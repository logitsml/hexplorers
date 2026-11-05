// Builds the island's terrain tiles (merged into two draw calls) and exposes the
// per-tile shapes used by decoration modules.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Board, Hex } from '../../engine';
import { SIDE_DIRS } from '../../engine/board';
import { Noise } from '../util/noise';
import { buildTileGeometry, createTileShape, type TileContext, type TileGeometry, type TileShape } from './terrain';
import { unpack, type TerrainJob, type TerrainResult } from './terrainPack';
import type { TerrainPool } from './terrainPool';
import { MAX_TILES, cliffMaterial, terrainMaterial, type TileEffects } from './materials';
import { release } from './release';
import { landHexes, lookOf } from './looks';
import { planRivers } from './riverCourse';
import { planWells } from './wellSite';

export interface TileInfo {
  hex: Hex;
  shape: TileShape;
}

/**
 * How finely a tile's ground is built: rings of vertices from its middle to its edge (twice as many
 * on a mountain). Set from the quality preset (see QualitySettings.terrainRings).
 */
let detail = 36;

export function setTerrainRings(rings: number) {
  detail = rings;
}

export const terrainRings = () => detail;

export class TileSet {
  group = new THREE.Group();
  tiles: TileInfo[] = [];
  top: THREE.Mesh;
  walls: THREE.Mesh;
  /** Earth on the land-facing sides, shown only while the island rises (see TileGeometry.inner). */
  inner: THREE.Mesh;
  /**
   * Tiles still coming up out of the sea on their own (a hex found in the fog: see fog.ts). The
   * coast's surf waits for the whole island while it rises at the start, but not for one of these.
   */
  pending = new Set<number>();

  /**
   * The island's tiles. Their terrain is built on `pool` in parallel when there is one (exactly
   * the geometry this thread would build), otherwise here; or taken from what prepare started
   * for the same board.
   */
  static async create(board: Board, effects: TileEffects, noise: Noise, seed: number, pool: TerrainPool | null, rings = detail) {
    const { plans, jobs, key } = planTiles(board, noise, seed, rings);
    let results: Promise<Built[]>;
    if (pool && ahead?.key === key) results = ahead.results;
    else results = pool ? runJobs(pool, jobs) : Promise.resolve(jobs.map(() => null));
    ahead = null;
    const built = await results;
    // A newer board was asked for meanwhile: this one is thrown away unbuilt.
    if (built.some((b) => b === STALE)) return new TileSet(effects, noise, [], []);
    const geos = built.map((b, i): TileGeometry => (b && b !== STALE ? { top: unpack(b.top), walls: unpack(b.walls), inner: unpack(b.inner) } : buildTileGeometry(createTileShape(plans[i].ctx, noise), noise, plans[i].rings)));
    return new TileSet(effects, noise, plans, geos);
  }

  /**
   * Start building a board's terrain on the workers before it is asked for (a game about to start:
   * see World.prepareIsland). create takes what was built if it is asked for the same board, seed
   * and noise (and builds afresh otherwise); a newer prepare, or create for another board, drops it.
   */
  static prepare(board: Board, noise: Noise, seed: number, pool: TerrainPool, rings = detail) {
    const { jobs, key } = planTiles(board, noise, seed, rings);
    if (ahead?.key === key) return;
    ahead = { key, results: runJobs(pool, jobs) };
    // (Unused, it fails quietly: create builds for itself.)
    ahead.results.catch(() => {});
  }

