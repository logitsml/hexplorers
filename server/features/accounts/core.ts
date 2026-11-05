// What the accounts feature's routes share: its tables, the account session tokens (and the
// identities they resolve to), the users' rows and their handles, the guest's upgrade into an
// account (the same id, so its record carries over), single-use flow ids, cookies and device
// labels. An account is a guest upgraded: `users.id` is the guest's id, and the guest's own token
// stops working once its row is gone. Only hashes of secrets are kept; nothing here logs.

import { NAME_MAX } from '../../../src/net/protocol';
import { b64url, newId, type RandomBytes } from '../../../src/net/codes';
import type { ServerEnv, ServiceDb } from '../../core/ports';
import { hmacSha256, sha256Hex, timingSafeEqual } from '../../lib/crypto';
import { moderateText } from '../../services/moderate';
import type { Identity } from '../../services';

/** What account code needs of its runtime (an HttpContext has all of it, as a feature's deps do). */
export interface AccountDeps {
  db: ServiceDb;
  env: ServerEnv;
  now(): number;
  random: RandomBytes;
}

// ------------------------------------------------------------------ tables

export const ACCOUNT_SCHEMA = [
  // (The handle's collation makes its uniqueness case-insensitive: handles are ASCII only.)
  'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, handle TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL, avatar INTEGER NOT NULL DEFAULT -1, color TEXT NOT NULL DEFAULT \'red\', settings TEXT NOT NULL DEFAULT \'{}\', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, banned_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY, user TEXT NOT NULL, public_key TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL, transports TEXT NOT NULL, backed_up INTEGER NOT NULL, device TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER)',
  'CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user)',
  'CREATE TABLE IF NOT EXISTS oauth_links(provider TEXT NOT NULL, subject TEXT NOT NULL, user TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject))',
  'CREATE INDEX IF NOT EXISTS oauth_links_user ON oauth_links(user)',
  'CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user TEXT NOT NULL, token_hash TEXT NOT NULL, device TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user)',
  // An address is kept only when its owner asks for letters by email; sign-in needs only its keyed hash.
  'CREATE TABLE IF NOT EXISTS emails(user TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, address TEXT, notify INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS email_pending(hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, exp INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, address TEXT)',
  // Challenges, flow states and magic-link nonces once used (each until it would have expired anyway).
  'CREATE TABLE IF NOT EXISTS auth_used(id TEXT PRIMARY KEY, exp INTEGER NOT NULL)',
  // A row per person per finished game (guests too, so an upgrade keeps them): the record and "recent sailors".
  'CREATE TABLE IF NOT EXISTS plays(user TEXT NOT NULL, replay TEXT NOT NULL, seat INTEGER NOT NULL, points INTEGER NOT NULL, won INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user, replay))',
  'CREATE INDEX IF NOT EXISTS plays_replay ON plays(replay)',
  'CREATE INDEX IF NOT EXISTS plays_user_at ON plays(user, at)',
  // A guest who signed in to an account they had: rooms that still name the guest's id in a seat read it as the account.
  'CREATE TABLE IF NOT EXISTS guest_alias(guest TEXT PRIMARY KEY, account TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS guest_alias_account ON guest_alias(account)',
];

// ------------------------------------------------------------------ hooks for the features after this one

/**
 * What other features add to an account: their part of the export, what erasing a person removes
 * of theirs, and fields on the public profile (ratings will add its tier here). Pushed to once,
 * when a feature's module loads.
 */
export const ACCOUNT_HOOKS = {
  export: [] as ((db: ServiceDb, user: string) => Promise<Record<string, unknown>>)[],
  erase: [] as ((db: ServiceDb, user: string) => Promise<void>)[],
  /** Statements that move a guest's rows into the account it signed in to (run in absorbGuest's one batch). */
  absorb: [] as ((guest: string, into: string) => { query: string; bindings: string[] }[])[],
  profile: [] as ((db: ServiceDb, user: string) => Promise<Record<string, unknown>>)[],
};

// ------------------------------------------------------------------ settings and the age band

/** Taken from a birth year (never kept), as features-social.md §1.4 asks: the band, not the date. */
export type AgeBand = 'u13' | '13-15' | '16-17' | '18+';

