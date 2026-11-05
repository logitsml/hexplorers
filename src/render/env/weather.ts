// Weather: every few minutes a shower passes over the island. Cloud cover thickens and the
// light dims, rain streaks fall (animated entirely on the GPU), drops ring the sea, the ground
// darkens and turns glossy, and if the sun is up as it clears, a rainbow arcs over the sea.

import * as THREE from 'three/webgpu';
import { windDir, windStrength } from './wind';
import { Fn, attribute, cameraPosition, float, fract, mix, mod, normalize, positionGeometry, positionWorld, smoothstep, time, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { Stage } from '../core/stage';
import { keepNormals } from '../util/mrt';
import { DETAIL_LAYER, SEA_LEVEL } from '../board/layout';
import { Lightning } from './lightning';

/** The haze lit by lightning: a cold blue-white. */
const FLASH = new THREE.Color('#d8e2ff');
const FLASH_NIGHT = new THREE.Color('#5a6688');

/** Shadow tint under cloud: a soft grey (#8f9aa3) at unit luminance. */
const OVERCAST_SHADE = (() => {
  const c = new THREE.Color('#8f9aa3');
  return c.multiplyScalar(1 / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
})();

const DROPS = 2400;
/** Half the side of the square of rain, centred on where the camera looks. */
const AREA = 10;
const TOP = 6;

type Phase = 'clear' | 'gathering' | 'raining' | 'clearing';

/**
 * A change the player makes in Settings runs this much quicker (see Weather.pace) until the sky,
 * the rain and the ground have come to it (at most RUSH_SECONDS), then eases back over a second.
 */
const RUSH_SECONDS = 12;
const RUSH_PACE = 6;

/** 'changing' brings passing showers now and then; the others hold one kind of weather. */
export type WeatherMode = 'changing' | 'clear' | 'cloudy' | 'rain' | 'storm';

/** Cloud and rain each held mode settles to. */
const HELD: Record<Exclude<WeatherMode, 'changing'>, { cloud: number; rain: number; storm: number }> = {
  clear: { cloud: 0, rain: 0, storm: 0 },
  cloudy: { cloud: 0.75, rain: 0, storm: 0 },
  rain: { cloud: 1, rain: 0.75, storm: 0 },
  storm: { cloud: 1, rain: 1, storm: 1 },
};

export class Weather {
  /** 0..1 how hard it is raining. */
  rain = uniform(0);
  /** 0..1 how wet surfaces are (follows rain, dries slowly). */
  wet = uniform(0);
  /** 0..1 cloud cover beyond the fair-weather baseline. */
  overcast = 0;
  rainbow = uniform(0);
  /** 0..1 how stormy: stronger wind and lightning. */
  storm = 0;
  /**
   * How fast the weather is turning now: 1 as it comes and goes in play, several times that for a
   * few seconds after the player picks the weather in Settings (see setMode), so the sky, the rain,
   * the wet ground, the puddles and the sea come to it in a few seconds rather than half a minute.
   * The puddles and the sea's swell read it too (World, OceanSim).
   */
  pace = 1;
  private rush = 0;
  /** How fast wet ground and puddles dry now: as in play, or in a rush a good deal faster still (drying is the slowest part). */
  get dryPace() {
    return this.pace > 1 ? this.pace * 1.6 : 1;
  }
  mode: WeatherMode = 'changing';
  private nextFlash = 3;
  /** How much light the strike throws on the scene now, eased (see update). */
  private flashLevel = 0;
  /** Called with the rain level for the ambience. */
  onRain: ((level: number) => void) | null = null;
  /** Called at each strike with the seconds until its thunder is heard and how near it is (0..1). */
  onThunder: ((delay: number, near: number) => void) | null = null;
  /** Called where a bolt meets the sea, with how near it is (0..1). */
  onStrike: ((at: THREE.Vector3, near: number) => void) | null = null;
  /** Softer lightning, one slow glow and no flicker, for players who reduce motion. */
  gentle: () => boolean = () => false;
  /** How far the island's coast reaches from its middle (bolts strike the sea beyond it). */
  coast = 5;
  /** The island's middle (on the sea plane: x and z), which `coast` is measured from. */
  readonly centre = new THREE.Vector2();
  private bolt = new Lightning();
  /** The strike under way: its age, when each stroke fires, how hard the scene flashes. */
  private strike: { t: number; strokes: number[]; flash: number; bolt: boolean; gentle: boolean } | null = null;

  group = new THREE.Group();
  private phase: Phase = 'clear';
  private timer = 70 + Math.random() * 110;
  private rainbowHold = 0;
  private drops: THREE.Mesh;
  private bow: THREE.Mesh;
  private disposables: { dispose(): void }[] = [];
  /** Where the rain falls round: the point on the sea the camera looks at. */
  private rainCentre = uniform(new THREE.Vector2());
  private look = new THREE.Vector3();
  private seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SEA_LEVEL);
  private ray = new THREE.Ray();

  constructor(private stage: Stage) {
    // ---- rain streaks: thin camera-facing quads; position and fall are computed in the shader.
    const geo = new THREE.PlaneGeometry(0.009, 0.24);
    geo.translate(0, 0.12, 0);
    const seeds = new Float32Array(DROPS * 3);
    for (let i = 0; i < DROPS; i++) seeds.set([(Math.random() * 2 - 1) * AREA, Math.random(), (Math.random() * 2 - 1) * AREA], i * 3);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const seed = attribute<'vec3'>('aSeed', 'vec3');
    const rain = this.rain;
    const around = this.rainCentre;
    mat.positionNode = Fn(() => {
      // Falling at ~7 units/s with a slight wind slant; wrapped through the column.
      const h = float(TOP - SEA_LEVEL);
      const y = fract(seed.y.sub(time.mul(1.2))).mul(h).add(SEA_LEVEL);
      const fallen = h.sub(y.sub(SEA_LEVEL));
      // Each drop keeps its place on a grid of squares tiling the world, and the one square in
      // use is the one round where the camera looks: as the view moves, drops leaving one side
      // come in at the other, so the rain follows it without a drop jumping in view.
      const x = mod(seed.x.sub(around.x).add(AREA), AREA * 2).sub(AREA).add(around.x);
      const z = mod(seed.z.sub(around.y).add(AREA), AREA * 2).sub(AREA).add(around.y);
      // (Slanting downwind with the scene's one wind, harder as it rises: see wind.ts.)
      const slant = windDir.mul(windStrength.mul(0.09).add(0.03));
      const centre = vec3(x.add(fallen.mul(slant.x)), y, z.add(fallen.mul(slant.y)));
      // Cylindrical billboard: the streak stays vertical but turns to face the camera.
      const toCam = normalize(vec2(cameraPosition.x.sub(centre.x), cameraPosition.z.sub(centre.z)));
      const right = vec3(toCam.y.negate(), 0, toCam.x);
      return centre.add(right.mul(positionGeometry.x)).add(vec3(slant.x.negate(), 1, slant.y.negate()).mul(positionGeometry.y));
    })();
    mat.colorNode = vec4(0.82, 0.88, 0.95, 1);
    mat.opacityNode = Fn(() => {
      const along = positionGeometry.y.div(0.24);
      // Streaks right in front of the lens would read as white poles: fade them out up close.
      const near = smoothstep(0.6, 2.5, positionWorld.sub(cameraPosition).length());
      return rain.mul(0.55).mul(smoothstep(0, 0.4, along)).mul(smoothstep(1, 0.6, along)).mul(near);
    })();
    // One draw for both faces: thin streaks, and their order among themselves doesn't show.
    mat.forceSinglePass = true;
    keepNormals(mat);
    // (`count` instances of one streak, placed by the shader: no instance matrices needed.)
    this.drops = new THREE.Mesh(geo, mat);
    this.drops.count = DROPS;
    this.drops.frustumCulled = false;
    this.drops.renderOrder = 30;
    this.drops.layers.set(DETAIL_LAYER);
    this.drops.visible = false;
    this.group.add(this.drops);
    this.disposables.push(geo, mat);

    // ---- rainbow: a flat ring segment far out, coloured by radius, fading at its feet.
    const inner = 78, outer = 85;
    const bowGeo = new THREE.RingGeometry(inner, outer, 96, 1, 0, Math.PI);
    const bowMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    bowMat.fog = false;
    const bow = this.rainbow;
    bowMat.colorNode = Fn(() => {
      const r = positionGeometry.xy.length();
      const t = r.sub(inner).div(outer - inner); // 0 inside (violet) .. 1 outside (red)
      const red = vec3(0.95, 0.25, 0.2), orange = vec3(1.0, 0.6, 0.15), yellow = vec3(1.0, 0.92, 0.3);
      const green = vec3(0.3, 0.85, 0.35), blue = vec3(0.25, 0.5, 1.0), violet = vec3(0.55, 0.3, 0.9);
      const c = mix(violet, blue, smoothstep(0.0, 0.2, t));
      const c2 = mix(c, green, smoothstep(0.2, 0.4, t));
      const c3 = mix(c2, yellow, smoothstep(0.4, 0.6, t));
      const c4 = mix(c3, orange, smoothstep(0.6, 0.78, t));
      return vec4(mix(c4, red, smoothstep(0.78, 0.95, t)), 1);
    })();
    bowMat.opacityNode = Fn(() => {
      const r = positionGeometry.xy.length();
      const t = r.sub(inner).div(outer - inner);
      const band = smoothstep(0.0, 0.12, t).mul(smoothstep(1.0, 0.85, t));
      // Fade where it meets the sea, strongest at the top of the arc.
      const height = positionGeometry.y.div(outer);
      return bow.mul(0.35).mul(band).mul(smoothstep(0.0, 0.35, height));
    })();
    bowMat.forceSinglePass = true;
    keepNormals(bowMat);
    this.bow = new THREE.Mesh(bowGeo, bowMat);
    // After the sea (10): drawn before it, the water painted over the arc wherever it lay behind.
    // (Its feet still go under the sea's surface, which writes depth.)
    this.bow.renderOrder = 11;
    this.bow.visible = false;
    this.group.add(this.bow);
    this.disposables.push(bowGeo, bowMat);
    this.group.add(this.bolt.mesh);
  }

  /** Start a shower now (debug / testing). */
  forceShower() {
    this.phase = 'gathering';
    this.timer = 6;
  }

  /** `quick`: the player chose it, so it comes on in a few seconds (see pace). */
  setMode(mode: WeatherMode, night = 0, quick = false) {
    if (mode === this.mode) return;
    const wasRaining = this.rain.value > 0.3;
    this.mode = mode;
    if (quick) {
      this.rush = RUSH_SECONDS;
      // (A storm chosen strikes soon, rather than after the usual wait.)
      if (mode === 'storm') this.nextFlash = Math.min(this.nextFlash, 2.5);
    }
    if (mode === 'changing') {
      // Carry on from the weather as it is now.
      this.phase = wasRaining ? 'raining' : this.overcast > 0.4 ? 'clearing' : 'clear';
      this.timer = wasRaining ? 30 : 40;
    } else if (wasRaining && HELD[mode].rain === 0 && night < 0.2 && this.stage.sunDir.y > 0.05) {
      // Rain stopping in daylight leaves a rainbow, as it does when a shower passes.
      this.rainbowHold = 32;
      this.bowPlaced = false;
    }
  }

  /**
   * Advance the weather and apply it on top of the time-of-day lighting (which TimeOfDay
   * rewrites every frame, so this only ever scales its values).
   */
  update(dt: number, night: number) {
    this.timer -= dt;
    // (The rush eases off over its last second, so the weather settles rather than stops short.)
    this.rush = Math.max(0, this.rush - dt);
    this.pace = 1 + (RUSH_PACE - 1) * Math.min(1, this.rush);
    switch (this.mode === 'changing' ? this.phase : null) {
      case 'clear':
        if (this.timer <= 0) {
          this.phase = 'gathering';
          this.timer = 14 + Math.random() * 8;
        }
        break;
      case 'gathering':
        if (this.timer <= 0) {
          this.phase = 'raining';
          this.timer = 35 + Math.random() * 40;
        }
        break;
      case 'raining':
        if (this.timer <= 0) {
          this.phase = 'clearing';
          this.timer = 18;
          // A rainbow needs the sun out. (Artistic licence: it is placed where the camera can
          // see it, in the sky behind the island, rather than exactly opposite the sun.)
          this.rainbowHold = night < 0.2 && this.stage.sunDir.y > 0.05 ? 32 : 0;
          this.bowPlaced = false;
        }
        break;
      case 'clearing':
        if (this.timer <= 0) {
          this.phase = 'clear';
          this.timer = 160 + Math.random() * 200;
        }
        break;
    }
    const k = Math.min(1, dt * 0.25 * this.pace);
    const held = this.mode === 'changing' ? null : HELD[this.mode];
    // (Settled: the rush winds down. Its last second eases the pace back to play's.)
    if (this.rush > 1 && Math.abs(this.overcast - (held ? held.cloud : this.overcast)) < 0.03 && Math.abs(this.rain.value - (held ? held.rain : this.rain.value)) < 0.03 && Math.abs(this.wet.value - (this.rain.value > 0.15 ? 1 : 0)) < 0.05) this.rush = 1;
    const wantCloud = held ? held.cloud : this.phase === 'gathering' || this.phase === 'raining' ? 1 : this.phase === 'clearing' ? 0.35 : 0;
    const wantRain = held ? held.rain : this.phase === 'raining' ? 1 : 0;
    this.storm += ((held?.storm ?? 0) - this.storm) * k;
    this.overcast += (wantCloud - this.overcast) * k;
    this.rain.value += (wantRain - this.rain.value) * Math.min(1, dt * 0.35 * this.pace);
    // Wet quickly in rain, dry slowly afterwards (and quickly too when the player clears the sky).
    const wetTarget = this.rain.value > 0.15 ? 1 : 0;
    this.wet.value += (wetTarget - this.wet.value) * Math.min(1, dt * (wetTarget ? 0.2 * this.pace : 0.03 * this.dryPace));
    this.rainbowHold = Math.max(0, this.rainbowHold - dt);
    const bowTarget = this.rainbowHold > 4 ? 1 : 0;
    this.rainbow.value += (bowTarget - this.rainbow.value) * Math.min(1, dt * 0.3 * Math.min(2, this.pace));
    this.drops.visible = this.rain.value > 0.01;
    if (this.drops.visible) this.followCamera();
    this.bow.visible = this.rainbow.value > 0.01;
    this.onRain?.(this.rain.value);

    // Light and sky.
    const st = this.stage;
    const o = this.overcast;
    st.sun.intensity *= 1 - 0.65 * o;
    st.hemi.intensity *= 1 + 0.25 * o;
    // Overcast reads soft rather than just dark: the sun is already cut, so the grade greys
    // and desaturates instead of the exposure dropping too.
    st.grade.saturation.value *= 1 - 0.15 * o;
    const sh = st.grade.shadows.value;
    sh.set(sh.x + (OVERCAST_SHADE.r - sh.x) * o, sh.y + (OVERCAST_SHADE.g - sh.y) * o, sh.z + (OVERCAST_SHADE.b - sh.z) * o, sh.w);
    st.scene.environmentIntensity *= 1 - 0.35 * o;
    st.sky.cloudCoverage.value = 0.38 + 0.5 * o;
    st.sky.cloudDensity.value = 0.5 + 0.4 * o;
    if (st.scene.fog instanceof THREE.Fog) {
      // (The overcast grey in the light there is: a storm at night closes in dark, not as a pale band on the horizon.)
      this.greyNow.copy(this.grey).multiplyScalar(1 - 0.88 * night);
      st.scene.fog.color.lerp(this.greyNow, 0.55 * o);
      st.scene.fog.near = 38 - 24 * this.rain.value;
      st.scene.fog.far = 210 - 90 * this.rain.value;
    }
    // Storm: now and then lightning, mostly a bolt down to the sea, sometimes the clouds lit
    // from within; the whole scene flashes with each stroke, and the thunder follows.
    if (this.storm > 0.6) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0 && !this.strike) {
        this.begin(Math.random() < 0.72);
        this.nextFlash = 5 + Math.random() * 10;
      }
    }
    // The strokes themselves are quick (the bolt is drawn at their pace), but the light they throw
    // on the scene is eased: it swells over a tenth of a second and fades over half a second, so a
    // strike brightens the sea and clouds like a passing glare rather than strobing the whole
    // frame (a single stroke's own 40 ms spike, and its return strokes, were a hard flash).
    const raw = this.lightning(dt);
    this.flashLevel += (raw - this.flashLevel) * (1 - Math.exp(-dt / (raw > this.flashLevel ? 0.14 : 0.5)));
    const f = this.flashLevel < 0.002 ? 0 : this.flashLevel;
    // The flash lights the clouds from within, brightest round the strike.
    st.sky.flash.value = f;
    if (f > 0) {
      st.hemi.intensity *= 1 + 1.6 * f;
      st.renderer.toneMappingExposure *= 1 + 0.1 * f;
      // (At night the flash lights the haze a cold blue-grey, not white.)
      if (st.scene.fog instanceof THREE.Fog) st.scene.fog.color.lerp(this.greyNow.copy(FLASH).lerp(FLASH_NIGHT, night), Math.min(0.3, 0.3 * f));
    }
    if (this.bow.visible && !this.bowPlaced) this.placeRainbow();
  }

  /** Centre the rain on the point of the sea the camera looks at (or below it, looking up). */
  private followCamera() {
    const cam = this.stage.camera;
    this.ray.origin.copy(cam.position);
    cam.getWorldDirection(this.ray.direction);
    const hit = this.ray.intersectPlane(this.seaPlane, this.look);
    const p = hit && hit.distanceTo(cam.position) < 40 ? hit : this.look.copy(cam.position);
    // (No easing needed: the drops stay put in the world, this only picks which of them show.)
    this.rainCentre.value.set(p.x, p.z);
  }

  /** Strike now (debug / testing). */
  forceStrike(bolt = true) {
    this.strike = null;
    this.begin(bolt);
  }

  private begin(bolt: boolean) {
    const gentle = this.gentle();
    const eye = this.stage.camera.position;
    // Return strokes follow the first down the same channel a few hundredths of a second later:
    // the flicker of real lightning. Never more than three, for players sensitive to flashing.
    const strokes = [0];
    if (!gentle) {
      if (Math.random() < 0.8) strokes.push(0.05 + Math.random() * 0.06);
      if (Math.random() < 0.45) strokes.push(strokes[strokes.length - 1] + 0.06 + Math.random() * 0.1);
    }
    let near = 0;
    const sky = this.stage.sky.flashDirection.value;
    if (bolt) {
      const at = this.strikePoint();
      // The cloud it comes from: above the strike, as seen from the camera.
      sky.set(at.x - eye.x, 34 - eye.y, at.z - eye.z).normalize();
      const d = eye.distanceTo(at);
      near = THREE.MathUtils.clamp(1 - (d - 10) / 70, 0, 1);
      this.bolt.shape(at, eye);
      this.onStrike?.(at, near);
      // Sound lags the light: a near crack at once, a far roll seconds later.
      this.onThunder?.(THREE.MathUtils.clamp(d * 0.035, 0.12, 4.5), near);
    } else {
      // Sheet lightning somewhere in the cloud ahead.
      this.stage.camera.getWorldDirection(sky).setY(0);
      if (sky.lengthSq() < 1e-6) sky.set(0, 0, -1);
      sky.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, (Math.random() - 0.5) * 1.6);
      sky.setY(0.35 + Math.random() * 0.4).normalize();
      this.onThunder?.(2 + Math.random() * 2.5, 0);
    }
    this.strike = { t: 0, strokes, flash: bolt ? 0.7 + 0.5 * near : 0.35, bolt, gentle };
  }

  /** Advance the strike under way: drives the bolt, and returns how much the scene flashes. */
  private lightning(dt: number) {
    const s = this.strike;
    if (!s) {
      this.bolt.mesh.visible = false;
      return 0;
    }
    s.t += dt;
    let pulse = 0;
    if (s.gentle) pulse = 0.6 * THREE.MathUtils.smoothstep(s.t, 0, 0.15) * Math.exp(-Math.max(0, s.t - 0.15) * 2.4);
    else {
      for (const t0 of s.strokes) if (s.t >= t0) pulse += Math.exp(-(s.t - t0) * 24) * (t0 === 0 ? 1 : 0.8);
      // The channel glows on a moment after the strokes.
      pulse += 0.18 * Math.exp(-s.t * 3.5);
    }
    this.bolt.mesh.visible = s.bolt && pulse > 0.01;
    this.bolt.glow.value = Math.min(1.6, pulse);
    this.bolt.branches.value = s.t < (s.strokes[1] ?? 1) ? 1 : 0.35;
    if (s.t > 1.8) {
      this.strike = null;
      this.bolt.mesh.visible = false;
      return 0;
    }
    return Math.min(1.2, pulse) * s.flash * (s.gentle ? 0.5 : 1);
  }

  /**
   * Mostly into the sea just off the coast, somewhere the camera can see (the nearest water
   * likeliest); otherwise, or when none is in view, out on the horizon ahead.
   */
  private strikePoint() {
    const cam = this.stage.camera;
    const p = new THREE.Vector3();
    const offshore = Math.random() < 0.6;
    for (let i = 0; offshore && i < 24; i++) {
      const a = Math.random() * Math.PI * 2, r = this.coast + 0.4 + Math.pow(Math.random(), 1.6) * 14;
      p.set(this.centre.x + Math.cos(a) * r, SEA_LEVEL, this.centre.y + Math.sin(a) * r);
      const s = p.clone().project(cam);
      if (Math.abs(s.x) < 0.85 && s.y > -0.6 && s.y < 0.8 && s.z < 1) return p;
    }
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.setY(0).normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, (Math.random() - 0.5) * 0.9);
    const d = 70 + Math.random() * 60;
    return p.set(cam.position.x + fwd.x * d, SEA_LEVEL, cam.position.z + fwd.z * d);
  }

  private bowPlaced = false;

  private grey = new THREE.Color('#8f9aa3');
  private greyNow = new THREE.Color();

  /**
   * Stand the arc in the sky the camera faces, behind the island, with its crown low (~3°)
   * so it shows at the lowest camera tilt players can reach.
   */
  private placeRainbow() {
    const cam = this.stage.camera;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const D = 140;
    const crown = Math.tan(THREE.MathUtils.degToRad(3)) * D;
    this.bow.position.set(fwd.x * D, crown - 85, fwd.z * D);
    this.bow.lookAt(0, this.bow.position.y, 0);
    this.bowPlaced = true;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.bolt.dispose();
    this.group.removeFromParent();
  }
}
