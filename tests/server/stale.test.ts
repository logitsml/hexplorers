// The stale race: two people answer the same offer; the first is taken, and the second's answer,
// made at a seq the table has since moved past, is refused as stale (not applied to whatever
// came next). Duplicates are re-acknowledged, never applied twice.

import { describe, expect, it } from 'vitest';
import { RESOURCES, cards, type Action, type Resource } from '../../src/engine';
import { play, serverState, startTable, type Client, type TestTable } from './harness';

async function act(t: TestTable, c: Client, a: Action, at = c.seq) {
  const n = ++c.n;
  await t.world.send(t.code, c.sock, { t: 'act', n, at, a });
  for (const x of t.clients) x.read();
  return n;
}

describe('stale answers', () => {
  it('refuses an answer made before the offer it answers was taken', { timeout: 600_000 }, async () => {
    const t = await startTable({ seed: 7, humans: 3 });
    const [c0, c1, c2] = t.clients;
    let pair: { give: Resource; get: Resource } | null = null;
    await play(t, {
      until: () => {
        const s = serverState(t);
        if (s.currentPlayer !== 0 || s.phase !== 'main' || !s.hasRolled || s.trade || s.pending.length) return false;
        const give = RESOURCES.find((r) => s.players[0].hand[r] > 0);
        const get = RESOURCES.find((r) => r !== give && s.players[1].hand[r] > 0 && s.players[2].hand[r] > 0);
        if (give && get) pair = { give, get };
        return !!pair;
      },
    });
    expect(pair).not.toBeNull();
    const { give, get } = pair!;
    await act(t, c0, { type: 'offerTrade', give: cards({ [give]: 1 }), get: cards({ [get]: 1 }), to: [1, 2] });
    const offer = serverState(t).trade!.id;
    // Both look at the offer, at the same seq.
    const at = c1.seq;
    expect(c2.seq).toBe(at);
    await act(t, c1, { type: 'respondTrade', accept: true, offer }, at);
    expect(serverState(t).trade!.responses[1]).toBeTruthy();
    // The proposer takes the first answer: the offer is gone.
    await act(t, c0, { type: 'acceptTrade', partner: 1, offer });
    expect(serverState(t).trade).toBeNull();
    const seq = serverState(t).seq;
    // The second answer, made at the old seq, arrives now.
    const n = await act(t, c2, { type: 'respondTrade', accept: true, offer }, at);
    const nack = c2.nacks.find((x) => x.n === n)!;
    expect(nack.code).toBe('stale');
    expect(nack.ackN).toBe(n);
    expect(serverState(t).seq).toBe(seq);

    // A duplicate (the same n again) is acknowledged, not applied.
    await t.world.send(t.code, c2.sock, { t: 'act', n, at: c2.seq, a: { type: 'respondTrade', accept: true, offer } });
    c2.read();
    const dup = c2.nacks.filter((x) => x.n === n).at(-1)!;
    expect(dup.code).toBe('order');
    expect(dup.ackN).toBe(n);
    // An intent claiming a seq that hasn't happened is out of order.
    const m = ++c2.n;
    await t.world.send(t.code, c2.sock, { t: 'act', n: m, at: seq + 50, a: { type: 'endTurn' } });
    c2.read();
    expect(c2.nacks.find((x) => x.n === m)!.code).toBe('order');
    // The engine's own refusals come back as rule.
    const r = ++c2.n;
    await t.world.send(t.code, c2.sock, { t: 'act', n: r, at: c2.seq, a: { type: 'endTurn' } });
    c2.read();
    expect(c2.nacks.find((x) => x.n === r)!.code).toBe('rule');
    expect(serverState(t).seq).toBe(seq);

    // The table plays on, in step.
    await play(t, { until: () => serverState(t).seq > seq + 30 });
    for (const c of t.clients) {
      c.read();
      expect(c.errors).toEqual([]);
    }
  });
});
