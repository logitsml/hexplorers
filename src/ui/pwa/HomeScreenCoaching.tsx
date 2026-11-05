// The Home Screen sheet: how to add the game to an iPhone's or iPad's Home Screen (Share → Add to
// Home Screen → open it from there), each step with a little drawing. iOS has no install prompt,
// and it delivers notifications only to a web app opened from the Home Screen, so this is how a
// player there gets "your move" letters. Shown only when asked for (an Install button, the
// online interface's push card): never by itself on a first visit.

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { EXIT_PANEL, FADE, SPRING_PANEL } from '../motion';
import './pwa.css';

/** Why the sheet is up: to get notifications (push). */
export type CoachReason = 'push';
/** How it was closed: the steps taken in ('done'), or put off ('later': a caller can show them again later). */
export type CoachResult = 'done' | 'later';

const isPad = () => /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** Where Share is in this browser. */
function shareWhere(): string {
  const ua = navigator.userAgent;
  if (/CriOS/.test(ua)) return 'In Chrome it’s in the address bar, at the top right.';
  if (/FxiOS|EdgiOS/.test(ua)) return 'It’s in the browser’s menu.';
  if (isPad()) return 'At the top of Safari, beside the address.';
  return 'In Safari’s toolbar, or in its ••• menu.';
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The sheet itself, for a page that places it (inside an AnimatePresence, as every dialog is);
 * showHomeScreenCoaching() (ui/pwa) puts it up anywhere. A dialog as the game's are (their frame,
 * ModalFrame's Modal, isn't used: it would bring the game's own chunks along with this one): it
 * takes the focus and keeps Tab inside, Escape or a click beside it puts it off, and the focus
 * goes back to a control reached with the keyboard.
 */
export function HomeScreenCoaching({ onClose }: { reason?: CoachReason; onClose: (result: CoachResult) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const present = useIsPresent();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const keyboard = !!opener && opener !== document.body && opener.matches(':focus-visible');
    ref.current?.querySelector<HTMLElement>('.pwa-coach-done')?.focus({ preventScroll: true });
    // While it is up the game's keyboard shortcuts wait (Space would roll the dice behind it), and
    // outside the game's own tree (see layer.tsx) the game's interface is out of reach.
    const keys = (e: KeyboardEvent) => {
      e.stopPropagation();
      const el = ref.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current('later');
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const at = document.activeElement as HTMLElement | null;
        const inside = !!at && items.includes(at);
        if (items.length && (e.shiftKey ? !inside || at === items[0] : !inside || at === items[items.length - 1])) {
          e.preventDefault();
          (e.shiftKey ? items[items.length - 1] : items[0]).focus();
        }
      }
    };
    window.addEventListener('keydown', keys, true);
    const root = document.getElementById('root');
    const outside = !!root && !!ref.current && !root.contains(ref.current) && !root.inert;
    if (outside) root.inert = true;
    return () => {
      window.removeEventListener('keydown', keys, true);
      if (outside) root.inert = false;
      if (keyboard && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const device = isPad() ? 'iPad' : 'iPhone';
  return (
    <>
      <motion.div className="modal-shade" aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1, transition: FADE }} exit={{ opacity: 0, transition: EXIT_PANEL }} />
      {/* (The backdrop doesn't fade: an ancestor's opacity blinds the dialog's backdrop-filter. The shade and the dialog fade.) */}
      <div
        className="modal-backdrop"
        style={{ pointerEvents: present ? 'auto' : 'none' }}
        onMouseDown={(e) => present && e.target === e.currentTarget && close.current('later')}
      >
        <motion.div
          ref={ref}
          tabIndex={-1}
          className="modal parchment pwa-coach"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          style={{ width: 'min(440px, calc((100vw - 32px) / var(--ui-scale, 1)))' }}
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_PANEL }}
          exit={{ opacity: 0, y: 12, scale: 0.98, transition: EXIT_PANEL }}
        >
          <h3 id={titleId}>Add to Home Screen</h3>
          <p className="sub">
            {`On ${device}, letters arrive once Hexplorers is on your Home Screen.`}
          </p>
          <ol className="pwa-steps">
            <li>
              <ShareArt />
              <div>
                <b>Tap Share</b>
                <span>{shareWhere()}</span>
              </div>
            </li>
            <li>
              <AddArt />
              <div>
                <b>Choose Add to Home Screen</b>
                <span>Scroll down the list if it isn’t in view, then tap Add.</span>
              </div>
            </li>
            <li>
              <HomeArt />
              <div>
                <b>Open Hexplorers from your Home Screen</b>
                <span>Then allow notifications when it asks.</span>
              </div>
            </li>
          </ol>
          <div className="footer">
            <button type="button" className="btn ghost" onClick={() => close.current('later')}>
              Not now
            </button>
            <button type="button" className="btn gold pwa-coach-done" onClick={() => close.current('done')}>
              Got it
            </button>
          </div>
        </motion.div>
      </div>
    </>
  );
}

