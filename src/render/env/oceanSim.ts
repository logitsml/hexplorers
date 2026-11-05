// FFT ocean simulation (Tessendorf) on the GPU: three cascades of 256² wave spectra evolved
// and inverse-transformed every frame in compute shaders, giving displacement, slopes and a
// persistent whitecap foam field per cascade. The spectrum, evolution and shared-memory FFT
// are adapted from Noniv/web-ocean (https://github.com/Noniv/web-ocean), Copyright (c) 2026
// Maksymilian Dendura, under the MIT License (LICENSES/MIT-web-ocean.txt).
//
// Runs directly on the renderer's WebGPU device; three samples the results through
// ExternalTexture wrappers (each with a full mip chain, built here, so distant water filters
// instead of shimmering). Units: the simulation works in metres; the scene samples it with
// METRES_PER_UNIT world units per metre.

import * as THREE from 'three/webgpu';
import { windStrength } from './wind';

// WebGPU's usage-flag namespaces exist at runtime but aren't in the project's type definitions.
const GPU = globalThis as unknown as {
  GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
  GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number };
};

export const N = 256;
const LOGN = 8;
const CASCADES = 3;
const MIPS = LOGN + 1;
/** World units are about this many metres (sets the scale of the sea). */
export const METRES_PER_UNIT = 8;
/** Patch sizes in metres: incommensurate, so the cascades never tile in step. */
const CASCADE_L = [233, 51.7, 11.3];

const COMMON = /* wgsl */ `
const N: u32 = ${N}u;
const LOGN: u32 = ${LOGN}u;
const PI: f32 = 3.14159265358979;
const GRAV: f32 = 9.81;
const SURF: f32 = 7.4e-5;
struct Sim {
  L: vec4f,      // patch size per cascade (m)
  kMin: vec4f,
  kMax: vec4f,
  wind: vec4f,   // U10 m/s, direction rad, fetch m, JONSWAP gamma
  swell: vec4f,  // Hs m, direction rad, peak omega, spreading exponent
  misc: vec4f,   // choppiness, short-wave cut (m), loop period s, seed
  timeP: vec4f,  // time s, dt s, foam decay 1/s, spectrum gain
  foamP: vec4f,  // Jacobian threshold, gain, storm spectrum share
};
@group(0) @binding(0) var<uniform> S: Sim;
fn waveVec(x: u32, y: u32, L: f32) -> vec2f {
  let nx = select(i32(x), i32(x) - i32(N), x >= N / 2u);
  let ny = select(i32(y), i32(y) - i32(N), y >= N / 2u);
  return vec2f(f32(nx), f32(ny)) * (2.0 * PI / L);
}
fn omegaOf(k: f32) -> f32 { return sqrt(GRAV * k + SURF * k * k * k); }
fn dOmegaOf(k: f32) -> f32 { return (GRAV + 3.0 * SURF * k * k) / (2.0 * omegaOf(k)); }
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn mulI(a: vec2f) -> vec2f { return vec2f(-a.y, a.x); }
`;

