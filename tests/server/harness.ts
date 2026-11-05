// A room on a test runtime: node:sqlite in memory, fake sockets, a fake clock that drives the
// alarm, seeded randomness (so a run can be repeated exactly), and clients that play as people
// would, deciding with the bots' own logic on nothing but their own view (inflateView of the
// patched WireView) and submitting through `act`.

import * as zlib from 'node:zlib';
import { applyPatch, inflateView, viewHash, type WireView } from '../../src/engine/wire';
import { legalActions, type Action, type GameState, type PlayerId } from '../../src/engine';
import { botDecide, cloneMemory, createBotMemory, type BotMemory } from '../../src/engine/ai';
import { PROTO, type ClientMsg, type GameRecord, type RoomInfo, type ServerMsg } from '../../src/net/protocol';
import type { BlobStore, RoomRuntime, RoomSocket, ServerEnv } from '../../server/core/ports';
import { Room, type RoomInit } from '../../server/room/room';
import { createServices, migrate, type Services } from '../../server/services';
import { NodeServiceDb, NodeSql } from '../../server/node/sql';

/** A small seeded generator (mulberry32) for the runtime's "cryptographic" bytes: tests repeat exactly. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
    return out;
  };
}

export class FakeSocket implements RoomSocket {
  private attachment: string | null = null;
  inbox: ServerMsg[] = [];
  closed: { code?: number; reason?: string } | null = null;
  bytes = 0;
  constructor(private onClose: (s: FakeSocket) => void) {}

  send(data: string) {
    if (this.closed) return;
    this.bytes += Buffer.byteLength(data);
    this.inbox.push(JSON.parse(data) as ServerMsg);
    this.raw.push(data);
  }
  /** Every frame as sent. */
  raw: string[] = [];

  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.onClose(this);
  }

  /** The connection is cut and the room never hears (its process died): the attachment goes with it. */
  drop() {
    this.closed = { code: 1006, reason: 'dropped' };
    this.attachment = null;
  }

  /** What this socket's attachment may hold (the platform's 2 KB; a test may make it less). */
  limit = 2048;

  serializeAttachment(v: unknown) {
    const s = JSON.stringify(v ?? null);
    if (s.length > this.limit) throw new Error('attachment too large');
    this.attachment = s;
  }

  deserializeAttachment() {
    return this.attachment === null ? null : JSON.parse(this.attachment);
  }

  take(): ServerMsg[] {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }
}

class MemoryBlobs implements BlobStore {
  m = new Map<string, Uint8Array>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: Uint8Array) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

export const ENV: ServerEnv = { PUBLIC_URL: 'http://localhost:5173', TOKEN_SECRET: 'ab'.repeat(32), BUILD: 'test' };

