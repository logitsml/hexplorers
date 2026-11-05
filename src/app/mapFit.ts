// Where the whole board goes on the window, in 3D and as the flat map: the largest part of it that
// the HUD's panels leave free, which the board is fitted to. The panels are found by what they
// mark (`data-hud-obstacle`), measured live: the window as the browser shows it (the visual
// viewport, less the screen's safe areas) and every panel at the biggest it has been, so the map
// stays put as cards come and go, and is laid out again only when the window or the panels change
// enough to matter (a size more than 2% off, or the map no longer inside the free part). The home
// view (render/core/cameraRig.ts) and the flat map (app/viewMode.ts) both take their fit from here.

import { useUI } from '../game/store';
import { ISLAND_FRAMED, type World } from '../render/World';
import { setViewFrame, type ViewFrame } from '../render/core/cameraRig';
import { COMPACT_QUERY } from '../ui/useCompact';
import { harbourRadius } from '../ui/flatArt';
import { session } from './session';
import { area, bottom, emptyRects, fitScale, inflate, intersect, pickCentred, right, union, type Rect } from './freeRect';

/** Room kept clear (px) round every panel. */
const GAP = 12;
/** The hand at its tallest (cards held), at interface size 1 (px): the map is fitted over it so it doesn't move as the hand fills. */
const HAND_TALLEST = 162;
/** The free part under this share of the window isn't worth fitting to: the map takes the whole window, under the HUD. */
const MIN_FREE = 0.3;
/** The size (a fraction of the biggest) a map across the middle of the window may cost, on a phone and elsewhere, to stay there rather than go to a side. */
const MIDDLE_PHONE = 2 / 3;
const MIDDLE = 0.85;
/** The size (a fraction of the biggest free part's) a map centred on the window may cost, before it is moved aside to where there is more room. */
const CENTRED = 0.7;
/** How much of its depth the island keeps on screen in 3D (the home view's pitch foreshortens it): free parts are scored by that shape in both views (so the island is centred or not alike in each, and doesn't jump between them), and a part wide and short isn't thought to cost it more than it does. */
const FORESHORTEN = 0.8;
/** A map must grow this much (a fraction) before it is laid out again; shrinking, it is as soon as it no longer fits. */
const GROW = 0.02;
/** The margin (px) at the most, a harbour's badge at full size: what free parts are scored with before the map's size is known. */
const MARGIN = 20;

/** The marker on the HUD's elements that take room the map keeps clear of (the value names it). */
export const OBSTACLE = 'data-hud-obstacle';

export interface Area {
  /** The window: the box fixed layers fill (the canvas, the flat map), from its own corner. */
  view: Rect;
  /** The window as shown (the visual viewport) less the screen's safe areas: where anything may be put. */
  safe: Rect;
  /** The part of it the map is fitted to: the largest the HUD's panels leave empty (or all of `safe`, if that is little). */
  free: Rect;
  /** Whether so little was free that the map takes all of `safe`, with the HUD over it. */
  covered: boolean;
}

export interface Fit extends Area {
  /** Px per world unit the flat map takes, and the margin (px) it keeps in from `free`'s edges. */
  k: number;
  pad: number;
  /** The board's box in world units: its size and middle. */
  box: { w: number; d: number; x: number; z: number };
}

// ------------------------------------------------------------------ the window

let probe: HTMLElement | null = null;

/**
 * The window and the screen's safe areas, through one fixed element laid out as the canvas and the
 * flat map are (`inset: 0`, so its box is the one they fill, whatever bars the browser shows), padded
 * by the insets, which CSS can give but script can't read directly.
 */
function windowBox(): { view: Rect; inset: { top: number; right: number; bottom: number; left: number } } {
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;box-sizing:border-box;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(probe);
  }
  const r = probe.getBoundingClientRect();
  const cs = getComputedStyle(probe);
  const n = (v: string) => Number.parseFloat(v) || 0;
  // (A window of no size, such as a hidden tab's, still gets a box: otherwise the map is laid out at NaN.)
  const view = { x: 0, y: 0, w: Math.max(1, r.width || window.innerWidth), h: Math.max(1, r.height || window.innerHeight) };
  return { view, inset: { top: n(cs.paddingTop), right: n(cs.paddingRight), bottom: n(cs.paddingBottom), left: n(cs.paddingLeft) } };
}

/** The window as the browser shows it, less the safe areas: the visual viewport (a zoomed page, the keyboard up) within the fixed box. */
function safeBox(view: Rect, inset: { top: number; right: number; bottom: number; left: number }): Rect {
  const vv = window.visualViewport;
  const shown = vv ? intersect(view, { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height }) : view;
  const x = Math.max(shown.x, view.x + inset.left), y = Math.max(shown.y, view.y + inset.top);
  const r = Math.min(right(shown), right(view) - inset.right), b = Math.min(bottom(shown), bottom(view) - inset.bottom);
  return r - x > 1 && b - y > 1 ? { x, y, w: r - x, h: b - y } : shown;
}

