// A room as a Durable Object: the platform-free Room over ctx.storage.sql, hibernatable sockets
// (ctx.acceptWebSocket, never ws.accept), the heartbeat as an auto-response (pings never wake the
// room), the single storage alarm, and attachments for per-socket routing. Written, not wired:
// see README.md for the wrangler config that would bind it.

import { PING, PONG } from '../../src/net/protocol';
import type { RoomRuntime, RoomServices, RoomSocket, RoomSql, ServerEnv, SqlCursor, SqlValue } from '../core/ports';
import { Room } from '../room/room';
import { serverEnv, toBinding, workerServices } from './adapter';
import type { CfDurableObjectState, CfGlobals, CfWebSocket, WorkerEnv } from './types';

const cf = globalThis as unknown as CfGlobals;

class DoSql implements RoomSql {
  constructor(private ctx: CfDurableObjectState) {}

  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
    return this.ctx.storage.sql.exec<T>(query, ...bindings.map(toBinding));
  }
}

class DoRuntime implements RoomRuntime {
  readonly sql: RoomSql;
  readonly env: ServerEnv;
  services!: RoomServices;
  /** The alarm as last set (the storage API is asynchronous; the room asks synchronously). */
  private alarm: number | null = null;
  private name: string | null = null;

  constructor(
    private ctx: CfDurableObjectState,
    private workerEnv: WorkerEnv,
  ) {
    this.sql = new DoSql(ctx);
    this.env = serverEnv(workerEnv);
  }

  async init() {
    this.services = (await workerServices(this.workerEnv)).services;
    this.alarm = await this.ctx.storage.getAlarm();
    // (A room woken by a socket or its alarm has no header to say its code: its own record does.)
    this.name = this.ctx.id.name ?? null;
    if (!this.name) {
      const sql = this.ctx.storage.sql;
      const made = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
      const row = made ? sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'room'").toArray()[0] : undefined;
      this.name = row ? ((JSON.parse(row.v) as { code?: string }).code ?? null) : null;
    }
  }

  /** The room's code, from the Worker's header (it names the object: idFromName(code)). */
  learn(code: string | null) {
    if (code && !this.name) this.name = code;
  }

  get code() {
    return this.name ?? '';
  }

  sockets(tag?: string): RoomSocket[] {
    return this.ctx.getWebSockets(tag);
  }

  tagsOf(socket: RoomSocket): string[] {
    return this.ctx.getTags(socket as CfWebSocket);
  }

  setAlarm(at: number) {
    this.alarm = at;
    // (Not awaited: the output gate holds what the room sends until the write is confirmed.)
    void this.ctx.storage.setAlarm(at);
  }

  getAlarm() {
    return this.alarm;
  }

  deleteAlarm() {
    this.alarm = null;
    void this.ctx.storage.deleteAlarm();
  }

  deleteAll() {
    this.alarm = null;
    void this.ctx.storage.deleteAll();
    this.name = null;
  }

  /** The alarm rang (the platform cleared it). */
  rang() {
    this.alarm = null;
  }

  now() {
    return Date.now();
  }

  random(n: number) {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  }

  waitUntil(p: Promise<unknown>) {
    this.ctx.waitUntil(p);
  }
}

export class RoomDO {
  private rt: DoRuntime;
  private room!: Room;

  constructor(
    private ctx: CfDurableObjectState,
    env: WorkerEnv,
  ) {
    this.rt = new DoRuntime(ctx, env);
    // Pings are answered by the runtime itself: they neither wake the room nor bill it.
    ctx.setWebSocketAutoResponse(new cf.WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      await this.rt.init();
      this.room = new Room(this.rt);
      await this.room.ready;
    });
  }

  async fetch(req: Request): Promise<Response> {
    this.rt.learn(req.headers.get('x-room-code'));
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const ok = await this.room.admit();
      if (!ok.ok) return new Response(JSON.stringify({ error: ok.error }), { status: ok.status, headers: { 'content-type': 'application/json' } });
      const pair = new cf.WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      this.room.opened(server);
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: CfWebSocket });
    }
    return this.room.fetch(req);
  }

  webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer) {
    return this.room.webSocketMessage(ws, message);
  }

  webSocketClose(ws: CfWebSocket, code: number, reason: string, wasClean: boolean) {
    return this.room.webSocketClose(ws, code, reason, wasClean);
  }

  webSocketError(ws: CfWebSocket, error: unknown) {
    return this.room.webSocketError(ws, error);
  }

  alarm() {
    this.rt.rang();
    return this.room.alarm();
  }
}
