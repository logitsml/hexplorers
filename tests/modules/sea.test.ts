// Sea Lanes: the maps, ships, the corsair, bounty fields, First Landing and Fog, then bot games
// and the fuzzer on both maps.

import { afterAll, describe, expect, it } from 'vitest';
import {
  Rng,
  TERRAIN_RESOURCE,
  applyAction,
  canUndo,
  createGame,
  legalActions,
  legalRobberHexes,
  legalSettlements,
  legalSetupSettlements,
  longestRoadFor,
  numbersOf,
  redactState,
  totalCards,
  totalVictoryPoints,
  type Action,
  type GameState,
  type PlayerId,
} from '../../src/engine';
import { MAP_INFO } from '../../src/engine/maps';
import { corsairRaid, offerBlockers, SHIPS } from '../../src/engine/modules/sea';
import { inClosedLine, isHidden, isOpenSea, isLegalShip, legalShips, shipSite } from '../../src/engine/modules/sea/rules';
import { Ctx } from '../../src/engine/ctx';
import { finishRobber } from '../../src/engine/reducer';
import type { BotDifficulty } from '../../src/engine/ai';
import { apply, grant, patch, toMain } from '../helpers';
import { checkInvariants, runBotGame, runFuzzGame, setups, type GameResult } from '../sim-harness';
import { slow, timeout } from '../tier';

const ship = (owner: PlayerId, builtTurn = 0) => ({ owner, kind: 'ship' as const, builtTurn });
const road = (owner: PlayerId) => ({ owner, kind: 'road' as const, builtTurn: 0 });
const PIPS_RED = new Set([6, 8]);

function seaGame(map = 'archipelago', n: 3 | 4 = 4, seed = 1): GameState {
  return createGame(setups(n), { seed, map, modules: ['sea'], victoryPoints: MAP_INFO[map].target }).state;
}

/** A sea map with nothing built, in `player`'s main phase on turn 5. */
function emptySea(map = 'archipelago', n: 3 | 4 = 4, seed = 1, player = 0): GameState {
  return patch(seaGame(map, n, seed), (s) => {
    s.turn = 5;
    s.setupIndex = s.setupOrder.length;
    toMain(s, player);
  });
}

const other = (s: GameState, e: number, v: number) => (s.board.edges[e].a === v ? s.board.edges[e].b : s.board.edges[e].a);
const landHexes = (s: GameState, v: number) => s.board.vertices[v].hexes.filter((h) => s.board.hexes[h].terrain !== 'sea');
const seaHexes = (s: GameState, v: number) => s.board.vertices[v].hexes.filter((h) => s.board.hexes[h].terrain === 'sea');
const home = (s: GameState, v: number) => landHexes(s, v).some((h) => s.board.islands[s.board.hexes[h].island].home);
/** An edge with only sea on both sides. */
const openWater = (s: GameState, e: number) => s.board.edges[e].hexes.every((h) => s.board.hexes[h].terrain === 'sea');

/** A home corner with two land hexes and one sea hex: a coast with a road inland and lanes along the shore. */
function homeCoast(s: GameState): number {
  return s.board.vertices.find((v) => home(s, v.id) && landHexes(s, v.id).length === 2 && seaHexes(s, v.id).length === 1)!.id;
}

/** A home corner with one land hex and two sea hexes: a cape with a lane of open water running out, three edges long and clear of land. */
function homeCape(s: GameState): number {
  const lane = (v: number) => {
    try {
      return walk(s, v, 3, (e) => openWater(s, e), landCorners(s, v)).length === 3;
    } catch {
      return false;
    }
  };
  return s.board.vertices.find((v) => home(s, v.id) && landHexes(s, v.id).length === 1 && seaHexes(s, v.id).length === 2 && lane(v.id))!.id;
}

/** Corners on land other than `v` (a lane of open water keeps clear of them). */
const landCorners = (s: GameState, v: number) => new Set(s.board.vertices.filter((x) => x.land && x.id !== v).map((x) => x.id));

/** A simple path of `k` edges from `start`, each passing `ok`, visiting no corner twice (and none in `avoid`). */
function walk(s: GameState, start: number, k: number, ok: (e: number) => boolean, avoid: Set<number> = new Set()): number[] {
  const seen = new Set([start, ...avoid]);
  const path: number[] = [];
  const rec = (v: number): boolean => {
    if (path.length === k) return true;
    for (const e of s.board.vertices[v].edges) {
      const u = other(s, e, v);
      if (seen.has(u) || !ok(e) || path.includes(e)) continue;
      seen.add(u);
      path.push(e);
      if (rec(u)) return true;
      path.pop();
      seen.delete(u);
    }
    return false;
  };
  if (!rec(start)) throw new Error(`no path of ${k} from ${start}`);
  return path;
}

/** The corner a path ends at. */
function endOf(s: GameState, start: number, path: number[]): number {
  let v = start;
  for (const e of path) v = other(s, e, v);
  return v;
}

/** Make the next roll come up `total` (a state whose dice stream starts with it). */
function rigDice(s: GameState, total: number) {
  for (let k = 1; ; k++) {
    const rng = new Rng(k);
    if (rng.die() + rng.die() === total) {
      s.rngState = k;
      return;
    }
  }
}

const act = (s: GameState, p: PlayerId, a: Action) => applyAction(s, p, a);

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

