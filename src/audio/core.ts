// Shared Web Audio plumbing: engine graph, generated buffers, the Voice node tracker and envelope helpers.

export interface Bus {
  dry: AudioNode;
  wet: AudioNode;
}

interface GainBus {
  dry: GainNode;
  wet: GainNode;
}

export interface Engine {
  ctx: BaseAudioContext;
  master: GainNode;
  sfx: GainBus;
  amb: GainBus;
  music: GainBus;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  warm: PeriodicWave;
  dispose(): void;
}

export const rnd = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

type NoiseColor = 'white' | 'pink' | 'brown';

/** Mono noise buffer; loopable ones get an equal-power crossfade at the seam so looping never clicks. */
function noiseBuffer(ctx: BaseAudioContext, seconds: number, color: NoiseColor): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const fade = Math.floor(0.08 * sr);
  const tmp = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < tmp.length; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'white') tmp[i] = w;
    else if (color === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      tmp[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      tmp[i] = last;
    }
  }
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let s = tmp[i];
    if (i < fade) {
      const a = i / fade;
      s = tmp[i] * Math.sqrt(a) + tmp[n + i] * Math.sqrt(1 - a);
    }
    out[i] = s;
    const m = Math.abs(s);
    if (m > peak) peak = m;
  }
  const k = peak > 0 ? 0.95 / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= k;
  return buf;
}

/** A short smear of darkened noise added at `at` s: one reflection (a hard surface is never a click). */
function burst(d: Float32Array, sr: number, at: number, amp: number, len: number, dark: number) {
  const i0 = Math.floor(at * sr), n = Math.floor(len * sr);
  let lp = 0;
  for (let i = 0; i < n && i0 + i < d.length; i++) {
    lp += dark * (Math.random() * 2 - 1 - lp);
    const env = Math.exp((-6 * i) / n) * Math.min(1, i / (0.0006 * sr));
    d[i0 + i] += lp * amp * env;
  }
}

/**
 * The open air round an island, not a room: a quick bounce off the ground, slaps from the rocks
 * and cliffs close by, a faint late echo off the far hills, and only a thin, fast-darkening wash
 * after (outdoors little comes back, and the air takes the treble first). Slightly different on
 * each side, so it spreads.
 */
function outdoorImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    burst(d, sr, rnd(0.004, 0.007), 0.5, 0.006, 0.7);
    for (let r = 0; r < 8; r++) {
      const at = rnd(0.035, 0.22);
      burst(d, sr, at, rnd(0.12, 0.3) * (1 - at * 2.5), rnd(0.008, 0.02), 0.45 - at);
    }
    for (let r = 0; r < 4; r++) burst(d, sr, rnd(0.34, 0.72), rnd(0.04, 0.09), rnd(0.03, 0.06), 0.12);
    let lp = 0;
    for (let i = Math.floor(0.03 * sr); i < n; i++) {
      const x = i / n;
      lp += (0.5 - 0.46 * x) * (Math.random() * 2 - 1 - lp);
      d[i] += lp * 0.09 * Math.exp(-x * 5.5);
    }
  }
  return buf;
}

function warmWave(ctx: BaseAudioContext): PeriodicWave {
  const h = 12;
  const real = new Float32Array(h);
  const imag = new Float32Array(h);
  for (let k = 1; k < h; k++) imag[k] = (k % 2 ? 1 : 0.55) / Math.pow(k, 1.6);
  return ctx.createPeriodicWave(real, imag);
}

export function createEngine(ctx: BaseAudioContext): Engine {
  // Mastering: rumble cut, a gentle glue compressor holding the mix together, then a fast limiter
  // so the loudest moments (a fanfare over thunder) never clip.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  limiter.connect(ctx.destination);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 12;
  comp.ratio.value = 2.2;
  comp.attack.value = 0.015;
  comp.release.value = 0.3;
  comp.connect(limiter);
  const rumble = ctx.createBiquadFilter();
  rumble.type = 'highpass';
  rumble.frequency.value = 28;
  rumble.Q.value = 0.7;
  rumble.connect(comp);

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(rumble);

  const verb = ctx.createConvolver();
  verb.buffer = outdoorImpulse(ctx, 3);
  const verbReturn = ctx.createGain();
  verbReturn.gain.value = 0.55;
  verb.connect(verbReturn);
  verbReturn.connect(master);

  const bus = (): GainBus => {
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.connect(master);
    wet.connect(verb);
    return { dry, wet };
  };
  const sfx = bus();
  const amb = bus();
  const music = bus();

  return {
    ctx,
    master,
    sfx,
    amb,
    music,
    white: noiseBuffer(ctx, 2, 'white'),
    pink: noiseBuffer(ctx, 5.3, 'pink'),
    brown: noiseBuffer(ctx, 6.7, 'brown'),
    warm: warmWave(ctx),
    dispose() {
      for (const n of [limiter, comp, rumble, master, verb, verbReturn, sfx.dry, sfx.wet, amb.dry, amb.wet, music.dry, music.wet]) n.disconnect();
    },
  };
}

