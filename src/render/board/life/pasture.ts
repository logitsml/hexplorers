// Pastures: a timber paddock fence around each meadow (inset from the road lanes,
// chamfered at the building corners, with an open gate) and cute fluffy sheep and
// lambs that graze, wander, look around and hop for joy when the pasture produces.

import { follow } from '../../util/angle';
import * as THREE from 'three/webgpu';
import { CORNER_OFFSETS } from '../../../engine/board';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose, displace, smoothSphere, softenNormals, v3 } from '../geom';
import { propMaterial, tilePropMaterial } from '../materials';
import type { TileInfo } from '../tiles';
import type { Decor, Reserved } from '../decor';
import { RIM, TILE_SCALE, TOKEN_CLEAR } from '../layout';
import { CORNER_CLEAR, LANE, sideDistance } from '../terrain';
import { riverClear } from '../riverCourse';
import { onPad } from '../wellSite';
import type { LifeContext, LifeModule } from './common';
import { release } from '../release';
import { instancedMesh } from '../instancing';

const C = (h: string) => new THREE.Color(h);
/** Sheep are modelled at life-like proportions and enlarged to read clearly (and look cuddly) on the board. */
// (Sized to the people, as every animal is: a little over a person's waist at the back, where a real
// sheep comes to the hip; the island draws its animals half again larger than life so they read from
// the table, but never larger than the people who keep them.)
const SHEEP_SCALE = 0.85;
/** How far a sheep's middle keeps from a bush, a tree or a rock: half its length, and a little. */
const SHEEP_CLEAR = 0.06;

// ---------------------------------------------------------------- geometry

function makeSheep(seed: number, opts: { lamb?: boolean; black?: boolean }): { body: THREE.BufferGeometry; head: THREE.BufferGeometry; leg: THREE.BufferGeometry } {
  const r = new Rand(seed);
  const s = opts.lamb ? 0.72 : 1;
  const wool = opts.black ? C('#3d3735') : C('#ece5d6');
  const woolShade = opts.black ? C('#2a2524') : C('#cfc5b3');
  const face = opts.black ? C('#18120f') : C('#2f2622');
  const b = new MeshBuilder();
  // Round, compact fleece: lumpy wool puffs over an ellipsoid, a little shorter than real
  // sheep so the head reads clearly in front of it from above.
  const puffs = 26;
  const ex = 0.043 * s, ey = 0.032 * s, ez = 0.036 * s;
  for (let i = 0; i < puffs; i++) {
    const u = (i + 0.5) / puffs;
    const th = Math.acos(1 - 2 * u);
    const ph = i * 2.399963;
    const x = Math.cos(ph) * Math.sin(th) * ex;
    const y = Math.cos(th) * ey;
    const z = Math.sin(ph) * Math.sin(th) * ez;
    if (y < -ey * 0.55) continue;
    const pr = (0.016 + r.range(0, 0.005)) * s;
    const g = smoothSphere(pr, 2);
    b.addGeometry(g, compose(x, y + 0.054 * s, z), (_x, yy, _z, o) => o.copy(woolShade).lerp(wool, Math.min(1, Math.max(0, (yy - 0.03 * s) / (0.055 * s)))));
    g.dispose();
  }
  const core = smoothSphere(0.038 * s, 3);
  core.scale(1.1, 0.82, 0.9);
  b.addGeometry(core, compose(0, 0.054 * s, 0), woolShade);
  core.dispose();
  const tail = smoothSphere(0.01 * s, 1);
  b.addGeometry(tail, compose(-0.047 * s, 0.064 * s, 0), wool);
  tail.dispose();
  const body = b.build(false);
  // Shade the fleece as one soft mass rather than a pile of balls: normals bent towards the
  // direction from its centre, and the crevices between the puffs darker.
  const cy = 0.054 * s;
  softenNormals(body, v3(0, cy, 0), 0.6);
  const bp = body.getAttribute('position'), bc = body.getAttribute('color');
  const hx = ex + 0.019 * s, hy = ey + 0.019 * s, hz = ez + 0.019 * s;
  for (let i = 0; i < bp.count; i++) {
    const d = Math.hypot(bp.getX(i) / hx, (bp.getY(i) - cy) / hy, bp.getZ(i) / hz);
    const k = 0.82 + 0.18 * THREE.MathUtils.smoothstep(d, 0.72, 1.0);
    bc.setXYZ(i, bc.getX(i) * k, bc.getY(i) * k, bc.getZ(i) * k);
  }

  // Head, modelled from the neck joint (origin) forward along +x so it can dip to graze
  // without sinking into the fleece. Big relative to the body, with sideways ears that
  // show from above, a wool topknot and large glossy eyes.
  const h = new MeshBuilder();
  const skull = smoothSphere(0.019 * s, 2);
  skull.scale(1.25, 1, 1);
  h.addGeometry(skull, compose(0.019 * s, 0, 0), face);
  skull.dispose();
  const muzzle = smoothSphere(0.011 * s, 2);
  muzzle.scale(1.1, 0.85, 1);
  h.addGeometry(muzzle, compose(0.036 * s, -0.005 * s, 0), face.clone().lerp(C('#6b5148'), 0.35));
  muzzle.dispose();
  const knot = smoothSphere(0.014 * s, 2);
  displace(knot, (x, _y, z) => Math.sin(x * 900) * Math.sin(z * 900) * 0.0015);
  h.addGeometry(knot, compose(0.012 * s, 0.014 * s, 0), wool);
  knot.dispose();
  for (const side of [-1, 1]) {
    const ear = smoothSphere(0.0095 * s, 1);
    ear.scale(0.7, 0.35, 1.7);
    h.addGeometry(ear, compose(0.012 * s, 0.004 * s, side * 0.027 * s, side * 0.35, 0, 0), face);
    ear.dispose();
    const inner = smoothSphere(0.006 * s, 1);
    inner.scale(0.6, 0.25, 1.5);
    h.addGeometry(inner, compose(0.0135 * s, 0.006 * s, side * 0.028 * s, side * 0.35, 0, 0), C('#d9908a'));
    inner.dispose();
    // Small dark bead eyes set on the sides of the head, as on a real sheep.
    const eye = smoothSphere(0.0026 * s, 1);
    h.addGeometry(eye, compose(0.027 * s, 0.006 * s, side * 0.0172 * s), C('#0b0807'));
    eye.dispose();
  }
  const head = h.build(false);
  // A leg hangs from its hip joint (origin) so it can swing; dark hoof at the bottom.
  const l = new MeshBuilder();
  const shin = new THREE.CylinderGeometry(0.0054 * s, 0.0046 * s, 0.034 * s, 6);
  l.addGeometry(shin, compose(0, -0.017 * s, 0), face);
  shin.dispose();
  const hoof = new THREE.CylinderGeometry(0.005 * s, 0.0055 * s, 0.005 * s, 6);
  l.addGeometry(hoof, compose(0, -0.0335 * s, 0), C('#141010'));
  hoof.dispose();
  return { body, head, leg: l.build(false) };
}

