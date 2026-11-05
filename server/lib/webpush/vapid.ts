// VAPID (RFC 8292): the application server identifies itself to push services with an ES256 JWT
// {aud: the push service's origin, exp: at most 24 h ahead, sub: mailto: or https: contact} and its
// public key, in `Authorization: vapid t=<jwt>, k=<public key>`.
//
// Keys travel as base64url: the public key as the 65-byte uncompressed point (what the browser's
// pushManager.subscribe({applicationServerKey}) takes), the private key as the 32-byte scalar d (the
// format the `web-push` tools print), or a private JWK as JSON.

import { fromBase64Url, signJwt, toBase64Url, utf8, type Bytes } from '../crypto';

export interface VapidKeys {
  /** base64url, 65 bytes: 0x04 | x | y. Give this to clients (GET /api/config). */
  publicKey: string;
  /** base64url, 32 bytes (the scalar d), or a private JWK as JSON. Never log or send this. */
  privateKey: string;
}

/** An imported key pair, ready to sign. Keeps a small per-audience cache of JWTs. */
export interface VapidSigner {
  readonly publicKey: string;
  readonly key: CryptoKey;
  /** aud -> { header, exp (s) } */
  readonly cache: Map<string, { authorization: string; exp: number }>;
}

/** RFC 8292 §2: exp must be no more than 24 hours after the request. */
export const VAPID_MAX_EXPIRY_SECONDS = 24 * 3600;
const DEFAULT_EXPIRY_SECONDS = 12 * 3600;

/** Make a fresh P-256 key pair (on first run, when the environment has none). */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: toBase64Url(raw), privateKey: jwk.d! };
}

/** Import keys from the environment. Throws (without echoing them) if they're malformed or don't match. */
export async function importVapidKeys(keys: VapidKeys): Promise<VapidSigner> {
  let point: Bytes;
  try {
    point = fromBase64Url(keys.publicKey);
  } catch {
    throw new Error('VAPID public key is not base64url');
  }
  if (point.length !== 65 || point[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 point (65 bytes)');
  const x = toBase64Url(point.subarray(1, 33));
  const y = toBase64Url(point.subarray(33));
  let d = keys.privateKey.trim();
  if (d.startsWith('{')) {
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(d) as JsonWebKey;
    } catch {
      throw new Error('VAPID private key JWK is not valid JSON');
    }
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('VAPID private key JWK must be an EC P-256 private key');
    if ((jwk.x && jwk.x !== x) || (jwk.y && jwk.y !== y)) throw new Error('VAPID private key does not match the public key');
    d = jwk.d;
  }
  let scalar: Uint8Array;
  try {
    scalar = fromBase64Url(d);
  } catch {
    throw new Error('VAPID private key is not base64url');
  }
  if (scalar.length !== 32) throw new Error('VAPID private key must be 32 bytes');
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x, y, d: toBase64Url(scalar) },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new Error('VAPID keys could not be imported');
  }
  // Prove the pair matches: a push service would refuse every message otherwise.
  const probe = utf8('exploratory/vapid-check');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, probe);
  const pub = await crypto.subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, probe))) {
    throw new Error('VAPID private key does not match the public key');
  }
  return { publicKey: toBase64Url(point), key, cache: new Map() };
}

/** Check a VAPID subject: a mailto: address or an https: URL (RFC 8292 §2.1). */
export function isValidSubject(subject: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+$/.test(subject)) return true;
  try {
    return new URL(subject).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The Authorization header value for a push endpoint: `vapid t=<jwt>, k=<public key>`. JWTs are
 * reused per push service while they have more than an hour left.
 */
export async function vapidAuthorization(
  endpoint: string,
  signer: VapidSigner,
  subject: string,
  options: { now?: number; expiresIn?: number } = {},
): Promise<string> {
  if (!isValidSubject(subject)) throw new Error('VAPID subject must be a mailto: address or an https: URL');
  const aud = new URL(endpoint).origin;
  const nowS = Math.floor((options.now ?? Date.now()) / 1000);
  const cached = signer.cache.get(aud);
  if (cached && cached.exp - nowS > 3600 && options.expiresIn === undefined) return cached.authorization;
  const expiresIn = Math.min(options.expiresIn ?? DEFAULT_EXPIRY_SECONDS, VAPID_MAX_EXPIRY_SECONDS);
  if (!(expiresIn > 0)) throw new Error('VAPID expiry must be positive');
  const exp = nowS + expiresIn;
  const jwt = await signJwt({ alg: 'ES256' }, { aud, exp, sub: subject }, signer.key);
  const authorization = `vapid t=${jwt}, k=${signer.publicKey}`;
  if (options.expiresIn === undefined) {
    if (signer.cache.size > 64) signer.cache.clear();
    signer.cache.set(aud, { authorization, exp });
  }
  return authorization;
}
