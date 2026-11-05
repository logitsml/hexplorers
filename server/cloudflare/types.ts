// The few Cloudflare Workers types the adapter uses, declared here instead of depending on
// @cloudflare/workers-types (written to the runtime's documented shapes; only what is used).

export interface CfSqlCursor<T> extends Iterable<T> {
  toArray(): T[];
  one(): T;
  readonly rowsWritten: number;
  readonly rowsRead: number;
}

export interface CfSqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): CfSqlCursor<T>;
}

export interface CfStorage {
  readonly sql: CfSqlStorage;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

/** A WebSocket as a Durable Object holds it (hibernatable). */
export interface CfWebSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface CfDurableObjectState {
  readonly id: { toString(): string; readonly name?: string };
  readonly storage: CfStorage;
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  getTags(ws: CfWebSocket): string[];
  setWebSocketAutoResponse(pair?: unknown): void;
  waitUntil(p: Promise<unknown>): void;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export interface CfDurableObjectId {
  toString(): string;
}

export interface CfDurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface CfDurableObjectNamespace {
  idFromName(name: string): CfDurableObjectId;
  get(id: CfDurableObjectId): CfDurableObjectStub;
}

export interface CfD1Result<T> {
  results: T[];
  meta: { changes: number; last_row_id: number };
}

export interface CfD1PreparedStatement {
  bind(...values: unknown[]): CfD1PreparedStatement;
  all<T>(): Promise<CfD1Result<T>>;
  first<T>(): Promise<T | null>;
  run(): Promise<CfD1Result<unknown>>;
}

export interface CfD1Database {
  prepare(query: string): CfD1PreparedStatement;
  batch(statements: CfD1PreparedStatement[]): Promise<unknown[]>;
}

export interface CfR2Bucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface CfFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface CfExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

/** The Worker's bindings and variables (see README.md for the wrangler config that would make them). */
export interface WorkerEnv {
  ROOMS: CfDurableObjectNamespace;
  DB: CfD1Database;
  /** Absent on an account without R2: the blobs go in D1 (see D1Blobs). */
  BLOBS?: CfR2Bucket;
  ASSETS: CfFetcher;
  PUBLIC_URL: string;
  TOKEN_SECRET: string;
  ALLOWED_ORIGINS?: string;
  /** The game's former hosts (comma-separated): their pages redirect to PUBLIC_URL's (worker.ts). */
  REDIRECT_HOSTS?: string;
  BUILD?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  [key: string]: unknown;
}

/** The runtime's globals the adapter needs (present in Workers, absent elsewhere). */
export interface CfGlobals {
  WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket };
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
}
