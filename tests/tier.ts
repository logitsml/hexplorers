// Which tier a test runs in, and how long it may take.
//
//   npm run test:quick   QUICK=1: no bot games, no 3D (`three/webgpu`) imports
//   npm test             every check, with the bot games at the counts that keep their spread
//   npm run test:full    FULL=1: the bot games at their full counts, and the seat-balance games
//
// Vitest can't stop a test that never yields (the engine and the bots are synchronous), so a
// timeout only turns a slow run into a failure: on a loaded machine set TEST_TIMEOUT_SCALE (say 4)
// rather than raising each one. Give every explicit timeout through `timeout()`; vite.config.ts
// scales the default ones the same way.

import { it } from 'vitest';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export const QUICK = !!env.QUICK;
export const FULL = !!env.FULL && !QUICK;

const scale = Number(env.TEST_TIMEOUT_SCALE);
export const TIMEOUT_SCALE = scale > 0 ? scale : 1;

/** A timeout in milliseconds, stretched by TEST_TIMEOUT_SCALE. */
export function timeout(ms: number): number {
  return ms * TIMEOUT_SCALE;
}

/** How many games to play: `full` under FULL=1, else `usual`. */
export function games(full: number, usual: number): number {
  return FULL ? full : usual;
}

/** A test that plays bot or fuzzed games, left out of the quick tier. */
export const slow = it.skipIf(QUICK);

/** A test that only the full tier runs. */
export const full = it.runIf(FULL);
