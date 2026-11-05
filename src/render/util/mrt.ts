import type * as THREE from 'three/webgpu';
import { mrt, vec4 } from 'three/tsl';

let renderer: { getMRT(): unknown } | null = null;

/** The renderer whose current MRT decides whether keepNormals materials add their extra output. */
export function setMrtRenderer(r: { getMRT(): unknown }) {
  renderer = r;
}

/**
 * Transparent effects (particles, beams, markers, ripples) must not disturb the
 * normal buffer that ambient occlusion reads. Writing a zero-alpha normal makes
 * the blend a no-op for that attachment, so only the colour output is affected.
 * The extra output is only supplied while the pass being built has an MRT: a plain
 * pass (the sea's mirror reflection) would otherwise be left with no colour output.
 */
export function keepNormals<T extends THREE.Material>(m: T): T {
  const node = mrt({ normal: vec4(0, 0, 0, 0) });
  Object.defineProperty(m, 'mrtNode', {
    get: () => (renderer?.getMRT() ? node : null),
    set: () => {},
    configurable: true,
  });
  return m;
}
