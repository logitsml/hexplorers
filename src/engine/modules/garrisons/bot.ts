// The garrisons' bot: walls when the hand runs big, and wardens raised, promoted and mustered
// ahead of the fleet (it watches how far the fleet still has to sail and whether the bot would be
// among the least defenders). Under Invasion it raises, promotes and musters them where the
// raiders press on its buildings, weighing each against the best build its cards could make. A
// warden that can chases the robber off the bot's own hexes, or the corsair off its lanes and
// fishing grounds. Every action comes from the module's own legal list.

import { COSTS, LONGEST_ROAD_MIN, isLand } from '../../constants';
import { handLimit } from '../../reducer';
import { hexPips, longestRoadFor, satisfiesDistanceRule, totalCards } from '../../rules';
import type { Action, CardCounts, GameState, Pending, PlayerId, Warden } from '../../types';
import { RESOURCES } from '../../types';
import { WIN_BONUS, type BotCtx, type BuildOption } from '../../ai/context';
import { robberHexScore } from '../../ai/robber';
import { bankAction, bankPlan, proposeOffer } from '../../ai/trade';
import type { ModuleBot } from '../api';
import { FLEET_STEPS, fleetStrength, pillageable } from '../fleet';
import { inv, prisonersPerPoint } from '../invasion/raids';
import { edgesWithin, topology } from '../invasion/topology';
import { fights } from '../invasion/wardens';
import { corsairHex, isConquered } from '../shared';
import { isFishHex } from '../fisheries/fish';
import { corsairBurden, corsairScore, rivalLanes } from '../sea/bot';
import { MUSTER_COST, PROMOTE_COST, RECRUIT_COST, legalGarrisons } from './actions';
import { canAct, canMuster, freePieces, invaded, musteredStrength, touchesRoute, wardenById, wardensOf } from './wardens';

/** Intersections the bot means to settle (a warden there would block itself). */
const wantedSpots = (ctx: BotCtx) => new Set(ctx.options().filter((o) => o.kind === 'settlement' && o.vertex !== undefined).map((o) => o.vertex!));

/** A spot for a new or retreating warden: off the bot's own building sites, in its rivals' way. */
function spotScore(ctx: BotCtx, v: number, wanted: Set<number>): number {
  const s = ctx.s;
  let score = wanted.has(v) ? -5 : 0;
  for (const e of s.board.vertices[v].edges) {
    const r = s.routes[e];
    if (r && r.owner !== ctx.me) score += 1;
  }
  return score;
}

function bestOf<T extends Action>(xs: T[], score: (a: T) => number): T | null {
  let out: T | null = null;
  let top = -Infinity;
  for (const x of xs) {
    const sc = score(x);
    if (sc > top) {
      top = sc;
      out = x;
    }
  }
  return out;
}

/**
 * What the fleet threatens. The bot's fair share of the defence is its own cities (if everyone
 * matched theirs, the defence would hold); below the others' least, it's first in line to lose one.
 */
function threat(ctx: BotCtx) {
  const s = ctx.s;
  const f = s.ext.fleet;
  if (!f) return null;
  const contrib = s.players.map((p) => musteredStrength(s, p.id));
  const others = contrib.filter((_, p) => p !== ctx.me);
  const defence = contrib.reduce((a, b) => a + b, 0);
  const exposed = pillageable(s, ctx.me).length > 0;
  let share = 0;
  for (const b of s.buildings) if (b?.owner === ctx.me && b.kind === 'city') share++;
  return {
    steps: FLEET_STEPS - f.position,
    share,
    // The fleet would win and the bot is (one of) the least defenders.
    atRisk: exposed && defence < fleetStrength(s) && contrib[ctx.me] <= Math.min(...others),
    mine: contrib[ctx.me],
    least: Math.min(...others),
    /** Rank of all the bot's wardens, mustered or not. */
    total: wardensOf(s, ctx.me).reduce((n, w) => n + w.rank, 0),
  };
}