export interface AccountSettings {
  ageBand?: AgeBand;
  /** Free chat is an opt-in, and only for a band of 13 or over; quick talk otherwise. */
  chat?: 'quick' | 'free';
  /** The client's own preferences (at most 2 KB of JSON). */
  prefs?: Record<string, unknown>;
}

/**
 * A birth year's band, counted as the youngest it could mean (someone born in 2013 may still be 12
 * in 2026), so a band never says older than the person is.
 */
export function ageBand(birthYear: number, now: number): AgeBand {
  const age = new Date(now).getUTCFullYear() - birthYear - 1;
  return age < 13 ? 'u13' : age < 16 ? '13-15' : age < 18 ? '16-17' : '18+';
}

export function readSettings(json: string | null | undefined): AccountSettings {
  try {
    const s = JSON.parse(json ?? '{}') as AccountSettings;
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

/** Quick talk only: an account that hasn't opted into free chat, or is under 13. */
export const quickOnly = (s: AccountSettings) => s.ageBand === 'u13' || s.chat !== 'free';

// ------------------------------------------------------------------ handles

export const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;

/** Handles that would pass for the game, its staff or its crew. */
const RESERVED = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'moderators', 'support', 'staff', 'system', 'official', 'help', 'root', 'null', 'undefined',
  'exploratory', 'hexplore', 'hexplorers', 'anonymous', 'guest', 'host', 'crew', 'bot', 'bots', 'bramble', 'harbourmaster', 'harbour', 'me', 'you', 'formersailor',
]);

/** What's wrong with a handle (in words), or null when it may be had. */
export function handleProblem(handle: string): string | null {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) return 'A handle is 3 to 20 letters, digits or underscores.';
  if (/^[\d_]+$/.test(handle)) return 'A handle needs a letter or two.';
  if (RESERVED.has(handle.toLowerCase()) || RESERVED.has(handle.toLowerCase().replace(/[\d_]+$/, ''))) return 'That handle is kept for the harbour.';
  // (Each word in it on its own as well, "Big" and "Rude" in BigRude1: split at underscores and
  // capitals, digits kept for their leetspeak, and split at the digits too.)
  const words = [...handle.split(/_+|(?<=[a-z])(?=[A-Z])/), ...handle.split(/[_\d]+|(?<=[a-z])(?=[A-Z])/)].filter(Boolean);
  if (moderateText(handle, 'name') === null || words.some((w) => moderateText(w, 'name') === null)) return 'That handle can’t be used here.';
  return null;
}

/** A handle made from a name: its letters as one word ("AmberGannet"), then four digits. */
export function handleFor(name: string, random: RandomBytes, digits = 4): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let base = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 14);
  if (base.length < 3 || handleProblem(base) !== null) base = 'Sailor';
  const b = random(4);
  const n = (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0) % 10 ** digits;
  return `${base}${String(n).padStart(digits, '0')}`;
}

/** A handle for this name that nobody has yet (it may still be taken by the time it's used). */
export async function freeHandle(d: AccountDeps, name: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const h = handleFor(name, d.random, i < 5 ? 4 : 6);
    if (!(await d.db.first('SELECT id FROM users WHERE handle = ?', h))) return h;
  }
  return handleFor('Sailor', d.random, 8);
}

// ------------------------------------------------------------------ users

export interface UserRow {
  id: string;
  handle: string;
  name: string;
  avatar: number;
  color: string;
  settings: string;
  created_at: number;
  last_seen: number;
  banned_at: number | null;
}

export const userRow = (db: ServiceDb, id: string) => db.first<UserRow>('SELECT * FROM users WHERE id = ?', id);

/** A guest's row, if it is still one (an account's guest row is gone). */
export const guestRow = (db: ServiceDb, id: string) => db.first<{ user: string; name: string; created_at: number }>('SELECT user, name, created_at FROM guests WHERE user = ?', id);

export interface AccountInit {
  /** The guest being upgraded (its id becomes the account's); none, or one that's gone: a new id. */
  guest?: string | null;
  handle?: string;
  settings?: AccountSettings;
}

/**
 * Make an account: the guest's own id, name and joining day when there is one (and its token stops
 * working, as its row goes), a new id otherwise. Returns the account's id; an id that is an account
 * already is returned as it is.
 */
