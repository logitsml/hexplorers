import { afterAll, describe, expect, it } from 'vitest';
import {
  applyAction,
  bridgeSites,
  createGame,
  isLegalRoad,
  legalActions,
  refugeHex,
  legalSetupRoads,
  legalSetupSettlements,
  longestRoadFor,
  moveAllowed,
  placeAllowed,
  publicVictoryPoints,
  rowColToAxial,
  type GameState,
  type Terrain,
  victoryTarget,
} from '../../src/engine';
import { Ctx } from '../../src/engine/ctx';
import { built, moved } from '../../src/engine/reducer';
import { onRiverCorner, onRiverEdge, riverGeometry, wealthOf } from '../../src/engine/modules/rivers/queries';
import { MODULES } from '../../src/engine/modules';
import { BotCtx } from '../../src/engine/ai/context';

const riversBot = MODULES.rivers.bot!;
import { botDecide, createBotMemory, type BotDifficulty } from '../../src/engine/ai';
import { apply, grant, patch, road, toMain } from '../helpers';
import { runBotGame, runFuzzGame, setups, type GameResult } from '../sim-harness';
import { slow, timeout } from '../tier';

const RIVERS = { modules: ['rivers' as const] };

function riverGame(opts: { seed?: number; layout?: 'beginner' | 'random'; numberPlacement?: 'spiral' | 'balanced'; players?: 3 | 4; friendlyRobber?: boolean } = {}): GameState {
  return createGame(setups(opts.players ?? 4), { layout: opts.layout ?? 'random', seed: opts.seed ?? 3, numberPlacement: opts.numberPlacement ?? 'spiral', friendlyRobber: opts.friendlyRobber ?? false, ...RIVERS }).state;
}

/** A river game past set-up with nothing built, player 0 to act in their main phase. */
function emptyMain(seed = 3): GameState {
  return patch(riverGame({ seed }), (s) => {
    s.turn = 1;
    s.setupIndex = s.setupOrder.length;
    s.setupRound = 2;
    toMain(s, 0);
  });
}

const hexAtRC = (s: GameState, row: number, col: number) => {
  const [q, r] = rowColToAxial(row, col);
  return s.board.hexes.find((h) => h.q === q && h.r === r)!;
};

const sitesOf = (s: GameState) => [...bridgeSites(s)].sort((a, b) => a - b);
/** A bridge site that crosses between two river hexes (both its ends are on land). */
const crossing = (s: GameState) => s.board.features.rivers![0].bridgeSites[1];
const coins = (s: GameState) => s.players.map((p) => p.coins);

/** An edge next to `vertex` that isn't a bridge site. */
const edgeBeside = (s: GameState, vertex: number, not: number[] = []) => s.board.vertices[vertex].edges.find((e) => !bridgeSites(s).has(e) && !not.includes(e))!;

/** Find a dice stream that rolls `total` (test-only). */
function forceRoll(state: GameState, total: number): GameState {
  for (let seed = 1; seed < 100000; seed++) {
    const s = patch(state, (x) => (x.rngState = seed));
    const r = applyAction(s, s.currentPlayer, { type: 'rollDice' });
    if (r.ok && r.state.dice![0] + r.state.dice![1] === total) return s;
  }
  throw new Error('no seed');
}

