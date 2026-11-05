import { afterAll, describe, expect } from 'vitest';
import type { BotDifficulty } from '../src/engine/ai';
import { runBotGame, runFuzzGame, type GameResult } from './sim-harness';
import { games, slow, timeout } from './tier';

const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];
const results: GameResult[] = [];

function difficultiesFor(g: number, n: number): BotDifficulty[] {
  switch (g % 5) {
    case 0:
      return Array(n).fill('hard');
    case 1:
      return Array(n).fill('normal');
    case 2:
      return Array(n).fill('easy');
    default:
      return Array.from({ length: n }, (_, i) => DIFFS[(g + i) % 3]);
  }
}

function playMany(count: number, players: 3 | 4, seedBase: number) {
  for (let g = 0; g < count; g++) {
    const seed = seedBase + g;
    const layout = g % 2 === 0 ? 'beginner' : 'random';
    const res = runBotGame({
      seed,
      players,
      layout,
      numberPlacement: g % 4 === 1 ? 'balanced' : 'spiral',
      difficulties: difficultiesFor(g, players),
      crossCheckLegal: g % 10 === 0,
    });
    expect(res.winner).not.toBeNull();
    expect(res.fallbacks).toBe(0);
    results.push(res);
  }
}

describe('bot-only games', () => {
  // (The seatings, layouts and number placements go round every 60 games, and every 20 but for
  // which seat gets which difficulty in a mixed game: the usual tier keeps those spreads.)
  slow(`${games(150, 60)} four-player games finish with every invariant intact`, () => {
    playMany(games(150, 60), 4, 1000);
  }, timeout(120_000));

  slow(`${games(50, 20)} three-player games finish with every invariant intact`, () => {
    playMany(games(50, 20), 3, 5000);
  }, timeout(120_000));
});

describe('random legal-action fuzzer', () => {
  slow('every enumerated action applies and invariants hold', () => {
    let checked = 0;
    let steps = 0;
    for (let g = 0; g < 10; g++) {
      const r = runFuzzGame(9000 + g, g % 3 === 0 ? 3 : 4, g % 2 ? 'random' : 'beginner', 600, true);
      checked += r.checkedActions;
      steps += r.steps;
    }
    for (let g = 0; g < 12; g++) {
      const r = runFuzzGame(9500 + g, g % 3 === 0 ? 3 : 4, 'random', 2500, false);
      steps += r.steps;
    }
    console.log(`fuzz: ${steps} steps, ${checked} legal actions verified`);
    expect(checked).toBeGreaterThan(10000);
  }, timeout(120_000));
});

afterAll(() => {
  if (results.length === 0) return;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const lines: string[] = [];
  for (const n of [4, 3]) {
    const rs = results.filter((r) => r.players === n);
    if (rs.length === 0) continue;
    const seatWins = Array(n).fill(0);
    for (const r of rs) seatWins[r.winner!]++;
    lines.push(
      `${n}p: ${rs.length} games, avg ${avg(rs.map((r) => r.turns)).toFixed(1)} turns (min ${Math.min(...rs.map((r) => r.turns))}, max ${Math.max(
        ...rs.map((r) => r.turns),
      )}), avg ${avg(rs.map((r) => r.actions)).toFixed(0)} actions, seat wins ${seatWins.join('/')}`,
    );
    for (const d of DIFFS) {
      const solo = rs.filter((r) => r.difficulties.every((x) => x === d));
      if (solo.length) lines.push(`  all-${d}: avg ${avg(solo.map((r) => r.turns)).toFixed(1)} turns over ${solo.length} games`);
    }
  }
  const mixed = results.filter((r) => new Set(r.difficulties).size > 1);
  const seats: Record<string, { seats: number; wins: number }> = {};
  for (const r of mixed) {
    r.difficulties.forEach((d, i) => {
      seats[d] ??= { seats: 0, wins: 0 };
      seats[d].seats++;
      if (r.winner === i) seats[d].wins++;
    });
  }
  lines.push(
    `mixed games (${mixed.length}): ` +
      DIFFS.map((d) => `${d} ${seats[d]?.wins ?? 0}/${seats[d]?.seats ?? 0} seats won (${(((seats[d]?.wins ?? 0) / (seats[d]?.seats || 1)) * 100).toFixed(0)}%)`).join(', '),
  );
  const calls = results.reduce((a, r) => a + r.decideCalls, 0);
  const ms = results.reduce((a, r) => a + r.decideMs, 0);
  lines.push(
    `botDecide: ${calls} calls, avg ${(ms / calls).toFixed(3)} ms, max ${Math.max(...results.map((r) => r.maxDecideMs)).toFixed(1)} ms; ` +
      `offers ${results.reduce((a, r) => a + r.offers, 0)}, domestic trades ${results.reduce((a, r) => a + r.tradesExecuted, 0)}; ` +
      `off-turn target reachers ${results.reduce((a, r) => a + r.offTurnReachers.length, 0)}`,
  );
  console.log('\n' + lines.join('\n'));
});
