// What of each event and action a seat may see, for networked play. The server sends every seat
// only eventsFor(events, seat) and actionFor(action, actor, seat): the presenter needs no more,
// and the fields these blank are exactly the secrets an event carries (a stolen card, a card
// drawn, a fish's value). Spectators (viewer null) see what any seat that isn't involved sees.
//
// Every kind of event has a rule in VISIBILITY, and the table is typed over every GameEvent kind
// (the base game's and every module's), so a new kind of event doesn't compile until it has one.
// Six fields are secret: the rest of every event is public by the rules (a discard, a monopoly's
// takings, a venture played face up, a bid laid down, a gift, a hex turned up).

import type { Action, GameEvent, PlayerId } from './types';

export type Viewer = PlayerId | null;

type Kind = GameEvent['type'];
type EventOf<K extends Kind> = Extract<GameEvent, { type: K }>;

/** An event of kind K with fields F kept from the viewer: they may be missing, never wrong. */
type Hiding<K extends Kind, F extends keyof EventOf<K>> = Omit<EventOf<K>, F> & { [P in F]?: never };

/**
 * An event as a viewer received it: the same shape, with the secret fields (if any) left out.
 * The presenter treats a missing field as a card face down.
 */
export type WireEvent =
  | GameEvent
  | Hiding<'stolen', 'resource'>
  | Hiding<'devCardBought', 'card'>
  | Hiding<'guilds/drew', 'card'>
  | Hiding<'guilds/ventureTaken', 'card'>
  | Hiding<'fisheries/drew', 'value'>
  | Hiding<'fisheries/card', 'card'>;

/** 'public': everyone sees it whole. A function: what `viewer` sees of it. */
export type VisibilityRule<K extends Kind> = 'public' | ((e: EventOf<K>, viewer: Viewer) => WireEvent);

/** One rule for every kind of event (a kind left out doesn't compile). */
export type VisibilityTable = { readonly [K in Kind]: VisibilityRule<K> };

function omit<E extends object, F extends keyof E>(e: E, ...keys: F[]): Omit<E, F> {
  const o = { ...e };
  for (const k of keys) delete o[k];
  return o;
}

/** For the eyes of `who` alone (whoever else looks sees the event without `field`). */
const own =
  <K extends Kind, F extends keyof EventOf<K>>(field: F, who: (e: EventOf<K>) => readonly PlayerId[]) =>
  (e: EventOf<K>, viewer: Viewer): WireEvent =>
    viewer !== null && who(e).includes(viewer) ? (e as WireEvent) : (omit(e, field) as unknown as WireEvent);

