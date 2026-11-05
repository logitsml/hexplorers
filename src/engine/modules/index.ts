// The rule modules, and the helpers the base engine uses to run their hooks.

import type { GameState, ModuleId } from '../types';
import type { RuleModule } from './api';
import { sea } from './sea';
import { guilds } from './guilds';
import { garrisons } from './garrisons';
import { fleet } from './fleet';
import { invasion } from './invasion';
import { rivers } from './rivers';
import { caravans } from './caravans';
import { fisheries } from './fisheries';
import { oil } from './oil';
import { almanac } from './almanac';
import { harbourmaster } from './harbourmaster';

export const MODULES: Record<ModuleId, RuleModule> = { sea, guilds, garrisons, fleet, invasion, rivers, caravans, fisheries, oil, almanac, harbourmaster };

const NONE: readonly RuleModule[] = Object.freeze([]);
const listCache = new WeakMap<readonly ModuleId[], readonly RuleModule[]>();
let lastIds: readonly ModuleId[] | null = null;
let lastList: readonly RuleModule[] = NONE;

/**
 * The modules in play, in hook order. Every query asks this, so the list is kept per game, keyed
 * on its options' list of ids, which every state of one game shares and nothing changes in place
 * (the last game's is kept to hand, as almost every call is for it).
 */
export function modulesOf(s: GameState): readonly RuleModule[] {
  const ids = s.options.modules;
  if (ids === lastIds && ids.length === lastList.length) return lastList;
  if (ids.length === 0) return NONE;
  let mods = listCache.get(ids);
  if (!mods || mods.length !== ids.length) {
    mods = Object.freeze(ids.map((id) => MODULES[id]));
    listCache.set(ids, mods);
  }
  lastIds = ids;
  lastList = mods;
  return mods;
}

export const hasModule = (s: GameState, id: ModuleId): boolean => s.options.modules.includes(id);
