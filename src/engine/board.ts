import { BEGINNER_PORTS, NUMBER_DISCS, SPIRAL_SEQUENCE, STANDARD_PORTS, TERRAIN_COUNTS, isLand } from './constants';
import { Rng } from './rng';
import type { Board, BoardFeatures, Edge, Hex, Island, MapObjective, Port, PortType, Terrain, Vertex } from './types';

export const SQRT3 = Math.sqrt(3);

/** Axial directions for the six sides, clockwise starting at NE: NE, E, SE, SW, W, NW. */
export const SIDE_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
];

/** Corner offsets for a pointy-top hex of circumradius 1, clockwise from the top (N, NE, SE, S, SW, NW). */
export const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = Array.from({ length: 6 }, (_, i) => {
  const a = ((-90 + 60 * i) * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)] as const;
});

export function hexCenter(q: number, r: number): [number, number] {
  return [SQRT3 * (q + r / 2), 1.5 * r];
}

/** The cell under a point on the board (world x, z). */
export function cellAt(x: number, z: number): [number, number] {
  const r = z / 1.5;
  const q = x / SQRT3 - r / 2;
  // (Cube rounding: the nearest cell centre.)
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(-q - r);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - (-q - r));
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

const BOARD_RADIUS = 2;

/** All axial coordinates of the 19-hex island, row by row (top to bottom, left to right). */
export function islandCoords(): [number, number][] {
  const out: [number, number][] = [];
  for (let r = -BOARD_RADIUS; r <= BOARD_RADIUS; r++) {
    const qStart = Math.max(-BOARD_RADIUS, -BOARD_RADIUS - r);
    const qEnd = Math.min(BOARD_RADIUS, BOARD_RADIUS - r);
    for (let q = qStart; q <= qEnd; q++) out.push([q, r]);
  }
  return out;
}

const coordKey = (q: number, r: number) => `${q},${r}`;

/** Row/column (1-based, rows top to bottom) to axial coordinates. */
export function rowColToAxial(row: number, col: number): [number, number] {
  const r = row - 3;
  const qStart = Math.max(-BOARD_RADIUS, -BOARD_RADIUS - r);
  return [qStart + col - 1, r];
}

/** Hex rings walked counter-clockwise (as seen from above with north up) starting at the given corner direction. */
export function spiralOrder(startCorner: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = BOARD_RADIUS; k >= 1; k--) {
    let q = SIDE_DIRS[startCorner][0] * k;
    let r = SIDE_DIRS[startCorner][1] * k;
    for (let i = 0; i < 6; i++) {
      const d = SIDE_DIRS[(startCorner + 4 - i + 6) % 6];
      for (let s = 0; s < k; s++) {
        out.push([q, r]);
        q += d[0];
        r += d[1];
      }
    }
  }
  out.push([0, 0]);
  return out;
}

/** Port slots (hex row/col and side) clockwise from the upper-left. */
const PORT_SLOTS: ReadonlyArray<{ row: number; col: number; side: number }> = [
  { row: 1, col: 1, side: 5 },
  { row: 1, col: 2, side: 0 },
  { row: 2, col: 4, side: 0 },
  { row: 3, col: 5, side: 1 },
  { row: 4, col: 4, side: 2 },
  { row: 5, col: 2, side: 2 },
  { row: 5, col: 1, side: 3 },
  { row: 4, col: 1, side: 4 },
  { row: 2, col: 1, side: 4 },
];

/**
 * The beginner island, rows top to bottom: our own, chosen by search for a friendly first game.
 * The desert (and the robber) sit in the middle, no number or terrain repeats side by side
 * except two pairs of terrain, and no 6 touches an 8. Each resource's production is in
 * proportion to its tiles.
 */
export const BEGINNER_LAYOUT: ReadonlyArray<ReadonlyArray<[Terrain, number | null]>> = [
  [['forest', 10], ['pasture', 3], ['hills', 2]],
  [['mountains', 9], ['hills', 5], ['mountains', 11], ['forest', 8]],
  [['pasture', 6], ['fields', 12], ['desert', null], ['fields', 4], ['pasture', 5]],
  [['forest', 4], ['hills', 6], ['pasture', 9], ['forest', 11]],
  [['mountains', 3], ['fields', 10], ['fields', 8]],
];

interface LayoutSpec {
  terrain: Map<string, Terrain>;
  numbers: Map<string, number | null>;
  ports: PortType[];
}

