import { describe, expect, it } from 'vitest';
import { applyAction, createGame, handEstimate, victoryTarget, type GameState } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { ALL_HANDS, PRESETS, mixOf, modulesFor } from '../src/engine/presets';
import { runBotGame, runFuzzGame, setups } from './sim-harness';
import { slow, timeout } from './tier';

// The flagship: every in-scope expansion at once on its own map, with the preset's knobs.
const preset = PRESETS.find((p) => p.id === 'allHands')!;
const options = { modules: modulesFor(ALL_HANDS), map: 'allHands', knobs: preset.knobs, victoryPoints: preset.target };
/** Oil leaves the game when it's sequestered or a well is polluted. */
const supply = (s: GameState) => {
  const o = s.ext.oil!;
  return { oil: 15 - o.sequestered.reduce((a, b) => a + b, 0) - o.destroyed };
};

describe('All Hands', () => {
  it('is the whole flagship: ten modules on its map, to 21, with no robber and the raider fleet left out', () => {
    const mix = mixOf(ALL_HANDS);
    expect(mix.modules).toEqual(['sea', 'guilds', 'garrisons', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster']);
    expect(mix.map).toBe('allHands');
    expect(mix.target).toBe(21);
    const s = createGame(setups(4), { ...options, seed: 1 }).state;
    expect(s.robberHex).toBeNull();
    expect(s.ext.sea!.corsair).toBeNull();
    expect(victoryTarget(s, 0)).toBe(21);
    // A raider waits on each coastal hex bearing the 2 or the 12.
    const raided = s.ext.invasion!.raiders.flatMap((n, h) => (n > 0 ? [h] : []));
    expect(raided.length).toBeGreaterThan(0);
    for (const h of raided) expect(s.board.hexes[h].numbers.some((n) => n === 2 || n === 12)).toBe(true);
    expect(raided.flatMap((h) => s.board.hexes[h].numbers).filter((n) => n === 2 || n === 12).sort((a, b) => a - b)).toEqual([2, 12]);
    // The islets pay their first landings (the target counts on them).
    expect(s.ext.sea!.landed).toEqual([[], [], [], []]);
  });

  slow('plays to a finish with bots at three and four seats, with no fall-backs', () => {
    for (let g = 0; g < 8; g++) {
      const n = g % 2 ? 3 : 4;
      const r = runBotGame({ seed: 4400 + g, players: n as 3 | 4, layout: 'random', options, supply, difficulties: ['normal', 'hard', 'easy', 'normal'], crossCheckLegal: g < 2 });
      expect(r.winner).not.toBeNull();
      expect(r.fallbacks).toBe(0);
    }
  }, timeout(180000));

  slow('lets every seat follow the expansions’ open card moves exactly, until a theft hides one', () => {
    let moves = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      let s = createGame(setups(4), { ...options, seed }).state;
      const mem = s.players.map(() => createBotMemory());
      for (let step = 0; step < 3000 && s.phase !== 'gameOver'; step++) {
        let next: ReturnType<typeof applyAction> | null = null;
        for (let p = 0; p < 4 && !next; p++) {
          const a = botDecide(s, p, mem[p], 'hard');
          if (a) next = applyAction(s, p, a);
        }
        if (!next?.ok) throw new Error(next ? next.error : 'no bot acted');
        s = next.state;
        // (Only the thief and the victim see what a theft takes: from then on the others guess.)
        if (next.events.some((e) => e.type === 'stolen')) break;
        moves += next.events.filter((e) => e.type === 'cardsMoved').length;
        for (const v of [0, 1, 2, 3, null]) for (const p of s.players) expect(handEstimate(s, v, p.id).sure).toEqual(p.hand);
      }
    }
    expect(moves).toBeGreaterThan(20);
  }, timeout(60000));

  slow('applies every action it offers', () => {
    runFuzzGame(91, 4, 'random', 1500, true, options, supply);
    runFuzzGame(92, 3, 'random', 2500, false, options, supply);
  }, timeout(180000));
});
