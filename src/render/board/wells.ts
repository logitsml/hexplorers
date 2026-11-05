// Oil wells (the Oil module), worked as the island works everything else, by hand and by beast. On
// each well tile's level pad (see wellSite.ts) a well-sweep: a long pole pivoting on a timber
// upright, a lashed stone at its short end, dipping a leather bucket into a stone-lined pit of oil
// and hauling it up dripping, beside barrels being filled through a funnel. A numbered well (on the
// desert or a swamp) is the landmark: a horse-gin over a stone-ringed shaft, a donkey walking its
// circle at the capstan, the rope paying out over the headframe's wheel as one bucket comes up and
// the other goes down; beside it pitch boiling in a cauldron over a fire (tar for the ships' seams),
// smoking by day and glowing at night, and lanterns on the headframe and by the barrels. Both stand
// on oil-soaked ground with a black, sheened seep. When a well yields, the sweep quickens (the
// donkey steps out) and oil wells up out of the pit or the shaft.
//
// Drawn as the expansions' looks draw their life (life/props.ts): every well's still parts in one
// mesh on the shared life material, each moving part a plain mesh on it (plain meshes of one
// material share a node build, where instanced batches would have builds of their own in each pass), the
// lanterns' glass and the cauldron's fire in the shared fire material, the oil in its own.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, attribute, cameraPosition, cos, dot, float, fract, int, max, mx_noise_float, normalWorld, normalize, positionLocal, positionWorld, pow, time, vec3, vec4 } from 'three/tsl';
import { MeshBuilder, compose, smoothSphere } from './geom';
import { shown } from './kit';
import { SURFACE } from './surfaces';
import { bumpedNormal, pooled, type TileEffects } from './materials';
import type { TileInfo } from './tiles';
import type { Reserved } from './decor';
import type { LifeContext, LifeModule } from './life/common';
import { Parts, fireMaterial, stillProps, stokeFire } from './life/props';
import { GIN, GIN_SCALE, SWEEP, WELL_SCALE, type WellPad } from './wellSite';
import { DETAIL_LAYER } from './layout';
import { release } from './release';
import { Rand } from '../util/noise';
import { lampColor } from '../fx/lamps';
import type { Lamp } from '../fx/lampLights';

// (Every colour here is chosen as it should look, so it goes through shown(): the material squares
// vertex colours.)
const S = shown;

// The well-sweep, in its own units (+x along the pole towards the pit, +y up): where the pole
// pivots, its arms either side, and the rope from its end to the bucket. (The pit is SWEEP.pit.)
const PIVOT = new THREE.Vector3(-0.006, 0.068, 0);
const LONG = 0.062;
const SHORT = 0.034;
const ROPE = 0.03;
/** The pole's angle at phase φ, the rhythm the hex has always had: its long end dipping to the pit, then hauled up by the stone. */
const sweepAngle = (phi: number) => -0.08 + 0.42 * Math.sin(phi);

// The horse-gin, in its own units: the headframe's wheel over the shaft (GIN.shaft), and the
// capstan the donkey walks round (GIN.capstan, at GIN.track).
const WHEEL_Y = 0.14;
const WHEEL_R = 0.012;
/** How high a bucket rides, deep in the shaft (out of sight) to just under the wheel. */
const BUCKET_DEEP = -0.03;
const BUCKET_UP = WHEEL_Y - 0.034;
/** A bucket's rope hangs from either side of the wheel (one up as the other goes down). */
const ROPE_X = [GIN.shaft.x - 0.0095, GIN.shaft.x + 0.0095];
/** One round of the gin, in seconds at its usual pace: a lap one way (a bucket up), a turn, a lap back (the other up), a turn. */
const GIN_ROUND = 13;
/** Where the gin's lanterns hang (its own units): from the headframe, and on a post by the barrels. */
const LANTERNS = [new THREE.Vector3(GIN.shaft.x, WHEEL_Y - 0.022, 0.037), new THREE.Vector3(-0.024, 0.047, 0.076)];
/** The pitch cauldron's hearth. */
const HEARTH = new THREE.Vector3(0.0, 0, 0.07);

const box = (b: MeshBuilder, w: number, h: number, d: number, m: THREE.Matrix4, c: THREE.Color) => {
  const g = new THREE.BoxGeometry(w, h, d);
  b.addGeometry(g, m, c);
  g.dispose();
};
const cyl = (b: MeshBuilder, r0: number, r1: number, h: number, seg: number, m: THREE.Matrix4, c: THREE.Color, open = false) => {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg, 1, open);
  b.addGeometry(g, m, c);
  g.dispose();
};
const add = (b: MeshBuilder, g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color) => {
  b.addGeometry(g, m, c);
  g.dispose();
};

/** A strut from a to b (a thin box), for frames and props. */
function strut(b: MeshBuilder, a: THREE.Vector3, z: THREE.Vector3, t: number, c: THREE.Color) {
  const d = new THREE.Vector3().subVectors(z, a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  box(b, t, len, t, new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, z).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), c);
}

/** An open cylinder seen from inside (normals in, faces wound to face them): a pit's or a shaft's lining. */
function lining(r: number, h: number, seg: number) {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, true);
  const n = g.getAttribute('normal');
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  const idx = g.getIndex()!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    idx.setX(i, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  return g;
}

/** A stone kerb round a hole at (x, z): its outer face, its top and its lining, `h` above the ground. */
function kerb(b: MeshBuilder, x: number, z: number, r0: number, r1: number, h: number, stone: THREE.Color) {
  b.surfaceId = SURFACE.stone;
  add(b, new THREE.CylinderGeometry(r1, r1 * 1.04, h + 0.01, 16, 1, true), compose(x, (h - 0.01) / 2, z), stone);
  b.surfaceId = SURFACE.plain;
  add(b, new THREE.RingGeometry(r0, r1, 16).rotateX(-Math.PI / 2), compose(x, h, z), stone.clone().multiplyScalar(0.92));
  add(b, lining(r0, h + 0.03, 16), compose(x, h - (h + 0.03) / 2, z), stone.clone().multiplyScalar(0.55));
}

