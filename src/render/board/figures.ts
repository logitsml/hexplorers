// The expansions' figures: the wardens' posts (three ranks, mustered or resting), raiders and
// their camp, and the guilds' trader at his stall. Units and conventions are the kit's (kit.ts).
//
// Nothing here stands on a plinth. The base island is a diorama (houses are buildings, and its
// people, the travellers and the folk, are a quarter of a cottage tall), so a warden is a *post*
// in that world rather than a miniature: people at the folk's size round the thing that says
// what rank it holds (a striped sentry box, a wall of shields, a round pavilion), on a patch of
// trodden earth, under a standard wide enough to read as a flag from across the island. What
// carries the owner's colour is big and faces the sky: the standard's cloth, the box's roof, the
// propped shields, the pavilion's cone.

import * as THREE from 'three/webgpu';
import type { PlayerColor } from '../../engine';
import { compose, smoothSphere } from './geom';
import { PLAYER_PALETTE, box } from './pieces';
import { SURFACE } from './surfaces';
import { C, Kit, shown, v3, barrel, streamer, type Paint } from './kit';

/** Skin tones as they should look (the travellers' are tuned for figures a third the size). */
export const SKIN = ['#e2b28c', '#b98258', '#7a4c32', '#ecc4a2'].map((c) => `#${shown(c).getHexString()}`);
const IRON = '#9c9a96';
const IRON_DARK = '#66635f';
const LEATHER = '#5e4128';
const WOOD = '#4a3322';
const EARTH = shown('#6a5238');
const EARTH_DARK = shown('#3e2e20');
/** Towards what the ground mostly is round a post, so the patch's edge doesn't cut. */
const RIM = shown('#6e6a3a');
const CREAM = C('#efe6d2');

/**
 * The posts' people are built at the miniatures' proportions (`figure` below, which the wagon's
 * driver shares) and shrunk to the folk's size: a traveller is 0.04 tall at the life's 2.1
 * scale, and a figure here 0.066 unshrunk, placed at marks.ts's FIGURE (about 2.1).
 */
const P = 0.62;

type Helm = 'kettle' | 'great' | 'crested' | 'nasal' | 'bare' | 'coif';

interface Figure {
  /** Placement within the model, as a matrix (feet at its origin, facing +x). */
  at: THREE.Matrix4;
  body: THREE.Color;
  trim: THREE.Color;
  legs: string | THREE.Color;
  skin: string;
  helm: Helm;
  /** Mail under the body colour (a surcoat over a hauberk): iron at the hem, the collar and the shoulders. */
  mail?: boolean;
  /** Sitting on the ground, knees up (a warden at rest). */
  seated?: boolean;
  /** A fur cloak over the shoulders, hanging long down one side (raiders). */
  cloak?: THREE.Color;
  /** Legs astride (a rider). */
  astride?: boolean;
}

/**
 * A small person: a tunic lathed with a skirt, a waist and squared shoulders (not a cone), the
 * head seated in its helm, boots. Feet at the origin, facing +x; the hip at 0.026, the shoulders
 * at 0.048 and the head at 0.059 when standing, which `arm` and the wagon's driver rely on.
 */
export function figure(k: Kit, f: Figure) {
  const M = f.at;
  const put = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: Paint) => k.add(g, M.clone().multiply(m), c);
  const hip = f.seated ? 0.007 : f.astride ? 0.0 : 0.026;
  const boot = '#3a2a1e';
  if (f.seated) {
    // Thighs forward along the ground, shins bent up to the knees and down to the feet.
    for (const s of [-1, 1]) {
      put(new THREE.CylinderGeometry(0.0046, 0.005, 0.018, 7), compose(0.009, 0.006, s * 0.0048, 0, 0, Math.PI / 2 - 0.25), f.legs);
      put(new THREE.CylinderGeometry(0.004, 0.0044, 0.016, 7), compose(0.021, 0.009, s * 0.005, 0, 0, -0.45), f.legs);
      put(new THREE.BoxGeometry(0.009, 0.0042, 0.0056), compose(0.025, 0.002, s * 0.005), boot);
    }
  } else if (f.astride) {
    for (const s of [-1, 1]) {
      put(new THREE.CylinderGeometry(0.0046, 0.0038, 0.022, 7), compose(0.004, -0.006, s * 0.0105, s * 0.35, 0, -0.35), f.legs);
      put(new THREE.BoxGeometry(0.008, 0.0036, 0.005), compose(0.009, -0.0165, s * 0.0135, s * 0.35, 0, 0), boot);
    }
  } else {
    // A little apart, one foot a touch forward, so the stance isn't a pair of pegs.
    for (const s of [-1, 1]) {
      put(new THREE.CylinderGeometry(0.0046, 0.0042, 0.025, 7), compose(s * 0.0008, 0.0135, s * 0.005, 0, 0, s * 0.04), f.legs);
      put(new THREE.BoxGeometry(0.0095, 0.0042, 0.0058), compose(0.002 + s * 0.0008, 0.0021, s * 0.005), boot);
    }
  }
  // The body: a lathe from the skirt's hem up through the waist to the shoulders and the neck,
  // narrowed front to back and squared across the shoulders, so it reads as a torso from any side.
  const prof: [number, number][] = [[0.0102, 0], [0.0098, 0.0035], [0.0082, 0.0095], [0.0076, 0.0135], [0.0084, 0.0185], [0.0094, 0.0222], [0.0092, 0.0248], [0.0066, 0.0266], [0.0038, 0.0278], [0, 0.0284]];
  const lathe = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 14);
  const lp = lathe.getAttribute('position');
  for (let i = 0; i < lp.count; i++) {
    const x = lp.getX(i), y = lp.getY(i), z = lp.getZ(i);
    const r = Math.hypot(x, z) || 1;
    const across = Math.abs(z) / r;
    const square = y > 0.017 ? 1 + 0.2 * across : 1 + 0.05 * across;
    lp.setXYZ(i, x * 0.8 * square, y, z * square);
  }
  lathe.computeVertexNormals();
  const collar = f.mail ? C(IRON) : f.trim;
  const bodyM = M.clone().multiply(compose(0, hip, 0)), bodyInv = bodyM.clone().invert();
  k.add(lathe, bodyM, (x, y, z, o) => {
    const ly = new THREE.Vector3(x, y, z).applyMatrix4(bodyInv).y;
    o.copy(ly > 0.0255 ? collar : f.mail && ly < 0.0028 ? C(IRON) : f.body);
  });
  put(new THREE.CylinderGeometry(0.0084, 0.0086, 0.0024, 12).scale(0.84, 1, 1.03), compose(0, hip + 0.0105, 0), LEATHER);
  // Shoulders (pauldrons on mail), rounded, so an arm's socket never shows a gap.
  for (const s of [-1, 1]) put(smoothSphere(0.0038, 1), compose(0, hip + 0.0232, s * 0.0086), f.mail ? IRON : f.body);
  if (f.cloak) cloak(k, M, hip, f.cloak);
  // Head and helm: the helm sits over the head, down to the brow (or the whole face, for a great helm).
  const hy = hip + 0.033;
  put(smoothSphere(0.0068, 1), compose(0.0006, hy, 0), f.skin);
  put(smoothSphere(0.0013, 0), compose(0.0068, hy - 0.0006, 0), f.skin);
  switch (f.helm) {
    case 'kettle':
      put(new THREE.SphereGeometry(0.0074, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), compose(0.0006, hy + 0.001, 0), IRON);
      put(new THREE.CylinderGeometry(0.0108, 0.0112, 0.0012, 14), compose(0.0006, hy + 0.0014, 0), IRON_DARK);
      break;
    case 'great':
      put(new THREE.CylinderGeometry(0.0076, 0.0074, 0.0136, 12), compose(0.0006, hy + 0.0008, 0), IRON);
      put(new THREE.CylinderGeometry(0.0076, 0.0076, 0.001, 12), compose(0.0006, hy + 0.0078, 0), IRON_DARK);
      put(new THREE.BoxGeometry(0.0015, 0.0014, 0.0098), compose(0.0076, hy + 0.0018, 0), '#1a1716');
      put(new THREE.BoxGeometry(0.0014, 0.009, 0.0018), compose(0.0078, hy - 0.0002, 0), f.trim);
      break;
    case 'crested':
      put(new THREE.SphereGeometry(0.0076, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), compose(0.0006, hy + 0.0004, 0), IRON);
      put(new THREE.CylinderGeometry(0.0014, 0.0036, 0.0108, 6).rotateX(Math.PI / 2).rotateY(Math.PI / 2), compose(-0.001, hy + 0.0086, 0, 0, 0, -0.35), f.trim);
      break;
    case 'nasal':
      put(new THREE.ConeGeometry(0.0077, 0.0105, 10), compose(0.0006, hy + 0.0058, 0), IRON_DARK);
      put(new THREE.BoxGeometry(0.0012, 0.0062, 0.0018), compose(0.0076, hy + 0.0002, 0), IRON_DARK);
      put(smoothSphere(0.0054, 1), compose(0.004, hy - 0.0046, 0, 0, 0, 0, 1, 1.2, 1.1), '#6b4a2b');
      break;
    case 'coif':
      // Mail over the head and down to the shoulders, the face open.
      put(new THREE.SphereGeometry(0.0074, 12, 7, Math.PI * 0.3, Math.PI * 1.4), compose(0.0006, hy + 0.0002, 0, 0, Math.PI / 2, 0), IRON);
      put(new THREE.CylinderGeometry(0.0062, 0.0088, 0.006, 12, 1, true), compose(0, hy - 0.0062, 0), IRON);
      break;
    case 'bare':
      put(new THREE.SphereGeometry(0.0071, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), compose(-0.0004, hy + 0.0006, 0, 0, 0, 0.35), '#4a3424');
      break;
  }
}

