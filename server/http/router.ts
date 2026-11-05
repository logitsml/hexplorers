// The HTTP API under /api, shared by both runtimes: a route table, the origin check every socket
// upgrade passes, and the per-IP limits (IPs are only ever hashed). Features read their keys from
// the environment and stay off until keyed; the routes planned for them answer 501 meanwhile, so
// each later feature adds its handlers here without touching the runtimes.

import { BUILD } from '../../src/net/build';
import { CUSTOM_MAP_MAX_BYTES, PROTO, ROOM_CODE_RE, type FeatureFlags, type ServerConfig } from '../../src/net/protocol';
import { CreateRoomBodySchema, GuestBodySchema, RoomMapBodySchema, check } from '../../src/net/schema';

import type { ServerEnv } from '../core/ports';

import { featureConfig, featureFlags, featureRoutes } from '../features';

export * from './kit';
import { HEADERS, body, fail, json, limited, originAllowed, who, type Handler, type HttpContext, type Route } from './kit';

export function features(env: ServerEnv): FeatureFlags {
  return {
    online: true,
    guests: true,
    // (Each of these turns on once its routes exist and its key is set.)
    passkeys: false,
    google: false,
    apple: false,
    discord: false,
    email: false,
    push: false,
    turnstile: !!(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY),
    og: false,
    ...featureFlags(env),
  };
}

async function turnstileOk(env: ServerEnv, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const out = (await r.json()) as { success?: boolean; action?: string };
    return out.success === true && (out.action === undefined || out.action === 'create-room');
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the routes

const config: Handler = async (_req, _p, ctx) => {
  const c: ServerConfig = { ...featureConfig(ctx.env), proto: PROTO, build: ctx.env.BUILD || BUILD, features: features(ctx.env) };
  if (ctx.env.VAPID_PUBLIC_KEY) c.vapidPublicKey = ctx.env.VAPID_PUBLIC_KEY;
  if (c.features.turnstile) c.turnstileSiteKey = ctx.env.TURNSTILE_SITE_KEY;
  return json(200, c);
};

const guest: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'guest', 10, 10)) return fail(429, 'Too many new guests from here: wait a minute.');
  const b = check(GuestBodySchema, await body(req, 2048));
  if (!b) return fail(400, 'Bad body.');
  const g = await ctx.services.guest(b.name);
  return json(201, { user: g.user, token: g.token, name: g.name, guest: true });
};

const me: Handler = async (req, _p, ctx) => {
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  return json(200, { user: id.user, name: id.name, handle: id.handle, guest: id.guest });
};

const createRoom: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  if (await limited(ctx, 'create', 5, 5)) return fail(429, 'Too many rooms from here: wait a minute.');
  const b = check(CreateRoomBodySchema, await body(req, CUSTOM_MAP_MAX_BYTES + 8192));
  if (!b) return fail(400, 'Those settings weren’t understood: reload the page and try again.');
  if (!(await turnstileOk(ctx.env, b.turnstile, ctx.ip))) return fail(403, 'The check didn’t pass. Try again.', 'turnstile');
  const name = (b.name && (await ctx.services.moderate(b.name, 'name'))) || id.name;
  try {
    const { code } = await ctx.services.createRoom({ host: { user: id.user, name }, settings: b.settings, custom: b.custom });
    return json(201, { code });
  } catch (e) {
    return fail(400, (e as Error).message);
  }
};

const roomCard: Handler = async (_req, p, ctx) => {
  if (!ROOM_CODE_RE.test(p.code)) return fail(404, 'No such room.');
  if (await limited(ctx, 'lookup', 20, 20)) return fail(429, 'Too many lookups: wait a minute.');
  const r = await ctx.rooms.fetch(p.code, 'card', { method: 'GET' });
  return new Response(r.body, { status: r.status, headers: HEADERS });
};

const roomMap: Handler = async (req, p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (!ROOM_CODE_RE.test(p.code)) return fail(404, 'No such room.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const b = check(RoomMapBodySchema, await body(req, CUSTOM_MAP_MAX_BYTES + 1024));
  if (!b) return fail(400, 'Bad body.');
  const r = await ctx.rooms.fetch(p.code, 'map', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: id.user, map: b.map }) });
  return new Response(r.body, { status: r.status, headers: HEADERS });
};

const replay: Handler = async (_req, p, ctx) => {
  const text = await ctx.services.replay(p.id);
  if (!text) return fail(404, 'No such replay.');
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400, immutable' } });
};

/** A feature that is planned but not built yet: its prefix answers 501, saying which. */
const planned = (feature: string): Handler => async () => fail(501, `${feature} isn’t available on this server yet.`, 'planned');

export const ROUTES: Route[] = [
  // (The features' own routes come first, ahead of the planned placeholders below.)
  ...featureRoutes(),
  { method: 'GET', path: '/api/config', handler: config },
  { method: 'POST', path: '/api/guest', handler: guest },
  { method: 'GET', path: '/api/me', handler: me },
  { method: 'POST', path: '/api/rooms', handler: createRoom },
  { method: 'GET', path: '/api/rooms/:code', handler: roomCard },
  { method: 'POST', path: '/api/rooms/:code/map', handler: roomMap },
  { method: 'GET', path: '/api/replays/:id', handler: replay },
  // Extension points: each feature replaces its line with its own routes.
  ...(['auth', 'friends', 'block', 'ratings', 'push'] as const).flatMap((f) =>
    (['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const).map((method): Route => ({ method, path: `/api/${f}/*`, handler: planned(f) })),
  ),
  { method: 'PATCH', path: '/api/me', handler: planned('profile') },
  { method: 'POST', path: '/api/report', handler: planned('report') },
  { method: 'GET', path: '/api/leaderboard', handler: planned('ratings') },
];

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/');
  const b = path.split('/');
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '*') return params;
    if (i >= b.length) return null;
    if (a[i].startsWith(':')) {
      if (!b[i]) return null;
      try {
        params[a[i].slice(1)] = decodeURIComponent(b[i]);
      } catch {
        return null; // a malformed escape matches nothing (a 404), never a throw
      }
    } else if (a[i] !== b[i]) return null;
  }
  return a.length === b.length ? params : null;
}

/** Answer an /api request or a link preview's card under /og (null: not one of ours; the runtime serves the page). */
export async function handleApi(req: Request, ctx: HttpContext): Promise<Response | null> {
  let path: string;
  try {
    path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return fail(400, 'Bad address.');
  }
  if (!path.startsWith('/api/') && path !== '/api' && !path.startsWith('/og/')) return null;
  let allowed = false;
  for (const r of ROUTES) {
    const params = matchPath(r.path, path);
    if (!params) continue;
    allowed = true;
    if (r.method !== req.method) continue;
    try {
      return await r.handler(req, params, ctx);
    } catch (e) {
      console.warn(JSON.stringify({ ev: 'httpError', path: r.path, error: String((e as Error)?.message ?? e).slice(0, 160) }));
      return fail(500, 'Something went wrong.');
    }
  }
  return allowed ? fail(405, 'Not that way.') : fail(404, 'No such route.');
}
