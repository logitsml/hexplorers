// Contact map: a world-space texture over the island recording where things meet the
// ground. R = soft occlusion under trees, rocks and buildings; G = worn, trampled ground
// around buildings and at road ends; B = tree canopy overhead (for sunflecks); A = how far up
// the shore the last flood reached (see setFlood). The terrain darkens and wears where objects
// stand, so they sit in the land instead of floating on it.
// Decor is splatted once per board (the static layer); buildings and roads change during
// play and are re-splatted when they do.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { float, texture, vec2 } from 'three/tsl';

const SIZE = 512;

type TexNode = ReturnType<typeof texture>;

/**
 * The texture node every material samples the contact map through. One for all maps: a new
 * board's map takes it over, so materials made for an earlier board (kept for the next, rather
 * than rebuilt) read the current one.
 */
let sharedNode: TexNode | null = null;

/** How many textures the maps take turns with (see make). */
const RING = 3;

/**
 * The textures every map draws through, in turn: each commit fills the next and hands it to the
 * shared node. They are kept for the session, never disposed. The renderer remembers the texture
 * a material's shader was first built with and uploads it again whenever a new object starts
 * drawing with that material, before it looks at the node's current one: a texture disposed by
 * then would be uploaded once more and never let go of (a megabyte a game, as a piece appears late
 * in it). Writing into one that may still be in a frame on its way is safe: the GPU takes the
 * upload after the frames already sent.
 */
const ring: THREE.DataTexture[] = [];
let turn = 0;

export class ContactMap {
  /** Half-width of the covered square (world units), centred on the board. */
  readonly extent = 7;
  // RGBA, 8 bits each (A the flood's mark): plenty for soft shade and wear, half the upload of floats.
  private data = new Uint8Array(SIZE * SIZE * 4);
  private base = [0, 0, 0].map(() => new Float32Array(SIZE * SIZE));
  private live = [0, 0, 0].map(() => new Float32Array(SIZE * SIZE));
  /**
   * Every sampler shares this node. Each commit gives it the ring's next texture rather than
   * updating the one on show in place: in-place updates of this texture reach the GPU but are
   * intermittently never seen by the terrain's shader (it keeps sampling stale contents).
   */
  private node: TexNode;
  /** This map's texture now on show (the shared node's, unless a newer map has taken over). */
  private current: THREE.Texture;
  /** Texels changed since the last commit (x0, z0, x1, z1 inclusive), and where the live layer has anything. */
  private dirty: number[] | null = null;
  private liveBox: number[] | null = null;

  constructor() {
    this.current = this.make();
    if (sharedNode) sharedNode.value = this.current;
    else sharedNode = texture(this.current);
    this.node = sharedNode;
  }

  private static union(box: number[] | null, x0: number, z0: number, x1: number, z1: number) {
    return box ? [Math.min(box[0], x0), Math.min(box[1], z0), Math.max(box[2], x1), Math.max(box[3], z1)] : [x0, z0, x1, z1];
  }

