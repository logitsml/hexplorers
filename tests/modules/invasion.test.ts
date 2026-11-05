// Invasion: the castle island, landings, conquest, the 7 without a robber, the muster deck,
// marching and battles alone, the same with the garrisons' ranks (on patched states, since the
// garrisons are written elsewhere), and bot games and the fuzzer.

import { afterAll, describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  isLegalSettlement,
  legalActions,
  legalCities,
  legalRoads,
  publicVictoryPoints,
  redactState,
  rowColToAxial,
  Rng,
  totalVictoryPoints,
  tradeRatios,
  type Action,
  type GameEvent,
  type GameOptions,
  type GameState,
  type ModuleId,
  type PlayerId,
  type Warden,
} from '../../src/engine';
import { Ctx } from '../../src/engine/ctx';
import { botDecide, createBotMemory, type BotDifficulty } from '../../src/engine/ai';
import { invasion, invasionTarget } from '../../src/engine/modules/invasion';
import { MUSTER_DECK, MUSTER_TOTAL } from '../../src/engine/modules/invasion/muster';
import { landingHex, RAIDERS } from '../../src/engine/modules/invasion/raids';
import { edgesWithin, topology } from '../../src/engine/modules/invasion/topology';
import type { InvasionState, MusterCard } from '../../src/engine/modules/invasion/types';
import { fightBattles } from '../../src/engine/modules/invasion/wardens';
import { castleEdges } from '../../src/engine/modules/garrisons/wardens';
import { buildingConquered, cutOff, isConquered } from '../../src/engine/modules/shared';
import { FOUR, apply, grant, patch, rc, road, toMain } from '../helpers';
import { checkInvariants, runBotGame, runFuzzGame, type GameResult, cardsInPlay } from '../sim-harness';
import { EVENT_FACES } from '../../src/engine/modules/guilds/rules';
import { slow, timeout } from '../tier';

const ALONE: ModuleId[] = ['invasion'];
const SIEGE: ModuleId[] = ['guilds', 'garrisons', 'invasion'];
const TARGET = invasionTarget(ALONE);

/** A fresh invasion island (no buildings yet) in the main phase of `player`'s turn. */
function island(opts: Partial<GameOptions> = {}, player = 0): GameState {
  const g = createGame(FOUR, { layout: 'random', seed: 11, modules: ALONE, victoryPoints: TARGET, ...opts }).state;
  return patch(g, (x) => {
    x.turn = 5;
    x.setupIndex = x.setupOrder.length;
    toMain(x, player);
  });
}

const inv = (s: GameState): InvasionState => s.ext.invasion!;
const coast = (s: GameState) => topology(s.board).coast;
const castle = (s: GameState) => topology(s.board).castle!;
/** The coastal hex bearing `n`. */
const hexOf = (s: GameState, n: number) => coast(s).find((h) => s.board.hexes[h].numbers.includes(n))!;
const events = (evs: GameEvent[], type: string) => evs.filter((e) => e.type === type) as unknown as Record<string, unknown>[];

let nextId = 100;
function putWarden(s: GameState, owner: PlayerId, edge: number, extra: Partial<Warden> = {}): Warden {
  const w: Warden = { id: nextId++, owner, rank: 1, mustered: true, vertex: null, edge, musteredTurn: 0, ...extra };
  s.wardens.push(w);
  // (The shared warden counter moves past this one.)
  s.nextWardenId = Math.max(s.nextWardenId ?? 1, w.id + 1);
  return w;
}

/** A dice-stream state whose next die rolls are `faces` (searched for, so tests don't depend on luck). */
function streamFor(...faces: number[]): number {
  for (let seed = 1; seed < 5_000_000; seed++) {
    const r = new Rng(seed);
    if (faces.every((f) => r.die() === f)) return seed;
  }
  throw new Error(`no stream rolls ${faces}`);
}

/** A dice stream that rolls `a` then `b`, after which `then` holds of what comes next. */
function streamThen(a: number, b: number, then: (r: Rng) => boolean): number {
  for (let seed = 1; seed < 5_000_000; seed++) {
    const r = new Rng(seed);
    if (r.die() === a && r.die() === b && then(r)) return seed;
  }
  throw new Error(`no stream rolls ${a}, ${b}`);
}

/** Run the battles on a copy of `s` with the given dice to come. */
function battles(s: GameState, ...faces: number[]): { s: GameState; events: GameEvent[] } {
  const c = new Ctx(patch(s, (x) => (x.rngState = streamFor(...faces))));
  fightBattles(c);
  return { s: c.s, events: c.events };
}

/** An edge of `hex` with the given orientation (side index mod 3), preferring one on no other coastal hex. */
function sideOf(s: GameState, hex: number, orientation: number, k = 0): number {
  return s.board.hexes[hex].edges.filter((_, i) => i % 3 === orientation)[k];
}

describe('the castle island', () => {
  const s = island();
  const at = (row: number, col: number) => {
    const [q, r] = rowColToAxial(row, col);
    return s.board.hexes.find((h) => h.q === q && h.r === r)!;
  };

  it('puts the castle on the lower-left corner and the desert on the corner opposite', () => {
    expect(at(5, 1).terrain).toBe('castle');
    expect(at(5, 1).numbers).toEqual([]);
    expect(s.board.features.castle).toBe(at(5, 1).id);
    expect(at(1, 3).terrain).toBe('desert');
  });

  it('brings every number to the coast, a different one on each of its numbered hexes', () => {
    const numbered = coast(s).filter((h) => s.board.hexes[h].numbers.length > 0);
    const nums = numbered.flatMap((h) => s.board.hexes[h].numbers);
    expect(new Set(nums).size).toBe(nums.length);
    expect(new Set(nums)).toEqual(new Set([2, 3, 4, 5, 6, 8, 9, 10, 11, 12]));
  });

  it('deals the coast’s numbers afresh with the seed', () => {
    const other = island({ seed: 12 });
    expect(other.board.hexes.map((h) => h.numbers)).not.toEqual(s.board.hexes.map((h) => h.numbers));
  });
});