const INIT = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> h0: array<vec4f>;
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand01(s: u32) -> f32 { return (f32(pcg(s) >> 8u) + 0.5) / 16777216.0; }
fn gauss2(seed: u32) -> vec2f {
  let u1 = rand01(seed * 2u + 17u);
  let u2 = rand01(seed * 2u + 18u + pcg(seed));
  return sqrt(-2.0 * log(u1)) * vec2f(cos(2.0 * PI * u2), sin(2.0 * PI * u2));
}
fn wrapAngle(a: f32) -> f32 { return a - 2.0 * PI * floor((a + PI) / (2.0 * PI)); }
fn jonswap(w: f32, wp: f32, alpha: f32, gamma: f32) -> f32 {
  let sigma = select(0.09, 0.07, w <= wp);
  let d = (w - wp) / (sigma * wp);
  let q = wp / w;
  let q2 = q * q;
  return alpha * GRAV * GRAV / (w * w * w * w * w) * exp(-1.25 * q2 * q2) * pow(gamma, exp(-0.5 * d * d));
}
// Donelan-Banner directional spreading.
fn donelanBanner(theta: f32, w: f32, wp: f32) -> f32 {
  let ratio = w / wp;
  var beta: f32;
  if (ratio < 0.95) { beta = 2.61 * pow(ratio, 1.3); }
  else if (ratio < 1.6) { beta = 2.28 * pow(ratio, -1.3); }
  else { beta = pow(10.0, -0.4 + 0.8393 * exp(-0.567 * log(ratio * ratio))); }
  let sh = 1.0 / cosh(clamp(beta * theta, -20.0, 20.0));
  return beta / (2.0 * tanh(beta * PI)) * sh * sh;
}
fn cosSpread(theta: f32, s: f32) -> f32 {
  return sqrt(s + 0.25) / (2.0 * sqrt(PI)) * pow(abs(cos(theta * 0.5)), 2.0 * s);
}
fn spectrum(k: vec2f) -> f32 {
  let kl = length(k);
  let w = omegaOf(kl);
  let theta = atan2(k.y, k.x);
  let U = S.wind.x;
  let F = S.wind.z;
  let alpha = 0.076 * pow(U * U / (F * GRAV), 0.22);
  let wp = 22.0 * pow(GRAV * GRAV / (U * F), 1.0 / 3.0);
  var Sw = jonswap(w, wp, alpha, S.wind.w) * donelanBanner(wrapAngle(theta - S.wind.y), w, wp);
  if (S.swell.x > 0.001) {
    let ws = S.swell.z;
    let hs4 = S.swell.x * 0.25;
    let alphaS = hs4 * hs4 * 5.0 * ws * ws * ws * ws / (GRAV * GRAV) * (1.0 - 0.287 * log(6.0));
    Sw += jonswap(w, ws, alphaS, 6.0) * cosSpread(wrapAngle(theta - S.swell.y), S.swell.w);
  }
  Sw *= exp(-kl * kl * S.misc.y * S.misc.y);
  return Sw * dOmegaOf(kl) / kl * S.timeP.w;
}
fn amplitude(k: vec2f, c: u32) -> f32 {
  let kl = length(k);
  if (kl < 1e-5 || kl < S.kMin[c] || kl >= S.kMax[c]) { return 0.0; }
  let dk = 2.0 * PI / S.L[c];
  return sqrt(max(spectrum(k), 0.0)) * dk * 0.5;
}
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = id.z;
  let k = waveVec(id.x, id.y, S.L[c]);
  let mx = (N - id.x) % N;
  let my = (N - id.y) % N;
  let seed = u32(S.misc.w) * 7919u + c * 1000003u;
  let a = gauss2(seed + (id.y * N + id.x)) * amplitude(k, c);
  let b = gauss2(seed + (my * N + mx)) * amplitude(-k, c);
  h0[(c * N + id.y) * N + id.x] = vec4f(a, b.x, -b.y);
}
`;

const EVOLVE = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> h0: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> specA: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> specB: array<vec4f>;
// The same sea under a storm's wind (the same random phases, so the two blend coherently).
@group(0) @binding(4) var<storage, read> h0Storm: array<vec4f>;
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = id.z;
  let idx = (c * N + id.y) * N + id.x;
  let k = waveVec(id.x, id.y, S.L[c]);
  let kl = length(k);
  if (kl < 1e-5) { specA[idx] = vec4f(0.0); specB[idx] = vec4f(0.0); return; }
  // Frequencies snapped to the loop period, so the sea repeats exactly (no time drift).
  let w0 = 2.0 * PI / S.misc.z;
  let ph = floor(omegaOf(kl) / w0) * w0 * S.timeP.x;
  let e = vec2f(cos(ph), sin(ph));
  let H0 = mix(h0[idx], h0Storm[idx], S.foamP.z);
  let h = cmul(H0.xy, vec2f(e.x, -e.y)) + cmul(H0.zw, e);
  let ih = mulI(h);
  let lam = S.misc.x;
  let ik = 1.0 / kl;
  let Dx = ih * (lam * k.x * ik);
  let Dz = ih * (lam * k.y * ik);
  let jxz = h * (-lam * k.x * k.y * ik);
  let sx = ih * k.x;
  let sz = ih * k.y;
  let jxx = h * (-lam * k.x * k.x * ik);
  let jzz = h * (-lam * k.y * k.y * ik);
  specA[idx] = vec4f(Dx + mulI(Dz), h + mulI(jxz));
  specB[idx] = vec4f(sx + mulI(sz), jxx + mulI(jzz));
}
`;

