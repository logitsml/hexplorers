// Raider Fleet: each ship on the event die sails the fleet a step closer, and when it reaches the
// island it attacks. Its strength is every city on the board; the defence is every mustered
// warden's rank. If the defence falls short, whoever defended least loses a city; if it holds, the
// best defender takes a point. Every warden rests afterwards and the fleet sets out again. The
// robber (and the corsair) wait off the board until the first attack.

import { type Ctx, addCoins, assert, fail } from '../../ctx';
import { modulesOf } from '..';
import { refugeHex } from '../../rules';
import type { Action, GameState, PlayerId } from '../../types';
import type { RuleModule } from '../api';
import { corsairHex, eventFace, setCorsair } from '../shared';
import { oweVentureChoice } from '../guilds/deck';
import { musteredStrength } from '../garrisons/wardens';
import { fleetBot } from './bot';
import type { FleetAction, PillagePending } from './types';

/** Steps from the start of the fleet's track to the island: seven ship faces bring an attack. */
export const FLEET_STEPS = 7;
/** Coins that buy a city off the raiders (Rivers). */
export const RANSOM = 5;

const fleetOf = (s: GameState) => s.ext.fleet!;

/** Cities on the board: the fleet's strength. */
export function fleetStrength(s: GameState): number {
  let n = 0;
  for (const b of s.buildings) if (b?.kind === 'city') n++;
  return n;
}

/** Cities the raiders may take from `player`: never a seat (or a foundry, which stands like one). */
export function pillageable(s: GameState, player: PlayerId): number[] {
  const out: number[] = [];
  s.buildings.forEach((b, v) => {
    if (b && b.owner === player && b.kind === 'city' && !b.seat && !b.foundry) out.push(v);
  });
  return out;
}

/** Whether a player may buy a city off (Rivers, with the coins). */
const canRansom = (s: GameState, player: PlayerId) => s.options.modules.includes('rivers') && s.players[player].coins >= RANSOM;

/** The raiders take the city at `vertex` down to a settlement; its wall goes back to its owner. */
export function pillage(ctx: Ctx, vertex: number) {
  const s = ctx.s;
  const b = s.buildings[vertex]!;
  const me = s.players[b.owner];
  delete b.wall;
  b.kind = 'settlement';
  let lying = false;
  if (me.settlementsLeft > 0) {
    me.settlementsLeft--;
    me.citiesLeft++;
  } else {
    // No settlement piece free: the city piece lies on its side as one, and must be stood up next.
    b.lying = true;
    lying = true;
  }
  ctx.emit({ type: 'fleet/pillaged', player: b.owner, vertex, lying });
}

/** What a landing would do as the island stands: the attack's own reckoning, so the table can be told it beforehand. */
export interface Landing {
  /** Cities on the board. */
  strength: number;
  /** Every mustered warden's rank. */
  defence: number;
  /** Each player's share of the defence. */
  contributions: number[];
  /** Whether the defence holds (it holds on a tie). */
  won: boolean;
  /** Falling short: the least defenders with a city to lose, in turn order from the player whose turn it is. */
  losers: PlayerId[];
  /** Holding: the one best defender, who takes a defence token. */
  token: PlayerId | null;
  /** Holding with a tie at the top: those tied, who each draw a venture of their choice. */
  tied: PlayerId[];
}

export function landing(s: GameState): Landing {
  const n = s.players.length;
  const strength = fleetStrength(s);
  const contributions = s.players.map((p) => musteredStrength(s, p.id));
  const defence = contributions.reduce((a, b) => a + b, 0);
  const won = defence >= strength;
  // Turn order from the player whose turn it is.
  const order = Array.from({ length: n }, (_, i) => (s.currentPlayer + i) % n);
  const out: Landing = { strength, defence, contributions, won, losers: [], token: null, tied: [] };
  if (!won) {
    // The least defenders each lose a city; if none of them has one to lose, the next least do.
    const levels = [...new Set(contributions)].sort((a, b) => a - b);
    for (const level of levels) {
      out.losers = order.filter((p) => contributions[p] === level && pillageable(s, p).length > 0);
      if (out.losers.length) break;
    }
  } else {
    const best = Math.max(...contributions);
    const top = order.filter((p) => contributions[p] === best);
    if (best > 0 && top.length === 1) out.token = top[0];
    else if (best > 0) out.tied = top;
  }
  return out;
}

