// Bounty fields: each producing building's owner picks resources of their choice (never a
// commodity), one decision per player, from the player whose turn it is round the table.

import type { Ctx } from '../../ctx';
import type { CardCounts, GameState, Pending, PlayerId, Resource } from '../../types';
import { RESOURCES } from '../../types';
import type { BountyOwed, BountyReason } from './types';

export const BOUNTY_PICK = 'sea/bountyPick';

/** Resources the bank still holds in all. */
export const bankResources = (bank: CardCounts): number => RESOURCES.reduce((n, r) => n + bank[r], 0);

/** How many resources the pick on top of the stack takes now: what's owed, or what the bank has left. */
export const pickSize = (s: GameState, p: Pending): number => Math.min((p.data as BountyOwed).count, bankResources(s.bank));

/** Owe each player their picks: a decision each, the current player's on top, then round the table. */
export function oweBounty(ctx: Ctx, owed: Map<PlayerId, number>, reason: BountyReason) {
  const s = ctx.s;
  const n = s.players.length;
  const order = [...owed.keys()].filter((p) => owed.get(p)! > 0).sort((a, b) => ((a - s.currentPlayer + n) % n) - ((b - s.currentPlayer + n) % n));
  if (order.length === 0) return;
  ctx.emit({ type: 'sea/bountyOwed', owed: Object.fromEntries(order.map((p) => [p, owed.get(p)!])), reason });
  // (Top last: the first to choose goes on last.)
  for (const p of order.reverse()) s.pending.push({ kind: BOUNTY_PICK, players: [p], data: { count: owed.get(p)!, reason } satisfies BountyOwed });
}

/** Every distinct pick of `size` resources the bank can give. */
export function pickOptions(bank: CardCounts, size: number): Resource[][] {
  const out: Resource[][] = [];
  const cur: Resource[] = [];
  const rec = (from: number, left: number) => {
    if (left === 0) {
      out.push(cur.slice());
      return;
    }
    for (let i = from; i < RESOURCES.length; i++) {
      const r = RESOURCES[i];
      if (cur.filter((x) => x === r).length >= bank[r]) continue;
      cur.push(r);
      rec(i, left - 1);
      cur.pop();
    }
  };
  rec(0, size);
  return out;
}
