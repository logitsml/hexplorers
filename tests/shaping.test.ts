// The expansions' geography on every map. Each module shapes the home island (rule 10) wherever
// it's played, and every map has room for every module.
// Fishing the Archipelago once played with no lake and no fishing grounds at all, because the
// shaping ran only on the classic island: these tests are the guard against that coming back.

import { describe, expect, it } from 'vitest';
import { createGame, isLand, type Board, type GameState } from '../src/engine';
import { missingFeatures } from '../src/engine/maps/features';
import { buildBoard, type BoardSpec } from '../src/engine/board';
import { coastOf, homeLand, partReds, redsTouch } from '../src/engine/maps/shape';
import { placeWells } from '../src/engine/modules/oil/map';
import { topology } from '../src/engine/modules/invasion/topology';
import { MAP_INFO } from '../src/engine/maps';
import { EXPANSIONS, PRESETS, mixOf, modulesFor, poolFor, type Expansion } from '../src/engine/presets';
import { Rng } from '../src/engine/rng';
import type { ModuleId } from '../src/engine/types';
import { cardsInPlay, runBotGame, setups } from './sim-harness';
import { FULL, games, slow, timeout } from './tier';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
/** The expansions that shape the map. */
const SHAPED: Expansion[] = ['invasion', 'rivers', 'caravans', 'fisheries', 'oil'];

/** A sea map played for First Landing and one played for Fog (every map's own case is below). */
const SEA_MAPS = ['archipelago', 'fogBank'].map((id) => ({ id, name: MAP_INFO[id].name }));

/** The map a mix plays on `seaMap`: that one with Sea Lanes, unless a preset fixes its own. */
const mapOf = (expansions: readonly Expansion[], seaMap?: string) => {
  const mix = mixOf(expansions, seaMap);
  return seaMap && expansions.includes('sea') && !mix.preset?.map ? seaMap : mix.map;
};

/**
 * A game of a set of expansions as the set-up page starts it (on `seaMap` where Sea Lanes is in and
 * no preset fixes the map, or the map named), its board dealt as a new game's is.
 */
function game(expansions: readonly Expansion[], players: 3 | 4, seed: number, seaMap?: string): GameState {
  const mix = mixOf(expansions, seaMap);
  const options = { seed, layout: 'random' as const, modules: mix.modules, map: mapOf(expansions, seaMap), knobs: mix.knobs, victoryPoints: mix.target };
  return createGame(setups(players), options).state;
}

const onHome = (b: Board, h: number) => isLand(b.hexes[h].terrain) && b.islands[b.hexes[h].island].home;
const red = (numbers: number[]) => numbers.includes(6) || numbers.includes(8);
const grounds = (b: Board) => b.hexes.filter((h) => h.terrain === 'sea' && h.numbers.length > 0);

/** What the board holds of each module's geography, counted here independently of missingFeatures. */
function tally(s: GameState) {
  const b = s.board;
  return {
    lakes: b.hexes.filter((h) => h.terrain === 'lake' && onHome(b, h.id)).length,
    grounds: grounds(b).length,
    wells: b.hexes.filter((h) => h.well && onHome(b, h.id)).length,
    rivers: (b.features.rivers ?? []).filter((r) => b.hexes[r.hexes[r.hexes.length - 1]].terrain === 'swamp').length,
    oasis: b.features.oasis !== undefined && b.hexes[b.features.oasis.hex].terrain === 'oasis' ? 1 : 0,
    castle: b.features.castle !== undefined && b.hexes[b.features.castle].terrain === 'castle' ? 1 : 0,
  };
}

/** The geography each module needs: a lake and six grounds, three wells, two rivers, an oasis, a castle. */
function expected(modules: readonly ModuleId[]) {
  const has = (m: ModuleId) => modules.includes(m);
  return { lakes: has('fisheries') ? 1 : 0, grounds: has('fisheries') ? 6 : 0, wells: has('oil') ? 3 : 0, rivers: has('rivers') ? 2 : 0, oasis: has('caravans') ? 1 : 0, castle: has('invasion') ? 1 : 0 };
}