const HIPS: [number, number][] = [
  [0.024, 0.016],
  [0.024, -0.016],
  [-0.024, 0.016],
  [-0.024, -0.016],
];

function makePost(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const g = new THREE.CylinderGeometry(0.0075, 0.009, 0.07, 6);
  b.addGeometry(g, compose(0, 0.035, 0), (_x, y, _z, o) => o.set(y > 0.066 ? '#b08a5c' : '#7a5636'));
  g.dispose();
  const cap = new THREE.ConeGeometry(0.0095, 0.008, 6);
  b.addGeometry(cap, compose(0, 0.074, 0), C('#8a6440'));
  cap.dispose();
  return b.build(false);
}

function makeRail(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  for (const y of [0.028, 0.054]) {
    const g = new THREE.BoxGeometry(1, 0.007, 0.006);
    b.addGeometry(g, compose(0.5, y, 0), C('#8f6a44'));
    g.dispose();
  }
  return b.build(false);
}

function makeTrough(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const box = new THREE.BoxGeometry(0.08, 0.022, 0.032);
  b.addGeometry(box, compose(0, 0.016, 0), C('#7a5636'));
  box.dispose();
  const water = new THREE.BoxGeometry(0.07, 0.002, 0.024);
  b.addGeometry(water, compose(0, 0.026, 0), C('#5d9fb0'));
  water.dispose();
  for (const x of [-0.034, 0.034]) {
    const leg = new THREE.BoxGeometry(0.006, 0.012, 0.03);
    b.addGeometry(leg, compose(x, 0.005, 0), C('#5e4128'));
    leg.dispose();
  }
  return b.build(false);
}

// ---------------------------------------------------------------- paddock