describe('the river island', () => {
  const STAMPS: Terrain[][] = [
    ['mountains', 'hills', 'pasture', 'swamp'],
    ['mountains', 'hills', 'swamp'],
  ];
  const straight = (s: GameState, path: number[]) => {
    const [a, b] = [s.board.hexes[path[0]], s.board.hexes[path[1]]];
    const [dq, dr] = [b.q - a.q, b.r - a.r];
    return path.every((h, i) => i === 0 || (s.board.hexes[h].q - s.board.hexes[path[i - 1]].q === dq && s.board.hexes[h].r - s.board.hexes[path[i - 1]].r === dr));
  };

  for (const layout of ['random', 'beginner'] as const) {
    for (const numberPlacement of ['spiral', 'balanced'] as const) {
      it(`${layout} (${numberPlacement}): two straight stamps of river tiles, no desert, every disc on the island`, () => {
        for (let seed = 1; seed <= 20; seed++) {
          const s = riverGame({ seed, layout, numberPlacement });
          const b = s.board;
          const rivers = b.features.rivers!;
          rivers.forEach((rv, i) => {
            expect(rv.hexes.map((h) => b.hexes[h].terrain)).toEqual(STAMPS[i]);
            expect(straight(s, rv.hexes)).toBe(true);
          });
          // The two never touch.
          for (const h of rivers[0].hexes) for (const k of rivers[1].hexes) expect(b.hexes[h].neighbors).not.toContain(k);
          const count = (t: Terrain) => b.hexes.filter((h) => h.terrain === t).length;
          expect([count('hills'), count('forest'), count('pasture'), count('fields'), count('mountains'), count('swamp'), count('desert')]).toEqual([3, 4, 3, 4, 3, 2, 0]);
          expect(b.desertHex).toBeNull();
          // Swamps take no number; the other 17 hexes hold the 18 discs, one hex two of them.
          for (const h of b.hexes) expect(h.numbers.length > 0).toBe(h.terrain !== 'swamp');
          expect(b.hexes.flatMap((h) => h.numbers).sort((x, y) => x - y)).toEqual([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
          const red = (h: { numbers: number[] }) => h.numbers.some((n) => n === 6 || n === 8);
          expect(b.hexes.some((h) => red(h) && h.neighbors.some((n) => red(b.hexes[n])))).toBe(false);
          // The robber starts on a swamp.
          expect(b.hexes[s.robberHex!].terrain).toBe('swamp');
        }
      });
    }
  }

  it('plays to the usual 10 points', () => {
    expect(victoryTarget(riverGame(), 0)).toBe(10);
  });

  it('deals the same river island from the same seed', () => {
    for (const layout of ['random', 'beginner'] as const) {
      const a = riverGame({ layout, seed: 1 }).board.hexes.map((h) => [h.terrain, h.numbers]);
      expect(riverGame({ layout, seed: 1 }).board.hexes.map((h) => [h.terrain, h.numbers])).toEqual(a);
      expect(riverGame({ layout, seed: 99 }).board.hexes.map((h) => [h.terrain, h.numbers])).not.toEqual(a);
    }
  });

  it('records each river from source to mouth, with its bridge sites: the crossings and the mouth', () => {
    const s = riverGame();
    const [four, three] = s.board.features.rivers!;
    expect(four.hexes).toHaveLength(4);
    expect(three.hexes).toHaveLength(3);
    expect(four.bridgeSites).toHaveLength(4);
    expect(three.bridgeSites).toHaveLength(3);
    for (const river of [four, three]) {
      // Each crossing joins two hexes of the river; the mouth is a coastal edge of the swamp.
      const sorted = (xs: number[]) => xs.slice().sort((x, y) => x - y);
      river.bridgeSites.slice(0, -1).forEach((e, i) => expect(sorted(s.board.edges[e].hexes)).toEqual(sorted([river.hexes[i], river.hexes[i + 1]])));
      const mouth = s.board.edges[river.bridgeSites.at(-1)!];
      expect(mouth.coastal).toBe(true);
      expect(mouth.hexes).toEqual([river.hexes.at(-1)]);
    }
  });

  it('keeps the beginner set-up’s starting roads off the bridge sites', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = riverGame({ layout: 'beginner', seed });
      const sites = bridgeSites(s);
      s.routes.forEach((r, e) => r && expect(sites.has(e)).toBe(false));
    }
  });

  it('every hex of a river tile is a river hex: its edges and corners pay', () => {
    const s = riverGame();
    const g = riverGeometry(s.board);
    expect(g.hexes.size).toBe(7);
    // A corner or side that touches no river hex is on no river.
    const dry = s.board.vertices.filter((v) => v.hexes.every((h) => !g.hexes.has(h)));
    expect(dry.length).toBeGreaterThan(0);
    for (const v of dry) expect(onRiverCorner(s, v.id)).toBe(false);
    for (const e of s.board.edges.filter((e) => e.hexes.every((h) => !g.hexes.has(h)))) expect(onRiverEdge(s, e.id)).toBe(false);
    const river = s.board.hexes[s.board.features.rivers![0].hexes[1]];
    expect(river.edges.every((e) => onRiverEdge(s, e))).toBe(true);
    expect(river.vertices.every((v) => onRiverCorner(s, v))).toBe(true);
  });

  it('the base game keeps its desert and robber', () => {
    const s = createGame(setups(4), { layout: 'random', seed: 3 }).state;
    expect(s.board.desertHex).not.toBeNull();
    expect(s.robberHex).toBe(s.board.desertHex);
    expect(s.board.features.rivers).toBeUndefined();
  });

  it('an invader that keeps the robber off the board keeps it off a swamp too', () => {
    const s = createGame(setups(4), { layout: 'random', seed: 3, modules: ['guilds', 'garrisons', 'fleet', 'rivers'] }).state;
    expect(s.robberHex).toBeNull();
  });
});

