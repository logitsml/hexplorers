// Ambient wildlife: seagulls (flap / glide / bank), fish schools in the shallows
// that occasionally leap out with a splash and ripple rings, and butterflies
// fluttering over meadows and fields.

import * as THREE from 'three/webgpu';
import { keepNormals } from '../util/mrt';
import { Fn, attribute, positionLocal, positionGeometry, positionWorld, sin, abs, atan, float, vec3, vec4, time, mix, smoothstep, uniform } from 'three/tsl';
import type { Board } from '../../engine';
import { lookOf } from '../board/looks';
import { easeAngle, follow } from '../util/angle';
import { DETAIL_LAYER, SEA_LEVEL, type SdfField } from '../board/layout';
import { MeshBuilder, compose, smoothSphere } from '../board/geom';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ParticleSystem } from '../fx/particles';
import { instancedMesh } from '../board/instancing';

const C = (h: string) => new THREE.Color(h);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// ------------------------------------------------------------------ gulls

function makeGull(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const white = C('#f6f4ef');
  const grey = C('#b9bec6');
  const body = smoothSphere(0.013, 2);
  body.scale(2.6, 0.9, 0.95);
  b.addGeometry(body, compose(0, 0, 0), white);
  body.dispose();
  const head = smoothSphere(0.009, 2);
  b.addGeometry(head, compose(0.03, 0.006, 0), white);
  head.dispose();
  const beak = new THREE.ConeGeometry(0.0028, 0.012, 5);
  b.addGeometry(beak, compose(0.043, 0.004, 0, 0, 0, -Math.PI / 2), C('#f2b13a'));
  beak.dispose();
  const tail = new THREE.ConeGeometry(0.01, 0.022, 4);
  tail.scale(1, 1, 0.3);
  b.addGeometry(tail, compose(-0.038, 0.002, 0, 0, 0, Math.PI / 2), white);
  tail.dispose();
  // Wings: tapered quads along ±z (span axis), grey tops with dark tips.
  for (const side of [-1, 1]) {
    const segs = 4;
    const rows: number[][] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = side * (0.008 + t * 0.075);
      const chord = 0.03 * (1 - t * 0.65);
      const sweep = -t * t * 0.02;
      const col = t > 0.78 ? C('#2b2b2e') : grey.clone().lerp(white, 0.3 - t * 0.3);
      rows.push([b.vertex(0.012 + sweep, 0.004, z, col), b.vertex(0.012 + sweep - chord, 0.004, z, col)]);
    }
    for (let i = 0; i < segs; i++) {
      const [a0, a1] = rows[i];
      const [b0, b1] = rows[i + 1];
      // One face per wing (the material is double-sided; a second, coincident face z-fights).
      if (side > 0) b.quad(a0, b0, b1, a1);
      else b.quad(a0, a1, b1, b0);
    }
  }
  return b.build(true);
}

interface Gull {
  cx: number;
  cz: number;
  r: number;
  h: number;
  speed: number;
  angle: number;
  phase: number;
  glide: number;
  /** Wingbeat phase and strength (eased, so a gull settles into a glide instead of freezing). */
  beat: number;
  amp: number;
}

// ------------------------------------------------------------------- fish

interface FishLook {
  back: string;
  flank: string;
  belly: string;
  fin: string;
  /** Dark vertical bars across the back (mackerel / perch style). */
  bars: number;
}

/**
 * A fusiform fish: elliptical cross-sections along a streamlined profile with a narrow
 * tail stalk, countershaded colouring (dark back, metallic flank, pale belly), a forked
 * tail, dorsal, anal and pectoral fins, and eyes. About 0.06 long, nose towards +x.
 */
