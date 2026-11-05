import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  islandCoords,
  canUndo,
  legalRoads,
  legalCities,
  legalSetupSettlements,
  legalSetupRoads,
  longestRoadFor,
  publicVictoryPoints,
  redactState,
  rowColToAxial,
  spiralOrder,
  SPIRAL_SEQUENCE,
  totalCards,
  totalVictoryPoints,
  tradeRatios,
  type GameState,
} from '../src/engine';
import { FOUR, apply, beginnerGame, grant, patch, playerByColor, rc, toMain, num, road } from './helpers';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { RESOURCES } from '../src/engine/types';

const coordOf = (row: number, col: number) => rowColToAxial(row, col).join(',');

describe('board topology', () => {
  const s = beginnerGame();
  it('has the standard component counts', () => {
    expect(s.board.hexes).toHaveLength(19);
    expect(s.board.vertices).toHaveLength(54);
    expect(s.board.edges).toHaveLength(72);
    expect(s.board.edges.filter((e) => e.coastal)).toHaveLength(30);
    expect(s.board.ports).toHaveLength(9);
    expect(s.board.vertices.filter((v) => v.port)).toHaveLength(18);
  });
  it('every port sits on a coastal edge', () => {
    for (const p of s.board.ports) expect(s.board.edges[p.edge].coastal).toBe(true);
  });
  it('intersections have 2 or 3 neighbours', () => {
    for (const v of s.board.vertices) expect([2, 3]).toContain(v.neighbors.length);
  });
  it('island coords are radius 2', () => {
    expect(islandCoords()).toHaveLength(19);
  });
});

describe('beginner setup', () => {
  const s = beginnerGame();
  it('lays out our own island, desert and robber in the middle', () => {
    const at = (row: number, col: number) => s.board.hexes.find((h) => `${h.q},${h.r}` === coordOf(row, col))!;
    expect([at(3, 3).terrain, num(at(3, 3))]).toEqual(['desert', null]);
    expect(s.robberHex).toBe(at(3, 3).id);
    expect([at(1, 1).terrain, num(at(1, 1))]).toEqual(['forest', 10]);
    expect([at(5, 3).terrain, num(at(5, 3))]).toEqual(['fields', 8]);
  });
  it('keeps numbers apart: no repeats side by side, no 6 touching an 8', () => {
    for (const h of s.board.hexes) {
      for (const n of h.neighbors.map((i) => s.board.hexes[i])) {
        if (num(h) === null || num(n) === null) continue;
        expect(num(n)).not.toBe(num(h));
        expect([6, 8].includes(num(h)!) && [6, 8].includes(num(n)!)).toBe(false);
      }
    }
  });
  it('places its own harbours clockwise from the upper-left', () => {
    expect(s.board.ports.map((p) => p.type)).toEqual(['wheat', 'any', 'wood', 'wool', 'brick', 'any', 'ore', 'any', 'any']);
  });
  it('gives every seat a fair start: all five resources, near-equal production, three cards', () => {
    const pips = s.players.map((p) => {
      const mine = s.buildings.map((b, v) => (b?.owner === p.id ? v : -1)).filter((v) => v >= 0);
      const hexes = mine.flatMap((v) => s.board.vertices[v].hexes.map((h) => s.board.hexes[h]));
      expect(new Set(hexes.map((h) => h.terrain)).size).toBe(5);
      expect(totalCards(p.hand)).toBe(3);
      return hexes.reduce((a, h) => a + (num(h) ? 6 - Math.abs(7 - num(h)!) : 0), 0);
    });
    expect(Math.max(...pips) - Math.min(...pips)).toBeLessThanOrEqual(1);
  });
  it('starts in the roll phase with 2 settlements and 2 roads each', () => {
    expect(s.phase).toBe('roll');
    for (const p of s.players) {
      expect(p.settlementsLeft).toBe(3);
      expect(p.roadsLeft).toBe(13);
      expect(totalVictoryPoints(s, p.id)).toBe(2);
    }
  });
  it('beginner starting spots go by seat, so any colours may play', () => {
    const plain = createGame(FOUR.slice(0, 3), { layout: 'beginner' }).state;
    const own = createGame(FOUR.slice(0, 3).map((p, i) => ({ ...p, color: ['#3aa36b', 'purple', 'white'][i] })), { layout: 'beginner' }).state;
    expect(own.players.map((p) => p.color)).toEqual(['#3aa36b', 'purple', 'white']);
    const spots = (g: typeof plain) => g.buildings.map((b) => (b ? b.owner : null));
    expect(spots(own)).toEqual(spots(plain));
  });
  it('a taken or missing colour falls back to a free preset', () => {
    const g = createGame(FOUR.slice(0, 3).map((p) => ({ ...p, color: 'red' })), { layout: 'random', seed: 3 }).state;
    expect(new Set(g.players.map((p) => p.color)).size).toBe(3);
    expect(g.players[0].color).toBe('red');
  });
});

