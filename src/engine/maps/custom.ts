// Custom maps: an island drawn in the map editor, carried whole in the game's options (so a save or
// a replay holds the map it was played on, however the editor's copy changes later).
//
// A map is a template as much as a layout. Each cell holds a terrain, or 'random' for one drawn
// from the map's bag; producing hexes hold a number, or are dealt one; harbours hold a type, or
// 'random'. The deal is made from the deal's own salted stream when the game is created
// (customSpec), so the same seed always deals the same island. Cells may lie face down under the
// fog (Sea Lanes), and the map may carry the expansions' features itself: bounty fields, a lake
// and fishing grounds, rivers with their swamps, an oasis, a castle, oil wells, the corsair's
// start and the home islands. The expansions in play whose features it doesn't carry shape its
// home island as they do the classic one's (rule 10). checkCustomMap says whether a game on it
// can be played to its target, and why not.

import { NUMBER_DISCS, PIPS, PIECES, TERRAIN_RESOURCE, isLand } from '../constants';
import { buildBoard, cellAt, hexCenter, SIDE_DIRS, type BoardSpec, type HexSpec } from '../board';
import type { Board, ModuleId, PortType, Resource, Terrain } from '../types';
import { RESOURCES } from '../types';
import { Rng } from '../rng';

/** The base game's terrain, as the editor offers it first. */
export const CUSTOM_TERRAINS = ['forest', 'pasture', 'fields', 'hills', 'mountains', 'desert', 'sea'] as const;
/** The expansions' terrain. */
const FEATURE_TERRAINS = ['bounty', 'lake', 'swamp', 'oasis', 'castle'] as const;
export type CustomTerrain = (typeof CUSTOM_TERRAINS)[number] | (typeof FEATURE_TERRAINS)[number];
/** What a cell holds: a terrain, or one drawn from the bag at the start of each game. */
export type CellTerrain = CustomTerrain | 'random';
const TERRAINS: readonly CellTerrain[] = [...CUSTOM_TERRAINS, ...FEATURE_TERRAINS, 'random'];

/** The expansion each feature belongs to (and only plays a part with). */
export const FEATURE_MODULE: Record<(typeof FEATURE_TERRAINS)[number] | 'well' | 'ground' | 'river' | 'corsair' | 'fog', ModuleId> = {
  bounty: 'sea',
  lake: 'fisheries',
  ground: 'fisheries',
  swamp: 'rivers',
  river: 'rivers',
  oasis: 'caravans',
  castle: 'invasion',
  well: 'oil',
  corsair: 'sea',
  fog: 'sea',
};

/** A harbour's type, or one drawn from the classic mix at the start. */
export type CustomPortType = PortType | 'random';
export const PORT_TYPES: readonly CustomPortType[] = ['any', 'brick', 'wood', 'wool', 'wheat', 'ore', 'random'];

/** The numbers a hex may bear. */
export const CUSTOM_NUMBERS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12] as const;
/** A lake's four printed numbers (Fisheries). */
export const LAKE_NUMBERS = [2, 3, 11, 12];
/** The oasis's train origins: upper-left, upper-right and bottom corners (Wagon Trains' ORIGIN_CORNERS). */
const OASIS_CORNERS = [5, 1, 3];

/** Land tiles the island's shaders hold (render/board/materials.ts takes its MAX_TILES from this). */
export const MAX_LAND = 61;
/** How far from the middle (0,0) a hex may lie. The hex-distance bound the carried board's check holds too (stored.ts). */
export const MAX_REACH = 16;
/** The most hexes a map lists, however it's spread (a reach of 16 would allow 817). Equal to the carried board's. */
export const MAX_HEXES = 600;
/** The most home islands, rivers and hexes in one river a map may mark (the carried board's check, stored.ts, holds the same). */
export const MAX_HOMES = 4;
export const MAX_RIVERS = 4;
export const MAX_RIVER_LEN = 8;
/** The limits of format 2, which clients from before the grid grew still read: a map beyond them is written as format 3. */
const V2_REACH = 5;
const V2_LAND = 37;

export interface CustomHex {
  q: number;
  r: number;
  terrain: CellTerrain;
  /** On a producing hex or a bounty field, its fixed number (dealt at the start when absent and `deal` is on); on the sea, a fishing ground's. */
  number?: number;
  /** An oil well (Oil). */
  well?: true;
  /** Face down under the fog until explored (Sea Lanes). */
  hidden?: true;
}

interface CustomPort {
  q: number;
  r: number;
  side: number;
  type: CustomPortType;
}

interface CustomRiver {
  /** Hexes from the spring to the mouth, each beside the last; the mouth a swamp on the coast. */
  path: [number, number][];
}

export interface CustomMap {
  /** The format: 3 only for a map beyond format 2's limits (reach 5, 37 land hexes), so an older client refuses it cleanly. */
  v: 1 | 2 | 3;
  name: string;
  hexes: CustomHex[];
  /** Each on side `side` (0-5: NE, E, SE, SW, W, NW) of a land hex, facing the sea or the map's edge. */
  ports: CustomPort[];
  /** The robber's starting hex, when not the desert. */
  robber?: [number, number];
  /** The corsair's starting sea hex (Sea Lanes). */
  corsair?: [number, number];
  /** A hex on each home island (the largest landmass when none is named). */
  home?: [number, number][];
  rivers?: CustomRiver[];
  /** The bag the random cells are drawn from (the classic proportions when absent). */
  bag?: Partial<Record<CustomTerrain, number>>;
  /** Deal numbers at the start to every producing hex without one. */
  deal?: boolean;
}

const key = (q: number, r: number) => `${q},${r}`;
export const hexDistance = (q: number, r: number) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
/** Terrain that takes one number disc: the five that produce, and the bounty field. */
export const numbered = (t: CellTerrain) => t !== 'random' && (TERRAIN_RESOURCE[t] !== null || t === 'bounty');
const produces = (t: Terrain) => TERRAIN_RESOURCE[t] !== null;
/** "a", "a or b", "a, b or c". */
const listed = (xs: readonly string[], and: string) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
const neighbours = (q: number, r: number): [number, number][] => SIDE_DIRS.map(([dq, dr]) => [q + dq, r + dr]);
const isRed = (n: number) => n === 6 || n === 8;

/** The format a map is written in: 2, or 3 when it reaches past radius 5 or holds more than 37 land hexes (a random cell may be dealt land, so counts as land). */
export function versionOf(hexes: readonly { q: number; r: number; terrain: CellTerrain }[]): 2 | 3 {
  const land = hexes.filter((h) => h.terrain !== 'sea').length;
  return land > V2_LAND || hexes.some((h) => hexDistance(h.q, h.r) > V2_REACH) ? 3 : 2;
}

/**
 * A map from anything (an imported file, a save): the map, cleaned of what doesn't belong (a
 * number where none goes, a flag that means nothing), or null when it isn't a map at all. Problems
 * a map can be saved with (a harbour off the coast) are kept for the check to report.
 */
