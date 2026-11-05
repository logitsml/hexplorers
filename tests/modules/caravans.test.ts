import { afterAll, describe, expect, it } from 'vitest';
import {
  NUMBER_DISCS,
  PIPS,
  Rng,
  SIDE_DIRS,
  beginnerLayout,
  buildBoard,
  classicSpec,
  type BoardSpec,
  type HexSpec,
  applyAction,
  buildingWorth,
  createGame,
  legalActions,
  legalRobberHexes,
  legalSettlements,
  satisfiesDistanceRule,
  longestRoadFor,
  totalVictoryPoints,
  victoryTarget,
  type Action,
  type CardCounts,
  type GameEvent,
  type GameState,
} from '../../src/engine';
import { botDecide, createBotMemory, type BotDifficulty } from '../../src/engine/ai';
import { caravansOf, growthEdges, placements, wagonAllowed, wagonEdges, addWagon, WAGONS } from '../../src/engine/modules/caravans/trains';
import { bidCards, recentAuction } from '../../src/engine/modules/caravans/auction';
import { ORIGIN_CORNERS, shapeOasis } from '../../src/engine/modules/caravans/map';
import { CARAVANS_TARGET, caravans } from '../../src/engine/modules/caravans';
import { targetFor } from '../../src/engine/presets';
import { FOUR, apply, grant, patch, rc, road, toMain, raidersAt } from '../helpers';
import { checkInvariants, runBotGame, runFuzzGame, type GameResult } from '../sim-harness';
import { games, slow, timeout } from '../tier';

const MODS = { modules: ['caravans' as const], victoryPoints: CARAVANS_TARGET };

function fresh(seed = 7, extra: object = {}): GameState {
  return createGame(FOUR, { layout: 'beginner', seed, ...MODS, ...extra }).state;
}

/** A board with no pieces on it: player 0 in their main phase. */
function bare(seed = 7): GameState {
  return patch(fresh(seed), (s) => {
    s.buildings = s.buildings.map(() => null);
    s.routes = s.routes.map(() => null);
    toMain(s, 0);
  });
}

const oasisOf = (s: GameState) => s.board.features.oasis!;
const otherEnd = (s: GameState, e: number, v: number) => (s.board.edges[e].a === v ? s.board.edges[e].b : s.board.edges[e].a);
const withWagons = (s: GameState, ...edges: number[]) =>
  patch(s, (x) => {
    for (const e of edges) addWagon(x, e);
  });
/** The train's front after its wagons. */
const front = (s: GameState, train: number) => caravansOf(s).trains[train].head;

const ofType = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