/** Barrels of oak, iron-hooped, standing on end and one on its side; the first with a funnel in its bung. */
function barrels(b: MeshBuilder, rnd: Rand, x: number, z: number, n: number, funnel = false) {
  const oak = [S('#8a6440'), S('#7a5636'), S('#956c45')];
  const hoop = S('#33302c'), oily = S('#2a211b');
  for (let i = 0; i < n; i++) {
    const lying = i === n - 1 && n > 2;
    const px = x + (i % 2) * 0.017 + rnd.range(-0.002, 0.002), pz = z + Math.floor(i / 2) * 0.017 + rnd.range(-0.002, 0.002);
    const m = lying ? compose(px + 0.006, 0.0075, pz + 0.01, 0, rnd.range(0, 3), Math.PI / 2) : compose(px, 0.0105, pz, 0, rnd.range(0, 3), 0);
    const wood = oak[(i + rnd.int(3)) % oak.length];
    // (Bellied: wider at the middle than at the heads.)
    const staves = new THREE.CylinderGeometry(0.0075, 0.0075, 0.021, 10, 4);
    const p = staves.getAttribute('position');
    for (let j = 0; j < p.count; j++) {
      const k = 1 + 0.12 * (1 - Math.pow(p.getY(j) / 0.0105, 2));
      p.setXYZ(j, p.getX(j) * k, p.getY(j), p.getZ(j) * k);
    }
    staves.computeVertexNormals();
    add(b, staves, m, wood);
    for (const y of [-0.0075, -0.003, 0.003, 0.0075]) cyl(b, 0.0081 + (Math.abs(y) < 0.004 ? 0.0006 : 0), 0.0081 + (Math.abs(y) < 0.004 ? 0.0006 : 0), 0.0012, 10, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, y, 0)), hoop);
    cyl(b, 0.0068, 0.0068, 0.0012, 10, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.0105, 0)), i === 0 ? oily : wood.clone().multiplyScalar(0.8));
    if (funnel && i === 0 && !lying) {
      add(b, new THREE.ConeGeometry(0.0055, 0.008, 10, 1, true).rotateX(Math.PI), compose(px, 0.0255, pz), S('#6a6258'));
      cyl(b, 0.0011, 0.0011, 0.006, 6, compose(px, 0.0195, pz), S('#6a6258'));
    }
  }
}

/** The well-sweep's fixed parts: its upright and props, the stone-lined pit, boards to stand on, barrels, a ladle on a peg, a tool shed and a length of rail. */
function makeSweepBase(seed: number): THREE.BufferGeometry {
  const rnd = new Rand(seed);
  const b = new MeshBuilder();
  const timber = S('#6b5036'), weathered = S('#7d6248'), stone = S('#9a8f80');
  // The upright: a stout post (on into the ground), forked at its top round the pole's pin, propped.
  box(b, 0.009, PIVOT.y + 0.02, 0.009, compose(PIVOT.x, (PIVOT.y - 0.02) / 2, 0), timber);
  for (const s of [-1, 1]) box(b, 0.008, 0.014, 0.0028, compose(PIVOT.x, PIVOT.y + 0.002, s * 0.0052), timber);
  cyl(b, 0.0016, 0.0016, 0.014, 6, compose(PIVOT.x, PIVOT.y, 0, Math.PI / 2, 0, 0), S('#3a3632'));
  strut(b, new THREE.Vector3(PIVOT.x - 0.026, -0.002, 0), new THREE.Vector3(PIVOT.x, 0.042, 0), 0.0045, weathered);
  for (const s of [-1, 1]) strut(b, new THREE.Vector3(PIVOT.x + 0.006, -0.002, s * 0.022), new THREE.Vector3(PIVOT.x, 0.036, s * 0.003), 0.0042, weathered);
  // A ladle hung on a peg on the upright.
  cyl(b, 0.0009, 0.0009, 0.006, 5, compose(PIVOT.x, 0.046, 0.007, Math.PI / 2, 0, 0), timber);
  box(b, 0.0016, 0.026, 0.0012, compose(PIVOT.x, 0.034, 0.0098), S('#5a4632'));
  add(b, new THREE.SphereGeometry(0.0034, 8, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), compose(PIVOT.x, 0.0215, 0.0098), S('#4a4440'));
  // The pit, lined with stone, and boards laid by it to stand on.
  const { x: px, z: pz } = SWEEP.pit;
  kerb(b, px, pz, 0.0145, 0.019, 0.008, stone);
  for (const [dx, dz, a] of [[-0.03, 0.006, 0.1], [-0.026, -0.008, -0.08], [0.004, 0.029, 1.5]] as const) box(b, 0.034, 0.003, 0.0085, compose(px + dx, 0.0015, pz + dz, 0, a, 0), weathered.clone().lerp(S('#2e2620'), rnd.range(0.2, 0.5)));
  barrels(b, rnd, 0.016, 0.03, 4, true);
  // A tool shed of planks under a pent roof, its door ajar, a pot of grease and a coil of rope by it.
  box(b, 0.026, 0.02, 0.018, compose(-0.062, 0.01, -0.038), weathered);
  box(b, 0.031, 0.0025, 0.024, compose(-0.062, 0.0215, -0.0375, 0.18, 0, 0), S('#4f4740'));
  box(b, 0.009, 0.016, 0.0015, compose(-0.058, 0.008, -0.0285, 0, -0.5, 0), S('#3a2a1e'));
  cyl(b, 0.0034, 0.0034, 0.007, 8, compose(-0.045, 0.0035, -0.03), S('#5a3a28'));
  add(b, new THREE.TorusGeometry(0.0038, 0.0013, 4, 10).rotateX(Math.PI / 2), compose(-0.075, 0.0015, -0.024), S('#a8936a'));
  // A length of post-and-rail along the yard's back.
  for (let i = 0; i < 4; i++) box(b, 0.0032, 0.022, 0.0032, compose(-0.02 + i * 0.022, 0.011, -0.058), timber);
  for (const y of [0.009, 0.018]) box(b, 0.068, 0.0022, 0.0018, compose(0.013, y, -0.058), timber);
  return b.build(false);
}

