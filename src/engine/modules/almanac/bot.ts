// The bot's answers to the happenings, and mending its cracked roads.

import type { BotCtx } from '../../ai/context';
import { nameOil } from '../../ai/robber';
import { canAfford, hasResources, legalSettlements, robbable, satisfiesDistanceRule, totalCards } from '../../rules';
import type { Action, Card, CardCounts, Pending, PlayerId, Resource } from '../../types';
import { RESOURCES } from '../../types';
import type { ModuleBot } from '../api';
import { type AlmanacPendingData, REPAIR_COST, bankResources, crackable, crackedRoads, giftKinds, leftOf } from './happenings';

/** What a hand would score with `k` cards of a kind added (negative: taken away). */
function scoreWith(ctx: BotCtx, kind: Card, k: number): number {
  const hand: CardCounts = { ...ctx.hand };
  hand[kind] += k;
  return ctx.scoreHand(hand);
}

/** The open spots a road's ends hold for this bot: what cracking it would cost (nobody may settle beside it). */
function crackHarm(ctx: BotCtx, edge: number): number {
  const s = ctx.s;
  const ed = s.board.edges[edge];
  let harm = 0;
  for (const v of [ed.a, ed.b]) if (satisfiesDistanceRule(s, v)) harm += 1 + ctx.spotValue(v);
  return harm;
}

function chooseCrack(ctx: BotCtx): Action | null {
  let best: { edge: number; harm: number } | null = null;
  for (const edge of crackable(ctx.s, ctx.me)) {
    const harm = crackHarm(ctx, edge);
    if (!best || harm < best.harm) best = { edge, harm };
  }
  return best && { type: 'almanac/crack', edge: best.edge };
}

function chooseTake(ctx: BotCtx): Action | null {
  let best: { resource: Resource; score: number } | null = null;
  for (const resource of bankResources(ctx.s)) {
    const score = scoreWith(ctx, resource, 1) + 0.01 * ctx.resVal[resource];
    if (!best || score > best.score) best = { resource, score };
  }
  return best && { type: 'almanac/take', resource: best.resource };
}

/**
 * The card it hurts least to give. The base planner weighs resources only; a commodity is given
 * at a modest fixed cost, less from a bigger pile.
 */
function chooseGiftCard(ctx: BotCtx): Card | null {
  const base = ctx.scoreHand(ctx.hand);
  let best: { card: Card; loss: number } | null = null;
  for (const card of giftKinds(ctx.s)) {
    if (ctx.hand[card] <= 0) continue;
    const loss = RESOURCES.includes(card as Resource) ? base - scoreWith(ctx, card, -1) : 0.35 - 0.05 * Math.min(4, ctx.hand[card]);
    if (!best || loss < best.loss) best = { card, loss };
  }
  return best?.card ?? null;
}

function chooseGift(ctx: BotCtx, d: AlmanacPendingData): Action | null {
  const card = chooseGiftCard(ctx);
  if (!card) return null;
  if (d.happening === 'gifts') return { type: 'almanac/give', card, to: leftOf(ctx.s, ctx.me) };
  // A helping hand: help whoever threatens least.
  let to: PlayerId | null = null;
  for (const o of d.recipients ?? []) if (to === null || ctx.threat(o) < ctx.threat(to)) to = o;
  return to === null ? null : { type: 'almanac/give', card, to };
}

function chooseVictim(ctx: BotCtx, d: AlmanacPendingData): Action | null {
  const s = ctx.s;
  const leader = ctx.leader();
  let best: { victim: PlayerId; score: number } | null = null;
  for (const o of d.victims ?? []) {
    if (!robbable(s, ctx.me, o)) continue;
    const score = 2 * ctx.publicVp[o] + 0.4 * Math.min(totalCards(s.players[o].hand), 10) + (o === leader ? 1 : 0);
    if (!best || score > best.score) best = { victim: o, score };
  }
  return best && (nameOil(ctx, best.victim) ? { type: 'almanac/rob', victim: best.victim, oil: true } : { type: 'almanac/rob', victim: best.victim });
}

/**
 * Mend a cracked road once brick and wood are in hand, unless they would build a settlement now
 * (it scores at once; the mending can wait). Not worth it with no roads left to build and no spot
 * beside the crack to settle.
 */
function repair(ctx: BotCtx): Action | null {
  const s = ctx.s;
  const cracked = crackedRoads(s, ctx.me);
  if (cracked.length === 0 || !hasResources(ctx.hand, REPAIR_COST)) return null;
  if (ctx.player.settlementsLeft > 0 && canAfford(s, ctx.me, 'settlement') && legalSettlements(s, ctx.me).length > 0) return null;
  const open = (e: number) => [s.board.edges[e].a, s.board.edges[e].b].some((v) => satisfiesDistanceRule(s, v));
  if (ctx.player.roadsLeft <= 0 && !cracked.some(open)) return null;
  // The crack beside the best spot first.
  let best = cracked[0];
  let worth = -1;
  for (const e of cracked) {
    const w = crackHarm(ctx, e);
    if (w > worth) {
      worth = w;
      best = e;
    }
  }
  return { type: 'almanac/repair', edge: best };
}

export const almanacBot: ModuleBot = {
  pending(ctx: BotCtx, p: Pending): Action | null {
    const d = p.data as AlmanacPendingData;
    switch (p.kind) {
      case 'almanac/quake':
        return chooseCrack(ctx);
      case 'almanac/take':
        return chooseTake(ctx);
      case 'almanac/gift':
        return chooseGift(ctx, d);
      case 'almanac/rob':
        return chooseVictim(ctx, d);
    }
    return null;
  },
  main: repair,
};
