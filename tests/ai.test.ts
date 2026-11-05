// The bots' trading, information and planning: fair trades, only what they could know, and a plan
// that takes the win when it's there.

import { describe, expect, it } from 'vitest';
import {
  RESOURCES,
  applyAction,
  createGame,
  emptyTracker,
  handEstimate,
  longestRoadFor,
  totalCards,
  totalVictoryPoints,
  trackEvents,
  type GameState,
  type Production,
  type CardCounts,
} from '../src/engine';
import { PROFILES, botDecide, createBotMemory, wouldAccept, type BotDifficulty } from '../src/engine/ai';
import { BotCtx } from '../src/engine/ai/context';
import { dealValue } from '../src/engine/ai/trade';
import { FOUR, apply, beginnerGame, patch, rc, toMain, road } from './helpers';
import { slow, timeout } from './tier';

/** The hands as they stand, as if every card had been seen arriving (so the tracker knows them). */
function known(state: GameState) {
  state.tracker = emptyTracker(state.players.length);
  const grants: Production[] = state.players.flatMap((p) => RESOURCES.filter((r) => p.hand[r] > 0).map((r) => ({ player: p.id, hex: 0, vertex: 0, resource: r, amount: p.hand[r] })));
  trackEvents(state, [{ type: 'production', total: 0, grants, blockedHexes: [], shortages: [] }]);
  return state;
}

const setHand = (s: GameState, p: number, h: Partial<CardCounts>) => {
  for (const r of RESOURCES) s.bank[r] += s.players[p].hand[r];
  s.players[p].hand = rc(h);
  for (const r of RESOURCES) s.bank[r] -= s.players[p].hand[r];
};

describe('bot trade fairness', () => {
  // Blue is a wheat short of a city; Red (a person) offers the wheat.
  const table = () =>
    known(
      patch(beginnerGame(), (x) => {
        toMain(x, 0);
        x.players[0].isBot = false;
        setHand(x, 0, { wheat: 2, brick: 1 });
        setHand(x, 1, { wheat: 1, ore: 3, wool: 2, brick: 2, wood: 2 });
      }),
    );

  it('will not give six cards for the wheat that finishes its city', () => {
    const s = table();
    for (const d of ['normal', 'hard'] as BotDifficulty[]) {
      expect(wouldAccept(s, 1, 0, rc({ wheat: 1 }), rc({ wool: 2, brick: 2, wood: 2 }), d)).toBe(false);
      expect(wouldAccept(s, 1, 0, rc({ wheat: 1 }), rc({ wool: 1, brick: 1, wood: 1 }), d)).toBe(false);
      // A fair swap that helps it is still taken.
      expect(wouldAccept(s, 1, 0, rc({ wheat: 1 }), rc({ wool: 1 }), d)).toBe(true);
    }
  });

  slow('never gives more than one card beyond what it gets', () => {
    let accepted = 0;
    for (let i = 0; i < 300; i++) {
      const s = table();
      const give = rc({ [RESOURCES[i % 5]]: 1 + (i % 2) });
      const get = rc({ [RESOURCES[(i + 1 + (i >> 3) % 4) % 5]]: 1 + ((i >> 1) % 3), [RESOURCES[(i + 2 + (i >> 5) % 3) % 5]]: (i >> 2) % 3 });
      if (RESOURCES.some((r) => give[r] > 0 && get[r] > 0)) continue;
      const r = applyAction(s, 0, { type: 'offerTrade', give, get, to: [1] });
      if (!r.ok) continue;
      const a = botDecide(r.state, 1, createBotMemory({ waitForHumans: true }), 'hard');
      if (a?.type === 'respondTrade' && a.accept) {
        accepted++;
        expect(totalCards(get)).toBeLessThanOrEqual(totalCards(give) + 1);
      }
      if (a?.type === 'counterTrade') expect(totalCards(a.give)).toBeLessThanOrEqual(totalCards(a.get) + 1);
    }
    expect(accepted).toBeGreaterThan(0);
  }, timeout(60_000));

  it('counts what a deal is worth to its partner, the leader most of all', () => {
    // Orange holds a city's worth bar one wheat; giving it that wheat helps Orange a lot.
    const s = known(
      patch(beginnerGame(), (x) => {
        toMain(x, 3);
        setHand(x, 1, { wheat: 3, wool: 1 });
        setHand(x, 3, { wheat: 1, ore: 3, brick: 1 });
        setHand(x, 2, { brick: 2 });
      }),
    );
    const ctx = new BotCtx(s, 1, 'hard', createBotMemory());
    const toOrange = dealValue(ctx, 3, rc({ wheat: 1 }), rc({ brick: 1 }));
    const toWhite = dealValue(ctx, 2, rc({ wheat: 1 }), rc({ brick: 1 }));
    expect(ctx.gainFor(3, rc({ brick: 1 }), rc({ wheat: 1 }))).toBeGreaterThan(ctx.gainFor(2, rc({ brick: 1 }), rc({ wheat: 1 })));
    expect(toOrange).toBeLessThan(toWhite);
    // Easy bots don't weigh their partner.
    const easy = new BotCtx(s, 1, 'easy', createBotMemory());
    expect(dealValue(easy, 3, rc({ wheat: 1 }), rc({ brick: 1 }))).toBeCloseTo(dealValue(easy, 2, rc({ wheat: 1 }), rc({ brick: 1 })));
  });
});