// The drawings: a 56-unit square each, in the interface's ink, the thing to tap in blue with a
// gold ring round it.

const Art = ({ children }: { children: ReactNode }) => (
  <svg className="pwa-art" viewBox="0 0 56 56" width="56" height="56" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

/** A phone's foot, its toolbar's Share button ringed. */
function ShareArt() {
  return (
    <Art>
      <rect className="pa-phone" x="9" y="3" width="38" height="50" rx="7" />
      <path className="pa-faint" d="M15 11h26M15 17h20M15 23h23M15 29h14" />
      <path className="pa-line" d="M9 37.5h38" />
      <path className="pa-line" d="m16.5 42.5-2.5 2.5 2.5 2.5" />
      <circle className="pa-faint" cx="40" cy="45" r="0.6" />
      <circle className="pa-faint" cx="37.5" cy="45" r="0.6" />
      <circle className="pa-faint" cx="42.5" cy="45" r="0.6" />
      <circle className="pa-ring" cx="28" cy="45" r="7" />
      <path className="pa-mark" d="M25.2 44v4.3h5.6V44M28 46v-6.2M25.9 41.7 28 39.6l2.1 2.1" />
    </Art>
  );
}

/** The Share sheet's list, its Add to Home Screen row ringed. */
function AddArt() {
  return (
    <Art>
      <rect className="pa-phone" x="5" y="6" width="46" height="44" rx="7" />
      <rect className="pa-faint" x="10" y="12" width="7" height="7" rx="2" />
      <path className="pa-faint" d="M21 15.5h22" />
      <rect className="pa-hi" x="7.5" y="23" width="41" height="11" rx="3.5" />
      <rect className="pa-mark" x="10" y="24.5" width="8" height="8" rx="2" />
      <path className="pa-mark" d="M14 26.5v4M12 28.5h4" />
      <path className="pa-line" d="M21.5 28.5h20" />
      <rect className="pa-faint" x="10" y="38" width="7" height="7" rx="2" />
      <path className="pa-faint" d="M21 41.5h16" />
    </Art>
  );
}

/** A Home Screen, the game's icon ringed. */
function HomeArt() {
  const cells = [12, 23.5, 35].flatMap((x) => [9, 20.5, 32].map((y) => [x, y] as const)).filter(([x, y]) => !(x === 23.5 && y === 20.5));
  return (
    <Art>
      <rect className="pa-phone" x="7" y="3" width="42" height="50" rx="7" />
      {cells.map(([x, y]) => (
        <rect key={`${x},${y}`} className="pa-faint" x={x} y={y} width="9" height="9" rx="2.4" />
      ))}
      <path className="pa-faint" d="M14 47h28" />
      <circle className="pa-ring" cx="28" cy="25" r="8.5" />
      <rect x="23.5" y="20.5" width="9" height="9" rx="2.4" fill="#1d5995" />
      <polygon points="28,21.6 31,23.3 31,26.7 28,28.4 25,26.7 25,23.3" fill="#2f7d4a" stroke="#f3e2b8" strokeWidth="0.8" />
      <circle cx="28" cy="25" r="1.15" fill="#f3e2b8" />
    </Art>
  );
}
