// Ocean: an FFT-simulated sea (see oceanSim.ts) with whitecaps, screen-space refraction,
// island-aware shallows, animated shoreline foam and a caustic-lit seabed. Without WebGPU it
// falls back to a Gerstner swell with tiled detail normals.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  uniform,
  texture,
  positionLocal,
  positionWorld,
  time,
  sin,
  cos,
  mix,
  smoothstep,
  normalize,
  dot,
  max,
  pow,
  clamp,
  cameraPosition,
  screenUV,
  viewportSharedTexture,
  mx_worley_noise_float,
  mx_worley_noise_vec2,
  mx_noise_float,
  transformNormalToView,
  abs,
  exp,
  reflect,
  perspectiveDepthToViewZ,
  cameraNear,
  cameraFar,
  positionView,
  attribute,
  If,
  reflector,
  log2,
  int,
  floor,
  fract,
  luminance,
  uniformArray,
} from 'three/tsl';
import { bumpedNormal, type TileEffects } from '../board/materials';
import { DETAIL_LAYER, SEA_LEVEL, type SdfField } from '../board/layout';
import { METRES_PER_UNIT, N as SIM_N, type OceanSim } from './oceanSim';
import { cloudShadeHere } from './clouds';
import { rainRings as sharedRainRings, surfPhase, surfWarp } from './surf';
import { gust as windGust, windDir } from './wind';
import { seaDepth, seaSafeUV } from '../util/sceneDepth';
import { frameState } from '../util/frame';
import { moonGlow } from './timeOfDay';
import { DETAIL_SIZE, detailNormals } from './oceanDetail';

// three r186 gives each viewport texture node (the water's copies of the scene behind it) a
// copy per render target and never frees them, so every post-pipeline rebuild (quality or
// motion-blur change) leaked screen-sized textures. Free a copy when its target is disposed.
const viewportProto = THREE.ViewportTextureNode.prototype as unknown as {
  getTextureForReference(reference?: unknown): THREE.Texture;
};
const textureFor = viewportProto.getTextureForReference;
viewportProto.getTextureForReference = function (this: unknown, reference = null) {
  const tex = textureFor.call(this, reference);
  const target = reference as THREE.RenderTarget | null;
  if (target?.isRenderTarget && !tex.userData.freedWithTarget) {
    tex.userData.freedWithTarget = true;
    target.addEventListener('dispose', () => tex.dispose());
  }
  return tex;
};

interface OceanOptions {
  sdf: SdfField;
  sunDir: THREE.Vector3;
  /** The shadow-casting sun: its shadow map is not re-rendered for the mirror view. */
  sun: THREE.DirectionalLight;
  /** Land hex centres, keyed by tile id: the sand under each one heaves up with it in the intro. */
  tiles: SeabedTile[];
  /** Per-tile vertical offset (TileEffects.rise). */
  rise: TileEffects['rise'];
  /** The FFT wave simulation (WebGPU only); without it the sea uses the Gerstner fallback. */
  sim?: OceanSim | null;
  /** The ripple normals' texels, if already built (see oceanDetail.ts). */
  detail?: Uint8Array | null;
}

interface SeabedTile {
  id: number;
  x: number;
  z: number;
}

interface Wave {
  dir: [number, number];
  length: number;
  amp: number;
  speed: number;
  steep: number;
}

const WAVES: Wave[] = [
  { dir: [0.8, 0.6], length: 9.0, amp: 0.05, speed: 1.0, steep: 0.5 },
  { dir: [-0.3, 0.95], length: 5.3, amp: 0.03, speed: 0.9, steep: 0.55 },
  { dir: [0.95, -0.2], length: 3.1, amp: 0.018, speed: 1.1, steep: 0.6 },
  { dir: [-0.7, -0.7], length: 1.9, amp: 0.01, speed: 1.2, steep: 0.6 },
];

