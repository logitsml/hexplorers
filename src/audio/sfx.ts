/*
 * Procedural audio for the island: pure Web Audio synthesis, no files, no packages.
 *
 * Graph: voices -> per-bus dry gain -> master -> compressor -> out, plus a per-bus wet gain into one
 * shared convolver whose impulse response is generated noise (12 ms pre-delay, early taps, tail that
 * darkens as it decays). Bus gains follow setVolume() with a squared (perceptual) curve. Noise buffers
 * (white / pink / brown, seam-crossfaded for looping) are generated once.
 *
 * Every play() builds a fresh Voice that tracks its nodes and disconnects them all when its last source
 * ends. Per-sound caps steal the oldest voice; a global cap bounds the total; a minimum gap per sound
 * either drops or slightly delays rapid repeats (cardLand ripples instead of stacking).
 *
 * Sounds (r = rate, a pitch multiplier):
 *  dice          two dice, each a noise excitation train (impact, two bounces, ~10 tumbling face hits,
 *                four rocking settles) through re-tuned resonant band-passes + low table body, panned apart
 *  cardLand      ~25 ms band-passed noise tick plus a lowpassed tap, random pitch -10/+12 %
 *  card          band-passed noise swish rising 0.9->4.2 kHz, ending in a papery snap
 *  devPlay       card swish, then an airy rise and a soft four-note bell reveal (A5 C#6 E6 A6)
 *  build         sine body thunk (160->88 Hz) + lowpassed impact + modal wooden knock with a second
 *                settling contact, then three tiny high bell glints
 *  road          lighter, higher modal clack with a short second contact and small body
 *  city          heavy stone thunk (115->52 Hz, brown-noise mass, grit crackle) then a rising D-major
 *                bell arpeggio with a faint high halo
 *  robber        pink noise through a resonant lowpass sweeping 160->1050->190 Hz over a beating
 *                49/52 Hz drone (plus octave triangles), panning left to right, long reverb
 *  robberLaugh   three staccato descending reedy "heh" notes (detuned saws, 480 Hz formant), then a held
 *                low E with a tritone shadow, tremolo, timpani-like thump and rumble
 *  steal         fast high noise swish panning across + two sly staccato triangle plucks
 *  trade         4-6 coin clinks (inharmonic sine partials 1 / 1.71 / 2.53 / 3.32 + a 6 kHz tick)
 *                scattered in time and stereo
 *  offer         soft hotel-bell ding at A5 with a sub-octave hum and a faint fifth
 *  award         brass pickup into a blooming D-major chord (detuned saws, opening lowpass, pitch
 *                scoop), cymbal swell, bell sparkle
 *  victory       ~3 s brass fanfare: ta-ta-ta pickup, D / G / A / big D chords, timpani roll and hits,
 *                cymbal swell, ascending bell cascade
 *  yourTurn      rising fourth (A5 -> D6) on soft bells
 *  error         muffled descending two-note triangle "uh-uh" with a soft low thud
 *  click         tiny modal tick (2.4 / 4.1 kHz) plus a faint sine blip
 *  hover         barely-there 2.5 kHz sine blip
 *  produce       five ascending pentatonic bell glints over an airy high noise swell
 *  produceForest stick-slip creak (low sawtooth exciting resonant band-passes), leaf-rustle crackles,
 *                a short bird chirp
 *  produceFields pink-noise wind gust sweeping across, a warm D/A glow, scattered high pentatonic glints
 *  producePasture lamb "baa": sawtooth through moving vowel formants (F1 380->820 Hz) with bleat vibrato
 *                and tremolo
 *  produceHills  kiln fire: brown-noise roar with opening lowpass, pink-noise flame, crackles and pops
 *  produceMountains three pickaxe clinks (steel partials + transient + stone grit), falling pebbles,
 *                brown-noise rumble and a low sine
 *  splash        downward-sweeping noise splash, spray hiss, a few upward-chirping bubble droplets
 *  whoosh        two band-passed noise sweeps (body + air) moving across the stereo field
 *  thunder       a near strike's crack and thump, then a roll of uneven brown/pink noise swells (r: far 0.75
 *                to overhead 1.2)
 *
 * The expansions' own voices (each measured against the above with scripts/capture/sounds.mjs):
 *  horn          far-off war horn, a short blast then a long one a fourth up that sags (saws + triangle,
 *                breath, late vibrato); r rises as the raider fleet closes in
 *  warDrum       war drums: two strokes, a gathering roll and one great stroke, a low crowd growl
 *  fanfare       herald's trumpet, tongued D-F#-A climb to a held high D over an A, snare brush, glint
 *  launch        hull off the slipway: deep wooden thud, a lap of water, spray and bubbles
 *  creak         rope on a cleat and timbers (slow stick-slip through wooden band-passes) over a lap
 *  battle        two drum strokes, blades clashing twice (bar partials + steel transients), a last stroke
 *  hiss          pollution: a sizzle under 7 kHz with crackles over a faint low tritone
 *  surge         flood: brown noise rising and opening, the wave breaking, a hiss draining away
 *  anvil         two hammer strokes on an anvil (bar partials, hammer tick, mass), the iron ringing
 *  wagon         wheels on a rough track (rumble, spoke knocks, axle creak) and an ox's low through formants
 *  stone         a dressed stone set: heavy dull thunk, a stone knock, grit
 *  crumble       stone giving way: a heavy fall, rubble skittering down, dust
 *  reel          a reel's ratchet winding in, then a drop's rising plop and a little splash
 *  chime         a breath of air through hung tubes, soft high D-pentatonic notes
 *  foghorn       a far foghorn in the fog bank: one long low diaphone note (D2) dropping a step at its end,
 *                dark and breathy, with a wide reverb
 *
 * Ambience: two panned pink-noise swell layers (lowpass body + band-passed foam wash after each crest,
 * random 5.5-10 s periods), a quiet brown-noise surf bed, wandering band-passed wind with rare gusts,
 * distant raspy gull cries and songbird chirp phrases at random intervals. Music: D-major Markov chord
 * walk (I ii IV V vi + mixolydian bVII) at 62-72 BPM with warm detuned pads, soft bass, marimba/kalimba
 * arpeggios of drifting density, occasional delayed-vibrato flute phrases and glockenspiel glints.
 * Both run on a lookahead scheduler (one interval timer each) and fade in/out.
 */
