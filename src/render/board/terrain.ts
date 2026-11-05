// Procedural terrain for each hex tile: a heightfield top (with flat lanes along
// the edges for roads, clear corners for buildings and a clearing for the number
// disc) plus layered rocky cliff walls that plunge into the sea.
//
// Every tile is unique (seeded per hex) and terrain noise is evaluated in world
// space, so two neighbouring tiles of the same terrain flow into each other: the
// shared edge loses its seam, vegetation grows right up to the road lane, and
// mountain ridges continue across it.

import * as THREE from 'three/webgpu';
import type { Terrain } from '../../engine';
import { CORNER_OFFSETS } from '../../engine/board';
import { Noise, Rand, smoothstep, lerp, clamp } from '../util/noise';
import { CLIFF_BOTTOM, HEX_APOTHEM, RIM, SEA_LEVEL, TILE_SCALE, TOKEN_CLEAR, segDist } from './layout';
import { carveRiver, riverClear, tintRiver, type RiverCourse } from './riverCourse';
import { levelPad, onPad, tintPad, type WellPad } from './wellSite';
import { LAKE_ISLET_RADIUS, discSpots, type DiscSpot } from './discSpots';

/** Half-width of the road lane kept clear on a shared, same-terrain edge. */
export const LANE = 0.1;
/** Clearance radius around each corner (settlements / cities). */
export const CORNER_CLEAR = 0.27;

/** Whether a tile's sea side is a sandy cove (shared with the beaches and the shore-rock scatter). */
export function isBeachSide(seed: number, side: number): boolean {
  return new Rand(seed * 3 + 71 + side * 7919).chance(0.3);
}

export interface TileContext {
  terrain: Terrain;
  /** World-space hex centre. */
  cx: number;
  cz: number;
  seed: number;
  /** connected[i] = neighbour across side i (NE, E, SE, SW, W, NW) has the same terrain. */
  connected: boolean[];
  /** Whether a land neighbour exists across side i. */
  landSide: boolean[];
  /**
   * The sides a river crosses this hex by (Rivers): in (-1 where it rises here) and out (the sea,
   * at its mouth). Known before the river is planned, so a swamp at the mouth can lay out its
   * channel for the planner to follow (see riverCourse.ts ownChannel).
   */
  riverSides?: { in: number; out: number };
  /** The stretch of a river crossing this tile (Rivers), cut into whatever ground the terrain makes: see riverCourse.ts. */
  river?: RiverCourse;
  /** An oil well's level pad (Oil): see wellSite.ts. */
  pad?: WellPad;
  /** How many number discs the hex bears: several (the lake's four, a hex given a second) each keep their own ground clear. */
  discs?: number;
}

export interface TileShape {
  ctx: TileContext;
  terrain: Terrain;
  seed: number;
  /** Height of the terrain at local (x, z). */
  height(x: number, z: number): number;
  /** Interior mask (0 in lanes/corners/clearing, 1 in open interior). */
  mask(x: number, z: number): number;
  /** Whether a decoration of the given radius may be placed at local (x, z). */
  canPlace(x: number, z: number, radius?: number): boolean;
  features: TileFeatures;
}

export interface TileFeatures {
  peaks: { x: number; z: number; h: number; r: number }[];
  /** Mine entrance (mountains), kiln (hills) or windmill (fields) anchor in local coords. */
  anchor: { x: number; z: number; angle: number } | null;
  /** Clay pit centre (hills). */
  pit: { x: number; z: number; r: number } | null;
  /**
   * Standing water (the lake, the swamp's pools, the oasis and the bounty field's pond): the
   * ground is flat at `level` wherever the bed would lie beneath it, and `depth` says how far the
   * bed lies below the surface there (negative on dry ground: how far it stands above). `basin`
   * (0..1) is how far into the hollow a point lies, and `soak` how far above the water the ground
   * round it stays wet. Only a basin holds water: the level sits below every tile's rim (0.018 on
   * a coast), and outside a basin the depth is simply -1.
   */
  water?: { level: number; soak: number; depth(x: number, z: number): number; basin(x: number, z: number): number };
  /** Named places on the tile for its life module (the sluice's pond, the lake's jetty, the oasis's tents...). */
  sites?: Record<string, { x: number; z: number; r?: number; a?: number }>;
  /** The swamp's channel from the river's way in to its way out, round the clearing (local points). */
  channel?: { x: number; z: number }[];
  /** The castle's rise: its flat top's height and radius, and the track that winds up to it. */
  plateau?: { y: number; r: number; track: { x: number; z: number }[] };
}

const C = (hex: string) => new THREE.Color(hex);

export const PALETTE = {
  grassB: C('#9cc23f'),
  grassDry: C('#a39a55'),
  meadowA: C('#6aa530'),
  meadowB: C('#a9cc45'),
  forestFloorA: C('#45702a'),
  forestFloorB: C('#76a03a'),
  moss: C('#71853a'),
  soil: C('#6b4f34'),
  soilDark: C('#45321f'),
  clay: C('#9c6244'),
  clayLight: C('#bc8b67'),
  clayDark: C('#72483a'),
  clayCut: C('#c98f66'),
  clayWet: C('#6c4636'),
  sand: C('#dcc189'),
  sandLight: C('#ead6a8'),
  sandShadow: C('#bd9a66'),
  rock: C('#938f8a'),
  rockLight: C('#c6c2bb'),
  rockDark: C('#5f5c58'),
  rockBlue: C('#878a8f'),
  gravel: C('#a19c94'),
  alpine: C('#71894c'),
  snow: C('#f2f4f7'),
  wheatSoil: C('#7a5f3c'),
  wheatStraw: C('#c9a24e'),
  strataA: C('#6e4c33'),
  strataB: C('#4a3424'),
  strataC: C('#8a6c4e'),
  cliffRock: C('#6f6a66'),
  cliffRockDark: C('#2f2824'),
  algae: C('#3c5240'),
  iron: C('#9a7a58'),
  lichen: C('#9aa36a'),
  scree: C('#a9a7a3'),
  // The expansions' looks. Like every colour here, the square root of what renders: chosen as
  // albedos and converted (the hex is read as sRGB, made linear, and then squared).
  lakeDeep: C('#698f97'),
  lakeMid: C('#7c9f9c'),
  lakeShallow: C('#9fa791'),
  shore: C('#cbbd9f'),
  pebble: C('#a29f98'),
  lakeGrass: C('#6fa259'),
  mud: C('#887f69'),
  peat: C('#645b4f'),
  sedge: C('#a5aa7c'),
  marsh: C('#7f9d69'),
  bog: C('#829a8d'),
  bogDeep: C('#6f8d88'),
  duckweed: C('#8dac69'),
  // The swamp's peat country (renders olive-brown and russet, never the pasture's lime or the
  // lake's blue-green turf): dead sedge, dark moss, black mud, and pools dark as tea over peat.
  peatTurf: C('#a49d75'),
  russet: C('#ba9d75'),
  bogMoss: C('#808a66'),
  deadSedge: C('#ccc099'),
  blackMud: C('#7b7061'),
  peatPool: C('#5c7575'),
  peatPoolDeep: C('#4f6669'),
  scum: C('#9dad6b'),
  oasisDeep: C('#6298a2'),
  oasisShallow: C('#8dbab2'),
  dampSand: C('#bca782'),
  oasisGrass: C('#7c9f54'),
  ochre: C('#d3ba82'),
  ochreLight: C('#e0ca93'),
  umber: C('#a28a66'),
  tailings: C('#a7a59f'),
  rust: C('#9f7854'),
  quartz: C('#dbd9d4'),
  pond: C('#829188'),
  // The bounty field: raw sienna gravel (it renders a warm orange-brown, between the desert's
  // sand and the hills' rust, and never the wheat's yellow), sun-bleached gold bars, red iron
  // streaks, dark earth down the gullies, wet gravel by the water and pale washed tailings.
  gravelOchre: C('#d7b277'),
  gravelGrey: C('#cca474'),
  goldStreak: C('#efdaa8'),
  ironRed: C('#c38b66'),
  earthDark: C('#a8896a'),
  wetGravel: C('#a08d75'),
  spoil: C('#e5d7ba'),
  spoilRust: C('#d2a982'),
  crag: C('#a9a7a3'),
  cragDark: C('#6f6d6a'),
  cragWarm: C('#b3aa9e'),
  heath: C('#7c885d'),
  heather: C('#826f7f'),
  turf: C('#789f5d'),
  track: C('#9f917f'),
};

/** Outward normal angle (radians) of side i for a pointy-top hex: NE=-60°, E=0°, SE=60°, ... */
const SIDE_NORMALS = Array.from({ length: 6 }, (_, i) => {
  const a = ((-60 + 60 * i) * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)] as const;
});

/** Distance from local point to side i (positive inside). */
export function sideDistance(x: number, z: number, i: number): number {
  const [nx, nz] = SIDE_NORMALS[i];
  return HEX_APOTHEM * TILE_SCALE - (x * nx + z * nz);
}

function cornerDistance(x: number, z: number): number {
  let d = Infinity;
  // (Indexed: this runs for every vertex, and destructuring made an iterator each time.)
  for (let i = 0; i < 6; i++) d = Math.min(d, Math.hypot(x - CORNER_OFFSETS[i][0], z - CORNER_OFFSETS[i][1]));
  return d;
}

