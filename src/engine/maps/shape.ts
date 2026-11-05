// Shaping a map's home island for the expansions. Rule 10 puts the lake, the rivers, the oasis, the
// castle and the wells on the home island, so each module's shaper finds that island in a board
// spec, leaves alone the hexes another module's feature already holds, and moves numbers by rule 5.
// The tools here are shared by those shapers and work on any spec: the classic island (one
// landmass, no sea hexes) as well as a sea map's home among its islets. Everything random draws
// from the game's rng, in a fixed order.

import { SIDE_DIRS, hexCenter, type BoardSpec, type HexSpec } from '../board';
import { PIPS, isLand } from '../constants';
import type { Rng } from '../rng';
import type { Terrain } from '../types';

/** The plain resource terrain: what a feature hex may displace. */
export const PLAIN: readonly Terrain[] = ['hills', 'forest', 'pasture', 'fields', 'mountains'];

/** Terrain that carries a number disc (feature hexes and the desert carry none; the lake keeps its own). */
export const takesNumber = (t: Terrain) => PLAIN.includes(t) || t === 'bounty';

export const isRed = (n: number) => n === 6 || n === 8;
export const hasRed = (h: HexSpec) => h.numbers.some(isRed);
export const pipsOf = (h: HexSpec) => h.numbers.reduce((n, x) => n + (PIPS[x] ?? 0), 0);

const key = (q: number, r: number) => `${q},${r}`;

/**
 * A coordinate as a map key: one number for the small whole numbers every spec uses (the shapers
 * look hexes up by coordinate constantly, and building a string for each look was most of their
 * time), and the string otherwise. Either way two coordinates share a key exactly when they're equal.
 */
export const cellKey = (q: number, r: number): number | string =>
  Number.isInteger(q) && Number.isInteger(r) && Math.abs(q) < 32768 && Math.abs(r) < 32768 ? (q + 32768) * 65536 + (r + 32768) : key(q, r);

/** A spec's hexes by coordinate. */
export function hexAtIn(spec: BoardSpec): (q: number, r: number) => HexSpec | undefined {
  const at = new Map(spec.hexes.map((h) => [cellKey(h.q, h.r), h]));
  return (q, r) => at.get(cellKey(q, r));
}

/**
 * Each hex's neighbours within the spec (as it holds hexes now: a hex's place never changes, so
 * each one's list is worked out once and shared, and callers only read it).
 */
export function neighboursIn(spec: BoardSpec): (h: HexSpec) => readonly HexSpec[] {
  const at = hexAtIn(spec);
  const known = new Map<HexSpec, HexSpec[]>();
  return (h) => {
    let out = known.get(h);
    if (!out) {
      out = [];
      for (const [dq, dr] of SIDE_DIRS) {
        const n = at(h.q + dq, h.r + dr);
        if (n) out.push(n);
      }
      known.set(h, out);
    }
    return out;
  };
}

/** Whether two hexes share a side. */
export const touching = (a: HexSpec, b: HexSpec) => SIDE_DIRS.some(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r);

/** Hex distance between two hexes. */
export const hexDistance = (a: HexSpec, b: HexSpec) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;

/** The hexes a map keeps for its objective (Fog's face-down stack): no feature goes there, whatever they hide. */
export function hiddenKeys(spec: BoardSpec): Set<string> {
  return new Set((spec.objectives ?? []).flatMap((o) => o.hexes ?? []).map(([q, r]) => key(q, r)));
}

/**
 * The home islands' land, each island in spec order: the landmass round each hex `spec.home` names,
 * or the largest landmass when it names none (as buildBoard decides). Every map the game deals has
 * one home island; a player's own map may start on several. A map's face-down hexes are never part
 * of one.
 */
