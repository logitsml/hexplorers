import { describe, expect, it } from 'vitest';
import { bridgeSites, legalCities, legalRoads, legalSettlements, placeAllowed, placeReason, type GameState } from '../src/engine';
import { placeWarden } from '../src/engine/modules/garrisons/wardens';
import { game } from './modules/guilds-helpers';
import { toMain } from './helpers';

function ownRoad(s: GameState): number {
  const e = s.routes.findIndex((r) => r?.owner === 0);
  if (e < 0) throw new Error('fixture needs a road');
  return e;
}

describe('placement explanations without changing rules', () => {
  it('finds the cracked-road veto rather than claiming no road is connected', () => {
    const s = game(['almanac']);
    toMain(s, 0);
    expect(legalRoads(s, 0).length).toBeGreaterThan(0);
    s.routes[ownRoad(s)]!.cracked = true;
    expect(legalRoads(s, 0)).toEqual([]);
    expect(placeReason(s, 0, 'road')).toMatch(/Mend your cracked road/);
    const e = s.board.edges.find((e) => !s.routes[e.id])!.id;
    expect(placeReason(s, 0, 'ship', e)).toMatch(/Mend your cracked road/);
    const v = s.board.edges[ownRoad(s)].a;
    expect(placeReason(s, 0, 'settlement', v)).toMatch(/cracked road/);
  });

  it('names raiders blocking every city upgrade and ignores blocked sites when another remains legal', () => {
    const s = game(['invasion']);
    toMain(s, 0);
    const v = s.buildings.findIndex((b) => b?.owner === 0 && b.kind === 'settlement');
    expect(legalCities(s, 0)).toContain(v);
    const h = s.board.vertices[v].hexes[0];
    s.ext.invasion!.raiders[h] = 3;
    expect(placeAllowed(s, 0, 'city', v)).toBe(false);
    expect(placeReason(s, 0, 'city', v)).toMatch(/raiders/);
    expect(placeReason(s, 0, 'city')).toMatch(/raiders/);
    const other = s.board.vertices.find((x) => !x.hexes.includes(h) && x.land && !s.buildings[x.id])!.id;
    s.buildings[other] = { owner: 0, kind: 'settlement' };
    expect(placeReason(s, 0, 'city')).toBeNull();
  });

  it('names the warden occupying an otherwise valid settlement corner', () => {
    const s = game(['guilds', 'garrisons']);
    toMain(s, 0);
    const v = s.board.vertices.find((v) => !s.buildings[v.id] && v.land && v.neighbors.every((n) => !s.buildings[n]))!;
    s.routes[v.edges[0]] = { owner: 0, kind: 'road', builtTurn: 0 };
    expect(legalSettlements(s, 0)).toContain(v.id);
    placeWarden(s, 1, 1, { vertex: v.id, edge: null });
    expect(legalSettlements(s, 0)).not.toContain(v.id);
    expect(placeReason(s, 0, 'settlement', v.id)).toMatch(/warden occupies/);
  });

  it('names a bridge crossing, and does not mutate a query state', () => {
    const s = game(['sea', 'rivers']);
    toMain(s, 0);
    const crossing = [...bridgeSites(s)][0];
    const before = JSON.stringify(s);
    expect(placeReason(s, 0, 'ship', crossing)).toMatch(/bridge/);
    for (const kind of ['road', 'settlement', 'city', 'ship'] as const) placeReason(s, 0, kind);
    expect(JSON.stringify(s)).toBe(before);
  });
});
