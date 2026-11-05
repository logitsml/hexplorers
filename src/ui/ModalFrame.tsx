// The dialog frame every dialog shares, and the little pieces several of them use. (Settings, the
// rules and the game's results load on demand: see Modals.tsx.)

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { EXIT_PANEL, PAGE_IN, SPRING_PANEL, SPRING_UI } from './motion';
import { CARDS, RESOURCES, totalCards, type Card, type CardCounts } from '../engine';
import { useUI } from '../game/store';
import { CARD_ICON, CARD_NAMES, asset } from '../game/names';
import { LineIcon, type LineIconName } from './LineIcons';

/**
 * What last had the focus outside the dialogs, and when it lost it. Opening a dialog makes what is
 * behind it inert, which takes the focus off its opener (to the page) in the same commit, often
 * before the dialog itself has drawn (those loaded on demand wait a frame in Suspense): so the
 * opener is found here, if it lost the focus just now.
 */
let outside: { el: HTMLElement; keyboard: boolean; lostAt: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && !t.closest('.modal')) outside = { el: t, keyboard: t.matches(':focus-visible'), lostAt: Infinity };
  });
  document.addEventListener('focusout', (e) => {
    if (outside && e.target === outside.el) outside.lostAt = performance.now();
  });
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * A real modal: named by its heading, takes focus, keeps Tab inside it (and the quality note's
 * Undo, which sits over it) and makes what is behind it inert. The HUD is released the moment the
 * dialog starts closing (not after its exit animation), and from then on it answers no keys, so
 * its Escape can't close the dialog that opens in its place. Focus goes back to the opener only
 * if it was reached with the keyboard; after a mouse click it is dropped, so Space and Enter go
 * back to rolling and ending the turn. `initialFocus`: a selector for what takes the focus first.
 */
export function Modal({ children, onClose, width, initialFocus }: { children: ReactNode; onClose?: () => void; width?: number; initialFocus?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const present = useIsPresent();
  const live = useRef(present);
  live.current = present;
  const closer = useRef(onClose);
  closer.current = onClose;
  useEffect(() => {
    const trap = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE), ...document.querySelectorAll<HTMLElement>('.quality-toast button')].filter((x) => x.getClientRects().length > 0);
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const at = document.activeElement as HTMLElement | null;
      const inside = !!at && items.includes(at);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey ? !inside || at === first : !inside || at === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    const k = (e: KeyboardEvent) => {
      if (!live.current) return;
      if (e.key === 'Escape' && closer.current) {
        e.preventDefault();
        closer.current();
      } else if (e.key === 'Tab') trap(e);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  // The opener is read as the dialog first renders (see `outside`): read in an effect, it would
  // always be the page, and Escape would leave the focus there rather than on the button that opened it.
  const [from] = useState(() => {
    const prev = document.activeElement as HTMLElement | null;
    if (prev && prev !== document.body) return { el: prev, keyboard: prev.matches(':focus-visible') };
    const o = outside && performance.now() - outside.lostAt < 600 ? outside : null;
    return { el: o?.el ?? null, keyboard: !!o?.keyboard };
  });
  const opener = useRef(from);
  const released = useRef(false);
  const release = () => {
    if (released.current) return;
    released.current = true;
    const { el, keyboard } = opener.current;
    if (keyboard && el?.isConnected && !el.closest('[inert]')) el.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement && ref.current?.contains(document.activeElement)) document.activeElement.blur();
  };
  useEffect(() => {
    const el = ref.current;
    const h = el?.querySelector('h3');
    if (el && h) {
      if (!h.id) h.id = titleId;
      el.setAttribute('aria-labelledby', h.id);
    }
    const first = initialFocus ? el?.querySelector<HTMLElement>(initialFocus) : null;
    (first ?? el)?.focus({ preventScroll: true });
    return release;
  }, [titleId]);
  useEffect(() => {
    if (!present) release();
  }, [present]);
  return (
    // (The backdrop itself never fades: an ancestor's opacity blinds the dialog's backdrop-filter, so
    // it would show as clear glass until the fade was over. The shade behind fades, see Modals, and the
    // dialog fades itself.)
    <div
      className="modal-backdrop"
      style={{ pointerEvents: present ? 'auto' : 'none' }}
      onMouseDown={(e) => present && e.target === e.currentTarget && onClose?.()}
    >
      <motion.div
        ref={ref}
        tabIndex={-1}
        className="modal parchment"
        style={width ? { width: `min(${width}px, calc((100vw - 32px) / var(--ui-scale, 1)))` } : undefined}
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_PANEL }}
        exit={{ opacity: 0, y: 12, scale: 0.98, transition: EXIT_PANEL }}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </motion.div>
    </div>
  );
}

export const close = () => useUI.getState().set({ modal: null });

/** Settings or the rules opened from the phone's Menu go back to it when closed (see MenuModal). */
let backToMenu = false;
/** The Menu's row that opened them, which takes the focus again on the way back. */
let menuRow: string | null = null;

export function openFromMenu(modal: 'rules' | 'settings') {
  backToMenu = true;
  menuRow = modal;
  useUI.getState().set({ modal });
}

