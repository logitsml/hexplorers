// The presenter's pure parts (src/game/presenter.ts): what a blocked or short roll is shown to have
// cost, reckoned as the engine reckons a hex's yield, and what an undo is said to have taken back.

import { describe, expect, it } from 'vitest';
import { createGame, numbersOf, type GameEvent, type GameState } from '../src/engine';
import { mixOf, type Expansion } from '../src/engine/presets';
import { awardsUndone, harbourFor, lostCards, rollPauses, stagedState } from '../src/game/presenter';
import { THROW_TIME } from '../src/render/fx/dice3d';
import { blockersHeld, happeningLine, sevenBlockers } from '../src/game/tableWords';
import { patch } from './helpers';
import { setups } from './sim-harness';

function game(mods: Expansion[]): GameState {
  const m = mixOf(mods);
  return createGame(setups(4), { modules: m.modules, map: m.map, knobs: m.knobs, victoryPoints: m.target, seed: 7 }).state;
}

/** A land hex of `terrain` with a number, and one of its corners. */
function spot(s: GameState, terrain: string) {
  const hex = s.board.hexes.find((h) => h.terrain === terrain && numbersOf(s, h).length > 0)!;
  return { hex: hex.id, total: numbersOf(s, hex)[0], vertex: hex.vertices[0] };
}

type Production = Extract<GameEvent, { type: 'production' }>;
const production = (p: Partial<Production> & { total: number }): Production => ({ type: 'production', grants: [], blockedHexes: [], shortages: [], ...p });

describe('cards a roll would have paid', () => {
  it('a blocked foundry loses all three of its cards', () => {
    const base = game(['oil']);
    const at = spot(base, 'hills');
    const s = patch(base, (d) => {
      d.buildings[at.vertex] = { owner: 1, kind: 'city', foundry: true };
      d.robberHex = at.hex;
    });
    expect(lostCards(s, production({ total: at.total, blockedHexes: [at.hex] }))).toEqual([{ hex: at.hex, resource: 'brick', amount: 3, reason: 'blocked' }]);
  });

  it('a blocked Guilds city on the forest loses a wood and a paper, not two wood', () => {
    const base = game(['guilds']);
    const at = spot(base, 'forest');
    const s = patch(base, (d) => {
      d.buildings[at.vertex] = { owner: 2, kind: 'city' };
      d.robberHex = at.hex;
    });
    const lost = lostCards(s, production({ total: at.total, blockedHexes: [at.hex] }));
    expect(lost).toEqual([
      { hex: at.hex, resource: 'wood', amount: 1, reason: 'blocked' },
      { hex: at.hex, resource: 'paper', amount: 1, reason: 'blocked' },
    ]);
  });

  it('a short supply shows only what went unpaid', () => {
    const base = game(['oil']);
    const at = spot(base, 'fields');
    const s = patch(base, (d) => {
      d.buildings[at.vertex] = { owner: 0, kind: 'city' };
    });
    const grants = [{ player: 0, hex: at.hex, vertex: at.vertex, resource: 'wheat' as const, amount: 1 }];
    expect(lostCards(s, production({ total: at.total, grants, shortages: ['wheat'] }))).toEqual([{ hex: at.hex, resource: 'wheat', amount: 1, reason: 'supply' }]);
    // (A resource the supply could pay loses nothing.)
    expect(lostCards(s, production({ total: at.total, grants, shortages: ['ore'] }))).toEqual([]);
  });
});

describe('an undo that took an award back', () => {
  const base = game(['harbourmaster', 'sea']);

  it('says where the award went and names nobody twice', () => {
    const won = patch(base, (d) => {
      d.ext.harbourmaster!.holder = 0;
    });
    const lines = awardsUndone(won, base, (p) => p === 0);
    // (Told in the colours of whoever lost it.)
    expect(lines).toEqual([{ player: 0, text: 'The Port Captain award goes back to the supply' }]);
    const toBen = patch(base, (d) => {
      d.ext.harbourmaster!.holder = 1;
    });
    expect(awardsUndone(won, toBen, (p) => p === 0)[0].text).toBe(`The Port Captain award goes back to ${base.players[1].name}`);
    expect(awardsUndone(won, won, (p) => p === 0)).toEqual([]);
  });

  it('takes back a first landing', () => {
    if (!base.ext.sea?.landed) return;
    const islet = base.board.islands.findIndex((i) => !i.home);
    const landed = patch(base, (d) => {
      d.ext.sea!.landed![2] = [islet];
    });
    const [l] = awardsUndone(landed, base, () => false);
    expect(l.player).toBe(2);
    expect(l.text).toMatch(new RegExp(`^${base.players[2].name}’s first landing on the .* is taken back$`));
  });
});

