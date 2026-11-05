// The contract between the base engine and a rule module (see docs/expansions.md, "Engine shape").
//
// A module owns its directory: its state (GameState.ext[id]), its actions and events (namespaced
// 'id/…'), its decisions on the pending stack, and its bot. The base reducer calls its hooks at
// fixed points, in MODULE_IDS order across the modules in play. A module never changes the base
// game: with no modules, every hook is absent and the engine plays exactly as before.

import type { BoardSpec } from '../board';
import type { Ctx } from '../ctx';
import type { Rng } from '../rng';
import type { Action, Building, Card, CardCounts, GameOptions, GameState, Hex, ModuleId, Pending, PlayerId, Production } from '../types';
import type { BotCtx } from '../ai/context';

export type PieceKind = 'road' | 'ship' | 'bridge' | 'settlement' | 'city';

export interface EndStep {
  /** Order across modules: march 10, battles 20, auction 30, disaster 40. */
  rank: number;
  /** Runs once per end of turn; may push pending decisions (the step after waits for them). */
  run(ctx: Ctx): void;
}

export interface ModuleHooks {
  // ------------------------------------------------------------------ map and set-up
  /**
   * Shape the map's home island before it's built (rivers, the lake, the oasis, the castle, wells,
   * fishing grounds), by the home island's rules (docs/maps.md): on every map the game deals, and
   * on a player's own map where it doesn't carry the feature already (`maps/deal.ts` calls it;
   * `maps/shape.ts` finds the home island; `maps/features.ts` checks that the result is all there).
   */
  shapeMap?(spec: BoardSpec, options: GameOptions, rng: Rng): void;
  /** Which building the second set-up round places (the guild and invasion games start with a city). */
  setupSecondKind?(s: GameState): 'settlement' | 'city' | undefined;
  /** What a set-up building collects beyond its resources (oil, a fish token, coins). Runs for the second-round building. */
  startingGrants?(ctx: Ctx, player: PlayerId, vertex: number): void;
  /** After any set-up piece is placed (coins for river spots). */
  afterSetupPiece?(ctx: Ctx, player: PlayerId, piece: PieceKind, at: number): void;

  // ------------------------------------------------------------------ the roll
  /** At the start of each turn. */
  turnStarted?(ctx: Ctx): void;
  /**
   * Replace the two production dice: given what earlier modules settled (or undefined), return the
   * dice to show and the production number. The dice-setting venture fixes them; the Almanac draws
   * its card for its happening and supplies the number unless it's already fixed. With nothing
   * returned, the base rolls (or draws from the event deck).
   */
  rollDice?(ctx: Ctx, settled: { dice: [number, number]; total: number } | undefined): { dice: [number, number]; total: number } | undefined;
  /**
   * After the dice, before production: the event die, a happening. It may push decisions: the roll
   * then waits (phase 'roll', GameState.productionOwed set), and production or the 7 follows once
   * the last of them is made.
   */
  afterRoll?(ctx: Ctx, total: number): void;

  // ------------------------------------------------------------------ production
  /** The production numbers a hex still has (pollution takes some away). */
  numbersOf?(s: GameState, hex: Hex, numbers: number[]): number[];
  /** A hex can't produce this roll (conquest, the corsair on a fishing ground). */
  hexBlocked?(s: GameState, hex: Hex): boolean;
  /** Adjust what one building takes from one producing hex. Base grants: the hex's resource, 1 or 2. */
  yields?(s: GameState, hex: Hex, vertex: number, building: Building, grants: Production[]): Production[];
  /**
   * What `afterProduction` would hand `player` on a roll of `total`, worked out by the same code it
   * uses: oil from the wells (within the player's limit), a bounty field's `picks` (resources of the
   * player's choice). Production never calls it: it's for the supply's estimate of income (income.ts).
   */
  afterYields?(s: GameState, player: PlayerId, total: number): { cards?: Partial<CardCounts>; picks?: number } | undefined;
  /**
   * After production is handed out (bounty picks, fish, oil). Returns the players it gave cards to
   * (or owes a pick of cards), so the fall-backs know who received nothing; tokens don't count.
   */
  afterProduction?(ctx: Ctx, total: number, grants: Production[]): void | Iterable<PlayerId>;
  /** Last of all, the fall-backs (rule 6): `received` holds everyone who took cards this roll. */
  productionFallback?(ctx: Ctx, total: number, received: ReadonlySet<PlayerId>): void;

