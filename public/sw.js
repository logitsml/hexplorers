// Hexplorers' service worker, written by hand (no library): it lets the game open offline for
// solo play against the crew, and it shows push notifications (a friend's request or invitation,
// "your move" at a live table you left). It is registered once the title is up
// (src/app/pwa/register.ts), never during the first load.
//
// Each request (routeFor below):
// - the game's page (a navigation to /): the network's, waited for up to NAV_TIMEOUT; a page that
//   doesn't come in that time, or at all (offline, a server error), is the copy saved by the last
//   launch that got one. So a release reaches everyone at their next launch, as it did before.
// - /assets/*: the built files, named by a hash of their content, so a saved copy is good for
//   ever: the saved copy, else the network's (saved). A page still open from an older release
//   finds its own files, and old ones are cleared out behind the release in use (prune).
// - /art/*: the cards and pictures, which keep their names: the saved copy at once, and the
//   network's answer saved behind it for next time (stale-while-revalidate).
// - one of the game's links (/r/CODE): the network's answer; offline, the game's page with
//   ?go=<link>, as the 404 page sends them online.
// - /api/*, /og/* and anything else: left to the browser and never saved (where the browser
//   allows, /api and /og skip the worker altogether). WebSockets never pass through a worker.
//
// Updates: a new worker waits until the page asks it to take over (its "New version: Reload"
// note, shown only between games) or until every window of the old one has closed. Kill switch:
// while /sw-off answers 200 no worker installs, and the page unregisters any it finds.
'use strict';

/** The caches' layout: a worker of a new version drops every cache of the old one as it takes over. */
const VERSION = 1;
const SHELL = `exploratory-shell-v${VERSION}`;
const ASSETS = `exploratory-assets-v${VERSION}`;
const ART = `exploratory-art-v${VERSION}`;
/** How long the game's page waits for the network before the saved copy opens instead (ms). */
const NAV_TIMEOUT = 3000;
/** What the offline page and the notifications need beyond the built files, saved at install. */
const SHELL_FILES = ['/', '/icon-192.png', '/badge-96.png'];
/** Built files kept besides the release in use, the newest: an older page still open (another tab) finds its own. */
const KEEP_OLD = 40;

// ------------------------------------------------------------------------------------- the rules
// A copy of src/app/pwa/routes.ts (tests/pwa.test.ts runs both over the same cases).

function routeFor(req, origin) {
  if (req.method !== 'GET' || req.range) return 'pass';
  let u;
  try {
    u = new URL(req.url);
  } catch {
    return 'pass';
  }
  if (u.origin !== origin) return 'pass';
  const path = u.pathname;
  const nav = req.mode === 'navigate';
  if (/^\/(api|og)(\/|$)/.test(path)) return nav ? 'network' : 'pass';
  if (nav) return path === '/' || path === '/index.html' ? 'shell' : /\.[a-z0-9]+$/i.test(path) ? 'network' : 'link';
  if (path.startsWith('/assets/')) return 'asset';
  if (path.startsWith('/art/')) return 'art';
  return 'pass';
}

function parsePush(text, origin) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // (Plain text: the body.)
  }
  if (!data || typeof data !== 'object') data = { body: text };
  let d = data;
  const n = d.notification;
  if (d.web_push === 8030 && n && typeof n === 'object') d = { ...n, url: n.navigate };
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  let url = '/';
  try {
    const u = new URL(typeof d.url === 'string' ? d.url : '/', origin);
    if (u.origin === origin) url = u.pathname + u.search + u.hash;
  } catch {
    // (Not a URL: the game's page.)
  }
  return {
    title: str(d.title, 120) || 'Hexplorers',
    body: str(d.body, 480),
    url,
    tag: str(d.tag, 64),
  };
}

// ------------------------------------------------------------------------------- the life cycle

self.addEventListener('install', (event) => {
  // The server's own routes skip the worker altogether where the browser can be told so (static
  // routing, Chrome and Safari 27): not even started up for them.
  if (typeof event.addRoutes === 'function') {
    event.waitUntil(
      Promise.resolve()
        .then(() => event.addRoutes([{ condition: { urlPattern: '/api/*' }, source: 'network' }, { condition: { urlPattern: '/og/*' }, source: 'network' }]))
        .catch(() => {}),
    );
  }
  event.waitUntil(install());
});

