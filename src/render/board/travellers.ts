// Travellers on the players' road networks: villagers on foot and horse-drawn carts. Each
// player gets a walker once they have a road, a cart at five roads and a second walker at
// nine. They keep to the verge, curve on to connecting roads at junctions (round the houses
// standing there) and over their own bridges, and turn round at dead ends, where they stop for a
// moment to look about (and sometimes wave). Another player's house on a corner is a dead end:
// it breaks the network there, as the rules have it.

import { writeMatrix } from '../util/matrices';
import { easeAngle, follow } from '../util/angle';
import * as THREE from 'three/webgpu';
import type { Board, PlayerColor, PlayerId } from '../../engine';
import { MeshBuilder, compose, smoothSphere } from './geom';
import { PLAYER_PALETTE, ROAD_LENGTH } from './pieces';
import { BRIDGE, deckY, edgeFrame, roadFrame } from './layout';
import type { LampLights } from '../fx/lampLights';
import { WINDOW_LIGHT, lampColor } from '../fx/lamps';

const CART_LIGHT = lampColor(...WINDOW_LIGHT);

const C = (h: string) => new THREE.Color(h);

const SKIN = ['#e7bc95', '#c98f64', '#8d5a3b', '#f0caa8'];
const HAIR = ['#3b2a1d', '#6b4a2b', '#1f1a17', '#a7713a'];
const STRAW = '#d9b66a';
const BOOT = '#3a2a1e';
const TROUSERS = '#5a4636';

/** The shared piece material reads per-vertex window-glow and sway attributes. */
function finish(g: THREE.BufferGeometry, glow = 0) {
  const n = g.getAttribute('position').count;
  g.setAttribute('glow', new THREE.Float32BufferAttribute(new Float32Array(n).fill(glow), 1));
  g.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  return g;
}

function add(b: MeshBuilder, g: THREE.BufferGeometry, m: THREE.Matrix4, c: string | THREE.Color) {
  b.addGeometry(g, m, typeof c === 'string' ? C(c) : c);
  g.dispose();
}

// ------------------------------------------------------------------ people
// Modelled facing +x with the feet at y = 0. Limbs are separate meshes hinged at hip and
// shoulder so they can swing.

const HIP = 0.016;
const SHOULDER = 0.0285;

interface Look {
  tunic: string;
  trim: string;
  skin: string;
  hair: string;
  hat: 'straw' | 'hood' | 'cap' | 'none';
  pack: boolean;
}

function makeTorso(look: Look, seated = false): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const y0 = seated ? 0.004 : HIP;
  // Tunic flaring to a short skirt, a belt and a collar in the trim colour.
  add(b, new THREE.CylinderGeometry(0.0044, 0.0064, 0.0165, 10), compose(0, y0 + 0.0065, 0), look.tunic);
  add(b, new THREE.CylinderGeometry(0.0055, 0.0057, 0.0018, 10), compose(0, y0 + 0.003, 0), '#4a3424');
  add(b, new THREE.CylinderGeometry(0.0034, 0.0044, 0.0016, 10), compose(0, y0 + 0.0145, 0), look.trim);
  const hy = y0 + 0.0195;
  add(b, smoothSphere(0.0041, 2), compose(0.0003, hy, 0), look.skin);
  add(b, smoothSphere(0.0011, 1), compose(0.0042, hy - 0.0003, 0), look.skin);
  if (look.hat === 'straw') {
    add(b, new THREE.CylinderGeometry(0.0082, 0.0082, 0.0006, 16), compose(0, hy + 0.0028, 0), STRAW);
    add(b, new THREE.CylinderGeometry(0.0031, 0.0038, 0.0034, 12), compose(0, hy + 0.0045, 0), STRAW);
    add(b, new THREE.CylinderGeometry(0.0039, 0.0039, 0.0009, 12), compose(0, hy + 0.0034, 0), look.trim);
  } else if (look.hat === 'hood') {
    const hood = smoothSphere(0.0049, 2);
    hood.scale(1, 1.05, 1);
    add(b, hood, compose(-0.0009, hy + 0.0006, 0), C(look.tunic).multiplyScalar(0.75));
    const cape = new THREE.CylinderGeometry(0.0046, 0.0074, 0.012, 10, 1, true, Math.PI * 0.55, Math.PI * 0.9);
    add(b, cape, compose(0, y0 + 0.0095, 0, 0, Math.PI, 0), C(look.tunic).multiplyScalar(0.75));
  } else if (look.hat === 'cap') {
    const cap = smoothSphere(0.0044, 2);
    cap.scale(1.15, 0.55, 1.1);
    add(b, cap, compose(-0.0004, hy + 0.0025, 0), look.trim);
  } else {
    const hair = smoothSphere(0.0043, 2);
    hair.scale(1, 0.75, 1);
    add(b, hair, compose(-0.0007, hy + 0.0016, 0), look.hair);
  }
  if (look.pack && !seated) {
    const pack = new THREE.BoxGeometry(0.0045, 0.0085, 0.0075);
    add(b, pack, compose(-0.0062, y0 + 0.009, 0), '#7d5f40');
    const roll = new THREE.CylinderGeometry(0.0018, 0.0018, 0.0082, 8);
    add(b, roll, compose(-0.0062, y0 + 0.0142, 0, Math.PI / 2, 0, 0), '#b8a27a');
  }
  if (seated) {
    // Thighs forward along the bench, shins hanging down.
    for (const s of [-1, 1]) {
      add(b, new THREE.CylinderGeometry(0.0021, 0.0021, 0.009, 6), compose(0.004, y0 + 0.0014, s * 0.0025, 0, 0, Math.PI / 2), TROUSERS);
      add(b, new THREE.CylinderGeometry(0.0019, 0.0017, 0.009, 6), compose(0.0085, y0 - 0.0031, s * 0.0025), TROUSERS);
      add(b, new THREE.BoxGeometry(0.004, 0.0015, 0.0026), compose(0.0095, y0 - 0.0081, s * 0.0025), BOOT);
    }
    // Arms reaching forward to the reins.
    for (const s of [-1, 1]) {
      add(b, smoothSphere(0.0023, 1), compose(0, y0 + 0.0122, s * 0.0049), look.tunic);
      // Shoulder (0, y0 + 0.0122) down and forward to the hand (0.0085, y0 + 0.0065).
      add(b, new THREE.CylinderGeometry(0.0017, 0.0014, 0.0106, 6), compose(0.00425, y0 + 0.00935, s * 0.0049, 0, 0, -(Math.PI / 2 + 0.59)), look.tunic);
      add(b, smoothSphere(0.0017, 1), compose(0.0087, y0 + 0.0064, s * 0.0049), look.skin);
    }
  }
  return finish(b.build(false));
}

function makeLeg(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  add(b, new THREE.CylinderGeometry(0.0021, 0.0018, 0.0145, 7), compose(0, -0.0072, 0), TROUSERS);
  add(b, new THREE.BoxGeometry(0.0052, 0.0022, 0.0031), compose(0.001, -0.0148, 0), BOOT);
  return finish(b.build(false));
}

function makeArm(look: Look, staff: boolean): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // A rounded shoulder at the pivot, sunk into the torso, so the joint never shows a gap.
  add(b, smoothSphere(0.0024, 1), compose(0, -0.0004, 0), look.tunic);
  add(b, new THREE.CylinderGeometry(0.0019, 0.0014, 0.0125, 7), compose(0, -0.0062, 0), look.tunic);
  add(b, smoothSphere(0.0017, 1), compose(0, -0.0133, 0), look.skin);
  if (staff) add(b, new THREE.CylinderGeometry(0.0006, 0.0006, 0.036, 5), compose(0.001, -0.012, 0.0004, 0, 0, -0.12), '#7c5a3a');
  return finish(b.build(false));
}

// ------------------------------------------------------------------ horse and cart
// The horse faces +x with its hooves at y = 0; legs and the head/neck are separate so the
// walk can swing them. The cart's axle is its origin and its shafts reach forward to the horse.

