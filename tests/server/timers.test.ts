// The table's clocks: a person who doesn't move in time has a bot make that move for them; after
// AFK_EXPIRIES in a row the seat goes to a bot ("away") until they say `back`; and a person gone
// AFK_GONE_MS on their own turn goes away too. Clocks only start once a batch has been presented.

import { describe, expect, it } from 'vitest';
import { viewHash } from '../../src/engine/wire';
import { AFK_EXPIRIES, AFK_GONE_MS, TIMERS } from '../../src/net/protocol';
import { play, serverState, serverView, startTable } from './harness';

describe('timers and being away', () => {
  it('times a quiet person out, hands the seat to a bot, and gives it back', { timeout: 600_000 }, async () => {
    const t = await startTable({ seed: 41, humans: 2, settings: { timer: 'brisk' } });
    const [c0, c1] = t.clients;
    await play(t, { until: () => serverState(t).turn >= 2 && serverState(t).currentPlayer === 0 });
    // The clock the seat sees runs out later than now, by the turn's length at least.
    c0.read();
    const timers = c0.timers as { seat?: number; endsAt?: number; now: number } | null;
    expect(timers?.seat).toBe(0);
    expect(timers!.endsAt! - t.world.now).toBeGreaterThan(TIMERS.brisk!.turn * 1000 - 5000);

    // Seat 0 goes quiet.
    c0.playing = false;
    const quiet = serverState(t).seq;
    await play(t, { until: () => c0.notices.filter((n) => n.kind === 'timeout' && n.seat === 0).length >= 1 });
    expect(serverState(t).seq).toBeGreaterThan(quiet);
    await play(t, { until: () => c0.notices.some((n) => n.kind === 'away' && n.seat === 0) });
    expect(c0.notices.filter((n) => n.kind === 'timeout' && n.seat === 0).length).toBe(AFK_EXPIRIES);
    expect(c0.room!.seats[0].away).toBe(true);
    // A bot plays the seat meanwhile: its turns come and go without it.
    const turn = serverState(t).turn;
    await play(t, { until: () => serverState(t).turn >= turn + 5 });

    // Back at the helm.
    await t.world.send(t.code, c0.sock, { t: 'back' });
    c0.read();
    expect(c0.notices.some((n) => n.kind === 'back' && n.seat === 0)).toBe(true);
    expect(c0.room!.seats[0].away).toBeFalsy();
    c0.playing = true;
    const back = serverState(t).seq;
    await play(t, { until: () => serverState(t).seq > back + 20 });
    expect(c0.errors).toEqual([]);
    expect(viewHash(c0.view!)).toBe(viewHash(serverView(t, 0)));

    // Gone on one's own turn: away after AFK_GONE_MS.
    await play(t, { until: () => serverState(t).currentPlayer === 1 && serverState(t).phase === 'main' });
    c1.sock.close(1001, 'gone');
    await t.world.settle(t.code);
    await t.world.advance(t.code, AFK_GONE_MS + 5000);
    c0.read();
    expect(c0.notices.some((n) => n.kind === 'away' && n.seat === 1)).toBe(true);
    expect(serverState(t).currentPlayer === 1 && serverState(t).phase === 'main').toBe(false);
  });
});
