// The lake: its four number discs ride log rafts moored together round an islet in its middle,
// and a fisher's hut stands on the far shore with a net drying beside it. A jetty runs out from the far shore on its piles, a
// rowing boat rides at its end, and a fisher sits on the boards with a rod out over the water.
// Ducks paddle about the lake and a pair of swallows skim low over it. When the lake yields (on a
// 2, 3, 11 or 12), fish leap silver out of the water, the fisher's rod bends to a catch and the
// ducks scatter.

import * as THREE from 'three/webgpu';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose, smoothSphere } from '../geom';
import { SURFACE } from '../surfaces';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import type { LifeContext, LifeModule } from './common';
import { release } from '../release';
import { FOLK_SCALE, makeFolk, rod } from './folk';
import { Parts, stillProps } from './props';
import { LAKE_ISLET_RADIUS, TOKEN_RADIUS, discSpots } from '../discSpots';
import { easeAngle, follow } from '../../util/angle';
import { WINDOW_LIGHT, lampColor } from '../../fx/lamps';
import type { Lamp } from '../../fx/lampLights';

const HUT_WINDOW = lampColor(...WINDOW_LIGHT);
/** How fast the fisher walks home and back (world units a second, about a traveller's pace). */
const FISHER_PACE = 0.045;

const _here = new THREE.Vector3(), _ahead = new THREE.Vector3();

/** The length of a route of points. */
function routeLength(route: THREE.Vector3[]): number {
  let n = 0;
  for (let i = 1; i < route.length; i++) n += route[i].distanceTo(route[i - 1]);
  return n;
}

/** The point `d` along a route (into `at`), and the way the route runs there (into `dir`, xz). */
function along(route: THREE.Vector3[], d: number, at: THREE.Vector3, dir: THREE.Vector3) {
  for (let i = 1; i < route.length; i++) {
    const seg = route[i].distanceTo(route[i - 1]);
    if (d <= seg || i === route.length - 1) {
      const u = seg > 0 ? Math.min(1, d / seg) : 1;
      at.lerpVectors(route[i - 1], route[i], u);
      dir.subVectors(route[i], route[i - 1]).setY(0);
      return;
    }
    d -= seg;
  }
  at.copy(route[0]);
  dir.set(1, 0, 0);
}

const C = (h: string) => new THREE.Color(h);
const FISHER = { coat: '#4f6a5a', legs: '#5a4a3a', hat: 'cap' as const, hatColor: '#8a3a2a', kneel: true };

/** A rowing boat about 0.12 long: a planked bowl of a hull, its inside darker, two thwarts and the oars shipped. */
function makeBoat(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.surfaceId = SURFACE.planks;
  const outer = new THREE.SphereGeometry(1, 14, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  b.addGeometry(outer, compose(0, 0.018, 0, 0, 0, 0, 0.06, 0.022, 0.024), (_x, y, _z, out) => out.set(y > 0.012 ? '#6e4a2c' : '#3e5a6a'));
  outer.dispose();
  // The inside, facing up: the same bowl a touch smaller with its faces wound the other way (the
  // outer bowl faces out and down, so from above only this one is seen).
  const inner = new THREE.SphereGeometry(1, 14, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const idx = inner.getIndex()!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    idx.setX(i, idx.getX(i + 1));
    idx.setX(i + 1, a);
  }
  inner.computeVertexNormals();
  b.addGeometry(inner, compose(0, 0.019, 0, 0, 0, 0, 0.056, 0.019, 0.021), C('#8a6a48'));
  inner.dispose();
  b.surfaceId = 0;
  for (const x of [-0.018, 0.016]) {
    const th = new THREE.BoxGeometry(0.008, 0.002, 0.042);
    b.addGeometry(th, compose(x, 0.014, 0), C('#9a7a52'));
    th.dispose();
  }
  for (const s of [-1, 1]) rod(b, new THREE.Vector3(-0.04, 0.017, s * 0.012), new THREE.Vector3(0.045, 0.016, s * 0.016), 0.0013, C('#b08a5a'));
  return b.build(false);
}

/** The fisher's rod, from the hands out over the water, its line and float (pivots at the butt). */
function makeRod(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  rod(b, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.11, 0.05, 0), 0.0012, C('#6a4a2a'));
  rod(b, new THREE.Vector3(0.11, 0.05, 0), new THREE.Vector3(0.12, -0.035, 0), 0.0003, C('#e8e4da'));
  const float = smoothSphere(0.0028, 1);
  b.addGeometry(float, compose(0.12, -0.035, 0), C('#d8402a'));
  float.dispose();
  return b.build(false);
}

