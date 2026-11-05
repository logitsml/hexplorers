// The table's own logic on the client: whom the game waits on and when a hail is due, Looking
// for / Spare as cards are tapped, who is typing (and the word each way), the offer made again at
// your next turn, the results' awards and share line, and the room client's part: a hail said
// here, a bot's deal passed to the chat, typing that lapses, reactions that float; and accepting an
// answer to your offer on the room's word that the partner can pay, which this view can't know.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, emptyCards, mustApply, type GameState } from '../../src/engine';
import { viewHash, wireView } from '../../src/engine/wire';
import { RemoteHost } from '../../src/online/remoteHost';
import { beginnerGame, grant, rc, toMain } from '../helpers';
import { stillClock } from './fakeRoom';
import { HAIL_AFTER_MS, type Results, type SeatInfo, type ServerMsg } from '../../src/net/protocol';
import { canHail, forgetOwed, offerAgain, owedKey, owedSince, shareText, toggleWant, TypingSignal, typingText, wantsText, awardText, QUICK_GROUPS, type KeptOffer } from '../../src/online/table';
import { QUICK_TALK } from '../../src/net/protocol';
import { noticeText } from '../../src/online/words';
import { RoomClient, type TableLine } from '../../src/online/client';
import { REACTION_MS, useOnline } from '../../src/online/store';

const game = (): GameState =>
  createGame(
    [
      { name: 'Ana', color: 'red', isBot: false },
      { name: 'Ben', color: 'blue', isBot: false },
      { name: 'Bramble', color: 'white', isBot: true },
    ],
    { seed: 3 },
  ).state;

const seats: SeatInfo[] = [
  { seat: 0, kind: 'human', name: 'Ana', color: 'red', online: true },
  { seat: 1, kind: 'human', name: 'Ben', color: 'blue', online: true },
  { seat: 2, kind: 'bot', name: 'Bramble', color: 'white' },
];

describe('whom the table waits on', () => {
  beforeEach(forgetOwed);

  it('keys what each seat owes as the room does, and remembers when it was first seen', () => {
    const s = game();
    const p = s.currentPlayer;
    expect(owedKey(s, p)).toBe(`t${s.turn}:${p}:${s.setupIndex}`);
    expect(owedKey(s, (p + 1) % 3)).toBeNull();
    expect(owedSince(s, p, 1000)).toBe(1000);
    // (The same obligation keeps its first time.)
    expect(owedSince(s, p, 5000)).toBe(1000);
    // An offer out: each seat it went to owes an answer until it gives one.
    const offer: GameState = { ...s, phase: 'main', trade: { id: 7, proposer: p, give: { ...emptyCards(), wool: 1 }, get: { ...emptyCards(), ore: 1 }, to: [(p + 1) % 3], responses: {}, counters: {} } };
    expect(owedKey(offer, (p + 1) % 3)).toBe('x7');
    expect(owedKey(offer, (p + 2) % 3)).toBeNull();
    expect(owedKey({ ...offer, trade: { ...offer.trade!, responses: { [(p + 1) % 3]: 'rejected' } } }, (p + 1) % 3)).toBeNull();
    expect(owedKey({ ...s, phase: 'gameOver' }, p)).toBeNull();
  });

  it('lets you hail a person kept waiting, once they have been, and not again straight away', () => {
    const s: GameState = { ...game(), currentPlayer: 1 };
    const base = { state: s, seat: 1, me: 0, seats, since: 0 };
    expect(canHail({ ...base, now: HAIL_AFTER_MS - 1 })).toBe(false);
    expect(canHail({ ...base, now: HAIL_AFTER_MS })).toBe(true);
    expect(canHail({ ...base, now: HAIL_AFTER_MS, lastHail: HAIL_AFTER_MS - 1000 })).toBe(false);
    // Not yourself, not the crew, not someone away, not from the quay.
    expect(canHail({ ...base, me: 1, now: HAIL_AFTER_MS })).toBe(false);
    expect(canHail({ ...base, state: { ...s, currentPlayer: 2 }, seat: 2, now: HAIL_AFTER_MS })).toBe(false);
    expect(canHail({ ...base, seats: seats.map((x) => (x.seat === 1 ? { ...x, away: true } : x)), now: HAIL_AFTER_MS })).toBe(false);
    expect(canHail({ ...base, me: null, now: HAIL_AFTER_MS })).toBe(false);
    // Nor someone the game isn't waiting on.
    expect(canHail({ ...base, seat: 0, me: 1, now: HAIL_AFTER_MS })).toBe(false);
  });
});

