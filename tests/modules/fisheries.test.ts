// Fisheries: the lake and fishing grounds on the classic island, fish tokens, the limit and its
// swap, fish actions, the Soggy Boot, and bots playing it to a finish.

import { afterEach, describe, expect, it } from 'vitest';
import {
  NUMBER_DISCS,
  Rng,
  TERRAIN_COUNTS,
  applyAction,
  buildBoard,
  classicSpec,
  createGame,
  legalActions,
  legalRobberHexes,
  playableDevCards,
  publicVictoryPoints,
  randomLayout,
  redactState,
  totalVictoryPoints,
  victoryTarget,
  type Action,
  type Building,
  type DevCardType,
  type GameEvent,
  type GameOptions,
  type GameState,
  type ModuleId,
} from '../../src/engine';
import { BotCtx, moduleSpotValue } from '../../src/engine/ai/context';
import { botDecide, createBotMemory, PROFILES, type BotDifficulty } from '../../src/engine/ai';
import { MODULES } from '../../src/engine/modules';
import type { ModuleHooks } from '../../src/engine/modules/api';
import { shapeFishingMap } from '../../src/engine/modules/fisheries/map';
import { payments } from '../../src/engine/modules/fisheries/fish';
import { BOOT, FISH_COSTS, HIDDEN, fishCosts, type FisheriesState, type Token } from '../../src/engine/modules/fisheries/types';
import { FOUR, grant, patch, raidersAt, corsairAt } from '../helpers';
import { checkInvariants, runBotGame, runFuzzGame, type GameResult } from '../sim-harness';
import { act as actKeeping, giveVenture, stackDeck } from './guilds-helpers';
import { games, slow, timeout } from '../tier';

const FISH: ModuleId[] = ['fisheries'];
const fishOf = (s: GameState): FisheriesState => s.ext.fisheries!;
const lakeOf = (s: GameState) => s.board.hexes.find((h) => h.terrain === 'lake')!;
const groundsOf = (s: GameState) => s.board.hexes.filter((h) => h.terrain === 'sea' && h.numbers.length > 0);
const landVertices = (s: GameState, hex: number) => s.board.hexes[hex].vertices.filter((v) => s.board.vertices[v].land);

/** A random island with fishing, set up and empty, at the start of `player`'s turn (before rolling). */
function fishIsland(player = 0, opts: Partial<GameOptions> = {}): GameState {
  const g = createGame(FOUR, { layout: 'random', seed: 11, modules: FISH, ...opts }).state;
  return patch(g, (x) => {
    x.turn = 5;
    x.setupIndex = x.setupOrder.length;
    x.setupRound = 2;
    x.currentPlayer = player;
    x.phase = 'roll';
    x.hasRolled = false;
  });
}

/** Rig the next roll to `total` (through the event deck, whose top card is the last). */
function rigRoll(s: GameState, total: number) {
  s.options = { ...s.options, eventDeck: true };
  const d1 = Math.min(6, total - 1);
  const d2 = total - d1;
  s.eventCards = [0, 0, 0, 0, 0, 0, (d1 - 1) * 6 + (d2 - 1)];
}

/** Put tokens in a hand, taken from the supply (keeps the tokens conserved). */
function give(s: GameState, player: number, tokens: Token[]) {
  const f = fishOf(s);
  for (const t of tokens) {
    f.supply.splice(f.supply.indexOf(t), 1);
    f.tokens[player].push(t);
  }
  f.tokens[player].sort((a, b) => b - a);
}

/** Stack the supply so that `top` comes off it next, first to last. */
function stack(s: GameState, top: Token[]) {
  const f = fishOf(s);
  for (const t of top) f.supply.splice(f.supply.indexOf(t), 1);
  f.supply.push(...[...top].reverse());
}

function act(s: GameState, player: number, action: Action): { state: GameState; events: GameEvent[] } {
  const r = applyAction(s, player, action);
  if (!r.ok) throw new Error(`${action.type}: ${r.error}`);
  checkInvariants(r.state, action.type);
  return { state: r.state, events: r.events };
}

/** Put a building down, taking its piece from the player's supply. */
function put(s: GameState, v: number, owner: number, kind: 'settlement' | 'city', extra: Partial<Building> = {}) {
  s.buildings[v] = { owner, kind, ...extra };
  if (kind === 'city') s.players[owner].citiesLeft--;
  else s.players[owner].settlementsLeft--;
}

/** `n` empty intersections on land, none next to a building or to each other. */
function freeSpots(s: GameState, n: number): number[] {
  const taken = new Set<number>();
  const out: number[] = [];
  for (const v of s.board.vertices) {
    if (out.length === n) break;
    if (!v.land || s.buildings[v.id] || [v.id, ...v.neighbors].some((u) => s.buildings[u] || taken.has(u))) continue;
    out.push(v.id);
    taken.add(v.id);
  }
  return out;
}

/** Deal a development card of `type` from the deck. */
function deal(s: GameState, player: number, type: DevCardType) {
  s.devDeck.splice(s.devDeck.indexOf(type), 1);
  s.players[player].devCards.push({ type, boughtTurn: 0 });
}

/** Hand the boot to `player` out of the supply. */
function takeBoot(s: GameState, player: number) {
  const f = fishOf(s);
  f.supply.splice(f.supply.indexOf(BOOT), 1);
  f.boot = player;
}

const refused = (s: GameState, player: number, action: Action) => {
  const r = applyAction(s, player, action);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
};

/** Who drew what, in order. */
const draws = (events: GameEvent[]) =>
  events.flatMap((e) => (e.type === 'fisheries/drew' ? [[e.player, e.value]] : e.type === 'fisheries/bootDrawn' ? [[e.player, BOOT]] : []));

