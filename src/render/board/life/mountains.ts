// Mountains: a timber-framed mine entrance cut into the main peak, a warm lantern,
// a short rail stub ending at an ore heap with glinting crystals, and a mine cart
// that trundles in and out. On production the cart rushes out loaded, sparks fly
// from the tunnel, dust billows and the ground rumbles.

import { easeAngle, follow } from '../../util/angle';
import * as THREE from 'three/webgpu';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose, displace, smoothSphere } from '../geom';
import { pooled, tilePropMaterial } from '../materials';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import { shelter, type LifeContext, type LifeModule } from './common';
import { release } from '../release';
import { lampColor, lampLevel } from '../../fx/lamps';
import type { Lamp } from '../../fx/lampLights';
import { FOLK_SCALE } from './folk';

const LANTERN = lampColor(1.8, 1.2, 0.4);
const lanternColor = new THREE.Color();

const C = (h: string) => new THREE.Color(h);
const RAIL_LEN = 0.09;

function makeMineEntrance(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const timber = C('#5d4129');
  const timberLight = C('#7c5a3a');
  // Dark tunnel mouth (a recessed half-cylinder).
  const hole = new THREE.CylinderGeometry(0.034, 0.034, 0.06, 16, 1, false, 0, Math.PI);
  b.addGeometry(hole, compose(0, 0.0, -0.01, Math.PI / 2, 0, Math.PI / 2), C('#0d0a08'));
  hole.dispose();
  const back = new THREE.BoxGeometry(0.068, 0.036, 0.004);
  b.addGeometry(back, compose(0, 0.018, -0.03), C('#0d0a08'));
  back.dispose();
  // Timber frame: posts, lintel, braces.
  for (const x of [-0.036, 0.036]) {
    const post = new THREE.BoxGeometry(0.009, 0.06, 0.009);
    b.addGeometry(post, compose(x, 0.03, 0.012), timber);
    post.dispose();
  }
  const lintel = new THREE.BoxGeometry(0.09, 0.011, 0.011);
  b.addGeometry(lintel, compose(0, 0.062, 0.012), timberLight);
  lintel.dispose();
  for (const s of [-1, 1]) {
    const brace = new THREE.BoxGeometry(0.006, 0.03, 0.006);
    b.addGeometry(brace, compose(s * 0.026, 0.05, 0.014, 0, 0, s * 0.8), timber);
    brace.dispose();
  }
  // Rail stub.
  for (const z of [-0.012, 0.012]) {
    const rail = new THREE.BoxGeometry(0.004, 0.004, RAIL_LEN + 0.04);
    b.addGeometry(rail, compose(z, 0.004, RAIL_LEN / 2 - 0.02), C('#55504c'));
    rail.dispose();
  }
  for (let i = 0; i < 7; i++) {
    const tie = new THREE.BoxGeometry(0.04, 0.004, 0.008);
    b.addGeometry(tie, compose(0, 0.001, -0.01 + i * 0.028), timber);
    tie.dispose();
  }
  // Lantern post.
  const lp = new THREE.BoxGeometry(0.004, 0.05, 0.004);
  b.addGeometry(lp, compose(0.05, 0.025, 0.03), timber);
  lp.dispose();
  const arm = new THREE.BoxGeometry(0.018, 0.003, 0.003);
  b.addGeometry(arm, compose(0.044, 0.05, 0.03), timber);
  arm.dispose();
  return b.build(false);
}