describe('a hex with two numbers', () => {
  it('produces on either', () => {
    const base = emptyMain();
    const hex = base.board.hexes.find((h) => h.numbers.length === 2)!;
    const v = hex.vertices[0];
    for (const total of hex.numbers) {
      let s = patch(base, (x) => {
        x.buildings[v] = { owner: 1, kind: 'settlement' };
        x.phase = 'roll';
        x.hasRolled = false;
        x.robberHex = riverGeometry(x.board).swamps[0];
      });
      s = forceRoll(s, total);
      const r = apply(s, 0, { type: 'rollDice' });
      const prod = r.events.find((e) => e.type === 'production');
      expect(prod?.type === 'production' && prod.grants.some((g) => g.hex === hex.id && g.player === 1)).toBe(true);
    }
  });
});

describe('bridges', () => {
  /** Player 0 with a settlement at one end of `site` and the cards for a bridge. */
  function atSite(site?: number): { s: GameState; site: number } {
    const base = emptyMain();
    const e = site ?? crossing(base);
    const s = patch(base, (x) => {
      x.buildings[x.board.edges[e].a] = { owner: 0, kind: 'settlement' };
      x.players[0].settlementsLeft--;
      grant(x, 0, { brick: 4, wood: 2 });
    });
    return { s, site: e };
  }

  it('cost 2 brick and 1 wood, cross a river joined to your own piece, and pay 3 coins', () => {
    const { s, site } = atSite();
    expect(legalActions(s, 0)).toContainEqual({ type: 'rivers/buildBridge', edge: site });
    const r = apply(s, 0, { type: 'rivers/buildBridge', edge: site });
    expect(r.state.routes[site]).toMatchObject({ owner: 0, kind: 'bridge' });
    expect(r.state.players[0].hand).toMatchObject({ brick: 2, wood: 1 });
    expect(r.state.players[0].coins).toBe(3);
    expect(r.state.ext.rivers!.bridgesLeft[0]).toBe(2);
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(['rivers/bridgeBuilt', 'coins', 'rivers/wealthChanged']));
  });

  it('go only on bridge sites, and only bridges go there', () => {
    const { s, site } = atSite();
    const other = edgeBeside(s, s.board.edges[site].a);
    expect(applyAction(s, 0, { type: 'rivers/buildBridge', edge: other }).ok).toBe(false);
    expect(isLegalRoad(s, 0, site)).toBe(false);
    expect(applyAction(s, 0, { type: 'buildRoad', edge: site }).ok).toBe(false);
  });

  it('must join your own road, bridge or building, and never past an opponent', () => {
    const { s, site } = atSite();
    const loose = patch(s, (x) => {
      x.buildings[x.board.edges[site].a] = null;
      x.players[0].settlementsLeft++;
    });
    expect(applyAction(loose, 0, { type: 'rivers/buildBridge', edge: site }).ok).toBe(false);
    // From a road that ends at an opponent's settlement: blocked there.
    const a = s.board.edges[site].a;
    const lead = edgeBeside(s, a);
    const blocked = patch(loose, (x) => {
      x.buildings[a] = { owner: 1, kind: 'settlement' };
      x.routes[lead] = road(0);
      x.players[0].roadsLeft--;
    });
    expect(applyAction(blocked, 0, { type: 'rivers/buildBridge', edge: site }).ok).toBe(false);
    // From your own road the bridge joins.
    const own = patch(loose, (x) => {
      x.routes[lead] = road(0);
      x.players[0].roadsLeft--;
    });
    expect(applyAction(own, 0, { type: 'rivers/buildBridge', edge: site }).ok).toBe(true);
  });

  it('cost what they cost, three to a player, only on your own turn', () => {
    const { s, site } = atSite();
    expect(applyAction(patch(s, (x) => grant(x, 0, { brick: -3 })), 0, { type: 'rivers/buildBridge', edge: site }).ok).toBe(false);
    expect(applyAction(patch(s, (x) => (x.ext.rivers!.bridgesLeft[0] = 0)), 0, { type: 'rivers/buildBridge', edge: site }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'rivers/buildBridge', edge: site }).ok).toBe(false);
    expect(applyAction(patch(s, (x) => (x.phase = 'roll')), 0, { type: 'rivers/buildBridge', edge: site }).ok).toBe(false);
  });

  it('carry a route like a road: roads go on from the far end, and Longest Route counts the bridge', () => {
    const { s, site } = atSite();
    const r = apply(s, 0, { type: 'rivers/buildBridge', edge: site }).state;
    const far = r.board.edges[site].b;
    const next = edgeBeside(r, far, [site]);
    expect(isLegalRoad(r, 0, next)).toBe(true);
    const after = apply(r, 0, { type: 'buildRoad', edge: next }).state;
    expect(longestRoadFor(after, 0)).toBe(2);
  });

  it('Road Crew places no bridge', () => {
    const { s, site } = atSite();
    const rb = patch(s, (x) => {
      x.phase = 'roadBuilding';
      x.freeRoadsLeft = 2;
    });
    expect(applyAction(rb, 0, { type: 'placeFreeRoad', edge: site }).ok).toBe(false);
    expect(legalActions(rb, 0).some((a) => a.type === 'placeFreeRoad' && a.edge === site)).toBe(false);
  });

  it('can be built at the mouth, where the river meets the sea', () => {
    const base = emptyMain();
    const mouth = base.board.features.rivers![1].bridgeSites.at(-1)!;
    const { s } = atSite(mouth);
    expect(apply(s, 0, { type: 'rivers/buildBridge', edge: mouth }).state.routes[mouth]?.kind).toBe('bridge');
  });

  it('set-up roads keep off bridge sites', () => {
    let s = riverGame();
    const sites = new Set(sitesOf(s));
    const v = legalSetupSettlements(s).find((x) => s.board.vertices[x].edges.some((e) => sites.has(e)))!;
    s = apply(s, s.currentPlayer, { type: 'placeSetupSettlement', vertex: v }).state;
    expect(legalSetupRoads(s).some((e) => sites.has(e))).toBe(false);
  });
});

