// Headlands: when a settlement is built on a coastal corner, a lobe of land rises from the
// sea beneath it so the building stands on solid ground rather than overhanging the cliff.
// The cap and the cliff use the island's own terrain and cliff materials (with the tile id
// of the neighbouring hex), so it inherits the turf, strata, stones and surf of the coast.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Terrain } from '../../engine';
import { Noise } from '../util/noise';

const TOP_COLOR: Record<Terrain, string> = {
  forest: '#4f7d2c',
  pasture: '#76aa36',
  fields: '#8fae45',
  hills: '#a8613a',
  mountains: '#8e8c88',
  desert: '#dcc189',
  // (The expansions' looks as their tiles' rims are coloured: see terrain.ts.)
  bounty: '#d3ba82',
  swamp: '#7c8f5d',
  lake: '#6fa259',
  oasis: '#dcc189',
  castle: '#7c885d',
  sea: '#2f6f8f',
};

export interface HeadlandSpec {
  /** Outward direction (unit, xz) from the land towards the sea. */
  dirX: number;
  dirZ: number;
  radius: number;
  /** Ground height at the corner; the cap sits just under it so the tile wins on land. */
  topY: number;
  tile: number;
  terrain: Terrain;
  seed: number;
}

const LEVELS = [0, -0.025, -0.07, -0.15, -0.27, -0.44, -0.68, -1.05];

/**
 * Attributes the terrain and cliff shaders expect: exactly the set the island's own tops and
 * walls carry, so a headland draws with the shaders already built for them instead of new ones
 * compiled as it rises. The cliff's also says it faces open sea (`cove` 0: breakers wet it).
 */
