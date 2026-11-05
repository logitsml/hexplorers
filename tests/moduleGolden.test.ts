// Golden replays of module mixes and online games (see tests/golden-modules.ts): every recorded log
// still plays, state for state, as it did when it was recorded.
//
//   RECORD_GOLDENS=1 npx vitest run tests/moduleGolden.test.ts -u    (re-record, only when play is meant to change)

import { describe, expect, it } from 'vitest';
import { SPECS, fixtureText, record, replay, type Fixture } from './golden-modules';

const FILES = import.meta.glob('./fixtures/golden-modules/*.json', { eager: true, import: 'default' }) as Record<string, Fixture>;
// Four of the logs as they were recorded before the second rules of Guilds, Fisheries and Rivers
// (token mix and prices, venture deck, Pauper tile), each stamped with the version it was made under.
const FIRST = import.meta.glob('./fixtures/golden-modules-first/*.json', { eager: true, import: 'default' }) as Record<string, Fixture>;
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

describe('golden replays of module mixes and online games', () => {
  if (env.RECORD_GOLDENS) {
    it('records them', async () => {
      for (const spec of SPECS) await expect(fixtureText(record(spec))).toMatchFileSnapshot(`./fixtures/golden-modules/${spec.id}.json`);
    }, 1_800_000);
  }

  it('every recorded game plays out exactly as recorded', () => {
    const all = Object.values(FILES);
    expect(all.map((f) => f.id).sort()).toEqual(SPECS.map((s) => s.id).sort());
    expect(all.map(replay).filter((x) => x !== null)).toEqual([]);
    // (They cover finished games, and games cut short in the middle of the big mixes.)
    expect(all.filter((f) => f.winner !== null).length).toBeGreaterThan(2);
  }, 1_800_000);

  it('games recorded under the first rules of Guilds, Fisheries and Rivers still play out exactly', () => {
    const all = Object.values(FIRST);
    expect(all.map((f) => f.id).sort()).toEqual(['all-hands', 'fishing-fog-bank', 'guilds', 'rivermouth']);
    expect(all.map(replay).filter((x) => x !== null)).toEqual([]);
  }, 1_800_000);
});
