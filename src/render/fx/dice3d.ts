// 3D dice, thrown onto the sea. When someone rolls, the dice fly in from the viewer's side and
// plunge into the water beside the island (a crown of spray and a ring at each entry), bob back
// up and come to rest floating with the rolled faces up, their pips lit in the roller's colour,
// ride the swell for a moment and then sink. They are part of the scene: lit by the sun, the sky
// and the lamps, mirrored in the sea, and seen through the water below the waterline.
//
// The throw is simulated in full before it is shown: a small rigid-body solver with buoyancy and
// drag on each eighth of a die (so it plunges, bobs and rights itself as a floating block does)
// and corner-against-box contacts between the dice. Wherever a die comes to rest, its pips
// are then turned within the cube so the face that ends up on top is the rolled value: a cube
// looks the same from every face, so the turn can't be seen.

import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { select, smoothstep, texture, uniform, uv, vec4 } from 'three/tsl';
import type { TileEffects } from '../board/materials';
import { bumpedNormal, pooled } from '../board/materials';
import { SEA_LEVEL } from '../board/layout';
import { throwFaces, VALUE_EVENT, paintEvent, type EventDieResult } from './eventDie';

/** Faces in BoxGeometry order (+x, -x, +y, -y, +z, -z) and their values (opposites sum to 7). */
const FACES: { n: THREE.Vector3; v: number }[] = [
  { n: new THREE.Vector3(1, 0, 0), v: 3 },
  { n: new THREE.Vector3(-1, 0, 0), v: 4 },
  { n: new THREE.Vector3(0, 1, 0), v: 1 },
  { n: new THREE.Vector3(0, -1, 0), v: 6 },
  { n: new THREE.Vector3(0, 0, 1), v: 2 },
  { n: new THREE.Vector3(0, 0, -1), v: 5 },
];
const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.25], [0.73, 0.25], [0.27, 0.5], [0.73, 0.5], [0.27, 0.75], [0.73, 0.75]],
};

/** Simulation constants, in die sizes and seconds. */
const GRAVITY = 32;
const HALF = 0.47;
const STEP = 1 / 240;
/** The throw always lands within this many seconds (it is eased to rest at the end). */
export const THROW_TIME = 1.2;
const FPS = 60;

/** Each die's skin, by its index: its pips' colour and its kind. */
const SKINS = [
  ['#4a1e12', 'ivory'],
  ['#d23b2c', 'ivory'],
  ['#29485c', 'event'],
  ['#fff4dc', 'red'],
] as const;

/** A 3×2 atlas of the six faces: ivory with engraved pips (colour) and their depth (height). */
function faceAtlas(pip: string, kind: 'ivory' | 'red' | 'event' = 'ivory') {
  const S = 256;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = S * 3;
    c.height = S * 2;
    return c;
  };
  const col = make(), hgt = make();
  const cx = col.getContext('2d')!, hx = hgt.getContext('2d')!;
  hx.fillStyle = '#fff';
  hx.fillRect(0, 0, hgt.width, hgt.height);
  FACES.forEach((f, i) => {
    const ox = (i % 3) * S, oy = Math.floor(i / 3) * S;
    const g = cx.createRadialGradient(ox + S * 0.4, oy + S * 0.35, S * 0.05, ox + S / 2, oy + S / 2, S * 0.75);
    g.addColorStop(0, kind === 'red' ? '#c54a3c' : '#f4ecda');
    g.addColorStop(1, kind === 'red' ? '#84251f' : '#e2d1ad');
    cx.fillStyle = g;
    cx.fillRect(ox, oy, S, S);
    if (kind === 'event') {
      const face = VALUE_EVENT[f.v - 1];
      paintEvent(cx, face, ox + S * 0.16, oy + S * 0.13, S * 0.68);
      paintEvent(hx, face, ox + S * 0.16, oy + S * 0.13, S * 0.68, '#222');
      return;
    }
    for (const [px, py] of PIPS[f.v]) {
      const x = ox + px * S, y = oy + py * S, r = S * 0.085;
      const pg = cx.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.1, x, y, r);
      pg.addColorStop(0, pip);
      pg.addColorStop(1, kind === 'red' ? '#e6c99c' : '#1c0b06');
      cx.fillStyle = pg;
      cx.beginPath();
      cx.arc(x, y, r, 0, Math.PI * 2);
      cx.fill();
      // Height: a soft-edged hollow, so the pips look drilled into the face.
      const hg = hx.createRadialGradient(x, y, r * 0.55, x, y, r * 1.12);
      hg.addColorStop(0, '#000');
      hg.addColorStop(1, '#fff');
      hx.fillStyle = hg;
      hx.beginPath();
      hx.arc(x, y, r * 1.12, 0, Math.PI * 2);
      hx.fill();
    }
  });
  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { color: tex(col, true), height: tex(hgt, false) };
}

