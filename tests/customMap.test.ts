import { describe, expect, it } from 'vitest';
import { Rng, buildBoard, classicSpec, createGame, dealBoard, randomLayout, validateOptions, DEFAULT_OPTIONS, type GameOptions } from '../src/engine';
import { MAX_HEXES, MAX_REACH, blankMap, buildingPoints, checkCustomMap, coastSides, customSpec, dealNumbers, fillTerrain, gridCells, hexDistance, hexagon, normalize, parseCustomMap, placeHarbours, rectangle, scatterIslets, surroundWithSea, translate, type CustomMap } from '../src/engine/maps/custom';
import { mixOf } from '../src/engine/presets';
import { validSave } from '../src/game/save';
import { runBotGame, setups } from './sim-harness';
import { slow, timeout } from './tier';

/** The classic island, as the editor would hold it. */
function classicMap(seed = 3): CustomMap {
  const spec = classicSpec(randomLayout(new Rng(seed), 'spiral'));
  return {
    v: 1,
    name: 'Classic',
    hexes: spec.hexes.map((h) => ({ q: h.q, r: h.r, terrain: h.terrain as CustomMap['hexes'][number]['terrain'], ...(h.numbers.length && { number: h.numbers[0] }) })),
    ports: spec.ports,
  };
}

/** A made map: `radius` of land in a sea one ring wider, filled, numbered and with harbours. */
function madeMap(radius: number, seed = 5): CustomMap {
  const rng = new Rng(seed);
  return placeHarbours(fillTerrain(blankMap(`Made ${radius}`, radius + 1, radius), rng), rng);
}

const opts = (map: CustomMap, more: Partial<GameOptions> = {}): Partial<GameOptions> => ({ map: 'custom', custom: map, ...more });

