import { describe, expect, it, vi } from 'vitest';
import { concat, fromBase64Url, fromHex, rawToDerEcdsa, sha256, toBase64Url, toHex, utf8 } from '../../server/lib/crypto';
import {
  FLAG_AT,
  FLAG_BE,
  FLAG_BS,
  FLAG_UP,
  FLAG_UV,
  authenticationOptions,
  coseToJwk,
  decodeCbor,
  encodeCbor,
  parseAuthenticatorData,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type CborInput,
  type CreationOptionsJSON,
  type RequestOptionsJSON,
  type StoredCredential,
} from '../../server/lib/webauthn';

vi.setConfig({ testTimeout: 60_000 });

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:5173';
const ORIGINS = [ORIGIN, 'https://hexplorers.xyz'];

type Alg = 'ES256' | 'RS256';

interface CreateTweaks {
  origin?: string;
  rpId?: string;
  type?: string;
  challenge?: string;
  crossOrigin?: boolean;
  flags?: number;
  fmt?: 'none' | 'packed' | 'packed-bad' | 'packed-wrong-alg' | 'tpm';
}

interface GetTweaks {
  origin?: string;
  rpId?: string;
  challenge?: string;
  flags?: number;
  counter?: number;
  tamperSignature?: boolean;
  tamperAuthData?: boolean;
}

/**
 * A software authenticator: makes a key pair with WebCrypto and writes clientDataJSON, authenticator
 * data and attestation objects byte for byte as a real one would.
 */
class SoftAuthenticator {
  credentialId = crypto.getRandomValues(new Uint8Array(32));
  counter = 0;
  private keys!: CryptoKeyPair;
  constructor(readonly alg: Alg, readonly baseFlags = FLAG_UP | FLAG_UV) {}

  private get params() {
    return this.alg === 'ES256'
      ? { gen: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } }
      : {
          gen: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          sign: { name: 'RSASSA-PKCS1-v1_5' },
        };
  }

  private async sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const sig = new Uint8Array(await crypto.subtle.sign(this.params.sign, this.keys.privateKey, data));
    return this.alg === 'ES256' ? rawToDerEcdsa(sig) : sig; // authenticators sign ECDSA in DER
  }

  private async coseKey(): Promise<Uint8Array> {
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const map =
      this.alg === 'ES256'
        ? new Map<CborInput, CborInput>([[1, 2], [3, -7], [-1, 1], [-2, fromBase64Url(jwk.x!)], [-3, fromBase64Url(jwk.y!)]])
        : new Map<CborInput, CborInput>([[1, 3], [3, -257], [-1, fromBase64Url(jwk.n!)], [-2, fromBase64Url(jwk.e!)]]);
    return encodeCbor(map);
  }

  private header(rpIdHash: Uint8Array, flags: number, counter: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(37);
    out.set(rpIdHash);
    out[32] = flags;
    new DataView(out.buffer).setUint32(33, counter);
    return out;
  }

  async create(options: CreationOptionsJSON, t: CreateTweaks = {}) {
    this.keys = (await crypto.subtle.generateKey(this.params.gen, true, ['sign', 'verify'])) as CryptoKeyPair;
    const clientDataJSON = utf8(
      JSON.stringify({ type: t.type ?? 'webauthn.create', challenge: t.challenge ?? options.challenge, origin: t.origin ?? ORIGIN, crossOrigin: t.crossOrigin ?? false }),
    );
    const idLen = new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const authData = concat(
      this.header(await sha256(t.rpId ?? options.rp.id), t.flags ?? this.baseFlags | FLAG_AT, this.counter),
      new Uint8Array(16), // AAGUID: zeros, as with attestation 'none'
      idLen,
      this.credentialId,
      await this.coseKey(),
    );
    const fmt = t.fmt ?? 'none';
    let attStmt: Map<CborInput, CborInput> = new Map();
    if (fmt.startsWith('packed')) {
      const sig = await this.sign(concat(authData, await sha256(clientDataJSON)));
      if (fmt === 'packed-bad') sig[sig.length - 1] ^= 1;
      const alg = fmt === 'packed-wrong-alg' ? (this.alg === 'ES256' ? -257 : -7) : this.alg === 'ES256' ? -7 : -257;
      attStmt = new Map<CborInput, CborInput>([['alg', alg], ['sig', sig]]);
    } else if (fmt === 'tpm') {
      attStmt = new Map<CborInput, CborInput>([['ver', '2.0'], ['alg', -257], ['sig', new Uint8Array([1, 2, 3])]]);
    }
    const attestationObject = encodeCbor(
      new Map<CborInput, CborInput>([['fmt', fmt.startsWith('packed') ? 'packed' : fmt], ['attStmt', attStmt], ['authData', authData]]),
    );
    const id = toBase64Url(this.credentialId);
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: { clientDataJSON: toBase64Url(clientDataJSON), attestationObject: toBase64Url(attestationObject), transports: ['internal', 'hybrid'] },
    };
  }

  async get(options: RequestOptionsJSON, t: GetTweaks = {}) {
    this.counter = t.counter ?? this.counter + 1;
    const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.get', challenge: t.challenge ?? options.challenge, origin: t.origin ?? ORIGIN, crossOrigin: false }));
    const authData = this.header(await sha256(t.rpId ?? options.rpId), t.flags ?? this.baseFlags, this.counter);
    const signature = await this.sign(concat(authData, await sha256(clientDataJSON)));
    if (t.tamperSignature) signature[10] ^= 0x40;
    if (t.tamperAuthData) authData[36] ^= 1;
    const id = toBase64Url(this.credentialId);
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(signature),
        userHandle: toBase64Url('user-123'),
      },
    };
  }
}

