// Invasion: raiders land on the home coast each time the island grows, three of them conquer a
// hex, and wardens march out from the castle at the end of each turn to throw them back. There is
// no robber (a 7 steals from anyone), no Biggest Army, and the muster deck replaces the
// development cards. Coins come from battles and turncoats and buy resources at the core's market.

import { cards } from '../../constants';
import { assert, fail, moveCards, validIndex, type Ctx } from '../../ctx';
import { doSteal, finishRobber } from '../../reducer';
import { canAfford, canTakeOil, robbable } from '../../rules';
import type { Action, Card, GameState, PlayerId, Pending } from '../../types';
import { CARDS, COMMODITIES, RESOURCES } from '../../types';
import type { RuleModule } from '../api';
import { buildingConquered, corsairStays, cutOff, eventFace, isConquered, setCorsair } from '../shared';
import { invasionBot } from './bot';
import { homeCoast } from './island';
import { buy, cardAnswers, dealMuster, MUSTER, MUSTER_DECK, musterLeft, newMusterDeck, playCard } from './muster';
import {
  buildingLandings,
  improvementLandings,
  land,
  landingHex,
  musterDeckInPlay,
  prisonerPoints,
  RAIDERS,
  unlimitedRaiders,
  withGarrisons,
  withGuilds,
} from './raids';
import { topology } from './topology';
import type { CardPending, InvasionState, MarchPending, MusterCard, RetreatPending } from './types';
import {
  displaceTargets,
  fightBattles,
  maybeEndMarch,
  mustWalk,
  owedRetreat,
  RANK_PIECES,
  retreatTargets,
  startMarch,
  STRIDE,
  walkTargets,
  WARDENS_PER_PLAYER,
  wardenOn,
} from './wardens';

/** The published target: 12 alone, 13 alongside the guilds. The game's target is its options' victoryPoints (presets set it). */
export const invasionTarget = (modules: readonly string[]): number => (modules.includes('guilds') ? 13 : 12);

/**
 * The bank's harbour ratios from `player`'s buildings that pass `usable` (the core's rule, see
 * tradeRatios in rules.ts, before any module adjusts it).
 */
function harbourRatios(s: GameState, player: PlayerId, usable: (v: number) => boolean): Record<Card, number> {
  const guilds = withGuilds(s);
  const c = guilds ? 4 : Infinity;
  const r: Record<Card, number> = { brick: 4, wood: 4, wool: 4, wheat: 4, ore: 4, paper: c, cloth: c, silver: c, oil: Infinity };
  for (const port of s.board.ports) {
    if (!port.vertices.some((v) => s.buildings[v]?.owner === player && usable(v))) continue;
    if (port.type === 'any') {
      for (const k of RESOURCES) r[k] = Math.min(r[k], 3);
      if (guilds) for (const k of COMMODITIES) r[k] = Math.min(r[k], 3);
    } else r[port.type] = Math.min(r[port.type], 2);
  }
  return r;
}

const topPending = (s: GameState): Pending | undefined => s.pending[s.pending.length - 1];

function marchActions(s: GameState, player: PlayerId, data: MarchPending): Action[] {
  const out: Action[] = [];
  let owed = false;
  for (const w of s.wardens) {
    if (w.owner !== player || data.acted.includes(w.id)) continue;
    for (const edge of walkTargets(s, w).keys()) out.push({ type: 'invasion/march', warden: w.id, edge });
    for (const edge of displaceTargets(s, w)) out.push({ type: 'invasion/displace', warden: w.id, edge });
    if (mustWalk(s, w)) owed = true;
  }
  // (Not while a warden still has to walk off the castle.)
  if (!owed) out.push({ type: 'invasion/halt' });
  return out;
}

function marchingWarden(s: GameState, player: PlayerId, id: unknown) {
  const top = topPending(s);
  assert(top?.kind === 'invasion/march' && top.players.includes(player), 'You are not marching.');
  const data = top.data as MarchPending;
  const w = s.wardens.find((x) => x.id === id);
  assert(w && w.owner === player, 'That is not your warden.');
  assert(!data.acted.includes(w.id), 'That warden has already marched.');
  return { w, data };
}

