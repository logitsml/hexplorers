// Copies of the scene's depth, shared between the materials that read it. Each
// `viewportDepthTexture()` node keeps its own texture and copies the depth buffer into it on
// every render (ending and restarting the render pass to do it), so a node per material means a
// copy per material. Nodes made from one with `.sample()` share its copy.

import type { Node } from 'three/webgpu';
import { Fn, linearDepth, screenUV, viewportDepthTexture } from 'three/tsl';

/**
 * The depth behind the particles. They all draw after the sea (which writes depth), so one copy
 * taken as the first of them draws serves all of them.
 */
export const particleDepth = viewportDepthTexture(screenUV);

/**
 * The depth under the sea, taken as it draws (before it writes its own), for its thickness and
 * its refraction.
 */
export const seaDepth = viewportDepthTexture(screenUV);

/**
 * three's viewportSafeUV on the sea's copy: where something in front of the water would be
 * refracted into it, fall back to the straight-through point.
 */
export const seaSafeUV = Fn(([uv]: [Node<'vec2'>]) => linearDepth(seaDepth.sample(uv)).sub(linearDepth()).lessThan(0).select(screenUV, uv));
