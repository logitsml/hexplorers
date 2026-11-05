// Static natural decoration for every tile (trees, undergrowth, grass, wheat,
// flowers, rocks), instanced across the board. Placement is seeded per hex so
// every tile is unique, and respects road lanes, building corners and the
// number-disc clearing.

import * as THREE from 'three/webgpu';
import { Noise, Rand } from '../util/noise';
import { BatchSet, trs, type InstanceSpec } from './instancing';
import { ease } from '../util/tween';
import { release } from './release';
import type { TileSet, TileInfo } from './tiles';
import { foliageMaterial, rockMaterial, propMaterial, type TileEffects } from './materials';
import {
  makeBroadleaf,
  makeBush,
  makeCactus,
  makeFern,
  makeFlowerClump,
  makeGrassTuft,
  makeLogPile,
  makeMushrooms,
  makePine,
  makeRock,
  makeStump,
  makeWheatClump,
  makePalm,
  makeReeds,
  makeLilyPads,
  makeSnag,
  makeWillow,
} from './flora';
import { scatter, trackAt } from './terrain';
import { CORNER_OFFSETS } from '../../engine/board';
import { SEA_LEVEL, TOKEN_CLEAR, segDist } from './layout';
import { TOKEN_RADIUS } from './discSpots';
import { riverAt } from './riverCourse';
import { isLand, type GameState } from '../../engine';
import { topology } from '../../engine/modules/invasion/topology';
import { landHexes } from './looks';
import { isBeachSide } from './terrain';

/** World-space direction of wheat rows (shared by every field so neighbours line up). */
export const WHEAT_ROW_ANGLE = 0.42;

/** Something that animates over time (the world's animator). */
type Tweener = { tween: (o: { duration: number; delay?: number; easing?: (t: number) => number; update: (t: number) => void }) => unknown };

/** A building standing at (x, z): how far round it trees are cleared and ground cover trodden. */
export interface Site {
  x: number;
  z: number;
  clear: number;
  trample: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();

/** Share of its size ground cover keeps at `d` (0..1 of the radius) from a building: none inside 60%. */
const trampleKeep = (d: number) => (d >= 1 ? 1 : THREE.MathUtils.smoothstep(d, 0.6, 1));

/** Areas reserved by props (windmill, kiln, mine, paddock gate...) so vegetation avoids them. */
export type Reserved = { hex: number; x: number; z: number; r: number }[];

/**
 * Where the modules' pieces may come to stand on a hex, so trees, snags, cacti and props keep
 * clear of them as they do of buildings: the raiders' ring and their camp on the coast they land
 * on, wardens on their roads (Invasion), and the spots beside each corner a warden, a guild seat
 * or a foundry takes (see marks.ts ring and beside). Only for the modules in play: the base game's
 * island keeps all its growth.
 */
export function pieceAnchors(state: GameState): Reserved {
  const mods = new Set<string>(state.options.modules);
  const out: Reserved = [];
  const invasion = mods.has('invasion');
  const beside = invasion || mods.has('garrisons') || mods.has('guilds') || mods.has('oil');
  if (!invasion && !beside) return out;
  const board = state.board;
  if (invasion) {
    const topo = topology(board);
    // The raiders' ring and their camp, on the hexes they land on.
    for (const id of topo.coast) {
      for (let i = 0; i < 6; i++) {
        const a = 0.4 + id * 1.3 + (i / 6) * Math.PI * 2;
        out.push({ hex: id, x: Math.cos(a) * 0.44, z: Math.sin(a) * 0.44, r: 0.07 });
        const c = a + Math.PI / 6;
        out.push({ hex: id, x: Math.cos(c) * 0.55, z: Math.sin(c) * 0.55, r: 0.1 });
      }
    }
    // A warden on its road, a little in from the edge's middle on the landward side.
    board.edges.forEach((e, id) => {
      if (!topo.wardenEdge[id]) return;
      const hex = e.hexes.map((h) => board.hexes[h]).find((h) => isLand(h.terrain));
      if (!hex) return;
      const a = board.vertices[e.a], b = board.vertices[e.b];
      const mx = (a.x + b.x) / 2 - hex.x, mz = (a.z + b.z) / 2 - hex.z;
      const d = Math.hypot(mx, mz) || 1;
      out.push({ hex: hex.id, x: mx * (1 - 0.12 / d), z: mz * (1 - 0.12 / d), r: 0.06 });
    });
  }
  // Beside every corner, where a warden, a guild seat or a foundry stands by its building.
  if (beside)
    for (const h of landHexes(board))
      for (const [cx, cz] of CORNER_OFFSETS)
        for (const r of [0.34, 0.4]) out.push({ hex: h.id, x: cx * (1 - r), z: cz * (1 - r), r: 0.08 });
  return out;
}

export class Decor {
  group = new THREE.Group();
  batches = new BatchSet();
  /** Tree instances per forest tile (for felling animations). */
  /** `cleared`: shrunk away for a building; `felled`: cut down by a production, regrowing. */
  trees: { hex: number; batch: string; index: number; x: number; y: number; z: number; scale: number; rot: number; cleared?: boolean; felled?: boolean }[] = [];