export function beginnerLayout(): LayoutSpec {
  const terrain = new Map<string, Terrain>();
  const numbers = new Map<string, number | null>();
  BEGINNER_LAYOUT.forEach((row, ri) =>
    row.forEach(([t, n], ci) => {
      const [q, r] = rowColToAxial(ri + 1, ci + 1);
      terrain.set(coordKey(q, r), t);
      numbers.set(coordKey(q, r), n);
    }),
  );
  return { terrain, numbers, ports: [...BEGINNER_PORTS] };
}

/** A beginner starting settlement as the hexes round its corner, and its road as the two hexes either side, all as [row, col]. */
export interface BeginnerSpot {
  settle: [number, number][];
  road: [[number, number], [number, number]];
}

/**
 * Rules 1's beginner starting positions by seat (the second of each pair brings the starting
 * cards). Every seat touches all five resources with nearly equal production (20 or 21 dots),
 * but in play they were far from even: seat 3 won 47% of all-hard games, seat 1 only 11%.
 */
export const BEGINNER_POSITIONS_V1: BeginnerSpot[][] = [
  [
    { settle: [[2, 4], [3, 4], [3, 5]], road: [[3, 4], [3, 5]] },
    { settle: [[1, 2], [2, 2], [2, 3]], road: [[1, 2], [2, 2]] },
  ],
  [
    { settle: [[4, 2], [4, 3], [5, 2]], road: [[4, 3], [5, 2]] },
    { settle: [[1, 3], [2, 3], [2, 4]], road: [[1, 3], [2, 4]] },
  ],
  [
    { settle: [[1, 1], [2, 1], [2, 2]], road: [[1, 1], [2, 2]] },
    { settle: [[2, 1], [3, 1], [3, 2]], road: [[3, 1], [3, 2]] },
  ],
  [
    { settle: [[4, 3], [4, 4], [5, 3]], road: [[4, 3], [5, 3]] },
    { settle: [[4, 1], [4, 2], [5, 1]], road: [[4, 1], [4, 2]] },
  ],
];

/**
 * Rules 2's positions: the same eight spots, with two roads turned (found by searching bot-game win
 * rates), which narrows the spread between positions; setup.ts turns them round the seats from game
 * to game, so no seat, and so not the person in seat 0, keeps the weakest one.
 */
export const BEGINNER_POSITIONS_V2: BeginnerSpot[][] = [
  [
    { settle: [[2, 4], [3, 4], [3, 5]], road: [[2, 4], [3, 5]] },
    { settle: [[1, 2], [2, 2], [2, 3]], road: [[1, 2], [2, 2]] },
  ],
  [
    { settle: [[4, 2], [4, 3], [5, 2]], road: [[4, 3], [5, 2]] },
    { settle: [[1, 3], [2, 3], [2, 4]], road: [[1, 3], [2, 4]] },
  ],
  [
    { settle: [[1, 1], [2, 1], [2, 2]], road: [[1, 1], [2, 2]] },
    { settle: [[2, 1], [3, 1], [3, 2]], road: [[3, 1], [3, 2]] },
  ],
  [
    { settle: [[4, 3], [4, 4], [5, 3]], road: [[4, 3], [4, 4]] },
    { settle: [[4, 1], [4, 2], [5, 1]], road: [[4, 1], [4, 2]] },
  ],
];

/**
 * Every beginner starting road, as its two hexes (axial), under either rules: the rivers keep their
 * crossings off them, so the set-up's roads never stand on a bridge site.
 */
export const BEGINNER_ROADS: [[number, number], [number, number]][] = [...BEGINNER_POSITIONS_V1, ...BEGINNER_POSITIONS_V2].flat().map((spot) => [rowColToAxial(...spot.road[0]), rowColToAxial(...spot.road[1])]);

function redAdjacent(numbers: Map<string, number | null>): boolean {
  for (const [key, n] of numbers) {
    if (n !== 6 && n !== 8) continue;
    const [q, r] = key.split(',').map(Number);
    for (const [dq, dr] of SIDE_DIRS) {
      const m = numbers.get(coordKey(q + dq, r + dr));
      if (m === 6 || m === 8) return true;
    }
  }
  return false;
}

