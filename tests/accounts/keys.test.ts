import { afterEach, describe, expect, it, vi } from 'vitest';
import { outside } from '../../server/features/accounts/auth';
import { api, guest } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

afterEach(() => {
  outside.oauth = {};
  outside.fetch = undefined;
});

/** The cookie a response sets, as a request would send it back. */
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

describe('off until keyed', () => {
  it('says so in /api/config and answers 404 or 501 cleanly', async () => {
    const a = await api(41);
    const g = await guest(a, 'Amber Gannet');
    expect((await a.json('GET', '/api/config')).body.features).toMatchObject({ passkeys: true, google: false, apple: false, discord: false, email: false });
    for (const p of ['google', 'apple', 'discord']) {
      const start = await a.json('POST', `/api/auth/oauth/${p}/start`, { token: g.token });
      expect(start.status).toBe(501);
      expect(start.body.code).toBe('off');
      expect((await a.call('GET', `/api/auth/oauth/${p}/callback?code=x&state=y`)).status).toBe(501);
    }
    expect((await a.call('POST', '/api/auth/oauth/myspace/start', { token: g.token })).status).toBe(404);
    for (const path of ['/api/auth/email/start', '/api/auth/email/verify']) {
      const r = await a.json('POST', path, { token: g.token, body: { email: 'a@b.example' } });
      expect(r.status).toBe(501);
      expect(r.body.code).toBe('off');
    }
    expect((await a.call('POST', '/api/auth/claim')).status).toBe(404);
  });
});

describe('a provider, once keyed (Discord, its network stood in for)', () => {
  it('starts with a sealed flow, comes back to the page, and the session is picked up once; the guest is upgraded', async () => {
    const a = await api(42, { DISCORD_CLIENT_ID: '123456', DISCORD_CLIENT_SECRET: 'shh' });
    expect((await a.json('GET', '/api/config')).body.features.discord).toBe(true);
    const asked: string[] = [];
    outside.oauth = {
      fetch: (async (url: string | URL | Request) => {
        asked.push(String(url));
        if (String(url).includes('/oauth2/token')) return Response.json({ access_token: 'at', token_type: 'Bearer' });
        return Response.json({ id: '41290573186402816', username: 'marlow', global_name: 'Marlow Real Name' });
      }) as typeof fetch,
    };
    const g = await guest(a, 'Teal Cormorant');
    const start = await a.call('POST', '/api/auth/oauth/discord/start', { token: g.token });
    expect(start.status).toBe(200);
    const set = start.headers.get('set-cookie')!;
    expect(set).toMatch(/^xo_flow=.*Path=\/api\/auth\/oauth; Max-Age=600; HttpOnly; SameSite=Lax/);
    const url = new URL((await start.json()).url);
    expect(url.origin).toBe('https://discord.com');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/auth/oauth/discord/callback');
    const state = url.searchParams.get('state')!;
    // The wrong state goes back to the page as a failure, with no session.
    const wrong = await a.call('GET', `/api/auth/oauth/discord/callback?code=c&state=nope`, { headers: { cookie: cookieOf(start) } });
    expect(wrong.status).toBe(303);
    expect(wrong.headers.get('location')).toBe('http://localhost:5173/?go=/multi#signin-failed');
    const back = await a.call('GET', `/api/auth/oauth/discord/callback?code=c&state=${state}`, { headers: { cookie: cookieOf(start) } });
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe('http://localhost:5173/?go=/multi#signin');
    expect(back.headers.get('location')).not.toContain('xa1');
    const claimCookie = cookieOf(back);
    expect(back.headers.get('set-cookie')).toMatch(/Path=\/api\/auth\/claim; Max-Age=120; HttpOnly/);
    // The same callback again: its state is spent.
    expect((await a.call('GET', `/api/auth/oauth/discord/callback?code=c&state=${state}`, { headers: { cookie: cookieOf(start) } })).headers.get('location')).toContain('signin-failed');
    const claim = await a.json('POST', '/api/auth/claim', { headers: { cookie: claimCookie } });
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ user: g.user, name: 'Teal Cormorant', guest: false });
    // (The provider's own name isn't taken.)
    expect(JSON.stringify(claim.body)).not.toContain('Real Name');
    expect((await a.world.services.identify(claim.body.token))?.user).toBe(g.user);
    expect((await a.json('POST', '/api/auth/claim', { headers: { cookie: claimCookie } })).status).toBe(400);
    expect((await a.json('GET', '/api/me', { token: claim.body.token })).body.methods.providers).toEqual(['discord']);
    // Signing in with Discord again from another device's guest finds the same account.
    const other = await guest(a, 'Elsewhere');
    const s2 = await a.call('POST', '/api/auth/oauth/discord/start', { token: other.token });
    const state2 = new URL((await s2.json()).url).searchParams.get('state')!;
    const back2 = await a.call('GET', `/api/auth/oauth/discord/callback?code=c2&state=${state2}`, { headers: { cookie: cookieOf(s2) } });
    const claim2 = await a.json('POST', '/api/auth/claim', { headers: { cookie: cookieOf(back2) } });
    expect(claim2.body.user).toBe(g.user);
    expect(asked.filter((u) => u.includes('/oauth2/token'))).toHaveLength(2);
  });
});

