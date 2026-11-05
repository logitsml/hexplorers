// Sea Lanes' read-only rule queries: where ships may go and move, where the corsair may sail and
// whom it robs, what the bounty fields owe, and what is still face down. Shared by the module's
// reducer steps, its legal-action list, its bot and its tests.

import { cards, isLand } from '../../constants';
import { bridgeSites, moveAllowed, numbersOf, placeAllowed, robbable, robberSpares, vertexConnects } from '../../rules';
import type { Building, GameState, Hex, PlayerId, Production, Resource, Route } from '../../types';
import { RESOURCES } from '../../types';
import type { RuleModule } from '../api';
import { modulesOf } from '../index';
import type { SeaState } from './types';

/** Ships each player owns. */
export const SHIPS = 15;
export const SHIP_COST = cards({ wood: 1, wool: 1 });
/** First Landing: points for a player's first settlement on an island that isn't home. */
export const FIRST_LANDING_POINTS = 2;

export const seaState = (s: GameState): SeaState => s.ext.sea!;

// ---------------------------------------------------------------------------
// Fog and open water
// ---------------------------------------------------------------------------

/** A hex still face down (Fog). */
export const isHidden = (s: GameState, hex: number): boolean => !!s.ext.sea?.fog?.hidden.includes(hex);

/** Open water a ship can be seen to sail: a sea hex that isn't face down. */
export const isOpenSea = (s: GameState, hex: number): boolean => s.board.hexes[hex].terrain === 'sea' && !isHidden(s, hex);

/** Land that's been seen: a land hex that isn't face down. */
export const isKnownLand = (s: GameState, hex: number): boolean => isLand(s.board.hexes[hex].terrain) && !isHidden(s, hex);

/** The island an intersection's land belongs to, or -1 at sea (the land hexes at a corner always share one island). */
export function islandOf(s: GameState, vertex: number): number {
  for (const h of s.board.vertices[vertex].hexes) if (isLand(s.board.hexes[h].terrain)) return s.board.hexes[h].island;
  return -1;
}

/** Whether an intersection touches a home island. */
export const onHome = (s: GameState, vertex: number): boolean => s.board.islands[islandOf(s, vertex)]?.home ?? false;

// ---------------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------------

/** Whether `edge` is an edge of the corsair's hex. */
function besideCorsair(s: GameState, edge: number): boolean {
  const c = s.ext.sea?.corsair;
  return c !== null && c !== undefined && s.board.hexes[c].edges.includes(edge);
}

/** An empty edge any ship could take: on open water, not a bridge site, clear of the corsair. */
export function shipSite(s: GameState, edge: number): boolean {
  if (s.routes[edge] !== null) return false;
  const e = s.board.edges[edge];
  if (!e.sea || !e.hexes.some((h) => isOpenSea(s, h))) return false;
  return !bridgeSites(s).has(edge) && !besideCorsair(s, edge);
}

/** Whether `player` may place a ship on `edge`: it joins their own ship or building (never a road), not past an opponent's building. */
export function isLegalShip(s: GameState, player: PlayerId, edge: number): boolean {
  if (!shipSite(s, edge)) return false;
  const e = s.board.edges[edge];
  if (!vertexConnects(s, player, e.a, 'sea') && !vertexConnects(s, player, e.b, 'sea')) return false;
  return placeAllowed(s, player, 'ship', edge);
}

/**
 * The edges where isLegalShip holds, in order (only the first with `first`). Each intersection's
 * connection is asked once rather than once for each of its edges.
 */
export function legalShips(s: GameState, player: PlayerId, first = false): number[] {
  if (seaState(s).shipsLeft[player] <= 0) return [];
  const out: number[] = [];
  // 0: not asked yet, 1: connects, 2: doesn't.
  const known = new Uint8Array(s.board.vertices.length);
  const connects = (v: number) => {
    if (known[v] === 0) known[v] = vertexConnects(s, player, v, 'sea') ? 1 : 2;
    return known[v] === 1;
  };
  for (const e of s.board.edges) {
    if (!shipSite(s, e.id) || !(connects(e.a) || connects(e.b)) || !placeAllowed(s, player, 'ship', e.id)) continue;
    out.push(e.id);
    if (first) break;
  }
  return out;
}

