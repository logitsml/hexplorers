// The memo a bot's decision runs under: it answers only for the state it was opened for, hands
// each caller its own copy of a list, and closes when the decision is made, so a state that changes
// afterwards (a test's patched scene, the reducer's work in progress) is never answered from it.

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, legalActions, legalRoads, legalSettlements } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { withMemo } from '../src/engine/memo';
import { setups } from './sim-harness';

/** A state a few turns into a bot game, with roads to build. */
function midGame() {
  let s = createGame(setups(4), { seed: 21, layout: 'random' }).state;
  const memories = s.players.map(() => createBotMemory());
  while (s.turn < 12) {
    for (let i = 0; i < 4; i++) {
      const p = (s.seq + i) % 4;
      const a = botDecide(s, p, memories[p], 'normal');
      if (!a) continue;
      const r = applyAction(s, p, a);
      if (!r.ok) throw new Error(r.error);
      s = r.state;
      break;
    }
  }
  return s;
}

describe('the memo a bot decides under', () => {
  it('answers as the queries do, for its own state only, with copies callers may change', () => {
    const s = midGame();
    const p = s.currentPlayer;
    const roads = legalRoads(s, p);
    const actions = legalActions(s, p);
    expect(roads.length).toBeGreaterThan(0);
    withMemo(s, () => {
      const a = legalRoads(s, p);
      expect(a).toEqual(roads);
      a.length = 0;
      expect(legalRoads(s, p)).toEqual(roads);
      expect(legalActions(s, p)).toEqual(actions);
      expect(legalSettlements(s, p)).toEqual(legalSettlements({ ...s }, p));
      // Another state, even one built from this one, is worked out afresh.
      const taken = { ...s, routes: s.routes.slice() };
      taken.routes[roads[0]] = { owner: (p + 1) % 4, kind: 'road', builtTurn: s.turn };
      expect(legalRoads(taken, p)).not.toContain(roads[0]);
    });
  });

  it('closes when the decision is made, so a state changed afterwards is answered afresh', () => {
    const s = midGame();
    const p = s.currentPlayer;
    const roads = withMemo(s, () => legalRoads(s, p));
    s.routes[roads[0]] = { owner: (p + 1) % 4, kind: 'road', builtTurn: s.turn };
    expect(legalRoads(s, p)).not.toContain(roads[0]);
  });
});
