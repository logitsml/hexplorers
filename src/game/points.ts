// Where a seat's points come from beyond its buildings' face value, the two base awards and hidden
// cards, read from the engine's own reckoning: each module's change to each building's worth (a
// guild seat, a wagon, a foundry, a conquest), taken in the engine's own order, and each module's
// own points, split where a module counts several things (shown ventures and the trader, oil
// sequestered and the Steward, the Richest and Pauper tiles). Whatever a module counts that isn't
// named here still shows, under the module's name, so the parts always add up to the engine's
// total. All of it is public, so it's the same for every seat at the table.

import type { GameState, ModuleId, PlayerId } from '../engine';
import { modulesOf } from '../engine/modules';
import { TRADER_POINTS } from '../engine/modules/guilds/rules';
import { SEQUESTER_PER_POINT } from '../engine/modules/oil/rules';
import { FIRST_LANDING_POINTS } from '../engine/modules/sea/rules';
import { HARBOUR_AWARD_POINTS } from '../engine/modules/harbourmaster/points';
import { prisonerPoints } from '../engine/modules/invasion/raids';
import { RICHEST_POINTS, coinsOf, pauperPoints, wealthOf } from '../engine/modules/rivers/queries';
import { count } from './modulePanels';

export interface PointPart {
  key: string;
  /** What the points are for, in a few words: "2 guild seats", "Port Captain". */
  words: string;
  n: number;
}

/** What a module's change to a building's worth is, by how many buildings it changed. */
const BUILDING_WORDS: Partial<Record<ModuleId, (k: number) => string>> = {
  guilds: (k) => count(k, 'guild seat'),
  invasion: (k) => `${count(k, 'building')} conquered`,
  caravans: (k) => count(k, 'wagon point'),
  oil: (k) => count(k, 'foundry', 'foundries'),
};

/** A module's own points, by what they're for (any left over are put down to the module). */
const SPLIT: Partial<Record<ModuleId, (s: GameState, p: PlayerId) => PointPart[]>> = {
  guilds: (s, p) => {
    const g = s.ext.guilds!;
    return [
      { key: 'ventures', words: `${count(g.shown[p].length, 'victory venture')} shown`, n: g.shown[p].length },
      { key: 'trader', words: 'the Trader', n: g.trader?.owner === p ? TRADER_POINTS : 0 },
    ];
  },
  fleet: (s, p) => [{ key: 'defence', words: count(s.ext.fleet!.tokens[p], 'defence token'), n: s.ext.fleet!.tokens[p] }],
  harbourmaster: (s, p) => [{ key: 'harbourmaster', words: 'Port Captain', n: s.ext.harbourmaster?.holder === p ? HARBOUR_AWARD_POINTS : 0 }],
  // (Prisoners make points as they're held, and as they're traded back once the raiders run out.)
  invasion: (s, p) => [{ key: 'prisoners', words: 'prisoners', n: prisonerPoints(s, p) }],
  sea: (s, p) => {
    const k = s.ext.sea?.landed?.[p].length ?? 0;
    return [{ key: 'landings', words: count(k, 'first landing'), n: k * FIRST_LANDING_POINTS }];
  },
  rivers: (s, p) => {
    // (Counted from the coins as they are, as the engine counts them.)
    const w = wealthOf(coinsOf(s));
    return [
      { key: 'richest', words: 'Richest', n: w.richest === p ? RICHEST_POINTS : 0 },
      { key: 'pauper', words: 'Pauper', n: w.paupers.includes(p) ? -pauperPoints(s) : 0 },
    ];
  },
  oil: (s, p) => {
    const o = s.ext.oil!;
    return [
      { key: 'sequestered', words: `${o.sequestered[p]} oil sequestered`, n: Math.floor(o.sequestered[p] / SEQUESTER_PER_POINT) },
      { key: 'steward', words: 'Steward', n: o.steward === p ? 1 : 0 },
    ];
  },
};

/** The display name a module's leftover points go under. */
const MODULE_WORDS: Partial<Record<ModuleId, string>> = { guilds: 'guilds', fleet: 'the fleet', invasion: 'the invasion', sea: 'the sea', rivers: 'the rivers', oil: 'oil', harbourmaster: 'harbours', caravans: 'wagons' };

/** Every point `p` has beyond its buildings' face value (1 a settlement, 2 a city), the two base awards and hidden cards. */
export function pointParts(s: GameState, p: PlayerId): PointPart[] {
  const out: PointPart[] = [];
  // Each module's change to each building's worth, taken in the engine's order (a conquest takes
  // what a seat added; a wagon after it adds again), so each change goes to the module that made it.
  const changed = new Map<ModuleId, { n: number; k: number }>();
  s.buildings.forEach((b, v) => {
    if (!b || b.owner !== p) return;
    let worth = b.kind === 'city' ? 2 : 1;
    for (const m of modulesOf(s)) {
      const f = m.hooks?.buildingWorth;
      if (!f) continue;
      const next = f(s, v, worth);
      if (next !== worth) {
        const c = changed.get(m.id) ?? { n: 0, k: 0 };
        c.n += next - worth;
        c.k++;
        changed.set(m.id, c);
      }
      worth = next;
    }
  });
  for (const [id, c] of changed) out.push({ key: `${id}-buildings`, words: BUILDING_WORDS[id]?.(c.k) ?? `${MODULE_WORDS[id] ?? id} buildings`, n: c.n });
  for (const m of modulesOf(s)) {
    const f = m.hooks?.victoryPoints;
    if (!f) continue;
    const total = f(s, p);
    const parts = (SPLIT[m.id]?.(s, p) ?? []).filter((x) => x.n !== 0);
    const rest = total - parts.reduce((t, x) => t + x.n, 0);
    out.push(...parts);
    if (rest !== 0) out.push({ key: m.id, words: MODULE_WORDS[m.id] ?? m.id, n: rest });
  }
  return out.filter((x) => x.n !== 0);
}

/** "+2", "−2". */
export const signed = (n: number) => (n > 0 ? `+${n}` : `−${-n}`);
