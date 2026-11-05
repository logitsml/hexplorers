// Byte helpers: UTF-8, base64 and base64url (RFC 4648), hex, concatenation, a constant-time compare and
// random values. Web standard APIs only (TextEncoder, btoa/atob, crypto.getRandomValues), so the same
// code runs on Node and on Cloudflare Workers.

/** A byte array backed by a plain ArrayBuffer (what WebCrypto's BufferSource accepts). */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A string's UTF-8 bytes. */
export function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}

/** Bytes as UTF-8 text (throws on invalid UTF-8). */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Bytes as they are, or a string's UTF-8 bytes; copies a view onto any other kind of buffer. */
export function asBytes(input: Uint8Array | string): Bytes {
  if (typeof input === 'string') return utf8(input);
  return input.buffer instanceof ArrayBuffer ? (input as Bytes) : new Uint8Array(input);
}

/** Standard base64 with padding. */
export function toBase64(input: Uint8Array | string): string {
  const bytes = asBytes(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** base64url without padding (RFC 4648 §5), as JWTs, WebAuthn and Web Push use. */
export function toBase64Url(input: Uint8Array | string): string {
  return toBase64(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url or base64, padded or not. Throws on anything else. */
export function fromBase64Url(text: string): Bytes {
  const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new Error('invalid base64');
  const binary = atob(clean + '==='.slice((clean.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The same as fromBase64Url, under the name the standard alphabet suggests. */
export const fromBase64 = fromBase64Url;

/** Lower-case hex. */
export function toHex(input: Uint8Array): string {
  let out = '';
  for (const b of input) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Decode hex (either case). Throws on odd length or non-hex characters. */
export function fromHex(text: string): Bytes {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) throw new Error('invalid hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Join byte arrays. */
export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Compare two byte arrays (or strings, by their UTF-8 bytes) in time that depends only on their
 * lengths, never on where they first differ.
 */
export function timingSafeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const x = asBytes(a);
  const y = asBytes(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] ?? 0) ^ (y[i % (y.length || 1)] ?? 0);
  return diff === 0;
}

/** Cryptographically random bytes. */
export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

/** A random id: `bytes` random bytes as base64url (16 bytes = 128 bits = 22 characters). */
export function randomId(bytes = 16): string {
  return toBase64Url(randomBytes(bytes));
}
