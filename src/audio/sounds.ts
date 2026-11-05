// One-shot sound recipes. Each receives a fresh Voice, a start time and a pitch multiplier `r`.
import { glide, mtof, perc, pick, ramp, rnd, type Voice } from './core';

type Recipe = (v: Voice, t: number, r: number) => void;

type Partial3 = readonly [ratio: number, amp: number, decay: number];

const BELL: readonly Partial3[] = [
  [1, 1, 1],
  [2.0, 0.42, 0.55],
  [3.01, 0.18, 0.32],
  [4.18, 0.11, 0.2],
  [5.43, 0.05, 0.12],
];
const SOFT_BELL: readonly Partial3[] = [
  [0.5, 0.18, 1.4],
  [1, 1, 1],
  [2.0, 0.28, 0.5],
  [3.0, 0.1, 0.3],
  [4.07, 0.05, 0.18],
];
const COIN: readonly Partial3[] = [
  [1, 1, 1],
  [1.71, 0.65, 0.7],
  [2.53, 0.45, 0.5],
  [3.32, 0.3, 0.35],
];
const STEEL: readonly Partial3[] = [
  [1, 1, 1],
  [2.43, 0.55, 0.6],
  [3.91, 0.35, 0.4],
  [5.62, 0.22, 0.25],
];

// D major / pentatonic so in-game chimes sit inside the music's key.
const PENTA = [74, 76, 78, 81, 83, 86, 88, 90, 93, 95];

/** Sum of decaying sine partials. */
export function bell(v: Voice, t: number, f: number, amp: number, decay: number, dest: AudioNode = v.out, partials: readonly Partial3[] = BELL) {
  for (const [ratio, a, d] of partials) {
    const fr = f * ratio;
    if (fr > 15000) continue;
    const g = v.gain(0, dest);
    v.osc('sine', fr, t, t + decay * d + 0.06, g);
    perc(g.gain, t, amp * a, 0.002, decay * d);
  }
}

/** Short noise excitation ringing through resonant band-passes: the core of every wooden hit. */
function knock(v: Voice, t: number, amp: number, freqs: readonly number[], q: number, dest: AudioNode = v.out, len = 0.007) {
  const exc = v.gain(0, null);
  v.noise(t, t + len + 0.05, exc);
  perc(exc.gain, t, amp, 0.0006, len);
  for (const f of freqs) exc.connect(v.filter('bandpass', f, q, dest));
}

/** Sine body with a downward pitch drop (wooden/stone mass hitting the table). */
function thump(v: Voice, t: number, f0: number, f1: number, amp: number, decay: number, dest: AudioNode = v.out) {
  const g = v.gain(0, dest);
  const o = v.osc('sine', f0, t, t + decay + 0.05, g);
  glide(o.frequency, t, [[0, f0], [decay * 0.7, f1]]);
  perc(g.gain, t, amp, 0.003, decay);
}

/** Band-passed noise sweep through three frequencies with a rise/fall envelope. */
function sweep(v: Voice, t: number, dur: number, f: readonly [number, number, number], q: number, amp: number, dest: AudioNode = v.out, buf?: AudioBuffer) {
  const g = v.gain(0, dest);
  const bp = v.filter('bandpass', f[0], q, g);
  v.noise(t, t + dur + 0.05, bp, buf);
  glide(bp.frequency, t, [[0, f[0]], [dur * 0.5, f[1]], [dur, f[2]]]);
  ramp(g.gain, t, [[0, 0], [dur * 0.45, amp], [dur, 0]]);
}

/** Filtered noise burst (perc envelope). */
function burst(v: Voice, t: number, type: BiquadFilterType, freq: number, q: number, amp: number, decay: number, dest: AudioNode = v.out, buf?: AudioBuffer) {
  const g = v.gain(0, dest);
  v.noise(t, t + decay + 0.06, v.filter(type, freq, q, g), buf);
  perc(g.gain, t, amp, 0.002, decay);
}

/** What a piece comes down on: the terrain under it (and whether the sea is right there). */
export type Ground = 'stone' | 'clay' | 'earth' | 'grass' | 'leaves' | 'sand';

/** How soft each ground is: it takes the edge off the piece's own knock (a lowpass, Hz). */
export const GROUND_DAMP: Record<Ground, number> = { stone: 20000, clay: 9000, earth: 7000, grass: 8000, leaves: 9000, sand: 6500 };

/**
 * The ground's part in a piece landing, on top of the piece's own sound (`weight`: a road 0.6, a
 * house 1, a city 1.4). Stone rings and pebbles skitter; clay gives a dull dense knock and a puff
 * of dust; tilled earth a soft thud and a crisp of straw; grass a thud and a swish; the forest
 * floor a twig snapping and leaves rustling; sand a muffled thud and a hiss of grains. By the sea,
 * a slap of water too.
 */
export function groundLayer(v: Voice, t: number, ground: Ground, weight: number, r: number, wet = false) {
  const w = weight;
  switch (ground) {
    case 'stone':
      knock(v, t, 0.55 * w, [1850 * r, 2900 * r, 4100 * r], 22, v.gain(1.8), 0.004);
      knock(v, t + rnd(0.012, 0.02), 0.25 * w, [2300 * r, 3500 * r], 20, v.gain(1.4), 0.003);
      crackles(v, t + 0.04, 0.14 + 0.06 * w, 4 + Math.round(4 * w), 0.18 * w, v.filter('bandpass', 3300 * r, 1.4));
      break;
    case 'clay':
      knock(v, t, 0.6 * w, [310 * r, 620 * r, 940 * r], 6, v.gain(1.6), 0.009);
      burst(v, t + 0.01, 'lowpass', 1200 * r, 0.6, 0.35 * w, 0.16, v.out, v.e.pink);
      break;
    case 'earth':
      thump(v, t, 120 * r, 70 * r, 0.35 * w, 0.1);
      burst(v, t, 'lowpass', 700 * r, 0.6, 0.4 * w, 0.08, v.out, v.e.brown);
      crackles(v, t + 0.005, 0.12, 6 + Math.round(5 * w), 0.14 * w, v.filter('highpass', 4200 * r, 0.7));
      break;
    case 'grass':
      thump(v, t, 130 * r, 80 * r, 0.3 * w, 0.08);
      sweep(v, t, 0.14, [2600 * r, 3800 * r, 2200 * r], 1.1, 0.22 * w);
      break;
    case 'leaves':
      thump(v, t, 125 * r, 75 * r, 0.28 * w, 0.09);
      if (Math.random() < 0.7) knock(v, t + rnd(0.005, 0.02), 0.35 * w, [2400 * r, 3600 * r], 9, v.gain(1.2), 0.002);
      crackles(v, t + 0.02, 0.22 + 0.08 * w, 10 + Math.round(6 * w), 0.12 * w, v.filter('bandpass', 5200 * r, 0.9));
      break;
    case 'sand':
      thump(v, t, 105 * r, 62 * r, 0.32 * w, 0.12);
      sweep(v, t, 0.22, [5200 * r, 3600 * r, 2400 * r], 0.8, 0.18 * w, v.out, v.e.pink);
      break;
  }
  if (wet) {
    // A wave's slap on the rocks below, a breath after the landing.
    sweep(v, t + rnd(0.06, 0.12), 0.32, [1400 * r, 700 * r, 380 * r], 1.2, 0.2 * w, v.out, v.e.pink);
  }
}

