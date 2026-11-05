// Read-only rule queries shared by the reducer, the AI and the UI. Where a rule module can change a
// rule, the query folds in its hooks (see modules/api.ts); with no modules each query is the base game's.

import { COSTS, FRIENDLY_ROBBER_MAX_VP, PIPS, isLand, type BuildKind } from './constants';
import { memo, Query } from './memo';
import { modulesOf } from './modules';
import type { PieceKind } from './modules/api';
import type { Board, Card, CardCounts, GameState, Hex, PlayerId, RouteKind } from './types';
import { CARDS, COMMODITIES, RESOURCES } from './types';

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const kindsCache = new WeakMap<object, Card[]>();

/** The kinds of card in play: the five resources, plus commodities with the guilds and oil with Oil. */
export function cardKinds(s: GameState): Card[] {
  let kinds = kindsCache.get(s.options);
  if (!kinds) {
    kinds = [...RESOURCES];
    if (s.options.modules.includes('guilds')) kinds.push(...COMMODITIES);
    if (s.options.modules.includes('oil')) kinds.push('oil');
    kindsCache.set(s.options, kinds);
  }
  return kinds;
}

/** Kinds a theft takes at random from (oil is taken only by name). */
export function stealableKinds(s: GameState): Card[] {
  return cardKinds(s).filter((k) => k !== 'oil');
}

export const totalCards = (rc: CardCounts): number => {
  let n = 0;
  for (const k of CARDS) n += rc[k];
  return n;
};

/** Whether this game has coins (Rivers, Invasion). */
export const usesCoins = (s: GameState): boolean => s.options.modules.includes('rivers') || s.options.modules.includes('invasion');

/** Coins buy at most this many resources a turn. */
export const COIN_BUYS_PER_TURN = 2;
/** Coins a resource costs. */
export const COINS_PER_RESOURCE = 2;

/** Cards in `player`'s hand that a theft can take at random. */
export function stealableCount(s: GameState, player: PlayerId): number {
  const hand = s.players[player].hand;
  let n = 0;
  for (const k of stealableKinds(s)) n += hand[k];
  return n;
}

export function hasResources(have: CardCounts, need: CardCounts): boolean {
  return CARDS.every((r) => have[r] >= need[r]);
}

/**
 * An offer that asks nothing in particular: cards put up for whatever the others will give. It's
 * answered only with counter-offers (bids), never accepted as it stands.
 */
export const isOpenOffer = (t: { get: CardCounts }): boolean => CARDS.every((r) => t.get[r] === 0);

/**
 * Whether the game has development cards at all: a module that brings its own deck (the guilds'
 * ventures, the invasion's muster cards) empties theirs before the first turn, and nobody ever holds one.
 */
export function devCardsInGame(state: GameState): boolean {
  return state.devDeck.length > 0 || state.players.some((p) => p.devCards.length > 0 || p.playedDevCards.length > 0);
}