/** Where a blocker stands on a hex, local to its centre (boardView.robberSpot: behind and left of the disc). */
const ROBBER_SPOT = { x: -TOKEN_CLEAR * 0.55, z: -TOKEN_CLEAR * 0.5 };

/** The angle between two directions (radians, 0..π). */
const angDiff = (p: number, q: number) => Math.abs(Math.atan2(Math.sin(p - q), Math.cos(p - q)));

/**
 * The ground a hex with several discs keeps clear: round each disc as the single disc's clearing
 * is round it (scaled with the disc), and a small spot where a blocker stands among them (see
 * boardView.robberSpot: between a pair, beside a triangle, in the middle of four).
 */
function clearings(n: number, terrain: Terrain): { x: number; z: number; r: number }[] {
  const out = discSpots(n, terrain).map((d: DiscSpot) => ({ x: d.x, z: d.z, r: TOKEN_CLEAR * d.s }));
  const blocker = terrain === 'lake' || n >= 4 ? { x: 0, z: 0 } : n === 2 ? { x: 0, z: -TOKEN_CLEAR * 0.66 } : { x: -TOKEN_CLEAR * 1.1, z: -TOKEN_CLEAR * 0.75 };
  out.push({ ...blocker, r: 0.09 });
  return out;
}

function bump(x: number, z: number, cx: number, cz: number, r: number): number {
  const d = Math.hypot(x - cx, z - cz) / r;
  if (d >= 1) return 0;
  const t = 1 - d * d;
  return t * t;
}

