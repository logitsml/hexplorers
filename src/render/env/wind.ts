// One wind for the whole scene. The sea's wave spectrum blows along it and cloud shadows drift
// with it; over the land a field of gusts travels downwind, so grass, crops and trees lean and
// recover as each gust passes, windmills speed up in it and smoke, dust and leaves are carried
// along. Like the sea's swell, the gusts are a few travelling fronts at different lengths and
// angles, so the same field can be evaluated on the GPU (foliage) and the CPU (mills, particles).

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, uniform, renderGroup, float, vec2, vec3, dot, sin, mix, smoothstep, mx_noise_float } from 'three/tsl';

/** Direction the wind blows towards (radians in the xz plane); the sea's waves run this way. */
export const WIND_ANGLE = 0.6;
export const WIND = new THREE.Vector2(Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE));
/** Speed at which gusts sweep across the island (world units per second, fair weather). */
const GUST_SPEED = 1.1;

// (These change every frame and are the same for every object: three's render group, written once a
// render, not each object's own uniforms; see render/core/uniformUploads.ts.)
/** Overall strength: 1 in fair weather, stronger under a shower (World sets it from the weather). */
export const windStrength = uniform(1).setGroup(renderGroup);
/** How far the gust pattern has travelled downwind (world units). */
export const windTravel = uniform(0).setGroup(renderGroup);
/**
 * The sky's clouds (see sky.ts): their offset in the sky's cloud coordinates, run against the
 * wind so the clouds sail with it, and how far they have billowed. Both advance with the wind's
 * strength, so a storm drives them faster.
 */
export const cloudTravel = uniform(new THREE.Vector2()).setGroup(renderGroup);
export const cloudEvolve = uniform(0).setGroup(renderGroup);
/** The sky's cloud speed in fair weather (its own units per second; three's SkyMesh default pace). */
const SKY_DRIFT = 0.0000566;

// Gust fronts: wavelength (world units), angle off the wind, phase and weight. Their lengths
// and angles share no common repeat, so the gusts never settle into a visible pattern.
const FRONTS = [
  { len: 5.3, off: 0.0, ph: 0.0, w: 0.5 },
  { len: 3.1, off: 0.38, ph: 1.7, w: 0.3 },
  { len: 1.9, off: -0.45, ph: 4.2, w: 0.2 },
].map((f) => ({ ...f, k: (Math.PI * 2) / f.len, dx: Math.cos(WIND_ANGLE + f.off), dz: Math.sin(WIND_ANGLE + f.off) }));

export function advanceWind(dt: number, strength: number) {
  windStrength.value = strength;
  windTravel.value += dt * GUST_SPEED * strength;
  cloudTravel.value.x -= dt * SKY_DRIFT * strength * WIND.x;
  cloudTravel.value.y -= dt * SKY_DRIFT * strength * WIND.y;
  cloudEvolve.value += dt * 0.012 * strength;
}

/** Gust at a world position: 0 in a lull, 1 in the heart of a gust (CPU). */
function gustAt(x: number, z: number) {
  const t = windTravel.value;
  let s = 0;
  for (const f of FRONTS) s += Math.sin((x * f.dx + z * f.dz - t) * f.k + f.ph) * f.w;
  return THREE.MathUtils.smoothstep(s, -0.35, 0.65);
}

/** Wind speed factor at a world position (about 0.35 in a lull to 1.3 in a gust, times strength). */
export function windAt(x: number, z: number) {
  return windStrength.value * (0.35 + 0.95 * gustAt(x, z));
}

/** Gust at a world xz position (GPU). Fine noise roughens the fronts' edges. */
export const gust = Fn(([p]: [Node<'vec2'>]) => {
  let s: Node<'float'> = float(0);
  for (const f of FRONTS) s = s.add(sin(dot(p, vec2(f.dx, f.dz)).sub(windTravel).mul(f.k).add(f.ph)).mul(f.w));
  const rag = mx_noise_float(vec3(p.mul(0.8), windTravel.mul(0.05))).mul(0.22);
  return smoothstep(-0.35, 0.65, s.add(rag));
});

/** Wind speed factor for a gust value (GPU counterpart of windAt). */
export const windFor = (g: Node<'float'>) => windStrength.mul(mix(float(0.35), float(1.3), g));

export const windDir = vec2(WIND.x, WIND.y);
