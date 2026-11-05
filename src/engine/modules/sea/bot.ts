// Sea Lanes' bot: it sails for islets, first landings, bounty fields and (on a fog map) the face-down
// hexes, shifts a loose ship forward when that saves building one, picks its bounty to suit its
// plans, and chooses between the robber and the corsair. Everything it reads is public, or its own.

import { COSTS, emptyCards } from '../../constants';
import { memo, Query } from '../../memo';
import { WIN_BONUS, add, type BotCtx } from '../../ai/context';
import { ownBlockedPips, robberHexScore } from '../../ai/robber';
import { bankAction, bankPlan } from '../../ai/trade';
import {
  breaksRoute,
  hasResources,
  hexPips,
  legalRoads,
  legalRobberHexes,
  legalSettlements,
  longestRoadFor,
  placeAllowed,
  satisfiesDistanceRule,
  stealCandidates,
  totalCards,
  vertexConnects,
} from '../../rules';
import type { Action, CardCounts, GameState, Pending, PlayerId } from '../../types';
import { RESOURCES } from '../../types';
import type { ModuleBot } from '../api';
import { BOUNTY_PICK, pickOptions, pickSize } from './bounty';
import { BLOCKER, type BlockerPending } from './handle';
import {
  FIRST_LANDING_POINTS,
  SHIP_COST,
  canMoveShip,
  corsairHexes,
  corsairVictims,
  isHidden,
  isLegalMove,
  isLegalShip,
  islandOf,
  legalSetupShips,
  legalShips,
  seaState,
  shipSite,
  withoutRoute,
} from './rules';

const INF = 1 << 20;
/** Value kept per ship still to build on the way to a target. */
const SHIP_DECAY = 0.85;
/** The furthest target considered, in ships. */
const MAX_SHIPS = 6;
/** What finding a face-down hex is worth: a card most of the time, and new numbers to settle on. */
const FIND_VALUE = 1.0;
/** What a corner beside face-down hexes is worth as a place to settle once they're found. */
const PROSPECT_VALUE = 1.0;

interface Reach {
  dist: number[];
  first: number[];
}

/**
 * Multi-source BFS over edges a ship of `player`'s could take, from everything they can sail out of.
 * (The plan and the lanes ask it of the same state, so a bot's decision works it out once.)
 */
function shipReach(s: GameState, player: PlayerId): Reach {
  return memo(s, Query.ShipReach, player, () => sail(s, player));
}

function sail(s: GameState, player: PlayerId): Reach {
  const n = s.board.vertices.length;
  const dist = new Array<number>(n).fill(INF);
  const first = new Array<number>(n).fill(-1);
  const site = new Map<number, boolean>();
  const open = (e: number) => {
    let ok = site.get(e);
    if (ok === undefined) {
      ok = shipSite(s, e) && placeAllowed(s, player, 'ship', e);
      site.set(e, ok);
    }
    return ok;
  };
  const queue: number[] = [];
  for (let v = 0; v < n; v++) {
    if (vertexConnects(s, player, v, 'sea')) {
      dist[v] = 0;
      queue.push(v);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi];
    // A lane can't run on past someone else's building.
    if (dist[v] > 0 && (s.buildings[v] || breaksRoute(s, player, v))) continue;
    for (const e of s.board.vertices[v].edges) {
      const ed = s.board.edges[e];
      const u = ed.a === v ? ed.b : ed.a;
      if (dist[u] <= dist[v] + 1 || !open(e)) continue;
      dist[u] = dist[v] + 1;
      first[u] = dist[v] === 0 ? e : first[v];
      queue.push(u);
    }
  }
  return { dist, first };
}

/** First Landing's worth of settling `v`: the points, if it's an island the bot hasn't landed on yet. */
function landingValue(ctx: BotCtx, v: number): number {
  const s = ctx.s;
  const landed = seaState(s).landed?.[ctx.me];
  if (!landed) return 0;
  const island = islandOf(s, v);
  if (island < 0 || s.board.islands[island].home || landed.includes(island)) return 0;
  return FIRST_LANDING_POINTS + (ctx.vp + 1 + FIRST_LANDING_POINTS >= ctx.target ? WIN_BONUS : 0);
}

