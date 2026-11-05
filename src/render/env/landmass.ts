// The materials of distant land (the islands' shapes are in landShapes.ts, the ranges' in
// distantShapes.ts). They paint it from the same few physical quantities (slope, height above
// the sea, distance) so rock, grass, forest, sand, wet stone and snow always agree with the
// shape; the islands' fades its finest noise with distance so nothing shimmers, and the ranges'
// (rangeMaterial) has none that fine.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  sin,
  mix,
  smoothstep,
  positionWorld,
  normalWorld,
  cameraPosition,
  mx_noise_float,
  mx_fractal_noise_float,
  mx_worley_noise_vec2,
  attribute,
  color,
  vertexColor,
} from 'three/tsl';
import { bumpedNormal } from '../board/materials';
import { SEA_LEVEL } from '../board/layout';

/**
 * Procedural land surface. `scale` is the size of a typical feature in world units (larger for
 * far islands, so their detail is drawn at a size that still reads); `snowLine` is a world
 * height above which flat ground carries snow.
 */
interface LandLook {
  /** Size of a typical feature in world units. */
  scale: number;
  /** World height above which flat ground carries snow. */
  snowLine?: number;
  /** Steepest ground (normal.y) that still grows turf and forest; mountainsides are forested
   * on far steeper slopes than a cliff-top meadow. */
  turfSlope?: number;
}

export function landMaterial({ scale, snowLine = Infinity, turfSlope = 0.6 }: LandLook): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const f = 1 / scale;
  const p = positionWorld;
  const up = normalWorld.y;
  const h = p.y.sub(SEA_LEVEL);
  // Fine detail fades out once it would be smaller than a pixel or so.
  const near = smoothstep(scale * 70, scale * 18, cameraPosition.sub(p).length());
  const broad = mx_noise_float(p.mul(f * 0.3));
  const mid = mx_fractal_noise_float(p.mul(f * 1.4), 3, 2, 0.5);
  const fine = mx_noise_float(p.mul(f * 7)).mul(near);
  // Rock: coastal stacks show horizontal bedding, vertical joints and dark weathering streaks
  // running down from the top, over a tone that varies in broad patches.
  const strata = sin(p.y.mul(f * 16).add(broad.mul(3)).add(mid.mul(1.6))).mul(0.5).add(0.5);
  const bed = smoothstep(0.88, 1.0, sin(p.y.mul(f * 23).add(broad.mul(2.5)))).mul(near);
  const columns = mx_worley_noise_vec2(vec3(p.x.mul(f * 1.9), p.y.mul(f * 0.22), p.z.mul(f * 1.9)));
  const joint = smoothstep(0.06, 0.0, columns.y.sub(columns.x)).mul(smoothstep(-0.1, 0.25, mid)).mul(near);
  const streak = mx_noise_float(vec3(p.x.mul(f * 3.2), p.y.mul(f * 0.35), p.z.mul(f * 3.2))).mul(0.5).add(0.5);
  // Ground cover from slope: flat ground grows turf, steep ground stays bare.
  const turf = smoothstep(turfSlope, turfSlope + 0.24, up.add(mid.mul(0.14)));
  const forest = smoothstep(0.05, 0.3, mx_noise_float(p.mul(f * 0.8)).add(broad.mul(0.3))).mul(turf);
  // Soil and roots in the first stretch of cliff under the turf edge.
  const below = attribute<'float'>('aDepth', 'float');
  const soil = smoothstep(scale * 0.3, scale * 0.06, below).mul(turf.oneMinus());
  // Near the waterline: wet, darker, glossier rock and a sand beach on gentle ground.
  // (The waterline bands keep a fixed size: the sea doesn't care how big the land is.)
  const shore = Math.min(scale, 1.5);
  const wet = smoothstep(shore * 0.22, 0.0, h);
  const beach = smoothstep(shore * 0.35, shore * 0.12, h).mul(smoothstep(0.45, 0.75, up));
  const snow = Number.isFinite(snowLine)
    ? smoothstep(snowLine - scale * 0.6, snowLine + scale * 0.6, p.y.add(mid.mul(scale * 0.8))).mul(smoothstep(0.45, 0.75, up))
    : float(0);
  m.colorNode = Fn(() => {
    const rock = mix(color('#3b342e'), color('#8a7e70'), strata.mul(0.5).add(mid.mul(0.3)).add(0.2).clamp(0, 1))
      .mul(mix(float(0.72), float(1.06), streak))
      .mul(joint.mul(0.5).add(bed.mul(0.25)).oneMinus())
      .mul(fine.mul(0.1).add(1))
      .toVar();
    // Moss and weed on the ledges just above the sea.
    rock.assign(mix(rock, color('#46552a'), smoothstep(shore * 0.8, shore * 0.15, h).mul(smoothstep(0.2, 0.55, up)).mul(0.6)));
    rock.assign(mix(rock, color('#3a2a1c'), soil.mul(0.85)));
    // Turf: greens varying in broad patches, sun-dried where the ground is highest and flattest.
    // Clumpy grass: dark hollows and lit tufts at two scales, so the turf never reads flat.
    const tufts = mx_noise_float(p.mul(f * 18)).mul(near).mul(0.5).add(mx_noise_float(p.mul(f * 4.5)).mul(0.5));
    const meadow = mix(color('#405e22'), color('#6a8a35'), broad.mul(0.5).add(0.5)).mul(tufts.mul(0.3).add(1)).toVar();
    meadow.assign(mix(meadow, color('#9a9450'), smoothstep(0.25, 0.6, mid).mul(0.35)));
    const canopy = mix(color('#22391d'), color('#36522a'), fine.mul(0.5).add(0.5));
    const ground = mix(meadow, canopy, forest);
    const c = mix(rock, ground, turf).toVar();
    c.assign(mix(c, color('#cdbc8e'), beach));
    c.assign(c.mul(wet.mul(0.4).oneMinus()));
    c.assign(mix(c, color('#eef2f6'), snow));
    return vec4(c, 1);
  })();
  m.roughnessNode = mix(mix(float(0.95), float(0.58), wet), float(0.6), snow);
  const relief = strata.mul(0.4).sub(joint.mul(0.7)).sub(bed.mul(0.3)).add(streak.mul(0.3)).add(fine.mul(0.35)).mul(turf.oneMinus()).add(fine.mul(forest).mul(0.5));
  m.normalNode = bumpedNormal(relief as Node<'float'>, scale * 0.03);
  return m;
}

