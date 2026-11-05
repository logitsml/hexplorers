// The platform interfaces the room and the services are written against. Two runtimes implement
// them: server/node (node:sqlite and ws, for local play and development) and server/cloudflare (a
// Durable Object and D1, which the deployed game runs on). Nothing under server/room, server/services or server/http may import a
// platform API directly: only these.

/** A value SQLite stores. */
export type SqlValue = string | number | null | Uint8Array;

/** The rows of one statement (a Durable Object's SqlStorageCursor has this shape). */
export interface SqlCursor<T> extends Iterable<T> {
  toArray(): T[];
  /** The only row (throws when there is none, or more than one). */
  one(): T;
  readonly rowsWritten: number;
}

/**
 * A room's own database: synchronous, as a Durable Object's `ctx.storage.sql` is (and node:sqlite's
 * DatabaseSync). Writes inside one event handler commit together.
 */
export interface RoomSql {
  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

/** A client's socket as the room holds it (a hibernatable WebSocket on Cloudflare). */
export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Per-socket data that survives the room sleeping (at most 2 KB): who the socket is, and the room's carry (what it hasn't stored). */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** What a room gets from its runtime. One instance per room; the room may be evicted and rebuilt at any time. */
export interface RoomRuntime {
  readonly code: string;
  readonly sql: RoomSql;
  /** The sockets accepted for this room, optionally only those with a tag (e.g. 'seat:2', 'watch'). */
  sockets(tag?: string): RoomSocket[];
  /** Tags given when the socket was accepted. */
  tagsOf(socket: RoomSocket): string[];
  /** The single alarm: when it is due the runtime calls Room.alarm(). Setting it replaces the last one. */
  setAlarm(at: number): void;
  getAlarm(): number | null;
  deleteAlarm(): void;
  /** Wipe the room's storage and alarm (a finished room, once archived). */
  deleteAll(): void;
  now(): number;
  /** Cryptographic random bytes. */
  random(bytes: number): Uint8Array;
  /** Keep the runtime alive for work after a response (Cloudflare's waitUntil). */
  waitUntil(p: Promise<unknown>): void;
  readonly env: ServerEnv;
  /** The account-wide services (results, ratings, replays, push, moderation). */
  readonly services: RoomServices;
}

/** What a room asks of the rest of the server (async: on Cloudflare these go to D1 or the Worker). */
export interface RoomServices {
  /** Resolve a bearer token to its identity (guest or account), or null. */
  identify(token: string): Promise<{ user: string; name: string; handle?: string; guest: boolean; banned?: boolean; quickTalk?: boolean } | null>;
  /**
   * Guest ids that now belong to this account (a guest who signed in to an account they had): a room
   * that still names the guest in a seat hands the seat to the account. Optional: none without accounts.
   */
  aliases?(user: string): Promise<string[]>;
  /** A finished game: store its replay, ratings and stats; returns the replay id and rating changes. */
  finishGame(game: FinishedGame): Promise<{ replay: string; ratings?: { user: string; before: number; after: number; tier: string }[] }>;
  /**
   * Tell these users something (Web Push), e.g. "your move" to someone away from a live table, or a
   * friend's invitation. `kind` is what each person's preferences are asked about; `expires`, when
   * the note is stale.
   */
  notify(users: string[], note: { title: string; body: string; url: string; tag?: string; kind?: NoteKind; expires?: number }): Promise<void>;
  /** A report from a seat about another (kept for moderators with the chat around it). */
  report(r: { room: string; from: string; about: string; reason: string; note?: string; chat: unknown[] }): Promise<void>;
  /** Text checks for free chat and names: returns the text to show (masked), or null to drop it. */
  moderate(text: string, kind: 'chat' | 'name'): Promise<string | null>;
  /** Users this user has blocked (their chat is hidden from them; they are never matched together). */
  blocked(user: string): Promise<string[]>;
  /**
   * A person's standing for their seat: their rating tier and its value, and "Fair winds" (the share
   * of their recent games they saw through, 0..1). Optional: a server without ratings shows none.
   */
  standing?(user: string): Promise<{ tier?: string; rating?: number; reliability?: number } | null>;
  /**
   * Make another room ("Sail again": the same seats invited), returning its code. `init` is the
   * room's creation body (server/room's RoomInit). Optional: a runtime without it offers no rematch.
   */
  createRoom?(init: unknown): Promise<{ code: string }>;
}

/** What a notification is about (each person chooses which kinds they hear). */
export type NoteKind = 'move' | 'invite' | 'over' | 'friend';

export interface FinishedGame {
  room: string;
  options: unknown;
  seats: { seat: number; user?: string; name: string; color: string; bot: boolean; difficulty?: string; away?: boolean; conceded?: boolean }[];
  log: { actor: number; action: unknown }[];
  key: string;
  nonces: (string | null)[];
  winner: number | null;
  points: number[];
  turns: number;
  startedAt: number;
  endedAt: number;
  rated: boolean;
  /** Nobody was left at the table (it was abandoned), so nobody saw it through. */
  abandoned?: boolean;
}

/** The account-wide database (D1 on Cloudflare: asynchronous). */
export interface ServiceDb {
  all<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Promise<T[]>;
  first<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Promise<T | null>;
  run(query: string, ...bindings: SqlValue[]): Promise<{ changes: number; lastRowId: number }>;
  /** Several writes in one transaction. */
  batch(statements: { query: string; bindings: SqlValue[] }[]): Promise<void>;
}

/** Large blobs (replays, map files, OG images): R2 on Cloudflare, a folder locally. */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Configuration. Everything optional is a feature that is off until its key is set. Never log
 * these values.
 */
export interface ServerEnv {
  /** Where the site is served from (origin checks, links in notifications), e.g. http://localhost:5173. */
  PUBLIC_URL: string;
  /** Origins allowed to open sockets and post (comma-separated); defaults to PUBLIC_URL's origin. */
  ALLOWED_ORIGINS?: string;
  /** 32+ random bytes, hex: signs seat tokens, sessions and links. Generated on first run locally. */
  TOKEN_SECRET: string;
  /** Build id the server runs (clients on another PROTO are told to reload). */
  BUILD: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /** Email (magic links): Resend's API key and the From address. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Web Push: generated on first run locally (P-256, base64url). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}
