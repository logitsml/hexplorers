// A column of panels that scrolls when it's taller than its room (the dock's decisions, the
// ledger's page), and says so: where the room cuts it, the panels fade out instead of ending in
// a sliver of paper that reads as a crushed panel, and a pill over the fade says how much is
// below and scrolls to it. (macOS hides its scrollbars, so otherwise nothing would show that a
// whole panel was waiting under the cut.)

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotionConfig } from 'motion/react';

interface Cut {
  above: boolean;
  below: boolean;
  /** How many of the column's panels are wholly out of sight below. */
  hidden: number;
}

const NONE: Cut = { above: false, below: false, hidden: 0 };

/** Where `el`'s content runs past its room, read again whenever it scrolls, resizes or its content changes. */
function useCut(ref: React.RefObject<HTMLDivElement | null>): Cut {
  const [cut, setCut] = useState<Cut>(NONE);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const bottom = el.scrollTop + el.clientHeight;
      const below = el.scrollHeight - bottom > 6;
      // (A panel counts as hidden once its top is under the fade, where nothing of it reads.)
      let hidden = 0;
      if (below) for (const c of el.children) if ((c as HTMLElement).offsetTop >= bottom - 28) hidden++;
      const next = { above: el.scrollTop > 6, below, hidden };
      setCut((was) => (was.above === next.above && was.below === next.below && was.hidden === next.hidden ? was : next));
    };
    const sizes = new ResizeObserver(check);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const c of el.children) sizes.observe(c);
    };
    // (A panel coming or going changes the content without changing the column's box.)
    const tree = new MutationObserver(() => {
      watch();
      check();
    });
    watch();
    tree.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', check, { passive: true });
    check();
    return () => {
      sizes.disconnect();
      tree.disconnect();
      el.removeEventListener('scroll', check);
    };
  }, [ref]);
  return cut;
}

/**
 * `children` in a scrolling column (`className`) inside a wrapper (`wrap`) that carries the cut's
 * classes, `cut-above` and `cut-below`, for the fades, and the "more" pill.
 */
export function ScrollCut({ className, wrap, label, mark, children }: { className: string; wrap: string; label: string; mark?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const cut = useCut(ref);
  const reduce = useReducedMotionConfig();
  const more = () => {
    const el = ref.current;
    if (el) el.scrollBy({ top: Math.max(80, el.clientHeight * 0.75), behavior: reduce ? 'auto' : 'smooth' });
  };
  return (
    <div className={`${wrap}${cut.above ? ' cut-above' : ''}${cut.below ? ' cut-below' : ''}`} data-hud-obstacle={mark}>
      <div className={`${className} scroll-cut`} ref={ref}>
        {children}
      </div>
      {cut.below && (
        // (For the pointer and the finger: the keyboard reaches what's below by tabbing to it, which
        // scrolls it into view, and a screen reader reads the column whole.)
        <button type="button" className="more-pill" onClick={more} tabIndex={-1} aria-hidden title={`Scroll down for ${cut.hidden > 0 ? `${cut.hidden} more ${cut.hidden === 1 ? 'panel' : 'panels'}` : 'more'} ${label}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
          {cut.hidden > 0 ? `${cut.hidden} more` : 'More'}
        </button>
      )}
    </div>
  );
}
