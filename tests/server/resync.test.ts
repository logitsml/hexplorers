// A person whose connection drops catches up when it comes back: the records missed as one batch
// when they're few and still kept, a snapshot when too far behind or when its view doesn't hash
// as the server's. Either way the view ends exactly as the server's, and play goes on.

import { describe, expect, it } from 'vitest';
import { viewHash } from '../../src/engine/wire';
import { RESYNC_BATCH_MAX } from '../../src/net/protocol';
import { play, serverState, serverView, startTable, type TestTable } from './harness';

async function drop(t: TestTable, i: number) {
  t.clients[i].sock.close(1001, 'gone');
  await t.world.settle(t.code);
}

async function rejoin(t: TestTable, i: number, resume: boolean, hash?: string) {
  const c = t.clients[i];
  const sock = await t.world.connect(t.code, { token: t.tokens[i], ...(resume ? { last: c.seq, hash: hash ?? viewHash(c.view!) } : {}) });
  c.sock = sock;
  c.read();
  return c;
}

describe('reconnecting mid-game', () => {
  it('catches up by a batch when a few records behind, by a snapshot when far behind or out of step', { timeout: 600_000 }, async () => {
    const t = await startTable({ seed: 21, humans: 2 });
    await play(t, { until: () => serverState(t).seq >= 40 && serverState(t).phase === 'main' && serverState(t).currentPlayer !== 0 });
    const c0 = t.clients[0];
    const others = { ...t, clients: [t.clients[1]] };

    // A few records behind: one batch.
    await drop(t, 0);
    const from = serverState(t).seq;
    await play(others, { until: () => serverState(t).seq >= from + 4 });
    expect(serverState(t).seq - c0.seq).toBeLessThanOrEqual(RESYNC_BATCH_MAX);
    const batches = c0.batches;
    const snaps = c0.snaps;
    await rejoin(t, 0, true);
    expect(c0.batches).toBe(batches + 1);
    expect(c0.snaps).toBe(snaps);
    expect(c0.seq).toBe(serverState(t).seq);
    expect(viewHash(c0.view!)).toBe(viewHash(serverView(t, 0)));

    // Out of step (its view hashes differently): a snapshot.
    await drop(t, 0);
    await rejoin(t, 0, true, '0000000000dead');
    expect(c0.snaps).toBe(snaps + 1);
    expect(viewHash(c0.view!)).toBe(viewHash(serverView(t, 0)));

    // Far behind (more than a batch's worth; the seat went to a bot meanwhile): a snapshot.
    await drop(t, 0);
    const far = serverState(t).seq + RESYNC_BATCH_MAX + 10;
    await play(others, { until: () => serverState(t).seq >= far || serverState(t).phase === 'gameOver' });
    await rejoin(t, 0, true);
    expect(c0.snaps).toBe(snaps + 2);
    expect(c0.errors).toEqual([]);
    expect(viewHash(c0.view!)).toBe(viewHash(serverView(t, 0)));
    expect(c0.you!.ackN).toBe(c0.n);

    // And plays on to the end in step.
    await play(t);
    for (const c of t.clients) {
      c.read();
      expect(c.errors).toEqual([]);
      expect(viewHash(c.view!)).toBe(viewHash(serverView(t, c.seat!)));
    }
  });
});
