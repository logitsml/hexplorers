// A minimal CBOR (RFC 8949) decoder and encoder: enough for WebAuthn's attestation objects and COSE
// keys. Definite lengths only (CTAP2 canonical CBOR never uses indefinite ones), maps decode to Map
// (COSE keys are integers), byte strings to Uint8Array, tags to { tag, value }. Inputs come from
// clients, so every length is checked against what's left and nesting is capped.

import { fromUtf8, utf8, type Bytes } from '../crypto';

export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Bytes
  | CborValue[]
  | Map<CborValue, CborValue>
  | CborTagged;

export interface CborTagged {
  tag: number;
  value: CborValue;
}

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** Decode one CBOR item starting at `offset`; returns it and where it ended. */
export function decodeCborPrefix(input: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const bytes = input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = offset;
  const need = (n: number): void => {
    if (at + n > bytes.length) throw new CborError('truncated CBOR');
  };
  const readArg = (info: number): number | bigint => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return bytes[at++]!;
    }
    if (info === 25) {
      need(2);
      const v = view.getUint16(at);
      at += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(at);
      at += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(at);
      at += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new CborError(info === 31 ? 'indefinite lengths are not supported' : 'reserved CBOR argument');
  };
  const length = (info: number): number => {
    const n = readArg(info);
    if (typeof n !== 'number') throw new CborError('CBOR length too large');
    return n;
  };
  const item = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new CborError('CBOR nested too deeply');
    need(1);
    const initial = bytes[at++]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return readArg(info);
      case 1: {
        const n = readArg(info);
        return typeof n === 'number' ? -1 - n : -1n - n;
      }
      case 2: {
        const n = length(info);
        need(n);
        const out = bytes.slice(at, at + n) as Bytes;
        at += n;
        return out;
      }
      case 3: {
        const n = length(info);
        need(n);
        let text: string;
        try {
          text = fromUtf8(bytes.subarray(at, at + n));
        } catch {
          throw new CborError('invalid UTF-8 in CBOR text');
        }
        at += n;
        return text;
      }
      case 4: {
        const n = length(info);
        if (n > MAX_ITEMS || n > bytes.length - at) throw new CborError('CBOR array too long');
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = length(info);
        if (n > MAX_ITEMS || n * 2 > bytes.length - at) throw new CborError('CBOR map too long');
        const out = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const key = item(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') throw new CborError('CBOR map keys must be integers or text');
          if (out.has(key)) throw new CborError('duplicate CBOR map key');
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 6: {
        const tag = readArg(info);
        if (typeof tag !== 'number') throw new CborError('CBOR tag too large');
        return { tag, value: item(depth + 1) };
      }
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) {
          need(2);
          const v = halfToFloat(view.getUint16(at));
          at += 2;
          return v;
        }
        if (info === 26) {
          need(4);
          const v = view.getFloat32(at);
          at += 4;
          return v;
        }
        if (info === 27) {
          need(8);
          const v = view.getFloat64(at);
          at += 8;
          return v;
        }
        throw new CborError('unsupported CBOR simple value');
      }
    }
  };
  const value = item(0);
  return { value, end: at };
}

/** Decode a whole buffer holding exactly one CBOR item. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, end } = decodeCborPrefix(bytes, 0);
  if (end !== bytes.length) throw new CborError('trailing bytes after CBOR');
  return value;
}

/** What encodeCbor accepts: plain objects encode as maps with text keys. */
export type CborInput =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborInput[]
  | Map<CborInput, CborInput>
  | { [key: string]: CborInput };

/** Encode integers, byte and text strings, arrays, maps, booleans and null (no floats). */
export function encodeCbor(value: CborInput): Bytes {
  const out: number[] = [];
  const head = (major: number, n: number | bigint): void => {
    const big = BigInt(n);
    if (big < 24n) out.push((major << 5) | Number(big));
    else if (big < 0x100n) out.push((major << 5) | 24, Number(big));
    else if (big < 0x10000n) out.push((major << 5) | 25, Number(big >> 8n), Number(big & 0xffn));
    else if (big < 0x100000000n) {
      out.push((major << 5) | 26);
      for (let s = 24n; s >= 0n; s -= 8n) out.push(Number((big >> s) & 0xffn));
    } else {
      out.push((major << 5) | 27);
      for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((big >> s) & 0xffn));
    }
  };
  const put = (v: CborInput): void => {
    if (typeof v === 'number' || typeof v === 'bigint') {
      if (typeof v === 'number' && !Number.isInteger(v)) throw new CborError('encodeCbor: floats are not supported');
      const big = BigInt(v);
      if (big >= 0n) head(0, big);
      else head(1, -1n - big);
    } else if (typeof v === 'string') {
      const b = utf8(v);
      head(3, b.length);
      for (const x of b) out.push(x);
    } else if (v instanceof Uint8Array) {
      head(2, v.length);
      for (const x of v) out.push(x);
    } else if (v === false) out.push(0xf4);
    else if (v === true) out.push(0xf5);
    else if (v === null) out.push(0xf6);
    else if (v === undefined) out.push(0xf7);
    else if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(put);
    } else if (v instanceof Map) {
      head(5, v.size);
      for (const [k, x] of v) {
        put(k);
        put(x);
      }
    } else {
      const entries = Object.entries(v);
      head(5, entries.length);
      for (const [k, x] of entries) {
        put(k);
        put(x);
      }
    }
  };
  put(value);
  return new Uint8Array(out);
}
