// Room codes, ids, encodings and the fair-dice arithmetic, shared by the server and the client.
// Nothing here imports anything: randomness and hashing come from WebCrypto, which every runtime
// (browsers, Node, Workers) has as the global `crypto`.

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './protocol';

/** Cryptographic random bytes (a runtime may pass its own, e.g. a seeded one in tests). */
export type RandomBytes = (n: number) => Uint8Array;

export const cryptoRandom: RandomBytes = (n) => {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
};

// ------------------------------------------------------------------ encodings

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding. */
export function b64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
  }
  return out;
}

/** The bytes of a base64url string, or null when it isn't one. */
export function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64.indexOf(s[i + k]) : 0));
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    out[o++] = n >> 16;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out;
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** Two byte strings equal, in time that doesn't depend on where they differ. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ------------------------------------------------------------------ codes and ids

/** A room code: ROOM_CODE_LENGTH letters of ROOM_CODE_ALPHABET, uniformly (rejection sampling). */
export function roomCode(random: RandomBytes = cryptoRandom): string {
  const n = ROOM_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < ROOM_CODE_LENGTH) {
    for (const b of random(ROOM_CODE_LENGTH * 2)) {
      if (b < limit && out.length < ROOM_CODE_LENGTH) out += ROOM_CODE_ALPHABET[b % n];
    }
  }
  return out;
}

/** A random id: `bytes` random bytes as base64url, with an optional prefix ('g_' for a guest, say). */
export const newId = (prefix = '', bytes = 12, random: RandomBytes = cryptoRandom): string => prefix + b64url(random(bytes));

/** A key: 32 random bytes as hex. */
export const newKey = (random: RandomBytes = cryptoRandom): string => hex(random(32));

/** A 32-bit unsigned integer. */
export function randomUint32(random: RandomBytes = cryptoRandom): number {
  const b = random(4);
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

// ------------------------------------------------------------------ hashing (async: WebCrypto)

export async function sha256(data: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : data));
}

export async function hmacSha256(key: Uint8Array<ArrayBuffer>, data: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? utf8(data) : data));
}

// ------------------------------------------------------------------ fair dice

/** What the dice commitment hashes ahead of the room's key K (hex). */
export const DICE_PREFIX = 'exploratory/dice/v1|';
/** What the game key's HMAC signs ahead of the seats' nonces. */
export const GAME_KEY_PREFIX = 'exploratory/game/v1|';

/** C = SHA-256("exploratory/dice/v1|" + K), as hex: published in the harbour, before any seat sends a nonce. */
export const diceCommit = async (key: string): Promise<string> => hex(await sha256(DICE_PREFIX + key));

/**
 * K' = HMAC-SHA-256(K, "exploratory/game/v1|" + the nonces in seat order joined by "|", a seat
 * that sent none as the empty string), as hex: the game's RNG key (createGame's rngKey).
 */
export async function gameKey(key: string, nonces: readonly (string | null)[]): Promise<string> {
  const k = fromHex(key);
  if (!k || k.length !== 32) throw new Error('A dice key is 32 bytes of hex.');
  return hex(await hmacSha256(k, GAME_KEY_PREFIX + nonces.map((n) => n ?? '').join('|')));
}

/** A nonce a seat may send: 16 to 64 characters of base64url or hex. */
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Checks a game-over reveal against the commitment the room showed: returns the game key to
 * replay the log with (createGame(seats, options, { rngKey })), or null when K doesn't match C.
 */
export async function checkReveal(commit: string, key: string, nonces: readonly (string | null)[]): Promise<string | null> {
  if ((await diceCommit(key)) !== commit) return null;
  return gameKey(key, nonces);
}

// ------------------------------------------------------------------ compression (async: CompressionStream)

async function pipeThrough(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** gzip of a string's UTF-8 (checkpoints, replays). */
export const gzip = (text: string): Promise<Uint8Array<ArrayBuffer>> => pipeThrough(utf8(text), new CompressionStream('gzip'));

export const gunzip = async (data: Uint8Array): Promise<string> => new TextDecoder().decode(await pipeThrough(new Uint8Array(data), new DecompressionStream('gzip')));
