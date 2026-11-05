// The end-of-turn auction for the wagon a turn's building earned, in two rounds.
//
// Bids: from the active player round the table, each player bids cards face up (each card a vote),
// perhaps proposing a placement, or passes. A bidder holding more than half of all votes places
// the wagon anywhere legal; if nobody bid, the active player does. Ballots: otherwise each bidder
// puts their whole bid behind one proposed placement. The most votes wins; on a tie the bidder with
// the most votes chooses among the tied placements, and failing that the active player does. With
// nothing proposed, every legal placement ties at no votes. Every bid goes to the supply.
//
// Only one seat owes a decision at a time (the pending stack names just that seat), so the order
// is the table's and no seat waits on another's answer out of turn.

import { cards as cardBundle } from '../../constants';
import { assert, fail, moveCards, readCounts, validIndex, type Ctx } from '../../ctx';
import { checkVictory, updateLongestRoad } from '../../reducer';
import { hasResources, totalCards } from '../../rules';
import type { Action, Card, GameState, PlayerId } from '../../types';
import { CARDS } from '../../types';
import { addWagon, caravansOf, placements } from './trains';
import type { Auction, AuctionResult, PlacerReason } from './types';

export const BID = 'caravans/bid';
export const VOTE = 'caravans/vote';
export const PLACE = 'caravans/place';

/** What bids are made of: wool and wheat, or brick and wood with the guilds (whose wool, wheat and ore feed the wardens). */
export const bidKinds = (s: GameState): [Card, Card] => (s.options.modules.includes('guilds') ? ['brick', 'wood'] : ['wool', 'wheat']);

/** The seats round the table from the active player. */
const fromActive = (s: GameState): PlayerId[] => s.players.map((_, i) => (s.currentPlayer + i) % s.players.length);

/** The placements the bidders proposed, each once, in bid order. */
export const proposals = (a: Auction): number[] => [...new Set(a.bids.flatMap((b) => (b.proposal === null ? [] : [b.proposal])))];

const ask = (ctx: Ctx, kind: string, player: PlayerId) => ctx.s.pending.push({ kind, players: [player] });

/** The end-of-turn step: if a wagon is owed, auction it (unless none is left or it can't go anywhere). */
export function openAuction(ctx: Ctx) {
  const s = ctx.s;
  const st = caravansOf(s);
  if (!st.owed) return;
  st.owed = false;
  const player = s.currentPlayer;
  if (st.supply <= 0) {
    ctx.emit({ type: 'caravans/auctionSkipped', player, reason: 'noWagons' });
    return;
  }
  const where = placements(s);
  if (where.length === 0) {
    ctx.emit({ type: 'caravans/auctionSkipped', player, reason: 'nowhere' });
    return;
  }
  st.auction = { stage: 'bids', queue: fromActive(s), bids: [], choices: null };
  ctx.emit({ type: 'caravans/auctionOpened', player, placements: where });
  ask(ctx, BID, player);
}

export function handleAuction(ctx: Ctx, player: PlayerId, action: Action) {
  const s = ctx.s;
  const a = caravansOf(s).auction;
  const top = s.pending[s.pending.length - 1];
  assert(a && top && top.kind.startsWith('caravans/'), 'There is no wagon auction under way.');
  assert(top.players.includes(player), 'It is not your turn in the auction.');
  switch (action.type) {
    case 'caravans/bid': {
      assert(top.kind === BID, 'The bidding is over.');
      const bid = readCounts(action.cards);
      assert(bid, 'Invalid bid.');
      const kinds = bidKinds(s);
      assert(CARDS.every((k) => kinds.includes(k) || bid[k] === 0), `Bids are made in ${kinds[0]} and ${kinds[1]}.`);
      const votes = totalCards(bid);
      assert(votes > 0, 'Bid at least one card, or pass.');
      assert(hasResources(s.players[player].hand, bid), 'You do not have those cards.');
      const proposal = action.proposal ?? null;
      assert(proposal === null || (validIndex(proposal, s.board.edges.length) && placements(s).includes(proposal)), 'The wagon cannot go there.');
      a.bids.push({ player, cards: bid, votes, proposal, ballot: null });
      ctx.emit({ type: 'caravans/bid', player, cards: { ...bid }, proposal });
      nextBid(ctx, a);
      return;
    }
    case 'caravans/pass': {
      assert(top.kind === BID, 'The bidding is over.');
      ctx.emit({ type: 'caravans/passed', player });
      nextBid(ctx, a);
      return;
    }
    case 'caravans/vote': {
      assert(top.kind === VOTE, 'This is not the ballot.');
      const bid = a.bids.find((b) => b.player === player)!;
      assert(proposals(a).includes(action.edge), 'Back one of the proposed placements.');
      bid.ballot = action.edge;
      ctx.emit({ type: 'caravans/voted', player, edge: action.edge, votes: bid.votes });
      s.pending.pop();
      a.queue.shift();
      if (a.queue.length > 0) ask(ctx, VOTE, a.queue[0]);
      else closeBallots(ctx, a);
      return;
    }
    case 'caravans/place': {
      assert(top.kind === PLACE, 'The wagon is not yours to place yet.');
      const choices = a.choices ?? placements(s);
      assert(validIndex(action.edge, s.board.edges.length) && choices.includes(action.edge), 'The wagon cannot go there.');
      s.pending.pop();
      settle(ctx, action.edge, player);
      return;
    }
    default:
      fail(`Unknown action ${action.type}.`);
  }
}

