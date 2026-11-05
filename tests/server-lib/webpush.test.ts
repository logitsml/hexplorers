import { describe, expect, it, vi } from 'vitest';
import { decodeJwt, fromBase64Url, fromUtf8, toBase64Url, verifyJwtSignature } from '../../server/lib/crypto';
import {
  PUSH_MAX_PLAINTEXT,
  buildPushRequest,
  decryptAes128gcm,
  decryptPushPayload,
  encryptAes128gcm,
  encryptPushPayload,
  generateVapidKeys,
  importVapidKeys,
  interpretPushResponse,
  isConfigured,
  sendPush,
  validateSubscription,
  vapidAuthorization,
  vapidSubject,
  type PushSubscriptionData,
} from '../../server/lib/webpush';

vi.setConfig({ testTimeout: 60_000 });

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** An ECDH private key from a raw public point and the scalar d (both base64url). */
function ecdhPrivate(publicKey: string, d: string): Promise<CryptoKey> {
  const point = fromBase64Url(publicKey);
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d, x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33)) },
    P256,
    false,
    ['deriveBits'],
  );
}

/** A browser's side of a subscription: an ECDH key pair and an auth secret. */
async function userAgent(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const pair = (await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription: PushSubscriptionData = {
    endpoint,
    keys: { p256dh: toBase64Url(publicKey), auth: toBase64Url(auth) },
  };
  return { subscription, recipient: { privateKey: pair.privateKey, publicKey, auth } };
}

// RFC 8291 §5 and Appendix A.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('aes128gcm (RFC 8188 §3 examples)', () => {
  it('decrypts §3.1 (one record, rs 4096) and re-encrypts it byte for byte', async () => {
    const body = fromBase64Url('I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg');
    const ikm = fromBase64Url('yqdlZ-tYemfogSmv7Ws5PQ');
    const { plaintext, header } = await decryptAes128gcm(body, ikm);
    expect(fromUtf8(plaintext)).toBe('I am the walrus');
    expect(header.recordSize).toBe(4096);
    expect(header.keyId.length).toBe(0);
    const again = await encryptAes128gcm('I am the walrus', ikm, { salt: header.salt, recordSize: 4096 });
    expect(toBase64Url(again)).toBe(toBase64Url(body));
  });
  it('decrypts §3.2 (several records, rs 25, key id "a1")', async () => {
    const body = fromBase64Url('uNCkWiNYzKTnBN9ji3-qWAAAABkCYTHOG8chz_gnvgOqdGYovxyjuqRyJFjEDyoF1Fvkj6hQPdPHI51OEUKEpgz3SsLWIqS_uA');
    const ikm = fromBase64Url('BO3ZVPxUlnLORbVGMpbT1Q');
    const { plaintext, header } = await decryptAes128gcm(body, (keyId) => {
      expect(fromUtf8(keyId)).toBe('a1');
      return ikm;
    });
    expect(fromUtf8(plaintext)).toBe('I am the walrus');
    expect(header.recordSize).toBe(25);
  });
  it('refuses a wrong key and a truncated body', async () => {
    const body = fromBase64Url('I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg');
    await expect(decryptAes128gcm(body, new Uint8Array(16))).rejects.toThrow();
    await expect(decryptAes128gcm(body.subarray(0, body.length - 1), fromBase64Url('yqdlZ-tYemfogSmv7Ws5PQ'))).rejects.toThrow();
    await expect(decryptAes128gcm(body.subarray(0, 10), fromBase64Url('yqdlZ-tYemfogSmv7Ws5PQ'))).rejects.toThrow();
  });
});