/** A mallard drake about 0.03 long, facing +x, sitting on the water at y = 0. */
function makeDuck(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const body = smoothSphere(0.008, 1);
  body.scale(1.6, 0.8, 1);
  b.addGeometry(body, compose(0, 0.004, 0), (x, _y, _z, out) => out.set(x > 0.006 ? '#7a5a44' : x < -0.008 ? '#3a3a3e' : '#b8b2a6'));
  body.dispose();
  const head = smoothSphere(0.0045, 1);
  b.addGeometry(head, compose(0.011, 0.011, 0), C('#2f6a3a'));
  head.dispose();
  const bill = new THREE.ConeGeometry(0.0018, 0.006, 4);
  b.addGeometry(bill, compose(0.017, 0.0105, 0, 0, 0, -Math.PI / 2), C('#e0b030'));
  bill.dispose();
  const ring = new THREE.TorusGeometry(0.0038, 0.0008, 4, 8);
  b.addGeometry(ring, compose(0.0095, 0.0075, 0, Math.PI / 2, 0, 0.4), C('#f0f0ea'));
  ring.dispose();
  return b.build(false);
}

/** A swallow gliding, about 0.03 across the wings, facing +x. */
function makeSwallow(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const back = C('#2a3048'), belly = C('#e8dcc8');
  const body = smoothSphere(0.003, 1);
  body.scale(2.2, 0.9, 0.9);
  b.addGeometry(body, compose(0, 0, 0), (_x, y, _z, out) => out.copy(y > 0 ? back : belly));
  body.dispose();
  for (const s of [-1, 1]) {
    const a = b.vertex(0.003, 0.0006, 0, back), c = b.vertex(-0.004, 0.0006, s * 0.002, back), d = b.vertex(-0.006, 0.002, s * 0.016, back);
    if (s > 0) b.tri(a, c, d);
    else b.tri(a, d, c);
    const a2 = b.vertex(0.003, 0.0004, 0, back, 0, -1, 0), c2 = b.vertex(-0.004, 0.0004, s * 0.002, back, 0, -1, 0), d2 = b.vertex(-0.006, 0.0018, s * 0.016, back, 0, -1, 0);
    if (s > 0) b.tri(a2, d2, c2);
    else b.tri(a2, c2, d2);
    // The forked tail.
    const t0 = b.vertex(-0.005, 0.0004, 0, back), t1 = b.vertex(-0.013, 0.0004, s * 0.004, back), t2 = b.vertex(-0.009, 0.0004, 0, back);
    b.tri(t0, s > 0 ? t2 : t1, s > 0 ? t1 : t2);
    b.tri(t0, s > 0 ? t1 : t2, s > 0 ? t2 : t1);
  }
  return b.build(false);
}

/** A fish arcing out of the water, about 0.03 long, facing +x. */
function makeFish(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const body = smoothSphere(0.006, 1);
  body.scale(2.4, 1, 0.6);
  b.addGeometry(body, compose(0, 0, 0), (_x, y, _z, out) => out.set(y > 0.002 ? '#5e7a86' : '#d8e2e6'));
  body.dispose();
  const tail = new THREE.ConeGeometry(0.004, 0.008, 4);
  b.addGeometry(tail, compose(-0.017, 0, 0, 0, 0, Math.PI / 2, 1, 1, 0.3), C('#5e7a86'));
  tail.dispose();
  return b.build(false);
}

interface Swimmer {
  lake: Pond;
  node: THREE.Object3D;
  x: number;
  z: number;
  yaw: number;
  to: { x: number; z: number };
  speed: number;
  wait: number;
  scare: number;
  /** Rain: under for a dive (seconds left), and until the next one. */
  dive: number;
  nextDive: number;
}

interface Pond {
  tile: TileInfo;
  level: number;
  boat: THREE.Object3D;
  boatY: number;
  rod: THREE.Object3D;
  fisher: THREE.Object3D;
  /** Open water (tile-local) where ducks may paddle and fish leap. */
  water: { x: number; z: number }[];
  fish: { mesh: THREE.Object3D; t: number; from: THREE.Vector3; to: THREE.Vector3; delay: number }[];
  bite: number;
  rnd: Rand;
  /**
   * The fisher's day: fishing off the jetty, walking home along the shore after dusk, home (the
   * hut's window lit), and walking back out at dawn. `walker` is the fisher standing, `route` the
   * way home (world points, from the jetty's end), `at` how far along it they are.
   */
  trip: 'out' | 'leaving' | 'home' | 'returning';
  walker: THREE.Object3D;
  route: THREE.Vector3[];
  at: number;
  window: Lamp | null;
  /** Where the ducks roost for the night: the open water nearest the hut's shore (tile-local). */
  roost: { x: number; z: number } | null;
}

export class LakeLife implements LifeModule {
  private tiles: TileInfo[] = [];
  private ponds: Pond[] = [];
  /** Each lake's rafts, by the disc they carry (the `i`th of the hex's discs on show). */
  private raftNodes: { hex: number; i: number; node: THREE.Group; sunk: number }[] = [];
  private ducks: Swimmer[] = [];
  private swallows: { pond: Pond; node: THREE.Object3D; phase: number }[] = [];
  private disposables: { dispose(): void }[] = [];
  private parts: Parts;

