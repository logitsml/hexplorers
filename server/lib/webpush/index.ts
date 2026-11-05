// server/lib/webpush: send Web Push messages with nothing but WebCrypto and fetch.
//
// On when VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set (the local runtime generates a pair on first
// run with generateVapidKeys). VAPID_SUBJECT defaults to PUBLIC_URL when that is https.
//
//   const signer = await importVapidKeys({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY });
//   const check = validateSubscription(body);              // from POST /api/push/subscribe
//   const result = await sendPush(check.subscription, JSON.stringify(note), { signer, subject }, { ttl: 86400, topic: 'room-BCDFGH' });
//   if (result.gone) deleteSubscription();                 // 404 or 410: the browser unsubscribed
//
// buildPushRequest gives the parts ({url, method, headers, body}) when the caller wants to queue or
// fetch it itself; toRequest turns them into a Request; interpretPushResponse reads the answer.
//
// Never log subscriptions (the endpoint is a capability) or the private key.

import type { ServerEnv } from '../../core/ports';
import { fromBase64Url, type Bytes } from '../crypto';
import { encryptPushPayload, type PushSubscriptionKeys, type WebPushEncryptOptions } from './ece';
import { vapidAuthorization, type VapidSigner } from './vapid';

export * from './ece';
export * from './vapid';

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime?: number | null;
  keys: PushSubscriptionKeys;
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';
export const URGENCIES: readonly Urgency[] = ['very-low', 'low', 'normal', 'high'];

export interface PushOptions {
  /** How long the push service may hold the message, in seconds (RFC 8030 §5.2). Default 1 day. */
  ttl?: number;
  urgency?: Urgency;
  /** Replaces an undelivered message with the same topic (RFC 8030 §5.4): ≤ 32 base64url characters. */
  topic?: string;
  /** Zero bytes of padding after the payload, to hide its length. */
  padding?: number;
  /** VAPID JWT lifetime in seconds (≤ 24 h). */
  vapidExpiresIn?: number;
  now?: number;
  /** Test hooks for the encryption (fixed salt and keys). */
  encryption?: Pick<WebPushEncryptOptions, 'salt' | 'serverKeys'>;
}

export interface VapidIdentity {
  signer: VapidSigner;
  /** mailto: or https: contact for the push service's operators. */
  subject: string;
}

export interface PushRequestParts {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Bytes | null;
}

/** Whether Web Push is on for this environment. */
export function isConfigured(env: Pick<ServerEnv, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY'>): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** The VAPID subject: VAPID_SUBJECT, else PUBLIC_URL when it is https, else a placeholder mailto. */
export function vapidSubject(env: Pick<ServerEnv, 'VAPID_SUBJECT' | 'PUBLIC_URL'>): string {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  try {
    const url = new URL(env.PUBLIC_URL);
    if (url.protocol === 'https:') return url.origin;
  } catch {
    // fall through
  }
  return 'mailto:push@localhost.invalid';
}

/** Push services browsers use today. Anything else is refused unless allowAnyHttps is set. */
export const KNOWN_PUSH_HOSTS: readonly (string | RegExp)[] = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export type SubscriptionCheck =
  | { ok: true; subscription: PushSubscriptionData }
  | { ok: false; error: 'shape' | 'endpoint' | 'host' | 'keys' };

/**
 * Validate a subscription a client sent (PushSubscription.toJSON()). The endpoint must be https on a
 * known push service: a client-chosen URL is otherwise a way to make the server fetch anything.
 */
export function validateSubscription(input: unknown, options: { allowAnyHttps?: boolean } = {}): SubscriptionCheck {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'shape' };
  const sub = input as Partial<PushSubscriptionData>;
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048 || typeof sub.keys !== 'object' || sub.keys === null) {
    return { ok: false, error: 'shape' };
  }
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return { ok: false, error: 'endpoint' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return { ok: false, error: 'endpoint' };
  const host = url.hostname.toLowerCase();
  if (!options.allowAnyHttps && !KNOWN_PUSH_HOSTS.some((h) => (typeof h === 'string' ? h === host : h.test(host)))) {
    return { ok: false, error: 'host' };
  }
  const { p256dh, auth } = sub.keys as Partial<PushSubscriptionKeys>;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return { ok: false, error: 'keys' };
  try {
    const point = fromBase64Url(p256dh);
    const secret = fromBase64Url(auth);
    if (point.length !== 65 || point[0] !== 4 || secret.length !== 16) return { ok: false, error: 'keys' };
  } catch {
    return { ok: false, error: 'keys' };
  }
  const expirationTime = typeof sub.expirationTime === 'number' ? sub.expirationTime : null;
  return { ok: true, subscription: { endpoint: url.href, expirationTime, keys: { p256dh, auth } } };
}

