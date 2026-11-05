// Shared TSL materials. Every board object carries a tile index (vertex attribute
// `tile` for merged geometry or instanced attribute `aTile`), which looks up a
// per-hex effect vector so production glows, robber blight and hover highlights
// can be driven from the CPU with a single uniform array.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn,
  attribute,
  float,
  int,
  vec3,
  vec4,
  uniform,
  uniformArray,
  vertexColor,
  positionWorld,
  positionLocal,
  positionGeometry,
  normalLocal,
  normalWorld,
  cameraPosition,
  mix,
  smoothstep,
  sin,
  cos,
  dot,
  max,
  pow,
  normalize,
  luminance,
  time,
  mx_noise_float,
  mx_fractal_noise_float,
  clamp,
  color,
  floor,
  fract,
  step,
  vec2,
  abs,
  If,
  mx_worley_noise_float,
  mx_worley_noise_vec2,
  dFdx,
  dFdy,
  cross,
  sign,
  normalView,
  positionView,
  modelWorldMatrixInverse,
  normalWorldGeometry,
  normalGeometry,
  transformNormalToView,
  exp,
  varying,
  mat3,
  atan,
  mod,
  min,
  renderGroup,
} from 'three/tsl';
import { MAX_LAND } from '../../engine/maps/custom';
import { SEA_LEVEL } from './layout';
import { WATERLINE } from './terrain';
import { ContactMap, TrailMap } from './contact';
import { gust, windFor, windDir, windStrength } from '../env/wind';
import { rainRings, sinceBreaker } from '../env/surf';
import { cloudShade } from '../env/clouds';
import { surfaceShade, worldScale } from './surfaces';
import { batchMatrix } from '../core/batchMatrix';

/**
 * Tiles a board can have: the 19 of the base game, with room for the larger boards the map editor
 * makes. The engine's land limit (MAX_LAND, so no board holds more land than the tables here), by
 * hex id: the uniform arrays below hold this many tiles, 427 vec4s in all (5 per tile, 2 for its sides),
 * well within a WebGL2 uniform block's 1024.
 */
export const MAX_TILES = MAX_LAND;

export class TileEffects {
  // (The single values below are the same for every object in a frame, so they sit in three's
  // render group, written once a render, not in each object's own uniforms: there `now`, set every
  // frame, would have every tile, prop and plant's uniforms rewritten every frame. See render/core/uniformUploads.ts.)
  /** x = production glow, y = robber blight, z = hover highlight, w = wind gust phase start (seconds). */
  values = Array.from({ length: MAX_TILES }, () => new THREE.Vector4(0, 0, 0, -100));
  node = uniformArray(this.values, 'vec4');
  /** Vertical offset per tile (intro: tiles rise out of the sea). */
  riseValues: number[] = new Array(MAX_TILES).fill(0);
  rise = uniformArray(this.riseValues, 'float');
  /** World time in seconds mirrored from the TSL `time` (used for gusts). */
  now = uniform(0).setGroup(renderGroup);
  /** 0 by day, 1 at night (set from the time of day). */
  night = uniform(0).setGroup(renderGroup);
  /** 0..1 rain wetness: darker, glossier ground (set from the weather). */
  wet = uniform(0).setGroup(renderGroup);
  /** 0..1 rain falling now (it rings the puddles). */
  rain = uniform(0).setGroup(renderGroup);
  /** 0..1 how far rainwater has filled the hollows: it rises in a shower and drains slowly. */
  puddles = uniform(0).setGroup(renderGroup);
  /** 0..1 how far the year has turned since the game began: the crops ripen with it (set from the turn, see World). */
  season = uniform(0).setGroup(renderGroup);
  /** 0..1 surf on the cliffs (held off while the coastline is still forming). */
  surf = uniform(1).setGroup(renderGroup);
  /** Per tile: when it came up out of the sea (seconds). It streams wet then, and dries. */
  dryValues: number[] = new Array(MAX_TILES).fill(-1000);
  dry = uniformArray(this.dryValues, 'float');
  /** 0..1 size of the shore boulders: they wait out the opening until the coastline exists. */
  shoreRocks = uniform(1).setGroup(renderGroup);
  /**
   * Per tile: pollution (see pollution.ts). 0 clean; about 0.55 once it has lost a number, its
   * ground blighted in spreading patches and its plants dying back; 1 destroyed, every number
   * lost, a charred and smoking waste.
   */
  scarValues: number[] = new Array(MAX_TILES).fill(0);
  scar = uniformArray(this.scarValues, 'float');
  /**
   * Per tile, the hexes across its six sides (their ids, -1 for none), so a polluted hex's scorch
   * can creep over the edge into its neighbours: sides 0-3 in [2t], 4-5 in [2t + 1].xy. Set with
   * each board, and `anyScar` each frame (see life/scorch.ts).
   */
  sideValues = Array.from({ length: MAX_TILES * 2 }, () => new THREE.Vector4(-1, -1, -1, -1));
  sides = uniformArray(this.sideValues, 'vec4');
  anyScar = uniform(0).setGroup(renderGroup);
  /** Per tile: when a flood soaked it (seconds). Its ground is dark for a while, drying in patches. */
  soakValues: number[] = new Array(MAX_TILES).fill(-1000);
  soak = uniformArray(this.soakValues, 'float');
  sunDir = uniform(new THREE.Vector3(0.4, 0.7, -0.5)).setGroup(renderGroup);
  /** Sunlight colour × relative strength (0 at night), for light that leaves the shading path. */
  sunTint = uniform(new THREE.Color(1, 1, 1)).setGroup(renderGroup);
  /** Where things stand on the ground: occlusion and wear for the terrain (see contact.ts). */
  contact = new ContactMap();
  /** Trails trodden by sheep and travellers, fading over a minute or so. */
  trail = new TrailMap();

  /** A tile's values (a sea hex has no tile: it gets a scratch slot no shader reads). */
  get(tile: number) {
    return this.values[tile] ?? this.scratch;
  }

  private scratch = new THREE.Vector4();
}

type FloatNode = Node<'float'>;
type Vec3Node = Node<'vec3'>;

const pools = new WeakMap<TileEffects, Map<string, THREE.Material>>();

/**
 * One material per kind (and tile, and options) for the session, not one per board: every board
 * draws with the same ones. Materials made anew for each board would have the renderer keep a
 * little more each game (their uniforms and bindings), and compile their shaders again. A pooled
 * material is never disposed: dispose() is a no-op, so code that tidies up a board's materials
 * can go on doing so.
 */
export function pooled<M extends THREE.Material>(effects: TileEffects, key: string, make: () => M): M {
  let pool = pools.get(effects);
  if (!pool) pools.set(effects, (pool = new Map()));
  let m = pool.get(key) as M | undefined;
  if (!m) {
    m = make();
    m.dispose = () => {};
    pool.set(key, m);
  }
  return m;
}

const GOLD = vec3(1.0, 0.72, 0.28);
/** The production glow is added light: keep it gentle when the scene is dark, or it floodlights the hex. */
const glowLight = (effects: TileEffects) => mix(float(0.4), float(1), clamp(luminance(effects.sunTint), 0, 1));

/** The tile's production pulse (and hover highlight), for materials that light up with it. */
function tileGlow(effects: TileEffects, fx: Node<'vec4'>, strength: number): Vec3Node {
  const pulse = sin(effects.now.mul(5)).mul(0.25).add(0.75);
  return GOLD.mul(glowLight(effects)).mul(fx.x.mul(strength).mul(pulse)).add(vec3(0.95, 0.9, 0.7).mul(fx.z.mul(0.06)));
}

/** World units covered by this pixel (the larger of its two screen axes). */
const footprint = Fn(() => max(dFdx(positionWorld).length(), dFdy(positionWorld).length()))();

/**
 * How much of a pattern with `freq` cycles per world unit to keep at this pixel: all of it
 * while a cycle spans several pixels, fading to none before it would alias into sparkle.
 */
export function detailFade(freq: number): FloatNode {
  return smoothstep(0.5, 0.18, footprint.mul(freq));
}

/**
 * Broad variation over the whole island: brightness and a warm/cool shift that drift across
 * tiles at two scales, so neighbouring hexes of one terrain never read as copies.
 */
const macroTint = Fn(([p]: [Node<'vec3'>]) => {
  const a = mx_noise_float(p.xz.mul(0.31));
  const b = mx_noise_float(p.xz.mul(1.05).add(7.3));
  const warm = mx_noise_float(p.xz.mul(0.22).add(19.1));
  const lum = a.mul(0.07).add(b.mul(0.04)).add(1);
  return mix(vec3(0.97, 1.0, 1.04), vec3(1.05, 1.0, 0.9), warm.mul(0.5).add(0.5)).mul(lum);
});

/**
 * macroTint at each vertex, blended across the faces: it changes over a world unit or more, far
 * slower than vertices are spaced, so this looks the same as working it out for every pixel
 * (three noises each) at a small part of the cost.
 */
const vertexTint = () => varying(macroTint(positionWorld)) as unknown as Vec3Node;

/** A small, fixed shift per tile (brightness and warmth), from a hash of its id. */
const tileTint = (tile: FloatNode) => {
  const h = fract(sin(tile.mul(12.9898).add(4.1)).mul(43758.5453));
  const h2 = fract(h.mul(7.31));
  return mix(vec3(0.98, 1.0, 1.03), vec3(1.04, 1.0, 0.93), h2).mul(h.sub(0.5).mul(0.08).add(1));
};

function fxFor(effects: TileEffects, tileNode: FloatNode): Node<'vec4'> {
  return effects.node.element(int(tileNode)) as unknown as Node<'vec4'>;
}

function riseFor(effects: TileEffects, tileNode: FloatNode): Node<'float'> {
  return effects.rise.element(int(tileNode)) as unknown as Node<'float'>;
}

