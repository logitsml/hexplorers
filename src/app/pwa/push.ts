// Web Push (a friend's request or invitation, "your move" at a live table you've left), for the
// online interface to call. Nothing here talks to the game's server: subscribePush returns the
// subscription (as JSON) for the caller to send to /api/push, and unsubscribePush the one to
// forget. The service worker shows the messages (public/sw.js, payload {title, body, url, tag}).
//
// iOS and iPadOS deliver push only to a web app opened from the Home Screen: in a Safari tab
// there is no PushManager at all. pushNeedsHomeScreen() says so, for the interface to show the
// Home Screen sheet (ui/pwa) instead of asking. Permission must be asked from a tap.

import { registerWorker } from './register';
import { isIOS, isStandalone } from './state';

export type PushErrorCode =
  /** No Web Push in this browser (or not on a secure origin). */
  | 'unsupported'
  /** iOS outside a Home Screen app: add it to the Home Screen first. */
  | 'needs-home-screen'
  /** Notifications were refused (or dismissed): only the browser's settings can change that now. */
  | 'denied'
  /** The server's VAPID public key isn't a P-256 key in base64url. */
  | 'bad-key'
  /** No service worker on this build (a dev server without ?sw, the kill switch). */
  | 'no-worker';

export class PushError extends Error {
  code: PushErrorCode;
  constructor(code: PushErrorCode, message: string) {
    super(message);
    this.name = 'PushError';
    this.code = code;
  }
}

/** Whether this browser can take push messages now (on iOS: only once opened from the Home Screen). */
export function pushSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iOS outside a Home Screen app, where push only comes once the game is added there. */
export function pushNeedsHomeScreen(): boolean {
  return isIOS() && !isStandalone();
}

/** The notification permission: 'default' (not asked yet), 'granted', 'denied', or 'unsupported'. */
export function pushPermission(): NotificationPermission | 'unsupported' {
  return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
}

/** A VAPID public key (base64url, the uncompressed P-256 point: 65 bytes from 0x04) as bytes. */
export function decodeVapidKey(key: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const b64 = key.trim().replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    throw new PushError('bad-key', 'The VAPID public key is not base64url.');
  }
  if (bytes.length !== 65 || bytes[0] !== 4) throw new PushError('bad-key', 'The VAPID public key is not an uncompressed P-256 public key.');
  return bytes;
}

/** The service worker, registered now if the page hasn't got to it yet. */
async function worker(): Promise<ServiceWorkerRegistration> {
  if (!(await registerWorker())) throw new PushError('no-worker', 'There is no service worker on this build.');
  return navigator.serviceWorker.ready;
}

/**
 * Subscribe this device to push, from a tap (the permission is asked first, while the tap still
 * counts): the subscription as JSON {endpoint, keys: {p256dh, auth}} for the server. One made
 * before with the same key is returned as it is; one with another key (the server's keys
 * changed) is replaced. Throws a PushError, by its code, when it can't.
 */
export async function subscribePush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  if (pushNeedsHomeScreen()) throw new PushError('needs-home-screen', 'On iOS, notifications come once the game is on the Home Screen.');
  if (!pushSupported()) throw new PushError('unsupported', 'This browser has no Web Push.');
  const asked = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
  const key = decodeVapidKey(vapidPublicKey);
  const [permission, reg] = await Promise.all([asked, worker()]);
  if (permission !== 'granted') throw new PushError('denied', 'Notifications are turned off for this site.');
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    const had = existing.options.applicationServerKey;
    if (had && sameBytes(new Uint8Array(had), key)) return existing.toJSON();
    await existing.unsubscribe();
  }
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return sub.toJSON();
}

/** Unsubscribe this device: the subscription it had (for the server to forget), or null. */
export async function unsubscribePush(): Promise<PushSubscriptionJSON | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  const json = sub.toJSON();
  await sub.unsubscribe();
  return json;
}

/** This device's subscription, if any (to check with the server at each launch: the browser can renew it by itself). */
export async function currentPushSubscription(): Promise<PushSubscriptionJSON | null> {
  return (await currentSubscription())?.toJSON() ?? null;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Messages from the service worker of one type, to `fn`; returns the way to stop listening. */
function onWorkerMessage(type: string, fn: (data: Record<string, unknown>) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const listen = (e: MessageEvent) => e.data?.type === type && fn(e.data);
  navigator.serviceWorker.addEventListener('message', listen);
  navigator.serviceWorker.startMessages();
  return () => navigator.serviceWorker.removeEventListener('message', listen);
}

/**
 * A notification tapped while the game is open on its page: the window is brought forward and
 * this hears where the notification points (a path, say /r/CODE), to go there without a reload.
 * (With no window on that page, a new one opens at the address instead.)
 */
export function onNotificationOpen(fn: (url: string) => void): () => void {
  return onWorkerMessage('pwa:open', (d) => typeof d.url === 'string' && fn(d.url));
}

/** The browser renewed the subscription by itself: the new one (or null) and the old, to pass to the server. */
export function onPushSubscriptionChange(fn: (sub: PushSubscriptionJSON | null, old: PushSubscriptionJSON | null) => void): () => void {
  return onWorkerMessage('pwa:subscription', (d) => fn((d.subscription as PushSubscriptionJSON) ?? null, (d.old as PushSubscriptionJSON) ?? null));
}
