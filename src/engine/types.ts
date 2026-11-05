// Core data model: board, players, cards, actions and events.
// The engine is pure and deterministic: no DOM, no timers, no Math.random.
//
// Rule modules (src/engine/modules/*) add their own state under GameState.ext, their own actions
// and events (namespaced 'module/…'), and their own decisions on the pending stack. What several
// modules share lives here: the kinds of card, route pieces on edges, building upgrades, wardens,
// coins and the board's features.

import type { AlmanacAction, AlmanacEvent, AlmanacState, Happening } from './modules/almanac/types';
import type { CaravansAction, CaravansEvent, CaravansState } from './modules/caravans/types';
import type { FisheriesAction, FisheriesEvent, FisheriesState } from './modules/fisheries/types';
import type { FleetAction, FleetEvent, FleetState } from './modules/fleet/types';
import type { GarrisonsAction, GarrisonsEvent, GarrisonsState } from './modules/garrisons/types';
import type { GuildsAction, GuildsEvent, GuildsState } from './modules/guilds/types';
import type { HarbourmasterAction, HarbourmasterEvent, HarbourmasterState } from './modules/harbourmaster/types';
import type { InvasionAction, InvasionEvent, InvasionState } from './modules/invasion/types';
import type { OilAction, OilEvent, OilState } from './modules/oil/types';
import type { RiversAction, RiversEvent, RiversState } from './modules/rivers/types';
import type { SeaAction, SeaEvent, SeaState } from './modules/sea/types';

export type Resource = 'brick' | 'wood' | 'wool' | 'wheat' | 'ore';
export const RESOURCES: readonly Resource[] = ['brick', 'wood', 'wool', 'wheat', 'ore'];

/** Guilds' commodities: paper from forest, cloth from pasture, silver from mountains. */
export type Commodity = 'paper' | 'cloth' | 'silver';
export const COMMODITIES: readonly Commodity[] = ['paper', 'cloth', 'silver'];

/**
 * Everything held as a card: the five resources, the commodities and oil. Which kinds a game
 * uses depends on its modules (see cardKinds in rules.ts); a hand always carries every key, at 0
 * for kinds not in play, so the base game behaves exactly as it did with resources alone.
 */
export type Card = Resource | Commodity | 'oil';
export const CARDS: readonly Card[] = [...RESOURCES, ...COMMODITIES, 'oil'];
export type CardCounts = Record<Card, number>;

import type { CustomMap } from './maps/custom';
import type { BoardSpec } from './board';

export type Terrain =
  | 'hills'
  | 'forest'
  | 'pasture'
  | 'fields'
  | 'mountains'
  | 'desert'
  /** Produces a resource of the owner's choice (Sea Lanes). */
  | 'bounty'
  /** A river's mouth: produces nothing (Rivers). */
  | 'swamp'
  /** Produces fish on its four printed numbers (Fisheries). */
  | 'lake'
  /** The centre the wagon trains run out from (Wagon Trains). */
  | 'oasis'
  /** Where wardens are recruited (Invasion). */
  | 'castle'
  /** Open water: ships sail its edges; numbered sea hexes are fishing grounds. */
  | 'sea';

export type DevCardType = 'knight' | 'roadBuilding' | 'invention' | 'monopoly' | 'victoryPoint';
export type PortType = Resource | 'any';

/** A player's colour: one of the presets (see PLAYER_COLORS and the UI's palette) or a '#rrggbb' of their own. */
export type PlayerColor = string;

export type PlayerId = number;