/** A rounded cube whose UVs address the atlas cell of whichever face each vertex lies on. */
function dieGeometry() {
  const g = new RoundedBoxGeometry(1, 1, 1, 4, 0.12);
  const pos = g.getAttribute('position'), uvs = g.getAttribute('uv');
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const ax = Math.abs(p.x), ay = Math.abs(p.y), az = Math.abs(p.z);
    let face: number, u: number, v: number;
    if (ax >= ay && ax >= az) [face, u, v] = p.x > 0 ? [0, -p.z, p.y] : [1, p.z, p.y];
    else if (ay >= az) [face, u, v] = p.y > 0 ? [2, p.x, -p.z] : [3, p.x, p.z];
    else [face, u, v] = p.z > 0 ? [4, p.x, p.y] : [5, -p.x, p.y];
    const cu = (face % 3) / 3, cv = Math.floor(face / 3) / 2;
    uvs.setXY(i, cu + (u + 0.5) / 3, 1 - (cv + (0.5 - v) / 2));
  }
  return g;
}

interface Body {
  x: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
}

const _l = new THREE.Vector3(), _n = new THREE.Vector3(), _pa = new THREE.Vector3(), _ra = new THREE.Vector3(), _rb = new THREE.Vector3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _cr = new THREE.Vector3(), _iq = new THREE.Quaternion();

/**
 * Corners of die `a` that have gone inside die `b` are pushed back out through b's nearest face,
 * with a bounce. (Unit mass; a cube's inertia is isotropic, I = 1/6, so its inverse is 6.)
 */
function cubeContact(a: Body, b: Body) {
  _iq.copy(b.q).invert();
  for (const c of CORNERS) {
    _pa.copy(c).applyQuaternion(a.q).add(a.x);
    _l.copy(_pa).sub(b.x).applyQuaternion(_iq);
    const dx = HALF - Math.abs(_l.x), dy = HALF - Math.abs(_l.y), dz = HALF - Math.abs(_l.z);
    if (dx <= 0 || dy <= 0 || dz <= 0) continue;
    let depth = dx;
    _n.set(Math.sign(_l.x), 0, 0);
    if (dy < depth) (depth = dy), _n.set(0, Math.sign(_l.y), 0);
    if (dz < depth) (depth = dz), _n.set(0, 0, Math.sign(_l.z));
    _n.applyQuaternion(b.q);
    a.x.addScaledVector(_n, depth * 0.5);
    b.x.addScaledVector(_n, -depth * 0.5);
    _ra.subVectors(_pa, a.x);
    _rb.subVectors(_pa, b.x);
    _va.copy(a.w).cross(_ra).add(a.v);
    _vb.copy(b.w).cross(_rb).add(b.v);
    const vn = _va.sub(_vb).dot(_n);
    if (vn >= 0) continue;
    const ka = _cr.copy(_ra).cross(_n).lengthSq();
    const kb = _cr.copy(_rb).cross(_n).lengthSq();
    const j = (-(1 + 0.35) * vn) / (2 + 6 * ka + 6 * kb);
    a.v.addScaledVector(_n, j);
    b.v.addScaledVector(_n, -j);
    a.w.add(_cr.copy(_ra).cross(_n).multiplyScalar(6 * j));
    b.w.add(_cr.copy(_rb).cross(_n).multiplyScalar(-6 * j));
  }
}

