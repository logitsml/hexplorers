// The Almanac: its deck, every happening, the quake's cracked roads, and bots playing it.

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  canAfford,
  createGame,
  emptyCards,
  legalActions,
  legalRoads,
  legalSettlements,
  longestRoadFor,
  redactState,
  satisfiesDistanceRule,
  totalCards,
  type GameEvent,
  type GameState,
  type ModuleId,
  type PlayerId,
  type Production,
} from '../../src/engine';
import { botDecide, createBotMemory } from '../../src/engine/ai';
import { Ctx } from '../../src/engine/ctx';
import { MODULES } from '../../src/engine/modules';
import { HAPPENINGS, NEW_YEAR, UNDER_NEW_YEAR, cardDice, drawCard } from '../../src/engine/modules/almanac/deck';
import type { Happening } from '../../src/engine/modules/almanac/types';
import { FOUR, apply, grant, num, patch, road, raidersAt, corsairAt } from '../helpers';
import { type GameResult, checkInvariants, runBotGame, runFuzzGame } from '../sim-harness';
import { games, slow, timeout } from '../tier';

const almanac = MODULES.almanac;
const total = (card: number) => cardDice(card)[0] + cardDice(card)[1];

/** An empty island past set-up, with player 0 about to roll. */
function island(modules: ModuleId[] = ['almanac'], seed = 11, layout: 'beginner' | 'random' = 'random'): GameState {
  const g = createGame(FOUR, { layout, seed, modules }).state;
  return patch(g, (x) => {
    x.turn = 5;
    x.setupIndex = x.setupOrder.length;
    x.currentPlayer = 0;
    x.phase = 'roll';
    x.hasRolled = false;
  });
}

/** A card bearing `h` (on `n`, if given). */
function cardFor(h: Happening, n?: number): number {
  const card = HAPPENINGS.findIndex((x, c) => x === h && (n === undefined || total(c) === n));
  if (card < 0) throw new Error(`no ${h} card on ${n}`);
  return card;
}

/** Put `card` on top of the deck (swapped with the top card, so the new year keeps its place). */
function stack(s: GameState, card: number) {
  const deck = s.ext.almanac!.deck;
  const i = deck.indexOf(card);
  [deck[i], deck[deck.length - 1]] = [deck[deck.length - 1], deck[i]];
}

/** Roll with `card` on top, as player 0. */
function rollWith(s: GameState, card: number, patchFn?: (x: GameState) => void) {
  const before = patch(s, (x) => {
    x.phase = 'roll';
    x.hasRolled = false;
    stack(x, card);
    patchFn?.(x);
  });
  return apply(before, before.currentPlayer, { type: 'rollDice' });
}

const of = (events: GameEvent[], type: string) => events.filter((e) => e.type === type);
const settle = (s: GameState, p: PlayerId, v: number, kind: 'settlement' | 'city' = 'settlement') => {
  s.buildings[v] = { owner: p, kind };
  if (kind === 'city') s.players[p].citiesLeft--;
  else s.players[p].settlementsLeft--;
};
const lay = (s: GameState, p: PlayerId, e: number) => {
  s.routes[e] = road(p);
  s.players[p].roadsLeft--;
};
/** A hex bearing `n` (the robber not on it). */
const hexOn = (s: GameState, n: number) => s.board.hexes.find((h) => num(h) === n && h.id !== s.robberHex)!;
/** Two intersections of one hex at distance two (so both may hold buildings). */
const twoCorners = (s: GameState, hex: number) => [s.board.hexes[hex].vertices[0], s.board.hexes[hex].vertices[2]];

