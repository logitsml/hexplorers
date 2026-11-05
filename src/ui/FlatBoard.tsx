// The flat 2D map (app/viewMode.ts switches to it): the same island drawn as a board, top-down
// and north-up, laid over the 3D view at the exact scale and place the overhead camera shows it,
// so the one can turn into the other. Terrain tiles with our resource icons and number discs, the
// harbours, everyone's roads and buildings (with their seat marks), the robber, and, while
// placing, the spots to choose from. Pointing at or tapping them goes through the board's own
// input (app/input.ts), so placing works exactly as on the island.
//
// The expansions are drawn here too, by ui/flatArt.tsx: the five new terrains' glyphs, rivers,
// wells, fishing grounds, face-down fog hexes (the state this map reads still holds what they
// are, so they're drawn as mist over open water here and never as the land they hide), pollution
// (greyed and hatched hexes, struck-through discs, wasteland), every disc of a hex with several,
// and the raider fleet's track out on the sea. The ground is laid in three layers: the tiles
// (which take the pointer), the rivers over them, and the icons, discs and markers over the rivers.

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { EventDieIcon } from './Dice';
import { throwFaces, VALUE_EVENT, type EventDieResult } from '../render/fx/eventDie';
import { PIPS, TERRAIN_RESOURCE, isLand, longestRoadEdges, numbersOf, type Board, type GameState, type Hex, type RouteKind, type Terrain } from '../engine';
import { landHexes } from '../render/board/looks';
import { interactionSpots, speedOf, useUI, type UIStore } from '../game/store';
import { quickSpots } from '../game/commands';
import { dragJob } from '../game/bindings';
import { session } from '../app/session';
import { toggleView, fitFlat, flatNow, flatView, flatZoomable, previewFlat, settleFlat } from '../app/viewMode';
import { panBy, zoomAbout, type FlatCam } from '../app/flatZoom';
import { PLAYER_PALETTE, SEAT_MARKS } from '../render/board/pieces';
import { CARD_ICON, CARD_NAMES, TERRAIN_NAMES, asset } from '../game/names';
import { sfx } from '../audio/sfx';
import { reducedMotion } from '../app/display';
import { FLEET_STEPS } from '../engine/modules/fleet';
import { isConquered } from '../engine/modules/shared';
import { BountyGlyph, Blight, CastleGlyph, OilWellGlyph, FishingGround, FlatDefs, FleetTrack, Mist, useGlide, OasisGlyph, Rivers, SwampGlyph, TileGround, WasteGlyph, clearSpot, discSpots, fleetTrack, harbourRadius, harbourSpots, raiderSpot, ringSpot, riverStretches, Raider, TraderStall, type Avoid, type Stretch } from './flatArt';

type Layout = NonNullable<UIStore['flatLayout']>;
type Pt = [number, number];

/** The terrain's colour from overhead (as the 3D island reads from above), and its edge. */
export const FILL: Record<Terrain, string> = {
  forest: '#3f6a3a',
  pasture: '#86ae52',
  fields: '#d4b457',
  hills: '#b4673f',
  mountains: '#7c858d',
  desert: '#d3c196',
  // (A worked stream's gravel bed, ochre-grey: the fields' gold would make it read as wheat.)
  bounty: '#a8987a',
  swamp: '#6b7650',
  lake: '#5a91ad',
  oasis: '#c8bb88',
  castle: '#8d867c',
  sea: '#256f98',
};

const INK = '#2b2118';
const NONE: number[] = [];

const proj = (L: Layout) => (x: number, z: number): Pt => [L.cx + (x - L.wx) * L.k, L.cy + (z - L.wz) * L.k];

const pts = (p: Pt[]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** A hex's corners pushed out from (or in towards) its centre. */
function hexCorners(board: Board, hex: number, P: (x: number, z: number) => Pt, scale = 1): Pt[] {
  const h = board.hexes[hex];
  return h.vertices.map((v) => {
    const vx = board.vertices[v];
    return P(h.x + (vx.x - h.x) * scale, h.z + (vx.z - h.z) * scale);
  });
}

export function FlatBoard() {
  const layout = useUI((s) => s.flatLayout);
  const phase = useUI((s) => s.flatPhase);
  const view = useUI((s) => s.view);
  const live = useUI((s) => s.mapPieces);
  const screen = useUI((s) => s.screen);
  const root = useRef<HTMLDivElement>(null);
  const up = !!layout && !!phase && !!view && screen === 'game';
  useMapGestures(root, up);
  if (!layout || !phase || !view || screen !== 'game') return null;
  const pieces = live ?? view;
  return (
    <div ref={root} className={`flat-board ${phase}`} style={{ ...scaleOf(layout), touchAction: 'none' }}>
      {/* The surface a drag or a pinch can start on anywhere, the sea beyond the island included (under the tiles and targets, which take taps); only while the map is up, not as it fades to the island. */}
      <div className="flat-pan" style={{ position: 'absolute', inset: 0, pointerEvents: phase === 'shown' ? 'auto' : 'none' }} />
      <div className="flat-sea" style={{ ['--sx' as string]: `${layout.cx}px`, ['--sy' as string]: `${layout.cy}px` } as CSSProperties} />
      <div className="flat-svg flat-ground">
        <Ground state={view} board={view.board} layout={layout} robber={pieces.robberHex ?? -1} />
      </div>
      <svg className="flat-svg" width="100%" height="100%" aria-label="The island as a flat map" role="img">
        <Harbours board={view.board} layout={layout} down={view.ext.sea?.fog?.hidden ?? NONE} held={heldHarbours(view, pieces.buildings)} />
        <Fleet state={view} layout={layout} />
        <Pieces state={view} pieces={pieces} layout={layout} />
        <Marks state={view} layout={layout} />
        <Spots board={view.board} layout={layout} />
      </svg>
      <FlatDice layout={layout} />
    </div>
  );
}

// ------------------------------------------------------------- zoom and pan

/** How far (px) a finger or the mouse must travel before a press is a drag and no longer a tap. */
const DRAG = 7;
/** A second tap this soon (ms) and this near (px) after the first is a double tap. */
const DOUBLE_MS = 320;
const DOUBLE_PX = 30;

/**
 * Pinch and two-finger pan on touch, drag with one finger or the mouse, the wheel (and a
 * trackpad's pinch) about the pointer, and a double tap to fit the board again. The map follows
 * with a transform while the gesture lasts and is redrawn at its end (app/viewMode.ts previewFlat,
 * settleFlat). A drag swallows the click that ends it, so it never places anything.
 */
function useMapGestures(root: React.RefObject<HTMLDivElement | null>, on: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!on || !el) return;
    const fingers = new Map<number, Pt>();
    // The gesture's start: the map then, where the fingers' middle was, and how spread they were.
    let base: FlatCam = flatNow();
    let from: Pt = [0, 0];
    let spread = 0;
    let dragging = false;
    let swallow = false;
    let swallowTimer: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let lastTap: { t: number; x: number; y: number } | null = null;
    let tap: { x: number; y: number; target: EventTarget | null } | null = null;

    const middle = (): Pt => {
      let x = 0, y = 0;
      fingers.forEach((p) => ((x += p[0]), (y += p[1])));
      return [x / fingers.size, y / fingers.size];
    };
    const spreadOf = (m: Pt) => {
      let d = 0;
      fingers.forEach((p) => (d += Math.hypot(p[0] - m[0], p[1] - m[1])));
      return d / fingers.size;
    };
    // A new start from where things are now (a finger came or went, or a drag has just begun), so the map doesn't jump.
    const rebase = () => {
      base = flatNow();
      from = middle();
      spread = spreadOf(from);
    };
    const follow = () => {
      const v = flatView();
      if (!v || fingers.size === 0) return;
      const m = middle();
      const s = fingers.size > 1 && spread > 1 ? spreadOf(m) / spread : 1;
      let next = zoomAbout(base, s, from[0], from[1], v.centre, v.k0);
      next = panBy(next, m[0] - from[0], m[1] - from[1], v.k0);
      previewFlat(next);
    };
    const swallowClick = () => {
      swallow = true;
      clearTimeout(swallowTimer);
      swallowTimer = setTimeout(() => (swallow = false), 60);
    };

    const move = (e: PointerEvent) => {
      if (!fingers.has(e.pointerId)) return;
      fingers.set(e.pointerId, [e.clientX, e.clientY]);
      if (!dragging) {
        if (fingers.size < 2 && tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < DRAG) return;
        if (fingers.size < 2 && !tap && Math.hypot(e.clientX - from[0], e.clientY - from[1]) < DRAG) return;
        dragging = true;
        tap = null;
        // (A tile's details, shown for the press, give way to the drag.)
        session.input?.hoverTile(-1, 0, 0);
        rebase();
        return;
      }
      follow();
    };
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (!fingers.delete(e.pointerId)) return;
      if (fingers.size > 0) {
        // (One finger of a pinch lifted: the other carries on as a pan.)
        rebase();
        return;
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', cancel);
      if (dragging) {
        dragging = false;
        swallowClick();
        settleFlat();
        lastTap = null;
        return;
      }
      if (cancelled || !tap) return;
      // A double tap on open map fits the board again (not on a target: its second tap is a placement).
      const onTarget = (tap.target as Element | null)?.closest?.('.flat-hit');
      const now = performance.now();
      if (!onTarget && lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < DOUBLE_PX) {
        lastTap = null;
        swallowClick();
        fitFlat();
      } else {
        lastTap = { t: now, x: tap.x, y: tap.y };
      }
      tap = null;
    };
    const lift = (e: PointerEvent) => end(e, false);
    const cancel = (e: PointerEvent) => end(e, true);

    const down = (e: PointerEvent) => {
      // A mouse drags the map with whichever buttons move the map on the island too (Settings,
      // Controls: by default the left and the middle; turning the view has no meaning here).
      if (e.pointerType === 'mouse' && e.button !== 0 && dragJob(e.button, useUI.getState().settings.mouse) !== 'pan') return;
      // (The middle button's own default, the page's autoscroll, would take over the drag.)
      if (e.button === 1) e.preventDefault();
      if (!flatZoomable()) return;
      if (fingers.size === 0) {
        // (A glide still on its way is finished at once, and this press works from where it ends.
        // Not for a pinch's second finger: the gesture goes on from where the map is shown.)
        settleFlat();
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', lift);
        window.addEventListener('pointercancel', cancel);
        dragging = false;
        // (Only the main button's press is a tap: another one let go where it was does nothing.)
        tap = e.button === 0 ? { x: e.clientX, y: e.clientY, target: e.target } : null;
      } else {
        // A second finger: a pinch, which is a gesture from the start.
        tap = null;
        dragging = true;
        session.input?.hoverTile(-1, 0, 0);
      }
      fingers.set(e.pointerId, [e.clientX, e.clientY]);
      rebase();
    };

    // A mouse wheel's notches (100 px or more a step, as on Windows) are eased in over a few
    // frames rather than jumped by, each new one adding to what's still to come; a trackpad's
    // fine steps follow at once. The map is redrawn once the wheel has rested a while.
    let owed = 0;
    let at: Pt = [0, 0];
    let ease = 0;
    const settleSoon = () => {
      clearTimeout(idle);
      idle = setTimeout(settleFlat, 220);
    };
    const step = () => {
      ease = 0;
      const v = flatView();
      if (!v || fingers.size > 0) return void (owed = 0);
      const part = Math.abs(owed) < 0.004 ? owed : owed * 0.35;
      owed -= part;
      previewFlat(zoomAbout(flatNow(), Math.exp(part), at[0], at[1], v.centre, v.k0));
      if (owed !== 0) ease = requestAnimationFrame(step);
      settleSoon();
    };
    const wheel = (e: WheelEvent) => {
      const v = flatView();
      if (!v) return;
      e.preventDefault();
      if (fingers.size > 0) return;
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // (A trackpad's pinch arrives as a wheel with Ctrl held, in much smaller steps than a wheel's notch.)
      const log = -dy * (e.ctrlKey ? 0.01 : 0.002);
      at = [e.clientX, e.clientY];
      const notch = e.deltaMode !== 0 || (!e.ctrlKey && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (!notch && owed === 0) {
        previewFlat(zoomAbout(flatNow(), Math.exp(log), at[0], at[1], v.centre, v.k0));
        settleSoon();
        return;
      }
      // (At most a step and a half of zoom waiting, so a fast spin doesn't run on after it stops.)
      owed = Math.max(-0.6, Math.min(0.6, owed + log));
      if (!ease) ease = requestAnimationFrame(step);
    };
    // The click that ends a drag (or a double tap) is not a press on whatever it ended over.
    const click = (e: MouseEvent) => {
      if (!swallow) return;
      e.stopPropagation();
      e.preventDefault();
    };

    // (With the right button dragging the map, its menu would open at the end of every drag.)
    const menu = (e: MouseEvent) => dragJob(2, useUI.getState().settings.mouse) === 'pan' && e.preventDefault();
    el.addEventListener('contextmenu', menu);
    el.addEventListener('pointerdown', down);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('contextmenu', menu);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('click', click, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', cancel);
      clearTimeout(swallowTimer);
      clearTimeout(idle);
      cancelAnimationFrame(ease);
      fingers.clear();
    };
  }, [root, on]);
}

