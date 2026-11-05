import { afterAll, describe, expect, it } from 'vitest';
import {
  NUMBER_DISCS,
  PIPS,
  applyAction,
  buildingWorth,
  cloneState,
  createGame,
  legalActions,
  legalRobberHexes,
  numbersOf,
  totalVictoryPoints,
  type Action,
  type Building,
  type GameEvent,
  type GameOptions,
  type GameState,
} from '../../src/engine';
import type { BotDifficulty } from '../../src/engine/ai';
import { actionKey } from '../../src/engine/ai';
import { Ctx } from '../../src/engine/ctx';
import { Rng, seedFrom } from '../../src/engine/rng';
import { SIDE_DIRS, beginnerLayout, classicSpec, randomLayout, type BoardSpec, type HexSpec } from '../../src/engine/board';
import { placeWells } from '../../src/engine/modules/oil/map';
import { disasterAcceptable } from '../../src/engine/modules/oil/bot';
import { flood, pollute } from '../../src/engine/modules/oil/disaster';
import { FOUNDRIES, OIL_LIMIT, OIL_SUPPLY, OIL_TARGET, isCoastal, oilOf } from '../../src/engine/modules/oil/rules';
import { BotCtx } from '../../src/engine/ai/context';
import { createBotMemory } from '../../src/engine/ai/memory';
import { checkInvariants, runBotGame, runFuzzGame, setups, type GameResult } from '../sim-harness';
import { grant, patch, rc } from '../helpers';
import { HAPPENINGS, cardDice } from '../../src/engine/modules/almanac/deck';
import { rollAs, setLevel } from './guilds-helpers';
import { slow, timeout } from '../tier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Oil in play: the supply less what has been sequestered or destroyed (burned oil goes back to the supply). */
const oilSupply = (s: GameState) => {
  const st = s.ext.oil!;
  return { oil: OIL_SUPPLY - st.sequestered.reduce((a, b) => a + b, 0) - st.destroyed };
};

const check = (s: GameState) => checkInvariants(s, 'oil test', oilSupply(s));

function oilGame(seed = 3, opts: Partial<GameOptions> = {}): GameState {
  return createGame(setups(4), { seed, layout: 'random', modules: ['oil'], victoryPoints: OIL_TARGET, ...opts }).state;
}

/** A game past set-up with `player` in their main phase. */
function ready(seed = 3, opts: Partial<GameOptions> = {}, player = 0): GameState {
  return patch(oilGame(seed, opts), (s) => {
    s.turn = 5;
    s.setupIndex = s.setupOrder.length;
    s.currentPlayer = player;
    s.phase = 'main';
    s.hasRolled = true;
  });
}

/** Take oil out of the supply and the game, as a polluted well would, to set a scene. */
function drain(s: GameState, k: number) {
  s.bank.oil -= k;
  oilOf(s).destroyed += k;
}

/** Set what each player has sequestered, taking that oil out of the supply. */
function sequestered(s: GameState, counts: number[]) {
  const st = oilOf(s);
  s.bank.oil -= counts.reduce((a, b) => a + b, 0) - st.sequestered.reduce((a, b) => a + b, 0);
  st.sequestered = counts;
}

/** Place a building, keeping the piece counts straight. */
function put(s: GameState, v: number, owner: number, kind: 'settlement' | 'city', extra: Partial<Building> = {}) {
  s.buildings[v] = { owner, kind, ...extra };
  if (kind === 'city') s.players[owner].citiesLeft--;
  else s.players[owner].settlementsLeft--;
}

function act(s: GameState, player: number, action: Action): { state: GameState; events: GameEvent[] } {
  const r = applyAction(s, player, action);
  if (!r.ok) throw new Error(`${action.type}: ${r.error}`);
  check(r.state);
  return { state: r.state, events: r.events };
}

function refused(s: GameState, player: number, action: Action): string {
  const r = applyAction(s, player, action);
  if (r.ok) throw new Error(`${action.type} should have been refused`);
  return r.error;
}

const offered = (s: GameState, player: number, action: Action) => legalActions(s, player).some((a) => actionKey(a) === actionKey(action));

/** The dice stream's state whose next two dice add up to `total`. */
function seedFor(total: number): number {
  for (let seed = 1; ; seed++) {
    const r = new Rng(seed);
    if (r.die() + r.die() === total) return seed;
  }
}

/** Try dice streams until applying `action` gives events that `want` accepts. */
function forcing(s: GameState, player: number, action: Action, want: (events: GameEvent[], state: GameState) => boolean) {
  for (let seed = 1; seed < 20000; seed++) {
    const r = applyAction(patch(s, (x) => (x.rngState = seed)), player, action);
    if (r.ok && want(r.events, r.state)) {
      check(r.state);
      return { state: r.state, events: r.events };
    }
  }
  throw new Error('no dice stream gives that');
}

/** Run a disaster function directly, on a copy, with a dice stream that makes `want` true. */
function forceDirect(s: GameState, run: (ctx: Ctx) => void, want: (events: GameEvent[], state: GameState) => boolean) {
  for (let seed = 1; seed < 20000; seed++) {
    const ctx = new Ctx(cloneState(s));
    ctx.rng = new Rng(seed);
    run(ctx);
    if (want(ctx.events, ctx.s)) return { state: ctx.s, events: ctx.events };
  }
  throw new Error('no dice stream gives that');
}

const ofType = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e) => e.type === type) as Extract<GameEvent, { type: T }>[];

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

