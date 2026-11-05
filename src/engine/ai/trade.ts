// Maritime and domestic trading.

import { countsKey, emptyCards } from '../constants';
import { tradeFits } from '../actions';
import { hasResources, isOpenOffer, totalCards } from '../rules';
import { mightHold } from '../tracker';
import type { Action, PlayerId, Resource, CardCounts } from '../types';
import { RESOURCES } from '../types';
import { add, missingFor, sub, type BotCtx, type BuildOption } from './context';

/** A refused offer is not proposed again on the bot's next this-many turns. */
const REFUSED_ROUNDS = 2;

interface BankStep {
  give: Resource;
  get: Resource;
  ratio: number;
}

/**
 * A sequence of maritime trades that makes `need` affordable while never giving away cards counted in
 * `reserve`, or null if impossible. Never gives a resource obtained from the bank this turn or takes
 * one given to it this turn, so repeated calls cannot oscillate.
 */
export function bankPlan(ctx: BotCtx, need: CardCounts, reserve: CardCounts): BankStep[] | null {
  const h = { ...ctx.hand };
  const bank = { ...ctx.s.bank };
  const steps: BankStep[] = [];
  for (const r of RESOURCES) {
    while (h[r] < need[r]) {
      if (bank[r] < 1 || ctx.mem.gaveToBank.includes(r)) return null;
      let best: Resource | null = null;
      for (const g of RESOURCES) {
        if (g === r || ctx.mem.gotFromBank.includes(g)) continue;
        if (h[g] - Math.max(reserve[g], need[g]) < ctx.ratios[g]) continue;
        if (
          !best ||
          ctx.ratios[g] < ctx.ratios[best] ||
          (ctx.ratios[g] === ctx.ratios[best] && h[g] - reserve[g] > h[best] - reserve[best]) ||
          (ctx.ratios[g] === ctx.ratios[best] && h[g] - reserve[g] === h[best] - reserve[best] && ctx.resVal[g] < ctx.resVal[best])
        )
          best = g;
      }
      if (!best) return null;
      h[best] -= ctx.ratios[best];
      bank[best] += ctx.ratios[best];
      h[r]++;
      bank[r]--;
      steps.push({ give: best, get: r, ratio: ctx.ratios[best] });
    }
  }
  return steps;
}

export function bankAction(step: BankStep): Action {
  return { type: 'bankTrade', give: step.give, get: step.get, times: 1 };
}

/** A person who has turned down this many of a bot's offers in a row is left in peace for a few rounds. */
const DECLINES_BEFORE_BACKOFF = 2;
const BACKOFF_ROUNDS = 3;

/** Whether the bot is holding off offers to `o`: a person who refused its last few (bots answer by the numbers, and never mind). */
export function backedOff(ctx: BotCtx, o: PlayerId): boolean {
  if (ctx.s.players[o].isBot) return false;
  const notes = ctx.mem.notes;
  if ((notes[`declines${o}`] ?? 0) < DECLINES_BEFORE_BACKOFF) return false;
  if (ctx.s.turn - (notes[`declinedAt${o}`] ?? -Infinity) <= BACKOFF_ROUNDS * ctx.s.players.length) return true;
  // (The rest is over: they are asked afresh, two refusals before the next one.)
  notes[`declines${o}`] = 0;
  return false;
}

/** What the people asked made of the offer now closing: a refusal counts toward leaving them alone, anything else clears it. */
function noteAnswers(ctx: BotCtx, eligible: PlayerId[]) {
  const t = ctx.s.trade!;
  for (const o of eligible) {
    if (ctx.s.players[o].isBot) continue;
    if (t.responses[o] === 'rejected' && !t.counters[o]) {
      ctx.mem.notes[`declines${o}`] = (ctx.mem.notes[`declines${o}`] ?? 0) + 1;
      ctx.mem.notes[`declinedAt${o}`] = ctx.s.turn;
    } else if (t.responses[o] === 'accepted' || t.counters[o]) ctx.mem.notes[`declines${o}`] = 0;
  }
}

/** Opponents a bot is willing to trade with: nobody within two points of winning, nor a person it has pestered enough. */
function tradePartners(ctx: BotCtx): PlayerId[] {
  return ctx.opponents.filter((o) => ctx.seenVp[o] < ctx.target - 2 && !backedOff(ctx, o));
}

