// Rivers (the Rivers module): water running from a spring in the hills down to the sea across
// the river tiles, in the channel the heightfield cut for it (see riverCourse.ts). A current you
// can see (ripples and foam streaks carried downstream, faster where it tumbles), reeds and
// pebbles at the banks, stepping stones where a stretch runs straight, and at the mouth the
// river pours over the cliff lip into the sea in a curtain of white water with spray at its foot.

import * as THREE from 'three/webgpu';
import { Fn, If, attribute, clamp, float, int, mix, mx_noise_float, normalLocal, positionLocal, positionWorld, smoothstep, step, time, transformNormalToView, vec2, vec3, vec4, abs, max, min, cos, normalize, cameraPosition, dot, pow } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { pooled, bumpedNormal, detailFade, rockMaterial, foliageMaterial, type TileEffects } from './materials';
import { windDir, windStrength } from '../env/wind';
import { lampColor } from '../fx/lamps';
import type { TileInfo } from './tiles';
import type { Reserved } from './decor';
import type { LifeContext, LifeModule } from './life/common';
import { RIVER_STEP, sideNormal, type RiverCourse } from './riverCourse';
import { DETAIL_LAYER, SEA_LEVEL } from './layout';
import { MeshBuilder } from './geom';
import { BatchSet, trs } from './instancing';
import { makeRock } from './flora';
import { Rand, type Noise } from '../util/noise';
import { PALETTE, sideDistance, topColor } from './terrain';
import { Parts, stillProps } from './life/props';
import { SURFACE } from './surfaces';

/**
 * The liquid material, shared by the rivers and the oil wells' slicks: one shader for all of it.
 * Each vertex carries `aWater` (x: the flow phase, how far calm water would have carried the
 * current to here, unbroken from tile to tile; y: distance across it from the middle; z: how
 * agitated the water is, for foam and white water, or -1 for oil; w: 0 in the middle to 1 at the
 * water's edge), `aStill` (rgb: the colour of the standing water the river runs out into there,
 * as the terrain's vertices carry it; a: how far it has become that water) and `tile` (whose rise
 * it follows as the island comes up out of the sea).
 */
function liquidMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  return pooled(effects, 'liquid', () => makeLiquidMaterial(effects));
}

/**
 * The island's fresh water, one look for the river, its falls and the standing water it runs into
 * (the lake, the pools, the oasis): the lake's own palette (terrain.ts PALETTE) as the terrain's
 * shader shows it (its vertex colours squared), deep in the middle and paler and greener at the
 * banks. (A bluer, darker water of the rivers' own would meet the lake at a change of colour where
 * a river empties into it.)
 */
const sq = (c: THREE.Color) => vec3(c.r * c.r, c.g * c.g, c.b * c.b);
const FRESH = { deep: sq(PALETTE.lakeDeep), mid: sq(PALETTE.lakeMid), shallow: sq(PALETTE.lakeShallow), aerated: vec3(0.2, 0.32, 0.32) };

/** Calm water's speed (world units a second): the pattern moves at this, the flow phase does the rest (see riverFlows). */
const FLOW = 0.16;

function makeLiquidMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0 });
  // (Seen from below where a fall curls over the lip.)
  m.side = THREE.DoubleSide;
  const w = attribute<'vec4'>('aWater', 'vec4');
  const still = attribute<'vec4'>('aStill', 'vec4');
  const tile = attribute<'float'>('tile', 'float');
  const oil = smoothstep(-0.5, -0.9, w.z);
  // Where the river runs out into standing water (a pond, a lake, the swamp's pools), it takes on
  // that water's look: its colour, its stillness and its breeze-ruffled ripples, so the two meet
  // with no seam.
  const calm = still.w;
  // How rough it runs: nothing on the flat, all white water down a cascade, thinning slowly for a
  // long way below one (the agitation in aWater.z already carries that tail, see riverFlows).
  const tumble = min(max(w.z, 0).mul(0.75), 1).mul(calm.oneMinus());
  m.positionNode = Fn(() => positionLocal.add(vec3(0, effects.rise.element(int(tile)) as unknown as Node<'float'>, 0)))();
  // Downstream: one speed for the whole river. aWater.x is a flow phase that advances less per
  // unit of length where the water runs fast, so the pattern races and stretches out down a
  // cascade. (Scaling time by the local speed instead shears the pattern a little more every
  // second wherever the speed changes, until it breaks up into bands of glitter.) Oil only crawls.
  const along = w.x.sub(time.mul(mix(float(FLOW), float(0.004), oil)));
  // Ripples stretched along the current, with a slower swell under them (oil: lazy swirls). The
  // finer octave, and then the ripples themselves, fade out before a pixel is too coarse to
  // resolve them: under a glassy roughness they would otherwise alias into sparkle.
  const p = mix(vec3(along.mul(14), w.y.mul(28), time.mul(0.35)), vec3(positionWorld.x.mul(9), positionWorld.z.mul(9), time.mul(0.05)), oil);
  const fineFade = max(detailFade(64), oil);
  const ripple = mx_noise_float(p).mul(0.6).add(mx_noise_float(p.mul(vec3(2.3, 2.1, 1.6))).mul(fineFade.mul(0.3)));
  const coarseFade = detailFade(28);
  // (Screen derivatives stay outside any branch: the only one here holds nothing but noise.)
  const flowing = bumpedNormal(ripple, mix(float(0.0026).add(tumble.mul(0.0026)).mul(coarseFade), float(0.0012), oil));
  // The standing water's own ripples, as the terrain's shader draws them (materials.ts): two slow
  // drifts down the wind, in world space, so they run on across the join unbroken.
  const ruffle = Fn(() => {
    const v = vec2(0, 0).toVar();
    If(calm.greaterThan(0.001), () => {
      const q = positionWorld.xz.mul(8).sub(windDir.mul(effects.now.mul(0.25)));
      const r = positionWorld.xz.mul(21).add(5.1);
      const ax = mx_noise_float(vec3(q, effects.now.mul(0.3)));
      const az = mx_noise_float(vec3(q.add(17.3), effects.now.mul(0.3)));
      const bx = mx_noise_float(vec3(r, effects.now.mul(0.55)));
      const bz = mx_noise_float(vec3(r.add(9.1), effects.now.mul(0.55)));
      v.assign(vec2(ax.mul(0.06).add(bx.mul(0.03)), az.mul(0.06).add(bz.mul(0.03))).mul(windStrength.mul(0.6).add(0.4)));
    });
    return v;
  })();
  const pondNormal = transformNormalToView(normalize(vec3(ruffle.x, 1, ruffle.y)));
  m.normalNode = normalize(mix(flowing, pondNormal, calm));
  // Foam. The streaks wander (their across coordinate warped by a slow noise), so they braid and
  // gather instead of running in ruled lines, and broad pockets drift down with the current where
  // it collects: behind a fall, and as scum in the slack water by the banks. How much there is
  // follows the agitation, so it thins out gradually below a cascade into calm water.
  const warp = mx_noise_float(vec3(along.mul(2.4), w.y.mul(9), time.mul(0.15)));
  const streakFade = detailFade(36);
  const streak = mix(float(0.5), mx_noise_float(vec3(along.mul(5), w.y.add(warp.mul(0.024)).mul(36), time.mul(0.45))).mul(0.5).add(0.5), streakFade);
  const pocket = mx_noise_float(vec3(along.mul(2.2).add(13.7), w.y.mul(14), time.mul(0.25))).mul(0.5).add(0.5);
  const bank = smoothstep(0.72, 1.02, w.w).mul(smoothstep(0.45, 0.8, pocket)).mul(calm.oneMinus());
  // (A little even on the flat: stray flecks drifting down show which way it runs.)
  const carry = tumble.mul(1.1).add(bank.mul(0.6)).add(calm.oneMinus().mul(0.14));
  const froth = streak.mul(0.65).add(pocket.mul(0.35));
  const foam = smoothstep(float(1.0).sub(carry.mul(0.6)), float(1.1).sub(carry.mul(0.45)), froth).mul(oil.oneMinus());
  // The island's fresh water (FRESH: the lake's): deep in the middle, paler and greener in the
  // shallows at the banks. Aerated water, paler where it tumbles, in patches with the streaks
  // (never one even sheet of pale).
  const water = mix(mix(mix(FRESH.deep, FRESH.mid, smoothstep(0.35, 0.8, w.w)), FRESH.shallow, smoothstep(0.75, 1.0, w.w)), FRESH.aerated, tumble.mul(streak.mul(0.35).add(0.25))).mul(ripple.mul(0.2).add(0.96));
  m.colorNode = Fn(() => {
    // (The terrain's shader squares its vertex colours: the standing water's colour comes as they are.)
    const pond = still.xyz.mul(still.xyz);
    const slick = vec3(0.006, 0.005, 0.004);
    const col = mix(mix(mix(water, pond, calm), vec3(0.86, 0.9, 0.9), foam), slick, oil);
    return vec4(col, 1);
  })();
  // Rough water scatters the light (no mirror glints off a cascade); where the ripples have faded
  // with distance, a little roughness stands in for them.
  // (Calm, it is as glassy as the lake's water, 0.04; it roughens as it tumbles.)
  const rough = float(0.05).add(tumble.mul(0.14)).add(coarseFade.oneMinus().mul(0.04));
  m.roughnessNode = mix(mix(mix(rough, float(0.55), foam), float(0.04), calm), float(0.14), oil);
  m.emissiveNode = Fn(() => {
    const view = normalize(cameraPosition.sub(positionWorld));
    const facing = abs(dot(view, vec3(0, 1, 0)));
    // A touch of sky in the water at a glance, broken up by the ripples; a little of it after dark.
    // (Only a touch: the scene's reflections already give the river the lake's sheen, and more
    // made running water read bluer than the lake it runs into.)
    const fresnel = pow(float(1).sub(facing), 4).mul(0.12).add(0.004);
    const sky = vec3(0.26, 0.42, 0.58).mul(effects.sunTint).add(vec3(0.01, 0.018, 0.04));
    const glance = sky.mul(fresnel).mul(ripple.mul(0.5).add(0.85)).mul(foam.oneMinus()).mul(oil.oneMinus()).mul(calm.oneMinus());
    // The standing water's light scattered back out of it (as the terrain's shader has it).
    // (Flowing or still, the water gives back some daylight in its own colour, as the lake's does.)
    const scatter = mix(water, still.xyz.mul(still.xyz), calm).mul(effects.sunTint).mul(0.3).mul(foam.oneMinus());
    // White water lights itself a little, so a fall in the cliff's shade still reads white.
    const white = vec3(0.16, 0.17, 0.17).mul(foam).mul(effects.sunTint.mul(0.8).add(0.06));
    // Oil's thin-film sheen: bands of colour that shift with the view and the swirls.
    const grazing = pow(float(1).sub(facing), 2);
    const film = ripple.mul(2.2).add(grazing.mul(1.5));
    const rainbow = cos(vec3(0, 2.1, 4.2).add(film.mul(6.283))).mul(0.5).add(0.5);
    // (Faint and greyed: a dark slick with only a hint of colour at a glance, never a gem.)
    const sheen = mix(vec3(0.5, 0.5, 0.5), rainbow, 0.45).mul(oil).mul(grazing.mul(grazing).mul(0.012).add(0.0015)).mul(effects.sunTint);
    return glance.add(scatter).add(white).add(sheen);
  })();
  return m;
}

// ----------------------------------------------------------------------------- geometry

/** Running water, with no standing water about it. */
const NOT_STILL = [0, 0, 0, 0] as const;

