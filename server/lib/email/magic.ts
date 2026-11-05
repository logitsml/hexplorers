// Magic-link tokens: signed (HMAC-SHA-256 with TOKEN_SECRET), single use, 15 minutes.
//
// The token carries {e: a keyed hash of the address, n: a nonce} and its expiry, never the address
// itself (links get forwarded, and the address is personal data). Single use needs state, so the
// caller passes `consume(nonce, exp)`: it records the nonce and returns true the first time, false
// after (a row with a unique key, deleted after exp, is enough).
//
// The 6-digit code in the same email is derived from the nonce, so a player who opened the mail on
// another device can type it instead. Checking a code needs the pending nonce (keep it with the
// address hash when the link is sent), and the caller must cap attempts: 6 digits is only 10^6.

import { hmacSha256, hmacSha256Hex, randomId, signToken, timingSafeEqual, verifyToken } from '../crypto';

export const MAGIC_TTL_MS = 15 * 60_000;
const PURPOSE = 'magic-link';

/** The address as it's compared: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A keyed hash of an address (hex): what tokens carry and what an index can be built on. */
export function emailHash(email: string, secret: string): Promise<string> {
  return hmacSha256Hex(secret, `exploratory/email/v1|${normalizeEmail(email)}`);
}

/** The 6-digit code for a nonce. */
export async function magicCode(nonce: string, secret: string): Promise<string> {
  const mac = await hmacSha256(secret, `exploratory/magic-code/v1|${nonce}`);
  const n = ((mac[0]! << 24) | (mac[1]! << 16) | (mac[2]! << 8) | mac[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

export interface MagicLink {
  /** Put this in the link's fragment (magicLinkUrl). */
  token: string;
  code: string;
  nonce: string;
  exp: number;
  emailHash: string;
}

/** Make a magic link for an address. */
export async function createMagicLink(email: string, secret: string, options: { now?: number; ttlMs?: number } = {}): Promise<MagicLink> {
  const nonce = randomId(16);
  const hash = await emailHash(email, secret);
  const ttl = options.ttlMs ?? MAGIC_TTL_MS;
  const now = options.now ?? Date.now();
  const token = await signToken({ e: hash, n: nonce }, secret, ttl, { purpose: PURPOSE, now });
  return { token, code: await magicCode(nonce, secret), nonce, exp: Math.floor(now + ttl), emailHash: hash };
}

/** The link to send: the token rides in the fragment, which never reaches a server log. */
export function magicLinkUrl(publicUrl: string, token: string, path = '/signin'): string {
  const base = new URL(publicUrl);
  return `${base.origin}${path}#magic=${encodeURIComponent(token)}`;
}

export type MagicResult =
  | { ok: true; emailHash: string; nonce: string; exp: number }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'used' | 'email' };

export interface MagicVerifyOptions {
  /** Mark the nonce used; true the first time only. */
  consume: (nonce: string, exp: number) => boolean | Promise<boolean>;
  /** When the caller knows which address to expect (e.g. the code form), check it too. */
  email?: string;
  now?: number;
}

/** Check a magic-link token and use it up. */
export async function verifyMagicLink(token: string, secret: string, options: MagicVerifyOptions): Promise<MagicResult> {
  const r = await verifyToken<{ e?: unknown; n?: unknown }>(token, secret, { purpose: PURPOSE, now: options.now });
  if (!r.ok) return r;
  const { e, n } = r.payload ?? {};
  if (typeof e !== 'string' || typeof n !== 'string') return { ok: false, reason: 'malformed' };
  if (options.email !== undefined && !timingSafeEqual(e, await emailHash(options.email, secret))) return { ok: false, reason: 'email' };
  if (!(await options.consume(n, r.exp))) return { ok: false, reason: 'used' };
  return { ok: true, emailHash: e, nonce: n, exp: r.exp };
}

/** Check a typed code against a pending link (nonce, exp and address hash as stored) and use it up. */
export async function verifyMagicCode(
  code: string,
  pending: { nonce: string; exp: number; emailHash: string },
  secret: string,
  options: MagicVerifyOptions,
): Promise<MagicResult> {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return { ok: false, reason: 'malformed' };
  if ((options.now ?? Date.now()) >= pending.exp) return { ok: false, reason: 'expired' };
  if (options.email !== undefined && !timingSafeEqual(pending.emailHash, await emailHash(options.email, secret))) return { ok: false, reason: 'email' };
  if (!timingSafeEqual(code.trim(), await magicCode(pending.nonce, secret))) return { ok: false, reason: 'signature' };
  if (!(await options.consume(pending.nonce, pending.exp))) return { ok: false, reason: 'used' };
  return { ok: true, emailHash: pending.emailHash, nonce: pending.nonce, exp: pending.exp };
}
