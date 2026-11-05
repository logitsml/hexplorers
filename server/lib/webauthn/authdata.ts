// Authenticator data (WebAuthn §6.1) and COSE public keys (RFC 9052/9053) → JWK.
//
// authData = rpIdHash (32) | flags (1) | signCount (4, big-endian)
//            [ | aaguid (16) | credentialIdLength (2) | credentialId | COSE public key ]  when AT is set
//            [ | extensions (CBOR map) ]                                                    when ED is set

import { asBytes, toBase64Url, type Bytes } from '../crypto';
import { decodeCborPrefix, type CborValue } from './cbor';

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

/** COSE algorithm ids this server accepts. */
export const ES256 = -7;
export const RS256 = -257;
export type CoseAlg = typeof ES256 | typeof RS256;

export interface AuthenticatorFlags {
  /** User present. */
  up: boolean;
  /** User verified (biometric or PIN). */
  uv: boolean;
  /** Backup eligible: a synced (multi-device) passkey. */
  be: boolean;
  /** Backed up right now. */
  bs: boolean;
  /** Attested credential data included. */
  at: boolean;
  /** Extension data included. */
  ed: boolean;
  raw: number;
}

export interface AttestedCredential {
  aaguid: Bytes;
  credentialId: Bytes;
  /** The COSE key as decoded. */
  publicKey: Map<CborValue, CborValue>;
  /** The COSE key's bytes as the authenticator wrote them. */
  publicKeyBytes: Bytes;
}

export interface AuthenticatorData {
  rpIdHash: Bytes;
  flags: AuthenticatorFlags;
  signCount: number;
  attested?: AttestedCredential;
  extensions?: CborValue;
}

export class WebAuthnFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebAuthnFormatError';
  }
}

/** Parse authenticator data. Throws WebAuthnFormatError on anything malformed. */
export function parseAuthenticatorData(input: Uint8Array): AuthenticatorData {
  const bytes = asBytes(input);
  if (bytes.length < 37) throw new WebAuthnFormatError('authenticator data too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = bytes[32]!;
  const flags: AuthenticatorFlags = {
    up: !!(raw & FLAG_UP),
    uv: !!(raw & FLAG_UV),
    be: !!(raw & FLAG_BE),
    bs: !!(raw & FLAG_BS),
    at: !!(raw & FLAG_AT),
    ed: !!(raw & FLAG_ED),
    raw,
  };
  if (flags.bs && !flags.be) throw new WebAuthnFormatError('backup state set without backup eligibility');
  const out: AuthenticatorData = { rpIdHash: bytes.slice(0, 32), flags, signCount: view.getUint32(33) };
  let at = 37;
  if (flags.at) {
    if (bytes.length < at + 18) throw new WebAuthnFormatError('attested credential data truncated');
    const aaguid = bytes.slice(at, at + 16);
    const idLen = view.getUint16(at + 16);
    at += 18;
    if (idLen === 0 || idLen > 1023 || bytes.length < at + idLen) throw new WebAuthnFormatError('bad credential id length');
    const credentialId = bytes.slice(at, at + idLen);
    at += idLen;
    let decoded: { value: CborValue; end: number };
    try {
      decoded = decodeCborPrefix(bytes, at);
    } catch {
      throw new WebAuthnFormatError('bad credential public key');
    }
    if (!(decoded.value instanceof Map)) throw new WebAuthnFormatError('credential public key is not a COSE map');
    out.attested = { aaguid, credentialId, publicKey: decoded.value, publicKeyBytes: bytes.slice(at, decoded.end) };
    at = decoded.end;
  }
  if (flags.ed) {
    try {
      const decoded = decodeCborPrefix(bytes, at);
      out.extensions = decoded.value;
      at = decoded.end;
    } catch {
      throw new WebAuthnFormatError('bad extension data');
    }
  }
  if (at !== bytes.length) throw new WebAuthnFormatError('trailing bytes in authenticator data');
  return out;
}

/** A COSE public key as a JWK WebCrypto can import, and its algorithm. Only ES256 and RS256. */
export function coseToJwk(cose: Map<CborValue, CborValue>): { jwk: JsonWebKey; alg: CoseAlg } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytesAt = (label: number, length?: number): Bytes => {
    const v = cose.get(label);
    if (!(v instanceof Uint8Array) || (length !== undefined && v.length !== length)) {
      throw new WebAuthnFormatError(`COSE key parameter ${label} missing or malformed`);
    }
    return v;
  };
  if (kty === 2 && alg === ES256) {
    if (cose.get(-1) !== 1) throw new WebAuthnFormatError('ES256 key must be on P-256');
    return {
      jwk: { kty: 'EC', crv: 'P-256', x: toBase64Url(bytesAt(-2, 32)), y: toBase64Url(bytesAt(-3, 32)) },
      alg: ES256,
    };
  }
  if (kty === 3 && alg === RS256) {
    const n = bytesAt(-1);
    if (n.length < 256) throw new WebAuthnFormatError('RSA key shorter than 2048 bits');
    return { jwk: { kty: 'RSA', n: toBase64Url(n), e: toBase64Url(bytesAt(-2)) }, alg: RS256 };
  }
  throw new WebAuthnFormatError('unsupported COSE key type or algorithm');
}
