// Improvements: climbing a track a level at a time, and the seats the first to levels 4 and 5 hold.

import { cards as cardsOf } from '../../constants';
import { type Ctx, assert, moveCards } from '../../ctx';
import type { GameState, PlayerId, Track } from '../../types';
import { returnVenture, takeFromHand } from './deck';
import { MAX_LEVEL, SEAT_LEVEL, TRACKS, TRACK_COMMODITY, citiesOf, guildsOf, levelCost, seatHolder, seatSites, seatVertex, trackFrozen } from './rules';
import type { GuildsAction } from './types';

type Improve = Extract<GuildsAction, { type: 'guilds/improve' }>;

/**
 * What reaching `level` on `track` does to its seat for `player`: they take it (the first to 4, or
 * the first to 5 when someone else holds it), it stays where it is and becomes theirs for good
 * (they held it and reach 5 first), or nothing.
 */
export function seatChange(s: GameState, player: PlayerId, track: Track, level: number): 'take' | 'keep' | 'none' {
  if (level < SEAT_LEVEL) return 'none';
  const holder = seatHolder(s, track);
  if (level === SEAT_LEVEL) return holder === null ? 'take' : 'none';
  if (guildsOf(s).seatsForGood.includes(track)) return 'none';
  return holder === player ? 'keep' : 'take';
}

/** Commodities the next level on `track` costs `player` (one less with a hoist). */
export const improveCost = (s: GameState, player: PlayerId, track: Track, hoist: boolean): number =>
  Math.max(0, levelCost(guildsOf(s).levels[player][track] + 1) - (hoist ? 1 : 0));

/** Why `player` can't make this improvement now (the phase aside), or null if they can. */
export function improveError(s: GameState, player: PlayerId, a: Omit<Improve, 'type'>): string | null {
  const g = guildsOf(s);
  const { track, hoist, vertex } = a;
  if (!TRACKS.includes(track)) return 'Unknown track.';
  const level = g.levels[player][track];
  if (level >= MAX_LEVEL) return 'That track is complete.';
  if (citiesOf(s, player).length === 0) return 'Improvements need a town.';
  if (trackFrozen(s, player, track)) return "That track's seat is cut off.";
  if (hoist !== undefined && typeof hoist !== 'boolean') return 'Invalid hoist.';
  if (hoist && !g.hands[player].includes('hoist')) return 'You have no hoist.';
  const cost = improveCost(s, player, track, !!hoist);
  if (s.players[player].hand[TRACK_COMMODITY[track]] < cost) return `You need ${cost} ${TRACK_COMMODITY[track]}.`;
  const change = seatChange(s, player, track, level + 1);
  if (level + 1 >= SEAT_LEVEL && change !== 'keep') {
    // Levels 4 and 5 need a city that could hold a seat (unless you're keeping the one you hold).
    const sites = seatSites(s, player);
    if (sites.length === 0) return 'You need a town that could hold a seat.';
    if (change === 'take' && (vertex === undefined || !sites.includes(vertex))) return 'Choose a town for the seat.';
  }
  if (change !== 'take' && vertex !== undefined) return 'There is no seat to place.';
  return null;
}

/** Every improvement `player` could make now. */
export function improveOptions(s: GameState, player: PlayerId): Improve[] {
  const out: Improve[] = [];
  const g = guildsOf(s);
  const hoists = g.hands[player].includes('hoist') ? [false, true] : [false];
  for (const track of TRACKS) {
    const level = g.levels[player][track];
    if (level >= MAX_LEVEL) continue;
    const vertices = seatChange(s, player, track, level + 1) === 'take' ? seatSites(s, player) : [undefined];
    for (const hoist of hoists) {
      for (const vertex of vertices) {
        const a: Improve = { type: 'guilds/improve', track };
        if (hoist) a.hoist = true;
        if (vertex !== undefined) a.vertex = vertex;
        if (improveError(s, player, a) === null) out.push(a);
      }
    }
  }
  return out;
}

/** Make the improvement: pay, climb, and take or keep the seat. */
export function improve(ctx: Ctx, player: PlayerId, a: Improve) {
  const s = ctx.s;
  const g = guildsOf(s);
  const err = improveError(s, player, a);
  assert(err === null, err ?? '');
  const c = TRACK_COMMODITY[a.track];
  const cost = improveCost(s, player, a.track, !!a.hoist);
  moveCards(ctx, player, null, cardsOf({ [c]: cost }), 'improvement');
  if (a.hoist) {
    takeFromHand(s, player, 'hoist');
    returnVenture(s, 'hoist');
    ctx.emit({ type: 'guilds/played', player, card: 'hoist' });
  }
  const level = ++g.levels[player][a.track];
  ctx.emit({ type: 'guilds/improved', player, track: a.track, level });
  const change = seatChange(s, player, a.track, level);
  const forGood = level === MAX_LEVEL;
  if (change === 'take') {
    const from = seatVertex(s, a.track);
    const was = from === null ? null : s.buildings[from]!.owner;
    if (from !== null) delete s.buildings[from]!.seat;
    s.buildings[a.vertex!]!.seat = a.track;
    if (forGood) g.seatsForGood.push(a.track);
    ctx.emit({ type: 'guilds/seat', player, track: a.track, vertex: a.vertex!, from, was, forGood });
  } else if (change === 'keep') {
    g.seatsForGood.push(a.track);
    const at = seatVertex(s, a.track)!;
    ctx.emit({ type: 'guilds/seat', player, track: a.track, vertex: at, from: at, was: player, forGood: true });
  }
}
