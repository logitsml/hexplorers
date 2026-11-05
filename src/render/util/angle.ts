/** `cur` turned toward `target` the short way round, by fraction `k` (0..1). */
export function easeAngle(cur: number, target: number, k: number) {
  return cur + Math.atan2(Math.sin(target - cur), Math.cos(target - cur)) * k;
}

/** Frame-rate independent smoothing fraction for a response `rate` (per second). */
export const follow = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);