const regOptions = () =>
  registrationOptions({ rpId: RP_ID, rpName: 'Hexplorers', user: { id: 'user-123', name: 'marlow', displayName: 'Marlow' } });

async function registered(alg: Alg, fmt: CreateTweaks['fmt'] = 'none', baseFlags?: number) {
  const auth = new SoftAuthenticator(alg, baseFlags);
  const { options, challenge } = regOptions();
  const response = await auth.create(options, { fmt });
  const result = await verifyRegistration({ response, expectedChallenge: challenge, expectedOrigins: ORIGINS, expectedRpId: RP_ID });
  if (!result.ok) throw new Error(`registration failed: ${result.error}`);
  return { auth, credential: result.credential };
}

describe('CBOR (RFC 8949 Appendix A examples)', () => {
  const vectors: [string, unknown][] = [
    ['00', 0],
    ['17', 23],
    ['1818', 24],
    ['1864', 100],
    ['1903e8', 1000],
    ['1a000f4240', 1000000],
    ['1b000000e8d4a51000', 1000000000000],
    ['1bffffffffffffffff', 18446744073709551615n],
    ['20', -1],
    ['29', -10],
    ['3863', -100],
    ['3903e7', -1000],
    ['f90000', 0],
    ['f93c00', 1],
    ['f93e00', 1.5],
    ['f97bff', 65504],
    ['fa47c35000', 100000],
    ['fb3ff199999999999a', 1.1],
    ['f9c400', -4],
    ['f4', false],
    ['f5', true],
    ['f6', null],
    ['f7', undefined],
    ['40', new Uint8Array(0)],
    ['4401020304', new Uint8Array([1, 2, 3, 4])],
    ['60', ''],
    ['6161', 'a'],
    ['6449455446', 'IETF'],
    ['62c3bc', 'ü'],
    ['80', []],
    ['83010203', [1, 2, 3]],
    ['8301820203820405', [1, [2, 3], [4, 5]]],
    ['a0', new Map()],
    ['a201020304', new Map([[1, 2], [3, 4]])],
    ['a26161016162820203', new Map<unknown, unknown>([['a', 1], ['b', [2, 3]]])],
    ['c11a514b67b0', { tag: 1, value: 1363896240 }],
  ];
  it('decodes every example', () => {
    for (const [hex, value] of vectors) expect(decodeCbor(fromHex(hex)), hex).toEqual(value);
  });
  it('encodes integers, strings, arrays and maps canonically', () => {
    for (const [hex, value] of vectors) {
      if (typeof value === 'number' && !Number.isInteger(value)) continue;
      if (hex.startsWith('f9') || hex.startsWith('fa') || hex.startsWith('fb') || hex.startsWith('c1')) continue;
      expect(toHex(encodeCbor(value as CborInput)), hex).toBe(hex);
    }
  });
  it('refuses indefinite lengths, truncation, trailing bytes, duplicate keys and deep nesting', () => {
    expect(() => decodeCbor(fromHex('5f42010243030405ff'))).toThrow(/indefinite/);
    expect(() => decodeCbor(fromHex('9f018202039f0405ffff'))).toThrow(/indefinite/);
    expect(() => decodeCbor(fromHex('44010203'))).toThrow(/truncated/);
    expect(() => decodeCbor(fromHex('0000'))).toThrow(/trailing/);
    expect(() => decodeCbor(fromHex('a201020103'))).toThrow(/duplicate/);
    expect(() => decodeCbor(fromHex('81'.repeat(40) + '00'))).toThrow(/deeply/);
    expect(() => decodeCbor(fromHex('9b00000000ffffffff'))).toThrow();
    expect(() => decodeCbor(fromHex('62c328'))).toThrow(/UTF-8/);
  });
});

