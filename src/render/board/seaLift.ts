// How far a flood's surge has lifted the sea at a point: a twin, on the CPU, of the ocean shader's
// surge (env/ocean.ts surgeLift), so what floats rides up with the water instead of the water
// closing over it: the ships, the merchantman and the corsair (marks.ts), the fishing grounds'
// boats and floats (grounds.ts), the harbours' moored boats (ports.ts).
//
// It reads what the shader reads: the island's distance field and the flood's reach, both in the
// ocean's sea-layer texture (r: the SDF, b: the reach; see makeSdfTexture), sampled the way the
// GPU's linear filter samples them, and the surge's two uniforms. Outside a flood it costs a read
// of those two numbers.

import * as THREE from 'three/webgpu';
import type { World } from '../World';

/** GLSL's smoothstep, edges either way round (the shader's smoothsteps run both ways). */
function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export type SeaLift = (x: number, z: number) => number;

const lifts = new WeakMap<World, SeaLift>();

/** The world's sea lift (one per world, shared by everything afloat on its board). */
export function seaLiftOf(world: World): SeaLift {
  let lift = lifts.get(world);
  if (lift) return lift;
  const half = THREE.DataUtils.fromHalfFloat;
  // The shader's clock (three's `time`), which the surge's rollers run on, so a hull rides the
  // roller that is under it rather than one of its own. (three keeps it on its node frame; the
  // world's own clock started a moment apart, and is the fallback.)
  const renderer = world.stage.renderer as unknown as { _nodes?: { nodeFrame?: { time: number } } };
  lift = (x: number, z: number) => {
    const ocean = world.ocean;
    if (!ocean) return 0;
    const surge = ocean.surge.value as number, waves = ocean.surgeWaves.value as number;
    if (surge < 1e-4 && waves < 1e-4) return 0;
    const tex = ocean.sdfTex;
    const data = tex.image.data as Uint16Array;
    const size = tex.image.width as number;
    const extent = ocean.layerGrid.extent;
    // Texel centres sit at (i + 0.5) cells from the grid's edge, as the reach field was laid out.
    const fx = ((x + extent) / (2 * extent)) * size - 0.5, fz = ((z + extent) / (2 * extent)) * size - 0.5;
    if (fx < 0 || fz < 0 || fx > size - 1 || fz > size - 1) return 0;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const at = (ii: number, jj: number, ch: number) => half(data[(Math.min(jj, size - 1) * size + Math.min(ii, size - 1)) * 4 + ch]);
    const bilerp = (ch: number) => (at(i, j, ch) * (1 - u) + at(i + 1, j, ch) * u) * (1 - v) + (at(i, j + 1, ch) * (1 - u) + at(i + 1, j + 1, ch) * u) * v;
    const reach = bilerp(2);
    if (reach < 1e-4) return 0;
    const s = bilerp(0);
    const t = renderer._nodes?.nodeFrame?.time ?? performance.now() / 1000;
    const swell = surge * reach * smooth(-0.85, -0.3, s) * smooth(3.6, 0.9, s);
    const rollers = Math.sin(s * 7.5 + t * 3.4) * 0.035 * waves * reach * smooth(-0.6, -0.1, s) * smooth(2.5, 0.5, s);
    return swell + rollers;
  };
  lifts.set(world, lift);
  return lift;
}