export function createTileShape(ctx: TileContext, noise: Noise): TileShape {
  const { terrain, cx, cz } = ctx;
  const rnd = new Rand(ctx.seed * 7919 + 13);
  const features: TileFeatures = { peaks: [], anchor: null, pit: null };

  /** 0 at an edge lane, 1 well inside. Connected sides only reserve a narrow lane. */
  const edgeMask = (x: number, z: number) => {
    let m = 1;
    for (let i = 0; i < 6; i++) {
      const d = sideDistance(x, z, i);
      const v = ctx.connected[i] ? smoothstep(LANE * 0.55, LANE + 0.05, d) : smoothstep(RIM * 0.5, RIM + 0.14, d);
      if (v < m) m = v;
    }
    return m;
  };
  const cornerMask = (x: number, z: number) => smoothstep(CORNER_CLEAR * 0.55, CORNER_CLEAR + 0.08, cornerDistance(x, z));
  // A hex with several discs keeps clear ground under each of them and where a blocker would stand
  // among them (boardView.robberSpot), rather than one clearing in the middle that the outer discs
  // overhang (and, on the lake, rather than an island that has to carry them all).
  const spots = (ctx.discs ?? 0) >= 2 || (terrain === 'lake' && (ctx.discs ?? 0) >= 1) ? clearings(ctx.discs!, terrain) : null;
  const clearMask = spots
    ? (x: number, z: number) => {
        let m = 1;
        for (const c of spots) m = Math.min(m, smoothstep(c.r - 0.02, c.r + 0.16, Math.hypot(x - c.x, z - c.z)));
        return m;
      }
    : (x: number, z: number) => smoothstep(TOKEN_CLEAR - 0.02, TOKEN_CLEAR + 0.16, Math.hypot(x, z));
  const mask = (x: number, z: number) => edgeMask(x, z) * cornerMask(x, z) * clearMask(x, z);
  /** Base ground height near the rim (constant on every edge so neighbours meet seamlessly). */
  const RIM_H = 0.03;
  const baseRim = (x: number, z: number) => RIM_H * (0.6 + 0.4 * edgeMask(x, z));

  // World-space noise helpers so terrain is continuous between tiles.
  const wn = (x: number, z: number, s: number, o = 0) => noise.fbm2((x + cx) * s + o, (z + cz) * s - o, 4);

  /** Point pushed towards the middle of side i (for features that should face a connected neighbour). */
  const towardSide = (i: number, dist: number, spread: number) => {
    const [nx, nz] = SIDE_NORMALS[i];
    const a = Math.atan2(nz, nx) + rnd.range(-spread, spread);
    return { x: Math.cos(a) * dist, z: Math.sin(a) * dist };
  };
  const connectedSides = ctx.connected.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);

  let fn: (x: number, z: number) => number;
  /** A look with no number of its own may open its clearing, keeping only the blocker's spot. */
  let open: { x: number; z: number; r: number } | null = null;

  switch (terrain) {
    case 'forest': {
      fn = (x, z) => baseRim(x, z) + mask(x, z) * (0.05 + 0.07 * (wn(x, z, 1.4) * 0.5 + 0.5));
      break;
    }
    case 'pasture': {
      const hills = Array.from({ length: 2 + rnd.int(3) }, () => {
        const a = rnd.range(0, Math.PI * 2);
        const r = rnd.range(0.42, 0.62);
        return { x: Math.cos(a) * r, z: Math.sin(a) * r, r: rnd.range(0.26, 0.4), h: rnd.range(0.05, 0.12) };
      });
      fn = (x, z) => {
        let h = 0.035 * (wn(x, z, 1.8) * 0.5 + 0.5);
        for (const p of hills) h += p.h * bump(x, z, p.x, p.z, p.r);
        return baseRim(x, z) + mask(x, z) * h;
      };
      break;
    }
    case 'fields': {
      fn = (x, z) => baseRim(x, z) + mask(x, z) * (0.012 + 0.014 * wn(x, z, 2.5));
      const a = rnd.range(0, Math.PI * 2);
      features.anchor = { x: Math.cos(a) * 0.56, z: Math.sin(a) * 0.56, angle: a };
      break;
    }
    case 'hills': {
      // The clay pit and the kiln yard are chosen first; mounds rise elsewhere and the
      // kiln stands on a levelled patch of ground, never on a hilltop.
      const pa = rnd.range(0, Math.PI * 2);
      const pit = { x: Math.cos(pa) * 0.5, z: Math.sin(pa) * 0.5, r: rnd.range(0.25, 0.3) };
      features.pit = pit;
      const ka = pa + Math.PI * rnd.range(0.6, 0.9) * (rnd.chance(0.5) ? 1 : -1);
      const kiln = { x: Math.cos(ka) * 0.5, z: Math.sin(ka) * 0.5 };
      features.anchor = { ...kiln, angle: ka };
      const clearOf = (x: number, z: number, r: number) => Math.hypot(x - pit.x, z - pit.z) > pit.r + r * 0.6 && Math.hypot(x - kiln.x, z - kiln.z) > 0.2 + r * 0.6;
      const count = 3 + rnd.int(3);
      const mounds: { x: number; z: number; r: number; h: number }[] = [];
      for (let i = 0; i < count * 6 && mounds.length < count; i++) {
        const p = connectedSides.length && rnd.chance(0.5)
          ? towardSide(rnd.pick(connectedSides), rnd.range(0.48, 0.6), 0.4)
          : (() => {
              const a = rnd.range(0, Math.PI * 2);
              const r = rnd.range(0.46, 0.6);
              return { x: Math.cos(a) * r, z: Math.sin(a) * r };
            })();
        const r = rnd.range(0.26, 0.38);
        if (!clearOf(p.x, p.z, r)) continue;
        mounds.push({ ...p, r, h: rnd.range(0.12, 0.26) });
      }
      features.peaks = mounds;
      fn = (x, z) => {
        let h = 0.025 * (wn(x, z, 2.2) * 0.5 + 0.5);
        for (const m of mounds) h += m.h * bump(x, z, m.x, m.z, m.r) * (0.85 + 0.3 * wn(x, z, 4, 7));
        // Level yard around the kiln.
        const kd = Math.hypot(x - kiln.x, z - kiln.z);
        h = 0.03 + (h - 0.03) * smoothstep(0.12, 0.22, kd);
        const pd = Math.hypot(x - pit.x, z - pit.z) / pit.r;
        if (pd < 1) {
          // Terraced clay pit: flat benches with steep cut faces between them.
          const depth = 0.17 * Math.min(1, (1 - pd) * 1.4);
          const k = depth / 0.04;
          const stepped = (Math.floor(k) + smoothstep(0.75, 1, k - Math.floor(k))) * 0.04;
          h = Math.min(h, 0.05) - stepped;
        }
        return baseRim(x, z) + mask(x, z) * h;
      };
      break;
    }
    case 'mountains': {
      // A foothill on one flank holds the mine; its tunnel opens towards the clearing and a
      // ledge is carved in front of it. Chosen first so the peaks leave its sector free.
      const fa = -Math.PI / 2 + (rnd.chance(0.5) ? 1 : -1) * rnd.range(1.25, 1.55);
      const angDiff = (p: number, q: number) => Math.abs(Math.atan2(Math.sin(p - q), Math.cos(p - q)));
      // Peaks can stand on any side and lean towards connected mountain neighbours so adjacent
      // tiles read as one range. Peaks on the camera side (+z) stay lower so the disc shows.
      const main = rnd.range(0, Math.PI * 2);
      const count = 3;
      for (let i = 0; i < count; i++) {
        let p: { x: number; z: number } | null = null;
        if (connectedSides.length && i < connectedSides.length && rnd.chance(0.65)) {
          const q = towardSide(connectedSides[i], rnd.range(0.5, 0.58), 0.35);
          if (angDiff(Math.atan2(q.z, q.x), fa) > 0.75) p = q;
        }
        if (!p) {
          let a = main + i * rnd.range(1.6, 2.4);
          for (let k = 0; k < 6 && angDiff(a, fa) < 0.85; k++) a += 0.5;
          const r = rnd.range(0.5, 0.62);
          p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
        }
        const front = smoothstep(-0.1, 0.55, p.z);
        const h = (i === 0 ? rnd.range(0.85, 0.98) : rnd.range(0.5, 0.72)) * (1 - 0.45 * front);
        features.peaks.push({ ...p, h, r: i === 0 ? rnd.range(0.58, 0.68) : rnd.range(0.42, 0.55) });
      }
      features.peaks.push({ x: Math.cos(fa) * 0.64, z: Math.sin(fa) * 0.64, h: rnd.range(0.3, 0.36), r: 0.34 });
      const mineR = 0.47;
      features.anchor = { x: Math.cos(fa) * mineR, z: Math.sin(fa) * mineR, angle: fa + Math.PI };
      const ledgeA = { x: Math.cos(fa) * 0.5, z: Math.sin(fa) * 0.5 };
      const ledgeB = { x: Math.cos(fa) * 0.3, z: Math.sin(fa) * 0.3 };
      const ledge = (x: number, z: number) => {
        const dx = ledgeB.x - ledgeA.x, dz = ledgeB.z - ledgeA.z;
        const u = Math.max(0, Math.min(1, ((x - ledgeA.x) * dx + (z - ledgeA.z) * dz) / (dx * dx + dz * dz)));
        return Math.hypot(x - (ledgeA.x + dx * u), z - (ledgeA.z + dz * u));
      };
      // Each peak has a sheer face turned a different way and a long gentle back slope.
      const faceDir = features.peaks.map(() => rnd.range(0, Math.PI * 2));
      const faceK = features.peaks.map((_, i) => (i === count ? 0.1 : rnd.range(0.22, 0.4)));
      const peakAngles = features.peaks.map(() => rnd.range(0, Math.PI * 2));
      const peakRidges = features.peaks.map(() => 5 + rnd.int(3));
      fn = (x, z) => {
        let h = 0.05 * (wn(x, z, 2.6) * 0.5 + 0.5);
        const wx = x + cx, wz = z + cz;
        const warp = noise.noise2(wx * 2.2, wz * 2.2) * 0.6;
        features.peaks.forEach((p, i) => {
          const dx = x - p.x, dz = z - p.z;
          const d = (Math.hypot(dx, dz) / p.r) * (1 + faceK[i] * Math.cos(Math.atan2(dz, dx) - faceDir[i]));
          if (d >= 1.15) return;
          const cone = Math.max(0, 1 - d);
          // Concave alpine profile: steep near the summit, flattening into the foothills.
          const prof = Math.pow(cone, 1.35);
          // Arêtes radiating from the summit with couloirs between them (domain-warped angle).
          const ang = Math.atan2(dz, dx) + warp + peakAngles[i];
          const ridges = Math.pow(Math.abs(Math.cos(ang * peakRidges[i] * 0.5)), 1.4);
          const midSlope = Math.sin(Math.min(1, cone * 1.25) * Math.PI);
          const gully = noise.ridged2(wx * 7.5, wz * 7.5, 3);
          let v = p.h * prof * (0.8 + 0.2 * ridges * (1 - cone * 0.4)) + (gully - 0.3) * 0.05 * midSlope;
          // Sharpen the summit slightly.
          v += p.h * Math.pow(cone, 6) * 0.08;
          // Smooth maximum blends neighbouring peaks into saddles instead of creases.
          const k = 0.12;
          const hh = Math.max(k - Math.abs(h - v), 0) / k;
          h = Math.max(h, v) + hh * hh * k * 0.25;
        });
        // Strata ledges: gently terraced rock bands on the upper slopes.
        if (h > 0.18) {
          const t = h * 15;
          const terr = (Math.floor(t) + smoothstep(0.35, 0.65, t - Math.floor(t))) / 15;
          h = h + (terr - h) * 0.35 * smoothstep(0.18, 0.3, h);
        }
        const lf = smoothstep(0.1, 0.19, ledge(x, z));
        h = 0.05 * (1 - lf) + h * lf;
        return baseRim(x, z) + mask(x, z) * h;
      };
      break;
    }
    case 'lake': {
      // A horseshoe of water round the disc, which stands on a grassy point joined to the shore by
      // a neck on one side; bays push the far shore out unevenly. The ground is carved down by the
      // basin and the water lies flat over whatever falls below its level.
      // (The neck at the back and the jetty at the front, so it is seen from the table.)
      const level = 0.012;
      // With its four discs on rafts in the middle (discSpots.ts), the lake is open water round an
      // islet they are moored to, with no neck to the shore; the jetty comes in from the east or the west.
      const rafts = (ctx.discs ?? 0) >= 1;
      const neck = rafts ? (rnd.chance(0.5) ? 0 : Math.PI) + rnd.range(-0.15, 0.15) : -Math.PI / 2 + rnd.range(-0.9, 0.9);
      const reach = rnd.range(0.6, 0.66) + (rafts ? 0.03 : 0);
      const land = (x: number, z: number) => baseRim(x, z) + mask(x, z) * (0.022 + 0.03 * (wn(x, z, 1.7) * 0.5 + 0.5));
      const basin = (x: number, z: number) => {
        const r = Math.hypot(x, z), a = Math.atan2(z, x);
        const inner = (rafts ? LAKE_ISLET_RADIUS : 0.37) + (rafts ? 0.01 : 0.025) * noise.noise2(Math.cos(a) * 2 + ctx.seed, Math.sin(a) * 2);
        const outer = reach + 0.08 * wn(x, z, 2.1, 5);
        const ring = smoothstep(inner, inner + (rafts ? 0.04 : 0.07), r) * smoothstep(outer, outer - 0.1, r);
        return ring * (rafts ? 1 : smoothstep(0.22, 0.55, angDiff(a, neck))) * edgeMask(x, z) * cornerMask(x, z);
      };
      const carved = (x: number, z: number) => land(x, z) - 0.1 * basin(x, z);
      fn = (x, z) => Math.max(level, carved(x, z));
      features.water = { level, soak: 0.008, depth: (x, z) => (basin(x, z) > 0 ? level - carved(x, z) : -1), basin };
      // The jetty runs out from the far shore, opposite the neck, into the deepest water.
      const ja = neck + Math.PI + rnd.range(-0.35, 0.35) * (rafts ? 0.4 : 1);
      features.sites = { jetty: { x: Math.cos(ja) * 0.66, z: Math.sin(ja) * 0.66, a: ja + Math.PI }, neck: { x: Math.cos(neck) * 0.45, z: Math.sin(neck) * 0.45, a: neck } };
      break;
    }
    case 'oasis': {
      // Dunes, gentler than the desert's, falling to a spring-fed pool off to one side of the
      // clearing, with a ring of damp ground round it where the palms grow.
      // The oasis bears no number, so the pool may reach into the clearing: only the spot where a
      // blocker would stand is kept dry, and the pool lies across the clearing from it.
      const level = 0.014;
      open = { x: ROBBER_SPOT.x, z: ROBBER_SPOT.z, r: 0.12 };
      const pa = Math.atan2(-ROBBER_SPOT.z, -ROBBER_SPOT.x) + rnd.range(-0.7, 0.7);
      const pool = { x: Math.cos(pa) * 0.33, z: Math.sin(pa) * 0.33, r: rnd.range(0.19, 0.21) };
      const dir = rnd.range(0, Math.PI);
      const dx = Math.cos(dir), dz = Math.sin(dir);
      // The tents pitch on the far side of the clearing from the pool.
      const ta = pa + Math.PI + rnd.range(-0.6, 0.6);
      const camp = { x: Math.cos(ta) * 0.52, z: Math.sin(ta) * 0.52, a: ta };
      // Dunes as tall as the desert's, in long ridges, lying down round the pool and the camp.
      const land = (x: number, z: number) => {
        const u = (x + cx) * dx + (z + cz) * dz;
        const w = noise.noise2((x + cx) * 1.5, (z + cz) * 1.5);
        const dune = Math.pow(0.5 + 0.5 * Math.sin(u * 5.2 + w * 2.4), 2.2) * 0.13;
        const near = smoothstep(pool.r + 0.34, pool.r + 0.08, Math.hypot(x - pool.x, z - pool.z));
        const atCamp = smoothstep(0.26, 0.1, Math.hypot(x - camp.x, z - camp.z));
        return baseRim(x, z) + mask(x, z) * (0.02 + dune * (1 - near * 0.85) * (1 - atCamp * 0.9) + 0.025 * wn(x, z, 2));
      };
      const basin = (x: number, z: number) => {
        const dxp = x - pool.x, dzp = z - pool.z;
        const wob = 1 + 0.16 * noise.noise2(Math.atan2(dzp, dxp) * 1.3 + ctx.seed, 3.7) + 0.06 * wn(x, z, 5, 3);
        return smoothstep(pool.r * wob, pool.r * wob - 0.09, Math.hypot(dxp, dzp)) * edgeMask(x, z) * cornerMask(x, z);
      };
      const carved = (x: number, z: number) => land(x, z) - 0.1 * basin(x, z);
      fn = (x, z) => Math.max(level, carved(x, z));
      features.water = { level, soak: 0.01, depth: (x, z) => (basin(x, z) > 0 ? level - carved(x, z) : -1), basin };
      features.sites = { pool: { ...pool, a: pa }, camp };
      break;
    }
    case 'swamp': {
      // Low, sodden ground: tussocks of sedge between dark pools laid out by the noise, and where a
      // river ends here, a channel that carries it round the clearing towards the sea. The clearing
      // stays dry (a blocker sent home stands there, or the Oil module's well).
      const level = 0.012;
      const channel: { x: number; z: number }[] = [];
      if (ctx.riverSides) {
        const angleOf = (side: number) => Math.atan2(SIDE_NORMALS[side][1], SIDE_NORMALS[side][0]);
        const { in: from, out: to } = ctx.riverSides;
        const aOut = angleOf(to);
        const aIn = from >= 0 ? angleOf(from) : aOut + Math.PI;
        let turn = Math.atan2(Math.sin(aOut - aIn), Math.cos(aOut - aIn));
        if (Math.abs(turn) > Math.PI - 0.3) turn = rnd.chance(0.5) ? Math.PI : -Math.PI;
        const R = 0.48;
        if (from >= 0) channel.push({ x: Math.cos(aIn) * 0.84, z: Math.sin(aIn) * 0.84 });
        for (let i = 0; i <= 6; i++) {
          const a = aIn + (turn * i) / 6;
          const r = R + 0.03 * Math.sin(i * 1.9 + ctx.seed);
          channel.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
        }
        channel.push({ x: Math.cos(aOut) * 0.84, z: Math.sin(aOut) * 0.84 });
      }
      features.channel = channel;
      const chan = (x: number, z: number) => {
        let d = Infinity;
        for (let i = 0; i + 1 < channel.length; i++) d = Math.min(d, segDist(x, z, channel[i].x, channel[i].z, channel[i + 1].x, channel[i + 1].z));
        return d;
      };
      const basin = (x: number, z: number) => {
        const pools = smoothstep(-0.16, 0.03, noise.fbm2((x + cx) * 2.0 + 17, (z + cz) * 2.0 - 5, 3)) * mask(x, z);
        if (!channel.length) return pools;
        const c = smoothstep(0.08, 0.04 + 0.012 * noise.noise2((x + cx) * 9, (z + cz) * 9), chan(x, z));
        return Math.max(pools, c * edgeMask(x, z) * cornerMask(x, z) * clearMask(x, z));
      };
      // Tussocks rise only on the dry ground between the pools.
      const land = (x: number, z: number, b: number) => {
        const tussock = Math.max(0, noise.noise2((x + cx) * 13, (z + cz) * 13)) * 0.022 * (1 - b);
        return baseRim(x, z) + mask(x, z) * (0.012 + 0.01 * (wn(x, z, 1.9) * 0.5 + 0.5) + tussock);
      };
      const carved = (x: number, z: number) => {
        const b = basin(x, z);
        return land(x, z, b) - 0.08 * b;
      };
      fn = (x, z) => Math.max(level, carved(x, z));
      features.water = { level, soak: 0.03, depth: (x, z) => (basin(x, z) > 0 ? level - carved(x, z) : -1), basin };
      break;
    }
    case 'bounty': {
      // Gold country: worn ochre knolls cut by gullies, with quartz breaking through, and below them
      // a small working: a pond dammed to feed the sluice, which runs round the tile to its tail,
      // and the grey spoil of washed gravel heaped beyond.
      const level = 0.014;
      const wa = rnd.range(0, Math.PI * 2);
      const pond = { x: Math.cos(wa) * 0.5, z: Math.sin(wa) * 0.5, r: 0.11 };
      const turn = rnd.chance(0.5) ? 1 : -1;
      const ta = wa + turn * 1.1;
      const tail = { x: Math.cos(ta) * 0.52, z: Math.sin(ta) * 0.52, a: ta };
      // Spoil heaps big enough to read from the table, in a run beyond the sluice's tail.
      const heaps = Array.from({ length: 4 + rnd.int(2) }, (_, i) => {
        const a = ta + turn * (0.24 + i * 0.22 + rnd.range(0, 0.08));
        const r = rnd.range(0.48, 0.58);
        return { x: Math.cos(a) * r, z: Math.sin(a) * r, r: rnd.range(0.09, 0.12), h: rnd.range(0.065, 0.095) };
      });
      // A creek runs in from the tile's edge to feed the pond (from beyond the lane, as if under the road).
      const creek = Array.from({ length: 7 }, (_, i) => {
        const r = 0.5 + (i / 6) * 0.34;
        const a = wa + 0.12 * Math.sin(i * 1.7 + ctx.seed) * (i / 6);
        return { x: Math.cos(a) * r, z: Math.sin(a) * r };
      });
      const creekAt = (x: number, z: number) => {
        let d = Infinity;
        for (let i = 0; i + 1 < creek.length; i++) d = Math.min(d, segDist(x, z, creek[i].x, creek[i].z, creek[i + 1].x, creek[i + 1].z));
        return smoothstep(0.034, 0.018, d);
      };
      const knolls: { x: number; z: number; r: number; h: number }[] = [];
      for (let k = 0; k < 40 && knolls.length < 3; k++) {
        const a = rnd.range(0, Math.PI * 2);
        if (angDiff(a, wa) < 1.2 || angDiff(a, ta + turn * 0.4) < 1.0) continue;
        if (knolls.some((o) => angDiff(a, Math.atan2(o.z, o.x)) < 1.1)) continue;
        const r = rnd.range(0.5, 0.6);
        // (Lower on the camera's side, so the disc shows over them.)
        const front = smoothstep(-0.1, 0.55, Math.sin(a) * r);
        knolls.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r: rnd.range(0.24, 0.32), h: rnd.range(0.08, 0.13) * (1 - 0.4 * front) });
      }
      features.peaks = knolls;
      const land = (x: number, z: number) => {
        let k = 0;
        for (const p of knolls) k += p.h * bump(x, z, p.x, p.z, p.r);
        let s = 0;
        for (const p of heaps) s += p.h * bump(x, z, p.x, p.z, p.r);
        // Rain has cut gullies down the knolls' flanks.
        const gully = noise.ridged2((x + cx) * 6.5, (z + cz) * 6.5, 2) * Math.min(1, k * 14) * 0.016;
        return baseRim(x, z) + mask(x, z) * (0.024 + 0.022 * (wn(x, z, 2.3) * 0.5 + 0.5) + k * (0.85 + 0.3 * wn(x, z, 4, 3)) + s - gully);
      };
      const basin = (x: number, z: number) => Math.max(smoothstep(pond.r + 0.01, pond.r - 0.05, Math.hypot(x - pond.x, z - pond.z)), creekAt(x, z)) * edgeMask(x, z) * cornerMask(x, z);
      const carved = (x: number, z: number) => land(x, z) - 0.07 * basin(x, z);
      fn = (x, z) => Math.max(level, carved(x, z));
      features.water = { level, soak: 0.012, depth: (x, z) => (basin(x, z) > 0 ? level - carved(x, z) : -1), basin };
      features.anchor = { x: pond.x, z: pond.z, angle: ta };
      features.sites = { pond: { ...pond, a: wa }, tail, ...Object.fromEntries(heaps.map((h, i) => [`heap${i}`, h])) };
      break;
    }
    case 'castle': {
      // A rocky rise for the keep: a flat top at the centre (the castle is built at its height),
      // crags falling away on every side, and a track winding up from the foot, from a side with
      // land beyond it where there is one.
      const top = 0.2, flat = 0.4;
      const landSides = ctx.landSide.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
      const s0 = landSides.length ? rnd.pick(landSides) : rnd.int(6);
      const a0 = Math.atan2(SIDE_NORMALS[s0][1], SIDE_NORMALS[s0][0]) + rnd.range(-0.25, 0.25);
      const turn = rnd.chance(0.5) ? 1 : -1;
      const buttresses = Array.from({ length: 3 }, (_, i) => {
        const a = a0 + Math.PI * (0.5 + i * 0.5) + rnd.range(-0.3, 0.3);
        return { x: Math.cos(a) * 0.52, z: Math.sin(a) * 0.52, r: rnd.range(0.12, 0.17), k: rnd.range(0.06, 0.1) };
      });
      const rise = (x: number, z: number) => {
        const r = Math.hypot(x, z);
        if (r <= flat) return { prof: 1, slope: 0 };
        // An uneven footprint, with buttresses of rock standing out from the flanks.
        let rw = r + (noise.noise2((x + cx) * 2.2, (z + cz) * 2.2) * 0.09 + noise.noise2((x + cx) * 6, (z + cz) * 6) * 0.025) * smoothstep(flat, flat + 0.1, r);
        for (const b of buttresses) rw -= b.k * bump(x, z, b.x, b.z, b.r);
        const prof = smoothstep(0.7, flat + 0.04, rw);
        return { prof: Math.pow(prof, 0.8), slope: prof * (1 - prof) * 4 };
      };
      const base = (x: number, z: number) => {
        const { prof, slope } = rise(x, z);
        let h = top * prof;
        if (prof < 1) {
          // Crags and broken ledges on the flanks, softer at the foot.
          const wx = x + cx, wz = z + cz;
          h += (noise.ridged2(wx * 8, wz * 8, 3) - 0.35) * 0.05 * slope + 0.016 * (wn(x, z, 2.4) * 0.5 + 0.5) * (1 - prof);
          const t = h * 22;
          const terr = (Math.floor(t) + smoothstep(0.4, 0.7, t - Math.floor(t))) / 22;
          h += (terr - h) * 0.45 * slope;
        }
        return baseRim(x, z) + edgeMask(x, z) * cornerMask(x, z) * (0.012 + h);
      };
      const y0 = base(Math.cos(a0) * 0.7, Math.sin(a0) * 0.7);
      const yTop = base(0, 0);
      const track = Array.from({ length: 25 }, (_, i) => {
        const u = i / 24;
        const a = a0 + turn * 2.4 * u;
        const r = 0.7 - 0.32 * u;
        return { x: Math.cos(a) * r, z: Math.sin(a) * r, y: y0 + (yTop - y0) * smoothstep(0, 1, u) };
      });
      fn = (x, z) => {
        const h = base(x, z);
        if (Math.hypot(x, z) <= flat) return h;
        let best = Infinity, ty = h;
        for (let i = 0; i + 1 < track.length; i++) {
          const p = track[i], q = track[i + 1];
          const dx = q.x - p.x, dz = q.z - p.z;
          const u = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / (dx * dx + dz * dz)));
          const d = Math.hypot(x - p.x - dx * u, z - p.z - dz * u);
          if (d < best) {
            best = d;
            ty = p.y + (q.y - p.y) * u;
          }
        }
        return h + (ty - h) * smoothstep(0.05, 0.03, best);
      };
      features.plateau = { y: yTop, r: flat, track: track.map(({ x, z }) => ({ x, z })) };
      break;
    }
    case 'desert':
    default: {
      const dir = rnd.range(0, Math.PI);
      const dx = Math.cos(dir), dz = Math.sin(dir);
      fn = (x, z) => {
        const u = (x + cx) * dx + (z + cz) * dz;
        const w = noise.noise2((x + cx) * 1.5, (z + cz) * 1.5);
        const dune = Math.pow(0.5 + 0.5 * Math.sin(u * 6.5 + w * 2.4), 2.2) * 0.1;
        return baseRim(x, z) + mask(x, z) * (0.02 + dune + 0.03 * wn(x, z, 2));
      };
      break;
    }
  }

  // A river's channel, cut into the ground after the terrain has made it (see riverCourse.ts).
  const river = ctx.river;
  const carved = river ? (x: number, z: number) => carveRiver(river, x, z, fn(x, z)) : fn;
  // An oil well's pad, levelled (see wellSite.ts).
  const pad = ctx.pad;
  const height = pad ? (x: number, z: number) => levelPad(pad, x, z, carved(x, z)) : carved;

  const canPlace = (x: number, z: number, radius = 0.04) => {
    if (open ? Math.hypot(x - open.x, z - open.z) < open.r + radius : spots ? spots.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + 0.05 + radius) : Math.hypot(x, z) < TOKEN_CLEAR + 0.05 + radius) return false;
    if (river && !riverClear(river, x, z, radius)) return false;
    if (pad && onPad(pad, x, z, radius)) return false;
    if (cornerDistance(x, z) < CORNER_CLEAR + radius) return false;
    for (let i = 0; i < 6; i++) {
      const d = sideDistance(x, z, i);
      const need = ctx.connected[i] ? LANE + radius + 0.01 : RIM + 0.04 + radius;
      if (d < need) return false;
    }
    return true;
  };

  return { ctx, terrain, seed: ctx.seed, height, mask, canPlace, features };
}

