// Your own account and other people's profiles: GET and PATCH /api/me (name, handle, face, the age
// band and the free-chat opt-in), a copy of everything kept about you (GET /api/me/export), erasing
// it (DELETE /api/me: your rows go, your seats in stored replays become "A former sailor", every
// session ends), and a public profile by handle (GET /api/u/:handle) with the record the plays
// table keeps. Guests can read, export and erase what they have too.

import * as v from 'valibot';
import { NAME_MAX } from '../../../src/net/protocol';
import { AVATARS } from '../../../src/game/names';
import { gunzip, gzip } from '../../../src/net/codes';
import { COLOR_RE, check } from '../../../src/net/schema';
import type { FinishedGame } from '../../core/ports';
import { body, fail, json, limited, originAllowed, who, type Handler, type HttpContext, type Route } from '../../http/kit';
import { moderateText } from '../../services/moderate';
import type { Services } from '../../services';
import { ACCOUNT_HOOKS, ageBand, handleProblem, quickOnly, readSettings, userRow, guestRow, siteOrigin, type AccountDeps, type AccountSettings } from './core';

/** The name a person's seats take in stored games once they've erased themselves. */
export const FORMER = 'A former sailor';

// ------------------------------------------------------------------ the record

/** Each finished game's people, a row each (guests too): what profiles count and "recent sailors" read. */
export function recordPlays(services: Services, d: AccountDeps) {
  const inner = services.finishGame.bind(services);
  services.finishGame = async (game: FinishedGame) => {
    const out = await inner(game);
    const rows = game.seats
      .filter((s) => s.user && !s.bot)
      .map((s) => ({
        query: 'INSERT OR IGNORE INTO plays(user, replay, seat, points, won, at) VALUES (?, ?, ?, ?, ?, ?)',
        bindings: [s.user!, out.replay, s.seat, game.points[s.seat] ?? 0, game.winner === s.seat ? 1 : 0, game.endedAt || d.now()],
      }));
    // (The replay is safe whatever happens here: a record not kept is no reason to fail the game.)
    if (rows.length) await d.db.batch(rows).catch((e) => console.warn(JSON.stringify({ ev: 'playsFailed', room: game.room, error: String((e as Error)?.message ?? e).slice(0, 120) })));
    return out;
  };
}

async function record(ctx: HttpContext, user: string) {
  const t = await ctx.db.first<{ n: number; w: number | null }>('SELECT COUNT(*) AS n, SUM(won) AS w FROM plays WHERE user = ?', user);
  const recent = await ctx.db.all<{ replay: string; seat: number; points: number; won: number; at: number }>('SELECT replay, seat, points, won, at FROM plays WHERE user = ? ORDER BY at DESC LIMIT 10', user);
  return { played: t?.n ?? 0, won: t?.w ?? 0, recent: recent.map((r) => ({ replay: r.replay, seat: r.seat, points: r.points, won: !!r.won, at: r.at })) };
}

// ------------------------------------------------------------------ you

const publicSettings = (s: AccountSettings) => ({ ageBand: s.ageBand ?? null, chat: quickOnly(s) ? 'quick' : 'free', prefs: s.prefs ?? {} });

async function meBody(ctx: HttpContext, user: string) {
  const u = await userRow(ctx.db, user);
  if (!u) return null;
  const s = readSettings(u.settings);
  const passkeys = await ctx.db.all<{ id: string; device: string; created_at: number; used_at: number | null; backed_up: number }>('SELECT id, device, created_at, used_at, backed_up FROM passkeys WHERE user = ? ORDER BY created_at', user);
  const links = await ctx.db.all<{ provider: string; created_at: number }>('SELECT provider, created_at FROM oauth_links WHERE user = ? ORDER BY created_at', user);
  const email = await ctx.db.first<{ address: string | null; notify: number }>('SELECT address, notify FROM emails WHERE user = ?', user);
  return {
    user,
    name: u.name,
    handle: u.handle,
    guest: false,
    avatar: u.avatar,
    color: u.color,
    created: u.created_at,
    settings: publicSettings(s),
    quickTalk: quickOnly(s),
    methods: {
      passkeys: passkeys.map((p) => ({ id: p.id, device: p.device, created: p.created_at, used: p.used_at, synced: !!p.backed_up })),
      providers: links.map((l) => l.provider),
      email: email ? { address: email.address, notify: !!email.notify } : null,
    },
    ...(await record(ctx, user)),
  };
}

const me: Handler = async (req, _p, ctx) => {
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  if (id.guest) return json(200, { user: id.user, name: id.name, guest: true, ...(await record(ctx, id.user)) });
  const out = await meBody(ctx, id.user);
  return out ? json(200, out) : fail(401, 'Sign in again.');
};

