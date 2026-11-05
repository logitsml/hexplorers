// The board as the island shows it on a sea map with face-down hexes: which hexes the fog hides,
// the board with them as open water, and the numbers found hexes drew. Pure queries on the game
// state, kept apart from the fog bank itself (fog.ts) because every game's board view and world
// ask them, while the fog bank loads only with the expansions (render/expansions.ts).

import type { Board, GameState, PlayerId } from '../../engine';
import { seenBoard } from '../../engine/modules/sea/fog';

/** The face-down hexes in `state`, if it has any. */
export function hiddenHexes(state: GameState): number[] {
  return state.ext.sea?.fog?.hidden ?? [];
}

/**
 * The board as the island shows it: face-down hexes as open water (the same board a player is
 * told about: see the sea module's redact). Ids and positions are unchanged, so pieces line up.
 */
export function shownBoard(state: GameState): Board {
  const hidden = hiddenHexes(state);
  return hidden.length ? seenBoard(state.board, hidden) : state.board;
}

/** The number a found hex drew from the face-down discs (it isn't printed on the board). */
export function fogNumber(state: GameState, hex: number): number | undefined {
  return state.ext.sea?.fog?.drawn[hex];
}

/**
 * The face-down hexes `player`'s pieces already touch (a corner where a route of theirs ends or a
 * building of theirs stands): within one more road or ship of being found. The fog thins over
 * them, as a hint of where to go next. None for a spectator.
 */
export function fogWithinReach(state: GameState, player: PlayerId | null): number[] {
  const hidden = hiddenHexes(state);
  if (player === null || !hidden.length) return [];
  const board = state.board;
  const mine = (v: number) => state.buildings[v]?.owner === player || board.vertices[v].edges.some((e) => state.routes[e]?.owner === player);
  return hidden.filter((h) => board.vertices.some((v) => v.hexes.includes(h) && mine(v.id)));
}
