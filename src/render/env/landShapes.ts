// The shapes of distant land: islets, sea stacks and far islands built as landforms rather than
// blobs. A polar grid gives each one a ragged coastline, a top surface (dome, hills, an optional
// summit) and sheer cliffs with undercuts and ledges, split at a crisp turf edge; and the trees
// on them. Geometry only, so it builds off the main thread too (see render/buildWorker.ts); the
// material that paints them is in landmass.ts.

import * as THREE from 'three/webgpu';
import { Noise, Rand } from '../util/noise';
import { MeshBuilder, compose, smoothSphere } from '../board/geom';

export interface LandShape {
  /** Mean radius of the coastline. */
  radius: number;
  /** Height of the cliff top above the object's origin. */
  rim: number;
  /** How much the top rises toward the middle. */
  dome: number;
  /** Relief of the rolling hills on top. */
  hills: number;
  /** Height of a summit (0 for none). */
  peak: number;
  /** Depth the cliffs reach down to (below the origin). */
  bottom: number;
  /** How far the cliff faces bulge and undercut (fraction of the radius). */
  undercut: number;
  /** Grid resolution: around, across the top, down the cliffs. */
  seg: number;
  top: number;
  cliff: number;
}

const C = (h: string) => new THREE.Color(h);

/** Builds the landform; also returns spots on the top surface (local) for trees. */
export function makeLandmass(seed: number, noise: Noise, o: LandShape): { geometry: THREE.BufferGeometry; spots: THREE.Vector3[] } {
  const pos: number[] = [];
  const depth: number[] = [];
  const idx: number[] = [];
  const rnd = new Rand(seed * 13 + 7);
  const f = 1.6 / o.radius;
  const coast = (a: number) =>
    1 + 0.3 * noise.fbm2(Math.cos(a) * 1.5 + seed, Math.sin(a) * 1.5 - seed, 4) + 0.07 * noise.noise2(Math.cos(a) * 6 + seed, Math.sin(a) * 6);
  const px = noise.noise2(seed, 3.3) * o.radius * 0.25, pz = noise.noise2(3.3, seed) * o.radius * 0.25;
  const topY = (x: number, z: number, t: number) => {
    let y = o.rim + o.dome * Math.max(0, 1 - t * t);
    y += o.hills * noise.fbm2(x * f + seed, z * f - seed, 4) * (0.35 + 0.65 * (1 - t * t));
    if (o.peak > 0) {
      const d = Math.hypot(x - px, z - pz) / (o.radius * 0.62);
      y += o.peak * Math.pow(Math.max(0, 1 - d), 1.7) * (0.8 + 0.35 * noise.ridged2(x * f * 1.6 + seed, z * f * 1.6, 4));
    }
    return y;
  };
  const S = o.seg;
  const ang = (s: number) => (s / S) * Math.PI * 2;
  const R = Array.from({ length: S }, (_, s) => o.radius * coast(ang(s)));

  // Top: a centre vertex, then rings out to the rim.
  pos.push(px * 0.2, topY(px * 0.2, pz * 0.2, 0), pz * 0.2);
  depth.push(0);
  const rows: number[] = [];
  const spots: THREE.Vector3[] = [];
  for (let i = 1; i <= o.top; i++) {
    const t = i / o.top;
    rows.push(pos.length / 3);
    for (let s = 0; s < S; s++) {
      const a = ang(s);
      const x = Math.cos(a) * R[s] * t, z = Math.sin(a) * R[s] * t;
      const y = topY(x, z, t);
      pos.push(x, y, z);
      depth.push(0);
      if (t < 0.86 && rnd.chance(0.05)) spots.push(new THREE.Vector3(x, y, z));
    }
  }
  const rimY = Array.from({ length: S }, (_, s) => pos[(rows[rows.length - 1] + s) * 3 + 1]);
  // Cliffs: the first row repeats the rim (a separate vertex, so the turf edge stays crisp),
  // then down the face to below the sea, with ledges, undercuts and a talus flare.
  const cliffStart = pos.length / 3;
  for (let j = 0; j <= o.cliff; j++) {
    const v = j / o.cliff;
    for (let s = 0; s < S; s++) {
      const a = ang(s);
      const y = rimY[s] + (o.bottom - rimY[s]) * Math.pow(v, 1.1);
      let r = R[s];
      if (j > 0) {
        const bulge = o.undercut * Math.sin(v * Math.PI) * noise.noise2(Math.cos(a) * 2 + seed, Math.sin(a) * 2 + 4);
        const ledge = 0.03 * Math.sin(y * 9 / Math.max(0.5, o.rim) + noise.noise2(a * 3, seed) * 3);
        const crag = 0.07 * noise.noise3(Math.cos(a) * 3 + seed, (y * 2.5) / Math.max(0.5, o.rim), Math.sin(a) * 3);
        r *= 1 + bulge + ledge + crag + 0.14 * THREE.MathUtils.smoothstep(v, 0.65, 1);
      }
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      depth.push(rimY[s] - y);
    }
  }
  // Indices (winding gives outward / upward faces).
  for (let s = 0; s < S; s++) idx.push(0, rows[0] + ((s + 1) % S), rows[0] + s);
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    for (let s = 0; s < S; s++) {
      const s1 = (s + 1) % S;
      idx.push(a + s, b + s1, b + s, a + s, a + s1, b + s1);
    }
  }
  for (let j = 0; j < o.cliff; j++) {
    const u = cliffStart + j * S, l = cliffStart + (j + 1) * S;
    for (let s = 0; s < S; s++) {
      const s1 = (s + 1) % S;
      idx.push(u + s, u + s1, l + s, u + s1, l + s1, l + s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Depth below the cliff top, so the material can lay soil and roots under the turf edge.
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return { geometry: g, spots };
}

/** Pines and broadleaf trees, each different in size, lean and shade. */
export function makeTrees(spots: THREE.Vector3[], seed: number, size: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const rnd = new Rand(seed);
  const pines = [C('#1f3a1f'), C('#284a26'), C('#1b3322'), C('#2f4f2a')];
  const leaves = [C('#3a5f28'), C('#46702f'), C('#33552a'), C('#577a33')];
  for (const p of spots) {
    const k = size * rnd.range(0.7, 1.3);
    const lean = rnd.range(-0.08, 0.08);
    const trunk = new THREE.CylinderGeometry(0.03 * k, 0.045 * k, 0.3 * k, 5);
    b.addGeometry(trunk, compose(p.x, p.y + 0.12 * k, p.z, lean, 0, lean), C('#5a4330'));
    trunk.dispose();
    if (rnd.chance(0.62)) {
      const col = pines[rnd.int(pines.length)];
      const tiers = 3 + rnd.int(2);
      for (let i = 0; i < tiers; i++) {
        const w = (0.34 - i * 0.07) * k, h = (0.42 - i * 0.05) * k;
        const cone = new THREE.ConeGeometry(w, h, 8);
        b.addGeometry(cone, compose(p.x, p.y + (0.3 + i * 0.22) * k, p.z, lean, rnd.range(0, 6), lean), col.clone().offsetHSL(0, 0, i * 0.03));
        cone.dispose();
      }
    } else {
      const col = leaves[rnd.int(leaves.length)];
      for (let i = 0; i < 3; i++) {
        const blob = smoothSphere((0.2 + rnd.range(0, 0.08)) * k, 1);
        b.addGeometry(blob, compose(p.x + rnd.range(-0.1, 0.1) * k, p.y + (0.42 + rnd.range(0, 0.14)) * k, p.z + rnd.range(-0.1, 0.1) * k, 0, 0, 0, 1, 0.85, 1), col.clone().offsetHSL(0, 0, rnd.range(-0.04, 0.04)));
        blob.dispose();
      }
    }
  }
  return b.build(false);
}
