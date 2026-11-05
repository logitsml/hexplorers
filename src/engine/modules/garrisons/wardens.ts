// Wardens and walls: the garrisons' pieces, where they may go and what they may do. Read by the
// garrisons' actions, the guilds' ventures (the forge, the rally, masonry, agitators, treachery),
// the fleet and the bots.

import type { Ctx } from '../../ctx';
import { updateLongestRoad } from '../../reducer';
import { breaksRoute, legalRobberHexes, routeFamily, stealCandidates } from '../../rules';
import type { GameState, PlayerId, Warden } from '../../types';
import { buildingConquered, corsairHex, newWardenId } from '../shared';
import { corsairHexes, corsairVictims } from '../sea/rules';
import { ABILITY_LEVEL, levelOf } from '../guilds/rules';
import type { Blocker, GarrisonsState, RetreatPending, WardenRank } from './types';

/** Pieces of each rank a player has. */
export const WARDEN_PIECES = 2;
/** Walls a player may have built at once. */
export const WALL_LIMIT = 3;
/** What each wall adds to its owner's hand limit on a 7. */
export const WALL_HAND_BONUS = 2;

export const garrisonsOf = (s: GameState): GarrisonsState => s.ext.garrisons!;

/** Under Invasion the wardens stand on edges and Invasion moves them; garrisons' own moves are off. */
export const invaded = (s: GameState): boolean => s.options.modules.includes('invasion');

export const wardenById = (s: GameState, id: number): Warden | undefined => s.wardens.find((w) => w.id === id);

export const wardenAt = (s: GameState, vertex: number): Warden | undefined => s.wardens.find((w) => w.vertex === vertex);

export const wardensOf = (s: GameState, player: PlayerId): Warden[] => s.wardens.filter((w) => w.owner === player);

/** Pieces of `rank` `player` still has in their supply. */
export function freePieces(s: GameState, player: PlayerId, rank: WardenRank): number {
  let n = 0;
  for (const w of s.wardens) if (w.owner === player && w.rank === rank) n++;
  return WARDEN_PIECES - n;
}

