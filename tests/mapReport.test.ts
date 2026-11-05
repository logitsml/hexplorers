// A bot report for the maps (docs/maps.md, Checking a map): every map of every pool played by hard
// bots in every seat, so a seat's share of the wins reads the board and the turn order rather than
// the bots. It reports how many games finish, how long they run in rounds, and each seat's share of
// the wins at three seats and at four. A sanity check, not a gate. Skipped in the
// usual run, and it splits into shards to run side by side:
//
//   REPORT=1 SHARD=0/4 N=36 npx vitest run tests/mapReport.test.ts --silent=false
//   (MAPS=isthmus,classic for some maps, PLAYERS=3 for one seat count, SEED=… for other games)
//
// Each map cycles through three mixes of the expansions that shape it. At 18 games a seat count a
// seat's share is good to about ±0.1 (the classic island's own last seat has read 0.28 to 0.46 at
// three seats), so read a share that stays off across seeds, not one batch.

import { it } from 'vitest';
import type { GameState } from '../src/engine';
import { OIL_SUPPLY } from '../src/engine/modules/oil/rules';
import { ALL_HANDS, mixOf, type Expansion } from '../src/engine/presets';
import { runBotGame } from './sim-harness';
import { timeout } from './tier';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const LAND: Expansion[][] = [['rivers', 'caravans', 'fisheries'], ['invasion', 'oil'], ['guilds', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil']];
const SEA: Expansion[][] = [['sea'], ['sea', 'fisheries', 'rivers'], ['sea', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil']];
/** Each map and the mixes it's played under, in turn. */
const MAPS: Record<string, Expansion[][]> = {
  classic: LAND,
  longIsle: LAND,
  isthmus: LAND,
  horseshoe: LAND,
  wild: LAND,
  archipelago: SEA,
  strait: SEA,
  twinIsles: SEA,
  fogBank: SEA,
  lostSea: SEA,
  allHands: [ALL_HANDS],
};

/** Oil leaves the game when it's sequestered or a well is polluted. */
const supply = (s: GameState) => {
  const o = s.ext.oil;
  return o ? { oil: OIL_SUPPLY - o.sequestered.reduce((a, b) => a + b, 0) - o.destroyed } : {};
};

it.skipIf(!env.REPORT)('reports how every map plays', () => {
  const n = Number(env.N ?? 36);
  const [k, of] = (env.SHARD ?? '0/1').split('/').map(Number);
  const ids = (env.MAPS ? env.MAPS.split(',') : Object.keys(MAPS)).filter((_, i) => i % of === k);
  for (const map of ids) {
    let finished = 0;
    const rounds: number[] = [];
    const errors: string[] = [];
    const wins: Record<3 | 4, number[]> = { 3: [0, 0, 0], 4: [0, 0, 0, 0] };
    for (let g = 0; g < n; g++) {
      const expansions = MAPS[map][g % MAPS[map].length];
      const mix = mixOf(expansions, map);
      const players: 3 | 4 = env.PLAYERS ? (Number(env.PLAYERS) as 3 | 4) : g % 2 ? 3 : 4;
      const seed = Number(env.SEED ?? 9100) + g;
      try {
        const res = runBotGame({ seed, players, layout: 'random', options: { modules: mix.modules, map: mix.map === 'classic' ? undefined : mix.map, knobs: mix.knobs, victoryPoints: mix.target }, supply, difficulties: Array(players).fill('hard'), maxTurns: 700 });
        if (res.winner !== null) {
          finished++;
          wins[players][res.winner]++;
        }
        rounds.push(res.turns / players);
      } catch (e) {
        errors.push(`${expansions.join('+')} seed ${seed}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    const mean = rounds.reduce((a, b) => a + b, 0) / Math.max(1, rounds.length);
    const shares = (p: 3 | 4) => {
      const total = wins[p].reduce((a, b) => a + b, 0);
      return total ? wins[p].map((w) => (w / total).toFixed(2)).join(' ') : '-';
    };
    console.log(`${map}: ${finished}/${n} finished, ${mean.toFixed(1)} rounds; wins by seat, four seats ${shares(4)}, three ${shares(3)}${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`);
  }
}, timeout(3_600_000));
