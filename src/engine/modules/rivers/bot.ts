// The Rivers bot: it values river spots and bridges for their coins, spends coins on the cards a
// build is short of, and minds the wealth tiles when they can decide the game. Everything else is
// the base planner's.

import type { ModuleBot } from '../api';
import { emptyCards } from '../../constants';
import { applyAction } from '../../reducer';
import { COIN_BUYS_PER_TURN, COINS_PER_RESOURCE, cardKinds, hasResources, satisfiesDistanceRule, victoryTarget } from '../../rules';
import type { Action, Card, CardCounts, GameState } from '../../types';
import { RESOURCES } from '../../types';
import { WIN_BONUS, computeReach, missingFor, type BotCtx, type BuildOption } from '../../ai/context';
import { BRIDGE_COINS, BRIDGE_COST, RIVER_COINS, legalBridges, onRiverCorner, wealthPointsWith } from './queries';

/**
 * A coin's worth in victory-point equivalents. Two buy a resource, and a resource is worth about a
 * third of a point to the planner (a settlement's four cards come to a point and a half or so).
 */
const COIN_WORTH = 0.15;
/** A bridge worth at least this much is built from cards the bot's main goal doesn't need. */
const BRIDGE_SPARE_MIN = 0.5;

const coinsOf = (ctx: BotCtx) => ctx.player.coins;

/**
 * Whether the bot is within three points of its target, not counting the wealth tiles (a Pauper
 * with eight points of buildings counts six, but is close: a coin or two could make it eight).
 */
const nearEnd = (ctx: BotCtx, target: number) => ctx.vp - wealthPointsWith(ctx.s, ctx.me, coinsOf(ctx)) + 3 >= target;

/**
 * What a point of the wealth tiles is worth to the bot. They count only when someone wins and can
 * change hands with every coin, so they matter little until the bot is near its target.
 */
const wealthWeight = (ctx: BotCtx, target: number) => (nearEnd(ctx, target) ? 1 : 0.3);

/** Points a build towards `goal` brings at once. */
function pointsOf(goal: BuildOption): number {
  if (goal.kind === 'longestRoad') return goal.value >= 2 ? 2 : 0;
  return goal.kind === 'devCard' ? 0 : goal.step.type === 'buildRoad' ? 0 : 1;
}

/** Card kinds the bank buys from this player for coins, with how many batches each could sell beyond `reserve`. */
function sellable(ctx: BotCtx, reserve: CardCounts): { kind: Card; batches: number }[] {
  const ratios = ctx.ratios as Record<Card, number>;
  const out: { kind: Card; batches: number }[] = [];
  for (const k of cardKinds(ctx.s)) {
    const ratio = ratios[k];
    if (!Number.isFinite(ratio) || ctx.mem.gotFromBank.includes(k)) continue;
    const batches = Math.floor(Math.max(0, ctx.hand[k] - reserve[k]) / ratio);
    if (batches > 0) out.push({ kind: k, batches });
  }
  return out;
}

/** Sell the batch that costs the least: the cheapest ratio of the least valued kind. */
function sell(ctx: BotCtx, options: { kind: Card; batches: number }[]): Action {
  const ratios = ctx.ratios as Record<Card, number>;
  const cost = (k: Card) => ratios[k] * (ctx.resVal[k] || 1);
  const kind = options.reduce((a, b) => (cost(b.kind) < cost(a.kind) ? b : a)).kind;
  ctx.mem.gaveToBank.push(kind);
  return { type: 'sellForCoins', give: kind, times: 1 };
}

/** The coins that would carry the bot to its target through the wealth tiles, if its cards can raise them. */
function winByWealth(ctx: BotCtx, target: number): Action | null {
  const now = wealthPointsWith(ctx.s, ctx.me, coinsOf(ctx));
  const options = sellable(ctx, emptyCards());
  const batches = options.reduce((n, o) => n + o.batches, 0);
  for (let extra = 1; extra <= Math.min(3, batches); extra++) {
    if (ctx.vp - now + wealthPointsWith(ctx.s, ctx.me, coinsOf(ctx) + extra) >= target) return sell(ctx, options);
  }
  return null;
}

/** A bridge that wins the game outright (its coins move the wealth tiles, or it takes Longest Route). */
function winningBridge(ctx: BotCtx, sites: number[]): Action | null {
  for (const edge of sites) {
    const action: Action = { type: 'rivers/buildBridge', edge };
    const r = applyAction(ctx.s, ctx.me, action);
    if (r.ok && r.state.winner === ctx.me) return action;
  }
  return null;
}

/** Spend coins on what the main goal's next step is short of, when they cover all of it this turn. */
function buyForGoal(ctx: BotCtx, target: number): Action | null {
  const s = ctx.s;
  const coins = coinsOf(ctx);
  const buys = COIN_BUYS_PER_TURN - s.coinBuys;
  if (buys <= 0 || coins < COINS_PER_RESOURCE) return null;
  const goal = ctx.rankedOptions()[0]?.option;
  if (!goal) return null;
  const miss = missingFor(ctx.hand, goal.stepCost);
  const need = RESOURCES.reduce((n, r) => n + miss[r], 0);
  if (need === 0 || need > buys || coins < need * COINS_PER_RESOURCE) return null;
  if (RESOURCES.some((r) => miss[r] > s.bank[r] || (miss[r] > 0 && ctx.mem.gaveToBank.includes(r)))) return null;
  // Near the end, don't buy into a worse wealth tile, unless the build wins the game anyway.
  const loss = wealthPointsWith(s, ctx.me, coins - need * COINS_PER_RESOURCE) - wealthPointsWith(s, ctx.me, coins);
  if (loss < 0 && nearEnd(ctx, target) && !(goal.value >= WIN_BONUS && ctx.vp + loss + pointsOf(goal) >= target)) return null;
  const get = RESOURCES.find((r) => miss[r] > 0)!;
  ctx.mem.gotFromBank.push(get);
  return { type: 'buyWithCoins', get };
}