function makeFish(look: FishLook): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const back = C(look.back), flank = C(look.flank), belly = C(look.belly), fin = C(look.fin);
  const L = 0.06, H = 0.0105, W = 0.0062;
  const RINGS = 14, SEG = 12;
  const c = new THREE.Color();
  for (let i = 0; i <= RINGS; i++) {
    const u = i / RINGS; // 0 tail stalk .. 1 nose
    const x = -L * 0.38 + u * L * 0.86;
    const env = Math.pow(Math.sin(Math.PI * Math.pow(Math.min(0.999, u * 0.97 + 0.015), 0.62)), 0.85);
    const h = H * Math.max(0.13, env), w = W * Math.max(0.16, env);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const cy = Math.cos(a), cz = Math.sin(a);
      // Slightly flatter belly, rounder back.
      const y = cy * h * (cy > 0 ? 1 : 0.88);
      pos.push(x, y, cz * w);
      const top = THREE.MathUtils.smoothstep(cy, -0.1, 0.55);
      c.copy(belly).lerp(flank, THREE.MathUtils.smoothstep(cy, -0.75, -0.05)).lerp(back, top);
      if (look.bars && cy > 0.15 && Math.sin(u * Math.PI * look.bars * 2 + cy * 1.5) > 0.55) c.lerp(back, 0.0).multiplyScalar(0.62);
      // Thin pale lateral line.
      if (Math.abs(cy - 0.08) < 0.07 && u > 0.12 && u < 0.85) c.lerp(belly, 0.35);
      // Darker snout and gill cover line.
      if (u > 0.9) c.multiplyScalar(0.85);
      if (Math.abs(u - 0.76) < 0.018) c.multiplyScalar(0.8);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a0 = i * SEG + j, a1 = i * SEG + ((j + 1) % SEG);
      const b0 = a0 + SEG, b1 = a1 + SEG;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const cap = (ring: number, tipX: number, inward: boolean) => {
    const tip = pos.length / 3;
    pos.push(tipX, 0, 0);
    const k = ring * SEG;
    col.push(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]);
    for (let j = 0; j < SEG; j++) {
      const a = k + j, b2 = k + ((j + 1) % SEG);
      if (inward) idx.push(a, b2, tip);
      else idx.push(b2, a, tip);
    }
  };
  cap(RINGS, L * 0.5, true);
  cap(0, -L * 0.385, false);

  const tri = (pts: number[][], cc: THREE.Color, shade = 1) => {
    const base = pos.length / 3;
    for (const p of pts) {
      pos.push(p[0], p[1], p[2]);
      col.push(cc.r * shade, cc.g * shade, cc.b * shade);
    }
    for (let k = 1; k < pts.length - 1; k++) idx.push(base, base + k, base + k + 1);
  };
  const tx = -L * 0.38;
  // Forked tail.
  tri([[tx + 0.002, 0.0006, 0], [tx - 0.017, 0.0115, 0], [tx - 0.011, 0.0012, 0], [tx - 0.006, 0, 0]], fin, 0.9);
  tri([[tx + 0.002, -0.0006, 0], [tx - 0.006, 0, 0], [tx - 0.011, -0.0012, 0], [tx - 0.017, -0.0105, 0]], fin, 0.9);
  // Dorsal and anal fins.
  tri([[0.006, H * 0.9, 0], [-0.004, H * 1.75, 0], [-0.011, H * 0.62, 0]], back, 0.85);
  tri([[-0.012, H * 0.4, 0], [-0.016, H * 0.95, 0], [-0.02, H * 0.25, 0]], back, 0.85);
  tri([[-0.006, -H * 0.8, 0], [-0.012, -H * 1.35, 0], [-0.016, -H * 0.5, 0]], fin, 0.95);
  // Pectoral fins, angled back along the flanks.
  for (const sz of [1, -1]) {
    tri([[0.013, -H * 0.25, W * 0.85 * sz], [0.002, -H * 0.55, W * 1.9 * sz], [0.006, -H * 0.05, W * 1.05 * sz]], fin, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Eyes: dark discs with a pale ring, set into the head.
  const merged = [g];
  for (const sz of [1, -1]) {
    const eye = new THREE.SphereGeometry(0.0021, 8, 6);
    eye.scale(1, 1, 0.45);
    eye.translate(L * 0.37, H * 0.28, W * 0.62 * sz);
    const n = eye.getAttribute('position').count;
    const ec = new Float32Array(n * 3);
    const ep = eye.getAttribute('position');
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(ep.getX(i) - L * 0.37, ep.getY(i) - H * 0.28);
      const e = d < 0.0012 ? 0.03 : 0.85;
      ec.set([e, e * 0.95, e * 0.8], i * 3);
    }
    eye.setAttribute('color', new THREE.BufferAttribute(ec, 3));
    eye.deleteAttribute('uv');
    merged.push(eye);
  }
  const out = mergeGeometries(merged.map((m) => (m.index ? m.toNonIndexed() : m)));
  merged.forEach((m) => m.dispose());
  out.computeBoundingSphere();
  return out;
}

