// Renderer, scene, lighting, sky and post-processing.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { shareInstanceShaders } from './instanceShaders';
import { keepLastMatrices, shareInstanceBuilds } from './instanceBuilds';
import { keepNodeBuilds } from './buildCache';
import { setPrepassMRT, skipPrepassLighting } from './prepassLighting';
import { skipUnchangedUniformArrays } from './uniformUploads';
import { carryDisplacementToMotion } from './motionVectors';
import { ReprojectAANode } from './reprojectAA';
import { Frost } from './frost';
import { Bundles } from './bundles';
import { probedGpu } from './gpuProbe';
import {
  pass,
  mrt,
  output,
  normalView,
  vec2,
  vec3,
  vec4,
  float,
  uniform,
  uv,
  smoothstep,
  mix,
  length,
  clamp,
  pow,
  luminance,
  Fn,
  renderOutput,
  cdl,
  max,
  dot,
  normalize,
  positionWorld,
  cameraPosition,
  rangeFogFactor,
  fog,
  sample,
  screenUV,
  packNormalToRGB,
  unpackRGBToNormal,
  builtinAOContext,
  step,
  velocity,
  convertToTexture,
  min,
  int,
  If,
  Loop,
  ivec2,
  screenCoordinate,
  interleavedGradientNoise,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { DETAIL_LAYER, SEA_LEVEL } from '../board/layout';
import { setTerrainRings } from '../board/tiles';
import { setMrtRenderer } from '../util/mrt';
import { frameState } from '../util/frame';
import { IslandLighting } from '../fx/lampLights';
import { IslandSky } from '../env/sky';
import { cloudField } from '../env/clouds';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  pixelRatio: number;
  shadowMap: number;
  ao: boolean;
  /**
   * Ambient occlusion from an opaque prepass, applied inside lighting to indirect light only
   * (High, Ultra); without it (Medium) it is multiplied into the frame afterwards.
   */
  aoPrepass: boolean;
  dof: boolean;
  bloom: boolean;
  /**
   * Anti-aliasing, always temporal: three's TRAA (`taa`: from motion vectors, in HDR before the
   * depth of field and motion blur), or the island's lighter one (`reproject`: from depth and the
   * camera's motion, on the finished frame; see reprojectAA.ts), in place of SMAA (Medium) and
   * FXAA (Low): they smooth one frame's edges, and can't stop sub-pixel wheat, grass, fences and
   * glints sparkling and crawling as the camera moves.
   */
  aa: 'taa' | 'reproject';
  /** Camera motion blur (requires the velocity buffer). */
  motionBlur: boolean;
  /** Multiplier on grass / wheat / flower instance counts. */
  foliage: number;
  /**
   * How finely each tile's ground is built (rings of vertices, twice as many on a mountain; see
   * tiles.ts). The ground is most of the island's triangles, drawn again for the sun's shadow: a
   * phone's GPU on the lightest preset draws about two fifths fewer for a barely coarser ground.
   */
  terrainRings: number;
  /** Resolution scale of the sea's mirror reflection (0 = sky reflection only). */
  reflections: number;
  /** Lamps cast real light (clustered point lights; WebGPU only). */
  pointLights: boolean;
  /**
   * How far the resolution may go past the screen's own (supersampling), when the canvas is
   * small enough for it to stay within a 4K frame's pixels.
   */
  supersample: number;
  /** The sun's shadow map is re-rendered every this many frames. */
  shadowEvery: number;
  /** The sea's simpler tier: two wave cascades and plainer foam (see Ocean.setTier). */
  seaLow: boolean;
  /**
   * At most about 60 frames a second on a screen that refreshes faster (120 Hz phones and
   * laptops would otherwise draw twice the frames, for heat and battery rather than a look the
   * lighter presets have).
   */
  cap60: boolean;
  /**
   * The cap at 60 on a 90 Hz screen too (most Android phones' fast setting), two refreshes in
   * three: a little uneven, but a third fewer frames for a phone's GPU, which can't keep 90 up on
   * the lightest preset either. (Elsewhere such a screen is left to draw at its own rate.)
   */
  cap60At90: boolean;
  /**
   * The frame's own pixel ratio, up to the screen's, with the lighter temporal AA: the scene is
   * drawn at `pixelRatio` and the AA rebuilds the frame finer from the frames' nudged samples
   * (temporal super-resolution; see reprojectAA.ts), instead of the browser stretching it. No
   * finer than the scene where this is no larger.
   */
  displayRatio: number;
}

export const QUALITY: Record<Quality, QualitySettings> = {
  low: { pixelRatio: 1, shadowMap: 1024, ao: false, aoPrepass: false, dof: false, bloom: false, aa: 'reproject', motionBlur: false, foliage: 0.35, terrainRings: 28, reflections: 0, pointLights: false, supersample: 1, shadowEvery: 2, seaLow: true, cap60: true, cap60At90: true, displayRatio: 1 },
  medium: { pixelRatio: 1.25, shadowMap: 2048, ao: true, aoPrepass: false, dof: false, bloom: true, aa: 'reproject', motionBlur: false, foliage: 0.6, terrainRings: 36, reflections: 0, pointLights: false, supersample: 1, shadowEvery: 2, seaLow: false, cap60: true, cap60At90: false, displayRatio: 2 },
  high: { pixelRatio: 1.5, shadowMap: 4096, ao: true, aoPrepass: true, dof: true, bloom: true, aa: 'taa', motionBlur: true, foliage: 1, terrainRings: 36, reflections: 0.5, pointLights: true, supersample: 1, shadowEvery: 1, seaLow: false, cap60: false, cap60At90: false, displayRatio: 1 },
  ultra: { pixelRatio: 2, shadowMap: 4096, ao: true, aoPrepass: true, dof: true, bloom: true, aa: 'taa', motionBlur: true, foliage: 1.4, terrainRings: 36, reflections: 0.7, pointLights: true, supersample: 1.5, shadowEvery: 1, seaLow: false, cap60: false, cap60At90: false, displayRatio: 1 },
};

/**
 * Shadow blur radius in texels for a map size, so the soft edge is the same width in the world
 * on every preset (a fixed radius made it four times wider on Low than on High).
 */
const shadowRadius = (mapSize: number) => (3 * mapSize) / 4096;

/**
 * Contrast-adaptive sharpening (RCAS, from AMD's FSR 1) of the texel under the pixel: the temporal
 * AA blends each pixel with history gathered round it and softens the picture a little; this
 * gives the edges back, more where an edge is faint than where it is already strong, so nothing
 * rings. RCAS works on colours in 0..1, so it runs on the colours squashed (x / (1 + x)) and the
 * result is opened out again. `amount`: 0 none, 1 RCAS's most. `centre`: the pixel itself, when it
 * should be read through a node rather than from `tex`.
 */
const sharpen = (tex: THREE.TextureNode, amount: Node<'float'>, centre?: Node<'vec4'>) =>
  Fn(() => {
    const p = ivec2(screenCoordinate.xy);
    const squash = (c: Node<'vec3'>) => c.max(0).div(c.max(0).add(1));
    const at = (x: number, y: number) => squash(tex.load(p.add(ivec2(x, y))).rgb);
    const e = centre ? squash(centre.rgb) : at(0, 0), b = at(0, -1), d = at(-1, 0), f = at(1, 0), h = at(0, 1);
    const mn4 = min(min(b, d), min(f, h)), mx4 = max(max(b, d), max(f, h));
    // How much of the ring can be subtracted before the result leaves the ring's range.
    const hitMin = min(mn4, e).div(mx4.mul(4).max(1e-5));
    const hitMax = vec3(1).sub(max(mx4, e)).div(mn4.mul(4).sub(4).min(-1e-5));
    const lobes = max(hitMin.negate(), hitMax);
    const lobe = max(float(-(0.25 - 1 / 16)), min(max(lobes.r, max(lobes.g, lobes.b)), float(0))).mul(amount);
    const out = b.add(d).add(f).add(h).mul(lobe).add(e).div(lobe.mul(4).add(1)).clamp(0, 0.999);
    return vec4(out.div(out.oneMinus()), 1);
  })();

/** The reflection in the sea's surface (y = SEA_LEVEL). */
const SEA_MIRROR = new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 2 * SEA_LEVEL, 0, 0, 1, 0, 0, 0, 0, 1);

/** Safari, and every browser on iOS (WebKit's touch gestures are its own). */
const WEBKIT = typeof window !== 'undefined' && 'GestureEvent' in window;

/** Supersampling stops at about a 4K frame's worth of pixels. */
const SUPERSAMPLE_BUDGET = 3840 * 2160;
/**
 * The fewest pixels a frame is drawn with, where the screen has them: a phone at a preset's
 * pixel ratio (1 on Low) would draw a third of a 3x screen's pixels and smear the board's small
 * numbers. About 0.8 MP is still less than a laptop draws at Low.
 */
const PIXEL_FLOOR = 800_000;

