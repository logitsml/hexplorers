// The interface's estimate of income against production itself. Mid-game states from bot games of
// each mix that changes what a building yields: the event deck forces each total in turn, the roll
// is played, and what every player actually took (cards in hand, a bounty field's picks owed) must
// be what incomeOn said it would be. (expectedIncome is that, weighted by the dice.)

import { describe, expect, it } from 'vitest';
import { CARDS, EVENT_DECK_RESHUFFLE_AT, applyAction, createGame, expectedIncome, hexPips, incomeOn, numbersOf, type Building, type GameState, type Hex } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { mixOf, type Expansion } from '../src/engine/presets';
import { BOUNTY_PICK } from '../src/engine/modules/sea/bounty';
import { patch } from './helpers';
import { setups } from './sim-harness';
import { slow, timeout } from './tier';

/** States at the start of a turn, before the roll, every few turns of one bot game. */
function rollStates(expansions: readonly Expansion[], seed: number): GameState[] {
  const mix = mixOf(expansions);
  let s = createGame(setups(4), { seed, layout: 'random', eventDeck: true, modules: mix.modules, map: mix.map, knobs: mix.knobs, victoryPoints: mix.target }).state;
  const memories = s.players.map(() => createBotMemory());
  const out: GameState[] = [];
  let lastTurn = -1;
  for (let steps = 0; steps < 4000 && s.phase !== 'gameOver' && out.length < 12; steps++) {
    if (s.phase === 'roll' && s.pending.length === 0 && !s.hasRolled && s.turn !== lastTurn && s.turn % 3 === 0) {
      out.push(s);
      lastTurn = s.turn;
    }
    let acted = false;
    for (let i = 0; i < s.players.length && !acted; i++) {
      const p = (s.seq + i) % s.players.length;
      const a = botDecide(s, p, memories[p], 'normal');
      if (!a) continue;
      const r = applyAction(s, p, a);
      if (!r.ok) throw new Error(r.error);
      s = r.state;
      acted = true;
    }
    if (!acted) break;
  }
  return out;
}

/** The event deck's card for a roll of `total`. */
const cardFor = (total: number) => {
  const d1 = Math.max(1, total - 6);
  return (d1 - 1) * 6 + (total - d1 - 1);
};

// (The Almanac draws its own deck for the roll, so it isn't forced this way; its sickness goes through the same yields hook as the rest.)
const MIXES: Expansion[][] = [[], ['sea'], ['guilds'], ['oil'], ['invasion'], ['fisheries'], ['sea', 'oil'], ['guilds', 'oil'], ['guilds', 'invasion']];