export function parseCustomMap(x: unknown): CustomMap | null {
  if (!x || typeof x !== 'object') return null;
  const m = x as Partial<CustomMap>;
  if ((m.v !== 1 && m.v !== 2 && m.v !== 3) || typeof m.name !== 'string' || !Array.isArray(m.hexes) || !Array.isArray(m.ports)) return null;
  const isInt = (n: unknown): n is number => Number.isInteger(n);
  const isQR = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2 && isInt(x[0]) && isInt(x[1]);
  if (m.hexes.length > MAX_HEXES) return null;
  const seen = new Set<string>();
  const hexes: CustomHex[] = [];
  for (const h of m.hexes as unknown[]) {
    if (!h || typeof h !== 'object') return null;
    const { q, r, terrain, number, well, hidden } = h as CustomHex;
    if (!isInt(q) || !isInt(r) || hexDistance(q, r) > MAX_REACH) return null;
    if (!TERRAINS.includes(terrain)) return null;
    if (seen.has(key(q, r))) return null;
    seen.add(key(q, r));
    const out: CustomHex = { q, r, terrain };
    if (number !== undefined) {
      if (!isInt(number) || !(CUSTOM_NUMBERS as readonly number[]).includes(number)) return null;
      if (numbered(terrain) || terrain === 'sea') out.number = number;
    }
    if (well === true && terrain !== 'sea') out.well = true;
    if (hidden === true) out.hidden = true;
    hexes.push(out);
  }
  const ports: CustomPort[] = [];
  for (const p of m.ports as unknown[]) {
    if (!p || typeof p !== 'object') return null;
    const { q, r, side, type } = p as CustomPort;
    if (!isInt(q) || !isInt(r) || !isInt(side) || side < 0 || side > 5 || !PORT_TYPES.includes(type)) return null;
    ports.push({ q, r, side, type });
  }
  const out: CustomMap = { v: versionOf(hexes), name: m.name.slice(0, 40), hexes, ports };
  if (m.robber !== undefined) {
    if (!isQR(m.robber)) return null;
    out.robber = [m.robber[0], m.robber[1]];
  }
  if (m.corsair !== undefined) {
    if (!isQR(m.corsair)) return null;
    out.corsair = [m.corsair[0], m.corsair[1]];
  }
  if (m.home !== undefined) {
    if (!Array.isArray(m.home) || !m.home.every(isQR) || m.home.length > MAX_HOMES) return null;
    if (m.home.length) out.home = m.home.map(([q, r]) => [q, r]);
  }
  if (m.rivers !== undefined) {
    if (!Array.isArray(m.rivers) || m.rivers.length > MAX_RIVERS) return null;
    const rivers: CustomRiver[] = [];
    for (const rv of m.rivers as unknown[]) {
      const path = (rv as CustomRiver)?.path;
      if (!Array.isArray(path) || path.length < 1 || path.length > MAX_RIVER_LEN || !path.every(isQR)) return null;
      rivers.push({ path: path.map(([q, r]) => [q, r]) });
    }
    if (rivers.length) out.rivers = rivers;
  }
  if (m.bag !== undefined) {
    if (!m.bag || typeof m.bag !== 'object') return null;
    const bag: Partial<Record<CustomTerrain, number>> = {};
    for (const [t, n] of Object.entries(m.bag)) {
      if (!TERRAINS.includes(t as CellTerrain) || t === 'random' || !isInt(n) || n < 0 || n > MAX_HEXES) return null;
      if (n > 0) bag[t as CustomTerrain] = n;
    }
    out.bag = bag;
  }
  if (m.deal === true) out.deal = true;
  return out;
}

// ---------------------------------------------------------------- the deal

/** The classic proportions: 3 hills, 4 forest, 4 pasture, 4 fields, 3 mountains to each desert. */
const WEIGHTS: Partial<Record<CustomTerrain, number>> = { hills: 3, forest: 4, pasture: 4, fields: 4, mountains: 3 };

/** A bag of `n` tiles in the classic proportions (one desert per 19, at least one when there are 10 or more). */
export function classicBag(n: number): Partial<Record<CustomTerrain, number>> {
  const deserts = n >= 10 ? Math.max(1, Math.round(n / 19)) : 0;
  const left = n - deserts;
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b!, 0);
  const counts = (Object.entries(WEIGHTS) as [CustomTerrain, number][]).map(([t, w]) => ({ t, n: Math.floor((left * w) / total), rem: ((left * w) / total) % 1 }));
  let short = left - counts.reduce((a, c) => a + c.n, 0);
  for (const c of [...counts].sort((a, b) => b.rem - a.rem)) if (short-- > 0) c.n++;
  const bag: Partial<Record<CustomTerrain, number>> = {};
  for (const c of counts) if (c.n) bag[c.t] = c.n;
  if (deserts) bag.desert = deserts;
  return bag;
}

export const bagSize = (bag: Partial<Record<CustomTerrain, number>>) => Object.values(bag).reduce((a, b) => a + (b ?? 0), 0);
const bagTiles = (bag: Partial<Record<CustomTerrain, number>>): CustomTerrain[] => (Object.entries(bag) as [CustomTerrain, number][]).flatMap(([t, n]) => Array<CustomTerrain>(n).fill(t));

/** The bag a map's random cells are drawn from: its own, or the classic proportions for as many cells. */
export const bagOf = (map: CustomMap) => map.bag ?? classicBag(map.hexes.filter((h) => h.terrain === 'random').length);

/** Whether a map leaves anything to the deal: random cells or harbours, or numbers to deal. */
export const isRandom = (map: CustomMap) => map.hexes.some((h) => h.terrain === 'random') || map.ports.some((p) => p.type === 'random') || (!!map.deal && map.hexes.some((h) => numbered(h.terrain) && h.number === undefined));

/** A deal: every cell its terrain, every producing hex its numbers, every harbour its type. */
export interface Dealt {
  hexes: (Omit<CustomHex, 'terrain' | 'number'> & { terrain: CustomTerrain; numbers: number[] })[];
  ports: { q: number; r: number; side: number; type: PortType }[];
}

/**
 * The map dealt from `rng`: the random cells from the bag, numbers to every numbered hex without
 * one (the classic discs, as many sets as it takes, reds kept apart where they can be), and each
 * random harbour a type from the classic mix. A map with nothing random draws nothing.
 */
