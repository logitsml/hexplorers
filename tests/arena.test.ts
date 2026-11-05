// Bot arena: a profile tried against the difficulty's own, on the same boards. Every board is played
// once per seat with the challenger in that seat and the usual bots in the others, so board and seat
// luck cancel; the challenger's wins are set against its fair share. Skipped in the usual run:
//
//   ARENA=1 PROFILE='{"winSearch":false}' N=200 npx vitest run tests/arena.test.ts --silent=false
//   (DIFF=normal for another level, MIX=allHands for an expansion mix, SEED=… for other boards)
//
// With identical bots every seat's game is the same, so the challenger wins exactly its fair share:
// a change shows only as a difference. (Over 1,500 boards, about ±0.045 of the fair share is noise.)

import { it } from 'vitest';
import { applyAction, createGame, type GameState } from '../src/engine';
import { PROFILES, botDecide, createBotMemory, type BotDifficulty, type BotProfile } from '../src/engine/ai';
import { EXPANSIONS, mixOf, type Expansion } from '../src/engine/presets';
import { newGame, setups } from './sim-harness';
import { timeout } from './tier';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

it.skipIf(!env.ARENA)('sets a profile against the usual bots', () => {
  const diff = (env.DIFF ?? 'hard') as BotDifficulty;
  const challenger: BotProfile = { ...PROFILES[diff], ...JSON.parse(env.PROFILE ?? '{}') };
  const boards = Number(env.N ?? 100);
  const first = Number(env.SEED ?? 1000);
  const mix = env.MIX ? mixOf(env.MIX === 'allHands' ? EXPANSIONS.map((e) => e.id) : (env.MIX.split('+') as Expansion[])) : null;
  const options = mix ? { modules: mix.modules, map: mix.map === 'classic' ? undefined : mix.map, knobs: mix.knobs, victoryPoints: mix.target } : {};
  let wins = 0, games = 0, fair = 0;
  for (let b = 0; b < boards; b++) {
    const n = b % 3 === 2 ? 3 : 4;
    for (let c = 0; c < n; c++) {
      let s: GameState = createGame(setups(n), newGame(n, { layout: b % 2 ? 'random' : 'beginner', seed: first + b, ...options } as never)).state;
      const mem = s.players.map(() => createBotMemory());
      while (s.phase !== 'gameOver' && s.turn < 500) {
        let acted = false;
        for (let i = 0; i < n && !acted; i++) {
          const p = (s.seq + i) % n;
          const a = botDecide(s, p, mem[p], diff, p === c ? challenger : PROFILES[diff]);
          if (!a) continue;
          const r = applyAction(s, p, a);
          if (!r.ok) throw new Error(r.error);
          s = r.state;
          acted = true;
        }
        if (!acted) throw new Error(`board ${first + b}: no one could move`);
      }
      games++;
      fair += 1 / n;
      if (s.winner === c) wins++;
    }
  }
  const rate = wins / games;
  const se = Math.sqrt((rate * (1 - rate)) / games);
  console.log('ARENA', JSON.stringify({ diff, profile: env.PROFILE ?? '{}', mix: env.MIX ?? 'base', games, wins, vsFair: +(wins / fair).toFixed(3), ci95: [+(rate - 1.96 * se).toFixed(3), +(rate + 1.96 * se).toFixed(3)], fairRate: +(fair / games).toFixed(3) }));
}, timeout(86400000));
