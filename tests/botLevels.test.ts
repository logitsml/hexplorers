// The levels of the computer opponents in the expansions: what each profile asks of the modules'
// bots, the actions bots used never to take (an opening ship, oil cards, the garrisons' march), the
// rest a person gets from a bot that has been refused twice, and the line each level has on the
// set-up page.

import { describe, expect, it } from 'vitest';
import { RESOURCES, applyAction, createGame, emptyTracker, legalActions, trackEvents, withBoard, type Action, type CardCounts, type GameState, type Production } from '../src/engine';
import { PROFILES, botDecide, createBotMemory, type BotDifficulty } from '../src/engine/ai';
import { DIFFICULTY_BLURBS } from '../src/engine/ai/profiles';
import { BotCtx } from '../src/engine/ai/context';
import { backedOff } from '../src/engine/ai/trade';
import { mixOf, targetFor } from '../src/engine/presets';
import { FOUR, apply, beginnerGame, grant, patch, rc, toMain } from './helpers';
import { game } from './modules/guilds-helpers';
import { runBotGame } from './sim-harness';

const LEVELS: BotDifficulty[] = ['easy', 'normal', 'hard'];

/** The hands as they stand, as if every card had been seen arriving (so the tracker knows them). */
function known(state: GameState) {
  state.tracker = emptyTracker(state.players.length);
  const grants: Production[] = state.players.flatMap((p) => RESOURCES.filter((r) => p.hand[r] > 0).map((r) => ({ player: p.id, hex: 0, vertex: 0, resource: r, amount: p.hand[r] })));
  trackEvents(state, [{ type: 'production', total: 0, grants, blockedHexes: [], shortages: [] }]);
  return state;
}

const setHand = (s: GameState, p: number, h: Partial<CardCounts>) => {
  for (const r of RESOURCES) s.bank[r] += s.players[p].hand[r];
  s.players[p].hand = rc(h);
  for (const r of RESOURCES) s.bank[r] -= s.players[p].hand[r];
};

describe('the levels in the expansions', () => {
  it('ask less of the modules the lower the level, and only hard searches their moves for a win', () => {
    const [e, n, h] = LEVELS.map((d) => PROFILES[d]);
    expect(e.moduleSkip).toBeGreaterThan(n.moduleSkip);
    expect(n.moduleSkip).toBeGreaterThanOrEqual(h.moduleSkip);
    expect(e.moduleSlip).toBeGreaterThan(n.moduleSlip);
    expect(n.moduleSlip).toBeGreaterThanOrEqual(h.moduleSlip);
    expect(e.moduleNoise).toBeGreaterThan(n.moduleNoise);
    expect(n.moduleNoise).toBeGreaterThanOrEqual(h.moduleNoise);
    expect([e.moduleSearch, n.moduleSearch, h.moduleSearch]).toEqual([false, false, true]);
    expect(h.moduleSkip + h.moduleSlip + h.moduleNoise).toBe(0);
  });

  it('say in a line how each plays, for the set-up pages', () => {
    for (const d of LEVELS) expect(DIFFICULTY_BLURBS[d].length).toBeGreaterThan(20);
    expect(new Set(LEVELS.map((d) => DIFFICULTY_BLURBS[d])).size).toBe(3);
  });

  it('set sail in the opening now and then (a ship toward an islet, the fog or a bounty field), never by a fallback', () => {
    let ships = 0;
    for (const map of ['archipelago', 'strait', 'twinIsles', 'fogBank', 'lostSea']) {
      for (let seed = 1; seed <= 8; seed++) {
        let s = createGame(FOUR, withBoard(4, { seed, modules: ['sea'], map, victoryPoints: 14 })).state;
        const mem = s.players.map(() => createBotMemory());
        for (let steps = 0; (s.phase === 'setupSettlement' || s.phase === 'setupRoad') && steps < 40; steps++) {
          const p = s.currentPlayer;
          const a = botDecide(s, p, mem[p], 'hard');
          expect(a).not.toBeNull();
          if (a!.type === 'sea/placeSetupShip') ships++;
          s = apply(s, p, a!).state;
        }
        expect(mem.every((m) => m.fallbacks === 0)).toBe(true);
      }
    }
    expect(ships).toBeGreaterThan(0);
  }, 120_000);
});

describe('loose play never costs a fallback', () => {
  // (A free ship that Road Crew leaves owed is never passed over: only a ship may fit. Rare, so many games.)
  it('easy and normal bots in sea mixes play to a finish with no fall-backs', () => {
    for (let g = 0; g < 24; g++) {
      const mix = mixOf(g % 2 ? ['sea', 'fisheries'] : ['sea', 'guilds']);
      const options = { modules: mix.modules, map: mix.map, knobs: mix.knobs, victoryPoints: mix.target };
      const res = runBotGame({ seed: 50_000 + g, players: 4, layout: 'random', options, difficulties: g % 3 ? ['easy', 'easy', 'normal', 'easy'] : ['normal', 'easy', 'easy', 'hard'] });
      expect(res.fallbacks).toBe(0);
      expect(res.winner).not.toBeNull();
    }
  }, 300_000);
});

