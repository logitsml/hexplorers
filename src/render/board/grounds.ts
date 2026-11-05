// Fishing grounds (the Fisheries module): each numbered sea hex is a working ground. Its disc
// rides on a tarred float cask, like a sign on a buoy; a ring of net floats, red and white on
// their headline, bobs round it with a marker buoy (a flag, and a lantern lit after dark), and a
// skiff lies moored inside the ring, its fisherman hauling and a gull on its stem; fish break the
// surface now and then, and gulls wheel overhead. When the ground's number comes up the fish boil
// out of the water in a flurry and the gulls drop to them.
//
// Each ground's float, nets, marker and skiff are one rig (one instanced draw for every ground),
// posed once and left alone but for the disc's arrival and a flood's surge; only the fish and the
// gulls move from the CPU. Everything that pierces the sea is narrow (the cask, the floats, the
// skiff's hull), so the sea's contact foam rims each rather than whitening a wide patch, as a flat
// raft's deck awash would.

import * as THREE from 'three/webgpu';
import { Fn, abs, attribute, mix, positionGeometry, positionLocal, sin, smoothstep, time, vec3, vec4, mx_noise_float } from 'three/tsl';
import { isLand, type Board, type Hex } from '../../engine';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBuilder, compose } from './geom';
import { makeSkiff } from './ships';
import type { SeaLift } from './seaLift';
import { pooled, vertexAlbedo, type TileEffects } from './materials';
import { DETAIL_LAYER, GROUND_DISC_Y, SEA_LEVEL } from './layout';
import { lampColor, lampLevelNode } from '../fx/lamps';
import type { ParticleSystem } from '../fx/particles';
import type { DiscCluster } from './tokens';
import { instancedMesh } from './instancing';

const C = (h: string) => new THREE.Color(h);
const LANTERN = lampColor(1.6, 0.85, 0.4);

/** Radius of the ring of net floats round the raft. */
const RING = 0.44;
const FLOATS = 14;
/** The props are modelled small and drawn at the pieces' scale (as the island's pieces are). */
// (The gulls and fish as the island's other animals go, against its people: see life/pasture.ts.)
const SIZE = { float: 1.8, marker: 1.9, gull: 1.08, fish: 1.08, skiff: 1.85 };
const FISH = 9;
const GULLS = 2;

/**
 * The sea props' material: lit vertex colours (squared, as the island's are), a band of green
 * grime at the waterline, a lantern that glows at night (`glow` per vertex), and two motions
 * worked out in the shader from the per-instance `aSea` (phase, bob, flap): bobbing on the swell,
 * and a gull's wingbeat, in bursts between glides. One shader for every ground's props.
 */
function seaPropMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  return pooled(effects, 'seaProp', () => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0 });
    const sea = attribute<'vec3'>('aSea', 'vec3');
    const glow = attribute<'float'>('glow', 'float');
    m.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const ph = sea.x;
      // Riding the swell: up and down, each float, the marker and the skiff in its own time.
      const swell = sin(time.mul(1.35).add(ph)).mul(0.0035).add(sin(time.mul(2.3).add(ph.mul(1.7))).mul(0.0015));
      p.y.addAssign(swell.mul(sea.y));
      // Wingbeats in bursts: the wings (everything out past the body) swing about the shoulder.
      const span = abs(positionGeometry.z);
      const burst = smoothstep(0.2, 0.6, sin(time.mul(0.55).add(ph.mul(2.1))));
      p.y.addAssign(span.mul(sin(time.mul(10).add(ph))).mul(0.9).mul(burst).mul(sea.z).mul(smoothstep(0.004, 0.012, span)));
      return p;
    })();
    m.colorNode = Fn(() => {
      const c = vertexAlbedo();
      const grime = smoothstep(0.004, 0.0, positionGeometry.y).mul(sea.y).mul(mx_noise_float(positionGeometry.mul(160)).mul(0.3).add(0.7));
      return vec4(mix(c, vec3(0.05, 0.07, 0.03), grime.mul(0.5)), 1);
    })();
    m.emissiveNode = vec3(LANTERN.r, LANTERN.g, LANTERN.b).mul(glow).mul(lampLevelNode(effects.night));
    return m;
  });
}

