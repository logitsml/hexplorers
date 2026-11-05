// Fish tokens: the supply, drawing one at a time, the limit and paying for fish actions.

import type { Ctx } from '../../ctx';
import { numbersOf } from '../../rules';
import type { Building, GameState, Hex, PlayerId } from '../../types';
import { cutOff } from '../shared';
import { BOOT, FISH_LIMIT, tokenCounts, type FishBuy, type FisheriesState, type Token } from './types';

export const fisheriesOf = (s: GameState): FisheriesState => s.ext.fisheries!;

/** The fish shown on a set of tokens. */
export const fishOf = (tokens: readonly Token[]): number => tokens.reduce((n, t) => n + t, 0);

/** The lake, or a fishing ground (a sea hex with printed numbers). */
export const isFishHex = (hex: Hex): boolean => hex.terrain === 'lake' || (hex.terrain === 'sea' && hex.numbers.length > 0);

/** Whether a building at `vertex` touches the lake or a fishing ground that still has a number. */
export function touchesFish(s: GameState, vertex: number): boolean {
  return s.board.vertices[vertex].hexes.some((h) => isFishHex(s.board.hexes[h]) && numbersOf(s, s.board.hexes[h]).length > 0);
}

/** Tokens a building draws when its fishing produces: settlement 1, city 2, foundry 3. */
export const tokensFor = (b: Building): number => (b.foundry ? 3 : b.kind === 'city' ? 2 : 1);

/** The whole mix, face down and shuffled. */
export function freshSupply(s: GameState, shuffle: <T>(a: T[]) => T[]): Token[] {
  const out: Token[] = [];
  const counts = tokenCounts(s);
  for (const v of [1, 2, 3] as const) for (let i = 0; i < counts[v]; i++) out.push(v);
  out.push(BOOT);
  return shuffle(out);
}

/** Put a token in a hand, which is kept highest first. */
function addToken(hand: Token[], t: Token) {
  let i = 0;
  while (i < hand.length && hand[i] >= t) i++;
  hand.splice(i, 0, t);
}

/** Take one token of value `t` out of a hand (the caller has checked it's there). */
export function removeToken(hand: Token[], t: Token) {
  hand.splice(hand.indexOf(t), 1);
}

/**
 * Draw the top token for `player`, shuffling the spent ones into a new supply if it has run out.
 * The boot is shown and kept face up. Returns false if there is nothing at all to draw.
 */
export function drawOne(ctx: Ctx, player: PlayerId): boolean {
  const f = fisheriesOf(ctx.s);
  if (f.supply.length === 0) {
    if (f.discard.length === 0) return false;
    f.supply = ctx.rng.shuffle(f.discard);
    f.discard = [];
    ctx.emit({ type: 'fisheries/reshuffled', tokens: f.supply.length });
  }
  const t = f.supply.pop()!;
  if (t === BOOT) {
    f.boot = player;
    ctx.emit({ type: 'fisheries/bootDrawn', player });
  } else {
    addToken(f.tokens[player], t);
    ctx.emit({ type: 'fisheries/drew', player, value: t });
  }
  return true;
}

/** Drop every draw still owed to `player`; returns how many there were. */
function dropDraws(f: FisheriesState, player: PlayerId): number {
  const before = f.queue.length;
  f.queue = f.queue.filter((p) => p !== player);
  return before - f.queue.length;
}

/**
 * Hand out the draws still owed, one token at a time, until they're done or a player at the limit
 * has a swap to decide (a pending decision; answering it carries on from here). A player at the
 * limit stops drawing either way.
 */
export function runQueue(ctx: Ctx) {
  const s = ctx.s;
  const f = fisheriesOf(s);
  while (f.queue.length > 0) {
    const p = f.queue[0];
    if (f.tokens[p].length >= FISH_LIMIT) {
      ctx.emit({ type: 'fisheries/full', player: p, missed: dropDraws(f, p) });
      if (f.swapTurn[p] !== s.turn && f.supply.length + f.discard.length > 0) {
        s.pending.push({ kind: 'fisheries/swap', players: [p] });
        return;
      }
      continue;
    }
    f.queue.shift();
    if (!drawOne(ctx, p)) ctx.emit({ type: 'fisheries/supplyEmpty', player: p, missed: 1 + dropDraws(f, p) });
  }
}

/**
 * Every way to pay `cost` fish from `hand` with no token to spare (each token is needed, though the
 * last may overpay: no change is given), highest tokens first.
 */
