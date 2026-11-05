// The shapes of the scenery beyond the island (see distant.ts): sea stacks and islets with their
// trees, hilly islands further out and mountain ranges on the horizon, laid out from fixed seeds,
// and the courses of the ships sailing round. Geometry and numbers only, so the whole layout can
// be built off the main thread (render/buildWorker.ts) while the renderer starts, and comes out the
// same wherever it is built.

import * as THREE from 'three/webgpu';
import { Noise, Rand } from '../util/noise';
import { makeLandmass, makeTrees } from './landShapes';

const C = (h: string) => new THREE.Color(h);

/** How a piece of scenery is painted (its material, chosen where the meshes are made). */
export type SceneryLook = 'near' | 'trees' | 'far' | 'range';

/** A piece of land, placed: `y` is its height relative to the sea level. */
export interface SceneryPiece<G = THREE.BufferGeometry> {
  geometry: G;
  look: SceneryLook;
  x: number;
  y: number;
  z: number;
  rot: number;
}

export interface ShipCourse {
  angle: number;
  speed: number;
  cx: number;
  cz: number;
  phase: number;
}

export interface SceneryPlan<G = THREE.BufferGeometry> {
  /** In the order they are added to the scene. */
  pieces: SceneryPiece<G>[];
  ships: ShipCourse[];
}

/** One mountain massif on the horizon (see makeMassif). */
interface Massif {
  /** Bearing of its middle from the island (radians), and how far off its summits stand. */
  a: number;
  d: number;
  /** Its length along the horizon and its depth front to back, shore to shore (world units). */
  w: number;
  deep: number;
  /** The height of its highest summit, and how many summits it has. */
  h: number;
  peaks: number;
  /** Grid spacing along the horizon, which is the detail of its skyline (across is coarser:
   * seen edge-on from the island, that direction is foreshortened). */
  step: number;
  seed: number;
}

/** Not quite the radius of the sea's mesh (ocean.ts), where the water ends. */
const SEA_EDGE = 250;

const smax = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + (h * h * k) / 4;
};
/** GLSL's smoothstep (edges either way round, unlike three's). */
const ss = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * A mountain massif far beyond the sea, as a height field on its own patch of the horizon: a
 * handful of summits of different heights along a wandering crest, saddles between them, spurs
 * and gullies cut down their flanks, and low rolling foothills that run out to beaches and
 * headlands, the whole of it falling into the sea at its edges (so the sea shows between
 * massifs, and each is culled on its own). The vertex colours are its ground cover only (forest,
 * meadow, the thin turf above the tree line): bare rock, snow and sand are painted per pixel
 * from the slope and height (see rangeMaterial in landmass.ts).
 */
