// The two rivers on the home island (rule 10), laid by the home island's rules (docs/maps.md): two
// straight stamps, the four-hex river running mountains, hills, pasture and swamp and the three-hex
// one mountains, hills and swamp, each turning at its mouth to meet the sea, never touching
// (`stampRivers`, maps/place.ts). Where an island is too narrow for a straight pair (a player's own
// map can be), the courses may bend. The island's own tiles and numbers are dealt afresh round them.

import { BEGINNER_ROADS, SIDE_DIRS, type BoardSpec, type HexSpec } from '../../board';
import { stampRivers } from '../../maps/place';
import { PLAIN, cellKey, centralHex, deal, featureHexes, hexAtIn, hexDistance, hiddenKeys, homeIslands, homeLand, neighboursIn, takesNumber, touching } from '../../maps/shape';
import type { Rng } from '../../rng';
import type { GameOptions, Terrain } from '../../types';

/** Each river's tiles from source to mouth: the four-hex river's, then the three-hex river's. */
const RIVER_TERRAIN: readonly (readonly Terrain[])[] = [
  ['mountains', 'hills', 'pasture', 'swamp'],
  ['mountains', 'hills', 'swamp'],
];

const key = (q: number, r: number) => `${q},${r}`;

/**
 * Lay the two rivers (the module's shapeMap): as stamps, leaving an inland hex for the lake where
 * Fisheries is in, and on the beginner set-up crossing none of its starting roads.
 */
export function shapeRivers(spec: BoardSpec, options: GameOptions, rng: Rng) {
  shapeHomeIsland(spec, rng, stampRivers(options.modules.includes('fisheries'), bendingRivers, options.layout === 'beginner' ? BEGINNER_ROADS : []));
}

/** A river laid on a spec: its hexes from source to mouth, and the mouth's side that meets the sea. */
export interface River {
  path: HexSpec[];
  mouthSide: number;
}

/**
 * The tiles the river tiles send back on any other island, in this order until seven have gone:
 * the desert, two hills, two pastures, two mountains, then (with no desert) a fields.
 */
const SENT_BACK: Terrain[] = ['desert', 'hills', 'hills', 'pasture', 'pasture', 'mountains', 'mountains', 'fields'];

/** Take `count` tiles out of `bag`, the ones SENT_BACK lists first, then the most plentiful terrain. */
function sendBack(bag: Terrain[], count: number) {
  for (const t of SENT_BACK) {
    if (count === 0) return;
    const i = bag.indexOf(t);
    if (i < 0) continue;
    bag.splice(i, 1);
    count--;
  }
  for (; count > 0; count--) {
    const most = PLAIN.reduce((best, t) => (bag.filter((x) => x === t).length > bag.filter((x) => x === best).length ? t : best));
    bag.splice(bag.indexOf(most), 1);
  }
}

/**
 * Two rivers that may bend, where no straight pair fits: of four hexes and three, each a chain of
 * free hexes that never runs back beside itself, ending on the coast where a side meets open water,
 * and the two never touching. Of every such pair, the best are those on different islands (where the
 * map starts on several), far apart, rising inland, and with mouths clear of the harbours; the dice
 * pick among them.
 */