interface Case {
  name: string;
  expansions: Expansion[];
  seaMap?: string;
}

/** Every preset; every expansion alone, on the classic island and with Sea Lanes on each sea map; every pair of the map-shaping five, and all five, on each map. */
const CASES: Case[] = [
  ...PRESETS.map((p) => ({ name: `the ${p.name} preset`, expansions: p.expansions })),
  ...EXPANSIONS.filter((e) => e.id !== 'sea').map((e) => ({ name: `${e.name} alone`, expansions: [e.id] })),
  ...SEA_MAPS.flatMap((m) => EXPANSIONS.map((e) => ({ name: `${e.name} on the ${m.name}`, expansions: e.id === 'sea' ? ['sea' as Expansion] : ['sea' as Expansion, e.id], seaMap: m.id }))),
  ...[undefined, ...SEA_MAPS.map((m) => m.id)].flatMap((seaMap) => {
    const sea: Expansion[] = seaMap ? ['sea'] : [];
    const where = seaMap ? `on the ${seaMap}` : 'on the classic island';
    const pairs = SHAPED.flatMap((a, i) => SHAPED.slice(i + 1).map((b) => ({ name: `${a} with ${b} ${where}`, expansions: [...sea, a, b], seaMap })));
    return [...pairs, { name: `all five map-shaping expansions ${where}`, expansions: [...sea, ...SHAPED], seaMap }];
  }),
];

describe('every module finds its geography on every map', () => {
  for (const c of CASES) {
    const map = mapOf(c.expansions, c.seaMap);
    it(`${c.name} (${map})`, () => {
      for (const players of [3, 4] as const) {
        for (const seed of SEEDS.slice(0, games(SEEDS.length, 2))) {
          const s = game(c.expansions, players, seed, c.seaMap);
          expect(missingFeatures(s.board, s.options.modules)).toEqual([]);
          expect(tally(s)).toEqual(expected(s.options.modules));
        }
      }
    });
  }

  it('offers every map of its pool to every mix', () => {
    expect(poolFor([])).toEqual(['classic', 'longIsle', 'isthmus', 'horseshoe', 'wild']);
    for (const e of EXPANSIONS.map((x) => x.id).filter((x) => x !== 'sea')) {
      expect(poolFor(['sea', e])).toEqual(['archipelago', 'strait', 'twinIsles', 'fogBank', 'lostSea']);
      expect(poolFor([e])).toEqual(['classic', 'longIsle', 'isthmus', 'horseshoe', 'wild']);
    }
    expect(CASES.every((c) => mixOf(c.expansions, c.seaMap).playable)).toBe(true);
  });

  it('refuses a game whose map lost a module’s geography', () => {
    // (The All Hands map carries every feature itself; asking it to play a module it doesn't
    // shape is fine, but a check over a featureless board names everything that's missing.)
    const s = createGame(setups(4), { seed: 1, map: 'archipelago', modules: ['sea'] }).state;
    expect(missingFeatures(s.board, ['fisheries', 'oil', 'rivers', 'caravans', 'invasion'])).toEqual([
      'Fisheries needs one lake, and the board has 0',
      'Fisheries needs six fishing grounds, and the board has 0',
      'Oil needs three wells, and the board has 0',
      'Rivers needs two rivers, and the board has 0',
      'Wagon Trains needs an oasis',
      'Invasion needs a castle',
    ]);
  });

  it('shapes the same board from the same seed', () => {
    for (const seaMap of ['archipelago', 'fogBank']) {
      for (const players of [3, 4] as const) expect(JSON.stringify(game(['sea', ...SHAPED], players, 9, seaMap).board)).toBe(JSON.stringify(game(['sea', ...SHAPED], players, 9, seaMap).board));
    }
  });
});

describe('every map a pool offers takes every module', () => {
  const maps = [...new Set(EXPANSIONS.flatMap((e) => [...poolFor([e.id]), ...poolFor(['sea', e.id])]))];
  for (const map of maps) {
    it(`the ${MAP_INFO[map].name}, dealt, with all five map-shaping expansions`, () => {
      const expansions: Expansion[] = MAP_INFO[map].needs.includes('sea') ? ['sea', ...SHAPED] : SHAPED;
      for (const players of [3, 4] as const) {
        for (const seed of SEEDS.slice(0, 4)) {
          const s = game(expansions, players, seed, map);
          expect(s.options.map).toBe(map);
          expect(missingFeatures(s.board, s.options.modules)).toEqual([]);
          expect(tally(s)).toEqual(expected(s.options.modules));
        }
      }
    });
  }
});

