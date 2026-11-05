// Almanac: the event deck's happenings, resolved before production.
// Its state, actions and events. Action and event types are namespaced 'almanac/…'.

import type { Card, PlayerId, Resource } from '../../types';

/** What a card brings with its number (see the table in deck.ts). */
export type Happening =
  /** Nothing happens. */
  | 'fairDay'
  /** The players with the most buildings on harbours each take a resource. */
  | 'calmSeas'
  /** The strongest army steals a card from anyone. */
  | 'quarrel'
  /** Each player cracks one of their roads. */
  | 'quake'
  /** Cities take one resource per producing hex. */
  | 'sickness'
  /** Each player passes a card to the left. */
  | 'gifts'
  /** The leaders each give a card to someone behind. */
  | 'helpingHand'
  /** Each player takes a resource. */
  | 'harvest'
  /** The robber goes back to the desert (or the corsair leaves the board). */
  | 'robberFlees'
  /** The strongest armies each take a resource. */
  | 'tournament'
  /** The holder of Longest Route steals a card from anyone. */
  | 'windfall'
  /** The card's 7. */
  | 'thieves';

export interface AlmanacState {
  /** The deck, top last: cards 0-35 (the dice pair coded (d1-1)*6 + (d2-1)) and the new year (NEW_YEAR). */
  deck: number[];
  /** This turn's card, or null before the draw. */
  card: number | null;
  /** This turn's happening, or null before the draw (and when the dice-setting venture voided a 7). */
  happening: Happening | null;
}

export type AlmanacAction =
  /** The Road Splits: crack one of your roads. */
  | { type: 'almanac/crack'; edge: number }
  /** Mirror Bay, Harvest Home, The Joust: the resource you take. */
  | { type: 'almanac/take'; resource: Resource }
  /** Over the Fence (to the player on your left) or Shoulder to the Wheel (to a player with fewer points). */
  | { type: 'almanac/give'; card: Card; to: PlayerId }
  /** Tug-of-War or The Fallen Purse: the player you steal from. */
  | { type: 'almanac/rob'; victim: PlayerId; oil?: boolean }
  /** Mend a cracked road of yours (1 brick + 1 wood). */
  | { type: 'almanac/repair'; edge: number };

export type AlmanacEvent =
  /** The card drawn for the roll. `happening` is null when the dice-setting venture voided its 7. */
  | { type: 'almanac/drawn'; player: PlayerId; card: number; dice: [number, number]; happening: Happening | null; settled: boolean }
  /** The new year came up: the deck was rebuilt and shuffled. */
  | { type: 'almanac/newYear' }
  /** A happening that found nobody to act on. */
  | { type: 'almanac/nothing'; happening: Happening }
  | { type: 'almanac/took'; player: PlayerId; resource: Resource; happening: Happening }
  | { type: 'almanac/gave'; from: PlayerId; to: PlayerId; card: Card; happening: Happening }
  | { type: 'almanac/cracked'; player: PlayerId; edge: number }
  | { type: 'almanac/repaired'; player: PlayerId; edge: number }
  | { type: 'almanac/robberFled'; from: number; to: number | null }
  | { type: 'almanac/corsairFled'; from: number };
