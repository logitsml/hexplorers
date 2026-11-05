import { describe, expect, it, vi } from 'vitest';
import { gunzip } from '../../src/net/codes';
import { ageBand, handleFor, handleProblem } from '../../server/features/accounts/core';
import { account, api, finish, guest } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

describe('handles', () => {
  it('are 3 to 20 letters, digits or underscores, moderated word by word, and not the harbour’s own', () => {
    expect(handleProblem('Marlow')).toBeNull();
    expect(handleProblem('amber_gannet_42')).toBeNull();
    expect(handleProblem('Scunthorpe')).toBeNull();
    expect(handleProblem('ab')).not.toBeNull();
    expect(handleProblem('has space')).not.toBeNull();
    expect(handleProblem('ünïcode')).not.toBeNull();
    expect(handleProblem('12345')).not.toBeNull();
    expect(handleProblem('Admin')).not.toBeNull();
    expect(handleProblem('moderator_1')).not.toBeNull();
    expect(handleProblem('BigShit')).not.toBeNull();
    expect(handleProblem('big_sh1t')).not.toBeNull();
    expect(handleProblem('xX_fuck_Xx')).not.toBeNull();
    // Made from a name: its letters as one word and four digits, a sailor's when the name won't do.
    const rand = () => new Uint8Array([0, 0, 4, 210]);
    expect(handleFor('Amber Gannet', rand)).toBe('AmberGannet1234');
    expect(handleFor('Zoë of the Isles', rand)).toBe('ZoeOfTheIsles1234');
    expect(handleFor('★★', rand)).toBe('Sailor1234');
  });

  it('are unique without regard to case, and checked on every change', async () => {
    const a = await api(21);
    const one = await account(a, 'Heather Fulmar');
    const two = await account(a, 'Copper Osprey');
    expect((await a.json('PATCH', '/api/me', { token: one.token, body: { handle: 'Marlow' } })).body.handle).toBe('Marlow');
    const taken = await a.json('PATCH', '/api/me', { token: two.token, body: { handle: 'mARLOW' } });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('taken');
    expect((await a.json('PATCH', '/api/me', { token: two.token, body: { handle: 'Wanker_99' } })).status).toBe(400);
    expect((await a.json('PATCH', '/api/me', { token: two.token, body: { handle: 'support' } })).status).toBe(400);
    // Changing your own handle's case is fine.
    expect((await a.json('PATCH', '/api/me', { token: one.token, body: { handle: 'MARLOW' } })).body.handle).toBe('MARLOW');
    // A profile answers to any case of its handle.
    expect((await a.json('GET', '/api/u/marlow')).body).toMatchObject({ user: one.user, handle: 'MARLOW', name: 'Heather Fulmar' });
    expect((await a.call('GET', '/api/u/nobody_here')).status).toBe(404);
    // Names are moderated too, and a guest can change only theirs.
    expect((await a.json('PATCH', '/api/me', { token: one.token, body: { name: 'fuckface' } })).status).toBe(400);
    const g = await guest(a, 'Ochre Heron');
    expect((await a.json('PATCH', '/api/me', { token: g.token, body: { name: 'Ochre the Bold' } })).body.name).toBe('Ochre the Bold');
    expect((await a.json('PATCH', '/api/me', { token: g.token, body: { handle: 'Ochre' } })).status).toBe(403);
  });
});

describe('the age band and free chat', () => {
  it('keeps a band, never the year; free chat is an opt-in for 13 and over, and under 13 stays so', async () => {
    const now = Date.UTC(2026, 9, 24);
    expect(ageBand(2013, now)).toBe('u13');
    expect(ageBand(2012, now)).toBe('13-15');
    expect(ageBand(2009, now)).toBe('16-17');
    expect(ageBand(1990, now)).toBe('18+');
    const a = await api(22);
    const year = new Date(a.world.now).getUTCFullYear();
    const adult = await account(a, 'Jade Curlew', { birthYear: year - 30, chat: 'free' });
    expect(await a.world.services.identify(adult.token)).not.toHaveProperty('quickTalk');
    const me = (await a.json('GET', '/api/me', { token: adult.token })).body;
    expect(me.settings).toMatchObject({ ageBand: '18+', chat: 'free' });
    expect(JSON.stringify(me)).not.toContain(String(year - 30));
    // No year given: free chat waits for one.
    const quiet = await account(a, 'Cobalt Shearwater');
    expect((await a.world.services.identify(quiet.token))?.quickTalk).toBe(true);
    expect((await a.json('PATCH', '/api/me', { token: quiet.token, body: { settings: { chat: 'free' } } })).body.code).toBe('age');
    expect((await a.json('PATCH', '/api/me', { token: quiet.token, body: { settings: { birthYear: year - 20, chat: 'free' } } })).body.settings.chat).toBe('free');
    // Under 13: quick talk, whatever is asked, and the band can't be signed away.
    const young = await account(a, 'Pearl Kittiwake', { birthYear: year - 10, chat: 'free' });
    expect((await a.world.services.identify(young.token))?.quickTalk).toBe(true);
    expect((await a.json('PATCH', '/api/me', { token: young.token, body: { settings: { chat: 'free' } } })).body.code).toBe('age');
    expect((await a.json('PATCH', '/api/me', { token: young.token, body: { settings: { birthYear: year - 40 } } })).body.code).toBe('age');
    // Their public profile shows the handle, not a name, and no games.
    await finish(a, [{ user: young.user, name: young.name }]);
    const p = (await a.json('GET', `/api/u/${young.handle}`)).body;
    expect(p).toMatchObject({ name: young.handle, played: 1, recent: [] });
  });
});

