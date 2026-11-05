// One roll presentation, shared by the floating throw, flat map and last-roll readout.
import type { GameEvent } from '../engine';
import type { UIStore } from './store';

/** Gather the later event die without losing how its red die was rolled, even on equal values. */
export function presentedRoll(e: Extract<GameEvent, { type: 'diceRolled' }>, events: readonly GameEvent[], id: number): NonNullable<UIStore['diceRoll']> {
  const event = events.find((o) => o.type === 'guilds/eventDie');
  return { id, dice: e.dice, player: e.player, ...(event ? { event: { face: event.face, red: event.red, independentRed: event.independentRed } } : {}) };
}
