// What a room keeps where, and what each way of going down costs it. The turn under way rides in
// the sockets' attachments (the carry) until a turn ends or something is drawn or shown: a room
// that sleeps mid-turn wakes exactly as it was, with nothing written; the last socket closing puts
// it into storage (also when the close wakes a room that no longer lists that socket); and a crash
// (the process gone, the sockets and their attachments with it) takes back only quiet moves: the
// room comes back at what storage holds, every client resyncs by snapshot, and nothing anyone saw
// drawn or shown is taken back, so nobody can see a roll or a card and then act otherwise before
// it. And the room core never sets a timer of its own (one would keep every room awake, billed).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAction, createGame, type Action, type GameEvent, type GameOptions, type GameState, type PlayerId, type PlayerSetup } from '../../src/engine';
import { canonical, viewHash } from '../../src/engine/wire';
import { checkReveal } from '../../src/net/codes';
import type { RoomSettings } from '../../src/net/protocol';
import { forcedRoll, reveals } from '../../server/room/table';
import { FakeSocket, World, play, serverState, serverView, startTable, storedActions, type TestTable } from './harness';

interface Inside {
  open: { entries: object[] };
  table: { setups: PlayerSetup[]; options: GameOptions; rngKey: string; diceKey?: string };
  fullLog(): { p: PlayerId; a: Action }[];
}
const inside = (t: TestTable) => t.world.rooms.get(t.code)!.room as unknown as Inside;
const counters = (t: TestTable) => t.world.rooms.get(t.code)!.room.counters;

/** The turn's player is a person mid-turn, with moves since storage last took the turn (they're only in the sockets). */
const unstored = (t: TestTable) => {
  const s = serverState(t);
  return s.phase === 'main' && s.currentPlayer < t.clients.length && storedActions(t) < s.seq;
};

/** For each action of a log, from the start: whether it showed anything (a draw, a hidden card), and whether it was a roll nobody could have done otherwise. */
function flags(t: TestTable, log: { p: PlayerId; a: Action }[]) {
  const tb = inside(t).table;
  let s: GameState = createGame(tb.setups, tb.options, tb.diceKey ? { rngKey: tb.rngKey, diceKey: tb.diceKey } : { rngKey: tb.rngKey }).state;
  return log.map(({ p, a }) => {
    const r = applyAction(s, p, a);
    if (!r.ok) throw new Error(`the log doesn't replay at ${s.seq}: ${r.error}`);
    const f = { shows: reveals(p, s.rngState, r.state, r.events), forced: forcedRoll(s, p, a), events: (r.events as GameEvent[]).map((e) => e.type) };
    s = r.state;
    return f;
  });
}

/** Every frame any socket of this table is sent, with what storage held then and how far the game was. */
function watchSends(t: TestTable) {
  const marks: { stored: number; seq: number }[] = [];
  const send = FakeSocket.prototype.send;
  FakeSocket.prototype.send = function (this: FakeSocket, data: string) {
    const e = t.world.rooms.get(t.code)!;
    if (e.rt.socks.includes(this) && (e.room as unknown as { table: unknown }).table) marks.push({ stored: storedActions(t), seq: serverState(t).seq });
    send.call(this, data);
  };
  return { marks, stop: () => (FakeSocket.prototype.send = send) };
}

/** Whatever a crash at that moment would have taken back was quiet: only the first of it may be a roll nobody could have done otherwise. */
function expectNothingShownUnstored(marks: { stored: number; seq: number }[], f: ReturnType<typeof flags>) {
  let tails = 0;
  for (const m of marks) {
    for (let i = m.stored; i < m.seq; i++) {
      if (!f[i].shows) continue;
      expect({ at: i, stored: m.stored, seq: m.seq, events: f[i].events, exempt: i === m.stored && f[i].forced }).toMatchObject({ exempt: true });
    }
    if (m.seq > m.stored) tails++;
  }
  return tails;
}