describe('the oasis', () => {
  it('takes the desert’s place at the centre, with the three train origins at its upper left, upper right and bottom', () => {
    const s = fresh();
    const oasis = oasisOf(s);
    const hex = s.board.hexes[oasis.hex];
    expect([hex.q, hex.r, hex.terrain, hex.numbers]).toEqual([0, 0, 'oasis', []]);
    expect(s.board.hexes.some((h) => h.terrain === 'desert')).toBe(false);
    expect(oasis.origins).toEqual(ORIGIN_CORNERS.map((c) => hex.vertices[c]));
    expect(ORIGIN_CORNERS).toEqual([5, 1, 3]);
    // Upper left and upper right sit above the centre, the bottom below it.
    const [ul, ur, bottom] = oasis.origins.map((v) => s.board.vertices[v]);
    expect(ul.x).toBeLessThan(hex.x);
    expect(ur.x).toBeGreaterThan(hex.x);
    expect(ul.z).toBeLessThan(hex.z);
    expect(bottom.z).toBeGreaterThan(hex.z);
  });

  it('leaves the rest of a random island as dealt: every terrain and number, no reds touching', () => {
    for (let seed = 1; seed <= games(60, 12); seed++) {
      for (const numberPlacement of ['spiral', 'balanced'] as const) {
        const s = createGame(FOUR, { layout: 'random', numberPlacement, seed, ...MODS }).state;
        const land = s.board.hexes.filter((h) => h.terrain !== 'oasis');
        expect(s.board.hexes.filter((h) => h.terrain === 'oasis').map((h) => [h.q, h.r])).toEqual([[0, 0]]);
        const counts: Record<string, number> = {};
        for (const h of land) counts[h.terrain] = (counts[h.terrain] ?? 0) + 1;
        expect(counts).toEqual({ hills: 3, forest: 4, pasture: 4, fields: 4, mountains: 3 });
        expect(land.flatMap((h) => h.numbers).sort((a, b) => a - b)).toEqual([...NUMBER_DISCS].sort((a, b) => a - b));
        expect(land.every((h) => h.numbers.length === 1)).toBe(true);
        const red = (n: number[]) => n.includes(6) || n.includes(8);
        if (numberPlacement === 'balanced') for (const h of land) if (red(h.numbers)) for (const n of h.neighbors) expect(red(s.board.hexes[n].numbers)).toBe(false);
      }
    }
  });

  describe('shaping the island', () => {
    const near = (spec: BoardSpec, h: HexSpec) => spec.hexes.filter((n) => SIDE_DIRS.some(([dq, dr]) => n.q === h.q + dq && n.r === h.r + dr));
    const red = (h: HexSpec) => h.numbers.some((n) => n === 6 || n === 8);
    const centreOf = (spec: BoardSpec) => spec.hexes.find((h) => h.q === 0 && h.r === 0)!;

    it('moves a red number the swap would leave touching another red to a hex where it can’t', () => {
      // The desert sits beside a red, and the centre holds a 6.
      const spec = classicSpec(beginnerLayout());
      const centre = centreOf(spec);
      const desert = spec.hexes.find((h) => h !== centre && near(spec, h).includes(centre) && !red(h) && near(spec, h).some((n) => n !== centre && red(n)))!;
      [centre.terrain, centre.numbers, desert.terrain, desert.numbers] = [desert.terrain, [6], 'desert', []];
      shapeOasis(spec, new Rng(1));
      expect([centre.terrain, centre.numbers]).toEqual(['oasis', []]);
      expect(red(desert)).toBe(false);
      for (const h of spec.hexes) if (red(h)) expect(near(spec, h).some(red)).toBe(false);
      expect(spec.hexes.flatMap((h) => h.numbers).filter((n) => n === 6)).toHaveLength(3);
    });

    it('without a desert, moves the centre’s number onto the least productive pasture or fields (rule 5)', () => {
      const spec = classicSpec(beginnerLayout());
      const centre = centreOf(spec);
      [centre.terrain, centre.numbers] = ['hills', [11]];
      const pips = (h: HexSpec) => h.numbers.reduce((n, x) => n + PIPS[x], 0);
      const pool = spec.hexes.filter((h) => h.terrain === 'pasture' || h.terrain === 'fields');
      const least = pool.reduce((a, b) => (pips(b) < pips(a) ? b : a));
      const before = [...least.numbers];
      shapeOasis(spec, new Rng(1));
      expect([centre.terrain, centre.numbers]).toEqual(['oasis', []]);
      expect(least.numbers).toEqual([...before, 11]);
    });

    it('never moves the centre’s number back onto the centre', () => {
      // A pasture centre holding the 12 is itself the least productive pasture.
      const spec = classicSpec(beginnerLayout());
      const centre = centreOf(spec);
      [centre.terrain, centre.numbers] = ['pasture', [12]];
      for (const h of spec.hexes) if (h !== centre && (h.terrain === 'pasture' || h.terrain === 'fields') && h.numbers.some((n) => PIPS[n] <= 1)) h.numbers = [5];
      const count = spec.hexes.flatMap((h) => h.numbers).length;
      shapeOasis(spec, new Rng(1));
      expect(centre.numbers).toEqual([]);
      expect(spec.hexes.flatMap((h) => h.numbers)).toHaveLength(count);
      expect(spec.hexes.flatMap((h) => h.numbers)).toContain(12);
    });
  });

  it('keeps the robber beside the board until the first 7 or Knight, which may send it to any land hex', () => {
    const s = fresh();
    expect(s.robberHex).toBeNull();
    const seven = patch(s, (x) => {
      x.currentPlayer = 0;
      x.phase = 'moveRobber';
      x.hasRolled = true;
      x.resumePhase = 'main';
    });
    expect(legalRobberHexes(seven)).toHaveLength(19);
    expect(legalRobberHexes(seven)).toContain(oasisOf(s).hex);
    const after = apply(seven, 0, { type: 'moveRobber', hex: oasisOf(s).hex }).state;
    expect(after.robberHex).toBe(oasisOf(s).hex);
  });

  it('plays to two points more, 12, set by the presets’ formula rather than a hook', () => {
    expect(targetFor(['caravans'])).toBe(CARAVANS_TARGET);
    expect(victoryTarget(fresh(), 0)).toBe(12);
    expect(victoryTarget(createGame(FOUR, { layout: 'beginner', seed: 7, modules: ['caravans'] }).state, 0)).toBe(10);
  });
});