export function payments(hand: readonly Token[], cost: number): Token[][] {
  const have = [0, 0, 0, 0];
  for (const t of hand) if (t >= 1 && t <= 3) have[t]++;
  const out: Token[][] = [];
  for (let a3 = 0; a3 <= have[3]; a3++) {
    for (let a2 = 0; a2 <= have[2]; a2++) {
      for (let a1 = 0; a1 <= have[1]; a1++) {
        const sum = a1 + 2 * a2 + 3 * a3;
        const least = a1 > 0 ? 1 : a2 > 0 ? 2 : a3 > 0 ? 3 : 0;
        if (least === 0 || sum < cost || sum - least >= cost) continue;
        out.push([...Array<Token>(a3).fill(3), ...Array<Token>(a2).fill(2), ...Array<Token>(a1).fill(1)]);
      }
    }
  }
  return out;
}

/**
 * Of these ways to pay for one thing, the one that wastes least and then frees the most room under
 * the limit (the first of equals): how the bots pay, and how the fish page pays for a person.
 */
export function cheapestPay<T extends readonly Token[]>(pays: readonly T[]): T | null {
  let best: T | null = null;
  for (const pay of pays) {
    if (!best || fishOf(pay) < fishOf(best) || (fishOf(pay) === fishOf(best) && pay.length > best.length)) best = pay;
  }
  return best;
}

/** Whether `pay` is a valid payment of `cost` from `hand` (as `payments` lists them, in any order). */
export function validPayment(hand: readonly Token[], pay: unknown, cost: number): pay is Token[] {
  if (!Array.isArray(pay) || pay.length === 0) return false;
  const tokens = Array.from(pay as unknown[]);
  if (!tokens.every((t) => t === 1 || t === 2 || t === 3)) return false;
  const sum = fishOf(tokens as Token[]);
  if (sum < cost || sum - Math.min(...(tokens as Token[])) >= cost) return false;
  const left = [...hand];
  for (const t of tokens as Token[]) {
    const i = left.indexOf(t);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

/** Spend `pay` (already validated): the tokens go face up beside the board. */
export function spend(ctx: Ctx, player: PlayerId, pay: Token[], buy: FishBuy) {
  const f = fisheriesOf(ctx.s);
  for (const t of pay) {
    removeToken(f.tokens[player], t);
    f.discard.push(t);
  }
  ctx.emit({ type: 'fisheries/spent', player, paid: [...pay].sort((a, b) => b - a), buy });
}

/** Conservation and range checks on the tokens (for the module's invariants). */
export function tokenProblems(s: GameState): string[] {
  const f = s.ext.fisheries;
  if (!f) return ['no fisheries state'];
  const out: string[] = [];
  const seen: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const count = (t: Token, where: string) => {
    if (!Number.isInteger(t) || t < 0 || t > 3) out.push(`bad token ${t} in ${where}`);
    else seen[t]++;
  };
  f.supply.forEach((t) => count(t, 'supply'));
  f.discard.forEach((t) => count(t, 'discard'));
  f.tokens.forEach((hand, p) => {
    hand.forEach((t) => count(t, `player ${p}'s hand`));
    if (hand.includes(BOOT)) out.push(`player ${p} holds the boot as a token`);
    if (hand.length > FISH_LIMIT) out.push(`player ${p} holds ${hand.length} tokens`);
  });
  if (f.discard.includes(BOOT)) out.push('the boot is on the discard pile');
  for (const v of [1, 2, 3] as const) if (seen[v] !== tokenCounts(s)[v]) out.push(`${v}-fish tokens: ${seen[v]} (want ${tokenCounts(s)[v]})`);
  const boots = seen[0] + (f.boot === null ? 0 : 1);
  if (boots !== 1) out.push(`${boots} boots`);
  if (f.boot !== null && (f.boot < 0 || f.boot >= s.players.length)) out.push(`boot held by ${f.boot}`);
  if (f.tokens.length !== s.players.length || f.swapTurn.length !== s.players.length) out.push('per-player lists the wrong length');
  if (s.phase !== 'gameOver' && f.queue.length > 0 && !s.pending.some((p) => p.kind === 'fisheries/swap')) out.push('draws owed with no swap pending');
  if (s.robberHex !== null && s.board.hexes[s.robberHex].terrain === 'sea') out.push('the robber is at sea');
  return out;
}

/** Whether the building at `vertex` fishes: there is one, and conquest hasn't cut it off (a cut-off seat included). */
export const fishes = (s: GameState, vertex: number): boolean => !!s.buildings[vertex] && !cutOff(s, vertex);
