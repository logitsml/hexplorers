// Guilds: commodities, improvements and seats, the event die, the venture decks and every card,
// the trader, plus bot games and fuzzing of the guilds alone.
//
// The beginner island (seed 7) puts these pieces down for the four seats:
//   seat 0: settlement 3 (forest 10, mountains 9, hills 5), city 15 (mountains 9, pasture 6, fields 12)
//   seat 1: city 38 (forest 4, hills 6, mountains 3), settlement 43 (pasture 9, forest 11, fields 8)
//   seat 2: city 9 (pasture 3, hills 5, mountains 11), settlement 24 (forest 8, fields 4, pasture 5)
//   seat 3: city 13 (hills 2, mountains 11, forest 8), settlement 41 (hills 6, pasture 9, fields 10)
// The desert is hex 9.

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, emptyCards, handEstimate, isLand, legalActions, numbersOf, redactState, totalVictoryPoints, tradeRatios, type Action, type GameState } from '../../src/engine';
import { topology } from '../../src/engine/modules/invasion/topology';
import { Ctx, moveCards } from '../../src/engine/ctx';
import { trackEvents } from '../../src/engine/tracker';
import { placeWarden, promote, promoteBlocker } from '../../src/engine/modules/garrisons/wardens';
import { oweVentureChoice } from '../../src/engine/modules/guilds/deck';
import { VENTURES, coastBuildings, ventureCopies } from '../../src/engine/modules/guilds/ventures';
import { guilds } from '../../src/engine/modules/guilds';
import { legalRobberHexes } from '../../src/engine/rules';
import type { VentureId } from '../../src/engine/modules/guilds/types';
import type { BotDifficulty } from '../../src/engine/ai';
import { grant, patch, raidersAt } from '../helpers';
import { runBotGame, runFuzzGame, setups, type GameResult } from '../sim-harness';
import { act, citiesOf, eventsOf, game, giveVenture, main, refused, rollAs, setLevel, settlementsOf, stackDeck, summarize } from './guilds-helpers';
import { slow, timeout } from '../tier';

const G = ['guilds'] as const;
const GG = ['guilds', 'garrisons'] as const;
const play = (card: VentureId, params: Record<string, unknown> = {}): Action => ({ type: 'guilds/play', card, ...params }) as Action;

/** Move a victory venture from its deck to a player's shown cards (a point, venture count kept). */
function showPoint(s: GameState, player: number, card: 'encyclopaedia' | 'grandCharter' = 'encyclopaedia') {
  const g = s.ext.guilds!;
  const deck = g.decks[VENTURES[card].track];
  deck.splice(deck.indexOf(card), 1);
  g.shown[player].push(card);
}

describe('guilds: set-up and supply', () => {
  it('puts twelve of each commodity in the supply and sets the development deck aside', () => {
    const s = game([...G]);
    expect([s.bank.paper, s.bank.cloth, s.bank.silver]).toEqual([12, 12, 12]);
    expect(s.devDeck).toEqual([]);
  });

  it('has 49 ventures, 16, 17 and 16 to the tracks, with no card in more than four copies', () => {
    const per: Record<string, number> = {};
    for (const def of Object.values(VENTURES)) per[def.track] = (per[def.track] ?? 0) + def.count;
    expect(per).toEqual({ learning: 16, commerce: 17, statecraft: 16 });
    const s = game([...GG]);
    expect(Object.values(s.ext.guilds!.decks).map((d) => d.length)).toEqual([16, 17, 16]);
    expect(Math.max(...Object.values(VENTURES).map((d) => d.count))).toBe(4);
    expect(VENTURES.trader.count).toBe(4);
    expect(VENTURES.cornerMarket.count).toBe(3);
    expect(VENTURES.spymaster.count).toBe(2);
    // The four cards the third rules retired have none, and the new ones are in.
    for (const c of ['deepSeams', 'pathfinders', 'charterFleet', 'cartel'] as const) expect(VENTURES[c].count).toBe(0);
    for (const c of ['salvage', 'pilot', 'tradeWind', 'customs', 'stockpile', 'lighthouse'] as const) expect(VENTURES[c].count).toBeGreaterThan(0);
  });

  it('keeps the first rules for a game recorded under them: 54 ventures, 18 to a track, the old counts', () => {
    const s = game([...GG], { moduleRules: { guilds: 2 } });
    expect(Object.values(s.ext.guilds!.decks).map((d) => d.length)).toEqual([18, 18, 18]);
    const all = Object.values(s.ext.guilds!.decks).flat();
    expect(all.filter((c) => c === 'trader')).toHaveLength(6);
    expect(all).not.toContain('lighthouse');
    expect(s.ext.guilds!.wind).toBeUndefined();
    expect(s.ext.guilds!.lit).toBeUndefined();
    // Their cards keep their old numbers: a town planning city for a wheat and two ore, a resurvey that spares 2, 6, 8 and 12.
    const old = patch(s, (x) => {
      main(x, 0);
      giveVenture(x, 0, 'townPlanning');
      grant(x, 0, { wheat: 1, ore: 2 });
    });
    const r = act(old, 0, play('townPlanning', { vertex: 3 }));
    expect(r.state.players[0].hand.ore).toBe(old.players[0].hand.ore - 2);
    expect(r.state.players[0].hand.wheat).toBe(old.players[0].hand.wheat - 1);
    // A retired card still plays for it.
    const seams = patch(s, (x) => {
      main(x, 0);
      giveVenture(x, 0, 'deepSeams');
    });
    expect(act(seams, 0, play('deepSeams')).state.players[0].hand.ore - seams.players[0].hand.ore).toBe(2);
  });

  it("leaves the wardens' and walls' cards out without the garrisons", () => {
    const s = game([...G]);
    const d = s.ext.guilds!.decks;
    expect([d.learning.length, d.commerce.length, d.statecraft.length]).toEqual([14, 17, 11]);
    for (const c of ['masonry', 'forge', 'rally', 'agitators', 'treachery'] as const) {
      expect(Object.values(d).flat()).not.toContain(c);
    }
  });

  it('places a city in the second set-up round, with one resource from each of its hexes and no commodities', () => {
    let s = createGame(setups(4), { layout: 'random', seed: 11, modules: ['guilds'], victoryPoints: 13 }).state;
    while (s.phase === 'setupSettlement' || s.phase === 'setupRoad') {
      const p = s.currentPlayer;
      s = act(s, p, legalActions(s, p)[0]).state;
    }
    for (const p of s.players) {
      const cities = citiesOf(s, p.id);
      expect(cities).toHaveLength(1);
      expect(settlementsOf(s, p.id)).toHaveLength(1);
      expect(p.citiesLeft).toBe(3);
      expect(p.settlementsLeft).toBe(4);
      expect(p.hand.paper + p.hand.cloth + p.hand.silver).toBe(0);
      const resourceHexes = s.board.vertices[cities[0]].hexes.filter((h) => ['hills', 'forest', 'pasture', 'fields', 'mountains'].includes(s.board.hexes[h].terrain));
      expect(p.hand.brick + p.hand.wood + p.hand.wool + p.hand.wheat + p.hand.ore).toBe(resourceHexes.length);
    }
  });

  it('starts the beginner island with a city too', () => {
    const s = game([...G]);
    for (const p of s.players) {
      expect(citiesOf(s, p.id)).toHaveLength(1);
      expect(totalVictoryPoints(s, p.id)).toBe(3);
    }
  });
});

