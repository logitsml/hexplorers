// The bot's Invasion: buying and playing muster cards, spending coins, and marching wardens.
//
// Everything is judged in rough victory points, like the base planner's options. A hex's worth to
// the bot comes from two things: prisoners (a point for every two, or three with the guilds) and
// what the hex's raiders threaten (production and buildings that conquest would take, the bot's
// own counting against it and its opponents' in its favour). A warden is worth what it adds to
// the battles on the hexes beside its edge, plus a little for being on its way to them.

import type { BotCtx, BuildOption } from '../../ai/context';
import { bankAction, bankPlan, proposeOffer } from '../../ai/trade';
import { isLand } from '../../constants';
import { COIN_BUYS_PER_TURN, COINS_PER_RESOURCE, hasResources, hexPips, usesCoins } from '../../rules';
import type { Action, CardCounts, GameState, Pending, PlayerId, Resource } from '../../types';
import { RESOURCES } from '../../types';
import type { ModuleBot } from '../api';
import { isConquered } from '../shared';
import { ambushHexes, freeWardens, levyEdges, outriderEdges, turncoatOptions } from './muster';
import { inv, musterDeckInPlay, prisonersPerPoint, raidersOnBoard, withGarrisons } from './raids';
import { edgesWithin, topology } from './topology';
import type { CardPending, MarchPending, RetreatPending } from './types';
import { displaceTargets, fights, LONG_STRIDE, restingPlace, retreatTargets, STRIDE, walkTargets } from './wardens';

/** How much each raider count puts a hex's worth at risk: three conquer it. */
const DANGER = [0, 0.12, 0.4, 1];
/** A warden that won't fight this turn (resting, with the garrisons) is worth this share of one that will. */
const LATER = 0.4;
/** Weight of the best raided hex a warden could reach on later marches. */
const TRAVEL = 0.5;

/** What `hex` falling would cost `p`, in rough points: its production, and buildings it would leave cut off. */
function fallCost(s: GameState, p: PlayerId, hex: number): number {
  const h = s.board.hexes[hex];
  const pips = hexPips(s, h);
  let cost = 0;
  for (const v of h.vertices) {
    const b = s.buildings[v];
    if (!b || b.owner !== p) continue;
    const mult = b.kind === 'city' ? 2 : 1;
    cost += 0.08 * pips * mult;
    if (b.seat) continue;
    const land = s.board.vertices[v].hexes.filter((x) => isLand(s.board.hexes[x].terrain));
    if (land.every((x) => x === hex || isConquered(s, x))) cost += mult;
  }
  return cost;
}

class Judge {
  readonly s: GameState;
  readonly me: PlayerId;
  /** Points per prisoner. */
  readonly pv: number;
  private oppWeight: number[];
  private fall = new Map<number, number>();
  private reach = new Map<number, Map<number, number>>();
  /** attraction() by hex, strength and the warden left out (worth() asks it of every coastal hex for every edge). */
  private pull = new Map<number, number>();

  constructor(readonly ctx: BotCtx) {
    this.s = ctx.s;
    this.me = ctx.me;
    this.pv = 1 / prisonersPerPoint(this.s);
    this.oppWeight = this.s.players.map((p) => (p.id === this.me ? 0 : 0.35 * Math.min(2, ctx.threat(p.id) / 1.6)));
  }

  private fallCost(p: PlayerId, hex: number): number {
    const key = p * 4096 + hex;
    let c = this.fall.get(key);
    if (c === undefined) {
      c = fallCost(this.s, p, hex);
      this.fall.set(key, c);
    }
    return c;
  }

  /** The bot's stake in `hex` holding `r` raiders: its own losses against, its opponents' for. */
  threat(hex: number, r: number): number {
    const d = DANGER[Math.min(3, r)];
    if (d === 0) return 0;
    let u = -this.fallCost(this.me, hex) * d;
    for (const p of this.s.players) if (p.id !== this.me) u += this.oppWeight[p.id] * this.fallCost(p.id, hex) * d;
    return u;
  }

