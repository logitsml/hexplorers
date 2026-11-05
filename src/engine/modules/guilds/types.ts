// Guilds: commodities, the three improvement tracks and their seats, the event die, venture cards and the trader.
// Its state, actions and events. Action and event types are namespaced 'guilds/…'.

import type { Card, CardCounts, PlayerId, Resource, Track } from '../../types';

/** The event die's faces: a ship, or one of the three tracks. */
export type EventFace = 'ship' | 'learning' | 'commerce' | 'statecraft';

/**
 * Every venture card, by what it does (each has a name of its own in ventures.ts). Guilds rules 3
 * retired deepSeams, pathfinders, charterFleet and cartel (for salvage, pilot, tradeWind and
 * customs): they stay here so games recorded under the earlier rules still play.
 */
export type VentureId =
  // Learning
  | 'augury'
  | 'hoist'
  | 'masonry'
  | 'resurvey'
  | 'waterworks'
  | 'townPlanning'
  | 'deepSeams'
  | 'pathfinders'
  | 'forge'
  | 'encyclopaedia'
  | 'salvage'
  | 'pilot'
  // Commerce
  | 'barter'
  | 'tribute'
  | 'trader'
  | 'charterFleet'
  | 'cornerMarket'
  | 'cartel'
  | 'tradeWind'
  | 'customs'
  | 'stockpile'
  // Statecraft
  | 'rightOfWay'
  | 'rally'
  | 'spymaster'
  | 'agitators'
  | 'unrest'
  | 'taxCollectors'
  | 'treachery'
  | 'grandCharter'
  | 'dowry'
  | 'lighthouse';

/** A venture card as a seat sees it: 'hidden' when it is in someone else's hand or a deck. */
export type VentureCard = VentureId | 'hidden';

export interface GuildsState {
  /** This turn's event die and red die (set when the dice are rolled; null before). Other modules read it through modules/shared.ts. */
  eventDie: { face: EventFace; red: number } | null;
  /** Each player's level on each track, 0–5. */
  levels: Record<Track, number>[];
  /** Tracks whose seat was taken at level 5 and is held for good. Where each seat stands is on Building.seat. */
  seatsForGood: Track[];
  /** The three venture decks, top last. Played and discarded cards go back underneath. */
  decks: Record<Track, VentureCard[]>;
  /** Each player's venture hand (secret). */
  hands: VentureCard[][];
  /** Victory ventures each player has shown (face up, worth a point each). */
  shown: VentureId[][];
  /** The trader: the hex it stands on and who controls it. */
  trader: { hex: number; owner: PlayerId } | null;
  /** Kinds the player whose turn it is trades 2:1 with the bank this turn (the charter fleet). */
  charter: Card[];
  /** Production dice fixed by the augury for this turn's roll. */
  settled: [number, number] | null;
  /** Whether this turn's production dice were set by the augury (its first die is then the red die). */
  augured: boolean;
  /** Number discs moved by the resurvey: hex id → the numbers it bears now. */
  numbers: Record<number, number[]>;
  /** Whether the player whose turn it is has the trade wind up: every bank rate one better this turn (guilds rules 3 on). */
  wind?: boolean;
  /** The lighthouse: a hex the robber can't be sent to until its owner's next turn begins (guilds rules 3 on). */
  lit?: { hex: number; owner: PlayerId }[];
}

/** How a venture is played: the parameters its card reads (each card uses its own few). */
export interface VentureParams {
  /** The augury: the production dice. */
  dice?: [number, number];
  /** Masonry, town planning: one of your cities or settlements. */
  vertex?: number;
  /** The resurvey: two hexes whose numbers swap. */
  hexes?: [number, number];
  /** The trader, the tax collectors, the lighthouse: a hex. */
  hex?: number;
  /** The charter fleet, the cornered market, the cartel: a kind of card. */
  kind?: Card;
  /** Tribute, spymaster, treachery: another player. */
  target?: PlayerId;
  /** Right of way: an open road. */
  edge?: number;
  /** The forge: one or two of your wardens. */
  wardens?: number[];
  /** Agitators: an opponent's warden. */
  warden?: number;
}