/** Seconds since the tile came up out of the sea. */
function emergedFor(effects: TileEffects, tileNode: FloatNode): Node<'float'> {
  return effects.now.sub(effects.dry.element(int(tileNode)) as unknown as Node<'float'>);
}

/**
 * Surface colour from the vertex colours. three multiplies a material's colour by the vertex
 * colour again when `vertexColors` is on, and these materials were authored that way, so the
 * palettes are tuned for the square. They now square it here, with `vertexColors` off, so
 * the colours mixed in on top (flowers, earth, moss, surf) keep their own values instead of
 * being tinted by the ground beneath.
 */
export function vertexAlbedo(): Vec3Node {
  const c = vertexColor().rgb;
  return c.mul(c);
}

/** How green (grassy) a base colour is, 0..1. */
const grassy = (c: Vec3Node) => smoothstep(0.02, 0.12, c.y.sub(max(c.x, c.z)));

/**
 * Sunflecks: where a canopy overhead (`canopy`, 0..1) lets the sun through in small bright
 * patches that shift as the leaves move in the wind. Returns the light they add to `albedo`.
 */
function sunflecks(effects: TileEffects, albedo: Vec3Node, canopy: FloatNode): Vec3Node {
  return Fn(() => {
    // (Screen derivatives stay outside the branch.)
    const fade = detailFade(11).toVar();
    const light = vec3(0, 0, 0).toVar();
    // Only under a canopy: everywhere else the noise would be multiplied by zero.
    If(canopy.mul(fade).greaterThan(0), () => {
      const p = positionWorld;
      const sway = windDir.mul(sin(effects.now.mul(1.3).add(p.x.mul(2.1)).add(p.z.mul(1.7))).mul(0.012).mul(windStrength));
      const q = p.xz.add(sway);
      const cell = mx_worley_noise_float(vec3(q.mul(11), effects.now.mul(0.1)));
      const gaps = smoothstep(-0.1, 0.35, mx_noise_float(vec3(q.mul(3.2), effects.now.mul(0.04))));
      const fleck = smoothstep(0.3, 0.12, cell).mul(gaps).mul(fade);
      light.assign(albedo.mul(effects.sunTint).mul(fleck.mul(canopy).mul(cloudShade(p)).mul(0.6)));
    });
    return light;
  })() as unknown as Vec3Node;
}

/**
 * positionNode that lifts geometry by its tile's rise offset in *world* space. The offset is
 * applied before the object (and instance) transform, so it is un-scaled and un-rotated first:
 * otherwise a scaled or spinning prop (windmill sails, a hoist wheel) drifts off its tile
 * while the island rises. Instanced batches carry the inverse of each instance's vertical
 * scale in `aRiseScale`.
 */
function risen(effects: TileEffects, tileNode: FloatNode, instanced = false) {
  const r = riseFor(effects, tileNode);
  if (instanced) return positionLocal.add(vec3(0, r.mul(attribute<'float'>('aRiseScale', 'float')), 0));
  return positionLocal.add(modelWorldMatrixInverse.mul(vec4(0, r, 0, 0)).xyz);
}

/** Distance (world units) from a point to the nearest edge of its hex cell (pointy-top, circumradius 1). */
const hexEdgeDist = Fn(([p]: [Node<'vec2'>]) => {
  const r = p.y.mul(2 / 3);
  const q = p.x.mul(Math.sqrt(3) / 3).sub(p.y.div(3));
  // Cube rounding.
  const x = q, z = r, y = x.negate().sub(z);
  const rx = floor(x.add(0.5)).toVar(), ry = floor(y.add(0.5)).toVar(), rz = floor(z.add(0.5)).toVar();
  const dx = abs(rx.sub(x)), dy = abs(ry.sub(y)), dz = abs(rz.sub(z));
  If(dx.greaterThan(dy).and(dx.greaterThan(dz)), () => {
    rx.assign(ry.negate().sub(rz));
  }).ElseIf(dy.greaterThan(dz), () => {
    ry.assign(rx.negate().sub(rz));
  }).Else(() => {
    rz.assign(rx.negate().sub(ry));
  });
  const cx = rx.add(rz.mul(0.5)).mul(Math.sqrt(3));
  const cz = rz.mul(1.5);
  const lx = abs(p.x.sub(cx));
  const lz = abs(p.y.sub(cz));
  return float(Math.sqrt(3) / 2).sub(max(lx, lx.mul(0.5).add(lz.mul(Math.sqrt(3) / 2))));
});

/** The hex cell a point lies in (pointy-top, circumradius 1): its centre (x, y) and the point's distance to its edge (z). */
const hexCell = Fn(([p]: [Node<'vec2'>]) => {
  const r = p.y.mul(2 / 3);
  const q = p.x.mul(Math.sqrt(3) / 3).sub(p.y.div(3));
  const x = q, z = r, y = x.negate().sub(z);
  const rx = floor(x.add(0.5)).toVar(), ry = floor(y.add(0.5)).toVar(), rz = floor(z.add(0.5)).toVar();
  const dx = abs(rx.sub(x)), dy = abs(ry.sub(y)), dz = abs(rz.sub(z));
  If(dx.greaterThan(dy).and(dx.greaterThan(dz)), () => {
    rx.assign(ry.negate().sub(rz));
  }).ElseIf(dy.greaterThan(dz), () => {
    ry.assign(rx.negate().sub(rz));
  }).Else(() => {
    rz.assign(rx.negate().sub(ry));
  });
  const cx = rx.add(rz.mul(0.5)).mul(Math.sqrt(3));
  const cz = rz.mul(1.5);
  const lx = abs(p.x.sub(cx));
  const lz = abs(p.y.sub(cz));
  return vec3(cx, cz, float(Math.sqrt(3) / 2).sub(max(lx, lx.mul(0.5).add(lz.mul(Math.sqrt(3) / 2)))));
});

/**
 * How far a destroyed (or blighted) neighbour's scorch has crept over the edge onto this tile: a
 * ragged band along the side they share, so a waste is a burn that has spread rather than a tile
 * swapped for another. (Looked for only while some tile is polluted; the neighbours come from
 * TileEffects.sides.)
 */
function edgeScorch(effects: TileEffects, tile: FloatNode): FloatNode {
  return Fn(() => {
    const v = float(0).toVar();
    If(effects.anyScar.greaterThan(0.5), () => {
      const p = positionWorld;
      const cell = hexCell(p.xz);
      // Which side the point is nearest (0 = NE at -60 degrees, then clockwise, as SIDE_DIRS).
      const a = atan(p.z.sub(cell.y), p.x.sub(cell.x));
      const k = mod(floor(a.add(Math.PI / 3).div(Math.PI / 3).add(0.5)).add(6), 6);
      const pick = (j: number) => float(1).sub(min(abs(k.sub(j)), 1));
      const s0 = effects.sides.element(int(tile).mul(2)) as unknown as Node<'vec4'>;
      const s1 = effects.sides.element(int(tile).mul(2).add(1)) as unknown as Node<'vec4'>;
      const id = dot(s0, vec4(pick(0), pick(1), pick(2), pick(3))).add(dot(s1.xy, vec2(pick(4), pick(5))));
      const theirs = (effects.scar.element(int(max(id, 0))) as unknown as FloatNode).mul(step(0, id));
      const ragged = mx_noise_float(p.mul(4.3)).mul(0.05).add(mx_noise_float(p.mul(13)).mul(0.015));
      v.assign(theirs.mul(smoothstep(0.15, 0.0, cell.z.add(ragged))).mul(0.8));
    });
    return v;
  })() as unknown as FloatNode;
}

/**
 * View-space normal perturbed by a procedural height field (Mikkelsen, "Bump Mapping
 * Unparametrized Surfaces on the GPU"). Uses unnormalised screen derivatives, so the
 * relief is defined in world units and stays consistent at every zoom level.
 */
export function bumpedNormal(height: Node<'float'>, scale: number | Node<'float'>): Node<'vec3'> {
  return Fn(() => {
    const n = normalView.normalize();
    const sx = dFdx(positionView);
    const sy = dFdy(positionView);
    const r1 = cross(sy, n);
    const r2 = cross(n, sx);
    const det = dot(sx, r1);
    const dh = vec2(dFdx(height), dFdy(height)).mul(scale);
    const grad = sign(det).mul(r1.mul(dh.x).add(r2.mul(dh.y)));
    return n.mul(abs(det)).sub(grad).normalize();
  })() as unknown as Node<'vec3'>;
}

/**
 * Applies robber blight (desaturate + darken + cool tint) to a colour. The grey keeps a trace
 * of the surface's own hue (from its vertex colour), so blighted sand still reads as sand.
 */
function blight(col: Vec3Node, amount: FloatNode): Vec3Node {
  const vc = vertexColor().rgb;
  const grey = vc.mul(luminance(col).div(max(luminance(vc), 0.001))).mul(vec3(0.62, 0.66, 0.78));
  return mix(col, grey, amount.mul(0.72));
}

/**
 * How soaked a tile still is after a flood (0..1, a little over in the wrack line), drying from the
 * edges of patches over about 25 s, the top of the shore first.
 */
function soakedFor(effects: TileEffects, tileNode: FloatNode): FloatNode {
  // How far up the shore the flood reached here (1 at the water's edge; read outside the branch).
  const reach = effects.contact.flood(positionWorld.xz);
  return Fn(() => {
    const since = effects.now.sub(effects.soak.element(int(tileNode)) as unknown as FloatNode);
    const v = float(0).toVar();
    If(since.lessThan(32), () => {
      const n = mx_noise_float(positionWorld.mul(3.3));
      // The top of the shore dries first, the water's edge last; dry above the highest reach,
      // where a ragged line of wrack (weed and flotsam) lies, drying with the rest. Values over
      // 1 darken it further.
      const wet = smoothstep(26, 4, since.add(n.mul(6)).add(reach.oneMinus().mul(12))).mul(smoothstep(0.02, 0.12, reach));
      const wrack = smoothstep(0.03, 0.09, reach).mul(smoothstep(0.3, 0.15, reach.add(n.mul(0.06)))).mul(smoothstep(-0.25, 0.3, mx_noise_float(positionWorld.mul(19))));
      v.assign(wet.mul(wrack.mul(1.2).add(1)));
    });
    return v;
  })() as unknown as FloatNode;
}

