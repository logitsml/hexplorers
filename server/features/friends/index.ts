// Friends: asked for by handle (the friend code) or from the people you've played with ("recent
// sailors"), accepted, declined or let go; a list with when each was last seen and whether they're
// in a harbour or at sea (each says where they are as they join a room, and the room's own card
// says what it's doing now); and an invitation to your harbour, sent through services.notify
// (Web Push will deliver it once push is built). Both sides need an account: a guest has no
// handle to be found by. Under 13, friends come by handle only (features-social.md §1.5).

import * as v from 'valibot';
import { ROOM_CODE_RE } from '../../../src/net/protocol';
import { check } from '../../../src/net/schema';
import type { ServiceDb } from '../../core/ports';
import { body, fail, json, limited, originAllowed, who, type Handler, type HttpContext, type Route } from '../../http/kit';
import type { Feature } from '..';
import { ACCOUNT_HOOKS } from '../accounts';
import { readSettings } from '../accounts/core';

const MAX_FRIENDS = 200;
const MAX_ASKING = 50;
/** A friend's word of where they are holds this long (a room left without saying so goes quiet after it). */
const HERE_MS = 3 * 3_600_000;
/** Rooms looked in for a list (each a card fetched). */
const HERE_LOOKS = 12;

export const FRIENDS_SCHEMA = [
  // A friendship is two rows, one each way, so either side lists theirs with one index.
  'CREATE TABLE IF NOT EXISTS friends(user TEXT NOT NULL, friend TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (user, friend))',
  'CREATE TABLE IF NOT EXISTS friend_requests(from_user TEXT NOT NULL, to_user TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (from_user, to_user))',
  'CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests(to_user)',
  'CREATE TABLE IF NOT EXISTS presence(user TEXT PRIMARY KEY, room TEXT, at INTEGER NOT NULL)',
];

/** Two people stop being friends, and neither asks the other any more (a block does this too). */
export function dropFriendship(db: ServiceDb, a: string, b: string) {
  return db.batch([
    { query: 'DELETE FROM friends WHERE (user = ? AND friend = ?) OR (user = ? AND friend = ?)', bindings: [a, b, b, a] },
    { query: 'DELETE FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)', bindings: [a, b, b, a] },
  ]);
}

interface Sailor {
  user: string;
  handle?: string;
  name: string;
  avatar?: number;
  color?: string;
  guest: boolean;
}

/** How people are shown in lists: an account by its handle and face, a guest by its name. */
async function sailors(db: ServiceDb, users: string[]): Promise<Map<string, Sailor>> {
  const out = new Map<string, Sailor>();
  for (const user of new Set(users)) {
    const u = await db.first<{ handle: string; name: string; avatar: number; color: string; settings: string }>('SELECT handle, name, avatar, color, settings FROM users WHERE id = ?', user);
    if (u) {
      out.set(user, { user, handle: u.handle, name: readSettings(u.settings).ageBand === 'u13' ? u.handle : u.name, avatar: u.avatar, color: u.color, guest: false });
      continue;
    }
    const g = await db.first<{ name: string }>('SELECT name FROM guests WHERE user = ?', user);
    if (g) out.set(user, { user, name: g.name, guest: true });
  }
  return out;
}

const young = async (db: ServiceDb, user: string) => readSettings((await db.first<{ settings: string }>('SELECT settings FROM users WHERE id = ?', user))?.settings).ageBand === 'u13';

/** Whether either has blocked the other. */
const blockedEither = async (db: ServiceDb, a: string, b: string) => !!(await db.first('SELECT user FROM blocks WHERE (user = ? AND blocked = ?) OR (user = ? AND blocked = ?)', a, b, b, a));

