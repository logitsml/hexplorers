// What the service worker (public/sw.js) does with each request, and how it reads a push
// message: the rules as plain functions, for the tests. The worker carries its own copy of each
// (it is a plain script, served as it is, with nothing to import); tests/pwa.test.ts runs both
// copies over the same cases, so a change made to one and not the other fails there.

/** What the worker does with a request. */
export type Route =
  /** Left to the browser, never saved: another site, a POST, /api and /og, the manifest... */
  | 'pass'
  /** A navigation the worker only hands on (it uses the request made as it started up). */
  | 'network'
  /** The game's page: the network's, or the copy saved last time if that doesn't come in time. */
  | 'shell'
  /** One of the game's links (/r/CODE): the network's answer; offline, the page with ?go=. */
  | 'link'
  /** A built file (its name carries a hash of its content): the saved copy, for good. */
  | 'asset'
  /** The cards and pictures: the saved copy at once, refreshed behind it. */
  | 'art';

export interface RouteRequest {
  url: string;
  method: string;
  /** The request's mode ('navigate' for a page). */
  mode: string;
  /** The request asks for part of a file (a Range header): never answered from a saved copy. */
  range?: boolean;
}

export function routeFor(req: RouteRequest, origin: string): Route {
  if (req.method !== 'GET' || req.range) return 'pass';
  let u: URL;
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

/** A push message as the worker shows it. */
export interface PushNote {
  title: string;
  body: string;
  /** Where a tap goes: a path on this site (anything else becomes /). */
  url: string;
  /** Notifications with the same tag replace each other (one per game's "your move"). */
  tag: string;
}

/**
 * A push message's text: JSON {title, body, url, tag}, or Safari's declarative form
 * ({web_push: 8030, notification: {title, body, navigate, tag}}), or plain text (the
 * body). Whatever comes, there is something to show: iOS takes push away from a site that
 * receives a message and shows nothing.
 */
export function parsePush(text: string, origin: string): PushNote {
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // (Plain text: the body.)
  }
  if (!data || typeof data !== 'object') data = { body: text };
  let d = data as Record<string, unknown>;
  const n = d.notification;
  if (d.web_push === 8030 && n && typeof n === 'object') {
    const dn = n as Record<string, unknown>;
    d = { ...dn, url: dn.navigate };
  }
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
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