/** Starting ships beside the set-up building just placed: any sea edge there a ship may take. */
export function legalSetupShips(s: GameState): number[] {
  const v = s.lastSetupSettlement;
  if (v === null || seaState(s).shipsLeft[s.currentPlayer] <= 0) return [];
  return s.board.vertices[v].edges.filter((e) => shipSite(s, e) && placeAllowed(s, s.currentPlayer, 'ship', e));
}

const ownShip = (r: Route | null, player: PlayerId) => !!r && r.kind === 'ship' && r.owner === player;
const ownBuilding = (b: Building | null, player: PlayerId) => !!b && b.owner === player;

/** An end of a ship is open when none of its owner's other ships or buildings touches it. */
function endOpen(s: GameState, player: PlayerId, vertex: number, ship: number): boolean {
  if (ownBuilding(s.buildings[vertex], player)) return false;
  return !s.board.vertices[vertex].edges.some((e) => e !== ship && ownShip(s.routes[e], player));
}

/** `player`'s buildings reachable from `vertex` along their ships without using `skip` (an opponent's building doesn't break the line). */
function buildingsAlongShips(s: GameState, player: PlayerId, vertex: number, skip: number): Set<number> {
  const found = new Set<number>();
  const seen = new Set([vertex]);
  const stack = [vertex];
  while (stack.length > 0) {
    const v = stack.pop()!;
    if (ownBuilding(s.buildings[v], player)) found.add(v);
    for (const e of s.board.vertices[v].edges) {
      if (e === skip || !ownShip(s.routes[e], player)) continue;
      const ed = s.board.edges[e];
      const u = ed.a === v ? ed.b : ed.a;
      if (!seen.has(u)) {
        seen.add(u);
        stack.push(u);
      }
    }
  }
  return found;
}

/** Whether a ship is part of a continuous line of its owner's ships joining two of their buildings. */
export function inClosedLine(s: GameState, player: PlayerId, ship: number): boolean {
  const e = s.board.edges[ship];
  const a = buildingsAlongShips(s, player, e.a, ship);
  if (a.size === 0) return false;
  const b = buildingsAlongShips(s, player, e.b, ship);
  for (const x of a) for (const y of b) if (x !== y) return true;
  return false;
}

/**
 * Whether `player` may pick up the ship on `edge` this turn: theirs, not built this turn, not on
 * an edge of the corsair's hex, with an open end, and not part of a line joining two buildings.
 * (One move a turn is checked by the caller.)
 */
export function canMoveShip(s: GameState, player: PlayerId, edge: number): boolean {
  const r = s.routes[edge];
  if (!ownShip(r, player) || r!.builtTurn === s.turn || besideCorsair(s, edge)) return false;
  const e = s.board.edges[edge];
  if (!endOpen(s, player, e.a, edge) && !endOpen(s, player, e.b, edge)) return false;
  return !inClosedLine(s, player, edge);
}

/** Whether moving `from` to `to` would leave one of `player`'s wardens with none of their route pieces beside it. */
function strandsWarden(s: GameState, player: PlayerId, from: number, to: number): boolean {
  const e = s.board.edges[from];
  return s.wardens.some((w) => {
    if (w.owner !== player || w.vertex === null || (w.vertex !== e.a && w.vertex !== e.b)) return false;
    return !s.board.vertices[w.vertex].edges.some((x) => x !== from && (x === to || s.routes[x]?.owner === player));
  });
}

/** The board as it stands with the ship on `from` lifted off (for checking where it may go). */
export function withoutRoute(s: GameState, edge: number): GameState {
  const routes = s.routes.slice();
  routes[edge] = null;
  return { ...s, routes };
}

/** Whether `player` may move their ship from `from` to `to` now (bar the once-a-turn limit). */
export function isLegalMove(s: GameState, player: PlayerId, from: number, to: number): boolean {
  if (from === to || !canMoveShip(s, player, from)) return false;
  return isLegalShip(withoutRoute(s, from), player, to) && !strandsWarden(s, player, from, to) && moveAllowed(s, player, 'ship', from, to);
}

