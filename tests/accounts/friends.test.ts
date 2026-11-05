import { describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '../../src/net/protocol';
import { account, api, finish, guest, type Api } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

const notes = (a: Api, user: string) => a.world.db.all<{ title: string; url: string }>('SELECT title, url FROM notes WHERE user = ? ORDER BY id', user);
const chatTexts = (msgs: ServerMsg[]) => msgs.flatMap((m) => (m.t === 'chat' && m.line.text ? [m.line.text] : m.t === 'welcome' ? m.chat.flatMap((l) => (l.text ? [l.text] : [])) : []));

describe('friends', () => {
  it('asks by handle, accepts, lists both ways and lets go', async () => {
    const a = await api(31);
    const marlow = await account(a, 'Marlow');
    const wren = await account(a, 'Wren');
    // By handle, any case; the other side is told (the notifications stub keeps the note).
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { handle: `@${wren.handle.toLowerCase()}` } })).body).toEqual({ state: 'asked' });
    expect(await notes(a, wren.user)).toEqual([{ title: 'A friend request', url: '/?go=/multi' }]);
    const theirs = (await a.json('GET', '/api/friends', { token: wren.token })).body;
    expect(theirs.incoming).toMatchObject([{ user: marlow.user, handle: marlow.handle, name: 'Marlow' }]);
    expect((await a.json('GET', '/api/friends', { token: marlow.token })).body.outgoing).toMatchObject([{ user: wren.user }]);
    expect((await a.json('POST', `/api/friends/${marlow.user}/accept`, { token: wren.token })).body).toEqual({ state: 'friends' });
    const mine = (await a.json('GET', '/api/friends', { token: marlow.token })).body;
    expect(mine.friends).toMatchObject([{ user: wren.user, handle: wren.handle, name: 'Wren' }]);
    expect(mine.friends[0].lastSeen).toBeTypeOf('number');
    expect(mine.outgoing).toEqual([]);
    expect((await a.json('GET', '/api/friends', { token: wren.token })).body.friends).toMatchObject([{ user: marlow.user }]);
    // Asking someone who already asked you makes you friends at once.
    const bea = await account(a, 'Bea');
    await a.json('POST', '/api/friends', { token: bea.token, body: { handle: marlow.handle } });
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { handle: bea.handle } })).body).toEqual({ state: 'friends' });
    // Declined requests go quietly; removing ends it both ways.
    const cal = await account(a, 'Cal');
    await a.json('POST', '/api/friends', { token: cal.token, body: { handle: marlow.handle } });
    await a.json('POST', `/api/friends/${cal.user}/decline`, { token: marlow.token });
    expect((await a.json('GET', '/api/friends', { token: cal.token })).body.outgoing).toEqual([]);
    await a.call('DELETE', `/api/friends/${wren.user}`, { token: marlow.token });
    expect((await a.json('GET', '/api/friends', { token: wren.token })).body.friends).toEqual([]);
    // Unknown handles, yourself, and guests on either side.
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { handle: 'NobodyAtAll' } })).status).toBe(404);
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { handle: marlow.handle } })).body.code).toBe('self');
    const g = await guest(a, 'Drifter');
    expect((await a.json('POST', '/api/friends', { token: g.token, body: { handle: marlow.handle } })).body.code).toBe('guest');
  });

  it('offers recent sailors, asks one by id, and refuses ids of strangers and of the young', async () => {
    const a = await api(32);
    const marlow = await account(a, 'Marlow');
    const wren = await account(a, 'Wren');
    const stranger = await account(a, 'Stranger');
    const g = await guest(a, 'Guest Gull');
    const year = new Date(a.world.now).getUTCFullYear();
    const kid = await account(a, 'Kit', { birthYear: year - 9 });
    await finish(a, [{ user: marlow.user, name: 'Marlow' }, { user: wren.user, name: 'Wren' }, { user: g.user, name: 'Guest Gull' }, { user: kid.user, name: 'Kit' }]);
    const recent = (await a.json('GET', '/api/friends', { token: marlow.token })).body.recent;
    expect(recent.map((r: { user: string }) => r.user).sort()).toEqual([wren.user, g.user, kid.user].sort());
    expect(recent.find((r: { user: string }) => r.user === g.user)).toMatchObject({ guest: true, name: 'Guest Gull' });
    expect(recent.find((r: { user: string }) => r.user === kid.user)).toMatchObject({ name: kid.handle });
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { user: wren.user } })).body).toEqual({ state: 'asked' });
    expect((await a.json('GET', '/api/friends', { token: marlow.token })).body.recent.map((r: { user: string }) => r.user)).not.toContain(wren.user);
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { user: stranger.user } })).status).toBe(404);
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { user: g.user } })).body.code).toBe('guest');
    // A sailor under 13 is asked by handle only.
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { user: kid.user } })).body.code).toBe('young');
    expect((await a.json('POST', '/api/friends', { token: marlow.token, body: { handle: kid.handle } })).body).toEqual({ state: 'asked' });
  });

  it('says who is in a harbour, and invites a friend to yours', async () => {
    const a = await api(33);
    const marlow = await account(a, 'Marlow');
    const wren = await account(a, 'Wren');
    await a.json('POST', '/api/friends', { token: marlow.token, body: { handle: wren.handle } });
    await a.json('POST', `/api/friends/${marlow.user}/accept`, { token: wren.token });
    const code = (await a.json('POST', '/api/rooms', { token: marlow.token, body: { settings: { seats: 3 } } })).body.code;
    expect((await a.call('PUT', '/api/friends/here', { token: marlow.token, body: { code } })).status).toBe(200);
    expect((await a.json('GET', '/api/friends', { token: wren.token })).body.friends[0].where).toBe('harbour');
    expect((await a.json('POST', `/api/friends/${wren.user}/invite`, { token: marlow.token, body: { code } })).body).toEqual({ invited: true });
    expect((await notes(a, wren.user)).at(-1)).toEqual({ title: 'Marlow asks you aboard', url: `/r/${code}` });
    // Not to someone off your list, and not to a room that isn't there.
    const cal = await account(a, 'Cal');
    expect((await a.call('POST', `/api/friends/${cal.user}/invite`, { token: marlow.token, body: { code } })).status).toBe(404);
    expect((await a.json('POST', `/api/friends/${wren.user}/invite`, { token: marlow.token, body: { code: 'BBBBBB' } })).body.code).toBe('room');
    // Gone ashore: nothing to show.
    await a.call('PUT', '/api/friends/here', { token: marlow.token, body: { code: null } });
    expect((await a.json('GET', '/api/friends', { token: wren.token })).body.friends[0].where).toBeUndefined();
  });
});