describe('the classic island', () => {
  const options = (o: Partial<GameOptions>): GameOptions => ({ ...createGame(FOUR).state.options, modules: FISH, ...o });

  it('puts the lake on an inner hex, the six fishing grounds off the coast, and keeps the base mix', () => {
    const lakeSpots = new Set<string>();
    for (let seed = 1; seed <= games(120, 40); seed++) {
      const numberPlacement = seed % 2 ? 'balanced' : 'spiral';
      const s = createGame(FOUR, { seed, modules: FISH, numberPlacement }).state;
      const land = s.board.hexes.filter((h) => h.terrain !== 'sea');
      expect(land).toHaveLength(19);
      expect(s.board.desertHex).toBeNull();
      const lake = lakeOf(s);
      expect(lake.numbers).toEqual([2, 3, 11, 12]);
      expect(lake.neighbors.every((n) => s.board.hexes[n].terrain !== 'sea')).toBe(true);
      lakeSpots.add(`${lake.q},${lake.r}`);
      // The other eighteen are the base island's terrain and number discs.
      const counts: Record<string, number> = {};
      for (const h of land) if (h !== lake) counts[h.terrain] = (counts[h.terrain] ?? 0) + 1;
      expect(counts).toEqual({ ...TERRAIN_COUNTS, desert: undefined });
      expect(land.filter((h) => h !== lake).flatMap((h) => h.numbers).sort((a, b) => a - b)).toEqual([...NUMBER_DISCS].sort((a, b) => a - b));
      // Six fishing grounds spread round the coast (docs/maps.md), each touching two coastal hexes.
      const grounds = groundsOf(s);
      expect(grounds.map((g) => g.id)).toEqual([19, 20, 21, 22, 23, 24]);
      expect(grounds.flatMap((g) => g.numbers).sort((a, b) => a - b)).toEqual([4, 5, 6, 8, 9, 10]);
      for (const g of grounds) expect(g.neighbors.filter((n) => s.board.hexes[n].terrain !== 'sea')).toHaveLength(2);
      if (numberPlacement === 'balanced') {
        const red = (h: { numbers: number[] }) => h.numbers.some((n) => n === 6 || n === 8);
        for (const h of land) if (red(h)) expect(h.neighbors.some((n) => land.includes(s.board.hexes[n]) && red(s.board.hexes[n]))).toBe(false);
      }
    }
    // Every one of the seven inner hexes holds the lake in some game.
    expect(lakeSpots.size).toBe(7);
  });

  it('leaves every intersection, edge and harbour of the land where it was', () => {
    for (const seed of [1, 2, 3]) {
      const spec = classicSpec(randomLayout(new Rng(seed), 'spiral'));
      shapeFishingMap(spec, options({ seed }), new Rng(seed + 100));
      const full = buildBoard(spec);
      const land = buildBoard({ ...spec, hexes: spec.hexes.slice(0, 19) });
      expect(full.vertices.length).toBe(land.vertices.length + 18);
      expect(full.edges.length).toBe(land.edges.length + 24);
      land.vertices.forEach((v, i) => expect([full.vertices[i].x, full.vertices[i].z, full.vertices[i].port]).toEqual([v.x, v.z, v.port]));
      land.edges.forEach((e, i) => expect([full.edges[i].a, full.edges[i].b, full.edges[i].coastal]).toEqual([e.a, e.b, e.coastal]));
      expect(full.ports).toEqual(land.ports);
      // The fishing grounds' own outer corners are open sea: nothing is built there.
      for (const h of full.hexes.slice(19)) expect(h.vertices.filter((v) => full.vertices[v].land)).toHaveLength(3);
    }
  });

  it('keeps the beginner island’s land, with the lake where its desert was (its discs may trade places to keep the reds apart)', () => {
    const base = createGame(FOUR, { layout: 'beginner', seed: 7 }).state;
    const s = createGame(FOUR, { layout: 'beginner', seed: 7, modules: FISH }).state;
    base.board.hexes.forEach((h, i) => {
      if (h.terrain === 'desert') expect([s.board.hexes[i].terrain, s.board.hexes[i].numbers]).toEqual(['lake', [2, 3, 11, 12]]);
      else expect(s.board.hexes[i].terrain).toBe(h.terrain);
    });
    const discs = (b: typeof base.board) => b.hexes.filter((h) => h.terrain !== 'sea' && h.terrain !== 'lake').flatMap((h) => h.numbers).sort((x, y) => x - y);
    expect(discs(s.board)).toEqual(discs(base.board));
    expect(s.buildings).toEqual(base.buildings.concat(Array(s.buildings.length - base.buildings.length).fill(null)));
  });
});

describe('the robber', () => {
  it('starts beside the board, comes on with the first 7, and may stop on the lake but never at sea', () => {
    let s = fishIsland(0);
    expect(s.robberHex).toBeNull();
    const where = legalRobberHexes(s);
    expect(where).toContain(lakeOf(s).id);
    for (const g of groundsOf(s)) expect(where).not.toContain(g.id);
    s = patch(s, (x) => rigRoll(x, 7));
    s = act(s, 0, { type: 'rollDice' }).state;
    expect(s.phase).toBe('moveRobber');
    expect(applyAction(s, 0, { type: 'moveRobber', hex: groundsOf(s)[0].id }).ok).toBe(false);
    s = act(s, 0, { type: 'moveRobber', hex: lakeOf(s).id }).state;
    expect(s.robberHex).toBe(lakeOf(s).id);
  });

  it('comes on with a Knight card too', () => {
    const s = patch(fishIsland(0), (x) => deal(x, 0, 'knight'));
    const r = act(s, 0, { type: 'playKnight' }).state;
    expect(r.phase).toBe('moveRobber');
  });
});

