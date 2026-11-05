// How a bot plays oil: it builds foundries when it can, burns oil for what its next build lacks,
// and sequesters what it doesn't need, more readily as the track climbs. It won't fill the track
// when the disaster would hurt it more than the others, nor when the island's last number is at stake.

import { PIPS, cards } from '../../constants';
import type { BotCtx } from '../../ai/context';
import { missingFor } from '../../ai/context';
import { bestInvention, bestMonopoly } from '../../ai/turn';
import { hexPips, numbersOf } from '../../rules';
import type { Action, CardCounts, Resource } from '../../types';
import { RESOURCES } from '../../types';
import type { ModuleBot } from '../api';
import { legalOil } from './actions';
import {
  BURN_YIELD,
  FOUNDRIES,
  FOUNDRY_TRACK,
  SEQUESTER_PER_POINT,
  STEWARD_AT,
  TRACK_MAX,
  canBuildFoundry,
  canSequester,
  canUseOil,
  floodsOneIsland,
  foundriesBuilt,
  foundrySites,
  isCoastal,
  oilOf,
  oilRoom,
  pollutionLimit,
} from './rules';

/** Points a bot reckons a pip of production is worth when it's lost for good. */
const PIP_WORTH = 0.08;

/**
 * What a disaster now would cost each player, in rough points: a flood's lost buildings (a sixth
 * of the time) and pollution's lost production (the rest).
 */
function disasterHarm(ctx: BotCtx): number[] {
  const s = ctx.s;
  const n = s.players.length;
  const flood = new Array<number>(n).fill(0);
  s.buildings.forEach((b, v) => {
    if (!b || !isCoastal(s, v)) return;
    if (b.kind === 'settlement') flood[b.owner] += 1;
    else if (!b.foundry && !b.seat) flood[b.owner] += b.wall ? 0.3 : 1;
  });
  // (A flood that picks one island of several hits fewer coasts.)
  const floodShare = floodsOneIsland(s) ? 1 / Math.max(1, s.board.islands.length) : 1;
  const pollution = new Array<number>(n).fill(0);
  for (let total = 2; total <= 12; total++) {
    if (total === 7) continue;
    const hit = s.board.hexes.filter((h) => numbersOf(s, h).includes(total));
    if (hit.length === 0) continue;
    const chance = PIPS[total] / 36 / hit.length;
    for (const hex of hit) {
      if (hex.well) continue;
      const lost = PIPS[total];
      for (const v of hex.vertices) {
        const b = s.buildings[v];
        if (b) pollution[b.owner] += chance * lost * (b.kind === 'city' ? (b.foundry ? 3 : 2) : 1) * PIP_WORTH;
      }
    }
  }
  return flood.map((f, p) => (1 / 6) * f * floodShare + pollution[p]);
}

/** Whether moving the track by `step` is all right for this bot: below the top, or a disaster it can live with. */
export function disasterAcceptable(ctx: BotCtx, step: number): boolean {
  const s = ctx.s;
  const st = oilOf(s);
  if (st.track + step < TRACK_MAX) return true;
  // (Greedy bots, the easy ones, don't count the cost to the island: they play for themselves.)
  if (st.lost.length >= pollutionLimit(s) - 1 && !ctx.prof.greedy) return false;
  const harm = disasterHarm(ctx);
  const others = ctx.opponents.map((o) => harm[o]);
  const avg = others.reduce((a, b) => a + b, 0) / Math.max(1, others.length);
  return harm[ctx.me] <= avg + 0.15;
}

/** Whether a foundry is still in reach this cycle of the track (a city for it, a piece left, room on the track). */
function foundryHope(ctx: BotCtx): boolean {
  const s = ctx.s;
  return foundriesBuilt(s) < FOUNDRIES && foundrySites(s, ctx.me).length > 0 && oilOf(s).track + FOUNDRY_TRACK <= TRACK_MAX;
}

/** Burns needed to cover `missing`, each giving two of one resource, or Infinity if the supply can't. */
function burnsFor(ctx: BotCtx, missing: CardCounts): number {
  let n = 0;
  for (const r of RESOURCES) {
    if (missing[r] <= 0) continue;
    const k = Math.ceil(missing[r] / BURN_YIELD);
    if (ctx.s.bank[r] < k * BURN_YIELD) return Infinity;
    n += k;
  }
  return n;
}

/** The resource to burn for first: the one most missing (then the most valuable). */
function burnTarget(ctx: BotCtx, missing: CardCounts): Resource | null {
  let best: Resource | null = null;
  for (const r of RESOURCES) {
    if (missing[r] <= 0 || ctx.s.bank[r] < BURN_YIELD) continue;
    if (!best || missing[r] > missing[best] || (missing[r] === missing[best] && ctx.resVal[r] > ctx.resVal[best])) best = r;
  }
  return best;
}

