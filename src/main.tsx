import '@fontsource-variable/fraunces';
import '@fontsource/lilita-one/400.css';
import '@fontsource/alegreya-sans/400.css';
import '@fontsource/alegreya-sans/500.css';
import '@fontsource/alegreya-sans/700.css';
import '@fontsource/alegreya-sans/800.css';
import '@fontsource-variable/google-sans-flex';
import './styles/base.css';
import './styles/ui.css';
import './styles/glass.css';
import { Suspense, lazy, useLayoutEffect, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { useUI } from './game/store';
import { Loader } from './ui/Loader';
import { startScenery } from './render/env/sceneryJob';
import { SPRING_UI } from './ui/motion';
import { startPwa } from './app/pwa/start';

// The page starts with only the loading screen: React, the motion library, the UI store and the
// loader itself. The interface and the 3D world (three.js, the session, the engine) come after, in
// chunks of their own, so the chart is up and drawing while they arrive.

/** Say on the loading screen that a part of the game didn't arrive (it offers Try again). */
function failed(e: unknown) {
  console.error('could not load', e);
  const { loading } = useUI.getState();
  useUI.getState().set({ loading: { ...loading, error: e instanceof Error ? e.message : String(e) } });
}

/**
 * A chunk that won't load, most likely because a new release has replaced it since this page was
 * opened (its old name is gone from the server). On the loading screen or the title nothing is
 * lost by starting again, so the page reloads, once, and only if the server answers (offline, a
 * reload would only trade the error for the browser's own): a second failure soon after is left
 * to show as an error. In a game (or the editor) the page stays, its save written at once, and the
 * part that didn't load says so as it would for any failure.
 */
window.addEventListener('vite:preloadError', () => {
  const { worldReady, screen } = useUI.getState();
  if (worldReady && screen !== 'title') {
    void import('./app/session').then((m) => m.session.flushSave());
    return;
  }
  const KEY = 'exploratory.reloadedForChunk';
  const recent = () => {
    try {
      return Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 60000;
    } catch {
      // (Without session storage a second failure can't be told from the first: no reload.)
      return true;
    }
  };
  if (recent()) return;
  void fetch('/', { method: 'HEAD', cache: 'no-store' }).then(
    (r) => {
      if (!r.ok || recent()) return;
      // (Where it can't be written, no reload: a second failure couldn't be told from the first.)
      try {
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        return;
      }
      location.reload();
    },
    () => {},
  );
});

const App = lazy<ComponentType>(() =>
  import('./ui/App').then(
    (m) => ({ default: m.App }),
    (e) => {
      failed(e);
      return { default: () => null };
    },
  ),
);

const MOTION = { system: 'user', on: 'always', off: 'never' } as const;

/**
 * The motion and contrast settings as attributes on the page, for the stylesheet: each is the
 * setting, or the device's own while it is left to follow that, so On and Off both win over the
 * system in CSS as they do in the animations (MotionConfig below).
 */
function useDocumentPrefs() {
  const motion = useUI((s) => s.settings.reduceMotion);
  const contrast = useUI((s) => s.settings.highContrast);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const strong = matchMedia('(prefers-contrast: more)');
    const apply = () => {
      root.dataset.motion = motion === 'on' || (motion === 'system' && still.matches) ? 'reduce' : 'full';
      root.dataset.contrast = contrast === 'on' || (contrast === 'system' && strong.matches) ? 'more' : 'standard';
    };
    apply();
    still.addEventListener('change', apply);
    strong.addEventListener('change', apply);
    return () => {
      still.removeEventListener('change', apply);
      strong.removeEventListener('change', apply);
    };
  }, [motion, contrast]);
}

/** The loading screen until the island is ready, and the interface (the title, a game) once it has loaded. */
function Shell() {
  const ready = useUI((s) => s.worldReady);
  const reduceMotion = useUI((s) => s.settings.reduceMotion);
  useDocumentPrefs();
  return (
    // (Whatever sets no transition of its own moves on the interface's spring, which settles
    // without overshooting: see ui/motion.ts.)
    <MotionConfig reducedMotion={MOTION[reduceMotion]} transition={SPRING_UI}>
      <AnimatePresence>{!ready && <Loader key="loader" />}</AnimatePresence>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </MotionConfig>
  );
}

createRoot(document.getElementById('root')!).render(<Shell />);
// The land on the horizon is built on a worker while the world's scripts arrive (see sceneryJob.ts).
void startScenery();
import('./app/bootstrap').then((m) => m.bootstrap(), failed);
// The installable app: its install prompt is listened for now, its service worker registered
// once the title is up (see app/pwa).
startPwa();