function makeMassif(noise: Noise, m: Massif): THREE.BufferGeometry {
  const rnd = new Rand(m.seed);
  const s = m.seed * 0.37;
  const nu = Math.ceil(m.w / m.step);
  const nv = Math.ceil(m.deep / (m.step * 1.8));
  // The summits: spread along the massif with some jitter, the crest wandering front to back.
  // One is the massif's height; the rest lower, so the skyline has a crown, shoulders and saddles.
  const main = rnd.int(m.peaks);
  const tops = Array.from({ length: m.peaks }, (_, k) => {
    const h = k === main ? m.h : m.h * rnd.range(0.42, 0.8);
    return {
      u: ((k + 0.5) / m.peaks - 0.5 + rnd.range(-0.22, 0.22) / m.peaks) * m.w * 0.78,
      v: rnd.range(-0.12, 0.16) * m.deep,
      h,
      // The reach of its flanks: slopes averaging some 25°, steeper near the top.
      r: h * rnd.range(2.0, 2.7) + 4,
    };
  });
  const foot = 0.9 + m.h * 0.13;
  const pos: number[] = [];
  const hs: number[] = [];
  for (let i = 0; i <= nu; i++) {
    const u = (i / nu - 0.5) * m.w;
    const a = m.a + u / m.d;
    for (let j = 0; j <= nv; j++) {
      const v = (j / nv - 0.5) * m.deep;
      const r = m.d + v;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      // The summits' cones, each flank concave (steep near the top, easing out below) and its
      // footprint ragged, joined by soft maxima: a saddle where two meet. (The tip is rounded a
      // little, or the coarser grids of the far bands draw needles.)
      const warp = 1 + 0.2 * noise.noise2(x * 0.05 + s, z * 0.05 - s);
      let y = 0, crown = 1;
      for (const t of tops) {
        const d = (Math.hypot(u - t.u, (v - t.v) * 1.2) / t.r) * warp;
        if (d >= 1) continue;
        const c = t.h * Math.pow(1 - Math.sqrt(d * d + 0.0016) + 0.04, 1.6);
        if (c > y) crown = c / t.h;
        y = smax(y, c, m.h * 0.12);
      }
      // Spurs and gullies down the flanks: ridged noise in world space, warped so they wander,
      // cutting deep mid-flank and only roughening the summits (where it would raise spikes).
      const wx = x * 0.075 + noise.noise2(x * 0.02 + s, z * 0.02) * 1.1;
      const wz = z * 0.075 + noise.noise2(z * 0.02, x * 0.02 + s) * 1.1;
      const rid = noise.ridged2(wx + s, wz - s, 3);
      const top = ss(0.55, 1, crown);
      y *= 0.58 + 0.56 * rid + (0.22 - 0.28 * rid) * top;
      // Crags along the skyline and down the faces, a few units across.
      y += y * 0.07 * noise.noise2(x * 0.32 - s, z * 0.32 + s);
      // Foothills: low rolling ground the peaks rise out of, spreading to the shore.
      y = smax(y, foot * (0.45 + 0.55 * (noise.fbm2(x * 0.045 + s, z * 0.045 - s, 3) * 0.5 + 0.5)), 1.6);
      // The coast: the land sinks toward the patch's edges, through a ragged line of bays and
      // headlands (sinking, not shrinking, so the mountains keep their shape down to the water),
      // gently enough to leave beaches; the very edge is always well under the sea.
      const e = Math.hypot(u / (m.w * 0.5), v / (m.deep * 0.5)) + 0.22 * noise.fbm2(x * 0.03 + s, z * 0.03 + 5, 3);
      const edge = ss(1, 0.88, Math.max(Math.abs(u) / (m.w * 0.5), Math.abs(v) / (m.deep * 0.5)));
      y = y + 0.5 - (foot + 1.5) * Math.pow(ss(0.5, 1.02, e), 1.4) - (m.h + 3) * (1 - edge);
      pos.push(x, y, z);
      hs.push(y);
    }
  }
  // Skip the cells wholly under the sea, where the sea covers them. (It ends some way short of
  // the furthest massifs: there the land under the waterline stays, painted as the haze that
  // the sea would be by then, or the sky would show through below the horizon.)
  const W = nv + 1;
  const idx: number[] = [];
  const covered = (k: number) => hs[k] < -0.6 && Math.hypot(pos[k * 3], pos[k * 3 + 2]) < SEA_EDGE;
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const p = i * W + j, q = (i + 1) * W + j;
      if (covered(p) && covered(p + 1) && covered(q) && covered(q + 1)) continue;
      idx.push(p, q, p + 1, q, q + 1, p + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  // Ground cover: woods in patches over the lower slopes, meadow in the valley floors and on the
  // gentlest ground, sun-dried grass in places, and thin turf and scree above the tree line.
  const nrm = g.getAttribute('normal');
  const col: number[] = [];
  const c = new THREE.Color();
  const wood = C('#34532b'), woodLight = C('#486a37'), meadow = C('#6c8b42'), dry = C('#8e8d52'), alpine = C('#7a7c58'), scree = C('#8b8576');
  for (let k = 0; k < hs.length; k++) {
    const y = hs[k];
    const up = nrm.getY(k);
    const x = pos[k * 3], z = pos[k * 3 + 2];
    const n = noise.fbm2(x * 0.06 + s, z * 0.06, 3);
    const n2 = noise.noise2(x * 0.17 - s, z * 0.17);
    const treeLine = 8.5 + 2.5 * n;
    c.copy(wood).lerp(woodLight, n2 * 0.5 + 0.5);
    // Clearings: meadow on gentle ground and in patches.
    c.lerp(meadow, THREE.MathUtils.clamp((up - 0.9) * 8 + n * 1.5, 0, 1));
    c.lerp(dry, THREE.MathUtils.clamp(n2 - 0.35, 0, 1) * ss(0.8, 0.95, up));
    // Above the trees: turf, then scree toward the summits.
    c.lerp(alpine, ss(treeLine - 1.5, treeLine + 1, y));
    c.lerp(scree, ss(treeLine + 2, treeLine + 7, y) * 0.8);
    col.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/**
 * The massifs on the horizon, in three bands that recede into the haze: headlands and lower
 * massifs nearest, taller ones behind them and, furthest, a long pale range. Most of them stand
 * behind the island as a game sees it (towards -z), with clear sea between some, and none at all
 * over a wide stretch of the horizon. Heights are kept to what a view from the island frames:
 * the camera is seldom more than a few degrees above the horizon, so a taller mountain only
 * shows as its lower slopes, cut off by the top of the screen.
 */
const MASSIFS: Massif[] = [
  // Nearest: headlands and massifs, the clearest of them.
  { a: -2.62, d: 168, w: 70, deep: 44, h: 10.5, peaks: 3, step: 0.7, seed: 11 },
  { a: -2.04, d: 148, w: 44, deep: 30, h: 7.5, peaks: 3, step: 0.7, seed: 12 },
  { a: -1.44, d: 182, w: 96, deep: 52, h: 12.5, peaks: 4, step: 0.7, seed: 13 },
  { a: -0.72, d: 158, w: 56, deep: 36, h: 8.5, peaks: 3, step: 0.7, seed: 14 },
  { a: 2.42, d: 172, w: 74, deep: 44, h: 11.5, peaks: 3, step: 0.7, seed: 15 },
  { a: 2.98, d: 150, w: 36, deep: 26, h: 5.5, peaks: 2, step: 0.7, seed: 16 },
  // Behind them, taller and hazier.
  { a: -2.25, d: 245, w: 112, deep: 58, h: 15, peaks: 4, step: 1.1, seed: 21 },
  { a: -1.0, d: 236, w: 122, deep: 62, h: 16, peaks: 5, step: 1.1, seed: 22 },
  { a: 2.76, d: 232, w: 92, deep: 50, h: 13, peaks: 3, step: 1.1, seed: 23 },
  // Furthest: long, pale ranges, the highest summits snow-capped.
  { a: -2.02, d: 338, w: 124, deep: 60, h: 17, peaks: 4, step: 1.8, seed: 31 },
  { a: -1.28, d: 330, w: 156, deep: 70, h: 20, peaks: 5, step: 1.8, seed: 32 },
  { a: -0.15, d: 322, w: 118, deep: 52, h: 14, peaks: 3, step: 1.8, seed: 33 },
];

/** The scenery's land and the ships' courses, always the same (fixed seeds). */
export function planScenery(): SceneryPlan {
  const noise = new Noise(99);
  const rnd = new Rand(31);
  const pieces: SceneryPiece[] = [];
  const place = (geometry: THREE.BufferGeometry, look: SceneryLook, x: number, y: number, z: number, rot: number) => pieces.push({ geometry, look, x, y, z, rot });

  // Sea stacks: tall rock columns with a scrap of turf on top, in loose clusters.
  const clusters = [
    { a: 2.3, d: 38 },
    { a: 3.7, d: 52 },
    { a: 5.3, d: 44 },
    { a: 0.9, d: 60 },
    { a: 4.4, d: 30 },
  ];
  for (const cl of clusters) {
    const n = 2 + rnd.int(3);
    for (let i = 0; i < n; i++) {
      const seed = rnd.int(1000);
      const land = makeLandmass(seed, noise, {
        radius: rnd.range(0.7, 1.4),
        rim: rnd.range(1.6, 4.0),
        dome: 0.12,
        hills: 0.06,
        peak: 0,
        bottom: -1.4,
        undercut: 0.16,
        seg: 64,
        top: 6,
        cliff: 34,
      });
      const x = Math.cos(cl.a) * cl.d + rnd.range(-4, 4);
      const z = Math.sin(cl.a) * cl.d + rnd.range(-4, 4);
      const rot = rnd.range(0, 6);
      place(land.geometry, 'near', x, -0.6, z, rot);
      const spots = land.spots.slice(0, rnd.int(3));
      if (spots.length) place(makeTrees(spots, seed, 0.7), 'trees', x, -0.6, z, rot);
    }
  }

  // Islands at three depths: rocky islets nearby, hilly islands further out and, far
  // beyond them, mountain ranges fading into the haze.
  const islets = [
    { a: 3.55, d: 34 },
    { a: 5.75, d: 38 },
    { a: 1.2, d: 42 },
    { a: 2.75, d: 46 },
  ];
  for (const it of islets) {
    const seed = rnd.int(1000);
    const land = makeLandmass(seed, noise, {
      radius: rnd.range(1.9, 2.8),
      rim: rnd.range(1.3, 1.9),
      dome: rnd.range(0.3, 0.6),
      hills: 0.25,
      peak: 0,
      bottom: -1.6,
      undercut: 0.12,
      seg: 112,
      top: 22,
      cliff: 26,
    });
    const x = Math.cos(it.a) * it.d, z = Math.sin(it.a) * it.d;
    const rot = rnd.range(0, 6);
    place(land.geometry, 'near', x, -0.35, z, rot);
    place(makeTrees(land.spots, seed, 0.85), 'trees', x, -0.35, z, rot);
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rnd.range(-0.3, 0.3);
    const d = rnd.range(80, 120);
    const tall = i % 3 === 0;
    const land = makeLandmass(i * 7 + 1, noise, {
      radius: rnd.range(9, 20),
      rim: 0.3,
      dome: rnd.range(1.4, 3),
      hills: rnd.range(1.2, 2.2),
      peak: tall ? rnd.range(6, 8.5) : rnd.range(0, 1.5),
      bottom: -1.2,
      undercut: 0.03,
      seg: 160,
      top: 40,
      cliff: 8,
    });
    place(land.geometry, 'far', Math.cos(a) * d, -0.2, Math.sin(a) * d, rnd.range(0, 6));
  }
  // (Their own seeds, not `rnd`: the ships' courses below stay as they were.)
  for (const m of MASSIFS) place(makeMassif(noise, m), 'range', 0, 0, 0, 0);

  // The ships' courses round the island.
  const ships: ShipCourse[] = [];
  for (let i = 0; i < 3; i++) {
    const angle = rnd.range(0, 6);
    const speed = (0.012 + rnd.range(0, 0.008)) * (i % 2 ? -1 : 1);
    const cx = rnd.range(-3, 3);
    const cz = rnd.range(-3, 3);
    const phase = rnd.range(0, 6);
    ships.push({ angle, speed, cx, cz, phase });
  }
  return { pieces, ships };
}
