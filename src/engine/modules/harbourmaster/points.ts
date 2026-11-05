// Points on harbours, and who should hold the award for them.

import { buildingWorth } from '../../rules';
import type { Board, GameState, PlayerId } from '../../types';

/** What the award is worth. */
export const HARBOUR_AWARD_POINTS = 2;
/** Points on harbours needed to take the award first. */
export const HARBOUR_AWARD_MIN = 3;

const harbourCache = new WeakMap<Board, number[]>();

/** The intersections on a harbour. */
export function harbourVertices(board: Board): number[] {
  let out = harbourCache.get(board);
  if (!out) {
    out = board.vertices.filter((v) => v.port !== null).map((v) => v.id);
    harbourCache.set(board, out);
  }
  return out;
}

/** `player`'s points in buildings on harbours, each at its worth. */
export function harbourPoints(s: GameState, player: PlayerId): number {
  let n = 0;
  for (const v of harbourVertices(s.board)) if (s.buildings[v]?.owner === player) n += buildingWorth(s, v);
  return n;
}

/**
 * Who should hold the award: the holder keeps it while they have at least 3 and nobody has more;
 * otherwise the one player with the most, if that's at least 3 (a tie for the most: nobody).
 */
export function harbourHolder(s: GameState): PlayerId | null {
  const pts = s.players.map((p) => harbourPoints(s, p.id));
  const best = Math.max(...pts);
  const holder = s.ext.harbourmaster?.holder ?? null;
  if (holder !== null && pts[holder] >= HARBOUR_AWARD_MIN && pts[holder] === best) return holder;
  const top = s.players.filter((p) => pts[p.id] === best);
  return best >= HARBOUR_AWARD_MIN && top.length === 1 ? top[0].id : null;
}
