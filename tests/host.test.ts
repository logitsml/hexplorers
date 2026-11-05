import { describe, expect, it } from 'vitest';
import { RULES_VERSION, hasResources, legalActions, type Action, type PlayerId } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { LocalHost, OFFER_DEADLINE_MS, personalityOf, type HostClock, type SeatConfig } from '../src/game/host';
import { slow, timeout } from './tier';

const crew: SeatConfig[] = [
  { name: 'You', color: 'red', isBot: false },
  { name: 'Captain Bramble', color: 'blue', isBot: true, difficulty: 'normal' },
  { name: 'Wren Ashdown', color: 'white', isBot: true, difficulty: 'normal' },
  { name: 'Tobias Forge', color: 'orange', isBot: true, difficulty: 'normal' },
];

/** A clock whose timers fire only when told to. */
function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const clock: HostClock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.set(++id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (x) => void timers.delete(x as number),
  };
  const advance = (ms: number) => {
    t += ms;
    for (const [k, v] of [...timers]) {
      if (v.at <= t) {
        timers.delete(k);
        v.fn();
      }
    }
  };
  return { clock, timers, advance };
}

/** The person at seat 0 plays like a hard bot, except that they never answer offers unless `answer`. */
function personMove(host: LocalHost, mem = createBotMemory({ waitForHumans: true }), answer = true): Action | null {
  const s = host.state;
  if (!answer && s.trade && s.trade.proposer !== 0) return null;
  return botDecide(s, 0, mem, 'hard');
}