/** Whether the bot takes part in domestic trading at this moment (easy bots only now and then). */
function inTheMood(ctx: BotCtx): boolean {
  return ctx.prof.domestic && (ctx.prof.tradeChance >= 1 || ctx.rng.next() < ctx.prof.tradeChance);
}

/** A deal no bot takes: giving away more than one card beyond what it gets. */
const lopsided = (ctx: BotCtx, gives: CardCounts, gets: CardCounts) => totalCards(gives) > totalCards(gets) + ctx.prof.maxGiveExtra;

/**
 * How likely `o` is to take an offer in which they give `oGives` for `oGets`: whether the tracker
 * says they hold the cards, and whether the deal looks good for them while not too good for us.
 */
function takeChance(ctx: BotCtx, o: PlayerId, oGives: CardCounts, oGets: CardCounts, ourGain: number): number {
  const has = ctx.holdChance(o, oGives);
  if (has <= 0 || lopsided(ctx, oGives, oGets)) return 0;
  const theirs = ctx.gainFor(o, oGives, oGets);
  const net = theirs - 0.4 * Math.max(0, ourGain);
  return has * (net > 0.05 ? 1 : theirs > 0.05 ? 0.4 : theirs > 0 ? 0.15 : 0.03);
}

/** A domestic offer that gets the bot closer to `goal`, or null. */
export function proposeOffer(ctx: BotCtx, goal: BuildOption): Action | null {
  if (!ctx.prof.domestic || ctx.mem.offersMade >= ctx.prof.offersPerTurn) return null;
  const need = missingFor(ctx.hand, goal.stepCost);
  const missing = totalCards(need);
  if (missing === 0 || missing > 2) return null;

  let spare = emptyCards();
  for (const r of RESOURCES) spare[r] = Math.max(0, ctx.hand[r] - goal.cost[r]);
  if (totalCards(spare) === 0) for (const r of RESOURCES) spare[r] = Math.max(0, ctx.hand[r] - goal.stepCost[r]);
  if (totalCards(spare) === 0) return null;

  // Public information only (the card tracker): someone who may hold what we want.
  const partners = tradePartners(ctx).filter((o) => ctx.holdChance(o, need) > 0);
  if (partners.length === 0 || !inTheMood(ctx)) return null;

  const candidates: { give: CardCounts; get: CardCounts }[] = [];
  const spareTypes = RESOURCES.filter((r) => spare[r] > 0 && need[r] === 0);
  if (missing === 1) {
    const r = RESOURCES.find((x) => need[x] > 0)!;
    const get = { ...emptyCards(), [r]: 1 };
    for (const g of spareTypes) {
      candidates.push({ give: { ...emptyCards(), [g]: 1 }, get });
      if (ctx.mem.offersMade > 0 && spare[g] >= 2) candidates.push({ give: { ...emptyCards(), [g]: 2 }, get });
      for (const g2 of spareTypes) if (g2 > g && ctx.mem.offersMade > 0) candidates.push({ give: { ...emptyCards(), [g]: 1, [g2]: 1 }, get });
    }
  } else {
    const get = { ...need };
    for (const g of spareTypes) {
      if (spare[g] >= 2) candidates.push({ give: { ...emptyCards(), [g]: 2 }, get });
      for (const g2 of spareTypes) if (g2 > g) candidates.push({ give: { ...emptyCards(), [g]: 1, [g2]: 1 }, get });
    }
  }

  const base = ctx.scoreHand(ctx.hand);
  const window = REFUSED_ROUNDS * ctx.s.players.length;
  ctx.mem.refused = ctx.mem.refused.filter((r) => ctx.s.turn - r.turn <= window);
  let best: { give: CardCounts; get: CardCounts; delta: number; to: PlayerId[] } | null = null;
  for (const c of candidates) {
    if (!hasResources(ctx.hand, c.give)) continue;
    const key = countsKey(c.give) + '>' + countsKey(c.get);
    if (ctx.mem.offerKeys.includes(key) || ctx.mem.refused.some((r) => r.key === key)) continue;
    const delta = ctx.scoreHand(add(sub(ctx.hand, c.give), c.get)) - base;
    if (delta <= 0.1) continue;
    // Only to partners likely enough to take it (so nobody is asked for what they lack or won't give).
    const chances = partners.map((o) => ({ o, p: takeChance(ctx, o, c.get, c.give, delta) }));
    const to = chances.filter((x) => x.p >= ctx.prof.minAcceptChance).map((x) => x.o);
    if (to.length === 0) continue;
    const likely = 1 - chances.reduce((q, x) => q * (1 - x.p), 1);
    // Prefer giving fewer cards when the gain is similar, and deals that are likely to happen.
    const adj = delta * (0.6 + 0.4 * likely) - 0.02 * totalCards(c.give);
    if (!best || adj > best.delta) best = { ...c, delta: adj, to };
  }
  if (!best) return null;
  ctx.mem.offersMade++;
  ctx.mem.offerKeys.push(countsKey(best.give) + '>' + countsKey(best.get));
  const to = best.to.length === ctx.opponents.length ? [] : best.to;
  return { type: 'offerTrade', give: best.give, get: best.get, to };
}

