// Pooled GPU-instanced particles (billboarded quads) simulated on the CPU.
// Styles: textured sprites (sparkles, wool puffs, leaves), shader-built smoke that billows
// and erodes as it ages, fine mist, and water droplets stretched along their motion. All of
// them fade where they meet the scene (soft particles), so nothing cuts a hard line through
// a cliff or the sea.

import * as THREE from 'three/webgpu';
import { keepNormals } from '../util/mrt';
import { WIND, windAt } from '../env/wind';
import { particleDepth } from '../util/sceneDepth';
import {
  Fn,
  attribute,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
  float,
  sin,
  cos,
  clamp,
  mix,
  smoothstep,
  positionGeometry,
  cameraViewMatrix,
  cameraProjectionMatrix,
  cameraNear,
  cameraFar,
  uniform,
  perspectiveDepthToViewZ,
  varyingProperty,
  mx_fractal_noise_float,
} from 'three/tsl';

type ParticleStyle = 'sprite' | 'smoke' | 'mist' | 'droplet';

interface ParticleOpts {
  max: number;
  style?: ParticleStyle;
  /** Sprite texture (sprite style only). */
  texture?: THREE.Texture;
  additive?: boolean;
  /** Billboard to the camera (true) or keep world-oriented quads (false, e.g. leaves). */
  billboard?: boolean;
  /** Distance over which particles fade into geometry behind them. */
  soft?: number;
  /** Speed (world units/s) the wind carries these along at full gust; 0 for heavy particles. */
  wind?: number;
}

interface Emit {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  /** Size multiplier at end of life. */
  grow?: number;
  color: THREE.Color | string;
  alpha?: number;
  gravity?: number;
  drag?: number;
  spin?: number;
  /** Fade-in fraction of life. */
  fadeIn?: number;
  /** Dies on falling below this height (droplets landing back in the sea). */
  floor?: number;
}

interface P {
  alive: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  size: number; grow: number;
  r: number; g: number; b: number; a: number;
  gravity: number; drag: number; rot: number; spin: number; fadeIn: number;
  seed: number;
  floor: number;
}

/** Send a pool's first `n` slots up to the GPU (the pools are sized for the busiest moment, and only the live slots go). */
function upload(a: THREE.InstancedBufferAttribute, n: number) {
  a.clearUpdateRanges();
  a.addUpdateRange(0, n * a.itemSize);
  a.needsUpdate = true;
}

/** Colours given as CSS strings, parsed once each (emitters pass the same few, many times a second). */
const parsed = new Map<string, THREE.Color>();

export class ParticleSystem {
  /**
   * Drawn as `count` instances of one quad. A plain mesh rather than an InstancedMesh: the quads
   * are placed by the shader from the per-particle attributes, so an instance matrix per slot
   * (64 bytes each, never read) would only take up memory.
   */
  mesh: THREE.Mesh;
  /** Scene light on lit-looking particles (smoke, dust, spray), so they dim at night; set by World. */
  light = uniform(new THREE.Color(1, 1, 1));
  private parts: P[];
  // Per-particle data, packed to stay within WebGPU's eight vertex buffers:
  // colour (rgba), centre + size, rotation / squash / seed / age, velocity.
  private colorAttr: THREE.InstancedBufferAttribute;
  private centerAttr: THREE.InstancedBufferAttribute;
  private extraAttr: THREE.InstancedBufferAttribute;
  private velAttr: THREE.InstancedBufferAttribute;
  private cursor = 0;
  private style: ParticleStyle;

  constructor(private o: ParticleOpts) {
    const style = (this.style = o.style ?? 'sprite');
    const geo = new THREE.PlaneGeometry(1, 1);
    // (Not marked dynamic: three sends a dynamic buffer again at every draw of it, in every pass
    // and whole after the first, where this one goes up once a frame, its live slots only.)
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(o.max * n), n);
    this.colorAttr = attr(4);
    this.centerAttr = attr(4);
    this.extraAttr = attr(4);
    this.velAttr = attr(3);
    geo.setAttribute('pColor', this.colorAttr);
    geo.setAttribute('pCenter', this.centerAttr);
    geo.setAttribute('pExtra', this.extraAttr);
    geo.setAttribute('pVel', this.velAttr);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    // Billboards always face the camera: single-sided avoids three's two-pass transparent
    // double-sided draw. Tumbling leaves (not billboards) still need both sides.
    mat.side = o.billboard === false ? THREE.DoubleSide : THREE.FrontSide;
    mat.fog = true;
    if (o.additive) mat.blending = THREE.AdditiveBlending;
    keepNormals(mat);
    const pc = attribute<'vec4'>('pColor', 'vec4');
    const ex = attribute<'vec4'>('pExtra', 'vec4');
    const seed = ex.z, age = ex.w;
    const light = this.light;
    const viewZ = varyingProperty('float', 'vParticleViewZ');