/**
 * A fur cloak: a sheet hung from the shoulders down the back, longer on the left than the right
 * and ragged at the hem, under a thick fur collar. (In the figure's frame.)
 */
function cloak(k: Kit, M: THREE.Matrix4, hip: number, fur: THREE.Color) {
  const light = fur.clone().lerp(CREAM, 0.3);
  const top = hip + 0.0255;
  const at = (u: number, v: number) => {
    const drop = (0.016 + 0.014 * (1 - u) + 0.0025 * Math.abs(Math.sin(u * Math.PI * 4))) * v;
    const flare = 1 + v * 0.9;
    return v3(-0.0045 - v * 0.008 + Math.sin(u * 7 + v * 3) * 0.0008, top - drop, (u - 0.5) * 0.022 * flare).applyMatrix4(M);
  };
  k.swaying(0, 0.03, 0.25, () => k.cloth(6, 4, at, (u, v) => (v > 0.82 ? light : fur).clone().lerp(C('#1a1410'), 0.25 * Math.abs(Math.sin(u * 11))), 0.0012), 'x');
  k.add(new THREE.TorusGeometry(0.0078, 0.0032, 6, 12).rotateX(Math.PI / 2).scale(0.9, 0.8, 1.05), M.clone().multiply(compose(-0.001, hip + 0.0245, 0)), light);
}

/**
 * An arm from the shoulder to the hand (in the figure's frame), bent at the elbow: the elbow
 * sits `bend` off the straight line (out and back by default). Returns where the hand is.
 */
function arm(k: Kit, M: THREE.Matrix4, shoulder: THREE.Vector3, hand: THREE.Vector3, sleeve: Paint, skin: string, bend = v3(-0.004, -0.001, 0)) {
  const s = M.getMaxScaleOnAxis();
  const out = Math.sign(shoulder.z || 1);
  const elbow = shoulder.clone().lerp(hand, 0.5).add(bend).add(v3(0, 0, out * 0.0025));
  const a = shoulder.clone().applyMatrix4(M), e = elbow.applyMatrix4(M), b = hand.clone().applyMatrix4(M);
  k.rod(a, e, 0.0036 * s, sleeve, 6);
  k.add(smoothSphere(0.0032 * s, 0), new THREE.Matrix4().makeTranslation(e.x, e.y, e.z), sleeve);
  k.rod(e, b, 0.0032 * s, sleeve, 6);
  k.add(smoothSphere(0.003 * s, 0), new THREE.Matrix4().makeTranslation(b.x, b.y, b.z), skin);
  return b;
}

/**
 * Trodden earth where a post stands: a thin, ragged patch of bare ground, darker where the
 * feet and the fire are, that lies on the grass rather than standing up out of it as a plinth.
 */
