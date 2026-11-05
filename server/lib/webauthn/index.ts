// server/lib/webauthn: passkeys (WebAuthn Level 3) without a library.
//
// Always on: passkeys need no outside account, only an RP id the browser accepts for the page's origin
// (localhost works locally).
//
// Registration ("Use this device"):
//   const { options, challenge } = registrationOptions({ rpId, rpName: 'Hexplorers', user: { id: userHandle, name, displayName } });
//   // keep `challenge` server-side or in a short-lived signed cookie (crypto.signToken), send `options`
//   // to the client (PublicKeyCredential.parseCreationOptionsFromJSON), then with its JSON answer:
//   const r = await verifyRegistration({ response, expectedChallenge: challenge, expectedOrigins, expectedRpId: rpId });
//   if (r.ok) store(r.credential);               // { id, publicKey (JWK), alg, signCount, backedUp, ... }
//
// Sign-in:
//   const { options, challenge } = authenticationOptions({ rpId });   // empty allowCredentials: discoverable
//   const a = await verifyAuthentication({ response, expectedChallenge: challenge, expectedOrigins, expectedRpId: rpId, credential: stored });
//   if (a.ok) updateSignCount(a.signCount);
//
// Attestation: 'none' and 'packed' self-attestation are checked; any other format (and packed with a
// certificate chain) is accepted with its attestation ignored, as for 'none'. Nothing here trusts an
// authenticator's make or model.

import { asBytes, concat, derToRawEcdsa, fromBase64Url, fromUtf8, importJwk, randomBytes, sha256, timingSafeEqual, toBase64Url, type Bytes } from '../crypto';
import { coseToJwk, ES256, parseAuthenticatorData, RS256, type AuthenticatorData, type CoseAlg } from './authdata';
import { decodeCbor, type CborValue } from './cbor';

export * from './authdata';
export * from './cbor';

/** How long the browser gives the user (ms). */
export const DEFAULT_TIMEOUT = 5 * 60_000;

export interface CredentialDescriptorJSON {
  type: 'public-key';
  /** base64url credential id. */
  id: string;
  transports?: string[];
}

/** The JSON form of PublicKeyCredentialCreationOptions (binary fields as base64url). */
export interface CreationOptionsJSON {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout: number;
  excludeCredentials: CredentialDescriptorJSON[];
  authenticatorSelection: { residentKey: 'preferred'; requireResidentKey: false; userVerification: 'preferred' | 'required' };
  attestation: 'none';
  extensions: { credProps: true };
}

/** The JSON form of PublicKeyCredentialRequestOptions. */
export interface RequestOptionsJSON {
  rpId: string;
  challenge: string;
  timeout: number;
  allowCredentials: CredentialDescriptorJSON[];
  userVerification: 'preferred' | 'required' | 'discouraged';
}

export interface RegistrationOptionsInput {
  rpId: string;
  rpName: string;
  /** user.id is the opaque user handle (1–64 bytes; a string is used by its UTF-8 bytes). Never an email. */
  user: { id: Uint8Array | string; name: string; displayName: string };
  /** Existing credentials of this user, so the same authenticator isn't registered twice. */
  excludeCredentials?: { id: string; transports?: string[] }[];
  timeout?: number;
  userVerification?: 'preferred' | 'required';
  /** A fixed challenge (tests); 32 random bytes otherwise. */
  challenge?: Uint8Array;
}

/** Options for navigator.credentials.create(), and the challenge to remember. */
export function registrationOptions(input: RegistrationOptionsInput): { options: CreationOptionsJSON; challenge: string } {
  const userId = asBytes(input.user.id);
  if (userId.length < 1 || userId.length > 64) throw new Error('webauthn: user id must be 1-64 bytes');
  const challenge = toBase64Url(input.challenge ?? randomBytes(32));
  return {
    challenge,
    options: {
      rp: { id: input.rpId, name: input.rpName },
      user: { id: toBase64Url(userId), name: input.user.name, displayName: input.user.displayName },
      challenge,
      pubKeyCredParams: [
        { type: 'public-key', alg: ES256 },
        { type: 'public-key', alg: RS256 },
      ],
      timeout: input.timeout ?? DEFAULT_TIMEOUT,
      excludeCredentials: (input.excludeCredentials ?? []).map((c) => ({ type: 'public-key' as const, id: c.id, ...(c.transports ? { transports: c.transports } : {}) })),
      authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: input.userVerification ?? 'preferred' },
      attestation: 'none',
      extensions: { credProps: true },
    },
  };
}

export interface AuthenticationOptionsInput {
  rpId: string;
  /** Leave empty for discoverable credentials (passkey autofill). */
  allowCredentials?: { id: string; transports?: string[] }[];
  timeout?: number;
  userVerification?: 'preferred' | 'required' | 'discouraged';
  challenge?: Uint8Array;
}

