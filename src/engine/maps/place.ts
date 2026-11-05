// Where a new game's features go on its home island, by the rules every dealt map keeps
// (docs/maps.md, The home island): the rivers as straight stamps, the fishing grounds spread round
// the island with their number pairs split by side, and the harbours round the home coast clear of
// the castle, the river mouths and the grounds. The modules' shapeMap hooks place their features
// with these, and the dealer (maps/deal.ts) the harbours.

import { SIDE_DIRS, hexCenter, type BoardSpec, type HexSpec } from '../board';
import type { River, RiverFinder } from '../modules/rivers/map';
import type { Rng } from '../rng';
import { cellKey, hexAtIn, hexDistance, hiddenKeys, homeIslands, homeLand, neighboursIn } from './shape';
import { harbourTypes, spreadSlots, type Slot } from './util';

const DEG = 180 / Math.PI;
const turn = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** The middle of some hexes, in world space. */
function middle(hexes: readonly HexSpec[]): [number, number] {
  return hexes.reduce(
    ([x, z], h) => {
      const [hx, hz] = hexCenter(h.q, h.r);
      return [x + hx / hexes.length, z + hz / hexes.length];
    },
    [0, 0],
  );
}

/** Whether side `side` of `h` opens onto open water: off the board, or a sea hex that isn't face down. */
function seaward(at: (q: number, r: number) => HexSpec | undefined, hidden: Set<string>) {
  return (h: HexSpec, side: number) => {
    const n = at(h.q + SIDE_DIRS[side][0], h.r + SIDE_DIRS[side][1]);
    return !n || (n.terrain === 'sea' && !hidden.has(`${n.q},${n.r}`));
  };
}

/**
 * The rivers as two stamps: each a straight course, the four-hex one and the
 * three-hex one, its mouth turned 60° to the sea, left or right, pointing any of six ways; the two
 * never touch. Of every such pair, the best are those on different islands (where the map starts on
 * several), far apart, and rising inland; with `lake`, one that leaves an inland hex free for
 * Fisheries' lake comes first, and no mouth opens on a harbour's side. The dice pick among the best.
 * No river crosses between the two hexes of a pair in `keep` (the beginner set-up's starting roads,
 * which can't stand on a bridge site). Where no pair fits (an island too narrow for a straight
 * course), the courses may bend (`fallback`).
 */
