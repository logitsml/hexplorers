// The keyed stream online games draw from (R1): ChaCha20 as RFC 8439 has it, every draw of a keyed
// game taken from it, and nothing a seat's view holds that says what comes next.

import { afterEach, describe, expect, it } from 'vitest';
import { Rng, applyAction, createGame, redactState, validateOptions, DEFAULT_OPTIONS, type GameEvent, type GameState } from '../../src/engine';
import { KeyedRng, PUBLIC_KEY, STREAM, botRng, chachaBlock, hexWords } from '../../src/engine/keyedRng';
import { wireView } from '../../src/engine/wire';
import { setups } from '../sim-harness';
import { ALL_HANDS_OPTIONS, keyed, playGame, testKey } from './play';

const words = (ws: Uint32Array) => Array.from(ws, (w) => w.toString(16).padStart(8, '0'));
/** The block as the keystream's bytes (each word little-endian). */
const bytes = (ws: Uint32Array) => Array.from(ws).flatMap((w) => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24]).map((b) => b.toString(16).padStart(2, '0')).join('');

describe('ChaCha20 (RFC 8439)', () => {
  it('computes the block function test vector (section 2.3.2)', () => {
    const key = hexWords('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const nonce = hexWords('000000090000004a00000000');
    expect(words(chachaBlock(key, 1, nonce))).toEqual([
      'e4e7f110', '15593bd1', '1fdd0f50', 'c47120a3',
      'c7f4d1c7', '0368c033', '9aaa2204', '4e6cd4c3',
      '466482d2', '09aa9f07', '05d7c214', 'a2028bd9',
      'd19c12b5', 'b94e16de', 'e883d0cb', '4e3c50a2',
    ]);
  });

  it('computes the keystream test vector for the zero key (appendix A.1, #1)', () => {
    const block = chachaBlock(new Uint32Array(8), 0, new Uint32Array(3));
    expect(bytes(block)).toBe('76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586');
    // The stream is that keystream, a word at a time.
    const r = new KeyedRng(PUBLIC_KEY, 0, 0);
    expect(Math.round(r.next() * 4294967296)).toBe(block[0]);
    expect(Math.round(r.next() * 4294967296)).toBe(block[1]);
    expect(r.state).toBe(2);
  });

  it('is a drop-in for Rng: the same key, state and stream give the same draws, a draw a word', () => {
    const key = testKey(1);
    const a = new KeyedRng(key, 0, STREAM.game);
    const drawn = Array.from({ length: 40 }, () => a.next());
    const b = new KeyedRng(key, 17, STREAM.game);
    expect(b.next()).toBe(drawn[17]);
    expect(new KeyedRng(key, 0, STREAM.bots).next()).not.toBe(drawn[0]);
    expect(new KeyedRng(key, 0, STREAM.game, 1).next()).not.toBe(drawn[0]);
    expect(new KeyedRng(testKey(2), 0, STREAM.game).next()).not.toBe(drawn[0]);
    expect(() => new KeyedRng('abc', 0)).toThrow(/256 bits/);
  });

  it('rolls fair dice and picks evenly (rejection sampling)', () => {
    const r = new KeyedRng(testKey(3), 0);
    const faces = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60_000; i++) faces[r.die() - 1]++;
    for (const n of faces) expect(Math.abs(n - 10_000)).toBeLessThan(500);
    expect(r.int(1)).toBe(0);
    const before = r.state;
    expect(r.int(0)).toBe(0);
    expect(r.state).toBe(before + 1);
    const deck = r.shuffle(Array.from({ length: 25 }, (_, i) => i));
    expect([...deck].sort((x, y) => x - y)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});

describe('keyed games', () => {
  it('play the same with the same key, whatever the seed, and differently with another key', () => {
    const a = createGame(setups(4), { rng: 'chacha20', seed: 1, layout: 'random' }, { rngKey: testKey(10) }).state;
    const b = createGame(setups(4), { rng: 'chacha20', seed: 2, layout: 'random' }, { rngKey: testKey(10) }).state;
    const c = createGame(setups(4), { rng: 'chacha20', seed: 1, layout: 'random' }, { rngKey: testKey(11) }).state;
    // (The seed only varies the scenery: the board, the deck and the roll-off come from the key.)
    expect(b.board).toEqual(a.board);
    expect(b.devDeck).toEqual(a.devDeck);
    expect(b.firstPlayer).toBe(a.firstPlayer);
    expect(c.board.hexes.map((h) => h.terrain)).not.toEqual(a.board.hexes.map((h) => h.terrain));
    expect(a.rngKey).toBe(testKey(10));
    // A whole game, twice: the same moves, events and states.
    const g1 = playGame('keyed', 5, keyed(20).options, keyed(20).secret);
    const g2 = playGame('keyed', 5, keyed(20).options, keyed(20).secret);
    expect(g1.final.phase).toBe('gameOver');
    expect(g2.steps.map((s) => s.action)).toEqual(g1.steps.map((s) => s.action));
    expect(g2.steps.map((s) => s.events)).toEqual(g1.steps.map((s) => s.events));
    expect(g2.final).toEqual(g1.final);
    // A state survives a JSON round trip with its key, and plays on the same from it.
    const mid = g1.steps[Math.floor(g1.steps.length / 2)];
    expect(applyAction(JSON.parse(JSON.stringify(mid.before)) as GameState, mid.actor, mid.action)).toEqual(applyAction(mid.before, mid.actor, mid.action));
  }, 1_800_000);

  describe('never draw from mulberry32', () => {
    const next = Rng.prototype.next;
    let calls = 0;
    afterEach(() => {
      Rng.prototype.next = next;
    });
    const count = () => {
      calls = 0;
      Rng.prototype.next = function (this: Rng) {
        calls++;
        return next.call(this);
      };
    };

    it('in set-up, play, discards and the bots, through every module', () => {
      count();
      // (An unkeyed game does, as it always has: the count sees it.)
      createGame(setups(4), { seed: 3 });
      expect(calls).toBeGreaterThan(0);
      count();
      const base = playGame('base', 3, keyed(30).options, keyed(30).secret);
      const all = playGame('all hands', 4, keyed(31, ALL_HANDS_OPTIONS).options, keyed(31).secret, { maxSteps: 700 });
      expect(base.final.phase).toBe('gameOver');
      expect(base.steps.some((s) => s.before.phase === 'discard')).toBe(true);
      expect(all.steps.length).toBe(700);
      expect(calls).toBe(0);
    }, 1_800_000);
  });

  it('refuse a key that doesn’t go with the options, and options that can’t be keyed', () => {
    const k = testKey(40);
    expect(() => createGame(setups(4), { rng: 'chacha20' })).toThrow(/needs its key/);
    expect(() => createGame(setups(4), { rng: 'chacha20' }, { rngKey: 'xyz' })).toThrow(/needs its key/);
    expect(() => createGame(setups(4), {}, { rngKey: k })).toThrow(/only a chacha20 game/);
    expect(() => createGame(setups(4), { rng: 'mulberry32' }, { rngKey: k })).toThrow(/only a chacha20 game/);
    expect(createGame(setups(4), { rng: 'mulberry32', seed: 9 }).state.board).toEqual(createGame(setups(4), { seed: 9 }).state.board);
    expect(() => validateOptions({ ...DEFAULT_OPTIONS, rng: 'xorshift' as never })).toThrow(/rng xorshift/);
    expect(() => validateOptions({ ...DEFAULT_OPTIONS, rng: 'chacha20', rules: 2 })).toThrow(/rules 3 or later/);
    expect(() => validateOptions({ ...DEFAULT_OPTIONS, rng: 'chacha20' })).not.toThrow();
  });

  it('keep their keys out of every view, and where the stream stands', () => {
    const g = playGame('views', 6, keyed(50).options, keyed(50).secret, { maxSteps: 120 });
    const key = testKey(50);
    for (const st of [g.initial, ...g.steps.filter((_, i) => i % 10 === 0).map((s) => s.state)]) {
      expect(st.rngKey).toBe(key);
      for (const v of [0, 1, 2, 3, null]) {
        const view = redactState(st, v);
        expect(view.rngKey).toBeUndefined();
        expect(view.rngState).toBe(0);
        // (A keyed game's seed only varies the scenery: views keep it.)
        expect(view.options.seed).toBe(6);
        expect(JSON.stringify(view)).not.toContain(key);
        expect(JSON.stringify(wireView(st, v))).not.toContain(key);
      }
    }
  }, 1_800_000);

  it('give bots their own stream under the key: nothing public predicts it', () => {
    const s = createGame(setups(4), { rng: 'chacha20' }, { rngKey: testKey(60) }).state;
    const seen = redactState(s, 0);
    const own = botRng(s, 1).next();
    expect(botRng(s, 1).next()).toBe(own);
    expect(botRng({ ...s, rngKey: testKey(61) }, 1).next()).not.toBe(own);
    // (On a view, with no key, a bot's noise comes from the public key: not the server's.)
    expect(botRng(seen, 1).next()).not.toBe(own);
    expect(botRng(seen, 1).next()).toBe(new KeyedRng(PUBLIC_KEY, 0, STREAM.bots, s.seq, 1).next());
  });
});

// The attack of docs/online/research/protocol-security.md §3.5, scaled down: from the roll-off's
// dice and the turns' rolls a seat sees, search a window of mulberry32's 2^32 states for the one
// the game was at. It finds it in an unkeyed game (and with it every roll to come), and nothing
// in a keyed one.
describe('the dice-stream attack', () => {
  const C = 0x6d2b79f5;
  const WINDOW = 1 << 20;

  /** The draws a seat can see, in order: the roll-off's dice, then each turn's two and a draw per secret theft. */
  function timeline(initialEvents: GameEvent[], events: GameEvent[]): (number | 'theft')[] {
    const first = initialEvents.find((e) => e.type === 'firstPlayerChosen');
    const out: (number | 'theft')[] = first && first.type === 'firstPlayerChosen' ? first.rolls.flatMap((round) => round.flatMap((r) => r.dice)) : [];
    for (const e of events) {
      if (e.type === 'diceRolled') out.push(...e.dice);
      if (e.type === 'stolen' && !e.named) out.push('theft');
    }
    return out;
  }

  /** The states in [from, from + WINDOW) that explain the first `upto` draws of the timeline. */
  function search(from: number, seen: (number | 'theft')[], upto: number): number[] {
    const found: number[] = [];
    for (let i = 0; i < WINDOW; i++) {
      let st = (from + i) | 0;
      let ok = true;
      for (let k = 0; k < upto && ok; k++) {
        st = (st + C) | 0;
        if (seen[k] === 'theft') continue;
        let t = Math.imul(st ^ (st >>> 15), st | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        ok = 1 + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 6) === seen[k];
      }
      if (ok) found.push((from + i) | 0);
    }
    return found;
  }

  function attack(options: Parameters<typeof playGame>[2], secret?: Parameters<typeof playGame>[3]) {
    const g = playGame('attack', 4242, options, secret, { maxSteps: 400 });
    const seen = timeline(g.initialEvents, g.steps.flatMap((s) => s.events));
    const offIn = timeline(g.initialEvents, []).length;
    // (The window is placed round where an unkeyed game's stream stood before the roll-off: the
    // attacker searches all 2^32 states, about 10 minutes of one core, or seconds on a GPU.)
    const before = (g.initial.rngState - offIn * C) | 0;
    const from = (before - (WINDOW >> 1) + 12345) | 0;
    const upto = Math.min(seen.length, offIn + 12);
    return { g, seen, before, found: search(from, seen, upto) };
  }

  it('finds an unkeyed game’s stream and predicts its rolls', () => {
    const { seen, before, found } = attack({});
    expect(found).toEqual([before]);
    let st = before;
    let right = 0;
    let rolls = 0;
    for (const d of seen) {
      st = (st + C) | 0;
      if (d === 'theft') continue;
      const r = new Rng((st - C) | 0);
      rolls++;
      if (r.die() === d) right++;
    }
    expect(right).toBe(rolls);
  }, 1_800_000);

  it('finds nothing in a keyed game', () => {
    const { found, g } = attack(keyed(70).options, keyed(70).secret);
    expect(found).toEqual([]);
    // (Nor does a view carry anything to search from: no seed's stream, no key, no place in it.)
    const view = redactState(g.initial, 0);
    expect(view.rngState).toBe(0);
    expect(view.rngKey).toBeUndefined();
  }, 1_800_000);
});