/** The map's scale (px per world unit) for the stylesheet, which sizes the targets and the sea's marks by it. */
function scaleOf(L: Layout): CSSProperties {
  return { ['--k' as string]: `${L.k}px` } as CSSProperties;
}

// ---------------------------------------------------------------- the island

/**
 * Where an oil well's badge goes on its hex (offsets from the centre in hex radii): where it has
 * always stood, unless that is on a corner holding a building, a road, a harbour's badge, a
 * raider or a disc, in which case the spot round the rim with the most room.
 */
function wellSpot(state: GameState, h: Hex, k: number, discs: number, icon: boolean, harbours: { x: number; z: number }[], stretches: Stretch[]): [number, number] {
  const board = state.board;
  const avoid: Avoid[] = [];
  h.vertices.forEach((v) => {
    // (A building's footprint, with its walls, chimney and banner above it.)
    if (state.buildings[v]) avoid.push({ x: board.vertices[v].x - h.x, z: board.vertices[v].z - h.z - 0.16, r: 0.42 });
  });
  h.edges.forEach((e) => {
    if (!state.routes[e]) return;
    const ed = board.edges[e];
    avoid.push({ x: board.vertices[ed.a].x - h.x, z: board.vertices[ed.a].z - h.z, to: [board.vertices[ed.b].x - h.x, board.vertices[ed.b].z - h.z], r: 0.12 });
  });
  for (const d of discSpots(discs, k, icon)) avoid.push({ x: d.dx / k, z: d.dy / k, r: d.r / k });
  const raid = raidersAt(state, h, k, discs, icon, harbours);
  if (raid) avoid.push({ x: raid.dx / k, z: raid.dy / k, r: raid.r / k });
  const badge = harbourRadius(k) / k;
  for (const b of harbours) avoid.push({ x: b.x - h.x, z: b.z - h.z, r: badge });
  // The river's water, sampled along the island's own course through this hex.
  const river = stretches.find((st) => st.hex.id === h.id)?.course;
  if (river) for (let i = 0; i < river.half.length; i += 4) avoid.push({ x: river.pts[i * 2], z: river.pts[i * 2 + 1], r: river.half[i] * 1.5, w: 0.7 });
  // (The icon behind counts for less: a badge may overlap its margin.)
  if (icon && discs > 0) avoid.push({ x: 0, z: discs > 1 ? -0.4 : -0.34, r: 0.28, w: 0.5 });
  const cands: [number, number][] = [[0.56, -0.3]];
  for (const rad of [0.4, 0.5, 0.6]) for (let deg = -90; deg < 270; deg += 30) cands.push([Math.cos((deg * Math.PI) / 180) * rad, Math.sin((deg * Math.PI) / 180) * rad]);
  return clearSpot(cands, Math.max(11, k * 0.22) / k, avoid);
}

/**
 * Where a hex's raiders stand (flatArt raiderSpot): towards the coast they came from (the middle of
 * its coast edges; away from the board's middle where it has none), clear of its icon, discs,
 * buildings, routes and the harbours' badges.
 */
function raidersAt(state: GameState, h: Hex, k: number, discs: number, icon: boolean, harbours: { x: number; z: number }[]) {
  const n = state.ext.invasion?.raiders[h.id] ?? 0;
  if (n <= 0) return null;
  const board = state.board;
  let cx = 0, cz = 0;
  for (const e of h.edges) {
    const ed = board.edges[e];
    if (!ed.coastal) continue;
    cx += (board.vertices[ed.a].x + board.vertices[ed.b].x) / 2 - h.x;
    cz += (board.vertices[ed.a].z + board.vertices[ed.b].z) / 2 - h.z;
  }
  if (Math.hypot(cx, cz) < 1e-3) {
    const land = landHexes(board);
    cx = h.x - land.reduce((a, l) => a + l.x, 0) / land.length;
    cz = h.z - land.reduce((a, l) => a + l.z, 0) / land.length;
  }
  const l = Math.hypot(cx, cz) || 1;
  const avoid: Avoid[] = [];
  h.vertices.forEach((v) => {
    if (state.buildings[v]) avoid.push({ x: board.vertices[v].x - h.x, z: board.vertices[v].z - h.z - 0.1, r: 0.36 });
  });
  h.edges.forEach((e) => {
    if (!state.routes[e]) return;
    const ed = board.edges[e];
    avoid.push({ x: board.vertices[ed.a].x - h.x, z: board.vertices[ed.a].z - h.z, to: [board.vertices[ed.b].x - h.x, board.vertices[ed.b].z - h.z], r: 0.1 });
  });
  for (const d of discSpots(discs, k, icon)) avoid.push({ x: d.dx / k, z: d.dy / k, r: d.r / k });
  // (The icon is the hex's identity: it counts double.)
  if (icon) avoid.push(discs === 0 ? { x: 0, z: 0, r: 0.42, w: 2 } : { x: 0, z: discs > 2 ? -0.5 : discs > 1 ? -0.4 : -0.34, r: discs > 1 ? 0.27 : 0.3, w: 2 });
  const badge = harbourRadius(k) / k;
  for (const b of harbours) avoid.push({ x: b.x - h.x, z: b.z - h.z, r: badge });
  const spot = raiderSpot(n, k, [cx / l, cz / l], avoid);
  return spot && { ...spot, n };
}

/** A hex's discs: the numbers it bears (the fog's drawn one included) and, struck through, the ones pollution has taken. */
function discsOf(state: GameState, hex: Hex): { n: number; struck: boolean }[] {
  const lost = (state.ext.oil?.lost ?? []).filter((l) => l.hex === hex.id).map((l) => l.number);
  return [...numbersOf(state, hex).map((n) => ({ n, struck: false })), ...lost.map((n) => ({ n, struck: true }))].sort((a, b) => a.n - b.n || Number(a.struck) - Number(b.struck));
}

/** The face-down hexes that have just been turned up: their mist rises for a moment (unless motion is reduced). */
function useLifted(hidden: number[] | undefined) {
  const prev = useRef<number[] | null>(null);
  const [lifted, setLifted] = useState<number[]>([]);
  const key = hidden ? hidden.join(',') : '';
  useEffect(() => {
    const was = prev.current;
    prev.current = hidden ?? null;
    if (!was || !hidden || reducedMotion()) return;
    const gone = was.filter((h) => !hidden.includes(h));
    if (gone.length === 0) return;
    setLifted(gone);
    const t = setTimeout(() => setLifted([]), 2000);
    return () => clearTimeout(t);
  }, [key]);
  return lifted;
}

