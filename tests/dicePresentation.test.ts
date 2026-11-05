import { describe, expect, it } from 'vitest';
import { mustApply, type GameEvent } from '../src/engine';
import { presentedRoll } from '../src/game/dice';
import { EVENT_VALUE, throwFaces } from '../src/render/fx/eventDie';
import { game, giveVenture } from './modules/guilds-helpers';

function present(events: GameEvent[]) {
  const numbers = events.find((e) => e.type === 'diceRolled');
  if (!numbers) throw new Error('No production roll');
  return presentedRoll(numbers, events, 123);
}

describe('the production pair and the red die', () => {
  it.each(['event deck', 'Almanac'] as const)('carries the independent-red flag from the %s through the presenter, including equal values', (source) => {
    const equal = new Set<boolean>();
    for (let seed = 1; seed <= 40; seed++) {
      const s = game(source === 'Almanac' ? ['guilds', 'almanac'] : ['guilds'], { seed, eventDeck: source === 'event deck' });
      const result = mustApply(s, 0, { type: 'rollDice' });
      const roll = present(result.events);
      const event = roll.event!;
      expect(event.independentRed).toBe(true);
      expect(roll.dice).toEqual(result.state.dice);
      expect(throwFaces(roll.dice, event)).toEqual([...roll.dice, EVENT_VALUE[event.face], event.red]);
      equal.add(event.red === roll.dice[0]);
    }
    expect(equal).toEqual(new Set([false, true]));
  });

  it('keeps a shared red die in the ordinary three-die throw', () => {
    const roll = present(mustApply(game(['guilds']), 0, { type: 'rollDice' }).events);
    expect(roll.event!.independentRed).toBe(false);
    expect(roll.event!.red).toBe(roll.dice[0]);
    expect(throwFaces(roll.dice, roll.event)).toEqual([...roll.dice, EVENT_VALUE[roll.event!.face]]);
  });

  it.each([false, true])('shares the augury’s first die even with card production (Almanac: %s)', (almanac) => {
    let s = game(almanac ? ['guilds', 'almanac'] : ['guilds'], { eventDeck: !almanac });
    giveVenture(s, 0, 'augury');
    s = mustApply(s, 0, { type: 'guilds/play', card: 'augury', dice: [1, 4] }).state;
    const roll = present(mustApply(s, 0, { type: 'rollDice' }).events);
    expect(roll.dice).toEqual([1, 4]);
    expect(roll.event).toMatchObject({ red: 1, independentRed: false });
    expect(throwFaces(roll.dice, roll.event)).toHaveLength(3);
  });

  it('shows the reported mismatched roll without substituting the separate red die', () => {
    const events: GameEvent[] = [
      { type: 'diceRolled', player: 0, dice: [1, 4], total: 5 },
      { type: 'guilds/eventDie', player: 0, face: 'ship', red: 6, independentRed: true },
    ];
    const roll = present(events);
    expect(throwFaces(roll.dice, roll.event)).toEqual([1, 4, 1, 6]);
    expect(roll.dice[0] + roll.dice[1]).toBe(5);
  });

  it('keeps two dice when there is no event throw', () => {
    const roll = present(mustApply(game([]), 0, { type: 'rollDice' }).events);
    expect(roll.event).toBeUndefined();
    expect(throwFaces(roll.dice)).toEqual(roll.dice);
  });
});