export class Stage {
  renderer: THREE.WebGPURenderer;
  /** The island's parts drawn as render bundles (see bundles.ts). */
  bundles: Bundles;
  /**
   * Run every frame once the scene's transforms are up to date, before it is drawn: instanced
   * meshes copy their stand-ins' places in (see TokenFactory.sync).
   */
  readonly beforeDraw = new Set<() => void>();
  /** Its world matrices are updated once a frame in render(), not by every render call. */
  scene = Object.assign(new THREE.Scene(), { matrixWorldAutoUpdate: false });
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: IslandSky;
  pipeline: THREE.RenderPipeline | null = null;
  quality: QualitySettings;
  /** Direction towards the sun (normalised). */
  sunDir = new THREE.Vector3();
  /** Focus distance for depth of field (updated by the camera rig). */
  focus = uniform(14);
  focalRange = uniform(22);
  /** Depth-of-field bokeh size (Settings: board blur). */
  bokeh = uniform(2.4);
  /**
   * Colour grade, keyed by time of day (see TimeOfDay): white balance, a tint for the shadows
   * and one for the highlights (rgb = colour normalised to unit luminance, a = strength), and
   * saturation.
   */
  grade = {
    balance: uniform(new THREE.Vector3(1, 1, 1)),
    shadows: uniform(new THREE.Vector4(1, 1, 1, 0)),
    highlights: uniform(new THREE.Vector4(1, 1, 1, 0)),
    saturation: uniform(1.08),
  };
  /** Sky colour at unit luminance (set by TimeOfDay): occluded light takes on its hue. */
  skyTint = uniform(new THREE.Color(1, 1, 1));
  /** Fog: its keyed colour, range, and the sun's colour it takes on looking towards the sun. */
  fogColor = uniform(new THREE.Color(0xbcd6e6));
  fogNear = uniform(38);
  fogFar = uniform(210);
  /** The fog's own far end (weather's), without the lift for a camera pulled far back. */
  fogReach = uniform(210);
  fogSun = uniform(new THREE.Color(1, 0.9, 0.75));
  fogSunDir = uniform(new THREE.Vector3(0, 1, 0));
  /**
   * Colour of the haze in a view direction: the keyed fog colour, glowing towards the sun's
   * colour around the sun (forward scattering), as a hazy sky does.
   */
  fogColorAt = Fn(([dir]: [Node<'vec3'>]) => {
    const s = max(dot(dir, this.fogSunDir), 0);
    const glow = pow(s, 8).mul(0.6).add(pow(s, 2).mul(0.18));
    return mix(this.fogColor, this.fogSun, glow);
  });
  /** The renderer's default lighting, and the clustered lighting used while lamps cast light. */
  private plainLighting: THREE.Lighting | null = null;
  private lampLighting: IslandLighting | null = null;
  private envTarget: THREE.RenderTarget | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private resizeObserver: ResizeObserver;
  /** The screen's pixel ratio last seen (see render). */
  private dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  /**
   * Called once if the GPU device is lost (a driver reset, the GPU process crashing). The stage
   * stops drawing for good; the caller decides what to offer (a reload from the save).
   */
  onDeviceLost?: (message: string) => void;
  /** Set when the device was lost: nothing is drawn or compiled from then on. */
  lost = false;

  constructor(
    public canvas: HTMLCanvasElement,
    quality: Quality,
  ) {
    this.quality = QUALITY[quality];
    setTerrainRings(this.quality.terrainRings);
    frameState.seaLow = this.quality.seaLow;
    // (WebGPU only where it was found to run the game, on the device found: see gpuProbe.ts.)
    const gpu = probedGpu();
    const forceWebGL = new URLSearchParams(location.search).has('webgl') || gpu === null;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', forceWebGL, ...(gpu && { device: gpu }), trackTimestamp: new URLSearchParams(location.search).has('perf') });
    this.bundles = new Bundles(this.renderer);
    // three's own handler (it logs and stops rendering) first, then ours.
    const r = this.renderer as unknown as { onDeviceLost(info: { message?: string }): void; _onDeviceLost(info: { message?: string }): void };
    r.onDeviceLost = (info) => {
      r._onDeviceLost(info);
      if (this.lost) return;
      this.lost = true;
      this.onDeviceLost?.(info.message || 'The graphics device was lost.');
    };
    setMrtRenderer(this.renderer);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 600);
    this.camera.layers.enable(DETAIL_LAYER);
    this.camera.position.set(0, 11, 11);
    this.camera.lookAt(0, 0, 0);

    // The keyed fog (colour and range) lives on scene.fog, which time of day and weather
    // adjust; the fog actually drawn is this node, which adds the glow towards the sun.
    this.scene.fog = new THREE.Fog(0xbcd6e6, 38, 210);
    this.scene.fogNode = fog(this.fogColorAt(normalize(positionWorld.sub(cameraPosition))), rangeFogFactor(this.fogNear, this.fogFar));