/** A warden's cost dressed as a build goal, for the base planner's trade offers. */
const wardenGoal = (cost: CardCounts): BuildOption => ({ kind: 'devCard', value: 1, cost, stepCost: cost, step: { type: 'endTurn' } });

// ---------------------------------------------------------------------------
// Under Invasion: the wardens stand on the coast's edges and fight the raiders there
// ---------------------------------------------------------------------------

/** How much each raider count puts a hex's worth at risk (three conquer it), as Invasion's bot weighs it. */
const DANGER = [0, 0.12, 0.4, 1];
/** A strength that still falls short of a battle: the share of the victory it's worth (others, or the bot's next muster, may finish it). */
const PROGRESS = 0.35;
/** Below this a warden move isn't worth a card. */
const MIN_WORTH = 0.12;

/** A coastal hex as the garrisons see it: raiders, who would fight there now, and the bot's stake. */
interface Front {
  hex: number;
  raiders: number;
  /** Mustered strength on its edges: everyone's, and the bot's. */
  fighting: number;
  mine: number;
  /** What the bot stands to lose if it falls (or win back, once conquered), in rough points. */
  stake: number;
}

interface Siege {
  fronts: Map<number, Front>;
  /**
   * Prisoners for the taking, whoever's buildings stand there: the most points a raided hex is
   * worth to the bot alone, per rank of strength the battle still needs (all the game, when they
   * would win it). It keeps a bot with nothing left to build fighting for the last points.
   */
  prize: number;
  /** Points per prisoner. */
  pv: number;
  /** How hard the raiders press on the bot's own buildings, in rough points at risk. */
  exposure: number;
  /** Raiders on hexes beside the bot's buildings, against the total rank of its wardens. */
  pressing: number;
  rank: number;
}

/** What `hex` falling costs `p`: its production, and the buildings it would leave cut off. */
function stakeIn(s: GameState, p: PlayerId, hex: number): number {
  const h = s.board.hexes[hex];
  const pips = hexPips(s, h);
  let stake = 0;
  for (const v of h.vertices) {
    const b = s.buildings[v];
    if (!b || b.owner !== p) continue;
    const mult = b.kind === 'city' ? 2 : 1;
    stake += 0.08 * pips * mult;
    if (b.seat) continue;
    const land = s.board.vertices[v].hexes.filter((x) => isLand(s.board.hexes[x].terrain));
    if (land.every((x) => x === hex || isConquered(s, x))) stake += mult;
  }
  return stake;
}

const sieges = new WeakMap<BotCtx, Siege>();

/** The coast as the bot sees it this decision (all of it public). */
function siegeOf(ctx: BotCtx): Siege {
  let sg = sieges.get(ctx);
  if (sg) return sg;
  const s = ctx.s;
  const raiders = inv(s).raiders;
  const fronts = new Map<number, Front>();
  let exposure = 0;
  let pressing = 0;
  for (const hex of topology(s.board).coast) {
    const r = raiders[hex];
    const stake = stakeIn(s, ctx.me, hex);
    if (r === 0 && stake === 0) continue;
    const edges = s.board.hexes[hex].edges;
    let fighting = 0;
    let mine = 0;
    for (const w of s.wardens) {
      if (w.edge === null || !edges.includes(w.edge) || !fights(s, w)) continue;
      fighting += w.rank;
      if (w.owner === ctx.me) mine += w.rank;
    }
    fronts.set(hex, { hex, raiders: r, fighting, mine, stake });
    if (r > 0 && stake > 0) {
      // (A raided hex is a landing or two from falling; a conquered one has fallen and waits to be won back.)
      exposure += stake * DANGER[Math.min(3, r + 1)];
      pressing += Math.min(3, r);
    }
  }
  const rank = wardensOf(s, ctx.me).reduce((n, w) => n + w.rank, 0);
  const pv = 1 / prisonersPerPoint(s);
  let prize = 0;
  for (const f of fronts.values()) {
    if (f.raiders === 0) continue;
    const points = f.raiders * pv;
    const need = Math.max(1, f.raiders + 1 - f.fighting);
    prize = Math.max(prize, (points + (ctx.vp + points >= ctx.target ? WIN_BONUS : 0)) / need);
  }
  sg = { fronts, pv, exposure, pressing, rank, prize };
  sieges.set(ctx, sg);
  return sg;
}

