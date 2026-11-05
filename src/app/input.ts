// Pointer input on the 3D board: hover previews and clicks for whatever the
// local player is currently placing. Touch has no hover, so there a first tap previews a spot
// (with a confirm button, see PlaceConfirm) and a second tap or the button places; pressing
// and holding a tile shows its details.

import * as THREE from 'three/webgpu';
import type { World } from '../render/World';
import type { BoardView } from '../render/board/boardView';
import type { Presenter } from '../game/presenter';
import { interactionSpots, useUI } from '../game/store';
import { spotOf, stagedAsk, stagedStep } from '../game/moduleActions';
import { segDist } from '../render/board/layout';
import { sfx } from '../audio/sfx';
import { cancelPlacement } from '../game/commands';
import { explain, missReason } from '../ui/why';
import { seenHex } from '../game/hexView';
import type { GameState } from '../engine';

export interface HoverInfo {
  hex: number;
  x: number;
  y: number;
  /** Legal intersection under the cursor while placing a settlement or city. */
  vertex?: number;
  /** From a press and hold on touch: shown above the finger rather than beside a pointer. */
  touch?: boolean;
}

const CONFIRM_LABEL: Record<string, string> = {
  setupSettlement: 'Settle here',
  setupRoad: 'Build road here',
  settlement: 'Build here',
  city: 'Build town here',
  road: 'Build road here',
  robber: 'Move robber here',
};

/** How long a still finger counts as press-and-hold (ms), and how far it may wander (px). */
const HOLD_MS = 450;
const HOLD_SLOP = 10;

/**
 * What the camera is told once the board's input is gone. (Made out here: an arrow made in the
 * constructor would share its scope, and so keep this input, its view and its presenter, the
 * whole last game, for as long as the camera does.)
 */
const never = () => false;

/** Words for a board spot, for screen readers (its hexes as the table sees them: see game/hexView.ts). */
function describeSpot(state: GameState, board: BoardView['board'], kind: 'vertex' | 'edge' | 'hex', id: number): string {
  const hexName = (h: number) => {
    const x = seenHex(state, h);
    return x.numbers.length > 0 ? `${x.label} ${x.numbers.join(' and ')}` : x.label;
  };
  if (kind === 'hex') return hexName(id);
  const hexes = kind === 'vertex' ? board.vertices[id].hexes : board.edges[id].hexes;
  const where = hexes.map(hexName).join(', ');
  if (kind === 'vertex') return `Intersection by ${where}${board.vertices[id].port ? ', with a harbour' : ''}`;
  return `Road along ${where}${hexes.length === 1 ? ' and the coast' : ''}`;
}

export class BoardInput {
  private ndc = new THREE.Vector2();
  private hoverHex = -1;
  /** The hexes the robber may go to, glowing gently while one is to be chosen (hovering brightens one). */
  private glowing = new Set<number>();
  private disposers: (() => void)[] = [];
  onHoverHex: ((info: HoverInfo | null) => void) | null = null;