describe('host', () => {
  it('takes moves from people only: not for a bot seat, nor during a replay', () => {
    const host = new LocalHost(crew, { seed: 5, layout: 'beginner' });
    const bot = host.state.currentPlayer === 0 ? 1 : host.state.currentPlayer;
    expect(host.submit(bot, { type: 'rollDice' })).toEqual({ ok: false, error: 'That seat is played by the computer.' });
    const replay = new LocalHost(crew.map((s) => ({ ...s, isBot: false })), { seed: 5, layout: 'beginner' });
    replay.setScript([{ actor: replay.state.currentPlayer, action: { type: 'rollDice' } }]);
    expect(replay.submit(replay.state.currentPlayer, { type: 'rollDice' }).ok).toBe(false);
    // The script itself plays through submitBot, one recorded move at a time, and pauses.
    replay.paused = true;
    expect(replay.nextBotAction()).toBeNull();
    replay.paused = false;
    const next = replay.nextBotAction()!;
    expect(next.action).toEqual({ type: 'rollDice' });
    expect(replay.submitBot(next).ok).toBe(true);
    expect(replay.scriptProgress).toEqual({ at: 1, total: 1 });
    expect(replay.nextBotAction()).toBeNull();
  });

  it('a game with a person in it replays to the same state', () => {
    const opts = { seed: 77, layout: 'random' as const };
    const a = new LocalHost(crew, opts);
    const mem = createBotMemory({ waitForHumans: true });
    let personMoves = 0;
    for (let i = 0; i < 900 && a.state.phase !== 'gameOver'; i++) {
      const d = a.nextBotAction();
      if (d) {
        expect(a.submitBot(d).ok).toBe(true);
        continue;
      }
      const m = personMove(a, mem);
      expect(m).not.toBeNull();
      expect(a.submit(0, m!).ok).toBe(true);
      personMoves++;
    }
    expect(personMoves).toBeGreaterThan(20);
    const b = new LocalHost(crew, opts);
    b.replay(JSON.parse(JSON.stringify(a.history)));
    expect(b.state).toEqual(a.state);
  });

  it('declines a bot offer for a person who has not answered in time', () => {
    let found = false;
    for (let seed = 1; seed < 40 && !found; seed++) {
      const { clock, timers, advance } = fakeClock();
      const host = new LocalHost(crew, { seed, layout: 'random' }, clock);
      const mem = createBotMemory({ waitForHumans: true });
      for (let i = 0; i < 1500 && host.state.phase !== 'gameOver'; i++) {
        const t = host.state.trade;
        if (t && t.proposer !== 0 && (t.to.length === 0 || t.to.includes(0)) && hasResources(host.state.players[0].hand, t.get) && t.responses[0] === undefined) {
          // The proposer waits for you…
          expect(host.nextBotAction()?.player ?? -1).not.toBe(t.proposer);
          expect(timers.size).toBe(1);
          advance(OFFER_DEADLINE_MS - 1);
          expect(host.state.trade?.responses[0]).toBeUndefined();
          advance(1);
          expect(host.state.trade?.responses[0]).toBe('rejected');
          expect(host.history.at(-1)).toEqual({ actor: 0, action: { type: 'respondTrade', accept: false } });
          expect(timers.size).toBe(0);
          found = true;
          break;
        }
        const d = host.nextBotAction();
        if (d) {
          host.submitBot(d);
          continue;
        }
        const m = personMove(host, mem, false);
        if (!m) break;
        host.submit(0, m);
      }
      host.dispose();
    }
    expect(found).toBe(true);
  });

  it('holds the offer clock while held and waits forever with no limit', () => {
    let found = false;
    for (let seed = 1; seed < 40 && !found; seed++) {
      const { clock, timers, advance } = fakeClock();
      const host = new LocalHost(crew, { seed, layout: 'random' }, clock);
      const mem = createBotMemory({ waitForHumans: true });
      for (let i = 0; i < 1500 && host.state.phase !== 'gameOver'; i++) {
        const t = host.state.trade;
        if (t && t.proposer !== 0 && (t.to.length === 0 || t.to.includes(0)) && hasResources(host.state.players[0].hand, t.get) && t.responses[0] === undefined) {
          advance(1000);
          host.holdOffers(true);
          expect(timers.size).toBe(0);
          advance(OFFER_DEADLINE_MS * 3);
          expect(host.state.trade?.responses[0]).toBeUndefined();
          host.holdOffers(false);
          advance(OFFER_DEADLINE_MS - 1001);
          expect(host.state.trade?.responses[0]).toBeUndefined();
          // No limit: the open offer's clock is dropped, and nothing declines it.
          host.setOfferWait(0);
          expect(timers.size).toBe(0);
          advance(OFFER_DEADLINE_MS * 3);
          expect(host.state.trade?.responses[0]).toBeUndefined();
          // A limit again: it starts over.
          host.setOfferWait(5000);
          advance(5000);
          expect(host.state.trade?.responses[0]).toBe('rejected');
          found = true;
          break;
        }
        const d = host.nextBotAction();
        if (d) {
          host.submitBot(d);
          continue;
        }
        const m = personMove(host, mem, false);
        if (!m) break;
        host.submit(0, m);
      }
      host.dispose();
    }
    expect(found).toBe(true);
  });

  it('stops its timers when disposed', () => {
    const { clock, timers } = fakeClock();
    const host = new LocalHost(crew, { seed: 3 }, clock);
    host.dispose();
    expect(timers.size).toBe(0);
    expect(host.submit(0, { type: 'rollDice' }).ok).toBe(false);
  });

  it('replays a game under the rules it was recorded with, and only those', () => {
    const opts = { seed: 12, layout: 'beginner' as const, rules: 1 };
    const bots = crew.map((s) => ({ ...s, isBot: true }));
    const old = new LocalHost(bots, opts);
    for (let i = 0; i < 300; i++) {
      const d = old.nextBotAction();
      if (!d) break;
      old.submitBot(d);
    }
    const resumed = new LocalHost(bots, opts);
    resumed.replay(JSON.parse(JSON.stringify(old.history)));
    expect(resumed.state).toEqual(old.state);
    // Under other rules the list doesn't play: nothing guesses.
    expect(() => new LocalHost(bots, { ...opts, rules: RULES_VERSION }).replay(old.history)).toThrow(/replay failed/);
  });

  it('replays an expansion game under the module versions it was stamped with', () => {
    const opts = { seed: 12, layout: 'beginner' as const, modules: ['rivers' as const], moduleRules: { rivers: 1 } };
    const bots = crew.map((s) => ({ ...s, isBot: true }));
    const played = new LocalHost(bots, opts);
    for (let i = 0; i < 300; i++) {
      const d = played.nextBotAction();
      if (!d) break;
      played.submitBot(d);
    }
    expect(played.history.length).toBeGreaterThan(20);
    expect(played.state.options.moduleRules).toEqual({ rivers: 1 });
    // The resumed host is given the same options (a save's stamps), and plays the list through unchanged.
    const resumed = new LocalHost(bots, opts);
    resumed.replay(JSON.parse(JSON.stringify(played.history)));
    expect(resumed.state.options).toEqual(played.state.options);
    expect(resumed.state).toEqual(played.state);
  });

  it('gives each of the crew the character that goes with their voice', () => {
    expect(crew.slice(1).map((s) => personalityOf(s.name))).toEqual(['trader', 'settler', 'smith']);
    expect(personalityOf('Elder Quill')).toBe('scholar');
    expect(personalityOf('Someone else')).toBeUndefined();
    const host = new LocalHost(crew, { seed: 3 });
    expect(host.profileOf(1).setupAnyPort).toBeGreaterThan(host.profileOf(3).setupAnyPort);
  });

  slow('every bot decision it serves is legal', () => {
    const host = new LocalHost(crew.map((s) => ({ ...s, isBot: true, difficulty: 'hard' as const })), { seed: 8, friendlyRobber: true, eventDeck: true, victoryPoints: 12 });
    let n = 0;
    while (host.state.phase !== 'gameOver' && n < 5000) {
      const d = host.nextBotAction()!;
      expect(d).not.toBeNull();
      const p: PlayerId = d.player;
      if (d.action.type !== 'offerTrade' && d.action.type !== 'counterTrade' && d.action.type !== 'discard') {
        expect(legalActions(host.state, p)).toContainEqual(d.action);
      }
      expect(host.submitBot(d).ok).toBe(true);
      n++;
    }
    expect(host.state.phase).toBe('gameOver');
  }, timeout(30_000));
});
