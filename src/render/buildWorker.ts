// Builds geometry off the main thread, with the same code and the same noise as the main thread,
// so the result is identical: one tile's terrain (see board/terrainPool.ts), or the scenery beyond
// the island with the sea's ripple normals (see env/sceneryJob.ts). One script for both, so the
// terrain's workers find it already fetched.

import { Noise } from './util/noise';
import { buildTileGeometry, createTileShape } from './board/terrain';
import { pack, type PackedGeometry, type TerrainJob, type TerrainResult } from './board/terrainPack';
import { planScenery, type SceneryPlan } from './env/distantShapes';
import { detailNormals } from './env/oceanDetail';

/** What the scenery job sends back. */
export interface SceneryResult {
  plan: SceneryPlan<PackedGeometry>;
  detail: Uint8Array;
}

/** The message that asks for the scenery (a tile's is its TerrainJob). */
export interface SceneryJob {
  scenery: true;
}

let noise: Noise | null = null;

function scenery() {
  const transfer: Transferable[] = [];
  const plan = planScenery();
  const detail = detailNormals();
  transfer.push(detail.buffer);
  const result: SceneryResult = { plan: { ships: plan.ships, pieces: plan.pieces.map((p) => ({ ...p, geometry: pack(p.geometry, transfer) })) }, detail };
  (self as unknown as Worker).postMessage(result, transfer);
}

self.onmessage = (e: MessageEvent<TerrainJob | SceneryJob>) => {
  if ('scenery' in e.data) return scenery();
  const { id, ctx, noiseSeed, rings } = e.data;
  if (!noise || noise.seed !== noiseSeed) noise = new Noise(noiseSeed);
  const geo = buildTileGeometry(createTileShape(ctx, noise), noise, rings);
  if (e.data.warm) return (self as unknown as Worker).postMessage({ id });
  const transfer: Transferable[] = [];
  const result: TerrainResult = { id, top: pack(geo.top, transfer), walls: pack(geo.walls, transfer), inner: pack(geo.inner, transfer) };
  (self as unknown as Worker).postMessage(result, transfer);
};