const HORSE_COATS = [
  { coat: '#7a5236', mane: '#2e2118' },
  { coat: '#a39a8e', mane: '#e8e2d8' },
  { coat: '#4b3426', mane: '#1d1510' },
  { coat: '#b7895a', mane: '#f1e3c4' },
];
const HORSE_HIP = 0.0215;
const HORSE_LEGS: [number, number][] = [
  [0.0125, 0.0052],
  [0.0125, -0.0052],
  [-0.0135, 0.0052],
  [-0.0135, -0.0052],
];
/** Horse and cart sizes relative to people, and the horse-centre-to-axle distance (in
 * person-scale units): the horse's rump, a gap, then the cart's front board. */
const HORSE_SCALE = 0.9;
const CART_SCALE = 1.22;
const HITCH = 0.0205 * HORSE_SCALE + 0.017 * CART_SCALE + 0.009;
const WHEEL_R = 0.0095;

function makeHorseBody(coat: string, mane: string, harness: string): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const barrel = smoothSphere(0.0105, 2);
  barrel.scale(1.75, 0.95, 0.78);
  add(b, barrel, compose(0, 0.027, 0), coat);
  const rump = smoothSphere(0.0085, 2);
  add(b, rump, compose(-0.012, 0.0285, 0), coat);
  const chest = smoothSphere(0.0082, 2);
  add(b, chest, compose(0.0125, 0.0275, 0), coat);
  // Tail hanging from the rump.
  const tail = new THREE.ConeGeometry(0.0028, 0.016, 7);
  add(b, tail, compose(-0.0205, 0.0225, 0, 0, 0, -0.35 + Math.PI), mane);
  // Harness: a collar band and a saddle pad in the player's colour.
  add(b, new THREE.CylinderGeometry(0.0104, 0.0104, 0.0042, 14), compose(0.002, 0.027, 0, 0, 0, Math.PI / 2, 1, 1, 0.82), harness);
  add(b, new THREE.CylinderGeometry(0.0088, 0.0088, 0.0022, 14), compose(0.0122, 0.028, 0, 0, 0, Math.PI / 2 - 0.3, 1, 1, 0.92), '#3a2a1e');
  return finish(b.build(false));
}

/** Neck and head, hinged at the withers (origin). */
function makeHorseHead(coat: string, mane: string): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const neck = new THREE.CylinderGeometry(0.0038, 0.0058, 0.017, 9);
  add(b, neck, compose(0.0045, 0.0062, 0, 0, 0, -0.62), coat);
  const crest = new THREE.BoxGeometry(0.0016, 0.016, 0.0018);
  add(b, crest, compose(0.0026, 0.0084, 0, 0, 0, -0.62), mane);
  const head = smoothSphere(0.0046, 2);
  head.scale(1.75, 0.82, 0.78);
  add(b, head, compose(0.0128, 0.0118, 0, 0, 0, -0.55), coat);
  const muzzle = smoothSphere(0.0032, 1);
  add(b, muzzle, compose(0.0178, 0.0083, 0), C(coat).multiplyScalar(0.7));
  for (const s of [-1, 1]) {
    add(b, new THREE.ConeGeometry(0.0012, 0.004, 5), compose(0.0092, 0.0168, s * 0.0019, s * 0.2, 0, -0.2), coat);
    add(b, smoothSphere(0.0007, 1), compose(0.0149, 0.0131, s * 0.0034), '#15100c');
  }
  return finish(b.build(false));
}

function makeHorseLeg(coat: string): THREE.BufferGeometry {
  const b = new MeshBuilder();
  add(b, new THREE.CylinderGeometry(0.0026, 0.0016, 0.0185, 7), compose(0, -0.0092, 0), coat);
  add(b, new THREE.CylinderGeometry(0.0019, 0.0022, 0.0028, 7), compose(0, -0.0198, 0), '#2a201a');
  return finish(b.build(false));
}

type CartLoad = 'wagon' | 'hay' | 'barrels';

function makeCart(load: CartLoad, color: string, trim: string): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const wood = '#8a6440', dark = '#5e4128';
  const y = WHEEL_R + 0.0015;
  // Bed and side boards.
  add(b, new THREE.BoxGeometry(0.03, 0.0022, 0.0205), compose(0.002, y, 0), wood);
  for (const s of [-1, 1]) add(b, new THREE.BoxGeometry(0.03, 0.0045, 0.0012), compose(0.002, y + 0.003, s * 0.0098), C(color).lerp(C(wood), 0.35));
  add(b, new THREE.BoxGeometry(0.0012, 0.0045, 0.0205), compose(-0.013, y + 0.003, 0), wood);
  // Axle, shafts out to the horse and a driver's bench at the front.
  add(b, new THREE.CylinderGeometry(0.0008, 0.0008, 0.026, 6), compose(0, WHEEL_R, 0, Math.PI / 2, 0, 0), dark);
  for (const s of [-1, 1]) add(b, new THREE.BoxGeometry(0.036, 0.0011, 0.0011), compose(0.033, y + 0.006, s * 0.0096, 0, 0, 0.3), dark);
  add(b, new THREE.BoxGeometry(0.0055, 0.0016, 0.0185), compose(0.0135, y + 0.007, 0), dark);
  add(b, new THREE.BoxGeometry(0.0012, 0.006, 0.0185), compose(0.0168, y + 0.0035, 0), dark);
  if (load === 'wagon') {
    // A covered wagon: hoops and a canvas tilt.
    // Half a tube: theta 0..π is its +x half, which the roll below turns to face up.
    const tilt = new THREE.CylinderGeometry(0.0108, 0.0108, 0.018, 14, 1, true, 0, Math.PI);
    add(b, tilt, compose(-0.0035, y + 0.0045, 0, 0, 0, Math.PI / 2), '#efe6d2');
    for (const x of [-0.0125, 0.0055]) {
      const hoop = new THREE.TorusGeometry(0.0109, 0.0006, 4, 14, Math.PI);
      add(b, hoop, compose(x, y + 0.0045, 0, 0, 0, 0), trim);
    }
    add(b, new THREE.CylinderGeometry(0.0007, 0.0007, 0.018, 4), compose(-0.0035, y + 0.0153, 0, 0, 0, Math.PI / 2), color);
  } else if (load === 'hay') {
    const hay = smoothSphere(0.012, 2);
    hay.scale(1.15, 0.6, 0.78);
    add(b, hay, compose(-0.002, y + 0.0065, 0), '#d8b45a');
    const hay2 = smoothSphere(0.0075, 1);
    add(b, hay2, compose(-0.004, y + 0.0115, 0.002), '#e2c26b');
  } else {
    for (const [x, z] of [[-0.0075, -0.0045], [-0.0075, 0.0045], [0.001, -0.0045], [0.001, 0.0045]]) {
      add(b, new THREE.CylinderGeometry(0.0034, 0.0034, 0.0075, 10), compose(x, y + 0.005, z), '#7a5232');
      add(b, new THREE.CylinderGeometry(0.0036, 0.0036, 0.0009, 10), compose(x, y + 0.0062, z), '#3d3a36');
    }
    const sack = smoothSphere(0.0042, 1);
    sack.scale(1.2, 0.8, 1);
    add(b, sack, compose(-0.0035, y + 0.0118, 0), '#cdb58a');
  }
  return finish(b.build(false));
}

function makeWheel(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  add(b, new THREE.TorusGeometry(WHEEL_R - 0.0007, 0.0009, 5, 18), compose(0, 0, 0), '#4f3420');
  add(b, new THREE.CylinderGeometry(0.0017, 0.0017, 0.0026, 8), compose(0, 0, 0, Math.PI / 2, 0, 0), '#3a2818');
  for (let i = 0; i < 4; i++) add(b, new THREE.BoxGeometry(0.0006, WHEEL_R * 2 - 0.002, 0.0008), compose(0, 0, 0, 0, 0, (i * Math.PI) / 4), '#6b4a2e');
  return finish(b.build(false));
}