async function reconnect(t: TestTable, i: number) {
  const c = t.clients[i];
  c.sock = await t.world.connect(t.code, { token: t.tokens[i], last: c.seq, hash: viewHash(c.view!) });
  c.outstanding = null;
  c.read();
  return c;
}

describe('the turn under way, in the sockets', () => {
  it('a room that sleeps mid-turn wakes as it slept, nothing written for it, and finishes as one never put to sleep', { timeout: 900_000 }, async () => {
    const straight = await startTable({ seed: 31, humans: 2 });
    await play(straight);
    straight.clients[0].read();
    const t = await startTable({ seed: 31, humans: 2 });
    let sleeps = 0;
    await play(t, {
      until: async () => {
        if (sleeps >= 6 || !unstored(t)) return false;
        // Mid-turn, with moves storage doesn't have: the room sleeps (and is evicted) at once.
        const seq = serverState(t).seq;
        const stored = storedActions(t);
        const snaps = t.clients.map((c) => c.snaps);
        const rows = t.world.rooms.get(t.code)!.rt.sql.rowsWritten;
        await t.world.evict(t.code);
        expect(serverState(t).seq).toBe(seq);
        expect(storedActions(t)).toBe(stored);
        expect(t.world.rooms.get(t.code)!.rt.sql.rowsWritten).toBe(rows);
        // The clients carry on where they were: no snapshot, their views the server's.
        for (const c of t.clients) {
          expect(c.snaps).toBe(snaps[t.clients.indexOf(c)]);
          expect(viewHash(c.view!)).toBe(viewHash(serverView(t, c.seat!)));
        }
        sleeps++;
        return false;
      },
    });
    expect(sleeps).toBe(6);
    for (const c of t.clients) {
      c.read();
      expect(c.errors).toEqual([]);
    }
    expect(t.clients[0].reveal!.log).toEqual(straight.clients[0].reveal!.log);
    expect(canonical(serverState(t))).toBe(canonical(serverState(straight)));
  });

  it('the last socket closing puts the turn under way into storage, also when its close wakes a room that no longer lists it', { timeout: 900_000 }, async () => {
    const t = await startTable({ seed: 33, humans: 2 });
    await play(t, { until: () => serverState(t).turn > 6 && unstored(t) });
    const seq = serverState(t).seq;
    expect(storedActions(t)).toBeLessThan(seq);
    // One leaves: the other's socket still carries the turn.
    t.clients[1].sock.close(1000, 'bye');
    await t.world.settle(t.code);
    expect(storedActions(t)).toBeLessThan(seq);
    // The last one goes while the room sleeps: woken by the close, it was built from what the runtime
    // still lists (nothing), and takes the carry from the closing socket itself.
    const last = t.clients[0].sock;
    last.closed = { code: 1001, reason: 'gone' };
    await t.world.evict(t.code);
    expect(serverState(t).seq).toBeLessThan(seq);
    await t.world.rooms.get(t.code)!.room.webSocketClose(last, 1001, 'gone', true);
    await t.world.settle(t.code);
    expect(storedActions(t)).toBe(seq);
    expect(counters(t).journal.flush).toBe(1);
    // Storage alone now has it all.
    await t.world.crash(t.code);
    expect(serverState(t).seq).toBe(seq);
    for (let i = 0; i < 2; i++) {
      const c = await reconnect(t, i);
      expect(c.errors).toEqual([]);
      expect(viewHash(c.view!)).toBe(viewHash(serverView(t, i)));
    }
    await play(t);
    expect(serverState(t).phase).toBe('gameOver');
  });

  it('a socket that refuses the carry (the platform counting it bigger) costs a row, never the handler', { timeout: 900_000 }, async () => {
    const t = await startTable({ seed: 34, humans: 2 });
    await play(t, { until: () => serverState(t).turn > 3 });
    // (Room for who it is, not for the turn under way.)
    t.clients[1].sock.limit = 400;
    await play(t, { until: () => serverState(t).turn > 12 });
    expect(counters(t).journal.big).toBeGreaterThan(3);
    for (const c of t.clients) {
      c.read();
      expect(c.errors).toEqual([]);
      expect(viewHash(c.view!)).toBe(viewHash(serverView(t, c.seat!)));
    }
    // Storage had it all each time: a crash now takes back nothing.
    expect(storedActions(t)).toBe(serverState(t).seq);
  });

  it('a harbour that sleeps keeps its claims and settings in the sockets, and its last close stores them', async () => {
    const w = await new World(35).init();
    const a = await w.guest('Ann');
    const b = await w.guest('Ben');
    const code = await w.createRoom(a.token);
    const rt = w.rooms.get(code)!.rt;
    const rows = rt.sql.rowsWritten;
    const sa = await w.connect(code, { token: a.token });
    const sb = await w.connect(code, { token: b.token });
    await w.send(code, sa, { t: 'claim', seat: 0, color: 'teal' });
    await w.send(code, sb, { t: 'claim', seat: 2 });
    await w.send(code, sb, { t: 'ready', on: true });
    await w.send(code, sb, { t: 'ready', on: false });
    await w.send(code, sb, { t: 'ready', on: true });
    await w.send(code, sa, { t: 'settings', settings: { seats: 3, victoryPoints: 12 } });
    // None of that was a row.
    expect(rt.sql.rowsWritten).toBe(rows);
    const card = async () => (await (await w.fetch(code, 'card')).json()) as { seats: { kind: string; color: string }[]; settings: { seats: number; victoryPoints: number } };
    await w.evict(code);
    const slept = await card();
    expect(slept.seats.map((s) => s.kind)).toEqual(['human', 'open', 'human']);
    expect(slept.seats[0].color).toBe('teal');
    expect(slept.settings).toMatchObject({ seats: 3, victoryPoints: 12 });
    // Both leave: one row, and storage alone has the harbour as it was.
    sa.close(1000);
    sb.close(1000);
    await w.settle(code);
    expect(rt.sql.rowsWritten).toBe(rows + 1);
    await w.crash(code);
    expect((await card()).seats.map((s) => s.kind)).toEqual(['human', 'open', 'human']);
  });
});