/** Sea, coast and tiles: redrawn when the board, the layout or what a hex bears changes. */
const Ground = memo(function Ground({ state, board, layout, robber }: { state: GameState; board: Board; layout: Layout; robber: number }) {
  // (The projection and each hex's corners are kept while the board and the layout are: the
  // drawings below are memoised, and fresh corners would redraw every one on every move.)
  const P = useMemo(() => proj(layout), [layout]);
  const { k } = layout;
  const shape = useMemo(
    () =>
      board.hexes.map((h) => {
        const corners = hexCorners(board, h.id, P);
        return { at: P(h.x, h.z), corners, outline: pts(corners) };
      }),
    [board, P],
  );
  const pulse = useRolledHexes(state);
  // The rivers are the island's own, as planned for its tiles (render/board/riverCourse.ts).
  const stretches = useMemo(() => riverStretches(session.world?.tiles?.tiles), [board, session.world?.tiles]);
  const hidden = state.ext.sea?.fog?.hidden;
  const lifted = useLifted(hidden);
  // (The state this view holds still has what is face down: it's drawn as open water, never as what it is.)
  const downKey = hidden ? hidden.join(',') : '';
  const down = useMemo(() => new Set(hidden ?? []), [downKey]);
  const harbours = useMemo(() => harbourSpots(board, [...down]), [board, down]);
  const land = useMemo(() => landHexes(board).filter((h) => !down.has(h.id)), [board, down]);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downAt = useRef<Pt | null>(null);
  // (A press still being held when the map goes mustn't show a tile's details afterwards.)
  useEffect(() => () => void (hold.current && clearTimeout(hold.current)), []);
  // Pointing at a tile shows its details (as on the island); on touch, a press and hold does.
  const tileEvents = (hex: number) => ({
    // (Not while a button is down: that is a drag across the map.)
    onPointerMove: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') {
        if (e.buttons === 0) session.input?.hoverTile(hex, e.clientX, e.clientY);
      } else if (hold.current && downAt.current && Math.hypot(e.clientX - downAt.current[0], e.clientY - downAt.current[1]) > 7) {
        // A finger that moves is dragging the map, not holding a tile.
        clearTimeout(hold.current);
        hold.current = null;
      }
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (hold.current) clearTimeout(hold.current);
      if (e.pointerType === 'mouse') session.input?.hoverTile(-1, 0, 0);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const { clientX: x, clientY: y } = e;
      downAt.current = [x, y];
      if (hold.current) clearTimeout(hold.current);
      hold.current = setTimeout(() => session.input?.hoverTile(hex, x, y, true), 450);
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (hold.current) clearTimeout(hold.current);
      if (e.pointerType === 'touch') session.input?.hoverTile(-1, 0, 0);
    },
  });
  // Each hex's drawing is worked out once, then laid in three layers: the tiles (which take the
  // pointer), the rivers over them, and the icons, discs and markers over the rivers.
  const hexes = board.hexes.map((h, i) => {
    const [x, y] = shape[i].at;
    const sea = !isLand(h.terrain) || down.has(h.id);
    const discs = down.has(h.id) ? [] : discsOf(state, h);
    const polluted = discs.some((d) => d.struck);
    return {
      h,
      x,
      y,
      sea,
      discs,
      polluted,
      waste: polluted && discs.every((d) => d.struck),
      corners: shape[i].corners,
      outline: shape[i].outline,
      // The number that just paid out here (0 when none did).
      hot: pulse?.ids.has(h.id) && h.id !== robber ? pulse.total : 0,
    };
  });
  // The coast and the land's clip are the same elements while the land and the layout are, so a
  // new state passes over them. (Round the land only: a map's sea hexes are open water, drawn with no
  // grid of their own.) The sea is one still colour with a paler band of shallows and the beach
  // round the land: nothing about it moves.
  const coast = useMemo(() => {
    const ring = (key: string, scale: number, fill: string, opacity?: string) =>
      land.map((h) => <polygon key={`${key}${h.id}`} points={pts(hexCorners(board, h.id, P, scale))} fill={fill} opacity={opacity} />);
    return {
      shallows: ring('s', 1.19, '#4a9bc0', '0.4'),
      beach: ring('b', 1.08, '#e7d4a2'),
    };
  }, [board, P, land]);
  const landClip = useMemo(
    () => (
      <clipPath id="flat-land">
        {land.map((h) => (
          <polygon key={h.id} points={pts(hexCorners(board, h.id, P, 1.08))} />
        ))}
      </clipPath>
    ),
    [board, P, land],
  );
  // The ground is drawn in layers, each an svg of its own: the shallows; over them the beach and
  // the tiles; the rivers; and the icons, discs and markers over those. (The pieces and the rest
  // are in the map's own svg, over these.)
  return (
    <>
      <svg className="flat-layer" width="100%" height="100%" aria-hidden>
        <FlatDefs k={k} />
        <g className="flat-coast">{coast.shallows}</g>
      </svg>
      <svg className="flat-layer" width="100%" height="100%" aria-hidden>
        <g className="flat-coast">{coast.beach}</g>
        {hexes.map(({ h, x, y, sea, discs, waste, polluted, corners, outline, hot }) =>
          sea ? (
            <g key={h.id} className={`flat-hex sea${hot ? ' hot' : ''}`} style={{ transformOrigin: `${x}px ${y}px` } as CSSProperties} {...tileEvents(h.id)}>
              {/* (Open water has no edge, except a faint one where a ship sails, a fishing ground lies or the fog hangs.) */}
              <polygon points={outline} fill="#ffffff" fillOpacity="0.02" stroke={down.has(h.id) || discs.length > 0 || h.edges.some((e) => state.routes[e]?.kind === 'ship') ? '#ffffff' : 'none'} strokeOpacity="0.2" strokeWidth={Math.max(1, k * 0.02)} />
            </g>
          ) : (
            <g key={h.id} className={`flat-hex${hot ? ' hot' : ''}${lifted.includes(h.id) ? ' found' : ''}`} style={{ transformOrigin: `${x}px ${y}px` } as CSSProperties} {...tileEvents(h.id)}>
              <polygon className="flat-tile" points={outline} fill={FILL[h.terrain]} />
              <TileGround terrain={h.terrain} id={h.id} x={x} y={y} k={k} corners={corners} />
              {polluted && <Blight id={h.id} x={x} y={y} k={k} corners={corners} waste={waste} />}
              {/* Conquered by the raiders: a thin broken border inside the edges nothing may now be built on. */}
              {state.ext.invasion && isConquered(state, h.id) && (
                <g pointerEvents="none" aria-hidden>
                  <polygon points={pts(hexCorners(board, h.id, P, 0.86))} fill="none" stroke="#6e3a30" strokeOpacity="0.9" strokeWidth={Math.max(1.5, k * 0.03)} strokeDasharray={`${(k * 0.12).toFixed(1)} ${(k * 0.08).toFixed(1)}`} strokeLinejoin="round" />
                </g>
              )}
            </g>
          ),
        )}
      </svg>
      {stretches.length > 0 && (
        <svg className="flat-layer flat-water" width="100%" height="100%" aria-hidden>
          {/* The land with its beach: where the rivers' water may run. */}
          {landClip}
          <Rivers stretches={stretches} P={P} k={k} clip="flat-land" />
        </svg>
      )}
      <svg className="flat-layer" width="100%" height="100%" aria-hidden>
        {hexes.map(({ h, x, y, sea, discs, waste, hot }) => {
          const res = TERRAIN_RESOURCE[h.terrain];
          const spots = discSpots(discs.length, k, h.terrain !== 'lake');
          // The icon is big and centred when the hex has no discs, and moves up out of their way when several share it.
          const bare = discs.length === 0;
          // (Over several discs the icon takes the room left above them, its foot on their top.)
          const top = discs.length > 1 ? Math.min(...spots.map((d) => d.dy - d.r)) : 0;
          const isz = bare ? (res ? k * 0.95 : k * 1.2) : discs.length > 1 ? Math.min(k * 0.6, Math.max(k * 0.3, top + k * 0.78)) : k * 0.68;
          const iy = bare ? y : discs.length > 1 ? y + top - isz * 0.46 : y - k * 0.34;
          return (
            <g key={h.id} className={`flat-top${hot ? ' hot' : ''}`} style={{ transformOrigin: `${x}px ${y}px` } as CSSProperties} pointerEvents="none">
              {sea && discs.length > 0 && <FishingGround x={x} y={y} k={k} disc={spots[0].r} />}
              {!sea &&
                (waste ? (
                  <WasteGlyph x={x} y={iy} s={isz} label="Wasteland" />
                ) : res ? (
                  <image href={asset(CARD_ICON[res])} x={x - isz / 2} y={iy - isz / 2} width={isz} height={isz} preserveAspectRatio="xMidYMid meet" aria-label={CARD_NAMES[res]} />
                ) : h.terrain === 'bounty' ? (
                  <BountyGlyph x={x} y={iy} s={isz} label={TERRAIN_NAMES.bounty} />
                ) : h.terrain === 'swamp' ? (
                  <SwampGlyph x={x} y={iy} s={isz} label={TERRAIN_NAMES.swamp} />
                ) : h.terrain === 'oasis' ? (
                  <OasisGlyph x={x} y={iy} s={isz} label={TERRAIN_NAMES.oasis} />
                ) : h.terrain === 'castle' ? (
                  <CastleGlyph x={x} y={iy} s={isz} label={TERRAIN_NAMES.castle} />
                ) : h.terrain === 'desert' ? (
                  <path d={`M${x - k * 0.45} ${y - k * 0.22} q${k * 0.22} ${-k * 0.2} ${k * 0.45} 0 t${k * 0.45} 0 M${x - k * 0.3} ${y - k * 0.42} q${k * 0.18} ${-k * 0.14} ${k * 0.36} 0`} fill="none" stroke="#b39d68" strokeWidth={k * 0.05} strokeLinecap="round" aria-hidden />
                ) : null)}
              {h.well && (() => {
                const [wx, wz] = wellSpot(state, h, k, discs.length, h.terrain !== 'lake', harbours, stretches);
                return <OilWellGlyph x={x + wx * k} y={y + wz * k} s={Math.max(22, k * 0.44)} label="Oil well" />;
              })()}
              {discs.map((d, i) => (
                <NumberDisc key={i} x={x + spots[i].dx} y={y + spots[i].dy} r={spots[i].r} k={k} n={d.n} struck={d.struck} hit={hot === d.n} />
              ))}
              {hot ? <polygon className="flat-glow" points={pts(hexCorners(board, h.id, P, 0.94))} /> : null}
            </g>
          );
        })}
        {hexes
          .filter((x) => down.has(x.h.id))
          .map(({ h, x, y, corners }) => (
            <Mist key={`m${h.id}`} id={h.id} x={x} y={y} k={k} corners={corners} />
          ))}
        {hexes
          .filter((x) => lifted.includes(x.h.id))
          .map(({ h, x, y, corners }) => (
            <Mist key={`l${h.id}`} id={h.id} x={x} y={y} k={k} corners={corners} lifting />
          ))}
      </svg>
    </>
  );
});