describe('trains', () => {
  it('start only at the origins, their first wagon facing away from the oasis', () => {
    const s = bare();
    const where = placements(s);
    const ring = new Set(s.board.hexes[oasisOf(s).hex].edges);
    expect(where).toHaveLength(3);
    oasisOf(s).origins.forEach((o, i) => {
      expect(s.board.vertices[o].edges).toContain(where[i]);
      expect(ring.has(where[i])).toBe(false);
    });
    expect(caravansOf(s).supply).toBe(WAGONS);
  });

  it('grow from the front, nose to tail, and never branch', () => {
    const s0 = bare();
    const o = oasisOf(s0).origins[0];
    const first = placements(s0)[0];
    const s1 = withWagons(s0, first);
    const head = otherEnd(s1, first, o);
    expect(front(s1, 0)).toBe(head);
    const next = growthEdges(s1, caravansOf(s1).trains[0]);
    expect(next.sort()).toEqual(s1.board.vertices[head].edges.filter((e) => e !== first).sort());
    // The origin is the tail: nothing grows from it (its other edges are the oasis's anyway).
    expect(placements(s1).filter((e) => s1.board.vertices[o].edges.includes(e))).toEqual([]);
    const s2 = withWagons(s1, next[0]);
    // The middle intersection's free edge is no placement: the train grows only at its new front.
    const spare = s2.board.vertices[head].edges.find((e) => e !== first && e !== next[0])!;
    expect(placements(s2)).not.toContain(spare);
    expect(placements(s2)).toEqual(expect.arrayContaining(growthEdges(s2, caravansOf(s2).trains[0])));
    expect(caravansOf(s2).trains[0].edges).toEqual([first, next[0]]);
    expect(caravansOf(s2).supply).toBe(WAGONS - 2);
  });

  /**
   * Grow train `t` towards intersection `target` by legal placements, along a shortest path
   * through intersections no wagon touches (and none in `avoid`). Returns the state and the last
   * placement's result.
   */
  function steer(s: GameState, t: number, target: number, avoid: number[] = []) {
    let last = { train: -1, joined: false };
    for (let i = 0; i < 16 && front(s, t) !== target; i++) {
      const wagons = wagonEdges(s);
      const head = front(s, t);
      const dist = new Map([[target, 0]]);
      const queue = [target];
      while (queue.length > 0) {
        const v = queue.shift()!;
        for (const e of s.board.vertices[v].edges) {
          const u = otherEnd(s, e, v);
          if (wagons.has(e) || dist.has(u) || avoid.includes(u)) continue;
          if (u !== head && s.board.vertices[u].edges.some((x) => wagons.has(x))) continue;
          dist.set(u, dist.get(v)! + 1);
          queue.push(u);
        }
      }
      const far = (e: number) => dist.get(otherEnd(s, e, head)) ?? Infinity;
      const options = growthEdges(s, caravansOf(s).trains[t]).filter((e) => far(e) < Infinity);
      if (options.length === 0) break;
      const e = options.sort((a, b) => far(a) - far(b))[0];
      s = patch(s, (x) => {
        last = addWagon(x, e);
      });
    }
    return { s, last };
  }

  it('join a train they meet and stop, while the one they met grows on', () => {
    let s = bare();
    s = withWagons(s, placements(s)[0]);
    const middle = front(s, 0);
    s = withWagons(s, growthEdges(s, caravansOf(s).trains[0])[0]);
    const r = steer(s, 1, middle);
    expect(front(r.s, 1)).toBe(middle);
    expect(r.last).toEqual({ train: 1, joined: true });
    expect(growthEdges(r.s, caravansOf(r.s).trains[1])).toEqual([]);
    expect(growthEdges(r.s, caravansOf(r.s).trains[0]).length).toBeGreaterThan(0);
    expect(caravans.invariants!(r.s)).toEqual([]);
  });

  it('stop, both of them, when two fronts meet', () => {
    let s = bare();
    s = withWagons(s, placements(s)[0]);
    s = withWagons(s, growthEdges(s, caravansOf(s).trains[0])[0]);
    const r = steer(s, 1, front(s, 0));
    expect(r.last.joined).toBe(true);
    for (const t of caravansOf(r.s).trains.slice(0, 2)) expect(growthEdges(r.s, t)).toEqual([]);
    expect(caravans.invariants!(r.s)).toEqual([]);
  });

  it('a running train takes a wagon at an origin whose train hasn’t started, and that train never will', () => {
    let s = bare();
    const o2 = oasisOf(s).origins[2];
    const start = placements(s)[2];
    const outer = otherEnd(s, start, o2);
    s = withWagons(s, placements(s)[0]);
    s = steer(s, 0, outer, [o2]).s;
    expect(front(s, 0)).toBe(outer);
    expect(placements(s)).toContain(start);
    s = patch(s, (x) => expect(addWagon(x, start)).toEqual({ train: 0, joined: false }));
    expect(front(s, 0)).toBe(o2);
    expect(growthEdges(s, caravansOf(s).trains[2])).toEqual([]);
    expect(growthEdges(s, caravansOf(s).trains[0]).length).toBeGreaterThan(0);
    expect(caravans.invariants!(s)).toEqual([]);
  });

  it('stop when the front reaches the train itself', () => {
    // Round one of the two hexes beside the first wagon, back to the origin.
    let s = bare();
    const o = oasisOf(s).origins[0];
    const first = placements(s)[0];
    const hex = s.board.edges[first].hexes.find((h) => h !== oasisOf(s).hex)!;
    const ring = s.board.hexes[hex].edges;
    s = withWagons(s, first);
    for (let i = 0; i < 5; i++) {
      const e = growthEdges(s, caravansOf(s).trains[0]).find((x) => ring.includes(x))!;
      expect(e).toBeDefined();
      s = patch(s, (x) => {
        const r = addWagon(x, e);
        if (i === 4) expect(r.joined).toBe(true);
      });
    }
    expect(front(s, 0)).toBe(o);
    expect(growthEdges(s, caravansOf(s).trains[0])).toEqual([]);
    expect(caravans.invariants!(s)).toEqual([]);
  });

  it('keep off unbridged river crossings, and cross on a bridge', () => {
    const s0 = withWagons(bare(), placements(bare())[0]);
    const next = growthEdges(s0, caravansOf(s0).trains[0]);
    const site = next[0];
    // (A river's bridge sites hold only while Rivers is in play.)
    const river = patch(s0, (s) => {
      s.board = { ...s.board, features: { ...s.board.features, rivers: [{ hexes: [], bridgeSites: [site] }] } };
      s.options = { ...s.options, modules: ['rivers', 'caravans'] };
    });
    expect(placements(river)).not.toContain(site);
    const bridged = patch(river, (s) => {
      s.routes[site] = { owner: 1, kind: 'bridge', builtTurn: 0 };
    });
    expect(placements(bridged)).toContain(site);
  });

  it('run over sea edges where the board has sea, ships or not', () => {
    // The island ringed by sea.
    const spec = classicSpec(beginnerLayout());
    for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === 3) spec.hexes.push({ q, r, terrain: 'sea', numbers: [] });
    shapeOasis(spec, new Rng(1));
    const board = buildBoard(spec);
    const s = patch(fresh(), (x) => {
      x.board = board;
      x.buildings = board.vertices.map(() => null);
      x.routes = board.edges.map(() => null);
      x.ext.caravans = { supply: WAGONS, trains: board.features.oasis!.origins.map((o) => ({ origin: o, edges: [], head: o })), owed: false, auction: null, lastAuction: null };
    });
    expect(placements(s)).toHaveLength(3);
    const open = board.edges.find((e) => !e.land)!;
    expect(wagonAllowed(s, open.id, new Set())).toBe(true);
    const shipped = patch(s, (x) => (x.routes[open.id] = { owner: 0, kind: 'ship', builtTurn: 0 }));
    expect(wagonAllowed(shipped, open.id, new Set())).toBe(true);
    expect(wagonAllowed(s, open.id, new Set([open.id]))).toBe(false);
  });

  it('keep off conquered hexes, but wagons already there stay', () => {
    const s0 = withWagons(bare(), placements(bare())[0]);
    const first = caravansOf(s0).trains[0].edges[0];
    const next = growthEdges(s0, caravansOf(s0).trains[0]);
    const hex = s0.board.edges[next[0]].hexes[0];
    const conquered = patch(s0, (s) => {
      s.ext.invasion = raidersAt(s, s.board.hexes.map((h) => (h.id === hex ? 3 : 0)));
    });
    for (const e of placements(conquered)) expect(conquered.board.edges[e].hexes).not.toContain(hex);
    expect(placements(conquered)).not.toContain(next[0]);
    // A wagon beside the conquered hex stays put.
    expect(wagonEdges(conquered).has(first)).toBe(true);
    expect(caravans.invariants!(conquered)).toEqual([]);
  });
});