describe('a sea map keeps its own guarantees under the expansions', () => {
  for (const { id: seaMap, name } of SEA_MAPS) {
    const mixes = [...SHAPED.map((e) => [e]), SHAPED].map((ex) => ['sea', ...ex] as Expansion[]);
    it(`the ${name}: no hex bears a number twice, the bounty fields never bear a red one, and red numbers never touch`, () => {
      for (const ex of mixes) {
        let touching = 0;
        for (const players of [3, 4] as const) {
          for (let seed = 1; seed <= games(50, 4); seed++) {
            const b = game(ex, players, seed, seaMap).board;
            for (const h of b.hexes) {
              expect(new Set(h.numbers).size).toBe(h.numbers.length);
              if (h.terrain === 'bounty') expect(red(h.numbers)).toBe(false);
            }
            if (b.hexes.some((h) => red(h.numbers) && (h.numbers.filter((n) => n === 6 || n === 8).length > 1 || h.neighbors.some((n) => red(b.hexes[n].numbers))))) touching++;
          }
        }
        expect(touching, ex.join('+')).toBe(0);
      }
    }, timeout(FULL ? 120_000 : 20_000));

    it(`the ${name}: the fishing grounds lie off the home island, with the lake on it`, () => {
      for (const players of [3, 4] as const) {
        for (const seed of SEEDS) {
          const b = game(['sea', 'fisheries'], players, seed, seaMap).board;
          for (const g of grounds(b)) {
            expect(g.neighbors.some((n) => onHome(b, n))).toBe(true);
            expect(g.id).not.toBe(b.features.corsair);
          }
          const lake = b.hexes.find((h) => h.terrain === 'lake')!;
          expect(lake.neighbors.every((n) => onHome(b, n))).toBe(true);
        }
      }
    });
  }

  it('never counts the lake as Invasion’s coast, even where a crowded island puts it on the shore', () => {
    // (Seed 41, three seats: the oasis and the rivers take every inland hex, so the lake goes to the shore.)
    const b = game(['sea', 'invasion', 'rivers', 'caravans', 'fisheries'], 3, 41, 'archipelago').board;
    const lake = b.hexes.find((h) => h.terrain === 'lake')!;
    expect(topology(b).coastal[lake.id]).toBe(false);
    expect(topology(b).coast).not.toContain(lake.id);
  });

  it('parts reds without costing the coast a landing number, splitting two on one hex, or pushing one beside a red fishing ground', () => {
    // (Three seats on the archipelago, each a case a first repair got wrong.)
    const coastNumbers = (b: Board) => new Set(topology(b).coast.flatMap((h) => b.hexes[h].numbers));
    expect(coastNumbers(game(['sea', 'invasion', 'rivers', 'caravans', 'fisheries'], 3, 39, 'archipelago').board).size).toBe(10);
    const twoReds = game(['sea', 'invasion', 'caravans'], 3, 81, 'archipelago').board;
    expect(twoReds.hexes.some((h) => h.numbers.filter((n) => n === 6 || n === 8).length > 1)).toBe(false);
    const ground = game(['sea', 'invasion', 'fisheries'], 3, 141, 'archipelago').board;
    const byGround = ground.hexes.filter((h) => h.terrain !== 'sea' && red(h.numbers) && h.neighbors.some((n) => ground.hexes[n].terrain === 'sea' && red(ground.hexes[n].numbers)));
    expect(byGround).toEqual([]);
  });

  it('parts the red numbers the shapers leave side by side (Invasion and Rivers on a three-seat archipelago)', () => {
    const b = game(['sea', 'invasion', 'rivers'], 3, 1, 'archipelago').board;
    const land = b.hexes.filter((h) => h.terrain !== 'sea');
    expect(land.some((h) => red(h.numbers) && h.neighbors.some((n) => b.hexes[n].terrain !== 'sea' && red(b.hexes[n].numbers)))).toBe(false);
  });

  it('on the archipelago, Invasion builds its castle on the home coast and brings every number to it', () => {
    for (const players of [3, 4] as const) {
      for (const seed of SEEDS) {
        // (With Rivers the desert goes back in the box. Beside the lake or the oasis, a three-seat
        // island can run out of room inland, and Oil's well puts its own number on the coast.)
        for (const ex of [['sea', 'invasion'], ['sea', 'invasion', 'rivers']] as Expansion[][]) {
          const b = game(ex, players, seed, 'archipelago').board;
          const t = topology(b);
          const castle = b.hexes[t.castle!];
          expect(t.coastal[castle.id]).toBe(true);
          // Every number lands somewhere on the coast, and only a coast with more numbered hexes than
          // numbers bears one twice (the desert's place is held by tests/island.test.ts).
          const coastal = t.coast.flatMap((h) => b.hexes[h].numbers);
          expect(new Set(coastal).size, `${ex.join('+')} seed ${seed}: ${coastal}`).toBe(Math.min(10, coastal.length));
        }
      }
    }
  });

  it('on the fog maps, no river, well or fishing ground starts under the fog', () => {
    // The island's features are built once, at the start (render/board/rivers.ts, wells.ts,
    // grounds.ts), and a hex found in the fog doesn't rebuild them: one under the fog would carve a
    // dry channel, leave a pad with no jack, or a ground with no raft. This holds the map to that.
    const mixes = [['sea', 'rivers'], ['sea', 'oil'], ['sea', 'fisheries'], ['sea', 'rivers', 'oil', 'fisheries']] as Expansion[][];
    for (const ex of mixes) {
      for (const players of [3, 4] as const) {
        for (const seed of SEEDS) {
          const s = game(ex, players, seed, seed % 2 ? 'fogBank' : 'lostSea');
          const hidden = new Set(s.ext.sea?.fog?.hidden ?? []);
          const fogged = (h: number) => hidden.has(h);
          const context = `${ex.join('+')} seed ${seed}`;
          for (const r of s.board.features.rivers ?? []) expect(r.hexes.some(fogged), context).toBe(false);
          for (const h of s.board.hexes) if (h.well || grounds(s.board).includes(h)) expect(fogged(h.id), context).toBe(false);
        }
      }
    }
  });
});

