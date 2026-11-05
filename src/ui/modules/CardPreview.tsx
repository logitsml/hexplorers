// The expansions' paintings at the size the HUD shows them and at a size you can see. A thumbnail
// is cropped to its subject (a focal point and a zoom for each painting, picked by eye from the
// full-size art: at 40 px the whole of a crowded market scene is a brown-blue texture, while the
// merchant on his sacks still reads), and hovering, focusing or long-pressing one opens the card
// itself beside it, the painting whole with its name and its rule under it.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { VentureId } from '../../engine/modules/guilds/types';
import type { Happening } from '../../engine/modules/almanac/types';
import { HAPPENING_ART, VENTURE_ART, asset } from '../../game/names';

/** Where a painting's subject is (fractions of its width and height) and how far to zoom in on it for a thumbnail. */
export interface Focus {
  x: number;
  y: number;
  z: number;
}

/** The ventures' subjects (portrait paintings, 2:3). */
const VENTURE_FOCUS: Record<VentureId, Focus> = {
  agitators: { x: 0.4, y: 0.28, z: 1.6 },
  augury: { x: 0.45, y: 0.38, z: 1.4 },
  barter: { x: 0.5, y: 0.47, z: 1.5 },
  cartel: { x: 0.5, y: 0.5, z: 1.5 },
  charterFleet: { x: 0.5, y: 0.47, z: 1.3 },
  cornerMarket: { x: 0.5, y: 0.28, z: 1.6 },
  deepSeams: { x: 0.55, y: 0.52, z: 1.5 },
  dowry: { x: 0.38, y: 0.52, z: 1.5 },
  encyclopaedia: { x: 0.42, y: 0.45, z: 1.4 },
  forge: { x: 0.45, y: 0.48, z: 1.5 },
  grandCharter: { x: 0.45, y: 0.6, z: 1.5 },
  hoist: { x: 0.45, y: 0.45, z: 1.3 },
  masonry: { x: 0.5, y: 0.42, z: 1.4 },
  pathfinders: { x: 0.45, y: 0.42, z: 1.4 },
  rally: { x: 0.4, y: 0.3, z: 1.5 },
  resurvey: { x: 0.42, y: 0.38, z: 1.5 },
  rightOfWay: { x: 0.4, y: 0.45, z: 1.4 },
  spymaster: { x: 0.42, y: 0.36, z: 1.5 },
  taxCollectors: { x: 0.45, y: 0.47, z: 1.3 },
  townPlanning: { x: 0.42, y: 0.55, z: 1.4 },
  trader: { x: 0.5, y: 0.42, z: 1.4 },
  treachery: { x: 0.5, y: 0.4, z: 1.4 },
  tribute: { x: 0.42, y: 0.38, z: 1.5 },
  unrest: { x: 0.5, y: 0.47, z: 1.4 },
  waterworks: { x: 0.5, y: 0.45, z: 1.2 },
  // (The newer ventures borrow older paintings, so they borrow their crops.)
  salvage: { x: 0.55, y: 0.52, z: 1.5 },
  pilot: { x: 0.45, y: 0.42, z: 1.4 },
  tradeWind: { x: 0.5, y: 0.47, z: 1.3 },
  customs: { x: 0.5, y: 0.5, z: 1.5 },
  stockpile: { x: 0.5, y: 0.28, z: 1.6 },
  lighthouse: { x: 0.5, y: 0.42, z: 1.4 },
};

/** The happenings' subjects (square paintings). */
const HAPPENING_FOCUS: Record<Happening, Focus> = {
  calmSeas: { x: 0.6, y: 0.45, z: 1.3 },
  fairDay: { x: 0.5, y: 0.6, z: 1.5 },
  gifts: { x: 0.55, y: 0.45, z: 1.5 },
  harvest: { x: 0.5, y: 0.5, z: 1.4 },
  helpingHand: { x: 0.45, y: 0.45, z: 1.5 },
  quake: { x: 0.4, y: 0.42, z: 1.4 },
  quarrel: { x: 0.45, y: 0.55, z: 1.5 },
  robberFlees: { x: 0.55, y: 0.45, z: 1.6 },
  sickness: { x: 0.55, y: 0.5, z: 1.5 },
  thieves: { x: 0.45, y: 0.5, z: 1.5 },
  tournament: { x: 0.45, y: 0.6, z: 1.5 },
  windfall: { x: 0.45, y: 0.5, z: 1.5 },
};

/** A painting: its file, its shape (width over height) and its subject. */
export interface Painting {
  src: string;
  aspect: number;
  focus: Focus;
}

export const venturePainting = (id: VentureId): Painting => ({ src: VENTURE_ART[id], aspect: 2 / 3, focus: VENTURE_FOCUS[id] });
export const happeningPainting = (id: Happening): Painting => ({ src: HAPPENING_ART[id], aspect: 1, focus: HAPPENING_FOCUS[id] });

/**
 * A painting cropped to a `w`×`h` box around its subject: scaled to cover the box, zoomed in by its
 * focus, and moved so the subject sits in the middle as far as the painting's edges allow.
 */
