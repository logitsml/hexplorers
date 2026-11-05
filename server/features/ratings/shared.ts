// What the community features (ratings, friends, safety) share: who
// is asking, the checks every write passes, the server's secret as bytes, the UTC day, and the
// friends feature's list when that feature is there. Platform-free, as all of server/features is.

import { fromHex, type RandomBytes } from '../../../src/net/codes';
import type { ServerEnv } from '../../core/ports';
import { fail, limited, originAllowed, who, type HttpContext } from '../../http/kit';
import type { Identity, Services } from '../../services';

/** The person asking (a bearer token), or the response refusing them. */
export async function signedIn(req: Request, ctx: HttpContext): Promise<Identity | Response> {
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  if (id.banned) return fail(403, 'You can’t do that.');
  return id;
}

/** A write: from this site, by someone signed in, within `perMinute` (bursting to twice that). */
export async function writer(req: Request, ctx: HttpContext, what: string, perMinute: number): Promise<Identity | Response> {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, what, perMinute, perMinute * 2)) return fail(429, 'Too many at once: wait a moment.');
  return signedIn(req, ctx);
}

/** TOKEN_SECRET as the HMAC key (hex, or its text when it isn't hex), as the services take it. */
export const secretBytes = (env: ServerEnv): Uint8Array<ArrayBuffer> => fromHex(env.TOKEN_SECRET) ?? (new TextEncoder().encode(env.TOKEN_SECRET) as Uint8Array<ArrayBuffer>);

/** The UTC day of `now` as YYYY-MM-DD. */
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * The people this user calls friends, when the friends feature is on this server (it adds
 * `friendsOf` to the services); null without it, and a scope that needs it says so.
 */
export function friendsOf(services: Services): ((user: string) => Promise<string[]>) | null {
  const f = (services as Services & { friendsOf?: (user: string) => Promise<string[]> }).friendsOf;
  return typeof f === 'function' ? (user) => f.call(services, user) : null;
}

/** `?` placeholders for an IN list. */
export const marks = (n: number) => Array(n).fill('?').join(', ');

/** A short random id (base 36), for matches and the like. */
export function shortId(random: RandomBytes, bytes = 8): string {
  return Array.from(random(bytes), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, bytes * 2);
}

/** Log a feature's failure: its code and the error's message only (never ids, names or tokens). */
export function warn(ev: string, e: unknown) {
  console.warn(JSON.stringify({ ev, error: String((e as Error)?.message ?? e).slice(0, 160) }));
}
