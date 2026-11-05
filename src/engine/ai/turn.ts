// The bot's own turn: optional Knight before rolling, then the Action phase planner.

import { LARGEST_ARMY_MIN } from '../constants';
import { inventionOptions } from '../actions';
import { hasResources, legalRobberHexes, legalRoads, playableDevCards, totalCards } from '../rules';
import type { Action, DevCardType, Resource } from '../types';
import { RESOURCES } from '../types';
import { roadLengthWith, type BotCtx, type BuildOption } from './context';
import { ownBlockedPips, robberHexScore } from './robber';
import { winningMove } from './search';
import { bankAction, bankPlan, proposeOffer } from './trade';

function playable(ctx: BotCtx): Set<DevCardType> {
  return new Set(playableDevCards(ctx.s, ctx.me).map((c) => c.type));
}

/** Would one more Knight take Biggest Army for this bot? */
function knightTakesArmy(ctx: BotCtx): boolean {
  const s = ctx.s;
  if (s.largestArmyHolder === ctx.me) return false;
  const mine = ctx.player.playedKnights + 1;
  const holderKnights = s.largestArmyHolder === null ? LARGEST_ARMY_MIN - 1 : s.players[s.largestArmyHolder].playedKnights;
  return mine > holderKnights;
}

function shouldPlayKnight(ctx: BotCtx, beforeRoll: boolean): boolean {
  const takesArmy = knightTakesArmy(ctx);
  if (takesArmy && ctx.vp + 2 >= ctx.target) return true;
  const blocked = ownBlockedPips(ctx);
  if (ctx.prof.greedy) return blocked >= 3 && ctx.rng.next() < 0.5;
  if (blocked >= 2) return true;
  if (takesArmy) return true;
  // Keep the army race alive and punish the leader when the robber move is strong.
  // (Where the robber may actually go: not the sea, a wasted hex, or beside a spared player.)
  const bestMove = Math.max(-Infinity, ...legalRobberHexes(ctx.s).map((h) => robberHexScore(ctx, h)));
  if (bestMove >= ctx.prof.knightMoveThreshold) return true;
  if (ctx.prof.knightRace && !beforeRoll) {
    const knightsInHand = ctx.player.devCards.filter((c) => c.type === 'knight').length;
    const maxOpp = Math.max(0, ...ctx.opponents.map((o) => ctx.s.players[o].playedKnights));
    if (knightsInHand >= 2 || maxOpp >= ctx.player.playedKnights + 1) return bestMove >= 4;
  }
  return false;
}

export function rollPhase(ctx: BotCtx): Action {
  if (!ctx.s.devCardPlayedThisTurn && playable(ctx).has('knight') && shouldPlayKnight(ctx, true)) return { type: 'playKnight' };
  return { type: 'rollDice' };
}

/** Best road to place for free (Road Crew) or null if none is legal. */
export function chooseFreeRoad(ctx: BotCtx): Action {
  const s = ctx.s;
  const win = ctx.prof.winSearch ? winningMove(ctx) : null;
  if (win) return win;
  const roads = legalRoads(s, ctx.me);
  if (roads.length === 0 || ctx.player.roadsLeft <= 0) return { type: 'skipFreeRoads' };
  let best: { edge: number; value: number } | null = null;
  for (const o of ctx.options()) {
    if (o.step.type !== 'buildRoad') continue;
    if (!best || o.value > best.value) best = { edge: o.step.edge, value: o.value };
  }
  if (best) return { type: 'placeFreeRoad', edge: best.edge };
  // Nothing to aim for: lengthen the longest route.
  let edge = roads[0];
  let len = -1;
  for (const e of roads) {
    const l = roadLengthWith(s, ctx.me, e);
    if (l > len) {
      len = l;
      edge = e;
    }
  }
  return { type: 'placeFreeRoad', edge };
}

function roadBuildingUseful(ctx: BotCtx): boolean {
  if (legalRoads(ctx.s, ctx.me).length === 0) return false;
  return ctx.options().some((o) => (o.kind === 'settlement' && (o.dist ?? 0) >= 1 && (o.dist ?? 0) <= 2) || (o.kind === 'longestRoad' && o.value >= 0.45));
}

/** The two resources an Invention would be best to name, and the hand score they add. */
export function bestInvention(ctx: BotCtx): { res: Resource[]; gain: number } | null {
  // (With an empty supply the card would bring nothing: keep it.)
  if (totalCards(ctx.s.bank) === 0) return null;
  const base = ctx.scoreHand(ctx.hand);
  let best: { res: Resource[]; gain: number } | null = null;
  for (const res of inventionOptions(ctx.s.bank)) {
    const h = { ...ctx.hand };
    for (const r of res) h[r]++;
    const gain = ctx.scoreHand(h) - base;
    if (!best || gain > best.gain) best = { res, gain };
  }
  return best;
}

function inventionChoice(ctx: BotCtx): Resource[] | null {
  const best = bestInvention(ctx);
  if (!best) return null;
  const card = ctx.player.devCards.find((c) => c.type === 'invention' && c.boughtTurn < ctx.s.turn);
  const heldLong = !!card && ctx.s.turn - card.boughtTurn >= 6;
  if (ctx.prof.greedy || best.gain >= 0.25 || heldLong) return best.res;
  return null;
}