describe('set-up', () => {
  const g = createGame(FOUR, { layout: 'random', seed: 3, modules: ALONE, victoryPoints: TARGET }).state;

  it('puts a raider on the coastal 2 and 12, and no robber on the board', () => {
    const i = inv(g);
    expect(i.raiders[hexOf(g, 2)]).toBe(1);
    expect(i.raiders[hexOf(g, 12)]).toBe(1);
    expect(i.raiders.reduce((a, b) => a + b, 0)).toBe(2);
    expect(i.supply).toBe(RAIDERS - 2);
    expect(g.robberHex).toBeNull();
  });

  it('replaces the development cards with the 26 muster cards', () => {
    expect(g.devDeck).toEqual([]);
    const i = inv(g);
    expect(i.deck).toHaveLength(MUSTER_TOTAL);
    for (const [card, n] of Object.entries(MUSTER_DECK)) expect(i.deck.filter((c) => c === card)).toHaveLength(n);
    expect(legalActions(island(), 0).some((a) => a.type === 'buyDevCard')).toBe(false);
  });

  it('makes the second set-up building a city', () => {
    let s = g;
    const mem = s.players.map(() => createBotMemory());
    while (s.phase === 'setupSettlement' || s.phase === 'setupRoad') {
      const p = s.currentPlayer;
      s = apply(s, p, botDecide(s, p, mem[p], 'normal')!).state;
    }
    for (const p of s.players) {
      const mine = s.buildings.filter((b) => b?.owner === p.id);
      expect(mine.map((b) => b!.kind).sort()).toEqual(['city', 'settlement']);
    }
  });

  it('leaves the deck to the guilds when they are in play, and counts three prisoners a point', () => {
    const s = island({ modules: SIEGE });
    expect(inv(s).deck).toEqual([]);
    expect(applyAction(s, 0, { type: 'invasion/buy' }).ok).toBe(false);
    s.ext.invasion!.prisoners[0] = 5;
    expect(totalVictoryPoints(s, 0)).toBe(1);
  });
});

describe('landings', () => {
  /** Player 0 with a road to an open inner intersection and the cards for a settlement there. */
  function readyToSettle(opts: Partial<GameOptions> = {}): { s: GameState; v: number } {
    let v = -1;
    const s = patch(island(opts), (x) => {
      v = x.board.vertices.find((vx) => vx.hexes.length === 3 && vx.hexes.every((h) => x.board.hexes[h].terrain !== 'castle'))!.id;
      x.routes[x.board.vertices[v].edges[0]] = road(0);
      x.players[0].roadsLeft--;
      grant(x, 0, { brick: 1, wood: 1, wool: 1, wheat: 1 });
    });
    return { s, v };
  }

  it('sends three raiders at three different totals, never 7, for each settlement', () => {
    for (let seed = 0; seed < 20; seed++) {
      const { s, v } = readyToSettle();
      const r = apply(patch(s, (x) => (x.rngState = seed * 7919 + 1)), 0, { type: 'buildSettlement', vertex: v });
      const landed = events(r.events, 'invasion/landed');
      expect(landed).toHaveLength(3);
      const totals = landed.map((e) => e.number as number);
      expect(new Set(totals).size).toBe(3);
      expect(totals).not.toContain(7);
      for (const e of landed) if (e.hex !== null) expect(s.board.hexes[e.hex as number].numbers).toContain(e.number);
      checkInvariants(r.state, 'landings');
    }
  });

  it('honours the landings knob', () => {
    const { s, v } = readyToSettle({ knobs: { landingsPerBuilding: 1 } });
    expect(events(apply(s, 0, { type: 'buildSettlement', vertex: v }).events, 'invasion/landed')).toHaveLength(1);
  });

  it('a city sets them off too, and nothing can take the building back', () => {
    const s = patch(island(), (x) => {
      const v = x.board.vertices.find((vx) => vx.hexes.length === 3)!.id;
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      x.players[0].settlementsLeft--;
      grant(x, 0, { wheat: 2, ore: 3 });
    });
    const v = s.buildings.findIndex((b) => b !== null);
    const r = apply(s, 0, { type: 'buildCity', vertex: v });
    expect(events(r.events, 'invasion/landed').length).toBe(3);
    expect(r.state.undo).toBeNull();
  });

  it('stops when the supply runs out', () => {
    const { s, v } = readyToSettle();
    const r = apply(patch(s, (x) => (inv(x).supply = 1, inv(x).prisoners[1] = RAIDERS - 3)), 0, { type: 'buildSettlement', vertex: v });
    expect(events(r.events, 'invasion/supplyEmpty')).toHaveLength(1);
    expect(events(r.events, 'invasion/landed').length).toBeLessThanOrEqual(1);
  });

  it('picks the hex with fewest raiders, then the first clockwise from the castle, and never a fourth', () => {
    const s = patch(island(), (x) => {
      // Give three coastal hexes the 5, and take it from the one that had it.
      x.board.hexes[hexOf(x, 5)].numbers = [];
      for (const h of coast(x).slice(2, 5)) x.board.hexes[h].numbers = [5];
    });
    const [a, b, c] = coast(s).slice(2, 5);
    expect(landingHex(s, 5)).toBe(a);
    inv(s).raiders[a] = 1;
    expect(landingHex(s, 5)).toBe(b);
    inv(s).raiders[b] = 1;
    inv(s).raiders[c] = 2;
    expect(landingHex(s, 5)).toBe(a);
    inv(s).raiders[a] = 3;
    inv(s).raiders[b] = 3;
    inv(s).raiders[c] = 3;
    expect(landingHex(s, 5)).toBeNull();
    expect(landingHex(s, 7)).toBeNull();
  });

  it('lands a raider at the production number on the event die ship, never on a 7', () => {
    const base = island({ modules: SIEGE }, 0);
    for (const [d1, d2] of [
      [2, 4],
      [3, 4],
    ]) {
      const s = patch(base, (x) => {
        x.phase = 'roll';
        x.hasRolled = false;
        // (The guilds draw the event die's face after the production dice.)
        x.rngState = streamThen(d1, d2, (r) => EVENT_FACES[r.int(EVENT_FACES.length)] === 'ship');
      });
      const r = apply(s, 0, { type: 'rollDice' });
      const landed = events(r.events, 'invasion/landed');
      if (d1 + d2 === 7) expect(landed).toHaveLength(0);
      else {
        expect(landed).toHaveLength(1);
        expect(landed[0].hex).toBe(hexOf(s, 6));
        expect(inv(r.state).raiders[hexOf(s, 6)]).toBe(1);
      }
    }
  });

  it('lands a raider for each guild improvement, unless the knob says not', () => {
    for (const on of [true, false]) {
      const s = island({ modules: SIEGE, knobs: { improvementLandings: on } });
      const c = new Ctx(structuredClone(s));
      c.emit({ type: 'guilds/improved', player: 0 } as unknown as GameEvent);
      invasion.hooks!.afterAction!(c);
      expect(events(c.events, 'invasion/landed')).toHaveLength(on ? 1 : 0);
    }
  });

  it('rolls an improvement’s landing once: on a 7 nothing lands, where a building’s rolls again', () => {
    const s = island({ modules: SIEGE });
    const improved = new Ctx(patch(s, (x) => (x.rngState = streamFor(3, 4))));
    improved.emit({ type: 'guilds/improved', player: 0 } as unknown as GameEvent);
    invasion.hooks!.afterAction!(improved);
    expect(events(improved.events, 'invasion/landed')).toEqual([{ type: 'invasion/landed', player: 0, cause: 'improvement', dice: [3, 4], number: 7, hex: null, raiders: 0 }]);
    expect(inv(improved.s).raiders).toEqual(inv(s).raiders);
    // A building's landing, on the same dice, rolls past the 7 (one landing each in All Hands).
    const built = new Ctx(
      patch(s, (x) => {
        x.rngState = streamFor(3, 4);
        x.options = { ...x.options, knobs: { landingsPerBuilding: 1 } };
      }),
    );
    invasion.hooks!.afterBuild!(built, 0, 'settlement', 0, 'threat');
    const landed = events(built.events, 'invasion/landed');
    expect(landed).toHaveLength(1);
    expect(landed[0].number).not.toBe(7);
  });
});