export type GuildsAction =
  /** Climb one level on a track. `hoist` spends a hoist venture for one commodity less; `vertex` is the city that takes the seat, if this level wins it. */
  | { type: 'guilds/improve'; track: Track; hoist?: boolean; vertex?: number }
  | ({ type: 'guilds/play'; card: VentureId } & VentureParams)
  /** Over the venture limit: put one back under its deck. */
  | { type: 'guilds/discardVenture'; card: VentureId }
  /** A card you owe someone (a dowry, a barter): one at a time. */
  | { type: 'guilds/give'; card: Card }
  /** Unrest: one card of the half you lose. */
  | { type: 'guilds/discardCard'; card: Card }
  /** Tribute: one of the cards you take. */
  | { type: 'guilds/take'; card: Card }
  /** Spymaster: the venture you take, or none. */
  | { type: 'guilds/takeVenture'; card: VentureId | null }
  /** The Learning ability: the resource you take (null only when the supply has none). */
  | { type: 'guilds/pick'; resource: Resource | null }
  /** A venture of your choice: the deck you draw from (null only when all three are empty). */
  | { type: 'guilds/draw'; track: Track | null }
  /** Barter: the resource you offer the next player, or none. */
  | { type: 'guilds/offer'; resource: Resource | null }
  /** Right of way: where your free road goes, or none. */
  | { type: 'guilds/rebuild'; edge: number | null }
  /** Treachery: the warden you give up. */
  | { type: 'guilds/surrender'; warden: number }
  /** Treachery: the rank of the warden you put in its place (0: none) and where (null under Invasion: the edge it left). */
  | { type: 'guilds/plant'; rank: 0 | 1 | 2 | 3; vertex: number | null };

/** Decisions the guilds leave owed (on the pending stack), one player each. */
export type GuildsPending =
  | { kind: 'guilds/ventureLimit' }
  | { kind: 'guilds/give'; to: PlayerId; left: number; only: 'cards' | 'commodities'; reason: 'dowry' | 'barter' }
  | { kind: 'guilds/discard'; left: number }
  | { kind: 'guilds/tribute'; target: PlayerId; left: number; seen: CardCounts }
  | { kind: 'guilds/spy'; target: PlayerId; seen: VentureCard[] }
  /** A resource of your choice from the supply (`salvage`: one of the salvage venture's, not the Learning ability's). */
  | { kind: 'guilds/pick'; salvage?: true }
  | { kind: 'guilds/drawChoice' }
  | { kind: 'guilds/barter'; queue: PlayerId[] }
  /** A free rebuild after a right of way took your piece: a ship if it was one. */
  | { kind: 'guilds/rebuild'; ship?: boolean }
  | { kind: 'guilds/surrender'; thief: PlayerId }
  | { kind: 'guilds/plant'; rank: 1 | 2 | 3; mustered: boolean; edge: number | null };

export type GuildsEvent =
  /** The event die and red die for this roll; independentRed distinguishes a card's production pair. */
  | { type: 'guilds/eventDie'; player: PlayerId; face: EventFace; red: number; independentRed: boolean }
  /** A venture drawn into a hand (the card is for its owner's eyes). */
  | { type: 'guilds/drew'; player: PlayerId; track: Track; card: VentureId }
  /** A victory venture shown face up. */
  | { type: 'guilds/shown'; player: PlayerId; card: VentureId }
  | { type: 'guilds/improved'; player: PlayerId; track: Track; level: number }
  /** A track's seat placed or moved (`from`: the city it left); `forGood` once it was won at level 5. */
  /** A track's seat taken (or kept for good): `from` is the city it left and `was` whose it was (null: nobody's yet). */
  | { type: 'guilds/seat'; player: PlayerId; track: Track; vertex: number; from: number | null; was: PlayerId | null; forGood: boolean }
  | { type: 'guilds/played'; player: PlayerId; card: VentureId }
  /** A venture put back face down under its deck. */
  | { type: 'guilds/ventureDiscarded'; player: PlayerId; track: Track }
  /** Cards moved by a venture or an ability (`from`/`to` null: the supply). */
  /** The trader placed (or lost: hex and player null). */
  | { type: 'guilds/trader'; player: PlayerId | null; hex: number | null }
  | { type: 'guilds/charter'; player: PlayerId; card: Card }
  /** The lighthouse lit on a hex: the robber can't come there until its owner's next turn. */
  | { type: 'guilds/lit'; player: PlayerId; hex: number }
  | { type: 'guilds/numbersSwapped'; player: PlayerId; hexes: [number, number] }
  | { type: 'guilds/routeRemoved'; player: PlayerId; owner: PlayerId; edge: number; kind: 'road' | 'ship' }
  /** Agitators under Invasion: a raider taken as a prisoner. */
  | { type: 'guilds/raiderCaptured'; player: PlayerId; hex: number }
  | { type: 'guilds/ventureTaken'; thief: PlayerId; victim: PlayerId; card: VentureId };
