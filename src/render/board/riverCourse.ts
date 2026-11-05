// A river's course across the island, worked out once per board and carried in each tile's
// context (TileContext.river), so the heightfield cuts the same channel whether a tile is built
// on a terrain worker or here. Pure maths, no three.js and no DOM: the workers import it.
//
// The river crosses an edge only at a bridge site, at the edge's midpoint and square to it, and
// between crossings it bends round the number disc and keeps off the corners (buildings) and
// the other edges (roads), so nothing a player builds ever stands in the water.

import type { Board, Hex } from '../../engine';
import { CORNER_OFFSETS } from '../../engine/board';
import type { TileContext, TileShape } from './terrain';
import { HEX_APOTHEM } from './layout';

export interface RiverCourse {
  /** The centreline in the tile's own coordinates, as x, z pairs, downstream. */
  pts: number[];
  /** The water's surface height at each point. */
  level: number[];
  /** Half the water's width at each point. */
  half: number[];
  /** The box the channel can touch: minX, minZ, maxX, maxZ (the centreline's, grown by REACH). */
  box: number[];
  /** The side it comes in by, or -1 where it rises in this tile. */
  in: number;
  /** The side it leaves by. */
  out: number;
  /** Whether it leaves into the sea here (the mouth, over the cliff). */
  mouth: boolean;
  /** The first point's distance along the whole river, so the current runs on unbroken from tile to tile. */
  s0: number;
  /** A watermill on the bank (one on the board, where a stretch has room): see MillSite. */
  mill?: MillSite;
  /** The level of the standing water the tile holds (a swamp's pools, a lake), which the river runs through at its level. */
  still?: number;
}

/**
 * A watermill's place: the house on a levelled patch of bank at (x, z), its wheel turning in the
 * water beside it. `y` is the patch's height, `angle` the river's heading there (radians from +x
 * towards +z), `side` which bank (+1 to the left of the current, -1 to the right), `i` the
 * course point it stands by.
 */
interface MillSite {
  x: number;
  z: number;
  r: number;
  y: number;
  angle: number;
  side: number;
  i: number;
}

/** Half the water's width where it passes under a bridge: the bridges span 0.12 of water. */
const RIVER_HALF = 0.06;
/** Depth of the water at the middle of the channel. */
const RIVER_DEPTH = 0.022;
/** How far below the ground it runs through the water's surface lies. */
const SURFACE_DROP = 0.006;
/** The surface at the cliff lip, where it spills over into the sea (the lip itself is at -0.02). */
const MOUTH_LEVEL = -0.016;
/** Half the water's width at the mouth, where it spreads out over the lip (still under a bridge's 0.166 arch). */
const MOUTH_HALF = 0.075;
/** Spacing of the centreline's points. */
const STEP = 0.02;
/** Beyond this distance from the centreline the channel's banks are above any ground (see bankAt). */
const REACH = 0.33;

const sideAngle = (i: number) => ((-60 + 60 * i) * Math.PI) / 180;
/** Side i's outward normal (pointy-top: NE first, as terrain's sides). */
export const sideNormal = (i: number): [number, number] => [Math.cos(sideAngle(i)), Math.sin(sideAngle(i))];

// ----------------------------------------------------------------------------- queries

/** Scratch result of `nearest`: distance to the centreline, and the water there. */
const near = { d: Infinity, level: 0, half: RIVER_HALF, u: 0, i: 0, s: 0 };

/**
 * Which segments can be within REACH of each cell of a coarse grid over the tile, so a query
 * looks at a handful rather than all of them: heights are asked for tens of thousands of times
 * as a tile is built (and the ambient occlusion bake asks a dozen more for each vertex). Made
 * on first use, on whichever thread builds the tile.
 */
const GRID = 18;
const CELL = 2.2 / GRID;
const grids = new WeakMap<RiverCourse, Int32Array[]>();

function gridOf(c: RiverCourse): Int32Array[] {
  let g = grids.get(c);
  if (g) return g;
  g = [];
  const p = c.pts;
  const reach = REACH + CELL * 0.75;
  for (let cz = 0; cz < GRID; cz++)
    for (let cx = 0; cx < GRID; cx++) {
      const x = -1.1 + (cx + 0.5) * CELL, z = -1.1 + (cz + 0.5) * CELL;
      const list: number[] = [];
      for (let i = 0; i + 3 < p.length; i += 2) if (segDist2(p, i, x, z) < reach * reach) list.push(i);
      g.push(Int32Array.from(list));
    }
  grids.set(c, g);
  return g;
}