describe('the deck', () => {
  it('holds one card per result of two dice, with the happenings spread as the table says', () => {
    expect(HAPPENINGS).toHaveLength(36);
    const count = (h: Happening) => HAPPENINGS.filter((x) => x === h).length;
    expect(count('fairDay')).toBe(10);
    expect(count('thieves')).toBe(6);
    for (const h of ['calmSeas', 'quarrel', 'quake', 'sickness', 'gifts', 'helpingHand', 'harvest', 'robberFlees', 'tournament', 'windfall'] as Happening[]) expect(count(h)).toBe(2);
    for (let card = 0; card < 36; card++) {
      const [a, b] = cardDice(card);
      // Every 7 is the thieves', and nothing else is.
      expect(HAPPENINGS[card] === 'thieves').toBe(a + b === 7);
      // A card and its mirror carry the same happening.
      expect(HAPPENINGS[(6 - a) * 6 + (6 - b)]).toBe(HAPPENINGS[card]);
    }
    for (let n = 2; n <= 12; n++) {
      if (n === 7) continue;
      const here = HAPPENINGS.filter((_, c) => total(c) === n);
      // One fair day on every number, and no happening twice on one.
      expect(here.filter((h) => h === 'fairDay')).toHaveLength(1);
      expect(new Set(here).size).toBe(here.length);
    }
  });

  it('is dealt with five cards under the new year and the rest on top', () => {
    const deck = island().ext.almanac!.deck;
    expect(deck).toHaveLength(37);
    expect(deck[UNDER_NEW_YEAR]).toBe(NEW_YEAR);
    expect(new Set(deck).size).toBe(37);
  });

  it('draws every card above the new year once, then rebuilds and draws again', () => {
    const s = island();
    const ctx = new Ctx(structuredClone(s));
    const under = ctx.s.ext.almanac!.deck.slice(0, UNDER_NEW_YEAR);
    const drawn = Array.from({ length: 31 }, () => drawCard(ctx));
    expect(new Set(drawn).size).toBe(31);
    for (const c of under) expect(drawn).not.toContain(c);
    expect(ctx.events).toHaveLength(0);
    // The next draw meets the new year: the deck is rebuilt whole, and a card is drawn from it.
    const next = drawCard(ctx);
    expect(ctx.events).toEqual([{ type: 'almanac/newYear' }]);
    expect(ctx.s.ext.almanac!.deck).toHaveLength(36);
    expect(ctx.s.ext.almanac!.deck).not.toContain(next);
    expect(ctx.s.ext.almanac!.deck[UNDER_NEW_YEAR]).toBe(NEW_YEAR);
  });

  it('gives the roll its dice and number, and replaces the plain event deck', () => {
    const s = island(['almanac']);
    const withDeck = patch(s, (x) => {
      x.options = { ...x.options, eventDeck: true };
    });
    const card = cardFor('fairDay', 9);
    const { state, events } = rollWith(withDeck, card);
    expect(state.dice).toEqual(cardDice(card));
    expect(of(events, 'diceRolled')[0]).toMatchObject({ total: 9 });
    expect(of(events, 'almanac/drawn')[0]).toMatchObject({ card, happening: 'fairDay', settled: false });
    expect(state.eventCards).toBeUndefined();
    expect(state.ext.almanac!.card).toBe(card);
    expect(state.phase).toBe('main');
  });

  it('keeps the dice-setting venture’s number, voiding the happening only when the card is a 7', () => {
    const settled = { dice: [4, 6] as [number, number], total: 10 };
    for (const [card, want] of [
      [cardFor('quake'), 'quake'],
      [cardFor('thieves'), null],
    ] as const) {
      const s = patch(island(), (x) => stack(x, card));
      const ctx = new Ctx(s);
      expect(almanac.hooks!.rollDice!(ctx, settled)).toBe(settled);
      expect(ctx.s.ext.almanac!.happening).toBe(want);
      expect(ctx.events[0]).toMatchObject({ type: 'almanac/drawn', card, settled: true });
    }
  });

  it('keeps its order and the five under the new year secret', () => {
    const r = redactState(island(), 1).ext.almanac!.deck;
    expect(r).toHaveLength(37);
    expect(r.filter((c) => c === NEW_YEAR)).toHaveLength(1);
    expect(r.filter((c) => c !== NEW_YEAR).every((c) => c === -1)).toBe(true);
  });

  it('clears the card when the next turn starts', () => {
    const { state } = rollWith(island(), cardFor('fairDay', 5));
    const next = apply(state, 0, { type: 'endTurn' }).state;
    expect(next.ext.almanac!.card).toBeNull();
    expect(next.ext.almanac!.happening).toBeNull();
  });
});