describe('wagons owed', () => {
  it('a settlement or city placed this turn owes one wagon, auctioned at its end, however many are built', () => {
    // Player 0 can build a settlement at an empty spot beside a road of theirs, and two cities.
    const s = patch(fresh(), (x) => {
      toMain(x, 0);
      grant(x, 0, { brick: 1, wood: 1, wool: 1, wheat: 5, ore: 6 });
      const v = x.board.vertices.find((u) => satisfiesDistanceRule(x, u.id) && u.edges.some((e) => x.routes[e] === null))!;
      x.routes[v.edges.find((e) => x.routes[e] === null)!] = road(0);
      x.players[0].roadsLeft--;
    });
    const spot = legalSettlements(s, 0)[0];
    let r = apply(s, 0, { type: 'buildSettlement', vertex: spot });
    expect(caravansOf(r.state).owed).toBe(true);
    for (const v of r.state.buildings.flatMap((b, i) => (b?.owner === 0 && i !== spot ? [i] : [])).slice(0, 2)) r = apply(r.state, 0, { type: 'buildCity', vertex: v });
    const end = apply(r.state, 0, { type: 'endTurn' });
    expect(ofType(end.events, 'caravans/auctionOpened')).toHaveLength(1);
    expect(end.state.phase).toBe('endOfTurn');
    expect(end.state.pending).toEqual([{ kind: 'caravans/bid', players: [0] }]);
    expect(caravansOf(end.state).owed).toBe(false);
  });

  it('roads alone owe nothing, and the turn passes', () => {
    const s = patch(fresh(), (x) => {
      toMain(x, 0);
      grant(x, 0, { brick: 1, wood: 1 });
    });
    const edge = legalActions(s, 0).find((a): a is Extract<Action, { type: 'buildRoad' }> => a.type === 'buildRoad')!.edge;
    const r = apply(s, 0, { type: 'buildRoad', edge });
    expect(caravansOf(r.state).owed).toBe(false);
    const end = apply(r.state, 0, { type: 'endTurn' });
    expect(ofType(end.events, 'caravans/auctionOpened')).toHaveLength(0);
    expect(end.state.currentPlayer).toBe(1);
  });

  it('taking the building back takes back the wagon', () => {
    const s = patch(fresh(), (x) => {
      toMain(x, 0);
      grant(x, 0, { wheat: 2, ore: 3 });
    });
    const home = s.buildings.findIndex((b) => b?.owner === 0);
    const built = apply(s, 0, { type: 'buildCity', vertex: home }).state;
    expect(caravansOf(built).owed).toBe(true);
    expect(caravansOf(apply(built, 0, { type: 'undo' }).state).owed).toBe(false);
  });

  it('is skipped when no wagon is left, or there is nowhere to put one', () => {
    const owed = (fn: (s: GameState) => void) =>
      patch(fresh(), (x) => {
        toMain(x, 0);
        caravansOf(x).owed = true;
        fn(x);
      });
    const none = apply(
      owed((x) => (caravansOf(x).supply = 0)),
      0,
      { type: 'endTurn' },
    );
    expect(ofType(none.events, 'caravans/auctionSkipped')).toEqual([{ type: 'caravans/auctionSkipped', player: 0, reason: 'noWagons' }]);
    expect(none.state.currentPlayer).toBe(1);
    const ring = (x: GameState) => x.board.hexes[oasisOf(x).hex].neighbors;
    const blocked = apply(
      owed((x) => (x.ext.invasion = raidersAt(x, x.board.hexes.map((h) => (ring(x).includes(h.id) ? 3 : 0))))),
      0,
      { type: 'endTurn' },
    );
    expect(ofType(blocked.events, 'caravans/auctionSkipped')[0].reason).toBe('nowhere');
    expect(blocked.state.currentPlayer).toBe(1);
  });

});

