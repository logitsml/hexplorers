// The map editor's edits, as pure functions on a CustomMap (so undo is a stack of maps), and the hex
// geometry the 2D board and the 3D draft both point with.

import { CORNER_OFFSETS, SIDE_DIRS, SQRT3, cellAt, hexCenter } from '../../engine/board';
import { isLand } from '../../engine/constants';
import { LAKE_NUMBERS, bagOf, MAX_HEXES, MAX_HOMES, MAX_REACH, MAX_RIVER_LEN, centreOf, dealMap, gridCells, hexDistance, normalize, numbered, rectangle, type CellTerrain, type CustomHex, type CustomMap, type CustomPortType } from '../../engine/maps/custom';
import { Rng } from '../../engine/rng';
import type { Terrain } from '../../engine';

export type Tool =
  | { kind: 'terrain'; terrain: CellTerrain }
  | { kind: 'erase' }
  /** A number to set; 'deal' takes a fixed one off, to be dealt at the start. */
  | { kind: 'number'; n: number | 'deal' }
  | { kind: 'port'; type: CustomPortType }
  | { kind: 'robber' }
  | { kind: 'corsair' }
  | { kind: 'home' }
  | { kind: 'well' }
  | { kind: 'fog' }
  | { kind: 'ground' }
  | { kind: 'river' };

/** Tools that paint across cells as the pointer drags; the rest act on a tap. */
export const isBrush = (t: Tool) => t.kind === 'terrain' || t.kind === 'erase' || t.kind === 'fog';

export const key = (q: number, r: number) => `${q},${r}`;

export const hexOf = (map: CustomMap, q: number, r: number) => map.hexes.find((h) => h.q === q && h.r === r);

const landish = (t: CellTerrain | undefined) => !!t && (t === 'random' || isLand(t as Terrain));
const fixedLand = (t: CellTerrain | undefined) => !!t && t !== 'random' && isLand(t as Terrain);

/** The cell under a point on the board (world x, z). */
export { cellAt };

/** The side of cell (q, r) a point is nearest (0-5: NE, E, SE, SW, W, NW). */
function sideAt(q: number, r: number, x: number, z: number): number {
  const [cx, cz] = hexCenter(q, r);
  let best = 0, bestDot = -Infinity;
  for (let s = 0; s < 6; s++) {
    const [nx, nz] = hexCenter(q + SIDE_DIRS[s][0], r + SIDE_DIRS[s][1]);
    const d = (x - cx) * (nx - cx) + (z - cz) * (nz - cz);
    if (d > bestDot) {
      bestDot = d;
      best = s;
    }
  }
  return best;
}

/** The two corners (world x, z) of a cell's side. */
export function sideCorners(q: number, r: number, side: number): [[number, number], [number, number]] {
  const [cx, cz] = hexCenter(q, r);
  // (Side s runs between corners s and s+1, clockwise from the top: see buildBoard.)
  const a = CORNER_OFFSETS[side], b = CORNER_OFFSETS[(side + 1) % 6];
  return [
    [cx + a[0], cz + a[1]],
    [cx + b[0], cz + b[1]],
  ];
}

const landAt = (map: CustomMap, q: number, r: number) => landish(hexOf(map, q, r)?.terrain);

/**
 * Whether side `side` of cell (q, r) can take a harbour: the cell is land and its neighbour isn't,
 * as the game reads them (a random cell is land, unless the bag may deal it as sea: then it may
 * hold no harbour, and may face one).
 */
export function coastal(map: CustomMap, q: number, r: number, side: number) {
  const seaInBag = (bagOf(map).sea ?? 0) > 0;
  const t = hexOf(map, q, r)?.terrain;
  if (!(fixedLand(t) || (t === 'random' && !seaInBag))) return false;
  const n = hexOf(map, q + SIDE_DIRS[side][0], r + SIDE_DIRS[side][1])?.terrain;
  return !landish(n) || (n === 'random' && seaInBag);
}

