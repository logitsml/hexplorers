// Garrisons: wardens (their pieces live in GameState.wardens, shared with Invasion) and city walls (on Building).
// Its state, actions and events. Action and event types are namespaced 'garrisons/…'.

import type { PlayerId } from '../../types';

export type WardenRank = 1 | 2 | 3;

export interface GarrisonsState {
  /** Wardens promoted this turn (each may be promoted once a turn). Their ids come from the shared counter, GameState.nextWardenId. */
  promoted: number[];
}

/** Which blocker a warden chases: the robber on land, or the corsair at sea (Sea Lanes). */
export type Blocker = 'robber' | 'corsair';

export type GarrisonsAction =
  /** Recruit a resting recruit onto an intersection beside your routes (or, under Invasion, an edge of the castle). */
  | { type: 'garrisons/recruit'; vertex?: number; edge?: number }
  | { type: 'garrisons/promote'; warden: number }
  | { type: 'garrisons/muster'; warden: number }
  | { type: 'garrisons/wall'; vertex: number }
  /** A mustered warden walks your routes to an empty intersection. */
  | { type: 'garrisons/march'; warden: number; vertex: number }
  /** A mustered warden walks your routes onto a weaker opponent's warden, which must retreat. */
  | { type: 'garrisons/displace'; warden: number; target: number }
  /** A mustered warden beside a blocker's hex sends it to `hex` and robs `victim` there: a card at random, or one oil by name (`oil`). */
  | { type: 'garrisons/chase'; warden: number; blocker: Blocker; hex: number; victim?: PlayerId; oil?: true }
  /** A displaced warden's owner moves it along their routes. */
  | { type: 'garrisons/retreat'; vertex: number };

/** The decision Garrisons leaves owed: a displaced warden's retreat. */
export interface RetreatPending {
  kind: 'garrisons/retreat';
  warden: number;
  /** Where it was displaced from. */
  from: number;
}

export type GarrisonsEvent =
  | { type: 'garrisons/recruited'; player: PlayerId; warden: number; vertex: number | null; edge: number | null }
  | { type: 'garrisons/promoted'; player: PlayerId; warden: number; rank: WardenRank; free: boolean }
  | { type: 'garrisons/mustered'; player: PlayerId; wardens: number[]; free: boolean }
  | { type: 'garrisons/wall'; player: PlayerId; vertex: number; free: boolean }
  | { type: 'garrisons/marched'; player: PlayerId; warden: number; from: number; to: number }
  | { type: 'garrisons/displaced'; player: PlayerId; warden: number | null; target: number; targetOwner: PlayerId; from: number }
  | { type: 'garrisons/retreated'; player: PlayerId; warden: number; from: number; to: number }
  /** A warden taken off the board (displaced with nowhere to go, or given up). */
  | { type: 'garrisons/removed'; player: PlayerId; warden: number; reason: 'noRetreat' | 'treachery' }
  | { type: 'garrisons/chased'; player: PlayerId; warden: number; blocker: Blocker; from: number | null; to: number }
  /** A warden placed by a venture (treachery). */
  | { type: 'garrisons/placed'; player: PlayerId; warden: number; rank: WardenRank; vertex: number | null; edge: number | null };
