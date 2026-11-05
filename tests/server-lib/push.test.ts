// Web Push as the server sends it: a device signs up through the API; a note reaches the push
// service as the RFC 8291 request it expects (aes128gcm, a VAPID JWT for its origin, a TTL, a
// Topic), which the browser's keys decrypt to the note; a device the service says is gone is
// forgotten; each person's kinds and quiet hours are kept (the note waits for their morning, and
// several come as one); and /api/config says push is on only with VAPID keys.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, fromBase64Url, verifyJwtSignature } from '../../server/lib/crypto';
import { DEFAULT_QUIET, defaultPrefs, localMinutes, quietUntil } from '../../server/features/push';
import { createServices, migrate } from '../../server/services';
import { NodeServiceDb } from '../../server/node/sql';
import { handleApi } from '../../server/http/router';
import { ENV } from '../server/harness';
import { PushWorld, api, fakeNetwork, userAgent, vapidKeys, vapidOf } from './pushHelpers';

vi.setConfig({ testTimeout: 120_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A world with one guest whose device has signed up. */
async function signedUp(o: { tz?: string; extra?: ConstructorParameters<typeof PushWorld>[1] } = {}) {
  const w = await new PushWorld(3, o.extra).init();
  const g = await w.guest('Wren');
  const ua = await userAgent();
  const r = await api(w, 'POST', '/api/push/subscribe', g.token, { subscription: ua.subscription, tz: o.tz ?? 'UTC' });
  expect(r.status).toBe(200);
  return { w, g, ua };
}

describe('Web Push: the request a push service gets', () => {
  it('encrypts each note for the device, signs it for the service, and the device reads it back', async () => {
    const { w, g, ua } = await signedUp();
    // (Noon in UTC: no quiet hours.)
    w.now = Date.UTC(2027, 0, 19, 12, 0);
    const sent = fakeNetwork();
    await w.services.notify([g.user], { title: 'Your move on Marlow’s island', body: 'Bramble built a city.', url: '/r/BCDFGH', tag: 'room-BCDFGH', kind: 'move', expires: w.now + 6 * 3_600_000 });
    expect(sent).toHaveLength(1);
    const r = sent[0];
    expect(r.method).toBe('POST');
    expect(r.url).toBe(ua.subscription.endpoint);
    expect(r.headers['content-encoding']).toBe('aes128gcm');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    // TTL until the deadline; the game's tag as the Topic (an undelivered note is replaced).
    expect(r.headers.ttl).toBe(String(6 * 3600));
    expect(r.headers.topic).toBe('room-BCDFGH');
    expect(r.headers.urgency).toBe('normal');
    const vapid = vapidOf(r.headers.authorization)!;
    expect(vapid.k).toBe((await vapidKeys()).publicKey);
    expect(vapid.claims.aud).toBe('https://fcm.googleapis.com');
    expect(vapid.claims.sub).toBe('mailto:ops@example.com');
    expect(vapid.claims.exp).toBeGreaterThan(w.now / 1000);
    expect(vapid.claims.exp).toBeLessThanOrEqual(w.now / 1000 + 24 * 3600);
    const pub = await crypto.subtle.importKey('raw', fromBase64Url(vapid.k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await verifyJwtSignature(decodeJwt(vapid.jwt), pub, 'ES256')).toBe(true);
    // The body is the aes128gcm record the browser decrypts with its own keys.
    expect(await ua.read(r.body)).toEqual({ title: 'Your move on Marlow’s island', body: 'Bramble built a city.', url: '/r/BCDFGH', tag: 'room-BCDFGH' });
    // No endpoint or key ever reaches a row other than the device's own.
    const row = await w.db.first<{ id: string; last_ok: number }>('SELECT id, last_ok FROM push_subscriptions WHERE user = ?', g.user);
    expect(row!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.last_ok).toBe(w.now);
  });

  it('collapses a burst for one game into one note, and sends a test on demand', async () => {
    const { w, g, ua } = await signedUp();
    w.now = Date.UTC(2027, 0, 19, 12, 0);
    const sent = fakeNetwork();
    const note = { title: 'Your move on Wren’s island', body: 'Ash offers 1 ore for 2 wool.', url: '/r/BCDFGH', tag: 'room-BCDFGH', kind: 'move' as const };
    await w.services.notify([g.user], note);
    w.now += 20_000;
    await w.services.notify([g.user], { ...note, body: 'Ash offers 1 ore for 1 wool.' });
    expect(sent).toHaveLength(1);
    w.now += 60_000;
    await w.services.notify([g.user], note);
    expect(sent).toHaveLength(2);
    const t = await api(w, 'POST', '/api/push/test', g.token);
    expect(t).toMatchObject({ status: 200, body: { sent: 1, gone: 0, failed: 0 } });
    expect((await ua.read(sent[2].body)).tag).toBe('test');
  });

  it('forgets a device the push service says is gone, and keeps one that only failed', async () => {
    const { w, g } = await signedUp();
    const other = await userAgent('https://updates.push.services.mozilla.com/wpush/v2/abc');
    expect((await api(w, 'POST', '/api/push/subscribe', g.token, { subscription: other.subscription })).status).toBe(200);
    w.now = Date.UTC(2027, 0, 19, 12, 0);
    let status = 410;
    const sent = fakeNetwork((r) => (r.url.includes('mozilla') ? 500 : status));
    await w.services.notify([g.user], { title: 'Your move', body: 'x', url: '/r/BCDFGH', tag: 'a', kind: 'move' });
    expect(sent).toHaveLength(2);
    let rows = await w.db.all<{ endpoint: string; fails: number }>('SELECT endpoint, fails FROM push_subscriptions WHERE user = ?', g.user);
    expect(rows).toEqual([{ endpoint: other.subscription.endpoint, fails: 1 }]);
    // 404 is gone too.
    status = 404;
    const third = await userAgent();
    await api(w, 'POST', '/api/push/subscribe', g.token, { subscription: third.subscription });
    await w.services.notify([g.user], { title: 'Your move', body: 'x', url: '/r/BCDFGH', tag: 'b', kind: 'move' });
    rows = await w.db.all('SELECT endpoint, fails FROM push_subscriptions WHERE user = ?', g.user);
    expect(rows.map((r) => r.endpoint)).toEqual([other.subscription.endpoint]);
    // Unsubscribing takes the last one away.
    expect((await api(w, 'POST', '/api/push/unsubscribe', g.token, { endpoint: other.subscription.endpoint })).body).toMatchObject({ removed: 1 });
    expect(await w.db.all('SELECT id FROM push_subscriptions')).toEqual([]);
  });

  it('refuses a subscription on a host that is no push service, and anyone without a token', async () => {
    const w = await new PushWorld(4).init();
    const g = await w.guest('Ash');
    const bad = await userAgent('https://example.com/steal');
    expect((await api(w, 'POST', '/api/push/subscribe', g.token, { subscription: bad.subscription })).status).toBe(400);
    expect((await api(w, 'POST', '/api/push/subscribe', undefined, { subscription: (await userAgent()).subscription })).status).toBe(401);
    expect((await api(w, 'POST', '/api/push/test', g.token)).status).toBe(409);
  });
});

describe('preferences and quiet hours', () => {
  it('reads the hour in the person’s own time zone', () => {
    const at = Date.UTC(2027, 0, 12, 23, 30);
    expect(localMinutes(at, 'UTC')).toBe(23 * 60 + 30);
    expect(localMinutes(at, 'Asia/Tokyo')).toBe(8 * 60 + 30);
    expect(localMinutes(at, 'America/New_York')).toBe(18 * 60 + 30);
    const p = defaultPrefs('Europe/London');
    expect(p.quiet).toEqual(DEFAULT_QUIET);
    // 23:30 in London (winter): quiet until 08:00.
    expect(quietUntil(p, at)).toBe(Date.UTC(2027, 0, 13, 8, 0));
    // 08:30 in Tokyo: not quiet; 21:59 is not, 22:00 is.
    expect(quietUntil({ ...p, tz: 'Asia/Tokyo' }, at)).toBeNull();
    expect(quietUntil(p, Date.UTC(2027, 0, 12, 21, 59))).toBeNull();
    expect(quietUntil(p, Date.UTC(2027, 0, 12, 22, 0))).toBe(Date.UTC(2027, 0, 13, 8, 0));
    // A window within the day, and none without a time zone.
    expect(quietUntil({ ...p, quiet: { from: 13 * 60, to: 14 * 60 } }, Date.UTC(2027, 0, 12, 13, 15))).toBe(Date.UTC(2027, 0, 12, 14, 0));
    expect(quietUntil({ ...p, tz: null }, at)).toBeNull();
  });

  it('keeps what each person turned off, and holds notes through their quiet hours', async () => {
    const { w, g, ua } = await signedUp({ tz: 'Europe/Berlin' });
    const prefs = await api(w, 'GET', '/api/push/prefs', g.token);
    expect(prefs.body).toMatchObject({ kinds: { move: true, invite: true, over: true, friend: true }, quiet: DEFAULT_QUIET, tz: 'Europe/Berlin', devices: 1 });
    const off = await api(w, 'PUT', '/api/push/prefs', g.token, { kinds: { over: false } });
    expect(off.body.kinds).toMatchObject({ move: true, over: false });
    expect((await api(w, 'PUT', '/api/push/prefs', g.token, { tz: 'Nowhere/Atlantis' })).status).toBe(400);
    expect((await api(w, 'PUT', '/api/push/prefs', g.token, { quiet: { from: 1500, to: 0 } })).status).toBe(400);
    const sent = fakeNetwork();
    // 12:00 in Berlin: a game's end is off, a move goes.
    w.now = Date.UTC(2027, 0, 19, 11, 0);
    await w.services.notify([g.user], { title: 'The voyage on Ash’s island is over', body: 'x', url: '/r/BCDFGH', tag: 'room-BCDFGH', kind: 'over' });
    expect(sent).toHaveLength(0);
    // 23:00 in Berlin: two games' moves wait for the morning (and a third's deadline passes before it).
    w.now = Date.UTC(2027, 0, 19, 22, 0);
    await w.services.notify([g.user], { title: 'Your move on Ash’s island', body: 'a', url: '/r/BCDFGH', tag: 'room-BCDFGH', kind: 'move', expires: w.now + 24 * 3_600_000 });
    await w.services.notify([g.user], { title: 'Your move on Rook’s island', body: 'b', url: '/r/CDFGHJ', tag: 'room-CDFGHJ', kind: 'move' });
    await w.services.notify([g.user], { title: 'Your move on Fen’s island', body: 'c', url: '/r/DFGHJK', tag: 'room-DFGHJK', kind: 'move', expires: w.now + 3_600_000 });
    expect(sent).toHaveLength(0);
    expect(await w.db.all('SELECT tag, due_at FROM push_queue ORDER BY tag')).toEqual([
      { tag: 'room-BCDFGH', due_at: Date.UTC(2027, 0, 20, 7, 0) },
      { tag: 'room-CDFGHJ', due_at: Date.UTC(2027, 0, 20, 7, 0) },
    ]);
    await w.services.tick!();
    expect(sent).toHaveLength(0);
    // 08:00 in Berlin: one note for both.
    w.now = Date.UTC(2027, 0, 20, 7, 0, 30);
    await w.services.tick!();
    expect(sent).toHaveLength(1);
    expect(await ua.read(sent[0].body)).toMatchObject({ title: 'Your move in 2 games', url: '/?go=/multi', tag: 'harbour' });
    expect(await w.db.all('SELECT tag FROM push_queue')).toEqual([]);
    // Quiet hours off: a note goes at once, at any hour.
    await api(w, 'PUT', '/api/push/prefs', g.token, { quiet: null });
    w.now = Date.UTC(2027, 0, 20, 23, 0);
    await w.services.notify([g.user], { title: 'Your move', body: 'd', url: '/r/BCDFGH', tag: 'room-BCDFGH', kind: 'move' });
    expect(sent).toHaveLength(2);
  });

  it('writes nothing and sends nothing without push keyed', async () => {
    const db = new NodeServiceDb(':memory:');
    await migrate(db);
    const services = createServices({ db, blobs: { get: async () => null, put: async () => {}, delete: async () => {} }, env: ENV, rooms: { fetch: async () => new Response(null, { status: 404 }) } });
    const sent = fakeNetwork();
    const g = await services.guest('Moss');
    await services.notify([g.user], { title: 'Your move', body: 'x', url: '/r/BCDFGH', kind: 'move' });
    expect(sent).toEqual([]);
    expect(await db.all('SELECT * FROM push_sent')).toEqual([]);
    const ctx = { env: ENV, db, blobs: { get: async () => null, put: async () => {}, delete: async () => {} }, services, rooms: { fetch: async () => new Response(null) }, now: () => Date.now(), random: (n: number) => crypto.getRandomValues(new Uint8Array(n)) };
    const config = (await (await handleApi(new Request('http://localhost/api/config'), ctx))!.json()) as { features: { push: boolean }; vapidPublicKey?: string };
    expect(config.features.push).toBe(false);
    expect(config.vapidPublicKey).toBeUndefined();
    const w = await new PushWorld(5).init();
    const on = await api(w, 'GET', '/api/config');
    expect(on.body).toMatchObject({ features: { push: true }, vapidPublicKey: (await vapidKeys()).publicKey });
  });
});
