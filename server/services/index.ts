// The account-wide services, over the platform's service database and blob store: guests and
// their tokens, the finished games' replays, reports, blocks, and the notifications stub. Shared
// by both runtimes (and by every room through RoomServices).

import { NAME_MAX } from '../../src/net/protocol';
import { b64url, cryptoRandom, fromB64url, fromHex, gunzip, gzip, hex, hmacSha256, newId, roomCode, sameBytes, sha256, type RandomBytes } from '../../src/net/codes';
import type { BlobStore, FinishedGame, RoomServices, ServerEnv, ServiceDb } from '../core/ports';
import { moderateText } from './moderate';
import { extendServices, featureSchema } from '../features';

/** The service database's tables (D1 on Cloudflare, node:sqlite locally). Only hashes of secrets are kept. */
export const SERVICE_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS guests(user TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS replays(id TEXT PRIMARY KEY, room TEXT NOT NULL, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL, turns INTEGER NOT NULL, winner INTEGER)',
  'CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, from_user TEXT NOT NULL, about TEXT NOT NULL, reason TEXT NOT NULL, note TEXT, chat TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS blocks(user TEXT NOT NULL, blocked TEXT NOT NULL, PRIMARY KEY (user, blocked))',
  'CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL, tag TEXT, at INTEGER NOT NULL)',
];

/**
 * Tables of features that were taken out (the Daily Chart, Open waters, regattas, the shop, the
 * Discord activity, games by post). They are dropped, with their indexes, by the same batch that
 * makes the live ones: each statement is idempotent, so a database that never had them is fine.
 * (users.cosmetics, a column the shop wrote, is left where it is: nothing reads it.)
 */
export const RETIRED_SCHEMA = [
  'DROP TABLE IF EXISTS daily_plays',
  'DROP TABLE IF EXISTS match_queue',
  'DROP TABLE IF EXISTS regatta_heats',
  'DROP TABLE IF EXISTS regatta_entries',
  'DROP TABLE IF EXISTS regattas',
  'DROP TABLE IF EXISTS entitlements',
  'DROP TABLE IF EXISTS equipped',
  'DROP TABLE IF EXISTS discord_rooms',
  'DROP TABLE IF EXISTS voyages',
  'DROP TABLE IF EXISTS vacations',
];

/** The service tables, made if missing (and the retired ones dropped): one batch, so a new Worker isolate waits on D1 once, not once a table. */
export async function migrate(db: ServiceDb) {
  await db.batch([...SERVICE_SCHEMA, ...featureSchema(), ...RETIRED_SCHEMA].map((query) => ({ query, bindings: [] })));
}

/** Where the services reach the rooms (to make one: POST init on a fresh code). */
export interface RoomDirectory {
  fetch(code: string, path: string, init?: RequestInit): Promise<Response>;
}

export interface Identity {
  user: string;
  name: string;
  handle?: string;
  guest: boolean;
  banned?: boolean;
  /** Quick talk only (an account under 13, or one that hasn't opted into free chat): free text is neither sent nor shown. */
  quickTalk?: boolean;
}

export interface Services extends RoomServices {
  /** A new guest: a random id and a bearer token (shown once; only its hash is kept). */
  guest(name?: string): Promise<{ user: string; token: string; name: string }>;
  /** A finished game's replay (the JSON as stored), or null. */
  replay(id: string): Promise<string | null>;
  /** Make a room with this creation body on a fresh code. */
  createRoom(init: unknown): Promise<{ code: string }>;
  /**
   * The features' periodic work (the notes held through quiet hours, say), called about once a
   * minute by the runtime: a timer locally, a Cron Trigger on Cloudflare. Features wrap it.
   */
  tick?(): Promise<void>;
}

const TOKEN_PREFIX = 'xg1';