describe('fishing', () => {
  it('draws a token a settlement, two a city and three a foundry, the roller first and then clockwise', () => {
    const s0 = fishIsland(2);
    const lake = lakeOf(s0);
    const [a, , b, , c] = lake.vertices;
    const s = patch(s0, (x) => {
      put(x, a, 1, 'settlement');
      put(x, b, 2, 'city');
      put(x, c, 0, 'city', { foundry: true });
      stack(x, [3, 1, 2, 2, 3, 1]);
      rigRoll(x, 11);
    });
    const { state, events } = act(s, 2, { type: 'rollDice' });
    expect(draws(events)).toEqual([
      [2, 3],
      [2, 1],
      [0, 2],
      [0, 2],
      [0, 3],
      [1, 1],
    ]);
    expect(fishOf(state).tokens).toEqual([[3, 2, 2], [1], [3, 1], []]);
    // Tokens aren't cards: the lake gave nobody a card.
    const production = events.find((e) => e.type === 'production');
    expect(production && production.type === 'production' && production.grants.filter((g) => g.hex === lake.id)).toEqual([]);
  });

  it('a fishing ground fishes for the buildings on its coast, on its own number', () => {
    const s0 = fishIsland(0);
    const g = groundsOf(s0)[0];
    const [v] = landVertices(s0, g.id);
    const s = patch(s0, (x) => {
      put(x, v, 3, 'settlement');
      stack(x, [2]);
      rigRoll(x, g.numbers[0]);
    });
    expect(draws(act(s, 0, { type: 'rollDice' }).events)).toEqual([[3, 2]]);
  });

  it('the robber on the lake blocks all four of its numbers', () => {
    const s0 = fishIsland(0);
    const lake = lakeOf(s0);
    for (const n of [2, 3, 11, 12]) {
      const s = patch(s0, (x) => {
        put(x, lake.vertices[0], 1, 'city');
        x.robberHex = lake.id;
        rigRoll(x, n);
      });
      const { events } = act(s, 0, { type: 'rollDice' });
      expect(draws(events)).toEqual([]);
      expect(events.find((e) => e.type === 'production')).toMatchObject({ blockedHexes: [lake.id] });
    }
  });

  it('with Sea Lanes, the corsair blocks the fishing ground it stops on', () => {
    const s0 = fishIsland(0, { modules: ['sea', 'fisheries'] });
    const g = groundsOf(s0)[0];
    const setUp = (corsair: number | null) =>
      patch(s0, (x) => {
        x.ext.sea = corsairAt(x, corsair);
        put(x, landVertices(x, g.id)[0], 1, 'settlement');
        rigRoll(x, g.numbers[0]);
      });
    expect(draws(act(setUp(g.id), 0, { type: 'rollDice' }).events)).toEqual([]);
    expect(draws(act(setUp(groundsOf(s0)[1].id), 0, { type: 'rollDice' }).events)).toHaveLength(1);
  });

  it('with Sea Lanes, the corsair waits off the board with the robber, and a 7 may bring either in (rule 4)', () => {
    const opts = { seed: 3, map: 'archipelago', victoryPoints: 14 };
    // The map alone puts the corsair at sea.
    expect(createGame(FOUR, { ...opts, modules: ['sea'] }).state.ext.sea!.corsair).not.toBeNull();
    const s0 = createGame(FOUR, { ...opts, modules: ['sea', 'fisheries'] }).state;
    expect([s0.robberHex, s0.ext.sea!.corsair]).toEqual([null, null]);
    const s = patch(s0, (x) => {
      x.turn = 5;
      x.setupIndex = x.setupOrder.length;
      x.currentPlayer = 0;
      x.phase = 'roll';
      x.hasRolled = false;
      rigRoll(x, 7);
    });
    const rolled = act(s, 0, { type: 'rollDice' }).state;
    expect(rolled.pending.at(-1)).toMatchObject({ kind: 'sea/blocker', players: [0] });
    const moves = new Set(legalActions(rolled, 0).map((a) => a.type));
    expect(moves).toEqual(new Set(['sea/moveRobber', 'sea/moveCorsair']));
  });

  it('a building cut off by conquest catches nothing', () => {
    const s0 = fishIsland(0, { modules: ['invasion', 'fisheries'] });
    const g = groundsOf(s0)[0];
    // A corner of the ground with a single land hex beside it.
    const v = landVertices(s0, g.id).find((x) => s0.board.vertices[x].hexes.filter((h) => s0.board.hexes[h].terrain !== 'sea').length === 1)!;
    const landHex = s0.board.vertices[v].hexes.find((h) => s0.board.hexes[h].terrain !== 'sea')!;
    const s = patch(s0, (x) => {
      x.ext.invasion = raidersAt(x, x.board.hexes.map((h) => (h.id === landHex ? 3 : 0)));
      put(x, v, 1, 'city');
      rigRoll(x, g.numbers[0]);
    });
    expect(draws(act(s, 0, { type: 'rollDice' }).events)).toEqual([]);
    // Nor does a seat city: cut off, it keeps its points but produces nothing, fish included.
    expect(draws(act(patch(s, (x) => (x.buildings[v]!.seat = 'learning')), 0, { type: 'rollDice' }).events)).toEqual([]);
  });

  it('a second set-up building on the lake or a fishing ground draws one token; a first one none', () => {
    const g = createGame(FOUR, { layout: 'random', seed: 11, modules: FISH }).state;
    const ground = groundsOf(g)[0];
    const [v] = landVertices(g, ground.id);
    const first = act(g, g.currentPlayer, { type: 'placeSetupSettlement', vertex: v }).state;
    expect(fishOf(first).tokens.flat()).toEqual([]);
    const second = patch(g, (x) => {
      x.setupIndex = x.players.length;
      x.setupRound = 2;
      x.currentPlayer = x.setupOrder[x.setupIndex];
      stack(x, [3]);
    });
    const r = act(second, second.currentPlayer, { type: 'placeSetupSettlement', vertex: v });
    expect(draws(r.events)).toEqual([[second.currentPlayer, 3]]);
  });

  it('shuffles the spent tokens into a new supply when it runs out', () => {
    const s0 = fishIsland(0);
    const lake = lakeOf(s0);
    const s = patch(s0, (x) => {
      const f = fishOf(x);
      f.discard = f.supply.filter((t) => t !== BOOT);
      f.supply = [BOOT];
      put(x, lake.vertices[0], 1, 'city');
      rigRoll(x, 12);
    });
    const { state, events } = act(s, 0, { type: 'rollDice' });
    expect(events.map((e) => e.type)).toContain('fisheries/reshuffled');
    expect(draws(events)[0]).toEqual([1, BOOT]);
    expect(fishOf(state).tokens[1]).toHaveLength(1);
  });
});