export function ArtCrop({ art, w, h, className = '' }: { art: Painting; w: number; h: number; className?: string }) {
  const { aspect, focus } = art;
  const W = Math.max(w, h * aspect) * focus.z;
  const H = W / aspect;
  const left = Math.min(0, Math.max(w - W, w / 2 - focus.x * W));
  const top = Math.min(0, Math.max(h - H, h / 2 - focus.y * H));
  return (
    <span className={`art-crop ${className}`} style={{ width: w, height: h }} aria-hidden>
      <img src={asset(art.src)} alt="" draggable={false} loading="lazy" style={{ width: W, height: H, left, top }} />
    </span>
  );
}

/** What a preview shows: the painting whole, the card's name, a line on what kind of card it is, and its rule. */
export interface PreviewCard {
  art: Painting;
  name: string;
  kicker?: string;
  text?: string;
  /** The card's colour (a guild's), for the ribbon's edge. */
  tone?: string;
}

/** The card-sized preview's width, in the HUD's own pixels. */
const PREVIEW_W = 184;

/**
 * The preview, beside its anchor: to the right where there's room (the left column), else to the
 * left (the right rail), else below or above; or (`below`, for what hangs from the top edge, the
 * Almanac's chip) below first.
 */
function Floating({ card, rect, below }: { card: PreviewCard; rect: DOMRect; below: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The HUD is zoomed to the interface size: measure on screen, move in its own units.
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const { width: w, height: h } = el.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight, m = 8, gap = 12;
    let x: number, y: number;
    if (below && rect.bottom + gap + h <= H - m) [x, y] = [rect.left, rect.bottom + gap];
    else if (rect.right + gap + w <= W - m) [x, y] = [rect.right + gap, rect.top];
    else if (rect.left - gap - w >= m) [x, y] = [rect.left - gap - w, rect.top];
    else if (rect.bottom + gap + h <= H - m) [x, y] = [rect.left + rect.width / 2 - w / 2, rect.bottom + gap];
    else [x, y] = [rect.left + rect.width / 2 - w / 2, rect.top - gap - h];
    x = Math.min(W - w - m, Math.max(m, x));
    y = Math.min(H - h - m, Math.max(m, y));
    el.style.transform = `translate(${x / zoom}px, ${y / zoom}px)`;
    el.style.visibility = 'visible';
  });
  return (
    <div ref={ref} className="card-preview parchment" style={{ width: PREVIEW_W, ['--tone' as string]: card.tone } as CSSProperties} aria-hidden>
      <img className="cp-art" src={asset(card.art.src)} alt="" draggable={false} style={{ height: PREVIEW_W / card.art.aspect }} />
      <div className="cp-ribbon">{card.name}</div>
      {card.kicker && <div className="cp-kicker">{card.kicker}</div>}
      {card.text && <p className="cp-text">{card.text}</p>}
    </div>
  );
}

/** How long a finger rests on a card before its preview opens. */
const HOLD_MS = 420;

/**
 * A card's preview for the element that carries it: the props to spread on that element (a
 * mouse over it, keyboard focus inside it, or a finger held on it opens the preview) and the
 * preview to render. A held finger's preview closes as it lifts, and that lift doesn't count as
 * a tap on whatever was under it. The preview is drawn in the HUD's own layer (so it takes the
 * interface's zoom) and says nothing to a screen reader, which already has the card's words.
 */
export function useCardPreview(card: PreviewCard | null, { below = false }: { below?: boolean } = {}): [Record<string, unknown>, ReactNode] {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  const held = useRef(false);
  const show = (el: HTMLElement) => {
    anchor.current = el;
    setRect(el.getBoundingClientRect());
  };
  const hide = () => setRect(null);
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => cancelHold, []);
  // (A preview open while the HUD moves under it, by a scroll or a resize, would point at nothing.)
  useEffect(() => {
    if (!rect) return;
    const close = () => setRect(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [rect]);
  const props = {
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => e.pointerType === 'mouse' && show(e.currentTarget),
    onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => e.pointerType === 'mouse' && hide(),
    onFocus: (e: FocusEvent<HTMLElement>) => (e.target as HTMLElement).matches(':focus-visible') && show(e.currentTarget),
    onBlur: hide,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse') return;
      const el = e.currentTarget;
      cancelHold();
      held.current = false;
      hold.current = {
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          held.current = true;
          show(el);
        }, HOLD_MS),
      };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const h = hold.current;
      if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) cancelHold();
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse') return;
      cancelHold();
      if (held.current) hide();
    },
    onPointerCancel: () => {
      cancelHold();
      if (held.current) hide();
    },
    onContextMenu: (e: Event) => held.current && e.preventDefault(),
    onClickCapture: (e: Event) => {
      if (!held.current) return;
      held.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
  const layer = anchor.current?.closest('.ui-layer') ?? document.body;
  return [props, rect && card ? createPortal(<Floating card={card} rect={rect} below={below} />, layer) : null];
}