  /** The bot's worth from `hex` with `r` raiders when the fighting strength there is `total`, `mine` of it the bot's. */
  battle(hex: number, r: number, total: number, mine: number): number {
    if (r === 0) {
      // Standing guard: two or more beat a raider the moment it lands, before more can follow it.
      const chance = Math.min(0.6, 0.08 * hexPips(this.s, this.s.board.hexes[hex]));
      const headedOff = total >= 2 ? this.threat(hex, 0) - this.threat(hex, 2) : 0;
      return 0.5 * chance * (this.battle(hex, 1, total, mine) + 0.5 * headedOff);
    }
    if (total > r) return (mine > 0 ? (r * this.pv * mine) / total : 0) + this.threat(hex, 0) - this.threat(hex, r);
    return mine > 0 ? (0.25 * r * this.pv * mine) / (r + 1) : 0;
  }

  /** Fighting strength on `hex`: everyone's and the bot's, leaving out one warden. */
  strength(hex: number, without: number | null): { total: number; mine: number } {
    const edges = this.s.board.hexes[hex].edges;
    let total = 0;
    let mine = 0;
    for (const w of this.s.wardens) {
      if (w.id === without || w.edge === null || !edges.includes(w.edge) || !fights(this.s, w)) continue;
      total += w.rank;
      if (w.owner === this.me) mine += w.rank;
    }
    return { total, mine };
  }

  /** What one more warden of strength `k` on `hex` is worth (`without`: a warden to leave out of the count). */
  gain(hex: number, k: number, without: number | null): number {
    const r = inv(this.s).raiders[hex];
    const { total, mine } = this.strength(hex, without);
    return this.battle(hex, r, total + k, mine + k) - this.battle(hex, r, total, mine);
  }

  /** Coastal hexes beside `edge`. */
  coastOf(edge: number): number[] {
    const t = topology(this.s.board);
    return this.s.board.edges[edge].hexes.filter((h) => t.coastal[h]);
  }

  /** Distance in edges from each warden edge to the nearest edge of `hex`. */
  private distTo(hex: number): Map<number, number> {
    let d = this.reach.get(hex);
    if (!d) {
      d = new Map();
      for (const e of this.s.board.hexes[hex].edges) {
        for (const [f, k] of edgesWithin(this.s.board, e, 12)) if ((d.get(f) ?? Infinity) > k) d.set(f, k);
      }
      this.reach.set(hex, d);
    }
    return d;
  }

  /**
   * What freeing `hex` is worth to the bot per point of strength still needed there: what pulls
   * wardens towards it from afar, before any one of them could win it alone.
   */
  attraction(hex: number, k: number, without: number | null): number {
    // (Wardens' ids and strengths are small whole numbers, and a board has under 4096 hexes.)
    const key = (((without ?? -1) + 1) * 16 + k) * 4096 + hex;
    let a = this.pull.get(key);
    if (a === undefined) {
      a = this.attractionNow(hex, k, without);
      this.pull.set(key, a);
    }
    return a;
  }

  private attractionNow(hex: number, k: number, without: number | null): number {
    const r = inv(this.s).raiders[hex];
    if (r === 0) return 0;
    const { total, mine } = this.strength(hex, without);
    if (total > r) return 0;
    const need = r + 1 - total;
    const win = this.battle(hex, r, r + 1, mine + need) - this.battle(hex, r, total, mine);
    return (win * Math.min(k, need)) / need;
  }

  /** A warden of strength `k` standing on `edge`: what it adds now (times `now`), and what it could reach later. */
  worth(edge: number, k: number, now: number, without: number | null): number {
    let v = 0;
    for (const h of this.coastOf(edge)) v += now * this.gain(h, k, without);
    let later = 0;
    for (const h of topology(this.s.board).coast) {
      if (inv(this.s).raiders[h] === 0) continue;
      const d = this.distTo(h).get(edge);
      if (d === undefined) continue;
      later = Math.max(later, this.attraction(h, k, without) * Math.pow(0.6, Math.ceil(d / STRIDE)));
    }
    return (v + TRAVEL * later) * this.ctx.fuzz(edge);
  }
}

/** What shoving a rival's warden off its edge is worth beyond the ground gained: it must retreat, and may have nowhere to go. */
const SHOVE = 0.08;

/** A wheat spent on a long march, in rough points. */
const wheatCost = (ctx: BotCtx) => 0.3 * ctx.resVal.wheat;