const PatchSchema = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.maxLength(NAME_MAX * 4))),
  handle: v.optional(v.pipe(v.string(), v.maxLength(40))),
  avatar: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-5), v.maxValue(AVATARS.length - 1))),
  color: v.optional(v.pipe(v.string(), v.regex(COLOR_RE))),
  settings: v.optional(
    v.strictObject({
      birthYear: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1900), v.maxValue(2100))),
      chat: v.optional(v.picklist(['quick', 'free'])),
      prefs: v.optional(v.record(v.pipe(v.string(), v.maxLength(64)), v.unknown())),
    }),
  ),
});

const patchMe: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'profile', 30, 30)) return fail(429, 'Too many changes from here: wait a minute.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const b = check(PatchSchema, await body(req, 8192));
  if (!b) return fail(400, 'Bad body.');
  const name = b.name === undefined ? undefined : moderateText(b.name, 'name');
  if (name === null) return fail(400, 'That name can’t be used here.', 'name');
  if (id.guest) {
    // (A guest has a name and nothing else to change: the rest comes with an account.)
    if (b.handle !== undefined || b.settings !== undefined) return fail(403, 'Keep your progress first: that needs an account.', 'guest');
    if (name) await ctx.db.run('UPDATE guests SET name = ? WHERE user = ?', name.slice(0, NAME_MAX), id.user);
    return json(200, { user: id.user, name: name ?? id.name, guest: true });
  }
  const u = await userRow(ctx.db, id.user);
  if (!u) return fail(401, 'Sign in again.');
  if (b.handle !== undefined && b.handle !== u.handle) {
    const problem = handleProblem(b.handle);
    if (problem) return fail(400, problem, 'handle');
    const taken = await ctx.db.first<{ id: string }>('SELECT id FROM users WHERE handle = ? AND id != ?', b.handle, id.user);
    if (taken) return fail(409, 'That handle is taken: try another.', 'taken');
  }
  const s = readSettings(u.settings);
  if (b.settings?.birthYear !== undefined) {
    const band = ageBand(b.settings.birthYear, ctx.now());
    // (Under 13 stays so: a younger sailor can't sign their own way into free chat.)
    if (s.ageBand === 'u13' && band !== 'u13') return fail(400, 'Your papers say under 13, and that can’t be changed here.', 'age');
    s.ageBand = band;
  }
  if (b.settings?.chat === 'free') {
    if (!s.ageBand) return fail(400, 'Free chat needs your year of birth first.', 'age');
    if (s.ageBand === 'u13') return fail(400, 'Free chat is for sailors 13 and over: quick talk is yours.', 'age');
    s.chat = 'free';
  } else if (b.settings?.chat === 'quick') s.chat = 'quick';
  if (s.ageBand === 'u13') s.chat = 'quick';
  if (b.settings?.prefs !== undefined) {
    if (JSON.stringify(b.settings.prefs).length > 2048) return fail(400, 'Too many preferences.', 'prefs');
    s.prefs = b.settings.prefs;
  }
  try {
    await ctx.db.run(
      'UPDATE users SET name = ?, handle = ?, avatar = ?, color = ?, settings = ? WHERE id = ?',
      (name ?? u.name).slice(0, NAME_MAX), b.handle ?? u.handle, b.avatar ?? u.avatar, b.color ?? u.color, JSON.stringify(s), id.user,
    );
  } catch {
    // (Taken in the moment since it was checked.)
    return fail(409, 'That handle is taken: try another.', 'taken');
  }
  return json(200, await meBody(ctx, id.user));
};

// ------------------------------------------------------------------ a copy of everything

const exportMe: Handler = async (req, _p, ctx) => {
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  if (await limited(ctx, 'export', 4, 4)) return fail(429, 'Too many copies from here: wait a minute.');
  const u = id.guest ? null : await userRow(ctx.db, id.user);
  const g = id.guest ? await guestRow(ctx.db, id.user) : null;
  const plays = await ctx.db.all<{ replay: string; seat: number; points: number; won: number; at: number }>('SELECT replay, seat, points, won, at FROM plays WHERE user = ? ORDER BY at', id.user);
  const out: Record<string, unknown> = {
    exported: new Date(ctx.now()).toISOString(),
    about: 'Everything Hexplorers keeps about you. Each replay is at its link; a session’s secret and a passkey’s private key are never kept, so neither is here.',
    profile: u
      ? { user: u.id, handle: u.handle, name: u.name, avatar: u.avatar, color: u.color, settings: publicSettings(readSettings(u.settings)), created: u.created_at, lastSeen: u.last_seen }
      : { user: id.user, name: id.name, guest: true, created: g?.created_at ?? null },
    plays: plays.map((p) => ({ ...p, won: !!p.won, replay: p.replay, link: `${siteOrigin(ctx.env)}/api/replays/${p.replay}` })),
  };
  if (u) {
    out.signIn = {
      passkeys: await ctx.db.all('SELECT id, device, created_at AS created, used_at AS used, backed_up AS synced, transports FROM passkeys WHERE user = ?', id.user),
      providers: await ctx.db.all('SELECT provider, subject, created_at AS linked FROM oauth_links WHERE user = ?', id.user),
      email: await ctx.db.first('SELECT address, notify, created_at AS created FROM emails WHERE user = ?', id.user),
    };
    out.sessions = await ctx.db.all('SELECT device, created_at AS created, last_seen AS lastSeen FROM sessions WHERE user = ?', id.user);
  }
  out.notes = await ctx.db.all('SELECT title, body, url, at FROM notes WHERE user = ? ORDER BY at', id.user);
  for (const hook of ACCOUNT_HOOKS.export) Object.assign(out, await hook(ctx.db, id.user));
  return json(200, out, { 'content-disposition': 'attachment; filename="exploratory-logbook.json"' });
};