function patch(k: Kit, r: number, x = 0, z = 0, seed = 1) {
  const b = k.b;
  const tone = (px: number, pz: number, t: number) => {
    // (Mottled by a hash of the spot, darkest at the middle, and towards the grass at the rim.)
    const h = Math.sin(px * 311 + pz * 197 + seed) * 0.5 + 0.5;
    return EARTH.clone().lerp(EARTH_DARK, (1 - t) * 0.7 + h * 0.3).lerp(RIM, t * t * 0.5);
  };
  const centre = b.vertex(x, 0.0012, z, tone(x, z, 0));
  const rings: number[][] = [];
  for (const [ring, n, f] of [[0, 12, 0.5], [1, 24, 1]] as const) {
    const row: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = r * f * (1 + (ring ? 0.16 * Math.sin(a * 3 + seed) + 0.1 * Math.sin(a * 7 + seed * 2.3) : 0.06 * Math.sin(a * 5 + seed)));
      row.push(b.vertex(x + Math.cos(a) * w, 0.0012, z + Math.sin(a) * w, tone(x + Math.cos(a) * w, z + Math.sin(a) * w, f)));
    }
    rings.push(row);
  }
  // (Wound to face up: the fan goes round against the clock seen from above, +z towards the viewer.)
  for (let i = 0; i < 12; i++) b.tri(centre, rings[0][(i + 1) % 12], rings[0][i]);
  for (let i = 0; i < 24; i++) {
    const a = rings[1][i], c = rings[1][(i + 1) % 24], inner = rings[0][Math.floor(i / 2)], next = rings[0][(Math.floor(i / 2) + 1) % 12];
    b.tri(a, next, inner);
    b.tri(a, c, next);
  }
}

/**
 * A standard: a tall pole with a wide gonfanon hung from a crossbar, the owner's colour edged
 * in its trim with a chevron charge, so that from across the island it is a flag, not a stick.
 * Raised and flying when the warden is mustered; furled and leaning on a forked stand when not.
 */
function standard(k: Kit, x: number, z: number, cloth: THREE.Color, trim: THREE.Color, raised: boolean) {
  if (raised) {
    const top = 0.165, W = 0.085, D = 0.066;
    k.rod(v3(x, 0, z), v3(x, top, z), 0.0022, WOOD, 6);
    k.add(new THREE.CylinderGeometry(0.005, 0.0062, 0.007, 8), compose(x, 0.0035, z), IRON_DARK);
    k.add(new THREE.ConeGeometry(0.0026, 0.009, 6), compose(x, top + 0.005, z), '#d8b45a');
    k.rod(v3(x, top - 0.004, z - W / 2 - 0.004), v3(x, top - 0.004, z + W / 2 + 0.004), 0.0012, WOOD, 4);
    for (const s of [-1, 1]) k.add(smoothSphere(0.0022, 0), compose(x, top - 0.004, z + s * (W / 2 + 0.005)), '#d8b45a');
    k.swaying(top - 0.005, 0.05, 0.7, () =>
      // (Hung from the bar, its foot cut into a swallowtail, and billowing a little forward, so
      // a camera high over the island sees its face rather than its edge.)
      k.cloth(8, 7, (u, v) => v3(x + 0.0035 + v * v * 0.018 + Math.sin(u * 4 + v * 3) * 0.0014, top - 0.0055 - v * (D - 0.016 * (1 - Math.abs(2 * u - 1))), z - W / 2 + u * W), (u, v) => {
        // (A narrow border and charge: the field's colour is what reads from afar.)
        const edge = u < 0.05 || u > 0.95 || v < 0.05;
        const chevron = Math.abs(v - 0.4 - Math.abs(u - 0.5) * 0.7) < 0.065;
        return edge || chevron ? trim : cloth;
      }),
    );
    // A long streamer from the head, flying across the gonfanon, so one cloth faces whichever way the camera looks.
    streamer(k, v3(x, top + 0.002, z), 0.06, 0.01, cloth, trim);
  } else {
    // Furled round the pole, which leans on a forked stand, the trim showing in its binding.
    const foot = v3(x + 0.016, 0, z), head = v3(x - 0.036, 0.092, z + 0.004);
    k.rod(foot, head, 0.0022, WOOD, 6);
    k.rod(v3(x - 0.026, 0, z + 0.003), v3(x - 0.024, 0.07, z + 0.004), 0.0016, LEATHER, 4);
    const furl = foot.clone().lerp(head, 0.62), dir = head.clone().sub(foot).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    k.add(new THREE.CylinderGeometry(0.0052, 0.0072, 0.05, 8), new THREE.Matrix4().compose(furl, q, new THREE.Vector3(1, 1, 1)), (_x, y, _z, o) => o.copy(Math.abs(y - furl.y) < 0.005 || Math.abs(y - furl.y - 0.014) < 0.0025 ? trim : cloth));
  }
}

/** A campfire: a ring of stones, crossed logs, and flames that glow (and light the ground at night). */
function campfire(k: Kit, x: number, z: number, s = 1) {
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    k.add(smoothSphere(0.0032 * s, 0), compose(x + Math.cos(a) * 0.0095 * s, 0.0018 * s, z + Math.sin(a) * 0.0095 * s, 0, a, 0, 1.2, 0.8, 1), '#7b766f');
  }
  for (let i = 0; i < 3; i++) k.add(new THREE.CylinderGeometry(0.0016 * s, 0.0016 * s, 0.016 * s, 5), compose(x, 0.003 * s, z, Math.PI / 2 - 0.3, (i * Math.PI) / 3, 0), WOOD);
  k.lit(() => {
    k.add(new THREE.ConeGeometry(0.0055 * s, 0.014 * s, 6), compose(x, 0.009 * s, z), shown('#e0601c'));
    k.add(new THREE.ConeGeometry(0.003 * s, 0.01 * s, 5), compose(x + 0.002 * s, 0.01 * s, z - 0.001 * s), shown('#f0a030'));
  }, 0.9);
}

/** A brazier: an iron basket on three legs with a fire in it, lit at a mustered post all night. */
function brazier(k: Kit, x: number, z: number) {
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    k.rod(v3(x + Math.cos(a) * 0.0075, 0, z + Math.sin(a) * 0.0075), v3(x + Math.cos(a) * 0.004, 0.014, z + Math.sin(a) * 0.004), 0.0009, IRON_DARK, 4);
  }
  k.add(new THREE.CylinderGeometry(0.0068, 0.0046, 0.007, 10, 1, true), compose(x, 0.0165, z), IRON_DARK);
  k.add(new THREE.TorusGeometry(0.0068, 0.0009, 4, 12).rotateX(Math.PI / 2), compose(x, 0.02, z), IRON);
  k.lit(() => {
    k.add(new THREE.ConeGeometry(0.0046, 0.011, 6), compose(x, 0.023, z), shown('#e0601c'));
    k.add(new THREE.ConeGeometry(0.0024, 0.008, 5), compose(x + 0.0015, 0.025, z - 0.001, 0, 0, 0.2), shown('#f0a030'));
  }, 0.9);
}