const CORNERS = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new THREE.Vector3(x, y, z).multiplyScalar(HALF))));

/** The face (index into FACES) pointing up for orientation q. */
function upFace(q: THREE.Quaternion) {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q.clone().invert());
  let best = 0;
  FACES.forEach((f, i) => {
    if (f.n.dot(up) > FACES[best].n.dot(up)) best = i;
  });
  return best;
}

/** Turn the painted faces inside the cube so its final upward face carries `value`. */
export function landingTurn(landed: THREE.Quaternion, value: number) {
  return new THREE.Quaternion().setFromUnitVectors(FACES.find((f) => f.v === value)!.n, FACES[upFace(landed)].n);
}

/** Die size in world units (a hex's circumradius is 1). */
export const DIE = 0.55;
/**
 * A die is a little under half as dense as water, so it floats with its centre this far above
 * the surface (in die sizes): 0.5 - DENSITY.
 */
const DENSITY = 0.44;
const FLOAT_Y = 0.5 - DENSITY;
/** Water drag on a submerged die (per unit speed), on its spin, and the pull that turns its nearest face up. */
const WATER_DRAG = 6;
/** Drag that grows with speed (the water resists a hard entry far more than a gentle bob). */
const WATER_DRAG2 = 2.2;
const WATER_SPIN_DRAG = 6;
const RIGHTING = 40;
/** Seconds afloat (at normal speed) before the dice sink, and how long they take to go under. */
const HOLD = 2.6;
const SINK = 1.1;
const UP = new THREE.Vector3(0, 1, 0);
/** The centres of a die's eight eighths, each carrying its share of buoyancy and drag. */
const EIGHTHS = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new THREE.Vector3(x, y, z).multiplyScalar(0.25))));

interface Splash {
  frame: number;
  x: number;
  z: number;
  /** How hard it struck the water (die sizes per second). */
  speed: number;
  /** Its horizontal motion as it went in. */
  vx: number;
  vz: number;
}

const _r8 = new THREE.Vector3(), _v8 = new THREE.Vector3(), _f8 = new THREE.Vector3(), _force = new THREE.Vector3(), _torque = new THREE.Vector3(), _nUp = new THREE.Vector3();

/**
 * Simulate a throw of two, three or four dice into water. `dir` points (in throw x/z) towards where they come
 * from. Returns per-frame positions and orientations (in die sizes, the water at y = 0, centred
 * on where the dice come to rest), the splashes, and the path they take (to keep it clear).
 */