/** Brass-like note: detuned saws through a lowpass that blooms open, with a small pitch scoop. */
function brass(v: Voice, t: number, f: number, dur: number, amp: number, bright = 2200, dest: AudioNode = v.out) {
  const g = v.gain(0, dest);
  const lp = v.filter('lowpass', f * 1.5, 1.1, g);
  for (const det of [-7, 6]) {
    const o = v.osc('sawtooth', f, t, t + dur + 0.45, lp);
    o.detune.value = det;
    glide(o.frequency, t, [[0, f * 0.975], [0.07, f]]);
  }
  glide(lp.frequency, t, [[0, f * 1.4], [0.09, Math.max(bright, f * 2)], [Math.max(dur, 0.12), Math.max(bright * 0.55, f * 1.6)], [dur + 0.45, f * 1.1]]);
  ramp(g.gain, t, [[0, 0], [0.05, amp], [Math.max(dur, 0.06), amp * 0.72], [dur + 0.4, 0]]);
}

/** Tiny bird chirp phrase on a single oscillator. */
export function chirp(v: Voice, t: number, notes: number, amp: number, dest: AudioNode = v.out) {
  const base = rnd(2600, 3800);
  const plan: [number, number, number, number][] = [];
  let tn = t;
  for (let i = 0; i < notes; i++) {
    const d = rnd(0.04, 0.1);
    const up = Math.random() < 0.6;
    const f0 = base * rnd(0.85, 1.15) * (up ? 1 : 1.35);
    plan.push([tn, d, f0, f0 * (up ? rnd(1.3, 1.6) : rnd(0.65, 0.8))]);
    tn += d + rnd(0.03, 0.09);
  }
  const g = v.gain(0, dest);
  const o = v.osc('sine', base, t, tn + 0.02, g);
  for (const [ts, d, f0, f1] of plan) {
    o.frequency.setValueAtTime(f0, ts);
    o.frequency.exponentialRampToValueAtTime(f1, ts + d);
    g.gain.setValueAtTime(0, ts);
    g.gain.linearRampToValueAtTime(amp * rnd(0.6, 1), ts + 0.008);
    g.gain.linearRampToValueAtTime(0, ts + d);
  }
}

/** Crackle bursts on one noise source (fire, rustling leaves). */
function crackles(v: Voice, t: number, span: number, count: number, amp: number, dest: AudioNode, minLen = 0.001, maxLen = 0.004) {
  const g = v.gain(0, dest);
  v.noise(t, t + span + 0.05, g);
  const times: number[] = [];
  for (let i = 0; i < count; i++) times.push(t + Math.random() * span);
  times.sort((a, b) => a - b);
  let last = -1;
  for (const tc of times) {
    if (tc < last + 0.002) continue;
    const len = rnd(minLen, maxLen);
    g.gain.setValueAtTime(0, tc);
    g.gain.linearRampToValueAtTime(amp * rnd(0.2, 1), tc + 0.0004);
    g.gain.exponentialRampToValueAtTime(0.0001, tc + len);
    g.gain.setValueAtTime(0, tc + len + 0.0002);
    last = tc + len + 0.0002;
  }
}

/** Two dice tumbling on wood: per-die excitation train through re-tuned resonators. */
const dice: Recipe = (v, t, r) => {
  const body = v.filter('lowpass', 6000, 0.5);
  for (let d = 0; d < 2; d++) {
    const t0 = t + d * rnd(0.012, 0.045);
    const hits: [number, number, boolean][] = [];
    let tt = t0;
    let a = 1;
    hits.push([tt, a, false]);
    for (let b = 0; b < 2; b++) {
      tt += rnd(0.06, 0.1) * (b ? 0.75 : 1);
      a *= rnd(0.55, 0.72);
      hits.push([tt, a, d === 0 && b === 0 && Math.random() < 0.6]);
    }
    a = rnd(0.45, 0.6);
    while (tt < t0 + rnd(0.58, 0.66)) {
      tt += rnd(0.045, 0.085);
      a *= rnd(0.82, 0.95);
      hits.push([tt, a * rnd(0.7, 1.15), false]);
      if (Math.random() < 0.3) {
        tt += rnd(0.013, 0.022);
        hits.push([tt, a * 0.45, false]);
      }
    }
    let gap = rnd(0.045, 0.06);
    a = Math.min(a, 0.25);
    for (let k = 0; k < 4; k++) {
      tt += gap;
      gap *= 0.68;
      a *= 0.62;
      hits.push([tt, a, false]);
    }
    const end = tt + 0.12;
    const mix = v.pan(d ? rnd(0.12, 0.35) : rnd(-0.35, -0.12), body);
    const exc = v.gain(0, null);
    v.noise(t0, end, exc);
    const bpLo = v.filter('bandpass', 260, 2.2, v.gain(2.2, mix));
    const bp1 = v.filter('bandpass', 1500, 11, v.gain(5.5, mix));
    const bp2 = v.filter('bandpass', 3200, 8, v.gain(3.5, mix));
    const air = v.filter('highpass', 5200, 0.7, v.gain(0.35, mix));
    for (const n of [bpLo, bp1, bp2, air]) exc.connect(n);
    let prev = -1;
    for (const [ti, ai, clack] of hits) {
      if (ti < prev + 0.009) continue;
      const len = clack ? 0.004 : rnd(0.005, 0.009);
      bp1.frequency.setValueAtTime(rnd(1150, 2100) * r * (clack ? 1.8 : 1), ti);
      bp2.frequency.setValueAtTime(rnd(2600, 3900) * r * (clack ? 1.4 : 1), ti);
      exc.gain.setValueAtTime(0, ti);
      exc.gain.linearRampToValueAtTime(ai, ti + 0.0005);
      exc.gain.exponentialRampToValueAtTime(0.0001, ti + len);
      exc.gain.setValueAtTime(0, ti + len + 0.0005);
      prev = ti + len + 0.0005;
    }
  }
  thump(v, t, 150 * r, 95 * r, 0.32, 0.09);
};

/** Soft papery tick for each card landing in a hand. */
const cardLand: Recipe = (v, t, r) => {
  const p = r * rnd(0.9, 1.12);
  const g = v.gain(0);
  const g2 = v.gain(0);
  const src = v.noise(t, t + 0.06, v.filter('bandpass', 3400 * p, 1.3, g));
  src.connect(v.filter('lowpass', 750 * p, 0.7, g2));
  perc(g.gain, t, 0.9, 0.0015, 0.022);
  perc(g2.gain, t + 0.002, 1.1, 0.002, 0.035);
};

