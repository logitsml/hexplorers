// Generative pastoral music: Markov chord walk in D major (with a mixolydian bVII), warm pads, soft bass,
// marimba/kalimba arpeggios with drifting density, an occasional breathy flute phrase and glockenspiel glints.
import { mtof, perc, pick, ramp, rnd, Voice, type Bus, type Engine } from './core';

const TICK_MS = 250;
const LOOKAHEAD = 1.3;
const TONIC = 50; // D3

type ChordName = 'I' | 'ii' | 'IV' | 'V' | 'vi' | 'bVII';

const CHORDS: Record<ChordName, { root: number; third: number; color: readonly number[] }> = {
  I: { root: 0, third: 4, color: [14, 11] },
  ii: { root: 2, third: 3, color: [10, 14] },
  IV: { root: 5, third: 4, color: [14, 11] },
  V: { root: 7, third: 4, color: [10, 14] },
  vi: { root: 9, third: 3, color: [10, 14] },
  bVII: { root: 10, third: 4, color: [14] },
};

const NEXT: Record<ChordName, readonly (readonly [ChordName, number])[]> = {
  I: [['IV', 3], ['vi', 2], ['V', 1.5], ['ii', 1], ['bVII', 0.8]],
  ii: [['V', 3], ['IV', 1.5], ['vi', 1]],
  IV: [['I', 3], ['V', 2], ['ii', 1], ['vi', 1]],
  V: [['I', 3], ['vi', 2], ['IV', 1.2]],
  vi: [['IV', 3], ['ii', 1.5], ['V', 1.5], ['I', 1]],
  bVII: [['IV', 2], ['I', 3]],
};

const MELODY = [69, 71, 74, 76, 78, 81, 83, 86]; // D major pentatonic, A4..D6
const GLOCK = [86, 88, 90, 93, 95, 98];
const BAR_WEIGHT = [1, 0.35, 0.7, 0.4, 0.85, 0.35, 0.65, 0.45];

type Ev =
  | { k: 'arp'; m: number; vel: number }
  | { k: 'lead'; m: number; steps: number }
  | { k: 'glock'; m: number }
  | { k: 'bass'; m: number; vel: number };

function weighted<T>(opts: readonly (readonly [T, number])[]): T {
  let sum = 0;
  for (const [, w] of opts) sum += w;
  let x = Math.random() * sum;
  for (const [o, w] of opts) if ((x -= w) <= 0) return o;
  return opts[opts.length - 1][0];
}

function nearestChordTone(i: number, pcs: ReadonlySet<number>): number {
  for (let d = 0; d < MELODY.length; d++) {
    for (const j of [i - d, i + d]) if (j >= 0 && j < MELODY.length && pcs.has((MELODY[j] - TONIC) % 12)) return j;
  }
  return i;
}

export class Music {
  private readonly ctx: BaseAudioContext;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly bus: Bus;
  private readonly voices = new Set<Voice>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private dead = false;

  private next: number;
  private pos = 0;
  private len = 16;
  private stepDur = 0.45;
  private chord: ChordName = 'I';
  private plan: Ev[][] = [];
  private density = 0.35;
  private ratio = 4;
  private pluckDecay = 1.3;
  private sectionLeft = 0;
  private lastMelody = false;
  private arpIdx = 3;
  private arpDir = 1;