/** Give a geometry the attributes the sea props' material reads (a lantern's vertices glow). */
function prepared(g: THREE.BufferGeometry, glowAbove = Infinity): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const pos = g.getAttribute('position');
  const glow = new Float32Array(n);
  for (let i = 0; i < n; i++) glow[i] = pos.getY(i) > glowAbove ? 1 : 0;
  g.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
  return g;
}

/**
 * The float under the disc: a tarred cask on end, iron-hooped, with a rope lashing round its
 * middle and a plank cap the disc sits on. Narrow (0.2 across, under a disc 0.43 across), so
 * the sea foams round it in a thin ring hidden mostly by the disc.
 */
function makeCask(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const top = GROUND_DISC_Y - SEA_LEVEL - 0.002;
  const body = new THREE.CylinderGeometry(0.098, 0.084, top + 0.035, 16);
  b.addGeometry(body, compose(0, (top - 0.035) / 2, 0), (_x, y, _z, o) => o.set(Math.abs(y - top + 0.012) < 0.004 || Math.abs(y + 0.004) < 0.004 ? '#3d3832' : '#4a3a2c'));
  body.dispose();
  const cap = new THREE.CylinderGeometry(0.104, 0.104, 0.006, 16);
  b.addGeometry(cap, compose(0, top - 0.003, 0), C('#6e5236'));
  cap.dispose();
  const lash = new THREE.TorusGeometry(0.094, 0.0035, 4, 24);
  b.addGeometry(lash, compose(0, 0.018, 0, Math.PI / 2, 0, 0), C('#a8956c'));
  lash.dispose();
  return b.build(false);
}

/** A net float on its headline: a cork barrel, red or white, and the line to the next float. */
function makeFloat(red: boolean, span: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const g = new THREE.CylinderGeometry(0.0085, 0.0085, 0.016, 10);
  b.addGeometry(g, compose(0, 0.002, 0, 0, 0, Math.PI / 2), red ? C('#c4472f') : C('#ece4d2'));
  g.dispose();
  const cap = new THREE.SphereGeometry(0.0086, 10, 6);
  for (const x of [-0.008, 0.008]) b.addGeometry(cap, compose(x, 0.002, 0, 0, 0, 0, 0.4, 1, 1), red ? C('#a53a26') : C('#d8cfbc'));
  cap.dispose();
  // (Riding a little over the water: a line just awash smeared the sea's contact foam along it.)
  const line = new THREE.CylinderGeometry(0.0009, 0.0009, span, 3);
  b.addGeometry(line, compose(span / 2, 0.0035, 0, 0, 0, Math.PI / 2), C('#b8a57a'));
  line.dispose();
  return prepared(b.build(false));
}

/** The marker buoy: a red and white can on a float collar, a pole with a pennant and a lantern. */
function makeMarker(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const red = C('#c4472f'), white = C('#ece4d2');
  const collar = new THREE.CylinderGeometry(0.022, 0.026, 0.012, 14);
  b.addGeometry(collar, compose(0, 0.002, 0), C('#3e3a36'));
  collar.dispose();
  for (let i = 0; i < 3; i++) {
    const g = new THREE.CylinderGeometry(0.016 - i * 0.003, 0.018 - i * 0.003, 0.016, 12);
    b.addGeometry(g, compose(0, 0.016 + i * 0.016, 0), i % 2 ? white : red);
    g.dispose();
  }
  const pole = new THREE.CylinderGeometry(0.0016, 0.0016, 0.05, 5);
  b.addGeometry(pole, compose(0, 0.078, 0), C('#4a4440'));
  pole.dispose();
  const flag = new THREE.BoxGeometry(0.022, 0.012, 0.0012);
  b.addGeometry(flag, compose(0.012, 0.094, 0), red);
  flag.dispose();
  // The lantern (its glass glows at night: see prepared).
  const cage = new THREE.CylinderGeometry(0.004, 0.004, 0.009, 6);
  b.addGeometry(cage, compose(0, 0.108, 0), C('#ffd99a'));
  cage.dispose();
  const hood = new THREE.ConeGeometry(0.0055, 0.005, 6);
  b.addGeometry(hood, compose(0, 0.115, 0), C('#3a3633'));
  hood.dispose();
  return prepared(b.build(false), 0.1035);
}