describe('wells on the classic island', () => {
  // Each island before and after the wells go on (spiral and balanced numbers, and the beginner island).
  const specs: { before: BoardSpec; after: BoardSpec }[] = [];
  for (let seed = 1; seed <= 400; seed++) {
    const rng = new Rng(seedFrom(seed));
    const before = classicSpec(seed === 400 ? beginnerLayout() : randomLayout(rng, seed % 2 ? 'balanced' : 'spiral'));
    const after = structuredClone(before);
    placeWells(after, rng);
    specs.push({ before, after });
  }
  const adj = (a: HexSpec, b: HexSpec) => SIDE_DIRS.some(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r);
  const spips = (h: HexSpec) => h.numbers.reduce((n, x) => n + (PIPS[x] ?? 0), 0);

  it('puts three wells on the desert, a pasture and a forest', () => {
    for (const { after } of specs) expect(after.hexes.filter((h) => h.well).map((h) => h.terrain).sort()).toEqual(['desert', 'forest', 'pasture']);
  });

  it('never side by side, unless the island leaves no other way', () => {
    let forced = 0;
    for (const { after } of specs) {
      const wells = after.hexes.filter((h) => h.well);
      if (!wells.some((a) => wells.some((b) => a !== b && adj(a, b)))) continue;
      forced++;
      // Every pasture and forest pair touches the desert or each other.
      const desert = wells.find((h) => h.terrain === 'desert')!;
      for (const p of after.hexes.filter((h) => h.terrain === 'pasture'))
        for (const f of after.hexes.filter((h) => h.terrain === 'forest')) expect(adj(p, desert) || adj(f, desert) || adj(p, f)).toBe(true);
    }
    expect(forced).toBeLessThan(10);
  });

  it('numbers the desert well 5 or 9, one its neighbours lack when it can', () => {
    let free = 0;
    for (const { before, after } of specs) {
      const i = before.hexes.findIndex((h) => h.terrain === 'desert');
      const desert = after.hexes[i];
      expect(desert.numbers.length).toBe(1);
      expect([5, 9]).toContain(desert.numbers[0]);
      const beside = before.hexes.filter((h) => adj(h, before.hexes[i])).flatMap((h) => h.numbers);
      const fresh = [5, 9].filter((n) => !beside.includes(n));
      if (fresh.length > 0) {
        free++;
        expect(fresh).toContain(desert.numbers[0]);
      }
    }
    expect(free).toBeGreaterThan(50);
  });

  it('puts the pasture well on the second-likeliest pasture and the forest well on the second-least-likely forest', () => {
    for (const { after } of specs) {
      const ranked = (terrain: string, desc: boolean) =>
        after.hexes
          .filter((h) => h.terrain === terrain)
          .map(spips)
          .sort((a, b) => (desc ? b - a : a - b));
      expect(spips(after.hexes.find((h) => h.well && h.terrain === 'pasture')!)).toBe(ranked('pasture', true)[1]);
      expect(spips(after.hexes.find((h) => h.well && h.terrain === 'forest')!)).toBe(ranked('forest', false)[1]);
    }
  });

  it('keeps the island’s numbers (swaps move them, never lose them), and moves as few as it can', () => {
    let moved = 0;
    for (const { before, after } of specs) {
      const desert = after.hexes.find((h) => h.terrain === 'desert')!;
      const all = after.hexes.flatMap((h) => h.numbers).sort((a, b) => a - b);
      expect(all).toEqual([...NUMBER_DISCS, desert.numbers[0]].sort((a, b) => a - b));
      // Numbers only ever move between tiles of one terrain, at most a pair for each well.
      const changed = after.hexes.filter((h, i) => h.terrain !== 'desert' && h.numbers.join() !== before.hexes[i].numbers.join());
      expect(changed.length).toBeLessThanOrEqual(4);
      if (changed.length > 0) moved++;
    }
    expect(moved).toBeLessThan(specs.length / 2);
  });

  it('carries the wells into the game, with 15 oil in the supply, the robber off the board and an empty track', () => {
    const s = oilGame(7);
    expect(s.board.hexes.filter((h) => h.well)).toHaveLength(3);
    expect(s.bank.oil).toBe(OIL_SUPPLY);
    expect(s.robberHex).toBeNull();
    expect(oilOf(s)).toMatchObject({ track: 0, steward: null, destroyed: 0, lost: [], sequestered: [0, 0, 0, 0] });
  });

  it('leaves the base game alone', () => {
    const s = createGame(setups(4), { seed: 3, layout: 'random' }).state;
    expect(s.board.hexes.some((h) => h.well)).toBe(false);
    expect(s.robberHex).toBe(s.board.desertHex);
    expect(s.bank.oil).toBe(0);
    expect(s.ext.oil).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

/** A well with a resource of its own, the only well bearing its number, with the robber away. */
function wellScene(seed = 3) {
  const base = ready(seed);
  const well = base.board.hexes.find((h) => h.well && h.terrain !== 'desert')!;
  const n = well.numbers[0];
  const s = patch(base, (x) => {
    for (const h of x.board.hexes) if (h.well && h.id !== well.id) delete h.well;
    x.phase = 'roll';
    x.hasRolled = false;
  });
  return { s, well: s.board.hexes[well.id], n };
}

describe('oil production', () => {
  it('gives a settlement 1, a city 2 and a foundry 3, with the hex’s own resource (a foundry takes one more)', () => {
    const { s: s0, well, n } = wellScene();
    const [a, b, c] = [well.vertices[0], well.vertices[2], well.vertices[4]];
    const s = patch(s0, (x) => {
      put(x, a, 1, 'settlement');
      put(x, b, 2, 'city');
      put(x, c, 3, 'city', { foundry: true });
      x.rngState = seedFor(n);
    });
    const { state, events } = act(s, 0, { type: 'rollDice' });
    expect([1, 2, 3].map((p) => state.players[p].hand.oil)).toEqual([1, 2, 3]);
    expect(state.bank.oil).toBe(OIL_SUPPLY - 6);
    const prod = ofType(events, 'production')[0];
    const fromWell = (v: number) => prod.grants.filter((g) => g.hex === well.id && g.vertex === v).reduce((k, g) => k + g.amount, 0);
    expect([fromWell(a), fromWell(b), fromWell(c)]).toEqual([1, 2, 3]);
    expect(ofType(events, 'oil/produced')[0].grants.map((g) => [g.player, g.amount])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('hands oil out one at a time from the roller, clockwise, while the supply lasts', () => {
    const { s: s0, well, n } = wellScene();
    const s = patch(s0, (x) => {
      x.currentPlayer = 2;
      put(x, well.vertices[0], 1, 'city');
      put(x, well.vertices[3], 3, 'city');
      // Only three oil left: the roller's left-hand neighbour (3) gets the first and third.
      drain(x, OIL_SUPPLY - 3);
      x.rngState = seedFor(n);
    });
    const { state, events } = act(s, 2, { type: 'rollDice' });
    expect(state.players[3].hand.oil).toBe(2);
    expect(state.players[1].hand.oil).toBe(1);
    expect(state.bank.oil).toBe(0);
    expect(ofType(events, 'oil/produced')[0].short).toBe(true);
  });

  it('never takes a player past 4: the rest stays in the supply', () => {
    const { s: s0, well, n } = wellScene();
    const s = patch(s0, (x) => {
      put(x, well.vertices[0], 1, 'city', { foundry: true });
      grant(x, 1, { oil: 3 });
      x.rngState = seedFor(n);
    });
    const { state, events } = act(s, 0, { type: 'rollDice' });
    expect(state.players[1].hand.oil).toBe(OIL_LIMIT);
    expect(state.bank.oil).toBe(OIL_SUPPLY - 4);
    expect(ofType(events, 'oil/produced')[0].short).toBe(false);
  });

  it('the robber on a well stops its oil', () => {
    const { s: s0, well, n } = wellScene();
    const s = patch(s0, (x) => {
      put(x, well.vertices[0], 1, 'city');
      x.robberHex = well.id;
      x.rngState = seedFor(n);
    });
    const { state, events } = act(s, 0, { type: 'rollDice' });
    expect(state.players[1].hand.oil).toBe(0);
    expect(ofType(events, 'oil/produced')).toHaveLength(0);
  });

  it('the desert well produces oil only', () => {
    const base = ready();
    const desert = base.board.hexes.find((h) => h.terrain === 'desert')!;
    const s = patch(base, (x) => {
      for (const h of x.board.hexes) if (h.well && h.id !== desert.id) delete h.well;
      x.phase = 'roll';
      x.hasRolled = false;
      put(x, desert.vertices[1], 2, 'settlement');
      x.rngState = seedFor(desert.numbers[0]);
    });
    const { state, events } = act(s, 0, { type: 'rollDice' });
    expect(state.players[2].hand.oil).toBe(1);
    expect(ofType(events, 'production')[0]?.grants.some((g) => g.hex === desert.id) ?? false).toBe(false);
  });

  it('a polluted number no longer produces', () => {
    const { s: s0, well, n } = wellScene();
    const s = patch(s0, (x) => {
      put(x, well.vertices[0], 1, 'city');
      oilOf(x).lost.push({ hex: well.id, number: n });
      x.rngState = seedFor(n);
    });
    expect(numbersOf(s, s.board.hexes[well.id])).toEqual([]);
    const { state } = act(s, 0, { type: 'rollDice' });
    expect(state.players[1].hand.oil).toBe(0);
  });

  it('a set-up building beside a well takes one oil', () => {
    let s = oilGame(5);
    const well = s.board.hexes.find((h) => h.well && h.terrain !== 'desert')!;
    // Play the first round anywhere away from the well, then the second-round settlement on it.
    while (s.setupRound === 1 || s.phase === 'setupRoad') {
      const acts = legalActions(s, s.currentPlayer);
      const pick = acts.find((a) => a.type !== 'placeSetupSettlement' || !well.vertices.includes(a.vertex)) ?? acts[0];
      s = act(s, s.currentPlayer, pick).state;
    }
    const p = s.currentPlayer;
    const v = well.vertices.find((x) => offered(s, p, { type: 'placeSetupSettlement', vertex: x }))!;
    const { state, events } = act(s, p, { type: 'placeSetupSettlement', vertex: v });
    const wells = s.board.vertices[v].hexes.filter((h) => s.board.hexes[h].well).length;
    expect(state.players[p].hand.oil).toBe(wells);
    expect(ofType(events, 'oil/startingOil')[0]).toMatchObject({ player: p, vertex: v, amount: wells });
  });
});

// ---------------------------------------------------------------------------
// Holding oil
// ---------------------------------------------------------------------------

describe('oil where it meets the other modules', () => {
  it('with Sea Lanes, the corsair waits beside the board with the robber until the first 7 (rule 4)', () => {
    const s = createGame(setups(4), { seed: 3, map: 'archipelago', modules: ['sea', 'oil'], victoryPoints: 16 }).state;
    expect([s.robberHex, s.ext.sea!.corsair]).toEqual([null, null]);
  });

  /** A well bearing 8, the only one, with a city of player 1's on it; the Almanac's card for `happening` on 8 on top. */
  function almanacWell(happening: 'sickness' | 'fairDay') {
    const base = ready(3, { modules: ['oil', 'almanac'] });
    const well = base.board.hexes.find((h) => h.well && h.terrain !== 'desert')!;
    const card = HAPPENINGS.findIndex((h, c) => h === happening && cardDice(c)[0] + cardDice(c)[1] === 8);
    return patch(base, (x) => {
      for (const h of x.board.hexes) if (h.well && h.id !== well.id) delete h.well;
      x.board.hexes[well.id].numbers = [8];
      put(x, well.vertices[0], 1, 'city');
      x.phase = 'roll';
      x.hasRolled = false;
      const deck = x.ext.almanac!.deck;
      const i = deck.indexOf(card);
      [deck[i], deck[deck.length - 1]] = [deck[deck.length - 1], deck[i]];
    });
  }

  it('a sickness lets a city take only one oil from a well', () => {
    const oilOn = (happening: 'sickness' | 'fairDay') => ofType(act(almanacWell(happening), 0, { type: 'rollDice' }).events, 'oil/produced')[0].grants.map((g) => [g.player, g.amount]);
    expect(oilOn('fairDay')).toEqual([[1, 2]]);
    expect(oilOn('sickness')).toEqual([[1, 1]]);
  });

  it('oil counts as cards received: a Learning 3 player who took only oil owes no pick', () => {
    const base = ready(3, { modules: ['guilds', 'oil'] });
    const well = base.board.hexes.find((h) => h.well && h.terrain !== 'desert')!;
    const n = well.numbers[0];
    const s = patch(base, (x) => {
      // The well as an oil swamp (oil and nothing else), the only hex bearing its number.
      x.board.hexes[well.id].terrain = 'swamp';
      for (const h of x.board.hexes) if (h.id !== well.id) h.numbers = h.numbers.filter((k) => k !== n);
      put(x, well.vertices[0], 1, 'settlement');
      setLevel(x, 1, 'learning', 3);
      setLevel(x, 2, 'learning', 3);
      x.phase = 'roll';
      x.hasRolled = false;
    });
    const { state } = rollAs(s, 0, { total: n });
    expect(state.players[1].hand.oil).toBe(1);
    expect(state.pending.filter((p) => p.kind === 'guilds/pick').map((p) => p.players)).toEqual([[2]]);
  });
});

describe('holding oil', () => {
  it('the bank neither sells nor buys oil', () => {
    const s = patch(ready(), (x) => grant(x, 0, { oil: 4, wool: 4 }));
    expect(refused(s, 0, { type: 'bankTrade', give: 'wool', get: 'oil' })).toMatch(/never sells oil/);
    expect(refused(s, 0, { type: 'bankTrade', give: 'oil', get: 'wool' })).toMatch(/does not take oil/);
    expect(legalActions(s, 0).some((a) => a.type === 'bankTrade' && (a.give === 'oil' || a.get === 'oil'))).toBe(false);
  });

  it('refuses a trade that would take a player past 4 oil', () => {
    let s = patch(ready(), (x) => {
      grant(x, 0, { oil: 4, wool: 1 });
      grant(x, 1, { oil: 1 });
    });
    s = act(s, 0, { type: 'offerTrade', give: rc({ wool: 1 }), get: rc({ oil: 1 }) }).state;
    s = act(s, 1, { type: 'respondTrade', accept: true }).state;
    expect(offered(s, 0, { type: 'acceptTrade', partner: 1 })).toBe(false);
    expect(refused(s, 0, { type: 'acceptTrade', partner: 1 })).toMatch(/more oil/);
    // With room it goes through.
    s = patch(s, (x) => {
      x.players[0].hand.oil--;
      x.bank.oil++;
    });
    expect(offered(s, 0, { type: 'acceptTrade', partner: 1 })).toBe(true);
    expect(act(s, 0, { type: 'acceptTrade', partner: 1 }).state.players[0].hand.oil).toBe(4);
  });

  it('counts oil toward the hand on a 7, and lets it be discarded', () => {
    const s = patch(ready(), (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
      grant(x, 1, { oil: 4, wool: 4 });
      x.rngState = seedFor(7);
    });
    let r = act(s, 0, { type: 'rollDice' });
    expect(r.state.pendingDiscards[1]).toBe(4);
    r = act(r.state, 1, { type: 'discard', resources: rc({ oil: 2, wool: 2 }) });
    expect(r.state.players[1].hand.oil).toBe(2);
    expect(r.state.bank.oil).toBe(OIL_SUPPLY - 2);
  });
});

// ---------------------------------------------------------------------------
// Theft
// ---------------------------------------------------------------------------

describe('taking oil by name', () => {
  function robberScene(thiefOil = 0) {
    const base = ready();
    const hex = base.board.hexes.find((h) => !h.well && h.numbers.length > 0)!;
    const s = patch(base, (x) => {
      x.phase = 'moveRobber';
      x.resumePhase = 'main';
      put(x, hex.vertices[0], 1, 'settlement');
      grant(x, 1, { oil: 2 });
      grant(x, 0, { oil: thiefOil });
    });
    return { s, hex };
  }

  it('moving the robber beside a player with oil lets the thief name one, even a lone victim', () => {
    const { s, hex } = robberScene();
    const moved = act(s, 0, { type: 'moveRobber', hex: hex.id }).state;
    // (They hold nothing a random theft could take, so naming the oil is the only theft.)
    expect(moved.phase).toBe('steal');
    expect(legalActions(moved, 0)).toEqual([{ type: 'steal', victim: 1, oil: true }]);
    const { state, events } = act(moved, 0, { type: 'steal', victim: 1, oil: true });
    expect([state.players[0].hand.oil, state.players[1].hand.oil]).toEqual([1, 1]);
    expect(state.phase).toBe('main');
    expect(ofType(events, 'stolen')[0]).toMatchObject({ thief: 0, victim: 1, resource: 'oil' });
  });

  it('only with room for it', () => {
    const { s, hex } = robberScene(4);
    const { state, events } = act(s, 0, { type: 'moveRobber', hex: hex.id });
    expect(state.players[1].hand.oil).toBe(2);
    expect(ofType(events, 'nothingToSteal')).toHaveLength(1);
  });

  it('a random theft never takes oil', () => {
    const { s, hex } = robberScene();
    const both = patch(s, (x) => grant(x, 1, { wool: 1 }));
    const moved = act(both, 0, { type: 'moveRobber', hex: hex.id }).state;
    const { state } = act(moved, 0, { type: 'steal', victim: 1 });
    expect([state.players[1].hand.oil, state.players[1].hand.wool]).toEqual([2, 0]);
  });

  it('not from a player with no oil', () => {
    const { s, hex } = robberScene();
    const moved = act(s, 0, { type: 'moveRobber', hex: hex.id }).state;
    expect(refused(moved, 0, { type: 'steal', victim: 2, oil: true })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Burning, foundries, sequestering
// ---------------------------------------------------------------------------

describe('burning oil', () => {
  it('buys two of one resource, returns the oil to the supply and moves the track', () => {
    const s = patch(ready(), (x) => grant(x, 0, { oil: 2 }));
    expect(RESOURCESOffered(s)).toBe(5);
    const { state, events } = act(s, 0, { type: 'oil/burn', get: 'ore' });
    expect(state.players[0].hand).toMatchObject({ oil: 1, ore: 2 });
    expect(state.bank.oil).toBe(OIL_SUPPLY - 1);
    expect(oilOf(state).track).toBe(1);
    expect(ofType(events, 'oil/burned')[0]).toMatchObject({ player: 0, get: 'ore', track: 1 });
  });

  it('never takes the track past 5', () => {
    const s = patch(ready(), (x) => {
      grant(x, 0, { oil: 2 });
      oilOf(x).track = 4;
    });
    const r = act(s, 0, { type: 'oil/burn', get: 'ore' });
    expect(oilOf(r.state).track).toBe(5);
    expect(refused(r.state, 0, { type: 'oil/burn', get: 'ore' })).toMatch(/track is full/);
    expect(RESOURCESOffered(r.state)).toBe(0);
  });

  it('only after rolling, on your own turn, with two in the supply', () => {
    const s = patch(ready(), (x) => grant(x, 0, { oil: 2 }));
    expect(refused(patch(s, (x) => (x.phase = 'roll')), 0, { type: 'oil/burn', get: 'ore' })).toMatch(/after rolling/);
    expect(refused(s, 1, { type: 'oil/burn', get: 'ore' })).toMatch(/after rolling/);
    expect(refused(patch(s, (x) => grant(x, 3, { ore: 18 })), 0, { type: 'oil/burn', get: 'ore' })).toMatch(/fewer than 2/);
    expect(refused(s, 0, { type: 'oil/burn', get: 'oil' as never })).toMatch(/buys a resource/);
  });
});

function RESOURCESOffered(s: GameState): number {
  return legalActions(s, s.currentPlayer).filter((a) => a.type === 'oil/burn').length;
}

describe('foundries', () => {
  function foundryScene(opts: Partial<GameOptions> = {}) {
    const base = ready(3, opts);
    const v = base.board.vertices.find((x) => !isCoastal(base, x.id))!.id;
    const s = patch(base, (x) => {
      put(x, v, 0, 'city');
      grant(x, 0, { brick: 1, wheat: 1, ore: 1, oil: 2 });
    });
    return { s, v };
  }

  it('costs a brick, a wheat, an ore and two oil, is worth 3 and moves the track 2', () => {
    const { s, v } = foundryScene();
    expect(offered(s, 0, { type: 'oil/foundry', vertex: v })).toBe(true);
    const before = totalVictoryPoints(s, 0);
    const { state } = act(s, 0, { type: 'oil/foundry', vertex: v });
    expect(state.buildings[v]).toMatchObject({ kind: 'city', foundry: true });
    expect(buildingWorth(state, v)).toBe(3);
    expect(totalVictoryPoints(state, 0)).toBe(before + 1);
    expect(state.players[0].hand).toMatchObject({ brick: 0, wheat: 0, ore: 0, oil: 0 });
    expect(state.bank.oil).toBe(OIL_SUPPLY);
    expect(oilOf(state).track).toBe(2);
  });

  it('not when it would take the track past 5', () => {
    const { s, v } = foundryScene();
    const full = patch(s, (x) => (oilOf(x).track = 4));
    expect(offered(full, 0, { type: 'oil/foundry', vertex: v })).toBe(false);
    expect(refused(full, 0, { type: 'oil/foundry', vertex: v })).toMatch(/past 5/);
    expect(oilOf(act(patch(s, (x) => (oilOf(x).track = 3)), 0, { type: 'oil/foundry', vertex: v }).state).track).toBe(5);
  });

  it('only under a city, and a city holds a seat or a foundry unless upgrades may stack', () => {
    const { s, v } = foundryScene();
    expect(refused(patch(s, (x) => (x.buildings[v]!.kind = 'settlement')), 0, { type: 'oil/foundry', vertex: v })).toMatch(/one of your towns/);
    const seated = patch(s, (x) => (x.buildings[v]!.seat = 'learning'));
    expect(refused(seated, 0, { type: 'oil/foundry', vertex: v })).toMatch(/seat or a foundry/);
    const stacked = foundryScene({ knobs: { stackUpgrades: true } });
    const both = patch(stacked.s, (x) => (x.buildings[stacked.v]!.seat = 'learning'));
    expect(act(both, 0, { type: 'oil/foundry', vertex: stacked.v }).state.buildings[stacked.v]).toMatchObject({ seat: 'learning', foundry: true });
  });

  it('four foundries in the game', () => {
    const { s, v } = foundryScene();
    const others = s.board.vertices.filter((x) => x.id !== v && !s.buildings[x.id]).slice(0, FOUNDRIES);
    const full = patch(s, (x) => others.forEach((o, i) => put(x, o.id, 1 + (i % 3), 'city', { foundry: true })));
    expect(refused(full, 0, { type: 'oil/foundry', vertex: v })).toMatch(/Every foundry/);
  });
});

describe('sequestering', () => {
  it('one oil a turn, out of the game for good', () => {
    const s = patch(ready(), (x) => grant(x, 0, { oil: 3 }));
    const { state } = act(s, 0, { type: 'oil/sequester' });
    expect(state.players[0].hand.oil).toBe(2);
    expect(state.bank.oil).toBe(OIL_SUPPLY - 3);
    expect(oilOf(state).sequestered[0]).toBe(1);
    expect(refused(state, 0, { type: 'oil/sequester' })).toMatch(/One oil a turn/);
    expect(offered(state, 0, { type: 'oil/sequester' })).toBe(false);
  });

  it('not in a turn you used oil, and no oil used after it', () => {
    const s = patch(ready(), (x) => grant(x, 0, { oil: 3 }));
    const burned = act(s, 0, { type: 'oil/burn', get: 'wool' }).state;
    expect(refused(burned, 0, { type: 'oil/sequester' })).toMatch(/used oil this turn/);
    const kept = act(s, 0, { type: 'oil/sequester' }).state;
    expect(refused(kept, 0, { type: 'oil/burn', get: 'wool' })).toMatch(/sequestered oil this turn/);
    // The next turn starts afresh.
    const next = act(burned, 0, { type: 'endTurn' }).state;
    expect(oilOf(next)).toMatchObject({ usedThisTurn: false, sequesteredThisTurn: false });
  });

  it('every three is a point, and the Steward goes to the first to three and to anyone with strictly more', () => {
    let s = patch(ready(), (x) => {
      grant(x, 0, { oil: 1 });
      grant(x, 1, { oil: 2 });
      sequestered(x, [2, 3, 0, 0]);
      oilOf(x).steward = 1;
    });
    const vp1 = totalVictoryPoints(s, 1);
    // Player 0 reaches three: a point, but a tie leaves the Steward where it is.
    s = act(s, 0, { type: 'oil/sequester' }).state;
    expect(oilOf(s).steward).toBe(1);
    expect(totalVictoryPoints(s, 1)).toBe(vp1);
    s = patch(s, (x) => {
      x.currentPlayer = 1;
      oilOf(x).sequesteredThisTurn = false;
    });
    s = act(s, 1, { type: 'oil/sequester' }).state;
    s = patch(s, (x) => {
      x.currentPlayer = 0;
      oilOf(x).sequesteredThisTurn = false;
      sequestered(x, [4, 4, 0, 0]);
      grant(x, 0, { oil: 1 });
    });
    const { state, events } = act(s, 0, { type: 'oil/sequester' });
    expect(oilOf(state).steward).toBe(0);
    expect(ofType(events, 'oil/stewardChanged')[0]).toEqual({ type: 'oil/stewardChanged', from: 1, to: 0 });
    // Five sequestered: one point, and the Steward's.
    expect(oilOf(state).sequestered[0]).toBe(5);
    expect(totalVictoryPoints(state, 0) - totalVictoryPoints(patch(state, (x) => ((oilOf(x).sequestered[0] = 0), (oilOf(x).steward = null))), 0)).toBe(2);
  });

  it('the first to three takes the Steward', () => {
    const s = patch(ready(), (x) => {
      grant(x, 0, { oil: 1 });
      sequestered(x, [2, 1, 0, 0]);
    });
    const { state } = act(s, 0, { type: 'oil/sequester' });
    expect(oilOf(state).steward).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Disasters
// ---------------------------------------------------------------------------

describe('floods', () => {
  /** One building of each sort on the coast, and two inland. */
  function floodScene(opts: Partial<GameOptions> = {}) {
    const base = ready(3, opts);
    const coast = base.board.vertices.filter((v) => isCoastal(base, v.id)).map((v) => v.id);
    const inland = base.board.vertices.filter((v) => !isCoastal(base, v.id)).map((v) => v.id);
    const [settle, city, foundry, walled, seat] = [coast[0], coast[3], coast[6], coast[9], coast[12]];
    const s = patch(base, (x) => {
      put(x, settle, 0, 'settlement');
      put(x, city, 1, 'city');
      put(x, foundry, 2, 'city', { foundry: true });
      put(x, walled, 3, 'city', { wall: true });
      put(x, seat, 3, 'city', { seat: 'commerce' });
      put(x, inland[0], 0, 'settlement');
      put(x, inland[5], 1, 'city');
      oilOf(x).track = 5;
    });
    return { s, settle, city, foundry, walled, seat, inland: [inland[0], inland[5]] };
  }

  it('on the island alone, a 7 hits every coastal building: settlements go, cities drop, foundries, seats and walls stand', () => {
    const sc = floodScene();
    const { state, events } = forcing(sc.s, 0, { type: 'endTurn' }, (ev) => ofType(ev, 'oil/disaster')[0]?.total === 7);
    expect(state.buildings[sc.settle]).toBeNull();
    expect(state.buildings[sc.city]).toEqual({ owner: 1, kind: 'settlement' });
    expect(state.buildings[sc.foundry]).toMatchObject({ kind: 'city', foundry: true });
    expect(state.buildings[sc.walled]).toEqual({ owner: 3, kind: 'city' });
    expect(state.buildings[sc.seat]).toMatchObject({ kind: 'city', seat: 'commerce' });
    for (const v of sc.inland) expect(state.buildings[v]).toEqual(sc.s.buildings[v]);
    expect(state.players[0].settlementsLeft).toBe(sc.s.players[0].settlementsLeft + 1);
    expect([state.players[1].settlementsLeft, state.players[1].citiesLeft]).toEqual([sc.s.players[1].settlementsLeft - 1, sc.s.players[1].citiesLeft + 1]);
    expect(ofType(events, 'oil/flood')[0]).toMatchObject({ island: null, number: null, washed: [sc.settle], dropped: [sc.city], walls: [sc.walled] });
    expect(oilOf(state).track).toBe(0);
    expect(state.currentPlayer).toBe(1);
  });

  it('a city with no settlement piece free lies down, and must be the next one rebuilt', () => {
    const sc = floodScene();
    const s = patch(sc.s, (x) => (x.players[1].settlementsLeft = 0));
    const { state } = forceDirect(s, flood, () => true);
    expect(state.buildings[sc.city]).toEqual({ owner: 1, kind: 'settlement', lying: true });
    expect([state.players[1].settlementsLeft, state.players[1].citiesLeft]).toEqual([0, s.players[1].citiesLeft]);
    // Washed away while lying, it gives back its city piece.
    const again = forceDirect(state, flood, () => true).state;
    expect(again.buildings[sc.city]).toBeNull();
    expect(again.players[1].citiesLeft).toBe(s.players[1].citiesLeft + 1);
  });

  it('with the one-island knob, a second roll picks an island bearing it, and nothing floods if none does', () => {
    const sc = floodScene({ knobs: { floodOneIsland: true } });
    const hit = forceDirect(sc.s, flood, (ev) => ofType(ev, 'oil/flood')[0].island !== null);
    const f = ofType(hit.events, 'oil/flood')[0];
    expect(f.number).not.toBe(7);
    expect(f.island).toBe(0);
    expect(hit.state.buildings[sc.settle]).toBeNull();
    // Take the 2 away: a second roll of 2 finds no island bearing it.
    const two = sc.s.board.hexes.find((h) => h.numbers.includes(2))!;
    const s = patch(sc.s, (x) => oilOf(x).lost.push({ hex: two.id, number: 2 }));
    const dry = forceDirect(s, flood, (ev) => ofType(ev, 'oil/flood')[0].number === 2);
    expect(ofType(dry.events, 'oil/flood')[0]).toMatchObject({ island: null, washed: [], dropped: [] });
    expect(dry.state.buildings[sc.settle]).not.toBeNull();
  });

  it('on a map of several islands, only the chosen island’s coast floods', () => {
    const sc = floodScene();
    // Split the island in two down the middle (q < 0 and the rest).
    const s = patch(sc.s, (x) => {
      const west = x.board.hexes.filter((h) => h.q < 0).map((h) => h.id);
      const east = x.board.hexes.filter((h) => h.q >= 0).map((h) => h.id);
      for (const h of west) x.board.hexes[h].island = 1;
      x.board.islands = [
        { id: 0, hexes: east, home: true },
        { id: 1, hexes: west, home: false },
      ];
    });
    const islandOf = (st: GameState, v: number) => st.board.hexes[st.board.vertices[v].hexes[0]].island;
    for (const isl of [0, 1]) {
      const { state, events } = forceDirect(s, flood, (ev) => ofType(ev, 'oil/flood')[0].island === isl);
      for (const v of [sc.settle, sc.city]) {
        if (islandOf(s, v) === isl) expect(state.buildings[v]).not.toEqual(s.buildings[v]);
        else expect(state.buildings[v]).toEqual(s.buildings[v]);
      }
      expect(ofType(events, 'oil/flood')[0].number).not.toBe(7);
    }
    // The knob set to no overrides the map: every coast floods, on both islands, with no second roll.
    const all = patch(s, (x) => (x.options = { ...x.options, knobs: { ...x.options.knobs, floodOneIsland: false } }));
    const { state, events } = forceDirect(all, flood, () => true);
    expect(ofType(events, 'oil/flood')[0]).toMatchObject({ island: null, number: null });
    for (const v of [sc.settle, sc.city]) expect(state.buildings[v]).not.toEqual(all.buildings[v]);
  });
});

describe('pollution', () => {
  it('takes the rolled number from a hex for good, and it goes on the track', () => {
    const base = patch(ready(), (x) => (oilOf(x).track = 5));
    const { state, events } = forcing(base, 0, { type: 'endTurn' }, (ev, st) => {
      const d = ofType(ev, 'oil/disaster')[0];
      return !!d && d.total !== 7 && ofType(ev, 'oil/polluted').length === 1 && !!st;
    });
    const p = ofType(events, 'oil/polluted')[0];
    expect(numbersOf(state, state.board.hexes[p.hex])).not.toContain(p.number);
    expect(state.board.hexes[p.hex].numbers).toContain(p.number);
    expect(oilOf(state).lost).toEqual([{ hex: p.hex, number: p.number }]);
    expect(p.lost).toBe(1);
    expect(oilOf(state).track).toBe(0);
  });

  it('keeps the robber off a hex that has lost every number, but not off one that still bears one', () => {
    const base = ready();
    const [gone, half] = base.board.hexes.filter((h) => !h.well && h.numbers.length === 1).map((h) => h.id);
    const s = patch(base, (x) => {
      x.robberHex = x.board.desertHex;
      oilOf(x).lost.push({ hex: gone, number: x.board.hexes[gone].numbers[0] });
      // A hex that bore two numbers and lost one still produces on the other.
      x.board.hexes[half].numbers = [x.board.hexes[half].numbers[0], 2];
      oilOf(x).lost.push({ hex: half, number: 2 });
    });
    expect(legalRobberHexes(s)).not.toContain(gone);
    expect(legalRobberHexes(s)).toContain(half);
    const toRoll = patch(s, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
    });
    const seven = rollAs(toRoll, 0, { total: 7 }).state;
    expect(seven.phase).toBe('moveRobber');
    const moves = legalActions(seven, 0).filter((a) => a.type === 'moveRobber').map((a) => (a as { hex: number }).hex);
    expect(moves).toContain(half);
    expect(moves).not.toContain(gone);
    expect(applyAction(seven, 0, { type: 'moveRobber', hex: gone }).ok).toBe(false);

    // With every other land hex destroyed, a 7 leaves the robber where it stands.
    const ruined = patch(s, (x) => {
      x.options = { ...x.options, knobs: { pollutionLimit: 30 } };
      for (const h of x.board.hexes) if (h.id !== x.robberHex) for (const n of numbersOf(x, h)) oilOf(x).lost.push({ hex: h.id, number: n });
      x.phase = 'roll';
      x.hasRolled = false;
    });
    expect(legalRobberHexes(ruined)).toEqual([]);
    const { state, events } = rollAs(ruined, 0, { total: 7 });
    expect(state.robberHex).toBe(s.robberHex);
    expect(state.phase).toBe('main');
    expect(ofType(events, 'nothingToSteal')).toHaveLength(1);
  });

  it('a hex with several numbers loses only the one rolled', () => {
    const base = ready();
    const hex = base.board.hexes.find((h) => !h.well && h.numbers[0] !== 9)!;
    // Leave this hex the only one bearing a 9, alongside its own number.
    const s = patch(base, (x) => {
      for (const h of x.board.hexes) if (h.numbers.includes(9)) oilOf(x).lost.push({ hex: h.id, number: 9 });
      x.board.hexes[hex.id].numbers.push(9);
    });
    const { state } = forceDirect(s, (ctx) => pollute(ctx, 9), () => true);
    expect(numbersOf(state, state.board.hexes[hex.id])).toEqual(hex.numbers);
  });

  it('a polluted well takes three oil out of the game: the supply’s first, then the hands’ from the roller clockwise', () => {
    const base = ready();
    const well = base.board.hexes.find((h) => h.well)!;
    const n = well.numbers[0];
    const s = patch(base, (x) => {
      x.currentPlayer = 2;
      for (const h of x.board.hexes) if (h.id !== well.id && h.numbers.includes(n)) oilOf(x).lost.push({ hex: h.id, number: n });
      drain(x, OIL_SUPPLY - 1 - 4);
      grant(x, 3, { oil: 1 });
      grant(x, 2, { oil: 3 });
    });
    const { state, events } = forceDirect(s, (ctx) => pollute(ctx, n), () => true);
    expect(ofType(events, 'oil/wellPolluted')[0]).toEqual({ type: 'oil/wellPolluted', hex: well.id, fromSupply: 1, fromHands: { 2: 1, 3: 1 } });
    expect([state.players[2].hand.oil, state.players[3].hand.oil]).toEqual([2, 0]);
    expect(oilOf(state).destroyed).toBe(oilOf(s).destroyed + 3);
    expect(numbersOf(state, state.board.hexes[well.id])).toEqual([n]);
    check(state);
  });

  it('with no hex bearing the number, nothing happens', () => {
    const base = ready();
    const s = patch(base, (x) => {
      for (const h of x.board.hexes) if (h.numbers.includes(12)) oilOf(x).lost.push({ hex: h.id, number: 12 });
    });
    const { state, events } = forceDirect(s, (ctx) => pollute(ctx, 12), () => true);
    expect(ofType(events, 'oil/spared')).toEqual([{ type: 'oil/spared', number: 12 }]);
    expect(oilOf(state).lost).toEqual(oilOf(s).lost);
  });

  it('the fifth lost number loses the island: nobody wins, and the Steward is honoured', () => {
    const base = ready();
    const fake = base.board.hexes.filter((h) => !h.well).slice(0, 4);
    const s = patch(base, (x) => {
      for (const h of fake) oilOf(x).lost.push({ hex: h.id, number: h.numbers[0] });
      sequestered(x, [0, 0, 3, 0]);
      oilOf(x).steward = 2;
      oilOf(x).track = 5;
    });
    const { state, events } = forcing(s, 0, { type: 'endTurn' }, (ev) => ofType(ev, 'oil/polluted').length === 1);
    expect(state.phase).toBe('gameOver');
    expect(state.winner).toBeNull();
    expect(ofType(events, 'oil/islandLost')).toEqual([{ type: 'oil/islandLost', steward: 2 }]);
    expect(ofType(events, 'gameLost')).toHaveLength(1);
  });

  it('the pollutionLimit knob moves the end', () => {
    const s = patch(ready(3, { knobs: { pollutionLimit: 1 } }), (x) => (oilOf(x).track = 5));
    const { state } = forcing(s, 0, { type: 'endTurn' }, (ev) => ofType(ev, 'oil/polluted').length === 1);
    expect(state.phase).toBe('gameOver');
    expect(state.winner).toBeNull();
  });

  it('no disaster while the track is below 5', () => {
    const s = patch(ready(), (x) => (oilOf(x).track = 4));
    const { state, events } = act(s, 0, { type: 'endTurn' });
    expect(ofType(events, 'oil/disaster')).toHaveLength(0);
    expect(oilOf(state).track).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------

describe('victory at the end of the turn', () => {
  /** Player 0 one point short of 12, a foundry away, with a coastal settlement. */
  function nearWin(track: number) {
    const base = ready();
    const free = base.board.vertices.map((v) => v.id);
    const coast = free.filter((v) => isCoastal(base, v));
    const inland = free.filter((v) => !isCoastal(base, v));
    const s = patch(base, (x) => {
      for (let i = 0; i < 4; i++) put(x, inland[i * 3], 0, 'city');
      for (let i = 0; i < 2; i++) put(x, inland[i * 3 + 13], 0, 'settlement');
      put(x, coast[0], 0, 'settlement');
      grant(x, 0, { brick: 1, wheat: 1, ore: 1, oil: 2 });
      oilOf(x).track = track;
    });
    expect(totalVictoryPoints(s, 0)).toBe(11);
    return { s, foundryAt: inland[0], coast: coast[0] };
  }

  it('reaching the target mid-turn wins only when the turn ends', () => {
    const { s, foundryAt } = nearWin(0);
    const built = act(s, 0, { type: 'oil/foundry', vertex: foundryAt }).state;
    expect(totalVictoryPoints(built, 0)).toBe(12);
    expect(built.phase).toBe('main');
    const { state } = act(built, 0, { type: 'endTurn' });
    expect(state.phase).toBe('gameOver');
    expect(state.winner).toBe(0);
  });

  it('a flood at the end of the turn can take the win away', () => {
    const { s, foundryAt, coast } = nearWin(3);
    const built = act(s, 0, { type: 'oil/foundry', vertex: foundryAt }).state;
    expect(oilOf(built).track).toBe(5);
    const { state } = forcing(built, 0, { type: 'endTurn' }, (ev) => ofType(ev, 'oil/disaster')[0]?.total === 7);
    expect(state.buildings[coast]).toBeNull();
    expect(totalVictoryPoints(state, 0)).toBe(11);
    expect(state.phase).toBe('roll');
    expect(state.winner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Monopoly and Invention
// ---------------------------------------------------------------------------

describe('Monopoly and Invention for oil', () => {
  const withCard = (type: 'monopoly' | 'invention', oil: number[]) =>
    patch(ready(), (x) => {
      x.players[0].devCards.push({ type, boughtTurn: 1 });
      x.devDeck.splice(x.devDeck.indexOf(type), 1);
      oil.forEach((k, p) => grant(x, p, { oil: k }));
    });

  it('Monopoly takes everyone’s oil when there is room for it', () => {
    const { state } = act(withCard('monopoly', [1, 1, 0, 2]), 0, { type: 'oil/monopoly' });
    expect(state.players.map((p) => p.hand.oil)).toEqual([4, 0, 0, 0]);
    expect(state.devCardPlayedThisTurn).toBe(true);
  });

  it('otherwise one from each in turn, from the next player clockwise, until full', () => {
    // Room for three: one from 1, one from 3, then another from 1.
    const { state, events } = act(withCard('monopoly', [1, 2, 0, 2]), 0, { type: 'oil/monopoly' });
    expect(state.players.map((p) => p.hand.oil)).toEqual([4, 0, 0, 1]);
    expect(ofType(events, 'oil/monopoly')[0].taken).toEqual({ 1: 2, 3: 1 });
  });

  it('Invention takes oil from the supply, within the limit', () => {
    const s = withCard('invention', [3]);
    expect(offered(s, 0, { type: 'oil/invention', cards: ['oil', 'oil'] })).toBe(false);
    expect(refused(s, 0, { type: 'oil/invention', cards: ['oil', 'oil'] })).toMatch(/at most 4 oil/);
    const { state } = act(s, 0, { type: 'oil/invention', cards: ['oil', 'brick'] });
    expect(state.players[0].hand).toMatchObject({ oil: 4, brick: 1 });
    expect(refused(withCard('invention', [0]), 0, { type: 'oil/invention', cards: ['wool', 'brick'] })).toMatch(/Name oil/);
  });

  it('one development card a turn, as ever', () => {
    const s = patch(withCard('monopoly', [0, 1]), (x) => (x.devCardPlayedThisTurn = true));
    expect(refused(s, 0, { type: 'oil/monopoly' })).toMatch(/One development card/);
  });
});

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

describe('the bot', () => {
  it('won’t fill the track when the island’s last number is at stake', () => {
    const s = patch(ready(), (x) => {
      grant(x, 0, { oil: 2 });
      oilOf(x).track = 4;
      for (const h of x.board.hexes.filter((h) => !h.well).slice(0, 4)) oilOf(x).lost.push({ hex: h.id, number: h.numbers[0] });
    });
    const ctx = new BotCtx(s, 0, 'hard', createBotMemory());
    expect(disasterAcceptable(ctx, 1)).toBe(false);
    // With the island safe and nobody's buildings at risk, it will.
    expect(disasterAcceptable(new BotCtx(patch(s, (x) => (oilOf(x).lost = [])), 0, 'hard', createBotMemory()), 1)).toBe(true);
    // An easy bot doesn't count the cost to the island.
    expect(disasterAcceptable(new BotCtx(s, 0, 'easy', createBotMemory()), 1)).toBe(true);
  });
});

const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];
const results: (GameResult & { label: string })[] = [];

function difficultiesFor(g: number, n: number): BotDifficulty[] {
  switch (g % 4) {
    case 0:
      return Array(n).fill('hard');
    case 1:
      return Array(n).fill('normal');
    default:
      return Array.from({ length: n }, (_, i) => DIFFS[(g + i) % 3]);
  }
}

function playMany(label: string, count: number, players: 3 | 4, seedBase: number, opts: Partial<GameOptions> = {}) {
  for (let g = 0; g < count; g++) {
    const res = runBotGame({
      seed: seedBase + g,
      players,
      layout: g % 3 === 0 ? 'beginner' : 'random',
      numberPlacement: g % 2 ? 'balanced' : 'spiral',
      options: { modules: ['oil'], victoryPoints: OIL_TARGET, ...opts },
      supply: oilSupply,
      difficulties: difficultiesFor(g, players),
      crossCheckLegal: g % 5 === 0,
    });
    expect(res.fallbacks).toBe(0);
    results.push({ ...res, label });
  }
}

describe('bot-only games with oil', () => {
  slow('40 four-seat games finish with every invariant intact', () => playMany('4p', 40, 4, 31000), timeout(120_000));
  slow('40 three-seat games finish with every invariant intact', () => playMany('3p', 40, 3, 32000), timeout(120_000));
  slow('20 games with the knobs turned (one-island floods, stacked upgrades, a three-number end)', () =>
    playMany('knobs', 20, 4, 33000, { knobs: { floodOneIsland: true, stackUpgrades: true, pollutionLimit: 3 } }), timeout(120_000));
});

describe('random legal-action fuzzer with oil', () => {
  slow('every enumerated action applies and invariants hold', () => {
    let checked = 0;
    let steps = 0;
    let ended = 0;
    const knobs = [{}, { floodOneIsland: true, stackUpgrades: true }, { pollutionLimit: 2 }];
    for (let g = 0; g < 9; g++) {
      const r = runFuzzGame(41000 + g, g % 3 === 0 ? 3 : 4, g % 2 ? 'random' : 'beginner', 700, true, { modules: ['oil'], victoryPoints: OIL_TARGET, knobs: knobs[g % 3] }, oilSupply);
      checked += r.checkedActions;
      steps += r.steps;
      if (r.finished) ended++;
    }
    for (let g = 0; g < 12; g++) {
      const r = runFuzzGame(42000 + g, g % 3 === 0 ? 3 : 4, 'random', 2500, false, { modules: ['oil'], victoryPoints: OIL_TARGET, knobs: knobs[g % 3] }, oilSupply);
      steps += r.steps;
      if (r.finished) ended++;
    }
    console.log(`oil fuzz: ${steps} steps, ${checked} legal actions verified, ${ended} of 21 games ended`);
    expect(checked).toBeGreaterThan(5000);
  }, timeout(120_000));
});

afterAll(() => {
  if (results.length === 0) return;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const lines: string[] = [];
  for (const label of ['4p', '3p', 'knobs']) {
    const rs = results.filter((r) => r.label === label);
    if (rs.length === 0) continue;
    const n = rs[0].players;
    const seatWins = Array(n).fill(0);
    for (const r of rs) if (r.winner !== null) seatWins[r.winner]++;
    const lost = rs.filter((r) => r.winner === null).length;
    lines.push(
      `oil ${label}: ${rs.length} games, avg ${avg(rs.map((r) => r.turns)).toFixed(1)} turns (min ${Math.min(...rs.map((r) => r.turns))}, max ${Math.max(
        ...rs.map((r) => r.turns),
      )}), seat wins ${seatWins.join('/')}, lost by everyone ${lost}, fallbacks ${rs.reduce((k, r) => k + r.fallbacks, 0)}`,
    );
  }
  console.log(lines.join('\n'));
});