/** The sweep's pole, about its pin (+x the long arm): a tapering timber, a stone lashed under its short end. */
function makeSweepPole(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const pole = S('#7a5c3c'), rope = S('#a8936a');
  const len = LONG + SHORT + 0.008;
  const g = new THREE.BoxGeometry(len, 0.005, 0.0045, 6, 1, 1);
  const p = g.getAttribute('position');
  // (Thinner towards the long end.)
  for (let i = 0; i < p.count; i++) {
    const t = (p.getX(i) + len / 2) / len;
    p.setXYZ(i, p.getX(i), p.getY(i) * (1.2 - 0.5 * t), p.getZ(i) * (1.2 - 0.5 * t));
  }
  g.computeVertexNormals();
  add(b, g, compose((LONG - SHORT) / 2, 0, 0), pole);
  // The rope's hitch at the long end; the stone under the short end, lashed with rope.
  add(b, new THREE.TorusGeometry(0.0022, 0.0008, 4, 8), compose(LONG, -0.0015, 0), S('#3a2618'));
  const rock = new THREE.IcosahedronGeometry(0.0095, 1);
  rock.scale(1.15, 0.85, 1);
  add(b, rock, compose(-SHORT, -0.0085, 0, 0.3, 0.5, 0.2), S('#8a8478'));
  for (const a of [-0.5, 0.6]) add(b, new THREE.TorusGeometry(0.0085, 0.0009, 4, 12), compose(-SHORT + a * 0.004, -0.0075, 0, 0, Math.PI / 2 + a, 0), rope);
  strut(b, new THREE.Vector3(-SHORT, 0, 0), new THREE.Vector3(-SHORT, -0.004, 0), 0.0012, rope);
  return b.build(false);
}

/** A rope hanging from its top (the origin) with a leather bucket on it: `ROPE` long, the bucket below. */
function makeBucket(rope: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const leather = S('#5a3a24'), strap = S('#3a2618');
  if (rope > 0) cyl(b, 0.0007, 0.0007, rope, 4, compose(0, -rope / 2, 0), S('#a8936a'));
  add(b, new THREE.TorusGeometry(0.0045, 0.0007, 3, 8, Math.PI), compose(0, -rope - 0.0035, 0), strap);
  cyl(b, 0.0062, 0.0048, 0.011, 10, compose(0, -rope - 0.0115, 0), leather);
  add(b, new THREE.CircleGeometry(0.0058, 10).rotateX(-Math.PI / 2), compose(0, -rope - 0.0061, 0), S('#141010'));
  add(b, new THREE.TorusGeometry(0.0062, 0.0008, 3, 10).rotateX(Math.PI / 2), compose(0, -rope - 0.0062, 0), strap);
  return b.build(false);
}

/** A unit rope along +y (a gin bucket's, stretched to length each frame). */
function makeRope(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  cyl(b, 0.0008, 0.0008, 1, 4, compose(0, 0.5, 0), S('#a8936a'));
  return b.build(false);
}

/**
 * The horse-gin's fixed parts: the stone-ringed shaft, the headframe of two timber A-frames over
 * it carrying the wheel's axle, the rope from the capstan's drum up to the wheel, the capstan's
 * footing, the trough the buckets are emptied into, the pitch cauldron on its hearth (its fire is
 * the fire's material: see WellsLife.build), firewood, barrels, and the lanterns' frames.
 */