describe('word to someone away', () => {
  it('at a live table is sent once when the table waits on someone away, not for every turn, and not again after the room slept', { timeout: 900_000 }, async () => {
    const t = await startTable({ seed: 36, humans: 2 });
    const notes: { users: string[]; kind?: string }[] = [];
    const send = t.world.services.notify.bind(t.world.services);
    t.world.services.notify = async (users, note) => {
      notes.push({ users, kind: note.kind });
      await send(users, note);
    };
    const turn = serverState(t).turn;
    await play(t, { until: () => serverState(t).turn >= turn + 12 && unstored(t) });
    // Everyone at the table: twelve turns, no word.
    expect(notes).toEqual([]);
    await t.world.evict(t.code);
    await play(t, { until: () => serverState(t).turn >= turn + 14 });
    expect(notes).toEqual([]);
    // One leaves on the other's move: nothing yet; when the move is theirs, the table waits on them, and they hear once.
    await play(t, { until: () => serverState(t).currentPlayer === 0 && serverState(t).phase === 'main' });
    t.clients[1].sock.close(1001, 'gone');
    await t.world.settle(t.code);
    expect(notes).toEqual([]);
    await play({ ...t, clients: [t.clients[0]] }, { until: () => serverState(t).currentPlayer === 1 });
    expect(notes).toEqual([{ users: [expect.any(String)], kind: 'move' }]);
  });
});