  // ------------------------------------------------------------------ the 7 and the robber
  /** The hand size a 7 leaves alone (walls raise it). */
  handLimit?(s: GameState, player: PlayerId, limit: number): number;
  /**
   * Rule 4: whether this module still holds the blockers off the board (the fleet, until its first
   * attack). While any module says so, a 7 or a Knight moves no blocker and robs nobody, whichever
   * module would otherwise take the robber's step; the discards of a 7 still happen.
   */
  blockersWaiting?(s: GameState): boolean;
  /**
   * Rule 4's other half: a blocker this module's own delay still holds off the board (Fisheries and
   * Oil hold both until the first 7 or Knight card). When another module brings the blockers in
   * (the fleet's first attack), a held one stays off, and enters on a 7 as usual.
   */
  blockerHeld?(s: GameState, blocker: 'robber' | 'corsair'): boolean;
  /** Take over the robber's step after a 7 (or a Knight). Return true if this module handled it. */
  robberStep?(ctx: Ctx, cause: 'seven' | 'knight'): boolean;
  /** The land hexes the robber may move to, given those allowed so far (Fog keeps it off face-down hexes). */
  robberHexes?(s: GameState, hexes: number[]): number[];

  // ------------------------------------------------------------------ building
  /** A player-facing explanation of a refused placement; diagnostic only, never a rule gate. */
  placeReason?(s: GameState, player: PlayerId, piece: PieceKind, at: number): string;
  /** Extra conditions on placing a piece. Return false to forbid. */
  canPlace?(s: GameState, player: PlayerId, piece: PieceKind, at: number): boolean;
  /**
   * After a piece is placed in play, in three stages across the modules (rule 7): the builder's
   * rewards, then awards recalculated, then threats (landings, nests). Victory is checked after.
   */
  afterBuild?(ctx: Ctx, player: PlayerId, piece: PieceKind, at: number, stage: 'reward' | 'award' | 'threat'): void;
  /** Whether `player` still has somewhere to put a free route piece (ships count with Sea Lanes). */
  canPlaceFreeRoute?(s: GameState, player: PlayerId): boolean;
  /**
   * Extra conditions on moving a route piece (a ship) from edge `from` to edge `to`. Return false to
   * forbid (a ship leaving a river edge needs a coin). The moving module asks through rules.moveAllowed.
   */
  canMove?(s: GameState, player: PlayerId, piece: PieceKind, from: number, to: number): boolean;
  /** After a route piece has moved (fees, rewards). The moving module runs these through reducer.moved. */
  afterMove?(ctx: Ctx, player: PlayerId, piece: PieceKind, from: number, to: number): void;
  /** Whether `player` may hold this hand (Oil's limit); checked when a trade would give them cards. */
  handAllowed?(s: GameState, player: PlayerId, hand: CardCounts): boolean;

  // ------------------------------------------------------------------ routes and points
  /** Whether `vertex` breaks `player`'s route (beyond an opponent's building). */
  breaksRoute?(s: GameState, player: PlayerId, vertex: number): boolean;
  /** Extra length `edge` adds to `player`'s route beyond its 1 (a wagon over it). */
  routeBonus?(s: GameState, player: PlayerId, edge: number): number;
  /** A building's worth, given its worth so far (a seat adds 2, a foundry 1, a wagon point 1; conquest makes it 0). */
  buildingWorth?(s: GameState, vertex: number, worth: number): number;
  /** Public points this module gives `player` beyond its buildings. */
  victoryPoints?(s: GameState, player: PlayerId): number;
  /** `player`'s target, given the game's (the boot adds one). The bots plan against it too. */
  victoryTarget?(s: GameState, player: PlayerId, target: number): number;

  // ------------------------------------------------------------------ trading
  /** Bank ratios, given the harbours' (commodities, the Commerce ability, the trader). Infinity: no trade. */
  tradeRatios?(s: GameState, player: PlayerId, ratios: Record<Card, number>): Record<Card, number>;

  // ------------------------------------------------------------------ one deck (rule 3)
  /**
   * When this module's deck replaces the development cards (the guilds' venture decks, Invasion's
   * muster deck): the decks a free card may come from right now, by name, leaving out empty ones.
   * Undefined from a module whose deck doesn't replace them. Asked, in module order, by anything
   * that grants "a development card" (Fisheries' seven fish); the first answer wins, and with none
   * the card is the top of the base deck.
   */
  freeCardDecks?(s: GameState): string[] | undefined;
  /** Deal `player` the top card of `deck` (one of this module's freeCardDecks) for free, with its event. */
  dealFreeCard?(ctx: Ctx, player: PlayerId, deck: string): void;

