// The local runtime for rooms: one node:sqlite file per room under .data/rooms/, sockets from
// `ws` with per-message deflate, attachments kept on each socket as a Durable Object keeps them,
// the heartbeat answered without the room (as the auto-response does), and each room's single
// alarm kept as a row in its file (so it survives a restart) and run by a timer, which is allowed
// here (the room core itself never sets one).
//
// Rooms nobody is connected to are dropped from memory after a while, as a Durable Object is
// evicted, and rebuilt from their file when next needed: local play exercises rehydration too.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { PING, PONG, ROOM_CODE_RE } from '../../src/net/protocol';
import type { RoomRuntime, RoomServices, RoomSocket, ServerEnv } from '../core/ports';
import { Room } from '../room/room';
import type { RoomDirectory } from '../services';
import { NodeSql } from './sql';

/** A `ws` socket as the room holds it. */
export class NodeSocket implements RoomSocket {
  private attachment: string | null = null;
  constructor(readonly ws: WebSocket) {}

  send(data: string) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(code?: number, reason?: string) {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason?.slice(0, 120));
  }

  serializeAttachment(value: unknown) {
    const s = JSON.stringify(value ?? null);
    if (s.length > 2048) throw new Error('An attachment holds at most 2 KB.');
    this.attachment = s;
  }

  deserializeAttachment(): unknown {
    return this.attachment === null ? null : JSON.parse(this.attachment);
  }
}

class NodeRoomRuntime implements RoomRuntime {
  readonly sql: NodeSql;
  readonly socks = new Set<NodeSocket>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly code: string,
    private file: string,
    private host: RoomHost,
  ) {
    this.sql = new NodeSql(file);
    this.sql.exec('CREATE TABLE IF NOT EXISTS _runtime(k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    const at = this.getAlarm();
    if (at !== null) this.arm(at);
  }

  get env(): ServerEnv {
    return this.host.env;
  }

  get services(): RoomServices {
    return this.host.services();
  }

  sockets(tag?: string): RoomSocket[] {
    return tag ? [] : [...this.socks];
  }

  tagsOf(): string[] {
    return [];
  }

  setAlarm(at: number) {
    this.sql.exec('INSERT INTO _runtime(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', 'alarm', at);
    this.arm(at);
  }

  getAlarm(): number | null {
    const r = this.sql.exec<{ v: number }>('SELECT v FROM _runtime WHERE k = ?', 'alarm').toArray();
    return r.length ? r[0].v : null;
  }

  deleteAlarm() {
    this.sql.exec('DELETE FROM _runtime WHERE k = ?', 'alarm');
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(at: number) {
    if (this.timer) clearTimeout(this.timer);
    // (Timers hold at most ~24.8 days; a later alarm re-arms when this one fires.)
    const ms = Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (Date.now() < at) return this.arm(at);
      this.sql.exec('DELETE FROM _runtime WHERE k = ?', 'alarm');
      void this.host.ring(this.code);
    }, ms);
    this.timer.unref?.();
  }

  deleteAll() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sql.close();
    rmSync(this.file, { force: true });
    rmSync(`${this.file}-journal`, { force: true });
    this.host.forget(this.code);
  }

  now() {
    return Date.now();
  }

  random(n: number): Uint8Array {
    return new Uint8Array(randomBytes(n));
  }

  waitUntil(p: Promise<unknown>) {
    p.catch(() => undefined);
  }

  /** Drop the timer (the host is shutting down, or the room is evicted and keeps its alarm row). */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Every room this process hosts: made on demand, evicted when idle, woken by their alarms. */
export class RoomHost implements RoomDirectory {
  private rooms = new Map<string, { rt: NodeRoomRuntime; room: Room; idleSince: number | null }>();
  private wss = new WebSocketServer({
    noServer: true,
    // (Context takeover both ways, as Cloudflare negotiates: small messages compress to a few bytes.)
    perMessageDeflate: { threshold: 32, zlibDeflateOptions: { level: 6 } },
    maxPayload: 64 * 1024,
  });
  private sweeper: ReturnType<typeof setInterval>;
  /** Shut down: the sockets it closes on the way out are no news to rooms whose files are closed. */
  private shut = false;