/** Every move `player` may make with one of their ships right now, as [from, to] pairs. */
export function legalMoves(s: GameState, player: PlayerId): [number, number][] {
  if (seaState(s).movedTurn[player] === s.turn) return [];
  const out: [number, number][] = [];
  s.routes.forEach((r, from) => {
    if (!ownShip(r, player) || !canMoveShip(s, player, from)) return;
    const lifted = withoutRoute(s, from);
    for (const e of s.board.edges) {
      // (Other modules have their say too: leaving a river edge costs a coin.)
      if (e.id !== from && isLegalShip(lifted, player, e.id) && !strandsWarden(s, player, from, e.id) && moveAllowed(s, player, 'ship', from, e.id)) out.push([from, e.id]);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The corsair
// ---------------------------------------------------------------------------

/** Whether a spared player (friendly robber) has a ship on `hex`. */
function sparedShipOn(s: GameState, hex: number): boolean {
  return s.board.hexes[hex].edges.some((e) => {
    const r = s.routes[e];
    return !!r && r.kind === 'ship' && robberSpares(s, r.owner);
  });
}

/** Where the corsair may sail: another sea hex in view (with the friendly robber, none where a spared player has a ship). */
export function corsairHexes(s: GameState): number[] {
  const at = seaState(s).corsair;
  const out = s.board.hexes.filter((h) => h.id !== at && isOpenSea(s, h.id)).map((h) => h.id);
  return s.options.friendlyRobber ? out.filter((h) => !sparedShipOn(s, h)) : out;
}

/** The corsair's victims at `hex`: other players with a ship on one of its edges and a card to lose. */
export function corsairVictims(s: GameState, hex: number, thief: PlayerId): PlayerId[] {
  const set = new Set<PlayerId>();
  for (const e of s.board.hexes[hex].edges) {
    const r = s.routes[e];
    if (r && r.kind === 'ship' && r.owner !== thief && robbable(s, thief, r.owner) && !robberSpares(s, r.owner)) set.add(r.owner);
  }
  return [...set].sort((a, b) => a - b);
}

/** Anyone a theft may target (Invasion's 7): every other player with a card to lose. */
export function anyVictims(s: GameState, thief: PlayerId): PlayerId[] {
  return s.players.filter((p) => p.id !== thief && robbable(s, thief, p.id) && !robberSpares(s, p.id)).map((p) => p.id);
}

// ---------------------------------------------------------------------------
// Bounty fields
// ---------------------------------------------------------------------------

/**
 * A bounty field has no resource of its own, so its take goes through the modules' yields hooks
 * as a grant of this stand-in. The hooks that read the terrain's own resource (the guilds'
 * commodities) leave it alone, and the rest treat it as any resource.
 */
const BOUNTY_STAND_IN: Resource = 'brick';

/**
 * How many resources a building takes from a producing bounty field: settlement 1, city 2, put
 * through every module's yields hook as any production is. So a foundry takes 3 (Oil), a sickness
 * holds a city or foundry to one (the Almanac), and a building cut off by conquest takes none.
 */
function bountyTake(s: GameState, hex: Hex, vertex: number, b: Building, mods: readonly RuleModule[] = modulesOf(s)): number {
  let gs: Production[] = [{ player: b.owner, hex: hex.id, vertex, resource: BOUNTY_STAND_IN, amount: b.kind === 'city' ? 2 : 1 }];
  for (const m of mods) if (m.hooks?.yields) gs = m.hooks.yields(s, hex, vertex, b, gs);
  let n = 0;
  for (const g of gs) if ((RESOURCES as readonly string[]).includes(g.resource)) n += g.amount;
  return n;
}

/** What the bounty fields owe each player on a roll of `total`, by player. */
export function bountyOwed(s: GameState, total: number): Map<PlayerId, number> {
  const owed = new Map<PlayerId, number>();
  const mods = modulesOf(s);
  for (const hex of s.board.hexes) {
    if (hex.terrain !== 'bounty' || isHidden(s, hex.id) || hex.id === s.robberHex) continue;
    if (!numbersOf(s, hex).includes(total) || mods.some((m) => m.hooks?.hexBlocked?.(s, hex))) continue;
    for (const v of hex.vertices) {
      const b = s.buildings[v];
      if (b) owed.set(b.owner, (owed.get(b.owner) ?? 0) + bountyTake(s, hex, v, b, mods));
    }
  }
  return owed;
}
