// A room: the harbour (lobby) where seats are taken and settings chosen, then the game, played
// on the server, each seat sent only what it may see. Platform-free: it runs over a RoomRuntime
// (server/core/ports.ts), on a Durable Object or locally on node:sqlite, and may be evicted and
// rebuilt from its storage at any moment.
//
// Every entry point (a request, a socket's message or close, the alarm) runs through one queue,
// so a handler that awaits (an identity lookup, a hash, the replay's upload) sees the room as it
// left it. A handler collects what it sends in an outbox: the game records each viewer gets (one
// `g`, or one `gb` for a run), then everything else; it persists before it sends, then sets the
// single alarm.
//
// What a room keeps, and where (rows written are the bill: see store.ts and docs/online/COSTS.md):
// storage has the room, its seats, every closed turn (a journal of chunks), a checkpoint every 25
// turns and the chat; the turn under way, the clocks and counters, chat lines not yet in their row
// and a harbour's changing seats ride in the sockets' attachments (`k`, the carry), which survive
// the room sleeping and cost nothing. They reach storage when a turn ends, when the turn under way
// shows something drawn or hidden, when the room's last socket closes, or when the carry doesn't
// fit. A crash of the room (rare on Cloudflare; a deploy is one too) loses only the carry: the
// quiet moves since the last reveal, a few chat lines, harbour seats taken since the last flush.
// The room comes back at the last thing stored with every socket gone, so each client resyncs by
// snapshot; and since no reveal is sent before it's stored, nobody can have seen a roll or a card
// that the rollback takes back (the keyed dice would redraw the same, but only what was kept).

import { cardKinds, type Action, type Card, type GameEvent, type GameState, type PlayerId } from '../../src/engine';
import type { BotDifficulty } from '../../src/engine/ai';
import { eventsFor } from '../../src/engine/visibility';
import { viewHash } from '../../src/engine/wire';
import type { CustomMap } from '../../src/engine/maps/custom';
import { avatarOf, pickCrew } from '../../src/game/names';
import {
  AFK_EXPIRIES, AFK_GONE_MS, BOT_THINK_MAX, BOT_THINK_MIN, CHAT_BURST, CHAT_KEEP, CHAT_MAX, HAIL_AFTER_MS, HARBOUR_IDLE_MS, NAME_MAX, NUDGE_GAP_MS, OVER_KEEP_MS, PING, PONG, PROTO,
  RATE_BURST, RATE_PER_SECOND, REACT_GAP_MS, RESYNC_BATCH_MAX, SEEN_CAP_MS,
  type ChatLine, type ClientMsg, type GameRecord, type NackCode, type NoticeKind, type Results, type RoomInfo, type RoomPhase, type RoomSettings, type SeatInfo, type SeatKind, type ServerMsg, type Timers,
} from '../../src/net/protocol';
import { b64url, diceCommit, fromB64url, gameKey, gunzip, gzip, hmacSha256, newKey, NONCE_RE, randomUint32, sameBytes, fromHex } from '../../src/net/codes';
import { COLOR_RE, parseClientFrame } from '../../src/net/schema';
import type { FinishedGame, NoteKind, RoomRuntime, RoomSocket } from '../core/ports';
import { emptyClocks, expired, nextClocks, nextDue, owed, release, sameTimers, timersView, type Clock, type ClockState } from './clock';
import { islandName, momentOf, moveNote, overNote } from './notes';
import { DEFAULT_SETTINGS, applySettings, checkRoomMap, gameOptions } from './settings';
import { CHECKPOINT_EVERY, RoomStore, chunkSealed, isAction, type ChunkCheckpoint, type JournalBody, type LogEntry } from './store';
import { Table, forcedRoll, reveals, type ViewKey } from './table';
import { RoomTalk } from './talk';

// ------------------------------------------------------------------ tuning

/**
 * The rolling chat row is rewritten once this many lines wait for it: in the harbour and after the
 * game, CHAT_FLUSH_LINES (the lines ride the sockets until then); while the game is under way the
 * journal, written about once a turn, carries them, so the row waits for CHAT_TAIL_MAX.
 */
export const CHAT_FLUSH_LINES = 10;
export const CHAT_TAIL_MAX = 50;
/** What a socket's attachment may hold (Cloudflare's limit for serializeAttachment; ports.ts). */
export const ATTACHMENT_MAX = 2048;
/** The alarm isn't moved earlier for less than this (a clock may run out this much late; the next person's often ends a moment before the last one's). */
export const ALARM_SLACK_MS = 3000;

/** A bot run stops after this many moves (the rest follows on the alarm, once these are presented). */
export const BOT_RUN_CAP = 40;
/**
 * Added to a batch's waits before a person's clock starts at the latest (the records' own
 * animations): sooner, once everyone at the table has said they've seen them (see release).
 */
export const PRESENT_ALLOWANCE_MS = SEEN_CAP_MS;
/**
 * The game's first clock waits for the island to rise on every screen (each says so with its first
 * `seen`, of the game it began from), this long at most.
 */
export const OPENING_ALLOWANCE_MS = 15_000;
/** A harbour's host who leaves has this long to come back before the next person becomes host. */
export const HOST_GRACE_MS = 60_000;
/** A pause the table voted for ends by itself after this long. */
export const PAUSE_MAX_MS = 10 * 60_000;
/** A live game nobody has been at for this long is abandoned. */
export const ABANDON_MS = 24 * 3_600_000;
/** A hand-off link lasts this long. */
export const HANDOFF_MS = 10 * 60_000;
const MAX_WATCHERS = 32;
const MAX_SOCKETS = 48;
/** Someone back at the table after being gone this long is said to have come aboard again (a blink of the link isn't news). */
const REJOIN_NEWS_MS = 15_000;
const REPORTS_PER_HOUR = 5;
/** Bad frames a socket may send in a minute before it is closed (1008). */
const STRIKES_MAX = 10;
/** Settings whose change makes it another game: the seated are asked to be ready again. */
const READY_AGAIN = new Set<keyof RoomSettings>(['seats', 'preset', 'modules', 'map', 'layout', 'numberPlacement', 'victoryPoints', 'friendlyRobber', 'eventDeck', 'knobs', 'timer', 'rated', 'customMapId']);
const COLORS = ['red', 'blue', 'white', 'orange', 'purple', 'teal', 'rose', 'charcoal'];

// ------------------------------------------------------------------ what a room keeps

export interface SeatState {
  seat: PlayerId;
  kind: SeatKind;
  name: string;
  color: string;
  avatar?: number;
  user?: string;
  handle?: string;
  ready?: boolean;
  difficulty?: BotDifficulty;
  /** The seat's generation: a hand-off bumps it, and sockets of an older one are closed. */
  gen: number;
  /** A bot is playing this person's seat (they went quiet, or left). */
  away?: boolean;
  conceded?: boolean;
  kicked?: boolean;
  /** The seat's entropy for the dice (fair dice: sent after seeing the commitment). */
  nonce?: string | null;
  /** The person's rating tier, its value and Fair winds, as the services know them (services.standing). */
  tier?: string;
  rating?: number;
  reliability?: number;
}

export interface RoomMeta {
  v: 1;
  code: string;
  createdAt: number;
  phase: RoomPhase;
  settings: RoomSettings;
  /** The host's public id. */
  host: string;
  /** The dice key K (hex): secret until the game is over. */
  key: string;
  /** C = SHA-256(prefix + K). */
  commit: string;
  banned: string[];
  /** When the harbour emptied (for closing an idle one). */
  idleSince?: number;
  /** When the host's last tab closed in the harbour (their duties pass on after a grace): kept, since a room asleep forgets. */
  hostGoneAt?: number;
  options?: GameState['options'];
  /** K' = HMAC(K, nonces): the game's RNG key. */
  gameKey?: string;
  startedAt?: number;
  endedAt?: number;
  results?: Results;
  rematch?: string;
  from?: string;
  /** The room's revision when this was stored (a harbour's carry newer than it wins on a rebuild). */
  rev?: number;
}

/** The volatile part of a game: the turn under way and the table's clocks (the journal's newest chunk keeps it; the carry, anything newer). */
interface OpenRow {
  turn: number;
  entries: LogEntry[];
  clocks: ClockState;
  lastN: number[];
  expiries: number[];
  goneAt: (number | null)[];
  allGoneSince: number | null;
  turnSince: { key: string; at: number } | null;
  pause: Pause | null;
  /** What each seat was last told it owes ('live': told once while away from a live table). */
  told?: (string | null)[];
  /**
   * Each seat's Looking for / Spare (SeatInfo.wants): the turn under way's, so it rides with it in
   * the sockets' carry and the journal rather than in a row of its own (it's gone by the end of the
   * speaker's turn anyway).
   */
  wants?: (Wants | null)[];
}

type Wants = { looking: Card[]; spare: Card[] };

interface Pause {
  by: PlayerId;
  votes: PlayerId[];
  at: number;
  /** Enough of the table agreed: the clocks are stopped. */
  on: boolean;
}

/** What a socket carries (it survives the room sleeping). */
interface Attachment {
  v: 1;
  at: number;
  u?: string;
  nm?: string;
  s?: PlayerId | null;
  g?: number;
  w?: boolean;
  /** Quick talk only (the identity says so): free text is neither sent nor shown to this socket. */
  q?: 1;
  /** An account's handle, for the seat it takes. */
  h?: string;
  /** The carry: what the room keeps here rather than in storage, as of revision `r` (every socket holds all of it). */
  k?: CarryWire;
}

/** What rides in the sockets: each part only while storage has an older one. */
interface Carry {
  /** The turn under way, the clocks and the counters. */
  o?: OpenRow;
  /** Chat lines in no row yet. */
  c?: ChatLine[];
  /** The harbour's seats and room, changed since they were stored. */
  s?: SeatState[];
  m?: RoomMeta;
}

/** The carry on a socket: plain, or gzipped (`z`, base64url) when plain doesn't fit. */
type CarryWire = Carry & { r: number; z?: string };

/** What the room keeps about a socket in memory only (lost if the room sleeps, which is fine). */
interface SocketMemo {
  tokens: number;
  refill: number;
  strikes: number[];
  chats: number[];
  nudgedAt: number;
  reports: number[];
  /** The newest record this socket's presenter has shown (its `seen`), and its last reaction. */
  seen: number;
  reactAt: number;
}

/** What POST /init (the room's creation) carries. */
export interface RoomInit {
  host: { user: string; name: string };
  settings?: Partial<RoomSettings>;
  custom?: unknown;
  /** Seats taken from the start ("Sail again": the last table's people and bots). */
  seats?: { seat: number; kind: 'human' | 'bot'; user?: string; name: string; color: string; avatar?: number; difficulty?: BotDifficulty }[];
  from?: string;
}

type Target = 'all' | { seat: PlayerId } | { socket: RoomSocket } | ((a: Attachment) => boolean);

interface Outbox {
  recs: Map<ViewKey, GameRecord[]>;
  msgs: { to: Target; msg: ServerMsg }[];
  wait: number;
  acted: Map<PlayerId, number>;
  /** Nothing but a `seen`: the room changed nothing, so it neither looks at its clocks nor persists. */
  light?: boolean;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Counters a test (or an operator) can read: what this room has cost so far. */
export interface RoomCounters {
  wakes: number;
  alarms: number;
  alarmsSet: number;
  messages: number;
  sent: number;
  sentBytes: number;
  /**
   * Why the journal was written: a turn closed, a reveal in the turn under way, the last socket
   * closed, nobody here to carry it, the carry too big for the sockets, the game's end.
   */
  journal: Record<JournalWhy, number>;
  /** Carries given to the sockets, and of those, gzipped. */
  carries: number;
  squeezed: number;
}

type JournalWhy = 'turn' | 'reveal' | 'flush' | 'alone' | 'big' | 'end';

export class Room {
  private store: RoomStore;
  private meta: RoomMeta | null = null;
  private seats: SeatState[] = [];
  private custom: CustomMap | null = null;
  private table: Table | null = null;
  private talk: RoomTalk | null = null;
  private chat: ChatLine[] = [];
  private open: OpenRow = Room.freshOpen(0, 0);
  /** The journal's newest chunk: its closed turns (all of them, written or not). */
  private journal: { id: number; turns: [number, LogEntry[]][] } = { id: 0, turns: [] };
  /** A turn closed since the journal was written. */
  private journalDue = false;
  /** The turn under way showed something drawn or hidden since the journal was written: it's stored before it's sent. */
  private revealPending = false;
  /** The room's last socket closed: everything carried goes to storage. */
  private flushDue = false;
  /** The room's revision: each write of the journal or the harbour, and each new carry, takes the next. */
  private rev = 0;
  private journalRev = 0;
  /** The open turn as the journal has it (JSON): the carry holds it only once it has moved on. */
  private storedOpen: string | null = null;
  /** How many of the turn's entries are stored (or will be, as this handler ends). */
  private storedEntries = 0;
  /** The last chat line in the chat row, and the last in the journal's tail. */
  private chatStored = 0;
  private chatJournaled = 0;
  /** The harbour's seats or room changed since they were stored (they ride in the carry until a flush or the start). */
  private harbourDirty = false;
  /** The room's row as stored (JSON, without its revision), so an unchanged one is never written again. */
  private roomStored: string | null = null;
  /** The carry as last given to the sockets (JSON, without its revision), and its revision. */
  private carried: string | null = null;
  private carryRev = 0;
  /**
   * After a rebuild, clocks the open row didn't have start from the table's last move rather than
   * from now (the turn began then): a room woken by its alarm still times the seat out.
   */
  private clocksFrom: number | null = null;
  private overPending = false;
  private botsAt: number | null = null;
  private hostGoneAt: number | null = null;
  /** The host has had a tab here this harbour (in memory): a creator slow to connect isn't handed over before arriving. */
  private hostSeen = false;
  private alarmAt: number | null = null;
  /** The alarm was set for the harbour, and the game has started: it moves even if later. */
  private alarmStale = false;
  private starting = false;
  private lastTimers: Timers | null = null;
  private reveal: Extract<ServerMsg, { t: 'reveal' }> | null = null;
  /** The game ended in this handler: its people away from the table hear. */
  private overTell = false;
  /** The latest public moment ("Wren built a city"), for a note's body (memory only). */
  private recent: { seat: PlayerId; text: string } | null = null;
  private checkpoints: { turn: number; seq: number; json: string; extra: unknown }[] = [];
  private out: Outbox | null = null;
  private memo = new WeakMap<RoomSocket, SocketMemo>();
  private blockedBy = new Map<string, string[]>();
  /** People whose standing (tier, Fair winds) this room has asked the services for. */
  private stood = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private gone = false;
  /** The socket whose close is being handled (a runtime may still list it). */
  private closing: RoomSocket | null = null;
  readonly ready: Promise<void>;
  readonly counters: RoomCounters = { wakes: 0, alarms: 0, alarmsSet: 0, messages: 0, sent: 0, sentBytes: 0, journal: { turn: 0, reveal: 0, flush: 0, alone: 0, big: 0, end: 0 }, carries: 0, squeezed: 0 };