/** Squared distance from (x, z) to the segment starting at point index i (in pairs). */
function segDist2(p: number[], i: number, x: number, z: number) {
  const ax = p[i], az = p[i + 1];
  const dx = p[i + 2] - ax, dz = p[i + 3] - az;
  const l2 = dx * dx + dz * dz;
  let u = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const ex = ax + dx * u - x, ez = az + dz * u - z;
  return ex * ex + ez * ez;
}

/**
 * The nearest point of the centreline to (x, z), if it is within REACH: fills `near` (u is the
 * fraction along segment i). Beyond REACH, `near.d` is Infinity.
 */
function nearest(c: RiverCourse, x: number, z: number) {
  const p = c.pts;
  let best = Infinity;
  let bi = 0;
  let bu = 0;
  const gx = Math.floor((x + 1.1) / CELL), gz = Math.floor((z + 1.1) / CELL);
  const list = gx >= 0 && gz >= 0 && gx < GRID && gz < GRID ? gridOf(c)[gz * GRID + gx] : null;
  if (!list || !list.length) {
    near.d = Infinity;
    return near;
  }
  for (let j = 0; j < list.length; j++) {
    const i = list[j];
    const ax = p[i], az = p[i + 1];
    const dx = p[i + 2] - ax, dz = p[i + 3] - az;
    const l2 = dx * dx + dz * dz;
    let u = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const ex = ax + dx * u - x, ez = az + dz * u - z;
    const d2 = ex * ex + ez * ez;
    if (d2 < best) {
      best = d2;
      bi = i >> 1;
      bu = u;
    }
  }
  near.d = Math.sqrt(best);
  near.i = bi;
  near.u = bu;
  near.level = c.level[bi] + (c.level[Math.min(bi + 1, c.level.length - 1)] - c.level[bi]) * bu;
  near.half = c.half[bi] + (c.half[Math.min(bi + 1, c.half.length - 1)] - c.half[bi]) * bu;
  near.s = c.s0 + (bi + bu) * STEP;
  return near;
}

const inBox = (c: RiverCourse, x: number, z: number) => x >= c.box[0] && z >= c.box[1] && x <= c.box[2] && z <= c.box[3];

/**
 * The ground's profile across the channel at distance `d` from its centreline: a rounded bed
 * `RIVER_DEPTH` deep under the surface, meeting the surface at the water's edge, then banks that
 * lie back in a bevel (a stream's valley, not a trench) and only steepen well out, so that by
 * REACH they stand above the tallest peak (and the cut never shows a seam).
 */
function bankAt(d: number, level: number, half: number) {
  if (d < half) {
    const t = d / half;
    return level - RIVER_DEPTH * (1 - t * t);
  }
  const b = d - half;
  const k = b / 0.17;
  return level + b * 0.5 + k * k * k * 0.36;
}