/** A fish leaping: silvery, dark-backed, about 0.05 long, nose towards +x. */
function makeFish(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const body = new THREE.SphereGeometry(1, 12, 8);
  b.addGeometry(body, compose(0, 0, 0, 0, 0, 0, 0.022, 0.0065, 0.0045), (_x, y, _z, o) => o.set(y > 0.002 ? '#47607a' : y > -0.002 ? '#b9c8d2' : '#e8eef0'));
  body.dispose();
  const tail = new THREE.ConeGeometry(0.008, 0.012, 4);
  b.addGeometry(tail, compose(-0.025, 0, 0, 0, 0, Math.PI / 2, 1, 1, 0.25), C('#5b7088'));
  tail.dispose();
  return prepared(b.build(false));
}

/**
 * A gull gliding: a white body and tail, swept grey wings in a shallow gull-wing bend with black
 * tips, a yellow bill. Wingspan about 0.12 (before SIZE), nose towards +x.
 */
function makeGull(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const body = new THREE.SphereGeometry(1, 12, 8);
  b.addGeometry(body, compose(0, 0, 0, 0, 0, 0, 0.017, 0.0056, 0.0058), (_x, y, _z, o) => o.set(y > 0.003 ? '#e9e9e6' : '#f6f6f2'));
  body.dispose();
  const head = new THREE.SphereGeometry(0.0045, 10, 6);
  b.addGeometry(head, compose(0.014, 0.0025, 0), C('#f8f8f4'));
  head.dispose();
  const beak = new THREE.ConeGeometry(0.0014, 0.006, 4);
  b.addGeometry(beak, compose(0.0205, 0.0018, 0, 0, 0, -Math.PI / 2), C('#e3a83c'));
  beak.dispose();
  // Each wing a swept, tapering plate in two panels (inner rising, outer drooping), both faces.
  const grey = C('#aeb3b8'), tip = C('#2a2b2e'), under = C('#e4e4e0');
  const wing = (s: number) => {
    // Leading and trailing edge points from root to tip: (x lead, x trail, z out, y).
    const st = [
      [0.008, -0.008, 0.004, 0.001],
      [0.004, -0.012, 0.03, 0.006],
      [-0.006, -0.014, 0.05, 0.004],
      [-0.016, -0.019, 0.064, 0.0],
    ];
    for (let k = 0; k + 1 < st.length; k++) {
      const [l0, t0, z0, y0] = st[k], [l1, t1, z1, y1] = st[k + 1];
      const c = k === 2 ? tip : grey;
      const n = [0, 1, 0] as const;
      const a = b.vertex(l0, y0, s * z0, c, ...n), bb = b.vertex(t0, y0, s * z0, c, ...n);
      const cc = b.vertex(t1, y1, s * z1, c, ...n), d = b.vertex(l1, y1, s * z1, c, ...n);
      // (Wound to face up; mirrored for the left wing.)
      if (s > 0) b.quad(a, bb, cc, d);
      else b.quad(a, d, cc, bb);
      const cu = k === 2 ? tip : under;
      const ua = b.vertex(l0, y0 - 0.0006, s * z0, cu, 0, -1, 0), ub = b.vertex(t0, y0 - 0.0006, s * z0, cu, 0, -1, 0);
      const uc = b.vertex(t1, y1 - 0.0006, s * z1, cu, 0, -1, 0), ud = b.vertex(l1, y1 - 0.0006, s * z1, cu, 0, -1, 0);
      if (s > 0) b.quad(ua, ud, uc, ub);
      else b.quad(ua, ub, uc, ud);
    }
  };
  wing(1);
  wing(-1);
  const tail = new THREE.ConeGeometry(0.006, 0.012, 3);
  b.addGeometry(tail, compose(-0.02, 0.001, 0, 0, 0, Math.PI / 2, 1, 0.25, 1), C('#efefeb'));
  tail.dispose();
  return prepared(b.build(false));
}

