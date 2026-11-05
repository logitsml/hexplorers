// What the extras' tests share: the server test harness's World with an HTTP context over it, and
// requests through the shared router (the routes as either runtime serves them).

import type { ServerEnv } from '../../server/core/ports';
import { handleApi, type HttpContext } from '../../server/http/router';
import { ENV, World } from '../server/harness';

export const ORIGIN = 'http://localhost:5173';

export function context(world: World, env: ServerEnv = ENV, ip = '127.0.0.1'): HttpContext {
  return {
    env,
    db: world.db,
    blobs: world.blobs,
    services: world.services,
    rooms: { fetch: (code, path, init) => world.fetch(code, path, init) },
    now: () => world.now,
    random: (n) => world.random(n),
    ip,
  };
}

/** A request through the router: method and path, a bearer token, a JSON body, more headers. */
export async function api(ctx: HttpContext, method: string, path: string, o: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const text = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  if (text !== undefined) headers['content-type'] = 'application/json';
  const r = await handleApi(new Request(`${ORIGIN}${path}`, { method, headers, body: text }), ctx);
  if (!r) throw new Error(`not a route: ${path}`);
  return r;
}

/** A fetch that answers from the router (what the client's own requests would reach). */
export const routerFetch = (ctx: HttpContext): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, ORIGIN);
    const r = await handleApi(new Request(url, init), ctx);
    return r ?? new Response('Not found', { status: 404 });
  }) as typeof fetch;

export { ENV, World };