describe('variable setup', () => {
  it('spiral from the NE corner follows the expected path', () => {
    const order = spiralOrder(0).map(([q, r]) => `${q},${r}`);
    const expected = [
      [1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [5, 2], [5, 3], [4, 4], [3, 5], [2, 4],
      [2, 3], [2, 2], [3, 2], [4, 2], [4, 3], [3, 4], [3, 3],
    ].map(([r, c]) => coordOf(r, c));
    expect(order).toEqual(expected);
  });
  it('random spiral boards use all discs and skip the desert', () => {
    for (let seed = 1; seed < 40; seed++) {
      const g = createGame(FOUR, { layout: 'random', seed }).state;
      const nums = g.board.hexes.map((h) => num(h)).filter((n): n is number => n !== null).sort((a, b) => a - b);
      expect(nums).toEqual([...SPIRAL_SEQUENCE].sort((a, b) => a - b));
      expect(num(g.board.hexes[g.board.desertHex!])).toBeNull();
      expect(g.robberHex).toBe(g.board.desertHex);
    }
  });
  it('balanced boards never put 6 and 8 next to each other', () => {
    for (let seed = 1; seed < 30; seed++) {
      const g = createGame(FOUR, { layout: 'random', numberPlacement: 'balanced', seed }).state;
      for (const h of g.board.hexes) {
        if (num(h) !== 6 && num(h) !== 8) continue;
        for (const n of h.neighbors) expect([6, 8]).not.toContain(num(g.board.hexes[n]));
      }
    }
  });
  it('snake-draft order and second-settlement resources', () => {
    let s = createGame(FOUR, { layout: 'random', seed: 3 }).state;
    const f = s.firstPlayer;
    expect(s.setupOrder).toEqual([0, 1, 2, 3, 3, 2, 1, 0].map((i) => (f + i) % 4));
    for (let i = 0; i < 8; i++) {
      const p = s.currentPlayer;
      expect(p).toBe(s.setupOrder[i]);
      const vertex = s.board.vertices.find((v) => !s.buildings[v.id] && v.neighbors.every((n) => !s.buildings[n]))!.id;
      const before = totalCards(s.players[p].hand);
      s = apply(s, p, { type: 'placeSetupSettlement', vertex }).state;
      const gained = totalCards(s.players[p].hand) - before;
      if (i < 4) expect(gained).toBe(0);
      else expect(gained).toBe(s.board.vertices[vertex].hexes.filter((h) => s.board.hexes[h].terrain !== 'desert').length);
      const bad = s.board.edges.find((e) => e.a !== vertex && e.b !== vertex)!.id;
      expect(applyAction(s, p, { type: 'placeSetupRoad', edge: bad }).ok).toBe(false);
      const edge = s.board.vertices[vertex].edges.find((e) => s.routes[e] === null)!;
      s = apply(s, p, { type: 'placeSetupRoad', edge }).state;
    }
    expect(s.phase).toBe('roll');
    expect(s.currentPlayer).toBe(f);
    expect(s.turn).toBe(1);
  });
  it('enforces the distance rule during setup', () => {
    let s = createGame(FOUR, { layout: 'random', seed: 5 }).state;
    const p = s.currentPlayer;
    s = apply(s, p, { type: 'placeSetupSettlement', vertex: 10 }).state;
    s = apply(s, p, { type: 'placeSetupRoad', edge: s.board.vertices[10].edges[0] }).state;
    const q = s.currentPlayer;
    for (const n of s.board.vertices[10].neighbors) {
      expect(applyAction(s, q, { type: 'placeSetupSettlement', vertex: n }).ok).toBe(false);
    }
    expect(applyAction(s, q, { type: 'placeSetupSettlement', vertex: 10 }).ok).toBe(false);
  });
});

function forceRoll(state: GameState, total: number): GameState {
  // Search for an rng state that yields the desired total (deterministic, test-only).
  for (let seed = 1; seed < 100000; seed++) {
    const s = patch(state, (x) => (x.rngState = seed));
    const r = applyAction(s, s.currentPlayer, { type: 'rollDice' });
    if (r.ok && r.state.dice![0] + r.state.dice![1] === total) return s;
  }
  throw new Error('no seed');
}

describe('production', () => {
  it('settlements produce 1, cities 2, robber blocks', () => {
    const base = beginnerGame();
    // Whoever settled on the forest 8 (it touches forest 11 and pasture 5 too): upgrade it to a city.
    const forest = base.board.hexes.find((h) => num(h) === 8 && h.terrain === 'forest')!;
    const v8 = forest.vertices.find((v) => base.buildings[v])!;
    const blue = base.buildings[v8]!.owner;
    let s = patch(base, (x) => {
      x.buildings[v8] = { owner: blue, kind: 'city' };
      x.currentPlayer = 0;
    });
    s = forceRoll(s, 8);
    const before = s.players[blue].hand.wood;
    const r = apply(s, s.currentPlayer, { type: 'rollDice' });
    expect(r.state.players[blue].hand.wood - before).toBe(2);
    // Now block the forest 8 with the robber.
    const forest8 = base.board.hexes.find((h) => num(h) === 8 && h.terrain === 'forest')!.id;
    let s2 = patch(s, (x) => (x.robberHex = forest8));
    s2 = forceRoll(s2, 8);
    const r2 = apply(s2, s2.currentPlayer, { type: 'rollDice' });
    expect(r2.state.players[blue].hand.wood).toBe(before);
    const prod = r2.events.find((e) => e.type === 'production');
    expect(prod && prod.type === 'production' && prod.blockedHexes).toContain(forest8);
  });

  it('supply shortage: nobody receives when several players are owed', () => {
    const base = beginnerGame();
    // wheat 5 (R3C2) touches White's 2nd settlement and Orange's 2nd settlement.
    let s = patch(base, (x) => {
      x.players[0].hand.wheat += x.bank.wheat - 1;
      x.bank.wheat = 1;
    });
    s = forceRoll(s, 5);
    const w = playerByColor(s, 'white');
    const o = playerByColor(s, 'orange');
    const wb = s.players[w].hand.wheat;
    const ob = s.players[o].hand.wheat;
    const r = apply(s, s.currentPlayer, { type: 'rollDice' });
    expect(r.state.players[w].hand.wheat).toBe(wb);
    expect(r.state.players[o].hand.wheat).toBe(ob);
    expect(r.state.bank.wheat).toBe(1);
  });

  it('supply shortage: a single affected player takes the remainder', () => {
    const base = beginnerGame();
    // Any settlement on a forest: make it a city (owed 2 wood) and the only building owed wood on that number.
    const v = base.buildings.findIndex((b, i) => b !== null && base.board.vertices[i].hexes.some((h) => base.board.hexes[h].terrain === 'forest'));
    const owner = base.buildings[v]!.owner;
    const forest = base.board.vertices[v].hexes.map((h) => base.board.hexes[h]).find((h) => h.terrain === 'forest')!;
    let s = patch(base, (x) => {
      x.buildings[v] = { owner, kind: 'city' };
      const other = (owner + 1) % x.players.length;
      x.players[other].hand.wood += x.bank.wood - 1;
      x.bank.wood = 1;
      for (const h of x.board.hexes) {
        if (h.terrain !== 'forest' || num(h) !== num(forest)) continue;
        for (const vv of h.vertices) if (x.buildings[vv] && x.buildings[vv]!.owner !== owner) x.buildings[vv] = null;
      }
    });
    s = forceRoll(s, num(forest)!);
    const before = s.players[owner].hand.wood;
    const r = apply(s, s.currentPlayer, { type: 'rollDice' });
    expect(r.state.players[owner].hand.wood).toBe(before + 1);
    expect(r.state.bank.wood).toBe(0);
  });
});

describe('rolling a 7', () => {
  it('players with more than 7 cards discard half (rounded down), then robber moves and steals', () => {
    const base = beginnerGame();
    const cur = base.currentPlayer;
    const victim = (cur + 1) % 4;
    let s = patch(base, (x) => {
      grant(x, victim, { ore: 6 }); // victim now has 9 cards -> discard 4
    });
    expect(totalCards(s.players[victim].hand)).toBe(9);
    s = forceRoll(s, 7);
    let r = apply(s, cur, { type: 'rollDice' });
    expect(r.state.phase).toBe('discard');
    expect(r.state.pendingDiscards[victim]).toBe(4);
    expect(applyAction(r.state, cur, { type: 'moveRobber', hex: 5 }).ok).toBe(false);
    expect(applyAction(r.state, victim, { type: 'discard', resources: rc({ ore: 3 }) }).ok).toBe(false);
    r = apply(r.state, victim, { type: 'discard', resources: rc({ ore: 4 }) });
    expect(r.state.phase).toBe('moveRobber');
    expect(applyAction(r.state, cur, { type: 'moveRobber', hex: r.state.robberHex! }).ok).toBe(false);
    // Move the robber onto a hex touching the victim's building.
    const vb = r.state.buildings.findIndex((b) => b?.owner === victim);
    const hex = r.state.board.vertices[vb].hexes.find((h) => h !== r.state.robberHex && !r.state.board.hexes[h].vertices.some((v) => r.state.buildings[v] && r.state.buildings[v]!.owner !== victim && r.state.buildings[v]!.owner !== cur))!;
    const before = totalCards(r.state.players[cur].hand);
    r = apply(r.state, cur, { type: 'moveRobber', hex });
    expect(r.state.phase).toBe('main');
    expect(totalCards(r.state.players[cur].hand)).toBe(before + 1);
    expect(r.events.some((e) => e.type === 'stolen')).toBe(true);
  });
});

describe('development cards', () => {
  it('cannot be played the turn they are bought; VP cards count immediately', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    let s = patch(base, (x) => {
      toMain(x, p);
      grant(x, p, { wool: 2, wheat: 2, ore: 2 });
      x.devDeck.push('knight');
    });
    let r = apply(s, p, { type: 'buyDevCard' });
    expect(r.state.players[p].devCards.at(-1)!.type).toBe('knight');
    expect(applyAction(r.state, p, { type: 'playKnight' }).ok).toBe(false);
    s = patch(r.state, (x) => x.devDeck.push('victoryPoint'));
    const vpBefore = totalVictoryPoints(s, p);
    r = apply(s, p, { type: 'buyDevCard' });
    expect(totalVictoryPoints(r.state, p)).toBe(vpBefore + 1);
  });

  it('only one development card per turn, and it may be played before rolling', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    const s = patch(base, (x) => {
      x.players[p].devCards.push({ type: 'knight', boughtTurn: 0 }, { type: 'monopoly', boughtTurn: 0 });
    });
    const r = apply(s, p, { type: 'playKnight' });
    expect(r.state.phase).toBe('moveRobber');
    const hex = r.state.board.hexes.find((h) => h.id !== r.state.robberHex)!.id;
    const r2 = apply(r.state, p, r.state.phase === 'moveRobber' ? { type: 'moveRobber', hex } : { type: 'rollDice' });
    const s3 = r2.state.phase === 'steal' ? apply(r2.state, p, { type: 'steal', victim: r2.state.stealCandidates[0] }).state : r2.state;
    expect(s3.phase).toBe('roll');
    expect(applyAction(s3, p, { type: 'playMonopoly', resource: 'ore' }).ok).toBe(false);
  });

  it('monopoly takes every card of that type from all opponents', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    const s = patch(base, (x) => {
      toMain(x, p);
      x.players[p].devCards.push({ type: 'monopoly', boughtTurn: 0 });
    });
    const totalWheat = s.players.reduce((n, pl) => n + pl.hand.wheat, 0);
    const r = apply(s, p, { type: 'playMonopoly', resource: 'wheat' });
    expect(r.state.players[p].hand.wheat).toBe(totalWheat);
    for (const pl of r.state.players) if (pl.id !== p) expect(pl.hand.wheat).toBe(0);
  });

  it('invention takes two cards from the supply', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    const s = patch(base, (x) => {
      toMain(x, p);
      x.players[p].devCards.push({ type: 'invention', boughtTurn: 0 });
    });
    expect(applyAction(s, p, { type: 'playInvention', resources: ['ore'] }).ok).toBe(false);
    const r = apply(s, p, { type: 'playInvention', resources: ['ore', 'ore'] });
    expect(r.state.players[p].hand.ore - s.players[p].hand.ore).toBe(2);
  });

  it('road crew places two free roads', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    let s = patch(base, (x) => {
      toMain(x, p);
      x.players[p].devCards.push({ type: 'roadBuilding', boughtTurn: 0 });
    });
    const res = { ...s.players[p].hand };
    s = apply(s, p, { type: 'playRoadBuilding' }).state;
    expect(s.phase).toBe('roadBuilding');
    const pick = (st: GameState) => st.board.edges.find((e) => st.routes[e.id] === null && applyAction(st, p, { type: 'placeFreeRoad', edge: e.id }).ok)!.id;
    s = apply(s, p, { type: 'placeFreeRoad', edge: pick(s) }).state;
    s = apply(s, p, { type: 'placeFreeRoad', edge: pick(s) }).state;
    expect(s.phase).toBe('main');
    expect(s.players[p].hand).toEqual(res);
    expect(s.players[p].roadsLeft).toBe(11);
  });
});