/** A bounty field's worth at `v`, valued as its pips of whatever resource the bot wants most. */
function bountyValue(ctx: BotCtx, v: number): number {
  const s = ctx.s;
  const best = Math.max(...RESOURCES.map((r) => ctx.resVal[r]));
  let val = 0;
  for (const h of s.board.vertices[v].hexes) {
    const hex = s.board.hexes[h];
    if (hex.terrain === 'bounty' && !isHidden(s, h)) val += hexPips(s, hex) * best * 1.3 * (h === s.robberHex ? 0.7 : 1);
  }
  return 0.1 * val;
}

/** A settlement at `v`, as the bot sees it: the base worth (a first landing among it), plus bounty fields. */
function settleValue(ctx: BotCtx, v: number): number {
  return ctx.prof.settlementWeight * (1 + ctx.spotValue(v)) + bountyValue(ctx, v);
}

/** What a route ending at `v` would find: the face-down hexes it turns up, and a place to settle among them. */
function findValue(ctx: BotCtx, v: number): number {
  const s = ctx.s;
  let k = 0;
  for (const h of s.board.vertices[v].hexes) if (isHidden(s, h)) k++;
  if (k === 0) return 0;
  const prospect = ctx.player.settlementsLeft > 0 && satisfiesDistanceRule(s, v) ? PROSPECT_VALUE : 0;
  return FIND_VALUE * k + prospect;
}

interface ShipPlan {
  target: number;
  dist: number;
  first: number;
  value: number;
  score: number;
}

const times = (c: CardCounts, k: number) => add(emptyCards(), c, k);

/** The best place to sail for now, scored like the base planner's options, or null. */
function shipPlan(ctx: BotCtx): ShipPlan | null {
  const s = ctx.s;
  const me = ctx.me;
  const left = seaState(s).shipsLeft[me];
  if (left <= 0) return null;
  const reach = shipReach(s, me);
  const roads = ctx.reach(me).dist;
  const canSettle = ctx.player.settlementsLeft > 0;
  let best: ShipPlan | null = null;
  for (let v = 0; v < s.board.vertices.length; v++) {
    const d = reach.dist[v];
    if (d < 1 || d > Math.min(left, MAX_SHIPS)) continue;
    let value = 0;
    let cost = times(SHIP_COST, d);
    if (canSettle && roads[v] > d && satisfiesDistanceRule(s, v) && placeAllowed(s, me, 'settlement', v)) {
      value = settleValue(ctx, v);
      cost = add(cost, COSTS.settlement);
    }
    const find = findValue(ctx, v);
    if (find > value) {
      value = find;
      cost = times(SHIP_COST, d);
    }
    if (value <= 0) continue;
    const score = ((value * Math.pow(SHIP_DECAY, d)) / (1 + ctx.prof.waitDiscount * ctx.rounds(cost))) * ctx.fuzz(v);
    if (!best || score > best.score) best = { target: v, dist: d, first: reach.first[v], value, score };
  }
  return best;
}

/** A loose ship that isn't on the way, moved onto the way: one ship nearer for nothing. */
function shiftShip(ctx: BotCtx, plan: ShipPlan): Action | null {
  const s = ctx.s;
  const me = ctx.me;
  if (seaState(s).movedTurn[me] === s.turn) return null;
  const before = longestRoadFor(s, me);
  for (let from = 0; from < s.routes.length; from++) {
    const r = s.routes[from];
    if (!r || r.kind !== 'ship' || r.owner !== me || !canMoveShip(s, me, from)) continue;
    const lifted = withoutRoute(s, from);
    const reach = shipReach(lifted, me);
    if (reach.dist[plan.target] > plan.dist) continue;
    const to = reach.first[plan.target];
    if (to < 0 || !isLegalMove(s, me, from, to)) continue;
    // Not at the cost of the route the bot has built up.
    const routes = lifted.routes.slice();
    routes[to] = r;
    if (longestRoadFor({ ...s, routes }, me) < before && (before >= 4 || s.longestRoadHolder === me)) continue;
    return { type: 'sea/moveShip', from, to };
  }
  return null;
}

