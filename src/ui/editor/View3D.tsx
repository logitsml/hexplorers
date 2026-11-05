// The editor's 3D view: the draft island (render/editor/draft.ts) in the live world, painted by
// tapping or dragging over the water and the land, as on the flat board. A brush (terrain, erase,
// the fog) paints along a drag; the other tools place with a tap, and a drag looks around as in a
// game. Two fingers move the map (spread to zoom, twist to turn); with a mouse, a right-drag pans,
// Shift or Alt and a drag turns, and the wheel zooms.
//
// From the flat board it lifts out of the map: the camera starts straight overhead through a lens
// narrow enough to draw the island as a map, laid exactly over the flat board, which dissolves into
// it; then, as the camera tilts down and the lens widens (a dolly zoom: the island keeps its size
// while the perspective deepens), the island rises into relief in a wave from its middle out. Back
// to the flat board, the same in reverse: the relief settles from the coast in as the camera rises
// overhead, and the flat board gathers over it where it lies.

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { session } from '../../app/session';
import { reducedMotion } from '../../app/display';
import { DraftIsland, PRESSED, type DraftScene } from '../../render/editor/draft';
import { SEA_LEVEL } from '../../render/board/layout';
import { CORNER_OFFSETS, hexCenter } from '../../engine/board';
import { boardFrameState, restoreBoardFrame, setBoardFrame, type CameraPose } from '../../render/core/cameraRig';
import type { CustomMap } from '../../engine/maps/custom';
import { aimAt, boxKey, cellAt, gridEdge, gridOf, gridRings, isBrush, key, robberCell, shownCells, shownPorts } from './model';
import { applyTool, useEditor } from './store';
import { flatLayout } from './Board2D';

/** What the draft shows: the map as drawn, or (previewing) as one deal dealt it. */
function sceneOf({ map, preview }: { map: CustomMap; preview: number | null }): DraftScene {
  const cells = shownCells(map, preview);
  return {
    cells,
    ports: shownPorts(map, preview),
    robber: robberCell(map, cells),
    corsair: map.corsair ?? null,
    home: map.home ?? [],
    rivers: map.rivers?.map((r) => r.path) ?? [],
  };
}

/** The scene's land (world x, z), for the ships sailing round to keep clear of. */
const landOf = (scene: DraftScene) => scene.cells.filter((h) => h.terrain !== 'sea').map((h) => {
  const [x, z] = hexCenter(h.q, h.r);
  return { x, z };
});

/** A press a brush paints with: a finger or a pen, or the left button with no key held. */
const paints = (e: PointerEvent) => isBrush(useEditor.getState().tool) && (e.pointerType !== 'mouse' || (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey));

/** The 3D view's pitch, and the flat view's lens (degrees: narrow enough that the island draws as a map). */
const PITCH = 0.98;
const FLAT_FOV = 4;
/** The lift out of the map and the press back into it (s). */
const LIFT = 1.6;
const PRESS = 1.25;
/** How much of the board's room the grid's outline fills, in its tighter dimension. */
const FILL = 0.9;

/** Which way the island was turned when last left for the flat board (it comes back so). */
let lastYaw = 0;

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `entry`: how the view comes in, flying from wherever the camera is (the editor opened in 3D) or
 * lifting out of the flat board under it. `leaving`: on its way back to the flat board (pressed
 * flat under it; set back to false, it rises again). `onShown`: lifting, the island is drawn under
 * the flat board, which may dissolve now. `onFlat`: leaving, nearly flat, so the flat board can
 * gather over it. `onGone`: leaving, flat and covered.
 */
