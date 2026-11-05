// Clay hills: a domed brick kiln with a flickering fire mouth and a chimney that
// smokes, stacks of fired bricks and racks of drying clay bricks. On production
// the kiln flares: sparks, a burst of smoke and fresh bricks popping onto a stack.

import * as THREE from 'three/webgpu';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose } from '../geom';
import { pooled, tilePropMaterial } from '../materials';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import { shelter, type LifeContext, type LifeModule } from './common';
import { release } from '../release';
import { ease } from '../../util/tween';
import { lampColor, lampLevel } from '../../fx/lamps';
import { SURFACE } from '../surfaces';
import type { Lamp } from '../../fx/lampLights';
import { FOLK_SCALE } from './folk';

const FIRE = lampColor(1.6, 0.67, 0.12);
const heated = new THREE.Color();

const C = (h: string) => new THREE.Color(h);
const KILN_SCALE = 1.65;

function makeKiln(): { body: THREE.BufferGeometry; fire: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const brick = C('#a4522f');
  const brickDark = C('#7d3b22');
  // Brick dome, ring and chimney: mottled and sooted in the shader (true-size brick courses
  // would be a pixel tall at play distance).
  b.surfaceId = SURFACE.kiln;
  const dome = new THREE.SphereGeometry(0.07, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  b.addGeometry(dome, compose(0, 0.012, 0), (_x, y, _z, o) => o.copy(brick).lerp(brickDark, 0.18 + (y < 0.025 ? 0.2 : 0)));
  dome.dispose();
  const ring = new THREE.CylinderGeometry(0.074, 0.078, 0.014, 24);
  b.addGeometry(ring, compose(0, 0.007, 0), brickDark);
  ring.dispose();
  // Fire mouth arch (dark recess).
  b.surfaceId = SURFACE.plain;
  const mouth = new THREE.CylinderGeometry(0.022, 0.022, 0.02, 12, 1, false, 0, Math.PI);
  b.addGeometry(mouth, compose(0, 0.018, 0.062, Math.PI / 2, 0, Math.PI / 2), C('#2a160d'));
  mouth.dispose();
  // Chimney.
  b.surfaceId = SURFACE.kiln;
  const ch = new THREE.CylinderGeometry(0.014, 0.017, 0.07, 10);
  b.addGeometry(ch, compose(0.025, 0.1, -0.015), brick);
  ch.dispose();
  const lip = new THREE.CylinderGeometry(0.019, 0.019, 0.008, 10);
  b.addGeometry(lip, compose(0.025, 0.136, -0.015), brickDark);
  lip.dispose();
  b.surfaceId = SURFACE.plain;
  // Firewood stack beside the kiln.
  for (let i = 0; i < 5; i++) {
    const log = new THREE.CylinderGeometry(0.006, 0.006, 0.05, 6);
    b.addGeometry(log, compose(-0.075, 0.006 + Math.floor(i / 3) * 0.011, -0.02 + (i % 3) * 0.013 + Math.floor(i / 3) * 0.006, Math.PI / 2, 0.2, 0), C(i % 2 ? '#6b4a2c' : '#7c573a'));
    log.dispose();
  }
  const body = b.build(false);
  const f = new MeshBuilder();
  const glow = new THREE.CircleGeometry(0.019, 16, 0, Math.PI);
  f.addGeometry(glow, compose(0, 0.009, 0.0725), C('#ffffff'));
  glow.dispose();
  return { body, fire: f.build(false) };
}

function makeBrickStack(seed: number, layers = 4): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const pallet = new THREE.BoxGeometry(0.075, 0.008, 0.05);
  b.addGeometry(pallet, compose(0, 0.004, 0), C('#7a5636'));
  pallet.dispose();
  for (let l = 0; l < layers; l++) {
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BoxGeometry(l % 2 ? 0.068 : 0.022, 0.011, l % 2 ? 0.015 : 0.046);
      const x = l % 2 ? 0 : (i - 1) * 0.024;
      const z = l % 2 ? (i - 1) * 0.016 : 0;
      b.addGeometry(g, compose(x + r.range(-0.001, 0.001), 0.014 + l * 0.012, z, 0, r.range(-0.03, 0.03), 0), C('#b45a34').offsetHSL(0, 0, r.range(-0.06, 0.04)));
      g.dispose();
    }
  }
  return b.build(false);
}