describe('crowded Invasion coasts', () => {
  const additions: Expansion[] = ['rivers', 'caravans', 'fisheries', 'oil'];
  for (const map of ['classic', 'archipelago']) {
    for (const players of [3, 4] as const) {
      it(`${players} seats on the ${map}: every shaping mix keeps all ten landing numbers and parts every red`, () => {
        for (let bits = 0; bits < 16; bits++) {
          const ex: Expansion[] = [...(map === 'classic' ? [] : ['sea' as const]), 'invasion', ...additions.filter((_, i) => bits & (1 << i))];
          for (let seed = 1; seed <= games(50, 6); seed++) {
            const b = game(ex, players, seed, map).board;
            const context = `${ex.join('+')} seed ${seed}`;
            expect(new Set(topology(b).coast.flatMap((h) => b.hexes[h].numbers)).size, context).toBe(10);
            for (const h of b.hexes) {
              expect(new Set(h.numbers).size, context).toBe(h.numbers.length);
              if (h.terrain === 'bounty') expect(red(h.numbers), context).toBe(false);
              if (!red(h.numbers)) continue;
              expect(h.numbers.filter((n) => n === 6 || n === 8).length, context).toBe(1);
              expect(h.neighbors.some((n) => red(b.hexes[n].numbers)), context).toBe(false);
            }
          }
        }
      }, timeout(FULL ? 120_000 : 15_000));
    }
  }

  it('repairs a local minimum while the well stays fixed and the coast keeps its discs', () => {
    // This is the old classic Invasion + Rivers + Oil board at seed 141 after single-swap
    // repair stalled. Both inner reds have to move together to clear the pasture well.
    const rows: [number, number, BoardSpec['hexes'][number]['terrain'], number[], boolean?][] = [
      [0, -2, 'hills', [6]], [1, -2, 'forest', [2]], [2, -2, 'pasture', [4]],
      [-1, -1, 'mountains', [5]], [0, -1, 'fields', [5]], [1, -1, 'mountains', [4]], [2, -1, 'forest', [11], true],
      [-2, 0, 'fields', [10]], [-1, 0, 'hills', [12]], [0, 0, 'forest', [9]], [1, 0, 'hills', [6]], [2, 0, 'mountains', [9]],
      [-2, 1, 'pasture', [8], true], [-1, 1, 'pasture', [8]], [0, 1, 'fields', [10, 3]], [1, 1, 'swamp', []],
      [-2, 2, 'castle', []], [-1, 2, 'swamp', [9], true], [0, 2, 'fields', [3]],
    ];
    const spec: BoardSpec = { hexes: rows.map(([q, r, terrain, numbers, well]) => ({ q, r, terrain, numbers, ...(well ? { well } : {}) })), ports: [], castle: [-2, 2] };
    const discs = () => spec.hexes.flatMap((h) => h.numbers).sort((a, b) => a - b);
    const coast = homeLand(spec).filter(coastOf(spec, homeLand(spec)));
    const coastal = () => coast.flatMap((h) => h.numbers).sort((a, b) => a - b);
    const before = discs();
    const shore = coastal();
    const counts = spec.hexes.map((h) => h.numbers.length);
    const held = spec.hexes.filter((h) => h.well || !h.numbers.length).map((h) => ({ h, numbers: [...h.numbers] }));
    expect(redsTouch(spec)).toBe(true);
    partReds(spec);
    expect(redsTouch(spec)).toBe(false);
    expect(discs()).toEqual(before);
    expect(coastal()).toEqual(shore);
    expect(spec.hexes.map((h) => h.numbers.length)).toEqual(counts);
    for (const { h, numbers } of held) expect(h.numbers).toEqual(numbers);
    for (const h of spec.hexes) expect(new Set(h.numbers).size).toBe(h.numbers.length);
  });

  it('parts the reds where the swaps carried discs across the coast before the search', () => {
    // (A hand-made castle island from the shaping review: the single swaps moved a disc between the
    // coast and the interior, and the search then fitted only on the board as it came.)
    const rows: [number, number, BoardSpec['hexes'][number]['terrain'], number[], boolean?][] = [
      [0, -2, 'hills', [3]], [1, -2, 'hills', [11], true], [2, -2, 'pasture', [4]], [-1, -1, 'mountains', [8]], [0, -1, 'lake', [8]],
      [1, -1, 'fields', [6]], [2, -1, 'forest', [11]], [-2, 0, 'mountains', [10]], [-1, 0, 'pasture', [4]], [0, 0, 'fields', [12]],
      [1, 0, 'fields', [2]], [2, 0, 'pasture', [5], true], [-2, 1, 'pasture', [9]], [-1, 1, 'hills', [5], true], [0, 1, 'fields', [10]],
      [1, 1, 'forest', [6, 9]], [-2, 2, 'castle', []], [-1, 2, 'desert', []], [0, 2, 'mountains', [3]],
      [3, -3, 'sea', [4]], [-3, 1, 'sea', [6]], [-3, 2, 'sea', [12]], [1, 2, 'sea', [9]], [-3, 3, 'sea', [11]],
    ];
    const spec: BoardSpec = { hexes: rows.map(([q, r, terrain, numbers, well]) => ({ q, r, terrain, numbers: [...numbers], ...(well ? { well } : {}) })), ports: [], castle: [-2, 2] };
    const discs = () => spec.hexes.flatMap((h) => h.numbers).sort((a, b) => a - b);
    const before = discs();
    partReds(spec);
    expect(redsTouch(spec)).toBe(false);
    expect(discs()).toEqual(before);
  });

  it('gives up promptly on reds that can\u2019t all be parted, keeping every disc', () => {
    // (Twenty-two reds on a 61-hex island, packed in a corner: without a budget the search takes far too long to give up on them.)
    const hexes: BoardSpec['hexes'] = [];
    for (let q = -4; q <= 4; q++) for (let r = Math.max(-4, -q - 4); r <= Math.min(4, -q + 4); r++) hexes.push({ q, r, terrain: 'fields', numbers: [hexes.length < 22 ? (hexes.length % 2 ? 6 : 8) : 5] });
    const spec: BoardSpec = { hexes, ports: [] };
    const discs = () => spec.hexes.flatMap((h) => h.numbers).sort((a, b) => a - b);
    const before = discs();
    const t0 = performance.now();
    partReds(spec);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(discs()).toEqual(before);
  });

  it('keeps the required well likelihoods when a calm board offers several sites', () => {
    const s = game(['invasion', 'fisheries'], 3, 91);
    const spec: BoardSpec = {
      hexes: s.board.hexes.map(({ q, r, terrain, numbers }) => ({ q, r, terrain, numbers: [...numbers] })),
      ports: [], castle: [-2, 2],
    };
    const home = homeLand(spec);
    const pips = (ns: number[]) => ns.reduce((n, x) => n + (x < 7 ? x - 1 : 13 - x), 0);
    const wanted = (terrain: 'pasture' | 'forest', descending: boolean) => {
      const ranked = home.filter((h) => h.terrain === terrain).map((h) => pips(h.numbers)).sort((a, b) => descending ? b - a : a - b);
      return ranked[Math.min(1, ranked.length - 1)];
    };
    const pasture = wanted('pasture', true);
    const forest = wanted('forest', false);
    placeWells(spec, new Rng(91));
    expect(pips(home.find((h) => h.well && h.terrain === 'pasture')!.numbers)).toBe(pasture);
    expect(pips(home.find((h) => h.well && h.terrain === 'forest')!.numbers)).toBe(forest);
    expect(redsTouch(spec)).toBe(false);
    expect(buildBoard(spec).hexes.filter((h) => h.well)).toHaveLength(3);
  });
});

