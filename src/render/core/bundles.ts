// Render bundles for the parts of the island that hold their shape between events: the tiles,
// what grows and lives on them, the pieces and discs on the board, the far islands.
//
// Each frame three would otherwise walk all of these, cull them, sort them and encode every draw
// again, hundreds of them, for the main view and again for the shadow map; on a phone that is
// most of the frame. A group made a bundle (three's BundleGroup, here given to the group in place
// so nothing is reparented) is walked and encoded once, then replayed. Moving things inside one
// are still kept up to date (the bundles are never "static", so three checks every object's
// transform and uniforms as it replays), but what a bundle draws is fixed when it is recorded:
// so each frame a cheap fingerprint of what three would draw from the group (what is shown, in
// which layers and inside which camera's view, instance counts, materials, geometry buffers)
// is checked, and the bundle is recorded again when it changes.
//
// A group can't be a bundle while it holds something drawn in an order of its own (see-through,
// not writing depth, a render order, a batched mesh that culls itself, a draw callback): bundles
// are drawn before everything else in a pass (see executeBundlesFirst), and as recorded. It renders as before meanwhile.
// WebGL2 has no bundles: there this does nothing.

import * as THREE from 'three/webgpu';
import { frameState } from '../util/frame';

type Bundled = THREE.Object3D & { isBundleGroup?: boolean; static?: boolean; version?: number };

interface Entry {
  group: Bundled;
  /** The fingerprint the bundle was recorded with (0: not recorded yet). */
  hash: number;
  /** Why it can't be a bundle just now (null: it is one). */
  blocked: string | null;
  /** Drawn as a plain group for a dry frame, its recording kept (see update). */
  aside: boolean;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object) => {
  let i = ids.get(o);
  if (i === undefined) ids.set(o, (i = nextId++));
  return i;
};
// FNV-1a over 32-bit words, kept to 30 bits: numbers that fit V8's small integers are never boxed,
// and this runs for every object of every bundle every frame.
const mix = (h: number, v: number) => Math.imul(h ^ (v | 0), 16777619) & 0x3fffffff;
const SEED = 2166136261 & 0x3fffffff;
const noCallback = THREE.Object3D.prototype.onBeforeRender;
const viewProj = new THREE.Matrix4();

export class Bundles {
  private entries: Entry[] = [];
  private frustums: THREE.Frustum[] = [];
  private cameras: THREE.Camera[] = [];
  private warned = new WeakSet<object>();

  constructor(private renderer: THREE.WebGPURenderer) {
    guardNestedRenders(renderer);
  }