describe('coins for building by a river', () => {
  /** Player 0 with a settlement at `vertex` and plenty of cards. */
  const withSettlement = (vertex: number) =>
    patch(emptyMain(), (x) => {
      x.buildings[vertex] = { owner: 0, kind: 'settlement' };
      x.players[0].settlementsLeft--;
      grant(x, 0, { brick: 5, wood: 5, wool: 2, wheat: 4, ore: 3 });
    });

  it('a road on a river hex edge pays a coin; elsewhere nothing', () => {
    const s0 = emptyMain();
    const riverEdge = s0.board.edges.find((e) => onRiverEdge(s0, e.id) && !bridgeSites(s0).has(e.id))!;
    const s = withSettlement(riverEdge.a);
    expect(apply(s, 0, { type: 'buildRoad', edge: riverEdge.id }).state.players[0].coins).toBe(1);
    const far = hexAtRC(s0, 1, 3);
    const dry = far.edges.find((e) => !onRiverEdge(s0, e))!;
    const s2 = withSettlement(s0.board.edges[dry].a);
    expect(apply(s2, 0, { type: 'buildRoad', edge: dry }).state.players[0].coins).toBe(0);
  });

  /** A settlement at the start of a two-road path (no bridge sites) to a corner `pick` accepts. */
  function twoRoadsTo(pick: (s: GameState, v: number) => boolean): { s: GameState; target: number } {
    const s0 = emptyMain();
    const sites = bridgeSites(s0);
    const edgeOf = (a: number, b: number) => s0.board.vertices[a].edges.find((e) => s0.board.edges[e].a === b || s0.board.edges[e].b === b)!;
    for (const t of s0.board.vertices) {
      if (!t.land || !pick(s0, t.id)) continue;
      for (const mid of t.neighbors) {
        for (const v of s0.board.vertices[mid].neighbors) {
          const [e1, e2] = [edgeOf(v, mid), edgeOf(mid, t.id)];
          if (v === t.id || t.neighbors.includes(v) || !s0.board.vertices[v].land || sites.has(e1) || sites.has(e2)) continue;
          const s = patch(withSettlement(v), (x) => {
            x.routes[e1] = road(0);
            x.routes[e2] = road(0);
            x.players[0].roadsLeft -= 2;
          });
          return { s, target: t.id };
        }
      }
    }
    throw new Error('no path');
  }

  it('a settlement on a river hex corner pays a coin; a city pays nothing', () => {
    const { s, target } = twoRoadsTo(onRiverCorner);
    const r = apply(s, 0, { type: 'buildSettlement', vertex: target });
    expect(r.state.players[0].coins).toBe(1);
    const c = apply(r.state, 0, { type: 'buildCity', vertex: target });
    expect(c.state.players[0].coins).toBe(1);
    const dry = twoRoadsTo((x, v) => !onRiverCorner(x, v));
    expect(apply(dry.s, 0, { type: 'buildSettlement', vertex: dry.target }).state.players[0].coins).toBe(0);
  });

  it('a free road from Road Crew pays like any other', () => {
    const s0 = emptyMain();
    const riverEdge = s0.board.edges.find((e) => onRiverEdge(s0, e.id) && !bridgeSites(s0).has(e.id))!;
    const s = patch(withSettlement(riverEdge.a), (x) => {
      x.phase = 'roadBuilding';
      x.freeRoadsLeft = 1;
    });
    expect(apply(s, 0, { type: 'placeFreeRoad', edge: riverEdge.id }).state.players[0].coins).toBe(1);
  });

  it('taking a road back takes its coin back', () => {
    const s0 = emptyMain();
    const riverEdge = s0.board.edges.find((e) => onRiverEdge(s0, e.id) && !bridgeSites(s0).has(e.id))!;
    const r = apply(withSettlement(riverEdge.a), 0, { type: 'buildRoad', edge: riverEdge.id }).state;
    expect(apply(r, 0, { type: 'undo' }).state.players[0].coins).toBe(0);
  });

  it('set-up pays a coin for a starting building on a river corner and a road on a river edge', () => {
    let s = riverGame();
    const p = s.currentPlayer;
    const v = legalSetupSettlements(s).find((x) => onRiverCorner(s, x) && s.board.vertices[x].edges.some((e) => onRiverEdge(s, e) && !bridgeSites(s).has(e)))!;
    s = apply(s, p, { type: 'placeSetupSettlement', vertex: v }).state;
    expect(s.players[p].coins).toBe(1);
    s = apply(s, p, { type: 'placeSetupRoad', edge: legalSetupRoads(s).find((e) => onRiverEdge(s, e))! }).state;
    expect(s.players[p].coins).toBe(2);
    const q = s.currentPlayer;
    const dry = legalSetupSettlements(s).find((x) => !onRiverCorner(s, x))!;
    s = apply(s, q, { type: 'placeSetupSettlement', vertex: dry }).state;
    s = apply(s, q, { type: 'placeSetupRoad', edge: legalSetupRoads(s).find((e) => !onRiverEdge(s, e))! }).state;
    expect(s.players[q].coins).toBe(0);
  });

  it('the beginner set-up pays its starting coins with the first action', () => {
    const s = riverGame({ layout: 'beginner' });
    expect(coins(s)).toEqual([0, 0, 0, 0]);
    const owed = s.players.map((p) => {
      let n = 0;
      s.buildings.forEach((b, v) => b?.owner === p.id && onRiverCorner(s, v) && n++);
      s.routes.forEach((r, e) => r?.owner === p.id && onRiverEdge(s, e) && n++);
      return n;
    });
    expect(owed.some((n) => n > 0)).toBe(true);
    const r = apply(s, s.currentPlayer, { type: 'rollDice' });
    expect(coins(r.state)).toEqual(owed);
    expect(r.state.ext.rivers!.startCoinsOwed).toBe(false);
  });
});

