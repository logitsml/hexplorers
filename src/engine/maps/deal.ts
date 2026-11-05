// Dealing a game's board. A new game's is dealt once, when the game is set up, and carried whole in
// its options (GameOptions.board), so saves and replays never deal again: how maps are dealt can
// change from one release to the next without altering a recorded game, and without a rules
// version. (createGame deals one the same way when it's given none: the tests and the editor's
// checks build games so.)
//
// The deal draws from its own stream of the game's seed, so a seed always deals the same island
// (?seed= and the screenshot scripts rely on it) while the game's own dice start fresh.
//
// Players' own maps and the beginner set-up come as they're laid out, and the base game keeps its
// own deals of the classic island; on these the modules only place what a map doesn't carry. Every
// other map is dealt by the home island's rules (docs/maps.md): the map's outline and its bags of
// tiles and discs (a drawing, or what a generator grows), the features each module places by those
// rules (its shapeMap hook: the castle on its corner, the rivers as stamps, the grounds spread
// round), the harbours round the home coast clear of them all, and then the annealer
// (maps/anneal.ts), which trades terrain, numbers and harbour kinds until the rules hold.

import { beginnerLayout, classicSpec, randomLayout, type BoardSpec } from '../board';
import { MODULES } from '../modules';
import { KeyedRng, STREAM } from '../keyedRng';
import { Rng, seedFrom } from '../rng';
import type { GameOptions, ModuleId } from '../types';
import { anneal } from './anneal';
import { archipelago } from './archipelago';
import { DRAWN } from './atlas';
import { carried, customSpec } from './custom';
import { drawnMap, wildIsland } from './outline';
import { placeHarbours } from './place';
import { homeIslands, partReds } from './shape';

/** Salts the seed for the deal (`map.`), so the board and the game's dice are separate streams. */
const DEAL_SALT = 0x6d61702e;

/** The classic island as board.ts lays it out: the beginner set-up, or a random deal. */
const classic = (options: GameOptions, rng: Rng) => classicSpec(options.layout === 'beginner' ? beginnerLayout() : randomLayout(rng, options.numberPlacement));

/** The maps laid out or grown afresh each game. */
const GROWN: Record<string, (options: GameOptions, rng: Rng) => BoardSpec> = { classic, archipelago, wild: wildIsland };

/** Where a map starts, before its features: what its generator grows, or its drawing. */
function outline(options: GameOptions, rng: Rng): BoardSpec {
  const grow = GROWN[options.map];
  if (grow) return grow(options, rng);
  const drawn = DRAWN[options.map];
  if (!drawn) throw new Error(`There's no map called ${options.map}.`);
  return drawnMap(drawn, options, rng);
}

/**
 * The board a game with these (whole) options plays on, dealt from its seed: their own `board` aside.
 * A keyed game deals from its key's own stream instead (`rngKey`), as its seed is public.
 */
export function dealSpec(options: GameOptions, rngKey?: string): BoardSpec {
  const rng = rngKey !== undefined ? new KeyedRng(rngKey, 0, STREAM.deal) : new Rng(seedFrom(options.seed ^ DEAL_SALT));
  const shape = (spec: BoardSpec, skip: ReadonlySet<ModuleId> = new Set()) => {
    for (const id of options.modules) if (!skip.has(id)) MODULES[id].hooks?.shapeMap?.(spec, options, rng);
  };
  const fixed = options.map === 'custom' || (options.map === 'classic' && (options.layout === 'beginner' || options.modules.length === 0));
  if (fixed) {
    const spec = options.map === 'custom' ? customSpec(options.custom!, rng, options.modules.includes('sea')) : classic(options, rng);
    const own = options.map === 'custom' ? carried(options.custom!) : new Set<ModuleId>();
    if (options.modules.some((id) => !own.has(id) && MODULES[id].hooks?.shapeMap)) {
      shape(spec, own);
      // (Between them, the shapers can leave red numbers side by side: they're parted last.)
      partReds(spec);
    }
    return spec;
  }

  const spec = outline(options, rng);
  shape(spec);
  partReds(spec);
  if (homeIslands(spec).length === 1) placeHarbours(spec, rng);
  anneal(spec, options.modules, rng);
  return spec;
}
