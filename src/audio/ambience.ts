// Island ambience: ocean swells, foam wash, wind, distant gulls and songbirds by day, crickets by
// night. It follows the listener (setScene): surf close and bright down by the water, a far wash
// from high above; the wind with the weather. Lookahead-scheduled.
import { clamp, glide, ramp, rnd, Voice, type Bus, type Engine } from './core';
import { chirp } from './sounds';
import type { SoundScene } from './sfx';

const TICK_MS = 500;
const LOOKAHEAD = 3;

interface Layer {
  body: GainNode;
  lp: BiquadFilterNode;
  wash: GainNode;
  washBp: BiquadFilterNode;
  next: number;
}

/**
 * A cricket's chirp train: each chirp three to five quick pulses of a pure high tone (the wing's
 * file and scraper), the train a few chirps long, as in a warm night's meadow.
 */
function cricket(v: Voice, t: number) {
  const f = rnd(4200, 5200);
  const chirps = 2 + Math.floor(rnd(0, 4));
  const gap = rnd(0.32, 0.5);
  const bp = v.filter('bandpass', f, 6);
  for (let c = 0; c < chirps; c++) {
    const pulses = 3 + Math.floor(rnd(0, 3));
    for (let i = 0; i < pulses; i++) {
      const ts = t + c * gap + i * 0.034;
      const g = v.gain(0, bp);
      v.osc('sine', f * rnd(0.995, 1.005), ts, ts + 0.03, g);
      ramp(g.gain, ts, [[0, 0], [0.004, 1], [0.02, 0.6], [0.028, 0]]);
    }
  }
}

/** A distant gull: a few rising-falling "kee-ow" cries, raspy from fast amplitude modulation. */
function gull(v: Voice, t: number) {
  const n = 1 + Math.floor(rnd(1, 4));
  const base = rnd(950, 1300);
  const calls: [number, number, number][] = [];
  let tc = t;
  for (let i = 0; i < n; i++) {
    const dur = i === n - 1 ? rnd(0.3, 0.42) : rnd(0.16, 0.24);
    calls.push([tc, dur, base * (1 - i * 0.03) * rnd(0.97, 1.03)]);
    tc += dur + rnd(0.08, 0.16);
  }
  const lp = v.filter('lowpass', 2600, 0.7);
  const rough = v.gain(1, lp);
  v.osc('sine', rnd(38, 55), t, tc, v.gain(0.45, rough.gain));
  for (const [ts, dur, f] of calls) {
    const g = v.gain(0, rough);
    const o = v.osc('sawtooth', f, ts, ts + dur + 0.03, v.filter('bandpass', 2000, 1.1, g));
    o.connect(v.filter('lowpass', 1300, 0.7, v.gain(0.35, g)));
    glide(o.frequency, ts, [[0, f * 0.78], [dur * 0.3, f * 1.12], [dur, f * 0.72]]);
    ramp(g.gain, ts, [[0, 0], [0.03, 1], [dur * 0.7, 0.8], [dur, 0]]);
  }
}

export class Ambience {
  private readonly ctx: BaseAudioContext;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly bus: Bus;
  private readonly bed: Voice;
  private readonly layers: Layer[] = [];
  private readonly wind: { g: GainNode; bp: BiquadFilterNode; next: number };
  private readonly rainGain: GainNode;
  private rainLevel = -1;
  /** The surf's level and brightness (by the listener's height), and the wind's (by the weather). */
  private readonly surf: GainNode;
  private readonly surfLp: BiquadFilterNode;
  private readonly windMul: GainNode;
  private night = 0;
  private nextCricket: number;

  /** The listener's surroundings: eased, so a camera flight is heard as a smooth change. */
  setScene(s: SoundScene) {
    const t = this.ctx.currentTime;
    // From down at the water (height ~2) to high above (~40 and up): close surf to a far wash.
    const near = clamp(1 - (s.height - 2) / 34, 0, 1);
    this.surf.gain.setTargetAtTime(0.55 + 0.75 * near, t, 0.6);
    this.surfLp.frequency.setTargetAtTime(2200 + 15000 * near * near, t, 0.6);
    this.windMul.gain.setTargetAtTime((0.6 + 1.6 * s.wind) * (1 + 1.2 * s.storm) * (0.8 + 0.5 * (1 - near)), t, 1.2);
    this.night = s.night;
  }

  /** 0..1 rain intensity; eased so showers fade in and out. */
  setRain(level: number) {
    const v = Math.round(level * 50) / 50;
    if (v === this.rainLevel) return;
    this.rainLevel = v;
    this.rainGain.gain.setTargetAtTime(v * 0.16, this.ctx.currentTime, 1.2);
  }
  private readonly events = new Set<Voice>();
  private nextGull: number;
  private nextBird: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dead = false;