export async function becomeAccount(d: AccountDeps, o: AccountInit = {}): Promise<string> {
  if (o.guest && (await d.db.first('SELECT id FROM users WHERE id = ?', o.guest))) return o.guest;
  const g = o.guest ? await guestRow(d.db, o.guest) : null;
  const id = g ? g.user : newId('u_', 9, d.random);
  const name = (g?.name && moderateText(g.name, 'name')) || `Deckhand ${1000 + (((d.random(2)[0] << 8) | d.random(2)[1]) % 9000)}`;
  const settings = JSON.stringify(o.settings ?? {});
  const created = g?.created_at ?? d.now();
  let handle = o.handle && handleProblem(o.handle) === null ? o.handle : await freeHandle(d, name);
  for (let i = 0; i < 6; i++) {
    const r = await d.db.run(
      'INSERT OR IGNORE INTO users(id, handle, name, avatar, color, settings, created_at, last_seen) VALUES (?, ?, ?, -1, \'red\', ?, ?, ?)',
      id, handle, name.slice(0, NAME_MAX), settings, created, d.now(),
    );
    if (r.changes === 1) break;
    // (The id is new, so it was the handle that someone else took meanwhile.)
    handle = await freeHandle(d, name);
    if (i === 5) throw new Error('No free handle.');
  }
  if (g) await d.db.run('DELETE FROM guests WHERE user = ?', g.user);
  return id;
}

/**
 * Someone who played as a guest on this device signed in to an account they had already: the
 * guest's record moves into it, and the guest is no more.
 */
export async function absorbGuest(d: AccountDeps, guest: string, into: string) {
  if (guest === into || !(await guestRow(d.db, guest)) || (await d.db.first('SELECT id FROM users WHERE id = ?', guest))) return;
  await d.db.batch([
    { query: 'UPDATE OR IGNORE plays SET user = ? WHERE user = ?', bindings: [into, guest] },
    { query: 'DELETE FROM plays WHERE user = ?', bindings: [guest] },
    { query: 'INSERT OR IGNORE INTO blocks(user, blocked) SELECT ?, blocked FROM blocks WHERE user = ? AND blocked != ?', bindings: [into, guest, into] },
    { query: 'DELETE FROM blocks WHERE user = ?', bindings: [guest] },
    ...ACCOUNT_HOOKS.absorb.flatMap((h) => h(guest, into)),
    { query: 'INSERT OR REPLACE INTO guest_alias(guest, account, at) VALUES (?, ?, ?)', bindings: [guest, into, d.now()] },
    { query: 'DELETE FROM guests WHERE user = ?', bindings: [guest] },
  ]);
}

/** The guest ids that became this account (see absorbGuest). */
export async function aliasesOf(db: ServiceDb, account: string): Promise<string[]> {
  return (await db.all<{ guest: string }>('SELECT guest FROM guest_alias WHERE account = ?', account)).map((r) => r.guest);
}

// ------------------------------------------------------------------ sessions