describe('longest route', () => {
  function chainState(): { s: GameState; red: number; path: number[] } {
    const s = createGame(FOUR, { layout: 'random', seed: 11 }).state;
    // Build a simple path along the coast for player 0.
    const coast = s.board.edges.filter((e) => e.coastal);
    const path: number[] = [];
    let v = coast[0].a;
    const used = new Set<number>();
    while (path.length < 8) {
      const next = s.board.vertices[v].edges.find((e) => s.board.edges[e].coastal && !used.has(e))!;
      used.add(next);
      path.push(next);
      const ed = s.board.edges[next];
      v = ed.a === v ? ed.b : ed.a;
    }
    return { s, red: 0, path };
  }

  it('awards the tile at 5, only transfers on strictly more, and handles breaks', () => {
    const { s: base, path } = chainState();
    const s = patch(base, (x) => {
      x.phase = 'main';
      x.turn = 5;
      x.currentPlayer = 0;
      const startV = x.board.edges[path[0]].a;
      x.buildings[startV] = { owner: 0, kind: 'settlement' };
    });
    let st = s;
    st = patch(st, (x) => grant(x, 0, { brick: 8, wood: 8 }));
    for (let i = 0; i < 4; i++) st = apply(st, 0, { type: 'buildRoad', edge: path[i] }).state;
    expect(st.longestRoadHolder).toBeNull();
    const r = apply(st, 0, { type: 'buildRoad', edge: path[4] });
    st = r.state;
    expect(longestRoadFor(st, 0)).toBe(5);
    expect(st.longestRoadHolder).toBe(0);
    expect(r.events.some((e) => e.type === 'longestRoadChanged')).toBe(true);
    // Opponent breaks it with a settlement in the middle (vertex between path[1] and path[2]).
    const shared = (i: number) => {
      const e1 = st.board.edges[path[i]];
      const e2 = st.board.edges[path[i + 1]];
      return [e1.a, e1.b].find((x) => x === e2.a || x === e2.b)!;
    };
    const mid = [1, 2, 0, 3].map(shared).find((v) => st.board.vertices[v].edges.length === 3)!;
    expect(mid).toBeDefined();
    st = patch(st, (x) => {
      x.currentPlayer = 1;
      x.routes[x.board.vertices[mid].edges.find((e) => x.routes[e] === null)!] = road(1);
      grant(x, 1, { brick: 1, wood: 1, wool: 1, wheat: 1 });
      // Clear distance rule neighbours for the test.
      for (const n of x.board.vertices[mid].neighbors) x.buildings[n] = null;
    });
    const r2 = apply(st, 1, { type: 'buildSettlement', vertex: mid });
    expect(longestRoadFor(r2.state, 0)).toBeLessThan(5);
    expect(r2.state.longestRoadHolder).toBeNull();
  });
});

