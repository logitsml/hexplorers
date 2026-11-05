// Safety: blocking (everywhere and for good, with no word to the one blocked: their chat is hidden
// from you in every room, see services.blocked, they can't ask to be your friend, and any
// friendship goes) and reports from a profile (a report from a seat goes through the room, which
// adds the chat around it). Guests can block and report too: a block is kept by id.

import * as v from 'valibot';
import { REPORT_REASONS } from '../../../src/net/protocol';
import { check } from '../../../src/net/schema';
import type { ServiceDb } from '../../core/ports';
import { body, fail, json, limited, originAllowed, who, type Handler, type Route } from '../../http/kit';
import type { Feature } from '..';
import { ACCOUNT_HOOKS } from '../accounts';
import { dropFriendship } from '../friends';

const MAX_BLOCKS = 500;
const ID = v.pipe(v.string(), v.maxLength(40), v.regex(/^[A-Za-z0-9_-]+$/));
const TargetSchema = v.strictObject({ user: v.optional(ID), handle: v.optional(v.pipe(v.string(), v.maxLength(40))) });

/** The person a body names, by id or by handle (null: nobody known). */
async function target(db: ServiceDb, b: { user?: string; handle?: string }): Promise<string | null> {
  if (b.user) {
    const known = (await db.first('SELECT id FROM users WHERE id = ?', b.user)) ?? (await db.first('SELECT user FROM guests WHERE user = ?', b.user));
    return known ? b.user : null;
  }
  const handle = b.handle?.trim().replace(/^@/, '') ?? '';
  return /^[A-Za-z0-9_]{3,20}$/.test(handle) ? ((await db.first<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle))?.id ?? null) : null;
}

const list: Handler = async (req, _p, ctx) => {
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const rows = await ctx.db.all<{ blocked: string; handle: string | null; name: string | null; guest_name: string | null }>(
    'SELECT b.blocked AS blocked, u.handle AS handle, u.name AS name, g.name AS guest_name FROM blocks b LEFT JOIN users u ON u.id = b.blocked LEFT JOIN guests g ON g.user = b.blocked WHERE b.user = ?',
    id.user,
  );
  return json(200, { blocked: rows.map((r) => ({ user: r.blocked, ...(r.handle && { handle: r.handle }), name: r.name ?? r.guest_name ?? 'A former sailor' })) });
};

const block: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'block', 30, 30)) return fail(429, 'Too many from here: wait a minute.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const b = check(TargetSchema, await body(req, 512));
  if (!b || (b.user === undefined) === (b.handle === undefined)) return fail(400, 'Who, please?');
  const them = await target(ctx.db, b);
  if (!them) return fail(404, 'Nobody by that name here.');
  if (them === id.user) return fail(400, 'That’s you.', 'self');
  const n = await ctx.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM blocks WHERE user = ?', id.user);
  if ((n?.n ?? 0) >= MAX_BLOCKS) return fail(400, 'Your block list is full.', 'full');
  await ctx.db.run('INSERT OR IGNORE INTO blocks(user, blocked) VALUES (?, ?)', id.user, them);
  await dropFriendship(ctx.db, id.user, them);
  return json(200, { blocked: true });
};

const unblock: Handler = async (req, p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  await ctx.db.run('DELETE FROM blocks WHERE user = ? AND blocked = ?', id.user, p.user);
  return json(200, { blocked: false });
};

const ReportSchema = v.strictObject({
  user: v.optional(ID),
  handle: v.optional(v.pipe(v.string(), v.maxLength(40))),
  reason: v.picklist(REPORT_REASONS),
  note: v.optional(v.pipe(v.string(), v.maxLength(500))),
  /** A replay it happened in, when the report is from one. */
  replay: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,32}$/))),
});

const report: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'report', 6, 6)) return fail(429, 'You’ve sent a lot of reports: wait a little.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const b = check(ReportSchema, await body(req, 2048));
  if (!b || (b.user === undefined) === (b.handle === undefined)) return fail(400, 'Bad body.');
  const them = await target(ctx.db, b);
  if (!them) return fail(404, 'Nobody by that name here.');
  if (them === id.user) return fail(400, 'That’s you.', 'self');
  await ctx.services.report({ room: b.replay ? `replay:${b.replay}` : 'profile', from: id.user, about: them, reason: b.reason, note: b.note, chat: [] });
  return json(202, { reported: true, text: 'Thanks. We’ll take a look.' });
};

export const SAFETY_ROUTES: Route[] = [
  { method: 'GET', path: '/api/block', handler: list },
  { method: 'POST', path: '/api/block', handler: block },
  { method: 'DELETE', path: '/api/block/:user', handler: unblock },
  { method: 'POST', path: '/api/report', handler: report },
];

ACCOUNT_HOOKS.export.push(async (db, user) => ({
  blocked: await db.all('SELECT blocked AS user FROM blocks WHERE user = ?', user),
  reportsSent: await db.all('SELECT room, about, reason, note, at FROM reports WHERE from_user = ?', user),
}));
// (Reports about someone stay for the moderators; the ones they sent no longer name them.)
ACCOUNT_HOOKS.erase.push(async (db, user) => {
  await db.batch([
    { query: 'DELETE FROM blocks WHERE user = ?', bindings: [user] },
    { query: "UPDATE reports SET from_user = 'erased' WHERE from_user = ?", bindings: [user] },
  ]);
});

export const safety: Feature = { id: 'safety', routes: SAFETY_ROUTES };