function makeGinBase(seed: number): THREE.BufferGeometry {
  const rnd = new Rand(seed);
  const b = new MeshBuilder();
  const timber = S('#6b5036'), dark = S('#4e3a28'), stone = S('#9a8f80'), iron = S('#2e2a27');
  const { x: sx, z: sz } = GIN.shaft;
  kerb(b, sx, sz, 0.019, 0.025, 0.012, stone);
  add(b, new THREE.CircleGeometry(0.019, 16).rotateX(-Math.PI / 2), compose(sx, -0.02, sz), S('#0c0a09'));
  // The headframe: an A-frame either side of the shaft, braced, the axle across their heads.
  for (const s of [-1, 1]) {
    const top = new THREE.Vector3(sx, WHEEL_Y + 0.004, s * 0.022);
    for (const d of [-1, 1]) strut(b, new THREE.Vector3(sx + d * 0.032, -0.008, s * 0.027), top, 0.0045, timber);
    strut(b, new THREE.Vector3(sx - 0.02, 0.046, s * 0.0245), new THREE.Vector3(sx + 0.02, 0.046, s * 0.0245), 0.0035, dark);
    box(b, 0.008, 0.006, 0.006, compose(sx, WHEEL_Y, s * 0.022), dark);
  }
  cyl(b, 0.0018, 0.0018, 0.05, 6, compose(sx, WHEEL_Y, 0, Math.PI / 2, 0, 0), iron);
  // The rope from the capstan's drum up over the wheel.
  strut(b, new THREE.Vector3(GIN.capstan.x - 0.011, 0.04, 0), new THREE.Vector3(sx + 0.004, WHEEL_Y + WHEEL_R, 0), 0.0014, S('#a8936a'));
  // The capstan's footing: a worn stone in the middle of the donkey's circle.
  cyl(b, 0.009, 0.011, 0.006, 10, compose(GIN.capstan.x, 0.001, GIN.capstan.z), stone);
  // The trough the buckets are tipped into (its oil is the slicks': see SlickBuilder.rect).
  const tz = sz - 0.034;
  for (const s of [-1, 1]) box(b, 0.042, 0.009, 0.0025, compose(sx, 0.0045, tz + s * 0.0055), dark);
  for (const s of [-1, 1]) box(b, 0.0025, 0.009, 0.0135, compose(sx + s * 0.0205, 0.0045, tz), dark);
  // The pitch cauldron: a hearth of stones, logs under a black pot on three legs, a paddle in it.
  const { x: hx, z: hz } = HEARTH;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    add(b, new THREE.IcosahedronGeometry(0.0042, 0), compose(hx + Math.cos(a) * 0.015, 0.002, hz + Math.sin(a) * 0.015, a, a * 2, 0), stone.clone().multiplyScalar(0.8 + rnd.range(0, 0.25)));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    cyl(b, 0.0018, 0.0018, 0.018, 5, compose(hx + Math.cos(a) * 0.005, 0.003, hz + Math.sin(a) * 0.005, Math.PI / 2, -a, 0.15), S('#3a2a1e'));
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    strut(b, new THREE.Vector3(hx + Math.cos(a) * 0.014, 0, hz + Math.sin(a) * 0.014), new THREE.Vector3(hx + Math.cos(a) * 0.009, 0.024, hz + Math.sin(a) * 0.009), 0.0016, iron);
  }
  add(b, new THREE.SphereGeometry(0.0125, 14, 8, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58), compose(hx, 0.03, hz), iron);
  add(b, new THREE.TorusGeometry(0.0122, 0.0013, 4, 14).rotateX(Math.PI / 2), compose(hx, 0.0312, hz), iron);
  add(b, new THREE.CircleGeometry(0.0118, 14).rotateX(-Math.PI / 2), compose(hx, 0.029, hz), S('#120e0b'));
  strut(b, new THREE.Vector3(hx - 0.004, 0.026, hz), new THREE.Vector3(hx + 0.012, 0.05, hz - 0.006), 0.0018, S('#5a4632'));
  // Firewood stacked by it, barrels of oil and of pitch, and the lanterns' frames: one hung from
  // the headframe on a bracket, one on a post by the barrels.
  for (let i = 0; i < 6; i++) cyl(b, 0.0034, 0.0034, 0.024, 6, compose(0.034 + (i % 3) * 0.0068 - (i >= 3 ? 0.0034 : 0), 0.0034 + (i >= 3 ? 0.0058 : 0), 0.076, Math.PI / 2, 0.3, 0), S(i % 2 ? '#7a5434' : '#8d6640'));
  barrels(b, rnd, -0.068, 0.044, 4);
  strut(b, new THREE.Vector3(sx, WHEEL_Y - 0.008, 0.024), new THREE.Vector3(LANTERNS[0].x, WHEEL_Y - 0.008, LANTERNS[0].z), 0.0016, dark);
  box(b, 0.0034, 0.062, 0.0034, compose(LANTERNS[1].x, 0.029, LANTERNS[1].z + 0.009), timber);
  strut(b, new THREE.Vector3(LANTERNS[1].x, 0.058, LANTERNS[1].z + 0.009), new THREE.Vector3(LANTERNS[1].x, 0.058, LANTERNS[1].z), 0.0016, dark);
  for (const at of LANTERNS) lanternFrame(b, at);
  return b.build(false);
}

/** The headframe's wheel, about its axle (in xy, turning about z): a rim with a groove, spokes and a hub. */
function makeWheel(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const wood = S('#6b5036');
  add(b, new THREE.TorusGeometry(WHEEL_R, 0.0022, 5, 18), compose(0, 0, 0), wood);
  for (let i = 0; i < 4; i++) box(b, WHEEL_R * 2, 0.0018, 0.0018, compose(0, 0, 0, 0, 0, (i * Math.PI) / 4), wood);
  cyl(b, 0.003, 0.003, 0.006, 8, compose(0, 0, 0, Math.PI / 2, 0, 0), S('#3a3632'));
  return b.build(false);
}

/** The capstan, about its upright (turning about y): the drum the rope winds on, and the arm out (+x) to the donkey's collar. */
function makeCapstan(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const timber = S('#6b5036'), rope = S('#a8936a');
  cyl(b, 0.0042, 0.0046, 0.066, 8, compose(0, 0.033, 0), timber);
  cyl(b, 0.011, 0.011, 0.016, 12, compose(0, 0.04, 0), rope);
  for (const y of [0.031, 0.049]) cyl(b, 0.014, 0.014, 0.002, 12, compose(0, y, 0), timber);
  add(b, new THREE.ConeGeometry(0.0062, 0.007, 8), compose(0, 0.0695, 0), timber);
  // (Out to the donkey's collar, as high as the donkey stands: see DONKEY.)
  strut(b, new THREE.Vector3(0, 0.06, 0), new THREE.Vector3(GIN.track - 0.004 * DONKEY, 0.031 * DONKEY, 0), 0.0042, timber);
  strut(b, new THREE.Vector3(0.012, 0.055, 0), new THREE.Vector3(0.012, 0.042, 0), 0.002, timber);
  return b.build(false);
}

/**
 * How the donkey is drawn against its model: a donkey stands lower than a horse, and the island's
 * people (see life/pasture.ts on sizes); at its model's size it would stand a hand taller than the
 * horses on the roads.
 */
const DONKEY = 0.78;