// ---------------------------------------------------------------------------
// Colouring (world-space so neighbouring tiles match)
// ---------------------------------------------------------------------------

const tmp = new THREE.Color();
const tmp2 = new THREE.Color();

export function topColor(shape: TileShape, x: number, z: number, h: number, slope: number, noise: Noise, out: THREE.Color) {
  const { cx, cz } = shape.ctx;
  const wx = x + cx, wz = z + cz;
  const n = noise.fbm2(wx * 2.2, wz * 2.2, 3) * 0.5 + 0.5;
  const fine = noise.noise2(wx * 11, wz * 11) * 0.5 + 0.5;
  const m = shape.mask(x, z);
  switch (shape.terrain) {
    case 'forest':
      out.copy(PALETTE.forestFloorA).lerp(PALETTE.forestFloorB, n);
      if (fine > 0.7) out.lerp(PALETTE.moss, 0.45);
      out.lerp(PALETTE.grassB, (1 - m) * 0.35);
      break;
    case 'pasture':
      out.copy(PALETTE.meadowA).lerp(PALETTE.meadowB, n * 0.85 + fine * 0.15);
      break;
    case 'fields': {
      out.copy(PALETTE.wheatSoil).lerp(PALETTE.wheatStraw, 0.3 + 0.2 * n);
      // A little meadow around the number disc.
      const clearing = 1 - smoothstep(TOKEN_CLEAR - 0.02, TOKEN_CLEAR + 0.12, Math.hypot(x, z));
      out.lerp(PALETTE.grassB, clearing * 0.85);
      const rimOnly = 1 - smoothstep(RIM * 0.4, RIM + 0.1, Math.min(...[0, 1, 2, 3, 4, 5].map((i) => sideDistance(x, z, i))));
      out.lerp(PALETTE.grassB, rimOnly * 0.8);
      break;
    }
    case 'hills': {
      // Bare clay country: no turf. Dusty, sun-bleached patches and darker damp hollows.
      out.copy(PALETTE.clay).lerp(PALETTE.clayLight, n);
      if (h < 0.02) out.lerp(PALETTE.clayDark, 0.35);
      const dust = smoothstep(0.55, 0.85, fine * 0.6 + n * 0.5) * (1 - smoothstep(0.08, 0.2, h));
      out.lerp(PALETTE.clayLight, dust * 0.4 + (1 - m) * 0.2);
      // Freshly cut clay in the pit: bright benches, darker cut faces, wet clay at the bottom.
      const pit = shape.features.pit;
      if (pit) {
        const pd = Math.hypot(x - pit.x, z - pit.z) / pit.r;
        if (pd < 1.1) {
          const bench = Math.floor((0.05 - h) / 0.04);
          tmp2.copy(PALETTE.clayCut).lerp(PALETTE.clayDark, (bench % 2) * 0.18 + (slope > 0.45 ? 0.32 : 0));
          if (pd < 0.28) tmp2.lerp(PALETTE.clayWet, 0.75);
          out.lerp(tmp2, smoothstep(1.1, 0.92, pd));
        }
      }
      break;
    }
    case 'mountains': {
      out.copy(PALETTE.rock).lerp(PALETTE.rockBlue, n * 0.7);
      // Banded strata, lighter on the ledges and darker in between.
      const band = Math.sin(h * 58 + n * 4) * 0.5 + 0.5;
      out.lerp(band > 0.5 ? PALETTE.rockLight : PALETTE.rockDark, Math.abs(band - 0.5) * 0.45);
      // A little rust staining and lichen; mostly cool grey stone.
      if (noise.noise2(wx * 3.1, wz * 3.1) > 0.58) out.lerp(PALETTE.iron, 0.2);
      if (fine > 0.82 && h < 0.45) out.lerp(PALETTE.lichen, 0.25);
      if (slope > 0.6) out.lerp(PALETTE.rockDark, 0.3);
      // Scree aprons below the cliffs.
      const scree = smoothstep(0.06, 0.12, h) * (1 - smoothstep(0.22, 0.34, h)) * (slope < 1.3 ? 1 : 0.4);
      out.lerp(PALETTE.scree, scree * 0.6);
      // The floor is slate and gravel with only sparse tufts of alpine grass.
      const low = 1 - smoothstep(0.06, 0.16, h);
      const tuft = smoothstep(0.62, 0.82, fine * 0.5 + n * 0.6);
      out.lerp(PALETTE.gravel, low * 0.9);
      if (fine < 0.3) out.lerp(PALETTE.rockDark, low * 0.3);
      out.lerp(PALETTE.alpine, low * tuft * 0.5);
      const snowLine = 0.55 + 0.12 * (n - 0.5);
      const snow = smoothstep(snowLine, snowLine + 0.09, h) * (1 - smoothstep(1.0, 1.8, slope) * 0.6);
      out.lerp(PALETTE.snow, snow);
      break;
    }
    case 'lake': {
      // Lakeside turf, a touch bluer than the pasture's, down to a pale shore of sand and pebbles.
      const d = shape.features.water!.depth(x, z);
      out.copy(PALETTE.lakeGrass).lerp(PALETTE.meadowB, n * 0.55 + fine * 0.15);
      tmp2.copy(PALETTE.shore).lerp(PALETTE.pebble, smoothstep(0.45, 0.8, fine));
      // (Graded over more than a step of the mesh, and meeting the shallows' own colour at the
      // waterline, so no colour edge follows the triangles: the shader draws the line itself.)
      out.lerp(tmp2, smoothstep(0.08, 0.3, shape.features.water!.basin(x, z)) * smoothstep(-0.08, -0.03, d) * 0.85);
      out.lerp(PALETTE.lakeShallow, smoothstep(-0.035, 0, d));
      if (d >= 0) waterColor(d, PALETTE.lakeShallow, PALETTE.lakeMid, PALETTE.lakeDeep, n, out);
      break;
    }
    case 'swamp': {
      // Peat country: olive-brown tussocks of dead and living sedge, russet where it has turned,
      // dark cushions of moss, black mud wherever the ground dips towards the water, and the
      // pools dark as tea over the peat, scummed green in the still corners.
      const d = shape.features.water!.depth(x, z);
      out.copy(PALETTE.peatTurf).lerp(PALETTE.russet, smoothstep(0.35, 0.75, n) * 0.8);
      out.lerp(PALETTE.bogMoss, smoothstep(0.55, 0.85, noise.fbm2(wx * 5.1 - 7, wz * 5.1, 2) * 0.5 + 0.5) * 0.7);
      out.lerp(PALETTE.deadSedge, smoothstep(0.62, 0.9, fine * 0.6 + noise.fbm2(wx * 4.3 + 9, wz * 4.3, 2) * 0.4 + 0.2) * 0.6);
      // A muddy margin, so the pools' edges are soft rather than cut out.
      out.lerp(PALETTE.blackMud, smoothstep(0.05, 0.32, shape.features.water!.basin(x, z)) * 0.8);
      if (d >= 0) {
        out.copy(PALETTE.blackMud).lerp(PALETTE.peatPool, smoothstep(0.0, 0.012, d)).lerp(PALETTE.peatPoolDeep, smoothstep(0.01, 0.045, d));
        const weed = smoothstep(0.55, 0.72, noise.fbm2(wx * 7 + 3, wz * 7, 2) * 0.5 + 0.5 + (0.012 - d) * 8);
        out.lerp(PALETTE.scum, weed * 0.8);
      }
      break;
    }
    case 'oasis': {
      // The desert's sand, with a ring of grass round the pool where the spring keeps it damp.
      const d = shape.features.water!.depth(x, z);
      const pool = shape.features.sites!.pool;
      out.copy(PALETTE.sand).lerp(PALETTE.sandLight, n);
      if (slope > 0.22) out.lerp(PALETTE.sandShadow, 0.3);
      const pd = Math.hypot(x - pool.x, z - pool.z) - pool.r!;
      const green = smoothstep(0.2, 0.05, pd + (fine - 0.5) * 0.06 + (n - 0.5) * 0.05);
      out.lerp(PALETTE.oasisGrass, green * 0.9);
      out.lerp(PALETTE.dampSand, smoothstep(0.05, 0.35, shape.features.water!.basin(x, z)));
      out.lerp(PALETTE.oasisShallow, smoothstep(-0.035, 0, d) * 0.7);
      if (d >= 0) waterColor(d, PALETTE.oasisShallow, PALETTE.oasisShallow, PALETTE.oasisDeep, n, out);
      break;
    }
    case 'bounty': {
      // Raw sienna gravel worked over for gold: banded with sun-bleached bars where the old
      // stream beds ran, streaked with red iron, dark down the gullies' sides, quartz breaking
      // through on the knolls, and the pale washed tailings heaped round the flume's tail, banded
      // with rust where each load dried. Wet, dark gravel rings the pond and lines the creek.
      const d = shape.features.water!.depth(x, z);
      out.copy(PALETTE.gravelOchre).lerp(PALETTE.gravelGrey, n * 0.8);
      // Old bars: long bands of bleached gravel, warped so they wander like dry stream beds.
      const bar = noise.ridged2(wx * 2.1 + noise.noise2(wx * 1.3, wz * 1.3) * 0.8 + 5, wz * 2.1 - 3, 2);
      out.lerp(PALETTE.goldStreak, smoothstep(0.42, 0.78, bar) * 0.85);
      out.lerp(PALETTE.ironRed, smoothstep(0.25, 0.6, noise.noise2(wx * 3.4 + 11, wz * 3.4)) * 0.55);
      out.lerp(PALETTE.earthDark, smoothstep(0.3, 0.8, slope) * 0.5);
      if (fine > 0.84 && slope > 0.2) out.lerp(PALETTE.quartz, 0.6);
      tmp2.copy(PALETTE.spoil).lerp(PALETTE.spoilRust, smoothstep(0.35, 0.75, Math.sin(h * 140 + n * 5) * 0.5 + 0.5) * 0.7);
      out.lerp(tmp2, spoilAt(shape, x, z));
      out.lerp(PALETTE.wetGravel, smoothstep(0.05, 0.4, shape.features.water!.basin(x, z)) * 0.85);
      if (d >= 0) waterColor(d, PALETTE.wetGravel.clone().lerp(PALETTE.pond, 0.4), PALETTE.pond, PALETTE.pond.clone().multiplyScalar(0.7), n, out);
      break;
    }
    case 'castle': {
      // Heath at the foot (turf and heather), bare crag on the flanks banded by its ledges, a
      // trodden top, scree where the rock has fallen, and the track's packed earth winding up.
      const pl = shape.features.plateau!;
      const r = Math.hypot(x, z);
      out.copy(PALETTE.heath).lerp(PALETTE.turf, n * 0.8 + fine * 0.2);
      if (noise.noise2(wx * 5.3, wz * 5.3) > 0.35) out.lerp(PALETTE.heather, 0.5);
      const rock = smoothstep(0.14, 0.45, slope) * (r > pl.r ? 1 : 0);
      tmp2.copy(PALETTE.crag).lerp(PALETTE.cragWarm, n);
      const band = Math.sin(h * 70 + n * 3) * 0.5 + 0.5;
      tmp2.lerp(band > 0.5 ? PALETTE.rockLight : PALETTE.cragDark, Math.abs(band - 0.5) * 0.5);
      if (fine > 0.8) tmp2.lerp(PALETTE.lichen, 0.3);
      out.lerp(tmp2, rock);
      const scree = smoothstep(0.05, 0.1, h) * (1 - smoothstep(0.14, 0.2, h)) * smoothstep(0.15, 0.4, slope) * (1 - rock * 0.5);
      out.lerp(PALETTE.scree, scree * 0.55);
      // The top is worn to earth and gravel where the castle's people come and go, with turf
      // hanging on at its lip.
      if (r <= pl.r + 0.02) out.copy(PALETTE.track).lerp(PALETTE.gravel, 0.25 + 0.35 * fine).lerp(PALETTE.turf, smoothstep(pl.r - 0.1, pl.r + 0.02, r) * 0.7 * n);
      out.lerp(PALETTE.track, trackAt(pl.track, x, z) * (0.75 + 0.2 * fine));
      break;
    }
    case 'desert':
    default:
      out.copy(PALETTE.sand).lerp(PALETTE.sandLight, n);
      if (slope > 0.22) out.lerp(PALETTE.sandShadow, 0.3);
      break;
  }
  // A river's wet banks and silty bed, over whatever the terrain coloured (see riverCourse.ts).
  if (shape.ctx.river) tintRiver(shape.ctx.river, x, z, h, out);
  // An oil well's trodden yard (see wellSite.ts).
  if (shape.ctx.pad) tintPad(shape.ctx.pad, x, z, out);
}

