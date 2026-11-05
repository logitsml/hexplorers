import { afterEach, describe, expect, it, vi } from 'vitest';
import { signToken } from '../../server/lib/crypto';
import {
  MAGIC_TTL_MS,
  RESEND_ENDPOINT,
  createMagicLink,
  emailHash,
  isConfigured,
  isPlausibleEmail,
  magicCode,
  magicLinkUrl,
  sendEmail,
  signInEmail,
  verifyMagicCode,
  verifyMagicLink,
} from '../../server/lib/email';

const SECRET = '0123456789abcdef'.repeat(4);
const ENV = { RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'Hexplorers <post@exploratory.example>' };
const ADDRESS = 'Sailor.Person@Example.com';
const NOW = 1_760_000_000_000;

/** A one-time store, as the services would keep in the DB. */
function store() {
  const used = new Set<string>();
  return (nonce: string) => {
    if (used.has(nonce)) return false;
    used.add(nonce);
    return true;
  };
}

afterEach(() => vi.restoreAllMocks());

describe('magic-link tokens', () => {
  it('verify once within 15 minutes, carrying a hash of the address but never the address', async () => {
    const link = await createMagicLink(ADDRESS, SECRET, { now: NOW });
    expect(link.exp).toBe(NOW + MAGIC_TTL_MS);
    expect(link.code).toMatch(/^\d{6}$/);
    expect(link.emailHash).toBe(await emailHash('  sailor.person@example.com ', SECRET));
    const payload = atob(link.token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    expect(payload.toLowerCase()).not.toContain('sailor');
    expect(payload).not.toContain('@');

    const consume = store();
    const ok = await verifyMagicLink(link.token, SECRET, { consume, now: NOW + MAGIC_TTL_MS - 1 });
    expect(ok).toEqual({ ok: true, emailHash: link.emailHash, nonce: link.nonce, exp: link.exp });
    expect(await verifyMagicLink(link.token, SECRET, { consume, now: NOW + 1000 })).toEqual({ ok: false, reason: 'used' });
  });
  it('refuses expired, forged, re-purposed and mismatched tokens without using them up', async () => {
    const link = await createMagicLink(ADDRESS, SECRET, { now: NOW });
    const consume = vi.fn(store());
    expect(await verifyMagicLink(link.token, SECRET, { consume, now: NOW + MAGIC_TTL_MS })).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyMagicLink(link.token, 'another-secret', { consume, now: NOW })).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyMagicLink(link.token, SECRET, { consume, now: NOW, email: 'someone@else.example' })).toEqual({ ok: false, reason: 'email' });
    // A token signed for another purpose with the same secret can't pass as a magic link.
    const other = await signToken({ e: link.emailHash, n: link.nonce }, SECRET, 60_000, { purpose: 'checkout', now: NOW });
    expect(await verifyMagicLink(other, SECRET, { consume, now: NOW })).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyMagicLink('nonsense', SECRET, { consume })).toEqual({ ok: false, reason: 'malformed' });
    expect(consume).not.toHaveBeenCalled();
    expect((await verifyMagicLink(link.token, SECRET, { consume, now: NOW, email: ADDRESS.toUpperCase() })).ok).toBe(true);
  });
  it('the 6-digit code works once, for the right pending link only', async () => {
    const link = await createMagicLink(ADDRESS, SECRET, { now: NOW });
    const other = await createMagicLink(ADDRESS, SECRET, { now: NOW });
    expect(await magicCode(link.nonce, SECRET)).toBe(link.code);
    const consume = store();
    const pending = { nonce: link.nonce, exp: link.exp, emailHash: link.emailHash };
    const wrong = link.code === '000000' ? '000001' : '000000';
    expect(await verifyMagicCode(wrong, pending, SECRET, { consume, now: NOW })).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyMagicCode('12a456', pending, SECRET, { consume, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyMagicCode(link.code, pending, SECRET, { consume, now: link.exp })).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyMagicCode(link.code, pending, SECRET, { consume, now: NOW, email: 'x@y.example' })).toEqual({ ok: false, reason: 'email' });
    expect((await verifyMagicCode(link.code, pending, SECRET, { consume, now: NOW, email: ADDRESS })).ok).toBe(true);
    expect(await verifyMagicCode(link.code, pending, SECRET, { consume, now: NOW })).toEqual({ ok: false, reason: 'used' });
    // The link and its code share the nonce: using one uses the other.
    expect(await verifyMagicLink(link.token, SECRET, { consume, now: NOW })).toEqual({ ok: false, reason: 'used' });
    expect((await verifyMagicLink(other.token, SECRET, { consume, now: NOW })).ok).toBe(true);
  });
  it('puts the token in the fragment of the site link', async () => {
    const link = await createMagicLink(ADDRESS, SECRET);
    const url = magicLinkUrl('https://exploratory.example/some/path?x=1', link.token);
    expect(url).toBe(`https://exploratory.example/signin#magic=${link.token}`);
    expect(new URL(url).search).toBe('');
  });
});

