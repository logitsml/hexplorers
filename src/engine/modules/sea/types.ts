// Sea Lanes: sea hexes, ships, bounty fields, the corsair, and the objectives that ride on a sea map (first landings, fog).
// Its state, actions and events. Action and event types are namespaced 'sea/…'.

import type { Resource, Terrain } from '../../types';

interface FogState {
  /** The face-down hexes still to be found. */
  hidden: number[];
  /** The face-down number discs, drawn from the end. */
  pool: number[];
  /** The number each land hex found so far drew (a face-down hex's own numbers are empty). */
  drawn: Record<number, number>;
  /** How many discs the pool started with (for the invariants). */
  discs: number;
}

export interface SeaState {
  /** The corsair's sea hex, or null while it's off the board. Other modules move it through modules/shared.ts. */
  corsair: number | null;
  /** Ships each player has left in their supply. */
  shipsLeft: number[];
  /** The turn each player last moved a ship (one move a turn). */
  movedTurn: number[];
  /** First Landing: the islands each player has landed on (settled first), recorded for good. Absent without the objective. */
  landed?: number[][];
  /** Fog: what is still face down. Absent without the objective. */
  fog?: FogState;
}

/** What a bounty pick is for: a bounty field producing, or a face-down bounty field found. */
export type BountyReason = 'production' | 'fog';

/** The decision owed when a 7 or a Knight can move either blocker. */
export interface BlockerChoice {
  cause: 'seven' | 'knight';
}

/** A bounty pick owed by one player. */
export interface BountyOwed {
  count: number;
  reason: BountyReason;
}

export type SeaAction =
  | { type: 'sea/buildShip'; edge: number }
  /** Move one ship whose far end is loose to another sea edge (once a turn). */
  | { type: 'sea/moveShip'; from: number; to: number }
  /** A free ship during Road Crew. */
  | { type: 'sea/placeFreeShip'; edge: number }
  /** A starting ship beside a coastal set-up building, instead of a road. */
  | { type: 'sea/placeSetupShip'; edge: number }
  /** The blocker choice: move the robber to a land hex. */
  | { type: 'sea/moveRobber'; hex: number }
  /** The blocker choice: move the corsair to a sea hex. */
  | { type: 'sea/moveCorsair'; hex: number }
  /** The resources taken for a bounty pick. */
  | { type: 'sea/pickBounty'; resources: Resource[] };

export type SeaEvent =
  | { type: 'sea/shipBuilt'; player: number; edge: number; free: boolean; setup: boolean }
  | { type: 'sea/shipMoved'; player: number; from: number; to: number }
  | { type: 'sea/corsairMoved'; player: number; from: number | null; to: number }
  /** Players owed bounty picks: how many resources each may choose. */
  | { type: 'sea/bountyOwed'; owed: Record<number, number>; reason: BountyReason }
  | { type: 'sea/bountyPicked'; player: number; resources: Resource[]; reason: BountyReason }
  | { type: 'sea/firstLanding'; player: number; island: number; vertex: number; points: number }
  /** A face-down hex turned up: land takes `number` (null if the pool is spent) and pays its finder `grant`. */
  | { type: 'sea/hexRevealed'; player: number; hex: number; terrain: Terrain; number: number | null; grant: Resource | null };
