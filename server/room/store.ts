// A room's own SQLite: what is kept, and every write it makes. Rows written are the bill (and a
// row deleted is billed as one written), so a room writes as little as it can and keeps few rows:
//
// - The log is a journal of chunks, one row each: the closed turns from one checkpoint to the next
//   (every CHECKPOINT_EVERY turns: the state, gzipped, with the bots' memories), the checkpoint
//   that ends it, and in the newest the turn under way with the table's clocks and counters
//   ('open') and the chat lines not yet in the chat row. The newest chunk is rewritten (one row) at
//   most once per handler: when a turn closed in it, when the turn under way drew from the dice or
//   the decks or showed anything hidden (so nothing a crash could take back was ever shown: see
//   Room.persist), and when the room's last socket closes. In between, the turn under way rides in
//   the sockets' attachments, which survive the room sleeping and cost nothing. A checkpoint rides
//   the write that closes its chunk, so it costs no row of its own.
// - The room's settings, phase and results, and its seats, are one row ('room' in meta).
// - Chat is one rolling row, rewritten once enough lines wait for it (Room's CHAT_FLUSH_LINES; while
//   the game is under way the journal's tail carries them, so CHAT_TAIL_MAX).
// - Nothing is deleted until the room is done with, when deleteAll() takes everything at once: a
//   finished base game leaves a handful of rows, not one per turn.
//
// (Rooms made before the journal kept a row per turn in `log`, the open turn in meta 'open', a
// row per seat in `seats` and their checkpoints in `checkpoints`: all are still read.)

import type { RoomSql, SqlValue } from '../core/ports';
import type { Action, PlayerId } from '../../src/engine';
import type { ChatLine } from '../../src/net/protocol';
import { fromB64url } from '../../src/net/codes';

const CHUNKS = 'CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, body TEXT NOT NULL)';

export const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS seats(seat INTEGER PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS log(turn INTEGER PRIMARY KEY, entries TEXT NOT NULL)',
  CHUNKS,
  'CREATE TABLE IF NOT EXISTS checkpoints(turn INTEGER PRIMARY KEY, seq INTEGER NOT NULL, state BLOB NOT NULL, extra TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY CHECK (id = 0), lines TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, v TEXT NOT NULL)',
];

/** A checkpoint every this many turns (and with it, the journal's next chunk). */
export const CHECKPOINT_EVERY = 25;
/** A chunk this big takes no more turns even without a checkpoint (one that couldn't be made). */
export const LOG_CHUNK_BYTES = 512 * 1024;

/**
 * One entry of the log: an action (`p` the seat, `n` the intent it answered, `by` who made it when
 * not the seat's own person: a bot, or a timer that ran out), or a seat changing hands (`c`: the
 * seat, `bot`: whether a bot plays it from here; its memory starts afresh). `t`: when (epoch ms).
 */
export type LogEntry =
  | { p: PlayerId; a: Action; n?: number; by?: 'bot' | 'timer'; t: number }
  | { c: PlayerId; bot: boolean; t: number };

export const isAction = (e: LogEntry): e is Extract<LogEntry, { p: PlayerId }> => 'p' in e;

/** A checkpoint as a chunk keeps it: the state gzipped (base64url), the table's extra (bots' memories, counters). */
export interface ChunkCheckpoint {
  turn: number;
  seq: number;
  state: string;
  extra: unknown;
}

/**
 * One journal chunk: closed turns in order; the checkpoint that closed it; the newest chunk's open
 * turn and chat tail; `rev`, the room's revision when written.
 */
export interface JournalBody<Open = unknown> {
  rev: number;
  turns: [number, LogEntry[]][];
  ck?: ChunkCheckpoint;
  open?: Open;
  /** Chat lines newer than the chat row's. */
  chat?: ChatLine[];
}

/** Whether a chunk takes no more turns: it has its checkpoint (or grew too big without one). */
export const chunkSealed = (body: { ck?: unknown }, bytes: number) => !!body.ck || bytes >= LOG_CHUNK_BYTES;

export class RoomStore {
  constructor(private sql: RoomSql) {}

  init() {
    for (const q of SCHEMA) this.sql.exec(q);
  }

