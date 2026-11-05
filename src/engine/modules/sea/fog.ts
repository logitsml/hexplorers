// Fog: face-down hexes found by building beside them, and the board as a player sees it.

import { SIDE_DIRS, buildBoard, specOfBoard } from '../../board';
import { TERRAIN_RESOURCE, cards, isLand } from '../../constants';
import { moveCards, type Ctx } from '../../ctx';
import type { CustomMap } from '../../maps/custom';
import type { Board, GameOptions, PlayerId, Port, Resource, Terrain } from '../../types';
import { isHidden, seaState } from './rules';
import { oweBounty } from './bounty';

/** Whether a found hex takes a number disc: land that produces (a resource, or a choice on a bounty field). */
const takesNumber = (t: Terrain) => TERRAIN_RESOURCE[t] !== null || t === 'bounty';

/**
 * A route piece has gone down on `edge` (built, placed at set-up, or a ship moved there): every
 * face-down hex at either of its ends turns up. Land draws a number from the face-down discs and
 * pays its finder one card of what it produces (a pick of their choice for a bounty field).
 */
export function revealBeside(ctx: Ctx, player: PlayerId, edge: number) {
  const s = ctx.s;
  const fog = seaState(s).fog;
  if (!fog || fog.hidden.length === 0) return;
  const e = s.board.edges[edge];
  const found = new Set<number>();
  for (const v of [e.a, e.b]) for (const h of s.board.vertices[v].hexes) if (isHidden(s, h)) found.add(h);
  if (found.size > 0) ctx.revealed = true;
  let picks = 0;
  for (const hex of [...found].sort((a, b) => a - b)) {
    fog.hidden = fog.hidden.filter((h) => h !== hex);
    const terrain = s.board.hexes[hex].terrain;
    let number: number | null = null;
    let grant: Resource | null = null;
    if (isLand(terrain) && takesNumber(terrain)) {
      number = fog.pool.pop() ?? null;
      if (number !== null) fog.drawn[hex] = number;
      const res = TERRAIN_RESOURCE[terrain];
      if (res && s.bank[res] > 0) {
        moveCards(ctx, null, player, cards({ [res]: 1 }), 'found');
        grant = res;
      } else if (terrain === 'bounty') picks++;
    }
    ctx.emit({ type: 'sea/hexRevealed', player, hex, terrain, number, grant });
  }
  if (picks > 0) oweBounty(ctx, new Map([[player, picks]]), 'fog');
}

const seenBoards = new WeakMap<Board, Map<string, Board>>();

/**
 * The board as anyone sees it while `hidden` hexes are face down: those show as open water, and
 * everything that follows from terrain (coasts, landmasses) is worked out without them. Ids stay
 * as they are, so pieces and the rest of the state still line up. The objectives' number discs
 * (the face-down pool in the order it's drawn) show only as how many there were. A harbour on a
 * face-down hex, or facing one (a harbour faces water, so it would say what lies there), isn't
 * shown until the hex turns up (the others keep their ids); nor are the robber's and the corsair's
 * starting hexes when face down. (Rivers, the castle and the oasis under the fog would show too:
 * online play refuses such maps, see checkRoomMap.)
 */
export function seenBoard(board: Board, hidden: number[]): Board {
  let byKey = seenBoards.get(board);
  if (!byKey) {
    byKey = new Map();
    seenBoards.set(board, byKey);
  }
  const key = hidden.slice().sort((a, b) => a - b).join(',');
  let seen = byKey.get(key);
  if (!seen) {
    seen = buildBoard(specOfBoard(board, new Map(hidden.map((h) => [h, 'sea' as Terrain]))));
    seen.objectives = seen.objectives?.map((o) => (o.numbers ? { ...o, numbers: o.numbers.map(() => 0) } : o));
    const down = new Set(hidden);
    // (A harbour's edge lies between the hex it's on and the one it faces.)
    const showing = (p: Port) => !board.edges[p.edge].hexes.some((h) => down.has(h));
    if (!seen.ports.every(showing)) {
      seen.ports = seen.ports.filter(showing);
      for (const v of seen.vertices) v.port = null;
      for (const p of seen.ports) for (const v of p.vertices) seen.vertices[v].port = p.type;
    }
    if (seen.features.robber !== undefined && down.has(seen.features.robber)) delete seen.features.robber;
    if (seen.features.corsair !== undefined && down.has(seen.features.corsair)) delete seen.features.corsair;
    byKey.set(key, seen);
  }
  return seen;
}

const foggedOptions = new WeakMap<GameOptions, Map<string, GameOptions>>();

/**
 * A custom fog map's options as anyone sees them while `hidden` hexes of `board` are face down:
 * each face-down cell only as a face-down cell (open water, with no number or well), and without the
 * harbours, rivers and markers on it, or (harbours) facing it. Revealed cells are shown as drawn.
 */
export function seenOptions(options: GameOptions, board: Board, hidden: number[]): GameOptions {
  const map = options.custom;
  if (!map || hidden.length === 0) return options;
  let byKey = foggedOptions.get(options);
  if (!byKey) {
    byKey = new Map();
    foggedOptions.set(options, byKey);
  }
  const key = hidden.slice().sort((a, b) => a - b).join(',');
  let seen = byKey.get(key);
  if (!seen) {
    seen = { ...options, custom: seenMap(map, new Set(hidden.map((h) => `${board.hexes[h].q},${board.hexes[h].r}`))) };
    byKey.set(key, seen);
  }
  return seen;
}

function seenMap(map: CustomMap, faceDown: Set<string>): CustomMap {
  const down = (q: number, r: number) => faceDown.has(`${q},${r}`);
  const out: CustomMap = {
    ...map,
    hexes: map.hexes.map((h) => (h.hidden && down(h.q, h.r) ? { q: h.q, r: h.r, terrain: 'sea', hidden: true } : h)),
    ports: map.ports.filter((p) => !down(p.q, p.r) && !down(p.q + SIDE_DIRS[p.side][0], p.r + SIDE_DIRS[p.side][1])),
  };
  const rivers = map.rivers?.filter((rv) => !rv.path.some(([q, r]) => down(q, r)));
  if (rivers?.length) out.rivers = rivers;
  else delete out.rivers;
  const home = map.home?.filter(([q, r]) => !down(q, r));
  if (home?.length) out.home = home;
  else delete out.home;
  if (map.robber && down(...map.robber)) delete out.robber;
  if (map.corsair && down(...map.corsair)) delete out.corsair;
  return out;
}