export const NumberDisc = memo(function NumberDisc({ x, y, r, k, n, struck = false, hit = false }: { x: number; y: number; r: number; k: number; n: number; struck?: boolean; hit?: boolean }) {
  const red = n === 6 || n === 8;
  const pips = PIPS[n] ?? 0;
  const ink = struck ? '#6e6558' : red ? '#b8302a' : INK;
  return (
    <g className={`flat-disc${hit ? ' hit' : ''}${struck ? ' struck' : ''}`} aria-label={struck ? `${n}, lost to pollution` : `${n}`}>
      <circle cx={x} cy={y} r={r} fill={struck ? '#ddd5c0' : '#f7efdc'} stroke={struck ? '#8f8570' : '#bfa877'} strokeWidth={Math.max(1, k * 0.025)} />
      <text x={x} y={y - r * 0.1} textAnchor="middle" dominantBaseline="middle" fontSize={r * (n >= 10 ? 0.86 : 0.96)} fill={ink} className="flat-num">
        {n}
      </text>
      {/* (The pips, the number's odds, under it on every disc: each its own dot, a clear gap between them.) */}
      {(() => {
        const dot = Math.max(0.85, r * 0.062);
        const gap = Math.max(dot * 3, r * 0.22);
        return Array.from({ length: pips }, (_, i) => <circle key={i} cx={x + (i - (pips - 1) / 2) * gap} cy={y + r * 0.6} r={dot} fill={ink} />);
      })()}
      {struck && <line x1={x - r * 0.78} y1={y - r * 0.78} x2={x + r * 0.78} y2={y + r * 0.78} stroke="#7a2a22" strokeWidth={Math.max(2, r * 0.18)} strokeLinecap="round" opacity="0.85" />}
    </g>
  );
});

/** The tiles a roll paid out (and the number that paid them), lit for a moment once the dice have landed. */
function useRolledHexes(state: GameState) {
  const roll = useUI((s) => s.diceRoll);
  const speed = useUI(speedOf);
  const [hot, setHot] = useState<{ ids: Set<number>; total: number } | null>(null);
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    if (!roll) return;
    const total = roll.dice[0] + roll.dice[1];
    if (total === 7) return;
    const show = setTimeout(() => {
      const s = latest.current;
      setHot({ ids: new Set(s.board.hexes.filter((h) => numbersOf(s, h).includes(total)).map((h) => h.id)), total });
    }, (SETTLED * 1000) / speed);
    const hide = setTimeout(() => setHot(null), (SETTLED * 1000) / speed + 1600);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [roll?.id]);
  return hot;
}

/** Who holds each harbour, as "id:colour" pairs in a string (so the memo holds): its badge's rim is theirs, as on the island. */
const heldHarbours = (s: GameState, buildings: GameState['buildings']) =>
  s.board.ports
    .flatMap((p) => {
      const v = p.vertices.find((x) => buildings[x]);
      return v === undefined ? [] : [`${p.id}:${PLAYER_PALETTE[s.players[buildings[v]!.owner].color].ui}`];
    })
    .join(',');

const Harbours = memo(function Harbours({ board, layout, down, held }: { board: Board; layout: Layout; down: number[]; held: string }) {
  const P = proj(layout);
  const { k } = layout;
  const owner = new Map(held ? held.split(',').map((x) => [Number(x.split(':')[0]), x.split(':')[1]] as const) : []);
  return (
    <g className="flat-harbours" aria-hidden>
      {harbourSpots(board, down).map(({ port, x: bx, z: bz }) => {
        const [a, b] = port.vertices.map((v) => board.vertices[v]);
        const [x, y] = P(bx, bz);
        const pier = (v: typeof a) => {
          const [px, py] = P(v.x + (bx - v.x) * 0.12, v.z + (bz - v.z) * 0.12);
          return <line x1={px} y1={py} x2={x} y2={y} stroke="#7a5532" strokeWidth={Math.max(2, k * 0.07)} strokeLinecap="round" />;
        };
        const r = harbourRadius(k);
        return (
          <g key={port.id} className="flat-harbour">
            {pier(a)}
            {pier(b)}
            <HarbourBadge x={x} y={y} r={r} k={k} type={port.type} rim={owner.get(port.id)} />
          </g>
        );
      })}
    </g>
  );
});

/**
 * A harbour's dock tag: a pale-blue rounded tag (so it isn't taken for a number's cream disc) with
 * 3:1 for any goods, else the resource's icon over 2:1; `rim`, its holder's colour. (Its words
 * never under 10 px: on a small map the 2:1's icon gives way a little.)
 */
export function HarbourBadge({ x, y, r, k, type, rim }: { x: number; y: number; r: number; k: number; type: Board['ports'][number]['type']; rim?: string }) {
  const small = Math.max(10, r * 0.5);
  const icon = Math.min(r, r * 1.5 - small);
  const w = Math.max(1.2, k * (rim ? 0.07 : 0.03));
  const corner = r * 0.42;
  return (
    <>
      {/* (A held tag is filled in its holder's colour round the pale face, and ringed in ink, so a pale seat's colour still shows.) */}
      {rim && <rect x={x - r - w * 1.5 - 0.6} y={y - r - w * 1.5 - 0.6} width={(r + w * 1.5 + 0.6) * 2} height={(r + w * 1.5 + 0.6) * 2} rx={corner + w * 1.5} fill="none" stroke={INK} strokeOpacity="0.7" strokeWidth={Math.max(0.8, k * 0.012)} />}
      <rect x={x - r - w} y={y - r - w} width={(r + w) * 2} height={(r + w) * 2} rx={corner + w * 0.5} fill={rim ?? '#6f9db5'} />
      <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={corner} fill="#d9edf6" />
      {type === 'any' ? (
        <text x={x} y={y + r * 0.08} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(10, r * 0.72)} fill={INK} className="flat-num">
          3:1
        </text>
      ) : (
        <>
          <image href={asset(CARD_ICON[type])} x={x - icon / 2} y={y - r * 0.82} width={icon} height={icon} />
          <text x={x} y={y + r * 0.75 - small / 2} textAnchor="middle" dominantBaseline="middle" fontSize={small} fill={INK} className="flat-num">
            2:1
          </text>
        </>
      )}
    </>
  );
}

/** The raider fleet (Raider Fleet): its track out on the sea in a corner of the window, and the longships' place on it. */
function Fleet({ state, layout }: { state: GameState; layout: Layout }) {
  const fleet = state.ext.fleet;
  const board = state.board;
  const { cx, cy, k, free, safe } = layout;
  // (On the sea left free of the HUD's panels if there's room there, otherwise anywhere in the window.)
  const track = useMemo(() => (fleet ? (fleetTrack(board, proj(layout), k, cx, cy, free) ?? fleetTrack(board, proj(layout), k, cx, cy, safe)) : null), [board, !!fleet, cx, cy, k, layout.wx, layout.wz, free, safe]);
  if (!fleet || !track) return null;
  return <FleetTrack track={track} k={k} position={fleet.position} steps={FLEET_STEPS} epoch={fleet.attacks} />;
}

// ------------------------------------------------------------------ pieces

const markPath = (seat: number, x: number, y: number, s: number) => {
  const m = SEAT_MARKS[seat % SEAT_MARKS.length];
  if (m === 'triangle') return <polygon points={pts([[x, y - s], [x + s * 0.9, y + s * 0.7], [x - s * 0.9, y + s * 0.7]])} />;
  if (m === 'square') return <rect x={x - s * 0.72} y={y - s * 0.72} width={s * 1.44} height={s * 1.44} rx={s * 0.12} />;
  if (m === 'diamond') return <polygon points={pts([[x, y - s], [x + s, y], [x, y + s], [x - s, y]])} />;
  return <circle cx={x} cy={y} r={s * 0.8} />;
};

const HOUSE: Pt[] = [[0, -1.05], [0.88, -0.22], [0.88, 0.78], [-0.88, 0.78], [-0.88, -0.22]];
const CITY: Pt[] = [[-1.05, 0.8], [-1.05, -0.95], [-0.62, -1.35], [-0.18, -0.95], [-0.18, -0.3], [0.42, -0.82], [1.02, -0.3], [1.02, 0.8]];

/** A piece placed while the map is up lands with a stamp (on its sound's knock) and a ring of dust. (The pieces are memoised: a new state redraws only those it changes.) */
function Impact({ x, y, r }: { x: number; y: number; r: number }) {
  return <circle className="flat-impact" cx={x} cy={y} r={r} style={{ transformOrigin: `${x}px ${y}px` }} />;
}

const HALO = '#fff6e0';

