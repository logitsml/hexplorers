import { useSyncExternalStore } from 'react';

/**
 * Phones (portrait or landscape) and other small windows get the compact HUD: a slim top bar,
 * the board in the middle and one dock at the bottom. So do touch screens up to about 960px
 * a side, which takes in both screens of a foldable phone (about 466x678 closed and
 * 890x626 open): the same HUD on either, as the device folds and unfolds. Keep in step with the
 * compact media query in ui.css.
 */
export const COMPACT_QUERY = '(max-width: 700px), (max-height: 500px), (pointer: coarse) and (max-width: 960px) and (max-height: 960px)';

const media = typeof window !== 'undefined' ? window.matchMedia(COMPACT_QUERY) : null;

const subscribe = (fn: () => void) => {
  media?.addEventListener('change', fn);
  return () => media?.removeEventListener('change', fn);
};

const isCompact = () => !!media?.matches;

export function useCompact() {
  return useSyncExternalStore(subscribe, isCompact, () => false);
}

/** A touch screen as the main input (no hover; taps want a preview before they commit). */
export const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