export function scarFor(effects: TileEffects, tileNode: FloatNode): FloatNode {
  return effects.scar.element(int(tileNode)) as unknown as FloatNode;
}

/** How far a polluted tile's blight has reached at this point: in patches that spread as it worsens. */
const scarCover = (amount: FloatNode) => {
  const n = mx_noise_float(positionWorld.xz.mul(2.1)).mul(0.5).add(0.5);
  return smoothstep(0, 0.22, amount.mul(1.35).sub(n.mul(0.75)));
};

/**
 * The cracks of a destroyed tile's ground: a cell network warped by noise so it wanders rather
 * than tiling into flagstones, coarse (few cells), the seams varying in width. x = how far into a
 * crack (1 on its line), y = a smouldering mask along it (where embers glow).
 */
const burnCracks = (p: Node<'vec3'>, now: FloatNode) => {
  const warp = vec2(mx_noise_float(p.mul(1.3)), mx_noise_float(p.mul(1.3).add(9.7))).mul(0.45);
  const cells = mx_worley_noise_vec2(vec3(p.x.mul(3.1).add(warp.x), p.y.mul(2), p.z.mul(3.1).add(warp.y)));
  const width = mx_noise_float(p.mul(2.7).add(3.3)).mul(0.5).add(0.5).mul(0.05).add(0.012);
  const crack = smoothstep(width, 0.0, cells.y.sub(cells.x));
  const smoulder = smoothstep(0.15, 0.6, mx_noise_float(p.xz.mul(1.6).add(now.mul(0.04))));
  return vec2(crack, smoulder);
};

/**
 * Pollution on a surface's colour. Blighted: in patches that spread as it worsens, the grass dies
 * back to straw and brown and bare ground goes sooty, keeping a trace of what it was. Destroyed:
 * a warm charcoal burn, brown-black, with drifts of pale silver ash and rings of rust and ochre
 * where the heat scorched the soil, and the ground cracked open along wandering seams (where the
 * embers glow: see embers). (Worked out only on a polluted tile: elsewhere it would be multiplied
 * by zero.)
 */
export function scorch(col: Vec3Node, amount: FloatNode): Vec3Node {
  return Fn(() => {
    const out = col.toVar();
    If(amount.greaterThan(0.001), () => {
      const p = positionWorld;
      const cover = scarCover(amount);
      const lum = luminance(col);
      const soot = vec3(0.03, 0.027, 0.023).add(vec3(lum).mul(vec3(0.42, 0.39, 0.34)));
      // Dying grass: straw and brown rather than grey (the greener, the more it browns).
      const green = smoothstep(0.0, 0.1, col.y.sub(max(col.x, col.z)));
      const straw = mix(vec3(0.2, 0.13, 0.045), vec3(0.11, 0.065, 0.025), smoothstep(0.35, 0.8, amount)).mul(lum.mul(2.2).add(0.55));
      out.assign(mix(col, mix(soot, straw, green), cover.mul(0.85)));
      const dead = smoothstep(0.75, 1, amount);
      const cr = burnCracks(p, float(0));
      const n1 = mx_noise_float(p.xz.mul(2.6)).mul(0.5).add(0.5);
      const n2 = mx_noise_float(p.xz.mul(17)).mul(0.12);
      const charcoal = mix(vec3(0.03, 0.021, 0.014), vec3(0.055, 0.04, 0.026), n1);
      // Pale silver ash, drifted into patches.
      const drift = smoothstep(0.55, 0.8, n1.add(n2).add(mx_noise_float(p.xz.mul(5.3).add(2.1)).mul(0.2)));
      const burn = mix(charcoal, vec3(0.2, 0.195, 0.185), drift.mul(0.85)).toVar();
      // Rust and ochre rings where the heat baked the soil.
      const ring = smoothstep(0.06, 0.0, abs(mx_noise_float(p.xz.mul(1.9).add(5.5)).sub(0.15))).mul(drift.oneMinus());
      burn.assign(mix(burn, vec3(0.16, 0.06, 0.018), ring.mul(0.6)));
      burn.assign(burn.mul(cr.x.mul(-0.7).add(1)));
      out.assign(mix(out, burn, dead.mul(0.95)));
    });
    return out;
  })() as unknown as Vec3Node;
}

/**
 * Embers in the cracks of a destroyed tile's ground: a dull red in the seams that pulses slowly
 * even by day (faint: in sunlight a bright glow would read as lava), and glows through the ash by
 * night. (Worked out only on a destroyed tile.)
 */
function embers(effects: TileEffects, amount: FloatNode): Vec3Node {
  return Fn(() => {
    const out = vec3(0, 0, 0).toVar();
    If(amount.greaterThan(0.75), () => {
      const p = positionWorld;
      const cr = burnCracks(p, effects.now);
      const pulse = sin(effects.now.mul(1.4).add(mx_noise_float(p.mul(2.2)).mul(7))).mul(0.4).add(0.6);
      const flicker = sin(effects.now.mul(5.3).add(mx_noise_float(p.mul(9)).mul(6))).mul(0.15).add(0.85);
      out.assign(vec3(1.0, 0.3, 0.05).mul(cr.x.mul(cr.y).mul(pulse).mul(flicker)).mul(smoothstep(0.75, 1, amount)).mul(mix(float(0.12), float(1.5), smoothstep(0.3, 0.8, effects.night))));
    });
    return out;
  })() as unknown as Vec3Node;
}

/** Soot on what stands on a polluted tile (buildings, carts, rocks): darker, and blacker still on a destroyed one. */
const soot = (col: Vec3Node, amount: FloatNode) => mix(col, vec3(luminance(col)).mul(0.18).add(vec3(0.006, 0.0055, 0.005)), amount.mul(0.92));

export function terrainMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  return pooled(effects, 'terrain', () => makeTerrainMaterial(effects));
}

function makeTerrainMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const tile = attribute<'float'>('tile', 'float');
  const fx = fxFor(effects, tile);
  m.positionNode = risen(effects, tile);
  const rocky = attribute<'float'>('rocky', 'float');
  // Each noise below only runs where its result is used: elsewhere it would be multiplied by
  // zero. (Screen derivatives and texture reads stay outside the branches.)
  const oreVein = Fn(() => {
    const ore = attribute<'float'>('ore', 'float');
    const v = float(0).toVar();
    If(ore.greaterThan(0), () => {
      const p = positionWorld;
      const w = mx_noise_float(p.mul(2.1)).mul(0.5);
      const seam = mx_noise_float(p.mul(vec3(4.5, 9, 4.5)).add(w)).abs();
      const flecks = smoothstep(0.55, 0.8, mx_worley_noise_float(p.mul(40)).oneMinus());
      v.assign(smoothstep(0.028, 0.006, seam).mul(flecks.mul(0.6).add(0.4)).mul(ore));
    });
    return v;
  })();
  // Rock strata, grain, crags and moss (x, y, z, w) on rocky ground, shared by the relief and
  // the shading so the fragment shader evaluates the noise once.
  const rockNoise = Fn(() => {
    const v = vec4(0, 0, 0, 0).toVar();
    If(rocky.greaterThan(0), () => {
      const p = positionWorld;
      v.assign(
        vec4(
          sin(p.y.mul(46).add(mx_noise_float(p.mul(vec3(3, 1, 3))).mul(3.6))),
          mx_fractal_noise_float(p.mul(vec3(14, 30, 14)), 3, 2, 0.5),
          mx_worley_noise_float(p.mul(9)),
          mx_noise_float(p.mul(5.5)).mul(0.5).add(0.5),
        ),
      );
    });
    return v;
  })();
  const strata = rockNoise.x;
  const grain = rockNoise.y;
  // The expansions' looks tell the shader two more things through the signs of attributes that
  // are never negative on the classic tiles (see terrain.ts): standing water and its soaked
  // margin through `meadow`, and gold in the gravel through `ore`.
  const wetMark = attribute<'float'>('meadow', 'float').negate();
  // The water's edge is found per pixel, where the mark (straight through the shore's depth near
  // the waterline: see terrain.ts waterMarks) crosses WATERLINE, sharp to a pixel and smoothed
  // over one, so the line follows the smooth depth field instead of the mesh. (The derivatives are
  // taken here, outside any branch.)
  const edgeWidth = max(abs(dFdx(wetMark)).add(abs(dFdy(wetMark))), 0.004);
  const standing = smoothstep(float(WATERLINE).sub(edgeWidth.mul(0.6)), float(WATERLINE).add(edgeWidth.mul(0.6)), wetMark);
  const soaked = smoothstep(0.0, 0.6, wetMark);
  // A narrow band of dark, wet ground along the edge itself, so the shore is a line of wet mud
  // or sand rather than a pale rim.
  const brink = smoothstep(WATERLINE - 0.24, WATERLINE - 0.02, wetMark).mul(standing.oneMinus());
  const gold = max(attribute<'float'>('ore', 'float').negate(), 0);
  // Still water ruffled by the breeze: two slow drifts of ripples (worked out only on the water).
  const ripples = Fn(() => {
    const v = vec2(0, 0).toVar();
    If(standing.greaterThan(0), () => {
      const p = positionWorld;
      const breeze = windStrength.mul(0.6).add(0.4);
      // (Pairs of the float noise the shader already carries, rather than a vector noise of its own.)
      const q = p.xz.mul(8).sub(windDir.mul(effects.now.mul(0.25)));
      const r = p.xz.mul(21).add(5.1);
      const ax = mx_noise_float(vec3(q, effects.now.mul(0.3)));
      const az = mx_noise_float(vec3(q.add(17.3), effects.now.mul(0.3)));
      const bx = mx_noise_float(vec3(r, effects.now.mul(0.55)));
      const bz = mx_noise_float(vec3(r.add(9.1), effects.now.mul(0.55)));
      v.assign(vec2(ax.mul(0.06).add(bx.mul(0.03)), az.mul(0.06).add(bz.mul(0.03))).mul(breeze).mul(standing));
    });
    return v;
  })();
  // Gold: specks in the washed gravel (screen derivatives outside the branch).
  const fade55 = detailFade(55);
  const goldFleck = Fn(() => {
    const v = float(0).toVar();
    If(gold.mul(fade55).greaterThan(0), () => {
      v.assign(smoothstep(0.8, 0.93, mx_worley_noise_float(positionWorld.mul(55)).oneMinus()).mul(gold).mul(fade55));
    });
    return v;
  })();
  // Rainwater pools in the hollows and on worn ground (where real puddles collect), filling
  // during a shower and shrinking from the edges as it drains. x = water, y = its wet rim.
  const pool = Fn(() => {
    const p = positionWorld;
    const worn = effects.contact.sample(p.xz).y;
    const trail = effects.trail.sample(p.xz);
    const v = vec2(0, 0).toVar();
    // Only while there is rain water about (a uniform, so the whole frame takes one branch).
    If(effects.puddles.greaterThanEqual(0.01), () => {
      const hollow = mx_noise_float(p.xz.mul(2.3).add(11.7)).mul(0.5).add(0.5);
      // Grass soaks it up; bare clay and packed earth hold it.
      const bare = grassy(vertexColor().rgb).oneMinus().mul(0.22);
      const basin = hollow.mul(0.75).add(bare).add(worn.mul(0.45)).add(trail.mul(0.3)).add(mx_noise_float(p.xz.mul(11)).mul(0.05));
      const level = float(1.18).sub(effects.puddles.mul(0.42));
      const flat = smoothstep(0.965, 0.99, normalWorldGeometry.y).mul(rocky.oneMinus());
      v.assign(vec2(smoothstep(level, level.add(0.02), basin), smoothstep(level.sub(0.08), level, basin)).mul(flat));
    });
    return v;
  })();
  m.normalNode = Fn(() => {
    const p = positionWorld;
    const rock = strata.mul(0.005).add(grain.mul(0.007)).add(rockNoise.z.mul(0.012));
    const turf = mx_noise_float(p.mul(28)).mul(0.0022).mul(detailFade(28)).add(mx_noise_float(p.mul(70)).mul(0.0008).mul(detailFade(70)));
    const ground = bumpedNormal(mix(turf, rock, rocky), 1);
    // Puddles: flat water, ringed by raindrops while it rains.
    const rings = rainRings(p.xz, effects.rain, 26).mul(0.35).mul(detailFade(26));
    const water = transformNormalToView(normalize(vec3(rings.x.negate().add(ripples.x), 1, rings.y.negate().add(ripples.y))));
    return normalize(mix(ground, water, max(pool.x, standing)));
  })();
  // Fresh out of the sea the ground streams wet, then dries in patches over a few seconds
  // (the noise can't bring a tile out longer than 9.5 s back under 7).
  const emergedWet = Fn(() => {
    const since = emergedFor(effects, tile);
    const v = float(0).toVar();
    If(since.lessThan(9.5), () => {
      v.assign(smoothstep(7, 0.5, since.add(mx_noise_float(positionWorld.mul(4)).mul(2.5))));
    });
    return v;
  })();
  const wetness = max(effects.wet, emergedWet);
  m.colorNode = Fn(() => {
    const p = positionWorld;
    // Fine variation, filtered so it never turns to sparkle in the distance, under broad
    // island-wide and per-tile variation that breaks up repeats.
    const micro = mx_noise_float(p.mul(22)).mul(0.07).mul(detailFade(22)).add(mx_noise_float(p.mul(6.5)).mul(0.05).mul(detailFade(6.5)));
    const c = vertexAlbedo().mul(micro.add(1)).mul(vertexTint()).mul(tileTint(tile)).toVar();
    const green = grassy(vertexColor().rgb).mul(rocky.oneMinus());
    // Gusts sweeping over the turf: blades bent by the wind show their paler sides.
    c.assign(c.mul(gust(p.xz).mul(green).mul(0.08).add(1)));
    // Rock strata and grain on steep rocky ground.
    const rockShade = mix(float(1), strata.mul(0.15).add(0.97).mul(grain.mul(0.15).add(0.97)), rocky);
    c.assign(c.mul(rockShade));
    // Moss settles on rock that faces up but away from the sun (damp, shaded ledges), and
    // gravel collects on the moderately steep ground at the foot of crags.
    const sunward = dot(normalWorld, effects.sunDir.normalize());
    const mossN = rockNoise.w;
    const moss = rocky.mul(smoothstep(0.55, 0.85, normalWorld.y)).mul(smoothstep(0.45, 0.05, sunward)).mul(smoothstep(0.35, 0.7, mossN));
    c.assign(mix(c, vec3(0.03, 0.05, 0.012), moss.mul(0.55)));
    const gravel = rocky.mul(smoothstep(0.5, 0.7, normalWorld.y)).mul(smoothstep(0.92, 0.75, normalWorld.y));
    const fade60 = detailFade(60).toVar();
    const pebbles = float(0).toVar();
    If(gravel.mul(fade60).greaterThan(0), () => {
      pebbles.assign(smoothstep(0.55, 0.8, mx_worley_noise_float(p.mul(60)).oneMinus()).mul(fade60));
    });
    c.assign(mix(c, c.mul(1.25).add(0.008), gravel.mul(pebbles).mul(0.6)));
    // Where things stand: darker in their shade, and bare, trodden earth round buildings and
    // the ends of roads.
    const contact = effects.contact.sample(p.xz);
    // Trails: grass pressed down by passing feet is paler and silvery; soil and sand are packed
    // darker. Well-used tracks wear through to earth.
    const trod = effects.trail.sample(p.xz);
    c.assign(mix(c, c.mul(vec3(1.16, 1.12, 0.86)).add(0.004), trod.mul(green).mul(0.7)));
    c.assign(c.mul(trod.mul(green.oneMinus()).mul(0.22).oneMinus()));
    const worn = max(contact.y, smoothstep(0.5, 1, trod).mul(0.85));
    // Trodden ground breaks up into patches of bare earth among the grass.
    const trodden = float(0).toVar();
    If(worn.mul(rocky.oneMinus()).greaterThan(0), () => {
      trodden.assign(worn.mul(rocky.oneMinus()).mul(smoothstep(0.15, 0.55, worn.add(mx_noise_float(p.mul(14)).mul(0.25)))));
    });
    // Packed earth is paler and dustier than the turf it replaces (a darker brown just reads
    // as shaded grass).
    c.assign(mix(c, vec3(0.11, 0.075, 0.04).mul(micro.add(1)), trodden.mul(0.9)));
    // Contact shade last, hugging whatever stands there.
    c.assign(c.mul(contact.x.mul(0.5).oneMinus()));
    // Ore veins: thin blue-silver seams threading through the mountain rock.
    c.assign(mix(c, vec3(0.17, 0.2, 0.25), oreVein.mul(0.6)));
    // Wildflower speckles in meadows (white, yellow, pink, violet).
    const meadow = attribute<'float'>('meadow', 'float');
    const cell = floor(p.xz.mul(95));
    const h1 = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
    const h2 = fract(sin(dot(cell, vec2(39.3468, 11.135))).mul(24634.6345));
    const inCell = fract(p.xz.mul(95)).sub(0.5).length();
    const dot1 = step(float(1).sub(meadow.mul(0.05)), h1).mul(step(inCell, 0.32)).mul(detailFade(95)).mul(worn.oneMinus());
    const flower = mix(mix(color('#fff8ec'), color('#ffd84a'), step(0.5, h2)), mix(color('#ff9ec4'), color('#b993ff'), step(0.8, h2)), step(0.7, fract(h2.mul(7.3))));
    c.assign(mix(c, flower, dot1));
    // Thin seam where two hexes meet (like the joins of a physical board).
    const e = hexEdgeDist(p.xz);
    const seam = smoothstep(0.0, 0.016, e);
    c.assign(c.mul(mix(float(0.72), float(1), seam)));
    // Rain-soaked ground reads darker and more saturated.
    c.assign(c.mul(mix(float(1), float(0.74), wetness)));
    // After a flood, darker still where the sea came over, drying out in patches (darker only: a
    // gloss would take the sky's colour and look like a sheet of water left behind).
    c.assign(c.mul(mix(float(1), float(0.62), soakedFor(effects, tile))));
    // Gold specks catch the light in the gravel.
    c.assign(mix(c, vec3(0.62, 0.42, 0.1), goldFleck.mul(0.85)));
    // Puddles: a dark, soaked rim, then muddy water. (Standing water has its own colour already:
    // rain only soaks its margin.)
    c.assign(mix(c, c.mul(0.55), max(pool.y.mul(0.6), soaked.mul(standing.oneMinus()).mul(0.5))));
    c.assign(c.mul(brink.mul(0.32).oneMinus()));
    c.assign(mix(c, c.mul(0.3).add(vec3(0.004, 0.005, 0.006)), pool.x.mul(standing.oneMinus())));
    return vec4(blight(scorch(c, max(scarFor(effects, tile), edgeScorch(effects, tile))), fx.y), 1);
  })();
  m.emissiveNode = Fn(() => {
    const pulse = sin(effects.now.mul(5)).mul(0.25).add(0.75);
    const glow = GOLD.mul(glowLight(effects)).mul(fx.x.mul(0.22).mul(pulse));
    const hover = vec3(0.95, 0.9, 0.7).mul(fx.z.mul(0.08));
    // Veins shimmer faintly, and flare when the mountain produces.
    const shimmer = vec3(0.25, 0.42, 0.7).mul(oreVein.mul(fx.x.mul(0.9)));
    // Snow sparkles: a few ice crystals per patch catch the sun, depending on where you look.
    // (Worked out only on snow: elsewhere it would be multiplied by zero.)
    const p = positionWorld;
    const snow = smoothstep(0.82, 0.9, luminance(vertexColor().rgb)).mul(smoothstep(0.6, 0.85, normalWorld.y));
    const fade240 = detailFade(240).toVar();
    const sparkle = vec3(0, 0, 0).toVar();
    // Gold glints, coarser than the snow's so they still catch the eye from the table, and
    // flaring when the field produces.
    const fade70 = detailFade(70).toVar();
    If(gold.mul(fade70).greaterThan(0), () => {
      const cell = floor(p.mul(70));
      const hc = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
      const facet = normalize(normalWorld.add(vec3(fract(hc.mul(13.7)).sub(0.5), 0, fract(hc.mul(29.3)).sub(0.5)).mul(0.9)));
      const view = normalize(cameraPosition.sub(p));
      const glint = pow(max(dot(normalize(view.add(effects.sunDir.normalize())), facet), 0), 60);
      sparkle.assign(vec3(1, 0.74, 0.3).mul(effects.sunTint).mul(glint.mul(step(0.95, hc)).mul(gold).mul(fade70).mul(fx.x.mul(4).add(2.5))));
    });
    // A sparser, coarser scatter of nuggets that still catches the eye from the table (where the
    // fine glints have faded), so the field names itself at the home view.
    const fade22 = detailFade(22).toVar();
    If(gold.mul(fade22).greaterThan(0), () => {
      const cell = floor(p.mul(22));
      const hc = fract(sin(dot(cell, vec3(41.37, 17.13, 93.71))).mul(24634.6345));
      const facet = normalize(normalWorld.add(vec3(fract(hc.mul(7.1)).sub(0.5), 0, fract(hc.mul(19.7)).sub(0.5)).mul(1.1)));
      const view = normalize(cameraPosition.sub(p));
      const glint = pow(max(dot(normalize(view.add(effects.sunDir.normalize())), facet), 0), 24);
      // (Only the middle of each lucky cell, so a nugget is a point, not a lit square.)
      const spot = smoothstep(0.32, 0.12, fract(p.xz.mul(22)).sub(0.5).length());
      sparkle.addAssign(vec3(1, 0.78, 0.36).mul(effects.sunTint).mul(glint.mul(step(0.975, hc)).mul(spot).mul(gold).mul(fade22).mul(fx.x.mul(3).add(1.6))));
    });
    If(snow.mul(fade240).greaterThan(0), () => {
      const cell = floor(p.mul(240));
      const hc = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
      const facet = normalize(normalWorld.add(vec3(fract(hc.mul(13.7)).sub(0.5), 0, fract(hc.mul(29.3)).sub(0.5)).mul(0.6)));
      const view = normalize(cameraPosition.sub(p));
      const glint = pow(max(dot(normalize(view.add(effects.sunDir.normalize())), facet), 0), 120);
      sparkle.addAssign(effects.sunTint.mul(glint.mul(step(0.93, hc)).mul(snow).mul(fade240).mul(3)));
    });
    // (No sunflecks on a polluted tile: its canopy is dying or gone.)
    const dapple = sunflecks(effects, vertexColor().rgb.mul(0.9), effects.contact.sample(p.xz).z.mul(pool.x.oneMinus()).mul(scarFor(effects, tile).oneMinus()));
    // Standing water gives back some of the daylight that goes into it, in its own colour (the
    // sea's shader scatters light the same way), so a pool reads as water and not as a hole
    // wherever it isn't mirroring the bright sky.
    const scatter = vertexAlbedo().mul(effects.sunTint).mul(standing.mul(0.3));
    // (Nothing glints in ash.)
    return glow.add(hover).add(shimmer).add(sparkle.mul(scarFor(effects, tile).oneMinus())).add(dapple).add(scatter).add(embers(effects, scarFor(effects, tile)));
  })();
  // Rain gathers on flat ground: it turns glossier there than on slopes, and puddles are glassy.
  const wetRough = mix(float(0.6), float(0.22), smoothstep(0.86, 0.98, normalWorld.y));
  m.roughnessNode = mix(mix(mix(mix(float(0.9), wetRough, wetness), float(0.3), max(oreVein, goldFleck)), float(0.6), soaked.mul(standing.oneMinus())), float(0.04), max(max(pool.x, standing), pool.y.mul(0.5)));
  m.metalnessNode = oreVein.mul(0.45).add(goldFleck.mul(0.5));
  return m;
}