describe('guilds: production', () => {
  it('gives a city on mountains an ore and a silver, and a settlement there an ore', () => {
    const s = game([...G]);
    const before = { ...s.players[0].hand };
    const { state } = rollAs(s, 0, { total: 9 });
    expect(state.players[0].hand.ore - before.ore).toBe(2);
    expect(state.players[0].hand.silver - before.silver).toBe(1);
    // Settlements on the pasture 9 take one wool each, and no commodity.
    expect(state.players[1].hand.cloth).toBe(0);
  });

  it('gives a city on hills two brick, as before', () => {
    const s = game([...G]);
    const { state } = rollAs(s, 0, { total: 5 });
    expect(state.players[2].hand.brick - s.players[2].hand.brick).toBe(2);
    expect(state.players[2].hand.paper + state.players[2].hand.cloth + state.players[2].hand.silver).toBe(0);
  });

  it('gives a Learning 3 player who took no cards a resource of their choice', () => {
    const s = patch(game([...G]), (x) => {
      setLevel(x, 2, 'learning', 3);
      setLevel(x, 0, 'learning', 3);
    });
    const { state } = rollAs(s, 0, { total: 9 });
    // Seat 0 produced; seat 2 didn't, so it owes a pick before play goes on.
    expect(state.pending.map((p) => [p.kind, p.players])).toEqual([['guilds/pick', [2]]]);
    expect(legalActions(state, 0)).toEqual([]);
    expect(legalActions(state, 2)).toHaveLength(5);
    const after = act(state, 2, { type: 'guilds/pick', resource: 'ore' }).state;
    expect(after.players[2].hand.ore).toBe(state.players[2].hand.ore + 1);
    expect(after.pending).toEqual([]);
  });

  it('answers what production owes before a Learning pick, so the pick never takes a card production promised (rule 6)', () => {
    const g = createGame(setups(4), { seed: 5, modules: ['sea', 'guilds'], map: 'archipelago' }).state;
    const bounty = g.board.hexes.find((h) => h.terrain === 'bounty' && h.numbers.length > 0)!;
    const s = patch(g, (x) => {
      x.turn = 5;
      x.setupIndex = x.setupOrder.length;
      x.currentPlayer = 0;
      x.phase = 'roll';
      x.hasRolled = false;
      x.buildings[bounty.vertices[0]] = { owner: 0, kind: 'settlement' };
      x.players[0].settlementsLeft--;
      setLevel(x, 1, 'learning', 3);
    });
    const kinds = rollAs(s, 0, { total: bounty.numbers[0] }).state.pending.map((p) => p.kind);
    // (The stack answers its top first: the bounty pick, then the fall-back.)
    expect(kinds.at(-1)).toBe('sea/bountyPick');
    expect(kinds.indexOf('guilds/pick')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('guilds/pick')).toBeLessThan(kinds.lastIndexOf('sea/bountyPick'));
  });

  it('gives no Learning pick on a 7', () => {
    const s = patch(game([...G]), (x) => setLevel(x, 2, 'learning', 3));
    const { state } = rollAs(s, 0, { total: 7 });
    expect(state.pending.some((p) => p.kind === 'guilds/pick')).toBe(false);
  });

  it('counts commodities toward the hand a 7 halves, and lets the robber take them', () => {
    const s = patch(game([...G]), (x) => grant(x, 1, { paper: 5, cloth: 4 }));
    const held = Object.values(s.players[1].hand).reduce((a, b) => a + b, 0);
    const { state } = rollAs(s, 0, { total: 7 });
    expect(state.pendingDiscards[1]).toBe(Math.floor(held / 2));
  });
});

