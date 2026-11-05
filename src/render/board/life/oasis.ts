// The oasis, where the caravans set out: a drovers' camp on the far side of the clearing from the
// pool, a striped ridge tent with a lantern lit inside and a striped awning over rugs beside it, a
// fire with a coffee pot and a drover sitting by it, water jars, and camels standing and couched in the shade,
// one of them chewing and looking about. Smoke rises from the fire and it glows at night. Should
// the oasis ever produce, the camels lift their heads and the fire flares.

import * as THREE from 'three/webgpu';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose, smoothSphere } from '../geom';
import { SURFACE } from '../surfaces';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import type { LifeContext, LifeModule } from './common';
import { release } from '../release';
import type { Lamp } from '../../fx/lampLights';
import { FOLK_SCALE, makeFolk, rod } from './folk';
import { FIRE, Parts, clearOfPieces, fireMaterial, stillProps, stokeFire } from './props';
import { DROVER_TENT, buildTent } from './tent';

const C = (h: string) => new THREE.Color(h);
/** The camels are modelled about 0.1 long and shown a half larger, to read among the palms from the table. */
// (The hump a head above a person, as a camel's is: see pasture.ts on sizes.)
const CAMEL = 1.23;

/** Where a camel's neck joins its body (local, before CAMEL), standing or couched. */
const NECK_BASE = { standing: new THREE.Vector3(0.033, 0.066, 0), couched: new THREE.Vector3(0.03, 0.03, 0) };

/**
 * A camel about 0.1 long, facing +x: standing on four long legs with knobbled knees, or couched
 * with its legs folded under and its forelegs tucked before it. The neck and head are separate
 * (see makeCamelHead).
 */
function makeCamel(coat: string, standing: boolean): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const c = C(coat), dark = c.clone().multiplyScalar(0.72), hoof = C('#3a2e24');
  const y0 = standing ? 0.058 : 0.021;
  const body = smoothSphere(0.024, 2);
  body.scale(1.5, 0.72, 0.78);
  b.addGeometry(body, compose(0, y0, 0), c);
  body.dispose();
  const hump = smoothSphere(0.014, 1);
  hump.scale(1.3, 1, 1);
  b.addGeometry(hump, compose(-0.004, y0 + 0.016, 0), c);
  hump.dispose();
  if (standing) {
    for (const [x, sd] of [[0.022, 1], [0.022, -1], [-0.021, 1], [-0.021, -1]]) {
      const top = new THREE.Vector3(x, y0 - 0.006, sd * 0.01), knee = new THREE.Vector3(x + 0.002, 0.026, sd * 0.011), foot = new THREE.Vector3(x - 0.001, 0.002, sd * 0.011);
      rod(b, top, knee, 0.0042, c);
      rod(b, knee, foot, 0.0032, dark);
      const k = smoothSphere(0.0045, 0);
      b.addGeometry(k, compose(knee.x, knee.y, knee.z), dark);
      k.dispose();
      const pad = new THREE.CylinderGeometry(0.0045, 0.005, 0.003, 6);
      b.addGeometry(pad, compose(foot.x + 0.001, 0.0015, foot.z), hoof);
      pad.dispose();
    }
  } else {
    // Couched: haunches and knees showing at the sides, the forelegs folded before the chest.
    for (const [x, sd] of [[0.022, 1], [0.022, -1], [-0.02, 1], [-0.02, -1]]) {
      const leg = smoothSphere(0.008, 1);
      leg.scale(1.8, 0.6, 0.8);
      b.addGeometry(leg, compose(x, 0.005, sd * 0.019), dark);
      leg.dispose();
    }
    for (const sd of [-1, 1]) rod(b, new THREE.Vector3(0.026, 0.004, sd * 0.009), new THREE.Vector3(0.05, 0.003, sd * 0.008), 0.0034, dark);
  }
  const tail = new THREE.CylinderGeometry(0.0016, 0.001, 0.018, 4);
  b.addGeometry(tail, compose(-0.037, y0 - 0.006, 0, 0, 0, -0.3), dark);
  tail.dispose();
  // A saddle blanket over the hump.
  const blanket = new THREE.BoxGeometry(0.026, 0.003, 0.04);
  b.addGeometry(blanket, compose(-0.002, y0 + 0.018, 0), (_x, _y, z, out) => out.set(Math.abs(z) > 0.014 ? '#8a2e26' : '#c99a3a'));
  blanket.dispose();
  return b.build(false);
}