  /** After every action (and the end-of-turn steps it set off), for anything owed once an action is done. */
  afterAction?(ctx: Ctx): void;
  /**
   * Recalculate the awards this module keeps (the harbour award, the wealth tiles, a trader lost to
   * conquest). Run after every action and before every victory check, so a win is decided on the
   * awards as they stand, whatever moved them: a build, a landing, a flood, a battle.
   */
  awards?(ctx: Ctx): void;

  // ------------------------------------------------------------------ the end of a turn
  /** End-of-turn steps (see EndStep). */
  endOfTurn?: EndStep[];

  // ------------------------------------------------------------------ hidden information
  /** Hide what `viewer` may not know in this module's state (the copy is already detached). */
  redact?(s: GameState, viewer: PlayerId | null): void;
}

export interface ModuleBot {
  /** The bot's answer when the top pending decision is this module's and it owes it. */
  pending?(ctx: BotCtx, p: Pending): Action | null;
  /** Something worth doing before rolling (fish, the dice venture). */
  beforeRoll?(ctx: BotCtx): Action | null;
  /** A main-phase action worth taking now, or null (asked before the base planner). */
  main?(ctx: BotCtx): Action | null;
  /** The bot's end-of-turn moves while its own end-of-turn step waits on it. */
  endOfTurn?(ctx: BotCtx): Action | null;
  /**
   * What a building at `vertex` would keep bringing this bot beyond its resources (fish, oil), in
   * the pips of an average resource. Added to the base scorer's value of the spot in set-up and
   * when expanding, and once more to a city upgrade's.
   */
  spotValue?(ctx: BotCtx, vertex: number): number;
  /**
   * What building at `vertex` is worth to the bot beyond its production and harbour's trade, in
   * victory-point equivalents (a coin for a river corner, progress toward the harbour award).
   * Added in set-up and when weighing settlement spots, never to a city upgrade.
   */
  spotBonus?(ctx: BotCtx, vertex: number): number;
  /**
   * The opening route piece to place instead of the base bot's road (a starting ship), given the
   * best road's score on set-up's scale (see ai/setup.ts), or null for the road.
   */
  setupRoute?(ctx: BotCtx, roadScore: number): Action | null;
  /** A free route piece worth placing during Road Crew (a ship), asked before the base bot's road. */
  freeRoute?(ctx: BotCtx): Action | null;
  /**
   * Worth this module's plans see in `hand` beyond what the base planner scores (commodities toward
   * improvements, say), in the base hand score's units. Added to BotCtx.scoreHand, so it steers
   * discards on a 7, trades and every other choice that compares hands.
   */
  handValue?(ctx: BotCtx, hand: CardCounts): number;
}

export interface RuleModule {
  id: ModuleId;
  /**
   * The module's current rules version, from 1. Bump it when a change to this module's own code (its
   * init, hooks, shapeMap, actions, legal moves) would alter a game recorded under the old code, and
   * keep the old behaviour behind `s.options.moduleRules[id]`, the version a game was created under
   * (stamped in saves), the way `beginnerSet` keeps rules 1's positions behind `options.rules`. A
   * bump touches only the games that have this module, so base games and other mixes replay as
   * they were. The core reducer, the shared map code in `maps/` and the order the shapers run in
   * are versioned by RULES_VERSION instead; so are the helpers shared between modules (`shared.ts`).
   */
  rulesVersion: number;
  /** Modules this one needs alongside it. */
  requires?: ModuleId[];
  /** Modules it can't share a game with (two invaders). */
  excludes?: ModuleId[];
  /** Victory is checked only at the end of the active player's turn (disasters can take points away). */
  endOfTurnVictory?: boolean;
  /** Fill state.ext[id], add to the bank, adjust the board's starting pieces. Runs after the base state exists. */
  init?(s: GameState, rng: Rng): void;
  /** The module's own actions ('id/…'). Throws a RuleError (via fail/assert) to refuse. */
  handle?(ctx: Ctx, player: PlayerId, action: Action): void;
  /** Every concrete module action `player` may take right now (for bots, the fuzzer and the interface). */
  legal?(s: GameState, player: PlayerId): Action[];
  hooks?: ModuleHooks;
  bot?: ModuleBot;
  /** Consistency checks for tests and simulation (pieces conserved, counters in range): each problem as a message. */
  invariants?(s: GameState): string[];
}
