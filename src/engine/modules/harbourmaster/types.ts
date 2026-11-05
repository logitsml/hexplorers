// Port Captain: the award for the most points in buildings on harbours.
// Its state, actions and events. Action and event types are namespaced 'harbourmaster/…'.

import type { PlayerId } from '../../types';

export interface HarbourmasterState {
  /** Who holds the award, or null while nobody does. */
  holder: PlayerId | null;
}

export type HarbourmasterAction = never;

export type HarbourmasterEvent =
  /** The award changed hands (`points`: the new holder's points on harbours, 0 when it went back to the supply). */
  { type: 'harbourmaster/changed'; from: PlayerId | null; to: PlayerId | null; points: number };