/**
 * Everything a push service needs, encrypted and signed. `payload` null sends a payload-less "tickle"
 * (the service worker then fetches what's new).
 */
export async function buildPushRequest(
  subscription: PushSubscriptionData,
  payload: Uint8Array | string | null,
  vapid: VapidIdentity,
  options: PushOptions = {},
): Promise<PushRequestParts> {
  const ttl = options.ttl ?? 86_400;
  if (!Number.isInteger(ttl) || ttl < 0) throw new Error('webpush: TTL must be a whole number of seconds');
  const headers: Record<string, string> = {
    TTL: String(ttl),
    Authorization: await vapidAuthorization(subscription.endpoint, vapid.signer, vapid.subject, {
      now: options.now,
      expiresIn: options.vapidExpiresIn,
    }),
  };
  if (options.urgency) {
    if (!URGENCIES.includes(options.urgency)) throw new Error('webpush: unknown urgency');
    headers.Urgency = options.urgency;
  }
  if (options.topic !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) throw new Error('webpush: topic must be 1-32 base64url characters');
    headers.Topic = options.topic;
  }
  let body: Bytes | null = null;
  if (payload !== null) {
    body = await encryptPushPayload(payload, subscription.keys, { padding: options.padding, ...options.encryption });
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
  }
  headers['Content-Length'] = String(body?.length ?? 0);
  return { url: subscription.endpoint, method: 'POST', headers, body };
}

/** The parts as a fetch Request. */
export function toRequest(parts: PushRequestParts): Request {
  const headers = { ...parts.headers };
  delete headers['Content-Length']; // fetch sets it, and some runtimes refuse it as a forbidden header
  return new Request(parts.url, { method: parts.method, headers, body: parts.body });
}

export type PushOutcome =
  | { ok: true; status: number }
  | {
      ok: false;
      status: number;
      /** The subscription is dead (404, 410): delete it. */
      gone: boolean;
      /** Worth trying again later (429, 5xx, network). */
      retry: boolean;
      /** Seconds, from Retry-After, when the service sent one. */
      retryAfter?: number;
      reason: 'gone' | 'too-large' | 'rate-limited' | 'unauthorized' | 'bad-request' | 'server-error' | 'network' | 'other';
    };

/** What a push service's answer means (RFC 8030 §5, RFC 8292 §4). */
export function interpretPushResponse(response: { status: number; headers?: Headers | { get(name: string): string | null } }): PushOutcome {
  const { status } = response;
  if (status >= 200 && status < 300) return { ok: true, status };
  const retryAfterText = response.headers?.get('Retry-After') ?? null;
  const retryAfter = retryAfterText && /^\d+$/.test(retryAfterText) ? Number(retryAfterText) : undefined;
  const base = { ok: false as const, status, ...(retryAfter !== undefined ? { retryAfter } : {}) };
  if (status === 404 || status === 410) return { ...base, gone: true, retry: false, reason: 'gone' };
  if (status === 413) return { ...base, gone: false, retry: false, reason: 'too-large' };
  if (status === 429) return { ...base, gone: false, retry: true, reason: 'rate-limited' };
  if (status === 401 || status === 403) return { ...base, gone: false, retry: false, reason: 'unauthorized' };
  if (status === 400) return { ...base, gone: false, retry: false, reason: 'bad-request' };
  if (status >= 500) return { ...base, gone: false, retry: true, reason: 'server-error' };
  return { ...base, gone: false, retry: false, reason: 'other' };
}

/** Build, send and interpret one push. Network failures come back as { reason: 'network', retry: true }. */
export async function sendPush(
  subscription: PushSubscriptionData,
  payload: Uint8Array | string | null,
  vapid: VapidIdentity,
  options: PushOptions & { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<PushOutcome> {
  const parts = await buildPushRequest(subscription, payload, vapid, options);
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(toRequest(parts), { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    // Drain the body so the connection can be reused (and never surface it: it may echo the endpoint).
    await response.body?.cancel().catch(() => undefined);
    return interpretPushResponse(response);
  } catch {
    return { ok: false, status: 0, gone: false, retry: true, reason: 'network' };
  }
}