  constructor(private readonly e: Engine, level = 0.5) {
    const ctx = (this.ctx = e.ctx);
    const now = ctx.currentTime;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    for (const [g, dest] of [[this.dry, e.amb.dry], [this.wet, e.amb.wet]] as const) {
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(level, now + 3);
      g.connect(dest);
    }
    this.bus = { dry: this.dry, wet: this.wet };

    const bed = (this.bed = new Voice(e, this.bus, 1, 0, 0.3));
    bed.noise(now, Infinity, bed.filter('lowpass', 220, 0.6, bed.gain(0.22)), e.brown, 0.9);
    this.surfLp = bed.filter('lowpass', 17000, 0.5);
    this.surf = bed.gain(1, this.surfLp);
    this.windMul = bed.gain(1);
    for (const pan of [-0.55, 0.55]) {
      const p = bed.pan(pan, this.surf);
      const body = bed.gain(0.05, p);
      const lp = bed.filter('lowpass', 340, 0.5, body);
      const wash = bed.gain(0, p);
      const washBp = bed.filter('bandpass', 3000, 0.6, wash);
      const src = bed.noise(now, Infinity, lp, e.pink, rnd(0.92, 1.05));
      src.connect(washBp);
      body.gain.setValueAtTime(0.05, now);
      lp.frequency.setValueAtTime(340, now);
      wash.gain.setValueAtTime(0, now);
      this.layers.push({ body, lp, wash, washBp, next: now + rnd(0, 3) });
    }
    const wg = bed.gain(0.015, this.windMul);
    const wbp = bed.filter('bandpass', 600, 0.9, wg);
    bed.noise(now, Infinity, wbp, e.pink, 0.8);
    wg.gain.setValueAtTime(0.015, now);
    wbp.frequency.setValueAtTime(600, now);
    this.wind = { g: wg, bp: wbp, next: now };
    // Rain: a hiss of fine drops plus a soft low patter, silent until a shower arrives.
    this.rainGain = bed.gain(0);
    bed.noise(now, Infinity, bed.filter('bandpass', 5200, 0.35, this.rainGain), e.pink, 1);
    const patter = bed.gain(0.35, this.rainGain);
    bed.noise(now, Infinity, bed.filter('lowpass', 900, 0.5, patter), e.brown, 1.1);

    this.nextGull = now + rnd(4, 12);
    this.nextBird = now + rnd(2, 7);
    this.nextCricket = now + rnd(1, 4);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private tick() {
    const now = this.ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    for (const L of this.layers) {
      if (L.next < now) L.next = now;
      while (L.next < horizon) L.next = this.wave(L, L.next);
    }
    const w = this.wind;
    if (w.next < now) w.next = now;
    while (w.next < horizon) {
      const dur = rnd(2.5, 6);
      const gust = Math.random() < 0.15;
      w.g.gain.linearRampToValueAtTime(gust ? rnd(0.06, 0.09) : rnd(0.008, 0.04), w.next + dur);
      w.bp.frequency.exponentialRampToValueAtTime(gust ? rnd(800, 1200) : rnd(350, 900), w.next + dur);
      w.next += dur;
    }
    // By day gulls and songbirds; they fall quiet towards night, when the crickets start up.
    const day = 1 - this.night;
    if (this.nextGull < now) this.nextGull = now + rnd(2, 8);
    while (this.nextGull < horizon) {
      if (Math.random() < 0.2 + 0.8 * day) {
        const v = this.event(rnd(0.25, 0.55), rnd(-0.8, 0.8), 0.6);
        gull(v, this.nextGull);
        v.seal();
      }
      this.nextGull += Math.random() < 0.25 ? rnd(1.2, 3) : rnd(9, 28);
    }
    if (this.nextBird < now) this.nextBird = now + rnd(1, 5);
    while (this.nextBird < horizon) {
      if (Math.random() < day * day) {
        const v = this.event(rnd(0.5, 0.9), rnd(-0.7, 0.7), 0.35);
        chirp(v, this.nextBird, 3 + Math.floor(Math.random() * 6), rnd(0.06, 0.11));
        v.seal();
      }
      this.nextBird += Math.random() < 0.3 ? rnd(0.6, 1.5) : rnd(5, 16);
    }
    if (this.nextCricket < now) this.nextCricket = now + rnd(0.5, 2);
    while (this.nextCricket < horizon) {
      if (this.night > 0.45 && this.rainLevel < 0.3) {
        const v = this.event(rnd(0.05, 0.12) * this.night, rnd(-0.85, 0.85), 0.25);
        cricket(v, this.nextCricket);
        v.seal();
      }
      this.nextCricket += rnd(0.7, 2.2);
    }
  }

  /** Schedules one swell starting at T; returns when the next one should start. */
  private wave(L: Layer, T: number): number {
    const P = rnd(5.5, 10);
    const A = rnd(0.45, 1);
    const crest = T + P * rnd(0.45, 0.6);
    const end = T + P;
    L.body.gain.linearRampToValueAtTime(0.05 + 0.45 * A, crest);
    L.body.gain.linearRampToValueAtTime(rnd(0.04, 0.08), end);
    L.lp.frequency.exponentialRampToValueAtTime(320 + 900 * A, crest);
    L.lp.frequency.exponentialRampToValueAtTime(rnd(300, 380), end);
    L.wash.gain.linearRampToValueAtTime(0, crest - 0.5);
    L.wash.gain.linearRampToValueAtTime(0.2 * A, crest + 0.25);
    L.wash.gain.linearRampToValueAtTime(0.05 * A, crest + (end - crest) * 0.6);
    L.wash.gain.linearRampToValueAtTime(0, end);
    L.washBp.frequency.setValueAtTime(rnd(2600, 4200), crest - 0.5);
    L.washBp.frequency.exponentialRampToValueAtTime(1500, end);
    return end;
  }

  private event(volume: number, pan: number, wet: number): Voice {
    const v = new Voice(this.e, this.bus, volume, pan, wet);
    this.events.add(v);
    v.onDone = () => this.events.delete(v);
    return v;
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bed.destroy();
    for (const v of [...this.events]) v.destroy();
    this.events.clear();
    this.dry.disconnect();
    this.wet.disconnect();
  }
}