  constructor(
    private world: World,
    private view: BoardView,
    private presenter: Presenter,
  ) {
    const canvas = world.canvas;
    // (Pointer moves are taken at most once a frame, the latest of them: a fast mouse sends
    // several between frames, and each would pick the board and re-render the tooltip.)
    let latest: PointerEvent | null = null;
    const moveFrame = () => {
      const e = latest;
      latest = null;
      if (e && !this.disposed) this.onMove(e);
    };
    const move = (e: PointerEvent) => {
      if (this.hold && Math.hypot(e.clientX - this.hold.x, e.clientY - this.hold.y) > HOLD_SLOP) this.cancelHold();
      if (!latest) requestAnimationFrame(moveFrame);
      latest = e;
    };
    const click = (e: MouseEvent) => this.onClick(e);
    // (A finger "leaves" as it lifts: that ends a held tile's details, not a previewed spot.)
    const leave = (e: PointerEvent) => (e.pointerType === 'touch' ? this.hideHeld() : this.clearHover());
    // A right-click that isn't a drag cancels an optional placement mode.
    let rightDown: { x: number; y: number } | null = null;
    // (The fingers down, by pointer: a lift that never arrives is forgotten with the window.)
    const fingers = new Set<number>();
    const forget = () => fingers.clear();
    window.addEventListener('blur', forget);
    this.disposers.push(() => window.removeEventListener('blur', forget));
    // The canvas's box is read again only when it changes size, not on every pointer move (or every
    // frame the touch confirm follows its spot), where it would lay the page out mid-frame.
    const ro = new ResizeObserver(() => (this.rect = null));
    ro.observe(canvas);
    this.disposers.push(() => ro.disconnect());
    const down = (e: PointerEvent) => {
      this.lastPointer = e.pointerType;
      if (e.button === 2) rightDown = { x: e.clientX, y: e.clientY };
      if (e.pointerType !== 'touch') return;
      // A new touch ends a held tile's details; a still finger shows them.
      this.hideHeld();
      fingers.add(e.pointerId);
      this.cancelHold();
      if (fingers.size > 1) return;
      const at = { x: e.clientX, y: e.clientY };
      this.hold = { ...at, timer: setTimeout(() => this.showHeld(at), HOLD_MS) };
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        fingers.delete(e.pointerId);
        this.cancelHold();
      }
      if (e.button !== 2 || !rightDown) return;
      const moved = Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y);
      rightDown = null;
      if (moved < 6 && cancelPlacement()) sfx.play('click');
    };
    // A pending spot belongs to the placement it was chosen in.
    let lastKind = useUI.getState().interaction.kind;
    const unsub = useUI.subscribe((st) => {
      if (st.interaction.kind === lastKind) return;
      lastKind = st.interaction.kind;
      if (this.pending) this.clearPending();
      this.syncGlow();
    });
    this.disposers.push(() => {
      this.glowing.forEach((h) => (this.world.effects.get(h).z = 0));
      this.glowing.clear();
    });
    this.syncGlow();
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (useUI.getState().modal || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.handleKey(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', key, true);
    world.rig.arrowsCaptured = () => this.spots() !== null && !useUI.getState().modal;
    world.rig.keysEnabled = () => !useUI.getState().modal;
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('click', click);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    const noPageZoom = (e: Event) => e.preventDefault();
    const twoFingers = (e: TouchEvent) => e.touches.length > 1 && e.preventDefault();
    document.addEventListener('gesturestart', noPageZoom);
    document.addEventListener('gesturechange', noPageZoom);
    document.addEventListener('touchmove', twoFingers, { passive: false });
    this.disposers.push(
      () => document.removeEventListener('gesturestart', noPageZoom),
      () => document.removeEventListener('gesturechange', noPageZoom),
      () => document.removeEventListener('touchmove', twoFingers),
    );
    this.disposers.push(
      unsub,
      () => window.removeEventListener('pointercancel', up),
      () => this.cancelHold(),
      () => canvas.removeEventListener('pointermove', move),
      () => canvas.removeEventListener('click', click),
      () => canvas.removeEventListener('pointerleave', leave),
      () => canvas.removeEventListener('pointerdown', down),
      () => window.removeEventListener('pointerup', up),
      () => window.removeEventListener('keydown', key, true),
      () => (world.rig.arrowsCaptured = never),
      () => (world.rig.keysEnabled = never),
    );
  }

  /** A hex's glow at rest: gently lit while it is one the robber may move to, else none. */
  private rest(hex: number) {
    return this.glowing.has(hex) ? 0.3 : 0;
  }

  /** Light every hex the robber may go to while it is to be moved (calm: steady, dim; no flashing), and put them out after. */
  private syncGlow() {
    const it = useUI.getState().interaction;
    const next = new Set<number>(it.kind === 'robber' ? it.hexes : []);
    const fx = this.world.effects;
    for (const h of this.glowing) if (!next.has(h)) fx.get(h).z = h === this.hoverHex ? 1 : 0;
    this.glowing = next;
    for (const h of next) if (h !== this.hoverHex) fx.get(h).z = 0.3;
  }

  private rect: DOMRect | null = null;

  private canvasRect() {
    return (this.rect ??= this.world.canvas.getBoundingClientRect());
  }

  private toNdc(e: { clientX: number; clientY: number }) {
    const r = this.canvasRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Resolve the pointer to the current interaction's target id (or -1). */
  private target(e: { clientX: number; clientY: number }): { kind: 'vertex' | 'edge' | 'hex' | null; id: number; hex: number } {
    this.toNdc(e);
    const pick = this.view.pick(this.ndc, this.world.stage.camera);
    if (!pick) return { kind: null, id: -1, hex: -1 };
    const sp = interactionSpots(useUI.getState().interaction);
    switch (sp?.kind) {
      case 'vertex': {
        // Choose the nearest *legal* spot within reach, so near-misses still work.
        let best = -1, bd = 0.42;
        for (const v of sp.ids) {
          const vx = this.view.board.vertices[v];
          const d = Math.hypot(vx.x - pick.point.x, vx.z - pick.point.z);
          if (d < bd) {
            bd = d;
            best = v;
          }
        }
        return { kind: 'vertex', id: best, hex: pick.hex };
      }
      case 'edge': {
        let best = -1, bd = 0.32;
        for (const eid of sp.ids) {
          const ed = this.view.board.edges[eid];
          const a = this.view.board.vertices[ed.a], b = this.view.board.vertices[ed.b];
          const d = segDist(pick.point.x, pick.point.z, a.x, a.z, b.x, b.z);
          if (d < bd) {
            bd = d;
            best = eid;
          }
        }
        return { kind: 'edge', id: best, hex: pick.hex };
      }
      case 'hex':
        return { kind: 'hex', id: sp.ids.includes(pick.hex) ? pick.hex : -1, hex: pick.hex };
      default:
        return { kind: null, id: -1, hex: pick.hex };
    }
  }

  private onMove(e: PointerEvent) {
    if (e.buttons !== 0) return;
    const t = this.target(e);
    this.focus(t.kind, t.id);
    const hoverHex = t.kind === 'hex' ? t.id : t.hex;
    if (hoverHex !== this.hoverHex) {
      const fx = this.world.effects;
      if (this.hoverHex >= 0) fx.get(this.hoverHex).z = this.rest(this.hoverHex);
      this.hoverHex = hoverHex;
      if (hoverHex >= 0) fx.get(hoverHex).z = t.kind === 'hex' ? 1 : 0.35;
    }
    this.world.canvas.style.cursor = t.id >= 0 ? 'pointer' : '';
    const vertex = t.kind === 'vertex' && t.id >= 0 ? t.id : undefined;
    this.onHoverHex?.(hoverHex >= 0 || vertex !== undefined ? { hex: hoverHex, x: e.clientX, y: e.clientY, vertex } : null);
  }

  private onClick(e: MouseEvent) {
    if (this.world.rig.suppressClick) {
      this.world.rig.suppressClick = false;
      return;
    }
    // A click while the camera glides somewhere would land on a moving board.
    if (this.world.rig.flying) return;
    const t = this.target(e);
    if (this.lastPointer === 'touch' && t.kind) {
      if (t.id < 0) {
        if (!this.pending) this.explainMiss();
        this.clearPending();
      }
      else if (this.pending && this.pending.kind === t.kind && this.pending.id === t.id) this.place(t.id);
      else this.choose(t.kind, t.id);
      return;
    }
    if (t.id < 0) {
      // (A click on the island that misses every legal spot says why, rather than nothing.)
      if (t.hex >= 0) this.explainMiss();
      return;
    }
    this.place(t.id);
  }

  private explainMiss() {
    explain(missReason(useUI.getState().interaction.kind));
  }

  // ------------------------------------------------------------- touch

  private lastPointer = 'mouse';
  /** The spot a touch has chosen and not yet confirmed. */
  private pending: { kind: 'vertex' | 'edge' | 'hex'; id: number } | null = null;
  private hold: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** A tile's details are showing from a press and hold. */
  private held = false;

  /** Preview a tapped spot: its ghost piece (or the hex lit for the robber) and the confirm button. */
  private choose(kind: 'vertex' | 'edge' | 'hex', id: number) {
    this.pending = { kind, id };
    this.kb = { kind, id };
    this.showKeyboardTarget(false);
    const it = useUI.getState().interaction;
    const label = it.kind === 'pick' ? (it.source ? 'Choose this piece' : 'Choose here') : CONFIRM_LABEL[it.kind] ?? 'Place here';
    useUI.getState().set({ placeConfirm: { label } });
  }

  clearPending() {
    if (!this.pending) return;
    this.pending = null;
    this.kb = null;
    this.clearHover();
    useUI.getState().set({ placeConfirm: null });
  }

  confirmPending() {
    const p = this.pending;
    if (!p) return;
    const sp = this.spots();
    if (!sp || sp.kind !== p.kind || !sp.ids.includes(p.id)) return this.clearPending();
    this.place(p.id);
  }

  /** Where the pending spot is on screen now (the confirm button follows it). */
  pendingScreenPoint() {
    return this.pending ? this.screenOf(this.pending.kind, this.pending.id) : null;
  }

  private hideHeld() {
    if (!this.held) return;
    this.held = false;
    this.onHoverHex?.(null);
  }

  private cancelHold() {
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = null;
  }

  /** Press and hold: the details of the tile under the finger (and no tap after it). */
  private showHeld(at: { x: number; y: number }) {
    this.hold = null;
    const t = this.target({ clientX: at.x, clientY: at.y });
    if (t.hex < 0) return;
    this.held = true;
    this.world.rig.suppressClick = true;
    navigator.vibrate?.(8);
    this.onHoverHex?.({ hex: t.hex, x: at.x, y: at.y, vertex: t.kind === 'vertex' && t.id >= 0 ? t.id : undefined, touch: true });
  }

  /** Place the current interaction's piece (or the robber) at target id. */
  private place(id: number) {
    const it = useUI.getState().interaction;
    let err: string | null = null;
    switch (it.kind) {
      case 'setupSettlement':
        err = this.presenter.act({ type: 'placeSetupSettlement', vertex: id });
        break;
      case 'setupRoad':
        err = this.presenter.act({ type: 'placeSetupRoad', edge: id });
        break;
      case 'settlement':
        err = this.presenter.act({ type: 'buildSettlement', vertex: id });
        break;
      case 'city':
        err = this.presenter.act({ type: 'buildCity', vertex: id });
        break;
      case 'road':
        err = this.presenter.act(it.free ? { type: 'placeFreeRoad', edge: id } : { type: 'buildRoad', edge: id });
        break;
      case 'robber':
        err = this.presenter.act({ type: 'moveRobber', hex: id });
        break;
      case 'pick': {
        if (it.chosen) {
          // A staged pick: the spot joins the stage under way, and the move is made once every stage is chosen.
          const step = stagedStep(it.actions, [...it.chosen.slice(0, -1), [...it.chosen[it.chosen.length - 1], id]]);
          if (!step) {
            err = 'Not here';
            break;
          }
          if (!step.done) {
            useUI.getState().set({ interaction: { ...it, spots: step.spots, chosen: step.chosen }, placeConfirm: null, hint: `${it.label}: ${stagedAsk(it.actions[0].type, step)}` });
            this.clearPending();
            this.focus(null);
            this.presenter.syncMarkers();
            sfx.play('click');
            return;
          }
          err = this.presenter.act(step.done);
          break;
        }
        // One move here is made at once; several (the same spot, different terms) are offered as a list.
        const here = it.actions.filter((a) => spotOf(a, it.target, useUI.getState().view!, it.source) === id);
        if (it.source && here.length) {
          // The first tap identifies the piece; only that piece's destinations light up next.
          const state = useUI.getState().view!;
          const target = (['vertex', 'edge', 'hex'] as const).find((kind) => here.every((a) => spotOf(a, kind, state) >= 0));
          if (target) {
            const spots = [...new Set(here.map((a) => spotOf(a, target, state)))];
            useUI.getState().set({ interaction: { ...it, target, spots, actions: here, source: false }, choice: null, placeConfirm: null, hint: `${it.label}: choose a destination on the board` });
            this.clearPending();
            this.focus(null);
            this.presenter.syncMarkers();
            sfx.play('click');
            return;
          }
        }
        if (here.length > 1) {
          useUI.getState().set({ choice: { title: it.label, actions: here } });
          return;
        }
        err = here.length ? this.presenter.act(here[0]) : 'Not here';
        break;
      }
    }
    if (!err) {
      sfx.play('click');
      this.pending = null;
      this.focus(null);
      // (The status line drops what it said at once; the next move's own words replace it as it is presented.)
      useUI.getState().set({ interaction: { kind: 'idle' }, placeConfirm: null, hint: '' });
      this.view.showMarkers(null);
      this.kb = null;
      // The spot's tooltip described a choice that has now been made.
      this.onHoverHex?.(null);
    }
  }

  // ------------------------------------------------------------- keyboard
  // Arrow keys move between the legal spots in screen space, Enter places.

  private kb: { kind: 'vertex' | 'edge' | 'hex'; id: number } | null = null;

  /** The legal targets of the current interaction, if it has any. */
  private spots(): { kind: 'vertex' | 'edge' | 'hex'; ids: number[] } | null {
    const sp = interactionSpots(useUI.getState().interaction);
    return sp?.ids.length ? sp : null;
  }

  private worldOf(kind: 'vertex' | 'edge' | 'hex', id: number): THREE.Vector3 {
    const b = this.view.board;
    if (kind === 'vertex') return this.view.vertexPos(id);
    if (kind === 'edge') {
      const e = b.edges[id];
      const a = b.vertices[e.a], c = b.vertices[e.b];
      const x = (a.x + c.x) / 2, z = (a.z + c.z) / 2;
      return new THREE.Vector3(x, this.view.groundY(x, z), z);
    }
    const h = b.hexes[id];
    return new THREE.Vector3(h.x, this.view.groundY(h.x, h.z), h.z);
  }

  private screenOf(kind: 'vertex' | 'edge' | 'hex', id: number) {
    const p = this.worldOf(kind, id).project(this.world.stage.camera);
    const r = this.canvasRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  /** Arrow keys pick spots while placing; Enter places. Returns true if it handled the key. */
  handleKey(e: KeyboardEvent): boolean {
    const sp = this.spots();
    if (!sp) {
      this.kb = null;
      return false;
    }
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === 'Enter' && this.kb && this.kb.kind === sp.kind && sp.ids.includes(this.kb.id)) {
      this.place(this.kb.id);
      return true;
    }
    const dir = dirs[e.key];
    if (!dir) return false;
    const cur = this.kb && this.kb.kind === sp.kind && sp.ids.includes(this.kb.id) ? this.kb : null;
    let next = -1;
    if (!cur) {
      // Start from the spot nearest the middle of the screen.
      const cx = window.innerWidth / 2, cy = window.innerHeight * 0.48;
      let bd = Infinity;
      for (const id of sp.ids) {
        const s = this.screenOf(sp.kind, id);
        const d = Math.hypot(s.x - cx, s.y - cy);
        if (d < bd) [bd, next] = [d, id];
      }
    } else {
      // The nearest spot roughly in the arrow's direction (within 60°), favouring straight ahead.
      const from = this.screenOf(sp.kind, cur.id);
      let best = Infinity;
      for (const id of sp.ids) {
        if (id === cur.id) continue;
        const s = this.screenOf(sp.kind, id);
        const dx = s.x - from.x, dy = s.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const cos = (dx * dir[0] + dy * dir[1]) / len;
        if (cos < 0.5) continue;
        const score = len * (1 + 2 * (1 - cos));
        if (score < best) [best, next] = [score, id];
      }
      if (next < 0) next = cur.id;
    }
    if (next < 0) return true;
    this.kb = { kind: sp.kind, id: next };
    this.showKeyboardTarget();
    return true;
  }

  private showKeyboardTarget(sound = true) {
    if (!this.kb) return;
    const { kind, id } = this.kb;
    const fx = this.world.effects;
    if (this.hoverHex >= 0) fx.get(this.hoverHex).z = this.rest(this.hoverHex);
    this.hoverHex = -1;
    this.focus(kind, id);
    if (kind === 'hex') {
      this.hoverHex = id;
      fx.get(id).z = 1;
    }
    if (sound) sfx.play('hover');
    const s = this.screenOf(kind, id);
    const hex = kind === 'hex' ? id : kind === 'vertex' ? this.view.board.vertices[id].hexes[0] : this.view.board.edges[id].hexes[0];
    this.onHoverHex?.({ hex, x: s.x, y: s.y, vertex: kind === 'vertex' ? id : undefined });
    const state = useUI.getState().view;
    if (state) useUI.getState().set({ announce: describeSpot(state, this.view.board, kind, id) + '. Enter to place.' });
  }

  clearHover() {
    this.held = false;
    if (this.hoverHex >= 0) this.world.effects.get(this.hoverHex).z = this.rest(this.hoverHex);
    this.hoverHex = -1;
    this.focus(null);
    this.onHoverHex?.(null);
  }

  /** Preview a spot: its ghost piece on the island, and for the flat map (which draws its own) the store's boardFocus. */
  private focus(kind: 'vertex' | 'edge' | 'hex' | null, id = -1) {
    const it = useUI.getState().interaction;
    const me = this.presenter.me;
    if (kind === 'vertex' && id >= 0) this.view.showGhost(it.kind === 'city' ? 'city' : 'settlement', id, me);
    else if (kind === 'edge' && id >= 0) this.view.showGhost('road', id, me);
    else this.view.showGhost(null);
    // A spot that would claim a harbour makes its badge pulse in your colour.
    this.view.previewHarbour(kind === 'vertex' && id >= 0 && (it.kind === 'setupSettlement' || it.kind === 'settlement') ? id : null, me);
    const next = kind && id >= 0 ? { kind, id } : null;
    const cur = useUI.getState().boardFocus;
    if (cur?.kind !== next?.kind || cur?.id !== next?.id) useUI.getState().set({ boardFocus: next });
  }

  // ------------------------------------------------------------ flat map
  // The flat map (ui/FlatBoard.tsx) has its own targets over the spots and tiles; they come here.

  /** Pointing at one of the flat map's spots (or off it, with null): previewed as on the island. */
  hoverSpot(kind: 'vertex' | 'edge' | 'hex' | null, id: number, x: number, y: number) {
    // (A touch's preview stays until it is confirmed or another spot is tapped.)
    if (this.pending) return;
    this.focus(kind, id);
    if (!kind || id < 0) return this.onHoverHex?.(null);
    const b = this.view.board;
    const hex = kind === 'hex' ? id : kind === 'vertex' ? b.vertices[id].hexes[0] : b.edges[id].hexes[0];
    this.onHoverHex?.({ hex, x, y, vertex: kind === 'vertex' ? id : undefined });
  }

  /** A flat map spot pressed: placed at once with a mouse; on touch, previewed first, as on the island. */
  pressSpot(kind: 'vertex' | 'edge' | 'hex', id: number, pointerType: string) {
    this.lastPointer = pointerType;
    if (pointerType === 'touch') {
      if (this.pending && this.pending.kind === kind && this.pending.id === id) this.place(id);
      else this.choose(kind, id);
      return;
    }
    this.place(id);
  }

  /** A flat map tile pointed at, or held on touch: its details (or none, with -1). */
  hoverTile(hex: number, x: number, y: number, touch = false) {
    this.onHoverHex?.(hex >= 0 ? { hex, x, y, touch } : null);
  }

  private disposed = false;

  dispose() {
    this.disposed = true;
    this.clearPending();
    this.clearHover();
    this.disposers.forEach((d) => d());
  }
}