describe('trading', () => {
  it('rejects like-for-like trades and offers of nothing; executes accepted offers', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    const q = (p + 1) % 4;
    const s = patch(base, (x) => {
      toMain(x, p);
      grant(x, p, { ore: 3 });
      grant(x, q, { wool: 2 });
    });
    // (Asking nothing back is an open offer, see openOffer.test.ts; offering nothing is no offer.)
    expect(applyAction(s, p, { type: 'offerTrade', give: rc({}), get: rc({ wool: 1 }) }).ok).toBe(false);
    expect(applyAction(s, p, { type: 'offerTrade', give: rc({ ore: 3 }), get: rc({ ore: 1 }) }).ok).toBe(false);
    let st = apply(s, p, { type: 'offerTrade', give: rc({ ore: 1 }), get: rc({ wool: 1 }) }).state;
    expect(applyAction(st, (p + 2) % 4, { type: 'acceptTrade', partner: q }).ok).toBe(false);
    st = apply(st, q, { type: 'respondTrade', accept: true }).state;
    const r = apply(st, p, { type: 'acceptTrade', partner: q });
    expect(r.state.players[q].hand.ore - s.players[q].hand.ore).toBe(1);
    expect(r.state.players[p].hand.wool - s.players[p].hand.wool).toBe(1);
    expect(r.state.trade).toBeNull();
  });

  it('counter-offers can be accepted by the active player', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    const q = (p + 1) % 4;
    let s = patch(base, (x) => {
      toMain(x, p);
      grant(x, p, { ore: 3 });
      grant(x, q, { wool: 2, brick: 2 });
    });
    s = apply(s, p, { type: 'offerTrade', give: rc({ ore: 1 }), get: rc({ wool: 1 }) }).state;
    s = apply(s, q, { type: 'counterTrade', give: rc({ brick: 1 }), get: rc({ ore: 2 }) }).state;
    const before = structuredClone(s.players);
    const r = apply(s, p, { type: 'acceptTrade', partner: q, counter: true });
    expect(r.state.players[p].hand.ore).toBe(before[p].hand.ore - 2);
    expect(r.state.players[p].hand.brick).toBe(before[p].hand.brick + 1);
  });

  it('bots sometimes counter a human offer, and every counter is legal', () => {
    const red = 0;
    const blue = 1;
    let counters = 0;
    for (let i = 0; i < 80; i++) {
      const s0 = patch(beginnerGame(), (x) => {
        toMain(x, red);
        grant(x, red, { brick: 2, wood: 2, wool: 2, wheat: 2, ore: 2 });
        grant(x, blue, { wool: i % 3, wheat: (i >> 1) % 3, ore: (i >> 2) % 3, brick: (i >> 3) % 2, wood: (i >> 4) % 2 });
      });
      const g = RESOURCES[i % 5];
      const w = RESOURCES[(i + 1 + ((i >> 2) % 4)) % 5];
      const s = apply(s0, red, { type: 'offerTrade', give: rc({ [g]: 1 }), get: rc({ [w]: 1 + (i % 2) }) }).state;
      const a = botDecide(s, blue, createBotMemory({ waitForHumans: true }), 'normal');
      if (a?.type !== 'counterTrade') continue;
      counters++;
      const t = s.trade!;
      expect(RESOURCES.every((r) => a.give[r] === t.get[r] && a.get[r] === t.give[r])).toBe(false);
      const after = apply(s, blue, a).state;
      expect(after.trade!.counters[blue]).toEqual({ give: a.give, get: a.get });
    }
    expect(counters).toBeGreaterThan(0);
  });

  it('maritime ratios follow owned ports', () => {
    const s = beginnerGame();
    // White's second settlement is not on a port; check every player has 4:1 by default.
    for (const pl of s.players) {
      const ratios = tradeRatios(s, pl.id);
      for (const r of RESOURCES) expect([2, 3, 4]).toContain(ratios[r]);
      // Commodities and oil aren't in this game: the bank takes none.
      expect([ratios.paper, ratios.oil]).toEqual([Infinity, Infinity]);
    }
    const port = s.board.ports.find((p) => p.type === 'ore')!;
    const st = patch(s, (x) => (x.buildings[port.vertices[0]] = { owner: 0, kind: 'settlement' }));
    expect(tradeRatios(st, 0).ore).toBe(2);
    expect(tradeRatios(st, 0).wool).toBeGreaterThanOrEqual(3);
  });
});