/** A part of a ground's rig: its geometry under a transform, with the attributes the sea props' material reads. */
function rigPart(g: THREE.BufferGeometry, m: THREE.Matrix4, sea: [number, number, number]): THREE.BufferGeometry {
  const out = g.clone().applyMatrix4(m);
  for (const name of Object.keys(out.attributes)) if (!['position', 'normal', 'color', 'glow'].includes(name)) out.deleteAttribute(name);
  const n = out.getAttribute('position').count;
  if (!out.getAttribute('glow')) out.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n), 1));
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(sea, i * 3);
  out.setAttribute('aSea', new THREE.BufferAttribute(a, 3));
  return out;
}

/**
 * A ground's rig, in one geometry (about the hex's middle, the sea level at y = 0): the cask
 * under the disc, the ring of floats on their headline, the marker buoy, and the skiff moored
 * inside the ring. Each part bobs in its own time (aSea per vertex: phase, how much it bobs);
 * the cask doesn't, so the disc it carries sits still on it.
 */
function makeRig(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const m = (x: number, y: number, z: number, yaw: number, sx: number, sy = sx, sz = sx) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(sx, sy, sz));
  const cask = makeCask();
  parts.push(rigPart(cask, new THREE.Matrix4(), [0, 0, 0]));
  cask.dispose();
  const span = 2 * RING * Math.sin(Math.PI / FLOATS);
  const red = makeFloat(true, span), white = makeFloat(false, span);
  for (let i = 0; i < FLOATS; i++) {
    const a = (i / FLOATS) * Math.PI * 2;
    const r = RING * (1 + 0.04 * Math.sin(i * 2.7));
    // (Stretched up and across but not along: the headline still spans float to float.)
    parts.push(rigPart(i % 2 ? white : red, m(Math.cos(a) * r, 0.011, Math.sin(a) * r, -(a + Math.PI / 2 + Math.PI / FLOATS), 1, SIZE.float, SIZE.float), [i * 0.9, 1, 0]));
  }
  red.dispose();
  white.dispose();
  const ma = -2.3;
  const marker = makeMarker();
  parts.push(rigPart(marker, m(Math.cos(ma) * (RING + 0.07), 0.002, Math.sin(ma) * (RING + 0.07), ma, SIZE.marker), [2.3, 1, 0]));
  marker.dispose();
  // The skiff lies across the ring between the disc and the nets, near the marker, riding high
  // enough that the swell laps its sides but never washes over it (as the ships ride: marks.ts).
  const sa = ma + 0.95;
  const skiff = makeSkiff();
  parts.push(rigPart(skiff, m(Math.cos(sa) * 0.33, 0.02, Math.sin(sa) * 0.33, -(sa + Math.PI / 2), SIZE.skiff), [1.1, 0.8, 0]));
  skiff.dispose();
  const rig = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return rig;
}

interface Leap {
  slot: number;
  t: number;
  dur: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  h: number;
}

interface Ground {
  hex: Hex;
  disc: DiscCluster | undefined;
  /** Shown as far as its disc is (they arrive together in the opening). */
  shown: number;
  /** How the rig was last posed (its arrival, and the sea's lift under it): it is posed again only when they change. */
  posedK: number;
  posedLift: number;
  next: number;
  leaps: Leap[];
  /** A flurry's push, easing off: the gulls drop low and wheel faster. */
  stir: number;
  gullPhase: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** The fishing grounds' props: every ground's rig in one instanced draw, and the fish and the gulls in one each. */
export class Grounds {
  group = new THREE.Group();
  private grounds: Ground[] = [];
  private meshes: Record<'rig' | 'fish' | 'gull', THREE.InstancedMesh | null> = { rig: null, fish: null, gull: null };
  private disposables: { dispose(): void }[] = [];
  private freeFish: number[] = [];