describe('conquest', () => {
  /** Hex `h` conquered, with a settlement of player 1 on a corner touching nothing but it. */
  function conquered(): { s: GameState; h: number; v: number } {
    let h = -1;
    let v = -1;
    const s = patch(island(), (x) => {
      for (const c of coast(x)) {
        const lone = x.board.hexes[c].vertices.find((vx) => x.board.vertices[vx].hexes.length === 1);
        if (lone !== undefined && x.board.hexes[c].numbers.length > 0) {
          h = c;
          v = lone;
          break;
        }
      }
      inv(x).raiders[h] = 3;
      x.buildings[v] = { owner: 1, kind: 'settlement' };
      x.players[1].settlementsLeft--;
    });
    return { s, h, v };
  }

  it('takes three raiders, stops production and every building on its edges and corners', () => {
    const { s, h } = conquered();
    expect(isConquered(s, h)).toBe(true);
    expect(invasion.hooks!.hexBlocked!(s, s.board.hexes[h])).toBe(true);
    // A road of player 0 beside the hex, and a free corner of it.
    const corner = s.board.hexes[h].vertices.find((vx) => !s.buildings[vx] && s.board.vertices[vx].neighbors.every((n) => !s.buildings[n]))!;
    const t = patch(s, (x) => {
      for (const e of x.board.vertices[corner].edges) {
        x.routes[e] = road(0);
        x.players[0].roadsLeft--;
        break;
      }
    });
    expect(isLegalSettlement(t, 0, corner)).toBe(false);
    for (const e of s.board.hexes[h].edges) expect(legalRoads(t, 0)).not.toContain(e);
  });

  it('a building touching only conquered land is worth nothing and its harbour shuts', () => {
    const { s, v } = conquered();
    expect(buildingConquered(s, v)).toBe(true);
    expect(publicVictoryPoints(s, 1)).toBe(0);
    // Free the hex: the point comes back.
    const freed = patch(s, (x) => (inv(x).raiders[s.board.vertices[v].hexes[0]] = 2));
    expect(publicVictoryPoints(freed, 1)).toBe(1);
  });

  it('a conquered settlement cannot become a city', () => {
    const { s, v } = conquered();
    const t = patch(s, (x) => toMain(x, 1));
    expect(legalCities(t, 1)).not.toContain(v);
  });

  it('closes the harbour of a conquered building, and only that one', () => {
    const s = island();
    const port = s.board.ports.find((p) => p.type !== 'any')!;
    const v = port.vertices[0];
    const t = patch(s, (x) => {
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      for (const h of x.board.vertices[v].hexes) if (x.board.hexes[h].terrain !== 'sea') inv(x).raiders[h] = 3;
    });
    expect(tradeRatios(patch(t, (x) => x.board.vertices[v].hexes.forEach((h) => (inv(x).raiders[h] = 0))), 0)[port.type as 'wool']).toBe(2);
    expect(tradeRatios(t, 0)[port.type as 'wool']).toBe(4);
  });

  it('a cut-off seat keeps its points but produces nothing', () => {
    const { s, v } = conquered();
    const t = patch(s, (x) => (x.buildings[v] = { owner: 1, kind: 'city', seat: 'learning' }));
    expect(buildingConquered(t, v)).toBe(false);
    expect(cutOff(t, v)).toBe(true);
    expect(publicVictoryPoints(t, 1)).toBe(2);
    const hex = t.board.hexes[t.board.vertices[v].hexes[0]];
    expect(invasion.hooks!.yields!(t, hex, v, t.buildings[v]!, [{ player: 1, hex: hex.id, vertex: v, resource: 'ore', amount: 2 }])).toEqual([]);
  });
});

