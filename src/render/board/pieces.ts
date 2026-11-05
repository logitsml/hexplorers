// Player pieces (roads, settlements, cities) and the robber, built procedurally
// with baked vertex colours per player so each piece type is a single draw.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, attribute, vec3, vec4, uniform, sin, time, positionLocal, positionGeometry, positionWorld, normalGeometry, mx_noise_float, smoothstep, mix, float, floor, fract, step, abs, vertexColor, mat3, varying } from 'three/tsl';
import { batchMatrix } from '../core/batchMatrix';
import { bumpedNormal, detailFade, vertexAlbedo } from './materials';
import { WINDOW_LIGHT, lampColor, lampLevelNode } from '../fx/lamps';
import { SURFACE, hash2, surfaceShade, worldScale } from './surfaces';
import type { PlayerColor } from '../../engine';
import { MeshBuilder, compose } from './geom';
import { Noise } from '../util/noise';
import { windStrength, windTravel } from '../env/wind';

type Palette = { base: string; light: string; dark: string; trim: string; ui: string };

/**
 * Player colours. base, light (walls), dark (roofs) and trim are vertex colours, which the
 * piece material squares (see vertexAlbedo), so they are stored as square roots of the colours
 * they render as: walls red #b6322b, amber #e89629, blue #305eb7, ivory #ece4d2, with roofs a
 * step darker. `ui` is the same colour as the HUD shows it, a little brighter, as the lit walls
 * read on the board. The orange player is an amber, so it never reads as a second red.
 *
 * The first four are tuned by hand; the other presets, and a colour a player picks for
 * themselves ('#rrggbb'), are worked out from their HUD colour by `derivePalette`.
 */
const PALETTES: Record<string, Palette> = {
  red: { base: '#c86861', light: '#d8756e', dark: '#b75a57', trim: '#f2e6d8', ui: '#d64534' },
  blue: { base: '#6b8ec8', light: '#739cd8', dark: '#6180b6', trim: '#efe8dc', ui: '#3f74d6' },
  white: { base: '#e9e3d6', light: '#f5f1e7', dark: '#c1b7ac', trim: '#6a5a48', ui: '#f2ede2' },
  orange: { base: '#e4b45a', light: '#f3c46c', dark: '#d4a346', trim: '#f4e8d6', ui: '#f2a12f' },
};

/** The presets offered on the title screen, in order, with the HUD colour of the derived ones. */
export const PRESET_COLORS: { id: PlayerColor; name: string; ui?: string }[] = [
  { id: 'red', name: 'Red' },
  { id: 'blue', name: 'Blue' },
  { id: 'white', name: 'Ivory' },
  { id: 'orange', name: 'Amber' },
  { id: 'purple', name: 'Violet', ui: '#8b55d6' },
  { id: 'teal', name: 'Teal', ui: '#16a093' },
  { id: 'rose', name: 'Rose', ui: '#e2639c' },
  { id: 'charcoal', name: 'Charcoal', ui: '#4a4c55' },
];

const _hsl = { h: 0, s: 0, l: 0 };

/** HUD lightness (sRGB) of a colour. */
function lightness(hex: string) {
  return new THREE.Color(hex).getHSL(_hsl, THREE.SRGBColorSpace).l;
}

/**
 * A palette from a HUD colour, following the hand-tuned four: walls render about 0.85 of its
 * lightness, roads 0.74 and roofs 0.62. Pale colours keep their walls nearly as pale and take
 * a greyer roof (darkening a pale colour in HSL would turn it yellow), and trim is cream on a
 * dark colour, brown on a pale one.
 */
function derivePalette(ui: string): Palette {
  const pale = THREE.MathUtils.smoothstep(lightness(ui), 0.72, 0.92);
  const step = (f: number, paleF: number, paleSat = 1) => {
    const c = new THREE.Color(ui);
    c.getHSL(_hsl, THREE.SRGBColorSpace);
    c.setHSL(_hsl.h, _hsl.s * THREE.MathUtils.lerp(1, paleSat, pale), _hsl.l * THREE.MathUtils.lerp(f, paleF, pale), THREE.SRGBColorSpace);
    // Stored as the square root of the colour it renders as (see above).
    c.setRGB(Math.sqrt(c.r), Math.sqrt(c.g), Math.sqrt(c.b));
    return `#${c.getHexString()}`;
  };
  return { base: step(0.74, 0.86), light: step(0.85, 0.97), dark: step(0.62, 0.56, 0.35), trim: pale > 0.5 ? '#6a5a48' : '#f2e6d8', ui };
}

for (const p of PRESET_COLORS) if (p.ui) PALETTES[p.id] = derivePalette(p.ui);

let GREY: Palette | null = null;
/** The players' own colours derived so far, oldest first (see PLAYER_PALETTE). */
const owned: string[] = [];

/** Any player colour's palette: a preset's, or one derived (once) from a '#rrggbb' of their own. */
export const PLAYER_PALETTE: Record<PlayerColor, Palette> = new Proxy(PALETTES, {
  get: (t, k) => {
    if (typeof k !== 'string') return Reflect.get(t, k);
    if (t[k]) return t[k];
    // Only a colour of a player's own is kept; anything else gets a grey, not a new entry. (At
    // most a few dozen of them: the set-up page's colour picker asks for every colour it passes.)
    if (/^#[0-9a-f]{6}$/i.test(k)) {
      if (owned.length >= 32) delete t[owned.shift()!];
      owned.push(k);
      return (t[k] = derivePalette(k));
    }
    return (GREY ??= derivePalette('#888888'));
  },
});

/** Pale colours (ivory, or a pale one of a player's own) take lighter timber beams, and dark lettering in the HUD. */
export const isPaleColor = (color: PlayerColor) => lightness(PLAYER_PALETTE[color].ui) > 0.75;

/** Two player colours too alike to tell apart on the board. */
export function colorsClash(a: PlayerColor, b: PlayerColor) {
  const x = new THREE.Color(PLAYER_PALETTE[a].ui), y = new THREE.Color(PLAYER_PALETTE[b].ui);
  x.getHSL(_hsl, THREE.SRGBColorSpace);
  const [h, s, l] = [_hsl.h, _hsl.s, _hsl.l];
  y.getHSL(_hsl, THREE.SRGBColorSpace);
  const dh = Math.min(Math.abs(h - _hsl.h), 1 - Math.abs(h - _hsl.h));
  if ((l > 0.85 && _hsl.l > 0.85) || (l < 0.22 && _hsl.l < 0.22)) return true;
  // Greys compare by lightness alone.
  if (Math.min(s, _hsl.s) < 0.18) return Math.abs(l - _hsl.l) < 0.18;
  return dh < 0.06 && Math.abs(l - _hsl.l) < 0.25;
}