/** Rows of moulded bricks laid out to dry on the ground. */
function makeBrickYard(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  for (let row = 0; row < 4; row++)
    for (let i = 0; i < 7; i++) {
      const g = new THREE.BoxGeometry(0.012, 0.006, 0.02);
      const wet = row < 2;
      b.addGeometry(g, compose(-0.045 + i * 0.015, 0.003, -0.036 + row * 0.024, 0, r.range(-0.08, 0.08), 0), C(wet ? '#a8653e' : '#c99a6c').offsetHSL(0, 0, r.range(-0.04, 0.04)));
      g.dispose();
    }
  return b.build(false);
}

/** A labourer (body only; the shovel is separate so it can dig). */
function makeDigger(): { body: THREE.BufferGeometry; tool: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const legs = new THREE.CylinderGeometry(0.0035, 0.004, 0.012, 6);
  b.addGeometry(legs, compose(0, 0.006, 0), C('#5a4636'));
  legs.dispose();
  const body = new THREE.CylinderGeometry(0.0045, 0.0055, 0.013, 8);
  b.addGeometry(body, compose(0, 0.018, 0), C('#d8c7a0'));
  body.dispose();
  const head = new THREE.SphereGeometry(0.0042, 8, 6);
  b.addGeometry(head, compose(0, 0.029, 0), C('#e2b48c'));
  head.dispose();
  const hat = new THREE.CylinderGeometry(0.003, 0.0075, 0.003, 10);
  b.addGeometry(hat, compose(0, 0.033, 0), C('#c9a75d'));
  hat.dispose();
  const t = new MeshBuilder();
  const handle = new THREE.BoxGeometry(0.0016, 0.0016, 0.02);
  t.addGeometry(handle, compose(0, 0, 0.01), C('#7c5a3a'));
  handle.dispose();
  const blade = new THREE.BoxGeometry(0.006, 0.001, 0.007);
  t.addGeometry(blade, compose(0, 0, 0.022), C('#6a6560'));
  blade.dispose();
  return { body: b.build(false), tool: t.build(false) };
}

function makeDryingRack(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const wood = C('#6e4e31');
  for (const x of [-0.05, 0.05])
    for (const z of [-0.018, 0.018]) {
      const post = new THREE.BoxGeometry(0.005, 0.03, 0.005);
      b.addGeometry(post, compose(x, 0.015, z), wood);
      post.dispose();
    }
  const shelf = new THREE.BoxGeometry(0.11, 0.004, 0.04);
  b.addGeometry(shelf, compose(0, 0.026, 0), wood);
  shelf.dispose();
  for (let i = 0; i < 6; i++) {
    const g = new THREE.BoxGeometry(0.014, 0.008, 0.026);
    b.addGeometry(g, compose(-0.04 + i * 0.016, 0.032, r.range(-0.004, 0.004)), C('#c9a374'));
    g.dispose();
  }
  return b.build(false);
}

interface Kiln {
  tile: TileInfo;
  root: THREE.Object3D;
  /** The fire mouth (a stand-in on WebGPU), and how its colour is set: its heat, the hour. */
  fire: THREE.Object3D;
  setFire(c: THREE.Color): void;
  smokeAt: THREE.Vector3;
  smokeTimer: number;
  flare: number;
  stacks: THREE.Object3D[];
  shovel: THREE.Object3D | null;
  glow: Lamp;
}

