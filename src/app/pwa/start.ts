// The installable app's start, called from main.tsx: the service worker and its update checks wait
// until the title is up and the page has gone quiet, so none of it slows the first load.

import { useUI } from '../../game/store';

/** How long after the title is up the service worker is registered (then at the page's next idle moment). */
const AFTER_TITLE_MS = 3000;

export function startPwa() {
  const register = () => void import('./register').then((m) => m.registerWorker(), () => {});
  const later = () =>
    setTimeout(() => {
      if ('requestIdleCallback' in window) requestIdleCallback(register, { timeout: 5000 });
      else register();
    }, AFTER_TITLE_MS);
  if (useUI.getState().worldReady) {
    later();
    return;
  }
  const stop = useUI.subscribe((s) => {
    if (!s.worldReady) return;
    stop();
    later();
  });
}
