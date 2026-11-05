// A seat's view must offer its own choices without requiring another seat's hidden hand. These
// scenes cover volunteered trade commitments and the private decisions modules leave owed.

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, legalActions, mustApply, redactState, seedFrom, type GameState } from '../src/engine';
import { actionKey, botDecide, createBotMemory } from '../src/engine/ai';
import { ALL_HANDS, mixOf, type Expansion } from '../src/engine/presets';
import { game, giveVenture, main } from './modules/guilds-helpers';
import { beginnerGame, grant, rc, toMain } from './helpers';
import { Ctx } from '../src/engine/ctx';
import { doSteal } from '../src/engine/reducer';
import { DISCARD_ENUMERATION_LIMIT, discardOptions } from '../src/engine/actions';
import { setups } from './sim-harness';
import { slow, timeout } from './tier';

const choices = (s: GameState, player: number) => legalActions(s, player).map(actionKey).sort();
const parity = (s: GameState) => {
  for (const p of s.players) {
    expect(choices(redactState(s, p.id), p.id), `Seed ${s.options.seed}, seq ${s.seq}, phase ${s.phase}, seat ${p.id}.`).toEqual(choices(s, p.id));
  }
};

describe('module decision redaction', () => {
  it('leaves auction and fish-swap decisions alone, for participants, other seats and spectators', () => {
    const s = game(['guilds', 'caravans', 'fisheries']);
    s.pending = [
      { kind: 'caravans/bid', players: [0] },
      { kind: 'caravans/place', players: [1] },
      { kind: 'fisheries/swap', players: [2] },
    ];
    for (const viewer of [0, 1, 2, 3, null]) {
      const view = redactState(s, viewer);
      expect(view.pending).toEqual(s.pending);
      expect(view.pending).not.toBe(s.pending);
    }
  });

  it('hides only the Guilds’ own private decisions from other seats and spectators', () => {
    const s = game(['guilds', 'caravans']);
    s.pending = [
      { kind: 'caravans/bid', players: [0] },
      { kind: 'guilds/spy', players: [1], data: { kind: 'guilds/spy', target: 2, seen: ['trader'] } },
      { kind: 'guilds/tribute', players: [1], data: { kind: 'guilds/tribute', target: 2, left: 1, seen: rc({ cloth: 1 }) } },
    ];
    expect(redactState(s, 1).pending).toEqual(s.pending);
    for (const viewer of [0, 2, 3, null]) {
      const view = redactState(s, viewer);
      expect(view.pending[0]).toEqual(s.pending[0]);
      expect(view.pending[1].data).toMatchObject({ seen: ['hidden'] });
      expect(view.pending[2].data).toMatchObject({ seen: rc({}) });
    }
    expect(s.pending[1].data).toMatchObject({ seen: ['trader'] });
    expect(s.pending[2].data).toMatchObject({ seen: rc({ cloth: 1 }) });
  });

  it('offers Barter and each recorded offer equally in a seat’s view', () => {
    let s = game(['guilds']);
    main(s, 0);
    giveVenture(s, 0, 'barter');
    grant(s, 0, { wool: 2 });
    grant(s, 1, { cloth: 1 });
    grant(s, 3, { paper: 1 });
    const play = { type: 'guilds/play', card: 'barter' } as const;
    expect(legalActions(s, 0)).toContainEqual(play);
    parity(s);
    s = mustApply(s, 0, play).state;
    parity(s);
    expect(legalActions(redactState(s, 0), 0)).toContainEqual({ type: 'guilds/offer', resource: 'wool' });
    s = mustApply(s, 0, { type: 'guilds/offer', resource: 'wool' }).state;
    parity(s);
    s = mustApply(s, 1, { type: 'guilds/give', card: 'cloth' }).state;
    parity(s);
    s = mustApply(s, 0, { type: 'guilds/offer', resource: 'wool' }).state;
    s = mustApply(s, 3, { type: 'guilds/give', card: 'paper' }).state;
    parity(s);
    expect(s.pending).toEqual([]);
  });

  it('offers no Barter when the only commodities are in our own hand', () => {
    const s = game(['guilds']);
    main(s, 0);
    giveVenture(s, 0, 'barter');
    grant(s, 0, { cloth: 1 });
    expect(legalActions(s, 0)).not.toContainEqual({ type: 'guilds/play', card: 'barter' });
    parity(s);
    expect(applyAction(s, 0, { type: 'guilds/play', card: 'barter' }).ok).toBe(false);
  });
});

