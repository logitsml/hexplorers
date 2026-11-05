// Invasion's home island: the castle on its castle corner (maps/shape.ts, castleCorner), the desert
// on the coastal hex furthest from it, and the island's own numbers dealt afresh with a different
// one on every coastal hex (trading with the islets for any it lacks), so every roll can land a
// raider (docs/maps.md, The home island).

import { SIDE_DIRS, hexCenter, type BoardSpec, type HexSpec } from '../../board';
import { PIPS, isLand } from '../../constants';
import { PLAIN, coastOf, deal, featureHexes, hiddenKeys, homeIslands, neighboursIn, swapTiles, takesNumber } from '../../maps/shape';
import type { Rng } from '../../rng';

/**
 * The castle on the home island's coast (the module's shapeMap): a corner (the most sides to the
 * sea), the one lying furthest to the lower left. Its tile leaves the game and its number moves on.
 * The desert trades places with the coastal hex lying furthest from the castle as the crow flies
 * (on the classic island, the corner opposite), so the coast has a number for each of its other
 * hexes, and the island's numbers are dealt afresh, a different one on every coastal hex.
 */
export function homeCoast(spec: BoardSpec, rng: Rng) {
  const islands = homeIslands(spec);
  if (islands.length !== 1) throw new Error('Invasion needs a single home island.');
  const [home] = islands;
  const taken = featureHexes(spec);
  const near = neighboursIn(spec);
  const mine = new Set(home);
  const coastal = coastOf(spec, home);
  const coast = home.filter((h) => coastal(h) && !taken.has(h));

  const [cx, cz] = home.reduce(([x, z], h) => {
    const [hx, hz] = hexCenter(h.q, h.r);
    return [x + hx / home.length, z + hz / home.length];
  }, [0, 0]);
  const [sx, sz] = hexCenter(...SIDE_DIRS[3]);
  const lowerLeft = (h: HexSpec) => {
    const [x, z] = hexCenter(h.q, h.r);
    return Math.round(((x - cx) * sx + (z - cz) * sz) * 1e6);
  };
  const open = (h: HexSpec) => 6 - near(h).filter((n) => mine.has(n)).length;
  // (The castle keeps its corner even where the deal put the desert there.)
  const sites = coast.filter((h) => PLAIN.includes(h.terrain) || h.terrain === 'desert');
  if (sites.length === 0) throw new Error('The home island has no coast for a castle.');
  const castle = sites.reduce((best, h) => (open(h) > open(best) || (open(h) === open(best) && lowerLeft(h) > lowerLeft(best)) ? h : best));
  const [kx, kz] = hexCenter(castle.q, castle.r);
  const span = (h: HexSpec) => {
    const [x, z] = hexCenter(h.q, h.r);
    return Math.round(((x - kx) ** 2 + (z - kz) ** 2) * 1e6) * 8 + open(h);
  };
  const far = () => coast.filter((h) => h !== castle).reduce((best, h) => (span(h) > span(best) ? h : best));
  if (castle.terrain === 'desert' && coast.length > 1) swapTiles(castle, far());

  const free = home.filter((h) => !taken.has(h));
  const discs = free.flatMap((h) => h.numbers);
  castle.terrain = 'castle';
  castle.numbers = [];
  spec.castle = [castle.q, castle.r];

  const desert = free.find((h) => h.terrain === 'desert');
  if (desert) {
    const away = far();
    if (away !== desert) swapTiles(desert, away);
  }
  const slots = free.filter((h) => h !== castle && takesNumber(h.terrain));
  bringNumbers(spec, mine, discs, Math.min(slots.filter(coastal).length, NUMBERS.length));
  for (const h of free) h.numbers = [];
  deal(spec, rng, slots, discs);
}

/** Every number a hex can bear. */
const NUMBERS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];

/**
 * Every number has to reach the coast, so raiders land wherever the dice fall. Where the home
 * island's own discs lack one (the islets drew every copy of it), it trades a disc it holds twice
 * for an islet hex's copy, until its discs hold `want` different numbers. The islet takes the
 * repeated number nearest in likelihood, one that isn't red where it can, and a red one only where
 * no red touches it and never on a bounty field: the islets keep their own rules.
 */
function bringNumbers(spec: BoardSpec, home: ReadonlySet<HexSpec>, discs: number[], want: number) {
  const near = neighboursIn(spec);
  const hidden = hiddenKeys(spec);
  const red = (n: number) => n === 6 || n === 8;
  for (const v of NUMBERS) {
    if (new Set(discs).size >= want) return;
    if (discs.includes(v)) continue;
    const islet = spec.hexes.find((h) => !home.has(h) && isLand(h.terrain) && !hidden.has(`${h.q},${h.r}`) && h.numbers.length === 1 && h.numbers[0] === v);
    if (!islet) continue;
    const fits = (n: number) => !red(n) || (islet.terrain !== 'bounty' && !near(islet).some((x) => x.numbers.some(red)));
    const twice = [...new Set(discs)]
      .filter((n) => discs.indexOf(n) !== discs.lastIndexOf(n) && fits(n))
      .sort((a, b) => Number(red(a)) - Number(red(b)) || Math.abs(PIPS[a] - PIPS[v]) - Math.abs(PIPS[b] - PIPS[v]) || a - b);
    if (twice.length === 0) continue;
    islet.numbers = [twice[0]];
    discs.splice(discs.indexOf(twice[0]), 1, v);
  }
}