import { Ambience } from './ambience';
import { clamp, createEngine, Voice, type Engine } from './core';
import { Music } from './music';
import { GROUND_DAMP, RECIPES, groundLayer, type Ground } from './sounds';

export type SfxName =
  | 'dice' | 'cardLand' | 'card' | 'devPlay' | 'build' | 'road' | 'city' | 'robber' | 'robberLaugh'
  | 'steal' | 'trade' | 'offer' | 'award' | 'victory' | 'yourTurn' | 'error' | 'click' | 'hover'
  | 'produce' | 'produceForest' | 'produceFields' | 'producePasture' | 'produceHills' | 'produceMountains'
  | 'splash' | 'whoosh' | 'thunder'
  // The expansions' own voices.
  | 'horn' | 'warDrum' | 'fanfare' | 'launch' | 'creak' | 'battle' | 'hiss' | 'surge' | 'anvil' | 'wagon'
  | 'stone' | 'crumble' | 'reel' | 'chime' | 'foghorn';

interface Spec {
  level: number;
  wet: number;
  /** Max simultaneous voices of this sound (oldest is stolen). */
  cap: number;
  /** Minimum spacing between starts, seconds. */
  gap: number;
  /** Rapid repeats are delayed by up to this much instead of dropped. */
  queue?: number;
}

