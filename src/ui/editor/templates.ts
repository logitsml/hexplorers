// Ready-made starts for the editor: shapes filled, numbered and given harbours afresh each time,
// and the random ones left to the deal of every game.

import { Rng } from '../../engine/rng';
import { SIDE_DIRS } from '../../engine/board';
import { blankMap, fillTerrain, hexagon, hexDistance, normalize, placeHarbours, rectangle, scatterIslets, surroundWithSea, type CustomMap } from '../../engine/maps/custom';
import { fillGaps } from './model';

const seed = () => Math.floor(Math.random() * 1e9);

/** A grid of `radius` with land where `landAt` says, sea elsewhere. */
function shaped(name: string, radius: number, landAt: (q: number, r: number) => boolean): CustomMap {
  return { v: 2, name, hexes: hexagon(radius).map(([q, r]) => ({ q, r, terrain: landAt(q, r) ? 'pasture' : 'sea' })), ports: [] };
}

/** Terrain and numbers dealt now, and harbours round the coast. */
function finish(map: CustomMap): CustomMap {
  const rng = new Rng(seed());
  return placeHarbours(fillTerrain(map, rng), rng);
}

/**
 * The land left to the deal: random hexes, numbers and harbour types every game. (The bag's own
 * desert is the robber's, wherever it falls: a fixed one in the middle as well dealt two.)
 */
function random(map: CustomMap): CustomMap {
  const hexes = map.hexes.map((h) => (h.terrain === 'sea' ? h : { q: h.q, r: h.r, terrain: 'random' as const }));
  return placeHarbours({ ...map, hexes, deal: true }, new Rng(seed()), true);
}

/**
 * A map from its land cells (and the sea cells it names, the open water beyond them filled in
 * round the coast and between the islands), given terrain, numbers and harbours afresh, and
 * centred. `home`: the islands the starting settlements go on, when not the largest.
 */
function laid(name: string, land: [number, number][], home?: [number, number][], sea: [number, number][] = []): CustomMap {
  const cells = new Set(land.map(([q, r]) => `${q},${r}`));
  const hexes = [...land.map(([q, r]) => ({ q, r, terrain: 'pasture' as const })), ...sea.filter(([q, r]) => !cells.has(`${q},${r}`)).map(([q, r]) => ({ q, r, terrain: 'sea' as const }))];
  const map = fillGaps(surroundWithSea({ v: 2, name, hexes, ports: [], ...(home && { home }) }));
  return normalize(finish(map));
}

/** A cell and its first `size - 1` neighbours: a small isle. */
const isle = (q: number, r: number, size: number): [number, number][] => [[q, r], ...SIDE_DIRS.slice(0, size - 1).map(([dq, dr]) => [q + dq, r + dr] as [number, number])];

/** The archipelago's islets, each a sea hex off the home island. */
const ISLETS = new Set(['4,-1', '4,0', '3,1', '-4,1', '-4,2', '0,-4', '1,-4', '2,-4', '-1,4', '0,4']);

interface Template {
  id: string;
  name: string;
  note: string;
  make: () => CustomMap;
}

export const TEMPLATES: Template[] = [
  { id: 'classic', name: 'Classic island', note: '19 hexes, as the base game', make: () => finish(blankMap('Classic island', 3, 2)) },
  { id: 'random', name: 'Random island', note: 'Dealt afresh every game', make: () => random(blankMap('Random island', 3, 2)) },
  { id: 'small', name: 'Small isle', note: '11 hexes, quick games for 3', make: () => finish(shaped('Small isle', 3, (q, r) => hexDistance(q, r) <= 1 || (hexDistance(q, r) === 2 && (((q + 2 * r) % 3) + 3) % 3 === 0))) },
  { id: 'big', name: 'Great island', note: '37 hexes, the most an island holds', make: () => finish(blankMap('Great island', 4, 3)) },
  { id: 'twins', name: 'Twin isles', note: 'Two islands across a strait', make: () => ({ ...finish(shaped('Twin isles', 4, (q, r) => hexDistance(q + 2, r) <= 1 || hexDistance(q - 2, r) <= 1)), home: [[-2, 0], [2, 0]] }) },
  { id: 'lagoon', name: 'Lagoon', note: 'A ring of land round open water', make: () => finish(shaped('Lagoon', 4, (q, r) => hexDistance(q, r) === 2 || hexDistance(q, r) === 3)) },
  { id: 'archipelago', name: 'Archipelago', note: 'A home island and islets, for Sea Lanes', make: () => finish(shaped('Archipelago', 5, (q, r) => hexDistance(q, r) <= 2 || ISLETS.has(`${q},${r}`))) },
  {
    id: 'rectangle',
    name: 'Rectangle',
    note: '7 × 5 hexes, the rows staggered',
    make: () => laid('Rectangle', rectangle(7, 5)),
  },
  {
    id: 'strip',
    name: 'Long island',
    note: 'A strip of three rows, 12 across',
    make: () => laid('Long island', rectangle(12, 3)),
  },
  {
    id: 'atoll',
    name: 'Atoll',
    note: 'A ring of land round a lagoon, with an inlet',
    // (The ring's east side is open sea: ships sail into the lagoon.)
    make: () => laid('Atoll', hexagon(4).filter(([q, r]) => hexDistance(q, r) >= 3 && !(r === 0 && q > 0)), undefined, hexagon(5)),
  },
  {
    id: 'isles',
    name: 'Four isles',
    note: 'Two home islands and two isles, joined by open sea, for Sea Lanes',
    make: () => laid('Four isles', [...hexagon(2).map(([q, r]) => [q - 3, r] as [number, number]), ...hexagon(2).map(([q, r]) => [q + 3, r] as [number, number]), ...hexagon(1).map(([q, r]) => [q, r - 5] as [number, number]), ...hexagon(1).map(([q, r]) => [q, r + 5] as [number, number])], [[-3, 0], [3, 0]]),
  },
  {
    id: 'offshore',
    name: 'Home isle and offshore isles',
    note: 'The classic island and four isles out at sea, for Sea Lanes',
    make: () => laid('Offshore isles', [...hexagon(2), ...isle(5, -3, 3), ...isle(-5, 2, 2), ...isle(-1, 5, 2), ...isle(-3, -2, 1)], [[0, 0]]),
  },
  {
    id: 'fog',
    name: 'Into the fog',
    note: 'Islets face down until found, for Sea Lanes',
    make: () => {
      const rng = new Rng(seed());
      const home = finish(blankMap('Into the fog', 5, 2));
      const map = scatterIslets(home, rng, hexagon(5), 4, true);
      // (The corsair waits far out, on the open sea at the grid's edge.)
      const out = map.hexes.find((h) => h.terrain === 'sea' && hexDistance(h.q, h.r) === 5);
      return out ? { ...map, corsair: [out.q, out.r] as [number, number] } : map;
    },
  },
];
