// A board a game carries (GameOptions.board) comes back from a save or, one day, over the network,
// so it's checked before anything is built from it: the shape of each part, every reference to a
// hex, and the limits the renderer holds the island to. What makes it a good board to play on is the
// dealer's business (maps/deal.ts); this only refuses what would crash or quietly misbehave.

import type { BoardSpec } from '../board';
import { SIDE_DIRS } from '../board';
import { TERRAIN_RESOURCE, isLand } from '../constants';
import type { Terrain } from '../types';
import { RESOURCES } from '../types';
import { MAX_HEXES, MAX_HOMES, MAX_LAND, MAX_REACH, MAX_RIVERS, MAX_RIVER_LEN } from './custom';

const TERRAINS = new Set(Object.keys(TERRAIN_RESOURCE));
const PORTS = new Set<string>([...RESOURCES, 'any']);
const OBJECTIVES = new Set(['firstLanding', 'fog']);

const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
const isNumber = (x: unknown) => isInt(x, 2, 12) && x !== 7;
const isCoord = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2 && isInt(x[0], -MAX_REACH, MAX_REACH) && isInt(x[1], -MAX_REACH, MAX_REACH);
const key = ([q, r]: [number, number]) => `${q},${r}`;

/** What's wrong with a carried board, as sentences (none when it can be built and played). */
export function boardProblems(x: unknown): string[] {
  if (!x || typeof x !== 'object') return ['The board is missing'];
  const b = x as Partial<BoardSpec>;
  if (!Array.isArray(b.hexes) || b.hexes.length === 0 || b.hexes.length > MAX_HEXES) return ['The board has no hexes'];
  const out: string[] = [];
  const terrain = new Map<string, Terrain>();
  for (const h of b.hexes) {
    if (!h || typeof h !== 'object' || !isCoord([h.q, h.r]) || !TERRAINS.has(h.terrain)) return ['The board has a hex it can’t read'];
    if (!Array.isArray(h.numbers) || h.numbers.length > 4 || !h.numbers.every(isNumber)) out.push(`The hex at ${h.q},${h.r} bears numbers no dice can roll`);
    if (h.well !== undefined && h.well !== true) out.push(`The hex at ${h.q},${h.r} has a well it can’t read`);
    if (terrain.has(key([h.q, h.r]))) out.push(`Two hexes at ${h.q},${h.r}`);
    terrain.set(key([h.q, h.r]), h.terrain);
  }
  const land = (c: unknown) => isCoord(c) && terrain.has(key(c)) && isLand(terrain.get(key(c))!);
  const lands = [...terrain.values()].filter(isLand).length;
  if (lands === 0) out.push('The board has no land');
  if (lands > MAX_LAND) out.push(`The board has ${lands} land hexes; the island holds at most ${MAX_LAND}`);

  if (!Array.isArray(b.ports) || b.ports.length > 30) out.push('The board’s harbours can’t be read');
  else {
    for (const p of b.ports) {
      if (!p || !land([p.q, p.r]) || !isInt(p.side, 0, 5) || !PORTS.has(p.type)) {
        out.push('A harbour isn’t on a side of the land');
        continue;
      }
      const facing = terrain.get(key([p.q + SIDE_DIRS[p.side][0], p.r + SIDE_DIRS[p.side][1]]));
      if (facing !== undefined && isLand(facing)) out.push(`The harbour at ${p.q},${p.r} faces land`);
    }
  }
  if (b.home !== undefined) {
    const homes = isCoord(b.home) ? [b.home] : Array.isArray(b.home) ? b.home : null;
    if (!homes || homes.length === 0 || homes.length > MAX_HOMES || !homes.every(land)) out.push('A home island isn’t on land');
  }
  if (b.rivers !== undefined) {
    if (!Array.isArray(b.rivers) || b.rivers.length > MAX_RIVERS) out.push('The rivers can’t be read');
    else {
      for (const rv of b.rivers) {
        const path = rv?.path;
        if (!Array.isArray(path) || path.length === 0 || path.length > MAX_RIVER_LEN || !path.every(land) || !isInt(rv.mouthSide, 0, 5)) {
          out.push('A river leaves the land');
          continue;
        }
        const next = path.every((c, i) => i === 0 || SIDE_DIRS.some(([dq, dr]) => path[i - 1][0] + dq === c[0] && path[i - 1][1] + dr === c[1]));
        if (!next) out.push('A river doesn’t run through neighbouring hexes');
      }
    }
  }
  for (const [name, at] of [['castle', b.castle], ['robber', b.robber]] as const) if (at !== undefined && !land(at)) out.push(`The ${name} isn’t on land`);
  if (b.corsair !== undefined && !(isCoord(b.corsair) && terrain.get(key(b.corsair)) === 'sea')) out.push('The corsair isn’t at sea');
  if (b.oasis !== undefined && !(b.oasis && land(b.oasis.at) && Array.isArray(b.oasis.corners) && b.oasis.corners.length === 3 && b.oasis.corners.every((c) => isInt(c, 0, 5)))) out.push('The oasis can’t be read');
  if (b.objectives !== undefined) {
    const ok = Array.isArray(b.objectives) && b.objectives.every((o) => o && OBJECTIVES.has(o.id) && (o.hexes === undefined || (Array.isArray(o.hexes) && o.hexes.every((c) => isCoord(c) && terrain.has(key(c))))) && (o.numbers === undefined || (Array.isArray(o.numbers) && o.numbers.every(isNumber))));
    if (!ok) out.push('The board’s objectives can’t be read');
  }
  if (b.keepOrder !== undefined && typeof b.keepOrder !== 'boolean') out.push('The board’s order can’t be read');
  return out;
}