export function dealMap(map: CustomMap, rng: Rng): Dealt {
  const random = map.hexes.filter((h) => h.terrain === 'random');
  const tiles = random.length ? rng.shuffle(bagTiles(bagOf(map))) : [];
  const terrainOf = new Map(random.map((h, i) => [key(h.q, h.r), tiles[i] ?? 'pasture']));
  const hexes: Dealt['hexes'] = map.hexes.map((h) => {
    const terrain = h.terrain === 'random' ? terrainOf.get(key(h.q, h.r))! : h.terrain;
    const out: Dealt['hexes'][number] = { q: h.q, r: h.r, terrain, numbers: [] };
    if (terrain === 'lake') out.numbers = [...LAKE_NUMBERS];
    else if (h.number !== undefined && (numbered(terrain) || terrain === 'sea') && h.terrain !== 'random') out.numbers = [h.number];
    if (h.well && isLand(terrain)) out.well = true;
    if (h.hidden) out.hidden = true;
    return out;
  });
  // (Random cells are always dealt their numbers: what they'll be isn't known until now.)
  const owed = hexes.filter((h) => numbered(h.terrain) && h.numbers.length === 0 && (map.deal || terrainOf.has(key(h.q, h.r))));
  if (owed.length) dealInto(hexes, owed, rng);
  const types: PortType[] = [];
  const wanted = map.ports.filter((p) => p.type === 'random').length;
  while (types.length < wanted) types.push(...rng.shuffle<PortType>(['any', 'any', 'any', 'any', 'brick', 'wood', 'wool', 'wheat', 'ore']));
  let t = 0;
  const ports = map.ports.map((p) => ({ q: p.q, r: p.r, side: p.side, type: p.type === 'random' ? types[t++] : p.type }));
  return { hexes, ports };
}

/** Numbers for `owed` from the classic discs, shuffled until no red touches another (or the best of many tries). */
function dealInto(all: Dealt['hexes'], owed: Dealt['hexes'], rng: Rng) {
  const bag: number[] = [];
  while (bag.length < owed.length) bag.push(...NUMBER_DISCS);
  const at = new Map(all.map((h) => [key(h.q, h.r), h]));
  let best: number[] = [];
  let bestClash = Infinity;
  for (let attempt = 0; attempt < 300 && bestClash > 0; attempt++) {
    const discs = rng.shuffle(bag.slice()).slice(0, owed.length);
    const by = new Map(owed.map((h, i) => [key(h.q, h.r), discs[i]]));
    const red = (q: number, r: number) => {
      const k = key(q, r);
      if (by.has(k)) return isRed(by.get(k)!);
      const h = at.get(k);
      return !!h && isLand(h.terrain) && h.numbers.some(isRed);
    };
    let clash = 0;
    for (const h of owed) if (isRed(by.get(key(h.q, h.r))!)) for (const [q, r] of neighbours(h.q, h.r)) if (red(q, r)) clash++;
    if (clash < bestClash) {
      bestClash = clash;
      best = discs;
    }
  }
  owed.forEach((h, i) => (h.numbers = [best[i]]));
}

/** The modules whose features a map carries itself (the rest shape its home island). */
export function carried(map: CustomMap): Set<ModuleId> {
  const out = new Set<ModuleId>();
  if (map.hexes.some((h) => h.terrain === 'lake')) out.add('fisheries');
  if (map.hexes.some((h) => h.well)) out.add('oil');
  if (map.rivers?.length) out.add('rivers');
  if (map.hexes.some((h) => h.terrain === 'oasis')) out.add('caravans');
  if (map.hexes.some((h) => h.terrain === 'castle')) out.add('invasion');
  return out;
}

/** The side of the mouth hex at the end of `path` that meets the sea (away from the river's last stretch), or -1. */
export function mouthSide(map: { hexes: { q: number; r: number; terrain: CellTerrain | Terrain }[] }, path: [number, number][]): number {
  if (path.length === 0) return -1;
  const at = new Map(map.hexes.map((h) => [key(h.q, h.r), h]));
  const [q, r] = path[path.length - 1];
  const prev = path.length > 1 ? path[path.length - 2] : null;
  const back = prev ? SIDE_DIRS.findIndex(([dq, dr]) => q + dq === prev[0] && r + dr === prev[1]) : -1;
  // (The side straight across from where the river came in, else the nearest to it that faces the sea.)
  const order = back < 0 ? [0, 1, 2, 3, 4, 5] : [3, 2, 4, 1, 5].map((d) => (back + d) % 6);
  for (const s of order) {
    const n = at.get(key(q + SIDE_DIRS[s][0], r + SIDE_DIRS[s][1]));
    if (!n || !isLand(n.terrain as Terrain)) return s;
  }
  return -1;
}

/**
 * The board spec a custom map builds, dealt from `rng` (the deal's own salted stream). `fog`: the
 * face-down cells go under the fog (with Sea Lanes); without it they're dealt face up.
 */
export function customSpec(map: CustomMap, rng: Rng = new Rng(1), fog = true): BoardSpec {
  const dealt = dealMap(map, rng);
  const hidden = fog ? dealt.hexes.filter((h) => h.hidden) : [];
  // The face-down hexes' discs are drawn from a pool as each is found.
  const pool = rng.shuffle(hidden.flatMap((h) => (isLand(h.terrain) ? h.numbers : [])));
  const hexes: HexSpec[] = dealt.hexes.map((h) => {
    const out: HexSpec = { q: h.q, r: h.r, terrain: h.terrain, numbers: h.hidden && fog && isLand(h.terrain) ? [] : [...h.numbers] };
    if (h.well) out.well = true;
    return out;
  });
  const spec: BoardSpec = { hexes, ports: dealt.ports };
  if (map.robber) spec.robber = [...map.robber];
  if (map.corsair) spec.corsair = [...map.corsair];
  if (map.home?.length) spec.home = map.home.map(([q, r]) => [q, r]);
  const castle = dealt.hexes.find((h) => h.terrain === 'castle');
  if (castle) spec.castle = [castle.q, castle.r];
  const oasis = dealt.hexes.find((h) => h.terrain === 'oasis');
  if (oasis) spec.oasis = { at: [oasis.q, oasis.r], corners: [...OASIS_CORNERS] };
  if (map.rivers?.length) spec.rivers = map.rivers.map((rv) => ({ path: rv.path.map(([q, r]) => [q, r] as [number, number]), mouthSide: Math.max(0, mouthSide(dealt, rv.path)) }));
  if (hidden.length) spec.objectives = [{ id: 'fog', hexes: hidden.map((h) => [h.q, h.r]), numbers: pool }];
  return spec;
}