    // Sun: golden-hour key light from the north-west so shadows fall towards the viewer's lower right.
    this.sun = new THREE.DirectionalLight(0xfff1de, 3.3);
    this.setSun(34, 292);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    // Things kept out of the sea's mirror (DETAIL_LAYER) still cast shadows if they're set to.
    sc.layers.enable(DETAIL_LAYER);
    sc.left = -7.5;
    sc.right = 7.5;
    sc.top = 7.5;
    sc.bottom = -7.5;
    sc.near = 1;
    sc.far = 40;
    this.sun.shadow.mapSize.set(this.quality.shadowMap, this.quality.shadowMap);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = shadowRadius(this.quality.shadowMap);
    this.scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x6b5a3c, 0.26);
    this.scene.add(this.hemi);

    this.sky = new IslandSky();
    this.sky.scale.setScalar(450);
    this.sky.turbidity.value = 3.2;
    this.sky.rayleigh.value = 1.35;
    this.sky.mieCoefficient.value = 0.004;
    this.sky.mieDirectionalG.value = 0.82;
    this.sky.cloudCoverage.value = 0.38;
    this.sky.cloudDensity.value = 0.5;
    this.sky.cloudScale.value = 0.00035;
    this.sky.sunPosition.value.copy(this.sunDir).multiplyScalar(400);
    this.scene.add(this.sky);

    this.resizeObserver = new ResizeObserver(() => this.resizeSoon());
    this.resizeObserver.observe(canvas);
    // The GPU device is asked for now, so it is on its way while the world is built (init waits
    // for it, and reports a failure).
    this.renderer.init().catch(() => {});
  }

  /** `step` reports each stage of start-up (for the loading screen) and may wait for it to show. */
  async init(step?: (label: string, progress: number) => Promise<void>) {
    await this.renderer.init();
    // Before any material is built: instanced meshes sharing a material share its shaders.
    shareInstanceShaders(this.renderer);
    shareInstanceBuilds(this.renderer);
    keepNodeBuilds(this.renderer);
    skipPrepassLighting();
    skipUnchangedUniformArrays(this.renderer);
    carryDisplacementToMotion();
    cloudField.init(this.renderer);
    await step?.('Mixing the inks', 0.26);
    this.plainLighting = this.renderer.lighting;
    // Clustered lighting needs compute shaders: WebGPU only (the WebGL fallback keeps glowing lamps).
    const backend = (this.renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
    if (backend.isWebGPUBackend) this.lampLighting = new IslandLighting(128, 32, 24, 32);
    this.applyLighting();
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    // The bake's shaders compile first, asynchronously: built in the bake itself they would hold
    // the GPU (and the loading screen) for seconds on a first visit.
    const pending: Promise<unknown>[] = [];
    this.dryRun(() => this.updateEnvironment(), pending);
    this.releaseDryTarget();
    await Promise.all(pending);
    this.updateEnvironment();
    await step?.('Charting wind and water', 0.36);
    this.buildPipeline();
    this.resize();
  }

  /** Light direction (elevation/azimuth in degrees, azimuth clockwise from north). The sky can use a different (true) sun elevation. */
  setSun(elevation: number, azimuth: number, skyElevation = elevation, skyAzimuth = azimuth) {
    const dir = (e: number, a: number, out: THREE.Vector3) => {
      const el = THREE.MathUtils.degToRad(e);
      const az = THREE.MathUtils.degToRad(a);
      return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    };
    dir(elevation, azimuth, this.sunDir);
    this.sun.position.copy(this.sunDir).multiplyScalar(18);
    this.sun.target.position.set(0, 0, 0);
    if (this.sky) dir(skyElevation, skyAzimuth, this.sky.sunPosition.value).multiplyScalar(400);
  }

  private envScene: THREE.Scene | null = null;
  private envSky: IslandSky | null = null;
  private envDirty = false;

  /**
   * Ask for a re-bake of the environment (time of day, weather). It happens at the start of the
   * next frame that is drawn, so none are made while nothing is (the flat map, a compile).
   */
  requestEnvironment() {
    this.envDirty = true;
  }

  /**
   * Re-bake the sky into the PMREM environment. The scene, sky and render target persist, so
   * `scene.environment` keeps the same texture: swapping it would make every material that
   * reads the environment rebuild (and the ocean's viewport-depth nodes leak a screen-sized
   * depth copy each time).
   */
  updateEnvironment() {
    if (!this.pmrem || this.lost) return;
    this.envDirty = false;
    if (!this.envScene || !this.envSky) {
      this.envScene = new THREE.Scene();
      this.envSky = new IslandSky();
      this.envSky.scale.setScalar(450);
      this.envScene.add(this.envSky);
    }
    const sky = this.envSky;
    sky.turbidity.value = this.sky.turbidity.value;
    sky.rayleigh.value = this.sky.rayleigh.value;
    sky.mieCoefficient.value = this.sky.mieCoefficient.value;
    sky.mieDirectionalG.value = this.sky.mieDirectionalG.value;
    // Weather's extra cloud goes into the bake, so overcast skies light and reflect softly (the
    // fair-weather clouds stay out: they would wash the island with white sky light).
    sky.cloudCoverage.value = Math.max(0, this.sky.cloudCoverage.value - 0.38) * 1.6;
    sky.cloudDensity.value = this.sky.cloudDensity.value;
    sky.sunPosition.value.copy(this.sky.sunPosition.value);
    sky.showSunDisc.value = 0;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 1, 500, this.envTarget ? { renderTarget: this.envTarget } : {});
    if (this.scene.environment !== this.envTarget.texture) this.scene.environment = this.envTarget.texture;
  }

  private scenePasses = new Map<string, ReturnType<typeof pass>>();
  /** Opaque depth-and-normal prepass for ambient occlusion on the higher presets. */
  private prePass: ReturnType<typeof pass> | null = null;
  /**
   * The ambient occlusion applied inside lighting (High, Ultra) and the context node that carries
   * it into the scene pass's materials. Made once and kept: a new context node is a new render
   * context for every material in the pass, so each would be built again (seconds of shader work).
   */
  private ambient: { ao: ReturnType<typeof ao>; context: ReturnType<typeof builtinAOContext> } | null = null;
  /** The HUD's glass panels' frost, drawn into the frame (see frost.ts; app/frost.ts says where). */
  readonly frost = new Frost();
  /** Post-processing nodes that own render targets; disposed when the chain is rebuilt. */
  private postNodes: { dispose(): void }[] = [];
  private own<T>(node: T): T {
    if (node && typeof (node as { dispose?: unknown }).dispose === 'function') this.postNodes.push(node as unknown as { dispose(): void });
    return node;
  }
  /**
   * The scene's resolution as a share of the frame's each way: under 1 where the lighter temporal
   * AA rebuilds the frame finer than the scene is drawn (see QualitySettings.displayRatio).
   */
  sceneScale = 1;
  /** What is drawn at the scene's resolution rather than the frame's, rescaled with it. */
  private scaled: ((k: number) => void)[] = [];

  /** The scene's own pixel ratio (the frame's, or less: see sceneScale). */
  get scenePixelRatio() {
    return this.renderer.getPixelRatio() * this.sceneScale;
  }

  private setSceneScale(k: number) {
    this.sceneScale = k;
    for (const f of this.scaled) f(k);
  }

  /** The scene's share of the frame as the preset and the screen have it (see resize), before any give (see resolutionGive). */
  private presetSceneScale = 1;
  /**
   * How much of the scene's resolution each way it keeps where the lighter temporal AA rebuilds the
   * frame (Medium, Low): under 1 while Auto gives some up for the GPU to keep up (app/autoResolution.ts).
   * Only the scene's buffers change size, no shader: the frame shown keeps its own.
   */
  resolutionGive = 1;

  setResolutionGive(k: number) {
    if (k === this.resolutionGive) return;
    this.resolutionGive = k;
    if (this.quality.aa === 'reproject') this.setSceneScale(this.presetSceneScale * k);
  }

  /**
   * The last frames drawn, each from the start of its drawing to the GPU having finished it
   * (oldest first, up to 120), while `timeFrames` is on: what app/autoResolution.ts judges by.
   */
  readonly frameTimes: number[] = [];
  timeFrames = false;

  /** How much the temporal presets are sharpened after their AA (see sharpen): 0 none, 1 the most. */
  sharpness = uniform(0.66);
  /** 1 while the camera's motion blur is on (Settings), 0 off: it switches without a rebuild. */
  private blurOn = uniform(1);

  /**
   * Build the post-processing chain for the current preset. The scene's materials are only built
   * again when what they are built for changes (the scene pass's buffers, or AO inside lighting
   * turning on or off); the chain's own shader is always new, and is compiled by the next
   * precompile, or else by the first frame.
   */
  buildPipeline() {
    const q = this.quality;
    // RenderPipeline.dispose() only frees its own quad; the passes' render targets are ours.
    this.pipeline?.dispose();
    for (const n of this.postNodes) n.dispose();
    this.postNodes = [];
    this.scaled = [];
    const pipeline = new THREE.RenderPipeline(this.renderer);
    // No MSAA on the scene pass: GTAO/DOF need single-sample depth, and the sea copies the depth
    // mid-pass. Anti-aliasing is temporal (see QualitySettings.aa).
    // Motion blur stays in the chain whenever the preset has it: the setting only zeroes it.
    const blur = q.motionBlur;
    const needVelocity = q.aa === 'taa' || blur;
    // Ambient occlusion. On High and Ultra it comes from an opaque prepass and is applied inside
    // lighting to indirect light only (sky, hemisphere fill, environment), so sunlit surfaces
    // keep their brightness. Medium can't afford a second geometry pass: there it is multiplied
    // in afterwards, with a raised floor tinted by the sky.
    const ambientAO = q.ao && q.aoPrepass;
    const postAO = q.ao && !ambientAO;
    // One scene pass per buffer layout, kept across rebuilds: a new pass is a new render context,
    // and every material compiled for the old one (programs, uniform buffers, render objects)
    // would otherwise stay cached for good on each quality change.
    const layout = `${postAO}|${needVelocity}`;
    let scenePass = this.scenePasses.get(layout);
    if (!scenePass) {
      scenePass = pass(this.scene, this.camera);
      // Transparent effects blend into the normal target (see util/mrt.ts) instead of overwriting it.
      // The normal target only feeds the post-process AO; skip it otherwise.
      const sceneMRT = postAO
        ? needVelocity
          ? mrt({ output, normal: normalView, velocity })
          : mrt({ output, normal: normalView })
        : needVelocity
          ? mrt({ output, velocity })
          : mrt({ output });
      if (postAO) sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
      scenePass.setMRT(sceneMRT);
      this.scenePasses.set(layout, scenePass);
    }
    // Idle layouts keep their (small) render context but give back their screen-sized buffers;
    // they are re-created if that layout is used again.
    for (const p of this.scenePasses.values()) if (p !== scenePass) p.renderTarget.dispose();
    // The scene at its share of the frame (see sceneScale), and with it what is worked out from it
    // before the lighter temporal AA rebuilds the frame (its AO, bloom and finished picture, below).
    const pass_ = scenePass;
    this.scaled.push((k) => pass_.setResolutionScale(k));
    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const normal = postAO ? scenePass.getTextureNode('normal') : null;
    const vel = needVelocity ? scenePass.getTextureNode('velocity') : null;

    // Temporal anti-aliasing resolves sub-pixel detail (grass blades, wheat, fences, rigging)
    // far better than post-process AA, and stabilises shimmering on thin geometry.
    let lit: Node<'vec4'> = vec4(color.rgb, float(1));

    const aoScale = q.pixelRatio > 1.25 ? 0.5 : 0.75;
    const tuneAO = (aoPass: ReturnType<typeof ao>) => {
      aoPass.resolutionScale = aoScale;
      aoPass.radius.value = 0.35;
      aoPass.distanceExponent.value = 1.4;
      aoPass.scale.value = 1.15;
      aoPass.thickness.value = 0.8;
      return aoPass;
    };
    let context: ReturnType<typeof builtinAOContext> | null = null;
    if (ambientAO) {
      if (!this.prePass) {
        this.prePass = pass(this.scene, this.camera);
        this.prePass.transparent = false;
        const preMRT = mrt({ output: packNormalToRGB(normalView) });
        this.prePass.setMRT(preMRT);
        // (Its materials are built without their lighting, which it never draws: see prepassLighting.ts.)
        setPrepassMRT(preMRT);
        this.prePass.getTexture('output').type = THREE.UnsignedByteType;
      }
      // At the AO's own resolution: it never reads finer than that.
      this.prePass.setResolutionScale(aoScale);
      if (!this.ambient) {
        const preNormal = this.prePass.getTextureNode('output');
        const aoPass = ao(this.prePass.getTextureNode('depth'), sample((uv) => unpackRGBToNormal(preNormal.sample(uv).rgb)), this.camera);
        // The sea's mirror is rendered from a camera below the water, inside this pass, and so
        // inherits its context; the AO texture belongs to the main view (in the mirror it painted
        // bands into the reflection), so only views from above the sea are occluded.
        const fromAbove = step(SEA_LEVEL, cameraPosition.y);
        // three sets the AO node up again in every material that reads it (all of the scene's,
        // through the context), and each time rebuilds its own shader: hundreds of identical
        // GTAO builds through a precompile, and one more whenever a material is built later
        // (seconds, on the first frame after a resize). Its result doesn't depend on the
        // material asking, so it is set up once and handed out after that.
        const node = aoPass as unknown as { setup(builder: unknown): unknown };
        const setup = node.setup.bind(aoPass);
        let result: unknown = null;
        node.setup = (builder) => (result ??= setup(builder));
        this.ambient = { ao: aoPass, context: builtinAOContext(mix(float(1), aoPass.getTextureNode().sample(screenUV).r, fromAbove)) };
      }
      tuneAO(this.ambient.ao);
      context = this.ambient.context;
    } else {
      // The prepass and the AO give back their screen-sized buffers while unused.
      this.prePass?.renderTarget.dispose();
      this.ambient?.ao.dispose();
    }
    if (scenePass.contextNode !== context) {
      scenePass.contextNode = context;
      scenePass.needsUpdate = true;
    }

    // Post-process AO goes in before the temporal resolve so TRAA also smooths its noise.
    if (postAO && normal) {
      const aoPass = this.own(tuneAO(ao(depth, normal, this.camera)));
      this.scaled.push((k) => (aoPass.resolutionScale = aoScale * k));
      const aoTex = aoPass.getTextureNode();
      // Faded out with distance, gone by the far islands (in the haze): out there a pixel spans more
      // than the AO's reach, and the depth (its near plane a tenth of a unit off) is too coarse for
      // it, so it drew false occlusion in fine horizontal stripes across the distant mountains and
      // the sea short of the horizon. (The fog's near end moves in with rain and out overhead.)
      const far = smoothstep(this.fogNear.add(30), this.fogNear.add(100), scenePass.getViewZNode().negate());
      const shade = mix(this.skyTint.mul(0.45), vec3(1), max(aoTex.r, far));
      lit = vec4(lit.rgb.mul(shade), lit.a);
    }

    if (q.aa === 'taa' && vel) {
      // Straight from the scene pass unless AO was multiplied in (TRAA never reads alpha, and
      // the alpha is dropped just below), saving a full-screen copy.
      const beauty = postAO ? this.own(convertToTexture(lit)) : color;
      const resolved = this.own(traa(beauty, depth, vel, this.camera)) as unknown as Node<'vec4'>;
      lit = vec4(resolved.rgb, float(1));
    }

    // Clamp tiny, extremely bright pixels (sun glints) so depth of field and bloom don't smear
    // them into bokeh rings and white-out.
    lit = vec4(min(lit.rgb, vec3(6)), lit.a);

    let dofNode: ReturnType<typeof dof> | null = null;
    if (q.dof) {
      const viewZ = scenePass.getViewZNode();
      // Tilt-shift: the board around the focus stays crisp, the horizon and extreme foreground soften.
      dofNode = this.own(dof(this.own(convertToTexture(lit)), viewZ, this.focus, this.focalRange, this.bokeh));
      lit = dofNode as unknown as Node<'vec4'>;
    }

    if (blur && vel) {
      // Subtle camera motion blur: only visible while the camera sweeps or orbits quickly.
      // A dead zone keeps slow orbits and drifting pieces crisp; only fast sweeps streak.
      const raw = vel.xy.mul(0.25);
      const len = length(raw);
      const v = raw.mul(smoothstep(0.003, 0.012, len));
      const capped = v.mul(min(float(1), float(0.012).div(length(v).add(1e-5)))).mul(this.blurOn);
      // The depth of field's own result texture when there is one (no extra copy).
      // (r186 has getTextureNode on the depth of field; its type declaration doesn't.)
      const src = dofNode ? (dofNode as unknown as { getTextureNode(): THREE.TextureNode }).getTextureNode() : this.own(convertToTexture(lit));
      // three's motionBlur with 10 taps, except that with the camera still (inside the dead
      // zone) every tap reads the same texel, so it takes one. (It averages n + 1 taps over n,
      // so a still frame comes out 11/10 as bright: kept, as the grade was tuned with it. With
      // the setting off a still frame is 10/10, as with no blur in the chain at all.)
      // Explicit-level reads, as texture lookups in a per-pixel branch must be.
      const blurred = Fn(() => {
        // The centre tap from the depth of field node itself: that keeps the node in the graph,
        // which is what makes it render each frame (its texture alone wouldn't).
        const c = (dofNode ? (dofNode as unknown as Node<'vec4'>) : src.sample(uv())).toVar();
        If(length(capped).greaterThan(0), () => {
          Loop({ start: int(1), end: int(10), type: 'int', condition: '<=' }, ({ i }: { i: Node<'int'> }) => {
            c.addAssign(src.sample(uv().add(capped.mul(float(i).div(9).sub(0.5)))).level(float(0)));
          });
        }).Else(() => {
          c.mulAssign(this.blurOn.add(10));
        });
        return c.div(10);
      })() as unknown as Node<'vec4'>;
      // With bloom after it, the blur is rendered once to a texture that both read: inline, it
      // would run in bloom's bright pass and again in the output.
      lit = q.bloom ? (this.own(convertToTexture(blurred)) as unknown as Node<'vec4'>) : blurred;
    }

    // After TRAA, its softening taken back (see sharpen), from the texture the chain has here
    // already on High and Ultra (the motion blur's: the bloom reads it too). (The lighter temporal
    // AA is sharpened on its way to the screen, below.)
    let out = lit;
    if (q.aa === 'taa') {
      const isTexture = (lit as unknown as { isTextureNode?: boolean }).isTextureNode;
      out = sharpen((isTexture ? lit : this.own(convertToTexture(lit))) as unknown as THREE.TextureNode, this.sharpness);
    }
    if (q.bloom) {
      // High threshold with a soft knee: only genuinely bright highlights glow, without a
      // milky veil over the island when looking towards the sun.
      const b = this.own(bloom(lit, 0.16, 0.3, 1.6));
      b.smoothWidth.value = 1.0;
      if (q.aa === 'reproject') this.scaled.push((k) => b.setResolutionScale(0.5 * k));
      out = vec4(out.rgb.add(b.rgb), 1);
    }

    // Grading keyed to the time of day: white balance and saturation, the shadows tinted
    // towards the sky and the highlights towards the sun, and a soft vignette.
    const g = this.grade;
    const graded = Fn(() => {
      const c = cdl(vec4(out.rgb, 1), g.balance, vec3(0), vec3(1), g.saturation).rgb.toVar();
      // Shadows and highlights by brightness, compressed so the split holds in HDR.
      const l = luminance(c);
      const tl = l.div(l.add(0.35));
      const inShadow = smoothstep(0.62, 0.1, tl).mul(g.shadows.w);
      const inLight = smoothstep(0.45, 0.95, tl).mul(g.highlights.w);
      c.assign(c.mul(mix(vec3(1), g.shadows.xyz, inShadow)).mul(mix(vec3(1), g.highlights.xyz, inLight)));
      const d = length(uv().sub(0.5).mul(vec2(1.0, 0.85)));
      const vig = clamp(pow(smoothstep(0.85, 0.25, d), 0.8), 0, 1);
      c.assign(c.mul(mix(0.72, 1.0, vig)));
      return vec4(c, 1);
    })();

    // Tone-mapped and in sRGB (the lighter temporal AA works on the finished frame). Named
    // outright: three tone-maps and encodes only when drawing to the screen, and the lighter
    // temporal AA draws this into a texture of its own first. Dithered by half a level of the
    // screen's 8 bits either way, so the sky's and the fog's long gradients (dusk's and night's
    // dark ones most) don't step into bands.
    const shown = renderOutput(graded, this.renderer.toneMapping, this.renderer.outputColorSpace);
    const dither = interleavedGradientNoise(screenCoordinate.xy).sub(0.5).div(255);
    pipeline.outputColorTransform = false;
    // (The glass panels' frost goes in under them on the way to the screen: see frost.ts. Only
    // on WebGPU, where app/frost.ts hands the panels to it: elsewhere its small frame and blur
    // would be three passes a frame for nothing.)
    const own = <T,>(node: T) => this.own(node);
    const gpu = !!(this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    const frosted = (frame: Node<'vec3'>) => (gpu ? this.frost.apply(shown, frame, own) : frame);
    if (q.aa === 'reproject') {
      // The finished frame (8 bits a channel), resolved over the frames, sharpened as the temporal
      // presets are and dithered on its way to the screen. (The centre read through the resolve
      // itself, which keeps it in the graph, drawn each frame.)
      const finished = this.own(convertToTexture(shown, null, null, { type: THREE.UnsignedByteType } as never)) as unknown as THREE.TextureNode & { setResolutionScale(k: number): void };
      const resolve = this.own(new ReprojectAANode(finished, depth, this.camera));
      this.scaled.push((k) => {
        finished.setResolutionScale(k);
        resolve.scale = k;
      });
      const sharp = sharpen(resolve.getTextureNode() as unknown as THREE.TextureNode, this.sharpness, resolve as unknown as Node<'vec4'>);
      pipeline.outputNode = vec4(frosted(sharp.rgb).add(dither), 1);
    }
    else pipeline.outputNode = vec4(frosted(shown.rgb).add(dither), shown.a);
    this.pipeline = pipeline;
    // (The scene drawn whole where the frame isn't rebuilt finer: see resize.)
    this.setSceneScale(q.aa === 'reproject' ? this.sceneScale : 1);
  }

  /**
   * Settings toggle. The blur stays in the chain and is only zeroed, so nothing is rebuilt and
   * no shader compiles: it returns false, "nothing to precompile", for callers that would
   * otherwise route a change through the precompile path.
   */
  setMotionBlur(on: boolean): boolean {
    this.blurOn.value = on ? 1 : 0;
    return false;
  }

  /** Board blur 0..1 from Settings (0.5 is the designed look). */
  setBlur(amount: number) {
    this.blurAmount = amount;
    this.bokeh.value = amount * 4.8 * this.bokehScale;
  }

  private blurAmount = 0.5;
  private bokehScale = 1;

  /**
   * How much of the board blur to use for the camera's distance (see World's frame): all of it
   * from the usual views, less in close, where the blur would otherwise soften the very thing
   * being looked at (a badge, the fog bank, a piece) as much as the background.
   */
  setBokehScale(k: number) {
    if (Math.abs(k - this.bokehScale) < 1e-3) return;
    this.bokehScale = k;
    this.bokeh.value = this.blurAmount * 4.8 * k;
  }

  /** Whether lamps cast real light now (the preset asks for it and the backend supports it). */
  get pointLightsOn() {
    return this.quality.pointLights && this.lampLighting !== null;
  }

  /** Switching lighting systems rebuilds every material once (render lists are per lighting). */
  private applyLighting() {
    const want = this.pointLightsOn ? this.lampLighting : this.plainLighting;
    if (want && this.renderer.lighting !== want) this.renderer.lighting = want;
    // Without clustered lighting the lamps go dark at once (World's lamps would only hide them
    // on the next frame, after a precompile had built every material for them as plain lights).
    if (!this.pointLightsOn)
      this.scene.traverse((o) => {
        if ((o as THREE.PointLight).isPointLight) o.visible = false;
      });
  }

  /**
   * Switch presets. With `resize` false the canvas keeps its size (and so its last frame, which
   * resizing would clear) until the caller resizes it, once the new preset is compiled.
   */
  setQuality(name: Quality, resize = true) {
    this.quality = QUALITY[name];
    // (The next board's ground is built to it: the one up stays as it was built.)
    setTerrainRings(this.quality.terrainRings);
    frameState.seaLow = this.quality.seaLow;
    this.applyLighting();
    // The shadow node resizes its own map to mapSize on the next render.
    this.sun.shadow.mapSize.set(this.quality.shadowMap, this.quality.shadowMap);
    this.sun.shadow.radius = shadowRadius(this.quality.shadowMap);
    this.sun.shadow.needsUpdate = true;
    this.buildPipeline();
    // (New lights and passes: every bundle is recorded again.)
    this.bundles.invalidate();
    if (resize) this.resize();
  }

  private size = { w: 0, h: 0, pr: 0 };

  /**
   * The pixel ratio to draw at: the preset's, up to the screen's own (or past it, supersampling
   * on Ultra), and on small dense screens enough to draw PIXEL_FLOOR pixels.
   */
  private pixelRatio(w: number, h: number) {
    const dpr = window.devicePixelRatio || 1;
    const q = this.quality;
    let pr = Math.min(q.pixelRatio, dpr * q.supersample);
    pr = Math.max(pr, Math.min(dpr, Math.sqrt((PIXEL_FLOOR * this.floorScale) / (w * h))));
    if (pr > dpr) pr = Math.max(dpr, Math.min(pr, Math.sqrt(SUPERSAMPLE_BUDGET / (w * h))));
    return pr;
  }

  /**
   * How much of the pixel floor a frame keeps: 1 all of it, 0 none (the preset's own pixel
   * ratio). Auto lowers it, a step at a time, on a device still falling behind on Low: a small
   * dense screen draws markedly faster at 1x than at the floor.
   */
  floorScale = 1;

  setFloorScale(k: number) {
    if (k === this.floorScale) return;
    this.floorScale = k;
    this.resize();
  }

  /**
   * Make the browser show the canvas again. Safari on iOS can go on drawing a WebGPU canvas
   * (every frame valid, no errors) while the page shows none of it, only the page's background,
   * until the canvas changes size: after every load on a foldable phone's cover screen, where
   * nothing resizes the page once it's up (elsewhere Safari's bars settling do, which hides it). A
   * size a pixel off for two frames, then back, is enough. Called once the title is up and
   * whenever the page is shown again.
   */
  refreshSurface() {
    const { w, h } = this.size;
    // (Only WebKit loses the canvas so: elsewhere the nudge would only clear it, and Firefox
    // shows the cleared canvas for a frame or two before the next one arrives.)
    if (!WEBKIT || this.lost || w < 2 || h < 3) return;
    this.renderer.setSize(w, h - 1, false);
    this.bundles.invalidate();
    this.redraw?.();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // (Unless a real resize came in between: that one stands.)
        if (this.size.w !== w || this.size.h !== h) return;
        this.renderer.setSize(w, h, false);
        this.bundles.invalidate();
        this.redraw?.();
      }),
    );
  }

  /**
   * Resolves once the GPU has finished what has been submitted so far, so the frame just drawn is
   * on its way to the screen (at once on WebGL, which has no queue to ask).
   */
  submitted(): Promise<void> {
    const queue = (this.renderer.backend as { device?: GPUDevice }).device?.queue;
    return queue ? queue.onSubmittedWorkDone().catch(() => {}) : Promise.resolve();
  }

  /** Draws a frame now, if one may be drawn (set by the World): after a resize has cleared the canvas. */
  redraw?: () => void;

  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeSince = 0;

  /**
   * The canvas's box changed: its pixels follow once the size has held for a moment (or a third of
   * a second into a drag), meanwhile the last frame is stretched to the box. Resizing clears the
   * canvas, and Firefox shows a WebGPU canvas's next frame a frame or two late however soon it's
   * drawn: coming back to a tab from one with the bookmarks bar (which resizes the page and puts
   * it back) would show the bare canvas, a flat brown, for those frames. A size that comes back
   * before it's taken up changes nothing. (The first size is taken at once; a hidden tab waits.)
   */
  private resizeSoon() {
    if (!this.size.w) {
      if (this.resize()) this.redraw?.();
      return;
    }
    const now = performance.now();
    if (!this.resizeTimer) this.resizeSince = now;
    else clearTimeout(this.resizeTimer);
    const apply = () => {
      if (document.hidden) {
        this.resizeTimer = setTimeout(apply, 200);
        return;
      }
      this.resizeTimer = null;
      if (this.resize()) this.redraw?.();
    };
    this.resizeTimer = setTimeout(apply, Math.max(0, Math.min(150, this.resizeSince + 320 - now)));
  }

  /** Fits the canvas to its box; whether that changed its size (and so cleared it). */
  resize(): boolean {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w < 2 || h < 2) return false;
    // The scene's pixel ratio, and the frame's: finer where the lighter temporal AA rebuilds it
    // (see QualitySettings.displayRatio).
    const scene = this.pixelRatio(w, h);
    const q = this.quality;
    // (Within a 4K frame's pixels, as supersampling is: the AA keeps two frames of history.)
    const pr = q.aa === 'reproject' ? Math.max(scene, Math.min(window.devicePixelRatio || 1, q.displayRatio, Math.sqrt(SUPERSAMPLE_BUDGET / (w * h)))) : scene;
    this.presetSceneScale = scene / pr;
    this.setSceneScale(this.presetSceneScale * (q.aa === 'reproject' ? this.resolutionGive : 1));
    // Setting the canvas size clears it, even to the size it has: only when something changed.
    const s = this.size;
    if (s.w === w && s.h === h && s.pr === pr) return false;
    s.w = w;
    s.h = h;
    s.pr = pr;
    this.renderer.setPixelRatio(pr);
    this.frost.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    // The ambient occlusion's texture is made again at the new size, and a bundle recorded with
    // the old one would draw from a destroyed texture: every frame it was in would fail to submit
    // (on High's title, after its one-pixel nudge in refreshSurface, until the turning camera
    // happened to change what a bundle held). So they are recorded again.
    this.bundles.invalidate();
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    return true;
  }

  /**
   * Compile every pipeline the current view needs before it is drawn, side by side. Normally
   * three creates each one when a draw first needs it, one after another, which stalls the first
   * frames of a new board for seconds (far longer on a first visit, before the browser has cached
   * them). Here frames go through every pass as usual (scene, AO prepass, sea mirror, shadow map,
   * post-processing), so each variant is built in exactly the state it will be drawn in, but
   * nothing is drawn and every pipeline is created asynchronously.
   *
   * Building a material's shader is JavaScript work of several milliseconds, and a new island has
   * over a hundred, so it goes in slices: each dry frame shows only a few objects, with a pause between
   * them, and the page never stops responding for more than a moment. A last frame with
   * everything covers what remains. `progress` reports (done, total): the objects, then the GPU
   * pipelines. With `hidden`, things not shown yet (pieces waiting for the intro, the dice, empty
   * particle pools) are shown for those frames too, so they don't stall the frame they first
   * appear in. `cancelled` stops it between slices (a quality change undone); `smooth` keeps the
   * slices short, for while frames are being drawn. `only`: just what is under these (a hex found
   * in the fog: see board/fog.ts), a few objects a slice, as each instanced batch builds alone.
   * `skip`: everything but what is under these, which is left as it is (hidden stays hidden).
   */
  async precompile(progress?: (done: number, total: number) => void, hidden = false, cancelled?: () => boolean, smooth = false, only?: THREE.Object3D[], skip?: THREE.Object3D[]) {
    if (this.lost) return;
    try {
      await this.compileSlices(progress, hidden, () => this.lost || (cancelled?.() ?? false), smooth, only, skip);
    } finally {
      // The stand-in canvas texture is only needed while dry frames run (it is canvas-sized).
      this.releaseDryTarget();
    }
  }

  private async compileSlices(progress: ((done: number, total: number) => void) | undefined, hidden: boolean, cancelled: () => boolean, smooth: boolean, only?: THREE.Object3D[], skip?: THREE.Object3D[]) {
    const pending: Promise<unknown>[] = [];
    // While frames are drawn (`smooth`) for a few objects (`only`: a found hex, a mesh warming up),
    // shaders are built after each slice's dry frame, asynchronously, a stage at a time with a task
    // between (see dryRun), so no build holds a frame. (A whole board's are built in the dry
    // frames, as the slices are sized for: built later, some would go missing and be built on sight.)
    const builds: (() => Promise<unknown>)[] | undefined = smooth && only ? [] : undefined;
    // What makes its meshes as frames are drawn (instanced batches growing for stand-ins added
    // since: see board/propBatches.ts) makes them now, so they are among what is compiled here
    // rather than built all at once by the first dry frame.
    this.scene.updateMatrixWorld();
    for (const f of this.beforeDraw) f();
    const renderables: THREE.Object3D[] = [];
    const collect = (into: THREE.Object3D[]) => (o: THREE.Object3D) => {
      const m = o as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
      if (m.isMesh || m.isPoints || m.isLine || m.isSprite) into.push(o);
    };
    // The scene, but not what is under `skip`.
    const skipped = new Set(skip);
    const traverse = (fn: (o: THREE.Object3D) => void, o: THREE.Object3D = this.scene) => {
      if (skipped.has(o)) return;
      fn(o);
      for (const c of o.children) traverse(fn, c);
    };
    traverse(collect(renderables));
    // (What the slices go through: everything, or what is under `only`.)
    let todo = renderables;
    if (only) {
      todo = [];
      for (const root of only) root.traverse(collect(todo));
    }
    // One dry frame showing only `only` among the renderables (all of them when null). The scene
    // is put back straight after, so the frames updating in between see it as it really is.
    const dry = (only: Set<THREE.Object3D> | null) => {
      const was: [THREE.Object3D, boolean][] = [];
      const set = (o: THREE.Object3D, v: boolean) => {
        if (o.visible === v) return;
        was.push([o, o.visible]);
        o.visible = v;
      };
      // (Not lights: a lamp switched off by day would light this frame alone, and every material
      // built for that set of lights would be built again for the real one.)
      if (hidden) traverse((o) => !o.visible && !(o as THREE.Light).isLight && set(o, true));
      if (only) for (const o of renderables) if (!only.has(o) && !this.passOwners.has(o)) set(o, false);
      // Nor culled: what is out of view now (a boat beyond the shadow's reach) comes into it later.
      const culled = renderables.filter((o) => o.frustumCulled && (!only || only.has(o)));
      for (const o of culled) o.frustumCulled = false;
      try {
        this.dryRun(() => this.render(), pending, builds);
      } finally {
        for (const o of culled) o.frustumCulled = true;
        for (let i = was.length - 1; i >= 0; i--) was[i][0].visible = was[i][1];
      }
    };
    // Slices are sized by what they build: the cost is in materials not seen before (tens of
    // milliseconds each), while objects sharing them are mostly cheap. So each slice takes a few
    // new materials, more while slices go quickly and fewer when one runs long, and none holds the
    // page for long. Objects sharing a material can still need builds of their own (instanced or
    // not, other attributes), and with lamps and the mirror on (High, Ultra) each build is several
    // times dearer: so after a slow slice the number of objects is capped as well, down to one at
    // a time. Slices are judged on what they add to a dry frame with nothing new in it (every pass
    // still runs, and on some browsers that alone is slow), or the slices would shrink to an object
    // each and that frame's cost would be paid hundreds of times over. The first dry frame has no
    // objects but the sea: the passes' own shaders (post-processing) are a sizeable build of
    // their own.
    const n = todo.length;
    const seen = new Set<string>();
    // What a build is shared by: the material, and an instanced mesh's capacity (see
    // core/instanceBuilds.ts) or a batched mesh itself. A new one is a new build in every pass.
    const buildKey = (o: THREE.Object3D) => {
      const m = materials(o).map((x) => x.uuid).join(',');
      const im = o as THREE.InstancedMesh & { isBatchedMesh?: boolean };
      return im.isInstancedMesh ? `${m}|i${im.instanceMatrix.count}` : im.isBatchedMesh ? `${m}|b${o.id}` : m;
    };
    const materials = (o: THREE.Object3D) => {
      const m = (o as THREE.Mesh).material;
      return Array.isArray(m) ? m : m ? [m] : [];
    };
    // The shaders a dry frame skipped built (three yielding as it goes), and the frame run again for
    // their pipelines, until it skips none (the shadow map's, say, come only once the scene's are
    // there). False if cancelled meanwhile.
    const built = async (slice: Set<THREE.Object3D> | null) => {
      for (let k = 0; k < 8 && builds?.length; k++) {
        // (Four side by side: each yields between its stages, so frames go on.)
        const queue = builds.splice(0);
        const lane = async () => {
          while (queue.length && !cancelled()) await queue.shift()!();
        };
        await Promise.all([lane(), lane(), lane(), lane()]);
        if (cancelled()) return false;
        dry(slice);
      }
      return true;
    };
    // Progress by what each object is likely to cost rather than by their count: the builds come
    // with an instanced mesh (whose shaders are its own) or a material not met before (tens of
    // milliseconds each, more with a shadow), while an object sharing what's built is nearly free.
    // (Counted, the "Setting sail" bar crawled to a third in most of the time, then leapt.)
    const reached = [0];
    const met = new Set<THREE.Material>();
    for (const o of todo) {
      const mats = materials(o);
      const costly = (o as THREE.InstancedMesh).isInstancedMesh || mats.some((m) => !met.has(m));
      for (const m of mats) met.add(m);
      reached.push(reached[reached.length - 1] + (costly ? (o.castShadow ? 1.5 : 1) : 0.05));
    }
    const weighed = (i: number) => (n * reached[i]) / (reached[n] || 1);
    // Progress is what has been done, not a guess at what is left: the objects built so far, and
    // the GPU's pipelines finished out of those asked for (their number extrapolated from how far
    // the building is, until it is done). On a first visit the GPU is the long part (every shader
    // compiled afresh, a pipeline at a time), and a bar that waited for it at 94% looked stuck.
    let gpuDone = 0, tracked = 0;
    const track = () => {
      for (; tracked < pending.length; tracked++) pending[tracked].then(() => gpuDone++, () => gpuDone++);
    };
    let shown = 0, gpuSince = 0;
    const report = (built: number) => {
      track();
      const cpu = n ? Math.min(1, built / n) : 1;
      const asked = Math.max(pending.length, 1) / Math.max(cpu, 0.05);
      // (The driver hands its pipelines back late and in a clump, so the count alone sat still
      // then leapt: the bar also eases towards the end with the time the GPU has been at it, a
      // first visit's compile running for tens of seconds, and never claims to be done before it is.)
      if (pending.length && !gpuSince) gpuSince = performance.now();
      const eased = gpuSince ? 0.95 * (1 - Math.exp(-(performance.now() - gpuSince) / 14000)) : 0;
      const gpu = gpuDone >= pending.length && cpu >= 1 ? 1 : Math.min(1, Math.max(gpuDone / asked, Math.min(eased, cpu)));
      // (Never back: the estimate of what is asked for grows as the objects are built.)
      shown = Math.max(shown, Math.min(1, cpu * 0.3 + gpu * 0.7));
      progress?.(Math.round(shown * 1000), 1000);
    };
    let budget = smooth ? 1 : 2;
    let cap = only ? 4 : 64;
    dry(new Set());
    const t = performance.now();
    dry(new Set());
    const base = performance.now() - t;
    for (let i = 0; i < n; ) {
      report(weighed(i));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // (Pipelines already asked for finish on their own.)
      if (cancelled()) return;
      const slice = new Set<THREE.Object3D>();
      let fresh = 0;
      while (i < n && fresh < budget && slice.size < cap) {
        const o = todo[i++];
        const k = buildKey(o);
        if (!seen.has(k)) {
          fresh++;
          seen.add(k);
        }
        slice.add(o);
      }
      const t0 = performance.now();
      dry(slice);
      const ms = performance.now() - t0 - base;
      if (!(await built(slice))) return;
      // (`smooth`, while frames are being drawn: shorter slices, so they keep their pace. Two new
      // builds at most, a tenth of a second or so at High: grown to sixteen after a few quick
      // slices, one held the page for over half a second.)
      const [quick, slow] = smooth ? [12, 30] : [30, 80];
      if (ms < quick) {
        budget = Math.min(budget * 2, smooth ? 2 : 16);
        cap = Math.min(cap * 2, only ? 6 : 64);
      } else if (ms > slow) {
        budget = Math.max(1, budget >> 1);
        cap = Math.max(1, slice.size >> 1);
      }
    }
    dry(null);
    if (!(await built(null))) return;
    if (!only) performance.mark('precompile: pipelines');
    report(n);
    // (Polled: the pipelines finish in clumps, and the bar should move between them.)
    await new Promise<void>((resolve) => {
      const tick = () => {
        report(n);
        if (gpuDone >= pending.length || cancelled()) resolve();
        else setTimeout(tick, 100);
      };
      tick();
    });
  }

  /**
   * Objects that render the scene again for themselves (the sea, for its mirror). They stay in
   * every slice of a precompile, so each slice's objects are built for that pass too: otherwise
   * none are until the last frame, which then builds them all at once (seconds on High and
   * Ultra, with the page frozen).
   */
  readonly passOwners = new Set<THREE.Object3D>();

  /** Where dry frames "draw" instead of the canvas (see dryRun). */
  private dryTarget: GPUTexture | null = null;

  private releaseDryTarget() {
    this.dryTarget?.destroy();
    this.dryTarget = null;
  }

  /**
   * Run `fn`, which renders, as a dry frame: every pipeline it needs is created asynchronously
   * (its promise added to `pending`) and nothing is drawn. Nor is the canvas touched: its
   * texture would be cleared and shown empty, so the page would go blank while shaders compile.
   * A stand-in of the same size and format takes its place and the last real frame stays up.
   */
  /**
   * With `builds`, an object whose shaders aren't built yet is skipped, and its build is added to
   * `builds`, to be run by the caller after the frame, asynchronously (three yields between its
   * stages, so none holds a frame; even starting one does a stage's work, so not within this
   * frame), before running the frame again for their pipelines.
   */
  private dryRun(fn: () => void, pending: Promise<unknown>[], builds?: (() => Promise<unknown>)[]) {
    type Pipelines = { getForRender(ro: unknown, promises?: Promise<unknown>[] | null): unknown };
    type Backend = {
      draw(...args: unknown[]): void;
      clear(color: boolean, depth: boolean, stencil: boolean, descriptor?: { textures: unknown[] | null } | null, ...rest: unknown[]): void;
      isWebGPUBackend?: boolean;
      context?: GPUCanvasContext;
      device?: GPUDevice;
      utils?: { getPreferredCanvasFormat(): GPUTextureFormat };
    };
    type Nodes = { nodeFrame: { update(): void }; get(ro: unknown): { nodeBuilderState?: unknown; dryBuild?: boolean }; nodeBuilderCache?: Map<unknown, unknown>; getForRenderCacheKey?(ro: unknown): unknown };
    type Direct = (this: any, object: unknown, material: unknown, scene: unknown, camera: unknown, lightsNode: unknown, group: unknown, clippingContext: unknown, passId: unknown) => void;
    const r = this.renderer as unknown as { _pipelines: Pipelines; backend: Backend; _nodes: Nodes; _objects: { get(...a: unknown[]): unknown }; _currentRenderContext: unknown; _renderObjectDirect: Direct };
    const pipelines = r._pipelines, backend = r.backend;
    const getForRender = pipelines.getForRender;
    pipelines.getForRender = (ro, promises) => getForRender.call(pipelines, ro, promises ?? pending);
    const nodes = r._nodes;
    // (A URL's ?syncbuilds builds them in the dry frames, as before, to compare.)
    const asyncBuilds = !!builds && stagedBuilds(this.renderer) && !new URLSearchParams(location.search).has('syncbuilds');
    if (asyncBuilds) {
      const direct = r._renderObjectDirect;
      const renderer = this.renderer;
      r._renderObjectDirect = function (this: typeof r, object, material, scene, camera, lightsNode, group, clippingContext, passId) {
        const ro = this._objects.get(object, material, scene, camera, lightsNode, this._currentRenderContext, clippingContext, passId);
        const data = nodes.get(ro);
        if (data.nodeBuilderState === undefined && !nodes.nodeBuilderCache!.has(nodes.getForRenderCacheKey!(ro))) {
          if (!data.dryBuild) {
            data.dryBuild = true;
            // (Built later, in steps, each with the renderer and the lights as this pass has them now: see stagedBuild.)
            const pass = passState(renderer);
            const lights = [...((lightsNode as LightsList | null)?.getLights() ?? [])];
            builds!.push(() => stagedBuild(renderer, ro, pass, lights).finally(() => (data.dryBuild = false)));
          }
          return;
        }
        direct.call(this, object, material, scene, camera, lightsNode, group, clippingContext, passId);
      };
    }
    backend.draw = () => {};
    const context = backend.isWebGPUBackend ? backend.context : undefined;
    if (context && backend.device && backend.utils) {
      const { width, height } = this.canvas;
      if (!this.dryTarget || this.dryTarget.width !== width || this.dryTarget.height !== height) {
        this.dryTarget?.destroy();
        // (WebGPU's usage flags exist at runtime but aren't in the project's type definitions.)
        const usage = (globalThis as unknown as { GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number } }).GPUTextureUsage;
        this.dryTarget = backend.device.createTexture({
          label: 'dry frame',
          size: [width, height],
          format: backend.utils.getPreferredCanvasFormat(),
          usage: usage.RENDER_ATTACHMENT | usage.COPY_SRC,
        });
      }
      const target = this.dryTarget;
      context.getCurrentTexture = () => target;
    } else if (!backend.isWebGPUBackend) {
      // WebGL draws straight into the canvas: skip its clears (render targets still clear), and
      // with nothing drawn the browser keeps showing the last real frame instead of a blank one.
      const clear = backend.clear;
      backend.clear = function (this: Backend, color, depth, stencil, descriptor, ...rest) {
        if (!descriptor || descriptor.textures === null) return;
        clear.call(this, color, depth, stencil, descriptor, ...rest);
      };
    }
    // Every pass runs in a dry frame (the shadow map included, whatever its rate).
    frameState.dry = true;
    const shadowAuto = this.sun.shadow.autoUpdate;
    this.sun.shadow.autoUpdate = true;
    // A frame of its own: the scene, shadow and AO passes run once a frame, and dry frames come
    // between animation frames, so without this all but the first in each would draw nothing
    // (and the real first frame would then build everything at once).
    r._nodes.nodeFrame.update();
    try {
      fn();
    } finally {
      // (All own-property overrides of prototype methods.)
      delete (pipelines as Partial<Pipelines>).getForRender;
      if (asyncBuilds) delete (r as Partial<typeof r>)._renderObjectDirect;
      delete (backend as Partial<Backend>).draw;
      if (Object.prototype.hasOwnProperty.call(backend, 'clear')) delete (backend as Partial<Backend>).clear;
      if (context) delete (context as Partial<GPUCanvasContext>).getCurrentTexture;
      frameState.dry = false;
      this.sun.shadow.autoUpdate = shadowAuto;
      // The dry frame cleared the shadow map without drawing it: the next real frame redraws it
      // whatever the rate.
      this.sun.shadow.needsUpdate = true;
    }
  }

  /** The cameras the scene is drawn from: the view and the sun's shadow (bundles cull for both). */
  private get bundleCameras(): THREE.Camera[] {
    const base = (this._bundleCameras ??= [this.camera, this.sun.shadow!.camera]);
    if (this.quality.reflections <= 0) return base;
    // With the sea's mirror the scene is drawn from below the water too, and its bundles are
    // recorded for that view: so it is watched as well (a boat coming into the reflection alone).
    // Its view is the camera's reflected in the sea, the layers it leaves out left out. (three's
    // own mirror camera clips at the water with an oblique projection, which only culls more.)
    const m = this.mirrorView;
    m.matrixWorld.multiplyMatrices(SEA_MIRROR, this.camera.matrixWorld);
    m.matrixWorldInverse.copy(m.matrixWorld).invert();
    m.projectionMatrix.copy(this.camera.projectionMatrix);
    m.coordinateSystem = this.camera.coordinateSystem;
    m.layers.mask = this.camera.layers.mask;
    m.layers.disable(DETAIL_LAYER);
    return (this._mirrorCameras ??= [...base, m]);
  }
  private _bundleCameras: THREE.Camera[] | undefined;
  private _mirrorCameras: THREE.Camera[] | undefined;
  /** The view of the sea's mirror, for the bundles (see bundleCameras). */
  private mirrorView = new THREE.PerspectiveCamera();

  /** Added to the fog's range while the camera is far above the island (the flat view). */
  fogLift = 0;

  render() {
    if (this.lost || this.canvas.width < 2 || this.canvas.height < 2) return;
    const dry = frameState.dry;
    const started = performance.now();
    // A new pixel ratio at the same CSS size (the window moved to another monitor, a zoom)
    // resizes nothing, so the observer never hears of it: checked here, once a frame.
    if (!dry && (window.devicePixelRatio || 1) !== this.dpr) {
      this.dpr = window.devicePixelRatio || 1;
      this.resize();
    }
    // (A dry frame draws nothing, so a bake in one would leave an empty environment.)
    if (this.envDirty && !dry) this.updateEnvironment();
    if (!dry) {
      frameState.frame++;
      // The sun's shadow map at the preset's rate (casters move slowly; a stale frame doesn't show).
      const every = this.quality.shadowEvery;
      this.sun.shadow.autoUpdate = every <= 1 || frameState.frame % every === 0;
    }
    const f = this.scene.fog;
    if (f instanceof THREE.Fog) {
      this.fogColor.value.copy(f.color);
      this.fogNear.value = f.near + this.fogLift;
      this.fogFar.value = f.far + this.fogLift;
      this.fogReach.value = f.far;
    }
    // Every pass of the frame (shadow map, AO prepass, sea mirror, main) sees the same
    // transforms, so they're brought up to date once here rather than at each render call.
    this.scene.updateMatrixWorld();
    for (const f of this.beforeDraw) f();
    this.camera.updateMatrixWorld();
    this.bundles.update(this.scene, this.bundleCameras);
    cloudField.update(this.renderer, this.camera);
    if (this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
    // (Last frame's instance matrices for the next frame's motion vectors: see instanceBuilds.ts.)
    if (!dry) keepLastMatrices();
    const queue = (this.renderer.backend as { device?: GPUDevice }).device?.queue;
    if (this.timeFrames && !dry && queue) {
      const times = this.frameTimes;
      void queue.onSubmittedWorkDone().then(() => {
        times.push(performance.now() - started);
        if (times.length > 120) times.shift();
      });
    }
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.pipeline?.dispose();
    for (const n of this.postNodes) n.dispose();
    this.postNodes = [];
    this.ambient?.ao.dispose();
    this.ambient = null;
    for (const p of this.scenePasses.values()) p.dispose();
    this.scenePasses.clear();
    this.prePass?.dispose();
    this.envTarget?.dispose();
    this.releaseDryTarget();
    this.pmrem?.dispose();
    for (const sky of [this.sky, this.envSky]) {
      if (!sky) continue;
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
    }
    cloudField.dispose();
    (this.lampLighting as unknown as { dispose?: () => void } | null)?.dispose?.();
    this.renderer.dispose();
  }
}

