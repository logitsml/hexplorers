// What a reducer step works on: the state being built, the events it emits and the dice stream,
// with the helpers the base reducer and the rule modules share.

import { Rng } from './rng';
import { gameRng } from './keyedRng';
import { emptyCards } from './constants';
import type { CardCounts, CardMoveReason, CoinReason, GameEvent, GameState, PlayerId } from './types';
import { CARDS } from './types';

/** A rule was broken: the action is refused with this message. */
export class RuleError extends Error {}

export function fail(msg: string): never {
  throw new RuleError(msg);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

/** The refusal of a draw on a view (see KeylessRng): a client checking a move on its view knows it by this. */
export const KEYLESS_DRAW = 'Only the server can draw from this game’s keyed stream: a view holds no key.';

/**
 * A keyed game's stream as a seat's view holds it: no key, so nothing may be drawn. (An action that
 * would draw is refused, as an illegal one is: a view can't play a keyed game on, only the server.)
 */
class KeylessRng extends Rng {
  override next(): number {
    return fail(KEYLESS_DRAW);
  }
}

export class Ctx {
  events: GameEvent[] = [];
  /** The game's stream (every draw, the dice included). */
  rng: Rng;
  /** Something hidden came to light (a face-down hex turned up): the action can't be taken back. */
  revealed = false;
  constructor(public s: GameState) {
    this.rng = gameRng(s) ?? new KeylessRng(s.rngState);
  }
  /** What the turn's roll draws from: the game's stream. */
  get dice(): Rng {
    return this.rng;
  }
  emit(e: GameEvent) {
    this.events.push(e);
  }
}

/** Re-reads the phase (it can change inside helpers, which TypeScript's narrowing cannot see). */
export const isOver = (s: GameState): boolean => s.phase === 'gameOver';

export const validIndex = (v: unknown, n: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n;

/**
 * A card bundle from an action, or null if it isn't one: non-negative whole numbers of known kinds.
 * Kinds left out count as 0 (saves from before commodities and oil list the resources alone).
 */
export function readCounts(rc: unknown): CardCounts | null {
  if (!rc || typeof rc !== 'object' || Array.isArray(rc)) return null;
  const out = emptyCards();
  for (const [k, v] of Object.entries(rc as Record<string, unknown>)) {
    if (!(CARDS as readonly string[]).includes(k) || !Number.isInteger(v) || (v as number) < 0) return null;
    out[k as keyof CardCounts] = v as number;
  }
  return out;
}

export function transfer(from: CardCounts, to: CardCounts, amounts: CardCounts) {
  for (const r of CARDS) {
    from[r] -= amounts[r];
    to[r] += amounts[r];
  }
}

/** Pay `cost` from `player`'s hand to the supply. */
export function pay(s: GameState, player: PlayerId, cost: CardCounts) {
  transfer(s.players[player].hand, s.bank, cost);
}

/**
 * Move cards in the open, for an expansion's move (a cost paid, a pick from the supply, a card
 * handed over), from a hand or the supply (null) to a hand or the supply, and say so, so the card
 * tracker and the table can follow them. A secret move (a theft) goes through doSteal instead.
 */
export function moveCards(ctx: Ctx, from: PlayerId | null, to: PlayerId | null, cards: CardCounts, reason: CardMoveReason) {
  if (!CARDS.some((r) => cards[r] > 0)) return;
  const s = ctx.s;
  transfer(from === null ? s.bank : s.players[from].hand, to === null ? s.bank : s.players[to].hand, cards);
  ctx.emit({ type: 'cardsMoved', from, to, cards: { ...cards }, reason });
}

/** Change `player`'s coins and say so (`piece`: what was built by or sailed off a river). */
export function addCoins(ctx: Ctx, player: PlayerId, amount: number, reason: CoinReason, detail: { piece?: 'settlement' | 'city' | 'road' | 'ship'; setup?: true } = {}) {
  if (amount === 0) return;
  const p = ctx.s.players[player];
  p.coins += amount;
  ctx.emit({ type: 'coins', player, amount, reason, ...detail });
}
