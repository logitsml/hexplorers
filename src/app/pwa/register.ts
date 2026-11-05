// The service worker (public/sw.js): its registration, the files it is asked to save, and
// updates. Loaded once the title is up (see start.ts).
//
// Updates. Every launch takes the page from the network (the worker only stands in when the
// network is slow or gone), so a release reaches a player the next time they open the game. A
// page left open for days (a phone keeps a Home Screen app) looks again as it comes back into
// view, at most every half hour: a new worker waiting, or a newer page on the server, puts up the
// "New version: Reload" note (ui/pwa), on the title only, never in a game. Unanswered, the new
// version is simply there at the next launch.

import { flushSettings, useUI } from '../../game/store';
import { usePwa } from './state';

/** How often a page left open looks for a new release, at most. */
const CHECK_EVERY_MS = 30 * 60 * 1000;
/** How long after the first game starts its files are listed to the worker again. */
const GAME_WARM_MS = 20000;

let registering: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Register the service worker, once: in a production build on a secure origin (https, or
 * localhost for `vite preview`). In development only with ?sw in the address (to try push
 * locally); without it, a worker left by an earlier ?sw is removed. ?nosw skips it for a visit.
 * Resolves with the registration, or null where there is none.
 */
export function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  registering ??= register().catch((e) => {
    console.warn('the service worker could not be registered', e);
    return null;
  });
  return registering;
}

async function register(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  const q = new URLSearchParams(location.search);
  if (q.has('nosw')) return null;
  if (!import.meta.env.PROD && !q.has('sw')) {
    await unregisterAll();
    return null;
  }
  if (await switchedOff()) {
    await unregisterAll();
    return null;
  }
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  watchUpdates(reg);
  void warmUp();
  return reg;
}

/**
 * The kill switch: an empty file public/sw-off, deployed, answers 200 and every page unregisters
 * its worker and drops its caches (the worker won't install meanwhile either). A page in its
 * place (the dev server's, or a future Worker's fallback to the game) doesn't count.
 */
async function switchedOff(): Promise<boolean> {
  try {
    const res = await fetch('/sw-off', { cache: 'no-store' });
    return res.status === 200 && !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

async function unregisterAll() {
  const regs = await navigator.serviceWorker.getRegistrations();
  if (!regs.length) return;
  await Promise.all(regs.map((r) => r.unregister()));
  for (const name of await caches.keys()) if (name.startsWith('exploratory-')) await caches.delete(name);
}

function watchUpdates(reg: ServiceWorkerRegistration) {
  // The note lives in a layer of its own, loaded the first time it has something to say.
  usePwa.subscribe((s, p) => {
    if (s.update && !p.update) void import('../../ui/pwa/layer').then((m) => m.mountPwaLayer());
  });
  // (The very first worker waits a moment too before it takes over: only one replacing another is an update.)
  const waiting = () => reg.waiting && navigator.serviceWorker.controller && flag('worker');
  waiting();
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => w.state === 'installed' && waiting());
  });
  // A page opened by the worker (a slow or failed network) may be an older release: it looks now.
  if (navigator.serviceWorker.controller) void newerPage().then((newer) => newer && flag('page'));
  let last = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || Date.now() - last < CHECK_EVERY_MS) return;
    last = Date.now();
    void checkForUpdate();
  });
}

const flag = (kind: 'worker' | 'page') => usePwa.setState((s) => ({ update: s.update ?? kind }));

/** Look for a new version now: a new worker, or a newer page on the server. */
export async function checkForUpdate(): Promise<void> {
  if (!navigator.onLine) return;
  const reg = await navigator.serviceWorker?.getRegistration();
  await reg?.update().catch(() => {});
  if (await newerPage()) flag('page');
}

/** Whether the server's page starts the game from another script than this page does (a release since). */
async function newerPage(): Promise<boolean> {
  const own = document.querySelector('script[type="module"][src]')?.getAttribute('src');
  if (!own?.startsWith('/assets/')) return false;
  try {
    const res = await fetch('/', { cache: 'no-cache' });
    if (!res.ok) return false;
    const theirs = /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(await res.text())?.[1];
    return !!theirs && theirs !== own;
  } catch {
    return false;
  }
}

/**
 * Take the new version: the waiting worker takes over and the page reloads (from the network,
 * see sw.js). From the note's Reload, so only ever between games.
 */
export async function applyUpdate(): Promise<void> {
  flushSettings();
  const waiting = (await navigator.serviceWorker?.getRegistration())?.waiting;
  if (!waiting) {
    location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  waiting.postMessage({ type: 'skip-waiting' });
  // (Should the change not come, the page reloads all the same.)
  setTimeout(() => location.reload(), 4000);
}

/**
 * The files the page has loaded, listed to the worker to save (those loaded before it looked
 * after the page come from the browser's cache: no network). The first list also has it fetch
 * the rest of the release's code, unless the device saves data. Again once the first game is
 * under way, for what that loaded.
 */
async function warmUp() {
  const reg = await navigator.serviceWorker.ready;
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const crawl = !conn?.saveData && !/2g/.test(conn?.effectiveType ?? '');
  reg.active?.postMessage({ type: 'warm', urls: loadedFiles(), crawl });
  const inGame = () => {
    stop();
    setTimeout(() => reg.active?.postMessage({ type: 'warm', urls: loadedFiles(), crawl: false }), GAME_WARM_MS);
  };
  const stop = useUI.subscribe((s) => s.screen === 'game' && inGame());
  if (useUI.getState().screen === 'game') inGame();
}

function loadedFiles(): string[] {
  const urls = new Set<string>();
  for (const e of performance.getEntriesByType('resource')) urls.add(e.name);
  for (const el of document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[href]')) urls.add('src' in el ? el.src : el.href);
  const mine = (u: string) => u.startsWith(`${location.origin}/assets/`) || u.startsWith(`${location.origin}/art/`);
  return [...urls].filter(mine);
}