describe('the limit', () => {
  /** Player 1 at the limit on the lake, player 2 beside them; player 0 rolls a 2. */
  function atLimit(dueOne: 'settlement' | 'city' = 'settlement') {
    const s0 = fishIsland(0);
    const lake = lakeOf(s0);
    return patch(s0, (x) => {
      give(x, 1, [3, 2, 1, 1, 1, 1, 1]);
      put(x, lake.vertices[0], 1, dueOne);
      put(x, lake.vertices[2], 2, 'settlement');
      stack(x, [3, 2]);
      rigRoll(x, 2);
    });
  }

  it('stops a full purse, offering one swap first: a token back for a fresh one', () => {
    const { state: s, events } = act(atLimit('city'), 0, { type: 'rollDice' });
    expect(events).toContainEqual({ type: 'fisheries/full', player: 1, missed: 2 });
    expect(s.pending).toEqual([{ kind: 'fisheries/swap', players: [1] }]);
    // Player 2 waits until the swap is decided.
    expect(draws(events)).toEqual([]);
    expect(legalActions(s, 1)).toEqual([
      { type: 'fisheries/swap', give: null },
      { type: 'fisheries/swap', give: 3 },
      { type: 'fisheries/swap', give: 2 },
      { type: 'fisheries/swap', give: 1 },
    ]);
    expect(legalActions(s, 0)).toEqual([]);
    expect(refused(s, 0, { type: 'endTurn' })).toMatch(/decision/);
    const r = act(s, 1, { type: 'fisheries/swap', give: 1 });
    expect(draws(r.events)).toEqual([
      [1, 3],
      [2, 2],
    ]);
    expect(fishOf(r.state).tokens[1]).toEqual([3, 3, 2, 1, 1, 1, 1]);
    expect(fishOf(r.state).discard).toEqual([1]);
    expect(r.state.pending).toEqual([]);
    expect(r.state.phase).toBe('main');
  });

  it('may be declined, and comes once a turn', () => {
    const s = act(atLimit(), 0, { type: 'rollDice' }).state;
    const kept = act(s, 1, { type: 'fisheries/swap', give: null });
    expect(fishOf(kept.state).tokens[1]).toEqual([3, 2, 1, 1, 1, 1, 1]);
    expect(draws(kept.events)).toEqual([[2, 3]]);
    // Once swapped this turn, a second catch the same turn just stops at the limit.
    const swapped = act(s, 1, { type: 'fisheries/swap', give: 1 }).state;
    const again = patch(swapped, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
      rigRoll(x, 3);
    });
    const r = act(again, 0, { type: 'rollDice' });
    expect(r.state.pending).toEqual([]);
    expect(r.events).toContainEqual({ type: 'fisheries/full', player: 1, missed: 1 });
  });

  it("tokens don't count on a 7", () => {
    const s = patch(fishIsland(0), (x) => {
      give(x, 1, [3, 3, 2, 2, 1, 1, 1]);
      grant(x, 1, { brick: 7 });
      rigRoll(x, 7);
    });
    const r = act(s, 0, { type: 'rollDice' }).state;
    expect(r.phase).toBe('moveRobber');
    expect(r.pendingDiscards).toEqual({});
  });
});

