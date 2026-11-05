// Port Captain: the award for points on harbours, the bots' eye for harbours, and bot games with
// the award alone and alongside the Almanac.

import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  publicVictoryPoints,
  satisfiesDistanceRule,
  totalVictoryPoints,
  type GameEvent,
  type GameState,
  type ModuleId,
  type PlayerId,
} from '../../src/engine';
import { botDecide, createBotMemory } from '../../src/engine/ai';
import { BotCtx, moduleSpotBonus } from '../../src/engine/ai/context';
import { MODULES } from '../../src/engine/modules';
import type { ModuleHooks } from '../../src/engine/modules/api';
import { harbourPoints, harbourVertices } from '../../src/engine/modules/harbourmaster';
import { FOUR, apply, grant, patch, road, toMain } from '../helpers';
import { type GameResult, runBotGame, runFuzzGame } from '../sim-harness';
import { games, slow, timeout } from '../tier';

const harbourmaster = MODULES.harbourmaster;

/** An empty island past set-up, in player 0's main phase. */
function island(modules: ModuleId[] = ['harbourmaster'], seed = 11): GameState {
  const g = createGame(FOUR, { layout: 'random', seed, modules }).state;
  return patch(g, (x) => {
    x.turn = 5;
    x.setupIndex = x.setupOrder.length;
    toMain(x, 0);
  });
}

/** Harbour intersections far enough apart to all hold buildings. */
function spreadHarbours(s: GameState): number[] {
  const out: number[] = [];
  for (const v of harbourVertices(s.board)) if (out.every((u) => u !== v && !s.board.vertices[u].neighbors.includes(v))) out.push(v);
  return out;
}

const settle = (s: GameState, p: PlayerId, v: number, kind: 'settlement' | 'city' = 'settlement') => {
  s.buildings[v] = { owner: p, kind };
  if (kind === 'city') s.players[p].citiesLeft--;
  else s.players[p].settlementsLeft--;
};
const changes = (events: GameEvent[]) => events.filter((e) => e.type === 'harbourmaster/changed');

/** Any action, to let the award catch up with a patched board. */
const nudge = (s: GameState) => {
  const t = patch(s, (x) => grant(x, 0, { wool: 4 }));
  return apply(t, 0, { type: 'bankTrade', give: 'wool', get: 'ore' });
};

const saved: Partial<Record<ModuleId, ModuleHooks | undefined>> = {};
afterEach(() => {
  for (const [id, hooks] of Object.entries(saved)) MODULES[id as ModuleId].hooks = hooks;
  for (const k of Object.keys(saved)) delete saved[k as ModuleId];
});
/** Give a module stub a hook for one test (restored afterwards). */
function hook(id: ModuleId, hooks: ModuleHooks) {
  if (!(id in saved)) saved[id] = MODULES[id].hooks;
  MODULES[id].hooks = { ...MODULES[id].hooks, ...hooks };
}