/** Accumulates water surfaces: positions in world space, `aWater`, `aStill` and `tile` per vertex. */
class WaterBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  water: number[] = [];
  still: number[] = [];
  tile: number[] = [];
  idx: number[] = [];

  vertex(x: number, y: number, z: number, n: [number, number, number], w: [number, number, number, number], tile: number, still: readonly number[] = NOT_STILL) {
    this.pos.push(x, y, z);
    this.nrm.push(...n);
    this.water.push(...w);
    this.still.push(still[0], still[1], still[2], still[3]);
    this.tile.push(tile);
    return this.pos.length / 3 - 1;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aWater', new THREE.Float32BufferAttribute(this.water, 4));
    g.setAttribute('aStill', new THREE.Float32BufferAttribute(this.still, 4));
    g.setAttribute('tile', new THREE.Float32BufferAttribute(this.tile, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Offsets across the ribbon, as fractions of its half-width (denser towards the banks). */
const ACROSS = [-1, -0.62, -0.28, 0, 0.28, 0.62, 1];
/** How far the ribbon runs on under the banks, past the water's edge, so no gap ever shows. */
const MARGIN = 0.035;
/** The fall's drop to below the sea surface (where the sea's own foam rings it). */
const FALL_FOOT = SEA_LEVEL - 0.03;

/** A stretch's current, per course point: the surface's slope, how agitated it is, and the flow phase. */
interface Flow {
  grad: number[];
  agit: number[];
  phase: number[];
}

/** A few passes of a three-point average, in place (the ends held). */
function soften(v: number[], passes: number) {
  for (let k = 0; k < passes; k++) {
    const prev = v.slice();
    for (let i = 1; i + 1 < v.length; i++) v[i] = (prev[i - 1] + prev[i] * 2 + prev[i + 1]) / 4;
  }
}

/**
 * The current along every river, worked out over each whole river at once (its stretches chained
 * where one's last point meets the next one's first), so nothing about it changes at a seam:
 *
 * - agitation: how steeply the surface falls, carried on downstream and thinning slowly (the
 *   white water a cascade churns up drifts a good way below it before the river runs calm again),
 *   with a short lead-in above the lip where the water quickens;
 * - the flow phase: the time calm water would take to get here, in calm water's units. The shader
 *   moves its pattern at one speed along it, so where the water runs fast the phase advances
 *   less, the pattern there races and stretches out, and nothing shears as time goes on.
 */
function riverFlows(stretches: { tile: TileInfo; c: RiverCourse }[]): Map<RiverCourse, Flow> {
  const out = new Map<RiverCourse, Flow>();
  const at = (s: { tile: TileInfo; c: RiverCourse }, i: number) => [s.tile.hex.x + s.c.pts[i * 2], s.tile.hex.z + s.c.pts[i * 2 + 1]];
  const first = (s: { tile: TileInfo; c: RiverCourse }) => at(s, 0);
  const last = (s: { tile: TileInfo; c: RiverCourse }) => at(s, s.c.pts.length / 2 - 1);
  const meets = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3;
  const done = new Set<RiverCourse>();
  let river = 0;
  for (const head of stretches) {
    // (A river starts at a stretch nothing runs into: its spring, or the first of it that's drawn.)
    if (done.has(head.c) || (head.c.in >= 0 && stretches.some((o) => o !== head && !o.c.mouth && meets(last(o), first(head))))) continue;
    const chain = [head];
    done.add(head.c);
    for (;;) {
      const end = chain[chain.length - 1];
      const next = end.c.mouth ? undefined : stretches.find((o) => !done.has(o.c) && o.c.in >= 0 && meets(first(o), last(end)));
      if (!next) break;
      chain.push(next);
      done.add(next.c);
    }
    // The whole river's levels, each seam's shared point once.
    const level: number[] = [];
    const offset: number[] = [];
    chain.forEach((s, k) => {
      offset.push(level.length - (k ? 1 : 0));
      level.push(...(k ? s.c.level.slice(1) : s.c.level));
    });
    const n = level.length;
    const grad = level.map((_, i) => {
      const a = Math.max(0, i - 1), z = Math.min(n - 1, i + 1);
      return (level[z] - level[a]) / ((z - a) * RIVER_STEP || 1);
    });
    const drop = grad.map((g) => Math.min(2.5, Math.max(0, -g * 3)));
    const agit = drop.slice();
    const down = Math.exp(-RIVER_STEP / 0.16), up = Math.exp(-RIVER_STEP / 0.04);
    for (let i = 1; i < n; i++) agit[i] = Math.max(agit[i], agit[i - 1] * down);
    for (let i = n - 2; i >= 0; i--) agit[i] = Math.max(agit[i], agit[i + 1] * up);
    soften(agit, 3);
    const speed = drop.slice();
    soften(speed, 4);
    // (Each river's phase starts somewhere else, so two springs don't run the same pattern.)
    const phase = [river * 37.3];
    for (let i = 1; i < n; i++) phase.push(phase[i - 1] + (RIVER_STEP * FLOW) / (FLOW + 0.6 * 0.5 * (speed[i - 1] + speed[i])));
    chain.forEach((s, k) => {
      const o = offset[k], len = s.c.level.length;
      out.set(s.c, { grad: grad.slice(o, o + len), agit: agit.slice(o, o + len), phase: phase.slice(o, o + len) });
    });
    river++;
  }
  return out;
}

/** Where `stillness` looks round a point for the open water's colour. */
const PROBES = [0.05, 0.1, 0.16].flatMap((r) => Array.from({ length: 8 }, (_, k) => [Math.cos(k * 0.785 + r * 9) * r, Math.sin(k * 0.785 + r * 9) * r]));

/**
 * Where a stretch runs out into standing water, each ribbon vertex's `aStill`: the colour of that
 * water there (as the terrain's vertices have it) and how far the river has become it, eased in
 * along the river so the change is a long one. Null where there's no standing water.
 */
function stillness(t: TileInfo, c: RiverCourse, rows: { x: number; z: number }[][], noise: Noise): number[][][] | null {
  const water = t.shape.features.water;
  if (!water) return null;
  const col = new THREE.Color();
  // Per row and across: [r, g, b, calm], with no colour yet where the vertex stands on dry ground.
  const v = rows.map((row, i) =>
    row.map(({ x, z }) => {
      // (Only where the river's surface is the pond's: one that falls past it runs on below it.)
      if (Math.abs(c.level[i] - water.level) > 0.004) return [0, 0, 0, 0, 0];
      const d = water.depth(x, z);
      if (d < 0) return [0, 0, 0, 0, 0];
      // The colour of the open water round about: the channel itself runs through the pond's
      // shallow, muddy margin, but what shows beside the ribbon is the water further out.
      let bx = x, bz = z, best = d;
      for (const [ox, oz] of PROBES) {
        const dd = water.depth(x + ox, z + oz);
        if (dd > best) [bx, bz, best] = [x + ox, z + oz, dd];
      }
      topColor(t.shape, bx, bz, water.level, 0, noise, col);
      return [col.r, col.g, col.b, 1, 1];
    }),
  );
  if (!v.some((row) => row.some((q) => q[4]))) return null;
  // Dry vertices take the nearest wet colour across their row, then along the river.
  for (const row of v)
    row.forEach((q, k) => {
      if (q[4]) return;
      let best = -1;
      row.forEach((o, j) => {
        if (o[4] && (best < 0 || Math.abs(j - k) < Math.abs(best - k))) best = j;
      });
      if (best >= 0) q.splice(0, 3, ...row[best].slice(0, 3)), (q[4] = 0.5);
    });
  for (let i = 0; i < v.length; i++)
    v[i].forEach((q, k) => {
      if (q[4]) return;
      for (let d = 1; d < v.length; d++) {
        const o = v[i - d]?.[k]?.[4] ? v[i - d][k] : v[i + d]?.[k]?.[4] ? v[i + d][k] : null;
        if (o) {
          q.splice(0, 3, ...o.slice(0, 3));
          break;
        }
      }
    });
  // Eased in along the river, a few rows each way.
  for (let k = 0; k < rows[0].length; k++) {
    const calm = v.map((row) => row[k][3]);
    soften(calm, 6);
    v.forEach((row, i) => (row[k][3] = Math.min(1, calm[i] * 1.15)));
  }
  return v.map((row) => row.map((q) => q.slice(0, 4)));
}

/**
 * The water along one tile's stretch: a ribbon at the surface level, squared off where it
 * crosses an edge (so it meets the next tile's ribbon exactly) and rounded at a spring. Into
 * `white` (the falls' translucent water) go a foam patch at the foot of each cascade and, at
 * the mouth, the curtain falling over the cliff lip into the sea with its foam at the foot.
 */
function addStretch(b: WaterBuilder, white: WaterBuilder, t: TileInfo, c: RiverCourse, f: Flow, noise: Noise) {
  const hx = t.hex.x, hz = t.hex.z, id = t.hex.id;
  const p = c.pts;
  const n = p.length / 2;
  // First the frame at each point: where it is, which way it runs, how wide.
  const frames: { x: number; z: number; tx: number; tz: number; wid: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), z = Math.min(n - 1, i + 1);
    let tx = p[z * 2] - p[a * 2], tz = p[z * 2 + 1] - p[a * 2 + 1];
    // Square to the edge at a crossing, exactly, so the two tiles' ribbons share the seam.
    if (i === 0 && c.in >= 0) [tx, tz] = sideNormal(c.in).map((v) => -v);
    if (i === n - 1) [tx, tz] = sideNormal(c.out);
    const tl = Math.hypot(tx, tz) || 1;
    frames.push({ x: p[i * 2], z: p[i * 2 + 1], tx: tx / tl, tz: tz / tl, wid: c.half[i] + MARGIN });
  }
  const still = stillness(
    t,
    c,
    frames.map((fr) => ACROSS.map((k) => ({ x: fr.x - fr.tz * k * fr.wid, z: fr.z + fr.tx * k * fr.wid }))),
    noise,
  );
  const rows: number[][] = [];
  let last = { x: 0, z: 0, y: 0, tx: 0, tz: 0, half: 0, s: 0 };
  let was = 0;
  for (let i = 0; i < n; i++) {
    const { tx, tz, wid } = frames[i];
    const lx = -tz, lz = tx;
    const g = f.grad[i];
    const drop = Math.min(2.5, Math.max(0, -g * 3));
    const agit = f.agit[i];
    const nl = Math.hypot(g, 1);
    const nrm: [number, number, number] = [(-g * tx) / nl, 1 / nl, (-g * tz) / nl];
    const half = c.half[i];
    const x = hx + frames[i].x, zz = hz + frames[i].z, y = c.level[i] + 0.0015;
    const s = c.s0 + i * RIVER_STEP;
    const ph = f.phase[i];
    rows.push(ACROSS.map((k, j) => b.vertex(x + lx * k * wid, y, zz + lz * k * wid, nrm, [ph, k * wid, agit, (Math.abs(k) * wid) / half], id, still?.[i][j])));
    if (i === 0 && c.in < 0) {
      // The spring: a little round pool behind the first point.
      const centre = b.vertex(x, y, zz, nrm, [ph, 0, agit, 0], id);
      const fan: number[] = [];
      for (let k = 0; k <= 8; k++) {
        const ang = (k / 8) * Math.PI;
        const ox = lx * Math.cos(ang) - tx * Math.sin(ang), oz = lz * Math.cos(ang) - tz * Math.sin(ang);
        fan.push(b.vertex(x + ox * wid, y, zz + oz * wid, nrm, [ph - Math.sin(ang) * wid, Math.cos(ang) * wid, agit, wid / half], id));
      }
      for (let k = 0; k < 8; k++) b.idx.push(centre, fan[k + 1], fan[k]);
    }
    // White water boiling in the pool at the foot of a cascade.
    if (was > 0.9 && drop < 0.45) addFoam(white, id, x + tx * 0.01, y + 0.0015, zz + tz * 0.01, half * 1.25);
    was = drop;
    last = { x, z: zz, y, tx, tz, half, s };
  }
  for (let i = 0; i + 1 < rows.length; i++)
    for (let k = 0; k + 1 < ACROSS.length; k++) {
      const a0 = rows[i][k], a1 = rows[i][k + 1], b0 = rows[i + 1][k], b1 = rows[i + 1][k + 1];
      // (Wound to face up: three lights a back face as if its normal were flipped.)
      b.idx.push(a0, a1, b0, a1, b1, b0);
    }
  if (c.mouth) addFall(white, id, last);
}

/**
 * The fall's gravity (world units a second squared) and the river's speed over the lip: the time
 * water takes to fall a distance `d` down the curtain, from d = v·t + g·t²/2, is what the falls'
 * shader moves its streaks by, so they leave the lip at the river's own pace and gather speed as
 * they drop, stretching out as real falling water does.
 */
const FALL_G = 2.2;
const LIP_SPEED = 0.16;
const fallTime = (d: number) => (-LIP_SPEED + Math.sqrt(LIP_SPEED * LIP_SPEED + 2 * FALL_G * d)) / FALL_G;

/**
 * The curtain of water from the cliff lip down into the sea: a parabola, like water thrown off an
 * edge, narrowing a little as it falls. Two sheets, the second a touch behind and narrower with
 * its streaks out of step, so the curtain has depth; foam boils where it meets the sea.
 */
function addFall(b: WaterBuilder, tile: number, at: { x: number; z: number; y: number; tx: number; tz: number; half: number; s: number }) {
  const K = 24;
  const OUT = 0.16;
  const lx = -at.tz, lz = at.tx;
  for (const layer of [0, 1]) {
    let prev: number[] = [];
    let d = 0;
    let px = 0, py = at.y;
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      const out = OUT * u - layer * 0.008;
      const y = at.y - (at.y - FALL_FOOT) * u * u - layer * 0.004;
      // The curve's slope, for the sheet's normal (facing out and up).
      const dx = OUT, dy = -(at.y - FALL_FOOT) * 2 * u;
      const l = Math.hypot(dx, dy);
      const nrm: [number, number, number] = [(-dy / l) * at.tx, dx / l, (-dy / l) * at.tz];
      d += Math.hypot(out - px, y - py);
      px = out;
      py = y;
      // (Falling water draws in a little as it speeds up, and the back sheet is narrower.)
      const wid = (at.half + MARGIN * 0.6) * (1 - 0.16 * u) * (layer ? 0.85 : 1);
      const cx = at.x + at.tx * out, cz = at.z + at.tz * out;
      // aWater here: (seconds of falling to here, out of step between the sheets; across; how far
      // down 0..1; how far out to the side 0..1).
      const row = ACROSS.map((kk) => b.vertex(cx + lx * kk * wid, y, cz + lz * kk * wid, nrm, [fallTime(d) + layer * 0.23, kk * wid + layer * 0.013, u, Math.abs(kk)], tile));
      if (k) for (let j = 0; j + 1 < ACROSS.length; j++) b.idx.push(prev[j], prev[j + 1], row[j], prev[j + 1], row[j + 1], row[j]);
      prev = row;
    }
  }
  // (A little above the sea's surface, so its swell doesn't cover the foam.)
  addFoam(b, tile, at.x + at.tx * (OUT + 0.01), SEA_LEVEL + 0.012, at.z + at.tz * (OUT + 0.01), 0.13);
}

/** A patch of churning foam lying on the water (a round fan marked as foam for the falls' material). */
function addFoam(b: WaterBuilder, tile: number, x: number, y: number, z: number, r: number) {
  const up: [number, number, number] = [0, 1, 0];
  const centre = b.vertex(x, y, z, up, [0, 0, 2, 0], tile);
  const N = 20;
  const ring: number[] = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const rr = r * (0.85 + 0.15 * Math.sin(a * 3 + x * 17));
    ring.push(b.vertex(x + Math.cos(a) * rr, y, z + Math.sin(a) * rr, up, [0, 0, 2, 1], tile));
  }
  for (let k = 0; k < N; k++) b.idx.push(centre, ring[(k + 1) % N], ring[k]);
}

