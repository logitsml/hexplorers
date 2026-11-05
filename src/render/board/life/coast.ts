// The coastline: sandy coves at the foot of some sea cliffs, spray bursting against the
// rocks on the others, and a few seals basking on the sand who lift their heads
// and look around now and then.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose, smoothSphere } from '../geom';
import { tilePropMaterial, beachMaterial } from '../materials';
import { SEA_LEVEL } from '../layout';
import { CORNER_OFFSETS } from '../../../engine/board';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import type { LifeContext, LifeModule } from './common';
import { release } from '../release';
import { waterBurst } from '../../fx/particles';
import { isBeachSide } from '../terrain';

/** A seal's scale: half again a person's height long, hauled out (see pasture.ts on sizes). */
const SEAL_SCALE = 0.75;

const C = (h: string) => new THREE.Color(h);

/** A crescent of sand along one sea side, from the cliff foot down under the water. */
function makeBeach(ax: number, az: number, bx: number, bz: number, rnd: Rand): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const U = 22;
  const K = [0.99, 1.04, 1.1, 1.17, 1.25, 1.33];
  const dry = C('#e3d09e'), damp = C('#c9b07c'), wet = C('#a68e62');
  const rows: number[][] = [];
  const bulge = rnd.range(0.06, 0.12);
  const c = new THREE.Color();
  for (let i = 0; i <= U; i++) {
    const u = 0.04 + (i / U) * 0.92;
    const taper = Math.sin(((u - 0.04) / 0.92) * Math.PI);
    const row: number[] = [];
    K.forEach((k0, j) => {
      const k = 1 + (k0 - 1) * (0.35 + 0.65 * taper) + (j > 0 ? bulge * taper * (j / (K.length - 1)) : 0);
      const x = (ax + (bx - ax) * u) * k;
      const z = (az + (bz - az) * u) * k;
      const t = j / (K.length - 1);
      const y = SEA_LEVEL + 0.07 - t * 0.2 - (1 - taper) * 0.05 + Math.sin(u * 37 + j) * 0.004;
      c.copy(dry).lerp(damp, Math.min(1, t * 1.6)).lerp(wet, Math.max(0, t * 2 - 0.9));
      if (Math.sin(u * 120 + j * 7) > 0.92) c.multiplyScalar(0.85);
      row.push(b.vertex(x, y, z, c.clone()));
    });
    rows.push(row);
  }
  for (let i = 0; i < U; i++)
    for (let j = 0; j < K.length - 1; j++) b.quad(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]);
  // Pebbles and a shell or two along the tideline.
  for (let n = 0; n < 9; n++) {
    const u = rnd.range(0.15, 0.85), k = rnd.range(1.08, 1.16);
    const p = smoothSphere(rnd.range(0.008, 0.016), 1);
    p.scale(1, 0.55, 0.8);
    const shell = rnd.chance(0.25);
    b.addGeometry(p, compose((ax + (bx - ax) * u) * k, SEA_LEVEL + 0.035 - (k - 1) * 0.5, (az + (bz - az) * u) * k, 0, rnd.range(0, 6), 0), shell ? C('#f4e6d4') : C(rnd.chance(0.5) ? '#8d8478' : '#6f675e'));
    p.dispose();
  }
  return b.build(true);
}