/** World height above which the ranges' gentler ground lies under snow: only the tallest summits. */
const RANGE_SNOW = 15.5;

/**
 * The material of the mountain ranges on the horizon (distantShapes.ts), seen from 150 units and
 * more and drawn every frame, so kept cheap: two world-space noises (nothing stretches down a
 * steep face) and no cliff detail, which would be far below a pixel there. Their ground cover
 * (woods, meadow, turf above the trees) comes in their vertex colours; here bare rock shows only
 * where the ground is steep, sand only on the gentle shores, snow only on the highest gentle
 * ground. They skip the scene's fog (it would erase them) for aerial perspective of their own:
 * their light dims and the haze's own light takes its place as the air between thickens.
 */
export function rangeMaterial(haze: { color: Node<'vec3'>; amount: Node<'float'> }): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  m.fog = false;
  const p = positionWorld;
  const up = normalWorld.y;
  const h = p.y.sub(SEA_LEVEL);
  // Broad patches (some 10 units across) and crags (2), in world space.
  const patch = mx_noise_float(p.mul(1 / 10));
  const crag = mx_noise_float(p.mul(1 / 2.2));
  // Bare rock past some 40°, a little sooner higher up, with a ragged edge.
  const rock = smoothstep(0.8, 0.68, up.add(patch.mul(0.07)).add(crag.mul(0.05)).sub(h.mul(0.005)));
  const snow = smoothstep(RANGE_SNOW - 1.2, RANGE_SNOW + 0.8, h.add(patch.mul(2))).mul(smoothstep(0.5, 0.72, up));
  const beach = smoothstep(0.4, 0.18, h).mul(smoothstep(0.75, 0.88, up));
  const wet = smoothstep(0.25, 0.0, h);
  // Under the waterline, all haze: it only shows past the sea's edge, where the sea itself would
  // be nothing but haze. Above it the haze is a little bluer than the fog, as far slopes are seen
  // through the sky's own blue.
  const under = smoothstep(0.0, -0.3, h);
  const k = haze.amount.max(under);
  const hazeColor = haze.color.mul(mix(vec3(0.9, 0.96, 1.06), vec3(1), under));
  m.colorNode = Fn(() => {
    const ground = vertexColor().rgb.mul(patch.mul(0.14).add(crag.mul(0.08)).add(1));
    const stone = mix(color('#4a4641'), color('#8a8277'), crag.mul(0.35).add(patch.mul(0.25)).add(0.5).clamp(0, 1));
    const c = mix(ground, stone, rock).toVar();
    c.assign(mix(c, color('#b3a27b'), beach));
    c.assign(c.mul(wet.mul(0.35).oneMinus()));
    c.assign(mix(c, color('#eef2f6'), snow));
    return vec4(c.mul(k.oneMinus()), 1);
  })();
  m.emissiveNode = hazeColor.mul(k);
  m.normalNode = bumpedNormal(crag.mul(rock.mul(0.5).add(0.2)) as Node<'float'>, 1);
  return m;
}
