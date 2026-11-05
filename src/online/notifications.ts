// Notifications from this client: Web Push (signing this device up with the server's VAPID key,
// the kinds and quiet hours, a test), and a tapped notification taking the page to its room.
// What it's for: a friend's request or invitation, and word that it's your move at a live table
// you stepped away from, or that the game is over.

import { session } from '../app/session';
import { useUI } from '../game/store';
import { currentPushSubscription, onNotificationOpen, onPushSubscriptionChange, pushPermission, subscribePush, unsubscribePush } from '../app/pwa/push';
import { ApiError } from './api';
import { loadIdentity } from './identity';
import { linkFrom } from './links';

export type NoteKind = 'move' | 'invite' | 'over' | 'friend';

export interface PushPrefs {
  kinds: Record<NoteKind, boolean>;
  quiet: { from: number; to: number } | null;
  tz: string | null;
  devices: number;
}

async function ask<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let r: Response;
  try {
    r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'The harbour can’t be reached. Check your connection and try again.');
  }
  const json = (r.headers.get('content-type') ?? '').includes('json') ? ((await r.json().catch(() => null)) as (T & { error?: string; code?: string }) | null) : null;
  if (!r.ok || json === null) throw new ApiError(r.status, json?.error ?? `The harbour answered ${r.status}`, json?.code);
  return json;
}

/** The identity's token, if this device has one. */
export const pushToken = () => loadIdentity()?.token ?? null;

export const getPushPrefs = (token: string) => ask<PushPrefs>('GET', '/api/push/prefs', token);

export const putPushPrefs = (token: string, patch: Partial<Pick<PushPrefs, 'kinds' | 'quiet' | 'tz'>>) => ask<PushPrefs>('PUT', '/api/push/prefs', token, patch);

export const sendTestPush = (token: string) => ask<{ sent: number; gone: number; failed: number }>('POST', '/api/push/test', token);

/** This device's time zone (for quiet hours), as the platform names it. */
export function deviceZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sign this device up and tell the server; its preferences come back. From a tap: the permission
 * is asked at once (iOS counts only a request made straight from the gesture), and only then is
 * the identity made, if this device has none yet.
 */
export async function turnOnPush(vapidPublicKey: string, token: () => Promise<string>): Promise<PushPrefs> {
  const subscription = await subscribePush(vapidPublicKey);
  return ask<PushPrefs>('POST', '/api/push/subscribe', await token(), { subscription, tz: deviceZone() });
}

/** Stop notifications on this device (the server forgets it). */
export async function turnOffPush(token: string) {
  const old = await unsubscribePush().catch(() => null);
  if (old?.endpoint) await ask('POST', '/api/push/unsubscribe', token, { endpoint: old.endpoint }).catch(() => undefined);
}

/** At a launch, the server hears this device's subscription again (the browser may have renewed it). */
export async function refreshPush(token: string): Promise<boolean> {
  if (pushPermission() !== 'granted') return false;
  const sub = await currentPushSubscription().catch(() => null);
  if (!sub) return false;
  await ask('POST', '/api/push/subscribe', token, { subscription: sub, tz: deviceZone() }).catch(() => undefined);
  return true;
}

let following = false;

/**
 * Once a page is up: a tapped notification for a room this page is on takes it there (aboard
 * again, if the room had let it go), one for the Multiplayer page opens it; and a subscription the
 * browser renewed goes to the server.
 */
export function followNotifications() {
  if (following) return;
  following = true;
  onNotificationOpen((url) => {
    let u: URL;
    try {
      u = new URL(url, location.origin);
    } catch {
      return;
    }
    const link = linkFrom(u);
    if (link) {
      if (session.room?.code !== link.code) void session.join(link.code);
      return;
    }
    if (u.searchParams.get('go') === '/multi' && useUI.getState().screen === 'title') useUI.getState().set({ goPage: { page: 'multi' } });
  });
  onPushSubscriptionChange((sub, old) => {
    const token = pushToken();
    if (!token) return;
    if (old?.endpoint) void ask('POST', '/api/push/unsubscribe', token, { endpoint: old.endpoint }).catch(() => undefined);
    if (sub) void ask('POST', '/api/push/subscribe', token, { subscription: sub, tz: deviceZone() }).catch(() => undefined);
  });
  const token = pushToken();
  if (token && pushPermission() === 'granted') void refreshPush(token);
}