  /**
   * Whether the backend has bundles: WebGPU's does. (Asked once it has started up: a browser
   * without WebGPU falls back to WebGL2 only then. A URL's ?nobundles turns them off, to compare.)
   */
  private get enabled(): boolean {
    const backend = (this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean; beginBundle?: unknown }; _initialized?: boolean }).backend;
    if (!(this.renderer as unknown as { _initialized?: boolean })._initialized) return false;
    return (this._enabled ??= guarded.has(this.renderer) && !!backend?.isWebGPUBackend && typeof backend.beginBundle === 'function' && !new URLSearchParams(location.search).has('nobundles') && executeBundlesFirst(backend));
  }
  private _enabled: boolean | undefined;

  /** Draw `group` (and all under it) as a bundle from now on, while it's in the scene. */
  add(group: THREE.Object3D) {
    if (this._enabled === false || this.entries.some((e) => e.group === group)) return;
    this.entries.push({ group, hash: 0, blocked: null, aside: false });
  }

  /** Back to a plain group. */
  remove(group: THREE.Object3D) {
    const i = this.entries.findIndex((e) => e.group === group);
    if (i < 0) return;
    demote(this.entries[i].group);
    this.entries.splice(i, 1);
  }

  /** Record every bundle again on the next frame (the lights, materials or passes changed). */
  invalidate() {
    for (const e of this.entries) e.hash = 0;
  }

  /**
   * Once a frame, after the scene's transforms are brought up to date and before it is drawn:
   * `cameras` are those the scene is drawn from this frame (the view, the sun's shadow).
   */
  update(scene: THREE.Scene, cameras: THREE.Camera[]) {
    if (!this.enabled) {
      if (this._enabled === false) this.entries.length = 0;
      return;
    }
    // A dry frame (see Stage.dryRun) draws nothing, so a bundle recorded in one would replay empty.
    const dry = frameState.dry;
    this.cameras = cameras;
    while (this.frustums.length < cameras.length) this.frustums.push(new THREE.Frustum());
    for (let i = 0; i < cameras.length; i++) {
      const c = cameras[i];
      viewProj.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
      this.frustums[i].setFromProjectionMatrix(viewProj, c.coordinateSystem, (c as THREE.Camera & { reversedDepth?: boolean }).reversedDepth);
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      // A group gone from the scene (its board was cleared) is let go.
      if (!inScene(e.group, scene)) {
        demote(e.group);
        this.entries.splice(i, 1);
        continue;
      }
      this.blocked = null;
      const hash = this.fingerprint(e.group, SEED, true);
      if (this.blocked) {
        if (!e.blocked) {
          demote(e.group);
          this.warn(e.group, this.blocked);
        }
        e.blocked = this.blocked;
        e.hash = 0;
        continue;
      }
      e.blocked = null;
      // In a dry frame (the precompile's, as a found hex is readied while frames go on) a bundle
      // whose contents have changed is drawn as a plain group, its recording kept: the real
      // frames after it, which most often show what it holds as it was, go on replaying it.
      if (dry) {
        if (hash !== e.hash && e.group.isBundleGroup) {
          e.group.isBundleGroup = false;
          e.aside = true;
        }
        continue;
      }
      if (e.aside) {
        e.aside = false;
        if (hash === e.hash) {
          e.group.isBundleGroup = true;
          continue;
        }
      }
      if (hash !== e.hash || !e.group.isBundleGroup) {
        e.hash = hash;
        promote(e.group);
      }
    }
  }

  private blocked: string | null = null;

  /** What three would draw from `o` and under it, as a number (see the file's comment). */
  private fingerprint(o: THREE.Object3D, h: number, root = false): number {
    h = mix(h, o.id);
    if (!o.visible) return mix(h, 0);
    h = mix(h, 1);
    // (A bundle inside a bundle isn't one three draws as such; a light inside one would light
    // only the bundle's own list, which nothing reads.)
    if (!root && (o as Bundled).isBundleGroup) this.blocked ??= 'a bundle inside it';
    if ((o as THREE.Light).isLight) this.blocked ??= 'a light';
    const m = o as THREE.Mesh & THREE.InstancedMesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean; isBatchedMesh?: boolean };
    if (m.isMesh || m.isPoints || m.isLine || m.isSprite) h = this.drawable(m, h);
    const children = o.children;
    for (let i = 0; i < children.length; i++) h = this.fingerprint(children[i], h);
    return mix(h, children.length);
  }

  private drawable(m: THREE.Mesh & THREE.InstancedMesh & { isSprite?: boolean; isBatchedMesh?: boolean }, h: number): number {
    if (m.isBatchedMesh) this.blocked ??= 'a batched mesh';
    else if (m.renderOrder !== 0) this.blocked ??= `render order ${m.renderOrder}`;
    else if (m.onBeforeRender !== noCallback) this.blocked ??= 'a draw callback';
    h = mix(h, m.layers.mask);
    let bits = (m.castShadow ? 1 : 0) | (m.receiveShadow ? 2 : 0) | (m.frustumCulled ? 4 : 0);
    for (let i = 0; i < this.cameras.length; i++) {
      const seen = m.layers.test(this.cameras[i].layers);
      const inside = seen && (!m.frustumCulled || (m.isSprite ? this.frustums[i].intersectsSprite(m as unknown as THREE.Sprite) : this.frustums[i].intersectsObject(m)));
      bits |= (seen ? 1 : 0) << (3 + 2 * i);
      bits |= (inside ? 1 : 0) << (4 + 2 * i);
    }
    h = mix(h, bits);
    const mats = m.material;
    if (Array.isArray(mats)) for (const mat of mats) h = this.material(mat, h);
    else if (mats) h = this.material(mats, h);
    const g = m.geometry;
    if (g) {
      h = mix(h, g.id);
      if (g.index) h = mix(mix(h, idOf(g.index)), g.index.count);
      h = mix(mix(h, g.drawRange.start), Number.isFinite(g.drawRange.count) ? g.drawRange.count : -1);
      h = mix(h, g.groups.length);
      const attrs = g.attributes;
      for (const k in attrs) {
        const a = attrs[k] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
        h = mix(mix(h, idOf((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data : a)), a.count);
      }
    }
    if (m.isInstancedMesh) {
      h = mix(mix(h, m.count), idOf(m.instanceMatrix));
      if (m.instanceColor) h = mix(h, idOf(m.instanceColor));
    }
    return h;
  }

  private material(mat: THREE.Material, h: number): number {
    if (mat.transparent) this.blocked ??= 'a see-through material';
    else if (!mat.depthWrite) this.blocked ??= 'a material that writes no depth';
    return mix(mix(h, idOf(mat)), mat.version);
  }

  private warn(group: THREE.Object3D, why: string) {
    if (!import.meta.env.DEV || this.warned.has(group)) return;
    this.warned.add(group);
    console.info(`[bundles] ${group.name || group.type} draws as a plain group while it holds ${why}`);
  }
}