/** A donkey facing +x, hooves about the origin: a stocky grey-brown body, pale muzzle and belly, long ears, a leather collar. */
function makeDonkey(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const coat = S('#8a7c6a'), pale = S('#d8cfc0'), dark = S('#3a332c'), leather = S('#5a3a24');
  const body = smoothSphere(0.0105, 1);
  body.scale(1.75, 1.0, 0.85);
  b.addGeometry(body, compose(0, 0.026, 0), (_x, y, _z, o) => void o.copy(y < 0.0205 ? pale : coat));
  body.dispose();
  strut(b, new THREE.Vector3(0.013, 0.029, 0), new THREE.Vector3(0.021, 0.04, 0), 0.0075, coat);
  box(b, 0.011, 0.002, 0.0018, compose(0.0175, 0.0398, 0, 0, 0, 0.95), dark);
  const head = smoothSphere(0.0055, 1);
  head.scale(1.6, 1, 0.9);
  add(b, head, compose(0.026, 0.0395, 0, 0, 0, -0.6), coat);
  add(b, smoothSphere(0.0036, 1), compose(0.0315, 0.0352, 0), pale);
  for (const s of [-1, 1]) add(b, new THREE.ConeGeometry(0.0016, 0.011, 5), compose(0.0225, 0.048, s * 0.0028, s * -0.25, 0, 0.35), coat);
  for (const [dx, dz] of [[0.011, 0.0045], [0.011, -0.0045], [-0.011, 0.0045], [-0.011, -0.0045]]) {
    cyl(b, 0.0024, 0.002, 0.017, 6, compose(dx, 0.0085, dz), coat);
    cyl(b, 0.0021, 0.0023, 0.002, 6, compose(dx, 0.001, dz), dark);
  }
  strut(b, new THREE.Vector3(-0.0175, 0.03, 0), new THREE.Vector3(-0.021, 0.017, 0), 0.0012, coat);
  add(b, smoothSphere(0.0022, 0), compose(-0.0212, 0.0158, 0), dark);
  add(b, new THREE.TorusGeometry(0.0055, 0.0016, 4, 12).rotateY(Math.PI / 2), compose(0.0155, 0.032, 0, 0, 0, -0.75), leather);
  return b.build(false);
}

/** A hurricane lantern's frame round (x, y, z): a cap, a base, guard wires and a bail. */
function lanternFrame(b: MeshBuilder, at: THREE.Vector3) {
  const metal = S('#2c2824');
  add(b, new THREE.ConeGeometry(0.0055, 0.0045, 8), compose(at.x, at.y + 0.0068, at.z), metal);
  cyl(b, 0.005, 0.0052, 0.0018, 8, compose(at.x, at.y - 0.0055, at.z), metal);
  for (const a of [0.6, 2.7, 4.8]) box(b, 0.0007, 0.0105, 0.0007, compose(at.x + Math.cos(a) * 0.0045, at.y, at.z + Math.sin(a) * 0.0045), metal);
  add(b, new THREE.TorusGeometry(0.0024, 0.0005, 3, 8, Math.PI), compose(at.x, at.y + 0.0088, at.z), metal);
}

const LANTERN = lampColor(1.5, 0.8, 0.35);
const CAULDRON_FIRE = lampColor(1.0, 0.5, 0.18);

/**
 * Oil lying on the ground: near-black brown, with a lazy swirl in its surface and the colours of
 * a thin film playing over it, strongest at a glancing angle and only by daylight. (Not the
 * rivers' water: the sky it mirrored read as a navy hole in the ground.)
 */
function oilMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  return pooled(effects, 'oilSlick', () => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0 });
    const tile = attribute<'float'>('tile', 'float');
    m.positionNode = positionLocal.add(vec3(0, effects.rise.element(int(tile)) as unknown as Node<'float'>, 0));
    // (No branches in this material, so the derivatives in bumpedNormal are safe.)
    const swirl = mx_noise_float(vec3(positionWorld.x.mul(16), positionWorld.z.mul(16), time.mul(0.05)));
    m.normalNode = bumpedNormal(swirl, 0.0007);
    m.colorNode = vec4(0.014, 0.010, 0.007, 1);
    m.emissiveNode = Fn(() => {
      const view = normalize(cameraPosition.sub(positionWorld));
      const facing = max(dot(normalWorld, view), 0);
      // Interference colours: a cosine palette round the hue circle, banded by the film's
      // thickness (the swirl) and by the angle it's seen at.
      const film = fract(facing.mul(2.4).add(swirl.mul(0.7)).add(time.mul(0.012)));
      const hue = vec3(0.5, 0.5, 0.5).add(vec3(0.32, 0.32, 0.32).mul(cos(film.mul(6.2832).add(vec3(0, 2.1, 4.2)))));
      const sheen = pow(float(1).sub(facing), 2).mul(0.7).add(0.06);
      return hue.mul(sheen).mul(effects.sunTint).mul(0.07);
    })();
    return m;
  });
}

interface Sweep {
  pole: THREE.Object3D;
  bucket: THREE.Object3D;
}

interface Gin {
  capstan: THREE.Object3D;
  donkey: THREE.Object3D;
  wheel: THREE.Object3D;
  buckets: THREE.Object3D[];
  ropes: THREE.Object3D[];
  smoke: number;
}

interface Well {
  tile: TileInfo;
  pad: WellPad;
  /** The sweep's (or gin's) frame: its place, turn and scale on the board. */
  frame: THREE.Matrix4;
  scale: number;
  sweep: Sweep | null;
  gin: Gin | null;
  /** A sweep's swing (radians of its rhythm), or how far a gin is through its round (0..1). */
  phase: number;
  /** Production's push, easing off: the work quickens, and oil wells up. */
  boost: number;
  gush: number;
  carry: number;
  drip: number;
  anchor: THREE.Object3D;
  lamps: Lamp[];
  /** A gin's lantern glass and cauldron fire (lit in the fire's material). */
  lit: THREE.Mesh | null;
}

// Scratch for the frame-by-frame posing (none allocated per frame).
const _m = new THREE.Matrix4();
const _l = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _tip = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const WHITE = new THREE.Color(1, 1, 1);
const ease = (u: number) => u * u * (3 - 2 * u);

