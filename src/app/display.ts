// Display preferences that live outside React: interface size and forced reduced motion.

import type { Settings } from '../game/store';

let current: Pick<Settings, 'uiScale' | 'reduceMotion'> = { uiScale: 1, reduceMotion: 'system' };
let listening = false;

/**
 * The HUD is laid out for about 1200×760 at size 1. Larger sizes only apply as far as the
 * window has room for them, so a big setting on a small screen never makes panels collide.
 */
export function effectiveScale(scale: number) {
  if (scale <= 1) return scale;
  const fit = Math.min(window.innerWidth / 1200, window.innerHeight / 760);
  return Math.max(1, Math.min(scale, fit));
}

function apply() {
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(effectiveScale(current.uiScale)));
}

/** Whether to keep motion and flashing down: the setting, or the system's when it says so. */
export function reducedMotion() {
  return current.reduceMotion === 'on' || (current.reduceMotion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

export function applyDisplaySettings(s: Pick<Settings, 'uiScale' | 'reduceMotion'>) {
  current = { uiScale: s.uiScale, reduceMotion: s.reduceMotion };
  apply();
  if (!listening) {
    listening = true;
    window.addEventListener('resize', apply);
  }
}
