// Oil: wells, burning and sequestering oil, foundries, the disaster track, floods and pollution, the Steward.
// Its state, actions and events. Action and event types are namespaced 'oil/…'.

import type { Card, PlayerId, Production, Resource } from '../../types';

export interface OilState {
  /** The disaster track: oil burned since the last disaster (a foundry counts 2), from 0 to 5. */
  track: number;
  /** Oil each player has sequestered, out of the game for good. */
  sequestered: number[];
  /** Who holds the Steward, if anyone. */
  steward: PlayerId | null;
  /** Oil a polluted well has taken out of the game. */
  destroyed: number;
  /** The numbers pollution has taken, in order: each takes one instance of its number from its hex. */
  lost: { hex: number; number: number }[];
  /** Whether the player whose turn it is has burned oil or built a foundry this turn. */
  usedThisTurn: boolean;
  /** Whether they have sequestered oil this turn. */
  sequesteredThisTurn: boolean;
  /** Whether a 7 has been rolled: until then (or a Knight card) the blockers wait beside the board. */
  sevenSeen: boolean;
}

export type OilAction =
  /** Burn one oil for two of one resource. */
  | { type: 'oil/burn'; get: Resource }
  /** Put a foundry under one of your cities. */
  | { type: 'oil/foundry'; vertex: number }
  /** Sequester one oil. */
  | { type: 'oil/sequester' }
  /** Play Monopoly naming oil. */
  | { type: 'oil/monopoly' }
  /** Play Invention taking oil as one or both of its cards. */
  | { type: 'oil/invention'; cards: Card[] };

export type OilEvent =
  /** Oil handed out by a roll; `short` when the supply ran out before everyone had theirs. */
  | { type: 'oil/produced'; total: number; grants: Production[]; short: boolean }
  /** Oil a set-up building took from the wells beside it. */
  | { type: 'oil/startingOil'; player: PlayerId; vertex: number; amount: number }
  | { type: 'oil/burned'; player: PlayerId; get: Resource; track: number }
  | { type: 'oil/foundryBuilt'; player: PlayerId; vertex: number; track: number }
  /** `total`: the oil this player has sequestered in all. */
  | { type: 'oil/sequestered'; player: PlayerId; total: number }
  | { type: 'oil/stewardChanged'; from: PlayerId | null; to: PlayerId }
  /** Monopoly naming oil: what came from each player. */
  | { type: 'oil/monopoly'; player: PlayerId; taken: Record<number, number> }
  | { type: 'oil/invention'; player: PlayerId; cards: Card[] }
  /** The disaster track stood at 5 at the end of `player`'s turn, and the dice were rolled. */
  | { type: 'oil/disaster'; player: PlayerId; dice: [number, number]; total: number }
  /**
   * A flood. `number` is the second roll that chose the island (null when every coast floods), and
   * `island` the one chosen (null when no island bore the number). `washed` lost their settlements,
   * `dropped` became settlements (`lying` among them, for want of a settlement piece), and `walls`
   * lost their walls.
   */
  /** A flood: the island it struck, and the corners it hit, each with its building's owner (`owners`, by corner). */
  | { type: 'oil/flood'; island: number | null; number: number | null; washed: number[]; dropped: number[]; lying: number[]; walls: number[]; owners: Record<number, PlayerId> }
  /** Pollution took `number` from `hex` for good; `lost` numbers are gone in all. */
  | { type: 'oil/polluted'; hex: number; number: number; lost: number }
  /** Pollution struck a well: oil left the game from the supply, then from hands. */
  | { type: 'oil/wellPolluted'; hex: number; fromSupply: number; fromHands: Record<number, number> }
  /** Pollution found no hex still bearing the number. */
  | { type: 'oil/spared'; number: number }
  /** The island is lost: the game ends with nobody winning, and the Steward is honoured. */
  | { type: 'oil/islandLost'; steward: PlayerId | null };