const SPEC: Record<SfxName, Spec> = {
  dice: { level: 1.8, wet: 0.12, cap: 2, gap: 0.12 },
  cardLand: { level: 1.4, wet: 0.06, cap: 6, gap: 0.03, queue: 0.2 },
  card: { level: 0.6, wet: 0.1, cap: 3, gap: 0.05, queue: 0.12 },
  devPlay: { level: 0.9, wet: 0.3, cap: 2, gap: 0.1 },
  build: { level: 1.2, wet: 0.15, cap: 3, gap: 0.05 },
  road: { level: 2.2, wet: 0.12, cap: 3, gap: 0.05 },
  city: { level: 0.85, wet: 0.25, cap: 2, gap: 0.1 },
  robber: { level: 0.45, wet: 0.4, cap: 1, gap: 0.3 },
  robberLaugh: { level: 0.45, wet: 0.35, cap: 1, gap: 0.3 },
  steal: { level: 0.6, wet: 0.2, cap: 2, gap: 0.1 },
  trade: { level: 1.9, wet: 0.25, cap: 2, gap: 0.08 },
  offer: { level: 0.85, wet: 0.35, cap: 2, gap: 0.1 },
  award: { level: 1.2, wet: 0.35, cap: 1, gap: 0.3 },
  victory: { level: 0.68, wet: 0.35, cap: 1, gap: 1 },
  yourTurn: { level: 0.88, wet: 0.35, cap: 1, gap: 0.3 },
  error: { level: 0.28, wet: 0.1, cap: 2, gap: 0.08 },
  click: { level: 1.0, wet: 0.05, cap: 3, gap: 0.03 },
  hover: { level: 0.45, wet: 0.05, cap: 2, gap: 0.05 },
  produce: { level: 1.4, wet: 0.35, cap: 2, gap: 0.08 },
  produceForest: { level: 1.0, wet: 0.25, cap: 2, gap: 0.08 },
  produceFields: { level: 1.0, wet: 0.3, cap: 2, gap: 0.08 },
  producePasture: { level: 0.53, wet: 0.2, cap: 2, gap: 0.08 },
  produceHills: { level: 0.6, wet: 0.2, cap: 2, gap: 0.08 },
  produceMountains: { level: 0.45, wet: 0.25, cap: 2, gap: 0.08 },
  splash: { level: 1.0, wet: 0.3, cap: 3, gap: 0.05 },
  whoosh: { level: 0.6, wet: 0.15, cap: 3, gap: 0.05 },
  thunder: { level: 1.5, wet: 0.45, cap: 2, gap: 0.3 },
  horn: { level: 0.52, wet: 0.5, cap: 1, gap: 0.4 },
  warDrum: { level: 0.8, wet: 0.35, cap: 1, gap: 0.4 },
  fanfare: { level: 1.4, wet: 0.35, cap: 1, gap: 0.3 },
  launch: { level: 0.49, wet: 0.25, cap: 2, gap: 0.08 },
  creak: { level: 0.9, wet: 0.2, cap: 2, gap: 0.08 },
  battle: { level: 0.82, wet: 0.3, cap: 2, gap: 0.15 },
  hiss: { level: 1.05, wet: 0.3, cap: 1, gap: 0.3 },
  surge: { level: 0.92, wet: 0.35, cap: 1, gap: 0.4 },
  anvil: { level: 2.0, wet: 0.3, cap: 2, gap: 0.1 },
  wagon: { level: 0.44, wet: 0.2, cap: 2, gap: 0.1 },
  stone: { level: 1.45, wet: 0.15, cap: 3, gap: 0.05 },
  crumble: { level: 1.15, wet: 0.25, cap: 2, gap: 0.08 },
  reel: { level: 1.9, wet: 0.2, cap: 2, gap: 0.08 },
  chime: { level: 1.15, wet: 0.4, cap: 2, gap: 0.2 },
  foghorn: { level: 0.42, wet: 0.6, cap: 1, gap: 6 },
};

/** Every sound's name, in the palette's order (for auditioning them all). */
export const SFX_NAMES = Object.keys(SPEC) as SfxName[];

/**
 * One sound rendered offline, as play() would sound it from the middle of the screen through the
 * same mastering (no device needed): what scripts/capture/sounds.mjs writes out as WAV and measures, so a
 * new voice's loudness and length can be checked against the palette's. It starts a quarter of a
 * second in.
 */
export async function renderSound(name: SfxName, o: { rate?: number; seconds?: number; sampleRate?: number } = {}): Promise<AudioBuffer> {
  const sr = o.sampleRate ?? 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(((o.seconds ?? 4) + 0.25) * sr), sr);
  const e = createEngine(ctx);
  const spec = SPEC[name];
  const v = new Voice(e, e.sfx, spec.level, 0, spec.wet);
  // (A quarter second in: the mastering's compressor clamps the first moments of a fresh context.)
  RECIPES[name](v, 0.25, o.rate ?? 1);
  v.seal();
  return ctx.startRendering();
}

const MAX_VOICES = 28;
/** How heavily each piece comes down, for its ground layer. */
const GROUND_WEIGHT: Partial<Record<SfxName, number>> = { road: 0.6, build: 1, city: 1.4 };
/** And at most this many sources sounding at once (a fanfare alone is about ninety). */
const MAX_SOURCES = 220;

