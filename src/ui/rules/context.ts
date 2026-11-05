// What the expansion pages need to know about the game they're read in: which expansions are in
// play, the mix's knobs and target, and whether there is a game at all (from the title every page
// is shown, and every note about how two expansions meet).

import type { GameState, Knobs, ModuleId } from '../../engine';
import { EXPANSIONS, PRESETS, expansionsOf, type Expansion } from '../../engine/presets';

export interface RulesCtx {
  /** Read in a game (else from the title, where every page and note is shown). */
  inGame: boolean;
  /** The expansions in play, in the set-up page's order (empty from the title or in a base game). */
  inPlay: Expansion[];
  /** The modules in play (Guilds & Garrisons is two or three of them). */
  modules: ReadonlySet<ModuleId>;
  knobs: Partial<Knobs>;
  /** The game's points target, when there is a game. */
  target: number | null;
  /** The map's id, when there is a game. */
  map: string | null;
  /** The named preset the mix makes up, if any. */
  preset: string | null;
  /** The base game's event deck stands in for the dice (the guilds then throw a red die of their own). */
  eventDeck: boolean;
}

export function rulesCtx(view: GameState | null, inGame: boolean): RulesCtx {
  if (!view || !inGame) return { inGame: false, inPlay: [], modules: new Set(), knobs: {}, target: null, map: null, preset: null, eventDeck: false };
  const modules = view.options.modules;
  const inPlay = expansionsOf(modules);
  const preset = PRESETS.find((p) => p.expansions.length === inPlay.length && p.expansions.every((e) => inPlay.includes(e)));
  return {
    inGame: true,
    inPlay,
    modules: new Set(modules),
    knobs: view.options.knobs ?? {},
    target: view.options.victoryPoints,
    map: view.options.map ?? null,
    preset: preset?.name ?? null,
    eventDeck: view.options.eventDeck,
  };
}

/** Whether a note about these expansions applies: every one of them in play, or any game from the title. */
export const applies = (ctx: RulesCtx, ...with_: Expansion[]): boolean => !ctx.inGame || with_.every((e) => ctx.inPlay.includes(e));

export const nameOf = (e: Expansion): string => EXPANSIONS.find((x) => x.id === e)!.name;
export const blurbOf = (e: Expansion): string => EXPANSIONS.find((x) => x.id === e)!.blurb;
