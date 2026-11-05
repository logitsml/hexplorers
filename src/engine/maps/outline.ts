// Maps drawn as outlines (docs/maps.md, Kinds of map): a picture of which cells are the home island,
// the islets, the fog and the open sea, and nothing more. Everything on it is dealt each game: the
// land from bags in the classic proportions, the number discs and the harbours. The dealer
// (deal.ts) then places every feature by the home island's rules and anneals terrain and numbers
// until they hold, so a new map is a drawing, a name and a points target. Seeded: every draw comes
// from the builder's rng.

import type { BoardSpec, HexSpec, PortSpec } from '../board';
import { hexCenter } from '../board';
import type { Rng } from '../rng';
import type { GameOptions, Terrain } from '../types';
import { type QR, byRow, distance, harbourTypes, hexagon, key, neighbors, placeNumbers, seaAround, tiles } from './util';

export interface Outline {
  /**
   * The map as it looks, north at the top, a line a row: `o` a home hex, `i` an islet's, `?` a
   * face-down hex, `~` open sea kept on the board, and anything else nothing. Cells stand two
   * characters apart and each row half a cell aside from the last, as the hexes lie, so the
   * drawing reads as the board. The sea round the land comes of itself.
   */
  art: string;
  /** The drawing for three seats, where it differs. */
  art3?: string;
  /** How many harbours the home coast takes (nine, as on the classic island, unless said). */
  harbours?: number;
}

/** The classic proportions: 3 hills, 4 forest, 4 pasture, 4 fields and 3 mountains in every 18. */
const SHARE: [Terrain, number][] = [
  ['forest', 4],
  ['pasture', 4],
  ['fields', 4],
  ['hills', 3],
  ['mountains', 3],
];

/** `n` tiles in the classic proportions, the rounding shared out at random. */
function plain(n: number, rng: Rng): Terrain[] {
  const counts = SHARE.map(([t, w]) => ({ t, n: Math.floor((n * w) / 18), rem: ((n * w) / 18) % 1, tie: rng.next() }));
  let short = n - counts.reduce((a, c) => a + c.n, 0);
  for (const c of [...counts].sort((a, b) => b.rem - a.rem || a.tie - b.tie)) if (short-- > 0) c.n++;
  return tiles(Object.fromEntries(counts.map((c) => [c.t, c.n])));
}

/**
 * Number discs for `n` hexes: the classic 18 (one of 2 and 12, two of the others) cut short or
 * carried on in the same order, so any count keeps the numbers about as the classic set has them.
 */
export function discsFor(n: number): number[] {
  const order = [6, 8, 5, 9, 4, 10, 3, 11, 2, 12, 5, 9, 4, 10, 3, 11, 6, 8];
  return Array.from({ length: n }, (_, i) => order[i % order.length]);
}

/** The cells of a drawing, by kind, placed so the home island's middle is the board's. */
export function parseArt(art: string): { home: QR[]; islets: QR[]; fog: QR[]; sea: QR[] } {
  const lines = art.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  const cells: { at: QR; kind: string }[] = [];
  let parity: number | undefined;
  lines.forEach((line, r) => {
    for (let c = 0; c < line.length; c++) {
      const kind = line[c];
      if (!'oi?~'.includes(kind)) continue;
      parity ??= (c - r) & 1;
      if (((c - r) & 1) !== parity) throw new Error(`The cell at row ${r}, column ${c} of a drawn map is half a cell out of line.`);
      cells.push({ at: [(c - r - parity) / 2, r], kind });
    }
  });
  const home = cells.filter((c) => c.kind === 'o');
  if (home.length === 0) throw new Error('A drawn map has no home island.');
  // The home island's middle, rounded to the nearest hex, goes to the board's.
  const [mq, mr] = home.reduce(([q, r], c) => [q + c.at[0] / home.length, r + c.at[1] / home.length], [0, 0]);
  const [dq, dr] = cubeRound(mq, mr);
  const of = (kind: string) => cells.filter((c) => c.kind === kind).map((c): QR => [c.at[0] - dq, c.at[1] - dr]);
  return { home: of('o'), islets: of('i'), fog: of('?'), sea: of('~') };
}

