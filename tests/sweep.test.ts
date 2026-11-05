// A sweep of every mix the set-up page can make: each combination of expansions on each map its pool
// offers, its board dealt as a new game's is, played by bots (every move checked against the legal
// list) and by the fuzzer, with every invariant checked after every action. Too slow for the usual run, so it's opt-in, and it
// splits into shards to run side by side:
//
//   SWEEP=1 SHARD=0/6 GAMES=2 npx vitest run tests/sweep.test.ts --silent=false   (SEED=… for fresh seeds)
//
// Shards count from 0, so six of them are 0/6 to 5/6.
//
// It reports every failure rather than stopping at the first.

import { expect, it } from 'vitest';
import { withBoard, type GameState } from '../src/engine';
import { OIL_SUPPLY } from '../src/engine/modules/oil/rules';
import { mixOf } from '../src/engine/presets';
import { mixes, runBotGame, runFuzzGame } from './sim-harness';
import { timeout } from './tier';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/** Oil leaves the game when it's sequestered or a well is polluted. */
const supply = (s: GameState) => {
  const o = s.ext.oil;
  return o ? { oil: OIL_SUPPLY - o.sequestered.reduce((a, b) => a + b, 0) - o.destroyed } : {};
};

it.skipIf(!env.SWEEP)('plays every mix to a finish, and applies every action it offers', () => {
  const [k, n] = (env.SHARD ?? '0/1').split('/').map(Number);
  // (A shard past the last would play nothing and pass.)
  if (!(Number.isInteger(k) && Number.isInteger(n) && k >= 0 && k < n)) throw new Error(`SHARD=${env.SHARD}: shards count from 0, as 0/${n} to ${n - 1}/${n}.`);
  const games = Number(env.GAMES ?? 2);
  const all = mixes();
  const mine = all.filter((_, i) => i % n === k);
  const failures: string[] = [];
  let played = 0;
  for (const [i, m] of mine.entries()) {
    const mix = mixOf(m.chosen, m.map);
    const options = { modules: mix.modules, map: mix.map === 'classic' ? undefined : mix.map, knobs: mix.knobs, victoryPoints: mix.target };
    const seed = Number(env.SEED ?? 5000) + all.indexOf(m) * 7;
    // (The board as the set-up page deals it for a new game, from the game's own seed and options.)
    const dealt = (players: 3 | 4, at: number, numberPlacement: 'spiral' | 'balanced') => withBoard(players, { ...options, seed: at, layout: 'random' as const, numberPlacement });
    for (let g = 0; g < games; g++) {
      try {
        const players = g % 2 ? 3 : 4;
        const r = runBotGame({ seed: seed + g, players, layout: 'random', options: dealt(players, seed + g, 'spiral'), supply, difficulties: ['normal', 'hard', 'easy', 'normal'], crossCheckLegal: true });
        if (r.fallbacks > 0) failures.push(`${m.label} seed ${seed + g}: ${r.fallbacks} fall-backs`);
        played++;
      } catch (e) {
        failures.push(`${m.label} bots seed ${seed + g}: ${(e as Error).message.slice(0, 400)}`);
      }
    }
    try {
      runFuzzGame(seed, i % 2 ? 3 : 4, 'random', 800, true, dealt(i % 2 ? 3 : 4, seed, seed % 2 ? 'balanced' : 'spiral'), supply);
    } catch (e) {
      failures.push(`${m.label} fuzz seed ${seed}: ${(e as Error).message.slice(0, 400)}`);
    }
  }
  console.log(`SWEEP shard ${k}/${n}: ${mine.length} mixes, ${played} bot games, ${failures.length} failures`);
  for (const f of failures) console.log('FAIL', f);
  expect(failures).toEqual([]);
}, timeout(3_600_000));
