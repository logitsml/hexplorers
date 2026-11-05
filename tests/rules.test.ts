// The base game's finer rules: options, the robber, the decks, the awards, trades, discards and
// taking back.

import { describe, expect, it } from 'vitest';
import {
  RULES_VERSION,
  applyAction,
  canUndo,
  createGame,
  discardOptions,
  handEstimate,
  legalActions,
  legalRoads,
  legalRobberHexes,
  longestRoadEdges,
  longestRoadFor,
  publicVictoryPoints,
  redactState,
  satisfiesDistanceRule,
  stealCandidates,
  totalCards,
  totalVictoryPoints,
  validateOptions,
  type GameOptions,
  type GameState,
  type CardCounts,
} from '../src/engine';
import { MODULES } from '../src/engine/modules';
import { RESOURCES, type ModuleId } from '../src/engine/types';
import { FOUR, apply, beginnerGame, grant, patch, rc, toMain, num, road } from './helpers';
import { setups } from './sim-harness';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { slow, timeout } from './tier';

const vpCards = (n: number) => Array.from({ length: n }, () => ({ type: 'victoryPoint' as const, boughtTurn: 0 }));

/** The 30 coastal edges in order round the island, with the intersection between edge i and i+1. */
function coastRing(s: GameState): { edges: number[]; joins: number[] } {
  const coast = s.board.edges.filter((e) => e.coastal);
  const edges: number[] = [coast[0].id];
  const joins: number[] = [];
  let v = coast[0].b;
  while (edges.length < coast.length) {
    const next = s.board.vertices[v].edges.find((e) => s.board.edges[e].coastal && !edges.includes(e))!;
    joins.push(v);
    edges.push(next);
    const ed = s.board.edges[next];
    v = ed.a === v ? ed.b : ed.a;
  }
  joins.push(v);
  return { edges, joins };
}

/** An empty random island in the main phase of `player`'s turn. */
function emptyIsland(player = 0, opts = {}): GameState {
  const g = createGame(FOUR, { layout: 'random', seed: 11, ...opts }).state;
  return patch(g, (x) => {
    x.turn = 5;
    x.setupIndex = x.setupOrder.length;
    toMain(x, player);
  });
}

