// The bots' side of the auction. A placement is judged by what it does for every player (points
// now, route length, a train front left at their building); a bot weighs its own gain against what
// it hands the others, the leader most. It bids when its favourite placement beats what would
// happen if it passed by more than the cards cost it, proposes that favourite, backs the best
// proposal on the ballot, and places the wagon where it does most good.

import { emptyCards } from '../../constants';
import { Ctx } from '../../ctx';
import { clonePlain, updateLongestRoad } from '../../reducer';
import { canAfford, legalSettlements, publicVictoryPoints } from '../../rules';
import type { Action, CardCounts, GameState, Pending } from '../../types';
import type { BotCtx } from '../../ai/context';
import type { ModuleBot } from '../api';
import { BID, PLACE, VOTE, bidCards, bidKinds, proposals } from './auction';
import { addWagon, caravansOf, frontsAt, placements, wagonEdges, wagonsAt } from './trains';

/** Worth of a point of route length that changes no award. */
const ROUTE = 0.1;
/** Worth of one of your buildings at a clear train front (its next wagon there makes a point). */
const FRONT = 0.4;
/** How much an opponent's gain counts against a bot, per unit of their threat. */
const HARM = 0.5;
/** The least a bid has to win a bot (in points) before it bids at all. */
const MIN_STAKE = 0.3;
/** How much of the stake a bot will spend, in hand score. */
const BUDGET = 0.8;
/** Hand score a card costs at the least, however little the bot needs it. */
const CARD_FLOOR = 0.06;

/** What a wagon on `edge` is worth to each player. */
function worth(s: GameState, edge: number): number[] {
  const before = s.players.map((p) => publicVictoryPoints(s, p.id));
  const fronts = s.players.map((p) => frontsAt(s, p.id));
  // (A copy of what the wagon and the award change, the trains and the players, rather than of
  // the whole state: this runs for every placement on offer.)
  const ctx = new Ctx({ ...s, players: s.players.map((p) => ({ ...p })), ext: { ...s.ext, caravans: clonePlain(caravansOf(s)) } });
  addWagon(ctx.s, edge);
  updateLongestRoad(ctx);
  const t = ctx.s;
  return s.players.map(
    (p) => publicVictoryPoints(t, p.id) - before[p.id] + ROUTE * (t.players[p.id].longestRoad - p.longestRoad) + FRONT * (frontsAt(t, p.id) - fronts[p.id]),
  );
}

interface Appraisal {
  /** Each placement's worth to every player. */
  worth: Map<number, number[]>;
  /** Each placement's worth to this bot, net of what it gives the others. */
  net: Map<number, number>;
}

function appraise(ctx: BotCtx, edges: number[]): Appraisal {
  const s = ctx.s;
  // (Easy bots look only at their own gain.)
  const harm = s.players.map((p) => (p.id === ctx.me || ctx.prof.greedy ? 0 : HARM * Math.min(2, ctx.threat(p.id) / 1.6)));
  const w = new Map<number, number[]>();
  const net = new Map<number, number>();
  for (const e of edges) {
    const g = worth(s, e);
    w.set(e, g);
    net.set(e, (g[ctx.me] - g.reduce((n, x, o) => n + harm[o] * x, 0)) * ctx.fuzz(e));
  }
  return { worth: w, net };
}

/** The placement scoring highest (the lowest edge on a tie, so the choice is reproducible). */
function bestOf(edges: number[], score: (e: number) => number): number {
  let best = edges[0];
  for (const e of edges) if (score(e) > score(best) || (score(e) === score(best) && e < best)) best = e;
  return best;
}