describe('happenings', () => {
  it('a fair day: production as usual', () => {
    const s = island();
    const hex = hexOn(s, 9);
    const [v] = twoCorners(s, hex.id);
    const { state, events } = rollWith(s, cardFor('fairDay', 9), (x) => settle(x, 1, v));
    expect(state.pending).toEqual([]);
    expect(of(events, 'production')).toHaveLength(1);
    expect(of(events, 'almanac/nothing')).toHaveLength(0);
  });

  it('the thieves strike: the card’s 7 is resolved as usual', () => {
    const s = island();
    const { state } = rollWith(s, cardFor('thieves'), (x) => grant(x, 1, { brick: 8 }));
    expect(state.phase).toBe('discard');
    expect(state.pendingDiscards).toEqual({ 1: 4 });
  });

  it('calm seas: the players with the most buildings on harbours each take a resource, before production', () => {
    const s = island();
    const harbours = s.board.vertices.filter((v) => v.port).map((v) => v.id);
    const card = cardFor('calmSeas', 4);
    const hex = hexOn(s, 4);
    const producer = hex.vertices.find((v) => !s.board.vertices[v].port)!;
    const { state, events } = rollWith(s, card, (x) => {
      settle(x, 1, harbours[0]);
      settle(x, 2, harbours[3]);
      settle(x, 3, producer);
    });
    // Players 1 and 2 tie with one each; the roll waits for them.
    expect(state.pending).toEqual([{ kind: 'almanac/take', players: [1, 2], data: { happening: 'calmSeas' } }]);
    expect(state.phase).toBe('roll');
    expect(state.productionOwed).toBe(4);
    expect(of(events, 'production')).toHaveLength(0);
    expect(legalActions(state, 0)).toEqual([]);
    expect(legalActions(state, 1)).toHaveLength(5);
    expect(applyAction(state, 0, { type: 'almanac/take', resource: 'ore' }).ok).toBe(false);
    expect(applyAction(state, 0, { type: 'endTurn' }).ok).toBe(false);

    const a = apply(state, 2, { type: 'almanac/take', resource: 'ore' });
    expect(a.state.players[2].hand.ore).toBe(1);
    expect(a.state.pending[0].players).toEqual([1]);
    const b = apply(a.state, 1, { type: 'almanac/take', resource: 'wool' });
    expect(b.state.players[1].hand.wool).toBe(1);
    // The last answer lets production go ahead.
    expect(b.state.pending).toEqual([]);
    expect(b.state.productionOwed).toBeUndefined();
    expect(b.state.phase).toBe('main');
    expect(of(b.events, 'production')).toHaveLength(1);
    expect(totalCards(b.state.players[3].hand)).toBeGreaterThan(0);
  });

  it('calm seas: nobody on a harbour, nobody takes', () => {
    const { state, events } = rollWith(island(), cardFor('calmSeas'));
    expect(state.pending).toEqual([]);
    expect(of(events, 'almanac/nothing')).toEqual([{ type: 'almanac/nothing', happening: 'calmSeas' }]);
  });

  it('calm seas counts buildings, not points', () => {
    const s = island();
    const harbours = s.board.vertices.filter((v) => v.port).map((v) => v.id);
    const { state } = rollWith(s, cardFor('calmSeas'), (x) => {
      settle(x, 1, harbours[0], 'city');
      settle(x, 2, harbours[3]);
      settle(x, 2, harbours[6]);
    });
    expect(state.pending[0].players).toEqual([2]);
  });

  it('a good harvest: everyone takes a resource while the supply lasts', () => {
    const { state } = rollWith(island(), cardFor('harvest'));
    expect(state.pending[0]).toMatchObject({ kind: 'almanac/take', players: [0, 1, 2, 3] });

    // With one card left in the supply, the first to choose takes it and the rest go without.
    const lean = rollWith(island(), cardFor('harvest'), (x) => {
      for (const r of ['brick', 'wood', 'wool', 'wheat', 'ore'] as const) grant(x, 3, { [r]: x.bank[r] });
      grant(x, 3, { brick: -1 });
    });
    expect(legalActions(lean.state, 2)).toEqual([{ type: 'almanac/take', resource: 'brick' }]);
    const after = apply(lean.state, 2, { type: 'almanac/take', resource: 'brick' });
    expect(after.state.pending).toEqual([]);
    expect(after.state.phase).toBe('main');
  });

  it('a tournament: the most Knight cards played take a resource each, ties included', () => {
    const s = island();
    const { state } = rollWith(s, cardFor('tournament'), (x) => {
      x.players[1].playedKnights = 2;
      x.players[3].playedKnights = 2;
      x.players[0].playedKnights = 1;
    });
    expect(state.pending[0]).toMatchObject({ kind: 'almanac/take', players: [1, 3] });
    const none = rollWith(island(), cardFor('tournament'));
    expect(none.state.pending).toEqual([]);
    expect(of(none.events, 'almanac/nothing')).toHaveLength(1);
  });

  it('a tournament and a quarrel read mustered warden strength with the Garrisons', () => {
    const s = patch(island(['guilds', 'garrisons', 'almanac']), (x) => {
      const w = (id: number, owner: number, rank: 1 | 2 | 3, mustered: boolean) => ({ id, owner, rank, mustered, vertex: id, edge: null, musteredTurn: 0 });
      // Player 1: a mustered champion (3). Player 2: two mustered recruits (2) and a resting veteran.
      x.wardens = [w(0, 1, 3, true), w(1, 2, 1, true), w(2, 2, 1, true), w(3, 2, 2, false)];
      // Knight cards don't count under the Garrisons.
      x.players[3].playedKnights = 5;
      x.largestArmyHolder = 3;
      grant(x, 0, { ore: 2 });
      grant(x, 2, { wool: 2 });
    });
    expect(rollWith(s, cardFor('tournament')).state.pending[0].players).toEqual([1]);
    // A quarrel: player 1 alone is strongest, and has a choice of victims.
    const q = rollWith(s, cardFor('quarrel'));
    expect(q.state.pending[0]).toMatchObject({ kind: 'almanac/rob', players: [1], data: { victims: [0, 2] } });
    // A tie for the strongest: a quarrel does nothing, a tournament rewards both.
    const tied = patch(s, (x) => {
      x.wardens[3].mustered = true;
      x.wardens[3].rank = 1;
    });
    expect(rollWith(tied, cardFor('quarrel')).state.pending).toEqual([]);
    expect(rollWith(tied, cardFor('tournament')).state.pending[0].players).toEqual([1, 2]);
  });

  it('a quarrel: the Biggest Army’s holder steals from a player of their choice', () => {
    const s = patch(island(), (x) => {
      x.largestArmyHolder = 2;
      x.players[2].playedKnights = 3;
      x.players[2].playedDevCards.push('knight', 'knight', 'knight');
      x.devDeck.splice(0, 3);
      grant(x, 0, { ore: 1 });
      grant(x, 3, { wool: 2 });
    });
    const { state } = rollWith(s, cardFor('quarrel'));
    expect(state.pending[0]).toMatchObject({ kind: 'almanac/rob', players: [2], data: { victims: [0, 3] } });
    expect(applyAction(state, 2, { type: 'almanac/rob', victim: 1 }).ok).toBe(false);
    const r = apply(state, 2, { type: 'almanac/rob', victim: 3 });
    expect(of(r.events, 'stolen')).toEqual([{ type: 'stolen', thief: 2, victim: 3, resource: 'wool', by: 'almanac' }]);
    expect(r.state.players[2].hand.wool).toBe(1);
    expect(r.state.phase).toBe('main');

    // One victim to choose from: the theft happens at once.
    const one = rollWith(patch(s, (x) => grant(x, 3, { wool: -2 })), cardFor('quarrel'));
    expect(one.state.pending).toEqual([]);
    expect(of(one.events, 'stolen')).toEqual([{ type: 'stolen', thief: 2, victim: 0, resource: 'ore', by: 'almanac' }]);
  });

  it('a quarrel without the Biggest Army: only a player with more Knight cards than anyone', () => {
    const base = patch(island(), (x) => {
      x.players[1].playedKnights = 2;
      x.players[1].playedDevCards.push('knight', 'knight');
      x.devDeck.splice(0, 2);
      grant(x, 0, { ore: 1 });
    });
    const solo = rollWith(base, cardFor('quarrel'));
    expect(of(solo.events, 'stolen')).toEqual([{ type: 'stolen', thief: 1, victim: 0, resource: 'ore', by: 'almanac' }]);
    const tie = patch(base, (x) => {
      x.players[2].playedKnights = 2;
      x.players[2].playedDevCards.push('knight', 'knight');
      x.devDeck.splice(0, 2);
    });
    expect(of(rollWith(tie, cardFor('quarrel')).events, 'almanac/nothing')).toHaveLength(1);
  });

  it('a trade windfall: the holder of Longest Route steals; without one, nothing', () => {
    const s = patch(island(), (x) => {
      x.longestRoadHolder = 3;
      grant(x, 1, { wheat: 1 });
    });
    expect(of(rollWith(s, cardFor('windfall')).events, 'stolen')).toEqual([{ type: 'stolen', thief: 3, victim: 1, resource: 'wheat', by: 'almanac' }]);
    expect(of(rollWith(patch(s, (x) => (x.longestRoadHolder = null)), cardFor('windfall')).events, 'almanac/nothing')).toHaveLength(1);
  });

  it('neighbourly gifts: everyone holding a card passes one of their choice to the left', () => {
    const s = patch(island(), (x) => {
      grant(x, 0, { brick: 1, ore: 1 });
      grant(x, 1, { wool: 1 });
      grant(x, 3, { wheat: 2 });
    });
    const { state } = rollWith(s, cardFor('gifts'));
    expect(state.pending[0]).toMatchObject({ kind: 'almanac/gift', players: [0, 1, 3] });
    expect(legalActions(state, 0)).toEqual([
      { type: 'almanac/give', card: 'brick', to: 1 },
      { type: 'almanac/give', card: 'ore', to: 1 },
    ]);
    expect(applyAction(state, 0, { type: 'almanac/give', card: 'brick', to: 2 }).ok).toBe(false);
    expect(applyAction(state, 0, { type: 'almanac/give', card: 'wool', to: 1 }).ok).toBe(false);
    let t = apply(state, 0, { type: 'almanac/give', card: 'ore', to: 1 }).state;
    t = apply(t, 1, { type: 'almanac/give', card: 'wool', to: 2 }).state;
    const last = apply(t, 3, { type: 'almanac/give', card: 'wheat', to: 0 });
    expect(last.state.players.map((p) => totalCards(p.hand))).toEqual([2, 1, 1, 1]);
    expect(last.state.players[1].hand.ore).toBe(1);
    expect(last.state.players[0].hand.wheat).toBe(1);
    expect(last.state.phase).toBe('main');
  });

  it('neighbourly gifts may be commodities with the Guilds, never oil', () => {
    const s = patch(island(['guilds', 'oil', 'almanac']), (x) => grant(x, 2, { cloth: 1, oil: 2 }));
    const { state } = rollWith(s, cardFor('gifts'));
    expect(state.pending[0].players).toEqual([2]);
    expect(legalActions(state, 2)).toEqual([{ type: 'almanac/give', card: 'cloth', to: 3 }]);
  });

  it('a helping hand: the leaders each give a card to a player of their choice with fewer points', () => {
    const s = island();
    const vs = s.board.vertices.filter((v) => v.land).map((v) => v.id);
    // Points 2, 2, 1, 0: players 0 and 1 lead; player 3 holds a hidden victory card, which doesn't count.
    const t = patch(s, (x) => {
      settle(x, 0, vs[0], 'city');
      settle(x, 1, vs[10]);
      settle(x, 1, vs[20]);
      settle(x, 2, vs[30]);
      x.players[3].devCards.push({ type: 'victoryPoint', boughtTurn: 1 }, { type: 'victoryPoint', boughtTurn: 1 }, { type: 'victoryPoint', boughtTurn: 1 });
      x.devDeck.splice(0, 3);
      grant(x, 0, { brick: 1 });
      grant(x, 1, { ore: 2 });
    });
    const { state } = rollWith(t, cardFor('helpingHand'));
    expect(state.pending[0]).toMatchObject({ kind: 'almanac/gift', players: [0, 1], data: { recipients: [2, 3] } });
    expect(applyAction(state, 0, { type: 'almanac/give', card: 'brick', to: 1 }).ok).toBe(false);
    const a = apply(state, 0, { type: 'almanac/give', card: 'brick', to: 3 }).state;
    const b = apply(a, 1, { type: 'almanac/give', card: 'ore', to: 2 });
    expect(b.state.players[3].hand.brick).toBe(1);
    expect(b.state.players[2].hand.ore).toBe(1);
    expect(b.state.pending).toEqual([]);

    // Everyone level: nobody has fewer, so nobody gives.
    expect(of(rollWith(patch(island(), (x) => grant(x, 0, { brick: 1 })), cardFor('helpingHand')).events, 'almanac/nothing')).toHaveLength(1);
  });

  it('a sickness: each city takes one resource per producing hex; settlements are spared', () => {
    const s = island();
    const card = cardFor('sickness', 8);
    const hex = hexOn(s, 8);
    const [a, b] = twoCorners(s, hex.id);
    const { events } = rollWith(s, card, (x) => {
      settle(x, 1, a, 'city');
      settle(x, 2, b);
    });
    const grants = (of(events, 'production')[0] as { grants: Production[] }).grants;
    expect(grants.map((g) => [g.player, g.amount])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    // On a fair day the same city takes two.
    const fair = rollWith(s, cardFor('fairDay', 8), (x) => settle(x, 1, a, 'city'));
    expect((of(fair.events, 'production')[0] as { grants: Production[] }).grants[0].amount).toBe(2);
  });

  it('a sickness takes no commodity and at most one oil from a well', () => {
    const s = patch(island(), (x) => (x.ext.almanac!.happening = 'sickness'));
    const hex = s.board.hexes[0];
    const city = { owner: 1, kind: 'city' as const, foundry: true };
    const g = (resource: Production['resource'], amount: number): Production => ({ player: 1, hex: 0, vertex: hex.vertices[0], resource, amount });
    expect(almanac.hooks!.yields!(s, hex, hex.vertices[0], city, [g('wool', 2), g('cloth', 1), g('oil', 3)])).toEqual([g('wool', 1), g('oil', 1)]);
    expect(almanac.hooks!.yields!(s, hex, hex.vertices[0], { owner: 1, kind: 'settlement' }, [g('wool', 1), g('oil', 1)])).toEqual([g('wool', 1), g('oil', 1)]);
  });

  it('a sickness holds a city or foundry on a bounty field to one pick, as on any other producing hex', () => {
    const g = createGame(FOUR, { seed: 1, map: 'archipelago', modules: ['sea', 'oil', 'almanac'], victoryPoints: 14 }).state;
    const field = g.board.hexes.find((h) => h.terrain === 'bounty')!;
    const [a, b, c] = [field.vertices[0], field.vertices[2], field.vertices[4]];
    const s = patch(g, (x) => {
      x.turn = 5;
      x.setupIndex = x.setupOrder.length;
      x.currentPlayer = 0;
      x.robberHex = null;
      // (A sickness falls only on a 6 or an 8, and a bounty field never bears a red number.)
      x.board.hexes[field.id].numbers = [8];
      settle(x, 1, a, 'city');
      x.buildings[b] = { owner: 2, kind: 'city', foundry: true };
      x.players[2].citiesLeft--;
      settle(x, 3, c);
    });
    const owed = (card: number) => (of(rollWith(s, card).events, 'sea/bountyOwed')[0] as { owed: Record<number, number> }).owed;
    expect(owed(cardFor('fairDay', 8))).toEqual({ 1: 2, 2: 3, 3: 1 });
    expect(owed(cardFor('sickness', 8))).toEqual({ 1: 1, 2: 1, 3: 1 });
    const { state } = rollWith(s, cardFor('sickness', 8));
    expect(state.pending.at(-1)).toMatchObject({ kind: 'sea/bountyPick', players: [1], data: { count: 1 } });
  });

  it('with Oil, a windfall’s theft may name oil, and a lone victim holding some is a choice', () => {
    const { state } = rollWith(island(['oil', 'almanac']), cardFor('windfall'), (x) => {
      x.longestRoadHolder = 0;
      grant(x, 1, { oil: 2 });
    });
    expect(state.pending.at(-1)).toMatchObject({ kind: 'almanac/rob', players: [0] });
    // (Oil is all they hold, so naming it is the only theft.)
    expect(legalActions(state, 0)).toEqual([{ type: 'almanac/rob', victim: 1, oil: true }]);
    const after = apply(state, 0, { type: 'almanac/rob', victim: 1, oil: true }).state;
    expect([after.players[0].hand.oil, after.players[1].hand.oil]).toEqual([1, 1]);
    expect(applyAction(state, 0, { type: 'almanac/rob', victim: 1 }).ok).toBe(false);
  });

  it('the robber flees to the desert before production, without stealing', () => {
    const s = island();
    const card = cardFor('robberFlees', 6);
    const hex = s.board.hexes.find((h) => num(h) === 6)!;
    const [v] = twoCorners(s, hex.id);
    const { state, events } = rollWith(s, card, (x) => {
      x.robberHex = hex.id;
      settle(x, 1, v);
      grant(x, 1, { ore: 3 });
    });
    expect(of(events, 'almanac/robberFled')).toEqual([{ type: 'almanac/robberFled', from: hex.id, to: s.board.desertHex }]);
    expect(state.robberHex).toBe(s.board.desertHex);
    // The hex it left produced.
    expect((of(events, 'production')[0] as { grants: Production[] }).grants.some((g) => g.hex === hex.id)).toBe(true);
    expect(of(events, 'stolen')).toHaveLength(0);
  });

  it('the robber flees off the board where there is no desert, and stays off', () => {
    const s = patch(island(), (x) => {
      x.robberHex = 3;
      x.board = { ...x.board, desertHex: null };
    });
    const off = rollWith(s, cardFor('robberFlees'));
    expect(off.state.robberHex).toBeNull();
    const again = rollWith(patch(s, (x) => (x.robberHex = null)), cardFor('robberFlees'));
    expect(again.state.robberHex).toBeNull();
    expect(of(again.events, 'almanac/nothing')).toHaveLength(1);
  });

  it('with Oil, the robber flees off the board rather than onto the well that stands on the desert', () => {
    const s = patch(island(['oil', 'almanac']), (x) => (x.robberHex = 3));
    expect(s.board.hexes[s.board.desertHex!].numbers.length).toBeGreaterThan(0);
    expect(rollWith(s, cardFor('robberFlees')).state.robberHex).toBeNull();
  });

  it('where Invasion has done away with the robber, the corsair leaves the board instead', () => {
    const s = patch(island(), (x) => {
      x.options = { ...x.options, modules: ['sea', 'invasion', 'almanac'] };
      x.ext.sea = corsairAt(x, 5);
      x.ext.invasion = raidersAt(x, x.board.hexes.map(() => 0));
      x.robberHex = null;
    });
    const { state, events } = rollWith(s, cardFor('robberFlees'));
    expect(state.ext.sea!.corsair).toBeNull();
    expect(of(events, 'almanac/corsairFled')).toEqual([{ type: 'almanac/corsairFled', from: 5 }]);
    // (The other card of the pair: the first has been drawn.)
    const card = cardFor('robberFlees', total(state.ext.almanac!.card!) === 8 ? 6 : 8);
    expect(of(rollWith(state, card).events, 'almanac/nothing')).toHaveLength(1);
  });
});

describe('a quake', () => {
  /** Player 0 with a three-road line from a settlement; player 1 with one road and a ship; player 2 with none. */
  function quaked() {
    const s = island();
    const v0 = s.board.hexes[hexOn(s, 9).id].vertices[0];
    const line: number[] = [];
    const t = patch(s, (x) => {
      settle(x, 0, v0);
      let at = v0;
      for (let i = 0; i < 3; i++) {
        const e = x.board.vertices[at].edges.find((e) => x.routes[e] === null && !line.includes(e))!;
        lay(x, 0, e);
        line.push(e);
        const ed = x.board.edges[e];
        at = ed.a === at ? ed.b : ed.a;
      }
      // Player 1 well away from that line.
      const near = new Set<number>();
      for (const e of line) for (const v of [x.board.edges[e].a, x.board.edges[e].b]) for (const u of [v, ...x.board.vertices[v].neighbors]) near.add(u);
      const far = x.board.hexes.find((h) => h.vertices.every((v) => !near.has(v) && x.board.vertices[v].neighbors.every((u) => !near.has(u))))!;
      settle(x, 1, far.vertices[0]);
      lay(x, 1, far.edges[0]);
      x.routes[far.edges[5]] = { owner: 1, kind: 'ship', builtTurn: 0 };
    });
    return { s: t, v0, line };
  }

  it('cracks one road of each player who has one; those with a choice choose', () => {
    const { s, line } = quaked();
    const { state, events } = rollWith(s, cardFor('quake'));
    // Player 1 has one road (the ship doesn't count): it cracks at once.
    expect(of(events, 'almanac/cracked')).toHaveLength(1);
    expect(state.pending).toEqual([{ kind: 'almanac/quake', players: [0], data: { happening: 'quake' } }]);
    expect(legalActions(state, 0)).toEqual(line.slice().sort((a, b) => a - b).map((edge) => ({ type: 'almanac/crack', edge })));
    const r = apply(state, 0, { type: 'almanac/crack', edge: line[2] });
    expect(r.state.routes[line[2]]!.cracked).toBe(true);
    expect(r.state.phase).toBe('main');
    expect(r.state.routes.filter((x) => x?.cracked)).toHaveLength(2);
    expect(r.state.routes.filter((x) => x?.kind === 'ship' && x.cracked)).toHaveLength(0);
  });

  it('stops its owner building roads, and everyone settling beside it, until it is mended', () => {
    const { s, line } = quaked();
    const cracked = patch(s, (x) => {
      x.routes[line[2]]!.cracked = true;
      x.phase = 'main';
      x.hasRolled = true;
      grant(x, 0, { brick: 3, wood: 3, wool: 1, wheat: 1 });
    });
    const ed = cracked.board.edges[line[2]];
    const end = ed.a === cracked.board.edges[line[1]].a || ed.a === cracked.board.edges[line[1]].b ? ed.b : ed.a;
    expect(satisfiesDistanceRule(cracked, end)).toBe(true);
    expect(legalRoads(cracked, 0)).toEqual([]);
    expect(applyAction(cracked, 0, { type: 'buildRoad', edge: cracked.board.vertices[end].edges.find((e) => cracked.routes[e] === null)! }).ok).toBe(false);
    expect(legalRoads(cracked, 1).length).toBeGreaterThan(0);
    expect(legalSettlements(cracked, 0)).not.toContain(end);
    // Still counts toward Longest Route.
    expect(longestRoadFor(cracked, 0)).toBe(3);
    // The bot doesn't reach for a road it can't build.
    expect(legalActions(cracked, 0)).toContainEqual({ type: 'almanac/repair', edge: line[2] });

    const mended = apply(cracked, 0, { type: 'almanac/repair', edge: line[2] });
    expect(mended.events).toEqual([
      { type: 'cardsMoved', from: 0, to: null, cards: { ...emptyCards(), brick: 1, wood: 1 }, reason: 'repair' },
      { type: 'almanac/repaired', player: 0, edge: line[2] },
    ]);
    expect(mended.state.routes[line[2]]!.cracked).toBeUndefined();
    expect(mended.state.players[0].hand.brick).toBe(2);
    expect(mended.state.players[0].hand.wood).toBe(2);
    expect(legalRoads(mended.state, 0).length).toBeGreaterThan(0);
    expect(legalSettlements(mended.state, 0)).toContain(end);
  });

  it('is mended only by its owner, on their turn, with brick and wood in hand', () => {
    const { s, line } = quaked();
    const cracked = patch(s, (x) => {
      x.routes[line[0]]!.cracked = true;
      x.phase = 'main';
      x.hasRolled = true;
      grant(x, 1, { brick: 1, wood: 1 });
    });
    expect(applyAction(cracked, 0, { type: 'almanac/repair', edge: line[0] }).ok).toBe(false);
    expect(applyAction(cracked, 1, { type: 'almanac/repair', edge: line[0] }).ok).toBe(false);
    const ready = patch(cracked, (x) => grant(x, 0, { brick: 1, wood: 1 }));
    expect(applyAction(ready, 0, { type: 'almanac/repair', edge: line[1] }).ok).toBe(false);
    expect(applyAction(patch(ready, (x) => (x.phase = 'roll')), 0, { type: 'almanac/repair', edge: line[0] }).ok).toBe(false);
    expect(applyAction(ready, 0, { type: 'almanac/repair', edge: line[0] }).ok).toBe(true);
  });

  it('a second quake before the mending cracks another road; all must be mended', () => {
    const { s, line } = quaked();
    const twice = patch(s, (x) => (x.routes[line[0]]!.cracked = true));
    const { state } = rollWith(twice, cardFor('quake'));
    expect(state.pending[0].players).toEqual([0]);
    expect(legalActions(state, 0).map((a) => (a as { edge: number }).edge)).not.toContain(line[0]);
    const r = apply(state, 0, { type: 'almanac/crack', edge: line[1] }).state;
    const fixed = apply(patch(r, (x) => grant(x, 0, { brick: 1, wood: 1 })), 0, { type: 'almanac/repair', edge: line[0] }).state;
    expect(legalRoads(fixed, 0)).toEqual([]);
  });
});

describe('bots', () => {
  it('crack the road whose ends leave them no spot to settle', () => {
    const s = island();
    const v0 = s.board.hexes[hexOn(s, 9).id].vertices[0];
    const line: number[] = [];
    const t = patch(s, (x) => {
      settle(x, 0, v0);
      let at = v0;
      for (let i = 0; i < 3; i++) {
        const e = x.board.vertices[at].edges.find((e) => x.routes[e] === null && !line.includes(e))!;
        lay(x, 0, e);
        line.push(e);
        const ed = x.board.edges[e];
        at = ed.a === at ? ed.b : ed.a;
      }
    });
    const { state } = rollWith(t, cardFor('quake'));
    // The road from the settlement ends at it and at a spot too close to it: cracking it costs nothing.
    expect(botDecide(state, 0, createBotMemory(), 'hard')).toEqual({ type: 'almanac/crack', edge: line[0] });
  });

  it('mend a cracked road once they hold brick and wood', () => {
    const s = patch(island(), (x) => {
      const v = x.board.hexes[hexOn(x, 5).id].vertices[0];
      settle(x, 0, v);
      const e = x.board.vertices[v].edges[0];
      lay(x, 0, e);
      x.routes[e]!.cracked = true;
      x.phase = 'main';
      x.hasRolled = true;
      grant(x, 0, { brick: 1, wood: 1, ore: 1 });
    });
    const a = botDecide(s, 0, createBotMemory(), 'normal');
    expect(a).toEqual({ type: 'almanac/repair', edge: s.board.vertices[s.board.hexes[hexOn(s, 5).id].vertices[0]].edges[0] });
  });

  it('take the resource that completes a build', () => {
    const s = patch(island(), (x) => {
      const v = x.board.hexes[hexOn(x, 5).id].vertices[0];
      settle(x, 1, v);
      grant(x, 1, { wheat: 2, ore: 2 });
    });
    const { state } = rollWith(s, cardFor('harvest'));
    const a = botDecide(state, 1, createBotMemory(), 'hard');
    expect(a?.type).toBe('almanac/take');
    // Ore for the city or wool for a development card: either completes a build.
    const after = apply(state, 1, a!).state;
    expect(canAfford(after, 1, 'city') || canAfford(after, 1, 'devCard')).toBe(true);
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
        options: { modules, victoryPoints: modules.includes('harbourmaster') ? 11 : 10 },
        crossCheckLegal: g % 8 === 0,
      }),
    );
  }
  return results;
}