  constructor(
    board: Board,
    effects: TileEffects,
    private spray: ParticleSystem,
    private ripple: (x: number, z: number, size: number, life: number) => void,
    discs: Map<number, DiscCluster>,
    private lift: SeaLift | null = null,
  ) {
    const hexes = board.hexes.filter((h) => !isLand(h.terrain) && h.numbers.length > 0);
    if (!hexes.length) return;
    this.grounds = hexes.map((hex, i) => ({ hex, disc: discs.get(hex.id), shown: 0, posedK: -1, posedLift: 0, next: 1 + i * 1.3, leaps: [], stir: 0, gullPhase: hex.id * 2.1 }));
    const mat = seaPropMaterial(effects);
    const n = hexes.length;
    const make = (key: keyof Grounds['meshes'], geo: THREE.BufferGeometry, count: number, shadow: boolean, phase?: (i: number) => [number, number, number]) => {
      if (phase) {
        const sea = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) sea.set(phase(i), i * 3);
        geo.setAttribute('aSea', new THREE.InstancedBufferAttribute(sea, 3));
      }
      const m = instancedMesh(geo, mat, count);
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.layers.set(DETAIL_LAYER);
      this.disposables.push(geo, m);
      this.group.add(m);
      this.meshes[key] = m;
    };
    make('rig', makeRig(), n, true);
    make('fish', makeFish(), n * FISH, false, () => [0, 0, 0]);
    make('gull', makeGull(), n * GULLS, true, (i) => [i * 1.9, 0, 1]);
    // (No fish is in the air yet: every slot starts out of sight, not at the world's origin.)
    for (let i = 0; i < n * FISH; i++) this.meshes.fish!.setMatrixAt(i, ZERO);
    for (let i = n * FISH - 1; i >= 0; i--) this.freeFish.push(i);
    this.update(0, 0);
  }