/** The land side a point on the board would put a harbour on: the cell it's in, else the land across the side it's nearest. */
export function harbourAt(map: CustomMap, x: number, z: number): { q: number; r: number; side: number } | null {
  const [q, r] = cellAt(x, z);
  const side = sideAt(q, r, x, z);
  if (coastal(map, q, r, side)) return { q, r, side };
  const nq = q + SIDE_DIRS[side][0], nr = r + SIDE_DIRS[side][1];
  const back = (side + 3) % 6;
  if (coastal(map, nq, nr, back)) return { q: nq, r: nr, side: back };
  return null;
}

// ---------------------------------------------------------------- symmetry and the brush

/** Cell (q, r) turned a sixth of a turn clockwise round the cell `pivot` (the map's centre, by default the origin) `n` times. */
export function turn(q: number, r: number, n: number, pivot: readonly [number, number] = [0, 0]): [number, number] {
  let a = q - pivot[0], b = r - pivot[1];
  for (let i = 0; i < ((n % 6) + 6) % 6; i++) [a, b] = [-b, a + b];
  return [a + pivot[0], b + pivot[1]];
}

/** The turns a symmetry repeats an edit at: 1 (none), 2 (halves), 3 (thirds) or 6 (sixths). */
export const turnsOf = (symmetry: 1 | 2 | 3 | 6) => Array.from({ length: symmetry }, (_, i) => (i * 6) / symmetry);

/** The cells a brush of `size` (1, or 7 for a hex and its ring) covers round (q, r). */
export const brushCells = (q: number, r: number, size: 1 | 7): [number, number][] => (size === 1 ? [[q, r]] : [[q, r], ...SIDE_DIRS.map(([dq, dr]) => [q + dq, r + dr] as [number, number])]);

/** A mark of what the tool would act on: a cell, or (`side`) a stretch of its coast; `ghost` for an image round the middle. */
export interface AimMark {
  q: number;
  r: number;
  side?: number;
  ghost: boolean;
}

/**
 * What the tool in hand would act on at a point on the board (world x, z), for either view to
 * mark: the cells (the brush's, and their images round the map's centre where the tool repeats
 * there) within the grid, or the stretches of coast for a harbour.
 */
export function aimAt(map: CustomMap, tool: Tool, x: number, z: number, brush: 1 | 7, symmetry: 1 | 2 | 3 | 6, pivot: readonly [number, number] = centreOf(map)): AimMark[] {
  const turns = turnsOf(symmetry);
  if (tool.kind === 'port') {
    const h = harbourAt(map, x, z);
    if (!h) return [];
    return turns.map((t) => {
      const [q, r] = turn(h.q, h.r, t, pivot);
      return { q, r, side: (h.side + t) % 6, ghost: t !== 0 };
    });
  }
  const [q, r] = cellAt(x, z);
  const base = isBrush(tool) ? brushCells(q, r, brush) : [[q, r] as [number, number]];
  const many = isBrush(tool) || tool.kind === 'number' || tool.kind === 'well';
  return (many ? turns : [0])
    .flatMap((t) =>
      base.map(([a, b]) => {
        const [c, d] = turn(a, b, t, pivot);
        return { q: c, r: d, ghost: t !== 0 };
      }),
    )
    .filter((m) => inGrid(map, m.q, m.r));
}

// ---------------------------------------------------------------- edits

/** What's tidied after a change: harbours left off the coast, pieces off their ground, features on what can't hold them. */
function tidy(map: CustomMap): CustomMap {
  const at = new Map(map.hexes.map((h) => [key(h.q, h.r), h]));
  const ports = map.ports.filter((p) => coastal(map, p.q, p.r, p.side));
  const out: CustomMap = { ...map, ports };
  const fixedAt = (qr?: [number, number]) => !!qr && fixedLand(at.get(key(...qr))?.terrain);
  if (!fixedAt(map.robber)) delete out.robber;
  if (map.corsair && at.get(key(...map.corsair))?.terrain !== 'sea') delete out.corsair;
  const home = (map.home ?? []).filter((h) => fixedAt(h));
  if (home.length) out.home = home;
  else delete out.home;
  // (A river keeps the stretch of it still on fixed land, from the spring.)
  const rivers = (map.rivers ?? [])
    .map((rv) => {
      const cut = rv.path.findIndex((h) => !fixedAt(h));
      return { path: cut < 0 ? rv.path : rv.path.slice(0, cut) };
    })
    .filter((rv) => rv.path.length > 0);
  if (rivers.length) out.rivers = rivers;
  else delete out.rivers;
  return out;
}

