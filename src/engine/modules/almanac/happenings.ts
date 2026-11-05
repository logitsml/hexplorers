// Resolving the happenings, before production. Those that ask players to choose push one decision
// on the pending stack; the roll waits for it (see api.ts, afterRoll).
//
// Where other modules are in play, each happening reads the way the All Hands table has it
// (docs/all-hands.md, "The Almanac in this mix"): armies are mustered warden strength under the
// Garrisons, gifts may be commodities under the Guilds, and the robber's flight moves the corsair
// where Invasion has done away with the robber.

import { cards } from '../../constants';
import type { Ctx } from '../../ctx';
import { memo, Query } from '../../memo';
import { doSteal } from '../../reducer';
import { canTakeOil, publicVictoryPoints, refugeHex, robbable, stealableKinds } from '../../rules';
import type { Card, GameState, Pending, PlayerId } from '../../types';
import { RESOURCES } from '../../types';
import { buildingConquered, corsairHex, setCorsair } from '../shared';
import type { Happening } from './types';

/** The decisions a happening leaves owed. */
export type AlmanacPendingKind = 'almanac/quake' | 'almanac/take' | 'almanac/gift' | 'almanac/rob';

export interface AlmanacPendingData {
  happening: Happening;
  /** Shoulder to the Wheel: who may receive (the players with fewer points). Over the Fence goes to the left instead. */
  recipients?: PlayerId[];
  /** Tug-of-War or The Fallen Purse: who may be robbed. */
  victims?: PlayerId[];
}

/** One of the Almanac's decisions on the pending stack. */
export type AlmanacDecision = Pending & { kind: AlmanacPendingKind; data: AlmanacPendingData };

/** The players in turn order, starting with the one whose turn it is. */
export function fromCurrent(s: GameState): PlayerId[] {
  const n = s.players.length;
  return Array.from({ length: n }, (_, i) => (s.currentPlayer + i) % n);
}

/** The player on `p`'s left: the next in turn order. */
export const leftOf = (s: GameState, p: PlayerId): PlayerId => (p + 1) % s.players.length;

/** Cards a gift may be: resources, and commodities with the guilds (never oil). */
export const giftKinds = (s: GameState): Card[] => stealableKinds(s);

const canGive = (s: GameState, p: PlayerId): boolean => giftKinds(s).some((k) => s.players[p].hand[k] > 0);

/** `p`'s roads a quake can crack: roads (never ships or bridges) not already cracked. */
export function crackable(s: GameState, p: PlayerId): number[] {
  const out: number[] = [];
  s.routes.forEach((r, e) => {
    if (r && r.owner === p && r.kind === 'road' && !r.cracked) out.push(e);
  });
  return out;
}

/** Mending a cracked road. */
export const REPAIR_COST = cards({ brick: 1, wood: 1 });

/** `p`'s cracked roads. */
export function crackedRoads(s: GameState, p: PlayerId): number[] {
  const out: number[] = [];
  s.routes.forEach((r, e) => {
    if (r && r.owner === p && r.cracked) out.push(e);
  });
  return out;
}

/** Whether `p` has a cracked road (they may build no route pieces until it's mended). */
export const hasCracked = (s: GameState, p: PlayerId): boolean =>
  // (Every route piece's legality asks this, so a bot's look at the board remembers it.)
  memo(s, Query.Cracked, p, () => s.routes.some((r) => !!r && r.owner === p && !!r.cracked));

/** The resources the supply can still give. */
export const bankResources = (s: GameState) => RESOURCES.filter((r) => s.bank[r] > 0);

/** Whether wardens stand in for Knight cards: the Garrisons' mustered strength, or Invasion's wardens on the board. */
const wardenArmies = (s: GameState) => s.options.modules.includes('garrisons') || s.options.modules.includes('invasion');

/**
 * A player's army for Tug-of-War or The Joust: the strength of their mustered wardens under the
 * Garrisons; under Invasion alone, their wardens on the board; otherwise the Knight cards they've played.
 */