  constructor(private rt: RoomRuntime) {
    this.store = new RoomStore(rt.sql);
    this.ready = this.load();
  }

  private static freshOpen(turn: number, n: number): OpenRow {
    return { turn, entries: [], clocks: emptyClocks(), lastN: Array(n).fill(0), expiries: Array(n).fill(0), goneAt: Array(n).fill(null), allGoneSince: null, turnSince: null, pause: null };
  }

  // ================================================================ entry points

  /** The room's own requests (from server/http): POST /init, GET /card, POST /map. */
  fetch(req: Request): Promise<Response> {
    return this.serial(async () => {
      const path = new URL(req.url).pathname.split('/').pop();
      if (req.method === 'POST' && path === 'init') return this.init((await req.json()) as RoomInit);
      if (!this.meta) return json(404, { error: 'No such room.' });
      if (req.method === 'GET' && path === 'card') return json(200, this.card());
      if (req.method === 'POST' && path === 'map') {
        const body = (await req.json()) as { user?: string; map?: unknown };
        return this.handle(() => this.uploadMap(body.user ?? '', body.map));
      }
      return json(404, { error: 'No such route.' });
    });
  }

  /** Everything the sockets carry, into storage now (a runtime going down takes its sockets with it). */
  flushNow() {
    if (this.meta && !this.gone) this.spill('flush');
  }

  /** Before a socket is accepted: whether this room takes one more. */
  async admit(): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    await this.ready;
    if (!this.meta) return { ok: false, status: 404, error: 'No such room.' };
    if (this.rt.sockets().length >= MAX_SOCKETS) return { ok: false, status: 503, error: 'The room is full.' };
    return { ok: true };
  }

  /** A socket was just accepted (by the runtime): it says hello next. */
  opened(ws: RoomSocket) {
    ws.serializeAttachment({ v: 1, at: this.rt.now() } satisfies Attachment);
  }

  webSocketMessage(ws: RoomSocket, data: string | ArrayBuffer): Promise<void> {
    // (A runtime without an auto-response passes the heartbeat on: answered at once, waking nothing else.)
    if (data === PING) {
      ws.send(PONG);
      return Promise.resolve();
    }
    return this.serial(() =>
      this.handle(async () => {
        this.counters.messages++;
        if (typeof data !== 'string') return ws.close(1003, 'Text frames only.');
        await this.frame(ws, data);
      }),
    );
  }

  webSocketClose(ws: RoomSocket, _code?: number, _reason?: string, _clean?: boolean): Promise<void> {
    return this.serial(() => this.closeOf(ws));
  }

  webSocketError(ws: RoomSocket, _err?: unknown): Promise<void> {
    return this.serial(() => this.closeOf(ws));
  }

  private async closeOf(ws: RoomSocket) {
    // (A room woken by this close may have been built without it, the runtime no longer listing it:
    // when its carry is newer than anything the room was built from, build again with it.)
    const k = this.att(ws).k;
    if (k && k.r > this.rev) await this.load([ws]);
    this.closing = ws;
    try {
      await this.handle(() => this.closed(ws));
    } finally {
      this.closing = null;
    }
  }

  alarm(): Promise<void> {
    return this.serial(() =>
      this.handle(async () => {
        this.counters.alarms++;
        this.alarmAt = null;
        await this.onAlarm();
      }),
    );
  }

