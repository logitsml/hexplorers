import { describe, expect, it } from 'vitest';
import { FIT_CAM, MAX_ZOOM, between, clampCam, panBy, zoomAbout } from '../src/app/flatZoom';

const box = { w: 10, d: 8 };
const centre = { x: 400, y: 300 };
const k0 = 50;

/** Where a world point (offset from the board's middle) is on screen for a zoom and pan. */
const screenOf = (c: { zoom: number; x: number; z: number }, wx: number, wz: number) => ({
  x: centre.x + (wx - c.x) * k0 * c.zoom,
  y: centre.y + (wz - c.z) * k0 * c.zoom,
});

describe('the flat map zoom', () => {
  it('never goes below the fit or above the top zoom, and cannot be panned at the fit', () => {
    expect(clampCam({ zoom: 0.3, x: 5, z: 5 }, box)).toEqual(FIT_CAM);
    expect(clampCam({ zoom: 9, x: 0, z: 0 }, box).zoom).toBe(MAX_ZOOM);
  });

  it('keeps the middle point within the board', () => {
    const c = clampCam({ zoom: 2, x: 99, z: -99 }, box);
    expect(c.x).toBeLessThanOrEqual(box.w / 2);
    expect(c.z).toBeGreaterThanOrEqual(-box.d / 2);
    expect(c.x).toBeGreaterThan(0);
  });

  it('keeps the point under the pointer where it is while zooming', () => {
    const c0 = { zoom: 1.5, x: 0.7, z: -0.4 };
    const anchor = { x: 520, y: 180 };
    // The world point under the anchor before...
    const wx = c0.x + (anchor.x - centre.x) / (k0 * c0.zoom), wz = c0.z + (anchor.y - centre.y) / (k0 * c0.zoom);
    const c1 = zoomAbout(c0, 1.7, anchor.x, anchor.y, centre, k0);
    const p = screenOf(c1, wx, wz);
    expect(p.x).toBeCloseTo(anchor.x, 6);
    expect(p.y).toBeCloseTo(anchor.y, 6);
  });

  it('pans the map with the finger', () => {
    const c0 = { zoom: 2, x: 0, z: 0 };
    const c1 = panBy(c0, 40, -20, k0);
    // A point that was at (500, 300) is now 40 px right and 20 px up of that.
    const wx = (500 - centre.x) / (k0 * c0.zoom), wz = 0;
    const p = screenOf(c1, wx, wz);
    expect(p.x).toBeCloseTo(540, 6);
    expect(p.y).toBeCloseTo(280, 6);
  });

  it('gives the transform that takes the map drawn for one zoom to how another draws it', () => {
    const a = { zoom: 1.4, x: 0.5, z: 0.2 };
    const b = { zoom: 3, x: -1, z: 1.1 };
    const t = between(a, b, centre, k0);
    for (const [wx, wz] of [[0, 0], [2, -1], [-3, 2.5]]) {
      const was = screenOf(a, wx, wz), now = screenOf(b, wx, wz);
      expect(t.s * was.x + t.tx).toBeCloseTo(now.x, 6);
      expect(t.s * was.y + t.ty).toBeCloseTo(now.y, 6);
    }
  });
});