/** What the engine needs before it can build a board from the map at all (createGame refuses the rest). */
export function structuralProblems(map: CustomMap): string[] {
  const out: string[] = [];
  // (A random cell may be dealt land: it counts as land here, whatever the bag holds.)
  const landish = (t: CellTerrain) => t === 'random' || isLand(t as Terrain);
  const land = map.hexes.filter((h) => landish(h.terrain));
  if (land.length === 0) out.push('The map has no land');
  if (land.length > MAX_LAND) out.push(`The map has ${land.length} land hexes; the island holds at most ${MAX_LAND}`);
  if (map.hexes.length > MAX_HEXES) out.push(`The map has ${map.hexes.length} hexes; it holds at most ${MAX_HEXES}`);
  if (map.hexes.some((h) => hexDistance(h.q, h.r) > MAX_REACH)) out.push(`The map reaches more than ${MAX_REACH} hexes from its middle`);
  const at = new Map(map.hexes.map((h) => [key(h.q, h.r), h]));
  const bag = bagOf(map);
  const seaInBag = (bag.sea ?? 0) > 0;
  for (const p of map.ports) {
    const h = at.get(key(p.q, p.r));
    if (!h || !landish(h.terrain)) {
      out.push(`A harbour at ${p.q},${p.r} isn't on land`);
      continue;
    }
    if (h.terrain === 'random' && seaInBag) out.push(`A harbour at ${p.q},${p.r} stands on a hex the bag may deal as sea`);
    const n = at.get(key(p.q + SIDE_DIRS[p.side][0], p.r + SIDE_DIRS[p.side][1]));
    if (n && landish(n.terrain) && !(n.terrain === 'random' && seaInBag)) out.push(`A harbour at ${p.q},${p.r} faces land, not the sea`);
  }
  const onLand = (qr: [number, number] | undefined) => !!qr && landish(at.get(key(...qr))?.terrain ?? 'sea') && at.get(key(...qr))?.terrain !== 'random';
  if (map.robber && !onLand(map.robber)) out.push('The robber starts off the land (or on a random hex)');
  if (map.corsair && at.get(key(...map.corsair))?.terrain !== 'sea') out.push('The corsair starts off the open sea');
  for (const h of map.home ?? []) if (!onLand(h)) out.push('A home island’s marker isn’t on fixed land');
  for (const [i, rv] of (map.rivers ?? []).entries()) {
    const name = `River ${i + 1}`;
    if (rv.path.some(([q, r], j) => j > 0 && hexDistance(q - rv.path[j - 1][0], r - rv.path[j - 1][1]) !== 1)) out.push(`${name} doesn’t run through neighbouring hexes`);
    if (rv.path.some(([q, r]) => !onLand([q, r]))) out.push(`${name} runs off fixed land`);
    else if (mouthSide(map, rv.path) < 0) out.push(`${name}’s mouth doesn’t reach the sea`);
  }
  if (map.bag && map.hexes.some((h) => h.terrain === 'random')) {
    const n = map.hexes.filter((h) => h.terrain === 'random').length;
    if (bagSize(map.bag) !== n) out.push(`The bag holds ${bagSize(map.bag)} tiles for ${n} random hexes`);
  }
  return out;
}

// ---------------------------------------------------------------- maps sent to a room

/**
 * The most a room takes of a custom map: its JSON (UTF-8 bytes), and harbours. The same numbers as
 * src/net/protocol.ts's CUSTOM_MAP_MAX_BYTES and CUSTOM_MAP_MAX_HARBOURS (the engine doesn't import
 * the protocol; tests/online/roomMap.test.ts holds them equal).
 */
export const ROOM_MAP_MAX_BYTES = 64 * 1024;
export const ROOM_MAP_MAX_HARBOURS = 18;

/** UTF-8 length of a string (without TextEncoder: the engine uses no host APIs). */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Whether an online room may be dealt a custom map someone sent it (`x`: the map, or its JSON): at
 * most ROOM_MAP_MAX_BYTES of JSON and ROOM_MAP_MAX_HARBOURS harbours, never two on one side, a map
 * parseCustomMap takes with no structural problem, and, under the fog, nothing a seat's view would
 * show through it: the board's features (a river, the castle, the oasis) and the markers a game
 * puts in its state (the robber's start, the desert it may start on, the corsair's, a home island's)
 * must lie face up. Returns the map as parsed, or why it's refused. (Whether it plays to its target
 * is checkCustomMap's to say, with the room's modules.)
 */
export function checkRoomMap(x: unknown): { map: CustomMap | null; errors: string[] } {
  let raw: unknown = x;
  let text: string;
  try {
    text = typeof x === 'string' ? x : JSON.stringify(x);
    if (typeof x === 'string') raw = JSON.parse(x);
  } catch {
    return { map: null, errors: ['The map isn’t JSON'] };
  }
  if (typeof text !== 'string') return { map: null, errors: ['The map isn’t JSON'] };
  const bytes = utf8Length(text);
  if (bytes > ROOM_MAP_MAX_BYTES) return { map: null, errors: [`The map is ${bytes} bytes; a room takes at most ${ROOM_MAP_MAX_BYTES}`] };
  const map = parseCustomMap(raw);
  if (!map) return { map: null, errors: ['That isn’t a map'] };
  const errors = structuralProblems(map);
  if (map.ports.length > ROOM_MAP_MAX_HARBOURS) errors.push(`The map has ${map.ports.length} harbours; a room takes at most ${ROOM_MAP_MAX_HARBOURS}`);
  const sides = new Set<string>();
  for (const p of map.ports) {
    const at = `${p.q},${p.r},${p.side}`;
    if (sides.has(at)) errors.push(`Two harbours on side ${p.side} of ${p.q},${p.r}`);
    sides.add(at);
  }
  const hidden = new Set(map.hexes.filter((h) => h.hidden).map((h) => key(h.q, h.r)));
  if (hidden.size > 0) {
    const down = (qr: [number, number] | undefined) => !!qr && hidden.has(key(...qr));
    if (map.rivers?.some((rv) => rv.path.some(([q, r]) => down([q, r])))) errors.push('A river runs under the fog');
    for (const h of map.hexes) if (h.hidden && (h.terrain === 'castle' || h.terrain === 'oasis')) errors.push(`The ${h.terrain} lies under the fog`);
    if (down(map.corsair)) errors.push('The corsair starts under the fog');
    if (map.home?.some((h) => down(h))) errors.push('A home island’s marker lies under the fog');
    if (map.robber) {
      if (down(map.robber)) errors.push('The robber starts under the fog');
    } else if (map.hexes.some((h) => h.hidden && (h.terrain === 'desert' || (h.terrain === 'random' && (bagOf(map).desert ?? 0) > 0)))) {
      // (Without a starting hex the robber starts on the desert: one dealt under the fog would show.)
      errors.push('The robber would start on a desert under the fog: place its starting hex face up');
    }
  }
  return { map: errors.length ? null : map, errors };
}

// ---------------------------------------------------------------- the check

interface MapFigures {
  /** Land hexes (face up), and those that produce. */
  land: number;
  producing: number;
  /** Settlement sites under the distance rule, all told and on the land a player can start on. */
  sites: number;
  startSites: number;
  /** Each player's fair share of the sites, and the points that share makes as buildings (cities included). */
  share: number;
  sharePoints: number;
  /** The most one player could make: buildings on the sites the others leave, every award and every point card. */
  most: number;
  /** The target the map comfortably supports for this many players (before the expansions' own points). */
  suggested: number;
  /** Production in dots, by resource (the average of the deals checked, on a random map). */
  dots: Record<Resource, number>;
  /** Islands, and how many deals were checked (1 when nothing is random). */
  islands: number;
  deals: number;
}

export interface MapCheck {
  errors: string[];
  warnings: string[];
  /** What the map tells the player about the expansions: which features it carries, which the game will place. */
  notes: string[];
  figures: MapFigures | null;
}

/** Points from `sites` building sites: each a settlement, four of them cities (five settlements and four cities at most). */
export const buildingPoints = (sites: number) => {
  const s = Math.max(0, Math.min(sites, PIECES.settlements + PIECES.cities));
  return s + Math.min(s, PIECES.cities);
};

/** The base game's points beyond buildings: longest route and biggest army (2 each), and the five point cards. */
const AWARDS = 2 + 2;
const POINT_CARDS = 5;

