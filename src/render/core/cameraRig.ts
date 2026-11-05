// Orbit camera with damping, keyboard controls, focus moves and an intro flight.
// Left-drag (or one finger) grabs the map and pans it, with the ground under the pointer
// staying under it; the view can be pushed a little past the island's edge and springs back.
// Right-drag (or shift/ctrl-drag) orbits and tilts; the wheel zooms towards the pointer (which
// button does which, and the keys, are the player's to choose: game/bindings.ts). Two
// fingers, as in map apps: moved together, up and down tilts and sideways turns; spread or
// twisted, they zoom towards their midpoint and turn (and the midpoint drags the map). Which of
// the two is decided once the fingers have moved a little, and kept until they lift. A short
// click still selects. WASD pans, Q/E rotate, R/F tilt, H (or the reset button) flies home.
// For the flat 2D view the camera flies straight overhead with a dolly zoom and locks there.

import * as THREE from 'three/webgpu';
import { clamp, lerp } from '../util/noise';
import { ease } from '../util/tween';
import { DEFAULT_MOUSE, dragJob, keysOf, type BindAction, type KeyBinds, type MouseBinds } from '../../game/bindings';

export interface CameraPose {
  target: THREE.Vector3;
  distance: number;
  /** Elevation above the horizon in radians. */
  pitch: number;
  /** Rotation around the vertical axis in radians (0 = looking north from the south). */
  yaw: number;
  /** Vertical field of view in degrees (36 normally; narrow far overhead, for the flat view). */
  fov?: number;
  /** Where the target sits on screen, in px from the middle (to centre the map between panels). */
  shiftX?: number;
  shiftY?: number;
  /**
   * How the target is put there: 0 (as by default) by sliding the camera across, which leaves the
   * horizon where it was (the title's sea, lifted above the menu); 1 by shifting the lens, which
   * moves the whole picture, so a board seen at a slant is drawn square, not skewed (the slide
   * moves what's nearer the camera further). In between, a blend, so flights pass smoothly from
   * one to the other.
   */
  lens?: number;
}

const tanHalf = (fov = 36) => Math.tan((fov * Math.PI) / 360);
const fovOf = (tanH: number) => (Math.atan(tanH) * 360) / Math.PI;

/** The classic island's radius (its outer hexes' centres plus a hex and a little shore). */
const CLASSIC_RADIUS = 4.61;

/**
 * The board the camera frames: its centre (the middle of its land's bounding box), the reach of its
 * land from the centre (`scale` against the classic island's, for how far the view may wander), and
 * the points the home view must show: the corners of its land, its harbours' signs and its fishing
 * grounds' rings, as x, z pairs on the ground (World.frameIsland).
 */
const boardFrame = { x: 0, z: 0, scale: 1, points: [] as number[] };

/**
 * Frame a board (World.frameIsland): centred at (x, z), its land reaching `radius` from there, and
 * everything that should be in view at home (`points`, as x, z pairs) within the part of the window
 * the HUD leaves.
 */
export function setBoardFrame(x: number, z: number, radius: number, points: number[]) {
  boardFrame.x = x;
  boardFrame.z = z;
  boardFrame.scale = Math.max(1, radius / CLASSIC_RADIUS);
  boardFrame.points = points;
}

/** The frame as it stands, for a view that frames a board of its own (the map editor's grid) to put back when it goes. */
export const boardFrameState = () => ({ ...boardFrame });
export const restoreBoardFrame = (frame: ReturnType<typeof boardFrameState>) => void Object.assign(boardFrame, frame);

/**
 * Where on the window the board may be put: the window's size, the rectangle of it the HUD's
 * panels leave free, and the margin (px) the board keeps in from that rectangle's edges, for the
 * pieces and harbours' badges that don't shrink with it (app/mapFit.ts). Every view of the whole
 * board, the home view here and the flat map (app/viewMode.ts), is fitted to it.
 */
export interface ViewFrame {
  w: number;
  h: number;
  free: { x: number; y: number; w: number; h: number };
  pad: number;
}

let viewFrame: ViewFrame | null = null;

export function setViewFrame(f: ViewFrame | null) {
  viewFrame = f;
}

/** How tall the island stands (a mountain's peak, a tall tree), in world units: the home view leaves it room above. */
const STAND = 0.9;
/** The home view's pitch (radians above the horizon). */
const HOME_PITCH = 0.92;

