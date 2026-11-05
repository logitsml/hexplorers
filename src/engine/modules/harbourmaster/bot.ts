// The bot's eye for harbours: progress toward the award counts in its choice of settlement spots,
// and a building that takes the award is built as soon as it's affordable.

import type { BotCtx } from '../../ai/context';
import { canAfford, legalCities, legalSettlements } from '../../rules';
import type { Action } from '../../types';
import type { ModuleBot } from '../api';
import { HARBOUR_AWARD_MIN, HARBOUR_AWARD_POINTS, harbourPoints } from './points';

/** What one more point on harbours is worth to this bot, in victory-point equivalents. */
function pointWorth(ctx: BotCtx): number {
  const s = ctx.s;
  const mine = harbourPoints(s, ctx.me);
  const others = Math.max(0, ...ctx.opponents.map((o) => harbourPoints(s, o)));
  const after = mine + 1;
  // Holding it: a point is worth something only while someone is close behind.
  if (s.ext.harbourmaster?.holder === ctx.me) return others >= mine ? 0.6 : others === mine - 1 ? 0.3 : 0.05;
  if (after >= HARBOUR_AWARD_MIN && after > others) return HARBOUR_AWARD_POINTS;
  // Progress toward it, worth less once someone else is ahead.
  return 0.12 * Math.min(after, HARBOUR_AWARD_MIN - 1) * (after >= others ? 1 : 0.4);
}

/** Whether one more point on harbours would take the award now. */
function takesAward(ctx: BotCtx): boolean {
  const s = ctx.s;
  if (s.ext.harbourmaster?.holder === ctx.me) return false;
  const after = harbourPoints(s, ctx.me) + 1;
  return after >= HARBOUR_AWARD_MIN && ctx.opponents.every((o) => harbourPoints(s, o) < after);
}

export const harbourmasterBot: ModuleBot = {
  spotBonus(ctx, v) {
    return ctx.s.board.vertices[v].port ? pointWorth(ctx) : 0;
  },
  main(ctx): Action | null {
    const s = ctx.s;
    if (!takesAward(ctx)) return null;
    let best: { action: Action; value: number } | null = null;
    if (canAfford(s, ctx.me, 'settlement')) {
      for (const v of legalSettlements(s, ctx.me)) {
        if (!s.board.vertices[v].port) continue;
        const value = 1 + ctx.spotValue(v);
        if (!best || value > best.value) best = { action: { type: 'buildSettlement', vertex: v }, value };
      }
    }
    if (canAfford(s, ctx.me, 'city')) {
      for (const v of legalCities(s, ctx.me)) {
        if (!s.board.vertices[v].port) continue;
        const value = ctx.cityValue(v) + HARBOUR_AWARD_POINTS;
        if (!best || value > best.value) best = { action: { type: 'buildCity', vertex: v }, value };
      }
    }
    return best?.action ?? null;
  },
};
