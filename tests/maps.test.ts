import { describe, expect, it } from 'vitest';
import { buildBoard, createGame, dealBoard, isLand } from '../src/engine';
import { islandCoords } from '../src/engine/board';
import { ALL_HANDS, mixOf } from '../src/engine/presets';
import { runBotGame, runFuzzGame, setups } from './sim-harness';
import { slow, timeout } from './tier';

// The All Hands map is dealt on its outline (maps/atlas.ts), every feature by the home island's
// rules, which tests/island.test.ts holds it to; here, the outline itself.
describe('the All Hands map', () => {
  it('is the classic island at home and islets of three, five and three, one sea hex off, with sea all round', () => {
    const mix = mixOf(ALL_HANDS);
    for (const seed of [1, 2, 3]) {
      const b = buildBoard(dealBoard(4, { seed, modules: mix.modules, map: 'allHands', knobs: mix.knobs }));
      const home = b.islands.find((i) => i.home)!;
      const islets = b.islands.filter((i) => !i.home);
      const steps = (a: number, c: number) => {
        const [h, k] = [b.hexes[a], b.hexes[c]];
        return (Math.abs(h.q - k.q) + Math.abs(h.r - k.r) + Math.abs(h.q + h.r - k.q - k.r)) / 2;
      };
      expect(home.hexes.map((h) => `${b.hexes[h].q},${b.hexes[h].r}`).sort()).toEqual(islandCoords().map(([q, r]) => `${q},${r}`).sort());
      expect(islets.map((i) => i.hexes.length).sort()).toEqual([3, 3, 5]);
      for (const i of islets) expect(Math.min(...i.hexes.flatMap((h) => home.hexes.map((g) => steps(h, g))))).toBe(2);
      // Every land hex has all six neighbours on the board, so ships can sail right round.
      for (const h of b.hexes) if (isLand(h.terrain)) expect(h.neighbors).toHaveLength(6);
    }
  });

  slow('plays a base game to the end', () => {
    // (No modules: the core alone on a map with sea and islets.)
    createGame(setups(4), { map: 'allHands', seed: 5 });
    for (let g = 0; g < 4; g++) {
      const res = runBotGame({ seed: 900 + g, players: g % 2 ? 3 : 4, layout: 'random', options: { map: 'allHands' }, difficulties: ['normal', 'hard', 'easy', 'normal'] });
      expect(res.winner).not.toBeNull();
      expect(res.fallbacks).toBe(0);
    }
    runFuzzGame(41, 4, 'random', 1500, false, { map: 'allHands' });
  }, timeout(60_000));
});

describe('the beginner layout', () => {
  it('is the classic island’s: on another map it is refused, with a reason', () => {
    expect(() => createGame(setups(4), { layout: 'beginner', map: 'strait', modules: ['sea'], seed: 3 })).toThrow(/beginner set-up is the classic island/);
  });

  it('gives the modules’ own starting grants, as a set-up played out does (oil from a well)', () => {
    let granted = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { state: s, events } = createGame(setups(4), { layout: 'beginner', modules: ['oil'], seed });
      const grants = events.flatMap((e) => (e.type === 'oil/startingOil' ? [e] : []));
      expect(s.players.map((p) => p.hand.oil)).toEqual(s.players.map((p) => grants.filter((g) => g.player === p.id).reduce((n, g) => n + g.amount, 0)));
      granted += grants.length;
    }
    // (Some seed puts a well beside a second building.)
    expect(granted).toBeGreaterThan(0);
  });
});