  update(dt: number, t: number) {
    const M = this.meshes;
    if (!M.rig) return;
    let posed = false, fishMoved = false;
    this.grounds.forEach((g, gi) => {
      const disc = g.disc?.group;
      g.shown = disc && disc.visible ? Math.min(1, disc.scale.x) : 0;
      const k = g.shown;
      const { x, z } = g.hex;
      const lift = this.lift?.(x, z) ?? 0;
      if (k !== g.posedK || Math.abs(lift - g.posedLift) > 1e-4) {
        // The rig under the disc, turned a different way on each ground; the disc rides up on
        // its cask with the sea when a flood lifts it.
        M.rig!.setMatrixAt(gi, _m.compose(_p.set(x, SEA_LEVEL + lift, z), _q.setFromEuler(_e.set(0, gi * 0.7, 0)), _s.setScalar(Math.max(1e-4, k))));
        if (disc && Math.abs(lift - g.posedLift) > 1e-4) disc.position.y = GROUND_DISC_Y + lift;
        g.posedK = k;
        g.posedLift = lift;
        posed = true;
      }
      // Gulls wheel overhead, lower and quicker while the fish are up.
      g.stir = Math.max(0, g.stir - dt * 0.25);
      g.gullPhase += dt * (0.45 + g.stir * 0.6);
      for (let j = 0; j < GULLS; j++) {
        const a = g.gullPhase * (j ? -1 : 1) + j * 2.4;
        const r = 0.36 + 0.12 * j + 0.04 * Math.sin(t * 0.3 + j);
        const y = SEA_LEVEL + 0.62 + 0.18 * j + 0.06 * Math.sin(t * 0.5 + gi + j) - g.stir * 0.35 + lift;
        const dir = j ? -1 : 1;
        // Heading along the circle, banked into the turn.
        _q.setFromEuler(_e.set(dir * 0.32, -(a + (dir * Math.PI) / 2), 0, 'YXZ'));
        M.gull!.setMatrixAt(gi * GULLS + j, _m.compose(_p.set(x + Math.cos(a) * r, y, z + Math.sin(a) * r), _q, _s.setScalar(Math.max(1e-4, k * SIZE.gull))));
      }
      // Now and then a fish breaks the surface inside the ring.
      g.next -= dt;
      if (g.next <= 0 && k > 0.99) {
        g.next = 2.5 + Math.random() * 5;
        this.leap(g);
      }
    });
    // Fish in the air: up out of the water and back in, nose along the arc.
    for (const g of this.grounds)
      for (let i = g.leaps.length - 1; i >= 0; i--) {
        const L = g.leaps[i];
        const was = L.t;
        L.t += dt / L.dur;
        fishMoved = true;
        if (was <= 0 && L.t > 0) this.splash(L.x0, L.z0, 0.6);
        if (L.t >= 1) {
          this.splash(L.x1, L.z1, 1);
          M.fish!.setMatrixAt(L.slot, ZERO);
          this.freeFish.push(L.slot);
          g.leaps.splice(i, 1);
          continue;
        }
        const u = Math.max(0, L.t);
        const px = L.x0 + (L.x1 - L.x0) * u, pz = L.z0 + (L.z1 - L.z0) * u;
        const py = SEA_LEVEL - 0.01 + 4 * L.h * u * (1 - u);
        const pitch = Math.atan2(4 * L.h * (1 - 2 * u), Math.hypot(L.x1 - L.x0, L.z1 - L.z0));
        _q.setFromEuler(_e.set(0, -Math.atan2(L.z1 - L.z0, L.x1 - L.x0), pitch, 'YZX'));
        M.fish!.setMatrixAt(L.slot, _m.compose(_p.set(px, py, pz), _q, _s.setScalar(L.t < 0 ? 0 : SIZE.fish)));
      }
    // (Only what moved goes up to the GPU: the gulls every frame, the rigs and fish when they change.)
    M.gull!.instanceMatrix.needsUpdate = true;
    if (posed || dt === 0) M.rig.instanceMatrix.needsUpdate = true;
    if (fishMoved || dt === 0) M.fish!.instanceMatrix.needsUpdate = true;
  }

  /** One fish leaping, somewhere inside the ring (after `delay` seconds). */
  private leap(g: Ground, delay = 0, high = 1) {
    const slot = this.freeFish.pop();
    if (slot === undefined) return;
    const a = Math.random() * Math.PI * 2, r = 0.2 + Math.random() * 0.18;
    const x0 = g.hex.x + Math.cos(a) * r, z0 = g.hex.z + Math.sin(a) * r;
    const d = Math.random() * Math.PI * 2, len = 0.05 + Math.random() * 0.05 * high;
    g.leaps.push({ slot, t: -delay / 0.6, dur: 0.5 + Math.random() * 0.25, x0, z0, x1: x0 + Math.cos(d) * len, z1: z0 + Math.sin(d) * len, h: (0.035 + Math.random() * 0.03) * high });
  }

  private splash(x: number, z: number, size: number) {
    this.ripple(x, z, 0.06 * size + 0.04, 1.1);
    for (let i = 0; i < 6 * size; i++)
      this.spray.emit({ x, y: SEA_LEVEL + 0.005, z, vx: (Math.random() - 0.5) * 0.12, vy: 0.2 + Math.random() * 0.25, vz: (Math.random() - 0.5) * 0.12, life: 0.4 + Math.random() * 0.25, size: 0.008, gravity: 1.4, color: '#eef6f6' });
  }

  /** The ground yields: the fish boil up all over the ring, and the gulls come down to them. */
  flurry(hex: number) {
    const g = this.grounds.find((o) => o.hex.id === hex);
    if (!g || g.shown < 0.99) return;
    g.stir = 1;
    for (let i = 0; i < FISH - 1; i++) this.leap(g, i * 0.16 + Math.random() * 0.1, 1.3);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.grounds = [];
  }
}