export function simulate(dir: THREE.Vector2, count: 2 | 3 | 4 = 2, random = Math.random) {
  const side = new THREE.Vector2(-dir.y, dir.x);
  const bodies: Body[] = Array.from({ length: count }, (_, i) => {
    const off = (i - (count - 1) / 2) * 1.5;
    const x = new THREE.Vector3(dir.x * 6.5 + side.x * off, 2.6 + i * 0.4, dir.y * 6.5 + side.y * off);
    const speed = 7 + random() * 1.5;
    const jitter = (random() - 0.5) * 1.5;
    const v = new THREE.Vector3(-dir.x * speed + side.x * jitter, 2.5 + random(), -dir.y * speed + side.y * jitter);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 6.28, random() * 6.28, random() * 6.28));
    const w = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize().multiplyScalar(14 + random() * 10);
    return { x, v, q, w };
  });
  const frames: { x: THREE.Vector3; q: THREE.Quaternion }[][] = Array.from({ length: count }, () => []);
  const splashes: Splash[] = [];
  const lastSplash = Array(count).fill(-99);
  const wet = Array(count).fill(false);
  const total = Math.round(THROW_TIME * FPS);
  const sub = Math.round(1 / FPS / STEP);
  const dq = new THREE.Quaternion();
  const buoyancy = GRAVITY / DENSITY / 8;
  for (let f = 0; f <= total; f++) {
    for (let s = 0; s < sub; s++) {
      bodies.forEach((b, i) => {
        b.v.y -= GRAVITY * STEP;
        b.v.multiplyScalar(Math.exp(-0.15 * STEP));
        // Water: each eighth under the surface is buoyed up and dragged at its own point, so the
        // die is pushed, slowed and turned as a floating block is.
        _force.set(0, 0, 0);
        _torque.set(0, 0, 0);
        let under = 0;
        for (const e of EIGHTHS) {
          _r8.copy(e).applyQuaternion(b.q);
          const depth = -(b.x.y + _r8.y);
          const k = Math.min(1, Math.max(0, (depth + 0.25) / 0.5));
          if (k <= 0) continue;
          under += k / 8;
          _v8.copy(b.w).cross(_r8).add(b.v);
          _f8.copy(_v8).multiplyScalar((-(WATER_DRAG + WATER_DRAG2 * _v8.length()) / 8) * k);
          _f8.y += buoyancy * k;
          _force.add(_f8);
          _torque.add(_r8.cross(_f8));
        }
        b.v.addScaledVector(_force, STEP);
        b.w.addScaledVector(_torque, 6 * STEP);
        if (under > 0) {
          b.w.multiplyScalar(Math.exp(-WATER_SPIN_DRAG * under * STEP));
          // Afloat it settles with a face up (the face nearest to up), as the game needs to read it.
          _nUp.copy(FACES[upFace(b.q)].n).applyQuaternion(b.q);
          b.w.addScaledVector(_nUp.cross(UP), RIGHTING * under * STEP);
        }
        // Splashes: going into the water, and again if it bobs clear and drops back.
        const isWet = under > 0.02;
        if (isWet && !wet[i] && f - lastSplash[i] > 6) {
          const speed = Math.max(0, -b.v.y) + 0.3 * Math.hypot(b.v.x, b.v.z);
          if (speed > 1.2) {
            splashes.push({ frame: f, x: b.x.x, z: b.x.z, speed, vx: b.v.x, vz: b.v.z });
            lastSplash[i] = f;
          }
        }
        wet[i] = isWet;
        b.x.addScaledVector(b.v, STEP);
        dq.set(b.w.x * STEP * 0.5, b.w.y * STEP * 0.5, b.w.z * STEP * 0.5, 0).multiply(b.q);
        b.q.set(b.q.x + dq.x, b.q.y + dq.y, b.q.z + dq.z, b.q.w + dq.w).normalize();
      });
      // The dice knock each other apart: corners against faces, both ways.
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
        const a = bodies[i], b = bodies[j];
        if (a.x.distanceToSquared(b.x) < 3) {
          cubeContact(a, b);
          cubeContact(b, a);
        }
      }
    }
    bodies.forEach((b, i) => frames[i].push({ x: b.x.clone(), q: b.q.clone() }));
  }
  // Ease the last stretch to rest: flat on the face nearest to up, floating at its waterline.
  const settle = Math.round(0.35 * FPS);
  // Flat cubes can be wider than the tilted bodies the solver ended on. Leave their half-
  // diagonals clear before easing the extra bodies flat; the classic two-die throw stays unchanged.
  const rests = frames.map((fr) => fr[fr.length - 1].x.clone().setY(FLOAT_Y));
  for (let pass = 0; count >= 3 && pass < 12; pass++) for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
    const delta = rests[j].clone().sub(rests[i]).setY(0);
    const distance = delta.length();
    if (distance >= 1.46) continue;
    if (distance < 1e-6) delta.set(side.x, 0, side.y);
    else delta.divideScalar(distance);
    rests[i].addScaledVector(delta, -(1.46 - distance) / 2);
    rests[j].addScaledVector(delta, (1.46 - distance) / 2);
  }
  for (const [i, fr] of frames.entries()) {
    const last = fr[fr.length - 1];
    const worldN = FACES[upFace(last.q)].n.clone().applyQuaternion(last.q);
    const restQ = new THREE.Quaternion().setFromUnitVectors(worldN, UP).multiply(last.q);
    const restX = rests[i];
    for (let k = 0; k < settle; k++) {
      const f = fr[fr.length - settle + k];
      const t = (k + 1) / settle;
      const s = t * t * (3 - 2 * t);
      f.q.slerp(restQ, s);
      f.x.lerp(restX, s);
    }
  }
  // Centre the throw on where the dice come to rest.
  const end = rests.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(count);
  for (const fr of frames) for (const f of fr) f.x.x -= end.x, (f.x.z -= end.z);
  for (const s of splashes) s.x -= end.x, (s.z -= end.z);
  // The whole flight (die sizes), to keep it clear of land, piers and the camera.
  const path: [number, number, number][] = [];
  for (const fr of frames) for (let i = 0; i < fr.length; i += 2) path.push([fr[i].x.x, fr[i].x.y, fr[i].x.z]);
  return { frames, splashes, path };
}