describe('email, once keyed (Resend stood in for)', () => {
  it('sends a link and a code, signs in with either once, and keeps an address only when asked to', async () => {
    const a = await api(43, { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Hexplorers <post@exploratory.example>' });
    expect((await a.json('GET', '/api/config')).body.features.email).toBe(true);
    const sent: { to: string[]; text: string }[] = [];
    outside.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init!.body)));
      return Response.json({ id: `m${sent.length}` });
    }) as typeof fetch;
    const g = await guest(a, 'Coral Petrel');
    expect((await a.json('POST', '/api/auth/email/start', { token: g.token, body: { email: 'not an address' } })).status).toBe(400);
    expect((await a.json('POST', '/api/auth/email/start', { token: g.token, body: { email: 'Coral@Example.org' } })).status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['Coral@Example.org']);
    const token = decodeURIComponent(/#magic=([^\s]+)/.exec(sent[0].text)![1]);
    expect(sent[0].text).toContain('http://localhost:5173/?go=/multi#magic=');
    // Asking again within the minute sends nothing more.
    await a.json('POST', '/api/auth/email/start', { token: g.token, body: { email: 'coral@example.org' } });
    expect(sent).toHaveLength(1);
    const r = await a.json('POST', '/api/auth/email/verify', { token: g.token, body: { token } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ user: g.user, guest: false });
    expect((await a.json('POST', '/api/auth/email/verify', { body: { token } })).body.code).toBe('used');
    // No address kept: only its hash, for signing in.
    const row = await a.world.db.first<{ address: string | null; hash: string }>('SELECT address, hash FROM emails WHERE user = ?', g.user);
    expect(row?.address).toBeNull();
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
    // On another device, with the code; this time asking for letters by email, so the address is kept.
    a.world.now += 2 * 60_000;
    await a.json('POST', '/api/auth/email/start', { body: { email: 'coral@example.org', notify: true } });
    const code = /code on the device you're signing in on: (\d{6})/.exec(sent[1].text)![1];
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await a.json('POST', '/api/auth/email/verify', { body: { email: 'coral@example.org', code: wrong } })).status).toBe(400);
    const c = await a.json('POST', '/api/auth/email/verify', { body: { email: 'CORAL@example.org', code } });
    expect(c.body.user).toBe(g.user);
    expect((await a.world.db.first<{ address: string }>('SELECT address FROM emails WHERE user = ?', g.user))?.address).toBe('coral@example.org');
    // Five wrong codes and the letter is spent.
    a.world.now += 2 * 60_000;
    await a.json('POST', '/api/auth/email/start', { body: { email: 'coral@example.org' } });
    const third = /code on the device you're signing in on: (\d{6})/.exec(sent[2].text)![1];
    for (let i = 0; i < 5; i++) await a.json('POST', '/api/auth/email/verify', { body: { email: 'coral@example.org', code: third === '000000' ? '111111' : '000000' } });
    expect((await a.json('POST', '/api/auth/email/verify', { body: { email: 'coral@example.org', code: third } })).body.code).toBe('code');
  });
});