describe('game options', () => {
  it('rejects targets, seeds and versions a game cannot use', () => {
    for (const bad of [{ victoryPoints: 2 }, { victoryPoints: 31 }, { victoryPoints: 7.5 }, { seed: -1 }, { seed: 2 ** 32 }, { seed: 1.5 }, { rules: 0 }, { rules: 99 }]) {
      expect(() => createGame(FOUR, bad)).toThrow(/Invalid game option/);
    }
    expect(createGame(FOUR, { victoryPoints: 12 }).state.options.victoryPoints).toBe(12);
  });

  it('an option passed as undefined takes its default', () => {
    const g = createGame(FOUR, { seed: 3, victoryPoints: undefined, friendlyRobber: undefined, eventDeck: undefined }).state;
    expect(g.options).toMatchObject({ victoryPoints: 10, friendlyRobber: false, eventDeck: false, rules: RULES_VERSION });
  });

  it('a new game stamps each module in play with its current rules version', () => {
    expect(createGame(FOUR, { seed: 3 }).state.options.moduleRules).toEqual({});
    expect(createGame(FOUR, { seed: 3, modules: ['rivers', 'oil'] }).state.options.moduleRules).toEqual({ rivers: MODULES.rivers.rulesVersion, oil: MODULES.oil.rulesVersion });
    // (A version passed as undefined is left to the default, like any other option.)
    expect(createGame(FOUR, { seed: 3, modules: ['rivers'], moduleRules: { rivers: undefined } }).state.options.moduleRules).toEqual({ rivers: MODULES.rivers.rulesVersion });
  });

  it('keeps the rules version a module was created under, when its code has moved on', () => {
    const was = MODULES.rivers.rulesVersion;
    MODULES.rivers.rulesVersion = 3;
    try {
      const opts = { seed: 3, modules: ['rivers', 'oil'] as ModuleId[] };
      expect(createGame(FOUR, opts).state.options.moduleRules).toEqual({ rivers: 3, oil: 1 });
      // A recorded game says which version it was created under, and the others take theirs.
      expect(createGame(FOUR, { ...opts, moduleRules: { rivers: 2 } }).state.options.moduleRules).toEqual({ rivers: 2, oil: 1 });
      expect(createGame(FOUR, { ...opts, moduleRules: { rivers: 1, oil: 1 } }).state.options.moduleRules).toEqual({ rivers: 1, oil: 1 });
      // None of it from the future.
      expect(() => createGame(FOUR, { ...opts, moduleRules: { rivers: 4 } })).toThrow(/moduleRules rivers 4/);
    } finally {
      MODULES.rivers.rulesVersion = was;
    }
  });

  it('refuses module versions a game cannot be played under', () => {
    const current = (id: ModuleId) => MODULES[id].rulesVersion;
    const rivers = { seed: 3, modules: ['rivers'] as ModuleId[] };
    const refused: [Partial<GameOptions>, RegExp][] = [
      // A stamp for a module that isn't in play (or isn't a module at all).
      [{ seed: 3, moduleRules: { rivers: 1 } }, /moduleRules for rivers, which isn't in play/],
      [{ ...rivers, moduleRules: { rivers: current('rivers'), oil: 1 } }, /moduleRules for oil, which isn't in play/],
      [{ ...rivers, moduleRules: { rivers: 1, nonsense: 1 } as GameOptions['moduleRules'] }, /moduleRules for nonsense/],
      // A version that never existed: not an integer, below the first, above the current.
      [{ ...rivers, moduleRules: { rivers: 0 } }, /moduleRules rivers 0/],
      [{ ...rivers, moduleRules: { rivers: -1 } }, /moduleRules rivers -1/],
      [{ ...rivers, moduleRules: { rivers: 1.5 } }, /moduleRules rivers 1.5/],
      [{ ...rivers, moduleRules: { rivers: current('rivers') + 1 } }, new RegExp(`moduleRules rivers ${current('rivers') + 1}`)],
      [{ ...rivers, moduleRules: { rivers: '1' as unknown as number } }, /moduleRules rivers 1/],
      [{ ...rivers, moduleRules: [1] as unknown as GameOptions['moduleRules'] }, /Invalid game option: moduleRules/],
      [{ ...rivers, moduleRules: null as unknown as GameOptions['moduleRules'] }, /Invalid game option: moduleRules/],
    ];
    for (const [opts, why] of refused) expect(() => createGame(FOUR, opts), JSON.stringify(opts)).toThrow(why);
    // A module in play with no version is only possible past createGame's defaulting: validateOptions says so.
    const made = createGame(FOUR, rivers).state.options;
    expect(() => validateOptions(made)).not.toThrow();
    expect(() => validateOptions({ ...made, moduleRules: {} })).toThrow(/moduleRules missing rivers/);
    expect(() => validateOptions({ ...made, moduleRules: { rivers: undefined } })).toThrow(/moduleRules rivers undefined/);
    expect(() => validateOptions({ ...made, modules: [], moduleRules: { rivers: 1 } })).toThrow(/which isn't in play/);
  });

  it('distinct seeds give distinct islands (no 32-bit aliasing within the allowed range)', () => {
    const terrain = (seed: number) => createGame(FOUR, { seed }).state.board.hexes.map((h) => `${h.terrain}${num(h)}`).join();
    expect(terrain(1)).not.toBe(terrain(2 ** 31 + 1));
  });

  it('plays to the chosen target: 10 points are not enough for a 12-point game', () => {
    const s = patch(createGame(FOUR, { layout: 'beginner', seed: 7, victoryPoints: 12 }).state, (x) => {
      toMain(x, 0);
      x.players[0].devCards.push(...vpCards(7));
      grant(x, 0, { wheat: 2, ore: 3 });
    });
    const v = s.buildings.findIndex((b) => b?.owner === 0);
    const r = apply(s, 0, { type: 'buildCity', vertex: v });
    expect(totalVictoryPoints(r.state, 0)).toBe(10);
    expect(r.state.phase).toBe('main');
  });
});

describe('6/8 separation on random islands', () => {
  it('neither number placement ever puts a 6 or 8 beside another', () => {
    for (const numberPlacement of ['spiral', 'balanced'] as const) {
      for (let seed = 1; seed <= 400; seed++) {
        const b = createGame(FOUR, { layout: 'random', numberPlacement, seed }).state.board;
        for (const h of b.hexes) {
          if (num(h) !== 6 && num(h) !== 8) continue;
          for (const n of h.neighbors) expect([6, 8]).not.toContain(num(b.hexes[n]));
        }
      }
    }
  }, timeout(60_000));
});

describe('friendly robber', () => {
  const friendly = () => createGame(FOUR, { layout: 'beginner', seed: 7, friendlyRobber: true }).state;

  it('keeps away from players with 2 points or fewer', () => {
    const s = friendly();
    const touchesBuilding = (h: number) => s.board.hexes[h].vertices.some((v) => s.buildings[v]);
    const legal = legalRobberHexes(s);
    expect(legal.length).toBeGreaterThan(0);
    for (const h of legal) expect(touchesBuilding(h)).toBe(false);
    const plain = createGame(FOUR, { layout: 'beginner', seed: 7 }).state;
    expect(legalRobberHexes(plain).length).toBe(18);
    const banned = s.board.hexes.find((h) => h.id !== s.robberHex && touchesBuilding(h.id))!.id;
    const r = applyAction(patch(s, (x) => (x.phase = 'moveRobber')), s.currentPlayer, { type: 'moveRobber', hex: banned });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/friendly robber/);
  });

  it('a player past 2 points is fair game again, and can be robbed', () => {
    const s = patch(friendly(), (x) => {
      const v = x.buildings.findIndex((b) => b?.owner === 1);
      x.buildings[v] = { owner: 1, kind: 'city' };
      grant(x, 1, { ore: 2 });
    });
    expect(publicVictoryPoints(s, 1)).toBe(3);
    const v = s.buildings.findIndex((b) => b?.kind === 'city');
    const hex = s.board.vertices[v].hexes.find((h) => legalRobberHexes(s).includes(h));
    expect(hex).toBeDefined();
    expect(stealCandidates(s, hex!, 0)).toContain(1);
    expect(stealCandidates(s, hex!, 0).every((p) => publicVictoryPoints(s, p) > 2)).toBe(true);
  });

  it('with nowhere to go it moves to the desert, or stays there, and steals from nobody spared', () => {
    // Cover every hex with buildings of players on 2 points or fewer.
    const base = createGame(FOUR, { layout: 'random', seed: 11, friendlyRobber: true }).state;
    const s = patch(base, (x) => {
      x.turn = 3;
      toMain(x, 0);
      x.phase = 'moveRobber';
      const covered = new Set<number>();
      const count = [0, 0, 0, 0];
      for (let k = 0; k < 8; k++) {
        let best = -1;
        let gain = 0;
        for (const v of x.board.vertices) {
          if (!satisfiesDistanceRule(x, v.id)) continue;
          const g = v.hexes.filter((h) => !covered.has(h)).length;
          if (g > gain) [best, gain] = [v.id, g];
        }
        if (best < 0) break;
        const owner = count.findIndex((c) => c < 2);
        count[owner]++;
        x.buildings[best] = { owner, kind: 'settlement' };
        x.board.vertices[best].hexes.forEach((h) => covered.add(h));
      }
      for (const p of x.players) grant(x, p.id, { wool: 1 });
    });
    const allCovered = s.board.hexes.every((h) => h.vertices.some((v) => s.buildings[v]));
    expect(allCovered).toBe(true);
    expect(legalRobberHexes(s)).toEqual([s.board.desertHex]);
    // Already on the desert: staying there is its move, and nobody is robbed.
    const r = apply(s, 0, { type: 'moveRobber', hex: s.board.desertHex! });
    expect(r.state.phase).toBe('main');
    expect(r.events.some((e) => e.type === 'stolen')).toBe(false);
    // Elsewhere: back to the desert.
    const off = patch(s, (x) => (x.robberHex = x.board.hexes.find((h) => h.id !== x.board.desertHex)!.id));
    expect(legalRobberHexes(off)).toEqual([s.board.desertHex]);
    expect(apply(off, 0, { type: 'moveRobber', hex: s.board.desertHex! }).state.robberHex).toBe(s.board.desertHex);
  });
});

describe('event deck', () => {
  const rollOnce = (s: GameState) => {
    const ready = patch(s, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
      x.pendingDiscards = {};
      for (const p of x.players) {
        for (const r of RESOURCES) x.bank[r] += p.hand[r];
        p.hand = rc({});
      }
    });
    return apply(ready, ready.currentPlayer, { type: 'rollDice' });
  };

  it('deals each of the 36 dice combinations at most once until 5 remain, then reshuffles', () => {
    let s = createGame(FOUR, { layout: 'beginner', seed: 7, eventDeck: true }).state;
    const seen = new Set<string>();
    for (let i = 0; i < 31; i++) {
      const r = rollOnce(s);
      s = r.state;
      const e = r.events.find((x) => x.type === 'diceRolled')!;
      expect(e.type === 'diceRolled' && e.total).toBe(s.dice![0] + s.dice![1]);
      seen.add(s.dice!.join());
    }
    expect(seen.size).toBe(31);
    expect(s.eventCards).toHaveLength(5);
    s = rollOnce(s).state;
    expect(s.eventCards).toHaveLength(35);
  });

  it('over whole decks the totals follow the dice odds exactly', () => {
    let s = createGame(FOUR, { layout: 'beginner', seed: 9, eventDeck: true }).state;
    const counts = new Array(13).fill(0);
    for (let deck = 0; deck < 20; deck++) {
      const cards = rollOnce(s);
      // Draw the rest of this deck (31 cards in all), counting the 5 left behind as well.
      s = cards.state;
      counts[s.dice![0] + s.dice![1]]++;
      for (let i = 1; i < 31; i++) {
        s = rollOnce(s).state;
        counts[s.dice![0] + s.dice![1]]++;
      }
      for (const c of s.eventCards!) counts[2 + Math.floor(c / 6) + (c % 6)]++;
    }
    for (let t = 2; t <= 12; t++) expect(counts[t]).toBe(20 * (6 - Math.abs(7 - t)));
  }, timeout(60_000));

  it('leaves dice games as they were, and hides the deck order from players', () => {
    const plain = createGame(FOUR, { layout: 'beginner', seed: 7 }).state;
    expect(plain.eventCards).toBeUndefined();
    const s = rollOnce(createGame(FOUR, { layout: 'beginner', seed: 7, eventDeck: true }).state).state;
    expect(new Set(redactState(s, 0).eventCards)).toEqual(new Set([0]));
  });
});

describe('road crew', () => {
  it('cannot give up free roads that could still be placed', () => {
    const s = patch(beginnerGame(), (x) => {
      toMain(x, 0);
      x.players[0].devCards.push({ type: 'roadBuilding', boughtTurn: 0 });
    });
    const r = apply(s, 0, { type: 'playRoadBuilding' }).state;
    expect(applyAction(r, 0, { type: 'skipFreeRoads' }).ok).toBe(false);
    expect(legalActions(r, 0).some((a) => a.type === 'skipFreeRoads')).toBe(false);
    // Walled in: the skip is the only way on.
    const walled = patch(r, (x) => {
      for (const e of legalRoads(x, 0)) x.routes[e] = road(1);
    });
    expect(legalActions(walled, 0)).toEqual([{ type: 'skipFreeRoads' }]);
    expect(apply(walled, 0, { type: 'skipFreeRoads' }).state.phase).toBe('main');
  });

  it('with one road left in the supply places just that one', () => {
    const s = patch(beginnerGame(), (x) => {
      toMain(x, 0);
      x.players[0].devCards.push({ type: 'roadBuilding', boughtTurn: 0 });
      x.players[0].roadsLeft = 1;
    });
    const r = apply(s, 0, { type: 'playRoadBuilding' }).state;
    expect(r.freeRoadsLeft).toBe(1);
    const done = apply(r, 0, { type: 'placeFreeRoad', edge: legalRoads(r, 0)[0] });
    expect(done.state.phase).toBe('main');
    expect(done.events.some((e) => e.type === 'freeRoadsFinished')).toBe(true);
  });

  it('a free road that takes Longest Route can win the game', () => {
    const base = emptyIsland(0);
    const { edges, joins } = coastRing(base);
    const s = patch(base, (x) => {
      x.buildings[joins[joins.length - 1]] = { owner: 0, kind: 'settlement' };
      for (let i = 0; i < 4; i++) x.routes[edges[i]] = road(0);
      x.players[0].roadsLeft -= 4;
      x.players[0].longestRoad = 4;
      x.players[0].devCards.push(...vpCards(7), { type: 'roadBuilding', boughtTurn: 0 });
    });
    expect(totalVictoryPoints(s, 0)).toBe(8);
    const rb = apply(s, 0, { type: 'playRoadBuilding' }).state;
    const r = apply(rb, 0, { type: 'placeFreeRoad', edge: edges[4] });
    expect(r.state.longestRoadHolder).toBe(0);
    expect(r.state.phase).toBe('gameOver');
    expect(r.state.winner).toBe(0);
  });
});

describe('longest route ties and breaks', () => {
  /** Players' roads along the coast: 0 on edges 0-5, 1 on 8-12, 2 on 15-19 (or as given). */
  function ring(spans: [number, number, number][], holder: number | null) {
    const base = emptyIsland(3);
    const { edges, joins } = coastRing(base);
    const s = patch(base, (x) => {
      for (const [p, from, to] of spans) {
        for (let i = from; i <= to; i++) x.routes[edges[i]] = road(p);
        x.players[p].roadsLeft -= to - from + 1;
      }
      for (const p of x.players) p.longestRoad = longestRoadFor(x, p.id);
      x.longestRoadHolder = holder;
    });
    return { s, edges, joins };
  }

  it('an equal route does not take the tile from its holder', () => {
    const { s, edges } = ring([[0, 0, 4], [1, 8, 11]], 0);
    const t = patch(s, (x) => {
      toMain(x, 1);
      grant(x, 1, { brick: 1, wood: 1 });
    });
    const r = apply(t, 1, { type: 'buildRoad', edge: edges[12] });
    expect(longestRoadFor(r.state, 1)).toBe(5);
    expect(r.state.longestRoadHolder).toBe(0);
  });

  it('a broken route passes the tile to a unique leader', () => {
    const { s, edges, joins } = ring([[0, 0, 5], [1, 8, 12]], 0);
    const t = patch(s, (x) => {
      toMain(x, 3);
      x.routes[x.board.vertices[joins[2]].edges.find((e) => e !== edges[2] && e !== edges[3])!] = road(3);
      grant(x, 3, { brick: 1, wood: 1, wool: 1, wheat: 1 });
    });
    const r = apply(t, 3, { type: 'buildSettlement', vertex: joins[2] });
    expect(longestRoadFor(r.state, 0)).toBe(3);
    expect(r.state.longestRoadHolder).toBe(1);
    expect(r.events).toContainEqual({ type: 'longestRoadChanged', from: 0, to: 1, length: 5 });
  });

  it('a break that leaves a tie at the top sets the tile aside', () => {
    const { s, edges, joins } = ring([[0, 0, 5], [1, 8, 12], [2, 15, 19]], 0);
    const t = patch(s, (x) => {
      toMain(x, 3);
      x.routes[x.board.vertices[joins[2]].edges.find((e) => e !== edges[2] && e !== edges[3])!] = road(3);
      grant(x, 3, { brick: 1, wood: 1, wool: 1, wheat: 1 });
    });
    const r = apply(t, 3, { type: 'buildSettlement', vertex: joins[2] });
    expect(r.state.longestRoadHolder).toBeNull();
    expect(r.events).toContainEqual({ type: 'longestRoadChanged', from: 0, to: null, length: 0 });
  });

  it('taking back the road that won the tile gives it back', () => {
    const { s, edges } = ring([[0, 0, 4], [1, 8, 12]], 1);
    const t = patch(s, (x) => {
      toMain(x, 0);
      grant(x, 0, { brick: 1, wood: 1 });
    });
    const built = apply(t, 0, { type: 'buildRoad', edge: edges[5] });
    expect(built.state.longestRoadHolder).toBe(0);
    const back = apply(built.state, 0, { type: 'undo' });
    expect(back.state.longestRoadHolder).toBe(1);
    expect(back.events).toContainEqual({ type: 'longestRoadChanged', from: 0, to: 1, length: 5 });
  });
});

describe('biggest army', () => {
  const knightReady = (p: number, played: number) =>
    patch(beginnerGame(), (x) => {
      toMain(x, p);
      x.players[p].playedKnights = played;
      x.players[p].playedDevCards = Array(played).fill('knight');
      x.players[p].devCards.push({ type: 'knight', boughtTurn: 0 });
    });

  it('goes to the first to play 3 knights, and passes only on strictly more', () => {
    const r = apply(knightReady(0, 2), 0, { type: 'playKnight' });
    expect(r.state.largestArmyHolder).toBe(0);
    expect(r.events).toContainEqual({ type: 'largestArmyChanged', from: null, to: 0, knights: 3 });
    const tie = patch(knightReady(1, 2), (x) => {
      x.largestArmyHolder = 0;
      x.players[0].playedKnights = 3;
      x.players[0].playedDevCards = Array(3).fill('knight');
    });
    expect(apply(tie, 1, { type: 'playKnight' }).state.largestArmyHolder).toBe(0);
    const more = patch(tie, (x) => {
      x.players[1].playedKnights = 3;
      x.players[1].playedDevCards = Array(3).fill('knight');
    });
    const r2 = apply(more, 1, { type: 'playKnight' });
    expect(r2.state.largestArmyHolder).toBe(1);
    expect(r2.events).toContainEqual({ type: 'largestArmyChanged', from: 0, to: 1, knights: 4 });
  });

  it('a knight that takes Biggest Army can win before the robber moves', () => {
    const s = patch(knightReady(0, 2), (x) => x.players[0].devCards.push(...vpCards(6)));
    expect(totalVictoryPoints(s, 0)).toBe(8);
    const r = apply(s, 0, { type: 'playKnight' });
    expect(r.state.phase).toBe('gameOver');
    expect(r.state.winner).toBe(0);
  });
});

describe('robbing several players', () => {
  it('waits for the thief to pick among the candidates', () => {
    const base = emptyIsland(0);
    const hex = base.board.hexes.find((h) => h.id !== base.robberHex && num(h))!;
    const [a, , c] = hex.vertices;
    const s = patch(base, (x) => {
      x.phase = 'moveRobber';
      x.buildings[a] = { owner: 1, kind: 'settlement' };
      x.buildings[c] = { owner: 2, kind: 'settlement' };
      grant(x, 1, { ore: 2 });
      grant(x, 2, { wool: 1 });
    });
    const r = apply(s, 0, { type: 'moveRobber', hex: hex.id });
    expect(r.state.phase).toBe('steal');
    expect(r.state.stealCandidates).toEqual([1, 2]);
    expect(applyAction(r.state, 0, { type: 'steal', victim: 3 }).ok).toBe(false);
    const done = apply(r.state, 0, { type: 'steal', victim: 2 });
    expect(done.state.players[0].hand.wool).toBe(1);
    expect(done.state.phase).toBe('main');
  });
});

describe('invention and bank trades', () => {
  it('invention takes what the supply has left: one card, or none', () => {
    const one = patch(beginnerGame(), (x) => {
      toMain(x, 0);
      x.players[0].devCards.push({ type: 'invention', boughtTurn: 0 });
      for (const r of RESOURCES) {
        x.players[1].hand[r] += x.bank[r];
        x.bank[r] = 0;
      }
      x.bank.ore = 1;
      x.players[1].hand.ore--;
    });
    expect(applyAction(one, 0, { type: 'playInvention', resources: ['ore', 'ore'] }).ok).toBe(false);
    expect(apply(one, 0, { type: 'playInvention', resources: ['ore'] }).state.bank.ore).toBe(0);
    const none = patch(one, (x) => {
      x.bank.ore = 0;
      x.players[1].hand.ore++;
    });
    expect(apply(none, 0, { type: 'playInvention', resources: [] }).state.players[0].hand).toEqual(none.players[0].hand);
  });

  it('trades several times over at 2:1 and 3:1', () => {
    const s = patch(beginnerGame(), (x) => {
      toMain(x, 0);
      const ore = x.board.ports.find((p) => p.type === 'ore')!;
      const any = x.board.ports.find((p) => p.type === 'any')!;
      x.buildings[ore.vertices[0]] = { owner: 0, kind: 'settlement' };
      x.buildings[any.vertices[0]] = { owner: 0, kind: 'settlement' };
      grant(x, 0, { ore: 6, wool: 6 });
    });
    const ore = apply(s, 0, { type: 'bankTrade', give: 'ore', get: 'brick', times: 3 });
    expect(ore.events).toContainEqual({ type: 'bankTraded', player: 0, give: 'ore', giveCount: 6, get: 'brick', getCount: 3 });
    const wool = apply(s, 0, { type: 'bankTrade', give: 'wool', get: 'wood', times: 2 });
    expect(wool.events).toContainEqual({ type: 'bankTraded', player: 0, give: 'wool', giveCount: 6, get: 'wood', getCount: 2 });
    expect(applyAction(s, 0, { type: 'bankTrade', give: 'wool', get: 'wood', times: 3 }).ok).toBe(false);
  });
});

describe('discards', () => {
  it('samples distinct, valid choices from a big hand', () => {
    const hand: CardCounts = rc({ brick: 5, wood: 5, wool: 5, wheat: 5, ore: 5 });
    const opts = discardOptions(hand, 12, 99);
    expect(opts.length).toBe(120);
    expect(new Set(opts.map((o) => RESOURCES.map((r) => o[r]).join())).size).toBe(120);
    for (const o of opts) {
      expect(totalCards(o)).toBe(12);
      for (const r of RESOURCES) expect(o[r]).toBeLessThanOrEqual(hand[r]);
    }
    expect(discardOptions(hand, 12, 99)).toEqual(opts);
  });
});

describe('trade recipients', () => {
  it('only takes a list of distinct other seats', () => {
    const s = patch(beginnerGame(), (x) => toMain(x, 0));
    const offer = (to: unknown) => applyAction(s, 0, { type: 'offerTrade', give: rc({ [RESOURCES.find((r) => s.players[0].hand[r] > 0)!]: 1 }), get: rc({ ore: 1 }), to: to as number[] });
    for (const bad of [[0], [1, 1], [4], [-1], [1.5], 'all', [, 2]]) expect(offer(bad).ok).toBe(false);
    const ok = offer([2, 1]);
    expect(ok.ok && ok.state.trade!.to).toEqual([2, 1]);
    expect(applyAction(ok.ok ? ok.state : s, 3, { type: 'respondTrade', accept: false }).ok).toBe(false);
  });
});

describe('taking back', () => {
  const ready = () =>
    patch(beginnerGame(), (x) => {
      toMain(x, 0);
      grant(x, 0, { brick: 4, wood: 4, wool: 2, wheat: 4, ore: 3 });
      grant(x, 1, { ore: 2 });
    });

  it('a road survives an offer and the answers to it, and the offer stays open', () => {
    const s = ready();
    const road = apply(s, 0, { type: 'buildRoad', edge: legalRoads(s, 0)[0] }).state;
    let t = apply(road, 0, { type: 'offerTrade', give: rc({ wheat: 1 }), get: rc({ ore: 1 }) }).state;
    t = apply(t, 1, { type: 'respondTrade', accept: true }).state;
    t = apply(t, 2, { type: 'respondTrade', accept: false }).state;
    expect(canUndo(t, 0)).toBe(true);
    const back = apply(t, 0, { type: 'undo' }).state;
    expect(back.routes).toEqual(s.routes);
    expect(back.players[0].hand).toEqual(s.players[0].hand);
    expect(back.trade?.responses).toEqual({ 1: 'accepted', 2: 'rejected' });
    const done = apply(back, 0, { type: 'acceptTrade', partner: 1 });
    expect(done.state.players[0].hand.ore).toBe(s.players[0].hand.ore + 1);
  });

  it('a trade that went through cannot be taken back', () => {
    const s = ready();
    const road = apply(s, 0, { type: 'buildRoad', edge: legalRoads(s, 0)[0] }).state;
    let t = apply(road, 0, { type: 'offerTrade', give: rc({ wheat: 1 }), get: rc({ ore: 1 }) }).state;
    t = apply(t, 1, { type: 'respondTrade', accept: true }).state;
    t = apply(t, 0, { type: 'acceptTrade', partner: 1 }).state;
    expect(canUndo(t, 0)).toBe(false);
  });

  it('a bank trade can be taken back, cards and all', () => {
    const s = ready();
    const t = apply(s, 0, { type: 'bankTrade', give: 'brick', get: 'ore' });
    expect(canUndo(t.state, 0)).toBe(true);
    const back = apply(t.state, 0, { type: 'undo' });
    expect(back.state.players[0].hand).toEqual(s.players[0].hand);
    expect(back.state.bank).toEqual(s.bank);
    expect(back.events).toEqual([{ type: 'bankTraded', player: 0, give: 'ore', giveCount: 1, get: 'brick', getCount: 4, undo: true }]);
    // A build then a trade come back one at a time.
    const road = apply(s, 0, { type: 'buildRoad', edge: legalRoads(s, 0)[0] }).state;
    const both = apply(road, 0, { type: 'bankTrade', give: 'wheat', get: 'ore' }).state;
    const one = apply(both, 0, { type: 'undo' }).state;
    expect(one.routes).toEqual(road.routes);
    expect(apply(one, 0, { type: 'undo' }).state.routes).toEqual(s.routes);
  });

  it('the winning build cannot be taken back', () => {
    const s = patch(ready(), (x) => x.players[0].devCards.push(...vpCards(7)));
    const v = s.buildings.findIndex((b) => b?.owner === 0);
    const r = apply(s, 0, { type: 'buildCity', vertex: v });
    expect(r.state.phase).toBe('gameOver');
    expect(canUndo(r.state, 0)).toBe(false);
  });
});

describe('card tracker', () => {
  it('knows what production and building show, exactly', () => {
    const s = beginnerGame();
    for (const v of [0, 1, 2, 3, null]) {
      for (const p of s.players) {
        const e = handEstimate(s, v, p.id);
        expect(e.sure).toEqual(p.hand);
        expect(e.expected).toEqual(p.hand);
      }
    }
  });

  it('a steal is seen by thief and victim; the others know only that a card moved', () => {
    const base = patch(beginnerGame(), (x) => {
      toMain(x, 0);
      x.phase = 'moveRobber';
    });
    const hex = base.board.hexes.find((h) => h.id !== base.robberHex && stealCandidates(base, h.id, 0).length === 1)!.id;
    const victim = stealCandidates(base, hex, 0)[0];
    const r = apply(base, 0, { type: 'moveRobber', hex });
    const stolen = r.events.find((e) => e.type === 'stolen')!;
    const res = stolen.type === 'stolen' ? stolen.resource : 'ore';
    const s = r.state;
    expect(handEstimate(s, victim, 0).sure).toEqual(s.players[0].hand);
    expect(handEstimate(s, 0, victim).sure).toEqual(s.players[victim].hand);
    const third = [1, 2, 3].find((p) => p !== victim)!;
    const seen = handEstimate(s, third, victim);
    expect(seen.sure[res]).toBeLessThanOrEqual(s.players[victim].hand[res]);
    expect(RESOURCES.reduce((n, x) => n + seen.expected[x], 0)).toBeCloseTo(totalCards(s.players[victim].hand));
    const thief = handEstimate(s, third, 0);
    expect(thief.expected[res]).toBeGreaterThan(base.players[0].hand[res]);
    expect(thief.expected[res]).toBeLessThan(base.players[0].hand[res] + 1);
    // What one seat alone knows stays out of the others' redacted views.
    expect(redactState(s, third).tracker).toEqual(redactState(s, null).tracker);
    expect(redactState(s, victim).tracker).not.toEqual(redactState(s, null).tracker);
  });

  slow('never claims a card a hand does not hold, over whole bot games', async () => {
    const { botDecide, createBotMemory } = await import('../src/engine/ai');
    for (const seed of [21, 22, 23]) {
      let s = createGame(FOUR.map((p) => ({ ...p, isBot: true })), { layout: 'random', seed }).state;
      const mem = s.players.map(() => createBotMemory());
      for (let step = 0; step < 4000 && s.phase !== 'gameOver'; step++) {
        const order = [s.currentPlayer, ...[0, 1, 2, 3].filter((p) => p !== s.currentPlayer)];
        let acted = false;
        for (const p of s.trade ? [...order.slice(1), order[0]] : order) {
          const a = botDecide(s, p, mem[p], 'hard');
          if (!a) continue;
          s = apply(s, p, a).state;
          acted = true;
          break;
        }
        expect(acted).toBe(true);
        for (const v of [0, 1, 2, 3, null]) {
          for (const p of s.players) {
            const e = handEstimate(s, v, p.id);
            for (const r of RESOURCES) {
              expect(e.sure[r]).toBeLessThanOrEqual(p.hand[r] + 1e-9);
              expect(e.expected[r]).toBeGreaterThanOrEqual(-1e-9);
            }
          }
        }
      }
    }
  }, timeout(60_000));
});

describe('longestRoadEdges', () => {
  slow('traces a connected route as long as the longest route, for every seat through whole games', () => {
    for (const seed of [3, 11, 27]) {
      let s = createGame(setups(4), { layout: 'random', seed }).state;
      const mem = s.players.map(() => createBotMemory());
      let checks = 0;
      for (let step = 0; step < 4000 && s.phase !== 'gameOver'; step++) {
        let acted = false;
        for (let p = 0; p < 4 && !acted; p++) {
          const a = botDecide(s, p, mem[p], 'normal');
          if (!a) continue;
          const r = applyAction(s, p, a);
          if (!r.ok) continue;
          s = r.state;
          acted = true;
        }
        if (!acted) break;
        if (step % 25) continue;
        for (const pl of s.players) {
          const route = longestRoadEdges(s, pl.id);
          expect(route.length).toBe(longestRoadFor(s, pl.id));
          expect(new Set(route).size).toBe(route.length);
          for (const e of route) expect(s.routes[e]?.owner).toBe(pl.id);
          // Each edge shares a corner with the next.
          for (let i = 1; i < route.length; i++) {
            const a = s.board.edges[route[i - 1]], b = s.board.edges[route[i]];
            expect([a.a, a.b].some((v) => v === b.a || v === b.b)).toBe(true);
          }
          checks++;
        }
      }
      expect(checks).toBeGreaterThan(20);
    }
  }, timeout(60_000));
});

describe('development cards in the game', () => {
  it('are there in the base game and gone where the guilds bring their ventures', async () => {
    const { createGame, devCardsInGame } = await import('../src/engine');
    const seats = ['red', 'blue', 'white'].map((color, i) => ({ name: `P${i}`, color, isBot: true }));
    expect(devCardsInGame(createGame(seats, { seed: 3 }).state)).toBe(true);
    expect(devCardsInGame(createGame(seats, { seed: 3, modules: ['guilds'] }).state)).toBe(false);
  });
});