/** How big a building is drawn (px, its unit): the settlement's, the city's a little more. */
const buildingSize = (kind: 'settlement' | 'city', k: number) => Math.max(kind === 'city' ? 10 : 9, k * (kind === 'city' ? 0.3 : 0.26));

const Building = memo(function Building({ kind, seat, color, x, y, k, ghost = false, fresh = false }: { kind: 'settlement' | 'city'; seat: number; color: string; x: number; y: number; k: number; ghost?: boolean; fresh?: boolean }) {
  const pal = PLAYER_PALETTE[color];
  const s = buildingSize(kind, k);
  const shape = (kind === 'city' ? CITY : HOUSE).map(([px, py]) => [x + px * s, y + py * s] as Pt);
  const ink = Math.max(1.2, s * 0.16);
  return (
    <g className={`flat-piece${ghost ? ' ghost' : ''}${fresh ? ' pop' : ''}`} style={{ transformOrigin: `${x}px ${y + s * 0.8}px` } as CSSProperties}>
      {fresh && <Impact x={x} y={y + s * 0.2} r={s * 1.5} />}
      {/* (A pale halo under the outline, so the piece stands out on every terrain.) */}
      <polygon points={pts(shape)} fill={HALO} fillOpacity="0.9" stroke={HALO} strokeOpacity="0.9" strokeWidth={ink + Math.max(3, s * 0.4)} strokeLinejoin="round" />
      <polygon points={pts(shape)} fill={pal.ui} stroke={INK} strokeOpacity="0.9" strokeWidth={ink} strokeLinejoin="round" />
      <g fill={pal.trim}>{markPath(seat, kind === 'city' ? x + s * 0.42 : x, y + s * 0.22, s * 0.34)}</g>
    </g>
  );
});

/**
 * A route piece: a road, a ship (dashed, like a wake) or a bridge (broad, with dark parapets). A road
 * a quake has cracked (the Almanac) keeps its outline and colour, with a jagged light gap cut across its
 * colour, inside the road's width, until it's mended.
 */
/** How wide a road is drawn (px, its colour's width before the outline and halo). */
const roadWidth = (k: number) => Math.max(5, k * 0.16);

const Road = memo(function Road({ a, b, color, k, kind = 'road', part = 'both', ghost = false, fresh = false, cracked = false, crackAt = 0.5, joinA = false, joinB = false }: { a: Pt; b: Pt; color: string; k: number; kind?: RouteKind; part?: 'halo' | 'ink' | 'body' | 'both'; ghost?: boolean; fresh?: boolean; cracked?: boolean; crackAt?: number; joinA?: boolean; joinB?: boolean }) {
  const pal = PLAYER_PALETTE[color];
  // (An end joined to another of its seat's roads runs on to the corner: see roadJoins. A bridge
  // spans nearly the whole edge, as on the island, so it meets a road at a corner either way.)
  const short = kind === 'bridge' ? 0.12 : 0.2;
  const p: Pt = joinA ? a : [a[0] + (b[0] - a[0]) * short, a[1] + (b[1] - a[1]) * short];
  const q: Pt = joinB ? b : [a[0] + (b[0] - a[0]) * (1 - short), a[1] + (b[1] - a[1]) * (1 - short)];
  const w = roadWidth(k);
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  // (Round ends on every route, so a bridge and a road meeting at a corner close round it with no notch.)
  const cap = 'round';
  // A road a quake has cracked keeps its whole outline and colour, with a jagged light gap cut across
  // its colour: within the road's own width, so nothing of it falls outside the casing.
  const parts: [Pt, Pt][] = [[p, q]];
  let crack: ReactNode = null;
  if (cracked) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len, nx = -uy, ny = ux;
    // (Where along the road it split: its middle, or nearer one end when a wagon stands on the middle.)
    const cx = p[0] + (q[0] - p[0]) * crackAt, cy = p[1] + (q[1] - p[1]) * crackAt;
    const half = (kind === 'bridge' ? 1.2 : 0.82) / 2;
    const at = (t: number, o: number) => `${(cx + ux * t * w + nx * o * w * half * 2).toFixed(1)} ${(cy + uy * t * w + ny * o * w * half * 2).toFixed(1)}`;
    crack = <path aria-hidden d={`M${at(-0.3, -half)} L${at(0.28, -half / 2)} L${at(-0.28, 0)} L${at(0.28, half / 2)} L${at(-0.3, half)}`} fill="none" stroke="#f3e8cc" strokeWidth={Math.max(1.8, w * 0.3)} strokeLinecap="butt" strokeLinejoin="round" />;
  }
  return (
    <g className={`flat-piece${ghost ? ' ghost' : ''}${fresh ? ' pop' : ''}${cracked ? ' cracked' : ''}`} style={{ transformOrigin: `${mx}px ${my}px` } as CSSProperties} aria-label={cracked ? 'A cracked road' : undefined}>
      {fresh && (part === 'body' || part === 'both') && <Impact x={mx} y={my} r={Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.55} />}
      {/* (Each layer is laid for all the roads before the next: all the halos, then all the dark outlines, then all the colours. So one road's outline never cuts across the colour of the next at a corner.) */}
      {(part === 'halo' || part === 'both') && <g opacity="0.9">{parts.map(([s0, s1], i) => <line key={`h${i}`} x1={s0[0]} y1={s0[1]} x2={s1[0]} y2={s1[1]} stroke={HALO} strokeWidth={w * (kind === 'bridge' ? 1.8 : 1.3) + Math.max(3, w * 0.6)} strokeLinecap={cap} />)}</g>}
      {(part === 'ink' || part === 'both') && parts.map(([s0, s1], i) => <line key={`i${i}`} x1={s0[0]} y1={s0[1]} x2={s1[0]} y2={s1[1]} stroke={INK} strokeOpacity="0.9" strokeWidth={w * (kind === 'bridge' ? 1.8 : 1.3)} strokeLinecap={cap} />)}
      {(part === 'body' || part === 'both') && parts.map(([s0, s1], i) => <line key={`c${i}`} x1={s0[0]} y1={s0[1]} x2={s1[0]} y2={s1[1]} stroke={pal.ui} strokeWidth={w * (kind === 'bridge' ? 1.2 : 0.82)} strokeLinecap={cap} strokeDasharray={kind === 'ship' ? `${w * 1.1} ${w * 0.7}` : undefined} />)}
      {(part === 'body' || part === 'both') && crack}
    </g>
  );
}, (x, y) => {
  // (Its ends come projected afresh with each state: compared by where they are, not by identity.)
  for (const key in x) {
    const k = key as keyof typeof x;
    if (k === 'a' || k === 'b' ? x[k][0] !== y[k][0] || x[k][1] !== y[k][1] : x[k] !== y[k]) return false;
  }
  return Object.keys(x).length === Object.keys(y).length;
});

/**
 * Where a seat's roads join, as on the island (render/board/boardView.ts joinRoads): every corner
 * with no building on it where two or three of one seat's roads and bridges meet, with those. Each runs
 * on to the corner there, and a lone road still stops short of it.
 */
/**
 * Where a wagon's cracked road splits (as a fraction along it from its edge's `a`): nearer one end than
 * the middle, since the wagon stands on the middle's far side. Nearer the end that is not joined to
 * another road, so the crack's stones and dark lines never fall on the road it meets at a corner.
 */
function crackAtOf(board: Board, joined: Set<string>, e: number): number {
  const ed = board.edges[e];
  return joined.has(`${e}:${ed.a}`) && !joined.has(`${e}:${ed.b}`) ? 0.75 : 0.25;
}

function roadJoins(board: Board, pieces: Pick<GameState, 'buildings' | 'routes'>): { v: number; edges: number[] }[] {
  const out: { v: number; edges: number[] }[] = [];
  for (const vx of board.vertices) {
    if (pieces.buildings[vx.id]) continue;
    const by = new Map<number, number[]>();
    for (const e of vx.edges) {
      const r = pieces.routes[e];
      // (A bridge counts as a road here, as it does in the rules.)
      if (r?.kind !== 'road' && r?.kind !== 'bridge') continue;
      const list = by.get(r.owner);
      if (list) list.push(e);
      else by.set(r.owner, [e]);
    }
    for (const edges of by.values()) if (edges.length >= 2) out.push({ v: vx.id, edges });
  }
  return out;
}

/** The robber: a pale figure in an ink outline, big enough to find on any tile. */
function Robber({ hex, layout, x, y, k }: { hex: number; layout: Layout; x: number; y: number; k: number }) {
  const s = Math.max(11, k * 0.4);
  const glide = useGlide(hex, layout, 700);
  const line = Math.max(1.5, s * 0.1);
  return (
    <g className="flat-robber" style={{ transform: `translate(${x}px, ${y}px)`, ...(!glide && { transition: 'none' }) }} aria-label="The robber">
      <ellipse cx={s * 0.12} cy={s * 0.92} rx={s * 0.7} ry={s * 0.22} fill="#000" opacity="0.22" />
      <path d={`M${-s * 0.62} ${s * 0.9} C${-s * 0.6} ${s * 0.1} ${-s * 0.42} ${-s * 0.35} 0 ${-s * 0.42} C${s * 0.42} ${-s * 0.35} ${s * 0.6} ${s * 0.1} ${s * 0.62} ${s * 0.9} Z`} fill="#f6efe0" stroke={INK} strokeWidth={line} strokeLinejoin="round" />
      <circle cx="0" cy={-s * 0.62} r={s * 0.36} fill="#f6efe0" stroke={INK} strokeWidth={line} />
    </g>
  );
}