function nextBid(ctx: Ctx, a: Auction) {
  ctx.s.pending.pop();
  a.queue.shift();
  if (a.queue.length > 0) ask(ctx, BID, a.queue[0]);
  else closeBids(ctx, a);
}

/** Everyone has bid or passed: a majority places it, or the ballots decide. */
function closeBids(ctx: Ctx, a: Auction) {
  const s = ctx.s;
  const total = a.bids.reduce((n, b) => n + b.votes, 0);
  if (total === 0) return toPlace(ctx, a, s.currentPlayer, null, 'nobodyBid');
  const major = a.bids.find((b) => 2 * b.votes > total);
  if (major) return toPlace(ctx, a, major.player, null, 'majority');
  const offered = proposals(a);
  // (With one placement proposed, every vote is behind it already; with none, every legal
  // placement ties at no votes.)
  if (offered.length === 1) return settle(ctx, offered[0], null);
  if (offered.length === 0) return breakTie(ctx, a, placements(s));
  a.stage = 'ballots';
  a.queue = a.bids.map((b) => b.player);
  ask(ctx, VOTE, a.queue[0]);
}

/** Every bidder has voted: the most votes wins, else the biggest bidder or the active player breaks the tie. */
function closeBallots(ctx: Ctx, a: Auction) {
  const tally = new Map<number, number>();
  for (const b of a.bids) tally.set(b.ballot!, (tally.get(b.ballot!) ?? 0) + b.votes);
  const best = Math.max(...tally.values());
  const tied = [...tally].filter(([, v]) => v === best).map(([e]) => e).sort((x, y) => x - y);
  if (tied.length === 1) return settle(ctx, tied[0], null);
  breakTie(ctx, a, tied);
}

/** Placements tied on votes: the bidder with the most votes chooses among them, or else the active player. */
function breakTie(ctx: Ctx, a: Auction, tied: number[]) {
  const most = Math.max(...a.bids.map((b) => b.votes));
  const top = a.bids.filter((b) => b.votes === most);
  if (top.length === 1) toPlace(ctx, a, top[0].player, tied, 'mostVotes');
  else toPlace(ctx, a, ctx.s.currentPlayer, tied, 'activePlayer');
}

function toPlace(ctx: Ctx, a: Auction, player: PlayerId, choices: number[] | null, reason: PlacerReason) {
  a.stage = 'place';
  a.queue = [player];
  a.choices = choices;
  ctx.emit({ type: 'caravans/toPlace', player, choices: choices && [...choices], reason });
  ask(ctx, PLACE, player);
}

/** The wagon goes down, the bids go to the supply, and the route lengths and the game are checked. */
function settle(ctx: Ctx, edge: number, by: PlayerId | null) {
  const s = ctx.s;
  const st = caravansOf(s);
  const a = st.auction!;
  const { train, joined } = addWagon(s, edge);
  ctx.emit({ type: 'caravans/wagonPlaced', edge, train, joined, by, left: st.supply });
  if (a.bids.length > 0) {
    for (const b of a.bids) moveCards(ctx, b.player, null, b.cards, 'auction');
    ctx.emit({ type: 'caravans/bidsPaid', bids: a.bids.map((b) => ({ player: b.player, cards: { ...b.cards } })) });
  }
  st.lastAuction = { turn: s.turn, edge, by, bids: a.bids.map((b) => ({ player: b.player, cards: { ...b.cards }, votes: b.votes })) };
  st.auction = null;
  // A wagon over a route piece lengthens it; a building it completes a pair at gains a point.
  updateLongestRoad(ctx);
  checkVictory(ctx);
}

/**
 * The auction the table should still be told about: the one that closed with the turn just ended,
 * for the turn after it and no longer (none while another is under way). The turn passes in the
 * same move that places the wagon, so it reads `turn + 1`; a game the wagon won stays on its own.
 */
export function recentAuction(s: GameState): AuctionResult | null {
  const st = s.ext.caravans;
  if (!st || st.auction || !st.lastAuction) return null;
  return s.turn <= st.lastAuction.turn + 1 ? st.lastAuction : null;
}

/** The actions answering the auction's decision, for the seat that owes it. */
export function auctionActions(s: GameState, player: PlayerId): Action[] {
  const a = s.ext.caravans?.auction;
  const top = s.pending[s.pending.length - 1];
  if (!a || !top || !top.kind.startsWith('caravans/') || !top.players.includes(player)) return [];
  switch (top.kind) {
    case BID: {
      const out: Action[] = [{ type: 'caravans/pass' }];
      const [x, y] = bidKinds(s);
      const hand = s.players[player].hand;
      const where = placements(s);
      for (let i = 0; i <= hand[x]; i++) {
        for (let j = 0; j <= hand[y]; j++) {
          if (i + j === 0) continue;
          out.push({ type: 'caravans/bid', cards: bidCards(s, i, j) });
          for (const proposal of where) out.push({ type: 'caravans/bid', cards: bidCards(s, i, j), proposal });
        }
      }
      return out;
    }
    case VOTE:
      return proposals(a).map((edge) => ({ type: 'caravans/vote', edge }));
    case PLACE:
      return (a.choices ?? placements(s)).map((edge) => ({ type: 'caravans/place', edge }));
    default:
      return [];
  }
}

/** A bid of `first` of the first bid kind and `second` of the other. */
export function bidCards(s: GameState, first: number, second: number) {
  const [x, y] = bidKinds(s);
  return cardBundle({ [x]: first, [y]: second });
}