/**
 * The best battle the bot's wardens can win together this march (alone, where walking doesn't
 * stop a warden fighting): the raided hex, and which wardens to send to which of its free edges,
 * nearest first. Its worth is the victory less what the walkers leave behind and the wheat.
 */
function battlePlan(ctx: BotCtx, j: Judge, acted: readonly number[]): { first: Action; value: number } | null {
  const s = ctx.s;
  const t = topology(s.board);
  const raiders = inv(s).raiders;
  const mine = s.wardens.filter((w) => w.owner === ctx.me && !acted.includes(w.id) && w.edge !== null);
  const reach = new Map(mine.map((w) => [w.id, walkTargets(s, w)]));
  let best: { first: Action; value: number } | null = null;
  for (const h of t.coast) {
    const r = raiders[h];
    if (r === 0) continue;
    const here = j.strength(h, null);
    if (here.total > r) continue;
    const sides = s.board.hexes[h].edges;
    const edges = sides.filter((e) => restingPlace(s, e));
    const walkers = mine.filter((w) => !sides.includes(w.edge!));
    // Nearest walkers first (a walk needing wheat last); each takes its nearest edge still free.
    const nearest = (w: (typeof mine)[number], taken: Set<number>) => {
      let pick: { edge: number; d: number } | null = null;
      for (const e of edges) {
        const d = reach.get(w.id)!.get(e);
        if (d !== undefined && !taken.has(e) && (!pick || d < pick.d)) pick = { edge: e, d };
      }
      return pick;
    };
    const order = walkers
      .map((w) => ({ w, d: nearest(w, new Set())?.d }))
      .filter((o): o is { w: (typeof mine)[number]; d: number } => o.d !== undefined)
      .sort((a, b) => Number(a.d > STRIDE) - Number(b.d > STRIDE) || a.d - b.d || a.w.id - b.w.id);
    let need = r + 1 - here.total;
    const taken = new Set<number>();
    const sent: { w: (typeof mine)[number]; edge: number; d: number }[] = [];
    let cost = 0;
    for (const { w } of order) {
      if (need <= 0) break;
      const pick = nearest(w, taken);
      if (!pick) continue;
      taken.add(pick.edge);
      sent.push({ w, ...pick });
      need -= w.rank;
      if (!t.castleEdge[w.edge!]) cost += j.worth(w.edge!, w.rank, 1, w.id);
      if (pick.d > STRIDE) cost += wheatCost(ctx);
    }
    if (need > 0 || sent.length === 0) continue;
    const added = sent.reduce((n, o) => n + o.w.rank, 0);
    const value = j.battle(h, r, here.total + added, here.mine + added) - j.battle(h, r, here.total, here.mine) - cost;
    if (!best || value > best.value) best = { first: { type: 'invasion/march', warden: sent[0].w.id, edge: sent[0].edge }, value };
  }
  return best;
}

function marchMove(ctx: BotCtx, data: MarchPending): Action {
  const s = ctx.s;
  const t = topology(s.board);
  const j = new Judge(ctx);
  const garrisons = withGarrisons(s);
  if (!garrisons) {
    const plan = battlePlan(ctx, j, data.acted);
    if (plan && plan.value > 0.05) return plan.first;
  }
  let best: { action: Action; gain: number } | null = null;
  for (const w of s.wardens) {
    if (w.owner !== ctx.me || data.acted.includes(w.id) || w.edge === null) continue;
    const targets = walkTargets(s, w);
    // (With the garrisons, a mustered warden may also take the edge of a weaker rival's: it is shoved off.)
    const shoves = garrisons ? displaceTargets(s, w) : [];
    if (targets.size === 0 && shoves.length === 0) continue;
    const forced = t.castleEdge[w.edge];
    const stay = forced ? 0 : j.worth(w.edge, w.rank, fights(s, w) ? 1 : LATER, w.id);
    for (const e of shoves) {
      let gain = j.worth(e, w.rank, LATER, w.id) - stay + SHOVE;
      if (forced) gain += 100;
      if (!best || gain > best.gain) best = { action: { type: 'invasion/displace', warden: w.id, edge: e }, gain };
    }
    for (const [e, d] of targets) {
      // With the garrisons, a walk leaves the warden resting: it fights again once mustered.
      let gain = j.worth(e, w.rank, garrisons ? LATER : 1, w.id) - stay;
      if (!garrisons && d > STRIDE) gain -= wheatCost(ctx);
      if (forced) gain += 100;
      if (!best || gain > best.gain) best = { action: { type: 'invasion/march', warden: w.id, edge: e }, gain };
    }
  }
  return best && best.gain > 0.02 ? best.action : { type: 'invasion/halt' };
}