/** Options for navigator.credentials.get(), and the challenge to remember. */
export function authenticationOptions(input: AuthenticationOptionsInput): { options: RequestOptionsJSON; challenge: string } {
  const challenge = toBase64Url(input.challenge ?? randomBytes(32));
  return {
    challenge,
    options: {
      rpId: input.rpId,
      challenge,
      timeout: input.timeout ?? DEFAULT_TIMEOUT,
      allowCredentials: (input.allowCredentials ?? []).map((c) => ({ type: 'public-key' as const, id: c.id, ...(c.transports ? { transports: c.transports } : {}) })),
      userVerification: input.userVerification ?? 'preferred',
    },
  };
}

// ------------------------------------------------------------------ verification

export type WebAuthnError =
  | 'malformed'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'cross-origin'
  | 'rp-id'
  | 'user-presence'
  | 'user-verification'
  | 'algorithm'
  | 'attestation'
  | 'credential'
  | 'signature'
  | 'sign-count';

/** What the browser's PublicKeyCredential.toJSON() gives for create(). */
export interface RegistrationResponseJSON {
  id: string;
  rawId?: string;
  type?: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

/** What the browser's PublicKeyCredential.toJSON() gives for get(). */
export interface AuthenticationResponseJSON {
  id: string;
  rawId?: string;
  type?: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

/** A credential as the server stores it. */
export interface StoredCredential {
  /** base64url credential id. */
  id: string;
  publicKey: JsonWebKey;
  alg: CoseAlg;
  signCount: number;
}

export interface RegisteredCredential extends StoredCredential {
  transports: string[];
  /** base64url AAGUID (all zeros for most passkeys with attestation 'none'). */
  aaguid: string;
  userVerified: boolean;
  /** A synced passkey (backup eligible), and whether it is backed up now. */
  backupEligible: boolean;
  backedUp: boolean;
  /** The attestation format the authenticator used, and what was checked of it. */
  fmt: string;
  attestation: 'none' | 'self';
}

interface Expectations {
  expectedChallenge: string;
  /** Origins allowed to use the RP, e.g. ['http://localhost:5173', 'https://hexplorers.xyz']. */
  expectedOrigins: string[];
  expectedRpId: string;
  requireUserVerification?: boolean;
  /** Accept clientData.crossOrigin === true (an iframe on another site). Off by default. */
  allowCrossOrigin?: boolean;
}

type Fail = { ok: false; error: WebAuthnError };
const fail = (error: WebAuthnError): Fail => ({ ok: false, error });

function decode(text: unknown): Bytes | null {
  if (typeof text !== 'string' || text.length > 65536) return null;
  try {
    return fromBase64Url(text);
  } catch {
    return null;
  }
}

function normaliseOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : origin;
  } catch {
    return origin;
  }
}

/** clientDataJSON: type, challenge, origin, crossOrigin (WebAuthn §7.1 steps 7–12). */
function checkClientData(bytes: Bytes, type: 'webauthn.create' | 'webauthn.get', expect: Expectations): WebAuthnError | null {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(fromUtf8(bytes));
  } catch {
    return 'malformed';
  }
  if (typeof data !== 'object' || data === null) return 'malformed';
  if (data.type !== type) return 'type';
  const got = decode(data.challenge);
  const want = decode(expect.expectedChallenge);
  if (!got || !want || want.length < 16 || !timingSafeEqual(got, want)) return 'challenge';
  if (typeof data.origin !== 'string') return 'origin';
  const allowed = expect.expectedOrigins.map(normaliseOrigin);
  if (!allowed.includes(data.origin)) return 'origin';
  if (data.crossOrigin === true && !expect.allowCrossOrigin) return 'cross-origin';
  return null;
}

async function checkAuthData(auth: AuthenticatorData, expect: Expectations): Promise<WebAuthnError | null> {
  if (!timingSafeEqual(auth.rpIdHash, await sha256(expect.expectedRpId))) return 'rp-id';
  if (!auth.flags.up) return 'user-presence';
  if (expect.requireUserVerification && !auth.flags.uv) return 'user-verification';
  return null;
}

/** Verify a signature by a credential key: ES256 (DER, as authenticators sign) or RS256. */
export async function verifyCredentialSignature(publicKey: JsonWebKey, alg: CoseAlg, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    if (alg === ES256) {
      const key = await importJwk(publicKey, 'ES256', 'verify');
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRawEcdsa(signature), asBytes(data));
    }
    if (alg === RS256) {
      const key = await importJwk(publicKey, 'RS256', 'verify');
      return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, asBytes(signature), asBytes(data));
    }
  } catch {
    return false;
  }
  return false;
}