/** Where a gin is in its round (0..1): how far bucket A is up (`s`), the capstan's turn, which way the donkey walks, and how far it has turned about at the end of a lap. */
const _gin = { s: 0, turn: 0, dir: 1, about: 0, walking: false };
function ginPose(ph: number) {
  const WALK = 0.44;
  if (ph < WALK) Object.assign(_gin, { s: ease(ph / WALK), dir: 1, about: 0, walking: true });
  else if (ph < 0.5) Object.assign(_gin, { s: 1, dir: 1, about: ease((ph - WALK) / (0.5 - WALK)), walking: false });
  else if (ph < 0.5 + WALK) Object.assign(_gin, { s: 1 - ease((ph - 0.5) / WALK), dir: -1, about: 0, walking: true });
  else Object.assign(_gin, { s: 0, dir: -1, about: ease((ph - 0.5 - WALK) / (0.5 - WALK)), walking: false });
  // (A lap of the circle raises one bucket the whole way.)
  _gin.turn = _gin.s * Math.PI * 2;
  return _gin;
}

/** Pose a part's node from a matrix (its node keeps no position, turn or scale of its own). */
function pose(node: THREE.Object3D, m: THREE.Matrix4) {
  node.matrix.copy(m);
  node.matrixWorldNeedsUpdate = true;
}

export class WellsLife implements LifeModule {
  private wells: Well[] = [];
  private root = new THREE.Group();
  private parts: Parts;
  private disposables: { dispose(): void }[] = [];

  constructor(private ctx: LifeContext) {
    this.parts = new Parts(ctx.effects, ctx.props);
    this.root.name = 'oil wells';
  }

  plan(tiles: TileInfo[]): Reserved {
    // (The pad itself keeps trees, grass and sheep off: see wellSite.ts and canPlace.)
    this.wells = tiles
      .filter((t) => t.shape.ctx.pad)
      .map((t) => ({ tile: t, pad: t.shape.ctx.pad!, frame: new THREE.Matrix4(), scale: 1, sweep: null, gin: null, phase: t.hex.id * 1.7, boost: 0, gush: 0, carry: 0, drip: 0, anchor: new THREE.Object3D(), lamps: [], lit: null }));
    return [];
  }

  build() {
    if (!this.wells.length) return;
    const { effects, group } = this.ctx;
    group.add(this.root);
    const geo = {
      pole: makeSweepPole(), bucket: makeBucket(ROPE), ginBucket: makeBucket(0), rope: makeRope(), wheel: makeWheel(), capstan: makeCapstan(), donkey: makeDonkey(),
      glass: new THREE.CylinderGeometry(0.0038, 0.0038, 0.0092, 8), flame: new THREE.ConeGeometry(0.0065, 0.016, 7).translate(0, 0.008, 0),
    };
    this.disposables.push(...Object.values(geo));
    const sweepBase = makeSweepBase(3), ginBase = makeGinBase(5);
    const still: { geo: THREE.BufferGeometry; hex: { id: number; x: number; z: number } }[] = [];
    const slick = new SlickBuilder();
    const local = new THREE.Matrix4();
    const node = () => {
      const n = new THREE.Object3D();
      n.matrixAutoUpdate = false;
      this.root.add(n);
      return n;
    };
    for (const w of this.wells) {
      const { tile, pad } = w;
      const id = tile.hex.id;
      const x = tile.hex.x + pad.x, z = tile.hex.z + pad.z;
      // (A forest's sweep a size larger, to stand out in its clearing among the trees.)
      w.scale = pad.gin ? GIN_SCALE : tile.shape.terrain === 'forest' ? WELL_SCALE * 1.15 : WELL_SCALE;
      w.frame.compose(_v.set(x, pad.y - 0.002, z), _q.setFromAxisAngle(Y, -pad.angle), _s.setScalar(w.scale));
      // Still parts, in the tile's own frame (x and z from its middle), into the one mesh.
      local.compose(_v.set(pad.x, pad.y - 0.002, pad.z), _q, _s);
      still.push({ geo: (pad.gin ? ginBase : sweepBase).clone().applyMatrix4(local), hex: tile.hex });
      w.anchor.position.set(x, pad.y, z);
      this.root.add(w.anchor);
      const rel = (p: THREE.Vector3) => p.clone().applyMatrix4(w.frame).sub(w.anchor.position);
      if (pad.gin) {
        w.lamps.push(this.ctx.lamps.add(w.anchor, rel(LANTERNS[0]), { color: LANTERN, distance: 0.55, strength: 0.75, pool: 0.2 }));
        w.lamps.push(this.ctx.lamps.add(w.anchor, rel(HEARTH.clone().setY(0.014)), { color: CAULDRON_FIRE, distance: 0.35, strength: 0.7, day: 0.1, flicker: 0.2, pool: 0.2 }));
        const b = new MeshBuilder();
        for (const at of LANTERNS) b.addGeometry(geo.glass, _m.multiplyMatrices(w.frame, _l.makeTranslation(at.x, at.y, at.z)), WHITE);
        b.addGeometry(geo.flame, _m.multiplyMatrices(w.frame, _l.makeTranslation(HEARTH.x, 0.003, HEARTH.z)), WHITE);
        const litGeo = b.build(false);
        this.disposables.push(litGeo);
        w.lit = new THREE.Mesh(litGeo, fireMaterial(effects));
        w.lit.layers.set(DETAIL_LAYER);
        this.root.add(w.lit);
        w.gin = { capstan: node(), donkey: node(), wheel: node(), buckets: [node(), node()], ropes: [node(), node()], smoke: Math.random() };
        this.parts.add(geo.capstan, w.gin.capstan, id, true);
        this.parts.add(geo.donkey, w.gin.donkey, id, true);
        this.parts.add(geo.wheel, w.gin.wheel, id);
        for (let i = 0; i < 2; i++) {
          this.parts.add(geo.ginBucket, w.gin.buckets[i], id);
          this.parts.add(geo.rope, w.gin.ropes[i], id);
        }
        // Oil spilt by the shaft, and standing in the trough.
        slick.pool(w, GIN.shaft.x - 0.026, GIN.shaft.z - 0.036, 0.022, id * 3);
        slick.rect(w, GIN.shaft.x - 0.019, GIN.shaft.x + 0.019, GIN.shaft.z - 0.038, GIN.shaft.z - 0.030, 0.007);
        w.phase = (id * 0.37) % 1;
      } else {
        w.sweep = { pole: node(), bucket: node() };
        this.parts.add(geo.pole, w.sweep.pole, id, true);
        this.parts.add(geo.bucket, w.sweep.bucket, id);
        // The oil in the pit, and a seep spreading from beside it.
        slick.disc(w, SWEEP.pit.x, SWEEP.pit.z, 0.0146, 0.005);
        slick.pool(w, SWEEP.pit.x + 0.026, SWEEP.pit.z - 0.016, 0.026, id * 3);
      }
    }
    sweepBase.dispose();
    ginBase.dispose();
    const mesh = stillProps(effects, still, this.disposables);
    still.forEach((p) => p.geo.dispose());
    if (mesh) this.root.add(mesh);
    const oil = slick.build();
    this.disposables.push(oil);
    const pools = new THREE.Mesh(oil, oilMaterial(effects));
    pools.receiveShadow = true;
    pools.layers.set(DETAIL_LAYER);
    this.root.add(pools);
    this.update(0, 0);
  }