/** A kite shield facing −z (on a figure's left arm), its field in `field` with a border and chevron in `trim`. */
function kiteShield(k: Kit, m: THREE.Matrix4, field: THREE.Color, trim: THREE.Color, s = 1) {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.009).quadraticCurveTo(0.0075, 0.009, 0.0072, 0.002).quadraticCurveTo(0.006, -0.008, 0, -0.016).quadraticCurveTo(-0.006, -0.008, -0.0072, 0.002).quadraticCurveTo(-0.0075, 0.009, 0, 0.009);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.0018, bevelEnabled: false, curveSegments: 5 });
  // Bowed a little, as a real shield is, and painted: the border and a chevron in the trim.
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + p.getX(i) * p.getX(i) * 18);
  g.scale(s, s, s);
  g.computeVertexNormals();
  const inv = m.clone().invert();
  k.add(g, m, (x, y, z, o) => {
    const l = new THREE.Vector3(x, y, z).applyMatrix4(inv).divideScalar(s);
    const edge = Math.abs(l.x) > 0.0058 - (l.y < 0 ? -l.y * 0.36 : 0) || l.y > 0.0076;
    const chevron = Math.abs(l.y + 0.0015 - Math.abs(l.x) * 0.9) < 0.0017;
    o.copy(edge || chevron ? trim : field);
  });
}

/** How much larger the wardens' horses are drawn than modelled: as big at the withers as the travellers' (see travellers.ts). */
const MOUNT = 1.27;

/** A horse facing +x, hooves at the origin of `M`: caparisoned in a cloth of `cloth` hemmed in `hem`, or plain, grazing if `grazing`. */
function horse(k: Kit, M: THREE.Matrix4, coat: string, mane: string, cloth: THREE.Color | null, hem: THREE.Color, grazing = false) {
  const put = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: Paint) => k.add(g, M.clone().multiply(m), c);
  const barrelG = smoothSphere(0.011, 2);
  barrelG.scale(2.0, 1.0, 0.82);
  put(barrelG, compose(0, 0.031, 0), coat);
  put(smoothSphere(0.0095, 2), compose(0.015, 0.032, 0), coat);
  put(smoothSphere(0.0098, 2), compose(-0.014, 0.033, 0), coat);
  for (const [x, z] of [[0.015, 0.006], [0.015, -0.006], [-0.015, 0.006], [-0.015, -0.006]]) {
    put(new THREE.CylinderGeometry(0.0028, 0.0019, 0.024, 7), compose(x, 0.014, z), coat);
    put(new THREE.CylinderGeometry(0.0021, 0.0025, 0.003, 7), compose(x, 0.0015, z), '#2a201a');
  }
  put(new THREE.ConeGeometry(0.0032, 0.02, 7), compose(-0.026, 0.026, 0, 0, 0, Math.PI - 0.3), mane);
  // Neck and head: raised, or down to the grass.
  const neckA = grazing ? -1.15 : -0.5;
  put(new THREE.CylinderGeometry(0.0042, 0.0068, 0.022, 9), compose(0.023, grazing ? 0.027 : 0.042, 0, 0, 0, neckA), coat);
  put(new THREE.BoxGeometry(0.0018, 0.02, 0.002), compose(0.021, grazing ? 0.029 : 0.044, 0, 0, 0, neckA), mane);
  const head = smoothSphere(0.0052, 1);
  head.scale(1.8, 0.85, 0.8);
  put(head, grazing ? compose(0.034, 0.012, 0, 0, 0, -1.1) : compose(0.033, 0.051, 0, 0, 0, -0.6), coat);
  for (const s of [-1, 1]) put(new THREE.ConeGeometry(0.0013, 0.0045, 5), grazing ? compose(0.03, 0.022, s * 0.002, 0, 0, -0.9) : compose(0.029, 0.058, s * 0.002, s * 0.2, 0, -0.2), coat);
  if (cloth) {
    // The caparison: a skirt of cloth round the body, hemmed, with a saddle on top.
    const skirt = new THREE.CylinderGeometry(0.0118, 0.0142, 0.019, 18, 1, true);
    skirt.scale(2.15, 1, 0.92);
    const inv = M.clone().invert();
    put(skirt, compose(0, 0.028, 0), (x, y, z, o) => o.copy(new THREE.Vector3(x, y, z).applyMatrix4(inv).y < 0.0212 ? hem : cloth));
    put(new THREE.CylinderGeometry(0.0062, 0.0062, 0.004, 12).scale(1.3, 1, 1), compose(-0.002, 0.0415, 0), LEATHER);
  }
}

// ---------------------------------------------------------------------------------------------
// The wardens' posts.
// ---------------------------------------------------------------------------------------------

/** Where a post's fire burns, in model units: the brazier when mustered, the campfire at rest (marks.ts lights it and lets it smoke). */
export const POST_FIRE = { mustered: v3(-0.012, 0.024, -0.034), resting: v3(0.014, 0.01, 0.002) };

/** A person's place in a post: at (x, z), turned to heading `a` (radians from +x towards +z), at the folk's size. */
const person = (x: number, z: number, a = 0, tilt = 0) => compose(x, 0.0008, z, 0, -a, tilt, P);

/** A spear standing in a hand (or on the ground): an ash shaft with an iron head. */
function spear(k: Kit, x: number, z: number, h: number, lean = 0) {
  k.rod(v3(x, 0, z), v3(x - Math.sin(lean) * h, Math.cos(lean) * h, z), 0.0011, '#7a5a3a', 5);
  k.add(new THREE.ConeGeometry(0.0022, 0.01, 6), compose(x - Math.sin(lean) * (h + 0.004), Math.cos(lean) * (h + 0.004), z, 0, 0, lean), IRON);
}

/** A striped sentry box in the owner's colours, its door open to +x, under a pointed roof in the owner's colour edged in the trim. */
function sentryBox(k: Kit, x: number, z: number, base: THREE.Color, light: THREE.Color, trim: THREE.Color) {
  const W = 0.024, D = 0.028, H = 0.046;
  k.add(box(W, H, D, 0.0012), compose(x, H / 2, z), (px, y, pz, o) => o.copy(Math.floor((y * 1.2 + (pz - z) + (px - x) * 0.4) / 0.0085 + 40) % 2 ? light : base));
  k.add(new THREE.BoxGeometry(0.001, H * 0.78, D * 0.62), compose(x + W / 2 + 0.0004, H * 0.44, z), '#1a1410');
  k.add(new THREE.BoxGeometry(W + 0.006, 0.003, D + 0.006), compose(x, 0.0015, z), LEATHER);
  k.add(new THREE.ConeGeometry(Math.hypot(W, D) * 0.66, 0.016, 4), compose(x, H + 0.008, z, 0, Math.PI / 4, 0), base);
  k.add(new THREE.BoxGeometry(W + 0.004, 0.0024, D + 0.004), compose(x, H + 0.0008, z), trim);
  k.add(smoothSphere(0.0024, 1), compose(x, H + 0.0175, z), '#d8b45a');
}