/**
 * The home view: straight on from the south at `HOME_PITCH`, the board's middle at the middle of
 * the free part of the window (the lens is shifted there, so the board is drawn square, as the
 * slide would skew it), and as near as holds all of the board's points (and a little height above
 * them) inside that part, a margin in from its edges. Nearest by search: the distance isn't
 * proportional to the size on screen (the nearer parts are drawn larger), so there is no closed
 * form, and a handful of points over a few dozen halvings costs nothing.
 */
export const homePose = (): CameraPose => clonePose(sharedHome());

/**
 * The home view itself, not to be changed (the check for a view away from home reads it every
 * frame): the search is made again only when what it is made from has changed.
 */
function sharedHome(): CameraPose {
  const W = viewFrame?.w || window.innerWidth, H = Math.max(1, viewFrame?.h || window.innerHeight);
  const c = homeCache;
  if (c && c.frame === viewFrame && c.points === boardFrame.points && c.x === boardFrame.x && c.z === boardFrame.z && c.W === W && c.H === H) return c.pose;
  const pose = searchHome(W, H);
  homeCache = { frame: viewFrame, points: boardFrame.points, x: boardFrame.x, z: boardFrame.z, W, H, pose };
  return pose;
}

let homeCache: { frame: ViewFrame | null; points: number[]; x: number; z: number; W: number; H: number; pose: CameraPose } | null = null;

function searchHome(W: number, H: number): CameraPose {
  const free = viewFrame?.free ?? { x: 0, y: 0, w: W, h: H };
  const pad = viewFrame?.pad ?? 12;
  const focal = H / 2 / tanHalf(36);
  const sp = Math.sin(HOME_PITCH), cp = Math.cos(HOME_PITCH);
  const pts = boardFrame.points;
  // Where the points fall, in px from where the target is drawn: the extent of them all. (The
  // camera looks north from `d` away, tipped down; a point `dx` east, `dz` south of the target and
  // `y` up is `d - y sp - dz cp` along the view, and `y cp - dz sp` up the screen.)
  const extent = (d: number) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const dx = pts[i] - boardFrame.x, dz = pts[i + 1] - boardFrame.z;
      for (const y of [0, STAND]) {
        const depth = d - y * sp - dz * cp;
        const px = (focal * dx) / depth, py = (-focal * (y * cp - dz * sp)) / depth;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
    return { x0, x1, y0, y1 };
  };
  const roomW = Math.max(40, free.w - 2 * pad), roomH = Math.max(40, free.h - 2 * pad);
  let near = 4, far = 600;
  if (pts.length) {
    for (let i = 0; i < 40; i++) {
      const d = (near + far) / 2, e = extent(d);
      if (e.x1 - e.x0 > roomW || e.y1 - e.y0 > roomH) near = d;
      else far = d;
    }
  } else far = 14.5;
  const e = pts.length ? extent(far) : { x0: 0, x1: 0, y0: 0, y1: 0 };
  return {
    target: new THREE.Vector3(boardFrame.x, 0, boardFrame.z),
    distance: far,
    pitch: HOME_PITCH,
    yaw: 0,
    fov: 36,
    shiftX: free.x + free.w / 2 - W / 2 - (e.x0 + e.x1) / 2,
    shiftY: free.y + free.h / 2 - H / 2 - (e.y0 + e.y1) / 2,
    lens: 1,
  };
}

/** How far (px) two fingers move before their gesture is decided. */
const TWO_FINGER_SLOP = 12;