/** Check a create() answer and return the credential to store. */
export async function verifyRegistration(
  input: Expectations & { response: RegistrationResponseJSON },
): Promise<{ ok: true; credential: RegisteredCredential } | Fail> {
  const r = input.response;
  if (typeof r !== 'object' || r === null || typeof r.response !== 'object' || r.response === null) return fail('malformed');
  if (r.type !== undefined && r.type !== 'public-key') return fail('malformed');
  const clientDataJSON = decode(r.response.clientDataJSON);
  const attestationObject = decode(r.response.attestationObject);
  if (!clientDataJSON || !attestationObject) return fail('malformed');
  const clientError = checkClientData(clientDataJSON, 'webauthn.create', input);
  if (clientError) return fail(clientError);

  let att: CborValue;
  try {
    att = decodeCbor(attestationObject);
  } catch {
    return fail('malformed');
  }
  if (!(att instanceof Map)) return fail('malformed');
  const fmt = att.get('fmt');
  const attStmt = att.get('attStmt');
  const authDataBytes = att.get('authData');
  if (typeof fmt !== 'string' || !(attStmt instanceof Map) || !(authDataBytes instanceof Uint8Array)) return fail('malformed');
  let auth: AuthenticatorData;
  try {
    auth = parseAuthenticatorData(authDataBytes);
  } catch {
    return fail('malformed');
  }
  const authError = await checkAuthData(auth, input);
  if (authError) return fail(authError);
  if (!auth.flags.at || !auth.attested) return fail('malformed');

  let key: { jwk: JsonWebKey; alg: CoseAlg };
  try {
    key = coseToJwk(auth.attested.publicKey);
  } catch {
    return fail('algorithm');
  }
  const credentialId = toBase64Url(auth.attested.credentialId);
  if (r.id !== credentialId || (r.rawId !== undefined && r.rawId !== credentialId)) return fail('credential');

  let attestation: 'none' | 'self' = 'none';
  if (fmt === 'packed' && !attStmt.has('x5c')) {
    // Self attestation: the credential key signs authData || SHA-256(clientDataJSON).
    const alg = attStmt.get('alg');
    const sig = attStmt.get('sig');
    if (alg !== key.alg || !(sig instanceof Uint8Array)) return fail('attestation');
    const signed = concat(authDataBytes, await sha256(clientDataJSON));
    if (!(await verifyCredentialSignature(key.jwk, key.alg, signed, sig))) return fail('attestation');
    attestation = 'self';
  }
  // 'none', packed with a certificate chain, and every other format: attestation ignored.

  return {
    ok: true,
    credential: {
      id: credentialId,
      publicKey: key.jwk,
      alg: key.alg,
      signCount: auth.signCount,
      transports: Array.isArray(r.response.transports) ? r.response.transports.filter((t) => typeof t === 'string').slice(0, 8) : [],
      aaguid: toBase64Url(auth.attested.aaguid),
      userVerified: auth.flags.uv,
      backupEligible: auth.flags.be,
      backedUp: auth.flags.bs,
      fmt,
      attestation,
    },
  };
}

export interface AuthenticationResult {
  ok: true;
  /** Store this as the credential's new count. */
  signCount: number;
  userVerified: boolean;
  backedUp: boolean;
  /** The user handle the authenticator returned (discoverable credentials), base64url. */
  userHandle: string | null;
}

/**
 * Check a get() answer against the stored credential. A sign count that didn't go up (when either
 * count is non-zero) fails as 'sign-count': the authenticator may have been cloned.
 */
export async function verifyAuthentication(
  input: Expectations & { response: AuthenticationResponseJSON; credential: StoredCredential },
): Promise<AuthenticationResult | Fail> {
  const r = input.response;
  if (typeof r !== 'object' || r === null || typeof r.response !== 'object' || r.response === null) return fail('malformed');
  if (r.type !== undefined && r.type !== 'public-key') return fail('malformed');
  if (r.id !== input.credential.id || (r.rawId !== undefined && r.rawId !== input.credential.id)) return fail('credential');
  const clientDataJSON = decode(r.response.clientDataJSON);
  const authDataBytes = decode(r.response.authenticatorData);
  const signature = decode(r.response.signature);
  if (!clientDataJSON || !authDataBytes || !signature) return fail('malformed');
  const clientError = checkClientData(clientDataJSON, 'webauthn.get', input);
  if (clientError) return fail(clientError);
  let auth: AuthenticatorData;
  try {
    auth = parseAuthenticatorData(authDataBytes);
  } catch {
    return fail('malformed');
  }
  const authError = await checkAuthData(auth, input);
  if (authError) return fail(authError);
  const signed = concat(authDataBytes, await sha256(clientDataJSON));
  if (!(await verifyCredentialSignature(input.credential.publicKey, input.credential.alg, signed, signature))) return fail('signature');
  const stored = input.credential.signCount;
  if ((stored !== 0 || auth.signCount !== 0) && auth.signCount <= stored) return fail('sign-count');
  const handle = r.response.userHandle;
  return {
    ok: true,
    signCount: auth.signCount,
    userVerified: auth.flags.uv,
    backedUp: auth.flags.bs,
    userHandle: typeof handle === 'string' && handle.length > 0 ? handle : null,
  };
}