  constructor(
    tiles: TileSet,
    effects: TileEffects,
    noise: Noise,
    density: number,
    reserved: Reserved,
  ) {
    const fol = (o: Parameters<typeof foliageMaterial>[1]) => foliageMaterial(effects, o);
    const treeMat = fol({ swayHeight: 0.5, swayAmount: 0.012, translucency: 0.5, instanceColor: true, tree: true });
    const grassMat = fol({ swayHeight: 0.07, swayAmount: 0.012, translucency: 0.6, instanceColor: true, trample: true, sheen: 0.14, dapple: true });
    grassMat.side = THREE.DoubleSide;
    const wheatMat = fol({ swayHeight: 0.14, swayAmount: 0.022, translucency: 0.45, instanceColor: true, sheen: 0.1 });
    wheatMat.side = THREE.DoubleSide;
    const fernMat = fol({ swayHeight: 0.06, swayAmount: 0.008, translucency: 0.5, instanceColor: true, trample: true, dapple: true });
    fernMat.side = THREE.DoubleSide;
    const flowerMat = fol({ swayHeight: 0.05, swayAmount: 0.006, translucency: 0.3, instanceColor: true, trample: true });
    flowerMat.side = THREE.DoubleSide;
    const bushMat = fol({ swayHeight: 0.1, swayAmount: 0.004, translucency: 0.4, instanceColor: true, dapple: true });
    const rockMossy = rockMaterial(effects, true);
    const rockBare = rockMaterial(effects, false);
    const rockShore = rockMaterial(effects, false, true);
    const prop = propMaterial(effects, { instanced: true });

    const B = this.batches;
    for (let i = 0; i < 4; i++) B.define(`pine${i}`, makePine(101 + i * 17, noise), treeMat, { name: 'pine' });
    for (let i = 0; i < 2; i++) B.define(`oak${i}`, makeBroadleaf(301 + i * 29, noise), treeMat, { name: 'oak' });
    B.define('birch', makeBroadleaf(511, noise, { birch: true }), treeMat, { name: 'birch' });
    for (let i = 0; i < 2; i++) B.define(`bush${i}`, makeBush(41 + i, noise, i === 1), bushMat);
    B.define('fern', makeFern(7), fernMat, { castShadow: false, detail: true });
    for (let i = 0; i < 3; i++) B.define(`grass${i}`, makeGrassTuft(900 + i, { blades: 7 + i * 2 }), grassMat, { castShadow: false, detail: true });
    B.define('grassLush', makeGrassTuft(951, { blades: 9, height: 0.05, lush: true }), grassMat, { castShadow: false, detail: true });
    B.define('grassDry', makeGrassTuft(977, { blades: 8, height: 0.055, dry: true }), grassMat, { castShadow: false, detail: true });
    B.define('flowers', makeFlowerClump(13), flowerMat, { castShadow: false, detail: true });
    for (let i = 0; i < 3; i++) B.define(`wheat${i}`, makeWheatClump(700 + i), wheatMat, { castShadow: i === 0 });
    for (let i = 0; i < 3; i++) B.define(`rock${i}`, makeRock(60 + i, noise), rockMossy, { name: 'rock' });
    for (let i = 0; i < 2; i++) B.define(`peakRock${i}`, makeRock(80 + i, noise, { jagged: 1.4, color: '#928b84' }), rockBare);
    for (let i = 0; i < 3; i++) B.define(`shoreRock${i}`, makeRock(120 + i, noise, { jagged: 1.6, color: '#867666' }), rockShore, { name: 'shore' });
    for (let i = 0; i < 3; i++) B.define(`cactus${i}`, makeCactus(400 + i * 7, i as 0 | 1 | 2), prop, { name: 'cactus' });
    B.define('sandstone', makeRock(91, noise, { flat: 0.7, color: '#d6a46a', jagged: 0.8 }), rockBare);
    B.define('clayRock', makeRock(95, noise, { flat: 0.8, color: '#b0683f' }), rockBare);
    B.define('mushrooms', makeMushrooms(3), prop, { castShadow: false, detail: true });
    B.define('logpile', makeLogPile(5), prop);
    B.define('stump', makeStump(9), prop);
    // The expansions' looks. (Defined for every board, built only where something was placed. Few
    // kinds, each varied by its placing: every batch is a shader of its own, its count written in.)
    for (let i = 0; i < 2; i++) B.define(`palm${i}`, makePalm(611 + i * 13, noise), treeMat, { name: 'palm' });
    B.define('willow', makeWillow(701, noise), treeMat, { name: 'willow' });
    B.define('reeds0', makeReeds(801), wheatMat);
    B.define('lily0', makeLilyPads(881), prop, { castShadow: false, detail: true });
    B.define('snag0', makeSnag(901, noise), prop, { name: 'snag' });

    for (const t of tiles.tiles) {
      const rnd = new Rand(t.shape.seed * 31 + 7);
      const res = reserved.filter((r) => r.hex === t.hex.id);
      // An oil well's machinery stands taller than its pad: nothing right beside it either, and
      // nothing tall (trees, cacti, snags: placed with a wide berth) near enough to stand behind
      // its lattice.
      const pad = t.shape.ctx.pad;
      if (pad) res.push({ hex: t.hex.id, x: pad.x, z: pad.z, r: pad.r + 0.12 });
      const free = (x: number, z: number, rad: number) =>
        t.shape.canPlace(x, z, rad) && res.every((r) => Math.hypot(x - r.x, z - r.z) > r.r + rad) && (!pad || rad < 0.07 || Math.hypot(x - pad.x, z - pad.z) > pad.r + 0.24);
      switch (t.shape.terrain) {
        case 'forest':
          this.forest(t, rnd, free, density);
          break;
        case 'pasture':
          this.pasture(t, rnd, free, density);
          break;
        case 'fields':
          this.fields(t, rnd, free, density, res);
          break;
        case 'hills':
          this.hills(t, rnd, free, density);
          break;
        case 'mountains':
          this.mountains(t, rnd, free, density);
          break;
        case 'desert':
          this.desert(t, rnd, free, density);
          break;
        case 'swamp':
          this.swamp(t, rnd, free, density);
          break;
        case 'lake':
          this.lake(t, rnd, free, density);
          break;
        case 'oasis':
          this.oasis(t, rnd, free, density);
          break;
        case 'bounty':
          this.bounty(t, rnd, free, density);
          break;
        case 'castle':
          this.castle(t, rnd, free, density);
          break;
      }
    }
    for (const t of tiles.tiles) {
      this.rimFringe(t, new Rand(t.shape.seed * 13 + 5), density);
      this.shoreRocks(t, new Rand(t.shape.seed * 17 + 3));
    }
    B.buildAll(this.group);
    this.splatContacts(effects);
  }

  /**
   * What stands solid on a hex (trees, bushes, rocks, stumps...), as circles in the hex's own x and z,
   * for the animals that wander there to walk round.
   */
  solids(hex: number, tile: { x: number; z: number }): { x: number; z: number; r: number }[] {
    const out: { x: number; z: number; r: number }[] = [];
    const col = new THREE.Vector3();
    for (const [key, b] of this.batches.batches) {
      if (!/^(pine|oak|birch|palm|willow|bush|rock|peakRock|sandstone|clayRock|stump|logpile|cactus|snag)/.test(key)) continue;
      if (!b.geometry.boundingBox) b.geometry.computeBoundingBox();
      const bb = b.geometry.boundingBox!;
      const half = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
      for (const it of b.items) {
        if (it.tile !== hex) continue;
        const e = it.matrix.elements;
        out.push({ x: e[12] - tile.x, z: e[14] - tile.z, r: half * col.setFromMatrixColumn(it.matrix, 0).length() });
      }
    }
    return out;
  }

