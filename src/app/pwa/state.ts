// The installable app's state, for the interface: whether a new version is waiting; and whether the
// game runs as an installed app. (Part of the page's first script, so kept small: everything else in
// app/pwa loads later. The browser offers its own install, in its bar or menu.)

import { create } from 'zustand';

export interface PwaState {
  /** A new version is ready: a new service worker waiting to take over, or a newer page on the server. */
  update: null | 'worker' | 'page';
}

export const usePwa = create<PwaState>(() => ({ update: null }));

/** An iPhone, iPad or iPod (an iPad asks for the desktop site, so it says Macintosh, with touch). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Whether the game runs as an installed app rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // (iOS says so itself; the Android app is opened by its package.)
  if ((navigator as { standalone?: boolean }).standalone === true || document.referrer.startsWith('android-app://')) return true;
  const mode = (m: string) => matchMedia(`(display-mode: ${m})`).matches;
  // (A tab put full screen matches fullscreen too, with an element in full screen.)
  return mode('standalone') || mode('minimal-ui') || mode('window-controls-overlay') || (mode('fullscreen') && !document.fullscreenElement);
}