describe('options', () => {
  it('registration options ask for ES256 and RS256, a preferred resident key and preferred UV', () => {
    const { options, challenge } = regOptions();
    expect(options.challenge).toBe(challenge);
    expect(fromBase64Url(challenge).length).toBe(32);
    expect(options.rp).toEqual({ id: RP_ID, name: 'Hexplorers' });
    expect(options.user).toEqual({ id: toBase64Url('user-123'), name: 'marlow', displayName: 'Marlow' });
    expect(options.pubKeyCredParams).toEqual([
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ]);
    expect(options.authenticatorSelection).toEqual({ residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' });
    expect(options.attestation).toBe('none');
    expect(regOptions().challenge).not.toBe(challenge);
    expect(() => registrationOptions({ rpId: RP_ID, rpName: 'x', user: { id: 'x'.repeat(65), name: 'a', displayName: 'a' } })).toThrow();
  });
  it('authentication options default to discoverable credentials', () => {
    const { options } = authenticationOptions({ rpId: RP_ID });
    expect(options).toMatchObject({ rpId: RP_ID, allowCredentials: [], userVerification: 'preferred' });
    const listed = authenticationOptions({ rpId: RP_ID, allowCredentials: [{ id: 'abc', transports: ['internal'] }] });
    expect(listed.options.allowCredentials).toEqual([{ type: 'public-key', id: 'abc', transports: ['internal'] }]);
  });
});

describe('registration', () => {
  for (const alg of ['ES256', 'RS256'] as const) {
    it(`accepts a ${alg} passkey with attestation none`, async () => {
      const { auth, credential } = await registered(alg);
      expect(credential.id).toBe(toBase64Url(auth.credentialId));
      expect(credential.alg).toBe(alg === 'ES256' ? -7 : -257);
      expect(credential.publicKey.kty).toBe(alg === 'ES256' ? 'EC' : 'RSA');
      expect(credential).toMatchObject({ signCount: 0, fmt: 'none', attestation: 'none', userVerified: true, transports: ['internal', 'hybrid'] });
    });
    it(`checks ${alg} packed self-attestation`, async () => {
      const { credential } = await registered(alg, 'packed');
      expect(credential).toMatchObject({ fmt: 'packed', attestation: 'self' });
      await expect(registered(alg, 'packed-bad')).rejects.toThrow(/attestation/);
      await expect(registered(alg, 'packed-wrong-alg')).rejects.toThrow(/attestation/);
    });
  }
  it('accepts other formats with their attestation ignored', async () => {
    const { credential } = await registered('ES256', 'tpm');
    expect(credential).toMatchObject({ fmt: 'tpm', attestation: 'none' });
  });
  it('reports backup eligibility and state (synced passkeys)', async () => {
    const { credential } = await registered('ES256', 'none', FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS);
    expect(credential).toMatchObject({ backupEligible: true, backedUp: true });
  });
  it('refuses the wrong origin, challenge, type, RP id, cross-origin use and missing flags', async () => {
    const cases: [CreateTweaks, string, { requireUserVerification?: boolean }?][] = [
      [{ origin: 'https://evil.example' }, 'origin'],
      [{ origin: 'http://localhost:5174' }, 'origin'],
      [{ challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) }, 'challenge'],
      [{ type: 'webauthn.get' }, 'type'],
      [{ rpId: 'evil.example' }, 'rp-id'],
      [{ crossOrigin: true }, 'cross-origin'],
      [{ flags: FLAG_UV | FLAG_AT }, 'user-presence'],
      [{ flags: FLAG_UP | FLAG_AT }, 'user-verification', { requireUserVerification: true }],
      [{ flags: FLAG_UP | FLAG_UV }, 'malformed'], // attested data present but AT unset: trailing bytes
    ];
    for (const [tweaks, error, extra] of cases) {
      const auth = new SoftAuthenticator('ES256');
      const { options, challenge } = regOptions();
      const response = await auth.create(options, tweaks);
      const r = await verifyRegistration({ response, expectedChallenge: challenge, expectedOrigins: ORIGINS, expectedRpId: RP_ID, ...extra });
      expect(r, JSON.stringify(tweaks)).toEqual({ ok: false, error });
    }
  });
  it('refuses a mismatched credential id, an unsupported key and garbage', async () => {
    const auth = new SoftAuthenticator('ES256');
    const { options, challenge } = regOptions();
    const response = await auth.create(options);
    const base = { expectedChallenge: challenge, expectedOrigins: ORIGINS, expectedRpId: RP_ID };
    expect(await verifyRegistration({ ...base, response: { ...response, id: 'AAAA', rawId: 'AAAA' } })).toEqual({ ok: false, error: 'credential' });
    expect(await verifyRegistration({ ...base, response: { ...response, response: { ...response.response, attestationObject: '!!' } } })).toEqual({
      ok: false,
      error: 'malformed',
    });
    expect(await verifyRegistration({ ...base, response: { ...response, response: { ...response.response, attestationObject: toBase64Url(encodeCbor(7)) } } })).toEqual({
      ok: false,
      error: 'malformed',
    });
    expect(await verifyRegistration({ ...base, response: null as never })).toEqual({ ok: false, error: 'malformed' });
    // An Ed25519 COSE key (kty 1, alg -8) is outside what we accept.
    const cose = new Map<CborInput, CborInput>([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(32)]]);
    expect(() => coseToJwk(decodeCbor(encodeCbor(cose)) as Map<never, never>)).toThrow(/unsupported/);
  });
});