/** Polynomial smooth minimum, so the banks round over into the ground instead of creasing. */
function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** The ground at local (x, z), `h` before the river, with its channel cut (and a mill's patch levelled). */
export function carveRiver(c: RiverCourse, x: number, z: number, h: number): number {
  if (!inBox(c, x, z)) return h;
  const q = nearest(c, x, z);
  if (q.d >= REACH) return h;
  // (A wide smoothing, so the bevel rounds over into the ground above it.)
  let out = smin(h, bankAt(q.d, q.level, q.half), 0.022);
  const m = c.mill;
  if (m) {
    // The mill's patch of bank, levelled on the land side only (the wheel's water stays open).
    const dm = Math.hypot(x - m.x, z - m.z);
    if (dm < m.r * 1.4) out += (m.y - out) * (1 - smooth01(m.r * 0.75, m.r * 1.4, dm)) * smooth01(q.half + 0.005, q.half + 0.03, q.d);
  }
  return out;
}

/** Whether a prop of `radius` at (x, z) stays out of the water (and off the wet edge of the bank, and off a mill's patch). */
export function riverClear(c: RiverCourse, x: number, z: number, radius: number): boolean {
  if (!inBox(c, x, z)) return true;
  if (c.mill && Math.hypot(x - c.mill.x, z - c.mill.z) < c.mill.r + Math.max(0, radius)) return false;
  const q = nearest(c, x, z);
  return q.d > q.half + 0.035 + Math.max(0, radius);
}

/** Distance from (x, z) to the centreline, and the water there (null when well away from it). */
export function riverAt(c: RiverCourse, x: number, z: number): { d: number; level: number; half: number; s: number } | null {
  if (!inBox(c, x, z)) return null;
  const q = nearest(c, x, z);
  return Number.isFinite(q.d) ? { d: q.d, level: q.level, half: q.half, s: q.s } : null;
}

/** Colour tints for the channel, as RGB triples (stored, like every palette, as square roots). */
const BED = [0.27, 0.25, 0.16];
const MUD = [0.36, 0.27, 0.17];
const PEBBLE = [0.55, 0.52, 0.47];

/**
 * Tint the ground colour `out` (an RGB object) for the channel: a dark silty bed under the
 * water, a band of wet mud and pebbles at the water's edge, and damp earth fading up the banks.
 */
export function tintRiver(c: RiverCourse, x: number, z: number, h: number, out: { r: number; g: number; b: number }) {
  if (!inBox(c, x, z)) return;
  // (Not on standing water's surface: where the river runs through a pool, the pool is all that
  // shows there, with no muddy bank or silty bed of the river's own.)
  if (c.still !== undefined && h <= c.still + 1e-5) return;
  const q = nearest(c, x, z);
  const edge = q.d - q.half;
  if (edge > 0.09) return;
  const mix = (col: number[], t: number) => {
    out.r += (col[0] - out.r) * t;
    out.g += (col[1] - out.g) * t;
    out.b += (col[2] - out.b) * t;
  };
  // Damp up the bank, darkest just above the waterline.
  const damp = 1 - Math.min(1, Math.max(0, edge / 0.09));
  mix(MUD, damp * damp * 0.7);
  // Pebbles in a broken band along the edge (the broken pattern is hashed from position).
  const hsh = Math.sin(x * 91.7 + z * 57.3) * 43758.5453;
  const grit = hsh - Math.floor(hsh);
  if (edge > -0.02 && edge < 0.025 && grit > 0.45) mix(PEBBLE, 0.55 * (1 - Math.abs(edge) / 0.025));
  // The bed: silt, darker in the deep middle.
  if (h < q.level) mix(BED, Math.min(1, (q.level - h) / (RIVER_DEPTH * 0.5)));
}

// ----------------------------------------------------------------------------- planning

interface Candidate {
  pts: number[];
  score: number;
}

/** Points of a cubic Hermite segment from p0 to p1 with tangents t0, t1 (dense: resampled later). */
function hermite(out: number[], p0: number[], t0: number[], p1: number[], t1: number[], n = 48) {
  for (let k = out.length ? 1 : 0; k <= n; k++) {
    const u = k / n, u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    out.push(h00 * p0[0] + h10 * t0[0] + h01 * p1[0] + h11 * t1[0], h00 * p0[1] + h10 * t0[1] + h01 * p1[1] + h11 * t1[1]);
  }
}

/** The polyline resampled at even STEP spacing (its last point kept exactly). */
function resample(p: number[]): number[] {
  const out = [p[0], p[1]];
  let carry = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
    const len = Math.hypot(bx - ax, bz - az);
    let t = STEP - carry;
    while (t <= len) {
      out.push(ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len);
      t += STEP;
    }
    carry = len - (t - STEP);
  }
  const lx = p[p.length - 2], lz = p[p.length - 1];
  if (Math.hypot(out[out.length - 2] - lx, out[out.length - 1] - lz) < STEP * 0.4) out.length -= 2;
  out.push(lx, lz);
  return out;
}

/**
 * How well a course keeps clear of what the tile holds: the least clearance (in world units)
 * over its points from the corners, from every edge it doesn't cross, from the disc (or the
 * cluster of discs), and from the tile's own landmark (the kiln, windmill or mine) and pit.
 */
