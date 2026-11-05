// The archipelago: a home island ringed by a channel of open water, and three islets beyond it
// holding the two bounty fields, round the home island's three sides furthest from its castle's
// corner. Played for First Landing (2 points for each player's first settlement on each islet), to
// 14. Seeded: every draw comes from the builder's rng.
//
// Four seats: the classic island (19 hexes) at home, islets of 9 land hexes in all, 27 numbers.
// Three seats: the classic island less three alternate corners (16 hexes), islets of 7, 22
// numbers. In both the islets bring each resource up to its full count, and the corsair starts out
// on the open sea. Nine harbours go round the home coast (the dealer places them).

import { hexCenter, type BoardSpec, type HexSpec, type PortSpec } from '../board';
import type { Rng } from '../rng';
import type { GameOptions, Terrain } from '../types';
import {
  type QR,
  type Slot,
  byRow,
  coastSlots,
  discs,
  distance,
  harbourTypes,
  hexagon,
  key,
  neighbor,
  neighbors,
  placeNumbers,
  ring,
  seaAround,
  spreadSlots,
  tiles,
} from './util';
import { castleCorner } from './shape';

const HOME_TILES: Record<3 | 4, Terrain[]> = {
  4: tiles({ hills: 3, forest: 4, pasture: 4, fields: 4, mountains: 3, desert: 1 }),
  3: tiles({ hills: 3, forest: 3, pasture: 3, fields: 3, mountains: 3, desert: 1 }),
};

/** The islets' land, the two bounty fields aside. */
const ISLET_TILES: Record<3 | 4, Terrain[]> = {
  4: tiles({ hills: 2, forest: 1, pasture: 1, fields: 1, mountains: 2 }),
  3: tiles({ hills: 1, pasture: 2, fields: 1, mountains: 1 }),
};

/** How the islets' land splits into three islets of two to four hexes. */
const ISLET_SIZES: Record<3 | 4, number[][]> = {
  4: [
    [3, 3, 3],
    [2, 3, 4],
    [4, 3, 2],
    [3, 2, 4],
  ],
  3: [
    [2, 2, 3],
    [2, 3, 2],
    [3, 2, 2],
  ],
};

const DISCS: Record<3 | 4, number[]> = {
  4: discs({ 2: 2, 3: 3, 4: 3, 5: 3, 6: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 1 }),
  3: discs({ 2: 1, 3: 2, 4: 3, 5: 3, 6: 2, 8: 3, 9: 2, 10: 3, 11: 2, 12: 1 }),
};

/** The ring the islets stand on: the channel (ring 3) keeps them off the home island. */
const ISLET_RING = 4;

/**
 * The islets: round the three sides
 * of the home island furthest from its castle's corner, on the half of the islet ring facing away
 * from it, in order along it with at least one sea hex between them.
 */
function farIslets(rng: Rng, sizes: number[], home: QR[]): QR[][] {
  const hexes = home.map(([q, r]) => ({ q, r, terrain: 'hills' as Terrain, numbers: [] }));
  const corner = castleCorner(hexes)!;
  const [cx, cz] = hexes.reduce(([x, z], h) => {
    const [hx, hz] = hexCenter(h.q, h.r);
    return [x + hx / hexes.length, z + hz / hexes.length];
  }, [0, 0]);
  const bearing = ([q, r]: QR) => {
    const [x, z] = hexCenter(q, r);
    return (Math.atan2(z - cz, x - cx) * 180) / Math.PI;
  };
  const turn = (a: number, b: number) => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360));
  const away = bearing([corner.q, corner.r]);
  const around = ring(ISLET_RING);
  const far = around.map((h) => turn(bearing(h), away) >= 90);
  // (The far half as one run along the ring, from where it begins.)
  const begin = far.findIndex((f, i) => f && !far[(i + around.length - 1) % around.length]);
  const arc = Array.from({ length: far.filter(Boolean).length }, (_, i) => around[(begin + i) % around.length]);

  const bulges = sizes.map((size) => size >= 3 && rng.next() < 0.5);
  const lengths = sizes.map((size, k) => (bulges[k] ? size - 1 : size));
  const gaps = [0, 1, 1, 0];
  for (let slack = arc.length - lengths.reduce((a, b) => a + b, 0) - 2; slack > 0; slack--) gaps[rng.int(4)]++;
  let at = gaps[0];
  return sizes.map((_, k) => {
    const hexes = arc.slice(at, at + lengths[k]);
    at += lengths[k] + gaps[k + 1];
    if (bulges[k]) {
      // A hex beyond the ring touching two neighbouring hexes of the arc.
      const i = rng.int(hexes.length - 1);
      const out = neighbors(hexes[i]).find((n) => distance(n, [0, 0]) === ISLET_RING + 1 && distance(n, hexes[i + 1]) === 1);
      if (out) hexes.push(out);
    }
    return hexes;
  });
}