describe('trade commitment redaction', () => {
  function offer() {
    let s = beginnerGame();
    toMain(s, 0);
    // A lone card makes the subsequent theft deterministic without exposing its kind in the view.
    for (const p of s.players) {
      for (const k of Object.keys(p.hand) as (keyof typeof p.hand)[]) s.bank[k] += p.hand[k];
      p.hand = rc({});
    }
    grant(s, 0, { wheat: 1 });
    grant(s, 1, { brick: 1 });
    s = mustApply(s, 0, { type: 'offerTrade', give: rc({ wheat: 1 }), get: rc({ brick: 1 }) }).state;
    return s;
  }

  it('keeps accepted offers and counters available without revealing the committed hand', () => {
    let s = offer();
    expect(redactState(s, 0).trade!.readiness).toEqual({ accepted: [], counters: [] });
    s = mustApply(s, 1, { type: 'respondTrade', accept: true }).state;
    parity(s);
    const view = redactState(s, 0);
    expect(view.players[1].hand).toEqual(rc({ ore: 1 }));
    expect(view.trade!.readiness).toEqual({ accepted: [1], counters: [] });
    expect(legalActions(view, 0)).toContainEqual({ type: 'acceptTrade', partner: 1 });
    expect(s.trade).not.toHaveProperty('readiness');
    // The view is detached, including its commitment lists when it is redacted again.
    redactState(view, 0).trade!.readiness!.accepted.length = 0;
    expect(view.trade!.readiness!.accepted).toEqual([1]);
    s = mustApply(s, 1, { type: 'counterTrade', give: rc({ brick: 1 }), get: rc({ wheat: 1 }) }).state;
    parity(s);
    expect(redactState(s, 0).trade!.readiness).toEqual({ accepted: [], counters: [1] });
    expect(legalActions(redactState(s, 0), 0)).toContainEqual({ type: 'acceptTrade', partner: 1, counter: true });
    expect(mustApply(s, 0, { type: 'acceptTrade', partner: 1, counter: true }).state.trade).toBeNull();
  });

  it('revalidates accepted offers and counters after a secret theft changes a hand', () => {
    for (const counter of [false, true]) {
      let s = offer();
      s = mustApply(s, 1, counter
        ? { type: 'counterTrade', give: rc({ brick: 1 }), get: rc({ wheat: 1 }) }
        : { type: 'respondTrade', accept: true }).state;
      const ctx = new Ctx(s);
      doSteal(ctx, 2, 1);
      parity(s);
      const view = redactState(s, 0);
      expect(view.trade!.readiness).toEqual({ accepted: [], counters: [] });
      const action = counter ? { type: 'acceptTrade' as const, partner: 1, counter: true } : { type: 'acceptTrade' as const, partner: 1 };
      expect(legalActions(view, 0)).not.toContainEqual(action);
      // A forged or stale view hint never authorises a transfer the real hands cannot cover.
      s.trade!.readiness = { accepted: [1], counters: [1] };
      expect(applyAction(s, 0, action).ok).toBe(false);
    }
  });

  it('checks the proposer’s ability to pay and both oil holds before publishing readiness', () => {
    let s = game(['oil']);
    main(s, 0);
    for (const p of s.players) {
      s.bank.oil += p.hand.oil;
      p.hand.oil = 0;
    }
    grant(s, 0, { oil: 2 });
    grant(s, 1, { oil: 3, brick: 1 });
    s = mustApply(s, 0, { type: 'offerTrade', give: rc({ oil: 2 }), get: rc({ brick: 1 }) }).state;
    s = mustApply(s, 1, { type: 'respondTrade', accept: true }).state;
    parity(s);
    expect(redactState(s, 0).trade!.readiness!.accepted).toEqual([]);
    expect(applyAction(s, 0, { type: 'acceptTrade', partner: 1 }).ok).toBe(false);
    s.players[1].hand.oil--;
    s.bank.oil++;
    parity(s);
    expect(redactState(s, 0).trade!.readiness!.accepted).toEqual([1]);
    s.players[0].hand.oil--;
    s.bank.oil++;
    parity(s);
    expect(redactState(s, 0).trade!.readiness!.accepted).toEqual([]);
  });
});