// ----------------------------------------------------------------- the panels

/**
 * Where a panel stands at rest: the HUD comes in from its edge on an animation, shifted by its
 * `translate` for the first moments, and that shift is taken off (on the panel and its parents
 * that are coming in) so it is measured where it will be.
 */
function resting(el: Element): Rect {
  const r = el.getBoundingClientRect();
  let dx = 0, dy = 0;
  for (let n: Element | null = el; n && !n.classList.contains('ui-layer'); n = n.parentElement) {
    if (!n.getAnimations().some((a) => (a as CSSAnimation).animationName === 'hud-in')) continue;
    const t = getComputedStyle(n).translate;
    if (!t || t === 'none') continue;
    const [x, y = '0'] = t.split(' ');
    dx += Number.parseFloat(x) || 0;
    dy += Number.parseFloat(y) || 0;
  }
  return { x: r.left - dx, y: r.top - dy, w: r.width, h: r.height };
}

/** Each panel at the biggest it has been since the window last changed shape (by what it marks itself), so what comes and goes doesn't move the map. */
const seen = new Map<string, Rect>();
let epoch = '';

function panels(view: Rect): Rect[] {
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hand-zoom')) || 1;
  const compact = !!document.querySelector('.ui-layer.compact');
  const scale = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim();
  const now = `${Math.round(view.w)}x${Math.round(view.h)} ${compact} ${scale}`;
  if (now !== epoch) {
    epoch = now;
    seen.clear();
  }
  for (const el of document.querySelectorAll(`[${OBSTACLE}]`)) {
    let r = resting(el);
    if (r.w < 1 || r.h < 1) continue;
    const name = el.getAttribute(OBSTACLE) || 'panel';
    if (name === 'hand') {
      const top = Math.min(r.y, bottom(r) - HAND_TALLEST * zoom);
      r = { x: r.x, y: top, w: r.w, h: bottom(r) - top };
    }
    const before = seen.get(name);
    seen.set(name, before ? union(before, r) : r);
  }
  return [...seen.values()];
}

/**
 * The part of the window the board has: the window as shown less the safe areas, less the panels
 * (a gap round each), as the largest empty rectangle, the one that holds a board of `box`
 * (width, depth in world units) biggest. One across the middle of the window is taken over a
 * bigger one off to a side, if it keeps 85% of the size (two thirds on a phone). Better still, the
 * map is centred on the window (the biggest part of a free rectangle that is symmetric about the
 * middle, so a dock in a corner shrinks it evenly rather than pushing it aside) whenever that
 * keeps 70% of the size the best free part gives it. Where none has
 * 30% of the window, the whole of it.
 */
export function measureFree(box = { w: 1, d: 1 }): Area {
  const { view, inset } = windowBox();
  const safe = safeBox(view, inset);
  const compact = !!document.querySelector('.ui-layer.compact');
  const walls = panels(view).map((r) => inflate(r, GAP));
  // (Scored with a margin of about a harbour's badge: the map's own is set once its size is known.)
  // (Only those with room to speak of: a strip tall and thin beside a panel may hold the map a
  // little bigger than the wide part under it, and leave it off in a corner of the window.)
  const roomy = emptyRects(safe, walls).filter((r) => area(r) >= MIN_FREE * area(safe));
  const depth = box.d * FORESHORTEN;
  const pick = pickCentred(roomy, (r) => fitScale(r, box.w, depth, MARGIN), safe.x + safe.w / 2, 0.06 * view.w, compact ? MIDDLE_PHONE : MIDDLE, CENTRED);
  return { view, safe, free: pick ?? safe, covered: !pick };
}

/** The margin (px) the map keeps from the free part's edges: a harbour's badge and a little over, never under 12. */
export const marginFor = (k: number) => Math.max(12, harbourRadius(k) + 6);

// --------------------------------------------------------------------- the map

/**
 * What the map must hold, in world units: the land, the harbours' signs, the fishing grounds' rings
 * (World.frameIsland: and land found in the fog, which frames it again), as a box.
 */