function cubeRound(q: number, r: number): QR {
  const s = -q - r;
  let [rq, rr, rs] = [Math.round(q), Math.round(r), Math.round(s)];
  const [eq, er, es] = [Math.abs(rq - q), Math.abs(rr - r), Math.abs(rs - s)];
  if (eq > er && eq > es) rq = -rr - rs;
  else if (er > es) rr = -rq - rs;
  return [rq, rr];
}

/** The islets of a drawing, as groups of touching cells. */
function groups(cells: QR[]): QR[][] {
  const left = new Map(cells.map((h) => [key(...h), h]));
  const out: QR[][] = [];
  for (const h of cells) {
    if (!left.delete(key(...h))) continue;
    const group = [h];
    for (let i = 0; i < group.length; i++) {
      for (const n of neighbors(group[i])) {
        const k = key(...n);
        const there = left.get(k);
        if (there) {
          left.delete(k);
          group.push(there);
        }
      }
    }
    out.push(group);
  }
  return out;
}

/** A drawn map's cells, by kind. */
export interface Cells {
  home: QR[];
  islets: QR[];
  fog: QR[];
  /** Open sea kept on the board beyond the ring round the land. */
  sea: QR[];
}

/** A drawn map's board as the dealer starts from it (see `fromCells`). */
export const drawnMap = (outline: Outline, options: GameOptions, rng: Rng): BoardSpec =>
  fromCells(parseArt(options.playerCount === 3 && outline.art3 ? outline.art3 : outline.art), outline.harbours ?? 9, rng);

/**
 * A map's board from its cells, as the dealer starts from it. The home island takes the classic bag
 * for its size (a desert in it, where the robber starts), the islets the classic proportions with
 * two bounty fields on two of them (both on the one, where there's only one), and the face-down
 * hexes a stack of their own: a sea tile in six, two bounty fields and the classic land, with discs
 * for what's land. Every numbered hex is dealt a disc, reds apart and off the bounty fields; the
 * harbours' places and kinds are left to the dealer, which needs only how many. Islets are played
 * for First Landing, and fog for Fog.
 */
export function fromCells({ home, islets, fog, sea: open }: Cells, harbours: number, rng: Rng): BoardSpec {
  const terrain = new Map<string, Terrain>();

  const homeTiles = rng.shuffle(['desert' as Terrain, ...plain(home.length - 1, rng)]);
  home.forEach((h, i) => terrain.set(key(...h), homeTiles[i]));

  // Two bounty fields on two islets, or both on the one where there's only one.
  const isles = groups(islets);
  const order = rng.shuffle(isles.map((_, i) => i));
  const bounty = new Set<string>();
  for (let i = 0; i < Math.min(2, islets.length); i++) {
    const islet = isles[order[i % order.length]];
    const free = islet.filter((h) => !bounty.has(key(...h)));
    bounty.add(key(...free[rng.int(free.length)]));
  }
  const isletTiles = rng.shuffle(plain(islets.length - bounty.size, rng));
  for (const h of islets) terrain.set(key(...h), bounty.has(key(...h)) ? 'bounty' : isletTiles.pop()!);

  const seaTiles = Math.round(fog.length / 6);
  const bountyTiles = fog.length > 0 ? Math.min(2, fog.length - seaTiles) : 0;
  const stack = rng.shuffle([...tiles({ sea: seaTiles, bounty: bountyTiles }), ...plain(fog.length - seaTiles - bountyTiles, rng)]);
  fog.forEach((h, i) => terrain.set(key(...h), stack[i]));

  const shown = [...home, ...islets];
  const numbered = shown.filter((h) => terrain.get(key(...h)) !== 'desert');
  const numbers = placeNumbers(rng, numbered, discsFor(numbered.length), bounty);
  const pool = rng.shuffle(discsFor(fog.filter((h) => terrain.get(key(...h)) !== 'sea').length));

  const land = [...shown, ...fog];
  const taken = new Set(land.map((h) => key(...h)));
  const sea = [...new Map([...seaAround(land), ...open.filter((h) => !taken.has(key(...h)))].map((h) => [key(...h), h])).values()].sort(byRow);

  // The corsair waits far out: a sea hex as far from home as the map goes.
  const [cx, cz] = home.reduce(([x, z], h) => {
    const [hx, hz] = hexCenter(...h);
    return [x + hx / home.length, z + hz / home.length];
  }, [0, 0]);
  const far = (h: QR) => Math.round(Math.hypot(hexCenter(...h)[0] - cx, hexCenter(...h)[1] - cz) * 1000);
  const furthest = Math.max(...sea.map(far));
  const outer = sea.filter((h) => far(h) === furthest);

  const hex = (h: QR): HexSpec => {
    const num = numbers.get(key(...h));
    return { q: h[0], r: h[1], terrain: terrain.get(key(...h)) ?? 'sea', numbers: num === undefined ? [] : [num] };
  };
  const sorted = home.slice().sort(byRow);
  // (The harbours' places are the dealer's: here only their count and kinds.)
  const ports: PortSpec[] = harbourTypes(rng, harbours).map((type) => ({ q: sorted[0][0], r: sorted[0][1], side: 0, type }));
  const hidden = fog.slice().sort(byRow);
  const spec: BoardSpec = {
    hexes: [...sorted, ...isles.flatMap((i) => i.slice().sort(byRow)), ...hidden, ...sea].map(hex),
    ports,
    home: sorted[0],
  };
  if (isles.length > 0 || fog.length > 0) spec.corsair = outer[rng.int(outer.length)];
  const objectives: NonNullable<BoardSpec['objectives']> = [];
  if (isles.length > 0) objectives.push({ id: 'firstLanding' });
  if (fog.length > 0) objectives.push({ id: 'fog', hexes: hidden, numbers: pool });
  if (objectives.length) spec.objectives = objectives;
  return spec;
}