function makeSeal(): { body: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const grey = C('#6e6862'), belly = C('#a59c8f');
  const body = smoothSphere(0.03, 2);
  body.scale(2.1, 0.75, 0.95);
  b.addGeometry(body, compose(0, 0.02, 0), (_x, y, _z, o) => o.copy(y < 0.014 ? belly : grey).lerp(C('#57514c'), Math.max(0, Math.sin(_x * 300) * 0.15)));
  body.dispose();
  // Tail flippers fanned at the back, fore flippers at the sides.
  for (const s of [-1, 1]) {
    const tf = smoothSphere(0.012, 1);
    tf.scale(1.6, 0.25, 0.9);
    b.addGeometry(tf, compose(-0.07, 0.008, s * 0.012, 0, s * 0.5, 0), C('#4f4a45'));
    tf.dispose();
    const ff = smoothSphere(0.01, 1);
    ff.scale(1.7, 0.3, 0.8);
    b.addGeometry(ff, compose(0.02, 0.006, s * 0.03, 0, s * -0.7, 0), C('#5a544e'));
    ff.dispose();
  }
  const h = new MeshBuilder();
  const head = smoothSphere(0.019, 2);
  head.scale(1.2, 1, 1);
  h.addGeometry(head, compose(0.012, 0, 0), grey);
  head.dispose();
  const snout = smoothSphere(0.01, 1);
  h.addGeometry(snout, compose(0.03, -0.004, 0), C('#7b746c'));
  snout.dispose();
  const nose = smoothSphere(0.0035, 1);
  h.addGeometry(nose, compose(0.039, -0.002, 0), C('#1b1715'));
  nose.dispose();
  for (const s of [-1, 1]) {
    const eye = smoothSphere(0.0032, 1);
    h.addGeometry(eye, compose(0.022, 0.006, s * 0.011), C('#0d0a09'));
    eye.dispose();
  }
  return { body: b.build(false), head: h.build(false) };
}

interface Seal {
  tile: TileInfo;
  root: THREE.Object3D;
  head: THREE.Object3D;
  phase: number;
  look: number;
  next: number;
}