describe('discard redaction', () => {
  it('samples from public data in new games, retaining the recorded sampler for earlier rules', () => {
    for (const rules of [1, 2, 3]) {
      const s = createGame(setups(3), { seed: 113, rules }).state;
      s.phase = 'discard';
      s.currentPlayer = 0;
      s.pendingDiscards = { 0: 10 };
      s.seq = 71;
      grant(s, 0, { brick: 4, wood: 4, wool: 4, wheat: 4, ore: 4 });
      const before = s.rngState;
      const full = legalActions(s, 0);
      expect(full).toHaveLength(DISCARD_ENUMERATION_LIMIT);
      if (rules >= 3) {
        parity(s);
        expect(legalActions({ ...s, rngState: 12345 }, 0)).toEqual(full);
      } else {
        const seed = seedFrom(s.seq * 7 + s.rngState);
        expect(full).toEqual(discardOptions(s.players[0].hand, 10, seed).map((resources) => ({ type: 'discard', resources })));
      }
      expect(s.rngState).toBe(before);
      for (const action of full) expect(applyAction(s, 0, action).ok).toBe(true);
    }
  });
});

slow('keeps every seat’s legal choices equal throughout bot games in several mixes', () => {
  const cases: { expansions: Expansion[]; seed: number; players: 3 | 4; seaMap?: string }[] = [
    { expansions: [], seed: 113, players: 3 },
    { expansions: ['guilds'], seed: 113, players: 4 },
    { expansions: ALL_HANDS, seed: 113, players: 4 },
    { expansions: ['sea', 'guilds', 'fisheries', 'oil', 'almanac'], seed: 271, players: 3, seaMap: 'fogBank' },
  ];
  let actions = 0;
  let sawTrade = false;
  let sawAuction = false;
  let sawBarter = false;
  for (const c of cases) {
    const mix = mixOf(c.expansions, c.seaMap);
    let s = createGame(setups(c.players), {
      seed: c.seed, layout: 'random', modules: mix.modules, map: mix.map,
      knobs: mix.knobs, victoryPoints: mix.target,
    }).state;
    const memories = s.players.map(() => createBotMemory());
    for (let step = 0; step < 4000 && s.phase !== 'gameOver'; step++) {
      // Every viewer is checked against their own authoritative choices, including off-turn
      // responses. Spectators must also redact safely while another module owns the decision.
      parity(s);
      redactState(s, null);
      sawTrade ||= !!s.trade;
      sawAuction ||= !!s.ext.caravans?.auction;
      sawBarter ||= s.pending.some((p) => p.kind === 'guilds/barter');
      let acted = false;
      for (let i = 0; i < c.players; i++) {
        const p = (s.seq + i) % c.players;
        const action = botDecide(s, p, memories[p], 'hard');
        if (!action) continue;
        s = mustApply(s, p, action).state;
        actions++;
        acted = true;
        break;
      }
      if (!acted) throw new Error(`No bot acted: seed ${c.seed}, seq ${s.seq}, phase ${s.phase}.`);
    }
    expect(s.phase).toBe('gameOver');
    expect(memories.map((m) => m.fallbacks)).toEqual(s.players.map(() => 0));
    parity(s);
  }
  expect(actions).toBeGreaterThan(1000);
  expect(sawTrade).toBe(true);
  expect(sawAuction).toBe(true);
  expect(sawBarter).toBe(true);
}, timeout(10_000));