function bestEdge(ctx: BotCtx, edges: number[], pick: (j: Judge, e: number) => number): number {
  const j = new Judge(ctx);
  let best = edges[0];
  let score = -Infinity;
  for (const e of edges) {
    const v = pick(j, e);
    if (v > score) {
      score = v;
      best = e;
    }
  }
  return best;
}

function cardAnswer(ctx: BotCtx, card: CardPending['card']): Action | null {
  const s = ctx.s;
  const t = topology(s.board);
  switch (card) {
    case 'levy': {
      // The castle edge nearest the best ground it can march to.
      const reach = s.players[ctx.me].hand.wheat > 0 ? LONG_STRIDE : STRIDE;
      const edge = bestEdge(ctx, levyEdges(s), (j, c) => {
        let v = 0;
        for (const [e, d] of edgesWithin(s.board, c, reach)) if (d > 0 && restingPlace(s, e)) v = Math.max(v, j.worth(e, 1, 1, null));
        return v;
      });
      return { type: 'invasion/levy', edge };
    }
    case 'outrider': {
      const all = outriderEdges(s);
      const open = all.filter((e) => !t.castleEdge[e]);
      const edge = bestEdge(ctx, open.length > 0 ? open : all, (j, e) => j.worth(e, 1, 1, null));
      return { type: 'invasion/outrider', edge };
    }
    case 'ambush': {
      const j = new Judge(ctx);
      const raiders = inv(s).raiders;
      let best = -1;
      let score = -Infinity;
      for (const h of ambushHexes(s)) {
        const r = raiders[h];
        const { total, mine } = j.strength(h, null);
        const v = j.threat(h, r - 1) - j.threat(h, r) + j.battle(h, r - 1, total, mine) - j.battle(h, r, total, mine);
        if (v > score) {
          score = v;
          best = h;
        }
      }
      return { type: 'invasion/ambush', hex: best };
    }
    case 'turncoat': {
      const j = new Judge(ctx);
      const raiders = inv(s).raiders;
      const opts = turncoatOptions(s);
      let best = opts[0];
      let score = -Infinity;
      for (const o of opts) {
        const after = new Map<number, number>();
        for (const h of o.from) if (h !== null) after.set(h, (after.get(h) ?? raiders[h]) - 1);
        for (const h of o.to) after.set(h, (after.get(h) ?? raiders[h]) + 1);
        let v = 0;
        for (const [h, r] of after) {
          const { total, mine } = j.strength(h, null);
          v += j.threat(h, r) - j.threat(h, raiders[h]) + j.battle(h, r, total, mine) - j.battle(h, raiders[h], total, mine);
        }
        if (v > score) {
          score = v;
          best = o;
        }
      }
      return { type: 'invasion/turncoat', moves: best.from.map((from, k) => ({ from, to: best.to[k] })) };
    }
  }
}

/** A muster card's worth to the bot now, in rough points (its draw is a lottery over the deck). */
function musterValue(ctx: BotCtx): number {
  const s = ctx.s;
  const raided = raidersOnBoard(s);
  const pv = 1 / prisonersPerPoint(s);
  // A warden is worth more the more raiders there are, above all beside the bot's own buildings.
  const j = new Judge(ctx);
  let exposed = 0;
  for (const h of topology(s.board).coast) if (inv(s).raiders[h] > 0) exposed += Math.max(0, -j.threat(h, inv(s).raiders[h]));
  const own = s.wardens.filter((w) => w.owner === ctx.me).length;
  const warden = freeWardens(s, ctx.me) > 0 ? 0.55 + 0.05 * Math.min(8, raided) + Math.min(0.6, 0.3 * exposed) - 0.05 * Math.max(0, own - 3) : 0;
  const ambush = raided > 0 ? pv + 0.15 : 0;
  const turncoat = 0.4;
  const n = 26;
  const ev = (14 * warden + 4 * (warden + 0.05) + 4 * ambush + 4 * turncoat) / n;
  return ev * (0.7 + 0.3 * ctx.prof.devCardValue);
}

