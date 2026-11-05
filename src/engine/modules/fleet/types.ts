// Raider Fleet: the track the raiders sail along, and their attacks on the cities.
// Its state, actions and events. Action and event types are namespaced 'fleet/…'.

import type { PlayerId } from '../../types';

export interface FleetState {
  /** Steps the fleet has sailed toward the island since it last set out (0 at the start of its track). */
  position: number;
  /** Attacks so far (the robber and the corsair stay off the board until the first). */
  attacks: number;
  /** Each player's defence tokens (a point each). */
  tokens: number[];
  /** Where the corsair waits to come in after the first attack (Sea Lanes), or null. */
  corsairStart: number | null;
}

export type FleetAction =
  /** A city of yours the raiders take: it drops to a settlement. */
  | { type: 'fleet/yield'; vertex: number }
  /** Pay five coins to keep your city (Rivers). */
  | { type: 'fleet/ransom' };

/** The decision the fleet leaves owed: which city a player loses, or whether they buy it off. */
export interface PillagePending {
  kind: 'fleet/pillage';
  /** The cities the raiders may take. */
  cities: number[];
}

export type FleetEvent =
  /** The fleet sailed a step (`position` of `steps`). */
  | { type: 'fleet/advanced'; position: number; steps: number }
  /** The fleet landed: its strength against the mustered wardens', and each player's share. */
  | { type: 'fleet/attack'; strength: number; defence: number; contributions: number[]; won: boolean }
  /** A city taken down to a settlement (`lying`: laid down for want of a settlement piece). */
  | { type: 'fleet/pillaged'; player: PlayerId; vertex: number; lying: boolean }
  | { type: 'fleet/ransomed'; player: PlayerId }
  /** The defence held: the top defender's token. */
  | { type: 'fleet/token'; player: PlayerId }
  /** The defence held with a tie at the top: each tied player draws a venture of their choice. */
  | { type: 'fleet/tied'; players: PlayerId[] }
  /** After the first attack the blockers come in. */
  | { type: 'fleet/blockersIn'; robber: number | null; corsair: number | null };
