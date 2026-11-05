// Almanac: a deck of 36 cards replaces the production dice, one card per result of two dice, each
// bringing a happening that resolves before production. A new year in the deck rebuilds it. The
// base game's plain event deck (the `eventDeck` option) is the same deck without happenings; the
// Almanac takes its place when both are chosen.

import { cards } from '../../constants';
import { type Ctx, assert, fail, moveCards, validIndex } from '../../ctx';
import { doSteal } from '../../reducer';
import { canTakeOil, hasResources, robbable, stealableCount, theftChoices } from '../../rules';
import type { Action, GameState, PlayerId } from '../../types';
import { RESOURCES } from '../../types';
import type { RuleModule } from '../api';
import { almanacBot } from './bot';
import { HAPPENINGS, NEW_YEAR, UNDER_NEW_YEAR, buildDeck, cardDice, drawCard } from './deck';
import {
  answered,
  bankResources,
  REPAIR_COST,
  canAnswer,
  crack,
  crackable,
  crackedRoads,
  giftKinds,
  hasCracked,
  leftOf,
  resolveHappening,
  topDecision,
} from './happenings';
import type { AlmanacAction } from './types';

/** The recipients `player` may give to under the decision on top. */
function recipientsFor(s: GameState, player: PlayerId): PlayerId[] {
  const d = topDecision(s)!;
  return d.data.happening === 'gifts' ? [leftOf(s, player)] : (d.data.recipients ?? []);
}

function handle(ctx: Ctx, player: PlayerId, action: Action) {
  const s = ctx.s;
  const a = action as AlmanacAction;
  const me = s.players[player];

  if (a.type === 'almanac/repair') {
    assert(s.pending.length === 0, 'Another decision has to be made first.');
    assert(s.phase === 'main' && s.currentPlayer === player, 'You can mend a road only on your own turn.');
    assert(validIndex(a.edge, s.board.edges.length), 'Invalid edge.');
    const r = s.routes[a.edge];
    assert(r && r.owner === player && r.cracked, 'That is not a cracked road of yours.');
    assert(hasResources(me.hand, REPAIR_COST), 'Mending a road costs 1 brick and 1 wood.');
    moveCards(ctx, player, null, REPAIR_COST, 'repair');
    delete r.cracked;
    ctx.emit({ type: 'almanac/repaired', player, edge: a.edge });
    return;
  }

  const d = topDecision(s);
  assert(d && d.players.includes(player), 'There is nothing for you to decide.');
  switch (a.type) {
    case 'almanac/crack': {
      assert(d.kind === 'almanac/quake', 'That does not answer this.');
      assert(crackable(s, player).includes(a.edge), 'Choose one of your roads that is not already cracked.');
      crack(ctx, player, a.edge);
      break;
    }
    case 'almanac/take': {
      assert(d.kind === 'almanac/take', 'That does not answer this.');
      assert(RESOURCES.includes(a.resource), 'Choose a resource.');
      assert(s.bank[a.resource] > 0, `The supply has no ${a.resource} left.`);
      moveCards(ctx, null, player, cards({ [a.resource]: 1 }), d.data.happening);
      ctx.emit({ type: 'almanac/took', player, resource: a.resource, happening: d.data.happening });
      break;
    }
    case 'almanac/give': {
      assert(d.kind === 'almanac/gift', 'That does not answer this.');
      assert(giftKinds(s).includes(a.card), 'You may give a resource or a commodity.');
      assert(me.hand[a.card] > 0, `You have no ${a.card}.`);
      assert(recipientsFor(s, player).includes(a.to), d.data.happening === 'gifts' ? 'Gifts go to the player on your left.' : 'Give to a player with fewer points.');
      moveCards(ctx, player, a.to, cards({ [a.card]: 1 }), d.data.happening);
      ctx.emit({ type: 'almanac/gave', from: player, to: a.to, card: a.card, happening: d.data.happening });
      break;
    }
    case 'almanac/rob': {
      assert(d.kind === 'almanac/rob', 'That does not answer this.');
      assert((d.data.victims ?? []).includes(a.victim) && robbable(s, player, a.victim), 'You cannot rob that player.');
      assert(a.oil ? canTakeOil(s, player, a.victim) : stealableCount(s, a.victim) > 0, a.oil ? 'You have no room for their oil.' : 'They have no card to take.');
      doSteal(ctx, player, a.victim, !!a.oil, 'almanac');
      break;
    }
    default:
      fail('That is not part of this game.');
  }
  answered(s, player);
}