  constructor(private readonly e: Engine, level = 0.3) {
    const ctx = (this.ctx = e.ctx);
    const now = ctx.currentTime;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    for (const [g, dest] of [[this.dry, e.music.dry], [this.wet, e.music.wet]] as const) {
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(level, now + 4);
      g.connect(dest);
    }
    this.bus = { dry: this.dry, wet: this.wet };
    this.next = now + 0.3;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private tick() {
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05;
    while (this.next < now + LOOKAHEAD) {
      if (this.pos === 0) this.beginChord(this.next);
      for (const ev of this.plan[this.pos]) this.play(ev, this.next + rnd(-0.006, 0.012));
      this.next += this.stepDur;
      if (++this.pos >= this.len) this.pos = 0;
    }
  }

  private newSection() {
    this.sectionLeft = 5 + Math.floor(Math.random() * 6);
    this.ratio = Math.random() < 0.5 ? 4 : rnd(5.2, 5.9);
    this.pluckDecay = rnd(1.0, 1.7);
    this.stepDur = 60 / rnd(62, 72) / 2;
    this.density = rnd(0.2, 0.5);
  }

  private beginChord(t: number) {
    if (this.plan.length) this.chord = weighted(NEXT[this.chord]);
    if (--this.sectionLeft <= 0) this.newSection();
    const c = CHORDS[this.chord];
    this.len = this.chord !== 'I' && Math.random() < 0.18 ? 8 : 16;
    this.density = Math.min(0.6, Math.max(0.12, this.density + rnd(-0.08, 0.08)));
    const breath = Math.random() < 0.12;

    let base = TONIC + c.root;
    if (base > 57) base -= 12;
    const color = Math.random() < 0.55 ? pick(c.color) : null;
    const padNotes = [base, base + 7, base + 12 + c.third];
    if (color !== null) padNotes.push(base + 12 + color);
    this.pad(t, padNotes, this.len * this.stepDur);

    const plan: Ev[][] = Array.from({ length: this.len }, () => []);
    plan[0].push({ k: 'bass', m: base - 12, vel: 0.22 });
    if (this.len === 16 && Math.random() < 0.4) plan[8].push({ k: 'bass', m: base - 5, vel: 0.12 });

    const tones = [0, 7, c.third, 12 + c.third, ...(color !== null ? [color] : [])];
    const pool = [
      ...new Set(
        [0, 12, 24]
          .flatMap((o) => tones.map((x) => TONIC + c.root + x + o))
          .filter((m) => m >= 62 && m <= 86),
      ),
    ].sort((a, b) => a - b);
    if (!breath) {
      for (let s = 0; s < this.len; s++) {
        const w = BAR_WEIGHT[s % 8];
        if (s !== 0 && Math.random() > this.density * w * 1.6) continue;
        if (Math.random() < 0.15) this.arpDir = -this.arpDir;
        this.arpIdx += this.arpDir * (Math.random() < 0.75 ? 1 : 2);
        if (this.arpIdx >= pool.length) {
          this.arpIdx = pool.length - 2;
          this.arpDir = -1;
        }
        if (this.arpIdx < 0) {
          this.arpIdx = 1;
          this.arpDir = 1;
        }
        this.arpIdx = Math.max(0, Math.min(pool.length - 1, this.arpIdx));
        plan[s].push({ k: 'arp', m: pool[this.arpIdx], vel: 0.12 * (0.65 + 0.35 * w) * rnd(0.8, 1.1) });
      }
    }

    if (this.len === 16 && Math.random() < (this.lastMelody ? 0.15 : 0.32)) {
      this.lastMelody = true;
      const chordPcs = new Set([c.root, c.root + 7, c.root + c.third].map((x) => x % 12));
      let s = pick([2, 4, 4, 6]);
      let i = Math.floor(rnd(1, MELODY.length - 2));
      const count = 3 + Math.floor(Math.random() * 3);
      for (let n = 0; n < count && s < this.len - 2; n++) {
        const last = n === count - 1 || s >= this.len - 6;
        if (last) i = nearestChordTone(i, chordPcs);
        const steps = last ? Math.min(6, this.len - s) : pick([2, 2, 3, 4]);
        plan[s].push({ k: 'lead', m: MELODY[i], steps });
        s += steps;
        if (last) break;
        i = Math.max(0, Math.min(MELODY.length - 1, i + pick([-2, -1, -1, 1, 1, 2])));
      }
    } else this.lastMelody = false;

    if (Math.random() < 0.18) plan[Math.floor(rnd(2, this.len))].push({ k: 'glock', m: pick(GLOCK) });
    this.plan = plan;
  }

  private voice(pan: number, wet: number): Voice {
    const v = new Voice(this.e, this.bus, 1, pan, wet);
    this.voices.add(v);
    v.onDone = () => this.voices.delete(v);
    return v;
  }

  private play(ev: Ev, t: number) {
    if (ev.k === 'arp') {
      const v = this.voice(rnd(-0.35, 0.35), 0.35);
      const f = mtof(ev.m);
      const g1 = v.gain(0);
      v.osc('sine', f, t, t + this.pluckDecay + 0.1, g1);
      perc(g1.gain, t, ev.vel, 0.003, this.pluckDecay);
      if (f * this.ratio < 12000) {
        const g2 = v.gain(0);
        v.osc('sine', f * this.ratio, t, t + 0.3, g2);
        perc(g2.gain, t, ev.vel * 0.28, 0.001, this.pluckDecay * 0.1);
      }
      const g3 = v.gain(0);
      v.osc('triangle', f * 2, t, t + this.pluckDecay * 0.4 + 0.05, g3);
      perc(g3.gain, t, ev.vel * 0.1, 0.002, this.pluckDecay * 0.35);
      v.seal();
    } else if (ev.k === 'lead') {
      const v = this.voice(rnd(-0.15, 0.15), 0.45);
      const f = mtof(ev.m);
      const dur = ev.steps * this.stepDur;
      const end = t + dur + 0.5;
      const g = v.gain(0, v.filter('lowpass', 2400, 0.6));
      const o1 = v.osc('triangle', f, t, end, g);
      const o2 = v.osc('sine', f * 2, t, end, v.gain(0.12, g));
      const vib = v.gain(0, null);
      vib.connect(o1.detune);
      vib.connect(o2.detune);
      v.osc('sine', rnd(4.8, 5.6), t, end, vib);
      ramp(vib.gain, t, [[0, 0], [Math.min(0.35, dur * 0.5), 0], [Math.min(0.9, dur), 10]]);
      ramp(g.gain, t, [[0, 0], [0.09, 0.07], [dur, 0.06], [dur + 0.4, 0]]);
      const bg = v.gain(0);
      v.noise(t, end, v.filter('bandpass', f * 2, 2, bg), this.e.pink);
      ramp(bg.gain, t, [[0, 0], [0.05, 0.02], [0.25, 0.006], [dur, 0.004], [dur + 0.3, 0]]);
      v.seal();
    } else if (ev.k === 'glock') {
      const v = this.voice(rnd(-0.5, 0.5), 0.5);
      const f = mtof(ev.m);
      for (const [ratio, a, d] of [[1, 0.04, 1.6], [2.76, 0.012, 0.5], [5.4, 0.006, 0.2]] as const) {
        const g = v.gain(0);
        v.osc('sine', f * ratio, t, t + d + 0.05, g);
        perc(g.gain, t, a, 0.002, d);
      }
      v.seal();
    } else {
      const v = this.voice(0, 0.1);
      const f = mtof(ev.m);
      const g = v.gain(0, v.filter('lowpass', 420, 0.7));
      v.osc('sine', f, t, t + 3.2, g);
      v.osc('triangle', f, t, t + 3.2, v.gain(0.3, g));
      ramp(g.gain, t, [[0, 0], [0.05, ev.vel], [0.7, ev.vel * 0.7], [3.1, 0]]);
      v.seal();
    }
  }

  private pad(t: number, notes: readonly number[], dur: number) {
    const v = this.voice(0, 0.5);
    const g = v.gain(0);
    const lp = v.filter('lowpass', 480, 0.5, g);
    const end = t + dur + 2.8;
    for (const m of notes) {
      for (const det of [-6, 6]) {
        const o = v.osc(this.e.warm, mtof(m), t, end, lp);
        o.detune.value = det + rnd(-2, 2);
      }
    }
    ramp(lp.frequency, t, [[0, 450], [dur * 0.5, rnd(750, 1100)], [dur + 2.6, 480]]);
    const amp = 0.038 / Math.sqrt(notes.length / 3);
    ramp(g.gain, t, [[0, 0], [1.6, amp], [dur, amp * 0.9], [dur + 2.6, 0]]);
    v.seal();
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const v of [...this.voices]) v.destroy();
    this.voices.clear();
    this.dry.disconnect();
    this.wet.disconnect();
  }
}