describe('the archipelago', () => {
  for (const n of [3, 4] as const) {
    it(`${n} seats: a home island, three islets holding two bounty fields, and sea round every coast`, () => {
      for (let seed = 1; seed <= 25; seed++) {
        const s = seaGame('archipelago', n, seed);
        const b = s.board;
        const homes = b.islands.filter((i) => i.home);
        expect(homes).toHaveLength(1);
        expect(homes[0].hexes).toHaveLength(n === 4 ? 19 : 16);
        const islets = b.islands.filter((i) => !i.home);
        expect(islets).toHaveLength(3);
        for (const i of islets) expect(i.hexes.length).toBeGreaterThanOrEqual(2);
        for (const i of islets) expect(i.hexes.length).toBeLessThanOrEqual(4);
        const bounty = b.hexes.filter((h) => h.terrain === 'bounty');
        expect(bounty).toHaveLength(2);
        for (const h of bounty) expect(b.islands[h.island].home).toBe(false);
        // Every land hex has all six neighbours on the board: every coast borders open water.
        for (const h of b.hexes) if (h.terrain !== 'sea') expect(h.neighbors).toHaveLength(6);
        for (const e of b.edges) if (e.coastal) expect(e.sea).toBe(true);
        // The classic mix at home, with its desert and the robber on it.
        const desert = b.hexes.filter((h) => h.terrain === 'desert');
        expect(desert).toHaveLength(1);
        expect(b.islands[desert[0].island].home).toBe(true);
        expect(s.robberHex).toBe(desert[0].id);
        // Numbers: one per producing hex, no reds side by side, none on a bounty field.
        const numbered = b.hexes.filter((h) => h.numbers.length > 0);
        expect(numbered).toHaveLength(n === 4 ? 27 : 22);
        for (const h of numbered) for (const m of h.neighbors) if (PIPS_RED.has(h.numbers[0])) expect(PIPS_RED.has(b.hexes[m].numbers[0])).toBe(false);
        for (const h of bounty) expect(PIPS_RED.has(h.numbers[0])).toBe(false);
        // Nine harbours round the home coast: five 2:1 (one per resource), the rest 3:1, no two sharing a corner.
        expect(b.ports).toHaveLength(9);
        expect(b.ports.filter((p) => p.type !== 'any').map((p) => p.type).sort()).toEqual(['brick', 'ore', 'wheat', 'wood', 'wool']);
        for (const p of b.ports) expect(b.islands[b.hexes[p.hex].island].home).toBe(true);
        const corners = b.ports.flatMap((p) => p.vertices);
        expect(new Set(corners).size).toBe(corners.length);
        for (const p of b.ports) expect(b.edges[p.edge].sea).toBe(true);
        // The corsair on open water; First Landing is the objective.
        expect(b.hexes[s.ext.sea!.corsair!].terrain).toBe('sea');
        expect(b.objectives).toEqual([{ id: 'firstLanding' }]);
      }
    });
  }

  it('is drawn from the seed alone', () => {
    const a = seaGame('archipelago', 4, 9);
    const b = seaGame('archipelago', 4, 9);
    expect(JSON.stringify(a.board)).toBe(JSON.stringify(b.board));
    expect(JSON.stringify(seaGame('archipelago', 4, 10).board)).not.toBe(JSON.stringify(a.board));
  });
});

