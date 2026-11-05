// Fisheries: the lake, the fishing grounds, fish tokens, fish actions and the Soggy Boot.
// Its state, actions and events. Action and event types are namespaced 'fisheries/…'.

import type { DevCardType, GameState, PlayerId, Resource } from '../../types';

/**
 * A fish token is its value: 1, 2 or 3 fish. In the face-down supply the Soggy Boot is 0. A
 * redacted copy shows -1 for every token its viewer can't see (the supply, and other hands).
 */
export type Token = number;

export const BOOT: Token = 0;
export const HIDDEN: Token = -1;

/** The token mix: 12 one-fish, 9 two-fish and 7 three-fish tokens, and the Soggy Boot (fisheries rules 2 on). */
export const TOKEN_COUNTS: Readonly<Record<1 | 2 | 3, number>> = { 1: 12, 2: 9, 3: 7 };
/** The mix in games recorded under the first rules: 11, 10 and 8. */
const FIRST_TOKEN_COUNTS: Readonly<Record<1 | 2 | 3, number>> = { 1: 11, 2: 10, 3: 8 };

/** Whether `s` plays the fisheries' second rules (the current token mix, prices and boot). */
export const newFisheries = (s: GameState): boolean => (s.options.moduleRules.fisheries ?? 1) >= 2;

/** The token mix this game plays with. */
export const tokenCounts = (s: GameState) => (newFisheries(s) ? TOKEN_COUNTS : FIRST_TOKEN_COUNTS);

/** A player holds at most this many fish tokens (the boot aside). */
export const FISH_LIMIT = 7;

/** The lake's printed numbers. */
export const LAKE_NUMBERS: readonly number[] = [2, 3, 11, 12];

/** The six fishing grounds' numbers, shuffled onto their spots. */
export const GROUND_NUMBERS: readonly number[] = [4, 5, 6, 8, 9, 10];

/** What each fish action costs, in fish shown on the tokens. */
export const FISH_COSTS = {
  /** The robber (or the corsair) leaves the board. */
  blocker: 2,
  /** Steal a random card from a player. */
  steal: 3,
  /** Take a resource of your choice from the supply. */
  take: 4,
  /** A free road (or ship). */
  route: 6,
  /** A free development card (or the top venture card of a deck you choose). */
  card: 7,
} as const;

/** The prices in games recorded under the first rules: a free road cost 5. */
const FIRST_FISH_COSTS: Readonly<Record<keyof typeof FISH_COSTS, number>> = { ...FISH_COSTS, route: 5 };

/** What each fish action costs in this game. */
export const fishCosts = (s: GameState): Readonly<Record<keyof typeof FISH_COSTS, number>> => (newFisheries(s) ? FISH_COSTS : FIRST_FISH_COSTS);

export type FishBuy = keyof typeof FISH_COSTS;

export interface FisheriesState {
  /** The face-down supply, top last. */
  supply: Token[];
  /** Spent and returned tokens, face up beside the board; shuffled into a new supply when it runs out. */
  discard: Token[];
  /** Each player's fish tokens, secret (only how many is public). */
  tokens: Token[][];
  /** Who holds the Soggy Boot (face up), or null while it's still in the supply. */
  boot: PlayerId | null;
  /**
   * Single draws still owed from this production, in order: each player's due, the roller first
   * and then clockwise. Non-empty only while a player at the limit decides on a swap.
   */
  queue: PlayerId[];
  /** Whether a 7 has been rolled: until then (or a Knight card) the blockers wait beside the board. */
  sevenSeen: boolean;
  /** The turn each player last swapped a token at the limit (once a turn). */
  swapTurn: number[];
}

export type FisheriesAction =
  /** Pay 2 fish: the robber (or, with Sea Lanes, the corsair) leaves the board until the next 7 or Knight card. */
  | { type: 'fisheries/blocker'; pay: Token[]; blocker: 'robber' | 'corsair' }
  /** Pay 3 fish: steal a random resource or commodity from a player. */
  | { type: 'fisheries/steal'; pay: Token[]; victim: PlayerId; oil?: boolean }
  /** Pay 4 fish: take a resource of your choice from the supply. */
  | { type: 'fisheries/take'; pay: Token[]; resource: Resource }
  /** Pay 6 fish: place a free road (or, with Sea Lanes, a ship) in the free-route interlude. */
  | { type: 'fisheries/route'; pay: Token[] }
  /** Pay 7 fish: a free development card, or the top card of the named deck where another deck replaces them. */
  | { type: 'fisheries/card'; pay: Token[]; deck?: string }
  /** At the limit: return a token of this value and draw one in its place, or keep them all (null). */
  | { type: 'fisheries/swap'; give: Token | null }
  /** Give the Soggy Boot to a player with more points than you (the first rules: at least as many). */
  | { type: 'fisheries/passBoot'; to: PlayerId };

export type FisheriesEvent =
  /** A fish token drawn. Its value is the drawer's secret: the presenter shows it to them alone. */
  | { type: 'fisheries/drew'; player: PlayerId; value: Token }
  /** The Soggy Boot drawn, and shown at once. */
  | { type: 'fisheries/bootDrawn'; player: PlayerId }
  /** The supply ran out: the spent tokens were shuffled into a new one. */
  | { type: 'fisheries/reshuffled'; tokens: number }
  /** Nothing left to draw: `missed` tokens went undrawn. */
  | { type: 'fisheries/supplyEmpty'; player: PlayerId; missed: number }
  /** A player at the limit stops drawing, `missed` tokens short. */
  | { type: 'fisheries/full'; player: PlayerId; missed: number }
  /** At the limit, a token returned face up for a fresh draw. */
  | { type: 'fisheries/swapped'; player: PlayerId; returned: Token }
  /** Tokens spent face up on a fish action. */
  | { type: 'fisheries/spent'; player: PlayerId; paid: Token[]; buy: FishBuy }
  /** The robber or the corsair left the board. */
  | { type: 'fisheries/blockerRemoved'; player: PlayerId; blocker: 'robber' | 'corsair'; from: number }
  /** A resource taken from the supply. */
  | { type: 'fisheries/took'; player: PlayerId; resource: Resource }
  /** A free development card (its kind is the taker's secret, as when one is bought). */
  | { type: 'fisheries/card'; player: PlayerId; card: DevCardType }
  /** The Soggy Boot passed on. */
  | { type: 'fisheries/bootPassed'; from: PlayerId; to: PlayerId };
