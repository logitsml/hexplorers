// The one way into the expansions' render chunk (render/expansions.ts): fetched once, the first
// time a game with modules sets its board or the set-up page picks a module, and shared after.

export type Expansions = typeof import('./expansions');

/**
 * The chunk couldn't be fetched (offline, or a release replaced it mid-visit). It says nothing
 * about the game being started, so a saved game survives it (see the title's launch).
 */
export class ExpansionsUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super('the expansions could not be loaded');
  }
}

let pending: Promise<Expansions> | null = null;

export function loadExpansions(): Promise<Expansions> {
  pending ??= import('./expansions').catch((e: unknown) => {
    // (Forgotten, so the next game asks again rather than inheriting the failure.)
    pending = null;
    throw new ExpansionsUnavailable(e);
  });
  return pending;
}
