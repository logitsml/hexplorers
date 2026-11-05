// Surface detail painted in the shader for models built from flat vertex colours: roof
// courses, masonry, kerb joints, whitewash, a sooty brick kiln, ship planking and sailcloth.
// A per-vertex `surface` id (set while a model is assembled, see MeshBuilder.surfaceId) says
// which pattern a part gets. Patterns run in the model's own space, at sizes chosen to read at
// play distance, and fade out before a pixel is too coarse to resolve them (no shimmer).

import type { Node } from 'three/webgpu';
import { Fn, If, float, vec3, vec4, abs, floor, fract, sin, max, min, mix, smoothstep, step, atan, dFdx, dFdy, positionWorld, modelWorldMatrix, mx_noise_float } from 'three/tsl';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

export const SURFACE = {
  plain: 0,
  /** Tile or shingle courses, each lower edge shadowed. */
  roof: 1,
  /** Coursed stone blocks with mortar joints (flagstones on top faces). */
  stone: 2,
  /** Kerb stones jointed along the road. */
  kerb: 3,
  /** Weathered whitewash: mottling, faint courses, rain streaks, grime at the foot. */
  whitewash: 4,
  /** A brick kiln: broad mottling and soot above the fire mouth and at the chimney. */
  kiln: 5,
  /** Ship's planking: plank seams along the hull, deck boards on top. */
  planks: 6,
  /** Sailcloth: panel seams and weathering. */
  canvas: 7,
  /** The lighthouse's red and white bands (coloured in its own material). */
  stripes: 8,
} as const;

/** World units per model unit (the object's scale, including its parents'). */
export const worldScale = modelWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz.length();

/** World units covered by this pixel. */
const footprint = Fn(() => max(dFdx(positionWorld).length(), dFdy(positionWorld).length()))();

/**
 * 1 while a pattern with this period (world units) spans several pixels, 0 before it aliases.
 * `pixel` is the footprint, evaluated once before any branching (a node first used inside one
 * branch of an If chain is computed only there, and reads as unset in the others).
 */
const keep = (pixel: F, period: F) => smoothstep(0.5, 0.18, pixel.div(period));

/** Hash of two numbers, 0..1. */
export const hash2 = (a: F, b: F) => fract(sin(a.mul(12.9898).add(b.mul(78.233))).mul(43758.5453));

/** Horizontal courses of height h, each one's lower edge in the shadow of the course above. */
function courses(p: V3, h: number, scale: F, pixel: F) {
  const cy = p.y.div(h);
  const row = floor(cy);
  const lip = smoothstep(0, 0.28, fract(cy)).mul(0.15).add(0.85);
  const tile = hash2(row, floor(p.x.add(p.z).div(h * 1.6).add(row.mul(0.5)))).sub(0.5).mul(0.12).add(1);
  return mix(float(1), lip.mul(tile), keep(pixel, scale.mul(h)));
}

/** Coursed blocks: courses of height h, blocks w long and staggered, darker mortar between. */
function masonry(p: V3, n: V3, h: number, w: number, scale: F, pixel: F) {
  // Walls run along whichever horizontal axis they face across; top faces are laid as flags.
  const top = step(0.7, abs(n.y));
  const along = mix(abs(n.x).greaterThan(abs(n.z)).select(p.z, p.x), p.x, top);
  const up = mix(p.y, p.z, top);
  const cy = up.div(h);
  const row = floor(cy);
  const cx = along.div(w).add(row.mul(0.5));
  const fx = fract(cx);
  const block = smoothstep(0, 0.08, fract(cy)).mul(smoothstep(0, 0.05, fx)).mul(smoothstep(1, 0.95, fx));
  const shade = mix(float(0.8), float(1), block).mul(hash2(row, floor(cx)).sub(0.5).mul(0.18).add(1));
  return mix(float(1), shade, keep(pixel, scale.mul(h)));
}

/**
 * Shade (a multiplier on the surface colour) for a model point `p` with geometry normal `n`.
 * `scale` converts the model's units to world units, for filtering.
 */