/** A settlement worth more than the base planner sees: a first landing or a bounty field, affordable now. */
function landNow(ctx: BotCtx): Action | null {
  if (!hasResources(ctx.hand, COSTS.settlement)) return null;
  let best: { v: number; value: number } | null = null;
  for (const v of legalSettlements(ctx.s, ctx.me)) {
    if (landingValue(ctx, v) <= 0 && bountyValue(ctx, v) <= 0.2) continue;
    const value = settleValue(ctx, v);
    if (!best || value > best.value) best = { v, value };
  }
  return best ? { type: 'buildSettlement', vertex: best.v } : null;
}

/** Whether a ship can be paid for without touching the cards `goal` will need. */
function spareShip(ctx: BotCtx, goal: CardCounts): boolean {
  return RESOURCES.every((r) => ctx.hand[r] >= SHIP_COST[r] && ctx.hand[r] - SHIP_COST[r] >= Math.min(ctx.hand[r], goal[r]));
}

function main(ctx: BotCtx): Action | null {
  const land = landNow(ctx);
  if (land) return land;
  const plan = shipPlan(ctx);
  if (!plan) return null;
  // Sailing on costs nothing when a loose ship can be shifted.
  const shift = shiftShip(ctx, plan);
  if (shift) return shift;
  // Otherwise when sailing beats the best thing the base planner has in mind, or out of cards that
  // goal doesn't need.
  const top = ctx.rankedOptions()[0];
  if (top && top.score > plan.score) return plan.score >= 0.4 * top.score && spareShip(ctx, top.option.cost) ? { type: 'sea/buildShip', edge: plan.first } : null;
  if (hasResources(ctx.hand, SHIP_COST)) return { type: 'sea/buildShip', edge: plan.first };
  if (ctx.mem.bankTrades >= ctx.prof.bankTrades) return null;
  const trade = bankPlan(ctx, SHIP_COST, SHIP_COST);
  if (trade && trade.length > 0 && trade.every((t) => t.ratio <= 3)) return bankAction(trade[0]);
  return null;
}

/**
 * The opening piece: a ship instead of the road, when it points at a first landing, a bounty
 * field or the fog within three ships and that is worth more than the road's best spot (both
 * discounted like any goal: by the pieces and the waiting they need).
 */
function setupShip(ctx: BotCtx, roadScore: number): Action | null {
  const s = ctx.s;
  const ships = legalSetupShips(s);
  if (ships.length === 0) return null;
  const reach = shipReach(s, ctx.me);
  const worth = (d: number, value: number) => (value * Math.pow(SHIP_DECAY, d)) / (1 + ctx.prof.waitDiscount * (1.2 * d + 1.5));
  // (The road's score is in set-up's pip units; a tenth of it is about what the spot adds to a point.)
  const road = worth(1, 1 + 0.1 * roadScore);
  let best: { edge: number; score: number } | null = null;
  for (let v = 0; v < s.board.vertices.length; v++) {
    const d = reach.dist[v];
    if (d < 1 || d > 3 || !ships.includes(reach.first[v])) continue;
    const settles = satisfiesDistanceRule(s, v) && placeAllowed(s, ctx.me, 'settlement', v);
    const special = landingValue(ctx, v) > 0 || bountyValue(ctx, v) > 0.2;
    const value = Math.max(settles && special ? settleValue(ctx, v) : 0, findValue(ctx, v));
    if (value <= 0) continue;
    const score = worth(d, value) * ctx.fuzz(v);
    if (!best || score > best.score) best = { edge: reach.first[v], score };
  }
  return best && best.score > road ? { type: 'sea/placeSetupShip', edge: best.edge } : null;
}