/** Whether paying `cost` leaves every card `goal` needs (the cards it uses are spare). */
function spareFor(hand: CardCounts, cost: CardCounts, goal: CardCounts): boolean {
  return RESOURCES.every((r) => hand[r] - cost[r] >= Math.min(hand[r], goal[r]));
}

/** The best settlement spot a bridge on `edge` brings closer, as the gain in what reaching it is worth. */
function reachGain(ctx: BotCtx, edge: number): number {
  const s = ctx.s;
  const p = ctx.player;
  if (p.settlementsLeft <= 0) return 0;
  const routes = s.routes.slice();
  routes[edge] = { owner: ctx.me, kind: 'bridge', builtTurn: s.turn };
  const after = computeReach({ ...s, routes } as GameState, ctx.me);
  const before = ctx.reach(ctx.me);
  const maxD = Math.min(p.roadsLeft, ctx.prof.maxRoadDistance);
  const decay = ctx.prof.roadDecay;
  let gain = 0;
  for (let w = 0; w < s.board.vertices.length; w++) {
    // The bridge itself is a step, then `d` roads.
    const d = after.dist[w] + 1;
    if (after.dist[w] > maxD || d >= before.dist[w] || !satisfiesDistanceRule(s, w)) continue;
    const worth = ctx.prof.settlementWeight * (1 + ctx.spotValue(w));
    const now = worth * Math.pow(decay, d) * ctx.contest(w, d);
    const was = before.dist[w] <= maxD ? worth * Math.pow(decay, before.dist[w]) * ctx.contest(w, before.dist[w]) : 0;
    gain = Math.max(gain, now - was);
  }
  return gain;
}

/** What a bridge on `edge` is worth now: its coins, what they do to the wealth tiles, the route and the spots it opens. */
function bridgeValue(ctx: BotCtx, edge: number, target: number): number {
  const s = ctx.s;
  const coins = coinsOf(ctx);
  const wealth = (wealthPointsWith(s, ctx.me, coins + BRIDGE_COINS) - wealthPointsWith(s, ctx.me, coins)) * wealthWeight(ctx, target);
  const others = Math.max(0, ...ctx.opponents.map((o) => s.players[o].longestRoad));
  // (A road there would be as long as the bridge: both are the road family.)
  const route = ctx.longestRoadGain(edge, ctx.player.longestRoad, others);
  return (BRIDGE_COINS * COIN_WORTH + wealth + route + reachGain(ctx, edge)) * ctx.fuzz(edge);
}

/** Build the best bridge, when its worth beats the main goal or it uses only spare cards. */
function bridgeStep(ctx: BotCtx, sites: number[], target: number): Action | null {
  let best: { edge: number; value: number } | null = null;
  for (const edge of sites) {
    const value = bridgeValue(ctx, edge, target);
    if (!best || value > best.value) best = { edge, value };
  }
  if (!best) return null;
  const top = ctx.rankedOptions()[0];
  const spare = !top || spareFor(ctx.hand, BRIDGE_COST, top.option.cost);
  if ((spare && best.value >= BRIDGE_SPARE_MIN) || !top || best.value > top.score) return { type: 'rivers/buildBridge', edge: best.edge };
  return null;
}

/** Near the end, sell spare cards for the coin or two that lift the bot off a Pauper tile or onto the Richest. */
function guardWealth(ctx: BotCtx, target: number): Action | null {
  if (!nearEnd(ctx, target)) return null;
  const coins = coinsOf(ctx);
  const now = wealthPointsWith(ctx.s, ctx.me, coins);
  const goal = ctx.rankedOptions()[0]?.option;
  const options = sellable(ctx, goal ? goal.cost : emptyCards());
  const batches = options.reduce((n, o) => n + o.batches, 0);
  for (let extra = 1; extra <= Math.min(2, batches); extra++) {
    if (wealthPointsWith(ctx.s, ctx.me, coins + extra) > now) return sell(ctx, options);
  }
  return null;
}

export const riversBot: ModuleBot = {
  spotBonus(ctx, vertex) {
    return onRiverCorner(ctx.s, vertex) ? RIVER_COINS * COIN_WORTH : 0;
  },

  main(ctx) {
    const s = ctx.s;
    if (s.phase !== 'main' || s.currentPlayer !== ctx.me) return null;
    const target = victoryTarget(s, ctx.me);
    const sites = hasResources(ctx.hand, BRIDGE_COST) ? legalBridges(s, ctx.me) : [];
    return winByWealth(ctx, target) ?? winningBridge(ctx, sites) ?? buyForGoal(ctx, target) ?? bridgeStep(ctx, sites, target) ?? guardWealth(ctx, target);
  },
};