function handle(ctx: Ctx, player: PlayerId, action: Action) {
  const s = ctx.s;
  const top = topPending(s);
  switch (action.type) {
    case 'invasion/buy':
      assert(musterDeckInPlay(s), 'There is no muster deck in this game.');
      assert(!top, 'Another decision has to be made first.');
      assert(s.phase === 'main', `Not allowed during ${s.phase}.`);
      assert(player === s.currentPlayer, 'It is not your turn.');
      buy(ctx, player);
      return;
    case 'invasion/levy':
    case 'invasion/outrider':
    case 'invasion/ambush':
    case 'invasion/turncoat':
      playCard(ctx, player, action);
      return;
    case 'invasion/march': {
      const { w, data } = marchingWarden(s, player, action.warden);
      assert(validIndex(action.edge, s.board.edges.length), 'Invalid edge.');
      const d = walkTargets(s, w).get(action.edge);
      assert(d !== undefined, "A warden walks to an empty edge within reach, and never stops on the castle's.");
      // Alone, the longer walk costs a wheat (walkTargets offers it only to a player holding one).
      const paid = !withGarrisons(s) && d > STRIDE;
      if (paid) moveCards(ctx, player, null, cards({ wheat: 1 }), 'march');
      const from = w.edge!;
      w.edge = action.edge;
      // With the garrisons, a mustered warden rests after walking.
      if (withGarrisons(s)) w.mustered = false;
      data.acted.push(w.id);
      ctx.emit({ type: 'invasion/marched', player, warden: w.id, from, to: action.edge, paid });
      maybeEndMarch(ctx);
      return;
    }
    case 'invasion/displace': {
      assert(withGarrisons(s), 'Wardens displace one another only with the garrisons.');
      const { w, data } = marchingWarden(s, player, action.warden);
      assert(validIndex(action.edge, s.board.edges.length) && displaceTargets(s, w).includes(action.edge), 'A mustered warden displaces a weaker warden within 3 edges.');
      const victim = wardenOn(s, action.edge)!;
      w.edge = action.edge;
      w.mustered = false;
      victim.mustered = false;
      data.acted.push(w.id);
      ctx.emit({ type: 'invasion/displaced', player, warden: w.id, victim: victim.id, victimOwner: victim.owner, edge: action.edge });
      owedRetreat(ctx, victim, action.edge);
      maybeEndMarch(ctx);
      return;
    }
    case 'invasion/retreat': {
      assert(top?.kind === 'invasion/retreat' && top.players.includes(player), 'You have no warden to retreat.');
      const data = top.data as RetreatPending;
      assert(validIndex(action.edge, s.board.edges.length) && retreatTargets(s, data.from).includes(action.edge), "Retreat to an empty edge within 3 that isn't the castle's.");
      const w = s.wardens.find((x) => x.id === data.warden)!;
      w.edge = action.edge;
      s.pending.pop();
      ctx.emit({ type: 'invasion/retreated', player, warden: w.id, to: action.edge });
      maybeEndMarch(ctx);
      return;
    }
    case 'invasion/halt': {
      assert(top?.kind === 'invasion/march' && top.players.includes(player), 'You are not marching.');
      const data = top.data as MarchPending;
      assert(!s.wardens.some((w) => w.owner === player && !data.acted.includes(w.id) && mustWalk(s, w)), 'Every warden on a castle edge has to walk off it.');
      s.pending.pop();
      ctx.emit({ type: 'invasion/halted', player, marched: data.acted.length > 0 });
      return;
    }
    default:
      fail(`Unknown action ${action.type}`);
  }
}

function legal(s: GameState, player: PlayerId): Action[] {
  const top = topPending(s);
  if (top) {
    if (!top.kind.startsWith('invasion/') || !top.players.includes(player)) return [];
    switch (top.kind) {
      case 'invasion/card':
        return cardAnswers(s, (top.data as CardPending).card);
      case 'invasion/march':
        return marchActions(s, player, top.data as MarchPending);
      case 'invasion/retreat':
        return retreatTargets(s, (top.data as RetreatPending).from).map((edge) => ({ type: 'invasion/retreat', edge }));
    }
    return [];
  }
  if (musterDeckInPlay(s) && s.phase === 'main' && s.currentPlayer === player && canAfford(s, player, 'devCard')) return [{ type: 'invasion/buy' }];
  return [];
}

