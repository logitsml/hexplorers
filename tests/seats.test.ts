// The beginner set-up's seats should be about as good as each other: the person always sits in
// seat 0. The positions were chosen by bot-game win rates (all-hard: 960 games per check).

import { describe, expect } from 'vitest';
import { applyAction, createGame, type GameState } from '../src/engine';
import { botDecide, createBotMemory, type BotDifficulty } from '../src/engine/ai';
import { setups } from './sim-harness';
import { full, timeout } from './tier';

function winner(seed: number, n: 3 | 4, rules?: number): number {
  let s: GameState = createGame(setups(n), { layout: 'beginner', seed, rules }).state;
  const mem = s.players.map(() => createBotMemory());
  const d: BotDifficulty = 'hard';
  while (s.phase !== 'gameOver') {
    const order = [s.currentPlayer, ...s.players.map((p) => p.id).filter((p) => p !== s.currentPlayer)];
    for (const p of s.trade ? [...order.slice(1), order[0]] : order) {
      const a = botDecide(s, p, mem[p], d);
      if (!a) continue;
      const r = applyAction(s, p, a);
      if (!r.ok) throw new Error(r.error);
      s = r.state;
      break;
    }
  }
  return s.winner!;
}

describe('beginner seats', () => {
  full('no seat wins far more or less than its share (all-hard bots)', () => {
    for (const n of [4, 3] as const) {
      const wins = new Array(n).fill(0);
      const games = 160;
      for (let seed = 1; seed <= games; seed++) wins[winner(seed, n)]++;
      // A fair share is 1/n; allow for the noise of 160 games.
      for (const w of wins) {
        expect(w / games).toBeGreaterThan(1 / n - 0.12);
        expect(w / games).toBeLessThan(1 / n + 0.12);
      }
    }
  }, timeout(400_000));
});