function legal(s: GameState, player: PlayerId): Action[] {
  const d = topDecision(s);
  if (!d) {
    if (s.pending.length > 0 || s.phase !== 'main' || s.currentPlayer !== player) return [];
    if (!hasResources(s.players[player].hand, REPAIR_COST)) return [];
    return crackedRoads(s, player).map((edge) => ({ type: 'almanac/repair', edge }));
  }
  if (!d.players.includes(player) || !canAnswer(s, d, player)) return [];
  const hand = s.players[player].hand;
  switch (d.kind) {
    case 'almanac/quake':
      return crackable(s, player).map((edge) => ({ type: 'almanac/crack', edge }));
    case 'almanac/take':
      return bankResources(s).map((resource) => ({ type: 'almanac/take', resource }));
    case 'almanac/gift': {
      const out: Action[] = [];
      for (const card of giftKinds(s)) if (hand[card] > 0) for (const to of recipientsFor(s, player)) out.push({ type: 'almanac/give', card, to });
      return out;
    }
    case 'almanac/rob':
      return (d.data.victims ?? []).flatMap((v) => theftChoices(s, player, v).map((t) => ({ type: 'almanac/rob' as const, ...t })));
  }
}

export const almanac: RuleModule = {
  id: 'almanac',
  rulesVersion: 1,
  init(s, rng) {
    s.ext.almanac = { deck: buildDeck((c) => rng.shuffle(c)), card: null, happening: null };
  },
  handle,
  legal,
  hooks: {
    turnStarted(ctx) {
      const st = ctx.s.ext.almanac!;
      st.card = null;
      st.happening = null;
    },
    rollDice(ctx, settled) {
      const st = ctx.s.ext.almanac!;
      const card = drawCard(ctx);
      const dice = cardDice(card);
      const total = dice[0] + dice[1];
      st.card = card;
      // The dice-setting venture keeps its number and the card still brings its happening, unless
      // the card is a 7: then the venture's number replaces it and nothing else happens.
      st.happening = settled && total === 7 ? null : HAPPENINGS[card];
      ctx.emit({ type: 'almanac/drawn', player: ctx.s.currentPlayer, card, dice: [dice[0], dice[1]], happening: st.happening, settled: !!settled });
      return settled ?? { dice, total };
    },
    afterRoll(ctx) {
      const h = ctx.s.ext.almanac!.happening;
      if (h) resolveHappening(ctx, h);
    },
    yields(s, _hex, _vertex, b, grants) {
      // A sickness: a city (a foundry too) takes one resource per producing hex, no commodity,
      // and at most one oil from a well. Settlements are spared.
      if (s.ext.almanac?.happening !== 'sickness' || b.kind !== 'city') return grants;
      let resource = false;
      const out: typeof grants = [];
      for (const g of grants) {
        if (RESOURCES.includes(g.resource as never)) {
          if (!resource) out.push({ ...g, amount: Math.min(1, g.amount) });
          resource = true;
        } else if (g.resource === 'oil') out.push({ ...g, amount: Math.min(1, g.amount) });
      }
      return out;
    },
    placeReason: (_s, _player, piece, _at) => piece === 'settlement' ? 'Mend the cracked road before settling beside it' : 'Mend your cracked road before building another route',
    canPlace(s, player, piece, at) {
      // A cracked road stops its owner building route pieces until it's mended, and nobody may
      // settle beside it.
      if (piece === 'road' || piece === 'ship' || piece === 'bridge') return !hasCracked(s, player);
      if (piece === 'settlement') return !s.board.vertices[at].edges.some((e) => s.routes[e]?.cracked);
      return true;
    },
    redact(s) {
      // The order of the deck, and which five cards lie under the new year, are secret.
      const st = s.ext.almanac;
      if (st) st.deck = st.deck.map((c) => (c === NEW_YEAR ? NEW_YEAR : -1));
    },
  },
  bot: almanacBot,
  invariants(s) {
    const out: string[] = [];
    const st = s.ext.almanac;
    if (!st) return ['no almanac state'];
    const seen = new Set<number>();
    for (const c of st.deck) {
      if (!Number.isInteger(c) || c < 0 || c > NEW_YEAR) out.push(`unknown card ${c}`);
      if (seen.has(c)) out.push(`card ${c} twice in the deck`);
      seen.add(c);
    }
    if (st.deck[UNDER_NEW_YEAR] !== NEW_YEAR) out.push('the new year is not on the five cards dealt under it');
    if (st.happening !== null && st.card === null) out.push('a happening without a card');
    s.routes.forEach((r, e) => {
      if (r?.cracked && r.kind !== 'road') out.push(`a cracked ${r.kind} on edge ${e}`);
    });
    for (const d of s.pending) {
      if (!d.kind.startsWith('almanac/')) continue;
      if (d.players.length === 0) out.push(`${d.kind} owed by nobody`);
      if (d === topDecision(s)) for (const p of d.players) if (!canAnswer(s, topDecision(s)!, p)) out.push(`${d.kind}: player ${p} owes it but cannot answer`);
    }
    if (s.productionOwed !== undefined && s.pending.length === 0 && s.phase !== 'gameOver') out.push('production owed with no decision pending');
    return out;
  },
};