  constructor(private ctx: LifeContext) {
    this.parts = new Parts(ctx.effects, ctx.props);
  }

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'lake');
    const res: Reserved = [];
    for (const t of this.tiles) {
      const j = t.shape.features.sites!.jetty;
      for (let i = 0; i <= 5; i++) res.push({ hex: t.hex.id, x: j.x + Math.cos(j.a!) * i * 0.045, z: j.z + Math.sin(j.a!) * i * 0.045, r: 0.07 });
      // The rafts and their mooring posts, and the fisher's hut on the shore.
      for (const r of this.rafts(t)) res.push({ hex: t.hex.id, x: r.x, z: r.z, r: r.r + 0.03 }, { hex: t.hex.id, x: r.post.x, z: r.post.z, r: 0.03 });
      const hut = this.hut(t);
      if (hut) res.push({ hex: t.hex.id, x: hut.x, z: hut.z, r: 0.09 });
    }
    return res;
  }

  /** The rafts the discs float on (see discSpots.ts), each moored to a post on the islet in the middle. */
  private rafts(t: TileInfo) {
    return discSpots(Math.min(4, t.shape.ctx.discs ?? 0), 'lake').map((d) => {
      const a = Math.atan2(d.z, d.x);
      const r = TOKEN_RADIUS * d.s + 0.016;
      const pr = LAKE_ISLET_RADIUS * 0.75;
      return { x: d.x, z: d.z, a, r, post: { x: Math.cos(a + 0.25) * pr, z: Math.sin(a + 0.25) * pr } };
    });
  }

  /**
   * The fisher's hut: on the far shore behind the rafts, facing the table, on the first dry ground
   * with room for it and its net (null if the shore has none, as on a crowded hex).
   */
  private hut(t: TileInfo) {
    if (!(t.shape.ctx.discs ?? 0)) return null;
    const { depth } = t.shape.features.water!;
    const j = t.shape.features.sites!.jetty;
    const dry = (x: number, z: number) => depth(x, z) < -0.008;
    for (const da of [0, 0.18, -0.18, 0.36, -0.36]) {
      const a = -Math.PI / 2 + da;
      for (let r = 0.56; r <= 0.76; r += 0.02) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (Math.hypot(x - j.x, z - j.z) < 0.25) continue;
        if ([[0, 0], [0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.04], [0.1, 0.01]].every(([dx, dz]) => dry(x + dx, z + dz))) return { x, z, a: Math.PI / 2 };
      }
    }
    return null;
  }

  /** The jetty's run: from its foot on the shore inwards over the water. */
  private jetty(t: TileInfo) {
    const j = t.shape.features.sites!.jetty;
    const dir = new THREE.Vector3(Math.cos(j.a!), 0, Math.sin(j.a!));
    return { foot: new THREE.Vector3(j.x, 0, j.z).addScaledVector(dir, -0.03), dir, across: new THREE.Vector3(-dir.z, 0, dir.x), len: 0.22 };
  }

  build() {
    const { effects, group } = this.ctx;
    const boatGeo = makeBoat(), rodGeo = makeRod(), fishGeo = makeFish();
    this.disposables.push(boatGeo, rodGeo, fishGeo);
    const duckGeo = makeDuck(), swallowGeo = makeSwallow(), fisherGeo = makeFolk(FISHER), walkerGeo = makeFolk({ ...FISHER, kneel: false });
    this.disposables.push(duckGeo, swallowGeo, fisherGeo, walkerGeo);
    // Every lake's jetty and fisher in one mesh.
    const still = this.tiles.map((t) => ({ geo: this.buildStatic(t), hex: t.hex }));
    const mesh = stillProps(effects, still, this.disposables);
    still.forEach((p) => p.geo.dispose());
    if (mesh) group.add(mesh);
    for (const t of this.tiles) {
      const level = t.shape.features.water!.level;
      const raftRnd = new Rand(t.shape.seed * 41 + 3);
      this.rafts(t).forEach((r, i) => {
        const geo = this.raftGeometry(t, r, raftRnd);
        this.disposables.push(geo);
        const node = new THREE.Group();
        node.position.set(t.hex.x + r.x, 0, t.hex.z + r.z);
        group.add(node);
        this.parts.add(geo, node, t.hex.id);
        this.raftNodes.push({ hex: t.hex.id, i, node, sunk: 0 });
      });
      const jt = this.jetty(t);
      const end = jt.foot.clone().addScaledVector(jt.dir, jt.len);
      const rnd = new Rand(t.shape.seed * 13 + 7);
      // The boat rides alongside the jetty's end, bow towards the shore.
      const boat = new THREE.Group();
      const bp = end.clone().addScaledVector(jt.across, 0.05).addScaledVector(jt.dir, -0.04);
      boat.position.set(t.hex.x + bp.x, level - 0.006, t.hex.z + bp.z);
      boat.rotation.y = -Math.atan2(-jt.dir.z, -jt.dir.x) + 0.15;
      group.add(boat);
      this.parts.add(boatGeo, boat, t.hex.id);
      // The fisher's rod, held out over the water beyond the end.
      const rodMesh = new THREE.Group();
      const seat = end.clone().addScaledVector(jt.dir, -0.012).addScaledVector(jt.across, -0.012);
      // (In the fisher's hands, which are as high as the fisher is tall.)
      rodMesh.position.set(t.hex.x + seat.x + jt.dir.x * 0.012, level + 0.016 + 0.03 * (FOLK_SCALE / 2.1), t.hex.z + seat.z + jt.dir.z * 0.012);
      rodMesh.rotation.y = -Math.atan2(jt.dir.z, jt.dir.x) + 0.35;
      group.add(rodMesh);
      this.parts.add(rodGeo, rodMesh, t.hex.id);
      // The fisher sitting on the boards (apart from the jetty, so a destroyed hex can be left empty).
      const fisher = new THREE.Group();
      fisher.position.set(t.hex.x + seat.x, level + 0.018, t.hex.z + seat.z);
      fisher.rotation.y = -Math.atan2(jt.dir.z, jt.dir.x);
      fisher.scale.setScalar(FOLK_SCALE);
      group.add(fisher);
      this.parts.add(fisherGeo, fisher, t.hex.id);
      const water: Pond['water'] = [];
      const rafts = this.rafts(t);
      for (let k = 0; k < 300 && water.length < 30; k++) {
        const a = rnd.range(0, Math.PI * 2), r = rnd.range(0.35, 0.72);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (t.shape.features.water!.depth(x, z) > 0.03 && end.distanceTo(new THREE.Vector3(x, 0, z)) > 0.1 && rafts.every((r) => Math.hypot(x - r.x, z - r.z) > r.r + 0.06)) water.push({ x, z });
      }
      const fish = [0, 1, 2].map(() => {
        const f = new THREE.Group();
        f.visible = false;
        // (As long as the island's other fish, against its people: see pasture.ts on sizes.)
        f.scale.setScalar(1.23);
        group.add(f);
        this.parts.add(fishGeo, f, t.hex.id);
        return { mesh: f, t: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), delay: 0 };
      });
      // The fisher on the way home or back: standing, hidden while fishing or indoors.
      const walker = new THREE.Group();
      walker.scale.setScalar(FOLK_SCALE);
      walker.visible = false;
      group.add(walker);
      this.parts.add(walkerGeo, walker, t.hex.id);
      const hut = this.hut(t);
      const route = this.homeward(t, seat, jt, hut);
      const window = hut ? this.ctx.lamps.add(group, { x: t.hex.x + hut.x + 0.018, y: t.shape.height(hut.x, hut.z) + 0.026, z: t.hex.z + hut.z + 0.034 }, { color: HUT_WINDOW, distance: 0.2, strength: 0.22 }) : null;
      if (window) window.gain = 0;
      const roost = water.length ? water.reduce((a, w) => (hut && Math.hypot(w.x - hut.x, w.z - hut.z) < Math.hypot(a.x - hut.x, a.z - hut.z) ? w : a)) : null;
      // (A game resumed after dark finds the fisher home.)
      const home = effects.night.value > 0.62;
      const pond: Pond = { tile: t, level, boat, boatY: boat.position.y, rod: rodMesh, fisher, water, fish, bite: 0, rnd, trip: home ? 'home' : 'out', walker, route, at: home ? routeLength(route) : 0, window, roost };
      if (window && home) window.gain = 1;
      this.ponds.push(pond);
      for (let d = 0; d < 3 && water.length; d++) {
        const p = water[rnd.int(water.length)];
        const node = new THREE.Group();
        node.scale.setScalar(1.3);
        group.add(node);
        this.parts.add(duckGeo, node, t.hex.id, true);
        this.ducks.push({ lake: pond, node, x: p.x, z: p.z, yaw: rnd.range(0, 6.28), to: p, speed: 0.025, wait: rnd.range(0, 4), scare: 0, dive: 0, nextDive: rnd.range(2, 9) });
      }
      for (let s = 0; s < 2; s++) {
        const node = new THREE.Group();
        node.scale.setScalar(1.06);
        group.add(node);
        this.parts.add(swallowGeo, node, t.hex.id);
        this.swallows.push({ pond, node, phase: s * 3.1 + t.hex.id });
      }
    }
  }

  /**
   * The fisher's way home: back along the jetty to its foot, then round the shore on dry ground
   * to the hut's door (world points). Without a hut, just ashore, where they go out of sight.
   */
  private homeward(t: TileInfo, seat: THREE.Vector3, jt: ReturnType<LakeLife['jetty']>, hut: { x: number; z: number } | null): THREE.Vector3[] {
    const level = t.shape.features.water!.level;
    const { depth } = t.shape.features.water!;
    const at = (x: number, z: number, y?: number) => new THREE.Vector3(t.hex.x + x, y ?? t.shape.height(x, z), t.hex.z + z);
    const deck = level + 0.018;
    const foot = jt.foot.clone().addScaledVector(jt.dir, -0.02);
    const out = [at(seat.x, seat.z, deck), at(jt.foot.x, jt.foot.z, Math.max(deck, t.shape.height(jt.foot.x, jt.foot.z))), at(foot.x, foot.z)];
    if (!hut) return out;
    const door = { x: hut.x - 0.015, z: hut.z + 0.05 };
    const a0 = Math.atan2(foot.z, foot.x), a1 = Math.atan2(door.z, door.x);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const r0 = Math.hypot(foot.x, foot.z), r1 = Math.hypot(door.x, door.z);
    for (let i = 1; i < 10; i++) {
      const u = i / 10, a = a0 + da * u;
      // (On the shore, pushed back from the water's edge wherever the lake reaches further.)
      let r = r0 + (r1 - r0) * u;
      for (let k = 0; k < 8 && depth(Math.cos(a) * r, Math.sin(a) * r) > -0.006; k++) r += 0.025;
      out.push(at(Math.cos(a) * r, Math.sin(a) * r));
    }
    out.push(at(door.x, door.z));
    return out;
  }

  /**
   * A raft, about its own middle (world y): logs lashed side by side, cut to a rough round under the
   * disc it carries, two battens across their ends, riding just under where the disc sits (see
   * tokens.ts cluster: a disc stands 0.03 above the ground beneath it, here the water), and its
   * line in to the post on the islet. Each is a part of its own, so a raft whose disc pollution
   * takes can founder and go down (see update) rather than float on empty.
   */
  private raftGeometry(t: TileInfo, r: ReturnType<LakeLife['rafts']>[number], rnd: Rand): THREE.BufferGeometry {
    const b = new MeshBuilder();
    const level = t.shape.features.water!.level;
    const log = C('#7a5a3a'), logDark = C('#5a4028'), lash = C('#c9b48a');
    const along = new THREE.Vector3(Math.cos(r.a), 0, Math.sin(r.a)), side = new THREE.Vector3(-along.z, 0, along.x);
    const n = 11, w = (r.r * 2) / n;
    b.surfaceId = SURFACE.planks;
    for (let i = 0; i < n; i++) {
      const u = -r.r + w * (i + 0.5);
      const half = Math.sqrt(Math.max(0, r.r * r.r - u * u)) * 1.06 + 0.012 + rnd.range(-0.006, 0.006);
      const c = new THREE.Vector3(0, level + 0.017, 0).addScaledVector(side, u);
      rod(b, c.clone().addScaledVector(along, -half), c.clone().addScaledVector(along, half), w * 0.52, i % 3 ? log : logDark);
    }
    b.surfaceId = 0;
    for (const sd of [-1, 1]) {
      const c = new THREE.Vector3(0, level + 0.029, 0).addScaledVector(along, sd * r.r * 0.82);
      rod(b, c.clone().addScaledVector(side, -r.r * 0.62), c.clone().addScaledVector(side, r.r * 0.62), 0.006, logDark, 0.004, 'flat');
    }
    const post = new THREE.Vector3(r.post.x - r.x, level + 0.042, r.post.z - r.z);
    rod(b, post, new THREE.Vector3(0, level + 0.026, 0).addScaledVector(along, -r.r * 0.9), 0.0009, lash);
    return b.build(false);
  }

  /** The jetty and the fisher, in one mesh (tile-local x and z, world y). */
  private buildStatic(t: TileInfo): THREE.BufferGeometry {
    const b = new MeshBuilder();
    const level = t.shape.features.water!.level;
    const jt = this.jetty(t);
    const deckY = level + 0.016;
    const plank = C('#8a6a48'), plankDark = C('#6a4e34'), pile = C('#4a3a2a');
    const rnd = new Rand(t.shape.seed * 5 + 1);
    b.surfaceId = SURFACE.planks;
    for (let u = 0; u < jt.len; u += 0.014) {
      const p = jt.foot.clone().addScaledVector(jt.dir, u);
      const y = Math.max(deckY, t.shape.height(p.x, p.z) + 0.004);
      rod(b, p.clone().addScaledVector(jt.across, -0.032).setY(y), p.clone().addScaledVector(jt.across, 0.032).setY(y + rnd.range(-0.001, 0.001)), 0.011, rnd.chance(0.3) ? plankDark : plank, 0.003, 'flat');
    }
    b.surfaceId = 0;
    for (let u = 0.03; u <= jt.len + 0.001; u += 0.07)
      for (const sd of [-1, 1]) {
        const p = jt.foot.clone().addScaledVector(jt.dir, u).addScaledVector(jt.across, sd * 0.03);
        rod(b, p.clone().setY(deckY + (u > jt.len - 0.01 ? 0.03 : 0.004)), p.clone().setY(level - 0.03), 0.004, pile);
      }
    // A mooring post and a coil of rope, and the fisher sitting at the end with a creel.
    const end = jt.foot.clone().addScaledVector(jt.dir, jt.len);
    const seat = end.clone().addScaledVector(jt.dir, -0.012).addScaledVector(jt.across, -0.012);
    const creel = new THREE.CylinderGeometry(0.008, 0.007, 0.012, 8);
    const cp = seat.clone().addScaledVector(jt.dir, -0.03).addScaledVector(jt.across, 0.01);
    b.addGeometry(creel, compose(cp.x, deckY + 0.008, cp.z), C('#a08050'));
    creel.dispose();
    const coil = new THREE.TorusGeometry(0.007, 0.002, 4, 10);
    const rp = end.clone().addScaledVector(jt.across, 0.022).addScaledVector(jt.dir, -0.05);
    b.addGeometry(coil, compose(rp.x, deckY + 0.003, rp.z, Math.PI / 2, 0, 0), C('#c9b48a'));
    coil.dispose();
    // The rafts' mooring posts on the islet (the rafts themselves move: see raftGeometry).
    for (const r of this.rafts(t)) {
      const post = new THREE.Vector3(r.post.x, 0, r.post.z);
      rod(b, post.clone().setY(level - 0.02), post.clone().setY(level + 0.05), 0.0045, pile);
    }
    // The fisher's hut on the shore: plank walls under a steep thatch, a door to the table, a net
    // hung to dry on poles beside it and a few fish on a line.
    const hut = this.hut(t);
    if (hut) {
      const hy = t.shape.height(hut.x, hut.z);
      b.surfaceId = SURFACE.planks;
      const walls = new THREE.BoxGeometry(0.075, 0.042, 0.055);
      b.addGeometry(walls, compose(hut.x, hy + 0.019, hut.z), C('#8a6a48'));
      walls.dispose();
      b.surfaceId = SURFACE.roof;
      for (const sd of [-1, 1]) {
        const roof = new THREE.BoxGeometry(0.088, 0.006, 0.046);
        b.addGeometry(roof, compose(hut.x, hy + 0.058, hut.z + sd * 0.0155, sd * 0.85, 0, 0), C('#c9a86a'));
        roof.dispose();
      }
      b.surfaceId = 0;
      for (const sx of [-1, 1]) {
        const gable = new THREE.BufferGeometry();
        gable.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.0275, 0, 0, 0.0275, 0, 0.034, 0], 3));
        gable.computeVertexNormals();
        b.addGeometry(gable, compose(hut.x + sx * 0.0372, hy + 0.04, hut.z, 0, sx > 0 ? 0 : Math.PI, 0), C('#7a5a3c'));
        b.addGeometry(gable, compose(hut.x + sx * 0.0372, hy + 0.04, hut.z, 0, sx > 0 ? Math.PI : 0, 0), C('#7a5a3c'));
        gable.dispose();
      }
      const door = new THREE.BoxGeometry(0.018, 0.03, 0.004);
      b.addGeometry(door, compose(hut.x - 0.015, hy + 0.015, hut.z + 0.0285), C('#3a2a1c'));
      door.dispose();
      const win = new THREE.BoxGeometry(0.014, 0.011, 0.004);
      b.addGeometry(win, compose(hut.x + 0.018, hy + 0.025, hut.z + 0.0285), C('#e8c070'));
      win.dispose();
      // The net on its poles, off the hut's side.
      const nx = hut.x + 0.075, nz = hut.z + 0.01, ny = t.shape.height(nx, nz);
      for (const sd of [-1, 1]) rod(b, new THREE.Vector3(nx, ny - 0.004, nz + sd * 0.03), new THREE.Vector3(nx, ny + 0.055, nz + sd * 0.03), 0.0025, pile);
      rod(b, new THREE.Vector3(nx, ny + 0.053, nz - 0.032), new THREE.Vector3(nx, ny + 0.053, nz + 0.032), 0.0018, pile);
      b.surfaceId = SURFACE.canvas;
      const net = new THREE.PlaneGeometry(0.058, 0.04);
      b.addGeometry(net, compose(nx, ny + 0.032, nz, 0, Math.PI / 2, 0), C('#5a5e58'));
      b.addGeometry(net, compose(nx, ny + 0.032, nz, 0, -Math.PI / 2, 0), C('#5a5e58'));
      net.dispose();
      b.surfaceId = 0;
    }
    // An upturned boat on the shore by the jetty's foot.
    const up = jt.foot.clone().addScaledVector(jt.dir, -0.05).addScaledVector(jt.across, 0.09);
    if (t.shape.canPlace(up.x, up.z, 0.05)) {
      const hull = new THREE.SphereGeometry(1, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2);
      b.addGeometry(hull, compose(up.x, t.shape.height(up.x, up.z) - 0.002, up.z, 0, -Math.atan2(jt.across.z, jt.across.x) + 0.4, 0, 0.05, 0.016, 0.02), C('#3e5a6a'));
      hull.dispose();
    }
    return b.build(false);
  }

  update(dt: number, t: number) {
    const { effects } = this.ctx;
    // A raft whose disc is gone founders: it lists, settles and goes under over a few seconds
    // (and rises again if a disc ever comes back to it).
    for (const r of this.raftNodes) {
      const want = r.i < (this.ctx.discsOn?.(r.hex) ?? Infinity) ? 0 : 1;
      if (r.sunk === want) continue;
      r.sunk = THREE.MathUtils.clamp(r.sunk + (want ? dt / 3.5 : -dt / 1.2), 0, 1);
      const k = r.sunk * r.sunk;
      r.node.position.y = -0.07 * k;
      r.node.rotation.z = 0.22 * k;
      r.node.rotation.x = -0.12 * k;
      r.node.visible = r.sunk < 0.999;
    }
    const alive = (id: number) => (effects.scarValues[id] ?? 0) < 0.85;
    for (const p of this.ponds) {
      const id = p.tile.hex.id;
      const rise = effects.riseValues[id] ?? 0;
      p.boat.visible = rise > -0.1;
      // (On a hex pollution has destroyed no one fishes, and nothing swims or flies.)
      const here = rise > -0.1 && alive(id);
      this.fisherDay(p, dt, effects.night.value);
      p.fisher.visible = p.rod.visible = here && p.trip === 'out';
      p.walker.visible = here && (p.trip === 'leaving' || p.trip === 'returning');
      // The boat rocks on the ripples; the float bobs and now and then a fish takes it.
      p.boat.position.y = p.boatY + Math.sin(t * 1.3 + id) * 0.0015;
      p.boat.rotation.z = Math.sin(t * 1.1 + id) * 0.04;
      p.boat.rotation.x = Math.sin(t * 0.8 + id * 2) * 0.03;
      p.bite = Math.max(0, p.bite - dt * 0.6);
      p.rod.rotation.z = Math.sin(t * 0.9 + id) * 0.03 + p.bite * 0.45 * (0.8 + 0.2 * Math.sin(t * 18));
      for (const f of p.fish) {
        if (f.t >= 1) continue;
        if ((f.delay -= dt) > 0) continue;
        f.t = Math.min(1, f.t + dt * 1.6);
        const u = f.t;
        f.mesh.visible = u < 1;
        f.mesh.position.lerpVectors(f.from, f.to, u);
        f.mesh.position.y = p.level + Math.sin(u * Math.PI) * 0.07 - 0.004;
        f.mesh.rotation.set(0, -Math.atan2(f.to.z - f.from.z, f.to.x - f.from.x), Math.cos(u * Math.PI) * 1.1);
        if (u === 1 || (u > 0.02 && u < 0.08)) this.splash(f.mesh.position, u === 1 ? 10 : 5);
      }
    }
    {
      this.ducks.forEach((d, i) => {
        const id = d.lake.tile.hex.id;
        const rise = effects.riseValues[id] ?? 0;
        d.scare = Math.max(0, d.scare - dt * 0.5);
        // At night the ducks gather to roost by the hut's shore and sit still, heads tucked down.
        const night = effects.night.value > 0.6;
        if (night && d.lake.roost) d.to = { x: d.lake.roost.x + Math.cos(i * 2.4) * 0.03, z: d.lake.roost.z + Math.sin(i * 2.4) * 0.03 };
        // In rain they dive now and then, tail up, and come up a moment later a little way off.
        if (effects.rain.value > 0.35 && !night && d.dive <= 0 && (d.nextDive -= dt) <= 0) {
          d.dive = 1.3;
          d.nextDive = d.lake.rnd.range(3, 9);
          this.splash(d.node.position, 4);
        }
        if (d.dive > 0) {
          d.dive -= dt;
          if (d.dive <= 0) this.splash(d.node.position, 3);
        }
        const dx = d.to.x - d.x, dz = d.to.z - d.z, dist = Math.hypot(dx, dz);
        if (dist < 0.02) {
          if (!night && (d.wait -= dt) <= 0) {
            d.to = d.lake.water[d.lake.rnd.int(d.lake.water.length)];
            d.wait = d.lake.rnd.range(2, 8);
          }
        } else {
          d.yaw = easeAngle(d.yaw, Math.atan2(dz, dx), follow(dt, 2));
          const v = d.speed * (1 + d.scare * 4) * dt;
          d.x += Math.cos(d.yaw) * v;
          d.z += Math.sin(d.yaw) * v;
        }
        d.node.position.set(d.lake.tile.hex.x + d.x, d.lake.level + Math.sin(t * 2 + i) * 0.0008, d.lake.tile.hex.z + d.z);
        d.node.rotation.y = -d.yaw;
        // (Tipped up as it goes under, and out of sight for the rest of the dive.)
        // Idle on the water (by day), it dabbles now and then, bill under and tail up.
        const idle = dist < 0.02 && !night && d.dive <= 0;
        const dab = idle && Math.sin(t * 0.8 + i * 3.1) > 0.8 ? -0.55 : 0;
        d.node.rotation.z = d.dive > 1.05 ? -(1.3 - d.dive) * 5 : d.node.rotation.z + (dab - d.node.rotation.z) * follow(dt, 5);
        // Head tucked at the roost: the duck sits lower and rounder.
        d.node.scale.set(1.3, night ? 1.3 * 0.82 : 1.3, 1.3);
        d.node.visible = rise > -0.05 && alive(id) && !(d.dive > 0 && d.dive <= 1.05);
      });
    }
    {
      this.swallows.forEach((sw, i) => {
        const p = sw.pond;
        const rise = effects.riseValues[p.tile.hex.id] ?? 0;
        // Figure-of-eight loops low over the water, banking into each turn.
        const ph = t * 0.55 + sw.phase;
        const x = Math.sin(ph) * 0.5, z = Math.sin(ph * 2) * 0.22;
        const vx = Math.cos(ph) * 0.5, vz = Math.cos(ph * 2) * 0.44;
        // (Lower over the water before rain, as swallows fly, and roosting out of sight at night.)
        const y = p.level + 0.07 * (1 - 0.55 * effects.rain.value) + Math.sin(ph * 3 + i) * 0.03 * (1 - 0.5 * effects.rain.value);
        sw.node.position.set(p.tile.hex.x + x, y, p.tile.hex.z + z);
        sw.node.rotation.set(-Math.sin(ph * 2) * 0.7, -Math.atan2(vz, vx), 0, 'YXZ');
        sw.node.visible = rise > -0.05 && alive(p.tile.hex.id) && effects.night.value < 0.5;
      });
    }
  }

  /**
   * The fisher's day (see Pond.trip): after dusk they pack up and walk home round the shore, and
   * the hut's window lights once they're in; at dawn they walk back out to fish. A walk is never
   * cut short: a night that turns while they're on the way waits for them to get there.
   */
  private fisherDay(p: Pond, dt: number, night: number) {
    const len = routeLength(p.route);
    if (p.trip === 'out' && night > 0.62) p.trip = 'leaving';
    else if (p.trip === 'home' && night < 0.3) p.trip = 'returning';
    if (p.trip === 'leaving' || p.trip === 'returning') {
      p.at = THREE.MathUtils.clamp(p.at + (p.trip === 'leaving' ? 1 : -1) * dt * FISHER_PACE, 0, len);
      along(p.route, p.at, _here, _ahead);
      p.walker.position.copy(_here);
      // (A little bob in the stride.)
      p.walker.position.y += Math.abs(Math.sin(p.at * 140)) * 0.0018;
      const dir = p.trip === 'leaving' ? 1 : -1;
      p.walker.rotation.y = -Math.atan2(_ahead.z * dir, _ahead.x * dir);
      if (p.trip === 'leaving' && p.at >= len) p.trip = 'home';
      else if (p.trip === 'returning' && p.at <= 0) p.trip = 'out';
    }
    if (p.window) p.window.gain += ((p.trip === 'home' ? 1 : 0) - p.window.gain) * Math.min(1, dt * 2);
  }

  private splash(at: THREE.Vector3, n: number) {
    for (let i = 0; i < n; i++)
      this.ctx.particles.spray.emit({
        x: at.x, y: at.y, z: at.z, vx: (Math.random() - 0.5) * 0.16, vy: 0.12 + Math.random() * 0.14, vz: (Math.random() - 0.5) * 0.16,
        life: 0.7, size: 0.006 + Math.random() * 0.004, color: '#eef6f9', alpha: 0.85, gravity: 1.9, drag: 0.3, floor: at.y - 0.01,
      });
  }

  produce(hex: number) {
    const p = this.ponds.find((x) => x.tile.hex.id === hex);
    if (!p || !p.water.length) return;
    p.bite = 1;
    const ox = p.tile.hex.x, oz = p.tile.hex.z;
    p.fish.forEach((f, i) => {
      const a = p.water[p.rnd.int(p.water.length)];
      const ang = p.rnd.range(0, Math.PI * 2);
      f.from.set(ox + a.x, 0, oz + a.z);
      f.to.set(ox + a.x + Math.cos(ang) * 0.08, 0, oz + a.z + Math.sin(ang) * 0.08);
      f.t = 0;
      f.delay = i * 0.35 + p.rnd.range(0, 0.15);
    });
    for (const d of this.ducks) if (d.lake === p) d.scare = 1;
  }

  dispose() {
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.parts.dispose();
    this.swallows = [];
    this.ponds = [];
    this.ducks = [];
  }
}