const FFT_CORE = /* wgsl */ `
var<workgroup> wa: array<vec4f, ${N}>;
var<workgroup> wb: array<vec4f, ${N}>;
fn bitrev(i: u32) -> u32 { return reverseBits(i) >> (32u - LOGN); }
fn butterflies(t: u32) {
  for (var s = 0u; s < LOGN; s++) {
    let half = 1u << s;
    let pos = t & (half - 1u);
    let i0 = ((t >> s) << (s + 1u)) + pos;
    let i1 = i0 + half;
    let ang = PI * f32(pos) / f32(half);
    let w = vec2f(cos(ang), sin(ang));
    let a0 = wa[i0]; let a1 = wa[i1];
    let b0 = wb[i0]; let b1 = wb[i1];
    let ta = vec4f(cmul(a1.xy, w), cmul(a1.zw, w));
    let tb = vec4f(cmul(b1.xy, w), cmul(b1.zw, w));
    wa[i0] = a0 + ta; wa[i1] = a0 - ta;
    wb[i0] = b0 + tb; wb[i1] = b0 - tb;
    workgroupBarrier();
  }
}
`;

const FFT_ROWS = COMMON + FFT_CORE + /* wgsl */ `
@group(0) @binding(1) var<storage, read> inA: array<vec4f>;
@group(0) @binding(2) var<storage, read> inB: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> outA: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> outB: array<vec4f>;
@compute @workgroup_size(${N / 2})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32) {
  let base = (wg.z * N + wg.x) * N;
  let e0 = t;
  let e1 = t + N / 2u;
  wa[bitrev(e0)] = inA[base + e0];
  wa[bitrev(e1)] = inA[base + e1];
  wb[bitrev(e0)] = inB[base + e0];
  wb[bitrev(e1)] = inB[base + e1];
  workgroupBarrier();
  butterflies(t);
  outA[base + e0] = wa[e0];
  outA[base + e1] = wa[e1];
  outB[base + e0] = wb[e0];
  outB[base + e1] = wb[e1];
}
`;

// Columns, then the cascade's textures: displacement (Dx, h, Dz, jxz), derivatives
// (sx, sz, jxx, jzz) and foam (persistent whitecap foam, Jacobian, jxz, fresh foam).
const FFT_COLS = COMMON + FFT_CORE + /* wgsl */ `
struct Cas { idx: vec4u };
@group(0) @binding(1) var<storage, read> inA: array<vec4f>;
@group(0) @binding(2) var<storage, read> inB: array<vec4f>;
@group(0) @binding(3) var<uniform> C: Cas;
@group(0) @binding(4) var dispOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var derivOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var foamOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var<storage, read_write> foamState: array<f32>;
fn emit(x: u32, y: u32, c: u32, a: vec4f, b: vec4f) {
  let p = vec2u(x, y);
  textureStore(dispOut, p, vec4f(a.x, a.z, a.y, a.w));
  textureStore(derivOut, p, b);
  // Whitecaps where this cascade's surface folds (Jacobian below the threshold); the foam
  // lingers and fades, travelling with the water it formed on.
  let J = (1.0 + b.z) * (1.0 + b.w) - a.w * a.w;
  let fi = (c * N + y) * N + x;
  let inject = clamp((S.foamP.x - J) * S.foamP.y, 0.0, 1.0);
  let f = max(foamState[fi] * exp(-S.timeP.y * S.timeP.z), inject);
  foamState[fi] = f;
  // (jxz is repeated here so the surface shader needs only the slope and foam textures.)
  textureStore(foamOut, p, vec4f(f, J, a.w, inject));
}
@compute @workgroup_size(${N / 2})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32) {
  let x = wg.x;
  let c = C.idx.x;
  let e0 = t;
  let e1 = t + N / 2u;
  let i0 = (c * N + e0) * N + x;
  let i1 = (c * N + e1) * N + x;
  wa[bitrev(e0)] = inA[i0];
  wa[bitrev(e1)] = inA[i1];
  wb[bitrev(e0)] = inB[i0];
  wb[bitrev(e1)] = inB[i1];
  workgroupBarrier();
  butterflies(t);
  emit(x, e0, c, wa[e0], wb[e0]);
  emit(x, e1, c, wa[e1], wb[e1]);
}
`;