  update(dt: number, t = 0) {
    const fx = this.ctx.effects;
    const flame = stokeFire(fx, t);
    for (const w of this.wells) {
      const id = w.tile.hex.id;
      // (Lanterns and the fire out while the tile is still under the sea.)
      const up = (fx.riseValues[id] ?? 0) > -0.05;
      w.lamps.forEach((l, i) => (l.gain = up ? (i === 1 ? flame : 1) : 0));
      if (w.lit) w.lit.visible = up;
      w.boost = Math.max(0, w.boost - dt * 0.18);
      this.spurt(w, dt);
      const slow = fx.get(id).y > 0.5 ? 0.35 : 1;
      if (w.sweep) this.swing(w, w.sweep, dt, slow);
      else if (w.gin) this.wind(w, w.gin, dt, slow, up);
    }
  }

  /** The sweep: the pole rocks on its pin, the bucket on its rope dipping into the pit and coming up dripping. */
  private swing(w: Well, sw: Sweep, dt: number, slow: number) {
    w.phase += dt * 1.7 * (1 + w.boost * 2.2) * slow;
    const theta = sweepAngle(w.phase);
    _l.compose(PIVOT, _q.setFromAxisAngle(Z, theta), ONE);
    pose(sw.pole, _m.multiplyMatrices(w.frame, _l));
    _tip.set(PIVOT.x + Math.cos(theta) * LONG, PIVOT.y + Math.sin(theta) * LONG, 0);
    pose(sw.bucket, _m.multiplyMatrices(w.frame, _l.makeTranslation(_tip.x, _tip.y, 0)));
    // Drips off the bucket as it comes up out of the pit.
    if (Math.cos(w.phase) > 0 && _tip.y > 0.05 && (w.drip -= dt) <= 0) {
      w.drip = 0.1 + Math.random() * 0.12;
      const at = _v.set(_tip.x + (Math.random() - 0.5) * 0.006, _tip.y - ROPE - 0.017, (Math.random() - 0.5) * 0.006).applyMatrix4(w.frame);
      this.ctx.particles.spray.emit({ x: at.x, y: at.y, z: at.z, vx: 0, vy: -0.05, vz: 0, life: 0.5, size: 0.006, gravity: 1.5, color: '#16110d' });
    }
  }

  /** The gin: the donkey walks its circle (turning about at the end of each lap), the capstan turns with it, the wheel spins, one bucket comes up as the other goes down. */
  private wind(w: Well, g: Gin, dt: number, slow: number, up: boolean) {
    w.phase = (w.phase + (dt / GIN_ROUND) * (1 + w.boost * 1.5) * slow) % 1;
    const p = ginPose(w.phase);
    const { x: cx, z: cz } = GIN.capstan;
    _l.compose(_v.set(cx, 0, cz), _q.setFromAxisAngle(Y, -p.turn), ONE);
    pose(g.capstan, _m.multiplyMatrices(w.frame, _l));
    // The donkey: its collar at the arm's end, its body trailing (and swinging round as it turns about).
    const lag = (0.0155 * DONKEY) / GIN.track;
    const a = p.turn - p.dir * lag * (1 - 2 * p.about);
    const heading = p.turn + p.dir * Math.PI * 0.5 + p.about * Math.PI;
    const bob = p.walking ? Math.abs(Math.sin(w.phase * 260)) * 0.0012 : 0;
    _l.compose(_v.set(cx + Math.cos(a) * GIN.track, bob, cz + Math.sin(a) * GIN.track), _q.setFromAxisAngle(Y, -heading), _s.setScalar(DONKEY));
    pose(g.donkey, _m.multiplyMatrices(w.frame, _l));
    const rise = BUCKET_UP - BUCKET_DEEP;
    _l.compose(_v.set(GIN.shaft.x, WHEEL_Y, GIN.shaft.z), _q.setFromAxisAngle(Z, (p.s * rise) / WHEEL_R), ONE);
    pose(g.wheel, _m.multiplyMatrices(w.frame, _l));
    for (let i = 0; i < 2; i++) {
      const h = BUCKET_DEEP + rise * (i === 0 ? p.s : 1 - p.s);
      pose(g.buckets[i], _m.multiplyMatrices(w.frame, _l.makeTranslation(ROPE_X[i], h, GIN.shaft.z)));
      _l.compose(_v.set(ROPE_X[i], h, GIN.shaft.z), _q.identity(), _s.set(1, WHEEL_Y - h, 1));
      pose(g.ropes[i], _m.multiplyMatrices(w.frame, _l));
    }
    // Pitch smoke from the cauldron: brown-grey, thinning as it climbs.
    if (up && (g.smoke -= dt) <= 0) {
      g.smoke = 0.45 + Math.random() * 0.35;
      const at = _v.set(HEARTH.x, 0.034, HEARTH.z).applyMatrix4(w.frame);
      this.ctx.particles.smoke.emit({ x: at.x, y: at.y, z: at.z, vx: (Math.random() - 0.5) * 0.02, vy: 0.08 + Math.random() * 0.04, vz: (Math.random() - 0.5) * 0.02, life: 3 + Math.random(), size: 0.02, grow: 4.5, color: '#6a625a', alpha: 0.3, drag: 0.25, fadeIn: 0.15 });
    }
  }