/** Total rank of `player`'s mustered wardens (their share of the defence). */
export function musteredStrength(s: GameState, player: PlayerId): number {
  let n = 0;
  for (const w of s.wardens) if (w.owner === player && w.mustered) n += w.rank;
  return n;
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

/** Walls `player` has standing (a wall comes back when its city is reduced). */
export function wallsOf(s: GameState, player: PlayerId): number {
  let n = 0;
  for (const b of s.buildings) if (b?.wall && b.owner === player) n++;
  return n;
}

/** Walls that count toward `player`'s hand limit (a conquered city's wall doesn't). */
export function countingWalls(s: GameState, player: PlayerId): number {
  let n = 0;
  s.buildings.forEach((b, v) => {
    if (b?.wall && b.owner === player && !buildingConquered(s, v)) n++;
  });
  return n;
}

/** Cities of `player`'s that could take a wall now. */
export function wallSites(s: GameState, player: PlayerId): number[] {
  if (wallsOf(s, player) >= WALL_LIMIT) return [];
  const out: number[] = [];
  s.buildings.forEach((b, v) => {
    if (b && b.owner === player && b.kind === 'city' && !b.wall) out.push(v);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Placing wardens
// ---------------------------------------------------------------------------

/** An intersection with no building and no warden on it. */
const empty = (s: GameState, v: number) => !s.buildings[v] && !wardenAt(s, v);

/** Whether one of `player`'s route pieces touches intersection `v`. */
export const touchesRoute = (s: GameState, player: PlayerId, v: number): boolean => s.board.vertices[v].edges.some((e) => s.routes[e]?.owner === player);

/** Empty intersections beside `player`'s routes: where a recruit (or a warden placed by a venture) may stand. */
export function recruitSpots(s: GameState, player: PlayerId): number[] {
  const out: number[] = [];
  for (const v of s.board.vertices) if (empty(s, v.id) && touchesRoute(s, player, v.id)) out.push(v.id);
  return out;
}

/** Under Invasion: the castle's edges with no warden on them. */
export function castleEdges(s: GameState): number[] {
  const castle = s.board.features.castle;
  if (castle === undefined) return [];
  return s.board.hexes[castle].edges.filter((e) => !s.wardens.some((w) => w.edge === e));
}

/** Whether `edge` is one of the castle hex's (Invasion). */
function onCastle(s: GameState, edge: number | null): boolean {
  const castle = s.board.features.castle;
  return edge !== null && castle !== undefined && s.board.hexes[castle].edges.includes(edge);
}

/** Put a new warden on the board for `player`. */
export function placeWarden(s: GameState, player: PlayerId, rank: WardenRank, at: { vertex: number | null; edge: number | null }, mustered = false): Warden {
  const w: Warden = { id: newWardenId(s), owner: player, rank, mustered, vertex: at.vertex, edge: at.edge, musteredTurn: mustered ? s.turn : 0 };
  s.wardens.push(w);
  return w;
}

/** Wardens moved, came or went: they break routes, so Longest Route may change. */
export function wardensChanged(ctx: Ctx) {
  if (!invaded(ctx.s)) updateLongestRoad(ctx);
}

// ---------------------------------------------------------------------------
// Promotion and mustering
// ---------------------------------------------------------------------------

/** Why `w` can't be promoted by `player` now, or null if it can (the cost aside). */
export function promoteBlocker(s: GameState, player: PlayerId, w: Warden | undefined): string | null {
  if (!w || w.owner !== player) return 'That is not your warden.';
  if (w.vertex === null && w.edge === null) return 'That warden is not on the board.';
  if (w.rank >= 3) return 'Champions are the highest rank.';
  const next = (w.rank + 1) as WardenRank;
  if (freePieces(s, player, next) <= 0) return 'You have no free warden of the next rank.';
  if (next === 3 && levelOf(s, player, 'statecraft') < ABILITY_LEVEL) return 'Champions need Statecraft level 3.';
  if (garrisonsOf(s).promoted.includes(w.id)) return 'A warden may be promoted once a turn.';
  return null;
}

/** Promote `w` one rank (it keeps its mustered state). */
export function promote(ctx: Ctx, w: Warden, free: boolean) {
  w.rank = (w.rank + 1) as WardenRank;
  garrisonsOf(ctx.s).promoted.push(w.id);
  ctx.emit({ type: 'garrisons/promoted', player: w.owner, warden: w.id, rank: w.rank, free });
}

/** Whether a resting warden of `player`'s may be mustered (under Invasion, not while on a castle edge). */
export function canMuster(s: GameState, player: PlayerId, w: Warden | undefined): boolean {
  if (!w || w.owner !== player || w.mustered) return false;
  if (w.vertex === null && w.edge === null) return false;
  return !(invaded(s) && onCastle(s, w.edge));
}

export function muster(s: GameState, w: Warden) {
  w.mustered = true;
  w.musteredTurn = s.turn;
}

// ---------------------------------------------------------------------------
// Moving along routes
// ---------------------------------------------------------------------------

/**
 * Where a warden of `player`'s standing at `from` can go along `player`'s continuous routes: through
 * empty intersections and `player`'s own buildings and wardens, never past an opponent's piece, and
 * from roads onto ships (or back) only at `player`'s own building. `stops` are the empty
 * intersections it may end on; `foes` the opponents' wardens it may walk onto.
 */
export function reach(s: GameState, player: PlayerId, from: number): { stops: number[]; foes: number[] } {
  const stops = new Set<number>();
  const foes = new Set<number>();
  const seen = new Set<string>();
  const queue: [number, 'land' | 'sea' | null][] = [[from, null]];
  seen.add(`${from}`);
  for (let qi = 0; qi < queue.length; qi++) {
    const [v, fam] = queue[qi];
    const own = s.buildings[v]?.owner === player;
    for (const e of s.board.vertices[v].edges) {
      const r = s.routes[e];
      if (!r || r.owner !== player) continue;
      const f = routeFamily(r.kind);
      if (fam !== null && f !== fam && !own) continue;
      const ed = s.board.edges[e];
      const u = ed.a === v ? ed.b : ed.a;
      if (u === from) continue;
      const w = wardenAt(s, u);
      if (w && w.owner !== player) {
        foes.add(w.id);
        continue;
      }
      const b = s.buildings[u];
      if (b && b.owner !== player) continue;
      if (!b && !w) stops.add(u);
      const key = `${u}:${f}`;
      if (seen.has(key) || (!b && !w && breaksRoute(s, player, u))) continue;
      seen.add(key);
      queue.push([u, f]);
    }
  }
  return { stops: [...stops].sort((a, b) => a - b), foes: [...foes].sort((a, b) => a - b) };
}

/** A warden that may act this turn: mustered before this turn began, standing on an intersection (never under Invasion). */
export const canAct = (s: GameState, w: Warden): boolean => !invaded(s) && w.mustered && w.musteredTurn < s.turn && w.vertex !== null;

/** The opponents' wardens `w` is strong enough to displace. */
export function displaceTargets(s: GameState, w: Warden): number[] {
  return reach(s, w.owner, w.vertex!).foes.filter((id) => wardenById(s, id)!.rank < w.rank);
}

/**
 * A warden is displaced from where it stands: its owner owes a retreat along their routes, or it
 * leaves the board if it has nowhere to go. While the retreat is owed it stands nowhere.
 */
export function unseat(ctx: Ctx, w: Warden) {
  const s = ctx.s;
  const from = w.vertex!;
  w.vertex = null;
  const { stops } = reach(s, w.owner, from);
  if (stops.length === 0) {
    s.wardens = s.wardens.filter((x) => x.id !== w.id);
    ctx.emit({ type: 'garrisons/removed', player: w.owner, warden: w.id, reason: 'noRetreat' });
    return;
  }
  const d: RetreatPending = { kind: 'garrisons/retreat', warden: w.id, from };
  s.pending.push({ kind: d.kind, players: [w.owner], data: d });
}

/** Where a displaced warden may retreat to (its owner's routes from where it was). */
export function retreatSpots(s: GameState, d: RetreatPending): number[] {
  const w = wardenById(s, d.warden);
  if (!w) return [];
  return reach(s, w.owner, d.from).stops;
}

// ---------------------------------------------------------------------------
// Chasing blockers
// ---------------------------------------------------------------------------

/**
 * Where the robber or the corsair may be chased to by a warden at `w`, with the players it could
 * rob there: anyone the robber or corsair itself could rob, a player holding only oil included
 * (the thief may name it, with room for it).
 */
export function chaseOptions(s: GameState, w: Warden, blocker: Blocker): { hex: number; victims: PlayerId[] }[] {
  if (w.vertex === null) return [];
  if (blocker === 'robber') {
    const h = s.robberHex;
    if (h === null || !s.board.hexes[h].vertices.includes(w.vertex)) return [];
    return legalRobberHexes(s).map((hex) => ({ hex, victims: stealCandidates(s, hex, w.owner) }));
  }
  const c = corsairHex(s);
  if (c === null || !s.board.hexes[c].vertices.includes(w.vertex)) return [];
  // (Wherever the corsair itself may go: open water, never a face-down hex, as the friendly robber allows.)
  return corsairHexes(s).map((hex) => ({ hex, victims: corsairVictims(s, hex, w.owner) }));
}
