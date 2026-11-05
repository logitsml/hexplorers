// Wagon Trains: wagon trains from the oasis and the end-of-turn auction that places them.
// Its state, actions and events. Action and event types are namespaced 'caravans/…'.

import type { CardCounts, PlayerId } from '../../types';

/**
 * A train of wagons running out from one of the oasis's origins, tail first. Its wagons are
 * neutral: each sits on an edge, over whatever route piece is there.
 */
export interface Train {
  /** The origin intersection it starts from (a corner of the oasis). */
  origin: number;
  /** The edges its wagons stand on, from the origin to the front. Empty until it starts. */
  edges: number[];
  /** The intersection its front faces (the origin while it has no wagons). */
  head: number;
}

/** One player's bid in an auction: cards face up, each card one vote. */
export interface Bid {
  player: PlayerId;
  cards: CardCounts;
  votes: number;
  /** The placement (an edge) this bidder proposed, if they proposed one. */
  proposal: number | null;
  /** The proposed placement this bidder's votes went behind, once the ballots are in. */
  ballot: number | null;
}

/** The auction for this turn's wagon, while it runs. */
export interface Auction {
  /** Bids, then ballots (only if nobody holds a majority), then someone places the wagon. */
  stage: 'bids' | 'ballots' | 'place';
  /** Seats still to act in this round, in order; the first owes the decision on the pending stack. */
  queue: PlayerId[];
  /** The bids made so far, in turn order from the active player (a pass makes none). */
  bids: Bid[];
  /** While a player places the wagon: the placements they may choose from (null: anywhere legal). */
  choices: number[] | null;
}

/**
 * How the last auction ended, kept in the state so a game resumed from a save (which replays the
 * moves and keeps no events) can still tell the table where the wagon went and what was paid.
 */
export interface AuctionResult {
  /** The turn it ran in (the builder's). */
  turn: number;
  /** The edge the wagon went on. */
  edge: number;
  /** The seat that placed it, or null when the votes did. */
  by: PlayerId | null;
  /** The bids, every one paid to the supply (a pass made none). */
  bids: { player: PlayerId; cards: CardCounts; votes: number }[];
}

export interface CaravansState {
  /** Wagons still beside the board. */
  supply: number;
  /** One train per origin, in origin order. */
  trains: Train[];
  /** A settlement or city was placed this turn, so a wagon is owed at its end (one a turn at most). */
  owed: boolean;
  /** The auction under way, or null. */
  auction: Auction | null;
  /** How the last auction ended, or null before the first. */
  lastAuction: AuctionResult | null;
}

export type CaravansAction =
  /** Bid cards face up for the wagon (wool and wheat, or brick and wood with the guilds), perhaps proposing where it goes. */
  | { type: 'caravans/bid'; cards: CardCounts; proposal?: number | null }
  | { type: 'caravans/pass' }
  /** Put your whole bid behind one of the proposed placements. */
  | { type: 'caravans/vote'; edge: number }
  /** Place the wagon (when it's yours to place). */
  | { type: 'caravans/place'; edge: number };

/** Why a player places the wagon: nobody bid, they hold a majority, or the votes tied. */
export type PlacerReason = 'nobodyBid' | 'majority' | 'mostVotes' | 'activePlayer';

export type CaravansEvent =
  | { type: 'caravans/auctionOpened'; player: PlayerId; placements: number[] }
  | { type: 'caravans/auctionSkipped'; player: PlayerId; reason: 'noWagons' | 'nowhere' }
  | { type: 'caravans/bid'; player: PlayerId; cards: CardCounts; proposal: number | null }
  | { type: 'caravans/passed'; player: PlayerId }
  | { type: 'caravans/voted'; player: PlayerId; edge: number; votes: number }
  /** The wagon is `player`'s to place, among `choices` (null: anywhere legal). */
  | { type: 'caravans/toPlace'; player: PlayerId; choices: number[] | null; reason: PlacerReason }
  /** Every bid went to the supply. */
  | { type: 'caravans/bidsPaid'; bids: { player: PlayerId; cards: CardCounts }[] }
  /**
   * A wagon went down on `edge`, extending train `train`; `joined` when its front met another
   * train (or itself) and stopped. `by` is the player who placed it, or null when the votes did.
   */
  | { type: 'caravans/wagonPlaced'; edge: number; train: number; joined: boolean; by: PlayerId | null; left: number };