describe('Web Push encryption (RFC 8291 §5 example)', () => {
  it('decrypts the RFC message with the user agent keys', async () => {
    const privateKey = await ecdhPrivate(RFC8291.uaPublic, RFC8291.uaPrivate);
    const plaintext = await decryptPushPayload(fromBase64Url(RFC8291.message), {
      privateKey,
      publicKey: fromBase64Url(RFC8291.uaPublic),
      auth: fromBase64Url(RFC8291.auth),
    });
    expect(fromUtf8(plaintext)).toBe(RFC8291.plaintext);
  });
  it('encrypts to exactly the RFC message given its fixed server key and salt', async () => {
    const body = await encryptPushPayload(
      RFC8291.plaintext,
      { p256dh: RFC8291.uaPublic, auth: RFC8291.auth },
      {
        salt: fromBase64Url(RFC8291.salt),
        serverKeys: { privateKey: await ecdhPrivate(RFC8291.asPublic, RFC8291.asPrivate), publicKey: fromBase64Url(RFC8291.asPublic) },
      },
    );
    expect(toBase64Url(body)).toBe(RFC8291.message);
  });
  it('round-trips with fresh keys, with and without padding', async () => {
    const { subscription, recipient } = await userAgent();
    for (const padding of [0, 1, 100]) {
      const body = await encryptPushPayload('{"title":"Your move"}', subscription.keys, { padding });
      expect(body.length).toBe(86 + 21 + 1 + padding + 16);
      expect(fromUtf8(await decryptPushPayload(body, recipient))).toBe('{"title":"Your move"}');
    }
    // A fresh salt and server key every time: the same payload never encrypts the same way twice.
    const a = await encryptPushPayload('same', subscription.keys);
    const b = await encryptPushPayload('same', subscription.keys);
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
  });
  it('fits 3993 bytes in one 4096-byte message and refuses more', async () => {
    const { subscription, recipient } = await userAgent();
    const max = 'x'.repeat(PUSH_MAX_PLAINTEXT);
    const body = await encryptPushPayload(max, subscription.keys);
    expect(body.length).toBe(4096);
    expect(fromUtf8(await decryptPushPayload(body, recipient))).toBe(max);
    await expect(encryptPushPayload(max + 'x', subscription.keys)).rejects.toThrow(/too large/);
    await expect(encryptPushPayload('x', { p256dh: subscription.keys.p256dh, auth: 'AAAA' })).rejects.toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('generates keys that import, sign and verify', async () => {
    const keys = await generateVapidKeys();
    expect(fromBase64Url(keys.publicKey).length).toBe(65);
    expect(fromBase64Url(keys.privateKey).length).toBe(32);
    const signer = await importVapidKeys(keys);
    const now = 1_700_000_000_000;
    const header = await vapidAuthorization('https://push.example.net/push/abc?x=1', signer, 'mailto:ops@example.com', { now });
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, t, k] = m!;
    expect(k).toBe(keys.publicKey);
    const jwt = decodeJwt(t!);
    expect(jwt.header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(jwt.payload.aud).toBe('https://push.example.net');
    expect(jwt.payload.sub).toBe('mailto:ops@example.com');
    expect(jwt.payload.exp).toBeGreaterThan(now / 1000);
    expect(jwt.payload.exp).toBeLessThanOrEqual(now / 1000 + 24 * 3600);
    const pub = await crypto.subtle.importKey('raw', fromBase64Url(k!), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await verifyJwtSignature(jwt, pub, 'ES256')).toBe(true);
  });
  it('caps exp at 24 hours and reuses a JWT per audience while it has over an hour left', async () => {
    const signer = await importVapidKeys(await generateVapidKeys());
    const now = 1_700_000_000_000;
    const long = await vapidAuthorization('https://a.example/x', signer, 'mailto:a@b.c', { now, expiresIn: 7 * 86400 });
    expect(decodeJwt(long.slice(8, long.indexOf(','))).payload.exp).toBe(now / 1000 + 86400);
    const first = await vapidAuthorization('https://a.example/x', signer, 'mailto:a@b.c', { now });
    expect(await vapidAuthorization('https://a.example/y', signer, 'mailto:a@b.c', { now: now + 60_000 })).toBe(first);
    expect(await vapidAuthorization('https://b.example/y', signer, 'mailto:a@b.c', { now })).not.toBe(first);
    expect(await vapidAuthorization('https://a.example/x', signer, 'mailto:a@b.c', { now: now + 11.5 * 3600_000 })).not.toBe(first);
    await expect(vapidAuthorization('https://a.example/x', signer, 'http://insecure.example')).rejects.toThrow(/subject/);
  });
  it('imports a private JWK and refuses mismatched or malformed keys without echoing them', async () => {
    const a = await generateVapidKeys();
    const b = await generateVapidKeys();
    const point = fromBase64Url(a.publicKey);
    const jwk = JSON.stringify({ kty: 'EC', crv: 'P-256', d: a.privateKey, x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33)) });
    expect((await importVapidKeys({ publicKey: a.publicKey, privateKey: jwk })).publicKey).toBe(a.publicKey);
    const err = await importVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(b.privateKey);
    await expect(importVapidKeys({ publicKey: 'AAAA', privateKey: a.privateKey })).rejects.toThrow(/65 bytes/);
    await expect(importVapidKeys({ publicKey: a.publicKey, privateKey: 'AAAA' })).rejects.toThrow(/32 bytes/);
  });
  it('is off until both keys are set, and picks a subject', () => {
    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ VAPID_PUBLIC_KEY: 'x' })).toBe(false);
    expect(isConfigured({ VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'y' })).toBe(true);
    expect(vapidSubject({ PUBLIC_URL: 'https://hexplorers.xyz/app' })).toBe('https://hexplorers.xyz');
    expect(vapidSubject({ PUBLIC_URL: 'http://localhost:5173', VAPID_SUBJECT: 'mailto:me@example.com' })).toBe('mailto:me@example.com');
    expect(vapidSubject({ PUBLIC_URL: 'http://localhost:5173' })).toMatch(/^mailto:/);
  });
});

