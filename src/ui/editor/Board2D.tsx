// The editor's flat board: the map in the flat map's own art (ui/FlatBoard.tsx), over the grid of
// cells that can be painted. One finger (or the mouse) paints across cells or taps; two fingers
// pan and pinch, as do the wheel and a right- or middle-drag. Each change lands with its own
// motion: a tile stamps down with a ring of surf, an erased one sinks away, a disc flips on, a
// harbour's badge drops onto its pier, the fog rolls in. Previewing a deal draws one game's island.

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react';
import { CORNER_OFFSETS, hexCenter } from '../../engine/board';
import { TERRAIN_RESOURCE, isLand } from '../../engine/constants';
import { centreOf, mouthSide, type CellTerrain } from '../../engine/maps/custom';
import type { Terrain } from '../../engine';
import { CARD_ICON, CARD_NAMES, TERRAIN_NAMES, asset } from '../../game/names';
import { FILL, HarbourBadge, NumberDisc } from '../FlatBoard';
import { BountyGlyph, CastleGlyph, FishingGround, FlatDefs, Mist, OasisGlyph, OilWellGlyph, SwampGlyph, TileGround, discSpots, harbourRadius } from '../flatArt';
import { aimAt, cellAt, gridOf, isBrush, key, robberCell, shownCells, shownPorts, sideCorners, turnsOf } from './model';
import { applyTool, useEditor } from './store';
import { LineIcon } from '../LineIcons';

