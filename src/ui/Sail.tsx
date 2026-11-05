// The progress of a game being set up ("Setting sail"), as the title's card, the set-up page's
// button and the editor's Test play show it: a fill and a percentage, eased a frame at a time
// towards what session.start reports and never back. (As the loading screen's route: a CSS
// transition, retargeted after a busy moment, could start again from behind where it was drawn.)

import { useEffect, useRef } from 'react';
import { useUI } from '../game/store';

/**
 * Refs for the fill (scaled across from the left) and the percentage, kept up to date every frame
 * without rendering anything again. (session.start reports from 0 the moment it is called, so a
 * button lit as it starts never shows the last voyage's progress.)
 */
export function useSailing() {
  const bar = useRef<HTMLSpanElement>(null);
  const pct = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0, at = 0, furthest = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      furthest = Math.max(furthest, Math.min(1, Math.max(0, useUI.getState().loading.progress)));
      at = furthest - at < 0.0005 ? furthest : at + (furthest - at) * Math.min(1, dt * 5);
      if (bar.current) bar.current.style.transform = `scaleX(${at})`;
      if (pct.current) pct.current.textContent = `${Math.floor(at * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return { bar, pct };
}

/** The fill: a pale wash across what it's in, from its leading edge (`wash`: the sea's tint, for a title card). */
export function SailFill({ wash = false }: { wash?: boolean }) {
  const { bar } = useSailing();
  return <span ref={bar} className={`sail-fill${wash ? ' wash' : ''}`} aria-hidden />;
}

/** "Setting sail… 42%", the percentage following the fill. */
export function SailLabel() {
  const { pct } = useSailing();
  return (
    <>
      Setting sail… <span ref={pct} className="sail-pct">0%</span>
    </>
  );
}