const MUSTER_COST: CardCounts = { brick: 0, wood: 0, wool: 1, wheat: 1, ore: 1, paper: 0, cloth: 0, silver: 0, oil: 0 };

/** Paying `cost` leaves what `goal` still needs from the hand. */
function sparesFor(hand: CardCounts, cost: CardCounts, goal: CardCounts): boolean {
  for (const r of RESOURCES) {
    if (hand[r] < cost[r]) return false;
    if (hand[r] - cost[r] < Math.min(hand[r], goal[r])) return false;
  }
  return true;
}

/** Coins buy what `cost` lacks (they're worth nothing else here). */
function coinBuy(ctx: BotCtx, cost: CardCounts | undefined): Action | null {
  const s = ctx.s;
  if (!cost || !usesCoins(s) || ctx.player.coins < COINS_PER_RESOURCE || s.coinBuys >= COIN_BUYS_PER_TURN) return null;
  let pick: Resource | null = null;
  for (const r of RESOURCES) {
    if (cost[r] <= ctx.hand[r] || s.bank[r] < 1) continue;
    if (!pick || ctx.resVal[r] > ctx.resVal[pick]) pick = r;
  }
  return pick ? { type: 'buyWithCoins', get: pick } : null;
}

/**
 * The bot's own turn: a muster card when it's the best thing to aim for (trading towards it like
 * any other goal), or when it's affordable without touching what the best goal needs; otherwise
 * coins towards that goal.
 */
function mainMove(ctx: BotCtx): Action | null {
  const s = ctx.s;
  const ranked = ctx.rankedOptions();
  const goal = ranked[0];
  if (musterDeckInPlay(s)) {
    const value = musterValue(ctx);
    const option: BuildOption = { kind: 'devCard', value, cost: MUSTER_COST, stepCost: MUSTER_COST, step: { type: 'invasion/buy' } };
    const score = value / (1 + ctx.prof.waitDiscount * ctx.rounds(MUSTER_COST));
    const affordable = hasResources(ctx.hand, MUSTER_COST);
    if (value > 0 && (!goal || score > goal.score)) {
      if (affordable) return option.step;
      const coins = coinBuy(ctx, MUSTER_COST);
      if (coins) return coins;
      if (ctx.mem.bankTrades >= ctx.prof.bankTrades) return proposeOffer(ctx, option);
      const plan = bankPlan(ctx, MUSTER_COST, MUSTER_COST);
      if (plan && plan.length > 0 && plan.every((p) => p.ratio <= 2)) return bankAction(plan[0]);
      const offer = proposeOffer(ctx, option);
      if (offer) return offer;
      if (plan && plan.length > 0) return bankAction(plan[0]);
      return null;
    }
    if (value > 0 && affordable && goal && !hasResources(ctx.hand, goal.option.stepCost) && sparesFor(ctx.hand, MUSTER_COST, goal.option.cost)) return option.step;
  }
  return coinBuy(ctx, goal?.option.stepCost);
}

export const invasionBot: ModuleBot = {
  pending(ctx: BotCtx, p: Pending): Action | null {
    switch (p.kind) {
      case 'invasion/card':
        return cardAnswer(ctx, (p.data as CardPending).card);
      case 'invasion/march':
        return marchMove(ctx, p.data as MarchPending);
      case 'invasion/retreat': {
        const edges = retreatTargets(ctx.s, (p.data as RetreatPending).from);
        const w = ctx.s.wardens.find((x) => x.id === (p.data as RetreatPending).warden);
        return { type: 'invasion/retreat', edge: bestEdge(ctx, edges, (j, e) => j.worth(e, w?.rank ?? 1, LATER, w?.id ?? null)) };
      }
    }
    return null;
  },

  main(ctx: BotCtx): Action | null {
    if (ctx.s.phase !== 'main' || ctx.s.pending.length > 0) return null;
    return mainMove(ctx);
  },
};