export function createServices(o: { db: ServiceDb; blobs: BlobStore; env: ServerEnv; rooms: RoomDirectory; now?: () => number; random?: RandomBytes }): Services {
  const { db, blobs, env, rooms } = o;
  const now = o.now ?? (() => Date.now());
  const random = o.random ?? cryptoRandom;
  const secret = (): Uint8Array<ArrayBuffer> => fromHex(env.TOKEN_SECRET) ?? (new TextEncoder().encode(env.TOKEN_SECRET) as Uint8Array<ArrayBuffer>);
  const mac = async (user: string, part: string) => (await hmacSha256(secret(), `guest|${user}|${part}`)).slice(0, 16);

  const services: Services = {
    async guest(name) {
      const user = newId('g_', 9, random);
      const part = b64url(random(24));
      const token = `${TOKEN_PREFIX}.${user}.${part}.${b64url(await mac(user, part))}`;
      const clean = (name && moderateText(name, 'name')) || `Deckhand ${1000 + (random(2)[0] * 256 + random(2)[1]) % 9000}`;
      await db.run('INSERT INTO guests(user, token_hash, name, created_at) VALUES (?, ?, ?, ?)', user, hex(await sha256(part)), clean.slice(0, NAME_MAX), now());
      return { user, token, name: clean.slice(0, NAME_MAX) };
    },

    async identify(token) {
      if (typeof token !== 'string' || token.length > 512) return null;
      const [prefix, user, part, sig] = token.split('.');
      if (prefix !== TOKEN_PREFIX || !user || !part || !sig) return null;
      // (The MAC first: a forged token never reaches the database.)
      const got = fromB64url(sig);
      if (!got || !sameBytes(got, await mac(user, part))) return null;
      const row = await db.first<{ token_hash: string; name: string }>('SELECT token_hash, name FROM guests WHERE user = ?', user);
      if (!row || row.token_hash !== hex(await sha256(part))) return null;
      return { user, name: row.name, guest: true };
    },

    async finishGame(game: FinishedGame) {
      const id = newId('', 12, random);
      const body = await gzip(JSON.stringify({ v: 1, id, ...game }));
      await blobs.put(`replays/${id}.json.gz`, body, { contentType: 'application/gzip' });
      await db.run('INSERT INTO replays(id, room, created_at, bytes, turns, winner) VALUES (?, ?, ?, ?, ?, ?)', id, game.room, now(), body.length, game.turns, game.winner);
      return { replay: id };
    },

    async replay(id) {
      if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) return null;
      const row = await db.first('SELECT id FROM replays WHERE id = ?', id);
      if (!row) return null;
      const blob = await blobs.get(`replays/${id}.json.gz`);
      return blob ? gunzip(blob) : null;
    },

    async notify(users, note) {
      // (Web Push comes later: until then each note is recorded, so the UI and tests can see what would go.)
      for (const user of users) await db.run('INSERT INTO notes(user, title, body, url, tag, at) VALUES (?, ?, ?, ?, ?, ?)', user, note.title, note.body, note.url, note.tag ?? null, now());
    },

    async report(r) {
      await db.run(
        'INSERT INTO reports(room, from_user, about, reason, note, chat, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        r.room, r.from, r.about, r.reason, r.note ?? null, JSON.stringify(r.chat).slice(0, 64_000), now(),
      );
    },

    async moderate(text, kind) {
      return moderateText(text, kind);
    },

    async blocked(user) {
      return (await db.all<{ blocked: string }>('SELECT blocked FROM blocks WHERE user = ?', user)).map((r) => r.blocked);
    },

    async createRoom(init) {
      for (let i = 0; i < 6; i++) {
        const code = roomCode(random);
        const r = await rooms.fetch(code, 'init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init) });
        if (r.status === 201) return { code };
        // (The room's own reason, "No such preset" or the like, is what the person reads.)
        if (r.status !== 409) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? 'The harbour couldn’t be opened.');
      }
      throw new Error('No free room code.');
    },
  };
  // (The features' hooks: accounts, push, ratings and the rest wrap what they extend.)
  extendServices(services, { db, blobs, env, rooms, now, random });
  return services;
}
