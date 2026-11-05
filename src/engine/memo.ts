// Answers to read-only queries about one state, kept while a bot decides. A bot asks the same
// things many times over (its options ask for legal roads, its models of the other seats for
// their production and reach, and the legality check for every legal action), and a state handed
// to a bot never changes, so each answer is worked out once and then reused.
//
// Only the state the memo was opened for is remembered: anything else (a hypothetical copy, or a
// state the reducer is building inside a bot's look-ahead) is worked out afresh every time, so a
// state that changes is never answered from the memo.

import type { GameState } from './types';

let open: { state: GameState; answers: Map<number, unknown> } | null = null;

/** Run `fn` with queries about `state` remembered. `state` must not change until it returns. */
export function withMemo<T>(state: GameState, fn: () => T): T {
  const outer = open;
  open = { state, answers: new Map() };
  try {
    return fn();
  } finally {
    open = outer;
  }
}

/** The queries remembered, each with room for a player (or other small number) beside it. */
export const Query = {
  LegalActions: 0,
  LegalRoads: 1,
  LegalSettlements: 2,
  Reach: 3,
  TradeRatios: 4,
  PublicPoints: 5,
  ResourceValues: 6,
  ProductionPips: 7,
  Cracked: 8,
  ShipReach: 9,
} as const;

/**
 * `compute()`, remembered under the query and `n` while a memo is open for `state`. What it
 * returns is shared between callers, so they must not change it (a list the caller might sort is
 * copied by the query itself).
 */
export function memo<T>(state: GameState, query: number, n: number, compute: () => T): T {
  if (open === null || open.state !== state) return compute();
  const key = query * 64 + n;
  let answer = open.answers.get(key) as T | undefined;
  if (answer === undefined) {
    answer = compute();
    open.answers.set(key, answer);
  }
  return answer;
}