export function View3D({ entry = 'fly', leaving = false, onShown, onFlat, onGone }: { entry?: 'fly' | 'lift'; leaving?: boolean; onShown?: () => void; onFlat?: () => void; onGone?: () => void }) {
  // Until the draft's shaders are built (the first time only), a word that the island is coming.
  const [ready, setReady] = useState(false);
  // The board's room, measured for the camera's framing.
  const area = useRef<HTMLDivElement>(null);
  // (The latest callbacks, and the press and the rise, for the effect below to call.)
  const calls = useRef({ onShown, onFlat, onGone });
  calls.current = { onShown, onFlat, onGone };
  const turn = useRef<{ press(): void; rise(): void } | null>(null);
  useEffect(() => {
    const world = session.world;
    if (!world) return;
    const draft = new DraftIsland(world);
    const quick = reducedMotion();
    draft.still = quick;
    const rig = world.rig;
    const limits = { ...rig.limits };
    // (The camera's frame is the grid's while this is up, and what it was after.)
    const frame = boardFrameState();
    world.setAutoOrbit(false);
    let gone = false;
    // Lifting or pressing: the camera is the transition's, and nothing is painted.
    let moving = false;
    const canvas = world.canvas;
    const size = () => ({ W: canvas.clientWidth || window.innerWidth, H: canvas.clientHeight || window.innerHeight });

    // Where a point of the board lands on the page through a pose, as the rig draws it (an
    // off-centre pose shifts the lens, or slides the camera across: see CameraPose.lens).
    const eye = new THREE.PerspectiveCamera();
    const across = new THREE.Vector3();
    const place = (p: CameraPose) => {
      const { W, H } = size();
      const fov = p.fov ?? 36;
      const shift = p.lens ?? 0;
      eye.fov = fov;
      eye.aspect = W / H;
      eye.near = 0.1;
      eye.far = p.distance + 300;
      eye.updateProjectionMatrix();
      const e = eye.projectionMatrix.elements;
      e[8] -= (2 * (p.shiftX ?? 0) * shift) / W;
      e[9] += (2 * (p.shiftY ?? 0) * shift) / H;
      eye.position.set(p.target.x + Math.sin(p.yaw) * Math.cos(p.pitch) * p.distance, p.target.y + Math.sin(p.pitch) * p.distance, p.target.z + Math.cos(p.yaw) * Math.cos(p.pitch) * p.distance);
      eye.lookAt(p.target);
      const k = H / 2 / (p.distance * Math.tan((fov * Math.PI) / 360));
      eye.position.add(across.set(1, 0, 0).applyQuaternion(eye.quaternion).multiplyScalar((-(p.shiftX ?? 0) * (1 - shift)) / k));
      eye.position.add(across.set(0, 1, 0).applyQuaternion(eye.quaternion).multiplyScalar(((p.shiftY ?? 0) * (1 - shift)) / k));
      eye.updateMatrixWorld();
    };
    // The grid's outline: the corners of its outer cells, at the sea and at the tiles' tops.
    const outline = () => {
      const pts: THREE.Vector3[] = [];
      for (const [q, r] of gridEdge(useEditor.getState().map)) {
        const [x, z] = hexCenter(q, r);
        for (const [dx, dz] of CORNER_OFFSETS) pts.push(new THREE.Vector3(x + dx, SEA_LEVEL, z + dz), new THREE.Vector3(x + dx, 0.12, z + dz));
      }
      return pts;
    };
    const bounds = (pts: THREE.Vector3[], p: CameraPose) => {
      place(p);
      const { W, H } = size();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const v = new THREE.Vector3();
      for (const pt of pts) {
        v.copy(pt).project(eye);
        const x = ((v.x + 1) / 2) * W, y = ((1 - v.y) / 2) * H;
        x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      }
      return { x0, x1, y0, y1 };
    };
    // The grid framed in the board's room (between the bar, the dock and the check), centred on
    // its bounds, turned to `yaw`: near enough that its outline, as the camera really draws it in perspective, fills the
    // room's tighter dimension, and that outline moved into the middle of it by shifting the lens,
    // so the island is drawn square (slid across to the side of the dock, the camera saw it at a
    // skew: nearer rows moved further than farther ones).
    const fitPose = (yaw: number): CameraPose => {
      const { W, H } = size();
      const room = area.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: W, height: H };
      const w = Math.max(1, room.width), h = Math.max(1, room.height);
      const map = useEditor.getState().map;
      const { box } = gridOf(map);
      const mid = new THREE.Vector3((box.x0 + box.x1) / 2, 0, (box.z0 + box.z1) / 2);
      const radius = gridRings(map);
      const pose: CameraPose = { yaw, pitch: PITCH, fov: 36, target: mid, distance: DraftIsland.frame(radius).distance, shiftX: 0, shiftY: 0, lens: 1 };
      const pts = outline();
      for (let i = 0; i < 4; i++) {
        let b = bounds(pts, pose);
        // (What a pose shows shrinks with its distance, near enough.)
        pose.distance *= Math.max((b.x1 - b.x0) / (w * FILL), (b.y1 - b.y0) / (h * FILL));
        b = bounds(pts, pose);
        pose.shiftX! += room.left + w / 2 - (b.x0 + b.x1) / 2;
        pose.shiftY! += room.top + h / 2 - (b.y0 + b.y1) / 2;
      }
      const f = DraftIsland.frame(radius);
      // (The grid's outline is the board the rig frames while the editor is up: see restoreBoardFrame.)
      setBoardFrame(mid.x, mid.z, 0, pts.flatMap((p) => [p.x, p.z]));
      rig.limits.radius = f.radius;
      rig.limits.hardRadius = f.radius + 2;
      rig.limits.maxDist = Math.max(limits.maxDist, pose.distance + 8);
      return pose;
    };
    // Straight overhead, north up, through the narrow lens: the island pressed flat lands exactly
    // where the flat board draws it (the level it's pressed to at the flat board's scale).
    const flatPose = (): CameraPose | null => {
      const l = flatLayout.current;
      if (!l) return null;
      const { W, H } = size();
      const tan = Math.tan((FLAT_FOV * Math.PI) / 360);
      return { target: new THREE.Vector3(0, PRESSED, 0), distance: H / (2 * l.k * tan), pitch: Math.PI / 2 - 0.0008, yaw: 0, fov: FLAT_FOV, shiftX: l.x - W / 2, shiftY: l.y - H / 2, lens: 1 };
    };

    // (A grid whose bounds changed, Fit view, another map opened, the check opened or closed, the
    // window resized: the camera takes in the grid again, turned as it is. Not mid-stroke: the
    // island would slide under the brush; the stroke's end does it.)
    const refit = () => !gone && !moving && void rig.flyTo(fitPose(rig.pose.yaw), 0.9);
    let pendingRefit = false;
    const offRoom = useEditor.subscribe((s, was) => s.checkOpen !== was.checkOpen && setTimeout(refit, 60));
    window.addEventListener('resize', refit);

    // The island shown, and kept to the map as it changes.
    let shown = false;
    let last = useEditor.getState();
    let unsub = () => {};
    const show = (assemble: boolean) => {
      last = useEditor.getState();
      const scene = sceneOf(last);
      draft.setScene(scene, gridOf(last.map).cells, new Set(), assemble);
      world.distant.keepClear(landOf(scene));
      unsub = useEditor.subscribe((s) => {
        if (s.change.id === last.change.id && s.fit === last.fit && s.preview === last.preview && s.map === last.map) return;
        const dealt = s.preview !== last.preview;
        if (s.fit !== last.fit) refit();
        else if (boxKey(s.map) !== boxKey(last.map)) {
          if (stroke) pendingRefit = true;
          else refit();
        }
        last = s;
        // (A new deal, or going back to the map from one, is dealt out across the island in a quick cascade.)
        const scene = sceneOf(s);
        draft.setScene(scene, gridOf(s.map).cells, new Set(s.change.cells), dealt, 0.025);
        world.distant.keepClear(landOf(scene));
      });
    };
    // Each change of direction (a press, a rise) outdates the one before.
    let run = 0;
    const rise = async (from: 'flat' | 'pressing') => {
      const id = ++run;
      moving = true;
      shown = false;
      rig.locked = true;
      if (from === 'flat') {
        const flat = flatPose();
        if (flat) rig.jumpTo(flat);
        // (Drawn under the flat board before it starts to dissolve: a frame or two to be sure.)
        await frames(3);
        if (id !== run || gone) return;
        calls.current.onShown?.();
      }
      const flight = rig.flyTo(fitPose(lastYaw), quick ? 0.01 : LIFT, true);
      // The relief comes up once the tilt is under way (straight overhead it barely shows).
      if (!quick) await wait(from === 'flat' ? 260 : 0);
      if (id !== run || gone) return;
      void draft.relief(1, quick ? 0 : LIFT - 0.3);
      await flight;
      if (id !== run || gone) return;
      moving = false;
      shown = true;
      rig.locked = false;
    };
    const press = async () => {
      const id = ++run;
      moving = true;
      shown = false;
      rig.locked = true;
      endStroke();
      draft.setAim([]);
      lastYaw = rig.pose.yaw;
      // (The flat board is laid out under it first, unseen: its place is where the camera goes.)
      await frames(2);
      if (id !== run || gone) return;
      const flat = flatPose();
      if (!flat) return calls.current.onGone?.();
      const flight = rig.flyTo(flat, quick ? 0.01 : PRESS, true);
      void draft.relief(0, quick ? 0 : PRESS * 0.8);
      // The flat board gathers over the island as the camera arrives above it.
      const check = () =>
        new Promise<void>((resolve) => {
          const go = () => (id !== run || gone || (rig.flightProgress ?? 1) >= 0.7 ? resolve() : requestAnimationFrame(go));
          go();
        });
      await check();
      if (id !== run || gone) return;
      calls.current.onFlat?.();
      await flight;
      // (Once the flat board has finished gathering: see --ed-melt.)
      await wait(quick ? 150 : 450);
      if (id !== run || gone) return;
      calls.current.onGone?.();
    };
    turn.current = { press: () => void press(), rise: () => void rise('pressing') };

    void DraftIsland.warm(world).then(() => {
      if (gone) return;
      performance.mark('editor: 3d shown');
      setReady(true);
      if (entry === 'lift') {
        show(false);
        draft.relief(0, 0);
        void rise('flat');
        return;
      }
      shown = true;
      show(true);
    });
    // Flying in, the island assembles as the camera arrives (or, the first time, once its shaders are built).
    if (entry === 'fly') void rig.flyTo(fitPose(lastYaw), 1.3);

    // What the tool would act on, marked as the flat board marks it (none while a deal is previewed).
    const mark = (e: PointerEvent | MouseEvent) => {
      if (!shown) return;
      const p = draft.pick(e.clientX, e.clientY);
      const st = useEditor.getState();
      draft.setAim(p && st.preview === null ? aimAt(st.map, st.tool, p[0], p[1], st.brush, st.symmetry) : []);
    };

    // A brush's stroke: a mouse paints from the press; a finger once it moves or holds a moment (so
    // a second finger, come to move the map, finds nothing painted), or where it lifts after a tap.
    // (Not before the island shows: till then a drag looks around.)
    rig.editing = { claim: (e) => shown && paints(e) };
    let stroke: { id: number; x0: number; y0: number; done: Set<string>; wait: ReturnType<typeof setTimeout> | null } | null = null;
    const endStroke = () => {
      if (stroke?.wait) clearTimeout(stroke.wait);
      stroke = null;
      if (pendingRefit) {
        pendingRefit = false;
        refit();
      }
    };
    const paintAt = (x: number, y: number, carry: boolean) => {
      const p = stroke && draft.pick(x, y);
      if (!stroke || !p) return;
      const c = key(...cellAt(p[0], p[1]));
      if (stroke.done.has(c)) return;
      stroke.done.add(c);
      applyTool(p[0], p[1], carry);
    };
    const begin = () => {
      if (!stroke?.wait) return;
      clearTimeout(stroke.wait);
      stroke.wait = null;
      paintAt(stroke.x0, stroke.y0, false);
    };
    const down = (e: PointerEvent) => {
      if (stroke) {
        // A second finger: the map is being moved, and the stroke ends where it is.
        endStroke();
        return;
      }
      if (!shown || rig.locked || !paints(e)) return;
      canvas.setPointerCapture?.(e.pointerId);
      stroke = { id: e.pointerId, x0: e.clientX, y0: e.clientY, done: new Set(), wait: null };
      if (e.pointerType === 'mouse') paintAt(e.clientX, e.clientY, false);
      else stroke.wait = setTimeout(begin, 110);
    };
    const move = (e: PointerEvent) => {
      mark(e);
      if (!stroke || e.pointerId !== stroke.id) return;
      if (stroke.wait) {
        if (Math.hypot(e.clientX - stroke.x0, e.clientY - stroke.y0) <= 8) return;
        begin();
      }
      paintAt(e.clientX, e.clientY, true);
    };
    const up = (e: PointerEvent) => {
      if (!stroke || e.pointerId !== stroke.id) return;
      begin();
      endStroke();
    };
    // The other tools place with a click (one that wasn't a drag).
    const click = (e: MouseEvent) => {
      if (!shown || rig.suppressClick || e.button !== 0 || isBrush(useEditor.getState().tool)) return;
      const p = draft.pick(e.clientX, e.clientY);
      if (p) applyTool(p[0], p[1]);
      mark(e);
    };
    const leave = () => draft.setAim([]);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('click', click);
    canvas.addEventListener('pointerleave', leave);
    return () => {
      gone = true;
      run++;
      turn.current = null;
      unsub();
      offRoom();
      window.removeEventListener('resize', refit);
      endStroke();
      rig.editing = null;
      rig.locked = false;
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('click', click);
      canvas.removeEventListener('pointerleave', leave);
      draft.dispose();
      world.distant.keepClear(world.boardLand);
      Object.assign(rig.limits, limits);
      restoreBoardFrame(frame);
      // (Back over the sea as the title has it, unless the flat board has it or a game is taking the camera.)
      if (useEditor.getState().view === '2d' || session.host) return;
      void world.flyToTitle(1.2, () => !session.host);
    };
  }, []);
  // Leaving for the flat board, or (changed back meanwhile) coming up again.
  const was = useRef(leaving);
  useEffect(() => {
    if (was.current === leaving) return;
    was.current = leaving;
    if (leaving) turn.current?.press();
    else turn.current?.rise();
  }, [leaving]);
  return (
    <>
      <div ref={area} className="ed-board-area" aria-hidden />
      <AnimatePresence>
        {!ready && (
          <motion.p key="raising" className="ed-raising" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.3 } }} exit={{ opacity: 0 }}>
            Raising the island…
          </motion.p>
        )}
      </AnimatePresence>
    </>
  );
}