export function randomLayout(rng: Rng, numberPlacement: 'spiral' | 'balanced'): LayoutSpec {
  const tiles: Terrain[] = [];
  for (const [t, n] of Object.entries(TERRAIN_COUNTS) as [Terrain, number][]) for (let i = 0; i < n; i++) tiles.push(t);
  rng.shuffle(tiles);
  const coords = islandCoords();
  const terrain = new Map<string, Terrain>();
  coords.forEach(([q, r], i) => terrain.set(coordKey(q, r), tiles[i]));

  let numbers = new Map<string, number | null>();
  if (numberPlacement === 'spiral') {
    const order = spiralOrder(rng.int(6));
    let k = 0;
    for (const [q, r] of order) {
      const key = coordKey(q, r);
      numbers.set(key, terrain.get(key) === 'desert' ? null : SPIRAL_SEQUENCE[k++]);
    }
  } else {
    for (let attempt = 0; attempt < 2000; attempt++) {
      const discs = rng.shuffle([...NUMBER_DISCS]);
      numbers = new Map();
      let k = 0;
      for (const [q, r] of coords) {
        const key = coordKey(q, r);
        numbers.set(key, terrain.get(key) === 'desert' ? null : discs[k++]);
      }
      if (!redAdjacent(numbers)) break;
    }
  }
  return { terrain, numbers, ports: rng.shuffle([...STANDARD_PORTS]) };
}

/** One hex of a board to build: land first, then sea (ids follow this order). */
export interface HexSpec {
  q: number;
  r: number;
  terrain: Terrain;
  numbers: number[];
  well?: boolean;
}

/** A harbour on side `side` (0-5: NE, E, SE, SW, W, NW) of the hex at (q, r). */
export interface PortSpec {
  q: number;
  r: number;
  side: number;
  type: PortType;
}

/** Everything a board is built from. The classic island is one (see classicSpec); module maps are others. */
export interface BoardSpec {
  hexes: HexSpec[];
  ports: PortSpec[];
  /** A hex on the home island (default: the largest landmass), or one on each home island where a map starts on several. */
  home?: [number, number] | [number, number][];
  /** Rivers as hex paths from source to mouth; the mouth is the last hex, and `mouthSide` its side that meets the sea. */
  rivers?: { path: [number, number][]; mouthSide: number }[];
  castle?: [number, number];
  /** The oasis and the corners (0-5, clockwise from the top) its trains start from. */
  oasis?: { at: [number, number]; corners: number[] };
  /** Where the robber starts, when not on the desert. */
  robber?: [number, number];
  /** The sea hex the corsair starts on (Sea Lanes). */
  corsair?: [number, number];
  /** The map's objectives (see MapObjective), with their hexes as coordinates. */
  objectives?: { id: string; hexes?: [number, number][]; numbers?: number[] }[];
  /** Number the hexes in the spec's own order, land and sea together: a board rebuilt from another (specOfBoard) keeps its ids. */
  keepOrder?: boolean;
}

/** The classic island as a board spec, in the hex and port order the classic board has always had. */
export function classicSpec(layout: LayoutSpec): BoardSpec {
  const hexes = islandCoords().map(([q, r]) => {
    const key = coordKey(q, r);
    const n = layout.numbers.get(key) ?? null;
    return { q, r, terrain: layout.terrain.get(key)!, numbers: n === null ? [] : [n] };
  });
  const ports = PORT_SLOTS.map((slot, id) => {
    const [q, r] = rowColToAxial(slot.row, slot.col);
    return { q, r, side: slot.side, type: layout.ports[id] };
  });
  return { hexes, ports };
}

/**
 * Build full topology (hexes, intersections, edges, ports, islands, features) from a spec. Land
 * hexes are numbered first, in the spec's order, and the sea after them: the renderer keeps
 * per-tile tables by hex id for the land alone (the classic island, all land, is unchanged).
 */
