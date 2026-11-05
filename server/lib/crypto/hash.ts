// SHA-256, HMAC-SHA-256 and HKDF-SHA-256 on WebCrypto.

import { asBytes, timingSafeEqual, toHex, type Bytes } from './bytes';

/** SHA-256 of bytes, or of a string's UTF-8 bytes. */
export async function sha256(data: Uint8Array | string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', asBytes(data)));
}

/** SHA-256 as lower-case hex. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(data));
}

/**
 * An HMAC-SHA-256 key. A string secret is used by its UTF-8 bytes (so TOKEN_SECRET works whether
 * or not it is hex).
 */
export function hmacKey(secret: Uint8Array | string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** HMAC-SHA-256(secret, data). */
export async function hmacSha256(secret: Uint8Array | string | CryptoKey, data: Uint8Array | string): Promise<Bytes> {
  const key = secret instanceof CryptoKey ? secret : await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, asBytes(data)));
}

/** HMAC-SHA-256 as lower-case hex. */
export async function hmacSha256Hex(secret: Uint8Array | string | CryptoKey, data: Uint8Array | string): Promise<string> {
  return toHex(await hmacSha256(secret, data));
}

/** Check a MAC in constant time. */
export async function hmacVerify(
  secret: Uint8Array | string | CryptoKey,
  data: Uint8Array | string,
  mac: Uint8Array,
): Promise<boolean> {
  return timingSafeEqual(await hmacSha256(secret, data), mac);
}

/** HKDF-SHA-256 (RFC 5869): `length` bytes of output keying material. */
export async function hkdf(
  ikm: Uint8Array | string,
  salt: Uint8Array | string,
  info: Uint8Array | string,
  length: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', asBytes(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: asBytes(salt), info: asBytes(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}