describe('redaction', () => {
  it('hides other hands, their development cards, the deck order and the seed', () => {
    const s = patch(beginnerGame(), (x) => {
      grant(x, 1, { ore: 2, wool: 1 });
      x.players[1].devCards.push({ type: 'monopoly', boughtTurn: 0 });
    });
    const v = redactState(s, 0);
    expect(v.players[0].hand).toEqual(s.players[0].hand);
    expect(totalCards(v.players[1].hand)).toBe(totalCards(s.players[1].hand));
    expect(v.players[1].hand.wool).toBe(0);
    expect(v.players[1].devCards.map((c) => c.type)).toEqual(s.players[1].devCards.map(() => 'knight'));
    expect(new Set(v.devDeck)).toEqual(new Set(['knight']));
    expect(v.options.seed).toBe(0);
    expect(v.rngState).toBe(0);
    expect(s.players[1].devCards.at(-1)!.type).toBe('monopoly');
  });
  it('counts a Victory Point card for its holder only', () => {
    const s = patch(beginnerGame(), (x) => x.players[1].devCards.push({ type: 'victoryPoint', boughtTurn: 0 }));
    expect(totalVictoryPoints(s, 1)).toBe(publicVictoryPoints(s, 1) + 1);
    expect(totalVictoryPoints(redactState(s, 0), 1)).toBe(publicVictoryPoints(s, 1));
  });
});

