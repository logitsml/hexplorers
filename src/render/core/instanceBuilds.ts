// One node build for every instanced mesh that shares a material and an instance capacity.
//
// three r186 keys a render object's node build (the TSL graph turned into WGSL, tens of
// milliseconds a material on High) by its material, geometry layout and pass, as for any mesh,
// and for an InstancedMesh by the mesh's uuid as well (RenderObject.getMaterialCacheKey): its
// instance matrices are a uniform buffer bound to that mesh's own array in what the build makes.
// So every board would build every instanced mesh's shaders afresh in every pass, though those
// sharing a material and a capacity come out the same, word for word (see core/instanceShaders.ts).
//
// Here such meshes share the build as plain meshes do: the mesh in the key gives way to its
// capacity (what the shaders' matrix array is sized by), and each render object's own copy of the
// bindings (three clones them per object) is pointed at its own mesh's matrices.
//
// The pass with motion vectors (TRAA's, High and Ultra) needs last frame's matrices too, which
// three keeps per mesh out of reach, and copies into in a closure over the mesh its build was made
// for: there an instanced mesh is placed here instead, by the same sums as three's (its position
// and normal by this frame's matrices, where it was by last frame's), from last frame's matrices
// kept here per mesh and brought up to date once a frame is drawn (see keepLastMatrices), as three
// does after each object. Its builds then share as the other passes' do.
//
// Left as they were: meshes with instance colours, and matrices too many for a uniform buffer
// (vertex attributes then, bound by the build).
//
// It reaches into three's internals, so it checks for them and leaves three alone (with one
// warning in a dev build) when they aren't there. `?unshared` turns it off, to compare. WebGL
// isn't patched.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { buffer, instanceIndex, normalLocal, positionLocal, positionPrevious, transformNormal } from 'three/tsl';

type MRT = { has(name: string): boolean } | null;
type Renderer = THREE.WebGPURenderer & { getMRT(): MRT };
type Binding = { isNodeUniformBuffer?: boolean; nodeUniform?: { value?: unknown; updateRanges?: unknown[] } };
type RenderObject = { object: THREE.Object3D; renderer: Renderer; _bindings?: unknown; getMaterialCacheKey(): number; getBindings(): { bindings: Binding[] }[] };
type Objects = { createRenderObject(...a: unknown[]): RenderObject };

/** Every shared mesh's matrices: what a cloned binding of a shared build may still point at. */
const matrices = new WeakSet<ArrayLike<number>>();

/** Render objects of instanced meshes keyed by their capacity, not themselves (see core/buildCache.ts). */
export const sharedKeys = new WeakSet<object>();

/** Each mesh placed here's last frame's matrices, and the version of its own they were copied from. */
const lastMatrices = new WeakMap<THREE.InstancedMesh, { array: Float32Array; version: number }>();
/** Those meshes, to bring up to date each frame (let go of once gone). */
let placed: WeakRef<THREE.InstancedMesh>[] = [];
/** Every mesh's last frame's matrices, as a cloned binding may still point at them. */
const previous = new WeakSet<ArrayLike<number>>();

function last(mesh: THREE.InstancedMesh) {
  let l = lastMatrices.get(mesh);
  if (!l) {
    // (Where it is now, to start with, as three's own copy starts.)
    l = { array: (mesh.instanceMatrix.array as Float32Array).slice(), version: mesh.instanceMatrix.version };
    lastMatrices.set(mesh, l);
    previous.add(l.array);
    placed.push(new WeakRef(mesh));
  }
  return l;
}

/**
 * Once a frame has been drawn: last frame's matrices become this frame's, for the meshes placed
 * here (see shareInstanceBuilds), as three does for its own after each object is drawn.
 */
export function keepLastMatrices() {
  let gone = 0;
  for (const ref of placed) {
    const mesh = ref.deref();
    if (!mesh) {
      gone++;
      continue;
    }
    const l = lastMatrices.get(mesh)!;
    const m = mesh.instanceMatrix;
    if (l.version === m.version) continue;
    l.array.set(m.array as Float32Array);
    l.version = m.version;
  }
  if (gone > 64) placed = placed.filter((r) => r.deref());
}