type DicePlan = ReturnType<typeof simulate>;

/** What the dice set off in the world around them (see World). */
interface DiceFx {
  /** A die strikes the water (strength 0..1), going on in direction (dx, dz) (length up to 1). */
  splash(x: number, z: number, strength: number, dx: number, dz: number): void;
  /** A ring spreading on the water around a floating die. */
  ripple(x: number, z: number, size: number, life: number): void;
  /** All have come to rest, showing the roll. */
  settled(points: THREE.Vector3[]): void;
}

/** Where a throw comes to rest, and which way is away from the viewer (it is thrown in from the other way). */
export interface DiceSpot {
  at: THREE.Vector3;
  away: THREE.Vector3;
}

const _p = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _qr = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4();
const smooth = (t: number) => t * t * (3 - 2 * t);

export class Dice3D {
  group = new THREE.Group();
  fx: DiceFx | null = null;
  private dice: { body: THREE.Group; pips: THREE.Mesh; phase: number; lap: number }[] = [];
  /** How brightly the pips glow, and in what colour (the roller's). */
  private glow = uniform(0);
  private glowColor = uniform(new THREE.Color());
  private disposables: { dispose(): void }[] = [];
  private frames: { x: THREE.Vector3; q: THREE.Quaternion }[][] | null = null;
  private splashes: Splash[] = [];
  private nextSplash = 0;
  private settled = false;
  private sinking = false;
  /** Seconds afloat when they start to sink. */
  private sinkFrom = HOLD;
  private t = 0;
  private speed = 1;
  /** The throw's frame in the world: its origin on the water, and its x (right) and z (towards the viewer). */
  private origin = new THREE.Vector3();
  private right = new THREE.Vector3();
  private back = new THREE.Vector3();
  private basis = new THREE.Quaternion();
  active = false;

  /** The dice's one material (see the constructor). */
  private material: THREE.Material;
  private geo: THREE.BufferGeometry;