describe('Rivers add a point to the target', () => {
  it('on any island, alone or in a mix', () => {
    expect(targetFor(['rivers'])).toBe(targetFor([]) + 1);
    expect(targetFor(['rivers', 'caravans'])).toBe(targetFor(['caravans']) + 1);
  });
});

describe('a person who keeps refusing', () => {
  // Blue (a bot) offers a wool for a wheat to Red (a person).
  const table = () =>
    known(
      patch(beginnerGame(), (x) => {
        toMain(x, 1);
        x.players[0].isBot = false;
        setHand(x, 0, { wheat: 4, ore: 1 });
        setHand(x, 1, { wheat: 1, ore: 3, wool: 2 });
      }),
    );
  const offer: Action = { type: 'offerTrade', give: rc({ wool: 1 }), get: rc({ wheat: 1 }), to: [0] };
  const backed = (s: GameState, mem: ReturnType<typeof createBotMemory>) => backedOff(new BotCtx(s, 1, 'normal', mem), 0);

  it('is left alone after two refusals in a row, for a few rounds, then asked afresh', () => {
    const s = table();
    const mem = createBotMemory({ waitForHumans: true });
    let st = s;
    for (let i = 0; i < 2; i++) {
      expect(backed(st, mem)).toBe(false);
      const refused = apply(apply(st, 1, offer).state, 0, { type: 'respondTrade', accept: false }).state;
      // Blue withdraws the offer, noting the refusal.
      const withdrawn = botDecide(refused, 1, mem, 'normal');
      expect(withdrawn?.type).toBe('cancelTrade');
      st = apply(refused, 1, withdrawn!).state;
    }
    expect(mem.notes.declines0).toBe(2);
    expect(backed(st, mem)).toBe(true);
    // Some rounds on, they are asked afresh.
    const later = patch(st, (x) => {
      x.turn += 3 * x.players.length + 1;
    });
    expect(backed(later, mem)).toBe(false);
    expect(mem.notes.declines0).toBe(0);
  });

  it('is never held off the bots, and a yes clears the count', () => {
    const s = table();
    const mem = createBotMemory({ waitForHumans: true });
    mem.notes.declines0 = 1;
    const taken = apply(apply(s, 1, offer).state, 0, { type: 'respondTrade', accept: true }).state;
    expect(botDecide(taken, 1, mem, 'normal')?.type).toBe('acceptTrade');
    expect(mem.notes.declines0).toBe(0);
    mem.notes.declines2 = 5;
    mem.notes.declinedAt2 = s.turn;
    expect(backed(s, mem)).toBe(false);
    expect(backedOff(new BotCtx(s, 1, 'normal', mem), 2)).toBe(false);
  });
});

describe('oil cards', () => {
  /** An Oil game in seat 0's main phase holding a Monopoly bought last turn, the others rich in oil but poor in cards. */
  const oily = () =>
    patch(game(['oil']), (x) => {
      x.turn = 4;
      toMain(x, 0);
      x.players[0].devCards.push({ type: 'monopoly', boughtTurn: 1 });
      for (const p of [1, 2, 3]) {
        setHand(x, p, {});
        x.bank.oil -= 2;
        x.players[p].hand.oil += 2;
      }
    });

  it('a Monopoly is played for the oil when the others hold plenty', () => {
    const s = oily();
    const a = botDecide(s, 0, createBotMemory(), 'normal');
    expect(a).toEqual({ type: 'oil/monopoly' });
    expect(legalActions(s, 0)).toContainEqual(a);
  });

  it('and left in hand when they hold next to none', () => {
    const s = patch(oily(), (x) => {
      for (const p of [1, 2, 3]) {
        x.bank.oil += x.players[p].hand.oil;
        x.players[p].hand.oil = 0;
      }
    });
    expect(botDecide(s, 0, createBotMemory(), 'normal')?.type).not.toBe('oil/monopoly');
    expect(applyAction(s, 0, { type: 'oil/monopoly' }).ok).toBe(true);
  });

  it('easy bots sometimes let it pass (that is their way with the modules)', () => {
    let played = 0;
    for (let i = 0; i < 40; i++) {
      const s = patch(oily(), (x) => {
        x.seq += i;
        grant(x, 0, { ore: 0 });
      });
      if (botDecide(s, 0, createBotMemory(), 'easy')?.type === 'oil/monopoly') played++;
    }
    expect(played).toBeGreaterThan(5);
    expect(played).toBeLessThan(40);
  });
});
