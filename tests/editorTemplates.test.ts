/// <reference types="node" />
// The editor's templates make the same maps they always have: with the dice of a fixed
// Math.random, each of the original eight is pinned to a hash of the map it makes and of the
// board a game on it is dealt (a seed dealt the same island is what a saved game relies on).

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBoard, createGame } from '../src/engine';
import { centreOf, checkCustomMap, customSpec, hexDistance, type CustomMap } from '../src/engine/maps/custom';
import { mixOf } from '../src/engine/presets';
import { Rng } from '../src/engine/rng';
import { TEMPLATES } from '../src/ui/editor/templates';
import { setups } from './sim-harness';

const hash = (x: unknown) => createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 12);

/** [map, dealt board] hashes of the templates as they were before the grid grew. */
const PINNED: Record<string, [string, string]> = {
  classic: ['4186d5966f2b', '94e09b782ef2'],
  random: ['dad63e8b81ee', '2cd10e24ce29'],
  small: ['283b8868903b', '20a033d4d279'],
  big: ['f9cb80060b51', '2e7f9e54b0cb'],
  twins: ['7044a7ac07ce', '10c55df9db00'],
  lagoon: ['30fbf0a7904f', 'e89e71e51117'],
  archipelago: ['12324b89d73c', '9a8fe338e16f'],
  fog: ['fd543de82e1f', 'dad6153848de'],
};

describe('the original templates', () => {
  beforeEach(() => void vi.spyOn(Math, 'random').mockReturnValue(0.123456));
  afterEach(() => vi.restoreAllMocks());

  it('make the maps they always have', () => {
    const got = Object.fromEntries(
      Object.keys(PINNED).map((id) => {
        const m = TEMPLATES.find((t) => t.id === id)!.make();
        return [id, [hash(m), hash(customSpec(m, new Rng(7), true))]];
      }),
    );
    expect(got).toEqual(PINNED);
  });
});

describe('the shape templates', () => {
  const NEW = ['rectangle', 'strip', 'atoll', 'isles', 'offshore', 'twins'];
  const sea = mixOf(['sea']).modules;

  it('make centred maps that pass the check and deal a game, with Sea Lanes where they call for it', () => {
    for (const id of NEW) {
      const map = TEMPLATES.find((t) => t.id === id)!.make();
      expect(centreOf(map), id).toEqual([0, 0]);
      expect(map.ports.length, id).toBeGreaterThan(0);
      for (const [modules, players] of [[[], 4], [sea, 4], [[], 3]] as const) {
        const c = checkCustomMap(map, { players, victoryPoints: 10, modules: [...modules], tryGame: (seed) => createGame(setups(players), { map: 'custom', custom: map, modules: [...modules], seed }) });
        // (Without Sea Lanes the isles can't be reached, which a game on them survives: it is warned of, not refused.)
        expect(c.errors, `${id} ${modules.length ? 'with' : 'without'} Sea Lanes`).toEqual([]);
      }
    }
  });

  it('are the shapes they are called', () => {
    const made = Object.fromEntries(NEW.map((id) => [id, TEMPLATES.find((t) => t.id === id)!.make()]));
    const land = (m: CustomMap) => m.hexes.filter((h) => h.terrain !== 'sea');
    // 7 × 5 hexes, and a strip of three rows.
    expect(land(made.rectangle)).toHaveLength(35);
    expect(new Set(land(made.strip).map((h) => h.r)).size).toBe(3);
    // The atoll's lagoon is open water inside its ring, and its inlet joins the sea outside.
    const lagoon = made.atoll.hexes.filter((h) => h.terrain === 'sea' && hexDistance(h.q, h.r) <= 2);
    expect(lagoon).toHaveLength(19);
    expect(buildBoard(customSpec(made.atoll)).islands).toHaveLength(1);
    // Four isles are four islands (two of them home), and the offshore isles five.
    expect(buildBoard(customSpec(made.isles)).islands.map((i) => i.home)).toEqual([true, true, false, false]);
    expect(buildBoard(customSpec(made.offshore)).islands).toHaveLength(5);
    // The bigger shapes are written in the newer format, the smaller in the old.
    expect(made.atoll.v).toBe(3);
    expect(made.rectangle.v).toBe(2);
  });
});
