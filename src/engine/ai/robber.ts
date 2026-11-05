// Robber placement, victim choice and discarding on a 7.

import { TERRAIN_RESOURCE, emptyCards } from '../constants';
import { canTakeOil, cardKinds, hexPips, legalRobberHexes, stealCandidates, stealableCount, totalCards } from '../rules';
import type { Action, Card, PlayerId, CardCounts } from '../types';
import { type BotCtx } from './context';

/** Pips of the bot's own production sitting under the robber. */
export function ownBlockedPips(ctx: BotCtx): number {
  const s = ctx.s;
  if (s.robberHex === null) return 0;
  const hex = s.board.hexes[s.robberHex];
  let n = 0;
  for (const v of hex.vertices) {
    const b = s.buildings[v];
    if (b && b.owner === ctx.me) n += hexPips(s, hex) * (b.kind === 'city' ? 2 : 1);
  }
  return n;
}

function victimScore(ctx: BotCtx, o: PlayerId): number {
  const cards = totalCards(ctx.s.players[o].hand);
  return 2 * ctx.seenVp[o] + 0.4 * Math.min(cards, 10) + (o === ctx.leader() ? 1 : 0);
}

export function robberHexScore(ctx: BotCtx, h: number): number {
  const s = ctx.s;
  const hex = s.board.hexes[h];
  const r = TERRAIN_RESOURCE[hex.terrain];
  const pips = hexPips(s, hex);
  const value = r ? ctx.resVal[r] : 0;
  let score = 0;
  let own = false;
  for (const v of hex.vertices) {
    const b = s.buildings[v];
    if (!b) continue;
    const mult = b.kind === 'city' ? 2 : 1;
    if (b.owner === ctx.me) {
      own = true;
      score -= pips * mult * 1.5 + 2;
    } else {
      score += pips * mult * value * ctx.threat(b.owner);
    }
  }
  const victims = stealCandidates(s, h, ctx.me);
  if (victims.length > 0) score += 1.5 + 0.15 * Math.max(...victims.map((o) => Math.min(10, totalCards(s.players[o].hand))));
  if (own) score -= 30;
  if (!r) score -= 20;
  return score;
}

export function chooseRobberHex(ctx: BotCtx): Action {
  const s = ctx.s;
  // Only where the robber may go: not the sea (a custom map's), a wasted hex (Oil) or, with the
  // friendly robber, beside a spared player, when it may stay on the desert. (On the classic
  // island without the friendly robber, that's every other hex.)
  const legal = legalRobberHexes(s);
  const hexes = legal.length > 0 ? legal : s.board.hexes.filter((h) => h.id !== s.robberHex).map((h) => h.id);
  const scored = hexes
    .map((hex) => ({ hex, score: robberHexScore(ctx, hex) }))
    .sort((a, b) => b.score - a.score);
  if (ctx.prof.randomRobber) {
    const good = scored.filter((x) => x.score > 0).slice(0, 5);
    if (good.length > 0) return { type: 'moveRobber', hex: good[ctx.rng.int(good.length)].hex };
  }
  return { type: 'moveRobber', hex: scored[0].hex };
}

export function chooseVictim(ctx: BotCtx): Action {
  const c = ctx.s.stealCandidates;
  let best = c[0];
  if (ctx.prof.randomRobber) best = c[ctx.rng.int(c.length)];
  else for (const o of c) if (victimScore(ctx, o) > victimScore(ctx, best)) best = o;
  return nameOil(ctx, best) ? { type: 'steal', victim: best, oil: true } : { type: 'steal', victim: best };
}

/** Whether a theft from `victim` should name oil: when it's all they have to take, or while short of the two a foundry needs. */
export const nameOil = (ctx: BotCtx, victim: PlayerId): boolean =>
  canTakeOil(ctx.s, ctx.me, victim) && (stealableCount(ctx.s, victim) === 0 || ctx.player.hand.oil < 2);

/** Greedy discard: repeatedly drop the card whose loss hurts the bot's plans least (any kind in play). */
export function chooseDiscard(ctx: BotCtx, count: number): Action {
  const hand = { ...ctx.hand };
  const out = emptyCards();
  for (let i = 0; i < count; i++) {
    let pick: Card | null = null;
    let bestScore = -Infinity;
    for (const r of cardKinds(ctx.s)) {
      if (hand[r] <= 0) continue;
      let score: number;
      if (ctx.prof.greedy) score = hand[r] + ctx.rng.next();
      else {
        hand[r]--;
        score = ctx.scoreHand(hand);
        hand[r]++;
      }
      if (score > bestScore) {
        bestScore = score;
        pick = r;
      }
    }
    hand[pick!]--;
    out[pick!]++;
  }
  return { type: 'discard', resources: out as CardCounts };
}
