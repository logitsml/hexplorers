import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePush, routeFor, type PushNote, type Route, type RouteRequest } from '../src/app/pwa/routes';
import { decodeVapidKey, PushError } from '../src/app/pwa/push';
import SW_CODE from '../public/sw.js?raw';

// The service worker (public/sw.js) is a plain script with its own copy of the rules in
// src/app/pwa/routes.ts: both copies run over the same cases here, and the worker itself runs
// against a stand-in for its global scope (self, caches, fetch, clients), its events dispatched
// by hand.

const ORIGIN = 'https://exploratory.test';

type Listener = (e: unknown) => void;

/** A Cache Storage in memory: entries by URL, in the order they were saved. */
class FakeCache {
  entries = new Map<string, Response>();
  key(req: string | { url: string }) {
    return new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
  }
  async match(req: string | { url: string }) {
    return this.entries.get(this.key(req))?.clone();
  }
  async put(req: string | { url: string }, res: Response) {
    const k = this.key(req);
    // (A put replaces the entry and moves it to the end, as the Cache API does.)
    const body = await res.arrayBuffer();
    this.entries.delete(k);
    this.entries.set(k, new Response(body, { status: res.status, headers: res.headers }));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(req: string | { url: string }) {
    return this.entries.delete(this.key(req));
  }
}

class FakeCaches {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

/** A response as the network gives it (a 'basic' one, which the worker keeps). */
function net(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const res = new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

/** The worker loaded into a stand-in global scope, with what it was given to call. */
function loadWorker() {
  const listeners = new Map<string, Listener[]>();
  const caches = new FakeCaches();
  const fetch = vi.fn(async (_req: unknown, _init?: unknown): Promise<Response> => {
    throw new TypeError('offline');
  });
  const windows: { url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }[] = [];
  const scope: Record<string, unknown> = {
    location: new URL('/sw.js', ORIGIN),
    registration: {
      navigationPreload: { enable: vi.fn(async () => {}) },
      showNotification: vi.fn(async () => {}),
    },
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  };
  // The script with `self`, `caches` and `fetch` given to it (the rest are this realm's own:
  // URL, Response, setTimeout), and its two rules handed back.
  const rules = new Function('self', 'caches', 'fetch', `${SW_CODE}\nreturn { routeFor, parsePush };`)(scope, caches, (req: unknown, init?: unknown) => fetch(req, init));
  Object.assign(scope, rules);
  /** Dispatch an event: what it was answered with, once everything it waits on has settled. */
  const dispatch = async (type: string, init: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const event = { ...init, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (response = p) };
    for (const fn of listeners.get(type) ?? []) fn(event);
    const res = response ? await response : undefined;
    // (What it waits on can add more waits as it goes.)
    for (let i = 0; i < waits.length; i++) await waits[i];
    return res;
  };
  const request = (path: string, mode = 'cors', extra: Record<string, unknown> = {}) => ({
    request: { url: new URL(path, ORIGIN).href, method: 'GET', mode, cache: 'default', headers: new Headers(), ...extra },
    preloadResponse: Promise.resolve(undefined),
  });
  const sw = scope as unknown as {
    routeFor: (r: RouteRequest, origin: string) => Route;
    parsePush: (t: string, origin: string) => PushNote;
    registration: { showNotification: ReturnType<typeof vi.fn>; navigationPreload: { enable: ReturnType<typeof vi.fn> } };
    clients: { claim: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn> };
    skipWaiting: ReturnType<typeof vi.fn>;
  };
  return { sw, caches, fetch, windows, dispatch, request };
}

const ROUTES: [RouteRequest, Route][] = [
  [{ url: `${ORIGIN}/`, method: 'GET', mode: 'navigate' }, 'shell'],
  [{ url: `${ORIGIN}/?go=/multi`, method: 'GET', mode: 'navigate' }, 'shell'],
  [{ url: `${ORIGIN}/index.html`, method: 'GET', mode: 'navigate' }, 'shell'],
  [{ url: `${ORIGIN}/r/ABCD`, method: 'GET', mode: 'navigate' }, 'link'],
  [{ url: `${ORIGIN}/w/ABCD`, method: 'GET', mode: 'navigate' }, 'link'],
  [{ url: `${ORIGIN}/social/thumb.jpg`, method: 'GET', mode: 'navigate' }, 'network'],
  [{ url: `${ORIGIN}/api/auth/callback?code=x`, method: 'GET', mode: 'navigate' }, 'network'],
  [{ url: `${ORIGIN}/api/config`, method: 'GET', mode: 'cors' }, 'pass'],
  [{ url: `${ORIGIN}/api`, method: 'GET', mode: 'cors' }, 'pass'],
  [{ url: `${ORIGIN}/og/r/ABCD.svg`, method: 'GET', mode: 'no-cors' }, 'pass'],
  [{ url: `${ORIGIN}/api/rooms`, method: 'POST', mode: 'cors' }, 'pass'],
  [{ url: `${ORIGIN}/assets/index-Df7goN7I.js`, method: 'GET', mode: 'cors' }, 'asset'],
  [{ url: `${ORIGIN}/assets/font.woff2`, method: 'GET', mode: 'cors', range: true }, 'pass'],
  [{ url: `${ORIGIN}/assets/x.js`, method: 'HEAD', mode: 'cors' }, 'pass'],
  [{ url: `${ORIGIN}/art/cards/wool.webp`, method: 'GET', mode: 'no-cors' }, 'art'],
  [{ url: `${ORIGIN}/`, method: 'GET', mode: 'cors' }, 'pass'],
  [{ url: `${ORIGIN}/sw.js`, method: 'GET', mode: 'same-origin' }, 'pass'],
  [{ url: `${ORIGIN}/sw-off`, method: 'GET', mode: 'cors' }, 'pass'],
  [{ url: `${ORIGIN}/manifest.webmanifest`, method: 'GET', mode: 'cors' }, 'pass'],
  [{ url: `${ORIGIN}/social/thumb.jpg`, method: 'GET', mode: 'no-cors' }, 'pass'],
  [{ url: 'https://fonts.example/assets/x.js', method: 'GET', mode: 'cors' }, 'pass'],
  [{ url: 'https://elsewhere.example/', method: 'GET', mode: 'navigate' }, 'pass'],
  [{ url: 'wss://exploratory.test/api/rooms/ABCD/ws', method: 'GET', mode: 'websocket' }, 'pass'],
  [{ url: 'not a url', method: 'GET', mode: 'cors' }, 'pass'],
  [{ url: `${ORIGIN}/apiary`, method: 'GET', mode: 'navigate' }, 'link'],
  [{ url: `${ORIGIN}/assetsx/a.js`, method: 'GET', mode: 'cors' }, 'pass'],
];

const PUSHES: [string, PushNote][] = [
  [
    JSON.stringify({ title: 'Your move on Marlow’s island', body: 'Wren built a city.', url: '/r/ABCD', tag: 'game:ABCD' }),
    { title: 'Your move on Marlow’s island', body: 'Wren built a city.', url: '/r/ABCD', tag: 'game:ABCD' },
  ],
  // Safari's declarative form.
  [
    JSON.stringify({ web_push: 8030, notification: { title: 'A seven!', body: 'Choose 4 cards to throw overboard.', navigate: `${ORIGIN}/r/WXYZ?d=1`, tag: 'g' } }),
    { title: 'A seven!', body: 'Choose 4 cards to throw overboard.', url: '/r/WXYZ?d=1', tag: 'g' },
  ],
  // Another site, or a script, as the link: the game's page instead.
  [JSON.stringify({ title: 'x', url: 'https://evil.example/x' }), { title: 'x', body: '', url: '/', tag: '' }],
  [JSON.stringify({ title: 'x', url: '//evil.example/x' }), { title: 'x', body: '', url: '/', tag: '' }],
  [JSON.stringify({ title: 'x', url: 'javascript:alert(1)' }), { title: 'x', body: '', url: '/', tag: '' }],
  // Plain text, nothing, or the wrong kinds: something to show all the same.
  ['Your move.', { title: 'Hexplorers', body: 'Your move.', url: '/', tag: '' }],
  ['', { title: 'Hexplorers', body: '', url: '/', tag: '' }],
  ['42', { title: 'Hexplorers', body: '42', url: '/', tag: '' }],
  [JSON.stringify({ title: 7, body: ['a'], tag: {} }), { title: 'Hexplorers', body: '', url: '/', tag: '' }],
  [JSON.stringify({ title: '  ' }), { title: 'Hexplorers', body: '', url: '/', tag: '' }],
  [JSON.stringify({ title: 'T'.repeat(500), body: 'B'.repeat(2000), tag: 'g'.repeat(200) }), { title: 'T'.repeat(120), body: 'B'.repeat(480), url: '/', tag: 'g'.repeat(64) }],
];

describe('the service worker’s rules', () => {
  const { sw } = loadWorker();
  it.each(ROUTES)('routes %o to %s (both copies)', (req, route) => {
    expect(routeFor(req, ORIGIN)).toBe(route);
    expect(sw.routeFor(req, ORIGIN)).toBe(route);
  });
  it.each(PUSHES)('reads the push %s (both copies)', (text, note) => {
    expect(parsePush(text, ORIGIN)).toEqual(note);
    expect({ ...sw.parsePush(text, ORIGIN) }).toEqual(note);
  });
});

describe('the service worker', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('installs with the page and the notification icons, and not while switched off', async () => {
    const w = loadWorker();
    w.fetch.mockImplementation(async (req) => (String(req) === '/sw-off' ? net('', { status: 404 }) : net(`file ${String(req)}`, { headers: { 'content-type': 'text/html' } })));
    await w.dispatch('install');
    const shell = await w.caches.open('exploratory-shell-v1');
    expect([...shell.entries.keys()].sort()).toEqual([`${ORIGIN}/`, `${ORIGIN}/badge-96.png`, `${ORIGIN}/icon-192.png`]);

    const off = loadWorker();
    off.fetch.mockImplementation(async () => net('off'));
    await expect(off.dispatch('install')).rejects.toThrow(/switched off/);

    // (A server that answers every path with the game's page hasn't switched it off.)
    const spa = loadWorker();
    spa.fetch.mockImplementation(async () => net('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    await spa.dispatch('install');
  });

  it('keeps the page saved by a launch when a new worker installs', async () => {
    const w = loadWorker();
    const shell = await w.caches.open('exploratory-shell-v1');
    await shell.put('/', net('release 1'));
    w.fetch.mockImplementation(async (req) => (String(req) === '/sw-off' ? net('', { status: 404 }) : net('release 2')));
    await w.dispatch('install');
    expect(await (await shell.match('/'))!.text()).toBe('release 1');
  });

  it('drops other versions’ caches as it takes over, and looks after the open pages', async () => {
    const w = loadWorker();
    await w.caches.open('exploratory-assets-v0');
    await w.caches.open('exploratory-assets-v1');
    await w.caches.open('someone-elses');
    await w.dispatch('activate');
    expect(await w.caches.keys()).toEqual(['exploratory-assets-v1', 'someone-elses']);
    expect(w.sw.clients.claim).toHaveBeenCalled();
    expect(w.sw.registration.navigationPreload.enable).toHaveBeenCalled();
  });

  it('serves built files from the cache once fetched, and leaves /api alone', async () => {
    const w = loadWorker();
    w.fetch.mockImplementation(async () => net('chunk'));
    const first = await w.dispatch('fetch', w.request('/assets/App-x.js'));
    expect(await first!.text()).toBe('chunk');
    w.fetch.mockClear();
    w.fetch.mockImplementation(async () => {
      throw new TypeError('offline');
    });
    const again = await w.dispatch('fetch', w.request('/assets/App-x.js'));
    expect(await again!.text()).toBe('chunk');
    expect(w.fetch).not.toHaveBeenCalled();
    expect(await w.dispatch('fetch', w.request('/api/config'))).toBeUndefined();
    // (A failed answer isn't kept.)
    w.fetch.mockImplementation(async () => net('missing', { status: 404 }));
    expect((await w.dispatch('fetch', w.request('/assets/gone.js')))!.status).toBe(404);
    expect((await w.caches.open('exploratory-assets-v1')).entries.has(`${ORIGIN}/assets/gone.js`)).toBe(false);
  });

  it('answers art from the cache and saves the network’s copy behind it when it changed', async () => {
    const w = loadWorker();
    const art = await w.caches.open('exploratory-art-v1');
    await art.put('/art/wool.webp', net('old', { headers: { etag: '"1"' } }));
    w.fetch.mockImplementation(async () => net('new', { headers: { etag: '"2"' } }));
    const res = await w.dispatch('fetch', w.request('/art/wool.webp', 'no-cors'));
    expect(await res!.text()).toBe('old');
    expect(await (await art.match('/art/wool.webp'))!.text()).toBe('new');
    // Checked once a launch.
    w.fetch.mockClear();
    await w.dispatch('fetch', w.request('/art/wool.webp', 'no-cors'));
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('opens the page from the network and saves it; offline, slow or failing, the saved one', async () => {
    const w = loadWorker();
    const html = { 'content-type': 'text/html; charset=utf-8' };
    w.fetch.mockImplementation(async () => net('release 2', { headers: html }));
    expect(await (await w.dispatch('fetch', w.request('/', 'navigate')))!.text()).toBe('release 2');
    const shell = await w.caches.open('exploratory-shell-v1');
    expect(await (await shell.match('/'))!.text()).toBe('release 2');

    w.fetch.mockImplementation(async () => {
      throw new TypeError('offline');
    });
    expect(await (await w.dispatch('fetch', w.request('/?go=/multi', 'navigate')))!.text()).toBe('release 2');

    w.fetch.mockImplementation(async () => net('down', { status: 503, headers: html }));
    expect(await (await w.dispatch('fetch', w.request('/', 'navigate')))!.text()).toBe('release 2');

    // Too slow: the saved page after the timeout, and the late answer isn't saved over it.
    vi.useFakeTimers();
    let arrive: (r: Response) => void = () => {};
    w.fetch.mockImplementation(() => new Promise<Response>((r) => (arrive = r)));
    const slow = w.dispatch('fetch', w.request('/', 'navigate'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await (await slow)!.text()).toBe('release 2');
    arrive(net('release 3', { headers: html }));
    await vi.runAllTimersAsync();
    expect(await (await shell.match('/'))!.text()).toBe('release 2');

    // A reload waits for the network.
    w.fetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return net('release 3', { headers: html });
    });
    const reload = w.dispatch('fetch', w.request('/', 'navigate', { cache: 'no-cache' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await (await reload)!.text()).toBe('release 3');
  });

  it('uses the request made while it started up, and makes no second one', async () => {
    const w = loadWorker();
    const ev = { ...w.request('/api/auth/callback?code=1', 'navigate'), preloadResponse: Promise.resolve(net('signed in')) };
    expect(await (await w.dispatch('fetch', ev))!.text()).toBe('signed in');
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('sends a link opened offline to the game’s page with ?go=', async () => {
    const w = loadWorker();
    const res = await w.dispatch('fetch', w.request('/r/ABCD?x=1', 'navigate'));
    expect(res!.status).toBe(302);
    expect(res!.headers.get('location')).toBe(`${ORIGIN}/?go=${encodeURIComponent('/r/ABCD?x=1')}`);
    w.fetch.mockImplementation(async () => net('not on the chart', { status: 404 }));
    expect((await w.dispatch('fetch', w.request('/r/ABCD', 'navigate')))!.status).toBe(404);
  });

  it('saves what the page loaded and every chunk it can load, and clears out old releases', async () => {
    const w = loadWorker();
    const files: Record<string, string> = {
      '/assets/index-a.js': 'import("./App-b.js");const d=["assets/Rules-c.js","assets/App-b.css"]',
      '/assets/App-b.js': 'import{x}from"./three-d.js";new URL("/assets/worker-e.js",import.meta.url)',
      '/assets/Rules-c.js': 'export const r=1',
      '/assets/App-b.css': '.a{}',
      '/assets/three-d.js': 'export const x=1',
      '/assets/worker-e.js': 'x',
      '/art/wool.webp': 'wool',
    };
    w.fetch.mockImplementation(async (req) => {
      const path = new URL(String(req), ORIGIN).pathname;
      return path in files ? net(files[path]) : net('', { status: 404 });
    });
    const assets = await w.caches.open('exploratory-assets-v1');
    for (let i = 0; i < 45; i++) await assets.put(`/assets/old-${i}.js`, net('old'));
    await w.dispatch('message', { data: { type: 'warm', urls: [`${ORIGIN}/assets/index-a.js`, `${ORIGIN}/art/wool.webp`, 'https://elsewhere.example/x.js', 42], crawl: true } });
    const saved = [...assets.entries.keys()];
    for (const f of Object.keys(files).filter((f) => f.startsWith('/assets/'))) expect(saved).toContain(`${ORIGIN}${f}`);
    expect((await w.caches.open('exploratory-art-v1')).entries.has(`${ORIGIN}/art/wool.webp`)).toBe(true);
    // The newest 40 of the old ones stay, for a page of the release before still open.
    expect(saved.filter((u) => u.includes('/old-'))).toHaveLength(40);
    expect(saved).not.toContain(`${ORIGIN}/assets/old-0.js`);
    expect(w.fetch.mock.calls.some(([req]) => String(req).includes('elsewhere'))).toBe(false);
  });

  it('takes over only when the page asks', async () => {
    const w = loadWorker();
    await w.dispatch('message', { data: { type: 'warm?' } });
    expect(w.sw.skipWaiting).not.toHaveBeenCalled();
    await w.dispatch('message', { data: { type: 'skip-waiting' } });
    expect(w.sw.skipWaiting).toHaveBeenCalled();
  });

  it('shows a push as a notification with the icon, badge and tag', async () => {
    const w = loadWorker();
    const data = { text: () => JSON.stringify({ title: 'Your move', body: 'Wren built a city.', url: '/r/ABCD', tag: 'game:ABCD' }) };
    await w.dispatch('push', { data });
    expect(w.sw.registration.showNotification).toHaveBeenCalledWith('Your move', {
      body: 'Wren built a city.',
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      tag: 'game:ABCD',
      renotify: true,
      data: { url: '/r/ABCD' },
    });
    // No data at all: still a note (iOS takes push away from a site that shows nothing).
    await w.dispatch('push', {});
    expect(w.sw.registration.showNotification).toHaveBeenLastCalledWith('Hexplorers', { body: '', icon: '/icon-192.png', badge: '/badge-96.png', data: { url: '/' } });
  });

  it('brings forward a window on the notification’s page, or opens one', async () => {
    const w = loadWorker();
    const close = vi.fn();
    const win = { url: `${ORIGIN}/?go=/r/ABCD`, focus: vi.fn(async () => win), postMessage: vi.fn() };
    w.windows.push({ url: `${ORIGIN}/`, focus: vi.fn(), postMessage: vi.fn() }, win);
    await w.dispatch('notificationclick', { notification: { close, data: { url: '/r/ABCD' } } });
    expect(close).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.postMessage).toHaveBeenCalledWith({ type: 'pwa:open', url: '/r/ABCD' });
    expect(w.sw.clients.openWindow).not.toHaveBeenCalled();
    await w.dispatch('notificationclick', { notification: { close, data: { url: '/v/OTHER' } } });
    expect(w.sw.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/v/OTHER`);
  });
});

describe('push and install, in the page', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads a VAPID public key, and refuses what isn’t one', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const b64url = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect([...decodeVapidKey(b64url)]).toEqual([...raw]);
    expect([...decodeVapidKey(` ${b64url}== `)]).toEqual([...raw]);
    for (const bad of ['', 'not base64!', b64url.slice(0, 40), btoa('x'.repeat(65))]) {
      expect(() => decodeVapidKey(bad)).toThrow(PushError);
      try {
        decodeVapidKey(bad);
      } catch (e) {
        expect((e as PushError).code).toBe('bad-key');
      }
    }
  });
});