/** A cell as it is after painting `terrain` on it: numbers kept where they still mean something, wells on land, the fog kept. */
function painted(old: CustomHex | undefined, q: number, r: number, terrain: CellTerrain): CustomHex {
  const hex: CustomHex = { q, r, terrain };
  if (old?.number !== undefined && ((numbered(terrain) && numbered(old.terrain)) || (terrain === 'sea' && old.terrain === 'sea'))) hex.number = old.number;
  if (old?.well && landish(terrain) && terrain !== 'lake') hex.well = true;
  // (The fog stays, but not over a feature, which is seen from the start: see fogless.)
  if (old?.hidden && !fogless(hex)) hex.hidden = true;
  return hex;
}

/** The map with cells painted (or erased off the map, with `terrain` null). Cells outside its grid are left alone. */
export function paint(map: CustomMap, cells: [number, number][], terrain: CellTerrain | null): CustomMap {
  const byKey = new Map(map.hexes.map((h) => [key(h.q, h.r), h]));
  let changed = false;
  for (const [q, r] of cells) {
    if (!inGrid(map, q, r)) continue;
    const old = byKey.get(key(q, r));
    if (terrain === null) {
      if (old) (byKey.delete(key(q, r)), (changed = true));
      continue;
    }
    if (old?.terrain === terrain) continue;
    byKey.set(key(q, r), painted(old, q, r, terrain));
    changed = true;
  }
  return changed ? tidy({ ...map, hexes: [...byKey.values()] }) : map;
}

/** The map with a flag (the fog, or a well) toggled on the cells: set on all when the first lacks it, else taken off all; null for a well pressed where none can stand. */
export function toggleFlag(map: CustomMap, cells: [number, number][], flag: 'hidden' | 'well', on?: boolean): CustomMap | null {
  const set = new Set(cells.map(([q, r]) => key(q, r)));
  const first = hexOf(map, ...cells[0]);
  const want = on ?? !first?.[flag];
  let changed = false;
  const hexes = map.hexes.map((h) => {
    if (!set.has(key(h.q, h.r))) return h;
    if (flag === 'well' && (!fixedLand(h.terrain) || h.terrain === 'lake')) return h;
    if (!!h[flag] === want) return h;
    changed = true;
    const out = { ...h };
    if (want) out[flag] = true;
    else delete out[flag];
    return out;
  });
  if (!changed && flag === 'well' && first && (!fixedLand(first.terrain) || first.terrain === 'lake')) return null;
  return changed ? { ...map, hexes } : map;
}

/** Whether the fog may not hide a cell: an expansion's feature, which must be seen from the start (the check's rule). */
export const fogless = (h: CustomHex) => h.terrain === 'lake' || h.terrain === 'castle' || h.terrain === 'oasis' || h.terrain === 'swamp' || !!h.well;

/**
 * The map with the fog laid on the cells (`on`) or lifted off them. Fog laid on a cell of the grid
 * the map doesn't list yet brings it onto the map as open sea under the fog (cells off the grid
 * are left alone).
 */
export function setFog(map: CustomMap, cells: [number, number][], on: boolean): CustomMap {
  const want = new Set(cells.filter(([q, r]) => inGrid(map, q, r)).map(([q, r]) => key(q, r)));
  let changed = false;
  const hexes = map.hexes.map((h): CustomHex => {
    const k = key(h.q, h.r);
    if (!want.has(k)) return h;
    want.delete(k);
    if (!!h.hidden === on || (on && fogless(h))) return h;
    changed = true;
    if (on) return { ...h, hidden: true };
    const { hidden: _h, ...out } = h;
    return out;
  });
  if (on)
    for (const k of want) {
      const [q, r] = k.split(',').map(Number);
      hexes.push({ q, r, terrain: 'sea', hidden: true });
      changed = true;
    }
  return changed ? { ...map, hexes } : map;
}