const C = (h: string) => new THREE.Color(h);

type FloatUniform = ReturnType<typeof uniform<'float'>>;

/**
 * "Bright pieces" (Settings): 0..1 how far the players' pieces and the robber light
 * themselves, so they stay clear in shade, under cloud and at night. Eased by BoardView.
 */
export const piecesBright = uniform(0);

/**
 * Self-light for a bright piece: enough to read at night, little by day (when the sun already
 * lights it) so pale pieces don't blow out and strong colours (a blue road's cobbles) keep their
 * depth (it's on by default).
 */
// (Pale pieces need less of it: a white seat's road lit as much as a blue one would glare after dark.)
const brightLight = (albedo: Node<'vec3'>, night: FloatUniform) =>
  albedo.mul(piecesBright).mul(night.mul(0.6).add(0.15)).mul(float(1).sub(albedo.dot(vec3(0.2126, 0.7152, 0.0722)).mul(0.5)));

/** How dark it is, 0..1, for the pieces and what lights itself as a bright piece beside them (set by BoardView). */
export const piecesNight = uniform(0);

/**
 * The same self-light for the board's other things a player reads at a glance (the number discs;
 * the harbour badges, which are unlit, dim less instead): `albedo` as a linear colour.
 */
export const brightLift = (albedo: Node<'vec3'>) => brightLight(albedo, piecesNight);

/** Shared material for pieces: painted-wood look, warm window glow at dusk. */
/**
 * The pieces' material. With `batch` it is that batched mesh's own (see standInBatch.ts): what it
 * does in a piece's own space (cloth in the breeze, the size of its surface patterns) it does in
 * each instance's, by the instance's transform (see core/batchMatrix.ts).
 */
export function pieceMaterial(night: FloatUniform, opts: { bright?: boolean } = {}, batch?: THREE.BatchedMesh): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.58, metalness: 0 });
  const glow = attribute<'float'>('glow', 'float');
  const sway = attribute<'float'>('sway', 'float');
  const own = batch ? batchMatrix(batch) : null;
  // Roof courses, masonry and kerb joints, painted in the piece's own space.
  // (An instance's size worked out once a vertex, not once a pixel.)
  const shade = surfaceShade(attribute<'float'>('surface', 'float'), positionGeometry, normalGeometry, own ? worldScale.mul(varying(mat3(own).mul(vec3(1, 0, 0)).length())) : worldScale);
  const albedo = vertexAlbedo().mul(shade);
  m.colorNode = vec4(albedo, 1);
  // Cloth, banners and flowers move in the breeze; weight 0 is rigid. They move with the scene's
  // one wind (env/wind.ts): quicker and further as it rises under cloud and in a storm, and
  // stiller in fair weather. (Its travel, not the clock, keeps time: a rising wind speeds them up
  // without a jump.)
  m.positionNode = Fn(() => {
    const p = positionLocal.toVar();
    const ph = positionGeometry.x.mul(31).add(positionGeometry.z.mul(17));
    const w = windTravel.mul(1.55);
    const reach = windStrength.mul(0.45).add(0.55);
    const gust = sin(w.mul(1.7).add(ph)).mul(0.6).add(sin(w.mul(4.3).add(ph.mul(1.9))).mul(0.25));
    const drift = vec3(gust.mul(sway).mul(0.006).mul(reach), 0, sin(w.mul(2.3).add(ph.mul(0.7))).mul(sway).mul(0.004).mul(reach));
    // (positionLocal is already the batched instance's: its own drift is turned and sized by it.)
    p.addAssign(own ? mat3(own).mul(drift) : drift);
    return p;
  })();
  m.emissiveNode = Fn(() => {
    const flicker = sin(time.mul(7).add(positionGeometry.x.mul(40))).mul(0.08).add(0.92);
    const lamp = lampColor(...WINDOW_LIGHT);
    // (A negative glow is no lamp but a floor of the piece's own colour after dark: a ship's
    // sail, so the owner's colour still reads at night. None of the base pieces have one.)
    const level = lampLevelNode(night);
    const lit = vec3(lamp.r, lamp.g, lamp.b).mul(glow.max(0)).mul(level).mul(flicker).add(albedo.mul(glow.negate().max(0)).mul(level));
    return opts.bright === false ? lit : lit.add(brightLight(albedo, night));
  })();
  return m;
}

function withGlow(g: THREE.BufferGeometry, glowFn: (i: number) => number, swayFn: (i: number) => number = () => 0) {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = glowFn(i);
    w[i] = swayFn(i);
  }
  g.setAttribute('glow', new THREE.BufferAttribute(a, 1));
  g.setAttribute('sway', new THREE.BufferAttribute(w, 1));
  if (!g.getAttribute('surface')) g.setAttribute('surface', new THREE.BufferAttribute(new Float32Array(n), 1));
  return g;
}

/** Marks vertex ranges of a MeshBuilder as glowing or swaying while a piece is assembled. */
class Marks {
  glow: [number, number][] = [];
  sway: { from: number; to: number; top: number; drop: number; amount: number }[] = [];
  constructor(private b: MeshBuilder) {}
  /** Everything added inside fn glows at night (windows, lanterns). */
  lit(fn: () => void) {
    const s = this.b.vertexCount;
    fn();
    this.glow.push([s, this.b.vertexCount]);
  }
  /** Everything added inside fn sways, more the further it hangs below `top`. */
  swaying(top: number, drop: number, amount: number, fn: () => void) {
    const s = this.b.vertexCount;
    fn();
    this.sway.push({ from: s, to: this.b.vertexCount, top, drop, amount });
  }
  apply(g: THREE.BufferGeometry) {
    const pos = g.getAttribute('position');
    return withGlow(
      g,
      (i) => (this.glow.some(([a, b]) => i >= a && i < b) ? 1 : 0),
      (i) => {
        const r = this.sway.find((m) => i >= m.from && i < m.to);
        if (!r) return 0;
        return r.amount * Math.min(1, Math.max(0, (r.top - pos.getY(i)) / r.drop));
      },
    );
  }
}

/** Small props shared by the buildings. */
function flowerBox(add: Add, x: number, y: number, z: number, w: number, rnd: () => number) {
  add(box(w, 0.008, 0.01, 0.002), compose(x, y, z), C('#6b4a2e'));
  const cols = ['#e2483a', '#f2c33a', '#f6efe4', '#d86aa6'];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.IcosahedronGeometry(0.0045, 0);
    add(g, compose(x - w / 2 + 0.004 + (i / 4) * (w - 0.008), y + 0.007, z + (rnd() - 0.5) * 0.004), C(cols[Math.floor(rnd() * cols.length)]));
  }
}