/** The fleet lands. */
export function attack(ctx: Ctx) {
  const s = ctx.s;
  const f = fleetOf(s);
  const l = landing(s);
  ctx.emit({ type: 'fleet/attack', strength: l.strength, defence: l.defence, contributions: l.contributions, won: l.won });
  if (!l.won) {
    // In turn order from the roller: a city goes at once unless its owner has a choice to make.
    const choosing: PlayerId[] = [];
    for (const p of l.losers) {
      const cities = pillageable(s, p);
      if (cities.length === 1 && !canRansom(s, p)) pillage(ctx, cities[0]);
      else choosing.push(p);
    }
    for (let i = choosing.length - 1; i >= 0; i--) {
      const d: PillagePending = { kind: 'fleet/pillage', cities: pillageable(s, choosing[i]) };
      s.pending.push({ kind: d.kind, players: [choosing[i]], data: d });
    }
  } else if (l.token !== null) {
    f.tokens[l.token]++;
    ctx.emit({ type: 'fleet/token', player: l.token });
  } else if (l.tied.length) {
    ctx.emit({ type: 'fleet/tied', players: l.tied });
    oweVentureChoice(s, l.tied);
  }

  for (const w of s.wardens) w.mustered = false;
  f.position = 0;
  f.attacks++;
  if (f.attacks === 1) {
    // (Rule 4: a blocker another module still holds stays off, and enters on a 7.)
    const held = (b: 'robber' | 'corsair') => modulesOf(s).some((m) => m.hooks?.blockerHeld?.(s, b));
    if (!held('robber')) s.robberHex = refugeHex(s);
    if (f.corsairStart !== null && !held('corsair')) setCorsair(s, f.corsairStart);
    ctx.emit({ type: 'fleet/blockersIn', robber: s.robberHex, corsair: corsairHex(s) });
  }
}

function handle(ctx: Ctx, player: PlayerId, a: FleetAction) {
  const s = ctx.s;
  const top = s.pending[s.pending.length - 1];
  assert(top && top.kind === 'fleet/pillage' && top.players.includes(player), 'The raiders want nothing of you.');
  const d = top.data as PillagePending;
  switch (a.type) {
    case 'fleet/yield':
      assert(d.cities.includes(a.vertex), 'The raiders can only take one of these towns.');
      s.pending.pop();
      pillage(ctx, a.vertex);
      return;
    case 'fleet/ransom':
      assert(canRansom(s, player), `Keeping your town costs ${RANSOM} coins.`);
      s.pending.pop();
      addCoins(ctx, player, -RANSOM, 'ransom');
      ctx.emit({ type: 'fleet/ransomed', player });
      return;
    default: {
      const never: never = a;
      fail(`Unknown action ${(never as Action).type}`);
    }
  }
}

function legal(s: GameState, player: PlayerId): Action[] {
  const top = s.pending[s.pending.length - 1];
  if (!top || top.kind !== 'fleet/pillage' || !top.players.includes(player)) return [];
  const out: Action[] = (top.data as PillagePending).cities.map((vertex) => ({ type: 'fleet/yield', vertex }));
  if (canRansom(s, player)) out.push({ type: 'fleet/ransom' });
  return out;
}

export const fleet: RuleModule = {
  id: 'fleet',
  rulesVersion: 1,
  requires: ['guilds', 'garrisons'],
  excludes: ['invasion'],

  init(s) {
    // The robber waits off the board for the first attack, and so does the corsair (Sea Lanes set it up first).
    s.robberHex = null;
    const corsairStart = corsairHex(s);
    setCorsair(s, null);
    s.ext.fleet = { position: 0, attacks: 0, tokens: s.players.map(() => 0), corsairStart };
  },

  handle: (ctx, player, action) => handle(ctx, player, action as FleetAction),
  legal,

  hooks: {
    afterRoll(ctx) {
      if (eventFace(ctx.s) !== 'ship') return;
      const f = fleetOf(ctx.s);
      f.position++;
      ctx.emit({ type: 'fleet/advanced', position: f.position, steps: FLEET_STEPS });
      if (f.position >= FLEET_STEPS) attack(ctx);
    },

    // Before the first attack a 7 moves no blocker and robs nobody (the discards still happen).
    // The engine holds every module's robber step back on this (rule 4), so Sea Lanes, whose hooks
    // run first, can't offer the robber or the corsair early.
    blockersWaiting: (s) => fleetOf(s).attacks === 0,

    victoryPoints: (s, player) => fleetOf(s).tokens[player],
  },

  bot: fleetBot,

  invariants(s) {
    const f = s.ext.fleet;
    if (!f) return ['no fleet state'];
    const out: string[] = [];
    if (!(f.position >= 0 && f.position < FLEET_STEPS)) out.push(`fleet at ${f.position}`);
    if (f.attacks === 0 && s.robberHex !== null) out.push('the robber is on the board before the first attack');
    if (f.tokens.some((t) => t < 0)) out.push('negative defence tokens');
    return out;
  },
};