/** The map with `n` on cell (q, r) (taken off again if it already bears it), 'deal' taking a fixed number off; null when the cell takes no number. */
export function setNumber(map: CustomMap, q: number, r: number, n: number | 'deal'): CustomMap | null {
  const old = hexOf(map, q, r);
  if (!old || !numbered(old.terrain)) return null;
  const hex: CustomHex = { ...old };
  if (n === 'deal' || old.number === n) delete hex.number;
  else hex.number = n;
  // (Dealt on a hex already without a number: it's left to the deal, which is turned on.)
  if (hex.number === old.number) return n === 'deal' && !map.deal ? { ...map, deal: true } : map;
  // (Leaving a number to the deal turns the deal on.)
  return { ...map, hexes: map.hexes.map((h) => (h === old ? hex : h)), ...(n === 'deal' && { deal: true }) };
}

/** The fishing grounds' numbers (Fisheries: one each). */
export const GROUND_NUMBERS = [4, 5, 6, 8, 9, 10];

/** The map with a fishing ground on sea cell (q, r) bearing the first of its numbers not yet out (or taken off again); null off the sea or out of reach of land. */
export function setGround(map: CustomMap, q: number, r: number): CustomMap | null {
  const old = hexOf(map, q, r);
  if (!old || old.terrain !== 'sea') return null;
  if (old.number !== undefined) return { ...map, hexes: map.hexes.map((h) => (h === old ? { q, r, terrain: 'sea', ...(h.hidden && { hidden: true as const }) } : h)) };
  if (!SIDE_DIRS.some(([dq, dr]) => landAt(map, q + dq, r + dr))) return null;
  const used = new Set(map.hexes.filter((h) => h.terrain === 'sea' && h.number !== undefined).map((h) => h.number));
  const n = GROUND_NUMBERS.find((x) => !used.has(x)) ?? GROUND_NUMBERS[used.size % GROUND_NUMBERS.length];
  return { ...map, hexes: map.hexes.map((h) => (h === old ? { ...h, number: n } : h)) };
}

/** The map with a harbour of `type` on the side (another type replaces one there; the same type takes it off). */
export function setHarbour(map: CustomMap, at: { q: number; r: number; side: number }, type: CustomPortType): CustomMap {
  const old = map.ports.find((p) => p.q === at.q && p.r === at.r && p.side === at.side);
  const others = map.ports.filter((p) => p !== old);
  if (old?.type === type) return { ...map, ports: others };
  return { ...map, ports: [...others, { ...at, type }] };
}

/** The map with a piece (the robber, the corsair) starting on cell (q, r), or taken off it, clicked again; null on the wrong ground. */
export function setPiece(map: CustomMap, piece: 'robber' | 'corsair', q: number, r: number): CustomMap | null {
  const h = hexOf(map, q, r);
  if (piece === 'robber' ? !fixedLand(h?.terrain) : h?.terrain !== 'sea') return null;
  const now = map[piece];
  const out = { ...map };
  if (now && now[0] === q && now[1] === r) delete out[piece];
  else out[piece] = [q, r];
  return out;
}

/** The map with cell (q, r)'s island marked home (or not, clicked again); null off fixed land. */
export function toggleHome(map: CustomMap, q: number, r: number): CustomMap | null {
  if (!fixedLand(hexOf(map, q, r)?.terrain)) return null;
  const island = islandOf(map, q, r);
  const home = map.home ?? [];
  const marked = home.findIndex(([a, b]) => island.has(key(a, b)));
  if (marked < 0 && home.length >= MAX_HOMES) return null;
  const next = marked >= 0 ? home.filter((_, i) => i !== marked) : [...home, [q, r] as [number, number]];
  const out = { ...map };
  if (next.length) out.home = next;
  else delete out.home;
  return out;
}

/** Whether marking (q, r)'s island home is refused for the limit alone (a map holds at most MAX_HOMES). */
export function homesFull(map: CustomMap, q: number, r: number): boolean {
  if (!fixedLand(hexOf(map, q, r)?.terrain)) return false;
  const island = islandOf(map, q, r);
  const home = map.home ?? [];
  return home.length >= MAX_HOMES && !home.some(([a, b]) => island.has(key(a, b)));
}

