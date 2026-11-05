// The room's socket, kept up. One per tab. The URL carries no token: the first message is
// `hello` (the token, the protocol, this build, and on a reconnect the last record seen and its
// hash, so the server sends only what was missed). A dropped socket comes back after a backoff
// that doubles to 15 s, jittered so a room's phones don't all knock at once; a phone waking or
// the network returning tries at once. An app-level ping every 25 s finds a socket that died
// quietly (iOS Safari keeps a dead one "open" after a sleep); the server answers it without
// waking the room (see ARCHITECTURE.md, Hibernation rules).

import { MAX_FRAME, type ClientMsg, type ServerMsg } from '../net/protocol';
import type { LinkState } from './store';

/** The few members of a WebSocket this uses (a test hands in its own). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface ConnectionDeps {
  socket(url: string): SocketLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  now(): number;
  random(): number;
  /** Whether the device thinks it is online (navigator.onLine). */
  online(): boolean;
  /** Where 'online', 'offline' and 'visibilitychange' are heard (null: nowhere, as in a test). */
  events: { window: EventTarget; document: Document } | null;
}

const OPEN = 1;

/**
 * Closes the room means for good: a token it doesn't know (4401), not allowed in or put ashore
 * (4403), no such room (4404), the seat opened in another tab or taken up on another device
 * (4409), the room closed (4410), too many watching (4429), a newer protocol (4426), and frames
 * it won't read (1003, 1008, 1009). Coming straight back would only be refused again, or (4409)
 * take the seat back from the tab that has it.
 */
export const FINAL_CLOSES = new Set([1003, 1008, 1009, 4401, 4403, 4404, 4409, 4410, 4426, 4429]);

/** How often the app pings, how long it waits for a word back after one, and the backoff's bounds. */
export const PING_EVERY_MS = 25_000;
export const PONG_WAIT_MS = 10_000;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 15_000;

/** The wait before attempt `n` (0 first): doubling to the cap, then somewhere in its upper half. */
export function backoff(n: number, random: () => number = Math.random): number {
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** n);
  return Math.round(cap * (0.5 + random() * 0.5));
}

function browserDeps(): ConnectionDeps {
  return {
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    now: () => Date.now(),
    random: Math.random,
    online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    events: typeof window === 'undefined' ? null : { window, document },
  };
}

export interface ConnectionOptions {
  url: string;
  /** The hello for each new socket (made fresh each time: a reconnect carries the last record seen). */
  hello: () => Extract<ClientMsg, { t: 'hello' }>;
  onMessage: (m: ServerMsg) => void;
  onState: (s: LinkState) => void;
  /** The room closed the socket for good (one of FINAL_CLOSES): nothing reconnects. */
  onClosed?: (code: number, reason: string) => void;
  deps?: Partial<ConnectionDeps>;
}

export class Connection {
  private ws: SocketLike | null = null;
  private d: ConnectionDeps;
  private attempt = 0;
  private retry: unknown = null;
  private pinger: unknown = null;
  private pongDue: unknown = null;
  private state: LinkState = 'connecting';
  /** Closed for good (left, or refused): nothing reconnects. */
  private done = false;
  /** Welcomed at least once on some socket (later drops are reconnects, not first tries). */
  private everOpen = false;
  private unlisten: (() => void) | null = null;

  constructor(private o: ConnectionOptions) {
    this.d = { ...browserDeps(), ...o.deps };
    const ev = this.d.events;
    if (ev) {
      const online = () => this.wake();
      // (The device's word for it can be wrong: a live socket is asked rather than dropped.)
      const offline = () => (this.isOpen ? this.ping() : this.setState('offline'));
      const visible = () => ev.document.visibilityState === 'visible' && this.wake();
      ev.window.addEventListener('online', online);
      ev.window.addEventListener('offline', offline);
      ev.document.addEventListener('visibilitychange', visible);
      this.unlisten = () => {
        ev.window.removeEventListener('online', online);
        ev.window.removeEventListener('offline', offline);
        ev.document.removeEventListener('visibilitychange', visible);
      };
    }
  }

  get link() {
    return this.state;
  }

