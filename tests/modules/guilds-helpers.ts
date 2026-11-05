// Small builders for the guilds, garrisons and fleet tests: a game past set-up, and patches that
// keep every card and venture conserved.

import { applyAction, createGame, longestRoadFor, mustApply, type Action, type GameEvent, type GameState, type ModuleId, type Track } from '../../src/engine';
import type { VentureId } from '../../src/engine/modules/guilds/types';
import { VENTURES } from '../../src/engine/modules/guilds/ventures';
import { FOUR } from '../helpers';
import { checkInvariants, type GameResult } from '../sim-harness';

/** A beginner game with these modules, past set-up (each seat has a settlement and a city), seat 0 to roll. */
export function game(modules: ModuleId[], opts: Record<string, unknown> = {}): GameState {
  const s = createGame(FOUR, { layout: 'beginner', seed: 7, modules, victoryPoints: 13, ...opts }).state;
  s.currentPlayer = 0;
  s.firstPlayer = 0;
  return s;
}

/** Apply or throw; the state's invariants (and the modules') must hold afterwards. */
export function act(s: GameState, player: number, a: Action): { state: GameState; events: GameEvent[] } {
  const r = mustApply(s, player, a);
  checkInvariants(r.state, a.type, supplyOf(s));
  return { state: r.state, events: r.events };
}

/** The supply totals of a state (bank and hands), to hold the next state to. */
export function supplyOf(s: GameState) {
  const out: Record<string, number> = {};
  for (const k of Object.keys(s.bank)) out[k] = s.bank[k as keyof typeof s.bank] + s.players.reduce((n, p) => n + p.hand[k as keyof typeof p.hand], 0);
  return out;
}

/** The refusal message for an action that must fail. */
export function refused(s: GameState, player: number, a: Action): string {
  const r = applyAction(s, player, a);
  if (r.ok) throw new Error(`${a.type} should have been refused`);
  return r.error;
}

/** `player`'s cities and settlements. */
export const citiesOf = (s: GameState, p: number) => s.buildings.flatMap((b, v) => (b?.owner === p && b.kind === 'city' ? [v] : []));
export const settlementsOf = (s: GameState, p: number) => s.buildings.flatMap((b, v) => (b?.owner === p && b.kind === 'settlement' ? [v] : []));

/** Move a venture from its deck into `player`'s hand (patching). */
export function giveVenture(s: GameState, player: number, card: VentureId) {
  const g = s.ext.guilds!;
  const deck = g.decks[VENTURES[card].track];
  const i = deck.lastIndexOf(card);
  if (i < 0) throw new Error(`no ${card} left in its deck`);
  deck.splice(i, 1);
  g.hands[player].push(card);
}

/** Put `card` on top of its deck (patching). */
export function stackDeck(s: GameState, card: VentureId) {
  const deck = s.ext.guilds!.decks[VENTURES[card].track];
  const i = deck.lastIndexOf(card);
  if (i < 0) throw new Error(`no ${card} left in its deck`);
  deck.splice(i, 1);
  deck.push(card);
}

export function setLevel(s: GameState, player: number, track: Track, level: number) {
  s.ext.guilds!.levels[player][track] = level;
}

/** Lay a road (patching), counting the piece; call `settle` once the patch is done. */
export function addRoad(s: GameState, owner: number, edge: number, kind: 'road' | 'ship' | 'bridge' = 'road') {
  s.routes[edge] = { owner, kind, builtTurn: 0 };
  if (kind !== 'ship') s.players[owner].roadsLeft--;
}

/** Bring the cached route lengths up to date after a patch (wardens and roads change them). */
export function settle(s: GameState) {
  for (const p of s.players) p.longestRoad = longestRoadFor(s, p.id);
}

/** Put `player` into their main phase with nothing owed. */
export function main(s: GameState, player: number) {
  s.currentPlayer = player;
  s.phase = 'main';
  s.hasRolled = true;
  s.pending = [];
}

/**
 * Roll for `player` (in their roll phase) with a dice stream chosen so the roll comes out as wanted:
 * a production total, an event face, a red die. Returns the result of the roll.
 */
export function rollAs(s: GameState, player: number, want: { total?: number; face?: string; red?: number }): { state: GameState; events: GameEvent[] } {
  for (let seed = 1; seed < 200000; seed++) {
    const t = { ...s, rngState: seed };
    const r = applyAction(t, player, { type: 'rollDice' });
    if (!r.ok) throw new Error(r.error);
    const d = r.state.ext.guilds?.eventDie;
    const total = r.state.dice![0] + r.state.dice![1];
    if (want.total !== undefined && total !== want.total) continue;
    if (want.face !== undefined && d?.face !== want.face) continue;
    if (want.red !== undefined && d?.red !== want.red) continue;
    return { state: r.state, events: r.events };
  }
  throw new Error(`no roll like ${JSON.stringify(want)}`);
}

/** Events of one type. */
export const eventsOf = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

/** One line per seat count: games, average turns, wins by seat, fall-backs. */
export function summarize(label: string, results: GameResult[]) {
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  for (const n of [4, 3]) {
    const rs = results.filter((r) => r.players === n);
    if (rs.length === 0) continue;
    const wins = Array(n).fill(0);
    for (const r of rs) wins[r.winner!]++;
    console.log(`${label} ${n}p: ${rs.length} games, avg ${avg(rs.map((r) => r.turns)).toFixed(1)} turns (min ${Math.min(...rs.map((r) => r.turns))}, max ${Math.max(...rs.map((r) => r.turns))}), seat wins ${wins.join('/')}, fallbacks ${rs.reduce((a, r) => a + r.fallbacks, 0)}`);
  }
}
