// How a hex looks to the person at the table (src/game/hexView.ts): a face-down hex is only
// "Unexplored", a found one carries the number it drew from the face-down discs, and a polluted one
// has lost the numbers pollution took. The words (tooltip, screen reader, log lines, panels) all
// come from here, so these are the cases that decide whether they leak or mislead.

import { describe, expect, it } from 'vitest';
import { TERRAIN_RESOURCE, createGame, isLand, numbersOf, redactState, type GameState } from '../src/engine';
import { seenBoard } from '../src/engine/modules/sea/fog';
import { oilOf } from '../src/engine/modules/oil/rules';
import { edgePlace, hexPlace, seenHex } from '../src/game/hexView';
import { hexName } from '../src/game/moduleEvents';
import { patch } from './helpers';
import { setups } from './sim-harness';

/** The Fog Bank with Sea Lanes and Oil: face-down hexes, and numbers pollution can take. */
function foggy(seed = 3): GameState {
  return createGame(setups(4), { seed, map: 'fogBank', modules: ['sea', 'oil'], victoryPoints: 12 }).state;
}

const s0 = foggy();
const fog = s0.ext.sea!.fog!;
/** A face-down hex with land under it, and what it is. */
const underLand = fog.hidden.find((h) => TERRAIN_RESOURCE[s0.board.hexes[h].terrain] !== null)!;
const underTerrain = s0.board.hexes[underLand].terrain;

describe('a face-down hex', () => {
  it('is unexplored, with no terrain, resource or number', () => {
    // (The test only means something if the state does hold the land underneath.)
    expect(isLand(underTerrain)).toBe(true);
    const v = seenHex(s0, underLand);
    expect(v).toMatchObject({ hidden: true, terrain: 'sea', land: false, resource: null, numbers: [], pips: 0, label: 'Unexplored' });
    expect(JSON.stringify(v).toLowerCase()).not.toContain(underTerrain);
  });

  it('shows what the shown board shows, for every hex', () => {
    const shown = seenBoard(s0.board, fog.hidden);
    for (const h of s0.board.hexes) {
      const v = seenHex(s0, h.id);
      expect(v.terrain).toBe(shown.hexes[h.id].terrain);
      expect(v.hidden).toBe(fog.hidden.includes(h.id));
    }
  });

  it('is the same on a state a client was sent (the host redacts the board the same way)', () => {
    const sent = redactState(s0, 0);
    for (const h of fog.hidden) expect(seenHex(sent, h)).toEqual(seenHex(s0, h));
  });

  it('is named without its terrain in a sentence, and is not land beside an edge', () => {
    expect(hexName(s0, underLand)).toBe('the unexplored hex');
    expect(hexPlace(s0, underLand)).toBe('the unexplored hex');
    const edge = s0.board.edges.find((e) => e.hexes.includes(underLand) && e.hexes.every((h) => fog.hidden.includes(h) || !isLand(s0.board.hexes[h].terrain)))!;
    expect(edgePlace(s0, edge.id)).toBe('out at sea');
  });
});

describe('a found hex', () => {
  /** `underLand`, turned up with a 10 drawn from the face-down discs (it isn't printed on the hex). */
  const found = patch(s0, (x) => {
    x.ext.sea!.fog!.hidden = x.ext.sea!.fog!.hidden.filter((h) => h !== underLand);
    x.ext.sea!.fog!.drawn[underLand] = 10;
  });

  it('is its terrain, its resource and the number it drew', () => {
    expect(found.board.hexes[underLand].numbers).toEqual([]);
    const v = seenHex(found, underLand);
    expect(v).toMatchObject({ hidden: false, terrain: underTerrain, land: true, resource: TERRAIN_RESOURCE[underTerrain], numbers: [10], pips: 3 });
    expect(v.label).not.toBe('Unexplored');
    expect(hexName(found, underLand)).toContain('on the 10');
    expect(hexPlace(found, underLand)).toContain('10');
  });

  it('keeps the rest face down', () => {
    for (const h of found.ext.sea!.fog!.hidden) expect(seenHex(found, h).label).toBe('Unexplored');
  });

  it('loses the number to pollution like any other', () => {
    const polluted = patch(found, (x) => oilOf(x).lost.push({ hex: underLand, number: 10 }));
    expect(seenHex(polluted, underLand)).toMatchObject({ numbers: [], pips: 0, terrain: underTerrain });
  });
});

describe('a polluted hex', () => {
  const printed = s0.board.hexes.find((h) => isLand(h.terrain) && !fog.hidden.includes(h.id) && h.numbers.length === 1 && h.numbers[0] !== 7)!;

  it('lists the numbers it has left, not the ones printed on it', () => {
    const v0 = seenHex(s0, printed.id);
    expect(v0.numbers).toEqual(printed.numbers);
    const x = patch(s0, (y) => oilOf(y).lost.push({ hex: printed.id, number: printed.numbers[0] }));
    expect(numbersOf(x, printed)).toEqual([]);
    const v = seenHex(x, printed.id);
    expect(v).toMatchObject({ numbers: [], pips: 0, hidden: false, terrain: printed.terrain });
    expect(hexName(x, printed.id)).not.toMatch(/ on the \d/);
  });

  it('keeps one of two numbers when pollution took the other', () => {
    const two = s0.board.hexes.find((h) => h.numbers.length === 2);
    if (!two) return;
    const x = patch(s0, (y) => oilOf(y).lost.push({ hex: two.id, number: two.numbers[0] }));
    expect(seenHex(x, two.id).numbers).toEqual([two.numbers[1]]);
  });
});

describe('a fishing ground', () => {
  const fished = createGame(setups(4), { seed: 5, modules: ['fisheries', 'oil'], victoryPoints: 10 }).state;
  const ground = fished.board.hexes.find((h) => h.terrain === 'sea' && h.numbers.length > 0);

  it('stays a fishing ground when pollution takes its numbers, and open sea is not one', () => {
    expect(ground).toBeDefined();
    const g = ground!;
    expect(seenHex(fished, g.id)).toMatchObject({ label: 'Fishing ground', kind: 'fishing ground', numbers: g.numbers });
    const x = patch(fished, (y) => g.numbers.forEach((n) => oilOf(y).lost.push({ hex: g.id, number: n })));
    expect(seenHex(x, g.id)).toMatchObject({ label: 'Fishing ground', numbers: [], pips: 0 });
    const open = s0.board.hexes.find((h) => h.terrain === 'sea' && h.numbers.length === 0 && !fog.hidden.includes(h.id))!;
    expect(seenHex(s0, open.id)).toMatchObject({ label: 'Sea', kind: 'open sea', resource: null });
  });
});