describe('simulation', () => {
  // (The seatings, layouts and number placements go round every 24 games.)
  slow(`${games(48, 24)} bot games with the Almanac finish with no fall-backs and every invariant intact`, () => {
    const res = simulate(['almanac'], games(48, 24), 61_000);
    summarize('almanac', res);
    for (const r of res) {
      expect(r.winner).not.toBeNull();
      expect(r.fallbacks).toBe(0);
    }
    const turns = res.reduce((n, r) => n + r.turns, 0) / res.length;
    expect(turns).toBeGreaterThan(30);
    expect(turns).toBeLessThan(120);
  }, timeout(120_000));

  slow('the fuzzer finds every action it is offered legal', () => {
    for (let g = 0; g < 6; g++) {
      const r = runFuzzGame(62_000 + g, g % 3 === 0 ? 3 : 4, g % 2 ? 'random' : 'beginner', 700, true, { modules: ['almanac'] });
      expect(r.steps).toBeGreaterThan(0);
    }
    for (let g = 0; g < 6; g++) runFuzzGame(62_500 + g, g % 3 === 0 ? 3 : 4, 'random', 2500, false, { modules: ['almanac'] });
  }, timeout(120_000));

  it('a patched state with a decision owed still passes the harness’s checks', () => {
    const { state } = rollWith(island(), cardFor('harvest'));
    expect(() => checkInvariants(state, 'owed')).not.toThrow();
  });
});