  constructor(effects: TileEffects) {
    const night = effects.night;
    this.geo = dieGeometry();
    this.disposables.push(this.geo);
    // One material for every die and every skin, so the dice are one shader and one node build in
    // each pass (plain Meshes sharing a material and a geometry share their builds), where a
    // material per skin would be a shader variant each, built for the scene, the AO prepass, the
    // mirror and the shadow. Each die's skin is an object-scoped uniform (see addDie). Every skin's
    // texture is read and the die's own chosen per pixel: the reads stay out of branches, as
    // WGSL needs for their derivatives, and a die is a few hundred pixels, so they cost nothing.
    const skin = uniform(0).onObjectUpdate(({ object }) => (object?.userData.skin as number | undefined) ?? 0);
    const skins = SKINS.map(([pip, kind]) => faceAtlas(pip, kind));
    const at = uv();
    const color = skins.map((k) => texture(k.color, at).rgb);
    const albedo = select(skin.equal(0), color[0], select(skin.equal(1), color[1], select(skin.equal(2), color[2], color[3])));
    const event = skin.equal(2);
    // (The red skin's pips are drilled as the ivory ones are: one height for them, one for the event's faces.)
    const depth = select(event, texture(skins[2].height, at).r, texture(skins[0].height, at).r);
    const m = pooled(effects, 'dice', () => new THREE.MeshPhysicalNodeMaterial({ roughness: 0.3, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.12 }));
    m.colorNode = vec4(albedo, 1);
    m.normalNode = bumpedNormal(depth, 0.035);
    // The pips light up as the dice come to rest; at night the dice keep a faint glow of their
    // own so they still read. The event keeps its track ink through the flare.
    const inkGlow = select(event, albedo.mul(0.55), this.glowColor);
    m.emissiveNode = inkGlow.mul(smoothstep(0.75, 0.2, depth).mul(this.glow)).add(albedo.mul(night.mul(0.16)));
    skins.forEach((k, i) => {
      this.disposables.push(k.color);
      if (i === 0 || i === 2) this.disposables.push(k.height);
      else k.height.dispose();
    });
    this.disposables.push(m);
    this.material = m;
    // The plain pair. The event die and the red die join only for the rules that throw them (see
    // prepare): a base game shows only these two.
    this.addDie(0);
    this.addDie(1);
    this.group.visible = false;
  }

  /**
   * Ready the dice a ruleset throws beyond the plain pair: the event die and the red die, which
   * stands in for the first ivory die when it is one of the production pair and is thrown as a
   * fourth when a card sets the number. Called as the board is set; they stay for the session
   * once made.
   */
  prepare(eventDie: boolean) {
    // (They share the dice's material, so they add no shaders: only meshes.)
    if (!eventDie || this.dice.length > 2) return;
    this.addDie(2);
    this.addDie(3);
  }

  /** Die `i`, in skin `i` (see SKINS). */
  private addDie(i: number) {
    const body = new THREE.Group();
    const pips = new THREE.Mesh(this.geo, this.material);
    pips.userData.skin = i;
    pips.castShadow = true;
    body.add(pips);
    body.scale.setScalar(DIE);
    this.group.add(body);
    this.dice.push({ body, pips, phase: Math.random() * 6, lap: 0 });
  }

  /** Work out a throw (in its own frame: x right, z towards the viewer, in die sizes). */
  plan(event?: EventDieResult): DicePlan {
    // In from the viewer's side, angled a little across.
    return simulate(new THREE.Vector2(-0.3, 1).normalize(), event ? event.independentRed ? 4 : 3 : 2);
  }

  /** Make the throw `plan` to come to rest at `spot`, showing `values`, their pips lit in `color`. */
  throw(values: [number, number], plan: DicePlan, spot: DiceSpot, color: string, speed: number, instant = false, event?: EventDieResult) {
    this.back.copy(spot.away).setY(0).normalize().negate();
    this.right.set(this.back.z, 0, -this.back.x);
    this.basis.setFromRotationMatrix(_m.makeBasis(this.right, UP, this.back));
    this.origin.set(spot.at.x, SEA_LEVEL, spot.at.z);
    this.frames = plan.frames;
    // A red die that is one of the production pair is the first die, in red.
    this.dice[0].pips.userData.skin = event && !event.independentRed ? 3 : 0;
    this.splashes = plan.splashes;
    this.nextSplash = instant ? this.splashes.length : 0;
    this.speed = Math.max(0.25, speed);
    this.t = instant ? THROW_TIME : 0;
    this.settled = this.sinking = false;
    this.sinkFrom = HOLD;
    this.glowColor.value.set(color);
    this.glow.value = 0;
    this.active = true;
    this.group.visible = true;
    const faces = throwFaces(values, event);
    this.dice.forEach((die, i) => {
      // Turn the pips within the cube so the face that lands on top shows the rolled value.
      die.body.visible = i < plan.frames.length;
      if (!die.body.visible) return;
      const fr = this.frames![i];
      const value = faces[i];
      die.pips.quaternion.copy(landingTurn(fr[fr.length - 1].q, value));
      die.lap = 0.4 + i * 0.5;
    });
  }

