// The reason a venture has nothing to do (the panel's "why not"), held to the options the engine
// offers: it names a reason exactly when the card has no way to be played.

import { describe, expect, it } from 'vitest';
import { MODULE_IDS, applyAction, createGame, type GameState, type ModuleId } from '../../src/engine';
import { botDecide, createBotMemory } from '../../src/engine/ai';
import { VENTURES, ventureCopies } from '../../src/engine/modules/guilds/ventures';
import { ventureIdleReason } from '../../src/engine/modules/guilds/why';
import type { VentureId } from '../../src/engine/modules/guilds/types';
import { patch, rc } from '../helpers';
import { citiesOf, game, giveVenture } from './guilds-helpers';
import { setups } from '../sim-harness';
import { slow, timeout } from '../tier';

const ALL = Object.keys(VENTURES) as VentureId[];
const inPlay = (s: GameState) => ALL.filter((c) => ventureCopies(s, VENTURES[c]) > 0);

describe('ventureIdleReason', () => {
  slow('gives a reason exactly when a card has no way to be played, along bot games of the venture module mixes', () => {
    const mixes: ModuleId[][] = [['guilds'], ['guilds', 'garrisons'], ['guilds', 'garrisons', 'invasion'], ['guilds', 'sea', 'rivers', 'oil']].map((ids) => MODULE_IDS.filter((m) => ids.includes(m)));
    let checked = 0;
    let idle = 0;
    mixes.forEach((modules, m) => {
      let s = createGame(setups(4), { layout: 'beginner', seed: 11 + m, modules, victoryPoints: 13 }).state;
      const memories = s.players.map(() => createBotMemory());
      for (let step = 0; step < 700 && s.phase !== 'gameOver'; step++) {
        if (step % 7 === 0) {
          for (const p of s.players) {
            for (const card of inPlay(s)) {
              const def = VENTURES[card];
              const reason = ventureIdleReason(s, p.id, card);
              const open = def.options ? def.options(s, p.id).length > 0 : false;
              expect(reason === null, `${modules.join('+')} step ${step} seat ${p.id} ${card}: ${reason}`).toBe(open);
              checked++;
              if (reason) idle++;
            }
          }
        }
        let moved = false;
        for (let k = 0; k < s.players.length && !moved; k++) {
          const p = (s.seq + k) % s.players.length;
          const a = botDecide(s, p, memories[p], 'normal');
          if (!a) continue;
          const r = applyAction(s, p, a);
          if (!r.ok) throw new Error(r.error);
          s = r.state;
          moved = true;
        }
        if (!moved) break;
      }
    });
    // (Both sides of the comparison were met: cards with ways, and cards without.)
    expect(checked).toBeGreaterThan(500);
    expect(idle).toBeGreaterThan(50);
    // (Four bot games of up to 700 moves: well under a second alone, slower with the suite's workers all busy.)
  }, timeout(60_000));

  it('is never null for the hoist, which is spent with an improvement', () => {
    expect(ventureIdleReason(game(['guilds']), 0, 'hoist')).toBe('Spent with an improvement, for one commodity less');
  });

  it('says what town planning lacks, then that there is nothing to raise', () => {
    const s = game(['guilds']);
    const poor = patch(s, (x) => (x.players[0].hand = rc({})));
    expect(ventureIdleReason(poor, 0, 'townPlanning')).toBe('You need 2 wheat and 1 ore more');
    const some = patch(poor, (x) => {
      x.players[0].hand = rc({ wheat: 1, ore: 1 });
    });
    expect(ventureIdleReason(some, 0, 'townPlanning')).toBe('You need 1 wheat more');
    // With every building a city already there is nothing left to raise.
    const cities = patch(s, (x) => {
      x.players[0].hand = rc({ wheat: 2, ore: 1 });
      for (const b of x.buildings) if (b?.owner === 0) b.kind = 'city';
    });
    expect(ventureIdleReason(cities, 0, 'townPlanning')).toBe('No house of yours to raise');
    expect(ventureIdleReason(patch(s, (x) => (x.players[0].hand = rc({ wheat: 2, ore: 1 }))), 0, 'townPlanning')).toBeNull();
  });

  it('tells a missing city from a walled one for the masonry', () => {
    const s = game(['guilds', 'garrisons']);
    expect(ventureIdleReason(s, 0, 'masonry')).toBeNull();
    const walled = patch(s, (x) => {
      for (const v of citiesOf(x, 0)) x.buildings[v]!.wall = true;
    });
    expect(ventureIdleReason(walled, 0, 'masonry')).toBe('Every town of yours has a wall');
    const none = patch(s, (x) => {
      for (const v of citiesOf(x, 0)) x.buildings[v]!.kind = 'settlement';
    });
    expect(ventureIdleReason(none, 0, 'masonry')).toBe('You have no town to wall');
  });

  it('tells an empty hand from a table with no commodities for barter, and notes who holds ventures for the spymaster', () => {
    const s = game(['guilds']);
    expect(ventureIdleReason(patch(s, (x) => (x.players[0].hand = rc({}))), 0, 'barter')).toBe('You have no resource to offer');
    expect(ventureIdleReason(patch(s, (x) => (x.players[0].hand = rc({ brick: 1 }))), 0, 'barter')).toBe('Nobody else holds a commodity');
    expect(ventureIdleReason(s, 0, 'spymaster')).toBe('Nobody else holds a venture');
    const held = patch(s, (x) => giveVenture(x, 1, 'spymaster'));
    expect(ventureIdleReason(held, 0, 'spymaster')).toBeNull();
  });
});