  /** The next texture of the ring, filled with the map as it is now. */
  private make() {
    turn = (turn + 1) % RING;
    let t = ring[turn];
    if (!t) {
      t = ring[turn] = new THREE.DataTexture(new Uint8Array(SIZE * SIZE * 4), SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    }
    (t.image.data as Uint8Array).set(this.data);
    t.needsUpdate = true;
    return t;
  }

  /** Occlusion, wear and canopy at a world xz position (0..1 each). */
  sample(xz: Node<'vec2'>): Node<'vec3'> {
    const s = this.node.sample(xz.div(this.extent * 2).add(vec2(0.5, 0.5))) as unknown as Node<'vec4'>;
    return s.xyz;
  }

  /**
   * How far up the shore a flood reached at a world xz position (0 dry, 1 at the water's edge),
   * from the last `setFlood`: the coast's wetness after it drains is graded by it.
   */
  flood(xz: Node<'vec2'>): Node<'float'> {
    return (this.node.sample(xz.div(this.extent * 2).add(vec2(0.5, 0.5))) as unknown as Node<'vec4'>).w;
  }

  /**
   * Mark how far up the shore a flood reached, `at(x, z)` (0..1, world units), in the map's
   * otherwise unused alpha channel (see flood); null clears it. The whole map at once, as a fresh
   * texture like `commit`'s (a flood comes a few times a game at most).
   */
  setFlood(at: ((x: number, z: number) => number) | null) {
    const k = (this.extent * 2) / SIZE;
    for (let j = 0; j < SIZE; j++) {
      const z = (j + 0.5) * k - this.extent;
      for (let i = 0; i < SIZE; i++) {
        const v = at ? at((i + 0.5) * k - this.extent, z) : 0;
        this.data[(j * SIZE + i) * 4 + 3] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
      }
    }
    this.current = this.make();
    this.node.value = this.current;
  }

  /** Clear one layer inside a world-space box (x0, z0)..(x1, z1), so what stood there can be splatted afresh. */
  clearBox(layer: 'base' | 'live', x0: number, z0: number, x1: number, z1: number) {
    const k = SIZE / (this.extent * 2);
    const i0 = Math.max(0, Math.floor((x0 + this.extent) * k)), i1 = Math.min(SIZE - 1, Math.ceil((x1 + this.extent) * k));
    const j0 = Math.max(0, Math.floor((z0 + this.extent) * k)), j1 = Math.min(SIZE - 1, Math.ceil((z1 + this.extent) * k));
    if (i0 > i1 || j0 > j1) return;
    for (const a of this[layer]) for (let j = j0; j <= j1; j++) a.fill(0, j * SIZE + i0, j * SIZE + i1 + 1);
    this.dirty = ContactMap.union(this.dirty, i0, j0, i1, j1);
  }

  clear(layer: 'base' | 'live') {
    for (const a of this[layer]) a.fill(0);
    if (layer === 'base') this.dirty = [0, 0, SIZE - 1, SIZE - 1];
    else if (this.liveBox) {
      const [x0, z0, x1, z1] = this.liveBox;
      this.dirty = ContactMap.union(this.dirty, x0, z0, x1, z1);
      this.liveBox = null;
    }
  }

  /** A round blot, full strength inside and soft at the rim, combined by maximum. */
  splat(layer: 'base' | 'live', x: number, z: number, radius: number, ao: number, wear: number, canopy = 0) {
    const [A, W, K] = this[layer];
    const k = SIZE / (this.extent * 2);
    const cx = (x + this.extent) * k, cz = (z + this.extent) * k, r = radius * k;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(SIZE - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(SIZE - 1, Math.ceil(cz + r));
    if (x0 > x1 || z0 > z1) return;
    this.dirty = ContactMap.union(this.dirty, x0, z0, x1, z1);
    if (layer === 'live') this.liveBox = ContactMap.union(this.liveBox, x0, z0, x1, z1);
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) / r;
        if (d >= 1) continue;
        // Full strength over the inner part, then a soft edge.
        const e = Math.min(1, Math.max(0, (d - 0.4) / 0.6));
        const f = 1 - e * e * (3 - 2 * e);
        const o = j * SIZE + i;
        if (ao * f > A[o]) A[o] = ao * f;
        if (wear * f > W[o]) W[o] = wear * f;
        if (canopy * f > K[o]) K[o] = canopy * f;
      }
    }
  }

  /**
   * Upload the combined layers (as a fresh texture). Only the texels changed since the last
   * commit are converted (most of the map is empty, and a new road or house touches a few).
   */
  commit() {
    if (!this.dirty) return;
    const [x0, z0, x1, z1] = this.dirty;
    this.dirty = null;
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        const o = j * SIZE + i;
        for (let c = 0; c < 3; c++) {
          const v = Math.max(this.base[c][o], this.live[c][o]);
          this.data[o * 4 + c] = v >= 1 ? 255 : Math.round(v * 255);
        }
      }
    }
    this.current = this.make();
    this.node.value = this.current;
  }

  /** (The ring's textures are kept for the next map.) */
  dispose() {}
}

const TRAIL = 256;

/**
 * Trails: where sheep and travellers have walked, lain or grazed. Unlike the contact map this
 * one has a memory that fades, as the sea's foam does: each step presses the grass down a
 * little, and it springs back over the following minute.
 */
export class TrailMap {
  readonly extent = 7;
  private wear = new Float32Array(TRAIL * TRAIL);
  private bytes = new Uint8Array(TRAIL * TRAIL);
  private node: TexNode;
  private tex: THREE.DataTexture;
  private since = 0;
  private active = false;

  constructor() {
    // One texture, its contents rewritten a few times a second (not a new texture each time).
    const t = (this.tex = new THREE.DataTexture(this.bytes, TRAIL, TRAIL, THREE.RedFormat, THREE.UnsignedByteType));
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    this.node = texture(t);
  }

  /** How trodden the ground is at a world xz position (0..1). */
  sample(xz: Node<'vec2'>): Node<'float'> {
    return (this.node.sample(xz.div(this.extent * 2).add(vec2(0.5, 0.5))) as unknown as Node<'vec4'>).x;
  }

  /** The same, for the vertex stage (no derivatives there to pick a mip level from). */
  sampleLevel(xz: Node<'vec2'>): Node<'float'> {
    return (this.node.sample(xz.div(this.extent * 2).add(vec2(0.5, 0.5))).level(float(0)) as unknown as Node<'vec4'>).x;
  }

  /** Forget every trail (a new board). */
  clear() {
    this.wear.fill(0);
    this.bytes.fill(0);
    this.tex.needsUpdate = true;
    this.active = false;
  }

  /** Press the ground at (x, z): soft-edged, adding up to fully trodden. */
  stamp(x: number, z: number, radius: number, amount: number) {
    const k = TRAIL / (this.extent * 2);
    const cx = (x + this.extent) * k, cz = (z + this.extent) * k, r = Math.max(radius * k, 0.75);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(TRAIL - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(TRAIL - 1, Math.ceil(cz + r));
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) / r;
        if (d >= 1) continue;
        const o = j * TRAIL + i;
        this.wear[o] = Math.min(1, this.wear[o] + amount * (1 - d * d));
      }
    }
    this.active = true;
  }

  /** Fade the trails and upload them a few times a second. */
  update(dt: number) {
    this.since += dt;
    if (!this.active || this.since < 0.25) return;
    // Half-life of about 40 seconds.
    const keep = Math.exp(-this.since / 58);
    this.since = 0;
    let any = false;
    for (let o = 0; o < this.wear.length; o++) {
      // (Untrodden ground, most of it, is already zero in both.)
      if (this.wear[o] === 0) continue;
      const v = this.wear[o] * keep;
      this.wear[o] = v < 0.002 ? 0 : v;
      this.bytes[o] = Math.round(this.wear[o] * 255);
      any = true;
    }
    this.active = any;
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.tex.dispose();
  }
}