/** Freeing `f` with `k` more of the bot's strength there: what it saves (or wins back) and its share of the prisoners. */
function victory(sg: Siege, f: Front, k: number): number {
  const total = f.fighting + k;
  if (f.raiders === 0 || total <= f.raiders) return 0;
  return f.stake * DANGER[Math.min(3, f.raiders)] + (f.raiders * sg.pv * (f.mine + k)) / total;
}

/** What `k` more fighting strength on `f` is worth at the end of this turn. */
function addedAt(sg: Siege, f: Front, k: number): number {
  const r = f.raiders;
  if (r === 0) return 0;
  // Already winning: only a bigger share of the prisoners.
  if (f.fighting > r) return victory(sg, f, k) - victory(sg, f, 0);
  if (f.fighting + k > r) return victory(sg, f, k);
  const need = r + 1 - f.fighting;
  return (PROGRESS * victory(sg, f, need) * k) / need;
}

/** What `k` more fighting strength on `edge` adds, over the coastal hexes beside it. */
function addedOn(ctx: BotCtx, sg: Siege, edge: number, k: number): number {
  let v = 0;
  for (const h of ctx.s.board.edges[edge].hexes) {
    const f = sg.fronts.get(h);
    if (f) v += addedAt(sg, f, k);
  }
  return v;
}

/**
 * A new warden's worth: more the harder the raiders press on the bot's buildings and the less
 * strength it has to meet them, and more the more prisoners there are to win.
 */
function recruitWorth(sg: Siege): number {
  const trailing = Math.max(0, sg.pressing + 1 - sg.rank);
  return 0.2 + 0.12 * Math.min(3, trailing) + Math.min(0.5, 0.5 * sg.exposure) - 0.06 * Math.max(0, sg.rank - 3) + 0.5 * sg.prize;
}

/** A rank more for `w`: what it tips on the coast now (or once mustered, if it rests), and its share of the strength the bot needs. */
function promoteWorth(ctx: BotCtx, sg: Siege, w: Warden): number {
  const now = w.edge === null ? 0 : addedOn(ctx, sg, w.edge, 1) * (w.mustered ? 1 : 0.5);
  return now + 0.7 * recruitWorth(sg);
}

/** Mustering resting `w` where it stands: the battles it joins at the end of the turn. */
const musterWorth = (ctx: BotCtx, sg: Siege, w: Warden): number => (w.edge === null ? 0 : addedOn(ctx, sg, w.edge, w.rank));

/** Mustering every resting warden the bot has (the guilds' rally), for comparison with keeping the card. */
export function rallyWorth(ctx: BotCtx): number {
  const s = ctx.s;
  if (!invaded(s) || !s.ext.invasion) return 0;
  const sg = siegeOf(ctx);
  let v = 0;
  for (const w of wardensOf(s, ctx.me)) if (canMuster(s, ctx.me, w)) v += musterWorth(ctx, sg, w);
  return v;
}

/** Paying `cost` leaves what `goal` still needs from the hand. */
function spares(hand: CardCounts, cost: CardCounts, goal: CardCounts): boolean {
  for (const r of RESOURCES) {
    if (hand[r] < cost[r]) return false;
    if (hand[r] - cost[r] < Math.min(hand[r], goal[r])) return false;
  }
  return true;
}

/**
 * The bot's own turn under Invasion: muster, promote or recruit where the raiders press, when the
 * cards spare its best build or the coast is worth more than that build; trade towards a muster
 * that would win a battle. Otherwise the cards go to building.
 */