function Pieces({ state, pieces, layout }: { state: GameState; pieces: Pick<GameState, 'buildings' | 'routes' | 'robberHex'>; layout: Layout }) {
  const P = proj(layout);
  const { k } = layout;
  const board = state.board;
  const colors = state.players.map((p) => p.color);
  // What stood here when the map came in is simply there; what's placed after lands.
  const born = useRef<Set<string> | null>(null);
  const keys = [...pieces.routes.flatMap((r, e) => (r === null ? [] : [`r${e}`])), ...pieces.buildings.flatMap((b, v) => (b ? [`b${v}-${b.kind}`] : []))];
  born.current ??= new Set(keys);
  const fresh = (key: string) => !born.current!.has(key);
  const robber = pieces.robberHex === null ? null : board.hexes[pieces.robberHex];
  const [rx, ry] = robber ? P(robber.x - 0.5, robber.z + 0.05) : [0, 0];
  // (A wagon is drawn over the middle of its edge: on a cracked road the crack moves towards one end
  // and the wagon towards the other, so both show. See Marks.)
  const wagons = new Set((state.ext.caravans?.trains ?? []).flatMap((t) => t.edges));
  const joins = roadJoins(board, pieces);
  const joined = new Set(joins.flatMap((j) => j.edges.map((e) => `${e}:${j.v}`)));
  const w = roadWidth(k);
  // The longest route, its award holder's winning route, in a soft gold halo under it (as it shimmers on the island).
  const longest = state.longestRoadHolder === null ? [] : longestRoadEdges(state, state.longestRoadHolder).filter((e) => pieces.routes[e]?.kind === 'road');
  return (
    <g className="flat-pieces">
      <g className="flat-longest" aria-hidden>
        {longest.map((e) => {
          const ed = board.edges[e];
          const [ax, ay] = P(board.vertices[ed.a].x, board.vertices[ed.a].z), [bx, by] = P(board.vertices[ed.b].x, board.vertices[ed.b].z);
          return <line key={`l${e}`} x1={ax + (bx - ax) * 0.12} y1={ay + (by - ay) * 0.12} x2={ax + (bx - ax) * 0.88} y2={ay + (by - ay) * 0.88} stroke="#ffe48a" strokeOpacity="0.75" strokeWidth={w * 2.6} strokeLinecap="round" />;
        })}
      </g>
      {(['halo', 'ink', 'body'] as const).map((part) =>
        pieces.routes.map((route, e) => {
          if (route === null) return null;
          const ed = board.edges[e];
          const a = board.vertices[ed.a], b = board.vertices[ed.b];
          return <Road key={`${part}${e}`} a={P(a.x, a.z)} b={P(b.x, b.z)} color={colors[route.owner]} k={k} kind={route.kind} part={part} fresh={fresh(`r${e}`)} cracked={!!route.cracked} crackAt={wagons.has(e) ? crackAtOf(board, joined, e) : 0.5} joinA={joined.has(`${e}:${ed.a}`)} joinB={joined.has(`${e}:${ed.b}`)} />;
        }),
      )}
      {/* Each joint painted over once more in its seat's colour, near the corner, so one road's
          outline and shadow don't cut across the next: the roads meet as one. */}
      <g aria-hidden>
        {joins.flatMap(({ v, edges }) => {
          const vx = board.vertices[v];
          const [x, y] = P(vx.x, vx.z);
          const ui = PLAYER_PALETTE[colors[pieces.routes[edges[0]]!.owner]].ui;
          return edges.map((e) => {
            const ed = board.edges[e];
            const o = board.vertices[ed.a === v ? ed.b : ed.a];
            const [ox, oy] = P(o.x, o.z);
            const len = Math.hypot(ox - x, oy - y) || 1;
            const t = Math.min(w * 1.1, len * 0.3) / len;
            // (At its own width: a bridge's colour runs broader than a road's.)
            return <line key={`j${v}:${e}`} x1={x} y1={y} x2={x + (ox - x) * t} y2={y + (oy - y) * t} stroke={ui} strokeWidth={w * (pieces.routes[e]?.kind === 'bridge' ? 1.2 : 0.82)} strokeLinecap="round" />;
          });
        })}
      </g>
      {pieces.buildings.map((bld, v) => {
        if (!bld) return null;
        const vx = board.vertices[v];
        const [x, y] = P(vx.x, vx.z);
        return <Building key={`b${v}-${bld.kind}`} kind={bld.kind} seat={bld.owner} color={colors[bld.owner]} x={x} y={y} k={k} fresh={fresh(`b${v}-${bld.kind}`)} />;
      })}
      {robber && <Robber hex={robber.id} layout={layout} x={rx} y={ry} k={k} />}
    </g>
  );
}

/**
 * The expansions' pieces on the map, as plain marks until they have drawings of their own (the
 * island's are in render/board/marks.ts): raiders as helmets on their hexes, the corsair as a
 * black sail, wardens as their owner's shields (one notch a rank, filled when mustered), wagons
 * as brown bars (a sail at sea), and rings, flags and chimneys on walled cities, seats and foundries.
 */