/** An account's bearer token: xa1.<session id>.<secret part>.<MAC>; only the part's hash is stored. */
export const SESSION_PREFIX = 'xa1';
const SESSION_RE = /^xa1\.(s_[A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{22})$/;
/** last_seen is written at most this often (each write is a row). */
const TOUCH_MS = 10 * 60_000;

const sessionMac = async (env: ServerEnv, sid: string, part: string) => b64url((await hmacSha256(env.TOKEN_SECRET, `session|${sid}|${part}`)).slice(0, 16));

/** A new session for this account, from this device; returns its token (shown once). */
export async function issueSession(d: AccountDeps, user: string, device: string): Promise<string> {
  const sid = newId('s_', 9, d.random);
  const part = b64url(d.random(24));
  const now = d.now();
  await d.db.run('INSERT INTO sessions(id, user, token_hash, device, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)', sid, user, await sha256Hex(part), device.slice(0, 48), now, now);
  return `${SESSION_PREFIX}.${sid}.${part}.${await sessionMac(d.env, sid, part)}`;
}

/** The session id in an account token (its public half), or null. */
export const sessionId = (token: string | null | undefined) => (token && SESSION_RE.exec(token)?.[1]) || null;

/** An account token's identity, or null (the MAC is checked before the database is asked). */
export async function identifySession(d: AccountDeps, token: string): Promise<Identity | null> {
  const m = SESSION_RE.exec(token);
  if (!m) return null;
  const [, sid, part, sig] = m;
  if (!timingSafeEqual(sig, await sessionMac(d.env, sid, part))) return null;
  const row = await d.db.first<{ user: string; token_hash: string; last_seen: number; name: string; handle: string; settings: string; banned_at: number | null }>(
    'SELECT s.user AS user, s.token_hash AS token_hash, s.last_seen AS last_seen, u.name AS name, u.handle AS handle, u.settings AS settings, u.banned_at AS banned_at FROM sessions s JOIN users u ON u.id = s.user WHERE s.id = ?',
    sid,
  );
  if (!row || !timingSafeEqual(row.token_hash, await sha256Hex(part))) return null;
  const now = d.now();
  if (now - row.last_seen > TOUCH_MS) {
    await d.db.batch([
      { query: 'UPDATE sessions SET last_seen = ? WHERE id = ?', bindings: [now, sid] },
      { query: 'UPDATE users SET last_seen = ? WHERE id = ?', bindings: [now, row.user] },
    ]);
  }
  return {
    user: row.user,
    name: row.name,
    handle: row.handle,
    guest: false,
    ...(row.banned_at && { banned: true }),
    ...(quickOnly(readSettings(row.settings)) && { quickTalk: true }),
  };
}

/** What a sign-in answers: the identity the client keeps (its token replaces the guest's). */
export async function signedIn(d: AccountDeps, user: string, token: string) {
  const u = await userRow(d.db, user);
  return { user, token, name: u?.name ?? '', handle: u?.handle, guest: false as const };
}

// ------------------------------------------------------------------ single use

/** Mark a challenge, flow or nonce used: true the first time only. */
export async function consume(d: AccountDeps, id: string, exp: number): Promise<boolean> {
  const now = d.now();
  await d.db.run('DELETE FROM auth_used WHERE exp < ?', now);
  return (await d.db.run('INSERT OR IGNORE INTO auth_used(id, exp) VALUES (?, ?)', id.slice(0, 200), Math.max(exp, now + 60_000))).changes === 1;
}

// ------------------------------------------------------------------ cookies, devices, origins

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) {
      try {
        return decodeURIComponent(part.slice(i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A short-lived, HttpOnly cookie for one path (Secure on https, and always with SameSite=None). */
export function cookie(env: ServerEnv, name: string, value: string, o: { path: string; maxAge: number; sameSite?: 'Lax' | 'None' }): string {
  const secure = env.PUBLIC_URL.startsWith('https:') || o.sameSite === 'None';
  return `${name}=${encodeURIComponent(value)}; Path=${o.path}; Max-Age=${o.maxAge}; HttpOnly; SameSite=${o.sameSite ?? 'Lax'}${secure ? '; Secure' : ''}`;
}

/** A device in a few words ("iPhone · Safari"), from its user agent, which itself is never kept. */
export function deviceLabel(ua: string | null): string {
  const u = ua ?? '';
  const os =
    /iPhone/.test(u) ? 'iPhone'
    : /iPad/.test(u) ? 'iPad'
    : /Android/.test(u) ? 'Android'
    : /CrOS/.test(u) ? 'Chromebook'
    : /Macintosh|Mac OS X/.test(u) ? 'Mac'
    : /Windows/.test(u) ? 'Windows'
    : /Linux/.test(u) ? 'Linux'
    : 'A device';
  const browser =
    /Edg(e|A|iOS)?\//.test(u) ? 'Edge'
    : /Firefox\/|FxiOS\//.test(u) ? 'Firefox'
    : /SamsungBrowser\//.test(u) ? 'Samsung Internet'
    : /Chrome\/|CriOS\//.test(u) ? 'Chrome'
    : /Safari\//.test(u) ? 'Safari'
    : '';
  return browser ? `${os} · ${browser}` : os;
}

/** The site's own origin, for links and redirects. */
export function siteOrigin(env: ServerEnv): string {
  try {
    return new URL(env.PUBLIC_URL).origin;
  } catch {
    return '';
  }
}

/** Origins a passkey may be used from: PUBLIC_URL's and ALLOWED_ORIGINS. */
export function siteOrigins(env: ServerEnv): string[] {
  const out = new Set<string>();
  if (siteOrigin(env)) out.add(siteOrigin(env));
  for (const o of (env.ALLOWED_ORIGINS ?? '').split(',')) if (o.trim()) out.add(o.trim().replace(/\/$/, ''));
  return [...out];
}
