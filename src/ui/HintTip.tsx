// The hover hints every `.tip[data-tip]` control carries, drawn by one layer on the page body rather than
// as each control's own ::before, so a scrolling panel doesn't cut them off, and none lies over the label
// beside it. Above the control where there's room, below it where there isn't (the toolbar, the top card),
// always inside the window, wrapping when long. Fades in after a moment's hover (a pointer passing over
// sets nothing flickering), at once when another hint was just showing; keyboard focus shows it too.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const DELAY = 250;
const GAP = 8;
const EDGE = 8;

/** A hint that would only repeat what's already open (the table talk under its button). */
const muted = (el: Element) => el.matches('.chat-btn.on');

/**
 * The bubble as wide as its longest line: a hint that wraps is balanced over its lines, and its box
 * would otherwise keep the full width it was allowed, the lines sitting at its left with a gap beside them.
 */
function fitWidth(b: HTMLElement, text: string) {
  b.style.width = '';
  b.dataset.fit = text;
  const range = document.createRange();
  range.selectNodeContents(b);
  let left = Infinity;
  let right = -Infinity;
  for (const line of range.getClientRects()) {
    left = Math.min(left, line.left);
    right = Math.max(right, line.right);
  }
  if (!(right > left)) return;
  const cs = getComputedStyle(b);
  const sides = cs.boxSizing === 'border-box' ? b.offsetWidth - b.clientWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 0;
  b.style.width = `${Math.ceil(right - left + sides) + 1}px`;
}

export function HintTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let timer = 0;
    let raf = 0;
    let shownAt = 0;
    const place = () => {
      raf = 0;
      const el = target.current;
      if (!el) return;
      if (!el.isConnected || muted(el)) return hide();
      const text = el.dataset.tip;
      if (!text) return hide();
      const r = el.getBoundingClientRect();
      const b = bubble.current;
      if (b && b.dataset.fit !== text) fitWidth(b, text);
      const w = b?.offsetWidth ?? 0;
      const h = b?.offsetHeight ?? 0;
      const below = r.top - GAP - h < EDGE;
      const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), innerWidth - EDGE - w);
      const y = below ? r.bottom + GAP : r.top - GAP - h;
      setTip((t) => (t && t.text === text && t.x === x && t.y === y && t.below === below ? t : { text, x, y, below }));
      // (Followed while it shows: a stack that lifts on hover, a list that scrolls under it.)
      raf = requestAnimationFrame(place);
    };
    const show = (el: HTMLElement, now: boolean) => {
      clearTimeout(timer);
      target.current = el;
      const go = () => {
        shownAt = performance.now();
        cancelAnimationFrame(raf);
        // (Measured once drawn: the first frame places it off-screen, the next where it belongs.)
        setTip({ text: el.dataset.tip ?? '', x: -9999, y: -9999, below: false });
        raf = requestAnimationFrame(place);
      };
      if (now) go();
      else timer = window.setTimeout(go, DELAY);
    };
    function hide() {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      raf = 0;
      target.current = null;
      setTip(null);
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('.tip[data-tip]');
      if (!el || el === target.current || muted(el)) return;
      // (From one hint straight to the next, no wait.)
      show(el, performance.now() - shownAt < 400 && target.current !== null);
    };
    const out = (e: PointerEvent) => {
      const el = target.current;
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('.tip[data-tip]');
      if (el && el.matches(':focus-visible') && !muted(el)) show(el, false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', hide);
    };
  }, []);
  if (!tip) return null;
  // (Decorative: every hinted control already says the same in its accessible name or label.)
  return createPortal(
    <div ref={bubble} className={`hint-tip${tip.below ? ' below' : ''}`} style={{ left: tip.x, top: tip.y }} aria-hidden>
      {tip.text}
    </div>,
    document.body,
  );
}