describe('fish actions', () => {
  /** Player 0's main phase, holding `tokens`. */
  const holding = (tokens: Token[], fn: (x: GameState) => void = () => {}) =>
    patch(fishIsland(0), (x) => {
      give(x, 0, tokens);
      x.phase = 'main';
      x.hasRolled = true;
      fn(x);
    });

  it('are paid in fish shown, with no token to spare and no change given', () => {
    expect(payments([3, 2, 1, 1], 4)).toEqual([
      [2, 1, 1],
      [3, 1],
      [3, 2],
    ]);
    expect(payments([1, 1, 1], 4)).toEqual([]);
    const s = holding([3, 2, 1, 1]);
    expect(refused(s, 0, { type: 'fisheries/take', pay: [3, 1, 1], resource: 'ore' })).toMatch(/none to spare/);
    expect(refused(s, 0, { type: 'fisheries/take', pay: [3], resource: 'ore' })).toMatch(/Pay 4 fish/);
    expect(refused(s, 0, { type: 'fisheries/take', pay: [3, 3], resource: 'ore' })).toMatch(/Pay 4 fish/);
    // Overpaying with the last token is allowed: the change is lost.
    const r = act(s, 0, { type: 'fisheries/take', pay: [2, 3], resource: 'ore' }).state;
    expect(fishOf(r).tokens[0]).toEqual([1, 1]);
    expect(fishOf(r).discard).toEqual([2, 3]);
    expect(r.players[0].hand.ore).toBe(s.players[0].hand.ore + 1);
    expect(r.bank.ore).toBe(s.bank.ore - 1);
  });

  it('only on your own turn, before or after rolling, with nothing owed', () => {
    const s = holding([3, 3]);
    expect(refused(s, 1, { type: 'fisheries/take', pay: [3, 3], resource: 'ore' })).toMatch(/not your turn/);
    expect(legalActions(s, 1).some((a) => a.type.startsWith('fisheries/'))).toBe(false);
    const before = patch(s, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
    });
    expect(act(before, 0, { type: 'fisheries/take', pay: [3, 3], resource: 'wool' }).state.phase).toBe('roll');
    const discarding = patch(s, (x) => {
      x.phase = 'discard';
      x.pendingDiscards = { 1: 4 };
    });
    expect(refused(discarding, 0, { type: 'fisheries/take', pay: [3, 3], resource: 'ore' })).toMatch(/discard/);
  });

  it('two fish send the robber off the board, until the next 7 or Knight card', () => {
    const lake = (x: GameState) => lakeOf(x).id;
    const s = holding([2], (x) => (x.robberHex = lake(x)));
    const { state, events } = act(s, 0, { type: 'fisheries/blocker', pay: [2], blocker: 'robber' });
    expect(state.robberHex).toBeNull();
    expect(events).toContainEqual({ type: 'fisheries/blockerRemoved', player: 0, blocker: 'robber', from: lake(s) });
    // Nothing to send away now.
    expect(refused(patch(state, (x) => give(x, 0, [2])), 0, { type: 'fisheries/blocker', pay: [2], blocker: 'robber' })).toMatch(/not on the board/);
  });

  it('with Sea Lanes, the corsair may be sent away instead', () => {
    const s0 = fishIsland(0, { modules: ['sea', 'fisheries'] });
    const s = patch(s0, (x) => {
      x.ext.sea = corsairAt(x, groundsOf(x)[2].id);
      give(x, 0, [1, 1]);
      x.phase = 'main';
      x.hasRolled = true;
    });
    expect(legalActions(s, 0).filter((a) => a.type === 'fisheries/blocker')).toEqual([{ type: 'fisheries/blocker', pay: [1, 1], blocker: 'corsair' }]);
    expect(act(s, 0, { type: 'fisheries/blocker', pay: [1, 1], blocker: 'corsair' }).state.ext.sea!.corsair).toBeNull();
  });

  it('three fish steal a random card from anyone holding one', () => {
    const s = holding([3], (x) => grant(x, 2, { wheat: 1 }));
    const steals = legalActions(s, 0).filter((a) => a.type === 'fisheries/steal');
    expect(steals).toEqual([{ type: 'fisheries/steal', pay: [3], victim: 2 }]);
    const { state, events } = act(s, 0, { type: 'fisheries/steal', pay: [3], victim: 2 });
    expect(events).toContainEqual({ type: 'stolen', thief: 0, victim: 2, resource: 'wheat', by: 'fish' });
    expect(state.players[0].hand.wheat).toBe(1);
    expect(refused(patch(s, (x) => give(x, 0, [3])), 0, { type: 'fisheries/steal', pay: [3], victim: 1 })).toMatch(/cannot steal/);
  });

  it('with Oil, three fish may name one oil instead, if there is room for it', () => {
    const s = patch(fishIsland(0, { modules: ['fisheries', 'oil'] }), (x) => {
      give(x, 0, [3]);
      x.phase = 'main';
      x.hasRolled = true;
      grant(x, 2, { wheat: 1 });
      grant(x, 3, { oil: 2 });
    });
    const steals = legalActions(s, 0).filter((a) => a.type === 'fisheries/steal');
    expect(steals).toEqual([
      { type: 'fisheries/steal', pay: [3], victim: 2 },
      { type: 'fisheries/steal', pay: [3], victim: 3, oil: true },
    ]);
    const r = applyAction(s, 0, { type: 'fisheries/steal', pay: [3], victim: 3, oil: true });
    if (!r.ok) throw new Error(r.error);
    const { state, events } = r;
    checkInvariants(state, 'fish theft of oil', { oil: 15 });
    expect(events).toContainEqual({ type: 'stolen', thief: 0, victim: 3, resource: 'oil', by: 'fish', named: true });
    expect([state.players[0].hand.oil, state.players[3].hand.oil]).toEqual([1, 1]);
    // Naming oil from a player holding none is refused.
    expect(refused(patch(s, (x) => give(x, 0, [3])), 0, { type: 'fisheries/steal', pay: [3], victim: 2, oil: true })).toMatch(/room for their oil|cannot steal/);
  });

  it('four fish take a resource, while the supply has it', () => {
    const s = holding([2, 2], (x) => grant(x, 3, { brick: 19 }));
    expect(legalActions(s, 0).filter((a) => a.type === 'fisheries/take').map((a) => (a as { resource: string }).resource)).toEqual(['wood', 'wool', 'wheat', 'ore']);
    expect(refused(s, 0, { type: 'fisheries/take', pay: [2, 2], resource: 'brick' })).toMatch(/no brick/);
  });

  it('six fish build a road for free, in the free-route interlude', () => {
    const s0 = holding([3, 3]);
    const v = s0.board.vertices.findIndex((x) => x.hexes.length === 3 && x.hexes.every((h) => s0.board.hexes[h].terrain !== 'sea'));
    const s = patch(s0, (x) => put(x, v, 0, 'settlement'));
    const before = s.players[0].hand;
    let r = act(s, 0, { type: 'fisheries/route', pay: [3, 3] }).state;
    expect([r.phase, r.freeRoadsLeft, r.resumePhase]).toEqual(['roadBuilding', 1, 'main']);
    r = act(r, 0, { type: 'placeFreeRoad', edge: s.board.vertices[v].edges[0] }).state;
    expect(r.phase).toBe('main');
    expect(r.routes[s.board.vertices[v].edges[0]]).toMatchObject({ owner: 0, kind: 'road' });
    expect(r.players[0].hand).toEqual(before);
    // Before rolling, play comes back to the roll.
    const early = patch(s, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
    });
    expect(act(early, 0, { type: 'fisheries/route', pay: [3, 3] }).state.resumePhase).toBe('roll');
    // Nowhere to build: not offered.
    expect(legalActions(s0, 0).some((a) => a.type === 'fisheries/route')).toBe(false);
  });

  it("seven fish take the top development card, which can't be played the turn it comes", () => {
    const s = holding([3, 3, 1], (x) => (x.devDeck[x.devDeck.length - 1] = 'knight'));
    const { state, events } = act(s, 0, { type: 'fisheries/card', pay: [3, 3, 1] });
    expect(events).toContainEqual({ type: 'fisheries/card', player: 0, card: 'knight' });
    expect(state.players[0].devCards).toEqual([{ type: 'knight', boughtTurn: 5 }]);
    expect(state.devDeck).toHaveLength(s.devDeck.length - 1);
    expect(playableDevCards(state, 0)).toEqual([]);
    expect(refused(patch(s, (x) => (x.devDeck = [])), 0, { type: 'fisheries/card', pay: [3, 3, 1] })).toMatch(/empty/);
  });

  describe('where another deck replaces the development cards', () => {
    const saved = MODULES.guilds.hooks;
    afterEach(() => {
      MODULES.guilds.hooks = saved;
    });

    it('seven fish take the top card of the deck you choose', () => {
      const dealt: [number, string][] = [];
      const hooks: ModuleHooks = { freeCardDecks: () => ['learning', 'commerce'], dealFreeCard: (_ctx, p, deck) => void dealt.push([p, deck]) };
      MODULES.guilds.hooks = hooks;
      const s = patch(fishIsland(0, { modules: ['guilds', 'fisheries'] }), (x) => {
        give(x, 0, [3, 2, 2]);
        x.phase = 'main';
        x.hasRolled = true;
      });
      expect(legalActions(s, 0).filter((a) => a.type === 'fisheries/card')).toEqual([
        { type: 'fisheries/card', pay: [3, 2, 2], deck: 'learning' },
        { type: 'fisheries/card', pay: [3, 2, 2], deck: 'commerce' },
      ]);
      expect(applyAction(s, 0, { type: 'fisheries/card', pay: [3, 2, 2] }).ok).toBe(false);
      expect(applyAction(s, 0, { type: 'fisheries/card', pay: [3, 2, 2], deck: 'statecraft' }).ok).toBe(false);
      const r = applyAction(s, 0, { type: 'fisheries/card', pay: [3, 2, 2], deck: 'commerce' });
      expect(r.ok).toBe(true);
      expect(dealt).toEqual([[0, 'commerce']]);
      expect(r.ok && r.state.players[0].devCards).toEqual([]);
    });
  });

  describe('where the guilds or Invasion replace the development cards (rule 3)', () => {
    /** Player 0's main phase in a game with `modules`, holding seven fish. */
    const sevenFish = (modules: ModuleId[], fn: (x: GameState) => void = () => {}) =>
      patch(fishIsland(0, { modules }), (x) => {
        give(x, 0, [3, 2, 2]);
        x.phase = 'main';
        x.hasRolled = true;
        fn(x);
      });
    // (The guilds add commodities to the supply: each state is held to its own scene's totals.)
    const cardBuys = (s: GameState) => legalActions(s, 0).filter((a) => a.type === 'fisheries/card');

    it('with the guilds, seven fish take the top venture of the deck you choose', () => {
      const s0 = sevenFish(['guilds', 'fisheries']);
      expect(cardBuys(s0)).toEqual(['learning', 'commerce', 'statecraft'].map((deck) => ({ type: 'fisheries/card', pay: [3, 2, 2], deck })));
      // (Before, with the development deck set aside, no card was ever offered.)
      expect(s0.devDeck).toEqual([]);
      const s = patch(s0, (x) => stackDeck(x, 'trader'));
      const { state, events } = actKeeping(s, 0, { type: 'fisheries/card', pay: [3, 2, 2], deck: 'commerce' });
      expect(state.ext.guilds!.hands[0]).toEqual(['trader']);
      expect(events).toContainEqual({ type: 'guilds/drew', player: 0, track: 'commerce', card: 'trader' });
      expect(state.players[0].hand).toEqual(s.players[0].hand);
      expect(fishOf(state).tokens[0]).toEqual([]);
      // A deck that has run dry isn't offered.
      const dry = patch(s0, (x) => (x.ext.guilds!.decks.learning = []));
      expect(cardBuys(dry).map((a) => (a as { deck?: string }).deck)).toEqual(['commerce', 'statecraft']);
    });

    it('a victory venture is shown at once, and a fifth venture waits for the end of your actions', () => {
      const shown = actKeeping(
        sevenFish(['guilds', 'fisheries'], (x) => stackDeck(x, 'grandCharter')),
        0,
        { type: 'fisheries/card', pay: [3, 2, 2], deck: 'statecraft' },
      ).state;
      expect(shown.ext.guilds!.shown[0]).toEqual(['grandCharter']);
      expect(shown.ext.guilds!.hands[0]).toEqual([]);
      expect(totalVictoryPoints(shown, 0)).toBe(totalVictoryPoints(sevenFish(['guilds', 'fisheries']), 0) + 1);

      const full = sevenFish(['guilds', 'fisheries'], (x) => {
        for (const c of ['augury', 'hoist', 'waterworks', 'salvage'] as const) giveVenture(x, 0, c);
        stackDeck(x, 'trader');
      });
      const drawn = actKeeping(full, 0, { type: 'fisheries/card', pay: [3, 2, 2], deck: 'commerce' }).state;
      expect(drawn.ext.guilds!.hands[0]).toHaveLength(5);
      expect(drawn.pending).toEqual([]);
      const ended = actKeeping(drawn, 0, { type: 'endTurn' }).state;
      expect(ended.pending).toMatchObject([{ kind: 'guilds/ventureLimit', players: [0] }]);
    });

    it('with Invasion and no guilds, seven fish take the top muster card, played at once', () => {
      const s0 = sevenFish(['invasion', 'fisheries'], (x) => {
        const deck = x.ext.invasion!.deck;
        deck.splice(deck.lastIndexOf('levy'), 1);
        deck.push('levy');
      });
      expect(cardBuys(s0)).toEqual([{ type: 'fisheries/card', pay: [3, 2, 2], deck: 'muster' }]);
      const { state, events } = actKeeping(s0, 0, { type: 'fisheries/card', pay: [3, 2, 2], deck: 'muster' });
      expect(events).toContainEqual({ type: 'invasion/drew', player: 0, card: 'levy', wasted: false });
      expect(events.some((e) => e.type === 'invasion/bought')).toBe(false);
      expect(state.pending).toEqual([{ kind: 'invasion/card', players: [0], data: { card: 'levy' } }]);
      expect(state.players[0].hand).toEqual(s0.players[0].hand);
      // With the guilds too, their ventures outrank the muster deck.
      expect(cardBuys(sevenFish(['guilds', 'invasion', 'fisheries'])).map((a) => (a as { deck?: string }).deck)).toEqual(['learning', 'commerce', 'statecraft']);
    });

    it('the bot draws from the Commerce deck rather than the first offered', () => {
      const s = sevenFish(['guilds', 'fisheries'], (x) => grant(x, 0, { brick: 3, wood: 3, wool: 3, wheat: 3, ore: 3 }));
      const ctx = new BotCtx(s, 0, 'hard', createBotMemory(), PROFILES.hard);
      expect(MODULES.fisheries.bot!.main!(ctx)).toEqual({ type: 'fisheries/card', pay: [3, 2, 2], deck: 'commerce' });
    });
  });
});