async function install() {
  if (await switchedOff()) throw new Error('the service worker is switched off (/sw-off)');
  const cache = await caches.open(SHELL);
  // The page is saved here only the first time: after that only a launch saves it (the page it
  // opened), so the copy saved is always one whose built files are saved too. (A worker updated
  // while an older page is open would otherwise save a page whose files nobody has fetched.)
  const have = await cache.match('/');
  await Promise.all(SHELL_FILES.filter((f) => f !== '/' || !have).map((f) => save(cache, f, { cache: 'no-cache' })));
}

/** The kill switch: /sw-off answering 200 (with a page in its place, a fallback to the game's, it isn't there). */
async function switchedOff() {
  try {
    const res = await fetch('/sw-off', { cache: 'no-store' });
    return res.status === 200 && !(res.headers.get('content-type') || '').includes('text/html');
  } catch {
    return false;
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL, ASSETS, ART];
      for (const name of await caches.keys()) if (name.startsWith('exploratory-') && !keep.includes(name)) await caches.delete(name);
      // The page's request goes out while the worker starts up (on a phone that can take a while), not after.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
      // The page that registered the worker (a first visit) is looked after from now on, so what
      // it loads next (a game's parts) is saved too.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'skip-waiting') self.skipWaiting();
  else if (m.type === 'warm' && Array.isArray(m.urls)) event.waitUntil(warm(m.urls.slice(0, 600), m.crawl === true));
});

// ----------------------------------------------------------------------------------- requests

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const route = routeFor({ url: req.url, method: req.method, mode: req.mode, range: req.headers.has('range') }, self.location.origin);
  if (route === 'pass') return;
  const handle = route === 'asset' ? asset : route === 'art' ? art : route === 'shell' ? shell : route === 'link' ? link : navNetwork;
  event.respondWith(handle(event));
});

/** A whole answer that can be kept: not an error, a part, a redirect or another site's. */
const keepable = (res) => res.status === 200 && res.type === 'basic' && !res.redirected;
const wait = (ms) => new Promise((r) => setTimeout(r, ms, null));

/**
 * A navigation's answer from the network: the request made while the worker started up (the
 * navigation preload), or a new one. Always this one request: the browser makes no second one
 * behind it, which an /api link (a sign-in's return) must not get.
 */
function navNetwork(event) {
  return Promise.resolve(event.preloadResponse).then((r) => r || fetch(event.request));
}

async function shell(event) {
  const network = navNetwork(event);
  const cache = await caches.open(SHELL);
  const saved = await cache.match('/');
  // A reload asks for the newest page (the "New version" note's Reload among them): no timeout then.
  const reload = event.request.cache === 'reload' || event.request.cache === 'no-cache';
  const res = await (saved && !reload ? Promise.race([network.catch(() => null), wait(NAV_TIMEOUT)]) : network.catch(() => null));
  if (res && !(saved && res.status >= 500)) {
    if (keepable(res) && (res.headers.get('content-type') || '').includes('text/html')) event.waitUntil(cache.put('/', res.clone()).catch(() => {}));
    return res;
  }
  // (Too slow, offline or the server failing: the page saved last time, and the late answer, if
  // any, isn't saved over it, since its files may not be.)
  return saved || network;
}

async function link(event) {
  try {
    return await navNetwork(event);
  } catch {
    const u = new URL(event.request.url);
    return Response.redirect(new URL(`/?go=${encodeURIComponent(u.pathname + u.search)}`, self.location.origin).href, 302);
  }
}

async function asset(event) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(event.request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(event.request);
  if (keepable(res)) event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
  return res;
}

/** The art looked at again this time the worker is running (each is checked once a launch). */
const checked = new Set();

async function art(event) {
  const cache = await caches.open(ART);
  const hit = await cache.match(event.request, { ignoreVary: true });
  if (!hit) {
    const res = await fetch(event.request);
    if (keepable(res)) event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
    return res;
  }
  if (!checked.has(event.request.url)) {
    checked.add(event.request.url);
    event.waitUntil(refresh(cache, event.request, hit));
  }
  return hit;
}

/** The network's copy of a saved file, saved over it if it changed (the browser's cache mostly answers: art keeps a week). */
async function refresh(cache, request, old) {
  try {
    const res = await fetch(request);
    if (!keepable(res)) return;
    const tag = res.headers.get('etag');
    if (tag && tag === old.headers.get('etag')) {
      await res.body?.cancel();
      return;
    }
    await cache.put(request, res);
  } catch {
    // (Offline: the saved copy stays.)
  }
}