/**
 * Breakers against the coast, in step with the sea's foam bands (see surf.ts): each one surges
 * up the rock and drains back, leaving it wet up to where it reached until it dries.
 */
function breakerAt(effects: TileEffects) {
  const p = positionWorld;
  const since = sinceBreaker(p.xz);
  const surge = smoothstep(0.0, 0.3, since).mul(smoothstep(1.8, 0.45, since));
  const reach = mx_noise_float(vec3(p.x.mul(3.1), 0.5, p.z.mul(3.1))).mul(0.5).add(0.5).mul(0.08).add(0.06).mul(effects.surf);
  const top = surge.mul(reach).add(SEA_LEVEL + 0.01);
  const mark = smoothstep(reach.add(SEA_LEVEL + 0.014), reach.add(SEA_LEVEL + 0.002), p.y).mul(exp(since.mul(-0.5)).mul(0.75).add(0.25)).mul(effects.surf);
  const waterline = smoothstep(SEA_LEVEL + 0.035, SEA_LEVEL + 0.005, p.y);
  return { since, surge, top, wet: max(mark, waterline) };
}

/**
 * Sandy coves. The breakers that surge up the cliffs (in step with the sea's foam bands) run
 * up the beach instead: a sheet of shallow water slides up the sand behind a foamy front, then
 * drains back down as thinning lace, leaving the sand dark and glossy where it reached. A line
 * of foam always rims the water's edge, so the sea meets the sand softly rather than along a
 * hard line. The dry sand has fine grain, and the damp sand ripple marks along the contours.
 */
/**
 * The coast's sand, for every beach on it in one mesh: each strip's vertices carry their tile
 * (attribute `tile`), which it rises with; the rest of the look is in world space.
 */
export function beachMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  return pooled(effects, 'beach', () => makeBeachMaterial(effects));
}

function makeBeachMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const tileNode = attribute<'float'>('tile', 'float');
  const fx = fxFor(effects, tileNode);
  m.positionNode = risen(effects, tileNode);
  const breaker = breakerAt(effects);
  const p = positionWorld;
  // How far up the sand each breaker runs, varying along the shore.
  const reach = mx_noise_float(vec3(p.x.mul(4.3), 1.5, p.z.mul(4.3))).mul(0.5).add(0.5).mul(0.018).add(0.022);
  const runup = breaker.surge.mul(reach).mul(effects.surf).add(SEA_LEVEL + 0.002);
  // Depth of the swash sheet over the sand (0 above the running water).
  const sheetD = runup.sub(p.y).max(0);
  const draining = smoothstep(0.4, 1.1, breaker.since);
  const sheet = smoothstep(0.0, 0.01, sheetD).mul(smoothstep(SEA_LEVEL - 0.03, SEA_LEVEL, p.y)).mul(effects.surf);
  // Wet where the last breaker reached, drying until the next.
  const mark = smoothstep(reach.add(SEA_LEVEL + 0.008), reach.add(SEA_LEVEL - 0.002), p.y).mul(exp(breaker.since.mul(-0.4)).mul(0.65).add(0.35)).mul(effects.surf);
  const wet = max(max(mark, sheet), smoothstep(SEA_LEVEL + 0.012, SEA_LEVEL - 0.005, p.y));
  const foam = Fn(() => {
    const t = effects.now;
    // Bubble walls (Worley cell edges), as on the sea's foam, rather than blotches.
    const cellA = mx_worley_noise_vec2(vec3(p.x.mul(40), p.z.mul(40), t.mul(0.6)));
    const cellB = mx_worley_noise_vec2(vec3(p.x.mul(110), p.z.mul(110), t.mul(0.9)));
    const lace = smoothstep(0.12, 0.02, cellA.y.sub(cellA.x));
    const fine = smoothstep(0.1, 0.015, cellB.y.sub(cellB.x));
    // The front: a thick roll of foam while the water climbs, fraying as it drains.
    const front = smoothstep(0.012, 0.0, abs(sheetD.sub(0.004))).mul(breaker.surge.mul(0.7).add(0.3));
    const surging = front.mul(mix(max(lace, fine).mul(0.4).add(0.6), max(lace, fine.mul(0.6)), draining));
    // Lace left behind in the draining sheet.
    const trail = sheet.mul(draining).mul(max(lace.mul(0.6), fine.mul(0.35)));
    // The rim where the sea meets the sand, always there.
    const rim = smoothstep(0.007, 0.0, abs(p.y.sub(SEA_LEVEL + 0.002))).mul(lace.mul(0.6).add(0.4));
    return max(max(surging, trail), rim).mul(effects.surf).mul(detailFade(34)).clamp(0, 1);
  })();
  m.colorNode = Fn(() => {
    const grain = mx_noise_float(p.mul(60)).mul(0.06).mul(detailFade(60)).add(mx_noise_float(p.mul(14)).mul(0.06));
    const ripples = sin(p.y.mul(233).add(mx_noise_float(p.mul(vec3(5, 2, 5))).mul(7))).mul(0.07).mul(detailFade(22));
    const damp = smoothstep(SEA_LEVEL + 0.045, SEA_LEVEL - 0.01, p.y);
    const c = vertexAlbedo().mul(grain.add(1)).mul(ripples.mul(damp).add(1)).toVar();
    c.assign(c.mul(wet.mul(0.4).oneMinus()));
    // Under the swash the sand shows through shallow sea water, greener and darker.
    c.assign(mix(c, c.mul(vec3(0.3, 0.45, 0.45)).add(vec3(0.02, 0.15, 0.18)), sheet.mul(0.85)));
    c.assign(mix(c, vec3(0.92, 0.95, 0.96), foam.mul(0.92)));
    return vec4(blight(scorch(c, scarFor(effects, tileNode).mul(0.7)), fx.y), 1);
  })();
  m.roughnessNode = mix(mix(float(0.95), float(0.22), wet), float(0.05), sheet.mul(foam.oneMinus()));
  m.emissiveNode = tileGlow(effects, fx, 0.16).add(vec3(0.8, 0.88, 0.92).mul(foam.mul(luminance(effects.sunTint).mul(0.12).add(0.02))));
  return m;
}

