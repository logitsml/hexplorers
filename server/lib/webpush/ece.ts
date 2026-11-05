// Encrypted Content-Encoding "aes128gcm" (RFC 8188) and its Web Push profile (RFC 8291).
//
// RFC 8188 body: header (salt 16 | record size 4 | key id length 1 | key id) then records, each
// AES-128-GCM of (plaintext | delimiter 0x01, or 0x02 for the last | zero padding).
//   PRK   = HMAC-SHA-256(salt, IKM)
//   CEK   = HMAC-SHA-256(PRK, "Content-Encoding: aes128gcm" 0x00 0x01)[0..16]
//   NONCE = HMAC-SHA-256(PRK, "Content-Encoding: nonce" 0x00 0x01)[0..12], XORed with the record number
//
// RFC 8291 sets IKM from an ECDH between a one-off server key and the subscription's p256dh key, mixed
// with the subscription's auth secret, and puts the server's public key in the key id:
//   PRK_key = HMAC-SHA-256(auth_secret, ecdh_secret)
//   IKM     = HMAC-SHA-256(PRK_key, "WebPush: info" 0x00 | ua_public | as_public | 0x01)
// A push message is one record of 4096 bytes at most, so at most 3993 bytes of plaintext.

import { asBytes, concat, fromBase64Url, hmacSha256, utf8, type Bytes } from '../crypto';

/** Web Push's record size (RFC 8291 §4). */
export const PUSH_RECORD_SIZE = 4096;
/** The most plaintext (plus padding) one push message can carry: 4096 − 86 header − 16 tag − 1 delimiter. */
export const PUSH_MAX_PLAINTEXT = 3993;

const TAG = 16;

async function deriveKeyAndNonce(ikm: Uint8Array, salt: Uint8Array): Promise<{ key: CryptoKey; nonce: Bytes }> {
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concat(utf8('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concat(utf8('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, nonce };
}

function recordNonce(base: Uint8Array, seq: number): Bytes {
  const nonce = new Uint8Array(base);
  // The record number is a 96-bit big-endian integer; records here never pass 2^32.
  for (let i = 0; i < 4; i++) nonce[11 - i]! ^= (seq >>> (8 * i)) & 0xff;
  return nonce;
}

export interface EncryptOptions {
  /** 16 random bytes unless given (tests use the RFC's fixed salt). */
  salt?: Uint8Array;
  /** The key id to put in the header (for Web Push: the server's public key). */
  keyId?: Uint8Array;
  recordSize?: number;
  /** Zero bytes of padding after the delimiter, to hide the plaintext's length. */
  padding?: number;
}

/** Encrypt into a single aes128gcm record (RFC 8188). Throws if it doesn't fit the record size. */
export async function encryptAes128gcm(plaintext: Uint8Array | string, ikm: Uint8Array, options: EncryptOptions = {}): Promise<Bytes> {
  const data = asBytes(plaintext);
  const salt = options.salt ? asBytes(options.salt) : crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('aes128gcm: salt must be 16 bytes');
  const keyId = options.keyId ? asBytes(options.keyId) : new Uint8Array(0);
  if (keyId.length > 255) throw new Error('aes128gcm: key id too long');
  const rs = options.recordSize ?? PUSH_RECORD_SIZE;
  const padding = options.padding ?? 0;
  if (!Number.isInteger(padding) || padding < 0) throw new Error('aes128gcm: bad padding');
  if (data.length + 1 + padding + TAG > rs) throw new Error('aes128gcm: plaintext does not fit one record');
  const { key, nonce } = await deriveKeyAndNonce(ikm, salt);
  const record = new Uint8Array(data.length + 1 + padding);
  record.set(data);
  record[data.length] = 2; // the last (only) record
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: recordNonce(nonce, 0) }, key, record));
  const header = new Uint8Array(21 + keyId.length);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = keyId.length;
  header.set(keyId, 21);
  return concat(header, sealed);
}

export interface Aes128gcmHeader {
  salt: Bytes;
  recordSize: number;
  keyId: Bytes;
  /** Where the records start. */
  offset: number;
}

/** Read an aes128gcm header. */
export function parseAes128gcmHeader(body: Uint8Array): Aes128gcmHeader {
  if (body.length < 21) throw new Error('aes128gcm: truncated header');
  const b = asBytes(body);
  const recordSize = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(16);
  const idLen = b[20]!;
  if (b.length < 21 + idLen) throw new Error('aes128gcm: truncated header');
  if (recordSize < 18) throw new Error('aes128gcm: record size too small');
  return { salt: b.slice(0, 16), recordSize, keyId: b.slice(21, 21 + idLen), offset: 21 + idLen };
}

