import { describe, expect, it } from 'vitest';
import { actionOf, bind, dragJob, keyLabel, keysOf, sanitizeKeys, sanitizeMouse, DEFAULT_MOUSE } from '../src/game/bindings';

describe('key bindings', () => {
  it('answers to the usual keys until one is chosen', () => {
    expect(actionOf('Space', {})).toBe('roll');
    expect(actionOf('NumpadEnter', {})).toBe('endTurn');
    expect(actionOf('KeyW', {})).toBe('panUp');
    expect(actionOf('KeyZ', {})).toBeNull();
  });

  it('gives a chosen key to one action only', () => {
    // T to roll: Trade loses T, Space no longer rolls.
    const b = bind({}, 'roll', 'KeyT');
    expect(actionOf('KeyT', b)).toBe('roll');
    expect(actionOf('Space', b)).toBeNull();
    expect(keysOf('trade', b)).toEqual([]);
    // (Back to the usual key: nothing left to remember for it.)
    expect(bind(b, 'roll', 'Space').roll).toBeUndefined();
  });

  it('keeps an action its other default when one of its keys is taken', () => {
    const b = bind({}, 'mute', 'Enter');
    expect(keysOf('endTurn', b)).toEqual(['NumpadEnter']);
    expect(actionOf('Enter', b)).toBe('mute');
  });

  it('drops stored keys that are unknown or fixed', () => {
    expect(sanitizeKeys({ roll: 'KeyG', road: 'Escape', nope: 'KeyX', town: 7, house: '' })).toEqual({ roll: 'KeyG', house: '' });
    expect(sanitizeKeys(null)).toEqual({});
  });

  it('names keys as keyboards print them', () => {
    expect(keyLabel('KeyQ')).toBe('Q');
    expect(keyLabel('Digit2')).toBe('2');
    expect(keyLabel('Numpad1')).toBe('Num 1');
    expect(keyLabel('Equal')).toBe('=');
    expect(keyLabel('')).toBe('None');
  });
});

describe('mouse bindings', () => {
  it('moves the map with the left and middle buttons and turns with the right by default', () => {
    expect([0, 1, 2, 3].map((b) => dragJob(b, DEFAULT_MOUSE))).toEqual(['pan', 'pan', 'turn', null]);
  });

  it('keeps only known jobs from a save', () => {
    expect(sanitizeMouse({ left: 'turn', middle: 'spin' })).toEqual({ left: 'turn', middle: 'pan', right: 'turn' });
  });
});