function clearance(pts: number[], skip: number[], hex: Hex, shape: TileShape): number {
  const discR = hex.numbers.length > 1 ? 0.46 : 0.33;
  const a = shape.features.anchor;
  const pit = shape.features.pit;
  let worst = Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], z = pts[i + 1];
    const half = RIVER_HALF + 0.01;
    for (const [cx, cz] of CORNER_OFFSETS) worst = Math.min(worst, Math.hypot(x - cx, z - cz) - 0.3 - half);
    for (let s = 0; s < 6; s++) {
      if (skip.includes(s)) continue;
      const [nx, nz] = sideNormal(s);
      worst = Math.min(worst, HEX_APOTHEM - (x * nx + z * nz) - 0.13 - half);
    }
    worst = Math.min(worst, Math.hypot(x, z) - discR - half);
    if (a) worst = Math.min(worst, Math.hypot(x - a.x, z - a.z) - 0.2 - half);
    if (pit) worst = Math.min(worst, Math.hypot(x - pit.x, z - pit.z) - pit.r - half);
  }
  return worst;
}

/** How sharply a course bends at its tightest (radians per unit length): tight kinks read badly. */
function kink(pts: number[]): number {
  let worst = 0;
  for (let i = 2; i + 3 < pts.length; i += 2) {
    const a1 = Math.atan2(pts[i + 1] - pts[i - 1], pts[i] - pts[i - 2]);
    const a2 = Math.atan2(pts[i + 3] - pts[i + 1], pts[i + 2] - pts[i]);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    worst = Math.max(worst, d / STEP);
  }
  return worst;
}

/** A tiny deterministic hash in [0, 1) (so every board plans its rivers the same way). */
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The best course through one tile: from the middle of side `enter` (or a spring, when it is -1)
 * to the middle of side `leave`, square to both edges, bending round the disc by way of one
 * waypoint. Candidates vary the waypoint's distance and angle and the curve's tension, and the
 * one that keeps the widest berth from everything on the tile (see clearance) wins.
 */
function bestCourse(hex: Hex, shape: TileShape, enter: number, leave: number): number[] {
  const R = HEX_APOTHEM;
  const X = sideNormal(leave).map((v) => v * R);
  const TX = sideNormal(leave);
  const th = (i: number) => sideAngle(i);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const cands: Candidate[] = [];
  const consider = (dense: number[], extra: number) => {
    const pts = resample(dense);
    const clear = clearance(pts, enter < 0 ? [leave] : [enter, leave], hex, shape);
    // Rivers keep to low ground: a course over a rise would have to cut a gorge through it.
    let high = 0;
    for (let i = 0; i < pts.length; i += 2) high += Math.max(0, shape.height(pts[i], pts[i + 1]) - 0.07);
    const score = Math.min(clear, 0.08) * 12 - Math.max(0, kink(pts) - 9) * 0.04 - (high / (pts.length / 2)) * 1.5 + extra;
    cands.push({ pts, score });
  };
  const scale = (v: number[], k: number) => [v[0] * k, v[1] * k];
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (enter >= 0) {
    const E = sideNormal(enter).map((v) => v * R);
    const TE = sideNormal(enter).map((v) => -v);
    const d = (leave - enter + 6) % 6;
    const turns = d === 3 ? [3, -3] : d < 3 ? [d] : [d - 6];
    for (const turn of turns)
      for (const r of [0.44, 0.5, 0.56, 0.62])
        for (const jit of [-0.14, 0, 0.14])
          for (const k of [0.6, 0.85, 1.1]) {
            const phi = th(enter) + (turn * Math.PI) / 6 + jit;
            const W = [Math.cos(phi) * r, Math.sin(phi) * r];
            const c1 = dist(E, W), c2 = dist(W, X);
            const TW = scale([-Math.sin(phi) * Math.sign(turn), Math.cos(phi) * Math.sign(turn)], (c1 + c2) * 0.5);
            const dense: number[] = [];
            hermite(dense, E, scale(TE, c1 * k), W, TW);
            hermite(dense, W, TW, X, scale(TX, c2 * k));
            consider(dense, hash(hex.id * 13 + r * 7 + jit * 3 + k) * 0.02);
          }
  } else {
    // A spring: somewhere on the far side of the tile, the river rising from the ground (on a
    // mountain, high on a flank, so it tumbles down towards the plain).
    const mountain = shape.terrain === 'mountains';
    for (let j = -3; j <= 3; j++)
      for (const rs of [0.42, 0.52, 0.6]) {
        const phi = th(leave) + Math.PI + j * 0.55;
        const S = [Math.cos(phi) * rs, Math.sin(phi) * rs];
        const travel = wrap(th(leave) - phi);
        const ways = Math.abs(Math.abs(travel) - Math.PI) < 0.3 ? [Math.PI, -Math.PI] : [travel];
        for (const way of ways)
          for (const k of [0.7, 1.0]) {
            const dir = Math.sign(way);
            const TS = [-Math.sin(phi) * dir, Math.cos(phi) * dir];
            const dense: number[] = [];
            if (Math.abs(way) > 1.9) {
              const mid = phi + way * 0.5;
              const rm = 0.56;
              const W = [Math.cos(mid) * rm, Math.sin(mid) * rm];
              const c1 = dist(S, W), c2 = dist(W, X);
              const TW = scale([-Math.sin(mid) * dir, Math.cos(mid) * dir], (c1 + c2) * 0.5);
              hermite(dense, S, scale(TS, c1 * k), W, TW);
              hermite(dense, W, TW, X, scale(TX, c2 * k));
            } else {
              const c = dist(S, X);
              hermite(dense, S, scale(TS, c * k), X, scale(TX, c * k));
            }
            const g = shape.height(S[0], S[1]);
            // (A spring high on a mountain's flank, not on its summit; anywhere will do elsewhere.)
            const lift = mountain ? smooth01(0.06, 0.18, g) * 0.15 - smooth01(0.26, 0.4, g) * 2 : -Math.max(0, g - 0.12) * 2;
            consider(dense, lift + hash(hex.id * 17 + j * 5 + rs * 11 + k) * 0.02);
          }
      }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0].pts;
}