/** Road Crew: a free ship when sailing is the better use, or when no road fits. */
function freeRoute(ctx: BotCtx): Action | null {
  const s = ctx.s;
  const ships = legalShips(s, ctx.me);
  if (ships.length === 0) return null;
  const roads = ctx.player.roadsLeft > 0 ? legalRoads(s, ctx.me) : [];
  const plan = shipPlan(ctx);
  if (plan && (roads.length === 0 || plan.score >= (ctx.rankedOptions()[0]?.score ?? 0))) return { type: 'sea/placeFreeShip', edge: plan.first };
  if (roads.length > 0) return null;
  // Nothing to aim for and no road fits: lengthen the route.
  let edge = ships[0];
  let len = -1;
  for (const e of ships) {
    const routes = s.routes.slice();
    routes[e] = { owner: ctx.me, kind: 'ship', builtTurn: s.turn };
    const l = longestRoadFor({ ...s, routes }, ctx.me);
    if (l > len) {
      len = l;
      edge = e;
    }
  }
  return { type: 'sea/placeFreeShip', edge };
}

/** The robber on `h`: the base bot's judgement, with a bounty field valued as its best resource. */
function robberScore(ctx: BotCtx, h: number): number {
  const s = ctx.s;
  const hex = s.board.hexes[h];
  if (hex.terrain !== 'bounty') return robberHexScore(ctx, h);
  const value = Math.max(...RESOURCES.map((r) => ctx.resVal[r]));
  const pips = hexPips(s, hex);
  let score = 0;
  for (const v of hex.vertices) {
    const b = s.buildings[v];
    if (!b) continue;
    const mult = b.kind === 'city' ? 2 : 1;
    score += b.owner === ctx.me ? -(pips * mult * 1.5 + 2) - 30 : pips * mult * value * ctx.threat(b.owner);
  }
  const victims = stealCandidates(s, h, ctx.me);
  if (victims.length > 0) score += 1.5 + 0.15 * Math.max(...victims.map((o) => Math.min(10, totalCards(s.players[o].hand))));
  return score;
}

/** A rival's lane: how far their ships are from somewhere worth reaching (a first landing, or the fog). */
interface Lane {
  player: PlayerId;
  dist: number[];
  goals: number[];
  /** Ships still needed to reach the nearest goal. */
  need: number;
}

/** Ships a rival needs before a goal counts as a lane worth closing. */
const LANE_REACH = 3;

/** `player`'s lane toward their nearest goal, where they're close to one. */
function laneOf(s: GameState, player: PlayerId): Lane | null {
  const st = seaState(s);
  if (st.shipsLeft[player] <= 0) return null;
  const { dist } = shipReach(s, player);
  const goals: number[] = [];
  for (let v = 0; v < dist.length; v++) {
    if (dist[v] < 1 || dist[v] > LANE_REACH) continue;
    // (What lies under the fog stays unknown: a corner beside it is a goal for what it may turn up.)
    if (s.board.vertices[v].hexes.some((h) => isHidden(s, h))) {
      goals.push(v);
      continue;
    }
    const island = islandOf(s, v);
    if (st.landed && island >= 0 && !s.board.islands[island].home && !st.landed[player].includes(island) && satisfiesDistanceRule(s, v)) goals.push(v);
  }
  return goals.length > 0 ? { player, dist, goals, need: Math.min(...goals.map((v) => dist[v])) } : null;
}

/** Each rival's lane toward their nearest goal, where they're close to one. */
export function rivalLanes(ctx: BotCtx): Lane[] {
  const out: Lane[] = [];
  for (const o of ctx.opponents) {
    const lane = laneOf(ctx.s, o);
    if (lane) out.push(lane);
  }
  return out;
}

/** Extra ships the corsair on `h` would cost a rival on their way to their nearest goal (at most 2). */
function laneDelay(s: GameState, h: number, lane: Lane): number {
  if (!s.board.hexes[h].vertices.some((v) => lane.dist[v] <= lane.need)) return 0;
  const moved: GameState = { ...s, ext: { ...s.ext, sea: { ...seaState(s), corsair: h } } };
  const { dist } = shipReach(moved, lane.player);
  return Math.min(2, Math.min(...lane.goals.map((v) => dist[v])) - lane.need);
}