export function stampRivers(lake: boolean, fallback: RiverFinder, keep: readonly [[number, number], [number, number]][] = []): RiverFinder {
  return (spec, islands, room, rng) => {
    const at = hexAtIn(spec);
    const near = neighboursIn(spec);
    const open = new Set(room);
    const sea = seaward(at, hiddenKeys(spec));
    const home = new Set(islands.flat());
    const islandOf = new Map<HexSpec, number>();
    islands.forEach((island, i) => island.forEach((h) => islandOf.set(h, i)));
    const inland = (h: HexSpec) => near(h).length === 6 && near(h).every((n) => home.has(n));
    // (A map starting on several islands keeps its harbour sites, so a mouth keeps clear of them;
    // elsewhere the harbours are placed afterwards, clear of the mouths.)
    const harbour = (h: HexSpec, side: number) => islands.length > 1 && spec.ports.some((p) => p.q === h.q && p.r === h.r && p.side === side);

    const kept = new Set(keep.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
    const crosses = (a: HexSpec, b: HexSpec) => kept.has(`${a.q},${a.r}|${b.q},${b.r}`);
    const stamps = (length: number): River[] => {
      const out: River[] = [];
      for (const source of room) {
        for (let d = 0; d < 6; d++) {
          const path = [source];
          for (let i = 1; i < length; i++) {
            const last = path[i - 1];
            const next = at(last.q + SIDE_DIRS[d][0], last.r + SIDE_DIRS[d][1]);
            if (!next || !open.has(next) || crosses(last, next)) break;
            path.push(next);
          }
          if (path.length < length) continue;
          const mouth = path[length - 1];
          for (const side of [(d + 1) % 6, (d + 5) % 6]) if (sea(mouth, side) && !harbour(mouth, side)) out.push({ path, mouthSide: side });
        }
      }
      return out;
    };
    const longs = stamps(4);
    const shorts = stamps(3);
    const lakeRoom = room.filter(inland);
    let best: River[][] = [];
    let bestScore = -Infinity;
    for (const a of longs) {
      const beside = new Set<number | string>();
      for (const x of a.path) {
        beside.add(cellKey(x.q, x.r));
        for (const [dq, dr] of SIDE_DIRS) beside.add(cellKey(x.q + dq, x.r + dr));
      }
      for (const b of shorts) {
        if (b.path.some((h) => beside.has(cellKey(h.q, h.r)))) continue;
        const used = new Set([...a.path, ...b.path]);
        const leaves = !lake || lakeRoom.some((h) => !used.has(h)) ? 100 : 0;
        const gap = Math.min(...a.path.flatMap((x) => b.path.map((h) => hexDistance(x, h))));
        const apart = islands.length > 1 && islandOf.get(a.path[0]) !== islandOf.get(b.path[0]) ? 10 : 0;
        const score = leaves + apart + Math.min(gap, 4) + Number(inland(a.path[0])) + Number(inland(b.path[0]));
        if (score > bestScore) {
          bestScore = score;
          best = [[a, b]];
        } else if (score === bestScore) best.push([a, b]);
      }
    }
    return best.length > 0 ? best[rng.int(best.length)] : fallback(spec, islands, room, rng);
  };
}

/**
 * Six fishing grounds round the home island, by the rules every map keeps: each in water touching
 * the island (a channel's may touch an islet as well), the six spread about sixty degrees apart
 * round it from a random start, those touching two of its hexes first; and their numbers split so
 * that each half of the island (three grounds in a row) has one of 4 and 10, one of 5 and 9 and one
 * of 6 and 8. On the classic island the grounds are new sea hexes after the island's own, so the land
 * keeps every intersection and edge id it had. Returns false, placing nothing, where the map starts
 * on more than one island: there the recorded way still places them.
 */
export function placeGrounds(spec: BoardSpec, numbers: readonly number[], rng: Rng): boolean {
  const islands = homeIslands(spec);
  if (islands.length !== 1) return false;
  const [home] = islands;
  const mine = new Set(home.map((h) => cellKey(h.q, h.r)));
  const at = hexAtIn(spec);
  const hidden = hiddenKeys(spec);
  const corsair = spec.corsair ? cellKey(...spec.corsair) : undefined;
  const [cx, cz] = middle(home);

  // Every cell of open water beside the island, with how many of its hexes it touches.
  const cells = new Map<number | string, { q: number; r: number; shore: number; bearing: number }>();
  for (const h of home) {
    for (const [dq, dr] of SIDE_DIRS) {
      const [q, r] = [h.q + dq, h.r + dr];
      const k = cellKey(q, r);
      if (mine.has(k) || cells.has(k) || k === corsair) continue;
      const there = at(q, r);
      if (there && (there.terrain !== 'sea' || there.numbers.length > 0 || hidden.has(`${q},${r}`))) continue;
      const shore = SIDE_DIRS.filter(([eq, er]) => mine.has(cellKey(q + eq, r + er))).length;
      const [x, z] = hexCenter(q, r);
      cells.set(k, { q, r, shore, bearing: Math.atan2(z - cz, x - cx) * DEG });
    }
  }
  const water = [...cells.values()];
  if (water.length < 6) throw new Error('The home island has no room for six fishing grounds.');

  // Aim at six bearings from a random start, taking the nearest water touching two hexes where there
  // is some; of a few starts, keep the most even spread.
  let best: typeof water = [];
  let worst = Infinity;
  for (let attempt = 0; attempt < 12 && worst > 15; attempt++) {
    const start = rng.next() * 360;
    const chosen: typeof water = [];
    for (let i = 0; i < 6; i++) {
      const aim = start + 60 * i;
      const free = water.filter((c) => !chosen.includes(c));
      const tier = Math.max(...free.map((c) => Math.min(c.shore, 2)));
      chosen.push(free.filter((c) => Math.min(c.shore, 2) === tier).reduce((b, c) => (turn(c.bearing, aim) < turn(b.bearing, aim) ? c : b)));
    }
    const round = [...chosen].sort((a, b) => a.bearing - b.bearing);
    const off = Math.max(...round.map((c, i) => Math.abs(turn(c.bearing, round[(i + 1) % 6].bearing) - 60)));
    if (off < worst) {
      worst = off;
      best = round;
    }
  }

  // One of each pair in three grounds in a row, the other in the other three.
  const first = rng.int(3);
  const half = [0, 1, 2].map((i) => (first + i) % 6);
  const rest = [3, 4, 5].map((i) => (first + i) % 6);
  rng.shuffle(half);
  rng.shuffle(rest);
  const dealt: number[] = [];
  const pairs = [...numbers].sort((a, b) => a - b);
  const twins = [0, 1, 2].map((i) => [pairs[i], pairs[5 - i]]);
  for (const [i, [a, b]] of twins.entries()) {
    const [mineN, theirs] = rng.next() < 0.5 ? [a, b] : [b, a];
    dealt[half[i]] = mineN;
    dealt[rest[i]] = theirs;
  }
  best.forEach((c, i) => {
    const there = at(c.q, c.r);
    if (there) there.numbers = [dealt[i]];
    else spec.hexes.push({ q: c.q, r: c.r, terrain: 'sea', numbers: [dealt[i]] });
  });
  return true;
}

/**
 * The harbours round the home coast, as many as the map had where the coast has room for them:
 * spread evenly from a random start, no two sharing a corner, and none on the castle, on a river's
 * mouth or facing a fishing ground. On a crowded coast (the archipelago's for three, with the castle,
 * both river mouths and six grounds) only seven or eight fit, and the 3:1 harbours are the ones left
 * out. Their kinds are dealt afresh (the dealer's annealing may trade them about).
 */
export function placeHarbours(spec: BoardSpec, rng: Rng) {
  const at = hexAtIn(spec);
  const sea = seaward(at, hiddenKeys(spec));
  const castle = spec.castle ? at(...spec.castle) : undefined;
  const mouths = new Set((spec.rivers ?? []).map((rv) => `${rv.path[rv.path.length - 1].join()}:${rv.mouthSide}`));
  const slots: Slot[] = [];
  for (const h of homeLand(spec)) {
    if (h === castle) continue;
    for (let side = 0; side < 6; side++) {
      if (!sea(h, side) || mouths.has(`${h.q},${h.r}:${side}`)) continue;
      const facing = at(h.q + SIDE_DIRS[side][0], h.r + SIDE_DIRS[side][1]);
      if (facing && facing.numbers.length > 0) continue;
      slots.push({ at: [h.q, h.r], side });
    }
  }
  const count = spec.ports.length;
  let chosen: Slot[] = [];
  for (let attempt = 0; attempt < 8 && chosen.length < count; attempt++) {
    const tried = spreadSlots(rng, slots, count);
    if (tried.length > chosen.length) chosen = tried;
  }
  const types = harbourTypes(rng, chosen.length);
  spec.ports = chosen.map((s, i) => ({ q: s.at[0], r: s.at[1], side: s.side, type: types[i] }));
}