/** Close Settings or the rules: back to the Menu if that is where they came from. */
export function closeBack() {
  const st = useUI.getState();
  const back = backToMenu && st.screen === 'game';
  backToMenu = false;
  st.set({ modal: back ? 'menu' : null });
}

/** The way back is only for a dialog opened from the Menu (any other change forgets it). */
export function forgetMenu(modal: string | null) {
  if (modal !== 'rules' && modal !== 'settings') backToMenu = false;
}

/** The Menu row to focus as the Menu opens again (once). */
export function takeMenuRow() {
  const r = menuRow;
  menuRow = null;
  return r;
}

export const MinusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
    <path d="M5 12h14" />
  </svg>
);

export const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** Resource cards as small chips: an icon and a count each. */
export function ResChips({ rc }: { rc: CardCounts }) {
  return (
    <span className="res-chips">
      {CARDS.filter((r) => rc[r] > 0).map((r) => (
        <span key={r} className="chip" title={CARD_NAMES[r]}>
          <img src={asset(CARD_ICON[r])} alt={CARD_NAMES[r]} /> {rc[r]}
        </span>
      ))}
    </span>
  );
}

/**
 * Cards chosen by kind, each counted up and down: the trades' rows and the discards'. `max`: how
 * many there are of each (shown under it, after `have`: "they have" for another's hand). `limit`:
 * most cards that may be picked in total (the discard). `tone`: what the row is for, coloured the
 * same everywhere: cards going out (give) warm, cards coming in (get) green.
 */
export function ResPicker({ value, onChange, max, label, disabled, limit, tone = 'give', kinds = RESOURCES, have = 'have' }: { value: CardCounts; onChange: (v: CardCounts) => void; max?: CardCounts; label?: string; disabled?: (r: Card) => boolean; limit?: number; tone?: 'give' | 'get'; kinds?: readonly Card[]; have?: string }) {
  const full = limit !== undefined && totalCards(value) >= limit;
  return (
    <div className={`trade-row ${tone}`} role="group" aria-label={label}>
      <div className="lbl" aria-hidden>
        {label}
      </div>
      <div className="res-cells">
        {kinds.map((r) => {
          const dis = disabled?.(r) ?? false;
          const cap = max ? max[r] : 19;
          return (
            <div key={r} className={`res-pick ${value[r] > 0 ? 'on' : ''} ${dis ? 'disabled' : ''}`}>
              <button type="button" className="res-pick-add" aria-label={`Add ${CARD_NAMES[r]} (${value[r]} chosen)`} disabled={dis || full || value[r] >= cap} onClick={() => onChange({ ...value, [r]: value[r] + 1 })}>
                <img src={asset(CARD_ICON[r])} alt="" draggable={false} />
              </button>
              <div className="qty">
                <button type="button" aria-label={`Fewer ${CARD_NAMES[r]}`} disabled={dis || value[r] === 0} onClick={() => onChange({ ...value, [r]: Math.max(0, value[r] - 1) })}>
                  <MinusIcon />
                </button>
                {/* (Keyed by the count, so each change gives it a little bump.) */}
                <span key={value[r]} className={value[r] ? 'n bump' : 'n'} aria-hidden>
                  {value[r]}
                </span>
                <button type="button" aria-label={`More ${CARD_NAMES[r]}`} disabled={dis || full || value[r] >= cap} onClick={() => onChange({ ...value, [r]: value[r] + 1 })}>
                  <PlusIcon />
                </button>
              </div>
              {max && <div className="have">{have} {max[r]}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A tab's panel (or a page within one), keyed by `page`: the old one goes and the new comes in
 * from a little below, and the dialog goes back to its top, so a new tab or page never opens
 * halfway down (where the last one was left scrolled) with its title out of sight.
 */
export function TabPanel({ page, idBase, tab, className, children }: { page: string; idBase?: string; tab?: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.closest('.modal')?.scrollTo({ top: 0 });
  }, [page]);
  const panel = idBase ? { role: 'tabpanel', id: `${idBase}-panel`, 'aria-labelledby': `${idBase}-tab-${tab}` } : {};
  return (
    <div ref={ref} className={className} {...panel}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={page} className="tab-page" {...PAGE_IN}>
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** Tabs (the ARIA pattern: arrow keys move between them, the panel follows). */
export function Tabs<T extends string>({ items, value, onChange, label, idBase }: { items: { id: T; label: string; icon: LineIconName }[]; value: T; onChange: (t: T) => void; label: string; idBase: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const key = (e: React.KeyboardEvent, i: number) => {
    const n = items.length;
    const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    onChange(items[j].id);
    refs.current[j]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((it, i) => (
        <button
          key={it.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${it.id}`}
          aria-selected={value === it.id}
          aria-controls={`${idBase}-panel`}
          tabIndex={value === it.id ? 0 : -1}
          className={value === it.id ? 'on' : ''}
          onClick={() => onChange(it.id)}
          onKeyDown={(e) => key(e, i)}
        >
          {value === it.id && <motion.span layoutId={`${idBase}-pill`} className="tab-pill" transition={SPRING_UI} />}
          <LineIcon name={it.icon} size={20} />
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
