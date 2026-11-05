// The raider fleet: its track, its attacks and what they cost or earn, the robber's wait, plus
// bot games and fuzzing of the full set (guilds, garrisons and the fleet) to 13 points.
//
// Each seat's city on the beginner island (seed 7): seat 0 at 15, seat 1 at 38, seat 2 at 9,
// seat 3 at 13. The desert is hex 9.

import { afterAll, describe, expect, it } from 'vitest';
import { createGame, legalActions, legalCities, totalVictoryPoints, type GameState } from '../../src/engine';
import { FLEET_STEPS, fleetStrength } from '../../src/engine/modules/fleet';
import { newWardenId } from '../../src/engine/modules/shared';
import type { BotDifficulty } from '../../src/engine/ai';
import { grant, patch as rawPatch } from '../helpers';
import { runBotGame, runFuzzGame, setups, type GameResult } from '../sim-harness';
import { act, citiesOf, eventsOf, game, main, rollAs, settle, summarize } from './guilds-helpers';
import { slow, timeout } from '../tier';

const ALL = ['guilds', 'garrisons', 'fleet'] as const;

const patch = (s: GameState, fn: (x: GameState) => void) =>
  rawPatch(s, (x) => {
    fn(x);
    settle(x);
  });

function warden(s: GameState, owner: number, rank: 1 | 2 | 3, vertex: number, mustered = true) {
  const id = newWardenId(s);
  s.wardens.push({ id, owner, rank, mustered, vertex, edge: null, musteredTurn: 0 });
}

/** A full-set game with the fleet one step out. */
const closing = (fn: (x: GameState) => void = () => {}, opts: Record<string, unknown> = {}) =>
  patch(game([...ALL], opts), (x) => {
    x.ext.fleet!.position = FLEET_STEPS - 1;
    fn(x);
  });

describe('fleet: the track and the robber', () => {
  it('keeps the robber off the board until the first attack', () => {
    const s = game([...ALL]);
    expect(s.robberHex).toBeNull();
    expect(s.ext.fleet).toMatchObject({ position: 0, attacks: 0 });
  });

  it('moves no robber and robs nobody on a 7 before the first attack, though hands are still halved', () => {
    const s = patch(game([...ALL]), (x) => grant(x, 1, { wheat: 8 }));
    const { state } = rollAs(s, 0, { total: 7 });
    expect(state.phase).toBe('discard');
    const after = act(state, 1, legalActions(state, 1)[0]).state;
    expect(after.phase).toBe('main');
    expect(after.robberHex).toBeNull();
  });

  it('sails a step on each ship face, and nowhere on a track face', () => {
    const s = game([...ALL]);
    const ship = rollAs(s, 0, { face: 'ship' });
    expect(ship.state.ext.fleet!.position).toBe(1);
    expect(eventsOf(ship.events, 'fleet/advanced')).toEqual([{ type: 'fleet/advanced', position: 1, steps: FLEET_STEPS }]);
    expect(rollAs(s, 0, { face: 'commerce' }).state.ext.fleet!.position).toBe(0);
  });

  it('attacks on reaching the end of its track (seven steps), then sets out again and the robber comes in', () => {
    const s = closing();
    const { state, events } = rollAs(s, 0, { face: 'ship', total: 8 });
    expect(eventsOf(events, 'fleet/attack')).toHaveLength(1);
    expect(state.ext.fleet).toMatchObject({ position: 0, attacks: 1 });
    expect(state.robberHex).toBe(9);
  });

  it('leaves a blocker Fisheries still holds off at the first attack, until a 7 (rule 4: every delay over)', () => {
    const sea = (seen: boolean) =>
      patch(createGame(setups(4), { seed: 3, map: 'archipelago', modules: ['sea', 'guilds', 'garrisons', 'fleet', 'fisheries'], victoryPoints: 16 }).state, (x) => {
        x.turn = 5;
        x.setupIndex = x.setupOrder.length;
        x.phase = 'roll';
        x.hasRolled = false;
        x.currentPlayer = 0;
        x.ext.fleet!.position = FLEET_STEPS - 1;
        x.ext.fisheries!.sevenSeen = seen;
      });
    const early = rollAs(sea(false), 0, { face: 'ship', total: 8 }).state;
    expect(early.ext.fleet!.attacks).toBe(1);
    expect(early.ext.sea!.corsair).toBeNull();
    // A 7 rolled before the attack (it moved nothing then) ends Fisheries' wait: the corsair comes in with the fleet.
    const later = rollAs(sea(true), 0, { face: 'ship', total: 8 }).state;
    expect(later.ext.sea!.corsair).not.toBeNull();
  });

  it('holds the robber and the corsair off a sea map until the first attack, though Sea Lanes would offer them (rule 4)', () => {
    // The Long Voyage: Sea Lanes' hooks run before the fleet's, and on their own would offer either blocker.
    const s0 = createGame(setups(4), { seed: 3, map: 'archipelago', modules: ['sea', 'guilds', 'garrisons', 'fleet'], victoryPoints: 16 }).state;
    const s = patch(s0, (x) => {
      x.turn = 5;
      x.setupIndex = x.setupOrder.length;
      x.currentPlayer = 0;
      x.phase = 'roll';
      x.hasRolled = false;
    });
    expect([s.robberHex, s.ext.sea!.corsair]).toEqual([null, null]);
    const start = s.ext.fleet!.corsairStart;
    expect(start).not.toBeNull();
    const { state, events } = rollAs(s, 0, { total: 7 });
    expect(state.pending).toEqual([]);
    expect(state.phase).toBe('main');
    expect([state.robberHex, state.ext.sea!.corsair]).toEqual([null, null]);
    expect(eventsOf(events, 'nothingToSteal')).toHaveLength(1);
    // Once the fleet has attacked, the corsair is at sea and a 7 moves a blocker as usual.
    const after = patch(s, (x) => {
      x.ext.fleet!.attacks = 1;
      x.ext.sea!.corsair = start;
    });
    expect(rollAs(after, 0, { total: 7 }).state.pending.at(-1)).toMatchObject({ kind: 'sea/blocker', players: [0] });
  });

  it('can’t share a game with Invasion', () => {
    expect(() => createGame(setups(4), { modules: ['guilds', 'garrisons', 'fleet', 'invasion'] })).toThrow(/fleet and invasion/);
  });
});