/**
 * Settlement sites a board offers under the distance rule (no two on neighbouring intersections),
 * among the intersections `allowed`: a greedy maximal independent set, taking first the
 * intersections that crowd out the fewest others (a close lower bound on the true most).
 */
function countSites(board: Board, allowed: (v: number) => boolean): number {
  const open = new Set(board.vertices.filter((v) => v.land && allowed(v.id)).map((v) => v.id));
  let n = 0;
  while (open.size > 0) {
    let best = -1;
    let bestDeg = Infinity;
    for (const v of open) {
      const deg = board.vertices[v].neighbors.filter((x) => open.has(x)).length;
      if (deg < bestDeg) {
        best = v;
        bestDeg = deg;
      }
    }
    open.delete(best);
    for (const x of board.vertices[best].neighbors) open.delete(x);
    n++;
  }
  return n;
}

/**
 * The fewest settlement sites a set-up is sure to leave room for, however the players spread out
 * among the intersections `allowed`. Nobody can settle once every free one is taken or beside a
 * settlement, and each settlement covers its own and its neighbours, so a set-up holds at least as
 * many as it takes the roomiest intersections to cover them all. (countSites is the most a careful
 * set-up fits, which careless settling may fall well short of on a small island.)
 */
export function surestSites(board: Board, allowed: (v: number) => boolean): number {
  const open = board.vertices.filter((v) => v.land && allowed(v.id));
  const ids = new Set(open.map((v) => v.id));
  const cover = open.map((v) => 1 + v.neighbors.filter((x) => ids.has(x)).length).sort((a, b) => b - a);
  let covered = 0;
  let n = 0;
  for (const c of cover) {
    if (covered >= open.length) break;
    covered += c;
    n++;
  }
  return n;
}

interface CheckFor {
  players: number;
  /** The points to win. */
  victoryPoints: number;
  modules?: readonly ModuleId[];
  /** Points the expansions in play add beyond the base game's (their suggested target less 10). */
  extra?: number;
  /** Tries a game on the map with the modules in play (createGame, passed in to keep this module free of setup's imports). */
  tryGame?: (seed: number) => void;
}

const MODULE_NAMES: Partial<Record<ModuleId, string>> = { sea: 'Sea Lanes', fisheries: 'Fisheries', rivers: 'Rivers', caravans: 'Wagon Trains', invasion: 'Invasion', oil: 'Oil' };
const featureName = (f: string) => ({ bounty: 'bounty fields', lake: 'lake', ground: 'fishing grounds', swamp: 'swamps', river: 'rivers', oasis: 'oasis', castle: 'castle', well: 'wells', corsair: 'corsair', fog: 'fog' })[f] ?? f;

/** Whether a game for `opts.players` to `opts.victoryPoints` can be played on the map, with what's wrong and what's merely worth knowing. */
export function checkCustomMap(map: CustomMap, opts: CheckFor): MapCheck {
  const errors = structuralProblems(map);
  const warnings: string[] = [];
  const notes: string[] = [];
  if (errors.length > 0) return { errors, warnings, notes, figures: null };
  const modules = opts.modules ?? [];
  const sea = modules.includes('sea');
  const random = isRandom(map);
  // A random map is checked over several deals: what goes wrong in any of them is reported.
  const deals = random ? 6 : 1;
  const figures: MapFigures[] = [];
  const once = new Set<string>();
  const add = (list: string[], text: string) => {
    if (once.has(text)) return;
    once.add(text);
    list.push(text);
  };
  for (let d = 0; d < deals; d++) {
    let board: Board;
    try {
      board = buildBoard(customSpec(map, new Rng(1000 + d * 7919), sea));
    } catch (e) {
      add(errors, (e as Error).message);
      break;
    }
    figures.push(checkBoard(board, map, opts, sea, (t) => add(errors, random && d > 0 ? `${t} (in some deals)` : t), (t) => add(warnings, t)));
  }
  if (figures.length === 0) return { errors, warnings, notes, figures: null };

  // The features, the expansions they belong to, and which the game will place itself.
  const has = {
    bounty: map.hexes.some((h) => h.terrain === 'bounty' || (h.terrain === 'random' && (bagOf(map).bounty ?? 0) > 0)),
    lake: map.hexes.some((h) => h.terrain === 'lake'),
    ground: map.hexes.some((h) => h.terrain === 'sea' && h.number !== undefined),
    swamp: map.hexes.some((h) => h.terrain === 'swamp'),
    river: (map.rivers?.length ?? 0) > 0,
    oasis: map.hexes.some((h) => h.terrain === 'oasis'),
    castle: map.hexes.some((h) => h.terrain === 'castle'),
    well: map.hexes.some((h) => h.well),
    corsair: !!map.corsair,
    fog: map.hexes.some((h) => h.hidden),
  };
  const idle = (Object.keys(has) as (keyof typeof has)[]).filter((f) => has[f] && !modules.includes(FEATURE_MODULE[f]));
  if (idle.length) {
    const absent = [...new Set(idle.map((f) => MODULE_NAMES[FEATURE_MODULE[f]] ?? FEATURE_MODULE[f]))];
    const things = idle.filter((f) => f !== 'fog').map(featureName);
    const parts = [...(idle.includes('fog') ? ['the fog is dealt face up'] : []), ...(things.length ? [`the map’s ${listed(things, 'and')} play no part`] : [])];
    warnings.push(`Without ${listed(absent, 'or')}, ${parts.join(', and ')}`);
  }
  const own = carried(map);
  const shaped = modules.filter((m) => ['fisheries', 'oil', 'rivers', 'caravans', 'invasion'].includes(m) && !own.has(m));
  const placed = modules.filter((m) => own.has(m));
  if (placed.length) notes.push(`The map places its own features for ${listed(placed.map((m) => MODULE_NAMES[m]!), 'and')}`);
  if (shaped.length) notes.push(`The game places ${listed(shaped.map((m) => MODULE_NAMES[m]!), 'and')}’s features on the home island, which may move a few tiles and numbers there`);
  if (random) notes.push('Random hexes, numbers and harbours are dealt afresh for every game');

  // The expansions shape the home island: try the game for real, on a few seeds (a shaper's, or the deal's, luck may differ).
  if (opts.tryGame && errors.length === 0 && (modules.length > 0 || random)) {
    for (const seed of [1, 2, 3]) {
      try {
        opts.tryGame(seed);
      } catch (e) {
        errors.push((e as Error).message.replace(/^Invalid game option: /, ''));
        break;
      }
    }
  }

  // (The figures are the worst deal's, the production the average of them all.)
  const worst = figures.reduce((a, b) => (b.sharePoints < a.sharePoints ? b : a));
  const dots = Object.fromEntries(RESOURCES.map((r) => [r, Math.round(figures.reduce((a, f) => a + f.dots[r], 0) / figures.length)])) as Record<Resource, number>;
  return { errors, warnings, notes, figures: { ...worst, dots, deals: figures.length } };
}