/** A small round pavilion: cream walls with a stripe in the owner's colour, a cone roof in it, a scalloped valance, a pennon. */
function pavilion(k: Kit, x: number, z: number, base: THREE.Color, trim: THREE.Color) {
  const R = 0.031, H = 0.03;
  const wall = CREAM.clone().lerp(base, 0.12);
  k.add(new THREE.CylinderGeometry(R, R * 1.04, H, 16, 1, true, Math.PI / 2 + 0.4, Math.PI * 2 - 0.8), compose(x, H / 2, z), (px, _y, pz, o) => {
    const a = Math.atan2(pz - z, px - x);
    o.copy(Math.floor(a / (Math.PI / 4) + 8) % 2 ? wall : base);
  });
  k.add(new THREE.CircleGeometry(R, 16).rotateX(-Math.PI / 2), compose(x, 0.0008, z), '#5e4128');
  k.lit(() => k.add(new THREE.CylinderGeometry(R * 0.9, R * 0.9, H - 0.004, 10, 1, true, -Math.PI / 2 + 0.6, Math.PI * 2 - 1.2), compose(x, H / 2, z), '#ffcf7a'), 0.4);
  k.surface(SURFACE.canvas, () => k.add(new THREE.ConeGeometry(R * 1.28, 0.036, 16, 1), compose(x, H + 0.0175, z), base));
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * Math.PI * 2;
    k.add(new THREE.ConeGeometry(0.0042, 0.006, 4).rotateX(Math.PI), compose(x + Math.cos(t) * R * 1.24, H - 0.002, z + Math.sin(t) * R * 1.24, 0, -t, 0), i % 2 ? base : trim);
  }
  for (const sgn of [-1, 1]) k.add(new THREE.BoxGeometry(0.003, H - 0.004, 0.008), compose(x + R * 0.98, H / 2 - 0.001, z + sgn * R * 0.42, 0, sgn * 0.5, 0), trim);
  k.rod(v3(x, H + 0.034, z), v3(x, H + 0.048, z), 0.0009, WOOD, 4);
  k.add(smoothSphere(0.0016, 1), compose(x, H + 0.049, z), '#d8b45a');
  k.swaying(x, 0.02, 1, () => k.cloth(5, 1, (u, v) => v3(x + u * 0.02, H + 0.046 - v * 0.006 * (1 - u * 0.6), z + Math.sin(u * 6) * 0.001), () => trim), 'x');
}

/** Three kite shields propped in a row facing +x, leaning back on stakes: a shield wall in the owner's colours. */
function shieldWall(k: Kit, x: number, z: number, field: THREE.Color, trim: THREE.Color) {
  const lean = 0.5;
  for (const dz of [-0.021, 0, 0.021]) {
    kiteShield(k, compose(x, 0.0205 * Math.cos(lean), z + dz, lean, -Math.PI / 2, 0), field, trim, 1.45);
    k.rod(v3(x - 0.016, 0, z + dz), v3(x - 0.004, 0.024, z + dz), 0.0012, WOOD, 4);
  }
}

/**
 * A warden's post in its owner's colour: at rank 1 a pair of spearmen by a striped sentry box,
 * at rank 2 men-at-arms behind a wall of shields, at rank 3 a mounted knight before a round
 * pavilion, each on a patch of trodden earth under a standard. Mustered, the standard flies,
 * the people stand in a line facing out and a brazier burns; at rest the standard is furled
 * and they sit round a fire with their helms off, so the two read apart from across the island
 * (a wide flag in the owner's colour, or a low huddle and a glow).
 */