/** The cells of the landmass round (q, r): land joined side to side (random cells counting as land). */
export function islandOf(map: CustomMap, q: number, r: number): Set<string> {
  const out = new Set<string>();
  if (!landAt(map, q, r)) return out;
  const stack: [number, number][] = [[q, r]];
  out.add(key(q, r));
  while (stack.length) {
    const [a, b] = stack.pop()!;
    for (const [dq, dr] of SIDE_DIRS) {
      const k = key(a + dq, b + dr);
      if (out.has(k) || !landAt(map, a + dq, b + dr)) continue;
      out.add(k);
      stack.push([a + dq, b + dr]);
    }
  }
  return out;
}

/**
 * The river tool at cell (q, r), with river `drawing` under way (or null): a cell beside its end
 * carries it on; a cell on a river cuts it back to there; anywhere else on fixed land starts a new
 * one (a third replaces the oldest). Returns the map and the river now being drawn.
 */
export function riverAt(map: CustomMap, q: number, r: number, drawing: number | null): { map: CustomMap; drawing: number | null; refused?: string; note?: string } | null {
  if (!fixedLand(hexOf(map, q, r)?.terrain)) return null;
  const rivers = (map.rivers ?? []).map((rv) => ({ path: [...rv.path] }));
  const on = rivers.findIndex((rv) => rv.path.some(([a, b]) => a === q && b === r));
  if (on >= 0) {
    const i = rivers[on].path.findIndex(([a, b]) => a === q && b === r);
    // (The end tapped again finishes it; elsewhere along it, cut back to there.)
    if (i === rivers[on].path.length - 1 && drawing === on) return { map, drawing: null };
    // (Its end, tapped to carry it on: nothing changes but the river being drawn.)
    if (i === rivers[on].path.length - 1) return { map, drawing: on };
    rivers[on].path = rivers[on].path.slice(0, i + 1);
    return { map: { ...map, rivers }, drawing: on };
  }
  const cur = drawing !== null ? rivers[drawing] : null;
  const end = cur?.path[cur.path.length - 1];
  if (cur && end && hexDistance(q - end[0], r - end[1]) === 1) {
    if (cur.path.length >= MAX_RIVER_LEN) return { map, drawing, refused: `A river runs through ${MAX_RIVER_LEN} hexes at most` };
    cur.path.push([q, r]);
    return { map: { ...map, rivers }, drawing };
  }
  // (The Rivers expansion runs two: a third takes the place of the first, and says so.)
  const replaced = rivers.length >= 2;
  if (replaced) rivers.shift();
  rivers.push({ path: [[q, r]] });
  return { map: { ...map, rivers }, drawing: rivers.length - 1, ...(replaced && { note: 'A map has two rivers: the first was taken up for this one' }) };
}

// ---------------------------------------------------------------- the grid

/** A map's grid, worked out once for as long as the map is the one in hand (an edit makes another). */
interface Grid {
  cells: [number, number][];
  has: Set<string>;
  /** The world box (x, z) of the grid's cells, corners and all. */
  box: { x0: number; x1: number; z0: number; z1: number };
}
const grids = new WeakMap<CustomMap, Grid>();

/**
 * The grid of `map`: the cells that can be painted, which are the cells it lists and two rings of
 * cells round them (never past 16 from the middle). Painting at its edge adds cells to the map, and
 * with them the next ring of the grid.
 */
export function gridOf(map: CustomMap): Grid {
  let g = grids.get(map);
  if (!g) {
    const cells = gridCells(map, 2);
    const box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const [q, r] of cells) {
      const [x, z] = hexCenter(q, r);
      box.x0 = Math.min(box.x0, x - SQRT3 / 2);
      box.x1 = Math.max(box.x1, x + SQRT3 / 2);
      box.z0 = Math.min(box.z0, z - 1);
      box.z1 = Math.max(box.z1, z + 1);
    }
    g = { cells, has: new Set(cells.map(([q, r]) => key(q, r))), box };
    grids.set(map, g);
  }
  return g;
}

/** Whether cell (q, r) is on the map's grid: the one test every paint, mark and fit uses. */
export const inGrid = (map: CustomMap, q: number, r: number) => gridOf(map).has.has(key(q, r));