/**
 * The islands no ship can reach: those whose coast the open sea doesn't run to from a home island
 * (a gap of nothing between two islands can't be sailed, only the sea cells can). A breadth-first
 * search over the sea's edges, from the corners of home land.
 */
function strandedIslands(board: Board, shown: (v: number) => boolean): Board['islands'] {
  const reached = new Set<number>();
  const queue: number[] = [];
  for (const v of board.vertices) {
    if (!shown(v.id) || !v.hexes.some((h) => board.islands[board.hexes[h].island]?.home)) continue;
    reached.add(v.id);
    queue.push(v.id);
  }
  while (queue.length > 0) {
    const v = queue.pop()!;
    for (const e of board.vertices[v].edges) {
      if (!board.edges[e].sea) continue;
      const w = board.edges[e].a === v ? board.edges[e].b : board.edges[e].a;
      if (reached.has(w)) continue;
      reached.add(w);
      queue.push(w);
    }
  }
  return board.islands.filter((i) => !i.home && !i.hexes.some((h) => board.hexes[h].vertices.some((v) => reached.has(v))));
}

/** The check of one dealt board: errors and warnings reported through `bad` and `warn`, and its figures. */
function checkBoard(board: Board, map: CustomMap, opts: CheckFor, sea: boolean, bad: (t: string) => void, warn: (t: string) => void): MapFigures {
  const hidden = new Set(sea ? (board.objectives?.find((o) => o.id === 'fog')?.hexes ?? []) : []);
  const land = board.hexes.filter((h) => isLand(h.terrain) && !hidden.has(h.id));
  const producing = land.filter((h) => produces(h.terrain));

  const unnumbered = land.filter((h) => (produces(h.terrain) || h.terrain === 'bounty') && h.numbers.length === 0).length;
  if (unnumbered > 0) bad(`${unnumbered} producing ${unnumbered === 1 ? 'hex has' : 'hexes have'} no number${map.deal ? '' : ' (number them, or deal numbers at the start)'}`);
  if (board.desertHex === null && board.features.robber === undefined) bad('Place the robber’s starting hex (or a desert for it)');
  // (Harbours share their corners' trade: two on one side, or touching, make one corner two harbours.)
  const sides = new Set<number>();
  const corners = new Set<number>();
  for (const p of board.ports) {
    if (sides.has(p.edge)) bad('Two harbours share a coast');
    sides.add(p.edge);
    for (const v of p.vertices) {
      if (corners.has(v)) bad('Two harbours touch at a corner');
      corners.add(v);
    }
  }

  // Sites: the starting settlements are counted on the home islands (with Sea Lanes they must go
  // there; without it roads can't leave an island, so a player who starts on an islet is stranded
  // on it, and the islets are warned of below). Ships carry the rest of the game to the other
  // islands, so with Sea Lanes every island's sites count towards the points, else the home islands' alone.
  const onHome = (v: number) => board.vertices[v].hexes.some((h) => isLand(board.hexes[h].terrain) && !hidden.has(h) && board.islands[board.hexes[h].island]?.home);
  const shown = (v: number) => board.vertices[v].hexes.some((h) => isLand(board.hexes[h].terrain) && !hidden.has(h));
  const sites = countSites(board, sea ? () => true : onHome);
  const startSites = countSites(board, onHome);
  const n = opts.players;
  if (startSites < 2 * n) bad(`${n} players need ${2 * n} starting sites on the home island${sea ? 's' : ''}, and the map has ${startSites}`);
  else {
    // (Settled carelessly, a small island can run out of room before everyone has started.)
    const surest = surestSites(board, onHome);
    if (surest < 2 * n) bad(`${n} players need ${2 * n} starting sites on the home island${sea ? 's' : ''}: the map has ${startSites}, but settled apart it may leave room for only ${surest}`);
  }

  const share = Math.floor(sites / n);
  const sharePoints = buildingPoints(share);
  const most = buildingPoints(sites - 2 * (n - 1)) + AWARDS + POINT_CARDS;
  const extra = opts.extra ?? 0;
  const target = opts.victoryPoints;
  if (most + extra < target) bad(`${target} points can’t be reached here: one player could make ${most + extra} at most`);
  else if (sharePoints + 2 + extra < target) warn(`${target} points is a long way on this map: a fair share of its sites makes about ${sharePoints + 2 + extra} with one award`);

  const dots = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;
  for (const h of producing) for (const x of h.numbers) dots[TERRAIN_RESOURCE[h.terrain]!] += PIPS[x] ?? 0;
  const all = board.hexes.filter((h) => isLand(h.terrain));
  const missing = RESOURCES.filter((r) => !all.some((h) => TERRAIN_RESOURCE[h.terrain] === r));
  if (missing.length > 0) warn(`No ${listed(missing, 'or')} grows here: ${missing.length === 1 ? 'it' : 'they'} can only be traded for`);
  const reds = land.filter((h) => h.numbers.some(isRed));
  if (reds.some((h) => h.neighbors.some((x) => reds.includes(board.hexes[x])))) warn('A 6 or an 8 sits beside another: those hexes will pay out a lot together');
  const totals = RESOURCES.filter((r) => !missing.includes(r) && dots[r] > 0).map((r) => dots[r]);
  if (totals.length >= 3 && Math.max(...totals) > 3 * Math.min(...totals)) warn('Production is lopsided: one resource yields over three times another');
  const islands = board.islands.length;
  if (islands > 1 && !sea) warn('Without Sea Lanes, roads can’t cross the sea: no one can reach the other islands, and their sites count for nothing');
  if (sea) for (const i of strandedIslands(board, shown)) bad(`${i.hexes.length === 1 ? 'An islet' : 'An island'} at ${board.hexes[i.hexes[0]].q},${board.hexes[i.hexes[0]].r} can’t be reached by ship: sea must run from a home island to its coast`);
  if (sea && board.hexes.every((h) => h.terrain !== 'sea')) warn('Sea Lanes’ ships need open sea: paint some round the coast');
  // The fog: never over a home island, and never over the expansions' features.
  if (hidden.size) {
    if ([...hidden].some((h) => isLand(board.hexes[h].terrain) && board.islands[board.hexes[h].island]?.home)) bad('The fog covers part of a home island: starting places must be face up');
    if (map.hexes.some((h) => h.hidden && (h.terrain === 'lake' || h.terrain === 'castle' || h.terrain === 'oasis' || h.terrain === 'swamp' || h.well))) bad('The fog can’t hide the expansions’ features (a lake, castle, oasis, swamp or well)');
  }
  for (const g of board.hexes.filter((h) => h.terrain === 'sea' && h.numbers.length > 0)) if (!g.neighbors.some((x) => isLand(board.hexes[x].terrain))) bad('A fishing ground lies out of reach of the land');
  const suggested = Math.max(3, Math.min(10, sharePoints + 1));
  return { land: land.length, producing: producing.length, sites, startSites, share, sharePoints, most, suggested, dots, islands, deals: 1 };
}

// ---------------------------------------------------------------- making maps

