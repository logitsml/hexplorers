// What the table itself asks of the room: a clock that starts once the move behind it has been
// seen (or at its cap), each person's Looking for / Spare, conceding, the hail and the reactions'
// pace, and a room that can't be made saying why.

import { describe, expect, it } from 'vitest';
import { HAIL_AFTER_MS, REACT_GAP_MS, SEEN_CAP_MS, TIMERS, type ServerMsg, type Timers } from '../../src/net/protocol';
import { World, play, serverState, startTable, type Client, type TestTable } from './harness';
import { OPENING_ALLOWANCE_MS } from '../../server/room/room';

/** The timers this client was told last, from a record or on their own. */
function lastTimers(c: Client): Timers | null {
  return c.timers as Timers | null;
}

/** The person whose opening it is places until the turn passes to someone else (their first settlement and road). */
async function passOpening(t: TestTable) {
  const first = serverState(t).currentPlayer;
  const c = t.clients[first];
  for (let i = 0; i < 10 && serverState(t).currentPlayer === first; i++) {
    c.read();
    const a = c.decide();
    if (!a) break;
    await t.world.send(t.code, c.sock, a);
  }
  for (const x of t.clients) x.read();
}

describe('the table', () => {
  it('starts a person’s clock once everyone has seen the move, and at its cap otherwise', { timeout: 120_000 }, async () => {
    const t = await startTable({ seed: 7, humans: 3, seats: 3, settings: { timer: 'standard' } });
    const full = TIMERS.standard!.turn * 1000;
    // The first clock waits for the island to rise on every screen: until all have shown the game it began from.
    const first = serverState(t).currentPlayer;
    const rising = lastTimers(t.clients[first]);
    expect(rising?.seat).toBe(first);
    expect(rising!.endsAt! - t.world.now).toBe(full + OPENING_ALLOWANCE_MS);
    for (const c of t.clients) await t.world.send(t.code, c.sock, { t: 'seen', seq: 0 });
    for (const c of t.clients) c.read();
    expect(lastTimers(t.clients[first])!.endsAt! - t.world.now).toBe(full);
    await passOpening(t);
    const next = serverState(t).currentPlayer;
    const sent = t.world.now;
    // Nobody has said they've seen it: the clock is set to start at its cap.
    const capped = lastTimers(t.clients[next]);
    expect(capped?.seat).toBe(next);
    expect(capped!.endsAt! - sent).toBe(full + SEEN_CAP_MS);
    // Two of the three have seen it: still waiting on the last.
    const seq = serverState(t).seq;
    const [a, b, last] = [next, (next + 1) % 3, (next + 2) % 3].map((i) => t.clients[i]);
    await t.world.send(t.code, a.sock, { t: 'seen', seq });
    await t.world.send(t.code, b.sock, { t: 'seen', seq });
    a.read();
    expect(lastTimers(a)!.endsAt).toBe(capped!.endsAt);
    // All three have, a second later: it starts then, three seconds sooner than its cap. (Neither a
    // row nor an alarm for it: the alarm stays at the cap, and the clock rides with the turn.)
    await t.world.advance(t.code, 1000);
    const rt = t.world.rooms.get(t.code)!.rt;
    const [rows, alarms, due] = [rt.written().rows, rt.alarmsSet, rt.alarmAt];
    await t.world.send(t.code, last.sock, { t: 'seen', seq });
    for (const c of t.clients) c.read();
    for (const c of t.clients) expect(lastTimers(c)!.endsAt).toBe(sent + 1000 + full);
    expect([rt.written().rows, rt.alarmsSet, rt.alarmAt]).toEqual([rows, alarms, due]);
    // (A `seen` that changes nothing sends nothing.)
    await t.world.send(t.code, last.sock, { t: 'seen', seq });
    expect(a.sock.inbox.length).toBe(0);
  });

  it('keeps each person’s Looking for and Spare, in their own word, until their own turn ends', { timeout: 120_000 }, async () => {
    const t = await startTable({ seed: 9, humans: 2, seats: 3 });
    const [c0, c1] = t.clients;
    // (Wool on both lists is looked for; paper isn't in a base game.) No row for it, however often it changes.
    const rt = t.world.rooms.get(t.code)!.rt;
    const rows = rt.written().rows;
    await t.world.send(t.code, c1.sock, { t: 'wants', looking: ['wheat'], spare: [] });
    await t.world.send(t.code, c1.sock, { t: 'wants', looking: ['ore', 'wool', 'ore'], spare: ['wool', 'brick', 'paper'] });
    expect(rt.written().rows).toBe(rows);
    c0.read();
    expect(c0.room!.seats[1].wants).toEqual({ looking: ['ore', 'wool'], spare: ['brick'] });
    expect(c0.room!.seats[0].wants).toBeUndefined();
    // The room sleeps and wakes: it's carried with the turn under way.
    await t.world.evict(t.code);
    await t.world.send(t.code, c0.sock, { t: 'wants', looking: [], spare: ['wheat'] });
    c0.read();
    expect(c0.room!.seats[1].wants).toEqual({ looking: ['ore', 'wool'], spare: ['brick'] });
    expect(c0.room!.seats[0].wants).toEqual({ looking: [], spare: ['wheat'] });
    // Not a card: refused at the door.
    await t.world.send(t.code, c1.sock, JSON.stringify({ t: 'wants', looking: ['gold'], spare: [] }));
    c1.read();
    expect(c1.errors.some((e) => e.startsWith('bad'))).toBe(true);
    c1.errors = [];
    // A spectator has nothing to want.
    const watcher = await t.world.connect(t.code, { token: (await t.world.guest('Quay')).token, watch: true });
    await t.world.send(t.code, watcher, { t: 'wants', looking: ['ore'], spare: [] });
    expect(watcher.take().some((m) => m.t === 'error' && m.code === 'seat')).toBe(true);
    // Empty lists clear it.
    await t.world.send(t.code, c0.sock, { t: 'wants', looking: [], spare: ['wheat'] });
    await t.world.send(t.code, c0.sock, { t: 'wants', looking: [], spare: [] });
    c1.read();
    expect(c1.room!.seats[0].wants).toBeUndefined();
    // Seat 1's word lasts until its own turn is over.
    await play(t, { until: () => serverState(t).phase === 'main' && serverState(t).currentPlayer === 1 });
    for (const c of t.clients) c.read();
    expect(c0.room!.seats[1].wants).toEqual({ looking: ['ore', 'wool'], spare: ['brick'] });
    const turn = serverState(t).turn;
    await play(t, { until: () => serverState(t).turn > turn });
    for (const c of t.clients) c.read();
    expect(c0.room!.seats[1].wants).toBeUndefined();
    expect(c0.errors).toEqual([]);
  });

  it('lets a person concede: the crew sails their seat to the end, and they finish last', { timeout: 600_000 }, async () => {
    const t = await startTable({ seed: 13, humans: 2, seats: 3, settings: { victoryPoints: 4, rated: true } });
    const [c0, c1] = t.clients;
    await play(t, { until: () => serverState(t).turn >= 2 });
    await t.world.send(t.code, c1.sock, { t: 'concede' });
    for (const c of t.clients) c.read();
    expect(c0.notices.some((n) => n.kind === 'conceded' && n.seat === 1)).toBe(true);
    expect(c0.room!.seats[1]).toMatchObject({ conceded: true, away: true });
    // Their seat isn't theirs to move, or to take back.
    c1.playing = false;
    await t.world.send(t.code, c1.sock, { t: 'act', n: 999, at: serverState(t).seq, a: { type: 'endTurn' } });
    c1.read();
    expect(c1.nacks.at(-1)).toMatchObject({ n: 999, code: 'auth' });
    await t.world.send(t.code, c1.sock, { t: 'back' });
    c1.read();
    expect(c1.room!.seats[1].away).toBe(true);
    await play(t);
    await t.world.settle(t.code);
    for (const c of t.clients) c.read();
    expect(serverState(t).phase).toBe('gameOver');
    const results = c0.room!.results!;
    expect(results.standings.find((s) => s.seat === 1)?.conceded).toBe(true);
    expect(results.awards?.length).toBeGreaterThan(0);
    // Rated: the one who conceded is placed last among the people, whatever their points.
    const r1 = results.ratings?.find((r) => r.seat === 1);
    const r0 = results.ratings?.find((r) => r.seat === 0);
    if (r0 && r1) expect(r1.after - r1.before).toBeLessThan(r0.after - r0.before);
    expect(c0.errors).toEqual([]);
  });

  it('hails only a seat kept waiting, and lets a burst of reactions go', { timeout: 120_000 }, async () => {
    const t = await startTable({ seed: 21, humans: 3, seats: 3, settings: { timer: 'off' } });
    const first = serverState(t).currentPlayer;
    const target = t.clients[first];
    const hailer = t.clients[(first + 1) % 3];
    const other = t.clients[(first + 2) % 3];
    // The opening has only just begun: no hail yet.
    await t.world.send(t.code, hailer.sock, { t: 'nudge', seat: first });
    target.read();
    expect(target.notices.some((n) => n.kind === 'nudged')).toBe(false);
    // Waited on long enough (from the island risen, at the latest OPENING_ALLOWANCE_MS): the seat
    // hears who hailed them (and nobody else does).
    await t.world.advance(t.code, OPENING_ALLOWANCE_MS + HAIL_AFTER_MS);
    await t.world.send(t.code, hailer.sock, { t: 'nudge', seat: first });
    for (const c of t.clients) c.read();
    expect(target.notices.filter((n) => n.kind === 'nudged')).toEqual([{ t: 'notice', kind: 'nudged', seat: hailer.seat }]);
    expect([...hailer.notices, ...other.notices].some((n) => n.kind === 'nudged')).toBe(false);
    // Twice running is once.
    await t.world.send(t.code, hailer.sock, { t: 'nudge', seat: first });
    target.read();
    expect(target.notices.filter((n) => n.kind === 'nudged').length).toBe(1);
    // Reactions: one at a time, from the seat that sent them.
    const reacts = () => target.sock.raw.map((x) => JSON.parse(x) as ServerMsg).filter((m) => m.t === 'react');
    target.sock.raw = [];
    await t.world.send(t.code, hailer.sock, { t: 'react', r: 'wave' });
    await t.world.send(t.code, hailer.sock, { t: 'react', r: 'cheer' });
    expect(reacts()).toEqual([{ t: 'react', from: hailer.seat, r: 'wave' }]);
    await t.world.advance(t.code, REACT_GAP_MS);
    await t.world.send(t.code, hailer.sock, { t: 'react', r: 'cheer' });
    expect(reacts().length).toBe(2);
  });

  it('leaving a live game hands the seat to the crew at once', { timeout: 120_000 }, async () => {
    const t = await startTable({ seed: 31, humans: 2, seats: 3 });
    const [c0, c1] = t.clients;
    // (Whether or not the turn is theirs, the crew has the seat at once.)
    await t.world.send(t.code, c1.sock, { t: 'leave' });
    c0.read();
    expect(c0.notices.some((n) => n.kind === 'left' && n.seat === 1)).toBe(true);
    expect(c0.room!.seats[1].away).toBe(true);
    expect(c0.room!.seats[1].conceded).toBeFalsy();
  });

  it('says why a room couldn’t be made', async () => {
    const world = await new World(3).init();
    const g = await world.guest('Host');
    await expect(world.createRoom(g.token, { settings: { preset: 'nope' } })).rejects.toThrow('No such preset: nope.');
  });
});