/** No two landmasses touch: the islets and home stay separate islands. */
function apart(groups: QR[][]): boolean {
  for (let a = 0; a < groups.length; a++) {
    for (let b = a + 1; b < groups.length; b++) {
      if (groups[a].some((h) => groups[b].some((g) => distance(h, g) <= 1))) return false;
    }
  }
  return true;
}

export function archipelago(options: GameOptions, rng: Rng): BoardSpec {
  const n = options.playerCount === 3 ? 3 : 4;

  // Home: the classic island; with three seats, three alternate corners are open water.
  let home = hexagon(2);
  if (n === 3) {
    const turn = rng.int(2);
    const corners = [0, 2, 4].map((i) => key(...neighbor(neighbor([0, 0], (i + turn) % 6), (i + turn) % 6)));
    home = home.filter((h) => !corners.includes(key(...h)));
  }
  const sizes = ISLET_SIZES[n][rng.int(ISLET_SIZES[n].length)];
  const lay = () => farIslets(rng, rng.shuffle(sizes.slice()), home);
  let islets = lay();
  for (let tries = 0; !apart([home, ...islets]); tries++) {
    if (tries > 50) throw new Error('The islets would not keep apart.');
    islets = lay();
  }

  // Terrain: home from its own bag; the bounty fields on two different islets, the rest shuffled.
  const terrain = new Map<string, Terrain>();
  const homeTiles = rng.shuffle(HOME_TILES[n].slice());
  home.forEach((h, i) => terrain.set(key(...h), homeTiles[i]));
  const withBounty = rng.shuffle([0, 1, 2]).slice(0, 2);
  const isletTiles = rng.shuffle(ISLET_TILES[n].slice());
  islets.forEach((islet, k) => {
    const bountyAt = withBounty.includes(k) ? rng.int(islet.length) : -1;
    islet.forEach((h, i) => terrain.set(key(...h), i === bountyAt ? 'bounty' : isletTiles.pop()!));
  });

  const land = [...home, ...islets.flat()];
  const numbered = land.filter((h) => terrain.get(key(...h)) !== 'desert');
  const bounty = new Set(land.filter((h) => terrain.get(key(...h)) === 'bounty').map((h) => key(...h)));
  const numbers = placeNumbers(rng, numbered, DISCS[n], bounty);

  const sea = seaAround(land);
  const seaKeys = new Set(sea.map((h) => key(...h)));

  // Harbours: spread round the home coast (never on the desert), where the dealer places them afresh.
  const desert = home.find((h) => terrain.get(key(...h)) === 'desert')!;
  const homeSlots = coastSlots(home, seaKeys).filter((s) => key(...s.at) !== key(...desert));
  const slots: Slot[] = spreadSlots(rng, homeSlots, 9);
  const types = harbourTypes(rng, slots.length);
  const ports: PortSpec[] = slots.map((s, i) => ({ q: s.at[0], r: s.at[1], side: s.side, type: types[i] }));

  // The corsair waits far out: a sea hex as far from home as the map goes.
  const far = Math.max(...sea.map((h) => distance(h, [0, 0])));
  const outer = sea.filter((h) => distance(h, [0, 0]) === far);
  const corsair = outer[rng.int(outer.length)];

  const hex = (h: QR): HexSpec => {
    const t = terrain.get(key(...h)) ?? 'sea';
    const num = numbers.get(key(...h));
    return { q: h[0], r: h[1], terrain: t, numbers: num === undefined ? [] : [num] };
  };
  return {
    hexes: [...home.slice().sort(byRow), ...islets.flatMap((i) => i.slice().sort(byRow)), ...sea].map(hex),
    ports,
    home: [0, 0],
    corsair,
    objectives: [{ id: 'firstLanding' }],
  };
}