describe('the 7', () => {
  const seven = (s: GameState) =>
    patch(s, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
      x.rngState = streamFor(3, 4);
    });

  it('moves no robber: the roller steals from any player holding cards, never coins', () => {
    const s = seven(
      patch(island(), (x) => {
        grant(x, 1, { brick: 2 });
        grant(x, 2, { wool: 1 });
        x.players[2].coins = 5;
      }),
    );
    const r = apply(s, 0, { type: 'rollDice' });
    expect(r.state.phase).toBe('steal');
    expect(r.state.robberHex).toBeNull();
    expect(r.state.stealCandidates).toEqual([1, 2]);
    const stole = apply(r.state, 0, { type: 'steal', victim: 2 });
    const t = stole.state;
    expect(t.players[0].hand.wool).toBe(1);
    expect(t.players[2].coins).toBe(5);
    expect(t.phase).toBe('main');
    // (No blocker made the theft: the table is told it was the 7's.)
    expect(stole.events).toContainEqual({ type: 'stolen', thief: 0, victim: 2, resource: 'wool', by: 'seven' });
  });

  it('steals at once from the only player with cards', () => {
    const s = seven(patch(island(), (x) => grant(x, 3, { ore: 1 })));
    const r = apply(s, 0, { type: 'rollDice' });
    expect(r.state.phase).toBe('main');
    expect(r.state.players[0].hand.ore).toBe(1);
  });

  it('with Oil, may name oil: a player holding only oil can be robbed, and a lone victim holding some is a choice', () => {
    const s = seven(patch(island({ modules: ['invasion', 'oil'] }), (x) => grant(x, 2, { oil: 2 })));
    const r = apply(s, 0, { type: 'rollDice' });
    expect(r.state.phase).toBe('steal');
    expect(r.state.stealCandidates).toEqual([2]);
    expect(legalActions(r.state, 0)).toEqual([{ type: 'steal', victim: 2, oil: true }]);
    const t = apply(r.state, 0, { type: 'steal', victim: 2, oil: true }).state;
    expect([t.players[0].hand.oil, t.players[2].hand.oil]).toEqual([1, 1]);
  });

  describe('with Sea Lanes (rule 4)', () => {
    const sea = (knobs: GameOptions['knobs'] = {}, map = 'allHands') => createGame(FOUR, { seed: 1, map, modules: ['sea', 'invasion'], victoryPoints: 16, knobs }).state;
    /** Player 0 about to roll a 7 with the corsair at sea, and player 2 holding a card far from any ship. */
    const sevenAtSea = (knobs: GameOptions['knobs'] = {}) =>
      seven(
        patch(sea(knobs), (x) => {
          x.turn = 5;
          x.setupIndex = x.setupOrder.length;
          toMain(x, 0);
          x.ext.sea!.corsair = x.board.hexes.find((h) => h.terrain === 'sea')!.id;
          grant(x, 2, { wool: 1 });
        }),
      );

    it('takes the corsair off the board: Invasion takes over the 7, so no blocker moves', () => {
      // A map whose corsair starts at sea loses it at set-up.
      expect(createGame(FOUR, { seed: 1, map: 'archipelago', modules: ['sea'], victoryPoints: 14 }).state.ext.sea!.corsair).not.toBeNull();
      expect(sea({}, 'archipelago').ext.sea!.corsair).toBeNull();
      const s = sevenAtSea();
      const r = apply(s, 0, { type: 'rollDice' });
      expect(r.state.pending).toEqual([]);
      expect(r.state.ext.sea!.corsair).toBe(s.ext.sea!.corsair);
      expect(r.state.players[0].hand.wool).toBe(1);
      expect(r.state.phase).toBe('main');
    });

    it('keeps the corsair with the corsairStays knob (All Hands): every 7 moves it, and its theft takes from anyone', () => {
      expect(sea({ corsairStays: true }, 'archipelago').ext.sea!.corsair).not.toBeNull();
      const s = sevenAtSea({ corsairStays: true });
      const r = apply(s, 0, { type: 'rollDice' });
      expect(r.state.pending.at(-1)).toMatchObject({ kind: 'sea/blocker', players: [0] });
      const moves = legalActions(r.state, 0);
      expect(moves.length).toBeGreaterThan(0);
      expect(moves.every((a) => a.type === 'sea/moveCorsair')).toBe(true);
      const t = apply(r.state, 0, moves[0]).state;
      expect(t.ext.sea!.corsair).toBe((moves[0] as { hex: number }).hex);
      expect(t.players[0].hand.wool).toBe(1);
    });
  });
});