const MIP = /* wgsl */ `
@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var srcC: texture_2d<f32>;
@group(0) @binding(3) var dstA: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var dstB: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var dstC: texture_storage_2d<rgba16float, write>;
fn box(t: texture_2d<f32>, p: vec2i) -> vec4f {
  return 0.25 * (textureLoad(t, p, 0) + textureLoad(t, p + vec2i(1, 0), 0) + textureLoad(t, p + vec2i(0, 1), 0) + textureLoad(t, p + vec2i(1, 1), 0));
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dstA);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  textureStore(dstA, id.xy, box(srcA, p));
  textureStore(dstB, id.xy, box(srcB, p));
  textureStore(dstC, id.xy, box(srcC, p));
}
`;

interface OceanSimSettings {
  /** Wind speed at 10 m (m/s) and its direction (radians). */
  wind: number;
  windDir: number;
  /** Long, regular swell height (m). */
  swell: number;
  choppiness: number;
}

/** The storm's sea, cross-faded in with the wind: a fresh gale's waves and swell, steeper and breaking. */
const STORM = { wind: 8.5, swell: 0.7, choppiness: 1.1, foamThreshold: 0.62, foamDecay: 0.32 };
const CALM_FOAM = { threshold: 0.38, decay: 0.55 };

/** One cascade's sampled outputs. */
interface Cascade {
  disp: THREE.Texture;
  deriv: THREE.Texture;
  foam: THREE.Texture;
  /** World units across one repeat of this cascade. */
  size: number;
}

export class OceanSim {
  cascades: Cascade[] = [];
  private device: GPUDevice;
  private uniform: GPUBuffer;
  private uniformData = new Float32Array(32);
  private buffers: GPUBuffer[] = [];
  private gpuTextures: GPUTexture[] = [];
  private evolve!: { pipeline: GPUComputePipeline; bind: GPUBindGroup };
  private rows!: { pipeline: GPUComputePipeline; bind: GPUBindGroup };
  private cols!: { pipeline: GPUComputePipeline; binds: GPUBindGroup[] };
  private mips!: { pipeline: GPUComputePipeline; binds: GPUBindGroup[][] };
  private disposed = false;
  /** Set when the GPU device is lost: nothing more is submitted. */
  private lost = false;
  /** How much of the storm's spectrum is in the sea (0..1), eased towards the wind's. */
  private storm = 0;
  /** Cascades simulated (the finest is left out on the sea's low tier). */
  private active = CASCADES;