/** Water from above: the bed through the shallows, darkening to the deep colour. */
function waterColor(depth: number, shallow: THREE.Color, mid: THREE.Color, deep: THREE.Color, n: number, out: THREE.Color) {
  out.copy(shallow).lerp(mid, smoothstep(0.0, 0.03, depth)).lerp(deep, smoothstep(0.025, 0.08, depth + (n - 0.5) * 0.01));
}

/** The castle track's packed earth: 1 on it, fading over its verges. */
export function trackAt(track: { x: number; z: number }[], x: number, z: number) {
  let d = Infinity;
  for (let i = 0; i + 1 < track.length; i++) d = Math.min(d, segDist(x, z, track[i].x, track[i].z, track[i + 1].x, track[i + 1].z));
  return smoothstep(0.042, 0.026, d);
}

/** The bounty field's washed gravel: round the sluice's tail and on the spoil heaps. */
function spoilAt(shape: TileShape, x: number, z: number) {
  const sites = shape.features.sites!;
  let s = smoothstep(0.16, 0.05, Math.hypot(x - sites.tail.x, z - sites.tail.z));
  for (const k in sites) if (k.startsWith('heap')) s = Math.max(s, smoothstep(sites[k].r! * 1.3, sites[k].r! * 0.5, Math.hypot(x - sites[k].x, z - sites[k].z)));
  return s;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface TileGeometry {
  top: THREE.BufferGeometry;
  walls: THREE.BufferGeometry;
  /** The land-facing sides' walls: buried against the neighbours once the island is whole,
   *  shown only while tiles rise one by one, so a lone tile has earth under it. */
  inner: THREE.BufferGeometry;
}

export function buildTileGeometry(shape: TileShape, noise: Noise, rings = 36, bakeAO = true): TileGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];

  // Tiles meet flush wherever there is land on the other side (one continuous island);
  // only sea-facing sides are pulled in slightly and bevelled into a cliff lip.
  const land = shape.ctx.landSide;
  const scaleForSide = (side: number) => (land[side] ? 1 : TILE_SCALE);
  // A corner is only pulled in when both of its sides face the sea. Where a land side meets
  // a sea side the neighbouring tile shares the corner, so it must stay exactly in place or
  // the two cliffs open a slot between them.
  const corner = (c: number) => {
    const s = land[c] || land[(c + 5) % 6] ? 1 : TILE_SCALE;
    return [CORNER_OFFSETS[c][0] * s, CORNER_OFFSETS[c][1] * s] as const;
  };

  let vcount = 0;
  for (let k = 0; k <= rings; k++) {
    ringStart.push(vcount);
    const count = k === 0 ? 1 : 6 * k;
    for (let i = 0; i < count; i++) {
      let x = 0, z = 0;
      if (k > 0) {
        const c = Math.floor(i / k);
        const t = (i % k) / k;
        const [ax, az] = corner(c);
        const [bx, bz] = corner((c + 1) % 6);
        const f = k / rings;
        x = lerp(ax, bx, t) * f;
        z = lerp(az, bz, t) * f;
        // On the outer ring, push mid-side vertices flush with the shared edge when connected.
        if (k === rings && t > 0 && land[c]) {
          const s = scaleForSide(c);
          x = lerp(CORNER_OFFSETS[c][0], CORNER_OFFSETS[(c + 1) % 6][0], t) * s;
          z = lerp(CORNER_OFFSETS[c][1], CORNER_OFFSETS[(c + 1) % 6][1], t) * s;
        }
      }
      if (k > 0 && k < rings) {
        x += noise.noise2(x * 13 + 3.1 + shape.ctx.cx, z * 13 + shape.ctx.cz) * 0.008;
        z += noise.noise2(x * 13 + shape.ctx.cx, z * 13 + 7.7 + shape.ctx.cz) * 0.008;
      }
      let y = shape.height(x, z);
      if (k === rings) {
        const c = Math.floor(i / k);
        const t = (i % k) / k;
        const seaSide = t === 0 ? !land[(c + 5) % 6] || !land[c] : !land[c];
        if (seaSide) y = -0.02; // bevelled lip on the coast
        else y = shape.height(x * 0.999, z * 0.999); // flush, matching the neighbour
      }
      positions.push(x, y, z);
      vcount++;
    }
  }
  for (let k = 1; k <= rings; k++) {
    const inner = ringStart[k - 1];
    const outer = ringStart[k];
    const outerCount = 6 * k;
    const innerCount = k === 1 ? 1 : 6 * (k - 1);
    for (let c = 0; c < 6; c++) {
      for (let s = 0; s < k; s++) {
        const o0 = outer + ((c * k + s) % outerCount);
        const o1 = outer + ((c * k + s + 1) % outerCount);
        const iIdx = (k - 1) * c + s;
        const i0 = k === 1 ? inner : inner + (iIdx % innerCount);
        indices.push(i0, o1, o0);
        if (s < k - 1) {
          const i1 = inner + ((iIdx + 1) % innerCount);
          indices.push(i0, i1, o1);
        }
      }
    }
  }

  const top = new THREE.BufferGeometry();
  top.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  top.setIndex(indices);
  top.computeVertexNormals();
  const nrm = top.getAttribute('normal');
  const colors = new Float32Array(vcount * 3);
  const rocky = new Float32Array(vcount);
  const meadow = new Float32Array(vcount);
  const ore = new Float32Array(vcount);
  for (let v = 0; v < vcount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const slope = (1 - nrm.getY(v)) * 2.2;
    topColor(shape, x, z, y, slope, noise, tmp);
    colors[v * 3] = tmp.r;
    colors[v * 3 + 1] = tmp.g;
    colors[v * 3 + 2] = tmp.b;
    // How much rock-strata detail the shader should add here.
    // Baked occlusion: darken creases and hollows, lift ridges (cheap horizon test).
    if (bakeAO) {
      let occ = 0, avg = 0;
      for (const r of [0.045, 0.13]) {
        for (let k = 0; k < 6; k++) {
          const a = k * 1.0472 + r * 9;
          const hs = shape.height(x + Math.cos(a) * r, z + Math.sin(a) * r);
          occ += Math.min(1.5, Math.max(0, (hs - y) / r));
          avg += hs;
        }
      }
      occ /= 12;
      const cavity = y - avg / 12;
      const shade = 1 - Math.min(0.5, occ * 0.42) + Math.max(-0.08, Math.min(0.1, cavity * 1.6));
      tmp.multiplyScalar(shade);
      colors[v * 3] = tmp.r;
      colors[v * 3 + 1] = tmp.g;
      colors[v * 3 + 2] = tmp.b;
    }
    if (shape.terrain === 'mountains') rocky[v] = Math.max(0.12, smoothstep(0.08, 0.3, y)) * (1 - smoothstep(0.62, 0.8, y) * (slope < 0.9 ? 1 : 0.3));
    else if (shape.terrain === 'hills') rocky[v] = smoothstep(0.35, 0.9, slope) * 0.6;
    // Where ore veins may show in the rock (below the snow).
    if (shape.terrain === 'mountains') ore[v] = smoothstep(0.14, 0.24, y) * smoothstep(0.35, 0.8, slope) * (1 - smoothstep(0.5, 0.62, y));
    // Where tiny wildflowers may be speckled into the ground.
    const m = shape.mask(x, z);
    meadow[v] =
      shape.terrain === 'pasture' ? 0.55 + 0.45 * m
      : shape.terrain === 'forest' ? 0.25 * (1 - m) + 0.1
      : shape.terrain === 'fields' ? 0.5 * (1 - m)
      : shape.terrain === 'mountains' ? 0.06 * (1 - smoothstep(0.05, 0.2, y))
      : 0;
    LOOK_EXTRAS[shape.terrain]?.(shape, x, z, y, slope, m, v, rocky, meadow, ore, noise);
  }
  top.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  top.setAttribute('rocky', new THREE.BufferAttribute(rocky, 1));
  top.setAttribute('meadow', new THREE.BufferAttribute(meadow, 1));
  top.setAttribute('ore', new THREE.BufferAttribute(ore, 1));

  const { walls, inner } = buildWalls(shape, noise, ringStart[rings], rings, positions);
  return { top, walls, inner };
}

