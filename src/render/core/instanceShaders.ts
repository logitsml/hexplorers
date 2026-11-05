// One shader for every instanced mesh that shares a material and an instance capacity.
//
// three r186 names a buffer uniform that has none of its own after its node: WGSLNodeBuilder's
// getUniformFromNode declares it as `NodeBuffer_<node id>`. Each InstancedMesh's instance matrices
// (and its colours, and on the scene pass last frame's matrices for the motion vectors) are buffer
// nodes of their own (nodes/accessors/Instance.js), so no two instanced meshes would ever produce
// the same shader text, and three caches shader programs and render pipelines by that text: every
// instanced mesh would cost a vertex program and a pipeline of its own in each pass, whatever
// material it shared. Naming those buffers by what they are lets meshes that share a material and
// a capacity (it is in the same declaration: see `capacity` in board/instancing.ts) share their
// shaders. A name only has to be unique within one shader, and a mesh has one of each.
// (`scripts/capture/shots.mjs --compiles` counts the programs and pipelines a game makes.)
//
// It reaches into three's internals, so it checks for them and leaves three alone (with one
// warning in a dev build) when they aren't there: the WGSL builder's getUniformFromNode taking a
// name, and InstancedMesh's instanceMatrix. WebGL needs nothing: its GLSL builder names buffers
// after their nodes whatever it is passed, so the wrapper isn't installed there.

import * as THREE from 'three/webgpu';

type Builder = { object?: THREE.Object3D | null; getUniformFromNode(node: unknown, type: string, shaderStage?: string, name?: string | null): unknown };
type BufferNode = { value?: unknown; bufferType?: string; bufferCount?: number; isBufferNode?: boolean };

const installed = new WeakSet<object>();

export function shareInstanceShaders(renderer: THREE.WebGPURenderer) {
  const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean; createNodeBuilder?: (o: THREE.Object3D, r: unknown) => Builder } }).backend;
  if (!backend?.isWebGPUBackend) return;
  const fail = (why: string) => {
    if (import.meta.env.DEV) console.warn(`Instanced meshes keep a shader each: ${why} (three's internals changed: see render/core/instanceShaders.ts).`);
  };
  let owner: Builder | null = null;
  try {
    const builder = backend.createNodeBuilder?.(new THREE.Mesh(), renderer);
    owner = builder ? (Object.getPrototypeOf(builder) as Builder) : null;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, 'getUniformFromNode')) owner = Object.getPrototypeOf(owner) as Builder | null;
  } catch {
    owner = null;
  }
  if (!owner || typeof owner.getUniformFromNode !== 'function') return fail('no node builder with getUniformFromNode');
  if (!('instanceMatrix' in new THREE.InstancedMesh(new THREE.BufferGeometry(), undefined, 1))) return fail('no InstancedMesh.instanceMatrix');
  if (installed.has(owner)) return;
  installed.add(owner);
  const get = owner.getUniformFromNode;
  owner.getUniformFromNode = function (this: Builder, node: unknown, type: string, shaderStage?: string, name?: string | null) {
    const o = this.object as THREE.InstancedMesh | null | undefined;
    if (!name && (type === 'buffer' || type === 'storageBuffer') && o?.isInstancedMesh) name = instanceBufferName(o, node as BufferNode) ?? name;
    return get.call(this, node, type, shaderStage, name);
  };
}

/** Which of an instanced mesh's own buffers `node` is, if it is one. */
function instanceBufferName(o: THREE.InstancedMesh, node: BufferNode) {
  const m = o.instanceMatrix;
  const v = node.value;
  if (v === m || v === m.array) return 'instanceMatrices';
  if (o.instanceColor && (v === o.instanceColor || v === o.instanceColor.array)) return 'instanceColors';
  // Last frame's matrices, for the motion vectors: a copy of the mesh's own, of the same size.
  if (v instanceof Float32Array && v.length === m.array.length && node.bufferType === 'mat4') return 'instanceMatricesPrevious';
  return null;
}