  /** Oil welling up while a yield's spurt lasts: out of the sweep's pit, or high out of the gin's shaft. */
  private spurt(w: Well, dt: number) {
    if (w.gush <= 0) return;
    w.gush -= dt;
    const gin = w.pad.gin;
    const at = gin ? _v.set(GIN.shaft.x, 0.016, GIN.shaft.z).applyMatrix4(w.frame) : _v.set(SWEEP.pit.x, 0.01, SWEEP.pit.z).applyMatrix4(w.frame);
    // (Whole droplets per frame, carrying the fraction over so slow frames don't lose them.)
    w.carry += dt * (gin ? 90 : 50);
    const n = Math.floor(w.carry);
    w.carry -= n;
    const { spray, smoke } = this.ctx.particles;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = Math.random() * (gin ? 0.16 : 0.1);
      spray.emit({ x: at.x, y: at.y, z: at.z, vx: Math.cos(a) * out, vy: (gin ? 0.55 : 0.35) + Math.random() * (gin ? 0.45 : 0.25), vz: Math.sin(a) * out, life: 0.9 + Math.random() * 0.6, size: gin ? 0.016 : 0.012, gravity: 1.5, color: '#16110d' });
    }
    // A dark plume over the shaft, a puff over the pit.
    if (Math.random() < dt * (gin ? 10 : 5)) smoke.emit({ x: at.x, y: at.y + (gin ? 0.03 : 0), z: at.z, vx: (Math.random() - 0.5) * 0.04, vy: gin ? 0.22 : 0.1, vz: (Math.random() - 0.5) * 0.04, life: 2.2, size: gin ? 0.03 : 0.02, grow: 3.5, color: '#2a241f', alpha: 0.5, drag: 0.35, fadeIn: 0.1 });
  }

  produce(hex: number) {
    for (const w of this.wells) {
      if (w.tile.hex.id !== hex) continue;
      // (A yield comes as two calls, the land's own and the oil: one spurt for both.)
      if (w.gush <= 0) w.gush = w.pad.gin ? 2.2 : 1.2;
      w.boost = 1;
    }
  }

  dispose() {
    this.root.removeFromParent();
    release(this.root);
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.parts.dispose();
    this.wells = [];
  }
}

/**
 * The oil's geometry: a ragged seep per well lying on the ground, the oil in a sweep's pit and in
 * a gin's trough, with the tile it's on (so it rises with the island).
 */
class SlickBuilder {
  private pos: number[] = [];
  private tile: number[] = [];
  private idx: number[] = [];

  private vertex(x: number, y: number, z: number, tile: number) {
    this.pos.push(x, y, z);
    this.tile.push(tile);
    return this.tile.length - 1;
  }

  /** A fan round a centre, its rim at `ring(a)` (in the well's own units), each point at height `y(px, pz)`. */
  private fan(w: Well, lx: number, lz: number, ly: number | null, n: number, ring: (a: number) => number) {
    const id = w.tile.hex.id, hx = w.tile.hex.x, hz = w.tile.hex.z;
    // (A seep lies on the ground, which may fall away a little past the pad's level middle.)
    const at = (x: number, z: number) => {
      _v.set(x, ly ?? 0, z).applyMatrix4(w.frame);
      return this.vertex(_v.x, ly === null ? w.tile.shape.height(_v.x - hx, _v.z - hz) + 0.0015 : _v.y, _v.z, id);
    };
    const mid = at(lx, lz);
    const rim: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, r = ring(a);
      rim.push(at(lx + Math.cos(a) * r, lz + Math.sin(a) * r));
    }
    // (Wound to face up: the frame turns but never mirrors.)
    for (let k = 0; k < n; k++) this.idx.push(mid, rim[(k + 1) % n], rim[k]);
  }

  /** A ragged seep round (lx, lz), about r across (in the well's units). */
  pool(w: Well, lx: number, lz: number, r: number, seed: number) {
    const rnd = new Rand(seed);
    const lobes = [rnd.range(0, 6), rnd.range(0, 6), rnd.range(0, 6)];
    this.fan(w, lx, lz, null, 18, (a) => r * (0.75 + 0.18 * Math.sin(a * 2 + lobes[0]) + 0.12 * Math.sin(a * 3 + lobes[1]) + 0.08 * Math.sin(a * 5 + lobes[2])));
  }

  /** A level disc of oil (in a pit) at height ly. */
  disc(w: Well, lx: number, lz: number, r: number, ly: number) {
    this.fan(w, lx, lz, ly, 16, () => r);
  }

  /** A level rectangle of oil (in a trough) at height ly. */
  rect(w: Well, x0: number, x1: number, z0: number, z1: number, ly: number) {
    const id = w.tile.hex.id;
    const c = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => {
      _v.set(x, ly, z).applyMatrix4(w.frame);
      return this.vertex(_v.x, _v.y, _v.z, id);
    });
    this.idx.push(c[0], c[2], c[1], c[0], c[3], c[2]);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(this.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('tile', new THREE.Float32BufferAttribute(this.tile, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
