// The maths of laying a map out between the HUD's panels (see mapFit.ts): the empty rectangles
// a window's panels leave, which of them the map takes, and how big the map comes out in one.
// Pure, so it is tested on its own (tests/freeRect.test.ts).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const right = (r: Rect) => r.x + r.w;
export const bottom = (r: Rect) => r.y + r.h;
export const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);

/** A rectangle grown by `by` on every side (shrunk, where negative: never to less than nothing). */
export function inflate(r: Rect, by: number): Rect {
  const w = Math.max(0, r.w + 2 * by), h = Math.max(0, r.h + 2 * by);
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** The smallest rectangle holding both. */
export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y };
}

/** What both hold (a rectangle of no size, where they don't meet). */
export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(right(a), right(b)) - x), h: Math.max(0, Math.min(bottom(a), bottom(b)) - y) };
}

/**
 * The empty rectangles inside `within` that none of `blocked` enters: for each pair of vertical
 * lines (through the panels' edges and the window's), the gaps between the panels that cross the
 * strip they bound, each as tall as its gap. Those hold every maximal empty rectangle (one that
 * can grow no way), and a few that could still widen, which is harmless for choosing the biggest.
 * (About fifty edges at the most, a thousand strips, none of them costly.)
 */
export function emptyRects(within: Rect, blocked: readonly Rect[]): Rect[] {
  const box = within;
  const walls = blocked.map((b) => intersect(b, box)).filter((b) => b.w > 0 && b.h > 0);
  const xs = [...new Set([box.x, right(box), ...walls.flatMap((b) => [b.x, right(b)])])].sort((a, b) => a - b);
  const found: Rect[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const x0 = xs[i], x1 = xs[j];
      // The panels across this strip, from the top down, and the gaps between them.
      const across = walls.filter((b) => b.x < x1 && right(b) > x0).sort((a, b) => a.y - b.y);
      let y = box.y;
      for (const b of across) {
        if (b.y > y) found.push({ x: x0, y, w: x1 - x0, h: b.y - y });
        y = Math.max(y, bottom(b));
      }
      if (bottom(box) > y) found.push({ x: x0, y, w: x1 - x0, h: bottom(box) - y });
    }
  }
  return found;
}

/**
 * How many pixels to a world unit the board takes in `r`, with `pad` px kept clear of its edges all
 * round (the harbours' badges and the pieces, which don't shrink with the map): the box's width
 * and depth in world units against what's left of the rectangle, by whichever binds first.
 */
export function fitScale(r: Rect, boxW: number, boxH: number, pad: number): number {
  return Math.max(0, Math.min((r.w - 2 * pad) / Math.max(1e-6, boxW), (r.h - 2 * pad) / Math.max(1e-6, boxH)));
}

/**
 * Of `candidates`, the one that holds the map biggest (`scale` of each). Where several hold it
 * alike (a map held by the depth of a window takes the same size in every strip as wide as it,
 * and the widest has the most room round it), the largest of those, then the one nearest
 * `centreX`.
 */
function biggest(candidates: readonly Rect[], scale: (r: Rect) => number, centreX: number): { rect: Rect; scale: number } | null {
  let best: Rect | null = null, bestScale = 0;
  for (const r of candidates) {
    const s = scale(r);
    const tie = best !== null && Math.abs(s - bestScale) <= 1e-6 * Math.max(1, bestScale);
    const closer = best !== null && Math.abs(r.x + r.w / 2 - centreX) < Math.abs(best.x + best.w / 2 - centreX);
    if (s > bestScale && !tie) (best = r), (bestScale = s);
    else if (tie && best && (area(r) > area(best) || (area(r) === area(best) && closer))) best = r;
  }
  return best && bestScale > 0 ? { rect: best, scale: bestScale } : null;
}

/**
 * The rectangle the map takes: the one that holds it biggest (`scale` of each). On a phone, when
 * that one is off to the side, the map stays across the middle of the window instead, as long as
 * it keeps `mid` of that size (a fraction; 0 to take the biggest always): a landscape phone's
 * biggest part is beside the dock, but the island jumping across the screen between 3D and
 * the map isn't worth a little more of it.
 */
export function pickRect(candidates: readonly Rect[], scale: (r: Rect) => number, centreX: number, tolerance: number, mid = 0): Rect | null {
  const best = biggest(candidates, scale, centreX);
  if (!best || mid <= 0 || Math.abs(best.rect.x + best.rect.w / 2 - centreX) <= tolerance) return best?.rect ?? null;
  const middle = biggest(candidates.filter((r) => Math.abs(r.x + r.w / 2 - centreX) <= tolerance), scale, centreX);
  return middle && middle.scale >= mid * best.scale ? middle.rect : best.rect;
}

/**
 * Of `candidates` that stand across the line `x = centreX`, the part of each that is symmetric
 * about it (as wide on one side as it is on the other, the narrower side's worth), so a map in
 * one is centred on the window.
 */
export function centredRects(candidates: readonly Rect[], centreX: number): Rect[] {
  const out: Rect[] = [];
  for (const r of candidates) {
    const half = Math.min(centreX - r.x, right(r) - centreX);
    if (half > 0) out.push({ x: centreX - half, y: r.y, w: 2 * half, h: r.h });
  }
  return out;
}

/**
 * The rectangle the map takes, centred on `centreX` where that can be had: the biggest symmetric
 * part of any candidate, as long as the map in it is at least `keep` of the size in the best
 * rectangle anywhere (a fraction); otherwise the best, off-centre or not, by `pickRect`
 * (`tolerance` and `mid` as there). A panel in a corner then shrinks the map evenly rather than
 * pushing it aside.
 */
export function pickCentred(candidates: readonly Rect[], scale: (r: Rect) => number, centreX: number, tolerance: number, mid: number, keep: number): Rect | null {
  const best = biggest(candidates, scale, centreX);
  if (!best) return null;
  const centred = biggest(centredRects(candidates, centreX), scale, centreX);
  if (centred && centred.scale >= keep * best.scale) return centred.rect;
  return pickRect(candidates, scale, centreX, tolerance, mid);
}