export class CameraRig {
  pose = homePose();
  goal = homePose();
  /** radius: how far the view centre may go (soft, then it springs back); hardRadius: never past. */
  limits = { minDist: 5, maxDist: 30, minPitch: 0.28, maxPitch: 1.42, radius: 4.2, hardRadius: 6 };
  private keys = new Set<string>();
  /** Set by the board input: true while arrow keys are choosing placement spots. */
  arrowsCaptured: () => boolean = () => false;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragMode: 'orbit' | 'pan' | null = null;
  private dragMoved = 0;
  private pinchDist = 0;
  private pinchAngle = 0;
  private pinchMid = { x: 0, y: 0 };
  /** Two fingers: undecided until they move, then tilting/turning or pinching, until they lift. */
  private twoMode: 'pending' | 'orbit' | 'pinch' | null = null;
  private twoStart = { dist: 0, angle: 0, mid: { x: 0, y: 0 } };
  /** Pan momentum (world units per second), carried on after a pan drag is let go. */
  private glide = new THREE.Vector2();
  private lastPanAt = 0;
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** Whether the view is away from home (for the reset button); reported on change. */
  offHome = false;
  onHomeChange: ((off: boolean) => void) | null = null;
  private flight: { from: CameraPose; to: CameraPose; t: number; dur: number; dolly: boolean; easing: (t: number) => number; resolve: () => void } | null = null;
  private _locked = false;
  /** The flat view: the camera holds still (no drags, wheel, keys or glances) until released. */
  get locked() {
    return this._locked;
  }
  set locked(v: boolean) {
    this._locked = v;
    if (!v) return;
    // A glance under way would fly back down under the map; a drag would cancel its flight.
    this.focusToken++;
    this.pointers.clear();
    this.dragMode = null;
    this.twoMode = null;
    this.glide.set(0, 0);
  }
  private shake = 0;
  /** Set when the last pointerdown turned into a drag (so the click should be ignored). */
  suppressClick = false;
  /**
   * The map editor's 3D view (null otherwise). A press `claim` says yes to is the editor's (a
   * brush painting along a drag) and moves nothing; a right-drag pans, as on the editor's flat
   * board (Shift or Alt and a drag still turns); two fingers travelling together pan, rather than
   * tilt.
   */
  editing: { claim: (e: PointerEvent) => boolean } | null = null;
  private disposers: (() => void)[] = [];
  private slide = new THREE.Vector3();
  /** The lens's shift (px, see CameraPose.lens), and the one the projection was last made with. */
  private offAxis = new THREE.Vector2();
  private madeAxis = new THREE.Vector2();
  /**
   * The view's size (CSS px), as a ResizeObserver last gave it: read every frame, and from the
   * element itself that would lay the page out again whenever anything had changed (each time the
   * projection is made, a few times a frame).
   */
  private box = { w: 0, h: 0 };
  private width = () => this.box.w || window.innerWidth;
  private height = () => this.box.h || window.innerHeight;