/**
 * The falls' water: translucent, streaked white running down over a blue-green sheet that
 * thickens to foam towards the foot, fading at its sides; and foam patches that churn on the
 * water where a fall lands. Lit a little by itself, so a fall in the cliff's shade still reads.
 */
function fallMaterial(effects: TileEffects): THREE.MeshStandardNodeMaterial {
  return pooled(effects, 'fall', () => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const w = attribute<'vec4'>('aWater', 'vec4');
    const tile = attribute<'float'>('tile', 'float');
    const patch = step(1.5, w.z);
    const u = clamp(w.z, 0, 1);
    // The streaks travel by fall time (see fallTime): at the lip the river's own pace, quicker and
    // longer the further they've dropped. (Time in that unit: the pattern is in seconds of falling.)
    const flow = w.x.sub(time);
    // The curtain ripples as it falls, waves running down it faster than the water and growing
    // as the sheet thins (on the sheet only: the foam lies flat on the sea).
    m.positionNode = Fn(() => {
      const wave = cos(flow.mul(22).add(w.y.mul(60))).mul(0.0022).add(cos(flow.mul(9).sub(w.y.mul(23))).mul(0.0016)).mul(u).mul(patch.oneMinus());
      return positionLocal.add(normalLocal.mul(wave)).add(vec3(0, effects.rise.element(int(tile)) as unknown as Node<'float'>, 0));
    })();
    const streak = mx_noise_float(vec3(w.y.mul(75), flow.mul(5.5), time.mul(0.3))).mul(0.5).add(0.5);
    const fine = mx_noise_float(vec3(w.y.mul(190), flow.mul(16), time.mul(0.5))).mul(0.5).add(0.5);
    // Over the lip it is still the river, dark and glassy; it breaks white as it gathers speed.
    const aerate = smoothstep(0.04, 0.5, u);
    const white = smoothstep(0.3, 0.68, streak.mul(0.7).add(fine.mul(0.3))).mul(aerate.mul(0.8).add(0.2));
    const sides = smoothstep(1.0, 0.72, w.w);
    // Lower down the sheet comes apart into falling fingers and holes, the sea seen between them.
    const fingers = smoothstep(0.25, 0.6, mx_noise_float(vec3(w.y.mul(48), flow.mul(2.4), 3.1)).mul(0.5).add(0.5).add(white.mul(0.35)));
    const sheet = mix(float(0.94), fingers, smoothstep(0.35, 0.95, u).mul(0.85));
    const curtain = mix(sheet.mul(0.82), float(0.97), white).mul(sides);
    const churn = mx_noise_float(vec3(positionWorld.x.mul(38), positionWorld.z.mul(38), time.mul(0.9))).mul(0.5).add(0.5);
    const foam = smoothstep(1.0, 0.3, w.w).mul(smoothstep(0.3, 0.7, churn.add(smoothstep(0.55, 0.0, w.w).mul(0.45))));
    m.opacityNode = mix(curtain, foam.mul(0.92), patch);
    // The river's water (liquidMaterial's, tumbling: deep teal lightened where it's aerated) over
    // the lip, turning to froth as it falls.
    const river = mix(FRESH.deep, FRESH.aerated, aerate.mul(0.6).add(0.15));
    const froth = vec3(0.9, 0.94, 0.94);
    const col = mix(mix(river, froth, white), froth, patch);
    m.colorNode = vec4(col, 1);
    m.roughnessNode = mix(float(0.12), float(0.5), max(white, patch));
    // The sky in the glassy water at the lip, as on the river; the white water lights itself a little.
    const view = normalize(cameraPosition.sub(positionWorld));
    const glance = vec3(0.26, 0.42, 0.58).mul(effects.sunTint).mul(pow(float(1).sub(abs(dot(view, vec3(0, 1, 0)))), 3).mul(0.4).add(0.05)).mul(aerate.oneMinus()).mul(patch.oneMinus());
    m.emissiveNode = col.mul(effects.sunTint.mul(0.22).add(0.04)).mul(max(white, patch)).add(glance);
    return m;
  });
}