export function buildBoard(given: BoardSpec): Board {
  const spec = given.keepOrder ? given : { ...given, hexes: [...given.hexes.filter((h) => isLand(h.terrain)), ...given.hexes.filter((h) => !isLand(h.terrain))] };
  const hexIndex = new Map<string, number>();
  spec.hexes.forEach(({ q, r }, i) => {
    const key = coordKey(q, r);
    if (hexIndex.has(key)) throw new Error(`Two hexes at ${key}.`);
    hexIndex.set(key, i);
  });

  const vertices: Vertex[] = [];
  const vertexIndex = new Map<string, number>();
  const edges: Edge[] = [];
  const edgeIndex = new Map<string, number>();

  const vKey = (x: number, z: number) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;

  const hexes: Hex[] = spec.hexes.map(({ q, r, terrain, numbers, well }, id) => {
    const [x, z] = hexCenter(q, r);
    const hexVerts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const vx = x + CORNER_OFFSETS[i][0];
      const vz = z + CORNER_OFFSETS[i][1];
      const k = vKey(vx, vz);
      let vid = vertexIndex.get(k);
      if (vid === undefined) {
        vid = vertices.length;
        vertexIndex.set(k, vid);
        vertices.push({ id: vid, x: vx, z: vz, hexes: [], edges: [], neighbors: [], port: null, land: false });
      }
      vertices[vid].hexes.push(id);
      hexVerts.push(vid);
    }
    const hexEdges: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = hexVerts[i];
      const b = hexVerts[(i + 1) % 6];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      let eid = edgeIndex.get(k);
      if (eid === undefined) {
        eid = edges.length;
        edgeIndex.set(k, eid);
        edges.push({ id: eid, a: Math.min(a, b), b: Math.max(a, b), hexes: [], coastal: false, sea: false, land: false });
      }
      edges[eid].hexes.push(id);
      hexEdges.push(eid);
    }
    const neighbors: number[] = [];
    for (const [dq, dr] of SIDE_DIRS) {
      const n = hexIndex.get(coordKey(q + dq, r + dr));
      if (n !== undefined) neighbors.push(n);
    }
    const hex: Hex = { id, q, r, x, z, terrain, numbers: [...numbers], vertices: hexVerts, edges: hexEdges, neighbors, island: -1 };
    if (well) hex.well = true;
    return hex;
  });

  for (const e of edges) {
    const land = e.hexes.filter((h) => isLand(hexes[h].terrain)).length;
    e.coastal = land === 1;
    e.land = land > 0;
    e.sea = e.hexes.some((h) => hexes[h].terrain === 'sea');
    vertices[e.a].edges.push(e.id);
    vertices[e.b].edges.push(e.id);
    vertices[e.a].neighbors.push(e.b);
    vertices[e.b].neighbors.push(e.a);
  }
  for (const v of vertices) v.land = v.hexes.some((h) => isLand(hexes[h].terrain));

  // Landmasses: land hexes joined side to side.
  const islands: Island[] = [];
  for (const h of hexes) {
    if (!isLand(h.terrain) || h.island >= 0) continue;
    const island: Island = { id: islands.length, hexes: [], home: false };
    const stack = [h.id];
    h.island = island.id;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      island.hexes.push(cur);
      for (const n of hexes[cur].neighbors) {
        if (isLand(hexes[n].terrain) && hexes[n].island < 0) {
          hexes[n].island = island.id;
          stack.push(n);
        }
      }
    }
    island.hexes.sort((a, b) => a - b);
    islands.push(island);
  }
  const at = ([q, r]: [number, number]) => {
    const id = hexIndex.get(coordKey(q, r));
    if (id === undefined) throw new Error(`No hex at ${q},${r}.`);
    return id;
  };

  const homes = spec.home === undefined ? [] : typeof spec.home[0] === 'number' ? [spec.home as [number, number]] : (spec.home as [number, number][]);
  if (homes.length === 0) {
    const largest = islands.reduce((best, i) => (i.hexes.length > islands[best].hexes.length ? i.id : best), 0);
    if (islands[largest]) islands[largest].home = true;
  }
  for (const h of homes) {
    const island = islands[hexes[at(h)].island];
    if (!island) throw new Error(`The home hex ${h} is not land.`);
    island.home = true;
  }

  const ports: Port[] = spec.ports.map((p, id) => {
    const hex = hexes[at([p.q, p.r])];
    const edge = hex.edges[p.side];
    const verts: [number, number] = [hex.vertices[p.side], hex.vertices[(p.side + 1) % 6]];
    for (const v of verts) vertices[v].port = p.type;
    return { id, type: p.type, edge, hex: hex.id, side: p.side, vertices: verts };
  });

  const features: BoardFeatures = {};
  if (spec.rivers) {
    features.rivers = spec.rivers.map(({ path, mouthSide }) => {
      const ids = path.map(at);
      const bridgeSites: number[] = [];
      for (let i = 0; i + 1 < ids.length; i++) {
        const e = edgeBetween({ hexes } as Board, ids[i], ids[i + 1]);
        if (e === undefined) throw new Error('A river must run through neighbouring hexes.');
        bridgeSites.push(e);
      }
      bridgeSites.push(hexes[ids[ids.length - 1]].edges[mouthSide]);
      return { hexes: ids, bridgeSites };
    });
  }
  if (spec.castle) features.castle = at(spec.castle);
  if (spec.oasis) {
    const hex = at(spec.oasis.at);
    features.oasis = { hex, origins: spec.oasis.corners.map((c) => hexes[hex].vertices[c]) };
  }
  if (spec.robber) features.robber = at(spec.robber);
  if (spec.corsair) features.corsair = at(spec.corsair);

  const desert = hexes.find((h) => h.terrain === 'desert');
  const board: Board = { hexes, vertices, edges, ports, desertHex: desert ? desert.id : null, islands, features };
  if (spec.objectives) {
    board.objectives = spec.objectives.map((o) => {
      const out: MapObjective = { id: o.id };
      if (o.hexes) out.hexes = o.hexes.map(at);
      if (o.numbers) out.numbers = [...o.numbers];
      return out;
    });
  }
  return board;
}