export function makeWarden(color: PlayerColor, rank: 1 | 2 | 3, mustered: boolean): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const k = new Kit();
  const body = C(pal.base), trim = C(pal.trim), light = C(pal.light);
  const skins = [SKIN[(rank + 1) % 4], SKIN[rank % 4], SKIN[(rank + 2) % 4]];
  const legs = rank === 1 ? '#5a4636' : IRON;
  const sleeves = rank === 1 ? body : C(IRON);
  patch(k, rank === 1 ? 0.046 : rank === 2 ? 0.052 : 0.062, 0.002, 0, rank);
  if (rank === 1) sentryBox(k, -0.006, 0.03, body, light, trim);
  if (rank === 2) shieldWall(k, 0.022, 0, body, trim);
  if (rank === 3) pavilion(k, -0.016, 0.028, body, trim);
  if (mustered) {
    brazier(k, POST_FIRE.mustered.x, POST_FIRE.mustered.z);
    standard(k, rank === 3 ? -0.032 : -0.022, rank === 3 ? -0.03 : -0.004, body, trim, true);
    if (rank === 1) {
      for (const [i, z] of [-0.013, 0.012].entries()) {
        const M = person(0.012, z, 0, 0);
        figure(k, { at: M, body, trim, legs, skin: skins[i], helm: 'kettle' });
        const hand = arm(k, M, v3(0, 0.048, 0.0085), v3(0.006, 0.034, 0.012), sleeves, skins[i]);
        arm(k, M, v3(0, 0.048, -0.0085), v3(0.003, 0.03, -0.0105), sleeves, skins[i]);
        spear(k, hand.x, hand.z, 0.062);
      }
    } else if (rank === 2) {
      for (const [i, z] of [-0.021, 0, 0.021].entries()) {
        const M = person(0.004, z, 0, 0);
        figure(k, { at: M, body, trim, legs, skin: skins[i], helm: 'great', mail: true });
        const hand = arm(k, M, v3(0, 0.048, 0.0085), v3(0.007, 0.036, 0.012), sleeves, skins[i]);
        arm(k, M, v3(0, 0.048, -0.0085), v3(0.004, 0.034, -0.011), sleeves, skins[i]);
        if (i === 1) spear(k, hand.x, hand.z, 0.064);
        else {
          // A sword held upright at the shoulder.
          k.rod(v3(hand.x, hand.y - 0.002, hand.z), v3(hand.x + 0.004, hand.y + 0.02, hand.z), 0.0009, '#cfd2d4', 4);
          k.add(new THREE.BoxGeometry(0.0014, 0.0014, 0.007), compose(hand.x, hand.y, hand.z), IRON_DARK);
        }
      }
    } else {
      const H = person(0.014, -0.022, 0, 0);
      // (The charger as big as the horses on the roads, which is a little bigger than its model:
      // the rider sits that much higher, and the lance rises with them.)
      horse(k, H.clone().multiply(compose(0, 0, 0, 0, 0, 0, MOUNT)), '#4b3426', '#1d1510', body, trim);
      const M = H.clone().multiply(compose(-0.002 * MOUNT, 0.043 * MOUNT, 0));
      const up = 0.043 * (MOUNT - 1);
      figure(k, { at: M, body, trim, legs, skin: skins[0], helm: 'crested', mail: true, astride: true });
      arm(k, M, v3(0, 0.022, -0.008), v3(0.009, 0.013, -0.01), sleeves, skins[0]);
      // The lance held upright, a pennon at its head.
      const hand = arm(k, M, v3(0, 0.022, 0.008), v3(0.007, 0.015, 0.012), sleeves, skins[0]);
      k.rod(v3(hand.x, hand.y - 0.012, hand.z), v3(hand.x, 0.096 + up, hand.z), 0.0012, '#d8cbb0', 6);
      k.add(new THREE.ConeGeometry(0.002, 0.008, 6), compose(hand.x, 0.1 + up, hand.z), IRON);
      k.swaying(hand.x, 0.02, 1, () => k.cloth(5, 1, (u, v) => v3(hand.x + u * 0.018, 0.093 + up - v * 0.006 * (1 - u * 0.5), hand.z + Math.sin(u * 5) * 0.001), (u) => (u < 0.15 ? trim : body)), 'x');
      // A squire on foot at the standard.
      const S = person(-0.016, -0.042, 0.3, 0);
      figure(k, { at: S, body: light, trim, legs: '#5a4636', skin: skins[1], helm: 'bare' });
      arm(k, S, v3(0, 0.048, 0.0085), v3(0.004, 0.034, 0.012), light, skins[1]);
      arm(k, S, v3(0, 0.048, -0.0085), v3(-0.006, 0.05, -0.014), light, skins[1], v3(-0.006, 0.004, 0));
    }
  } else {
    const F = POST_FIRE.resting;
    campfire(k, F.x, F.z, 0.8);
    standard(k, rank === 3 ? -0.03 : -0.024, rank === 3 ? -0.026 : -0.006, body, trim, false);
    // Seated round the fire, facing it, helms off and laid by.
    const seats = rank === 1 ? [Math.PI - 0.55, Math.PI + 0.55] : [Math.PI - 0.7, Math.PI, Math.PI + 0.7];
    const n = rank === 3 ? 1 : seats.length;
    for (let i = 0; i < n; i++) {
      const a = seats[i];
      const M = person(F.x + Math.cos(a) * 0.027, F.z + Math.sin(a) * 0.027, a + Math.PI, 0);
      figure(k, { at: M, body, trim, legs, skin: skins[i], helm: rank === 1 ? 'bare' : 'coif', mail: rank > 1, seated: true });
      for (const s of [-1, 1]) arm(k, M, v3(0, 0.03, s * 0.0085), v3(0.016, 0.018, s * 0.007), sleeves, skins[i], v3(-0.003, -0.002, 0));
    }
    if (rank === 1) {
      k.add(new THREE.CylinderGeometry(0.0068, 0.0068, 0.0008, 12), compose(-0.012, 0.0022, -0.02), IRON_DARK);
      k.add(new THREE.SphereGeometry(0.0046, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), compose(-0.012, 0.0024, -0.02), IRON);
      spear(k, -0.02, -0.024, 0.06, 0.35);
    }
    if (rank === 2) {
      k.add(new THREE.CylinderGeometry(0.0048, 0.0046, 0.0086, 10), compose(-0.014, 0.0045, -0.022, 0.25, 0, 0.2), IRON);
      kiteShield(k, compose(-0.02, 0.0082, -0.03, -1.2, 0.9, 0), body, trim, 1.1);
    }
    if (rank === 3) {
      // The horse grazing by the pavilion, its saddle off, and the knight's crested helm by the fire.
      horse(k, person(0.034, -0.03, 0.9, 0).multiply(compose(0, 0, 0, 0, 0, 0, MOUNT)), '#4b3426', '#1d1510', body, trim, true);
      k.add(new THREE.SphereGeometry(0.0046, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.62), compose(-0.006, 0.0022, -0.02, 0.3, 0, 0), IRON);
    }
  }
  return k.build();
}

// ---------------------------------------------------------------------------------------------
// Raiders and their camp.
// ---------------------------------------------------------------------------------------------

const RAID_RED = shown('#8e2a20');
const FUR = shown('#5e2e22');
const HIDE = ['#8a6a4a', '#6e5238'];

/** Where the camp's fire burns, in model units. */
export const CAMP_FIRE = v3(-0.012, 0.012, 0.002);

/** A raider: a hunched figure at the folk's size in a fur cloak and a nosed helm, round shield up and axe raised. */
export function makeRaider(): THREE.BufferGeometry {
  const k = new Kit();
  const leather = shown('#5e4a3a'), skin = SKIN[3];
  const M = person(0, 0, 0, 0.16);
  figure(k, { at: M, body: leather, trim: RAID_RED, legs: shown('#4a3c32'), skin, helm: 'nasal', cloak: FUR });
  const hand = arm(k, M, v3(0, 0.048, 0.0085), v3(0.006, 0.062, 0.013), leather, skin, v3(-0.002, 0.004, 0));
  k.rod(v3(hand.x - 0.003, hand.y - 0.009, hand.z), v3(hand.x + 0.0015, hand.y + 0.009, hand.z), 0.0009, LEATHER, 5);
  k.add(new THREE.CylinderGeometry(0.005, 0.005, 0.0012, 3, 1, false, 0, Math.PI).rotateX(Math.PI / 2), compose(hand.x + 0.003, hand.y + 0.006, hand.z, 0, 0, -0.4), IRON);
  arm(k, M, v3(0, 0.048, -0.0085), v3(0.008, 0.038, -0.012), leather, skin);
  // The round shield: planks painted red and cream in halves, an iron rim and boss.
  const sm = M.clone().multiply(compose(0.007, 0.037, -0.015, Math.PI / 2, -0.4, 0)), inv = sm.clone().invert();
  k.add(new THREE.CylinderGeometry(0.0115, 0.0115, 0.0016, 16), sm, (x, y, z, o) => {
    const l = new THREE.Vector3(x, y, z).applyMatrix4(inv);
    o.copy(l.x * 0.7 + l.z > 0 ? RAID_RED : shown('#e6dcc4'));
  });
  k.add(new THREE.TorusGeometry(0.0112, 0.0009, 4, 18), M.clone().multiply(compose(0.007, 0.037, -0.015, 0, -0.4, 0)), IRON_DARK);
  k.add(smoothSphere(0.0026, 1), M.clone().multiply(compose(0.007, 0.037, -0.0165)), IRON);
  return k.build();
}

