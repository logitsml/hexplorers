// The ground Invasion is fought over: the home island's coast in clockwise order from the castle,
// the edges wardens may stand on, and distances along them. All of it follows from the board
// alone, so it's worked out once per board.

import { isLand } from '../../constants';
import type { Board } from '../../types';

interface Topology {
  /** The home island's id. */
  home: number;
  /** The castle hex, or null on a board without one. */
  castle: number | null;
  /** Home land hexes on the coast, clockwise from the castle (the order landings break ties in and battles run in). */
  coast: number[];
  /** Whether each hex is one of `coast`. */
  coastal: boolean[];
  /** Whether each edge is one a warden may stand on: it touches the home island. */
  wardenEdge: boolean[];
  /** Whether each edge is an edge of the castle hex. */
  castleEdge: boolean[];
  /** For each warden edge, the warden edges sharing a corner with it. */
  next: number[][];
}

const cache = new WeakMap<Board, Topology>();

export function topology(board: Board): Topology {
  let t = cache.get(board);
  if (!t) {
    t = build(board);
    cache.set(board, t);
  }
  return t;
}

function build(board: Board): Topology {
  const home = board.islands.find((i) => i.home)?.id ?? 0;
  const onHome = (h: number) => isLand(board.hexes[h].terrain) && board.hexes[h].island === home;
  const homeHexes = board.hexes.filter((h) => onHome(h.id));
  const castle = board.features.castle ?? null;

  // A hex is on the coast when one of its edges borders no other land. (Not the lake, which is
  // water: a lake on the shore takes no raiders.)
  const coastal = board.hexes.map((h) => onHome(h.id) && h.terrain !== 'lake' && h.edges.some((e) => board.edges[e].coastal));

  // Clockwise as seen from above: +x is east and +z south, so the angle atan2(z, x) grows clockwise.
  const cx = homeHexes.reduce((n, h) => n + h.x, 0) / Math.max(1, homeHexes.length);
  const cz = homeHexes.reduce((n, h) => n + h.z, 0) / Math.max(1, homeHexes.length);
  const angle = (h: number) => Math.atan2(board.hexes[h].z - cz, board.hexes[h].x - cx);
  // (Without a castle the round starts at the top of the island.)
  const start = castle !== null ? angle(castle) : -Math.PI / 2;
  const turn = (h: number) => {
    let a = angle(h) - start;
    while (a < -1e-9) a += 2 * Math.PI;
    if (a > 2 * Math.PI - 1e-9) a = 0;
    return a;
  };
  const coast = homeHexes
    .filter((h) => coastal[h.id] && h.id !== castle)
    .map((h) => h.id)
    .sort((a, b) => turn(a) - turn(b) || a - b);

  const wardenEdge = board.edges.map((e) => e.hexes.some(onHome));
  const castleEdge = board.edges.map(() => false);
  if (castle !== null) for (const e of board.hexes[castle].edges) castleEdge[e] = true;
  const next = board.edges.map((e) => {
    if (!wardenEdge[e.id]) return [];
    const out = new Set<number>();
    for (const v of [e.a, e.b]) for (const f of board.vertices[v].edges) if (f !== e.id && wardenEdge[f]) out.add(f);
    return [...out].sort((a, b) => a - b);
  });
  return { home, castle, coast, coastal, wardenEdge, castleEdge, next };
}

const withinCache = new WeakMap<Board, Map<number, ReadonlyMap<number, number>>>();

/**
 * Edges within `max` steps of `from` along warden edges, with their distance (`from` itself at 0).
 * Like the rest of the topology it follows from the board alone, so each is worked out once per
 * board (and shared: callers only read it).
 */
export function edgesWithin(board: Board, from: number, max: number): ReadonlyMap<number, number> {
  let byBoard = withinCache.get(board);
  if (!byBoard) withinCache.set(board, (byBoard = new Map()));
  // (Edge ids are below 2^20 on any board, and the reaches asked for are small.)
  const key = max * 1048576 + from;
  let dist = byBoard.get(key);
  if (!dist) byBoard.set(key, (dist = within(board, from, max)));
  return dist;
}

function within(board: Board, from: number, max: number): Map<number, number> {
  const t = topology(board);
  const dist = new Map<number, number>([[from, 0]]);
  let frontier = [from];
  for (let d = 1; d <= max && frontier.length > 0; d++) {
    const nextFrontier: number[] = [];
    for (const e of frontier) {
      for (const f of t.next[e]) {
        if (dist.has(f)) continue;
        dist.set(f, d);
        nextFrontier.push(f);
      }
    }
    frontier = nextFrontier;
  }
  return dist;
}

/**
 * The die's edge orientation after a victory, as the three pairs of opposite sides of a hex
 * (sides are numbered NE 0, E 1, SE 2, SW 3, W 4, NW 5, so a pair is a side index mod 3): 1 or 6
 * picks the upper-left and lower-right slopes, 2 or 5 the upper-right and lower-left, 3 or 4 the
 * two upright sides.
 */
export const orientationOf = (die: number): number => (die === 1 || die === 6 ? 2 : die === 2 || die === 5 ? 0 : 1);

/** The orientation (0-2) of `edge` as a side of `hex`, or -1 if it isn't one of its sides. */
export function sideOrientation(board: Board, hex: number, edge: number): number {
  const i = board.hexes[hex].edges.indexOf(edge);
  return i < 0 ? -1 : i % 3;
}
