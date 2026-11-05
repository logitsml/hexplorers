import { describe, expect, it } from 'vitest';
import {
  concat,
  decodeJwt,
  derToRawEcdsa,
  fromBase64Url,
  fromHex,
  fromUtf8,
  hkdf,
  hmacSha256Hex,
  hmacVerify,
  importJwk,
  randomBytes,
  randomId,
  rawToDerEcdsa,
  sha256Hex,
  signJwt,
  signToken,
  timingSafeEqual,
  toBase64,
  toBase64Url,
  toHex,
  utf8,
  verifyJwtSignature,
  verifyToken,
} from '../../server/lib/crypto';

describe('base64 and hex (RFC 4648 §10 vectors)', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ];
  it('encodes and decodes the standard vectors', () => {
    for (const [plain, b64] of vectors) {
      expect(toBase64(plain)).toBe(b64);
      expect(toBase64Url(plain)).toBe(b64.replace(/=+$/, ''));
      expect(fromUtf8(fromBase64Url(b64))).toBe(plain);
      expect(fromUtf8(fromBase64Url(b64.replace(/=+$/, '')))).toBe(plain);
    }
  });
  it('uses the url-safe alphabet and round-trips every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const text = toBase64Url(all);
    expect(text).not.toMatch(/[+/=]/);
    expect(fromBase64Url(text)).toEqual(all);
    expect(fromBase64Url(toBase64(all))).toEqual(all);
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });
  it('rejects malformed input', () => {
    expect(() => fromBase64Url('a')).toThrow();
    expect(() => fromBase64Url('ab$c')).toThrow();
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });
  it('hex round-trips', () => {
    expect(toHex(new Uint8Array([0, 1, 0xab, 0xff]))).toBe('0001abff');
    expect(fromHex('0001ABff')).toEqual(new Uint8Array([0, 1, 0xab, 0xff]));
  });
  it('round-trips a large buffer (chunked btoa)', () => {
    const big = randomBytes(100_000);
    expect(timingSafeEqual(fromBase64Url(toBase64Url(big)), big)).toBe(true);
  });
});

describe('hashes (FIPS 180-2, RFC 4231, RFC 5869 vectors)', () => {
  it('SHA-256', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('HMAC-SHA-256 (RFC 4231 test cases 1 and 2)', async () => {
    expect(await hmacSha256Hex(new Uint8Array(20).fill(0x0b), 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
  it('hmacVerify accepts the right MAC and nothing else', async () => {
    const mac = fromHex('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    expect(await hmacVerify('Jefe', 'what do ya want for nothing?', mac)).toBe(true);
    const bad = mac.slice();
    bad[31] ^= 1;
    expect(await hmacVerify('Jefe', 'what do ya want for nothing?', bad)).toBe(false);
    expect(await hmacVerify('Jefe', 'what do ya want for nothing?', mac.subarray(0, 16))).toBe(false);
  });
  it('HKDF-SHA-256 (RFC 5869 test case 1)', async () => {
    const okm = await hkdf(
      new Uint8Array(22).fill(0x0b),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });
});

describe('timingSafeEqual and random ids', () => {
  it('compares by content and length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'a')).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });
  it('random ids are 128-bit base64url and distinct', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomBytes(70_000).length).toBe(70_000); // more than one getRandomValues call
  });
});

describe('signed tokens', () => {
  const secret = 'a'.repeat(64);
  it('round-trips a payload until it expires', async () => {
    const now = 1_700_000_000_000;
    const t = await signToken({ user: 'u1', n: 3 }, secret, 60_000, { now, purpose: 'test' });
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const ok = await verifyToken<{ user: string }>(t, secret, { now: now + 59_999, purpose: 'test' });
    expect(ok).toEqual({ ok: true, payload: { user: 'u1', n: 3 }, exp: now + 60_000 });
    expect(await verifyToken(t, secret, { now: now + 60_000, purpose: 'test' })).toEqual({ ok: false, reason: 'expired' });
  });
  it('refuses another secret, another purpose and any tampering', async () => {
    const t = await signToken({ user: 'u1' }, secret, 60_000, { purpose: 'magic' });
    expect((await verifyToken(t, 'b'.repeat(64), { purpose: 'magic' })).ok).toBe(false);
    expect(await verifyToken(t, secret, { purpose: 'checkout' })).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyToken(t, secret)).toEqual({ ok: false, reason: 'signature' });
    const [v, body, mac] = t.split('.') as [string, string, string];
    const forged = toBase64Url(JSON.stringify({ p: { user: 'admin' }, x: Date.now() + 1e9 }));
    expect(await verifyToken(`${v}.${forged}.${mac}`, secret, { purpose: 'magic' })).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyToken(`${v}.${body}.${mac.slice(0, -2)}AA`, secret, { purpose: 'magic' })).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyToken(`v2.${body}.${mac}`, secret, { purpose: 'magic' })).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyToken('garbage', secret)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyToken('v1.a.' + 'x'.repeat(9000), secret)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('JWT and ECDSA encodings', () => {
  it('RFC 8292 §2.4 example VAPID JWT verifies with its public key', async () => {
    const t =
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA';
    const k = fromBase64Url('BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs');
    const key = await crypto.subtle.importKey('raw', k, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const jwt = decodeJwt(t);
    expect(jwt.payload).toEqual({ aud: 'https://push.example.net', exp: 1453523768, sub: 'mailto:push@example.com' });
    expect(await verifyJwtSignature(jwt, key, 'ES256')).toBe(true);
    // The caller fixes the algorithm: the same token is refused as RS256.
    expect(await verifyJwtSignature(jwt, key, 'RS256')).toBe(false);
  });
  it('signs and verifies ES256 and RS256, and refuses tampering', async () => {
    const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const rsa = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    for (const [alg, pair] of [['ES256', ec], ['RS256', rsa]] as const) {
      const t = await signJwt({ alg, kid: 'k1' }, { sub: 'x', n: 1 }, pair.privateKey);
      expect(decodeJwt(t).header).toEqual({ typ: 'JWT', alg, kid: 'k1' });
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      expect(await verifyJwtSignature(t, jwk, alg)).toBe(true);
      expect(await verifyJwtSignature(t, await importJwk(jwk, alg, 'verify'), alg)).toBe(true);
      const [h, , s] = t.split('.');
      const tampered = `${h}.${toBase64Url(JSON.stringify({ sub: 'y', n: 1 }))}.${s}`;
      expect(await verifyJwtSignature(tampered, jwk, alg)).toBe(false);
    }
    expect(() => decodeJwt('a.b')).toThrow();
    expect(() => decodeJwt('###.###.###')).toThrow();
  });
  it('converts ECDSA signatures between DER and raw', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    for (let i = 0; i < 20; i++) {
      const msg = utf8(`message ${i}`);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, msg));
      const der = rawToDerEcdsa(raw);
      expect(der[0]).toBe(0x30);
      expect(derToRawEcdsa(der)).toEqual(raw);
    }
    // High bits get a zero pad; leading zeros are stripped.
    const raw = concat(new Uint8Array(32).fill(0xff), concat(new Uint8Array([0, 0]), new Uint8Array(30).fill(1)));
    const der = rawToDerEcdsa(raw);
    expect(toHex(der.subarray(0, 5))).toBe('3043022100'); // r is 33 bytes, s 30 once its zeros go
    expect(der.length).toBe(2 + 2 + 33 + 2 + 30);
    expect(derToRawEcdsa(der)).toEqual(raw);
    expect(() => derToRawEcdsa(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toThrow();
    expect(() => derToRawEcdsa(concat(der, new Uint8Array([0])))).toThrow();
  });
});
