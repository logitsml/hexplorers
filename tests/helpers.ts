import type { InvasionState } from '../src/engine/modules/invasion/types';
import type { SeaState } from '../src/engine/modules/sea/types';
import { RAIDERS } from '../src/engine/modules/invasion/raids';
import { type Hex, type Route, createGame, mustApply, type GameState, type PlayerSetup, type Action, type GameEvent, emptyCards, type CardCounts } from '../src/engine';

export const FOUR: PlayerSetup[] = [
  { name: 'Red', color: 'red', isBot: false },
  { name: 'Blue', color: 'blue', isBot: true },
  { name: 'White', color: 'white', isBot: true },
  { name: 'Orange', color: 'orange', isBot: true },
];

export function beginnerGame(seed = 7): GameState {
  return createGame(FOUR, { layout: 'beginner', seed }).state;
}

export function apply(state: GameState, player: number, action: Action): { state: GameState; events: GameEvent[] } {
  const r = mustApply(state, player, action);
  return { state: r.state, events: r.events };
}

export function rc(partial: Partial<CardCounts>): CardCounts {
  return { ...emptyCards(), ...partial };
}

/** Deep-cloned state with a mutation applied, for building test scenarios. */
export function patch(state: GameState, fn: (s: GameState) => void): GameState {
  const s = structuredClone(state);
  fn(s);
  return s;
}

export function playerByColor(state: GameState, color: string): number {
  return state.players.find((p) => p.color === color)!.id;
}

/** Give a player resources taken from the bank (keeps the conservation invariant). */
export function grant(s: GameState, player: number, res: Partial<CardCounts>) {
  for (const [r, n] of Object.entries(res) as [keyof CardCounts, number][]) {
    s.bank[r] -= n;
    s.players[player].hand[r] += n;
  }
}

/** Put a player into their main phase (after rolling) without randomness. */
export function toMain(s: GameState, player: number) {
  s.currentPlayer = player;
  s.phase = 'main';
  s.hasRolled = true;
}

/** A hex's number disc (the first of its numbers), or null: the classic island has one per hex. */
export const num = (h: Hex): number | null => h.numbers[0] ?? null;

/** A road owned by `owner`, for patching states. */
export const road = (owner: number): Route => ({ owner, kind: 'road', builtTurn: 0 });

/**
 * Invasion's state with `raiders` on the board (a count per hex), for scenes of conquest in other
 * modules' tests. A game with Invasion in play keeps the rest of its own state (the raiders moved
 * come from, or go back to, the supply); otherwise nobody holds prisoners or tokens and there is no
 * muster deck.
 */
export function raidersAt(s: GameState, raiders: number[]): InvasionState {
  const on = raiders.reduce((a, b) => a + b, 0);
  const n = s.players.length;
  const st = s.ext.invasion ?? { raiders, supply: RAIDERS, extra: 0, prisoners: Array(n).fill(0), tokens: Array(n).fill(0), deck: [], discard: [] };
  const was = st.raiders.reduce((a, b) => a + b, 0);
  return { ...st, raiders, supply: (s.ext.invasion ? st.supply + was : RAIDERS) - on };
}

/** Sea Lanes' state with the corsair on `corsair` (or off the board), keeping the rest of a game's own, for other modules' tests. */
export function corsairAt(s: GameState, corsair: number | null): SeaState {
  const n = s.players.length;
  return { ...(s.ext.sea ?? { shipsLeft: Array(n).fill(15), movedTurn: Array(n).fill(-1) }), corsair };
}