describe('wealth', () => {
  it('everyone level means everyone a Pauper and nobody the Richest', () => {
    expect(wealthOf([0, 0, 0, 0])).toEqual({ richest: null, paupers: [0, 1, 2, 3] });
    const s = emptyMain();
    expect(s.players.map((p) => publicVictoryPoints(s, p.id))).toEqual([-1, -1, -1, -1]);
    // (A game recorded under the first rules paid two for each Pauper tile.)
    const first = patch(s, (x) => (x.options = { ...x.options, moduleRules: { ...x.options.moduleRules, rivers: 1 } }));
    expect(first.players.map((p) => publicVictoryPoints(first, p.id))).toEqual([-2, -2, -2, -2]);
  });

  it('a Pauper tile costs what the game says it does (the pauperPoints knob)', () => {
    const s = patch(emptyMain(), (x) => (x.options = { ...x.options, knobs: { ...x.options.knobs, pauperPoints: 2 } }));
    expect(s.players.map((p) => publicVictoryPoints(s, p.id))).toEqual([-2, -2, -2, -2]);
    const none = patch(s, (x) => (x.options = { ...x.options, knobs: { ...x.options.knobs, pauperPoints: 0 } }));
    expect(none.players.map((p) => publicVictoryPoints(none, p.id))).toEqual([0, 0, 0, 0]);
  });

  it('strictly the most coins holds the Richest; a tie for most leaves it in the supply', () => {
    expect(wealthOf([3, 1, 1, 0]).richest).toBe(0);
    expect(wealthOf([3, 3, 1, 0]).richest).toBeNull();
  });

  it('everyone tied for the fewest holds a Pauper tile', () => {
    expect(wealthOf([3, 1, 1, 2]).paupers).toEqual([1, 2]);
    expect(wealthOf([0, 1, 2, 3]).paupers).toEqual([0]);
  });

  it('the tiles count as points and move as soon as the coins do', () => {
    let s = patch(emptyMain(), (x) => {
      x.players.forEach((p, i) => (p.coins = [4, 3, 2, 1][i]));
    });
    s = apply(s, 0, { type: 'endTurn' }).state; // (any action brings the announced tiles up to date)
    expect(s.ext.rivers).toMatchObject({ richest: 0, paupers: [3] });
    expect(s.players.map((p) => publicVictoryPoints(s, p.id))).toEqual([1, 0, 0, -1]);
    // Player 1 spends two coins on a resource: now level with player 3 at the bottom.
    s = patch(s, (x) => toMain(x, 1));
    const r = apply(s, 1, { type: 'buyWithCoins', get: 'ore' });
    expect(r.state.ext.rivers!.paupers).toEqual([1, 3]);
    expect(publicVictoryPoints(r.state, 1)).toBe(-1);
    expect(r.events.find((e) => e.type === 'rivers/wealthChanged')).toMatchObject({ richest: 0, paupers: [1, 3], was: { richest: 0, paupers: [3] } });
  });

  it('a coin that lifts you onto the Richest tile can win the game', () => {
    const s0 = emptyMain();
    const corners = s0.board.vertices.filter((v) => v.land).map((v) => v.id);
    // Player 0: four cities and a settlement (9 points), level with player 1 for the most coins, so
    // neither Richest nor Pauper. One more coin makes them the Richest: 10.
    const spots: number[] = [];
    for (const v of corners) if (spots.every((u) => u !== v && !s0.board.vertices[u].neighbors.includes(v))) spots.push(v);
    const s = patch(s0, (x) => {
      spots.slice(0, 5).forEach((v, i) => (x.buildings[v] = { owner: 0, kind: i < 4 ? 'city' : 'settlement' }));
      x.players[0].citiesLeft = 0;
      x.players[0].settlementsLeft = 4;
      x.players.forEach((p, i) => (p.coins = [2, 2, 1, 1][i]));
      grant(x, 0, { wheat: 4 });
    });
    // 9 building points; neither Richest nor Pauper: 9.
    expect(publicVictoryPoints(s, 0)).toBe(9);
    const r = apply(s, 0, { type: 'sellForCoins', give: 'wheat', times: 1 });
    expect(r.state.winner).toBe(0);
  });
});