let engine: Engine | null = null;
let failed = false;
let resumePending = false;
/** When the pending resume was asked for: one that never settles mustn't count as running. */
let resumeAt = 0;
/** Why the context is held suspended on purpose (the tab hidden, everything muted). */
const holds = new Set<string>();
let ambience: Ambience | null = null;
let music: Music | null = null;
let wantAmbience = false;
let wantMusic = false;
const vols = { sfx: 1, amb: 1, music: 1 };
const active = new Map<SfxName, Voice[]>();
const all: Voice[] = [];
const lastStart = new Map<SfxName, number>();

type AudioContextCtor = typeof AudioContext;

function ensure(): Engine | null {
  if (engine || failed) return engine;
  try {
    const w = typeof window !== 'undefined' ? (window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }) : undefined;
    const Ctor = w?.AudioContext ?? w?.webkitAudioContext;
    if (!Ctor) {
      failed = true;
      return null;
    }
    engine = createEngine(new Ctor({ latencyHint: 'interactive' }));
    applyVolumes(true);
  } catch {
    failed = true;
    engine = null;
  }
  return engine;
}

function applyVolumes(instant = false) {
  if (!engine) return;
  const t = engine.ctx.currentTime;
  for (const [bus, v] of [[engine.sfx, vols.sfx], [engine.amb, vols.amb], [engine.music, vols.music]] as const) {
    const g = v * v;
    for (const node of [bus.dry, bus.wet]) {
      if (instant) node.gain.value = g;
      else node.gain.setTargetAtTime(g, t, 0.04);
    }
  }
}

function running(e: Engine): boolean {
  return e.ctx.state === 'running' || (resumePending && performance.now() - resumeAt < 1200);
}

/** Hold the context suspended for a reason (or let it go, resuming once nothing holds it). */
function hold(reason: string, on: boolean) {
  if (on === holds.has(reason)) return;
  if (on) holds.add(reason);
  else holds.delete(reason);
  const e = engine;
  if (!e) return;
  const ctx = e.ctx as AudioContext;
  if (holds.size) ctx.suspend().catch(() => {});
  else if (ctx.state !== 'running') ctx.resume().then(syncBeds, () => {});
}

function syncBeds() {
  const e = engine;
  if (!e || !running(e)) return;
  if (wantAmbience && !ambience) {
    ambience = new Ambience(e);
    if (scene) ambience.setScene(scene);
  }
  if (wantMusic && !music) music = new Music(e);
}

function prune(list: Voice[], now: number) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].done || list[i].end < now - 0.05) list.splice(i, 1);
}

