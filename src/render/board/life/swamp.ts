// Swamp: a rickety boardwalk on posts runs in from the edge over the pools, a punt lies at its
// end, and a heron stands in the shallows, now and then striking at a fish. Mist drifts low over
// the water (more of it at night and in the rain), marsh gas bubbles up, and at night fireflies
// gather over the reeds in their dozens. When something here produces (the Oil module's well),
// the pools heave with gas, the mist rolls out and the heron strikes.

import * as THREE from 'three/webgpu';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose, smoothSphere } from '../geom';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import type { LifeContext, LifeModule } from './common';
import { release } from '../release';
import { rod } from './folk';
import { Parts, clearOfPieces, stillProps } from './props';
import { segDist } from '../layout';

const C = (h: string) => new THREE.Color(h);

/** A grey heron's body, legs and wings (the neck and head are separate, to strike), about 0.09 tall. */
function makeHeron(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const grey = C('#a7adb3'), wing = C('#6c727a'), leg = C('#8a7a4a');
  const body = smoothSphere(0.018, 2);
  body.scale(1.5, 0.9, 0.85);
  b.addGeometry(body, compose(0, 0.052, 0, 0, 0, 0.35), (x, y, _z, out) => out.copy(y > 0.056 && x < 0.01 ? wing : grey));
  body.dispose();
  // Folded wings and the tail, darker along the back.
  for (const s of [-1, 1]) {
    const w = smoothSphere(0.014, 1);
    w.scale(1.7, 0.45, 0.6);
    b.addGeometry(w, compose(-0.008, 0.058, s * 0.009, 0, 0, 0.35), wing);
    w.dispose();
  }
  const tail = new THREE.ConeGeometry(0.008, 0.02, 5);
  b.addGeometry(tail, compose(-0.03, 0.046, 0, 0, 0, 1.9), wing);
  tail.dispose();
  for (const s of [-1, 1]) {
    rod(b, new THREE.Vector3(0.002, 0.042, s * 0.005), new THREE.Vector3(0.004 + s * 0.002, 0.0, s * 0.006), 0.0013, leg);
    rod(b, new THREE.Vector3(0.004 + s * 0.002, 0.001, s * 0.006), new THREE.Vector3(0.014 + s * 0.002, 0.001, s * 0.008), 0.001, leg);
  }
  return b.build(false);
}

/** The heron's neck, head and bill, from its base on the shoulders (strikes by turning about z). */
function makeHeronNeck(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const white = C('#e4e6e2'), black = C('#25272a'), bill = C('#d9a23a');
  // An S-curve of short segments.
  const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.008, 0.012, 0), new THREE.Vector3(0.004, 0.024, 0), new THREE.Vector3(0.01, 0.034, 0)];
  for (let i = 0; i + 1 < pts.length; i++) rod(b, pts[i], pts[i + 1], 0.0042 - i * 0.0007, white);
  const head = smoothSphere(0.0052, 1);
  head.scale(1.3, 1, 0.9);
  b.addGeometry(head, compose(0.012, 0.036, 0), white);
  head.dispose();
  const crest = new THREE.ConeGeometry(0.0015, 0.014, 4);
  b.addGeometry(crest, compose(0.004, 0.038, 0, 0, 0, 1.75), black);
  crest.dispose();
  const beak = new THREE.ConeGeometry(0.0022, 0.024, 5);
  b.addGeometry(beak, compose(0.028, 0.035, 0, 0, 0, -Math.PI / 2 - 0.08), bill);
  beak.dispose();
  const eye = smoothSphere(0.001, 0);
  for (const s of [-1, 1]) b.addGeometry(eye, compose(0.015, 0.0375, s * 0.004), black);
  eye.dispose();
  return b.build(false);
}

