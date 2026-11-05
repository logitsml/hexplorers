import { describe, expect, it } from 'vitest';
import { BACKOFF_MAX_MS, Connection, PING_EVERY_MS, PONG_WAIT_MS, backoff, type SocketLike } from '../../src/online/connection';
import type { LinkState } from '../../src/online/store';
import type { ServerMsg } from '../../src/net/protocol';

/** Sockets the test opens, answers and drops by hand, on a clock that only moves when told. */
function harness() {
  let t = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const sockets: (SocketLike & { sent: string[]; url: string; open(): void; drop(code?: number): void; say(m: unknown): void })[] = [];
  let online = true;
  const deps = {
    socket: (url: string) => {
      const s = {
        url,
        sent: [] as string[],
        readyState: 0,
        onopen: null as SocketLike['onopen'],
        onmessage: null as SocketLike['onmessage'],
        onclose: null as SocketLike['onclose'],
        onerror: null as SocketLike['onerror'],
        send(d: string) {
          this.sent.push(d);
        },
        close() {
          this.readyState = 3;
        },
        open() {
          this.readyState = 1;
          this.onopen?.({});
        },
        drop(code = 1006) {
          this.readyState = 3;
          this.onclose?.({ code });
        },
        say(m: unknown) {
          this.onmessage?.({ data: JSON.stringify(m) });
        },
      };
      sockets.push(s);
      return s;
    },
    setTimeout: (fn: () => void, ms: number) => (timers.set(++id, { at: t + ms, fn }), id),
    clearTimeout: (x: unknown) => void timers.delete(x as number),
    setInterval: (fn: () => void, ms: number) => (timers.set(++id, { at: t + ms, fn, every: ms }), id),
    clearInterval: (x: unknown) => void timers.delete(x as number),
    now: () => t,
    random: () => 1,
    online: () => online,
    events: null,
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [k, v] = next;
      t = v.at;
      if (v.every) v.at += v.every;
      else timers.delete(k);
      v.fn();
    }
    t = end;
  };
  return { deps, sockets, advance, setOnline: (v: boolean) => (online = v) };
}

const WELCOME = { t: 'welcome', proto: 1, you: { seat: 0, user: 'g', host: true, watch: false }, room: {}, chat: [] };

describe('the room’s socket', () => {
  it('opens with hello, and comes back after a drop with what it last had', () => {
    const h = harness();
    const states: LinkState[] = [];
    const got: ServerMsg[] = [];
    let last: number | undefined;
    const c = new Connection({
      url: 'ws://localhost/api/rooms/KQ7M4P/ws',
      hello: () => ({ t: 'hello', proto: 1, build: 'dev', token: 'tok', ...(last !== undefined && { last, hash: 'abc' }) }),
      onMessage: (m) => got.push(m),
      onState: (s) => states.push(s),
      deps: h.deps,
    });
    c.open();
    expect(h.sockets[0].url).not.toContain('tok');
    h.sockets[0].open();
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({ t: 'hello', proto: 1, build: 'dev', token: 'tok' });
    h.sockets[0].say(WELCOME);
    expect(states).toEqual(['open']);
    expect(got.map((m) => m.t)).toEqual(['welcome']);
    // Dropped: it waits its backoff, then a new socket's hello says where it got to.
    last = 41;
    h.sockets[0].drop();
    expect(states[states.length - 1]).toBe('reconnecting');
    h.advance(backoff(0, () => 1) - 1);
    expect(h.sockets).toHaveLength(1);
    h.advance(1);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].open();
    expect(JSON.parse(h.sockets[1].sent[0])).toMatchObject({ t: 'hello', last: 41, hash: 'abc' });
    h.sockets[1].say(WELCOME);
    expect(states[states.length - 1]).toBe('open');
    // Sends go out as JSON; nothing too long for the server goes at all.
    expect(c.send({ t: 'ready', on: true })).toBe(true);
    expect(c.send({ t: 'chat', text: 'x'.repeat(5000) })).toBe(false);
    c.close();
    expect(states[states.length - 1]).toBe('closed');
    h.sockets[1].drop();
    h.advance(60_000);
    expect(h.sockets).toHaveLength(2);
  });

  it('stays closed when the room closes it for good (another tab took the seat, the room is gone)', () => {
    for (const code of [4409, 4410, 4403, 1008]) {
      const h = harness();
      const states: LinkState[] = [];
      const closed: number[] = [];
      const c = new Connection({ url: 'ws://x', hello: () => ({ t: 'hello', proto: 1, build: 'dev', token: 't' }), onMessage: () => {}, onState: (s) => states.push(s), onClosed: (x) => closed.push(x), deps: h.deps });
      c.open();
      h.sockets[0].open();
      h.sockets[0].say(WELCOME);
      h.sockets[0].drop(code);
      h.advance(120_000);
      // (Back at once, a tab that lost its seat to another would only take it back, and so on.)
      expect(h.sockets).toHaveLength(1);
      expect(closed).toEqual([code]);
      expect(states.at(-1)).toBe('closed');
      expect(c.link).toBe('closed');
    }
  });

  it('backs off, doubling to its cap, and starts over once welcomed', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((n) => backoff(n, () => 1))).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
    for (let n = 0; n < 8; n++) {
      const low = backoff(n, () => 0);
      expect(low).toBeGreaterThanOrEqual(backoff(n, () => 1) / 2);
      expect(low).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    }
  });

  it('finds a socket that died quietly by its ping going unanswered', () => {
    const h = harness();
    const c = new Connection({ url: 'ws://x', hello: () => ({ t: 'hello', proto: 1, build: 'dev', token: 't' }), onMessage: () => {}, onState: () => {}, deps: h.deps });
    c.open();
    h.sockets[0].open();
    h.sockets[0].say(WELCOME);
    h.advance(PING_EVERY_MS);
    expect(h.sockets[0].sent[1]).toBe('{"t":"ping"}');
    // Answered: nothing happens.
    h.sockets[0].say({ t: 'pong' });
    h.advance(PONG_WAIT_MS);
    expect(h.sockets).toHaveLength(1);
    // Unanswered: the socket is replaced at once.
    h.advance(PING_EVERY_MS);
    h.advance(PONG_WAIT_MS);
    expect(h.sockets).toHaveLength(2);
    c.close();
  });

  it('waits for the network rather than spending its attempts', () => {
    const h = harness();
    const states: LinkState[] = [];
    h.setOnline(false);
    const c = new Connection({ url: 'ws://x', hello: () => ({ t: 'hello', proto: 1, build: 'dev', token: 't' }), onMessage: () => {}, onState: (s) => states.push(s), deps: h.deps });
    c.open();
    expect(states).toEqual(['offline']);
    expect(h.sockets).toHaveLength(0);
    c.close();
  });
});