/** A porter's crate of the harvest, in its colour, with dark slats. */
function makeCrate(color: string): THREE.BufferGeometry {
  const b = new MeshBuilder();
  add(b, new THREE.BoxGeometry(0.0085, 0.0095, 0.0085), compose(0, 0, 0), color);
  for (const y of [-0.0035, 0.0035]) add(b, new THREE.BoxGeometry(0.009, 0.0012, 0.009), compose(0, y, 0), '#5e4128');
  return finish(b.build(false));
}

/** A lantern on a pole at the front of the cart. */
function makeLanternFrame(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  add(b, new THREE.CylinderGeometry(0.0005, 0.0005, 0.012, 4), compose(0, 0.006, 0), '#3a2818');
  add(b, new THREE.BoxGeometry(0.0034, 0.0007, 0.0034), compose(0, 0.0148, 0), '#2a2420');
  add(b, new THREE.ConeGeometry(0.0026, 0.0018, 4), compose(0, 0.0192, 0, 0, Math.PI / 4, 0), '#2a2420');
  return finish(b.build(false));
}

/** Its flame: lit through the piece material's window glow, so it shines at night. */
function makeLanternFlame(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  add(b, new THREE.BoxGeometry(0.0026, 0.0034, 0.0026), compose(0, 0.0167, 0), '#ffd27a');
  return finish(b.build(false), 1);
}

/**
 * A walker's hand lantern, hanging from the hand (the arm's end is the origin): a bail, a cap and
 * a base round the flame (the cart's, see makeLanternFlame, hung just under the cap).
 */
function makeHandLantern(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  add(b, new THREE.TorusGeometry(0.0012, 0.00035, 3, 8, Math.PI), compose(0, -0.0021, 0), '#2a2420');
  add(b, new THREE.ConeGeometry(0.0022, 0.0016, 4), compose(0, -0.0042, 0, 0, Math.PI / 4, 0), '#2a2420');
  add(b, new THREE.BoxGeometry(0.0032, 0.0007, 0.0032), compose(0, -0.0089, 0), '#2a2420');
  return finish(b.build(false));
}

/** Where the flame hangs in the hand lantern: makeLanternFlame's box (at 0.0167 up) moved under the cap. */
const HAND_FLAME = -0.0235;

// ------------------------------------------------------------------ routes

interface Point {
  x: number;
  z: number;
}

interface Sample {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

/**
 * A stretch of a traveller's route: straight along a road, or a curve joining one road to
 * the next (through a junction or a U-turn at a dead end), so the path never jumps.
 */
interface Segment {
  len: number;
  at(s: number, out: Sample): void;
}

function line(p: Point, q: Point): Segment {
  const dx = q.x - p.x, dz = q.z - p.z;
  const len = Math.hypot(dx, dz) || 1e-6;
  return {
    len,
    at(s, o) {
      const u = s / len;
      o.x = p.x + dx * u;
      o.z = p.z + dz * u;
      o.tx = dx / len;
      o.tz = dz / len;
    },
  };
}

/** Cubic Bézier from p to q through control points p1 and p2. */
function bend(p: Point, p1: Point, p2: Point, q: Point): Segment {
  const point = (u: number, o: Sample) => {
    const v = 1 - u;
    o.x = v * v * v * p.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u * u * u * q.x;
    o.z = v * v * v * p.z + 3 * v * v * u * p1.z + 3 * v * u * u * p2.z + u * u * u * q.z;
    const tx = 3 * v * v * (p1.x - p.x) + 6 * v * u * (p2.x - p1.x) + 3 * u * u * (q.x - p2.x);
    const tz = 3 * v * v * (p1.z - p.z) + 6 * v * u * (p2.z - p1.z) + 3 * u * u * (q.z - p2.z);
    const tl = Math.hypot(tx, tz) || 1;
    o.tx = tx / tl;
    o.tz = tz / tl;
  };
  // Arc-length table so the traveller keeps an even pace round the curve.
  const N = 16;
  const acc = [0];
  const o = { x: 0, z: 0, tx: 0, tz: 0 };
  let px = p.x, pz = p.z;
  for (let i = 1; i <= N; i++) {
    point(i / N, o);
    acc.push(acc[i - 1] + Math.hypot(o.x - px, o.z - pz));
    px = o.x;
    pz = o.z;
  }
  const len = acc[N] || 1e-6;
  return {
    len,
    at(s, out) {
      let i = 1;
      while (i < N && acc[i] < s) i++;
      const f = (s - acc[i - 1]) / Math.max(1e-6, acc[i] - acc[i - 1]);
      point((i - 1 + Math.min(1, Math.max(0, f))) / N, out);
    },
  };
}

// ------------------------------------------------------------------ travellers

/** Ease a heading toward a target, never turning faster than maxRate (radians per second). */
function turnToward(cur: number, target: number, dt: number, rate: number, maxRate: number) {
  const next = easeAngle(cur, target, follow(dt, rate));
  const d = Math.atan2(Math.sin(next - cur), Math.cos(next - cur));
  return cur + Math.max(-maxRate * dt, Math.min(maxRate * dt, d));
}

const SCALE = 2.1;
/**
 * How far a walker goes in half a stride (world units): what the legs' swing (LEG_SWING, about the
 * hip, a leg 0.034 long at SCALE) covers, so a planted foot stays put rather than sliding.
 */
const STRIDE = 0.026;
const LEG_SWING = 0.4;
/** The horse's half stride (its legs swing by their own angle, not LEG_SWING). */
const HORSE_STRIDE = 0.0192;
/** Height of a road's cobbles above the ground it is laid on (the piece sits 0.004 up). */
const ROAD_TOP = 0.03;
const ROAD_HALF_WIDTH = 0.05;
/** How far a building's footprint reaches from its vertex (half the diagonal, at board scale). */
const FOOTPRINT = { settlement: 0.15, city: 0.25 };

/** One part of a traveller (a torso, a leg, a wheel): where it is, and its instance in the batch. */
interface Part {
  obj: THREE.Object3D;
  id: number;
}

/** A road as drawn, for standing on it: its middle, direction, length and the height of its top. */
interface RoadTop {
  mx: number;
  mz: number;
  dx: number;
  dz: number;
  len: number;
  top: number;
}

/** Ground heights are sampled on a grid this fine (and blended between), then remembered. */
const GROUND_CELL = 0.02;

/**
 * A porter bringing in a harvest: a villager with a crate of it on their back, hurrying along
 * the owner's roads from the producing tile to the building, where they go in.
 */
interface Porter {
  root: THREE.Group;
  person: Person;
  parts: Part[];
  segs: Segment[];
  total: number;
  /** Seconds walked, out of `duration`, then a moment fading in at the door. */
  t: number;
  duration: number;
  heading: number;
  stride: number;
  y: number;
  /** Distance covered at the last frame, for the stride. */
  last: number;
}

/** Porters on the roads at once (a big harvest sends the nearest few). */
const MAX_PORTERS = 10;
/**
 * Instances the travellers' batch is made with: well over the most that ever walk at once (three
 * travellers a seat, people five parts and carts eleven, plus the porters, about 250). It mustn't
 * have to grow: under motion blur three keeps each batch's previous matrices in a texture sized
 * when it was first drawn, and a grown batch overflows it every frame (a RangeError).
 */
const BATCH_PARTS = 512;

interface Person {
  body: THREE.Object3D;
  legs: THREE.Object3D[];
  arms: THREE.Object3D[];
  /** The hand lantern, shown after dark. */
  lantern: THREE.Object3D;
}

interface Rig {
  horse: THREE.Group;
  head: THREE.Object3D;
  legs: THREE.Object3D[];
  cart: THREE.Group;
  wheels: THREE.Object3D[];
  /** Where the horse has been (newest last), so the cart can follow in its tracks. */
  trail: { x: number; z: number }[];
}

interface Traveller {
  owner: PlayerId;
  kind: 'walker' | 'cart';
  root: THREE.Group;
  person?: Person;
  rig?: Rig;
  edge: number;
  /** Travelling from edge.a to edge.b (true) or back. */
  forward: boolean;
  /** Keeps to this side of the road (+1 right, -1 left of the way it travels). */
  side: number;
  /** Distance from the road's centre line, how far short of a bare road end it turns, and
   * its own reach (half a body, or a horse's nose) to keep clear of buildings. */
  offset: number;
  margin: number;
  reach: number;
  seg: Segment;
  onRoad: boolean;
  /** Turn round at the end of this stretch (a dead end): slow down and stop first. */
  deadEnd: boolean;
  s: number;
  vel: number;
  speed: number;
  pause: number;
  /** Seconds left of a wave, and how far the arm is raised (eased). */
  wave: number;
  waveAmt: number;
  heading: number;
  look: number;
  stride: number;
  roll: number;
  phase: number;
  /** Eased heights of the traveller (and of its cart), so stepping on or off a road is smooth. */
  y: number;
  cartY: number;
  /** Its parts: placeholders posed like meshes, drawn by the shared batch. */
  parts: Part[];
  /** 1 while it stays; counts down to 0 as it leaves (its owner lost the roads it needs). */
  stay: number;
  leaving: boolean;
}

export class Travellers {
  group = new THREE.Group();
  private walkers: Traveller[] = [];
  private geos = new Map<string, THREE.BufferGeometry>();
  private p: Sample = { x: 0, z: 0, tx: 1, tz: 0 };
  /** Road count plus visible roads, so travellers re-sync only when the network changes. */
  private roadKey = -1;
  private roadTops: RoadTop[] = [];
  /** The same for the bridges, `top` the foot of the bridge (its deck humps up from there). */
  private bridgeTops: RoadTop[] = [];
  private groundCache = new Map<number, number>();
  /**
   * Every traveller's parts in one draw (and one per shadow pass), each part an instance posed
   * from its placeholder: people are five parts and a cart eleven, which as meshes of their
   * own made some 80 draws, each cast into the shadow maps again.
   */
  private batch: THREE.BatchedMesh | null = null;
  private geoIds = new Map<THREE.BufferGeometry, number>();
  private batchVertices = 0;
  private batchIndices = 0;
  private batchRoom = { vertices: 24000, indices: 72000 };
  /** Parts made for the traveller being built (see mesh). */
  private making: Part[] = [];
  private porters: Porter[] = [];
  private inverse = new THREE.Matrix4();
  private tmp = new THREE.Matrix4();
  /** Stopped where they stand (the island is going under). */
  stopped = false;

