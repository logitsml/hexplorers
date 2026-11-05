// Bounty field: a gold working. A log dam holds back the pond, which feeds a long timber flume
// carried high on trestles round the field to its tail, where the washed gravel spills onto the
// pale tailings. Over a shaft on a knoll's shoulder stands the working's landmark, a headframe of
// raw pine whose wheel turns as the kibble comes up and goes back down. A prospector kneels at the
// pond's edge swirling a pan, another breaks gravel from the heaps with a pick, and a ridge tent
// with a lantern inside and a campfire stand nearby. Gold glints in the gravel. On production the
// flume runs in spate, the hoist hurries, the pick swings hard, and the pan comes up flashing gold.

import * as THREE from 'three/webgpu';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose, smoothSphere } from '../geom';
import { SURFACE } from '../surfaces';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import { shelter, type LifeContext, type LifeModule } from './common';
import { release } from '../release';
import type { Lamp } from '../../fx/lampLights';
import { makeArm, makeFolk, rod, shoulder, type FolkLook, FOLK_SCALE } from './folk';
import { FIRE, Parts, clearOfPieces, fireMaterial, stillProps, stokeFire } from './props';
import { PROSPECTOR_TENT, buildTent } from './tent';

const C = (h: string) => new THREE.Color(h);
/** Props are modelled at the classic modules' scale, like the miner and the kiln. */
const S = FOLK_SCALE;
const PANNER: FolkLook = { coat: '#6d7a8c', legs: '#4a3f33', hat: 'brim', hatColor: '#6b5236', kneel: true };
const DIGGER: FolkLook = { coat: '#9a5a3c', legs: '#3e3a44', hat: 'brim', hatColor: '#4f4033' };
/** The headframe's height to its platform, and its sheave wheel's radius. */
const FRAME_H = 0.25;
const WHEEL_R = 0.034;
/** The axle stands this far forward of the shaft, so the rope off the wheel's back drops straight down it. */
const AXLE = WHEEL_R * 0.9;

/** The headframe's sheave wheel, facing +x, turning about z: an iron rim and hub, six spokes. */
function makeSheave(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const iron = C('#3d3a38');
  const rim = new THREE.TorusGeometry(WHEEL_R, 0.003, 6, 22);
  b.addGeometry(rim, compose(0, 0, 0), iron);
  rim.dispose();
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.BoxGeometry(WHEEL_R * 2, 0.0024, 0.0024);
    b.addGeometry(spoke, compose(0, 0, 0, 0, 0, (i * Math.PI) / 3), iron);
    spoke.dispose();
  }
  const hub = new THREE.CylinderGeometry(0.005, 0.005, 0.03, 8);
  b.addGeometry(hub, compose(0, 0, 0, Math.PI / 2, 0, 0), C('#2a2826'));
  hub.dispose();
  return b.build(false);
}

/** The kibble on the hoist rope: an iron bucket and its bail, the rope running up from it. */
function makeKibble(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const bucket = new THREE.CylinderGeometry(0.011, 0.009, 0.018, 8);
  b.addGeometry(bucket, compose(0, 0.009, 0), C('#4a4440'));
  bucket.dispose();
  for (const sd of [-1, 1]) rod(b, new THREE.Vector3(sd * 0.01, 0.017, 0), new THREE.Vector3(0, 0.03, 0), 0.0008, C('#55504c'));
  return b.build(false);
}

interface Working {
  tile: TileInfo;
  root: THREE.Group;
  panArm: THREE.Object3D;
  pickArm: THREE.Object3D;
  fire: THREE.Mesh;
  glow: Lamp;
  /** The figures (bodies and moving arms), the tent's lantern and its light, put out on a destroyed hex. */
  crew: THREE.Object3D[];
  lantern: THREE.Mesh | null;
  lanternGlow: Lamp | null;
  /** The headframe's wheel (turning about z) and the kibble it hoists (rising and falling), if it has one. */
  sheave: THREE.Object3D | null;
  kibble: THREE.Object3D | null;
  /** The kibble's depth below the wheel, and its trip: 0..1 up, a pause, 1..0 down, a pause. */
  hoist: number;
  /** Local points: the sluice's tail (where its water spills), the fire, the pan, the heap being worked. */
  tail: THREE.Vector3;
  smokeAt: THREE.Vector3;
  pan: THREE.Vector3;
  heap: THREE.Vector3;
  spate: number;
  swing: number;
  lift: number;
  smokeTimer: number;
  spillTimer: number;
  glintTimer: number;
  rnd: Rand;
}