const FOUNDRY_RESOURCES = cards({ brick: 1, wheat: 1, ore: 1 });

/** A burn that completes something worth building now: a foundry, or the bot's next build. */
function burnAction(ctx: BotCtx): Action | null {
  const s = ctx.s;
  const st = oilOf(s);
  const oil = ctx.hand.oil;
  if (oil === 0 || !canUseOil(s, ctx.me, 1)) return null;
  const hope = foundryHope(ctx);
  // Burning towards a foundry leaves its two oil, and the track room for them.
  if (hope && oil > 2) {
    const missing = missingFor(ctx.hand, FOUNDRY_RESOURCES);
    const k = burnsFor(ctx, missing);
    if (k >= 1 && k <= oil - 2 && st.track + k + FOUNDRY_TRACK <= TRACK_MAX && disasterAcceptable(ctx, k + FOUNDRY_TRACK)) {
      const r = burnTarget(ctx, missing);
      if (r) return { type: 'oil/burn', get: r };
    }
  }
  const goal = ctx.rankedOptions()[0]?.option;
  if (!goal) return null;
  const missing = missingFor(ctx.hand, goal.stepCost);
  const k = burnsFor(ctx, missing);
  // Two oil are kept back while a foundry is in reach.
  const spare = hope ? oil - 2 : oil;
  if (k < 1 || k > spare || st.track + k > TRACK_MAX || !disasterAcceptable(ctx, k)) return null;
  const r = burnTarget(ctx, missing);
  return r ? { type: 'oil/burn', get: r } : null;
}

function wantsToSequester(ctx: BotCtx): boolean {
  const s = ctx.s;
  if (!canSequester(s, ctx.me)) return false;
  const st = oilOf(s);
  const mine = st.sequestered[ctx.me];
  const point = (mine + 1) % SEQUESTER_PER_POINT === 0;
  const steward = mine + 1 >= STEWARD_AT && st.steward !== ctx.me && (st.steward === null || mine + 1 > st.sequestered[st.steward]);
  if (point || steward) return true;
  // Oil for a foundry is worth more than its share of a point.
  if (foundryHope(ctx) && ctx.hand.oil <= 2) return false;
  return st.track >= 3 || ctx.hand.oil >= 3;
}

/** What a card of oil is worth in the hand score's units: a third of a sequestered point, or two cards burned. */
const OIL_WORTH = 0.35;

/**
 * A Monopoly or an Invention played for oil rather than for resources: when the oil it brings is
 * worth more than the best the plain card would do (the plain card is then kept for later).
 */
function oilCard(ctx: BotCtx): Action | null {
  const s = ctx.s;
  const legal = legalOil(s, ctx.me);
  const hope = foundryHope(ctx) ? 1.15 : 1;
  if (legal.some((a) => a.type === 'oil/monopoly')) {
    const taken = Math.min(oilRoom(s, ctx.me), ctx.opponents.reduce((n, o) => n + s.players[o].hand.oil, 0));
    const score = OIL_WORTH * hope * taken;
    const plain = bestMonopoly(ctx);
    // (The plain card is played at four cards and up: the oil must beat that, or the plain card's own bar.)
    if (taken >= 2 && score >= 0.7 && (!plain || plain.taken < ctx.prof.monopolyMin || score > plain.score)) return { type: 'oil/monopoly' };
  }
  const base = ctx.scoreHand(ctx.hand);
  const plain = bestInvention(ctx);
  let best: { action: Action; gain: number } | null = null;
  for (const a of legal) {
    if (a.type !== 'oil/invention') continue;
    const h = { ...ctx.hand };
    let oil = 0;
    for (const c of a.cards) {
      if (c === 'oil') oil++;
      else h[c]++;
    }
    const gain = ctx.scoreHand(h) - base + OIL_WORTH * hope * oil;
    if (!best || gain > best.gain) best = { action: a, gain };
  }
  if (best && best.gain >= 0.5 && (!plain || best.gain > plain.gain)) return best.action;
  return null;
}

export const oilBot: ModuleBot = {
  main(ctx) {
    const s = ctx.s;
    if (s.phase !== 'main' || s.currentPlayer !== ctx.me) return null;
    if (canBuildFoundry(s, ctx.me) && disasterAcceptable(ctx, FOUNDRY_TRACK)) {
      let best = -1;
      let bestValue = -Infinity;
      for (const v of foundrySites(s, ctx.me)) {
        let value = 0;
        for (const h of s.board.vertices[v].hexes) value += hexPips(s, s.board.hexes[h]);
        if (value > bestValue) {
          bestValue = value;
          best = v;
        }
      }
      if (best >= 0) return { type: 'oil/foundry', vertex: best };
    }
    const burn = burnAction(ctx);
    if (burn) return burn;
    if (wantsToSequester(ctx)) return { type: 'oil/sequester' };
    return oilCard(ctx);
  },
};