describe('the muster deck', () => {
  function buying(top: MusterCard[], fn: (x: GameState) => void = () => {}): GameState {
    return patch(island(), (x) => {
      grant(x, 0, { wool: 1, wheat: 1, ore: 1 });
      const i = inv(x);
      // The cards named go on top, in the order they'll be drawn.
      for (const c of top) i.deck.splice(i.deck.lastIndexOf(c), 1);
      i.deck.push(...top.slice().reverse());
      fn(x);
    });
  }

  it('costs a development card and owes the card drawn at once', () => {
    const s = buying(['levy']);
    expect(legalActions(s, 0)).toContainEqual({ type: 'invasion/buy' });
    const r = apply(s, 0, { type: 'invasion/buy' });
    expect(r.state.players[0].hand).toEqual(rc({}));
    expect(r.state.pending.at(-1)).toEqual({ kind: 'invasion/card', players: [0], data: { card: 'levy' } });
    // Nothing else may happen first.
    expect(applyAction(r.state, 0, { type: 'endTurn' }).ok).toBe(false);
    expect(applyAction(r.state, 0, { type: 'invasion/buy' }).ok).toBe(false);
    checkInvariants(r.state, 'muster');
  });

  it('a levy raises a warden on an empty castle edge', () => {
    const s = apply(buying(['levy'], (x) => putWarden(x, 1, x.board.hexes[castle(x)].edges[0])), 0, { type: 'invasion/buy' }).state;
    const answers = legalActions(s, 0);
    expect(answers.map((a) => (a as { edge: number }).edge).sort()).toEqual(s.board.hexes[castle(s)].edges.slice(1).sort());
    expect(applyAction(s, 0, { type: 'invasion/levy', edge: s.board.hexes[castle(s)].edges[0] }).ok).toBe(false);
    const t = apply(s, 0, answers[0]).state;
    const w = t.wardens.find((x) => x.owner === 0)!;
    expect(w).toMatchObject({ rank: 1, mustered: true, vertex: null });
    expect(t.pending).toEqual([]);
    expect(inv(t).discard).toContain('levy');
  });

  it('an outrider raises a warden on any empty edge of the home island', () => {
    const s = apply(buying(['outrider']), 0, { type: 'invasion/buy' }).state;
    const edges = legalActions(s, 0).map((a) => (a as { edge: number }).edge);
    expect(edges).toHaveLength(s.board.edges.length);
    const t = apply(s, 0, { type: 'invasion/outrider', edge: edges[40] }).state;
    expect(t.wardens.find((w) => w.owner === 0)!.edge).toBe(edges[40]);
  });

  it('an ambush takes a raider prisoner', () => {
    const s = apply(buying(['ambush']), 0, { type: 'invasion/buy' }).state;
    expect(legalActions(s, 0)).toHaveLength(2);
    expect(legalActions(s, 0)).toEqual(expect.arrayContaining([
      { type: 'invasion/ambush', hex: hexOf(s, 12) },
      { type: 'invasion/ambush', hex: hexOf(s, 2) },
    ]));
    const t = apply(s, 0, { type: 'invasion/ambush', hex: hexOf(s, 2) }).state;
    expect(inv(t).prisoners[0]).toBe(1);
    expect(inv(t).raiders[hexOf(t, 2)]).toBe(0);
  });

  it('an ambush with no raider about is set aside for the next card', () => {
    const s = buying(['ambush', 'levy'], (x) => inv(x).raiders.fill(0));
    const r = apply(s, 0, { type: 'invasion/buy' });
    expect(events(r.events, 'invasion/drew').map((e) => [e.card, e.wasted])).toEqual([
      ['ambush', true],
      ['levy', false],
    ]);
    expect(r.state.pending.at(-1)!.data).toEqual({ card: 'levy' });
  });

  it('a turncoat pays 2 coins and leads two raiders from two hexes to two others', () => {
    const s = apply(buying(['turncoat']), 0, { type: 'invasion/buy' }).state;
    const answers = legalActions(s, 0) as Extract<Action, { type: 'invasion/turncoat' }>[];
    // From the 2 and the 12 to any two of the other eight numbered or desert coastal hexes.
    expect(answers).toHaveLength(36);
    for (const a of answers) expect(a.moves.map((m) => m.from).sort()).toEqual([hexOf(s, 2), hexOf(s, 12)].sort());
    const to = [hexOf(s, 6), hexOf(s, 8)];
    const t = apply(s, 0, { type: 'invasion/turncoat', moves: [{ from: hexOf(s, 2), to: to[1] }, { from: hexOf(s, 12), to: to[0] }] }).state;
    expect(t.players[0].coins).toBe(2);
    expect(to.map((h) => inv(t).raiders[h])).toEqual([1, 1]);
    expect(inv(t).raiders[hexOf(t, 2)]).toBe(0);
    // Not from one hex twice, nor onto a source.
    const u = apply(buying(['turncoat']), 0, { type: 'invasion/buy' }).state;
    expect(applyAction(u, 0, { type: 'invasion/turncoat', moves: [{ from: hexOf(u, 2), to: to[0] }, { from: hexOf(u, 2), to: to[1] }] }).ok).toBe(false);
    expect(applyAction(u, 0, { type: 'invasion/turncoat', moves: [{ from: hexOf(u, 2), to: hexOf(u, 12) }, { from: hexOf(u, 12), to: to[1] }] }).ok).toBe(false);
  });

  it('a turncoat takes from the supply what the board lacks, and never onto a conquered hex', () => {
    const s = apply(
      buying(['turncoat'], (x) => {
        inv(x).raiders.fill(0);
        inv(x).raiders[hexOf(x, 6)] = 3;
        inv(x).supply = RAIDERS - 3;
      }),
      0,
      { type: 'invasion/buy' },
    ).state;
    const answers = legalActions(s, 0) as Extract<Action, { type: 'invasion/turncoat' }>[];
    for (const a of answers) {
      expect(a.moves.map((m) => m.from)).toEqual([hexOf(s, 6), null]);
      expect(a.moves.map((m) => m.to)).not.toContain(hexOf(s, 6));
    }
    const t = apply(s, 0, answers[0]).state;
    expect(inv(t).supply).toBe(RAIDERS - 4);
    checkInvariants(t, 'turncoat');
  });

  it('shuffles the played cards back once the deck runs out', () => {
    const s = buying([], (x) => {
      inv(x).discard = inv(x).deck.splice(0, MUSTER_TOTAL - 1);
    });
    const r = apply(s, 0, { type: 'invasion/buy' });
    const card = (r.state.pending.at(-1)?.data as { card: MusterCard } | undefined)?.card;
    // The last card was drawn; its decision may still be owed.
    expect(inv(r.state).deck.length + inv(r.state).discard.length + (card ? 1 : 0)).toBe(MUSTER_TOTAL);
    const t = apply(r.state, 0, legalActions(r.state, 0)[0]).state;
    grant(t, 0, { wool: 1, wheat: 1, ore: 1 });
    const u = apply(t, 0, { type: 'invasion/buy' }).state;
    expect(inv(u).deck.length).toBeGreaterThan(0);
    expect(inv(u).discard).toHaveLength(0);
  });

  it('is refused without the cards, off your turn or outside the main phase', () => {
    const s = island();
    expect(applyAction(s, 0, { type: 'invasion/buy' }).ok).toBe(false);
    const t = buying(['levy']);
    expect(applyAction(t, 1, { type: 'invasion/buy' }).ok).toBe(false);
    expect(applyAction(patch(t, (x) => ((x.phase = 'roll'), (x.hasRolled = false))), 0, { type: 'invasion/buy' }).ok).toBe(false);
  });

  it('hides the deck order from every seat', () => {
    const s = island();
    const v = redactState(s, 0);
    expect(new Set(inv(v).deck)).toEqual(new Set(['levy']));
    expect(inv(v).deck).toHaveLength(MUSTER_TOTAL);
  });
});

describe('marching alone', () => {
  /** Player 0 with a warden on a castle edge, about to end the turn. */
  function atCastle(fn: (x: GameState) => void = () => {}) {
    let w!: Warden;
    const s = patch(island(), (x) => {
      w = putWarden(x, 0, x.board.hexes[castle(x)].edges[0]);
      fn(x);
    });
    return { s: apply(s, 0, { type: 'endTurn' }).state, w };
  }

  it('owes a march, and a warden on a castle edge must walk off it', () => {
    const { s } = atCastle();
    expect(s.phase).toBe('endOfTurn');
    expect(s.pending.at(-1)).toMatchObject({ kind: 'invasion/march', players: [0] });
    expect(legalActions(s, 0).some((a) => a.type === 'invasion/halt')).toBe(false);
    expect(applyAction(s, 0, { type: 'invasion/halt' }).ok).toBe(false);
  });

  it('walks up to 3 edges free, 5 for a wheat, never onto the castle or another warden', () => {
    const { s, w } = atCastle((x) => grant(x, 0, { wheat: 1 }));
    const t = topology(s.board);
    const targets = legalActions(s, 0).filter((a) => a.type === 'invasion/march') as { edge: number }[];
    for (const a of targets) expect(t.castleEdge[a.edge]).toBe(false);
    const far = [...edgesWithin(s.board, w.edge!, 5)].find(([e, d]) => d === 5 && !t.castleEdge[e])![0];
    const near = [...edgesWithin(s.board, w.edge!, 3)].find(([e, d]) => d === 2 && !t.castleEdge[e])![0];
    const r1 = apply(s, 0, { type: 'invasion/march', warden: w.id, edge: near });
    expect(r1.state.players[0].hand.wheat).toBe(1);
    const r2 = apply(s, 0, { type: 'invasion/march', warden: w.id, edge: far });
    expect(r2.state.players[0].hand.wheat).toBe(0);
    expect(events(r2.events, 'invasion/marched')[0].paid).toBe(true);
    // Without the wheat, only 3.
    const { s: poor, w: pw } = atCastle();
    expect(applyAction(poor, 0, { type: 'invasion/march', warden: pw.id, edge: far }).ok).toBe(false);
    // The march ends by itself once nobody can move, and the turn passes.
    expect(r1.state.phase).toBe('roll');
    expect(r1.state.currentPlayer).toBe(1);
  });

  it('passes through occupied edges but never stops on one', () => {
    const { s, w } = atCastle((x) => {
      const next = topology(x.board).next[x.board.hexes[castle(x)].edges[0]];
      for (const e of next) if (!topology(x.board).castleEdge[e]) putWarden(x, 1, e);
    });
    const blocked = s.wardens.filter((x) => x.owner === 1).map((x) => x.edge!);
    for (const e of blocked) expect(applyAction(s, 0, { type: 'invasion/march', warden: w.id, edge: e }).ok).toBe(false);
    expect(legalActions(s, 0).length).toBeGreaterThan(0);
  });

  it('may halt when no warden stands on the castle, and other players can do nothing meanwhile', () => {
    const s = apply(
      patch(island(), (x) => putWarden(x, 0, x.board.hexes[hexOf(x, 6)].edges[0])),
      0,
      { type: 'endTurn' },
    ).state;
    expect(legalActions(s, 1)).toEqual([]);
    const r = apply(s, 0, { type: 'invasion/halt' });
    expect(r.state.currentPlayer).toBe(1);
  });
});

