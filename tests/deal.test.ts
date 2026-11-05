// A new game's board is dealt once and carried in its options (engine/maps/deal.ts): the same seed
// deals the same board, a game builds the board it carries whatever its seed, the carried board is
// checked and kept from other seats, and a game given no board deals the one it would carry.

import { describe, expect, it } from 'vitest';
import { buildBoard, createGame, dealBoard, redactState, validateOptions, withBoard, type BoardSpec, type GameOptions } from '../src/engine';
import { DEFAULT_OPTIONS } from '../src/engine/setup';
import { coastOf, homeLand } from '../src/engine/maps/shape';
import { boardProblems } from '../src/engine/maps/stored';
import { mixOf, PRESETS, type Expansion } from '../src/engine/presets';
import { setups } from './sim-harness';

const json = (x: unknown) => JSON.stringify(x);

describe('dealing a new game’s board', () => {
  it('deals the same board from the same seed and options, and another from another seed', () => {
    for (const chosen of [[], ['sea'], ['sea', 'rivers', 'fisheries', 'oil'], ['invasion', 'caravans'], PRESETS[0].expansions] as Expansion[][]) {
      const mix = mixOf(chosen);
      const opts = { modules: mix.modules, map: mix.map, knobs: mix.knobs };
      for (const players of [3, 4]) {
        expect(json(dealBoard(players, { ...opts, seed: 41 }))).toBe(json(dealBoard(players, { ...opts, seed: 41 })));
        // (All Hands is one board; every other map deals afresh.)
        if (mix.map !== 'allHands') expect(json(dealBoard(players, { ...opts, seed: 41 }))).not.toBe(json(dealBoard(players, { ...opts, seed: 42 })));
      }
    }
  });

  it('builds the board a game carries, whatever its seed says', () => {
    const opts = { modules: mixOf(['sea', 'oil']).modules, map: 'archipelago', seed: 7 };
    const carried = dealBoard(4, opts);
    const game = createGame(setups(4), { ...opts, seed: 8, board: carried }).state;
    expect(json(game.board)).toBe(json(buildBoard(carried)));
    expect(json(game.board)).not.toBe(json(createGame(setups(4), withBoard(4, { ...opts, seed: 8 })).state.board));
    // The options keep their board as it was given.
    expect(game.options.board).toEqual(carried);
  });

  it('deals the same board inside createGame when none is carried', () => {
    // (One way of dealing: a game given no board deals the one a new game's options would carry.)
    const given = createGame(setups(4), { seed: 5, modules: ['invasion'] }).state;
    const fresh = createGame(setups(4), withBoard(4, { seed: 5, modules: ['invasion'] })).state;
    expect(given.options.board).toBeUndefined();
    expect(json(given.board)).toBe(json(fresh.board));
    expect(given.rngState).toBe(fresh.rngState);
  });

  it('refuses a carried board that can’t be built, saying why', () => {
    const good = dealBoard(4, { seed: 3 });
    const bad = (board: unknown) => () => validateOptions({ ...DEFAULT_OPTIONS, playerCount: 4, board: board as BoardSpec } as GameOptions);
    expect(bad(good)).not.toThrow();
    expect(bad({ ...good, hexes: [...good.hexes, good.hexes[0]] })).toThrow(/Two hexes/);
    expect(bad({ ...good, hexes: good.hexes.map((h, i) => (i === 0 ? { ...h, numbers: [7] } : h)) })).toThrow(/no dice can roll/);
    expect(bad({ ...good, ports: [{ q: 0, r: 0, side: 0, type: 'any' }] })).toThrow(/faces land/);
    expect(bad({ ...good, rivers: [{ path: [[-2, 0], [0, 0]], mouthSide: 3 }] })).toThrow(/neighbouring/);
    expect(bad({ hexes: 'no' })).toThrow(/no hexes/);
    expect(boardProblems(good)).toEqual([]);
  });

  it('keeps the carried board from every seat: it holds what lies under the fog', () => {
    const s = createGame(setups(4), withBoard(4, { seed: 9, modules: ['sea'], map: 'fogBank' })).state;
    expect(s.options.board?.objectives?.some((o) => o.id === 'fog')).toBe(true);
    for (const viewer of [0, null]) expect(redactState(s, viewer).options.board).toBeUndefined();
  });
});

describe('Invasion’s coast on the classic island', () => {
  const deal = (seed: number, chosen: Expansion[] = ['invasion']) => {
    const mix = mixOf(chosen);
    return dealBoard(4, { seed, modules: mix.modules, map: mix.map, knobs: mix.knobs });
  };
  const at = (spec: BoardSpec, q: number, r: number) => spec.hexes.find((h) => h.q === q && h.r === r)!;

  it('deals its numbers afresh every game, where the old layout printed one', () => {
    for (const chosen of [['invasion'], PRESETS.find((p) => p.id === 'siege')!.expansions] as Expansion[][]) {
      const layouts = new Set(Array.from({ length: 40 }, (_, i) => json(deal(1000 + i, chosen).hexes.map((h) => h.numbers))));
      expect(layouts.size).toBeGreaterThanOrEqual(38);
    }
  });

  it('keeps the castle on the lower-left corner, the desert on the corner opposite, and a different number on every coastal hex', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const spec = deal(seed);
      expect(spec.castle).toEqual([-2, 2]);
      expect(at(spec, -2, 2).terrain).toBe('castle');
      expect(at(spec, 2, -2).terrain).toBe('desert');
      const home = homeLand(spec);
      const coast = home.filter(coastOf(spec, home)).filter((h) => h.numbers.length > 0);
      const numbers = coast.flatMap((h) => h.numbers);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect([...numbers].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
    }
  });

  it('plays: a game dealt this way starts with a raider on the 2 and the 12', () => {
    const s = createGame(setups(4), withBoard(4, { seed: 77, modules: ['invasion'] })).state;
    const raided = s.ext.invasion!.raiders.flatMap((n, h) => (n > 0 ? s.board.hexes[h].numbers : []));
    expect(raided).toEqual(expect.arrayContaining([2, 12]));
  });
});