/**
 * The spec a board is built from, with `terrain` overriding some hexes' terrain (and taking their
 * numbers and wells). Building it gives the same hexes, intersections, edges and harbours, by the
 * same ids, with everything derived from terrain worked out afresh: how a board looks to someone
 * who can't see every hex (Fog's face-down hexes shown as open water).
 */
export function specOfBoard(board: Board, terrain: ReadonlyMap<number, Terrain> = new Map()): BoardSpec {
  const qr = (h: number): [number, number] => [board.hexes[h].q, board.hexes[h].r];
  const spec: BoardSpec = {
    hexes: board.hexes.map((h) => {
      const t = terrain.get(h.id);
      if (t !== undefined) return { q: h.q, r: h.r, terrain: t, numbers: [] };
      const hs: HexSpec = { q: h.q, r: h.r, terrain: h.terrain, numbers: [...h.numbers] };
      if (h.well) hs.well = true;
      return hs;
    }),
    ports: board.ports.map((p) => ({ q: board.hexes[p.hex].q, r: board.hexes[p.hex].r, side: p.side, type: p.type })),
    // (Every id stays where it was, though some land now shows as sea.)
    keepOrder: true,
  };
  // (Each home island by a hex of it that stays land.)
  const homes = board.islands.filter((i) => i.home).map((i) => i.hexes.find((h) => !terrain.has(h) || isLand(terrain.get(h)!)));
  if (homes.every((h) => h !== undefined)) spec.home = homes.map((h) => qr(h!));
  const f = board.features;
  if (f.rivers) {
    spec.rivers = f.rivers.map((river) => {
      const mouth = river.hexes[river.hexes.length - 1];
      return { path: river.hexes.map(qr), mouthSide: board.hexes[mouth].edges.indexOf(river.bridgeSites[river.bridgeSites.length - 1]) };
    });
  }
  if (f.castle !== undefined) spec.castle = qr(f.castle);
  if (f.oasis) spec.oasis = { at: qr(f.oasis.hex), corners: f.oasis.origins.map((v) => board.hexes[f.oasis!.hex].vertices.indexOf(v)) };
  if (f.robber !== undefined) spec.robber = qr(f.robber);
  if (f.corsair !== undefined) spec.corsair = qr(f.corsair);
  if (board.objectives) {
    spec.objectives = board.objectives.map((o) => ({ id: o.id, ...(o.hexes && { hexes: o.hexes.map(qr) }), ...(o.numbers && { numbers: [...o.numbers] }) }));
  }
  return spec;
}

export function hexAt(board: Board, q: number, r: number): Hex | undefined {
  return board.hexes.find((h) => h.q === q && h.r === r);
}

/** Intersection shared by the three given hexes (or two hexes on the coast). */
export function vertexBetween(board: Board, hexIds: number[]): number | undefined {
  const sets = hexIds.map((id) => new Set(board.hexes[id].vertices));
  return board.hexes[hexIds[0]].vertices.find((v) => sets.every((s) => s.has(v)));
}

/** Edge shared by two adjacent hexes. */
export function edgeBetween(board: Board, a: number, b: number): number | undefined {
  const sb = new Set(board.hexes[b].edges);
  return board.hexes[a].edges.find((e) => sb.has(e));
}
