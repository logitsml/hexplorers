// Shared tools for the named maps: axial geometry, the sea round the land, number discs under
// constraints and harbours spread along a coast. Everything random draws from the builder's rng.

import { SIDE_DIRS, hexCenter } from '../board';
import type { Rng } from '../rng';
import type { PortType, Terrain } from '../types';
import { RESOURCES } from '../types';

export type QR = [number, number];

export const key = (q: number, r: number) => `${q},${r}`;

export const neighbor = ([q, r]: QR, side: number): QR => [q + SIDE_DIRS[side][0], r + SIDE_DIRS[side][1]];
export const neighbors = (h: QR): QR[] => SIDE_DIRS.map((_, i) => neighbor(h, i));

/** Hex distance between two axial coordinates. */
export const distance = ([q1, r1]: QR, [q2, r2]: QR) => (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(q1 + r1 - q2 - r2)) / 2;

/** Every hex within `radius` of the origin, row by row. */
export function hexagon(radius: number): QR[] {
  const out: QR[] = [];
  for (let r = -radius; r <= radius; r++) {
    for (let q = Math.max(-radius, -radius - r); q <= Math.min(radius, radius - r); q++) out.push([q, r]);
  }
  return out;
}

/** The hexes at exactly `radius` from the origin, walked once round in order. */
export function ring(radius: number): QR[] {
  const out: QR[] = [];
  let h: QR = [SIDE_DIRS[4][0] * radius, SIDE_DIRS[4][1] * radius];
  for (let side = 0; side < 6; side++) {
    for (let i = 0; i < radius; i++) {
      out.push(h);
      h = neighbor(h, side);
    }
  }
  return out;
}

/** Row by row, top to bottom: a stable order for hex ids. */
export const byRow = (a: QR, b: QR) => a[1] - b[1] || a[0] - b[0];

/** The sea: every hex next to land that isn't land itself, so every coast borders open water. */
export function seaAround(land: Iterable<QR>): QR[] {
  const taken = new Set<string>();
  const all: QR[] = [];
  for (const h of land) {
    all.push(h);
    taken.add(key(...h));
  }
  const sea = new Map<string, QR>();
  for (const h of all) {
    for (const n of neighbors(h)) {
      const k = key(...n);
      if (!taken.has(k)) sea.set(k, n);
    }
  }
  return [...sea.values()].sort(byRow);
}

const isRed = (n: number) => n === 6 || n === 8;

/**
 * Number discs onto hexes: no two 6s or 8s side by side, and none on the hexes in `noRed` (bounty
 * fields). Reds go first, each on a random hex clear of the others; the rest are shuffled on.
 */
export function placeNumbers(rng: Rng, hexes: QR[], discs: number[], noRed: Set<string> = new Set()): Map<string, number> {
  if (hexes.length !== discs.length) throw new Error(`${discs.length} number discs for ${hexes.length} hexes.`);
  const reds = discs.filter(isRed);
  const rest = discs.filter((n) => !isRed(n));
  for (let attempt = 0; attempt < 200; attempt++) {
    const order = rng.shuffle(hexes.slice());
    const red = new Set<string>();
    for (const h of order) {
      if (red.size === reds.length) break;
      const k = key(...h);
      if (noRed.has(k) || neighbors(h).some((n) => red.has(key(...n)))) continue;
      red.add(k);
    }
    if (red.size < reds.length) continue;
    const out = new Map<string, number>();
    const redDiscs = rng.shuffle(reds.slice());
    const restDiscs = rng.shuffle(rest.slice());
    for (const h of hexes) {
      const k = key(...h);
      out.set(k, red.has(k) ? redDiscs.pop()! : restDiscs.pop()!);
    }
    return out;
  }
  throw new Error('No layout keeps the red numbers apart.');
}

/** One harbour slot: the side of a land hex that faces the sea. */
export interface Slot {
  at: QR;
  side: number;
}

/** A slot's two corners, as world positions rounded to keys (shared corners compare equal). */
function slotCorners({ at, side }: Slot): string[] {
  const [x, z] = hexCenter(...at);
  return [side, (side + 1) % 6].map((c) => {
    const a = ((-90 + 60 * c) * Math.PI) / 180;
    return `${Math.round((x + Math.cos(a)) * 1000)},${Math.round((z + Math.sin(a)) * 1000)}`;
  });
}

/** Whether `slot` shares a corner with any of `taken`: harbours keep an edge between them. */
export function crowds(slot: Slot, taken: Slot[]): boolean {
  const mine = slotCorners(slot);
  return taken.some((t) => slotCorners(t).some((c) => mine.includes(c)));
}

/** Every side of `land` hexes that faces a hex in `sea`. */
export function coastSlots(land: QR[], sea: Set<string>): Slot[] {
  const out: Slot[] = [];
  for (const at of land) for (let side = 0; side < 6; side++) if (sea.has(key(...neighbor(at, side)))) out.push({ at, side });
  return out;
}

/**
 * `count` harbour slots spread evenly round a coast: aim at `count` bearings from a random start,
 * and take the free slot nearest each bearing that doesn't crowd one already taken.
 */
export function spreadSlots(rng: Rng, slots: Slot[], count: number, taken: Slot[] = []): Slot[] {
  if (slots.length === 0) return [];
  const centre = slots.reduce(([sx, sz], s) => {
    const [x, z] = hexCenter(...s.at);
    return [sx + x / slots.length, sz + z / slots.length];
  }, [0, 0]);
  const bearing = (s: Slot) => {
    const [x, z] = hexCenter(...s.at);
    const a = ((-60 + 60 * s.side) * Math.PI) / 180;
    return Math.atan2(z + Math.sin(a) - centre[1], x + Math.cos(a) - centre[0]);
  };
  const start = rng.next() * 2 * Math.PI;
  const chosen: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const aim = start + (2 * Math.PI * i) / count;
    const gap = (s: Slot) => {
      const d = Math.abs(bearing(s) - aim) % (2 * Math.PI);
      return Math.min(d, 2 * Math.PI - d);
    };
    const free = slots.filter((s) => !crowds(s, [...taken, ...chosen]));
    if (free.length === 0) break;
    chosen.push(free.reduce((best, s) => (gap(s) < gap(best) ? s : best)));
  }
  return chosen;
}

/** Harbour types: one 2:1 for each resource, the rest 3:1, shuffled. */
export function harbourTypes(rng: Rng, count: number): PortType[] {
  const types: PortType[] = [...RESOURCES];
  while (types.length < count) types.push('any');
  return rng.shuffle(types.slice(0, count));
}

/** A bag of terrain tiles from counts. */
export function tiles(counts: Partial<Record<Terrain, number>>): Terrain[] {
  const out: Terrain[] = [];
  for (const [t, n] of Object.entries(counts) as [Terrain, number][]) for (let i = 0; i < n; i++) out.push(t);
  return out;
}

/** A bag of number discs from counts. */
export function discs(counts: Record<number, number>): number[] {
  const out: number[] = [];
  for (const [n, c] of Object.entries(counts)) for (let i = 0; i < c; i++) out.push(Number(n));
  return out;
}
