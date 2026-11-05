// The expansions as players choose them: the toggles on the set-up page, the named presets, the
// map a mix plays on, its points target and how well-trodden it is (docs/expansions.md).

import type { Knobs, ModuleId } from './types';
import { MODULE_IDS } from './types';
import { MAP_INFO } from './maps';

/** What a player switches on: each expansion is one or more modules. */
export type Expansion = 'sea' | 'guilds' | 'invasion' | 'rivers' | 'caravans' | 'fisheries' | 'oil' | 'almanac' | 'harbourmaster';

export const EXPANSIONS: { id: Expansion; name: string; blurb: string }[] = [
  { id: 'sea', name: 'Sea Lanes', blurb: 'Ships, islets across the water, bounty fields and the corsair' },
  { id: 'guilds', name: 'Guilds & Garrisons', blurb: 'Commodities, guild seats, venture cards, wardens and the raider fleet' },
  { id: 'invasion', name: 'Invasion', blurb: 'Raiders land on the coast as the island grows; wardens drive them off' },
  { id: 'rivers', name: 'Rivers', blurb: 'Bridges, coins for building along the water, the richest and the poorest' },
  { id: 'caravans', name: 'Wagon Trains', blurb: 'Wagons from the oasis, placed by auction' },
  { id: 'fisheries', name: 'Fisheries', blurb: 'A lake and fishing grounds; fish buy favours; beware the Soggy Boot' },
  { id: 'oil', name: 'Oil', blurb: 'Wells, foundries and the disasters burning oil brings' },
  { id: 'almanac', name: 'Almanac', blurb: 'A deck of the year’s happenings instead of dice' },
  { id: 'harbourmaster', name: 'Port Captain', blurb: 'Two points for the busiest harbours' },
];

/** The modules a set of expansions plays with. Invasion takes the raider fleet's place (rule 8). */
export function modulesFor(expansions: readonly Expansion[]): ModuleId[] {
  const ids = new Set<ModuleId>();
  for (const e of expansions) {
    if (e === 'guilds') {
      ids.add('guilds');
      ids.add('garrisons');
      if (!expansions.includes('invasion')) ids.add('fleet');
    } else ids.add(e);
  }
  return MODULE_IDS.filter((m) => ids.has(m));
}

/** The expansions a set of modules came from (the inverse of modulesFor). */
export function expansionsOf(modules: readonly ModuleId[]): Expansion[] {
  return EXPANSIONS.map((e) => e.id).filter((e) => (e === 'guilds' ? modules.includes('guilds') : modules.includes(e as ModuleId)));
}

/** Every in-scope expansion: the flagship. */
export const ALL_HANDS: Expansion[] = EXPANSIONS.map((e) => e.id);

/** The maps of one landmass, for the base game and expansions without Sea Lanes (docs/maps.md, Kinds of map). */
const LAND_POOL = ['classic', 'longIsle', 'isthmus', 'horseshoe', 'wild'];
/** The sea maps, for Sea Lanes: islets played for First Landing, then fog played for Fog. */
const SEA_POOL = ['archipelago', 'strait', 'twinIsles', 'fogBank', 'lostSea'];

/**
 * The maps a mix can be played on, its flagship first (the one the set-up page offers until another
 * is chosen): the All Hands map for the whole flagship, the sea maps with Sea Lanes, and the maps
 * of one landmass otherwise, the base game included. Every map has room for every expansion.
 */
export function poolFor(expansions: readonly Expansion[]): string[] {
  if (ALL_HANDS.every((e) => expansions.includes(e))) return ['allHands'];
  return expansions.includes('sea') ? SEA_POOL : LAND_POOL;
}

const mapFor = (expansions: readonly Expansion[]): string => poolFor(expansions)[0];


/**
 * The points target (rule 9): the map's own, plus each expansion's delta. Presets carry tuned
 * values instead; this is the starting point for a custom mix, which the host can adjust.
 */
export function targetFor(expansions: readonly Expansion[], map = mapFor(expansions)): number {
  const sea = map !== 'classic';
  let t = MAP_INFO[map]?.target ?? 10;
  if (expansions.includes('guilds')) t += sea ? 2 : 3;
  if (expansions.includes('caravans')) t += 2;
  if (expansions.includes('invasion') && !expansions.includes('guilds')) t += 2;
  if (expansions.includes('harbourmaster')) t += 1;
  if (expansions.includes('oil')) t += 2;
  // (Bot games on Rivers alone ran short, a fifth of them under forty turns: a point more.)
  if (expansions.includes('rivers')) t += 1;
  return t;
}