function armyOf(s: GameState, p: PlayerId): number {
  if (!wardenArmies(s)) return s.players[p].playedKnights;
  const garrisons = s.options.modules.includes('garrisons');
  let n = 0;
  for (const w of s.wardens) {
    if (w.owner !== p || (w.vertex === null && w.edge === null)) continue;
    if (garrisons) n += w.mustered ? w.rank : 0;
    else n++;
  }
  return n;
}

/** Everyone tied for the strongest army, if it's stronger than nothing (The Joust). */
export function strongest(s: GameState): PlayerId[] {
  const armies = s.players.map((p) => armyOf(s, p.id));
  const best = Math.max(...armies);
  return best > 0 ? fromCurrent(s).filter((p) => armies[p] === best) : [];
}

/**
 * Who leads in arms for Tug-of-War: the Biggest Army's holder, else the one player with more
 * Knight cards played than anyone; with wardens, the one player with the greatest strength (a tie: nobody).
 */
function armyLeader(s: GameState): PlayerId | null {
  if (!wardenArmies(s) && s.largestArmyHolder !== null) return s.largestArmyHolder;
  const top = strongest(s);
  return top.length === 1 ? top[0] : null;
}

/** Normal buildings (not conquered) `p` has on harbours. */
function harbourBuildings(s: GameState, p: PlayerId): number {
  let n = 0;
  s.buildings.forEach((b, v) => {
    if (b && b.owner === p && s.board.vertices[v].port && !buildingConquered(s, v)) n++;
  });
  return n;
}

/** The players with the most normal buildings on harbours, if they have any (Mirror Bay). */
function harbourLeaders(s: GameState): PlayerId[] {
  const counts = s.players.map((p) => harbourBuildings(s, p.id));
  const best = Math.max(...counts);
  return best > 0 ? fromCurrent(s).filter((p) => counts[p] === best) : [];
}

/** Players `thief` could rob: anyone else holding a card a theft can take, or oil they may name. */
const victimsOf = (s: GameState, thief: PlayerId): PlayerId[] => s.players.filter((p) => p.id !== thief && robbable(s, thief, p.id)).map((p) => p.id);

function owe(ctx: Ctx, kind: AlmanacPendingKind, players: PlayerId[], data: AlmanacPendingData) {
  ctx.s.pending.push({ kind, players, data });
}

function nothing(ctx: Ctx, happening: Happening) {
  ctx.emit({ type: 'almanac/nothing', happening });
}

/** Each of `players` takes a resource of their choice from the supply. */
function grant(ctx: Ctx, happening: Happening, players: PlayerId[]) {
  if (players.length === 0 || bankResources(ctx.s).length === 0) return nothing(ctx, happening);
  owe(ctx, 'almanac/take', players, { happening });
}

/** `thief` steals a random card, or one oil by name, from a player of their choice. */
function rob(ctx: Ctx, happening: Happening, thief: PlayerId | null) {
  if (thief === null) return nothing(ctx, happening);
  const victims = victimsOf(ctx.s, thief);
  if (victims.length === 0) return nothing(ctx, happening);
  // (A lone victim is robbed at once, unless there's oil to name: then it's a choice.)
  if (victims.length === 1 && !canTakeOil(ctx.s, thief, victims[0])) return doSteal(ctx, thief, victims[0], false, 'almanac');
  owe(ctx, 'almanac/rob', [thief], { happening, victims });
}

/** Crack `edge`, a road of `player`'s. */
export function crack(ctx: Ctx, player: PlayerId, edge: number) {
  ctx.s.routes[edge]!.cracked = true;
  ctx.emit({ type: 'almanac/cracked', player, edge });
}

/** The Road Splits: everyone with a road cracks one; those with a choice of road are asked which. */
function quake(ctx: Ctx) {
  const s = ctx.s;
  const asked: PlayerId[] = [];
  let forced = 0;
  for (const p of fromCurrent(s)) {
    const roads = crackable(s, p);
    if (roads.length === 1) {
      crack(ctx, p, roads[0]);
      forced++;
    } else if (roads.length > 1) asked.push(p);
  }
  if (asked.length > 0) owe(ctx, 'almanac/quake', asked, { happening: 'quake' });
  else if (forced === 0) nothing(ctx, 'quake');
}

