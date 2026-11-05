// What the expansions' own panels (ui/modules/) offer, read from the game and nothing else: the
// action types and decisions each panel answers, so the generic panel (ui/ModuleControls.tsx)
// leaves those out, and the legal moves both work from. Like moduleActions.ts, every move offered
// here is one legalActions listed; nothing is built that the engine might refuse.

import type { Action, GameState, ModuleId, Pending, PlayerId } from '../engine';
import { moduleActions } from './moduleActions';

/**
 * The action types each module's own panel offers. The rest of a module's moves (a foundry, a
 * learning pick, a barter) stay with the generic panel, so no move is ever out of reach.
 */
const COVERED: Partial<Record<ModuleId, readonly string[]>> = {
  guilds: ['guilds/improve', 'guilds/play', 'guilds/discardVenture', 'guilds/draw', 'guilds/takeVenture', 'guilds/give', 'guilds/discardCard', 'guilds/take', 'guilds/pick'],
  // (The expansions' builds, a ship, a bridge, a warden, a wall and a foundry, are the build bar's: game/builds.ts.)
  sea: ['sea/pickBounty', 'sea/buildShip'],
  // (The coin market, buying a resource for coins or selling cards for them, is the trade dialog's
  // Supply tab: ui/SupplyTrade.tsx.)
  rivers: ['rivers/buildBridge', 'buyWithCoins', 'sellForCoins'],
  garrisons: ['garrisons/recruit', 'garrisons/wall'],
  caravans: ['caravans/bid', 'caravans/pass', 'caravans/vote', 'caravans/place'],
  almanac: ['almanac/crack', 'almanac/take', 'almanac/give', 'almanac/rob', 'almanac/repair'],
  // (Hoarder and Invention naming oil are the base game's dialogs, which offer oil beside the resources.)
  oil: ['oil/burn', 'oil/sequester', 'oil/foundry', 'oil/monopoly', 'oil/invention'],
  fisheries: ['fisheries/blocker', 'fisheries/steal', 'fisheries/take', 'fisheries/route', 'fisheries/card', 'fisheries/swap', 'fisheries/passBoot'],
  // (The muster card's buy is the build bar's card button, where the development card's would be.)
  invasion: ['buyWithCoins', 'sellForCoins', 'invasion/buy', 'invasion/levy', 'invasion/outrider', 'invasion/ambush', 'invasion/turncoat'],
};

/** The decisions each module's own panel answers (by their kind on the pending stack). */
const ANSWERED: Partial<Record<ModuleId, readonly string[]>> = {
  guilds: ['guilds/ventureLimit', 'guilds/drawChoice', 'guilds/spy', 'guilds/give', 'guilds/discard', 'guilds/tribute', 'guilds/pick'],
  sea: ['sea/bountyPick'],
  caravans: ['caravans/bid', 'caravans/vote', 'caravans/place'],
  almanac: ['almanac/quake', 'almanac/take', 'almanac/gift', 'almanac/rob'],
  fisheries: ['fisheries/swap'],
  invasion: ['invasion/card'],
};

const coveredCache = new WeakMap<readonly ModuleId[], Set<string>>();

/** Every action type a dedicated panel offers in this game. */
export function coveredTypes(s: GameState): Set<string> {
  let out = coveredCache.get(s.options.modules);
  if (!out) {
    out = new Set(s.options.modules.flatMap((m) => COVERED[m] ?? []));
    coveredCache.set(s.options.modules, out);
  }
  return out;
}

/** Whether a dedicated panel answers this decision in this game. */
export const answersDecision = (s: GameState, p: Pending): boolean => s.options.modules.some((m) => ANSWERED[m]?.includes(p.kind));

const legalCache = new WeakMap<GameState, { me: PlayerId; actions: Action[] }>();

/**
 * The expansions' legal moves for `me` in `s`, worked out once per state however many panels ask
 * (each new state is a new object, so the cache never serves a stale list).
 */
export function legalModuleActions(s: GameState, me: PlayerId): Action[] {
  const hit = legalCache.get(s);
  if (hit && hit.me === me) return hit.actions;
  const actions = moduleActions(s, me);
  legalCache.set(s, { me, actions });
  return actions;
}

/** The legal moves of one type, narrowed by `keep`. */
export function legalOf<T extends Action>(s: GameState, me: PlayerId, type: string, keep: (a: T) => boolean = () => true): T[] {
  return legalModuleActions(s, me).filter((a): a is T => a.type === type && keep(a as T));
}

/** The decision on top of the stack when it's one of `kinds`. */
export function topOf(s: GameState, ...kinds: string[]): Pending | null {
  const top = s.pending[s.pending.length - 1];
  return top && kinds.includes(top.kind) ? top : null;
}

/** The seats in turn order, starting with the one whose turn it is. */
export function fromCurrent(s: GameState): PlayerId[] {
  const n = s.players.length;
  return Array.from({ length: n }, (_, i) => (s.currentPlayer + i) % n);
}

/** The seats with `me` first, then the others in seat order (how the panels list players). */
export function meFirst(s: GameState, me: PlayerId): PlayerId[] {
  return [me, ...s.players.map((p) => p.id).filter((p) => p !== me)];
}

/** A list in words: "a, b and c". */
export function listOf(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}

/** "1 oil", "2 wagons". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