export function shareInstanceBuilds(renderer: THREE.WebGPURenderer) {
  const r = renderer as unknown as { backend?: { isWebGPUBackend?: boolean; device?: GPUDevice }; _objects?: Objects };
  if (!r.backend?.isWebGPUBackend || new URLSearchParams(location.search).has('unshared')) return;
  const fail = (why: string) => {
    if (import.meta.env.DEV) console.warn(`Instanced meshes keep a node build each: ${why} (three's internals changed: see render/core/instanceBuilds.ts).`);
  };
  const objects = r._objects;
  const getData = (THREE.NodeUtils as unknown as { getDataFromObject?: (o: object) => { useVelocity?: boolean } }).getDataFromObject;
  if (!objects || typeof objects.createRenderObject !== 'function') return fail('no RenderObjects.createRenderObject');
  if (typeof getData !== 'function') return fail('no NodeUtils.getDataFromObject');
  const limit = r.backend.device?.limits.maxUniformBufferBindingSize ?? 0;
  const placing = placeForMotion(limit);

  /** Whether `o`'s build can be shared in the pass being drawn. */
  const shareable = (o: THREE.Object3D, renderer: Renderer) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh || m.instanceColor || !m.instanceMatrix?.isInstancedBufferAttribute) return false;
    if ((m.instanceMatrix as { isStorageInstancedBufferAttribute?: boolean }).isStorageInstancedBufferAttribute) return false;
    if (Math.max(m.instanceMatrix.count, 1) * 64 > limit) return false;
    if (!placing && (renderer.getMRT()?.has('velocity') || getData(o).useVelocity === true)) return false;
    matrices.add(m.instanceMatrix.array);
    return true;
  };

  // The prototype is found on the first render object made (RenderObject isn't exported).
  const create = objects.createRenderObject;
  objects.createRenderObject = function (this: Objects, ...a: unknown[]) {
    const ro = create.apply(this, a);
    delete (objects as Partial<Objects>).createRenderObject;
    const proto = Object.getPrototypeOf(ro) as RenderObject;
    if (typeof proto.getMaterialCacheKey !== 'function' || typeof proto.getBindings !== 'function') {
      fail('no RenderObject.getMaterialCacheKey or getBindings');
      return ro;
    }
    const key = proto.getMaterialCacheKey;
    proto.getMaterialCacheKey = function (this: RenderObject) {
      const o = this.object;
      if (!shareable(o, this.renderer)) {
        sharedKeys.delete(this);
        return key.call(this);
      }
      sharedKeys.add(this);
      // (Its capacity in the mesh's place: the key is a hash of what it reads, the uuid among it.)
      const uuid = o.uuid;
      o.uuid = `instances:${(o as THREE.InstancedMesh).instanceMatrix.count}`;
      try {
        return key.call(this);
      } finally {
        o.uuid = uuid;
      }
    };
    const getBindings = proto.getBindings;
    proto.getBindings = function (this: RenderObject) {
      const fresh = !this._bindings;
      const groups = getBindings.call(this);
      if (fresh && (this.object as THREE.InstancedMesh).isInstancedMesh) {
        const mesh = this.object as THREE.InstancedMesh;
        const own = mesh.instanceMatrix.array;
        for (const group of groups)
          for (const b of group.bindings) {
            const node = b.nodeUniform;
            if (!b.isNodeUniformBuffer || !node) continue;
            // (This object's copy of the binding, built for another mesh: its own matrices, this
            // frame's or last frame's.)
            const value = matrices.has(node.value as ArrayLike<number>) && node.value !== own ? own : previous.has(node.value as ArrayLike<number>) ? last(mesh).array : null;
            if (value && value !== node.value) b.nodeUniform = Object.assign(Object.create(node) as typeof node, { value, updateRanges: [] });
          }
      }
      return groups;
    };
    return ro;
  };
}

/**
 * Place instanced meshes in passes with motion vectors here rather than by three's own (see the
 * top of this file): three's steps run without its instancing, which is then done as three does
 * it but from last frame's matrices kept here. False where three's internals aren't as expected.
 */
function placeForMotion(limit: number): boolean {
  type Builder = { object: THREE.Object3D; needsPreviousData?(): boolean; hasGeometryAttribute(name: string): boolean };
  type Material = { setupPosition(builder: Builder): Node };
  const proto = THREE.NodeMaterial.prototype as unknown as Material;
  const setup = proto.setupPosition;
  const probe = new THREE.InstancedMesh(new THREE.BufferGeometry(), undefined, 1);
  if (typeof setup !== 'function' || !Object.prototype.hasOwnProperty.call(probe.instanceMatrix, 'isInstancedBufferAttribute')) {
    if (import.meta.env.DEV) console.warn("Instanced meshes keep a node build each in the motion vectors' pass: three's internals changed (see render/core/instanceBuilds.ts).");
    return false;
  }
  proto.setupPosition = function (this: Material, builder: Builder) {
    const m = builder.object as THREE.InstancedMesh;
    const attr = m.instanceMatrix as (THREE.InstancedBufferAttribute & { isStorageInstancedBufferAttribute?: boolean }) | undefined;
    const ours = m.isInstancedMesh && !!attr?.isInstancedBufferAttribute && !attr.isStorageInstancedBufferAttribute && !m.instanceColor && Math.max(attr.count, 1) * 64 <= limit && !!builder.needsPreviousData?.();
    if (!ours) return setup.call(this, builder);
    // three's steps (morphs, skinning, batching, the material's position: whatever its caller left
    // it), without its instancing.
    const flags = attr as unknown as { isInstancedBufferAttribute: boolean };
    flags.isInstancedBufferAttribute = false;
    try {
      setup.call(this, builder);
    } finally {
      flags.isInstancedBufferAttribute = true;
    }
    // Its instancing, as three's (nodes/accessors/Instance.js), with last frame's matrices from here.
    const count = Math.max(attr.count, 1);
    type Matrices = { element(i: unknown): Node<'mat4'> };
    const now = (buffer(attr.array as Float32Array, 'mat4', count) as unknown as Matrices).element(instanceIndex);
    const before = (buffer(last(m).array, 'mat4', count) as unknown as Matrices).element(instanceIndex);
    positionLocal.assign(now.mul(positionLocal).xyz);
    (positionPrevious as unknown as Node<'vec3'>).assign(before.mul(positionPrevious).xyz);
    if (builder.hasGeometryAttribute('normal')) normalLocal.assign(transformNormal(normalLocal, now));
    return positionLocal;
  };
  return true;
}
