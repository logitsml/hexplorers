import { describe, expect, it } from 'vitest';
import { RESOURCES, type Action, type GameEvent } from '../../src/engine';
import { botDecide, createBotMemory } from '../../src/engine/ai';
import { viewHash, wireView, type Viewer } from '../../src/engine/wire';
import type { HostMessage } from '../../src/game/host';
import type { ClientMsg, SeatInfo, ServerMsg } from '../../src/net/protocol';
import { RemoteHost, SEEN_EVERY_MS, nackText, type Snap } from '../../src/online/remoteHost';
import { CREW, FakeRoom, stillClock } from './fakeRoom';

const SEATS: SeatInfo[] = CREW.map((s, seat) => ({ seat, kind: s.isBot ? 'bot' : 'human', name: s.name, color: s.color, ...(s.isBot && { difficulty: 'normal' as const }) }));

/** A client on the fake room: its RemoteHost, what it was shown, and a presenter stand-in that reports each record shown when told to. */
function client(room: FakeRoom, viewer: Viewer, o: { waitScale?: () => number; clock?: ReturnType<typeof stillClock> } = {}) {
  const sock = room.connect(viewer);
  const snap = sock.outbox.shift() as Snap;
  const shown: HostMessage[] = [];
  const errors: string[] = [];
  const sent: ClientMsg[] = [];
  const clock = o.clock ?? stillClock();
  const c = {
    sock,
    clock,
    shown,
    errors,
    sent,
    presentedUpTo: snap.seq,
    resyncs: 0,
    wantsResync: false,
    /** Messages to this client are lost (the socket is down). */
    down: false,
    /** The next batch is a resume's. */
    catchUpNext: false,
    host: null as unknown as RemoteHost,
  };
  c.host = new RemoteHost({
    seat: viewer,
    snap,
    seats: SEATS,
    send: (m) => {
      if (c.down) return false;
      sent.push(m);
      room.hear(sock, m);
      return true;
    },
    resync: () => {
      c.resyncs++;
      c.wantsResync = true;
    },
    clock,
    waitScale: o.waitScale ?? (() => 0),
  });
  c.host.onError = (e) => errors.push(e);
  c.host.subscribe((m) => shown.push(m));
  // The presenter's intro: the game it began from has been shown.
  c.host.presented();
  return c;
}

type Client = ReturnType<typeof client>;

/** Deliver one message, resume one socket, or report what was shown: the first that's due. */
function service(room: FakeRoom, clients: Client[]): boolean {
  for (const c of clients) {
    if (c.wantsResync) {
      // (A new socket: what the old one still had queued is gone with it.)
      c.wantsResync = false;
      c.catchUpNext = true;
      c.sock.outbox.length = 0;
      room.resume(c.sock, c.host.resumeInfo());
      return true;
    }
    if (!c.down && c.sock.outbox.length) {
      const m = c.sock.outbox.shift()!;
      c.host.receive(m, { catchUp: m.t === 'gb' && c.catchUpNext });
      if (m.t === 'gb' || m.t === 'snap') c.catchUpNext = false;
      return true;
    }
    const last = c.shown[c.shown.length - 1];
    if (last?.seq !== undefined && last.seq > c.presentedUpTo) {
      c.presentedUpTo = last.seq;
      c.host.presented(last.seq);
      return true;
    }
  }
  return false;
}

/** The view a client holds is the room's for its seat, hash for hash. */
function inStep(room: FakeRoom, c: Client) {
  expect(c.host.lastSeq).toBe(room.seq);
  expect(c.host.resumeInfo()?.hash).toBe(viewHash(wireView(room.state, c.host.me)));
}