/** The cells of a hexagon of `radius` round the middle. */
export function hexagon(radius: number): [number, number][] {
  const out: [number, number][] = [];
  for (let r = -radius; r <= radius; r++) for (let q = Math.max(-radius, -radius - r); q <= Math.min(radius, radius - r); q++) out.push([q, r]);
  return out;
}

/** A blank map: `land` cells of grassland in the middle of a sea of `radius`. */
export function blankMap(name: string, radius: number, landRadius = radius - 1): CustomMap {
  return {
    v: 2,
    name,
    hexes: hexagon(radius).map(([q, r]) => ({ q, r, terrain: hexDistance(q, r) <= landRadius ? 'pasture' : 'sea' })),
    ports: [],
  };
}

/**
 * The cells of a rectangle `width` hexes across and `height` rows high, the odd rows half a hex to
 * the right (so the rows stagger like bricks), about the middle.
 */
export function rectangle(width: number, height: number): [number, number][] {
  const out: [number, number][] = [];
  const r0 = -Math.floor((height - 1) / 2);
  const c0 = -Math.floor((width - 1) / 2);
  for (let r = r0; r < r0 + height; r++) for (let c = c0; c < c0 + width; c++) out.push([c - (r - (r & 1)) / 2, r]);
  return out;
}

/** The map with every coordinate moved by (dq, dr): cells, harbours, the robber, the corsair, homes and rivers. */
export function translate(map: CustomMap, dq: number, dr: number): CustomMap {
  if (dq === 0 && dr === 0) return map;
  const move = ([q, r]: [number, number]): [number, number] => [q + dq, r + dr];
  const out: CustomMap = { ...map, hexes: map.hexes.map((h) => ({ ...h, q: h.q + dq, r: h.r + dr })), ports: map.ports.map((p) => ({ ...p, q: p.q + dq, r: p.r + dr })) };
  if (map.robber) out.robber = move(map.robber);
  if (map.corsair) out.corsair = move(map.corsair);
  if (map.home) out.home = map.home.map(move);
  if (map.rivers) out.rivers = map.rivers.map((rv) => ({ path: rv.path.map(move) }));
  return out;
}

/** The cell nearest the middle of the bounding box of the map's cells (0,0 for a map with none). */
export function centreOf(map: { hexes: readonly { q: number; r: number }[] }): [number, number] {
  if (map.hexes.length === 0) return [0, 0];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const h of map.hexes) {
    const [x, z] = hexCenter(h.q, h.r);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  // (A hair to one side: a middle exactly between two cells is rounded the same way before a move and after it.)
  const [q, r] = cellAt((x0 + x1) / 2 + 1e-6, (z0 + z1) / 2 + 1e-6);
  // (Adding 0 turns a -0 into 0.)
  return [q + 0, r + 0];
}

/**
 * The map recentred on the middle of its cells' bounding box, every coordinate moved with it, and
 * written in the format its size calls for. (Called when a map is saved, not while it is drawn: the
 * editor's cells stay where they are under the brush. A map already centred is returned as it is;
 * one the move would carry past MAX_REACH is centred as near as the limit allows.)
 */
export function normalize(map: CustomMap): CustomMap {
  if (map.hexes.length === 0) return map;
  const reach = (c: readonly [number, number]) => Math.max(...map.hexes.map((h) => hexDistance(h.q - c[0], h.r - c[1])));
  const mid = centreOf(map);
  let at: readonly [number, number] = mid;
  if (reach(at) > MAX_REACH) {
    // (A strip along a diagonal can lie nearer its ends than its middle: the best of the cells about it.)
    const near = [[0, 0], ...neighbours(...mid), mid].map(([q, r]) => [q + 0, r + 0] as [number, number]);
    at = near.reduce((a, b) => (reach(b) < reach(a) ? b : a));
  }
  const moved = translate(map, -at[0], -at[1]);
  const v = versionOf(moved.hexes);
  return moved.v === v ? moved : { ...moved, v };
}

const PLAIN: CellTerrain[] = ['hills', 'forest', 'pasture', 'fields', 'mountains', 'desert'];

const clean = (h: CustomHex): CustomHex => {
  const out: CustomHex = { q: h.q, r: h.r, terrain: h.terrain };
  if (h.number !== undefined) out.number = h.number;
  if (h.well) out.well = true;
  if (h.hidden) out.hidden = true;
  return out;
};

/** The map's plain land given terrain in the classic proportions, then numbers dealt (features, random cells and fog left as they are). */
export function fillTerrain(map: CustomMap, rng: Rng): CustomMap {
  const plain = map.hexes.filter((h) => PLAIN.includes(h.terrain));
  const bag = rng.shuffle(bagTiles(classicBag(plain.length)));
  if (!bag.includes('desert') && plain.length >= 7 && !map.hexes.some((h) => h.terrain === 'desert')) bag[0] = 'desert';
  let k = 0;
  const hexes = map.hexes.map((h) => clean(PLAIN.includes(h.terrain) ? { ...h, terrain: bag[k++], number: undefined } : h));
  return dealNumbers({ ...map, hexes, robber: undefined }, rng);
}

/** Fixed numbers dealt now to every numbered hex (random cells keep theirs to the deal): the classic discs, reds apart. */
export function dealNumbers(map: CustomMap, rng: Rng): CustomMap {
  const hexes = map.hexes.map((h) => clean({ ...h, number: numbered(h.terrain) ? undefined : h.number }));
  const work: Dealt['hexes'] = hexes.map((h) => ({ q: h.q, r: h.r, terrain: h.terrain === 'random' ? 'sea' : h.terrain, numbers: h.terrain === 'lake' ? [...LAKE_NUMBERS] : h.number !== undefined ? [h.number] : [] }));
  const owed = work.filter((h) => numbered(h.terrain));
  dealInto(work, owed, rng);
  work.forEach((w, i) => {
    if (numbered(w.terrain)) hexes[i].number = w.numbers[0];
  });
  return { ...map, hexes };
}

/**
 * The middle of a map's cells, in hex coordinates (the sums are integers, so a hexagon drawn about
 * (0,0) has its middle at exactly 0,0 and its coast the order it has always had).
 */
function centroid(map: CustomMap): [number, number] {
  if (map.hexes.length === 0) return [0, 0];
  let q = 0;
  let r = 0;
  for (const h of map.hexes) {
    q += h.q;
    r += h.r;
  }
  return [q / map.hexes.length, r / map.hexes.length];
}

/**
 * Every coastal side of the face-up land, clockwise round the map's centroid (where harbours may
 * go): random land counts as land unless the bag may deal it as sea (structuralProblems' rule).
 */