/** Card slide/flip: rising papery swish ending in a light snap. */
const card: Recipe = (v, t, r) => {
  sweep(v, t, 0.2, [900 * r, 2600 * r, 4200 * r], 0.9, 1.1);
  burst(v, t + 0.19, 'bandpass', 3800 * r, 1.4, 0.7, 0.025);
  burst(v, t + 0.19, 'lowpass', 700 * r, 0.7, 0.8, 0.03);
};

/** Development card played: flip swish then a soft magical three-note reveal. */
const devPlay: Recipe = (v, t, r) => {
  sweep(v, t, 0.16, [1000 * r, 3000 * r, 4500 * r], 0.9, 0.9);
  burst(v, t + 0.15, 'bandpass', 3600 * r, 1.4, 0.6, 0.025);
  sweep(v, t + 0.1, 0.6, [3000 * r, 7000 * r, 9000 * r], 1.5, 0.25);
  [81, 85, 88, 93].forEach((m, i) => bell(v, t + 0.17 + i * 0.07, mtof(m) * r, 0.11 - i * 0.015, 1.3, v.out, SOFT_BELL));
};

/** Wooden piece set down: body thunk, two-contact knock, tiny sparkle. */
const build: Recipe = (v, t, r) => {
  thump(v, t, 160 * r, 88 * r, 0.75, 0.13);
  burst(v, t, 'lowpass', 520 * r, 0.8, 0.9, 0.05);
  knock(v, t, 1.0, [640 * r, 1190 * r, 2050 * r], 16, v.gain(2.6));
  knock(v, t + rnd(0.04, 0.055), 0.45, [700 * r, 1300 * r, 2240 * r], 16, v.gain(2.6));
  const sp = v.gain(1);
  [86, 90, 93].forEach((m, i) => bell(v, t + 0.08 + i * 0.045, mtof(m + (Math.random() < 0.3 ? 2 : 0)) * r, 0.055, 0.55, sp));
};

/** Road: lighter, higher wooden clack. */
const road: Recipe = (v, t, r) => {
  thump(v, t, 230 * r, 160 * r, 0.32, 0.06);
  knock(v, t, 1.0, [920 * r, 1700 * r, 2950 * r], 14, v.gain(2.4));
  knock(v, t + rnd(0.025, 0.035), 0.4, [980 * r, 1780 * r, 3100 * r], 14, v.gain(2.4));
};

/** City: heavy stone thunk with grit, then a rising D-major chime. */
const city: Recipe = (v, t, r) => {
  thump(v, t, 115 * r, 52 * r, 0.9, 0.28);
  burst(v, t, 'lowpass', 380 * r, 0.8, 1.2, 0.2, v.out, v.e.brown);
  burst(v, t, 'bandpass', 1900 * r, 1, 0.35, 0.07);
  knock(v, t, 0.9, [390 * r, 780 * r, 1480 * r], 9, v.gain(2.4));
  crackles(v, t + 0.03, 0.18, 7, 0.25, v.filter('bandpass', 2600 * r, 1.2));
  [74, 78, 81, 86].forEach((m, i) => bell(v, t + 0.14 + i * 0.075, mtof(m) * r, 0.16 - i * 0.015, 1.4));
  bell(v, t + 0.5, mtof(93) * r, 0.04, 1.6, v.out, SOFT_BELL);
};

/** Robber: dark resonant whoosh with a beating low drone, panning across. */
const robber: Recipe = (v, t, r) => {
  const g = v.gain(0);
  const lp = v.filter('lowpass', 180, 4.5, g);
  v.noise(t, t + 1.5, lp, v.e.pink);
  glide(lp.frequency, t, [[0, 160 * r], [0.5, 1050 * r], [1.4, 190 * r]]);
  ramp(g.gain, t, [[0, 0], [0.5, 0.9], [1.4, 0]]);
  const dg = v.gain(0);
  const dlp = v.filter('lowpass', 420, 0.7, dg);
  for (const [f, type] of [[49, 'sine'], [52, 'sine'], [98, 'triangle'], [104, 'triangle']] as const) {
    const o = v.osc(type, f * r, t, t + 1.55, dlp);
    glide(o.frequency, t, [[0, f * r], [1.5, f * 0.9 * r]]);
  }
  ramp(dg.gain, t, [[0, 0], [0.35, 0.4], [1.0, 0.3], [1.5, 0]]);
  ramp(v.panner.pan, t, [[0, -0.5], [1.4, 0.5]]);
};

/** Robber's sly "heh-heh-heh" on a reedy low voice, ending on a tritone-shadowed growl. */
const robberLaugh: Recipe = (v, t, r) => {
  const reed = (tn: number, f: number, dur: number, amp: number, dest: AudioNode = v.out) => {
    const g = v.gain(0, dest);
    const fmt = v.filter('bandpass', 480 * r, 1.6, g);
    const lp = v.filter('lowpass', 1500 * r, 0.7, g);
    for (const det of [-8, 8]) {
      const o = v.osc('sawtooth', f, tn, tn + dur + 0.2, fmt);
      o.connect(lp);
      o.detune.value = det;
      glide(o.frequency, tn, [[0, f * 1.04], [0.04, f], [dur, f * 0.94]]);
    }
    ramp(g.gain, tn, [[0, 0], [0.025, amp], [dur * 0.6, amp * 0.6], [dur + 0.12, 0]]);
  };
  [123.5, 116.5, 110].forEach((f, i) => reed(t + i * 0.17, f * r, 0.11, 0.55 - i * 0.05));
  const tl = t + 0.55;
  const trem = v.gain(1);
  v.osc('sine', 5.5, tl, tl + 0.85, v.gain(0.3, trem.gain));
  reed(tl, 82.4 * r, 0.6, 0.6, trem);
  reed(tl + 0.02, 116.5 * r, 0.55, 0.22, trem);
  thump(v, tl, 72 * r, 44 * r, 0.55, 0.6);
  burst(v, tl, 'lowpass', 160, 0.7, 0.7, 0.7, v.out, v.e.brown);
};

/** Steal: quick high swish sweeping across plus two sly staccato plucks. */
const steal: Recipe = (v, t, r) => {
  sweep(v, t, 0.17, [2000 * r, 6200 * r, 3000 * r], 1.6, 1.4);
  ramp(v.panner.pan, t, [[0, -0.6], [0.2, 0.6]]);
  for (const [dt, m] of [[0.02, 62], [0.12, 57]] as const) {
    const g = v.gain(0);
    v.osc('triangle', mtof(m) * r, t + dt, t + dt + 0.12, v.filter('lowpass', 1400, 0.7, g));
    perc(g.gain, t + dt, 0.35, 0.003, 0.08);
  }
};

/** Coins: several metallic clinks with inharmonic partials, scattered in time and stereo. */
const trade: Recipe = (v, t, r) => {
  const n = 4 + Math.floor(Math.random() * 3);
  let tc = t;
  for (let i = 0; i < n; i++) {
    const p = v.pan(rnd(-0.45, 0.45));
    const f = rnd(2300, 3500) * r;
    const amp = (i === 0 ? 0.12 : rnd(0.05, 0.1)) * (1 - i * 0.08);
    bell(v, tc, f, amp, rnd(0.18, 0.32), p, COIN);
    burst(v, tc, 'highpass', 6000, 0.7, amp * 2.2, 0.006, p);
    tc += rnd(0.04, 0.11);
  }
};

