// Which piece a theft goes by way of on screen: the blocker that made it, or none (straight from the hand).

import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../src/engine';
import { blockerOf } from '../src/game/theft';
import { beginnerGame, patch, road } from './helpers';

type Stolen = Extract<GameEvent, { type: 'stolen' }>;
const stolen = (extra: Partial<Stolen> = {}): Stolen => ({ type: 'stolen', thief: 0, victim: 1, resource: 'wheat', ...extra });
const robberMoved: GameEvent = { type: 'robberMoved', player: 0, from: null, to: 4 };
const corsairMoved = { type: 'sea/corsairMoved', player: 0, from: null, to: 0 } as unknown as GameEvent;

describe('a theft and the piece it goes by way of', () => {
  const s = beginnerGame();

  it('goes straight from the hand when something other than a blocker made it', () => {
    for (const by of ['fish', 'almanac', 'warden', 'venture', 'seven'] as const) {
      // (Even right after a blocker moved, and with one standing by the victim.)
      expect(blockerOf(stolen({ by }), [robberMoved, stolen({ by })], 1, s)).toBeNull();
    }
  });

  it('goes by way of the blocker that moved just before it', () => {
    expect(blockerOf(stolen(), [robberMoved, stolen()], 1, s)).toBe('robber');
    expect(blockerOf(stolen(), [corsairMoved, stolen()], 1, s)).toBe('corsair');
  });

  it('when the thief chose their victim in a move of their own, goes by the blocker beside that victim', () => {
    // The robber stands on a hex where the victim has a building.
    const hex = s.board.hexes.find((h) => h.vertices.some((v) => s.buildings[v]?.owner === 1))!;
    const robbing = patch(s, (x) => {
      x.robberHex = hex.id;
    });
    expect(blockerOf(stolen(), [stolen()], 0, robbing)).toBe('robber');
    // The corsair rides a sea hex whose edge carries the victim's ship, the robber stands elsewhere.
    const sea = patch(s, (x) => {
      const h = x.board.hexes.find((q) => q.vertices.every((v) => !x.buildings[v] || x.buildings[v]!.owner !== 1))!;
      x.robberHex = h.id;
      x.routes[h.edges[0]] = { ...road(1), kind: 'ship' };
      x.ext.sea = { shipsLeft: [15, 15, 15, 15], movedTurn: [-1, -1, -1, -1], corsair: h.id };
    });
    expect(blockerOf(stolen(), [stolen()], 0, sea)).toBe('corsair');
    // Neither standing by the victim: nothing lifts it.
    const none = patch(s, (x) => {
      x.robberHex = null;
    });
    expect(blockerOf(stolen(), [stolen()], 0, none)).toBeNull();
  });
});