export function coastSides(map: CustomMap): { q: number; r: number; side: number }[] {
  const at = new Map(map.hexes.map((h) => [key(h.q, h.r), h]));
  const seaInBag = (bagOf(map).sea ?? 0) > 0;
  const land = (t?: CellTerrain) => !!t && (t === 'random' ? !seaInBag : isLand(t as Terrain));
  const [cx, cz] = hexCenter(...centroid(map));
  const out: { q: number; r: number; side: number; a: number }[] = [];
  for (const h of map.hexes) {
    if (!land(h.terrain) || h.hidden) continue;
    for (let side = 0; side < 6; side++) {
      const n = at.get(key(h.q + SIDE_DIRS[side][0], h.r + SIDE_DIRS[side][1]));
      if (n && land(n.terrain)) continue;
      const [x, z] = hexCenter(h.q, h.r);
      const [nx, nz] = hexCenter(h.q + SIDE_DIRS[side][0], h.r + SIDE_DIRS[side][1]);
      out.push({ q: h.q, r: h.r, side, a: Math.atan2((z + nz) / 2 - cz, (x + nx) / 2 - cx) });
    }
  }
  return out.sort((a, b) => a.a - b.a).map(({ q, r, side }) => ({ q, r, side }));
}

/** Harbours spread evenly round the coast: one per 3 or so coastal sides, never touching, in the classic mix (4 of 9 for any trade), or all random. */
export function placeHarbours(map: CustomMap, rng: Rng, random = false): CustomMap {
  const coast = coastSides(map);
  const land = map.hexes.filter((h) => h.terrain !== 'sea' && !h.hidden).length;
  const want = Math.max(1, Math.min(Math.round((land * 9) / 19), Math.floor(coast.length / 3)));
  const types: CustomPortType[] = [];
  const classic: PortType[] = ['any', 'any', 'any', 'any', 'brick', 'wood', 'wool', 'wheat', 'ore'];
  while (types.length < want) types.push(...(random ? Array<CustomPortType>(9).fill('random') : rng.shuffle([...classic])));
  const ports: CustomPort[] = [];
  const corners = new Set<string>();
  const cornerKeys = (s: { q: number; r: number; side: number }) => {
    const [x, z] = hexCenter(s.q, s.r);
    return [s.side, (s.side + 1) % 6].map((c) => {
      const a = ((-90 + 60 * c) * Math.PI) / 180;
      return `${Math.round((x + Math.cos(a)) * 100)},${Math.round((z + Math.sin(a)) * 100)}`;
    });
  };
  const step = coast.length / want;
  const offset = rng.int(Math.max(1, Math.floor(step)));
  for (let i = 0; i < want && coast.length; i++) {
    // (The nearest free side to each even step round the coast.)
    for (let d = 0; d < coast.length; d++) {
      const s = coast[(Math.round(offset + i * step) + d) % coast.length];
      const ks = cornerKeys(s);
      if (ks.some((k) => corners.has(k))) continue;
      ks.forEach((k) => corners.add(k));
      ports.push({ ...s, type: types[i] });
      break;
    }
  }
  return { ...map, ports };
}

/**
 * The map with open sea round all its land (a ring of sea cells wherever land meets nothing), for
 * ships to sail round: within `within` (scatterIslets' grid), else as far as maps reach.
 */
export function surroundWithSea(map: CustomMap, within: (q: number, r: number) => boolean = (q, r) => hexDistance(q, r) <= MAX_REACH): CustomMap {
  const at = new Set(map.hexes.map((h) => key(h.q, h.r)));
  const add: CustomHex[] = [];
  for (const h of map.hexes) {
    if (h.terrain === 'sea') continue;
    for (const [q, r] of neighbours(h.q, h.r)) {
      if (at.has(key(q, r)) || !within(q, r)) continue;
      at.add(key(q, r));
      add.push({ q, r, terrain: 'sea' });
    }
  }
  return add.length ? { ...map, hexes: [...map.hexes, ...add] } : map;
}

/**
 * The cells of the editor's grid: those a map lists, and `rings` rings of cells round them (as far
 * as maps reach from the middle). In the order of the map's cells, then the rings' (a map with no
 * cells has a small grid of its own to start in).
 */
export function gridCells(map: CustomMap, rings = 2): [number, number][] {
  if (map.hexes.length === 0) return hexagon(rings + 1);
  const seen = new Set(map.hexes.map((h) => key(h.q, h.r)));
  const out: [number, number][] = map.hexes.map((h) => [h.q, h.r]);
  let edge = out.slice();
  for (let i = 0; i < rings; i++) {
    const next: [number, number][] = [];
    for (const [q, r] of edge)
      for (const [a, b] of neighbours(q, r)) {
        if (seen.has(key(a, b)) || hexDistance(a, b) > MAX_REACH) continue;
        seen.add(key(a, b));
        next.push([a, b]);
      }
    out.push(...next);
    edge = next;
  }
  return out;
}

/**
 * Islets scattered off the coast: up to `count` of 1 to 3 hexes, each set in open sea clear of
 * the other land, within `cells` (the map's grid and four rings round it, unless given) and the
 * island's land budget; the cells on the edge of `cells` are left clear, so the sea can close round
 * an islet. Their land is random (dealt from the bag at the start); `fog` puts them face down.
 * The sea round them is filled in.
 */
export function scatterIslets(map: CustomMap, rng: Rng, cells: readonly [number, number][] = gridCells(map, 4), count = 3, fog = false): CustomMap {
  const hexes = map.hexes.map(clean);
  const byKey = new Map(hexes.map((h) => [key(h.q, h.r), h]));
  const grid = new Set(cells.map(([q, r]) => key(q, r)));
  const landAt = (q: number, r: number) => {
    const h = byKey.get(key(q, r));
    return !!h && h.terrain !== 'sea';
  };
  let budget = MAX_LAND - hexes.filter((h) => h.terrain !== 'sea').length;
  const inside = (q: number, r: number) => grid.has(key(q, r)) && neighbours(q, r).every(([a, b]) => grid.has(key(a, b)));
  const clear = (q: number, r: number, mine: [number, number][] = []) =>
    inside(q, r) && !landAt(q, r) && neighbours(q, r).every(([a, b]) => !landAt(a, b) || mine.some(([x, y]) => x === a && y === b));
  const set = (q: number, r: number) => {
    const hex: CustomHex = { q, r, terrain: 'random' };
    if (fog) hex.hidden = true;
    const old = byKey.get(key(q, r));
    if (old) {
      old.terrain = 'random';
      delete old.number;
      if (fog) old.hidden = true;
    } else {
      hexes.push(hex);
      byKey.set(key(q, r), hex);
    }
  };
  let made = 0;
  for (const [q, r] of rng.shuffle(cells.slice())) {
    if (made >= count || budget <= 0) break;
    if (!clear(q, r)) continue;
    const size = Math.min(budget, 1 + rng.int(3));
    const cluster: [number, number][] = [[q, r]];
    for (const [a, b] of rng.shuffle(neighbours(q, r))) {
      if (cluster.length >= size) break;
      if (clear(a, b, cluster)) cluster.push([a, b]);
    }
    cluster.forEach(([a, b]) => set(a, b));
    budget -= cluster.length;
    made++;
  }
  // (The bag, when the map keeps its own, grows by the islets' tiles in the classic proportions.)
  const random = hexes.filter((h) => h.terrain === 'random').length;
  const bag = map.bag ? classicBag(random) : undefined;
  return surroundWithSea({ ...map, hexes, ...(bag && { bag }) }, (q, r) => grid.has(key(q, r)));
}
