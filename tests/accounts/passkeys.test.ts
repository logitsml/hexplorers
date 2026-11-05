import { describe, expect, it, vi } from 'vitest';
import { SoftPasskey, account, addPasskey, api, finish, guest, signInWith } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

describe('passkeys, end to end through the routes', () => {
  it('a guest adds a passkey and becomes an account with the same id; its guest token stops working', async () => {
    const a = await api(11);
    const g = await guest(a, 'Amber Gannet');
    await finish(a, [{ user: g.user, name: g.name }], 0);
    const r = await addPasskey(a, g.token);
    expect(r.status).toBe(201);
    expect(r.options.rp.id).toBe('localhost');
    expect(r.options.user.name).toBe(r.body.handle);
    expect(r.body).toMatchObject({ user: g.user, name: 'Amber Gannet', guest: false });
    expect(r.body.handle).toMatch(/^AmberGannet\d{4}$/);
    expect(r.body.token).toMatch(/^xa1\./);
    // The same person, now an account: the room services see the handle, and the record carried over.
    const id = await a.world.services.identify(r.body.token);
    expect(id).toMatchObject({ user: g.user, handle: r.body.handle, guest: false, quickTalk: true });
    const me = await a.json('GET', '/api/me', { token: r.body.token });
    expect(me.body).toMatchObject({ user: g.user, guest: false, played: 1, won: 1 });
    expect(me.body.methods.passkeys).toHaveLength(1);
    expect(me.body.methods.passkeys[0].device).toBe('iPhone · Safari');
    // The old guest token is spent.
    expect(await a.world.services.identify(g.token)).toBeNull();
    expect((await a.call('GET', '/api/me', { token: g.token })).status).toBe(401);
    expect((await a.json('GET', '/api/config')).body.features).toMatchObject({ passkeys: true, google: false, apple: false, discord: false, email: false });
  });

  it('signs in on another device with the passkey, and the guest played there comes along', async () => {
    const a = await api(12);
    const acc = await account(a, 'Teal Cormorant');
    // Another device: its own guest, who played a game before signing in.
    const other = await guest(a, 'Teal on the iPad');
    await finish(a, [{ user: other.user, name: other.name }, { user: 'g_somebodyelse1', name: 'Wren' }], 0, a.world.now + 1000);
    const r = await signInWith(a, acc.key, other.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ user: acc.user, handle: acc.handle, guest: false });
    expect(r.body.token).not.toBe(acc.token);
    // Both sessions work; the iPad's guest is gone and its game is the account's now.
    expect((await a.world.services.identify(acc.token))?.user).toBe(acc.user);
    expect((await a.world.services.identify(r.body.token))?.user).toBe(acc.user);
    expect(await a.world.services.identify(other.token)).toBeNull();
    const me = (await a.json('GET', '/api/me', { token: r.body.token })).body;
    expect(me.played).toBe(1);
    expect(me.won).toBe(1);
  });

  it('refuses a replayed answer, a stale flow, the wrong origin, an unknown passkey and someone else’s flow', async () => {
    const a = await api(13);
    const acc = await account(a, 'Coral Petrel');
    const opts = await a.json('POST', '/api/auth/passkey/login/options');
    const response = await acc.key.get(opts.body.options);
    const ok = await a.json('POST', '/api/auth/passkey/login/verify', { body: { flow: opts.body.flow, response } });
    expect(ok.status).toBe(200);
    // The same answer again: its challenge is spent.
    const again = await a.json('POST', '/api/auth/passkey/login/verify', { body: { flow: opts.body.flow, response } });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('flow');
    // A flow kept past its five minutes.
    const late = await a.json('POST', '/api/auth/passkey/login/options');
    a.world.now += 6 * 60_000;
    const lateAnswer = await a.json('POST', '/api/auth/passkey/login/verify', { body: { flow: late.body.flow, response: await acc.key.get(late.body.options) } });
    expect(lateAnswer.body.code).toBe('flow');
    // An answer made for another site.
    const evil = new SoftPasskey('https://evil.example');
    const g = await guest(a, 'Slate Tern');
    const reg = await a.json('POST', '/api/auth/passkey/register/options', { token: g.token });
    const bad = await a.json('POST', '/api/auth/passkey/register/verify', { token: g.token, body: { flow: reg.body.flow, response: await evil.create(reg.body.options) } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('origin');
    // A passkey nobody registered.
    const stranger = new SoftPasskey();
    await stranger.create(reg.body.options);
    expect((await signInWith(a, stranger)).body.code).toBe('credential');
    // Another guest's registration flow.
    const thief = await guest(a, 'Pearl Skua');
    const stolen = await a.json('POST', '/api/auth/passkey/register/verify', { token: thief.token, body: { flow: reg.body.flow, response: await new SoftPasskey().create(reg.body.options) } });
    expect(stolen.status).toBe(401);
    // A post from another site never gets that far.
    expect((await a.call('POST', '/api/auth/passkey/login/options', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('an account adds a second passkey (no new session), and sessions are listed, revoked and signed out', async () => {
    const a = await api(14);
    const acc = await account(a, 'Saffron Puffin');
    const second = await addPasskey(a, acc.token, new SoftPasskey());
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ added: true });
    // The first passkey is excluded from the second's options.
    expect(second.options.excludeCredentials).toHaveLength(1);
    const laptop = await signInWith(a, second.key);
    expect(laptop.status).toBe(200);
    const list = await a.json('GET', '/api/auth/sessions', { token: acc.token });
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.body.sessions.find((s: { current: boolean }) => !s.current);
    // Revoked: the laptop's token is refused everywhere, the phone's still works.
    expect((await a.call('DELETE', `/api/auth/sessions/${other.id}`, { token: acc.token })).status).toBe(200);
    expect(await a.world.services.identify(laptop.body.token)).toBeNull();
    expect((await a.call('GET', '/api/me', { token: laptop.body.token })).status).toBe(401);
    expect((await a.world.services.identify(acc.token))?.user).toBe(acc.user);
    // Someone else's session can't be revoked by id.
    const stranger = await account(a, 'Russet Plover');
    const theirs = (await a.json('GET', '/api/auth/sessions', { token: stranger.token })).body.sessions[0];
    expect((await a.call('DELETE', `/api/auth/sessions/${theirs.id}`, { token: acc.token })).status).toBe(404);
    // Signing out ends this session.
    expect((await a.call('POST', '/api/auth/logout', { token: acc.token })).status).toBe(200);
    expect(await a.world.services.identify(acc.token)).toBeNull();
    // A forged token never reaches the database.
    const forged = `${acc.token.slice(0, -4)}AAAA`;
    expect(await a.world.services.identify(forged)).toBeNull();
  });
});