interface Marsh {
  tile: TileInfo;
  heron: THREE.Group;
  neck: THREE.Object3D;
  /** Pools' points (tile-local) where mist rises, gas bubbles and fireflies gather. */
  wet: { x: number; z: number; y: number }[];
  margins: { x: number; z: number; y: number }[];
  strike: number;
  next: number;
  stir: number;
  mistTimer: number;
  gasTimer: number;
  flyTimer: number;
  rnd: Rand;
}

export class SwampLife implements LifeModule {
  private tiles: TileInfo[] = [];
  private marshes: Marsh[] = [];
  private walks = new Map<number, { a: number; from: number; to: number }>();
  private disposables: { dispose(): void }[] = [];
  private parts: Parts;

  constructor(private ctx: LifeContext) {
    this.parts = new Parts(ctx.effects, ctx.props);
  }

  /** Distance from a point to the swamp's river channel (Infinity where no river runs). */
  private chan(t: TileInfo, x: number, z: number) {
    const ch = t.shape.features.channel ?? [];
    let d = Infinity;
    for (let i = 0; i + 1 < ch.length; i++) d = Math.min(d, segDist(x, z, ch[i].x, ch[i].z, ch[i + 1].x, ch[i + 1].z));
    return d;
  }

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'swamp');
    const res: Reserved = [];
    for (const t of this.tiles) {
      // The boardwalk comes in from whichever side lies furthest from the river's channel, and
      // clear of an oil well's pad (Oil puts its numbered well on a swamp where there's no desert).
      const pad = t.shape.ctx.pad;
      let best = { a: 0, score: -Infinity };
      for (let i = 0; i < 6; i++) {
        const a = ((-60 + 60 * i) * Math.PI) / 180 + 0.18;
        let near = Infinity;
        for (let r = 0.4; r <= 0.72; r += 0.04) {
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          near = Math.min(near, this.chan(t, x, z), pad ? (Math.hypot(x - pad.x, z - pad.z) - pad.r) * 1.5 : Infinity);
          // (Where a piece may come to stand, a raider or a warden, counts as close too.)
          if (!clearOfPieces(this.ctx.anchors, t.hex.id, x, z, 0.03)) near = Math.min(near, 0.02);
        }
        const score = Math.min(near, 1) + (t.shape.ctx.landSide[i] ? 0.2 : 0) + new Rand(t.shape.seed + i).range(0, 0.1);
        if (score > best.score) best = { a, score };
      }
      const walk = { a: best.a, from: 0.74, to: 0.4 };
      this.walks.set(t.hex.id, walk);
      for (let r = walk.to; r <= walk.from; r += 0.06) res.push({ hex: t.hex.id, x: Math.cos(walk.a) * r, z: Math.sin(walk.a) * r, r: 0.05 });
    }
    return res;
  }

  build() {
    const { effects, group } = this.ctx;
    const heronGeo = makeHeron();
    const neckGeo = makeHeronNeck();
    this.disposables.push(heronGeo, neckGeo);
    // Every swamp's boardwalk and punt in one mesh.
    const still = this.tiles.map((t) => ({ geo: this.buildStatic(t), hex: t.hex }));
    const mesh = stillProps(effects, still, this.disposables);
    still.forEach((p) => p.geo.dispose());
    if (mesh) group.add(mesh);
    for (const t of this.tiles) {
      const rnd = new Rand(t.shape.seed * 53 + 3);
      const depth = (x: number, z: number) => t.shape.features.water!.depth(x, z);
      // Sample the tile: open water for mist and gas, its margins for fireflies, a shallow for the heron.
      const wet: Marsh['wet'] = [], margins: Marsh['margins'] = [];
      let stand: { x: number; z: number } | null = null;
      const walk = this.walks.get(t.hex.id)!;
      for (let k = 0; k < 400; k++) {
        const a = rnd.range(0, Math.PI * 2), r = rnd.range(0.3, 0.78);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (!t.shape.canPlace(x, z, 0)) continue;
        const d = depth(x, z);
        const y = t.shape.height(x, z);
        if (d > 0.006 && wet.length < 24) wet.push({ x, z, y });
        else if (d > -0.02 && d < 0.004 && margins.length < 40) margins.push({ x, z, y });
        const offWalk = Math.abs(Math.sin(a - walk.a)) * r > 0.12 || Math.cos(a - walk.a) < 0;
        if (!stand && d > 0.002 && d < 0.022 && offWalk && this.chan(t, x, z) > 0.05 && t.shape.canPlace(x, z, 0.04) && clearOfPieces(this.ctx.anchors, t.hex.id, x, z, 0.04)) stand = { x, z };
      }
      const heron = new THREE.Group();
      const sp = stand ?? { x: Math.cos(walk.a + 2) * 0.55, z: Math.sin(walk.a + 2) * 0.55 };
      heron.position.set(t.hex.x + sp.x, t.shape.height(sp.x, sp.z) - 0.004, t.hex.z + sp.z);
      heron.rotation.y = rnd.range(0, Math.PI * 2);
      // (About a person's height, as the island's animals go: see pasture.ts on sizes.)
      heron.scale.setScalar(0.85);
      const body = new THREE.Group();
      heron.add(body);
      const neck = new THREE.Group();
      neck.position.set(0.02, 0.062, 0);
      heron.add(neck);
      group.add(heron);
      this.parts.add(heronGeo, body, t.hex.id, true);
      this.parts.add(neckGeo, neck, t.hex.id);
      this.marshes.push({ tile: t, heron, neck, wet, margins, strike: 0, next: rnd.range(3, 9), stir: 0, mistTimer: rnd.range(0, 1), gasTimer: rnd.range(1, 4), flyTimer: 0, rnd });
    }
  }

  /** The boardwalk, its posts and a punt at its end, in one mesh (tile-local x and z, world y). */
  private buildStatic(t: TileInfo): THREE.BufferGeometry {
    const b = new MeshBuilder();
    const walk = this.walks.get(t.hex.id)!;
    const level = t.shape.features.water!.level;
    const rnd = new Rand(t.shape.seed * 11 + 5);
    const dir = new THREE.Vector3(-Math.cos(walk.a), 0, -Math.sin(walk.a));
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    const start = new THREE.Vector3(Math.cos(walk.a) * walk.from, 0, Math.sin(walk.a) * walk.from);
    const len = walk.from - walk.to;
    const old = C('#6e5a45'), grey = C('#8a7f70'), dark = C('#3e3226');
    // The deck rides just clear of the water, or rests on the tussocks where they stand higher.
    const deck = (u: number) => {
      const p = start.clone().addScaledVector(dir, u);
      return p.setY(Math.max(level + 0.016, t.shape.height(p.x, p.z) + 0.006) + Math.sin(u * 23) * 0.002);
    };
    for (const sd of [-1, 1]) {
      for (let u = 0; u < len; u += 0.06) {
        const a = deck(u).addScaledVector(across, sd * 0.022).setY(deck(u).y - 0.005);
        const c = deck(Math.min(len, u + 0.06)).addScaledVector(across, sd * 0.022);
        rod(b, a, c.setY(c.y - 0.005), 0.004, dark, 0.004, 'flat');
      }
    }
    for (let u = 0.004; u < len; u += 0.017) {
      // A plank or two gone, others askew: it has stood here a long time.
      if (rnd.chance(0.07)) continue;
      const p = deck(u);
      const skew = rnd.range(-0.12, 0.12);
      const ax = across.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), skew);
      rod(b, p.clone().addScaledVector(ax, -0.03), p.clone().addScaledVector(ax, 0.03).setY(p.y + rnd.range(-0.002, 0.002)), 0.012, rnd.chance(0.5) ? old : grey, 0.0028, 'flat');
    }
    for (let u = 0.02; u < len; u += 0.08)
      for (const sd of [-1, 1]) {
        const p = deck(u).addScaledVector(across, sd * 0.026);
        rod(b, p.clone().setY(p.y + 0.01), p.clone().setY(Math.min(level, t.shape.height(p.x, p.z)) - 0.01), 0.0032, dark);
      }
    // A punt moored at the end, low in the water, and a pole leaning on the rail.
    const end = deck(len).addScaledVector(dir, 0.05).addScaledVector(across, 0.03);
    const hull = new THREE.BoxGeometry(0.11, 0.012, 0.038);
    const yaw = -Math.atan2(across.z, across.x) + rnd.range(-0.3, 0.3);
    b.addGeometry(hull, compose(end.x, level + 0.002, end.z, 0, yaw, 0), dark);
    hull.dispose();
    const inside = new THREE.BoxGeometry(0.098, 0.004, 0.028);
    b.addGeometry(inside, compose(end.x, level + 0.0085, end.z, 0, yaw, 0), C('#5a4836'));
    inside.dispose();
    const tip = deck(len);
    rod(b, tip.clone().addScaledVector(across, -0.03).setY(tip.y - 0.01), tip.clone().addScaledVector(across, -0.02).addScaledVector(dir, 0.03).setY(tip.y + 0.13), 0.0018, grey);
    // A few old mooring posts standing out of the pools.
    for (let k = 0; k < 3; k++) {
      const a = walk.a + rnd.range(0.6, 2.4) * (k % 2 ? 1 : -1), r = rnd.range(0.42, 0.7);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (t.shape.features.water!.depth(x, z) < 0.004 || this.chan(t, x, z) < 0.05 || !t.shape.canPlace(x, z, 0.01) || !clearOfPieces(this.ctx.anchors, t.hex.id, x, z, 0.02)) continue;
      rod(b, new THREE.Vector3(x, level - 0.01, z), new THREE.Vector3(x + rnd.range(-0.01, 0.01), level + rnd.range(0.03, 0.06), z), 0.004, grey);
    }
    return b.build(false);
  }

  update(dt: number, t: number) {
    const { effects, particles } = this.ctx;
    const night = effects.night.value;
    for (const m of this.marshes) {
      const id = m.tile.hex.id;
      const rise = effects.riseValues[id] ?? 0;
      // (A hex pollution has destroyed is dead water: no heron, no mist off it, nothing alight.)
      const alive = (effects.scarValues[id] ?? 0) < 0.85;
      m.heron.visible = rise > -0.1 && alive;
      if (rise < -0.05 || !alive) continue;
      const lift = Math.max(0, rise);
      const ox = m.tile.hex.x, oz = m.tile.hex.z;
      m.stir = Math.max(0, m.stir - dt * 0.4);
      // The heron waits, neck drawn back, then darts its bill into the water and recovers.
      if ((m.next -= dt) <= 0 && m.strike <= 0) {
        m.strike = 1;
        m.next = m.rnd.range(5, 14);
      }
      if (m.strike > 0) {
        m.strike = Math.max(0, m.strike - dt * 1.4);
        const u = 1 - m.strike;
        const dart = u < 0.18 ? u / 0.18 : u < 0.4 ? 1 : Math.max(0, 1 - (u - 0.4) / 0.6);
        m.neck.rotation.z = -1.25 * dart;
        m.neck.position.x = 0.02 + dart * 0.008;
        if (u > 0.17 && u < 0.2) {
          const tip = new THREE.Vector3(0.05, 0.0, 0).applyMatrix4(m.heron.matrixWorld);
          for (let i = 0; i < 6; i++)
            particles.spray.emit({ x: tip.x, y: m.heron.position.y + 0.006, z: tip.z, vx: (Math.random() - 0.5) * 0.12, vy: 0.12 + Math.random() * 0.1, vz: (Math.random() - 0.5) * 0.12, life: 0.6, size: 0.006, color: '#eef6f9', alpha: 0.8, gravity: 1.8, drag: 0.3, floor: m.heron.position.y });
        }
      } else {
        // A slow sway of the head while it watches.
        m.neck.rotation.z = Math.sin(t * 0.6 + id) * 0.06;
        m.neck.rotation.y = Math.sin(t * 0.23 + id * 2) * 0.35;
      }
      // Low mist drifts off the pools: more by night and in the rain, rolling out when stirred.
      // (By day too: a thin, low sheet that hangs over the pools and names the place from the table.)
      const misty = 0.9 + night * 0.5 + effects.wet.value * 0.5 + m.stir * 3;
      if (m.wet.length && (m.mistTimer -= dt * misty) <= 0) {
        m.mistTimer = 0.3 + m.rnd.range(0, 0.3);
        const p = m.wet[m.rnd.int(m.wet.length)];
        particles.mist.emit({
          x: ox + p.x, y: p.y + 0.015 + lift, z: oz + p.z,
          vx: (Math.random() - 0.5) * 0.02, vy: 0.004, vz: (Math.random() - 0.5) * 0.02,
          life: 6 + Math.random() * 3, size: 0.26 + Math.random() * 0.12, grow: 1.5, color: '#e6ece6', alpha: 0.1 + night * 0.03, drag: 0.4, fadeIn: 0.35,
        });
      }
      // Marsh gas: a few bubbles breaking the surface here and there.
      if (m.wet.length && (m.gasTimer -= dt * (1 + m.stir * 12)) <= 0) {
        m.gasTimer = m.rnd.range(1.5, 4.5);
        const p = m.wet[m.rnd.int(m.wet.length)];
        for (let i = 0; i < 3; i++)
          particles.spray.emit({ x: ox + p.x + (Math.random() - 0.5) * 0.01, y: p.y + lift, z: oz + p.z + (Math.random() - 0.5) * 0.01, vx: 0, vy: 0.05 + Math.random() * 0.05, vz: 0, life: 0.35, size: 0.005, color: '#dfe6da', alpha: 0.7, gravity: 0.6, drag: 0.5 });
      }
      // Fireflies over the reeds at night: the swamp is where they gather most.
      if (night > 0.3 && m.margins.length) {
        m.flyTimer -= dt;
        while (m.flyTimer <= 0) {
          m.flyTimer += 0.045 / night;
          const p = m.margins[m.rnd.int(m.margins.length)];
          particles.sparkle.emit({
            x: ox + p.x + (Math.random() - 0.5) * 0.06, y: p.y + 0.03 + Math.random() * 0.12 + lift, z: oz + p.z + (Math.random() - 0.5) * 0.06,
            vx: (Math.random() - 0.5) * 0.05, vy: (Math.random() - 0.4) * 0.03, vz: (Math.random() - 0.5) * 0.05,
            life: 1.2 + Math.random() * 1.6, size: 0.026, grow: 1, color: Math.random() < 0.8 ? '#d9ff7a' : '#fff3a0', fadeIn: 0.45, drag: 0.25,
          });
        }
      }
    }
  }

  produce(hex: number) {
    const m = this.marshes.find((x) => x.tile.hex.id === hex);
    if (!m) return;
    m.stir = 1;
    m.strike = 1;
    m.next = 8;
    const ox = m.tile.hex.x, oz = m.tile.hex.z;
    for (const p of m.wet.slice(0, 10))
      for (let i = 0; i < 4; i++)
        this.ctx.particles.spray.emit({ x: ox + p.x, y: p.y, z: oz + p.z, vx: (Math.random() - 0.5) * 0.06, vy: 0.1 + Math.random() * 0.1, vz: (Math.random() - 0.5) * 0.06, life: 0.5, size: 0.007, color: '#e4eadc', alpha: 0.8, gravity: 1.2, drag: 0.4 });
  }

  dispose() {
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.parts.dispose();
    this.marshes = [];
  }
}
