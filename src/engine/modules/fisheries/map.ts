// Fishing on the home island (rule 10): the lake on one of its inner hexes, and six fishing grounds
// off its coast, spread round it by the home island's rules (`placeGrounds`, maps/place.ts), or
// shared out round each island where a player's own map starts on several.

import { SIDE_DIRS, hexCenter, type BoardSpec, type HexSpec } from '../../board';
import { placeGrounds } from '../../maps/place';
import { coastOf, featureHexes, hexAtIn, hiddenKeys, homeIslands, homeLand, isRed, neighboursIn, PLAIN, redsTouch, rehome, swapTiles } from '../../maps/shape';
import type { Rng } from '../../rng';
import type { GameOptions } from '../../types';
import { GROUND_NUMBERS, LAKE_NUMBERS } from './types';

function makeLake(h: HexSpec) {
  h.terrain = 'lake';
  h.numbers = [...LAKE_NUMBERS];
  delete h.well;
}

/**
 * The hexes the lake may take: the home island's inner hexes (every side on its own land), or where
 * an island has none (a narrow island of a player's own map) the ones with the most land
 * around them. Never a hex another module's feature holds.
 */
function lakeSites(spec: BoardSpec): HexSpec[] {
  const taken = featureHexes(spec);
  const home = homeLand(spec);
  const mine = new Set(home);
  const near = neighboursIn(spec);
  const inland = (h: HexSpec) => near(h).filter((n) => mine.has(n)).length;
  const free = home.filter((h) => !taken.has(h));
  const most = Math.max(0, ...free.filter((h) => PLAIN.includes(h.terrain) || h.terrain === 'desert').map(inland));
  return free.filter((h) => inland(h) === most);
}

/**
 * The lake replaces the desert on one of the inner hexes, chosen at random: it swaps places with the
 * tile there, which keeps its number (where the map keeps red numbers apart, never next to another
 * red). The beginner island keeps it where its desert stands, in the centre. If another module has
 * already taken the desert, or Invasion's coast must keep its numbers and the desert stands on it,
 * the lake takes an inner resource hex instead, and that hex's numbers move on by rule 5.
 */
export function placeLake(spec: BoardSpec, options: GameOptions, rng: Rng) {
  const inner = lakeSites(spec);
  const home = homeLand(spec);
  const coastal = coastOf(spec, home);
  const desert = home.find((h) => h.terrain === 'desert' && !(spec.castle && coastal(h)));
  if (desert) {
    if (options.layout === 'beginner' && inner.includes(desert)) {
      makeLake(desert);
      return;
    }
    let sites = inner.filter((h) => h === desert || PLAIN.includes(h.terrain));
    // (Balanced numbers and every named map keep the reds apart: so does the lake's swap.)
    if (options.numberPlacement === 'balanced' || options.map !== 'classic') {
      const calm = sites.filter((h) => {
        const trial: BoardSpec = { ...spec, hexes: spec.hexes.map((x) => ({ ...x, numbers: [...x.numbers] })) };
        const at = hexAtIn(trial);
        const [d, s] = [at(desert.q, desert.r)!, at(h.q, h.r)!];
        swapTiles(d, s);
        makeLake(s);
        return !redsTouch(trial, [d, s]);
      });
      if (calm.length > 0) sites = calm;
    }
    if (sites.length === 0) {
      makeLake(desert);
      return;
    }
    const site = sites[rng.int(sites.length)];
    if (site !== desert) swapTiles(desert, site);
    makeLake(site);
    return;
  }
  const sites = inner.filter((h) => PLAIN.includes(h.terrain));
  if (sites.length === 0) return;
  const site = sites[rng.int(sites.length)];
  const displaced = site.numbers;
  site.numbers = [];
  rehome(spec, displaced, new Set([site]));
  makeLake(site);
}

/**
 * Where six fishing grounds go round several home islands: bare sea hexes off the home coast,
 * shared out among the islands and spread round each by bearing from a random start. Hexes touching two of the
 * island's hexes come first, then those touching one; the water beyond a harbour, the corsair's
 * start, a map's face-down hexes and water that also touches an islet are kept clear while they can
 * be. The grounds that will bear the red numbers are found first, on opposite bearings (one on each
 * island where there are two), in water touching no red number. Returns the red grounds, then the rest.
 */