describe('the second rules: the token mix and the prices', () => {
  it('deals 12 one-fish, 9 two-fish and 7 three-fish tokens and the boot', () => {
    const f = fishOf(fishIsland(0));
    const count = (v: number) => f.supply.filter((t) => t === v).length;
    expect([count(1), count(2), count(3), count(0)]).toEqual([12, 9, 7, 1]);
  });

  it('prices a blocker at 2, a steal at 3, a resource at 4, a road at 6 and a card at 7', () => {
    expect(FISH_COSTS).toEqual({ blocker: 2, steal: 3, take: 4, route: 6, card: 7 });
  });

  it('keeps the first mix and prices for a game recorded under them: 11, 10 and 8, and a road for 5', () => {
    const s = fishIsland(0, { moduleRules: { fisheries: 1 } });
    const count = (v: number) => fishOf(s).supply.filter((t) => t === v).length;
    expect([count(1), count(2), count(3), count(0)]).toEqual([11, 10, 8, 1]);
    expect(fishCosts(s).route).toBe(5);
  });
});

describe('the Soggy Boot', () => {
  it('is shown when drawn, and its holder needs a point more', () => {
    const s0 = fishIsland(0);
    const s = patch(s0, (x) => {
      put(x, lakeOf(x).vertices[0], 3, 'settlement');
      stack(x, [BOOT]);
      rigRoll(x, 2);
    });
    const { state, events } = act(s, 0, { type: 'rollDice' });
    expect(events).toContainEqual({ type: 'fisheries/bootDrawn', player: 3 });
    expect(fishOf(state).boot).toBe(3);
    expect(fishOf(state).tokens[3]).toEqual([]);
    expect(victoryTarget(state, 3)).toBe(11);
    expect(victoryTarget(state, 0)).toBe(10);
  });

  it('passes on your turn to a player with more points showing', () => {
    const s = patch(fishIsland(0), (x) => {
      takeBoot(x, 0);
      const spots = freeSpots(x, 12);
      const owners = [0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 3];
      spots.forEach((v, i) => put(x, v, owners[i], 'settlement'));
      deal(x, 1, 'victoryPoint');
    });
    expect(s.players.map((p) => publicVictoryPoints(s, p.id))).toEqual([3, 2, 3, 4]);
    expect(legalActions(s, 0).filter((a) => a.type === 'fisheries/passBoot')).toEqual([{ type: 'fisheries/passBoot', to: 3 }]);
    // (Hidden points don't count: player 1 shows 2. Player 2 is level with the holder, and level is not enough.)
    expect(refused(s, 0, { type: 'fisheries/passBoot', to: 1 })).toMatch(/more points/);
    expect(refused(s, 0, { type: 'fisheries/passBoot', to: 2 })).toMatch(/more points/);
    // (Games recorded under the first rules passed it to a player level on points too.)
    const first = patch(s, (x) => (x.options = { ...x.options, moduleRules: { ...x.options.moduleRules, fisheries: 1 } }));
    expect(legalActions(first, 0).filter((a) => a.type === 'fisheries/passBoot')).toEqual([
      { type: 'fisheries/passBoot', to: 2 },
      { type: 'fisheries/passBoot', to: 3 },
    ]);
    expect(refused(s, 2, { type: 'fisheries/passBoot', to: 3 })).toMatch(/not your turn/);
    const r = act(s, 0, { type: 'fisheries/passBoot', to: 3 });
    expect(fishOf(r.state).boot).toBe(3);
    expect(r.events).toContainEqual({ type: 'fisheries/bootPassed', from: 0, to: 3 });
    expect(legalActions(r.state, 0).some((a) => a.type === 'fisheries/passBoot')).toBe(false);
    expect(refused(r.state, 0, { type: 'fisheries/passBoot', to: 3 })).toMatch(/do not have/);
  });

  it('holds its holder at ten points, and passing it on wins the game', () => {
    const s = patch(fishIsland(0), (x) => {
      takeBoot(x, 0);
      x.phase = 'main';
      x.hasRolled = true;
      // (Player 1 shows 9 points, one more than the holder's 8: the boot may go to them.)
      const spots = freeSpots(x, 9);
      spots.forEach((v, i) => put(x, v, i < 4 ? 0 : 1, i < 8 ? 'city' : 'settlement'));
      deal(x, 0, 'victoryPoint');
      deal(x, 0, 'victoryPoint');
      give(x, 0, [2, 2]);
    });
    expect(totalVictoryPoints(s, 0)).toBe(10);
    expect(victoryTarget(s, 0)).toBe(11);
    const on = act(s, 0, { type: 'fisheries/take', pay: [2, 2], resource: 'ore' }).state;
    expect([on.phase, on.winner]).toEqual(['main', null]);
    const won = act(on, 0, { type: 'fisheries/passBoot', to: 1 });
    expect([won.state.phase, won.state.winner]).toEqual(['gameOver', 0]);
    expect(won.events).toContainEqual({ type: 'gameWon', player: 0, points: 10 });
  });
});