/**
 * A terrain that lays out its own channel for a river (a swamp's, carried round its clearing)
 * gives the course through that tile: its points, run on out to the edges' midpoints and
 * resampled, so the water follows the channel the ground was shaped for.
 */
function ownChannel(shape: TileShape, enter: number, leave: number): number[] | null {
  const ch = (shape.features as { channel?: { x: number; z: number }[] }).channel;
  if (!ch || ch.length < 2) return null;
  const dense: number[] = [];
  if (enter >= 0) dense.push(...sideNormal(enter).map((v) => v * HEX_APOTHEM));
  for (const p of ch) dense.push(p.x, p.z);
  dense.push(...sideNormal(leave).map((v) => v * HEX_APOTHEM));
  return resample(dense);
}

/**
 * Plan every river on the board and hand each of its tiles the stretch that crosses it (as
 * `ctx.river`). `shapeOf` builds a tile's shape from its context (without the river), for the
 * ground the water runs through. The water's surface is the lowest the ground has been so far
 * downstream, a little under it, so the river never climbs; it falls to the cliff lip in its
 * last tile, and the current runs on from tile to tile unbroken.
 */
export function planRivers(board: Board, plans: { hex: Hex; ctx: TileContext }[], shapeOf: (ctx: TileContext) => TileShape) {
  const byHex = new Map(plans.map((p) => [p.hex.id, p]));
  // The same rivers through the same ground are planned the same: see `planned`.
  const drawn = (board.features.rivers ?? []).filter((r) => r.hexes.every((h) => byHex.has(h)));
  if (!drawn.length) return;
  const key = JSON.stringify(
    drawn.map((r) =>
      r.hexes.map((id) => {
        const { river: _r, pad: _p, ...ctx } = byHex.get(id)!.ctx;
        const shape = shapeOf(ctx);
        return [ctx, KEY_SAMPLES.map(([x, z]) => Math.round(shape.height(x, z) * 1e6))];
      }),
    ),
  );
  if (planned?.key === key) {
    for (const [id, course] of planned.courses) byHex.get(id)!.ctx.river = course;
    return;
  }
  planFresh(board, byHex, shapeOf);
  planned = { key, courses: new Map(drawn.flatMap((r) => r.hexes.map((id) => [id, byHex.get(id)!.ctx.river!] as const))) };
}

/**
 * The last board's plan, kept: finding a hex in the fog rebuilds every tile (the found one's
 * neighbours' coasts change), but no river runs beside a face-down hex, so its tiles' contexts and
 * ground, and so its course, come out exactly as before, and planning it again (tens of
 * milliseconds, in the frame the fog starts parting) would only find the same course. Keyed by
 * every river tile's context and a few heights of its ground (which stand in for the terrain
 * noise the shapes are made with).
 */
let planned: { key: string; courses: Map<number, RiverCourse> } | null = null;
const KEY_SAMPLES = [
  [0, 0],
  [0.41, 0.13],
  [-0.27, 0.36],
  [-0.18, -0.44],
  [0.33, -0.29],
];