describe('custom maps', () => {
  it('build the same board as the spec they came from', () => {
    const spec = classicSpec(randomLayout(new Rng(3), 'spiral'));
    const a = buildBoard(spec);
    const b = buildBoard(customSpec(classicMap(3)));
    expect(b.hexes.map((h) => [h.q, h.r, h.terrain, h.numbers])).toEqual(a.hexes.map((h) => [h.q, h.r, h.terrain, h.numbers]));
    expect(b.ports.map((p) => [p.hex, p.side, p.type])).toEqual(a.ports.map((p) => [p.hex, p.side, p.type]));
  });

  it('pass the check on the classic island for 3 and 4 players to 10', () => {
    for (const players of [3, 4]) {
      const c = checkCustomMap(classicMap(), { players, victoryPoints: 10 });
      expect(c.errors).toEqual([]);
      expect(c.figures!.suggested).toBe(10);
      expect(c.figures!.sites).toBeGreaterThanOrEqual(20);
    }
  });

  it('refuse what the engine or the game can’t take', () => {
    const empty: CustomMap = { v: 1, name: 'x', hexes: hexagon(2).map(([q, r]) => ({ q, r, terrain: 'sea' })), ports: [] };
    expect(checkCustomMap(empty, { players: 4, victoryPoints: 10 }).errors).toContain('The map has no land');

    const big = blankMap('big', 6, 5);
    expect(checkCustomMap(big, { players: 4, victoryPoints: 10 }).errors[0]).toMatch(/at most 61/);

    const bare = blankMap('bare', 3, 2);
    const e = checkCustomMap(bare, { players: 4, victoryPoints: 10 }).errors;
    expect(e.some((x) => /no number/.test(x))).toBe(true);
    expect(e.some((x) => /robber/.test(x))).toBe(true);

    // A harbour facing land, and two touching.
    const m = classicMap();
    expect(checkCustomMap({ ...m, ports: [{ q: 0, r: 0, side: 0, type: 'any' }] }, { players: 4, victoryPoints: 10 }).errors[0]).toMatch(/faces land/);
    const [s1] = coastSides(m);
    const touching = { ...m, ports: [{ ...s1, type: 'any' as const }, { ...s1, type: 'ore' as const }] };
    expect(checkCustomMap(touching, { players: 4, victoryPoints: 10 }).errors).toContain('Two harbours share a coast');
  });

  it('work out the points a map supports', () => {
    expect(buildingPoints(2)).toBe(4);
    expect(buildingPoints(5)).toBe(9);
    expect(buildingPoints(9)).toBe(13);
    expect(buildingPoints(20)).toBe(13);
    // Seven hexes: twelve sites, three each for four players, so ten points is a long way.
    const tiny = fillTerrain(blankMap('tiny', 2, 1), new Rng(1));
    const c = checkCustomMap(tiny, { players: 4, victoryPoints: 10 });
    expect(c.figures!.sites).toBe(12);
    expect(c.figures!.suggested).toBeLessThan(10);
    expect(c.warnings.some((w) => /long way/.test(w))).toBe(true);
    // Settled apart, though, those seven hexes may leave room for only six starting settlements:
    // enough for three players, not four (a set-up there ran out of room before the last one).
    expect(c.errors.some((x) => /settled apart it may leave room for only 6/.test(x))).toBe(true);
    expect(checkCustomMap(tiny, { players: 3, victoryPoints: 10 }).errors).toEqual([]);
    // One hex has two sites: not even one player's start.
    const one = fillTerrain(blankMap('one', 1, 0), new Rng(1));
    expect(checkCustomMap(one, { players: 3, victoryPoints: 10 }).errors.some((x) => /starting sites/.test(x))).toBe(true);
    // Thirty points are out of reach anywhere.
    expect(checkCustomMap(classicMap(), { players: 4, victoryPoints: 30 }).errors.some((x) => /can’t be reached/.test(x))).toBe(true);
  });

  it('warn about a missing resource, touching reds and stranded islands', () => {
    const m = classicMap();
    const noOre = { ...m, hexes: m.hexes.map((h) => (h.terrain === 'mountains' ? { ...h, terrain: 'hills' as const } : h)) };
    expect(checkCustomMap(noOre, { players: 4, victoryPoints: 10 }).warnings.some((w) => /No ore/.test(w))).toBe(true);
    const red = { ...m, hexes: m.hexes.map((h) => (h.q === 0 && (h.r === 0 || h.r === 1) && h.terrain !== 'desert' ? { ...h, number: 6 } : h)) };
    if (red.hexes.filter((h) => h.number === 6 && h.q === 0 && h.r >= 0 && h.r <= 1).length === 2) expect(checkCustomMap(red, { players: 4, victoryPoints: 10 }).warnings.some((w) => /6 or an 8/.test(w))).toBe(true);
    // Two islands, with and without Sea Lanes.
    const two = madeMap(3);
    const split = { ...two, ports: [], hexes: two.hexes.map((h) => (h.q === 0 ? { q: h.q, r: h.r, terrain: 'sea' as const } : h)) };
    const dealt = dealNumbers(split, new Rng(2));
    expect(checkCustomMap(dealt, { players: 4, victoryPoints: 10 }).warnings.some((w) => /Sea Lanes/.test(w))).toBe(true);
  });

  it('deal numbers to every producing hex, and harbours that never touch', () => {
    const m = madeMap(3, 9);
    for (const h of m.hexes) expect(h.number !== undefined).toBe(['forest', 'pasture', 'fields', 'hills', 'mountains'].includes(h.terrain));
    expect(m.ports.length).toBeGreaterThan(9);
    const c = checkCustomMap(m, { players: 4, victoryPoints: 10 });
    expect(c.errors).toEqual([]);
  });

  it('ride in the options and in saves, and are refused when broken', () => {
    const m = madeMap(2);
    expect(() => validateOptions({ ...DEFAULT_OPTIONS, ...opts(m) } as GameOptions)).not.toThrow();
    expect(() => validateOptions({ ...DEFAULT_OPTIONS, map: 'custom' } as GameOptions)).toThrow(/custom/);
    expect(() => validateOptions({ ...DEFAULT_OPTIONS, custom: m } as GameOptions)).toThrow(/custom/);
    expect(() => validateOptions({ ...DEFAULT_OPTIONS, ...opts(m), layout: 'beginner' } as GameOptions)).toThrow(/beginner/);
    expect(parseCustomMap({ ...m, hexes: [...m.hexes, m.hexes[0]] })).toBeNull();
    expect(parseCustomMap(JSON.parse(JSON.stringify(m)))).toEqual(m);
    const board = dealBoard(4, { ...opts(m), seed: 1 });
    const save = { v: 3, rules: 3, cfg: { name: 'a', color: 'red', opponents: 3, difficulty: 'normal', layout: 'random', numberPlacement: 'spiral', seed: 1, map: 'custom', custom: m, board }, seats: setups(4), avatars: [0, 1, 2, 3], history: [], turn: 0 };
    expect(validSave(save)).toBe(true);
    expect(validSave({ ...save, cfg: { ...save.cfg, custom: undefined } })).toBe(false);
    const s = createGame(setups(4), { ...opts(m), seed: 4 }).state;
    expect(s.board.hexes.filter((h) => h.terrain !== 'sea')).toHaveLength(19);
  });

  slow('play to a finish by bots, small, large and with expansions', () => {
    const cases: { map: CustomMap; more?: Partial<GameOptions>; players: 3 | 4 }[] = [
      { map: madeMap(2, 11), players: 4 },
      { map: madeMap(3, 12), players: 4, more: { victoryPoints: 12 } },
      { map: madeMap(3, 13), players: 3, more: { modules: mixOf(['rivers', 'caravans']).modules } },
      { map: madeMap(3, 14), players: 4, more: { modules: mixOf(['sea']).modules } },
    ];
    for (const [i, c] of cases.entries()) {
      const r = runBotGame({ seed: 100 + i, players: c.players, layout: 'random', options: opts(c.map, c.more), difficulties: ['normal', 'hard', 'normal', 'easy'] });
      expect(r.winner, `case ${i}`).not.toBeNull();
      expect(r.fallbacks, `case ${i}`).toBe(0);
    }
  }, timeout(60_000));

  it('try the expansions on the map for real', () => {
    const m = madeMap(3, 21);
    const modules = mixOf(['rivers', 'fisheries', 'oil']).modules;
    const c = checkCustomMap(m, { players: 4, victoryPoints: 12, modules, tryGame: (seed) => createGame(setups(4), { ...opts(m), modules, seed }) });
    expect(c.errors).toEqual([]);
  });
});

