// Raiders: the numbers that govern them, where a landing goes, the supply they come from, and the
// landings that buildings, the event die and the guilds' improvements set off.

import type { Ctx } from '../../ctx';
import { numbersOf } from '../../rules';
import type { GameState, PlayerId } from '../../types';
import { topology } from './topology';
import type { InvasionState, LandingCause } from './types';

/** Raiders in the box. */
export const RAIDERS = 36;
/** Coins for each tied participant who loses the roll for a prisoner, each one left without, and each warden lost. */
export const BATTLE_COINS = 3;

export const inv = (s: GameState): InvasionState => s.ext.invasion!;

/** The guilds are in play: their ventures replace the muster deck, the event die lands raiders, and raiders never run out. */
export const withGuilds = (s: GameState): boolean => s.options.modules.includes('guilds');
/** The garrisons are in play: wardens have ranks and rest, and the garrisons recruit them. */
export const withGarrisons = (s: GameState): boolean => s.options.modules.includes('garrisons');
/** Raiders never run out alongside the guilds: three prisoners go back for a point token instead. */
export const unlimitedRaiders = withGuilds;
/** The muster deck replaces the development cards, unless the guilds' ventures do. */
export const musterDeckInPlay = (s: GameState): boolean => !withGuilds(s);

/** Different non-7 totals each settlement or city sets off (knob; default 3, the published procedure). */
export function landingsPerBuilding(s: GameState): number {
  const k = s.options.knobs.landingsPerBuilding;
  // (Only ten totals other than 7 exist.)
  return k === undefined ? 3 : Math.min(10, Math.max(0, Math.floor(k)));
}

/** Whether each guild improvement sets off a landing (knob; default yes). */
export const improvementLandings = (s: GameState): boolean => s.options.knobs.improvementLandings ?? true;

/** Prisoners per victory point (knob; 2 by default, or 3 alongside the guilds). */
export function prisonersPerPoint(s: GameState): number {
  const k = s.options.knobs.prisonersPerPoint ?? (withGuilds(s) ? 3 : 2);
  return Math.max(1, Math.floor(k));
}

/** Points from prisoners and the tokens traded for them. */
export function prisonerPoints(s: GameState, player: PlayerId): number {
  const i = inv(s);
  return Math.floor(i.prisoners[player] / prisonersPerPoint(s)) + i.tokens[player];
}

/**
 * Where a landing at `number` goes: of the home coast's hexes bearing that number with fewer than
 * three raiders, the one with fewest, ties going to the first clockwise from the castle. Null when
 * none qualifies (nothing lands).
 */
export function landingHex(s: GameState, number: number): number | null {
  const raiders = inv(s).raiders;
  let best: number | null = null;
  for (const h of topology(s.board).coast) {
    if (raiders[h] >= 3 || !numbersOf(s, s.board.hexes[h]).includes(number)) continue;
    if (best === null || raiders[h] < raiders[best]) best = h;
  }
  return best;
}

/** Whether a raider is still there to land. */
const raiderAvailable = (s: GameState): boolean => unlimitedRaiders(s) || inv(s).supply > 0;

/**
 * Take a raider from the supply. With unlimited raiders an empty supply is refilled by trading a
 * point's worth of prisoners (three by default, the prisonersPerPoint knob) for a point token, so
 * nobody's points change: the player holding most, ties going to the first from the player whose
 * turn it is. With nobody holding that many, the raider comes from beyond the box.
 */
export function takeRaider(ctx: Ctx): boolean {
  const s = ctx.s;
  const i = inv(s);
  if (i.supply <= 0) {
    if (!unlimitedRaiders(s)) return false;
    const n = s.players.length;
    const point = prisonersPerPoint(s);
    let donor: PlayerId | null = null;
    for (let k = 0; k < n; k++) {
      const p = (s.currentPlayer + k) % n;
      if (i.prisoners[p] >= point && (donor === null || i.prisoners[p] > i.prisoners[donor])) donor = p;
    }
    if (donor !== null) {
      i.prisoners[donor] -= point;
      i.tokens[donor]++;
      i.supply += point;
      ctx.emit({ type: 'invasion/prisonersTraded', player: donor });
    } else {
      i.extra++;
      i.supply++;
    }
  }
  i.supply--;
  return true;
}

/** One landing at `number` (the total `dice` show, or the production number): a raider goes where the selector says, if anywhere. */
export function land(ctx: Ctx, player: PlayerId, cause: LandingCause, dice: [number, number], number: number) {
  const s = ctx.s;
  const hex = number === 7 ? null : landingHex(s, number);
  if (hex !== null && !takeRaider(ctx)) {
    ctx.emit({ type: 'invasion/supplyEmpty', player });
    return;
  }
  if (hex !== null) inv(s).raiders[hex]++;
  ctx.emit({ type: 'invasion/landed', player, cause, dice, number, hex, raiders: hex === null ? 0 : inv(s).raiders[hex] });
}

/**
 * The landings a new settlement or city sets off: up to `landingsPerBuilding` different totals,
 * each rolled until it is neither 7 nor a total already rolled, stopping when the supply runs out.
 * A total whose hex can take no more raiders still counts as one of them.
 */
export function buildingLandings(ctx: Ctx, player: PlayerId) {
  const s = ctx.s;
  const rolled: number[] = [];
  for (let k = 0; k < landingsPerBuilding(s); k++) {
    if (!raiderAvailable(s)) {
      ctx.emit({ type: 'invasion/supplyEmpty', player });
      return;
    }
    let dice: [number, number];
    do dice = [ctx.rng.die(), ctx.rng.die()];
    while (dice[0] + dice[1] === 7 || rolled.includes(dice[0] + dice[1]));
    rolled.push(dice[0] + dice[1]);
    land(ctx, player, 'build', dice, dice[0] + dice[1]);
  }
}

/** Raiders on the board. */
export const raidersOnBoard = (s: GameState): number => inv(s).raiders.reduce((a, b) => a + b, 0);
