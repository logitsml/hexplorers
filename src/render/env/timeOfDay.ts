// Time of day: sun path, light colours, sky, fog and a night factor that drives
// lit windows, lanterns, the lighthouse beam, stars and fireflies.

import * as THREE from 'three/webgpu';
import { keepNormals } from '../util/mrt';
import { uniform, vec4, vec3, Fn, sin, time, attribute, smoothstep, cameraProjectionMatrix, modelViewMatrix, positionGeometry, screenSize, normalize, positionWorld, cameraPosition } from 'three/tsl';
import type { Stage } from '../core/stage';

export type TimeMode = 'dynamic' | 'daytime' | 'morning' | 'noon' | 'golden' | 'dusk' | 'night';

/** Day phase 0..1: 0 = dawn, 0.25 = noon, 0.45 = golden hour, 0.52 = sunset, 0.6–0.9 night. */
export const PRESETS: Record<Exclude<TimeMode, 'dynamic' | 'daytime'>, number> = {
  morning: 0.12,
  noon: 0.25,
  golden: 0.42,
  dusk: 0.53,
  night: 0.72,
};

/** Daytime mode stays between these phases (morning to late afternoon, sun well up). */
const DAY_START = 0.13;
const DAY_END = 0.4;

interface Key {
  t: number;
  elev: number;
  az: number;
  sun: string;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  fog: string;
  exposure: number;
  env: number;
  turbidity: number;
  rayleigh: number;
  night: number;
  /** Grade: white balance (r, g, b gains). */
  wb: [number, number, number];
  /** Grade: shadow tint and its strength (shadows lean towards the sky). */
  shadow: [string, number];
  /** Grade: highlight tint and its strength (lit surfaces lean towards the sun). */
  light: [string, number];
  sat: number;
}

// Keyframes around the day (azimuth in degrees, clockwise from north).
const KEYS: Key[] = [
  { t: 0.0, elev: 4, az: 80, sun: '#ffb07a', sunI: 2.0, hemiSky: '#b4b2d6', hemiGround: '#5b4a3a', hemiI: 0.4, fog: '#e3c9b8', exposure: 1.12, env: 0.28, turbidity: 6, rayleigh: 2.2, night: 0.15, wb: [1.05, 1.0, 0.96], shadow: ['#6f78b8', 0.1], light: ['#ffc9a0', 0.08], sat: 1.04 },
  { t: 0.12, elev: 24, az: 120, sun: '#ffe2bd', sunI: 3.6, hemiSky: '#aac6ee', hemiGround: '#6f6a45', hemiI: 0.52, fog: '#c7dbe6', exposure: 1.03, env: 0.32, turbidity: 3.2, rayleigh: 1.4, night: 0, wb: [1.03, 1.0, 0.97], shadow: ['#6b8cc4', 0.08], light: ['#ffe6c8', 0.05], sat: 1.08 },
  { t: 0.25, elev: 52, az: 200, sun: '#fff6ea', sunI: 4.2, hemiSky: '#a8c4ea', hemiGround: '#6f6a45', hemiI: 0.45, fog: '#bcd6e6', exposure: 1.0, env: 0.34, turbidity: 2.6, rayleigh: 1.2, night: 0, wb: [1.02, 1.0, 0.97], shadow: ['#6e88aa', 0.06], light: ['#fff4e0', 0.03], sat: 1.08 },
  { t: 0.36, elev: 36, az: 268, sun: '#fff1de', sunI: 4.2, hemiSky: '#a9c5ec', hemiGround: '#6f6a45', hemiI: 0.52, fog: '#bfd5e2', exposure: 1.08, env: 0.32, turbidity: 3.2, rayleigh: 1.35, night: 0, wb: [1.03, 1.0, 0.965], shadow: ['#6d8cc2', 0.07], light: ['#ffeed6', 0.04], sat: 1.08 },
  { t: 0.45, elev: 13, az: 292, sun: '#ffcf96', sunI: 3.9, hemiSky: '#a9bcd6', hemiGround: '#766a45', hemiI: 0.5, fog: '#e8cdb0', exposure: 1.28, env: 0.3, turbidity: 4.8, rayleigh: 2.0, night: 0.05, wb: [1.06, 1.0, 0.93], shadow: ['#576697', 0.12], light: ['#ffcf96', 0.1], sat: 1.12 },
  { t: 0.52, elev: 3, az: 300, sun: '#ff9a5c', sunI: 2.1, hemiSky: '#a99ac6', hemiGround: '#4a3a30', hemiI: 0.34, fog: '#8a6a62', exposure: 1.28, env: 0.24, turbidity: 8, rayleigh: 3.0, night: 0.45, wb: [1.07, 0.99, 0.94], shadow: ['#594a82', 0.14], light: ['#ffa070', 0.1], sat: 1.08 },
  { t: 0.6, elev: -12, az: 320, sun: '#9fb3ff', sunI: 1.3, hemiSky: '#5b6a9c', hemiGround: '#2a2833', hemiI: 0.44, fog: '#2a3552', exposure: 1.2, env: 0.2, turbidity: 2, rayleigh: 1, night: 0.95, wb: [0.95, 0.98, 1.05], shadow: ['#2a3558', 0.14], light: ['#ffffff', 0], sat: 0.88 },
  { t: 0.75, elev: -32, az: 10, sun: '#b0c2ff', sunI: 1.5, hemiSky: '#52619a', hemiGround: '#24232e', hemiI: 0.48, fog: '#1f2944', exposure: 1.25, env: 0.2, turbidity: 2, rayleigh: 0.6, night: 1, wb: [0.94, 0.98, 1.06], shadow: ['#212c4c', 0.15], light: ['#ffffff', 0], sat: 0.85 },
  { t: 0.9, elev: -10, az: 60, sun: '#9fb3ff', sunI: 1.3, hemiSky: '#5b6a9c', hemiGround: '#2a2833', hemiI: 0.44, fog: '#2f3a5a', exposure: 1.2, env: 0.2, turbidity: 2, rayleigh: 1, night: 0.9, wb: [0.95, 0.98, 1.05], shadow: ['#2a3558', 0.14], light: ['#ffffff', 0], sat: 0.88 },
  { t: 1.0, elev: 4, az: 80, sun: '#ffb07a', sunI: 2.0, hemiSky: '#b4b2d6', hemiGround: '#5b4a3a', hemiI: 0.4, fog: '#e3c9b8', exposure: 1.12, env: 0.28, turbidity: 6, rayleigh: 2.2, night: 0.15, wb: [1.05, 1.0, 0.96], shadow: ['#6f78b8', 0.1], light: ['#ffc9a0', 0.08], sat: 1.04 },
];