function Marks({ state, layout }: { state: GameState; layout: Layout }) {
  const P = proj(layout);
  const { k } = layout;
  const board = state.board;
  const colors = state.players.map((p) => p.color);
  const raiders = state.ext.invasion?.raiders ?? [];
  const harbours = harbourSpots(board, state.ext.sea?.fog?.hidden ?? NONE);
  const corsair = state.ext.sea?.corsair ?? null;
  const trader = state.ext.guilds?.trader ?? null;
  const trains = state.ext.caravans?.trains ?? [];
  const joinedEnds = new Set(roadJoins(board, state).flatMap((j) => j.edges.map((e) => `${e}:${j.v}`)));
  const sail = (x: number, y: number, s: number, fill: string) => <path d={`M${x - s * 0.6} ${y + s * 0.25} h${s * 1.2} l${-s * 0.25} ${s * 0.35} h${-s * 0.7} Z M${x} ${y + s * 0.2} V${y - s * 0.75} L${x + s * 0.55} ${y + s * 0.1} Z`} fill={fill} stroke={INK} strokeWidth={Math.max(1, s * 0.08)} strokeLinejoin="round" />;
  return (
    <g className="flat-marks" pointerEvents="none">
      {raiders.map((n, hex) => {
        if (!n) return null;
        const h = board.hexes[hex];
        const [hx, hy] = P(h.x, h.z);
        const d = raidersAt(state, h, k, discsOf(state, h).length, h.terrain !== 'lake', harbours);
        return d && <Raider key={`raider${hex}`} x={hx + d.dx} y={hy + d.dy} r={d.r} n={n} />;
      })}
      {corsair !== null && (() => {
        const h = board.hexes[corsair];
        const [hx, hy] = P(h.x, h.z);
        // On its hex's middle, unless that is where a harbour's badge or the hex's disc is: then to the side with most room.
        const avoid: Avoid[] = [];
        for (const b of harbourSpots(board, state.ext.sea?.fog?.hidden ?? NONE)) avoid.push({ x: b.x - h.x, z: b.z - h.z, r: harbourRadius(k) / k });
        if (numbersOf(state, h).length > 0) avoid.push({ x: 0, z: 0, r: 0.29 });
        h.edges.forEach((e) => {
          const ed = board.edges[e];
          if (state.routes[e]) avoid.push({ x: board.vertices[ed.a].x - h.x, z: board.vertices[ed.a].z - h.z, to: [board.vertices[ed.b].x - h.x, board.vertices[ed.b].z - h.z], r: 0.12 });
        });
        const cands: [number, number][] = [[0, 0]];
        for (const deg of [-90, -30, 30, 90, 150, 210]) cands.push([Math.cos((deg * Math.PI) / 180) * 0.4, Math.sin((deg * Math.PI) / 180) * 0.4]);
        const [cx, cz] = clearSpot(cands, 0.3, avoid);
        return <g aria-label="The corsair">{sail(hx + cx * k, hy + cz * k, k * 0.45, '#1f1b19')}</g>;
      })()}
      {trader && (() => {
        // The trader stands on its hex beside the disc (as the robber does, on the other side), clear
        // of the icon, the discs, the raiders, the robber and the pieces round the rim.
        const h = board.hexes[trader.hex];
        const [hx, hy] = P(h.x, h.z);
        const discs = discsOf(state, h).length, icon = h.terrain !== 'lake';
        const avoid: Avoid[] = [];
        h.vertices.forEach((v) => {
          if (state.buildings[v]) avoid.push({ x: board.vertices[v].x - h.x, z: board.vertices[v].z - h.z - 0.1, r: 0.36 });
        });
        h.edges.forEach((e) => {
          if (!state.routes[e]) return;
          const ed = board.edges[e];
          avoid.push({ x: board.vertices[ed.a].x - h.x, z: board.vertices[ed.a].z - h.z, to: [board.vertices[ed.b].x - h.x, board.vertices[ed.b].z - h.z], r: 0.1 });
        });
        for (const d of discSpots(discs, k, icon)) avoid.push({ x: d.dx / k, z: d.dy / k, r: d.r / k });
        if (icon) avoid.push(discs === 0 ? { x: 0, z: 0, r: 0.42, w: 2 } : { x: 0, z: discs > 2 ? -0.5 : discs > 1 ? -0.4 : -0.34, r: discs > 1 ? 0.27 : 0.3, w: 2 });
        const raid = raidersAt(state, h, k, discs, icon, harbours);
        if (raid) avoid.push({ x: raid.dx / k, z: raid.dy / k, r: raid.r / k });
        if (state.robberHex === h.id) avoid.push({ x: -0.5, z: 0.05, r: 0.36 });
        for (const b of harbours) avoid.push({ x: b.x - h.x, z: b.z - h.z, r: harbourRadius(k) / k });
        const size = Math.max(9, k * 0.24);
        const [tx, tz] = ringSpot([1, 0.15], size / k, avoid, 0.52);
        const pal = PLAYER_PALETTE[colors[trader.owner]];
        const name = state.players[trader.owner]?.name ?? 'someone';
        return (
          <TraderStall
            key="trader"
            x={hx + tx * k}
            y={hy + tz * k}
            s={size}
            color={pal.ui}
            trim="#f3e8cc"
            label={`The trader, held by ${name}: a point while held, and 2:1 trades in this hex's resource`}
            mark={<g fill={pal.ui} stroke={INK} strokeWidth={0.32}>{markPath(trader.owner, 0, 0, 1)}</g>}
          />
        );
      })()}
      {trains.flatMap((t) =>
        t.edges.map((e) => {
          const ed = board.edges[e];
          const a = board.vertices[ed.a], b = board.vertices[ed.b];
          const [x, y] = P((a.x + b.x) / 2, (a.z + b.z) / 2);
          if (!ed.land) return <g key={`wagon${e}`}>{sail(x, y, k * 0.28, '#efe4c8')}</g>;
          // (On a cracked road the wagon stands on the far half, clear of the crack: see Pieces.)
          const [t0, t1] = state.routes[e]?.cracked ? (crackAtOf(board, joinedEnds, e) > 0.5 ? [0.22, 0.5] : [0.5, 0.78]) : [0.3, 0.7];
          const [ax, ay] = P(a.x + (b.x - a.x) * t0, a.z + (b.z - a.z) * t0), [bx, by] = P(a.x + (b.x - a.x) * t1, a.z + (b.z - a.z) * t1);
          return <line key={`wagon${e}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="#7a5432" strokeWidth={Math.max(3, k * 0.1)} strokeLinecap="butt" />;
        }),
      )}
      {state.wardens.map((w) => {
        let x: number, y: number;
        if (w.edge !== null) {
          const ed = board.edges[w.edge];
          const a = board.vertices[ed.a], b = board.vertices[ed.b];
          [x, y] = P((a.x + b.x) / 2, (a.z + b.z) / 2);
        } else if (w.vertex !== null) [x, y] = P(board.vertices[w.vertex].x + 0.14, board.vertices[w.vertex].z + 0.1);
        else return null;
        const pal = PLAYER_PALETTE[colors[w.owner]];
        const s = Math.max(5, k * 0.14);
        return (
          <g key={`warden${w.id}`}>
            <path d={`M${x - s} ${y - s} h${s * 2} v${s} q0 ${s * 0.9} ${-s} ${s * 1.3} q${-s} ${-s * 0.4} ${-s} ${-s * 1.3} Z`} fill={w.mustered ? pal.ui : '#f2ead8'} stroke={pal.ui} strokeWidth={Math.max(1.5, s * 0.25)} />
            {Array.from({ length: w.rank }, (_, i) => (
              <line key={i} x1={x - s * 0.5} x2={x + s * 0.5} y1={y - s * 0.55 + i * s * 0.45} y2={y - s * 0.55 + i * s * 0.45} stroke={w.mustered ? pal.trim : pal.ui} strokeWidth={Math.max(1, s * 0.18)} />
            ))}
          </g>
        );
      })}
      {state.buildings.map((bld, v) => {
        if (!bld || !(bld.wall || bld.seat || bld.foundry)) return null;
        const [x, y] = P(board.vertices[v].x, board.vertices[v].z);
        const s = buildingSize(bld.kind, k);
        return (
          <g key={`badge${v}`}>
            {bld.wall && <WallBase x={x} y={y} s={s} />}
            {bld.seat && <path d={`M${x - s * 0.9} ${y - s * 0.2} V${y - s * 1.6} l${s * 0.7} ${s * 0.25} l${-s * 0.7} ${s * 0.25}`} fill={PLAYER_PALETTE[colors[bld.owner]].ui} stroke={INK} strokeWidth={Math.max(1, s * 0.1)} />}
            {bld.foundry && <rect x={x + s * 0.55} y={y - s * 1.5} width={s * 0.3} height={s * 0.9} fill="#3a3532" stroke={INK} strokeWidth={Math.max(1, s * 0.08)} />}
          </g>
        );
      })}
    </g>
  );
}

/** A city wall: a low stone rampart with battlements at the building's foot, under it rather than round it. */
function WallBase({ x, y, s }: { x: number; y: number; s: number }) {
  const x0 = x - s * 1.2;
  const w = s * 2.4;
  const top = y + s * 0.84;
  const h = s * 0.46;
  const merlon = s * 0.2;
  // Five merlons and four gaps along the top, then down and round the base.
  const step = w / 9;
  let d = `M${x0} ${top + h} V${top}`;
  for (let i = 0; i < 9; i++) d += i % 2 === 0 ? ` v${-merlon} h${step} v${merlon}` : ` h${step}`;
  d += ` V${top + h} Z`;
  const ink = Math.max(1, s * 0.12);
  return (
    <g aria-label="Town wall">
      <path d={d} fill={HALO} fillOpacity="0.9" stroke={HALO} strokeOpacity="0.9" strokeWidth={ink + Math.max(3, s * 0.35)} strokeLinejoin="round" />
      <path d={d} fill="#b8afa0" stroke={INK} strokeOpacity="0.9" strokeWidth={ink} strokeLinejoin="round" />
    </g>
  );
}

// ------------------------------------------------------------------- spots

/**
 * On your turn with nothing being placed: unmarked targets over every spot a road, house or town
 * could go (game/commands.ts quickSpots), so a press there builds that piece; pointed at, its ghost.
 */
function QuickSpots({ board, layout, pointer }: { board: Board; layout: Layout; pointer: React.MutableRefObject<string> }) {
  const focus = useUI((s) => s.boardFocus);
  const me = useUI((s) => s.me);
  const myColor = useUI((s) => s.view?.players[s.me]?.color ?? 'red');
  const q = quickSpots();
  if (!q) return null;
  const P = proj(layout);
  const { k } = layout;
  const events = (kind: 'vertex' | 'edge', id: number) => ({
    onPointerDown: (e: React.PointerEvent) => (pointer.current = e.pointerType),
    onPointerEnter: (e: React.PointerEvent) => e.pointerType === 'mouse' && session.input?.hoverSpot(kind, id, e.clientX, e.clientY),
    onPointerLeave: (e: React.PointerEvent) => e.pointerType === 'mouse' && session.input?.hoverSpot(null, -1, 0, 0),
    onClick: () => session.input?.pressSpot(kind, id, pointer.current),
  });
  const ends = (id: number) => {
    const ed = board.edges[id];
    return [P(board.vertices[ed.a].x, board.vertices[ed.a].z), P(board.vertices[ed.b].x, board.vertices[ed.b].z)] as const;
  };
  const corners = [...q.houses, ...q.towns];
  return (
    <g className="flat-spots quick">
      {/* (The edges first: a corner's target sits over the ends of the edges that meet there.) */}
      {q.roads.map((id) => {
        const [a, b] = ends(id);
        return <line key={`e${id}`} className="flat-hit" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...events('edge', id)} />;
      })}
      {corners.map((id) => {
        const [x, y] = P(board.vertices[id].x, board.vertices[id].z);
        return <circle key={`v${id}`} className="flat-hit" cx={x} cy={y} r={Math.max(18, k * 0.28)} {...events('vertex', id)} />;
      })}
      {focus?.kind === 'vertex' && corners.includes(focus.id) && (() => {
        const [x, y] = P(board.vertices[focus.id].x, board.vertices[focus.id].z);
        return <Building kind={q.towns.includes(focus.id) ? 'city' : 'settlement'} seat={me} color={myColor} x={x} y={y} k={k} ghost />;
      })()}
      {focus?.kind === 'edge' && q.roads.includes(focus.id) && <Road a={ends(focus.id)[0]} b={ends(focus.id)[1]} color={myColor} k={k} ghost />}
    </g>
  );
}

/** While placing: the legal spots (pulsing), the one being previewed as a ghost, and their targets. */
function Spots({ board, layout }: { board: Board; layout: Layout }) {
  const it = useUI((s) => s.interaction);
  const focus = useUI((s) => s.boardFocus);
  const me = useUI((s) => s.me);
  const myColor = useUI((s) => s.view?.players[s.me]?.color ?? 'red');
  const P = proj(layout);
  const { k } = layout;
  const pointer = useRef('mouse');
  // (Redrawn as the state changes: what can be built without choosing the piece first goes with it.)
  useUI((s) => s.view);
  useUI((s) => s.busy);
  const sp = interactionSpots(it);
  if (!sp || sp.ids.length === 0) return <QuickSpots board={board} layout={layout} pointer={pointer} />;
  const { kind, ids } = sp;
  const events = (id: number) => ({
    onPointerDown: (e: React.PointerEvent) => (pointer.current = e.pointerType),
    onPointerEnter: (e: React.PointerEvent) => e.pointerType === 'mouse' && session.input?.hoverSpot(kind, id, e.clientX, e.clientY),
    onPointerLeave: (e: React.PointerEvent) => e.pointerType === 'mouse' && session.input?.hoverSpot(null, -1, 0, 0),
    onClick: () => session.input?.pressSpot(kind, id, pointer.current),
  });
  const hit = Math.max(22, k * 0.36);
  const ghost = focus && focus.kind === kind && ids.includes(focus.id) ? focus.id : -1;
  return (
    <g className="flat-spots">
      {ids.map((id) => {
        if (kind === 'vertex') {
          const [x, y] = P(board.vertices[id].x, board.vertices[id].z);
          return (
            <g key={id}>
              <circle className="flat-spot" cx={x} cy={y} r={Math.max(6, k * 0.15)} />
              <circle className="flat-hit" cx={x} cy={y} r={hit} {...events(id)} />
            </g>
          );
        }
        if (kind === 'edge') {
          const ed = board.edges[id];
          const a = P(board.vertices[ed.a].x, board.vertices[ed.a].z), b = P(board.vertices[ed.b].x, board.vertices[ed.b].z);
          const p = [a[0] + (b[0] - a[0]) * 0.26, a[1] + (b[1] - a[1]) * 0.26], q = [a[0] + (b[0] - a[0]) * 0.74, a[1] + (b[1] - a[1]) * 0.74];
          return (
            <g key={id}>
              <line className="flat-spot" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />
              <line className="flat-hit" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...events(id)} />
            </g>
          );
        }
        const corners = hexCorners(board, id, P, 0.9);
        return (
          <g key={id}>
            <polygon className="flat-spot hex" points={pts(corners)} />
            <polygon className="flat-hit" points={pts(hexCorners(board, id, P))} {...events(id)} />
          </g>
        );
      })}
      {ghost >= 0 && kind === 'vertex' && (() => {
        const [x, y] = P(board.vertices[ghost].x, board.vertices[ghost].z);
        return <Building kind={it.kind === 'city' ? 'city' : 'settlement'} seat={me} color={myColor} x={x} y={y} k={k} ghost />;
      })()}
      {ghost >= 0 && kind === 'edge' && (() => {
        const ed = board.edges[ghost];
        return <Road a={P(board.vertices[ed.a].x, board.vertices[ed.a].z)} b={P(board.vertices[ed.b].x, board.vertices[ed.b].z)} color={myColor} k={k} ghost />;
      })()}
      {ghost >= 0 && kind === 'hex' && <polygon className="flat-spot hex chosen" points={pts(hexCorners(board, ghost, P, 0.9))} />}
    </g>
  );
}

// -------------------------------------------------------------------- dice

/**
 * The dice on the flat map: two small cubes thrown in from the lower right. They strike the table
 * with the sound's first knock, bounce twice, tumble across it, rock to rest on the rolled faces,
 * then lift away. (Times in seconds, at normal speed; the sound's hits are in audio/sounds.ts.)
 */
const IMPACT = 0.14;
const SETTLED = 0.95;
const HOLD = 1.7;

/** Pips on a face, in a 3 x 3 grid (1 to 9, reading order). */
const PIP_CELLS: Record<number, number[]> = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

/** Which face is where on the cube, and how to turn the cube to show each one on top. */
const FACES: { n: number; place: string }[] = [
  { n: 1, place: 'rotateY(0deg)' },
  { n: 6, place: 'rotateY(180deg)' },
  { n: 2, place: 'rotateY(90deg)' },
  { n: 5, place: 'rotateY(-90deg)' },
  { n: 3, place: 'rotateX(90deg)' },
  { n: 4, place: 'rotateX(-90deg)' },
];
const SHOW: Record<number, [number, number]> = { 1: [0, 0], 6: [0, 180], 2: [0, -90], 5: [0, 90], 3: [-90, 0], 4: [90, 0] };

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function Cube({ red, event = false }: { red: boolean; event?: boolean }) {
  return (
    <div className="fd-cube">
      {FACES.map((f) => (
        <div key={f.n} className={`fd-face${event ? ' event-face' : ''}`} style={{ transform: `${f.place} translateZ(calc(var(--die) / 2))` }}>
          {event ? <EventDieIcon face={VALUE_EVENT[f.n - 1]} /> : PIP_CELLS[f.n].map((c) => (
            <i key={c} className={red ? 'red' : undefined} style={{ gridArea: `${Math.ceil(c / 3)} / ${((c - 1) % 3) + 1}` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One die's throw: where it strikes, rolls to and rests, and how it turns on the way. */
function throwDie(el: HTMLElement, face: number, i: number, size: number, speed: number, still = false, count = 2) {
  const ms = (HOLD * 1000) / speed;
  const at = (t: number) => t / HOLD;
  const fx = (i - (count - 1) / 2) * 1.24 * size + rnd(-4, 4), fy = rnd(-5, 5);
  const ix = fx + size * rnd(1.5, 1.9), iy = fy + size * rnd(0.9, 1.2);
  const sx = ix + size * 1.9, sy = iy + size * 1.3;
  const along = (u: number) => `${ix + (fx - ix) * u}px, ${iy + (fy - iy) * u}px`;
  if (still) {
    // Reduced motion: the dice are simply there, face up.
    const [X, Y] = SHOW[face];
    el.style.transform = `translate(${along(1)})`;
    el.querySelector<HTMLElement>('.fd-cube')!.style.transform = `rotateX(${X}deg) rotateY(${Y}deg)`;
    return;
  }
  // The second die a beat behind the first, as in the sound.
  const lag = i * 0.03;
  const off = (t: number) => at(Math.min(HOLD, t + lag));
  el.animate(
    [
      { offset: 0, transform: `translate(${sx}px, ${sy}px) scale(1.7)`, opacity: 0, easing: 'cubic-bezier(.4,0,.9,.6)' },
      { offset: off(0.04), opacity: 1 },
      { offset: off(IMPACT), transform: `translate(${along(0)}) scale(1)`, easing: 'cubic-bezier(.2,.6,.5,1)' },
      { offset: off(0.19), transform: `translate(${along(0.1)}) scale(1.13)`, easing: 'cubic-bezier(.5,0,.9,.5)' },
      { offset: off(0.23), transform: `translate(${along(0.18)}) scale(1)`, easing: 'cubic-bezier(.2,.6,.5,1)' },
      { offset: off(0.255), transform: `translate(${along(0.23)}) scale(1.05)`, easing: 'cubic-bezier(.5,0,.9,.5)' },
      { offset: off(0.28), transform: `translate(${along(0.28)}) scale(1)`, easing: 'cubic-bezier(.25,.7,.35,1)' },
      { offset: off(0.75), transform: `translate(${along(1)}) scale(1)` },
      { offset: 1, transform: `translate(${along(1)}) scale(1)`, opacity: 1 },
    ],
    { duration: ms, fill: 'both' },
  );
  // Tumbling the way it travels, slowing, then rocking to rest square-ish to the table.
  const [X, Y] = SHOW[face];
  const Z = Math.round(rnd(-1, 1) * 2) * 90 + rnd(-14, 14);
  const turns = (n: number) => 360 * n;
  const rot = (x: number, y: number, z: number) => `rotateZ(${z}deg) rotateX(${x}deg) rotateY(${y}deg)`;
  const x0 = X - turns(2) - rnd(30, 150), y0 = Y + turns(1) + rnd(30, 150), z0 = Z + rnd(-60, 60);
  el.querySelector<HTMLElement>('.fd-cube')!.animate(
    [
      { offset: 0, transform: rot(x0, y0, z0), easing: 'cubic-bezier(.15,.5,.3,1)' },
      { offset: off(0.62), transform: rot(X + 9, Y - 5, Z), easing: 'ease-in-out' },
      { offset: off(0.68), transform: rot(X - 5, Y + 3, Z), easing: 'ease-in-out' },
      { offset: off(0.72), transform: rot(X + 2, Y - 1, Z), easing: 'ease-in-out' },
      { offset: off(0.76), transform: rot(X, Y, Z) },
      { offset: 1, transform: rot(X, Y, Z) },
    ],
    { duration: ms, fill: 'both' },
  );
}

/** On the flat map the dice are thrown onto the middle of the board, and the roll's sound with them. */
function FlatDice({ layout }: { layout: Layout }) {
  const roll = useUI((s) => s.diceRoll);
  const speed = useUI(speedOf);
  const [shown, setShown] = useState<{ id: number; faces: number[]; event?: EventDieResult; total: number } | null>(null);
  const first = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const size = Math.min(58, Math.max(34, layout.k * 0.56));
  useEffect(() => {
    // (Not for the roll already on the table when the map comes in.)
    if (first.current) {
      first.current = false;
      return;
    }
    if (!roll) return;
    setShown({ id: roll.id, faces: throwFaces(roll.dice, roll.event), event: roll.event, total: roll.dice[0] + roll.dice[1] });
    const knock = setTimeout(() => sfx.play('dice'), (IMPACT * 1000) / speed);
    const gone = setTimeout(() => setShown(null), ((HOLD + 0.45) * 1000) / speed);
    return () => {
      clearTimeout(knock);
      clearTimeout(gone);
    };
  }, [roll?.id]);
  useEffect(() => {
    if (!shown || !box.current) return;
    const still = reducedMotion();
    box.current.querySelectorAll<HTMLElement>('.fd-die').forEach((el, i) => throwDie(el, shown.faces[i], i, size, speed, still, shown.faces.length));
    // (With Reduce motion they fade where they lie, as the dice landed without their throw.)
    const lift = box.current.animate([{ opacity: 1 }, still ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-8%) scale(0.92)' }], { duration: 400 / speed, delay: (HOLD * 1000) / speed, easing: 'ease-in', fill: 'forwards' });
    return () => lift.cancel();
  }, [shown?.id]);
  if (!shown) return null;
  const seven = shown.total === 7;
  return (
    <div ref={box} key={shown.id} className={`flat-dice${seven ? ' seven' : ''}`} style={{ left: layout.cx, top: layout.cy, ['--die' as string]: `${size}px` } as CSSProperties} aria-hidden>
      {shown.event?.independentRed && <span className="fd-card-total">card total {shown.total}</span>}
      {shown.faces.map((_, i) => (
        <div key={i} className={`fd-die${(i === 0 && shown.event && !shown.event.independentRed || i === 3) ? ' red-body' : ''}`}>
          <div className="fd-shadow" />
          <Cube red={i === 1 && !shown.event} event={i === 2} />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ switch

/** The 2D/3D switch: which view is on, and a press (or V) for the other. */
export function ViewToggle() {
  const mode = useUI((s) => s.viewMode);
  const flat = mode === '2d';
  return (
    <button
      type="button"
      className={`view-toggle${flat ? ' flat' : ''}`}
      aria-pressed={flat}
      aria-label="Flat map (V)"
      title={flat ? 'Back to the 3D island (V)' : 'Flat map (V)'}
      onClick={toggleView}
    >
      <span className="vt-knob" aria-hidden />
      <span className={`vt-opt${flat ? '' : ' on'}`} aria-hidden>
        3D
      </span>
      <span className={`vt-opt${flat ? ' on' : ''}`} aria-hidden>
        2D
      </span>
    </button>
  );
}