function invariants(s: GameState): string[] {
  const out: string[] = [];
  const i = s.ext.invasion;
  if (!i) return ['no invasion state'];
  const t = topology(s.board);
  if (i.raiders.length !== s.board.hexes.length) out.push('raider counts do not match the hexes');
  i.raiders.forEach((r, h) => {
    if (!Number.isInteger(r) || r < 0 || r > 3) out.push(`hex ${h} holds ${r} raiders`);
    if (r > 0 && !t.coastal[h]) out.push(`raiders on hex ${h}, off the home coast`);
  });
  const onBoard = i.raiders.reduce((a, b) => a + b, 0);
  const held = i.prisoners.reduce((a, b) => a + b, 0);
  if (i.prisoners.some((p) => p < 0) || i.tokens.some((p) => p < 0) || i.supply < 0) out.push('negative prisoners, tokens or supply');
  if (onBoard + held + i.supply !== RAIDERS + i.extra) out.push(`raiders not conserved: ${onBoard} on the board, ${held} prisoners, ${i.supply} beside it (${RAIDERS + i.extra})`);
  if (!unlimitedRaiders(s) && (i.extra !== 0 || i.tokens.some((k) => k !== 0))) out.push('raiders from beyond the box in a game where they run out');
  if (s.robberHex !== null) out.push('the robber is on the board');
  if (musterDeckInPlay(s)) {
    if (s.largestArmyHolder !== null) out.push('somebody holds Biggest Army');
    if (s.devDeck.length > 0) out.push('development cards beside the muster deck');
    const counts: Record<string, number> = {};
    for (const c of [...i.deck, ...i.discard]) counts[c] = (counts[c] ?? 0) + 1;
    for (const p of s.pending) if (p.kind === 'invasion/card') counts[(p.data as CardPending).card] = (counts[(p.data as CardPending).card] ?? 0) + 1;
    for (const [c, n] of Object.entries(MUSTER_DECK)) if ((counts[c] ?? 0) !== n) out.push(`muster cards not conserved: ${counts[c] ?? 0} ${c} (want ${n})`);
  } else if (i.deck.length + i.discard.length > 0) out.push('a muster deck alongside the ventures');
  const edges = new Set<number>();
  const ids = new Set<number>();
  for (const w of s.wardens) {
    if (ids.has(w.id)) out.push(`two wardens numbered ${w.id}`);
    if (w.id >= (s.nextWardenId ?? 1)) out.push(`warden id ${w.id} beyond the counter`);
    ids.add(w.id);
    if (w.vertex !== null) out.push(`warden ${w.id} stands on an intersection`);
    if (w.edge === null) {
      const retreating = s.pending.some((p) => p.kind === 'invasion/retreat' && (p.data as RetreatPending).warden === w.id);
      if (!retreating) out.push(`warden ${w.id} stands nowhere`);
      continue;
    }
    if (!t.wardenEdge[w.edge]) out.push(`warden ${w.id} is off the home island`);
    if (edges.has(w.edge)) out.push(`two wardens on edge ${w.edge}`);
    edges.add(w.edge);
  }
  for (const p of s.players) {
    const mine = s.wardens.filter((w) => w.owner === p.id);
    if (!withGarrisons(s)) {
      if (mine.length > WARDENS_PER_PLAYER) out.push(`player ${p.id} has ${mine.length} wardens`);
      if (mine.some((w) => w.rank !== 1 || !w.mustered)) out.push(`player ${p.id} has a warden of rank or state the muster deck never gives`);
    } else {
      for (const r of [1, 2, 3]) if (mine.filter((w) => w.rank === r).length > RANK_PIECES) out.push(`player ${p.id} has too many rank-${r} wardens`);
    }
  }
  return out;
}