/** Where the moon hangs: the night's key light comes from it (see apply). */
const MOON_ELEVATION = 38;
const MOON_AZIMUTH = 230;

/**
 * 0..1 how much the moon shows (night, sun well down). The sea takes it up as the glitter of a
 * moon path, since at night its key light, and so its glint, comes from the moon.
 */
export const moonGlow = uniform(0);

/** Share of the sky environment used as diffuse light. */
const DIFFUSE_ENV = 0.4;

/** Key colours parsed once (they are interpolated every frame). */
const parsed = new Map<string, THREE.Color>();
const colorOf = (hex: string) => {
  let c = parsed.get(hex);
  if (!c) parsed.set(hex, (c = new THREE.Color(hex)));
  return c;
};

function lerpColor(a: string, b: string, t: number, out: THREE.Color) {
  return out.copy(colorOf(a)).lerp(colorOf(b), t);
}

const _ca = new THREE.Color(), _cb = new THREE.Color();
const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** A tint as (colour at unit luminance, strength), blended between two keys. */
function lerpTint(a: [string, number], b: [string, number], t: number, out: THREE.Vector4) {
  _ca.copy(colorOf(a[0])).multiplyScalar(1 / lum(colorOf(a[0])));
  _cb.copy(colorOf(b[0])).multiplyScalar(1 / lum(colorOf(b[0])));
  _ca.lerp(_cb, t);
  return out.set(_ca.r, _ca.g, _ca.b, a[1] + (b[1] - a[1]) * t);
}

export class TimeOfDay {
  /** Sky reflection strength for glossy materials (see apply()). */
  reflections = 0.3;
  /** Current day phase 0..1. */
  phase = PRESETS.golden;
  target = PRESETS.golden;
  mode: TimeMode = 'dynamic';
  night = uniform(0);
  private lastEnvPhase = -1;
  private lastEnvCloud = -1;
  private envTimer = 0;
  stars: THREE.Mesh;
  private starMat: THREE.MeshBasicNodeMaterial;
  /** Star radius in drawing-buffer pixels (follows the pixel ratio), and how clear the sky is. */
  private starPx = uniform(1.5);
  private starClear = uniform(1);

