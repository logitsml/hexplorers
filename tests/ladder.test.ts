// Difficulty ladder: how far apart the bot levels play. Each board seats two bots of one level and
// two of the other, alternating (ABAB, then BABA on the same board), so board and seat luck cancel and
// a fair split is 0.5. Mirror games (all four seats one level) give each level's pace: the rounds it
// takes to reach the target. Skipped in the usual run:
//
//   LADDER=1 N=200 npx vitest run tests/ladder.test.ts --silent=false
//   (PAIRS=easy:normal,normal:hard to pick the matchups, SEED=… for other boards, MIRROR=0 to skip the pace games,
//    A='{"noise":0.2}' / B='{…}' to lay a profile change over the first / second level of every pair)

import { it } from 'vitest';
import { applyAction, createGame, type GameState } from '../src/engine';
import { PROFILES, botDecide, createBotMemory, type BotDifficulty, type BotProfile } from '../src/engine/ai';
import { newGame, setups } from './sim-harness';
import { timeout } from './tier';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

interface Seat {
  diff: BotDifficulty;
  prof: BotProfile;
}

function play(seed: number, layout: 'beginner' | 'random', seats: Seat[]): { winner: number | null; rounds: number } {
  const n = seats.length;
  let s: GameState = createGame(setups(n), newGame(n, { layout, seed })).state;
  const mem = s.players.map(() => createBotMemory());
  while (s.phase !== 'gameOver' && s.turn < 600) {
    let acted = false;
    for (let i = 0; i < n && !acted; i++) {
      const p = (s.seq + i) % n;
      const a = botDecide(s, p, mem[p], seats[p].diff, seats[p].prof);
      if (!a) continue;
      const r = applyAction(s, p, a);
      if (!r.ok) throw new Error(`seed ${seed}: ${r.error}`);
      s = r.state;
      acted = true;
    }
    if (!acted) throw new Error(`seed ${seed}: no one could move`);
  }
  return { winner: s.winner, rounds: s.turn / n };
}

it.skipIf(!env.LADDER)('measures the gaps between bot levels', () => {
  const boards = Number(env.N ?? 100);
  const first = Number(env.SEED ?? 5000);
  const pairs = (env.PAIRS ?? 'easy:normal,normal:hard').split(',').map((p) => p.split(':') as [BotDifficulty, BotDifficulty]);
  const over = (d: BotDifficulty, j: string | undefined): Seat => ({ diff: d, prof: { ...PROFILES[d], ...JSON.parse(j ?? '{}') } });
  for (const [a, b] of pairs) {
    const A = over(a, env.A), B = over(b, env.B);
    let winsA = 0, games = 0;
    const roundsA: number[] = [], roundsB: number[] = [];
    for (let k = 0; k < boards; k++) {
      const layout = k % 2 ? 'random' : 'beginner';
      for (const seats of [[A, B, A, B], [B, A, B, A]]) {
        const g = play(first + k, layout, seats);
        games++;
        if (g.winner === null) continue;
        if (seats[g.winner] === A) {
          winsA++;
          roundsA.push(g.rounds);
        } else roundsB.push(g.rounds);
      }
    }
    const rate = winsA / games;
    const se = Math.sqrt((rate * (1 - rate)) / games);
    const mean = (x: number[]) => (x.length ? +(x.reduce((p, q) => p + q, 0) / x.length).toFixed(1) : null);
    console.log('LADDER', JSON.stringify({ a, b, games, winsA, rateA: +rate.toFixed(3), ci95: [+(rate - 1.96 * se).toFixed(3), +(rate + 1.96 * se).toFixed(3)], roundsWhenAWins: mean(roundsA), roundsWhenBWins: mean(roundsB) }));
  }
  if (env.MIRROR === '0') return;
  for (const d of [...new Set(pairs.flat())]) {
    const seat = over(d, undefined);
    const rounds: number[] = [];
    for (let k = 0; k < Math.ceil(boards / 2); k++) rounds.push(play(first + k, k % 2 ? 'random' : 'beginner', [seat, seat, seat, seat]).rounds);
    rounds.sort((p, q) => p - q);
    console.log('PACE', JSON.stringify({ diff: d, games: rounds.length, meanRounds: +(rounds.reduce((p, q) => p + q, 0) / rounds.length).toFixed(1), medianRounds: rounds[rounds.length >> 1] }));
  }
}, timeout(86400000));
