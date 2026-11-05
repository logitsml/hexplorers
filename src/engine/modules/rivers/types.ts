// Rivers: bridges over the river hexes, coins for building along them, and the wealth tiles.
// Its state, actions and events. Action and event types are namespaced 'rivers/…'.

import type { PlayerId } from '../../types';

export interface RiversState {
  /** Bridges each player still has to build (three each at the start). */
  bridgesLeft: number[];
  /**
   * The wealth tiles as last announced: the Richest tile's holder (null while it's in the supply)
   * and everyone holding a Pauper tile. Points are always counted from the coins themselves (see
   * wealthOf); this copy is how the module notices a change worth saying.
   */
  richest: PlayerId | null;
  paupers: PlayerId[];
  /**
   * The beginner set-up places its starting pieces after the modules have set up, without the
   * set-up hooks: their coins are paid with the first action instead.
   */
  startCoinsOwed: boolean;
}

export type RiversAction =
  /** Build a bridge (2 brick and 1 wood) on an empty bridge site joined to your road, bridge or building. */
  { type: 'rivers/buildBridge'; edge: number };

export type RiversEvent =
  | { type: 'rivers/bridgeBuilt'; player: PlayerId; edge: number }
  /** The Richest or Pauper tiles changed hands (the new holders, and the old). */
  | { type: 'rivers/wealthChanged'; richest: PlayerId | null; paupers: PlayerId[]; was: { richest: PlayerId | null; paupers: PlayerId[] } };