describe('guilds: improvements', () => {
  it('needs a city', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      grant(x, 0, { paper: 1 });
      x.buildings[15]!.kind = 'settlement';
      x.players[0].citiesLeft++;
      x.players[0].settlementsLeft--;
    });
    expect(refused(s, 0, { type: 'guilds/improve', track: 'learning' })).toBe('Improvements need a town.');
  });

  it('climbs one level at a time, each costing its own number of the track commodity', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      grant(x, 0, { paper: 3 });
    });
    const r = act(s, 0, { type: 'guilds/improve', track: 'learning' });
    expect(eventsOf(r.events, 'guilds/improved')).toEqual([{ type: 'guilds/improved', player: 0, track: 'learning', level: 1 }]);
    s = act(r.state, 0, { type: 'guilds/improve', track: 'learning' }).state;
    expect(s.ext.guilds!.levels[0].learning).toBe(2);
    expect(s.players[0].hand.paper).toBe(0);
    expect(refused(s, 0, { type: 'guilds/improve', track: 'learning' })).toBe('You need 3 paper.');
    expect(s.bank.paper).toBe(12);
  });

  it('takes one commodity less with a hoist, so a first level can cost nothing', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'hoist');
    });
    expect(legalActions(s, 0)).toContainEqual({ type: 'guilds/improve', track: 'statecraft', hoist: true });
    const r = act(s, 0, { type: 'guilds/improve', track: 'statecraft', hoist: true });
    expect(r.state.ext.guilds!.levels[0].statecraft).toBe(1);
    expect(r.state.ext.guilds!.hands[0]).toEqual([]);
    expect(r.state.ext.guilds!.decks.learning[0]).toBe('hoist');
  });

  it('gives the first to level 4 the seat, and the first to level 5 the seat for good', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      setLevel(x, 0, 'commerce', 3);
      setLevel(x, 1, 'commerce', 3);
      grant(x, 0, { cloth: 4 });
    });
    // Level 4 needs a city for the seat, and the legal list offers each one.
    expect(refused(s, 0, { type: 'guilds/improve', track: 'commerce' })).toBe('Choose a town for the seat.');
    expect(legalActions(s, 0)).toContainEqual({ type: 'guilds/improve', track: 'commerce', vertex: 15 });
    let r = act(s, 0, { type: 'guilds/improve', track: 'commerce', vertex: 15 });
    s = r.state;
    expect(s.buildings[15]!.seat).toBe('commerce');
    expect(eventsOf(r.events, 'guilds/seat')[0]).toMatchObject({ player: 0, vertex: 15, from: null, forGood: false });
    expect(totalVictoryPoints(s, 0)).toBe(5);
    // Seat 1 reaches level 4 second: no seat.
    main(s, 1);
    grant(s, 1, { cloth: 9 });
    s = act(s, 1, { type: 'guilds/improve', track: 'commerce' }).state;
    expect(s.buildings[38]!.seat).toBeUndefined();
    // Seat 1 reaches level 5 first: the seat moves to its city for good.
    r = act(s, 1, { type: 'guilds/improve', track: 'commerce', vertex: 38 });
    s = r.state;
    expect(s.buildings[15]!.seat).toBeUndefined();
    expect(s.buildings[38]!.seat).toBe('commerce');
    expect(s.ext.guilds!.seatsForGood).toEqual(['commerce']);
    expect(totalVictoryPoints(s, 0)).toBe(3);
    expect(totalVictoryPoints(s, 1)).toBe(5);
    // Seat 0 reaching level 5 later changes nothing.
    main(s, 0);
    grant(s, 0, { cloth: 5 });
    s = act(s, 0, { type: 'guilds/improve', track: 'commerce' }).state;
    expect(s.buildings[38]!.seat).toBe('commerce');
    expect(s.ext.guilds!.levels[0].commerce).toBe(5);
  });

  it('keeps the seat where it stands when its holder reaches level 5', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      setLevel(x, 0, 'learning', 3);
      grant(x, 0, { paper: 9 });
    });
    s = act(s, 0, { type: 'guilds/improve', track: 'learning', vertex: 15 }).state;
    expect(legalActions(s, 0)).toContainEqual({ type: 'guilds/improve', track: 'learning' });
    const r = act(s, 0, { type: 'guilds/improve', track: 'learning' });
    expect(r.state.buildings[15]!.seat).toBe('learning');
    expect(r.state.ext.guilds!.seatsForGood).toEqual(['learning']);
    expect(eventsOf(r.events, 'guilds/seat')[0]).toMatchObject({ vertex: 15, from: 15, forGood: true });
  });

  it('refuses levels 4 and 5 without a city that could hold a seat', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      setLevel(x, 0, 'learning', 4);
      setLevel(x, 0, 'commerce', 3);
      x.buildings[15]!.seat = 'learning';
      grant(x, 0, { cloth: 4 });
    });
    expect(refused(s, 0, { type: 'guilds/improve', track: 'commerce', vertex: 15 })).toBe('You need a town that could hold a seat.');
    expect(legalActions(s, 0).some((a) => a.type === 'guilds/improve')).toBe(false);
  });

  it('keeps seats off foundries unless the stackUpgrades knob is set', () => {
    const base = (knobs: Record<string, boolean>) =>
      patch(game([...G], { knobs }), (x) => {
        main(x, 0);
        setLevel(x, 0, 'learning', 3);
        x.buildings[15]!.foundry = true;
        grant(x, 0, { paper: 4 });
      });
    expect(refused(base({}), 0, { type: 'guilds/improve', track: 'learning', vertex: 15 })).toBe('You need a town that could hold a seat.');
    const s = act(base({ stackUpgrades: true }), 0, { type: 'guilds/improve', track: 'learning', vertex: 15 }).state;
    expect(s.buildings[15]!.seat).toBe('learning');
  });

  it('opens 2:1 commodity trades at Commerce 3', () => {
    const s = game([...G]);
    expect(tradeRatios(s, 0).cloth).toBe(4);
    const t = patch(s, (x) => setLevel(x, 0, 'commerce', 3));
    expect([tradeRatios(t, 0).paper, tradeRatios(t, 0).cloth, tradeRatios(t, 0).silver]).toEqual([2, 2, 2]);
    expect(tradeRatios(t, 0).wool).toBe(4);
    const u = patch(t, (x) => {
      main(x, 0);
      grant(x, 0, { silver: 2 });
    });
    const after = act(u, 0, { type: 'bankTrade', give: 'silver', get: 'brick', times: 1 }).state;
    expect(after.players[0].hand.silver).toBe(0);
  });
});