// ------------------------------------------------------------------ erasing

/** A replay with this person's seats made anonymous (null when it doesn't name them). */
async function anonymised(blob: Uint8Array, user: string): Promise<Uint8Array | null> {
  const game = JSON.parse(await gunzip(blob)) as { seats?: { user?: string; name?: string }[] };
  let changed = false;
  for (const s of game.seats ?? []) {
    if (s.user !== user) continue;
    delete s.user;
    s.name = FORMER;
    changed = true;
  }
  return changed ? gzip(JSON.stringify(game)) : null;
}

/** Erase everything kept about a person (guest or account): their games stay in others' histories, under "A former sailor". */
export async function erase(ctx: HttpContext, user: string) {
  const replays = await ctx.db.all<{ replay: string }>('SELECT replay FROM plays WHERE user = ?', user);
  for (const { replay } of replays) {
    const key = `replays/${replay}.json.gz`;
    try {
      const blob = await ctx.blobs.get(key);
      const next = blob && (await anonymised(blob, user));
      if (next) await ctx.blobs.put(key, next, { contentType: 'application/gzip' });
    } catch (e) {
      console.warn(JSON.stringify({ ev: 'anonymiseFailed', replay, error: String((e as Error)?.message ?? e).slice(0, 120) }));
    }
  }
  for (const hook of ACCOUNT_HOOKS.erase) await hook(ctx.db, user);
  await ctx.db.batch(
    [
      'DELETE FROM passkeys WHERE user = ?',
      'DELETE FROM oauth_links WHERE user = ?',
      'DELETE FROM sessions WHERE user = ?',
      'DELETE FROM emails WHERE user = ?',
      'DELETE FROM plays WHERE user = ?',
      'DELETE FROM notes WHERE user = ?',
      'DELETE FROM users WHERE id = ?',
      'DELETE FROM guests WHERE user = ?',
      'DELETE FROM guest_alias WHERE account = ?',
    ].map((query) => ({ query, bindings: [user] })),
  );
}

const DeleteSchema = v.strictObject({ confirm: v.pipe(v.string(), v.maxLength(80)) });

const deleteMe: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const b = check(DeleteSchema, await body(req, 1024));
  const said = b?.confirm.trim().toLowerCase().replace(/^@/, '');
  if (!said || (said !== id.name.trim().toLowerCase() && said !== id.handle?.toLowerCase())) return fail(400, 'Type your name to confirm.', 'confirm');
  await erase(ctx, id.user);
  return json(200, { erased: true });
};

// ------------------------------------------------------------------ profiles

const profile: Handler = async (_req, p, ctx) => {
  if (await limited(ctx, 'profile-read', 60, 60)) return fail(429, 'Too many lookups: wait a minute.');
  const handle = p.handle.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(handle)) return fail(404, 'No such sailor.');
  const u = await ctx.db.first<{ id: string; handle: string; name: string; avatar: number; color: string; settings: string; created_at: number }>('SELECT id, handle, name, avatar, color, settings, created_at FROM users WHERE handle = ?', handle);
  if (!u) return fail(404, 'No such sailor.');
  const young = readSettings(u.settings).ageBand === 'u13';
  const r = await record(ctx, u.id);
  const out: Record<string, unknown> = {
    user: u.id,
    handle: u.handle,
    // (A sailor under 13 shows their handle, not a name, and no list of games.)
    name: young ? u.handle : u.name,
    avatar: u.avatar,
    color: u.color,
    joined: u.created_at,
    played: r.played,
    won: r.won,
    recent: young ? [] : r.recent,
    // (The ratings feature fills this in through ACCOUNT_HOOKS.profile.)
    rating: null,
  };
  for (const hook of ACCOUNT_HOOKS.profile) Object.assign(out, await hook(ctx.db, u.id));
  return json(200, out, { 'cache-control': 'private, max-age=30' });
};

export const ME_ROUTES: Route[] = [
  { method: 'GET', path: '/api/me', handler: me },
  { method: 'PATCH', path: '/api/me', handler: patchMe },
  { method: 'DELETE', path: '/api/me', handler: deleteMe },
  { method: 'GET', path: '/api/me/export', handler: exportMe },
  { method: 'GET', path: '/api/u/:handle', handler: profile },
];