interface Fish {
  school: number;
  ox: number;
  oz: number;
  oy: number;
  phase: number;
  jump: number;
  /** Smoothed heading (radians), so turns are gradual. */
  yaw: number;
}

interface School {
  /** Parameter along the shoreline loop. */
  t: number;
  speed: number;
  loop: { x: number; z: number }[];
  dir: number;
}

// --------------------------------------------------------------- ripples

interface Ripple {
  x: number;
  z: number;
  age: number;
  life: number;
  size: number;
}

/** Light at the wildlife, shared by its materials (only one island's wildlife exists at a time). */
const DAYLIGHT = uniform(1);

/**
 * The wildlife's materials, built once for the session: fresh ones for every game left the
 * renderer a little more to keep each time.
 */
let shared: { gull: THREE.Material; fish: THREE.Material[]; ring: THREE.Material; butterfly: THREE.Material } | null = null;
function materials() {
  if (shared) return shared;
  const gullMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
  const flapAttr = attribute<'vec2'>('aFlap', 'vec2');
  const flapN = flapAttr.x;
  const ampN = flapAttr.y;
  // Wings hinge at the shoulder: the whole wing swings through the beat and the outer half
  // lags behind it, so the tips whip; gliding holds a shallow dihedral.
  gullMat.positionNode = Fn(() => {
    const p = positionLocal;
    const span = abs(positionGeometry.z);
    const wing = smoothstep(0.006, 0.012, span);
    const outer = smoothstep(0.035, 0.083, span);
    const angle = sin(flapN).mul(0.7).mul(ampN).add(ampN.oneMinus().mul(0.12)).add(sin(flapN.sub(0.9)).mul(0.4).mul(ampN).mul(outer));
    // Swing about the shoulder; the body rides against the stroke. (Only y is displaced:
    // rewriting z here corrupts the instanced positions in this three build.)
    const y = p.y.add(span.mul(sin(angle)).mul(wing)).sub(sin(flapN).mul(0.004).mul(ampN));
    return vec3(p.x, y, p.z);
  })();
  const fish = [0, 1, 2, 3].map((pi) => {
    const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, side: THREE.DoubleSide });
    // Darker the deeper they swim, so fish under the surface don't glow.
    mat.colorNode = vec4(vec3(mix(float(1), float(0.45), smoothstep(-0.05, -0.2, positionWorld.y.sub(SEA_LEVEL)))), 1);
    mat.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const along = positionGeometry.x;
      // Travelling body wave: barely moves the head, swings the tail.
      const amp = smoothstep(0.02, -0.04, along).pow(1.4).mul(0.0075);
      const wag = sin(time.mul(11).add(along.mul(95)).add(float(pi * 1.7)).add(attribute<'float'>('aSwim', 'float')));
      p.z.addAssign(wag.mul(amp));
      return p;
    })();
    return mat;
  });
  const ringMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  ringMat.colorNode = vec4(0.84, 0.93, 0.97, 1);
  // A feathered, uneven band rather than a crisp white circle; faint at night.
  ringMat.opacityNode = Fn(() => {
    const p = positionGeometry.xz;
    const r = p.length();
    const band = smoothstep(0.8, 0.9, r).mul(smoothstep(1.0, 0.92, r));
    const a = atan(p.y, p.x);
    const broken = sin(a.mul(5).add(sin(a.mul(3)).mul(2))).mul(0.3).add(0.7);
    return attribute<'float'>('rAlpha', 'float').mul(band).mul(broken).mul(DAYLIGHT.mul(0.75).add(0.25));
  })();
  keepNormals(ringMat);
  const bMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true });
  bMat.positionNode = Fn(() => {
    const p = positionLocal.toVar();
    const ph = attribute<'float'>('bPhase', 'float');
    const flapA = sin(time.mul(26).add(ph)).mul(0.9);
    p.y.addAssign(abs(positionGeometry.x).mul(flapA));
    return p;
  })();
  bMat.colorNode = vec4(attribute<'vec3'>('bColor', 'vec3'), 1);
  bMat.opacityNode = mix(float(0), float(1), DAYLIGHT);
  // Tiny wings: one draw for both sides (their back-to-front order can't be seen).
  bMat.forceSinglePass = true;
  keepNormals(bMat);
  shared = { gull: gullMat, fish, ring: ringMat, butterfly: bMat };
  return shared;
}