describe('victory', () => {
  it('a player wins immediately on their own turn at 10 points', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    const s = patch(base, (x) => {
      toMain(x, p);
      x.players[p].devCards.push(
        { type: 'victoryPoint', boughtTurn: 0 },
        { type: 'victoryPoint', boughtTurn: 0 },
        { type: 'victoryPoint', boughtTurn: 0 },
        { type: 'victoryPoint', boughtTurn: 0 },
        { type: 'victoryPoint', boughtTurn: 0 },
      );
      x.largestArmyHolder = p;
      x.players[p].playedKnights = 3;
      grant(x, p, { wheat: 2, ore: 3 });
    });
    expect(totalVictoryPoints(s, p)).toBe(9);
    const v = s.buildings.findIndex((b) => b?.owner === p);
    const r = apply(s, p, { type: 'buildCity', vertex: v });
    expect(r.state.phase).toBe('gameOver');
    expect(r.state.winner).toBe(p);
  });

  it('points gained on another turn only win at the start of your own turn', () => {
    const base = beginnerGame();
    const p = base.currentPlayer;
    const q = (p + 1) % 4;
    const s = patch(base, (x) => {
      toMain(x, p);
      for (let i = 0; i < 8; i++) x.players[q].devCards.push({ type: 'victoryPoint', boughtTurn: 0 });
    });
    expect(totalVictoryPoints(s, q)).toBe(10);
    expect(s.phase).toBe('main');
    const r = apply(s, p, { type: 'endTurn' });
    expect(r.state.winner).toBe(q);
  });
});

