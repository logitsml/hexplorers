// The life's props drawn as instances: a mine's entrance, cart, headframe and miner on every
// mountain, a kiln's chimney and log racks on every hill, are each one draw for the whole board
// rather than one per hex (and one more each in the shadow map), which three otherwise prepares
// apiece every frame.
//
// A module asks for a mesh of a geometry and a tile prop material, or the shared prop material and
// a tile (see materials.ts), and gets a stand-in: an empty object it places, moves, scales, hides
// and parents as it would the mesh. Just before each frame is drawn (Stage.beforeDraw) every
// stand-in's place is copied into the instanced mesh for its shape, look and shadows, with its
// tile, size and origin, which the instanced twin of its material reads where the tile's own
// material, or its geometry, had them (see tilePropInstancedMaterial, propInstancedMaterial).
// Anything else asked for is a plain mesh, as before.

import { writeMatrix, writeValue } from '../util/matrices';
import * as THREE from 'three/webgpu';
import { capacity } from './instancing';
import { propBatchedMaterial, propInstancedMaterial, propLookOf, tilePropInstancedMaterial, tilePropOf, type PropOptions, type TileEffects } from './materials';
import { StandInBatch } from './standInBatch';

interface Stand {
  obj: THREE.Object3D;
  geo: THREE.BufferGeometry;
  /** The instanced twin of its material. */
  material: THREE.Material;
  /** Whether that reads the geometry's surface ids (a geometry without them gets zeros). */
  surfaces: boolean;
  tile: number;
  batch: Batch | null;
  /** Its shadows and layers when it joined its batch (a batch is for one set of them). */
  flags: number;
  mask: number;
  /** Whether it has been in the scene (one gone from it since is let go). */
  seen: boolean;
}

interface Batch {
  key: string;
  stands: Stand[];
  mesh: THREE.InstancedMesh | null;
  data: THREE.InstancedInterleavedBuffer | null;
  /** A bigger mesh made mid-game, warming up (see build): it takes over once its shaders are built. */
  next: { mesh: THREE.InstancedMesh; data: THREE.InstancedInterleavedBuffer } | null;
}

/**
 * Where the batches draw and how they keep from stalling a frame: the stage's hook before each
 * frame is drawn, and (the World) whether the board's island has been compiled, after which a mesh
 * made for it is warmed hidden first (see World.warm).
 */
export interface BatchHost {
  beforeDraw: Set<() => void>;
  readonly compiled?: boolean;
  warm?(objects: THREE.Object3D[]): Promise<void>;
}

/** Per instance: its tile, its scale, and its origin (x, y, z). */
const STRIDE = 5;
const NONE = new THREE.Matrix4().makeScale(0, 0, 0);
const inverse = new THREE.Matrix4();
const place = new THREE.Matrix4();
const axis = new THREE.Vector3();

export class PropBatches {
  private stands: Stand[] = [];
  private batches = new Map<string, Batch>();
  /** The same batches, to go through each frame without an iterator. */
  private list: Batch[] = [];
  private ids = new WeakMap<THREE.BufferGeometry, number>();
  private nextId = 1;
  private readonly synced = () => this.sync();

  constructor(
    private effects: TileEffects,
    /** Where the instanced meshes go (the life's group). */
    private parent: THREE.Object3D,
    private stage: BatchHost,
    /**
     * Where the batched meshes go (see part): out of the life's bundle, which can't hold one.
     * None on WebGL2, where a part is a mesh.
     */
    private loose: THREE.Object3D | null = null,
  ) {
    stage.beforeDraw.add(this.synced);
  }

  /** Whether parts are batched (WebGPU). */
  get batching() {
    return this.loose !== null;
  }

  /** The glowing parts' batched mesh (see glow). */
  private glowing: StandInBatch | null = null;

  /**
   * A glowing part (a kiln's fire mouth, a mine's lantern): a stand-in in one batched mesh of every
   * such part on the board, unlit, its colour set each frame with `set` (its heat, the hour), rather
   * than a material of its own for each. Null without batched meshes (WebGL2), or when its
   * geometry can't join: the caller makes it a mesh.
   */
  glow(geo: THREE.BufferGeometry, color: THREE.Color): { obj: THREE.Object3D; set(c: THREE.Color): void } | null {
    if (!this.loose) return null;
    if (!this.glowing) {
      this.glowing = new StandInBatch(() => new THREE.MeshBasicNodeMaterial({ color: '#ffffff' }), { instances: 32, vertices: 4096, indices: 8192 }, { castShadow: false, receiveShadow: false }, this.loose, this.stage, 'glow');
      if (this.stage.compiled && this.stage.warm) void this.stage.warm([this.glowing.mesh]);
    }
    const batch = this.glowing;
    const obj = new THREE.Object3D();
    if (!batch.add(obj, geo)) return null;
    batch.setColor(obj, color);
    return { obj, set: (c) => batch.setColor(obj, c) };
  }

