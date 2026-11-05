// Node builds kept for the next board.
//
// three r186 drops a node build (the TSL graph turned into WGSL, tens of milliseconds a material
// on High) as soon as no render object uses it: so a board left for the title would take every
// build of its island with it, and the next game would build them all again, though most come out
// under the same keys (the same materials, and instanced meshes keyed by capacity: see
// core/instanceBuilds.ts). Here the builds a board lets go of are kept, the most recent few
// hundred, for the next board to find, and a second game builds less than half as many.
//
// Not kept: builds whose key names the object they were made for (an instanced mesh in the pass
// with motion vectors, a batched mesh), which no other object can ever use; nor an instanced
// mesh's but in the shadow map (see keepable). A kept build holds
// what it was built from (its nodes, and for an instanced mesh the matrices of the mesh it was
// built for: up to 64 KB), so they are capped.
//
// It reaches into three's internals, so it checks for them and leaves three alone (with one
// warning in a dev build) when they aren't there. `?nokeep` turns it off, to compare.

import type * as THREE from 'three/webgpu';
import { sharedKeys } from './instanceBuilds';

/** How many builds no render object uses are kept, at most. */
const KEEP = 400;

type State = { usedTimes: number };
type RenderObject = { isRenderObject?: boolean; object: THREE.Object3D; material: THREE.Material };
type Nodes = {
  get(o: object): { nodeBuilderState?: State };
  delete(o: object): unknown;
  nodeBuilderCache: Map<unknown, State>;
  getForRenderCacheKey(ro: object): unknown;
};

export function keepNodeBuilds(renderer: THREE.WebGPURenderer) {
  const nodes = (renderer as unknown as { _nodes?: Nodes })._nodes;
  if (new URLSearchParams(location.search).has('nokeep')) return;
  if (!nodes || typeof nodes.delete !== 'function' || typeof nodes.getForRenderCacheKey !== 'function' || !(nodes.nodeBuilderCache instanceof Map)) {
    if (import.meta.env.DEV) console.warn("A board's node builds go with it: three's internals changed (see render/core/buildCache.ts).");
    return;
  }
  // The builds held here (one use each, so three keeps them), oldest first.
  const held = new Map<unknown, State>();
  const del = nodes.delete;
  nodes.delete = function (this: Nodes, o: object) {
    const ro = o as RenderObject;
    const state = ro.isRenderObject ? this.get(ro).nodeBuilderState : undefined;
    if (state && state.usedTimes <= 2 && keepable(ro)) {
      const key = this.getForRenderCacheKey(ro);
      if (held.get(key) === state) {
        // (Its last user going: the newest held again, so the last to be let go.)
        if (state.usedTimes === 2) {
          held.delete(key);
          held.set(key, state);
        }
      } else if (state.usedTimes === 1 && !held.has(key)) {
        state.usedTimes++;
        held.set(key, state);
        if (held.size > KEEP) release(this, held);
      }
    }
    return del.call(this, o);
  };
}

/** Whether another object could ever find `ro`'s build under its key. */
function keepable(ro: RenderObject) {
  const o = ro.object as THREE.Object3D & { isInstancedMesh?: boolean; isBatchedMesh?: boolean; count?: number };
  if (o.isBatchedMesh) return false;
  // (An instanced mesh's only in the shadow map: kept in the scene's passes, the next board's
  // instanced pieces draw too bright, as if out of the shade, for reasons not yet found.)
  if (o.isInstancedMesh || (o.count ?? 1) > 1) return sharedKeys.has(ro) && (ro.material as { isShadowPassMaterial?: boolean }).isShadowPassMaterial === true;
  return true;
}

/** Let go of the oldest held builds nothing else uses, down to the cap. */
function release(nodes: Nodes, held: Map<unknown, State>) {
  for (const [key, state] of held) {
    if (held.size <= KEEP) return;
    if (state.usedTimes > 1) continue;
    held.delete(key);
    state.usedTimes = 0;
    if (nodes.nodeBuilderCache.get(key) === state) nodes.nodeBuilderCache.delete(key);
  }
}
