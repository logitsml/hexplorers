// The board as a 3D island or a flat 2D map (the 2D/3D switch, or V). Going flat, the camera
// turns north-up and rises straight overhead in a dolly zoom: the lens narrows as it backs away,
// keeping the island's size on screen, so the perspective melts into a map. As it arrives, the flat
// map (ui/FlatBoard.tsx), laid exactly over it, fades in (one layer, by opacity alone), and the 3D
// view is left to draw only now and then, so its canvas always holds a current frame. Going back,
// the island is drawn at full rate again and shown on screen before the map fades out over it, and
// the camera comes back down to where it was. The choice is remembered.
//
// Where the map goes is app/mapFit.ts's: the whole board, in the part of the window the HUD leaves
// free. This file turns that fit into a camera pose and a layout for the map, and lays both out
// again, in step, when the fit changes.
//
// The map can be zoomed and panned (app/flatZoom.ts; ui/FlatBoard.tsx reads the fingers and the
// wheel). That is part of the flat pose itself, a zoom that dollies the camera in and a pan that
// moves the point it looks at, so the map's layout and the camera are always the same picture.
// While a gesture is under way the map just wears a CSS transform (redrawing its many elements
// every frame would stutter); the pose and the layout are brought up to it when it ends.

import * as THREE from 'three/webgpu';
import { flushSync } from 'react-dom';
import { useUI } from '../game/store';
import { session } from './session';
import { reducedMotion } from './display';
import { homePose, type CameraPose } from '../render/core/cameraRig';
import { titleView } from '../render/World';
import { current as currentFit, fitNow, hold, onFit, type Fit } from './mapFit';
import { FIT_CAM, between, clampCam, panBy, sameCam, zoomAbout, type FlatCam } from './flatZoom';

type ViewMode = '3d' | '2d';

const KEY = 'exploratory.view';
/** The flat view's lens (degrees): narrow enough that the island draws as a map. */
const FLAT_FOV = 4;
/** The flight overhead and back (s); the map's fade in and back out (ms, as in ui.css). */
const FLY = 1.3;
const FADE = 250;
/** How far through the flight overhead the map starts to fade in: the camera has nearly arrived (an eased flight is 97% of the way at 0.8). */
const FADE_AT = 0.8;
/** How long the map takes to slide to a new fit (ms). */
const GLIDE = 280;

/** Where the player was looking before going flat (to come back to), and whether that was home. */
let saved: CameraPose | null = null;
let savedHome = false;
/** How the flat map is zoomed and panned now (as laid out), and where a gesture or a glide has taken it to, if it is under way. */
let cam: FlatCam = FIT_CAM;
let live: FlatCam | null = null;
/** The glide that is taking the map to `live` (its animations), if there is one. */
let glide: { anims: Animation[]; token: number } | null = null;
/** Counts changes of view: a newer one takes over from one still under way. */
let run = 0;

export function rememberedView(): ViewMode {
  try {
    return localStorage.getItem(KEY) === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
}

function remember(m: ViewMode) {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* storage unavailable */
  }
}

/** The way back down: from rest, but under way at once (the map has just gone), landing gently. */
const backDown = (t: number) => 1 - Math.pow(1 - t, 2.5) * (1 + 2.5 * t);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Until the camera's flight has got `p` of the way (or ended): the map follows the flight itself. */
const flown = (p: number) =>
  new Promise<void>((resolve) => {
    const check = () => {
      const f = session.world?.rig.flightProgress;
      if (f === null || f === undefined || f >= p) resolve();
      else requestAnimationFrame(check);
    };
    check();
  });
const frames = (n: number) => new Promise<void>((r) => {
  const step = () => (--n <= 0 ? r() : requestAnimationFrame(step));
  requestAnimationFrame(step);
});

/**
 * Straight overhead, north up, the board filling the free part of the window (app/mapFit.ts): the
 * bounding box of its land, harbours and fishing grounds fitted by each dimension and centred
 * there. (A circle round it fitted the shorter side: a wide archipelago in a wide window came
 * out about a third too small, and a landscape phone's map smaller still.) Zoomed, the camera is
 * that much nearer, over the point the pan has brought to the middle of the free part.
 */
function flatPose(fit: Fit): CameraPose {
  const w = session.world!;
  const tanH = Math.tan((FLAT_FOV * Math.PI) / 360);
  const distance = fit.view.h / (2 * tanH * fit.k);
  const yaw = w.rig.pose.yaw - Math.atan2(Math.sin(w.rig.pose.yaw), Math.cos(w.rig.pose.yaw));
  return {
    target: new THREE.Vector3(fit.box.x + cam.x, 0, fit.box.z + cam.z),
    distance: distance / cam.zoom,
    pitch: Math.PI / 2 - 0.0008,
    yaw,
    fov: FLAT_FOV,
    shiftX: fit.free.x + fit.free.w / 2 - fit.view.w / 2,
    shiftY: fit.free.y + fit.free.h / 2 - fit.view.h / 2,
  };
}