function link(a: AudioNode, d: AudioNode | AudioParam) {
  if ('value' in d) a.connect(d);
  else a.connect(d);
}

/**
 * One sounding event. Every node it creates is tracked; when the last source ends (or the voice is
 * killed) everything is disconnected, so nothing leaks no matter how often sounds fire.
 */
export class Voice {
  readonly ctx: BaseAudioContext;
  readonly out: GainNode;
  readonly panner: StereoPannerNode;
  end = 0;
  done = false;
  onDone: (() => void) | null = null;
  private nodes: AudioNode[] = [];
  private srcs: AudioScheduledSourceNode[] = [];

  /** How many sources (oscillators, buffers) this voice plays: what the voice cap budgets. */
  get sources() {
    return this.srcs.length;
  }
  private live = 0;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  /** `air`: a lowpass (Hz) for a sound heard from far off, the treble lost on the way. */
  constructor(readonly e: Engine, bus: Bus, volume: number, pan = 0, wet = 0, air = 0) {
    const ctx = (this.ctx = e.ctx);
    this.out = ctx.createGain();
    this.out.gain.value = volume;
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = clamp(pan, -1, 1);
    this.nodes.push(this.out, this.panner);
    if (air > 0 && air < 18000) {
      const lp = this.track(ctx.createBiquadFilter());
      lp.type = 'lowpass';
      lp.frequency.value = air;
      lp.Q.value = 0.5;
      this.out.connect(lp);
      lp.connect(this.panner);
    } else this.out.connect(this.panner);
    this.panner.connect(bus.dry);
    if (wet > 0) this.panner.connect(this.gain(wet, bus.wet));
  }

  track<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  gain(value: number, dest: AudioNode | AudioParam | null = this.out): GainNode {
    const g = this.track(this.ctx.createGain());
    g.gain.value = value;
    if (dest) link(g, dest);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode | null = this.out): BiquadFilterNode {
    const f = this.track(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  pan(value: number, dest: AudioNode = this.out): StereoPannerNode {
    const p = this.track(this.ctx.createStereoPanner());
    p.pan.value = clamp(value, -1, 1);
    p.connect(dest);
    return p;
  }

  osc(type: OscillatorType | PeriodicWave, freq: number, t0: number, t1: number, dest: AudioNode | AudioParam | null = this.out): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType;
    else o.setPeriodicWave(type);
    o.frequency.value = freq;
    if (dest) link(o, dest);
    this.source(o, t0, t1);
    return o;
  }

  noise(t0: number, t1: number, dest: AudioNode | null = this.out, buf: AudioBuffer = this.e.white, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    if (dest) s.connect(dest);
    this.source(s, t0, t1, Math.random() * buf.duration);
    return s;
  }

  private source(s: AudioScheduledSourceNode, t0: number, t1: number, offset?: number) {
    this.srcs.push(s);
    this.live++;
    s.onended = () => {
      if (--this.live <= 0) this.destroy();
    };
    if (offset !== undefined) (s as AudioBufferSourceNode).start(t0, offset);
    else s.start(t0);
    if (Number.isFinite(t1)) {
      s.stop(t1);
      if (t1 > this.end) this.end = t1;
    } else this.end = Infinity;
  }

  /** Call after building: a voice that created no sources is torn down immediately. */
  seal(): this {
    if (this.live === 0) this.destroy();
    return this;
  }

  /** Quick fade then hard teardown (used for voice stealing and stopping long-running beds). */
  kill(fade = 0.03) {
    if (this.done || this.killTimer) return;
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    for (const s of this.srcs) {
      try {
        s.stop(now + fade + 0.01);
      } catch {
        // already stopped
      }
    }
    if (typeof setTimeout === 'function') this.killTimer = setTimeout(() => this.destroy(), (fade + 0.08) * 1000);
  }

  destroy() {
    if (this.done) return;
    this.done = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    for (const s of this.srcs) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped
      }
      s.disconnect();
    }
    for (const n of this.nodes) n.disconnect();
    this.srcs = [];
    this.nodes = [];
    const cb = this.onDone;
    this.onDone = null;
    cb?.();
  }
}

/** Linear attack to `peak`, exponential decay to silence. Param should start at 0. */
export function perc(p: AudioParam, t: number, peak: number, attack: number, decay: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  p.setValueAtTime(0, t + attack + decay + 0.001);
}

/** Piecewise-exponential glide through [time offset, value] points (values must be > 0). */
export function glide(p: AudioParam, t: number, pts: readonly (readonly [number, number])[]) {
  p.setValueAtTime(pts[0][1], t + pts[0][0]);
  for (let i = 1; i < pts.length; i++) p.exponentialRampToValueAtTime(pts[i][1], t + pts[i][0]);
}

/** Piecewise-linear automation through [time offset, value] points. */
export function ramp(p: AudioParam, t: number, pts: readonly (readonly [number, number])[]) {
  p.setValueAtTime(pts[0][1], t + pts[0][0]);
  for (let i = 1; i < pts.length; i++) p.linearRampToValueAtTime(pts[i][1], t + pts[i][0]);
}
