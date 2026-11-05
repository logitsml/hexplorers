// The ports over Cloudflare: D1 as the service database, R2 as the blob store (or, on an account
// without R2, a table in D1), a Durable Object namespace as the room directory, and the Worker's
// variables as the server's environment.

import { BUILD } from '../../src/net/build';
import type { BlobStore, ServerEnv, ServiceDb, SqlValue } from '../core/ports';
import { createServices, migrate, type RoomDirectory, type Services } from '../services';
import type { CfD1Database, CfDurableObjectNamespace, CfR2Bucket, WorkerEnv } from './types';

/** D1 and the Durable Object's SQL take blobs as ArrayBuffers. */
export const toBinding = (v: SqlValue): unknown => (v instanceof Uint8Array ? v.slice().buffer : v);

export class D1Db implements ServiceDb {
  constructor(private db: CfD1Database) {}

  async all<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Promise<T[]> {
    return (await this.db.prepare(query).bind(...bindings.map(toBinding)).all<T>()).results;
  }

  first<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Promise<T | null> {
    return this.db.prepare(query).bind(...bindings.map(toBinding)).first<T>();
  }

  async run(query: string, ...bindings: SqlValue[]) {
    const r = await this.db.prepare(query).bind(...bindings.map(toBinding)).run();
    return { changes: r.meta.changes, lastRowId: r.meta.last_row_id };
  }

  async batch(statements: { query: string; bindings: SqlValue[] }[]) {
    await this.db.batch(statements.map((s) => this.db.prepare(s.query).bind(...s.bindings.map(toBinding))));
  }
}

export class R2Blobs implements BlobStore {
  constructor(private bucket: CfR2Bucket) {}

  async get(key: string) {
    const o = await this.bucket.get(key);
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  }

  async put(key: string, value: Uint8Array, meta?: { contentType?: string }) {
    await this.bucket.put(key, value, meta?.contentType ? { httpMetadata: { contentType: meta.contentType } } : undefined);
  }

  delete(key: string) {
    return this.bucket.delete(key);
  }
}

/**
 * The blob store as a D1 table, for an account without R2 (bind BLOBS and R2 takes over). Its
 * blobs are small: a replay gzipped, a map (a row holds up to 2 MB).
 */
export class D1Blobs implements BlobStore {
  private made: Promise<unknown> | null = null;
  constructor(private db: D1Db) {}

  private table() {
    return (this.made ??= this.db.run('CREATE TABLE IF NOT EXISTS blobs(key TEXT PRIMARY KEY, value BLOB NOT NULL, type TEXT)').catch((e) => {
      this.made = null;
      throw e;
    }));
  }

  async get(key: string) {
    await this.table();
    const row = await this.db.first<{ value: ArrayBuffer | number[] }>('SELECT value FROM blobs WHERE key = ?', key);
    return row ? new Uint8Array(row.value) : null;
  }

  async put(key: string, value: Uint8Array, meta?: { contentType?: string }) {
    await this.table();
    await this.db.run('INSERT OR REPLACE INTO blobs(key, value, type) VALUES (?, ?, ?)', key, value, meta?.contentType ?? null);
  }

  async delete(key: string) {
    await this.table();
    await this.db.run('DELETE FROM blobs WHERE key = ?', key);
  }
}

/** Rooms by code: each code is one Durable Object (idFromName), told its code in a header. */
export class DoDirectory implements RoomDirectory {
  constructor(private ns: CfDurableObjectNamespace) {}

  fetch(code: string, path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    headers.set('x-room-code', code);
    return this.ns.get(this.ns.idFromName(code)).fetch(new Request(`https://room/${path}`, { ...init, headers }));
  }
}

export function serverEnv(env: WorkerEnv): ServerEnv {
  const s = (k: string) => (typeof env[k] === 'string' && env[k] ? (env[k] as string) : undefined);
  return {
    PUBLIC_URL: env.PUBLIC_URL,
    ALLOWED_ORIGINS: s('ALLOWED_ORIGINS'),
    TOKEN_SECRET: env.TOKEN_SECRET,
    BUILD: s('BUILD') ?? BUILD,
    TURNSTILE_SITE_KEY: s('TURNSTILE_SITE_KEY'),
    TURNSTILE_SECRET: s('TURNSTILE_SECRET'),
    VAPID_PUBLIC_KEY: s('VAPID_PUBLIC_KEY'),
    VAPID_PRIVATE_KEY: s('VAPID_PRIVATE_KEY'),
    VAPID_SUBJECT: s('VAPID_SUBJECT'),
    RESEND_API_KEY: s('RESEND_API_KEY'),
    EMAIL_FROM: s('EMAIL_FROM'),
    DISCORD_CLIENT_ID: s('DISCORD_CLIENT_ID'),
    DISCORD_CLIENT_SECRET: s('DISCORD_CLIENT_SECRET'),
  };
}

let migrated: Promise<void> | null = null;

/** The services for this isolate (the service tables made once per isolate: CREATE IF NOT EXISTS). */
export async function workerServices(env: WorkerEnv): Promise<{ services: Services; db: ServiceDb; blobs: BlobStore; rooms: RoomDirectory; env: ServerEnv }> {
  const db = new D1Db(env.DB);
  const blobs = env.BLOBS ? new R2Blobs(env.BLOBS) : new D1Blobs(db);
  const rooms = new DoDirectory(env.ROOMS);
  const senv = serverEnv(env);
  migrated ??= migrate(db).catch((e) => {
    migrated = null;
    throw e;
  });
  await migrated;
  return { services: createServices({ db, blobs, env: senv, rooms }), db, blobs, rooms, env: senv };
}