function lantern(add: Add, x: number, y: number, z: number) {
  add(box(0.008, 0.011, 0.008, 0.002), compose(x, y, z), C('#ffd27a'));
  add(box(0.011, 0.003, 0.011, 0.001), compose(x, y + 0.007, z), C('#2c2420'));
}

type Add = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color | ((x: number, y: number, z: number, o: THREE.Color) => void)) => void;

export function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Gabled roof prism along z: width w (x), depth d (z), rise h. */
export function gable(w: number, d: number, h: number, overhang = 0.012, thickness = 0.008): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = w / 2 + overhang;
  shape.moveTo(-hw, 0);
  shape.lineTo(0, h);
  shape.lineTo(hw, 0);
  shape.lineTo(hw - thickness * 1.6, 0);
  shape.lineTo(0, h - thickness * 1.9);
  shape.lineTo(-hw + thickness * 1.6, 0);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: d + overhang * 2, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 });
  g.translate(0, 0, -(d + overhang * 2) / 2);
  return g;
}

/** Triangular gable-end wall filling under the roof. */
export function gableWall(w: number, d: number, h: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(0, h);
  shape.lineTo(w / 2, 0);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  return g;
}

/** The unit box that rounded boxes are bent from: two segments round each edge. */
const BOX_SEGMENTS = 5;
let unitBox: THREE.BoxGeometry | null = null;

/**
 * A box with rounded edges: three's RoundedBoxGeometry, bent the same way from an indexed box.
 * (Its own unindexes the box first: 900 vertices to shade for each, where this keeps 216.)
 */