/** The last people (not bots) this one played with, newest first. */
export async function recentSailors(db: ServiceDb, user: string, limit = 50): Promise<{ user: string; at: number }[]> {
  return db.all<{ user: string; at: number }>(
    'SELECT p2.user AS user, MAX(p1.at) AS at FROM plays p1 JOIN plays p2 ON p2.replay = p1.replay AND p2.user != p1.user WHERE p1.user = ? GROUP BY p2.user ORDER BY at DESC LIMIT ?',
    user, limit,
  );
}

/** Where a friend is, if they said so lately and the room is still going: in its harbour or at sea. */
async function whereIs(ctx: HttpContext, room: string | null, at: number): Promise<'harbour' | 'playing' | null> {
  if (!room || ctx.now() - at > HERE_MS || !ROOM_CODE_RE.test(room)) return null;
  try {
    const r = await ctx.rooms.fetch(room, 'card', { method: 'GET' });
    if (!r.ok) return null;
    const card = (await r.json()) as { phase?: string };
    return card.phase === 'harbour' ? 'harbour' : card.phase === 'playing' ? 'playing' : null;
  } catch {
    return null;
  }
}

async function account(req: Request, ctx: HttpContext) {
  const id = await who(req, ctx);
  if (!id) return { error: fail(401, 'Sign in again.') };
  if (id.guest) return { error: fail(403, 'Keep your progress first: friends need an account.', 'guest') };
  return { id };
}

// ------------------------------------------------------------------ the routes

const list: Handler = async (req, _p, ctx) => {
  const a = await account(req, ctx);
  if (a.error) return a.error;
  const me = a.id.user;
  const friends = await ctx.db.all<{ friend: string; since: number; last_seen: number | null; room: string | null; at: number | null }>(
    'SELECT f.friend AS friend, f.since AS since, u.last_seen AS last_seen, p.room AS room, p.at AS at FROM friends f LEFT JOIN users u ON u.id = f.friend LEFT JOIN presence p ON p.user = f.friend WHERE f.user = ? ORDER BY u.last_seen DESC',
    me,
  );
  const incoming = await ctx.db.all<{ from_user: string; at: number }>('SELECT from_user, at FROM friend_requests WHERE to_user = ? ORDER BY at DESC', me);
  const outgoing = await ctx.db.all<{ to_user: string; at: number }>('SELECT to_user, at FROM friend_requests WHERE from_user = ? ORDER BY at DESC', me);
  const blocked = new Set((await ctx.db.all<{ blocked: string }>('SELECT blocked FROM blocks WHERE user = ?', me)).map((r) => r.blocked));
  const known = new Set([me, ...friends.map((f) => f.friend), ...outgoing.map((o) => o.to_user), ...incoming.map((i) => i.from_user)]);
  const recent = (await recentSailors(ctx.db, me)).filter((r) => !known.has(r.user) && !blocked.has(r.user));
  const faces = await sailors(ctx.db, [...friends.map((f) => f.friend), ...incoming.map((i) => i.from_user), ...outgoing.map((o) => o.to_user), ...recent.map((r) => r.user)]);
  let looks = 0;
  const shown = [];
  for (const f of friends) {
    const s = faces.get(f.friend);
    if (!s) continue;
    const where = looks < HERE_LOOKS && f.room ? (looks++, await whereIs(ctx, f.room, f.at ?? 0)) : null;
    shown.push({ ...s, since: f.since, lastSeen: f.last_seen, ...(where && { where }) });
  }
  return json(200, {
    friends: shown,
    incoming: incoming.flatMap((i) => (faces.get(i.from_user) && !blocked.has(i.from_user) ? [{ ...faces.get(i.from_user)!, at: i.at }] : [])),
    outgoing: outgoing.flatMap((o) => (faces.get(o.to_user) ? [{ ...faces.get(o.to_user)!, at: o.at }] : [])),
    recent: recent.flatMap((r) => (faces.get(r.user) ? [{ ...faces.get(r.user)!, at: r.at }] : [])),
  });
};

const AskSchema = v.strictObject({ handle: v.optional(v.pipe(v.string(), v.maxLength(40))), user: v.optional(v.pipe(v.string(), v.maxLength(40))) });

