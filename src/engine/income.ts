// What a player's buildings can expect to bring in on a roll, for the interface's estimates (the
// supply's income figures). Production never reads it. For each roll it takes production's own
// grants (rollGrants: the numbers a hex still has, the blockers, the yields) and what the modules
// hand out after them (afterYields, by the code their afterProduction uses), so the estimate keeps
// up with the expansions on its own.
//
// Left out: a bank too short to pay, fish and coins (tokens, not cards), and the fall-backs for a
// roll that brings nothing (rule 6), which hang on everything else a roll brings.

import { PIPS, emptyCards } from './constants';
import { modulesOf } from './modules';
import { rollGrants } from './reducer';
import type { CardCounts, GameState, PlayerId } from './types';
import { CARDS } from './types';

interface Income {
  /** Cards of each kind. */
  per: CardCounts;
  /** Resources of the player's choice (a bounty field's picks). */
  picks: number;
}

/** What `player`'s buildings would take on a roll of `total` (a bank permitting): what production hands out, worked out by its own code. */
export function incomeOn(s: GameState, player: PlayerId, total: number): Income {
  const per = emptyCards();
  let picks = 0;
  for (const g of rollGrants(s, total).grants) if (g.player === player) per[g.resource] += g.amount;
  for (const m of modulesOf(s)) {
    const more = m.hooks?.afterYields?.(s, player, total);
    for (const k of CARDS) per[k] += more?.cards?.[k] ?? 0;
    picks += more?.picks ?? 0;
  }
  return { per, picks };
}

/** What `player`'s buildings bring in on an average roll: each roll's take, weighted by the dice. */
export function expectedIncome(s: GameState, player: PlayerId): Income {
  const per = emptyCards();
  let picks = 0;
  for (let total = 2; total <= 12; total++) {
    const chance = (PIPS[total] ?? 0) / 36;
    if (chance === 0) continue;
    const roll = incomeOn(s, player, total);
    for (const k of CARDS) per[k] += chance * roll.per[k];
    picks += chance * roll.picks;
  }
  return { per, picks };
}
