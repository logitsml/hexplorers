// Read-only Rivers queries shared by the module and its bot: where the rivers are,
// where a bridge may go, and who holds the wealth tiles.

import { cards } from '../../constants';
import { bridgeSites, placeAllowed, vertexConnects } from '../../rules';
import type { Board, GameState, PlayerId } from '../../types';

/** A bridge's cost. */
export const BRIDGE_COST = cards({ brick: 2, wood: 1 });
/** Bridges each player has. */
export const BRIDGES_EACH = 3;
/** Coins for a road, settlement or ship by a river; for a bridge. */
export const RIVER_COINS = 1;
export const BRIDGE_COINS = 3;
/** The Richest tile's worth, and the Pauper tile's cost. */
export const RICHEST_POINTS = 1;
export const PAUPER_POINTS = 1;
/** The Pauper tile's cost in games recorded under the first rivers rules. */
const FIRST_PAUPER_POINTS = 2;

interface RiverGeometry {
  /** Every hex of every river tile, swamps included. */
  hexes: Set<number>;
  /** Their edges and corners: building there pays a coin. */
  edges: Set<number>;
  corners: Set<number>;
  /** The swamps (each river's mouth), in river order. */
  swamps: number[];
}

const geometryCache = new WeakMap<Board, RiverGeometry>();

export function riverGeometry(board: Board): RiverGeometry {
  let g = geometryCache.get(board);
  if (!g) {
    g = { hexes: new Set(), edges: new Set(), corners: new Set(), swamps: [] };
    for (const river of board.features.rivers ?? []) {
      for (const h of river.hexes) {
        g.hexes.add(h);
        for (const e of board.hexes[h].edges) g.edges.add(e);
        for (const v of board.hexes[h].vertices) g.corners.add(v);
      }
      g.swamps.push(river.hexes[river.hexes.length - 1]);
    }
    geometryCache.set(board, g);
  }
  return g;
}

/** An edge of a river hex (a road, ship or bridge there pays). */
export const onRiverEdge = (s: GameState, edge: number): boolean => riverGeometry(s.board).edges.has(edge);
/** A corner of a river hex (a settlement there pays). */
export const onRiverCorner = (s: GameState, vertex: number): boolean => riverGeometry(s.board).corners.has(vertex);

export const bridgesLeft = (s: GameState, player: PlayerId): number => s.ext.rivers?.bridgesLeft[player] ?? 0;

/**
 * Whether `player` may put a bridge on `edge` (cost and pieces aside): an empty bridge site, joined
 * at one end to their road, bridge or building, and not past an opponent's building.
 */
export function isLegalBridge(s: GameState, player: PlayerId, edge: number): boolean {
  if (!bridgeSites(s).has(edge) || s.routes[edge] !== null) return false;
  const e = s.board.edges[edge];
  if (!(vertexConnects(s, player, e.a, 'land') || vertexConnects(s, player, e.b, 'land'))) return false;
  return placeAllowed(s, player, 'bridge', edge);
}

/** Every bridge site `player` may build on now (pieces left, cost aside), in edge order. */
export function legalBridges(s: GameState, player: PlayerId): number[] {
  if (bridgesLeft(s, player) <= 0) return [];
  return [...bridgeSites(s)].filter((e) => isLegalBridge(s, player, e)).sort((a, b) => a - b);
}

interface Wealth {
  /** Strictly the most coins: the Richest tile. On a tie for most it stays in the supply. */
  richest: PlayerId | null;
  /** Everyone tied for the fewest coins: a Pauper tile each (all of them, when everyone has the same). */
  paupers: PlayerId[];
}

/** Who holds the wealth tiles, given each player's coins. */
export function wealthOf(coins: readonly number[]): Wealth {
  const most = Math.max(...coins);
  const fewest = Math.min(...coins);
  const top = coins.filter((c) => c === most).length;
  return {
    richest: top === 1 ? coins.indexOf(most) : null,
    paupers: coins.flatMap((c, p) => (c === fewest ? [p] : [])),
  };
}

export const coinsOf = (s: GameState): number[] => s.players.map((p) => p.coins);

/** What a Pauper tile costs in this game (the pauperPoints knob). */
export const pauperPoints = (s: GameState): number => s.options.knobs.pauperPoints ?? ((s.options.moduleRules.rivers ?? 1) >= 2 ? PAUPER_POINTS : FIRST_PAUPER_POINTS);

/** What the wealth tiles are worth to `player`: +1 for the Richest, −1 (by default) for a Pauper. */
export function wealthPoints(w: Wealth, player: PlayerId, pauper = PAUPER_POINTS): number {
  return (w.richest === player ? RICHEST_POINTS : 0) - (w.paupers.includes(player) ? pauper : 0);
}

/** `player`'s wealth points if their coins were `coins` and everyone else's stayed as they are. */
export function wealthPointsWith(s: GameState, player: PlayerId, coins: number): number {
  const all = coinsOf(s);
  all[player] = coins;
  return wealthPoints(wealthOf(all), player, pauperPoints(s));
}
