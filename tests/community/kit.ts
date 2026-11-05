// The community features' tests: the server harness's World (services with every feature's hooks,
// rooms on fake sockets, the fake clock) and the HTTP API called as the runtimes call it.

import type { FinishedGame, ServerEnv } from '../../server/core/ports';
import { handleApi, type HttpContext } from '../../server/http/router';
import { ENV, World } from '../server/harness';

export { World, ENV };

let ips = 0;

/** The API's context for this world (each its own address, so the per-IP limits never cross tests). */
export function context(w: World, env: Partial<ServerEnv> = {}): HttpContext {
  const ip = `10.0.${Math.floor(++ips / 250)}.${ips % 250}`;
  return { env: { ...ENV, ...env }, db: w.db, blobs: w.blobs, services: w.services, rooms: { fetch: (code, path, init) => w.fetch(code, path, init) }, now: () => w.now, random: (n) => w.random(n), ip };
}

export interface Answer<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** One API request: `token` as the bearer, `body` as JSON. */
export async function api<T = any>(w: World, method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string>; env?: Partial<ServerEnv>; ctx?: HttpContext } = {}): Promise<Answer<T>> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`http://localhost:5173${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const r = (await handleApi(req, o.ctx ?? context(w, o.env)))!;
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* (an SVG, say) */
  }
  return { status: r.status, body: body as T, headers: r.headers };
}

/** A guest: its user id and token. */
export async function sailor(w: World, name: string) {
  const g = await w.guest(name);
  return { user: g.user, token: g.token, name: g.name };
}

/** A finished game as a room hands it to the services, with only what a test cares about. */
export function finished(o: {
  room?: string;
  seats: { user?: string; name?: string; bot?: boolean; conceded?: boolean; away?: boolean }[];
  points: number[];
  winner: number | null;
  rated?: boolean;
  startedAt?: number;
  endedAt?: number;
  turns?: number;
  abandoned?: boolean;
}): FinishedGame {
  return {
    room: o.room ?? 'BCDFGH',
    options: {},
    seats: o.seats.map((s, i) => ({ seat: i, user: s.user, name: s.name ?? (s.bot ? `Crew ${i}` : `Sailor ${i}`), color: ['red', 'blue', 'white', 'orange'][i], bot: !!s.bot, conceded: s.conceded, away: s.away })),
    log: [],
    key: '00'.repeat(32),
    nonces: o.seats.map(() => null),
    winner: o.winner,
    points: o.points,
    turns: o.turns ?? 40,
    startedAt: o.startedAt ?? 1_800_000_000_000,
    endedAt: o.endedAt ?? 1_800_000_600_000,
    rated: o.rated ?? true,
    ...(o.abandoned && { abandoned: true }),
  };
}