  /** The expansions' moving parts' batched meshes, one per look and shadow (see part). */
  private loosed = new Map<string, StandInBatch>();

  /**
   * A moving part of one of the expansions' looks (a raft, a camel's leg, a mill wheel): a stand-in
   * in the batched mesh for its look, every part of it across the board one draw whatever its
   * shape; or null without batched meshes (WebGL2), or when its geometry can't join (the caller
   * makes a mesh of it). `geo` carries its tile already.
   */
  part(geo: THREE.BufferGeometry, look: PropOptions, castShadow: boolean, layers: number): THREE.Object3D | null {
    if (!this.loose) return null;
    const key = `${JSON.stringify(look)}|${castShadow}|${layers}`;
    let batch = this.loosed.get(key);
    if (!batch) {
      batch = new StandInBatch((mesh) => propBatchedMaterial(this.effects, look, mesh), { instances: 256, vertices: 32768, indices: 65536 }, { castShadow, receiveShadow: true, layers }, this.loose, this.stage, 'parts');
      // (A look first found mid-game: its mesh warms up hidden, see World.warm.)
      if (this.stage.compiled && this.stage.warm) void this.stage.warm([batch.mesh]);
      this.loosed.set(key, batch);
    }
    const obj = new THREE.Object3D();
    return batch.add(obj, geo) ? obj : null;
  }

  /**
   * A mesh of `geo` drawn with `material`: a stand-in drawn as an instance when `material` is a
   * tile prop material, or the shared prop material (on `tile`), otherwise a mesh.
   */
  mesh(geo: THREE.BufferGeometry, material: THREE.Material, tile?: number): THREE.Object3D {
    const prop = tilePropOf(material);
    const look = prop ? null : propLookOf(material);
    if (!prop && !(look && tile !== undefined)) return new THREE.Mesh(geo, material);
    const twin = prop ? tilePropInstancedMaterial(this.effects, prop.opts) : propInstancedMaterial(this.effects, look!);
    const obj = new THREE.Object3D();
    this.stands.push({ obj, geo, material: twin, surfaces: !!(prop ? prop.opts.surfaces : look!.surfaces), tile: prop ? prop.tile : tile!, batch: null, flags: 0, mask: 0, seen: false });
    return obj;
  }

  private matId(m: THREE.Material) {
    let id = this.mats.get(m);
    if (id === undefined) this.mats.set(m, (id = this.nextId++));
    return id;
  }
  private mats = new WeakMap<THREE.Material, number>();

  private geoId(g: THREE.BufferGeometry) {
    let id = this.ids.get(g);
    if (id === undefined) this.ids.set(g, (id = this.nextId++));
    return id;
  }

  /** Every stand-in's place into its batch (once the scene's transforms are up to date). */
  sync() {
    if (!this.stands.length) return;
    let root: THREE.Object3D = this.parent;
    while (root.parent) root = root.parent;
    // Stand-ins into the batch for their shape, look and shadows (set after they were made, so
    // read here), and those gone from the scene out of theirs.
    for (let i = this.stands.length - 1; i >= 0; i--) {
      const s = this.stands[i];
      const top = topOf(s.obj);
      if (top === root) s.seen = true;
      else if (s.seen) {
        this.leave(s);
        this.stands.splice(i, 1);
        continue;
      }
      const flags = (s.obj.castShadow ? 1 : 0) | (s.obj.receiveShadow ? 2 : 0);
      const mask = s.obj.layers.mask;
      if (s.batch && s.flags === flags && s.mask === mask) continue;
      s.flags = flags;
      s.mask = mask;
      const key = `${this.geoId(s.geo)}|${this.matId(s.material)}|${flags}|${mask}`;
      if (s.batch?.key === key) continue;
      this.leave(s);
      let b = this.batches.get(key);
      if (!b) {
        this.batches.set(key, (b = { key, stands: [], mesh: null, data: null, next: null }));
        this.list.push(b);
      }
      b.stands.push(s);
      s.batch = b;
    }
    inverse.copy(this.parent.matrixWorld).invert();
    for (let k = this.list.length - 1; k >= 0; k--) {
      const b = this.list[k];
      const n = b.stands.length;
      if (!n) {
        this.drop(b, true);
        this.batches.delete(b.key);
        this.list.splice(k, 1);
        continue;
      }
      if ((!b.mesh || b.mesh.instanceMatrix.count < n) && !b.next) this.build(b, n);
      // (While a bigger mesh warms up, the one there draws what it has room for.)
      if (!b.mesh) continue;
      const mesh = b.mesh, data = b.data!.array as Float32Array, matrices = mesh.instanceMatrix.array as Float32Array;
      const shown = Math.min(n, mesh.instanceMatrix.count);
      // (Uploaded only if something moved: most props stand still.)
      let moved = false, changed = false;
      for (let i = 0; i < shown; i++) {
        const s = b.stands[i];
        const o = i * STRIDE;
        if (writeValue(data, o, s.tile)) changed = true;
        if (!onShow(s.obj, root)) {
          if (writeMatrix(matrices, i * 16, NONE)) moved = true;
          continue;
        }
        place.multiplyMatrices(inverse, s.obj.matrixWorld);
        if (writeMatrix(matrices, i * 16, place)) moved = true;
        const e = place.elements;
        if (writeValue(data, o + 1, axis.set(e[0], e[1], e[2]).length())) changed = true;
        if (writeValue(data, o + 2, e[12])) changed = true;
        if (writeValue(data, o + 3, e[13])) changed = true;
        if (writeValue(data, o + 4, e[14])) changed = true;
      }
      mesh.count = shown;
      if (moved) mesh.instanceMatrix.needsUpdate = true;
      if (changed) b.data!.needsUpdate = true;
    }
  }