export class Wildlife {
  group = new THREE.Group();
  private gulls: Gull[] = [];
  private gullMesh: THREE.InstancedMesh;
  private flap: THREE.InstancedBufferAttribute;
  private fishMeshes: THREE.InstancedMesh[] = [];
  private fish: Fish[][] = [];
  private schools: School[] = [];
  private ripples: Ripple[] = [];
  private rippleMesh: THREE.InstancedMesh;
  private rippleAlpha: THREE.InstancedBufferAttribute;
  private butterflies: { x: number; y: number; z: number; vx: number; vz: number; phase: number; hx: number; hz: number; hex: number; yaw?: number }[] = [];
  /** Current rise offset of a tile (negative while the island rises), so meadow life follows it. */
  riseOf: (hex: number) => number = () => 0;
  private butterflyMesh: THREE.InstancedMesh;
  private disposables: { dispose(): void }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();
  /** Light at the wildlife (1 by day, 0 at night). */
  daylight = DAYLIGHT;

  /**
   * `island` is the land's middle and reach (World.frameIsland): the gulls circle it and the fish
   * swim its coast, wherever the board lies (a player's own map need not centre on the origin).
   */
  constructor(
    board: Board,
    private sdf: SdfField,
    private splash: ParticleSystem,
    private island: { x: number; z: number; radius: number },
    count = { gulls: 10, schools: 11, butterflies: 16 },
  ) {
    // Gulls.
    const gullGeo = makeGull();
    // (Not marked dynamic, nor are the rings' alphas: three would send them again at every draw, in
    // every pass, where they change once a frame.)
    this.flap = new THREE.InstancedBufferAttribute(new Float32Array(count.gulls * 2), 2);
    gullGeo.setAttribute('aFlap', this.flap);
    const mats = materials();
    this.gullMesh = instancedMesh(gullGeo, mats.gull, count.gulls);
    this.gullMesh.castShadow = true;
    this.gullMesh.frustumCulled = false;
    this.disposables.push(gullGeo);
    for (let i = 0; i < count.gulls; i++) {
      const coast = i < count.gulls * 0.6;
      this.gulls.push({
        cx: island.x + (Math.random() - 0.5) * (coast ? 3 : 8),
        cz: island.z + (Math.random() - 0.5) * (coast ? 3 : 8),
        r: coast ? 4.5 + Math.random() * 2 : 7 + Math.random() * 6,
        h: 1.6 + Math.random() * 1.6,
        speed: (0.55 + Math.random() * 0.25) * (Math.random() < 0.5 ? 1 : -1),
        angle: Math.random() * Math.PI * 2,
        phase: Math.random() * 10,
        glide: Math.random() * 3,
        beat: Math.random() * 6,
        amp: 1,
      });
    }
    this.group.add(this.gullMesh);

    // Fish schools travelling along loops in the shallows.
    const palettes: FishLook[] = [
      // Mackerel: blue-green barred back, silver flanks.
      { back: '#1f4e5a', flank: '#9fb7bd', belly: '#eef1ee', fin: '#5e7c80', bars: 5 },
      // Sea bream: silver with a warm gold sheen.
      { back: '#6c6a52', flank: '#cfc6a1', belly: '#f3efe2', fin: '#b9a46a', bars: 0 },
      // Snapper: coral back fading to rose and cream.
      { back: '#b2432f', flank: '#e48a6e', belly: '#f7e2d4', fin: '#d1694f', bars: 0 },
      // Perch-like: olive with dark bars and orange fins.
      { back: '#4c5a2c', flank: '#a4a865', belly: '#efe9cf', fin: '#d77a2c', bars: 3 },
    ];
    const perSchool = 7;
    const fishPerMesh = count.schools * perSchool;
    palettes.forEach((look, pi) => {
      const geo = makeFish(look);
      const swim = new THREE.InstancedBufferAttribute(new Float32Array(fishPerMesh).map(() => Math.random() * 6.28), 1);
      geo.setAttribute('aSwim', swim);
      const mesh = instancedMesh(geo, mats.fish[pi], fishPerMesh);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.fishMeshes.push(mesh);
      this.fish.push([]);
      this.group.add(mesh);
      this.disposables.push(geo);
    });
    for (let si = 0; si < count.schools; si++) {
      const offset = 0.3 + Math.random() * 0.9;
      this.schools.push({ t: Math.random(), speed: 0.006 + Math.random() * 0.006, loop: this.shoreLoop(offset), dir: Math.random() < 0.5 ? 1 : -1 });
      const pal = si % palettes.length;
      for (let k = 0; k < perSchool; k++) {
        this.fish[pal].push({ school: si, ox: (Math.random() - 0.5) * 0.35, oz: (Math.random() - 0.5) * 0.25, oy: -0.12 - Math.random() * 0.08, phase: Math.random() * 10, jump: -1, yaw: NaN });
      }
    }
    this.fishMeshes.forEach((m, i) => (m.count = this.fish[i].length));

    // Ripple rings on the water.
    const ringGeo = new THREE.RingGeometry(0.8, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.rippleAlpha = new THREE.InstancedBufferAttribute(new Float32Array(48), 1);
    ringGeo.setAttribute('rAlpha', this.rippleAlpha);
    this.rippleMesh = instancedMesh(ringGeo, mats.ring, 48);
    this.rippleMesh.count = 0;
    this.rippleMesh.frustumCulled = false;
    this.rippleMesh.renderOrder = 12;
    this.rippleMesh.layers.set(DETAIL_LAYER);
    this.group.add(this.rippleMesh);
    this.disposables.push(ringGeo);

    // Butterflies over pastures and fields.
    // (Several times life, to be seen at all, but smaller than a person's head.)
    const bGeo = new THREE.PlaneGeometry(0.015, 0.011, 2, 1);
    const bPhase = new THREE.InstancedBufferAttribute(new Float32Array(count.butterflies).map(() => Math.random() * 10), 1);
    const bColor = new THREE.InstancedBufferAttribute(new Float32Array(count.butterflies * 3), 3);
    const cols = ['#ffffff', '#ffe066', '#9ec5ff', '#ffb0d0', '#ffa94d'];
    for (let i = 0; i < count.butterflies; i++) {
      const c = C(cols[i % cols.length]);
      bColor.setXYZ(i, c.r, c.g, c.b);
    }
    bGeo.setAttribute('bPhase', bPhase);
    bGeo.setAttribute('bColor', bColor);
    this.butterflyMesh = instancedMesh(bGeo, mats.butterfly, count.butterflies);
    this.butterflyMesh.frustumCulled = false;
    this.group.add(this.butterflyMesh);
    this.disposables.push(bGeo);
    const meadows = board.hexes.filter((h) => lookOf(h.terrain) === 'pasture' || lookOf(h.terrain) === 'fields');
    for (let i = 0; i < count.butterflies && meadows.length; i++) {
      const h = meadows[i % meadows.length];
      this.butterflies.push({ x: h.x, y: 0.15, z: h.z, vx: 0, vz: 0, phase: Math.random() * 10, hx: h.x, hz: h.z, hex: h.id });
    }
  }

  /** A closed loop around the island at a given distance from the shore (out from its middle). */
  private shoreLoop(offset: number) {
    const pts: { x: number; z: number }[] = [];
    const { x: cx, z: cz } = this.island;
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      let lo = 0, hi = this.island.radius + 7;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (this.sdf.sample(cx + Math.cos(a) * mid, cz + Math.sin(a) * mid) < offset) lo = mid;
        else hi = mid;
      }
      pts.push({ x: cx + Math.cos(a) * lo, z: cz + Math.sin(a) * lo });
    }
    return pts;
  }

  private lp = { x: 0, z: 0, dx: 0, dz: 0 };

  /**
   * Point and direction along a closed loop at parameter t, on a Catmull-Rom curve through the
   * loop's points (no corners, so swimmers never snap round); the result is reused by the next call.
   */
  private loopPoint(loop: { x: number; z: number }[], t: number) {
    const n = loop.length;
    const f = (((t % 1) + 1) % 1) * n;
    const i = Math.floor(f);
    const u = f - i;
    const p0 = loop[(i + n - 1) % n], p1 = loop[i], p2 = loop[(i + 1) % n], p3 = loop[(i + 2) % n];
    const u2 = u * u, u3 = u2 * u;
    const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
    const dcr = (a: number, b: number, c: number, d: number) => 0.5 * (-a + c + 2 * (2 * a - 5 * b + 4 * c - d) * u + 3 * (-a + 3 * b - 3 * c + d) * u2);
    const o = this.lp;
    o.x = cr(p0.x, p1.x, p2.x, p3.x);
    o.z = cr(p0.z, p1.z, p2.z, p3.z);
    o.dx = dcr(p0.x, p1.x, p2.x, p3.x);
    o.dz = dcr(p0.z, p1.z, p2.z, p3.z);
    return o;
  }

  addRipple(x: number, z: number, size = 0.25, life = 1.6) {
    if (this.ripples.length > 46) this.ripples.shift();
    this.ripples.push({ x, z, age: 0, life, size });
  }

  update(dt: number, t: number) {
    const { m, q, e, s, p } = this;
    // Gulls.
    this.gulls.forEach((g, i) => {
      g.angle += (g.speed / g.r) * dt * 1.6;
      g.glide -= dt;
      const flapping = g.glide < 0;
      if (g.glide < -4.5) g.glide = 1.2 + Math.random() * 2;
      g.amp += ((flapping ? 1 : 0) - g.amp) * follow(dt, 2.5);
      g.beat += dt * 11 * (0.4 + 0.6 * g.amp);
      const x = g.cx + Math.cos(g.angle) * g.r;
      const z = g.cz + Math.sin(g.angle) * g.r;
      const y = g.h + Math.sin(t * 0.5 + g.phase) * 0.25;
      const heading = g.angle + (g.speed > 0 ? Math.PI / 2 : -Math.PI / 2);
      q.setFromAxisAngle(Y_AXIS, -heading);
      this.q2.setFromAxisAngle(X_AXIS, (g.speed > 0 ? -1 : 1) * (0.3 + Math.sin(t + g.phase) * 0.06));
      q.multiply(this.q2);
      p.set(x, y, z);
      // (Twice life against the people, as the island's birds go: see board/life/pasture.ts.)
      s.set(0.83, 0.83, 0.83);
      m.compose(p, q, s);
      this.gullMesh.setMatrixAt(i, m);
      (this.flap.array as Float32Array)[i * 2] = g.beat;
      (this.flap.array as Float32Array)[i * 2 + 1] = g.amp;
    });
    this.gullMesh.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;

    // Fish.
    for (const sc of this.schools) sc.t += sc.speed * sc.dir * dt;
    this.fish.forEach((list, mi) => {
      const mesh = this.fishMeshes[mi];
      list.forEach((f, i) => {
        const sc = this.schools[f.school];
        const lp = this.loopPoint(sc.loop, sc.t + f.ox * 0.02);
        // Heading eases toward the path's direction instead of following it exactly.
        const want = Math.atan2(lp.dz * sc.dir, lp.dx * sc.dir);
        f.yaw = Number.isNaN(f.yaw) ? want : easeAngle(f.yaw, want, follow(dt, 4));
        const tx = Math.cos(f.yaw), tz = Math.sin(f.yaw);
        const nx = -tz, nz = tx;
        const wob = Math.sin(t * 1.3 + f.phase) * 0.04;
        let x = lp.x + nx * (f.oz + wob) + tx * f.ox;
        let z = lp.z + nz * (f.oz + wob) + tz * f.ox;
        let y = SEA_LEVEL + f.oy + Math.sin(t * 2 + f.phase) * 0.01;
        let pitch = 0;
        // Occasional leap out of the water.
        if (f.jump < 0 && Math.random() < dt * 0.012) {
          f.jump = 0;
          this.addRipple(x, z, 0.12, 1.1);
          this.splashAt(x, z, 6);
        }
        if (f.jump >= 0) {
          f.jump += dt * 1.6;
          const u = f.jump;
          y = SEA_LEVEL + f.oy + Math.sin(Math.min(1, u) * Math.PI) * (0.3 - f.oy);
          x += tx * u * 0.25;
          z += tz * u * 0.25;
          pitch = (0.5 - Math.min(1, u)) * 1.8;
          if (u >= 1) {
            f.jump = -1;
            this.addRipple(x, z, 0.16, 1.4);
            this.splashAt(x, z, 10);
          }
        }
        const heading = Math.atan2(tz, tx);
        q.setFromAxisAngle(Y_AXIS, -heading);
        this.q2.setFromAxisAngle(Z_AXIS, pitch);
        q.multiply(this.q2);
        p.set(x, y, z);
        s.set(0.9, 0.9, 0.9);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
    // Ambient ripples from swells near the shore.
    if (Math.random() < dt * 0.8) {
      const sc = this.schools[Math.floor(Math.random() * this.schools.length)];
      const lp = this.loopPoint(sc.loop, Math.random());
      this.addRipple(lp.x, lp.z, 0.05 + Math.random() * 0.05, 1.2);
    }

    // Ripples.
    let n = 0;
    const alpha = this.rippleAlpha.array as Float32Array;
    let live = 0;
    for (const r of this.ripples) if ((r.age += dt) < r.life) this.ripples[live++] = r;
    this.ripples.length = live;
    for (const r of this.ripples) {
      const u = r.age / r.life;
      const size = r.size * (0.3 + u * 1.4);
      p.set(r.x, SEA_LEVEL + 0.012, r.z);
      q.identity();
      s.set(size, 1, size);
      m.compose(p, q, s);
      this.rippleMesh.setMatrixAt(n, m);
      alpha[n] = (1 - u) * (1 - u) * 0.28;
      n++;
    }
    // (A calm sea has no rings: nothing to send then.)
    if (n > 0) {
      this.rippleMesh.instanceMatrix.needsUpdate = true;
      this.rippleAlpha.needsUpdate = true;
    }
    this.rippleMesh.count = n;

    // Butterflies: lazy wandering around their home meadow.
    this.butterflies.forEach((b, i) => {
      const k = t * 0.7 + b.phase;
      b.vx += (Math.sin(k * 1.3) * 0.3 + (b.hx - b.x) * 0.6) * dt;
      b.vz += (Math.cos(k * 1.1) * 0.3 + (b.hz - b.z) * 0.6) * dt;
      b.vx *= 0.98;
      b.vz *= 0.98;
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      const rise = this.riseOf(b.hex);
      b.y = 0.14 + Math.sin(k * 3) * 0.04 + rise;
      b.yaw = easeAngle(b.yaw ?? Math.atan2(-b.vz, b.vx), Math.atan2(-b.vz, b.vx), follow(dt, 6));
      e.set(0, b.yaw, 0);
      q.setFromEuler(e);
      p.set(b.x, b.y, b.z);
      // Not out over open water while their meadow is still under it.
      s.setScalar(rise < -0.05 ? 0.0001 : 1);
      m.compose(p, q, s);
      this.butterflyMesh.setMatrixAt(i, m);
    });
    this.butterflyMesh.instanceMatrix.needsUpdate = true;
  }

  private splashAt(x: number, z: number, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.splash.emit({
        x,
        y: SEA_LEVEL + 0.01,
        z,
        vx: Math.cos(a) * 0.15,
        vy: 0.35 + Math.random() * 0.3,
        vz: Math.sin(a) * 0.15,
        life: 0.6 + Math.random() * 0.3,
        size: 0.025,
        grow: 1.2,
        color: '#f4fbff',
        alpha: 0.85,
        gravity: 1.6,
      });
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.gullMesh.dispose();
    this.fishMeshes.forEach((m) => m.dispose());
    this.rippleMesh.dispose();
    this.butterflyMesh.dispose();
    this.group.clear();
  }
}
