// Games the sweep of every mix (tests/sweep.test.ts) found broken: each failed before its fix and
// must keep finishing cleanly. The last two play the mixes and seeds they were found with on the
// current dealing (the warden's bug has a test of its own in tests/modules/garrisons.test.ts).

import { describe, expect, it } from 'vitest';
import { createGame, type GameState } from '../src/engine';
import { topology } from '../src/engine/modules/invasion/topology';
import { OIL_SUPPLY } from '../src/engine/modules/oil/rules';
import { mixOf, type Expansion } from '../src/engine/presets';
import { runBotGame, runFuzzGame, setups } from './sim-harness';
import { slow, timeout } from './tier';

const supply = (s: GameState) => {
  const o = s.ext.oil;
  return o ? { oil: OIL_SUPPLY - o.sequestered.reduce((a, b) => a + b, 0) - o.destroyed } : {};
};
const optionsOf = (chosen: Expansion[], seaMap?: string) => {
  const mix = mixOf(chosen, seaMap);
  return { modules: mix.modules, map: mix.map === 'classic' ? undefined : mix.map, knobs: mix.knobs, victoryPoints: mix.target };
};

describe('sweep regressions', () => {
  it('parts the reds before wells can hold a clash in place', () => {
    // The classic pasture well kept a red neighbour at seed 91. On the crowded archipelago,
    // the two wells touched at 81, and one well held both a 6 and an 8 at 173.
    const cases: [number, Expansion[], string?][] = [
      [91, ['invasion', 'fisheries', 'oil']],
      [81, ['sea', 'invasion', 'rivers', 'caravans', 'oil'], 'archipelago'],
      [173, ['sea', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil'], 'archipelago'],
    ];
    for (const [seed, chosen, seaMap] of cases) {
      const b = createGame(setups(3), { seed, layout: 'random', ...optionsOf(chosen, seaMap) }).state.board;
      for (const h of b.hexes.filter((h) => h.numbers.some((n) => n === 6 || n === 8))) {
        expect(h.numbers.filter((n) => n === 6 || n === 8)).toHaveLength(1);
        expect(h.neighbors.some((n) => b.hexes[n].numbers.some((x) => x === 6 || x === 8))).toBe(false);
      }
    }
  });

  it('gives a crowded coast its missing landing number on a second disc', () => {
    // Both maps had only nine distinct coastal numbers at seed 2. The spare disc must be
    // one omitted by the coastal deal, so rehoming it supplies the tenth landing number.
    for (const seaMap of [undefined, 'archipelago']) {
      const chosen: Expansion[] = [...(seaMap ? ['sea' as const] : []), 'invasion', 'rivers'];
      const b = createGame(setups(3), { seed: 2, layout: 'random', ...optionsOf(chosen, seaMap) }).state.board;
      expect(new Set(topology(b).coast.flatMap((h) => b.hexes[h].numbers)).size).toBe(10);
    }
  });

  slow('a warden never chases the corsair onto a face-down hex (found on the hidden shores)', () => {
    runFuzzGame(6288, 3, 'random', 800, true, optionsOf(['sea', 'guilds', 'fisheries', 'almanac'], 'fogBank'), supply);
  }, timeout(60_000));

  slow('a bot with nothing left to build fights for the prisoners that would win it the game', () => {
    // (Every coastal hex fell, and the leader sat one point short with every piece placed.)
    const r = runBotGame({ seed: 7451, players: 3, layout: 'random', options: optionsOf(['sea', 'guilds', 'invasion', 'caravans', 'fisheries', 'harbourmaster'], 'archipelago'), supply, difficulties: ['normal', 'hard', 'easy', 'normal'] });
    expect(r.winner).not.toBeNull();
    expect(r.fallbacks).toBe(0);
  }, timeout(60_000));
});