  constructor(
    private board: Board,
    private colors: PlayerColor[],
    private material: THREE.Material,
    private ground: (x: number, z: number) => number,
    private roads: Map<number, { owner: PlayerId; obj: THREE.Object3D }>,
    private buildings: Map<number, { owner: PlayerId; obj: THREE.Object3D; kind: string }>,
    /** Leaves a fading trail on the ground (see TrailMap). */
    private tread: (x: number, z: number, radius: number, amount: number) => void = () => {},
    private lamps: LampLights | null = null,
    /** The bridges standing and their seats (the expansions'): crossed as their roads are. */
    private bridges: () => Map<number, PlayerId> = () => new Map(),
    /** The bridges' scale on the board (see marks.ts). */
    private bridgeScale = 1,
  ) {}

  /** Keep-out radius round a vertex: its building's footprint, if one stands there. */
  private clearance(v: number) {
    const b = this.buildings.get(v);
    if (!b || !b.obj.visible) return 0;
    return b.kind === 'city' ? FOOTPRINT.city : FOOTPRINT.settlement;
  }

  /** How far from vertex v this traveller stops along a road (edge lengths are 1). */
  private stopAt(w: Traveller, v: number) {
    return Math.max(w.margin, this.clearance(v) + w.reach);
  }

  private geo(key: string, make: () => THREE.BufferGeometry) {
    let g = this.geos.get(key);
    if (!g) {
      g = make();
      this.geos.set(key, g);
    }
    return g;
  }

  /** A part drawn with `geo`: a placeholder to pose, and an instance of it in the batch. */
  private mesh(geo: THREE.BufferGeometry): THREE.Object3D {
    const obj = new THREE.Object3D();
    this.making.push({ obj, id: this.instanceOf(geo) });
    return obj;
  }

  /** The batch, grown when it must be to hold another geometry or instance. */
  private instanceOf(geo: THREE.BufferGeometry): number {
    // The piece material reads surface patterns; travellers are plain.
    if (!geo.getAttribute('surface')) geo.setAttribute('surface', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1));
    let batch = this.batch;
    if (!batch) {
      batch = this.batch = new THREE.BatchedMesh(BATCH_PARTS, this.batchRoom.vertices, this.batchRoom.indices, this.material);
      batch.castShadow = true;
      batch.receiveShadow = true;
      batch.frustumCulled = false;
      batch.perObjectFrustumCulled = false;
      batch.sortObjects = false;
      this.group.add(batch);
    }
    let gid = this.geoIds.get(geo);
    if (gid === undefined) {
      const v = geo.getAttribute('position').count, i = geo.getIndex()!.count;
      const room = this.batchRoom;
      if (this.batchVertices + v > room.vertices || this.batchIndices + i > room.indices) {
        room.vertices = Math.max(room.vertices * 2, this.batchVertices + v);
        room.indices = Math.max(room.indices * 2, this.batchIndices + i);
        batch.setGeometrySize(room.vertices, room.indices);
      }
      gid = batch.addGeometry(geo);
      this.batchVertices += v;
      this.batchIndices += i;
      this.geoIds.set(geo, gid);
    }
    // (Never reached in play: see BATCH_PARTS.)
    if (batch.instanceCount >= batch.maxInstanceCount) batch.setInstanceCount(batch.maxInstanceCount * 2);
    return batch.addInstance(gid);
  }

