// What each seat is told of each event and action (R4, R5): the six secret fields reach only those
// entitled to them, every kind of event has a rule, and other seats' actions go out as their kind.

import { describe, expect, it } from 'vitest';
import { type GameEvent } from '../../src/engine';
import { VISIBILITY, actionFor, eventsFor, type Viewer } from '../../src/engine/visibility';
import { ALL_HANDS_OPTIONS, keyed, playGame } from './play';

const VIEWERS: Viewer[] = [0, 1, 2, 3, null];

/** Which field of which event is secret, and who may read it. */
const SECRETS: Record<string, { field: string; who: (e: Record<string, unknown>) => unknown[] }> = {
  stolen: { field: 'resource', who: (e) => (e.named ? VIEWERS : [e.thief, e.victim]) },
  devCardBought: { field: 'card', who: (e) => [e.player] },
  'guilds/drew': { field: 'card', who: (e) => [e.player] },
  'guilds/ventureTaken': { field: 'card', who: (e) => [e.thief, e.victim] },
  'fisheries/drew': { field: 'value', who: (e) => [e.player] },
  'fisheries/card': { field: 'card', who: (e) => [e.player] },
};

describe('visibility', () => {
  it('tells each secret only to those it belongs to, and the rest of every event to all', () => {
    const events: GameEvent[] = [
      { type: 'stolen', thief: 0, victim: 1, resource: 'ore' },
      { type: 'stolen', thief: 2, victim: 3, resource: 'oil', named: true },
      { type: 'devCardBought', player: 2, card: 'monopoly' },
      { type: 'guilds/drew', player: 1, track: 'commerce', card: 'cornerMarket' },
      { type: 'guilds/ventureTaken', thief: 3, victim: 0, card: 'augury' },
      { type: 'fisheries/drew', player: 0, value: 3 },
      { type: 'fisheries/card', player: 3, card: 'knight' },
      { type: 'discarded', player: 1, resources: { brick: 1, wood: 0, wool: 2, wheat: 0, ore: 1, paper: 0, cloth: 0, silver: 0, oil: 0 } },
    ];
    const copy = structuredClone(events);
    for (const v of VIEWERS) {
      const seen = eventsFor(events, v);
      seen.forEach((w, i) => {
        const e = events[i] as unknown as Record<string, unknown>;
        const rule = SECRETS[e.type as string];
        const got = w as unknown as Record<string, unknown>;
        if (!rule) return expect(got).toBe(e);
        const entitled = rule.who(e).includes(v);
        expect(rule.field in got, `${e.type} for ${v}`).toBe(entitled);
        // (Everything else as it was.)
        expect({ ...got, [rule.field]: e[rule.field] }).toEqual(e);
      });
    }
    // Discards go face up to everyone (R8: the tracker holds them public).
    expect(eventsFor([events[7]], null)).toEqual([events[7]]);
    expect(VISIBILITY.discarded).toBe('public');
    expect(events).toEqual(copy);
    // (A kind with no rule, which only a cast could make, goes out as its kind alone.)
    expect(eventsFor([{ type: 'made/up', secret: 1 } as unknown as GameEvent], 0)).toEqual([{ type: 'made/up' }]);
  });

  it('has a rule for every event bot games make, and lets no secret through in them', () => {
    let secrets = 0;
    const kinds = new Set<string>();
    for (const g of [
      playGame('base', 21, keyed(21).options, keyed(21).secret),
      playGame('all hands', 22, keyed(22, ALL_HANDS_OPTIONS).options, keyed(22).secret),
    ]) {
      for (const e of [...g.initialEvents, ...g.steps.flatMap((s) => s.events)]) {
        kinds.add(e.type);
        expect(VISIBILITY, e.type).toHaveProperty([e.type]);
        const rule = SECRETS[e.type];
        if (!rule) continue;
        secrets++;
        const r = e as unknown as Record<string, unknown>;
        for (const v of VIEWERS) expect(rule.field in (eventsFor([e], v)[0] as object), `${e.type} for ${v}`).toBe(rule.who(r).includes(v));
      }
    }
    expect(secrets).toBeGreaterThan(100);
    expect(kinds.size).toBeGreaterThan(60);
  }, 1_800_000);

  it('sends an action whole to its actor and as its kind to everyone else', () => {
    const discard = { type: 'guilds/discardVenture', card: 'augury' } as const;
    expect(actionFor(discard, 1, 1)).toBe(discard);
    for (const v of [0, 2, 3, null]) expect(actionFor(discard, 1, v)).toEqual({ type: 'guilds/discardVenture' });
    expect(actionFor({ type: 'rollDice' }, 0, null)).toEqual({ type: 'rollDice' });
  });
});
