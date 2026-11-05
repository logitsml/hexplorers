// Water shared by the sea and the land. The breakers that roll in as foam bands on the sea are
// the same ones that surge up the cliffs, and raindrops ring the puddles as they ring the sea.

import type { Node } from 'three/webgpu';
import { Fn, If, float, vec2, vec3, dot, sin, fract, floor, abs, smoothstep, time, mx_noise_float } from 'three/tsl';

/** Breakers reaching the coast per second. */
const SURF_RATE = 0.26;

/** Slow warp of the breaker fronts along the coast, so they arrive raggedly. */
export const surfWarp = Fn(([p]: [Node<'vec2'>]) => mx_noise_float(vec3(p.mul(1.3), time.mul(0.1))).mul(0.9));

/**
 * Phase of the breakers at distance `s` (world units) out from the coast: a front at 0.05
 * with a tail behind it to about 0.3, moving shoreward.
 */
export const surfPhase = (s: Node<'float'>, warp: Node<'float'>) => fract(s.mul(2.3).add(time.mul(SURF_RATE)).add(warp.mul(0.35)));

/** Seconds since the last breaker hit the coast at p. */
export const sinceBreaker = (p: Node<'vec2'>) => fract(surfPhase(float(0), surfWarp(p)).sub(0.05)).div(SURF_RATE);

/**
 * Raindrop rings: in each small cell a ring expands from a random point and fades. Returns the
 * surface slope they add (xz), scaled by the rain level. `density` is cells per world unit.
 */
export const rainRings = (p: Node<'vec2'>, level: Node<'float'>, density = 9) =>
  Fn(() => {
    const d = vec2(0, 0).toVar();
    If(level.greaterThan(0.01), () => {
      const rp = p.mul(density);
      const cell = floor(rp);
      const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
      const h2 = fract(h.mul(7.13));
      const age = fract(time.mul(0.85).add(h));
      const off = fract(rp).sub(vec2(h, h2).mul(0.6).add(0.2));
      const dist = off.length();
      const ring = smoothstep(0.08, 0.0, abs(dist.sub(age.mul(0.38)))).mul(age.oneMinus()).mul(level);
      d.assign(off.div(dist.max(0.001)).mul(ring.mul(1.6)));
    });
    return d;
  })();
