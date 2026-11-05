// Number discs: raised, bevelled resin-ivory tokens with engraved numerals and
// probability pips (6 and 8 in red).

import * as THREE from 'three/webgpu';
import { Fn, texture, uv, vec2, vec3, vec4, float, attribute, sin, time } from 'three/tsl';
import { PIPS } from '../../engine/constants';
import { DETAIL_LAYER } from './layout';
import { capacity } from './instancing';
import { brightLift } from './pieces';

import type { Terrain } from '../../engine';
import { TOKEN_RADIUS, discSpots, type DiscSpot } from './discSpots';

export { TOKEN_RADIUS };
const THICK = 0.05;

/** The numbers a disc can show, in the order of the face atlas's cells. */
const NUMBERS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
const CELL = 512;
const COLS = 5;
const ROWS = 2;
const FONT = '"Fraunces Variable", Georgia, serif';

function drawFace(ctx: CanvasRenderingContext2D, n: number, x0: number, y0: number, size = CELL) {
  ctx.save();
  ctx.translate(x0, y0);
  ctx.beginPath();
  ctx.rect(0, 0, size, size);
  ctx.clip();
  const red = n === 6 || n === 8;
  // Face: warm ivory with a subtle radial sheen and an inner engraved ring.
  const g = ctx.createRadialGradient(size * 0.42, size * 0.38, size * 0.05, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, '#f9e9c2');
  g.addColorStop(0.7, '#efd9a6');
  g.addColorStop(1, '#d9bc80');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(120, 90, 40, 0.35)';
  ctx.lineWidth = size * 0.012;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.43, 0, Math.PI * 2);
  ctx.stroke();
  const ink = red ? '#b0241a' : '#2a1d12';
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${size * (n >= 10 ? 0.46 : 0.54)}px ${FONT}`;
  // Engraving: a light offset highlight below the glyph.
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(String(n), size / 2 + size * 0.004, size * 0.63 + size * 0.006);
  ctx.restore();
  ctx.fillText(String(n), size / 2, size * 0.63);
  // Underline 6/9 to disambiguate when rotated.
  if (n === 6 || n === 9) {
    ctx.fillRect(size * 0.41, size * 0.665, size * 0.18, size * 0.018);
  }
  const pips = PIPS[n] ?? 0;
  const pr = size * 0.03;
  const total = pips * pr * 2.6;
  for (let i = 0; i < pips; i++) {
    ctx.beginPath();
    ctx.arc(size / 2 - total / 2 + pr * 1.3 + i * pr * 2.6, size * 0.78, pr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Every face in one canvas, NUMBERS in rows of COLS. */
function drawAtlas(ctx: CanvasRenderingContext2D) {
  NUMBERS.forEach((n, i) => drawFace(ctx, n, (i % COLS) * CELL, Math.floor(i / COLS) * CELL));
}

interface TokenParts {
  geometry: THREE.BufferGeometry;
  faceGeometry: THREE.BufferGeometry;
  rimMaterial: THREE.MeshStandardNodeMaterial;
  faceMaterial: THREE.MeshStandardNodeMaterial;
  canvas: HTMLCanvasElement;
  atlas: THREE.CanvasTexture;
  /** Whether the faces were lettered in the display font (or a fallback, to be redone). */
  font: boolean;
}

/**
 * What every disc shares, made once for the session: the body, the face (one material for all,
 * reading its number's cell of one atlas and its own glow per disc, both from its instance) and
 * the atlas itself.
 */
let shared: TokenParts | null = null;

function fontReady() {
  return document.fonts?.check?.(`700 64px ${FONT}`) ?? true;
}

function tokenParts(): TokenParts {
  if (shared) {
    if (!shared.font && fontReady()) {
      // The display font had not loaded when the faces were first painted.
      shared.font = true;
      drawAtlas(shared.canvas.getContext('2d')!);
      shared.atlas.needsUpdate = true;
    }
    return shared;
  }
  // Lathe profile: bevelled edge and a slightly domed top.
  const pts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(TOKEN_RADIUS - 0.012, 0),
    new THREE.Vector2(TOKEN_RADIUS, 0.01),
    new THREE.Vector2(TOKEN_RADIUS, THICK - 0.012),
    new THREE.Vector2(TOKEN_RADIUS - 0.01, THICK),
    new THREE.Vector2(0, THICK + 0.003),
  ];
  const canvas = document.createElement('canvas');
  canvas.width = CELL * COLS;
  canvas.height = CELL * ROWS;
  drawAtlas(canvas.getContext('2d')!);
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 8;
  // Per disc, from its instance (see TokenFactory.sync): which cell its number is (column, row),
  // and how strongly it glows.
  const cell = attribute<'vec2'>('aCell', 'vec2');
  const highlight = attribute<'float'>('aGlow', 'float');
  const faceMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 });
  // (The canvas is flipped: its first row is the texture's top.)
  const tex = texture(atlas, vec2(uv().x.add(cell.x).div(COLS), uv().y.add(float(ROWS - 1).sub(cell.y)).div(ROWS)));
  faceMaterial.colorNode = Fn(() => vec4(tex.rgb, 1))();
  faceMaterial.emissiveNode = Fn(() => {
    const pulse = sin(time.mul(6)).mul(0.3).add(0.7);
    // (With "Bright pieces" the discs light themselves as the pieces do, so a number reads at night.)
    return vec3(1.0, 0.75, 0.3).mul(highlight.mul(pulse).mul(0.55)).add(tex.rgb.mul(float(0.04))).add(brightLift(tex.rgb));
  })();
  const rimMaterial = new THREE.MeshStandardNodeMaterial({ color: '#d8b77a', roughness: 0.5, metalness: 0 });
  const rim = new THREE.Color('#d8b77a');
  rimMaterial.emissiveNode = brightLift(vec3(rim.r, rim.g, rim.b));
  return (shared = {
    geometry: new THREE.LatheGeometry(pts, 64),
    faceGeometry: new THREE.CircleGeometry(TOKEN_RADIUS - 0.014, 64),
    rimMaterial,
    faceMaterial,
    canvas,
    atlas,
    font: fontReady(),
  });
}

/**
 * The board's discs. Each disc is a group of two stand-ins, its body and its face, moved, lifted,
 * spun and hidden as a disc of its own would be; every frame (see sync) their places are copied into
 * two instanced meshes, the bodies' and the faces', so all the board's discs are two draws (and
 * one in the shadow map) rather than two each (and one more each in the shadow map).
 */
export class TokenFactory {
  private parts = tokenParts();
  private stands: { body: THREE.Object3D; face: THREE.Object3D }[] = [];
  private bodies: THREE.InstancedMesh | null = null;
  private faces: THREE.InstancedMesh | null = null;
  private cells: THREE.InstancedBufferAttribute | null = null;
  private glows: THREE.InstancedBufferAttribute | null = null;
  private parent: THREE.Object3D | null = null;
  private stage: { beforeDraw: Set<() => void> } | null = null;
  private readonly synced = () => this.sync();

  get rimMaterial() {
    return this.parts.rimMaterial;
  }

  /** The discs' meshes go under `parent` (the board's), and are drawn from the stand-ins just before each frame is. */
  attach(parent: THREE.Object3D, stage: { beforeDraw: Set<() => void> }) {
    this.parent = parent;
    this.stage = stage;
    stage.beforeDraw.add(this.synced);
  }

  /** Room for `n` discs: the meshes made anew at the next capacity when there is too little. */
  private reserve(n: number) {
    if (!this.parent || (this.bodies && this.bodies.instanceMatrix.count >= n)) return;
    // (A capacity three bakes into the shaders: sizes in steps, see instancing.ts.)
    // (With room to spare for discs a found hex brings: a new mesh mid-game would build its shaders on sight.)
    const cap = capacity(Math.max(32, n + 8));
    this.dropMeshes();
    const { geometry, faceGeometry, rimMaterial, faceMaterial } = this.parts;
    const bodies = new THREE.InstancedMesh(geometry, rimMaterial, cap);
    bodies.castShadow = true;
    bodies.receiveShadow = true;
    // (Its own face geometry: the per-disc attributes live on it.)
    const fg = faceGeometry.clone();
    this.cells = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.glows = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    fg.setAttribute('aCell', this.cells);
    fg.setAttribute('aGlow', this.glows);
    const faces = new THREE.InstancedMesh(fg, faceMaterial, cap);
    faces.receiveShadow = true;
    for (const m of [bodies, faces]) {
      m.count = 0;
      // (Spread over the island, and moving: never culled as one.)
      m.frustumCulled = false;
      // Flat on the tile tops, they never show in the sea's mirror: kept out of it.
      m.layers.set(DETAIL_LAYER);
      this.parent.add(m);
    }
    this.bodies = bodies;
    this.faces = faces;
  }

  private dropMeshes() {
    for (const m of [this.bodies, this.faces]) {
      if (!m) continue;
      m.removeFromParent();
      m.dispose();
    }
    this.faces?.geometry.dispose();
    this.bodies = this.faces = null;
  }

  /**
   * Each disc's body and face where its stand-ins are now (after the scene's transforms are
   * brought up to date), with its number's cell and its glow; a disc not on show (it, or a group
   * it is in, hidden, or not in the scene) is drawn at no size.
   */
  sync() {
    const n = this.stands.length;
    const bodies = this.bodies, faces = this.faces, parent = this.parent;
    if (!n || !bodies || !faces || !parent) return;
    let root: THREE.Object3D = parent;
    while (root.parent) root = root.parent;
    inverse.copy(parent.matrixWorld).invert();
    const cells = this.cells!.array as Float32Array, glows = this.glows!.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const { body, face } = this.stands[i];
      if (!onShow(face, root)) {
        bodies.setMatrixAt(i, NONE);
        faces.setMatrixAt(i, NONE);
        continue;
      }
      bodies.setMatrixAt(i, place.multiplyMatrices(inverse, body.matrixWorld));
      faces.setMatrixAt(i, place.multiplyMatrices(inverse, face.matrixWorld));
      const cell = face.userData.cell as THREE.Vector2;
      cells[i * 2] = cell.x;
      cells[i * 2 + 1] = cell.y;
      glows[i] = (face.userData.highlight as { value: number }).value;
    }
    bodies.count = faces.count = n;
    bodies.instanceMatrix.needsUpdate = faces.instanceMatrix.needsUpdate = true;
    this.cells!.needsUpdate = this.glows!.needsUpdate = true;
  }

  /**
   * A token group: bevelled body + printed face. `highlight` drives a golden glow on this disc alone,
   * and `setNumber` reprints its face (a resurvey moves numbers about).
   */
  create(n: number): { group: THREE.Group; highlight: { value: number }; setNumber: (k: number) => void } {
    const group = new THREE.Group();
    // (Stand-ins: the discs are drawn by the factory's instanced meshes, see sync.)
    const body = new THREE.Object3D();
    group.add(body);
    const highlight = { value: 0 };
    const face = new THREE.Object3D();
    const cell = new THREE.Vector2();
    const setNumber = (k: number) => {
      const i = Math.max(0, NUMBERS.indexOf(k));
      cell.set(i % COLS, Math.floor(i / COLS));
    };
    setNumber(n);
    face.userData.cell = cell;
    face.userData.highlight = highlight;
    face.rotation.x = -Math.PI / 2;
    face.position.y = THICK + 0.0035;
    group.add(face);
    this.stands.push({ body, face });
    this.reserve(this.stands.length);
    return { group, highlight, setNumber };
  }

  /**
   * The discs of one hex, arranged round its centre: a single disc, or (on a hex with several
   * numbers: the lake's four, a feature hex's two) a neat cluster of smaller ones. `groundAt`
   * gives the ground's height at a point relative to the centre's, so each disc sits on the
   * ground beneath it. The cluster's `group` and `highlight` act on all of it as on one disc
   * (the opening spins it down, a yield lifts it), while `pulse` lifts and lights only the discs
   * showing the number rolled, and a yield's glow then stays on those.
   */
  cluster(numbers: number[], groundAt: (x: number, z: number) => number, terrain?: Terrain): DiscCluster {
    const group = new THREE.Group();
    const highlight = { value: 0 };
    const discs: Disc[] = [];
    for (const n of numbers) {
      const d = this.create(n);
      const disc: Disc = { ...d, n, lit: false };
      d.group.children[1].userData.highlight = discGlow(disc, discs, highlight);
      group.add(d.group);
      discs.push(disc);
    }
    const layout = (ns: number[]) => {
      const spots = discLayout(ns.length, terrain);
      discs.forEach((d, i) => {
        d.group.visible = i < ns.length;
        if (i >= ns.length) return;
        d.n = ns[i];
        d.setNumber(ns[i]);
        const { x, z, s } = spots[i];
        // (On the highest ground under its rim, so it never cuts into a slope.)
        let y = groundAt(x, z);
        for (let k = 0; k < 6; k++) y = Math.max(y, groundAt(x + Math.cos(k * 1.047) * TOKEN_RADIUS * s * 0.8, z + Math.sin(k * 1.047) * TOKEN_RADIUS * s * 0.8));
        d.group.position.set(x, discs.length > 1 ? y : 0, z);
        d.group.userData.baseY = d.group.position.y;
        d.group.scale.setScalar(s);
      });
    };
    layout(numbers);
    const pulse = (n: number, strength: number, anim: (rise: (t: number) => void, glow: (t: number) => void) => void) => {
      for (const d of discs) {
        d.lit = d.group.visible && d.n === n;
        if (!d.lit) continue;
        const y0 = d.group.userData.baseY as number;
        d.highlight.value = strength;
        anim(
          (t) => (d.group.position.y = y0 + Math.sin(t * Math.PI) * 0.12),
          (t) => (d.highlight.value = strength * (1 - t)),
        );
      }
    };
    return { group, highlight, discs, setNumbers: layout, pulse };
  }

  /** The board's instanced meshes go; the discs' geometry, materials and faces are kept for the next board. */
  dispose() {
    this.stage?.beforeDraw.delete(this.synced);
    this.dropMeshes();
    this.stands = [];
  }
}

const NONE = new THREE.Matrix4().makeScale(0, 0, 0);
const inverse = new THREE.Matrix4();
const place = new THREE.Matrix4();

/** Whether `o` is drawn: it and every group it is in shown, all the way up to `root`'s scene. */
function onShow(o: THREE.Object3D, root: THREE.Object3D) {
  let p: THREE.Object3D | null = o;
  for (; p; p = p.parent) {
    if (!p.visible) return false;
    if (!p.parent) return p === root;
  }
  return false;
}

interface Disc {
  group: THREE.Group;
  highlight: { value: number };
  setNumber: (k: number) => void;
  /** The number it shows. */
  n: number;
  /** Rolled last: a yield of its hex lights it. */
  lit: boolean;
}

/**
 * What a cluster's disc face glows with: its own pulse, or the whole hex's yield where it was
 * rolled (on the discs last rolled, or on all of them when none was). Made out here, not in
 * `cluster`, so the getter closes over the discs alone and not over the cluster's ground lookup,
 * which holds the board's view: the renderer can keep a face past its board (see release.ts).
 */
function discGlow(disc: Disc, discs: Disc[], yieldGlow: { value: number }): { value: number } {
  return {
    get value() {
      return Math.max(disc.highlight.value, disc.lit || discs.length === 1 || !discs.some((o) => o.lit) ? yieldGlow.value : 0);
    },
  };
}

export interface DiscCluster {
  /** All of the hex's discs (moved as one by the opening and by a yield). */
  group: THREE.Group;
  /** A yield's glow (on the discs last rolled, or the only one). */
  highlight: { value: number };
  discs: Disc[];
  /** Show these numbers (a resurvey or pollution changes them), arranged afresh. */
  setNumbers: (ns: number[]) => void;
  /** Lift and light the discs showing `n`; `anim` runs the lift (0..1) and then the glow's fade. */
  pulse: (n: number, strength: number, anim: (rise: (t: number) => void, glow: (t: number) => void) => void) => void;
}

/** Where each of `n` discs on one hex stands (see discSpots.ts; the lake floats its four on the water). */
export function discLayout(n: number, terrain?: Terrain): DiscSpot[] {
  return discSpots(n, terrain);
}
