import { describe, expect, it } from 'vitest';
import { area, centredRects, emptyRects, fitScale, inflate, intersect, pickCentred, pickRect, union, type Rect } from '../src/app/freeRect';

const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const biggest = (rs: Rect[]) => rs.reduce((a, r) => (area(r) > area(a) ? r : a));

/** Whether no part of `r` is inside a wall. */
const empty = (r: Rect, walls: Rect[]) => walls.every((b) => intersect(r, b).w <= 1e-9 || intersect(r, b).h <= 1e-9);

describe('the rectangle maths', () => {
  it('inflates, shrinks and joins', () => {
    expect(inflate(box(10, 10, 20, 20), 5)).toEqual(box(5, 5, 30, 30));
    expect(inflate(box(10, 10, 20, 20), -15)).toEqual(box(20, 20, 0, 0));
    expect(union(box(0, 0, 10, 10), box(20, 5, 10, 10))).toEqual(box(0, 0, 30, 15));
    expect(intersect(box(0, 0, 10, 10), box(5, 5, 10, 10))).toEqual(box(5, 5, 5, 5));
    expect(intersect(box(0, 0, 10, 10), box(20, 20, 5, 5)).w).toBe(0);
  });
});

describe('emptyRects', () => {
  const window = box(0, 0, 100, 60);

  it('is the window itself with nothing in it', () => {
    expect(biggest(emptyRects(window, []))).toEqual(window);
  });

  it('finds the strip between two columns', () => {
    const walls = [box(0, 0, 20, 60), box(80, 0, 20, 60)];
    expect(biggest(emptyRects(window, walls))).toEqual(box(20, 0, 60, 60));
  });

  it('goes under a bar across the top and over a hand along the bottom', () => {
    const walls = [box(30, 0, 40, 10), box(25, 45, 50, 15)];
    const best = biggest(emptyRects(window, walls));
    // (Full width between them, 35 tall, or full height on one side of a panel: the first is bigger.)
    expect(best).toEqual(box(0, 10, 100, 35));
  });

  it('never returns a rectangle a panel stands in, and clips panels to the window', () => {
    const walls = [box(-50, 20, 80, 10), box(60, 10, 200, 20), box(40, 40, 10, 10)];
    const found = emptyRects(window, walls);
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) {
      expect(empty(r, walls)).toBe(true);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(100);
      expect(r.y + r.h).toBeLessThanOrEqual(60);
    }
  });

  it('holds the largest empty rectangle (checked against every grid cell of a crowded window)', () => {
    // (A small window, on a unit grid: the best empty rectangle by trying every one.)
    const walls = [box(2, 1, 3, 2), box(7, 0, 2, 4), box(0, 5, 4, 1), box(5, 4, 4, 2), box(3, 3, 1, 1)];
    const w = box(0, 0, 10, 7);
    let best = 0;
    for (let x0 = 0; x0 < 10; x0++)
      for (let x1 = x0 + 1; x1 <= 10; x1++)
        for (let y0 = 0; y0 < 7; y0++)
          for (let y1 = y0 + 1; y1 <= 7; y1++) {
            const r = box(x0, y0, x1 - x0, y1 - y0);
            if (empty(r, walls)) best = Math.max(best, area(r));
          }
    expect(area(biggest(emptyRects(w, walls)))).toBe(best);
  });

  it('is nothing where a panel fills the window', () => {
    expect(emptyRects(window, [box(0, 0, 100, 60)])).toEqual([]);
  });
});

describe('fitScale', () => {
  it('fits by whichever side binds, a margin in from every edge', () => {
    // 200 x 100 with 10 clear all round: 180 x 80 room.
    expect(fitScale(box(0, 0, 200, 100), 9, 4, 10)).toBeCloseTo(20); // 9 wide: 20/unit; 4 deep: 20/unit
    expect(fitScale(box(0, 0, 200, 100), 18, 4, 10)).toBeCloseTo(10); // width binds
    expect(fitScale(box(0, 0, 200, 100), 9, 8, 10)).toBeCloseTo(10); // depth binds
  });

  it('is never negative, however little room', () => {
    expect(fitScale(box(0, 0, 10, 10), 5, 5, 20)).toBe(0);
  });
});

describe('pickRect', () => {
  const tall = box(0, 0, 100, 400);
  const side = box(120, 0, 260, 300);
  const middle = box(60, 0, 280, 220);
  const scale = (r: Rect) => fitScale(r, 10, 10, 0);

  it('takes the one that holds the map biggest', () => {
    expect(pickRect([tall, side, middle], scale, 200, 24)).toBe(side);
    expect(pickRect([], scale, 200, 24)).toBeNull();
  });

  it('takes the widest where several hold the map alike (held by depth, a strip is as good as the whole)', () => {
    const narrow = box(0, 0, 100, 200);
    const wide = box(0, 0, 300, 200);
    expect(pickRect([narrow, wide], (r) => fitScale(r, 1, 10, 0), 150, 24)).toBe(wide);
    expect(pickRect([wide, narrow], (r) => fitScale(r, 1, 10, 0), 150, 24)).toBe(wide);
  });

  it('keeps to the middle of the window when that costs less than a third, if asked', () => {
    // (Side: 260/10 = 26 a unit; middle: 220/10 = 22, 85%: kept.)
    expect(pickRect([tall, side, middle], scale, 200, 24, 2 / 3)).toBe(middle);
    // (Not when it costs more: a middle only 1/2 the size.)
    const small = box(60, 0, 280, 120);
    expect(pickRect([tall, side, small], scale, 200, 24, 2 / 3)).toBe(side);
  });

  it('leaves the biggest alone when it is already across the middle', () => {
    expect(pickRect([middle, tall], scale, 200, 24, 2 / 3)).toBe(middle);
  });
});

describe('centring', () => {
  const scale = (r: Rect) => fitScale(r, 10, 10, 0);

  it('mirrors each rectangle across the line, to the narrower side', () => {
    expect(centredRects([box(0, 10, 300, 200), box(250, 0, 100, 50)], 200)).toEqual([{ x: 100, y: 10, w: 200, h: 200 }]);
  });

  it('centres the map where a corner panel only costs a little', () => {
    // A 400x300 window with a dock in the bottom right: the biggest part is the strip left of it (330 wide, off to the left), a centred map in it is 87% as big.
    const rects = emptyRects(box(0, 0, 400, 300), [box(330, 200, 70, 100)]);
    expect(pickRect(rects, scale, 200, 24)).toEqual(box(0, 0, 330, 300));
    expect(pickCentred(rects, scale, 200, 24, 0, 0.8)).toEqual(box(70, 0, 260, 300));
    // (Not when it must keep 90%.)
    expect(pickCentred(rects, scale, 200, 24, 0, 0.9)).toEqual(box(0, 0, 330, 300));
  });

  it('falls back to the best part when centring would cost too much', () => {
    // Everything but a strip on the left is taken: a centred map would have nothing.
    const rects = emptyRects(box(0, 0, 400, 300), [box(100, 0, 300, 300)]);
    expect(pickCentred(rects, scale, 200, 24, 0, 0.8)).toEqual(box(0, 0, 100, 300));
    expect(pickCentred([], scale, 200, 24, 0, 0.8)).toBeNull();
  });
});