/** Whether to accept the open offer (the bot would give `trade.get` and receive `trade.give`). */
export function wantsTrade(ctx: BotCtx): boolean {
  const t = ctx.s.trade!;
  if (!ctx.prof.domestic || isOpenOffer(t)) return false;
  if (!hasResources(ctx.hand, t.get)) return false;
  if (ctx.seenVp[t.proposer] >= ctx.target - 2) return false;
  if (ctx.prof.tradeChance < 1 && ctx.rng.next() >= ctx.prof.tradeChance) return false;
  return dealValue(ctx, t.proposer, t.get, t.give) > threshold(ctx, t.proposer);
}

/** The bar a deal with `o` must clear (higher against a leader). */
function threshold(ctx: BotCtx, o: PlayerId): number {
  const ahead = Math.max(0, ctx.seenVp[o] - ctx.publicVp[ctx.me]);
  return ctx.prof.acceptBase + ctx.prof.acceptAhead * ahead;
}

/**
 * Net worth to the bot of giving `gives` to `o` for `gets`: its own hand-score gain, less what the
 * deal is worth to `o` (from what the bot can see of their hand). -Infinity for lopsided deals.
 */
export function dealValue(ctx: BotCtx, o: PlayerId, gives: CardCounts, gets: CardCounts): number {
  if (lopsided(ctx, gives, gets)) return -Infinity;
  const own = ctx.scoreHand(add(sub(ctx.hand, gives), gets)) - ctx.scoreHand(ctx.hand);
  if (ctx.prof.partnerWeight <= 0) return own;
  return own - ctx.partnerCost(o) * Math.max(0, ctx.gainFor(o, gets, gives));
}

/**
 * When a human's offer isn't worth taking as it stands, the most modest variant the bot would take:
 * one more card of a kind the proposer is known to produce, one card fewer from the bot, or the bot
 * paying in a resource it has to spare. Uses public information only. Null if nothing clears its bar.
 */
