// Where an oil well (Oil) stands on its tile: a level pad of ground, chosen once per board and
// carried in the tile's context (TileContext.pad) so the heightfield levels it the same way on a
// terrain worker as here. Pure maths: the workers import it.

import type { Hex } from '../../engine';
import type { TileContext, TileShape } from './terrain';

export interface WellPad {
  /** Centre, in the tile's own coordinates. */
  x: number;
  z: number;
  /** Radius of the levelled ground. */
  r: number;
  /** Radius of the trodden yard round it, kept clear of trees, grass and sheep (at least `r`). */
  yard: number;
  /** The pad's height. */
  y: number;
  /** Which way the machinery faces (radians about +y). */
  angle: number;
  /** A numbered well (on the desert or a swamp) is worked by a horse-gin over a shaft, not a well-sweep. */
  gin: boolean;
}

/** Wells are drawn at the scale of the pieces round them (a sweep's upright about as tall as a house). */
export const WELL_SCALE = 2.0;
/** A gin a size larger: the landmark of its hex, its headframe standing well over the houses. */
export const GIN_SCALE = 2.1;
/** The well-sweep's pit, in its own units (+x along the pole, towards the pit). */
export const SWEEP = { pit: { x: 0.05, z: 0 } };
/** The horse-gin's shaft and capstan, in its own units, and the radius of the circle the donkey walks. */
export const GIN = { shaft: { x: -0.04, z: 0 }, capstan: { x: 0.042, z: 0 }, track: 0.038 };

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The ground at (x, z), `h` before the pad, levelled round it (blending back out at its rim). */
export function levelPad(p: WellPad, x: number, z: number, h: number): number {
  const d = Math.hypot(x - p.x, z - p.z);
  if (d >= p.r * 1.35) return h;
  return p.y + (h - p.y) * smooth01(p.r * 0.75, p.r * 1.35, d);
}

/** Whether something of `radius` at (x, z) would stand in the well's yard (so it goes elsewhere). */
export function onPad(p: WellPad, x: number, z: number, radius: number): boolean {
  return Math.hypot(x - p.x, z - p.z) < p.yard + Math.max(0, radius);
}

/**
 * Tint the ground colour `out` (an RGB object, stored like the palettes as square roots) for the
 * well's yard: packed earth, broken at its edge, so the work stands in a clearing; soaked near
 * black round the oil (a sweep's pit and the seep beside it; a gin's shaft, its trough and the
 * spill by them), in blots with ragged edges; on a sweep's yard a pair of cart ruts running in to
 * the barrels, and on a gin's the ring the donkey has trodden round the capstan.
 */
export function tintPad(p: WellPad, x: number, z: number, out: { r: number; g: number; b: number }) {
  const d = Math.hypot(x - p.x, z - p.z);
  if (d > p.yard) return;
  const hsh = Math.sin(x * 73.1 + z * 41.7) * 43758.5453;
  const grit = hsh - Math.floor(hsh);
  const t = (1 - smooth01(p.yard * 0.6, p.yard, d + grit * 0.03)) * (0.7 + grit * 0.2);
  out.r += (0.47 - out.r) * t;
  out.g += (0.39 - out.g) * t;
  out.b += (0.29 - out.b) * t;
  // In the work's own frame and units: u along it (a sweep's pole, towards the pit), v across.
  const k = p.gin ? GIN_SCALE : WELL_SCALE;
  const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
  const u = ((x - p.x) * ca + (z - p.z) * sa) / k, v = (-(x - p.x) * sa + (z - p.z) * ca) / k;
  const ragged = 0.8 + 0.25 * Math.sin(Math.atan2(v, u) * 5 + p.x * 40) + grit * 0.15;
  const blot = (cu: number, cv: number, r: number) => 1 - smooth01(r * 0.55, r, Math.hypot(u - cu, v - cv) / ragged);
  let dark: number;
  if (p.gin) {
    const { shaft, capstan, track } = GIN;
    dark = Math.max(blot(shaft.x, shaft.z, 0.036), blot(shaft.x, shaft.z - 0.034, 0.03), blot(shaft.x - 0.026, shaft.z - 0.036, 0.032)) * 0.88;
    // (The donkey's circle, trodden bare and dark.)
    const ring = 1 - smooth01(0.004, 0.009, Math.abs(Math.hypot(u - capstan.x, v - capstan.z) - track));
    dark = Math.max(dark, ring * 0.32 * t);
  } else {
    const { pit } = SWEEP;
    dark = Math.max(blot(pit.x, pit.z, 0.03), blot(pit.x + 0.026, pit.z - 0.016, 0.04) * 0.85) * 0.88;
    if (v > 0.02) {
      // (Two wheel ruts, a cart's width apart, from the yard's edge in to the barrels.)
      const rut = Math.max(1 - smooth01(0.002, 0.006, Math.abs(u - 0.016)), 1 - smooth01(0.002, 0.006, Math.abs(u - 0.044)));
      dark = Math.max(dark, rut * 0.3 * t);
    }
  }
  out.r += (0.17 - out.r) * dark;
  out.g += (0.14 - out.g) * dark;
  out.b += (0.11 - out.b) * dark;
}

/**
 * Pick each well tile's pad: off the disc, the corners, the edges and any river (the tile's
 * own `canPlace`), clear of its landmark, on the flattest ground, and (for a gin's tall headframe)
 * beside or behind the disc from the usual view rather than in front of it.
 */
export function planWells(plans: { hex: Hex; ctx: TileContext }[], shapeOf: (ctx: TileContext) => TileShape) {
  for (const { hex, ctx } of plans) {
    if (!hex.well) continue;
    const shape = shapeOf(ctx);
    const gin = hex.numbers.length > 0 && (hex.terrain === 'desert' || hex.terrain === 'swamp');
    const r = gin ? 0.21 : 0.17;
    const a = shape.features.anchor;
    let best: { x: number; z: number; score: number } | null = null;
    // (Inside a pasture's paddock fence, which runs round the tile not far inside its edges.)
    const rads = hex.terrain === 'pasture' ? [0.42, 0.46, 0.5] : [0.5, 0.56, 0.62];
    for (let k = 0; k < 24; k++)
      for (const rad of rads) {
        const ang = (k / 24) * Math.PI * 2 + hex.id * 0.37;
        const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
        // (The machinery stands in the middle of the pad; its levelled rim may run up to a lane.)
        if (!shape.canPlace(x, z, r * 0.55)) continue;
        if (a && Math.hypot(x - a.x, z - a.z) < 0.3 + r) continue;
        let lo = Infinity, hi = -Infinity;
        for (let j = 0; j < 8; j++) {
          const h = shape.height(x + Math.cos(j * 0.785) * r, z + Math.sin(j * 0.785) * r);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        const score = -(hi - lo) * 4 + (gin ? -Math.max(0, z) * 0.3 : -Math.abs(z) * 0.1) - (rad - 0.5) * 0.2;
        if (!best || score > best.score) best = { x, z, score };
      }
    if (!best) continue;
    // Side-on to the middle of the tile, so a sweep's pole is seen rocking from most views.
    const angle = Math.atan2(best.z, best.x) + Math.PI / 2;
    // (In a forest the yard is cleared wide, so the sweep isn't lost among the trees.)
    const yard = hex.terrain === 'forest' ? 0.3 : r + 0.03;
    ctx.pad = { x: best.x, z: best.z, r, yard, y: shape.height(best.x, best.z), angle, gin };
  }
}