/** Closed fence loop (local coords) inset from the lanes with chamfered corners. */
function paddockLoop(t: TileInfo): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = [];
  const conn = t.shape.ctx.connected;
  const inset = (side: number) => (conn[side] ? LANE + 0.075 : RIM + 0.075);
  // Corner c sits between side c-1 and side c. Walk each side, staying clear of corners.
  for (let c = 0; c < 6; c++) {
    const side = c; // side c runs from corner c to corner c+1
    const [ax, az] = CORNER_OFFSETS[c];
    const [bx, bz] = CORNER_OFFSETS[(c + 1) % 6];
    const nx = (ax + bx) / 2, nz = (az + bz) / 2;
    const nl = Math.hypot(nx, nz);
    const ox = (nx / nl) * inset(side), oz = (nz / nl) * inset(side);
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const u = 0.06 + (i / steps) * 0.88;
      let x = (ax + (bx - ax) * u) * TILE_SCALE - ox;
      let z = (az + (bz - az) * u) * TILE_SCALE - oz;
      // Push away from building corners.
      for (const [cx, cz] of CORNER_OFFSETS) {
        const d = Math.hypot(x - cx, z - cz);
        const need = CORNER_CLEAR + 0.1;
        if (d < need) {
          x = cx + ((x - cx) / d) * need;
          z = cz + ((z - cz) / d) * need;
        }
      }
      // Re-apply the lane inset after the corner push.
      const sd = sideDistance(x, z, side);
      if (sd < inset(side)) {
        x -= (nx / nl) * (inset(side) - sd);
        z -= (nz / nl) * (inset(side) - sd);
      }
      pts.push({ x, z });
    }
  }
  // Smooth the loop a little (Chaikin-like relaxation).
  for (let it = 0; it < 2; it++) {
    const n = pts.length;
    const out = pts.map((p, i) => {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      return { x: p.x * 0.5 + (a.x + b.x) * 0.25, z: p.z * 0.5 + (a.z + b.z) * 0.25 };
    });
    pts.splice(0, n, ...out);
  }
  return pts;
}

// ------------------------------------------------------------------ sheep

interface Sheep {
  tile: TileInfo;
  /** Variant (white/black, ewe/lamb) and this sheep's slot in that variant's instanced batches. */
  variant: number;
  slot: number;
  root: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  legs: THREE.Mesh[];
  /** Walk-cycle phase (radians) and how far the sheep is lying down (0..1). */
  gait: number;
  lie: number;
  x: number;
  z: number;
  /** Terrain height under the sheep, resampled only when it moves. */
  ground: number;
  /** Radians still to turn on the spot (a grazing sheep that bumped into something). */
  turnLeft: number;
  heading: number;
  /** Current ground speed and turn rate: eased toward what the behaviour wants, so a sheep
   * leans into a walk, slows to a stop and swings round rather than snapping. */
  vel: number;
  yawRate: number;
  target: { x: number; z: number } | null;
  state: 'graze' | 'walk' | 'trot' | 'look' | 'rest';
  timer: number;
  speed: number;
  phase: number;
  hop: number;
  rnd: Rand;
  lamb: boolean;
  inside: (x: number, z: number) => boolean;
}

export class PastureLife implements LifeModule {
  private tiles: TileInfo[] = [];
  private loops = new Map<number, { x: number; z: number }[]>();
  private gates = new Map<number, number>();
  private sheep: Sheep[] = [];
  private disposables: { dispose(): void }[] = [];
  private posts: THREE.InstancedMesh[] = [];
  private batches: { body: THREE.InstancedMesh; head: THREE.InstancedMesh; legs: THREE.InstancedMesh }[] = [];