// Bot games of the mixes the shaping brought to life on the sea maps: each finishes with no
// fall-backs, and with a winner unless Oil's pollution sank the island. (SHAPED_GAMES=24 runs more of each.)
describe('bots finish the newly shaped sea mixes', () => {
  const N = Number(env.SHAPED_GAMES ?? 2);
  const mixes: [string, Expansion[], string][] = [
    ['Fishing the Archipelago', ['sea', 'fisheries'], 'archipelago'],
    ['Sea Lanes with Oil', ['sea', 'oil'], 'archipelago'],
    ['Sea Lanes with Rivers', ['sea', 'rivers'], 'archipelago'],
    ['Sea Lanes with Caravans', ['sea', 'caravans'], 'archipelago'],
    ['Sea Lanes with Invasion', ['sea', 'invasion'], 'archipelago'],
    ['Sea Lanes with Fisheries on the Fog Bank', ['sea', 'fisheries'], 'fogBank'],
    ['Sea Lanes with Rivers on the Lost Sea', ['sea', 'rivers'], 'lostSea'],
    ['Sea Lanes with Oil on the Strait', ['sea', 'oil'], 'strait'],
  ];
  for (const [name, expansions, seaMap] of mixes) {
    slow(name, () => {
      const mix = mixOf(expansions, seaMap);
      expect(mix.modules).toEqual(modulesFor(expansions));
      for (let g = 0; g < N; g++) {
        const res = runBotGame({
          seed: 7700 + g,
          players: g % 2 ? 3 : 4,
          layout: 'random',
          options: { modules: mix.modules, map: mapOf(expansions, seaMap), knobs: mix.knobs, victoryPoints: mix.target },
          difficulties: ['normal', 'hard', 'easy', 'normal'],
          // (Oil leaves the game as it's burned or sequestered: hold it to what's still in play.)
          supply: expansions.includes('oil') ? (s) => ({ oil: cardsInPlay(s).oil }) : undefined,
        });
        if (!expansions.includes('oil')) expect(res.winner).not.toBeNull();
        expect(res.fallbacks).toBe(0);
      }
    }, timeout(120000));
  }
});