describe('the award', () => {
  it('goes to the first player with 3 points on harbours, as the building goes up, worth 2', () => {
    const s = island();
    const [h1, h2] = spreadHarbours(s);
    const t = patch(s, (x) => {
      settle(x, 0, h1, 'city');
      x.routes[x.board.vertices[h2].edges[0]] = road(0);
      x.players[0].roadsLeft--;
      grant(x, 0, { brick: 1, wood: 1, wool: 1, wheat: 1 });
    });
    expect(harbourPoints(t, 0)).toBe(2);
    expect(satisfiesDistanceRule(t, h2)).toBe(true);
    const { state, events } = apply(t, 0, { type: 'buildSettlement', vertex: h2 });
    expect(changes(events)).toEqual([{ type: 'harbourmaster/changed', from: null, to: 0, points: 3 }]);
    expect(state.ext.harbourmaster!.holder).toBe(0);
    expect(publicVictoryPoints(state, 0)).toBe(2 + 1 + 2);
  });

  it('decides the game on the build that takes it', () => {
    const s = island();
    const [h1, h2] = spreadHarbours(s);
    const t = patch(s, (x) => {
      settle(x, 0, h1, 'city');
      x.routes[x.board.vertices[h2].edges[0]] = road(0);
      x.players[0].roadsLeft--;
      x.players[0].devCards.push(...Array.from({ length: 4 }, () => ({ type: 'victoryPoint' as const, boughtTurn: 1 })));
      x.devDeck.splice(0, 4);
      grant(x, 0, { brick: 1, wood: 1, wool: 1, wheat: 1 });
    });
    // 2 (city) + 4 (cards) = 6; the settlement and the award make 9: short of 10. One more card...
    const nine = apply(t, 0, { type: 'buildSettlement', vertex: h2 }).state;
    expect(nine.phase).toBe('main');
    const ten = patch(t, (x) => {
      x.players[0].devCards.push({ type: 'victoryPoint', boughtTurn: 1 });
      x.devDeck.splice(0, 1);
    });
    const won = apply(ten, 0, { type: 'buildSettlement', vertex: h2 });
    expect(won.state.winner).toBe(0);
    expect(totalVictoryPoints(won.state, 0)).toBe(10);
  });

  it('stays with its holder on a tie, and goes to anyone with strictly more', () => {
    const s = island();
    const [a, b, c, d, e] = spreadHarbours(s);
    const held = patch(s, (x) => {
      settle(x, 0, a, 'city');
      settle(x, 0, b);
      x.ext.harbourmaster!.holder = 0;
      settle(x, 1, c, 'city');
      settle(x, 1, d);
    });
    // 3 apiece: the holder keeps it.
    const tie = nudge(held);
    expect(changes(tie.events)).toEqual([]);
    expect(tie.state.ext.harbourmaster!.holder).toBe(0);
    const more = nudge(patch(held, (x) => settle(x, 1, e)));
    expect(changes(more.events)).toEqual([{ type: 'harbourmaster/changed', from: 0, to: 1, points: 4 }]);
  });

  it('goes to nobody while two share the most and neither held it', () => {
    const s = island();
    const [a, b, c, d] = spreadHarbours(s);
    const t = patch(s, (x) => {
      settle(x, 0, a, 'city');
      settle(x, 0, b);
      settle(x, 1, c, 'city');
      settle(x, 1, d);
    });
    expect(nudge(t).state.ext.harbourmaster!.holder).toBeNull();
  });

  it('goes back to the supply when its holder falls below 3, or to whoever then has the most', () => {
    const s = island();
    const [a, b, c, d] = spreadHarbours(s);
    const t = patch(s, (x) => {
      settle(x, 0, a, 'city');
      settle(x, 0, b);
      x.ext.harbourmaster!.holder = 0;
      settle(x, 1, c);
      settle(x, 1, d);
    });
    // A building lost (a flood, say): 2 against 2.
    const lost = nudge(patch(t, (x) => (x.buildings[b] = null)));
    expect(changes(lost.events)).toEqual([{ type: 'harbourmaster/changed', from: 0, to: null, points: 0 }]);
    // Down to 2 while another has 3: the other takes it.
    const passed = nudge(
      patch(t, (x) => {
        x.buildings[b] = null;
        x.buildings[c] = { owner: 1, kind: 'city' };
      }),
    );
    expect(passed.state.ext.harbourmaster!.holder).toBe(1);
  });

  it('counts each building at its worth, so upgrades count and conquest takes them away', () => {
    const s = island(['oil', 'harbourmaster']);
    const [a, b] = spreadHarbours(s);
    hook('oil', { buildingWorth: (st, v, w) => (st.buildings[v]?.foundry ? w + 1 : w) });
    const t = patch(s, (x) => {
      settle(x, 0, a, 'city');
      x.buildings[a]!.foundry = true;
    });
    expect(harbourPoints(t, 0)).toBe(3);
    expect(nudge(t).state.ext.harbourmaster!.holder).toBe(0);
    // A conquered building counts nothing.
    hook('oil', { buildingWorth: (_s, v, w) => (v === b ? 0 : w) });
    const u = patch(s, (x) => {
      settle(x, 0, a, 'city');
      settle(x, 0, b);
    });
    expect(harbourPoints(u, 0)).toBe(2);
    expect(nudge(u).state.ext.harbourmaster!.holder).toBeNull();
  });

  it('comes back off a settlement taken back', () => {
    const s = island();
    const [h1, h2] = spreadHarbours(s);
    const t = patch(s, (x) => {
      settle(x, 0, h1, 'city');
      x.routes[x.board.vertices[h2].edges[0]] = road(0);
      x.players[0].roadsLeft--;
      grant(x, 0, { brick: 1, wood: 1, wool: 1, wheat: 1 });
    });
    const built = apply(t, 0, { type: 'buildSettlement', vertex: h2 }).state;
    expect(built.ext.harbourmaster!.holder).toBe(0);
    const back = apply(built, 0, { type: 'undo' }).state;
    expect(back.ext.harbourmaster!.holder).toBeNull();
    expect(publicVictoryPoints(back, 0)).toBe(2);
  });

  it('is checked by the invariants', () => {
    const s = patch(island(), (x) => (x.ext.harbourmaster!.holder = 2));
    expect(harbourmaster.invariants!(s)).toHaveLength(1);
    expect(harbourmaster.invariants!(island())).toEqual([]);
  });
});