/**
 * What the corsair on `hex` costs the bot, in corsairScore's units: its ships there that can't
 * move, the open edges beside them it can't build on, and the ships it adds to the bot's way to
 * its nearest goal.
 */
export function corsairBurden(ctx: BotCtx, hex: number): number {
  const s = ctx.s;
  const clear: GameState = { ...s, ext: { ...s.ext, sea: { ...seaState(s), corsair: null } } };
  let cost = 0;
  for (const e of s.board.hexes[hex].edges) {
    const r = s.routes[e];
    if (r?.kind === 'ship' && r.owner === ctx.me) cost += 1.5;
    else if (!r && isLegalShip(clear, ctx.me, e)) cost += 1.5;
  }
  const lane = laneOf(clear, ctx.me);
  if (lane) cost += 3 * laneDelay(clear, hex, lane);
  return cost;
}

/** The corsair on `h`: theft from a ship owner, and the lanes it closes, chiefly the leader's; never the bot's own. */
export function corsairScore(ctx: BotCtx, h: number, victims: 'ships' | 'anyone', lanes: Lane[]): number {
  const s = ctx.s;
  const hex = s.board.hexes[h];
  let score = 0;
  for (const lane of lanes) score += 3 * ctx.threat(lane.player) * laneDelay(s, h, lane);
  for (const e of hex.edges) {
    const r = s.routes[e];
    // A ship under it can't move off; an open edge beside someone's lane can't be built on.
    if (r?.kind === 'ship') score += r.owner === ctx.me ? -1.5 : 0.5 * ctx.threat(r.owner);
    if (!r) {
      if (isLegalShip(s, ctx.me, e)) score -= 1.5;
      for (const o of ctx.opponents) if (isLegalShip(s, o, e)) score += 2 * ctx.threat(o);
    }
  }
  if (victims === 'ships') {
    const vs = corsairVictims(s, h, ctx.me);
    if (vs.length > 0) score += 1.5 + 0.15 * Math.max(...vs.map((o) => Math.min(10, totalCards(s.players[o].hand))));
  }
  return score;
}

function blocker(ctx: BotCtx, p: Pending): Action | null {
  const data = p.data as BlockerPending;
  const s = ctx.s;
  let best: Action | null = null;
  let bestScore = -Infinity;
  const consider = (action: Action, score: number) => {
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  };
  // Moving the robber also frees whatever of the bot's it sits on now; the corsair leaves it there.
  const blocked = ownBlockedPips(ctx);
  const relief = blocked > 0 ? blocked * 1.5 + 2 : 0;
  if (data.robber) for (const h of legalRobberHexes(s)) consider({ type: 'sea/moveRobber', hex: h }, robberScore(ctx, h) + relief);
  const lanes = rivalLanes(ctx);
  for (const h of corsairHexes(s)) consider({ type: 'sea/moveCorsair', hex: h }, corsairScore(ctx, h, data.victims, lanes));
  return best;
}

/** A bounty pick: whatever leaves the hand best placed for the bot's plans. */
function bountyPick(ctx: BotCtx, p: Pending): Action {
  const size = pickSize(ctx.s, p);
  let best: { pick: (typeof RESOURCES)[number][]; score: number } | null = null;
  for (const pick of pickOptions(ctx.s.bank, size)) {
    const hand = { ...ctx.hand };
    for (const r of pick) hand[r]++;
    const score = ctx.scoreHand(hand) + 0.01 * pick.reduce((n, r) => n + ctx.resVal[r], 0);
    if (!best || score > best.score) best = { pick, score };
  }
  return { type: 'sea/pickBounty', resources: best?.pick ?? [] };
}

export const seaBot: ModuleBot = {
  // A first landing counts wherever a settlement is weighed: the base planner then saves and
  // trades for one the bot's ships already reach, as for any other settlement.
  spotBonus: landingValue,
  pending(ctx, p) {
    if (p.kind === BLOCKER) return blocker(ctx, p);
    if (p.kind === BOUNTY_PICK) return bountyPick(ctx, p);
    return null;
  },
  main,
  freeRoute,
  setupRoute: setupShip,
};
