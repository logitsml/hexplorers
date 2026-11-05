// Whole games: two people (clients deciding on their own views) and two server bots, to the end.
// Every client's view must hash as the server's view of that seat; the reveal must replay to the
// very dice everyone saw; and what the game cost in storage rows, wakes and bytes is reported.

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, type GameEvent } from '../../src/engine';
import { canonical, viewHash } from '../../src/engine/wire';
import { checkReveal } from '../../src/net/codes';
import { deflatedSize, play, serverState, serverView, startTable } from './harness';

describe('a whole game online', () => {
  it('two people and two bots play to the end, every view in step with the server', { timeout: 600_000 }, async () => {
    const t = await startTable({ seed: 11, humans: 2 });
    const steps = await play(t);
    for (const c of t.clients) c.read();
    const s = serverState(t);
    expect(s.phase).toBe('gameOver');
    for (const c of t.clients) {
      expect(c.errors).toEqual([]);
      expect(c.seq).toBe(s.seq);
      // Each client's own view is exactly the server's view of its seat.
      expect(viewHash(c.view!)).toBe(viewHash(serverView(t, c.seat!)));
      expect(canonical(c.view)).toBe(canonical(serverView(t, c.seat!)));
      expect(c.hashChecks).toBeGreaterThan(5);
      // No other seat's action ever reached it whole (actionFor).
      for (const r of c.records) if (r.actor !== c.seat) expect(Object.keys(r.a)).toEqual(['type']);
      expect(c.nacks.filter((n) => n.code === 'rule')).toEqual([]);
    }
    // The room's key never went out before the reveal.
    const key = t.clients[0].reveal!.key;
    for (const c of t.clients) {
      const before = c.sock.raw.slice(0, c.sock.raw.findIndex((m) => m.startsWith('{"t":"reveal"')));
      expect(before.some((m) => m.includes(key))).toBe(false);
    }

    // ---------------------------------------------------------- (f) fair dice: the reveal replays the dice everyone saw
    const reveal = t.clients[0].reveal!;
    const commit = t.clients[0].room!.commit!;
    expect(commit).toMatch(/^[0-9a-f]{64}$/);
    expect(reveal.nonces.slice(0, 2).every((n) => typeof n === 'string')).toBe(true);
    const rngKey = await checkReveal(commit, reveal.key, reveal.nonces);
    expect(rngKey).not.toBeNull();
    // (A wrong key, or a changed nonce, doesn't check out.)
    expect(await checkReveal(commit, reveal.key.replace(/^./, (c) => (c === '0' ? '1' : '0')), reveal.nonces)).toBeNull();
    const view = t.clients[0].view!;
    const seats = view.players.map((p) => ({ name: p.name, color: p.color, isBot: p.isBot }));
    let state = createGame(seats, reveal.options, { rngKey: rngKey! }).state;
    const dice: [number, number][] = [];
    for (const { actor, action } of reveal.log) {
      const r = applyAction(state, actor, action);
      expect(r.ok).toBe(true);
      if (!r.ok) break;
      state = r.state;
      for (const e of r.events) if (e.type === 'diceRolled') dice.push(e.dice);
    }
    expect(state.phase).toBe('gameOver');
    expect(state.winner).toBe(s.winner);
    const seen = t.clients[0].records.flatMap((r) => (r.e as GameEvent[]).filter((e) => e.type === 'diceRolled').map((e) => (e as Extract<GameEvent, { type: 'diceRolled' }>).dice));
    expect(dice).toEqual(seen);
    expect(dice.length).toBeGreaterThan(10);

    // ---------------------------------------------------------- results and the replay
    const room = t.clients[0].room!;
    expect(room.phase).toBe('over');
    expect(room.results!.winner).toBe(s.winner);
    expect(room.results!.standings[0].seat).toBe(s.winner);
    expect(room.results!.replay).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const replay = JSON.parse((await t.world.services.replay(room.results!.replay!))!);
    expect(replay.log.length).toBe(reveal.log.length);

    // ---------------------------------------------------------- (h) what it cost
    const e = t.world.rooms.get(t.code)!;
    const counters = e.room.counters;
    const perSeat = await Promise.all(t.clients.map(async (c) => ({ seat: c.seat, frames: c.sock.raw.length, raw: c.sock.bytes, deflated: await deflatedSize(c.sock.raw) })));
    const report = {
      actions: s.seq,
      turns: s.turn,
      humanSteps: steps,
      rowsWritten: e.rt.sql.rowsWritten,
      rowsByTable: Object.fromEntries(e.rt.sql.writesBy),
      alarmsSet: e.rt.alarmsSet,
      rowsBilled: e.rt.sql.rowsWritten + e.rt.alarmsSet,
      alarmsRung: counters.alarms,
      wakes: counters.wakes,
      messagesIn: counters.messages,
      perSeat,
    };
    console.log(`online game cost: ${JSON.stringify(report)}`);
    // Rows: about a turn's row each, plus the people's actions and the clocks (far below one per action and seat).
    expect(report.rowsBilled).toBeLessThan(s.seq * 1.2);
  });
});