interface Cliff {
  tile: TileInfo;
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export class CoastLife implements LifeModule {
  private beaches: { tile: TileInfo; side: number }[] = [];
  private cliffs: Cliff[] = [];
  private seals: Seal[] = [];
  private sprayTimer = 1;
  private disposables: { dispose(): void }[] = [];

  constructor(private ctx: LifeContext) {}

  plan(tiles: TileInfo[]): Reserved {
    for (const t of tiles) {
      for (let side = 0; side < 6; side++) {
        if (t.shape.ctx.landSide[side]) continue;
        const [ax, az] = CORNER_OFFSETS[side];
        const [bx, bz] = CORNER_OFFSETS[(side + 1) % 6];
        if (isBeachSide(t.shape.seed, side)) this.beaches.push({ tile: t, side });
        else this.cliffs.push({ tile: t, ax, az, bx, bz });
      }
    }
    return [];
  }

  build() {
    const { effects, group } = this.ctx;
    // Every strip of sand on the coast is one mesh (a draw, rather than one per beach): each
    // strip moved onto its tile and tagged with it, for its rise (see beachMaterial). Until
    // then each stands alone, for the seals to be set down on.
    const beachMeshes = new Map<string, THREE.Mesh>();
    const strips: THREE.BufferGeometry[] = [];
    for (const bch of this.beaches) {
      const t = bch.tile;
      const [ax, az] = CORNER_OFFSETS[bch.side];
      const [bx, bz] = CORNER_OFFSETS[(bch.side + 1) % 6];
      const rnd = new Rand(t.shape.seed * 7 + bch.side);
      const geo = makeBeach(ax, az, bx, bz, rnd);
      geo.translate(t.hex.x, 0, t.hex.z);
      geo.setAttribute('tile', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count).fill(t.hex.id), 1));
      strips.push(geo);
      const m = new THREE.Mesh(geo);
      m.updateMatrixWorld();
      beachMeshes.set(`${t.hex.id}-${bch.side}`, m);
    }
    // A few seals hauled out on the sand.
    const seal = makeSeal();
    this.disposables.push(seal.body, seal.head);
    const count = Math.min(this.beaches.length, 3);
    for (let i = 0; i < count; i++) {
      const bch = this.beaches[(i * 5) % this.beaches.length];
      const t = bch.tile;
      const rnd = new Rand(t.shape.seed + i * 13);
      const [ax, az] = CORNER_OFFSETS[bch.side];
      const [bx, bz] = CORNER_OFFSETS[(bch.side + 1) % 6];
      const u = rnd.range(0.3, 0.7), k = 1.09;
      const x = (ax + (bx - ax) * u) * k, z = (az + (bz - az) * u) * k;
      const mat = tilePropMaterial(effects, t.hex.id, { roughness: 0.45 });
      this.disposables.push(mat);
      const root = new THREE.Group();
      // Rest on the sand itself (the beach slopes, so sample it).
      const ray = new THREE.Raycaster(new THREE.Vector3(t.hex.x + x, 1, t.hex.z + z), new THREE.Vector3(0, -1, 0));
      const hit = beachMeshes.get(`${t.hex.id}-${bch.side}`);
      const y = hit ? (ray.intersectObject(hit)[0]?.point.y ?? SEA_LEVEL + 0.01) : SEA_LEVEL + 0.01;
      root.position.set(t.hex.x + x, y - 0.004, t.hex.z + z);
      root.rotation.y = -Math.atan2(bz - az, bx - ax) + (rnd.chance(0.5) ? 0 : Math.PI) + rnd.range(-0.3, 0.3);
      root.scale.setScalar(SEAL_SCALE);
      const body = this.ctx.props.mesh(seal.body, mat);
      body.castShadow = true;
      const head = new THREE.Group();
      head.position.set(0.055, 0.03, 0);
      head.add(this.ctx.props.mesh(seal.head, mat));
      root.add(body, head);
      group.add(root);
      this.seals.push({ tile: t, root, head, phase: rnd.range(0, 6), look: 0, next: rnd.range(2, 8) });
    }
    if (strips.length) {
      const merged = mergeGeometries(strips)!;
      strips.forEach((g) => g.dispose());
      merged.computeBoundingSphere();
      this.disposables.push(merged);
      const sand = new THREE.Mesh(merged, beachMaterial(effects));
      sand.name = 'beach';
      sand.receiveShadow = true;
      group.add(sand);
    }
  }

  update(dt: number, t: number) {
    for (const s of this.seals) {
      // Mostly dozing with the head down; every so often it lifts and looks around.
      s.next -= dt;
      if (s.next <= 0) {
        s.look = s.look > 0 ? 0 : 1;
        s.next = s.look ? 2.5 + Math.random() * 3 : 5 + Math.random() * 9;
      }
      const lift = s.head.userData.lift ?? 0;
      const goal = s.look;
      const v = lift + (goal - lift) * Math.min(1, dt * 3);
      s.head.userData.lift = v;
      s.head.rotation.z = -0.35 + v * 0.75;
      s.head.rotation.y = v * Math.sin(t * 0.9 + s.phase) * 0.6;
      s.root.scale.y = SEAL_SCALE * (1 + Math.sin(t * 1.6 + s.phase) * 0.02);
      s.root.visible = (this.ctx.effects.riseValues[s.tile.hex.id] ?? 0) > -0.05;
    }
    // Waves bursting against a sea cliff now and then.
    this.sprayTimer -= dt;
    if (this.sprayTimer <= 0 && this.cliffs.length) {
      this.sprayTimer = 0.7 + Math.random() * 1.6;
      const c = this.cliffs[Math.floor(Math.random() * this.cliffs.length)];
      if ((this.ctx.effects.riseValues[c.tile.hex.id] ?? 0) < -0.05) return;
      const u = 0.15 + Math.random() * 0.7;
      const k = 1.02;
      const x = c.tile.hex.x + (c.ax + (c.bx - c.ax) * u) * k;
      const z = c.tile.hex.z + (c.az + (c.bz - c.az) * u) * k;
      const ox = c.ax + c.bx, oz = c.az + c.bz;
      const ol = Math.hypot(ox, oz) || 1;
      waterBurst(this.ctx.particles.spray, this.ctx.particles.mist, { x, y: SEA_LEVEL + 0.02, z, count: 22, radius: 0.07, up: [0.45, 1.0], out: [0.08, 0.22], push: [ox / ol, oz / ol], size: 0.032 });
    }
  }

  produce() {}

  dispose() {
    // (Everything the island's life put on the board goes with it: see release.)
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.seals = [];
    this.beaches = [];
    this.cliffs = [];
  }
}