/** A camel's long neck, dipping forward and rising to the head, from its base (turns and nods about it). */
function makeCamelHead(coat: string): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const c = C(coat);
  rod(b, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.019, 0.006, 0), 0.0068, c);
  rod(b, new THREE.Vector3(0.019, 0.006, 0), new THREE.Vector3(0.03, 0.026, 0), 0.0058, c);
  rod(b, new THREE.Vector3(0.03, 0.026, 0), new THREE.Vector3(0.032, 0.044, 0), 0.0052, c);
  const head = smoothSphere(0.0068, 1);
  head.scale(1.8, 0.9, 0.8);
  b.addGeometry(head, compose(0.04, 0.047, 0, 0, 0, -0.25), c);
  head.dispose();
  for (const sd of [-1, 1]) {
    const ear = new THREE.ConeGeometry(0.0016, 0.005, 4);
    b.addGeometry(ear, compose(0.033, 0.053, sd * 0.0035, sd * 0.3, 0, 0.2), c);
    ear.dispose();
    const eye = smoothSphere(0.001, 0);
    b.addGeometry(eye, compose(0.041, 0.0495, sd * 0.0042), C('#1a120c'));
    eye.dispose();
  }
  return b.build(false);
}

/** The first and third camels stand; the second is couched. */
const stands = (i: number) => i !== 1;

interface Camp {
  tile: TileInfo;
  root: THREE.Group;
  heads: THREE.Object3D[];
  fire: THREE.Mesh;
  glow: Lamp;
  /** The drover and the camels (bodies and heads), and the tent's lantern and its light: put out on a destroyed hex. */
  living: THREE.Object3D;
  lantern: THREE.Mesh;
  lanternGlow: Lamp;
  smokeAt: THREE.Vector3;
  alert: number;
  smokeTimer: number;
  rnd: Rand;
}

type Spot = { x: number; z: number; a: number };

export class OasisLife implements LifeModule {
  private tiles: TileInfo[] = [];
  private camps: Camp[] = [];
  private layout = new Map<number, { tent: Spot; fire: Spot; awning: Spot; camels: Spot[]; jars: Spot }>();
  private disposables: { dispose(): void }[] = [];
  private parts: Parts;
  /** Where each tent's lantern hangs (tile-local), set as the tent is built. */
  private lanterns = new Map<number, THREE.Vector3>();