type Extras = (shape: TileShape, x: number, z: number, y: number, slope: number, m: number, v: number, rocky: Float32Array, meadow: Float32Array, ore: Float32Array, noise: Noise) => void;

/**
 * Standing water and its soaked margin, told to the terrain shader through the sign of `meadow`
 * (no flowers grow there anyway). Near the waterline the mark runs straight through the shore's
 * depth, WATERLINE at the water's edge and rising into the water, so the shader can find the
 * edge per pixel where the interpolated mark crosses WATERLINE: a smooth line following the
 * analytic depth field rather than the triangles' sawtooth (which a mark that jumped from wet to
 * water at the vertices drew). Below that, from WATERLINE down to 0, the ground is wet, most of all
 * at the edge; further out a pool's soak keeps it damp. (A new attribute would be the ninth vertex
 * buffer, one more than WebGPU allows the terrain.)
 */
function waterMarks(shape: TileShape, x: number, z: number, v: number, meadow: Float32Array) {
  const w = shape.features.water;
  if (!w) return;
  const d = w.depth(x, z);
  const basin = w.basin(x, z);
  const line = basin > 0 ? WATERLINE + d * WATER_SLOPE : -1;
  const soak = d > -w.soak ? 0.6 * smoothstep(0.02, 0.4, basin) * smoothstep(-w.soak, 0, d) : 0;
  const mark = Math.max(line, soak);
  if (mark > 0) meadow[v] = Math.min(meadow[v], -mark);
}