    // Camera-facing quad from per-particle centre, size and rotation (with a flip squash for
    // tumbling leaves). Droplets are drawn as streaks along their on-screen motion; smoke
    // and mist stay upright so their lighting (lit from above) stays put.
    mat.vertexNode = Fn(() => {
      const cs4 = attribute<'vec4'>('pCenter', 'vec4');
      const size = cs4.w;
      const vp = cameraViewMatrix.mul(vec4(cs4.xyz, 1));
      const g = positionGeometry.xy.mul(size);
      let offset;
      if (style === 'droplet') {
        const v = cameraViewMatrix.mul(vec4(attribute<'vec3'>('pVel', 'vec3'), 0)).xy;
        const len = v.length().max(1e-4);
        const d = v.div(len);
        const stretch = len.mul(0.06).div(size).add(1).min(5);
        // (Side vector chosen so the basis isn't mirrored: a flipped quad is culled as a back face.)
        offset = d.mul(g.y.mul(stretch)).add(vec2(d.y, d.x.negate()).mul(g.x));
      } else if (style === 'sprite') {
        const q = g.mul(vec2(ex.y, 1));
        const cs = cos(ex.x);
        const sn = sin(ex.x);
        offset = vec2(q.x.mul(cs).sub(q.y.mul(sn)), q.x.mul(sn).add(q.y.mul(cs)));
      } else {
        offset = g;
      }
      viewZ.assign(vp.z);
      return cameraProjectionMatrix.mul(vec4(vp.xy.add(offset), vp.z, 1));
    })();

