import type { CardCounts, Commodity, DevCardType, Knobs, PlayerColor, PortType, Resource, Terrain } from './types';
import { CARDS } from './types';

/** What each terrain produces as a plain resource (bounty fields produce a resource of the owner's choice instead). */
export const TERRAIN_RESOURCE: Record<Terrain, Resource | null> = {
  hills: 'brick',
  forest: 'wood',
  pasture: 'wool',
  fields: 'wheat',
  mountains: 'ore',
  desert: null,
  bounty: null,
  swamp: null,
  lake: null,
  oasis: null,
  castle: null,
  sea: null,
};

/** The commodity a city on each terrain also takes (Guilds). */
export const TERRAIN_COMMODITY: Partial<Record<Terrain, Commodity>> = { forest: 'paper', pasture: 'cloth', mountains: 'silver' };

/** Terrain that is land (everything but the sea). */
export const isLand = (t: Terrain) => t !== 'sea';

/** The classic island's terrain. */
export type ClassicTerrain = 'hills' | 'forest' | 'pasture' | 'fields' | 'mountains' | 'desert';

export const TERRAIN_COUNTS: Record<ClassicTerrain, number> = {
  hills: 3,
  forest: 4,
  pasture: 4,
  fields: 4,
  mountains: 3,
  desert: 1,
};

export const NUMBER_DISCS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

/** The order number discs are laid along the spiral on a random island. */
export const SPIRAL_SEQUENCE = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];

export const RESOURCE_SUPPLY = 19;

export const DEV_DECK: Record<DevCardType, number> = {
  knight: 14,
  victoryPoint: 5,
  roadBuilding: 2,
  invention: 2,
  monopoly: 2,
};

export const PIECES = { settlements: 5, cities: 4, roads: 15 };

/** A card bundle from a partial list (every other kind at 0). */
export const cards = (partial: Partial<CardCounts>): CardCounts => ({ ...emptyCards(), ...partial });

export const COSTS = {
  road: cards({ brick: 1, wood: 1 }),
  settlement: cards({ brick: 1, wood: 1, wool: 1, wheat: 1 }),
  city: cards({ wheat: 2, ore: 3 }),
  devCard: cards({ wool: 1, wheat: 1, ore: 1 }),
} satisfies Record<string, CardCounts>;

export type BuildKind = keyof typeof COSTS;

/**
 * Bumped when a rules change would alter a recorded game (saves and replays are action lists).
 * 2: rebalanced beginner start positions.
 * 3: discard choices sampled from public data, independently of the hidden dice stream.
 */
export const RULES_VERSION = 3;

/** Friendly robber: players with this many visible points or fewer are spared. */
export const FRIENDLY_ROBBER_MAX_VP = 2;

/** Event deck: reshuffled (all 36 cards) once this few remain. */
export const EVENT_DECK_RESHUFFLE_AT = 5;

/** Allowed victory point targets. */
export const MIN_VICTORY_POINTS = 3;
export const MAX_VICTORY_POINTS = 30;

export const LONGEST_ROAD_MIN = 5;
export const LARGEST_ARMY_MIN = 3;
export const DISCARD_THRESHOLD = 7;

export const PLAYER_COLORS: PlayerColor[] = ['red', 'blue', 'white', 'orange'];

/** The nine harbour types, shuffled onto the port slots of a random island. */
export const STANDARD_PORTS: PortType[] = ['any', 'wool', 'any', 'any', 'brick', 'wood', 'any', 'wheat', 'ore'];

/** The beginner island's harbours, clockwise from the upper-left slot. */
export const BEGINNER_PORTS: PortType[] = ['wheat', 'any', 'wood', 'wool', 'brick', 'any', 'ore', 'any', 'any'];

/** Number of dots printed under each number disc (production probability out of 36). */
export const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

export function emptyCards(): CardCounts {
  return { brick: 0, wood: 0, wool: 0, wheat: 0, ore: 0, paper: 0, cloth: 0, silver: 0, oil: 0 };
}

/** Stable key for a card bundle (comma-separated so 1,11 and 11,1 differ). */
export const countsKey = (rc: CardCounts) => CARDS.map((r) => rc[r]).join(',');

/** The supply at the start: resources always; commodities and oil only when their modules add them (see the modules' init). */
export const fullBank = (): CardCounts => cards({
  brick: RESOURCE_SUPPLY,
  wood: RESOURCE_SUPPLY,
  wool: RESOURCE_SUPPLY,
  wheat: RESOURCE_SUPPLY,
  ore: RESOURCE_SUPPLY,
});

/** Each calibration knob's type, for validating options (see Knobs). */
export const KNOB_TYPES: Record<keyof Knobs, 'boolean' | 'number'> = {
  stackUpgrades: 'boolean',
  landingsPerBuilding: 'number',
  improvementLandings: 'boolean',
  prisonersPerPoint: 'number',
  pollutionLimit: 'number',
  floodOneIsland: 'boolean',
  corsairStays: 'boolean',
  pauperPoints: 'number',
};
