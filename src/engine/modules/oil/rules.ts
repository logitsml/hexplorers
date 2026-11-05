// Oil's numbers and the queries its actions, bot and tests share. Read-only: nothing here draws
// from the dice or changes the state.

import { cards } from '../../constants';
import { hasResources } from '../../rules';
import type { GameState, PlayerId } from '../../types';
import { buildingConquered } from '../shared';
import type { OilState } from './types';

/** Oil in the game for three or four seats. */
export const OIL_SUPPLY = 15;
/** The most oil a player may hold. */
export const OIL_LIMIT = 4;
/** The disaster track's top: a disaster follows at the end of the turn it's reached. */
export const TRACK_MAX = 5;
/** Foundry pieces in the game (shared by everyone). */
export const FOUNDRIES = 4;
export const FOUNDRY_COST = cards({ brick: 1, wheat: 1, ore: 1, oil: 2 });
/** How far a foundry moves the disaster track (its two oil). */
export const FOUNDRY_TRACK = 2;
/** Resources one burned oil buys. */
export const BURN_YIELD = 2;
/** Sequestered oil per point, and what the Steward needs first. */
export const SEQUESTER_PER_POINT = 3;
export const STEWARD_AT = 3;
/** Oil a polluted well takes out of the game. */
export const WELL_LOSS = 3;
/** Lost numbers that end the game, unless the pollutionLimit knob says otherwise. */
export const DEFAULT_POLLUTION_LIMIT = 5;
/** The published target for a game with oil (the base 10 plus rule 9's 2). Presets set options.victoryPoints. */
export const OIL_TARGET = 12;

export const oilOf = (s: GameState): OilState => s.ext.oil!;

export const pollutionLimit = (s: GameState): number => s.options.knobs.pollutionLimit ?? DEFAULT_POLLUTION_LIMIT;

/**
 * Floods strike one island at random rather than every coast: the floodOneIsland knob if it's set
 * either way, else whenever the map has several islands (a flood over every coast would wipe an
 * archipelago).
 */
export const floodsOneIsland = (s: GameState): boolean => s.options.knobs.floodOneIsland ?? s.board.islands.length > 1;

/** Oil `player` can still take before reaching the limit. */
export const oilRoom = (s: GameState, player: PlayerId): number => Math.max(0, OIL_LIMIT - s.players[player].hand.oil);

/** An intersection on the shore: one of its edges borders exactly one land hex. */
export const isCoastal = (s: GameState, vertex: number): boolean => s.board.vertices[vertex].edges.some((e) => s.board.edges[e].coastal);

export const foundriesBuilt = (s: GameState): number => s.buildings.reduce((n, b) => n + (b?.foundry ? 1 : 0), 0);

/** Points from sequestering: one per three, and the Steward's one. */
export function oilPoints(s: GameState, player: PlayerId): number {
  const st = oilOf(s);
  return Math.floor(st.sequestered[player] / SEQUESTER_PER_POINT) + (st.steward === player ? 1 : 0);
}

/** Whether an oil action moving the track by `step` may be taken now (never above 5, never after sequestering). */
export function canUseOil(s: GameState, player: PlayerId, step: number): boolean {
  const st = oilOf(s);
  return s.phase === 'main' && s.currentPlayer === player && s.pending.length === 0 && !st.sequesteredThisTurn && st.track + step <= TRACK_MAX;
}

/** Cities of `player` that may take a foundry: not conquered, and holding no seat unless upgrades may stack. */
export function foundrySites(s: GameState, player: PlayerId): number[] {
  const out: number[] = [];
  const stack = !!s.options.knobs.stackUpgrades;
  s.buildings.forEach((b, v) => {
    if (b && b.owner === player && b.kind === 'city' && !b.foundry && (stack || !b.seat) && !buildingConquered(s, v)) out.push(v);
  });
  return out;
}

/** Whether `player` could put a foundry somewhere now. */
export function canBuildFoundry(s: GameState, player: PlayerId): boolean {
  return (
    canUseOil(s, player, FOUNDRY_TRACK) &&
    foundriesBuilt(s) < FOUNDRIES &&
    hasResources(s.players[player].hand, FOUNDRY_COST) &&
    foundrySites(s, player).length > 0
  );
}

/** Whether `player` may sequester an oil now: once a turn, and not in a turn they used oil. */
export function canSequester(s: GameState, player: PlayerId): boolean {
  const st = oilOf(s);
  return (
    s.phase === 'main' &&
    s.currentPlayer === player &&
    s.pending.length === 0 &&
    !st.usedThisTurn &&
    !st.sequesteredThisTurn &&
    s.players[player].hand.oil > 0
  );
}