describe('fleet: the attack', () => {
  it('counts every city on the board, seats included, against every mustered warden', () => {
    const s = closing((x) => {
      x.buildings[9]!.seat = 'learning';
      x.ext.guilds!.levels[2].learning = 4;
      warden(x, 0, 2, 2);
      warden(x, 1, 1, 30, false);
    });
    expect(fleetStrength(s)).toBe(4);
    const { events } = rollAs(s, 0, { face: 'ship', total: 8 });
    expect(eventsOf(events, 'fleet/attack')[0]).toMatchObject({ strength: 4, defence: 2, contributions: [2, 0, 0, 0], won: false });
  });

  it('takes a city from each of the least defenders, sparing seats, and gives walls back', () => {
    const s = closing((x) => {
      warden(x, 0, 2, 2);
      warden(x, 1, 1, 30);
      x.buildings[13]!.wall = true;
    });
    const { state, events } = rollAs(s, 0, { face: 'ship', total: 8 });
    expect(eventsOf(events, 'fleet/pillaged').map((e) => e.player)).toEqual([2, 3]);
    expect(state.buildings[9]).toEqual({ owner: 2, kind: 'settlement' });
    expect(state.buildings[13]).toEqual({ owner: 3, kind: 'settlement' });
    expect(state.players[3]).toMatchObject({ citiesLeft: 4, settlementsLeft: 3 });
    expect(totalVictoryPoints(state, 3)).toBe(2);
    // Every warden rests afterwards.
    expect(state.wardens.every((w) => !w.mustered)).toBe(true);
  });

  it('moves up the order when the least defenders have no city it may take', () => {
    const s = closing((x) => {
      warden(x, 0, 2, 2);
      warden(x, 1, 1, 30);
      x.buildings[9]!.seat = 'learning';
      x.ext.guilds!.levels[2].learning = 4;
      x.buildings[13]!.seat = 'commerce';
      x.ext.guilds!.levels[3].commerce = 4;
    });
    const { state, events } = rollAs(s, 0, { face: 'ship', total: 8 });
    expect(eventsOf(events, 'fleet/pillaged').map((e) => e.player)).toEqual([1]);
    expect(state.buildings[38]!.kind).toBe('settlement');
    expect(state.buildings[9]!.kind).toBe('city');
  });

  it('lets a player with several cities choose which to lose', () => {
    const s = closing((x) => {
      warden(x, 0, 2, 2);
      warden(x, 1, 1, 30);
      warden(x, 2, 1, 18);
      x.buildings[41]!.kind = 'city';
      x.players[3].citiesLeft--;
      x.players[3].settlementsLeft++;
    });
    const { state } = rollAs(s, 0, { face: 'ship', total: 8 });
    expect(state.pending.map((p) => [p.kind, p.players])).toEqual([['fleet/pillage', [3]]]);
    expect(legalActions(state, 3)).toEqual([
      { type: 'fleet/yield', vertex: 13 },
      { type: 'fleet/yield', vertex: 41 },
    ]);
    const after = act(state, 3, { type: 'fleet/yield', vertex: 41 }).state;
    expect(after.buildings[41]!.kind).toBe('settlement');
    expect(after.buildings[13]!.kind).toBe('city');
  });

  it('lays a city down when no settlement piece is free; it is the next one stood up, with no new piece', () => {
    let s = closing((x) => {
      warden(x, 0, 1, 2);
      warden(x, 1, 1, 30);
      warden(x, 2, 1, 18);
      for (const v of [0, 6, 47, 52]) x.buildings[v] = { owner: 3, kind: 'settlement' };
      x.players[3].settlementsLeft = 0;
    });
    s = rollAs(s, 0, { face: 'ship', total: 8 }).state;
    expect(s.buildings[13]).toEqual({ owner: 3, kind: 'settlement', lying: true });
    expect(s.players[3]).toMatchObject({ citiesLeft: 3, settlementsLeft: 0 });
    expect(legalCities(s, 3)).toEqual([13]);
    s = patch(s, (x) => {
      main(x, 3);
      grant(x, 3, { wheat: 2, ore: 3 });
    });
    s = act(s, 3, { type: 'buildCity', vertex: 13 }).state;
    expect(s.buildings[13]).toEqual({ owner: 3, kind: 'city' });
    expect(s.players[3]).toMatchObject({ citiesLeft: 3, settlementsLeft: 0 });
  });

  it('lets a player buy a city off for five coins with Rivers', () => {
    const s = closing(
      (x) => {
        warden(x, 0, 1, 2);
        warden(x, 1, 1, 30);
        warden(x, 2, 1, 18);
        x.players[3].coins = 6;
      },
      { modules: ['guilds', 'garrisons', 'fleet', 'rivers'] },
    );
    const { state } = rollAs(s, 0, { face: 'ship', total: 8 });
    expect(legalActions(state, 3)).toEqual([{ type: 'fleet/yield', vertex: 13 }, { type: 'fleet/ransom' }]);
    const after = act(state, 3, { type: 'fleet/ransom' }).state;
    expect(after.buildings[13]!.kind).toBe('city');
    // (Five coins less, whatever the river corners had paid meanwhile.)
    expect(after.players[3].coins).toBe(state.players[3].coins - 5);
  });

  it('gives the top defender a point when the defence holds', () => {
    const s = closing((x) => {
      warden(x, 0, 3, 2);
      warden(x, 1, 1, 30);
    });
    const { state, events } = rollAs(s, 0, { face: 'ship', total: 8 });
    expect(eventsOf(events, 'fleet/token')).toEqual([{ type: 'fleet/token', player: 0 }]);
    expect(totalVictoryPoints(state, 0)).toBe(4);
    expect(citiesOf(state, 3)).toEqual([13]);
  });

  it('gives each tied top defender a venture of their choice, in turn order from the roller', () => {
    let s = closing((x) => {
      x.currentPlayer = 1;
      warden(x, 0, 2, 2);
      warden(x, 1, 2, 30);
    });
    const r = rollAs(s, 1, { face: 'ship', total: 8 });
    s = r.state;
    expect(eventsOf(r.events, 'fleet/tied')).toEqual([{ type: 'fleet/tied', players: [1, 0] }]);
    expect(s.pending.map((p) => [p.kind, p.players])).toEqual([
      ['guilds/drawChoice', [0]],
      ['guilds/drawChoice', [1]],
    ]);
    s = act(s, 1, { type: 'guilds/draw', track: 'commerce' }).state;
    s = act(s, 0, { type: 'guilds/draw', track: 'statecraft' }).state;
    expect(s.ext.guilds!.hands.map((h) => h.length)).toEqual([1, 1, 0, 0]);
  });
});