/**
 * Decrypt an aes128gcm body (any number of records). `ikm` may depend on the header's key id (Web
 * Push puts the sender's public key there).
 */
export async function decryptAes128gcm(
  body: Uint8Array,
  ikm: Uint8Array | ((keyId: Bytes) => Uint8Array | Promise<Uint8Array>),
): Promise<{ plaintext: Bytes; header: Aes128gcmHeader }> {
  const header = parseAes128gcmHeader(body);
  const keyMaterial = typeof ikm === 'function' ? await ikm(header.keyId) : ikm;
  const { key, nonce } = await deriveKeyAndNonce(keyMaterial, header.salt);
  const records = asBytes(body).subarray(header.offset);
  if (records.length === 0) throw new Error('aes128gcm: no records');
  const out: Uint8Array[] = [];
  let seq = 0;
  for (let at = 0; at < records.length; at += header.recordSize, seq++) {
    const sealed = records.subarray(at, Math.min(records.length, at + header.recordSize));
    if (sealed.length <= TAG) throw new Error('aes128gcm: truncated record');
    const isLast = at + header.recordSize >= records.length;
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: recordNonce(nonce, seq) }, key, sealed));
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (end < 0) throw new Error('aes128gcm: record has no delimiter');
    if (plain[end] !== (isLast ? 2 : 1)) throw new Error('aes128gcm: bad delimiter');
    out.push(plain.subarray(0, end));
  }
  return { plaintext: concat(...out), header };
}

// ------------------------------------------------------------------ RFC 8291

export interface PushSubscriptionKeys {
  /** The user agent's P-256 public key: 65 bytes, uncompressed, base64url. */
  p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  auth: string;
}

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function webPushIkm(ecdhSecret: Uint8Array, authSecret: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array): Promise<Bytes> {
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  return hmacSha256(prkKey, concat(utf8('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
}

function checkPoint(point: Uint8Array, what: string): void {
  if (point.length !== 65 || point[0] !== 4) throw new Error(`webpush: ${what} must be an uncompressed P-256 point`);
}

export interface WebPushEncryptOptions {
  padding?: number;
  /** Fixed salt (tests). */
  salt?: Uint8Array;
  /** Fixed server ECDH key pair (tests); a fresh one is made for every message otherwise. */
  serverKeys?: { privateKey: CryptoKey; publicKey: Uint8Array };
}

/** Encrypt a push message for a subscription (RFC 8291). Returns the request body. */
export async function encryptPushPayload(
  payload: Uint8Array | string,
  keys: PushSubscriptionKeys,
  options: WebPushEncryptOptions = {},
): Promise<Bytes> {
  const uaPublic = fromBase64Url(keys.p256dh);
  const authSecret = fromBase64Url(keys.auth);
  checkPoint(uaPublic, 'p256dh');
  if (authSecret.length !== 16) throw new Error('webpush: auth secret must be 16 bytes');
  const data = asBytes(payload);
  if (data.length + (options.padding ?? 0) > PUSH_MAX_PLAINTEXT) throw new Error('webpush: payload too large');
  let server = options.serverKeys;
  if (!server) {
    const pair = (await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
    server = { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  }
  const asPublic = asBytes(server.publicKey);
  checkPoint(asPublic, 'server public key');
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, P256, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256));
  const ikm = await webPushIkm(ecdh, authSecret, uaPublic, asPublic);
  return encryptAes128gcm(data, ikm, { salt: options.salt, keyId: asPublic, recordSize: PUSH_RECORD_SIZE, padding: options.padding });
}

/**
 * Decrypt a push message as the user agent would (tests, and checking our own output). The
 * recipient's private key is an ECDH P-256 key.
 */
export async function decryptPushPayload(
  body: Uint8Array,
  recipient: { privateKey: CryptoKey; publicKey: Uint8Array; auth: Uint8Array },
): Promise<Bytes> {
  const { plaintext } = await decryptAes128gcm(body, async (asPublic) => {
    checkPoint(asPublic, 'key id');
    const asKey = await crypto.subtle.importKey('raw', asPublic, P256, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, recipient.privateKey, 256));
    return webPushIkm(ecdh, recipient.auth, recipient.publicKey, asPublic);
  });
  return plaintext;
}