/**
 * Sea cliffs and coastal edges. The vertex colour carries the terrain's tint; the shader
 * paints soil horizons in world space: dark humus with pale roots under the turf lip, a
 * subsoil studded with rounded stones, then bedded rock with thin bedding planes and
 * cracks, wet and weedy at the waterline with surf washing against it.
 */
export function cliffMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  return pooled(effects, 'cliff', () => makeCliffMaterial(effects));
}

function makeCliffMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const tile = attribute<'float'>('tile', 'float');
  const fx = fxFor(effects, tile);
  m.positionNode = risen(effects, tile);

  // Depth below the rim, gently warped so horizons undulate instead of running ruler-straight.
  const depth = Fn(() => {
    const p = positionWorld;
    const y = p.y.sub(riseFor(effects, tile));
    return y.negate().add(mx_noise_float(p.mul(vec3(2.2, 0.6, 2.2))).mul(0.035));
  })();
  const topsoil = smoothstep(0.08, 0.035, depth);
  const subsoil = smoothstep(0.03, 0.07, depth).mul(smoothstep(0.27, 0.2, depth));
  const rock = smoothstep(0.19, 0.29, depth);
  // Each noise below only runs where its result is used: elsewhere it would be multiplied by
  // zero. (Screen derivatives stay outside the branches.)
  // Stones in the subsoil and rock (x = stone, y = dome, z = its tint): Worley cells in a
  // squashed space so they read as rounded cobbles in the bank.
  const stones = Fn(() => {
    const v = vec3(0, 0, 0).toVar();
    If(subsoil.add(rock).greaterThan(0), () => {
      const stoneSpace = vec3(positionWorld.x.mul(15), depth.mul(21), positionWorld.z.mul(15));
      const f1 = mx_worley_noise_float(stoneSpace);
      // Stone size and density vary across the bank: gravelly patches and bare clay.
      const sizeN = mx_noise_float(positionWorld.mul(3.1)).mul(0.5).add(0.5);
      const radius = sizeN.mul(0.16).add(0.14);
      const density = smoothstep(-0.35, 0.15, mx_noise_float(positionWorld.mul(1.7).add(7)));
      const stone = smoothstep(radius.add(0.05), radius.sub(0.03), f1).mul(subsoil.add(rock.mul(0.35))).mul(density);
      // Dome shading: light crown, darker toward the rim, so cobbles read as raised.
      const dome = f1.div(radius.add(0.05)).clamp(0, 1).oneMinus();
      v.assign(vec3(stone, dome, mx_noise_float(stoneSpace.mul(0.37)).mul(0.5).add(0.5)));
    });
    return v;
  })();
  const stone = stones.x;
  const dome = stones.y;
  const bed = sin(depth.mul(115).add(mx_noise_float(positionWorld.mul(vec3(4, 1, 4))).mul(5)));
  const bedLine = smoothstep(0.86, 1, bed).mul(rock);
  const crack = Fn(() => {
    const v = float(0).toVar();
    If(rock.greaterThan(0), () => {
      v.assign(smoothstep(0.06, 0.0, mx_worley_noise_float(positionWorld.mul(vec3(9, 3.5, 9))).sub(0.12).abs()).mul(rock));
    });
    return v;
  })();
  const grain = Fn(() => {
    const fade = detailFade(50).toVar();
    const v = float(0).toVar();
    If(fade.greaterThan(0), () => {
      v.assign(mx_fractal_noise_float(positionWorld.mul(vec3(36, 70, 36)), 3, 2, 0.5).mul(fade));
    });
    return v;
  })();
  const breaker = breakerAt(effects);
  // Behind a sandy cove the breakers run up the beach instead (see beachMaterial), so the
  // cliff stays dry and white water doesn't climb it.
  const open = attribute<'float'>('cove', 'float').oneMinus();
  // Wet rock: where the last breaker reached (drying until the next), and the whole bank for a
  // while after its tile comes up out of the sea, drying from the top down.
  const emerged = smoothstep(9, 1, emergedFor(effects, tile).sub(depth.mul(10)));
  const cliffWet = max(breaker.wet.mul(open), emerged.mul(0.85));
  // White water: a solid sheet as a breaker climbs the rock, breaking into lace as it drains.
  const splash = Fn(() => {
    const p = positionWorld;
    const sheet = smoothstep(breaker.top, breaker.top.sub(0.03), p.y).mul(smoothstep(SEA_LEVEL - 0.03, SEA_LEVEL, p.y));
    const v = float(0).toVar();
    // Only where the sheet of white water is.
    If(sheet.mul(effects.surf).mul(open).greaterThan(0), () => {
      const froth = smoothstep(0.3, 0.6, mx_worley_noise_float(vec3(p.x.mul(14), p.y.mul(30).add(effects.now.mul(0.6)), p.z.mul(14))));
      const draining = smoothstep(0.4, 1.1, breaker.since);
      // Thinning towards its ragged top edge.
      const edge = smoothstep(breaker.top, breaker.top.sub(0.05).add(froth.mul(0.03)), p.y);
      const body = mix(edge.mul(0.25).add(0.75), froth.mul(edge).mul(0.9), draining);
      v.assign(sheet.mul(body).mul(breaker.surge.mul(0.85).add(0.15)).mul(effects.surf).mul(open).clamp(0, 1));
    });
    return v;
  })();

  m.normalNode = Fn(() => {
    const p = positionWorld;
    const strata = sin(p.y.mul(38).add(mx_noise_float(p.mul(vec3(2.5, 1, 2.5))).mul(5)));
    const blocks = mx_worley_noise_float(p.mul(vec3(7, 13, 7)));
    const h = strata.mul(0.006).add(blocks.mul(0.016)).add(grain.mul(0.005)).add(stone.mul(dome.pow(0.5)).mul(0.014)).sub(crack.mul(0.006)).add(bed.mul(rock).mul(0.002));
    return bumpedNormal(h, 1);
  })();
  m.colorNode = Fn(() => {
    const p = positionWorld;
    const base = vertexAlbedo().mul(grain.mul(0.16).add(1));
    const c = base.toVar();
    // Humus: darker and richer, with pale fibrous roots hanging from the turf.
    c.assign(mix(c, c.mul(vec3(0.55, 0.5, 0.45)), topsoil.mul(0.55)));
    const roots = smoothstep(0.94, 1, sin(p.x.add(p.z).mul(160).add(mx_noise_float(p.mul(9)).mul(8)))).mul(topsoil).mul(smoothstep(0.004, 0.02, depth)).mul(detailFade(160));
    c.assign(mix(c, vec3(0.16, 0.1, 0.05), roots.mul(0.55)));
    // Subsoil mottling, then the stones with their own varied greys.
    c.assign(c.mul(mx_noise_float(p.mul(11)).mul(0.1).add(1)));
    const stoneTint = mix(vec3(0.15, 0.12, 0.09), vec3(0.1, 0.085, 0.07), stones.z);
    const lit = stoneTint.mul(dome.pow(0.6).mul(0.45).add(0.65));
    c.assign(mix(c, lit.mul(base.mul(0.4).add(0.75)), stone.mul(0.9)));
    // Bedded rock: thin dark bedding planes and hairline cracks.
    c.assign(c.mul(float(1).sub(bedLine.mul(0.32)).sub(crack.mul(0.35))));
    const y = p.y.sub(riseFor(effects, tile));
    // Damp just above the waterline.
    const damp = smoothstep(-0.22, -0.42, y).mul(0.3);
    const wetC = blight(scorch(c.mul(float(1).sub(damp)).mul(cliffWet.mul(0.38).oneMinus()).mul(soakedFor(effects, tile).mul(0.3).oneMinus()), scarFor(effects, tile).mul(0.6)), fx.y).toVar();
    wetC.assign(mix(wetC, vec3(0.94, 0.97, 0.98), splash.mul(0.95)));
    return vec4(wetC, 1);
  })();
  m.roughnessNode = mix(mix(float(0.95), float(0.5), effects.wet), float(0.32), max(smoothstep(-0.3, -0.42, positionWorld.y.sub(riseFor(effects, tile))), cliffWet));
  // The sides light up with the tile when it produces.
  // White water scatters skylight, so it stays bright on a cliff in shade.
  m.emissiveNode = tileGlow(effects, fx, 0.16).add(vec3(0.8, 0.88, 0.92).mul(splash.mul(luminance(effects.sunTint).mul(0.12).add(0.02))));
  return m;
}

interface FoliageOptions {
  /** Height (in local geometry units) at which sway reaches full strength. */
  swayHeight: number;
  swayAmount: number;
  /** Subsurface translucency strength (backlit glow). */
  translucency?: number;
  roughness?: number;
  /** Use per-instance colour attribute `aColor` (vec3) multiplied with vertex colours. */
  instanceColor?: boolean;
  flatShading?: boolean;
  /** Trees: the trunk sways slowly, branches bob faster and leaves tremble at their tips. */
  tree?: boolean;
  /** Ground cover that is pressed flat along trails (grass, flowers, ferns). */
  trample?: boolean;
  /** How much paler blades turn as a gust bends them (grass and crops). */
  sheen?: number;
  /** Lit by sunflecks through the canopy above (undergrowth). */
  dapple?: boolean;
}