describe('bots use only what they could know', () => {
  /** Mid-game states from a bot game (no open trade), with each opponent's hand reshuffled across kinds. */
  function* samples(seed: number) {
    let s = createGame(FOUR.map((p) => ({ ...p, isBot: true })), { layout: 'random', seed }).state;
    const mem = s.players.map(() => createBotMemory());
    for (let step = 0; step < 3000 && s.phase !== 'gameOver'; step++) {
      const order = [s.currentPlayer, ...[0, 1, 2, 3].filter((p) => p !== s.currentPlayer)];
      for (const p of s.trade ? [...order.slice(1), order[0]] : order) {
        const a = botDecide(s, p, mem[p], 'hard');
        if (!a) continue;
        s = apply(s, p, a).state;
        break;
      }
      if (step % 9 === 0 && !s.trade && s.turn > 4) yield s;
    }
  }

  const reshuffle = (s: GameState, keep: number, k: number) =>
    patch(s, (x) => {
      for (const p of x.players) {
        if (p.id === keep) continue;
        const n = totalCards(p.hand);
        const h = rc({});
        for (let i = 0; i < n; i++) h[RESOURCES[(i * 7 + k * 3 + p.id) % 5]]++;
        p.hand = h;
      }
    });

  slow('decides the same whatever the hidden hands hold', () => {
    let compared = 0;
    for (const seed of [31, 32, 33]) {
      for (const s of samples(seed)) {
        const p = s.phase === 'discard' ? Number(Object.keys(s.pendingDiscards)[0]) : s.currentPlayer;
        const a = botDecide(s, p, createBotMemory(), 'hard');
        for (const k of [1, 2]) expect(botDecide(reshuffle(s, p, k), p, createBotMemory(), 'hard')).toEqual(a);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(60);
  }, timeout(60_000));

  it('picks Monopoly by what it has seen, not by the hands', () => {
    const s = known(
      patch(beginnerGame(), (x) => {
        toMain(x, 0);
        x.players[0].devCards.push({ type: 'monopoly', boughtTurn: 0 });
        setHand(x, 1, { wool: 3 });
        setHand(x, 2, { wool: 2 });
        setHand(x, 3, { brick: 1 });
      }),
    );
    expect(botDecide(s, 0, createBotMemory(), 'hard')).toEqual({ type: 'playMonopoly', resource: 'wool' });
    // The same hands made of ore instead, unseen: the tracker still says wool.
    const hidden = patch(s, (x) => {
      setHand(x, 1, { ore: 3 });
      setHand(x, 2, { ore: 2 });
    });
    expect(botDecide(hidden, 0, createBotMemory(), 'hard')).toEqual({ type: 'playMonopoly', resource: 'wool' });
  });

  slow('only offers to players who may hold what it asks for', () => {
    let offers = 0;
    for (const seed of [41, 42, 43]) {
      let s = createGame(FOUR.map((p) => ({ ...p, isBot: true })), { layout: 'random', seed }).state;
      const mem = s.players.map(() => createBotMemory());
      while (s.phase !== 'gameOver') {
        const order = [s.currentPlayer, ...[0, 1, 2, 3].filter((p) => p !== s.currentPlayer)];
        for (const p of s.trade ? [...order.slice(1), order[0]] : order) {
          const a = botDecide(s, p, mem[p], 'normal');
          if (!a) continue;
          if (a.type === 'offerTrade') {
            offers++;
            const to = a.to?.length ? a.to : [0, 1, 2, 3].filter((o) => o !== p);
            for (const o of to) {
              const e = handEstimate(s, p, o);
              const unknown = e.total - RESOURCES.reduce((n, r) => n + e.sure[r], 0);
              for (const r of RESOURCES) expect(e.sure[r] + unknown + 1e-9).toBeGreaterThanOrEqual(a.get[r]);
            }
          }
          s = apply(s, p, a).state;
          break;
        }
      }
    }
    expect(offers).toBeGreaterThan(10);
  }, timeout(60_000));

  it('waits for a person’s answer by what the table has seen, never by their hand', () => {
    // Blue offers a brick for an ore; the other two bots have declined, and Red (a person) hasn't answered.
    const offer = (red: Partial<CardCounts>, secretly: Partial<CardCounts> | null) => {
      let s = known(
        patch(beginnerGame(), (x) => {
          toMain(x, 1);
          x.players[0].isBot = false;
          setHand(x, 0, red);
          setHand(x, 1, { brick: 2 });
        }),
      );
      // (A hand changed after the tracker saw it: what a theft hides from the rest of the table.)
      if (secretly) s = patch(s, (x) => setHand(x, 0, secretly));
      s = apply(s, 1, { type: 'offerTrade', give: rc({ brick: 1 }), get: rc({ ore: 1 }) }).state;
      for (const p of [2, 3]) s = apply(s, p, { type: 'respondTrade', accept: false }).state;
      return botDecide(s, 1, createBotMemory({ waitForHumans: true }), 'normal');
    };
    // Seen to hold ore: it waits. Seen to hold none: it doesn't.
    expect(offer({ ore: 1, wheat: 1 }, null)).toBeNull();
    expect(offer({ wheat: 2 }, null)).not.toBeNull();
    // The ore seen has secretly gone: it still waits. Ore the table never saw arrive: it still doesn't.
    expect(offer({ ore: 1, wheat: 1 }, { wheat: 2 })).toBeNull();
    expect(offer({ wheat: 2 }, { ore: 1, wheat: 1 })).not.toBeNull();
  });
});

describe('bot planning', () => {
  it('values a settlement that cuts the Longest Route holder', () => {
    // Orange holds the tile with six roads along the coast; Blue's road reaches a corner in the middle.
    const base = createGame(FOUR, { layout: 'random', seed: 11 }).state;
    const coast = base.board.edges.filter((e) => e.coastal);
    const edges: number[] = [coast[0].id];
    const joins: number[] = [];
    let v = coast[0].b;
    while (edges.length < 8) {
      const next = base.board.vertices[v].edges.find((e) => base.board.edges[e].coastal && !edges.includes(e))!;
      joins.push(v);
      edges.push(next);
      const ed = base.board.edges[next];
      v = ed.a === v ? ed.b : ed.a;
    }
    const cut = joins.slice(1, 5).find((j) => base.board.vertices[j].edges.length === 3)!;
    const s = patch(base, (x) => {
      x.turn = 6;
      x.setupIndex = x.setupOrder.length;
      toMain(x, 1);
      for (let i = 0; i < 7; i++) x.routes[edges[i]] = road(3);
      x.players[3].roadsLeft -= 7;
      x.routes[x.board.vertices[cut].edges.find((e) => !edges.includes(e))!] = road(1);
      x.players[1].roadsLeft -= 1;
      for (const p of x.players) p.longestRoad = longestRoadFor(x, p.id);
      x.longestRoadHolder = 3;
    });
    const hard = new BotCtx(s, 1, 'hard', createBotMemory());
    expect(hard.routeBreak(cut)).toBeGreaterThan(0.5);
    const blind = new BotCtx(s, 1, 'hard', createBotMemory(), { ...PROFILES.hard, blockWeight: 0 });
    const value = (c: BotCtx) => c.options().find((o) => o.kind === 'settlement' && o.vertex === cut)!.value;
    expect(value(hard)).toBeGreaterThan(value(blind) + 0.5);
  });

  it('keeps an Invention card when the supply is empty', () => {
    const s = patch(beginnerGame(), (x) => {
      toMain(x, 0);
      x.players[0].devCards.push({ type: 'invention', boughtTurn: 0 });
      for (const r of RESOURCES) {
        x.players[1].hand[r] += x.bank[r];
        x.bank[r] = 0;
      }
    });
    for (const d of ['easy', 'normal', 'hard'] as BotDifficulty[]) {
      for (let k = 0; k < 10; k++) expect(botDecide({ ...s, seq: k }, 0, createBotMemory(), d)?.type).not.toBe('playInvention');
    }
  });

  slow('easy bots trade now and then', () => {
    let offers = 0;
    let trades = 0;
    for (const seed of [51, 52, 53, 54, 55, 56]) {
      let s = createGame(FOUR.map((p) => ({ ...p, isBot: true })), { layout: 'random', seed }).state;
      const mem = s.players.map(() => createBotMemory());
      while (s.phase !== 'gameOver') {
        const order = [s.currentPlayer, ...[0, 1, 2, 3].filter((p) => p !== s.currentPlayer)];
        for (const p of s.trade ? [...order.slice(1), order[0]] : order) {
          const a = botDecide(s, p, mem[p], 'easy');
          if (!a) continue;
          if (a.type === 'offerTrade') offers++;
          const r = apply(s, p, a);
          if (r.events.some((e) => e.type === 'tradeExecuted')) trades++;
          s = r.state;
          break;
        }
      }
    }
    expect(offers).toBeGreaterThan(5);
    expect(trades).toBeGreaterThan(0);
    // But far less than the others: a few offers a game.
    expect(offers / 6).toBeLessThan(15);
  }, timeout(60_000));
});

describe('the win this turn', () => {
  // Red has a road of three along an empty stretch of coast, the cards for two more, and is two
  // points short: two roads take Longest Route, and the game. One road alone gains nothing.
  function brink() {
    const base = beginnerGame();
    const free = (v: number) => !base.buildings[v] && base.board.vertices[v].neighbors.every((u) => !base.buildings[u]);
    const coast = base.board.edges.filter((e) => e.coastal);
    for (const start of coast) {
      const edges = [start.id];
      let v = start.b;
      if (!free(start.a) || !free(v)) continue;
      while (edges.length < 5) {
        const next = base.board.vertices[v].edges.find((e) => base.board.edges[e].coastal && !edges.includes(e) && base.routes[e] === null);
        if (next === undefined) break;
        const ed = base.board.edges[next];
        v = ed.a === v ? ed.b : ed.a;
        if (!free(v)) break;
        edges.push(next);
      }
      if (edges.length < 5) continue;
      return patch(base, (x) => {
        x.turn = 9;
        toMain(x, 0);
        for (const e of edges.slice(0, 3)) x.routes[e] = road(0);
        x.players[0].roadsLeft -= 3;
        for (const p of x.players) p.longestRoad = longestRoadFor(x, p.id);
        setHand(x, 0, { brick: 2, wood: 2 });
        x.options = { ...x.options, victoryPoints: totalVictoryPoints(x, 0) + 2 };
      });
    }
    throw new Error('no free stretch of coast');
  }

  it('finds a line of two roads that takes Longest Route and wins', () => {
    let s = brink();
    const mem = createBotMemory();
    for (let i = 0; i < 4 && s.phase !== 'gameOver'; i++) {
      const a = botDecide(s, 0, mem, 'hard')!;
      expect(a.type).toBe('buildRoad');
      s = apply(s, 0, a).state;
    }
    expect(s.winner).toBe(0);
  });

  it('looks only at what it may know: the others’ hands change nothing', () => {
    const s = brink();
    const other = patch(s, (x) => setHand(x, 1, { ore: 3, wheat: 2 }));
    expect(botDecide(other, 0, createBotMemory(), 'hard')).toEqual(botDecide(s, 0, createBotMemory(), 'hard'));
  });
});