/** Every rule module; the order is the order their hooks run in. */
export const MODULE_IDS = ['sea', 'guilds', 'garrisons', 'fleet', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

// ---------------------------------------------------------------------------
// Board topology (static for a game)
// ---------------------------------------------------------------------------

/** Pointy-top hex in axial coordinates. Corners are indexed clockwise from the top: N, NE, SE, S, SW, NW. */
export interface Hex {
  id: number;
  q: number;
  r: number;
  /** World-space centre (hex circumradius = 1). +x is east, +z is south. */
  x: number;
  z: number;
  terrain: Terrain;
  /**
   * Production numbers (2-12). Usually one; none on the desert and other unnumbered hexes; two
   * where a feature hex displaced a number; four on the lake. Pollution (Oil) can take some away
   * during a game: read them through numbersOf() in rules.ts, not here.
   */
  numbers: number[];
  /** Vertex ids, clockwise from the top corner. */
  vertices: number[];
  /** Edge ids, clockwise; edge i joins vertices[i] and vertices[(i+1)%6]. Sides: NE, E, SE, SW, W, NW. */
  edges: number[];
  /** Neighbouring hex ids on the board (land and sea). */
  neighbors: number[];
  /** The landmass this hex belongs to (index into Board.islands), or -1 for sea. */
  island: number;
  /** An oil well (Oil): it produces oil, as well as its own resource if it has one. */
  well?: boolean;
}

export interface Vertex {
  id: number;
  x: number;
  z: number;
  /** Hexes meeting here, land and sea. */
  hexes: number[];
  edges: number[];
  neighbors: number[];
  /** Port at this intersection, if any. */
  port: PortType | null;
  /** Touches at least one land hex (buildings stand only on land). */
  land: boolean;
}

export interface Edge {
  id: number;
  a: number;
  b: number;
  hexes: number[];
  /** Borders exactly one land hex: the island's shore (with or without sea hexes modelled). */
  coastal: boolean;
  /** Borders a sea hex: ships may sail here (Sea Lanes). */
  sea: boolean;
  /** Touches a land hex: roads may run here. */
  land: boolean;
}

export interface Port {
  id: number;
  type: PortType;
  edge: number;
  hex: number;
  /** Side index 0-5 of `hex` (NE, E, SE, SW, W, NW). */
  side: number;
  vertices: [number, number];
}

export interface Island {
  id: number;
  hexes: number[];
  /**
   * The home island, where the game starts and the land-bound modules (Invasion, Wagon Trains, Rivers,
   * the lake) live. A map may start on more than one (a fog map's two starting islands).
   */
  home: boolean;
}

export interface River {
  /** River hexes from source to mouth (the last is the swamp). */
  hexes: number[];
  /** Edges the river crosses or meets the sea at: only bridges may stand there. */
  bridgeSites: number[];
}

/** Static features the map generator placed for the modules. */
export interface BoardFeatures {
  rivers?: River[];
  /** The castle hex (Invasion). */
  castle?: number;
  /** The oasis hex and the three intersections its trains start from (Wagon Trains). */
  oasis?: { hex: number; origins: number[] };
  /** Where the robber starts on a map that places it away from the desert (a fog map puts it on the 12). */
  robber?: number;
  /** The sea hex the corsair starts on (Sea Lanes); without one it waits off the board. */
  corsair?: number;
}

/**
 * What a map is played for beyond the base game's points, and what it sets aside for that: Sea
 * Lanes' First Landing ('firstLanding') and Fog ('fog', with its face-down hexes and the face-down
 * number discs, drawn from the end). The module that knows the objective reads it; others ignore it.
 */
export interface MapObjective {
  id: string;
  /** Hexes it concerns (the face-down hexes of a fog map). */
  hexes?: number[];
  /** Number discs it holds back (the face-down pool of a fog map). */
  numbers?: number[];
}

export interface Board {
  hexes: Hex[];
  vertices: Vertex[];
  edges: Edge[];
  ports: Port[];
  /** The desert, if there is one (the robber starts there); null on islands without one. */
  desertHex: number | null;
  islands: Island[];
  features: BoardFeatures;
  /** The map's objectives (absent on the classic island). */
  objectives?: MapObjective[];
}

// ---------------------------------------------------------------------------
// Dynamic state
// ---------------------------------------------------------------------------

type BuildingKind = 'settlement' | 'city';

/** Guilds' improvement tracks. */
export type Track = 'learning' | 'commerce' | 'statecraft';

export interface Building {
  owner: PlayerId;
  kind: BuildingKind;
  /** A city wall (Garrisons). */
  wall?: boolean;
  /** The seat of a guild track (Guilds). */
  seat?: Track;
  /** A foundry (Oil). */
  foundry?: boolean;
  /** A city reduced to a settlement with no settlement piece free: it must be the next one upgraded. */
  lying?: boolean;
}

export type RouteKind = 'road' | 'ship' | 'bridge';

/** A piece on an edge. Roads are the base game's; ships come with Sea Lanes and bridges with Rivers. */
export interface Route {
  owner: PlayerId;
  kind: RouteKind;
  /** Turn it was built (a ship may not move on the turn it was built). */
  builtTurn: number;
  /** Cracked by a quake (Almanac): its owner builds no route pieces until it's repaired. */
  cracked?: boolean;
}

/** A warden (Garrisons, and Invasion's defenders). Stands on an intersection, or on an edge under Invasion. */
export interface Warden {
  id: number;
  owner: PlayerId;
  rank: 1 | 2 | 3;
  mustered: boolean;
  vertex: number | null;
  edge: number | null;
  /** Turn it was last mustered (it may not act that turn). */
  musteredTurn: number;
}

export interface DevCard {
  type: DevCardType;
  /** Global turn number on which this card was bought (setup counts as turn 0). */
  boughtTurn: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: PlayerColor;
  isBot: boolean;
  /** Cards in hand: resources, and commodities and oil where those are in play. */
  hand: CardCounts;
  /** Coins (Rivers, Invasion): tokens, not cards. */
  coins: number;
  devCards: DevCard[];
  playedKnights: number;
  /** Development cards played face-up (excludes unrevealed VP cards). */
  playedDevCards: DevCardType[];
  settlementsLeft: number;
  citiesLeft: number;
  roadsLeft: number;
  /** Cached longest continuous route length. */
  longestRoad: number;
}

export type Phase =
  | 'setupSettlement'
  | 'setupRoad'
  | 'roll'
  | 'discard'
  | 'moveRobber'
  | 'steal'
  | 'main'
  | 'roadBuilding'
  /** The modules' end-of-turn steps (marching, battles, the auction, disasters) before the dice pass. */
  | 'endOfTurn'
  | 'gameOver';

/** Which volunteered trade commitments can still be executed, as checked for a network view. */
export interface TradeReadiness {
  accepted: PlayerId[];
  counters: PlayerId[];
}

export interface TradeOffer {
  id: number;
  proposer: PlayerId;
  /** What the proposer gives. */
  give: CardCounts;
  /** What the proposer wants in return. */
  get: CardCounts;
  /** Optional restriction to specific players; empty = everyone. */
  to: PlayerId[];
  responses: Record<number, 'accepted' | 'rejected'>;
  /** Counter-offers keyed by the countering player (from that player's perspective: they give `give`, receive `get`). */
  counters: Record<number, { give: CardCounts; get: CardCounts }>;
  /**
   * Only network views carry this snapshot: volunteered commitments rechecked against the hands
   * before redaction. It reveals their validity, never card counts, and execution never trusts it.
   */
  readiness?: TradeReadiness;
}

/**
 * Calibration knobs: overrides a preset or the simulation sets. Absent, each module plays its own
 * published default (Invasion's three landings a building, Oil's five lost numbers, and so on).
 */
export interface Knobs {
  /** A city may hold a seat and a foundry together (default: no). */
  stackUpgrades?: boolean;
  /** Landings each settlement or city sets off (Invasion; default 3). */
  landingsPerBuilding?: number;
  /** Whether a guild improvement sets off a landing (Invasion with the guilds; default yes). */
  improvementLandings?: boolean;
  /** Prisoners per victory point (Invasion; default 2, or 3 alongside the guilds), and how many go back for a point token when raiders never run out. */
  prisonersPerPoint?: number;
  /** Lost numbers that end the game (Oil; default 5). */
  pollutionLimit?: number;
  /** Floods strike one island chosen at random rather than every coast (Oil). Either setting overrides the map; unset, it's yes on maps with several islands. */
  floodOneIsland?: boolean;
  /**
   * Under Invasion with Sea Lanes, the corsair stays: every 7 moves it, and the theft after may
   * take from anyone (All Hands, decision 1). Default no: Invasion takes over the 7's theft and
   * so removes every blocker (rule 4).
   */
  corsairStays?: boolean;
  /** What a Pauper tile costs, in points (Rivers; default 2). */
  pauperPoints?: number;
}

/** The rules version each module in play was created under (see GameOptions.moduleRules). */
export type ModuleRules = Partial<Record<ModuleId, number>>;

export interface GameOptions {
  playerCount: 3 | 4;
  victoryPoints: number;
  layout: 'beginner' | 'random';
  /** Random layouts: numbers along the spiral (default) or shuffled so 6s and 8s stay apart. */
  numberPlacement: 'spiral' | 'balanced';
  /** 0 <= seed < 2^32 (createGame rejects anything else: larger values alias through the 32-bit hash). */
  seed: number;
  /** Friendly robber: it may not be moved next to a building of a player with 2 or fewer visible points (nor steal from them). */
  friendlyRobber: boolean;
  /** Event deck: each roll draws one of the 36 dice combinations instead of rolling; reshuffled when 5 cards remain. */
  eventDeck: boolean;
  /**
   * Rules version the game was created under (see RULES_VERSION). Older versions keep the rules
   * they had where a change would alter a recorded game: 1 = the original beginner start positions,
   * 2 = rotated beginner positions, 3 = discard sampling from public data.
   */
  rules: number;
  /** Rule modules in play (none for the base game), in MODULE_IDS order. */
  modules: ModuleId[];
  /**
   * The rules version each module in play was created under: exactly the modules in `modules`, each
   * an integer from 1 to that module's current `rulesVersion` (createGame fills in any the caller
   * leaves out with the current one, validateOptions refuses the rest). A module's own code gates
   * old behaviour on it, as `beginnerSet` does on `rules`: read `s.options.moduleRules[id]` and keep
   * what an older version did where a change would alter a recorded game. The core reducer, the
   * shared map code and the order the shapers run in answer to `rules` instead (see
   * docs/module-guide.md, "Versions").
   */
  moduleRules: ModuleRules;
  /** The map: the classic island (laid out by `layout`), a named map for the modules, or 'custom' (drawn in the map editor: `custom`). */
  map: string;
  /** The custom map, carried whole (present exactly when `map` is 'custom'). */
  custom?: CustomMap;
  /**
   * The board, dealt once when the game was set up (dealBoard, maps/deal.ts) and carried whole:
   * createGame builds it as it is and deals nothing, so a save or a replay never depends on how
   * maps are dealt. Without one, createGame deals the board these options would carry. `map`
   * still names the kind of island it is.
   */
  board?: BoardSpec;
  /** Overrides of the calibration knobs. */
  knobs: Partial<Knobs>;
  /**
   * The random stream: mulberry32 (local games, saves and replays) or a ChaCha20 stream keyed by
   * a secret only the server holds (online games; see keyedRng.ts). Absent: mulberry32.
   */
  rng?: 'mulberry32' | 'chacha20';
}

/** Each module's state, present when the module is in play. */
interface ModuleStates {
  sea?: SeaState;
  guilds?: GuildsState;
  garrisons?: GarrisonsState;
  fleet?: FleetState;
  invasion?: InvasionState;
  rivers?: RiversState;
  caravans?: CaravansState;
  fisheries?: FisheriesState;
  oil?: OilState;
  almanac?: AlmanacState;
  harbourmaster?: HarbourmasterState;
}

/**
 * A decision someone owes before play goes on: a bounty-field pick, a displaced warden's retreat,
 * venture cards to discard, an auction bid. The top of GameState.pending is resolved first; while
 * it's there, only the actions its module allows for it are legal.
 */
export interface Pending {
  /** Namespaced kind, e.g. 'sea/bountyPick'. */
  kind: string;
  /** Who may act on it (all of them must, unless the module says otherwise). */
  players: PlayerId[];
  /** Module-specific details. */
  data?: unknown;
}

export interface GameState {
  version: 1;
  options: GameOptions;
  board: Board;
  players: PlayerState[];
  /** buildings[vertexId] */
  buildings: (Building | null)[];
  /** routes[edgeId]: the road, ship or bridge on that edge. */
  routes: (Route | null)[];
  /** The robber's hex, or null while it's off the board. */
  robberHex: number | null;
  bank: CardCounts;
  devDeck: DevCardType[];
  phase: Phase;
  /** Phase to return to after a robber/steal/road-building interlude that began before rolling. */
  resumePhase: 'roll' | 'main' | null;
  currentPlayer: PlayerId;
  /** Seat that took the first turn (winner of the start roll). */
  firstPlayer: PlayerId;
  /** Global turn counter; 0 during setup, 1 for the first regular turn. */
  turn: number;
  setupRound: 1 | 2;
  /** Index into setupOrder for the current setup placement. */
  setupIndex: number;
  setupOrder: PlayerId[];
  lastSetupSettlement: number | null;
  dice: [number, number] | null;
  hasRolled: boolean;
  devCardPlayedThisTurn: boolean;
  pendingDiscards: Record<number, number>;
  stealCandidates: PlayerId[];
  freeRoadsLeft: number;
  longestRoadHolder: PlayerId | null;
  largestArmyHolder: PlayerId | null;
  trade: TradeOffer | null;
  nextTradeId: number;
  winner: PlayerId | null;
  rngState: number;
  /** The ChaCha20 key (64 hex digits) of a 'chacha20' game: only ever in the server's state (redactState strips it). */
  rngKey?: string;
  /** Event deck games: the cards still to draw (each a dice pair coded (d1-1)*6 + (d2-1)), top last. */
  eventCards?: number[];
  /**
   * What each seat can know about every hand (see tracker.ts): per viewer (the last row is the
   * public view), per player, the cards known for certain and the expected count of each kind.
   */
  tracker?: number[];
  /** Monotonic action counter (useful for networking / replays). */
  seq: number;
  /**
   * The state before the last piece this player placed, while they may still take it back (see
   * the 'undo' action): any other action clears it. Its own `undo` holds the piece before, so
   * several builds in a turn come back one at a time. A bank trade can be taken back the same way.
   * Answers to the player's own trade offer don't clear it.
   */
  undo: { player: PlayerId; before: GameState } | null;
  /** Decisions owed before play goes on (top last). Empty in the base game. */
  pending: Pending[];
  /** Resources bought with coins this turn (at most two). */
  coinBuys: number;
  /** The next end-of-turn step to run while phase is 'endOfTurn'. */
  endStep: number;
  /**
   * The production number while the roll waits on decisions its happenings left owed (a quake's
   * cracked road, a gift): phase stays 'roll', and production or the 7 follows once they're made.
   * Absent otherwise.
   */
  productionOwed?: number;
  /** Wardens on the board (Garrisons, Invasion). */
  wardens: Warden[];
  /**
   * The id the next warden takes: one counter for every module that places wardens (newWardenId
   * in modules/shared.ts), so ids stay unique whichever module places them. Absent until the first.
   */
  nextWardenId?: number;
  /** Module state. */
  ext: ModuleStates;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type BaseAction =
  | { type: 'placeSetupSettlement'; vertex: number }
  | { type: 'placeSetupRoad'; edge: number }
  | { type: 'rollDice' }
  | { type: 'discard'; resources: CardCounts }
  | { type: 'moveRobber'; hex: number }
  /** `oil`: take one oil by name rather than a card at random (Oil, where the thief has room). */
  | { type: 'steal'; victim: PlayerId; oil?: boolean }
  | { type: 'buildRoad'; edge: number }
  | { type: 'buildSettlement'; vertex: number }
  | { type: 'buildCity'; vertex: number }
  | { type: 'buyDevCard' }
  | { type: 'playKnight' }
  | { type: 'playRoadBuilding' }
  | { type: 'playInvention'; resources: Resource[] }
  | { type: 'playMonopoly'; resource: Resource }
  | { type: 'placeFreeRoad'; edge: number }
  | { type: 'skipFreeRoads' }
  | { type: 'bankTrade'; give: Card; get: Card; times?: number }
  | { type: 'offerTrade'; give: CardCounts; get: CardCounts; to?: PlayerId[] }
  /** `offer`: the id of the offer answered (online play sends it; refused when another offer is open). */
  | { type: 'respondTrade'; accept: boolean; offer?: number }
  | { type: 'counterTrade'; give: CardCounts; get: CardCounts; offer?: number }
  | { type: 'acceptTrade'; partner: PlayerId; counter?: boolean; offer?: number }
  | { type: 'cancelTrade'; offer?: number }
  | { type: 'endTurn' }
  /** Take back the last road, settlement, city or bank trade (nothing has happened since). */
  | { type: 'undo' }
  /** Coins (Rivers, Invasion): two coins buy a resource from the bank, at most twice a turn. */
  | { type: 'buyWithCoins'; get: Resource }
  /** Coins: sell cards to the bank for coins, a coin for each card the bank would give at your rate. */
  | { type: 'sellForCoins'; give: Card; times?: number };

export type ModuleAction =
  | SeaAction
  | GuildsAction
  | GarrisonsAction
  | FleetAction
  | InvasionAction
  | RiversAction
  | CaravansAction
  | FisheriesAction
  | OilAction
  | AlmanacAction
  | HarbourmasterAction;

export type Action = BaseAction | ModuleAction;

// ---------------------------------------------------------------------------
// Events (consumed by the presentation layer for animation and logs)
// ---------------------------------------------------------------------------

export interface Production {
  player: PlayerId;
  hex: number;
  vertex: number;
  resource: Card;
  amount: number;
}

type BaseEvent =
  | { type: 'firstPlayerChosen'; player: PlayerId; rolls: { player: PlayerId; dice: [number, number] }[][] }
  | { type: 'setupSettlementPlaced'; player: PlayerId; vertex: number }
  | { type: 'setupRoadPlaced'; player: PlayerId; edge: number }
  | { type: 'startingResources'; player: PlayerId; vertex: number; grants: { hex: number; resource: Card }[] }
  | { type: 'turnStarted'; player: PlayerId; turn: number }
  | { type: 'diceRolled'; player: PlayerId; dice: [number, number]; total: number }
  | { type: 'production'; total: number; grants: Production[]; blockedHexes: number[]; shortages: Card[] }
  | { type: 'noProduction'; total: number }
  | { type: 'discardRequired'; players: Record<number, number> }
  | { type: 'discarded'; player: PlayerId; resources: CardCounts }
  | { type: 'robberMoved'; player: PlayerId; from: number | null; to: number }
  /** A theft. `by` names what did it when it wasn't a blocker moved for it (the robber, the corsair). */
  /** `named`: the thief named what they took (oil, openly), so the whole table knows the card. */
  | { type: 'stolen'; thief: PlayerId; victim: PlayerId; resource: Card; by?: StealCause; named?: true }
  | { type: 'nothingToSteal'; player: PlayerId }
  | { type: 'roadBuilt'; player: PlayerId; edge: number; free: boolean }
  | { type: 'settlementBuilt'; player: PlayerId; vertex: number }
  | { type: 'cityBuilt'; player: PlayerId; vertex: number }
  | { type: 'devCardBought'; player: PlayerId; card: DevCardType }
  | { type: 'devCardPlayed'; player: PlayerId; card: DevCardType }
  | { type: 'monopoly'; player: PlayerId; resource: Resource; taken: Record<number, number> }
  | { type: 'invention'; player: PlayerId; resources: Resource[] }
  /** `undo`: a bank trade taken back (the cards go the other way). */
  | { type: 'bankTraded'; player: PlayerId; give: Card; giveCount: number; get: Card; getCount: number; undo?: true }
  | { type: 'tradeOffered'; offer: TradeOffer }
  | { type: 'tradeResponded'; player: PlayerId; accept: boolean }
  | { type: 'tradeCountered'; player: PlayerId; give: CardCounts; get: CardCounts }
  | { type: 'tradeExecuted'; from: PlayerId; to: PlayerId; give: CardCounts; get: CardCounts }
  | { type: 'tradeCancelled'; player: PlayerId }
  | { type: 'longestRoadChanged'; from: PlayerId | null; to: PlayerId | null; length: number }
  | { type: 'largestArmyChanged'; from: PlayerId | null; to: PlayerId | null; knights: number }
  | { type: 'freeRoadsFinished'; player: PlayerId }
  | { type: 'turnEnded'; player: PlayerId }
  /** A piece taken back: `refund` returns to the player from the supply, `returned` goes back (a set-up settlement's starting cards). */
  | { type: 'undone'; player: PlayerId; kind: 'road' | 'settlement' | 'city'; at: number; refund: CardCounts; returned: CardCounts }
  /** Coins changed hands (positive: to the player); `piece` is what was built by or moved off a river. */
  | { type: 'coins'; player: PlayerId; amount: number; reason: CoinReason; piece?: 'settlement' | 'city' | 'road' | 'ship'; setup?: true }
  /** Cards traded with the bank for coins, or coins for a card. */
  | { type: 'coinTraded'; player: PlayerId; card: Card; cards: number; coins: number; bought: boolean }
  /**
   * Cards moved in the open by an expansion's move: a cost paid, a pick from the supply, a card
   * handed over (`from`/`to` null: the supply). The card tracker follows these.
   */
  | { type: 'cardsMoved'; from: PlayerId | null; to: PlayerId | null; cards: CardCounts; reason: CardMoveReason }
  | { type: 'gameWon'; player: PlayerId; points: number }
  /** The game ended with no winner (Oil: the island was lost). */
  | { type: 'gameLost'; reason: string };

/** Why cards moved in the open (`cardsMoved`): a cost paid, a pick or take from the supply, a card handed over. */
export type CardMoveReason =
  // Costs paid to the supply.
  | 'ship' | 'bridge' | 'wall' | 'recruit' | 'promotion' | 'muster' | 'march' | 'muster card' | 'improvement' | 'charter' | 'foundry' | 'burn' | 'repair' | 'auction'
  // Taken from the supply.
  | 'bounty' | 'found' | 'fish' | 'learning' | 'invention' | 'waterworks' | 'deepSeams' | 'salvage' | 'pilot' | 'stockpile'
  // Between players, or lost to the supply.
  | 'monopoly' | 'unrest' | 'tribute' | 'barter' | 'dowry' | 'cornerMarket' | 'cartel' | 'customs'
  // The Almanac's takings and gifts.
  | Happening;

/** Why coins changed hands (`coins`). */
export type CoinReason = 'river' | 'bridge' | 'riverLeft' | 'battle' | 'wardenLost' | 'ransom' | 'turncoat' | 'rightOfWay';

/** What made a theft when no blocker moved for it: fish, the Almanac, a warden's chase, a venture, or a 7 with no blocker (Invasion). */
export type StealCause = 'fish' | 'almanac' | 'warden' | 'venture' | 'seven';

export type ModuleEvent =
  | SeaEvent
  | GuildsEvent
  | GarrisonsEvent
  | FleetEvent
  | InvasionEvent
  | RiversEvent
  | CaravansEvent
  | FisheriesEvent
  | OilEvent
  | AlmanacEvent
  | HarbourmasterEvent;

export type GameEvent = BaseEvent | ModuleEvent;

export interface ActionResult {
  ok: true;
  state: GameState;
  events: GameEvent[];
}

export interface ActionError {
  ok: false;
  error: string;
}