/** A hide tent: hides stitched over a ring of poles that cross at the top, its flap open towards `open`. */
function hideTent(k: Kit, x: number, z: number, open: number, r = 0.026, h = 0.044) {
  k.add(new THREE.ConeGeometry(r, h, 9, 2, true, open - 0.35 + Math.PI / 2, Math.PI * 2 - 0.7), compose(x, h / 2, z), (px, y, pz, o) => o.set(HIDE[Math.floor(Math.atan2(pz - z, px - x) * 2.2 + y * 60 + 50) % 2]));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    k.rod(v3(x + Math.cos(a) * r * 0.2, h - 0.008, z + Math.sin(a) * r * 0.2), v3(x + Math.cos(a) * 0.004, h + 0.01, z + Math.sin(a) * 0.004), 0.001, WOOD, 4);
  }
}

/**
 * Where raiders hold a hex (three or more on it): their camp, on trodden ground: hide tents, a
 * fire, plunder, and a war banner on a tall pole, black slashed with red and crowned with a
 * horned skull. The three raiders stand about it (see marks.ts); more raiders don't bring more
 * figures but a bigger camp: at `size` 2 a second tent and a palisade of stakes on the outward
 * side, at 3 a third tent and a longship's prow run up on the shore. +x points in to the hex.
 */
export function makeRaiderCamp(size: 1 | 2 | 3): THREE.BufferGeometry {
  const k = new Kit();
  const black = C('#2c2724');
  patch(k, size === 1 ? 0.07 : 0.08, 0.004, 0, 7);
  hideTent(k, 0.012, 0.03, -Math.PI / 2);
  if (size >= 2) hideTent(k, 0.014, -0.032, Math.PI / 2, 0.024, 0.04);
  if (size >= 3) hideTent(k, 0.04, 0.0, Math.PI, 0.022, 0.038);
  campfire(k, CAMP_FIRE.x, CAMP_FIRE.z, 1.1);
  // The war banner, out on the side they came from.
  const bx = -0.03, bz = -0.016, top = 0.1;
  k.rod(v3(bx, 0, bz), v3(bx, top, bz), 0.002, '#2a2420', 6);
  k.rod(v3(bx, top - 0.004, bz - 0.024), v3(bx, top - 0.004, bz + 0.024), 0.0013, '#2a2420', 4);
  k.swaying(top - 0.004, 0.05, 0.8, () =>
    k.cloth(7, 7, (u, v) => v3(bx - 0.003 - v * v * 0.012 + Math.sin(u * 3 + v * 2) * 0.0015, top - 0.005 - v * (0.05 - 0.016 * Math.abs(Math.sin(u * Math.PI * 2))), bz - 0.024 + u * 0.048), (u, v) => (Math.abs(v - 0.15 - u * 0.7) < 0.12 ? RAID_RED : black)),
  );
  const skull = smoothSphere(0.0055, 1);
  skull.scale(1.1, 1, 0.9);
  k.add(skull, compose(bx, top + 0.006, bz), '#e6dcc4');
  for (const s of [-1, 1]) k.add(new THREE.ConeGeometry(0.0018, 0.012, 6), compose(bx, top + 0.01, bz + s * 0.006, s * 0.9, 0, 0), '#e6dcc4');
  // Plunder piled by the tent: a chest, barrels, sacks.
  k.add(box(0.014, 0.009, 0.009, 0.0015), compose(0.03, 0.0045, 0.012, 0, 0.4, 0), '#6b4a2e');
  k.add(new THREE.BoxGeometry(0.0146, 0.0016, 0.0096), compose(0.03, 0.0062, 0.012, 0, 0.4, 0), '#c9a24a');
  barrel(k, 0.034, 0, -0.004);
  if (size >= 2) {
    barrel(k, 0.028, 0, -0.016, 0.005, 0.01);
    for (const [sx, sz] of [[0.02, 0.022], [0.026, 0.028]]) k.add(smoothSphere(0.0052, 1).scale(1.2, 0.75, 1), compose(sx, 0.0036, sz), '#b8a27a');
    // A palisade: sharpened stakes leaning out, with gaps the raiders pass through.
    for (let i = -4; i <= 4; i++) {
      if (i === 0) continue;
      const z = i * 0.012 + (i > 0 ? 0.004 : -0.004);
      k.rod(v3(-0.06 + Math.abs(i) * 0.002, 0, z), v3(-0.072 + Math.abs(i) * 0.002, 0.03, z), 0.0022, WOOD, 5);
      k.add(new THREE.ConeGeometry(0.0022, 0.006, 5), compose(-0.073 + Math.abs(i) * 0.002, 0.0325, z, 0, 0, 0.38), '#a08a68');
    }
  }
  if (size >= 3) {
    // A longship run up on the shore beyond the stakes: a tarred hull, half out of the ground,
    // its stem curling up into a beast's head, shields along the rail.
    const hx = -0.062, hz = 0.044, a = 0.7;
    const Hm = compose(hx, 0, hz, 0, a, -0.12);
    const put = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: Paint) => k.add(g, Hm.clone().multiply(m), c);
    const hull = smoothSphere(0.0145, 2);
    hull.scale(2.6, 0.6, 0.9);
    k.surface(SURFACE.planks, () => put(hull, compose(0, 0.003, 0), (px, _y, pz, o) => o.set(Math.floor((px * 1.3 + pz * 0.7) * 400) % 2 ? '#3a2a1e' : '#4a3626')));
    put(new THREE.TorusGeometry(0.0145, 0.0012, 4, 20).scale(2.55, 0.9, 1), compose(0, 0.0105, 0, Math.PI / 2, 0, 0), '#5a4230');
    const stem = [v3(0.034, 0.008, 0), v3(0.041, 0.018, 0), v3(0.044, 0.03, 0), v3(0.041, 0.038, 0)].map((p) => p.applyMatrix4(Hm));
    for (let i = 0; i < stem.length - 1; i++) k.rod(stem[i], stem[i + 1], 0.0022 - i * 0.0003, '#3a2a1e', 5);
    k.add(smoothSphere(0.0034, 1).scale(1.5, 0.9, 0.8), new THREE.Matrix4().makeTranslation(stem[3].x, stem[3].y, stem[3].z).multiply(compose(0, 0, 0, 0, a, 0)), '#c9a24a');
    for (const t of [-0.016, -0.004, 0.008, 0.02]) {
      put(new THREE.CylinderGeometry(0.0048, 0.0048, 0.0012, 10).rotateX(Math.PI / 2), compose(t, 0.0095, 0.0125, 0, 0, 0), (px, _y, pz, o) => o.copy(Math.floor((px + pz) * 300) % 2 ? RAID_RED : shown('#e6dcc4')));
    }
    // Oars stacked against the hull.
    for (const t of [-0.012, 0.0]) k.rod(v3(hx - 0.01, 0, hz - 0.02 + t), v3(hx + 0.02, 0.014, hz - 0.006 + t), 0.0008, '#7a5a3a', 4);
  }
  return k.build();
}