describe('the auction', () => {
  /** The auction open at the end of player 0's turn, with the given hands. */
  function auction(hands: Record<number, Partial<CardCounts>> = {}, extra: object = {}) {
    const s = patch(fresh(7, extra), (x) => {
      toMain(x, 0);
      for (const p of x.players) for (const r of ['brick', 'wood', 'wool', 'wheat', 'ore'] as const) {
        x.bank[r] += p.hand[r];
        p.hand[r] = 0;
      }
      for (const [p, h] of Object.entries(hands)) grant(x, Number(p), h);
      caravansOf(x).owed = true;
    });
    return apply(s, 0, { type: 'endTurn' }).state;
  }
  const bid = (s: GameState, wool: number, wheat: number, proposal: number): Action => ({ type: 'caravans/bid', cards: bidCards(s, wool, wheat), proposal });
  const pass: Action = { type: 'caravans/pass' };
  /** Apply each seat's action in turn: [player, action]. */
  function run(s: GameState, steps: [number, Action][]) {
    const events: GameEvent[] = [];
    for (const [p, a] of steps) {
      const r = apply(s, p, a);
      events.push(...r.events);
      s = r.state;
      checkInvariants(s, 'auction');
    }
    return { s, events };
  }

  it('asks one seat at a time, from the active player round the table', () => {
    let s = auction({ 1: { wool: 1 } });
    for (const p of [0, 1, 2, 3]) {
      expect(s.pending.at(-1)).toEqual({ kind: 'caravans/bid', players: [p] });
      for (const q of [0, 1, 2, 3]) expect(legalActions(s, q).length > 0).toBe(q === p);
      const acted = [0, 1, 2, 3].filter((q) => botDecide(s, q, createBotMemory(), 'normal') !== null);
      expect(acted).toEqual([p]);
      s = apply(s, p, pass).state;
    }
  });

  it('if nobody bids, the active player places it anywhere', () => {
    const s0 = auction();
    const where = placements(s0);
    const { s, events } = run(s0, [[0, pass], [1, pass], [2, pass], [3, pass]]);
    expect(ofType(events, 'caravans/toPlace')).toEqual([{ type: 'caravans/toPlace', player: 0, choices: null, reason: 'nobodyBid' }]);
    expect(legalActions(s, 0)).toEqual(where.map((edge) => ({ type: 'caravans/place', edge })));
    const done = run(s, [[0, { type: 'caravans/place', edge: where[2] }]]);
    expect(wagonEdges(done.s).has(where[2])).toBe(true);
    expect(ofType(done.events, 'caravans/bidsPaid')).toHaveLength(0);
    // The turn passes once the wagon is down.
    expect(done.s.currentPlayer).toBe(1);
    expect(done.s.phase).toBe('roll');
  });

  it('a bidder holding more than half the votes places it anywhere legal, and every bid goes to the supply', () => {
    const s0 = auction({ 1: { wool: 1 }, 2: { wool: 2, wheat: 1 } });
    const where = placements(s0);
    const bank = { ...s0.bank };
    const { s, events } = run(s0, [
      [0, pass],
      [1, bid(s0, 1, 0, where[0])],
      [2, bid(s0, 2, 1, where[0])],
      [3, pass],
    ]);
    expect(ofType(events, 'caravans/toPlace')).toEqual([{ type: 'caravans/toPlace', player: 2, choices: null, reason: 'majority' }]);
    // Not bound by the proposals.
    const done = run(s, [[2, { type: 'caravans/place', edge: where[1] }]]);
    expect(ofType(done.events, 'caravans/wagonPlaced')[0]).toMatchObject({ edge: where[1], by: 2 });
    expect(done.s.players[1].hand.wool).toBe(0);
    expect(done.s.players[2].hand).toEqual(rc({}));
    expect(done.s.bank.wool).toBe(bank.wool + 3);
    expect(done.s.bank.wheat).toBe(bank.wheat + 1);
  });

  it('keeps how it ended in the state, for the turn after, whoever placed the wagon', () => {
    const s0 = auction({ 1: { wool: 1 }, 2: { wool: 2, wheat: 1 } });
    expect(caravansOf(s0).lastAuction).toBeNull();
    expect(recentAuction(s0)).toBeNull();
    const where = placements(s0);
    const { s } = run(s0, [
      [0, pass],
      [1, bid(s0, 1, 0, where[0])],
      [2, bid(s0, 2, 1, where[0])],
      [3, pass],
      [2, { type: 'caravans/place', edge: where[1] }],
    ]);
    const bids = [
      { player: 1, cards: bidCards(s0, 1, 0), votes: 1 },
      { player: 2, cards: bidCards(s0, 2, 1), votes: 3 },
    ];
    // (The turn passed with the wagon: the record is the builder's turn, and is told for the next.)
    expect(caravansOf(s).lastAuction).toEqual({ turn: s0.turn, edge: where[1], by: 2, bids });
    expect(s.turn).toBe(s0.turn + 1);
    expect(recentAuction(s)).toEqual(caravansOf(s).lastAuction);
    // Seat 1's turn: nothing built, and the turn after it the record is stale.
    const later = patch(s, (x) => {
      x.turn += 1;
    });
    expect(recentAuction(later)).toBeNull();
    // A vote that decides it names nobody.
    const t0 = auction({ 1: { wool: 1 }, 2: { wheat: 1 }, 3: { wool: 1 } });
    const [a, b] = placements(t0);
    const voted = run(t0, [
      [0, pass],
      [1, bid(t0, 1, 0, a)],
      [2, bid(t0, 0, 1, b)],
      [3, bid(t0, 1, 0, a)],
      [1, { type: 'caravans/vote', edge: a }],
      [2, { type: 'caravans/vote', edge: b }],
      [3, { type: 'caravans/vote', edge: a }],
    ]).s;
    expect(caravansOf(voted).lastAuction).toMatchObject({ edge: a, by: null });
    // Nobody bid: the active player places it, and the record has no bids.
    const quiet = run(auction(), [[0, pass], [1, pass], [2, pass], [3, pass], [0, { type: 'caravans/place', edge: placements(auction())[0] }]]).s;
    expect(caravansOf(quiet).lastAuction).toMatchObject({ by: 0, bids: [] });
  });

  it('is told again by a game resumed from its moves (a save replays them and keeps no events)', () => {
    const opts = { layout: 'beginner' as const, seed: 21, ...MODS };
    const crew = FOUR.map((p) => ({ ...p, isBot: true }));
    let s = createGame(crew, opts).state;
    const memories = s.players.map(() => createBotMemory());
    const log: { p: number; a: Action }[] = [];
    // Play on until an auction with bids has closed (the table is shown its result).
    for (let step = 0; step < 4000 && !(recentAuction(s)?.bids.length); step++) {
      const p = [0, 1, 2, 3].find((q) => botDecide(s, q, memories[q], 'normal') !== null);
      if (p === undefined) throw new Error('no seat acted');
      const a = botDecide(s, p, memories[p], 'normal')!;
      s = apply(s, p, a).state;
      log.push({ p, a });
    }
    expect(recentAuction(s)?.bids.length).toBeGreaterThan(0);
    // The resumed game: the same seed and options, the logged moves replayed, through a save's JSON.
    let resumed = createGame(crew, opts).state;
    for (const { p, a } of JSON.parse(JSON.stringify(log)) as typeof log) resumed = apply(resumed, p, a).state;
    expect(recentAuction(resumed)).toEqual(recentAuction(s));
    expect(resumed).toEqual(s);
  });

  it('otherwise the ballots decide: the placement with the most votes', () => {
    const s0 = auction({ 1: { wool: 1 }, 2: { wheat: 1 }, 3: { wool: 1 } });
    const [a, b] = placements(s0);
    const { s, events } = run(s0, [
      [0, pass],
      [1, bid(s0, 1, 0, a)],
      [2, bid(s0, 0, 1, b)],
      [3, bid(s0, 1, 0, a)],
    ]);
    // Only bidders vote, in turn order.
    expect(s.pending.at(-1)).toEqual({ kind: 'caravans/vote', players: [1] });
    expect(legalActions(s, 1)).toEqual([a, b].map((edge) => ({ type: 'caravans/vote', edge })));
    expect(ofType(events, 'caravans/toPlace')).toHaveLength(0);
    const done = run(s, [
      [1, { type: 'caravans/vote', edge: b }],
      [2, { type: 'caravans/vote', edge: b }],
      [3, { type: 'caravans/vote', edge: a }],
    ]);
    expect(ofType(done.events, 'caravans/wagonPlaced')[0]).toMatchObject({ edge: b, by: null });
    expect(done.s.currentPlayer).toBe(1);
  });

  it('on a tie, the bidder with the most votes chooses among the tied placements', () => {
    const s0 = auction({ 1: { wool: 2 }, 2: { wheat: 1 }, 3: { wool: 1 } });
    const [a, b, c] = placements(s0);
    const { s, events } = run(s0, [
      [0, pass],
      [1, bid(s0, 2, 0, a)],
      [2, bid(s0, 0, 1, b)],
      [3, bid(s0, 1, 0, c)],
      [1, { type: 'caravans/vote', edge: a }],
      [2, { type: 'caravans/vote', edge: b }],
      [3, { type: 'caravans/vote', edge: b }],
    ]);
    const tied = [a, b].sort((x, y) => x - y);
    expect(ofType(events, 'caravans/toPlace')).toEqual([{ type: 'caravans/toPlace', player: 1, choices: tied, reason: 'mostVotes' }]);
    expect(applyAction(s, 1, { type: 'caravans/place', edge: c }).ok).toBe(false);
    expect(wagonEdges(run(s, [[1, { type: 'caravans/place', edge: b }]]).s).has(b)).toBe(true);
  });

  it('failing that, the active player chooses, even having bid nothing', () => {
    const s0 = auction({ 1: { wool: 1 }, 2: { wheat: 1 } });
    const [a, b] = placements(s0);
    const { s, events } = run(s0, [
      [0, pass],
      [1, bid(s0, 1, 0, a)],
      [2, bid(s0, 0, 1, b)],
      [3, pass],
      [1, { type: 'caravans/vote', edge: a }],
      [2, { type: 'caravans/vote', edge: b }],
    ]);
    expect(ofType(events, 'caravans/toPlace')).toEqual([{ type: 'caravans/toPlace', player: 0, choices: [a, b].sort((x, y) => x - y), reason: 'activePlayer' }]);
    expect(run(s, [[0, { type: 'caravans/place', edge: a }]]).s.currentPlayer).toBe(1);
  });

  it('needs no ballot when every bid proposed the same placement', () => {
    const s0 = auction({ 1: { wool: 1 }, 2: { wheat: 1 } });
    const where = placements(s0);
    const { s, events } = run(s0, [
      [0, pass],
      [1, bid(s0, 1, 0, where[1])],
      [2, bid(s0, 0, 1, where[1])],
      [3, pass],
    ]);
    expect(ofType(events, 'caravans/wagonPlaced')[0]).toMatchObject({ edge: where[1], by: null });
    expect(s.currentPlayer).toBe(1);
  });

  it('lets a bid go without a proposal, and back someone else’s on the ballot', () => {
    const s0 = auction({ 1: { wool: 1 }, 2: { wheat: 1 }, 3: { wool: 1 } });
    const [a, b] = placements(s0);
    expect(legalActions(s0, 0)).toEqual([{ type: 'caravans/pass' }]);
    const { s } = run(s0, [
      [0, pass],
      [1, bid(s0, 1, 0, a)],
      [2, bid(s0, 0, 1, b)],
      [3, { type: 'caravans/bid', cards: bidCards(s0, 1, 0) }],
    ]);
    expect(legalActions(s, 1)).toEqual([a, b].map((edge) => ({ type: 'caravans/vote', edge })));
    const done = run(s, [
      [1, { type: 'caravans/vote', edge: a }],
      [2, { type: 'caravans/vote', edge: b }],
      [3, { type: 'caravans/vote', edge: b }],
    ]);
    expect(ofType(done.events, 'caravans/wagonPlaced')[0]).toMatchObject({ edge: b, by: null });
  });

  it('with nothing proposed, every legal placement ties: the biggest bidder chooses, or else the active player', () => {
    const s0 = auction({ 1: { wool: 2 }, 2: { wheat: 1 }, 3: { wool: 1 } });
    const where = [...placements(s0)];
    const unproposed = (p: number, wool: number, wheat: number): [number, Action] => [p, { type: 'caravans/bid', cards: bidCards(s0, wool, wheat) }];
    const one = run(s0, [[0, pass], unproposed(1, 2, 0), unproposed(2, 0, 1), unproposed(3, 1, 0)]);
    expect(ofType(one.events, 'caravans/toPlace')).toEqual([{ type: 'caravans/toPlace', player: 1, choices: where, reason: 'mostVotes' }]);
    const two = run(s0, [[0, pass], [1, pass], unproposed(2, 0, 1), unproposed(3, 1, 0)]);
    expect(ofType(two.events, 'caravans/toPlace')).toEqual([{ type: 'caravans/toPlace', player: 0, choices: where, reason: 'activePlayer' }]);
  });

  it('refuses what the auction does not allow', () => {
    const s = auction({ 0: { wool: 1, ore: 2 }, 1: { wool: 1 } });
    const [a] = placements(s);
    const no = (p: number, action: Action) => expect(applyAction(s, p, action).ok).toBe(false);
    no(1, pass); // not their turn to bid
    no(0, bid(s, 2, 0, a)); // more than they hold
    no(0, { type: 'caravans/bid', cards: rc({ ore: 1 }), proposal: a }); // the wrong kind
    no(0, bid(s, 0, 0, a)); // nothing bid
    no(0, bid(s, 1, 0, s.board.hexes[oasisOf(s).hex].edges[0])); // nowhere a wagon may go
    no(0, { type: 'caravans/vote', edge: a });
    no(0, { type: 'caravans/place', edge: a });
    no(0, { type: 'rollDice' });
    expect(applyAction(s, 0, bid(s, 1, 0, a)).ok).toBe(true);
  });

  it('bids brick and wood when the guilds are in play', () => {
    const s = auction({ 0: { wool: 1, brick: 1, wood: 1 } }, { modules: ['guilds', 'caravans'] });
    const [a] = placements(s);
    expect(applyAction(s, 0, { type: 'caravans/bid', cards: rc({ wool: 1 }), proposal: a }).ok).toBe(false);
    expect(applyAction(s, 0, { type: 'caravans/bid', cards: rc({ brick: 1, wood: 1 }), proposal: a }).ok).toBe(true);
    const bids = legalActions(s, 0).filter((x): x is Extract<Action, { type: 'caravans/bid' }> => x.type === 'caravans/bid');
    // Each of the three bids, with each proposal or none.
    expect(bids.length).toBe(3 * (placements(s).length + 1));
    for (const x of bids) expect(x.cards.wool + x.cards.wheat).toBe(0);
  });
});