describe('coins are tokens, not cards', () => {
  it("don't count towards a 7's hand limit", () => {
    let s = patch(emptyMain(), (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
      grant(x, 1, { brick: 3, wood: 4 });
      x.players[1].coins = 20;
    });
    s = forceRoll(s, 7);
    const r = apply(s, 0, { type: 'rollDice' });
    expect(r.state.pendingDiscards[1]).toBeUndefined();
  });

  it("can't be stolen", () => {
    const base = emptyMain();
    const hex = base.board.hexes.find((h) => h.terrain === 'forest')!;
    const s = patch(base, (x) => {
      x.buildings[hex.vertices[0]] = { owner: 1, kind: 'settlement' };
      x.players[1].coins = 5;
      grant(x, 1, { wool: 1 });
      x.phase = 'moveRobber';
    });
    const r = apply(s, 0, { type: 'moveRobber', hex: hex.id });
    expect(r.state.players[1].coins).toBe(5);
    expect(r.state.players[0].hand.wool).toBe(1);
  });

  it("can't be taken by a Monopoly", () => {
    const s = patch(emptyMain(), (x) => {
      x.players[0].devCards.push({ type: 'monopoly', boughtTurn: 0 });
      x.players[1].coins = 6;
      grant(x, 1, { ore: 2 });
    });
    const r = apply(s, 0, { type: 'playMonopoly', resource: 'ore' });
    expect(r.state.players[1].coins).toBe(6);
    expect(r.state.players[0].hand.ore).toBe(2);
  });

  it('buy a resource at two coins, twice a turn, and are sold for at the bank rate', () => {
    let s = patch(emptyMain(), (x) => {
      x.players[0].coins = 6;
      grant(x, 0, { wool: 4 });
    });
    s = apply(s, 0, { type: 'buyWithCoins', get: 'brick' }).state;
    s = apply(s, 0, { type: 'buyWithCoins', get: 'wood' }).state;
    expect(s.players[0].coins).toBe(2);
    expect(applyAction(s, 0, { type: 'buyWithCoins', get: 'ore' }).ok).toBe(false);
    s = apply(s, 0, { type: 'sellForCoins', give: 'wool', times: 1 }).state;
    expect(s.players[0]).toMatchObject({ coins: 3, hand: expect.objectContaining({ wool: 0 }) });
  });
});