// ---------------------------------------------------------------------------------------------
// The guilds' trader.
// ---------------------------------------------------------------------------------------------

/** Where the stall's lantern hangs, in model units. */
export const TRADER_LAMP = v3(0.02, 0.036, -0.026);

/**
 * The trader at his stall, in the colours of the seat that holds him: a counter of goods under
 * a striped awning, a sign and a pennant in the owner's colour, a lantern lit through the night,
 * the merchant behind the counter. The stall faces +x (the hex's disc).
 */
export function makeTrader(color: PlayerColor): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const k = new Kit();
  const base = C(pal.base), trim = C(pal.trim), light = C(pal.light);
  patch(k, 0.038, 0.004, 0, 3);
  // Four posts (the back pair taller, so the awning runs off to the front), a counter and a shelf.
  for (const [x, z, h] of [[0.02, -0.026, 0.04], [0.02, 0.026, 0.04], [-0.016, -0.026, 0.05], [-0.016, 0.026, 0.05]]) k.rod(v3(x, 0, z), v3(x, h, z), 0.0016, WOOD, 6);
  k.surface(SURFACE.planks, () => k.add(box(0.03, 0.014, 0.05, 0.001), compose(0.008, 0.017, 0), '#8a6a48'));
  k.add(new THREE.BoxGeometry(0.034, 0.002, 0.054), compose(0.008, 0.025, 0), '#a07a4c');
  k.add(new THREE.BoxGeometry(0.03, 0.002, 0.05), compose(-0.012, 0.034, 0), '#8a6a48');
  // The awning: cloth striped in cream and the owner's colour, sagging a little between the posts.
  const cloth = CREAM.clone();
  k.surface(SURFACE.canvas, () =>
    k.swaying(-0.02, 0.05, 0.15, () =>
      k.cloth(6, 4, (u, v) => v3(-0.022 + u * 0.05, 0.052 - u * 0.012 - Math.sin(v * Math.PI) * 0.003, -0.032 + v * 0.064), (_u, v) => (Math.floor(v * 5.999) % 2 ? base : cloth)),
    ),
  );
  // A scalloped edge along the front, and the pennant on a back post.
  for (let i = 0; i < 8; i++) k.add(new THREE.ConeGeometry(0.004, 0.005, 4).rotateX(Math.PI), compose(0.028, 0.0385, -0.028 + i * 0.008, 0, 0, 0), i % 2 ? base : trim);
  k.rod(v3(-0.016, 0.05, -0.026), v3(-0.016, 0.07, -0.026), 0.001, WOOD, 4);
  k.swaying(-0.016, 0.02, 1, () => k.cloth(5, 1, (u, v) => v3(-0.016 + u * 0.02, 0.068 - v * 0.006 * (1 - u * 0.5), -0.026 + Math.sin(u * 5) * 0.001), (u) => (u < 0.15 ? trim : base)), 'x');
  // The sign hung from the front: a board in the owner's colour, a pair of scales painted on it.
  k.add(new THREE.BoxGeometry(0.0016, 0.012, 0.018), compose(0.021, 0.031, 0.026), (_x, y, z, o) => o.copy(Math.abs(y - 0.031) > 0.005 || Math.abs(z - 0.026) > 0.0075 ? trim : base));
  k.add(new THREE.BoxGeometry(0.0004, 0.0012, 0.009), compose(0.0222, 0.0335, 0.026), '#f2e7c8');
  for (const s of [-1, 1]) k.add(new THREE.CylinderGeometry(0.0022, 0.0022, 0.0004, 8).rotateZ(Math.PI / 2), compose(0.0222, 0.029, 0.026 + s * 0.0045), '#f2e7c8');
  // The lantern, and the goods: sacks, a bolt of cloth in the trim, a basket of fruit, a barrel.
  k.rod(v3(0.02, 0.04, -0.026), v3(0.02, 0.04, -0.03), 0.0008, IRON_DARK, 4);
  k.lit(() => k.add(new THREE.BoxGeometry(0.005, 0.0066, 0.005), compose(TRADER_LAMP.x, TRADER_LAMP.y, TRADER_LAMP.z), '#ffd27a'), 1.4);
  k.add(new THREE.ConeGeometry(0.0046, 0.0034, 4), compose(TRADER_LAMP.x, TRADER_LAMP.y + 0.005, TRADER_LAMP.z, 0, Math.PI / 4, 0), '#2a2420');
  for (const [x, z, s] of [[0.012, -0.014, 1], [0.004, -0.008, 0.9]]) k.add(smoothSphere(0.0046 * s, 1).scale(1.15, 0.8, 1), compose(x, 0.0295, z), '#c8b28a');
  k.add(new THREE.CylinderGeometry(0.0032, 0.0032, 0.016, 8).rotateZ(Math.PI / 2), compose(0.01, 0.0292, 0.004), trim);
  k.add(new THREE.CylinderGeometry(0.0034, 0.0034, 0.015, 8).rotateZ(Math.PI / 2), compose(0.008, 0.0355, 0.004), light);
  k.add(new THREE.CylinderGeometry(0.0048, 0.0038, 0.004, 10, 1, true), compose(0.012, 0.028, 0.017), '#a08a58');
  for (let i = 0; i < 5; i++) k.add(smoothSphere(0.0014, 0), compose(0.012 + Math.cos(i * 1.3) * 0.0022, 0.0304, 0.017 + Math.sin(i * 1.3) * 0.0022), i % 2 ? '#c9402e' : '#d8a63a');
  barrel(k, 0.03, 0, -0.03, 0.0048, 0.0105);
  k.add(smoothSphere(0.005, 1).scale(1.2, 0.8, 1), compose(0.03, 0.004, 0.032), '#c8b28a');
  // The merchant behind the counter, in his seat's colours under a felt hat, one hand raised to the trade.
  const M = person(-0.008, 0.0, 0, 0);
  figure(k, { at: M, body: base, trim, legs: '#5a4636', skin: SKIN[1], helm: 'bare' });
  k.add(new THREE.CylinderGeometry(0.0062, 0.0062, 0.0008, 12), M.clone().multiply(compose(0, 0.0627, 0)), trim);
  k.add(new THREE.CylinderGeometry(0.0042, 0.0052, 0.004, 10), M.clone().multiply(compose(0, 0.0648, 0)), trim);
  arm(k, M, v3(0, 0.048, 0.0085), v3(0.012, 0.044, 0.01), base, SKIN[1], v3(0, 0.004, 0));
  arm(k, M, v3(0, 0.048, -0.0085), v3(0.008, 0.028, -0.011), base, SKIN[1]);
  return k.build();
}