describe('taking a piece back', () => {
  const ready = () =>
    patch(beginnerGame(), (x) => {
      toMain(x, 0);
      grant(x, 0, { brick: 4, wood: 4, wool: 2, wheat: 4, ore: 3 });
    });
  const strip = (g: GameState) => ({ ...g, seq: 0, undo: null });

  it('puts a road back exactly as it was, cards and all', () => {
    const s = ready();
    const r = apply(s, 0, { type: 'buildRoad', edge: legalRoads(s, 0)[0] });
    expect(canUndo(r.state, 0)).toBe(true);
    expect(canUndo(r.state, 1)).toBe(false);
    const u = apply(r.state, 0, { type: 'undo' });
    expect(strip(u.state)).toEqual(strip(s));
    expect(u.state.seq).toBe(r.state.seq + 1);
    const e = u.events.find((x) => x.type === 'undone')!;
    expect(e).toMatchObject({ type: 'undone', player: 0, kind: 'road', refund: rc({ brick: 1, wood: 1 }) });
  });

  it('takes back several builds one at a time, and a city back to a settlement', () => {
    const s = ready();
    const v = legalCities(s, 0)[0];
    const a = apply(s, 0, { type: 'buildRoad', edge: legalRoads(s, 0)[0] });
    const b = apply(a.state, 0, { type: 'buildCity', vertex: v });
    const u1 = apply(b.state, 0, { type: 'undo' });
    expect(u1.state.buildings[v]?.kind).toBe('settlement');
    expect(u1.events.find((x) => x.type === 'undone')).toMatchObject({ kind: 'city', at: v });
    const u2 = apply(u1.state, 0, { type: 'undo' });
    expect(strip(u2.state)).toEqual(strip(s));
    expect(canUndo(u2.state, 0)).toBe(false);
  });

  it('is gone once anything else happens', () => {
    const s = ready();
    const r = apply(s, 0, { type: 'buildRoad', edge: legalRoads(s, 0)[0] });
    const t = apply(r.state, 0, { type: 'buyDevCard' });
    expect(canUndo(t.state, 0)).toBe(false);
    expect(() => apply(t.state, 0, { type: 'undo' })).toThrow(/Nothing to take back/);
  });

  it('returns the starting cards of a second set-up settlement', () => {
    let g = createGame(FOUR, { layout: 'random', seed: 5 }).state;
    // Play the set-up up to the last settlement.
    while (!(g.setupRound === 2 && g.phase === 'setupSettlement' && g.setupIndex === g.setupOrder.length - 1)) {
      const p = g.currentPlayer;
      g = g.phase === 'setupSettlement' ? apply(g, p, { type: 'placeSetupSettlement', vertex: legalSetupSettlements(g)[0] }).state : apply(g, p, { type: 'placeSetupRoad', edge: legalSetupRoads(g)[0] }).state;
    }
    const p = g.currentPlayer;
    const placed = apply(g, p, { type: 'placeSetupSettlement', vertex: legalSetupSettlements(g)[0] });
    const back = apply(placed.state, p, { type: 'undo' });
    expect(back.state.players[p].hand).toEqual(g.players[p].hand);
    expect(back.state.phase).toBe('setupSettlement');
    const e = back.events.find((x) => x.type === 'undone');
    expect(e && e.type === 'undone' && totalCards(e.returned)).toBe(totalCards(placed.state.players[p].hand) - totalCards(g.players[p].hand));
  });

  it('keeps the earlier state hidden in what others see', () => {
    const s = ready();
    const r = apply(s, 0, { type: 'buildRoad', edge: legalRoads(s, 0)[0] });
    const seen = redactState(r.state, 1);
    expect(seen.undo?.before.players[0].hand.brick).toBe(0);
  });
});