const bendingRivers: RiverFinder = (spec, islands, free, rng) => {
  const at = hexAtIn(spec);
  const near = neighboursIn(spec);
  const hidden = hiddenKeys(spec);
  const home = new Set(islands.flat());
  const islandOf = new Map<HexSpec, number>();
  islands.forEach((island, i) => island.forEach((h) => islandOf.set(h, i)));
  const open = new Set(free);
  const harbour = (h: HexSpec, side: number) => spec.ports.some((p) => p.q === h.q && p.r === h.r && p.side === side);
  // (Off the board, or open water that isn't face down.)
  const toSea = (h: HexSpec) =>
    SIDE_DIRS.flatMap(([dq, dr], side) => {
      const n = at(h.q + dq, h.r + dr);
      return !n || (n.terrain === 'sea' && !hidden.has(key(n.q, n.r))) ? [side] : [];
    });
  const sideTo = (a: HexSpec, b: HexSpec) => SIDE_DIRS.findIndex(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r);

  const chains = (length: number): River[] => {
    const out: River[] = [];
    const walk = (path: HexSpec[]) => {
      const last = path[path.length - 1];
      if (path.length === length) {
        // The mouth runs straight on where it can, else at the gentlest turn, and clear of a harbour.
        const heading = sideTo(path[path.length - 2], last);
        const turn = (s: number) => Math.min((s - heading + 6) % 6, (heading - s + 6) % 6);
        const sides = toSea(last).sort((a, b) => Number(harbour(last, a)) - Number(harbour(last, b)) || turn(a) - turn(b) || a - b);
        if (sides.length > 0) out.push({ path: [...path], mouthSide: sides[0] });
        return;
      }
      for (const n of near(last)) {
        if (!open.has(n) || path.includes(n) || path.slice(0, -1).some((p) => touching(p, n))) continue;
        path.push(n);
        walk(path);
        path.pop();
      }
    };
    for (const h of free) walk([h]);
    return out;
  };

  const inland = (h: HexSpec) => (near(h).filter((n) => home.has(n)).length === 6 ? 1 : 0);
  const clear = (rv: River) => (harbour(rv.path[rv.path.length - 1], rv.mouthSide) ? 0 : 1);
  const merit = (rv: River) => inland(rv.path[0]) + clear(rv);
  const shorts = chains(3);
  const shortMerit = shorts.map(merit);
  let best: River[][] = [];
  let bestScore = -1;
  for (const a of chains(4)) {
    // (Every pair is weighed, so what touches the long river is worked out once for all the short
    // ones: its hexes, and the places beside them.)
    const beside = new Set<number | string>();
    for (const x of a.path) for (const [dq, dr] of SIDE_DIRS) beside.add(cellKey(x.q + dq, x.r + dr));
    const meritA = merit(a);
    for (const [j, b] of shorts.entries()) {
      if (b.path.some((h) => a.path.includes(h) || beside.has(cellKey(h.q, h.r)))) continue;
      const gap = Math.min(...a.path.flatMap((x) => b.path.map((h) => hexDistance(x, h))));
      const apart = islands.length > 1 && islandOf.get(a.path[0]) !== islandOf.get(b.path[0]) ? 10 : 0;
      const score = apart + Math.min(gap, 4) + meritA + shortMerit[j];
      if (score > bestScore) {
        bestScore = score;
        best = [[a, b]];
      } else if (score === bestScore) best.push([a, b]);
    }
  }
  return best.length > 0 ? best[rng.int(best.length)] : null;
};

/** Where two rivers go, among the free hexes of the home islands (`room`), or null where they can't. */
export type RiverFinder = (spec: BoardSpec, islands: HexSpec[][], room: HexSpec[], rng: Rng) => River[] | null;

/**
 * The rivers on the home island, where `find` puts them. The middle of the island stays dry for the
 * oasis. The river tiles go on their hexes, and the island's own tiles, less the seven they send
 * back, are shuffled over the rest; then its own number discs are dealt afresh, skipping the
 * swamps, with what's left over moving on by rule 5 (and under Invasion a different number on every
 * coastal hex). A robber the map started on a numbered hex starts on the three-hex river's swamp
 * instead.
 */
function shapeHomeIsland(spec: BoardSpec, rng: Rng, find: RiverFinder) {
  const islands = homeIslands(spec);
  const home = homeLand(spec);
  const taken = featureHexes(spec);
  const free = home.filter((h) => !taken.has(h));
  const centre = centralHex(home, (h) => !taken.has(h));
  const room = free.filter((h) => h !== centre);
  const rivers = find(spec, islands, room, rng);
  if (!rivers) throw new Error('The home island has no room for two rivers.');

  const discs = free.flatMap((h) => h.numbers);
  const bag = free.map((h) => h.terrain);
  sendBack(bag, rivers[0].path.length + rivers[1].path.length);
  const onRiver = new Set(rivers.flatMap((rv) => rv.path));
  rivers.forEach((rv, i) => rv.path.forEach((h, j) => (h.terrain = RIVER_TERRAIN[i][j])));
  rng.shuffle(bag);
  free.filter((h) => !onRiver.has(h)).forEach((h, i) => (h.terrain = bag[i]));
  for (const h of free) h.numbers = [];
  spec.rivers = rivers.map((rv) => ({ path: rv.path.map((h): [number, number] => [h.q, h.r]), mouthSide: rv.mouthSide }));
  deal(spec, rng, free.filter((h) => takesNumber(h.terrain)), discs);

  if (spec.robber) {
    const swamp = rivers[1].path[rivers[1].path.length - 1];
    spec.robber = [swamp.q, swamp.r];
  }
}