/** A timber headframe: two raked legs, a cross-beam and a platform; the wheel is separate. */
function makeHeadframe(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const timber = C('#5d4129');
  const light = C('#7c5a3a');
  for (const x of [-0.016, 0.016])
    for (const z of [-0.014, 0.014]) {
      const leg = new THREE.BoxGeometry(0.005, 0.1, 0.005);
      b.addGeometry(leg, compose(x * 0.8, 0.05, z * 0.8, z * 2.2, 0, -x * 2.2), timber);
      leg.dispose();
    }
  for (const y of [0.035, 0.07]) {
    const beam = new THREE.BoxGeometry(0.03, 0.004, 0.004);
    b.addGeometry(beam, compose(0, y, 0.011 - (y - 0.035) * 0.1), light);
    b.addGeometry(beam, compose(0, y, -0.011 + (y - 0.035) * 0.1), light);
    beam.dispose();
  }
  const top = new THREE.BoxGeometry(0.03, 0.005, 0.026);
  b.addGeometry(top, compose(0, 0.1, 0), light);
  top.dispose();
  // Hoist rope down into the shaft.
  const rope = new THREE.CylinderGeometry(0.0009, 0.0009, 0.1, 4);
  b.addGeometry(rope, compose(0.012, 0.06, 0), C('#c9b48a'));
  rope.dispose();
  return b.build(false);
}

function makeWheel(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const iron = C('#3d3a38');
  const rim = new THREE.TorusGeometry(0.014, 0.0018, 6, 18);
  b.addGeometry(rim, compose(0, 0, 0), iron);
  rim.dispose();
  for (let i = 0; i < 4; i++) {
    const spoke = new THREE.BoxGeometry(0.028, 0.0016, 0.0016);
    b.addGeometry(spoke, compose(0, 0, 0, 0, 0, (i * Math.PI) / 4), iron);
    spoke.dispose();
  }
  return b.build(false);
}

/** A little ore shed with a plank roof. */
function makeShed(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const wall = new THREE.BoxGeometry(0.05, 0.034, 0.038);
  b.addGeometry(wall, compose(0, 0.017, 0), C('#8a6a48'));
  wall.dispose();
  for (const s of [-1, 1]) {
    const roof = new THREE.BoxGeometry(0.058, 0.004, 0.028);
    b.addGeometry(roof, compose(0, 0.042, s * 0.011, s * 0.6, 0, 0), C('#5b4a3c'));
    roof.dispose();
  }
  const door = new THREE.BoxGeometry(0.012, 0.022, 0.002);
  b.addGeometry(door, compose(0.008, 0.011, 0.02), C('#3d2a1a'));
  door.dispose();
  return b.build(false);
}

/** A miner: body and head (the pick arm is a separate mesh so it can swing). */
function makeMiner(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const legs = new THREE.CylinderGeometry(0.0035, 0.004, 0.012, 6);
  b.addGeometry(legs, compose(0, 0.006, 0), C('#3e3a44'));
  legs.dispose();
  const body = new THREE.CylinderGeometry(0.0045, 0.0055, 0.013, 8);
  b.addGeometry(body, compose(0, 0.018, 0), C('#8b5a3c'));
  body.dispose();
  const head = smoothSphere(0.0042, 1);
  b.addGeometry(head, compose(0, 0.029, 0), C('#e2b48c'));
  head.dispose();
  const hat = new THREE.CylinderGeometry(0.0046, 0.0052, 0.003, 8);
  b.addGeometry(hat, compose(0, 0.0325, 0), C('#3a342e'));
  hat.dispose();
  const lamp = smoothSphere(0.0013, 1);
  b.addGeometry(lamp, compose(0, 0.032, 0.0045), C('#ffd27a'));
  lamp.dispose();
  return b.build(false);
}

function makePick(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const handle = new THREE.BoxGeometry(0.0016, 0.0016, 0.016);
  b.addGeometry(handle, compose(0, 0, 0.008), C('#7c5a3a'));
  handle.dispose();
  const head = new THREE.BoxGeometry(0.0016, 0.011, 0.002);
  b.addGeometry(head, compose(0, 0, 0.016), C('#55504c'));
  head.dispose();
  return b.build(false);
}