describe('custom maps, version 2', () => {
  /** A medium island of random land in the sea, with numbers dealt and random harbours. */
  const randomMap = (): CustomMap => {
    const m = blankMap('Random', 4, 2);
    const hexes = m.hexes.map((h) => (h.terrain === 'sea' ? h : { q: h.q, r: h.r, terrain: 'random' as const }));
    return placeHarbours({ ...m, hexes: hexes.map((h) => (h.q === 0 && h.r === 0 ? { q: 0, r: 0, terrain: 'desert' as const } : h)) }, new Rng(4), true);
  };

  it('deal their random hexes, numbers and harbours from the game’s seed, the same every time', () => {
    const m = randomMap();
    const a = createGame(setups(4), { ...opts(m), seed: 9 }).state.board;
    const b = createGame(setups(4), { ...opts(m), seed: 9 }).state.board;
    const c = createGame(setups(4), { ...opts(m), seed: 10 }).state.board;
    const look = (bd: typeof a) => bd.hexes.map((h) => `${h.terrain}${h.numbers.join('/')}`).join() + bd.ports.map((p) => p.type).join();
    expect(look(a)).toBe(look(b));
    expect(look(a)).not.toBe(look(c));
    expect(a.ports.every((p) => p.type !== ('random' as string))).toBe(true);
    for (const h of a.hexes) if (['forest', 'pasture', 'fields', 'hills', 'mountains'].includes(h.terrain)) expect(h.numbers).toHaveLength(1);
    expect(checkCustomMap(m, { players: 4, victoryPoints: 10 }).errors).toEqual([]);
  });

  it('take a bag of their own, which must hold one tile per random hex', () => {
    const m = randomMap();
    const n = m.hexes.filter((h) => h.terrain === 'random').length;
    expect(checkCustomMap({ ...m, bag: { forest: n - 1 } }, { players: 4, victoryPoints: 10 }).errors[0]).toMatch(/bag holds/);
    const forests = createGame(setups(4), { ...opts({ ...m, bag: { forest: n } }), seed: 3 }).state.board;
    expect(forests.hexes.filter((h) => h.terrain === 'forest')).toHaveLength(n);
  });

  it('put face-down hexes under the fog with Sea Lanes, their numbers in its pool', () => {
    const m = madeMap(2, 31);
    const isles = scatterIslets(m, new Rng(2), hexagon(5), 3, true);
    const hidden = isles.hexes.filter((h) => h.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    const sea = mixOf(['sea']).modules;
    const s = createGame(setups(4), { ...opts(isles), modules: sea, seed: 5 }).state;
    expect(s.ext.sea?.fog?.hidden.length).toBe(hidden.length);
    // (Without Sea Lanes they're dealt face up, with their numbers.)
    const plain = createGame(setups(4), { ...opts(isles), seed: 5 }).state;
    expect(plain.board.objectives).toBeUndefined();
    const c = checkCustomMap(isles, { players: 4, victoryPoints: 12, modules: sea, tryGame: (seed) => createGame(setups(4), { ...opts(isles), modules: sea, seed }) });
    expect(c.errors).toEqual([]);
    expect(checkCustomMap(isles, { players: 4, victoryPoints: 10 }).warnings.some((w) => /fog is dealt face up/.test(w))).toBe(true);
    // The fog may not cover a home island.
    const homeFog = { ...m, hexes: m.hexes.map((h) => (h.q === 0 && h.r === 0 ? { ...h, hidden: true as const } : h)) };
    expect(checkCustomMap(homeFog, { players: 4, victoryPoints: 10, modules: sea }).errors.some((e) => /home island/.test(e))).toBe(true);
  });

  it('carry the expansions’ features themselves, the game shaping only what they leave out', () => {
    // The classic island in the sea, with a lake, six grounds, a castle on the coast, an oasis in the middle, three wells and two rivers.
    const base = surroundWithSea({ ...classicMap(8), ports: [] });
    const feature: Record<string, CustomMap['hexes'][number]['terrain']> = { '0,0': 'oasis', '1,0': 'lake', '-2,0': 'castle', '2,-2': 'swamp', '-2,2': 'swamp' };
    const grounds: Record<string, number> = { '3,-3': 4, '3,0': 5, '0,3': 6, '-3,3': 8, '-3,0': 9, '0,-3': 10 };
    const wells = new Set(['-1,-1', '2,-1', '-1,1']);
    const hexes = base.hexes.map((h) => {
      const k = `${h.q},${h.r}`;
      if (feature[k]) return { q: h.q, r: h.r, terrain: feature[k] };
      if (grounds[k]) return { q: h.q, r: h.r, terrain: 'sea' as const, number: grounds[k] };
      const plain = { q: h.q, r: h.r, terrain: h.terrain === 'desert' ? ('pasture' as const) : h.terrain };
      return wells.has(k) ? { ...plain, well: true as const } : plain;
    });
    const map = dealNumbers({ ...base, hexes, robber: [-2, 0], rivers: [{ path: [[0, -1], [1, -2], [2, -2]] }, { path: [[0, 1], [-1, 2], [-2, 2]] }] }, new Rng(3));
    const modules = mixOf(['fisheries', 'rivers', 'caravans', 'oil', 'invasion']).modules;
    const b = createGame(setups(4), { ...opts(map), modules, seed: 2 }).state.board;
    expect(b.hexes.find((h) => h.terrain === 'oasis')).toMatchObject({ q: 0, r: 0 });
    expect(b.hexes.find((h) => h.terrain === 'lake')).toMatchObject({ q: 1, r: 0, numbers: [2, 3, 11, 12] });
    expect(b.hexes[b.features.castle!]).toMatchObject({ q: -2, r: 0 });
    expect(b.features.rivers!.map((r) => r.hexes.map((h) => `${b.hexes[h].q},${b.hexes[h].r}`))).toEqual([['0,-1', '1,-2', '2,-2'], ['0,1', '-1,2', '-2,2']]);
    expect(b.hexes.filter((h) => h.well).map((h) => `${h.q},${h.r}`).sort()).toEqual([...wells].sort());
    expect(checkCustomMap(map, { players: 4, victoryPoints: 16, modules }).notes.join()).toMatch(/places its own features/);
    // With none of them placed, the game shapes the home island for each.
    const plain = createGame(setups(4), { ...opts(madeMap(2, 40)), modules, seed: 2 }).state.board;
    expect(plain.hexes.some((h) => h.terrain === 'lake') && plain.features.rivers?.length === 2 && plain.features.castle !== undefined).toBe(true);
  });

  it('reads version 1 maps and keeps every new field through a save', () => {
    const v1 = { v: 1, name: 'Old', hexes: [{ q: 0, r: 0, terrain: 'forest', number: 6 }], ports: [] };
    expect(parseCustomMap(v1)).toMatchObject({ v: 2, name: 'Old' });
    const m: CustomMap = { ...randomMap(), corsair: [3, 0], home: [[0, 0]], deal: true, bag: { forest: 2 }, rivers: [{ path: [[0, 1], [0, 2]] }] };
    expect(parseCustomMap(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  slow('play to a finish by bots on a random map with islets in the fog', () => {
    const m = scatterIslets(randomMap(), new Rng(6), hexagon(5), 3, true);
    const r = runBotGame({ seed: 77, players: 4, layout: 'random', options: { ...opts(m), modules: mixOf(['sea']).modules, victoryPoints: 12 }, difficulties: ['normal', 'hard', 'normal', 'easy'] });
    expect(r.winner).not.toBeNull();
    expect(r.fallbacks).toBe(0);
  }, timeout(120_000));
});

describe('custom maps of any size and shape', () => {
  /** A map from its land cells: sea round them, filled, numbered, with harbours and centred (what a template makes). */
  function shaped(name: string, land: [number, number][], seed = 7, home?: [number, number][]): CustomMap {
    const rng = new Rng(seed);
    const base: CustomMap = { v: 2, name, hexes: land.map(([q, r]) => ({ q, r, terrain: 'pasture' as const })), ports: [], ...(home && { home }) };
    return normalize(placeHarbours(fillTerrain(surroundWithSea(base), rng), rng));
  }
  const isle = (q: number, r: number) => [[q, r]] as [number, number][];
  const SHAPES: Record<string, { map: CustomMap; v: 2 | 3 }> = {
    rectangle: { map: shaped('Rectangle', rectangle(8, 6)), v: 3 },
    ring: { map: shaped('Atoll', hexagon(4).filter(([q, r]) => hexDistance(q, r) >= 3)), v: 3 },
    islets: { map: shaped('Isles', [...hexagon(2), ...isle(4, -1), ...isle(-4, 1), ...isle(0, 4)]), v: 2 },
    strip: { map: shaped('Strip', rectangle(13, 2)), v: 3 },
    sixtyOne: { map: shaped('Sixty-one', hexagon(4)), v: 3 },
  };
  const sea = mixOf(['sea']).modules;
  const label = (name: string, modules: readonly unknown[]) => `${name} ${modules.length ? 'with' : 'without'} Sea Lanes`;

  it('are written in the format their size calls for, and read back whole', () => {
    for (const [name, { map, v }] of Object.entries(SHAPES)) {
      expect(map.v, name).toBe(v);
      expect(parseCustomMap(JSON.parse(JSON.stringify(map))), name).toEqual(map);
    }
    // The strip is version 3 for its reach alone (26 land hexes), the sixty-one for its land alone.
    expect(SHAPES.strip.map.hexes.filter((h) => h.terrain !== 'sea').length).toBeLessThanOrEqual(37);
    expect(Math.max(...SHAPES.strip.map.hexes.map((h) => hexDistance(h.q, h.r)))).toBeGreaterThan(5);
    expect(Math.max(...SHAPES.sixtyOne.map.hexes.map((h) => hexDistance(h.q, h.r)))).toBeLessThanOrEqual(5);
    // Whatever version a map is given as, it is read as the one its size calls for, and version 4 is refused.
    expect(parseCustomMap({ ...SHAPES.strip.map, v: 2 })!.v).toBe(3);
    expect(parseCustomMap({ ...madeMap(2), v: 3 })!.v).toBe(2);
    expect(parseCustomMap({ ...madeMap(2), v: 4 })).toBeNull();
  });

  it('are bounded by the reach and size of a map, and no more', () => {
    const hex = (q: number, r: number) => ({ q, r, terrain: 'sea' as const });
    const given = (hexes: ReturnType<typeof hex>[]) => ({ v: 3, name: 'x', ports: [], hexes });
    expect(parseCustomMap(given([hex(MAX_REACH, 0)]))).not.toBeNull();
    expect(parseCustomMap(given([hex(MAX_REACH + 1, 0)]))).toBeNull();
    expect(parseCustomMap(given([hex(MAX_REACH, -MAX_REACH + 1), hex(-MAX_REACH, MAX_REACH)]))).not.toBeNull();
    expect(parseCustomMap(given([hex(MAX_REACH, MAX_REACH)]))).toBeNull();
    const cells = hexagon(MAX_REACH).slice(0, MAX_HEXES + 1).map(([q, r]) => hex(q, r));
    expect(parseCustomMap(given(cells))).toBeNull();
    expect(parseCustomMap(given(cells.slice(0, MAX_HEXES)))).not.toBeNull();
    // The check refuses what parse would (a map handed to it straight from the editor).
    const base = SHAPES.sixtyOne.map;
    const over = { ...base, hexes: [...base.hexes, { q: 6, r: 0, terrain: 'forest' as const, number: 5 }] };
    expect(checkCustomMap(over, { players: 4, victoryPoints: 10 }).errors.some((e) => /at most 61/.test(e))).toBe(true);
    expect(checkCustomMap({ ...base, hexes: [...base.hexes, hex(MAX_REACH + 1, 0)] }, { players: 4, victoryPoints: 10 }).errors.some((e) => /more than 16 hexes/.test(e))).toBe(true);
  });

  it('pass the check and build a game, with and without Sea Lanes', () => {
    for (const [name, { map }] of Object.entries(SHAPES)) {
      for (const modules of [[], sea]) {
        const c = checkCustomMap(map, { players: 4, victoryPoints: 10, modules, tryGame: (seed) => createGame(setups(4), { ...opts(map), modules, seed }) });
        expect(c.errors, label(name, modules)).toEqual([]);
        const dealt = createGame(setups(4), { ...opts(map), modules, seed: 3 }).state.board;
        expect(dealt.hexes.filter((h) => h.terrain !== 'sea')).toHaveLength(map.hexes.filter((h) => h.terrain !== 'sea').length);
      }
    }
    // The islets are other islands: with Sea Lanes ships reach them, without it nobody can.
    const islets = SHAPES.islets.map;
    expect(buildBoard(customSpec(islets)).islands).toHaveLength(4);
    expect(checkCustomMap(islets, { players: 4, victoryPoints: 10 }).warnings.some((w) => /no one can reach the other islands/.test(w))).toBe(true);
    expect(checkCustomMap(islets, { players: 4, victoryPoints: 10, modules: sea }).warnings.some((w) => /no one can reach/.test(w))).toBe(false);
  });

  slow('are played to a finish by bots, with and without Sea Lanes', () => {
    let seed = 300;
    for (const [name, { map }] of Object.entries(SHAPES)) {
      for (const modules of [[], sea]) {
        const r = runBotGame({ seed: seed++, players: 4, layout: 'random', options: { ...opts(map), modules, victoryPoints: 10 }, difficulties: ['normal', 'hard', 'normal', 'easy'] });
        expect(r.winner, label(name, modules)).not.toBeNull();
        expect(r.fallbacks, label(name, modules)).toBe(0);
      }
    }
  }, timeout(240_000));

  it('count the starting sites on the home island alone', () => {
    // A home island of seven hexes and a big islet beside it: the islet's sites don't make starting sites.
    const home = hexagon(1);
    const islet = hexagon(2).map(([q, r]) => [q + 6, r] as [number, number]);
    const map = shaped('Seven and nineteen', [...home, ...islet], 7, [[0, 0]]);
    const errors = (modules: typeof sea) => checkCustomMap(map, { players: 4, victoryPoints: 10, modules }).errors.join();
    expect(errors([])).toMatch(/4 players need 8 starting sites on the home island[:,]/);
    expect(errors(sea)).toMatch(/4 players need 8 starting sites on the home islands[:,]/);
    // Marked home, the nineteen-hex island has room.
    expect(checkCustomMap(shaped('Nineteen and seven', [...home, ...islet], 7, [[6, 0]]), { players: 4, victoryPoints: 10 }).errors).toEqual([]);
  });

  it('refuse, with Sea Lanes, an island that no ship can reach', () => {
    // An islet whose own ring of sea meets the home island's, and one a ring too far.
    const near = shaped('Near', [...hexagon(2), ...isle(5, -3)]);
    const far = shaped('Far', [...hexagon(2), ...isle(6, -3)]);
    expect(checkCustomMap(near, { players: 4, victoryPoints: 10, modules: sea }).errors).toEqual([]);
    expect(checkCustomMap(far, { players: 4, victoryPoints: 10, modules: sea }).errors.some((e) => /can’t be reached by ship/.test(e))).toBe(true);
    expect(checkCustomMap(far, { players: 4, victoryPoints: 10 }).errors).toEqual([]);
  });

  it('recentre on the middle of their cells, moving everything with them', () => {
    const m: CustomMap = { ...madeMap(3, 31), robber: [0, 0], home: [[1, 0]], corsair: [3, 0], rivers: [{ path: [[0, 1], [0, 2]] }] };
    const moved = translate(m, 7, -4);
    expect(moved.robber).toEqual([7, -4]);
    const back = normalize(moved);
    expect(back).toEqual(m);
    expect(normalize(back)).toBe(back);
    // A rectangle is centred by its bounding box, not by its first cell.
    const rect = normalize({ v: 2, name: 'r', ports: [], hexes: rectangle(6, 5).map(([q, r]) => ({ q: q + 9, r: r + 2, terrain: 'sea' as const })) });
    const across = rect.hexes.map((h) => Math.sqrt(3) * (h.q + h.r / 2));
    expect(Math.abs(Math.min(...across) + Math.max(...across))).toBeLessThanOrEqual(Math.sqrt(3) + 1e-9);
    expect(Math.min(...rect.hexes.map((h) => h.r)) + Math.max(...rect.hexes.map((h) => h.r))).toBe(0);
    // The deal doesn't depend on where the map lies.
    const dealt = (x: CustomMap) => customSpec(x, new Rng(5)).hexes.map((h) => `${h.terrain}${h.numbers}`).join();
    expect(dealt(moved)).toBe(dealt(m));
  });

  it('place harbours round the coast whatever the map’s offset', () => {
    const m = shaped('Long', rectangle(9, 5), 4);
    const off = translate(m, 3, -5);
    const sides = (x: CustomMap, dq = 0, dr = 0) => coastSides(x).map((s) => `${s.q - dq},${s.r - dr},${s.side}`);
    expect(sides(off, 3, -5)).toEqual(sides(m));
    const ports = (x: CustomMap, dq = 0, dr = 0) => placeHarbours({ ...x, ports: [] }, new Rng(1)).ports.map((p) => `${p.q - dq},${p.r - dr},${p.side},${p.type}`);
    expect(ports(off, 3, -5)).toEqual(ports(m));
  });

  it('give the editor a grid of the cells listed and two rings round them', () => {
    const m = madeMap(2);
    expect(gridCells(m)).toHaveLength(hexagon(m.hexes.reduce((a, h) => Math.max(a, hexDistance(h.q, h.r)), 0) + 2).length);
    expect(new Set(gridCells(m).map(([q, r]) => `${q},${r}`)).size).toBe(gridCells(m).length);
    expect(gridCells({ ...m, hexes: [] })).toHaveLength(hexagon(3).length);
    const edge = { ...m, hexes: [{ q: MAX_REACH, r: 0, terrain: 'sea' as const }] };
    expect(gridCells(edge).every(([q, r]) => hexDistance(q, r) <= MAX_REACH)).toBe(true);
  });

  it('scatter islets and surround with sea without a radius', () => {
    const home = placeHarbours(fillTerrain(blankMap('Home', 5, 2), new Rng(2)), new Rng(2));
    const isles = scatterIslets(home, new Rng(3), hexagon(5), 4, true);
    expect(isles.hexes.every((h) => hexDistance(h.q, h.r) <= 5)).toBe(true);
    expect(isles.hexes.filter((h) => h.hidden).length).toBeGreaterThan(0);
    // With no cells given, the islets go anywhere in the map's grid and the rings round it.
    const rect = shaped('Rect', rectangle(7, 5), 11);
    const wide = scatterIslets(rect, new Rng(3));
    expect(wide.hexes.filter((h) => h.terrain === 'random').length).toBeGreaterThan(0);
    expect(wide.hexes.length).toBeGreaterThan(rect.hexes.length);
    const bare: CustomMap = { ...rect, hexes: rect.hexes.filter((h) => h.terrain !== 'sea') };
    expect(surroundWithSea(bare).hexes.length).toBe(rect.hexes.length);
    expect(surroundWithSea(rect)).toBe(rect);
  });
});