function planFresh(board: Board, byHex: Map<number, { hex: Hex; ctx: TileContext }>, shapeOf: (ctx: TileContext) => TileShape) {
  const stretches: { course: RiverCourse; hex: Hex; shape: TileShape }[] = [];
  for (const river of board.features.rivers ?? []) {
    // (A river through a tile the board doesn't draw as land, face-down fog say, isn't drawn.)
    if (!river.hexes.every((h) => byHex.has(h))) continue;
    const parts = river.hexes.map((id, k) => {
      const plan = byHex.get(id)!;
      const hex = plan.hex;
      const enter = k === 0 ? -1 : hex.edges.indexOf(river.bridgeSites[k - 1]);
      const leave = hex.edges.indexOf(river.bridgeSites[k]);
      const shape = shapeOf(plan.ctx);
      const pts = ownChannel(shape, enter, leave) ?? bestCourse(hex, shape, enter, leave);
      // (Where the terrain holds standing water, the river runs in at that water's level.)
      const still = (shape.features as { water?: { level: number } }).water?.level ?? -Infinity;
      const ground: number[] = [];
      for (let i = 0; i < pts.length; i += 2) ground.push(Math.max(shape.height(pts[i], pts[i + 1]), still + SURFACE_DROP));
      return { plan, shape, in: enter, out: leave, pts, ground, level: [] as number[], half: [] as number[], mouth: k === river.hexes.length - 1 };
    });
    // The surface: a running minimum of the ground (less a little), downstream.
    let low = Infinity;
    for (const part of parts) {
      const from = low;
      for (let i = 0; i < part.ground.length; i++) {
        low = Math.min(low, part.ground[i] - SURFACE_DROP);
        part.level.push(low);
      }
      if (part.mouth) {
        const n = part.level.length;
        const l0 = Number.isFinite(from) ? from : part.level[0];
        // (Not while it is still crossing standing water, a swamp's pool on its way to the sea: it
        // runs out of the pool at the pool's level and only then falls, rather than cutting a
        // trench down through the water.)
        let start = 0.35;
        const still = (part.shape.features as { water?: { level: number } }).water?.level;
        if (still !== undefined)
          for (let i = n - 1; i >= 0; i--)
            if (part.ground[i] <= still + SURFACE_DROP + 1e-6) {
              start = Math.min(0.85, Math.max(start, (i + 1) / (n - 1)));
              break;
            }
        for (let i = 0; i < n; i++) part.level[i] = Math.min(part.level[i], l0 + (MOUTH_LEVEL - l0) * smooth01(start, 1, i / (n - 1)));
      }
    }
    // Soften the steps: a few passes of a three-point average over the whole river (a crossing
    // keeps one level on both sides, and a run that only falls still only falls).
    const all: number[] = [];
    parts.forEach((p, k) => all.push(...(k ? p.level.slice(1) : p.level)));
    // No steeper than MAX_FALL anywhere: where the ground drops away sharply (a mountain's foot
    // at the lane), the water upstream comes down to meet it sooner, so the fall is spread along
    // the stream as a run of steps rather than one chute at the edge.
    const MAX_FALL = 0.32;
    for (let i = all.length - 2; i >= 0; i--) all[i] = Math.min(all[i], all[i + 1] + MAX_FALL * STEP);
    for (let pass = 0; pass < 4; pass++) {
      const prev = all.slice();
      for (let i = 1; i + 1 < all.length; i++) all[i] = (prev[i - 1] + prev[i] + prev[i + 1]) / 3;
    }
    // Where it runs steeply (a mountain stream), the surface steps down in pools and short falls
    // rather than sliding down in one sheet: terraced, more the steeper it is.
    const TERRACE = 0.022;
    for (let i = 1; i + 1 < all.length; i++) {
      const slope = (all[i - 1] - all[i + 1]) / (2 * STEP);
      const k = smooth01(0.08, 0.2, slope);
      if (k <= 0) continue;
      const q = all[i] / TERRACE;
      const f = q - Math.floor(q);
      all[i] += ((Math.floor(q) + smooth01(0.72, 1, f)) * TERRACE - all[i]) * k;
    }
    let at = 0;
    let s0 = 0;
    parts.forEach((p, k) => {
      const n = p.level.length;
      if (k) at--;
      for (let i = 0; i < n; i++) p.level[i] = all[at + i];
      at += n;
      // Width: wider and narrower along the way but exactly RIVER_HALF at a crossing; at a
      // spring, a round pool narrowing to a brook that grows; spreading out at the mouth.
      const len = (n - 1) * STEP;
      for (let i = 0; i < n; i++) {
        const s = i * STEP;
        const ends = smooth01(0, 0.2, Math.min(s, len - s));
        let half = RIVER_HALF * (1 + 0.14 * Math.sin((s0 + s) * 8.3 + river.hexes[0]) * ends);
        if (p.in < 0) half *= 0.5 + 0.5 * smooth01(0.1, 0.5, s) + 0.45 * (1 - smooth01(0, 0.1, s));
        if (p.mouth) half += (MOUTH_HALF - half) * smooth01(len - 0.35, len, s);
        p.half.push(half);
      }
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.pts.length; i += 2) {
        box[0] = Math.min(box[0], p.pts[i] - REACH);
        box[1] = Math.min(box[1], p.pts[i + 1] - REACH);
        box[2] = Math.max(box[2], p.pts[i] + REACH);
        box[3] = Math.max(box[3], p.pts[i + 1] + REACH);
      }
      const still = (p.shape.features as { water?: { level: number } }).water?.level;
      p.plan.ctx.river = { pts: p.pts, level: p.level, half: p.half, box, in: p.in, out: p.out, mouth: p.mouth, s0, ...(still !== undefined && { still }) };
      s0 += len;
      stretches.push({ course: p.plan.ctx.river, hex: p.plan.hex, shape: p.shape });
    });
  }
  placeMill(stretches);
}