const ask: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'friends', 20, 20)) return fail(429, 'Too many requests from here: wait a minute.');
  const a = await account(req, ctx);
  if (a.error) return a.error;
  const me = a.id.user;
  const b = check(AskSchema, await body(req, 1024));
  if (!b || (b.handle === undefined) === (b.user === undefined)) return fail(400, 'A handle or a sailor, please.');
  let them: string | null = null;
  if (b.handle !== undefined) {
    const handle = b.handle.trim().replace(/^@/, '');
    them = /^[A-Za-z0-9_]{3,20}$/.test(handle) ? ((await ctx.db.first<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle))?.id ?? null) : null;
    if (!them) return fail(404, 'Nobody sails under that handle.', 'unknown');
  } else {
    // (By id only for someone you've played with: ids aren't for looking people up.)
    if (!(await recentSailors(ctx.db, me, 200)).some((r) => r.user === b.user)) return fail(404, 'Ask them by their handle.', 'unknown');
    if (!(await ctx.db.first('SELECT id FROM users WHERE id = ?', b.user!))) return fail(400, 'They play as a guest: friends need an account on both sides.', 'guest');
    if ((await young(ctx.db, me)) || (await young(ctx.db, b.user!))) return fail(403, 'Ask them by their handle.', 'young');
    them = b.user!;
  }
  if (them === me) return fail(400, 'That’s you.', 'self');
  if (await ctx.db.first('SELECT friend FROM friends WHERE user = ? AND friend = ?', me, them)) return json(200, { state: 'friends' });
  // (Blocked either way: it looks sent, and nothing is.)
  if (await blockedEither(ctx.db, me, them)) return json(200, { state: 'asked' });
  const now = ctx.now();
  if (await ctx.db.first('SELECT from_user FROM friend_requests WHERE from_user = ? AND to_user = ?', them, me)) {
    await befriend(ctx, me, them);
    return json(200, { state: 'friends' });
  }
  const counts = await ctx.db.first<{ f: number; o: number }>('SELECT (SELECT COUNT(*) FROM friends WHERE user = ?) AS f, (SELECT COUNT(*) FROM friend_requests WHERE from_user = ?) AS o', me, me);
  if ((counts?.f ?? 0) >= MAX_FRIENDS) return fail(400, 'Your list is full.', 'full');
  if ((counts?.o ?? 0) >= MAX_ASKING) return fail(400, 'You’ve asked a lot of people: wait for some answers.', 'full');
  const r = await ctx.db.run('INSERT OR IGNORE INTO friend_requests(from_user, to_user, at) VALUES (?, ?, ?)', me, them, now);
  if (r.changes) await ctx.services.notify([them], { title: 'A friend request', body: `${a.id.name}${a.id.handle ? ` (@${a.id.handle})` : ''} would like to sail with you.`, url: '/?go=/multi', tag: 'friends', kind: 'friend' }).catch(() => undefined);
  return json(200, { state: 'asked' });
};

async function befriend(ctx: HttpContext, a: string, b: string) {
  const now = ctx.now();
  await ctx.db.batch([
    { query: 'DELETE FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)', bindings: [a, b, b, a] },
    { query: 'INSERT OR IGNORE INTO friends(user, friend, since) VALUES (?, ?, ?)', bindings: [a, b, now] },
    { query: 'INSERT OR IGNORE INTO friends(user, friend, since) VALUES (?, ?, ?)', bindings: [b, a, now] },
  ]);
}

const accept: Handler = async (req, p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const a = await account(req, ctx);
  if (a.error) return a.error;
  if (!(await ctx.db.first('SELECT from_user FROM friend_requests WHERE from_user = ? AND to_user = ?', p.user, a.id.user))) return fail(404, 'No such request.');
  await befriend(ctx, a.id.user, p.user);
  return json(200, { state: 'friends' });
};

