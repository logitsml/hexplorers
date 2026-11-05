// Running statistics for the end-of-game summary: how often each total was rolled and
// how many cards each player collected from production and the robber.

import type { GameEvent } from '../engine';

export interface GameStats {
  /** Index = dice total (2..12). */
  rolls: number[];
  /** Resource cards each player received from production. */
  produced: Record<number, number>;
  /** Cards each player stole with the robber. */
  stolen: Record<number, number>;
}

export function emptyStats(): GameStats {
  return { rolls: new Array(13).fill(0), produced: {}, stolen: {} };
}

export function addEvents(stats: GameStats, events: GameEvent[]) {
  for (const e of events) {
    if (e.type === 'diceRolled') stats.rolls[e.total]++;
    else if (e.type === 'production') for (const g of e.grants) stats.produced[g.player] = (stats.produced[g.player] ?? 0) + g.amount;
    else if (e.type === 'stolen') stats.stolen[e.thief] = (stats.stolen[e.thief] ?? 0) + 1;
  }
}