/** Over the Fence: everyone holding a card passes one to their left. */
function gifts(ctx: Ctx) {
  const givers = fromCurrent(ctx.s).filter((p) => canGive(ctx.s, p));
  if (givers.length === 0) return nothing(ctx, 'gifts');
  owe(ctx, 'almanac/gift', givers, { happening: 'gifts' });
}

/** Shoulder to the Wheel: the players with the most points each give a card to someone with fewer. */
function helpingHand(ctx: Ctx) {
  const s = ctx.s;
  // (Points as the table sees them: hidden victory cards stay hidden.)
  const pts = s.players.map((p) => publicVictoryPoints(s, p.id));
  const best = Math.max(...pts);
  const recipients = fromCurrent(s).filter((p) => pts[p] < best);
  const givers = fromCurrent(s).filter((p) => pts[p] === best && canGive(s, p));
  if (recipients.length === 0 || givers.length === 0) return nothing(ctx, 'helpingHand');
  owe(ctx, 'almanac/gift', givers, { happening: 'helpingHand', recipients });
}

/**
 * Hue and Cry: the robber goes to a desert, else a swamp, else off the board (rule 4), without stealing.
 * Where Invasion has done away with the robber, the corsair leaves the board instead, until the
 * next 7 brings it back. A blocker already off the board stays off.
 */
function robberFlees(ctx: Ctx) {
  const s = ctx.s;
  if (s.options.modules.includes('invasion')) {
    const from = corsairHex(s);
    if (from === null) return nothing(ctx, 'robberFlees');
    setCorsair(s, null);
    ctx.emit({ type: 'almanac/corsairFled', from });
    return;
  }
  const from = s.robberHex;
  if (from === null) return nothing(ctx, 'robberFlees');
  const to = refugeHex(s);
  if (to === from) return nothing(ctx, 'robberFlees');
  s.robberHex = to;
  ctx.emit({ type: 'almanac/robberFled', from, to });
}

/** Resolve this turn's happening, before production. */
export function resolveHappening(ctx: Ctx, happening: Happening) {
  const s = ctx.s;
  switch (happening) {
    case 'fairDay':
    // (The thieves are the card's 7, which the base game resolves.)
    case 'thieves':
    // (A sickness acts on production itself: see the yields hook.)
    case 'sickness':
      return;
    case 'calmSeas':
      return grant(ctx, happening, harbourLeaders(s));
    case 'harvest':
      return grant(ctx, happening, fromCurrent(s));
    case 'tournament':
      return grant(ctx, happening, strongest(s));
    case 'quarrel':
      return rob(ctx, happening, armyLeader(s));
    case 'windfall':
      return rob(ctx, happening, s.longestRoadHolder);
    case 'quake':
      return quake(ctx);
    case 'gifts':
      return gifts(ctx);
    case 'helpingHand':
      return helpingHand(ctx);
    case 'robberFlees':
      return robberFlees(ctx);
  }
}

/** The Almanac's decision on top of the stack, if that's what's owed. */
export function topDecision(s: GameState): AlmanacDecision | null {
  const top = s.pending[s.pending.length - 1];
  return top && top.kind.startsWith('almanac/') ? (top as AlmanacDecision) : null;
}

/** Whether `p` can still answer the decision (the supply or their hand may have run out). */
export function canAnswer(s: GameState, d: AlmanacDecision, p: PlayerId): boolean {
  switch (d.kind) {
    case 'almanac/quake':
      return crackable(s, p).length > 0;
    case 'almanac/take':
      return bankResources(s).length > 0;
    case 'almanac/gift':
      return canGive(s, p);
    case 'almanac/rob':
      return (d.data.victims ?? []).some((v) => robbable(s, p, v));
  }
}

/** `p` has answered: take them off the decision, along with anyone who no longer can, and drop it once nobody's left. */
export function answered(s: GameState, p: PlayerId) {
  const d = topDecision(s);
  if (!d) return;
  d.players = d.players.filter((q) => q !== p && canAnswer(s, d, q));
  if (d.players.length === 0) s.pending.pop();
}
