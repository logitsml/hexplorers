// The HTTP side of online play: is there a server, make a guest, make and look up rooms. The
// static deploy has no server, so `/api/config` there is the 404 page (or nothing at all): that,
// a timeout, or a server that says online play is off all come back as a reason the Multiplayer
// page can explain, never as an error thrown at it. Tokens go in the Authorization header only.

import { PROTO, type RoomInfo, type RoomSettings, type ServerConfig } from '../net/protocol';

/** Why online play can't be offered: no server on this build, one that says it's off, or one on a newer protocol. */
export type Unavailable = 'offline' | 'off' | 'upgrade' | 'error';

export type ConfigResult = { ok: true; config: ServerConfig } | { ok: false; why: Unavailable };

/** How long the config may take before the page decides there is no server (a phone on a slow link still gets a word in). */
export const CONFIG_TIMEOUT_MS = 3500;

type Fetch = typeof fetch;

/** fetch with a deadline: an unanswered request is aborted rather than left to hang the page. */
async function timed(f: Fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** A JSON body, or null when the answer isn't JSON (the static site's 404 page, a proxy's error page). */
async function json<T>(r: Response): Promise<T | null> {
  if (!(r.headers.get('content-type') ?? '').includes('json')) return null;
  try {
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

let cached: Promise<ConfigResult> | null = null;

/**
 * What the server offers (asked once a visit; a failed answer is asked again next time). `base`
 * and `f` are for tests.
 */
export function fetchConfig(o: { base?: string; f?: Fetch; timeout?: number; fresh?: boolean } = {}): Promise<ConfigResult> {
  if (cached && !o.fresh && !o.f) return cached;
  const p = askConfig(o.base ?? '', o.f ?? fetch, o.timeout ?? CONFIG_TIMEOUT_MS);
  if (!o.f) {
    cached = p;
    void p.then((r) => {
      if (!r.ok && r.why !== 'off') cached = null;
    });
  }
  return p;
}

async function askConfig(base: string, f: Fetch, ms: number): Promise<ConfigResult> {
  let r: Response;
  try {
    r = await timed(f, `${base}/api/config`, { headers: { accept: 'application/json' }, cache: 'no-store' }, ms);
  } catch (e) {
    // (No answer in time is a server that's there but slow, as a dev server compiling its first
    // answer is: worth asking again. Nothing at all is a build without one.)
    return { ok: false, why: (e as Error)?.name === 'AbortError' ? 'error' : 'offline' };
  }
  if (r.status === 404) return { ok: false, why: 'offline' };
  const config = r.ok ? await json<ServerConfig>(r) : null;
  if (!config || typeof config !== 'object' || !config.features) return { ok: false, why: r.ok ? 'offline' : 'error' };
  if (config.proto !== PROTO) return { ok: false, why: 'upgrade' };
  if (!config.features.online) return { ok: false, why: 'off' };
  return { ok: true, config };
}

/** An HTTP failure the page can put in words. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** One JSON request: its answer, or an ApiError in words (the features' clients use it too). */
export async function call<T>(f: Fetch, url: string, init: RequestInit & { token?: string }, ms = 8000): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let r: Response;
  try {
    r = await timed(f, url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }, ms);
  } catch {
    throw new ApiError(0, 'The harbour can’t be reached. Check your connection and try again.');
  }
  const body = await json<T & { error?: string; code?: string }>(r);
  if (!r.ok) throw new ApiError(r.status, body?.error ?? (r.status === 404 ? 'Not found' : `The harbour answered ${r.status}`), body?.code);
  if (body === null) throw new ApiError(r.status, 'The harbour’s answer made no sense.');
  return body;
}

/** A new guest identity: `{user, token, name}` (the token is a bearer secret). */
export function createGuest(name: string, o: { base?: string; f?: Fetch } = {}) {
  return call<{ user: string; token: string; name: string }>(o.f ?? fetch, `${o.base ?? ''}/api/guest`, { method: 'POST', body: JSON.stringify({ name }) });
}

/** A new room with these settings (anything left out takes the server's default); returns its code. */
export function createRoom(token: string, settings: Partial<RoomSettings>, o: { base?: string; f?: Fetch } = {}) {
  return call<{ code: string }>(o.f ?? fetch, `${o.base ?? ''}/api/rooms`, { method: 'POST', token, body: JSON.stringify({ settings }) });
}

/** What anyone may know of a room before joining (its card for the join page); null when there is no such room. */
export type RoomCard = Pick<RoomInfo, 'code' | 'phase' | 'settings' | 'seats' | 'spectators'>;

export async function getRoom(code: string, o: { base?: string; f?: Fetch } = {}): Promise<RoomCard | null> {
  try {
    return await call<RoomCard>(o.f ?? fetch, `${o.base ?? ''}/api/rooms/${encodeURIComponent(code)}`, { method: 'GET' });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** The room's socket, on this page's own host (the dev server proxies it, the Worker would serve it). */
export function socketUrl(code: string, loc: Pick<Location, 'protocol' | 'host'> = location) {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/rooms/${encodeURIComponent(code)}/ws`;
}