  /** `decor`: the island's scenery, whose bushes, trees and rocks in the paddock the sheep walk round. */
  constructor(
    private ctx: LifeContext,
    private decor: () => Decor | null = () => null,
  ) {}

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'pasture');
    const res: Reserved = [];
    for (const t of this.tiles) {
      const loop = paddockLoop(t);
      this.loops.set(t.hex.id, loop);
      const rnd = new Rand(t.shape.seed + 5);
      this.gates.set(t.hex.id, rnd.int(loop.length));
      for (let i = 0; i < loop.length; i += 2) res.push({ hex: t.hex.id, x: loop[i].x, z: loop[i].z, r: 0.035 });
    }
    return res;
  }

  build() {
    const { effects, group } = this.ctx;
    const postGeo = makePost();
    const railGeo = makeRail();
    const troughGeo = makeTrough();
    this.disposables.push(postGeo, railGeo, troughGeo);
    const variants = [
      makeSheep(1, {}),
      makeSheep(2, {}),
      makeSheep(3, { black: true }),
      makeSheep(4, { lamb: true }),
      makeSheep(5, { lamb: true, black: true }),
    ];
    variants.forEach((v) => this.disposables.push(v.body, v.head, v.leg));
    for (const t of this.tiles) {
      const woodMat = tilePropMaterial(effects, t.hex.id, { roughness: 0.85 });
      this.disposables.push(woodMat);
      const loop = this.loops.get(t.hex.id)!;
      const gate = this.gates.get(t.hex.id)!;
      const n = loop.length;
      const postMesh = instancedMesh(postGeo, woodMat, n);
      const railMesh = instancedMesh(railGeo, woodMat, n);
      const m = new THREE.Matrix4();
      let railCount = 0;
      // (Where a river runs through the paddock, the fence stops at its banks; and short of an oil well's yard.)
      const river = t.shape.ctx.river;
      const wet = (x: number, z: number) => (!!river && !riverClear(river, x, z, 0)) || (!!t.shape.ctx.pad && onPad(t.shape.ctx.pad, x, z, 0.01));
      for (let i = 0; i < n; i++) {
        const p = loop[i];
        const q = loop[(i + 1) % n];
        const wx = t.hex.x + p.x, wz = t.hex.z + p.z;
        const y = t.shape.height(p.x, p.z) - 0.004;
        if (wet(p.x, p.z)) {
          postMesh.setMatrixAt(i, m.makeScale(0, 0, 0));
          continue;
        }
        m.compose(new THREE.Vector3(wx, y, wz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 1.7) % 6.28), new THREE.Vector3(1, 1 + ((i * 7) % 5) * 0.03, 1));
        postMesh.setMatrixAt(i, m);
        if (i === gate) continue; // open gate gap
        if ([0.25, 0.5, 0.75, 1].some((u) => wet(p.x + (q.x - p.x) * u, p.z + (q.z - p.z) * u))) continue;
        const dx = q.x - p.x, dz = q.z - p.z;
        const len = Math.hypot(dx, dz);
        const yq = t.shape.height(q.x, q.z) - 0.004;
        const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.atan2(dz, dx), Math.atan2(yq - y, len), 'YZX'));
        m.compose(new THREE.Vector3(wx, y, wz), rot, new THREE.Vector3(len, 1, 1));
        railMesh.setMatrixAt(railCount++, m);
      }
      railMesh.count = railCount;
      for (const mesh of [postMesh, railMesh]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
        this.posts.push(mesh);
      }
      // Open gate leaf swung inward.
      const gp = loop[gate], gq = loop[(gate + 1) % n];
      const gateMesh = this.ctx.props.mesh(railGeo, woodMat);
      const glen = Math.hypot(gq.x - gp.x, gq.z - gp.z) * 0.9;
      gateMesh.position.set(t.hex.x + gp.x, t.shape.height(gp.x, gp.z) - 0.004, t.hex.z + gp.z);
      gateMesh.rotation.y = -Math.atan2(gq.z - gp.z, gq.x - gp.x) - 1.1;
      gateMesh.scale.set(glen, 1, 1);
      gateMesh.castShadow = true;
      group.add(gateMesh);

      const rnd = new Rand(t.shape.seed * 3 + 17);
      // (The paddock's bushes, its oak and its rocks, and its trough: a sheep's middle keeps half its length off them.)
      const solids = this.decor()?.solids(t.hex.id, t.hex) ?? [];
      // Water trough somewhere inside.
      const inside = (x: number, z: number) => {
        const r = Math.hypot(x, z);
        if (r < TOKEN_CLEAR + 0.06) return false;
        // (Sheep keep out of a river: they graze along its banks.)
        if (river && !riverClear(river, x, z, 0.02)) return false;
        if (t.shape.ctx.pad && onPad(t.shape.ctx.pad, x, z, 0.03)) return false;
        for (const o of solids) if ((x - o.x) ** 2 + (z - o.z) ** 2 < (o.r + SHEEP_CLEAR) ** 2) return false;
        return pointInLoop(x, z, loop, 0.085);
      };
      for (let k = 0; k < 40; k++) {
        const x = rnd.range(-0.6, 0.6), z = rnd.range(-0.6, 0.6);
        if (!inside(x, z)) continue;
        const tr = this.ctx.props.mesh(troughGeo, woodMat);
        tr.position.set(t.hex.x + x, t.shape.height(x, z) - 0.002, t.hex.z + z);
        tr.rotation.y = rnd.range(0, Math.PI);
        tr.castShadow = true;
        tr.receiveShadow = true;
        group.add(tr);
        solids.push({ x, z, r: 0.045 });
        break;
      }
      // A flock: 3–5 adults and 0–2 lambs, sometimes a black sheep.
      const adults = 3 + rnd.int(3);
      const lambs = rnd.int(3);
      for (let i = 0; i < adults + lambs; i++) {
        const lamb = i >= adults;
        const black = !lamb ? rnd.chance(0.15) : rnd.chance(0.2);
        const vi = lamb ? (black ? 4 : 3) : black ? 2 : rnd.int(2);
        const v = variants[vi];
        let x = 0, z = 0, placed = false;
        for (let k = 0; k < 60 && !placed; k++) {
          x = rnd.range(-0.6, 0.6);
          z = rnd.range(-0.6, 0.6);
          placed = inside(x, z);
        }
        // (No luck: a small spiral out from the middle, then the sheep is skipped rather than pivoting outside.)
        for (let k = 0; k < 48 && !placed; k++) {
          const ang = k * 2.4, rad = 0.05 + k * 0.012;
          x = Math.cos(ang) * rad;
          z = Math.sin(ang) * rad;
          placed = inside(x, z);
        }
        if (!placed) continue;
        // The sheep is posed as a small (never rendered) hierarchy; its world matrices feed
        // instanced batches, so the whole flock costs a handful of draws instead of six each.
        const root = new THREE.Group();
        root.scale.setScalar(SHEEP_SCALE);
        const body = new THREE.Mesh(v.body);
        const head = new THREE.Mesh(v.head);
        const s = lamb ? 0.72 : 1;
        head.position.set(0.042 * s, 0.07 * s, 0);
        root.add(body, head);
        const legs = HIPS.map(([hx, hz]) => {
          const leg = new THREE.Mesh(v.leg);
          leg.position.set(hx * s, 0.034 * s, hz * s);
          root.add(leg);
          return leg;
        });
        this.sheep.push({
          tile: t,
          variant: vi,
          slot: this.sheep.filter((o) => o.variant === vi).length,
          root,
          body,
          head,
          legs,
          gait: 0,
          lie: 0,
          x,
          z,
          heading: rnd.range(0, Math.PI * 2),
          vel: 0,
          yawRate: 0,
          target: null,
          state: 'graze',
          timer: rnd.range(1, 5),
          speed: lamb ? 0.075 : 0.055,
          phase: rnd.range(0, 10),
          hop: 0,
          ground: NaN,
          turnLeft: 0,
          rnd,
          lamb,
          inside,
        });
      }
    }
    // Instanced batches per variant: body, head, and four legs per sheep.
    const mat = propMaterial(effects, { roughness: 0.95, instanced: true });
    const woolMat = propMaterial(effects, { roughness: 1, instanced: true, fuzz: true });
    this.disposables.push(mat, woolMat);
    variants.forEach((v, vi) => {
      const flock = this.sheep.filter((sh) => sh.variant === vi);
      if (!flock.length) return;
      const make = (geo: THREE.BufferGeometry, count: number, shadow: boolean, material = mat) => {
        const g = geo.clone();
        const tile = new Float32Array(count), rs = new Float32Array(count).fill(1 / SHEEP_SCALE);
        flock.forEach((sh, k) => {
          for (let j = 0; j < count / flock.length; j++) tile[k * (count / flock.length) + j] = sh.tile.hex.id;
        });
        g.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 1));
        g.setAttribute('aRiseScale', new THREE.InstancedBufferAttribute(rs, 1));
        const im = instancedMesh(g, material, count);
        im.frustumCulled = false;
        im.castShadow = shadow;
        im.receiveShadow = true;
        this.ctx.group.add(im);
        this.disposables.push(g);
        return im;
      };
      this.batches[vi] = { body: make(v.body, flock.length, true, woolMat), head: make(v.head, flock.length, true), legs: make(v.leg, flock.length * 4, true) };
    });
  }

  update(dt: number, t: number) {
    for (const s of this.sheep) {
      s.timer -= dt;
      if (s.timer <= 0) this.nextState(s);
      const k = s.lamb ? 0.72 : 1;
      // Movement: walking and trotting head for a target; grazing drifts slowly forward
      // with the nose in the grass, the way a grazing flock creeps across a field.
      let speed = 0;
      let yaw = 0;
      if ((s.state === 'walk' || s.state === 'trot') && s.target) {
        const dx = s.target.x - s.x, dz = s.target.z - s.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.02) {
          s.state = 'graze';
          // (Going in for the night or out of the rain, it carries on soon: it may have further to go.)
          const gathering = this.ctx.effects.night.value > 0.55 || this.ctx.effects.rain.value > 0.4;
          s.timer = gathering ? s.rnd.range(0.4, 1.2) : s.rnd.range(3, 8);
          s.target = null;
        } else {
          const want = Math.atan2(dz, dx);
          const diff = Math.atan2(Math.sin(want - s.heading), Math.cos(want - s.heading));
          yaw = THREE.MathUtils.clamp(diff * 3, -1.6, 1.6);
          // Ease off on the approach so it walks up to the spot rather than braking on it.
          speed = s.speed * (s.state === 'trot' ? 2.4 : 1) * (0.25 + 0.75 * Math.max(0, Math.cos(diff))) * Math.min(1, 0.35 + d * 6);
        }
      } else if (s.state === 'graze') {
        speed = s.speed * 0.12 * (0.5 + 0.5 * Math.sin((t + s.phase) * 0.6));
        yaw = Math.sin((t + s.phase) * 0.23) * 0.25;
      }
      // Turning away from an obstacle: a gradual pivot on the spot, shuffling round.
      if (s.turnLeft !== 0) {
        yaw = Math.sign(s.turnLeft) * Math.min(1.3, 0.4 + Math.abs(s.turnLeft) * 2);
        speed = 0;
      }
      s.vel += (speed - s.vel) * follow(dt, speed > s.vel ? 2.5 : 4.5);
      s.yawRate += (yaw - s.yawRate) * follow(dt, 5);
      const dYaw = s.yawRate * dt;
      s.heading += dYaw;
      if (s.turnLeft !== 0) s.turnLeft = Math.sign(s.turnLeft) === Math.sign(s.turnLeft - dYaw) ? s.turnLeft - dYaw : 0;
      speed = s.vel;
      if (speed > 1e-4 && s.turnLeft === 0) {
        const step = speed * dt;
        const nx = s.x + Math.cos(s.heading) * step;
        const nz = s.z + Math.sin(s.heading) * step;
        if (s.inside(nx, nz) && !this.crowded(s, nx, nz)) {
          s.x = nx;
          s.z = nz;
        } else if (s.state === 'graze') {
          s.turnLeft = (s.rnd.chance(0.5) ? 1 : -1) * s.rnd.range(1.4, 2.2);
        } else {
          s.target = null;
          s.state = 'look';
          s.timer = s.rnd.range(0.8, 2);
          s.vel *= 0.5;
          speed = 0;
        }
      }
      // Gait: diagonal legs swing together; stride scales with speed, and a pivoting sheep
      // shuffles its feet instead of spinning on rigid legs.
      const stride = Math.min(1, Math.max(speed / (s.speed * 1.2), Math.abs(s.yawRate) * 0.35));
      s.gait += dt * (6 + speed * 90) * Math.min(1, stride * 8);
      const swing = Math.sin(s.gait) * 0.55 * stride;
      s.lie += ((s.state === 'rest' ? 1 : 0) - s.lie) * Math.min(1, dt * 2.5);
      // (Loops rather than forEach: this runs for every sheep every frame, and a callback is a closure each time.)
      for (let i = 0; i < s.legs.length; i++) {
        const leg = s.legs[i];
        const diag = i === 0 || i === 3 ? 1 : -1;
        leg.rotation.z = swing * diag;
        leg.scale.y = 1 - s.lie * 0.75;
      }
      const bob = stride * Math.abs(Math.sin(s.gait)) * 0.005;
      if (speed > 0 || Number.isNaN(s.ground)) s.ground = s.tile.shape.height(s.x, s.z);
      const ground = s.ground;
      const hopY = s.hop > 0 ? Math.sin((1 - s.hop) * Math.PI) * 0.07 : 0;
      if (s.hop > 0) s.hop = Math.max(0, s.hop - dt * 2.2);
      s.root.position.set(s.tile.hex.x + s.x, ground - 0.003 + bob + hopY - s.lie * 0.022 * k * SHEEP_SCALE, s.tile.hex.z + s.z);
      s.root.rotation.y = -s.heading;
      s.root.rotation.x = Math.sin(s.gait) * 0.04 * stride;
      // The flock wears tracks through the grass where it walks, and flattens it where it lies.
      if (speed > 0.005 || s.lie > 0.5) this.ctx.effects.trail.stamp(s.tile.hex.x + s.x, s.tile.hex.z + s.z, 0.05 * k, dt * (s.lie > 0.5 ? 0.35 : speed * 3));
      // Head: graze (down, nibbling), look and rest (up, turning), walk (nodding with the step).
      // The pose is a target the head moves toward, so switching state lifts or lowers it
      // smoothly instead of snapping.
      let pitch: number, lift: number, turn: number;
      if (s.state === 'graze') {
        pitch = -0.95 + Math.sin((t + s.phase) * 6) * 0.08;
        lift = 0.064 * k;
        turn = Math.sin((t + s.phase) * 0.7) * 0.25;
      } else if (s.state === 'look' || s.state === 'rest') {
        pitch = 0.18 - s.lie * 0.1;
        lift = 0.074 * k;
        turn = Math.sin((t + s.phase) * (s.state === 'rest' ? 0.4 : 1.3)) * 0.7;
      } else {
        pitch = 0.06 + Math.sin(s.gait * 2) * 0.06;
        lift = 0.071 * k;
        turn = 0;
      }
      const ease = follow(dt, 7);
      s.head.rotation.z += (pitch - s.head.rotation.z) * ease;
      s.head.position.y += (lift - s.head.position.y) * ease;
      s.head.rotation.y += (turn - s.head.rotation.y) * ease;
      // Breathing.
      s.body.scale.y = 1 + Math.sin((t + s.phase) * (s.state === 'rest' ? 1.4 : 2.2)) * 0.015;
      const b = this.batches[s.variant];
      if (b) {
        s.root.updateMatrixWorld(true);
        b.body.setMatrixAt(s.slot, s.body.matrixWorld);
        b.head.setMatrixAt(s.slot, s.head.matrixWorld);
        for (let k = 0; k < s.legs.length; k++) b.legs.setMatrixAt(s.slot * 4 + k, s.legs[k].matrixWorld);
      }
    }
    for (const b of this.batches) {
      if (!b) continue;
      b.body.instanceMatrix.needsUpdate = true;
      b.head.instanceMatrix.needsUpdate = true;
      b.legs.instanceMatrix.needsUpdate = true;
    }
  }

  private crowded(s: Sheep, x: number, z: number) {
    for (const o of this.sheep) {
      if (o === s || o.tile !== s.tile) continue;
      if ((o.x - x) ** 2 + (o.z - z) ** 2 < 0.09 ** 2 && (o.x - x) * Math.cos(s.heading) + (o.z - z) * Math.sin(s.heading) < 0) return true;
    }
    return false;
  }

  private nextState(s: Sheep) {
    const flock = this.sheep.filter((o) => o.tile === s.tile && o !== s);
    const cx = flock.reduce((a, o) => a + o.x, 0) / Math.max(1, flock.length);
    const cz = flock.reduce((a, o) => a + o.z, 0) / Math.max(1, flock.length);
    const far = Math.hypot(cx - s.x, cz - s.z) > 0.32;
    const r = s.rnd.next();
    // After dark the flock draws together and beds down for the night; in rain it huddles,
    // standing close together until it passes. Each sheep goes in to the middle (a lamb to
    // its mother) when it's next free, so the flock gathers over a few seconds, not in step.
    const { night, rain } = this.ctx.effects;
    const bedtime = night.value > 0.55, huddle = !bedtime && rain.value > 0.4;
    if (bedtime || huddle) {
      // (They gather on the flock's eldest ewe, wherever she stands: the flock's middle is as
      // often as not the number disc, where no sheep may stand.)
      const lead = this.sheep.find((o) => o.tile === s.tile && !o.lamb) ?? s;
      const near = Math.hypot(lead.x - s.x, lead.z - s.z);
      if (lead !== s && near > (bedtime ? 0.1 : 0.12)) {
        for (let k = 0; k < 24; k++) {
          const a = s.rnd.range(0, Math.PI * 2), r = s.rnd.range(0.05, 0.09);
          const x = lead.x + Math.cos(a) * r, z = lead.z + Math.sin(a) * r;
          if (!s.inside(x, z)) continue;
          // (A straight line that would cross the number disc goes round it: first to a point
          // part of the way round, then on from there when this sheep is next free.)
          s.target = roundTheDisc(s.x, s.z, x, z, s.inside) ?? { x, z };
          s.state = huddle && rain.value > 0.7 ? 'trot' : 'walk';
          s.timer = 10;
          return;
        }
      }
      s.state = bedtime ? 'rest' : 'look';
      s.timer = bedtime ? s.rnd.range(18, 34) : s.rnd.range(5, 10);
      return;
    }
    // Lambs keep close to the nearest adult; strays trot back to the flock.
    let anchor: { x: number; z: number } | null = null;
    if (s.lamb) {
      const mum = flock.filter((o) => !o.lamb).sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z))[0];
      if (mum && Math.hypot(mum.x - s.x, mum.z - s.z) > 0.12) anchor = { x: mum.x, z: mum.z };
    } else if (far) anchor = { x: cx, z: cz };
    if (anchor || r < 0.42) {
      for (let k = 0; k < 24; k++) {
        const bx = anchor ? anchor.x : s.x + (cx - s.x) * 0.3;
        const bz = anchor ? anchor.z : s.z + (cz - s.z) * 0.3;
        const spread = anchor ? 0.1 : 0.4;
        const x = bx + s.rnd.range(-spread, spread);
        const z = bz + s.rnd.range(-spread, spread);
        if (s.inside(x, z)) {
          s.target = { x, z };
          s.state = anchor && (far || s.lamb) ? 'trot' : 'walk';
          s.timer = 10;
          return;
        }
      }
    }
    s.state = r < 0.78 ? 'graze' : r < 0.9 ? 'look' : 'rest';
    s.timer = s.state === 'rest' ? s.rnd.range(8, 16) : s.rnd.range(3, 8);
  }

  produce(hex: number) {
    const flock = this.sheep.filter((s) => s.tile.hex.id === hex);
    flock.forEach((s, i) => {
      this.ctx.animator.wait(i * 0.12).then(() => {
        s.hop = 1;
        s.state = 'look';
        s.timer = 2;
        const p = s.root.position;
        for (let k = 0; k < 6; k++) {
          this.ctx.particles.soft.emit({
            x: p.x + (Math.random() - 0.5) * 0.05,
            y: p.y + 0.08,
            z: p.z + (Math.random() - 0.5) * 0.05,
            vx: (Math.random() - 0.5) * 0.15,
            vy: 0.25 + Math.random() * 0.2,
            vz: (Math.random() - 0.5) * 0.15,
            life: 1.2,
            size: 0.03 + Math.random() * 0.025,
            grow: 1.6,
            color: '#fffaf0',
            alpha: 0.9,
            drag: 2,
          });
        }
      });
    });
  }

  dispose() {
    // (Everything the island's life put on the board goes with it: see release.)
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.posts.forEach((p) => p.dispose());
    for (const b of this.batches) {
      if (!b) continue;
      b.body.dispose();
      b.head.dispose();
      b.legs.dispose();
    }
    this.batches = [];
    this.sheep = [];
  }
}