/** The resource a Monopoly would be best to name, with its worth (the hand score it adds, and a little for the cards) and the cards it should take. */
export function bestMonopoly(ctx: BotCtx): { r: Resource; score: number; taken: number } | null {
  const base = ctx.scoreHand(ctx.hand);
  let best: { r: Resource; score: number; taken: number } | null = null;
  for (const r of RESOURCES) {
    // What the bot can know: the card tracker's expected counts, not the hidden hands.
    const taken = ctx.opponents.reduce((n, o) => n + ctx.estimate(o).expected[r], 0);
    const h = { ...ctx.hand, [r]: ctx.hand[r] + taken };
    const gain = ctx.scoreHand(h) - base;
    const score = ctx.prof.greedy ? taken : gain + 0.12 * taken + (0.15 * taken) / ctx.ratios[r];
    if (!best || score > best.score) best = { r, score, taken };
  }
  return best;
}

function monopolyChoice(ctx: BotCtx): Resource | null {
  const best = bestMonopoly(ctx);
  if (!best) return null;
  if (ctx.prof.greedy) return best.taken >= ctx.prof.monopolyMin - 1e-6 ? best.r : null;
  return best.taken >= ctx.prof.monopolyMin - 1e-6 || (best.taken >= 2 && best.score >= 0.6) ? best.r : null;
}

function devCardPlay(ctx: BotCtx): Action | null {
  if (ctx.s.devCardPlayedThisTurn) return null;
  const types = playable(ctx);
  if (types.size === 0) return null;
  if (types.has('knight') && shouldPlayKnight(ctx, false)) return { type: 'playKnight' };
  if (types.has('monopoly')) {
    const r = monopolyChoice(ctx);
    if (r) return { type: 'playMonopoly', resource: r };
  }
  if (types.has('invention')) {
    const res = inventionChoice(ctx);
    if (res) return { type: 'playInvention', resources: res };
  }
  if (types.has('roadBuilding') && roadBuildingUseful(ctx)) return { type: 'playRoadBuilding' };
  return null;
}

/** Can `option`'s next step be paid without touching cards reserved for `goal`? */
function affordableAround(ctx: BotCtx, option: BuildOption, goal: BuildOption): boolean {
  for (const r of RESOURCES) {
    const have = ctx.hand[r];
    if (have < option.stepCost[r]) return false;
    if (have - option.stepCost[r] < Math.min(have, goal.cost[r])) return false;
  }
  return true;
}

function tradeTowards(ctx: BotCtx, goal: BuildOption): Action | null {
  if (ctx.mem.bankTrades >= ctx.prof.bankTrades) return proposeOffer(ctx, goal);
  const plan = bankPlan(ctx, goal.stepCost, goal.cost) ?? bankPlan(ctx, goal.stepCost, goal.stepCost);
  if (plan && plan.length > 0 && plan.every((p) => p.ratio <= 2)) return bankAction(plan[0]);
  const offer = proposeOffer(ctx, goal);
  if (offer) return offer;
  if (plan && plan.length > 0) return bankAction(plan[0]);
  return null;
}

/** With a big hand and nothing to build, convert surplus into what the goal needs (limits 7 losses). */
function dumpBigHand(ctx: BotCtx, goal: BuildOption | undefined): Action | null {
  if (!goal || totalCards(ctx.hand) < ctx.prof.dumpAt || ctx.mem.bankTrades >= ctx.prof.bankTrades) return null;
  for (const r of RESOURCES) {
    if (ctx.hand[r] >= goal.cost[r] || ctx.s.bank[r] < 1 || ctx.mem.gaveToBank.includes(r)) continue;
    for (const g of RESOURCES) {
      if (g === r || ctx.mem.gotFromBank.includes(g)) continue;
      if (ctx.hand[g] - goal.cost[g] >= ctx.ratios[g]) return { type: 'bankTrade', give: g, get: r, times: 1 };
    }
  }
  return null;
}

export function mainPhase(ctx: BotCtx): Action {
  const win = ctx.prof.winSearch ? winningMove(ctx) : null;
  if (win) return win;
  const dev = devCardPlay(ctx);
  if (dev) return dev;

  const ranked = ctx.rankedOptions();
  const goal = ranked[0]?.option;

  if (ctx.prof.greedy) {
    // Greedy: build the most attractive thing that is affordable right now.
    const affordable = ranked.find((x) => hasResources(ctx.hand, x.option.stepCost));
    if (affordable) return affordable.option.step;
    if (goal) {
      const t = tradeTowards(ctx, goal);
      if (t) return t;
    }
    return { type: 'endTurn' };
  }

  if (goal) {
    if (hasResources(ctx.hand, goal.stepCost)) return goal.step;
    const t = tradeTowards(ctx, goal);
    if (t) return t;
    for (const { option } of ranked.slice(1)) {
      if (affordableAround(ctx, option, goal)) return option.step;
    }
    const dump = dumpBigHand(ctx, goal);
    if (dump) return dump;
    if (totalCards(ctx.hand) > ctx.prof.spendAbove) {
      const any = ranked.find((x) => hasResources(ctx.hand, x.option.stepCost));
      if (any) return any.option.step;
    }
  }
  return { type: 'endTurn' };
}