describe('guilds: the event die and drawing ventures', () => {
  const levels = (s: GameState) => {
    setLevel(s, 0, 'learning', 1);
    setLevel(s, 2, 'learning', 5);
    setLevel(s, 3, 'learning', 2);
  };

  it('has three ship faces and one for each track, and reads the red die from the production dice', () => {
    const s = game([...G]);
    const { state, events } = rollAs(s, 0, { face: 'learning' });
    expect(state.ext.guilds!.eventDie!.red).toBe(state.dice![0]);
    expect(eventsOf(events, 'guilds/eventDie')).toHaveLength(1);
  });

  it('gives a card from the face’s deck to each player whose level covers the red die, in turn order from the roller', () => {
    const s = patch(game([...G]), levels);
    s.currentPlayer = 3;
    const { state, events } = rollAs(s, 3, { face: 'learning', red: 3 });
    // Level 1 covers 1–2 (not 3); level 2 covers 1–3; level 5 covers 1–6.
    expect(eventsOf(events, 'guilds/drew').map((e) => e.player)).toEqual([3, 2]);
    expect(state.ext.guilds!.hands[2]).toHaveLength(1);
    expect(state.ext.guilds!.decks.learning).toHaveLength(12);
  });

  it('draws nothing on a ship', () => {
    const s = patch(game([...G]), levels);
    const { events } = rollAs(s, 0, { face: 'ship' });
    expect(eventsOf(events, 'guilds/drew')).toEqual([]);
  });

  it('shows a victory venture at once, worth a point, outside the hand', () => {
    const s = patch(game([...G]), (x) => {
      levels(x);
      stackDeck(x, 'encyclopaedia');
    });
    const { state, events } = rollAs(s, 0, { face: 'learning', red: 6 });
    expect(eventsOf(events, 'guilds/shown')).toEqual([{ type: 'guilds/shown', player: 2, card: 'encyclopaedia' }]);
    expect(state.ext.guilds!.hands[2]).toEqual([]);
    expect(totalVictoryPoints(state, 2)).toBe(4);
  });

  it('makes a player over four ventures off their turn discard at once, under the deck', () => {
    const s = patch(game([...G]), (x) => {
      levels(x);
      for (const c of ['hoist', 'resurvey', 'waterworks', 'salvage'] as const) giveVenture(x, 2, c);
      stackDeck(x, 'augury');
    });
    // Only level 5 covers a 6 (and on a 7 nobody owes a Learning pick).
    const { state } = rollAs(s, 0, { face: 'learning', red: 6, total: 7 });
    expect(state.ext.guilds!.hands[2]).toHaveLength(5);
    expect(state.pending.map((p) => [p.kind, p.players])).toEqual([['guilds/ventureLimit', [2]]]);
    const deckBefore = state.ext.guilds!.decks.learning.length;
    const after = act(state, 2, { type: 'guilds/discardVenture', card: 'resurvey' }).state;
    expect(after.pending).toEqual([]);
    expect(after.ext.guilds!.hands[2]).toHaveLength(4);
    expect(after.ext.guilds!.decks.learning[0]).toBe('resurvey');
    expect(after.ext.guilds!.decks.learning).toHaveLength(deckBefore + 1);
  });

  it('gives the player whose turn it is until the end of their actions', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      for (const c of ['hoist', 'resurvey', 'waterworks', 'salvage', 'pilot'] as const) giveVenture(x, 0, c);
    });
    expect(s.pending).toEqual([]);
    s = act(s, 0, { type: 'endTurn' }).state;
    expect(s.phase).toBe('endOfTurn');
    expect(s.pending.map((p) => [p.kind, p.players])).toEqual([['guilds/ventureLimit', [0]]]);
    s = act(s, 0, { type: 'guilds/discardVenture', card: 'hoist' }).state;
    expect(s.currentPlayer).toBe(1);
    expect(s.phase).toBe('roll');
  });

  it('draws a venture from the deck of your choice (rule 3), discarding off-turn if over the limit', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      for (const c of ['hoist', 'resurvey', 'waterworks', 'salvage'] as const) giveVenture(x, 1, c);
      stackDeck(x, 'unrest');
    });
    const ctx = new Ctx(structuredClone(s));
    oweVentureChoice(ctx.s, [0, 1]);
    let t = ctx.s;
    expect(t.pending.at(-1)!.players).toEqual([0]);
    expect(legalActions(t, 0)).toEqual(['learning', 'commerce', 'statecraft'].map((track) => ({ type: 'guilds/draw', track })));
    t = act(t, 0, { type: 'guilds/draw', track: 'commerce' }).state;
    t = act(t, 1, { type: 'guilds/draw', track: 'statecraft' }).state;
    expect(t.ext.guilds!.hands[0]).toHaveLength(1);
    expect(t.pending.map((p) => [p.kind, p.players])).toEqual([['guilds/ventureLimit', [1]]]);
  });

  it('hides other hands and the decks from each seat', () => {
    const s = patch(game([...G]), (x) => giveVenture(x, 1, 'trader'));
    const v = redactState(s, 0);
    expect(v.ext.guilds!.hands[1]).toEqual(['hidden']);
    expect(v.ext.guilds!.decks.commerce.every((c) => c === 'hidden')).toBe(true);
    expect(redactState(s, 1).ext.guilds!.hands[1]).toEqual(['trader']);
  });
});