describe('authentication', () => {
  for (const alg of ['ES256', 'RS256'] as const) {
    it(`verifies a ${alg} assertion and the rising sign count`, async () => {
      const { auth, credential } = await registered(alg);
      let stored: StoredCredential = credential;
      for (let i = 1; i <= 3; i++) {
        const { options, challenge } = authenticationOptions({ rpId: RP_ID });
        const response = await auth.get(options);
        const r = await verifyAuthentication({ response, expectedChallenge: challenge, expectedOrigins: ORIGINS, expectedRpId: RP_ID, credential: stored });
        expect(r).toEqual({ ok: true, signCount: i, userVerified: true, backedUp: false, userHandle: toBase64Url('user-123') });
        if (r.ok) stored = { ...stored, signCount: r.signCount };
      }
    });
  }
  it('allows a counter that stays at zero (synced passkeys) but refuses one that goes backwards', async () => {
    const { auth, credential } = await registered('ES256');
    const attempt = async (stored: StoredCredential, counter: number) => {
      const { options, challenge } = authenticationOptions({ rpId: RP_ID });
      const response = await auth.get(options, { counter });
      return verifyAuthentication({ response, expectedChallenge: challenge, expectedOrigins: ORIGINS, expectedRpId: RP_ID, credential: stored });
    };
    expect((await attempt(credential, 0)).ok).toBe(true);
    expect(await attempt({ ...credential, signCount: 5 }, 5)).toEqual({ ok: false, error: 'sign-count' });
    expect(await attempt({ ...credential, signCount: 5 }, 3)).toEqual({ ok: false, error: 'sign-count' });
    expect(await attempt({ ...credential, signCount: 5 }, 0)).toEqual({ ok: false, error: 'sign-count' });
    expect((await attempt({ ...credential, signCount: 5 }, 6)).ok).toBe(true);
  });
  it('refuses the wrong origin, challenge, RP id, a tampered signature or authenticator data, and missing flags', async () => {
    const { auth, credential } = await registered('ES256');
    const cases: [GetTweaks, string, { requireUserVerification?: boolean }?][] = [
      [{ origin: 'https://hexplorers.xyz.evil.example' }, 'origin'],
      [{ challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) }, 'challenge'],
      [{ rpId: 'evil.example' }, 'rp-id'],
      [{ tamperSignature: true }, 'signature'],
      [{ tamperAuthData: true }, 'signature'],
      [{ flags: FLAG_UV }, 'user-presence'],
      [{ flags: FLAG_UP }, 'user-verification', { requireUserVerification: true }],
    ];
    for (const [tweaks, error, extra] of cases) {
      const { options, challenge } = authenticationOptions({ rpId: RP_ID });
      const response = await auth.get(options, tweaks);
      const r = await verifyAuthentication({ response, expectedChallenge: challenge, expectedOrigins: ORIGINS, expectedRpId: RP_ID, credential, ...extra });
      expect(r, JSON.stringify(tweaks)).toEqual({ ok: false, error });
    }
  });
  it("refuses another credential's assertion and another credential's key", async () => {
    const a = await registered('ES256');
    const b = await registered('ES256');
    const { options, challenge } = authenticationOptions({ rpId: RP_ID });
    const response = await a.auth.get(options);
    const base = { response, expectedChallenge: challenge, expectedOrigins: ORIGINS, expectedRpId: RP_ID };
    expect(await verifyAuthentication({ ...base, credential: b.credential })).toEqual({ ok: false, error: 'credential' });
    expect(await verifyAuthentication({ ...base, credential: { ...b.credential, id: a.credential.id } })).toEqual({ ok: false, error: 'signature' });
  });
});

describe('authenticator data', () => {
  it('parses flags, counter and attested credential data', async () => {
    const { auth } = await registered('ES256');
    const { options } = regOptions();
    const response = await auth.create(options);
    const att = decodeCbor(fromBase64Url(response.response.attestationObject)) as Map<string, unknown>;
    const parsed = parseAuthenticatorData(att.get('authData') as Uint8Array);
    expect(toHex(parsed.rpIdHash)).toBe(toHex(await sha256(RP_ID)));
    expect(parsed.flags).toMatchObject({ up: true, uv: true, be: false, bs: false, at: true, ed: false });
    expect(parsed.attested!.credentialId).toEqual(auth.credentialId);
    expect(coseToJwk(parsed.attested!.publicKey).alg).toBe(-7);
  });
  it('refuses short data and BS without BE', () => {
    expect(() => parseAuthenticatorData(new Uint8Array(36))).toThrow();
    const bad = new Uint8Array(37);
    bad[32] = FLAG_UP | FLAG_BS;
    expect(() => parseAuthenticatorData(bad)).toThrow(/backup/);
  });
});