export class BountyLife implements LifeModule {
  /** How far the workers here have downed tools for the rain (see common.ts shelter). */
  private rest = 0;
  private tiles: TileInfo[] = [];
  private works: Working[] = [];
  private spots = new Map<number, { tent: { x: number; z: number; a: number }; dig: { x: number; z: number; a: number }; pan: { x: number; z: number; a: number } }>();
  /** Each field's headframe over its shaft (facing the clearing), where it has room for one. */
  private frames = new Map<number, { x: number; z: number; a: number }>();
  private disposables: { dispose(): void }[] = [];
  private parts: Parts;
  /** Where each tent's lantern hangs (tile-local), set as the tent is built. */
  private lanterns = new Map<number, THREE.Vector3>();

  constructor(private ctx: LifeContext) {
    this.parts = new Parts(ctx.effects, ctx.props);
  }

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'bounty');
    const res: Reserved = [];
    for (const t of this.tiles) {
      const s = t.shape.features.sites!;
      const pond = s.pond, tail = s.tail;
      // The sluice and its trestles, the dam, the pond's edge where the panner kneels.
      for (let i = 0; i <= 4; i++) {
        const u = i / 4;
        res.push({ hex: t.hex.id, x: pond.x + (tail.x - pond.x) * u, z: pond.z + (tail.z - pond.z) * u, r: 0.09 });
      }
      res.push({ hex: t.hex.id, x: pond.x, z: pond.z, r: pond.r! + 0.04 });
      // The panner kneels on the far side of the pond from the sluice, facing the water.
      const pa = Math.atan2(pond.z - tail.z, pond.x - tail.x) + 0.5;
      const pan = { x: pond.x + Math.cos(pa) * (pond.r! + 0.03), z: pond.z + Math.sin(pa) * (pond.r! + 0.03), a: pa + Math.PI };
      // The digger works the first spoil heap from its inner side.
      const h0 = s.heap0;
      const da = Math.atan2(h0.z, h0.x) + Math.PI;
      const dig = { x: h0.x + Math.cos(da) * (h0.r! + 0.02), z: h0.z + Math.sin(da) * (h0.r! + 0.02), a: da + Math.PI };
      // The tent pitches on the other side of the pond, towards the clearing.
      const sa = Math.atan2(pond.z, pond.x);
      const side = Math.sign(Math.sin(Math.atan2(tail.z, tail.x) - sa)) || 1;
      let tent = { x: Math.cos(sa - side * 0.95) * 0.5, z: Math.sin(sa - side * 0.95) * 0.5, a: sa - side * 0.95 };
      for (let k = 0; k < 8 && !(t.shape.canPlace(tent.x, tent.z, 0.12) && clearOfPieces(this.ctx.anchors, t.hex.id, tent.x, tent.z, 0.1)); k++) {
        const a = sa - side * (0.95 + k * 0.15);
        tent = { x: Math.cos(a) * 0.5, z: Math.sin(a) * 0.5, a };
      }
      this.spots.set(t.hex.id, { tent, dig, pan });
      const fr = this.frame(t);
      if (fr) {
        this.frames.set(t.hex.id, fr);
        res.push({ hex: t.hex.id, x: fr.x, z: fr.z, r: 0.13 });
      }
      res.push({ hex: t.hex.id, x: tent.x, z: tent.z, r: 0.17 }, { hex: t.hex.id, x: pan.x, z: pan.z, r: 0.04 }, { hex: t.hex.id, x: dig.x, z: dig.z, r: 0.05 });
    }
    return res;
  }

  build() {
    const { effects, group } = this.ctx;
    const panGeo = makeArm('pan', PANNER.coat);
    const pickGeo = makeArm('pick', DIGGER.coat);
    const fireGeo = new THREE.ConeGeometry(0.012, 0.032, 7);
    fireGeo.translate(0, 0.016, 0);
    // The tent's lantern: a small glowing box, burning in the campfire's material.
    const lanternGeo = new THREE.BoxGeometry(0.008, 0.011, 0.008);
    const sheaveGeo = makeSheave();
    const kibbleGeo = makeKibble();
    const panBody = makeFolk(PANNER), digBody = makeFolk(DIGGER);
    this.disposables.push(panGeo, pickGeo, fireGeo, lanternGeo, sheaveGeo, kibbleGeo, panBody, digBody);
    // Every bounty field's still props in one mesh.
    const still = this.tiles.map((t) => ({ geo: this.buildStatic(t), hex: t.hex }));
    const mesh = stillProps(effects, still, this.disposables);
    still.forEach((p) => p.geo.dispose());
    if (mesh) group.add(mesh);
    for (const t of this.tiles) {
      const root = new THREE.Group();
      root.position.set(t.hex.x, 0, t.hex.z);
      group.add(root);
      const sp = this.spots.get(t.hex.id)!;
      // The panner's arm swirls the pan; the digger's swings the pick. (Too small to cast a
      // shadow worth its draw.)
      // (Each figure's body hangs on the same pivot as its arm, so a destroyed hex can put both out.)
      const crew: THREE.Object3D[] = [];
      const armAt = (p: { x: number; z: number; a: number }, look: FolkLook, geo: THREE.BufferGeometry, body: THREE.BufferGeometry) => {
        const pivot = new THREE.Group();
        pivot.position.set(p.x, t.shape.height(p.x, p.z) - 0.002, p.z);
        pivot.rotation.y = -p.a;
        pivot.scale.setScalar(S);
        const arm = new THREE.Group();
        arm.position.copy(shoulder(look));
        pivot.add(arm);
        root.add(pivot);
        this.parts.add(body, pivot, t.hex.id);
        this.parts.add(geo, arm, t.hex.id);
        crew.push(pivot);
        return arm;
      };
      const panArm = armAt(sp.pan, PANNER, panGeo, panBody);
      const pickArm = armAt(sp.dig, DIGGER, pickGeo, digBody);
      // The lantern in the tent, and its light.
      const lp = this.lanterns.get(t.hex.id);
      let lantern: THREE.Mesh | null = null, lanternGlow: Lamp | null = null;
      if (lp) {
        lantern = new THREE.Mesh(lanternGeo, fireMaterial(effects));
        lantern.position.copy(lp);
        root.add(lantern);
        lanternGlow = this.ctx.lamps.add(root, { x: lp.x, y: lp.y, z: lp.z }, { color: FIRE, distance: 0.22, strength: 0.18 });
      }
      // The headframe's wheel and the kibble hanging under its back edge, over the shaft.
      const fr = this.frames.get(t.hex.id);
      let sheave: THREE.Object3D | null = null, kibble: THREE.Object3D | null = null;
      if (fr) {
        const fy = t.shape.height(fr.x, fr.z);
        const axle = new THREE.Group();
        axle.position.set(fr.x + Math.cos(fr.a) * AXLE, fy + FRAME_H + WHEEL_R + 0.008, fr.z + Math.sin(fr.a) * AXLE);
        axle.rotation.y = -fr.a;
        root.add(axle);
        sheave = new THREE.Group();
        axle.add(sheave);
        this.parts.add(sheaveGeo, sheave, t.hex.id);
        kibble = new THREE.Group();
        kibble.position.set(-AXLE, -0.2, 0);
        axle.add(kibble);
        this.parts.add(kibbleGeo, kibble, t.hex.id);
      }
      // The campfire before the tent: a flame that flickers, a lamp at night, a wisp of smoke.
      const fx = sp.tent.x - Math.cos(sp.tent.a) * 0.13, fz = sp.tent.z - Math.sin(sp.tent.a) * 0.13;
      const fy = t.shape.height(fx, fz);
      const fire = new THREE.Mesh(fireGeo, fireMaterial(effects));
      fire.position.set(fx, fy + 0.004, fz);
      root.add(fire);
      const glow = this.ctx.lamps.add(root, { x: fx, y: fy + 0.03, z: fz }, { color: FIRE, distance: 0.4, strength: 0.32 });
      const s = t.shape.features.sites!;
      const tail = new THREE.Vector3(s.tail.x, t.shape.height(s.tail.x, s.tail.z) + 0.012, s.tail.z);
      const pan = new THREE.Vector3(sp.pan.x + Math.cos(sp.pan.a) * 0.02, t.shape.height(sp.pan.x, sp.pan.z) + 0.02, sp.pan.z + Math.sin(sp.pan.a) * 0.02);
      const heap = new THREE.Vector3(s.heap0.x, t.shape.height(s.heap0.x, s.heap0.z) + 0.02, s.heap0.z);
      this.works.push({
        tile: t, root, panArm, pickArm, fire, glow, tail, pan, heap, crew, lantern, lanternGlow, sheave, kibble, hoist: t.hex.id * 0.37,
        smokeAt: new THREE.Vector3(fx, fy + 0.03, fz),
        spate: 0, swing: 0, lift: 0, smokeTimer: Math.random(), spillTimer: 0, glintTimer: Math.random(),
        rnd: new Rand(t.shape.seed * 3 + 1),
      });
    }
  }

  /**
   * Where the headframe stands over its shaft: on the inner shoulder of a knoll, the furthest back
   * that has room (so from the table it rises behind the disc rather than in front of it), facing
   * the clearing; failing a knoll, anywhere at the back with room. Null if nowhere fits.
   */
  private frame(t: TileInfo) {
    const fits = (x: number, z: number) => t.shape.canPlace(x, z, 0.075) && clearOfPieces(this.ctx.anchors, t.hex.id, x, z, 0.07) && t.shape.features.water!.depth(x, z) < -0.01;
    const knolls = [...t.shape.features.peaks].sort((p, q) => p.z - q.z);
    for (const k of knolls) {
      const r = Math.hypot(k.x, k.z);
      for (const f of [0.1, 0.06, 0.14]) {
        const x = k.x * (1 - f / r), z = k.z * (1 - f / r);
        if (fits(x, z)) return { x, z, a: Math.atan2(-z, -x) };
      }
    }
    for (let i = 0; i < 24; i++) {
      const a = -Math.PI / 2 + (i % 2 ? 1 : -1) * Math.floor((i + 1) / 2) * 0.26;
      for (const r of [0.55, 0.5, 0.6]) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (fits(x, z)) return { x, z, a: a + Math.PI };
      }
    }
    return null;
  }

  /** Everything that keeps still, for one tile, in one mesh (tile-local x and z, world y). */
  private buildStatic(t: TileInfo): THREE.BufferGeometry {
    const b = new MeshBuilder();
    const h = (x: number, z: number) => t.shape.height(x, z);
    const s = t.shape.features.sites!;
    const level = t.shape.features.water!.level;
    const pond = s.pond, tail = s.tail;
    const timber = C('#5e4128'), timberLight = C('#7a5a3a'), wet = C('#4a3a2a'), water = C('#5e8ea6');
    const dir = new THREE.Vector3(tail.x - pond.x, 0, tail.z - pond.z).normalize();
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    // The dam: logs laid across the pond's outflow.
    const head = new THREE.Vector3(pond.x, 0, pond.z).addScaledVector(dir, pond.r! - 0.005);
    for (let i = 0; i < 3; i++) {
      const y = level + 0.006 + i * 0.014;
      const c = new THREE.Vector3(head.x, y, head.z).addScaledVector(dir, -i * 0.002);
      rod(b, c.clone().addScaledVector(across, -0.075), c.clone().addScaledVector(across, 0.075), 0.009, i === 0 ? wet : timber);
    }
    // The flume: a long timber trough carried high on trestles from the dam to the tail, falling
    // gently all the way, with riffle bars across its floor and a bright run of water in it. (Tall
    // and long enough to read from the table as the working's spine.)
    b.surfaceId = SURFACE.planks;
    const a = new THREE.Vector3(head.x, level + 0.06, head.z);
    const end = new THREE.Vector3(tail.x, Math.max(h(tail.x, tail.z) + 0.05, level + 0.03), tail.z);
    const W = 0.034;
    rod(b, a, end, 0.074, timberLight, 0.005, 'flat');
    for (const sd of [-1, 1]) {
      const off = across.clone().multiplyScalar(sd * W);
      rod(b, a.clone().add(off).setY(a.y + 0.014), end.clone().add(off).setY(end.y + 0.014), 0.006, timber, 0.03, 'flat');
    }
    b.surfaceId = 0;
    const len = a.distanceTo(end);
    for (let k = 1; k < Math.floor(len / 0.06); k++) {
      const p = a.clone().lerp(end, (k * 0.06) / len);
      rod(b, p.clone().addScaledVector(across, -W).setY(p.y + 0.005), p.clone().addScaledVector(across, W).setY(p.y + 0.005), 0.0026, wet);
    }
    rod(b, a.clone().setY(a.y + 0.006), end.clone().setY(end.y + 0.006), 0.06, water, 0.001, 'flat');
    // Trestles: splayed legs to the ground, a cap under the trough and a cross-brace, every so often.
    const steps = Math.max(3, Math.round(len / 0.11));
    for (let k = 1; k <= steps; k++) {
      const p = a.clone().lerp(end, (k - 0.5) / steps);
      const g = h(p.x, p.z) - 0.004;
      const capY = p.y - 0.004;
      rod(b, p.clone().addScaledVector(across, -W * 1.5).setY(capY), p.clone().addScaledVector(across, W * 1.5).setY(capY), 0.005, timber, 0.005);
      for (const sd of [-1, 1]) {
        const top = p.clone().addScaledVector(across, sd * W * 1.2).setY(capY);
        const foot = p.clone().addScaledVector(across, sd * W * 2.1).setY(g);
        rod(b, top, foot, 0.0042, timber, 0.0042);
      }
      if (capY - g > 0.03) {
        const m1 = p.clone().addScaledVector(across, -W * 1.95).setY(g + 0.006), m2 = p.clone().addScaledVector(across, W * 1.3).setY(capY - 0.006);
        rod(b, m1, m2, 0.0022, timber, 0.0022);
      }
    }
    // A barrow by the spoil, and a shovel left standing in the heap.
    const h1 = s.heap1 ?? s.heap0;
    const bx = h1.x + Math.cos(Math.atan2(h1.z, h1.x) + Math.PI) * (h1.r! + 0.05), bz = h1.z + Math.sin(Math.atan2(h1.z, h1.x) + Math.PI) * (h1.r! + 0.05);
    const by = h(bx, bz), ba = Math.atan2(h1.z, h1.x) + 1.4;
    const tray = new THREE.BoxGeometry(0.055, 0.02, 0.036);
    b.addGeometry(tray, compose(bx, by + 0.028, bz, 0, -ba, 0.12), timberLight);
    tray.dispose();
    const wheel = new THREE.CylinderGeometry(0.014, 0.014, 0.006, 12);
    b.addGeometry(wheel, compose(bx + Math.cos(ba) * 0.032, by + 0.014, bz + Math.sin(ba) * 0.032, Math.PI / 2, -ba, 0), C('#3f3a36'));
    wheel.dispose();
    for (const sd of [-1, 1]) {
      const o = new THREE.Vector3(-Math.sin(ba), 0, Math.cos(ba)).multiplyScalar(sd * 0.014);
      rod(b, new THREE.Vector3(bx + o.x, by + 0.028, bz + o.z), new THREE.Vector3(bx - Math.cos(ba) * 0.07 + o.x, by + 0.034, bz - Math.sin(ba) * 0.07 + o.z), 0.0025, timber, 0.0025);
    }
    const hs = s.heap2 ?? s.heap0;
    const sy = h(hs.x, hs.z);
    rod(b, new THREE.Vector3(hs.x, sy - 0.008, hs.z), new THREE.Vector3(hs.x + 0.012, sy + 0.08, hs.z + 0.006), 0.0022, timber, 0.0022);
    const blade = new THREE.BoxGeometry(0.018, 0.022, 0.002);
    b.addGeometry(blade, compose(hs.x, sy, hs.z, 0, 0.6, 0.15), C('#5a5550'));
    blade.dispose();
    // The tent: a prospector's ridge tent, its door turned to the fire (see tent.ts).
    const sp = this.spots.get(t.hex.id)!;
    const tx = sp.tent.x, tz = sp.tent.z;
    this.lanterns.set(t.hex.id, buildTent(b, tx, tz, sp.tent.a + Math.PI, h, PROSPECTOR_TENT));
    const ridge = new THREE.Vector3(Math.cos(sp.tent.a), 0, Math.sin(sp.tent.a));
    // The fire's ring of stones and its logs, and a pot on a tripod.
    const fx = tx - ridge.x * 0.13, fz = tz - ridge.z * 0.13, fy = h(fx, fz);
    for (let k = 0; k < 7; k++) {
      const q = (k / 7) * Math.PI * 2;
      const st = smoothSphere(0.007, 0);
      b.addGeometry(st, compose(fx + Math.cos(q) * 0.02, fy + 0.002, fz + Math.sin(q) * 0.02, 0, q, 0, 1, 0.7, 1), C(k % 2 ? '#7d7a76' : '#5d5a56'));
      st.dispose();
    }
    for (let k = 0; k < 3; k++) {
      const q = (k / 3) * Math.PI * 2 + 0.4;
      rod(b, new THREE.Vector3(fx + Math.cos(q) * 0.016, fy + 0.002, fz + Math.sin(q) * 0.016), new THREE.Vector3(fx - Math.cos(q) * 0.003, fy + 0.011, fz - Math.sin(q) * 0.003), 0.003, C('#3a2a1c'));
      rod(b, new THREE.Vector3(fx + Math.cos(q) * 0.026, fy - 0.002, fz + Math.sin(q) * 0.026), new THREE.Vector3(fx, fy + 0.062, fz), 0.0018, timber);
    }
    const pot = smoothSphere(0.009, 1);
    b.addGeometry(pot, compose(fx, fy + 0.044, fz, 0, 0, 0, 1, 0.85, 1), C('#2e2c2a'));
    pot.dispose();
    // The headframe over its shaft: the working's landmark, a tapering tower of raw pine with
    // girts and braces, a platform at its head carrying the sheave wheel (which turns: see
    // build), a backstay raking down to the winding shed, and a collar of logs round the shaft.
    const fr = this.frames.get(t.hex.id);
    if (fr) {
      const fy = h(fr.x, fr.z);
      const fwd = new THREE.Vector3(Math.cos(fr.a), 0, Math.sin(fr.a)), side = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const at = (f: number, sd: number, y: number) => new THREE.Vector3(fr.x, fy + y, fr.z).addScaledVector(fwd, f).addScaledVector(side, sd);
      const pine = C('#d0b38c'), pineDark = C('#a88c6a');
      const H = FRAME_H, base = 0.046, top = 0.022;
      // Four legs, each down to the ground beneath its own foot.
      for (const [f, sd] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const foot = at(f * base, sd * base, 0);
        foot.y = h(foot.x, foot.z) - 0.006;
        rod(b, foot, at(f * top, sd * top, H), 0.0068, pine, 0.0068);
      }
      // Girts round the tower at three heights, and an X brace on each side face.
      const girt = (y: number) => {
        const w = base + (top - base) * (y / H);
        for (const [f0, s0, f1, s1] of [[-1, -1, 1, -1], [-1, 1, 1, 1], [-1, -1, -1, 1], [1, -1, 1, 1]]) rod(b, at(f0 * w, s0 * w, y), at(f1 * w, s1 * w, y), 0.0028, pineDark, 0.0028);
        return w;
      };
      const levels = [0.065, 0.14, 0.205];
      levels.forEach((y) => girt(y));
      for (const sd of [-1, 1]) {
        const w0 = base + (top - base) * (levels[0] / H), w1 = base + (top - base) * (levels[1] / H);
        rod(b, at(-w0, sd * w0, levels[0]), at(w1, sd * w1, levels[1]), 0.002, pineDark, 0.002);
        rod(b, at(w0, sd * w0, levels[0]), at(-w1, sd * w1, levels[1]), 0.002, pineDark, 0.002);
      }
      // The head: a platform and two bearers carrying the wheel's axle.
      const plat = new THREE.BoxGeometry(top * 2.8, 0.006, top * 2.8);
      b.addGeometry(plat, compose(fr.x, fy + H + 0.003, fr.z, 0, -fr.a, 0), pineDark);
      plat.dispose();
      for (const sd of [-1, 1]) rod(b, at(AXLE, sd * 0.012, H), at(AXLE, sd * 0.012, H + WHEEL_R + 0.008), 0.003, pine, 0.003);
      // The hoist rope off the wheel's back, straight down the shaft (the kibble rides it: see build).
      rod(b, at(0, 0, H + WHEEL_R + 0.008), at(0, 0, -0.02), 0.0008, C('#c9b48a'));
      // The backstay: from the head down to the ground towards the shed, which stands that way.
      const stayFoot = at(0.17, 0, 0);
      stayFoot.y = h(stayFoot.x, stayFoot.z) - 0.004;
      for (const sd of [-1, 1]) rod(b, at(top, sd * top, H - 0.01), stayFoot.clone().addScaledVector(side, sd * 0.02), 0.0036, pine, 0.0036);
      // The winding shed: plank walls under a rusty iron roof, beside the stay's foot.
      const shed = at(0.15, 0.075, 0);
      const sy = h(shed.x, shed.z);
      b.surfaceId = SURFACE.planks;
      const walls = new THREE.BoxGeometry(0.075, 0.045, 0.055);
      b.addGeometry(walls, compose(shed.x, sy + 0.0215, shed.z, 0, -fr.a, 0), C('#9a7650'));
      walls.dispose();
      b.surfaceId = 0;
      for (const sd of [-1, 1]) {
        const roof = new THREE.BoxGeometry(0.084, 0.004, 0.036);
        const rp = shed.clone().addScaledVector(side, sd * 0.0145);
        b.addGeometry(roof, compose(rp.x, sy + 0.052, rp.z, sd * 0.5, -fr.a, 0), C('#8a5a3a'));
        roof.dispose();
      }
      const door = new THREE.BoxGeometry(0.004, 0.03, 0.018);
      const dp = shed.clone().addScaledVector(fwd, -0.038);
      b.addGeometry(door, compose(dp.x, sy + 0.015, dp.z, 0, -fr.a, 0), C('#3a2a1c'));
      door.dispose();
      // The hoist rope from the wheel's front to the shed's drum.
      rod(b, at(AXLE * 2, 0, H + WHEEL_R + 0.008), new THREE.Vector3(shed.x, sy + 0.03, shed.z), 0.0009, C('#c9b48a'));
      // The shaft: a dark mouth under the tower in a collar of logs.
      const hole = new THREE.PlaneGeometry(base * 1.6, base * 1.6);
      b.addGeometry(hole, compose(fr.x, fy + 0.003, fr.z, -Math.PI / 2, -fr.a, 0), C('#140f0b'));
      hole.dispose();
      for (const [f0, s0, f1, s1] of [[-1, -1, -1, 1], [1, -1, 1, 1], [-1, -1, 1, -1], [-1, 1, 1, 1]])
        rod(b, at(f0 * base * 0.9, s0 * base * 0.9, 0.005), at(f1 * base * 0.9, s1 * base * 0.9, 0.005), 0.0055, timber);
      // A kibble (an ore bucket) waiting by the shaft, and a heap of fresh pay dirt.
      const kib = new THREE.CylinderGeometry(0.01, 0.008, 0.016, 8);
      const kp = at(-0.03, -0.06, 0);
      b.addGeometry(kib, compose(kp.x, h(kp.x, kp.z) + 0.007, kp.z), C('#4a4440'));
      kib.dispose();
    }
    return b.build(false);
  }

  update(dt: number, t: number) {
    this.rest = shelter(this.rest, this.ctx.effects.rain.value, dt);
    const { effects, particles } = this.ctx;
    const day = 1 - effects.night.value;
    const flame = stokeFire(effects, t);
    for (const w of this.works) {
      const id = w.tile.hex.id;
      const rise = effects.riseValues[id] ?? 0;
      // (On a hex pollution has destroyed the working is abandoned: no one at it, no fire, no lamp.)
      const alive = (effects.scarValues[id] ?? 0) < 0.85;
      const up = rise > -0.05 && alive;
      const blighted = effects.get(id).y > 0.5;
      for (const c of w.crew) c.visible = alive;
      if (w.lantern) w.lantern.visible = up;
      if (w.lanternGlow) w.lanternGlow.gain = up ? flame * 0.8 : 0;
      // The hoist: the kibble comes up the shaft, waits at the head, goes back down and waits below
      // (faster in spate), and the wheel turns with the rope.
      if (w.sheave && w.kibble && alive) {
        const was = w.hoist;
        w.hoist = (w.hoist + dt * (blighted ? 0.03 : 0.07) * (1 + w.spate * 2.5)) % 1;
        const depth = (u: number) => (u < 0.4 ? 1 - u / 0.4 : u < 0.5 ? 0 : u < 0.9 ? (u - 0.5) / 0.4 : 1);
        const d0 = depth(was), d1 = depth(w.hoist);
        w.kibble.position.y = -0.045 - d1 * (FRAME_H + 0.05);
        // (Down the shaft at the bottom of its run.)
        w.kibble.visible = d1 < 0.95;
        w.sheave.rotation.z += ((d1 - d0) * (FRAME_H + 0.05)) / WHEEL_R;
      }
      const pace = blighted ? 0.35 : 1;
      w.spate = Math.max(0, w.spate - dt * 0.35);
      w.lift = Math.max(0, w.lift - dt * 0.5);
      // The pan swirls in slow circles, and comes up to the light when there is gold in it.
      const sw = t * 2.2 * pace + id;
      // (In heavy rain both stop work, the pan held still and the pick grounded: see shelter.)
      const rest = this.rest;
      w.panArm.rotation.set(Math.sin(sw) * 0.18 * (1 - rest), 0, -0.55 + Math.cos(sw) * 0.12 * (1 - rest) - w.lift * 0.9);
      // The pick: a slow lift, a quick fall onto the heap; in spate, faster and harder.
      w.swing = (w.swing + dt * (blighted ? 0.4 : 1.1) * (1 + w.spate * 1.5)) % 1;
      const u = w.swing;
      w.pickArm.rotation.z = (u < 0.72 ? -2.6 * (u / 0.72) : -2.6 + 2.6 * Math.min(1, (u - 0.72) / 0.07)) * (1 - rest);
      // The fire flickers; by night it glows like every other light.
      const flick = flame * (0.9 + Math.sin(t * 7 + id * 3) * 0.1);
      w.fire.scale.set(1, 0.85 + Math.sin(t * 9 + id) * 0.15, 1);
      w.fire.visible = up;
      w.glow.gain = up ? flick * (blighted ? 0.4 : 1) : 0;
      if (!up) continue;
      const lift = Math.max(0, rise);
      if ((w.smokeTimer -= dt) <= 0) {
        w.smokeTimer = 0.4 + Math.random() * 0.3;
        particles.smoke.emit({
          x: w.root.position.x + w.smokeAt.x, y: w.smokeAt.y + lift, z: w.root.position.z + w.smokeAt.z,
          vx: (Math.random() - 0.5) * 0.02, vy: 0.1 + Math.random() * 0.04, vz: (Math.random() - 0.5) * 0.02,
          life: 2.6 + Math.random(), size: 0.02, grow: 4, color: '#d6d0c8', alpha: 0.3, drag: 0.2, fadeIn: 0.15,
        });
      }
      // Water spills from the sluice's tail onto the spoil, harder in spate.
      if ((w.spillTimer -= dt * (1 + w.spate * 5)) <= 0) {
        w.spillTimer = 0.12;
        particles.spray.emit({
          x: w.root.position.x + w.tail.x, y: w.tail.y + lift, z: w.root.position.z + w.tail.z,
          vx: (Math.random() - 0.5) * 0.05, vy: 0.02 + Math.random() * 0.03, vz: (Math.random() - 0.5) * 0.05,
          life: 0.5, size: 0.006 + Math.random() * 0.004, color: '#e8f2f4', alpha: 0.8, gravity: 1.6, drag: 0.4, floor: w.tail.y - 0.02 + lift,
        });
      }
      // Gold glints in the gravel, catching the sun (none at night).
      if (day > 0.2 && (w.glintTimer -= dt * day * (1 + w.spate * 6)) <= 0) {
        w.glintTimer = 0.07 + w.rnd.range(0, 0.16);
        const s = w.tile.shape.features.sites!;
        const keys = Object.keys(s).filter((k) => k.startsWith('heap') || k === 'tail');
        const c = s[keys[w.rnd.int(keys.length)]];
        const a = w.rnd.range(0, Math.PI * 2), r = w.rnd.range(0, (c.r ?? 0.1) * 1.1);
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        particles.sparkle.emit({
          x: w.root.position.x + x, y: w.tile.shape.height(x, z) + 0.006 + lift, z: w.root.position.z + z,
          life: 0.35 + Math.random() * 0.3, size: 0.022 + Math.random() * 0.018, grow: 0.2, color: '#fff1b8', fadeIn: 0.3,
        });
      }
    }
  }

  produce(hex: number) {
    const w = this.works.find((x) => x.tile.hex.id === hex);
    if (!w) return;
    w.spate = 1;
    w.lift = 1;
    w.swing = 0.5;
    const ox = w.root.position.x, oz = w.root.position.z;
    // A flash of gold from the pan and from the heap under the pick.
    for (const [p, n] of [[w.pan, 22], [w.heap, 30]] as const)
      for (let i = 0; i < n; i++)
        this.ctx.particles.sparkle.emit({
          x: ox + p.x, y: p.y + 0.01, z: oz + p.z,
          vx: (Math.random() - 0.5) * 0.4, vy: 0.25 + Math.random() * 0.45, vz: (Math.random() - 0.5) * 0.4,
          life: 0.7 + Math.random() * 0.6, size: 0.016 + Math.random() * 0.014, grow: 0.3,
          color: Math.random() < 0.7 ? '#ffd56a' : '#fff4c8', gravity: 0.7, drag: 1.2,
        });
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      this.ctx.particles.dust.emit({
        x: ox + w.heap.x + Math.cos(a) * 0.02, y: w.heap.y, z: oz + w.heap.z + Math.sin(a) * 0.02,
        vx: Math.cos(a) * 0.08, vy: 0.05, vz: Math.sin(a) * 0.08, life: 1.2, size: 0.04, grow: 2, color: '#c9b48a', alpha: 0.4, drag: 2,
      });
    }
  }

  dispose() {
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.parts.dispose();
    this.works = [];
  }
}