export class TestRuntime implements RoomRuntime {
  sql = new NodeSql(':memory:');
  socks: FakeSocket[] = [];
  alarmAt: number | null = null;
  alarmsSet = 0;
  deletes = 0;
  /** Rows deleteAll() took with it (Cloudflare bills a deleted row as a row written). */
  rowsDeleted = 0;
  /** What the databases wiped by deleteAll() had written (the room's rows over its whole life are these and sql's). */
  private wiped = { rows: 0, by: new Map<string, number>() };
  pending: Promise<unknown>[] = [];
  constructor(
    readonly code: string,
    private world: World,
  ) {}
  get env() {
    return ENV;
  }
  get services() {
    return this.world.services;
  }
  sockets() {
    return this.socks.filter((s) => !s.closed);
  }
  tagsOf() {
    return [];
  }
  setAlarm(at: number) {
    this.alarmAt = at;
    this.alarmsSet++;
  }
  getAlarm() {
    return this.alarmAt;
  }
  deleteAlarm() {
    this.alarmAt = null;
  }
  deleteAll() {
    this.deletes++;
    if (this.sql.isOpen) {
      for (const { name } of this.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray()) {
        this.rowsDeleted += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`).one().n;
      }
    }
    this.wiped.rows += this.sql.rowsWritten;
    for (const [k, v] of this.sql.writesBy) this.wiped.by.set(k, (this.wiped.by.get(k) ?? 0) + v);
    this.alarmAt = null;
    this.sql.close();
    this.sql = new NodeSql(':memory:');
  }
  now() {
    return this.world.now;
  }
  random(n: number) {
    return this.world.random(n);
  }
  waitUntil(p: Promise<unknown>) {
    this.pending.push(p.catch(() => undefined));
  }
  /** Rows written over the room's whole life (through any deleteAll), in all and by table and purpose. */
  written(): { rows: number; by: Map<string, number> } {
    const by = new Map(this.wiped.by);
    for (const [k, v] of this.sql.writesBy) by.set(k, (by.get(k) ?? 0) + v);
    return { rows: this.wiped.rows + this.sql.rowsWritten, by };
  }
}

/** The server side of a test: services, rooms by code, the clock. */
export class World {
  now = 1_800_000_000_000;
  random: (n: number) => Uint8Array;
  db = new NodeServiceDb(':memory:');
  blobs = new MemoryBlobs();
  services!: Services;
  rooms = new Map<string, { rt: TestRuntime; room: Room }>();

  constructor(seed = 1) {
    this.random = seeded(seed);
  }

  async init() {
    await migrate(this.db);
    this.services = createServices({
      db: this.db,
      blobs: this.blobs,
      env: ENV,
      now: () => this.now,
      random: (n) => this.random(n),
      rooms: { fetch: (code, path, init) => this.fetch(code, path, init) },
    });
    return this;
  }

  entry(code: string) {
    let e = this.rooms.get(code);
    if (!e) {
      const rt = new TestRuntime(code, this);
      e = { rt, room: new Room(rt) };
      this.rooms.set(code, e);
    }
    return e;
  }

  async fetch(code: string, path: string, init?: RequestInit) {
    return this.entry(code).room.fetch(new Request(`http://room/${path}`, init));
  }

  async guest(name: string) {
    return this.services.guest(name);
  }

  async createRoom(token: string, init: Omit<RoomInit, 'host'> = {}) {
    const who = (await this.services.identify(token))!;
    const { code } = await this.services.createRoom({ host: { user: who.user, name: who.name }, ...init });
    return code;
  }

  /** Drop a room's object (as the platform evicts it) and build it again from its storage and its sockets' attachments; sockets stay. */
  async evict(code: string) {
    const e = this.rooms.get(code)!;
    e.room = new Room(e.rt);
    await e.room.ready;
    return e.room;
  }

  /**
   * The room's process dies (a crash, a deploy): every socket is cut without the room hearing, its
   * attachment gone with it, and the room is built again from storage alone (its alarm kept).
   */
  async crash(code: string) {
    const e = this.rooms.get(code)!;
    await this.settle(code);
    for (const s of e.rt.socks) s.drop();
    e.room = new Room(e.rt);
    await e.room.ready;
    return e.room;
  }

  async connect(code: string, hello: Omit<Extract<ClientMsg, { t: 'hello' }>, 't' | 'proto' | 'build'>) {
    const e = this.entry(code);
    const sock: FakeSocket = new FakeSocket((s) => {
      e.rt.pending.push(this.rooms.get(code)!.room.webSocketClose(s, s.closed?.code ?? 1000, '', true));
    });
    const ok = await e.room.admit();
    if (!ok.ok) throw new Error(ok.error);
    e.rt.socks.push(sock);
    e.room.opened(sock);
    await this.send(code, sock, { t: 'hello', proto: PROTO, build: 'test', ...hello });
    return sock;
  }

  async send(code: string, sock: FakeSocket, msg: ClientMsg | string) {
    const e = this.rooms.get(code)!;
    await e.room.webSocketMessage(sock, typeof msg === 'string' ? msg : JSON.stringify(msg));
    await this.settle(code);
  }

  async settle(code: string) {
    const e = this.rooms.get(code)!;
    while (e.rt.pending.length) await e.rt.pending.shift();
  }

  /** Move the clock on by `ms`, ringing the alarm whenever it falls due. */
  async advance(code: string, ms: number) {
    const e = this.rooms.get(code)!;
    const until = this.now + ms;
    for (let i = 0; i < 1000; i++) {
      const at = e.rt.alarmAt;
      if (at === null || at > until) break;
      this.now = Math.max(this.now, at);
      e.rt.alarmAt = null;
      await e.room.alarm();
      await this.settle(code);
    }
    this.now = until;
  }
}

/** A person at the table, played by the bots' logic on its own view only. */
export class Client {
  view: WireView | null = null;
  seq = -1;
  room: RoomInfo | null = null;
  you: Extract<ServerMsg, { t: 'welcome' }>['you'] | null = null;
  mem: BotMemory = createBotMemory({ waitForHumans: true });
  n = 0;
  outstanding: { n: number; at: number; a: Action; mem: BotMemory } | null = null;
  hashChecks = 0;
  records: GameRecord[] = [];
  nacks: Extract<ServerMsg, { t: 'nack' }>[] = [];
  notices: Extract<ServerMsg, { t: 'notice' }>[] = [];
  reveal: Extract<ServerMsg, { t: 'reveal' }> | null = null;
  snaps = 0;
  batches = 0;
  errors: string[] = [];
  lastRefused: string | null = null;
  timers: unknown = null;
  /** Off: the client stops deciding (a person gone quiet). */
  playing = true;

  constructor(
    public sock: FakeSocket,
    public seat: PlayerId | null,
  ) {}

  get state(): GameState | null {
    return this.view ? inflateView(this.view, this.seat) : null;
  }

  /** Read everything that arrived. */
  read() {
    for (const m of this.sock.take()) this.on(m);
  }

  on(m: ServerMsg) {
    switch (m.t) {
      case 'welcome':
        this.you = m.you;
        this.room = m.room;
        if (m.you.ackN) this.n = Math.max(this.n, m.you.ackN);
        return;
      case 'room':
        this.room = m.room;
        return;
      case 'snap':
        this.snaps++;
        this.view = m.view;
        this.seq = m.seq;
        if (viewHash(m.view) !== m.hash) this.errors.push(`snap hash at ${m.seq}`);
        if (m.ackN !== undefined) this.ack(m.ackN);
        return;
      case 'g':
        return this.apply(m);
      case 'gb':
        this.batches++;
        for (const r of m.list) this.apply(r);
        return;
      case 'nack':
        this.nacks.push(m);
        if (this.outstanding && m.n === this.outstanding.n) {
          if (m.code === 'rule') this.lastRefused = `${this.seq}|${JSON.stringify(this.outstanding.a)}`;
          this.outstanding = null;
        }
        if (m.ackN !== undefined) this.ack(m.ackN);
        return;
      case 'notice':
        this.notices.push(m);
        return;
      case 'reveal':
        this.reveal = m;
        return;
      case 'timers':
        this.timers = m.timers;
        return;
      case 'error':
        if (m.code !== 'slow') this.errors.push(`${m.code}: ${m.error}`);
        return;
    }
  }

  private ack(n: number) {
    if (this.outstanding && n >= this.outstanding.n) {
      this.mem = this.outstanding.mem;
      this.outstanding = null;
    }
  }

  private apply(r: GameRecord) {
    if (!this.view) return void this.errors.push(`record ${r.seq} before a view`);
    if (r.seq <= this.seq) return;
    if (r.seq !== this.seq + 1) return void this.errors.push(`gap: ${this.seq} then ${r.seq}`);
    this.view = applyPatch(this.view, r.p);
    this.seq = r.seq;
    this.records.push(r);
    if (r.timers) this.timers = r.timers;
    if (r.h !== undefined) {
      this.hashChecks++;
      if (viewHash(this.view) !== r.h) this.errors.push(`hash at ${r.seq}`);
    }
    if (r.ackN !== undefined) this.ack(r.ackN);
  }

  private seenSent = -1;

  /** Tell the room this client has presented up to its seq (a real client's `seen`), when that moved on. */
  async sendSeen(t: TestTable) {
    if (this.seat === null || this.sock.closed || this.seq <= this.seenSent) return;
    this.seenSent = this.seq;
    await t.world.send(t.code, this.sock, { t: 'seen', seq: this.seq });
    this.read();
  }

  /** The intent this person would send now, if any. */
  decide(): Extract<ClientMsg, { t: 'act' }> | null {
    if (!this.playing || this.outstanding || this.seat === null || !this.view) return null;
    const s = this.state!;
    if (s.phase === 'gameOver') return null;
    const mem = cloneMemory(this.mem);
    let a = botDecide(s, this.seat, mem, 'normal');
    if (!a) return null;
    // (Refused just now at this very seq: something safe instead, so a client never loops.)
    if (this.lastRefused === `${this.seq}|${JSON.stringify(a)}`) {
      const legal = legalActions(s, this.seat);
      a = legal.find((x) => x.type === 'endTurn') ?? legal.find((x) => x.type === 'respondTrade' && !x.accept) ?? legal[0] ?? null;
      if (!a) return null;
    }
    const n = ++this.n;
    this.outstanding = { n, at: this.seq, a, mem };
    return { t: 'act', n, at: this.seq, a };
  }
}

/** permessage-deflate's size for a socket's messages: one deflate stream with context takeover, a sync flush per message, less the 4-byte marker it strips. */
export async function deflatedSize(messages: string[]): Promise<number> {
  const z = zlib.createDeflateRaw({ level: 6 });
  let size = 0;
  z.on('data', (c: Buffer) => (size += c.length));
  for (const m of messages) {
    z.write(Buffer.from(m));
    await new Promise<void>((done) => z.flush(zlib.constants.Z_SYNC_FLUSH, () => done()));
  }
  await new Promise<void>((done) => z.end(() => done()));
  return size - 4 * messages.length;
}

// ------------------------------------------------------------------ whole tables

export interface TestTable {
  world: World;
  code: string;
  clients: Client[];
  tokens: string[];
}

/** A room with `humans` people in the first seats (each having sent a nonce), bots in the rest, started. */
export async function startTable(o: { seed: number; humans: number; seats?: 3 | 4; settings?: Partial<import('../../src/net/protocol').RoomSettings> }): Promise<TestTable> {
  const world = await new World(o.seed).init();
  const tokens: string[] = [];
  for (let i = 0; i < o.humans; i++) tokens.push((await world.guest(`Person ${i}`)).token);
  const code = await world.createRoom(tokens[0], { settings: { seats: o.seats ?? 4, ...(o.settings ?? {}) } });
  const clients: Client[] = [];
  for (let i = 0; i < o.humans; i++) {
    const sock = await world.connect(code, { token: tokens[i] });
    const c = new Client(sock, i);
    clients.push(c);
    await world.send(code, sock, { t: 'claim', seat: i });
    await world.send(code, sock, { t: 'entropy', nonce: `nonce-of-seat-${i}-${o.seed}`.padEnd(20, 'x') });
    if (i > 0) await world.send(code, sock, { t: 'ready', on: true });
  }
  await world.send(code, clients[0].sock, { t: 'start' });
  for (const c of clients) c.read();
  return { world, code, clients, tokens };
}

/** The server's own state of a room's game (for checks only). */
export function serverState(t: TestTable): GameState {
  const room = t.world.rooms.get(t.code)!.room as unknown as { table: { state: GameState; views: Map<unknown, WireView> } };
  return room.table.state;
}

/**
 * How many of the game's actions storage holds right now (the journal's closed turns and the turn
 * under way as it was last written): what a crash would come back to.
 */
export function storedActions(t: TestTable): number {
  const rows = t.world.rooms.get(t.code)!.rt.sql.exec<{ body: string }>('SELECT body FROM chunks ORDER BY id').toArray();
  let n = 0;
  const count = (entries: object[]) => entries.filter((e) => 'p' in e).length;
  for (const r of rows) for (const [, entries] of (JSON.parse(r.body) as { turns: [number, object[]][] }).turns) n += count(entries);
  const last = rows.at(-1);
  const open = last ? (JSON.parse(last.body) as { open?: { entries: object[] } }).open : undefined;
  return n + count(open?.entries ?? []);
}

export function serverView(t: TestTable, seat: PlayerId): WireView {
  const room = t.world.rooms.get(t.code)!.room as unknown as { table: { views: Map<unknown, WireView> } };
  return room.table.views.get(seat)!;
}

/**
 * Play on: each person decides in turn, a few seconds of thought each, until the game is over or
 * `until` says stop. Returns the number of steps taken.
 */
export async function play(t: TestTable, o: { thinkMs?: number; maxSteps?: number; until?: (step: number) => boolean | Promise<boolean>; seen?: boolean } = {}): Promise<number> {
  const think = o.thinkMs ?? 3000;
  let idle = 0;
  for (let step = 0; step < (o.maxSteps ?? 6000); step++) {
    for (const c of t.clients) c.read();
    // (As a browser does: `seen` once its presenter has shown what came.)
    if (o.seen) for (const c of t.clients) await c.sendSeen(t);
    if (serverState(t).phase === 'gameOver') return step;
    if (o.until && (await o.until(step))) return step;
    let acted = false;
    for (const c of t.clients) {
      if (c.sock.closed) continue;
      const a = c.decide();
      if (!a) continue;
      await t.world.send(t.code, c.sock, a);
      for (const x of t.clients) x.read();
      await t.world.advance(t.code, think);
      acted = true;
    }
    if (acted) idle = 0;
    else {
      await t.world.advance(t.code, think);
      if (++idle > 400) throw new Error(`stuck at seq ${serverState(t).seq} (${serverState(t).phase})`);
    }
  }
  return o.maxSteps ?? 6000;
}