export function homeIslands(spec: BoardSpec): HexSpec[][] {
  const hidden = hiddenKeys(spec);
  const at = hexAtIn(spec);
  const near = neighboursIn(spec);
  const order = new Map(spec.hexes.map((h, i) => [h, i]));
  const onLand = (h: HexSpec) => isLand(h.terrain) && !hidden.has(key(h.q, h.r));
  const islandOf = (start: HexSpec): HexSpec[] => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length > 0) {
      for (const n of near(stack.pop()!)) {
        if (onLand(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return [...seen].sort((a, b) => order.get(a)! - order.get(b)!);
  };
  const named = spec.home === undefined ? [] : typeof spec.home[0] === 'number' ? [spec.home as [number, number]] : (spec.home as [number, number][]);
  if (named.length > 0) {
    return named.map(([q, r]) => {
      const h = at(q, r);
      if (!h || !onLand(h)) throw new Error(`The home hex ${q},${r} is not land.`);
      return islandOf(h);
    });
  }
  // (Islands in the order buildBoard numbers them, land first: the first of the largest wins a tie.)
  const land = spec.hexes.filter(onLand);
  const claimed = new Set<HexSpec>();
  let best: HexSpec[] = [];
  for (const h of land) {
    if (claimed.has(h)) continue;
    const island = islandOf(h);
    for (const x of island) claimed.add(x);
    if (island.length > best.length) best = island;
  }
  return best.length > 0 ? [best] : [];
}

/** Every home hex, in spec order. */
export function homeLand(spec: BoardSpec): HexSpec[] {
  const order = new Map(spec.hexes.map((h, i) => [h, i]));
  return homeIslands(spec)
    .flat()
    .sort((a, b) => order.get(a)! - order.get(b)!);
}

/**
 * The home island's castle corner: of its hexes with the most sides to the sea, the one lying
 * furthest to the lower left. Invasion builds its castle there, and the islets keep away from it
 * (docs/maps.md, The home island).
 */
export function castleCorner(home: readonly HexSpec[]): HexSpec | undefined {
  if (home.length === 0) return undefined;
  const mine = new Set(home.map((h) => cellKey(h.q, h.r)));
  const open = (h: HexSpec) => SIDE_DIRS.filter(([dq, dr]) => !mine.has(cellKey(h.q + dq, h.r + dr))).length;
  const [cx, cz] = home.reduce(([x, z], h) => {
    const [hx, hz] = hexCenter(h.q, h.r);
    return [x + hx / home.length, z + hz / home.length];
  }, [0, 0]);
  const [sx, sz] = hexCenter(...SIDE_DIRS[3]);
  const lowerLeft = (h: HexSpec) => {
    const [x, z] = hexCenter(h.q, h.r);
    return Math.round(((x - cx) * sx + (z - cz) * sz) * 1e6);
  };
  return home.reduce((best, h) => (open(h) > open(best) || (open(h) === open(best) && lowerLeft(h) > lowerLeft(best)) ? h : best));
}

/**
 * Hexes that already hold a feature (a river, the castle, the oasis, the lake, a well), and the
 * hexes the map keeps for its objective. No other feature takes them.
 */
export function featureHexes(spec: BoardSpec): Set<HexSpec> {
  const at = hexAtIn(spec);
  const out = new Set<HexSpec>();
  const add = (q: number, r: number) => {
    const h = at(q, r);
    if (h) out.add(h);
  };
  for (const river of spec.rivers ?? []) for (const [q, r] of river.path) add(q, r);
  if (spec.castle) add(...spec.castle);
  if (spec.oasis) add(...spec.oasis.at);
  const hidden = hiddenKeys(spec);
  for (const h of spec.hexes) {
    if (h.terrain === 'lake' || h.terrain === 'castle' || h.terrain === 'oasis' || h.terrain === 'swamp' || h.well || hidden.has(key(h.q, h.r))) out.add(h);
  }
  return out;
}

/** Whether a hex of `island` is on its coast: one of its sides faces anything but the island's own land. */
export function coastOf(spec: BoardSpec, island: readonly HexSpec[]): (h: HexSpec) => boolean {
  const mine = new Set(island);
  const near = neighboursIn(spec);
  return (h) => near(h).length < 6 || near(h).some((n) => !mine.has(n));
}

/**
 * Whether the home coast has to keep a different number on every hex: Invasion's raiders land by
 * number on the coast, so once the castle is placed, numbers that move go inland.
 */
function coastHeld(spec: BoardSpec): ((h: HexSpec) => boolean) | null {
  if (!spec.castle) return null;
  const coast = coastOf(spec, homeLand(spec));
  // (The lake is water: raiders never land on it, so its numbers aren't the coast's.)
  return (h) => h.terrain !== 'lake' && coast(h);
}

/** The home hex nearest the island's middle (the first in spec order on a tie), among those `allowed`. */
export function centralHex(home: readonly HexSpec[], allowed: (h: HexSpec) => boolean = () => true): HexSpec | undefined {
  if (home.length === 0) return undefined;
  const [cx, cz] = home.reduce(([x, z], h) => {
    const [hx, hz] = hexCenter(h.q, h.r);
    return [x + hx / home.length, z + hz / home.length];
  }, [0, 0]);
  const far = (h: HexSpec) => {
    const [x, z] = hexCenter(h.q, h.r);
    return Math.round(((x - cx) ** 2 + (z - cz) ** 2) * 1e6);
  };
  return home.filter(allowed).reduce<HexSpec | undefined>((best, h) => (best === undefined || far(h) < far(best) ? h : best), undefined);
}

/** Two tiles change places, each taking its terrain, numbers and well with it (the hexes themselves stay put). */
export function swapTiles(a: HexSpec, b: HexSpec) {
  [a.terrain, b.terrain] = [b.terrain, a.terrain];
  [a.numbers, b.numbers] = [b.numbers, a.numbers];
  const [wa, wb] = [a.well, b.well];
  delete a.well;
  delete b.well;
  if (wb) a.well = true;
  if (wa) b.well = true;
}

/**
 * Rule 5: numbers a feature hex displaced move onto other hexes, which then produce on either. The
 * least likely move first, each onto the least productive pasture or fields of the home island that
 * already has a number, never making two reds touch (any other numbered hex if no pasture or fields
 * will do), and never onto a hex in `avoid` or the lake, whose numbers are its own. A hex never
 * takes a number it already bears, and the numbers spread: a hex already bearing two is passed
 * over while one bearing a single number can take it. Under Invasion the coast keeps a different
 * number on every hex while the island has room inland: only when every inland hex already bears
 * two does a coastal hex take a number the coast has. And a number the coast lacks goes onto it.
 */
export function rehome(spec: BoardSpec, numbers: readonly number[], avoid: ReadonlySet<HexSpec> = new Set()) {
  const near = neighboursIn(spec);
  const coast = coastHeld(spec);
  const home = homeLand(spec);
  const hosts = home.filter((h) => !avoid.has(h) && h.terrain !== 'lake' && h.numbers.length > 0);
  const farm = (h: HexSpec) => (h.terrain === 'pasture' || h.terrain === 'fields' ? 0 : 1);
  for (const n of [...numbers].sort((a, b) => (PIPS[a] ?? 0) - (PIPS[b] ?? 0))) {
    const onCoast = coast ? home.filter(coast).some((h) => h.numbers.includes(n)) : false;
    const repeats = (h: HexSpec) => (coast && coast(h) && onCoast ? 1 : 0);
    // (A number the coast lacks goes back onto it, so a landing on it still finds a hex.)
    const shore = (h: HexSpec) => (coast && !onCoast && !coast(h) ? 1 : 0);
    const fits = (h: HexSpec) => !isRed(n) || (!hasRed(h) && !near(h).some(hasRed));
    const ranked = hosts
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => !h.numbers.includes(n))
      .sort((a, b) => shore(a.h) - shore(b.h) || a.h.numbers.length - b.h.numbers.length || repeats(a.h) - repeats(b.h) || farm(a.h) - farm(b.h) || pipsOf(a.h) - pipsOf(b.h) || a.i - b.i)
      .map(({ h }) => h);
    const target = ranked.find(fits) ?? ranked[0];
    if (target) target.numbers = [...target.numbers, n];
  }
}

/** Pairs of side-by-side hexes (and hexes alone) that carry two red numbers between them. */
function redClashes(hexes: readonly HexSpec[], near: (h: HexSpec) => readonly HexSpec[]): number {
  let n = 0;
  for (const h of hexes) {
    const reds = h.numbers.filter(isRed).length;
    if (reds === 0) continue;
    if (reds > 1) n++;
    for (const x of near(h)) if (hasRed(x)) n++;
  }
  return n;
}

/**
 * Deal number discs afresh over `slots`: the red numbers apart (from each other and from any
 * numbered hex beside them), and under Invasion a different number on every coastal slot while
 * the discs allow. Discs beyond the slots are the least likely (under Invasion, repeated numbers
 * first, so the coast still finds every number), and they move on by rule 5 once the deal is down.
 * As the maps' own deal does, the reds go down first, each on a random slot clear of the others.
 */
export function deal(spec: BoardSpec, rng: Rng, slots: readonly HexSpec[], discs: readonly number[]) {
  if (discs.length < slots.length) throw new Error(`${discs.length} number discs for ${slots.length} hexes.`);
  const coast = coastHeld(spec);
  const near = neighboursIn(spec);
  const count = new Map<number, number>();
  for (const n of discs) count.set(n, (count.get(n) ?? 0) + 1);
  const spare = [...discs].sort((a, b) => (coast ? Number(count.get(a)! === 1) - Number(count.get(b)! === 1) : 0) || (PIPS[a] ?? 0) - (PIPS[b] ?? 0) || a - b).slice(0, discs.length - slots.length);
  const pool = [...discs];
  for (const n of spare) pool.splice(pool.indexOf(n), 1);

  const onCoast = coast ? slots.filter(coast) : [];
  const inland = coast ? slots.filter((h) => !coast(h)) : [...slots];
  for (const h of slots) h.numbers = [];
  let best: number[][] | null = null;
  let bestClashes = Infinity;
  for (let attempt = 0; attempt < 200 && bestClashes > 0; attempt++) {
    const order = rng.shuffle(pool.slice());
    // A crowded coast cannot take every number on a separate hex. Numbers without a spare
    // copy go first: rehome can then give the coast any omitted number as a second disc.
    const first: number[] = [];
    const rest: number[] = [];
    const coastalOrder = coast ? [...order.filter((n) => !spare.includes(n)), ...order.filter((n) => spare.includes(n))] : order;
    for (const n of coastalOrder) (first.length < onCoast.length && !first.includes(n) ? first : rest).push(n);
    while (first.length < onCoast.length) first.push(rest.shift()!);
    for (const h of slots) h.numbers = [];
    for (const [side, ds] of [
      [onCoast, first],
      [inland, rest],
    ] as const) {
      const spots = rng.shuffle(side.slice());
      for (const n of ds.filter(isRed)) {
        const h = spots.find((x) => x.numbers.length === 0 && !near(x).some(hasRed)) ?? spots.find((x) => x.numbers.length === 0)!;
        h.numbers = [n];
      }
      const others = ds.filter((n) => !isRed(n));
      side.filter((x) => x.numbers.length === 0).forEach((h, i) => (h.numbers = [others[i]]));
    }
    const clashes = redClashes(slots, near);
    if (clashes < bestClashes) {
      bestClashes = clashes;
      best = slots.map((h) => h.numbers);
    }
  }
  slots.forEach((h, i) => (h.numbers = best![i]));
  rehome(spec, spare);
}

/**
 * The last word on a shaped map. Each shaper deals or moves numbers by its own rules, and between
 * them red numbers can end up side by side (or two on one hex). While they do, swap single numbers
 * between two plain land hexes wherever that parts them. When single swaps get stuck, search
 * the remaining red positions together, then fit the other discs round them.
 * - A feature's numbers stay put: the lake's, a well's, the castle's, a swamp's, a face-down hex's,
 *   a bounty field's (which never bears a red one).
 * - A fishing ground's numbers stay put too, but count: no swap puts a red beside a red ground.
 * - Under Invasion the home coast loses no number it bore and gains no repeat, so every landing
 *   number still finds a hex.
 * It uses no dice: the deal is already down.
 */
export function partReds(spec: BoardSpec) {
  const all = neighboursIn(spec);
  const land = spec.hexes.filter((h) => h.terrain !== 'sea');
  /** Reds two to a hex, and red land beside red land. */
  const clashes = () => {
    let n = 0;
    for (const h of land) {
      const reds = h.numbers.filter(isRed).length;
      if (reds === 0) continue;
      if (reds > 1) n += reds - 1;
      for (const x of all(h)) if (x.terrain !== 'sea' && hasRed(x)) n++;
    }
    return n;
  };
  /** Red land beside a red fishing ground (which a swap may not add to). */
  const offshore = () => {
    let n = 0;
    for (const h of land) if (hasRed(h)) for (const x of all(h)) if (x.terrain === 'sea' && hasRed(x)) n++;
    return n;
  };
  const score = () => clashes() + offshore();
  let now = score();
  if (now === 0) return;
  const grounds = offshore();

  const hidden = hiddenKeys(spec);
  const movable = land.filter((h) => PLAIN.includes(h.terrain) && !h.well && h.numbers.length > 0 && !hidden.has(key(h.q, h.r)));
  const coast = coastHeld(spec);
  const shore = coast ? homeLand(spec).filter(coast) : [];
  /** The home coast's numbers: how many differ, and how many repeat (Invasion lands raiders by them). */
  const coastal = () => {
    const seen = new Map<number, number>();
    for (const h of shore) for (const n of h.numbers) seen.set(n, (seen.get(n) ?? 0) + 1);
    let repeats = 0;
    for (const c of seen.values()) repeats += c - 1;
    return { numbers: new Set(seen.keys()), repeats };
  };
  const before = coastal();
  const allowed = () => {
    const after = coast ? coastal() : before;
    return offshore() <= grounds && [...before.numbers].every((n) => after.numbers.has(n)) && after.repeats <= before.repeats;
  };
  type Swap = { a: HexSpec; b: HexSpec; x: number; y: number };
  const swaps: Swap[] = [];
  for (let i = 0; i < movable.length; i++) {
    for (let j = i + 1; j < movable.length; j++) {
      for (let x = 0; x < movable[i].numbers.length; x++) {
        for (let y = 0; y < movable[j].numbers.length; y++) swaps.push({ a: movable[i], b: movable[j], x, y });
      }
    }
  }
  const flip = ({ a, b, x, y }: Swap) => ([a.numbers[x], b.numbers[y]] = [b.numbers[y], a.numbers[x]]);
  const original = movable.map((h) => [...h.numbers]);
  const fits = ({ a, b, x, y }: Swap) => a.numbers[x] !== b.numbers[y] && !a.numbers.includes(b.numbers[y]) && !b.numbers.includes(a.numbers[x]);
  const improve = () => {
    for (const swap of swaps) {
      const { a, b, x, y } = swap;
      if ((!isRed(a.numbers[x]) && !isRed(b.numbers[y])) || !fits(swap)) continue;
      flip(swap);
      const next = score();
      if (next < now && allowed()) {
        now = next;
        return true;
      }
      flip(swap);
    }
    return false;
  };
  while (now > 0 && improve()) { /* Each accepted swap strictly lowers the score. */ }
  if (now === 0) return;
  // The swaps can carry discs between the coast and the interior, which the fallback keeps apart, so
  // it may fit only on the board as it came: try it from both, and keep a placement only if it helps
  // (a clash between two fixed reds stays whatever moves, and needn't reshuffle the rest).
  const swapped = movable.map((h) => [...h.numbers]);
  const restore = (to: number[][]) => movable.forEach((h, i) => (h.numbers = [...to[i]]));
  for (const from of [swapped, original]) {
    restore(from);
    if (fitReds(movable, all, new Set(shore)) && score() < now) return;
  }
  restore(swapped);
}

/**
 * An exhaustive fallback for a swap-local minimum. The coast and the interior each keep their
 * whole disc multiset, every hex keeps its disc count, and feature hexes stay fixed. Enumerate
 * independent sets for the movable reds, then match the non-red discs to the remaining spaces
 * (one copy of each number per hex). This admits cycles of any length without drawing more dice.
 */
function fitReds(movable: readonly HexSpec[], near: (h: HexSpec) => readonly HexSpec[], shore: ReadonlySet<HexSpec>): boolean {
  const free = new Set(movable);
  const groups = [movable.filter((h) => shore.has(h)), movable.filter((h) => !shore.has(h))];
  const original = new Map(movable.map((h) => [h, [...h.numbers]]));
  const redDiscs = groups.map((hs) => hs.flatMap((h) => h.numbers.filter(isRed)));
  const others = groups.map((hs) => hs.flatMap((h) => h.numbers.filter((n) => !isRed(n))));
  const candidates = groups.map((hs) => hs.filter((h) => !near(h).some((n) => !free.has(n) && hasRed(n))));
  const selected = new Set<HexSpec>();

  const fill = () => {
    for (let side = 0; side < groups.length; side++) {
      const hs = groups[side];
      const assigned = new Map(hs.map((h) => [h, [] as number[]]));
      const capacity = (h: HexSpec) => original.get(h)!.length - Number(selected.has(h));
      // An augmenting path moves already matched discs out of the way. A number-to-hex edge
      // has capacity one, so two copies of a number can never finish on the same hex.
      const put = (n: number, seenNumbers: Set<number>, seenHexes: Set<HexSpec>): boolean => {
        if (seenNumbers.has(n)) return false;
        seenNumbers.add(n);
        const order = [...hs].sort((a, b) => Number(!original.get(a)!.includes(n)) - Number(!original.get(b)!.includes(n)));
        for (const h of order) {
          const ns = assigned.get(h)!;
          if (seenHexes.has(h) || ns.includes(n) || capacity(h) === 0) continue;
          seenHexes.add(h);
          if (ns.length < capacity(h)) {
            ns.push(n);
            return true;
          }
          for (let i = 0; i < ns.length; i++) {
            if (put(ns[i], seenNumbers, seenHexes)) {
              ns[i] = n;
              return true;
            }
          }
        }
        return false;
      };
      for (const n of others[side]) if (!put(n, new Set(), new Set())) return false;
      const reds: number[] = [...redDiscs[side]];
      for (const h of hs.filter((h) => selected.has(h))) {
        const old = original.get(h)!.find((n) => isRed(n) && reds.includes(n));
        const n = old ?? reds[0];
        assigned.get(h)!.push(n);
        reds.splice(reds.indexOf(n), 1);
      }
      for (const h of hs) h.numbers = assigned.get(h)!;
    }
    return true;
  };
  // (The search is exponential where the reds can't all be placed. Today's islands settle it in a
  // handful of steps; a larger one gives up here rather than hang the set-up.)
  let budget = 100_000;
  const choose = (side: number, start: number, left: number): boolean => {
    if (--budget < 0) return false;
    if (left === 0) return side === 0 ? choose(1, 0, redDiscs[1].length) : fill();
    const pool = candidates[side];
    for (let i = start; i <= pool.length - left; i++) {
      const h = pool[i];
      if (near(h).some((n) => selected.has(n))) continue;
      selected.add(h);
      if (choose(side, i + 1, left - 1)) return true;
      selected.delete(h);
    }
    return false;
  };
  if (choose(0, 0, redDiscs[0].length)) return true;
  for (const h of movable) h.numbers = original.get(h)!;
  return false;
}

/** Whether any two side-by-side hexes of `hexes` (or one hex) carry two red numbers. */
export function redsTouch(spec: BoardSpec, hexes: readonly HexSpec[] = spec.hexes): boolean {
  return redClashes(hexes, neighboursIn(spec)) > 0;
}