/** Where the water mark meets the water (the shader reads the same number: see materials.ts). */
export const WATERLINE = 0.71;
/** How fast the mark climbs with depth: steep enough that the wet band is a narrow margin. */
const WATER_SLOPE = 12;

/**
 * The expansions' looks' shader masks: rock on the castle's crags and the bounty field's
 * gullies, a few flowers in the turf, and gold, told to the shader as a negative `ore` (the
 * mountains' veins are positive), wherever gravel has been washed or worn: brightest round the
 * sluice and on its spoil, never under the water.
 */
const LOOK_EXTRAS: Partial<Record<Terrain, Extras>> = {
  lake: (shape, x, z, _y, _slope, m, v, _rocky, meadow) => {
    meadow[v] = 0.3 * m;
    waterMarks(shape, x, z, v, meadow);
  },
  swamp: (shape, x, z, _y, _slope, m, v, _rocky, meadow) => {
    meadow[v] = 0.12 * m;
    waterMarks(shape, x, z, v, meadow);
  },
  oasis: (shape, x, z, _y, _slope, _m, v, _rocky, meadow) => {
    const pool = shape.features.sites!.pool;
    meadow[v] = 0.3 * smoothstep(0.2, 0.08, Math.hypot(x - pool.x, z - pool.z) - pool.r!);
    waterMarks(shape, x, z, v, meadow);
  },
  bounty: (shape, x, z, _y, slope, _m, v, rocky, meadow, ore, noise) => {
    rocky[v] = smoothstep(0.45, 1.0, slope) * 0.55;
    const wet = shape.features.water!.depth(x, z);
    // (The old bars as topColor draws them: gold lies along them too, more thinly.)
    const wx = x + shape.ctx.cx, wz = z + shape.ctx.cz;
    const bar = smoothstep(0.42, 0.78, noise.ridged2(wx * 2.1 + noise.noise2(wx * 1.3, wz * 1.3) * 0.8 + 5, wz * 2.1 - 3, 2));
    ore[v] = wet >= 0 ? 0 : -Math.min(1, 0.25 + 0.35 * smoothstep(0.25, 0.7, slope) + 0.45 * bar + spoilAt(shape, x, z) + 0.6 * smoothstep(0.05, 0.4, shape.features.water!.basin(x, z)));
    waterMarks(shape, x, z, v, meadow);
  },
  castle: (shape, x, z, y, slope, _m, v, rocky, meadow) => {
    const pl = shape.features.plateau!;
    const crag = smoothstep(0.14, 0.45, slope) * (Math.hypot(x, z) > pl.r ? 1 : 0) * (1 - trackAt(pl.track, x, z));
    rocky[v] = crag;
    meadow[v] = 0.2 * (1 - crag) * (1 - smoothstep(0.06, 0.12, y));
  },
};