/** The cells of the grid that lie on its edge (a neighbour off the grid): its outline. */
export function gridEdge(map: CustomMap): [number, number][] {
  const g = gridOf(map);
  return g.cells.filter(([q, r]) => SIDE_DIRS.some(([dq, dr]) => !g.has.has(key(q + dq, r + dr))));
}

/** How many rings of hexagon the grid is about, for the 3D camera's distance and reach (a hexagonal grid's own radius). */
export function gridRings(map: CustomMap): number {
  const { box } = gridOf(map);
  return Math.max(0, ((box.x1 - box.x0) / SQRT3 - 1) / 2, (box.z1 - box.z0 - 2) / 3);
}

/** A box's four numbers as one string, to tell whether the grid's bounds changed. */
export function boxKey(map: CustomMap): string {
  const { x0, x1, z0, z1 } = gridOf(map).box;
  return `${x0.toFixed(3)},${x1.toFixed(3)},${z0.toFixed(3)},${z1.toFixed(3)}`;
}

/** How many hexes wide and high the map's cells are, in rows that stagger (the size the canvas steppers show). */
export function canvasSize(map: CustomMap): { cols: number; rows: number } {
  if (map.hexes.length === 0) return { cols: 0, rows: 0 };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const h of map.hexes) {
    const [x, z] = hexCenter(h.q, h.r);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return { cols: Math.floor((x1 - x0) / SQRT3 + 1e-6) + 1, rows: Math.round((z1 - z0) / 1.5) + 1 };
}

/** Plain open water: a sea cell with nothing on it (no fishing ground, no fog, no corsair), which can be taken off without a loss. */
const plainSea = (map: CustomMap, h: CustomHex) => h.terrain === 'sea' && h.number === undefined && !h.hidden && !(map.corsair && map.corsair[0] === h.q && map.corsair[1] === h.r);

/**
 * The map laid out on a canvas of `cols` × `rows` hexes round its middle: every cell of the
 * canvas the map doesn't list becomes open sea, and open water beyond it is taken off. Null when
 * land (or a fishing ground, the fog or the corsair) lies beyond it.
 */
export function resize(map: CustomMap, cols: number, rows: number): CustomMap | null {
  const shape = rectangle(Math.max(1, cols), Math.max(1, rows)).map(([q, r]) => ({ q, r }));
  const [mq, mr] = centreOf(map);
  const [sq, sr] = centreOf({ hexes: shape });
  const canvas = new Set(shape.map((h) => key(h.q + mq - sq, h.r + mr - sr)));
  if (map.hexes.some((h) => !canvas.has(key(h.q, h.r)) && !plainSea(map, h))) return null;
  const have = new Set(map.hexes.map((h) => key(h.q, h.r)));
  const kept = map.hexes.filter((h) => canvas.has(key(h.q, h.r)));
  const added = [...canvas].filter((k) => !have.has(k)).map((k) => {
    const [q, r] = k.split(',').map(Number);
    return { q, r, terrain: 'sea' as const };
  });
  if (added.length === 0 && kept.length === map.hexes.length) return map;
  const hexes = [...kept, ...added];
  // (A map holds so many cells, none past its reach: a canvas wider than that is refused.)
  if (hexes.length > MAX_HEXES || hexes.some((h) => hexDistance(h.q, h.r) > MAX_REACH)) return null;
  return tidy({ ...map, hexes });
}

/**
 * The map cropped to its content: open water more than a ring away from anything else is taken
 * off (the sea round the land, and between the islands, stays), and the rest recentred on the
 * middle of what is left, as it is saved.
 */
export function crop(map: CustomMap): CustomMap {
  const solid = map.hexes.filter((h) => !plainSea(map, h));
  if (solid.length === 0) return map;
  const near = new Set<string>();
  for (const h of solid) {
    near.add(key(h.q, h.r));
    for (const [dq, dr] of SIDE_DIRS) near.add(key(h.q + dq, h.r + dr));
  }
  // (Sea hexes that touch only sea stay when they lie between the islands: inside their hull.)
  const hull = hullOf(solid.map((h) => hexCenter(h.q, h.r)));
  const keep = (h: CustomHex) => !plainSea(map, h) || near.has(key(h.q, h.r)) || inHull(hull, hexCenter(h.q, h.r));
  const hexes = map.hexes.filter(keep);
  // (A map with nothing to take off, already centred, is returned as it is: no step to undo.)
  return normalize(hexes.length === map.hexes.length ? map : tidy({ ...map, hexes }));
}

