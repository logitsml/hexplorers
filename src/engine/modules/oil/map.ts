// Wells on the home island, by Oil's variable set-up: a numbered well on the desert, then
// wells on the second-likeliest pasture and the second-least-likely forest, never two side by side.
// Where another module has taken the desert, the numbered well goes on a swamp (as on the All Hands
// map), or failing that on a hills, fields or mountains hex, which keeps its own number.

import { type BoardSpec, type HexSpec } from '../../board';
import { coastOf, featureHexes, homeLand, pipsOf as pips, touching as adjacent } from '../../maps/shape';
import type { Rng } from '../../rng';

/** The numbers the desert's well can carry. */
const DESERT_WELL_NUMBERS = [5, 9];

const isRed = (h: HexSpec): boolean => h.numbers.some((n) => n === 6 || n === 8);

/** Pairs of side-by-side hexes that both carry a 6 or an 8. */
function redPairs(hexes: HexSpec[]): number {
  let n = 0;
  for (let i = 0; i < hexes.length; i++) {
    if (!isRed(hexes[i])) continue;
    for (let j = i + 1; j < hexes.length; j++) if (isRed(hexes[j]) && adjacent(hexes[i], hexes[j])) n++;
  }
  return n;
}

const pick = <T>(xs: T[], rng: Rng): T => (xs.length === 1 ? xs[0] : xs[rng.int(xs.length)]);

/** Where one well goes: its tile, and the tile it swaps numbers with to carry the number it should (if any). */
interface Spot {
  tile: HexSpec;
  swap: HexSpec | null;
}

/**
 * The spots a well of one terrain may take on the home island. The well's tile is ranked by its
 * number's likelihood (second from the top for pastures, from the bottom for forests). Any tile of
 * the terrain can take it, swapping numbers with a tile that carries the right one, so the well
 * still bears it. Under Invasion a swap stays on the coast or off it, so the coast keeps its numbers.
 */
function spotsFor(home: HexSpec[], terrain: HexSpec['terrain'], likeliestFirst: boolean, sameSide: (a: HexSpec, b: HexSpec) => boolean): Spot[] {
  const group = home.filter((h) => h.terrain === terrain && !h.well);
  if (group.length === 0) return [];
  const ranked = [...group].sort((a, b) => (likeliestFirst ? pips(b) - pips(a) : pips(a) - pips(b)));
  const want = pips(ranked[Math.min(1, ranked.length - 1)]);
  const holders = group.filter((h) => pips(h) === want);
  const out: Spot[] = [];
  for (const tile of group) {
    if (pips(tile) === want) out.push({ tile, swap: null });
    else for (const h of holders) if (sameSide(tile, h)) out.push({ tile, swap: h });
  }
  return out;
}

const swapNumbers = (a: HexSpec, b: HexSpec) => ([a.numbers, b.numbers] = [b.numbers, a.numbers]);

/** Lexicographic order of two score lists (lower is better). */
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * A well where the island has no desert or swamp for the numbered one, or no pasture or forest
 * left for its own: a hills, fields or mountains hex (any free hex at all, failing those) takes it
 * and keeps its own number. It touches no other well if it can help it, and bears a 5 or a 9 if one does.
 */
function spareWell(spec: BoardSpec, home: HexSpec[], rng: Rng): HexSpec | undefined {
  const taken = featureHexes(spec);
  const free = home.filter((h) => !taken.has(h) && h.numbers.length > 0);
  const plain = free.filter((h) => h.terrain === 'hills' || h.terrain === 'fields' || h.terrain === 'mountains');
  const pool = plain.length > 0 ? plain : free;
  if (pool.length === 0) return undefined;
  const wells = home.filter((h) => h.well);
  const rank = (h: HexSpec) => (wells.some((w) => adjacent(w, h)) ? 2 : 0) + (h.numbers.some((n) => DESERT_WELL_NUMBERS.includes(n)) ? 0 : 1);
  const best = Math.min(...pool.map(rank));
  const well = pick(pool.filter((h) => rank(h) === best), rng);
  well.well = true;
  return well;
}

/**
 * The numbered well: on the desert, else on a swamp (the first river's: the robber starts on the
 * other), each taking a 5 or a 9, preferring one its neighbours don't already carry (and under
 * Invasion one the coast doesn't). With neither, a spare well takes its place.
 */