describe('battles alone', () => {
  /** Raiders on the coastal 6 and wardens on its edges (by orientation), player 0 to move. */
  function raided(raiders: number, wardens: [PlayerId, number, number?][]) {
    const s = patch(island(), (x) => {
      inv(x).raiders.fill(0);
      inv(x).raiders[hexOf(x, 6)] = raiders;
      inv(x).supply = RAIDERS - raiders;
      for (const [owner, orientation, k] of wardens) putWarden(x, owner, sideOf(x, hexOf(x, 6), orientation, k ?? 0));
    });
    return { s, h: hexOf(s, 6) };
  }

  it('needs more wardens than raiders', () => {
    const { s, h } = raided(2, [
      [0, 0],
      [0, 1],
    ]);
    const r = battles(s, 1);
    expect(inv(r.s).raiders[h]).toBe(2);
    expect(events(r.events, 'invasion/battle')).toHaveLength(0);
  });

  it('frees the hex: one participant takes every prisoner, then the die takes wardens on its orientation', () => {
    const { s, h } = raided(2, [
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
    // A 3 picks the upright sides (orientation 1).
    const r = battles(s, 3);
    expect(inv(r.s).raiders[h]).toBe(0);
    expect(inv(r.s).prisoners[0]).toBe(2);
    expect(r.s.wardens.filter((w) => w.owner === 0)).toHaveLength(2);
    expect(r.s.wardens.some((w) => w.edge === sideOf(s, h, 1))).toBe(false);
    expect(r.s.players[0].coins).toBe(3);
    const loss = events(r.events, 'invasion/losses')[0];
    expect(loss.die).toBe(3);
  });

  it('shares prisoners one each, the extra to the stronger side', () => {
    const { s } = raided(3, [
      [0, 0],
      [0, 0, 1],
      [1, 1],
      [0, 2],
    ]);
    // Losses: a 2 picks orientation 0 (player 0's two).
    const r = battles(s, 2);
    expect(inv(r.s).prisoners.slice(0, 2)).toEqual([2, 1]);
    expect(r.s.players[1].coins).toBe(0);
  });

  it('settles a tie for the extra prisoner by dice, the loser taking 3 coins', () => {
    const { s } = raided(3, [
      [0, 0],
      [0, 1],
      [1, 0, 1],
      [1, 1, 1],
    ]);
    // Player 0 rolls 2, player 1 rolls 5; then the loss die is a 6 (orientation 2: nobody).
    const r = battles(s, 2, 5, 6);
    expect(inv(r.s).prisoners.slice(0, 2)).toEqual([1, 2]);
    expect(r.s.players.map((p) => p.coins).slice(0, 2)).toEqual([3, 0]);
  });

  it('with fewer prisoners than participants, the dice decide and the rest take 3 coins', () => {
    const { s } = raided(1, [
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    // Rolls: player 0 a 4, player 1 a 4, player 2 a 1; the tie re-rolls 2 against 6; the loss die a 6.
    const r = battles(s, 4, 4, 1, 2, 6, 6);
    expect(inv(r.s).prisoners.slice(0, 3)).toEqual([0, 1, 0]);
    expect(r.s.players.map((p) => p.coins).slice(0, 3)).toEqual([3, 0, 3 + 3]);
  });

  it('fights hexes in clockwise order with the wardens as they stand after each battle', () => {
    // A warden on the edge between two coastal hexes, lost in the first battle, can't fight the second.
    const s = patch(island(), (x) => {
      inv(x).raiders.fill(0);
      inv(x).supply = RAIDERS;
    });
    const t = topology(s.board);
    const [a, b] = [coast(s)[1], coast(s)[2]];
    const shared = s.board.hexes[a].edges.find((e) => s.board.hexes[b].edges.includes(e))!;
    const orient = s.board.hexes[a].edges.indexOf(shared) % 3;
    const die = orient === 2 ? 1 : orient === 0 ? 2 : 3;
    const u = patch(s, (x) => {
      inv(x).raiders[a] = 1;
      inv(x).raiders[b] = 1;
      inv(x).supply -= 2;
      putWarden(x, 0, shared);
      putWarden(x, 0, x.board.hexes[a].edges.find((e) => e !== shared && x.board.hexes[a].edges.indexOf(e) % 3 !== orient && !x.board.hexes[b].edges.includes(e))!);
      putWarden(x, 0, x.board.hexes[b].edges.find((e) => e !== shared && !x.board.hexes[a].edges.includes(e) && t.wardenEdge[e])!);
    });
    const r = battles(u, die);
    expect(inv(r.s).raiders[a]).toBe(0);
    expect(inv(r.s).raiders[b]).toBe(1);
    expect(events(r.events, 'invasion/battle')).toHaveLength(1);
  });

  it('two prisoners make a point, and a battle at the end of your turn can win the game', () => {
    const { s } = raided(1, [
      [0, 0],
      [0, 1],
    ]);
    const near = patch(s, (x) => {
      inv(x).prisoners[0] = 1;
      x.options = { ...x.options, victoryPoints: 1 };
    });
    expect(totalVictoryPoints(near, 0)).toBe(0);
    const r = apply(patch(near, (x) => (x.rngState = streamFor(6))), 0, { type: 'endTurn' });
    // (The march is owed first: nothing has to move, so halt.)
    const end = r.state.pending.length > 0 ? apply(r.state, 0, { type: 'invasion/halt' }).state : r.state;
    expect(end.phase).toBe('gameOver');
    expect(end.winner).toBe(0);
  });
});

describe('with the garrisons (patched states)', () => {
  function siege(fn: (x: GameState) => void): GameState {
    return patch(island({ modules: SIEGE }), (x) => {
      inv(x).raiders.fill(0);
      inv(x).supply = RAIDERS;
      fn(x);
    });
  }

  it('numbers every warden from one counter, whichever module places it', () => {
    // (Only the garrisons recruit beside the guilds; a levy is owed here by hand to put both to work.)
    let s = siege((x) => {
      grant(x, 0, { wool: 1, ore: 1 });
      x.pending.push({ kind: 'invasion/card', players: [0], data: { card: 'levy' } });
    });
    const [e0, e1] = castleEdges(s);
    s = apply(s, 0, { type: 'invasion/levy', edge: e0 }).state;
    s = patch(s, (x) => x.pending.push({ kind: 'invasion/card', players: [1], data: { card: 'levy' } }));
    s = apply(s, 1, { type: 'invasion/levy', edge: e1 }).state;
    s = apply(s, 0, { type: 'garrisons/recruit', edge: castleEdges(s)[0] }).state;
    expect(s.wardens.map((w) => w.id)).toEqual([1, 2, 3]);
    expect(s.nextWardenId).toBe(4);
  });

  it('only mustered wardens fight, with their ranks as strength', () => {
    const s = siege((x) => {
      const h = hexOf(x, 6);
      inv(x).raiders[h] = 3;
      inv(x).supply -= 3;
      putWarden(x, 0, sideOf(x, h, 0), { rank: 3 });
      putWarden(x, 1, sideOf(x, h, 1), { rank: 1, mustered: false });
    });
    expect(inv(battles(s, 6).s).raiders[hexOf(s, 6)]).toBe(3);
    const t = patch(s, (x) => (x.wardens[1].mustered = true));
    const r = battles(t, 6);
    expect(inv(r.s).raiders[hexOf(s, 6)]).toBe(0);
    // Three prisoners for two participants: one each, the extra to the stronger.
    expect(inv(r.s).prisoners.slice(0, 2)).toEqual([2, 1]);
  });

  it('a mustered warden walks 5 and rests, a resting one 3, and one mustered this turn not at all', () => {
    const base = siege(() => {});
    const e0 = base.board.hexes[hexOf(base, 8)].edges[0];
    const far = [...edgesWithin(base.board, e0, 5)].find(([e, d]) => d === 5 && !topology(base.board).castleEdge[e])![0];
    const go = (w: Partial<Warden>) => {
      const s = patch(base, (x) => putWarden(x, 0, e0, w));
      return apply(s, 0, { type: 'endTurn' }).state;
    };
    const mustered = go({ rank: 2, mustered: true });
    const r = apply(mustered, 0, { type: 'invasion/march', warden: mustered.wardens[0].id, edge: far });
    expect(r.state.wardens[0]).toMatchObject({ edge: far, mustered: false });
    expect(r.state.players[0].hand.wheat).toBe(0);
    const resting = go({ rank: 2, mustered: false });
    expect(applyAction(resting, 0, { type: 'invasion/march', warden: resting.wardens[0].id, edge: far }).ok).toBe(false);
    expect(legalActions(resting, 0).length).toBeGreaterThan(1);
    // Mustered this turn: no march is owed at all.
    expect(go({ rank: 2, mustered: true, musteredTurn: base.turn }).pending).toEqual([]);
  });

  it('displaces a weaker warden within 3, resting both, and its owner retreats it', () => {
    let target = -1;
    const s = siege((x) => {
      const e0 = x.board.hexes[hexOf(x, 8)].edges[0];
      putWarden(x, 0, e0, { rank: 2 });
      target = [...edgesWithin(x.board, e0, 3)].find(([e, d]) => d === 2 && !topology(x.board).castleEdge[e])![0];
      putWarden(x, 1, target, { rank: 1 });
    });
    const t = apply(s, 0, { type: 'endTurn' }).state;
    const me = t.wardens.find((w) => w.owner === 0)!;
    expect(legalActions(t, 0)).toContainEqual({ type: 'invasion/displace', warden: me.id, edge: target });
    const u = apply(t, 0, { type: 'invasion/displace', warden: me.id, edge: target }).state;
    expect(u.pending.at(-1)).toMatchObject({ kind: 'invasion/retreat', players: [1] });
    expect(legalActions(u, 0)).toEqual([]);
    const retreat = legalActions(u, 1)[0] as { edge: number };
    const v = apply(u, 1, { type: 'invasion/retreat', edge: retreat.edge }).state;
    expect(v.wardens.find((w) => w.owner === 1)).toMatchObject({ edge: retreat.edge, mustered: false });
    expect(v.wardens.find((w) => w.owner === 0)).toMatchObject({ edge: target, mustered: false });
    checkInvariants(v, 'displace', cardsInPlay(s));
  });

  it('never displaces an equal or stronger warden', () => {
    const s = siege((x) => {
      const e0 = x.board.hexes[hexOf(x, 8)].edges[0];
      putWarden(x, 0, e0, { rank: 2 });
      putWarden(x, 1, topology(x.board).next[e0].find((e) => !topology(x.board).castleEdge[e])!, { rank: 2 });
    });
    const t = apply(s, 0, { type: 'endTurn' }).state;
    expect(legalActions(t, 0).some((a) => a.type === 'invasion/displace')).toBe(false);
  });

  it('a loss costs a rank, to the next lower piece free, and 3 coins', () => {
    const s = siege((x) => {
      const h = hexOf(x, 6);
      inv(x).raiders[h] = 1;
      inv(x).supply -= 1;
      // Both rank-2 pieces of player 0 are in use elsewhere: the champion drops to a recruit.
      putWarden(x, 0, sideOf(x, h, 1), { rank: 3 });
      putWarden(x, 0, x.board.hexes[hexOf(x, 9)].edges[0], { rank: 2, mustered: false });
      putWarden(x, 0, x.board.hexes[hexOf(x, 10)].edges[0], { rank: 2, mustered: false });
    });
    const r = battles(s, 3);
    expect(r.s.wardens.find((w) => w.edge === sideOf(s, hexOf(s, 6), 1))!.rank).toBe(1);
    expect(r.s.players[0].coins).toBe(3);
    // A recruit's loss removes it.
    const t = patch(s, (x) => {
      x.wardens[0].rank = 1;
      putWarden(x, 0, sideOf(x, hexOf(x, 6), 0));
    });
    expect(battles(t, 3).s.wardens.some((w) => w.edge === sideOf(s, hexOf(s, 6), 1))).toBe(false);
  });

  it('three prisoners a point, and with the supply empty three go back for a token', () => {
    const s = siege((x) => {
      inv(x).supply = 0;
      inv(x).prisoners[2] = RAIDERS;
    });
    const c = new Ctx(structuredClone(s));
    c.s.rngState = streamFor(3, 3);
    expect(totalVictoryPoints(s, 2)).toBe(RAIDERS / 3);
    invasion.hooks!.afterBuild!(c, 0, 'settlement', 0, 'threat');
    const i = inv(c.s);
    // Three landings: the first empties the prisoners' three back into the supply for a token.
    expect(events(c.events, 'invasion/landed').filter((e) => e.hex !== null)).toHaveLength(3);
    expect(events(c.events, 'invasion/prisonersTraded')).toHaveLength(1);
    expect(i.tokens[2]).toBe(1);
    expect(i.prisoners[2]).toBe(RAIDERS - 3);
    // A token is worth what the three prisoners were.
    expect(totalVictoryPoints(c.s, 2)).toBe(RAIDERS / 3);
    expect(invasion.invariants!(c.s)).toEqual([]);
  });

  it('with the prisonersPerPoint knob, a point’s worth of prisoners goes back for a token, so no points are lost', () => {
    const s = patch(
      siege((x) => {
        inv(x).supply = 0;
        inv(x).prisoners[2] = RAIDERS;
      }),
      (x) => (x.options = { ...x.options, knobs: { ...x.options.knobs, prisonersPerPoint: 2 } }),
    );
    const c = new Ctx(structuredClone(s));
    c.s.rngState = streamFor(3, 3);
    expect(totalVictoryPoints(s, 2)).toBe(RAIDERS / 2);
    invasion.hooks!.afterBuild!(c, 0, 'settlement', 0, 'threat');
    const i = inv(c.s);
    // Two back for the first token, two more for the second (each landing takes one raider).
    expect(events(c.events, 'invasion/prisonersTraded')).toHaveLength(2);
    expect(i.tokens[2]).toBe(2);
    expect(i.prisoners[2]).toBe(RAIDERS - 4);
    expect(totalVictoryPoints(c.s, 2)).toBe(RAIDERS / 2);
    expect(invasion.invariants!(c.s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------------------------

describe('bots', () => {
  it('send two wardens together to beat a lone raider', () => {
    const s = patch(island(), (x) => {
      inv(x).raiders.fill(0);
      const h = hexOf(x, 8);
      inv(x).raiders[h] = 1;
      inv(x).supply = RAIDERS - 1;
      // Two wardens two edges away from the hex, on different sides.
      const near = [...edgesWithin(x.board, x.board.hexes[h].edges[0], 2)].filter(([e, d]) => d === 2 && !x.board.hexes[h].edges.includes(e) && !topology(x.board).castleEdge[e]);
      putWarden(x, 0, near[0][0]);
      putWarden(x, 0, near[near.length - 1][0]);
    });
    let t = apply(s, 0, { type: 'endTurn' }).state;
    const mem = createBotMemory();
    let guard = 0;
    while (t.currentPlayer === 0 && t.pending.length > 0 && guard++ < 10) t = apply(t, 0, botDecide(t, 0, mem, 'hard')!).state;
    expect(inv(t).raiders[hexOf(t, 8)]).toBe(0);
    expect(inv(t).prisoners[0]).toBe(1);
    expect(mem.fallbacks).toBe(0);
  });

  it('walk wardens off the castle and answer every card', () => {
    for (const card of ['levy', 'outrider', 'ambush', 'turncoat'] as MusterCard[]) {
      const s = patch(island(), (x) => {
        grant(x, 0, { wool: 1, wheat: 1, ore: 1 });
        inv(x).deck.splice(inv(x).deck.lastIndexOf(card), 1);
        inv(x).deck.push(card);
      });
      const t = apply(s, 0, { type: 'invasion/buy' }).state;
      const mem = createBotMemory();
      const a = botDecide(t, 0, mem, 'normal')!;
      expect(a.type).toBe(`invasion/${card}`);
      expect(mem.fallbacks).toBe(0);
    }
  });
});

describe('bot games', () => {
  const results: GameResult[] = [];
  const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];
  const diffs = (g: number, n: number): BotDifficulty[] => (g % 4 === 3 ? Array.from({ length: n }, (_, i) => DIFFS[(g + i) % 3]) : Array(n).fill(DIFFS[g % 3]));

  function play(count: number, players: 3 | 4, seedBase: number) {
    for (let g = 0; g < count; g++) {
      const res = runBotGame({
        seed: seedBase + g,
        players,
        layout: 'random',
        options: { modules: ALONE, victoryPoints: TARGET },
        difficulties: diffs(g, players),
        crossCheckLegal: g % 5 === 0,
      });
      expect(res.winner).not.toBeNull();
      expect(res.fallbacks).toBe(0);
      results.push(res);
    }
  }

  slow('finish 30 four-seat games with every invariant intact and no fall-backs', () => {
    play(30, 4, 41000);
  }, timeout(120_000));

  slow('finish 30 three-seat games with every invariant intact and no fall-backs', () => {
    play(30, 3, 42000);
  }, timeout(120_000));

  afterAll(() => {
    if (results.length === 0) return;
    const lines = [`invasion bot games: ${results.length}, fallbacks ${results.reduce((a, r) => a + r.fallbacks, 0)}`];
    for (const n of [4, 3]) {
      const rs = results.filter((r) => r.players === n);
      const turns = rs.map((r) => r.turns);
      const wins = Array(n).fill(0);
      for (const r of rs) if (r.winner !== null) wins[r.winner]++;
      lines.push(`${n} seats: ${rs.length} games, average ${(turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1)} turns (${Math.min(...turns)}-${Math.max(...turns)}), wins by seat ${wins.join(' / ')}`);
    }
    console.log(lines.join('\n'));
  });
});

describe('fuzzing', () => {
  slow('every action legalActions offers applies, through whole games', () => {
    let checked = 0;
    for (let g = 0; g < 6; g++) {
      const r = runFuzzGame(43000 + g, g % 2 ? 3 : 4, 'random', 700, true, { modules: ALONE, victoryPoints: TARGET });
      checked += r.checkedActions;
    }
    for (let g = 0; g < 8; g++) runFuzzGame(43100 + g, g % 2 ? 3 : 4, 'random', 3000, false, { modules: ALONE, victoryPoints: TARGET });
    expect(checked).toBeGreaterThan(1000);
  }, timeout(120_000));

  slow('the same with the guilds and garrisons in name (no deck, unlimited raiders)', () => {
    for (let g = 0; g < 3; g++) runFuzzGame(43200 + g, 4, 'random', 500, true, { modules: SIEGE, victoryPoints: invasionTarget(SIEGE) });
  }, timeout(120_000));
});