/** The convex hull of points (x, z), counter-clockwise (Andrew's monotone chain). */
function hullOf(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: [number, number][]) => {
    const out: [number, number][] = [];
    for (const pt of pts) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], pt) <= 1e-9) out.pop();
      out.push(pt);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half(p.reverse())];
}

/** Whether a point lies in (or on the edge of) a convex hull from hullOf. */
function inHull(hull: [number, number][], [x, z]: [number, number]): boolean {
  if (hull.length < 3) return hull.some(([a, b]) => Math.abs(a - x) < 1e-6 && Math.abs(b - z) < 1e-6);
  return hull.every((a, i) => {
    const b = hull[(i + 1) % hull.length];
    return (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) >= -1e-6;
  });
}

/**
 * The map with open sea laid in the gaps of nothing between its islands: every unlisted cell
 * inside the outline (the convex hull) of the cells it lists, however far apart the islands lie.
 * Cells beyond the outline stay as they are, so the sea round the whole map isn't added to.
 */
export function fillGaps(map: CustomMap): CustomMap {
  if (map.hexes.length === 0) return map;
  const have = new Set(map.hexes.map((h) => key(h.q, h.r)));
  const hull = hullOf(map.hexes.map((h) => hexCenter(h.q, h.r)));
  const added: CustomHex[] = [];
  // (Every cell in the hull has its q and r within the cells' own: a line of them is the hull's extreme.)
  const qs = map.hexes.map((h) => h.q), rs = map.hexes.map((h) => h.r);
  for (let r = Math.min(...rs); r <= Math.max(...rs); r++)
    for (let q = Math.min(...qs); q <= Math.max(...qs); q++) if (!have.has(key(q, r)) && inHull(hull, hexCenter(q, r))) added.push({ q, r, terrain: 'sea' });
  return added.length ? { ...map, hexes: [...map.hexes, ...added] } : map;
}

/** Where the robber stands: its own start, else the first desert (of the map, or of a previewed deal's `cells`). */
export function robberCell(map: CustomMap, cells: readonly { q: number; r: number; terrain: CellTerrain }[] = map.hexes): [number, number] | null {
  if (map.robber) return map.robber;
  const d = cells.find((h) => h.terrain === 'desert');
  return d ? [d.q, d.r] : null;
}

// ---------------------------------------------------------------- what the boards draw

/** A cell as the boards draw it: the template's own, or (previewing a deal) as one game would deal it. */
export interface Shown {
  q: number;
  r: number;
  terrain: CellTerrain;
  /** Its discs: a lake's four, a fixed number, or a fishing ground's. */
  numbers: number[];
  /** A number the deal will give it (a '?' disc). */
  owed: boolean;
  well: boolean;
  hidden: boolean;
}

/** The cells to draw: the map as drawn, or dealt with `seed` for a preview. */
export function shownCells(map: CustomMap, seed: number | null): Shown[] {
  if (seed !== null) {
    const dealt = dealMap(map, new Rng(seed));
    return dealt.hexes.map((h) => ({ q: h.q, r: h.r, terrain: h.terrain, numbers: h.numbers, owed: false, well: !!h.well, hidden: !!h.hidden }));
  }
  return map.hexes.map((h) => ({
    q: h.q,
    r: h.r,
    terrain: h.terrain,
    numbers: h.terrain === 'lake' ? [...LAKE_NUMBERS] : h.number !== undefined ? [h.number] : [],
    owed: h.number === undefined && (h.terrain === 'random' || (!!map.deal && numbered(h.terrain))),
    well: !!h.well,
    hidden: !!h.hidden,
  }));
}

/** The harbours to draw, dealt for a preview. */
export function shownPorts(map: CustomMap, seed: number | null): { q: number; r: number; side: number; type: CustomPortType }[] {
  return seed !== null ? dealMap(map, new Rng(seed)).ports : map.ports;
}
