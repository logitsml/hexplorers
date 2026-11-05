// The flat map's zoom and pan, as plain numbers (app/viewMode.ts puts them into the flat pose, and
// ui/FlatBoard.tsx turns fingers, wheels and keys into them). The map is the fitted one at zoom 1
// (never smaller); zooming in, the camera dollies in on a point it is looking at, which is moved
// across the board by the pan. The pan is held in world units, as an offset of that point from the
// fit's middle, so it means the same thing whatever the window does, and whatever the zoom.

export interface FlatCam {
  /** 1 is the fit; more is closer. */
  zoom: number;
  /** The offset (world units) of the point at the middle of the free part, from the middle of the board. */
  x: number;
  z: number;
}

export const FIT_CAM: FlatCam = { zoom: 1, x: 0, z: 0 };
export const MAX_ZOOM = 4;

/** How much further than the board's own edge the middle of the free part may go (as a fraction of the board's half size), so a corner can be brought to the middle. */
const SLACK = 1.15;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const sameCam = (a: FlatCam, b: FlatCam) => Math.abs(a.zoom - b.zoom) < 1e-6 && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;

/**
 * Zoom within 1 to MAX_ZOOM, and the pan within the board: the more it is zoomed in, the further
 * the middle may travel from the board's, but never so far that the free part's middle is off the
 * board. (At zoom 1 the whole board is in view, so there is nothing to pan to.)
 */
export function clampCam(c: FlatCam, box: { w: number; d: number }): FlatCam {
  const zoom = clamp(c.zoom, 1, MAX_ZOOM);
  const room = 1 - 1 / zoom;
  const rx = (box.w / 2) * room * SLACK, rz = (box.d / 2) * room * SLACK;
  return { zoom, x: clamp(c.x, -rx, rx), z: clamp(c.z, -rz, rz) };
}

/**
 * The zoom changed by `factor`, with the point on screen at (ax, ay) kept where it is. `centre` is
 * where the middle point is on screen, and `k0` the px per world unit at zoom 1.
 */
export function zoomAbout(c: FlatCam, factor: number, ax: number, ay: number, centre: { x: number; y: number }, k0: number): FlatCam {
  const zoom = clamp(c.zoom * factor, 1, MAX_ZOOM);
  // (The world point under the anchor, found at the old zoom, is put back under it at the new.)
  return {
    zoom,
    x: c.x + (ax - centre.x) / (k0 * c.zoom) - (ax - centre.x) / (k0 * zoom),
    z: c.z + (ay - centre.y) / (k0 * c.zoom) - (ay - centre.y) / (k0 * zoom),
  };
}

/** The map dragged by (dx, dy) px: the point under the middle moves the other way. */
export function panBy(c: FlatCam, dx: number, dy: number, k0: number): FlatCam {
  return { zoom: c.zoom, x: c.x - dx / (k0 * c.zoom), z: c.z - dy / (k0 * c.zoom) };
}

/**
 * The transform (a scale about the window's corner, then a shift) that takes the map drawn for
 * `from` to how `to` would draw it: every point on screen goes to s * p + (tx, ty). This is what
 * the map wears between layouts, while a gesture is under way.
 */
export function between(from: FlatCam, to: FlatCam, centre: { x: number; y: number }, k0: number): { s: number; tx: number; ty: number } {
  const s = to.zoom / from.zoom;
  return {
    s,
    tx: (1 - s) * centre.x - (to.x - from.x) * k0 * to.zoom,
    ty: (1 - s) * centre.y - (to.z - from.z) * k0 * to.zoom,
  };
}