describe('scoring', () => {
  it('a wagon over a route piece adds 1 to its owner’s route: three roads under two wagons make five', () => {
    const s0 = bare();
    const o = oasisOf(s0).origins[0];
    const first = placements(s0)[0];
    let s = withWagons(s0, first);
    const second = growthEdges(s, caravansOf(s).trains[0])[0];
    s = withWagons(s, second);
    const mid = otherEnd(s, first, o);
    const end = otherEnd(s, second, mid);
    const third = s.board.vertices[end].edges.find((e) => e !== second)!;
    s = patch(s, (x) => {
      for (const e of [first, second, third]) x.routes[e] = road(1);
    });
    expect(longestRoadFor(s, 1)).toBe(5);
    // A bridge under a wagon counts the same, and so does a ship (which joins roads only at a building).
    expect(longestRoadFor(patch(s, (x) => (x.routes[first] = { owner: 1, kind: 'bridge', builtTurn: 0 })), 1)).toBe(5);
    expect(longestRoadFor(patch(s0, (x) => (x.routes[first] = { owner: 2, kind: 'ship', builtTurn: 0 })), 2)).toBe(1);
    expect(longestRoadFor(withWagons(patch(s0, (x) => (x.routes[first] = { owner: 2, kind: 'ship', builtTurn: 0 })), first), 2)).toBe(2);
    // A wagon over someone else's road adds nothing to yours.
    expect(longestRoadFor(patch(s, (x) => (x.routes[third] = road(2))), 2)).toBe(1);
  });

  it('a building between two wagons is worth a point more: a settlement 2, a city 3, unless conquered', () => {
    const s0 = bare();
    const first = placements(s0)[0];
    const s1 = withWagons(s0, first);
    const mid = front(s1, 0);
    const s2 = withWagons(s1, growthEdges(s1, caravansOf(s1).trains[0])[0]);
    const settled = patch(s1, (x) => (x.buildings[mid] = { owner: 1, kind: 'settlement' }));
    expect(buildingWorth(settled, mid)).toBe(1);
    const between = patch(s2, (x) => (x.buildings[mid] = { owner: 1, kind: 'settlement' }));
    expect(buildingWorth(between, mid)).toBe(2);
    expect(buildingWorth(patch(between, (x) => (x.buildings[mid]!.kind = 'city')), mid)).toBe(3);
    const conquered = patch(between, (x) => {
      x.ext.invasion = raidersAt(x, x.board.hexes.map((h) => (x.board.vertices[mid].hexes.includes(h.id) && h.terrain !== 'oasis' ? 3 : 0)));
      x.ext.invasion.raiders[oasisOf(x).hex] = 3;
    });
    expect(buildingWorth(conquered, mid)).toBe(1);
  });

  it('a wagon that brings the active player to the target wins at once; the route award moves at once', () => {
    // Player 0 at 11 with a settlement at a train front: the next wagon there is the twelfth point.
    let s = bare();
    const first = placements(s)[0];
    s = withWagons(s, first);
    const mid = front(s, 0);
    const next = growthEdges(s, caravansOf(s).trains[0])[0];
    s = patch(s, (x) => {
      x.buildings[mid] = { owner: 0, kind: 'settlement' };
      x.players[0].devCards = Array.from({ length: 10 }, () => ({ type: 'victoryPoint', boughtTurn: 0 }));
      x.devDeck.splice(0, 10);
      caravansOf(x).owed = true;
    });
    expect(totalVictoryPoints(s, 0)).toBe(11);
    const r = apply(apply(apply(apply(apply(s, 0, { type: 'endTurn' }).state, 0, { type: 'caravans/pass' }).state, 1, { type: 'caravans/pass' }).state, 2, { type: 'caravans/pass' }).state, 3, {
      type: 'caravans/pass',
    });
    const won = apply(r.state, 0, { type: 'caravans/place', edge: next });
    expect(won.state.phase).toBe('gameOver');
    expect(won.state.winner).toBe(0);
  });
});