  constructor(
    public camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    // The lens's shift goes into the projection every time it is made, so it outlasts the temporal
    // AA's jitter (which makes the projection again each frame, through a view offset of its own)
    // and is in what the picking, the culling and the motion vectors use.
    const project = camera.updateProjectionMatrix.bind(camera);
    camera.updateProjectionMatrix = () => {
      project();
      const o = this.offAxis;
      this.madeAxis.copy(o);
      if (o.x === 0 && o.y === 0) return;
      const e = camera.projectionMatrix.elements;
      e[8] -= (2 * o.x) / Math.max(1, this.width());
      e[9] += (2 * o.y) / Math.max(1, this.height());
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    };
    this.box = { w: dom.clientWidth, h: dom.clientHeight };
    const sized = new ResizeObserver(([entry]) => {
      this.box.w = entry.contentRect.width;
      this.box.h = entry.contentRect.height;
    });
    sized.observe(dom);
    this.disposers.push(() => sized.disconnect());
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(ev, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(ev, fn as EventListener, opts));
    };
    on(dom, 'pointerdown', (e) => this.onDown(e));
    on(window, 'pointermove', (e) => this.onMove(e));
    on(window, 'pointerup', (e) => this.onUp(e));
    on(window, 'pointercancel', (e) => this.onUp(e));
    on(dom, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(dom, 'contextmenu', (e) => e.preventDefault());
    // (Keys by their place on the keyboard, so WASD sits right on any layout and a '+' let go
    // after Shift still lifts.)
    on(window, 'keydown', (e) => {
      if (isTyping(e) || !this.keysEnabled()) return;
      this.keys.add(e.code);
      if (!e.repeat && !this.locked && keysOf('home', this.binds().keys).includes(e.code)) this.reset();
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    // Losing the window loses the lifts too: forget held keys and fingers.
    on(window, 'blur', () => {
      this.keys.clear();
      this.pointers.clear();
      this.dragMode = null;
      this.twoMode = null;
    });
  }

  private onDown(e: PointerEvent) {
    if (this.locked) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragMoved = 0;
    this.suppressClick = false;
    this.glide.set(0, 0);
    // (A third finger or more does nothing: the two first keep their pinch, and none pans alone.)
    if (this.pointers.size > 2) return;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchAngle = Math.atan2(b.y - a.y, b.x - a.x);
      this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.twoStart = { dist: this.pinchDist, angle: this.pinchAngle, mid: { ...this.pinchMid } };
      this.twoMode = 'pending';
      this.dragMode = null;
      return;
    }
    if (this.pointers.size === 1 && this.editing?.claim(e)) {
      this.dragMode = null;
      return;
    }
    // (The middle button's own default, the page's autoscroll, would take over the drag.)
    if (e.button === 1) e.preventDefault();
    const job = dragJob(e.button, this.binds().mouse);
    if (e.button === 2 && this.editing) this.dragMode = 'pan';
    else if (job === 'turn' || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.altKey))) this.dragMode = 'orbit';
    else if (job === 'pan') this.dragMode = 'pan';
  }

  private onMove(e: PointerEvent) {
    if (this.locked) return;
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    if (this.pointers.size > 2) return;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.suppressClick = true;
      if (this.twoMode === 'pending') {
        // Spreading or twisting (measured as the distance the fingertips travel) means a pinch;
        // the pair travelling together, a tilt or turn. Until one is clear, nothing moves.
        const s0 = this.twoStart;
        const spread = Math.abs(d - s0.dist);
        const twist = Math.abs(Math.atan2(Math.sin(ang - s0.angle), Math.cos(ang - s0.angle))) * d * 0.5;
        const travel = Math.hypot(mid.x - s0.mid.x, mid.y - s0.mid.y);
        if (Math.max(spread, twist) > TWO_FINGER_SLOP) this.twoMode = 'pinch';
        // (In the editor, a pinch: its midpoint carries the map along.)
        else if (travel > TWO_FINGER_SLOP) this.twoMode = this.editing ? 'pinch' : 'orbit';
        else return;
        this.endFlight();
        this.focusToken++;
        this.glide.set(0, 0);
      } else if (this.twoMode === 'orbit') {
        const h = this.dom.clientHeight || 800;
        const mdx = mid.x - this.pinchMid.x, mdy = mid.y - this.pinchMid.y;
        // The same senses as a right-drag: up tilts towards the horizon, sideways turns.
        this.goal.yaw -= (mdx / h) * 3.2;
        this.goal.pitch = clamp(this.goal.pitch + (mdy / h) * 2.4, this.limits.minPitch, this.limits.maxPitch);
      } else if (this.twoMode === 'pinch' && this.pinchDist > 0) {
        this.grabPan(this.pinchMid.x, this.pinchMid.y, mid.x, mid.y);
        this.zoomBy(this.pinchDist / Math.max(1, d));
        this.goal.yaw += Math.atan2(Math.sin(ang - this.pinchAngle), Math.cos(ang - this.pinchAngle));
      }
      this.pinchDist = d;
      this.pinchAngle = ang;
      this.pinchMid = mid;
      return;
    }
    this.dragMoved += Math.abs(dx) + Math.abs(dy);
    if (this.dragMoved < 6) return;
    this.suppressClick = true;
    // (A press the editor claimed paints: the camera's flight, if any, carries on.)
    if (this.editing && !this.dragMode) return;
    this.endFlight();
    this.focusToken++;
    const h = this.dom.clientHeight || 800;
    if (this.dragMode === 'orbit') {
      this.goal.yaw -= (dx / h) * 3.2;
      this.goal.pitch = clamp(this.goal.pitch + (dy / h) * 2.4, this.limits.minPitch, this.limits.maxPitch);
    } else if (this.dragMode === 'pan') {
      const before = this.goal.target.clone();
      this.grabPan(e.clientX - dx, e.clientY - dy, e.clientX, e.clientY);
      // Track the drag's speed for the glide after release.
      const now = performance.now();
      const dt = Math.max(1, now - this.lastPanAt) / 1000;
      if (dt < 0.1) {
        const vx = (this.goal.target.x - before.x) / dt, vz = (this.goal.target.z - before.z) / dt;
        this.glide.set(this.glide.x * 0.6 + vx * 0.4, this.glide.y * 0.6 + vz * 0.4);
      } else this.glide.set(0, 0);
      this.lastPanAt = now;
    }
  }

  /** Where a screen point meets the ground (y = 0), as seen from the camera now. */
  private groundAt(x: number, y: number, out: THREE.Vector3): THREE.Vector3 | null {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.intersectPlane(this.ground, out);
  }

  /**
   * Drag the map so the ground under (x0, y0) moves to (x1, y1). Near the horizon a pixel
   * covers a lot of ground, so each step is capped; past the island's edge the map resists.
   */
  private grabPan(x0: number, y0: number, x1: number, y1: number) {
    const a = this.groundAt(x0, y0, new THREE.Vector3());
    const b = this.groundAt(x1, y1, new THREE.Vector3());
    const h = this.dom.clientHeight || 800;
    if (!a || !b) {
      this.panBy(-(x1 - x0) / h, -(y1 - y0) / h);
      return;
    }
    const d = new THREE.Vector2(a.x - b.x, a.z - b.z);
    const cap = this.goal.distance * 0.25;
    if (d.length() > cap) d.setLength(cap);
    // Rubber band: the further out past the edge, the less the map follows.
    const t = this.goal.target;
    const ox = t.x - boardFrame.x, oz = t.z - boardFrame.z;
    const r = Math.hypot(ox + d.x, oz + d.y);
    const outward = (ox * d.x + oz * d.y) > 0;
    const radius = this.limits.radius * boardFrame.scale;
    if (outward && r > radius) d.multiplyScalar(1 / (1 + (r - radius) * 2.2));
    this.moveTarget(d.x, d.y);
  }

  private moveTarget(dx: number, dz: number) {
    const t = this.goal.target;
    t.x += dx;
    t.z += dz;
    // (Measured from the board's centre, and scaled with it.)
    const ox = t.x - boardFrame.x, oz = t.z - boardFrame.z;
    const r = Math.hypot(ox, oz);
    const hard = this.limits.hardRadius * boardFrame.scale;
    if (r > hard) {
      t.x = boardFrame.x + (ox * hard) / r;
      t.z = boardFrame.z + (oz * hard) / r;
    }
  }

  /** Abandon a flight where the camera is now; anyone awaiting it continues. */
  private endFlight() {
    const f = this.flight;
    this.flight = null;
    f?.resolve();
  }

  private onUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    // A pan let go while still moving glides on; one held still first stops where it is.
    if (this.dragMode !== 'pan' || performance.now() - this.lastPanAt > 60) this.glide.set(0, 0);
    if (this.pointers.size === 0) this.dragMode = null;
    // The other finger stays put rather than turning into a pan halfway through.
    if (this.pointers.size < 2) this.twoMode = null;
    this.pinchDist = 0;
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (this.locked) return;
    this.endFlight();
    this.focusToken++;
    this.glide.set(0, 0);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const before = this.goal.distance;
    this.zoomBy(Math.exp(delta * 0.0012));
    // Zoom towards the point under the pointer (and away from it when zooming out).
    const f = this.goal.distance / before;
    const hit = this.groundAt(e.clientX, e.clientY, new THREE.Vector3());
    if (hit && f !== 1) {
      const t = this.goal.target;
      const k = Math.min(1, 1 - f);
      this.moveTarget((hit.x - t.x) * k, (hit.z - t.z) * k);
    }
  }

  zoomBy(factor: number) {
    this.goal.distance = clamp(this.goal.distance * factor, this.limits.minDist, Math.max(this.limits.maxDist * boardFrame.scale, homePose().distance * 1.15));
  }

  panBy(nx: number, ny: number) {
    const scale = this.goal.distance * 0.9;
    const cos = Math.cos(this.goal.yaw);
    const sin = Math.sin(this.goal.yaw);
    // Screen right = (cos, 0, -sin)... in our yaw convention camera sits at +z when yaw = 0.
    const rx = cos, rz = -sin;
    const fx = -sin, fz = -cos;
    this.moveTarget((rx * nx - fx * ny) * scale, (rz * nx - fz * ny) * scale);
  }

  reset() {
    if (this.locked) return;
    this.glide.set(0, 0);
    this.focusToken++;
    this.flyTo(homePose(), 1.2);
  }

  /** Whether the camera is at rest at the home view (as the frame stands now). */
  atHome() {
    return !this.locked && !this.flight && this.pointers.size === 0 && !this.awayFromHome();
  }

  /**
   * The window, or the part of it the HUD leaves free, has changed (app/mapFit.ts): a view at home
   * glides to the new home. (One still flying home, as the opening's does, is turned to the new
   * one where it is, rather than left to arrive at the old.)
   */
  refitHome(frame: ViewFrame | null, duration = 0.5) {
    const before = homePose();
    const settled = this.atHome();
    const f = this.flight;
    const arriving = !!f && !this.locked && f.to.distance === before.distance && f.to.shiftX === before.shiftX && f.to.shiftY === before.shiftY;
    setViewFrame(frame);
    if (settled) void this.flyTo(homePose(), duration);
    else if (arriving) f.to = clonePose(homePose());
  }

  /** Away from the home view by more than a glance (used to offer the reset button). */
  private awayFromHome() {
    const home = sharedHome();
    const g = this.goal;
    const dyaw = Math.abs(Math.atan2(Math.sin(g.yaw - home.yaw), Math.cos(g.yaw - home.yaw)));
    return g.target.distanceTo(home.target) > 0.6 || Math.abs(g.distance - home.distance) > home.distance * 0.18 || Math.abs(g.pitch - home.pitch) > 0.14 || dyaw > 0.25;
  }

  /**
   * Smoothly move to a pose; resolves on arrival. With `dolly`, a change of lens keeps the
   * island's size on screen as the camera moves (a dolly zoom): narrowing as it rises overhead,
   * the perspective melts into a flat map, and widening on the way back down it returns.
   * `easing`: how the flight gathers pace and arrives (by default, gently at both ends).
   */
  flyTo(to: Partial<CameraPose>, duration = 1.4, dolly = false, easing: (t: number) => number = ease.inOutCubic): Promise<void> {
    const target: CameraPose = {
      target: (to.target ?? this.goal.target).clone(),
      distance: to.distance ?? this.goal.distance,
      pitch: to.pitch ?? this.goal.pitch,
      yaw: to.yaw ?? this.goal.yaw,
      fov: to.fov ?? this.goal.fov,
      shiftX: to.shiftX ?? this.goal.shiftX,
      shiftY: to.shiftY ?? this.goal.shiftY,
      // (Unless asked for, the camera slides: as every view but the map editor's has it.)
      lens: to.lens ?? 0,
    };
    // Take the short way around.
    const dy = target.yaw - this.pose.yaw;
    target.yaw = this.pose.yaw + Math.atan2(Math.sin(dy), Math.cos(dy));
    this.flight?.resolve();
    return new Promise((resolve) => {
      this.flight = { from: clonePose(this.pose), to: target, t: 0, dur: duration, dolly, easing, resolve };
    });
  }

  /** Where the camera is headed (a copy, to come back to later). */
  snapshot(): CameraPose {
    return clonePose(this.goal);
  }

  /** Be at a pose straight away (no flight). */
  jumpTo(to: CameraPose) {
    this.focusToken++;
    this.endFlight();
    this.glide.set(0, 0);
    this.goal = clonePose(to);
    this.pose = clonePose(to);
  }

  /**
   * Gently pan towards a point of interest, then glide back to where the player was looking. With
   * motion kept down (`calm`), the camera stays where it is and the spot is marked in place
   * instead (`stillCue`: the World glows the hex), so the glance still says where.
   */
  async focusOn(x: number, z: number, hold = 1.6) {
    if (this.locked) return;
    if (this.calm()) {
      this.stillCue?.(x, z);
      return;
    }
    const back = clonePose(this.goal);
    const token = ++this.focusToken;
    // (Over the board's middle towards the spot: on a map off the origin, the origin is open sea.)
    const toward = new THREE.Vector3(boardFrame.x + (x - boardFrame.x) * 0.55, 0, boardFrame.z + (z - boardFrame.z) * 0.55 + 0.2);
    await this.flyTo({ target: toward, distance: Math.min(this.goal.distance, 12) }, 0.9);
    if (token !== this.focusToken) return;
    await new Promise((r) => setTimeout(r, hold * 1000));
    // Only return if nothing else moved or locked the camera in the meantime.
    if (token === this.focusToken && !this.flight && !this.locked) await this.flyTo(back, 1.1);
  }

  /** Call off a glance still waiting to fly back (a game ending, a view changing). */
  cancelFocus() {
    this.focusToken++;
  }

  private focusToken = 0;

  /** Set by the board input while a game is on (false while a dialog is open); off otherwise. */
  keysEnabled: () => boolean = () => false;
  /** The player's keys and mouse buttons (the usual ones until the game says otherwise). */
  binds: () => { keys: KeyBinds; mouse: MouseBinds } = () => ({ keys: {}, mouse: DEFAULT_MOUSE });
  /**
   * Whether motion is to be kept down (Settings, or the system's preference): set by the app, which
   * owns the setting (render code doesn't read it). Glances then don't fly the camera.
   */
  calm: () => boolean = () => false;
  /** What marks a glanced-at spot when the camera stays still (the World: a glow on the hex). */
  stillCue: ((x: number, z: number) => void) | null = null;

  /** True while a scripted camera move is in progress. */
  get flying() {
    return this.flight !== null;
  }

  /** How far the scripted move under way has got (0..1), or null when there is none. */
  get flightProgress(): number | null {
    return this.flight ? Math.min(1, this.flight.t) : null;
  }

  addShake(amount: number) {
    this.shake = Math.min(0.25, this.shake + amount);
  }

  update(dt: number) {
    if (this.flight) {
      const f = this.flight;
      f.t += dt / f.dur;
      const k = f.t >= 1 ? 1 : f.easing(f.t);
      this.goal.target.lerpVectors(f.from.target, f.to.target, k);
      this.goal.pitch = lerp(f.from.pitch, f.to.pitch, k);
      this.goal.yaw = lerp(f.from.yaw, f.to.yaw, k);
      this.goal.shiftX = lerp(f.from.shiftX ?? 0, f.to.shiftX ?? 0, k);
      this.goal.shiftY = lerp(f.from.shiftY ?? 0, f.to.shiftY ?? 0, k);
      this.goal.lens = lerp(f.from.lens ?? 0, f.to.lens ?? 0, k);
      if (f.dolly) {
        // The height of the view at the target eases from start to end while the lens changes
        // (mostly in the half nearer the flat end); the distance follows from the two.
        const t0 = tanHalf(f.from.fov), t1 = tanHalf(f.to.fov);
        const tt = Math.min(1, f.t);
        const kf = ease.inOutCubic(t1 < t0 ? clamp((tt - 0.15) / 0.85, 0, 1) : clamp(tt / 0.85, 0, 1));
        const tanH = lerp(t0, t1, kf);
        this.goal.fov = fovOf(tanH);
        this.goal.distance = lerp(f.from.distance * t0, f.to.distance * t1, k) / tanH;
      } else {
        this.goal.distance = lerp(f.from.distance, f.to.distance, k);
        this.goal.fov = lerp(f.from.fov ?? 36, f.to.fov ?? 36, k);
      }
      if (f.t >= 1) {
        this.flight = null;
        f.resolve();
      }
    }
    // Glide after a flung pan, and spring back inside the island's bounds once let go. (Not while
    // the camera is held, as over the flat map: its pan may take the view past those bounds.)
    if (!this.flight && !this.locked && this.dragMode !== 'pan' && this.pointers.size < 2) {
      if (this.glide.lengthSq() > 1e-4) {
        this.moveTarget(this.glide.x * dt, this.glide.y * dt);
        this.glide.multiplyScalar(Math.exp(-dt * 4.5));
      }
      const t = this.goal.target;
      const ox = t.x - boardFrame.x, oz = t.z - boardFrame.z;
      const r = Math.hypot(ox, oz);
      const radius = this.limits.radius * boardFrame.scale;
      if (r > radius) {
        const k = 1 - Math.exp(-dt * 6);
        const pull = ((r - radius) / r) * k;
        t.x -= ox * pull;
        t.z -= oz * pull;
        this.glide.multiplyScalar(Math.exp(-dt * 10));
      }
    }
    if (!this.flight && this.keysEnabled() && !this.locked) {
      const k = this.keys;
      const binds = this.binds().keys;
      const held = (a: BindAction) => k.size > 0 && keysOf(a, binds).some((c) => k.has(c));
      const pan = dt * 0.9;
      // While placing a piece the arrow keys pick spots on the board; WASD still pans.
      const arrows = !this.arrowsCaptured();
      if (held('panUp') || (arrows && k.has('ArrowUp'))) this.panBy(0, -pan);
      if (held('panDown') || (arrows && k.has('ArrowDown'))) this.panBy(0, pan);
      if (held('panLeft') || (arrows && k.has('ArrowLeft'))) this.panBy(-pan, 0);
      if (held('panRight') || (arrows && k.has('ArrowRight'))) this.panBy(pan, 0);
      if (held('turnLeft')) this.goal.yaw += dt * 1.2;
      if (held('turnRight')) this.goal.yaw -= dt * 1.2;
      if (held('tiltUp')) this.goal.pitch = clamp(this.goal.pitch + dt, this.limits.minPitch, this.limits.maxPitch);
      if (held('tiltDown')) this.goal.pitch = clamp(this.goal.pitch - dt, this.limits.minPitch, this.limits.maxPitch);
      if (held('zoomIn')) this.zoomBy(1 - dt);
      if (held('zoomOut')) this.zoomBy(1 + dt);
    }
    // Critically-damped follow.
    const s = this.flight ? 1 : 1 - Math.exp(-dt * 9);
    this.pose.target.lerp(this.goal.target, s);
    this.pose.distance = lerp(this.pose.distance, this.goal.distance, s);
    this.pose.pitch = lerp(this.pose.pitch, this.goal.pitch, s);
    this.pose.yaw = lerp(this.pose.yaw, this.goal.yaw, s);
    this.pose.fov = lerp(this.pose.fov ?? 36, this.goal.fov ?? 36, s);
    this.pose.shiftX = lerp(this.pose.shiftX ?? 0, this.goal.shiftX ?? 0, s);
    this.pose.shiftY = lerp(this.pose.shiftY ?? 0, this.goal.shiftY ?? 0, s);
    this.pose.lens = lerp(this.pose.lens ?? 0, this.goal.lens ?? 0, s);

    const off = !this.locked && !this.flight && this.awayFromHome();
    if (off !== this.offHome) {
      this.offHome = off;
      this.onHomeChange?.(off);
    }

    const p = this.pose;
    const cx = p.target.x + Math.sin(p.yaw) * Math.cos(p.pitch) * p.distance;
    const cz = p.target.z + Math.cos(p.yaw) * Math.cos(p.pitch) * p.distance;
    const cy = p.target.y + Math.sin(p.pitch) * p.distance;
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(p.target);
    // The lens: a narrow one far overhead takes the near plane out with it (keeping depth precise).
    const fov = p.fov ?? 36;
    const near = Math.max(0.1, p.distance * 0.25 * clamp((36 - fov) / 20, 0, 1));
    const far = Math.max(600, p.distance + 300);
    // Off-centre: the target drawn away from the middle of the window, by the lens's shift and the
    // camera's slide in the pose's measure (see CameraPose.lens).
    const lens = clamp(p.lens ?? 0, 0, 1);
    this.offAxis.set((p.shiftX ?? 0) * lens, (p.shiftY ?? 0) * lens);
    if (this.camera.fov !== fov || this.camera.near !== near || this.camera.far !== far || !this.offAxis.equals(this.madeAxis)) {
      this.camera.fov = fov;
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    // The slide: across, parallel to the screen, by as much as the shift is at the target's
    // distance (the same picture as the lens's shift there, but nearer things move further).
    const sx = (p.shiftX ?? 0) * (1 - lens), sy = (p.shiftY ?? 0) * (1 - lens);
    if (Math.abs(sx) + Math.abs(sy) > 0.25) {
      const h = this.height();
      const k = h / 2 / (p.distance * tanHalf(fov));
      this.camera.position.add(this.slide.set(1, 0, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(-sx / k));
      this.camera.position.add(this.slide.set(0, 1, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(sy / k));
    }
    if (this.shake > 0.0005 && !this.locked) {
      const t = performance.now() * 0.05;
      this.camera.position.x += Math.sin(t * 1.3) * this.shake * 0.12;
      this.camera.position.y += Math.sin(t * 1.9) * this.shake * 0.08;
      this.shake *= Math.exp(-dt * 6);
    }
  }

  dispose() {
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }
}

function clonePose(p: CameraPose): CameraPose {
  return { target: p.target.clone(), distance: p.distance, pitch: p.pitch, yaw: p.yaw, fov: p.fov ?? 36, shiftX: p.shiftX ?? 0, shiftY: p.shiftY ?? 0, lens: p.lens ?? 0 };
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