function numberedWell(spec: BoardSpec, home: HexSpec[], rng: Rng): HexSpec | undefined {
  const firstSwamp = spec.rivers?.[0]?.path.at(-1);
  const swamp = home.find((h) => firstSwamp && h.q === firstSwamp[0] && h.r === firstSwamp[1] && h.terrain === 'swamp') ?? home.find((h) => h.terrain === 'swamp');
  const site = home.find((h) => h.terrain === 'desert') ?? swamp;
  if (site) {
    const beside = spec.hexes.filter((h) => adjacent(h, site));
    const coast = spec.castle ? home.filter(coastOf(spec, home)) : [];
    const fresh = DESERT_WELL_NUMBERS.filter((n) => !beside.some((h) => h.numbers.includes(n)));
    const freshest = fresh.filter((n) => !coast.some((h) => h.numbers.includes(n)));
    site.numbers = [pick(freshest.length > 0 ? freshest : fresh.length > 0 ? fresh : DESERT_WELL_NUMBERS, rng)];
    site.well = true;
    return site;
  }
  return spareWell(spec, home, rng);
}

/**
 * Put the three wells on the home island. `calm` (every named map), and a calm island with
 * Invasion or fishing grounds, put keeping reds apart first, before separating wells and moving few discs.
 */
export function placeWells(spec: BoardSpec, rng: Rng, calm = false) {
  const home = homeLand(spec);
  const coastal = spec.castle ? coastOf(spec, home) : null;
  const sameSide = (a: HexSpec, b: HexSpec) => !coastal || coastal(a) === coastal(b);
  const first = numberedWell(spec, home, rng);

  // Then the pasture and forest wells, together: no two wells side by side if it can be helped, then
  // as few number swaps as possible, then no 6 and 8 brought together (first of all where calm), then the dice.
  const pastures: (Spot | null)[] = spotsFor(home, 'pasture', true, sameSide);
  const forests: (Spot | null)[] = spotsFor(home, 'forest', false, sameSide);
  if (pastures.length === 0) pastures.push(null);
  if (forests.length === 0) forests.push(null);
  let best: { p: Spot | null; f: Spot | null }[] = [];
  let bestKey: number[] = [];
  const hexes = spec.hexes;
  const reds = redPairs(hexes);
  // The shared repair ran before the wells were ranked. Where coastal numbers or fishing
  // grounds constrain the next repair, a calm board keeps its no-swap choice at the required
  // likelihood available rather than freezing a new red clash to separate its wells.
  const keepCalm = calm || (reds === 0 && (!!spec.castle || hexes.some((h) => h.terrain === 'sea' && h.numbers.length > 0)));
  for (const p of pastures) {
    for (const f of forests) {
      const wells = [first, p?.tile, f?.tile].filter((h): h is HexSpec => !!h);
      let touching = 0;
      for (let i = 0; i < wells.length; i++) for (let j = i + 1; j < wells.length; j++) if (adjacent(wells[i], wells[j])) touching++;
      const swaps = (p?.swap ? 1 : 0) + (f?.swap ? 1 : 0);
      if (p?.swap) swapNumbers(p.tile, p.swap);
      if (f?.swap) swapNumbers(f.tile, f.swap);
      const redder = redPairs(hexes) > reds ? 1 : 0;
      if (f?.swap) swapNumbers(f.tile, f.swap);
      if (p?.swap) swapNumbers(p.tile, p.swap);
      const key = keepCalm ? [redder, touching, swaps] : [touching, swaps, redder];
      const cmp = bestKey.length === 0 ? -1 : compare(key, bestKey);
      if (cmp < 0) {
        best = [{ p, f }];
        bestKey = key;
      } else if (cmp === 0) best.push({ p, f });
    }
  }
  const { p, f } = pick(best, rng);
  for (const spot of [p, f]) {
    if (!spot) continue;
    if (spot.swap) swapNumbers(spot.tile, spot.swap);
    spot.tile.well = true;
  }
  // (An island the other modules have left without a pasture or a forest still gets three wells.)
  for (const spot of [p, f]) if (!spot) spareWell(spec, home, rng);
}