describe('ships along a river (through the generic hooks)', () => {
  const setup = () => {
    const s = emptyMain();
    const riverEdge = s.board.edges.find((e) => onRiverEdge(s, e.id) && !bridgeSites(s).has(e.id))!.id;
    const dry = hexAtRC(s, 1, 3).edges.find((e) => !onRiverEdge(s, e))!;
    return { s, riverEdge, dry };
  };

  it('a ship built on a river edge pays a coin; none may stand on a bridge site', () => {
    const { s, riverEdge } = setup();
    const ctx = new Ctx(structuredClone(s));
    ctx.s.routes[riverEdge] = { owner: 0, kind: 'ship', builtTurn: 1 };
    built(ctx, 0, 'ship', riverEdge, true);
    expect(ctx.s.players[0].coins).toBe(1);
    const site = sitesOf(s)[0];
    expect(placeAllowed(s, 0, 'ship', site)).toBe(false);
    expect(placeAllowed(s, 0, 'ship', riverEdge)).toBe(true);
    expect(placeAllowed(s, 0, 'bridge', site)).toBe(true);
    expect(moveAllowed(patch(s, (x) => (x.players[0].coins = 5)), 0, 'ship', riverEdge, site)).toBe(false);
  });

  it('sailing off a river edge costs a coin, and needs one', () => {
    const { s, riverEdge, dry } = setup();
    const ship = patch(s, (x) => (x.routes[riverEdge] = { owner: 0, kind: 'ship', builtTurn: 0 }));
    expect(moveAllowed(ship, 0, 'ship', riverEdge, dry)).toBe(false);
    const rich = patch(ship, (x) => (x.players[0].coins = 2));
    expect(moveAllowed(rich, 0, 'ship', riverEdge, dry)).toBe(true);
    const ctx = new Ctx(structuredClone(rich));
    ctx.s.routes[dry] = ctx.s.routes[riverEdge];
    ctx.s.routes[riverEdge] = null;
    moved(ctx, 0, 'ship', riverEdge, dry);
    expect(ctx.s.players[0].coins).toBe(1);
    // Sailing onto a river edge is free, and pays nothing.
    expect(moveAllowed(ship, 0, 'ship', dry, riverEdge)).toBe(true);
  });
});

describe('the friendly robber', () => {
  it('with nowhere it may go, it goes to a swamp (rule 4)', () => {
    const base = riverGame({ friendlyRobber: true });
    const forest = base.board.hexes.find((h) => h.terrain === 'forest')!.id;
    // Buildings touch every land hex but the robber's, two at most per player: with every coin level
    // at none, each holds a Pauper tile and has no more than 2 - 2 = 0 points, so all are spared.
    const s = patch(base, (x) => {
      x.turn = 5;
      x.setupIndex = x.setupOrder.length;
      toMain(x, 0);
      x.robberHex = forest;
      x.players[0].devCards.push({ type: 'knight', boughtTurn: 0 });
      const need = new Set(x.board.hexes.filter((h) => h.id !== forest).map((h) => h.id));
      for (let k = 0; need.size > 0; k++) {
        let best = -1;
        let gain = 0;
        for (const v of x.board.vertices) {
          if (x.buildings[v.id] || v.neighbors.some((n) => x.buildings[n])) continue;
          const g = v.hexes.filter((h) => need.has(h)).length;
          if (g > gain) [best, gain] = [v.id, g];
        }
        if (best < 0) throw new Error('cannot cover the island');
        x.buildings[best] = { owner: k % 4, kind: 'settlement' };
        x.players[k % 4].settlementsLeft--;
        for (const h of x.board.vertices[best].hexes) need.delete(h);
      }
    });
    expect(s.players.every((p) => publicVictoryPoints(s, p.id) <= 2)).toBe(true);
    // (The core's own fall-back: the only hex left is a swamp bearing no number, the desert being gone.)
    const k = apply(s, 0, { type: 'playKnight' }).state;
    const swamp = refugeHex(s)!;
    expect(s.board.hexes[swamp].terrain).toBe('swamp');
    expect(legalActions(k, 0)).toEqual([{ type: 'moveRobber', hex: swamp }]);
    const r = apply(k, 0, { type: 'moveRobber', hex: swamp });
    expect(r.state.robberHex).toBe(swamp);
    expect(r.events).toContainEqual({ type: 'robberMoved', player: 0, from: forest, to: swamp });
  });
});