export function box(w: number, h: number, d: number, r = 0.004): THREE.BufferGeometry {
  const radius = Math.min(r, Math.min(w, h, d) / 2.2);
  unitBox ??= new THREE.BoxGeometry(1, 1, 1, BOX_SEGMENTS, BOX_SEGMENTS, BOX_SEGMENTS);
  const src = unitBox.getAttribute('position').array;
  const pos = new Float32Array(src.length);
  const nrm = new Float32Array(src.length);
  const half = [w / 2 - radius, h / 2 - radius, d / 2 - radius];
  const n = [0, 0, 0];
  for (let i = 0; i < src.length; i += 3) {
    for (let k = 0; k < 3; k++) n[k] = src[i + k] - Math.sign(src[i + k]) * (0.5 / BOX_SEGMENTS);
    const len = Math.hypot(n[0], n[1], n[2]);
    for (let k = 0; k < 3; k++) {
      nrm[i + k] = n[k] / len;
      pos[i + k] = half[k] * Math.sign(src[i + k]) + nrm[i + k] * radius;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  // (Shared: these only ever feed a MeshBuilder, never the GPU.)
  g.setIndex(unitBox.getIndex());
  return g;
}

// ---------------------------------------------------------------------------
// Settlement: a timber-framed cottage on a stone footing.
// ---------------------------------------------------------------------------

/**
 * Each seat's mark (seat 0 a circle, 1 a triangle, 2 a square, 3 a diamond), so players can be
 * told apart by more than colour: on a wooden plaque in each building's front gable, and beside
 * them in the HUD (see ui/SeatMark.tsx).
 */
export const SEAT_MARKS = ['circle', 'triangle', 'square', 'diamond'] as const;

function markShape(seat: number): THREE.Shape {
  const s = new THREE.Shape();
  switch (SEAT_MARKS[seat % SEAT_MARKS.length]) {
    case 'circle':
      s.absarc(0, 0, 0.42, 0, Math.PI * 2, false);
      break;
    case 'triangle':
      s.moveTo(0, 0.46).lineTo(0.44, -0.34).lineTo(-0.44, -0.34).closePath();
      break;
    case 'square':
      s.moveTo(-0.36, -0.36).lineTo(0.36, -0.36).lineTo(0.36, 0.36).lineTo(-0.36, 0.36).closePath();
      break;
    case 'diamond':
      s.moveTo(0, 0.48).lineTo(0.46, 0).lineTo(0, -0.48).lineTo(-0.46, 0).closePath();
      break;
  }
  return s;
}

/** Marks are cream on dark timber for every colour: the shape, not the hue, is what tells seats apart. */
const MARK_INK = new THREE.Color('#f4ead6');

/** A round plaque of dark timber at (x, y, z) facing +z, with the seat's mark on it in `ink`. */
function seatPlaque(add: (g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color) => void, seat: number, x: number, y: number, z: number, size: number, plank: THREE.Color, ink: THREE.Color) {
  add(new THREE.CylinderGeometry(size * 0.62, size * 0.62, 0.003, 18), compose(x, y, z, Math.PI / 2, 0, 0), plank);
  // Raised a little off the plaque's face, so the two never fight for the same depth.
  const g = new THREE.ExtrudeGeometry(markShape(seat), { depth: 1, bevelEnabled: false, curveSegments: 16 });
  g.scale(size, size, 0.0009);
  add(g, compose(x, y, z + 0.0015), ink);
}

export function makeSettlement(color: PlayerColor, seat = -1): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const b = new MeshBuilder();
  const stone = C('#8e8a84');
  const beam = isPaleColor(color) ? C('#6b5440') : C('#4a3322');
  const wall = C(pal.light);
  const roof = C(pal.dark);
  const W = 0.12, D = 0.1, H = 0.062;
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color | ((x: number, y: number, z: number, o: THREE.Color) => void)) => {
    b.addGeometry(g, m, c);
    g.dispose();
  };
  // Footing of coursed stone.
  b.surfaceId = SURFACE.stone;
  add(box(W + 0.014, 0.016, D + 0.014, 0.004), compose(0, 0.008, 0), stone);
  b.surfaceId = SURFACE.plain;
  // Walls.
  add(box(W, H, D, 0.003), compose(0, 0.016 + H / 2, 0), wall);
  // Gable ends.
  add(gableWall(W, D - 0.002, 0.05), compose(0, 0.016 + H, 0), wall);
  // Timber frame: corner posts, sill and lintel band, cross braces on the front.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) add(box(0.009, H, 0.009, 0.002), compose(sx * (W / 2 - 0.002), 0.016 + H / 2, sz * (D / 2 - 0.002)), beam);
  for (const sz of [-1, 1]) add(box(W + 0.004, 0.008, 0.008, 0.002), compose(0, 0.016 + H - 0.004, sz * (D / 2)), beam);
  add(box(0.006, H * 0.95, 0.006, 0.0015), compose(-W * 0.22, 0.016 + H / 2, D / 2 + 0.001, 0, 0, 0.62), beam);
  // Roof (tiled in courses) and ridge.
  b.surfaceId = SURFACE.roof;
  add(gable(W, D, 0.055), compose(0, 0.016 + H - 0.002, 0), roof);
  b.surfaceId = SURFACE.plain;
  add(box(0.012, 0.01, D + 0.03, 0.003), compose(0, 0.016 + H + 0.052, 0), roof.clone().offsetHSL(0, 0, -0.06));
  // Chimney.
  b.surfaceId = SURFACE.stone;
  add(box(0.018, 0.045, 0.018, 0.003), compose(W * 0.26, 0.016 + H + 0.035, -D * 0.2), stone);
  b.surfaceId = SURFACE.plain;
  add(box(0.022, 0.006, 0.022, 0.002), compose(W * 0.26, 0.016 + H + 0.06, -D * 0.2), stone.clone().offsetHSL(0, 0, -0.1));
  const mk = new Marks(b);
  const rnd = seeded(7);
  const front = D / 2 + 0.002;
  if (seat >= 0) seatPlaque(add, seat, 0, 0.016 + H + 0.017, front - 0.001, 0.024, C('#3a2717'), MARK_INK);
  // Plank door with a little gabled canopy and a stone step.
  add(box(0.024, 0.038, 0.006, 0.002), compose(W * 0.18, 0.016 + 0.019, front), C('#3b2616'));
  add(box(0.003, 0.034, 0.007, 0.001), compose(W * 0.18, 0.016 + 0.019, front + 0.001), C('#2a1a0e'));
  add(gable(0.032, 0.014, 0.012, 0.003, 0.004), compose(W * 0.18, 0.016 + 0.041, front + 0.006, 0, Math.PI / 2, 0), roof);
  add(box(0.032, 0.006, 0.014, 0.002), compose(W * 0.18, 0.003, front + 0.008), stone.clone().offsetHSL(0, 0, 0.06));
  // Front window: frame, mullion cross, green shutters and a flower box.
  const wy = 0.016 + H * 0.58;
  mk.lit(() => add(box(0.02, 0.018, 0.005, 0.0015), compose(-W * 0.18, wy, front), C('#ffcf7a')));
  add(box(0.0022, 0.019, 0.006, 0.0008), compose(-W * 0.18, wy, front + 0.001), beam);
  add(box(0.021, 0.0022, 0.006, 0.0008), compose(-W * 0.18, wy, front + 0.001), beam);
  for (const s2 of [-1, 1]) add(box(0.009, 0.02, 0.003, 0.001), compose(-W * 0.18 + s2 * 0.016, wy, front + 0.002), C(pal.dark).offsetHSL(0, -0.1, -0.05));
  mk.swaying(wy - 0.008, 0.01, 0.25, () => flowerBox(add, -W * 0.18, wy - 0.013, front + 0.006, 0.024, rnd));
  // Side windows.
  mk.lit(() => {
    add(box(0.005, 0.018, 0.02, 0.0015), compose(W / 2 + 0.002, wy, 0), C('#ffcf7a'));
    add(box(0.005, 0.018, 0.02, 0.0015), compose(-W / 2 - 0.002, wy, 0), C('#ffcf7a'));
  });
  // Lantern by the door, lit at dusk.
  add(box(0.0025, 0.012, 0.0025, 0.0008), compose(W * 0.18 + 0.02, 0.016 + 0.046, front + 0.004), C('#2c2420'));
  mk.lit(() => lantern(add, W * 0.18 + 0.02, 0.016 + 0.036, front + 0.006));
  // Woodpile under the eave and a water barrel.
  for (let i = 0; i < 6; i++) {
    const log = new THREE.CylinderGeometry(0.0045, 0.0045, 0.034, 6);
    add(log, compose(-W / 2 - 0.01, 0.006 + Math.floor(i / 3) * 0.0085, -0.02 + (i % 3) * 0.0095 + Math.floor(i / 3) * 0.0045, Math.PI / 2, 0, 0), C(i % 2 ? '#7a5434' : '#8d6640'));
  }
  add(new THREE.CylinderGeometry(0.009, 0.0085, 0.02, 10), compose(W / 2 + 0.012, 0.01, D / 2 - 0.012), (_x, y, _z, o) => o.set(Math.abs(y - 0.01) > 0.006 ? '#3d3a36' : '#7b5636'));
  // Kitchen garden behind a picket fence, with a laundry line on two posts.
  const gz = -D / 2 - 0.035;
  for (let i = 0; i < 7; i++) add(box(0.003, 0.016, 0.003, 0.0008), compose(-0.05 + i * 0.017, 0.008, gz - 0.025), C('#e9dcc2'));
  add(box(0.105, 0.0025, 0.0025, 0.0008), compose(0.001, 0.012, gz - 0.025), C('#e9dcc2'));
  for (let r = 0; r < 2; r++)
    for (let i = 0; i < 5; i++) {
      const g = new THREE.IcosahedronGeometry(0.0055, 0);
      add(g, compose(-0.04 + i * 0.02, 0.005, gz - 0.006 - r * 0.012), C(r ? '#5f8f3a' : '#7aa346'));
    }
  for (const x of [-0.05, 0.05]) add(box(0.0025, 0.05, 0.0025, 0.0008), compose(x, 0.025, gz + 0.012), beam);
  add(box(0.1, 0.0008, 0.0008, 0.0003), compose(0, 0.048, gz + 0.012), C('#d8cbb0'));
  const cloths = ['#f2ece0', pal.base, '#a9c2d6', '#e8d27a'];
  mk.swaying(0.048, 0.022, 1, () => {
    cloths.forEach((c, i) => {
      const w = 0.012 + (i % 2) * 0.006;
      add(new THREE.BoxGeometry(w, 0.018 + (i % 3) * 0.003, 0.0012), compose(-0.034 + i * 0.022, 0.047 - 0.01, gz + 0.012), C(c));
    });
  });
  const g = b.build(false);
  return mk.apply(g);
}

// ---------------------------------------------------------------------------
// City: a hall with a round tower, conical roof and a flag; plus an annex.
// ---------------------------------------------------------------------------

/**
 * The builders' scaffold that goes up round a settlement becoming a city (see BoardView's
 * animateUpgrade): timber poles at the corners and between them, two lifts of boards, and
 * braces across two faces, about a city's footprint. In the pieces' own scale, origin on the ground.
 */