describe('the pieces as of each event in a message', () => {
  it('lands raiders one landing at a time', () => {
    const base = game(['invasion']);
    const [a, b] = base.board.hexes.filter((h) => h.terrain !== 'sea' && numbersOf(base, h).length).map((h) => h.id);
    // After the message: two raiders on a (one there before it), one on b.
    const next = patch(base, (d) => {
      d.ext.invasion!.raiders[a] = 2;
      d.ext.invasion!.raiders[b] = 1;
    });
    const land = (hex: number, raiders: number): GameEvent => ({ type: 'invasion/landed', player: 0, cause: 'build', dice: [3, 4], number: 7, hex, raiders });
    const events: GameEvent[] = [{ type: 'settlementBuilt', player: 0, vertex: 0 }, land(a, 2), land(b, 1)];
    expect(stagedState(next, events, 1).ext.invasion!.raiders[a]).toBe(2);
    expect(stagedState(next, events, 1).ext.invasion!.raiders[b]).toBe(0);
    // (The last staged event sees the message's end, and isn't copied.)
    expect(stagedState(next, events, 2)).toBe(next);
  });

  it('keeps raiders a later battle drives off, and the corsair a later event brings in', () => {
    const base = game(['invasion', 'sea']);
    const hex = base.board.hexes.find((h) => h.terrain !== 'sea' && numbersOf(base, h).length)!.id;
    const sea = base.board.hexes.find((h) => h.terrain === 'sea')!.id;
    const next = patch(base, (d) => {
      d.ext.invasion!.raiders[hex] = 0;
      d.ext.sea!.corsair = sea;
    });
    const events: GameEvent[] = [
      { type: 'invasion/marched', player: 1, warden: 0, from: 0, to: 1, paid: false } as unknown as GameEvent,
      { type: 'invasion/battle', hex, raiders: 2, conquered: false, strength: 3, participants: [1], prisoners: { 1: 2 }, coins: {}, rolls: [] },
      { type: 'fleet/blockersIn', robber: null, corsair: sea },
    ];
    const asOfMarch = stagedState(next, events, 0);
    expect(asOfMarch.ext.invasion!.raiders[hex]).toBe(2);
    expect(asOfMarch.ext.sea!.corsair).toBeNull();
    expect(stagedState(next, events, 1).ext.invasion!.raiders[hex]).toBe(0);
    expect(stagedState(next, events, 1).ext.sea!.corsair).toBeNull();
  });

  it('holds the raider fleet at its own step though an attack sends it home', () => {
    const base = game(['guilds']);
    const next = patch(base, (d) => {
      d.ext.fleet!.position = 0;
    });
    const events: GameEvent[] = [
      { type: 'fleet/advanced', position: 7, steps: 7 },
      { type: 'fleet/attack', strength: 4, defence: 5, contributions: [5, 0, 0, 0], won: true },
    ];
    expect(stagedState(next, events, 0).ext.fleet!.position).toBe(7);
    expect(stagedState(next, events, 1)).toBe(next);
  });
});

describe('what a 7 stirs', () => {
  it('follows the blockers the mix has', () => {
    expect(sevenBlockers(game(['oil']))).toEqual(['robber']);
    expect(sevenBlockers(game(['sea']))).toEqual(['robber', 'corsair']);
    expect(sevenBlockers(game(['invasion']))).toEqual([]);
    // (All Hands keeps the corsair beside the raiders.)
    const all = game(['sea', 'guilds', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster']);
    expect(sevenBlockers(all)).toEqual(all.options.knobs.corsairStays ? ['corsair'] : []);
    // The raider fleet holds them off until its first attack.
    expect(blockersHeld(game(['guilds']))).toBe(true);
    expect(happeningLine(game(['guilds']), 'thieves')).toBe('A 7: big hands lose half.');
    expect(happeningLine(game(['sea']), 'thieves')).toBe('A 7: the robber or the corsair moves and big hands lose half.');
  });
});

describe('a harbour boat for a harbour trade', () => {
  it('sails only for a rate a harbour of yours gives', () => {
    const base = game(['guilds']);
    const port = base.board.ports.find((p) => p.type !== 'any')!;
    const s = patch(base, (d) => {
      d.buildings[port.vertices[0]] = { owner: 1, kind: 'settlement' };
    });
    expect(harbourFor(s, 1, port.type as 'wool', 2)).toBe(port.type);
    // (A 2:1 in something else came from the trader or Commerce, not this harbour; and nobody else's boat sails.)
    const other = (['brick', 'wood', 'wool', 'wheat', 'ore'] as const).find((r) => r !== port.type)!;
    expect(harbourFor(s, 1, other, 2)).toBeNull();
    expect(harbourFor(s, 1, 'paper', 2)).toBeNull();
    expect(harbourFor(s, 0, port.type as 'wool', 2)).toBeNull();
  });
});

describe('a seven that costs you half your hand', () => {
  it('asks for the cards only once the dice are at rest and the seven has been seen', () => {
    const [landed, after] = rollPauses(true, false, true);
    // (The island's dice come to rest at THROW_TIME; the seven rises over them after that.)
    expect(landed + after).toBeGreaterThanOrEqual(THROW_TIME + 0.8);
    expect(after).toBeGreaterThan(rollPauses(true, false, false)[1]);
    // The flat map's dice are down sooner, and it waits for them all the same.
    const [flatLanded, flatAfter] = rollPauses(true, true, true);
    expect(flatLanded + flatAfter).toBeGreaterThanOrEqual(0.95 + 0.8);
  });

  it('keeps the usual beat for anyone else, a replay among them', () => {
    expect(rollPauses(true, false, false)).toEqual([1.35, 0.6]);
    expect(rollPauses(true, true, false)).toEqual([1.05, 0.6]);
    // (Not a seven: no beat after it at all.)
    expect(rollPauses(false, false, true)).toEqual([1.35, 0]);
  });
});