  private constructor(effects: TileEffects, noise: Noise, plans: { hex: Hex; ctx: TileContext }[], geos: TileGeometry[]) {
    if (!plans.length) {
      // (An empty set, for a board replaced before it was built: see create.)
      this.top = new THREE.Mesh();
      this.walls = new THREE.Mesh();
      this.inner = new THREE.Mesh();
      return;
    }
    const tops: THREE.BufferGeometry[] = [];
    const walls: THREE.BufferGeometry[] = [];
    const inners: THREE.BufferGeometry[] = [];
    plans.forEach(({ hex, ctx }, i) => {
      // The shape (heights, masks, placement) stays here for the decoration modules.
      const shape = createTileShape(ctx, noise);
      this.tiles.push({ hex, shape });
      const geo = geos[i];
      for (const w of [geo.walls, geo.inner]) {
        const wc = w.getAttribute('position').count;
        if (!w.getAttribute('rocky')) w.setAttribute('rocky', new THREE.Float32BufferAttribute(new Float32Array(wc).fill(1), 1));
        if (!w.getAttribute('meadow')) w.setAttribute('meadow', new THREE.Float32BufferAttribute(new Float32Array(wc), 1));
        if (!w.getAttribute('ore')) w.setAttribute('ore', new THREE.Float32BufferAttribute(new Float32Array(wc), 1));
      }
      for (const g of [geo.top, geo.walls, geo.inner]) {
        g.translate(hex.x, 0, hex.z);
        const n = g.getAttribute('position').count;
        g.setAttribute('tile', new THREE.Float32BufferAttribute(new Float32Array(n).fill(hex.id), 1));
      }
      tops.push(geo.top);
      walls.push(geo.walls);
      inners.push(geo.inner);
    });
    const topGeo = mergeGeometries(tops)!;
    const wallGeo = mergeGeometries(walls)!;
    const innerGeo = mergeGeometries(inners)!;
    tops.forEach((g) => g.dispose());
    walls.forEach((g) => g.dispose());
    inners.forEach((g) => g.dispose());
    innerGeo.computeBoundingSphere();
    topGeo.computeBoundingSphere();
    wallGeo.computeBoundingSphere();

    this.top = new THREE.Mesh(topGeo, terrainMaterial(effects));
    this.top.receiveShadow = true;
    this.top.castShadow = true;
    this.walls = new THREE.Mesh(wallGeo, cliffMaterial(effects));
    this.walls.receiveShadow = true;
    this.walls.castShadow = true;
    this.inner = new THREE.Mesh(innerGeo, this.walls.material);
    this.inner.receiveShadow = true;
    this.inner.visible = false;
    this.group.add(this.top, this.walls, this.inner);
  }

  heightAt(hexId: number, wx: number, wz: number): number {
    // (A tile's index is its hex's id, except on a board where some land shows as sea: face-down fog.)
    const t = this.tiles[hexId]?.hex.id === hexId ? this.tiles[hexId] : this.tiles.find((x) => x.hex.id === hexId)!;
    return t.shape.height(wx - t.hex.x, wz - t.hex.z);
  }

  dispose() {
    release(this.group);
    for (const m of [this.top, this.walls]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.inner.geometry.dispose();
  }
}

/** A tile's terrain from the workers, null to build here (no worker could), or STALE (a newer board took the workers). */
type Built = TerrainResult | null | typeof STALE;
const STALE = Symbol('stale');

/** Terrain started ahead of its board (see TileSet.prepare): what it was planned from, and the workers' results. */
let ahead: { key: string; results: Promise<Built[]> } | null = null;

/** Each land hex's tile as the workers build it, and a key for the lot (every input to the build). */
function planTiles(board: Board, noise: Noise, seed: number, rings: number) {
  // Only the land is built, each hex drawn as its look (see looks.ts); a coast faces the sea hexes too.
  const land = landHexes(board);
  const top = Math.max(...land.map((h) => h.id)) + 1;
  if (top > MAX_TILES) throw new Error(`A board whose land runs to hex ${top - 1} is more than the ${MAX_TILES} tiles the shaders hold.`);
  const coordIndex = new Map(land.map((h) => [`${h.q},${h.r}`, h]));
  // Where a river runs through a hex: the sides it crosses in and out by (its bridge sites), for
  // a terrain that shapes its ground round the river before it is planned (the swamp at a mouth).
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
    const ctx: TileContext = { terrain: look, cx: hex.x, cz: hex.z, seed: seed * 131 + hex.id * 977 + 1, connected, landSide, discs: hex.numbers.length };
    const sides = rivers.get(hex.id);
    if (sides) ctx.riverSides = sides;
    return { hex, ctx, rings: look === 'mountains' ? Math.round(rings * 2) : rings };
  });
  // Each river tile's stretch of river, in its context, so the workers cut the same channel.
  planRivers(board, plans, (ctx) => createTileShape(ctx, noise));
  planWells(plans, (ctx) => createTileShape(ctx, noise));
  const jobs: TerrainJob[] = plans.map(({ ctx, rings: r }, id) => ({ id, ctx, noiseSeed: noise.seed, rings: r }));
  return { plans, jobs, key: JSON.stringify(jobs) };
}

/** The jobs on the workers, as a new set (any set still queued is dropped). */
function runJobs(pool: TerrainPool, jobs: TerrainJob[]): Promise<Built[]> {
  const batch = pool.begin();
  return Promise.all(
    jobs.map((job) =>
      pool.run(job, batch).then(
        (r) => r ?? STALE,
        // (Built here instead, unless a newer board has replaced this one.)
        () => (pool.current(batch) ? null : STALE),
      ),
    ),
  );
}