export function proposeCounter(ctx: BotCtx): Action | null {
  const t = ctx.s.trade!;
  if (!ctx.prof.domestic || ctx.s.players[t.proposer].isBot) return null;
  if (ctx.seenVp[t.proposer] >= ctx.target - 2) return null;
  if (ctx.prof.tradeChance < 1 && ctx.rng.next() >= ctx.prof.tradeChance) return null;
  // From the bot's side: it gives `give` and receives `get`.
  const n = totalCards(t.get);
  const candidates: { give: CardCounts; get: CardCounts }[] = [];
  if (isOpenOffer(t)) {
    // An open offer asks what the bot would give for the cards put up: a bid of up to one card more
    // than it's offered, of one kind or two, from resources the proposer isn't giving.
    const most = Math.min(totalCards(t.give) + 1, 4);
    for (const r of RESOURCES) {
      if (t.give[r] > 0) continue;
      for (let k = 1; k <= Math.min(most, ctx.hand[r]); k++) candidates.push({ give: { ...emptyCards(), [r]: k }, get: t.give });
      for (const q of RESOURCES) if (q > r && t.give[q] === 0 && most >= 2) candidates.push({ give: { ...emptyCards(), [r]: 1, [q]: 1 }, get: t.give });
    }
  }
  for (const r of isOpenOffer(t) ? [] : RESOURCES) {
    if (t.get[r] === 0 && ctx.prod[t.proposer][r] > 0) candidates.push({ give: t.get, get: { ...t.give, [r]: t.give[r] + 1 } });
    if (t.get[r] > 0 && n > 1) candidates.push({ give: { ...t.get, [r]: t.get[r] - 1 }, get: t.give });
    if (t.give[r] === 0 && t.get[r] < n) candidates.push({ give: { ...emptyCards(), [r]: n }, get: t.give });
  }
  const bar = threshold(ctx, t.proposer);
  let best: { give: CardCounts; get: CardCounts; delta: number } | null = null;
  for (const c of candidates) {
    if (!hasResources(ctx.hand, c.give) || RESOURCES.some((r) => c.give[r] > 0 && c.get[r] > 0)) continue;
    const delta = dealValue(ctx, t.proposer, c.give, c.get);
    if (delta > bar && (!best || delta < best.delta)) best = { ...c, delta };
  }
  return best ? { type: 'counterTrade', give: { ...best.give }, get: { ...best.get } } : null;
}

/**
 * The proposer's move while its offer is open: null while waiting for answers, otherwise accept the best
 * acceptance or counter-offer, or cancel. Every candidate is scored on one scale (the bot's hand-score
 * gain, less a little per point the partner holds). Acceptances of its own offer always qualify; a counter
 * qualifies if it clears the same bar as accepting someone else's offer, or is at least as good as the
 * bot's own terms.
 */
export function resolveOwnOffer(ctx: BotCtx): Action | null {
  const s = ctx.s;
  const t = s.trade!;
  const eligible = t.to.length > 0 ? t.to : ctx.opponents;
  // (A person the tracker shows can't pay isn't waited for: they couldn't take it. It's judged from
  // the table, as the host's backstop timer judges it, never from their hand: a person whose hand a
  // theft has hidden is waited for, and may still counter.)
  const waiting = eligible.filter(
    (o) =>
      t.responses[o] === undefined &&
      t.counters[o] === undefined &&
      (s.players[o].isBot || (ctx.mem.waitForHumans && mightHold(s, ctx.me, o, t.get))),
  );
  if (waiting.length > 0) return null;
  noteAnswers(ctx, eligible);

  const base = ctx.scoreHand(ctx.hand);
  // From the bot's side: it gives `give` and receives `get`.
  const gain = (give: CardCounts, get: CardCounts) => ctx.scoreHand(add(sub(ctx.hand, give), get)) - base;
  const own = gain(t.give, t.get);
  let best: { action: Action; score: number } | null = null;
  for (const o of eligible) {
    const other = s.players[o].hand;
    // (As the engine checks it: both can pay, and neither ends up over a hand limit, Oil's four.)
    if (t.responses[o] === 'accepted' && hasResources(ctx.hand, t.give) && hasResources(other, t.get) && tradeFits(s, ctx.me, o, t.give, t.get)) {
      const score = own - 0.1 * ctx.seenVp[o];
      if (!best || score > best.score) best = { action: { type: 'acceptTrade', partner: o }, score };
    }
    const c = t.counters[o];
    if (c && ctx.prof.domestic && ctx.seenVp[o] < ctx.target - 2 && hasResources(ctx.hand, c.get) && hasResources(other, c.give) && tradeFits(s, ctx.me, o, c.get, c.give)) {
      const g = dealValue(ctx, o, c.get, c.give);
      const asGood = RESOURCES.every((r) => c.give[r] >= t.get[r] && c.get[r] <= t.give[r]);
      if (asGood || g > threshold(ctx, o)) {
        const score = Math.max(g, asGood ? own : -Infinity) - 0.1 * ctx.seenVp[o];
        if (!best || score > best.score) best = { action: { type: 'acceptTrade', partner: o, counter: true }, score };
      }
    }
  }
  if (best) return best.action;
  ctx.mem.refused.push({ key: countsKey(t.give) + '>' + countsKey(t.get), turn: s.turn });
  return { type: 'cancelTrade' };
}