/** A mountain goat: stocky cream-and-tan body, dark legs, beard and swept-back horns. */
function makeGoat(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const coat = C('#e8dfcc'), tan = C('#b89a72'), dark = C('#3d3530');
  const body = smoothSphere(0.016, 2);
  body.scale(1.6, 1, 0.9);
  b.addGeometry(body, compose(0, 0.03, 0), (_x, y, _z, o) => o.copy(y > 0.034 ? coat : tan));
  body.dispose();
  for (const lx of [-0.016, 0.016])
    for (const lz of [-0.008, 0.008]) {
      const leg = new THREE.CylinderGeometry(0.0026, 0.0022, 0.022, 5);
      b.addGeometry(leg, compose(lx, 0.011, lz), dark);
      leg.dispose();
    }
  const neck = new THREE.CylinderGeometry(0.0055, 0.007, 0.016, 6);
  b.addGeometry(neck, compose(0.022, 0.042, 0, 0, 0, -0.6), coat);
  neck.dispose();
  const head = smoothSphere(0.0075, 1);
  head.scale(1.5, 1, 0.9);
  b.addGeometry(head, compose(0.032, 0.05, 0, 0, 0, -0.35), coat);
  head.dispose();
  const beard = new THREE.ConeGeometry(0.0025, 0.008, 5);
  b.addGeometry(beard, compose(0.036, 0.042, 0, Math.PI, 0, 0), C('#d8cdb6'));
  beard.dispose();
  for (const s of [-1, 1]) {
    const horn = new THREE.ConeGeometry(0.0022, 0.016, 5);
    b.addGeometry(horn, compose(0.027, 0.06, s * 0.0035, s * 0.2, 0, 0.9), C('#5a4a3c'));
    horn.dispose();
    const eye = smoothSphere(0.0013, 0);
    b.addGeometry(eye, compose(0.036, 0.053, s * 0.0055), C('#1a120c'));
    eye.dispose();
  }
  const tail = smoothSphere(0.004, 1);
  b.addGeometry(tail, compose(-0.026, 0.038, 0), coat);
  tail.dispose();
  return b.build(false);
}

interface Goat {
  tile: TileInfo;
  obj: THREE.Object3D;
  x: number;
  z: number;
  /** Ground height where it stood when last sampled (again only when it moves: the terrain is costly). */
  ground?: { x: number; z: number; y: number };
  from: { x: number; z: number };
  to: { x: number; z: number };
  hop: number;
  wait: number;
  rnd: Rand;
}

function makeCart(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const iron = C('#4c4744');
  const wood = C('#6f4d31');
  const tub = new THREE.BoxGeometry(0.036, 0.022, 0.05);
  b.addGeometry(tub, compose(0, 0.02, 0), wood);
  tub.dispose();
  for (const y of [0.012, 0.028]) {
    const band = new THREE.BoxGeometry(0.038, 0.003, 0.052);
    b.addGeometry(band, compose(0, y, 0), iron);
    band.dispose();
  }
  for (const x of [-0.019, 0.019])
    for (const z of [-0.016, 0.016]) {
      const w = new THREE.CylinderGeometry(0.008, 0.008, 0.004, 10);
      b.addGeometry(w, compose(x, 0.008, z, 0, 0, Math.PI / 2), iron);
      w.dispose();
    }
  // Heap of ore.
  for (let i = 0; i < 6; i++) {
    const o = smoothSphere(0.009, 1);
    b.addGeometry(o, compose((i % 3 - 1) * 0.011, 0.034 + (i > 2 ? 0.006 : 0), (Math.floor(i / 3) - 0.5) * 0.016), C(i % 2 ? '#3f4652' : '#555b66'));
    o.dispose();
  }
  return b.build(false);
}

function makeOreHeap(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  for (let i = 0; i < 14; i++) {
    const g = smoothSphere(0.012 + r.range(0, 0.006), 1);
    displace(g, (x, y, z) => Math.sin(x * 400 + y * 300 + z * 500) * 0.002);
    const a = r.range(0, Math.PI * 2);
    const d = r.range(0, 0.03);
    b.addGeometry(g, compose(Math.cos(a) * d, 0.006 + (0.03 - d) * 0.5, Math.sin(a) * d), C(r.chance(0.3) ? '#6b7f99' : '#4a4f58'));
    g.dispose();
  }
  return b.build(false);
}