const decline: Handler = async (req, p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const a = await account(req, ctx);
  if (a.error) return a.error;
  // (They aren't told: the request just goes.)
  await ctx.db.run('DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?', p.user, a.id.user);
  return json(200, { state: 'none' });
};

const remove: Handler = async (req, p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const a = await account(req, ctx);
  if (a.error) return a.error;
  await dropFriendship(ctx.db, a.id.user, p.user);
  return json(200, { state: 'none' });
};

const HereSchema = v.strictObject({ code: v.nullable(v.pipe(v.string(), v.regex(ROOM_CODE_RE))) });

/** Where you are (a room's code, or nowhere), for your friends' lists. */
const here: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const b = check(HereSchema, await body(req, 256));
  if (!b) return fail(400, 'Bad body.');
  // (A guest has no friends to tell.)
  if (id.guest) return json(200, { ok: true });
  await ctx.db.run('INSERT INTO presence(user, room, at) VALUES (?, ?, ?) ON CONFLICT(user) DO UPDATE SET room = excluded.room, at = excluded.at', id.user, b.code, ctx.now());
  return json(200, { ok: true });
};

const InviteSchema = v.strictObject({ code: v.pipe(v.string(), v.regex(ROOM_CODE_RE)) });

const invite: Handler = async (req, p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'invite', 20, 20)) return fail(429, 'Too many invitations from here: wait a minute.');
  const a = await account(req, ctx);
  if (a.error) return a.error;
  const b = check(InviteSchema, await body(req, 256));
  if (!b) return fail(400, 'Bad body.');
  if (!(await ctx.db.first('SELECT friend FROM friends WHERE user = ? AND friend = ?', a.id.user, p.user))) return fail(404, 'They aren’t on your list.');
  const card = await ctx.rooms.fetch(b.code, 'card', { method: 'GET' }).catch(() => null);
  const phase = card?.ok ? ((await card.json()) as { phase?: string }).phase : undefined;
  if (phase !== 'harbour' && phase !== 'playing') return fail(404, 'That harbour has closed.', 'room');
  await ctx.services.notify([p.user], { title: `${a.id.name} asks you aboard`, body: phase === 'harbour' ? 'Their harbour is open: come and take a seat.' : 'Their voyage is under way: come and watch.', url: `/${phase === 'harbour' ? 'r' : 'w'}/${b.code}`, tag: `invite-${b.code}`, kind: 'invite' });
  return json(200, { invited: true });
};

export const FRIENDS_ROUTES: Route[] = [
  { method: 'GET', path: '/api/friends', handler: list },
  { method: 'POST', path: '/api/friends', handler: ask },
  { method: 'PUT', path: '/api/friends/here', handler: here },
  { method: 'POST', path: '/api/friends/:user/accept', handler: accept },
  { method: 'POST', path: '/api/friends/:user/decline', handler: decline },
  { method: 'POST', path: '/api/friends/:user/invite', handler: invite },
  { method: 'DELETE', path: '/api/friends/:user', handler: remove },
];

// What an account's export and erasure take of this feature's.
ACCOUNT_HOOKS.export.push(async (db, user) => ({
  friends: await db.all('SELECT friend AS user, since FROM friends WHERE user = ?', user),
  friendRequests: {
    sent: await db.all('SELECT to_user AS user, at FROM friend_requests WHERE from_user = ?', user),
    received: await db.all('SELECT from_user AS user, at FROM friend_requests WHERE to_user = ?', user),
  },
}));
ACCOUNT_HOOKS.erase.push(async (db, user) => {
  await db.batch([
    { query: 'DELETE FROM friends WHERE user = ? OR friend = ?', bindings: [user, user] },
    { query: 'DELETE FROM friend_requests WHERE from_user = ? OR to_user = ?', bindings: [user, user] },
    { query: 'DELETE FROM presence WHERE user = ?', bindings: [user] },
  ]);
});

export const friends: Feature = { id: 'friends', schema: FRIENDS_SCHEMA, routes: FRIENDS_ROUTES };