/**
 * Bundles drawn first in their pass, where this module counts on them. three's WebGPU backend holds
 * a pass's bundles back and executes them as the pass ends, after every other draw in it: the
 * bundled tiles then painted over what is drawn on them without writing depth (the placement
 * rings and road bars, the ghost pieces, glows). Each is executed as it's added instead, before
 * the pass's other draws (three adds them first, see Renderer._renderScene). A bundle leaves the
 * pass with no pipeline, bind groups or buffers set, so three's note of what is set is cleared
 * after it, as beginBundle does. Whether three still works this way: false (no bundles) if not.
 */
function executeBundlesFirst(backend: unknown): boolean {
  type Data = { currentPass?: GPURenderPassEncoder | null; currentSets?: unknown; renderBundles?: GPURenderBundle[] };
  const b = backend as { addBundle?: (ctx: object, bundle: object) => void; get(o: object): Data };
  if (typeof b.addBundle !== 'function' || typeof b.get !== 'function') return false;
  b.addBundle = function (this: typeof b, renderContext: object, bundle: object) {
    const data = this.get(renderContext);
    const gpu = (this.get(bundle) as { bundleGPU?: GPURenderBundle }).bundleGPU;
    if (!gpu) return;
    if (!data.currentPass) {
      data.renderBundles?.push(gpu);
      return;
    }
    data.currentPass.executeBundles([gpu]);
    data.currentSets = { attributes: {}, bindingGroups: [], pipeline: null, index: null };
  };
  return true;
}

/**
 * three r186 records a bundle by pointing the renderer at it (`_currentRenderBundle`) while it
 * draws the bundle's objects, and a render made inside that neither clears nor restores the
 * pointer. One is: the shadow map, which three draws lazily, from inside the main pass, when the
 * first object that receives it is drawn. Its own objects would go into the outer bundle, and
 * should it record bundles of its own it would leave the pointer cleared, so the rest of the outer
 * bundle would be drawn directly that frame and left out of every replay after it (the tiles'
 * cliffs vanishing now and then, on frames where the shadow map is redrawn). Every render here starts with no bundle
 * and gives the outer one back. (Without the field, three has changed: no bundles, see `enabled`.)
 */
function guardNestedRenders(renderer: THREE.WebGPURenderer) {
  const r = renderer as unknown as { render(...args: unknown[]): unknown; _currentRenderBundle?: unknown };
  if (!('_currentRenderBundle' in r)) {
    if (import.meta.env.DEV) console.warn('[bundles] three no longer has _currentRenderBundle: render bundles are off (see render/core/bundles.ts).');
    guarded.delete(renderer);
    return;
  }
  guarded.add(renderer);
  const render = r.render;
  r.render = function (this: typeof r, ...args: unknown[]) {
    const outer = this._currentRenderBundle;
    if (outer == null) return render.apply(this, args);
    this._currentRenderBundle = null;
    try {
      return render.apply(this, args);
    } finally {
      this._currentRenderBundle = outer;
    }
  };
}

/** Renderers whose nested renders are guarded (bundles are drawn only there). */
const guarded = new WeakSet<object>();

function promote(g: Bundled) {
  g.isBundleGroup = true;
  g.static = false;
  g.version = (g.version ?? 0) + 1;
}

function demote(g: Bundled) {
  if (!g.isBundleGroup) return;
  g.isBundleGroup = false;
  // (Its recorded bundle is stale from here: a later promotion records it again.)
  g.version = (g.version ?? 0) + 1;
}

function inScene(o: THREE.Object3D, scene: THREE.Scene) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === scene) return true;
  return false;
}