export const VISIBILITY: VisibilityTable = {
  // ---------------------------------------------------------------- the base game
  firstPlayerChosen: 'public',
  setupSettlementPlaced: 'public',
  setupRoadPlaced: 'public',
  startingResources: 'public',
  turnStarted: 'public',
  diceRolled: 'public',
  production: 'public',
  noProduction: 'public',
  discardRequired: 'public',
  // Discards are face up (R8): the card tracker counts them as public knowledge, and the client
  // shows them face up to everyone.
  discarded: 'public',
  robberMoved: 'public',
  // Only the thief and the victim know the card taken, unless it was named (oil, openly).
  stolen: (e, viewer) => (e.named || viewer === e.thief || viewer === e.victim ? e : omit(e, 'resource')),
  nothingToSteal: 'public',
  roadBuilt: 'public',
  settlementBuilt: 'public',
  cityBuilt: 'public',
  devCardBought: own('card', (e) => [e.player]),
  devCardPlayed: 'public',
  // (Hoarder reveals what each hand held of the kind: by rule.)
  monopoly: 'public',
  invention: 'public',
  bankTraded: 'public',
  tradeOffered: 'public',
  tradeResponded: 'public',
  tradeCountered: 'public',
  tradeExecuted: 'public',
  tradeCancelled: 'public',
  longestRoadChanged: 'public',
  largestArmyChanged: 'public',
  freeRoadsFinished: 'public',
  turnEnded: 'public',
  undone: 'public',
  coins: 'public',
  coinTraded: 'public',
  // Moves in the open: costs, picks from the supply, gifts, tribute, barter, Corner Market, Cartel
  // (a secret move, a theft, is a `stolen` instead).
  cardsMoved: 'public',
  gameWon: 'public',
  gameLost: 'public',

  // ---------------------------------------------------------------- Sea Lanes
  'sea/shipBuilt': 'public',
  'sea/shipMoved': 'public',
  'sea/corsairMoved': 'public',
  'sea/bountyOwed': 'public',
  'sea/bountyPicked': 'public',
  'sea/firstLanding': 'public',
  // (A face-down hex turned up: everyone sees it, and the number it took.)
  'sea/hexRevealed': 'public',

  // ---------------------------------------------------------------- Guilds
  'guilds/eventDie': 'public',
  'guilds/drew': own('card', (e) => [e.player]),
  'guilds/shown': 'public',
  'guilds/improved': 'public',
  'guilds/seat': 'public',
  'guilds/played': 'public',
  // (Put back face down: the event never says which.)
  'guilds/ventureDiscarded': 'public',
  'guilds/trader': 'public',
  'guilds/charter': 'public',
  'guilds/lit': 'public',
  'guilds/numbersSwapped': 'public',
  'guilds/routeRemoved': 'public',
  'guilds/raiderCaptured': 'public',
  'guilds/ventureTaken': own('card', (e) => [e.thief, e.victim]),

  // ---------------------------------------------------------------- Garrisons
  'garrisons/recruited': 'public',
  'garrisons/promoted': 'public',
  'garrisons/mustered': 'public',
  'garrisons/wall': 'public',
  'garrisons/marched': 'public',
  'garrisons/displaced': 'public',
  'garrisons/retreated': 'public',
  'garrisons/removed': 'public',
  'garrisons/chased': 'public',
  'garrisons/placed': 'public',

  // ---------------------------------------------------------------- the raider fleet
  'fleet/advanced': 'public',
  'fleet/attack': 'public',
  'fleet/pillaged': 'public',
  'fleet/ransomed': 'public',
  'fleet/token': 'public',
  // (The ventures the tied draw come as guilds/drew, each for its drawer's eyes.)
  'fleet/tied': 'public',
  'fleet/blockersIn': 'public',

  // ---------------------------------------------------------------- Invasion
  'invasion/landed': 'public',
  'invasion/supplyEmpty': 'public',
  'invasion/prisonersTraded': 'public',
  'invasion/bought': 'public',
  // (A muster card is played the moment it's drawn: face up.)
  'invasion/drew': 'public',
  'invasion/wardenRaised': 'public',
  'invasion/captured': 'public',
  'invasion/raidersLed': 'public',
  'invasion/marched': 'public',
  'invasion/displaced': 'public',
  'invasion/retreated': 'public',
  'invasion/halted': 'public',
  'invasion/battle': 'public',
  'invasion/losses': 'public',

  // ---------------------------------------------------------------- Rivers
  'rivers/bridgeBuilt': 'public',
  'rivers/wealthChanged': 'public',

  // ---------------------------------------------------------------- Wagon Trains (bids are face up)
  'caravans/auctionOpened': 'public',
  'caravans/auctionSkipped': 'public',
  'caravans/bid': 'public',
  'caravans/passed': 'public',
  'caravans/voted': 'public',
  'caravans/toPlace': 'public',
  'caravans/bidsPaid': 'public',
  'caravans/wagonPlaced': 'public',

  // ---------------------------------------------------------------- Fisheries
  'fisheries/drew': own('value', (e) => [e.player]),
  'fisheries/bootDrawn': 'public',
  'fisheries/reshuffled': 'public',
  'fisheries/supplyEmpty': 'public',
  'fisheries/full': 'public',
  // (A token returned is turned face up; tokens spent are paid face up.)
  'fisheries/swapped': 'public',
  'fisheries/spent': 'public',
  'fisheries/blockerRemoved': 'public',
  'fisheries/took': 'public',
  // (A free development card: its kind is the taker's secret, as when one is bought.)
  'fisheries/card': own('card', (e) => [e.player]),
  'fisheries/bootPassed': 'public',

  // ---------------------------------------------------------------- Oil (all face up)
  'oil/produced': 'public',
  'oil/startingOil': 'public',
  'oil/burned': 'public',
  'oil/foundryBuilt': 'public',
  'oil/sequestered': 'public',
  'oil/stewardChanged': 'public',
  'oil/monopoly': 'public',
  'oil/invention': 'public',
  'oil/disaster': 'public',
  'oil/flood': 'public',
  'oil/polluted': 'public',
  'oil/wellPolluted': 'public',
  'oil/spared': 'public',
  'oil/islandLost': 'public',

  // ---------------------------------------------------------------- the Almanac
  // (The card drawn for the roll is turned face up; gifts and takings are moves in the open.)
  'almanac/drawn': 'public',
  'almanac/newYear': 'public',
  'almanac/nothing': 'public',
  'almanac/took': 'public',
  'almanac/gave': 'public',
  'almanac/cracked': 'public',
  'almanac/repaired': 'public',
  'almanac/robberFled': 'public',
  'almanac/corsairFled': 'public',

  // ---------------------------------------------------------------- Port Captain
  'harbourmaster/changed': 'public',
};

/**
 * The events as `viewer` may see them. (An event of a kind without a rule, which only a cast past
 * the types could make, goes out as its kind alone.)
 */
export function eventsFor(events: readonly GameEvent[], viewer: Viewer): WireEvent[] {
  return events.map((e) => {
    const rule = (VISIBILITY as Record<string, VisibilityRule<Kind> | undefined>)[e.type];
    if (rule === 'public') return e;
    if (rule === undefined) return { type: e.type } as WireEvent;
    return (rule as (e: GameEvent, viewer: Viewer) => WireEvent)(e, viewer);
  });
}

/**
 * An action as `viewer` may see it: whole for its actor, only its type for everyone else. The
 * events say all the table may know of it; and two actions name a secret themselves (the venture
 * put back face down, guilds/discardVenture, and the one a spymaster takes, guilds/takeVenture),
 * as any action a module adds later might.
 */
export function actionFor(action: Action, actor: PlayerId, viewer: Viewer): Action | { type: Action['type'] } {
  return viewer === actor ? action : { type: action.type };
}
