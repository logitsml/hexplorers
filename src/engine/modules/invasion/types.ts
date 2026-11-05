// Invasion: the castle, raiders landing on the home coast, conquest, battles and prisoners.
// Its state, actions and events. Action and event types are namespaced 'invasion/…'.

import type { PlayerId } from '../../types';

/**
 * The muster deck's four kinds of card, each played as soon as it's bought: a levy raises a
 * warden on an empty castle edge, an outrider a warden on any empty edge, an ambush takes a raider
 * prisoner, and a turncoat pays 2 coins and leads two raiders to other parts of the coast.
 */
export type MusterCard = 'levy' | 'outrider' | 'ambush' | 'turncoat';

export interface InvasionState {
  /** Raiders on each hex (by hex id); three conquer it. Other modules read conquest through modules/shared.ts. */
  raiders: number[];
  /** Raiders beside the board, still to land. */
  supply: number;
  /**
   * Raiders brought in from beyond the box (unlimited raiders): when the supply is empty and nobody
   * holds three prisoners to trade back for a point.
   */
  extra: number;
  /** Prisoners each player holds. */
  prisoners: number[];
  /** Victory point tokens, one for each three prisoners traded back when the supply ran dry. */
  tokens: number[];
  /** The muster deck, top last (empty with the guilds, whose ventures are the deck). */
  deck: MusterCard[];
  /** Muster cards played; shuffled back into the deck when it runs out. */
  discard: MusterCard[];
}

/** A raider led from one hex (or the supply, when too few stand on the board) to another. */
export interface RaiderMove {
  from: number | null;
  to: number;
}

/** What each of this module's decisions carries in Pending.data. */
export interface CardPending {
  card: MusterCard;
}
export interface MarchPending {
  /** Wardens that have already walked or displaced this march. */
  acted: number[];
}
export interface RetreatPending {
  warden: number;
  /** The edge it was pushed off (it stands nowhere until it retreats). */
  from: number;
}

export type InvasionAction =
  /** Buy the top muster card (a development card's price) and play it at once. */
  | { type: 'invasion/buy' }
  /** Answer a levy: the empty castle edge for the new warden. */
  | { type: 'invasion/levy'; edge: number }
  /** Answer an outrider: any empty edge for the new warden. */
  | { type: 'invasion/outrider'; edge: number }
  /** Answer an ambush: the hex to take a raider prisoner from. */
  | { type: 'invasion/ambush'; hex: number }
  /** Answer a turncoat: which raiders go where (two, or as many as can move). */
  | { type: 'invasion/turncoat'; moves: RaiderMove[] }
  /** March: walk one of your wardens to an empty edge. */
  | { type: 'invasion/march'; warden: number; edge: number }
  /** March (with the garrisons): push a weaker warden of another player off its edge. */
  | { type: 'invasion/displace'; warden: number; edge: number }
  /** A displaced warden's owner moves it to an empty edge. */
  | { type: 'invasion/retreat'; edge: number }
  /** Finish marching. */
  | { type: 'invasion/halt' };

export type LandingCause = 'build' | 'ship' | 'improvement';

export type InvasionEvent =
  /** A landing at `number` (hex null: no coastal hex could take a raider). `raiders`: on the hex afterwards. */
  | { type: 'invasion/landed'; player: PlayerId; cause: LandingCause; dice: [number, number]; number: number; hex: number | null; raiders: number }
  /** The raider supply is empty: nothing more lands. */
  | { type: 'invasion/supplyEmpty'; player: PlayerId }
  /** Three prisoners went back to the supply for a victory point token (unlimited raiders). */
  | { type: 'invasion/prisonersTraded'; player: PlayerId }
  | { type: 'invasion/bought'; player: PlayerId }
  /** The card drawn; `wasted` when it could do nothing and another was drawn in its place. */
  | { type: 'invasion/drew'; player: PlayerId; card: MusterCard; wasted: boolean }
  | { type: 'invasion/wardenRaised'; player: PlayerId; warden: number; edge: number; card: 'levy' | 'outrider' }
  | { type: 'invasion/captured'; player: PlayerId; hex: number }
  | { type: 'invasion/raidersLed'; player: PlayerId; moves: RaiderMove[] }
  /** `paid`: a wheat bought the longer march. */
  | { type: 'invasion/marched'; player: PlayerId; warden: number; from: number; to: number; paid: boolean }
  | { type: 'invasion/displaced'; player: PlayerId; warden: number; victim: number; victimOwner: PlayerId; edge: number }
  /** A displaced warden found an edge (to), or had nowhere to go and left the board (to null). */
  | { type: 'invasion/retreated'; player: PlayerId; warden: number; to: number | null }
  /** The march over; `marched` says whether any warden acted in it (a bare halt is no news). */
  | { type: 'invasion/halted'; player: PlayerId; marched: boolean }
  /**
   * A hex freed: the strength of the wardens on its edges beat its raiders, who became prisoners.
   * `prisoners` and `coins` are what each participant took; `rolls` are the dice that shared them out.
   */
  | {
      type: 'invasion/battle';
      hex: number;
      raiders: number;
      /** Whether the raiders held the hex (three of them conquer it): freed, rather than driven off. */
      conquered: boolean;
      strength: number;
      participants: PlayerId[];
      prisoners: Record<number, number>;
      coins: Record<number, number>;
      rolls: { player: PlayerId; die: number }[];
    }
  /** After a victory: the die picked an edge orientation, and these wardens fell a rank (to null: removed). */
  | { type: 'invasion/losses'; hex: number; die: number; wardens: { warden: number; owner: PlayerId; rank: number; to: number | null }[] };