export function makeScaffold(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const timber = C('#8a6a44'), board = C('#b08a5a'), rope = C('#c9b48a');
  const X = 0.088, Z = 0.074, H = 0.13;
  const poles: [number, number][] = [[-X, -Z], [X, -Z], [-X, Z], [X, Z], [0, -Z], [0, Z], [-X, 0], [X, 0]];
  for (const [x, z] of poles) {
    const pole = new THREE.CylinderGeometry(0.0022, 0.0026, H, 5);
    b.addGeometry(pole, compose(x, H / 2, z), timber);
    pole.dispose();
  }
  for (const y of [0.05, 0.095]) {
    // Ledgers round the outside and a run of boards along the two long faces.
    for (const s of [-1, 1]) {
      const ledger = new THREE.BoxGeometry(X * 2 + 0.006, 0.003, 0.003);
      b.addGeometry(ledger, compose(0, y, s * Z), timber);
      ledger.dispose();
      const end = new THREE.BoxGeometry(0.003, 0.003, Z * 2 + 0.006);
      b.addGeometry(end, compose(s * X, y, 0), timber);
      end.dispose();
      const deck = new THREE.BoxGeometry(X * 2, 0.0016, 0.012);
      b.addGeometry(deck, compose(0, y + 0.0023, s * (Z + 0.006)), board);
      deck.dispose();
    }
  }
  // Braces corner to corner across the long faces, and a lashing at each top.
  for (const s of [-1, 1]) {
    const len = Math.hypot(X * 2, 0.09);
    const brace = new THREE.BoxGeometry(len, 0.0022, 0.0022);
    b.addGeometry(brace, compose(0, 0.05 + 0.045, s * (Z + 0.0025), 0, 0, Math.atan2(0.09, X * 2) * s), timber);
    brace.dispose();
  }
  for (const [x, z] of poles) {
    const tie = new THREE.CylinderGeometry(0.0032, 0.0032, 0.004, 5);
    b.addGeometry(tie, compose(x, H - 0.006, z), rope);
    tie.dispose();
  }
  return withGlow(b.build(false), () => 0);
}

export function makeCity(color: PlayerColor, seat = -1): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const b = new MeshBuilder();
  const stone = C('#9a958d');
  const stoneDark = C('#7b766f');
  const wall = C(pal.light);
  const roof = C(pal.dark);
  const beam = isPaleColor(color) ? C('#6b5440') : C('#4a3322');
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color | ((x: number, y: number, z: number, o: THREE.Color) => void)) => {
    b.addGeometry(g, m, c);
    g.dispose();
  };
  // Coursed stone (blocks and joints in the shader) and tiled roofs.
  const masonry = (fn: () => void) => {
    b.surfaceId = SURFACE.stone;
    fn();
    b.surfaceId = SURFACE.plain;
  };
  const tiled = (fn: () => void) => {
    b.surfaceId = SURFACE.roof;
    fn();
    b.surfaceId = SURFACE.plain;
  };
  const stoneMid = stone.clone().lerp(stoneDark, 0.2);
  // Plinth.
  masonry(() => add(box(0.21, 0.018, 0.16, 0.005), compose(0, 0.009, 0), stoneMid));
  // Main hall.
  const HW = 0.15, HD = 0.11, HH = 0.08;
  add(box(HW, HH, HD, 0.003), compose(-0.015, 0.018 + HH / 2, 0.01), wall);
  add(gableWall(HW, HD - 0.002, 0.06), compose(-0.015, 0.018 + HH, 0.01), wall);
  tiled(() => add(gable(HW, HD, 0.065), compose(-0.015, 0.018 + HH - 0.002, 0.01), roof));
  for (const sx of [-1, 1]) add(box(0.009, HH, 0.009, 0.002), compose(-0.015 + sx * (HW / 2 - 0.002), 0.018 + HH / 2, 0.01 + HD / 2 - 0.002), beam);
  add(box(HW + 0.004, 0.008, 0.008, 0.002), compose(-0.015, 0.018 + HH - 0.004, 0.01 + HD / 2), beam);
  // Tower (stone) with crenellated band and conical roof.
  const tx = 0.055, tz = -0.035, TR = 0.034, TH = 0.17;
  masonry(() => add(new THREE.CylinderGeometry(TR, TR * 1.08, TH, 18, 6), compose(tx, 0.018 + TH / 2, tz), stoneMid));
  add(new THREE.CylinderGeometry(TR * 1.18, TR * 1.18, 0.012, 18, 1), compose(tx, 0.018 + TH, tz), stoneDark);
  tiled(() => add(new THREE.ConeGeometry(TR * 1.32, 0.085, 18, 2), compose(tx, 0.018 + TH + 0.048, tz), roof));
  // Flag pole.
  add(new THREE.CylinderGeometry(0.0018, 0.0018, 0.06, 5), compose(tx, 0.018 + TH + 0.11, tz), C('#3d2b1c'));
  // Annex cottage.
  add(box(0.06, 0.05, 0.06, 0.003), compose(-0.07, 0.018 + 0.025, -0.045), wall);
  tiled(() => add(gable(0.06, 0.06, 0.035, 0.008), compose(-0.07, 0.018 + 0.049, -0.045, 0, Math.PI / 2, 0), roof));
  // Chimney on the hall.
  masonry(() => add(box(0.016, 0.04, 0.016, 0.003), compose(-0.06, 0.018 + HH + 0.04, 0.0), stone));
  const mk = new Marks(b);
  const rnd = seeded(11);
  const front = 0.01 + HD / 2 + 0.002;
  if (seat >= 0) seatPlaque(add, seat, -0.015, 0.018 + HH + 0.021, front - 0.001, 0.028, C('#3a2717'), MARK_INK);
  // Arched double door with a canopy and lanterns either side.
  add(box(0.03, 0.045, 0.006, 0.002), compose(-0.015, 0.018 + 0.0225, front), C('#3b2616'));
  add(new THREE.CylinderGeometry(0.015, 0.015, 0.006, 12, 1, false, 0, Math.PI), compose(-0.015, 0.018 + 0.045, front, Math.PI / 2, 0, Math.PI / 2), C('#3b2616'));
  add(gable(0.04, 0.016, 0.014, 0.003, 0.004), compose(-0.015, 0.018 + 0.064, front + 0.007, 0, Math.PI / 2, 0), roof);
  for (const s2 of [-1, 1]) {
    add(box(0.0025, 0.012, 0.0025, 0.0008), compose(-0.015 + s2 * 0.026, 0.018 + 0.05, front + 0.004), C('#2c2420'));
    mk.lit(() => lantern(add, -0.015 + s2 * 0.026, 0.018 + 0.04, front + 0.006));
  }
  // Hall windows with shutters and flower boxes; tower arrow slits; annex window.
  for (const wx of [-0.05, 0.02]) {
    mk.lit(() => add(box(0.018, 0.022, 0.005, 0.0015), compose(wx, 0.018 + HH * 0.6, front), C('#ffcf7a')));
    add(box(0.0022, 0.023, 0.006, 0.0008), compose(wx, 0.018 + HH * 0.6, front + 0.001), beam);
    for (const s2 of [-1, 1]) add(box(0.008, 0.023, 0.003, 0.001), compose(wx + s2 * 0.0145, 0.018 + HH * 0.6, front + 0.002), C(pal.dark).offsetHSL(0, -0.1, -0.05));
    mk.swaying(0.018 + HH * 0.6 - 0.012, 0.01, 0.25, () => flowerBox(add, wx, 0.018 + HH * 0.6 - 0.016, front + 0.006, 0.022, rnd));
  }
  mk.lit(() => {
    for (const h of [0.45, 0.72]) add(box(0.006, 0.02, 0.005, 0.0015), compose(tx, 0.018 + TH * h, tz + TR + 0.001), C('#ffcf7a'));
    add(box(0.005, 0.016, 0.014, 0.0015), compose(-0.07 - 0.031, 0.018 + 0.027, -0.045), C('#ffcf7a'));
  });
  // Merlons around the tower top.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    add(box(0.009, 0.01, 0.007, 0.0015), compose(tx + Math.cos(a) * TR * 1.12, 0.018 + TH + 0.01, tz + Math.sin(a) * TR * 1.12, 0, -a, 0), stoneDark);
  }
  // A long banner hanging down the tower face in the player's colour.
  mk.swaying(0.018 + TH * 0.88, 0.07, 0.6, () => {
    add(new THREE.BoxGeometry(0.018, 0.06, 0.0015, 1, 6, 1), compose(tx + TR * 0.72, 0.018 + TH * 0.68, tz + TR * 0.72, 0, -Math.PI / 4, 0), (_x, y, _z, o) => o.set(Math.abs(y - (0.018 + TH * 0.68)) < 0.006 ? pal.trim : pal.base));
  });
  // Market stall: posts, a striped awning in the player's colour, crates of produce.
  const mx = 0.075, mz = 0.07;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box(0.003, 0.04, 0.003, 0.0008), compose(mx + sx * 0.022, 0.02, mz + sz * 0.014), beam);
  mk.swaying(0.042, 0.012, 0.3, () => {
    for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(0.0085, 0.002, 0.036), compose(mx - 0.021 + i * 0.0084, 0.043 - (i % 2) * 0.0005, mz, 0.18, 0, 0), C(i % 2 ? pal.trim : pal.base));
  });
  add(box(0.046, 0.014, 0.024, 0.002), compose(mx, 0.007, mz), C('#8a6440'));
  const produce = ['#d24a3a', '#f0b43a', '#7aa346', '#c78a4a'];
  for (let i = 0; i < 8; i++) {
    const g = new THREE.IcosahedronGeometry(0.0042, 0);
    add(g, compose(mx - 0.018 + (i % 4) * 0.012, 0.017, mz - 0.006 + Math.floor(i / 4) * 0.012), C(produce[i % 4]));
  }
  // A stone well with a little roof.
  const wx2 = -0.085, wz2 = 0.065;
  masonry(() => add(new THREE.CylinderGeometry(0.014, 0.015, 0.016, 12, 1, true), compose(wx2, 0.008, wz2), stoneMid));
  add(new THREE.CircleGeometry(0.0125, 12), compose(wx2, 0.012, wz2, -Math.PI / 2, 0, 0), C('#1e2a33'));
  for (const s2 of [-1, 1]) add(box(0.0025, 0.03, 0.0025, 0.0008), compose(wx2 + s2 * 0.013, 0.031, wz2), beam);
  add(gable(0.032, 0.02, 0.012, 0.003, 0.003), compose(wx2, 0.045, wz2), roof);
  const g = b.build(false);
  return mk.apply(g);
}