const C = (h: string) => new THREE.Color(h);

/**
 * A clump of reeds: tall, narrow blades leaning out from the root, and (when `heads`) a few
 * bulrushes, brown seed heads on bare stems standing above them. About 0.1 tall.
 */
function makeReeds(seed: number, heads: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const root = C('#4c6a24'), tip = C('#b3b65c');
  const tmp = new THREE.Color();
  const blades = 9 + r.int(4);
  for (let k = 0; k < blades; k++) {
    const a = r.range(0, Math.PI * 2);
    const lean = r.range(0.05, 0.35);
    const h = r.range(0.06, 0.11);
    const w = 0.0042 * r.range(0.8, 1.2);
    const ox = r.range(-0.01, 0.01), oz = r.range(-0.01, 0.01);
    const dx = Math.cos(a), dz = Math.sin(a);
    const px = -dz, pz = dx;
    const left: number[] = [], right: number[] = [];
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      const bend = lean * t * t * h;
      const ww = w * (1 - t * 0.95);
      tmp.copy(root).lerp(tip, t * 0.9);
      left.push(b.vertex(ox + dx * bend + px * ww, h * t, oz + dz * bend + pz * ww, tmp, dx * 0.3, 1, dz * 0.3));
      right.push(b.vertex(ox + dx * bend - px * ww, h * t, oz + dz * bend - pz * ww, tmp, dx * 0.3, 1, dz * 0.3));
    }
    for (let s = 0; s < 4; s++) {
      b.quad(left[s], right[s], right[s + 1], left[s + 1]);
      b.quad(right[s], left[s], left[s + 1], right[s + 1]);
    }
  }
  const stem = C('#6f7d3a'), head = C('#5b3a20');
  for (let k = 0; k < heads; k++) {
    const ox = r.range(-0.008, 0.008), oz = r.range(-0.008, 0.008);
    const h = r.range(0.1, 0.13);
    const st = new THREE.CylinderGeometry(0.0009, 0.0012, h, 4, 1, true);
    b.addGeometry(st, new THREE.Matrix4().makeTranslation(ox, h / 2, oz), stem);
    st.dispose();
    const hd = new THREE.CapsuleGeometry(0.0034, 0.016, 2, 6);
    b.addGeometry(hd, new THREE.Matrix4().makeTranslation(ox, h - 0.014, oz), head);
    hd.dispose();
  }
  return b.build(false);
}

// The watermill, in its own frame: +x downstream along the bank, +z away from the river, the
// house standing at the origin on its levelled patch; the wheel turns in the water off -z.
// (A big undershot wheel, nearly as tall as the house, dipping into the current off the bank.)
const WHEEL_R = 0.05;
const WHEEL_Z = -0.074;
const WHEEL_Y = 0.035;
/** The mill is modelled small and drawn at about the pieces' scale. */
const MILL_SCALE = 1.7;

const box = (b: MeshBuilder, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, ry = 0, rx = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  b.addGeometry(g, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0, 'YXZ')), new THREE.Vector3(1, 1, 1)), c);
  g.dispose();
};

/**
 * The mill house: a rubble-stone ground floor, a whitewashed timber-framed storey under a steep
 * thatched roof with a chimney, a door and sacks on the land side, and the wheel's axle running out
 * through the wall to the river. About 0.09 long.
 */
