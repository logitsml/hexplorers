// The harbour (the lobby), the HTTP API and the services: seats and settings as the host may
// change them, hand-off links, the host leaving, an idle harbour closing, concede and "Sail
// again"; guests' tokens; moderation; the routes and the origin check.

import { describe, expect, it } from 'vitest';
import { HARBOUR_IDLE_MS, ROOM_CODE_RE, type RoomInfo, type ServerMsg } from '../../src/net/protocol';
import { diceCommit } from '../../src/net/codes';
import { handleApi, roomSocket, type HttpContext } from '../../server/http/router';
import { moderateText } from '../../server/services/moderate';
import { HOST_GRACE_MS } from '../../server/room/room';
import { ENV, World, type FakeSocket } from './harness';

const last = <T extends ServerMsg['t']>(s: FakeSocket, t: T) => s.inbox.filter((m) => m.t === t).at(-1) as Extract<ServerMsg, { t: T }> | undefined;
const room = (s: FakeSocket) => (last(s, 'room')?.room ?? last(s, 'welcome')?.room) as RoomInfo;
const errors = (s: FakeSocket) => s.inbox.filter((m) => m.t === 'error').map((m) => (m as Extract<ServerMsg, { t: 'error' }>).code);

describe('services', () => {
  it('guests get a token that identifies them, and only theirs', async () => {
    const w = await new World(3).init();
    const g = await w.guest('Ada');
    expect(g.user).toMatch(/^g_/);
    expect((await w.services.identify(g.token))?.user).toBe(g.user);
    const [p, u, part, mac] = g.token.split('.');
    expect(await w.services.identify([p, u, part, mac.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))].join('.'))).toBeNull();
    expect(await w.services.identify([p, u, part.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')), mac].join('.'))).toBeNull();
    expect(await w.services.identify('junk')).toBeNull();
    // Only a hash of the secret is stored.
    const row = await w.db.first<{ token_hash: string }>('SELECT token_hash FROM guests WHERE user = ?', g.user);
    expect(g.token.includes(row!.token_hash)).toBe(false);
  });

  it('moderation masks words, refuses links, and cleans names', () => {
    expect(moderateText('well played, you sh1t', 'chat')).toBe('well played, you •••');
    expect(moderateText('see www.example.com', 'chat')).toBeNull();
    expect(moderateText('mail me a@b.co', 'chat')).toBeNull();
    expect(moderateText('Scunthorpe classic', 'chat')).toBe('Scunthorpe classic');
    expect(moderateText('  Ada‮​  Lovelace ', 'name')).toBe('Ada Lovelace');
    expect(moderateText('fuckface', 'name')).toBeNull();
    expect(moderateText('x'.repeat(100), 'name')!.length).toBe(24);
  });
});

describe('the HTTP API', () => {
  it('serves the config, guests, rooms and their cards, and checks origins', async () => {
    const w = await new World(4).init();
    const ctx: HttpContext = { env: ENV, db: w.db, blobs: w.blobs, services: w.services, rooms: { fetch: (c, p, i) => w.fetch(c, p, i) }, now: () => w.now, random: (n) => w.random(n), ip: '10.0.0.1' };
    const req = (path: string, init: RequestInit = {}) => handleApi(new Request(`http://localhost:5173${path}`, init), ctx).then((r) => r!);
    const config = await (await req('/api/config')).json();
    expect(config.features.online).toBe(true);
    expect(config.features.google).toBe(false);
    expect(config.turnstileSiteKey).toBeUndefined();
    const g = await (await req('/api/guest', { method: 'POST', body: JSON.stringify({ name: 'Bea' }), headers: { origin: 'http://localhost:5173' } })).json();
    expect(g.name).toBe('Bea');
    // A post from another site is refused.
    expect((await req('/api/guest', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await req('/api/rooms', { method: 'POST', body: '{}' })).status).toBe(401);
    const made = await req('/api/rooms', { method: 'POST', body: JSON.stringify({ settings: { seats: 3 } }), headers: { authorization: `Bearer ${g.token}` } });
    expect(made.status).toBe(201);
    const { code } = await made.json();
    expect(code).toMatch(ROOM_CODE_RE);
    const card = await (await req(`/api/rooms/${code}`)).json();
    expect(card.settings.seats).toBe(3);
    expect(JSON.stringify(card)).not.toContain(g.user);
    expect((await req('/api/rooms/BBBBBB')).status).toBe(404);
    expect((await req('/api/replays/nope')).status).toBe(404);
    expect((await req('/api/match/queue', { method: 'POST' })).status).toBe(404);
    expect((await req('/api/daily/today')).status).toBe(404);
    expect((await req('/api/nothing')).status).toBe(404);
    // Settings the engine can't play are refused at creation.
    const bad = await req('/api/rooms', { method: 'POST', body: JSON.stringify({ settings: { knobs: { pollutionLimit: 3 } } }), headers: { authorization: `Bearer ${g.token}` } });
    expect(bad.status).toBe(400);
    // The socket route: only for a room code, only from our own pages.
    const up = (origin: string) => roomSocket(new Request(`http://localhost:5173/api/rooms/${code}/ws`, { headers: { upgrade: 'websocket', origin, host: 'localhost:5173' } }), ENV);
    expect(up('http://localhost:5173')).toEqual({ code });
    expect((up('https://evil.example') as Response).status).toBe(403);
  });
});

describe('the harbour', () => {
  it('seats, settings, bots, kicks and the host’s role', async () => {
    const w = await new World(5).init();
    const [a, b, c] = [await w.guest('Ann'), await w.guest('Ben'), await w.guest('Cal')];
    const code = await w.createRoom(a.token);
    const sa = await w.connect(code, { token: a.token });
    const sb = await w.connect(code, { token: b.token });
    const info = room(sa);
    expect(info.phase).toBe('harbour');
    // The dice commitment is shown before anyone sends a nonce.
    expect(info.commit).toMatch(/^[0-9a-f]{64}$/);
    const key = (w.rooms.get(code)!.room as unknown as { meta: { key: string } }).meta.key;
    expect(info.commit).toBe(await diceCommit(key));
    await w.send(code, sa, { t: 'claim', seat: 0, color: 'teal' });
    await w.send(code, sb, { t: 'claim', seat: 0 });
    expect(errors(sb)).toContain('taken');
    await w.send(code, sb, { t: 'claim', seat: 1, color: 'teal' });
    expect(errors(sb)).toContain('color');
    await w.send(code, sb, { t: 'claim', seat: 1, name: 'Benedict' });
    expect(room(sa).seats[1]).toMatchObject({ kind: 'human', name: 'Benedict' });
    // Only the host changes settings; presets bring their own mix; knobs only from presets.
    await w.send(code, sb, { t: 'settings', settings: { victoryPoints: 12 } });
    expect(errors(sb)).toContain('auth');
    await w.send(code, sa, { t: 'settings', settings: { preset: 'allHands' } });
    expect(room(sa).settings).toMatchObject({ preset: 'allHands', map: 'allHands', victoryPoints: 21 });
    expect(room(sa).settings.modules.length).toBeGreaterThan(5);
    await w.send(code, sa, { t: 'settings', settings: { knobs: { pollutionLimit: 2 } } });
    expect(errors(sa)).toContain('settings');
    await w.send(code, sa, { t: 'settings', settings: { preset: 'base', seats: 3 } });
    expect(room(sa).seats.length).toBe(3);
    await w.send(code, sa, { t: 'seatBot', seat: 2, difficulty: 'hard' });
    expect(room(sa).seats[2]).toMatchObject({ kind: 'bot', difficulty: 'hard' });
    // A kicked person can't come back.
    await w.send(code, sa, { t: 'kick', seat: 1 });
    expect(sb.closed?.code).toBe(4403);
    const again = await w.connect(code, { token: b.token });
    expect(again.closed?.code).toBe(4403);
    // A third joins; the host leaves; after a grace the next person hosts.
    const sc = await w.connect(code, { token: c.token });
    await w.send(code, sc, { t: 'claim', seat: 1 });
    sa.close(1001);
    await w.settle(code);
    await w.advance(code, HOST_GRACE_MS + 1000);
    expect(room(sc).host).not.toBe(a.user);
    expect(sc.inbox.some((m) => m.t === 'notice' && m.kind === 'hostChanged')).toBe(true);
  });

  it('the host’s duties pass on though the room sleeps through the grace, or a guest only comes later', async () => {
    // (Asleep: the room is rebuilt from storage and the sockets' carry before its alarm rings.)
    {
      const w = await new World(17).init();
      const a = await w.guest('Ann');
      const c = await w.guest('Cal');
      const code = await w.createRoom(a.token);
      const sa = await w.connect(code, { token: a.token });
      const sc = await w.connect(code, { token: c.token });
      await w.send(code, sc, { t: 'claim', seat: 1 });
      sa.close(1001);
      await w.settle(code);
      await w.advance(code, 3000);
      await w.evict(code);
      await w.advance(code, HOST_GRACE_MS + 1000);
      expect(room(sc).host).toBe(c.user);
      await w.send(code, sc, { t: 'start' });
      expect(errors(sc)).not.toContain('auth');
    }
    // A creator slow to connect isn't handed over before arriving, whoever comes first.
    {
      const w = await new World(19).init();
      const a = await w.guest('Ann');
      const c = await w.guest('Cal');
      const code = await w.createRoom(a.token);
      const sc = await w.connect(code, { token: c.token });
      await w.advance(code, HOST_GRACE_MS * 3);
      expect(room(sc).host).toBe(a.user);
    }
    // The host leaves a harbour nobody else is in; someone comes later, and hosts after the grace.
    {
      const w = await new World(18).init();
      const a = await w.guest('Ann');
      const c = await w.guest('Cal');
      const code = await w.createRoom(a.token);
      const sa = await w.connect(code, { token: a.token });
      await w.send(code, sa, { t: 'leave' });
      await w.settle(code);
      await w.advance(code, HOST_GRACE_MS + 1000);
      const sc = await w.connect(code, { token: c.token });
      await w.send(code, sc, { t: 'claim', seat: 0 });
      await w.advance(code, HOST_GRACE_MS + 1000);
      expect(room(sc).host).toBe(c.user);
    }
  });

  it('the host may sail without someone ready, once asked; a smaller table moves people up, and only a change to the game unreadies them', async () => {
    const w = await new World(16).init();
    const a = await w.guest('Ann');
    const b = await w.guest('Bea');
    const code = await w.createRoom(a.token);
    const sa = await w.connect(code, { token: a.token });
    const sb = await w.connect(code, { token: b.token });
    await w.send(code, sa, { t: 'claim', seat: 0 });
    // (Bea in the last seat, ready.)
    await w.send(code, sb, { t: 'claim', seat: 3 });
    await w.send(code, sb, { t: 'ready', on: true });
    // Three seats: Bea moves into one that stays, the first open one, and is asked to be ready again.
    await w.send(code, sa, { t: 'settings', settings: { seats: 3 } });
    expect(errors(sa)).toEqual([]);
    const bea = room(sb).seats.find((x) => x.kind === 'human' && x.name === 'Bea')!;
    expect(bea.seat).toBe(1);
    expect(bea.ready).toBeFalsy();
    expect(room(sb).seats).toHaveLength(3);
    // (Her socket follows her: she can still say she's ready, and changing her face keeps it.)
    await w.send(code, sb, { t: 'ready', on: true });
    await w.send(code, sb, { t: 'claim', seat: 1, avatar: 2 });
    expect(room(sb).seats[1]).toMatchObject({ ready: true, avatar: 2 });
    // The table's manners don't unready anyone; the game itself does.
    await w.send(code, sa, { t: 'settings', settings: { takeBacks: false, freeChat: false } });
    expect(room(sb).seats[1].ready).toBe(true);
    await w.send(code, sa, { t: 'settings', settings: { timer: 'brisk' } });
    expect(room(sb).seats[1].ready).toBeFalsy();
    // Not ready: asked plainly, refused; forced, it sails, with Bea in her seat.
    await w.send(code, sa, { t: 'start' });
    expect(errors(sa)).toContain('start');
    expect(room(sa).phase).toBe('harbour');
    await w.send(code, sa, { t: 'start', force: true });
    expect(room(sa).phase).toBe('playing');
    expect(room(sa).seats[1]).toMatchObject({ kind: 'human', name: 'Bea' });
  });

  it('a hand-off link moves a seat to another device, once', async () => {
    const w = await new World(6).init();
    const a = await w.guest('Ann');
    const code = await w.createRoom(a.token);
    const s1 = await w.connect(code, { token: a.token });
    await w.send(code, s1, { t: 'claim', seat: 0 });
    await w.send(code, s1, { t: 'handoff' });
    const token = last(s1, 'handoff')!.token;
    const other = await w.guest('Ann on her phone');
    const s2 = await w.connect(code, { token: other.token, seat: token });
    expect(last(s2, 'welcome')!.you.seat).toBe(0);
    expect(s1.closed?.code).toBe(4409);
    // Used once: the generation moved on.
    const third = await w.guest('Someone else');
    const s3 = await w.connect(code, { token: third.token, seat: token });
    expect(s3.closed?.code).toBe(4403);
  });

  it('an idle harbour closes, and its storage goes', async () => {
    const w = await new World(7).init();
    const a = await w.guest('Ann');
    const code = await w.createRoom(a.token);
    const s = await w.connect(code, { token: a.token });
    s.close(1000);
    await w.settle(code);
    await w.advance(code, HARBOUR_IDLE_MS + 1000);
    const rt = w.rooms.get(code)!.rt;
    expect(rt.deletes).toBe(1);
    expect((await w.fetch(code, 'card')).status).toBe(404);
  });

  it('concede ends a game nobody is left in, and "Sail again" invites the same seats', async () => {
    const w = await new World(8).init();
    const a = await w.guest('Ann');
    const code = await w.createRoom(a.token);
    const s = await w.connect(code, { token: a.token });
    await w.send(code, s, { t: 'claim', seat: 0 });
    await w.send(code, s, { t: 'start' });
    expect(s.inbox.some((m) => m.t === 'snap')).toBe(true);
    await w.send(code, s, { t: 'concede' });
    expect(room(s).phase).toBe('abandoned');
    expect(room(s).results!.standings.find((x) => x.seat === 0)!.conceded).toBe(true);
    expect(s.inbox.some((m) => m.t === 'reveal')).toBe(true);
    await w.send(code, s, { t: 'rematch' });
    const next = room(s).rematch!;
    expect(next).toMatch(ROOM_CODE_RE);
    expect(next).not.toBe(code);
    const card = await (await w.fetch(next, 'card')).json();
    expect(card.seats.map((x: { kind: string }) => x.kind)).toEqual(['human', 'bot', 'bot', 'bot']);
  });
});