/**
 * Flag cloth for cities (separate mesh so it can wave), in the player's colour as a vertex
 * colour like the pieces' own, so one material (flagMaterial) serves every flag.
 */
export function makeFlag(color: PlayerColor): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(0.05, 0.03, 10, 3);
  g.translate(0.025, 0, 0);
  g.deleteAttribute('uv');
  const c = new THREE.Color(PLAYER_PALETTE[color].base);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * A pennant for the Longest Route: a slim pole and a swallow-tailed streamer in the player's
 * colour, flying along +x from the pole's top (drawn with flagMaterial, so the cloth ripples
 * from the pole out and the pole itself stands still).
 */
export function makePennant(color: PlayerColor): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const b = new MeshBuilder();
  const pole = new THREE.CylinderGeometry(0.0011, 0.0014, 0.052, 5);
  b.addGeometry(pole, compose(0, 0.026, 0), C('#4a3322'));
  pole.dispose();
  const knob = new THREE.SphereGeometry(0.0018, 6, 4);
  b.addGeometry(knob, compose(0, 0.053, 0), C(pal.trim));
  knob.dispose();
  // The streamer: a strip of quads tapering to a notched tail, both faces drawn.
  const cloth = C(pal.base), hem = C(pal.trim);
  const L = 0.032, top = 0.0505, H = 0.012, N = 8;
  const rows: number[][] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const x = u * L;
    const h = H * (1 - 0.55 * u);
    const notch = i === N ? h * 0.45 : 0;
    const c = i === 0 ? hem : cloth;
    rows.push([b.vertex(x, top, 0, c, 0, 0, 1), b.vertex(x - notch, top - h / 2, 0, c, 0, 0, 1), b.vertex(x, top - h, 0, c, 0, 0, 1)]);
  }
  for (let i = 0; i < N; i++) {
    b.quad(rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0]);
    b.quad(rows[i][1], rows[i][2], rows[i + 1][2], rows[i + 1][1]);
  }
  return b.build(false);
}

/**
 * The flags' material: cloth rippling in the wind, its colour squared like the pieces' (so it
 * matches its city's banners), and lit like them at night and with "Bright pieces".
 */
export function flagMaterial(night: FloatUniform): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: THREE.DoubleSide });
  // A flag flies downwind (BoardView turns each to the wind, see windward) and ripples along its
  // length: harder and quicker as the wind rises, and in fair weather drooping a little at the fly.
  m.positionNode = Fn(() => {
    const p = positionLocal.toVar();
    const u = positionGeometry.x.div(0.05);
    const w = windTravel.mul(6.4);
    const reach = windStrength.mul(0.5).add(0.5);
    p.z.addAssign(sin(w.sub(u.mul(6))).mul(0.006).mul(u).mul(reach));
    const droop = u.mul(u).mul(0.004).mul(float(1.6).sub(windStrength).max(0));
    p.y.addAssign(sin(w.mul(0.72).sub(u.mul(4))).mul(0.002).mul(u).sub(droop));
    return p;
  })();
  const albedo = vertexAlbedo();
  m.colorNode = vec4(albedo, 1);
  m.emissiveNode = brightLight(albedo, night);
  return m;
}

