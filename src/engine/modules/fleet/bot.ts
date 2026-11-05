// The fleet's bot: when the raiders come for one of its cities, it buys the city off if it can
// (Rivers' coins), and otherwise gives up the city that produces least.

import type { Action, Pending } from '../../types';
import type { BotCtx } from '../../ai/context';
import type { ModuleBot } from '../api';
import type { PillagePending } from './types';

function pending(ctx: BotCtx, p: Pending): Action | null {
  if (p.kind !== 'fleet/pillage') return null;
  if (ctx.s.options.modules.includes('rivers') && ctx.player.coins >= 5) return { type: 'fleet/ransom' };
  const cities = (p.data as PillagePending).cities;
  let best = cities[0];
  for (const v of cities) if (ctx.cityValue(v) < ctx.cityValue(best)) best = v;
  return { type: 'fleet/yield', vertex: best };
}

export const fleetBot: ModuleBot = { pending };