describe('templates', () => {
  it('"Your sign-in link" has the link, the code and the expiry in both parts', () => {
    const mail = signInEmail({ url: 'https://exploratory.example/signin#magic=abc', code: '042517' });
    expect(mail.subject).toBe('Your sign-in link');
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('https://exploratory.example/signin#magic=abc');
      expect(part).toContain('042517');
      expect(part).toContain('15 minutes');
    }
    expect(mail.html.startsWith('<!doctype html>')).toBe(true);
    expect(() => signInEmail({ url: 'javascript:alert(1)' })).toThrow();
    expect(signInEmail({ url: 'https://x.example/', code: '<b>1</b>' }).html).not.toContain('<b>1</b>');
  });
});

describe('sending through Resend', () => {
  it('is off without both the key and the From address, and then never calls out', async () => {
    const f = vi.fn();
    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ RESEND_API_KEY: 'k' })).toBe(false);
    expect(isConfigured(ENV)).toBe(true);
    expect(await sendEmail({ RESEND_API_KEY: 'k' }, { to: ADDRESS, ...signInEmail({ url: 'https://x.example/' }) }, { fetch: f })).toEqual({
      ok: false,
      error: 'not-configured',
    });
    expect(f).not.toHaveBeenCalled();
  });
  it('posts the message as JSON with the bearer key', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(url), init: init! };
      return new Response(JSON.stringify({ id: 'e1f2' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const mail = { ...signInEmail({ url: 'https://exploratory.example/' }), headers: { 'X-Entity-Ref-ID': 'abc' } };
    const r = await sendEmail(ENV, { to: ADDRESS, ...mail, tags: [{ name: 'kind', value: 'your-move' }, { name: 'bad tag', value: 'x' }], idempotencyKey: 'move-BCDFGH-41' }, { fetch: f });
    expect(r).toEqual({ ok: true, id: 'e1f2' });
    expect(seen!.url).toBe(RESEND_ENDPOINT);
    expect(seen!.init.method).toBe('POST');
    const headers = new Headers(seen!.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer re_test_123');
    expect(headers.get('Idempotency-Key')).toBe('move-BCDFGH-41');
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toMatchObject({
      from: ENV.EMAIL_FROM,
      to: [ADDRESS],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers,
      tags: [{ name: 'kind', value: 'your-move' }],
    });
  });
  it('reports failures by kind, never with the address, and never logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const answer = (status: number) =>
      (async () => new Response(JSON.stringify({ message: `bad recipient ${ADDRESS}` }), { status })) as unknown as typeof fetch;
    const msg = { to: ADDRESS, ...signInEmail({ url: 'https://x.example/' }) };
    const results = [
      await sendEmail(ENV, msg, { fetch: answer(422) }),
      await sendEmail(ENV, msg, { fetch: answer(401) }),
      await sendEmail(ENV, msg, { fetch: answer(429) }),
      await sendEmail(ENV, msg, { fetch: answer(503) }),
      await sendEmail(ENV, msg, { fetch: (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch }),
      await sendEmail(ENV, { ...msg, to: 'not an address' }, { fetch: answer(200) }),
    ];
    expect(results).toEqual([
      { ok: false, error: 'rejected', status: 422 },
      { ok: false, error: 'unauthorized', status: 401 },
      { ok: false, error: 'rate-limited', status: 429 },
      { ok: false, error: 'server-error', status: 503 },
      { ok: false, error: 'network' },
      { ok: false, error: 'invalid-address' },
    ]);
    expect(JSON.stringify(results).toLowerCase()).not.toContain('sailor');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it('checks address shape cheaply', () => {
    expect(isPlausibleEmail('a@b.co')).toBe(true);
    expect(isPlausibleEmail('a@b')).toBe(false);
    expect(isPlausibleEmail('a b@c.d')).toBe(false);
    expect(isPlausibleEmail('<a@b.c>')).toBe(false);
    expect(isPlausibleEmail('x'.repeat(250) + '@b.co')).toBe(false);
  });
});