describe('secrets', () => {
  it('hides the supply and other hands, but not their sizes, the spent tokens or the boot', () => {
    const s = patch(fishIsland(0), (x) => {
      give(x, 0, [3, 1]);
      give(x, 2, [2, 2, 1]);
      takeBoot(x, 1);
      const t = fishOf(x).supply.pop()!;
      fishOf(x).discard.push(t);
    });
    const seen = fishOf(redactState(s, 0));
    expect(seen.tokens).toEqual([[3, 1], [], [HIDDEN, HIDDEN, HIDDEN], []]);
    expect(seen.supply.every((t) => t === HIDDEN)).toBe(true);
    expect(seen.supply).toHaveLength(fishOf(s).supply.length);
    expect(seen.discard).toEqual(fishOf(s).discard);
    expect(seen.boot).toBe(1);
    expect(fishOf(redactState(s, null)).tokens).toEqual([[HIDDEN, HIDDEN], [], [HIDDEN, HIDDEN, HIDDEN], []]);
    // The real state is untouched.
    expect(fishOf(s).tokens[2]).toEqual([2, 2, 1]);
  });
});

describe('bots', () => {
  const ctxFor = (s: GameState, p: number, diff: BotDifficulty = 'hard') => new BotCtx(s, p, diff, createBotMemory(), PROFILES[diff]);

  it('value the lake and the fishing grounds when they settle', () => {
    const s = fishIsland(0);
    const ctx = ctxFor(s, 0);
    const lake = lakeOf(s);
    expect(moduleSpotValue(ctx, lake.vertices[0])).toBeCloseTo(6 * 0.55);
    const inland = s.board.vertices.find((v) => v.land && v.hexes.every((h) => !['lake', 'sea'].includes(s.board.hexes[h].terrain)))!;
    expect(moduleSpotValue(ctx, inland.id)).toBe(0);
    // Without fisheries the same intersection is worth less to the base scorer.
    const plain = createGame(FOUR, { layout: 'random', seed: 11 }).state;
    const sameBoard = patch(plain, (x) => {
      x.board = s.board;
      x.robberHex = null;
    });
    expect(ctx.spotValue(groundVertex(s))).toBeGreaterThan(ctxFor(sameBoard, 0).spotValue(groundVertex(s)));
  });

  it('pass the boot to the leader', () => {
    const s = patch(fishIsland(1), (x) => {
      takeBoot(x, 1);
      const owners = [0, 0, 1, 2, 2, 2, 3, 3];
      freeSpots(x, owners.length).forEach((v, i) => put(x, v, owners[i], 'settlement'));
    });
    expect(botDecide(s, 1, createBotMemory(), 'hard')).toEqual({ type: 'fisheries/passBoot', to: 2 });
  });

  it('swap a one-fish token at the limit', () => {
    const s = patch(fishIsland(0), (x) => {
      give(x, 1, [3, 2, 2, 2, 1, 1, 1]);
      x.pending = [{ kind: 'fisheries/swap', players: [1] }];
      x.phase = 'main';
    });
    expect(botDecide(s, 1, createBotMemory(), 'normal')).toEqual({ type: 'fisheries/swap', give: 1 });
  });

  it('send the robber off their own production', () => {
    const s = patch(fishIsland(0), (x) => {
      const h = x.board.hexes.find((hex) => hex.numbers.includes(6) && hex.terrain !== 'sea')!;
      put(x, h.vertices[0], 0, 'city');
      x.robberHex = h.id;
      give(x, 0, [2]);
    });
    expect(botDecide(s, 0, createBotMemory(), 'hard')).toEqual({ type: 'fisheries/blocker', pay: [2], blocker: 'robber' });
  });

  /** An intersection on a fishing ground's coast. */
  function groundVertex(s: GameState) {
    return landVertices(s, groundsOf(s)[0].id)[0];
  }

  const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];
  const results: GameResult[] = [];

  function playMany(count: number, players: 3 | 4, seedBase: number) {
    for (let g = 0; g < count; g++) {
      const res = runBotGame({
        seed: seedBase + g,
        players,
        layout: g % 3 === 2 ? 'beginner' : 'random',
        numberPlacement: g % 2 ? 'balanced' : 'spiral',
        options: { modules: FISH },
        difficulties: g % 4 === 0 ? Array(players).fill('hard') : Array.from({ length: players }, (_, i) => DIFFS[(g + i) % 3]),
        crossCheckLegal: g % 5 === 0,
      });
      expect(res.winner).not.toBeNull();
      expect(res.fallbacks).toBe(0);
      results.push(res);
    }
  }

  slow('play 30 four-seat games to a finish with no fall-backs', () => playMany(30, 4, 31000), timeout(120_000));
  slow('play 20 three-seat games to a finish with no fall-backs', () => {
    playMany(20, 3, 32000);
    const turns = results.reduce((n, r) => n + r.turns, 0) / results.length;
    for (const n of [4, 3]) {
      const games = results.filter((r) => r.players === n);
      const wins = Array(n).fill(0);
      for (const r of games) wins[r.winner!]++;
      const avg = games.reduce((t, r) => t + r.turns, 0) / games.length;
      console.log(`fisheries, ${n} seats: ${games.length} games, ${avg.toFixed(1)} turns on average, wins by seat ${wins.join('/')}`);
    }
    expect(turns).toBeGreaterThan(20);
    expect(turns).toBeLessThan(150);
  }, timeout(120_000));
});

describe('fuzzing', () => {
  slow('every action offered applies, and the tokens stay whole', () => {
    let checked = 0;
    for (let g = 0; g < 6; g++) checked += runFuzzGame(41000 + g, g % 2 ? 3 : 4, g % 3 ? 'random' : 'beginner', 700, true, { modules: FISH }).checkedActions;
    let steps = 0;
    for (let g = 0; g < 8; g++) steps += runFuzzGame(42000 + g, g % 2 ? 3 : 4, 'random', 2500, false, { modules: FISH }).steps;
    expect(checked).toBeGreaterThan(5000);
    expect(steps).toBeGreaterThan(5000);
  }, timeout(120_000));
});