describe('Looking for and Spare', () => {
  it('moves a card from one list to the other, keeps the game’s order and says it in words', () => {
    let w = toggleWant(undefined, 'ore', 'looking');
    w = toggleWant(w, 'brick', 'looking');
    expect(w).toEqual({ looking: ['brick', 'ore'], spare: [] });
    w = toggleWant(w, 'ore', 'spare');
    expect(w).toEqual({ looking: ['brick'], spare: ['ore'] });
    w = toggleWant(w, 'brick', 'looking');
    expect(w).toEqual({ looking: [], spare: ['ore'] });
    expect(wantsText({ looking: ['wool', 'ore'], spare: ['brick'] })).toBe('Looking for wool, ore · Spare brick');
    expect(wantsText(undefined)).toBe('');
  });
});

describe('table talk', () => {
  it('has every quick word once in its groups, and says who is typing', () => {
    const all = QUICK_GROUPS.flatMap((g) => g.words);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...QUICK_TALK].sort());
    expect(typingText({ 1: true }, seats, 0)).toBe('Ben is typing…');
    expect(typingText({ 0: true, 1: true }, seats, 2)).toBe('Ana and Ben are typing…');
    expect(typingText({ 0: true }, seats, 0)).toBe('');
  });

  it('says typing once each way: on with the first key, off once quiet, sent or cleared', () => {
    let t = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let id = 0;
    const clock = {
      set: (fn: () => void, ms: number) => (timers.push({ at: t + ms, fn, id: ++id }), id as unknown as ReturnType<typeof setTimeout>),
      clear: (x: ReturnType<typeof setTimeout>) => void timers.splice(timers.findIndex((y) => y.id === (x as unknown as number)) >>> 0, 1),
    };
    const run = (ms: number) => {
      t += ms;
      for (const x of timers.filter((y) => y.at <= t)) (timers.splice(timers.indexOf(x), 1), x.fn());
    };
    const said: boolean[] = [];
    const sig = new TypingSignal((on) => said.push(on), 4000, clock);
    sig.input('h');
    sig.input('he');
    sig.input('hel');
    expect(said).toEqual([true]);
    run(3999);
    expect(said).toEqual([true]);
    run(1);
    expect(said).toEqual([true, false]);
    sig.input('hello');
    sig.input('');
    expect(said).toEqual([true, false, true, false]);
    sig.input('again');
    sig.stop();
    sig.stop();
    expect(said).toEqual([true, false, true, false, true, false]);
  });

  it('says a hail to the one hailed as who sent it', () => {
    expect(noticeText('nudged', 'Ben')).toBe('Ben hailed you: the table is waiting on you');
    expect(noticeText('left', 'Ben', false, { playing: true })).toBe('Ben left: the crew sails for them');
  });
});

describe('the offer made again', () => {
  const kept: KeptOffer = { give: { ...emptyCards(), wool: 1 }, get: { ...emptyCards(), ore: 1 }, to: [1], turn: 3 };
  const mine = (over: Partial<GameState> = {}): GameState => {
    const s = game();
    const players = s.players.map((p) => (p.id === 0 ? { ...p, hand: { ...emptyCards(), wool: 2 } } : p));
    return { ...s, phase: 'main', currentPlayer: 0, turn: 6, trade: null, pending: [], players, ...over };
  };

  it('comes back on your next turn while you still hold what it gives', () => {
    expect(offerAgain(kept, mine(), 0)).toBe(kept);
    expect(offerAgain(kept, mine({ turn: 3 }), 0)).toBeNull();
    expect(offerAgain(kept, mine({ currentPlayer: 1 }), 0)).toBeNull();
    expect(offerAgain(kept, mine({ phase: 'roll' }), 0)).toBeNull();
    const broke = mine();
    broke.players[0] = { ...broke.players[0], hand: emptyCards() };
    expect(offerAgain(kept, broke, 0)).toBeNull();
    expect(offerAgain(null, mine(), 0)).toBeNull();
    expect(offerAgain(kept, mine(), null)).toBeNull();
  });
});

describe('the results', () => {
  const r: Results = {
    winner: 1,
    standings: [
      { seat: 1, points: 10 },
      { seat: 0, points: 8 },
      { seat: 2, points: 5, conceded: true },
    ],
    turns: 64,
    durationMs: 1,
    awards: [{ seat: 1, award: 'longestRoute', value: 7 }],
  };

  it('puts the game in a line to share, and each award in words', () => {
    expect(shareText(r, seats, 0)).toBe('Ben won in Hexplorers · Ben 10 · Me 8 · Bramble 5 (conceded) · 64 turns');
    expect(shareText({ ...r, winner: 0 }, seats, 0).startsWith('I won')).toBe(true);
    expect(awardText('longestRoute', 7)).toEqual({ label: 'Longest Route: 7 roads', short: 'Longest Route' });
    expect(awardText('mostTrades', 1).label).toBe('Most trades: 1');
  });
});

