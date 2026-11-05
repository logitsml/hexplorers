// What wells and foundries produce. Oil is handed out after the roll's other production, one at a
// time from the roller clockwise while the supply lasts, and never past a player's limit; so it
// goes round here rather than through the base hand-out, whose short-supply rule is all or nothing.

import type { Ctx } from '../../ctx';
import { modulesOf } from '../../modules';
import { numbersOf } from '../../rules';
import type { Building, GameState, Hex, PlayerId, Production } from '../../types';
import { RESOURCES } from '../../types';
import { oilRoom } from './rules';

/** Oil a building takes from a producing well: settlement 1, city 2, foundry 3. */
const oilYield = (b: Building): number => (b.kind === 'city' ? (b.foundry ? 3 : 2) : 1);

/** A foundry takes one more of each resource its city takes (never of a commodity: rule 6's table). */
export function foundryYields(_s: GameState, _hex: Hex, vertex: number, b: Building, grants: Production[]): Production[] {
  if (!b.foundry || b.kind !== 'city') return grants;
  return grants.map((g) => (g.vertex === vertex && (RESOURCES as readonly string[]).includes(g.resource) ? { ...g, amount: g.amount + 1 } : g));
}

/**
 * The oil a roll of `total` owes: every producing well's, to each building on it. Each building's
 * oil goes through the modules' yields hooks like any other production: a sickness caps it at one
 * a well, and conquest cuts it off.
 */
export function oilOwed(s: GameState, total: number): Production[] {
  const mods = modulesOf(s);
  const owed: Production[] = [];
  for (const hex of s.board.hexes) {
    if (!hex.well || !numbersOf(s, hex).includes(total)) continue;
    if (hex.id === s.robberHex || mods.some((m) => m.hooks?.hexBlocked?.(s, hex))) continue;
    for (const v of hex.vertices) {
      const b = s.buildings[v];
      if (!b) continue;
      let gs: Production[] = [{ player: b.owner, hex: hex.id, vertex: v, resource: 'oil', amount: oilYield(b) }];
      for (const m of mods) if (m.hooks?.yields) gs = m.hooks.yields(s, hex, v, b, gs);
      owed.push(...gs.filter((g) => g.resource === 'oil' && g.amount > 0));
    }
  }
  return owed;
}

/** Hand out the oil a roll of `total` brings, and return who got some. */
export function produceOil(ctx: Ctx, total: number): PlayerId[] {
  const s = ctx.s;
  const owed = oilOwed(s, total);
  if (owed.length === 0) return [];

  const n = s.players.length;
  const left = new Array<number>(n).fill(0);
  for (const g of owed) left[g.player] += g.amount;
  const got = new Array<number>(n).fill(0);
  // One at a time from the roller round the table, until everyone has theirs, is full, or the supply is out.
  let moved = true;
  while (moved && s.bank.oil > 0) {
    moved = false;
    for (let i = 0; i < n && s.bank.oil > 0; i++) {
      const p: PlayerId = (s.currentPlayer + i) % n;
      if (left[p] === 0 || oilRoom(s, p) === 0) continue;
      s.bank.oil--;
      s.players[p].hand.oil++;
      left[p]--;
      got[p]++;
      moved = true;
    }
  }
  const short = left.some((k, p) => k > 0 && oilRoom(s, p) > 0);
  // Each player's oil is credited to their buildings in board order.
  const grants: Production[] = [];
  for (const g of owed) {
    const amount = Math.min(g.amount, got[g.player]);
    if (amount <= 0) continue;
    got[g.player] -= amount;
    grants.push({ ...g, amount });
  }
  ctx.emit({ type: 'oil/produced', total, grants, short });
  return [...new Set(grants.map((g) => g.player))];
}

/** A set-up building's oil: one from each well beside it (as each terrain gives one of its resource). */
export function startingOil(ctx: Ctx, player: PlayerId, vertex: number) {
  const s = ctx.s;
  const wells = s.board.vertices[vertex].hexes.filter((h) => s.board.hexes[h].well).length;
  const amount = Math.min(wells, s.bank.oil, oilRoom(s, player));
  if (amount <= 0) return;
  s.bank.oil -= amount;
  s.players[player].hand.oil += amount;
  ctx.emit({ type: 'oil/startingOil', player, vertex, amount });
}
