// Custom maps in online rooms: the cap on what a room takes (checkRoomMap), and the fog kept face
// down in every view: neither the map in the options (R2) nor a harbour on the board (R3) tells
// what lies under it.

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, redactState, type GameState } from '../../src/engine';
import { MAX_HEXES, MAX_LAND, MAX_REACH, ROOM_MAP_MAX_BYTES, ROOM_MAP_MAX_HARBOURS, blankMap, checkRoomMap, fillTerrain, hexDistance, hexagon, normalize, placeHarbours, type CustomMap } from '../../src/engine/maps/custom';
import { Rng } from '../../src/engine/rng';
import { CUSTOM_MAP_MAX_BYTES, CUSTOM_MAP_MAX_HARBOURS } from '../../src/net/protocol';
import { canonical, wireView } from '../../src/engine/wire';
import { setups } from '../sim-harness';
import { fogMap, keyed, playGame } from './play';

const FOG = { map: 'custom', custom: fogMap(), modules: ['sea' as const], victoryPoints: 12 };
const key = (q: number, r: number) => `${q},${r}`;
const faceDown = (s: GameState) => new Set(s.ext.sea!.fog!.hidden.map((h) => key(s.board.hexes[h].q, s.board.hexes[h].r)));

describe('maps sent to a room', () => {
  it('hold to the protocol’s limits', () => {
    expect(ROOM_MAP_MAX_BYTES).toBe(CUSTOM_MAP_MAX_BYTES);
    expect(ROOM_MAP_MAX_HARBOURS).toBe(CUSTOM_MAP_MAX_HARBOURS);
  });

  it('are taken when sound, as a map or as its JSON', () => {
    const m = fogMap();
    expect(checkRoomMap(m)).toEqual({ map: m, errors: [] });
    expect(checkRoomMap(JSON.stringify(m)).errors).toEqual([]);
  });

  it('are refused when too big, crowded with harbours, or showing through the fog', () => {
    const m = fogMap();
    const errs = (x: unknown) => checkRoomMap(x).errors.join('; ');
    expect(errs({ ...m, name: 'x', junk: 'y'.repeat(ROOM_MAP_MAX_BYTES) })).toMatch(/at most 65536/);
    expect(errs('{not json')).toMatch(/isn’t JSON/);
    expect(errs({ v: 3 })).toMatch(/isn’t a map/);
    const sides = m.hexes.filter((h) => h.terrain !== 'sea' && !h.hidden).flatMap((h) => [0, 1, 2, 3, 4, 5].map((side) => ({ q: h.q, r: h.r, side, type: 'any' as const })));
    expect(errs({ ...m, ports: sides.slice(0, ROOM_MAP_MAX_HARBOURS + 1) })).toMatch(/harbours; a room takes at most 18/);
    expect(errs({ ...m, ports: [...m.ports, m.ports[0]] })).toMatch(/Two harbours on side/);
    // (200,000 copies of one harbour passed every check the engine had.)
    expect(errs({ ...m, ports: Array(200_000).fill(m.ports[0]) })).toMatch(/bytes; a room takes at most/);
    const at = (q: number, r: number, change: Partial<CustomMap['hexes'][number]>): CustomMap => ({ ...m, hexes: m.hexes.map((h) => (h.q === q && h.r === r ? { ...h, ...change } : h)) });
    expect(errs({ ...at(4, -2, { terrain: 'castle' }) })).toMatch(/castle lies under the fog/);
    expect(errs({ ...m, rivers: [{ path: [[4, -1], [4, -2]] }] })).toMatch(/river runs under the fog/);
    expect(errs({ ...at(4, -2, { hidden: true }), robber: [4, -2] })).toMatch(/robber starts under the fog/);
    expect(errs({ ...m, corsair: [3, 0] })).toMatch(/corsair starts under the fog/);
    expect(errs({ ...at(4, -1, { terrain: 'desert', number: undefined }), robber: undefined })).toMatch(/desert under the fog/);
    expect(errs({ ...m, home: [[0, 0], [4, -2]] })).toMatch(/home island’s marker/);
  });
});

describe('big maps sent to a room', () => {
  /** 61 land hexes in 600 cells (the most a map lists), centred and written in format 3. */
  function biggest(cells = MAX_HEXES): CustomMap {
    const rng = new Rng(2);
    const home = placeHarbours(fillTerrain(blankMap('Big', 5, 4), rng), rng);
    const have = new Set(home.hexes.map((h) => `${h.q},${h.r}`));
    const more = hexagon(MAX_REACH)
      .filter(([q, r]) => !have.has(`${q},${r}`))
      .sort((a, b) => hexDistance(...a) - hexDistance(...b))
      .slice(0, cells - home.hexes.length)
      .map(([q, r]) => ({ q, r, terrain: 'sea' as const }));
    return normalize({ ...home, hexes: [...home.hexes, ...more] });
  }

  it('are taken at the most a map lists, within the byte cap, and refused beyond', () => {
    const m = biggest();
    expect(m.v).toBe(3);
    expect(m.hexes).toHaveLength(MAX_HEXES);
    expect(m.hexes.filter((h) => h.terrain !== 'sea')).toHaveLength(MAX_LAND);
    expect(JSON.stringify(m).length).toBeLessThan(ROOM_MAP_MAX_BYTES);
    expect(checkRoomMap(m)).toEqual({ map: m, errors: [] });
    expect(checkRoomMap(JSON.stringify(m)).errors).toEqual([]);
    expect(checkRoomMap(biggest(MAX_HEXES + 1)).errors).toEqual(['That isn’t a map']);
    // A game is dealt on it, as a room would.
    expect(() => createGame(setups(4), { map: 'custom', custom: m, seed: 1 })).not.toThrow();
  });
});