/** The sea's fine ripple normals as a texture: `data` from detailNormals (made here if not given). */
function makeDetailNormalMap(data = detailNormals(), size = DETAIL_SIZE): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Packs the island SDF into a half-float texture, with room beside it for what the sea is doing
 * there: r = the SDF, g = fog over face-down hexes (0..1), b = how much of a flood's surge
 * reaches here (0..1), a unused. One texture, read where the SDF already is, so the fog and the
 * flood cost the water no extra samplers (its fragment stage is near WebGPU's 16).
 */
export function makeSdfTexture(sdf: SdfField): THREE.DataTexture {
  const halfs = new Uint16Array(sdf.size * sdf.size * 4);
  for (let i = 0; i < sdf.size * sdf.size; i++) halfs[i * 4] = THREE.DataUtils.toHalfFloat(sdf.data[i]);
  const tex = new THREE.DataTexture(halfs, sdf.size, sdf.size, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Wakes: hulls under way (the raider fleet rowing in, a ship sailing to another edge, the corsair
 * crossing) leave foam on the sea, worked out in the contact foam below. Each slot is a hull:
 * `seaWakes` its middle and heading (x, z, cos, sin of the way its bow points), `seaWakeShape`
 * its strength (0: none), half-length and half-beam, in world units. Written by the pieces
 * (board/marks.ts); all zero in a base game, where they cost the sea nothing it can see.
 */
export const WAKE_SLOTS = 6;
export const seaWakes = uniformArray(Array.from({ length: WAKE_SLOTS }, () => new THREE.Vector4()), 'vec4');
export const seaWakeShape = uniformArray(Array.from({ length: WAKE_SLOTS }, () => new THREE.Vector4()), 'vec4');
/** 1 while any slot holds a wake: the sea skips the wakes altogether otherwise (a base game, a fleetless sea at rest). */
export const seaWakesOn = uniform(0);

/** Radial grid: dense near the island, sparse towards the horizon. */
function makeOceanGeometry(radius = 260, rings = 150, segments = 220): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(0, 0, 0);
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    const rad = radius * (Math.pow(t, 2.6) * 0.985 + t * 0.015);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2 + (r % 2) * (Math.PI / segments);
      pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    }
  }
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segments;
    const b0 = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const a = a0 + s, a1 = a0 + ((s + 1) % segments);
      const b = b0 + s, b1 = b0 + ((s + 1) % segments);
      if (r % 2 === 1) idx.push(a, a1, b, a1, b1, b);
      else idx.push(a, b1, b, a, a1, b1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * The sea floor's grid: fine (0.45 units) under the island and its shelf, where it shapes the
 * shallows and rises with the tiles, opening out to about 3 units towards its edges, which lie
 * deep under water nobody sees through. A fifth of the vertices of an even grid at that detail.
 */
function makeSeabedGeometry(half = 45): THREE.BufferGeometry {
  const side = [0];
  for (let x = 0; x < half; ) {
    x = Math.min(half, x + (x < 11 ? 0.45 : Math.min(3.2, 0.45 + (x - 11) * 0.12)));
    side.push(x);
  }
  const axis = [...side.slice(1).reverse().map((v) => -v), ...side];
  const W = axis.length;
  const pos = new Float32Array(W * W * 3);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) pos.set([axis[i], 0, axis[j]], (j * W + i) * 3);
  const idx: number[] = [];
  for (let j = 0; j + 1 < W; j++)
    for (let i = 0; i + 1 < W; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export class Ocean {
  mesh: THREE.Mesh;
  seabed: THREE.Mesh;
  sdfTex: THREE.DataTexture;
  normalTex: THREE.DataTexture;
  sunDir = uniform(new THREE.Vector3());
  /** Wave and ripple strength: 1 in fair weather, higher under a shower (set from Weather). */
  chop = uniform(1);
  /** Ambient daylight multiplier for the self-lit water body (dims at night). */
  daylight = uniform(1);
  /** Colour of the light on the scene at unit luminance (sun and sky), so the water warms at
   * golden hour and turns violet at dusk along with the land. */
  lightTint = uniform(new THREE.Color(1, 1, 1));
  /** Sun colour for the glitter (warm at golden hour, set from World). */
  sunColor = uniform(new THREE.Color(1.0, 0.95, 0.85));
  /** 0..1 how far the island has risen: no surf rings an island still under the sea. */
  shoreline = uniform(1);
  /**
   * 0..1 how far the floor under the island goes down with its sunken tiles. In play it does
   * (1), so a rising tile brings its own patch of sand; at the title it stays (0), and the island
   * waiting under the sea shows as a sandbank in clear shallow water.
   */
  bedFollow = uniform(1);
  /** Where that sandbank lies: the island's centre (x, z) and its radius. */
  bank = uniform(new THREE.Vector3(0, 0, 4));
  /** 0..1 rain on the sea (raindrop rings in the detail normals). */
  rain = uniform(0);
  /**
   * A face-down hex's fog parting (see board/fog.ts): its centre (x, z) and how far the fog over
   * it has cleared (0..1), ahead of the fog layer being redrawn without it.
   */
  fogClear = uniform(new THREE.Vector3(0, 0, 0));
  /** A found hex's land coming up under the sea: its centre (x, z) and how far (0..1). */
  shoaling = uniform(new THREE.Vector3(0, 0, 0));
  /**
   * A found hex's new coast, just broken the surface: its centre (x, z) and how unsettled its
   * surf still is (1 as it breaks through, easing to 0), so the foam round it gathers in uneven
   * patches rather than appearing at once as a clean white outline.
   */
  emerging = uniform(new THREE.Vector3(0, 0, 0));
  /**
   * A flood (see board/flood.ts): how high the sea has swelled over the coast it reaches (world
   * units at the waterline), and how hard the waves break over it (0..1).
   */
  surge = uniform(0);
  surgeWaves = uniform(0);
  /** Half-width of the square the SDF and the sea layers cover (the island's: see sdfExtent). */
  private extent: number;
  private extentU = uniform(14);
  private mirror: ReturnType<typeof reflector>;
  private emissiveMirror: Node<'vec3'>;
  private mirrorOn = false;
  /** The surface's shading on the full and the low tier (see surface() in the constructor). */
  private tiers: Record<'full' | 'low', { normalNode: Node<'vec3'>; colorNode: Node<'vec4'>; roughnessNode: Node<'float'>; emissivePlain: Node<'vec3'> }>;
  private low = false;
  private mirrorRefresh = 0;
  /** Strength of the sky in the mirror (follows the time of day's reflection level). */
  private skyGain = uniform(0.33);

  /** The GPU wave simulation, when running on WebGPU (World steps it each frame). */
  sim: OceanSim | null;

  constructor(opts: OceanOptions) {
    this.sim = opts.sim ?? null;
    this.sdfTex = makeSdfTexture(opts.sdf);
    this.normalTex = makeDetailNormalMap(opts.detail ?? undefined);
    this.sunDir.value.copy(opts.sunDir);
    this.extent = this.extentU.value = opts.sdf.extent;
    const extent = this.extentU;

    // The SDF and the sea layers beside it (fog, a flood's reach): see makeSdfTexture. Off the
    // grid it is open sea, far from land, with neither.
    const seaAt = (xz: Node<'vec2'>): Node<'vec4'> => {
      const uvv = xz.div(extent.mul(2)).add(0.5);
      const inside = uvv.x.greaterThan(0).and(uvv.x.lessThan(1)).and(uvv.y.greaterThan(0)).and(uvv.y.lessThan(1));
      const v = texture(this.sdfTex, uvv);
      return inside.select(v, vec4(extent, 0, 0, 0));
    };
    const sdfAt = (xz: Node<'vec2'>): Node<'float'> => seaAt(xz).r;
    // A flood: the sea swells over the coast it reaches, up past the cliff tops and some way
    // inland (to about 0.45 in, where the coastal corners' buildings stand), easing back to its
    // usual level a few units out; waves roll in on top of it, shoreward.
    const swellAt = (s: Node<'float'>, reach: Node<'float'>): Node<'float'> => this.surge.mul(reach).mul(smoothstep(-0.85, -0.3, s)).mul(smoothstep(3.6, 0.9, s));
    const surgeLift = (s: Node<'float'>, reach: Node<'float'>): Node<'float'> => {
      const swell = swellAt(s, reach);
      const rollers = sin(s.mul(7.5).add(time.mul(3.4))).mul(0.035).mul(this.surgeWaves).mul(reach).mul(smoothstep(-0.6, -0.1, s)).mul(smoothstep(2.5, 0.5, s));
      return swell.add(rollers);
    };

    // ------------------------------------------------------------------ water
    const mat = new THREE.MeshStandardNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = true;
    mat.metalness = 0;

    const chop = this.chop;
    const waveSum = (p: Node<'vec2'>, shore: Node<'float'>) => {
      let disp: Node<'vec3'> = vec3(0, 0, 0);
      let dx: Node<'float'> = float(0);
      let dz: Node<'float'> = float(0);
      for (const w of WAVES) {
        const k = (Math.PI * 2) / w.length;
        const omega = Math.sqrt(9.8 * k) * 0.35 * w.speed;
        const d = vec2(w.dir[0], w.dir[1]).normalize();
        const amp = float(w.amp).mul(shore).mul(chop);
        const phase = dot(d, p).mul(k).sub(time.mul(omega));
        const c = cos(phase);
        const s = sin(phase);
        disp = disp.add(vec3(d.x.mul(amp).mul(w.steep).mul(c), amp.mul(s), d.y.mul(amp).mul(w.steep).mul(c)));
        dx = dx.add(d.x.mul(k).mul(amp).mul(c));
        dz = dz.add(d.y.mul(k).mul(amp).mul(c));
      }
      return { disp, dx, dz };
    };

    mat.positionNode = Fn(() => {
      const p = positionLocal.xz;
      const sea = seaAt(p);
      const s = sea.r;
      const shore = smoothstep(-0.05, 2.2, s).mul(0.85).add(0.15);
      const { disp } = waveSum(p, shore);
      return vec3(p.x.add(disp.x), float(SEA_LEVEL).add(disp.y).add(surgeLift(s, sea.b)), p.y.add(disp.z));
    })();

    const seaF = seaAt(positionWorld.xz);
    const sdfF = seaF.r;
    // Fog over face-down hexes, less where one is parting (its whole hex, softly edged).
    const fogF = seaF.g.mul(this.fogClear.z.mul(smoothstep(1.3, 0.65, positionWorld.xz.sub(this.fogClear.xy).length())).oneMinus());
    const reachF = seaF.b;
    // Where a flood's swell stands over the coast: the usual surf at the old waterline goes under
    // it (it would trace the coastline in white across the raised water).
    const swellF = swellAt(sdfF, reachF);
    const underSurge = smoothstep(0.03, 0.16, swellF);
    // Floodwater is muddy: where the swell stands over the coast (and in a plume a little out
    // from it) the water turns silty and opaque, so what it has drowned (piers, cliffs, the
    // posts of the harbour signs) is lost in it rather than seen sharply through clear water,
    // where it read as pale ghosts of itself.
    // (A plume of it, not the whole sea: it thins out a couple of units off the coast, raggedly: see silt.)
    const silted = smoothstep(0.02, 0.22, swellF).mul(smoothstep(3.0, 0.5, sdfF));
    // Wherever the swell has raised the surface at all (see the mirror's amount).
    const raised = smoothstep(0.01, 0.1, swellF);
    // Where land is coming up under the sea (see shoaling): over its hex, softly edged, the edge
    // pushed in and out by a slow noise so it is a stain of shallow water and not a drawn circle.
    // (The noise only while land is coming up: a uniform, so the whole frame takes one branch.)
    const shoalF = Fn(() => {
      const v = float(0).toVar();
      If(this.shoaling.z.greaterThan(0.001), () => {
        const p = positionWorld.xz;
        const warp = mx_noise_float(vec3(p.mul(2.3), time.mul(0.25))).mul(0.2);
        v.assign(this.shoaling.z.mul(smoothstep(1.05, 0.45, p.sub(this.shoaling.xy).length().add(warp))));
      });
      return v;
    })();
    const shoreF = smoothstep(-0.05, 2.2, sdfF).mul(0.85).add(0.15);
    const waveN = waveSum(positionWorld.xz, shoreF);

    const rainLevel = this.rain;
    const rainRings = (p: Node<'vec2'>) => sharedRainRings(p, rainLevel);

    // Detail normals (fallback sea): scrolling samples of a tiled normal map.
    const detail = Fn(() => {
      const p = positionWorld.xz;
      const n1 = texture(this.normalTex, p.mul(0.23).add(vec2(time.mul(0.018), time.mul(0.011)))).xyz.mul(2).sub(1);
      // The middle octave is rotated so the three samples never line up into a visible grid.
      const pr = vec2(p.x.mul(0.8).sub(p.y.mul(0.6)), p.x.mul(0.6).add(p.y.mul(0.8)));
      const n2 = texture(this.normalTex, pr.mul(0.61).add(vec2(time.mul(-0.021), time.mul(0.016)))).xyz.mul(2).sub(1);
      const n3 = texture(this.normalTex, p.mul(1.7).add(vec2(time.mul(0.03), time.mul(-0.027)))).xyz.mul(2).sub(1);
      return n1.xy.add(n2.xy.mul(0.7)).add(n3.xy.mul(0.35)).add(rainRings(p));
    })();

    // Far water: fine ripples fade out and the surface turns a little rougher, so at grazing
    // angles it reads as a softly glinting sea rather than a repeating white texture.
    const farFade = smoothstep(7, 32, cameraPosition.sub(positionWorld).length());
    const fft = opts.sim?.cascades ?? null;
    const scale = 1 / METRES_PER_UNIT;
    // Each cascade is turned to its own angle so their repeats never line up, and sampled
    // in that frame: vectors and the Jacobian tensor are rotated back to world axes.
    const ROT = [0, 0.83, 2.27];
    const rot = (c: number) => ({ cs: Math.cos(ROT[c]), sn: Math.sin(ROT[c]) });
    const uvOf = (p: Node<'vec2'>, c: number) => {
      const { cs, sn } = rot(c);
      return vec2(p.x.mul(cs).sub(p.y.mul(sn)), p.x.mul(sn).add(p.y.mul(cs))).div(fft![c].size);
    };
    const back = (v: Node<'vec2'>, c: number) => {
      const { cs, sn } = rot(c);
      return vec2(v.x.mul(cs).add(v.y.mul(sn)), v.x.mul(-sn).add(v.y.mul(cs)));
    };
    if (fft) {
      // Vertices: the two larger cascades (the finest only adds shading detail). Sampled at a
      // mip matched to the vertex spacing, which grows with distance.
      mat.positionNode = Fn(() => {
        const p = positionLocal.xz;
        const sea = seaAt(p);
        const shore = smoothstep(-0.05, 2.2, sea.r).mul(0.85).add(0.15);
        const dist = cameraPosition.sub(vec3(p.x, SEA_LEVEL, p.y)).length();
        const d = vec3(0, 0, 0).toVar();
        for (let c = 0; c < 2; c++) {
          const texel = fft[c].size / SIM_N;
          const lod = log2(max(dist.mul(0.003).div(texel), 1));
          const s = texture(fft[c].disp, uvOf(p, c)).level(lod);
          const h = back(s.xz, c);
          d.addAssign(vec3(h.x, s.y, h.y));
        }
        const k = shore.mul(chop).mul(scale);
        return vec3(p.x.add(d.x.mul(k)), float(SEA_LEVEL).add(d.y.mul(k)).add(surgeLift(sea.r, sea.b)), p.y.add(d.z.mul(k)));
      })();
    }

    // Water body colour: refraction tinted by depth (derived from distance to the island).
    // True water thickness along the view ray (scene depth behind the surface minus the
    // surface itself), so rocks, piers and the seabed shape the colour and the foam.
    const thickness = Fn(() => {
      const sceneZ = perspectiveDepthToViewZ(seaDepth, cameraNear, cameraFar);
      return positionView.z.sub(sceneZ).max(0);
    })();
    const foamColor = vec3(0.95, 0.97, 0.96);
    const night = vec3(0.05, 0.09, 0.2);
    // Under a passing cloud the glitter goes out and the water dulls a little.
    const shade = cloudShadeHere;

    /**
     * The surface's shading: on the full tier three wave cascades with wind gusts, whitecaps
     * broken into lace and layered coastal foam; on the low tier (the Low preset) the two
     * larger cascades with a tiled ripple map for the finest waves, and plainer foam.
     */
    const surface = (low: boolean) => {
      // Far water: fine ripples fade out and the surface turns a little rougher, so at grazing
      // angles it reads as a softly glinting sea rather than a repeating white texture.
      let worldNormal: Node<'vec3'> = Fn(() => {
        // Large slow patches of calmer and choppier water break up the tiling.
        const patch = mx_noise_float(vec3(positionWorld.xz.mul(0.06), time.mul(0.015))).mul(0.35).add(0.9);
        const nd = detail.mul(0.32).mul(chop.mul(0.5).add(0.5)).mul(patch).mul(mix(float(1), float(0.3), farFade));
        const n = normalize(vec3(waveN.dx.negate().add(nd.x), 1, waveN.dz.negate().add(nd.y)));
        return n;
      })();
      /** Screen-space shift for the refraction behind the surface. */
      let refractShift: Node<'vec2'> = detail.mul(0.012);
      /** Whitecaps on breaking crests (FFT sea only). */
      let whitecap: Node<'float'> = float(0);
      /** Surface slope that ripples the mirror reflection (smoother than the shading normal). */
      let mirrorSlope: Node<'vec2'> = worldNormal.xz;
      /** The longest waves' normal alone: the swell, without the ripples or the gusts' patches. */
      let swellNormal: Node<'vec3'> = worldNormal;

      if (fft) {
        // Fragments: slopes and the surface Jacobian summed over the cascades. Wind gusts
        // ("cat's paws") make patches where the short ripples are stronger or calmer.
        const p = positionWorld.xz;
        let gust: Node<'float'> = float(1);
        if (!low) {
          const gustN = mx_noise_float(vec3(p.mul(0.045), time.mul(0.012))).mul(0.5).add(0.5);
          // Round the island the patches are the land's own gusts, so you can watch one cross the
          // water and run on over the grass.
          const near = smoothstep(18, 9, p.length());
          gust = mix(float(0.45), float(1.3), mix(smoothstep(0.32, 0.72, gustN), windGust(p), near));
        }
        const amp = shoreF.mul(chop);
        let slope: Node<'vec2'> = vec2(0, 0);
        let broad: Node<'vec2'> = vec2(0, 0);
        let longest: Node<'vec2'> = vec2(0, 0);
        let jxx: Node<'float'> = float(0), jzz: Node<'float'> = float(0), jxz: Node<'float'> = float(0);
        let persistent: Node<'float'> = float(0);
        const count = low ? 2 : fft.length;
        for (let c = 0; c < count; c++) {
          const uv = uvOf(p, c);
          const dv = texture(fft[c].deriv, uv);
          // Foam texture: (persistent foam, J, jxz, fresh foam); the displacement texture stays
          // vertex-only, which keeps the fragment stage within WebGPU's 16 sampled textures.
          const fv = texture(fft[c].foam, uv);
          const a = fv.z;
          // (On Low there are no gusts: a mix of two constants would be an abstract-float
          // expression outside a constant, which Firefox's shader compiler rejects.)
          const gk = c === 0 || low ? amp : c === 1 ? amp.mul(mix(float(1), gust, 0.5)) : amp.mul(gust);
          slope = slope.add(back(dv.xy, c).mul(gk));
          if (c < 2) broad = broad.add(back(dv.xy, c).mul(gk));
          if (c === 0) longest = back(dv.xy, c).mul(gk);
          const { cs, sn } = rot(c);
          // R^T M R for the symmetric tensor [[jxx, jxz], [jxz, jzz]].
          jxx = jxx.add(dv.z.mul(cs * cs).add(a.mul(2 * cs * sn)).add(dv.w.mul(sn * sn)).mul(gk));
          jxz = jxz.add(dv.z.mul(-cs * sn).add(a.mul(cs * cs - sn * sn)).add(dv.w.mul(cs * sn)).mul(gk));
          jzz = jzz.add(dv.z.mul(sn * sn).sub(a.mul(2 * cs * sn)).add(dv.w.mul(cs * cs)).mul(gk));
          if (c < 2) persistent = persistent.add(fv.x.mul(c === 0 ? 1 : 0.55));
        }
        if (low) {
          // The finest waves from the tiled ripple map instead of their own cascade.
          const fine = texture(this.normalTex, p.mul(1.7).add(vec2(time.mul(0.03), time.mul(-0.027)))).xy.mul(2).sub(1);
          slope = slope.add(fine.mul(amp).mul(0.09).mul(mix(float(1), float(0.3), farFade)));
        }
        const rings = rainRings(p);
        const jx = max(jxx.add(1), 0.15), jz = max(jzz.add(1), 0.15);
        const sl = vec2(slope.x.div(jx), slope.y.div(jz)).add(rings.mul(0.12));
        worldNormal = normalize(vec3(sl.x.negate(), 1, sl.y.negate()));
        refractShift = sl.mul(0.09);
        // The finest ripples would shred the mirror image into a saw-tooth; use the longer waves.
        mirrorSlope = broad.negate().mul(0.6);
        swellNormal = normalize(vec3(longest.x.negate(), 1, longest.y.negate()));
        // Whitecaps where the surface folds over, lingering as foam that breaks into lace.
        const J = jxx.add(1).mul(jzz.add(1)).sub(jxz.mul(jxz));
        const fresh = clamp(float(0.42).sub(J).mul(2.6), 0, 1);
        const cover = clamp(max(persistent.mul(0.85), fresh), 0, 1).mul(shoreF);
        // The lace noise only where there is foam cover to break up.
        whitecap = Fn(() => {
          const w = float(0).toVar();
          If(cover.greaterThan(0.02), () => {
            const coarse = mx_noise_float(vec3(p.mul(16), time.mul(0.25))).mul(0.5).add(0.5);
            const lace = low ? coarse : coarse.mul(0.6).add(mx_noise_float(vec3(p.mul(41), time.mul(0.4))).mul(0.5).add(0.5).mul(0.4));
            w.assign(smoothstep(cover.oneMinus().sub(0.12), cover.oneMinus().add(0.12), lace).mul(smoothstep(0.02, 0.35, cover)));
          });
          return w;
        })();
      }
      const normalNode = transformNormalToView(worldNormal);

      // Foam: contact line + bands rolling in towards the island. Real foam is a lacy network of
      // bubble walls with dark holes between, so the pattern is built from Worley cell edges
      // (F2 - F1) in a domain-warped space, at two scales, rather than from cell interiors.
      // (The low tier: one scale, unwarped and unbroken.)
      const foam = Fn(() => {
        const s = sdfF;
        // Only pay for the noise where foam can exist (a band around the coast).
        const out = float(0).toVar();
        If(s.lessThan(1.15).and(s.greaterThan(-0.12)), () => {
          const p = positionWorld.xz;
          const flow = vec2(time.mul(0.05), time.mul(-0.035));
          const q = low ? p : p.add(vec2(mx_noise_float(vec3(p.mul(2.1), time.mul(0.12))), mx_noise_float(vec3(p.mul(2.1).add(5.2), time.mul(0.12)))).mul(0.16));
          const cellA = mx_worley_noise_vec2(vec3(q.mul(6.5).add(flow.mul(3)), time.mul(0.16)));
          // Bubble walls are broken and uneven: fragment the cell edges with fine noise.
          const breakup = low ? float(0.7) : smoothstep(0.25, 0.75, mx_noise_float(vec3(p.mul(9), time.mul(0.4))).mul(0.5).add(0.5));
          const lace = smoothstep(0.1, 0.015, cellA.y.sub(cellA.x)).mul(breakup.mul(0.7).add(0.3));
          let fine: Node<'float'> = lace.mul(0.6);
          if (!low) {
            const cellB = mx_worley_noise_vec2(vec3(q.mul(17).sub(flow.mul(5)), time.mul(0.3)));
            fine = smoothstep(0.08, 0.01, cellB.y.sub(cellB.x)).mul(breakup);
          }
          // Patchy coverage so foam gathers in drifts instead of covering everything evenly.
          const cover = smoothstep(-0.15, 0.5, mx_noise_float(vec3(p.mul(0.9), time.mul(0.05))));
          const warp = surfWarp(p);
          // Thick surf against the cliffs: solid at the rock, opening into lace further out.
          const contact = smoothstep(0.36, 0.03, s.add(warp.mul(0.07)));
          const solid = smoothstep(0.13, 0.0, s.add(warp.mul(0.04)));
          const surf = contact.mul(max(solid, lace.mul(0.7).add(fine.mul(0.45)).mul(cover.mul(0.5).add(0.5))));
          // Wave fronts rolling in and breaking.
          const bandPhase = surfPhase(s, warp);
          const crest = smoothstep(0.0, 0.05, bandPhase).mul(smoothstep(0.3, 0.07, bandPhase));
          const bands = crest.mul(smoothstep(0.6, 0.08, s)).mul(lace.mul(0.55).add(fine.mul(0.25)).add(0.25)).mul(1.0);
          // Wispy lace drifting away from the coast.
          const trails = lace.mul(fine.mul(0.6).add(0.4)).mul(cover).mul(smoothstep(0.8, 0.15, s)).mul(0.55);
          const f = max(surf, max(bands, trails));
          // Inside the island's footprint the water only shows while tiles rise through it;
          // there, foam comes from the depth-based contact ring instead of the shoreline.
          out.assign(clamp(f, 0, 1).mul(smoothstep(-0.12, -0.02, s)).mul(this.shoreline).mul(underSurge.oneMinus()));
        });
        return out;
      })();

      const body = Fn(() => {
        const s = sdfF;
        const depthApprox = smoothstep(-0.02, 1.6, s);
        // Optical depth: mostly the real water thickness, nudged by distance from the island.
        const optical = thickness.mul(0.9).add(depthApprox.mul(0.6));
        const deep = vec3(0.01, 0.085, 0.16);
        const mid = vec3(0.016, 0.22, 0.31);
        const shallow = vec3(0.06, 0.4, 0.42);
        const tint = mix(shallow, mix(mid, deep, smoothstep(0.5, 1.6, optical)), smoothstep(0.05, 0.6, optical));
        // (Less under a flood's swell, the deeper it stands: the scene behind a raised surface is
        // further below it, and the same shift would drag what lies there up into long smears.)
        const offset = refractShift.mul(depthApprox.oneMinus().mul(0.7).add(0.3)).mul(smoothstep(0.0, 0.08, thickness)).div(swellF.mul(8).add(1));
        const refr = viewportSharedTexture(seaSafeUV(screenUV.add(offset))).rgb;
        // Beer–Lambert style absorption: red fades first, then green.
        const absorb = exp(vec3(2.6, 0.9, 0.55).mul(optical).negate());
        // The silt churned up by the flood: ochre-brown off the land, greener where it thins out to
        // sea, in swirls drawn out along the swell's run, thicker and thinner by turns, and its
        // edge out at sea a ragged plume rather than a line round the coast (the noise only where
        // the flood reaches). w: how thick it is.
        const silt = Fn(() => {
          const c = vec4(0, 0, 0, 0).toVar();
          If(silted.greaterThan(0.001), () => {
            const p = positionWorld.xz;
            const swirl = mx_noise_float(vec3(p.mul(1.7).add(vec2(sdfF.mul(1.2), 0)), time.mul(0.35))).mul(0.5).add(0.5);
            const fine = mx_noise_float(vec3(p.mul(6.3), time.mul(0.6))).mul(0.5).add(0.5);
            const mud = mix(vec3(0.1, 0.066, 0.03), vec3(0.19, 0.14, 0.072), swirl.mul(0.7).add(fine.mul(0.3)));
            const plume = smoothstep(2.9, 0.2, sdfF.add(swirl.sub(0.5).mul(2.2)));
            c.assign(vec4(mix(mud, vec3(0.1, 0.16, 0.13), smoothstep(0.5, 1.9, sdfF)), plume.mul(swirl.mul(0.4).add(0.6))));
          });
          return c;
        })();
        // (Thinning to clear at the flood's edge, where it runs only a film over the ground, so its
        // waterline on the land is a soft wet margin rather than a cut.)
        // (Over the land only: against a cliff the water is just as thin, and a clear band there
        // would trace the coast.)
        const muddy = silted.mul(silt.w).mul(mix(float(1), smoothstep(0.004, 0.07, thickness), smoothstep(0.04, -0.12, sdfF)));
        const clarity = exp(optical.mul(-1.6)).mul(muddy.mul(0.92).oneMinus());
        const clear = mix(tint, refr.mul(absorb).mul(vec3(0.82, 0.97, 0.98)).add(tint.mul(0.25)), clarity.mul(0.9));
        const col = mix(clear, silt.xyz, muddy.mul(0.85));
        // Subsurface lift on the sunlit side of wave crests.
        const view = normalize(cameraPosition.sub(positionWorld));
        const sss = pow(max(dot(view, this.sunDir.negate().add(vec3(0, 0.6, 0)).normalize()), 0), 4).mul(0.18);
        const lifted = col.add(vec3(0.05, 0.28, 0.25).mul(sss).mul(smoothstep(0.0, 0.08, positionWorld.y.sub(SEA_LEVEL - 0.02))));
        // The swell seen from above. From the game's steep view the sky's reflection is a few
        // percent of the light off the water, so the waves' pattern, which lives in it, all but
        // vanished: open water read as a flat blue. So the water's own light follows the waves too:
        // a facet turned towards the sun catches more of it and one turned away less (the longest
        // waves for the pattern, a little of all of them for texture and the gusts' patches, both
        // softer far off, where they would only shimmer). (Tinting the crests by their height
        // instead, as thinner water, drew the swell's long rises as pale blotches across the sea.)
        const swellLit = dot(swellNormal, this.sunDir);
        const facet = swellLit.sub(this.sunDir.y).add(dot(worldNormal, this.sunDir).sub(swellLit).mul(0.4)).mul(mix(float(1.8), float(0.7), farFade));
        const waved = lifted.mul(facet.add(1).max(0));
        // Under the fog the water is a dull, flat slate that keeps only a trace of the sea's green,
        // in the bank's shade, so the face-down hexes read as an unknown stretch with an edge (and
        // the bank has weight from above), rather than open water.
        const murk = vec3(0.026, 0.04, 0.05).add(vec3(luminance(lifted)).mul(vec3(0.4, 0.45, 0.5)));
        // Over land coming up out of the sea the water pales to the shallows' green.
        const pale = mix(waved, waved.mul(0.5).add(vec3(0.05, 0.34, 0.36)), shoalF.mul(0.7));
        return mix(pale, murk, fogF.mul(0.82));
      })();

      // Foam where anything pierces the surface: cliffs, boulders, pier posts, moored boats, and
      // the wakes of hulls under way.
      const contactFoam = Fn(() => {
        const out = float(0).toVar();
        const facing = smoothstep(0.1, 0.4, max(dot(vec3(0, 1, 0), normalize(cameraPosition.sub(positionWorld))), 0));
        If(thickness.lessThan(0.07), () => {
          const p = positionWorld.xz;
          const lace = smoothstep(0.35, 0.62, mx_worley_noise_float(vec3(p.mul(18), time.mul(0.5))));
          // Ragged rather than a clean rim, and faded where the view grazes the surface (screen-space
          // thickness would otherwise drag it down the rock as a hard white skirt).
          const ragged = low ? thickness : thickness.add(mx_noise_float(vec3(p.mul(24), time.mul(0.3))).mul(0.03));
          out.assign(smoothstep(0.07, 0.0, ragged).mul(lace.mul(0.5).add(0.5)).mul(facing));
        });
        // Wakes (see seaWakes): in each hull's frame, s is how far aft of its bow and q how far to
        // the side. Two arms spread from the bow at the wake's angle (about 19.5 degrees: tan 0.35)
        // and widen as they go, a churned wash runs straight back from the stern, and the oars'
        // splashes line its sides; all of it fades over a few hull lengths. Plain arithmetic for
        // every slot, and the lace only where some wake reaches (the sea's noise runs on its mask).
        const wake = float(0).toVar();
        const flowS = float(0).toVar();
        const flowQ = float(0).toVar();
        If(seaWakesOn.greaterThan(0.5), () => {
          for (let i = 0; i < WAKE_SLOTS; i++) {
            const w = seaWakes.element(i) as unknown as Node<'vec4'>, shape = seaWakeShape.element(i) as unknown as Node<'vec4'>;
            const d = positionWorld.xz.sub(w.xy);
            const half = shape.y, beam = shape.z;
            const s = half.sub(d.x.mul(w.z).add(d.y.mul(w.w)));
            const q = abs(d.y.mul(w.z).sub(d.x.mul(w.w)));
            // (Four and a half half-lengths: long enough to say which way it rows, short enough that the
            // arms read as water churned behind it rather than lines ruled across the sea.)
            const len = half.mul(4.5);
            const fade = smoothstep(len, half.mul(0.5), s).mul(smoothstep(-0.02, 0.06, s));
            const arm = abs(q.sub(beam.mul(0.9).add(s.mul(0.35))));
            const armW = beam.mul(0.45).add(s.mul(0.06));
            const arms = smoothstep(armW, armW.mul(0.1), arm).mul(0.55);
            const aft = s.sub(half.mul(2));
            const wash = smoothstep(beam.mul(1.1).add(aft.max(0).mul(0.12)), beam.mul(0.2), q).mul(smoothstep(-0.05, 0.15, aft)).mul(smoothstep(half.mul(5), half.mul(0.4), aft));
            const here = max(arms, wash).mul(fade).mul(shape.x);
            const stronger = here.greaterThan(wake);
            flowS.assign(stronger.select(s, flowS));
            // (Across an arm, its streaks run along the arm rather than straight aft.)
            flowQ.assign(stronger.select(arms.greaterThan(wash).select(arm, q), flowQ));
            wake.assign(max(wake, here));
          }
        });
        If(wake.greaterThan(0.01), () => {
          // (Streaming aft with the hull's way on it, in the hull's own frame.)
          // (Foam streaks drawn out along the way it goes, finer across it.)
          const lace = smoothstep(0.15, 0.75, mx_worley_noise_float(vec3(flowS.mul(3.5).sub(time.mul(0.7)), flowQ.mul(30), time.mul(0.3))));
          const fine = mx_noise_float(vec3(flowS.mul(18).sub(time.mul(1.8)), flowQ.mul(60), time.mul(0.6))).mul(0.5).add(0.5);
          out.assign(max(out, wake.mul(lace.mul(0.5).add(fine.mul(0.3)).add(0.2)).min(1).mul(facing)));
        });
        return out;
      })();

      // Schlick Fresnel: grazing angles reflect the sky instead of showing the water body.
      const fresnel = Fn(() => {
        const view = normalize(cameraPosition.sub(positionWorld));
        const ndv = max(dot(worldNormal, view), 0);
        return float(0.02).add(float(0.98).mul(pow(float(1).sub(ndv), 5)));
      })();
      // Shoal breaks under the fog: now and then the swell stands up and breaks white over
      // something just under the surface, a short crest rolling on downwind and leaving foam
      // behind it as it fades. Every face-down hex shows them, land or sea, so they hint at what
      // might be there without telling.
      const shoal = Fn(() => {
        const out = float(0).toVar();
        If(fogF.greaterThan(0.02), () => {
          const p = positionWorld.xz;
          const q = p.mul(1.1);
          const cell = floor(q);
          const h = fract(sin(dot(cell, vec2(127.1, 311.7))).mul(43758.5453));
          const h2 = fract(h.mul(13.37));
          const h3 = fract(h.mul(71.13));
          const rel = q.sub(cell.add(vec2(h, h2).mul(0.5).add(0.25))).div(1.1);
          const u = dot(rel, windDir);
          const v = dot(rel, vec2(windDir.y.negate(), windDir.x));
          // Seconds since this cell's last break (every 7 to 12 s).
          const period = h3.mul(5).add(7);
          const age = fract(time.div(period).add(h.mul(3.1))).mul(period);
          const front = age.mul(0.1).sub(0.06);
          const width = smoothstep(0.24, 0.04, abs(v).add(age.mul(0.012)));
          const crest = smoothstep(0.045, 0.0, abs(u.sub(front))).mul(smoothstep(0.0, 0.3, age)).mul(exp(age.mul(-0.75)));
          const trail = smoothstep(0.0, -0.05, u.sub(front)).mul(smoothstep(-0.32, -0.08, u.sub(front))).mul(exp(age.mul(-1.1))).mul(0.55);
          // Broken into lumps of foam rather than a clean line.
          const lumps = smoothstep(-0.2, 0.5, mx_noise_float(vec3(p.mul(11), time.mul(0.6))));
          out.assign(max(crest, trail).mul(width).mul(lumps).mul(smoothstep(0.33, 0.37, h3)).mul(smoothstep(0.1, 0.6, fogF)));
        });
        return out;
      })();
      // A flood's white water: rollers coming in on the swell out over the sea, and where the swollen
      // sea runs shallow over the land (by its real depth over the ground, as the contact foam is)
      // churned white in broken, feathered patches, not along any line of the board's.
      const surgeFoam = Fn(() => {
        const out = float(0).toVar();
        If(this.surgeWaves.greaterThan(0.005), () => {
          const p = positionWorld.xz;
          const s = sdfF;
          const warp = surfWarp(p);
          const phase = fract(s.mul(1.4).add(time.mul(0.6)).add(warp.mul(0.6)));
          const stretch = smoothstep(0.4, 0.75, mx_noise_float(vec3(p.mul(1.3), time.mul(0.15))).mul(0.5).add(0.5));
          const front = smoothstep(0.0, 0.05, phase).mul(smoothstep(0.28, 0.06, phase)).mul(smoothstep(2.6, 0.6, s)).mul(smoothstep(0.2, 0.7, s)).mul(stretch);
          const foamy = mx_noise_float(vec3(p.mul(6.5), time.mul(0.6))).mul(0.5).add(0.5).add(mx_noise_float(vec3(p.mul(17), time.mul(0.9))).mul(0.2));
          const lumps = smoothstep(0.45, 0.8, foamy);
          const shallow = smoothstep(0.13, 0.015, thickness.add(foamy.sub(0.5).mul(0.06))).mul(smoothstep(0.5, -0.05, s));
          out.assign(clamp(max(front.mul(lumps.mul(0.8).add(0.2)), shallow.mul(lumps).mul(0.85)).mul(reachF).mul(this.surgeWaves), 0, 1));
        });
        return out;
      })();
      // The sea boiling over the land coming up: churned lace and bubbles, thickest in the middle.
      const boil = Fn(() => {
        const out = float(0).toVar();
        If(shoalF.greaterThan(0.01), () => {
          const p = positionWorld.xz;
          // Patches of churned white water welling up and spreading, and fine bubbles in them.
          const churn = smoothstep(0.15, 0.6, mx_noise_float(vec3(p.mul(3.4), time.mul(1.1))).add(mx_noise_float(vec3(p.mul(9), time.mul(1.7))).mul(0.35)));
          const bubbles = smoothstep(0.55, 0.8, mx_noise_float(vec3(p.mul(26), time.mul(2.6))));
          out.assign(max(churn.mul(0.55), bubbles.mul(churn.mul(0.6).add(0.25))).mul(shoalF));
        });
        return out;
      })();
      // Round a coast that has only just broken the surface, its surf and the foam at its walls
      // gather in broken patches that grow until they join (see emerging).
      const settled = Fn(() => {
        const out = float(1).toVar();
        const near = this.emerging.z.mul(smoothstep(1.55, 1.05, positionWorld.xz.sub(this.emerging.xy).length()));
        If(near.greaterThan(0.01), () => {
          const p = positionWorld.xz;
          const n = mx_noise_float(vec3(p.mul(4.2), time.mul(0.7))).mul(0.5).add(0.5).add(mx_noise_float(vec3(p.mul(13), time.mul(1.3))).mul(0.18));
          out.assign(mix(float(1), smoothstep(near.mul(0.75).sub(0.05), near.mul(0.75).add(0.18), n), near));
        });
        return out;
      })();
      const foamAll = max(max(max(foam, contactFoam).mul(settled), whitecap), max(max(shoal, surgeFoam), boil));
      // Sun glitter on the wave facets; at night the moon's, in a broader path of glitter.
      const glint = Fn(() => {
        const view = normalize(cameraPosition.sub(positionWorld));
        const r = reflect(view.negate(), worldNormal);
        // Tighter sparkles close by, a broader sheen of glitter further out.
        const sharp = mix(float(520), float(140), farFade).mul(mix(float(1), float(0.35), moonGlow));
        return pow(max(dot(r, this.sunDir), 0), sharp).mul(mix(float(3.2), float(1.4), farFade));
      })();
      const lit = mix(body.mul(night.mul(1.1)), body, this.daylight).mul(mix(float(1), shade, 0.35)).mul(mix(vec3(1, 1, 1), this.lightTint, 0.5));
      const sparkle = this.sunColor.mul(glint).mul(max(this.daylight, moonGlow.mul(0.45))).mul(foamAll.oneMinus()).mul(shade);
      // Without the mirror, the sky reflection comes from the environment map (specular IBL).
      const emissivePlain = lit.mul(fresnel.oneMinus()).mul(foamAll.oneMinus()).add(sparkle);
      return {
        normalNode,
        colorNode: vec4(foamColor.mul(foamAll), 1),
        // (A flood's silty water a little duller too: see the mirror's amount below.)
        roughnessNode: mix(max(mix(float(0.05), float(0.2), farFade), silted.mul(0.3)), float(0.75), foamAll),
        emissivePlain,
        mirrorSlope,
        mirrored: (mirror: ReturnType<typeof reflector>) => {
          // With the mirror: a mirror of the scene (island, cliffs, boats, piers, badges, sky)
          // rendered from below the sea plane, rippled by the wave normals and blended in by
          // Fresnel, with a floor so the cliffs still mirror near the shore from the game's steep view.
          const rippled = mirror.uvNode!.add(mirrorSlope.mul(0.055));
          mirror.uvNode = rippled;
          const mirrorDepth = mirror.getDepthNode();
          mirrorDepth.uvNode = rippled;
          // Objects (cliffs, boats, piers, badges, distant islands) mirror strongly; the sky only at
          // the level the environment reflection had, so bright clouds don't wash out the sea.
          const sky = mirrorDepth.r.greaterThan(0.99999);
          const reflected = sky.select(mirror.rgb.mul(this.skyGain), mirror.rgb.mul(vec3(0.8, 0.9, 0.96)));
          // (Fog-bound water mirrors little: the mist overhead is what it would show.)
          // (Nor does a flood's swell mirror the scene: the mirror is taken about the usual sea
          // level, so over the raised water it would hang what stands on the coast below it.)
          // Its silt dulls the sky in it too, so seen low across it the flood stays brown, not milky.
          const amount = sky.select(fresnel.mul(0.6).mul(silted.mul(0.45).oneMinus()), mix(float(0.2), float(0.72), fresnel).mul(raised.oneMinus())).mul(fogF.mul(0.6).oneMinus());
          return mix(lit, reflected, amount).mul(foamAll.oneMinus()).add(sparkle);
        },
      };
    };

    const full = surface(false);
    this.tiers = { full, low: fft ? surface(true) : full };
    this.mirror = reflector({ resolutionScale: 0.5, bounces: false, depth: true });
    this.mirror.target.rotation.x = -Math.PI / 2;
    this.mirror.target.position.y = SEA_LEVEL;
    this.mirror.target.updateMatrixWorld();
    const base = this.mirror.reflector as unknown as { getVirtualCamera(c: THREE.Camera): THREE.Camera; updateBefore(frame: { camera?: THREE.Camera }): unknown };
    const virtualCamera = base.getVirtualCamera.bind(base);
    base.getVirtualCamera = (c) => {
      const v = virtualCamera(c);
      v.layers.disable(DETAIL_LAYER);
      return v;
    };
    // Shadows don't depend on the view: reuse this frame's shadow map instead of rendering it again.
    // Except for the first frames after the mirror is (re)enabled: if the shadow map was resized
    // meanwhile (a quality change), the mirror's bindings must pick up the new map first.
    // While the camera holds still the mirror is redrawn every other frame: what it shows moves
    // slowly, and the ripples that break it up are the sea's own, drawn every frame.
    const renderMirror = base.updateBefore.bind(base);
    const lastView = new THREE.Matrix4();
    base.updateBefore = (frame) => {
      if (this.mirrorRefresh > 0) {
        this.mirrorRefresh--;
        return renderMirror(frame);
      }
      const cam = frame.camera;
      // (A dry frame clears the mirror without drawing it: the next real one must redraw it.)
      if (frameState.dry) lastView.identity();
      else if (cam) {
        // (Still within a hair: the camera's easing creeps on by tiny amounts long after it stops.)
        const m = cam.matrixWorld.elements, l = lastView.elements;
        let still = true;
        for (let i = 0; i < 16 && still; i++) still = Math.abs(m[i] - l[i]) < 1e-4;
        lastView.copy(cam.matrixWorld);
        if (still && frameState.frame % 2 === 1) return undefined;
      }
      const shadow = opts.sun.shadow;
      const auto = shadow.autoUpdate;
      shadow.autoUpdate = false;
      const r = renderMirror(frame);
      shadow.autoUpdate = auto;
      return r;
    };
    this.emissiveMirror = full.mirrored(this.mirror);
    const tier = this.tiers.full;
    mat.normalNode = tier.normalNode;
    mat.colorNode = tier.colorNode;
    mat.roughnessNode = tier.roughnessNode;
    mat.emissiveNode = tier.emissivePlain;
    mat.opacityNode = float(1);

    this.mesh = new THREE.Mesh(makeOceanGeometry(), mat);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    // Not in its own mirror: from below, the surface lies on the mirror's clipping plane, and
    // drawing it there would cost a second pass of the sea's shading and a copy of the mirror's
    // frame for its refraction, and bind the mirror's texture while it was being drawn into.
    this.mesh.layers.set(DETAIL_LAYER);

    // ----------------------------------------------------------------- seabed
    const bedGeo = makeSeabedGeometry();
    bedGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(bedGeo.getAttribute('position').count * 3), 3));
    bedGeo.setAttribute('aTile', new THREE.Float32BufferAttribute(new Float32Array(bedGeo.getAttribute('position').count), 1));
    bedGeo.setAttribute('aLift', new THREE.Float32BufferAttribute(new Float32Array(bedGeo.getAttribute('position').count), 1));
    this.shapeSeabed(bedGeo, opts.sdf, opts.tiles);
    const bedMat = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
    // The floor under the island travels with its tile, so a rising tile lifts its own patch of
    // sand instead of punching up through a fixed seabed.
    bedMat.positionNode = positionLocal.add(
      vec3(
        0,
        (opts.rise.element(int(attribute<'float'>('aTile', 'float'))) as unknown as Node<'float'>)
          .mul(this.bedFollow)
          .mul(attribute<'float'>('aLift', 'float'))
          // As a sandbank it swells a little higher towards its middle, in a rounded, uneven
          // mound (not the tiles' outline), so its sand shows through the shallows.
          .add(
            this.bedFollow
              .oneMinus()
              .mul(0.3)
              .mul(smoothstep(this.bank.z.add(0.4), this.bank.z.sub(2.4), positionLocal.xz.sub(this.bank.xy).length().add(mx_noise_float(vec3(positionLocal.xz.mul(0.55), 7)).mul(0.9)))),
          ),
        0,
      ),
    );
    // Wave-formed sand ripples (warped so they never look ruled) and darker weed patches. Only
    // near the island: further out the floor lies under metres of water that let nothing through.
    // (Worked out in a branch, but its slope is taken outside it, where derivatives are defined.)
    const ripple = Fn(() => {
      const p = positionWorld.xz;
      const r = float(0.5).toVar();
      If(sdfAt(p).lessThan(2.2), () => {
        const warp = mx_noise_float(vec3(p.mul(0.9), 0)).mul(2.2);
        const w = sin(p.x.mul(9).add(p.y.mul(5.5)).add(warp.mul(4)));
        r.assign(w.mul(0.5).add(0.5).pow(1.6).add(mx_noise_float(vec3(p.mul(6), 1)).mul(0.25)));
      });
      return r;
    })();
    bedMat.normalNode = bumpedNormal(ripple, 0.012);
    bedMat.colorNode = Fn(() => {
      const p = positionWorld.xz;
      // Past the shelf the floor lies 3.6 units down and the water lets about 0.2% of it
      // through, so its weed and pebbles are only worked out near the island.
      const patch = float(0).toVar();
      const pebbles = float(0).toVar();
      If(sdfAt(p).lessThan(2), () => {
        patch.assign(smoothstep(0.15, 0.55, mx_noise_float(vec3(p.mul(0.55), 2))));
        pebbles.assign(smoothstep(0.55, 0.75, mx_worley_noise_float(vec3(p.mul(7), 0)).oneMinus()));
      });
      // (Squared: the sand was tuned under three's second vertex-colour multiply.)
      const base = attribute<'vec3'>('color', 'vec3').mul(attribute<'vec3'>('color', 'vec3'));
      const weed = base.mul(vec3(0.55, 0.72, 0.5));
      const c = mix(base.mul(ripple.mul(0.18).add(0.88)), weed, patch.mul(0.6));
      return vec4(mix(c, c.mul(0.7), pebbles.mul(0.35)), 1);
    })();
    bedMat.emissiveNode = Fn(() => {
      const p = positionWorld.xz;
      const near = smoothstep(1.4, 0.0, sdfAt(p));
      // Caustics only show in the clear shallows; skip the two Worley lookups elsewhere.
      const out = vec3(0, 0, 0).toVar();
      If(near.greaterThan(0.001), () => {
        const w1 = mx_worley_noise_float(vec3(p.mul(3.2), time.mul(0.6)));
        const w2 = mx_worley_noise_float(vec3(p.mul(4.7).add(3.1), time.mul(0.75)));
        const caustic = pow(abs(w1.sub(w2)).oneMinus(), 9).mul(0.22);
        out.assign(vec3(1.0, 0.97, 0.85).mul(caustic).mul(near).mul(this.daylight));
      });
      return out;
    })();
    this.seabed = new THREE.Mesh(bedGeo, bedMat);
    this.seabed.receiveShadow = true;
    // Under the water plane, so never in the mirror (whose camera leaves this layer out).
    this.seabed.layers.set(DETAIL_LAYER);
  }

  private shapeSeabed(bedGeo: THREE.BufferGeometry, sdf: SdfField, tiles: SeabedTile[]) {
    const bp = bedGeo.getAttribute('position');
    const col = bedGeo.getAttribute('color');
    const tileAttr = bedGeo.getAttribute('aTile');
    const liftAttr = bedGeo.getAttribute('aLift');
    const sand = new THREE.Color('#b8a676');
    const deepSand = new THREE.Color('#3f5f5e');
    const c = new THREE.Color();
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i), z = bp.getZ(i);
      const s = sdf.sample(x, z);
      const shelf = THREE.MathUtils.smoothstep(s, 0.05, 1.8);
      bp.setY(i, SEA_LEVEL - 0.42 - shelf * 3.2 - Math.max(0, s - 6) * 0.15);
      c.copy(sand).lerp(deepSand, shelf);
      col.setXYZ(i, c.r, c.g, c.b);
      // Under the land and a short skirt beyond it, follow the nearest tile.
      const lift = 1 - THREE.MathUtils.smoothstep(s, 0.05, 0.6);
      let best = 0, bestD = Infinity;
      if (lift > 0) {
        for (const t of tiles) {
          const d = (t.x - x) ** 2 + (t.z - z) ** 2;
          if (d < bestD) (bestD = d), (best = t.id);
        }
      }
      tileAttr.setX(i, best);
      liftAttr.setX(i, lift);
    }
    bp.needsUpdate = true;
    col.needsUpdate = true;
    tileAttr.needsUpdate = true;
    liftAttr.needsUpdate = true;
    bedGeo.computeVertexNormals();
    bedGeo.computeBoundingSphere();
  }

  /**
   * Re-shape for a new island without rebuilding materials. (Rebuilding would leak:
   * three's viewport texture nodes allocate a screen-sized texture per material.)
   */
  /**
   * The sea reflects the sky environment at its own strength, independent of the (much
   * weaker) diffuse share the rest of the scene gets.
   */
  setReflections(env: THREE.Texture | null, intensity: number) {
    const mat = this.mesh.material as THREE.MeshStandardNodeMaterial;
    if (env && mat.envMap !== env) {
      mat.envMap = env;
      mat.needsUpdate = true;
    }
    // The mirror already carries the sky; the environment keeps half its strength for the
    // glossy sheen that shows the wave pattern from above.
    mat.envMapIntensity = intensity * (this.mirrorOn ? 0.5 : 1);
    this.skyGain.value = intensity * 1.1;
  }

  /**
   * Mirror reflections at `scale` of the screen resolution, or off (sky only) at 0; and the
   * sea's tier, `low` (by default the current preset's, see Stage): two of the three wave
   * cascades, plainer foam and no gust patches. (With the mirror on, the full tier is kept.)
   */
  setMirror(scale: number, low = frameState.seaLow) {
    this.mirrorOn = scale > 0;
    if (this.mirrorOn) {
      this.mirror.reflector.resolutionScale = scale;
      this.mirrorRefresh = 3;
    } else {
      // Its render targets (screen-sized, half-float, with depth) go back until it is used again.
      for (const target of (this.mirror.reflector as unknown as { renderTargets: Map<unknown, THREE.RenderTarget> }).renderTargets.values()) target.dispose();
    }
    this.low = low && !this.mirrorOn;
    this.sim?.setCascades(this.low ? 2 : 3);
    this.applyShading();
  }

  private applyShading() {
    const mat = this.mesh.material as THREE.MeshStandardNodeMaterial;
    const tier = this.low ? this.tiers.low : this.tiers.full;
    const emissive = this.mirrorOn ? this.emissiveMirror : tier.emissivePlain;
    if (mat.emissiveNode === emissive && mat.normalNode === tier.normalNode) return;
    mat.normalNode = tier.normalNode;
    mat.colorNode = tier.colorNode;
    mat.roughnessNode = tier.roughnessNode;
    mat.emissiveNode = emissive;
    mat.needsUpdate = true;
  }

  setIsland(sdf: SdfField, tiles: SeabedTile[]) {
    this.extent = this.extentU.value = sdf.extent;
    const data = this.sdfTex.image.data as Uint16Array;
    for (let i = 0; i < sdf.data.length; i++) data[i * 4] = THREE.DataUtils.toHalfFloat(sdf.data[i]);
    this.sdfTex.needsUpdate = true;
    this.shapeSeabed(this.seabed.geometry, sdf, tiles);
  }

  /**
   * Write one of the texture's sea layers (1 = fog, 2 = flood) from a field over the same grid
   * as the SDF (or clear it, with null). Fields are coarse and smooth, so linear filtering
   * between texels is all the softening they need.
   */
  setLayer(channel: 1 | 2, field: Float32Array | null) {
    const data = this.sdfTex.image.data as Uint16Array;
    const n = data.length / 4;
    const zero = THREE.DataUtils.toHalfFloat(0);
    for (let i = 0; i < n; i++) data[i * 4 + channel] = field ? THREE.DataUtils.toHalfFloat(field[i]) : zero;
    this.sdfTex.needsUpdate = true;
  }

  /** The grid the sea layers are drawn on: texels per side and the half-width they cover. */
  get layerGrid() {
    return { size: this.sdfTex.image.width as number, extent: this.extent };
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.seabed.geometry.dispose();
    (this.seabed.material as THREE.Material).dispose();
    this.sdfTex.dispose();
    this.normalTex.dispose();
    this.mirror.dispose();
    this.sim?.dispose();
  }
}