  /** Soft contact shade on the ground under every tree, bush, rock and stump. */
  private splatContacts(effects: TileEffects) {
    const map = effects.contact;
    map.clear('base');
    const col = new THREE.Vector3();
    for (const [key, b] of this.batches.batches) {
      const tree = /^(pine|oak|birch|palm|willow)/.test(key);
      const solid = tree || /^(bush|rock|peakRock|sandstone|clayRock|stump|logpile|cactus|palm|willow|snag)/.test(key);
      if (!solid) continue;
      if (!b.geometry.boundingBox) b.geometry.computeBoundingBox();
      const bb = b.geometry.boundingBox!;
      const half = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
      for (const it of b.items) {
        const e = it.matrix.elements;
        const s = col.setFromMatrixColumn(it.matrix, 0).length();
        map.splat('base', e[12], e[14], half * s * (tree ? 1.7 : 1.5), tree ? 0.55 : 0.4, 0, tree ? 1 : 0);
      }
    }
    map.commit();
  }

  /** Dark, chunky boulders piled at the foot of every sea cliff, breaking up the hex outline. */
  private shoreRocks(t: TileInfo, rnd: Rand) {
    const land = t.shape.ctx.landSide;
    for (let side = 0; side < 6; side++) {
      if (land[side]) continue;
      const [ax, az] = CORNER_OFFSETS[side];
      const [bx, bz] = CORNER_OFFSETS[(side + 1) % 6];
      // A sandy cove keeps just a rock or two at each horn, framing it.
      const beach = isBeachSide(t.shape.seed, side);
      const n = beach ? 3 : 5 + rnd.int(5);
      for (let i = 0; i < n; i++) {
        const u = beach ? (i % 2 ? rnd.range(-0.05, 0.1) : rnd.range(0.9, 1.05)) : rnd.range(-0.05, 1.05);
        const out = rnd.range(1.03, 1.16);
        const x = (ax + (bx - ax) * u) * out;
        const z = (az + (bz - az) * u) * out;
        const s = rnd.range(0.07, 0.17);
        const y = SEA_LEVEL - s * rnd.range(0.2, 0.7);
        this.batches.get(`shoreRock${rnd.int(3)}`).add({
          matrix: trs(t.hex.x + x, y, t.hex.z + z, rnd.range(0, 6.28), s, s * rnd.range(0.8, 1.6), rnd.range(-0.3, 0.3), rnd.range(-0.3, 0.3)),
          tile: t.hex.id,
          // Order round the island (0..1), for the intro's wave of rising boulders.
          phase: Math.min(1, Math.max(0, (Math.atan2(t.hex.x + x, t.hex.z + z) + Math.PI) / (Math.PI * 2) + rnd.range(-0.03, 0.03))),
          color: this.tint(rnd, '#ffffff', 0.02, 0.08),
        });
      }
    }
  }

  /** Grass tufts leaning out over every open tile edge, like turf overhanging the cliff. */
  private rimFringe(t: TileInfo, rnd: Rand, density: number) {
    if (t.shape.terrain === 'desert' || t.shape.terrain === 'hills' || t.shape.terrain === 'oasis' || t.shape.terrain === 'bounty') return;
    const conn = t.shape.ctx.connected;
    const key = 'grassLush';
    const corners = CORNER_OFFSETS;
    for (let side = 0; side < 6; side++) {
      if (conn[side] || t.shape.ctx.landSide[side]) continue;
      const [ax, az] = corners[side];
      const [bx, bz] = corners[(side + 1) % 6];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.round((len / 0.03) * Math.min(1.2, density));
      const outA = Math.atan2((az + bz) / 2, (ax + bx) / 2);
      for (let i = 0; i < steps; i++) {
        const u = (i + rnd.range(0.2, 0.8)) / steps;
        if (u < 0.12 || u > 0.88) continue; // keep building corners clear
        const x = (ax + (bx - ax) * u) * 0.975;
        const z = (az + (bz - az) * u) * 0.975;
        this.put(key, t, x, z, rnd.range(0.6, 1.0), {
          ry: -outA + Math.PI / 2 + rnd.range(-0.3, 0.3),
          color: this.tint(rnd, '#ffffff', 0.02, 0.06),
          sink: 0.012,
          tiltOut: { angle: outA, amount: rnd.range(0.45, 0.9) },
        });
      }
    }
  }

  private y(t: TileInfo, x: number, z: number) {
    return t.shape.height(x, z);
  }