describe('the bot', () => {
  /** Player 0 with four cities and a settlement (9 points), coins level with player 1 for the most. */
  function nearlyThere(): GameState {
    const s0 = emptyMain();
    const spots: number[] = [];
    for (const v of s0.board.vertices) if (v.land && spots.every((u) => !s0.board.vertices[u].neighbors.includes(v.id))) spots.push(v.id);
    return patch(s0, (x) => {
      spots.slice(0, 5).forEach((v, i) => (x.buildings[v] = { owner: 0, kind: i < 4 ? 'city' : 'settlement' }));
      x.players[0].citiesLeft = 0;
      x.players[0].settlementsLeft = 4;
      x.players.forEach((p, i) => (p.coins = [2, 2, 1, 1][i]));
    });
  }

  it('sells cards for the coin that wins it the game', () => {
    const s = patch(nearlyThere(), (x) => grant(x, 0, { wool: 4 }));
    const a = botDecide(s, 0, createBotMemory(), 'normal');
    expect(a).toMatchObject({ type: 'sellForCoins', give: 'wool' });
    expect(apply(s, 0, a!).state.winner).toBe(0);
  });

  it('near the end, sells spare cards to get off a Pauper tile', () => {
    // Player 0 at 8 building points, alone with the fewest coins: 7 points. A coin makes them level
    // with players 2 and 3 at the bottom (still a Pauper); two lift them clear.
    const s = patch(nearlyThere(), (x) => {
      x.buildings[x.buildings.findIndex((b) => b?.kind === 'settlement')] = null;
      x.players[0].settlementsLeft = 5;
      x.players.forEach((p, i) => (p.coins = [0, 3, 1, 1][i]));
      grant(x, 0, { wool: 10 });
    });
    expect(publicVictoryPoints(s, 0)).toBe(7);
    const a = botDecide(s, 0, createBotMemory(), 'normal');
    expect(a).toMatchObject({ type: 'sellForCoins', give: 'wool' });
  });

  it('spends coins on the card a build is short of', () => {
    const base = emptyMain();
    const v = base.board.vertices.find((x) => x.land)!.id;
    const s = patch(base, (x) => {
      // (No development cards left, so the city is the one build in reach.)
      x.devDeck = [];
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      x.players[0].settlementsLeft--;
      x.players[0].coins = 4;
      grant(x, 0, { wheat: 2, ore: 2 });
    });
    expect(botDecide(s, 0, createBotMemory(), 'hard')).toEqual({ type: 'buyWithCoins', get: 'ore' });
  });

  it('values a river corner above the same spot without the river', () => {
    const s = emptyMain();
    const wet = s.board.vertices.find((v) => onRiverCorner(s, v.id))!.id;
    const ctx = new BotCtx(s, 0, 'normal', createBotMemory());
    expect(riversBot.spotBonus!(ctx, wet)).toBeGreaterThan(0);
    expect(riversBot.spotBonus!(ctx, hexAtRC(s, 1, 3).vertices[0])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Bots and the fuzzer
// ---------------------------------------------------------------------------------------------

const results: GameResult[] = [];
const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];

describe('bot-only river games', () => {
  for (const players of [4, 3] as const) {
    slow(`${players === 4 ? 30 : 20} ${players}-player games finish with no fall-backs and every invariant intact`, () => {
      const count = players === 4 ? 30 : 20;
      for (let g = 0; g < count; g++) {
        const res = runBotGame({
          seed: 7000 + players * 100 + g,
          players,
          layout: g % 5 === 4 ? 'beginner' : 'random',
          numberPlacement: g % 3 === 1 ? 'balanced' : 'spiral',
          options: RIVERS,
          difficulties: g % 4 === 3 ? Array.from({ length: players }, (_, i) => DIFFS[(g + i) % 3]) : Array(players).fill(DIFFS[g % 3]),
          crossCheckLegal: g % 5 === 0,
        });
        expect(res.winner).not.toBeNull();
        expect(res.fallbacks).toBe(0);
        results.push(res);
      }
    }, timeout(120_000));
  }
});

describe('random legal-action fuzzer', () => {
  slow('every enumerated river action applies and the invariants hold', () => {
    let checked = 0;
    for (let g = 0; g < 6; g++) checked += runFuzzGame(8100 + g, g % 3 === 0 ? 3 : 4, g % 2 ? 'random' : 'beginner', 500, true, RIVERS).checkedActions;
    for (let g = 0; g < 6; g++) runFuzzGame(8200 + g, g % 2 ? 3 : 4, 'random', 2500, false, RIVERS);
    expect(checked).toBeGreaterThan(5000);
  }, timeout(120_000));
});

afterAll(() => {
  if (results.length === 0) return;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  for (const n of [4, 3]) {
    const rs = results.filter((r) => r.players === n);
    const wins = Array(n).fill(0);
    for (const r of rs) wins[r.winner!]++;
    console.log(`rivers ${n}p: ${rs.length} games, avg ${avg(rs.map((r) => r.turns)).toFixed(1)} turns, seat wins ${wins.join('/')}, fall-backs ${rs.reduce((a, r) => a + r.fallbacks, 0)}`);
  }
});