  get isOpen() {
    return this.ws?.readyState === OPEN;
  }

  open() {
    if (this.done || this.ws) return;
    if (!this.d.online()) {
      this.setState('offline');
      return;
    }
    this.setState(this.everOpen ? 'reconnecting' : 'connecting');
    let ws: SocketLike;
    try {
      ws = this.d.socket(this.o.url);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.raw(JSON.stringify(this.o.hello()));
      this.startPings();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.heard();
      if (typeof ev.data !== 'string') return;
      let m: ServerMsg | { t: 'pong' };
      try {
        m = JSON.parse(ev.data) as ServerMsg | { t: 'pong' };
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string' || m.t === 'pong') return;
      if (m.t === 'welcome') {
        this.attempt = 0;
        this.everOpen = true;
        this.setState('open');
      }
      this.o.onMessage(m);
    };
    ws.onerror = () => {
      // (A close follows: the retry is decided there.)
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.dropSocket();
      if (this.done) return;
      if (FINAL_CLOSES.has(ev.code)) {
        this.close(1000, 'closed');
        this.o.onClosed?.(ev.code, ev.reason ?? '');
        return;
      }
      this.schedule();
    };
  }

  /** Send a message; false when there is no open socket (an intent then waits for the user to act again). */
  send(m: ClientMsg): boolean {
    const text = JSON.stringify(m);
    // (The server reads no longer frame; nothing the client sends should come near it.)
    if (text.length > MAX_FRAME) return false;
    return this.raw(text);
  }

  private raw(text: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Drop this socket and start again at once (a view that no longer matches the room's, a dead link). */
  resume() {
    if (this.done) return;
    const ws = this.ws;
    this.dropSocket();
    try {
      ws?.close(4000, 'resume');
    } catch {
      /* already gone */
    }
    this.attempt = 0;
    this.open();
  }

  /** Close for good (leaving, or the server refused this client). */
  close(code = 1000, reason = 'leave') {
    this.done = true;
    const ws = this.ws;
    this.dropSocket();
    if (this.retry !== null) this.d.clearTimeout(this.retry);
    this.retry = null;
    this.unlisten?.();
    this.unlisten = null;
    try {
      ws?.close(code, reason);
    } catch {
      /* already gone */
    }
    this.setState('closed');
  }

  /** The phone woke or the network came back: a missing socket is tried at once, a live one is asked for a word. */
  private wake() {
    if (this.done) return;
    if (!this.ws) {
      if (this.retry !== null) this.d.clearTimeout(this.retry);
      this.retry = null;
      this.attempt = 0;
      this.open();
    } else if (this.isOpen) this.ping();
  }

  private schedule() {
    if (this.done || this.retry !== null) return;
    if (!this.d.online()) {
      // (No network: 'online' brings it back, without spending attempts meanwhile.)
      this.setState('offline');
      return;
    }
    this.setState(this.everOpen ? 'reconnecting' : 'connecting');
    const wait = backoff(this.attempt++, this.d.random);
    this.retry = this.d.setTimeout(() => {
      this.retry = null;
      this.open();
    }, wait);
  }

  private startPings() {
    if (this.pinger !== null) this.d.clearInterval(this.pinger);
    this.pinger = this.d.setInterval(() => this.ping(), PING_EVERY_MS);
  }

  private ping() {
    if (!this.raw('{"t":"ping"}') || this.pongDue !== null) return;
    // No word back in time: the socket is dead whatever it says, and is replaced.
    this.pongDue = this.d.setTimeout(() => {
      this.pongDue = null;
      this.resume();
    }, PONG_WAIT_MS);
  }

  /** Anything from the server shows the socket alive. */
  private heard() {
    if (this.pongDue !== null) this.d.clearTimeout(this.pongDue);
    this.pongDue = null;
  }

  private dropSocket() {
    const ws = this.ws;
    if (ws) ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    this.ws = null;
    if (this.pinger !== null) this.d.clearInterval(this.pinger);
    this.pinger = null;
    this.heard();
  }

  private setState(s: LinkState) {
    if (this.done && s !== 'closed') return;
    if (s === this.state) return;
    this.state = s;
    this.o.onState(s);
  }
}