describe('the fog maps', () => {
  const FOG = { fogBank: 15, lostSea: 12 };
  for (const [map, count] of Object.entries(FOG)) {
    for (const n of [3, 4] as const) {
      it(`${MAP_INFO[map].name}, ${n} seats: one home island, ${count} face-down hexes off it, and its own stack`, () => {
        for (let seed = 1; seed <= 10; seed++) {
          const s = seaGame(map, n, seed);
          const b = s.board;
          const fog = s.ext.sea!.fog!;
          expect(fog.hidden).toHaveLength(count);
          expect(b.objectives!.find((o) => o.id === 'fog')!.hexes).toEqual(fog.hidden);
          // A sea tile in six, two bounty fields and the rest land, with a disc in the pool for every land hex.
          const down = fog.hidden.map((h) => b.hexes[h].terrain);
          expect(down.filter((t) => t === 'sea')).toHaveLength(Math.round(count / 6));
          expect(down.filter((t) => t === 'bounty')).toHaveLength(2);
          for (const h of fog.hidden) expect(b.hexes[h].numbers).toEqual([]);
          expect(fog.pool).toHaveLength(down.filter((t) => t !== 'sea').length);
          // One home island, which no face-down hex touches.
          const homes = b.islands.filter((i) => i.home);
          expect(homes).toHaveLength(1);
          for (const h of homes[0].hexes) for (const m of b.hexes[h].neighbors) expect(fog.hidden).not.toContain(m);
          // The robber on the desert, the corsair at sea, nine harbours with five 2:1.
          expect(b.hexes[s.robberHex!].terrain).toBe('desert');
          expect(isOpenSea(s, s.ext.sea!.corsair!)).toBe(true);
          expect(b.ports).toHaveLength(9);
          expect(b.ports.filter((p) => p.type !== 'any')).toHaveLength(5);
          for (const p of b.ports) expect(b.edges[p.edge].sea).toBe(true);
        }
      });
    }
  }

  it('starts every player on the home island, and nowhere else', () => {
    const s = seaGame('fogBank', 4, 3);
    const spots = legalSetupSettlements(s);
    expect(spots.length).toBeGreaterThan(0);
    for (const v of spots) expect(home(s, v)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------------

describe('building ships', () => {
  it('costs 1 wood and 1 wool, joins its owner\'s building or ship, and counts toward the 15', () => {
    let s = emptySea();
    const v = homeCape(s);
    const lane = walk(s, v, 2, (e) => openWater(s, e), landCorners(s, v));
    s = patch(s, (x) => {
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      grant(x, 0, { wood: 2, wool: 2 });
    });
    // Not yet joined: the second edge of the lane.
    expect(act(s, 0, { type: 'sea/buildShip', edge: lane[1] }).ok).toBe(false);
    s = apply(s, 0, { type: 'sea/buildShip', edge: lane[0] }).state;
    expect(s.routes[lane[0]]).toMatchObject({ owner: 0, kind: 'ship' });
    expect(s.players[0].hand.wood).toBe(1);
    expect(s.players[0].hand.wool).toBe(1);
    expect(s.ext.sea!.shipsLeft[0]).toBe(SHIPS - 1);
    // Joined to the ship now.
    s = apply(s, 0, { type: 'sea/buildShip', edge: lane[1] }).state;
    expect(s.ext.sea!.shipsLeft[0]).toBe(SHIPS - 2);
    expect(act(s, 0, { type: 'sea/buildShip', edge: walk(s, endOf(s, v, lane), 1, (e) => !lane.includes(e) && shipSite(s, e))[0] }).ok).toBe(false);
    // With none left in the supply, none can be built.
    const none = patch(s, (x) => {
      x.ext.sea!.shipsLeft[0] = 0;
      grant(x, 0, { wood: 1, wool: 1 });
    });
    expect(legalShips(none, 0)).toEqual([]);
  });

  it('never joins a road, never goes on land, and never runs on past an opponent\'s building', () => {
    const s0 = emptySea();
    const v = homeCoast(s0);
    // A road ending on the coast: no ship may start from its end.
    const coastal = s0.board.vertices[v].edges.find((e) => s0.board.edges[e].coastal)!;
    const w = other(s0, coastal, v);
    let s = patch(s0, (x) => {
      x.routes[coastal] = road(0);
      grant(x, 0, { wood: 3, wool: 3 });
    });
    for (const e of s.board.vertices[w].edges) if (e !== coastal) expect(isLegalShip(s, 0, e)).toBe(false);
    for (const e of s.board.vertices[v].edges) if (e !== coastal) expect(isLegalShip(s, 0, e)).toBe(false);
    // A land edge takes no ship even beside a settlement.
    s = patch(s, (x) => (x.buildings[v] = { owner: 0, kind: 'settlement' }));
    const inland = s.board.vertices[v].edges.find((e) => !s.board.edges[e].sea)!;
    expect(isLegalShip(s, 0, inland)).toBe(false);
    // An opponent's settlement at the end of a ship: the lane stops there.
    const lane = walk(s, v, 2, (e) => s.board.edges[e].sea && e !== coastal);
    const mid = endOf(s, v, [lane[0]]);
    s = patch(s, (x) => {
      x.routes[lane[0]] = ship(0);
      x.buildings[mid] = { owner: 1, kind: 'settlement' };
    });
    expect(isLegalShip(s, 0, lane[1])).toBe(false);
    expect(isLegalShip(patch(s, (x) => (x.buildings[mid] = null)), 0, lane[1])).toBe(true);
  });

  it('keeps off the corsair\'s hex and off bridge sites', () => {
    let s = emptySea();
    const v = homeCoast(s);
    s = patch(s, (x) => (x.buildings[v] = { owner: 0, kind: 'settlement' }));
    const lanes = s.board.vertices[v].edges.filter((e) => s.board.edges[e].sea);
    for (const e of lanes) expect(isLegalShip(s, 0, e)).toBe(true);
    const sea = seaHexes(s, v)[0];
    const corsaired = patch(s, (x) => (x.ext.sea!.corsair = sea));
    for (const e of lanes) expect(isLegalShip(corsaired, 0, e)).toBe(false);
    // (A river's bridge sites hold only while Rivers is in play.)
    const bridged = patch(s, (x) => {
      x.board.features.rivers = [{ hexes: [], bridgeSites: [lanes[0]] }];
      x.options = { ...x.options, modules: ['sea', 'rivers'] };
    });
    expect(isLegalShip(bridged, 0, lanes[0])).toBe(false);
    expect(isLegalShip(bridged, 0, lanes[1])).toBe(true);
  });
});

describe('moving ships', () => {
  /** A settlement on the coast with a lane of three ships out from it, the last with an open end. */
  function lane(): { s: GameState; v: number; ships: number[]; end: number } {
    const s0 = emptySea();
    const v = homeCape(s0);
    const ships = walk(s0, v, 3, (e) => openWater(s0, e), landCorners(s0, v));
    const s = patch(s0, (x) => {
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      for (const e of ships) x.routes[e] = ship(0);
    });
    return { s, v, ships, end: endOf(s, v, ships) };
  }

  it('moves the open-ended ship, once a turn, to anywhere a new ship could go', () => {
    const { s, v, ships } = lane();
    const moves = legalActions(s, 0).filter((a) => a.type === 'sea/moveShip') as { from: number; to: number }[];
    // Only the last ship has an open end.
    expect(new Set(moves.map((m) => m.from))).toEqual(new Set([ships[2]]));
    // It can't go back to where it would join only itself.
    expect(moves.some((m) => m.to === ships[2])).toBe(false);
    const to = s.board.vertices[v].edges.find((e) => s.board.edges[e].sea && !ships.includes(e))!;
    const moved = apply(s, 0, { type: 'sea/moveShip', from: ships[2], to }).state;
    expect(moved.routes[ships[2]]).toBeNull();
    expect(moved.routes[to]).toMatchObject({ owner: 0, kind: 'ship' });
    expect(moved.ext.sea!.shipsLeft[0]).toBe(SHIPS);
    // One move a turn.
    expect(legalActions(moved, 0).some((a) => a.type === 'sea/moveShip')).toBe(false);
    expect(act(moved, 0, { type: 'sea/moveShip', from: ships[1], to: ships[2] }).ok).toBe(false);
  });

  it('never moves a ship built this turn, nor to or from an edge of the corsair\'s hex', () => {
    const { s, ships } = lane();
    const fresh = patch(s, (x) => (x.routes[ships[2]] = ship(0, x.turn)));
    expect(legalActions(fresh, 0).some((a) => a.type === 'sea/moveShip')).toBe(false);
    const sea = s.board.edges[ships[2]].hexes.find((h) => s.board.hexes[h].terrain === 'sea')!;
    const blocked = patch(s, (x) => (x.ext.sea!.corsair = sea));
    expect(legalActions(blocked, 0).some((a) => a.type === 'sea/moveShip')).toBe(false);
    // Elsewhere, the corsair only closes the edges of its own hex to arrivals.
    const target = s.board.hexes.find((h) => h.terrain === 'sea' && !h.edges.includes(ships[2]) && h.edges.some((e) => legalActions(s, 0).some((a) => a.type === 'sea/moveShip' && a.to === e)))!;
    const there = patch(s, (x) => (x.ext.sea!.corsair = target.id));
    for (const a of legalActions(there, 0)) if (a.type === 'sea/moveShip') expect(target.edges).not.toContain(a.to);
  });

  it('never moves a ship in a line joining two of its owner\'s buildings, even through an opponent\'s', () => {
    const { s, v, ships, end } = lane();
    const mid = endOf(s, v, [ships[0]]);
    const closed = patch(s, (x) => {
      x.buildings[end] = { owner: 0, kind: 'settlement' };
      x.buildings[mid] = { owner: 1, kind: 'settlement' };
    });
    for (const e of ships) expect(inClosedLine(closed, 0, e)).toBe(true);
    expect(legalActions(closed, 0).some((a) => a.type === 'sea/moveShip')).toBe(false);
    expect(inClosedLine(s, 0, ships[2])).toBe(false);
  });

  it('never cuts a warden off from its owner\'s routes', () => {
    const { s, ships, end } = lane();
    const guarded = patch(s, (x) => {
      x.wardens = [{ id: 0, owner: 0, rank: 1, mustered: true, vertex: end, edge: null, musteredTurn: 0 }];
    });
    expect(legalActions(guarded, 0).some((a) => a.type === 'sea/moveShip' && a.from === ships[2])).toBe(false);
    // Someone else's warden there doesn't hold the ship.
    const theirs = patch(guarded, (x) => (x.wardens[0].owner = 1));
    expect(legalActions(theirs, 0).some((a) => a.type === 'sea/moveShip' && a.from === ships[2])).toBe(true);
  });
});

describe('Longest Route at sea', () => {
  it('counts ships, and joins roads to ships only at the owner\'s building', () => {
    const s0 = emptySea();
    const v = homeCoast(s0);
    const roads = walk(s0, v, 2, (e) => !s0.board.edges[e].sea);
    const ships = walk(s0, v, 3, (e) => s0.board.edges[e].sea, new Set(roads.map((e) => endOf(s0, v, roads.slice(0, roads.indexOf(e) + 1)))));
    let s = patch(s0, (x) => {
      for (const e of roads) x.routes[e] = road(0);
      for (const e of ships) x.routes[e] = ship(0);
    });
    // Meeting at an empty corner, they don't join.
    expect(longestRoadFor(s, 0)).toBe(3);
    s = patch(s, (x) => (x.buildings[v] = { owner: 0, kind: 'settlement' }));
    expect(longestRoadFor(s, 0)).toBe(5);
    // Someone else's building there doesn't join them either.
    expect(longestRoadFor(patch(s, (x) => (x.buildings[v] = { owner: 1, kind: 'settlement' })), 0)).toBe(3);
    // Five ships in a row take the award when the fifth is built.
    const five = walk(s0, v, 5, (e) => s0.board.edges[e].sea);
    let t = patch(s0, (x) => {
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      for (const e of five.slice(0, 4)) x.routes[e] = ship(0);
      x.ext.sea!.shipsLeft[0] -= 4;
      grant(x, 0, { wood: 1, wool: 1 });
    });
    t = apply(t, 0, { type: 'sea/buildShip', edge: five[4] }).state;
    expect(t.longestRoadHolder).toBe(0);
    expect(t.players[0].longestRoad).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The corsair and the robber
// ---------------------------------------------------------------------------

describe('the corsair', () => {
  /** Player 1 has a ship on a sea hex next to home, and cards; player 0 is about to roll a 7. */
  function sevenReady() {
    const s0 = emptySea();
    const v = homeCoast(s0);
    const sea = seaHexes(s0, v)[0];
    const e = s0.board.hexes[sea].edges.find((x) => s0.board.vertices[s0.board.edges[x].a].edges.includes(x) && s0.board.edges[x].sea)!;
    const s = patch(s0, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
      x.buildings[v] = { owner: 1, kind: 'settlement' };
      x.routes[e] = ship(1);
      x.ext.sea!.shipsLeft[1]--;
      grant(x, 1, { ore: 2 });
      rigDice(x, 7);
    });
    return { s, sea, v };
  }

  it('a 7 leaves the roller the choice of robber or corsair, and the corsair robs a ship owner', () => {
    const { s, sea } = sevenReady();
    const rolled = apply(s, 0, { type: 'rollDice' }).state;
    expect(rolled.pending.at(-1)).toMatchObject({ kind: 'sea/blocker', players: [0] });
    const options = legalActions(rolled, 0);
    expect(options.some((a) => a.type === 'sea/moveRobber')).toBe(true);
    expect(options.some((a) => a.type === 'sea/moveCorsair' && a.hex === sea)).toBe(true);
    // Only sea for the corsair, only land for the robber.
    for (const a of options) {
      if (a.type === 'sea/moveCorsair') expect(rolled.board.hexes[a.hex].terrain).toBe('sea');
      if (a.type === 'sea/moveRobber') expect(rolled.board.hexes[a.hex].terrain).not.toBe('sea');
    }
    expect(legalActions(rolled, 1)).toEqual([]);
    expect(act(rolled, 0, { type: 'moveRobber', hex: legalRobberHexes(rolled)[0] }).ok).toBe(false);
    const r = apply(rolled, 0, { type: 'sea/moveCorsair', hex: sea });
    expect(r.state.ext.sea!.corsair).toBe(sea);
    expect(r.events.some((e) => e.type === 'stolen' && e.victim === 1 && e.thief === 0)).toBe(true);
    expect(totalCards(r.state.players[1].hand)).toBe(1);
    expect(r.state.phase).toBe('main');
    expect(r.state.pending).toEqual([]);
  });

  it('the robber may be chosen instead, and robs as usual; a bounty field can be robbed', () => {
    const { s, v } = sevenReady();
    const rolled = apply(s, 0, { type: 'rollDice' }).state;
    const land = landHexes(rolled, v)[0];
    const r = apply(rolled, 0, { type: 'sea/moveRobber', hex: land });
    expect(r.state.robberHex).toBe(land);
    expect(r.events.some((e) => e.type === 'stolen' && e.victim === 1)).toBe(true);
    expect(legalRobberHexes(rolled).some((h) => rolled.board.hexes[h].terrain === 'bounty')).toBe(true);
  });

  it('a Knight moves either, before or after the roll', () => {
    const { s } = sevenReady();
    const knight = patch(s, (x) => x.players[0].devCards.push({ type: 'knight', boughtTurn: 1 }));
    const played = apply(knight, 0, { type: 'playKnight' }).state;
    expect(played.pending.at(-1)?.kind).toBe('sea/blocker');
    const sea = legalActions(played, 0).find((a) => a.type === 'sea/moveCorsair')!;
    const after = apply(played, 0, sea).state;
    expect(after.phase).toBe('roll');
  });

  it('can be offered alone, robbing anyone (the seam for an invader that takes the robber off)', () => {
    const { s } = sevenReady();
    const ctx = new Ctx(patch(s, (x) => {
      x.routes = x.routes.map(() => null);
      x.ext.sea!.shipsLeft[1] = SHIPS;
      x.hasRolled = true;
      x.resumePhase = 'main';
    }));
    expect(offerBlockers(ctx, 'seven', { robber: false, victims: 'anyone' })).toBe(true);
    const offered = ctx.s;
    expect(offered.pending.at(-1)).toMatchObject({ kind: 'sea/blocker', data: { robber: false, victims: 'anyone' } });
    expect(legalActions(offered, 0).every((a) => a.type === 'sea/moveCorsair')).toBe(true);
    const r = apply(offered, 0, legalActions(offered, 0)[0]);
    expect(r.events.some((e) => e.type === 'stolen' && e.victim === 1)).toBe(true);
    expect(r.state.phase).toBe('main');
  });

  it('corsairRaid moves it and, for an invader\'s 7, robs anyone', () => {
    const { s, sea } = sevenReady();
    const far = s.board.hexes.find((h) => h.terrain === 'sea' && h.id !== sea && !h.edges.some((e) => s.routes[e]))!;
    const ctx = new Ctx(patch(s, (x) => (x.phase = 'main')));
    corsairRaid(ctx, 0, far.id, 'anyone');
    expect(ctx.s.ext.sea!.corsair).toBe(far.id);
    expect(ctx.events.some((e) => e.type === 'stolen' && e.victim === 1)).toBe(true);
    const quiet = new Ctx(patch(s, (x) => (x.phase = 'main')));
    corsairRaid(quiet, 0, far.id, 'ships');
    expect(quiet.events.some((e) => e.type === 'nothingToSteal')).toBe(true);
    finishRobber(quiet);
  });
});

// ---------------------------------------------------------------------------
// Bounty fields, Road Crew, set-up
// ---------------------------------------------------------------------------

describe('bounty fields', () => {
  it('a settlement picks 1 and a city 2 resources of their choice, each owner in turn from the roller', () => {
    const s0 = emptySea('archipelago', 4, 2);
    const field = s0.board.hexes.find((h) => h.terrain === 'bounty' && h.id !== s0.robberHex)!;
    const [a, , c] = field.vertices;
    let s = patch(s0, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
      x.currentPlayer = 2;
      x.buildings[a] = { owner: 1, kind: 'settlement' };
      x.buildings[c] = { owner: 3, kind: 'city' };
      x.players[1].settlementsLeft--;
      x.players[3].citiesLeft--;
      rigDice(x, field.numbers[0]);
    });
    const r = apply(s, 2, { type: 'rollDice' });
    s = r.state;
    expect(r.events).toContainEqual({ type: 'sea/bountyOwed', owed: { 3: 2, 1: 1 }, reason: 'production' });
    // Player 3 sits next after the roller (2), so chooses first.
    expect(s.pending.map((p) => p.players[0])).toEqual([1, 3]);
    expect(legalActions(s, 1)).toEqual([]);
    expect(act(s, 3, { type: 'sea/pickBounty', resources: ['ore'] }).ok).toBe(false);
    expect(act(s, 3, { type: 'sea/pickBounty', resources: ['paper' as never, 'ore'] }).ok).toBe(false);
    expect(act(s, 2, { type: 'buildRoad', edge: 0 }).ok).toBe(false);
    s = apply(s, 3, { type: 'sea/pickBounty', resources: ['ore', 'ore'] }).state;
    expect(s.players[3].hand.ore).toBe(2);
    expect(legalActions(s, 1)).toHaveLength(5);
    s = apply(s, 1, { type: 'sea/pickBounty', resources: ['wool'] }).state;
    expect(s.players[1].hand.wool).toBe(1);
    expect(s.pending).toEqual([]);
    expect(s.phase).toBe('main');
    checkInvariants(s, 'bounty');
  });

  it('take no commodities even with the guilds in play, and nothing under the robber', () => {
    const s0 = createGame(setups(4), { seed: 2, map: 'archipelago', modules: ['sea', 'guilds'] }).state;
    const field = s0.board.hexes.find((h) => h.terrain === 'bounty')!;
    let s = patch(s0, (x) => {
      x.turn = 5;
      x.setupIndex = x.setupOrder.length;
      x.phase = 'roll';
      x.currentPlayer = 0;
      x.buildings[field.vertices[0]] = { owner: 1, kind: 'settlement' };
      rigDice(x, field.numbers[0]);
    });
    const rolled = apply(s, 0, { type: 'rollDice' }).state;
    for (const a of legalActions(rolled, 1)) expect(['brick', 'wood', 'wool', 'wheat', 'ore']).toContain((a as { resources: string[] }).resources[0]);
    expect(act(rolled, 1, { type: 'sea/pickBounty', resources: ['silver' as never] }).ok).toBe(false);
    s = patch(s, (x) => (x.robberHex = field.id));
    expect(apply(s, 0, { type: 'rollDice' }).state.pending).toEqual([]);
  });
});

describe('Road Crew', () => {
  it('builds any two of roads and ships', () => {
    const s0 = emptySea();
    const v = homeCoast(s0);
    let s = patch(s0, (x) => {
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      x.players[0].devCards.push({ type: 'roadBuilding', boughtTurn: 1 });
    });
    s = apply(s, 0, { type: 'playRoadBuilding' }).state;
    expect(s.phase).toBe('roadBuilding');
    const lanes = legalActions(s, 0).filter((a) => a.type === 'sea/placeFreeShip');
    expect(lanes.length).toBeGreaterThan(0);
    expect(legalActions(s, 0).some((a) => a.type === 'skipFreeRoads')).toBe(false);
    s = apply(s, 0, lanes[0]).state;
    expect(s.phase).toBe('roadBuilding');
    const roadAction = legalActions(s, 0).find((a) => a.type === 'placeFreeRoad')!;
    s = apply(s, 0, roadAction).state;
    expect(s.phase).toBe('main');
    expect(s.ext.sea!.shipsLeft[0]).toBe(SHIPS - 1);
    expect(s.players[0].roadsLeft).toBe(14);
    expect(totalCards(s.players[0].hand)).toBe(0);
    // Two ships, with no road left to build.
    let t = patch(s0, (x) => {
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      x.players[0].roadsLeft = 0;
      x.players[0].devCards.push({ type: 'roadBuilding', boughtTurn: 1 });
    });
    t = apply(t, 0, { type: 'playRoadBuilding' }).state;
    t = apply(t, 0, legalActions(t, 0).find((a) => a.type === 'sea/placeFreeShip')!).state;
    t = apply(t, 0, legalActions(t, 0).find((a) => a.type === 'sea/placeFreeShip')!).state;
    expect(t.phase).toBe('main');
    expect(t.ext.sea!.shipsLeft[0]).toBe(SHIPS - 2);
  });
});

describe('set-up', () => {
  it('starts on the home island, and a coastal start may take a ship instead of a road', () => {
    let s = seaGame('archipelago', 4, 4);
    const spots = legalSetupSettlements(s);
    for (const v of spots) expect(home(s, v)).toBe(true);
    const islet = s.board.vertices.find((v) => v.land && !home(s, v.id))!;
    expect(act(s, s.currentPlayer, { type: 'placeSetupSettlement', vertex: islet.id }).ok).toBe(false);
    const p = s.currentPlayer;
    const coast = homeCoast(s);
    s = apply(s, p, { type: 'placeSetupSettlement', vertex: coast }).state;
    const ships = legalActions(s, p).filter((a) => a.type === 'sea/placeSetupShip');
    expect(ships.length).toBeGreaterThan(0);
    for (const a of ships) expect(s.board.edges[(a as { edge: number }).edge].sea).toBe(true);
    s = apply(s, p, ships[0]).state;
    expect(s.routes[(ships[0] as { edge: number }).edge]).toMatchObject({ owner: p, kind: 'ship' });
    expect(s.phase).toBe('setupSettlement');
    expect(s.currentPlayer).not.toBe(p);
    // An inland start takes a road only.
    const inland = s.board.vertices.find((v) => home(s, v.id) && seaHexes(s, v.id).length === 0 && legalSetupSettlements(s).includes(v.id))!;
    s = apply(s, s.currentPlayer, { type: 'placeSetupSettlement', vertex: inland.id }).state;
    expect(legalActions(s, s.currentPlayer).some((a) => a.type === 'sea/placeSetupShip')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// First Landing
// ---------------------------------------------------------------------------

describe('First Landing', () => {
  it('pays 2 for each player\'s first settlement on each islet, once and for good', () => {
    const s0 = emptySea('archipelago', 4, 5);
    const islets = s0.board.islands.filter((i) => !i.home);
    const touch = (v: number) => s0.board.vertices[v].edges.find((e) => s0.board.edges[e].sea && !s0.board.edges[e].land)!;
    // Coastal corners of an islet with a lane of open water running out of them.
    const spots = (island: number) =>
      s0.board.vertices.filter((v) => landHexes(s0, v.id).some((h) => s0.board.hexes[h].island === island) && touch(v.id) !== undefined).map((v) => v.id);
    const [i1, i2] = islets.map((i) => i.id);
    // A ship at two corners of the first islet, apart, and at one of the second.
    const a = spots(i1)[0];
    const b = spots(i1).find((v) => v !== a && !s0.board.vertices[a].neighbors.includes(v) && touch(v) !== touch(a))!;
    const c = spots(i2)[0];
    let s = patch(s0, (x) => {
      for (const v of [a, b, c]) x.routes[touch(v)] = ship(0);
      x.ext.sea!.shipsLeft[0] -= 3;
      grant(x, 0, { brick: 3, wood: 3, wool: 3, wheat: 3 });
    });
    const before = totalVictoryPoints(s, 0);
    let r = apply(s, 0, { type: 'buildSettlement', vertex: a });
    expect(r.events).toContainEqual({ type: 'sea/firstLanding', player: 0, island: i1, vertex: a, points: 2 });
    s = r.state;
    expect(totalVictoryPoints(s, 0)).toBe(before + 3);
    // A second settlement on the same islet earns nothing more.
    r = apply(s, 0, { type: 'buildSettlement', vertex: b });
    expect(r.events.some((e) => e.type === 'sea/firstLanding')).toBe(false);
    s = r.state;
    expect(totalVictoryPoints(s, 0)).toBe(before + 4);
    // Another islet earns it again.
    s = apply(s, 0, { type: 'buildSettlement', vertex: c }).state;
    expect(totalVictoryPoints(s, 0)).toBe(before + 7);
    // Losing the settlements later doesn't take the landings back, and rebuilding doesn't pay twice.
    const lost = patch(s, (x) => {
      x.buildings[a] = null;
      x.buildings[b] = null;
      x.players[0].settlementsLeft += 2;
      grant(x, 0, { brick: 1, wood: 1, wool: 1, wheat: 1 });
    });
    expect(totalVictoryPoints(lost, 0)).toBe(before + 5);
    const again = apply(lost, 0, { type: 'buildSettlement', vertex: a });
    expect(again.events.some((e) => e.type === 'sea/firstLanding')).toBe(false);
    expect(totalVictoryPoints(again.state, 0)).toBe(before + 6);
    // Home earns nothing.
    const h = homeCoast(s0);
    const homeLanding = patch(s0, (x) => {
      x.routes[s0.board.vertices[h].edges[0]] = road(0);
      grant(x, 0, { brick: 1, wood: 1, wool: 1, wheat: 1 });
    });
    expect(apply(homeLanding, 0, { type: 'buildSettlement', vertex: h }).events.some((e) => e.type === 'sea/firstLanding')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fog
// ---------------------------------------------------------------------------

describe('Fog', () => {
  /** A ship of player 0's beside an open-water edge `edge` whose far corner touches a face-down hex of `terrain`. */
  function frontier(terrain: (t: string) => boolean, seed = 1) {
    const s0 = emptySea('fogBank', 4, seed);
    const fog = s0.ext.sea!.fog!;
    for (const e of s0.board.edges) {
      if (!shipSite(s0, e.id)) continue;
      for (const [near, far] of [[e.a, e.b], [e.b, e.a]]) {
        const hidden = s0.board.vertices[far].hexes.filter((h) => fog.hidden.includes(h));
        if (hidden.length !== 1 || !terrain(s0.board.hexes[hidden[0]].terrain)) continue;
        if (s0.board.vertices[near].hexes.some((h) => fog.hidden.includes(h))) continue;
        const back = s0.board.vertices[near].edges.find((x) => x !== e.id && shipSite(s0, x) && s0.board.vertices[other(s0, x, near)].hexes.every((h) => !fog.hidden.includes(h)));
        if (back === undefined) continue;
        const s = patch(s0, (x) => {
          x.routes[back] = ship(0);
          x.ext.sea!.shipsLeft[0]--;
          grant(x, 0, { wood: 1, wool: 1 });
        });
        return { s, edge: e.id, hex: hidden[0], far };
      }
    }
    throw new Error('no frontier');
  }

  it('a ship beside a face-down hex turns it up: land draws a number and pays its finder a card', () => {
    const { s, edge, hex } = frontier((t) => t !== 'sea' && t !== 'bounty');
    const terrain = s.board.hexes[hex].terrain;
    const pool = s.ext.sea!.fog!.pool;
    const r = apply(s, 0, { type: 'sea/buildShip', edge });
    const res = TERRAIN_RESOURCE[terrain]!;
    expect(r.events).toContainEqual({ type: 'sea/hexRevealed', player: 0, hex, terrain, number: pool.at(-1), grant: res });
    const after = r.state;
    expect(isHidden(after, hex)).toBe(false);
    expect(after.players[0].hand[res]).toBe(1);
    expect(after.ext.sea!.fog!.pool).toHaveLength(pool.length - 1);
    expect(numbersOf(after, after.board.hexes[hex])).toEqual([pool.at(-1)]);
    expect(numbersOf(s, s.board.hexes[hex])).toEqual([]);
    // Nothing that turned something up can be taken back.
    expect(canUndo(after, 0)).toBe(false);
    checkInvariants(after, 'fog');
  });

  it('a face-down bounty field pays a pick of the finder\'s choice; open water pays nothing', () => {
    const gold = frontier((t) => t === 'bounty');
    const r = apply(gold.s, 0, { type: 'sea/buildShip', edge: gold.edge });
    expect(r.state.pending.at(-1)).toMatchObject({ kind: 'sea/bountyPick', players: [0], data: { count: 1, reason: 'fog' } });
    const picked = apply(r.state, 0, { type: 'sea/pickBounty', resources: ['wheat'] }).state;
    expect(picked.players[0].hand.wheat).toBe(1);
    const water = frontier((t) => t === 'sea');
    const w = apply(water.s, 0, { type: 'sea/buildShip', edge: water.edge });
    expect(w.events).toContainEqual({ type: 'sea/hexRevealed', player: 0, hex: water.hex, terrain: 'sea', number: null, grant: null });
    expect(w.state.ext.sea!.fog!.pool).toEqual(water.s.ext.sea!.fog!.pool);
  });

  it('nothing is built on, robbed or produced from what nobody has seen', () => {
    const s = emptySea('fogBank', 4, 2);
    const fog = s.ext.sea!.fog!;
    for (const h of fog.hidden) expect(legalRobberHexes(s)).not.toContain(h);
    const touching = s.board.vertices.filter((v) => v.hexes.some((h) => fog.hidden.includes(h)));
    const spread = patch(s, (x) => {
      for (const v of touching) for (const e of v.edges) if (!x.routes[e]) x.routes[e] = ship(0);
    });
    const spots = legalSettlements(spread, 0);
    for (const v of touching) expect(spots).not.toContain(v.id);
    // A road needs land in view, a ship open water in view.
    for (const e of s.board.edges) {
      if (e.hexes.every((h) => fog.hidden.includes(h) || s.board.hexes[h].terrain === 'sea')) {
        const t = patch(s, (x) => (x.buildings[e.a] = { owner: 0, kind: 'settlement' }));
        expect(legalActions(t, 0).some((a) => a.type === 'buildRoad' && a.edge === e.id)).toBe(false);
      }
      if (e.hexes.every((h) => fog.hidden.includes(h) || s.board.hexes[h].terrain !== 'sea')) expect(isLegalShip(s, 0, e.id)).toBe(false);
    }
  });

  it('hides the face-down terrain and the order of the discs from every seat', () => {
    const s = emptySea('fogBank', 3, 4);
    const fog = s.ext.sea!.fog!;
    for (const viewer of [0, 1, null]) {
      const seen = redactState(s, viewer);
      expect(seen.board.hexes).toHaveLength(s.board.hexes.length);
      expect(seen.board.vertices).toHaveLength(s.board.vertices.length);
      expect(seen.board.edges).toHaveLength(s.board.edges.length);
      for (const h of fog.hidden) {
        expect(seen.board.hexes[h].terrain).toBe('sea');
        expect(seen.board.hexes[h].island).toBe(-1);
      }
      for (const h of seen.board.hexes) if (!fog.hidden.includes(h.id)) expect(h.terrain).toBe(s.board.hexes[h.id].terrain);
      // Nothing derived from the hidden terrain shows: no edge between face-down hexes reads as land.
      for (const e of seen.board.edges) if (e.hexes.every((h) => fog.hidden.includes(h))) expect(e.land).toBe(false);
      expect(seen.board.islands.filter((i) => i.home)).toHaveLength(1);
      expect(seen.ext.sea!.fog!.pool.every((n) => n === 0)).toBe(true);
      expect(seen.board.objectives![0].numbers!.every((n) => n === 0)).toBe(true);
      expect(seen.ext.sea!.fog!.hidden).toEqual(fog.hidden);
    }
    // The real state is untouched.
    expect(s.board.hexes[fog.hidden[0]].terrain).toBe(seaGame('fogBank', 3, 4).board.hexes[fog.hidden[0]].terrain);
  });
});

// ---------------------------------------------------------------------------
// Bots and the fuzzer
// ---------------------------------------------------------------------------

const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];
const results: { map: string; res: GameResult }[] = [];

describe('bot games at sea', () => {
  for (const map of ['archipelago', 'fogBank']) {
    for (const n of [3, 4] as const) {
      slow(`${map}, ${n} seats: 12 games to ${MAP_INFO[map].target} finish with no fall-backs`, () => {
        for (let g = 0; g < 12; g++) {
          const res = runBotGame({
            seed: 41_000 + g * 31 + n,
            players: n,
            layout: 'random',
            options: { map, modules: ['sea'], victoryPoints: MAP_INFO[map].target },
            difficulties: g % 4 === 3 ? Array.from({ length: n }, (_, i) => DIFFS[(g + i) % 3]) : Array(n).fill(DIFFS[g % 3]),
            crossCheckLegal: g % 3 === 0,
          });
          expect(res.winner).not.toBeNull();
          expect(res.fallbacks).toBe(0);
          results.push({ map, res });
        }
      }, timeout(300_000));
    }
  }
});

describe('Sea Lanes without a sea', () => {
  slow('on the classic island, with no open water, the game plays as before: no corsair, no ships', () => {
    for (let g = 0; g < 4; g++) {
      const n = g % 2 ? 3 : 4;
      const s = createGame(setups(n), { seed: 44_000 + g, modules: ['sea'] }).state;
      expect(s.ext.sea!.corsair).toBeNull();
      const res = runBotGame({ seed: 44_000 + g, players: n, layout: 'random', options: { modules: ['sea'] }, difficulties: Array(n).fill(DIFFS[g % 3]), crossCheckLegal: true });
      expect(res.winner).not.toBeNull();
      expect(res.fallbacks).toBe(0);
    }
  }, timeout(120_000));
});

describe('fuzzing at sea', () => {
  for (const map of ['archipelago', 'fogBank']) {
    slow(`${map}: every legal action applies, and the invariants hold`, () => {
      let checked = 0;
      for (let g = 0; g < 4; g++) {
        const r = runFuzzGame(52_000 + g, g % 2 ? 3 : 4, 'random', 500, true, { map, modules: ['sea'], victoryPoints: MAP_INFO[map].target });
        checked += r.checkedActions;
      }
      for (let g = 0; g < 4; g++) runFuzzGame(53_000 + g, g % 2 ? 4 : 3, 'random', 3000, false, { map, modules: ['sea'], victoryPoints: MAP_INFO[map].target });
      expect(checked).toBeGreaterThan(3000);
    }, timeout(300_000));
  }
});

afterAll(() => {
  if (results.length === 0) return;
  const lines: string[] = [];
  for (const map of ['archipelago', 'fogBank']) {
    for (const n of [3, 4]) {
      const rs = results.filter((r) => r.map === map && r.res.players === n).map((r) => r.res);
      if (rs.length === 0) continue;
      const wins = Array(n).fill(0);
      for (const r of rs) wins[r.winner!]++;
      const turns = rs.map((r) => r.turns);
      lines.push(
        `${map} ${n}p: ${rs.length} games, avg ${(turns.reduce((a, b) => a + b, 0) / rs.length).toFixed(1)} turns (min ${Math.min(...turns)}, max ${Math.max(...turns)}), seat wins ${wins.join('/')}, fallbacks ${rs.reduce((a, r) => a + r.fallbacks, 0)}`,
      );
    }
  }
  console.log('\n' + lines.join('\n'));
});
