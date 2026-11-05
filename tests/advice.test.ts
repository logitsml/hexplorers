// What the supply dialog says it would take when nothing in your hand can pay (src/ui/advice.ts),
// worked out from the rates the engine gives you.

import { describe, expect, it } from 'vitest';
import { RESOURCES, createGame, tradeRatios } from '../src/engine';
import { supplyNeeds } from '../src/ui/advice';
import { patch } from './helpers';
import { setups } from './sim-harness';

describe('what a trade with the supply takes', () => {
  const base = createGame(setups(4), { seed: 7 }).state;

  it('is four of a kind with no harbour', () => {
    expect(supplyNeeds(RESOURCES, tradeRatios(base, 0))).toBe('You need 4 of one kind to trade.');
  });

  it('names a harbour’s own resource at its rate, after the rest', () => {
    const port = base.board.ports.find((p) => p.type !== 'any')!;
    const s = patch(base, (d) => {
      d.buildings[port.vertices[0]] = { owner: 0, kind: 'settlement' };
    });
    expect(supplyNeeds(RESOURCES, tradeRatios(s, 0))).toBe(`You need 4 of one kind to trade, or 2 ${port.type}.`);
  });

  it('is three of a kind with a 3:1 harbour', () => {
    const port = base.board.ports.find((p) => p.type === 'any')!;
    const s = patch(base, (d) => {
      d.buildings[port.vertices[0]] = { owner: 0, kind: 'settlement' };
    });
    expect(supplyNeeds(RESOURCES, tradeRatios(s, 0))).toBe('You need 3 of one kind to trade.');
  });
});