/** Rocky layered cliff walls around the tile perimeter (only open sides are visible). */
function buildWalls(shape: TileShape, noise: Noise, perimStart: number, rings: number, topPos: number[]): { walls: THREE.BufferGeometry; inner: THREE.BufferGeometry } {
  const perim = 6 * rings;
  const levels = [-0.02, -0.06, -0.13, -0.24, -0.38, -0.56, -0.78, -1.02, -1.3, CLIFF_BOTTOM];
  const pos: number[] = [];
  const col: number[] = [];
  const cove: number[] = [];
  const rows: number[][] = [];
  const { cx, cz } = shape.ctx;
  // Sides with a sandy cove at their foot (see coast.ts), faded towards the corners.
  const coveAt = (i: number) => {
    const side = Math.floor(i / rings);
    if (!isBeachSide(shape.seed, side)) return 0;
    const u = (i % rings) / rings;
    return smoothstep(0.02, 0.16, u) * smoothstep(1, 0.86, u);
  };
  const landSide = shape.ctx.landSide;
  // Where a sea cliff meets a land side, the neighbouring tile's cliff starts at the same
  // corner. Displacement is radial from each tile's own centre, so it would open a sliver
  // between the two walls; fade it out over the last few vertices so they meet exactly.
  const junctionFade = (i: number) => {
    const side = Math.floor(i / rings), k = i % rings;
    let w = 1;
    const startJ = landSide[(side + 5) % 6] !== landSide[side];
    const endJ = landSide[(side + 1) % 6] !== landSide[side];
    if (startJ) w = Math.min(w, smoothstep(0, 4, k));
    if (endJ) w = Math.min(w, smoothstep(0, 4, rings - k));
    return w;
  };
  for (let li = 0; li < levels.length; li++) {
    const row: number[] = [];
    for (let i = 0; i < perim; i++) {
      const tx = topPos[(perimStart + i) * 3];
      const ty = topPos[(perimStart + i) * 3 + 1];
      const tz = topPos[(perimStart + i) * 3 + 2];
      // The top row starts exactly on the turf edge above it. Sea sides are bevelled to
      // -0.02, but land sides follow the ground, so a fixed level would leave a slit (the sea
      // showing through it while tiles rise on their own). Lower rows stay below it.
      const y = li === 0 ? ty : Math.min(levels[li], ty - 0.04);
      const wx = tx + cx, wz = tz + cz;
      const depthT = clamp((-y - 0.02) / 0.5, 0, 1);
      // Layered rock: horizontal strata ledges plus rounded boulder bulges.
      const strata = Math.sin(y * 38 + noise.noise2(wx * 2, wz * 2) * 2.5) * 0.012 * depthT;
      // Chunky blocks: quantised noise gives faceted ledges like broken basalt.
      const blk = noise.noise3(wx * 3.2, Math.floor(y * 9) * 0.37, wz * 3.2);
      const bulge = noise.noise3(wx * 2.6, y * 3.2, wz * 2.6) * 0.06 * depthT + Math.round(blk * 3) / 3 * 0.035 * depthT + noise.noise3(wx * 8, y * 9, wz * 8) * 0.016 * depthT;
      // The top row must sit exactly on the turf edge (no slit to the sea below); the next
      // row tucks in under the turf lip.
      const lip = li === 1 ? -0.004 : 0;
      const spread = y < SEA_LEVEL ? (SEA_LEVEL - y) * 0.07 : 0;
      const jw = junctionFade(i);
      const r = 1 + (lip + bulge + strata + spread) * jw;
      row.push(pos.length / 3);
      pos.push(tx * r, y + noise.noise2(wx * 6 + li, wz * 6) * 0.012 * depthT * jw, tz * r);
      const band = noise.noise2(y * 7 + wx * 0.3, (wx + wz) * 1.2) * 0.5 + 0.5;
      if (li <= 1) {
        tmp.copy(PALETTE.soilDark).lerp(PALETTE.soil, band);
        if (li === 0) {
          topColor(shape, tx, tz, 0, 0, noise, tmp2);
          tmp.lerp(tmp2, 0.8);
        }
      } else if (y > -0.45) {
        tmp.copy(band > 0.5 ? PALETTE.strataA : PALETTE.strataB).lerp(PALETTE.strataC, noise.noise2(wx * 4, y * 16) * 0.5 + 0.5);
        if (shape.terrain === 'hills') tmp.lerp(PALETTE.clayDark, 0.45);
        if (shape.terrain === 'desert') tmp.lerp(PALETTE.sandShadow, 0.5);
        if (shape.terrain === 'mountains' || shape.terrain === 'castle') tmp.lerp(PALETTE.rockDark, 0.45);
        if (shape.terrain === 'oasis') tmp.lerp(PALETTE.sandShadow, 0.5);
        if (shape.terrain === 'bounty') tmp.lerp(PALETTE.umber, 0.4);
        if (shape.terrain === 'swamp') tmp.lerp(PALETTE.peat, 0.5);
      } else {
        tmp.copy(PALETTE.cliffRock).lerp(PALETTE.cliffRockDark, band);
        if (y < SEA_LEVEL - 0.12) tmp.lerp(PALETTE.algae, 0.35);
      }
      col.push(tmp.r, tmp.g, tmp.b);
      cove.push(coveAt(i));
    }
    rows.push(row);
  }
  const idx: number[] = [];
  const innerIdx: number[] = [];
  const land = shape.ctx.landSide;
  for (let li = 0; li < levels.length - 1; li++) {
    const a = rows[li], b = rows[li + 1];
    for (let i = 0; i < perim; i++) {
      const j = (i + 1) % perim;
      // Land sides are hidden against the neighbouring tile once it has risen.
      (land[Math.floor(i / rings)] ? innerIdx : idx).push(a[i], a[j], b[i], a[j], b[j], b[i]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('cove', new THREE.Float32BufferAttribute(cove, 1));
  const inner = g.clone();
  g.setIndex(idx);
  g.computeVertexNormals();
  inner.setIndex(innerIdx);
  inner.computeVertexNormals();
  return { walls: g, inner };
}

/** Poisson-ish scatter of points accepted by a predicate (grid-hashed, O(n)). */
export function scatter(rand: Rand, count: number, minDist: number, accept: (x: number, z: number) => boolean, maxTries = count * 40) {
  const pts: { x: number; z: number }[] = [];
  const cell = Math.max(minDist, 0.01);
  const grid = new Map<number, { x: number; z: number }[]>();
  const key = (i: number, j: number) => (i + 512) * 4096 + (j + 512);
  const md2 = minDist * minDist;
  for (let t = 0; t < maxTries && pts.length < count; t++) {
    const x = rand.range(-0.95, 0.95);
    const z = rand.range(-0.95, 0.95);
    const ci = Math.floor(x / cell);
    const cj = Math.floor(z / cell);
    let ok = true;
    for (let di = -1; di <= 1 && ok; di++)
      for (let dj = -1; dj <= 1 && ok; dj++) {
        const list = grid.get(key(ci + di, cj + dj));
        if (!list) continue;
        for (const p of list)
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < md2) {
            ok = false;
            break;
          }
      }
    if (!ok || !accept(x, z)) continue;
    const pt = { x, z };
    pts.push(pt);
    const k = key(ci, cj);
    const list = grid.get(k);
    if (list) list.push(pt);
    else grid.set(k, [pt]);
  }
  return pts;
}
