// Compact JWS/JWT (RFC 7515/7519) for the two algorithms the server meets: ES256 (VAPID, Apple's
// client secret, Apple and passkey keys) and RS256 (Google's and Apple's id_tokens). Also the ECDSA
// signature conversions WebCrypto needs: WebCrypto signs and verifies raw r||s, while WebAuthn
// authenticators (and X.509) use DER.

import { asBytes, concat, fromBase64, fromBase64Url, fromUtf8, toBase64Url, utf8, type Bytes } from './bytes';

export type JwtAlg = 'ES256' | 'RS256';

export interface JwtHeader {
  alg: string;
  typ?: string;
  kid?: string;
  [key: string]: unknown;
}

export interface DecodedJwt {
  header: JwtHeader;
  payload: Record<string, unknown>;
  /** `base64url(header).base64url(payload)` as bytes: what the signature covers. */
  signingInput: Bytes;
  signature: Bytes;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

/** Longest JWT decodeJwt will parse. */
export const JWT_MAX_LENGTH = 16384;

function algParams(alg: JwtAlg): { importParams: EcKeyImportParams | RsaHashedImportParams; signParams: EcdsaParams | AlgorithmIdentifier } {
  if (alg === 'ES256') {
    return { importParams: { name: 'ECDSA', namedCurve: 'P-256' }, signParams: { name: 'ECDSA', hash: 'SHA-256' } };
  }
  return { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, signParams: { name: 'RSASSA-PKCS1-v1_5' } };
}

/** Import a JWK as a signing or verifying key for `alg`. */
export function importJwk(jwk: JsonWebKey, alg: JwtAlg, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  // Strip fields WebCrypto is strict about (a JWKS entry's "alg" may be absent or "use" set).
  const { kty, crv, x, y, d, n, e, p, q, dp, dq, qi } = jwk;
  const clean: JsonWebKey = Object.fromEntries(
    Object.entries({ kty, crv, x, y, d, n, e, p, q, dp, dq, qi }).filter(([, v]) => v !== undefined),
  );
  return crypto.subtle.importKey('jwk', clean, algParams(alg).importParams, true, [usage]);
}

/** Import a PKCS#8 private key in PEM ("-----BEGIN PRIVATE KEY-----", e.g. Apple's .p8 file). */
export function importPkcs8Pem(pem: string, alg: JwtAlg): Promise<CryptoKey> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  return crypto.subtle.importKey('pkcs8', fromBase64(body), algParams(alg).importParams, false, ['sign']);
}

/** Split and decode a compact JWT. Throws JwtError when it isn't one. */
export function decodeJwt(token: string): DecodedJwt {
  if (typeof token !== 'string' || token.length > JWT_MAX_LENGTH) throw new JwtError('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(fromUtf8(fromBase64Url(h))) as JwtHeader;
    const payload = JSON.parse(fromUtf8(fromBase64Url(p))) as Record<string, unknown>;
    if (typeof header !== 'object' || header === null || typeof header.alg !== 'string') throw new Error();
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error();
    return { header, payload, signingInput: utf8(`${h}.${p}`), signature: fromBase64Url(s) };
  } catch {
    throw new JwtError('malformed token');
  }
}

/** Sign a JWT. ES256 signatures are raw r||s (64 bytes), as JWS requires and WebCrypto produces. */
export async function signJwt(header: { alg: JwtAlg; kid?: string; typ?: string }, payload: object, key: CryptoKey): Promise<string> {
  const h = toBase64Url(JSON.stringify({ typ: 'JWT', ...header }));
  const p = toBase64Url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign(algParams(header.alg).signParams, key, utf8(`${h}.${p}`));
  return `${h}.${p}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Check a JWT's signature with `key` (a CryptoKey or a JWK). The header's alg must be `alg`, so a
 * token can never choose its own algorithm ("none", or HS256 with a public key as the secret).
 */
export async function verifyJwtSignature(token: string | DecodedJwt, key: CryptoKey | JsonWebKey, alg: JwtAlg): Promise<boolean> {
  const jwt = typeof token === 'string' ? decodeJwt(token) : token;
  if (jwt.header.alg !== alg) return false;
  if (alg === 'ES256' && jwt.signature.length !== 64) return false;
  const k = key instanceof CryptoKey ? key : await importJwk(key, alg, 'verify');
  return crypto.subtle.verify(algParams(alg).signParams, k, jwt.signature, jwt.signingInput);
}

// ------------------------------------------------------------------ ECDSA signature encodings

/** An ECDSA DER signature (SEQUENCE of two INTEGERs) as raw r||s, each `size` bytes. Throws if malformed. */
export function derToRawEcdsa(der: Uint8Array, size = 32): Bytes {
  const fail = (): never => {
    throw new Error('malformed ECDSA signature');
  };
  if (der.length < 8 || der[0] !== 0x30) fail();
  let at = 2;
  let seqLen = der[1]!;
  if (seqLen === 0x81) {
    seqLen = der[2]!;
    at = 3;
  } else if (seqLen > 0x80) fail();
  if (at + seqLen !== der.length) fail();
  const out = new Uint8Array(size * 2);
  for (let i = 0; i < 2; i++) {
    if (der[at] !== 0x02) fail();
    const len = der[at + 1]!;
    if (len === 0 || len > size + 1 || at + 2 + len > der.length) fail();
    let int = der.subarray(at + 2, at + 2 + len);
    // A leading zero only pads a high bit; anything longer than size after stripping it is invalid.
    while (int.length > 1 && int[0] === 0) int = int.subarray(1);
    if (int.length > size) fail();
    out.set(int, i * size + (size - int.length));
    at += 2 + len;
  }
  if (at !== der.length) fail();
  return out;
}

/** Raw r||s as an ECDSA DER signature. */
export function rawToDerEcdsa(raw: Uint8Array): Bytes {
  if (raw.length === 0 || raw.length % 2 !== 0) throw new Error('malformed ECDSA signature');
  const half = raw.length / 2;
  const int = (bytes: Uint8Array): Bytes => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const v = bytes.subarray(i);
    const body = v[0]! & 0x80 ? concat(new Uint8Array([0]), v) : asBytes(v);
    return concat(new Uint8Array([0x02, body.length]), body);
  };
  const r = int(raw.subarray(0, half));
  const s = int(raw.subarray(half));
  const len = r.length + s.length;
  return concat(new Uint8Array(len < 0x80 ? [0x30, len] : [0x30, 0x81, len]), r, s);
}
