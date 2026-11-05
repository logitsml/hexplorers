// The quality preset a device starts on while Settings say Auto.
//
// Most of a first visit's loading time is the GPU compiling a shader for every variant the
// preset draws (before the browser has cached them), and High, whose AO prepass, sea mirror and
// lamp lighting need three times the variants of Low or Medium, takes about three times as long.
// So Auto starts capable devices on Medium and phones and weak or
// software-rendered devices on Low; Settings can pick another, and Auto never changes it by itself.

import type { Quality } from '../render/core/stage';
import { probeGpu } from '../render/core/gpuProbe';

const KEY = 'exploratory.autoQuality';
const PRESETS: readonly Quality[] = ['low', 'medium', 'high', 'ultra'];
/** Set once a step down is the player's to accept (see rememberedQuality). */
const ASKS = 'exploratory.autoQualityAsks';

/** What Auto settled on for this device before (a step down the player accepted, or an accepted High). */
export function rememberedQuality(): Quality | null {
  try {
    // A Low or Medium kept without the ASKS mark was a step down Auto took by itself, which could
    // misread a game's start (its shaders building, the island rising) as a slow device: it's let
    // go of, once, and the device's own pick stands again. (An accepted High stays.)
    if (!localStorage.getItem(ASKS)) {
      localStorage.setItem(ASKS, '1');
      const was = localStorage.getItem(KEY);
      if (was === 'low' || was === 'medium') localStorage.removeItem(KEY);
    }
    const v = localStorage.getItem(KEY) as Quality | null;
    return v && PRESETS.includes(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberQuality(q: Quality) {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* storage unavailable */
  }
}

const FLOOR_KEY = 'exploratory.pixelFloor';

/** How much of the pixel floor Auto kept for this device (see Stage.floorScale), if it lowered it. */
export function rememberedFloor(): number | null {
  try {
    const v = Number(localStorage.getItem(FLOOR_KEY) ?? NaN);
    return v >= 0 && v <= 1 ? v : null;
  } catch {
    return null;
  }
}

export function rememberFloor(k: number) {
  try {
    localStorage.setItem(FLOOR_KEY, String(k));
  } catch {
    /* storage unavailable */
  }
}

/** A starting preset from what the browser reports about the device. */
export async function deviceQuality(): Promise<Quality> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  // Without WebGPU three falls back to WebGL2 (no wave simulation or lamp light): keep it light.
  // (As without a WebGPU that would run the game: see gpuProbe.ts.)
  if (!nav.gpu || !(await probeGpu())) return 'low';
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    /* none available */
  }
  // A software adapter renders on the CPU. (Said by its info now; Chrome deprecated the adapter's own flag.)
  const soft = adapter as (GPUAdapter & { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } }) | null;
  if (!soft || (soft.info?.isFallbackAdapter ?? soft.isFallbackAdapter)) return 'low';
  // Phones: a coarse pointer on a small screen.
  if (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820) return 'low';
  // (Chrome reports memory in steps up to 8 GB; other browsers don't report it.)
  if ((nav.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4) return 'low';
  return 'medium';
}

/** The next preset down, or null at the bottom. */
export function stepDown(q: Quality): Quality | null {
  const i = PRESETS.indexOf(q);
  return i > 0 ? PRESETS[i - 1] : null;
}