/**
 * A wild island: 19 hexes grown from the middle, a new shape every game. It starts from the middle
 * and the six round it and grows a hex at a time onto the sea beside it, each new hex touching at
 * least two of the island's and lying within three steps of the middle. An island that closes a
 * pocket of sea inside itself, has a coast of under 12 hexes or over 15, or fewer than four hexes
 * inland is grown again, so it stays one island with room for a lake, two rivers and the oasis.
 */
export function wildIsland(_options: GameOptions, rng: Rng): BoardSpec {
  const SIZE = 19;
  const RADIUS = 3;
  for (let tries = 0; tries < 200; tries++) {
    const land = new Map<string, QR>([[key(0, 0), [0, 0]], ...neighbors([0, 0]).map((h): [string, QR] => [key(...h), h])]);
    while (land.size < SIZE) {
      const options = new Map<string, QR>();
      for (const h of land.values()) {
        for (const n of neighbors(h)) {
          const k = key(...n);
          if (!land.has(k) && distance(n, [0, 0]) <= RADIUS && neighbors(n).filter((m) => land.has(key(...m))).length >= 2) options.set(k, n);
        }
      }
      const pick = [...options.values()].sort(byRow)[rng.int(options.size)];
      land.set(key(...pick), pick);
    }
    const cells = [...land.values()];
    const inland = cells.filter((h) => neighbors(h).every((n) => land.has(key(...n)))).length;
    if (SIZE - inland < 12 || SIZE - inland > 15 || inland < 4 || enclosed(land, RADIUS)) continue;
    return fromCells({ home: cells.sort(byRow), islets: [], fog: [], sea: [] }, 9, rng);
  }
  throw new Error('No wild island grew to shape.');
}

/** Whether `land` closes a pocket of sea: water within `radius` that can't reach the open sea beyond it. */
function enclosed(land: Map<string, QR>, radius: number): boolean {
  const water = hexagon(radius + 1).filter((h) => !land.has(key(...h)));
  const open = new Set(water.filter((h) => distance(h, [0, 0]) === radius + 1).map((h) => key(...h)));
  const stack = [...open].map((k) => water.find((h) => key(...h) === k)!);
  while (stack.length > 0) {
    for (const n of neighbors(stack.pop()!)) {
      const k = key(...n);
      if (!open.has(k) && !land.has(k) && distance(n, [0, 0]) <= radius + 1) {
        open.add(k);
        stack.push(n);
      }
    }
  }
  return water.some((h) => !open.has(key(...h)));
}