describe('the estimate of income is what production hands out', () => {
  for (const ex of MIXES) {
    slow(ex.length ? ex.join(' + ') : 'the base game', () => {
      let compared = 0;
      for (const seed of [3, 4]) {
        for (const s of rollStates(ex, seed)) {
          const roller = s.currentPlayer;
          for (let total = 2; total <= 12; total++) {
            if (total === 7) continue;
            // (A deck long enough not to reshuffle, with the card for `total` on top.)
            const forced = { ...s, eventCards: [...Array.from({ length: EVENT_DECK_RESHUFFLE_AT + 1 }, () => 0), cardFor(total)] };
            const r = applyAction(forced, roller, { type: 'rollDice' });
            if (!r.ok) throw new Error(r.error);
            const after = r.state;
            const at = r.events.findIndex((e) => e.type === 'production' || e.type === 'noProduction');
            const production = r.events[at];
            // Only where production ran on the board as it stood: nothing waited on a decision first, and
            // nothing came of the roll before it (the event die can land raiders on the rolled number), the
            // bank paid in full, and every oil fitted.
            if (!production || (production.type === 'production' && production.shortages.length > 0)) continue;
            if (r.events.slice(0, at).some((e) => e.type !== 'diceRolled' && e.type !== 'guilds/eventDie')) continue;
            if (after.pending.some((p) => p.kind !== BOUNTY_PICK)) continue;
            // (Oil's four-a-hand limit is part of the estimate; only a supply run dry is left out.)
            if (s.options.modules.includes('oil') && after.bank.oil === 0) continue;
            for (const p of s.players) {
              const want = incomeOn(s, p.id, total);
              for (const k of CARDS) expect(after.players[p.id].hand[k] - p.hand[k], `${k} for ${p.id} on ${total}`).toBeCloseTo(want.per[k], 9);
              const picks = after.pending.filter((d) => d.kind === BOUNTY_PICK && d.players[0] === p.id).reduce((n, d) => n + (d.data as { count: number }).count, 0);
              expect(picks, `picks for ${p.id} on ${total}`).toBe(want.picks);
              compared++;
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(50);
    }, timeout(60_000));
  }

  it('counts what the old estimate missed: a commodity, a foundry’s third card, a well’s oil and a bounty field’s pick', () => {
    /** A game of `expansions` with one city of Red's on a corner of the first hex `on` picks, and nothing else built. */
    const city = (expansions: Expansion[], on: (h: Hex) => boolean, extra: Partial<Building> = {}) => {
      const mix = mixOf(expansions);
      const s0 = createGame(setups(4), { seed: 5, layout: 'random', modules: mix.modules, map: mix.map, knobs: mix.knobs, victoryPoints: mix.target }).state;
      const hex = s0.board.hexes.find((h) => on(h) && hexPips(s0, h) > 0)!;
      const v = hex.vertices[0];
      const s = patch(s0, (x) => {
        x.buildings = x.buildings.map(() => null);
        x.buildings[v] = { owner: 0, kind: 'city', ...extra };
        x.robberHex = -1;
      });
      /** The chance a roll produces on each hex at the city's corner that `which` picks. */
      const at = (which: (h: Hex) => boolean) => s.board.vertices[v].hexes.map((h) => s.board.hexes[h]).filter(which).reduce((n, h) => n + hexPips(s, h) / 36, 0);
      return { s, hex, at };
    };
    // A city on a forest takes a wood and a paper (Guilds).
    const forest = city(['guilds'], (h) => h.terrain === 'forest');
    expect(expectedIncome(forest.s, 0).per.wood).toBeCloseTo(forest.at((h) => h.terrain === 'forest'), 9);
    expect(expectedIncome(forest.s, 0).per.paper).toBeCloseTo(forest.at((h) => h.terrain === 'forest'), 9);
    // A foundry takes three of its city's resource, and a well's oil (Oil).
    const hills = city(['oil'], (h) => h.terrain === 'hills' && !h.well, { foundry: true });
    expect(expectedIncome(hills.s, 0).per.brick).toBeCloseTo(3 * hills.at((h) => h.terrain === 'hills'), 9);
    const well = city(['oil'], (h) => !!h.well);
    expect(expectedIncome(well.s, 0).per.oil).toBeCloseTo(2 * well.at((h) => !!h.well), 9);
    // A bounty field owes a city two picks, and none with the robber on it (Sea Lanes).
    const bounty = city(['sea'], (h) => h.terrain === 'bounty');
    const picks = 2 * bounty.at((h) => h.terrain === 'bounty');
    expect(picks).toBeGreaterThan(0);
    expect(expectedIncome(bounty.s, 0).picks).toBeCloseTo(picks, 9);
    const robbed = patch(bounty.s, (x) => (x.robberHex = bounty.hex.id));
    expect(expectedIncome(robbed, 0).picks).toBeCloseTo(picks - 2 * (hexPips(robbed, bounty.hex) / 36), 9);
  });

  it('counts a well’s oil only as far as the four a player may hold', () => {
    const mix = mixOf(['oil']);
    const s0 = createGame(setups(4), { seed: 5, layout: 'random', modules: mix.modules, map: mix.map, knobs: mix.knobs, victoryPoints: mix.target }).state;
    const well = s0.board.hexes.find((h) => h.well && hexPips(s0, h) > 0)!;
    const total = numbersOf(s0, well)[0];
    const holding = (oil: number) =>
      patch(s0, (x) => {
        x.buildings = x.buildings.map(() => null);
        x.buildings[well.vertices[0]] = { owner: 0, kind: 'city' };
        x.robberHex = -1;
        x.bank.oil += x.players[0].hand.oil - oil;
        x.players[0].hand.oil = oil;
      });
    expect([0, 3, 4].map((oil) => incomeOn(holding(oil), 0, total).per.oil)).toEqual([2, 1, 0]);
  });
});
