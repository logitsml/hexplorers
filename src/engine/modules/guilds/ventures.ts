// The venture cards: three decks of 16, 17 and 16, one per track. Each card is a small effect: the ways it can
// be played now (`options`, which the legal actions and the bots read) and what it does (`play`,
// which runs once the card has left the hand). A play is refused unless its parameters are among
// the options, so what the engine offers and what it accepts can't drift apart.

import { cards as cardsOf, isLand } from '../../constants';
import { type Ctx, addCoins, assert, moveCards } from '../../ctx';
import { built, doSteal, updateLongestRoad } from '../../reducer';
import { modulesOf } from '..';
import { cardKinds, freeRouteOpen, hasResources, legalCities, legalRobberHexes, numbersOf, stealCandidates, stealableCount, totalVictoryPoints } from '../../rules';
import { buildingConquered, captureRaider, oilRoom, raidersOn, returnShip } from '../shared';
import type { Card, CardCounts, CardMoveReason, GameState, ModuleId, PlayerId, Resource, Track } from '../../types';
import { COMMODITIES, RESOURCES } from '../../types';
import { COMMODITY_SUPPLY, guildsOf, owe, traderHexes } from './rules';
import type { VentureId, VentureParams } from './types';
import {
  canMuster,
  freePieces,
  garrisonsOf,
  invaded,
  muster,
  promote,
  promoteBlocker,
  recruitSpots,
  touchesRoute,
  unseat,
  wallSites,
  wardenById,
  wardensChanged,
  wardensOf,
} from '../garrisons/wardens';
import type { WardenRank } from '../garrisons/types';