  constructor(private stage: Stage) {
    // Stars on a large dome, fading in at night. Each is a small quad held at a constant size on
    // screen: WebGPU draws points one pixel wide whatever their size, and temporal AA and depth
    // of field all but erased those.
    const n = 900;
    const pos = new Float32Array(n * 4 * 3);
    const corner = new Float32Array(n * 4 * 2);
    const tw = new Float32Array(n * 4);
    const size = new Float32Array(n * 4);
    const index: number[] = [];
    const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 0.9 + 0.1;
      const th = Math.random() * Math.PI * 2;
      const r = 380;
      const y = u;
      const s = Math.sqrt(1 - y * y);
      // A few bright stars among many faint ones.
      const big = 0.6 + Math.pow(Math.random(), 3) * 1.1;
      const phase = Math.random() * 10;
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        pos.set([Math.cos(th) * s * r, y * r, Math.sin(th) * s * r], v * 3);
        corner.set([CORNERS[k * 2], CORNERS[k * 2 + 1]], v * 2);
        tw[v] = phase;
        size[v] = big;
      }
      index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('tw', new THREE.BufferAttribute(tw, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setIndex(index);
    this.starMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.starMat.forceSinglePass = true;
    const night = this.night;
    const c = attribute<'vec2'>('aCorner', 'vec2');
    const big = attribute<'float'>('aSize', 'float');
    this.starMat.vertexNode = Fn(() => {
      const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(positionGeometry, 1))).toVar();
      clip.xy.addAssign(c.mul(big.mul(this.starPx).mul(2)).div(screenSize).mul(clip.w));
      return clip;
    })();
    // Bright enough (past 1) that the blur of depth of field and the temporal resolve leave a point.
    this.starMat.colorNode = vec4(vec3(1, 0.97, 0.9).mul(big.mul(1.4)), 1);
    this.starMat.opacityNode = Fn(() => {
      const twinkle = sin(time.mul(2).add(attribute<'float'>('tw', 'float'))).mul(0.3).add(0.7);
      // Behind the sky's clouds as the moon is (thin cloud lets a few through).
      const cloud = stage.sky.clouds(normalize(positionWorld.sub(cameraPosition))).alpha;
      return night.mul(twinkle).mul(smoothstep(1, 0.2, c.length())).mul(cloud.oneMinus()).mul(this.starClear);
    })();
    keepNormals(this.starMat);
    this.stars = new THREE.Mesh(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;
    stage.scene.add(this.stars);
    const el = THREE.MathUtils.degToRad(MOON_ELEVATION), az = THREE.MathUtils.degToRad(MOON_AZIMUTH);
    stage.sky.moonDirection.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  }

  /** Jump straight to the target (new game) instead of animating through the day. */
  snap() {
    this.phase = this.target;
    this.lastEnvPhase = -1;
    this.envTimer = 0;
  }

  /**
   * `quick`: the player chose the time in Settings, so the day sweeps to it in a couple of seconds
   * (easing in to it) instead of drifting at the game's pace, and the sky's reflections are
   * rebaked more often on the way and once more on arrival, so nothing lags behind the light.
   */
  setMode(mode: TimeMode, quick = false) {
    this.mode = mode;
    this.retarget();
    this.rushing = quick;
  }

  /** Sweeping to a time the player chose (see setMode), until it's there. */
  private rushing = false;

  private turn = 0;
  private players = 4;
  private frozen: number | null = null;

  /** Hold the day at one phase whatever the mode and turns (the `?time=` debug parameter). */
  freeze(phase: number) {
    this.frozen = this.phase = this.target = phase;
    this.snap();
  }

  setTurn(turn: number, players: number) {
    this.turn = turn;
    this.players = players;
    this.retarget();
  }

  /**
   * Dynamic: one full day and night every ~10 rounds, starting in the morning. Daytime: the
   * sun drifts from morning to late afternoon over ~8 rounds and slowly back, never setting.
   */
  private retarget() {
    if (this.frozen !== null) {
      this.target = this.frozen;
      return;
    }
    const rounds = this.turn / Math.max(1, this.players);
    if (this.mode === 'dynamic') this.target = (0.1 + rounds / 10) % 1;
    else if (this.mode === 'daytime') {
      const u = (rounds / 8) % 2;
      this.target = DAY_START + (u < 1 ? u : 2 - u) * (DAY_END - DAY_START);
    } else this.target = PRESETS[this.mode];
  }

  update(dt: number) {
    // Move the day phase smoothly towards the target (always forwards).
    let d = this.target - this.phase;
    if (Math.abs(d) < 1e-4) d = 0;
    if (d < -0.5) d += 1;
    // Dynamic time only moves forward (through the night to the next morning), never backwards.
    if (d < -1e-3 && this.mode === 'dynamic') d += 1;
    // (In a rush: up to a third of a day a second, slowing as it nears the time chosen.)
    const rate = this.rushing ? Math.max(0.035, Math.min(0.32, Math.abs(d) * 2.6)) : 0.035;
    const step = Math.sign(d) * Math.min(Math.abs(d), dt * rate);
    this.phase = (this.phase + step + 1) % 1;
    if (this.rushing && Math.abs(d - step) < 1e-4) {
      this.rushing = false;
      // (The reflections catch up with the light now it has arrived.)
      this.envTimer = 0;
      this.lastEnvPhase = -1;
    }
    this.apply(dt);
  }