function siegeMove(ctx: BotCtx, legal: Action[]): Action | null {
  const s = ctx.s;
  if (!s.ext.invasion) return null;
  const sg = siegeOf(ctx);
  const cands: { action: Action; worth: number; cost: CardCounts }[] = [];
  for (const a of legal) {
    if (a.type === 'garrisons/muster') cands.push({ action: a, worth: musterWorth(ctx, sg, wardenById(s, a.warden)!), cost: MUSTER_COST });
    else if (a.type === 'garrisons/promote') cands.push({ action: a, worth: promoteWorth(ctx, sg, wardenById(s, a.warden)!), cost: PROMOTE_COST });
  }
  const recruits = legal.filter((a): a is Extract<Action, { type: 'garrisons/recruit' }> => a.type === 'garrisons/recruit');
  if (recruits.length > 0) {
    // On the castle edge nearest the bot's worst front, so its first walk takes it there.
    let target: Front | null = null;
    for (const f of sg.fronts.values()) if (f.raiders > 0 && (!target || f.stake * DANGER[Math.min(3, f.raiders + 1)] > target.stake * DANGER[Math.min(3, target.raiders + 1)])) target = f;
    const near = (e: number) => {
      if (!target) return 0;
      const within = edgesWithin(s.board, e, 12);
      let d = Infinity;
      for (const t of s.board.hexes[target.hex].edges) d = Math.min(d, within.get(t) ?? Infinity);
      return -d;
    };
    cands.push({ action: bestOf(recruits, (a) => near(a.edge!))!, worth: recruitWorth(sg), cost: RECRUIT_COST });
  }
  const goal = ctx.rankedOptions()[0];
  let best: (typeof cands)[number] | null = null;
  for (const c of cands) if (c.worth >= MIN_WORTH && (!best || c.worth > best.worth)) best = c;
  if (best && (!goal || spares(ctx.hand, best.cost, goal.option.cost) || best.worth >= goal.score)) return best.action;

  // No wool and ore for a warden the coast is worth (a front to hold, or prisoners that would win
  // the game): trade towards one.
  if (recruits.length === 0 && freePieces(s, ctx.me, 1) > 0 && (ctx.hand.wool === 0 || ctx.hand.ore === 0)) {
    const want = recruitWorth(sg);
    if (want >= 0.5 && (!goal || want >= goal.score) && ctx.mem.bankTrades < ctx.prof.bankTrades) {
      const plan = bankPlan(ctx, RECRUIT_COST, goal ? goal.option.stepCost : RECRUIT_COST);
      if (plan && plan.length > 0) return bankAction(plan[0]);
    }
  }

  // No wheat for a muster that would win a battle the bot cares about: trade for one.
  if (ctx.hand.wheat === 0) {
    let want = 0;
    for (const w of wardensOf(s, ctx.me)) if (canMuster(s, ctx.me, w)) want = Math.max(want, musterWorth(ctx, sg, w));
    if (want >= 0.4 && (!goal || want >= goal.score)) {
      if (ctx.mem.bankTrades < ctx.prof.bankTrades) {
        const plan = bankPlan(ctx, MUSTER_COST, goal ? goal.option.stepCost : MUSTER_COST);
        if (plan && plan.length > 0) return bankAction(plan[0]);
      }
      const offer = proposeOffer(ctx, wardenGoal(MUSTER_COST));
      if (offer) return offer;
    }
  }
  return null;
}