describe('blocking and reporting', () => {
  it('a block hides their chat in a room, ends a friendship, and stops their requests without a word', async () => {
    const a = await api(34);
    const marlow = await account(a, 'Marlow', { birthYear: 1990, chat: 'free' });
    const pest = await account(a, 'Pest', { birthYear: 1990, chat: 'free' });
    await a.json('POST', '/api/friends', { token: marlow.token, body: { handle: pest.handle } });
    await a.json('POST', `/api/friends/${marlow.user}/accept`, { token: pest.token });
    expect((await a.json('POST', '/api/block', { token: marlow.token, body: { handle: pest.handle } })).body).toEqual({ blocked: true });
    expect((await a.json('GET', '/api/block', { token: marlow.token })).body.blocked).toEqual([{ user: pest.user, handle: pest.handle, name: 'Pest' }]);
    expect((await a.json('GET', '/api/friends', { token: marlow.token })).body.friends).toEqual([]);
    // Their request looks sent, and nothing arrives.
    expect((await a.json('POST', '/api/friends', { token: pest.token, body: { handle: marlow.handle } })).body).toEqual({ state: 'asked' });
    expect((await a.json('GET', '/api/friends', { token: marlow.token })).body.incoming).toEqual([]);
    // In a room: the one who blocked never hears them; a third person does.
    const w = a.world;
    const third = await guest(a, 'Third');
    const code = await w.createRoom(pest.token, { settings: { seats: 3 } });
    const sockPest = await w.connect(code, { token: pest.token });
    await w.send(code, sockPest, { t: 'claim', seat: 0 });
    await w.send(code, sockPest, { t: 'chat', text: 'before you came' });
    const sockMarlow = await w.connect(code, { token: marlow.token });
    await w.send(code, sockMarlow, { t: 'claim', seat: 1 });
    const sockThird = await w.connect(code, { token: third.token });
    await w.send(code, sockThird, { t: 'claim', seat: 2 });
    await w.send(code, sockPest, { t: 'chat', text: 'hello all' });
    await w.send(code, sockThird, { t: 'chat', text: 'hi from third' });
    const heard = chatTexts(sockMarlow.take());
    expect(heard).toContain('hi from third');
    expect(heard).not.toContain('hello all');
    expect(heard).not.toContain('before you came');
    expect(chatTexts(sockThird.take())).toEqual(expect.arrayContaining(['before you came', 'hello all', 'hi from third']));
    // Unblocked, they're heard again (from the next time the room is joined).
    await a.call('DELETE', `/api/block/${pest.user}`, { token: marlow.token });
    const again = await w.connect(code, { token: marlow.token });
    expect(chatTexts(again.take())).toContain('hello all');
  });

  it('quick talk only: an account that hasn’t opted in neither sends nor sees free text, quick words still go', async () => {
    const a = await api(35);
    const w = a.world;
    const quiet = await account(a, 'Quiet');
    const talker = await guest(a, 'Talker');
    const code = await w.createRoom(talker.token, { settings: { seats: 3 } });
    const sockTalker = await w.connect(code, { token: talker.token });
    await w.send(code, sockTalker, { t: 'claim', seat: 0 });
    const sockQuiet = await w.connect(code, { token: quiet.token });
    await w.send(code, sockQuiet, { t: 'claim', seat: 1 });
    // (The seat an account takes shows its handle, for its profile link.)
    const rooms = sockQuiet.take().flatMap((m) => (m.t === 'room' ? [m.room] : []));
    expect(rooms.at(-1)?.seats[1]).toMatchObject({ user: quiet.user, handle: quiet.handle });
    expect(rooms.at(-1)?.seats[0].handle).toBeUndefined();
    await w.send(code, sockTalker, { t: 'chat', text: 'free words' });
    await w.send(code, sockTalker, { t: 'chat', quick: 'goodLuck' });
    const got = sockQuiet.take();
    expect(chatTexts(got)).toEqual([]);
    expect(got.some((m) => m.t === 'chat' && m.line.quick === 'goodLuck')).toBe(true);
    await w.send(code, sockQuiet, { t: 'chat', text: 'let me talk' });
    expect(sockQuiet.take().some((m) => m.t === 'error' && m.code === 'chat')).toBe(true);
    expect(chatTexts(sockTalker.take())).not.toContain('let me talk');
  });

  it('reports from a profile reach the reports table; blocks and reports work for guests too', async () => {
    const a = await api(36);
    const marlow = await account(a, 'Marlow');
    const g = await guest(a, 'Drifter');
    expect((await a.json('POST', '/api/report', { token: g.token, body: { handle: marlow.handle, reason: 'name', note: 'rude name' } })).body).toMatchObject({ reported: true });
    const rows = await a.world.db.all<{ room: string; from_user: string; about: string; reason: string }>('SELECT room, from_user, about, reason FROM reports');
    expect(rows).toEqual([{ room: 'profile', from_user: g.user, about: marlow.user, reason: 'name' }]);
    expect((await a.json('POST', '/api/report', { token: g.token, body: { handle: marlow.handle, reason: 'rudeness' } })).status).toBe(400);
    expect((await a.json('POST', '/api/report', { token: g.token, body: { user: g.user, reason: 'other' } })).body.code).toBe('self');
    expect((await a.json('POST', '/api/block', { token: g.token, body: { user: marlow.user } })).body).toEqual({ blocked: true });
    expect(await a.world.services.blocked(g.user)).toEqual([marlow.user]);
    expect((await a.call('POST', '/api/block', { body: { user: marlow.user } })).status).toBe(401);
  });
});
