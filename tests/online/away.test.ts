// "While you were away", as the client reads it: a seat's game at its last move against the game
// some turns on (what a fresh start sees), and the records it missed (what a catch-up brings),
// both from a game played on the server through the harness, on nothing but that seat's view.

import { describe, expect, it, vi } from 'vitest';
import { inflateView } from '../../src/engine/wire';
import type { GameEvent } from '../../src/engine';
import { fromEvents, markOf, sinceMark } from '../../src/online/away';
import { play, serverState, serverView, startTable } from '../server/harness';

vi.setConfig({ testTimeout: 300_000 });

describe('while you were away', () => {
  it('says what changed since a seat’s last move, from the game whole and from the records missed', async () => {
    const t = await startTable({ seed: 19, humans: 1, seats: 4 });
    const [c0] = t.clients;
    await play(t, { until: () => serverState(t).turn >= 2 && serverState(t).currentPlayer === 0 && serverState(t).phase === 'main' });
    c0.read();
    const before = inflateView(serverView(t, 0), 0);
    const mark = markOf(before, 0, 1);
    const from = c0.records.length;
    // Twelve turns on (seat 0's own moves among them, which the summary leaves out).
    await play(t, { until: () => serverState(t).turn >= 14 });
    c0.read();
    const after = inflateView(serverView(t, 0), 0);
    const lines = sinceMark(mark, after, 0);
    expect(lines[0]).toBe(`${after.turn - before.turn} turns since your last move.`);
    // Someone built something in twelve turns of four players, and every line is a sentence.
    expect(lines.some((l) => / built /.test(l))).toBe(true);
    for (const l of lines) expect(l).toMatch(/^[A-Z0-9].*\.$/);
    // Nothing changed, nothing to say.
    expect(sinceMark(markOf(after, 0), after, 0)).toEqual([]);
    // The records seat 0 got meanwhile, as a catch-up would bring them.
    const events = c0.records.slice(from).flatMap((r) => r.e as GameEvent[]);
    const missed = fromEvents(events, 0, (p) => after.players[p].name);
    expect(missed[0]).toMatch(/^Rolls: (\d+, )+\d+\.$/);
    expect(missed.length).toBeLessThanOrEqual(6);
    for (const l of missed) expect(l).not.toMatch(/undefined|NaN/);
  });
});