describe('the fog in a view', () => {
  it('keeps a custom map’s face-down cells face down in the options (R2)', () => {
    const s = createGame(setups(4), { ...keyed(1, FOG).options, seed: 3 }, keyed(1).secret).state;
    const down = faceDown(s);
    expect(down.size).toBe(7);
    const custom = structuredClone(s.options.custom);
    for (const v of [0, 1, 2, 3, null]) {
      const seen = redactState(s, v).options.custom!;
      for (const h of seen.hexes.filter((x) => down.has(key(x.q, x.r)))) expect(h).toEqual({ q: h.q, r: h.r, terrain: 'sea', hidden: true });
      for (const p of seen.ports) {
        expect(down.has(key(p.q, p.r))).toBe(false);
        expect(`${p.q},${p.r},${p.side}`).not.toBe('2,0,1');
      }
      expect(JSON.stringify(seen)).not.toMatch(/mountains","number":6,"hidden"/);
    }
    // (The server's own state is left as it was.)
    expect(s.options.custom).toEqual(custom);
  });

  it('shows no harbour on a face-down hex, or facing one, until it turns up (R3)', () => {
    const g = playGame('fog', 7, keyed(2, FOG).options, keyed(2).secret);
    const at = (s: GameState, q: number, r: number) => s.board.hexes.findIndex((h) => h.q === q && h.r === r);
    let shownAfter = -1;
    for (const [i, st] of [g.initial, ...g.steps.map((x) => x.state)].entries()) {
      const hidden = new Set(st.ext.sea!.fog!.hidden);
      const view = redactState(st, 0);
      for (const p of view.board.ports) expect(st.board.edges[p.edge].hexes.some((h) => hidden.has(h)), `step ${i}`).toBe(false);
      for (const v of view.board.vertices) if (v.port !== null) expect(view.board.ports.some((p) => p.vertices.includes(v.id) && p.type === v.port)).toBe(true);
      // The islet's ore harbour and the island's wool one, once what they're on and face has turned up.
      const ore = view.board.ports.some((p) => p.type === 'ore' && p.hex === at(st, 4, -2));
      expect(ore).toBe(!hidden.has(at(st, 4, -2)) && !hidden.has(at(st, 5, -2)));
      if (ore && shownAfter < 0) shownAfter = i;
      // (The ports kept keep their ids.)
      for (const p of view.board.ports) expect(st.board.ports[p.id]).toEqual(p);
    }
    expect(g.final.ext.sea!.fog!.hidden.length).toBeLessThan(7);
  }, 1_200_000);

  it('looks the same whatever lies under it', () => {
    // A twin of the map with the islet's tiles and numbers dealt round it otherwise.
    const twin = fogMap();
    const islet = twin.hexes.filter((h) => h.hidden && h.terrain !== 'sea');
    const turned = [...islet.slice(1), islet[0]].map((h) => ({ terrain: h.terrain, number: h.number }));
    twin.hexes = twin.hexes.map((h) => {
      const i = islet.indexOf(h);
      return i < 0 ? h : { ...h, ...turned[i] };
    });
    const g = playGame('fog a', 8, keyed(3, FOG).options, keyed(3).secret, { maxSteps: 300 });
    let b = createGame(setups(4), { layout: 'random', seed: 8, ...keyed(3, { ...FOG, custom: twin }).options }, keyed(3).secret).state;
    expect(b.board.hexes.map((h) => h.terrain)).not.toEqual(g.initial.board.hexes.map((h) => h.terrain));
    let compared = 0;
    for (const st of g.steps) {
      for (const v of [0, 1, 2, 3, null]) expect(canonical(wireView(b, v)), `seq ${st.before.seq} viewer ${v}`).toBe(canonical(wireView(st.before, v)));
      compared++;
      if (st.events.some((e) => e.type === 'sea/hexRevealed' && !st.before.board.hexes[e.hex].terrain.startsWith('sea'))) break;
      const r = applyAction(b, st.actor, st.action);
      expect(r.ok).toBe(true);
      b = r.ok ? r.state : b;
    }
    expect(compared).toBeGreaterThan(20);
  }, 1_200_000);
});
