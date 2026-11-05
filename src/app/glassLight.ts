// Sea Glass follows the sky. The game's night value (0 by day, 1 at night, eased by the sky itself) moves
// the glass continuously: by day it's a light, clear tint over a lifted board, growing denser as the board
// darkens so its dark text keeps its contrast; at night it's dark, clearer still, with light text. Every
// value blends with the sky except one: which way round the text is. A continuous fade would pass the
// glass through mid-grey, where neither dark nor light text can be read, so the two appearances are
// brought toward each other and the text turns over once, at deep dusk, in one slow crossfade (with a
// little hysteresis, so a sky resting near the point never flickers). Written to the page's custom
// properties a few times a second, and only when a value moves.

import { useUI } from '../game/store';
import { session } from './session';
import { DARK_ALPHA, LIGHT_ALPHA, RAMPS } from '../ui/glassPalette';

const F = RAMPS.frost;
const SEA = RAMPS.sea;
const AMBER = RAMPS.amber;
const KELP = RAMPS.kelp;

/** Where the glass turns from light to dark, and back (night values). */
const TO_DARK = 0.6;
const TO_LIGHT = 0.54;
/** How long the turn takes, in milliseconds (shorter with reduced motion: a quick fade, nothing moving). */
const TURN_MS = 6000;
const TURN_MS_REDUCED = 600;