type Pt = [number, number];
const pts = (p: Pt[]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** A stable small id per cell, for TileGround's scatter (the same cell always looks the same). */
const cellSeed = (q: number, r: number) => ((q + 11) * 31 + (r + 11)) % 997;

const RANDOM_FILL = '#e9dcbd';

/** Pan and zoom: the scale over the fitted one, and the offset of the middle in px. */
interface View {
  s: number;
  x: number;
  y: number;
}
const FIT: View = { s: 1, x: 0, y: 0 };

/** The world box (x, z) the board fits to: the grid's, kept as it was while a stroke is under way. */
interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
const sameBox = (a: Box, b: Box) => a.x0 === b.x0 && a.x1 === b.x1 && a.z0 === b.z0 && a.z1 === b.z1;

/** How the room frames a box: px per world unit, and the world point at its middle. */
function framing(box: Box, w: number, h: number) {
  const k = Math.max(10, Math.min((w - 24) / (box.x1 - box.x0 + 1.2), (h - 24) / (box.z1 - box.z0 + 1.2)));
  return { k, bx: (box.x0 + box.x1) / 2, bz: (box.z0 + box.z1) / 2 };
}

type Gesture =
  | { kind: 'pending'; id: number; x0: number; y0: number; timer: ReturnType<typeof setTimeout> }
  | { kind: 'paint'; done: Set<string> }
  | { kind: 'pan'; lx: number; ly: number }
  | { kind: 'pinch'; d0: number; mx0: number; my0: number; view0: View };

/**
 * Where the flat board draws the grid: the point on the page of the board's middle (world 0, 0),
 * and px per world unit. The 3D view lays its camera over it, to turn one into the other in place.
 */
export const flatLayout: { current: { x: number; y: number; k: number } | null } = { current: null };

/** `hidden`: laid out (and measured) but not shown, faded out or about to fade in. */
export function Board2D({ hidden = false }: { hidden?: boolean }) {
  const map = useEditor((s) => s.map);
  const fitTick = useEditor((s) => s.fit);
  const tool = useEditor((s) => s.tool);
  const change = useEditor((s) => s.change);
  const preview = useEditor((s) => s.preview);
  const brush = useEditor((s) => s.brush);
  const symmetry = useEditor((s) => s.symmetry);
  const drawing = useEditor((s) => s.drawing);
  const wrap = useRef<HTMLDivElement>(null);
  // `top`: the room the undo, redo and view buttons take over the board's top edge, kept clear.
  // (`x`, `y`: where the board is on the page.)
  const [size, setSize] = useState({ w: 800, h: 600, top: 0, x: 0, y: 0 });
  const [view, setView] = useState<View>(FIT);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const float = document.querySelector('.ed-float')?.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const top = float ? Math.max(0, Math.min(el.clientHeight / 3, float.bottom - box.top)) : 0;
      setSize({ w: el.clientWidth, h: el.clientHeight, top, x: box.left, y: box.top });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    // (The wheel and a trackpad's pinch zoom the board, not the page: React's own listener can't stop them.)
    const mine = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', mine, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', mine);
    };
  }, []);
  // The grid fits the room, and the board is framed on it: refitted only when its bounds change,
  // and not while a stroke is under way (the board would slide under the brush). A view the person
  // has moved keeps its place on the page through a refit (their zoom and pan are theirs).
  const grid = gridOf(map);
  const painting = useRef(false);
  const [settle, setSettle] = useState(0);
  const [box, setBox] = useState<Box>(grid.box);
  const room = { w: size.w, h: size.h - size.top };
  const fitSeen = useRef(fitTick);
  useEffect(() => {
    if (fitTick !== fitSeen.current) {
      fitSeen.current = fitTick;
      setView(FIT);
      setBox(grid.box);
      return;
    }
    if (painting.current || sameBox(box, grid.box)) return;
    const before = framing(box, room.w, room.h), after = framing(grid.box, room.w, room.h);
    setView((v) => {
      if (v.s === 1 && v.x === 0 && v.y === 0) return v;
      // (The same px per unit and the same place on the page: the offsets move with the middle.)
      const k0 = before.k * v.s;
      return { s: k0 / after.k, x: v.x + (after.bx - before.bx) * k0, y: v.y + (after.bz - before.bz) * k0 };
    });
    setBox(grid.box);
  }, [grid.box, settle, fitTick]);
  const { k: fit, bx, bz } = framing(box, room.w, room.h);
  const k = fit * view.s;
  const midY = (size.h + size.top) / 2;
  const cx = size.w / 2 + view.x, cy = midY + view.y;
  useLayoutEffect(() => {
    flatLayout.current = { x: size.x + cx - bx * k, y: size.y + cy - bz * k, k };
  });
  const P = (x: number, z: number): Pt => [cx + (x - bx) * k, cy + (z - bz) * k];
  const toWorld = (px: number, py: number): Pt => [(px - cx) / k + bx, (py - cy) / k + bz];
  const corners = (q: number, r: number, s = 1): Pt[] => {
    const [x, z] = hexCenter(q, r);
    return CORNER_OFFSETS.map(([dx, dz]) => P(x + dx * s, z + dz * s));
  };
  const zoomAt = (px: number, py: number, s: number, from: View = view) => {
    const s1 = Math.max(0.6, Math.min(4, s));
    // (The point under the pointer stays put.)
    const k0 = fit * from.s, k1 = fit * s1;
    const wx = (px - (size.w / 2 + from.x)) / k0, wy = (py - (midY + from.y)) / k0;
    return { s: s1, x: px - size.w / 2 - wx * k1, y: py - midY - wy * k1 };
  };

  // ---------------------------------------------------------------- pointing
  const [hover, setHover] = useState<Pt | null>(null);
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture | null>(null);
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const rect = wrap.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  const paintAt = (px: number, py: number, stroke: boolean) => {
    const g = gesture.current;
    const [x, z] = toWorld(px, py);
    if (g?.kind === 'paint') {
      const c = key(...cellAt(x, z));
      if (g.done.has(c)) return;
      g.done.add(c);
    }
    applyTool(x, z, stroke);
  };
  const startPaint = (px: number, py: number) => {
    painting.current = true;
    gesture.current = { kind: 'paint', done: new Set() };
    paintAt(px, py, false);
  };
  const pinchOf = () => {
    const [a, b] = [...pointers.current.values()];
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
  };
  const down = (e: ReactPointerEvent) => {
    const p = local(e);
    // (On the board, not the cell under it: a paint replaces that cell, and the capture would go
    // with it, so a stroke let go over the dock would never end.)
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g?.kind === 'pending') clearTimeout(g.timer);
    if (pointers.current.size === 2) {
      // A second finger: no painting, but a pinch (whatever the first had begun is left as it is).
      const { d, mx, my } = pinchOf();
      gesture.current = { kind: 'pinch', d0: d, mx0: mx, my0: my, view0: view };
      return;
    }
    if (pointers.current.size > 2) return;
    if (e.pointerType === 'mouse') {
      if (e.button === 1 || e.button === 2 || e.altKey) gesture.current = { kind: 'pan', lx: p[0], ly: p[1] };
      else if (e.button === 0) {
        if (isBrush(tool)) startPaint(...p);
        else {
          gesture.current = null;
          paintAt(...p, false);
        }
      }
      return;
    }
    // A finger: a tap, a paint stroke or a pan, decided by what it does next (or by a short hold, for a brush).
    const timer = setTimeout(() => {
      if (gesture.current?.kind === 'pending' && pointers.current.size === 1 && isBrush(useEditor.getState().tool)) startPaint(p[0], p[1]);
    }, 110);
    gesture.current = { kind: 'pending', id: e.pointerId, x0: p[0], y0: p[1], timer };
  };
  const move = (e: ReactPointerEvent) => {
    const p = local(e);
    if (e.pointerType !== 'touch') setHover(toWorld(...p));
    if (!pointers.current.has(e.pointerId)) return;
    const last = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const { d, mx, my } = pinchOf();
      const zoomed = zoomAt(g.mx0, g.my0, g.view0.s * (d / Math.max(1, g.d0)), g.view0);
      setView({ ...zoomed, x: zoomed.x + mx - g.mx0, y: zoomed.y + my - g.my0 });
    } else if (g.kind === 'pan') {
      setView((v) => ({ ...v, x: v.x + p[0] - g.lx, y: v.y + p[1] - g.ly }));
      gesture.current = { kind: 'pan', lx: p[0], ly: p[1] };
    } else if (g.kind === 'pending' && Math.hypot(p[0] - g.x0, p[1] - g.y0) > 8) {
      clearTimeout(g.timer);
      if (isBrush(tool)) {
        startPaint(g.x0, g.y0);
        paintAt(...p, true);
      } else gesture.current = { kind: 'pan', lx: last[0], ly: last[1] };
    } else if (g.kind === 'paint') paintAt(...p, true);
  };
  const up = (e: ReactPointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (g?.kind === 'pending' && g.id === e.pointerId) {
      clearTimeout(g.timer);
      gesture.current = null;
      paintAt(g.x0, g.y0, false);
      return;
    }
    if (pointers.current.size === 0) {
      gesture.current = null;
      // (The stroke is over: the board takes in the grid it grew.)
      if (painting.current) {
        painting.current = false;
        setSettle((n) => n + 1);
      }
    }
  };
  const wheel = (e: ReactWheelEvent) => {
    const p = local(e);
    setView((v) => zoomAt(p[0], p[1], v.s * Math.exp(-e.deltaY * 0.0015), v));
  };

  // ---------------------------------------------------------------- what's drawn
  const cells = grid.cells;
  const pivot = useMemo(() => centreOf(map), [map]);
  const shown = useMemo(() => shownCells(map, preview), [map, preview]);
  const ports = useMemo(() => shownPorts(map, preview), [map, preview]);
  const byCell = new Set(shown.map((h) => key(h.q, h.r)));
  const landish = (t: CellTerrain) => t === 'random' || isLand(t as Terrain);
  const land = shown.filter((h) => landish(h.terrain));
  const sea = shown.filter((h) => !landish(h.terrain));
  const robber = robberCell(map, shown);
  const fresh = new Set(change.cells);
  const r1 = Math.max(8, k * 0.3);

  // The pointer's target, as the tool sees it: cells (with the brush and their images round the middle), or a coast side.
  const aim =
    hover && preview === null
      ? aimAt(map, tool, hover[0], hover[1], brush, symmetry, pivot).map(({ q, r, side, ghost }, i) => {
          if (side === undefined) return <polygon key={i} className={`ed-aim ${tool.kind}${ghost ? ' ghost' : ''}`} points={pts(corners(q, r, 0.97))} strokeWidth={Math.max(2, k * 0.06)} />;
          const [a, b] = sideCorners(q, r, side).map(([x, z]) => P(x, z));
          return <line key={i} className={`ed-aim-side${ghost ? ' ghost' : ''}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth={Math.max(4, k * 0.14)} />;
        })
      : null;

  return (
    <div
      ref={wrap}
      className={`ed-board2d tool-${tool.kind}${preview !== null ? ' previewing' : ''}${hidden ? ' hidden' : ''}`}
      aria-hidden={hidden || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onPointerLeave={() => setHover(null)}
      onWheel={wheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="ed-svg" width={size.w} height={size.h} role="img" aria-label={`${map.name}: ${land.length} land hexes`}>
        <FlatDefs k={k} />
        {/* The symmetry's axes, faint, through the middle. */}
        {symmetry > 1 && (
          <g className="ed-axes" aria-hidden>
            {turnsOf(symmetry).map((t) => {
              const a = ((-90 + 60 * t) * Math.PI) / 180;
              // (From the map's centre, out past the grid's edge.)
              const R = Math.max(grid.box.x1 - grid.box.x0, grid.box.z1 - grid.box.z0);
              const [ox, oy] = P(...hexCenter(...pivot));
              return <line key={t} x1={ox} y1={oy} x2={ox + Math.cos(a) * R * k} y2={oy + Math.sin(a) * R * k} strokeWidth={Math.max(1, k * 0.03)} />;
            })}
          </g>
        )}
        {/* The grid: every cell that can be painted. */}
        <g className="ed-grid" aria-hidden>
          {cells.map(([q, r]) => (byCell.has(key(q, r)) ? null : <polygon key={key(q, r)} points={pts(corners(q, r, 0.94))} strokeWidth={Math.max(1, k * 0.025)} />))}
        </g>
        {/* Open water the ships may sail. */}
        <g aria-hidden>
          <AnimatePresence>
            {sea.map((h) => (
              <motion.polygon key={key(h.q, h.r)} className="ed-sea" points={pts(corners(h.q, h.r, 0.97))} strokeWidth={Math.max(1, k * 0.03)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} />
            ))}
          </AnimatePresence>
        </g>
        {/* The beach round the land, as the flat map lays it. */}
        <g aria-hidden>
          {land.map((h) => (
            <polygon key={`s${key(h.q, h.r)}`} points={pts(corners(h.q, h.r, 1.16))} fill="#3a93bf" opacity="0.55" />
          ))}
          {land.map((h) => (
            <polygon key={`b${key(h.q, h.r)}`} points={pts(corners(h.q, h.r, 1.07))} fill="#e7d4a2" />
          ))}
        </g>
        <AnimatePresence>
          {land.map((h) => {
            const [x, y] = P(...hexCenter(h.q, h.r));
            const discs = h.numbers.length + (h.owed ? 1 : 0);
            return (
              <motion.g
                key={`${key(h.q, h.r)}:${h.terrain}:${preview ?? ''}`}
                className="ed-tile"
                style={{ transformOrigin: `${x}px ${y}px`, transformBox: 'view-box' }}
                initial={{ scale: 0.3, y: -k * 0.7, opacity: 0 }}
                animate={{ scale: 1, y: 0, opacity: 1 }}
                exit={{ scale: 0.55, y: k * 0.25, opacity: 0, transition: { duration: 0.24, ease: 'easeIn' } }}
                transition={{ type: 'spring', duration: 0.5, bounce: 0.45, delay: preview !== null ? (Math.hypot(h.q, h.r) % 5) * 0.03 : 0 }}
              >
                <polygon points={pts(corners(h.q, h.r))} fill={h.terrain === 'random' ? RANDOM_FILL : FILL[h.terrain]} />
                {h.terrain === 'random' ? <RandomFace x={x} y={y} k={k} bare={discs === 0} /> : <TileGround terrain={h.terrain} id={cellSeed(h.q, h.r)} x={x} y={y} k={k} corners={corners(h.q, h.r)} />}
                {h.terrain !== 'random' && <TerrainIcon terrain={h.terrain} x={x} y={y} k={k} discs={discs} />}
              </motion.g>
            );
          })}
        </AnimatePresence>
        {/* Rivers, from spring to sea. */}
        <g aria-hidden pointerEvents="none">
          {(map.rivers ?? []).map((rv, i) => {
            const mids = rv.path.map(([q, r]) => P(...hexCenter(q, r)));
            const ms = mouthSide({ hexes: shown }, rv.path);
            if (ms >= 0) {
              const [a, b] = sideCorners(...rv.path[rv.path.length - 1], ms);
              mids.push(P((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
            }
            const d = mids.map(([x, y], j) => `${j ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
            return (
              <g key={i} className={`ed-river${drawing === i ? ' drawing' : ''}`}>
                <path d={d} strokeWidth={Math.max(5, k * 0.2)} className="bank" />
                <motion.path d={d} strokeWidth={Math.max(3, k * 0.12)} className="water" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4 }} />
                {mids[0] && <circle cx={mids[0][0]} cy={mids[0][1]} r={Math.max(3, k * 0.09)} className="spring" />}
              </g>
            );
          })}
        </g>
        {/* Wells, discs (a lake's four in a ring, a fishing ground's on the water, '?' where the deal will give one). */}
        <g pointerEvents="none">
          <AnimatePresence>
            {shown.flatMap((h) => {
              const [x, y] = P(...hexCenter(h.q, h.r));
              const out: ReactNode[] = [];
              if (h.well)
                out.push(
                  <motion.g key={`w${key(h.q, h.r)}`} initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} style={{ transformOrigin: `${x + k * 0.42}px ${y - k * 0.3}px`, transformBox: 'view-box' }}>
                    <OilWellGlyph x={x + k * 0.42} y={y - k * 0.3} s={Math.max(12, k * 0.48)} label="Oil well" />
                  </motion.g>,
                );
              if (h.terrain === 'sea' && h.numbers.length) {
                out.push(
                  <motion.g key={`g${key(h.q, h.r)}:${h.numbers[0]}`} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} style={{ transformOrigin: `${x}px ${y}px`, transformBox: 'view-box' }}>
                    <FishingGround x={x} y={y} k={k} disc={r1} />
                    <NumberDisc x={x} y={y} r={r1} k={k} n={h.numbers[0]} />
                  </motion.g>,
                );
                return out;
              }
              if (!landish(h.terrain)) return out;
              const all = [...h.numbers, ...(h.owed ? [0] : [])];
              const spots = discSpots(all.length, k, h.terrain !== 'lake' && h.terrain !== 'random');
              all.forEach((n, i) =>
                out.push(
                  <motion.g
                    key={`n${key(h.q, h.r)}:${i}:${n}:${preview ?? ''}`}
                    style={{ transformOrigin: `${x + spots[i].dx}px ${y + spots[i].dy}px`, transformBox: 'view-box' }}
                    initial={{ scaleX: 0, scaleY: 1.25, y: -k * 0.3 }}
                    animate={{ scaleX: 1, scaleY: 1, y: 0 }}
                    exit={{ scaleX: 0, opacity: 0, transition: { duration: 0.18 } }}
                    transition={{ type: 'spring', duration: 0.45, bounce: 0.4 }}
                  >
                    {n ? <NumberDisc x={x + spots[i].dx} y={y + spots[i].dy} r={spots[i].r} k={k} n={n} /> : <OwedDisc x={x + spots[i].dx} y={y + spots[i].dy} r={spots[i].r} k={k} />}
                  </motion.g>,
                ),
              );
              return out;
            })}
          </AnimatePresence>
        </g>
        {/* The fog over the face-down cells (the cells still faintly seen beneath, for the one drawing them). */}
        <g pointerEvents="none">
          <AnimatePresence>
            {shown
              .filter((h) => h.hidden)
              .map((h) => {
                const [x, y] = P(...hexCenter(h.q, h.r));
                return (
                  <motion.g key={`f${key(h.q, h.r)}`} className="ed-fog" initial={{ opacity: 0, scale: 1.25 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={{ duration: 0.45, ease: 'easeOut' }} style={{ transformOrigin: `${x}px ${y}px`, transformBox: 'view-box' }}>
                    <polygon points={pts(corners(h.q, h.r, 0.99))} className="ed-fog-veil" />
                    <Mist id={cellSeed(h.q, h.r)} x={x} y={y} k={k} corners={corners(h.q, h.r)} />
                  </motion.g>
                );
              })}
          </AnimatePresence>
        </g>
        {/* Harbours: two piers out from the coast's corners and a badge where they meet. */}
        <AnimatePresence>
          {ports.map((p) => {
            const [a, b] = sideCorners(p.q, p.r, p.side);
            const [hx, hz] = hexCenter(p.q, p.r);
            const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
            const len = Math.hypot(mx - hx, mz - hz) || 1;
            const bx = mx + ((mx - hx) / len) * 0.62, bz = mz + ((mz - hz) / len) * 0.62;
            const [x, y] = P(bx, bz);
            const r = harbourRadius(k);
            return (
              <motion.g key={`p${p.q},${p.r},${p.side}:${p.type}:${preview ?? ''}`} className="ed-harbour" exit={{ opacity: 0, scale: 0.4, transition: { duration: 0.2 } }} style={{ transformOrigin: `${x}px ${y}px`, transformBox: 'view-box' }} pointerEvents="none">
                {[a, b].map(([vx, vz], i) => {
                  const [px, py] = P(vx + (bx - vx) * 0.12, vz + (bz - vz) * 0.12);
                  return <motion.line key={i} x1={px} y1={py} stroke="#7a5532" strokeWidth={Math.max(2, k * 0.07)} strokeLinecap="round" initial={{ x2: px, y2: py }} animate={{ x2: x, y2: y }} transition={{ duration: 0.3, ease: 'easeOut' }} />;
                })}
                <motion.g initial={{ y: -k * 0.9, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', delay: 0.18, duration: 0.5, bounce: 0.5 }}>
                  {p.type === 'random' ? <RandomBadge x={x} y={y} r={r} k={k} /> : <HarbourBadge x={x} y={y} r={r} k={k} type={p.type} />}
                </motion.g>
              </motion.g>
            );
          })}
        </AnimatePresence>
        {/* The pieces: the robber's and the corsair's starts, and the home islands' flags. */}
        <g pointerEvents="none">
          <AnimatePresence>
            {robber && (
              <motion.g key={`rob${key(...robber)}`} initial={{ y: -k * 0.8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ type: 'spring', duration: 0.5, bounce: 0.35 }} aria-label="The robber starts here">
                <Robber at={P(...hexCenter(...robber))} k={k} />
              </motion.g>
            )}
            {map.corsair && (
              <motion.g key={`cor${key(...map.corsair)}`} initial={{ x: -k * 0.6, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ opacity: 0 }} transition={{ type: 'spring', duration: 0.6, bounce: 0.3 }} aria-label="The corsair starts here">
                <Corsair at={P(...hexCenter(...map.corsair))} k={k} />
              </motion.g>
            )}
            {(map.home ?? []).map(([q, r]) => {
              const [x, y] = P(...hexCenter(q, r));
              return (
                <motion.g key={`home${key(q, r)}`} initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} exit={{ scaleY: 0 }} style={{ transformOrigin: `${x - k * 0.38}px ${y + k * 0.1}px`, transformBox: 'view-box' }} transition={{ type: 'spring', duration: 0.5, bounce: 0.4 }} aria-label="A home island">
                  <HomeFlag at={[x, y]} k={k} />
                </motion.g>
              );
            })}
          </AnimatePresence>
        </g>
        {/* Surf rings where the last edit landed. */}
        <g aria-hidden pointerEvents="none">
          {[...fresh].map((c) => {
            const [q, r] = c.split(',').map(Number);
            const [x, y] = P(...hexCenter(q, r));
            return <circle key={`${change.id}:${c}`} className="ed-ripple" cx={x} cy={y} r={k * 0.9} style={{ transformOrigin: `${x}px ${y}px` }} />;
          })}
        </g>
        <g pointerEvents="none">{aim}</g>
      </svg>
      <div className="ed-zoom" role="group" aria-label="Zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button className="tip" data-tip="Zoom in" aria-label="Zoom in" onClick={() => setView((v) => zoomAt(size.w / 2, midY, v.s * 1.25, v))}>
          <LineIcon name="plus" size={18} />
        </button>
        <button className="tip" data-tip="Zoom out" aria-label="Zoom out" onClick={() => setView((v) => zoomAt(size.w / 2, midY, v.s / 1.25, v))}>
          <LineIcon name="minus" size={18} />
        </button>
        <button className="tip" data-tip="Fit the map" aria-label="Fit the map" disabled={view.s === 1 && view.x === 0 && view.y === 0} onClick={() => setView(FIT)}>
          <svg className="line-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** A terrain's icon (a resource's card art, or an expansion terrain's glyph), up out of its discs' way. */
function TerrainIcon({ terrain, x, y, k, discs }: { terrain: Exclude<CellTerrain, 'random'>; x: number; y: number; k: number; discs: number }) {
  const res = TERRAIN_RESOURCE[terrain];
  const bare = discs === 0;
  const iy = bare ? y : discs > 2 ? y - k * 0.5 : y - k * 0.34;
  const isz = bare ? (res ? k * 0.95 : k * 1.15) : discs > 2 ? k * 0.48 : k * 0.62;
  if (res) return <image href={asset(CARD_ICON[res])} x={x - isz / 2} y={iy - isz / 2} width={isz} height={isz} aria-label={CARD_NAMES[res]} />;
  if (terrain === 'bounty') return <BountyGlyph x={x} y={iy} s={isz} label={TERRAIN_NAMES.bounty} />;
  if (terrain === 'swamp') return <SwampGlyph x={x} y={iy} s={isz} label={TERRAIN_NAMES.swamp} />;
  if (terrain === 'oasis') return <OasisGlyph x={x} y={iy} s={isz} label={TERRAIN_NAMES.oasis} />;
  if (terrain === 'castle') return <CastleGlyph x={x} y={iy} s={isz} label={TERRAIN_NAMES.castle} />;
  if (terrain === 'desert')
    return <path d={`M${x - k * 0.45} ${y - k * 0.22} q${k * 0.22} ${-k * 0.2} ${k * 0.45} 0 t${k * 0.45} 0 M${x - k * 0.3} ${y - k * 0.42} q${k * 0.18} ${-k * 0.14} ${k * 0.36} 0`} fill="none" stroke="#b39d68" strokeWidth={k * 0.05} strokeLinecap="round" aria-label={TERRAIN_NAMES.desert} />;
  return null;
}

/** A random cell's face: a die, for a tile dealt at the start of each game. */
function RandomFace({ x, y, k, bare }: { x: number; y: number; k: number; bare: boolean }) {
  const s = k * (bare ? 0.62 : 0.46);
  const cy = bare ? y : y - k * 0.32;
  const pip = (dx: number, dy: number) => <circle cx={x + dx * s} cy={cy + dy * s} r={s * 0.07} fill="#6b5233" />;
  return (
    <g aria-label="Random: dealt at the start">
      <g transform={`rotate(-12 ${x} ${cy})`}>
        <rect x={x - s / 2} y={cy - s / 2} width={s} height={s} rx={s * 0.18} fill="#fbf4e2" stroke="#8a6c45" strokeWidth={Math.max(1, k * 0.03)} />
        {pip(-0.25, -0.25)}
        {pip(0.25, 0.25)}
        {pip(0, 0)}
        {pip(0.25, -0.25)}
        {pip(-0.25, 0.25)}
      </g>
    </g>
  );
}

/** A disc the deal will fill: a '?'. */
function OwedDisc({ x, y, r, k }: { x: number; y: number; r: number; k: number }) {
  return (
    <g aria-label="Number dealt at the start">
      <circle cx={x} cy={y} r={r} fill="#f7efdc" stroke="#bfa877" strokeWidth={Math.max(1, k * 0.025)} strokeDasharray={`${r * 0.35} ${r * 0.2}`} />
      <text x={x} y={y + r * 0.08} textAnchor="middle" dominantBaseline="middle" fontSize={r * 1.05} fill="#8a6c45" className="flat-num">
        ?
      </text>
    </g>
  );
}

/** A harbour of a type dealt at the start. */
function RandomBadge({ x, y, r, k }: { x: number; y: number; r: number; k: number }) {
  return (
    <g aria-label="Harbour of a random type">
      <circle cx={x + r * 0.08} cy={y + r * 0.12} r={r} fill="#000" opacity="0.25" />
      <circle cx={x} cy={y} r={r} fill="#f4e9cf" stroke="#8a6c45" strokeWidth={Math.max(1, k * 0.03)} strokeDasharray={`${r * 0.3} ${r * 0.18}`} />
      <text x={x} y={y + r * 0.08} textAnchor="middle" dominantBaseline="middle" fontSize={r * 1.05} fill="#6b5233" className="flat-num">
        ?
      </text>
    </g>
  );
}

function Robber({ at: [x, y], k }: { at: Pt; k: number }) {
  const s = k * 0.42;
  return (
    <g>
      <ellipse cx={x + s * 0.55} cy={y + s * 0.95} rx={s * 0.55} ry={s * 0.16} fill="#000" opacity="0.3" />
      <path d={`M${x - s * 0.45} ${y + s * 0.9} Q${x - s * 0.5} ${y} ${x} ${y - s * 0.3} Q${x + s * 0.5} ${y} ${x + s * 0.45} ${y + s * 0.9} Z`} fill="#2e2a27" stroke="#120f0d" strokeWidth={Math.max(1, k * 0.02)} />
      <circle cx={x} cy={y - s * 0.55} r={s * 0.34} fill="#2e2a27" stroke="#120f0d" strokeWidth={Math.max(1, k * 0.02)} />
    </g>
  );
}

function Corsair({ at: [x, y], k }: { at: Pt; k: number }) {
  const s = k * 0.5;
  return (
    <g className="ed-bob" style={{ transformOrigin: `${x}px ${y}px` }}>
      <path d={`M${x - s * 0.7} ${y + s * 0.2} L${x + s * 0.7} ${y + s * 0.2} L${x + s * 0.45} ${y + s * 0.55} L${x - s * 0.45} ${y + s * 0.55} Z`} fill="#3b2a1e" stroke="#1d140d" strokeWidth={Math.max(1, k * 0.02)} />
      <line x1={x} y1={y + s * 0.2} x2={x} y2={y - s * 0.75} stroke="#1d140d" strokeWidth={Math.max(1.5, k * 0.03)} />
      <path d={`M${x + s * 0.04} ${y - s * 0.7} Q${x + s * 0.6} ${y - s * 0.3} ${x + s * 0.04} ${y + s * 0.1} Z`} fill="#16120f" />
      <path d={`M${x - s * 0.04} ${y - s * 0.6} Q${x - s * 0.5} ${y - s * 0.25} ${x - s * 0.04} ${y + s * 0.05} Z`} fill="#231c17" />
    </g>
  );
}

function HomeFlag({ at: [x, y], k }: { at: Pt; k: number }) {
  const s = k * 0.5;
  const fx = x - k * 0.38, fy = y + k * 0.1;
  return (
    <g>
      <line x1={fx} y1={fy} x2={fx} y2={fy - s * 1.1} stroke="#5b3d24" strokeWidth={Math.max(1.5, k * 0.035)} strokeLinecap="round" />
      <path className="ed-flag" d={`M${fx} ${fy - s * 1.1} L${fx + s * 0.7} ${fy - s * 0.92} L${fx} ${fy - s * 0.72} Z`} fill="#c4953b" stroke="#6d4b17" strokeWidth={Math.max(1, k * 0.02)} />
    </g>
  );
}
