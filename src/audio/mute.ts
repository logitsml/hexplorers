// Global mute that remembers the player's volume settings.

import { sfx } from './sfx';
import { useUI } from '../game/store';

let muted = false;
try {
  muted = localStorage.getItem('exploratory.muted') === '1';
} catch {
  /* storage unavailable */
}

export function isMuted() {
  return muted;
}

/** Apply the current settings (or silence) to the audio buses. */
export function applyVolume() {
  const s = useUI.getState().settings;
  if (muted) sfx.setVolume(0, 0, 0);
  else sfx.setVolume(s.sound, s.sound * 0.8, s.music);
}

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem('exploratory.muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
  applyVolume();
  useUI.getState().set({ muted: m });
}
