// World-space conventions for the 3D board. Engine coordinates (x, z) map 1:1 to
// world x/z; hex circumradius = 1. +y is up.

import { isLand, type Board } from '../../engine';
import { SQRT3 } from '../../engine/board';

export const SEA_LEVEL = -0.4;

/** Where a fishing ground's disc rides: on its float, clear of the swell (see grounds.ts). */
export const GROUND_DISC_Y = SEA_LEVEL + 0.062;
export const CLIFF_BOTTOM = -1.6;
/** Visual tile scale (leaves a slim seam between tiles). */
export const TILE_SCALE = 0.985;
/** Width of the flat rim kept clear for roads and buildings. */
export const RIM = 0.2;
/** Radius of the flat clearing at the tile centre for the number disc. */
export const TOKEN_CLEAR = 0.3;
export const TOKEN_Y = 0.05;

export const HEX_APOTHEM = SQRT3 / 2;

/**
 * Render layer for small detail (grass, flowers, particles, rain, ripples): drawn by the main
 * camera but skipped by the water's mirror camera, where it would cost a lot and show little.
 */
export const DETAIL_LAYER = 1;

/** Distance from point p to segment ab in the xz plane. */
export function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Signed distance to a pointy-top hexagon of circumradius r centred at origin (negative inside). */
export function hexSdf(x: number, z: number, r = 1): number {
  // Rotate so we can use the flat-top formula: pointy-top = flat-top rotated 30°.
  const kx = -0.866025404, ky = 0.5, kz = 0.577350269;
  let px = Math.abs(z);
  let py = Math.abs(x);
  const d = 2 * Math.min(kx * px + ky * py, 0);
  px -= d * kx;
  py -= d * ky;
  const ra = r * HEX_APOTHEM;
  const cx = Math.min(Math.max(px, -kz * ra), kz * ra);
  const lx = px - cx;
  const ly = py - ra;
  return Math.hypot(lx, ly) * Math.sign(ly);
}

export interface SdfField {
  size: number;
  extent: number;
  data: Float32Array;
  sample(x: number, z: number): number;
}

/**
 * Half-width of the square the island's SDF covers, about the origin: 14, or more for a board
 * reaching further (a sea map's islets and fog), so its farthest hex keeps a few
 * units of open sea inside the grid, past which the sea's shading has settled. From every hex,
 * the sea's and the face-down ones too, so a board keeps one grid as its hexes are found.
 */
export function sdfExtent(board: Board): number {
  let r = 0;
  for (const h of board.hexes) r = Math.max(r, Math.abs(h.x), Math.abs(h.z));
  return Math.max(14, Math.ceil(r + 4));
}

/**
 * Rasterises the island SDF on a square grid covering [-extent, extent]². Distances are
 * measured to the coastline only (the sea-facing edges), so the seams between land hexes
 * are deep inside the island rather than reading as shoreline (which put foam on them while
 * the tiles rise through the water).
 */
export function buildSdfField(board: Board, size = 384, extent = sdfExtent(board)): SdfField {
  const data = new Float32Array(size * size);
  // Coastline segments as (ax, az, dx, dz, 1/|d|²), flat for a tight inner loop.
  const coastEdges = board.edges.filter((e) => e.coastal);
  const seg = new Float64Array(coastEdges.length * 5);
  coastEdges.forEach((e, k) => {
    const a = board.vertices[e.a], b = board.vertices[e.b];
    const dx = b.x - a.x, dz = b.z - a.z;
    seg.set([a.x, a.z, dx, dz, 1 / (dx * dx + dz * dz)], k * 5);
  });
  // (Inside means inside the land: a map's sea hexes are open water.)
  const hexes = board.hexes.filter((h) => isLand(h.terrain));
  for (let j = 0; j < size; j++) {
    const z = ((j + 0.5) / size) * 2 * extent - extent;
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size) * 2 * extent - extent;
      // Inside the island: within some land hex (only hexes whose circumcircle holds the point can).
      let inside = false;
      for (let h = 0; h < hexes.length && !inside; h++) {
        const hx = x - hexes[h].x, hz = z - hexes[h].z;
        inside = hx * hx + hz * hz < 1 && hexSdf(hx, hz, 1) < 0;
      }
      let d2 = Infinity;
      for (let k = 0; k < seg.length; k += 5) {
        const px = x - seg[k], pz = z - seg[k + 1];
        const t = Math.max(0, Math.min(1, (px * seg[k + 2] + pz * seg[k + 3]) * seg[k + 4]));
        const ex = px - seg[k + 2] * t, ez = pz - seg[k + 3] * t;
        const v = ex * ex + ez * ez;
        if (v < d2) d2 = v;
      }
      const d = Math.sqrt(d2);
      data[j * size + i] = inside ? -d : d;
    }
  }
  return {
    size,
    extent,
    data,
    sample(x: number, z: number) {
      const fx = ((x + extent) / (2 * extent)) * size - 0.5;
      const fz = ((z + extent) / (2 * extent)) * size - 0.5;
      const i0 = Math.max(0, Math.min(size - 2, Math.floor(fx)));
      const j0 = Math.max(0, Math.min(size - 2, Math.floor(fz)));
      const tx = Math.min(1, Math.max(0, fx - i0));
      const tz = Math.min(1, Math.max(0, fz - j0));
      const a = data[j0 * size + i0];
      const b = data[j0 * size + i0 + 1];
      const c = data[(j0 + 1) * size + i0];
      const d = data[(j0 + 1) * size + i0 + 1];
      return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    },
  };
}

/** The expansions' pieces on the board (ships, bridges, wagons...) are drawn at this many times their models' size (see marks.ts). */
export const MARKS_SCALE = 1.85;

/** A bridge's measures, in its model's units (see works.ts makeBridge). */
export const BRIDGE = { L: 0.56, W: 0.056, span: 0.09, spring: -0.034, foot: -0.085, hump: 0.35 };

/** A bridge deck's height along it (model units from its middle): level with a road at the ends, humped over the arch. */
export const deckY = (x: number) => 0.015 + 0.02 * Math.pow(Math.max(0, 1 - Math.pow((2 * x) / BRIDGE.hump, 2)), 1.6);

/** Midpoint and orientation of an edge, for placing roads and port docks. */
export function edgeFrame(board: Board, edgeId: number) {
  const e = board.edges[edgeId];
  const a = board.vertices[e.a];
  const b = board.vertices[e.b];
  const x = (a.x + b.x) / 2;
  const z = (a.z + b.z) / 2;
  const angle = Math.atan2(b.z - a.z, b.x - a.x);
  return { x, z, angle, ax: a.x, az: a.z, bx: b.x, bz: b.z };
}

/** How far a road along the coast is drawn in from the edge, so its outer kerb stays on the land. */
const COAST_INSET = 0.07;

/**
 * Where a road on an edge lies: the edge itself, or, along the coast, moved in toward the land
 * by COAST_INSET (a full-width road on the edge line would overhang the cliff).
 */
export function roadFrame(board: Board, edgeId: number) {
  const f = edgeFrame(board, edgeId);
  const e = board.edges[edgeId];
  if (!e.coastal) return f;
  const h = board.hexes[e.hexes.find((x) => isLand(board.hexes[x].terrain))!];
  const dx = h.x - f.x, dz = h.z - f.z;
  const d = Math.hypot(dx, dz) || 1;
  const ox = (dx / d) * COAST_INSET, oz = (dz / d) * COAST_INSET;
  return { ...f, x: f.x + ox, z: f.z + oz, ax: f.ax + ox, az: f.az + oz, bx: f.bx + ox, bz: f.bz + oz };
}