  /** Whether this room was ever made (a lookup of an unknown code must leave no storage behind). */
  exists(): boolean {
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  getMeta<T>(k: string): T | null {
    const rows = this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray();
    return rows.length ? (JSON.parse(rows[0].v) as T) : null;
  }

  setMeta(k: string, v: unknown) {
    this.sql.exec('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }

  /** The room's row and its seats (kept in it; a room made before kept a row per seat in `seats`). */
  room<M extends object, S>(): { meta: M; seats: S[] } | null {
    const row = this.getMeta<M & { seats?: S[] }>('room');
    if (!row) return null;
    const { seats, ...meta } = row;
    return { meta: meta as M, seats: seats ?? this.sql.exec<{ v: string }>('SELECT v FROM seats ORDER BY seat').toArray().map((r) => JSON.parse(r.v) as S) };
  }

  /** The room's row with its seats: one row written, whichever changed. */
  setRoom(meta: object, seats: unknown[]) {
    this.setMeta('room', { ...meta, seats });
  }

  private chunksMade = false;

  /** A journal chunk, written whole (one row). `body` is its JSON. */
  writeChunk(id: number, body: string) {
    // (A room made before the journal has no table for it yet.)
    if (!this.chunksMade) this.sql.exec(CHUNKS);
    this.chunksMade = true;
    this.sql.exec('INSERT INTO chunks(id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body', id, body);
  }

  /** The journal's chunks, in order (none for a room made before it). */
  chunks<Open = unknown>(): { id: number; body: JournalBody<Open>; bytes: number }[] {
    if (!this.hasChunks()) return [];
    return this.sql
      .exec<{ id: number; body: string }>('SELECT id, body FROM chunks ORDER BY id')
      .toArray()
      .map((r) => ({ id: r.id, body: JSON.parse(r.body) as JournalBody<Open>, bytes: r.body.length }));
  }

  private hasChunks(): boolean {
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks'").toArray().length > 0;
  }

  /** Closed turns from `after` on (exclusive), in order: the journal's (`chunks`, when already read), and an older room's rows in `log`. */
  turns(after = -1, chunks: { body: JournalBody }[] = this.chunks()): { turn: number; entries: LogEntry[] }[] {
    const old = this.sql
      .exec<{ turn: number; entries: string }>('SELECT turn, entries FROM log WHERE turn > ? ORDER BY turn', after)
      .toArray()
      .map((r) => ({ turn: r.turn, entries: JSON.parse(r.entries) as LogEntry[] }));
    const journal = chunks.flatMap((c) => c.body.turns.filter(([t]) => t > after).map(([turn, entries]) => ({ turn, entries })));
    return old.length ? [...old, ...journal].sort((a, b) => a.turn - b.turn) : journal;
  }

  /** The newest checkpoint: the journal's (`chunks`, when already read), or an older room's row in `checkpoints`. */
  latestCheckpoint(chunks: { body: JournalBody }[] = this.chunks()): { turn: number; seq: number; state: Uint8Array; extra: unknown } | null {
    const ck = chunks.findLast((c) => c.body.ck)?.body.ck;
    const rows = this.sql.exec<{ turn: number; seq: number; state: SqlValue; extra: string }>('SELECT turn, seq, state, extra FROM checkpoints ORDER BY turn DESC LIMIT 1').toArray();
    const r = rows[0];
    if (ck && (!r || ck.turn >= r.turn)) return { turn: ck.turn, seq: ck.seq, state: fromB64url(ck.state)!, extra: ck.extra };
    if (!r) return null;
    const state = r.state instanceof Uint8Array ? r.state : new Uint8Array(r.state as unknown as ArrayBuffer);
    return { turn: r.turn, seq: r.seq, state, extra: JSON.parse(r.extra) };
  }

  chat(): ChatLine[] {
    const rows = this.sql.exec<{ lines: string }>('SELECT lines FROM chat WHERE id = 0').toArray();
    return rows.length ? (JSON.parse(rows[0].lines) as ChatLine[]) : [];
  }

  setChat(lines: ChatLine[]) {
    this.sql.exec('INSERT INTO chat(id, lines) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET lines = excluded.lines', JSON.stringify(lines));
  }

  addReport(at: number, v: unknown) {
    this.sql.exec('INSERT INTO reports(at, v) VALUES (?, ?)', at, JSON.stringify(v));
  }
}