function shaderAttributes(g: THREE.BufferGeometry, tile: number, rocky: number, meadow: number, cliff = false) {
  const n = g.getAttribute('position').count;
  g.setAttribute('tile', new THREE.Float32BufferAttribute(new Float32Array(n).fill(tile), 1));
  g.setAttribute('rocky', new THREE.Float32BufferAttribute(new Float32Array(n).fill(rocky), 1));
  g.setAttribute('meadow', new THREE.Float32BufferAttribute(new Float32Array(n).fill(meadow), 1));
  g.setAttribute('ore', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  if (cliff) g.setAttribute('cove', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  g.computeBoundingSphere();
}

/** The cap's outline: its centre (pushed seaward of the corner) and its edge at each angle round it. */
function outline(spec: HeadlandSpec, noise: Noise) {
  const { dirX, dirZ, radius: R } = spec;
  // Centre pushed seaward so the lobe juts out from the corner.
  const ox = dirX * R * 0.35, oz = dirZ * R * 0.35;
  const edge = (a: number) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    // Longer towards the sea, irregular all round.
    const along = ca * dirX + sa * dirZ;
    const r = R * (1 + 0.3 * Math.max(0, along)) * (1 + 0.16 * noise.noise2(ca * 1.6 + 3, sa * 1.6) + 0.07 * Math.sin(a * 5 + spec.seed) + 0.04 * Math.sin(a * 11 + spec.seed * 2));
    return [ox + ca * r, oz + sa * r] as const;
  };
  return { ox, oz, edge };
}

/**
 * How far from its corner the headland's cap reaches heading (dx, dz) (a unit direction): where
 * something leaving the corner that way (a harbour's stairs) comes off the land.
 */
export function headlandReach(spec: HeadlandSpec, dx: number, dz: number): number {
  const { ox, oz, edge } = outline(spec, new Noise(spec.seed));
  for (let t = 0; t < 1.5; t += 0.004) {
    const x = dx * t - ox, z = dz * t - oz;
    const [ex, ez] = edge(Math.atan2(z, x));
    if (Math.hypot(x, z) > Math.hypot(ex - ox, ez - oz)) return t;
  }
  return 1.5;
}

/** Geometry is local to the corner (the mesh is positioned at the vertex). */
export function makeHeadland(spec: HeadlandSpec): { top: THREE.BufferGeometry; wall: THREE.BufferGeometry } {
  const noise = new Noise(spec.seed);
  const SEG = 40, RINGS = 6;
  const { ox, oz, edge } = outline(spec, noise);

  // ---- cap
  const tp: number[] = [], tc: number[] = [], ti: number[] = [];
  const base = new THREE.Color(TOP_COLOR[spec.terrain]);
  const soil = new THREE.Color('#5a4330');
  const c = new THREE.Color();
  tp.push(ox, spec.topY - 0.004, oz);
  tc.push(base.r, base.g, base.b);
  for (let k = 1; k <= RINGS; k++) {
    const f = k / RINGS;
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const [ex, ez] = edge(a);
      const x = ox + (ex - ox) * f, z = oz + (ez - oz) * f;
      // A rounded turf shoulder rather than a sharp table edge.
      const droop = Math.pow(Math.max(0, (f - 0.55) / 0.45), 2.2) * 0.032;
      tp.push(x, spec.topY - 0.004 - droop + noise.noise2(x * 9, z * 9) * 0.003, z);
      c.copy(base).offsetHSL(0, 0, noise.noise2(x * 6 + 1, z * 6) * 0.05).lerp(soil, Math.max(0, f - 0.85) * 3);
      tc.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < SEG; j++) ti.push(0, 1 + ((j + 1) % SEG), 1 + j);
  for (let k = 1; k < RINGS; k++)
    for (let j = 0; j < SEG; j++) {
      const a = 1 + (k - 1) * SEG + j, b2 = 1 + (k - 1) * SEG + ((j + 1) % SEG);
      ti.push(a, b2, a + SEG, b2, b2 + SEG, a + SEG);
    }
  const top = new THREE.BufferGeometry();
  top.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
  top.setAttribute('color', new THREE.Float32BufferAttribute(tc, 3));
  top.setIndex(ti);
  top.computeVertexNormals();

  // ---- cliff
  const wp: number[] = [], wc: number[] = [], wi: number[] = [];
  const rimStart = 1 + (RINGS - 1) * SEG;
  const strata = [new THREE.Color('#6e4c33'), new THREE.Color('#4a3424'), new THREE.Color('#8a6c4e')];
  const rock = new THREE.Color('#6f6a66'), rockDark = new THREE.Color('#2f2824'), algae = new THREE.Color('#3c5240');
  LEVELS.forEach((dy, li) => {
    for (let j = 0; j < SEG; j++) {
      const x0 = tp[(rimStart + j) * 3], y0 = tp[(rimStart + j) * 3 + 1], z0 = tp[(rimStart + j) * 3 + 2];
      const depth = -dy;
      const dx = x0 - ox, dz = z0 - oz;
      // Ledges and bulges near the top, then a talus slope spreading out to the sea floor.
      const ledge = Math.round(noise.noise3(x0 * 6, li * 0.7, z0 * 6) * 3) / 3;
      const bulge = 1 + Math.min(1, depth * 3) * (0.1 * noise.noise2(x0 * 7 + li, z0 * 7) + 0.05 * ledge) + 0.32 * Math.pow(depth, 1.3);
      const y = y0 + dy;
      wp.push(ox + dx * bulge, y, oz + dz * bulge);
      if (li <= 1) c.copy(soil).lerp(base, li === 0 ? 0.5 : 0);
      else if (y > -0.45) c.copy(strata[(li + j) % 3]);
      else c.copy(rock).lerp(rockDark, 0.5 + noise.noise2(x0 * 5, li) * 0.5).lerp(algae, y < -0.52 ? 0.35 : 0);
      wc.push(c.r, c.g, c.b);
    }
  });
  for (let li = 0; li < LEVELS.length - 1; li++)
    for (let j = 0; j < SEG; j++) {
      const a = li * SEG + j, b2 = li * SEG + ((j + 1) % SEG);
      wi.push(a, b2, a + SEG, b2, b2 + SEG, a + SEG);
    }
  const wall = new THREE.BufferGeometry();
  wall.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
  wall.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3));
  wall.setIndex(wi);
  wall.computeVertexNormals();

  const green = spec.terrain === 'pasture' || spec.terrain === 'forest' || spec.terrain === 'fields' || spec.terrain === 'lake' || spec.terrain === 'swamp' || spec.terrain === 'castle';
  shaderAttributes(top, spec.tile, spec.terrain === 'mountains' ? 0.3 : 0, green ? 0.45 : 0.05);
  shaderAttributes(wall, spec.tile, 1, 0, true);
  return { top, wall };
}

/** A few dark boulders around the waterline of a headland (local coordinates). */
export function makeHeadlandRocks(spec: HeadlandSpec): THREE.BufferGeometry {
  const noise = new Noise(spec.seed + 1);
  const parts: THREE.BufferGeometry[] = [];
  const n = 5 + (spec.seed % 3);
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(spec.dirZ, spec.dirX) + (i / (n - 1) - 0.5) * 2.6;
    const r = spec.radius * (1.25 + 0.25 * Math.abs(noise.noise2(i * 3.1, 2)));
    const s = 0.045 + 0.04 * (noise.noise2(i * 1.7, 5) * 0.5 + 0.5);
    const g = new THREE.IcosahedronGeometry(s, 1);
    g.deleteAttribute('uv');
    const p = g.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const d = 1 + noise.noise3(x * 30 + i, y * 30, z * 30) * 0.25;
      p.setXYZ(k, x * d, y * d * 0.7, z * d);
    }
    g.translate(Math.cos(a) * r + spec.dirX * spec.radius * 0.35, -0.4 + s * 0.15, Math.sin(a) * r + spec.dirZ * spec.radius * 0.35);
    const col = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) col.set([0.25, 0.22, 0.2], k * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  }
  const out = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  // Indexed like the island's walls (one index per vertex, so still faceted), which lets the
  // rocks share the walls' shaders too.
  out.setIndex(Array.from({ length: out.getAttribute('position').count }, (_, i) => i));
  out.computeVertexNormals();
  shaderAttributes(out, spec.tile, 1, 0, true);
  return out;
}