describe('a crash', () => {
  it('takes back only quiet moves: the room comes back at what storage holds, and every client resyncs by snapshot', { timeout: 900_000 }, async () => {
    const t = await startTable({ seed: 37, humans: 2 });
    const watch = watchSends(t);
    let lost = 0;
    try {
      await play(t, { until: () => serverState(t).turn > 10 && unstored(t) });
      const before = serverState(t).seq;
      const stored = storedActions(t);
      const history = inside(t).fullLog();
      expect(history.length).toBe(before);
      // What the crash takes back was quiet (only its first may be a roll nobody could have done otherwise).
      const f = flags(t, history);
      expect(expectNothingShownUnstored([{ stored, seq: before }], f)).toBe(1);
      lost = before - stored;
      expect(lost).toBeGreaterThan(0);
      const snaps = t.clients.map((c) => c.snaps);
      await t.world.crash(t.code);
      expect(serverState(t).seq).toBe(stored);
      expect(inside(t).fullLog()).toEqual(history.slice(0, stored));
      for (let i = 0; i < t.clients.length; i++) {
        const c = await reconnect(t, i);
        expect(c.snaps).toBe(snaps[i] + 1);
        expect(c.seq).toBe(stored);
        expect(viewHash(c.view!)).toBe(viewHash(serverView(t, i)));
      }
      // Up to the crash, every frame went out with storage holding every reveal before it.
      expectNothingShownUnstored(watch.marks, f);
      watch.marks.length = 0;
    } finally {
      watch.stop();
    }
    // And the game plays on to its end, its dice checking out from the reveal.
    await play(t);
    for (const c of t.clients) {
      c.read();
      expect(c.errors).toEqual([]);
      expect(viewHash(c.view!)).toBe(viewHash(serverView(t, c.seat!)));
    }
    const reveal = t.clients[0].reveal!;
    const rngKey = await checkReveal(t.clients[0].room!.commit!, reveal.key, reveal.nonces);
    expect(rngKey).toBe(inside(t).table.rngKey);
    let s = createGame(inside(t).table.setups, reveal.options, { rngKey: rngKey! }).state;
    for (const { actor, action } of reveal.log) {
      const r = applyAction(s, actor, action);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.state;
    }
    expect(s.winner).toBe(serverState(t).winner);
  });

  // (Seeds with a quiet move before a roll nobody could have done otherwise, in the same turn: a
  // knight that found nobody to rob, a guild card. That roll must be stored before it's sent, since
  // a rollback would put the choice of the move before it back in the person's hands.)
  for (const [name, seed, settings] of [['the base game', 15, {}], ['All Hands', 17, { preset: 'allHands' }]] as [string, number, Partial<RoomSettings>][]) {
    it(`never could have taken back anything shown, at any frame of a whole game (${name})`, { timeout: 900_000 }, async () => {
      const t = await startTable({ seed, humans: 3, settings });
      const watch = watchSends(t);
      try {
        await play(t, { seen: true });
      } finally {
        watch.stop();
      }
      expect(serverState(t).phase).toBe('gameOver');
      const log = inside(t).fullLog();
      const f = flags(t, log);
      expect(watch.marks.length).toBeGreaterThan(200);
      // (Frames went out with a quiet tail unstored many times: the carry did its work.)
      expect(expectNothingShownUnstored(watch.marks, f)).toBeGreaterThan(20);
      // Every reveal of the game was in storage before any frame after it.
      expect(f.filter((x) => x.shows).length).toBeGreaterThan(20);
    });
  }
});

describe('the room core', () => {
  it('never sets a timer of its own and never accepts a socket the standard way', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const d of ['server/room', 'server/services', 'server/features']) walk(d);
    expect(files.length).toBeGreaterThan(20);
    // (Comments may name them; code may not.)
    const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const offenders = files.filter((p) => /\bset(Timeout|Interval)\s*\(|\bsetImmediate\s*\(/.test(code(p)));
    expect(offenders).toEqual([]);
    // The Durable Object accepts with ctx.acceptWebSocket (hibernatable), never ws.accept().
    const room = code('server/cloudflare/room-do.ts');
    expect(room).toMatch(/\.acceptWebSocket\(/);
    expect(room).not.toMatch(/\.accept\(\s*\)/);
  });
});