export const FLAG_OFFSET = new THREE.Vector3(0.055, 0.018 + 0.17 + 0.128, -0.035);

// ---------------------------------------------------------------------------
// Road: a little paved road. A raised bed with kerbs in the player's colour, a cobbled
// surface tinted toward it (so the owner still reads from above) and a bollard at each corner.
// The bed is a plain slab: its cobbles are painted (and lit as raised stones) by roadMaterial,
// so a road is about 1,300 triangles, not the 23,000 of modelled stones.
// ---------------------------------------------------------------------------

export const ROAD_LENGTH = 0.66;
const ROAD_WIDTH = 0.1;
/** The cobbled strip between the kerbs, and the stones laid in it. */
const COBBLE_INNER = ROAD_WIDTH - 0.034;
const COBBLE_LANES = 3;
const COBBLE_LENGTH = 0.026;
/** Height of the cobbled surface (the stones' tops). */
const COBBLE_TOP = 0.026;

export function makeRoad(color: PlayerColor): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const b = new MeshBuilder();
  const L = ROAD_LENGTH, W = ROAD_WIDTH;
  // The bed: its top is the cobbles' colour (the shader lays the stones), its sides the joints'.
  const bed = box(L - 0.006, COBBLE_TOP, W - 0.004, 0.006);
  b.addGeometry(bed, compose(0, COBBLE_TOP / 2, 0), (_x, y, _z, o) => o.set(y > COBBLE_TOP - 0.002 ? pal.base : pal.dark));
  bed.dispose();
  // Kerbs along both edges, jointed every ninth of the road (in the shader).
  b.surfaceId = SURFACE.kerb;
  for (const s of [-1, 1]) {
    const kerb = box(L, 0.03, 0.017, 0.006);
    b.addGeometry(kerb, compose(0, 0.015, s * (W / 2 - 0.0085)), (_x, y, _z, o) => o.set(pal.base).offsetHSL(0, 0, y > 0.028 ? 0.05 : 0));
    kerb.dispose();
  }
  b.surfaceId = SURFACE.plain;
  // Bollards at the four corners, capped in the trim colour.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // On the kerb's outer edge, leaving the full width between them for carts.
      const post = new THREE.CylinderGeometry(0.0058, 0.0066, 0.032, 8, 1, true);
      b.addGeometry(post, compose(sx * (L / 2 - 0.011), 0.03 + 0.016, sz * (W / 2 - 0.0055)), C(pal.base));
      post.dispose();
      const cap = new THREE.SphereGeometry(0.006, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
      b.addGeometry(cap, compose(sx * (L / 2 - 0.011), 0.062, sz * (W / 2 - 0.0055)), C(pal.trim));
      cap.dispose();
    }
  }
  const out = b.build(false);
  if (!out.getAttribute('surface')) out.setAttribute('surface', new THREE.BufferAttribute(new Float32Array(out.getAttribute('position').count), 1));
  return out;
}

/** Weathered grey stone, '#a39b8c' (as a vertex colour: linear, before the material squares it). */
const WEATHERED = vec3(0.366, 0.33, 0.262);

/**
 * Roads (instanced, one draw per seat): painted wood like the other pieces, with the cobbles
 * laid in the shader on the bed's top. Staggered courses of stones a little apart, each its own
 * shade of the player's colour (lighter, darker, a touch of weathered stone), domed so the sun
 * catches their crowns and the joints between them sit in shade; at a distance they blend to
 * their average, as the pixels outgrow them.
 */
export function roadMaterial(night: FloatUniform): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0 });
  const p = positionGeometry;
  const surface = attribute<'float'>('surface', 'float');
  // The seat's lighter and darker stones (its palette's walls and roofs), set per draw: each
  // seat's roads are one instanced mesh carrying them (see cobbleColors).
  const light = uniform(new THREE.Vector3(1, 1, 1)).onObjectUpdate(({ object }) => (object?.userData.cobble as CobbleColors | undefined)?.light);
  const dark = uniform(new THREE.Vector3(1, 1, 1)).onObjectUpdate(({ object }) => (object?.userData.cobble as CobbleColors | undefined)?.dark);
  // The cobbled strip: the bed's top face, between the kerbs.
  const strip = step(COBBLE_TOP - 0.0015, p.y).mul(step(abs(p.z), COBBLE_INNER / 2)).mul(step(surface, 0.5)).mul(step(0.5, normalGeometry.y));
  const cw = COBBLE_INNER / COBBLE_LANES;
  const laneF = p.z.add(COBBLE_INNER / 2).div(cw);
  const lane = floor(laneF);
  const fz = fract(laneF);
  // Every other lane's courses are offset by half a stone; each stone a slightly different length.
  const u = p.x.add(ROAD_LENGTH / 2 - 0.008).sub(lane.mod(2).mul(COBBLE_LENGTH / 2)).div(COBBLE_LENGTH);
  const course = floor(u);
  const fx = fract(u);
  const h1 = hash2(course, lane.add(3.7));
  const h2 = hash2(course.add(11.3), lane);
  // Each stone a little short of its cell, its corners rounded.
  const gx = h2.mul(0.04).add(0.05);
  const ex = smoothstep(0, gx, fx).mul(smoothstep(1, float(1).sub(gx), fx));
  const ez = smoothstep(0, 0.07, fz).mul(smoothstep(1, 0.93, fz));
  const stone = ex.mul(ez);
  const fade = detailFade(1 / cw).mul(strip);
  m.colorNode = Fn(() => {
    const vc = vertexColor().rgb;
    // The stones: a quarter lighter, a quarter darker, the rest the road's own
    // colour, each weathered a little toward grey stone; the joints between them in shade.
    const own = h1.lessThan(0.25).select(light, h1.lessThan(0.5).select(dark, vc));
    const weathered = mix(own, WEATHERED, h2.mul(0.1).add(0.12));
    const joint = dark.mul(0.78);
    const laid = mix(joint, weathered, stone);
    // Afar, the stones' average.
    const average = mix(mix(vc, mix(light, dark, 0.5), 0.5), WEATHERED, 0.17).mul(0.92);
    const c = mix(mix(vc, average, strip), laid, fade);
    // (Vertex colours are stored as square roots of what they render as: see vertexAlbedo.)
    return vec4(c.mul(c).mul(surfaceShade(surface, positionGeometry, normalGeometry, worldScale)), 1);
  })();
  // Raised, rounded stones: a dome inside each, sunk at the joints.
  m.normalNode = bumpedNormal(stone.sqrt().mul(0.0028).add(h2.mul(0.0005)).mul(fade), 1);
  m.roughnessNode = mix(float(0.66), float(0.5), stone.mul(fade));
  // The longest route (its holder's route that wins the award) shimmers faintly gold, a slow glint
  // running along it, so the award's road can be told on the board (`aGlow` per instance, 0..1).
  const glow = attribute<'float'>('aGlow', 'float');
  m.emissiveNode = Fn(() => {
    const vc = vertexColor().rgb;
    const glint = sin(positionWorld.x.add(positionWorld.z).mul(2.2).sub(time.mul(1.6))).mul(0.5).add(0.5);
    return brightLight(vc.mul(vc), night).add(vec3(1.0, 0.72, 0.28).mul(glow.mul(glint.mul(0.1).add(0.06))));
  })();
  // A road joined to the next of its seat's at a corner with no building (see boardView's
  // joinRoads) runs on to the corner and is cut on the mitre there, so the two meet kerb to kerb;
  // its bollards at that end sink into the kerb. Per instance, `aMitre` is each end's cut on either
  // side, as x shifted per unit of z (+x end at z > 0 and z < 0, then the -x end; 0: a square end),
  // and `aAxis` the instance's x axis in the mesh's space and its height scale. (Instancing has
  // already placed positionLocal, so the cut is added along the instance's own axes.)
  const mitre = attribute<'vec4'>('aMitre', 'vec4');
  const axis = attribute<'vec4'>('aAxis', 'vec4');
  m.positionNode = Fn(() => {
    const g = positionGeometry;
    const plus = g.x.greaterThan(0);
    const right = g.z.greaterThan(0);
    const k = plus.select(right.select(mitre.x, mitre.y), right.select(mitre.z, mitre.w));
    const joined = plus.select(abs(mitre.x).add(abs(mitre.y)), abs(mitre.z).add(abs(mitre.w))).greaterThan(0);
    const end = step(ROAD_LENGTH / 2 - 0.02, abs(g.x));
    const shift = g.z.mul(k).mul(end);
    const sink = joined.and(end.greaterThan(0.5)).and(g.y.greaterThan(0.031)).select(float(0.02).sub(g.y), float(0));
    return positionLocal.add(axis.xyz.mul(shift)).add(vec3(0, axis.w.mul(sink), 0));
  })();
  return m;
}