  private leave(s: Stand) {
    if (!s.batch) return;
    const list = s.batch.stands;
    const i = list.indexOf(s);
    if (i >= 0) list.splice(i, 1);
    s.batch = null;
  }

  /** The batch's instanced mesh, made anew with room for `n` (in the steps three's shaders share, see instancing.ts). */
  /**
   * The batch's instanced mesh, made anew with room for `n` and some to spare (in the steps
   * three's shaders share, see instancing.ts), so a found hex's props rarely need a new one. Made
   * mid-game (the island compiled already), it warms up hidden while the one there goes on
   * drawing, and takes over once its shaders are built: shown at once, its first frame would
   * build them (tens of milliseconds a mesh, more on a phone).
   */
  private build(b: Batch, n: number) {
    const s = b.stands[0];
    const cap = capacity(Math.max(n + 4, Math.ceil(n * 1.5)));
    // (The per-instance data lives on a copy, so the module's geometry stays its own.)
    const geo = s.geo.clone();
    if (s.surfaces && !geo.getAttribute('surface')) geo.setAttribute('surface', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1));
    const data = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * STRIDE), STRIDE, 1);
    // (One buffer for all three: WebGPU allows 8 vertex buffers a pipeline.)
    geo.setAttribute('aTile', new THREE.InterleavedBufferAttribute(data, 1, 0));
    geo.setAttribute('aScale', new THREE.InterleavedBufferAttribute(data, 1, 1));
    geo.setAttribute('aPivot', new THREE.InterleavedBufferAttribute(data, 3, 2));
    const mesh = new THREE.InstancedMesh(geo, s.material, cap);
    mesh.count = 0;
    mesh.castShadow = s.obj.castShadow;
    mesh.receiveShadow = s.obj.receiveShadow;
    mesh.layers.mask = s.obj.layers.mask;
    // (Spread over the island, and moving: never culled as one.)
    mesh.frustumCulled = false;
    mesh.name = 'props';
    this.parent.add(mesh);
    if (this.stage.compiled && this.stage.warm) {
      // (Drawn in the warming's dry frames, so with an instance, at no size: an empty batch isn't drawn.)
      mesh.count = 1;
      mesh.setMatrixAt(0, NONE);
      const next = (b.next = { mesh, data });
      void this.stage.warm([mesh]).then(() => {
        // (Let go meanwhile: the batch emptied, or everything was disposed.)
        if (b.next !== next) return;
        b.next = null;
        this.drop(b);
        b.mesh = mesh;
        b.data = data;
      });
      return;
    }
    this.drop(b);
    b.mesh = mesh;
    b.data = data;
  }

  private drop(b: Batch, all = false) {
    if (all && b.next) {
      b.next.mesh.removeFromParent();
      b.next.mesh.geometry.dispose();
      b.next.mesh.dispose();
      b.next = null;
    }
    if (!b.mesh) return;
    b.mesh.removeFromParent();
    b.mesh.geometry.dispose();
    b.mesh.dispose();
    b.mesh = null;
    b.data = null;
  }

  dispose() {
    this.stage.beforeDraw.delete(this.synced);
    for (const b of this.loosed.values()) b.dispose();
    this.loosed.clear();
    this.glowing?.dispose();
    this.glowing = null;
    for (const b of this.list) this.drop(b, true);
    this.batches.clear();
    this.list = [];
    this.stands = [];
  }
}

function topOf(o: THREE.Object3D) {
  let p = o;
  while (p.parent) p = p.parent;
  return p;
}

/** Whether `o` is drawn: it and every group it is in shown, up to `root`. */
function onShow(o: THREE.Object3D, root: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (!p.parent) return p === root;
  }
  return false;
}