/** The flat map's placement for a pose: the point it looks at, where that is on screen, and px per world unit. */
function layoutOf(p: CameraPose, fit: Fit): NonNullable<ReturnType<typeof useUI.getState>['flatLayout']> {
  const { w, h } = fit.view;
  const k = h / 2 / (p.distance * Math.tan(((p.fov ?? 36) * Math.PI) / 360));
  return { cx: w / 2 + (p.shiftX ?? 0), cy: h / 2 + (p.shiftY ?? 0), k, wx: p.target.x, wz: p.target.z, w, h, free: fit.free, safe: fit.safe };
}

export function toggleView() {
  void setViewMode(useUI.getState().viewMode === '2d' ? '3d' : '2d');
}

export async function setViewMode(to: ViewMode, instant = false) {
  const w = session.world;
  const store = useUI.getState();
  // (Not while the island is still rising or sinking: those flights own the camera.)
  if (!w || store.screen !== 'game' || session.introducing) return;
  if (store.viewMode === to && !instant) return;
  const id = ++run;
  const still = () => id === run;
  remember(to);
  const quick = instant || reducedMotion();
  // (The fit is left alone while the view changes: the camera and the map are both placed by the
  // change. A newer change takes the hold over; the last one lets it go, and what was asked meanwhile is done.)
  hold(true);
  try {
    await change(to, quick, still, w, store);
  } finally {
    if (still()) hold(false);
  }
}

/**
 * Until the map has finished fading (its opacity transition ends), or a little after its time if
 * no end comes (a tab in the background doesn't run its transitions).
 */
function faded(): Promise<void> {
  return new Promise((resolve) => {
    const el = document.querySelector('.flat-board');
    const end = (e: Event) => {
      if (e.target === el && (e as TransitionEvent).propertyName === 'opacity') done();
    };
    const done = () => {
      clearTimeout(timer);
      el?.removeEventListener('transitionend', end);
      resolve();
    };
    const timer = setTimeout(done, FADE + 200);
    el?.addEventListener('transitionend', end);
  });
}

async function change(to: ViewMode, quick: boolean, still: () => boolean, w: NonNullable<typeof session.world>, store: ReturnType<typeof useUI.getState>) {
  const set = useUI.getState().set;
  if (to === '2d') {
    // Coming from the island (not from a change back that was still under way): remember the view.
    if (saved === null) {
      savedHome = w.rig.atHome();
      saved = w.rig.snapshot();
    }
    w.rig.locked = true;
    // (Always from the whole board.)
    cam = FIT_CAM;
    live = null;
    // (Drawn at its full rate while the map comes in over it: it is only let rest once the map is whole.)
    w.coarse = false;
    const fit = fitNow()!;
    const pose = flatPose(fit);
    // The map is mounted at a hair's opacity (laid out and painted) while the camera rises, so it
    // is ready to fade in on arrival.
    store.set({ viewMode: '2d', flatLayout: layoutOf(pose, fit), boardFocus: null, flatPhase: store.flatPhase === 'shown' ? 'shown' : 'pre' });
    if (quick) {
      // (A dissolve with no flight: the map comes up over the island as it is, and the camera moves under it.)
      await frames(2);
      if (!still()) return;
      set({ flatPhase: 'in' });
      await faded();
      if (!still()) return;
      w.rig.jumpTo(pose);
    } else {
      const flight = w.rig.flyTo(pose, FLY, true);
      // The map fades in as the camera arrives (where it has least still to move).
      await flown(FADE_AT);
      if (!still()) return;
      set({ flatPhase: 'in' });
      await Promise.all([flight, faded()]);
    }
    if (!still()) return;
    set({ flatPhase: 'shown' });
    // The map is the whole picture now: the island under it is drawn only now and then, so the
    // canvas holds a current frame for the way back, whatever the page does meanwhile.
    w.coarse = true;
  } else {
    // Whatever zoom the map was at is made the camera's before anything else: the island is drawn
    // at the very pose the map was laid out for, whatever a gesture was doing a moment ago.
    settleFlat();
    // (And the camera put back on that pose, should anything have nudged it while the map was up.
    // Only once the map was whole: a change back during the flight up flies back from where it is.)
    const fit = currentFit();
    if (fit && useUI.getState().flatPhase === 'shown') w.rig.jumpTo(flatPose(fit));
    // The island at its full rate again under the map (at the very pose the map was laid out for).
    w.coarse = false;
    store.set({ viewMode: '3d' });
    // (The home view as the fit is now, if that is where the player left it.)
    fitNow();
    const back = savedHome || saved === null ? homePose() : saved;
    // A dissolve with no flight puts the camera at the end of it first, unseen under the map.
    if (quick) w.rig.jumpTo(back);
    // The map goes only once the island is on screen: the GPU done with what it was given and a
    // couple of frames shown (WebKit holds back the first frame of a canvas that has rested).
    await w.stage.submitted();
    await frames(2);
    if (!still()) return;
    set({ flatPhase: 'out' });
    const gone = faded();
    if (quick) {
      await gone;
    } else {
      // The camera sets off once the map's fade is past half (its first moments barely move it,
      // so the island stays registered with what's left of the map).
      await wait(FADE * 0.55);
      if (!still()) return;
      const flight = w.rig.flyTo(back, FLY, true, backDown);
      await gone;
      if (!still()) return;
      set({ flatPhase: null, flatLayout: null });
      await flight;
    }
    if (!still()) return;
    set({ flatPhase: null, flatLayout: null });
    w.rig.locked = false;
    saved = null;
  }
}