function groundSpots(spec: BoardSpec, rng: Rng): { red: HexSpec[]; rest: HexSpec[] } {
  const near = neighboursIn(spec);
  const hidden = hiddenKeys(spec);
  const at = hexAtIn(spec);
  const harbourWater = new Set(spec.ports.map((p) => at(p.q + SIDE_DIRS[p.side][0], p.r + SIDE_DIRS[p.side][1])));
  const corsair = spec.corsair ? at(...spec.corsair) : undefined;
  const islands = homeIslands(spec);
  const homes = new Set(islands.flat());
  const share = (total: number, k: number) => Math.floor((total * (k + 1)) / islands.length) - Math.floor((total * k) / islands.length);
  const reds = GROUND_NUMBERS.filter(isRed).length;
  const red: HexSpec[] = [];
  const rest: HexSpec[] = [];
  islands.forEach((island, k) => {
    const mine = new Set(island);
    const want = share(GROUND_NUMBERS.length, k);
    const redAims = share(reds, k);
    const water = spec.hexes.filter((h) => h.terrain === 'sea' && h.numbers.length === 0 && h !== corsair && !hidden.has(`${h.q},${h.r}`) && near(h).some((n) => mine.has(n)));
    const rank = (h: HexSpec) => {
      const shore = near(h).filter((n) => mine.has(n)).length;
      const islet = near(h).some((n) => n.terrain !== 'sea' && !homes.has(n));
      return (harbourWater.has(h) ? 4 : 0) + (islet ? 2 : 0) + (shore >= 2 ? 0 : 1);
    };
    const [cx, cz] = island.reduce(([x, z], h) => {
      const [hx, hz] = hexCenter(h.q, h.r);
      return [x + hx / island.length, z + hz / island.length];
    }, [0, 0]);
    const bearing = (h: HexSpec) => {
      const [x, z] = hexCenter(h.q, h.r);
      return Math.atan2(z - cz, x - cx);
    };
    const start = rng.next() * 2 * Math.PI;
    // (The red aims are spread evenly among the island's aims, and are taken first.)
    const redAt = new Set(Array.from({ length: redAims }, (_, j) => Math.floor((j * want) / redAims)));
    const aims = Array.from({ length: want }, (_, i) => i).sort((a, b) => Number(!redAt.has(a)) - Number(!redAt.has(b)) || a - b);
    for (const i of aims) {
      const aim = start + (2 * Math.PI * i) / want;
      const gap = (h: HexSpec) => {
        const d = Math.abs(bearing(h) - aim) % (2 * Math.PI);
        return Math.min(d, 2 * Math.PI - d);
      };
      let free = water.filter((h) => !red.includes(h) && !rest.includes(h));
      if (redAt.has(i)) {
        const calm = free.filter((h) => !near(h).some((n) => n.numbers.some(isRed) || red.includes(n)));
        if (calm.length > 0) free = calm;
      }
      if (free.length === 0) break;
      const tier = Math.min(...free.map(rank));
      (redAt.has(i) ? red : rest).push(free.filter((h) => rank(h) === tier).reduce((best, h) => (gap(h) < gap(best) - 1e-9 ? h : best)));
    }
  });
  return { red, rest };
}

/** The six fishing grounds shared out round several home islands, their numbers shuffled, the red ones where they touch no red. */
function shareGrounds(spec: BoardSpec, rng: Rng) {
  const { red, rest } = groundSpots(spec, rng);
  const reds = rng.shuffle(GROUND_NUMBERS.filter(isRed));
  const others = rng.shuffle(GROUND_NUMBERS.filter((n) => !isRed(n)));
  red.forEach((h, i) => (h.numbers = [reds[i]]));
  rest.forEach((h, i) => (h.numbers = [others[i]]));
}

/** Shape the home island for fishing (the module's shapeMap hook). */
export function shapeFishingMap(spec: BoardSpec, options: GameOptions, rng: Rng) {
  placeLake(spec, options, rng);
  if (!placeGrounds(spec, GROUND_NUMBERS, rng)) shareGrounds(spec, rng);
}
