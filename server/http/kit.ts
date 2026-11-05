// What every /api handler shares (the core routes in router.ts and each feature's under
// server/features): the request context, JSON answers, bodies, bearer identities, the origin check
// and the per-IP limits (IPs are only ever hashed).

import { ROOM_CODE_RE } from '../../src/net/protocol';
import { hex, sha256, type RandomBytes } from '../../src/net/codes';
import type { BlobStore, ServerEnv, ServiceDb } from '../core/ports';
import type { RoomDirectory, Services } from '../services';

export interface HttpContext {
  env: ServerEnv;
  db: ServiceDb;
  blobs: BlobStore;
  services: Services;
  rooms: RoomDirectory;
  now(): number;
  random: RandomBytes;
  /** The client's address, for rate limits (hashed before use, never stored or logged). */
  ip?: string;
}

export type Handler = (req: Request, params: Record<string, string>, ctx: HttpContext) => Promise<Response>;

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** A path with :params, e.g. /api/rooms/:code; a trailing /* matches the rest. */
  path: string;
  handler: Handler;
}

export const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...headers } });
export const fail = (status: number, error: string, code?: string) => json(status, code ? { error, code } : { error });

// ------------------------------------------------------------------ limits

export class Buckets {
  private b = new Map<string, { tokens: number; at: number }>();
  /** One from `key`'s bucket (`perMinute`, bursting to `burst`). */
  take(key: string, perMinute: number, burst: number, now: number): boolean {
    let x = this.b.get(key);
    if (!x) {
      if (this.b.size > 50_000) this.b.clear();
      x = { tokens: burst, at: now };
      this.b.set(key, x);
    }
    x.tokens = Math.min(burst, x.tokens + ((now - x.at) / 60_000) * perMinute);
    x.at = now;
    if (x.tokens < 1) return false;
    x.tokens--;
    return true;
  }
}
export const buckets = new Buckets();

export async function limited(ctx: HttpContext, what: string, perMinute: number, burst: number): Promise<boolean> {
  const who = ctx.ip ? hex(await sha256(`${ctx.env.TOKEN_SECRET}|ip|${ctx.ip}`)).slice(0, 24) : 'unknown';
  return !buckets.take(`${what}|${who}`, perMinute, burst, ctx.now());
}

// ------------------------------------------------------------------ helpers

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h && /^Bearer ([\x21-\x7e]{1,512})$/.exec(h);
  return m ? m[1] : null;
}

export async function who(req: Request, ctx: HttpContext) {
  const token = bearer(req);
  return token ? ctx.services.identify(token) : null;
}

/** A JSON body, read to at most `max` bytes. */
export async function body(req: Request, max: number): Promise<unknown | undefined> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > max) return undefined;
  const text = await req.text();
  if (text.length > max) return undefined;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

/** The origins allowed to open sockets and post: PUBLIC_URL's and ALLOWED_ORIGINS, and the page's own host. */
export function originAllowed(req: Request, env: ServerEnv): boolean {
  const origin = req.headers.get('origin');
  // (Browsers always send one with a socket; a missing one isn't a browser, which no cookie protects anyway.)
  if (!origin) return true;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(env.PUBLIC_URL).origin);
  } catch {
    // (No public URL: same host only.)
  }
  for (const o of (env.ALLOWED_ORIGINS ?? '').split(',')) if (o.trim()) allowed.add(o.trim().replace(/\/$/, ''));
  if (allowed.has(origin)) return true;
  try {
    return new URL(origin).host === (req.headers.get('host') ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

/** A socket upgrade for a room: its code, or the response refusing it. */
export function roomSocket(req: Request, env: ServerEnv): { code: string } | Response | null {
  const m = /^\/api\/rooms\/([^/]+)\/ws$/.exec(new URL(req.url).pathname);
  if (!m) return null;
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'A socket, please.');
  if (!ROOM_CODE_RE.test(m[1])) return fail(404, 'No such room.');
  if (!originAllowed(req, env)) return fail(403, 'Not from this site.');
  return { code: m[1] };
}
