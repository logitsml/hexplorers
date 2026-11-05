import { describe, expect, it } from 'vitest';
import { cleanName, ensureGuest, forgetIdentity, loadIdentity, loadProfile, sailorName, saveIdentity, saveProfile, type KeyStore } from '../../src/online/identity';
import { codeInput, linkFrom, normalizeCode, roomPath, spacedCode } from '../../src/online/links';
import { fetchConfig, socketUrl } from '../../src/online/api';
import { PROTO, type ServerConfig } from '../../src/net/protocol';

/** Storage as a Map, the way a browser's localStorage behaves for these calls. */
function memory(init: Record<string, string> = {}): KeyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

/** A fetch that answers from a table of routes. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response('<!doctype html><p>Not on the chart</p>', { status: 404, headers: { 'content-type': 'text/html' } });
    return r(init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

describe('online identity', () => {
  it('keeps a guest identity, and forgets one that isn’t whole', () => {
    const store = memory();
    expect(loadIdentity(store)).toBeNull();
    saveIdentity({ user: 'g_1', token: 'secret-token', name: 'Ana', guest: true }, store);
    expect(loadIdentity(store)).toEqual({ user: 'g_1', token: 'secret-token', name: 'Ana', guest: true });
    forgetIdentity(store);
    expect(loadIdentity(store)).toBeNull();
    for (const bad of ['{', 'null', '{"user":"g"}', '{"token":"t"}', '{"user":"","token":"t"}']) {
      expect(loadIdentity(memory({ 'exploratory.online.identity': bad }))).toBeNull();
    }
  });

  it('comes aboard with the singleplayer page’s name, colour and avatar', () => {
    const store = memory({ 'exploratory.name': '  Ana   Lima ', 'exploratory.setup': JSON.stringify({ color: 'teal', avatar: -3, opponents: 3 }) });
    expect(loadProfile(store)).toEqual({ name: 'Ana Lima', color: 'teal', avatar: -3 });
    // The default "You" gets a sailor's name; a broken set-up the defaults.
    const fresh = loadProfile(memory({ 'exploratory.name': 'You', 'exploratory.setup': '{oops' }), () => 0);
    expect(fresh).toEqual({ name: 'Amber Gannet', color: 'red', avatar: -1 });
    expect(loadProfile(memory({ 'exploratory.setup': JSON.stringify({ color: 'url(evil)', avatar: 99 }) }), () => 0.99)).toEqual({ name: sailorName(() => 0.99), color: 'red', avatar: -1 });
    expect(loadProfile(memory({ 'exploratory.setup': JSON.stringify({ color: '#3AA36B', avatar: 2 }) })).color).toBe('#3AA36B');
  });

  it('saves a changed face into the singleplayer page’s own keys, keeping its other choices', () => {
    const store = memory({ 'exploratory.setup': JSON.stringify({ color: 'red', avatar: -1, opponents: 2, expansions: ['sea'] }) });
    saveProfile({ name: 'Wren', color: 'blue', avatar: 1 }, store);
    expect(store.data.get('exploratory.name')).toBe('Wren');
    expect(JSON.parse(store.data.get('exploratory.setup')!)).toEqual({ color: 'blue', avatar: 1, opponents: 2, expansions: ['sea'] });
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
  });

  it('makes a guest once, and uses the kept one after', async () => {
    const store = memory();
    const { f, calls } = fakeFetch({ '/api/guest': () => json({ user: 'g_9', token: 'tok-9', name: 'Ana' }) });
    const id = await ensureGuest('Ana', { f, store });
    expect(id).toEqual({ user: 'g_9', token: 'tok-9', name: 'Ana', guest: true });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: 'Ana' });
    expect(await ensureGuest('Someone else', { f, store })).toEqual(id);
    expect(calls).toHaveLength(1);
  });

  it('works without storage at all (a private window that refuses it)', async () => {
    const refusing: KeyStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadIdentity(refusing)).toBeNull();
    expect(loadProfile(refusing, () => 0).name).toBe('Amber Gannet');
    const { f } = fakeFetch({ '/api/guest': () => json({ user: 'g', token: 't', name: 'A' }) });
    expect((await ensureGuest('A', { f, store: refusing })).token).toBe('t');
  });

  it('keeps one guest for a visit when storage refuses it', async () => {
    const deny = () => {
      throw new Error('denied');
    };
    const refusing: KeyStore = { getItem: deny, setItem: deny, removeItem: deny };
    let n = 0;
    const { f, calls } = fakeFetch({ '/api/guest': () => json({ user: `g${++n}`, token: `t${n}`, name: 'A' }) });
    const first = await ensureGuest('A', { f, store: refusing });
    const second = await ensureGuest('A', { f, store: refusing });
    const third = await ensureGuest('A', { f, store: null });
    const fourth = await ensureGuest('A', { f, store: null });
    expect(second).toEqual(first);
    expect(fourth).toEqual(third);
    expect(calls).toHaveLength(2);
    forgetIdentity(refusing);
    expect(loadIdentity(refusing)).toBeNull();
  });
});

describe('online config', () => {
  const config: ServerConfig = {
    proto: PROTO,
    build: 'dev',
    features: { online: true, guests: true, passkeys: false, google: false, apple: false, discord: false, email: false, push: false, turnstile: false, og: false },
  };

  it('says why online play isn’t offered: no server, switched off, or a newer protocol', async () => {
    expect(await fetchConfig({ f: fakeFetch({}).f })).toEqual({ ok: false, why: 'offline' });
    expect(await fetchConfig({ f: fakeFetch({ '/api/config': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) }).f })).toEqual({ ok: false, why: 'offline' });
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await fetchConfig({ f: down })).toEqual({ ok: false, why: 'offline' });
    expect(await fetchConfig({ f: fakeFetch({ '/api/config': () => json({ ...config, features: { ...config.features, online: false } }) }).f })).toEqual({ ok: false, why: 'off' });
    expect(await fetchConfig({ f: fakeFetch({ '/api/config': () => json({ ...config, proto: PROTO + 1 }) }).f })).toEqual({ ok: false, why: 'upgrade' });
    expect(await fetchConfig({ f: fakeFetch({ '/api/config': () => json(config) }).f })).toEqual({ ok: true, config });
  });

  it('gives up on a server that doesn’t answer in time', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    // (A server that's there but slow: the page says so, and asks again.)
    expect(await fetchConfig({ f: hang, timeout: 20 })).toEqual({ ok: false, why: 'error' });
  });
});

describe('room links', () => {
  it('reads /r/CODE, /w/CODE, the 404 page’s ?go= and a seat in the fragment', () => {
    expect(linkFrom({ pathname: '/r/KQ7M4P', search: '', hash: '' })).toEqual({ code: 'KQ7M4P', watch: false });
    expect(linkFrom({ pathname: '/w/kq7-m4p', search: '', hash: '' })).toEqual({ code: 'KQ7M4P', watch: true });
    expect(linkFrom({ pathname: '/', search: '?go=%2Fr%2FBCDFGH', hash: '#seat=abcdefgh_123' })).toEqual({ code: 'BCDFGH', watch: false, seat: 'abcdefgh_123' });
    expect(linkFrom({ pathname: '/', search: '', hash: '' })).toBeNull();
    // Not a code (a vowel, a zero, too short), or not a room path.
    for (const p of ['/r/KQ7M4A', '/r/KQ0M4P', '/r/KQ7M4', '/x/KQ7M4P', '/r/KQ7M4P/extra']) expect(linkFrom({ pathname: p, search: '', hash: '' })).toBeNull();
    // A seat token that isn't one is left out.
    expect(linkFrom({ pathname: '/r/KQ7M4P', search: '', hash: '#seat=<script>' })).toEqual({ code: 'KQ7M4P', watch: false });
  });

  it('takes codes as typed', () => {
    expect(codeInput('kq7 m4p')).toBe('KQ7M4P');
    expect(codeInput('a0o1kq7m4pzz')).toBe('KQ7M4P');
    expect(normalizeCode('kq7-m4p')).toBe('KQ7M4P');
    expect(spacedCode('KQ7M4P')).toBe('KQ7 M4P');
    expect(roomPath('KQ7M4P', true)).toBe('/w/KQ7M4P');
    expect(socketUrl('KQ7M4P', { protocol: 'https:', host: 'hexplorers.xyz' })).toBe('wss://hexplorers.xyz/api/rooms/KQ7M4P/ws');
    expect(socketUrl('KQ7M4P', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/rooms/KQ7M4P/ws');
  });
});