/**
 * Foliage / vegetation material for instanced meshes: every plant leans with the one wind and
 * flutters about that lean, harder as a gust sweeps over it; production sends a ring of gust
 * out from the tile centre. Backlit translucency and per-tile effects.
 */
export function foliageMaterial(effects: TileEffects, o: FoliageOptions): THREE.MeshStandardNodeMaterial {
  return pooled(effects, `foliage:${JSON.stringify(o)}`, () => makeFoliageMaterial(effects, o));
}

function makeFoliageMaterial(effects: TileEffects, o: FoliageOptions): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: o.roughness ?? 0.8, metalness: 0 });
  m.flatShading = !!o.flatShading;
  const tile = attribute<'float'>('aTile', 'float');
  const fx = fxFor(effects, tile);
  const phaseAttr = attribute<'float'>('aPhase', 'float');
  const across = vec2(windDir.y.negate(), windDir.x);
  // Leaf tremble: a fast shiver that runs through the canopy in small patches.
  const tremble = Fn(() => {
    const q = positionGeometry;
    return sin(time.mul(9.5).add(dot(q, vec3(53, 37, 61))).add(phaseAttr)).mul(0.6).add(sin(time.mul(13.1).add(dot(q, vec3(-41, 67, 29)))).mul(0.4));
  })();

  m.positionNode = Fn(() => {
    const p = positionLocal.toVar();
    const h = clamp(positionGeometry.y.div(o.swayHeight), 0, 1);
    const hw = h.mul(h);
    const t = time;
    const wp = p.xz;
    const g = gust(wp);
    const w = windFor(g);
    const along = dot(wp, windDir);
    // Gust: a ring travelling outward from the tile centre after a production event.
    const gustAge = effects.now.sub(fx.w);
    const ring = smoothstep(0.0, 0.15, gustAge).mul(smoothstep(2.2, 0.6, gustAge)).mul(sin(gustAge.mul(9)).mul(0.5).add(0.9)).mul(2.2);
    // Lean downwind, and flutter about the lean: slow sways for trees, quicker for small plants.
    const f = o.tree ? 0.85 : 2.1;
    const flutter = sin(t.mul(f).add(along.mul(1.3)).add(phaseAttr)).mul(0.55).add(sin(t.mul(f * 1.9).add(phaseAttr.mul(1.7))).mul(0.2));
    const bend = w.mul(flutter.mul(g.mul(0.5).add(0.3)).add(0.55)).mul(ring.add(1)).mul(float(o.swayAmount).mul(hw));
    const side = sin(t.mul(f * 0.8).add(phaseAttr.mul(2.3))).mul(w).mul(float(o.swayAmount * 0.25).mul(hw));
    p.x.addAssign(windDir.x.mul(bend).add(across.x.mul(side)));
    p.z.addAssign(windDir.y.mul(bend).add(across.y.mul(side)));
    // Stems keep their length: bending over lowers the tip a little.
    p.y.subAssign(bend.mul(bend).div(o.swayHeight * 2));
    if (o.tree) {
      // Branches bob and swing on their own, more the further they reach from the trunk...
      const reach = smoothstep(0.02, 0.1, positionGeometry.xz.length());
      const bp = dot(positionGeometry, vec3(17, 9, 23)).add(phaseAttr);
      const bob = sin(t.mul(2.1).add(bp)).mul(w).mul(reach).mul(0.0035);
      p.y.addAssign(bob);
      p.x.addAssign(windDir.x.mul(bob).mul(0.8));
      p.z.addAssign(windDir.y.mul(bob).mul(0.8));
      // ...and the leaves at their tips shiver, more in a gust.
      const shiver = tremble.mul(reach).mul(g.mul(0.7).add(0.3)).mul(windStrength).mul(0.0012);
      p.x.addAssign(shiver);
      p.y.addAssign(shiver.mul(0.6));
    }
    if (o.trample) {
      // Pressed flat along trails, springing back as they fade.
      const trod = effects.trail.sampleLevel(wp);
      p.y.subAssign(positionGeometry.y.mul(trod).mul(0.55));
      p.x.addAssign(cos(phaseAttr).mul(positionGeometry.y).mul(trod).mul(0.5));
      p.z.addAssign(sin(phaseAttr).mul(positionGeometry.y).mul(trod).mul(0.5));
    }
    // Pollution: plants wither and droop towards the ground; on a destroyed tile, ground cover is
    // burnt to stubble and trees to bare, blackened snags. (Measured from each plant's own foot:
    // positionLocal is already placed by its instance, whose scale aRiseScale undoes.)
    const scar = scarFor(effects, tile);
    const dead = smoothstep(0.75, 1, scar);
    const inv = attribute<'float'>('aRiseScale', 'float');
    const wither = mix(float(1), mix(float(0.62), float(o.tree ? 0.7 : 0.16), dead), smoothstep(0.0, 0.5, scar));
    p.y.addAssign(positionGeometry.y.mul(wither.sub(1)).div(inv));
    if (o.tree) {
      // The canopy burnt away: its surface drawn in to the trunk along its own normals (which
      // point out from the trunk), leaving a thin, ragged snag.
      const reach = positionGeometry.xz.length().div(inv);
      const inward = normalLocal.xz.div(normalLocal.xz.length().max(0.001));
      p.x.subAssign(inward.x.mul(reach).mul(dead.mul(0.8)));
      p.z.subAssign(inward.y.mul(reach).mul(dead.mul(0.8)));
    }
    p.y.addAssign(riseFor(effects, tile).mul(attribute<'float'>('aRiseScale', 'float')));
    return p;
  })();

  m.colorNode = Fn(() => {
    let c: Vec3Node = vertexAlbedo();
    if (o.instanceColor) c = c.mul(attribute<'vec3'>('aColor', 'vec3'));
    const micro = mx_noise_float(positionWorld.mul(30)).mul(0.08).mul(detailFade(30)).add(1);
    if (o.sheen) c = c.mul(gust(positionWorld.xz).mul(o.sheen).add(1));
    // Blades pressed flat on a trail show their paler undersides.
    if (o.trample) c = c.mul(effects.trail.sample(positionWorld.xz).mul(vec3(0.22, 0.2, 0.05)).add(1));
    // Pollution: plants die back brown and grey, and on a destroyed tile are charred.
    const scar = scarFor(effects, tile);
    const dead = mix(c, vec3(luminance(c)).mul(vec3(0.55, 0.42, 0.26)).add(vec3(0.012, 0.008, 0.004)), smoothstep(0.0, 0.5, scar));
    const burnt = mix(dead, vec3(0.012, 0.011, 0.01), smoothstep(0.75, 1, scar).mul(0.9));
    return vec4(blight(burnt.mul(micro).mul(vertexTint()), fx.y), 1);
  })();

  const tr = o.translucency ?? 0;
  m.emissiveNode = Fn(() => {
    const view = normalize(cameraPosition.sub(positionWorld));
    // Trembling leaves catch the light behind them unevenly, so a backlit canopy glitters.
    const flicker = o.tree ? tremble.mul(0.18).add(1) : float(1);
    const back = pow(max(dot(view, effects.sunDir.negate()), 0), 3).mul(tr).mul(flicker);
    const wrap = max(dot(normalWorld, effects.sunDir).mul(-0.5).add(0.5), 0).mul(tr * 0.35);
    let c: Vec3Node = vertexColor().rgb;
    if (o.instanceColor) c = c.mul(attribute<'vec3'>('aColor', 'vec3'));
    const sss = c.mul(vec3(1.1, 1.25, 0.6)).mul(back.add(wrap)).mul(effects.sunTint);
    const pulse = sin(effects.now.mul(5)).mul(0.25).add(0.75);
    const glow = GOLD.mul(glowLight(effects)).mul(fx.x.mul(0.22).mul(pulse));
    const dapple = o.dapple ? sunflecks(effects, c.mul(0.8), effects.contact.sample(positionWorld.xz).z) : vec3(0, 0, 0);
    return sss.add(dapple).mul(float(1).sub(fx.y.mul(0.8))).mul(scarFor(effects, tile).oneMinus()).add(glow);
  })();
  return m;
}

/** Plain lit material for props (buildings, rocks, carts) that still honours per-tile effects. */
export type PropOptions = { roughness?: number; metalness?: number; instanced?: boolean; fuzz?: boolean; surfaces?: boolean };

export function propMaterial(effects: TileEffects, opts: PropOptions = {}) {
  return pooled(effects, `prop:${JSON.stringify(opts)}`, () => {
    const m = makePropMaterial(effects, opts);
    // (So a part made with it can be drawn as an instance instead: see propBatches.ts.)
    if (!opts.instanced) propLooks.set(m, opts);
    return m;
  });
}

/** Each (not instanced) prop material's look. */
const propLooks = new WeakMap<THREE.Material, PropOptions>();

/** The look a prop material was made with, or undefined for any other material. */
export function propLookOf(m: THREE.Material): PropOptions | undefined {
  return propLooks.get(m);
}

/**
 * The same as propMaterial(effects, opts) for a part drawn as one instance among many (see
 * propBatches.ts): its tile and its size in the world come from its instance (aTile, aScale)
 * rather than its geometry and its transform.
 */
export function propInstancedMaterial(effects: TileEffects, opts: PropOptions = {}) {
  return pooled(effects, `propI:${JSON.stringify(opts)}`, () => makePropMaterial(effects, opts, true));
}

/**
 * propMaterial(effects, opts) for one batched mesh of parts (see standInBatch.ts): each part's
 * tile on its geometry as before, its size in the world (for the surface patterns) its instance's.
 */
export function propBatchedMaterial(effects: TileEffects, opts: PropOptions, batch: THREE.BatchedMesh) {
  return makePropMaterial(effects, opts, false, batch);
}

