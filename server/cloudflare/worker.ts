// The Worker: room sockets to their Durable Object (idFromName(code)), the rest of /api and the
// link previews' cards (/og) to the shared router over D1 and R2, the game's own links (/r/CODE...)
// to the page (with that link's preview tags), and every other path to the site's own Worker
// (src/worker: the invitation and watch links' cards, the clip), which serves the static assets.
// A request to one of the game's former addresses (REDIRECT_HOSTS) moves to PUBLIC_URL's.

import { handleApi, roomSocket } from '../http/router';
import { META_PAGE, renderPage } from '../features/og';
import site from '../../src/worker';
import { workerServices } from './adapter';
import type { CfExecutionContext, WorkerEnv } from './types';

export { RoomDO } from './room-do';

/** The SPA's own routes: the page reads its path (see ARCHITECTURE.md, "Client links"). */
const PAGE = /^\/(r|w|replay|m|new|u)(\/|$)/;

/**
 * At a former address: its pages move to the same path at PUBLIC_URL's (301), and /sw-off
 * answers, so a copy of the game saved there unregisters its service worker (src/app/pwa). Its
 * /api stays, for a saved page still open there; its files are served without the Worker.
 */
export function moved(url: URL, env: WorkerEnv): Response | null {
  const from = (env.REDIRECT_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase());
  if (!from.includes(url.hostname.toLowerCase())) return null;
  if (url.pathname === '/sw-off') return new Response('off', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  if (url.pathname.startsWith('/api/')) return null;
  return Response.redirect(new URL(url.pathname + url.search, env.PUBLIC_URL).href, 301);
}

export default {
  async fetch(req: Request, env: WorkerEnv, _ctx: CfExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const away = moved(url, env);
    if (away) return away;
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/og/')) {
      if (!PAGE.test(url.pathname)) return site.fetch(req, env);
      const page = await env.ASSETS.fetch(new Request(new URL('/', url), req));
      if (!META_PAGE.test(url.pathname) || !page.ok) return page;
      const w = await workerServices(env);
      const html = await renderPage(url.pathname, await page.text(), { env: w.env, db: w.db, blobs: w.blobs, services: w.services, rooms: w.rooms, now: () => Date.now(), random: (n) => crypto.getRandomValues(new Uint8Array(n)) });
      const headers = new Headers(page.headers);
      for (const h of ['content-length', 'etag', 'content-encoding']) headers.delete(h);
      headers.set('cache-control', 'no-cache');
      return new Response(html, { status: 200, headers });
    }
    const { services, db, blobs, rooms, env: senv } = await workerServices(env);
    const sock = roomSocket(req, senv);
    if (sock instanceof Response) return sock;
    if (sock) {
      // (The upgrade goes on to the room as it came: the room accepts it there.)
      const headers = new Headers(req.headers);
      headers.set('x-room-code', sock.code);
      return env.ROOMS.get(env.ROOMS.idFromName(sock.code)).fetch(new Request(req, { headers }));
    }
    const ip = req.headers.get('cf-connecting-ip') ?? undefined;
    const r = await handleApi(req, { env: senv, db, blobs, services, rooms, now: () => Date.now(), random: (n) => crypto.getRandomValues(new Uint8Array(n)), ip });
    return r ?? new Response('{"error":"No such route."}', { status: 404, headers: { 'content-type': 'application/json' } });
  },

  /** The features' periodic work (the notes held through quiet hours), on a Cron Trigger: see README.md. */
  async scheduled(_event: unknown, env: WorkerEnv, ctx: CfExecutionContext): Promise<void> {
    const { services } = await workerServices(env);
    ctx.waitUntil(services.tick?.() ?? Promise.resolve());
  },
};
