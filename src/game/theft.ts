// Which blocker a theft was made by, for the presenter's choreography: a blocker's theft goes by
// way of the piece that made it (the robber lifts the card from the victim and hands it over, the
// corsair does the same from the water), and a theft nothing on the board made flies straight from
// the hand. `stolen.by` names the second kind; the first has to be read off the events and the state.

import type { GameEvent, GameState, PlayerId } from '../engine';

export type Blocker = 'robber' | 'corsair';

type Stolen = Extract<GameEvent, { type: 'stolen' }>;

/**
 * The blocker that made `theft` (the event at `at` in `events`), or null when none did. A move of
 * a blocker earlier in the same move's events is the one (it moved, then robbed). When the thief
 * chose among several victims in a move of their own, that move holds only the theft, so the
 * blocker is the one standing by the victim (a building on the robber's hex, a ship on an edge
 * of the corsair's); both, the robber.
 */
export function blockerOf(theft: Stolen, events: readonly GameEvent[], at: number, next: GameState): Blocker | null {
  if (theft.by) return null;
  for (let i = at - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'robberMoved') return 'robber';
    if (e.type === 'sea/corsairMoved') return 'corsair';
  }
  if (standsBy(next, theft.victim, 'robber')) return 'robber';
  if (standsBy(next, theft.victim, 'corsair')) return 'corsair';
  return null;
}

/** Whether `blocker` is on the board with something of `victim`'s beside it. */
function standsBy(s: GameState, victim: PlayerId, blocker: Blocker): boolean {
  if (blocker === 'robber') {
    const hex = s.robberHex;
    return hex !== null && s.board.hexes[hex].vertices.some((v) => s.buildings[v]?.owner === victim);
  }
  const hex = s.ext.sea?.corsair ?? null;
  return hex !== null && s.board.hexes[hex].edges.some((e) => s.routes[e]?.owner === victim && s.routes[e]?.kind === 'ship');
}