function makePropMaterial(effects: TileEffects, opts: PropOptions, asInstance = false, batch?: THREE.BatchedMesh) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: opts.roughness ?? 0.75, metalness: opts.metalness ?? 0 });
  const tile = opts.instanced || asInstance ? attribute<'float'>('aTile', 'float') : attribute<'float'>('tile', 'float');
  const fx = fxFor(effects, tile);
  m.positionNode = risen(effects, tile, !!opts.instanced);
  if (opts.instanced) {
    // On a destroyed tile what stood there (sheep, log piles, toadstools) sinks into the ash,
    // flattened down to its own foot (positionLocal is already placed by its instance, whose
    // height scale aRiseScale undoes).
    const left = smoothstep(1, 0.8, scarFor(effects, tile));
    m.positionNode = (m.positionNode as Node<'vec3'>).add(vec3(0, positionGeometry.y.mul(left.sub(1)).div(attribute<'float'>('aRiseScale', 'float')), 0));
  }
  // Optional surface patterns (planks, sailcloth...) from the geometry's surface ids, as on the tile
  // props (at the part's own size: see tilePropInstancedMaterial).
  const size = asInstance ? worldScale.mul(attribute<'float'>('aScale', 'float')) : batch ? worldScale.mul(varying(mat3(batchMatrix(batch)).mul(vec3(1, 0, 0)).length() as unknown as FloatNode) as unknown as FloatNode) : worldScale;
  const albedo = opts.surfaces ? vertexAlbedo().mul(surfaceShade(attribute<'float'>('surface', 'float'), positionGeometry, normalGeometry, size)) : vertexAlbedo();
  m.colorNode = Fn(() => vec4(blight(soot(albedo, scarFor(effects, tile)), fx.y), 1))();
  m.emissiveNode = Fn(() => {
    const pulse = sin(effects.now.mul(5)).mul(0.25).add(0.75);
    const glow = GOLD.mul(glowLight(effects)).mul(fx.x.mul(0.18).mul(pulse));
    if (!opts.fuzz) return glow;
    // Fleece: the fibres scatter light at the silhouette (a soft sheen, brightest on the lit
    // side) and let it wrap a little past the terminator, so wool reads soft, not plastic.
    const view = normalize(cameraPosition.sub(positionWorld));
    const ndl = dot(normalWorld, effects.sunDir.normalize());
    const rim = pow(float(1).sub(max(dot(normalWorld, view), 0)), 3).mul(ndl.mul(0.5).add(0.5));
    const wrap = max(ndl.mul(0.5).add(0.5).sub(max(ndl, 0)), 0);
    return glow.add(blight(vertexAlbedo(), fx.y).mul(effects.sunTint).mul(rim.mul(0.4).add(wrap.mul(0.15))));
  })();
  return m;
}

/** Rock material: mossy tops on upward-facing surfaces, cool crevices. */
export function rockMaterial(effects: TileEffects, mossy = true, shore = false) {
  return pooled(effects, `rock:${mossy}:${shore}`, () => makeRockMaterial(effects, mossy, shore));
}

function makeRockMaterial(effects: TileEffects, mossy: boolean, shore: boolean) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  const tile = attribute<'float'>('aTile', 'float');
  const fx = fxFor(effects, tile);
  // Rocks only exist once their tile breaks the surface: while it is still under the sea they
  // shrink to nothing (never left bobbing on the water), growing in as it rises.
  {
    const r = riseFor(effects, tile);
    const inv = attribute<'float'>('aRiseScale', 'float');
    if (shore) {
      // Shore boulders heave up out of the sea in a wave that runs round the coast: each one
      // (staggered by aPhase, 0..1 round the island) climbs from below the surface, overshoots
      // a touch and settles, swelling from a smaller core as it comes.
      const SPAN = 0.3;
      const q = clamp(effects.shoreRocks.sub(attribute<'float'>('aPhase', 'float').mul(1 - SPAN)).div(SPAN), 0, 1);
      const climb = q.oneMinus().pow(3).oneMinus();
      const settle = sin(q.mul(Math.PI)).mul(0.06);
      const lift = climb.oneMinus().mul(-0.55).add(settle);
      const grown = smoothstep(-0.6, -0.05, r).mul(smoothstep(0, 0.35, q).mul(0.45).add(0.55)).mul(step(0.001, q));
      m.positionNode = positionLocal.mul(grown).add(vec3(0, r.add(lift).mul(inv), 0));
    } else {
      m.positionNode = positionLocal.mul(smoothstep(-0.6, -0.05, r)).add(vec3(0, r.mul(inv), 0));
    }
  }
  m.normalNode = Fn(() => {
    const p = positionWorld;
    // The fine relief only where it's still resolved (screen derivatives outside the branches).
    const f22 = detailFade(22).toVar();
    const f40 = detailFade(40).toVar();
    const h = float(0).toVar();
    If(f22.greaterThan(0), () => {
      h.addAssign(mx_worley_noise_float(p.mul(22)).mul(0.006).mul(f22));
    });
    If(f40.greaterThan(0), () => {
      h.addAssign(mx_fractal_noise_float(p.mul(40), 2, 2, 0.5).mul(0.003).mul(f40));
    });
    return bumpedNormal(h, 1);
  })();
  // Shore boulders are washed by the same breakers as the cliffs.
  const wet = shore ? breakerAt(effects).wet : float(0);
  m.colorNode = Fn(() => {
    const p = positionWorld;
    const base = vertexAlbedo().mul(mx_fractal_noise_float(p.mul(14), 3, 2, 0.5).mul(0.16).mul(detailFade(14)).add(1)).mul(vertexTint()).toVar();
    if (mossy) {
      const up = smoothstep(0.35, 0.85, normalWorld.y.add(mx_noise_float(p.mul(9)).mul(0.35)));
      base.assign(mix(base, vec3(0.028, 0.048, 0.009), up.mul(0.85)));
    }
    return vec4(blight(soot(base.mul(wet.mul(0.25).oneMinus()), scarFor(effects, tile).mul(0.8)), fx.y), 1);
  })();
  if (shore) m.roughnessNode = mix(float(0.88), float(0.3), wet);
  m.emissiveNode = tileGlow(effects, fx, 0.2);
  return m;
}


/**
 * Prop material bound to one tile (for shared, non-instanced geometry such as
 * sheep, windmills, kilns and mine carts): applies that tile's rise offset,
 * robber blight and production glow.
 */
export function tilePropMaterial(effects: TileEffects, tile: number, opts: TilePropOptions = {}): THREE.MeshStandardNodeMaterial {
  return pooled(effects, `tileProp:${tile}:${JSON.stringify(opts)}`, () => {
    const m = makeTilePropMaterial(effects, tile, opts);
    // (So a prop made with it can be drawn as an instance instead: see propBatches.ts.)
    tileProps.set(m, { tile, opts });
    return m;
  });
}

export type TilePropOptions = { roughness?: number; metalness?: number; emissive?: [number, number, number]; flatShading?: boolean; side?: THREE.Side; surfaces?: boolean };

/** Each tile prop material's tile and look. */
const tileProps = new WeakMap<THREE.Material, { tile: number; opts: TilePropOptions }>();

/** The tile and look a tile prop material was made for, or undefined for any other material. */
export function tilePropOf(m: THREE.Material): { tile: number; opts: TilePropOptions } | undefined {
  return tileProps.get(m);
}

/**
 * The tile props' look for a prop drawn as one instance among many (see propBatches.ts): its tile,
 * its size in the world (for the surface patterns) and its own origin (which a destroyed tile's
 * props shrink to) come from its instance (aTile, aScale, aPivot) instead of the material. One
 * for every tile, so a mine's parts on every mountain are a draw each, not one per mountain.
 */
export function tilePropInstancedMaterial(effects: TileEffects, opts: TilePropOptions = {}): THREE.MeshStandardNodeMaterial {
  return pooled(effects, `tilePropI:${JSON.stringify(opts)}`, () => makeTilePropMaterial(effects, null, opts));
}

/** A tile prop material for `tile`, or (null) the instanced one, which reads its tile, size and origin from each instance. */
function makeTilePropMaterial(effects: TileEffects, tile: number | null, opts: TilePropOptions): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: opts.roughness ?? 0.8, metalness: opts.metalness ?? 0 });
  m.flatShading = !!opts.flatShading;
  if (opts.side !== undefined) m.side = opts.side;
  // A uniform (not a baked constant) so every tile's prop material shares one shader and pipeline.
  const tileNode = tile === null ? attribute<'float'>('aTile', 'float') : uniform(tile);
  const fx = fxFor(effects, tileNode);
  // On a destroyed tile what stood there is gone, consumed as the blight reaches it: shrunk to its
  // own origin (an instance's is aPivot, in the instanced mesh's space, as positionLocal is).
  const left = smoothstep(1, 0.8, scarFor(effects, tileNode));
  const own = tile === null ? positionLocal.sub(attribute<'vec3'>('aPivot', 'vec3')) : positionLocal;
  m.positionNode = risen(effects, tileNode).sub(own.mul(left.oneMinus()));
  // Optional surface patterns (whitewash, a sooty kiln...) from the geometry's surface ids, at the
  // prop's size (an instance's own scale is aScale: the instanced mesh's is the board's).
  const size = tile === null ? worldScale.mul(attribute<'float'>('aScale', 'float')) : worldScale;
  const albedo = opts.surfaces ? vertexAlbedo().mul(surfaceShade(attribute<'float'>('surface', 'float'), positionGeometry, normalGeometry, size)) : vertexAlbedo();
  m.colorNode = Fn(() => vec4(blight(soot(albedo, scarFor(effects, tileNode)), fx.y), 1))();
  const em = opts.emissive;
  m.emissiveNode = Fn(() => {
    const pulse = sin(effects.now.mul(5)).mul(0.25).add(0.75);
    const base = em ? vec3(em[0], em[1], em[2]) : vec3(0, 0, 0);
    return base.add(GOLD.mul(glowLight(effects)).mul(fx.x.mul(0.16).mul(pulse)));
  })();
  return m;
}