/** Offer: one soft hotel-bell ding with a gentle sub-hum. */
const offer: Recipe = (v, t, r) => {
  bell(v, t, 880 * r, 0.22, 1.6, v.out, SOFT_BELL);
  bell(v, t + 0.004, 1318.5 * r, 0.04, 0.9, v.out, SOFT_BELL);
};

/** Award: pickup note into a blooming brass D-major chord with a cymbal swell and sparkle. */
const award: Recipe = (v, t, r) => {
  brass(v, t, 440 * r, 0.09, 0.13, 1800);
  const tc = t + 0.13;
  for (const m of [62, 66, 69, 74]) brass(v, tc, mtof(m) * r, 0.75, 0.1, 2400);
  const cym = v.gain(0);
  v.noise(tc, tc + 1.3, v.filter('highpass', 6500, 0.7, cym));
  ramp(cym.gain, tc, [[0, 0], [0.08, 0.08], [1.25, 0]]);
  bell(v, tc + 0.05, mtof(86) * r, 0.06, 1.2, v.out, SOFT_BELL);
  bell(v, tc + 0.12, mtof(90) * r, 0.05, 1.2, v.out, SOFT_BELL);
};

/** Victory: "ta-ta-ta-taaa" brass call through I-IV-V-I with timpani, cymbal and a bell cascade. */
const victory: Recipe = (v, t, r) => {
  const tim = (tt: number, amp: number) => {
    thump(v, tt, 82 * r, 70 * r, amp, 0.55);
    burst(v, tt, 'lowpass', 300, 0.8, amp * 0.8, 0.25, v.out, v.e.brown);
  };
  for (let i = 0; i < 3; i++) brass(v, t + i * 0.15, 440 * r, 0.08, 0.13, 1900);
  const chord = (tt: number, ms: readonly number[], dur: number, amp: number, bright: number) => {
    for (const m of ms) brass(v, tt, mtof(m) * r, dur, amp, bright);
  };
  chord(t + 0.45, [62, 66, 69, 74], 0.45, 0.085, 2300);
  tim(t + 0.45, 0.6);
  chord(t + 1.0, [55, 59, 62, 71], 0.25, 0.08, 2100);
  chord(t + 1.3, [57, 64, 69, 73], 0.3, 0.08, 2300);
  tim(t + 1.3, 0.35);
  const tf = t + 1.7;
  for (let i = 0; i < 6; i++) tim(tf - 0.3 + i * 0.05, 0.12 + i * 0.03);
  tim(tf, 0.7);
  chord(tf, [50, 62, 66, 69, 74, 78], 1.0, 0.075, 2800);
  const cym = v.gain(0);
  v.noise(tf, tf + 1.6, v.filter('highpass', 6000, 0.7, cym));
  ramp(cym.gain, tf, [[0, 0], [0.06, 0.12], [1.5, 0]]);
  [86, 90, 93, 98, 102].forEach((m, i) => bell(v, tf + 0.1 + i * 0.07, mtof(m) * r, 0.06, 1.3, v.out, SOFT_BELL));
};

/** Your turn: gentle rising fourth on soft bells. */
const yourTurn: Recipe = (v, t, r) => {
  bell(v, t, mtof(81) * r, 0.2, 1.2, v.out, SOFT_BELL);
  bell(v, t + 0.16, mtof(86) * r, 0.22, 1.5, v.out, SOFT_BELL);
};

/** Error: muffled two-note descending "uh-uh" with a soft thud. */
const error: Recipe = (v, t, r) => {
  const lp = v.filter('lowpass', 700 * r, 0.8);
  for (const [dt, f] of [[0, 233], [0.13, 185]] as const) {
    const g = v.gain(0, lp);
    v.osc('triangle', f * r, t + dt, t + dt + 0.2, g);
    v.osc('sine', f * r * 0.5, t + dt, t + dt + 0.2, g);
    ramp(g.gain, t + dt, [[0, 0], [0.01, 0.5], [0.07, 0.35], [0.14, 0]]);
  }
  thump(v, t, 120 * r, 75 * r, 0.35, 0.08);
};

/** UI click: tiny bright wooden tick. */
const click: Recipe = (v, t, r) => {
  knock(v, t, 1, [2400 * r, 4100 * r], 7, v.gain(3.5), 0.004);
  const g = v.gain(0);
  v.osc('sine', 1700 * r, t, t + 0.04, g);
  perc(g.gain, t, 0.12, 0.001, 0.018);
};

/** UI hover: a barely-there high blip. */
const hover: Recipe = (v, t, r) => {
  const g = v.gain(0);
  v.osc('sine', 2500 * r * rnd(0.98, 1.02), t, t + 0.05, g);
  perc(g.gain, t, 0.2, 0.002, 0.022);
};

/** Generic production: ascending pentatonic glints over a soft airy swell. */
const produce: Recipe = (v, t, r) => {
  const start = Math.floor(rnd(0, 4));
  for (let i = 0; i < 5; i++) bell(v, t + i * rnd(0.045, 0.06), mtof(PENTA[start + i]) * r, 0.075 - i * 0.008, 0.9, v.out, SOFT_BELL);
  const g = v.gain(0);
  v.noise(t, t + 0.9, v.filter('highpass', 5500, 0.7, g));
  ramp(g.gain, t, [[0, 0], [0.2, 0.05], [0.85, 0]]);
};

/** Forest: stick-slip wood creak, leaf rustle, and a little bird. */
const produceForest: Recipe = (v, t, r) => {
  const cg = v.gain(0);
  const saw = v.osc('sawtooth', 30, t, t + 0.7, null);
  saw.connect(v.filter('bandpass', 720 * r, 14, cg));
  saw.connect(v.filter('bandpass', 1340 * r, 11, v.gain(0.6, cg)));
  ramp(saw.frequency, t, [[0, 26], [0.15, 38], [0.3, 33], [0.5, 46], [0.65, 40]]);
  ramp(cg.gain, t, [[0, 0], [0.08, 2.2], [0.5, 1.8], [0.68, 0]]);
  crackles(v, t + 0.15, 0.6, 22, 0.45, v.filter('bandpass', 4200, 0.8), 0.003, 0.012);
  chirp(v, t + 0.38, 3, 0.09, v.pan(rnd(-0.4, 0.4)));
};

/** Fields: warm wind gust with a golden high shimmer. */
const produceFields: Recipe = (v, t, r) => {
  const p = v.pan(0);
  sweep(v, t, 1.1, [420 * r, 1250 * r, 560 * r], 1.1, 1.2, p, v.e.pink);
  ramp(p.pan, t, [[0, -0.4], [1.1, 0.4]]);
  const glow = v.gain(0);
  for (const m of [74, 81]) v.osc('sine', mtof(m) * r, t, t + 1.3, glow);
  ramp(glow.gain, t, [[0, 0], [0.4, 0.035], [1.25, 0]]);
  for (let i = 0; i < 6; i++) bell(v, t + rnd(0.2, 0.85), mtof(pick(PENTA.slice(4))) * r, rnd(0.025, 0.045), 0.6, v.out, SOFT_BELL);
};