function makeCrystals(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  for (let i = 0; i < 4; i++) {
    const g = new THREE.OctahedronGeometry(0.008 + r.range(0, 0.005), 0);
    g.scale(0.7, 1.8, 0.7);
    b.addGeometry(g, compose(r.range(-0.012, 0.012), 0.008, r.range(-0.012, 0.012), r.range(-0.3, 0.3), r.range(0, 3), r.range(-0.3, 0.3)), C('#9fc8ff'));
    g.dispose();
  }
  return b.build(false);
}

interface Mine {
  tile: TileInfo;
  root: THREE.Object3D;
  wheel: THREE.Object3D;
  pick: THREE.Object3D;
  miner: THREE.Object3D;
  cart: THREE.Object3D;
  /** Its lantern (a stand-in on WebGPU), and how its colour is set: its flicker, the hour. */
  lantern: THREE.Object3D;
  setLantern(c: THREE.Color): void;
  crystals: THREE.Object3D[];
  crystalMat: THREE.MeshStandardNodeMaterial;
  cartT: number;
  cartDir: number;
  pause: number;
  rush: number;
  glow: Lamp;
}

export class MountainsLife implements LifeModule {
  /** How far the workers here have downed tools for the rain (see common.ts shelter). */
  private rest = 0;
  private tiles: TileInfo[] = [];
  private mines: Mine[] = [];
  private spots = new Map<number, { x: number; z: number; yaw: number }>();
  private disposables: { dispose(): void }[] = [];
  private goats: Goat[] = [];

  constructor(private ctx: LifeContext) {}