describe('push requests and responses', () => {
  it('builds a request the browser can decrypt, with TTL, urgency and topic', async () => {
    const { subscription, recipient } = await userAgent();
    const signer = await importVapidKeys(await generateVapidKeys());
    const parts = await buildPushRequest(subscription, '{"title":"Your move on Marlow\'s island"}', { signer, subject: 'mailto:a@b.c' }, {
      ttl: 3600,
      urgency: 'high',
      topic: 'room-BCDFGH',
      padding: 32,
    });
    expect(parts.url).toBe(subscription.endpoint);
    expect(parts.method).toBe('POST');
    expect(parts.headers).toMatchObject({
      TTL: '3600',
      Urgency: 'high',
      Topic: 'room-BCDFGH',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(parts.body!.length),
    });
    expect(parts.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(fromUtf8(await decryptPushPayload(parts.body!, recipient))).toBe('{"title":"Your move on Marlow\'s island"}');
  });
  it('sends a payload-less tickle and validates its options', async () => {
    const { subscription } = await userAgent();
    const vapid = { signer: await importVapidKeys(await generateVapidKeys()), subject: 'mailto:a@b.c' };
    const parts = await buildPushRequest(subscription, null, vapid);
    expect(parts.body).toBeNull();
    expect(parts.headers['Content-Encoding']).toBeUndefined();
    expect(parts.headers.TTL).toBe('86400');
    await expect(buildPushRequest(subscription, 'x', vapid, { topic: 'has spaces' })).rejects.toThrow(/topic/);
    await expect(buildPushRequest(subscription, 'x', vapid, { topic: 'x'.repeat(33) })).rejects.toThrow(/topic/);
    await expect(buildPushRequest(subscription, 'x', vapid, { ttl: -1 })).rejects.toThrow(/TTL/);
    await expect(buildPushRequest(subscription, 'x', vapid, { urgency: 'urgent' as never })).rejects.toThrow(/urgency/);
  });
  it('sendPush posts through fetch and reports a dead subscription', async () => {
    const { subscription, recipient } = await userAgent();
    const vapid = { signer: await importVapidKeys(await generateVapidKeys()), subject: 'mailto:a@b.c' };
    let seen: Request | undefined;
    const ok = await sendPush(subscription, 'hello', vapid, {
      fetch: async (input) => {
        seen = input as Request;
        return new Response(null, { status: 201 });
      },
    });
    expect(ok).toEqual({ ok: true, status: 201 });
    expect(seen!.method).toBe('POST');
    expect(seen!.url).toBe(subscription.endpoint);
    expect(seen!.headers.get('content-encoding')).toBe('aes128gcm');
    const body = new Uint8Array(await seen!.arrayBuffer());
    expect(fromUtf8(await decryptPushPayload(body, recipient))).toBe('hello');

    const gone = await sendPush(subscription, 'hello', vapid, { fetch: async () => new Response('gone', { status: 410 }) });
    expect(gone).toMatchObject({ ok: false, gone: true, reason: 'gone' });
    const net = await sendPush(subscription, 'hello', vapid, {
      fetch: async () => {
        throw new TypeError('network down');
      },
    });
    expect(net).toMatchObject({ ok: false, gone: false, retry: true, reason: 'network' });
  });
  it('interprets push service answers', () => {
    expect(interpretPushResponse({ status: 201 })).toEqual({ ok: true, status: 201 });
    expect(interpretPushResponse({ status: 404 })).toMatchObject({ gone: true, retry: false });
    expect(interpretPushResponse({ status: 410 })).toMatchObject({ gone: true, reason: 'gone' });
    expect(interpretPushResponse({ status: 413 })).toMatchObject({ gone: false, reason: 'too-large' });
    expect(interpretPushResponse({ status: 429, headers: new Headers({ 'Retry-After': '120' }) })).toMatchObject({
      retry: true,
      retryAfter: 120,
      reason: 'rate-limited',
    });
    expect(interpretPushResponse({ status: 403 })).toMatchObject({ reason: 'unauthorized', retry: false });
    expect(interpretPushResponse({ status: 503 })).toMatchObject({ reason: 'server-error', retry: true });
  });
  it('validates client subscriptions (https on a known push service, real keys)', async () => {
    const { subscription } = await userAgent();
    expect(validateSubscription(subscription)).toMatchObject({ ok: true });
    for (const endpoint of [
      'https://web.push.apple.com/QGuQyavXutnMH...',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(validateSubscription({ ...subscription, endpoint }).ok).toBe(true);
    }
    expect(validateSubscription({ ...subscription, endpoint: 'http://fcm.googleapis.com/x' })).toEqual({ ok: false, error: 'endpoint' });
    expect(validateSubscription({ ...subscription, endpoint: 'https://169.254.169.254/latest' })).toEqual({ ok: false, error: 'host' });
    expect(validateSubscription({ ...subscription, endpoint: 'https://fcm.googleapis.com:8443/x' })).toEqual({ ok: false, error: 'endpoint' });
    expect(validateSubscription({ ...subscription, endpoint: 'https://my.host/x' }, { allowAnyHttps: true }).ok).toBe(true);
    expect(validateSubscription({ ...subscription, keys: { p256dh: 'AAAA', auth: subscription.keys.auth } })).toEqual({ ok: false, error: 'keys' });
    expect(validateSubscription({ endpoint: subscription.endpoint })).toEqual({ ok: false, error: 'shape' });
    expect(validateSubscription(null)).toEqual({ ok: false, error: 'shape' });
  });
});