/** Pasture: a cute short lamb "baa" (saw through moving vowel formants with bleat vibrato). */
const producePasture: Recipe = (v, t, r) => {
  const f0 = rnd(390, 470) * r;
  const dur = rnd(0.38, 0.46);
  const trem = v.gain(1, v.filter('lowpass', 3200, 0.7));
  const g = v.gain(0, trem);
  const f1 = v.filter('bandpass', 380, 5, g);
  const f2 = v.filter('bandpass', 1150, 6, v.gain(0.6, g));
  const f3 = v.filter('bandpass', 2600, 8, v.gain(0.25, g));
  const src = v.osc('sawtooth', f0, t, t + dur + 0.1, f1);
  src.connect(f2);
  src.connect(f3);
  glide(src.frequency, t, [[0, f0 * 0.9], [0.06, f0], [dur, f0 * 0.93]]);
  glide(f1.frequency, t, [[0, 380], [0.07, 820], [dur, 760]]);
  glide(f2.frequency, t, [[0, 1000], [0.07, 1250], [dur, 1180]]);
  const lfo = v.osc('sine', rnd(7, 8.5), t, t + dur + 0.1, null);
  lfo.connect(v.gain(f0 * 0.035, src.frequency));
  lfo.connect(v.gain(0.3, trem.gain));
  ramp(g.gain, t, [[0, 0], [0.035, 1.1], [dur - 0.1, 0.9], [dur, 0]]);
};

/** Hills: kiln fire whoosh with crackles and pops. */
const produceHills: Recipe = (v, t, r) => {
  const g = v.gain(0);
  const lp = v.filter('lowpass', 300, 0.9, g);
  v.noise(t, t + 1.15, lp, v.e.brown);
  glide(lp.frequency, t, [[0, 260 * r], [0.3, 1400 * r], [1.1, 420 * r]]);
  ramp(g.gain, t, [[0, 0], [0.28, 1.0], [1.1, 0]]);
  sweep(v, t, 1.0, [600 * r, 1100 * r, 700 * r], 0.7, 0.45, v.out, v.e.pink);
  const cr = v.gain(1, null);
  cr.connect(v.filter('highpass', 2000, 0.7));
  cr.connect(v.filter('bandpass', 1100, 3, v.gain(0.9)));
  crackles(v, t + 0.08, 0.95, 26, 0.9, cr);
};

/** Mountains: pickaxe clinks on rock, pebbles, and a low rumble. */
const produceMountains: Recipe = (v, t, r) => {
  const rg = v.gain(0);
  v.noise(t, t + 1.25, v.filter('lowpass', 160, 0.8, rg), v.e.brown);
  ramp(rg.gain, t, [[0, 0], [0.2, 1.3], [1.2, 0]]);
  thump(v, t, 55 * r, 42 * r, 0.3, 0.8);
  burst(v, t, 'lowpass', 320, 0.7, 0.6, 0.6, v.out, v.e.brown);
  for (const [dt, amp] of [[0.05, 0.13], [0.36, 0.1], [0.62, 0.07]] as const) {
    const tc = t + dt;
    bell(v, tc, rnd(1900, 2250) * r, amp, 0.22, v.out, STEEL);
    burst(v, tc, 'highpass', 3500, 0.7, amp * 3, 0.01);
    burst(v, tc, 'bandpass', 1200 * r, 1, amp * 2.5, 0.05);
  }
  for (let i = 0; i < 5; i++) knock(v, t + rnd(0.15, 0.95), rnd(0.15, 0.3), [rnd(2200, 3800) * r], 9, v.gain(2.2, v.pan(rnd(-0.5, 0.5))));
};

/** Splash: fish breaking the surface, spray, then a few bubbly droplets. */
const splash: Recipe = (v, t, r) => {
  const g = v.gain(0);
  const bp = v.filter('bandpass', 2400, 0.9, g);
  v.noise(t, t + 0.3, bp);
  glide(bp.frequency, t, [[0, 2600 * r], [0.2, 650 * r]]);
  perc(g.gain, t, 0.9, 0.006, 0.2);
  burst(v, t, 'highpass', 3600, 0.7, 0.18, 0.08);
  const n = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++) {
    const td = t + rnd(0.05, 0.38);
    const f = rnd(700, 1600) * r;
    const dg = v.gain(0, v.pan(rnd(-0.4, 0.4)));
    const o = v.osc('sine', f, td, td + 0.06, dg);
    glide(o.frequency, td, [[0, f], [0.035, f * rnd(1.8, 2.4)]]);
    perc(dg.gain, td, rnd(0.04, 0.12), 0.002, 0.035);
  }
};

/**
 * Thunder. A near strike first tears the air: a few overlapping bright bursts in a tenth of a
 * second and a deep thump. Then the roll, which comes from the whole length of the channel at
 * once, near parts first: low noise that swells in uneven bursts and dies away over seconds,
 * longer and darker the further off it is. `r` runs from about 0.75 (far: no crack, low,
 * slow) to 1.2 (overhead).
 */
const thunder: Recipe = (v, t, r) => {
  const near = Math.max(0, Math.min(1, (r - 0.75) / 0.45));
  const pan = v.pan(rnd(-0.5, 0.5));
  if (near > 0.4) {
    let tc = t;
    for (let i = 0; i < 4; i++) {
      burst(v, tc, 'highpass', rnd(900, 2000), 0.6, 0.5 * near * rnd(0.6, 1), rnd(0.05, 0.16), pan);
      tc += rnd(0.012, 0.045);
    }
    burst(v, t, 'lowpass', 2400, 0.7, 0.75 * near, 0.4, pan);
    thump(v, t + 0.02, 85, 34, 0.9 * near, 1.4, pan);
  }
  const dur = 3.4 + (1 - near) * 2.6 + rnd(0, 1.4);
  const onset = near > 0.4 ? 0.06 : rnd(0.2, 0.5);
  // The roll's body (brown noise) and its rumble underneath (pink, lower still).
  const g = v.gain(0, pan);
  v.noise(t, t + dur + 0.3, v.filter('lowpass', (160 + 420 * near) * r, 0.8, g), v.e.brown);
  const low = v.gain(0, pan);
  v.noise(t, t + dur + 0.3, v.filter('lowpass', 70 + 60 * near, 1.2, low), v.e.pink);
  const pts: [number, number][] = [
    [0, 0],
    [onset, 0.95],
  ];
  let tt = onset, a = 0.95;
  while (tt < dur - 0.7) {
    tt += rnd(0.22, 0.65);
    a *= rnd(0.62, 0.95);
    pts.push([tt - 0.12, a * rnd(0.35, 0.6)], [tt, a]);
  }
  pts.push([dur, 0]);
  ramp(g.gain, t, pts);
  ramp(low.gain, t, [
    [0, 0],
    [onset + 0.1, 0.8],
    [dur * 0.6, 0.45],
    [dur + 0.2, 0],
  ]);
};