/** Under Invasion: wheat for a muster that would win a battle, wool and ore for the wardens the bot is short of. */
function siegeHandValue(ctx: BotCtx, hand: CardCounts): number {
  const s = ctx.s;
  const sg = siegeOf(ctx);
  let muster = 0;
  for (const w of wardensOf(s, ctx.me)) if (canMuster(s, ctx.me, w)) muster = Math.max(muster, musterWorth(ctx, sg, w));
  let v = 0;
  if (muster >= MIN_WORTH) v += Math.min(0.6, 0.5 * muster) * Math.min(1, hand.wheat);
  const recruit = freePieces(s, ctx.me, 1) > 0 ? recruitWorth(sg) : 0;
  if (recruit >= 0.4) v += (recruit - 0.2) * (0.3 * Math.min(1, hand.wool) + 0.3 * Math.min(1, hand.ore) + (hand.wool >= 1 && hand.ore >= 1 ? 0.4 : 0));
  return v;
}

/**
 * What wool, ore and wheat are worth beyond the base planner's plans while the bot wants a warden
 * or a muster ahead of the fleet (or against the raiders): it keeps them on a 7 and trades for them.
 */
function handValue(ctx: BotCtx, hand: CardCounts): number {
  if (invaded(ctx.s)) return ctx.s.ext.invasion ? siegeHandValue(ctx, hand) : 0;
  const t = threat(ctx);
  if (!t || t.share === 0) return 0;
  const urgency = t.steps <= 5 ? 1 : 0.5;
  let v = 0;
  if (t.total < t.share && freePieces(ctx.s, ctx.me, 1) > 0) v += 0.25 * Math.min(1, hand.wool) + 0.25 * Math.min(1, hand.ore) + (hand.wool >= 1 && hand.ore >= 1 ? 0.3 : 0);
  const resting = wardensOf(ctx.s, ctx.me).filter((w) => !w.mustered).length;
  if (resting > 0 && t.mine < t.share) v += 0.3 * Math.min(hand.wheat, resting);
  return urgency * v;
}

/** The least the corsair must cost the bot before a warden chases it: a ship's delay, or two of its edges. */
const CHASE_BURDEN = 3;

/** Fish the corsair keeps from the bot on `hex` (a fishing ground it blocks), in corsairBurden's units. */
function fishingBurden(ctx: BotCtx, hex: number): number {
  const s = ctx.s;
  const h = s.board.hexes[hex];
  if (!s.ext.fisheries || !isFishHex(h)) return 0;
  let pips = 0;
  for (const v of h.vertices) {
    const b = s.buildings[v];
    if (b?.owner === ctx.me) pips += hexPips(s, h) * (b.kind === 'city' ? 2 : 1);
  }
  // (A fish token is worth a little over half a resource card; the robber's relief counts a pip at 1.5.)
  return 0.8 * pips;
}

/** A march or a displacement rests the warden (it must be mustered again): worth about a wheat, or more while the fleet is near. */
const REST_COST = 0.2;
/** The least a march or a displacement must gain, net of the rest. */
const MIN_MOVE = 0.15;

/** The state with warden `id` gone from the board (for what its owner's rivals would do without it). */
const without = (s: GameState, id: number): GameState => ({ ...s, wardens: s.wardens.filter((w) => w.id !== id) });

/** What the bot's Longest Route would regain, in points, were warden `id` (a rival's) off the board. */
function routeRegained(ctx: BotCtx, id: number): number {
  const s = ctx.s;
  const before = ctx.player.longestRoad;
  const after = longestRoadFor(without(s, id), ctx.me);
  if (after <= before) return 0;
  const others = Math.max(0, ...ctx.opponents.map((o) => s.players[o].longestRoad));
  const need = Math.max(LONGEST_ROAD_MIN, others + 1);
  return 0.2 * (after - before) + (s.longestRoadHolder !== ctx.me && before < need && after >= need ? 2 : 0);
}

/** Whether the fleet is close enough that no warden should rest now. */
function fleetNear(ctx: BotCtx): boolean {
  const t = threat(ctx);
  return !!t && t.share > 0 && t.steps <= 5 && t.mine <= t.share;
}

