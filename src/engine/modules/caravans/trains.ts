// Wagon trains: where the next wagon may go, putting it there, and what wagons are worth.
//
// A train runs nose to tail from its origin on the oasis and grows only at its front, so it never
// branches. Whether a train can still grow follows from the wagons alone: its front is clear when
// the only wagon touching that intersection is its own last one (none at all before it starts).
// A front that reaches an intersection another wagon already touches has met a train, its own
// included, and grows no further; the train it met loses a clear front too if that was its front.

import { bridgeSites } from '../../rules';
import type { GameState } from '../../types';
import { buildingConquered, isConquered } from '../shared';
import type { CaravansState, Train } from './types';

/** Wagons in the game. */
export const WAGONS = 22;

export const caravansOf = (s: GameState): CaravansState => s.ext.caravans!;

/** Every edge holding a wagon. */
export function wagonEdges(s: GameState): Set<number> {
  const out = new Set<number>();
  for (const t of s.ext.caravans?.trains ?? []) for (const e of t.edges) out.add(e);
  return out;
}

/** Whether a wagon stands on `edge`. */
export function hasWagon(s: GameState, edge: number): boolean {
  const trains = s.ext.caravans?.trains;
  if (!trains) return false;
  for (const t of trains) if (t.edges.includes(edge)) return true;
  return false;
}

/** How many wagons touch intersection `vertex`. */
export function wagonsAt(s: GameState, vertex: number, wagons?: Set<number>): number {
  let n = 0;
  // (Without the set, each of the corner's edges is looked for in the trains: cheaper than building
  // the set for one corner, which every building's worth asks.)
  for (const e of s.board.vertices[vertex].edges) if (wagons ? wagons.has(e) : hasWagon(s, e)) n++;
  return n;
}

/**
 * A building between two wagons (two of its edges hold one) is worth a point more, unless it's
 * conquered. A merge can put a third wagon there; it's still one point.
 */
export function wagonPoint(s: GameState, vertex: number): boolean {
  return !!s.buildings[vertex] && wagonsAt(s, vertex) >= 2 && !buildingConquered(s, vertex);
}

/** The oasis's own edges (a train's first wagon faces away from it). */
function oasisRing(s: GameState): Set<number> {
  const oasis = s.board.features.oasis;
  return new Set(oasis ? s.board.hexes[oasis.hex].edges : []);
}

/**
 * Whether a wagon may stand on `edge`: it has none, and it isn't an unbridged bridge site (carts
 * don't ford rivers) or an edge of a conquered hex. Roads, bridges, ships, bare land edges and
 * sea edges all take one.
 */
export function wagonAllowed(s: GameState, edge: number, wagons: Set<number>): boolean {
  if (wagons.has(edge)) return false;
  if (bridgeSites(s).has(edge) && s.routes[edge]?.kind !== 'bridge') return false;
  return !s.board.edges[edge].hexes.some((h) => isConquered(s, h));
}

/** Whether `train`'s front is clear, so it may still grow. */
function isOpen(s: GameState, train: Train, wagons: Set<number>): boolean {
  return wagonsAt(s, train.head, wagons) === (train.edges.length === 0 ? 0 : 1);
}

/** The edges `train` could grow onto now. */
export function growthEdges(s: GameState, train: Train, wagons: Set<number> = wagonEdges(s)): number[] {
  if (!isOpen(s, train, wagons)) return [];
  let edges = s.board.vertices[train.head].edges;
  if (train.edges.length === 0) {
    const ring = oasisRing(s);
    edges = edges.filter((e) => !ring.has(e));
  }
  return edges.filter((e) => wagonAllowed(s, e, wagons));
}

/** Every legal placement for the next wagon, as edges, in origin order (each once). */
export function placements(s: GameState): number[] {
  const st = s.ext.caravans;
  if (!st) return [];
  const wagons = wagonEdges(s);
  const out: number[] = [];
  for (const t of st.trains) for (const e of growthEdges(s, t, wagons)) if (!out.includes(e)) out.push(e);
  return out;
}

/** The train a wagon on `edge` extends, or -1 if none can. */
function trainFor(s: GameState, edge: number, wagons: Set<number> = wagonEdges(s)): number {
  const trains = caravansOf(s).trains;
  // An edge can fit two trains only where their fronts meet across it (the wagons end up the same
  // whichever it extends), or where a running train's front faces an origin whose train hasn't
  // started: then the running train takes it, nose to tail, rather than a new one starting into it.
  const order = trains.map((_, i) => i).sort((a, b) => Number(trains[b].edges.length > 0) - Number(trains[a].edges.length > 0) || a - b);
  return order.find((i) => growthEdges(s, trains[i], wagons).includes(edge)) ?? -1;
}

/** Put a wagon on `edge`, which must be a legal placement, extending the train it fits (see trainFor). */
export function addWagon(s: GameState, edge: number): { train: number; joined: boolean } {
  const st = caravansOf(s);
  const wagons = wagonEdges(s);
  const train = trainFor(s, edge, wagons);
  if (train < 0) throw new Error(`No train can grow onto edge ${edge}.`);
  const t = st.trains[train];
  const e = s.board.edges[edge];
  // (Whether the new front meets a train is read before the wagon goes down: any wagon already there.)
  t.head = e.a === t.head ? e.b : e.a;
  const joined = wagonsAt(s, t.head, wagons) > 0;
  t.edges.push(edge);
  st.supply--;
  return { train, joined };
}

/** `player`'s buildings at a clear train front: the next wagon of that train gives each a point. */
export function frontsAt(s: GameState, player: number): number {
  const st = s.ext.caravans;
  if (!st) return 0;
  const wagons = wagonEdges(s);
  let n = 0;
  for (const t of st.trains) {
    if (t.edges.length === 0 || !isOpen(s, t, wagons)) continue;
    const b = s.buildings[t.head];
    if (b && b.owner === player && !buildingConquered(s, t.head)) n++;
  }
  return n;
}