function pointInLoop(x: number, z: number, loop: { x: number; z: number }[], margin: number) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  if (!inside) return false;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    if (Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u)) < margin) return false;
  }
  return true;
}


/**
 * Where a sheep heading from (x0, z0) to (x1, z1) should make for first, if the straight way runs
 * over the number disc in the field's middle: a point a third of the way round the disc on the
 * nearer side, at the sheep's own distance from it (or just outside the disc's clearing). Null when
 * the straight way is clear (or no such point is in the field).
 */
function roundTheDisc(x0: number, z0: number, x1: number, z1: number, inside: (x: number, z: number) => boolean): { x: number; z: number } | null {
  const R = TOKEN_CLEAR + 0.1;
  const dx = x1 - x0, dz = z1 - z0;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, -(x0 * dx + z0 * dz) / len2));
  if (Math.hypot(x0 + dx * t, z0 + dz * t) >= R) return null;
  const a0 = Math.atan2(z0, x0), a1 = Math.atan2(z1, x1);
  let da = a1 - a0;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  const r = Math.max(R, Math.hypot(x0, z0));
  for (const step of [0.9, 0.6, 1.2]) {
    const a = a0 + Math.sign(da) * Math.min(Math.abs(da), step);
    const p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
    if (inside(p.x, p.z)) return p;
  }
  return null;
}