export function surfaceShade(id: F, p: V3, n: V3, worldUnits: F): F {
  return Fn(() => {
    const s = float(1).toVar();
    const pixel = footprint.toVar();
    const scale = worldUnits.toVar();
    If(id.lessThan(0.5), () => {
      s.assign(1);
    })
      .ElseIf(id.lessThan(1.5), () => {
        s.assign(courses(p, 0.0135, scale, pixel));
      })
      .ElseIf(id.lessThan(2.5), () => {
        s.assign(masonry(p, n, 0.024, 0.042, scale, pixel));
      })
      .ElseIf(id.lessThan(3.5), () => {
        // Kerb stones a ninth of the road long: thin joints, each stone a slightly different shade.
        const u = p.x.div(0.0733).add(0.5);
        const f = fract(u);
        const joint = smoothstep(0.045, 0.0, min(f, f.oneMinus())).mul(keep(pixel, scale.mul(0.012)));
        const stone = hash2(floor(u), float(3.1)).sub(0.5).mul(0.1).mul(keep(pixel, scale.mul(0.0733))).add(1);
        s.assign(stone.mul(joint.mul(0.3).oneMinus()));
      })
      .ElseIf(id.lessThan(4.5), () => {
        const mottle = mx_noise_float(p.mul(45)).mul(0.045).mul(keep(pixel, scale.mul(0.022)));
        const course = mix(float(1), smoothstep(0, 0.12, fract(p.y.div(0.022))).mul(0.03).add(0.97), keep(pixel, scale.mul(0.022)));
        // Rain streaks running down from the band and the cap, and grime splashed at the foot.
        const streak = smoothstep(0.35, 0.8, mx_noise_float(vec3(atan(p.z, p.x).mul(7), p.y.mul(9), 0.5))).mul(0.07);
        const grime = smoothstep(0.075, 0.025, p.y).mul(0.14);
        s.assign(mottle.add(1).mul(course).mul(float(1).sub(streak).sub(grime)));
      })
      .ElseIf(id.lessThan(5.5), () => {
        // Brick in patches of different firing (cells about a dozen round the dome), broad
        // mottling, and finer variation close up.
        const cell = hash2(floor(atan(p.z, p.x).mul(12 / Math.PI)), floor(p.y.div(0.018)));
        const mottle = cell.sub(0.5).mul(0.2).mul(keep(pixel, scale.mul(0.035)))
          .add(mx_noise_float(p.mul(38)).mul(0.1))
          .add(mx_noise_float(p.mul(110)).mul(0.05).mul(keep(pixel, scale.mul(0.009))));
        // Soot: a black streak rising from the fire mouth (+z) and widening up the dome, and a
        // sooty band round the chimney top.
        const above = p.y.sub(0.034);
        const width = above.max(0).mul(0.55).add(0.012);
        const plume = smoothstep(width, width.mul(0.3), abs(p.x)).mul(smoothstep(0.02, 0.045, p.z)).mul(smoothstep(0.085, 0.045, p.y)).mul(smoothstep(0.03, 0.04, p.y));
        const chimney = smoothstep(0.115, 0.138, p.y);
        const soot = max(plume, chimney.mul(0.8)).mul(mx_noise_float(p.mul(60)).mul(0.3).add(0.85)).clamp(0, 1);
        s.assign(mottle.add(1).mul(mix(float(1), float(0.16), soot)));
      })
      .ElseIf(id.lessThan(6.5), () => {
        // Strakes along the hull; boards along the deck.
        const top = step(0.7, abs(n.y));
        const across = mix(p.y.div(0.05), p.z.div(0.07), top);
        const f = fract(across);
        const seam = smoothstep(0.08, 0.0, min(f, f.oneMinus())).mul(keep(pixel, scale.mul(0.012)));
        const board = hash2(floor(across), top).sub(0.5).mul(0.14).mul(keep(pixel, scale.mul(0.05))).add(1);
        s.assign(board.mul(seam.mul(0.35).oneMinus()));
      })
      .ElseIf(id.lessThan(7.5), () => {
        // Panels about a ninth of a sail wide, sun-bleached towards the top, stained at the foot.
        const f = fract(p.x.div(0.11));
        const seam = smoothstep(0.06, 0.0, min(f, f.oneMinus())).mul(keep(pixel, scale.mul(0.02)));
        const weather = mx_noise_float(p.mul(7)).mul(0.05);
        s.assign(seam.mul(0.12).oneMinus().mul(weather.add(1)));
      });
    return s;
  })() as unknown as F;
}

/** The lighthouse's bands: white and red, every 0.27 model units up the tower. */
export function lighthouseBands(p: V3): V3 {
  const band = step(0.5, fract(p.y.sub(0.3).div(0.54)));
  return mix(vec3(0.89, 0.86, 0.81), vec3(0.55, 0.035, 0.026), band);
}