export class HillsLife implements LifeModule {
  /** How far the workers here have downed tools for the rain (see common.ts shelter). */
  private rest = 0;
  private tiles: TileInfo[] = [];
  private kilns: Kiln[] = [];
  private spots = new Map<number, { kiln: { x: number; z: number }; stacks: { x: number; z: number }[]; rack: { x: number; z: number } | null; yard: { x: number; z: number } | null }>();
  private disposables: { dispose(): void }[] = [];

  constructor(private ctx: LifeContext) {}

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'hills');
    const res: Reserved = [];
    for (const t of this.tiles) {
      const rnd = new Rand(t.shape.seed + 33);
      const pit = t.shape.features.pit;
      const find = (rad: number, avoid: { x: number; z: number; r: number }[]) => {
        for (let k = 0; k < 80; k++) {
          const a = rnd.range(0, Math.PI * 2);
          const r = rnd.range(0.38, 0.6);
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          if (!t.shape.canPlace(x, z, rad)) continue;
          if (pit && Math.hypot(x - pit.x, z - pit.z) < pit.r + rad) continue;
          if (avoid.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + rad)) continue;
          return { x, z };
        }
        return null;
      };
      const placed: { x: number; z: number; r: number }[] = [];
      // Exactly one kiln per tile, on the level yard the terrain left for it.
      const a = t.shape.features.anchor;
      const kiln = a ? { x: a.x, z: a.z } : (find(0.13, placed) ?? { x: 0.45, z: 0 });
      placed.push({ ...kiln, r: 0.13 });
      const stacks: { x: number; z: number }[] = [];
      for (let i = 0; i < 2 + rnd.int(2); i++) {
        const s = find(0.05, placed);
        if (s) {
          stacks.push(s);
          placed.push({ ...s, r: 0.05 });
        }
      }
      const rack = rnd.chance(0.8) ? find(0.065, placed) : null;
      if (rack) placed.push({ ...rack, r: 0.065 });
      const yard = find(0.08, placed);
      if (yard) placed.push({ ...yard, r: 0.08 });
      this.spots.set(t.hex.id, { kiln, stacks, rack, yard });
      for (const p of placed) res.push({ hex: t.hex.id, ...p });
      // Keep grass and rocks out of the clay pit.
      if (pit) res.push({ hex: t.hex.id, x: pit.x, z: pit.z, r: pit.r * 0.95 });
    }
    return res;
  }

  build() {
    const { effects, group, props } = this.ctx;
    const kilnGeo = makeKiln();
    const stackGeos = [makeBrickStack(1, 4), makeBrickStack(2, 3), makeBrickStack(3, 5)];
    const rackGeo = makeDryingRack(4);
    const yardGeo = makeBrickYard(6);
    const digger = makeDigger();
    this.disposables.push(kilnGeo.body, kilnGeo.fire, rackGeo, yardGeo, digger.body, digger.tool, ...stackGeos);
    for (const t of this.tiles) {
      const sp = this.spots.get(t.hex.id)!;
      const mat = tilePropMaterial(effects, t.hex.id, { roughness: 0.9 });
      this.disposables.push(mat);
      const root = new THREE.Group();
      const kilnMat = tilePropMaterial(effects, t.hex.id, { roughness: 0.9, surfaces: true });
      this.disposables.push(kilnMat);
      const kiln = props.mesh(kilnGeo.body, kilnMat);
      kiln.castShadow = kiln.receiveShadow = true;
      // Its colour is the kiln's heat: one batched glow on WebGPU, else a material of the tile's own
      // (kept from board to board).
      const lit = props.glow(kilnGeo.fire, FIRE);
      let fire: THREE.Object3D, setFire: (c: THREE.Color) => void;
      if (lit) ({ obj: fire, set: setFire } = lit);
      else {
        const fireMat = pooled(effects, `kilnFire:${t.hex.id}`, () => new THREE.MeshBasicNodeMaterial({ color: '#ff8a2a' }));
        this.disposables.push(fireMat);
        fire = new THREE.Mesh(kilnGeo.fire, fireMat);
        setFire = (c) => fireMat.color.copy(c);
      }
      root.add(kiln, fire);
      const y = t.shape.height(sp.kiln.x, sp.kiln.z) - 0.006;
      root.position.set(t.hex.x + sp.kiln.x, y, t.hex.z + sp.kiln.z);
      // Mouth faces outward-ish towards the default camera.
      root.rotation.y = Math.atan2(sp.kiln.x, 0.6 + sp.kiln.z) * 0.6;
      root.scale.setScalar(KILN_SCALE);
      group.add(root);
      const stacks: THREE.Object3D[] = [];
      sp.stacks.forEach((s, i) => {
        const m = props.mesh(stackGeos[i % 3], mat);
        m.position.set(t.hex.x + s.x, t.shape.height(s.x, s.z) - 0.003, t.hex.z + s.z);
        m.rotation.y = s.x * 9 + s.z * 4;
        m.scale.setScalar(1.7);
        m.castShadow = m.receiveShadow = true;
        group.add(m);
        stacks.push(m);
      });
      if (sp.rack) {
        const m = props.mesh(rackGeo, mat);
        m.position.set(t.hex.x + sp.rack.x, t.shape.height(sp.rack.x, sp.rack.z) - 0.003, t.hex.z + sp.rack.z);
        m.rotation.y = sp.rack.x * 7;
        m.scale.setScalar(1.35);
        m.castShadow = m.receiveShadow = true;
        group.add(m);
      }
      if (sp.yard) {
        const m = props.mesh(yardGeo, mat);
        m.position.set(t.hex.x + sp.yard.x, t.shape.height(sp.yard.x, sp.yard.z) - 0.001, t.hex.z + sp.yard.z);
        m.rotation.y = Math.atan2(sp.yard.x, sp.yard.z);
        m.scale.setScalar(1.6);
        m.receiveShadow = true;
        group.add(m);
      }
      // A digger working a bench of the clay pit, next to a full brick stack.
      let shovel: THREE.Object3D | null = null;
      const pit = t.shape.features.pit;
      if (pit) {
        const a = Math.atan2(-pit.z, -pit.x);
        const dx = pit.x + Math.cos(a) * pit.r * 0.45, dz = pit.z + Math.sin(a) * pit.r * 0.45;
        const man = new THREE.Group();
        const body = props.mesh(digger.body, mat);
        body.castShadow = true;
        man.add(body);
        const arm = new THREE.Group();
        arm.position.set(0.004, 0.02, 0);
        arm.add(props.mesh(digger.tool, mat));
        man.add(arm);
        man.position.set(t.hex.x + dx, t.shape.height(dx, dz) - 0.002, t.hex.z + dz);
        man.rotation.y = -a - Math.PI / 2;
        man.scale.setScalar(FOLK_SCALE);
        group.add(man);
        shovel = arm;
      }
      const smokeAt = new THREE.Vector3(0.025, 0.142, -0.015).multiplyScalar(KILN_SCALE).applyAxisAngle(new THREE.Vector3(0, 1, 0), root.rotation.y).add(root.position);
      // The fire lights the yard in front of the kiln mouth (it burns by day too, unseen in the sun).
      const glow = this.ctx.lamps.add(root, { x: 0, y: 0.025, z: 0.1 }, { color: FIRE, distance: 0.75, strength: 0.9, day: 0.6, flicker: 0 });
      this.kilns.push({ tile: t, root, fire, setFire, smokeAt, smokeTimer: Math.random(), flare: 0, stacks, shovel, glow });
    }
  }

  update(dt: number, t: number) {
    this.rest = shelter(this.rest, this.ctx.effects.rain.value, dt);
    for (const k of this.kilns) {
      const rise = this.ctx.effects.riseValues[k.tile.hex.id] ?? 0;
      const blighted = this.ctx.effects.get(k.tile.hex.id).y > 0.5;
      // (Out on a hex pollution has destroyed: the kiln is gone with everything else.)
      k.fire.visible = rise > -0.02 && (this.ctx.effects.scarValues[k.tile.hex.id] ?? 0) < 0.85;
      k.flare = Math.max(0, k.flare - dt * 0.7);
      if (k.shovel) {
        // Dig, lift, toss: a slow working rhythm (faster after production).
        const u = (t * (blighted ? 0.35 : 0.8) * (1 + k.flare) + k.tile.hex.id * 0.31) % 1;
        // (Planted in the clay through heavy rain: see shelter.)
        k.shovel.rotation.x = THREE.MathUtils.lerp(u < 0.5 ? 0.9 - u * 1.2 : 0.3 - Math.sin((u - 0.5) * Math.PI * 2) * 1.0, 0.9, this.rest);
      }
      const flicker = 0.75 + Math.sin(t * 13 + k.tile.hex.id) * 0.12 + Math.sin(t * 29) * 0.08;
      const heat = (blighted ? 0.25 : 1) * flicker + k.flare * 2.5;
      // A fire burns by day too, so its floor is high; at night it glows like every other light.
      k.setFire(heated.copy(FIRE).multiplyScalar(heat * lampLevel(this.ctx.effects.night.value, 0.85)));
      k.glow.gain = rise > -0.02 ? heat : 0;
      k.smokeTimer -= dt * (blighted ? 0.3 : 1) * (1 + k.flare * 4);
      if (k.smokeTimer <= 0 && rise > -0.05) {
        k.smokeTimer = 0.28 + Math.random() * 0.2;
        this.ctx.particles.smoke.emit({
          x: k.smokeAt.x,
          y: k.smokeAt.y + rise,
          z: k.smokeAt.z,
          vx: (Math.random() - 0.5) * 0.02,
          vy: 0.14 + Math.random() * 0.05,
          vz: (Math.random() - 0.5) * 0.02,
          life: 3.2 + Math.random(),
          size: 0.03,
          grow: 5,
          color: k.flare > 0.1 ? '#6a6460' : '#cfc9c2',
          alpha: 0.38,
          drag: 0.2,
          fadeIn: 0.15,
        });
      }
    }
  }

  produce(hex: number) {
    const k = this.kilns.find((x) => x.tile.hex.id === hex);
    if (!k) return;
    k.flare = 1;
    const mouth = new THREE.Vector3(0, 0.02, 0.09).multiplyScalar(KILN_SCALE).applyAxisAngle(new THREE.Vector3(0, 1, 0), k.root.rotation.y).add(k.root.position);
    for (let i = 0; i < 34; i++) {
      this.ctx.particles.sparkle.emit({
        x: mouth.x,
        y: mouth.y,
        z: mouth.z,
        vx: (Math.random() - 0.5) * 0.5,
        vy: 0.3 + Math.random() * 0.6,
        vz: (Math.random() - 0.5) * 0.5,
        life: 0.7 + Math.random() * 0.6,
        size: 0.018 + Math.random() * 0.015,
        grow: 0.2,
        color: Math.random() < 0.5 ? '#ffb347' : '#ff6a2a',
        gravity: 0.6,
        drag: 1.2,
      });
    }
    // Stacks hop as fresh bricks land.
    k.stacks.forEach((s, i) => {
      const y0 = s.position.y;
      const sc = s.scale.x;
      this.ctx.animator.tween({
        delay: 0.2 + i * 0.12,
        duration: 0.5,
        easing: ease.linear,
        update: (u) => {
          const b = Math.sin(u * Math.PI) * Math.exp(-u * 2);
          s.position.y = y0 + b * 0.03;
          s.scale.set(sc * (1 + b * 0.08), sc * (1 + b * 0.12), sc * (1 + b * 0.08));
        },
        done: () => {
          s.position.y = y0;
          s.scale.setScalar(sc);
        },
      });
    });
  }

  dispose() {
    // (Everything the island's life put on the board goes with it: see release.)
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.kilns = [];
  }
}