  private put(
    key: string,
    t: TileInfo,
    x: number,
    z: number,
    s: number,
    opts: { ry?: number; sy?: number; color?: THREE.Color; tilt?: number; sink?: number; tiltOut?: { angle: number; amount: number } } = {},
  ) {
    const wx = t.hex.x + x;
    const wz = t.hex.z + z;
    const y = this.y(t, x, z) - (opts.sink ?? 0.004);
    const tilt = opts.tilt ?? 0;
    let matrix = trs(wx, y, wz, opts.ry ?? 0, s, opts.sy ?? s, tilt * Math.cos(x * 40), tilt * Math.sin(z * 40));
    if (opts.tiltOut) {
      // Lean outward (over the edge) around the horizontal axis perpendicular to the outward direction.
      const axis = new THREE.Vector3(-Math.sin(opts.tiltOut.angle), 0, Math.cos(opts.tiltOut.angle));
      const q = new THREE.Quaternion().setFromAxisAngle(axis, -opts.tiltOut.amount).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), opts.ry ?? 0));
      matrix = new THREE.Matrix4().compose(new THREE.Vector3(wx, y, wz), q, new THREE.Vector3(s, opts.sy ?? s, s));
    }
    return this.batches.get(key).add({
      matrix,
      tile: t.hex.id,
      phase: (wx * 1.7 + wz * 2.3) % 6.283,
      color: opts.color,
    });
  }

  private tint(rnd: Rand, base: string, hueJitter = 0.03, lJitter = 0.08): THREE.Color {
    const c = new THREE.Color(base);
    c.offsetHSL(rnd.range(-hueJitter, hueJitter), rnd.range(-0.05, 0.05), rnd.range(-lJitter, lJitter));
    return c;
  }

  private grass(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, count: number, keys: string[], scale: [number, number], color = '#ffffff') {
    const pts = scatter(rnd, count, 0.03, (x, z) => free(x, z, 0.0) || (rnd.chance(0.35) && t.shape.canPlace(x, z, -0.08)));
    for (const p of pts) this.put(rnd.pick(keys), t, p.x, p.z, rnd.range(scale[0], scale[1]), { ry: rnd.range(0, 6.28), color: this.tint(rnd, color, 0.02, 0.06) });
  }

  // ------------------------------------------------------------------ forest
  private forest(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    const count = 16 + rnd.int(11);
    // Canopies must not overhang the number disc: keep trees further from the clearing.
    const pts = scatter(rnd, count, 0.115, (x, z) => free(x, z, 0.1) && Math.hypot(x, z) > 0.5);
    for (const p of pts) {
      const roll = rnd.next();
      const key = roll < 0.7 ? `pine${rnd.int(4)}` : roll < 0.9 ? `oak${rnd.int(2)}` : 'birch';
      // Trees near the clearing stay short enough that the number disc remains visible from above.
      const r = Math.hypot(p.x, p.z);
      const s = Math.min(rnd.range(0.78, 1.18), (1.33 * (r - 0.24)) / 0.5 + 0.18);
      const ry = rnd.range(0, 6.283);
      const color = key.startsWith('pine') ? this.tint(rnd, '#ffffff', 0.025, 0.07) : this.tint(rnd, '#ffffff', 0.04, 0.08);
      const idx = this.put(key, t, p.x, p.z, s, { ry, color, tilt: 0.04 });
      this.trees.push({ hex: t.hex.id, batch: key, index: idx, x: t.hex.x + p.x, y: this.y(t, p.x, p.z), z: t.hex.z + p.z, scale: s, rot: ry });
    }
    const under = scatter(rnd, Math.round((14 + rnd.int(8)) * density), 0.06, (x, z) => free(x, z, 0.02));
    for (const p of under) {
      const r = rnd.next();
      if (r < 0.45) this.put('fern', t, p.x, p.z, rnd.range(0.8, 1.3), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff') });
      else if (r < 0.8) this.put(`bush${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.6, 1.0), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff') });
      else this.put('mushrooms', t, p.x, p.z, rnd.range(0.8, 1.2), { ry: rnd.range(0, 6.28) });
    }
    const rocks = scatter(rnd, 2 + rnd.int(3), 0.15, (x, z) => free(x, z, 0.05));
    for (const p of rocks) this.put(`rock${rnd.int(3)}`, t, p.x, p.z, rnd.range(0.035, 0.06), { ry: rnd.range(0, 6.28), sink: 0.01 });
    const lp = scatter(rnd, 1, 0.2, (x, z) => free(x, z, 0.07) && Math.hypot(x, z) < 0.55);
    for (const p of lp) this.put(rnd.chance(0.6) ? 'logpile' : 'stump', t, p.x, p.z, 1, { ry: rnd.range(0, 6.28) });
    this.grass(t, rnd, free, Math.round(90 * density), ['grass0', 'grass1'], [0.7, 1.1], '#d8e8c0');
  }

  // ----------------------------------------------------------------- pasture
  private pasture(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    this.grass(t, rnd, free, Math.round(650 * density), ['grassLush', 'grass1', 'grass2'], [0.7, 1.15]);
    const flowerColors = ['#ffffff', '#ffe14d', '#ff9ec7', '#c8a0ff', '#ffffff', '#ffb84d'];
    const fl = scatter(rnd, Math.round((40 + rnd.int(30)) * density), 0.04, (x, z) => free(x, z, 0.01));
    for (const p of fl) this.put('flowers', t, p.x, p.z, rnd.range(0.8, 1.2), { ry: rnd.range(0, 6.28), color: new THREE.Color(rnd.pick(flowerColors)) });
    const b = scatter(rnd, 1 + rnd.int(3), 0.2, (x, z) => free(x, z, 0.05));
    for (const p of b) this.put(`bush${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.7, 1.0), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff') });
    if (rnd.chance(0.55)) {
      const tr = scatter(rnd, 1, 0.3, (x, z) => free(x, z, 0.14) && Math.hypot(x, z) > 0.6);
      for (const p of tr) this.put(`oak${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.85, 1.05), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff') });
    }
    const rocks = scatter(rnd, rnd.int(3), 0.2, (x, z) => free(x, z, 0.04));
    for (const p of rocks) this.put(`rock${rnd.int(3)}`, t, p.x, p.z, rnd.range(0.025, 0.04), { ry: rnd.range(0, 6.28), sink: 0.008 });
  }

  // ------------------------------------------------------------------ fields
  private fields(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number, res: Reserved) {
    const ca = Math.cos(WHEAT_ROW_ANGLE), sa = Math.sin(WHEAT_ROW_ANGLE);
    const rowGap = 0.05;
    const along = 0.03 / Math.sqrt(Math.max(0.35, density));
    // Iterate in world-aligned row coordinates so neighbouring fields line up.
    const wx0 = t.hex.x, wz0 = t.hex.z;
    const uMin = Math.floor(((wx0 * ca + wz0 * sa) - 1.1) / rowGap);
    const uMax = Math.ceil(((wx0 * ca + wz0 * sa) + 1.1) / rowGap);
    for (let ui = uMin; ui <= uMax; ui++) {
      const u = ui * rowGap;
      const vCenter = -wx0 * sa + wz0 * ca;
      for (let v = vCenter - 1.1; v <= vCenter + 1.1; v += along) {
        const jitterV = v + rnd.range(-along * 0.3, along * 0.3);
        const ju = u + rnd.range(-0.006, 0.006);
        const wx = ju * ca - jitterV * sa;
        const wz = ju * sa + jitterV * ca;
        const x = wx - wx0, z = wz - wz0;
        if (!free(x, z, 0.012)) continue;
        // The crop canopy covers the field; individual stalks fringe its edges and poke through sparsely.
        const edge = !t.shape.canPlace(x, z, 0.06) || res.some((r) => Math.hypot(x - r.x, z - r.z) < r.r + 0.05);
        if (!edge && !rnd.chance(0.07)) continue;
        this.put(`wheat${rnd.int(3)}`, t, x, z, rnd.range(0.85, 1.12) * (edge ? 1 : 1.12), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff', 0.015, 0.06) });
      }
    }
    // Where a river cuts through the field, a hedge along each bank where the crop falls away to
    // it (see FieldsLife.buildCanopy), so the cut is a field's edge and not a wall of straw.
    const river = t.shape.ctx.river;
    if (river) {
      const hedge = scatter(rnd, 90, 0.048, (x, z) => {
        const q = riverAt(river, x, z);
        if (!q) return false;
        const d = q.d - q.half;
        return d > 0.05 && d < 0.085 && t.shape.mask(x, z) > 0.55 && res.every((r) => Math.hypot(x - r.x, z - r.z) > r.r);
      });
      for (const p of hedge) this.put(rnd.chance(0.2) ? 'bush1' : 'bush0', t, p.x, p.z, rnd.range(0.46, 0.58), { ry: rnd.range(0, 6.28), sy: rnd.range(0.42, 0.55), color: this.tint(rnd, '#c8d8a8', 0.02, 0.06), sink: 0.006 });
    }
    // Field margins: poppies, cornflowers and grass on the rim side of the crop.
    const margin = scatter(rnd, Math.round(26 * density), 0.05, (x, z) => !free(x, z, 0.0) && t.shape.canPlace(x, z, -0.1) && Math.hypot(x, z) > 0.3);
    for (const p of margin) this.put('flowers', t, p.x, p.z, rnd.range(0.8, 1.1), { ry: rnd.range(0, 6.28), color: new THREE.Color(rnd.chance(0.6) ? '#ff4b3a' : '#5a7dff') });
    this.grass(t, rnd, (x, z, r) => !free(x, z, 0) && t.shape.canPlace(x, z, r - 0.1), Math.round(60 * density), ['grass1', 'grass2'], [0.6, 1.0]);
  }

  // ------------------------------------------------------------------- hills
  private hills(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    // Bare clay: no grass or scrub, just clay boulders and scattered clods.
    const rocks = scatter(rnd, 3 + rnd.int(3), 0.12, (x, z) => free(x, z, 0.04));
    for (const p of rocks) this.put('clayRock', t, p.x, p.z, rnd.range(0.025, 0.05), { ry: rnd.range(0, 6.28), sink: 0.01 });
    const clods = scatter(rnd, Math.round(26 * density), 0.05, (x, z) => free(x, z, 0.01));
    for (const p of clods) this.put('clayRock', t, p.x, p.z, rnd.range(0.008, 0.016), { ry: rnd.range(0, 6.28), sink: 0.004 });
    if (rnd.chance(0.6)) {
      const tr = scatter(rnd, 1, 0.3, (x, z) => free(x, z, 0.12) && Math.hypot(x, z) > 0.6);
      for (const p of tr) this.put(`oak${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.7, 0.9), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#e6e8a0') });
    }
  }

  // --------------------------------------------------------------- mountains
  private mountains(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    // A few hardy pines on the lower slopes; none on the camera side of the disc, where they'd hide it.
    const pines = scatter(rnd, 3 + rnd.int(4), 0.14, (x, z) => free(x, z, 0.08) && this.y(t, x, z) < 0.36 && Math.hypot(x, z) > 0.55 && (z < 0.15 || Math.abs(x) > 0.5));
    for (const p of pines) {
      const h = this.y(t, p.x, p.z);
      const r = Math.hypot(p.x, p.z);
      const s = Math.min(rnd.range(0.4, 0.62) * (1 - h * 0.6), (1.33 * (r - 0.24)) / 0.5 + 0.12);
      this.put(`pine${rnd.int(4)}`, t, p.x, p.z, s, { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#c8d8c0', 0.02, 0.06), tilt: 0.06 });
    }
    const boulders = scatter(rnd, 9 + rnd.int(6), 0.08, (x, z) => free(x, z, 0.03));
    for (const p of boulders) this.put(`peakRock${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.03, 0.07), { ry: rnd.range(0, 6.28), sink: 0.012 });
    const scree = scatter(rnd, Math.round(18 * density), 0.05, (x, z) => free(x, z, 0.01));
    for (const p of scree) this.put(`peakRock${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.01, 0.02), { ry: rnd.range(0, 6.28), sink: 0.004 });
    this.grass(t, rnd, (x, z, r) => free(x, z, r) && this.y(t, x, z) < 0.18, Math.round(70 * density), ['grass0', 'grass1'], [0.6, 0.9], '#cfe0b0');
  }

  // ------------------------------------------------------------------ desert
  private desert(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    const rocks = scatter(rnd, 3 + rnd.int(3), 0.18, (x, z) => free(x, z, 0.05));
    for (const p of rocks) this.put('sandstone', t, p.x, p.z, rnd.range(0.035, 0.075), { ry: rnd.range(0, 6.28), sink: 0.015 });
    // One or two saguaros plus a scatter of barrel cacti and prickly pear.
    // (Where an oil well's pad has pushed the cacti about, the tall ones keep from standing
    // between the camera's usual place and the number disc.)
    const pad = t.shape.ctx.pad;
    const cacti = scatter(rnd, 4 + rnd.int(3), 0.2, (x, z) => free(x, z, 0.08) && !(pad && z > 0.05 && Math.abs(x) < 0.34));
    cacti.forEach((p, i) => {
      const kind = i < 1 + rnd.int(2) ? 0 : 1 + rnd.int(2);
      const s = kind === 0 ? rnd.range(1.9, 2.5) : rnd.range(1.5, 2.0);
      this.put(`cactus${kind}`, t, p.x, p.z, s, { ry: rnd.range(0, 6.28), sink: 0.003, color: this.tint(rnd, '#ffffff', 0.02, 0.06) });
    });
    this.grass(t, rnd, free, Math.round(30 * density), ['grassDry'], [0.6, 1.0], '#f0e2b0');
  }

  /**
   * Ground cover kept strictly where `accept` allows (unlike grass(), which lets some stray into
   * the lanes regardless): off the water, off the castle's top and its track.
   */
  private cover(t: TileInfo, rnd: Rand, accept: (x: number, z: number, r: number) => boolean, count: number, keys: string[], scale: [number, number], color = '#ffffff') {
    const pts = scatter(rnd, count, 0.03, (x, z) => accept(x, z, 0));
    for (const p of pts) this.put(rnd.pick(keys), t, p.x, p.z, rnd.range(scale[0], scale[1]), { ry: rnd.range(0, 6.28), color: this.tint(rnd, color, 0.02, 0.06) });
  }

  /** How far below the water the bed lies at (x, z): negative on dry ground (see TileFeatures.water). */
  private depth(t: TileInfo, x: number, z: number) {
    return t.shape.features.water?.depth(x, z) ?? -1;
  }

  /** Something lying on its side (a fallen snag): tipped over about a horizontal axis at `ry`. */
  private lay(key: string, t: TileInfo, x: number, z: number, s: number, ry: number, tip: number, sink: number) {
    const m = new THREE.Matrix4().compose(
      _p.set(t.hex.x + x, this.y(t, x, z) - sink, t.hex.z + z),
      _q.setFromEuler(new THREE.Euler(0, ry, tip, 'YXZ')),
      _s1.setScalar(s),
    );
    this.batches.get(key).add({ matrix: m, tile: t.hex.id, phase: (x * 9 + z * 7) % 6.283 });
  }

  // ------------------------------------------------------------------- swamp
  private swamp(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    // The river's channel (where it runs through) is kept open water: reeds line it, nothing stands in it.
    const ch = t.shape.features.channel ?? [];
    const chan = (x: number, z: number) => {
      let d = Infinity;
      for (let i = 0; i + 1 < ch.length; i++) d = Math.min(d, segDist(x, z, ch[i].x, ch[i].z, ch[i + 1].x, ch[i + 1].z));
      return d;
    };
    const open = (x: number, z: number) => chan(x, z) > 0.07;
    // Bulrushes crowd the margins and the shallows, in beds.
    const reeds = scatter(rnd, Math.round(46 * density), 0.045, (x, z) => {
      const d = this.depth(t, x, z);
      return free(x, z, 0.01) && d > -0.014 && d < 0.02 && open(x, z) && this.noiseBed(t, x, z) > -0.15;
    });
    for (const p of reeds) this.put('reeds0', t, p.x, p.z, rnd.range(0.8, 1.25), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff', 0.03, 0.08) });
    // Rushes and sedge on the tussocks between the pools, and round the clearing's rim too (short
    // enough not to hide a disc, and clear of where one would lie), so it isn't a bald mound.
    const rim = (x: number, z: number) => {
      const r = Math.hypot(x, z);
      return r > TOKEN_RADIUS + 0.03 && r < TOKEN_CLEAR + 0.1 && t.shape.canPlace(x * (TOKEN_CLEAR + 0.12) / r, z * (TOKEN_CLEAR + 0.12) / r, 0);
    };
    const tufts = scatter(rnd, Math.round(130 * density), 0.035, (x, z) => (free(x, z, 0) || rim(x, z)) && this.depth(t, x, z) < -0.006);
    tufts.forEach((p, i) => {
      if (i % 3 === 0) this.put('grass1', t, p.x, p.z, rnd.range(0.8, 1.2), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#e8ecc0', 0.03, 0.08) });
      else this.put(rnd.chance(0.5) ? 'grassDry' : 'grass1', t, p.x, p.z, rnd.range(0.7, 1.1), { ry: rnd.range(0, 6.28), color: this.tint(rnd, rnd.chance(0.5) ? '#d8c08a' : '#b8b07a', 0.03, 0.06) });
    });
    // Lily pads out on the still water.
    const pads = scatter(rnd, Math.round(10 * density) + 2, 0.08, (x, z) => free(x, z, 0.02) && this.depth(t, x, z) > 0.008 && open(x, z));
    for (const p of pads) this.put('lily0', t, p.x, p.z, rnd.range(0.8, 1.2), { ry: rnd.range(0, 6.28), sink: 0 });
    // Dead snags standing in the pools and at their edges, and one fallen across the water.
    // (Tall, so kept off an oil well's machinery as other tall things are.)
    const pad = t.shape.ctx.pad;
    // (The swamp's silhouette from the table: tall, grey and bare, more of them towards the back so
    // they stand behind the disc rather than before it.)
    // (Only a snag's foot needs the room: its limbs are high and bare.)
    const snags = scatter(rnd, 7 + rnd.int(3), 0.12, (x, z) => free(x, z, 0.025) && open(x, z) && (!pad || Math.hypot(x - pad.x, z - pad.z) > pad.r + 0.24) && (z < 0.2 || rnd.chance(0.3)));
    snags.forEach((p, i) => {
      if (i === 0) this.lay('snag0', t, p.x, p.z, rnd.range(1.0, 1.2), rnd.range(0, 6.28), rnd.range(1.35, 1.5), 0.008);
      else this.put('snag0', t, p.x, p.z, rnd.range(1.25, 1.85) * (p.z > 0.2 ? 0.8 : 1), { ry: rnd.range(0, 6.28), sink: 0.01 });
    });
    const rocks = scatter(rnd, 1 + rnd.int(2), 0.2, (x, z) => free(x, z, 0.04) && this.depth(t, x, z) < -0.004);
    for (const p of rocks) this.put(`rock${rnd.int(3)}`, t, p.x, p.z, rnd.range(0.025, 0.04), { ry: rnd.range(0, 6.28), sink: 0.01 });
  }

  /** Low-frequency noise that gathers water plants into beds rather than an even scatter. */
  private noiseBed(t: TileInfo, x: number, z: number) {
    const wx = t.hex.x + x, wz = t.hex.z + z;
    return Math.sin(wx * 7.3 + Math.sin(wz * 5.1) * 1.7) * 0.6 + Math.sin(wz * 6.1 - wx * 2.3) * 0.4;
  }

  // -------------------------------------------------------------------- lake
  private lake(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    const reeds = scatter(rnd, Math.round(20 * density), 0.04, (x, z) => {
      const d = this.depth(t, x, z);
      return free(x, z, 0.01) && d > -0.004 && d < 0.03 && this.noiseBed(t, x, z) > 0.45;
    });
    for (const p of reeds) this.put('reeds0', t, p.x, p.z, rnd.range(0.85, 1.2), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff', 0.03, 0.06) });
    const pads = scatter(rnd, Math.round(8 * density) + 2, 0.09, (x, z) => free(x, z, 0.02) && this.depth(t, x, z) > 0.012 && this.noiseBed(t, x, z) < 0.3);
    for (const p of pads) this.put('lily0', t, p.x, p.z, rnd.range(0.8, 1.15), { ry: rnd.range(0, 6.28), sink: 0 });
    // A willow leaning over the water from the shore.
    const wl = scatter(rnd, 1, 0.3, (x, z) => free(x, z, 0.12) && this.depth(t, x, z) < -0.012 && this.depth(t, x, z) > -0.03 && Math.hypot(x, z) > 0.5);
    for (const p of wl) this.put('willow', t, p.x, p.z, rnd.range(0.9, 1.05), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff', 0.02, 0.05) });
    // Turf and flowers on the dry ground, pebbles along the waterline.
    this.cover(t, rnd, (x, z, r) => free(x, z, r) && this.depth(t, x, z) < -0.016, Math.round(180 * density), ['grassLush', 'grass1', 'grass2'], [0.7, 1.1]);
    const fl = scatter(rnd, Math.round(26 * density), 0.05, (x, z) => free(x, z, 0.01) && this.depth(t, x, z) < -0.012);
    for (const p of fl) this.put('flowers', t, p.x, p.z, rnd.range(0.8, 1.1), { ry: rnd.range(0, 6.28), color: new THREE.Color(rnd.pick(['#ffffff', '#ffe14d', '#c8a0ff', '#9ec5ff'])) });
    const pebbles = scatter(rnd, 6 + rnd.int(4), 0.08, (x, z) => free(x, z, 0.02) && Math.abs(this.depth(t, x, z) + 0.002) < 0.006);
    for (const p of pebbles) this.put(`rock${rnd.int(3)}`, t, p.x, p.z, rnd.range(0.012, 0.022), { ry: rnd.range(0, 6.28), sink: 0.006 });
    const b = scatter(rnd, 1 + rnd.int(2), 0.25, (x, z) => free(x, z, 0.05) && this.depth(t, x, z) < -0.015);
    for (const p of b) this.put(`bush${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.7, 0.95), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff') });
  }

  // ------------------------------------------------------------------- oasis
  private oasis(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    const pool = t.shape.features.sites!.pool;
    // Palms ring the pool, leaning out over it, with one or two stragglers on the dunes.
    const want = 6 + rnd.int(3);
    let placed = 0;
    for (let i = 0; i < 24 && placed < want; i++) {
      const a = (i / 24) * Math.PI * 2 * 3 + rnd.range(-0.2, 0.2);
      const d = pool.r! + rnd.range(0.03, 0.1);
      const x = pool.x + Math.cos(a) * d, z = pool.z + Math.sin(a) * d;
      // (A palm's trunk is slender: only its foot needs the room.)
      if (!free(x, z, 0.025) || this.depth(t, x, z) > -0.004) continue;
      placed++;
      // Turned so the trunk's lean faces the water.
      this.put(`palm${rnd.int(2)}`, t, x, z, rnd.range(0.85, 1.15), { ry: -a + Math.PI + rnd.range(-0.4, 0.4), color: this.tint(rnd, '#ffffff', 0.025, 0.07), sink: 0.006 });
    }
    const far = scatter(rnd, 1 + rnd.int(2), 0.35, (x, z) => free(x, z, 0.1) && Math.hypot(x - pool.x, z - pool.z) > pool.r! + 0.25);
    for (const p of far) this.put(`palm${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.8, 1.0), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff', 0.025, 0.07), sink: 0.006 });
    const reeds = scatter(rnd, Math.round(12 * density), 0.04, (x, z) => free(x, z, 0.01) && this.depth(t, x, z) > -0.005 && this.depth(t, x, z) < 0.014);
    for (const p of reeds) this.put('reeds0', t, p.x, p.z, rnd.range(0.7, 1.0), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#ffffff', 0.03, 0.06) });
    const near = (x: number, z: number) => Math.hypot(x - pool.x, z - pool.z) - pool.r! < 0.18;
    this.cover(t, rnd, (x, z, r) => free(x, z, r) && near(x, z) && this.depth(t, x, z) < -0.006, Math.round(90 * density), ['grassLush', 'grass1'], [0.7, 1.05]);
    this.cover(t, rnd, (x, z, r) => free(x, z, r) && !near(x, z), Math.round(26 * density), ['grassDry'], [0.6, 1.0], '#f0e2b0');
    const rocks = scatter(rnd, 2 + rnd.int(2), 0.2, (x, z) => free(x, z, 0.05) && !near(x, z));
    for (const p of rocks) this.put('sandstone', t, p.x, p.z, rnd.range(0.03, 0.06), { ry: rnd.range(0, 6.28), sink: 0.015 });
  }

  // ------------------------------------------------------------------ bounty
  private bounty(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    // Quartz breaking through the knolls, gorse in flower, thin dry grass and a scrubby tree or two.
    const quartz = scatter(rnd, 5 + rnd.int(3), 0.1, (x, z) => free(x, z, 0.03) && this.y(t, x, z) > 0.05);
    for (const p of quartz) this.put(`peakRock${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.02, 0.045), { ry: rnd.range(0, 6.28), sink: 0.01 });
    const stones = scatter(rnd, 2 + rnd.int(2), 0.2, (x, z) => free(x, z, 0.04));
    for (const p of stones) this.put('sandstone', t, p.x, p.z, rnd.range(0.03, 0.05), { ry: rnd.range(0, 6.28), sink: 0.012 });
    const gorse = scatter(rnd, 4 + rnd.int(3), 0.12, (x, z) => free(x, z, 0.04) && this.depth(t, x, z) < -0.01);
    for (const p of gorse) this.put('bush1', t, p.x, p.z, rnd.range(0.55, 0.8), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#f2e2a0', 0.02, 0.06) });
    const trees = scatter(rnd, 1 + rnd.int(2), 0.3, (x, z) => free(x, z, 0.1) && Math.hypot(x, z) > 0.55);
    for (const p of trees) this.put(rnd.chance(0.5) ? `pine${rnd.int(4)}` : `oak${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.55, 0.72), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#e2e2a8', 0.02, 0.06), tilt: 0.06 });
    this.cover(t, rnd, (x, z, r) => free(x, z, r) && this.depth(t, x, z) < -0.006, Math.round(55 * density), ['grassDry', 'grass0'], [0.6, 0.95], '#eadca8');
  }

  // ------------------------------------------------------------------ castle
  private castle(t: TileInfo, rnd: Rand, free: (x: number, z: number, r: number) => boolean, density: number) {
    const pl = t.shape.features.plateau!;
    // Nothing on the top (the castle stands there) or on the track.
    const ok = (x: number, z: number, r: number) => free(x, z, r) && Math.hypot(x, z) > pl.r + 0.06 + r && trackAt(pl.track, x, z) < 0.05;
    const heath = scatter(rnd, 12 + rnd.int(5), 0.09, (x, z) => ok(x, z, 0.03));
    // Dark heath and gorse in flower.
    for (const p of heath) {
      const gorse = rnd.chance(0.4);
      this.put(gorse ? 'bush1' : 'bush0', t, p.x, p.z, rnd.range(0.45, 0.75), { ry: rnd.range(0, 6.28), color: this.tint(rnd, gorse ? '#ffffff' : '#b4c49c', 0.02, 0.06) });
    }
    // Wind-bent pines at the foot of the rise.
    const pines = scatter(rnd, 3 + rnd.int(2), 0.18, (x, z) => ok(x, z, 0.07) && this.y(t, x, z) < 0.1);
    for (const p of pines) this.put(`pine${rnd.int(4)}`, t, p.x, p.z, rnd.range(0.45, 0.65), { ry: rnd.range(0, 6.28), color: this.tint(rnd, '#c8d8c0', 0.02, 0.06), tilt: 0.12 });
    const boulders = scatter(rnd, 10 + rnd.int(5), 0.08, (x, z) => ok(x, z, 0.03));
    for (const p of boulders) this.put(`peakRock${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.03, 0.065), { ry: rnd.range(0, 6.28), sink: 0.012 });
    const scree = scatter(rnd, Math.round(16 * density), 0.05, (x, z) => ok(x, z, 0.01));
    for (const p of scree) this.put(`peakRock${rnd.int(2)}`, t, p.x, p.z, rnd.range(0.01, 0.02), { ry: rnd.range(0, 6.28), sink: 0.004 });
    this.cover(t, rnd, (x, z, r) => ok(x, z, r) && this.y(t, x, z) < 0.12, Math.round(110 * density), ['grass0', 'grass1', 'grassDry'], [0.6, 1.0], '#d6e0b4');
  }

  /** Trees whose canopy would overlap a newly placed building gently shrink away. */
  clearAround(x: number, z: number, radius: number, animator: Tweener) {
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3();
    for (const tree of this.trees) {
      const d = Math.hypot(tree.x - x, tree.z - z);
      const canopy = 0.15 * tree.scale;
      if (d > radius + canopy || tree.cleared) continue;
      tree.cleared = true;
      const q = new THREE.Quaternion().setFromAxisAngle(UP, tree.rot);
      const pos = new THREE.Vector3(tree.x, tree.y - 0.004, tree.z);
      animator.tween({
        duration: 0.6,
        update: (t) => {
          // (A tree regrown meanwhile, the building taken back, is left alone.)
          if (!tree.cleared) return;
          m.compose(pos, q, s.setScalar(Math.max(0.0001, tree.scale * (1 - t))));
          this.setTreeMatrix(tree, m);
        },
      });
    }
  }

  /**
   * A building taken back: the trees it cleared grow again (unless another building still
   * stands too close to them, or a felled one is regrowing by itself).
   */
  regrowAround(x: number, z: number, radius: number, others: Site[], animator: Tweener) {
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3();
    for (const tree of this.trees) {
      const canopy = 0.15 * tree.scale;
      if (!tree.cleared || Math.hypot(tree.x - x, tree.z - z) > radius + canopy) continue;
      if (others.some((o) => Math.hypot(tree.x - o.x, tree.z - o.z) <= o.clear + canopy)) continue;
      tree.cleared = false;
      if (tree.felled) continue;
      const q = new THREE.Quaternion().setFromAxisAngle(UP, tree.rot);
      const pos = new THREE.Vector3(tree.x, tree.y - 0.004, tree.z);
      animator.tween({
        delay: 0.15 + Math.random() * 0.25,
        duration: 1.1,
        easing: ease.outBack,
        update: (t) => {
          if (tree.cleared || tree.felled) return;
          m.compose(pos, q, s.setScalar(Math.max(0.0001, tree.scale * t)));
          this.setTreeMatrix(tree, m);
        },
      });
    }
  }

  /** The ground cover batches a building treads down. */
  private *trodden() {
    for (const [key, b] of this.batches.batches) if (/^(grass|flowers|fern|mushrooms)/.test(key) && b.mesh) yield b;
  }

  /**
   * Ground cover round a new building is trodden down: grass, flowers and ferns vanish close
   * in and are cut shorter towards the edge, so the worn earth under them shows.
   */
  trample(x: number, z: number, radius: number, animator: Tweener) {
    this.retread(x, z, radius, (it) => {
      const d = Math.hypot(it.orig!.elements[12] - x, it.orig!.elements[14] - z) / radius;
      return trampleKeep(d) * this.keepOf(it);
    }, animator, 0.5);
  }

  /**
   * A building taken back: the ground cover it trod down springs up again, as far as the
   * buildings still standing (`others`) allow.
   */
  untrample(x: number, z: number, radius: number, others: Site[], animator: Tweener) {
    this.retread(x, z, radius, (it) => {
      const e = it.orig!.elements;
      let keep = 1;
      for (const o of others) keep *= trampleKeep(Math.hypot(e[12] - o.x, e[14] - o.z) / o.trample);
      return keep;
    }, animator, 0.9);
  }

  /** How much of its height an item has kept (1 = as it grew). */
  private keepOf(it: InstanceSpec) {
    const o = it.orig!;
    _s1.setFromMatrixColumn(o, 1);
    _s2.setFromMatrixColumn(it.matrix, 1);
    return Math.sqrt(_s2.length() / Math.max(1e-6, _s1.length()));
  }

  /**
   * Every item within `radius` of (x, z) eases to a new height: `keep` of its full size (its
   * width by `keep`, its height by `keep` squared). One tween moves them all.
   */
  private retread(x: number, z: number, radius: number, keep: (it: InstanceSpec) => number, animator: Tweener, duration: number) {
    const jobs: { mesh: THREE.InstancedMesh; i: number; p: THREE.Vector3; q: THREE.Quaternion; from: THREE.Vector3; to: THREE.Vector3 }[] = [];
    const meshes = new Set<THREE.InstancedMesh>();
    for (const b of this.trodden()) {
      const mesh = b.mesh!;
      b.items.forEach((it, i) => {
        it.orig ??= it.matrix.clone();
        const e = it.orig.elements;
        if (Math.hypot(e[12] - x, e[14] - z) >= radius) return;
        const k = keep(it);
        // Each item its own position, rotation and scales.
        const p = new THREE.Vector3(), q = new THREE.Quaternion(), full = new THREE.Vector3(), from = new THREE.Vector3();
        it.orig.decompose(p, q, full);
        it.matrix.decompose(_p, _q, from);
        const to = full.clone().multiply(_s1.set(Math.max(k, 0.001), Math.max(k * k, 0.001), Math.max(k, 0.001)));
        if (to.distanceToSquared(from) < 1e-12) return;
        jobs.push({ mesh, i, p, q, from, to });
        meshes.add(mesh);
        it.matrix = new THREE.Matrix4().compose(p, q, to);
      });
    }
    if (!jobs.length) return;
    const m = new THREE.Matrix4(), sc = new THREE.Vector3();
    animator.tween({
      duration,
      update: (t) => {
        for (const j of jobs) j.mesh.setMatrixAt(j.i, m.compose(j.p, j.q, sc.copy(j.from).lerp(j.to, t)));
        for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
      },
    });
  }

  /** Set a tree's instance matrix (a zero scale hides a felled tree until it regrows). */
  setTreeMatrix(tree: (typeof this.trees)[number], m: THREE.Matrix4) {
    const mesh = this.batches.get(tree.batch).mesh;
    if (!mesh) return;
    mesh.setMatrixAt(tree.index, m);
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const b of this.batches.batches.values()) (b.material as THREE.Material).dispose?.();
    this.batches.dispose();
    release(this.group);
    this.group.clear();
  }
}