  /**
   * The batch made now, for the game-start precompile (see BoardView.standIns), with a speck of a
   * traveller in it: three builds a batch's shaders for that batch alone (its key is the batch's
   * own matrices), so a stand-in batch of its own would compile nothing the real one could use, and
   * the first traveller out on the roads would build them on sight, in four passes at once.
   * Returns the speck's removal.
   */
  standIn(): () => void {
    const id = this.instanceOf(this.geo('leg', makeLeg));
    this.batch!.setMatrixAt(id, new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4));
    return () => this.batch?.deleteInstance(id);
  }

  /** Pose every part's instance from its placeholder (hidden when it, or anything it hangs from, is). */
  private writeBatch() {
    const batch = this.batch;
    if (!batch) return;
    this.group.updateWorldMatrix(true, false);
    this.inverse.copy(this.group.matrixWorld).invert();
    // (The matrices go up only if one moved: a walker at rest, or one out of sight, doesn't.)
    const texture = (batch as unknown as { _matricesTexture: THREE.DataTexture })._matricesTexture;
    let moved = false;
    for (const w of this.walkers) moved = this.writeParts(batch, w, texture.image.data as Float32Array) || moved;
    for (const w of this.porters) moved = this.writeParts(batch, w, texture.image.data as Float32Array) || moved;
    if (moved) texture.needsUpdate = true;
  }

  private writeParts(batch: THREE.BatchedMesh, w: { root: THREE.Object3D; parts: Part[] }, matrices: Float32Array) {
    w.root.updateMatrixWorld(true);
    let moved = false;
    for (const p of w.parts) {
      let shown = true;
      for (let o: THREE.Object3D | null = p.obj; o && o !== this.group; o = o.parent) if (!o.visible) shown = false;
      batch.setVisibleAt(p.id, shown);
      if (shown && writeMatrix(matrices, p.id * 16, this.tmp.multiplyMatrices(this.inverse, p.obj.matrixWorld))) moved = true;
    }
    return moved;
  }

  private look(owner: PlayerId, n: number): Look {
    const pal = PLAYER_PALETTE[this.colors[owner]];
    const k = owner * 3 + n;
    return {
      tunic: n % 2 ? pal.dark : pal.base,
      trim: pal.trim,
      skin: SKIN[k % SKIN.length],
      hair: HAIR[(k * 7) % HAIR.length],
      hat: (['straw', 'hood', 'cap', 'none'] as const)[(k * 5 + 1) % 4],
      pack: n === 0,
    };
  }

  private makePerson(owner: PlayerId, n: number): { root: THREE.Group; person: Person } {
    const look = this.look(owner, n);
    const key = `${owner}-${n}`;
    const root = new THREE.Group();
    const body = new THREE.Group();
    body.rotation.order = 'YXZ';
    body.add(this.mesh(this.geo(`torso-${key}`, () => makeTorso(look))));
    const legGeo = this.geo('leg', makeLeg);
    const legs = [-1, 1].map((s) => {
      const leg = this.mesh(legGeo);
      leg.position.set(0, HIP, s * 0.0026);
      root.add(leg);
      return leg;
    });
    const arms = [-1, 1].map((s) => {
      const arm = this.mesh(this.geo(`arm-${key}-${s}`, () => makeArm(look, s > 0 && !look.pack)));
      arm.position.set(0, SHOULDER, s * 0.0052);
      arm.rotation.order = 'XYZ';
      body.add(arm);
      return arm;
    });
    // A lantern in the free hand, carried after dark (see sync and posePerson).
    const lantern = new THREE.Group();
    lantern.position.set(0, -0.0133, 0);
    lantern.visible = false;
    lantern.add(this.mesh(this.geo('handLantern', makeHandLantern)));
    const flame = this.mesh(this.geo('flame', makeLanternFlame));
    flame.position.y = HAND_FLAME;
    lantern.add(flame);
    arms[0].add(lantern);
    root.add(body);
    return { root, person: { body, legs, arms, lantern } };
  }

  private makeRig(owner: PlayerId): { root: THREE.Group; rig: Rig } {
    const pal = PLAYER_PALETTE[this.colors[owner]];
    const horseLook = HORSE_COATS[owner % HORSE_COATS.length];
    const load = (['wagon', 'hay', 'barrels'] as const)[owner % 3];
    const root = new THREE.Group();
    const horse = new THREE.Group();
    horse.add(this.mesh(this.geo(`horse-${owner}`, () => makeHorseBody(horseLook.coat, horseLook.mane, pal.base))));
    const head = this.mesh(this.geo(`horsehead-${owner}`, () => makeHorseHead(horseLook.coat, horseLook.mane)));
    head.position.set(0.0155, 0.031, 0);
    horse.add(head);
    const legGeo = this.geo(`horseleg-${owner}`, () => makeHorseLeg(horseLook.coat));
    const legs = HORSE_LEGS.map(([x, z]) => {
      const leg = this.mesh(legGeo);
      leg.position.set(x, HORSE_HIP, z);
      horse.add(leg);
      return leg;
    });
    const cart = new THREE.Group();
    cart.add(this.mesh(this.geo(`cart-${owner}`, () => makeCart(load, pal.base, pal.trim))));
    const wheelGeo = this.geo('wheel', makeWheel);
    const wheels = [-1, 1].map((s) => {
      const w = this.mesh(wheelGeo);
      w.position.set(0, WHEEL_R, s * 0.0118);
      cart.add(w);
      return w;
    });
    const driver = this.mesh(this.geo(`driver-${owner}`, () => makeTorso(this.look(owner, 2), true)));
    // Seated on the bench (the seated torso's skirt sits 0.004 above its origin), at a walker's
    // scale rather than the cart's larger one, so the driver is as big as the people on foot.
    driver.scale.setScalar(1 / CART_SCALE);
    driver.position.set(0.0135, WHEEL_R + 0.0146 - 0.004 * (1 / CART_SCALE - 1), 0);
    cart.add(driver);
    for (const m of [this.mesh(this.geo('lantern', makeLanternFrame)), this.mesh(this.geo('flame', makeLanternFlame))]) {
      m.position.set(0.0168, WHEEL_R + 0.006, -0.0095);
      cart.add(m);
    }
    // The lantern lights the road round the cart after dark.
    this.lamps?.add(cart, { x: 0.0168, y: WHEEL_R + 0.0233, z: -0.0095 }, { color: CART_LIGHT, distance: 0.28, strength: 0.22 });
    horse.scale.setScalar(SCALE * HORSE_SCALE);
    cart.scale.setScalar(SCALE * CART_SCALE);
    for (const g of [horse, cart]) {
      g.rotation.order = 'YXZ';
      root.add(g);
    }
    return { root, rig: { horse, head, legs, cart, wheels, trail: [] } };
  }

  private roadsOf(owner: PlayerId) {
    const out: number[] = [];
    for (const [e, r] of this.roads) if (r.owner === owner && r.obj.visible) out.push(e);
    return out;
  }

  /** Where `owner`'s travellers may go: their roads on show, and their bridges. */
  private waysOf(owner: PlayerId) {
    const out = this.roadsOf(owner);
    for (const [e, o] of this.bridges()) if (o === owner) out.push(e);
    return out;
  }

  private mine(edge: number, owner: PlayerId) {
    const r = this.roads.get(edge);
    return r ? r.owner === owner && r.obj.visible : this.bridges().get(edge) === owner;
  }

  /** The usable stretch of a road in the direction of travel, on the traveller's side. */
  private stretch(w: Traveller, edge: number, forward: boolean) {
    const e = this.board.edges[edge];
    // (Along the road as drawn: a coastal one lies a little inland of its edge; a bridge spans it.)
    const f = this.roads.has(edge) ? roadFrame(this.board, edge) : edgeFrame(this.board, edge);
    const a = forward ? { x: f.ax, z: f.az } : { x: f.bx, z: f.bz };
    const b = forward ? { x: f.bx, z: f.bz } : { x: f.ax, z: f.az };
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const tx = dx / len, tz = dz / len;
    const ox = -tz * w.offset * w.side, oz = tx * w.offset * w.side;
    const m0 = this.stopAt(w, forward ? e.a : e.b) / len, m1 = this.stopAt(w, forward ? e.b : e.a) / len;
    return {
      from: { x: a.x + dx * m0 + ox, z: a.z + dz * m0 + oz },
      to: { x: a.x + dx * (1 - m1) + ox, z: a.z + dz * (1 - m1) + oz },
      tx,
      tz,
      end: forward ? e.b : e.a,
    };
  }

  private enterRoad(w: Traveller, edge: number, forward: boolean) {
    w.edge = edge;
    w.forward = forward;
    const st = this.stretch(w, edge, forward);
    w.seg = line(st.from, st.to);
    w.onRoad = true;
    w.deadEnd = this.nextRoads(w).length === 0;
    w.s = 0;
  }

  private nextRoads(w: Traveller) {
    const at = this.stretch(w, w.edge, w.forward).end;
    // (Another seat's house on the corner breaks the way there.)
    const b = this.buildings.get(at);
    if (b && b.owner !== w.owner && b.obj.visible) return [];
    return this.waysOf(w.owner).filter((id) => id !== w.edge && (this.board.edges[id].a === at || this.board.edges[id].b === at));
  }

  /**
   * The light and the weather the travellers are out in (BoardView sets it each frame): after dark
   * a player's second walker goes home and the first carries a lantern; in heavy rain the people
   * on foot go in, leaving the roads to the carts (a player with no cart keeps one walker out).
   */
  ambient = { night: 0, rain: 0 };
  private dark = false;
  private wet = false;

  /** A walker per player with roads, a cart at five roads, a second walker at nine (fewer after dark and in heavy rain: see ambient). */
  private sync() {
    for (let owner = 0; owner < this.colors.length; owner++) {
      const mine = this.roadsOf(owner);
      let want: Traveller['kind'][] = mine.length === 0 ? [] : mine.length >= 9 ? ['walker', 'cart', 'walker'] : mine.length >= 5 ? ['walker', 'cart'] : ['walker'];
      if (this.dark && want.length === 3) want = ['walker', 'cart'];
      if (this.wet && want.includes('cart')) want = ['cart'];
      const have = this.walkers.filter((w) => w.owner === owner && !w.leaving);
      // Roads taken back, nightfall or rain: whoever isn't wanted heads off (the latest of each kind first).
      for (const kind of ['walker', 'cart'] as const) {
        const mineOf = have.filter((w) => w.kind === kind);
        const keep = want.filter((k) => k === kind).length;
        for (let i = mineOf.length - 1; i >= keep; i--) mineOf[i].leaving = true;
      }
      const missing: Traveller['kind'][] = [];
      for (const kind of ['walker', 'cart'] as const) {
        const n = want.filter((k) => k === kind).length - have.filter((w) => w.kind === kind).length;
        for (let i = 0; i < n; i++) missing.push(kind);
      }
      for (const kind of missing) {
        // (Walker 0 is the one with the pack, who stays out after dark; walker 1 the second.)
        const walkersNow = this.walkers.filter((w) => w.owner === owner && !w.leaving && w.kind === 'walker').length;
        this.making = [];
        const made = kind === 'cart' ? this.makeRig(owner) : this.makePerson(owner, walkersNow === 0 ? 0 : 1);
        if (kind === 'walker') made.root.scale.setScalar(SCALE);
        made.root.rotation.order = 'YXZ';
        this.group.add(made.root);
        const w: Traveller = {
          owner,
          kind,
          root: made.root,
          person: 'person' in made ? made.person : undefined,
          rig: 'rig' in made ? made.rig : undefined,
          edge: 0,
          forward: true,
          // (Everyone on foot keeps to the right, so walkers meeting pass each other; a cart
          // keeps to the crown, a little to one side.)
          side: kind === 'cart' ? (Math.random() < 0.5 ? 1 : -1) : 1,
          // On the cobbles: walkers in a lane either side, the cart down the middle (a little
          // off it, so a U-turn has room to swing round).
          offset: kind === 'cart' ? 0.006 : 0.021,
          // Walkers follow the road right out through its end (between the bollards) before
          // turning; a cart stops sooner so the horse's nose stays clear of the building.
          margin: kind === 'cart' ? 0.21 : 0.165,
          reach: kind === 'cart' ? 0.045 : 0.016,
          seg: line({ x: 0, z: 0 }, { x: 1, z: 0 }),
          onRoad: true,
          deadEnd: false,
          s: 0,
          vel: 0,
          speed: kind === 'cart' ? 0.05 + Math.random() * 0.01 : 0.042 + Math.random() * 0.018,
          pause: Math.random() * 1.5,
          wave: 0,
          waveAmt: 0,
          heading: 0,
          look: 0,
          stride: Math.random() * 6,
          roll: 0,
          phase: Math.random() * 6,
          y: NaN,
          cartY: NaN,
          stay: 1,
          leaving: false,
          parts: this.making,
        };
        this.making = [];
        this.enterRoad(w, mine[Math.floor(Math.random() * mine.length)], Math.random() < 0.5);
        w.s = Math.random() * w.seg.len;
        w.seg.at(w.s, this.p);
        w.heading = Math.atan2(this.p.tz, this.p.tx);
        if (w.rig) {
          // Lay the horse's track out straight behind it so the cart starts in line.
          for (let k = 12; k >= 0; k--) w.rig.trail.push({ x: this.p.x - this.p.tx * k * 0.012, z: this.p.z - this.p.tz * k * 0.012 });
        }
        this.walkers.push(w);
      }
    }
  }

  /** The ground's height at (x, z), from a grid of remembered samples (full ones cost a lot). */
  private groundAt(x: number, z: number) {
    const fx = x / GROUND_CELL, fz = z / GROUND_CELL;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const h = (a: number, b: number) => {
      const key = (a + 2048) * 4096 + (b + 2048);
      let y = this.groundCache.get(key);
      if (y === undefined) {
        if (this.groundCache.size > 30000) this.groundCache.clear();
        y = this.ground(a * GROUND_CELL, b * GROUND_CELL);
        this.groundCache.set(key, y);
      }
      return y;
    };
    return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
  }

  /** The roads on show, as drawn (rebuilt when the network changes). */
  private measureRoads() {
    this.roadTops = [];
    for (const [id, r] of this.roads) {
      if (!r.obj.visible) continue;
      const f = roadFrame(this.board, id);
      const dx = f.bx - f.ax, dz = f.bz - f.az;
      this.roadTops.push({ mx: f.x, mz: f.z, dx, dz, len: Math.hypot(dx, dz) || 1, top: this.ground(f.x, f.z) + ROAD_TOP });
    }
    // The bridges, standing on the higher of their banks as marks.ts puts them.
    this.bridgeTops = [];
    for (const id of this.bridges().keys()) {
      const f = edgeFrame(this.board, id);
      const dx = f.bx - f.ax, dz = f.bz - f.az;
      const base = Math.max(this.ground(f.ax * 0.7 + f.bx * 0.3, f.az * 0.7 + f.bz * 0.3), this.ground(f.ax * 0.3 + f.bx * 0.7, f.az * 0.3 + f.bz * 0.7));
      this.bridgeTops.push({ mx: f.x, mz: f.z, dx, dz, len: Math.hypot(dx, dz) || 1, top: base });
    }
  }

  /**
   * Send a porter along `path` (world points, from the producing tile's corner to the building)
   * with a crate in `color`, arriving after `duration` seconds.
   */
  deliver(owner: PlayerId, path: Point[], color: string, duration: number) {
    if (this.stopped || path.length < 2 || this.porters.length >= MAX_PORTERS) return;
    this.making = [];
    const made = this.makePerson(owner, 3);
    const crate = this.mesh(this.geo(`crate-${color}`, () => makeCrate(color)));
    // On the back, a little above the hips, leaning into the load.
    crate.position.set(-0.0062, 0.0245, 0);
    made.person.body.add(crate);
    made.root.scale.setScalar(SCALE);
    made.root.rotation.order = 'YXZ';
    this.group.add(made.root);
    const segs: Segment[] = [];
    for (let i = 1; i < path.length; i++) segs.push(line(path[i - 1], path[i]));
    const total = segs.reduce((n, s) => n + s.len, 0);
    segs[0].at(0, this.p);
    this.porters.push({ root: made.root, person: made.person, parts: this.making, segs, total, t: 0, duration: Math.max(0.4, duration), heading: Math.atan2(this.p.tz, this.p.tx), stride: Math.random() * 6, y: NaN, last: 0 });
    this.making = [];
  }

  /** Walk the porters on; one at its door goes in (shrinks away) and is gone. */
  private updatePorters(dt: number, t: number) {
    const p = this.p;
    for (const w of this.porters) {
      w.t += dt;
      const u = Math.min(1, w.t / w.duration);
      // Setting off and arriving gently, quickest in the middle.
      let s = (u * u * (3 - 2 * u)) * w.total;
      const step = s - w.last;
      w.last = s;
      let seg = 0;
      while (seg < w.segs.length - 1 && s > w.segs[seg].len) s -= w.segs[seg++].len;
      w.segs[seg].at(Math.min(s, w.segs[seg].len), p);
      w.heading = turnToward(w.heading, Math.atan2(p.tz, p.tx), dt, 12, 8);
      w.stride += (step / STRIDE) * Math.PI;
      const swing = Math.sin(w.stride);
      const gait = u < 1 ? 1 : 0;
      w.y = this.ease(w.y, this.heightAt(p.x, p.z), dt);
      w.root.position.set(p.x, w.y + Math.abs(Math.cos(w.stride)) * 0.0012 * SCALE * gait, p.z);
      w.root.rotation.y = -w.heading;
      const { body, legs, arms } = w.person;
      // Bent under the load, arms reaching back to steady it.
      body.rotation.z = -0.22 * gait;
      body.rotation.x = swing * 0.04 * gait;
      legs[0].rotation.z = swing * LEG_SWING * gait;
      legs[1].rotation.z = -swing * LEG_SWING * gait;
      for (const a of arms) a.rotation.z = 0.9 + Math.sin(t * 2 + w.stride * 0.1) * 0.05;
      // At the door: in they go.
      const gone = Math.max(0, (w.t - w.duration) / 0.3);
      w.root.scale.setScalar(SCALE * Math.max(0.001, 1 - gone));
    }
    const done = this.porters.filter((w) => w.t >= w.duration + 0.3);
    if (!done.length) return;
    for (const w of done) {
      w.root.removeFromParent();
      for (const part of w.parts) this.batch?.deleteInstance(part.id);
    }
    this.porters = this.porters.filter((w) => !done.includes(w));
  }

  /** Ground height, or the top of any road laid here (ramping down over its last few cm). */
  private heightAt(x: number, z: number) {
    // Over a bridge: on its deck, up over the arch and down again.
    const k = this.bridgeScale;
    for (const r of this.bridgeTops) {
      const along = ((x - r.mx) * r.dx + (z - r.mz) * r.dz) / r.len;
      const across = Math.abs(((x - r.mx) * -r.dz + (z - r.mz) * r.dx) / r.len);
      if (Math.abs(along) < (BRIDGE.L / 2) * k && across < (BRIDGE.W / 2) * k) return r.top + k * deckY(along / k);
    }
    // On a road's top (most of the time), the ground beneath doesn't matter.
    let flat = -Infinity;
    let any = false;
    for (const r of this.roadTops) {
      const along = Math.abs(((x - r.mx) * r.dx + (z - r.mz) * r.dz) / r.len);
      const across = Math.abs(((x - r.mx) * -r.dz + (z - r.mz) * r.dx) / r.len);
      if (along > ROAD_LENGTH / 2 || across > ROAD_HALF_WIDTH) continue;
      any = true;
      if (along < ROAD_LENGTH / 2 - 0.03 && across < ROAD_HALF_WIDTH - 0.006) flat = Math.max(flat, r.top);
    }
    if (flat > -Infinity) return flat;
    const ground = this.groundAt(x, z);
    if (!any) return ground;
    let best = ground;
    for (const r of this.roadTops) {
      const along = Math.abs(((x - r.mx) * r.dx + (z - r.mz) * r.dz) / r.len);
      const across = Math.abs(((x - r.mx) * -r.dz + (z - r.mz) * r.dx) / r.len);
      if (along > ROAD_LENGTH / 2 || across > ROAD_HALF_WIDTH) continue;
      const k = (1 - THREE.MathUtils.smoothstep(along, ROAD_LENGTH / 2 - 0.03, ROAD_LENGTH / 2)) * (1 - THREE.MathUtils.smoothstep(across, ROAD_HALF_WIDTH - 0.006, ROAD_HALF_WIDTH));
      best = Math.max(best, ground + (r.top - ground) * k);
    }
    return best;
  }

  private ease(cur: number, target: number, dt: number) {
    return Number.isNaN(cur) ? target : cur + (target - cur) * follow(dt, 14);
  }

  update(dt: number, t: number) {
    // Stopped, they stay where they are (and shrink with the island, as their placeholders do).
    if (this.stopped) {
      this.writeBatch();
      return;
    }
    let visible = 0, built = 0;
    for (const r of this.roads.values()) if (r.obj.visible) visible++;
    for (const b of this.buildings.values()) if (b.obj.visible) built += b.kind === 'city' ? 2 : 1;
    // (Nightfall and heavy rain send people in, and dawn and the sun out again: hysteresis, so a
    // night hovering at the threshold doesn't send them back and forth.)
    const dark = this.dark ? this.ambient.night > 0.45 : this.ambient.night > 0.62;
    const wet = this.wet ? this.ambient.rain > 0.35 : this.ambient.rain > 0.6;
    if (dark !== this.dark || wet !== this.wet) {
      this.dark = dark;
      this.wet = wet;
      this.roadKey = -1;
    }
    const key = ((this.roads.size * 1000 + visible) * 1000 + built) * 100 + this.bridges().size;
    if (key !== this.roadKey) {
      this.roadKey = key;
      this.measureRoads();
      this.sync();
      for (const w of this.walkers) {
        if (!w.onRoad) continue;
        // The network changed: a road ahead may have appeared (no longer a dead end), or a
        // building gone up at the end of this one, so re-aim from where the traveller stands.
        w.deadEnd = this.nextRoads(w).length === 0;
        w.seg.at(Math.min(w.s, w.seg.len), this.p);
        const st = this.stretch(w, w.edge, w.forward);
        if ((st.to.x - this.p.x) * st.tx + (st.to.z - this.p.z) * st.tz > 0.005) {
          w.seg = line({ x: this.p.x, z: this.p.z }, st.to);
          w.s = 0;
        }
      }
    }
    for (const w of this.walkers) {
      if (w.leaving) {
        // Fading away where it stands.
        w.stay = Math.max(0, w.stay - dt / 0.6);
        w.root.scale.setScalar((w.kind === 'walker' ? SCALE : 1) * Math.max(0.001, w.stay));
        continue;
      }
      if (!this.mine(w.edge, w.owner)) {
        const mine = this.roadsOf(w.owner);
        if (!mine.length) continue;
        this.enterRoad(w, mine[0], true);
      }
      const step = this.advance(w, dt);
      if (w.kind === 'cart') this.poseCart(w, step, dt, t);
      else this.posePerson(w, step, dt, t);
      if (w.person) w.person.lantern.visible = this.dark;
      // Feet, hooves and wheels wear the verges where they pass (the road itself hides it).
      if (step > 0 && w.rig) {
        this.tread(w.rig.horse.position.x, w.rig.horse.position.z, 0.025, step * 5);
        this.tread(w.rig.cart.position.x, w.rig.cart.position.z, 0.03, step * 5);
      } else if (step > 0) this.tread(w.root.position.x, w.root.position.z, 0.02, step * 5);
    }
    this.updatePorters(dt, t);
    if (this.walkers.some((w) => w.leaving && w.stay <= 0)) {
      for (const w of this.walkers) {
        if (!(w.leaving && w.stay <= 0)) continue;
        w.root.removeFromParent();
        for (const p of w.parts) this.batch?.deleteInstance(p.id);
      }
      this.walkers = this.walkers.filter((w) => !(w.leaving && w.stay <= 0));
    }
    this.writeBatch();
  }

  /** Move along the route; returns the distance covered this frame. */
  private advance(w: Traveller, dt: number) {
    const p = this.p;
    // Pace: ease up to speed, and slow to a halt before turning round at a dead end.
    let want = w.pause > 0 ? 0 : w.speed;
    // Slow while the body is still swinging round to the way the path now goes.
    w.seg.at(Math.min(w.s, w.seg.len), p);
    const err = Math.abs(Math.atan2(Math.sin(Math.atan2(p.tz, p.tx) - w.heading), Math.cos(Math.atan2(p.tz, p.tx) - w.heading)));
    want *= Math.pow(Math.max(0, Math.cos(err)), 0.7);
    if (w.onRoad && w.deadEnd) want *= Math.min(1, 0.2 + (w.seg.len - w.s) / 0.1);
    // Catching up with someone going the same way along the same road: fall in behind them.
    if (w.onRoad) {
      for (const o of this.walkers) {
        if (o === w || o.leaving || !o.onRoad || o.edge !== w.edge || o.forward !== w.forward || o.kind !== w.kind) continue;
        const gap = o.s - w.s;
        if (gap > 0 && gap < 0.07) want = Math.min(want, o.vel * Math.max(0, (gap - 0.03) / 0.04));
      }
    }
    w.vel += (want - w.vel) * follow(dt, want > w.vel ? 2.5 : 5);
    if (w.pause > 0) {
      w.pause -= dt;
      w.wave = Math.max(0, w.wave - dt);
    }
    // Only moves while roughly facing the way it goes (it turns on the spot first).
    const step = w.vel * dt * Math.max(0, Math.cos(err));
    w.s += step;
    if (w.s >= w.seg.len) {
      const over = w.s - w.seg.len;
      w.seg.at(w.seg.len, p);
      const from = { x: p.x, z: p.z }, dx = p.tx, dz = p.tz;
      if (w.onRoad) {
        // End of the road: curve on to a connecting road of ours, or turn round.
        const next = this.nextRoads(w);
        const at = this.stretch(w, w.edge, w.forward).end;
        let edge = w.edge, forward = !w.forward;
        if (next.length) {
          edge = next[Math.floor(Math.random() * next.length)];
          forward = this.board.edges[edge].a === at;
        } else {
          w.pause = 1.8 + Math.random() * 2.5;
          // Some walkers wave to the island while they stand there.
          if (w.kind === 'walker' && Math.random() < 0.45) w.wave = Math.min(w.pause, 1.6 + Math.random());
        }
        const st = this.stretch(w, edge, forward);
        const cart = w.kind === 'cart';
        const v = this.board.vertices[at];
        if (next.length) {
          // Round the corner on the open side, bowing away from the vertex so the curve
          // clears the settlement or city standing on it.
          let ux = from.x - v.x + st.from.x - v.x, uz = from.z - v.z + st.from.z - v.z;
          const ul = Math.hypot(ux, uz) || 1;
          ux /= ul;
          uz /= ul;
          // (The bow points 120° from the way it walks, so the lead must outweigh half of it
          // or the curve would start by stepping backwards.)
          // Size the bow so the curve's apex clears whatever stands on the vertex. With the
          // lead at 0.55 of the bow, the apex sits (4m + 4.35k) / 8 from the vertex.
          const m = Math.hypot(from.x - v.x, from.z - v.z);
          const keep = Math.max(this.clearance(at), 0.13) + w.reach;
          const k = Math.max(cart ? 0.2 : 0.12, (8 * keep - 4 * m) / 4.35), lead = 0.55 * k;
          w.seg = bend(
            from,
            { x: from.x + ux * k + dx * lead, z: from.z + uz * k + dz * lead },
            { x: st.from.x + ux * k - st.tx * lead, z: st.from.z + uz * k - st.tz * lead },
            st.from,
          );
        } else {
          // Turn round short of the end with a loop out to the side, as a cart would, rather
          // than pushing on toward whatever stands at the road's end.
          const nx = -dz * w.side, nz = dx * w.side;
          // A sidestep loop that hardly goes further forward, so it clears a building at the end.
          const wide = cart ? 0.13 : 0.06, ahead = cart ? 0.01 : 0.012;
          w.seg = bend(
            from,
            { x: from.x + dx * ahead + nx * wide, z: from.z + dz * ahead + nz * wide },
            { x: st.from.x + dx * ahead + nx * wide, z: st.from.z + dz * ahead + nz * wide },
            st.from,
          );
        }
        w.onRoad = false;
        w.edge = edge;
        w.forward = forward;
        w.s = w.pause > 0 ? 0 : over;
      } else {
        this.enterRoad(w, w.edge, w.forward);
        w.s = over;
      }
    }
    w.seg.at(w.s, p);
    return step;
  }

  private posePerson(w: Traveller, step: number, dt: number, t: number) {
    const p = this.p;
    const { body, legs, arms } = w.person!;
    const before = w.heading;
    w.heading = turnToward(w.heading, Math.atan2(p.tz, p.tx), dt, 9, 3);
    // Turning on the spot still takes steps.
    const turn = Math.abs(w.heading - before);
    const gait = Math.min(1, Math.max(w.vel / 0.03, turn / Math.max(dt, 1e-4) / 2.5));
    w.stride += (step / STRIDE) * Math.PI + turn * 1.6;
    const swing = Math.sin(w.stride);
    // Stood still, a walker looks about; walking, it faces the way it goes.
    const idle = 1 - gait;
    const lookAt = (Math.sin(t * 0.7 + w.phase) * 0.9 + Math.sin(t * 1.9 + w.phase * 2) * 0.25) * idle;
    w.look += (lookAt - w.look) * follow(dt, 3);
    const bob = Math.abs(Math.cos(w.stride)) * 0.0011 * gait;
    w.y = this.ease(w.y, this.heightAt(p.x, p.z), dt);
    w.root.position.set(p.x, w.y + bob * SCALE, p.z);
    w.root.rotation.y = -(w.heading + w.look * 0.5);
    body.rotation.y = -w.look * 0.35;
    body.rotation.z = -0.09 * gait + Math.sin(t * 1.3 + w.phase) * 0.015 * idle;
    body.rotation.x = swing * 0.045 * gait;
    legs[0].rotation.z = swing * LEG_SWING * gait;
    legs[1].rotation.z = -swing * LEG_SWING * gait;
    // Arms swing against the legs; a waving walker raises one and waves it.
    w.waveAmt += ((w.wave > 0.3 ? 1 : 0) - w.waveAmt) * follow(dt, 6);
    const waving = w.waveAmt;
    arms[0].rotation.z = -swing * 0.4 * gait;
    arms[0].rotation.x = 0.08;
    arms[1].rotation.z = swing * 0.4 * gait * (1 - waving) + waving * 0.2;
    arms[1].rotation.x = -0.08 - waving * (2.5 + Math.sin(t * 9) * 0.3);
  }

  private poseCart(w: Traveller, step: number, dt: number, t: number) {
    const p = this.p;
    const rig = w.rig!;
    const gait = Math.min(1, w.vel / 0.03);
    w.stride += (step / HORSE_STRIDE) * Math.PI;
    w.heading = turnToward(w.heading, Math.atan2(p.tz, p.tx), dt, 7, 1.8);
    w.y = this.ease(w.y, this.heightAt(p.x, p.z), dt);
    const gy = w.y;
    rig.horse.position.set(p.x, gy + Math.abs(Math.sin(w.stride)) * 0.0007 * SCALE * HORSE_SCALE * gait, p.z);
    rig.horse.rotation.y = -w.heading;
    // Four-beat walk: left hind, left fore, right hind, right fore.
    const beats = [0.25, 0.75, 0, 0.5];
    rig.legs.forEach((leg, i) => (leg.rotation.z = Math.sin(w.stride + beats[i] * Math.PI * 2) * 0.42 * gait));
    rig.head.rotation.z = Math.sin(w.stride * 2) * 0.07 * gait + (1 - gait) * (Math.sin(t * 0.6 + w.phase) * 0.12 - 0.15);
    // The cart follows the horse's own track, so it swings wide round corners like a real one.
    const last = rig.trail[rig.trail.length - 1];
    if (Math.hypot(p.x - last.x, p.z - last.z) > 0.004) rig.trail.push({ x: p.x, z: p.z });
    const reach = HITCH * SCALE;
    let acc = Math.hypot(p.x - rig.trail[rig.trail.length - 1].x, p.z - rig.trail[rig.trail.length - 1].z);
    let cx = rig.trail[0].x, cz = rig.trail[0].z;
    for (let i = rig.trail.length - 1; i > 0; i--) {
      const a = rig.trail[i], b = rig.trail[i - 1];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (acc + d >= reach) {
        const f = (reach - acc) / d;
        cx = a.x + (b.x - a.x) * f;
        cz = a.z + (b.z - a.z) * f;
        if (i > 4) rig.trail.splice(0, i - 4);
        break;
      }
      acc += d;
    }
    w.cartY = this.ease(w.cartY, this.heightAt(cx, cz), dt);
    rig.cart.position.set(cx, w.cartY, cz);
    rig.cart.rotation.y = -Math.atan2(p.z - cz, p.x - cx);
    w.roll += step / (WHEEL_R * SCALE * CART_SCALE);
    for (const wh of rig.wheels) wh.rotation.z = -w.roll;
  }

  dispose() {
    this.batch?.dispose();
    this.batch = null;
    for (const g of this.geos.values()) g.dispose();
    this.geos.clear();
    this.walkers = [];
    this.group.clear();
  }
}