describe('the bots at auction', () => {
  /** A bare board with train 0 one wagon out, `owner`'s settlement at its front, and the auction open at the end of player 0's turn. */
  function atFront(owner: number, fn: (s: GameState, mid: number) => void = () => {}) {
    let s = bare();
    s = withWagons(s, placements(s)[0]);
    const mid = front(s, 0);
    s = patch(s, (x) => {
      x.buildings[mid] = { owner, kind: 'settlement' };
      for (const p of [1, 2, 3]) grant(x, p, { wool: 2, wheat: 1 });
      caravansOf(x).owed = true;
      fn(x, mid);
    });
    return { s: apply(s, 0, { type: 'endTurn' }).state, mid };
  }
  const decide = (s: GameState, p: number, d: BotDifficulty = 'hard') => botDecide(s, p, createBotMemory(), d);

  it('bid for a placement that runs a train past their own building', () => {
    const { s: s0, mid } = atFront(1);
    const s = apply(s0, 0, { type: 'caravans/pass' }).state;
    const a = decide(s, 1);
    expect(a?.type).toBe('caravans/bid');
    const proposal = (a as Extract<Action, { type: 'caravans/bid' }>).proposal;
    expect(s.board.vertices[mid].edges).toContain(proposal);
  });

  it('place the wagon where it gives them the point', () => {
    const { s: s0, mid } = atFront(0);
    let s = s0;
    for (const p of [0, 1, 2, 3]) s = apply(s, p, { type: 'caravans/pass' }).state;
    expect(s.pending.at(-1)).toEqual({ kind: 'caravans/place', players: [0] });
    const a = decide(s, 0) as Extract<Action, { type: 'caravans/place' }>;
    expect(a.type).toBe('caravans/place');
    expect(s.board.vertices[mid].edges).toContain(a.edge);
  });

  it('bid against a leader the wagon would help', () => {
    // Player 0 leads by far, with a settlement at the front; player 1 gains nothing either way.
    const { s: s0, mid } = atFront(0, (x, mid) => {
      const far = x.board.vertices.filter((v) => v.hexes.length === 3 && !v.hexes.includes(oasisOf(x).hex) && v.id !== mid);
      let placed = 0;
      for (const v of far) {
        if (placed === 4) break;
        if (!satisfiesDistanceRule(x, v.id) || v.neighbors.includes(mid)) continue;
        x.buildings[v.id] = { owner: 0, kind: 'city' };
        placed++;
      }
    });
    const s = apply(s0, 0, { type: 'caravans/pass' }).state;
    const a = decide(s, 1) as Extract<Action, { type: 'caravans/bid' }>;
    expect(a.type).toBe('caravans/bid');
    expect(s.board.vertices[mid].edges).not.toContain(a.proposal);
  });
});