/** Back to the island at once (leaving a game for the title, which shows it in 3D). */
export function resetView() {
  run++;
  hold(false);
  const w = session.world;
  if (w) {
    w.drawEnabled = true;
    w.coarse = false;
    w.rig.locked = false;
    // Out of the flat lens with the island left where it is on screen: the same framing through
    // the usual lens (from overhead the two look alike), for the flights that follow.
    const p = w.rig.pose;
    if ((p.fov ?? 36) !== 36) {
      const t0 = Math.tan(((p.fov ?? 36) * Math.PI) / 360), t1 = Math.tan((36 * Math.PI) / 360);
      w.rig.jumpTo({ target: p.target.clone(), distance: (p.distance * t0) / t1, pitch: p.pitch, yaw: p.yaw, fov: 36, shiftX: p.shiftX, shiftY: p.shiftY });
    }
  }
  saved = null;
  cam = FIT_CAM;
  live = null;
  glide = null;
  useUI.getState().set({ viewMode: '3d', flatPhase: null, flatLayout: null, boardFocus: null });
}

// The fit changed (a phone turned, the HUD's panels grew, land turned up in the fog): the flat map
// is laid out again, and the camera above it moved to match (for the cards that fly from the board,
// and the way back). The map slides to its new place rather than jumping; 3D's home view is moved
// by the camera itself (mapFit).
let gliding = false;
let latest: Fit | null = null;
onFit((fit) => {
  latest = fit;
  const s = useUI.getState();
  if (s.viewMode !== '2d' || !s.flatLayout || !session.world || gliding) return;
  void relayout();
});