  /** A point in the throw's frame (die sizes) in the world. */
  private toWorld(p: THREE.Vector3) {
    return _w.copy(this.origin).addScaledVector(this.right, p.x * DIE).addScaledVector(this.back, p.z * DIE).setY(SEA_LEVEL + p.y * DIE);
  }

  /** `camera`: floating dice it comes too close to go under early (rather than fill the view). */
  update(dt: number, camera?: THREE.Camera) {
    if (!this.active || !this.frames) return;
    this.t += dt * this.speed;
    const f = this.t * FPS;
    while (this.nextSplash < this.splashes.length && this.splashes[this.nextSplash].frame <= f) {
      const s = this.splashes[this.nextSplash++];
      const p = this.toWorld(_p.set(s.x, 0, s.z));
      // Its horizontal motion, turned into the world (to throw the spray on ahead of it).
      const h = Math.hypot(s.vx, s.vz);
      const g = h > 1e-3 ? Math.min(1, h / 8) / h : 0;
      const dx = (this.right.x * s.vx + this.back.x * s.vz) * g;
      const dz = (this.right.z * s.vx + this.back.z * s.vz) * g;
      this.fx?.splash(p.x, p.z, Math.min(1, Math.max(0.1, (s.speed - 1.5) / 12)), dx, dz);
    }
    const last = this.frames[0].length - 1;
    const fi = Math.min(last, f);
    const i0 = Math.floor(fi), i1 = Math.min(i0 + 1, last), k = fi - i0;
    const afloat = Math.max(0, this.t - THROW_TIME);
    // Afloat, they ride the swell (eased in), then go under.
    const calm = smooth(Math.min(1, afloat / 0.8));
    if (afloat > 0 && camera && !this.sinking) {
      for (const d of this.dice) if (d.body.visible && camera.position.distanceTo(d.body.position) < 1.5) this.sinkFrom = Math.min(this.sinkFrom, afloat);
    }
    const sink = Math.min(1, Math.max(0, afloat - this.sinkFrom) / SINK);
    if (sink > 0 && !this.sinking) {
      this.sinking = true;
      for (const d of this.dice) if (d.body.visible) this.fx?.ripple(d.body.position.x, d.body.position.z, 0.5, 1.6);
    }
    this.dice.forEach((die, i) => {
      if (!die.body.visible) return;
      const a = this.frames![i][i0], b = this.frames![i][i1];
      _p.lerpVectors(a.x, b.x, k);
      _q.slerpQuaternions(a.q, b.q, k);
      const t = this.t, ph = die.phase;
      _p.y += calm * 0.05 * Math.sin(t * 2.2 + ph) - sink * sink * 1.7;
      _e.set(calm * 0.07 * Math.sin(t * 1.6 + ph) + sink * 0.45, 0, calm * 0.06 * Math.sin(t * 1.25 + ph * 1.7));
      _q.premultiply(_qr.setFromEuler(_e));
      die.body.position.copy(this.toWorld(_p));
      die.body.quaternion.copy(this.basis).multiply(_q);
      // Rings spread from it as it bobs.
      if (afloat > 0 && !this.sinking) {
        die.lap -= dt * this.speed;
        if (die.lap <= 0) {
          die.lap = 1.1 + Math.random() * 0.5;
          this.fx?.ripple(die.body.position.x, die.body.position.z, 0.34, 1.8);
        }
      }
    });
    if (!this.settled && this.t >= THROW_TIME) {
      this.settled = true;
      this.fx?.settled(this.dice.filter((d) => d.body.visible).map((d) => d.body.position.clone()));
    }
    // The pips flare as the dice settle, then glow softly until they go under.
    this.glow.value = this.settled ? (0.3 + 1.6 * Math.exp(-afloat * 2.2)) * (1 - sink) : 0;
    if (sink >= 1) {
      this.active = false;
      this.group.visible = false;
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