/**
 * Wardens off the garrisons' usual duty: one that shoves a weaker rival's warden off a corner that
 * cuts the bot's own route, one that stands on a corner the bot would settle (it marches off it),
 * and one that moves to a corner where it cuts a rival's long route. Each rests the warden.
 */
function reposition(ctx: BotCtx, legal: Action[]): Action | null {
  const s = ctx.s;
  if (fleetNear(ctx)) return null;
  const mine = wardensOf(s, ctx.me).filter((w) => canAct(s, w));
  if (mine.length === 0) return null;

  let best: { action: Action; worth: number } | null = null;
  const consider = (action: Action, worth: number, key: number) => {
    const net = worth * ctx.fuzz(key) - REST_COST;
    if (net >= MIN_MOVE && (!best || net > best.worth)) best = { action, worth: net };
  };

  for (const a of legal) {
    if (a.type !== 'garrisons/displace') continue;
    // The rival's corner is no longer cutting the bot's route (its owner may have nowhere to retreat: a piece lost).
    consider(a, routeRegained(ctx, a.target) + 0.05 * ctx.threat(wardenById(s, a.target)!.owner), a.target);
  }

  // A warden on a corner worth settling, when the bot could build there soon and has nothing as good.
  const top = Math.max(0, ...ctx.options().filter((o) => o.kind === 'settlement').map((o) => o.value));
  const soon = ctx.rounds(COSTS.settlement) <= 1.5 && ctx.player.settlementsLeft > 0;
  const spots = new Map<number, number>();
  for (const w of mine) {
    const v = w.vertex!;
    if (!soon || s.buildings[v] || !satisfiesDistanceRule(s, v) || !touchesRoute(s, ctx.me, v)) continue;
    spots.set(w.id, ctx.prof.settlementWeight * (1 + ctx.spotValue(v)));
  }
  const wanted = wantedSpots(ctx);
  for (const a of legal) {
    if (a.type !== 'garrisons/march') continue;
    const w = wardenById(s, a.warden)!;
    const stand = spots.get(w.id);
    let worth = 0;
    if (stand !== undefined && stand > top * 1.1) worth += stand - top * 0.5 + (wanted.has(a.vertex) ? -5 : 0);
    // A corner where the warden cuts a long route of a rival's (unless it is cutting one now).
    if (cutsRoute(ctx, w) === 0) worth += ctx.routeBreak(a.vertex);
    if (worth > 0) consider(a, worth, a.vertex);
  }
  return best ? (best as { action: Action }).action : null;
}

/** How much of a rival's Longest Route the warden cuts where it stands now (in edges, zero if none to speak of). */
function cutsRoute(ctx: BotCtx, w: Warden): number {
  const s = ctx.s;
  const rest = without(s, w.id);
  let cut = 0;
  for (const o of ctx.opponents) {
    const len = s.players[o].longestRoad;
    if (len >= 4) cut = Math.max(cut, longestRoadFor(rest, o) - len);
  }
  return cut;
}

