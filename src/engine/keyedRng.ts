// A keyed, counter-based random stream for online games (ChaCha20, RFC 8439), with the same
// interface as Rng. `state` stays a plain number (the draws taken), so everything that threads
// GameState.rngState through a step works unchanged; the 256-bit key sits beside it, only in the
// server's state (GameState.rngKey), and redactState strips it. Without the key, a seat's view
// says nothing about dice to come or the deck's order (mulberry32's 32-bit state could be
// brute-forced from the board in minutes).

import { Rng, seedFrom } from './rng';
import type { GameOptions, GameState, PlayerId } from './types';

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

function quarter(s: Uint32Array, a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotl(s[b] ^ s[c], 7);
}

/** One 64-byte ChaCha20 block, as 16 little-endian words. */
export function chachaBlock(key: Uint32Array, counter: number, nonce: Uint32Array, out = new Uint32Array(16)): Uint32Array {
  const init = new Uint32Array(16);
  init.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  init.set(key, 4);
  init[12] = counter >>> 0;
  init.set(nonce, 13);
  const s = init.slice();
  for (let i = 0; i < 10; i++) {
    quarter(s, 0, 4, 8, 12);
    quarter(s, 1, 5, 9, 13);
    quarter(s, 2, 6, 10, 14);
    quarter(s, 3, 7, 11, 15);
    quarter(s, 0, 5, 10, 15);
    quarter(s, 1, 6, 11, 12);
    quarter(s, 2, 7, 8, 13);
    quarter(s, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) out[i] = (s[i] + init[i]) >>> 0;
  return out;
}

/** Hex (little-endian words, as RFC 8439 writes keys) to words. */
export function hexWords(hex: string): Uint32Array {
  if (!/^(?:[0-9a-f]{8})+$/i.test(hex)) throw new Error('keyedRng: the key must be hex, a whole number of words');
  const out = new Uint32Array(hex.length / 8);
  for (let i = 0; i < out.length; i++) {
    let w = 0;
    for (let b = 3; b >= 0; b--) w = (w << 8) | parseInt(hex.substr(i * 8 + b * 2, 2), 16);
    out[i] = w >>> 0;
  }
  return out;
}

/** The streams under one key: the 96-bit nonce's first word (the others are the tweaks). */
export const STREAM = {
  /** The game's own draws: the board, the decks, the dice, the thefts. */
  game: 0,
  /** The bots' choices (tweaked by the action counter and the seat). */
  bots: 1,
  /** Draws anyone may repeat (the discard sample), under the public key. */
  public: 3,
  /** The board's deal (maps/deal.ts), when the game itself deals it. */
  deal: 4,
} as const;

/** A key everybody knows, for draws that must come out the same on every side (a seat's view included). */
export const PUBLIC_KEY = '0'.repeat(64);

/** A 256-bit key as the engine takes it: 64 hex digits. */
export const isKey = (k: unknown): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k);

/**
 * Drop-in for Rng: next/int/die/shuffle, `state` = words drawn. `stream` picks an independent
 * stream under the same key (see STREAM); `tweak` and `tweak2` the stream's instance (a turn, an
 * action counter and a seat).
 */
export class KeyedRng extends Rng {
  private key: Uint32Array;
  private nonce: Uint32Array;
  private block = new Uint32Array(16);
  private blockNo = -1;

  constructor(keyHex: string, state: number, stream = 0, tweak = 0, tweak2 = 0) {
    super(state);
    if (!isKey(keyHex)) throw new Error('keyedRng: the key must be 256 bits, as 64 hex digits');
    this.key = hexWords(keyHex);
    this.nonce = new Uint32Array([stream >>> 0, tweak >>> 0, tweak2 >>> 0]);
  }

  private word(i: number) {
    const b = Math.floor(i / 16);
    if (b !== this.blockNo) {
      chachaBlock(this.key, b, this.nonce, this.block);
      this.blockNo = b;
    }
    return this.block[i % 16];
  }

  override next(): number {
    return this.word(this.state++) / 4294967296;
  }

  /** Unbiased: rejection sampling on 32-bit words. */
  override int(maxExclusive: number): number {
    const n = Math.floor(maxExclusive);
    // (Nothing to choose from: a draw, and 0, as mulberry32's floor(x·0) gives.)
    if (!(n >= 1)) {
      this.state++;
      return 0;
    }
    const lim = Math.floor(4294967296 / n) * n;
    for (;;) {
      const w = this.word(this.state++);
      if (w < lim) return w % n;
    }
  }
}

// ------------------------------------------------------------------ the factory
//
// Every random draw the engine makes comes from one of these. A game without `options.rng` (or
// with 'mulberry32') draws exactly as it always has, so saves, replays and the golden games stay
// as recorded; a 'chacha20' game draws only from ChaCha20 streams, its own under its key.

const keyed = (o: Pick<GameOptions, 'rng'>) => o.rng === 'chacha20';

/** The stream a new game is set up from (the board, the decks, the roll-off and the modules' own). */
export function setupRng(options: GameOptions, rngKey: string | undefined): Rng {
  if (!keyed(options)) return new Rng(seedFrom(options.seed));
  if (!isKey(rngKey)) throw new Error('A chacha20 game needs its key: 64 hex digits.');
  return new KeyedRng(rngKey, 0, STREAM.game);
}

/**
 * The game's stream where `s` left it, or null for a keyed game's view (which holds no key: only
 * the server can draw; see Ctx).
 */
export function gameRng(s: Pick<GameState, 'options' | 'rngState' | 'rngKey'>): Rng | null {
  if (!keyed(s.options)) return new Rng(s.rngState);
  return isKey(s.rngKey) ? new KeyedRng(s.rngKey, s.rngState, STREAM.game) : null;
}

/**
 * A bot's own randomness for one decision (its noise and its coin flips). Keyed games draw it from
 * the bots' stream under the game's key, so nothing public predicts it; a bot judging from a view
 * (no key, as table talk on a client does) draws from the public key instead.
 */
export function botRng(s: Pick<GameState, 'options' | 'rngState' | 'rngKey' | 'seq'>, me: PlayerId): Rng {
  if (!keyed(s.options)) return new Rng(seedFrom(seedFrom(s.seq * 31 + me * 7 + 1) ^ s.rngState ^ s.options.seed));
  return new KeyedRng(isKey(s.rngKey) ? s.rngKey : PUBLIC_KEY, 0, STREAM.bots, s.seq, me);
}

/**
 * A draw anyone can repeat from public data (`seed`: the action counter and the seat), as the
 * discard sample is: a seat's view must offer the same choices as the full state.
 */
export function publicRng(s: Pick<GameState, 'options'>, seed: number): Rng {
  return keyed(s.options) ? new KeyedRng(PUBLIC_KEY, 0, STREAM.public, seed) : new Rng(seed);
}
