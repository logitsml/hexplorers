// No lighting in the ambient-occlusion prepass.
//
// High and Ultra draw the opaque scene once more before the main pass, for its depth and its normals
// (Stage.buildPipeline: the prepass's one target is the packed view normal). three r186 builds
// every material there as it would for the screen all the same: its lighting (the sun and its
// shadow map, the lamps' clusters, the sky's light, the AO itself), fog and tone mapping, assigned
// to an output the prepass then replaces with the normal. Nothing of it reaches the target, but it
// would be set up, analysed, written into the shader and compiled on the GPU: a good part of a game's
// start at High.
//
// So a material built while the prepass's buffers are the renderer's gets no lighting: its depth,
// its normal (the material's own normal node, its displacement and its alpha cut-out are set up
// before lighting, as before) and so the AO come out the same. `?prepasslit` builds them lit, to compare.

import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';

type Builder = { renderer: { getMRT(): unknown } };

/** The prepass's buffers, while there is a prepass. */
let prepassMRT: unknown = null;

export function setPrepassMRT(mrt: unknown) {
  prepassMRT = mrt;
}

let installed = false;

export function skipPrepassLighting() {
  if (installed || new URLSearchParams(location.search).has('prepasslit')) return;
  const proto = THREE.NodeMaterial.prototype as unknown as { setupLighting?: (builder: Builder) => unknown };
  const setupLighting = proto.setupLighting;
  if (typeof setupLighting !== 'function') {
    if (import.meta.env.DEV) console.warn("The AO prepass builds every material's lighting: three's internals changed (see render/core/prepassLighting.ts).");
    return;
  }
  installed = true;
  proto.setupLighting = function (this: THREE.NodeMaterial, builder: Builder) {
    if (prepassMRT !== null && builder.renderer.getMRT() === prepassMRT) return vec3(0);
    return setupLighting.call(this, builder);
  };
}