// ---- staged shader builds (see Stage.dryRun) ----

type Internal = {
  _renderTarget: unknown;
  _activeCubeFace: number;
  _activeMipmapLevel: number;
  _mrt: unknown;
  _outputRenderTarget: unknown;
  _currentRenderContext: unknown;
  contextNode: unknown;
  _nodes: {
    get(ro: unknown): { nodeBuilderState?: unknown };
    nodeBuilderCache: Map<unknown, { usedTimes: number }>;
    getForRenderCacheKey(ro: unknown): unknown;
    _createNodeBuilder(ro: unknown, material: unknown): Builder;
    _createNodeBuilderState(builder: Builder): { usedTimes: number };
  };
};
type Builder = {
  prebuild(): void;
  setBuildStage(stage: string | null): void;
  setShaderStage(stage: string | null): void;
  context: { position?: { isNode?: boolean } };
  flowNodeFromShaderStage(stage: string, node: unknown): void;
  flowNodes: Record<string, { build(builder: Builder): void }[]>;
  flowNode(node: unknown): void;
  buildCode(): void;
  buildUpdateNodes(): void;
};

/** Whether three's internals a staged build uses are there (three r186). */
function stagedBuilds(renderer: THREE.WebGPURenderer) {
  const r = renderer as unknown as Partial<Internal>;
  const n = r._nodes as Partial<Internal['_nodes']> | undefined;
  return !!n && n.nodeBuilderCache instanceof Map && typeof n.getForRenderCacheKey === 'function' && typeof n._createNodeBuilder === 'function' && typeof n._createNodeBuilderState === 'function' && '_renderTarget' in r && '_mrt' in r && '_currentRenderContext' in r;
}