  private apply(dt: number) {
    const p = this.phase;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].t < p) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const u = THREE.MathUtils.smoothstep(p, a.t, b.t);
    const L = (x: number, y: number) => x + (y - x) * u;
    const st = this.stage;
    let az = b.az - a.az;
    if (az > 180) az -= 360;
    if (az < -180) az += 360;
    const elev = L(a.elev, b.elev);
    const azimuth = a.az + az * u;
    // Below the horizon the key light becomes moonlight from high in the south-west; the sky keeps the true sun.
    const sunUp = THREE.MathUtils.smoothstep(elev, -4, 6);
    const lightEl = Math.max(elev, 0) * sunUp + MOON_ELEVATION * (1 - sunUp);
    const lightAz = sunUp > 0.5 ? azimuth : MOON_AZIMUTH;
    st.setSun(lightEl, sunUp > 0.02 && sunUp < 0.98 ? azimuth * sunUp + MOON_AZIMUTH * (1 - sunUp) : lightAz, elev, azimuth);
    lerpColor(a.sun, b.sun, u, st.sun.color);
    st.sun.intensity = L(a.sunI, b.sunI);
    lerpColor(a.hemiSky, b.hemiSky, u, st.hemi.color);
    // (By day the ground bounce is olive: the island is mostly green, ringed by sea.)
    lerpColor(a.hemiGround, b.hemiGround, u, st.hemi.groundColor);
    st.hemi.intensity = L(a.hemiI, b.hemiI);
    if (st.scene.fog instanceof THREE.Fog) lerpColor(a.fog, b.fog, u, st.scene.fog.color);
    st.renderer.toneMappingExposure = L(a.exposure, b.exposure);
    // The sky environment is mostly a reflection source: as diffuse fill it flattens the sun's
    // shading and shadows, so only a fraction lights surfaces (the hemisphere light is the fill).
    // Glossy materials (the sea) take the full level through `reflections`.
    this.reflections = L(a.env, b.env);
    st.scene.environmentIntensity = this.reflections * DIFFUSE_ENV;
    st.sky.turbidity.value = L(a.turbidity, b.turbidity);
    st.sky.rayleigh.value = L(a.rayleigh, b.rayleigh);
    this.night.value = L(a.night, b.night);
    // The moon rises into view as the night deepens; stars and moon hide behind thick cloud
    // (the sky's own clouds cover the moon; the stars are drawn over the sky, so they fade).
    moonGlow.value = THREE.MathUtils.smoothstep(this.night.value, 0.45, 0.9) * (1 - sunUp);
    st.sky.moonLight.value = moonGlow.value;
    this.starClear.value = 1 - THREE.MathUtils.smoothstep(st.sky.cloudCoverage.value, 0.45, 0.8);
    this.stars.visible = this.night.value > 0.01;
    // (In the scene's own pixels: see Stage.sceneScale.)
    this.starPx.value = 1.5 * st.scenePixelRatio;
    // Grade.
    st.grade.balance.value.set(L(a.wb[0], b.wb[0]), L(a.wb[1], b.wb[1]), L(a.wb[2], b.wb[2]));
    lerpTint(a.shadow, b.shadow, u, st.grade.shadows.value);
    lerpTint(a.light, b.light, u, st.grade.highlights.value);
    st.grade.saturation.value = L(a.sat, b.sat);
    st.skyTint.value.copy(st.hemi.color).multiplyScalar(1 / lum(st.hemi.color));
    // Haze glows towards the real sun in its colour (the light at night is the moon).
    st.fogSunDir.value.copy(st.sky.sunPosition.value).normalize();
    const fogL = st.scene.fog instanceof THREE.Fog ? lum(st.scene.fog.color) : 0.5;
    const sunUpSky = THREE.MathUtils.smoothstep(elev, -6, 2);
    st.fogSun.value.copy(st.sun.color).multiplyScalar((fogL * 1.7 * sunUpSky) / Math.max(1e-4, lum(st.sun.color)));
    if (st.scene.fog instanceof THREE.Fog) st.fogSun.value.lerp(st.scene.fog.color, 1 - sunUpSky);
    // Refresh the reflection environment occasionally while the light changes.
    this.envTimer -= dt;
    // (Also when the weather has changed the cloud cover since the last bake.)
    const cloud = st.sky.cloudCoverage.value;
    if (this.envTimer <= 0 && (Math.abs(p - this.lastEnvPhase) > 0.01 || Math.abs(cloud - this.lastEnvCloud) > 0.05)) {
      this.envTimer = this.rushing ? 0.45 : 1.5;
      this.lastEnvPhase = p;
      this.lastEnvCloud = cloud;
      // (Baked at the next frame that is drawn: none while the flat map or a compile hides the island.)
      st.requestEnvironment();
    }
  }

  dispose() {
    this.stars.geometry.dispose();
    this.starMat.dispose();
    this.stars.removeFromParent();
  }
}
