// Where a piece can stand on the island: dry ground, clear of what the terrain keeps free. The
// expansions' figures (marks.ts) ask this of the board through their context; a test can ask it
// of the tile shapes alone, planned here the way TileSet.create plans them (without the geometry).

import type { Board, Hex } from '../../engine';
import { SIDE_DIRS } from '../../engine/board';
import type { Noise } from '../util/noise';
import { createTileShape, type TileContext, type TileShape } from './terrain';
import { landHexes, lookOf } from './looks';
import { planRivers, riverClear } from './riverCourse';
import { planWells } from './wellSite';

export interface Standing {
  hex: Hex;
  shape: TileShape;
}

/** The tile under (x, z): the nearest land hex's (null with no land built). */
export function tileAt(tiles: readonly Standing[], x: number, z: number): Standing | null {
  let best: Standing | null = null, bd = Infinity;
  for (const t of tiles) {
    const d = (t.hex.x - x) ** 2 + (t.hex.z - z) ** 2;
    if (d < bd) [best, bd] = [t, d];
  }
  return best;
}

/**
 * Whether a piece of radius `r` at (x, z) would stand in water: a river's channel (or its wet
 * bank, or a mill's patch), or standing water (the lake, a swamp's pools, a pond), sampled at
 * its middle and round its edge.
 */
export function wetAt(tiles: readonly Standing[], x: number, z: number, r: number): boolean {
  const t = tileAt(tiles, x, z);
  if (!t) return false;
  const lx = x - t.hex.x, lz = z - t.hex.z;
  // (The river's own word, not canPlace's, which folds in the lanes an edge's warden may stand on.)
  const river = t.shape.ctx.river;
  if (river && !riverClear(river, lx, lz, r)) return true;
  const w = t.shape.features.water;
  if (!w) return false;
  // (Its middle at the waterline is wet; its edge may touch the shallows, as a camp's does.)
  if (w.depth(lx, lz) > -0.001) return true;
  for (const [dx, dz] of [[r * 0.6, 0], [-r * 0.6, 0], [0, r * 0.6], [0, -r * 0.6]]) if (w.depth(lx + dx, lz + dz) > 0.004) return true;
  return false;
}

/**
 * Whether the terrain keeps the spot for something else: the hex's clearing and its discs, the
 * lanes along its roads, its corners (where buildings stand), an oil well's pad, its landmark.
 */
export function busyAt(tiles: readonly Standing[], x: number, z: number, r: number): boolean {
  const t = tileAt(tiles, x, z);
  if (!t) return false;
  const lx = x - t.hex.x, lz = z - t.hex.z;
  if (!t.shape.canPlace(lx, lz, r)) return true;
  // (The landmark the terrain was shaped round, a mine, a kiln or a windmill, and a clay pit.)
  const f = t.shape.features;
  if (f.anchor && Math.hypot(lx - f.anchor.x, lz - f.anchor.z) < 0.24 + r) return true;
  if (f.pit && Math.hypot(lx - f.pit.x, lz - f.pit.z) < f.pit.r + r) return true;
  return f.peaks.some((p) => Math.hypot(lx - p.x, lz - p.z) < p.r * 0.7 + r);
}

/**
 * The land's tile shapes, planned as TileSet.create plans them (its contexts, rivers and wells),
 * for asking about the ground without building it.
 */
export function planShapes(board: Board, noise: Noise, seed: number): Standing[] {
  const land = landHexes(board);
  const coordIndex = new Map(land.map((h) => [`${h.q},${h.r}`, h]));
  const rivers = new Map<number, { in: number; out: number }>();
  for (const r of board.features.rivers ?? [])
    r.hexes.forEach((id, i) => {
      const edges = board.hexes[id].edges;
      rivers.set(id, { in: i > 0 ? edges.indexOf(r.bridgeSites[i - 1]) : -1, out: edges.indexOf(r.bridgeSites[i]) });
    });
  const plans = land.map((hex) => {
    const look = lookOf(hex.terrain)!;
    const connected: boolean[] = [];
    const landSide: boolean[] = [];
    for (const [dq, dr] of SIDE_DIRS) {
      const n = coordIndex.get(`${hex.q + dq},${hex.r + dr}`);
      landSide.push(!!n);
      connected.push(!!n && lookOf(n.terrain) === look);
    }
    const ctx: TileContext = { terrain: look, cx: hex.x, cz: hex.z, seed: seed * 131 + hex.id * 977 + 1, connected, landSide };
    const sides = rivers.get(hex.id);
    if (sides) ctx.riverSides = sides;
    return { hex, ctx };
  });
  planRivers(board, plans, (ctx) => createTileShape(ctx, noise));
  planWells(plans, (ctx) => createTileShape(ctx, noise));
  return plans.map(({ hex, ctx }) => ({ hex, shape: createTileShape(ctx, noise) }));
}