export const invasion: RuleModule = {
  id: 'invasion',
  rulesVersion: 1,
  excludes: ['fleet'],

  init(s, rng) {
    // Invasion takes over the 7's theft, so it removes every blocker (rule 4): the robber, and with
    // Sea Lanes the corsair, unless the corsairStays knob keeps it (All Hands, decision 1).
    s.robberHex = null;
    if (!corsairStays(s)) setCorsair(s, null);
    const n = s.players.length;
    const state: InvasionState = {
      raiders: s.board.hexes.map(() => 0),
      supply: RAIDERS,
      extra: 0,
      prisoners: Array(n).fill(0),
      tokens: Array(n).fill(0),
      deck: [],
      discard: [],
    };
    s.ext.invasion = state;
    // One raider waits on each coastal hex bearing a 2 or a 12 (one hex bearing both holds one).
    const seeded = new Set<number>();
    for (const number of [2, 12]) {
      const h = landingHex(s, number);
      if (h === null || seeded.has(h)) continue;
      seeded.add(h);
      state.raiders[h]++;
      state.supply--;
    }
    // The muster deck replaces the development cards; with the guilds, their ventures do instead.
    if (musterDeckInPlay(s)) {
      s.devDeck = [];
      state.deck = newMusterDeck(rng);
    }
  },

  handle,
  legal,

  hooks: {
    shapeMap(spec, _options, rng) {
      homeCoast(spec, rng);
    },
    setupSecondKind: () => 'city',

    afterRoll(ctx, total) {
      // The event die's ship lands a raider at the production number (nothing on a 7).
      if (withGuilds(ctx.s) && eventFace(ctx.s) === 'ship' && total !== 7) {
        const dice = ctx.s.dice ?? [0, 0];
        land(ctx, ctx.s.currentPlayer, 'ship', [dice[0], dice[1]], total);
      }
    },
    hexBlocked: (s, hex) => isConquered(s, hex.id),
    // A building cut off by conquest (a cut-off seat included) produces nothing, from the sea either.
    yields: (s, _hex, vertex, _b, grants) => (cutOff(s, vertex) ? [] : grants),

    robberStep(ctx) {
      // No robber: the roller steals one random card from any player they choose, or with Oil
      // names one oil instead, while they have room for it (a lone victim holding some is then a
      // choice, as at the base game's steal).
      const s = ctx.s;
      const thief = s.currentPlayer;
      const victims = s.players.filter((p) => p.id !== thief && robbable(s, thief, p.id)).map((p) => p.id);
      if (victims.length === 0) {
        ctx.emit({ type: 'nothingToSteal', player: thief });
        finishRobber(ctx);
      } else if (victims.length === 1 && !canTakeOil(s, thief, victims[0])) {
        doSteal(ctx, thief, victims[0], false, 'seven');
        finishRobber(ctx);
      } else {
        s.stealCandidates = victims;
        s.phase = 'steal';
      }
      return true;
    },

    placeReason: (_s, _player, _piece, _at) => 'Free the neighbouring hex from its raiders before building here',
    canPlace(s, _player, piece, at) {
      // Nothing is built on a conquered hex's edges or corners; ships may still use its sea edges.
      if (piece === 'road' || piece === 'bridge') return !s.board.edges[at].hexes.some((h) => isConquered(s, h));
      if (piece === 'settlement' || piece === 'city') return !s.board.vertices[at].hexes.some((h) => isConquered(s, h));
      return true;
    },
    afterBuild(ctx, player, piece, _at, stage) {
      if (stage === 'threat' && (piece === 'settlement' || piece === 'city')) buildingLandings(ctx, player);
    },

    // Rule 3: the muster deck replaces the development cards (unless the guilds' ventures outrank
    // it), so anything that grants one (seven fish) grants the top muster card, played at once.
    freeCardDecks: (s) => (musterDeckInPlay(s) ? (musterLeft(s) ? [MUSTER] : []) : undefined),
    dealFreeCard(ctx, player) {
      dealMuster(ctx, player);
    },

    buildingWorth: (s, vertex, worth) => (buildingConquered(s, vertex) ? 0 : worth),
    victoryPoints: (s, player) => prisonerPoints(s, player),

    tradeRatios(s, player, ratios) {
      // A conquered building's harbour can't be used. (Only a ratio the harbour itself gave is
      // raised again: what another module granted below it stands.)
      const all = harbourRatios(s, player, () => true);
      const kept = harbourRatios(s, player, (v) => !buildingConquered(s, v));
      let out = ratios;
      for (const k of CARDS) {
        if (kept[k] > all[k] && ratios[k] === all[k]) {
          if (out === ratios) out = { ...ratios };
          out[k] = kept[k];
        }
      }
      return out;
    },

    afterAction(ctx) {
      // Each guild improvement lands a raider at a fresh roll of the production dice.
      const s = ctx.s;
      if (!withGuilds(s) || !improvementLandings(s)) return;
      const improved = ctx.events.filter((e) => (e as { type: string }).type === 'guilds/improved') as unknown as { player?: PlayerId }[];
      for (const e of improved) {
        const dice: [number, number] = [ctx.rng.die(), ctx.rng.die()];
        land(ctx, e.player ?? s.currentPlayer, 'improvement', dice, dice[0] + dice[1]);
      }
    },

    endOfTurn: [
      { rank: 10, run: startMarch },
      { rank: 20, run: fightBattles },
    ],

    redact(s) {
      // The deck's order is secret; the cards played are public.
      const i = s.ext.invasion;
      if (i) i.deck = i.deck.map((): MusterCard => 'levy');
    },
  },

  bot: invasionBot,
  invariants,
};