describe('fleet: the full set in play', () => {
  const results: GameResult[] = [];
  const diffs = (g: number, n: number): BotDifficulty[] => {
    if (g % 5 === 0) return Array(n).fill('hard');
    if (g % 5 === 1) return Array(n).fill('normal');
    return Array.from({ length: n }, (_, i) => (['easy', 'normal', 'hard'] as const)[(g + i) % 3]);
  };

  slow('48 bot games to 13 points, three and four seats, finish with no fall-backs and every invariant intact', () => {
    for (let g = 0; g < 48; g++) {
      const n = (g % 2 ? 3 : 4) as 3 | 4;
      const r = runBotGame({
        seed: 9000 + g,
        players: n,
        layout: g % 6 === 0 ? 'beginner' : 'random',
        numberPlacement: g % 4 === 1 ? 'balanced' : 'spiral',
        difficulties: diffs(g, n),
        options: { modules: [...ALL], victoryPoints: 13 },
        crossCheckLegal: g % 6 === 1,
      });
      expect(r.winner).not.toBeNull();
      expect(r.fallbacks).toBe(0);
      results.push(r);
    }
  }, timeout(300_000));

  slow('every legal action applies under random play', () => {
    let checked = 0;
    for (let g = 0; g < 4; g++) checked += runFuzzGame(9100 + g, g % 2 ? 3 : 4, g % 2 ? 'random' : 'beginner', 700, true, { modules: [...ALL], victoryPoints: 13 }).checkedActions;
    for (let g = 0; g < 8; g++) runFuzzGame(9200 + g, g % 2 ? 3 : 4, 'random', 2500, false, { modules: [...ALL], victoryPoints: 13 });
    expect(checked).toBeGreaterThan(5000);
  }, timeout(300_000));

  afterAll(() => summarize('full set', results));
});