interface VentureDef {
  track: Track;
  /** Copies in its deck (guilds rules 3 on). */
  count: number;
  /** Copies in its deck in games recorded under the earlier guilds rules (a retired card has none now). */
  was: number;
  name: string;
  /** What it does, in a sentence or two. */
  text: string;
  /** A victory venture: shown face up as soon as it's drawn, worth a point, never held. */
  victory?: true;
  /** Played before rolling (the augury); every other card after. */
  beforeRoll?: true;
  /** In the deck only when these modules are in play (the wardens' and walls' cards need the garrisons). */
  needs?: ModuleId[];
  /** Left out of the deck when any of these modules is in play (the lighthouse has no robber to keep off under Invasion). */
  without?: ModuleId[];
  /** Every way it can be played now; empty when it can't be. Absent for cards never played on their own (the hoist rides on an improvement). */
  options?(s: GameState, player: PlayerId): VentureParams[];
  /** Parameters the options don't list but the card accepts (the augury takes any pair of dice). */
  validate?(s: GameState, player: PlayerId, params: VentureParams): string | null;
  /** Resolve it. The card has already gone back under its deck. */
  play?(ctx: Ctx, player: PlayerId, params: VentureParams): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether `s` plays the guilds' third rules: the current deck and numbers rather than the first ones. */
export const newVentures = (s: GameState): boolean => (s.options.moduleRules.guilds ?? 1) >= 3;

/** How many copies of `def` the decks of this game hold. */
export const ventureCopies = (s: GameState, def: Pick<VentureDef, 'count' | 'was' | 'needs' | 'without'>): number => {
  const mods = s.options.modules;
  if (def.needs && !def.needs.every((m) => mods.includes(m))) return 0;
  if (def.without?.some((m) => mods.includes(m))) return 0;
  return newVentures(s) ? def.count : def.was;
};

/** Kinds of card a venture may take or move: resources and commodities, never oil (rule 2). */
export const ventureKinds = (s: GameState): Card[] => cardKinds(s).filter((k) => k !== 'oil');

/** How many cards a venture could take from `player`. */
export function ventureCards(s: GameState, player: PlayerId): number {
  let n = 0;
  for (const k of ventureKinds(s)) n += s.players[player].hand[k];
  return n;
}

/** Points as the ventures compare them (all of them public in a guilds game). */
const points = (s: GameState, p: PlayerId) => totalVictoryPoints(s, p);

/** The other players, in turn order from `player`. */
function othersFrom(s: GameState, player: PlayerId): PlayerId[] {
  const n = s.players.length;
  return Array.from({ length: n - 1 }, (_, i) => (player + 1 + i) % n);
}

/** Move `n` cards of `kind` in the open (from/to null: the supply). */
export function moveKind(ctx: Ctx, from: PlayerId | null, to: PlayerId | null, kind: Card, n: number, reason: CardMoveReason) {
  if (n > 0) moveCards(ctx, from, to, cardsOf({ [kind]: n }), reason);
}

/** Hexes of `terrain` beside at least one of `player`'s buildings. */
function hexesBeside(s: GameState, player: PlayerId, terrain: string): number[] {
  return s.board.hexes.filter((h) => h.terrain === terrain && h.vertices.some((v) => s.buildings[v]?.owner === player)).map((h) => h.id);
}

/** Two of a resource from the supply for each such hex (as many as the supply has). */
function harvest(ctx: Ctx, player: PlayerId, terrain: string, r: Resource, reason: CardMoveReason) {
  const want = 2 * hexesBeside(ctx.s, player, terrain).length;
  moveKind(ctx, null, player, r, Math.min(want, ctx.s.bank[r]), reason);
}

/** Every other player gives up to `n` of `kind`. */
function takeFromEach(ctx: Ctx, player: PlayerId, kind: Card, n: number, reason: CardMoveReason) {
  for (const o of othersFrom(ctx.s, player)) moveKind(ctx, o, player, kind, Math.min(n, ctx.s.players[o].hand[kind]), reason);
}

/**
 * The numbers a hex bears as the guilds see them (moved by the resurvey), counting any that
 * pollution has since taken: Oil's numbersOf hook, which runs after the guilds', takes those off.
 */
const currentNumbers = (s: GameState, hex: number): number[] => guildsOf(s).numbers[hex] ?? s.board.hexes[hex].numbers;

/** A hex surrounded by land on all six sides (Invasion keeps the resurvey to these). */
const inner = (s: GameState, hex: number) => {
  const h = s.board.hexes[hex];
  return h.neighbors.length === 6 && h.neighbors.every((n) => s.board.hexes[n].terrain !== 'sea');
};

/**
 * A hex whose disc the resurvey may move, and that disc: land other than the lake (which keeps its
 * own numbers, rule 5), with a single surviving number, never a 5, 6, 8 or 9 (the earlier rules:
 * never a 2, 6, 8 or 12), inner hexes only under Invasion. Only surviving numbers count, so a number pollution took is gone for good: a hex that
 * lost its only number has nothing to move. (A face-down hex's drawn number isn't the guilds' to
 * move either.)
 */
function swappable(s: GameState, hex: number): number | null {
  const h = s.board.hexes[hex];
  if (h.terrain === 'sea' || h.terrain === 'lake') return null;
  const nums = numbersOf(s, h);
  if (nums.length !== 1 || (newVentures(s) ? [5, 6, 8, 9] : [2, 6, 8, 12]).includes(nums[0]) || !currentNumbers(s, hex).includes(nums[0])) return null;
  if (s.options.modules.includes('invasion') && !inner(s, hex)) return null;
  return nums[0];
}

/** `nums` with one `from` changed to `to`. */
function replaceOne(nums: number[], from: number, to: number): number[] {
  const out = nums.slice();
  out[out.indexOf(from)] = to;
  return out;
}

/**
 * The two hexes' number lists after a resurvey swaps their discs (bots weigh it with this too).
 * Only the surviving discs change places. A number pollution took stays on its hex's list, where
 * Oil keeps taking it off, so the loss is permanent and no disc comes back.
 */
export function resurveyed(s: GameState, a: number, b: number): Record<number, number[]> {
  const da = swappable(s, a)!;
  const db = swappable(s, b)!;
  return { [a]: replaceOne(currentNumbers(s, a), da, db), [b]: replaceOne(currentNumbers(s, b), db, da) };
}

/** A corner on the coast: at the edge of the board, or beside a sea hex. */
const coastal = (s: GameState, vertex: number): boolean => {
  const hexes = s.board.vertices[vertex].hexes;
  return hexes.length < 3 || hexes.some((h) => s.board.hexes[h].terrain === 'sea');
};

/** Buildings of `player`'s on the coast (the salvage counts up to three of them). */
export const coastBuildings = (s: GameState, player: PlayerId): number => s.buildings.filter((b, v) => b?.owner === player && coastal(s, v)).length;

/** What town planning costs: 2 wheat and 1 ore (the earlier rules: 1 wheat and 2 ore). */
export const townCost = (s: GameState): CardCounts => cardsOf(newVentures(s) ? { wheat: 2, ore: 1 } : { wheat: 1, ore: 2 });

/** What a dowry takes from `giver` for `p`: two cards if they lead by two points or more, else one (the earlier rules: always two). */
export const dowryOwed = (s: GameState, p: PlayerId, giver: PlayerId): number => (!newVentures(s) || points(s, giver) - points(s, p) >= 2 ? 2 : 1);

/** What unrest takes from a hand of `n` cards: a third, rounded up (the earlier rules: half, rounded down). */
export const unrestLoss = (s: GameState, n: number): number => (newVentures(s) ? Math.ceil(n / 3) : Math.floor(n / 2));

/** The fewest cards a hand needs to feel unrest. */
export const unrestFloor = (s: GameState): number => (newVentures(s) ? 3 : 2);

/** Hexes where `player` may light a lighthouse: land beside one of their buildings, not already lit by them. */
export function lightHexes(s: GameState, player: PlayerId): number[] {
  const lit = guildsOf(s).lit ?? [];
  return s.board.hexes.filter((h) => isLand(h.terrain) && h.vertices.some((v) => s.buildings[v]?.owner === player) && !lit.some((l) => l.owner === player && l.hex === h.id)).map((h) => h.id);
}

/** Edges of a river hex (Rivers): removing a road from one costs a coin. */
function riverEdge(s: GameState, edge: number): boolean {
  const rivers = s.board.features.rivers;
  if (!rivers) return false;
  return s.board.edges[edge].hexes.some((h) => rivers.some((r) => r.hexes.includes(h)));
}

/** A road with a loose end: an end where its owner has no building, no warden and no other route piece. */
export function openRoad(s: GameState, edge: number): boolean {
  const r = s.routes[edge];
  // (A ship is a basic route piece too, rule 1; bridges never come off.)
  if (!r || r.kind === 'bridge') return false;
  const ed = s.board.edges[edge];
  return [ed.a, ed.b].some(
    (v) =>
      s.buildings[v]?.owner !== r.owner &&
      !s.wardens.some((w) => w.vertex === v && w.owner === r.owner) &&
      !s.board.vertices[v].edges.some((e) => e !== edge && s.routes[e]?.owner === r.owner),
  );
}

/** Who a tax on `hex` takes from: the others with a normal building on it (not one the raiders have conquered) and a card to give. */
function taxed(s: GameState, hex: number, player: PlayerId): PlayerId[] {
  const out = new Set<PlayerId>();
  for (const v of s.board.hexes[hex].vertices) {
    const b = s.buildings[v];
    if (b && b.owner !== player && !buildingConquered(s, v) && stealableCount(s, b.owner) > 0) out.add(b.owner);
  }
  return [...out].sort((a, c) => a - c);
}

/** The wardens the forge could promote: one, or two (the second judged after the first). */
function forgeChoices(s: GameState, player: PlayerId): number[][] {
  const ok = wardensOf(s, player).filter((w) => promoteBlocker(s, player, w) === null);
  const out: number[][] = ok.map((w) => [w.id]);
  for (const a of ok) {
    // (The first promotion frees a piece of its old rank and uses one of the next.)
    const g = garrisonsOf(s);
    const after: GameState = {
      ...s,
      wardens: s.wardens.map((w) => (w.id === a.id ? { ...w, rank: (w.rank + 1) as WardenRank } : w)),
      ext: { ...s.ext, garrisons: { ...g, promoted: [...g.promoted, a.id] } },
    };
    // The first promotion may free the piece the second needs, so their order matters. Games
    // recorded under the first rules keep their former, id-ordered choices.
    for (const b of wardensOf(after, player)) {
      if ((s.options.moduleRules.guilds! < 2 ? b.id > a.id : b.id !== a.id) && promoteBlocker(after, player, b) === null) out.push([a.id, b.id]);
    }
  }
  return out;
}

/** The ranks `player` could put in play for a removed warden of `rank`. */
export const plantRanks = (s: GameState, player: PlayerId, rank: WardenRank): WardenRank[] =>
  ([1, 2, 3] as WardenRank[]).filter((r) => r <= rank && freePieces(s, player, r) > 0);

/** Where `player`'s planted warden may stand: by their routes, or (Invasion) the edge the removed one left. */
export function plantSpots(s: GameState, player: PlayerId, edge: number | null): number[] {
  if (invaded(s)) return edge !== null && !s.wardens.some((w) => w.edge === edge) ? [edge] : [];
  return recruitSpots(s, player);
}

/** Treachery: `w` leaves the board, and the thief may put one of theirs in its place. */
export function treacheryRemove(ctx: Ctx, thief: PlayerId, wardenId: number) {
  const s = ctx.s;
  const w = wardenById(s, wardenId)!;
  s.wardens = s.wardens.filter((x) => x.id !== w.id);
  ctx.emit({ type: 'garrisons/removed', player: w.owner, warden: w.id, reason: 'treachery' });
  wardensChanged(ctx);
  if (plantRanks(s, thief, w.rank).length > 0 && plantSpots(s, thief, w.edge).length > 0) {
    owe(s, thief, { kind: 'guilds/plant', rank: w.rank, mustered: w.mustered, edge: invaded(s) ? w.edge : null });
  }
}

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

const dicePairFor = (t: number): [number, number] => {
  const a = Math.max(1, t - 6);
  return [a, t - a];
};

export const VENTURES: Record<VentureId, VentureDef> = {
  // ------------------------------------------------------------- Learning
  augury: {
    track: 'learning',
    count: 1,
    was: 2,
    name: 'Augury',
    text: 'Before you roll, name the production dice. The event die is rolled as usual.',
    beforeRoll: true,
    options: () => Array.from({ length: 11 }, (_, i) => ({ dice: dicePairFor(i + 2) })),
    validate: (_s, _p, { dice }) =>
      Array.isArray(dice) && dice.length === 2 && dice.every((d) => Number.isInteger(d) && d >= 1 && d <= 6) ? null : 'Name two dice from 1 to 6.',
    play: (ctx, _p, { dice }) => {
      guildsOf(ctx.s).settled = [dice![0], dice![1]];
    },
  },
  hoist: {
    track: 'learning',
    count: 3,
    was: 2,
    name: 'Hoist',
    text: 'Your next improvement costs one commodity less (a first level can cost nothing). One hoist to an improvement.',
  },
  masonry: {
    track: 'learning',
    count: 1,
    was: 1,
    name: 'Masonry',
    text: 'Raise a wall under one of your towns for free.',
    needs: ['garrisons'],
    options: (s, p) => wallSites(s, p).map((vertex) => ({ vertex })),
    play: (ctx, p, { vertex }) => {
      ctx.s.buildings[vertex!]!.wall = true;
      ctx.emit({ type: 'garrisons/wall', player: p, vertex: vertex!, free: true });
    },
  },
  resurvey: {
    track: 'learning',
    count: 2,
    was: 2,
    name: 'Resurvey',
    text: 'Swap two number discs, neither of them a 5, 6, 8 or 9. The robber stays where it is.',
    options: (s) => {
      const hexes = s.board.hexes.map((h) => h.id).filter((h) => swappable(s, h) !== null);
      const out: VentureParams[] = [];
      for (const a of hexes) for (const b of hexes) if (a < b && swappable(s, a) !== swappable(s, b)) out.push({ hexes: [a, b] });
      return out;
    },
    play: (ctx, p, { hexes }) => {
      const s = ctx.s;
      const [a, b] = hexes!;
      Object.assign(guildsOf(s).numbers, resurveyed(s, a, b));
      ctx.emit({ type: 'guilds/numbersSwapped', player: p, hexes: [a, b] });
    },
  },
  waterworks: {
    track: 'learning',
    count: 2,
    was: 2,
    name: 'Waterworks',
    text: 'Take 2 wheat for each fields hex beside at least one of your buildings.',
    options: () => [{}],
    play: (ctx, p) => harvest(ctx, p, 'fields', 'wheat', 'waterworks'),
  },
  townPlanning: {
    track: 'learning',
    count: 2,
    was: 2,
    name: 'Town Planning',
    text: 'Raise one of your houses to a town for 2 wheat and 1 ore.',
    options: (s, p) => (hasResources(s.players[p].hand, townCost(s)) ? legalCities(s, p).map((vertex) => ({ vertex })) : []),
    play: (ctx, p, { vertex }) => {
      const s = ctx.s;
      const me = s.players[p];
      const b = s.buildings[vertex!]!;
      moveCards(ctx, p, null, townCost(s), 'charter');
      b.kind = 'city';
      if (b.lying) delete b.lying;
      else {
        me.settlementsLeft++;
        me.citiesLeft--;
      }
      ctx.emit({ type: 'cityBuilt', player: p, vertex: vertex! });
      built(ctx, p, 'city', vertex!, false);
    },
  },
  // (Retired with the guilds' third rules, for the salvage: kept for games recorded before.)
  deepSeams: {
    track: 'learning',
    count: 0,
    was: 2,
    name: 'Deep Seams',
    text: 'Take 2 ore for each mountains hex beside at least one of your buildings.',
    options: () => [{}],
    play: (ctx, p) => harvest(ctx, p, 'mountains', 'ore', 'deepSeams'),
  },
  // (Retired with the guilds' third rules, for the pilot: kept for games recorded before.)
  pathfinders: {
    track: 'learning',
    count: 0,
    was: 2,
    name: 'Pathfinders',
    text: 'Build two roads for free (with Sea Lanes, ships too; never bridges).',
    options: (s, p) => (freeRouteOpen(s, p) ? [{}] : []),
    play: (ctx, p) => {
      const s = ctx.s;
      // The base game's free-road interlude (as its Road Crew card): it ends when they're placed or none fit.
      s.freeRoadsLeft = modulesOf(s).some((m) => m.hooks?.canPlaceFreeRoute) ? 2 : Math.min(2, s.players[p].roadsLeft);
      s.resumePhase = 'main';
      s.phase = 'roadBuilding';
    },
  },
  forge: {
    track: 'learning',
    count: 1,
    was: 2,
    name: 'Forge',
    text: 'Promote up to two of your wardens for free, each no more than once this turn.',
    needs: ['garrisons'],
    options: (s, p) => forgeChoices(s, p).map((wardens) => ({ wardens })),
    play: (ctx, p, { wardens }) => {
      for (const id of wardens!) {
        const w = wardenById(ctx.s, id);
        const why = promoteBlocker(ctx.s, p, w);
        assert(why === null, why ?? '');
        promote(ctx, w!, true);
      }
    },
  },
  encyclopaedia: {
    track: 'learning',
    count: 1,
    was: 1,
    name: 'Encyclopaedia',
    text: 'A victory point, shown as soon as it is drawn.',
    victory: true,
  },
  salvage: {
    track: 'learning',
    count: 2,
    was: 0,
    name: 'Salvage',
    text: 'Wreckage washes up: take a resource of your choice from the supply for each of your buildings on the coast, at most three.',
    options: (s, p) => (coastBuildings(s, p) > 0 && RESOURCES.some((r) => s.bank[r] > 0) ? [{}] : []),
    play: (ctx, p) => {
      for (let i = 0; i < Math.min(3, coastBuildings(ctx.s, p)); i++) owe(ctx.s, p, { kind: 'guilds/pick', salvage: true });
    },
  },
  pilot: {
    track: 'learning',
    count: 1,
    was: 0,
    name: 'Pilot',
    text: 'Build a road for free (with Sea Lanes, a ship; never a bridge), and take 1 brick and 1 wood from the supply.',
    options: (s, p) => (freeRouteOpen(s, p) ? [{}] : []),
    play: (ctx, p) => {
      const s = ctx.s;
      for (const r of ['brick', 'wood'] as const) moveKind(ctx, null, p, r, Math.min(1, s.bank[r]), 'pilot');
      s.freeRoadsLeft = modulesOf(s).some((m) => m.hooks?.canPlaceFreeRoute) ? 1 : Math.min(1, s.players[p].roadsLeft);
      s.resumePhase = 'main';
      s.phase = 'roadBuilding';
    },
  },

  // ------------------------------------------------------------- Commerce
  barter: {
    track: 'commerce',
    count: 2,
    was: 2,
    name: 'Barter',
    text: 'Offer each other player one of your resources: each must give you a commodity of their choice for it. Anyone with no commodity keeps the trade off.',
    options: (s, p) => {
      const mine = RESOURCES.some((r) => s.players[p].hand[r] > 0);
      // The supply and our own hand tell us whether any commodity is held elsewhere, without
      // needing to know which opponent holds it (their redacted hands keep no commodity kinds).
      const theirs = COMMODITIES.some((c) => s.bank[c] + s.players[p].hand[c] < COMMODITY_SUPPLY);
      return mine && theirs ? [{}] : [];
    },
    play: (ctx, p) => {
      const s = ctx.s;
      const queue = othersFrom(s, p).filter((o) => COMMODITIES.some((c) => s.players[o].hand[c] > 0));
      owe(s, p, { kind: 'guilds/barter', queue });
    },
  },
  tribute: {
    track: 'commerce',
    count: 2,
    was: 2,
    name: 'Tribute',
    text: 'Look at the hand of a player with more points than you, and take any two of their cards.',
    options: (s, p) => othersFrom(s, p).filter((o) => points(s, o) > points(s, p) && ventureCards(s, o) > 0).map((target) => ({ target })),
    play: (ctx, p, { target }) => {
      const s = ctx.s;
      const seen = cardsOf({});
      for (const k of ventureKinds(s)) seen[k] = s.players[target!].hand[k];
      owe(s, p, { kind: 'guilds/tribute', target: target!, left: Math.min(2, ventureCards(s, target!)), seen });
    },
  },
  trader: {
    track: 'commerce',
    count: 4,
    was: 6,
    name: 'The Trader',
    text: "Put the trader on a hex beside one of your buildings. While you hold it, it's worth a point and you trade that hex's resource 2:1.",
    options: (s, p) => traderHexes(s, p).map((hex) => ({ hex })),
    play: (ctx, p, { hex }) => {
      guildsOf(ctx.s).trader = { hex: hex!, owner: p };
      ctx.emit({ type: 'guilds/trader', player: p, hex: hex! });
    },
  },
  // (Retired with the guilds' third rules, for the trade wind: kept for games recorded before.)
  charterFleet: {
    track: 'commerce',
    count: 0,
    was: 2,
    name: 'Charter Fleet',
    text: 'Name a resource or commodity: until your turn ends, you trade it with the bank 2:1.',
    options: (s) => ventureKinds(s).filter((k) => !guildsOf(s).charter.includes(k)).map((kind) => ({ kind })),
    play: (ctx, p, { kind }) => {
      guildsOf(ctx.s).charter.push(kind!);
      ctx.emit({ type: 'guilds/charter', player: p, card: kind! });
    },
  },
  cornerMarket: {
    track: 'commerce',
    count: 3,
    was: 4,
    name: 'Corner the Market',
    text: 'Name a resource (or oil, with Oil): every other player gives you two of it, or the one they have.',
    options: (s) => [...RESOURCES, ...(s.ext.oil ? (['oil'] as const) : [])].map((kind) => ({ kind })),
    play: (ctx, p, { kind }) => {
      if (kind !== 'oil') return takeFromEach(ctx, p, kind!, 2, 'cornerMarket');
      // Oil comes one at a time, clockwise round the table and then round again, up to two from
      // each, stopping when your hold is full (All Hands: capacity-aware). So with room for only
      // a few, they come one from each opponent in turn, not two from the first.
      const others = othersFrom(ctx.s, p);
      const taken = others.map(() => 0);
      let room = oilRoom(ctx.s, p);
      for (let round = 0; round < 2; round++) {
        others.forEach((o, k) => {
          if (room > 0 && ctx.s.players[o].hand.oil > taken[k]) {
            taken[k]++;
            room--;
          }
        });
      }
      others.forEach((o, k) => moveKind(ctx, o, p, 'oil', taken[k], 'cornerMarket'));
    },
  },
  // (Retired with the guilds' third rules, for customs: kept for games recorded before.)
  cartel: {
    track: 'commerce',
    count: 0,
    was: 2,
    name: 'Cartel',
    text: 'Name a commodity: every other player gives you one of it.',
    options: () => COMMODITIES.map((kind) => ({ kind })),
    play: (ctx, p, { kind }) => takeFromEach(ctx, p, kind!, 1, 'cartel'),
  },
  tradeWind: {
    track: 'commerce',
    count: 2,
    was: 0,
    name: 'Trade Wind',
    text: 'Until your turn ends, every trade you make with the bank costs one card fewer (4:1 becomes 3:1, 3:1 becomes 2:1, never better than 2:1).',
    options: (s) => (guildsOf(s).wind ? [] : [{}]),
    play: (ctx) => {
      guildsOf(ctx.s).wind = true;
    },
  },
  customs: {
    track: 'commerce',
    count: 2,
    was: 0,
    name: 'Customs',
    text: 'Name a resource or commodity: every other player holding two or more of it hands you one.',
    options: (s) => ventureKinds(s).map((kind) => ({ kind })),
    play: (ctx, p, { kind }) => {
      for (const o of othersFrom(ctx.s, p)) if (ctx.s.players[o].hand[kind!] >= 2) moveKind(ctx, o, p, kind!, 1, 'customs');
    },
  },
  stockpile: {
    track: 'commerce',
    count: 2,
    was: 0,
    name: 'Stockpile',
    text: 'Take one of each commodity from the supply (as many as it has).',
    options: (s) => (COMMODITIES.some((c) => s.bank[c] > 0) ? [{}] : []),
    play: (ctx, p) => {
      for (const c of COMMODITIES) moveKind(ctx, null, p, c, Math.min(1, ctx.s.bank[c]), 'stockpile');
    },
  },

  // ------------------------------------------------------------- Statecraft
  rightOfWay: {
    track: 'statecraft',
    count: 1,
    was: 2,
    name: 'Right of Way',
    text: 'Remove an open road or ship (never a bridge). If it was yours, you may build one of the same kind for free. Taking one off a river costs a coin.',
    options: (s, p) =>
      s.routes
        .map((_, edge) => edge)
        .filter((edge) => openRoad(s, edge) && (!riverEdge(s, edge) || s.players[p].coins >= 1))
        .map((edge) => ({ edge })),
    play: (ctx, p, { edge }) => {
      const s = ctx.s;
      const { owner, kind } = s.routes[edge!]!;
      if (riverEdge(s, edge!)) addCoins(ctx, p, -1, 'rightOfWay');
      s.routes[edge!] = null;
      if (kind === 'ship') returnShip(s, owner);
      else s.players[owner].roadsLeft++;
      ctx.emit({ type: 'guilds/routeRemoved', player: p, owner, edge: edge!, kind: kind === 'ship' ? 'ship' : 'road' });
      updateLongestRoad(ctx);
      if (owner === p) owe(s, p, { kind: 'guilds/rebuild', ship: kind === 'ship' });
    },
  },
  rally: {
    track: 'statecraft',
    count: 2,
    was: 2,
    name: 'Rally',
    text: 'Muster all your wardens for free.',
    needs: ['garrisons'],
    options: (s, p) => (wardensOf(s, p).some((w) => canMuster(s, p, w)) ? [{}] : []),
    play: (ctx, p) => {
      const ids: number[] = [];
      for (const w of wardensOf(ctx.s, p)) {
        if (!canMuster(ctx.s, p, w)) continue;
        muster(ctx.s, w);
        ids.push(w.id);
      }
      ctx.emit({ type: 'garrisons/mustered', player: p, wardens: ids, free: true });
    },
  },
  spymaster: {
    track: 'statecraft',
    count: 2,
    was: 3,
    name: 'Spymaster',
    text: "Look at another player's ventures and take one.",
    options: (s, p) => othersFrom(s, p).filter((o) => guildsOf(s).hands[o].length > 0).map((target) => ({ target })),
    play: (ctx, p, { target }) => owe(ctx.s, p, { kind: 'guilds/spy', target: target!, seen: guildsOf(ctx.s).hands[target!].slice() }),
  },
  agitators: {
    track: 'statecraft',
    count: 2,
    was: 2,
    name: 'Agitators',
    text: "Displace an opponent's warden standing beside your routes, without a warden of your own. Its owner moves it away. Under Invasion, capture a raider from any hex instead.",
    needs: ['garrisons'],
    options: (s, p) =>
      invaded(s)
        ? s.board.hexes.filter((h) => raidersOn(s, h.id) > 0).map((h) => ({ hex: h.id }))
        : s.wardens.filter((w) => w.owner !== p && w.vertex !== null && touchesRoute(s, p, w.vertex)).map((w) => ({ warden: w.id })),
    play: (ctx, p, { warden, hex }) => {
      if (hex !== undefined) {
        // (All Hands: the agitators turn on the raiders, and one becomes a prisoner.)
        captureRaider(ctx.s, p, hex);
        ctx.emit({ type: 'guilds/raiderCaptured', player: p, hex });
        return;
      }
      const w = wardenById(ctx.s, warden!)!;
      ctx.emit({ type: 'garrisons/displaced', player: p, warden: null, target: w.id, targetOwner: w.owner, from: w.vertex! });
      unseat(ctx, w);
      wardensChanged(ctx);
    },
  },
  unrest: {
    track: 'statecraft',
    count: 2,
    was: 2,
    name: 'Unrest',
    text: 'Every player with at least as many points as you discards a third of their cards, rounded up (nobody with fewer than three).',
    options: () => [{}],
    play: (ctx, p) => {
      const s = ctx.s;
      const hit = othersFrom(s, p).filter((o) => points(s, o) >= points(s, p) && ventureCards(s, o) >= unrestFloor(s));
      for (let i = hit.length - 1; i >= 0; i--) owe(s, hit[i], { kind: 'guilds/discard', left: unrestLoss(s, ventureCards(s, hit[i])) });
    },
  },
  taxCollectors: {
    track: 'statecraft',
    count: 2,
    was: 2,
    name: 'Tax Collectors',
    text: 'Move the robber to a new hex and take a card from each player with a building there. Under Invasion, with no robber, choose any land hex instead.',
    options: (s, p) =>
      s.robberHex !== null
        ? legalRobberHexes(s).map((hex) => ({ hex }))
        : s.options.modules.includes('invasion')
          ? s.board.hexes.filter((h) => isLand(h.terrain) && taxed(s, h.id, p).length > 0).map((h) => ({ hex: h.id }))
          : [],
    play: (ctx, p, { hex }) => {
      const s = ctx.s;
      if (s.robberHex === null) {
        // (All Hands: a card from each player with a normal building on the hex; nothing moves.)
        for (const v of taxed(s, hex!, p)) doSteal(ctx, p, v, false, 'venture');
        return;
      }
      const from = s.robberHex;
      s.robberHex = hex!;
      ctx.emit({ type: 'robberMoved', player: p, from, to: hex! });
      // (A venture takes no oil: only the resource monopoly may name it.)
      const victims = stealCandidates(s, hex!, p).filter((v) => stealableCount(s, v) > 0);
      if (victims.length === 0) ctx.emit({ type: 'nothingToSteal', player: p });
      for (const v of victims) doSteal(ctx, p, v, false, 'venture');
    },
  },
  treachery: {
    track: 'statecraft',
    count: 1,
    was: 2,
    name: 'Treachery',
    text: 'Another player gives up a warden of their choice. You may put one of yours of the same rank or lower in play, mustered or resting as theirs was.',
    needs: ['garrisons'],
    options: (s, p) => othersFrom(s, p).filter((o) => wardensOf(s, o).some((w) => w.vertex !== null || w.edge !== null)).map((target) => ({ target })),
    play: (ctx, p, { target }) => {
      const s = ctx.s;
      const theirs = wardensOf(s, target!).filter((w) => w.vertex !== null || w.edge !== null);
      if (theirs.length === 1) treacheryRemove(ctx, p, theirs[0].id);
      else owe(s, target!, { kind: 'guilds/surrender', thief: p });
    },
  },
  grandCharter: {
    track: 'statecraft',
    count: 1,
    was: 1,
    name: 'Grand Charter',
    text: 'A victory point, shown as soon as it is drawn.',
    victory: true,
  },
  dowry: {
    track: 'statecraft',
    count: 1,
    was: 2,
    name: 'Dowry',
    text: 'Every player with more points than you gives you a card of their choice, or two if they lead you by two points or more.',
    options: () => [{}],
    play: (ctx, p) => {
      const s = ctx.s;
      const givers = othersFrom(s, p).filter((o) => points(s, o) > points(s, p) && ventureCards(s, o) > 0);
      for (let i = givers.length - 1; i >= 0; i--) {
        owe(s, givers[i], { kind: 'guilds/give', to: p, left: Math.min(dowryOwed(s, p, givers[i]), ventureCards(s, givers[i])), only: 'cards', reason: 'dowry' });
      }
    },
  },
  lighthouse: {
    track: 'statecraft',
    count: 2,
    was: 0,
    name: 'Lighthouse',
    without: ['invasion'],
    text: 'Light a lighthouse on a land hex beside one of your buildings: until your next turn begins, the robber cannot be sent there. One lighthouse at a time for you.',
    options: (s, p) => lightHexes(s, p).map((hex) => ({ hex })),
    play: (ctx, p, { hex }) => {
      const g = guildsOf(ctx.s);
      g.lit = [...(g.lit ?? []).filter((l) => l.owner !== p), { hex: hex!, owner: p }];
      ctx.emit({ type: 'guilds/lit', player: p, hex: hex! });
    },
  },
};

/** A venture's parameters as a stable key (to compare a play with the options). */
export function paramsKey(p: VentureParams): string {
  return (['dice', 'vertex', 'hexes', 'hex', 'kind', 'target', 'edge', 'wardens', 'warden'] as const)
    .filter((k) => p[k] !== undefined)
    .map((k) => `${k}=${JSON.stringify(p[k])}`)
    .join('|');
}

/** Just the parameters of a play action. */
export function paramsOf(a: VentureParams): VentureParams {
  const out: VentureParams = {};
  for (const k of ['dice', 'vertex', 'hexes', 'hex', 'kind', 'target', 'edge', 'wardens', 'warden'] as const) if (a[k] !== undefined) (out as Record<string, unknown>)[k] = a[k];
  return out;
}