interface CobbleColors {
  light: THREE.Vector3;
  dark: THREE.Vector3;
}

/** The lighter and darker stones of a seat's roads (as vertex colours): set on its road mesh's userData.cobble. */
export function cobbleColors(color: PlayerColor): CobbleColors {
  const pal = PLAYER_PALETTE[color];
  const v = (h: string) => {
    const c = C(h);
    return new THREE.Vector3(c.r, c.g, c.b);
  };
  return { light: v(pal.light), dark: v(pal.dark) };
}

// ---------------------------------------------------------------------------
// Robber: a minimal, sculpted hooded figure (painted cast-metal miniature).
// ---------------------------------------------------------------------------

export function makeRobber(): THREE.BufferGeometry {
  const noise = new Noise(77);
  const pts: THREE.Vector2[] = [];
  const profile: [number, number][] = [
    [0.0, 0.0], [0.074, 0.0], [0.079, 0.012], [0.072, 0.05], [0.064, 0.1], [0.056, 0.15], [0.05, 0.19],
    [0.052, 0.215], [0.058, 0.232], [0.05, 0.248], [0.03, 0.258], [0.0, 0.26],
  ];
  for (const [r, y] of profile) pts.push(new THREE.Vector2(r, y));
  const body = new THREE.LatheGeometry(pts, 48);
  const p = body.getAttribute('position');
  // Cloak folds that deepen towards the hem; slightly squared shoulders.
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    if (r < 1e-5) continue;
    const hem = Math.max(0, 1 - y / 0.2);
    const folds = Math.sin(a * 7 + Math.sin(a * 3) * 0.8) * 0.07 * hem + noise.noise2(a * 3, y * 18) * 0.025 * hem;
    const shoulder = y > 0.2 && y < 0.25 ? 1 + 0.12 * Math.abs(Math.cos(a)) : 1;
    const k = (1 + folds) * shoulder;
    p.setXYZ(i, x * k, y, z * k);
  }
  body.computeVertexNormals();
  const b = new MeshBuilder();
  const cloak = C('#3a3d44');
  const deep = C('#1d1f24');
  b.addGeometry(body, new THREE.Matrix4(), (x, y, z, o) => {
    const a = Math.atan2(z, x);
    const crease = Math.sin(a * 7 + Math.sin(a * 3) * 0.8);
    o.copy(cloak).lerp(deep, Math.max(0, -crease) * 0.45 * Math.max(0, 1 - y / 0.2) + (y < 0.01 ? 0.3 : 0));
  });
  body.dispose();
  // Hood: a sphere pulled into a peak, with a dark recessed opening facing +z.
  const hood = new THREE.SphereGeometry(0.045, 32, 24);
  const hp = hood.getAttribute('position');
  for (let i = 0; i < hp.count; i++) {
    let x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    if (y > 0) {
      const t = y / 0.045;
      z -= t * t * 0.02; // peak sweeps back
      y += t * t * 0.012;
    }
    if (z > 0.015) {
      const open = Math.max(0, 1 - Math.hypot(x / 0.03, (y + 0.004) / 0.032));
      z -= open * 0.03;
    }
    hp.setXYZ(i, x, y, z);
  }
  hood.computeVertexNormals();
  b.addGeometry(hood, compose(0, 0.285, 0.004), (x, y, z, o) => {
    const inOpening = z > -0.01 && Math.hypot(x / 0.03, (y - 0.285 + 0.004) / 0.032) < 0.85 && z < 0.03;
    o.copy(inOpening ? C('#0b0c0e') : cloak);
  });
  hood.dispose();
  const g = b.build(false);
  return withGlow(g, () => 0);
}

export function robberMaterial(night: FloatUniform): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0.35 });
  // Cast-metal patina: broad, low-contrast mottling, a little duller in the hollows, and the
  // upper folds rubbed brighter and smoother as if handled through many games.
  const p = positionGeometry;
  const patina = mx_noise_float(p.mul(24)).mul(0.5).add(0.5);
  const rubbed = smoothstep(0.45, 0.9, normalGeometry.y).mul(smoothstep(0.35, 0.75, mx_noise_float(p.mul(11).add(4.2)).mul(0.5).add(0.5)));
  const albedo = vertexAlbedo().mul(patina.mul(0.12).add(0.94)).mul(rubbed.mul(0.35).add(1));
  m.colorNode = vec4(albedo, 1);
  m.roughnessNode = mix(float(0.55), float(0.3), patina).mul(rubbed.mul(-0.3).add(1));
  // (The robber is near black: it brightens to a dark slate, still clearly the robber.)
  m.emissiveNode = brightLight(albedo.add(0.05), night);
  return m;
}