function makeMillHouse(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // (A thatched roof and stone walls: no player's piece looks like it.)
  const stone = C('#aaa497'), lime = C('#efe8d6'), timber = C('#6a5038'), tile = C('#cdae70'), dark = C('#2f2a25');
  // (Painted in the shader as the base game's houses are: coursed rubble, weathered limewash, roof courses.)
  b.surfaceId = SURFACE.stone;
  box(b, 0.092, 0.036, 0.07, 0, 0.018, 0, stone);
  b.surfaceId = SURFACE.whitewash;
  box(b, 0.088, 0.034, 0.066, 0, 0.053, 0, lime);
  b.surfaceId = SURFACE.plain;
  for (const x of [-0.044, 0, 0.044]) for (const z of [-0.033, 0.033]) box(b, 0.005, 0.034, 0.005, x, 0.053, z, timber);
  for (const z of [-0.0335, 0.0335]) box(b, 0.09, 0.004, 0.004, 0, 0.037, z, timber);
  // Roof: two slabs meeting at the ridge, with whitewashed gables under them.
  b.surfaceId = SURFACE.roof;
  for (const s of [-1, 1]) box(b, 0.104, 0.008, 0.05, 0, 0.083, s * 0.019, tile, 0, s * 0.72);
  b.surfaceId = SURFACE.plain;
  box(b, 0.102, 0.006, 0.006, 0, 0.098, 0, tile.clone().multiplyScalar(0.8));
  for (const x of [-0.0435, 0.0435]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.07, -0.034, 0, 0.07, 0.034, 0, 0.097, 0], 3));
    g.setIndex(x > 0 ? [0, 2, 1] : [0, 1, 2]);
    g.computeVertexNormals();
    b.surfaceId = SURFACE.whitewash;
    b.addGeometry(g, new THREE.Matrix4().makeTranslation(x, 0, 0), lime);
    b.surfaceId = SURFACE.plain;
    g.dispose();
  }
  box(b, 0.012, 0.03, 0.012, 0.028, 0.098, 0.012, C('#8a5038'));
  // Door and a window on the land side, two windows towards the river.
  box(b, 0.016, 0.026, 0.002, -0.014, 0.013, 0.0355, dark);
  box(b, 0.012, 0.01, 0.002, 0.02, 0.054, 0.0335, dark);
  for (const x of [-0.022, 0.02]) box(b, 0.011, 0.01, 0.002, x, 0.054, -0.0335, dark);
  // Sacks of flour by the door.
  for (let i = 0; i < 3; i++) {
    const g = new THREE.SphereGeometry(0.0075, 8, 6);
    b.addGeometry(g, new THREE.Matrix4().compose(new THREE.Vector3(0.006 + i * 0.012, 0.006 + (i === 1 ? 0.009 : 0), 0.044), new THREE.Quaternion(), new THREE.Vector3(1, 0.85, 0.8)), C('#d8c8a0'));
    g.dispose();
  }
  // The axle, out through the wall to the wheel, on a timber post at the water's edge.
  const ax = new THREE.CylinderGeometry(0.0035, 0.0035, Math.abs(WHEEL_Z) - 0.03, 8);
  b.addGeometry(ax, new THREE.Matrix4().compose(new THREE.Vector3(0, WHEEL_Y, (WHEEL_Z - 0.035) / 2 + 0.005), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new THREE.Vector3(1, 1, 1)), timber);
  ax.dispose();
  box(b, 0.008, WHEEL_Y + 0.012, 0.008, 0, (WHEEL_Y - 0.012) / 2, WHEEL_Z + 0.016, timber);
  return b.build(false);
}

/** The wheel: two rims, spokes, a hub and twelve paddles, turning about its own +z. */
function makeMillWheel(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // (Pale, weathered timber, so the spokes and paddles read against the water.)
  const wood = C('#9a7a56'), wet = C('#76593e');
  for (const z of [-0.0075, 0.0075]) {
    const rim = new THREE.TorusGeometry(WHEEL_R - 0.002, 0.003, 4, 28);
    b.addGeometry(rim, new THREE.Matrix4().makeTranslation(0, 0, z), wood);
    rim.dispose();
  }
  // (The spokes: three bars through the hub on each face, turned a sixth apart.)
  for (const z of [-0.0075, 0.0075])
    for (let k = 0; k < 3; k++) {
      const g = new THREE.BoxGeometry(WHEEL_R * 2 - 0.004, 0.0025, 0.0025);
      b.addGeometry(g, new THREE.Matrix4().compose(new THREE.Vector3(0, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (k * Math.PI) / 3 + Math.PI / 6), new THREE.Vector3(1, 1, 1)), wood);
      g.dispose();
    }
  const hub = new THREE.CylinderGeometry(0.006, 0.006, 0.02, 10);
  b.addGeometry(hub, new THREE.Matrix4().makeRotationX(Math.PI / 2), wet);
  hub.dispose();
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const g = new THREE.BoxGeometry(0.0032, 0.014, 0.019);
    b.addGeometry(g, new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * (WHEEL_R - 0.004), Math.sin(a) * (WHEEL_R - 0.004), 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a + Math.PI / 2), new THREE.Vector3(1, 1, 1)), wet);
    g.dispose();
  }
  return b.build(false);
}

const MILL_LAMP = lampColor(1.5, 0.85, 0.45);
const _wp = new THREE.Vector3();

/** Terrains the river runs through, and how thickly reeds line its banks there. */
const REEDS: Record<string, number> = { swamp: 0.9, pasture: 0.45, fields: 0.4, forest: 0.35, hills: 0.25, mountains: 0.12, desert: 0.15 };

interface Fall {
  x: number;
  z: number;
  tx: number;
  tz: number;
  tile: number;
  timer: number;
  /** The lip: where the river goes over (world), how high, and the curtain's half width there. */
  lip: { x: number; y: number; z: number; half: number };
  /** Until the next drops peel off the curtain. */
  drip: number;
}

interface Mill {
  tile: TileInfo;
  /** The mill's frame on the board (see makeMillHouse). */
  frame: THREE.Matrix4;
  /** Turns the wheel the way the water drives it (its frame may face upstream). */
  spin: number;
  angle: number;
  timer: number;
  /** The wheel's axle, in the mill's frame: the wheel turns about its z. */
  axle: THREE.Object3D;
}

export class RiversLife implements LifeModule {
  private stretches: { tile: TileInfo; c: RiverCourse }[] = [];
  private falls: Fall[] = [];
  private mill: Mill | null = null;
  private batches = new BatchSet();
  private parts: Parts;
  private disposables: { dispose(): void }[] = [];

  constructor(private ctx: LifeContext) {
    this.parts = new Parts(ctx.effects, ctx.props);
  }

  plan(tiles: TileInfo[]): Reserved {
    this.stretches = tiles.filter((t) => t.shape.ctx.river).map((t) => ({ tile: t, c: t.shape.ctx.river! }));
    // (The channel keeps vegetation and props out of the water itself: see canPlace.)
    return [];
  }