export function mapBounds(world: World | null = session.world) {
  if (!world) return null;
  const b = world.islandBox;
  return { w: b.x1 - b.x0, d: b.z1 - b.z0, x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
}

/** The fit for the board as it is now and the window as it is now. */
export function measureFit(): Fit | null {
  const box = mapBounds();
  if (!box) return null;
  const a = measureFree(box);
  // (The margin follows the size, which follows the margin: twice round settles it.)
  let k = fitScale(a.free, box.w, box.d, MARGIN), pad = MARGIN;
  for (let i = 0; i < 2; i++) {
    pad = marginFor(k);
    k = fitScale(a.free, box.w, box.d, pad);
  }
  return { ...a, k: Math.max(1e-3, k), pad, box };
}

/** Whether the map laid out for `was` would still lie within the free part of `next` (so it needs no moving). */
function stillFits(was: Fit, next: Fit): boolean {
  const w = was.box.w * was.k + 2 * was.pad, h = was.box.d * was.k + 2 * was.pad;
  const x = was.free.x + (was.free.w - w) / 2, y = was.free.y + (was.free.h - h) / 2;
  return x >= next.free.x - 1 && y >= next.free.y - 1 && x + w <= right(next.free) + 1 && y + h <= bottom(next.free) + 1;
}

let applied: Fit | null = null;
let held = false;
let pending = false;
let frame = 0;
const listeners = new Set<(fit: Fit) => void>();

/** The fit as last laid out (what the home view and the flat map are placed by). */
export const current = () => applied;

/** Be told when the fit changes (the flat map is laid out again, in app/viewMode.ts). */
export function onFit(fn: (fit: Fit) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The frame the camera's home view is fitted to. */
export const frameOf = (f: Fit): ViewFrame => ({ w: f.view.w, h: f.view.h, free: f.free, pad: f.pad });

/**
 * Hold the fit still (`true`) while the view changes between 3D and the flat map, which has the
 * camera and the map in step; released, anything asked meanwhile is done.
 */
export function hold(on: boolean) {
  held = on;
  if (!on && pending) request();
}

/** Whether `next` is different enough from the fit laid out (`was`) to lay the map out again. */
function matters(was: Fit | null, next: Fit): boolean {
  if (!was) return true;
  const resized = Math.abs(was.view.w - next.view.w) > 0.5 || Math.abs(was.view.h - next.view.h) > 0.5 || was.covered !== next.covered;
  return resized || !stillFits(was, next) || next.k > was.k * (1 + GROW);
}

/** Measure now, and lay the map out afresh if it matters (or `force`d). */
function run(force = false) {
  frame = 0;
  if (useUI.getState().screen !== 'game' || !session.world) return;
  if (held && !force) {
    pending = true;
    return;
  }
  pending = false;
  const next = measureFit();
  if (!next || (!force && !matters(applied, next))) return;
  applied = next;
  const world = session.world;
  if (useUI.getState().viewMode === '3d') world.rig.refitHome(frameOf(next));
  else setViewFrame(frameOf(next));
  for (const fn of listeners) fn(next);
}

/**
 * The fit as it is now, for a view about to be set up (the flat map's pose): measured afresh, and
 * taken up as the fit if it matters, without moving the camera or telling anyone, since the caller
 * is about to place both.
 */
export function fitNow(): Fit | null {
  const next = measureFit();
  if (next && matters(applied, next)) {
    applied = next;
    setViewFrame(frameOf(next));
  }
  return applied;
}

/** Ask for the fit to be looked at again: next frame, once, however many things changed. */
export function request(force = false) {
  if (force) {
    run(true);
    return;
  }
  if (!frame) frame = requestAnimationFrame(() => run());
}

/** Forget what a game's panels measured (a game left). */
function forget() {
  seen.clear();
  epoch = '';
  applied = null;
  setViewFrame(null);
}

/**
 * Watch for what moves the map: the window and the visual viewport (a phone turned, its bars in
 * or out, the page zoomed), the compact layout, the interface's size, the board's own frame, and
 * the panels themselves (any of them changing size, or a new one appearing).
 */
export function startMapFit(world: World) {
  world.measureHome = () => request(true);
  const ask = () => request();
  window.addEventListener('resize', ask);
  window.addEventListener('orientationchange', ask);
  window.addEventListener(ISLAND_FRAMED, ask);
  window.visualViewport?.addEventListener('resize', ask);
  window.visualViewport?.addEventListener('scroll', ask);
  window.matchMedia(COMPACT_QUERY).addEventListener('change', ask);
  useUI.subscribe((s, p) => {
    if (s.screen !== p.screen) {
      if (s.screen !== 'game') forget();
      ask();
    }
    if (s.settings.uiScale !== p.settings.uiScale) ask();
  });
  // The panels: each one's size is watched, and the page is looked over for new ones when its
  // markup changes (which only asks for a measurement if one came or went).
  const sizes = new ResizeObserver(ask);
  const watched = new Set<Element>();
  const rescan = () => {
    let changed = false;
    const now = new Set(document.querySelectorAll(`[${OBSTACLE}]`));
    for (const el of now) if (!watched.has(el)) (sizes.observe(el), watched.add(el), (changed = true));
    for (const el of watched) if (!now.has(el)) (sizes.unobserve(el), watched.delete(el), (changed = true));
    if (changed) ask();
  };
  new MutationObserver(rescan).observe(document.body, { childList: true, subtree: true });
  rescan();
}