describe('RemoteHost against a scripted room', () => {
  it('plays a whole game through the room, view for view, with a spectator watching', { timeout: 900_000 }, () => {
    const room = new FakeRoom({ seed: 41 });
    const me = client(room, 0);
    const quay = client(room, null);
    const mem = createBotMemory({ waitForHumans: true });
    let moves = 0;
    for (let i = 0; i < 40_000 && room.state.phase !== 'gameOver'; i++) {
      if (service(room, [me, quay])) continue;
      if (i % 40 === 0) {
        inStep(room, me);
        inStep(room, quay);
      }
      if (room.botStep()) continue;
      // The person (a bot's mind on the seat's own view) moves when the game waits on them.
      expect(me.host.sending).toBe(false);
      const a = botDecide(me.host.state, 0, mem, 'normal');
      expect(a, `stuck at ${room.state.phase}`).not.toBeNull();
      expect(me.host.submit(0, a!)).toEqual({ ok: true });
      moves++;
    }
    while (service(room, [me, quay]));
    expect(room.state.phase).toBe('gameOver');
    expect(me.errors).toEqual([]);
    expect(moves).toBeGreaterThan(20);
    inStep(room, me);
    inStep(room, quay);
    expect(me.host.state.phase).toBe('gameOver');
    expect(quay.host.state.phase).toBe('gameOver');
    // Every move named the offer it answered, and it was the open one.
    expect(room.answers.length).toBeGreaterThan(0);
    for (const a of room.answers) expect(a.offer).toBe(a.open);
    // Each record shown was reported, by the seat and not the quay: the newest at most every
    // SEEN_EVERY_MS, so the last goes once that has passed, and never two in one.
    me.clock.advance(SEEN_EVERY_MS);
    const seen = room.received.filter((m): m is Extract<ClientMsg, { t: 'seen' }> => m.t === 'seen');
    expect(seen[seen.length - 1].seq).toBe(room.seq);
    expect(seen.length).toBeLessThan(room.seq / 4);
    expect(quay.sent).toEqual([]);
    expect(me.host.sending).toBe(false);
    // Nobody's secrets came through: hands are sizes (under ore), theft and dev cards face down
    // for whoever wasn't party to them.
    const events = (c: Client) => c.shown.flatMap((m) => m.events) as (GameEvent & Record<string, unknown>)[];
    for (const p of quay.host.state.players) for (const r of RESOURCES) if (r !== 'ore') expect(p.hand[r]).toBe(0);
    for (const p of me.host.state.players.slice(1)) for (const r of RESOURCES) if (r !== 'ore') expect(p.hand[r]).toBe(0);
    const stolen = events(quay).filter((e) => e.type === 'stolen');
    expect(stolen.length).toBeGreaterThan(0);
    for (const e of stolen) expect(e.resource).toBeUndefined();
    for (const e of events(me).filter((e) => e.type === 'stolen')) expect(e.resource === undefined).toBe(e.thief !== 0 && e.victim !== 0);
    for (const e of events(me).filter((e) => e.type === 'devCardBought')) expect(e.card === undefined).toBe(e.player !== 0);
    // Others' moves came as their type alone.
    for (const m of me.shown) if (m.actor !== null && m.actor !== 0 && m.action) expect(Object.keys(m.action)).toEqual(['type']);
  });

  it('turns a refusal into the presenter’s error, and lifts the guard on a second move', { timeout: 120_000 }, () => {
    const room = new FakeRoom({ seed: 7, layout: 'beginner' });
    const me = client(room, 0);
    // Bring the game to the person's first decision.
    for (let i = 0; i < 2000; i++) {
      if (service(room, [me])) continue;
      if (!room.botStep()) break;
    }
    const a = botDecide(me.host.state, 0, createBotMemory({ waitForHumans: true }), 'normal')!;
    expect(a).not.toBeNull();
    // A second press of the same move is the same move; another waits for the first.
    room.refuseNext = 'stale';
    expect(me.host.submit(0, a)).toEqual({ ok: true });
    expect(me.host.sending).toBe(true);
    expect(me.host.submit(0, a)).toEqual({ ok: true });
    expect(me.host.submit(0, { type: 'endTurn' })).toEqual({ ok: false, error: 'One moment: your last move is still on its way' });
    expect(me.sent.filter((m) => m.t === 'act')).toHaveLength(1);
    while (service(room, [me]));
    expect(me.errors).toEqual([nackText('stale', '')]);
    expect(me.host.sending).toBe(false);
    // Tried again, it goes through, and its record's ack lifts the guard.
    expect(me.host.submit(0, a)).toEqual({ ok: true });
    const act = me.sent.filter((m) => m.t === 'act').pop() as Extract<ClientMsg, { t: 'act' }>;
    expect(act.n).toBe(2);
    expect(act.at).toBe(me.host.lastSeq);
    while (service(room, [me]));
    expect(me.host.sending).toBe(false);
    expect(me.errors).toHaveLength(1);
    // A move the engine refuses here never goes out.
    const before = me.sent.length;
    const bad = me.host.submit(0, { type: 'buildCity', vertex: 0 } as Action);
    expect(bad.ok).toBe(false);
    expect(me.sent.length).toBe(before);
    // Off the line, a move says so rather than vanishing.
    me.down = true;
    const next = botDecide(me.host.state, 0, createBotMemory({ waitForHumans: true }), 'normal');
    if (next) expect(me.host.submit(0, next).ok).toBe(false);
  });

  it('catches up after a short drop with a batch, and after a long one with a snapshot', { timeout: 300_000 }, () => {
    // (The crew plays every seat: the client follows seat 1's view.)
    const room = new FakeRoom({ seed: 12, crewOnly: true });
    const me = client(room, 1 as Viewer);
    const steps = (n: number) => {
      for (let k = 0; k < n; ) {
        if (service(room, [me])) continue;
        if (!room.botStep()) throw new Error('the crew stopped');
        k++;
      }
    };
    steps(30);
    while (service(room, [me]));
    inStep(room, me);
    // A short drop: the room sends what was missed as one batch, shown quickly.
    me.down = true;
    me.sock.dropped = true;
    for (let k = 0; k < 10; k++) room.botStep();
    me.down = false;
    me.wantsResync = true;
    service(room, [me]);
    expect(me.sock.outbox[0].t).toBe('gb');
    const shownBefore = me.shown.length;
    service(room, [me]);
    expect(me.host.catchUp).toBe(true);
    expect(me.shown.length - shownBefore).toBe(10);
    while (service(room, [me]));
    expect(me.host.catchUp).toBe(false);
    inStep(room, me);
    // A long one: a snapshot, and the presenter is told the view jumped.
    me.down = true;
    me.sock.dropped = true;
    for (let k = 0; k < 80; k++) room.botStep();
    me.down = false;
    me.wantsResync = true;
    service(room, [me]);
    expect(me.sock.outbox[0].t).toBe('snap');
    while (service(room, [me]));
    const jump = me.shown[me.shown.length - 1];
    expect(jump.jump).toBe(true);
    expect(jump.seq).toBe(room.seq);
    inStep(room, me);
  });

  it('asks the room again for a record gone missing, and for a view whose hash is wrong', { timeout: 300_000 }, () => {
    const room = new FakeRoom({ seed: 19, crewOnly: true });
    const me = client(room, 2 as Viewer);
    const run = (n: number) => {
      for (let k = 0; k < n; k++) room.botStep();
    };
    run(5);
    // One record lost on the way: the next shows the gap, and a resume's batch fills it.
    me.sock.outbox.splice(2, 1);
    while (service(room, [me]));
    expect(me.resyncs).toBe(1);
    inStep(room, me);
    // A view gone wrong (the record's hash disagrees): asked for whole, and the view jumps to it.
    run(40);
    const spoilt = me.sock.outbox.find((m): m is Extract<ServerMsg, { t: 'g' }> => m.t === 'g' && m.h !== undefined)!;
    spoilt.h = '00000000000000';
    let asked: unknown = undefined;
    for (let i = 0; i < 1000 && me.resyncs < 2; i++) service(room, [me]);
    expect(me.resyncs).toBe(2);
    asked = me.host.resumeInfo();
    expect(asked).toBeNull();
    while (service(room, [me]));
    expect(me.shown[me.shown.length - 1].jump).toBe(true);
    inStep(room, me);
  });

  it('holds a bot’s move for its think time, once the one before it has been shown', { timeout: 120_000 }, () => {
    const room = new FakeRoom({ seed: 3, crewOnly: true });
    const clock = stillClock();
    const me = client(room, 1 as Viewer, { waitScale: () => 0.5, clock });
    room.botWait = 1000;
    expect(room.botStep() && room.botStep()).toBe(true);
    // Both records are received; the first waits its 500 ms, the second for the first to be shown too.
    while (me.sock.outbox.length) me.host.receive(me.sock.outbox.shift()!);
    expect(me.shown).toHaveLength(0);
    expect(me.host.backlog).toBe(2);
    clock.advance(499);
    expect(me.shown).toHaveLength(0);
    clock.advance(1);
    expect(me.shown).toHaveLength(1);
    clock.advance(5000);
    expect(me.shown).toHaveLength(1);
    me.host.presented(me.shown[0].seq);
    clock.advance(499);
    expect(me.shown).toHaveLength(1);
    clock.advance(1);
    expect(me.shown).toHaveLength(2);
    // The newest view is what a move is checked against, ahead of what is shown.
    expect(me.host.newest.seq).toBe(room.state.seq);
    // Fallen behind by more than a bot run (a hidden tab), the pauses go and the presentation hurries.
    me.host.presented(me.shown[1].seq);
    for (let k = 0; k < 20; k++) room.botStep();
    while (me.sock.outbox.length) me.host.receive(me.sock.outbox.shift()!);
    expect(me.host.catchUp).toBe(true);
    expect(me.shown.length).toBe(2 + 20);
    me.host.presented(me.shown[me.shown.length - 1].seq);
    expect(me.host.catchUp).toBe(false);
  });
});