describe('the room client at the table', () => {
  let client: RoomClient;
  let lines: TableLine[];
  let sent: unknown[];
  const deliver = (m: ServerMsg) => (client as unknown as { onMessage(m: ServerMsg): void }).onMessage(m);

  beforeEach(() => {
    vi.useFakeTimers();
    lines = [];
    sent = [];
    client = new RoomClient('BCDFGH', {}, { onGame: () => {}, onChat: (l) => lines.push(l) });
    client.send = (m) => (sent.push(m), true);
    useOnline.getState().set({ you: { seat: 0, user: 'u0', host: false, watch: false }, room: { code: 'BCDFGH', phase: 'playing', settings: { mode: 'live' } as never, seats, host: 'u0', spectators: 0, createdAt: 0 } });
  });
  afterEach(() => {
    client.leave();
    vi.useRealTimers();
  });

  it('says your hail here, and hears one as who sent it', () => {
    client.nudge(1);
    expect(sent).toEqual([{ t: 'nudge', seat: 1 }]);
    expect(useOnline.getState().notices.at(-1)).toMatchObject({ kind: 'nudged', local: true, text: 'You hailed Ben' });
    expect(useOnline.getState().hailedAt).not.toBeNull();
    deliver({ t: 'notice', kind: 'nudged', seat: 1 });
    expect(useOnline.getState().notices.at(-1)).toMatchObject({ kind: 'nudged', text: 'Ben hailed you: the table is waiting on you' });
  });

  it('passes a bot’s deal on with its line, and lets typing lapse', () => {
    deliver({ t: 'typing', seat: 1, on: true });
    expect(useOnline.getState().typing[1]).toBe(true);
    vi.advanceTimersByTime(9000);
    expect(useOnline.getState().typing[1]).toBe(false);
    deliver({ t: 'typing', seat: 1, on: true });
    deliver({ t: 'chat', line: { id: 1, at: 0, from: 1, quick: 'hello' } });
    expect(useOnline.getState().typing[1]).toBe(false);
    const give = { ...emptyCards(), wool: 1 };
    const get = { ...emptyCards(), ore: 1 };
    deliver({ t: 'chat', line: { id: 2, at: 0, from: 2, text: 'Wool for ore?', bot: true, to: 0, offer: { give, get } } });
    expect(lines.at(-1)).toEqual({ player: 2, text: 'Wool for ore?', offer: { to: 2, give, get } });
    expect(lines[0]).toEqual({ player: 1, text: 'Hello!' });
  });

  it('floats each reaction a moment, a few at most', () => {
    for (let i = 0; i < 9; i++) deliver({ t: 'react', from: 1, r: 'wave' });
    expect(useOnline.getState().reactions.length).toBe(6);
    vi.advanceTimersByTime(REACTION_MS);
    expect(useOnline.getState().reactions.length).toBe(0);
  });
});

describe('trading with a person', () => {
  it('accepts an answer the room says the partner can pay for, though this view only guesses at their hand', () => {
    let s = beginnerGame();
    toMain(s, 0);
    grant(s, 0, { wheat: 2 });
    // (Given out of sight: seat 0's view can't know seat 1 holds brick.)
    grant(s, 1, { brick: 2 });
    s = mustApply(s, 0, { type: 'offerTrade', give: rc({ wheat: 1 }), get: rc({ brick: 1 }), to: [1] }).state;
    s = mustApply(s, 1, { type: 'respondTrade', accept: true, offer: s.trade!.id }).state;
    const host = (state: GameState) => {
      const sent: unknown[] = [];
      const view = wireView(state, 0);
      const h = new RemoteHost({ seat: 0, snap: { t: 'snap', seq: state.seq, view, hash: viewHash(view) }, seats: [], send: (m) => (sent.push(m), true), resync: () => {}, clock: stillClock() });
      h.presented();
      return { h, sent };
    };
    const ready = host(s);
    expect(ready.h.newest.trade?.readiness?.accepted).toEqual([1]);
    expect(ready.h.submit(0, { type: 'acceptTrade', partner: 1 })).toEqual({ ok: true });
    expect(ready.sent.at(-1)).toMatchObject({ t: 'act', a: { type: 'acceptTrade', partner: 1, offer: s.trade!.id } });
    // The room saying they can't pay any more: refused here as before.
    const gone: GameState = { ...s, trade: { ...s.trade!, readiness: { accepted: [], counters: [] } } };
    const { h: refused } = host(gone);
    expect(refused.submit(0, { type: 'acceptTrade', partner: 1 }).ok).toBe(false);
  });
});