  constructor(private ctx: LifeContext) {
    this.parts = new Parts(ctx.effects, ctx.props);
  }

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'oasis');
    const res: Reserved = [];
    for (const t of this.tiles) {
      const camp = t.shape.features.sites!.camp, pool = t.shape.features.sites!.pool;
      const at = (a: number, r: number, face: number): Spot => ({ x: Math.cos(a) * r, z: Math.sin(a) * r, a: face });
      // The tent opens towards the clearing; the fire burns before it, the awning stands beside it.
      const tent = at(camp.a!, 0.56, camp.a! + Math.PI);
      const fire = at(camp.a!, 0.39, 0);
      const awning = at(camp.a! + 0.42, 0.52, camp.a! + Math.PI);
      const jars = at(camp.a! - 0.36, 0.5, 0);
      // The camels couch round the pool's side of the camp, in the palms' shade.
      const camels: Spot[] = [];
      const pa = Math.atan2(pool.z, pool.x);
      // (Searching out from the camp on either side for room, clear of where pieces may stand.)
      for (let k = 0; k < 24 && camels.length < 3; k++) {
        const off = (0.6 + Math.floor(k / 2) * 0.12) * (k % 2 ? -1 : 1);
        const a = camp.a! + off;
        for (const r of [0.55, 0.47, 0.62]) {
          const s = at(a, r, a + Math.PI / 2 + (off > 0 ? 0 : Math.PI) + 0.3 * Math.sin(pa));
          if (!t.shape.canPlace(s.x, s.z, 0.07) || t.shape.features.water!.depth(s.x, s.z) > -0.01) continue;
          if (!clearOfPieces(this.ctx.anchors, t.hex.id, s.x, s.z, 0.07) || camels.some((c) => Math.hypot(c.x - s.x, c.z - s.z) < 0.17)) continue;
          camels.push(s);
          break;
        }
      }
      this.layout.set(t.hex.id, { tent, fire, awning, camels, jars });
      res.push({ hex: t.hex.id, x: tent.x, z: tent.z, r: 0.13 }, { hex: t.hex.id, x: fire.x, z: fire.z, r: 0.05 }, { hex: t.hex.id, x: awning.x, z: awning.z, r: 0.09 }, { hex: t.hex.id, x: jars.x, z: jars.z, r: 0.04 });
      for (const c of camels) res.push({ hex: t.hex.id, x: c.x, z: c.z, r: 0.1 });
    }
    return res;
  }

  build() {
    const { effects, group } = this.ctx;
    const coats = ['#c9a272', '#b08a5e', '#d6b58a'];
    const headGeos = coats.map((c) => makeCamelHead(c));
    const fireGeo = new THREE.ConeGeometry(0.011, 0.03, 7);
    fireGeo.translate(0, 0.015, 0);
    const lanternGeo = new THREE.BoxGeometry(0.008, 0.011, 0.008);
    this.disposables.push(...headGeos, fireGeo, lanternGeo);
    // Every oasis camp in one mesh.
    const still = this.tiles.map((t) => ({ geo: this.buildStatic(t), hex: t.hex }));
    const mesh = stillProps(effects, still, this.disposables);
    still.forEach((p) => p.geo.dispose());
    if (mesh) group.add(mesh);
    for (const t of this.tiles) {
      const L = this.layout.get(t.hex.id)!;
      const root = new THREE.Group();
      root.position.set(t.hex.x, 0, t.hex.z);
      group.add(root);
      const living = new THREE.Group();
      root.add(living);
      const bodies = this.buildLiving(t, coats);
      this.parts.add(bodies, living, t.hex.id, true);
      bodies.dispose();
      const lp = this.lanterns.get(t.hex.id)!;
      const lantern = new THREE.Mesh(lanternGeo, fireMaterial(effects));
      lantern.position.copy(lp);
      root.add(lantern);
      const lanternGlow = this.ctx.lamps.add(root, { x: lp.x, y: lp.y, z: lp.z }, { color: FIRE, distance: 0.22, strength: 0.18 });
      const heads = L.camels.map((c, i) => {
        const pivot = new THREE.Group();
        const base = stands(i) ? NECK_BASE.standing : NECK_BASE.couched;
        pivot.position.set(c.x + Math.cos(c.a) * base.x * CAMEL, t.shape.height(c.x, c.z) + base.y * CAMEL, c.z + Math.sin(c.a) * base.x * CAMEL);
        pivot.rotation.y = -c.a;
        pivot.scale.setScalar(CAMEL);
        living.add(pivot);
        this.parts.add(headGeos[i % headGeos.length], pivot, t.hex.id);
        return pivot;
      });
      const fy = t.shape.height(L.fire.x, L.fire.z);
      const fire = new THREE.Mesh(fireGeo, fireMaterial(effects));
      fire.position.set(L.fire.x, fy + 0.003, L.fire.z);
      root.add(fire);
      const glow = this.ctx.lamps.add(root, { x: L.fire.x, y: fy + 0.03, z: L.fire.z }, { color: FIRE, distance: 0.45, strength: 0.34 });
      this.camps.push({ tile: t, root, heads, fire, glow, living, lantern, lanternGlow, smokeAt: new THREE.Vector3(L.fire.x, fy + 0.035, L.fire.z), alert: 0, smokeTimer: 0, rnd: new Rand(t.shape.seed * 43 + 5) });
    }
  }

  /** The camp (tent, awning, rugs, fire ring, jars, the drover) and the camels' bodies, in one mesh. */
  private buildStatic(t: TileInfo): THREE.BufferGeometry {
    const b = new MeshBuilder();
    const L = this.layout.get(t.hex.id)!;
    const h = (x: number, z: number) => t.shape.height(x, z);
    const pole = C('#6a4a2e');
    // The tent: a drovers' ridge tent of striped canvas, its door open to the fire (see tent.ts).
    this.lanterns.set(t.hex.id, buildTent(b, L.tent.x, L.tent.z, L.tent.a, h, DROVER_TENT, 0.15, 0.12, 0.088));
    // The awning: a striped sheet on four poles over a rug.
    {
      const { x, z, a } = L.awning;
      const y0 = h(x, z);
      const fwd = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), side = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const P = (u: number, v: number, y: number) => new THREE.Vector3(x, y0 + y, z).addScaledVector(side, u * 0.05).addScaledVector(fwd, v * 0.04);
      for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) rod(b, P(u, v, -0.003), P(u, v, v < 0 ? 0.05 : 0.058), 0.0018, pole);
      b.surfaceId = SURFACE.canvas;
      const N = 6;
      for (let i = 0; i < N; i++) {
        const u0 = (i / N) * 2 - 1, u1 = ((i + 1) / N) * 2 - 1;
        const sag = (u: number) => -0.006 * (1 - u * u);
        const c = i % 2 ? C('#e8dcc4') : C('#b8402e');
        const q = [P(u0, -1, 0.05 + sag(u0)), P(u1, -1, 0.05 + sag(u1)), P(u1, 1, 0.058 + sag(u1)), P(u0, 1, 0.058 + sag(u0))];
        const top = q.map((p) => b.vertex(p.x, p.y, p.z, c));
        const bot = q.map((p) => b.vertex(p.x, p.y - 0.0008, p.z, c.clone().multiplyScalar(0.7), 0, -1, 0));
        b.quad(top[0], top[3], top[2], top[1]);
        b.quad(bot[0], bot[1], bot[2], bot[3]);
      }
      b.surfaceId = 0;
      const rug = new THREE.PlaneGeometry(0.085, 0.065);
      b.addGeometry(rug, compose(x, y0 + 0.002, z, -Math.PI / 2, -a, 0), (px, _py, pz, out) => out.set(Math.abs(Math.sin(px * 160) + Math.cos(pz * 140)) > 1.1 ? '#2e4a7a' : '#a8382a'));
      rug.dispose();
      for (const s of [-1, 1]) {
        const cushion = smoothSphere(0.008, 1);
        cushion.scale(1.4, 0.6, 1);
        const cp = P(s * 0.55, 0.5, 0.005);
        b.addGeometry(cushion, compose(cp.x, cp.y, cp.z), C(s > 0 ? '#c99a3a' : '#6a3a5a'));
        cushion.dispose();
      }
    }
    // The fire ring, a coffee pot in the embers, and the drover sitting by it.
    {
      const { x, z } = L.fire;
      const y = h(x, z);
      for (let k = 0; k < 7; k++) {
        const q = (k / 7) * Math.PI * 2;
        const st = smoothSphere(0.0065, 0);
        b.addGeometry(st, compose(x + Math.cos(q) * 0.019, y + 0.002, z + Math.sin(q) * 0.019, 0, q, 0, 1, 0.7, 1), C(k % 2 ? '#a08a6a' : '#7d6a52'));
        st.dispose();
      }
      const pot = new THREE.CylinderGeometry(0.003, 0.006, 0.012, 8);
      b.addGeometry(pot, compose(x + 0.012, y + 0.008, z + 0.004), C('#b07a3a'));
      pot.dispose();
    }
    // Water jars by the path to the pool.
    {
      const { x, z } = L.jars;
      for (let k = 0; k < 3; k++) {
        const jx = x + Math.cos(k * 2.1) * 0.016, jz = z + Math.sin(k * 2.1) * 0.016;
        const pts = [0, 0.004, 0.007, 0.0065, 0.004, 0.003, 0.0035].map((r, i) => new THREE.Vector2(r, i * 0.004));
        const jar = new THREE.LatheGeometry(pts, 8);
        b.addGeometry(jar, compose(jx, h(jx, jz) - 0.001, jz, 0, 0, k === 2 ? 1.4 : 0, 1 + k * 0.1), C(k % 2 ? '#b8683e' : '#c98a56'));
        jar.dispose();
      }
    }
    return b.build(false);
  }

  /**
   * The camp's living things that keep still, in one mesh (tile-local x and z, world y): the
   * drover sitting by the fire and the camels' bodies (their necks and heads move: see build).
   * Kept apart from the camp so a hex pollution destroys can be left empty of them.
   */
  private buildLiving(t: TileInfo, coats: string[]): THREE.BufferGeometry {
    const b = new MeshBuilder();
    const L = this.layout.get(t.hex.id)!;
    const h = (x: number, z: number) => t.shape.height(x, z);
    const { x, z } = L.fire, tent = L.tent;
    const da = Math.atan2(z - tent.z, x - tent.x) + 1.2;
    const dx = x + Math.cos(da) * 0.045, dz = z + Math.sin(da) * 0.045;
    const g = makeFolk({ coat: '#e6dcc8', robe: true, hat: 'wrap', hatColor: '#f0ead8', skin: '#b48058' });
    // (Sitting cross-legged by the fire: the robe's foot sunk into the sand.)
    b.addGeometry(g, compose(dx, h(dx, dz) - 0.012 * (FOLK_SCALE / 2.1), dz, 0, -Math.atan2(z - dz, x - dx), 0, FOLK_SCALE), C('#ffffff'));
    g.dispose();
    L.camels.forEach((c, i) => {
      const cg = makeCamel(coats[i % coats.length], stands(i));
      b.addGeometry(cg, compose(c.x, h(c.x, c.z) - 0.003, c.z, 0, -c.a, 0, CAMEL), C('#ffffff'));
      cg.dispose();
    });
    return b.build(false);
  }

  update(dt: number, t: number) {
    const { effects, particles } = this.ctx;
    const flame = stokeFire(effects, t);
    for (const c of this.camps) {
      const id = c.tile.hex.id;
      const rise = effects.riseValues[id] ?? 0;
      // (On a hex pollution has destroyed the camp is abandoned: no drover, no camels, no fire.)
      const alive = (effects.scarValues[id] ?? 0) < 0.85;
      const up = rise > -0.05 && alive;
      c.living.visible = alive;
      c.lantern.visible = up;
      c.lanternGlow.gain = up ? flame * 0.8 : 0;
      c.alert = Math.max(0, c.alert - dt * 0.4);
      // The camels chew and look slowly about; startled, they lift their heads high.
      c.heads.forEach((hd, i) => {
        const ph = t * 0.35 + i * 2.3 + id;
        hd.rotation.y = Math.sin(ph) * 0.5 + Math.sin(ph * 2.7) * 0.1;
        hd.rotation.z = Math.sin(t * 6 + i) * 0.015 + c.alert * 0.35 - 0.1 + Math.max(0, Math.sin(ph * 0.4)) * 0.2;
      });
      const heat = flame * (0.9 + Math.sin(t * 7 + id * 3) * 0.1) * (1 + c.alert * 1.5) * (effects.get(id).y > 0.5 ? 0.4 : 1);
      c.fire.scale.set(1, 0.85 + Math.sin(t * 9 + id) * 0.15 + c.alert * 0.4, 1);
      c.fire.visible = up;
      c.glow.gain = up ? heat : 0;
      if (up && (c.smokeTimer -= dt * (1 + c.alert * 3)) <= 0) {
        c.smokeTimer = 0.45 + Math.random() * 0.3;
        particles.smoke.emit({
          x: c.root.position.x + c.smokeAt.x, y: c.smokeAt.y + Math.max(0, rise), z: c.root.position.z + c.smokeAt.z,
          vx: (Math.random() - 0.5) * 0.02, vy: 0.1 + Math.random() * 0.04, vz: (Math.random() - 0.5) * 0.02,
          life: 2.6 + Math.random(), size: 0.02, grow: 4, color: '#ddd6cc', alpha: 0.28, drag: 0.2, fadeIn: 0.15,
        });
      }
    }
  }

  produce(hex: number) {
    const c = this.camps.find((x) => x.tile.hex.id === hex);
    if (!c) return;
    c.alert = 1;
    for (let i = 0; i < 14; i++)
      this.ctx.particles.sparkle.emit({
        x: c.root.position.x + c.smokeAt.x, y: c.smokeAt.y, z: c.root.position.z + c.smokeAt.z,
        vx: (Math.random() - 0.5) * 0.2, vy: 0.2 + Math.random() * 0.3, vz: (Math.random() - 0.5) * 0.2,
        life: 0.8 + Math.random() * 0.5, size: 0.012, color: Math.random() < 0.5 ? '#ffb35a' : '#ffe08a', gravity: 0.4, drag: 1,
      });
  }

  dispose() {
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.parts.dispose();
    this.camps = [];
  }
}