  constructor(
    private dir: string,
    readonly env: ServerEnv,
    readonly services: () => RoomServices,
    private evictAfterMs = 5 * 60_000,
  ) {
    mkdirSync(dir, { recursive: true });
    // Rooms with an alarm come back after a restart (their files say when).
    for (const f of readdirSync(dir)) {
      const code = f.replace(/\.sqlite$/, '');
      if (f.endsWith('.sqlite') && ROOM_CODE_RE.test(code)) {
        const rt = new NodeRoomRuntime(code, join(dir, f), this);
        if (rt.getAlarm() === null) rt.sql.close();
        // (Its timer, if any, holds the runtime; the room itself is made when it rings.)
      }
    }
    this.sweeper = setInterval(() => this.evict(), 30_000);
    this.sweeper.unref?.();
  }

  private file(code: string) {
    return join(this.dir, `${code}.sqlite`);
  }

  /** The room for a code: made (from its file, or fresh when `create`), or null when there is none. */
  get(code: string, create = false) {
    let e = this.rooms.get(code);
    if (e) return e;
    if (!ROOM_CODE_RE.test(code)) return null;
    if (!create && !existsSync(this.file(code))) return null;
    const rt = new NodeRoomRuntime(code, this.file(code), this);
    e = { rt, room: new Room(rt), idleSince: null };
    this.rooms.set(code, e);
    return e;
  }

  forget(code: string) {
    const e = this.rooms.get(code);
    if (e) for (const s of e.rt.socks) s.close(4410, 'This room has closed.');
    this.rooms.delete(code);
  }

  async ring(code: string) {
    const e = this.get(code);
    if (e) await e.room.alarm().catch((err) => console.warn(JSON.stringify({ ev: 'alarmError', room: code, error: String(err?.message ?? err).slice(0, 160) })));
  }

  async fetch(code: string, path: string, init?: RequestInit): Promise<Response> {
    const e = this.get(code, path === 'init');
    if (!e) return new Response(JSON.stringify({ error: 'No such room.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const r = await e.room.fetch(new Request(`http://room/${path}`, init));
    // (A room asked about that turned out not to exist leaves no file behind.)
    if (path === 'init' && r.status !== 201 && r.status !== 409) this.drop(code);
    return r;
  }

  private drop(code: string) {
    const e = this.rooms.get(code);
    if (!e || e.rt.socks.size) return;
    e.rt.stop();
    e.rt.sql.close();
    this.rooms.delete(code);
    rmSync(this.file(code), { force: true });
  }

  /** A socket upgrade for a room (the origin was checked by the caller). */
  async upgrade(code: string, req: IncomingMessage, socket: Duplex, head: Buffer) {
    const e = this.get(code);
    const refuse = (status: number, error: string) => {
      socket.write(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Unavailable'}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ error })}`);
      socket.destroy();
    };
    if (!e) return refuse(404, 'No such room.');
    const ok = await e.room.admit();
    if (!ok.ok) return refuse(ok.status, ok.error);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const s = new NodeSocket(ws);
      e.rt.socks.add(s);
      e.idleSince = null;
      e.room.opened(s);
      ws.on('message', (data, binary) => {
        if (binary) {
          void e.room.webSocketMessage(s, new Uint8Array(data as Buffer).buffer as ArrayBuffer);
          return;
        }
        const text = data.toString();
        // The heartbeat never reaches the room (Cloudflare's auto-response).
        if (text === PING) return s.send(PONG);
        void e.room.webSocketMessage(s, text).catch(() => undefined);
      });
      ws.on('close', (code, reason) => {
        e.rt.socks.delete(s);
        if (this.shut) return;
        if (!e.rt.socks.size) e.idleSince = Date.now();
        void e.room.webSocketClose(s, code, reason.toString(), true).catch(() => undefined);
      });
      ws.on('error', () => undefined);
    });
  }

  /** Rooms nobody is connected to leave memory (their alarms stay armed and bring them back). */
  private evict() {
    const now = Date.now();
    for (const [code, e] of this.rooms) {
      if (e.rt.socks.size || e.idleSince === null || now - e.idleSince < this.evictAfterMs) continue;
      this.rooms.delete(code);
      if (e.rt.getAlarm() === null) {
        e.rt.stop();
        e.rt.sql.close();
      }
    }
  }

  close() {
    this.shut = true;
    clearInterval(this.sweeper);
    for (const e of this.rooms.values()) {
      // (What the sockets carry goes with them: into the room's file first.)
      try {
        e.room.flushNow();
      } catch (err) {
        console.warn(JSON.stringify({ ev: 'flushError', room: e.rt.code, error: String((err as Error)?.message ?? err).slice(0, 160) }));
      }
      for (const s of e.rt.socks) s.close(1001, 'The server is restarting.');
      e.rt.stop();
      e.rt.sql.close();
    }
    this.rooms.clear();
    this.wss.close();
  }
}