describe('guilds: ventures', () => {
  it('plays only cards in hand, and not the hoist on its own', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'hoist');
    });
    expect(refused(s, 0, play('waterworks'))).toBe('You do not have that card.');
    expect(refused(s, 0, play('hoist'))).toBe('You cannot play that card on its own.');
  });

  it('augury: names the production dice before the roll, red die included', () => {
    let s = patch(game([...G]), (x) => giveVenture(x, 0, 'augury'));
    expect(legalActions(s, 0).filter((a) => a.type === 'guilds/play')).toHaveLength(11);
    expect(refused(s, 0, play('augury', { dice: [0, 7] }))).toBe('Name two dice from 1 to 6.');
    s = act(s, 0, play('augury', { dice: [4, 5] })).state;
    const { state } = rollAs(s, 0, {});
    expect(state.dice).toEqual([4, 5]);
    expect(state.ext.guilds!.eventDie!.red).toBe(4);
    const m = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'augury');
    });
    expect(refused(m, 0, play('augury', { dice: [3, 3] }))).toBe('Play it before you roll.');
  });

  it('masonry: a free wall under one of your cities', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'masonry');
    });
    expect(refused(s, 0, play('masonry', { vertex: 3 }))).toBe('You cannot play that card like that.');
    const after = act(s, 0, play('masonry', { vertex: 15 })).state;
    expect(after.buildings[15]!.wall).toBe(true);
    expect(after.players[0].hand).toEqual(s.players[0].hand);
  });

  it('resurvey: swaps two number discs, never a 5, 6, 8 or 9, and production follows', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'resurvey');
    });
    const options = legalActions(s, 0).filter((a) => a.type === 'guilds/play') as { hexes: [number, number] }[];
    for (const o of options) for (const h of o.hexes) expect([5, 6, 8, 9]).not.toContain(s.board.hexes[h].numbers[0]);
    expect(refused(s, 0, play('resurvey', { hexes: [0, 7] }))).toBe('You cannot play that card like that.');
    s = act(s, 0, play('resurvey', { hexes: [0, 1] })).state;
    expect(numbersOf(s, s.board.hexes[0])).toEqual([3]);
    expect(numbersOf(s, s.board.hexes[1])).toEqual([10]);
    // A 3 now falls on the forest by seat 0's settlement.
    s = patch(s, (x) => {
      x.phase = 'roll';
      x.hasRolled = false;
    });
    const { state } = rollAs(s, 0, { total: 3 });
    expect(state.players[0].hand.wood - s.players[0].hand.wood).toBe(1);
    expect(state.players[0].hand.ore).toBe(s.players[0].hand.ore);
  });

  it('resurvey with Oil: only surviving numbers move, so a number pollution took stays lost', () => {
    const surviving = (x: GameState) => x.board.hexes.reduce((n, h) => n + numbersOf(x, h).length, 0);
    const base = patch(game(['guilds', 'oil']), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'resurvey');
    });
    const [three, otherThree] = base.board.hexes.filter((h) => h.numbers[0] === 3).map((h) => h.id);
    const ten = base.board.hexes.find((h) => h.numbers[0] === 10)!.id;
    const swaps = (x: GameState) => (legalActions(x, 0).filter((a) => a.type === 'guilds/play') as { hexes: [number, number] }[]).map((a) => a.hexes);

    // The reviewer's case: pollution takes a hex's 3, and swapping it with a 10 brought the 3 back.
    const polluted = patch(base, (x) => x.ext.oil!.lost.push({ hex: three, number: 3 }));
    expect(surviving(polluted)).toBe(surviving(base) - 1);
    expect(swaps(polluted).some((h) => h.includes(three))).toBe(false);
    expect(refused(polluted, 0, play('resurvey', { hexes: [Math.min(three, ten), Math.max(three, ten)] }))).toBe('You cannot play that card like that.');

    // A hex that bore two numbers and lost one moves the one it has left; the lost one stays lost,
    // even when the swap brings a disc of the same number onto it.
    const two = patch(base, (x) => {
      x.board.hexes[three].numbers = [3, 11];
      x.ext.oil!.lost.push({ hex: three, number: 3 });
    });
    expect(numbersOf(two, two.board.hexes[three])).toEqual([11]);
    const before = surviving(two);
    const pair: [number, number] = [Math.min(three, otherThree), Math.max(three, otherThree)];
    expect(swaps(two)).toContainEqual(pair);
    const after = act(two, 0, play('resurvey', { hexes: pair })).state;
    expect(numbersOf(after, after.board.hexes[three])).toEqual([3]);
    expect(numbersOf(after, after.board.hexes[otherThree])).toEqual([11]);
    expect(surviving(after)).toBe(before);
  });

  it('resurvey never moves the lake’s numbers, even down to one', () => {
    const s = patch(game(['guilds', 'fisheries', 'oil']), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'resurvey');
      const lake = x.board.hexes.find((h) => h.terrain === 'lake')!;
      for (const n of [2, 11, 12]) x.ext.oil!.lost.push({ hex: lake.id, number: n });
    });
    const lake = s.board.hexes.find((h) => h.terrain === 'lake')!.id;
    expect(numbersOf(s, s.board.hexes[lake])).toEqual([3]);
    const plays = legalActions(s, 0).filter((a) => a.type === 'guilds/play') as { hexes: [number, number] }[];
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.some((a) => a.hexes.includes(lake))).toBe(false);
  });

  it('waterworks: two wheat for each fields hex beside your buildings, not each building', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'waterworks');
    });
    const t = act(s, 0, play('waterworks')).state;
    // (Seat 0's city touches the one fields hex.)
    expect(t.players[0].hand.wheat - s.players[0].hand.wheat).toBe(2);
  });

  /** Seat 0 with settlements on three coastal corners (patching). */
  const coastal3 = (x: GameState) => {
    const spots = x.board.vertices.flatMap((v, i) => (v.hexes.length < 3 && !x.buildings[i] ? [i] : [])).slice(0, 3);
    for (const v of spots) {
      x.buildings[v] = { owner: 0, kind: 'settlement' };
      x.players[0].settlementsLeft--;
    }
  };

  it('salvage: a resource of your choice for each building on the coast, at most three', () => {
    const base = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'salvage');
    });
    // Nothing of seat 0's stands on the coast of the beginner island.
    expect(coastBuildings(base, 0)).toBe(0);
    expect(legalActions(base, 0).some((a) => a.type === 'guilds/play')).toBe(false);
    let s = patch(base, coastal3);
    expect(coastBuildings(s, 0)).toBe(3);
    s = act(s, 0, play('salvage')).state;
    expect(s.pending.map((p) => [p.kind, p.players])).toEqual([['guilds/pick', [0]], ['guilds/pick', [0]], ['guilds/pick', [0]]]);
    const before = s.players[0].hand;
    for (const resource of ['brick', 'brick', 'ore'] as const) s = act(s, 0, { type: 'guilds/pick', resource }).state;
    expect(s.pending).toEqual([]);
    expect([s.players[0].hand.brick - before.brick, s.players[0].hand.ore - before.ore]).toEqual([2, 1]);
  });

  it('pilot: a free road, and a brick and a wood from the supply', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'pilot');
    });
    const before = s.players[0].hand;
    s = act(s, 0, play('pilot')).state;
    expect([s.phase, s.freeRoadsLeft]).toEqual(['roadBuilding', 1]);
    expect([s.players[0].hand.brick - before.brick, s.players[0].hand.wood - before.wood]).toEqual([1, 1]);
    s = act(s, 0, legalActions(s, 0).find((x) => x.type === 'placeFreeRoad')!).state;
    expect(s.phase).toBe('main');
    expect(s.players[0].roadsLeft).toBe(12);
  });

  it('town planning: a town for two wheat and an ore', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'townPlanning');
      x.players[0].hand = { ...x.players[0].hand, wheat: 1, ore: 1 };
    });
    // One wheat is not enough.
    expect(legalActions(s, 0).some((a) => a.type === 'guilds/play')).toBe(false);
    const rich = patch(s, (x) => {
      x.players[0].hand = { ...x.players[0].hand, wheat: 2, ore: 1 };
    });
    expect(legalActions(rich, 0)).toContainEqual(play('townPlanning', { vertex: 3 }));
    const r = act(rich, 0, play('townPlanning', { vertex: 3 }));
    expect(r.state.buildings[3]!.kind).toBe('city');
    expect(r.state.players[0].hand.ore).toBe(0);
    expect(r.state.players[0].hand.wheat).toBe(0);
    expect(r.state.players[0].citiesLeft).toBe(2);
    expect(totalVictoryPoints(r.state, 0)).toBe(4);
  });

  it('town planning: every seat tracks its discounted payment exactly once', () => {
    const s = game([...G]);
    main(s, 0);
    giveVenture(s, 0, 'townPlanning');
    const ctx = new Ctx(s);
    moveCards(ctx, null, 0, { ...emptyCards(), wheat: 4, ore: 6 }, 'learning');
    trackEvents(s, ctx.events);
    for (const viewer of [0, 1, 2, 3, null]) expect(handEstimate(s, viewer, 0).sure).toEqual(s.players[0].hand);
    const r = act(s, 0, play('townPlanning', { vertex: 3 }));
    expect(r.events.map((e) => e.type)).toEqual(['guilds/played', 'cardsMoved', 'cityBuilt']);
    for (const viewer of [0, 1, 2, 3, null]) {
      const estimate = handEstimate(r.state, viewer, 0);
      expect(estimate.sure).toEqual(r.state.players[0].hand);
      expect(estimate.expected).toEqual(r.state.players[0].hand);
    }
  });

  it('trade wind: every bank rate one better until the turn ends, never past 2:1', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'tradeWind');
      giveVenture(x, 0, 'tradeWind');
      grant(x, 0, { paper: 3 });
    });
    const before = tradeRatios(s, 0);
    s = act(s, 0, play('tradeWind')).state;
    const after = tradeRatios(s, 0);
    for (const k of Object.keys(before) as (keyof typeof before)[]) expect(after[k]).toBe(Math.max(2, before[k] - 1));
    expect(after.paper).toBe(3);
    // Only the player whose turn it is gains; and not twice over.
    expect(tradeRatios(s, 1)).toEqual(tradeRatios(patch(s, (x) => (x.ext.guilds!.wind = false)), 1));
    expect(legalActions(s, 0).some((a) => a.type === 'guilds/play' && a.card === 'tradeWind')).toBe(false);
    s = act(s, 0, { type: 'bankTrade', give: 'paper', get: 'ore', times: 1 }).state;
    expect(s.players[0].hand.paper).toBe(0);
    s = act(s, 0, { type: 'endTurn' }).state;
    expect(tradeRatios(s, 0).paper).toBe(4);
    expect(s.ext.guilds!.wind).toBe(false);
  });

  it('corner the market: two of a resource from each other player (or the one they have)', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'cornerMarket');
      grant(x, 2, { ore: 2 });
    });
    const t = act(s, 0, play('cornerMarket', { kind: 'ore' })).state;
    expect(t.players.map((p) => p.hand.ore)).toEqual([s.players[0].hand.ore + 2 + 1 + 1, 0, 1, 0]);
  });

  it('corner the market naming oil: one at a time from each opponent clockwise, up to two each, until your hold is full', () => {
    const oilGame = (fn: (x: GameState) => void) =>
      patch(game(['guilds', 'oil']), (x) => {
        main(x, 0);
        giveVenture(x, 0, 'cornerMarket');
        // (From empty holds: the starting oil a well beside a city gives goes back.)
        for (const p of x.players) {
          x.bank.oil += p.hand.oil;
          p.hand.oil = 0;
        }
        for (const p of [1, 2, 3]) grant(x, p, { oil: 2 });
        fn(x);
      });
    const oils = (x: GameState) => x.players.map((p) => p.hand.oil);
    // Room for two: one each from the next two players round the table, not two from the first.
    const two = oilGame((x) => grant(x, 0, { oil: 2 }));
    expect(oils(act(two, 0, play('cornerMarket', { kind: 'oil' })).state)).toEqual([4, 1, 1, 2]);
    // Room for four: a round of one each, then the first again.
    const four = oilGame(() => {});
    expect(oils(act(four, 0, play('cornerMarket', { kind: 'oil' })).state)).toEqual([4, 0, 1, 1]);
    // An opponent who runs out is passed over on the second round.
    const short = oilGame((x) => {
      x.players[1].hand.oil--;
      x.bank.oil++;
    });
    expect(oils(act(short, 0, play('cornerMarket', { kind: 'oil' })).state)).toEqual([4, 0, 0, 1]);
  });

  it('customs: one of the named kind from each other player holding two or more', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'customs');
      grant(x, 1, { silver: 3 });
      grant(x, 3, { silver: 1 });
    });
    const t = act(s, 0, play('customs', { kind: 'silver' })).state;
    expect(t.players.map((p) => p.hand.silver)).toEqual([1, 2, 0, 1]);
  });

  it('stockpile: one of each commodity from the supply, as far as it goes', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'stockpile');
      x.players[2].hand.cloth += x.bank.cloth;
      x.bank.cloth = 0;
    });
    const t = act(s, 0, play('stockpile')).state;
    expect([t.players[0].hand.paper - s.players[0].hand.paper, t.players[0].hand.cloth - s.players[0].hand.cloth, t.players[0].hand.silver - s.players[0].hand.silver]).toEqual([1, 0, 1]);
  });

  it('lighthouse: the robber cannot be sent to the lit hex until its owner’s next turn begins', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'lighthouse');
    });
    expect(legalRobberHexes(s)).toContain(3);
    // Only land beside the player's own buildings can be lit.
    expect(refused(s, 0, play('lighthouse', { hex: 14 }))).toBe('You cannot play that card like that.');
    const r = act(s, 0, play('lighthouse', { hex: 3 }));
    expect(r.events).toContainEqual({ type: 'guilds/lit', player: 0, hex: 3 });
    s = r.state;
    expect(legalRobberHexes(s)).not.toContain(3);
    expect(legalRobberHexes(s)).toContain(0);
    // It stays lit through the other players' turns, and goes out when its owner's turn begins.
    const rival = patch(s, (x) => (x.currentPlayer = 1));
    guilds.hooks!.turnStarted!(new Ctx(rival));
    expect(rival.ext.guilds!.lit).toEqual([{ hex: 3, owner: 0 }]);
    const mine = patch(s, (x) => (x.currentPlayer = 0));
    guilds.hooks!.turnStarted!(new Ctx(mine));
    expect(mine.ext.guilds!.lit).toEqual([]);
    // It is left out of the deck under Invasion, where there is no robber.
    expect(ventureCopies(game(['guilds', 'garrisons', 'invasion']), VENTURES.lighthouse)).toBe(0);
  });

  it('right of way: removes an open road (never a bridge); your own may be rebuilt for free', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'rightOfWay');
      x.routes[21] = { owner: 3, kind: 'bridge', builtTurn: 0 };
    });
    const edges = (legalActions(s, 0).filter((a) => a.type === 'guilds/play') as { edge: number }[]).map((a) => a.edge);
    expect(edges).toContain(2);
    expect(edges).toContain(9);
    expect(edges).not.toContain(21);
    // Another player's road goes back to them.
    s = act(s, 0, play('rightOfWay', { edge: 9 })).state;
    expect(s.routes[9]).toBeNull();
    expect(s.players[2].roadsLeft).toBe(14);
    expect(s.pending).toEqual([]);
    // Your own: a free road may follow (the card went back under its deck; the deck has one copy).
    s = patch(s, (x) => giveVenture(x, 0, 'rightOfWay'));
    s = act(s, 0, play('rightOfWay', { edge: 2 })).state;
    expect(s.pending.at(-1)!.kind).toBe('guilds/rebuild');
    s = act(s, 0, { type: 'guilds/rebuild', edge: 2 }).state;
    expect(s.routes[2]).toMatchObject({ owner: 0, kind: 'road' });
    expect(s.players[0].roadsLeft).toBe(13);
  });

  it('right of way: removing a road from a river hex costs a coin', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'rightOfWay');
      x.board = structuredClone(x.board);
      x.board.features.rivers = [{ hexes: [4], bridgeSites: [] }];
    });
    const edges = (s0: GameState) => (legalActions(s0, 0).filter((a) => a.type === 'guilds/play') as { edge: number }[]).map((a) => a.edge);
    expect(edges(s)).not.toContain(9);
    const rich = patch(s, (x) => (x.players[0].coins = 1));
    expect(edges(rich)).toContain(9);
    expect(act(rich, 0, play('rightOfWay', { edge: 9 })).state.players[0].coins).toBe(0);
  });

  it('spymaster: takes one venture from another hand, seen only by the spy', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'spymaster');
      giveVenture(x, 1, 'customs');
      giveVenture(x, 1, 'hoist');
    });
    s = act(s, 0, play('spymaster', { target: 1 })).state;
    expect(redactState(s, 2).pending.at(-1)!.data).toMatchObject({ seen: ['hidden', 'hidden'] });
    expect(redactState(s, 0).pending.at(-1)!.data).toMatchObject({ seen: ['customs', 'hoist'] });
    s = act(s, 0, { type: 'guilds/takeVenture', card: 'customs' }).state;
    expect(s.ext.guilds!.hands[0]).toEqual(['customs']);
    expect(s.ext.guilds!.hands[1]).toEqual(['hoist']);
  });

  it('unrest: everyone with at least your points discards a third of their cards, rounded up', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'unrest');
      x.players.forEach((p) => (p.hand = { ...p.hand, brick: 0, wood: 0, wool: 0, wheat: 0, ore: 0 }));
      x.bank = { ...x.bank, brick: 19, wood: 19, wool: 19, wheat: 19, ore: 19 };
      grant(x, 1, { brick: 3, paper: 2 });
      grant(x, 2, { ore: 1 });
      grant(x, 3, { wool: 4 });
      showPoint(x, 3);
      showPoint(x, 0, 'grandCharter');
    });
    // Seat 0 has 4 points now: only seat 3 (also 4) is hit.
    s = act(s, 0, play('unrest')).state;
    expect(s.pending.map((p) => [p.kind, p.players])).toEqual([['guilds/discard', [3]]]);
    s = act(s, 3, { type: 'guilds/discardCard', card: 'wool' }).state;
    s = act(s, 3, { type: 'guilds/discardCard', card: 'wool' }).state;
    expect(s.pending).toEqual([]);
    expect(s.players[3].hand.wool).toBe(2);
    expect(s.players[1].hand.brick).toBe(3);
  });

  it('offers the tribute and the spymaster’s take from what the venture showed, so a view redacted for the taker offers the same', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 1);
      giveVenture(x, 1, 'tribute');
      giveVenture(x, 1, 'spymaster');
      giveVenture(x, 2, 'augury');
      // (A tribute is taken from a player with more points.)
      const v = x.buildings.findIndex((b) => b?.owner === 2 && b.kind === 'settlement');
      x.buildings[v] = { owner: 2, kind: 'city' };
      x.players[2].settlementsLeft++;
      x.players[2].citiesLeft--;
    });
    const sorted = (as: Action[]) => as.map((a) => JSON.stringify(a)).sort();
    const tribute = act(s, 1, play('tribute', { target: 2 })).state;
    expect(sorted(legalActions(redactState(tribute, 1), 1))).toEqual(sorted(legalActions(tribute, 1)));
    expect(legalActions(tribute, 1).length).toBeGreaterThan(0);
    const spy = act(s, 1, play('spymaster', { target: 2 })).state;
    expect(sorted(legalActions(redactState(spy, 1), 1))).toEqual(sorted(legalActions(spy, 1)));
    expect(legalActions(spy, 1)).toContainEqual({ type: 'guilds/takeVenture', card: 'augury' });
  });

  it('tax collectors: the robber moves and robs each player on its new hex', () => {
    const s = patch(game([...G]), (x) => {
      main(x, 1);
      giveVenture(x, 1, 'taxCollectors');
    });
    const t = act(s, 1, play('taxCollectors', { hex: 4 })).state;
    expect(t.robberHex).toBe(4);
    const lost = (p: number) => Object.values(s.players[p].hand).reduce((a, b) => a + b, 0) - Object.values(t.players[p].hand).reduce((a, b) => a + b, 0);
    expect([lost(0), lost(2)]).toEqual([1, 1]);
    // A player holding only oil keeps it: a venture never takes oil (only the resource monopoly may name it).
    const oily = patch(game(['guilds', 'oil']), (x) => {
      main(x, 1);
      x.robberHex = s.robberHex;
      giveVenture(x, 1, 'taxCollectors');
      for (const [k, n] of Object.entries(x.players[2].hand)) {
        x.bank[k as keyof typeof x.bank] += n;
        x.players[2].hand[k as keyof typeof x.bank] = 0;
      }
      x.bank.oil -= 2;
      x.players[2].hand.oil = 2;
    });
    const taxed = act(oily, 1, play('taxCollectors', { hex: 4 }));
    expect(taxed.state.players[2].hand.oil).toBe(2);
    expect(taxed.events.filter((e) => e.type === 'stolen').map((e) => (e as { victim: number }).victim)).toEqual([0]);
    // Not while the robber is off the board.
    const off = patch(s, (x) => (x.robberHex = null));
    expect(legalActions(off, 1).some((a) => a.type === 'guilds/play')).toBe(false);
  });

  it('dowry: each player with more points gives you a card, or two if they lead by two or more', () => {
    let s = patch(game([...G]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'dowry');
      showPoint(x, 1);
      showPoint(x, 1, 'grandCharter');
      // Seat 2 raises a house to a town: one point ahead.
      x.buildings[24]!.kind = 'city';
      x.players[2].settlementsLeft++;
      x.players[2].citiesLeft--;
    });
    s = act(s, 0, play('dowry')).state;
    expect(s.pending.map((p) => p.players[0])).toEqual([2, 1]);
    const before = s.players[0].hand;
    // Seat 1 leads by two, seat 2 by one.
    for (const p of [1, 1, 2]) {
      const a = legalActions(s, p)[0];
      s = act(s, p, a).state;
    }
    expect(s.pending).toEqual([]);
    expect(Object.values(s.players[0].hand).reduce((a, b) => a + b, 0) - Object.values(before).reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('guilds: under Invasion', () => {
  /**
   * Seat 0's city moved to a corner of the coast with every land hex round it conquered (raiders
   * land only on the coast, so only a corner there can be cut off). `at` is that corner.
   */
  const coastCorner = (x: GameState) => {
    const coastal = topology(x.board).coastal;
    const land = (v: number) => x.board.vertices[v].hexes.filter((h) => isLand(x.board.hexes[h].terrain));
    return x.board.vertices.find((v) => land(v.id).length === 2 && land(v.id).every((h) => coastal[h] && x.board.hexes[h].terrain !== 'castle') && !x.buildings[v.id] && v.neighbors.every((n) => !x.buildings[n]))!.id;
  };
  const cutOff = () =>
    patch(game(['guilds', 'garrisons', 'invasion']), (x) => {
      const at = coastCorner(x);
      x.buildings[at] = { ...x.buildings[15]!, seat: 'learning' };
      x.buildings[15] = null;
      x.ext.invasion = raidersAt(x, x.board.hexes.map((h) => (x.board.vertices[at].hexes.includes(h.id) && isLand(h.terrain) ? 3 : 0)));
      setLevel(x, 0, 'learning', 4);
      grant(x, 0, { paper: 5, cloth: 1 });
    });

  it('keeps a cut-off seat its points, but it produces nothing and freezes its track', () => {
    const s = cutOff();
    expect(totalVictoryPoints(s, 0)).toBe(5);
    const { state } = rollAs(s, 0, { total: 6 });
    expect(state.players[0].hand.wool).toBe(s.players[0].hand.wool);
    main(s, 0);
    expect(refused(s, 0, { type: 'guilds/improve', track: 'learning' })).toBe("That track's seat is cut off.");
    expect(applyAction(s, 0, { type: 'guilds/improve', track: 'commerce' }).ok).toBe(true);
  });

  it('loses the trader when its hex is conquered', () => {
    const s = patch(cutOff(), (x) => {
      main(x, 0);
      x.ext.guilds!.trader = { hex: x.board.hexes.find((h) => x.ext.invasion!.raiders[h.id] === 3)!.id, owner: 0 };
    });
    const t = act(s, 0, { type: 'guilds/improve', track: 'commerce' }).state;
    expect(t.ext.guilds!.trader).toBeNull();
  });
});

describe('guilds: bots and fuzzing', () => {
  const results: GameResult[] = [];
  const diffs = (g: number, n: number): BotDifficulty[] => Array.from({ length: n }, (_, i) => (['easy', 'normal', 'hard'] as const)[(g + i) % 3]);

  slow('20 bot games of the guilds alone finish with no fall-backs', () => {
    for (let g = 0; g < 20; g++) {
      const n = g % 2 ? 3 : 4;
      const r = runBotGame({ seed: 7000 + g, players: n as 3 | 4, layout: g % 4 === 0 ? 'beginner' : 'random', difficulties: diffs(g, n), options: { modules: [...G], victoryPoints: 13 }, crossCheckLegal: g % 5 === 0 });
      expect(r.winner).not.toBeNull();
      expect(r.fallbacks).toBe(0);
      results.push(r);
    }
    summarize('guilds alone', results);
  }, timeout(120_000));

  slow('every legal action applies, and every venture and card stays conserved, under random play', () => {
    let checked = 0;
    for (let g = 0; g < 4; g++) checked += runFuzzGame(7100 + g, g % 2 ? 3 : 4, g % 2 ? 'random' : 'beginner', 700, true, { modules: [...G], victoryPoints: 13 }).checkedActions;
    for (let g = 0; g < 6; g++) runFuzzGame(7200 + g, g % 2 ? 3 : 4, 'random', 2000, false, { modules: [...G], victoryPoints: 13 });
    expect(checked).toBeGreaterThan(5000);
  }, timeout(120_000));
});


describe('guilds: forge promotion order', () => {
  it('lets the first promotion free the piece the second needs, retaining the first rules’ choices', () => {
    for (const version of [1, 2]) {
      const s = game([...GG], { moduleRules: { guilds: version } });
      main(s, 0);
      giveVenture(s, 0, 'forge');
      setLevel(s, 0, 'statecraft', 3);
      const vs = s.buildings.flatMap((b, v) => b ? [] : [v]);
      const a = placeWarden(s, 0, 1, { vertex: vs[0], edge: null });
      const b = placeWarden(s, 0, 2, { vertex: vs[1], edge: null });
      placeWarden(s, 0, 2, { vertex: vs[2], edge: null });
      expect(promoteBlocker(s, 0, a)).not.toBeNull();
      const c = new Ctx(structuredClone(s));
      promote(c, c.s.wardens.find((w) => w.id === b.id)!, true);
      expect(promoteBlocker(c.s, 0, c.s.wardens.find((w) => w.id === a.id))).toBeNull();
      const action = play('forge', { wardens: [b.id, a.id] });
      if (version === 1) {
        expect(legalActions(s, 0)).not.toContainEqual(action);
        expect(applyAction(s, 0, action).ok).toBe(false);
        expect(VENTURES.forge.options!(s, 0)).toEqual([{ wardens: [2] }, { wardens: [3] }, { wardens: [2, 3] }]);
      } else {
        expect(legalActions(s, 0)).toContainEqual(action);
        const r = act(s, 0, action);
        expect(r.state.wardens.map((w) => w.rank)).toEqual([2, 3, 2]);
        expect(r.state.ext.garrisons!.promoted).toEqual([b.id, a.id]);
        expect(r.state.ext.guilds!.hands[0]).not.toContain('forge');
      }
    }
  });
});