const num = (x: number | undefined, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/** A place on the island (world units) a sound comes from. */
interface SoundAt {
  x: number;
  y?: number;
  z: number;
}

/** Where a place sits for the listener: left-right on screen (-1..1) and how far off. */
type Locate = (at: SoundAt) => { pan: number; distance: number };
let locate: Locate | null = null;

/** What the ambience follows: the listener's height over the sea, night, wind and storm (0..1). */
export interface SoundScene {
  height: number;
  night: number;
  wind: number;
  storm: number;
}
let scene: SoundScene | null = null;

/**
 * A sound from a place: panned to where it is on screen, and further off quieter, duller and
 * with more of the surroundings in it (at the usual view's distance, as recorded).
 */
function placed(at: SoundAt, wet: number) {
  const l = locate!(at);
  const d = Math.max(0, l.distance);
  return {
    pan: clamp(l.pan, -1, 1) * 0.8,
    gain: Math.pow(14 / Math.max(14, d), 0.7) * Math.min(1.15, Math.pow(14 / Math.max(6, d), 0.15)),
    air: clamp(20000 * Math.exp(-Math.max(0, d - 12) / 40), 2600, 20000),
    wet: wet * (0.8 + 0.6 * clamp((d - 10) / 30, 0, 1)),
  };
}

export const sfx = {
  /**
   * Build the engine ahead of the first gesture: opening the audio device blocks for a few
   * hundred milliseconds, better spent while loading than on the first tap (often Begin). The
   * context stays suspended until unlock().
   */
  prepare(): void {
    ensure();
  },

  /** Must be called from a user gesture before sounds play (browser autoplay policy); safe to call repeatedly. */
  unlock(): void {
    const e = ensure();
    if (!e || holds.size) return;
    const ctx = e.ctx as AudioContext;
    // (Asked again on every gesture until it runs: a resume can be refused, or interrupted later
    // by the system, and asking twice does no harm.)
    if (ctx.state !== 'running') {
      resumePending = true;
      resumeAt = performance.now();
      try {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.onended = () => s.disconnect();
        s.start();
      } catch {
        // iOS unlock nicety only
      }
      ctx.resume().then(
        () => {
          resumePending = false;
          syncBeds();
        },
        () => {
          resumePending = false;
        },
      );
    }
    syncBeds();
  },

  /** How to place sounds on the island (set by the world, from its camera). */
  setLocate(fn: Locate | null): void {
    locate = fn;
  },

  /** The listener's surroundings, for the ambience (set by the world a few times a second). */
  setScene(s: SoundScene): void {
    scene = s;
    ambience?.setScene(s);
  },

  /**
   * `at`: where on the island it comes from. `ground`: what a piece lands on (with `wet` for a
   * corner by the sea), which colours the landing and softens the piece's knock on soft ground.
   */
  play(name: SfxName, opts?: { volume?: number; pan?: number; rate?: number; at?: SoundAt; ground?: Ground; wet?: boolean }): void {
    const e = engine;
    const spec = SPEC[name];
    if (!e || !spec || !running(e)) return;
    try {
      const now = e.ctx.currentTime;
      let t = now + 0.005;
      const last = lastStart.get(name);
      if (last !== undefined && t - last < spec.gap) {
        const delay = last + spec.gap - t;
        if (!spec.queue || delay > spec.queue) return;
        t = last + spec.gap;
      }
      lastStart.set(name, t);

      let list = active.get(name);
      if (!list) active.set(name, (list = []));
      prune(list, now);
      prune(all, now);
      while (list.length >= spec.cap) list.shift()?.kill();
      while (all.length >= MAX_VOICES) all.shift()?.kill();
      let sources = 0;
      for (const x of all) sources += x.sources;

      let volume = clamp(num(opts?.volume, 1), 0, 2) * spec.level;
      const rate = clamp(num(opts?.rate, 1), 0.25, 4);
      let pan = clamp(num(opts?.pan, 0), -1, 1), wet = spec.wet, air = 0;
      if (opts?.at && locate) {
        const p = placed(opts.at, spec.wet);
        volume *= p.gain;
        pan = p.pan;
        wet = p.wet;
        air = p.air;
      }
      if (opts?.ground) air = Math.min(air || 20000, GROUND_DAMP[opts.ground]);
      const v = new Voice(e, e.sfx, volume, pan, wet, air);
      RECIPES[name](v, t, rate);
      if (opts?.ground) groundLayer(v, t, opts.ground, GROUND_WEIGHT[name] ?? 1, rate, opts.wet);
      v.seal();
      if (!v.done) {
        // Oldest first, until the new voice fits the budget of sources.
        while (all.length && sources + v.sources > MAX_SOURCES) {
          const old = all.shift()!;
          sources -= old.sources;
          old.kill();
        }
        list.push(v);
        all.push(v);
      }
    } catch {
      // never let audio break the game
    }
  },

  /** 0..1 each; mapped through a squared curve so sliders feel even. */
  setVolume(sfxVol: number, ambienceVol: number, musicVol: number): void {
    vols.sfx = clamp(num(sfxVol, vols.sfx), 0, 1);
    vols.amb = clamp(num(ambienceVol, vols.amb), 0, 1);
    vols.music = clamp(num(musicVol, vols.music), 0, 1);
    applyVolumes();
    // Silent all round (muted): the beds and their schedulers needn't run at all.
    hold('muted', vols.sfx + vols.amb + vols.music === 0);
  },

  /** The tab hidden (or shown again): nothing plays to an empty room. */
  setHidden(hidden: boolean): void {
    hold('hidden', hidden);
  },

  /** Whether sound is actually playing now (gestures keep asking for it until it is). */
  isRunning(): boolean {
    return !!engine && engine.ctx.state === 'running';
  },

  startAmbience(): void {
    wantAmbience = true;
    syncBeds();
  },

  /** Rain on the ambience bed (0..1). */
  setRain(level: number): void {
    ambience?.setRain(level);
  },

  startMusic(): void {
    wantMusic = true;
    syncBeds();
  },

  dispose(): void {
    wantAmbience = wantMusic = false;
    ambience?.destroy();
    music?.destroy();
    ambience = music = null;
    for (const v of all) v.destroy();
    all.length = 0;
    active.clear();
    lastStart.clear();
    if (engine) {
      const ctx = engine.ctx as AudioContext;
      engine.dispose();
      ctx.close().catch(() => {});
    }
    engine = null;
    failed = false;
    resumePending = false;
  },
};