/** The scene's lights for a pass (three's LightsNode). */
type LightsList = { getLights(): THREE.Light[]; setLights(lights: THREE.Light[]): unknown };

/** What a shader build reads from the renderer of the pass it is drawn in. */
type PassState = Pick<Internal, '_renderTarget' | '_activeCubeFace' | '_activeMipmapLevel' | '_mrt' | '_outputRenderTarget' | '_currentRenderContext' | 'contextNode'>;

function passState(renderer: THREE.WebGPURenderer): PassState {
  const r = renderer as unknown as Internal;
  return { _renderTarget: r._renderTarget, _activeCubeFace: r._activeCubeFace, _activeMipmapLevel: r._activeMipmapLevel, _mrt: r._mrt, _outputRenderTarget: r._outputRenderTarget, _currentRenderContext: r._currentRenderContext, contextNode: r.contextNode };
}

/** Run `fn` with the renderer as `pass` had it, and put it back. */
function within<T>(renderer: THREE.WebGPURenderer, pass: PassState, fn: () => T): T {
  const r = renderer as unknown as Internal;
  const was = passState(renderer);
  Object.assign(r, pass);
  try {
    return fn();
  } finally {
    Object.assign(r, was);
  }
}

/**
 * A task's gap, for frames to be drawn in. (A timer, not the scheduler's yield: its continuations
 * run ahead of everything else, so several builds side by side ran stage after stage with no
 * frame between.)
 */
