// A room can be evicted at any moment (hibernation, a deploy): dropping the Room object mid-game
// and building it again from its storage (a checkpoint, the turns logged since, the turn under
// way; the bots' memories rebuilt by replaying their decisions) must change nothing: the game
// finishes exactly as one that was never evicted.

import { describe, expect, it } from 'vitest';
import { canonical, viewHash } from '../../src/engine/wire';
import { play, serverState, serverView, startTable } from './harness';

async function game(evictAtTurns: number[]) {
  const t = await startTable({ seed: 31, humans: 2 });
  let next = 0;
  const evictions: number[] = [];
  await play(t, {
    until: async () => {
      if (next < evictAtTurns.length && serverState(t).turn >= evictAtTurns[next]) {
        next++;
        // (A room sleeps only after a quiet spell, in which its alarm has flushed the turn under way.)
        await t.world.advance(t.code, 3000);
        await t.world.evict(t.code);
        evictions.push(serverState(t).seq);
      }
      return false;
    },
  });
  for (const c of t.clients) c.read();
  return { t, evictions, log: t.clients[0].reveal?.log, final: canonical(serverState(t)) };
}

describe('eviction', () => {
  it('a room rebuilt from storage mid-game finishes exactly as one never evicted', { timeout: 900_000 }, async () => {
    const straight = await game([]);
    // Once before the first checkpoint (replayed from the start), once after it (from the checkpoint).
    const evicted = await game([8, 31]);
    expect(evicted.evictions.length).toBe(2);
    expect(serverState(evicted.t).turn).toBeGreaterThan(31);
    expect(evicted.log).toEqual(straight.log);
    expect(evicted.final).toBe(straight.final);
    for (const c of evicted.t.clients) {
      expect(c.errors).toEqual([]);
      expect(viewHash(c.view!)).toBe(viewHash(serverView(evicted.t, c.seat!)));
    }
    // The checkpoint was written (it closes the journal's first chunk) and used.
    const rows = evicted.t.world.rooms.get(evicted.t.code)!.rt.sql.exec<{ body: string }>('SELECT body FROM chunks ORDER BY id').toArray();
    expect(rows.map((r) => (JSON.parse(r.body) as { ck?: { turn: number } }).ck?.turn)).toContain(25);
  });
});