async function relayout() {
  const fit = latest;
  const s = useUI.getState();
  const w = session.world;
  if (!fit || !w || !s.flatLayout) return;
  // (A gesture still under way is taken up first, so the map slides from where it is shown.)
  settleFlat();
  const was = useUI.getState().flatLayout!;
  // (The zoom and pan stay, kept within what the new board and window allow.)
  cam = clampCam(cam, fit.box);
  const pose = flatPose(fit);
  const next = layoutOf(pose, fit);
  w.rig.jumpTo(pose);
  const boards = reducedMotion() ? [] : [...document.querySelectorAll<HTMLElement>('.flat-board > .flat-svg')];
  if (!boards.length || was.w !== next.w || was.h !== next.h) {
    s.set({ flatLayout: next });
    return;
  }
  // The map as laid out stays, and slides and scales to where the new layout puts it (every
  // point from its old place to its new one: a scale about the old middle, and a shift); then
  // the new layout is drawn in its place, in the same frame the slide is taken off.
  gliding = true;
  const k = next.k / was.k;
  const tx = next.cx - k * was.cx + (was.wx - next.wx) * next.k, ty = next.cy - k * was.cy + (was.wz - next.wz) * next.k;
  const slides = boards.map((el) => el.animate([{ transform: 'none' }, { transform: `translate(${tx}px, ${ty}px) scale(${k})` }], { duration: GLIDE, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' }));
  for (const el of boards) el.style.transformOrigin = '0 0';
  await Promise.all(slides.map((a) => a.finished.catch(() => {})));
  flushSync(() => useUI.getState().set({ flatLayout: next }));
  for (const a of slides) a.cancel();
  for (const el of boards) el.style.transformOrigin = '';
  gliding = false;
  // (Another change came in while it slid: that one, now.)
  if (latest !== fit && useUI.getState().viewMode === '2d') void relayout();
}

// ------------------------------------------------------------------ zoom and pan

/** Whether the map can be zoomed and panned now: it is settled on screen, and nothing is moving it. */
export function flatZoomable(): boolean {
  const s = useUI.getState();
  return s.viewMode === '2d' && s.flatPhase === 'shown' && !!s.flatLayout && !gliding && !!session.world && !!currentFit();
}

/**
 * The map as laid out, for working out a gesture: its zoom and pan as committed, px per world unit
 * at zoom 1, and where the point it is centred on is on screen.
 */
export function flatView(): { cam: FlatCam; k0: number; centre: { x: number; y: number } } | null {
  const L = useUI.getState().flatLayout;
  if (!L || !flatZoomable()) return null;
  return { cam, k0: L.k / cam.zoom, centre: { x: L.cx, y: L.cy } };
}

/** The elements that make up the map's drawing (the dice stay at the middle, where the layout leaves them). */
const mapLayers = () => [...document.querySelectorAll<HTMLElement>('.flat-board > .flat-svg')];

const wearing = (t: { s: number; tx: number; ty: number }) => `translate(${t.tx}px, ${t.ty}px) scale(${t.s})`;

/** Dress the map in a transform (or take it off, with null). */
function wear(t: { s: number; tx: number; ty: number } | null) {
  for (const el of mapLayers()) {
    el.style.transformOrigin = t ? '0 0' : '';
    el.style.transform = t ? wearing(t) : '';
    el.style.willChange = t ? 'transform' : '';
  }
}

/**
 * Show the map at `next` (clamped) without redrawing it: it wears the transform that takes the
 * layout as drawn there. The pose and the layout follow when the gesture is over (settleFlat).
 */
export function previewFlat(next: FlatCam) {
  const v = flatView();
  const fit = currentFit();
  if (!v || !fit) return;
  stopGlide();
  live = clampCam(next, fit.box);
  wear(sameCam(live, cam) ? null : between(cam, live, v.centre, v.k0));
}

function stopGlide() {
  if (!glide) return;
  for (const a of glide.anims) a.cancel();
  glide = null;
}

/**
 * Bring the camera and the map's layout up to where a gesture or a glide has taken the map: the
 * flat pose is made, the camera set to it, and the layout drawn in the same frame the transform
 * comes off. Done at once when the view changes, so the island is under the map exactly.
 */
export function settleFlat() {
  const fit = currentFit();
  const w = session.world;
  if (!live || !fit || !w) {
    live = null;
    stopGlide();
    wear(null);
    return;
  }
  const next = clampCam(live, fit.box);
  live = null;
  // (A drag that came to nothing, at the fit where there is nowhere to pan to: no redrawing.)
  if (sameCam(next, cam)) {
    stopGlide();
    wear(null);
    return;
  }
  cam = next;
  const pose = flatPose(fit);
  w.rig.jumpTo(pose);
  flushSync(() => useUI.getState().set({ flatLayout: layoutOf(pose, fit) }));
  stopGlide();
  wear(null);
}

/** Take the map to `to` (clamped) in a short glide, or at once if motion is reduced. */
export function glideFlat(to: FlatCam) {
  settleFlat();
  const v = flatView();
  const fit = currentFit();
  if (!v || !fit) return;
  const goal = clampCam(to, fit.box);
  if (sameCam(goal, cam)) return;
  live = goal;
  if (reducedMotion()) {
    settleFlat();
    return;
  }
  const t = between(cam, goal, v.centre, v.k0);
  const token = (glide?.token ?? 0) + 1;
  const anims = mapLayers().map((el) => {
    el.style.transformOrigin = '0 0';
    el.style.willChange = 'transform';
    return el.animate([{ transform: 'none' }, { transform: wearing(t) }], { duration: GLIDE, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'forwards' });
  });
  glide = { anims, token };
  void Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => {
    // (Only if nothing took the map over meanwhile: a touch settles it at once.)
    if (glide?.token === token && live === goal) settleFlat();
  });
}

/** The zoom and pan the map is at, or is being taken to by a gesture. */
export const flatNow = (): FlatCam => live ?? cam;

/** Zoom by `factor` about the middle of the free part (the + and - keys). */
export function zoomFlatBy(factor: number) {
  const v = flatView();
  if (v) glideFlat(zoomAbout(flatNow(), factor, v.centre.x, v.centre.y, v.centre, v.k0));
}

/** The map moved a step, a sixth of the free part's width or height (the arrow keys), as a glide. */
export function panFlatBy(dx: number, dy: number) {
  const v = flatView();
  const L = useUI.getState().flatLayout;
  if (v && L) glideFlat(panBy(flatNow(), (-dx * L.free.w) / 6, (-dy * L.free.h) / 6, v.k0));
}

/** Back to the whole board (a double tap). */
export const fitFlat = () => glideFlat(FIT_CAM);

// On the title, the view re-fits its lift above the menu (a phone turned).
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (useUI.getState().screen === 'title' && session.world && !session.world.rig.flying) session.world.rig.goal.shiftY = titleView().shiftY;
  }, 120);
});