/** The `n` bid cards this bot misses least, and what they cost it in hand score; null if it holds too few. */
function cheapest(ctx: BotCtx, n: number): { cards: CardCounts; cost: number } | null {
  const [x, y] = bidKinds(ctx.s);
  const hand = { ...ctx.hand };
  if (hand[x] + hand[y] < n) return null;
  const pick = emptyCards();
  for (let i = 0; i < n; i++) {
    let r = x;
    if (hand[x] === 0) r = y;
    else if (hand[y] > 0) {
      if (ctx.prof.greedy) r = hand[y] > hand[x] ? y : x;
      else {
        // Give up whichever card leaves the better hand.
        hand[x]--;
        const lessX = ctx.scoreHand(hand);
        hand[x]++;
        hand[y]--;
        const lessY = ctx.scoreHand(hand);
        hand[y]++;
        r = lessY > lessX ? y : x;
      }
    }
    hand[r]--;
    pick[r]++;
  }
  const cost = ctx.scoreHand(ctx.hand) - ctx.scoreHand(hand) + CARD_FLOOR * n;
  return { cards: bidCards(ctx.s, pick[x], pick[y]), cost };
}

function bid(ctx: BotCtx): Action {
  const s = ctx.s;
  const a = caravansOf(s).auction!;
  const pass: Action = { type: 'caravans/pass' };
  const where = placements(s);
  const { worth: w, net } = appraise(ctx, where);
  const val = (e: number) => net.get(e)!;
  const mine = bestOf(where, val);
  // What `p` placing it would be worth to this bot: the placements `p` likes best, on average
  // (between those `p` doesn't mind, there's no telling which they'd take).
  const placedBy = (p: number) => {
    const top = Math.max(...where.map((e) => w.get(e)![p]));
    const liked = where.filter((e) => w.get(e)![p] >= top - 1e-9);
    return liked.reduce((n, e) => n + val(e), 0) / liked.length;
  };
  // What would happen if this bot passed: the biggest bid so far has its way, or else the active
  // player places it. The active player bidding first places it anyway unless someone outbids
  // them, so a card only guards it against whoever might.
  const lead = a.bids.reduce<(typeof a.bids)[number] | null>((m, b) => (!m || b.votes > m.votes ? b : m), null);
  let stake: number;
  // (A bid with no proposal will back whatever its bidder likes.)
  if (lead) stake = val(mine) - (lead.proposal === null ? placedBy(lead.player) : val(lead.proposal));
  else if (s.currentPlayer !== ctx.me) stake = val(mine) - placedBy(s.currentPlayer);
  else stake = 0.5 * (val(mine) - Math.min(...ctx.opponents.map(placedBy)));
  if (stake < MIN_STAKE) return pass;
  const total = a.bids.reduce((n, b) => n + b.votes, 0);
  const most = lead?.votes ?? 0;
  // A majority of the votes so far, or else the biggest bid (which breaks ties on the ballot).
  for (const want of [total + 1, most + 1]) {
    const pick = cheapest(ctx, want);
    if (pick && pick.cost <= BUDGET * stake) return { type: 'caravans/bid', cards: pick.cards, proposal: mine };
  }
  return pass;
}

export const caravansBot: ModuleBot = {
  pending(ctx: BotCtx, p: Pending): Action | null {
    const s = ctx.s;
    const a = caravansOf(s).auction;
    if (!a) return null;
    switch (p.kind) {
      case BID:
        return bid(ctx);
      case VOTE: {
        const offered = proposals(a);
        const { net } = appraise(ctx, offered);
        return { type: 'caravans/vote', edge: bestOf(offered, (e) => net.get(e)!) };
      }
      case PLACE: {
        const choices = a.choices ?? placements(s);
        const { net } = appraise(ctx, choices);
        return { type: 'caravans/place', edge: bestOf(choices, (e) => net.get(e)!) };
      }
    }
    return null;
  },

  /** A settlement between two wagons is worth a point more: take such a spot when it's affordable. */
  main(ctx: BotCtx): Action | null {
    const s = ctx.s;
    if (!canAfford(s, ctx.me, 'settlement')) return null;
    const wagons = wagonEdges(s);
    const spots = legalSettlements(s, ctx.me).filter((v) => wagonsAt(s, v, wagons) >= 2);
    if (spots.length === 0) return null;
    return { type: 'buildSettlement', vertex: bestOf(spots, (v) => ctx.spotValue(v)) };
  },
};