    // Soft particles: fade out as the particle nears whatever lies behind it.
    const sceneZ = perspectiveDepthToViewZ(particleDepth, cameraNear, cameraFar);
    const soft = smoothstep(0, o.soft ?? 0.06, viewZ.sub(sceneZ));
    const q = uv().mul(2).sub(1);
    const r = q.length();
    if (style === 'smoke' || style === 'mist') {
      // Billowing noise that drifts and evolves over the puff's life; the puff erodes from
      // its thin edges inward as it ages rather than just turning transparent.
      const smoke = style === 'smoke';
      const n = mx_fractal_noise_float(vec3(q.mul(smoke ? 1.7 : 1.6).add(seed.mul(17)), seed.mul(5).add(age.mul(smoke ? 0.9 : 0.6))), 4, 2, 0.5);
      // The noise roughens the outline (mist far more: it should read as a ragged veil, not
      // a puff), inside an envelope that always reaches zero before the quad's edge (or the
      // quad shows as a faint square).
      const shape = smoothstep(1.0, smoke ? 0.15 : 0.2, r.add(n.mul(smoke ? 0.38 : 0.6))).mul(smoothstep(1.0, 0.62, r));
      const erode = age.mul(age).mul(smoke ? 0.55 : 0.3);
      const dens = clamp(shape.mul(n.mul(0.5).add(smoke ? 0.78 : 0.7)).sub(erode), 0, 1);
      // Lit from above, shaded underneath; denser cores read a touch darker.
      const lit = mix(float(smoke ? 0.6 : 0.88), float(smoke ? 1.12 : 1.05), clamp(q.y.mul(0.5).add(0.5).add(n.mul(0.25)), 0, 1)).mul(dens.mul(-0.12).add(1));
      mat.colorNode = vec4(pc.rgb.mul(lit).mul(light), 1);
      mat.opacityNode = dens.mul(pc.a).mul(soft);
    } else if (style === 'droplet') {
      // A bright, sunlit bead of water with a soft rim.
      const core = smoothstep(1.0, 0.3, r);
      mat.colorNode = vec4(pc.rgb.mul(light).mul(smoothstep(0.6, 0.0, r).mul(0.6).add(1.25)), 1);
      mat.opacityNode = core.mul(pc.a).mul(soft);
    } else {
      const tex = texture(o.texture!, uv());
      mat.colorNode = Fn(() => vec4(o.additive ? pc.rgb.mul(tex.rgb) : pc.rgb.mul(tex.rgb).mul(light), float(1)))();
      mat.opacityNode = pc.a.mul(tex.a).mul(o.additive ? float(1) : soft);
    }
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.count = 0;
    // Hidden while empty, so a pool that hasn't emitted yet costs no draw (nor its depth copy).
    this.mesh.visible = false;
    this.parts = Array.from({ length: o.max }, () => ({
      alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size: 1, grow: 1, r: 1, g: 1, b: 1, a: 1, gravity: 0, drag: 0, rot: 0, spin: 0, fadeIn: 0.1, seed: 0, floor: -Infinity,
    }));
  }

  emit(e: Emit) {
    this.active = true;
    // Ring-buffer allocation: overwrite the oldest when full.
    const p = this.parts[this.cursor];
    this.cursor = (this.cursor + 1) % this.o.max;
    if (!p.alive) this.alive++;
    p.alive = true;
    p.x = e.x; p.y = e.y; p.z = e.z;
    p.vx = e.vx ?? 0; p.vy = e.vy ?? 0; p.vz = e.vz ?? 0;
    p.age = 0; p.life = e.life; p.size = e.size; p.grow = e.grow ?? 1;
    let c = typeof e.color === 'string' ? parsed.get(e.color) : e.color;
    if (!c) parsed.set(e.color as string, (c = new THREE.Color(e.color)));
    p.r = c.r; p.g = c.g; p.b = c.b; p.a = e.alpha ?? 1;
    p.gravity = e.gravity ?? 0; p.drag = e.drag ?? 0; p.spin = e.spin ?? 0;
    p.rot = Math.random() * Math.PI * 2;
    p.fadeIn = e.fadeIn ?? 0.12;
    p.seed = Math.random();
    p.floor = e.floor ?? -Infinity;
  }

  /** Set when something was emitted; lets idle systems skip their update entirely. */
  private active = false;
  /** How many slots are alive (the update stops once it has met them all, rather than walk the whole pool). */
  private alive = 0;

  update(dt: number) {
    if (!this.active && this.mesh.count === 0) return;
    let n = 0;
    const colors = this.colorAttr.array as Float32Array;
    const centers = this.centerAttr.array as Float32Array;
    const ex = this.extraAttr.array as Float32Array;
    const vel = this.velAttr.array as Float32Array;
    let left = this.alive;
    for (const p of this.parts) {
      if (left === 0) break;
      if (!p.alive) continue;
      left--;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        this.alive--;
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k - p.gravity * dt; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (this.o.wind) {
        // Carried downwind, faster as a gust passes.
        const w = windAt(p.x, p.z) * this.o.wind * dt;
        p.x += WIND.x * w; p.z += WIND.y * w;
      }
      if (p.y < p.floor && p.vy < 0) {
        p.alive = false;
        this.alive--;
        continue;
      }
      p.rot += p.spin * dt;
      const t = p.age / p.life;
      const size = p.size * (1 + (p.grow - 1) * t);
      const fade = Math.min(1, t / Math.max(0.001, p.fadeIn)) * (1 - smooth(Math.max(0, (t - 0.55) / 0.45)));
      centers[n * 4] = p.x; centers[n * 4 + 1] = p.y; centers[n * 4 + 2] = p.z; centers[n * 4 + 3] = size;
      ex[n * 4] = p.rot;
      // Leaves flutter: squash the quad horizontally to fake a 3D tumble.
      ex[n * 4 + 1] = this.o.billboard === false ? Math.abs(Math.cos(p.rot * 1.7)) * 0.9 + 0.1 : 1;
      ex[n * 4 + 2] = p.seed;
      ex[n * 4 + 3] = t;
      colors[n * 4] = p.r; colors[n * 4 + 1] = p.g; colors[n * 4 + 2] = p.b;
      // Shader-built styles erode themselves over life; they only need the fade-in.
      colors[n * 4 + 3] = p.a * (this.style === 'smoke' || this.style === 'mist' ? Math.min(1, t / Math.max(0.001, p.fadeIn)) * (1 - smooth(Math.max(0, (t - 0.8) / 0.2))) : fade);
      vel[n * 3] = p.vx; vel[n * 3 + 1] = p.vy; vel[n * 3 + 2] = p.vz;
      n++;
    }
    this.mesh.count = n;
    this.active = n > 0;
    // Hidden while empty, so it costs no draw (nor its depth copy).
    this.mesh.visible = n > 0;
    if (n > 0) {
      upload(this.colorAttr, n);
      upload(this.centerAttr, n);
      upload(this.extraAttr, n);
      if (this.style === 'droplet') upload(this.velAttr, n);
    }
  }

  clear() {
    for (const p of this.parts) p.alive = false;
    this.alive = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.o.texture?.dispose();
  }
}