/** Whoosh: airy swish moving across the stereo field. */
const whoosh: Recipe = (v, t, r) => {
  sweep(v, t, 0.38, [380 * r, 2300 * r, 700 * r], 1.1, 1.1);
  sweep(v, t + 0.02, 0.34, [1200 * r, 5200 * r, 2000 * r], 2, 0.35);
  ramp(v.panner.pan, t, [[0, -0.4], [0.38, 0.4]]);
};

// ------------------------------------------------------------------ the expansions' voices

/** A bar of struck metal (an anvil, a blade): bar-mode partials, the high ones dying first. */
const ANVIL: readonly Partial3[] = [
  [1, 1, 1],
  [2.76, 0.5, 0.45],
  [5.4, 0.28, 0.22],
  [8.93, 0.12, 0.12],
];
/** A hung tube (a wind chime): its strike tone and two bright inharmonic overtones. */
const TUBE: readonly Partial3[] = [
  [1, 1, 1],
  [2.76, 0.32, 0.4],
  [5.4, 0.1, 0.2],
];

/** One drum stroke: the skin's pitched body falling, its slap, and the shell's air. */
function drum(v: Voice, t: number, f: number, amp: number, decay = 0.4, dest: AudioNode = v.out) {
  thump(v, t, f * 1.6, f, amp, decay, dest);
  knock(v, t, amp * 0.7, [f * 2.3, f * 3.9], 5, v.gain(1.4, dest), 0.006);
  burst(v, t, 'lowpass', f * 4, 0.7, amp * 0.6, decay * 0.5, dest, v.e.brown);
}

/** Stick-slip friction (a rope on a cleat, an axle, a hull's timbers): a slow buzz through narrow wooden resonances. */
function creakAt(v: Voice, t: number, dur: number, rates: readonly number[], freqs: readonly number[], amp: number, dest: AudioNode = v.out) {
  const g = v.gain(0, dest);
  const saw = v.osc('sawtooth', rates[0], t, t + dur + 0.05, null);
  freqs.forEach((f, i) => saw.connect(v.filter('bandpass', f, 12 - i * 3, v.gain(1 / (1 + i * 0.6), g))));
  ramp(saw.frequency, t, rates.map((r, i) => [(dur * i) / Math.max(1, rates.length - 1), r] as const));
  ramp(g.gain, t, [[0, 0], [dur * 0.15, amp], [dur * 0.7, amp * 0.8], [dur, 0]]);
}

/** Water drawing up and falling back on a shore: a lowpassed swell that opens as it rises. */
function lap(v: Voice, t: number, dur: number, amp: number, top = 1100, dest: AudioNode = v.out) {
  const g = v.gain(0, dest);
  const lp = v.filter('lowpass', 300, 0.7, g);
  v.noise(t, t + dur + 0.05, lp, v.e.pink);
  glide(lp.frequency, t, [[0, 260], [dur * 0.4, top], [dur, 340]]);
  ramp(g.gain, t, [[0, 0], [dur * 0.35, amp], [dur, 0]]);
}

/**
 * The raider fleet's war horn, far off over the water: a short blast, then a long one a fourth
 * above that sags as the breath runs out. Dark (a horn of bone and brass, not a trumpet), with
 * breath at its onset and a slow vibrato. `r` lifts it as the fleet closes in.
 */
const horn: Recipe = (v, t, r) => {
  const blast = (t0: number, f: number, dur: number, amp: number) => {
    const g = v.gain(0);
    const lp = v.filter('lowpass', f * 2, 0.9, g);
    const vib = v.osc('sine', 4.6, t0, t0 + dur + 0.35, null);
    const depth = v.gain(0, null);
    vib.connect(depth);
    ramp(depth.gain, t0, [[0, 0], [dur * 0.5, 0], [dur, f * 0.012]]);
    for (const [type, det, a] of [['sawtooth', -6, 0.55], ['sawtooth', 7, 0.45], ['triangle', 0, 1]] as const) {
      const o = v.osc(type, f, t0, t0 + dur + 0.35, v.gain(a, lp));
      o.detune.value = det;
      depth.connect(o.frequency);
      glide(o.frequency, t0, [[0, f * 0.93], [0.13, f], [dur * 0.85, f * 0.995], [dur + 0.3, f * 0.92]]);
    }
    glide(lp.frequency, t0, [[0, f * 1.4], [0.2, f * 4.2], [dur * 0.8, f * 3.4], [dur + 0.3, f * 1.3]]);
    ramp(g.gain, t0, [[0, 0], [0.16, amp], [dur * 0.75, amp * 0.85], [dur + 0.3, 0]]);
    const bg = v.gain(0);
    v.noise(t0, t0 + dur + 0.3, v.filter('bandpass', f * 7, 1.4, bg), v.e.pink);
    ramp(bg.gain, t0, [[0, 0], [0.05, amp * 0.9], [0.25, amp * 0.25], [dur + 0.25, 0]]);
  };
  blast(t, 110 * r, 0.3, 0.16);
  blast(t + 0.46, 146.83 * r, 1.0, 0.19);
};

/**
 * A foghorn far off in the bank over the face-down hexes: one long low diaphone note that drops a
 * step at its end (the "bee-oh" of a lightship), dark and breathy, with the mist's reverb on it.
 * Far quieter and lower than the raiders' horn, and with no vibrato: it's weather, not a threat.
 */
const foghorn: Recipe = (v, t, r) => {
  const f = 73.4 * r;
  const g = v.gain(0);
  const lp = v.filter('lowpass', f * 3, 0.7, g);
  for (const [type, det, a] of [['sawtooth', -4, 0.4], ['square', 5, 0.25], ['triangle', 0, 1]] as const) {
    const o = v.osc(type, f, t, t + 2.9, v.gain(a, lp));
    o.detune.value = det;
    glide(o.frequency, t, [[0, f * 0.97], [0.25, f], [1.7, f], [1.95, f * 0.84], [2.8, f * 0.82]]);
  }
  glide(lp.frequency, t, [[0, f * 1.5], [0.35, f * 4], [1.7, f * 3.6], [2.0, f * 2.4], [2.8, f * 1.4]]);
  ramp(g.gain, t, [[0, 0], [0.3, 0.2], [1.7, 0.18], [1.95, 0.15], [2.8, 0]]);
  // (Air through the reed at the onset.)
  const bg = v.gain(0);
  v.noise(t, t + 1, v.filter('bandpass', f * 6, 1.2, bg), v.e.pink);
  ramp(bg.gain, t, [[0, 0], [0.08, 0.12], [0.5, 0.03], [1, 0]]);
};

