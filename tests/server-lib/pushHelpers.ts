// What the push tests share: a world whose services hold VAPID keys, a browser's side of a push
// subscription that can read what it's sent, a stand-in for the push services that keeps every
// request, and the HTTP API called as a client would.

import { vi } from 'vitest';
import { fromBase64Url, fromUtf8, toBase64Url } from '../../server/lib/crypto';
import { decryptPushPayload, generateVapidKeys, type PushSubscriptionData } from '../../server/lib/webpush';
import type { ServerEnv } from '../../server/core/ports';
import { handleApi, type HttpContext } from '../../server/http/router';
import { createServices, migrate } from '../../server/services';
import { ENV, World } from '../server/harness';

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** A browser's side of a subscription: its ECDH key pair and auth secret, to decrypt what comes. */
export async function userAgent(endpoint = `https://fcm.googleapis.com/fcm/send/${Math.random().toString(36).slice(2)}`) {
  const pair = (await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription: PushSubscriptionData & { expirationTime: null } = { endpoint, expirationTime: null, keys: { p256dh: toBase64Url(publicKey), auth: toBase64Url(auth) } };
  const recipient = { privateKey: pair.privateKey, publicKey, auth };
  return {
    subscription,
    /** A push request's body as the browser reads it. */
    read: async (body: Uint8Array) => JSON.parse(fromUtf8(await decryptPushPayload(body, recipient))) as { title: string; body: string; url: string; tag: string; badge?: number },
  };
}

export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * The network as the server sees it: every request kept, each answered by `answer` (201 by
 * default, as push services answer). Restore with vi.unstubAllGlobals().
 */
export function fakeNetwork(answer: (r: Sent) => number = () => 201) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const r: Sent = { url: req.url, method: req.method, headers, body: new Uint8Array(await req.arrayBuffer()) };
    sent.push(r);
    const status = answer(r);
    return new Response(null, { status, headers: { 'content-type': 'application/json' } });
  });
  return sent;
}

let keys: Promise<{ publicKey: string; privateKey: string }> | null = null;
/** One VAPID key pair for the whole run (making one is quick, but not free). */
export const vapidKeys = () => (keys ??= generateVapidKeys());

let worlds = 0;

/** A world whose services have VAPID keys (and whatever else `env` adds). */
export class PushWorld extends World {
  env: ServerEnv = ENV;
  /** Its own address, so the API's per-address limits of one test never meet another's. */
  ip = `203.0.113.${++worlds % 250}`;
  async init() {
    const k = await vapidKeys();
    this.env = { ...ENV, VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com', ...this.extra };
    await migrate(this.db);
    this.services = createServices({
      db: this.db,
      blobs: this.blobs,
      env: this.env,
      now: () => this.now,
      random: (n) => this.random(n),
      rooms: { fetch: (code, path, init) => this.fetch(code, path, init) },
    });
    return this;
  }
  constructor(
    seed = 1,
    private extra: Partial<ServerEnv> = {},
  ) {
    super(seed);
  }

  ctx(): HttpContext {
    return { env: this.env, db: this.db, blobs: this.blobs, services: this.services, rooms: { fetch: (c, p, i) => this.fetch(c, p, i) }, now: () => this.now, random: (n) => this.random(n), ip: this.ip };
  }
}

/** Call the API as a client would (JSON in and out, the token as a bearer). */
export async function api(w: { ctx(): HttpContext }, method: string, path: string, token?: string, b?: unknown) {
  const headers: Record<string, string> = { origin: ENV.PUBLIC_URL };
  if (token) headers.authorization = `Bearer ${token}`;
  if (b !== undefined) headers['content-type'] = 'application/json';
  const r = (await handleApi(new Request(`http://localhost:5173${path}`, { method, headers, body: b === undefined ? undefined : JSON.stringify(b) }), w.ctx()))!;
  return { status: r.status, body: (await r.json()) as Record<string, unknown> & { error?: string } };
}

/** The VAPID header's parts: the JWT's claims and the public key. */
export function vapidOf(authorization: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  if (!m) return null;
  const [, t, k] = m;
  const claims = JSON.parse(fromUtf8(fromBase64Url(t.split('.')[1]))) as { aud: string; exp: number; sub: string };
  return { jwt: t, k, claims };
}