  build() {
    if (!this.stretches.length) return;
    const { effects, group, glass, noise } = this.ctx;
    const water = new WaterBuilder();
    const white = new WaterBuilder();
    const flows = riverFlows(this.stretches);
    for (const { tile, c } of this.stretches) {
      addStretch(water, white, tile, c, flows.get(c)!, noise);
      if (c.mouth) {
        const n = c.pts.length;
        const [tx, tz] = sideNormal(c.out);
        const half = c.half[c.half.length - 1];
        const lip = { x: tile.hex.x + c.pts[n - 2], y: c.level[c.level.length - 1], z: tile.hex.z + c.pts[n - 1], half };
        this.falls.push({ x: tile.hex.x + c.pts[n - 2] + tx * 0.17, z: tile.hex.z + c.pts[n - 1] + tz * 0.17, tx, tz, tile: tile.hex.id, timer: 0, lip, drip: 0 });
      }
    }
    const geo = water.build();
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, liquidMaterial(effects));
    mesh.name = 'rivers';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.layers.set(DETAIL_LAYER);
    glass.add(mesh);
    // Reeds share the meadow grass's material (so no new shader), and stones the bare rocks'.
    const grass = foliageMaterial(effects, { swayHeight: 0.07, swayAmount: 0.012, translucency: 0.6, instanceColor: true, trample: true, sheen: 0.14, dapple: true });
    grass.side = THREE.DoubleSide;
    const B = this.batches;
    B.define('reeds', makeReeds(11, 3), grass, { castShadow: false, detail: true });
    B.define('sedge', makeReeds(23, 0), grass, { castShadow: false, detail: true });
    // (One batch for every stone, pebble and boulder, turned and sized apiece: one draw.)
    B.define('stone', makeRock(140, noise, { flat: 0.6, color: '#8f887c', jagged: 0.8 }), rockMaterial(effects, true), { name: 'rock' });
    for (const s of this.stretches) this.dress(s.tile, s.c);
    this.buildMill(white);
    B.buildAll(group);
    // The falls and the foam: translucent, so one more draw (only where there is white water).
    if (white.idx.length) {
      const fg = white.build();
      this.disposables.push(fg);
      const falls = new THREE.Mesh(fg, fallMaterial(effects));
      falls.name = 'falls';
      falls.receiveShadow = true;
      falls.layers.set(DETAIL_LAYER);
      glass.add(falls);
    }
  }

  /**
   * The board's watermill, where the course planned one (see placeMill in riverCourse.ts): its
   * house among the looks' still props and its wheel a moving part, both on their one shared
   * material (an instanced mesh apiece would cost node builds of their own in every pass), and a
   * lamp in its window after dark.
   */
  private buildMill(white: WaterBuilder) {
    const st = this.stretches.find((o) => o.c.mill);
    if (!st) return;
    const m = st.c.mill!;
    const { effects, group } = this.ctx;
    const hex = st.tile.hex;
    // Frame: +x along the river, +z from the river to the house. On the right bank that basis
    // would be mirrored, so +x runs upstream there instead (and the wheel turns the other way).
    const tx = Math.cos(m.angle) * m.side, tz = Math.sin(m.angle) * m.side;
    const X = new THREE.Vector3(tx, 0, tz), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3().crossVectors(X, Y);
    const frame = new THREE.Matrix4().makeBasis(X, Y, Z).scale(new THREE.Vector3(MILL_SCALE, MILL_SCALE, MILL_SCALE)).setPosition(hex.x + m.x, m.y - 0.001, hex.z + m.z);
    // (The still props are built in the tile's frame: x and z from the hex's centre.)
    const house = makeMillHouse().applyMatrix4(frame.clone().setPosition(m.x, m.y - 0.001, m.z));
    const mesh = stillProps(effects, [{ geo: house, hex }], this.disposables);
    house.dispose();
    if (mesh) {
      mesh.name = 'mill';
      group.add(mesh);
    }
    const anchor = new THREE.Object3D();
    anchor.applyMatrix4(frame);
    group.add(anchor);
    const axle = new THREE.Object3D();
    axle.position.set(0, WHEEL_Y, WHEEL_Z);
    anchor.add(axle);
    const wheel = makeMillWheel();
    this.disposables.push(wheel);
    this.parts.add(wheel, axle, hex.id, true);
    this.ctx.lamps.add(anchor, { x: 0, y: 0.054, z: 0.05 }, { color: MILL_LAMP, distance: 0.45, strength: 0.7 });
    this.mill = { tile: st.tile, frame, spin: m.side, angle: 0, timer: 0, axle };
    // White water where the paddles beat the current, mostly downstream of the wheel.
    for (const [ox, r] of [[0.03, 0.05], [-0.015, 0.032]]) {
      const at = new THREE.Vector3(ox * m.side, 0, WHEEL_Z).applyMatrix4(frame);
      addFoam(white, st.tile.hex.id, at.x, m.y - 0.014 + 0.003, at.z, r);
    }
  }

  /** Reeds along the banks, pebbles at the edge, and stepping stones across a straight stretch. */
  private dress(t: TileInfo, c: RiverCourse) {
    const rnd = new Rand(t.shape.seed * 37 + 11);
    const p = c.pts;
    const n = p.length / 2;
    const len = (n - 1) * RIVER_STEP;
    const dens = REEDS[t.shape.terrain] ?? 0.3;
    const tint = new THREE.Color();
    const clear = (x: number, z: number) => {
      // Off the corners and the disc, and well inside the edges (bridges and roads), and clear of a mill.
      if (Math.hypot(x, z) < 0.36) return false;
      if (c.mill && Math.hypot(x - c.mill.x, z - c.mill.z) < c.mill.r + 0.07) return false;
      for (let k = 0; k < 6; k++) {
        const a = ((-90 + 60 * k) * Math.PI) / 180;
        if (Math.hypot(x - Math.cos(a), z - Math.sin(a)) < 0.33) return false;
        if (sideDistance(x, z, k) < 0.13) return false;
      }
      return true;
    };
    for (let i = 2; i < n - 2; i += 2) {
      const s = i * RIVER_STEP;
      // (Not where a bridge will stand, nor right at the cliff lip.)
      if ((c.in >= 0 && s < 0.16) || s > len - (c.mouth ? 0.3 : 0.16)) continue;
      if (!rnd.chance(dens)) continue;
      const tx = p[i * 2 + 2] - p[i * 2 - 2], tz = p[i * 2 + 3] - p[i * 2 - 1];
      const tl = Math.hypot(tx, tz);
      const side = rnd.chance(0.5) ? 1 : -1;
      const off = c.half[i] + rnd.range(0.008, 0.04);
      const x = p[i * 2] - (tz / tl) * off * side, z = p[i * 2 + 1] + (tx / tl) * off * side;
      if (!clear(x, z)) continue;
      const y = t.shape.height(x, z) - 0.006;
      // (Reeds stand at the water's edge, not up a gorge's wall.)
      if (y > c.level[i] + 0.05) continue;
      tint.setHSL(0.18 + rnd.range(-0.03, 0.03), 0.3, 0.45 + rnd.range(-0.05, 0.08));
      this.batches.get(rnd.chance(0.55) ? 'reeds' : 'sedge').add({ matrix: trs(t.hex.x + x, y, t.hex.z + z, rnd.range(0, 6.28), rnd.range(0.8, 1.25)), tile: t.hex.id, color: tint.clone() });
      // A pebble or two at its foot.
      if (rnd.chance(0.35)) {
        const ps = c.half[i] + rnd.range(-0.012, 0.012);
        const qx = p[i * 2] + (tz / tl) * ps * side, qz = p[i * 2 + 1] - (tx / tl) * ps * side;
        if (clear(qx, qz)) this.batches.get('stone').add({ matrix: trs(t.hex.x + qx, t.shape.height(qx, qz) - 0.004, t.hex.z + qz, rnd.range(0, 6.28), rnd.range(0.012, 0.02)), tile: t.hex.id });
      }
    }
    // Mossy boulders round the spring, where the river wells up out of the ground.
    if (c.in < 0) {
      const tx = p[2] - p[0], tz = p[3] - p[1];
      const back = Math.atan2(-tz, -tx);
      for (let k = 0; k < 5; k++) {
        const a = back + (k - 2) * 0.62 + rnd.range(-0.15, 0.15);
        const r = c.half[0] + MARGIN + rnd.range(0.0, 0.02);
        const x = p[0] + Math.cos(a) * r, z = p[1] + Math.sin(a) * r;
        this.batches.get('stone').add({ matrix: trs(t.hex.x + x, t.shape.height(x, z) - 0.008, t.hex.z + z, rnd.range(0, 6.28), rnd.range(0.022, 0.036)), tile: t.hex.id });
      }
    }
    // Stepping stones across the straightest open stretch of a plains tile.
    if (c.in < 0 || c.mouth || !['pasture', 'fields', 'forest'].includes(t.shape.terrain)) return;
    let best = -1, bestBend = Infinity;
    for (let i = 8; i < n - 8; i++) {
      const s = i * RIVER_STEP;
      if (s < 0.3 || s > len - 0.3) continue;
      const a1 = Math.atan2(p[i * 2 + 1] - p[i * 2 - 7], p[i * 2] - p[i * 2 - 8]);
      const a2 = Math.atan2(p[i * 2 + 9] - p[i * 2 + 1], p[i * 2 + 8] - p[i * 2]);
      const bend = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      if (c.mill && Math.abs(i - c.mill.i) < 16) continue;
      if (bend < bestBend && clear(p[i * 2], p[i * 2 + 1])) {
        bestBend = bend;
        best = i;
      }
    }
    if (best < 0) return;
    const tx = p[best * 2 + 2] - p[best * 2 - 2], tz = p[best * 2 + 3] - p[best * 2 - 1];
    const tl = Math.hypot(tx, tz);
    const half = c.half[best];
    for (let k = -2; k <= 2; k++) {
      const off = (k / 2) * half * 1.05 + rnd.range(-0.004, 0.004);
      const x = p[best * 2] - (tz / tl) * off + (tx / tl) * rnd.range(-0.006, 0.006);
      const z = p[best * 2 + 1] + (tx / tl) * off + (tz / tl) * rnd.range(-0.006, 0.006);
      this.batches.get('stone').add({ matrix: trs(t.hex.x + x, c.level[best] - 0.012, t.hex.z + z, rnd.range(0, 6.28), 0.026, 0.024), tile: t.hex.id });
    }
  }

  update(dt: number) {
    const mill = this.mill;
    if (mill) {
      // The wheel turns with the current, its paddles slapping up spray as they leave the water.
      mill.angle += dt * 1.3 * mill.spin;
      mill.axle.rotation.z = mill.angle;
      mill.timer -= dt;
      if (mill.timer <= 0 && (this.ctx.effects.riseValues[mill.tile.hex.id] ?? 0) > -0.02) {
        mill.timer = 0.05 + Math.random() * 0.07;
        const at = _wp.set(WHEEL_R * 0.7 * mill.spin, WHEEL_Y - WHEEL_R * 0.55, WHEEL_Z).applyMatrix4(mill.frame);
        this.ctx.particles.spray.emit({ x: at.x, y: at.y, z: at.z, vx: (Math.random() - 0.5) * 0.06, vy: 0.12 + Math.random() * 0.1, vz: (Math.random() - 0.5) * 0.06, life: 0.45 + Math.random() * 0.25, size: 0.01, gravity: 1.2, color: '#eef6f6' });
      }
    }
    // Spray and mist thrown up where each fall meets the sea; and drops peeling off the curtain
    // as it falls, thrown out with its speed and pulled down by gravity, mostly from its edges
    // where the sheet is thinnest.
    for (const f of this.falls) {
      if ((this.ctx.effects.riseValues[f.tile] ?? 0) < -0.05) continue;
      f.drip -= dt;
      if (f.drip <= 0) {
        f.drip = 0.018 + Math.random() * 0.025;
        const u = 0.25 + Math.random() * 0.6;
        const edge = Math.random() < 0.65 ? (Math.random() < 0.5 ? -1 : 1) * (0.75 + Math.random() * 0.25) : (Math.random() - 0.5) * 1.4;
        const w = f.lip.half * (1 - 0.16 * u);
        const out = 0.16 * u, y = f.lip.y - (f.lip.y - FALL_FOOT) * u * u;
        const speed = LIP_SPEED + FALL_G * fallTime((f.lip.y - y) * 1.05);
        this.ctx.particles.spray.emit({
          x: f.lip.x + f.tx * out - f.tz * edge * w,
          y,
          z: f.lip.z + f.tz * out + f.tx * edge * w,
          vx: f.tx * (0.1 + Math.random() * 0.12) - f.tz * edge * 0.06,
          vy: -speed * 0.55,
          vz: f.tz * (0.1 + Math.random() * 0.12) + f.tx * edge * 0.06,
          life: 0.35 + Math.random() * 0.25,
          size: 0.009 + Math.random() * 0.009,
          gravity: 1.6,
          color: '#e9f2f3',
          floor: SEA_LEVEL,
        });
      }
      f.timer -= dt;
      if (f.timer > 0) continue;
      f.timer = 0.07 + Math.random() * 0.06;
      const { spray, mist } = this.ctx.particles;
      const jx = (Math.random() - 0.5) * 0.08;
      spray.emit({ x: f.x + f.tz * jx, y: SEA_LEVEL + 0.01, z: f.z - f.tx * jx, vx: f.tx * 0.12 + (Math.random() - 0.5) * 0.12, vy: 0.25 + Math.random() * 0.25, vz: f.tz * 0.12 + (Math.random() - 0.5) * 0.12, life: 0.5 + Math.random() * 0.3, size: 0.012, gravity: 1.2, color: '#eef6f6' });
      if (Math.random() < 0.5) mist.emit({ x: f.x + f.tz * jx, y: SEA_LEVEL + 0.03, z: f.z - f.tx * jx, vx: f.tx * 0.05, vy: 0.06 + Math.random() * 0.05, vz: f.tz * 0.05, life: 1.6 + Math.random(), size: 0.05, grow: 2.2, color: '#f2f7f7', alpha: 0.28, drag: 0.4, fadeIn: 0.2 });
    }
  }

  produce() {}

  dispose() {
    this.batches.dispose();
    this.parts.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.falls = [];
    this.stretches = [];
  }
}