/** Save a file unless it is saved already: whether it is saved now. */
async function save(cache, url, init) {
  if (await cache.match(url, { ignoreVary: true })) return true;
  try {
    const res = await fetch(url, init);
    if (!keepable(res)) return false;
    await cache.put(url, res);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- saving what a page loaded

let warming = Promise.resolve();

/**
 * The files the page has loaded (it sends the list once it has settled), saved: those it loaded
 * before the worker looked after it are in the browser's cache, so saving them costs no network.
 * With `crawl`, every other chunk the release can load (the rules, the editor, an expansion not
 * played yet) is fetched too, one at a time and at low priority, so all of solo play opens
 * offline; then built files of older releases are cleared out.
 */
function warm(urls, crawl) {
  warming = warming.then(() => warmNow(urls, crawl)).catch(() => {});
  return warming;
}

async function warmNow(urls, crawl) {
  const origin = self.location.origin;
  const [assets, art] = await Promise.all([caches.open(ASSETS), caches.open(ART)]);
  const inUse = new Set();
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    const route = routeFor({ url: raw, method: 'GET', mode: 'cors' }, origin);
    if (route !== 'asset' && route !== 'art') continue;
    const url = new URL(raw);
    url.hash = '';
    if (route === 'asset') inUse.add(url.href);
    await save(route === 'asset' ? assets : art, url.href);
  }
  if (!crawl) return prune(assets, inUse, KEEP_OLD * 4);
  // Vite names the chunks a chunk loads in its imports ("./App-x.js") and its preload lists
  // ("assets/App-x.js").
  const queue = [...inUse].filter((u) => u.endsWith('.js'));
  for (let i = 0; i < queue.length && inUse.size < 400; i++) {
    const res = await assets.match(queue[i], { ignoreVary: true });
    if (!res) continue;
    const code = await res.text();
    for (const m of code.matchAll(/["'`](?:\.\/|\/?assets\/)([\w.-]+\.(?:js|css))["'`]/g)) {
      const url = new URL(`/assets/${m[1]}`, origin).href;
      if (inUse.has(url)) continue;
      inUse.add(url);
      if ((await save(assets, url, { priority: 'low' })) && url.endsWith('.js')) queue.push(url);
    }
  }
  await prune(assets, inUse, KEEP_OLD);
}

/** Built files not in use, all but the `spare` saved last (the cache lists them oldest first). */
async function prune(cache, inUse, spare) {
  const old = (await cache.keys()).filter((r) => !inUse.has(r.url));
  await Promise.all(old.slice(0, Math.max(0, old.length - spare)).map((r) => cache.delete(r)));
}

// ------------------------------------------------------------------------------------- push

self.addEventListener('push', (event) => {
  let text = '';
  try {
    text = event.data ? event.data.text() : '';
  } catch {
    // (Unreadable: a note with the defaults all the same.)
  }
  const note = parsePush(text, self.location.origin);
  const shown = self.registration.showNotification(note.title, {
    body: note.body,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    // One per game and moment: a newer one replaces it, and still sounds (renotify).
    ...(note.tag && { tag: note.tag, renotify: true }),
    data: { url: note.url },
  });
  event.waitUntil(shown);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = new URL((data && typeof data.url === 'string' && data.url) || '/', self.location.origin);
  event.waitUntil(openOrFocus(target));
});

/** A window already on the notification's page is brought forward (and told), else one opens there. */
async function openOrFocus(target) {
  const path = target.pathname + target.search;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const same = windows.find((c) => {
    const u = new URL(c.url);
    // (The 404 page sends a link on to /?go=<link>: the same place.)
    return u.origin === target.origin && (u.pathname + u.search === path || (u.pathname === '/' && u.searchParams.get('go') === path));
  });
  if (!same) return self.clients.openWindow ? self.clients.openWindow(target.href) : undefined;
  const focused = await same.focus().catch(() => same);
  (focused || same).postMessage({ type: 'pwa:open', url: path + target.hash });
}

// A subscription the browser renewed by itself: the open pages are told, so the online client
// can pass the new one to the server (one with no page open is renewed at the next launch).
self.addEventListener('pushsubscriptionchange', (event) => {
  const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
  event.waitUntil(
    (async () => {
      const sub = event.newSubscription || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(() => null) : null);
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of windows) c.postMessage({ type: 'pwa:subscription', subscription: sub ? sub.toJSON() : null, old: event.oldSubscription ? event.oldSubscription.toJSON() : null });
    })(),
  );
});