describe('profiles, export and erasure', () => {
  it('a profile counts the games played and won from the plays table, newest first', async () => {
    const a = await api(23);
    const acc = await account(a, 'Indigo Gannet');
    const g = await guest(a, 'Sorrel Tern');
    const first = await finish(a, [{ user: acc.user, name: acc.name }, { user: g.user, name: g.name }], 0, a.world.now);
    const second = await finish(a, [{ user: g.user, name: g.name }, { user: acc.user, name: acc.name }], 0, a.world.now + 60_000);
    const p = (await a.json('GET', `/api/u/${acc.handle}`)).body;
    expect(p).toMatchObject({ user: acc.user, handle: acc.handle, played: 2, won: 1, rating: null });
    expect(p.recent.map((r: { replay: string }) => r.replay)).toEqual([second, first]);
    expect(p.recent[0]).toMatchObject({ seat: 1, points: 7, won: false });
    expect(p.joined).toBeTypeOf('number');
  });

  it('the export holds everything kept about you, and no secret', async () => {
    const a = await api(24);
    const acc = await account(a, 'Amber Puffin', { birthYear: 1990 });
    const friend = await account(a, 'Teal Heron');
    await finish(a, [{ user: acc.user, name: acc.name }, { user: friend.user, name: friend.name }]);
    await a.json('POST', '/api/friends', { token: acc.token, body: { handle: friend.handle } });
    const pest = await guest(a, 'Slate Skua');
    await a.json('POST', '/api/block', { token: acc.token, body: { user: pest.user } });
    const r = await a.call('GET', '/api/me/export', { token: acc.token });
    expect(r.headers.get('content-disposition')).toContain('attachment');
    const out = await r.json();
    expect(out.profile).toMatchObject({ user: acc.user, handle: acc.handle, name: 'Amber Puffin' });
    expect(out.plays).toHaveLength(1);
    expect(out.plays[0].link).toContain('/api/replays/');
    expect(out.signIn.passkeys).toHaveLength(1);
    expect(out.sessions).toHaveLength(1);
    expect(out.friendRequests.sent).toEqual([{ user: friend.user, at: expect.any(Number) }]);
    expect(out.blocked).toEqual([{ user: pest.user }]);
    // Only hashes of secrets are kept, and the export doesn't include those either.
    const text = JSON.stringify(out);
    expect(text).not.toContain(acc.token.split('.')[2]);
    expect(text).not.toContain('token_hash');
    // A guest gets their copy too.
    expect((await a.json('GET', '/api/me/export', { token: pest.token })).body.profile).toMatchObject({ user: pest.user, guest: true });
  });

  it('erasing removes their rows and sessions, and makes their seats in stored games anonymous', async () => {
    const a = await api(25);
    const acc = await account(a, 'Russet Albatross');
    const other = await account(a, 'Cobalt Tern');
    const replay = await finish(a, [{ user: acc.user, name: acc.name }, { user: other.user, name: other.name }]);
    await a.json('POST', '/api/friends', { token: acc.token, body: { handle: other.handle } });
    await a.json('POST', `/api/friends/${acc.user}/accept`, { token: other.token });
    await a.json('POST', '/api/block', { token: acc.token, body: { handle: 'nobody' } });
    // The confirmation must name them.
    expect((await a.json('DELETE', '/api/me', { token: acc.token, body: { confirm: 'someone else' } })).body.code).toBe('confirm');
    const r = await a.json('DELETE', '/api/me', { token: acc.token, body: { confirm: acc.name.toUpperCase() } });
    expect(r.body).toEqual({ erased: true });
    expect(await a.world.services.identify(acc.token)).toBeNull();
    expect((await a.call('GET', `/api/u/${acc.handle}`)).status).toBe(404);
    for (const t of ['users', 'passkeys', 'sessions', 'oauth_links', 'emails', 'friend_requests', 'blocks']) {
      const col = t === 'users' ? 'id' : t === 'friend_requests' ? 'from_user' : 'user';
      expect((await a.world.db.all(`SELECT * FROM ${t} WHERE ${col} = ?`, acc.user)).length, t).toBe(0);
    }
    expect(await a.world.db.all('SELECT * FROM friends WHERE user = ? OR friend = ?', acc.user, acc.user)).toHaveLength(0);
    expect(await a.world.db.all('SELECT * FROM plays WHERE user = ?', acc.user)).toHaveLength(0);
    // The game stays in the other player's history, with "A former sailor" in the erased one's seat.
    expect((await a.json('GET', `/api/u/${other.handle}`)).body.played).toBe(1);
    const game = JSON.parse(await gunzip((await a.world.blobs.get(`replays/${replay}.json.gz`))!));
    expect(game.seats[0]).toMatchObject({ name: 'A former sailor' });
    expect(game.seats[0].user).toBeUndefined();
    expect(game.seats[1]).toMatchObject({ user: other.user, name: other.name });
    expect(JSON.stringify(game)).not.toContain(acc.user);
    // A guest can be erased as well.
    const g = await guest(a, 'Ochre Plover');
    expect((await a.json('DELETE', '/api/me', { token: g.token, body: { confirm: 'Ochre Plover' } })).body).toEqual({ erased: true });
    expect(await a.world.services.identify(g.token)).toBeNull();
  });
});