/** The raiders come ashore: war drums, a beat, a beat, then a gathering roll into one great stroke. */
const warDrum: Recipe = (v, t, r) => {
  const hits: [number, number][] = [[0, 0.55], [0.36, 0.5], [0.62, 0.32], [0.74, 0.38], [0.86, 0.44], [0.97, 0.5]];
  for (const [dt, a] of hits) drum(v, t + dt, rnd(58, 64) * r, a, 0.32, v.pan(rnd(-0.25, 0.25)));
  drum(v, t + 1.12, 52 * r, 0.95, 0.75);
  // (A low growl of the crowd behind the drums.)
  const g = v.gain(0);
  v.noise(t + 0.5, t + 2, v.filter('bandpass', 260 * r, 1.6, g), v.e.brown);
  ramp(g.gain, t + 0.5, [[0, 0], [0.62, 0.5], [1.4, 0]]);
};

/**
 * A bright call on a herald's trumpet: three quick notes climbing the D chord to a held high A,
 * with a third under it, a snare's brush and a glint. Higher and more melodic than the award's
 * chord (which blooms) and far shorter than the victory fanfare.
 */
const fanfare: Recipe = (v, t, r) => {
  // Tongued: each note speaks at once and is stopped short, so the climb is heard note by note
  // (the shared brass voice blooms and lingers, which is the award's character).
  const trumpet = (tn: number, m: number, dur: number, amp: number, rel: number) => {
    const f = mtof(m) * r;
    const g = v.gain(0);
    const lp = v.filter('lowpass', f * 2, 1, g);
    for (const det of [-5, 5]) {
      const o = v.osc('sawtooth', f, tn, tn + dur + rel + 0.05, lp);
      o.detune.value = det;
      glide(o.frequency, tn, [[0, f * 0.98], [0.03, f]]);
    }
    // (A square under the saws gives the trumpet its bite.)
    v.osc('square', f, tn, tn + dur + rel + 0.05, v.gain(0.3, lp));
    glide(lp.frequency, tn, [[0, f * 1.5], [0.04, Math.max(3600, f * 3)], [Math.max(0.05, dur), Math.max(2600, f * 2.4)], [dur + rel, f * 1.2]]);
    ramp(g.gain, tn, [[0, 0], [0.018, amp], [dur, amp * 0.8], [dur + rel, 0]]);
  };
  [74, 78, 81].forEach((m, i) => trumpet(t + i * 0.12, m, 0.06, 0.1, 0.05));
  const th = t + 0.36;
  trumpet(th, 86, 0.55, 0.11, 0.35);
  trumpet(th + 0.01, 81, 0.53, 0.055, 0.35);
  const sn = v.gain(0);
  v.noise(th - 0.08, th + 0.5, v.filter('bandpass', 4200, 0.8, sn));
  ramp(sn.gain, th - 0.08, [[0, 0], [0.08, 0.07], [0.5, 0]]);
  bell(v, th + 0.18, mtof(98) * r, 0.04, 1.1, v.out, SOFT_BELL);
};

/** A hull slides off the slipway: a deep wooden thud, the sea taking it, spray and a few bubbles. */
const launch: Recipe = (v, t, r) => {
  thump(v, t, 95 * r, 48 * r, 0.7, 0.28);
  knock(v, t, 0.8, [260 * r, 520 * r, 830 * r], 7, v.gain(2.0), 0.01);
  lap(v, t + 0.08, 0.85, 0.75, 1300 * r);
  sweep(v, t + 0.1, 0.45, [3200 * r, 2000 * r, 900 * r], 0.9, 0.3);
  for (let i = 0; i < 4; i++) {
    const td = t + rnd(0.3, 0.75);
    const f = rnd(500, 1100) * r;
    const g = v.gain(0, v.pan(rnd(-0.35, 0.35)));
    const o = v.osc('sine', f, td, td + 0.06, g);
    glide(o.frequency, td, [[0, f], [0.04, f * 2]]);
    perc(g.gain, td, rnd(0.03, 0.07), 0.002, 0.04);
  }
};

/** Under sail: rope working on a cleat and the timbers answering, over a slap of water at the bow. */
const creak: Recipe = (v, t, r) => {
  creakAt(v, t, 0.42, [9, 16, 12, 21], [540 * r, 980 * r], 1.6);
  creakAt(v, t + 0.38, 0.34, [14, 22, 17], [430 * r, 760 * r, 1500 * r], 1.1);
  lap(v, t + 0.05, 0.75, 0.35, 900);
};

/** An Invasion battle: two drum strokes, blades meeting twice, and a last low stroke. */
const battle: Recipe = (v, t, r) => {
  drum(v, t, 70 * r, 0.6, 0.3);
  drum(v, t + 0.17, 66 * r, 0.5, 0.3);
  for (const [dt, f, a] of [[0.34, rnd(2300, 2600), 0.09], [0.52, rnd(2800, 3200), 0.07]] as const) {
    const p = v.pan(rnd(-0.3, 0.3));
    bell(v, t + dt, f * r, a, 0.32, p, ANVIL);
    burst(v, t + dt, 'highpass', 4500, 0.7, a * 4, 0.03, p);
    burst(v, t + dt, 'bandpass', 1800 * r, 1.2, a * 2.5, 0.06, p);
  }
  drum(v, t + 0.72, 56 * r, 0.7, 0.5);
};

/** Pollution: a sour hiss and sizzle, crackling, over a low tritone that hangs in the air. */
const hiss: Recipe = (v, t, r) => {
  const g = v.gain(0);
  // (Kept under 7 kHz: a hiss any brighter is a hurt ear, not a sizzle.)
  const hp = v.filter('highpass', 2600 * r, 0.6, v.filter('lowpass', 7000, 0.7, g));
  v.noise(t, t + 1.5, hp);
  glide(hp.frequency, t, [[0, 1800 * r], [0.3, 3400 * r], [1.4, 2400 * r]]);
  ramp(g.gain, t, [[0, 0], [0.12, 0.32], [0.6, 0.22], [1.4, 0]]);
  crackles(v, t + 0.05, 1.1, 34, 0.5, v.filter('bandpass', 3200 * r, 1.1));
  const dg = v.gain(0, v.filter('lowpass', 500, 0.7));
  for (const f of [73.4, 103.8]) v.osc('triangle', f * r, t, t + 1.7, dg);
  ramp(dg.gain, t, [[0, 0], [0.4, 0.07], [1.0, 0.05], [1.65, 0]]);
};

/** A flood: the sea draws back and comes in, rising and opening as it climbs, breaks, and drains away hissing. */
const surge: Recipe = (v, t, r) => {
  const g = v.gain(0);
  const lp = v.filter('lowpass', 180, 0.8, g);
  v.noise(t, t + 2.3, lp, v.e.brown);
  glide(lp.frequency, t, [[0, 140 * r], [1.1, 1500 * r], [1.4, 900 * r], [2.2, 260 * r]]);
  ramp(g.gain, t, [[0, 0], [1.05, 1.1], [1.3, 0.9], [2.2, 0]]);
  sweep(v, t + 0.3, 1.0, [500 * r, 1600 * r, 2400 * r], 0.8, 0.32, v.out, v.e.pink);
  // The wave breaks...
  burst(v, t + 1.12, 'lowpass', 2400 * r, 0.6, 0.55, 0.45, v.out, v.e.pink);
  thump(v, t + 1.12, 70 * r, 38 * r, 0.45, 0.5);
  // ...and drains off the land.
  sweep(v, t + 1.3, 0.9, [4200 * r, 3000 * r, 1800 * r], 0.7, 0.22);
};