type RGB = [number, number, number];

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const parse = (hex: string): RGB => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as RGB;
const P: Record<string, RGB> = {};
const rgb = (hex: string) => (P[hex] ??= parse(hex));
/** Two colours mixed in linear light, `t` of the second. */
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB, alpha = 1) => {
  const [r, g, b] = c.map((v) => Math.round(gam(Math.min(1, Math.max(0, v))) * 255));
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${Math.round(alpha * 1000) / 10}%)`;
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The open sea behind the HUD, by day and by night (sRGB, 0..1). */
const SEA_DAY: RGB = [0.07, 0.32, 0.49];
const SEA_NIGHT: RGB = [0.03, 0.09, 0.16];

/**
 * A colour (sRGB) through the frost's filters, as the browser applies them (styles/glass.css's
 * --glass-backdrop, less the blur): contrast, brightness and saturate(1.8), each clamped. In
 * linear light, for mix.
 */
function frosted(c: RGB, contrast: number, bright: number): RGB {
  const lifted = c.map((v) => clamp01(clamp01((v - 0.5) * contrast + 0.5) * bright));
  const grey = 0.213 * lifted[0] + 0.715 * lifted[1] + 0.072 * lifted[2];
  return lifted.map((v) => lin(clamp01(grey + (v - grey) * 1.8))) as RGB;
}

/** A value read off one of the opacity tables at `n`. */
function table(rows: readonly (readonly [number, number])[], n: number): number {
  if (n <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    const [x1, y1] = rows[i];
    if (n <= x1) {
      const [x0, y0] = rows[i - 1];
      return lerp(y0, y1, (n - x0) / (x1 - x0));
    }
  }
  return rows[rows.length - 1][1];
}

interface Look {
  fill: RGB;
  alpha: number;
  contrast: number;
  bright: number;
  pebble: RGB;
  pebbleAlpha: number;
  well: RGB;
  wellAlpha: number;
}

/** The light glass at night value `n`: denser and a touch greyer as the board behind it darkens. */
const lightLook = (n: number): Look => ({
  fill: mix(rgb(F[0]), rgb(F[2]), clamp01(n / 0.6)),
  alpha: table(LIGHT_ALPHA, n),
  contrast: 0.25 + 0.15 * n,
  bright: 1.65 - 0.35 * n,
  pebble: rgb('#fdfefe'),
  pebbleAlpha: 0.96,
  well: rgb(F[2]),
  wellAlpha: 0.9,
});

/** The dark glass at night value `n`: clearer as the night deepens. */
const darkLook = (n: number): Look => ({
  fill: mix(rgb(F[9]), rgb(F[11]), clamp01((n - 0.3) / 0.7)),
  alpha: table(DARK_ALPHA, n),
  contrast: 0.6,
  bright: 0.75 + 0.25 * (1 - n),
  pebble: rgb(F[10]),
  pebbleAlpha: 0.94,
  well: rgb(F[11]),
  wellAlpha: 0.62,
});

let night = 0;
/** 0 light, 1 dark; eased toward the appearance the sky calls for. */
let turn = 0;
let goal = 0;
let turnFrom = 0;
let turnStart = 0;
let raf = 0;
const written: Record<string, string> = {};

function write(name: string, value: string) {
  if (written[name] === value) return;
  written[name] = value;
  document.documentElement.style.setProperty(name, value);
}

/** The sky's night value: the world's when it's up, else the fixed time of day the settings name. */
function skyNight(): number {
  const w = session.world;
  if (w) return w.time.night.value;
  const t = useUI.getState().settings.timeOfDay;
  return t === 'night' ? 1 : t === 'dusk' ? 0.55 : 0;
}

function paint() {
  const t = ease(turn);
  const L = lightLook(night);
  const D = darkLook(night);
  const fill = mix(L.fill, D.fill, t);
  const alpha = lerp(L.alpha, D.alpha, t), contrast = lerp(L.contrast, D.contrast, t), bright = lerp(L.bright, D.bright, t);
  // Without a blur behind it (app/frost.ts: the WebGL fallback), the glass is opaque, as it would
  // come out over the open sea: the sea lifted by the frost's filters, the fill laid over it.
  if (document.documentElement.dataset.backdrop === 'solid') write('--glass-fill', css(mix(frosted(mix(SEA_DAY, SEA_NIGHT, night), contrast, bright), fill, alpha)));
  else write('--glass-fill', css(fill, alpha));
  write('--glass-contrast', contrast.toFixed(3));
  write('--glass-bright', bright.toFixed(3));
  write('--glass-pebble', css(mix(L.pebble, D.pebble, t), lerp(L.pebbleAlpha, D.pebbleAlpha, t)));
  write('--glass-pebble-hover', css(mix(rgb(F[0]), rgb(F[9]), t), lerp(1, 0.96, t)));
  write('--glass-well', css(mix(L.well, D.well, t), lerp(L.wellAlpha, D.wellAlpha, t)));
  // The text turns over in the middle of the turn, over its middle sixth, never at a frame where both
  // the glass and the text are mid-grey for long.
  const tx = ease(clamp01((turn - 0.42) / 0.16));
  const text = mix(rgb(F[11]), rgb(F[0]), tx);
  write('--glass-text', css(text));
  // (The quiet washes are the ink at a low alpha, as a channel triplet for ui.css's rgb(var(--wash) / a).)
  write('--wash', css(text).slice(4, -1));
  // (The soft ink a step deeper by day and paler at night than its ramp step: it keeps 4.5:1 on the clearest glass.)
  write('--glass-text-2', css(mix(mix(rgb(F[10]), rgb(F[11]), 0.4), rgb(F[3]), tx)));
  // Links and quiet buttons: the accent's deep shade by day, a pale one at night, turning with the text.
  write('--glass-link', css(mix(rgb(SEA[10]), rgb(SEA[3]), tx)));
  write('--glass-line', css(mix(rgb(F[4]), rgb(F[0]), t), lerp(1, 0.18, t)));
  write('--glass-rim', lerp(0.22, 0.1, t).toFixed(3));
  write('--glass-shadow', css(mix(rgb('#04222f'), rgb('#00040c'), t), lerp(0.24, 0.55, t)));
  write('--glass-shadow-near', css(mix(rgb('#04222f'), rgb('#00040c'), t), lerp(0.16, 0.4, t)));
  write('--glass-scrim', css(mix(rgb('#041e2c'), rgb('#00060f'), t), lerp(0.34, 0.45, t)));
  // Meaning colours: pale by day, deep at night, each with its own text shade.
  write('--glass-accent-subtle', css(mix(rgb(SEA[2]), rgb(SEA[10]), t), lerp(0.88, 0.88, t)));
  write('--glass-accent-ring', css(mix(rgb(SEA[6]), rgb(SEA[6]), t)));
  write('--glass-give', css(mix(rgb(AMBER[3]), rgb(AMBER[10]), t)));
  write('--glass-give-strong', css(mix(rgb(AMBER[5]), rgb(AMBER[6]), t)));
  write('--glass-give-text', css(mix(rgb(AMBER[11]), rgb(AMBER[2]), tx)));
  write('--glass-get', css(mix(rgb(KELP[3]), rgb(KELP[10]), t)));
  write('--glass-get-strong', css(mix(rgb(KELP[5]), rgb(KELP[6]), t)));
  write('--glass-get-text', css(mix(rgb(KELP[11]), rgb(KELP[2]), tx)));
  write('--glass-dark', t.toFixed(3));
}

function frame(now: number) {
  raf = 0;
  const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? TURN_MS_REDUCED : TURN_MS;
  turn = lerp(turnFrom, goal, clamp01((now - turnStart) / ms));
  paint();
  if (turn !== goal) raf = requestAnimationFrame(frame);
}

function tick() {
  if (document.documentElement.dataset.look !== 'glass') return;
  // (In steps of a hundredth: the sky drifts slowly, and each step restyles the page.)
  night = Math.round(skyNight() * 100) / 100;
  const want = goal === 0 ? (night >= TO_DARK ? 1 : 0) : night <= TO_LIGHT ? 0 : 1;
  if (want !== goal) {
    goal = want;
    turnFrom = turn;
    turnStart = performance.now();
    if (!raf) raf = requestAnimationFrame(frame);
  }
  if (!raf) paint();
}

/** Paints the glass again at once (the page changed how it is drawn: see app/frost.ts). */
export function repaintGlass() {
  if (document.documentElement.dataset.look === 'glass') paint();
}

/** Puts the chosen look on the page, and keeps Sea Glass in step with the sky. */
export function installGlassLight() {
  const apply = () => {
    const look = useUI.getState().settings.look;
    if (document.documentElement.dataset.look === look) return;
    document.documentElement.dataset.look = look;
    if (look === 'glass') {
      // (Start already matching the sky: no turn plays as the game opens.)
      night = Math.round(skyNight() * 100) / 100;
      goal = turn = turnFrom = night >= TO_DARK ? 1 : 0;
      paint();
    }
  };
  apply();
  useUI.subscribe((s, p) => {
    if (s.settings.look !== p.settings.look) apply();
  });
  setInterval(() => {
    if (!document.hidden) tick();
  }, 250);
}