/** How much we know about a mix (docs/expansions.md, Compatibility). */
export type Grade = 'settled' | 'derived' | 'speculative';
const RANK: Record<Grade, number> = { settled: 0, derived: 1, speculative: 2 };

/** The grade of each pair of expansions; any pair not listed is settled. */
const PAIRS: Partial<Record<string, Grade>> = {
  'fisheries+sea': 'derived',
  'fisheries+rivers': 'derived',
  'caravans+fisheries': 'derived',
  'caravans+rivers': 'derived',
  'fisheries+invasion': 'speculative',
  'invasion+rivers': 'speculative',
  'caravans+invasion': 'speculative',
  'oil+sea': 'speculative',
  'guilds+oil': 'speculative',
  'harbourmaster+oil': 'derived',
  'almanac+oil': 'derived',
  'fisheries+oil': 'speculative',
  'oil+rivers': 'speculative',
  'caravans+oil': 'speculative',
  'invasion+oil': 'speculative',
};

/** A mix's grade: the weakest of its pairs. */
function gradeOf(expansions: readonly Expansion[]): Grade {
  let worst: Grade = 'settled';
  for (let i = 0; i < expansions.length; i++) {
    for (let j = i + 1; j < expansions.length; j++) {
      const key = [expansions[i], expansions[j]].sort().join('+');
      const g = PAIRS[key] ?? 'settled';
      if (RANK[g] > RANK[worst]) worst = g;
    }
  }
  return worst;
}

interface Preset {
  id: string;
  name: string;
  blurb: string;
  expansions: Expansion[];
  /** Tuned target (else the formula's). */
  target?: number;
  map?: string;
  knobs?: Knobs;
}

/** The named mixes (docs/all-hands.md and docs/expansion-rulesets.md). Targets marked provisional there are starting points. */
export const PRESETS: Preset[] = [
  {
    id: 'allHands',
    name: 'All Hands',
    blurb: 'Every expansion at once: the whole archipelago',
    expansions: ALL_HANDS,
    target: 21,
    map: 'allHands',
    // (Improvements set off landings too: without them, bot playtests found the raiders a nuisance
    // rather than a threat. See docs/all-hands.md, decision 3. The corsair stays beside Invasion,
    // decision 1, where rule 4 would take it off.)
    knobs: { landingsPerBuilding: 1, improvementLandings: true, prisonersPerPoint: 3, pollutionLimit: 10, floodOneIsland: true, corsairStays: true },
  },
  { id: 'longVoyage', name: 'The Long Voyage', blurb: 'Sea Lanes with Guilds & Garrisons', expansions: ['sea', 'guilds'], target: 16 },
  { id: 'siege', name: 'Siege of the Coast', blurb: 'Invasion with Guilds & Garrisons', expansions: ['guilds', 'invasion'], target: 13 },
  { id: 'rivermouth', name: 'Rivermouth Fair', blurb: 'Rivers, Wagon Trains and Port Captain on the classic island', expansions: ['rivers', 'caravans', 'harbourmaster'], target: 14 },
  { id: 'fishingArchipelago', name: 'Fishing the Archipelago', blurb: 'Sea Lanes with Fisheries', expansions: ['sea', 'fisheries'] },
];

/** The named preset a set of expansions makes up, if any (a preset is its set: picking the same toggles by hand is the same game). */
function presetOf(expansions: readonly Expansion[]): Preset | undefined {
  return PRESETS.find((p) => p.expansions.length === expansions.length && p.expansions.every((e) => expansions.includes(e)));
}

/** Everything a game needs from a choice of expansions. */
interface Mix {
  expansions: Expansion[];
  modules: ModuleId[];
  map: string;
  knobs: Knobs;
  /** The suggested points target (the preset's tuned one, else rule 9's). */
  target: number;
  grade: Grade;
  preset?: Preset;
  /** Whether its map exists yet and has room for every expansion's features. */
  playable: boolean;
}

/** A choice of expansions as a game: `pick` chooses the map from the mix's pool (its flagship when it isn't there) unless a preset fixes one. */
export function mixOf(chosen: readonly Expansion[], pick?: string): Mix {
  const expansions = ALL_HANDS.filter((e) => chosen.includes(e));
  const preset = presetOf(expansions);
  const pool = poolFor(expansions);
  const map = preset?.map ?? (pick && pool.includes(pick) ? pick : pool[0]);
  const modules = modulesFor(expansions);
  return {
    expansions,
    modules,
    map,
    knobs: preset?.knobs ?? {},
    target: preset?.target ?? targetFor(expansions, map),
    grade: gradeOf(expansions),
    preset,
    playable: map in MAP_INFO,
  };
}