interface WaterBurst {
  x: number;
  y: number;
  z: number;
  /** Droplets thrown (mist puffs are a third as many). */
  count: number;
  /** Spread: a disc of this radius, or a ring when `ring` is set. */
  radius: number;
  ring?: boolean;
  /** Upward and outward launch speeds (min, max). */
  up: [number, number];
  out: [number, number];
  /** Bias every droplet along this horizontal direction (e.g. away from a cliff). */
  push?: [number, number];
  /** Typical droplet size. */
  size: number;
}

/**
 * Water thrown up: a spray of droplets (falling back under gravity, drawn as streaks) and a
 * few puffs of fine mist that hang and dissolve.
 */
export function waterBurst(spray: ParticleSystem, mist: ParticleSystem, b: WaterBurst) {
  const [px, pz] = b.push ?? [0, 0];
  for (let i = 0; i < b.count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = b.ring ? b.radius * (0.9 + Math.random() * 0.12) : Math.sqrt(Math.random()) * b.radius;
    const out = b.out[0] + Math.random() * (b.out[1] - b.out[0]);
    const x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
    // Each throw is a couple of droplets of different sizes along nearly the same path.
    for (let k = 0; k < 2; k++) {
      const j = 1 + (Math.random() - 0.5) * 0.25;
      spray.emit({
        x, y: b.y, z,
        vx: (Math.cos(a) * out + px * out) * j,
        vy: (b.up[0] + Math.random() * (b.up[1] - b.up[0])) * j,
        vz: (Math.sin(a) * out + pz * out) * j,
        life: 1.4 + Math.random() * 0.6,
        size: b.size * (k === 0 ? 0.45 + Math.random() * 0.4 : 0.22 + Math.random() * 0.2),
        color: '#eef6f9',
        alpha: 0.85,
        gravity: 1.9,
        drag: 0.3,
        fadeIn: 0.02,
        // Gone the moment it falls back into the water.
        floor: b.y - 0.01,
      });
    }
    if (i % 2 === 0) {
      mist.emit({
        x, y: b.y + 0.02, z,
        vx: (Math.cos(a) * out + px * out) * 0.35,
        vy: (b.up[0] + Math.random() * (b.up[1] - b.up[0])) * 0.3,
        vz: (Math.sin(a) * out + pz * out) * 0.35,
        life: 1.3 + Math.random() * 1.0,
        // Large and faint, so it reads as a veil of spray rather than as separate puffs.
        size: b.size * (4 + Math.random() * 2.5),
        grow: 1.8,
        color: '#f3f8fa',
        alpha: 0.16,
        gravity: 0.15,
        drag: 1.6,
        fadeIn: 0.15,
      });
    }
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------
// Procedural sprite textures
// ---------------------------------------------------------------------------

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const SpriteTextures = {
  soft: () =>
    canvasTex(64, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }),
  spark: () =>
    canvasTex(64, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.15, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.25)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s / 2, 4); ctx.lineTo(s / 2, s - 4);
      ctx.moveTo(4, s / 2); ctx.lineTo(s - 4, s / 2);
      ctx.stroke();
    }),
  leaf: () =>
    canvasTex(64, (ctx, s) => {
      ctx.translate(s / 2, s / 2);
      ctx.rotate(0.6);
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.18, s * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
    }),
};
