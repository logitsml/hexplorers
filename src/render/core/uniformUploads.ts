// A uniform array is sent to the GPU only when it has changed.
//
// three r186 writes every uniform array (a `buffer()` node: an instanced mesh's matrices, the
// tiles' per-tile effects, a few kilobytes each) to its GPU buffer for every object, in every
// pass, every frame: NodeUniformBuffer has no change check of its own (Buffer.update() is always
// true), unlike the groups of single uniforms, which compare value by value. Most of a frame's
// buffer writes are these arrays, and most of them haven't changed since the last frame: skipping
// those halves the writes, sends a fraction of the bytes and takes real time off Stage.render.
//
// So the backend's updateBinding notes which contents each GPU buffer was last given (by the GPU
// buffer, so a buffer made afresh is always written) and passes on a write of the same bits.
// Only whole-array writes are checked; one with update ranges goes through as it is. `?alluploads`
// turns it off, to compare.
//
// WebGL's backend makes the same writes (a buffer re-made with bufferData for each one), which a
// phone's CPU feels more than anything else the frame costs there: it is skipped the same way.
//
// It reaches into three's internals, so it checks for them and leaves three alone (with one
// warning in a dev build) when they aren't there.

import type * as THREE from 'three/webgpu';

type Binding = { isNodeUniformBuffer?: boolean; buffer?: unknown; updateRanges?: readonly unknown[] };
type Backend = { isWebGPUBackend?: boolean; isWebGLBackend?: boolean; updateBinding?(binding: Binding): void; get?(o: object): { buffer?: GPUBuffer; bufferGPU?: WebGLBuffer } };

/**
 * Each array, as last seen: its bits, the render or compute call it was last looked at in, and a
 * stamp that changes whenever its bits do. (Looked at once a call, not once for every object that
 * draws with it: comparing a tile array per object cost as much as writing it.)
 */
const seen = new WeakMap<ArrayBufferView, { call: number; stamp: number; bits: Uint32Array; copy: Uint32Array }>();
/** The stamp of the contents each GPU buffer (WebGPU's or WebGL's) was last given. */
const written = new WeakMap<object, number>();
let stamps = 0;

export function skipUnchangedUniformArrays(renderer: THREE.WebGPURenderer) {
  const backend = (renderer as unknown as { backend?: Backend }).backend;
  if (!backend || new URLSearchParams(location.search).has('alluploads')) return;
  const webgpu = !!backend.isWebGPUBackend;
  if (typeof backend.updateBinding !== 'function' || typeof backend.get !== 'function') {
    if (import.meta.env.DEV) console.warn("Uniform arrays are written every frame: three's backend has no updateBinding (three's internals changed: see render/core/uniformUploads.ts).");
    return;
  }
  const update = backend.updateBinding;
  const get = backend.get;
  const info = renderer.info as unknown as { calls: number; compute: { calls: number } };
  backend.updateBinding = function (this: Backend, binding: Binding) {
    const array = binding.buffer;
    if (binding.isNodeUniformBuffer && !binding.updateRanges?.length && ArrayBuffer.isView(array) && array.byteLength % 4 === 0) {
      const data = get.call(this, binding);
      const gpu = webgpu ? data.buffer : data.bufferGPU;
      if (gpu) {
        // (Arrays are set before a render or a compute call, never during one: see the header.)
        const call = info.calls + info.compute.calls;
        let a = seen.get(array);
        if (!a) {
          const bits = new Uint32Array(array.buffer, array.byteOffset, array.byteLength >> 2);
          seen.set(array, (a = { call, stamp: ++stamps, bits, copy: bits.slice() }));
        } else if (a.call !== call) {
          a.call = call;
          if (!same(a.copy, a.bits)) {
            a.copy.set(a.bits);
            a.stamp = ++stamps;
          }
        }
        if (written.get(gpu) === a.stamp) return;
        written.set(gpu, a.stamp);
      }
    }
    update.call(this, binding);
  };
}

function same(a: Uint32Array, b: Uint32Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