  /** Run `fn` after everything before it (one handler at a time). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ready;
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** One handler: collect what it sends, then send it, persist, and set the alarm. */
  private async handle<T>(fn: () => Promise<T> | T): Promise<T> {
    this.counters.wakes++;
    this.out = { recs: new Map(), msgs: [], wait: 0, acted: new Map() };
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      this.log('error', { error: String((e as Error)?.message ?? e).slice(0, 200) });
      throw e;
    } finally {
      try {
        await this.finishHandler();
      } catch (e) {
        this.log('error', { at: 'finish', error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
      this.out = null;
    }
    return result;
  }

  private async finishHandler() {
    if (this.gone || !this.meta) return;
    // (A `seen` changes nothing: no clocks to look at, nothing to keep.)
    if (this.out!.light && !this.out!.msgs.length && !this.out!.recs.size && !this.overPending) return;
    if (this.overPending) this.markOver();
    if (this.meta.phase === 'playing') this.tick();
    this.tell();
    // Kept, then sent: nothing goes out that a crash could take back unseen by storage (on Cloudflare
    // the output gate holds the sends until the writes are confirmed; locally they simply come after).
    await this.persist();
    this.flush();
    if (this.overPending) {
      this.overPending = false;
      await this.archive();
    }
    this.schedule();
  }

  // ================================================================ loading

  /**
   * The room from its storage and the sockets' carry (the newest of each part). `extra`: sockets the
   * runtime no longer lists but whose carry counts (the one whose close woke the room).
   */
  private async load(extra: RoomSocket[] = []) {
    this.alarmAt = this.rt.getAlarm();
    this.meta = null;
    this.table = null;
    this.talk = null;
    this.reveal = null;
    this.journal = { id: 0, turns: [] };
    this.journalDue = this.revealPending = this.flushDue = this.harbourDirty = false;
    this.carried = null;
    this.checkpoints = [];
    if (!this.store.exists()) return;
    const kept = this.store.room<RoomMeta, SeatState>();
    if (!kept) return;
    const meta = kept.meta;
    let seats = kept.seats;
    this.roomStored = JSON.stringify({ ...meta, rev: undefined, seats });
    this.custom = this.store.getMeta<CustomMap>('custom');
    const chat = this.store.chat();
    this.chatStored = this.chatJournaled = chat.at(-1)?.id ?? 0;
    const addLines = (lines: ChatLine[] | undefined) => {
      for (const l of lines ?? []) if (l.id > (chat.at(-1)?.id ?? 0)) chat.push(l);
    };
    const carry = await this.readCarry(extra);
    this.rev = Math.max(meta.rev ?? 0, carry?.r ?? 0);
    let m = meta;
    // A harbour's seats and settings as they last were, when that's newer than storage's.
    if (carry?.m && carry.s && carry.r > (meta.rev ?? 0) && meta.phase === 'harbour' && carry.m.phase === 'harbour') {
      m = carry.m;
      seats = carry.s;
      this.harbourDirty = true;
    }
    this.meta = m;
    this.seats = seats;
    this.hostGoneAt = m.hostGoneAt ?? null;
    if (this.hostGoneAt !== null) this.hostSeen = true;
    if (m.phase === 'harbour' || !m.options || !m.gameKey) {
      addLines(carry?.c);
      this.chat = chat.slice(-CHAT_KEEP);
      return;
    }
    // The game: from its last checkpoint (or its start), every turn logged since, and the turn under way.
    const table = this.newTable(m.options, m.gameKey);
    const n = this.seats.length;
    const lastN = Array(n).fill(0);
    const chunks = this.store.chunks<OpenRow>();
    const ck = this.store.latestCheckpoint(chunks);
    let after = -1;
    if (ck) {
      const extra = ck.extra as ReturnType<Table['checkpointExtra']> & { lastN: number[] };
      table.restore(JSON.parse(await gunzip(ck.state)) as GameState, extra);
      lastN.splice(0, n, ...extra.lastN);
      after = ck.turn;
    }
    const note = (e: Extract<LogEntry, { p: PlayerId }>) => {
      if (e.n) lastN[e.p] = Math.max(lastN[e.p], e.n);
    };
    let lastTurn = after;
    let lastClosed: LogEntry[] = [];
    for (const t of this.store.turns(after, chunks)) {
      table.replay(t.entries, note);
      lastTurn = t.turn;
      lastClosed = t.entries;
    }
    const last = chunks.at(-1);
    this.journalRev = last?.body.rev ?? 0;
    this.rev = Math.max(this.rev, this.journalRev);
    // (The newest chunk goes on taking turns; one its checkpoint closed, the next.)
    if (last) this.journal = chunkSealed(last.body, last.bytes) ? { id: last.id + 1, turns: [] } : { id: last.id, turns: last.body.turns };
    addLines(last?.body.chat);
    this.chatJournaled = chat.at(-1)?.id ?? 0;
    addLines(carry?.c);
    // The turn under way: the sockets' when it's newer than the journal's (a room made before the journal kept it in meta 'open').
    const stored = last ? (last.body.open ?? null) : this.store.getMeta<OpenRow>('open');
    const row = carry?.o && carry.r > this.journalRev ? carry.o : stored;
    // (An open row older than the log, kept by a room made before the journal when its turn ended
    // after the row's last write: only its clocks and counters are kept, and the turn starts empty.)
    if (row && row.turn > lastTurn) table.replay(row.entries, note);
    else if (row) row.entries = [];
    const open = row ? { ...row, turn: table.state.turn } : { ...Room.freshOpen(0, n), turn: table.state.turn };
    open.lastN = lastN.map((x, i) => Math.max(x, row?.lastN[i] ?? 0));
    this.open = open;
    this.storedOpen = row === stored ? JSON.stringify(open) : stored ? JSON.stringify(stored) : null;
    this.storedEntries = stored && stored.turn === open.turn ? stored.entries.length : 0;
    const lastEntry = [...lastClosed, ...open.entries].at(-1);
    this.clocksFrom = lastEntry?.t ?? m.startedAt ?? null;
    this.table = table;
    for (const s of this.seats) if (s.kind === 'human') table.keep(s.seat);
    this.talk = this.newTalk();
    this.chat = chat.slice(-CHAT_KEEP);
    if (m.phase === 'over' || m.phase === 'abandoned') this.reveal = this.revealMsg();
  }

  /** The newest carry any socket holds (the others' are older revisions of it). */
  private async readCarry(extra: RoomSocket[]): Promise<(Carry & { r: number }) | null> {
    let best: CarryWire | null = null;
    for (const ws of [...this.rt.sockets(), ...extra]) {
      const k = this.att(ws).k;
      if (k && (!best || k.r > best.r)) best = k;
    }
    if (!best?.z) return best;
    try {
      return { ...(JSON.parse(await gunzip(fromB64url(best.z)!)) as Carry), r: best.r };
    } catch (e) {
      this.log('carryFailed', { error: String((e as Error)?.message ?? e).slice(0, 120) });
      return null;
    }
  }

  private newTable(options: GameState['options'], key: string, seats = this.seats): Table {
    const setups = seats.map((s) => ({ name: s.name, color: s.color, isBot: s.kind === 'bot' }));
    const table = new Table(setups, options, key, (p) => this.seats[p]?.difficulty ?? this.meta!.settings.botDifficulty);
    for (const s of seats) if (s.kind === 'bot') table.botTakes(s.seat);
    return table;
  }

  private newTalk(): RoomTalk | null {
    if (!this.table || !this.seats.some((s) => s.kind === 'bot')) return null;
    const t = this.table;
    return new RoomTalk(() => t.state, (p) => this.seats[p]?.difficulty ?? 'normal', () => this.rt.now(), () => this.random01());
  }

  // ================================================================ creation and the card

  private async init(body: RoomInit): Promise<Response> {
    if (this.meta) return json(409, { error: 'That room exists.' });
    const host = body?.host;
    if (!host || typeof host.user !== 'string' || typeof host.name !== 'string') return json(400, { error: 'A room needs a host.' });
    const custom = body.custom !== undefined ? checkRoomMap(body.custom, { ...DEFAULT_SETTINGS, ...(body.settings ?? {}) }) : null;
    if (custom && !custom.ok) return json(400, { error: custom.error });
    const settingsResult = applySettings(DEFAULT_SETTINGS, body.settings ?? {}, custom?.ok ? custom.map : null);
    if (!settingsResult.ok) return json(400, { error: settingsResult.error });
    const settings = settingsResult.settings;
    const key = newKey((n) => this.rt.random(n));
    const now = this.rt.now();
    this.gone = false;
    this.store.init();
    this.rev = 0;
    this.roomStored = null;
    this.journal = { id: 0, turns: [] };
    this.chatStored = this.chatJournaled = 0;
    this.meta = {
      v: 1,
      code: this.rt.code,
      createdAt: now,
      phase: 'harbour',
      settings,
      host: host.user,
      key,
      commit: await diceCommit(key),
      banned: [],
      idleSince: now,
      from: body.from,
    };
    this.custom = custom?.ok ? custom.map : null;
    this.seats = [];
    for (let i = 0; i < settings.seats; i++) {
      const given = body.seats?.find((s) => s.seat === i);
      if (given?.kind === 'human' && given.user) this.seats.push({ seat: i, kind: 'human', user: given.user, name: given.name.slice(0, NAME_MAX), color: given.color, avatar: given.avatar, ready: false, gen: 0, nonce: null });
      else if (given?.kind === 'bot') this.seats.push({ seat: i, kind: 'bot', name: given.name, color: given.color, avatar: given.avatar, difficulty: given.difficulty ?? settings.botDifficulty, gen: 0 });
      else this.seats.push({ seat: i, kind: 'open', name: '', color: '', gen: 0 });
    }
    this.writeRoom();
    if (this.custom) this.store.setMeta('custom', this.custom);
    this.log('created', { seats: settings.seats });
    this.schedule();
    return json(201, { code: this.rt.code });
  }

  /** The public card (the join page, link previews): no ids, no secrets. */
  private card() {
    const m = this.meta!;
    return {
      code: m.code,
      phase: m.phase,
      createdAt: m.createdAt,
      seats: this.seats.map((s) => ({ seat: s.seat, kind: s.kind, name: s.kind === 'open' ? '' : s.name, color: s.color, avatar: s.avatar, online: this.online(s.seat), away: !!s.away })),
      settings: { seats: m.settings.seats, preset: m.settings.preset, modules: m.settings.modules, map: m.settings.map, victoryPoints: m.settings.victoryPoints, timer: m.settings.timer, spectators: m.settings.spectators },
      spectators: this.watchers().length,
      results: m.results ? { winner: m.results.winner, standings: m.results.standings, turns: m.results.turns } : undefined,
      rematch: m.rematch,
    };
  }

  private info(): RoomInfo {
    const m = this.meta!;
    const p = this.open.pause;
    return {
      code: m.code,
      phase: m.phase,
      settings: m.settings,
      seats: this.seats.map((s) => this.seatInfo(s)),
      host: m.host,
      spectators: this.watchers().length,
      createdAt: m.createdAt,
      commit: m.commit,
      pause: p ? { by: p.by, votes: p.votes, at: p.at, on: p.on } : null,
      results: m.results,
      rematch: m.rematch,
    };
  }

  private seatInfo(s: SeatState): SeatInfo {
    const i: SeatInfo = { seat: s.seat, kind: s.kind, name: s.name, color: s.color };
    if (s.avatar !== undefined) i.avatar = s.avatar;
    if (s.user) i.user = s.user;
    if (s.handle) i.handle = s.handle;
    if (s.kind === 'human') {
      i.ready = !!s.ready;
      i.online = this.online(s.seat);
      if (s.away) i.away = true;
      if (s.tier !== undefined) i.tier = s.tier;
      if (s.rating !== undefined) i.rating = s.rating;
      if (s.reliability !== undefined) i.reliability = s.reliability;
      if (s.conceded) i.conceded = true;
    }
    if (s.kind === 'bot') i.difficulty = s.difficulty;
    const wants = s.kind === 'human' && this.meta?.phase === 'playing' ? this.open.wants?.[s.seat] : null;
    if (wants) i.wants = wants;
    return i;
  }

  // ================================================================ sockets

  private att(ws: RoomSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { v: 1, at: 0 };
  }

  private setAtt(ws: RoomSocket, a: Attachment) {
    ws.serializeAttachment(a);
  }

  /** The sockets that said hello (and still hold their seat's generation). */
  private live(except?: RoomSocket): { ws: RoomSocket; a: Attachment }[] {
    const out: { ws: RoomSocket; a: Attachment }[] = [];
    for (const ws of this.rt.sockets()) {
      if (ws === except || ws === this.closing) continue;
      const a = this.att(ws);
      if (!a.u) continue;
      if (a.s != null && this.seats[a.s] && this.seats[a.s].gen !== a.g) continue;
      out.push({ ws, a });
    }
    return out;
  }

  private watchers(except?: RoomSocket) {
    return this.live(except).filter((x) => x.a.w);
  }

  private online(seat: PlayerId, except?: RoomSocket) {
    return this.live(except).some((x) => x.a.s === seat && !x.a.w);
  }

  /** People still in the game (not bots; not conceded or kicked). */
  private people(): SeatState[] {
    return this.seats.filter((s) => s.kind === 'human' && !s.conceded && !s.kicked);
  }

  /** A seat a person plays right now (not a bot, not away). */
  private personAt(p: PlayerId) {
    const s = this.seats[p];
    return !!s && s.kind === 'human' && !s.away && !s.conceded && !s.kicked;
  }

  private allGone(except?: RoomSocket) {
    return !this.people().some((s) => this.online(s.seat, except));
  }

  private send(ws: RoomSocket, msg: ServerMsg | string) {
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.counters.sent++;
    this.counters.sentBytes += text.length;
    try {
      ws.send(text);
    } catch {
      // (A socket closing as we send: its close comes next.)
    }
  }

  private queueMsg(to: Target, msg: ServerMsg) {
    this.out!.msgs.push({ to, msg });
  }

  private notice(to: Target, kind: NoticeKind, seat?: PlayerId, text?: string) {
    const msg: ServerMsg = { t: 'notice', kind };
    if (seat !== undefined) msg.seat = seat;
    if (text !== undefined) msg.text = text;
    this.queueMsg(to, msg);
  }

  private error(ws: RoomSocket, code: string, error: string) {
    this.send(ws, { t: 'error', code, error });
  }

  private nack(ws: RoomSocket, n: number, code: NackCode, error: string, ackN?: number) {
    const msg: ServerMsg = { t: 'nack', n, code, error };
    if (ackN !== undefined) msg.ackN = ackN;
    this.send(ws, msg);
  }

  private matches(to: Target, ws: RoomSocket, a: Attachment) {
    if (to === 'all') return true;
    if (typeof to === 'function') return to(a);
    if ('socket' in to) return to.socket === ws;
    return a.s === to.seat && !a.w;
  }

  /** Which view a socket's records come from: its seat's, or the spectators'. */
  private viewKeyOf(a: Attachment): ViewKey | null {
    if (!this.table) return null;
    if (a.s != null && !a.w && this.seats[a.s]?.kind === 'human') return a.s;
    if (a.w) return 'w';
    return null;
  }

  private flush() {
    const out = this.out!;
    const texts = new Map<ViewKey, string>();
    for (const [k, list] of out.recs) {
      if (!list.length) continue;
      texts.set(k, JSON.stringify(list.length === 1 ? { t: 'g', ...list[0] } : { t: 'gb', list }));
    }
    // (Each record list and each message is made into text once, however many sockets get it: the
    // spectators share one view, and the room's messages are the same for everyone they go to.)
    const msgs = out.msgs.map((m) => ({ to: m.to, text: JSON.stringify(m.msg) }));
    for (const { ws, a } of this.live()) {
      const k = this.viewKeyOf(a);
      const t = k === null ? undefined : texts.get(k);
      if (t) this.send(ws, t);
      for (const m of msgs) if (this.matches(m.to, ws, a)) this.send(ws, m.text);
    }
    out.recs.clear();
    out.msgs = [];
  }

  private broadcastRoom() {
    // (Only the latest room message in a handler matters.)
    const out = this.out!;
    out.msgs = out.msgs.filter((m) => m.msg.t !== 'room');
    this.queueMsg('all', { t: 'room', room: this.info() });
  }

  private presence() {
    const out = this.out!;
    out.msgs = out.msgs.filter((m) => m.msg.t !== 'presence');
    this.queueMsg('all', {
      t: 'presence',
      seats: this.seats.filter((s) => s.kind === 'human').map((s) => ({ seat: s.seat, online: this.online(s.seat), away: !!s.away })),
      spectators: this.watchers().length,
    });
  }

  private memoOf(ws: RoomSocket): SocketMemo {
    let m = this.memo.get(ws);
    if (!m) {
      m = { tokens: RATE_BURST, refill: this.rt.now(), strikes: [], chats: [], nudgedAt: 0, reports: [], seen: -1, reactAt: -Infinity };
      this.memo.set(ws, m);
    }
    return m;
  }

  /** A token from the socket's bucket (RATE_PER_SECOND, bursting to RATE_BURST). */
  private takeToken(ws: RoomSocket): boolean {
    const m = this.memoOf(ws);
    const now = this.rt.now();
    m.tokens = Math.min(RATE_BURST, m.tokens + ((now - m.refill) / 1000) * RATE_PER_SECOND);
    m.refill = now;
    if (m.tokens < 1) return false;
    m.tokens--;
    return true;
  }

  /** A bad frame: past STRIKES_MAX a minute the socket is closed. */
  private strike(ws: RoomSocket): boolean {
    const m = this.memoOf(ws);
    const now = this.rt.now();
    m.strikes = m.strikes.filter((t) => now - t < 60_000);
    m.strikes.push(now);
    if (m.strikes.length > STRIKES_MAX) {
      ws.close(1008, 'Too many bad messages.');
      return true;
    }
    return false;
  }

  // ================================================================ frames

  private async frame(ws: RoomSocket, text: string) {
    const r = parseClientFrame(text);
    if (!r.ok) {
      if (r.code === 'big') return ws.close(1009, 'Frame too large.');
      this.log('bad', { code: r.code });
      if (this.strike(ws)) return;
      if (r.n !== undefined) return this.nack(ws, r.n, 'bad', r.error);
      return this.error(ws, 'bad', r.error);
    }
    const msg = r.msg;
    let a = this.att(ws);
    if (!this.meta) {
      this.error(ws, 'gone', 'This room is closed.');
      return ws.close(4404, 'No such room.');
    }
    if (msg.t === 'hello') {
      if (a.u) return this.error(ws, 'order', 'Already said hello.');
      return this.hello(ws, msg);
    }
    if (!a.u) {
      this.error(ws, 'auth', 'Say hello first.');
      return ws.close(4401, 'Say hello first.');
    }
    if (a.s != null && this.seats[a.s] && this.seats[a.s].gen !== a.g) {
      this.notice({ socket: ws }, 'handedOff', a.s);
      return ws.close(4409, 'This seat moved to another device.');
    }
    if (!this.takeToken(ws)) {
      if (msg.t === 'act') return this.nack(ws, msg.n, 'slow', 'Too many messages.');
      return this.error(ws, 'slow', 'Too many messages.');
    }
    a = this.att(ws);
    switch (msg.t) {
      case 'claim':
        return this.claim(ws, a, msg);
      case 'unclaim':
        return this.unclaim(ws, a);
      case 'ready':
        return this.ready_(ws, a, msg.on);
      case 'settings':
        return this.settings(ws, a, msg.settings);
      case 'seatBot':
        return this.seatBot(ws, a, msg.seat, msg.difficulty);
      case 'kick':
        return this.kick(ws, a, msg.seat);
      case 'start':
        return this.start(ws, a, !!msg.force);
      case 'transfer':
        return this.transfer(ws, a, msg.seat);
      case 'entropy':
        return this.entropy(ws, a, msg.nonce);
      case 'act':
        return this.act(ws, a, msg);
      case 'seen':
        return this.seen(ws, a, msg.seq);
      case 'back':
        return this.backMsg(ws, a);
      case 'pause':
        return this.pause(ws, a, msg.on);
      case 'concede':
        return this.concede(ws, a);
      case 'nudge':
        return this.nudge(ws, a, msg.seat);
      case 'wants':
        return this.wants(ws, a, msg.looking, msg.spare);
      case 'chat':
        return this.chatMsg(ws, a, msg);
      case 'react': {
        // (One at a time: a burst of faces is let go, not queued.)
        const m = this.memoOf(ws);
        const now = this.rt.now();
        if (now - m.reactAt < REACT_GAP_MS) return;
        m.reactAt = now;
        return this.queueMsg('all', { t: 'react', from: a.w ? null : (a.s ?? null), r: msg.r });
      }
      case 'typing':
        if (a.s == null || a.w) return;
        return this.queueMsg((x) => x.u !== a.u, { t: 'typing', seat: a.s, on: msg.on });
      case 'handoff':
        return this.handoff(ws, a);
      case 'report':
        return this.report(ws, a, msg);
      case 'rematch':
        return this.rematch(ws, a);
      case 'leave':
        return this.leave(ws, a);
    }
  }

  // ================================================================ hello

  private async hello(ws: RoomSocket, msg: Extract<ClientMsg, { t: 'hello' }>) {
    if (msg.proto !== PROTO) {
      this.send(ws, { t: 'upgrade', need: PROTO });
      return ws.close(4426, 'Upgrade needed.');
    }
    const who = await this.rt.services.identify(msg.token).catch(() => null);
    if (!who) {
      this.error(ws, 'auth', 'Who are you? Sign in again.');
      return ws.close(4401, 'Unknown token.');
    }
    const m = this.meta!;
    if (who.banned || m.banned.includes(who.user)) {
      this.error(ws, 'banned', 'You can’t join this room.');
      return ws.close(4403, 'Not allowed.');
    }
    const blocked = await this.rt.services.blocked(who.user).catch(() => [] as string[]);
    this.blockedBy.set(who.user, blocked);
    let seat = this.seats.findIndex((s) => s.kind === 'human' && s.user === who.user && !s.kicked);
    // A guest who signed in to this account since they sat here: the seat is theirs, under the account's id.
    if (seat < 0 && this.rt.services.aliases) {
      const old = await this.rt.services.aliases(who.user).catch(() => [] as string[]);
      if (old.length) {
        const i = this.seats.findIndex((s) => s.kind === 'human' && !!s.user && old.includes(s.user) && !s.kicked);
        if (i >= 0) {
          const was = this.seats[i].user!;
          this.seats[i].user = who.user;
          if (m.host === was) m.host = who.user;
          seat = i;
          this.saveRoom();
        } else if (old.includes(m.host)) {
          m.host = who.user;
          this.saveRoom();
        }
      }
    }
    // A hand-off link: this device takes the seat; the one that made the link stops.
    if (msg.seat) {
      const taken = await this.takeHandoff(msg.seat, who.user, seat);
      if (!taken.ok) {
        this.error(ws, 'handoff', taken.error);
        return ws.close(4403, 'Bad hand-off.');
      }
      seat = taken.seat;
    }
    const playing = m.phase !== 'harbour';
    const watch = seat < 0 && (playing || !!msg.watch);
    if (watch) {
      if (m.settings.spectators === 'none') {
        this.error(ws, 'watch', 'This room has no spectators.');
        return ws.close(4403, 'No spectators.');
      }
      if (this.watchers().length >= MAX_WATCHERS) {
        this.error(ws, 'full', 'Too many watching already.');
        return ws.close(4429, 'Too many spectators.');
      }
    }
    const a: Attachment = { v: 1, at: this.att(ws).at || this.rt.now(), u: who.user, nm: who.name.slice(0, NAME_MAX), s: seat >= 0 ? seat : null, w: watch, ...(who.quickTalk && { q: 1 as const }), ...(who.handle && { h: who.handle.slice(0, 20) }) };
    if (seat >= 0) {
      a.g = this.seats[seat].gen;
      if (who.handle) this.seats[seat].handle = who.handle;
      if (!this.stood.has(who.user)) await this.stand(this.seats[seat]);
      // One socket per seat: the newest tab takes it.
      for (const x of this.live(ws)) {
        if (x.a.s === seat && !x.a.w) {
          this.send(x.ws, { t: 'error', code: 'replaced', error: 'This seat was opened in another tab.' });
          x.ws.close(4409, 'Opened elsewhere.');
        }
      }
    }
    this.setAtt(ws, a);
    if (who.user === m.host) this.hostSeen = true;
    if (this.hostGoneAt !== null && who.user === m.host) this.setHostGone(null);
    // (Someone is here and the host isn't, with no hand-over coming: one is, from now.)
    else this.armHostGone();
    if (m.idleSince !== undefined) {
      delete m.idleSince;
      if (m.phase === 'harbour') this.saveRoom();
    }
    const you = { seat: seat >= 0 ? seat : null, user: who.user, host: m.host === who.user, watch, gen: a.g, ackN: seat >= 0 ? (this.open.lastN[seat] ?? 0) : undefined, ...(who.quickTalk && { quick: true }) };
    this.send(ws, { t: 'welcome', proto: PROTO, you, room: this.info(), chat: this.chatFor(a) });
    if (this.table) {
      const k = this.viewKeyOf(a);
      if (k !== null) this.resync(ws, k, msg.last, msg.hash, seat >= 0 ? seat : null);
      if (this.reveal) this.send(ws, this.reveal);
      if (seat >= 0 && m.phase === 'playing') {
        // (Back after a while: the table hears it, as it heard them go.)
        const gone = this.open.goneAt[seat];
        if (gone != null && this.rt.now() - gone >= REJOIN_NEWS_MS && !this.seats[seat].conceded) this.notice((x) => x.u !== who.user, 'joined', seat);
        this.open.goneAt[seat] = null;
        this.open.allGoneSince = null;
        // (Back at a live table: the next time they're away and owe a move, they hear again.)
        if (this.open.told?.[seat]) this.open.told[seat] = null;
        this.advance();
      }
    }
    this.presence();
    this.broadcastRoom();
  }

  /** A reconnecting viewer catches up: its missed records as one batch when they're few and kept, else a snapshot. */
  private resync(ws: RoomSocket, k: ViewKey, last: number | undefined, hash: string | undefined, seat: PlayerId | null) {
    const t = this.table!;
    const view = t.view(k);
    const ackN = seat !== null ? this.open.lastN[seat] : undefined;
    if (last !== undefined) {
      const missed = t.since(k, last);
      const fine = last !== t.state.seq || !hash || hash === viewHash(view);
      if (missed && fine && missed.length <= RESYNC_BATCH_MAX) {
        if (!missed.length) return;
        const list = missed.map((r) => {
          const c: GameRecord = { ...r };
          delete c.wait;
          delete c.timers;
          delete c.ackN;
          return c;
        });
        const lastRec = list[list.length - 1];
        lastRec.h = viewHash(view);
        if (ackN) lastRec.ackN = ackN;
        if (this.lastTimers) lastRec.timers = this.lastTimers;
        return this.send(ws, { t: 'gb', list });
      }
    }
    const snap: ServerMsg = { t: 'snap', seq: t.state.seq, view, hash: viewHash(view) };
    if (this.lastTimers) snap.timers = this.lastTimers;
    if (ackN) snap.ackN = ackN;
    if (t.state.seq === 0) snap.initialEvents = eventsFor(t.initialEvents, k === 'w' ? null : k);
    this.send(ws, snap);
  }

  private closed(ws: RoomSocket) {
    if (!this.meta) return;
    const a = this.att(ws);
    if (!a.u) return;
    const m = this.meta;
    const now = this.rt.now();
    if (a.s != null && !a.w && !this.online(a.s) && m.phase === 'playing') {
      this.open.goneAt[a.s] = now;
      if (this.allGone()) this.open.allGoneSince = now;
    }
    if (a.w && this.table && this.watchers().length === 0) this.table.drop('w');
    if (a.u === m.host && !this.live().some((x) => x.a.u === m.host)) this.setHostGone(now);
    const empty = this.live().length === 0;
    if (empty && m.phase === 'harbour') {
      m.idleSince = now;
      this.saveRoom();
    }
    // (The last socket that carried the room's unstored state is going: storage takes it all.)
    if (empty) this.flushDue = true;
    this.presence();
    if (m.phase === 'harbour') this.broadcastRoom();
  }

  // ================================================================ the harbour

  private inHarbour(ws: RoomSocket): boolean {
    if (this.meta!.phase === 'harbour' && !this.starting) return true;
    this.error(ws, 'phase', 'The game is under way.');
    return false;
  }

  private isHost(ws: RoomSocket, a: Attachment): boolean {
    if (a.u === this.meta!.host) return true;
    this.log('notHost', {});
    this.strike(ws);
    this.error(ws, 'auth', 'Only the host can do that.');
    return false;
  }

  /**
   * The room or a seat changed: stored now, or in the harbour carried until a flush or the start
   * (claims, colours and ready come and go there, and nothing in a harbour is worth a row each).
   */
  private saveRoom() {
    if (this.meta?.phase === 'harbour') this.harbourDirty = true;
    else this.writeRoom();
  }

  /**
   * The room's row, with its seats in it (one row for both: made, set sailing and deleted as one),
   * when it differs from the stored one; with the revision it was stored at.
   */
  private writeRoom() {
    const m = this.meta!;
    const text = JSON.stringify({ ...m, rev: undefined, seats: this.seats });
    if (text === this.roomStored) return;
    m.rev = ++this.rev;
    this.store.setRoom(m, this.seats);
    this.roomStored = text;
  }

  /** A harbour's seats and room into storage, when they changed. */
  private flushHarbour() {
    if (!this.harbourDirty || !this.meta) return;
    this.harbourDirty = false;
    this.writeRoom();
  }

  /** The sockets of a user (their tabs) follow the seat they took. */
  private moveUser(user: string, seat: PlayerId | null) {
    for (const x of this.live()) {
      if (x.a.u !== user) continue;
      x.a.s = seat;
      x.a.g = seat === null ? undefined : this.seats[seat].gen;
      x.a.w = false;
      this.setAtt(x.ws, x.a);
    }
  }

  private freeColor(except?: PlayerId): string {
    return COLORS.find((c) => !this.seats.some((s) => s.seat !== except && s.kind !== 'open' && s.color.toLowerCase() === c)) ?? 'red';
  }

  private openSeat(seat: PlayerId): SeatState {
    return { seat, kind: 'open', name: '', color: '', gen: (this.seats[seat]?.gen ?? 0) + 1 };
  }

  private async claim(ws: RoomSocket, a: Attachment, msg: Extract<ClientMsg, { t: 'claim' }>) {
    if (!this.inHarbour(ws)) return;
    const target = this.seats[msg.seat];
    if (!target) return this.error(ws, 'seat', 'No such seat.');
    if (target.kind === 'bot' || (target.kind === 'human' && target.user !== a.u)) return this.error(ws, 'taken', 'That seat is taken.');
    let name = a.nm ?? 'Sailor';
    if (msg.name !== undefined) {
      const ok = await this.rt.services.moderate(msg.name, 'name').catch(() => null);
      if (!ok) return this.error(ws, 'name', 'Choose another name.');
      name = ok.slice(0, NAME_MAX);
    } else if (target.kind === 'human') name = target.name;
    // (Checked again after the wait: the queue kept everyone else out, but be plain about it.)
    const t2 = this.seats[msg.seat];
    if (t2.kind === 'bot' || (t2.kind === 'human' && t2.user !== a.u)) return this.error(ws, 'taken', 'That seat is taken.');
    const color = (msg.color ?? (t2.kind === 'human' ? t2.color : '')) || this.freeColor(msg.seat);
    if (!COLOR_RE.test(color)) return this.error(ws, 'color', 'No such colour.');
    if (this.seats.some((s) => s.seat !== msg.seat && s.kind !== 'open' && s.color.toLowerCase() === color.toLowerCase())) return this.error(ws, 'color', 'That colour is taken.');
    const mine = this.seats.findIndex((s) => s.kind === 'human' && s.user === a.u);
    if (mine >= 0 && mine !== msg.seat) {
      this.seats[mine] = this.openSeat(mine);
      this.saveRoom();
    }
    const s: SeatState = { seat: msg.seat, kind: 'human', user: a.u, name, color, avatar: msg.avatar ?? t2.avatar, ready: t2.kind === 'human' && t2.user === a.u ? !!t2.ready : false, gen: t2.gen, nonce: t2.kind === 'human' ? (t2.nonce ?? null) : null, ...(a.h && { handle: a.h }) };
    await this.stand(s);
    this.seats[msg.seat] = s;
    this.saveRoom();
    this.moveUser(a.u!, msg.seat);
    this.broadcastRoom();
    this.presence();
  }

  /** A person's rating tier and Fair winds onto their seat (when the services keep them). */
  private async stand(s: SeatState) {
    const ask = this.rt.services.standing;
    if (!s.user || !ask) return;
    this.stood.add(s.user);
    const st = await ask.call(this.rt.services, s.user).catch(() => null);
    delete s.tier;
    delete s.rating;
    delete s.reliability;
    if (st?.tier !== undefined) s.tier = st.tier;
    if (st?.rating !== undefined) s.rating = st.rating;
    if (st?.reliability !== undefined) s.reliability = st.reliability;
  }

  private unclaim(ws: RoomSocket, a: Attachment) {
    if (!this.inHarbour(ws)) return;
    if (a.s == null) return;
    this.seats[a.s] = this.openSeat(a.s);
    this.saveRoom();
    this.moveUser(a.u!, null);
    this.broadcastRoom();
  }

  private ready_(ws: RoomSocket, a: Attachment, on: boolean) {
    if (!this.inHarbour(ws)) return;
    if (a.s == null) return this.error(ws, 'seat', 'Take a seat first.');
    const s = this.seats[a.s];
    if (s.ready === on) return;
    s.ready = on;
    this.saveRoom();
    this.broadcastRoom();
  }

  private settings(ws: RoomSocket, a: Attachment, patch: Partial<RoomSettings>) {
    if (!this.inHarbour(ws) || !this.isHost(ws, a)) return;
    const m = this.meta!;
    const r = applySettings(m.settings, patch, this.custom);
    if (!r.ok) return this.error(ws, 'settings', r.error);
    if (r.settings.seats < this.seats.length) {
      // Someone in a seat that goes moves up into one that stays: an open one, else the crew's.
      const gone = this.seats.slice(r.settings.seats).filter((s) => s.kind === 'human');
      const free = this.seats.slice(0, r.settings.seats).filter((s) => s.kind !== 'human');
      if (gone.length > free.length) return this.error(ws, 'settings', 'There are more people aboard than that.');
      free.sort((x, y) => (x.kind === 'open' ? 0 : 1) - (y.kind === 'open' ? 0 : 1));
      for (const [i, s] of gone.entries()) {
        const to = free[i].seat;
        this.seats[to] = { ...s, seat: to, gen: this.seats[to].gen + 1 };
        this.moveUser(s.user!, to);
      }
      // (The rows of seats no longer here go when the harbour is next stored.)
      this.seats = this.seats.slice(0, r.settings.seats);
      this.harbourDirty = true;
    }
    while (this.seats.length < r.settings.seats) {
      const s: SeatState = { seat: this.seats.length, kind: 'open', name: '', color: '', gen: 0 };
      this.seats.push(s);
      this.saveRoom();
    }
    const before = m.settings;
    m.settings = r.settings;
    // (A change to the game itself asks everyone to be ready again; the table's manners don't.)
    const changed = (Object.keys(r.settings) as (keyof RoomSettings)[]).some((k) => READY_AGAIN.has(k) && JSON.stringify(before[k]) !== JSON.stringify(r.settings[k]));
    for (const s of this.seats) {
      if (changed && s.kind === 'human' && s.ready && s.user !== m.host) {
        s.ready = false;
        this.saveRoom();
      }
    }
    this.saveRoom();
    this.broadcastRoom();
  }

  private uploadMap(user: string, raw: unknown): Response {
    const m = this.meta!;
    if (m.phase !== 'harbour') return json(409, { error: 'The game is under way.' });
    if (user !== m.host) return json(403, { error: 'Only the host can do that.' });
    const r = checkRoomMap(raw, m.settings);
    if (!r.ok) return json(400, { error: r.error });
    this.custom = r.map;
    this.store.setMeta('custom', r.map);
    const s = applySettings(m.settings, { map: 'custom', layout: 'random' }, r.map);
    if (!s.ok) return json(400, { error: s.error });
    m.settings = { ...s.settings, customMapId: String(Math.abs(hashString(JSON.stringify(r.map)))) };
    this.saveRoom();
    this.broadcastRoom();
    return json(200, { ok: true });
  }

  private seatBot(ws: RoomSocket, a: Attachment, seat: PlayerId, difficulty: BotDifficulty | null) {
    if (!this.inHarbour(ws) || !this.isHost(ws, a)) return;
    const s = this.seats[seat];
    if (!s) return this.error(ws, 'seat', 'No such seat.');
    if (s.kind === 'human') return this.error(ws, 'taken', 'Someone sits there.');
    if (difficulty === null) {
      if (s.kind !== 'bot') return;
      this.seats[seat] = this.openSeat(seat);
    } else if (s.kind === 'bot') s.difficulty = difficulty;
    else this.seats[seat] = { seat, kind: 'bot', name: this.freeBotName(), color: this.freeColor(seat), difficulty, gen: s.gen };
    const b = this.seats[seat];
    if (b.kind === 'bot') b.avatar = avatarOf(b.name);
    this.saveRoom();
    this.broadcastRoom();
  }

  /** A name for a bot taking a seat: one nobody here has, at random, with a face and a voice the table lacks. */
  private freeBotName(): string {
    const seated = this.seats.filter((s) => s.kind !== 'open');
    return pickCrew(1, () => this.random01(), { taken: seated.map((s) => s.name), faces: seated.map((s) => s.avatar ?? -1) })[0] ?? `Crew ${this.seats.length}`;
  }

  private kick(ws: RoomSocket, a: Attachment, seat: PlayerId) {
    if (!this.isHost(ws, a)) return;
    const s = this.seats[seat];
    if (!s || s.kind !== 'human' || !s.user) return this.error(ws, 'seat', 'Nobody sits there.');
    if (s.user === a.u) return this.error(ws, 'seat', 'That is you.');
    const m = this.meta!;
    const user = s.user;
    m.banned.push(user);
    for (const x of this.live()) {
      if (x.a.u !== user) continue;
      this.send(x.ws, { t: 'notice', kind: 'kicked', seat });
      x.ws.close(4403, 'Kicked.');
    }
    if (m.phase === 'harbour') {
      this.seats[seat] = this.openSeat(seat);
      this.saveRoom();
    } else if (m.phase === 'playing') {
      s.kicked = true;
      s.gen++;
      this.toBot(seat, 'kicked');
    }
    this.saveRoom();
    // (A ban is kept at once, even in the harbour.)
    this.flushHarbour();
    this.notice('all', 'kicked', seat);
    this.broadcastRoom();
    if (m.phase === 'playing' && this.people().length === 0) return this.abandon();
    this.advance();
  }

  private transfer(ws: RoomSocket, a: Attachment, seat: PlayerId) {
    if (!this.isHost(ws, a)) return;
    const s = this.seats[seat];
    if (!s || s.kind !== 'human' || !s.user) return this.error(ws, 'seat', 'Nobody sits there.');
    this.meta!.host = s.user;
    this.setHostGone(null);
    this.saveRoom();
    this.notice('all', 'hostChanged', seat);
    this.broadcastRoom();
  }

  /** The host is gone: the next person at the table (or in the harbour) hosts. */
  private passHost() {
    const m = this.meta!;
    const here = this.live();
    const next = this.people().find((s) => here.some((x) => x.a.u === s.user))?.user ?? here.find((x) => !x.a.w)?.a.u;
    this.setHostGone(null);
    if (!next || next === m.host) return;
    m.host = next;
    this.saveRoom();
    const seat = this.seats.find((s) => s.user === next)?.seat;
    this.notice('all', 'hostChanged', seat);
    this.broadcastRoom();
  }

  /**
   * The host's leaving, kept with a harbour's seats (they go with the sockets' carry, so this costs no
   * write): a harbour asleep through the grace still hands over. At sea it's only in memory, as before.
   */
  private setHostGone(at: number | null) {
    this.hostGoneAt = at;
    const m = this.meta;
    if (!m || (m.hostGoneAt ?? null) === at || (at !== null && m.phase !== 'harbour')) return;
    if (at === null) delete m.hostGoneAt;
    else m.hostGoneAt = at;
    this.saveRoom();
  }

  /**
   * In the harbour, the host has no tab here, someone else has, and no hand-over is coming (the host
   * left a harbour nobody else was in, say, and a guest came later): it comes after the grace, from now.
   */
  private armHostGone() {
    const m = this.meta;
    // (In the harbour only, where the host is who sets sail: at sea it's as it always was.)
    if (!m || this.hostGoneAt !== null || m.phase !== 'harbour') return;
    // (A host who has not yet arrived is not gone: the creator may just be slow to connect.)
    if (!this.hostSeen) return;
    const here = this.live();
    if (here.some((x) => x.a.u === m.host) || !here.some((x) => !x.a.w)) return;
    this.setHostGone(this.rt.now());
  }

  private entropy(ws: RoomSocket, a: Attachment, nonce: string) {
    if (!this.inHarbour(ws)) return;
    if (a.s == null) return this.error(ws, 'seat', 'Take a seat first.');
    if (!NONCE_RE.test(nonce)) return this.error(ws, 'bad', 'A nonce is 16 to 64 characters of base64url.');
    const s = this.seats[a.s];
    if (s.nonce) return;
    s.nonce = nonce;
    this.saveRoom();
  }

  private leave(ws: RoomSocket, a: Attachment) {
    const m = this.meta!;
    if (m.phase === 'harbour' && a.s != null) {
      this.seats[a.s] = this.openSeat(a.s);
      this.saveRoom();
      this.moveUser(a.u!, null);
      this.broadcastRoom();
    }
    if (a.u === m.host && m.phase === 'harbour') this.setHostGone(this.rt.now() - HOST_GRACE_MS);
    // Leaving a live game: the crew takes the helm now rather than once the turn has waited on an
    // empty seat (back by the link, Take the helm has it again).
    if (m.phase === 'playing' && a.s != null && !a.w && this.personAt(a.s)) {
      this.toBot(a.s, 'left');
      this.broadcastRoom();
      // (The crew plays on for the others; not to an empty table.)
      if (!this.allGone(ws)) this.advance();
    }
    this.notice((x) => x.u !== a.u, 'left', a.s ?? undefined);
    ws.close(1000, 'Left.');
  }

  // ================================================================ the start

  private async start(ws: RoomSocket, a: Attachment, force = false) {
    if (!this.inHarbour(ws) || !this.isHost(ws, a)) return;
    const m = this.meta!;
    // Open seats, and seats kept for someone who never came (an invitation not taken up), go to bots.
    const fill = this.seats.filter((s) => s.kind === 'open' || (s.kind === 'human' && s.user !== m.host && !s.ready && !this.online(s.seat)));
    if (fill.length && !m.settings.botsFill) return this.error(ws, 'start', 'Some seats are still open.');
    // (Ready is a word to the host, not a lock: the host may sail without it, once asked.)
    if (!force && this.seats.some((s) => s.kind === 'human' && s.user !== m.host && !s.ready && this.online(s.seat))) return this.error(ws, 'start', 'Not everyone is ready.');
    return this.launch(fill, (error) => this.error(ws, 'start', error));
  }

  /** Set sail: `fill`'s seats go to the crew, the game is made and everyone gets their view. */
  private async launch(fill: SeatState[], fail: (error: string) => void) {
    const m = this.meta!;
    const plan = this.seats.map((s) => ({ ...s }));
    // (The crew come from the room's own dice, and the names go into the seats: that is what a replay reads.)
    const kept = plan.filter((x) => x.kind !== 'open' && !fill.some((f) => f.seat === x.seat));
    const crew = pickCrew(fill.length, () => this.random01(), { taken: kept.map((x) => x.name), faces: kept.map((x) => x.avatar ?? -1) });
    for (const [i, s] of fill.entries()) {
      const name = crew[i] ?? `Crew ${s.seat + 1}`;
      const color = COLORS.find((c) => !plan.some((x) => x.seat !== s.seat && (x.kind === 'bot' || (x.kind === 'human' && !fill.includes(x))) && x.color.toLowerCase() === c)) ?? 'red';
      plan[s.seat] = { seat: s.seat, kind: 'bot', name, color, avatar: avatarOf(name), difficulty: m.settings.botDifficulty, gen: s.gen };
    }
    if (!plan.some((s) => s.kind === 'human')) return fail('A game needs one person at least.');
    this.starting = true;
    let key: string;
    try {
      key = await gameKey(m.key, plan.map((s) => (s.kind === 'human' ? (s.nonce ?? null) : null)));
    } finally {
      this.starting = false;
    }
    let table: Table;
    try {
      const options = gameOptions(m.settings, this.custom, randomUint32((n) => this.rt.random(n)));
      table = this.newTable(options, key, plan);
    } catch (e) {
      return fail((e as Error).message);
    }
    this.seats = plan;
    for (const s of this.seats) if (s.kind !== 'human') s.nonce = null;
    const now = this.rt.now();
    m.phase = 'playing';
    m.options = table.state.options;
    m.gameKey = key;
    m.startedAt = now;
    delete m.idleSince;
    delete m.hostGoneAt;
    this.hostGoneAt = null;
    // (The seats as they sail, and the room with its game key: stored now, whatever the harbour carried.)
    this.harbourDirty = true;
    this.flushHarbour();
    this.table = table;
    this.open = Room.freshOpen(table.state.turn, this.seats.length);
    this.journal = { id: 0, turns: [] };
    this.storedOpen = null;
    // (The game as it starts follows from its key, stored with the room.)
    this.storedEntries = 0;
    this.alarmStale = true;
    this.lastTimers = null;
    for (const s of this.seats) if (s.kind === 'human') table.keep(s.seat);
    this.log('started', { seats: this.seats.length, humans: this.people().length });
    // Everyone gets the room, then their view; those without a seat watch, when the room lets them.
    const info = this.info();
    for (const { ws: w, a: x } of this.live()) {
      if (x.s == null && m.settings.spectators !== 'none') {
        x.w = true;
        this.setAtt(w, x);
      }
      this.send(w, { t: 'room', room: info });
      const k = this.viewKeyOf(x);
      if (k === null) continue;
      const view = table.view(k);
      this.send(w, { t: 'snap', seq: table.state.seq, view, hash: viewHash(view), initialEvents: eventsFor(table.initialEvents, k === 'w' ? null : k) });
    }
    this.talk = this.newTalk();
    this.talk?.onEvents(table.initialEvents);
    this.takeTalk();
    this.advance();
  }

  // ================================================================ play

  private playing(ws: RoomSocket, n?: number): boolean {
    if (this.meta!.phase === 'playing' && this.table && !this.table.over) return true;
    if (n !== undefined) this.nack(ws, n, 'order', 'The game isn’t under way.');
    else this.error(ws, 'phase', 'The game isn’t under way.');
    return false;
  }

  private act(ws: RoomSocket, a: Attachment, msg: Extract<ClientMsg, { t: 'act' }>) {
    if (!this.playing(ws, msg.n)) return;
    const t = this.table!;
    const seat = a.s;
    if (seat == null || a.w) return this.nack(ws, msg.n, 'auth', 'You don’t hold a seat.');
    const s = this.seats[seat];
    if (s.conceded || s.kicked) return this.nack(ws, msg.n, 'auth', 'You left this game.');
    const lastN = this.open.lastN[seat] ?? 0;
    if (msg.n <= lastN) return this.nack(ws, msg.n, 'order', 'Already received.', lastN);
    this.open.lastN[seat] = msg.n;
    if (msg.at > t.state.seq) return this.nack(ws, msg.n, 'order', 'That seq hasn’t happened.', msg.n);
    if (this.open.pause?.on) return this.nack(ws, msg.n, 'rule', 'The game is paused.', msg.n);
    if (msg.a.type === 'undo' && !this.meta!.settings.takeBacks) return this.nack(ws, msg.n, 'rule', 'This room plays without take-backs.', msg.n);
    // Any move of their own brings a person back from being away.
    if (s.away) this.fromBot(seat);
    if (t.isStale(seat, msg.a, msg.at)) return this.nack(ws, msg.n, 'stale', 'The table moved on: look again.', msg.n);
    const r = this.commit(seat, msg.a, { n: msg.n });
    if (!r.ok) return this.nack(ws, msg.n, 'rule', r.error, msg.n);
    this.open.expiries[seat] = 0;
    this.out!.acted.set(seat, (this.out!.acted.get(seat) ?? 0) + 1);
    this.advance();
  }

  /**
   * Apply an action and record it: the log, each viewer's record, the bots' talk. A turn that
   * ends goes into the journal, and every CHECKPOINT_EVERY turns a checkpoint is queued (it closes
   * the journal's chunk when it's written, as this handler ends).
   */
  private commit(actor: PlayerId, action: Action, o: { n?: number; by?: 'bot' | 'timer'; wait?: number }): { ok: true; events: GameEvent[] } | { ok: false; error: string } {
    const t = this.table!;
    const before = t.state;
    const r = t.apply(actor, action);
    if (!r.ok) return r;
    const now = this.rt.now();
    const entry: LogEntry = { p: actor, a: action, t: now };
    if (o.n) entry.n = o.n;
    if (o.by) entry.by = o.by;
    // A roll, a card, a theft: the turn under way is stored before anyone hears of it (unless it's a
    // roll nobody could have done otherwise, first since the last store: a rollback can't change it).
    const settled = this.open.entries.length === this.storedEntries;
    if (reveals(actor, before.rngState, t.state, r.events) && !(settled && forcedRoll(before, actor, action))) this.revealPending = true;
    this.open.entries.push(entry);
    const recs = t.records(actor, action, r.events);
    for (const [k, rec] of recs) {
      if (o.wait) rec.wait = o.wait;
      if (o.n && k === actor) rec.ackN = o.n;
      const list = this.out!.recs.get(k) ?? [];
      list.push(rec);
      this.out!.recs.set(k, list);
    }
    if (o.wait) this.out!.wait += o.wait;
    if (this.talk) {
      this.talk.onEvents(r.events);
      this.takeTalk();
    }
    for (const e of r.events) this.recent = momentOf(e, (p) => this.seats[p]?.name ?? 'Someone') ?? this.recent;
    if (t.state.turn !== before.turn || t.over) {
      // The closed turn goes into the journal (written once, as this handler ends, with its reveals).
      this.journal.turns.push([this.open.turn, this.open.entries]);
      this.journalDue = true;
      this.revealPending = false;
      this.storedEntries = 0;
      // (Looking for / Spare was for the turn: it goes as the speaker's own turn passes to another.)
      const turnOf = before.currentPlayer;
      if (this.open.wants?.[turnOf] && t.state.turn !== before.turn && t.state.currentPlayer !== turnOf) {
        this.open.wants[turnOf] = null;
        this.broadcastRoom();
      }
      const closed = this.open.turn;
      this.open = { ...this.open, turn: t.state.turn, entries: [] };
      if (closed > 0 && closed % CHECKPOINT_EVERY === 0 && !t.over) {
        this.checkpoints.push({ turn: closed, seq: t.state.seq, json: JSON.stringify(t.state), extra: structuredClone({ ...t.checkpointExtra(), lastN: this.open.lastN }) });
      }
    }
    if (t.over) this.overPending = true;
    return r;
  }

  /** A bot's think time (ms): the pause a client holds before presenting its move. */
  private think(): number {
    return Math.round(BOT_THINK_MIN + this.random01() * (BOT_THINK_MAX - BOT_THINK_MIN));
  }

  private random01(): number {
    const b = this.rt.random(4);
    return (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0) / 2 ** 32;
  }

  /** Run the bots until a person must decide (or the game ends, or the run is long enough to send). */
  private advance() {
    const t = this.table;
    this.botsAt = null;
    if (!t || t.over || this.meta?.phase !== 'playing' || this.open.pause?.on) return;
    if (this.allGone()) return;
    for (let i = 0; i < BOT_RUN_CAP; i++) {
      const d = t.nextBot();
      if (!d) return;
      const r = this.commit(d.player, d.action, { by: 'bot', wait: this.think() });
      if (!r.ok) {
        this.log('botRefused', { seat: d.player, type: d.action.type });
        return;
      }
      const bot = t.bots.get(d.player);
      if (bot) bot.memory = d.memory;
      if (t.over) return;
    }
    // (A long run goes out in parts: the next once this one has been presented.)
    if (t.nextBot()) this.botsAt = this.rt.now() + this.out!.wait;
  }

  /** A bot takes a person's seat (away, kicked, conceded); its memory starts afresh. */
  private toBot(seat: PlayerId, why: 'away' | 'kicked' | 'conceded' | 'left') {
    const t = this.table;
    const s = this.seats[seat];
    s.away = true;
    this.saveRoom();
    if (!t || t.bots.has(seat)) return;
    t.botTakes(seat);
    this.open.entries.push({ c: seat, bot: true, t: this.rt.now() });
    this.open.clocks = { clocks: this.open.clocks.clocks.filter((c) => c.seat !== seat) };
    if (why === 'away') this.notice('all', 'away', seat);
    this.presence();
  }

  /** The person takes the helm again. */
  private fromBot(seat: PlayerId) {
    const t = this.table!;
    const s = this.seats[seat];
    s.away = false;
    this.saveRoom();
    this.open.expiries[seat] = 0;
    if (t.bots.has(seat)) {
      t.botLeaves(seat);
      this.open.entries.push({ c: seat, bot: false, t: this.rt.now() });
    }
    // (A fresh clock: the old one ran down while the bot played.)
    this.open.clocks = { clocks: this.open.clocks.clocks.filter((c) => c.seat !== seat) };
    this.notice('all', 'back', seat);
    this.presence();
    this.broadcastRoom();
  }

  private backMsg(ws: RoomSocket, a: Attachment) {
    if (!this.playing(ws)) return;
    if (a.s == null || a.w) return this.error(ws, 'seat', 'You don’t hold a seat.');
    const s = this.seats[a.s];
    if (s.conceded || s.kicked) return this.error(ws, 'seat', 'You left this game.');
    if (!s.away) return;
    this.fromBot(a.s);
    this.advance();
  }

  private pause(ws: RoomSocket, a: Attachment, on: boolean) {
    if (!this.playing(ws)) return;
    if (a.s == null || a.w || !this.personAt(a.s)) return this.error(ws, 'seat', 'Only the people at the table can pause.');
    const now = this.rt.now();
    let p = this.open.pause;
    if (on) {
      if (!p) p = { by: a.s, votes: [], at: now, on: false };
      if (!p.votes.includes(a.s)) p.votes.push(a.s);
      const people = this.people().filter((s) => !s.away).length;
      if (!p.on && p.votes.length * 2 > people) {
        p.on = true;
        p.at = now;
        this.notice('all', 'paused', a.s);
      }
      this.open.pause = p;
    } else if (p) {
      if (p.on) this.notice('all', 'resumed', a.s);
      this.open.pause = null;
    }
    this.broadcastRoom();
    if (!this.open.pause) this.advance();
  }

  private concede(ws: RoomSocket, a: Attachment) {
    if (!this.playing(ws)) return;
    if (a.s == null || a.w) return this.error(ws, 'seat', 'You don’t hold a seat.');
    const s = this.seats[a.s];
    if (s.conceded) return;
    s.conceded = true;
    this.toBot(a.s, 'conceded');
    this.notice('all', 'conceded', a.s);
    this.broadcastRoom();
    if (this.people().length === 0) return this.abandon();
    this.advance();
  }

  private nudge(ws: RoomSocket, a: Attachment, seat: PlayerId) {
    if (!this.playing(ws)) return;
    if (a.s == null || a.w) return;
    const m = this.memoOf(ws);
    const now = this.rt.now();
    if (now - m.nudgedAt < NUDGE_GAP_MS) return this.error(ws, 'slow', 'Give them a moment.');
    const target = this.seats[seat];
    if (!target || seat === a.s || !this.personAt(seat)) return;
    const due = owed(this.table!.state).find((o) => o.seat === seat);
    if (!due) return;
    // (A turn only just begun isn't kept waiting yet: the hail comes once it has been.)
    const since = this.open.turnSince;
    if (due.kind === 'turn' && since?.key === due.key && now - since.at < HAIL_AFTER_MS - 5000) return this.error(ws, 'slow', 'Give them a moment.');
    m.nudgedAt = now;
    this.notice({ seat }, 'nudged', a.s);
    if (target.user && !this.online(seat)) {
      this.rt.waitUntil(this.rt.services.notify([target.user], { title: 'Your move', body: 'The table is waiting for you.', url: `/r/${this.rt.code}`, tag: `room-${this.rt.code}`, kind: 'move' }).catch(() => undefined));
    }
  }

  /** Looking for / Spare: each kind once, kinds the game has, none on both lists (what's looked for wins). */
  private wants(ws: RoomSocket, a: Attachment, looking: Card[], spare: Card[]) {
    if (!this.playing(ws)) return;
    if (a.s == null || a.w) return this.error(ws, 'seat', 'You don’t hold a seat.');
    const s = this.seats[a.s];
    if (s.kind !== 'human' || s.conceded || s.kicked) return this.error(ws, 'seat', 'You left this game.');
    const kinds = new Set(cardKinds(this.table!.state));
    const look = [...new Set(looking)].filter((c) => kinds.has(c));
    const give = [...new Set(spare)].filter((c) => kinds.has(c) && !look.includes(c));
    const next = look.length || give.length ? { looking: look, spare: give } : null;
    const all = this.open.wants ?? this.seats.map(() => null);
    if (JSON.stringify(next) === JSON.stringify(all[a.s] ?? null)) return;
    // (The turn under way's, carried with it: no row of its own, however often it changes.)
    all[a.s] = next;
    this.open.wants = all;
    this.broadcastRoom();
  }

  /**
   * A person's presenter has shown the game up to `seq`: once everyone at the table has, the
   * clocks waiting on it start now rather than at their cap.
   */
  private seen(ws: RoomSocket, a: Attachment, seq: number) {
    const m = this.memoOf(ws);
    m.seen = Math.max(m.seen, seq);
    // (Most `seen`s change nothing: no clocks to look at, nothing to keep. One that starts a clock
    // is a handler like any other: the timers go out, and the turn under way carries the clock.)
    if (a.w || a.s == null || this.meta?.phase !== 'playing' || !this.table || !this.releaseSeen()) this.out!.light = true;
  }

  /** The clocks waiting on records every person here has now shown start now (true when one did). */
  private releaseSeen(): boolean {
    if (!this.open.clocks.clocks.some((c) => c.seq !== undefined)) return false;
    let least = Infinity;
    for (const x of this.live()) {
      if (x.a.w || x.a.s == null || !this.personAt(x.a.s)) continue;
      least = Math.min(least, this.memoOf(x.ws).seen);
    }
    if (least === Infinity) return false;
    const now = this.rt.now();
    const next = release(this.open.clocks, least, now);
    if (!next) return false;
    // (The turn began when its clock did: being gone on it, and the hail, count from then.)
    const since = this.open.turnSince;
    if (since && since.at > now && this.open.clocks.clocks.some((c) => c.kind === 'turn' && c.key === since.key && c.seq !== undefined && c.seq <= least)) since.at = now;
    this.open.clocks = next;
    return true;
  }

  // ================================================================ hand-offs

  private async seatToken(seat: PlayerId, gen: number, exp: number): Promise<string> {
    const key = fromHex(this.rt.env.TOKEN_SECRET) ?? new TextEncoder().encode(this.rt.env.TOKEN_SECRET);
    const mac = await hmacSha256(key as Uint8Array<ArrayBuffer>, `seat|${this.rt.code}|${seat}|${gen}|${exp}`);
    return `${seat}.${gen}.${exp}.${b64url(mac.slice(0, 16))}`;
  }

  private async handoff(ws: RoomSocket, a: Attachment) {
    if (a.s == null || a.w) return this.error(ws, 'seat', 'You don’t hold a seat.');
    const s = this.seats[a.s];
    const token = await this.seatToken(a.s, s.gen, this.rt.now() + HANDOFF_MS);
    this.send(ws, { t: 'handoff', token });
  }

  /** A hand-off token presented in hello: the seat it names, now this user's (its generation bumped). */
  private async takeHandoff(token: string, user: string, mine: number): Promise<{ ok: true; seat: PlayerId } | { ok: false; error: string }> {
    const parts = token.split('.');
    if (parts.length !== 4) return { ok: false, error: 'That link isn’t a seat.' };
    const [seat, gen, exp] = parts.slice(0, 3).map(Number);
    const s = this.seats[seat];
    if (!s || s.kind !== 'human' || s.kicked || !Number.isInteger(gen) || !Number.isInteger(exp)) return { ok: false, error: 'That link isn’t a seat.' };
    const want = (await this.seatToken(seat, gen, exp)).split('.')[3];
    const got = fromB64url(parts[3]);
    const wantBytes = fromB64url(want)!;
    if (!got || !sameBytes(got, wantBytes)) return { ok: false, error: 'That link isn’t a seat.' };
    if (exp < this.rt.now()) return { ok: false, error: 'That link has run out.' };
    if (gen !== s.gen) return { ok: false, error: 'That link was used already.' };
    if (mine >= 0 && mine !== seat) return { ok: false, error: 'You hold another seat here.' };
    if (s.user === user) return { ok: true, seat };
    const old = s.user;
    s.user = user;
    s.gen++;
    this.saveRoom();
    // (Its sockets hold the old generation now: the room no longer counts them, so close them by their attachments.)
    for (const ws of this.rt.sockets()) {
      const a = this.att(ws);
      if (a.u === old && a.s === seat) {
        this.send(ws, { t: 'notice', kind: 'handedOff', seat });
        ws.close(4409, 'This seat moved to another device.');
      }
    }
    if (this.meta!.host === old) this.meta!.host = user;
    this.saveRoom();
    // (A seat moved to another device is kept at once, even in the harbour: the old link must stay dead.)
    this.flushHarbour();
    return { ok: true, seat };
  }

  // ================================================================ table talk

  private chatFor(a: Attachment): ChatLine[] {
    const blocked = this.blockedSet(a.u!);
    return this.chat.filter((l) => this.visible(l, a, blocked));
  }

  private blockedSet(user: string): Set<string> {
    return new Set(this.blockedBy.get(user) ?? []);
  }

  private visible(l: ChatLine, a: Attachment, blocked: Set<string>) {
    if (l.to !== undefined && (a.s !== l.to || a.w)) return false;
    if (a.q && l.text !== undefined && !l.bot && l.from !== null) return false;
    if (l.from !== null && !l.bot) {
      const u = this.seats[l.from]?.user;
      if (u && blocked.has(u)) return false;
    }
    return true;
  }

  private addLine(line: Omit<ChatLine, 'id' | 'at'>) {
    const l: ChatLine = { id: (this.chat.at(-1)?.id ?? 0) + 1, at: this.rt.now(), ...line };
    this.chat.push(l);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.queueMsg((x) => this.visible(l, x, this.blockedSet(x.u!)), { t: 'chat', line: l });
  }

  private takeTalk() {
    for (const l of this.talk?.take() ?? []) {
      const line: Omit<ChatLine, 'id' | 'at'> = { from: l.from, text: l.text, bot: true };
      if (l.to !== undefined) line.to = l.to;
      if (l.offer) line.offer = { give: l.offer.give, get: l.offer.get };
      this.addLine(line);
    }
  }

  private async chatMsg(ws: RoomSocket, a: Attachment, msg: Extract<ClientMsg, { t: 'chat' }>) {
    if (a.s == null || a.w) return this.error(ws, 'chat', 'Take a seat to talk.');
    if ((msg.text === undefined) === (msg.quick === undefined)) return this.error(ws, 'bad', 'Say one thing: words or a quick word.');
    const m = this.memoOf(ws);
    const now = this.rt.now();
    m.chats = m.chats.filter((t) => now - t < 10_000);
    if (m.chats.length >= CHAT_BURST) return this.error(ws, 'slow', 'Slow down a little.');
    m.chats.push(now);
    const seat = a.s;
    if (msg.quick) {
      this.addLine({ from: seat, quick: msg.quick });
      this.talk?.hear(seat, undefined, msg.quick);
      return this.takeTalk();
    }
    if (!this.meta!.settings.freeChat) return this.error(ws, 'chat', 'This room uses quick talk only.');
    if (a.q) return this.error(ws, 'chat', 'Your papers say quick talk only.');
    const text = await this.rt.services.moderate(msg.text!, 'chat').catch(() => null);
    if (!text) return this.error(ws, 'chat', 'That can’t be said here.');
    this.addLine({ from: seat, text: text.slice(0, CHAT_MAX) });
    // (Every listener's blocks, for those who joined before the room last slept.)
    for (const x of this.live()) if (!this.blockedBy.has(x.a.u!)) this.blockedBy.set(x.a.u!, await this.rt.services.blocked(x.a.u!).catch(() => []));
    this.talk?.hear(seat, text, undefined);
    this.takeTalk();
  }

  private async report(ws: RoomSocket, a: Attachment, msg: Extract<ClientMsg, { t: 'report' }>) {
    const m = this.memoOf(ws);
    const now = this.rt.now();
    m.reports = m.reports.filter((t) => now - t < 3_600_000);
    if (m.reports.length >= REPORTS_PER_HOUR) return this.error(ws, 'slow', 'You’ve sent a lot of reports.');
    const about = this.seats[msg.seat];
    if (!about || about.kind !== 'human' || !about.user || about.user === a.u) return this.error(ws, 'seat', 'Nobody to report there.');
    m.reports.push(now);
    const chat = this.chat.slice(-30);
    const r = { room: this.rt.code, from: a.u!, about: about.user, reason: msg.reason, note: msg.note, chat };
    this.store.addReport(now, r);
    await this.rt.services.report(r).catch(() => undefined);
    this.notice({ socket: ws }, 'reported', msg.seat);
  }

  // ================================================================ the clocks

  /** After a handler's moves: the clocks recomputed, and sent when they changed. */
  private tick() {
    const t = this.table;
    if (!t || t.over) return;
    const now = this.rt.now();
    const out = this.out!;
    const presented = out.recs.size > 0 ? out.wait + PRESENT_ALLOWANCE_MS : t.state.seq === 0 ? OPENING_ALLOWANCE_MS : 0;
    const stopped = !!this.open.pause?.on || this.allGone();
    // (Someone not here, since when: kept, so being gone on one's turn runs out at a fixed time.)
    for (const s of this.people()) {
      const here = this.online(s.seat);
      if (!here && this.open.goneAt[s.seat] == null) this.open.goneAt[s.seat] = now;
      else if (here && this.open.goneAt[s.seat] != null) this.open.goneAt[s.seat] = null;
    }
    // (After a rebuild the clocks the room had come back with it; any it didn't start from the last move's time.)
    const startAt = this.clocksFrom !== null ? Math.min(this.clocksFrom, now + presented) : now + presented;
    this.clocksFrom = null;
    this.open.clocks = nextClocks(this.open.clocks, { state: t.state, settings: this.meta!.settings, people: (p) => this.personAt(p), acted: out.acted, startAt, seq: t.state.seq, now, stopped });
    // (A clock restarted on records everyone has already shown, after a pause, starts now.)
    this.releaseSeen();
    // When the turn's player's turn began (for being gone on it).
    const turn = owed(t.state)[0];
    if (turn && this.open.turnSince?.key !== turn.key) this.open.turnSince = { key: turn.key, at: startAt };
    const timers = timersView(this.open.clocks, now, stopped);
    if (sameTimers(this.lastTimers, timers)) return;
    this.lastTimers = timers;
    let carried = false;
    for (const list of out.recs.values()) {
      if (!list.length) continue;
      const last = list.length - 1;
      list[last] = { ...list[last], timers };
      carried = true;
    }
    // (Seats whose records carried none hear it on its own: everyone, when no record went out.)
    if (!carried) this.queueMsg('all', { t: 'timers', timers });
    else this.queueMsg((x) => this.viewKeyOf(x) === null, { t: 'timers', timers });
  }

  private async onAlarm() {
    const m = this.meta;
    if (!m) return;
    const now = this.rt.now();
    // A finished room keeps its summary a while, then goes.
    if ((m.phase === 'over' || m.phase === 'abandoned') && m.endedAt !== undefined && now >= m.endedAt + OVER_KEEP_MS) return this.wipe();
    if (m.phase === 'harbour' && this.live().length === 0 && m.idleSince !== undefined && now >= m.idleSince + HARBOUR_IDLE_MS) return this.wipe();
    this.armHostGone();
    if (this.hostGoneAt !== null && now >= this.hostGoneAt + HOST_GRACE_MS) this.passHost();
    if (m.phase !== 'playing' || !this.table || this.table.over) return;
    if (this.open.allGoneSince !== null && this.allGone() && now >= this.open.allGoneSince + ABANDON_MS) return this.abandon();
    const p = this.open.pause;
    if (p?.on && now >= p.at + PAUSE_MAX_MS) {
      this.open.pause = null;
      this.notice('all', 'resumed');
      this.broadcastRoom();
    }
    if (!this.open.pause?.on && !this.allGone()) {
      for (const c of expired(this.open.clocks, now)) this.timeout(c);
      const gone = this.goneDue();
      if (gone && now >= gone.at) {
        this.toBot(gone.seat, 'away');
        this.broadcastRoom();
      }
    }
    this.advance();
  }

  /** The turn's player is a person who isn't here: when they go to a bot. */
  private goneDue(): { seat: PlayerId; at: number } | null {
    const t = this.table;
    if (!t) return null;
    const seat = t.state.currentPlayer;
    if (!this.personAt(seat) || this.online(seat)) return null;
    const since = Math.max(this.open.goneAt[seat] ?? this.rt.now(), this.open.turnSince?.key === owed(t.state)[0]?.key ? this.open.turnSince.at : 0);
    return { seat, at: since + AFK_GONE_MS };
  }

  /** A clock ran out: a bot plays that seat's move (and after AFK_EXPIRIES in a row, the seat). */
  private timeout(c: Clock) {
    const t = this.table!;
    const seat = c.seat;
    if (!this.personAt(seat) || !owed(t.state).some((o) => o.seat === seat && o.key === c.key)) return;
    this.open.clocks = { clocks: this.open.clocks.clocks.filter((x) => x !== c) };
    this.open.expiries[seat] = (this.open.expiries[seat] ?? 0) + 1;
    this.notice('all', 'timeout', seat);
    if (this.open.expiries[seat] >= AFK_EXPIRIES) {
      this.toBot(seat, 'away');
      this.broadcastRoom();
      return;
    }
    if (c.kind === 'decision') {
      const tr = t.state.trade;
      const action: Action | null = c.key.startsWith('x') && tr ? { type: 'respondTrade', accept: false, offer: tr.id } : t.botMoveFor(seat);
      if (action) this.commit(seat, action, { by: 'timer' });
      return;
    }
    // The turn: whatever it still owes (a roll, the robber, a placement) as a bot would, then the turn ends.
    const turn = t.state.turn;
    for (let i = 0; i < 30 && !t.over && t.state.currentPlayer === seat && t.state.turn === turn; i++) {
      const s = t.state;
      let action: Action | null;
      if (s.phase === 'main' && s.pending.length === 0) action = s.trade && s.trade.proposer === seat ? { type: 'cancelTrade', offer: s.trade.id } : { type: 'endTurn' };
      else action = t.botMoveFor(seat);
      if (!action) break;
      const r = this.commit(seat, action, { by: 'timer' });
      if (!r.ok) break;
      // (A decision that is someone else's now: their own clock runs for it.)
      if (owed(t.state).some((o) => o.seat !== seat && o.kind === 'decision')) break;
      if (t.state.phase === 'setupSettlement' || t.state.phase === 'setupRoad') {
        if (t.state.currentPlayer !== seat) break;
      }
    }
  }

  // ================================================================ word from the table

  /** The people still in this game, for the notes. */
  private crew(): SeatState[] {
    return this.seats.filter((s) => s.kind === 'human' && s.user && !s.kicked && !s.conceded);
  }

  private island(user: string | undefined): string {
    const host = this.seats.find((s) => s.kind === 'human' && s.user === this.meta!.host);
    return islandName(host?.name, !!user && user === this.meta!.host);
  }

  /** A note to one person. */
  private note(user: string, n: { title: string; body: string }, kind: NoteKind, expires?: number) {
    const code = this.rt.code;
    const sent = this.rt.services.notify([user], { ...n, url: `/r/${code}`, tag: `room-${code}`, kind, ...(expires !== undefined && { expires }) });
    this.rt.waitUntil(sent.catch(() => undefined));
  }

  /**
   * Word to those the table waits on and who aren't at it: once while they're away, when it's their
   * turn or an offer awaits them. And the end of the game, to those who weren't there to see it.
   */
  private tell() {
    const m = this.meta!;
    if (this.overTell) {
      this.overTell = false;
      const w = m.results?.winner ?? null;
      for (const s of this.crew()) {
        if (this.online(s.seat)) continue;
        this.note(s.user!, overNote(this.island(s.user), w === null ? null : (this.seats[w]?.name ?? null), w === s.seat), 'over');
      }
      return;
    }
    const t = this.table;
    if (m.phase !== 'playing' || !t || t.over || this.open.pause?.on) return;
    const told = (this.open.told ??= []);
    const name = (p: PlayerId) => this.seats[p]?.name ?? 'Someone';
    for (const o of owed(t.state)) {
      const s = this.seats[o.seat];
      if (!this.personAt(o.seat) || !s.user) continue;
      if (told[o.seat] === 'live' || this.online(o.seat)) continue;
      told[o.seat] = 'live';
      const recent = this.recent && this.recent.seat !== o.seat ? this.recent.text : undefined;
      this.note(s.user, moveNote({ state: t.state, seat: o.seat, kind: o.kind, name, island: this.island(s.user), recent }), 'move');
    }
  }

  // ================================================================ the end

  /** The game just ended: the results, and the dice key revealed with the whole log. */
  private markOver() {
    const m = this.meta!;
    const t = this.table!;
    m.phase = 'over';
    m.endedAt = this.rt.now();
    m.results = this.results();
    this.overTell = true;
    this.writeJournal('end');
    this.saveRoom();
    this.reveal = this.revealMsg();
    this.lastTimers = null;
    this.queueMsg('all', this.reveal);
    this.broadcastRoom();
    this.log('over', { turns: t.state.turn, seq: t.state.seq });
  }

  private abandon() {
    const m = this.meta!;
    m.phase = 'abandoned';
    m.endedAt = this.rt.now();
    this.overTell = true;
    if (this.table) {
      this.journal.turns.push([this.open.turn, this.open.entries]);
      this.open = { ...this.open, entries: [] };
      m.results = this.results();
      this.reveal = this.revealMsg();
      this.queueMsg('all', this.reveal);
      this.writeJournal('end');
    }
    this.saveRoom();
    this.notice('all', 'abandoned');
    this.broadcastRoom();
    this.overPending = false;
    this.rt.waitUntil(this.archive());
  }

  private results(): Results {
    const t = this.table!;
    const s = t.state;
    const points = t.points();
    const standings = this.seats
      .map((x) => ({ seat: x.seat, points: points[x.seat], ...(x.conceded ? { conceded: true } : {}), ...(x.away && !x.conceded ? { away: true } : {}) }))
      .sort((a, b) => (b.seat === s.winner ? 1 : 0) - (a.seat === s.winner ? 1 : 0) || b.points - a.points);
    const awards: NonNullable<Results['awards']> = [];
    const best = (xs: number[], award: string) => {
      const max = Math.max(...xs);
      if (max > 0) awards.push({ seat: xs.indexOf(max), award, value: max });
    };
    if (s.longestRoadHolder !== null) awards.push({ seat: s.longestRoadHolder, award: 'longestRoute', value: s.players[s.longestRoadHolder].longestRoad });
    if (s.largestArmyHolder !== null) awards.push({ seat: s.largestArmyHolder, award: 'largestArmy', value: s.players[s.largestArmyHolder].playedKnights });
    best(t.stats.trades, 'mostTrades');
    best(t.stats.harvest, 'bestHarvest');
    best(t.stats.sevens, 'mostSevens');
    best(t.stats.robbed, 'mostRobbed');
    return { winner: s.winner, standings, turns: s.turn, durationMs: (this.meta!.endedAt ?? this.rt.now()) - (this.meta!.startedAt ?? this.rt.now()), awards };
  }

  /** Every action of the game, in order: the turns closed (stored, and the journal's newest chunk, written or not) and the one under way. */
  private fullLog(): Extract<LogEntry, { p: PlayerId }>[] {
    const mine = new Set(this.journal.turns.map(([turn]) => turn));
    const stored = this.store.turns().filter((t) => !mine.has(t.turn));
    return [...stored.flatMap((t) => t.entries), ...this.journal.turns.flatMap(([, entries]) => entries), ...this.open.entries].filter(isAction);
  }

  private revealMsg(): Extract<ServerMsg, { t: 'reveal' }> {
    const m = this.meta!;
    return {
      t: 'reveal',
      key: m.key,
      nonces: this.seats.map((s) => s.nonce ?? null),
      log: this.fullLog().map((e) => ({ actor: e.p, action: e.a })),
      options: m.options ?? {},
    };
  }

  /** The finished game to the services (its replay, ratings and stats), then its replay id to the table. */
  private async archive() {
    const m = this.meta!;
    const t = this.table;
    if (!t || !m.results) return;
    const game: FinishedGame = {
      room: this.rt.code,
      options: m.options,
      seats: this.seats.map((s) => ({ seat: s.seat, user: s.user, name: s.name, color: s.color, bot: s.kind === 'bot', difficulty: s.difficulty, away: s.away, conceded: s.conceded })),
      log: this.reveal?.log ?? [],
      key: m.key,
      nonces: this.seats.map((s) => s.nonce ?? null),
      winner: m.results.winner,
      points: t.points(),
      turns: t.state.turn,
      startedAt: m.startedAt ?? 0,
      endedAt: m.endedAt ?? this.rt.now(),
      rated: m.settings.rated,
      ...(m.phase === 'abandoned' && { abandoned: true }),
    };
    try {
      const r = await this.rt.services.finishGame(game);
      m.results.replay = r.replay;
      if (r.ratings) {
        m.results.ratings = r.ratings.flatMap((x) => {
          const seat = this.seats.find((s) => s.user === x.user)?.seat;
          return seat === undefined ? [] : [{ seat, before: x.before, after: x.after, tier: x.tier }];
        });
      }
      this.saveRoom();
      const info = this.info();
      for (const { ws } of this.live()) this.send(ws, { t: 'room', room: info });
    } catch (e) {
      this.log('archiveFailed', { error: String((e as Error)?.message ?? e).slice(0, 120) });
    }
  }

  /** "Sail again": a new room, the same seats invited. */
  private async rematch(ws: RoomSocket, a: Attachment) {
    const m = this.meta!;
    if (m.phase !== 'over' && m.phase !== 'abandoned') return this.error(ws, 'phase', 'The game isn’t over.');
    if (m.rematch) return this.send(ws, { t: 'room', room: this.info() });
    const create = this.rt.services.createRoom;
    if (!create) return this.error(ws, 'rematch', 'Not on this server.');
    const init: RoomInit = {
      host: { user: a.u!, name: a.nm ?? 'Sailor' },
      settings: { ...m.settings },
      custom: this.custom ?? undefined,
      seats: this.seats.flatMap((s): NonNullable<RoomInit['seats']> => {
        if (s.kind === 'human' && s.user && !s.kicked) return [{ seat: s.seat, kind: 'human', user: s.user, name: s.name, color: s.color, avatar: s.avatar }];
        if (s.kind === 'bot') return [{ seat: s.seat, kind: 'bot', name: s.name, color: s.color, avatar: s.avatar, difficulty: s.difficulty }];
        return [];
      }),
      from: this.rt.code,
    };
    try {
      const { code } = await create.call(this.rt.services, init);
      m.rematch = code;
      this.saveRoom();
      this.broadcastRoom();
    } catch {
      this.error(ws, 'rematch', 'Couldn’t make the next room.');
    }
  }

  /** Everything gone: the room's storage and its alarm (the sockets closed first). */
  private wipe() {
    for (const ws of this.rt.sockets()) {
      try {
        ws.close(4410, 'This room has closed.');
      } catch {
        // (Already closing.)
      }
    }
    this.log('closed', {});
    this.rt.deleteAll();
    this.meta = null;
    this.table = null;
    this.gone = true;
    this.alarmAt = null;
  }

  // ================================================================ persistence and the alarm

  /** Whether there's a game whose journal the room keeps. */
  private get game(): boolean {
    return !!this.table && !!this.meta && this.meta.phase !== 'harbour';
  }

  /** The turn under way has moved on from the journal's. */
  private openMoved(): boolean {
    return JSON.stringify(this.open) !== this.storedOpen;
  }

  /** Chat lines in neither the chat row nor the journal's tail. */
  private unkeptLines(): ChatLine[] {
    const kept = Math.max(this.chatStored, this.chatJournaled);
    return this.chat.filter((l) => l.id > kept);
  }

  /**
   * As a handler ends, before anything is sent: storage takes what must outlive a crash, and the
   * sockets carry the rest. The journal's newest chunk is written (one row) when a turn closed, when
   * the turn under way showed something drawn or hidden (so no reveal ever goes out that a crash
   * could take back: the output gate holds it until the write is confirmed), and when the last
   * socket closed and the turn under way had moved on; the chat row once enough lines wait for it
   * (CHAT_FLUSH_LINES, or CHAT_TAIL_MAX while the journal carries them). Quiet moves, the clocks and counters, the newest chat lines and a harbour's seats
   * ride in the carry, free, until one of those comes.
   */
  private async persist() {
    if (!this.meta || this.gone) return;
    const flush = this.flushDue;
    this.flushDue = false;
    if (this.game && (this.journalDue || this.revealPending)) this.writeJournal(this.journalDue ? 'turn' : 'reveal', await this.checkpoint());
    // (Chat ids run on by one, so the lines waiting are the difference.)
    const tailMax = this.game && this.meta.phase === 'playing' ? CHAT_TAIL_MAX : CHAT_FLUSH_LINES;
    if ((this.chat.at(-1)?.id ?? 0) - this.chatStored >= tailMax) this.writeChat();
    if (flush) this.spill('flush');
    await this.spread();
  }

  /**
   * The journal's newest chunk, written whole: its closed turns, the turn under way, the chat lines
   * newer than the chat row; and when `ck` is given, the checkpoint that closes it (the next write
   * starts the next chunk).
   */
  private writeJournal(why: JournalWhy, ck?: ChunkCheckpoint) {
    this.counters.journal[why]++;
    const rev = ++this.rev;
    const tail = this.chat.filter((l) => l.id > this.chatStored);
    const body: JournalBody<OpenRow> = { rev, turns: this.journal.turns, ...(ck && { ck }), open: this.open, ...(tail.length > 0 && { chat: tail }) };
    const text = JSON.stringify(body);
    this.store.writeChunk(this.journal.id, text);
    this.journalRev = rev;
    this.storedOpen = JSON.stringify(this.open);
    this.storedEntries = this.open.entries.length;
    if (tail.length) this.chatJournaled = tail[tail.length - 1].id;
    this.journalDue = false;
    this.revealPending = false;
    if (chunkSealed(body, text.length)) this.journal = { id: this.journal.id + 1, turns: [] };
  }

  /** The checkpoint a turn just closed asks for (the newest, if more than one), gzipped for its chunk. */
  private async checkpoint(): Promise<ChunkCheckpoint | undefined> {
    const c = this.checkpoints.at(-1);
    this.checkpoints = [];
    if (!c) return undefined;
    try {
      return { turn: c.turn, seq: c.seq, state: b64url(await gzip(c.json)), extra: c.extra };
    } catch (e) {
      this.log('checkpointFailed', { turn: c.turn, error: String((e as Error)?.message ?? e).slice(0, 120) });
      return undefined;
    }
  }

  private writeChat() {
    this.store.setChat(this.chat);
    this.chatStored = this.chat.at(-1)?.id ?? 0;
  }

  /** Everything the carry holds, into storage (the last socket closed, the carry doesn't fit, or there's nobody to carry it). */
  private spill(why: JournalWhy) {
    if (this.game && (this.journalDue || this.revealPending || this.openMoved())) this.writeJournal(why);
    if (this.unkeptLines().length) this.writeChat();
    this.flushHarbour();
  }

  /**
   * The carry to every socket that said hello: each holds all of it, so any one left is enough to
   * rebuild the room; gzipped when it doesn't fit as it is, and into storage when it doesn't fit
   * even so, or when nobody is here to carry it. (A socket's attachment also holds who it is: the
   * carry takes what's left of ATTACHMENT_MAX.)
   */
  private async spread() {
    const body: Carry = {};
    if (this.game && this.openMoved()) body.o = this.open;
    const lines = this.unkeptLines();
    if (lines.length) body.c = lines;
    if (this.harbourDirty) {
      body.s = this.seats;
      body.m = this.meta!;
    }
    const text = body.o || body.c || body.s ? JSON.stringify(body) : null;
    if (text !== this.carried) {
      this.carried = text;
      this.carryRev = text === null ? 0 : ++this.rev;
    }
    const here = this.live();
    if (text !== null && !here.length) return this.drop('alone');
    if (text === null) return this.strip(here);
    const r = this.carryRev;
    const fits = (k: CarryWire) => here.every((x) => attachmentSize({ ...x.a, k }) <= ATTACHMENT_MAX);
    let k: CarryWire = { ...body, r };
    if (!fits(k)) k = { r, z: b64url(await gzip(text)) };
    if (!fits(k)) return this.drop('big', here);
    let given = false;
    for (const x of here) {
      if (x.a.k?.r === r) continue;
      try {
        this.setAtt(x.ws, { ...x.a, k });
      } catch (e) {
        // (The platform counted it bigger than we did: storage takes the carry, so nothing is lost and the sends still go.)
        this.log('carryWriteFailed', { bytes: attachmentSize({ ...x.a, k }), error: String((e as Error)?.message ?? e).slice(0, 80) });
        return this.drop('big', here);
      }
      given = true;
    }
    if (given) {
      this.counters.carries++;
      if (k.z) this.counters.squeezed++;
    }
  }

  /** The carry can't ride (too big, or nobody here): storage takes it, and the sockets carry nothing. */
  private drop(why: JournalWhy, here: { ws: RoomSocket; a: Attachment }[] = []) {
    this.spill(why);
    this.carried = null;
    this.carryRev = 0;
    this.strip(here);
  }

  /** (Storage has it all: the sockets' carries are older revisions, and lighter gone.) */
  private strip(here: { ws: RoomSocket; a: Attachment }[]) {
    for (const x of here) {
      if (!x.a.k) continue;
      delete x.a.k;
      try {
        this.setAtt(x.ws, x.a);
      } catch {
        // (A socket closing as we write: its close comes next.)
      }
    }
  }

  /** When the room next needs to wake: the earliest of everything due. */
  private nextAlarm(): number | null {
    const m = this.meta;
    if (!m || this.gone) return null;
    const due: number[] = [];
    if (this.hostGoneAt !== null) due.push(this.hostGoneAt + HOST_GRACE_MS);
    if (m.phase === 'harbour' && m.idleSince !== undefined) due.push(m.idleSince + HARBOUR_IDLE_MS);
    if ((m.phase === 'over' || m.phase === 'abandoned') && m.endedAt !== undefined) due.push(m.endedAt + OVER_KEEP_MS);
    if (m.phase === 'playing' && this.table && !this.table.over) {
      const p = this.open.pause;
      if (p?.on) due.push(p.at + PAUSE_MAX_MS);
      const gone = this.allGone();
      if (gone && this.open.allGoneSince !== null) due.push(this.open.allGoneSince + ABANDON_MS);
      if (!p?.on && !gone) {
        const c = nextDue(this.open.clocks);
        if (c !== null) due.push(c);
        const g = this.goneDue();
        if (g) due.push(g.at);
        if (this.botsAt !== null) due.push(this.botsAt);
      }
    }
    return due.length ? Math.min(...due) : null;
  }

  /**
   * Set the alarm only when it must move earlier: each setAlarm is a row written, and never to the
   * time it has. An alarm earlier than anything due rings, finds nothing, and is set then: a ring
   * costs a request, a sixth of a row, and moving it later now would often be wasted, since
   * something earlier comes up meanwhile (a table's clocks, every turn).
   * Nor for a moment's difference (ALARM_SLACK_MS). The one exception: the harbour's alarm once the
   * game is under way (its reasons are all gone). (With nothing due it rings once for nothing:
   * deleting it would be a write too.)
   */
  private schedule() {
    const due = this.nextAlarm();
    if (due === null) return;
    const at = this.alarmAt;
    const stale = this.alarmStale;
    this.alarmStale = false;
    if (at !== null && at <= due + ALARM_SLACK_MS && !(stale && at < due)) return;
    this.rt.setAlarm(due);
    this.alarmAt = due;
    this.counters.alarmsSet++;
  }

  private log(ev: string, fields: Record<string, string | number | boolean>) {
    // Room codes, seats, codes and sizes only: never tokens, names or chat.
    if (ev === 'error' || ev.endsWith('Failed') || ev === 'botRefused') console.warn(JSON.stringify({ ev, room: this.rt.code, ...fields }));
  }
}

/**
 * An attachment's size as the platform counts it, near enough: its JSON, at two bytes a character
 * when any is past Latin-1 (a structured clone keeps such a string two bytes wide).
 */
function attachmentSize(a: Attachment): number {
  const s = JSON.stringify(a);
  return /[^\u0000-\u00ff]/.test(s) ? s.length * 2 : s.length;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