function main(ctx: BotCtx): Action | null {
  const s = ctx.s;
  if (s.phase !== 'main') return null;
  const legal = legalGarrisons(s, ctx.me);
  const of = <K extends Action['type']>(type: K) => legal.filter((a): a is Extract<Action, { type: K }> => a.type === type);
  const wanted = wantedSpots(ctx);

  // A wall when the hand is near the limit a 7 would halve.
  const walls = of('garrisons/wall');
  if (walls.length > 0 && totalCards(ctx.hand) >= handLimit(s, ctx.me) - 1) return bestOf(walls, (a) => ctx.cityValue(a.vertex));

  // Invasion moves these wardens and fights with them: raise and stand them up where the raiders press.
  if (invaded(s)) return siegeMove(ctx, legal);

  const t = threat(ctx);
  if (t && t.share > 0) {
    // The fleet sails about two steps between a bot's turns: stand wardens up while it's still four out.
    const want = Math.max(t.share, t.atRisk ? t.least + 1 : 0);
    if (t.steps <= 4 && t.mine < want) {
      const muster = of('garrisons/muster');
      if (muster.length > 0) return bestOf(muster, (a) => wardenById(s, a.warden)!.rank);
    }
    // Keep enough wardens for the share: recruit (as soon as it can: the first attack comes early), then rank them up.
    if (t.total < t.share) {
      const recruit = of('garrisons/recruit');
      if (recruit.length > 0) return bestOf(recruit, (a) => spotScore(ctx, a.vertex!, wanted));
      const promote = of('garrisons/promote');
      if (promote.length > 0) return bestOf(promote, (a) => (wardenById(s, a.warden)!.mustered ? 1 : 0) - wardenById(s, a.warden)!.rank * 0.1);
    }
    // Short of the share with the fleet close: trade at the bank toward the next warden or muster.
    const mine = wardensOf(s, ctx.me);
    const resting = mine.some((w) => !w.mustered);
    const short = t.total < t.share || (resting && t.mine < want);
    if (short && t.steps <= 5) {
      const need = resting && t.steps <= 3 ? MUSTER_COST : freePieces(s, ctx.me, 1) > 0 ? RECRUIT_COST : PROMOTE_COST;
      if (ctx.mem.bankTrades < ctx.prof.bankTrades) {
        const plan = bankPlan(ctx, need, need);
        if (plan && plan.length > 0) return bankAction(plan[0]);
      }
      // Or ask the table for the card or two it lacks.
      const offer = proposeOffer(ctx, wardenGoal(need));
      if (offer) return offer;
    }
    // A spare wool and ore rank up a warden ahead of time.
    if (t.total < t.share + 1 && ctx.hand.wool >= 2 && ctx.hand.ore >= 3) {
      const promote = of('garrisons/promote');
      if (promote.length > 0) return bestOf(promote, (a) => (wardenById(s, a.warden)!.mustered ? 1 : 0) - wardenById(s, a.warden)!.rank * 0.1);
    }
  }

  // Chase the robber off one of the bot's own hexes.
  const chases = of('garrisons/chase');
  const theft = (a: { victim?: PlayerId }) => (a.victim !== undefined ? 0.1 * totalCards(s.players[a.victim].hand) : 0);
  if (s.robberHex !== null && s.board.hexes[s.robberHex].vertices.some((v) => s.buildings[v]?.owner === ctx.me)) {
    const best = bestOf(
      chases.filter((a) => a.blocker === 'robber'),
      (a) => robberHexScore(ctx, a.hex) + theft(a),
    );
    if (best) return best;
  }
  // Or the corsair, when it closes the bot's lanes or sits on its fishing grounds: to where it
  // closes a rival's instead.
  const corsair = corsairHex(s);
  const away = chases.filter((a) => a.blocker === 'corsair');
  if (corsair !== null && away.length > 0) {
    const burden = corsairBurden(ctx, corsair) + fishingBurden(ctx, corsair);
    if (burden >= CHASE_BURDEN) {
      const lanes = rivalLanes(ctx);
      let best: (typeof away)[number] | null = null;
      let top = -Infinity;
      for (const a of away) {
        const sc = corsairScore(ctx, a.hex, 'ships', lanes) + theft(a);
        if (sc > top) {
          top = sc;
          best = a;
        }
      }
      if (best && burden + top > 0) return best;
    }
  }
  return reposition(ctx, legal);
}

function pending(ctx: BotCtx, p: Pending): Action | null {
  if (p.kind !== 'garrisons/retreat') return null;
  const legal = legalGarrisons(ctx.s, ctx.me).filter((a): a is Extract<Action, { type: 'garrisons/retreat' }> => a.type === 'garrisons/retreat');
  const wanted = wantedSpots(ctx);
  return bestOf(legal, (a) => spotScore(ctx, a.vertex, wanted));
}

export const garrisonsBot: ModuleBot = { main, pending, handValue };