describe('bots', () => {
  it('value a harbour spot by how close it brings them to the award', () => {
    const s = island();
    const [a, b, c] = spreadHarbours(s);
    const inland = s.board.vertices.find((v) => v.land && !v.port)!.id;
    const ctx = new BotCtx(s, 0, 'normal', createBotMemory());
    expect(moduleSpotBonus(ctx, inland)).toBe(0);
    const first = moduleSpotBonus(ctx, a);
    expect(first).toBeGreaterThan(0);
    // With two points already, the third takes the award: worth its 2 points.
    const two = patch(s, (x) => {
      settle(x, 0, b);
      settle(x, 0, c);
    });
    expect(moduleSpotBonus(new BotCtx(two, 0, 'normal', createBotMemory()), a)).toBe(2);
    // Without the module, harbours are worth nothing extra.
    const plain = patch(s, (x) => (x.options = { ...x.options, modules: [] }));
    expect(moduleSpotBonus(new BotCtx(plain, 0, 'normal', createBotMemory()), a)).toBe(0);
  });

  it('build the city that takes the award as soon as they can', () => {
    const s = island();
    const [a, b] = spreadHarbours(s);
    const t = patch(s, (x) => {
      settle(x, 0, a, 'city');
      settle(x, 0, b);
      settle(x, 1, spreadHarbours(x)[3], 'city');
      grant(x, 0, { wheat: 2, ore: 3 });
    });
    // 3 against player 1's 2 would already be enough: make it 3 against 3, so only the city does it.
    const contested = patch(t, (x) => settle(x, 1, spreadHarbours(x)[4]));
    expect(harbourPoints(contested, 0)).toBe(3);
    expect(harbourPoints(contested, 1)).toBe(3);
    expect(botDecide(contested, 0, createBotMemory(), 'normal')).toEqual({ type: 'buildCity', vertex: b });
  });

  it('prefer harbours in set-up more than without the award', () => {
    let withAward = 0;
    let without = 0;
    for (let seed = 0; seed < 30; seed++) {
      for (const [mods, add] of [
        [['harbourmaster'], (n: number) => (withAward += n)],
        [[], (n: number) => (without += n)],
      ] as const) {
        let s = createGame(FOUR, { layout: 'random', seed, modules: [...mods] }).state;
        const mems = s.players.map(() => createBotMemory());
        while (s.phase === 'setupSettlement' || s.phase === 'setupRoad') {
          const p = s.currentPlayer;
          const r = applyAction(s, p, botDecide(s, p, mems[p], 'hard')!);
          if (!r.ok) throw new Error(r.error);
          s = r.state;
        }
        add(harbourVertices(s.board).filter((v) => s.buildings[v]).length);
      }
    }
    expect(withAward).toBeGreaterThan(without);
  });
});

/** One line per seat count: games, average turns, seat wins and fall-backs (for the record). */
function summarize(label: string, res: GameResult[]) {
  const lines = [label];
  for (const n of [4, 3]) {
    const rs = res.filter((r) => r.players === n);
    const wins = Array(n).fill(0);
    for (const r of rs) if (r.winner !== null) wins[r.winner]++;
    const avg = rs.reduce((a, r) => a + r.turns, 0) / Math.max(1, rs.length);
    lines.push(`  ${n}p: ${rs.length} games, avg ${avg.toFixed(1)} turns, seat wins ${wins.join('/')}, fall-backs ${rs.reduce((a, r) => a + r.fallbacks, 0)}`);
  }
  console.log(lines.join('\n'));
}

function simulate(modules: ModuleId[], count: number, seedBase: number) {
  const diffs = ['easy', 'normal', 'hard'] as const;
  const results: GameResult[] = [];
  for (let g = 0; g < count; g++) {
    const players = g % 2 === 0 ? 4 : 3;
    results.push(
      runBotGame({
        seed: seedBase + g,
        players,
        layout: g % 4 < 2 ? 'beginner' : 'random',
        numberPlacement: g % 3 === 0 ? 'balanced' : 'spiral',
        difficulties: Array.from({ length: players }, (_, i) => diffs[(g + i) % 3]),
        // The award's +1 to the target (the presets').
        options: { modules, victoryPoints: 11 },
        crossCheckLegal: g % 8 === 0,
      }),
    );
  }
  return results;
}

describe('simulation', () => {
  for (const modules of [['harbourmaster'], ['almanac', 'harbourmaster']] as ModuleId[][]) {
    // (The seatings, layouts and number placements go round every 24 games.)
    slow(`${games(48, 24)} bot games with ${modules.join(' and ')} finish with no fall-backs and every invariant intact`, () => {
      const res = simulate(modules, games(48, 24), 71_000 + 1000 * modules.length);
      summarize(modules.join('+'), res);
      for (const r of res) {
        expect(r.winner).not.toBeNull();
        expect(r.fallbacks).toBe(0);
      }
      const turns = res.reduce((n, r) => n + r.turns, 0) / res.length;
      expect(turns).toBeGreaterThan(30);
      expect(turns).toBeLessThan(120);
    }, timeout(120_000));

    slow(`the fuzzer finds every action it is offered legal with ${modules.join(' and ')}`, () => {
      for (let g = 0; g < 6; g++) runFuzzGame(73_000 + g, g % 3 === 0 ? 3 : 4, g % 2 ? 'random' : 'beginner', 700, true, { modules });
      for (let g = 0; g < 6; g++) runFuzzGame(73_500 + g, g % 3 === 0 ? 3 : 4, 'random', 2500, false, { modules });
    }, timeout(120_000));
  }
});
