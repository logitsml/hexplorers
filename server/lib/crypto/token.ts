// Signed, short-lived tokens: `v1.<payload>.<mac>`, where the payload is base64url JSON
// `{ p: payload, x: expiry (ms since the epoch) }` and the MAC is HMAC-SHA-256 over a purpose label and
// the payload. The purpose keeps one kind of token from being replayed as another (a seat's hand-off
// can't pass for a magic link). Tokens are signed, not encrypted: anything in the payload is readable
// by whoever holds the token.

import { fromBase64Url, fromUtf8, toBase64Url } from './bytes';
import { hmacSha256, hmacVerify } from './hash';

/** Longest token verify() will look at (a cheap guard against huge inputs). */
export const TOKEN_MAX_LENGTH = 8192;

export interface TokenOptions {
  /** What the token is for (e.g. 'magic', 'checkout', 'oauth-flow'); verify must give the same. */
  purpose?: string;
  /** The current time in ms (tests, or a runtime's clock). */
  now?: number;
}

export type TokenResult<T> =
  | { ok: true; payload: T; exp: number }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

function macInput(purpose: string, body: string): string {
  return `exploratory/token/v1|${purpose}|${body}`;
}

/** Sign `payload` (anything JSON can carry) for `ttlMs` milliseconds. */
export async function signToken(
  payload: unknown,
  secret: string | Uint8Array,
  ttlMs: number,
  options: TokenOptions = {},
): Promise<string> {
  if (!(ttlMs > 0)) throw new Error('signToken: ttlMs must be positive');
  const exp = Math.floor((options.now ?? Date.now()) + ttlMs);
  const body = toBase64Url(JSON.stringify({ p: payload, x: exp }));
  const mac = await hmacSha256(secret, macInput(options.purpose ?? '', body));
  return `v1.${body}.${toBase64Url(mac)}`;
}

/** Check a token's signature, purpose and expiry, and return its payload. */
export async function verifyToken<T = unknown>(
  token: string,
  secret: string | Uint8Array,
  options: TokenOptions = {},
): Promise<TokenResult<T>> {
  if (typeof token !== 'string' || token.length > TOKEN_MAX_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [, body, macText] = parts as [string, string, string];
  let mac: Uint8Array;
  try {
    mac = fromBase64Url(macText);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!(await hmacVerify(secret, macInput(options.purpose ?? '', body), mac))) return { ok: false, reason: 'signature' };
  let decoded: { p?: unknown; x?: unknown };
  try {
    decoded = JSON.parse(fromUtf8(fromBase64Url(body)));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof decoded !== 'object' || decoded === null || typeof decoded.x !== 'number') return { ok: false, reason: 'malformed' };
  if ((options.now ?? Date.now()) >= decoded.x) return { ok: false, reason: 'expired' };
  return { ok: true, payload: decoded.p as T, exp: decoded.x };
}