/** A foundry fired up: a hammer on the anvil twice, the second a lighter bounce, over the iron's ring. */
const anvil: Recipe = (v, t, r) => {
  for (const [dt, a] of [[0, 0.14], [0.27, 0.07]] as const) {
    const f = rnd(1080, 1160) * r;
    bell(v, t + dt, f, a, 0.9, v.out, ANVIL);
    burst(v, t + dt, 'highpass', 5000, 0.7, a * 3.5, 0.008);
    thump(v, t + dt, 210 * r, 150 * r, a * 2.4, 0.07);
  }
  bell(v, t, 2.1 * 1120 * r, 0.02, 1.4, v.out, SOFT_BELL);
};

/** A wagon train: wheels on a rough track (rumble, the spokes knocking, an axle's creak) and an ox's low. */
const wagon: Recipe = (v, t, r) => {
  const rg = v.gain(0);
  v.noise(t, t + 1.1, v.filter('lowpass', 220, 0.8, rg), v.e.brown);
  ramp(rg.gain, t, [[0, 0], [0.15, 0.8], [0.85, 0.6], [1.1, 0]]);
  let tk = t + 0.03;
  for (let i = 0; i < 8; i++) {
    knock(v, tk, rnd(0.35, 0.6), [rnd(380, 460) * r, rnd(820, 980) * r], 8, v.gain(1.8, v.pan(rnd(-0.2, 0.2))), 0.006);
    tk += rnd(0.1, 0.14);
  }
  creakAt(v, t + 0.25, 0.3, [18, 26, 20], [650 * r, 1150 * r], 0.9);
  // The ox: a low hum through slowly opening vowel formants, falling at the end.
  const to = t + 0.55;
  const f0 = rnd(92, 100) * r;
  const og = v.gain(0, v.filter('lowpass', 1600, 0.7));
  const src = v.osc('sawtooth', f0, to, to + 0.95, null);
  src.connect(v.filter('bandpass', 320, 4, og));
  src.connect(v.filter('bandpass', 720, 5, v.gain(0.5, og)));
  glide(src.frequency, to, [[0, f0 * 0.92], [0.12, f0], [0.6, f0 * 1.02], [0.9, f0 * 0.82]]);
  ramp(og.gain, to, [[0, 0], [0.15, 0.55], [0.6, 0.5], [0.9, 0]]);
};

/** A dressed stone set in place (a bridge's keystone, a wall's course): a heavy dull thunk, grit, a ring of the stone. */
const stone: Recipe = (v, t, r) => {
  thump(v, t, 105 * r, 46 * r, 0.85, 0.22);
  burst(v, t, 'lowpass', 420 * r, 0.8, 1.0, 0.14, v.out, v.e.brown);
  knock(v, t, 0.9, [520 * r, 1130 * r, 2050 * r], 8, v.gain(2.2), 0.008);
  knock(v, t + rnd(0.05, 0.07), 0.3, [560 * r, 1210 * r], 8, v.gain(2), 0.006);
  crackles(v, t + 0.02, 0.2, 9, 0.22, v.filter('bandpass', 2800 * r, 1.2));
};

/** Stone giving way (a city sacked, a road cracked by a quake): a heavy fall, then rubble skittering down. */
const crumble: Recipe = (v, t, r) => {
  thump(v, t, 90 * r, 36 * r, 0.8, 0.45);
  burst(v, t, 'lowpass', 380 * r, 0.7, 1.1, 0.4, v.out, v.e.brown);
  for (let i = 0; i < 9; i++) {
    const tk = t + 0.05 + Math.pow(Math.random(), 0.7) * 0.75;
    knock(v, tk, rnd(0.2, 0.5) * (1 - (tk - t) * 0.7), [rnd(700, 1500) * r, rnd(1800, 3000) * r], 8, v.gain(1.8, v.pan(rnd(-0.5, 0.5))), 0.004);
  }
  burst(v, t + 0.1, 'bandpass', 1300 * r, 0.8, 0.3, 0.6, v.out, v.e.pink);
};

/** A fish drawn: the reel's ratchet winding in, then a plop as it comes out of the water. */
const reel: Recipe = (v, t, r) => {
  let tk = t;
  for (let i = 0; i < 11; i++) {
    knock(v, tk, 0.55 - i * 0.025, [3600 * r, 5200 * r], 14, v.gain(1.6), 0.002);
    tk += 0.026 + i * 0.002;
  }
  // The plop: a drop's ringing cavity, rising, over a small splash.
  const tp = tk + 0.06;
  const g = v.gain(0);
  const o = v.osc('sine', 380 * r, tp, tp + 0.12, g);
  glide(o.frequency, tp, [[0, 380 * r], [0.05, 1250 * r]]);
  perc(g.gain, tp, 0.32, 0.003, 0.06);
  burst(v, tp, 'bandpass', 1500 * r, 0.9, 0.35, 0.12);
  sweep(v, tp + 0.02, 0.22, [2400 * r, 1300 * r, 700 * r], 1, 0.18);
};

/** Fog lifting: a breath of air through hung chimes, a few soft high notes of the D pentatonic. */
const chime: Recipe = (v, t, r) => {
  const g = v.gain(0);
  const bp = v.filter('bandpass', 3000, 0.8, g);
  v.noise(t, t + 1.6, bp, v.e.pink);
  glide(bp.frequency, t, [[0, 1800], [0.7, 5200], [1.5, 3000]]);
  ramp(g.gain, t, [[0, 0], [0.5, 0.06], [1.5, 0]]);
  const notes = [86, 88, 90, 93, 95, 98];
  let tn = t + 0.12;
  for (let i = 0; i < 6; i++) {
    bell(v, tn, mtof(pick(notes)) * r * rnd(0.997, 1.003), rnd(0.06, 0.09) * (1 - i * 0.08), rnd(1.3, 1.8), v.pan(rnd(-0.5, 0.5)), TUBE);
    tn += rnd(0.1, 0.24);
  }
};

export const RECIPES = {
  dice,
  cardLand,
  card,
  devPlay,
  build,
  road,
  city,
  robber,
  robberLaugh,
  steal,
  trade,
  offer,
  award,
  victory,
  yourTurn,
  error,
  click,
  hover,
  produce,
  produceForest,
  produceFields,
  producePasture,
  produceHills,
  produceMountains,
  splash,
  whoosh,
  thunder,
  horn,
  warDrum,
  fanfare,
  launch,
  creak,
  battle,
  hiss,
  surge,
  anvil,
  wagon,
  stone,
  crumble,
  reel,
  chime,
  foghorn,
} satisfies Record<string, Recipe>;