// ---------------------------------------------------------------------------
// Bots and the fuzzer
// ---------------------------------------------------------------------------

const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];
const results: GameResult[] = [];

function difficultiesFor(g: number, n: number): BotDifficulty[] {
  if (g % 4 === 0) return Array(n).fill('hard');
  if (g % 4 === 1) return Array(n).fill('normal');
  return Array.from({ length: n }, (_, i) => DIFFS[(g + i) % 3]);
}

describe('bot-only games with caravans', () => {
  for (const [n, count, base] of [[4, 30, 41000], [3, 20, 43000]] as const) {
    slow(`${count} ${n}-player games finish with no fall-backs and every invariant intact`, () => {
      for (let g = 0; g < count; g++) {
        const res = runBotGame({
          seed: base + g,
          players: n,
          layout: g % 2 === 0 ? 'beginner' : 'random',
          numberPlacement: g % 4 === 1 ? 'balanced' : 'spiral',
          difficulties: difficultiesFor(g, n),
          options: MODS,
          crossCheckLegal: g % 5 === 0,
        });
        expect(res.winner).not.toBeNull();
        expect(res.fallbacks).toBe(0);
        results.push(res);
      }
    }, timeout(300_000));
  }
});

describe('random legal-action fuzzer with caravans', () => {
  slow('every enumerated action applies and invariants hold', () => {
    let checked = 0;
    let steps = 0;
    for (let g = 0; g < 6; g++) {
      const r = runFuzzGame(47000 + g, g % 3 === 0 ? 3 : 4, g % 2 ? 'random' : 'beginner', 800, true, MODS);
      checked += r.checkedActions;
      steps += r.steps;
    }
    for (let g = 0; g < 8; g++) steps += runFuzzGame(48000 + g, g % 3 === 0 ? 3 : 4, 'random', 3000, false, MODS).steps;
    console.log(`caravans fuzz: ${steps} steps, ${checked} legal actions verified`);
    expect(checked).toBeGreaterThan(5000);
  }, timeout(300_000));
});

afterAll(() => {
  if (results.length === 0) return;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  for (const n of [4, 3]) {
    const rs = results.filter((r) => r.players === n);
    if (rs.length === 0) continue;
    const seatWins = Array(n).fill(0);
    for (const r of rs) seatWins[r.winner!]++;
    console.log(`caravans ${n}p: ${rs.length} games, avg ${avg(rs.map((r) => r.turns)).toFixed(1)} turns, seat wins ${seatWins.join('/')}, fallbacks ${rs.reduce((a, r) => a + r.fallbacks, 0)}`);
  }
});