/**
 * One watermill for the board, on the stretch of a plains tile with the most room: by a straight
 * run of the river, on low bank, well clear of the corners, the edges, the disc and the tile's
 * own landmark.
 */
function placeMill(stretches: { course: RiverCourse; hex: Hex; shape: TileShape }[]) {
  let best: { st: (typeof stretches)[number]; site: MillSite; score: number } | null = null;
  const R = 0.105;
  for (const st of stretches) {
    const { course: c, hex, shape } = st;
    if (c.in < 0 || c.mouth || !['forest', 'fields', 'pasture'].includes(shape.terrain)) continue;
    const p = c.pts;
    const n = p.length / 2;
    const discR = hex.numbers.length > 1 ? 0.46 : 0.33;
    const a = shape.features.anchor;
    for (let i = 6; i < n - 6; i++) {
      const tx = p[i * 2 + 2] - p[i * 2 - 2], tz = p[i * 2 + 3] - p[i * 2 - 1];
      const tl = Math.hypot(tx, tz);
      const a1 = Math.atan2(p[i * 2 + 1] - p[i * 2 - 11], p[i * 2] - p[i * 2 - 12]);
      const a2 = Math.atan2(p[i * 2 + 13] - p[i * 2 + 1], p[i * 2 + 12] - p[i * 2]);
      const bend = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      for (const side of [1, -1]) {
        const off = c.half[i] + R * 0.95;
        const x = p[i * 2] - (tz / tl) * off * side, z = p[i * 2 + 1] + (tx / tl) * off * side;
        let clear = Infinity;
        for (const [cx, cz] of CORNER_OFFSETS) clear = Math.min(clear, Math.hypot(x - cx, z - cz) - 0.32 - R);
        for (let k = 0; k < 6; k++) {
          const [nx, nz] = sideNormal(k);
          clear = Math.min(clear, HEX_APOTHEM - (x * nx + z * nz) - 0.2 - R);
        }
        clear = Math.min(clear, Math.hypot(x, z) - discR - R);
        if (a) clear = Math.min(clear, Math.hypot(x - a.x, z - a.z) - 0.2 - R);
        if (clear < 0) continue;
        const bank = shape.height(x, z) - c.level[i];
        if (bank > 0.07) continue;
        // (The house beyond the river from the usual view, its wheel in front of it, reads best.)
        const score = Math.min(clear, 0.06) * 10 - bend * 0.6 - bank * 3 + (z < p[i * 2 + 1] ? 0.05 : 0);
        if (!best || score > best.score) best = { st, score, site: { x, z, r: R, y: c.level[i] + 0.014, angle: Math.atan2(tz, tx), side, i } };
      }
    }
  }
  if (best) best.st.course.mill = best.site;
}

/** The centreline's point spacing (for code that walks a course point by point). */
export const RIVER_STEP = STEP;