export function canAfford(state: GameState, player: PlayerId, kind: BuildKind): boolean {
  return hasResources(state.players[player].hand, COSTS[kind]);
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** The production numbers `hex` still has. */
export function numbersOf(s: GameState, hex: Hex): number[] {
  let nums = hex.numbers;
  for (const m of modulesOf(s)) if (m.hooks?.numbersOf) nums = m.hooks.numbersOf(s, hex, nums);
  return nums;
}

/** Dots under a number disc: its chance in 36 (0 for no number). */
export const pipsOf = (n: number | null | undefined): number => (n ? (PIPS[n] ?? 0) : 0);

/** A hex's production chance in pips: the sum over the numbers it still has. */
export function hexPips(s: GameState, hex: Hex): number {
  let p = 0;
  for (const n of numbersOf(s, hex)) p += pipsOf(n);
  return p;
}

const bridgeCache = new WeakMap<Board, Set<number>>();
const NO_SITES: ReadonlySet<number> = new Set();

/** Edges only a bridge may occupy: the map's rivers', while Rivers is in play (without it a river is only scenery). */
export function bridgeSites(s: GameState): ReadonlySet<number> {
  if (!s.options.modules.includes('rivers')) return NO_SITES;
  let set = bridgeCache.get(s.board);
  if (!set) {
    set = new Set((s.board.features.rivers ?? []).flatMap((r) => r.bridgeSites));
    bridgeCache.set(s.board, set);
  }
  return set;
}

/** Every module in play allows `player` to place `piece` at `at` (an edge or an intersection). */
export function placeAllowed(s: GameState, player: PlayerId, piece: PieceKind, at: number): boolean {
  for (const m of modulesOf(s)) if (m.hooks?.canPlace && !m.hooks.canPlace(s, player, piece, at)) return false;
  return true;
}

/**
 * Why modules forbid this site, or all sites the base placement rules would offer. This query
 * never participates in legality: old saves and the reducer keep their exact placement gates.
 * With no site, a still-legal candidate wins over any blocked one elsewhere on the board.
 */
export function placeReason(s: GameState, player: PlayerId, piece: PieceKind, at?: number): string | null {
  if (at !== undefined) {
    if (piece === 'road' && bridgeSites(s).has(at)) return 'A river crossing needs a bridge';
    for (const m of modulesOf(s)) {
      if (m.hooks?.canPlace && !m.hooks.canPlace(s, player, piece, at)) return m.hooks.placeReason?.(s, player, piece, at) ?? 'This expansion prevents building here';
    }
    return null;
  }
  let sites: number[];
  const baseConnects = (v: number, family: 'land' | 'sea') => {
    const b = s.buildings[v];
    return b ? b.owner === player : s.board.vertices[v].edges.some((e) => s.routes[e]?.owner === player && routeFamily(s.routes[e]!.kind) === family);
  };
  if (piece === 'city') sites = s.board.vertices.filter((v) => s.buildings[v.id]?.owner === player && s.buildings[v.id]?.kind === 'settlement').map((v) => v.id);
  else if (piece === 'settlement') sites = s.board.vertices.filter((v) => satisfiesDistanceRule(s, v.id) && v.edges.some((e) => s.routes[e]?.owner === player)).map((v) => v.id);
  else sites = s.board.edges.filter((e) => !s.routes[e.id] && (piece === 'ship' ? e.hexes.some((h) => s.board.hexes[h].terrain === 'sea') : e.land) && (baseConnects(e.a, piece === 'ship' ? 'sea' : 'land') || baseConnects(e.b, piece === 'ship' ? 'sea' : 'land'))).map((e) => e.id);
  let first: string | null = null;
  for (const site of sites) {
    let reason = placeReason(s, player, piece, site);
    if (!reason && piece === 'road' && bridgeSites(s).has(site)) reason = 'A river crossing needs a bridge';
    if (!reason && (piece === 'road' || piece === 'ship' || piece === 'bridge')) {
      const e = s.board.edges[site];
      const family = piece === 'ship' ? 'sea' : 'land';
      if (!vertexConnects(s, player, e.a, family) && !vertexConnects(s, player, e.b, family)) reason = 'A rival warden or a conquered building blocks your route';
    }
    if (!reason) return null;
    first ??= reason;
  }
  return first;
}

/** Every module in play allows `player` to move `piece` (a ship) from edge `from` to edge `to`. */
export function moveAllowed(s: GameState, player: PlayerId, piece: PieceKind, from: number, to: number): boolean {
  for (const m of modulesOf(s)) if (m.hooks?.canMove && !m.hooks.canMove(s, player, piece, from, to)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Distance rule: the intersection is on land, and it and all adjacent intersections are empty. */
export function satisfiesDistanceRule(state: GameState, vertex: number): boolean {
  if (state.buildings[vertex] || !state.board.vertices[vertex].land) return false;
  return state.board.vertices[vertex].neighbors.every((n) => !state.buildings[n]);
}

export function legalSetupSettlements(state: GameState): number[] {
  return state.board.vertices.filter((v) => satisfiesDistanceRule(state, v.id) && placeAllowed(state, state.currentPlayer, 'settlement', v.id)).map((v) => v.id);
}

export function legalSetupRoads(state: GameState): number[] {
  const v = state.lastSetupSettlement;
  if (v === null) return [];
  const sites = bridgeSites(state);
  return state.board.vertices[v].edges.filter(
    (e) => state.routes[e] === null && state.board.edges[e].land && !sites.has(e) && placeAllowed(state, state.currentPlayer, 'road', e),
  );
}

/** Roads and bridges are one family, ships another; they join only at their owner's building. */
export const routeFamily = (kind: RouteKind): 'land' | 'sea' => (kind === 'ship' ? 'sea' : 'land');

/** Whether something other than `player`'s own pieces breaks a route at `v` (an opponent's building, or what a module says). */
export function breaksRoute(state: GameState, player: PlayerId, v: number): boolean {
  const b = state.buildings[v];
  if (b) return b.owner !== player;
  for (const m of modulesOf(state)) if (m.hooks?.breaksRoute?.(state, player, v)) return true;
  return false;
}

/** Whether `player` may route a new piece of `family` through/into intersection `v` from one of their pieces. */
export function vertexConnects(state: GameState, player: PlayerId, v: number, family: 'land' | 'sea'): boolean {
  const b = state.buildings[v];
  if (b && b.owner !== player) return false;
  // A route grows from your building while it still counts; a conquered one is worth nothing, and
  // only a route of the same family through its corner carries on (rule 10).
  if (b && (state.options.modules.length === 0 || buildingWorth(state, v) > 0)) return true;
  // (Your own route here is checked first: it's cheap, and without one nothing the modules say matters.)
  const own = state.board.vertices[v].edges.some((e) => {
    const r = state.routes[e];
    return !!r && r.owner === player && routeFamily(r.kind) === family;
  });
  return own && (!!b || !breaksRoute(state, player, v));
}

/** Whether `player` may route a new road through/into intersection `v` from one of their roads. */
export function vertexConnectsForRoad(state: GameState, player: PlayerId, v: number): boolean {
  return vertexConnects(state, player, v, 'land');
}

export function isLegalRoad(state: GameState, player: PlayerId, edge: number): boolean {
  if (state.routes[edge] !== null) return false;
  const e = state.board.edges[edge];
  if (!e.land || bridgeSites(state).has(edge)) return false;
  if (!(vertexConnectsForRoad(state, player, e.a) || vertexConnectsForRoad(state, player, e.b))) return false;
  return placeAllowed(state, player, 'road', edge);
}

export function legalRoads(state: GameState, player: PlayerId): number[] {
  if (state.players[player].roadsLeft <= 0) return [];
  return memo(state, Query.LegalRoads, player, () => roadSites(state, player, false)).slice();
}

/**
 * The edges where isLegalRoad holds, in order (only the first with `first`). Each intersection's
 * connection is asked once rather than once for each of its edges.
 */
function roadSites(state: GameState, player: PlayerId, first: boolean): number[] {
  const out: number[] = [];
  const sites = bridgeSites(state);
  // 0: not asked yet, 1: connects, 2: doesn't.
  const known = new Uint8Array(state.board.vertices.length);
  const connects = (v: number) => {
    if (known[v] === 0) known[v] = vertexConnectsForRoad(state, player, v) ? 1 : 2;
    return known[v] === 1;
  };
  for (const e of state.board.edges) {
    if (state.routes[e.id] !== null || !e.land || sites.has(e.id)) continue;
    if (!(connects(e.a) || connects(e.b)) || !placeAllowed(state, player, 'road', e.id)) continue;
    out.push(e.id);
    if (first) break;
  }
  return out;
}

/** Whether `player` still has somewhere to put a free route piece (a road, or a ship with Sea Lanes). */
export function freeRouteOpen(state: GameState, player: PlayerId): boolean {
  if (state.players[player].roadsLeft > 0 && roadSites(state, player, true).length > 0) return true;
  return modulesOf(state).some((m) => m.hooks?.canPlaceFreeRoute?.(state, player));
}

export function isLegalSettlement(state: GameState, player: PlayerId, vertex: number): boolean {
  if (!satisfiesDistanceRule(state, vertex)) return false;
  if (!state.board.vertices[vertex].edges.some((e) => state.routes[e]?.owner === player)) return false;
  return placeAllowed(state, player, 'settlement', vertex);
}

export function legalSettlements(state: GameState, player: PlayerId): number[] {
  if (state.players[player].settlementsLeft <= 0) return [];
  return memo(state, Query.LegalSettlements, player, () => state.board.vertices.filter((v) => isLegalSettlement(state, player, v.id)).map((v) => v.id)).slice();
}

export function legalCities(state: GameState, player: PlayerId): number[] {
  const out: number[] = [];
  let lying = -1;
  state.buildings.forEach((b, v) => {
    if (b && b.owner === player && b.kind === 'settlement' && placeAllowed(state, player, 'city', v)) {
      out.push(v);
      if (b.lying) lying = v;
    }
  });
  // A city laid down for want of a settlement piece must be the next one rebuilt (it is still a
  // city piece, so it needs no free one).
  if (lying >= 0) return [lying];
  return state.players[player].citiesLeft <= 0 ? [] : out;
}

// ---------------------------------------------------------------------------
// The robber
// ---------------------------------------------------------------------------

/** Friendly robber: whether `player` is spared (2 or fewer visible points). Always false without the variant. */
export function robberSpares(state: GameState, player: PlayerId): boolean {
  return !!state.options.friendlyRobber && publicVictoryPoints(state, player) <= FRIENDLY_ROBBER_MAX_VP;
}

/** Friendly robber: whether a hex borders a building of a spared player. */
function touchesSpared(state: GameState, hex: number): boolean {
  return state.board.hexes[hex].vertices.some((v) => {
    const b = state.buildings[v];
    return !!b && robberSpares(state, b.owner);
  });
}

/**
 * Where the robber may go: any other land hex a module allows (not a face-down one). With the
 * friendly robber, not next to a spared player; if that leaves nowhere, it goes to the desert (or
 * stays there, which then counts as its move), and with no desert, nowhere.
 */
export function legalRobberHexes(state: GameState): number[] {
  let others = state.board.hexes.filter((h) => h.id !== state.robberHex && isLand(h.terrain)).map((h) => h.id);
  for (const m of modulesOf(state)) if (m.hooks?.robberHexes) others = m.hooks.robberHexes(state, others);
  if (!state.options.friendlyRobber) return others;
  const ok = others.filter((h) => !touchesSpared(state, h));
  if (ok.length > 0) return ok;
  const home = refugeHex(state);
  return home === null ? [] : [home];
}

/**
 * Where a blocker sent home goes (rule 4): a desert, else a swamp, that bears no number of its own,
 * else off the board (null). Oil can put a well, with a number, on the desert or a river's swamp:
 * the robber doesn't sit on a hex that produces. On the classic island it's the desert, as ever.
 */
export function refugeHex(state: GameState): number | null {
  const bare = (h: Hex) => h.numbers.length === 0;
  const d = state.board.desertHex;
  if (d !== null && bare(state.board.hexes[d])) return d;
  return state.board.hexes.find((h) => h.terrain === 'swamp' && bare(h))?.id ?? null;
}

/** Opponents with a building on `hex` who hold at least one card a theft can take (never a spared player). */
/**
 * Whether `thief` may take one oil by name from `victim` (Oil): the victim holds some, and the
 * thief has room for it, as every module's hand rules say (oil holds are capacity-aware).
 */
export function canTakeOil(s: GameState, thief: PlayerId, victim: PlayerId): boolean {
  if (thief === victim || !s.options.modules.includes('oil') || s.players[victim].hand.oil <= 0) return false;
  const hand = { ...s.players[thief].hand, oil: s.players[thief].hand.oil + 1 };
  return modulesOf(s).every((m) => m.hooks?.handAllowed?.(s, thief, hand) ?? true);
}

/** Whether a theft from `victim` has anything to take: a card at random, or oil `thief` may name. */
export const robbable = (s: GameState, thief: PlayerId, victim: PlayerId): boolean => stealableCount(s, victim) > 0 || canTakeOil(s, thief, victim);

/** The ways `thief` may rob `victim`: a card at random if they hold one, and one oil by name if there's room for it. */
export function theftChoices(s: GameState, thief: PlayerId, victim: PlayerId): { victim: PlayerId; oil?: true }[] {
  const out: { victim: PlayerId; oil?: true }[] = [];
  if (stealableCount(s, victim) > 0) out.push({ victim });
  if (canTakeOil(s, thief, victim)) out.push({ victim, oil: true });
  return out;
}

export function stealCandidates(state: GameState, hex: number, thief: PlayerId): PlayerId[] {
  const set = new Set<PlayerId>();
  for (const v of state.board.hexes[hex].vertices) {
    const b = state.buildings[v];
    if (b && b.owner !== thief && robbable(state, thief, b.owner) && !robberSpares(state, b.owner)) set.add(b.owner);
  }
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

/**
 * Best bank ratio for each kind of card (Infinity where the bank won't take it). Resources trade
 * 4:1, 3:1 through a general harbour and 2:1 through their own; commodities, when in play, 4:1
 * or 3:1; oil never.
 */
export function tradeRatios(state: GameState, player: PlayerId): Record<Card, number> {
  const guilds = state.options.modules.includes('guilds');
  const c = guilds ? 4 : Infinity;
  let ratios: Record<Card, number> = { brick: 4, wood: 4, wool: 4, wheat: 4, ore: 4, paper: c, cloth: c, silver: c, oil: Infinity };
  for (const port of state.board.ports) {
    const owns = port.vertices.some((v) => state.buildings[v]?.owner === player);
    if (!owns) continue;
    if (port.type === 'any') {
      for (const r of RESOURCES) ratios[r] = Math.min(ratios[r], 3);
      if (guilds) for (const k of COMMODITIES) ratios[k] = Math.min(ratios[k], 3);
    } else {
      ratios[port.type] = Math.min(ratios[port.type], 2);
    }
  }
  for (const m of modulesOf(state)) if (m.hooks?.tradeRatios) ratios = m.hooks.tradeRatios(state, player, ratios);
  return ratios;
}

export function playableDevCards(state: GameState, player: PlayerId) {
  const p = state.players[player];
  if (state.currentPlayer !== player || state.devCardPlayedThisTurn) return [];
  if (state.phase !== 'roll' && state.phase !== 'main') return [];
  return p.devCards.filter((c) => c.type !== 'victoryPoint' && c.boughtTurn < state.turn);
}

// ---------------------------------------------------------------------------
// Longest continuous route
// ---------------------------------------------------------------------------

/** What an edge adds to a route of `player`'s: 1, plus any bonus a module gives it (a wagon over it). */
function routeWeight(state: GameState, player: PlayerId, edge: number): number {
  let w = 1;
  for (const m of modulesOf(state)) if (m.hooks?.routeBonus) w += m.hooks.routeBonus(state, player, edge);
  return w;
}

/**
 * Longest trail (each piece used at most once) through `player`'s roads, bridges and ships. A
 * route may not continue through an intersection where something breaks it (an opponent's
 * building), and roads and ships join only at the player's own building.
 */
export function longestRoadFor(state: GameState, player: PlayerId): number {
  return longestRoute(state, player).length;
}

/** The edges of one of `player`'s longest routes, in order (for drawing it; longestRoadFor is the length). */
export function longestRoadEdges(state: GameState, player: PlayerId): number[] {
  return longestRoute(state, player).edges;
}

function longestRoute(state: GameState, player: PlayerId): { length: number; edges: number[] } {
  const { edges, vertices } = state.board;
  const mine: number[] = [];
  for (const e of edges) if (state.routes[e.id]?.owner === player) mine.push(e.id);
  if (mine.length === 0) return { length: 0, edges: [] };
  // (The search visits each intersection many times, so what the modules say of an edge or an
  // intersection is asked once and kept in arrays: weights, and per intersection 0 not asked yet,
  // 1 breaks the route, 2 doesn't. The edge of each piece is its family: 0 land, 1 sea.)
  const weight = new Float64Array(edges.length);
  const family = new Uint8Array(edges.length);
  for (const e of mine) {
    weight[e] = routeWeight(state, player, e);
    family[e] = state.routes[e]!.kind === 'ship' ? 1 : 0;
  }
  const breaks = new Uint8Array(vertices.length);
  const used: number[] = [];
  const usedSet = new Uint8Array(edges.length);
  let best = 0;
  let bestEdges: number[] = [];

  const blocked = (v: number) => {
    if (breaks[v] === 0) breaks[v] = breaksRoute(state, player, v) ? 1 : 2;
    return breaks[v] === 1;
  };
  // Roads and ships join only at a building of yours that still counts (a conquered one doesn't).
  // (Asked only where a route changes family, as blocked() is.)
  const joinsAt = new Uint8Array(vertices.length);
  const joins = (v: number) => {
    if (joinsAt[v] === 0) {
      const b = state.buildings[v];
      joinsAt[v] = b?.owner === player && (state.options.modules.length === 0 || buildingWorth(state, v) > 0) ? 1 : 2;
    }
    return joinsAt[v] === 1;
  };

  const dfs = (v: number, length: number, f0: number) => {
    if (length > best) {
      best = length;
      bestEdges = used.slice();
    }
    if (blocked(v)) return;
    for (const e of vertices[v].edges) {
      if (usedSet[e] === 1) continue;
      const r = state.routes[e];
      if (!r || r.owner !== player) continue;
      const f = family[e];
      if (f !== f0 && !joins(v)) continue;
      used.push(e);
      usedSet[e] = 1;
      const ed = edges[e];
      dfs(ed.a === v ? ed.b : ed.a, length + weight[e], f);
      used.pop();
      usedSet[e] = 0;
    }
  };

  for (const e of mine) {
    const ed = edges[e];
    for (const end of [ed.a, ed.b]) {
      used.push(e);
      usedSet[e] = 1;
      dfs(end, weight[e], family[e]);
      used.pop();
      usedSet[e] = 0;
    }
  }
  return { length: best, edges: bestEdges };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** What the building at `vertex` is worth: settlement 1, city 2, plus what modules add (or take: conquest). */
export function buildingWorth(state: GameState, vertex: number): number {
  const b = state.buildings[vertex];
  if (!b) return 0;
  let worth = b.kind === 'city' ? 2 : 1;
  for (const m of modulesOf(state)) if (m.hooks?.buildingWorth) worth = m.hooks.buildingWorth(state, vertex, worth);
  return worth;
}

/** Points from the modules beyond buildings (awards, tokens, achievements). */
function modulePoints(state: GameState, player: PlayerId): number {
  let vp = 0;
  for (const m of modulesOf(state)) if (m.hooks?.victoryPoints) vp += m.hooks.victoryPoints(state, player);
  return vp;
}

export function publicVictoryPoints(state: GameState, player: PlayerId): number {
  let vp = 0;
  state.buildings.forEach((b, v) => {
    if (b && b.owner === player) vp += buildingWorth(state, v);
  });
  if (state.longestRoadHolder === player) vp += 2;
  if (state.largestArmyHolder === player) vp += 2;
  return vp + modulePoints(state, player);
}

export function hiddenVictoryPoints(state: GameState, player: PlayerId): number {
  return state.players[player].devCards.filter((c) => c.type === 'victoryPoint').length;
}

export function totalVictoryPoints(state: GameState, player: PlayerId): number {
  return publicVictoryPoints(state, player) + hiddenVictoryPoints(state, player);
}

/** The points `player` needs to win (the game's target, plus what modules add: the boot). */
export function victoryTarget(state: GameState, player: PlayerId): number {
  let t = state.options.victoryPoints;
  for (const m of modulesOf(state)) if (m.hooks?.victoryTarget) t = m.hooks.victoryTarget(state, player, t);
  return t;
}

export function victoryBreakdown(state: GameState, player: PlayerId) {
  let settlements = 0;
  let cities = 0;
  let buildingPoints = 0;
  state.buildings.forEach((b, v) => {
    if (!b || b.owner !== player) return;
    if (b.kind === 'city') cities++;
    else settlements++;
    buildingPoints += buildingWorth(state, v);
  });
  return {
    settlements,
    cities,
    /** Points the buildings are worth beyond 1 a settlement and 2 a city (seats, foundries, wagons; conquest takes away). */
    buildingExtra: buildingPoints - settlements - 2 * cities,
    longestRoad: state.longestRoadHolder === player,
    largestArmy: state.largestArmyHolder === player,
    victoryCards: hiddenVictoryPoints(state, player),
    modules: modulePoints(state, player),
    total: totalVictoryPoints(state, player),
  };
}

/** Whether `player` may take back the piece they last placed. */
export function canUndo(state: GameState, player: PlayerId): boolean {
  return state.phase !== 'gameOver' && state.undo?.player === player;
}