  /**
   * WebGPU only: null when the renderer runs on its WebGL fallback (or can't build the simulation's
   * pipelines). The pipelines are compiled
   * asynchronously, so a first visit's compile doesn't hold the GPU (and the loading screen).
   */
  static async create(renderer: THREE.WebGPURenderer, settings: OceanSimSettings): Promise<OceanSim | null> {
    const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice };
    const device = backend.device;
    if (!backend.isWebGPUBackend || !device) return null;
    const pipe = (code: string, label: string) =>
      device.createComputePipelineAsync({ label, layout: 'auto', compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' } });
    // A device that can't build them (limits, a driver bug) gets the Gerstner sea, not a failed start.
    try {
      const [init, evolve, rows, cols, mips] = await Promise.all([pipe(INIT, 'ocean-init'), pipe(EVOLVE, 'ocean-evolve'), pipe(FFT_ROWS, 'ocean-fft-rows'), pipe(FFT_COLS, 'ocean-fft-cols'), pipe(MIP, 'ocean-mips')]);
      return new OceanSim(device, settings, { init, evolve, rows, cols, mips });
    } catch (e) {
      console.warn('[ocean] wave simulation unavailable, using the simple sea:', e);
      return null;
    }
  }

  private constructor(
    device: GPUDevice,
    private settings: OceanSimSettings,
    pipes: Record<'init' | 'evolve' | 'rows' | 'cols' | 'mips', GPUComputePipeline>,
  ) {
    this.device = device;
    const U = GPU.GPUBufferUsage;
    this.uniform = device.createBuffer({ size: this.uniformData.byteLength, usage: U.UNIFORM | U.COPY_DST });
    const cells = N * N * CASCADES;
    const vec4Buf = () => {
      const b = device.createBuffer({ size: cells * 16, usage: U.STORAGE });
      this.buffers.push(b);
      return b;
    };
    const h0 = vec4Buf(), h0Storm = vec4Buf(), specA = vec4Buf(), specB = vec4Buf(), rowA = vec4Buf(), rowB = vec4Buf();
    const foamState = device.createBuffer({ size: cells * 4, usage: U.STORAGE });
    this.buffers.push(foamState);
    device.lost.then(() => (this.lost = true));

    const buf = (binding: number, buffer: GPUBuffer) => ({ binding, resource: { buffer } });

    // Initial spectra, once: the fair-weather sea, and the storm's (its own uniforms, then the
    // fair-weather ones go back for the frames).
    const init = pipes.init;
    const stormUniform = device.createBuffer({ size: this.uniformData.byteLength, usage: U.UNIFORM | U.COPY_DST });
    this.buffers.push(stormUniform);
    this.pack({ ...settings, wind: STORM.wind, swell: STORM.swell, choppiness: STORM.choppiness }, 0, 0);
    device.queue.writeBuffer(stormUniform, 0, this.uniformData);
    this.writeUniforms(0, 0);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(init);
    for (const [u, out] of [[this.uniform, h0], [stormUniform, h0Storm]]) {
      pass.setBindGroup(0, device.createBindGroup({ layout: init.getBindGroupLayout(0), entries: [buf(0, u), buf(1, out)] }));
      pass.dispatchWorkgroups(N / 16, N / 16, CASCADES);
    }
    pass.end();
    device.queue.submit([enc.finish()]);

    const ev = pipes.evolve;
    this.evolve = { pipeline: ev, bind: device.createBindGroup({ layout: ev.getBindGroupLayout(0), entries: [buf(0, this.uniform), buf(1, h0), buf(2, specA), buf(3, specB), buf(4, h0Storm)] }) };
    const rw = pipes.rows;
    this.rows = {
      pipeline: rw,
      // (The row pass never reads the uniforms, so the automatic layout has no binding 0.)
      bind: device.createBindGroup({ layout: rw.getBindGroupLayout(0), entries: [buf(1, specA), buf(2, specB), buf(3, rowA), buf(4, rowB)] }),
    };

    // Output textures, with mips, wrapped for three.
    const makeTex = (label: string) => {
      const t = device.createTexture({
        label,
        size: [N, N, 1],
        format: 'rgba16float',
        mipLevelCount: MIPS,
        usage: GPU.GPUTextureUsage.TEXTURE_BINDING | GPU.GPUTextureUsage.STORAGE_BINDING | GPU.GPUTextureUsage.COPY_SRC,
      });
      this.gpuTextures.push(t);
      return t;
    };
    const wrap = (t: GPUTexture) => {
      const tex = new THREE.ExternalTexture(t);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = false;
      tex.anisotropy = 8;
      return tex;
    };
    const cl = pipes.cols;
    const mp = pipes.mips;
    const colBinds: GPUBindGroup[] = [];
    const mipBinds: GPUBindGroup[][] = [];
    for (let c = 0; c < CASCADES; c++) {
      const disp = makeTex(`ocean-disp-${c}`), deriv = makeTex(`ocean-deriv-${c}`), foam = makeTex(`ocean-foam-${c}`);
      const cas = device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
      device.queue.writeBuffer(cas, 0, new Uint32Array([c, 0, 0, 0]));
      this.buffers.push(cas);
      const level = (t: GPUTexture, l: number) => t.createView({ baseMipLevel: l, mipLevelCount: 1 });
      colBinds.push(
        device.createBindGroup({
          layout: cl.getBindGroupLayout(0),
          entries: [buf(0, this.uniform), buf(1, rowA), buf(2, rowB), buf(3, cas), { binding: 4, resource: level(disp, 0) }, { binding: 5, resource: level(deriv, 0) }, { binding: 6, resource: level(foam, 0) }, buf(7, foamState)],
        }),
      );
      const binds: GPUBindGroup[] = [];
      for (let l = 1; l < MIPS; l++) {
        binds.push(
          device.createBindGroup({
            layout: mp.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: level(disp, l - 1) },
              { binding: 1, resource: level(deriv, l - 1) },
              { binding: 2, resource: level(foam, l - 1) },
              { binding: 3, resource: level(disp, l) },
              { binding: 4, resource: level(deriv, l) },
              { binding: 5, resource: level(foam, l) },
            ],
          }),
        );
      }
      mipBinds.push(binds);
      this.cascades.push({ disp: wrap(disp), deriv: wrap(deriv), foam: wrap(foam), size: CASCADE_L[c] / METRES_PER_UNIT });
    }
    this.cols = { pipeline: cl, binds: colBinds };
    this.mips = { pipeline: mp, binds: mipBinds };
  }

  private writeUniforms(time: number, dt: number) {
    const k = this.storm;
    const s = this.settings;
    this.pack({ ...s, choppiness: s.choppiness + (STORM.choppiness - s.choppiness) * k }, time, dt, k);
    this.device.queue.writeBuffer(this.uniform, 0, this.uniformData);
  }

  /** Fill the uniform block for `s`, with `storm` of the storm's spectrum and foam. */
  private pack(s: OceanSimSettings, time: number, dt: number, storm = 0) {
    const d = this.uniformData;
    const L = CASCADE_L;
    // Each cascade covers its own band of wavenumbers (from the 6th harmonic of the next
    // larger patch), so no wave is counted twice.
    const split = (c: number) => (2 * Math.PI * 6) / L[c];
    d.set([L[0], L[1], L[2], 1], 0);
    d.set([0, split(1), split(2), 0], 4);
    d.set([split(1), split(2), 1e9, 0], 8);
    d.set([s.wind, s.windDir, 120000, 3.3], 12);
    d.set([s.swell, s.windDir + 0.5, 0.75, 22], 16);
    d.set([s.choppiness, 0.006, 600, 11], 20);
    // More of the sea breaks in a storm (a higher fold threshold) and its foam lingers longer.
    const lerp = (a: number, b: number) => a + (b - a) * storm;
    d.set([time % 600, dt, lerp(CALM_FOAM.decay, STORM.foamDecay), 1], 24);
    d.set([lerp(CALM_FOAM.threshold, STORM.foamThreshold), 2.2, storm, 0], 28);
  }

  /** `pace`: how fast the weather is turning (Weather.pace): the sea builds or calms that much sooner. */
  update(time: number, dt: number, pace = 1) {
    if (this.disposed || this.lost) return;
    // The sea builds as the wind rises (fair 1, a shower about 1.9, a storm 2.8) and calms as it
    // drops, over some seconds rather than at once.
    const want = THREE.MathUtils.clamp((windStrength.value - 1.2) / 1.6, 0, 1);
    this.storm += (want - this.storm) * Math.min(1, dt * 0.25 * pace);
    this.writeUniforms(time, Math.min(dt, 0.1));
    const enc = this.device.createCommandEncoder({ label: 'ocean-sim' });
    const pass = enc.beginComputePass();
    const n = this.active;
    pass.setPipeline(this.evolve.pipeline);
    pass.setBindGroup(0, this.evolve.bind);
    pass.dispatchWorkgroups(N / 16, N / 16, n);
    pass.setPipeline(this.rows.pipeline);
    pass.setBindGroup(0, this.rows.bind);
    pass.dispatchWorkgroups(N, 1, n);
    pass.setPipeline(this.cols.pipeline);
    for (let c = 0; c < n; c++) {
      pass.setBindGroup(0, this.cols.binds[c]);
      pass.dispatchWorkgroups(N, 1, 1);
    }
    pass.setPipeline(this.mips.pipeline);
    for (let c = 0; c < n; c++) {
      this.mips.binds[c].forEach((b, i) => {
        const size = N >> (i + 1);
        pass.setBindGroup(0, b);
        pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 1);
      });
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** How many cascades to simulate (3; 2 leaves out the finest, for the sea's low tier). */
  setCascades(n: number) {
    this.active = THREE.MathUtils.clamp(Math.round(n), 1, CASCADES);
  }

  dispose() {
    this.disposed = true;
    for (const c of this.cascades) for (const t of [c.disp, c.deriv, c.foam]) t.dispose();
    for (const b of this.buffers) b.destroy();
    this.uniform.destroy();
    for (const t of this.gpuTextures) t.destroy();
  }
}