const stageGap = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A render object's shaders built as three's own build does (NodeBuilder.build), a stage at a time
 * with a task between, so no frame waits on a whole build: three's buildAsync does that too, but
 * runs its stages with the renderer as it is then, outside the pass, and a shader built for the
 * wrong render target (no MRT, no depth, none of the pass's context) gives a pipeline that fails,
 * or looks wrong. Each stage here runs with the renderer as the pass that asked had it. The state
 * goes into three's cache as its own build's would.
 */
async function stagedBuild(renderer: THREE.WebGPURenderer, ro: unknown, pass: PassState, lights: THREE.Light[]) {
  const nodes = (renderer as unknown as Internal)._nodes;
  // Each stage with the lights the pass had, too. The scene's lights are its render list's, which
  // every render through that list empties and fills again (and a pass that sees no lights leaves
  // empty): read between frames, they could be none at all, and the material would be built unlit
  // (no sun, no shadow, only the sky's light) and kept in three's cache under its lit key, for every
  // later object like it. (The map editor's 3D draft, warmed this way, would come out in shade.)
  const lightsNode = (ro as { lightsNode?: LightsList | null }).lightsNode ?? null;
  const step = <T>(fn: () => T): T =>
    within(renderer, pass, () => {
      const was = lightsNode?.getLights();
      lightsNode?.setLights(lights);
      try {
        return fn();
      } finally {
        if (lightsNode && was) lightsNode.setLights(was);
      }
    });
  const data = nodes.get(ro);
  if (data.nodeBuilderState !== undefined) return;
  const key = nodes.getForRenderCacheKey(ro);
  const done = () => {
    const cached = nodes.nodeBuilderCache.get(key);
    if (!cached) return false;
    cached.usedTimes++;
    data.nodeBuilderState = cached;
    return true;
  };
  if (done()) return;
  const material = (ro as { material: unknown }).material;
  const builder = step(() => {
    const b = nodes._createNodeBuilder(ro, material);
    b.prebuild();
    return b;
  });
  for (const buildStage of ['setup', 'analyze', 'generate']) {
    for (const shaderStage of ['fragment', 'vertex', 'compute']) {
      await stageGap();
      // (Built meanwhile, a frame drawing it: nothing more to do.)
      if (data.nodeBuilderState !== undefined) return;
      step(() => {
        builder.setBuildStage(buildStage);
        if (shaderStage === 'fragment' && builder.context.position && builder.context.position.isNode) builder.flowNodeFromShaderStage('vertex', builder.context.position);
        builder.setShaderStage(shaderStage);
        for (const node of builder.flowNodes[shaderStage]) {
          if (buildStage === 'generate') builder.flowNode(node);
          else node.build(builder);
        }
      });
    }
  }
  await stageGap();
  if (data.nodeBuilderState !== undefined) return;
  // (Another build of the same shaders may have finished first.)
  if (done()) return;
  step(() => {
    builder.setBuildStage(null);
    builder.setShaderStage(null);
    builder.buildCode();
    builder.buildUpdateNodes();
  });
  const state = nodes._createNodeBuilderState(builder);
  nodes.nodeBuilderCache.set(key, state);
  state.usedTimes++;
  data.nodeBuilderState = state;
}