  /** A foothold on the lower and middle slopes, clear of the mine and the number. */
  private foothold(t: TileInfo, rnd: Rand) {
    for (let k = 0; k < 40; k++) {
      const a = rnd.range(0, Math.PI * 2), r = rnd.range(0.4, 0.7);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = t.shape.height(x, z);
      // (A goat is long: its foothold keeps a body's length clear of the number disc.)
      if (h < 0.1 || h > 0.42 || !t.shape.canPlace(x, z, 0.08)) continue;
      const sp = this.spots.get(t.hex.id);
      if (sp && Math.hypot(sp.x - x, sp.z - z) < 0.2) continue;
      return { x, z };
    }
    return null;
  }

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'mountains');
    const res: Reserved = [];
    for (const t of this.tiles) {
      // The terrain generator carved a ledge for the mine into the front foothill.
      const a = t.shape.features.anchor!;
      const best = { x: a.x, z: a.z, yaw: Math.atan2(-a.z, -a.x) };
      this.spots.set(t.hex.id, best);
      for (let i = 0; i <= 3; i++) res.push({ hex: t.hex.id, x: best.x + Math.cos(best.yaw) * i * 0.06, z: best.z + Math.sin(best.yaw) * i * 0.06, r: 0.16 });
      // Keep the foothill in front of the tunnel free of trees so the mine stays visible.
      for (const d of [0.1, 0.2, 0.3]) res.push({ hex: t.hex.id, x: best.x - Math.cos(best.yaw) * d, z: best.z - Math.sin(best.yaw) * d, r: 0.14 });
    }
    return res;
  }

  build() {
    const { effects, group, props } = this.ctx;
    const entranceGeo = makeMineEntrance();
    const cartGeo = makeCart();
    const heapGeo = makeOreHeap(2);
    const crystalGeo = makeCrystals(5);
    const lanternGeo = new THREE.SphereGeometry(0.006, 10, 8);
    const frameGeo = makeHeadframe();
    const wheelGeo = makeWheel();
    const shedGeo = makeShed();
    const minerGeo = makeMiner();
    const pickGeo = makePick();
    const goatGeo = makeGoat();
    this.disposables.push(goatGeo);
    this.disposables.push(entranceGeo, cartGeo, heapGeo, crystalGeo, lanternGeo, frameGeo, wheelGeo, shedGeo, minerGeo, pickGeo);
    for (const t of this.tiles) {
      const sp = this.spots.get(t.hex.id)!;
      const mat = tilePropMaterial(effects, t.hex.id, { roughness: 0.85 });
      const crystalMat = tilePropMaterial(effects, t.hex.id, { roughness: 0.15, metalness: 0.2, emissive: [0.1, 0.25, 0.5] });
      this.disposables.push(mat, crystalMat);
      const root = new THREE.Group();
      const y = t.shape.height(sp.x, sp.z) - 0.004;
      root.position.set(t.hex.x + sp.x, y, t.hex.z + sp.z);
      // Local +z points out of the tunnel along the rails.
      root.rotation.y = Math.PI / 2 - sp.yaw;
      root.scale.setScalar(2.1);
      const ent = props.mesh(entranceGeo, mat);
      ent.castShadow = ent.receiveShadow = true;
      root.add(ent);
      // Its colour is this mine's lamp: one batched glow on WebGPU, else a material of the tile's own
      // (kept from board to board).
      const lit = props.glow(lanternGeo, LANTERN);
      let lantern: THREE.Object3D, setLantern: (c: THREE.Color) => void;
      if (lit) ({ obj: lantern, set: setLantern } = lit);
      else {
        const lanternMat = pooled(effects, `mineLantern:${t.hex.id}`, () => new THREE.MeshBasicNodeMaterial({ color: '#ffcf7a' }));
        this.disposables.push(lanternMat);
        lantern = new THREE.Mesh(lanternGeo, lanternMat);
        setLantern = (c) => lanternMat.color.copy(c);
      }
      lantern.position.set(0.036, 0.044, 0.03);
      root.add(lantern);
      const glow = this.ctx.lamps.add(root, { x: 0.036, y: 0.046, z: 0.04 }, { color: LANTERN, distance: 0.45, strength: 0.35 });
      const heap = props.mesh(heapGeo, mat);
      heap.position.set(-0.045, 0, RAIL_LEN - 0.005);
      heap.castShadow = heap.receiveShadow = true;
      root.add(heap);
      const crystals: THREE.Object3D[] = [];
      for (const [cx, cz] of [
        [-0.05, 0.03],
        [0.06, RAIL_LEN - 0.01],
      ]) {
        const c = props.mesh(crystalGeo, crystalMat);
        c.position.set(cx, 0, cz);
        root.add(c);
        crystals.push(c);
      }
      const cart = props.mesh(cartGeo, mat);
      cart.castShadow = true;
      root.add(cart);
      // Headframe with a turning hoist wheel beside the portal, an ore shed opposite.
      const frame = props.mesh(frameGeo, mat);
      frame.position.set(0.075, 0, 0.02);
      frame.castShadow = frame.receiveShadow = true;
      root.add(frame);
      const wheel = props.mesh(wheelGeo, mat);
      wheel.position.set(0.075, 0.108, 0.02);
      wheel.rotation.y = Math.PI / 2;
      wheel.castShadow = true;
      root.add(wheel);
      const shed = props.mesh(shedGeo, mat);
      shed.position.set(-0.085, 0, 0.035);
      shed.rotation.y = 0.35;
      shed.castShadow = shed.receiveShadow = true;
      root.add(shed);
      // A miner working the ore heap.
      const miner = new THREE.Group();
      const body = props.mesh(minerGeo, mat);
      body.castShadow = true;
      miner.add(body);
      const pick = new THREE.Group();
      pick.position.set(0.004, 0.022, 0);
      const pickMesh = props.mesh(pickGeo, mat);
      pick.add(pickMesh);
      miner.add(pick);
      miner.position.set(-0.02, 0, RAIL_LEN + 0.012);
      miner.rotation.y = -2.2;
      // (The mine is drawn at 2.1; the miner stands as tall as anyone, see folk.ts.)
      miner.scale.setScalar(FOLK_SCALE / 2.1);
      root.add(miner);
      group.add(root);
      // Two goats picking their way across the slopes.
      const grnd = new Rand(t.shape.seed * 5 + 9);
      for (let g = 0; g < 2; g++) {
        const p = this.foothold(t, grnd);
        if (!p) continue;
        const obj = props.mesh(goatGeo, mat);
        obj.castShadow = true;
        // (A goat's back comes to a person's waist and a little more: see pasture.ts on sizes.)
        obj.scale.setScalar(1.44);
        group.add(obj);
        this.goats.push({ tile: t, obj, x: p.x, z: p.z, from: p, to: p, hop: 1, wait: grnd.range(1, 6), rnd: grnd });
      }
      this.mines.push({ tile: t, root, wheel, pick, miner, cart, lantern, setLantern, crystals, crystalMat, cartT: Math.random(), cartDir: 1, pause: Math.random() * 2, rush: 0, glow });
    }
  }

  update(dt: number, t: number) {
    this.rest = shelter(this.rest, this.ctx.effects.rain.value, dt);
    for (const g of this.goats) {
      const rise = this.ctx.effects.riseValues[g.tile.hex.id] ?? 0;
      g.obj.visible = rise > -0.1;
      if (g.hop < 1) {
        g.hop = Math.min(1, g.hop + dt * 1.6);
        // Below zero it is still turning to face the foothold before it leaps.
        const u = Math.max(0, g.hop);
        g.x = g.from.x + (g.to.x - g.from.x) * u;
        g.z = g.from.z + (g.to.z - g.from.z) * u;
      } else if ((g.wait -= dt) <= 0) {
        // Bound to a nearby foothold.
        const p = this.foothold(g.tile, g.rnd);
        // (Never a leap across the number disc: every point of the bound keeps off it.)
        const clear = (q: { x: number; z: number }) => [0.25, 0.5, 0.75].every((u) => g.tile.shape.canPlace(g.x + (q.x - g.x) * u, g.z + (q.z - g.z) * u, 0.03));
        if (p && Math.hypot(p.x - g.x, p.z - g.z) < 0.35 && clear(p)) {
          g.from = { x: g.x, z: g.z };
          g.to = p;
          g.hop = -0.6;
        }
        g.wait = g.rnd.range(3, 9);
      }
      const arc = g.hop > 0 && g.hop < 1 ? Math.sin(g.hop * Math.PI) * 0.05 : 0;
      if (!g.ground || g.ground.x !== g.x || g.ground.z !== g.z) g.ground = { x: g.x, z: g.z, y: g.tile.shape.height(g.x, g.z) };
      const y = g.ground.y;
      g.obj.position.set(g.tile.hex.x + g.x, y - 0.002 + arc, g.tile.hex.z + g.z);
      const dx = g.to.x - g.from.x, dz = g.to.z - g.from.z;
      // Turns toward the next foothold as it sets off, rather than snapping round.
      if (Math.hypot(dx, dz) > 1e-4) g.obj.rotation.y = easeAngle(g.obj.rotation.y, -Math.atan2(dz, dx), follow(dt, 5));
      // Head down to nibble between hops.
      const nod = g.hop > 0 && g.hop < 1 ? (0.5 - g.hop) * 0.4 : Math.sin(t * 0.7 + g.x * 9) > 0.3 ? -0.12 : 0;
      g.obj.rotation.z += (nod - g.obj.rotation.z) * follow(dt, 6);
    }
    for (const m of this.mines) {
      const blighted = this.ctx.effects.get(m.tile.hex.id).y > 0.5;
      const rise = this.ctx.effects.riseValues[m.tile.hex.id] ?? 0;
      // (Out on a hex pollution has destroyed: the mine is gone with everything else.)
      m.lantern.visible = rise > -0.02 && (this.ctx.effects.scarValues[m.tile.hex.id] ?? 0) < 0.85;
      const flick = 0.85 + Math.sin(t * 9 + m.tile.hex.id) * 0.08 + Math.sin(t * 23) * 0.05;
      const lv = (blighted ? 0.3 : 1) * flick * (1 + m.rush * 0.8);
      // An unlit bulb keeps a warm floor by day, so it never reads as a dead dark ball.
      m.setLantern(lanternColor.copy(LANTERN).multiplyScalar(lv * lampLevel(this.ctx.effects.night.value, 0.45)));
      m.glow.gain = rise > -0.02 ? lv : 0;
      // Cart shuttles between the tunnel and the ore heap, pausing at each end.
      m.rush = Math.max(0, m.rush - dt * 0.6);
      if (m.pause > 0) m.pause -= dt * (blighted ? 0.25 : 1);
      else {
        const speed = (blighted ? 0.05 : 0.12) * (1 + m.rush * 4);
        m.cartT += m.cartDir * speed * dt;
        if (m.cartT >= 1) {
          m.cartT = 1;
          m.cartDir = -1;
          m.pause = 1.2 + Math.random() * 1.5;
        } else if (m.cartT <= 0) {
          m.cartT = 0;
          m.cartDir = 1;
          m.pause = 2 + Math.random() * 3;
        }
      }
      const z = -0.02 + m.cartT * (RAIL_LEN - 0.02);
      m.cart.position.set(0, 0.005 + Math.abs(Math.sin(t * 20)) * 0.0008 * (m.pause > 0 ? 0 : 1), z);
      m.cart.rotation.z = m.pause > 0 ? 0 : Math.sin(t * 18) * 0.02;
      m.cart.visible = rise > -0.1;
      // Hoist wheel turns while the cart moves; the miner swings the pick.
      m.wheel.rotation.z += dt * (m.pause > 0 ? 0.3 : 3) * (1 + m.rush * 3) * (blighted ? 0.2 : 1);
      const swing = (t * (blighted ? 0.5 : 1.3) + m.tile.hex.id * 0.37) % 1;
      // (Grounded through heavy rain: see shelter.)
      m.pick.rotation.x = (swing < 0.7 ? -1.6 * (swing / 0.7) : -1.6 + 1.6 * Math.min(1, (swing - 0.7) / 0.08)) * (1 - this.rest);
      m.miner.visible = rise > -0.1;
      // Crystals glint.
      for (let i = 0; i < m.crystals.length; i++) {
        const s = 1 + Math.max(0, Math.sin(t * 2.3 + i * 2 + m.tile.hex.id)) * 0.12;
        m.crystals[i].scale.setScalar(s);
      }
    }
  }

  produce(hex: number) {
    const m = this.mines.find((x) => x.tile.hex.id === hex);
    if (!m) return;
    m.rush = 1;
    m.pause = 0;
    m.cartT = 0;
    m.cartDir = 1;
    this.ctx.shake(0.04);
    const mouth = new THREE.Vector3(0, 0.03, 0.01).applyMatrix4(m.root.matrixWorld);
    for (let i = 0; i < 40; i++) {
      this.ctx.particles.sparkle.emit({
        x: mouth.x,
        y: mouth.y,
        z: mouth.z,
        vx: (Math.random() - 0.5) * 0.6,
        vy: 0.2 + Math.random() * 0.6,
        vz: (Math.random() - 0.5) * 0.6,
        life: 0.6 + Math.random() * 0.5,
        size: 0.016 + Math.random() * 0.016,
        grow: 0.2,
        color: Math.random() < 0.6 ? '#bfe0ff' : '#ffd98a',
        gravity: 0.9,
        drag: 1.5,
      });
    }
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      this.ctx.particles.dust.emit({
        x: mouth.x + Math.cos(a) * 0.03,
        y: mouth.y,
        z: mouth.z + Math.sin(a) * 0.03,
        vx: Math.cos(a) * 0.12,
        vy: 0.06 + Math.random() * 0.06,
        vz: Math.sin(a) * 0.12,
        life: 1.4,
        size: 0.06,
        grow: 2.5,
        color: '#b9b2a8',
        alpha: 0.5,
        drag: 2,
      });
    }
  }

  dispose() {
    // (Everything the island's life put on the board goes with it: see release.)
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.mines = [];
    this.goats = [];
  }
}
