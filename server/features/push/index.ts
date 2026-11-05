// Web Push: each person's devices (push_subscriptions: the endpoint's hash, the endpoint and its
// keys, when it was made and last took a message), what they want to hear about and when not
// (push_prefs), the notes held through their quiet hours (push_queue) and the last note of each
// game they were sent (push_sent). It replaces services.notify: a note goes to each of the
// person's devices, encrypted for each (RFC 8291) and signed with the server's VAPID key, unless
// its kind is off or it's their quiet hours (then it waits, one per game, and comes in a digest
// when they end); the same game's notes share a tag, so a device shows one "your move" per game,
// and a push service replaces one not yet delivered (its Topic). A device the push service says
// is gone (404, 410) is forgotten. What it carries: a friend's request or invitation, and word to
// someone away from a live table that it's their move or the game is over.
//
// On only with VAPID keys (the local runtime makes a pair on first run). Endpoints are
// capabilities and never logged; neither are keys or addresses.

import * as v from 'valibot';
import { check } from '../../../src/net/schema';
import type { NoteKind, ServerEnv } from '../../core/ports';
import { body, fail, json, limited, originAllowed, who, type Handler } from '../../http/kit';
import { sha256Hex } from '../../lib/crypto';
import { importVapidKeys, isConfigured, sendPush, validateSubscription, vapidSubject, type PushSubscriptionData, type Urgency, type VapidIdentity } from '../../lib/webpush';
import type { Services } from '../../services';
import type { Feature, FeatureDeps } from '../index';
import { NOTE_KINDS, cleanZone, defaultPrefs, prefsOf, quietUntil, type Prefs } from './prefs';

export * from './prefs';

/** The same game's note no more than once in this long (a burst of offers is one note). */
export const NOTE_COOLDOWN_MS = 60_000;
/** A person's devices kept at most (the oldest goes). */
export const MAX_DEVICES = 10;

export type Note = Parameters<Services['notify']>[1];

type Host = Services & { push?: Sender };

export interface Delivery {
  sent: number;
  gone: number;
  failed: number;
}

export type Outcome = 'sent' | 'queued' | 'off' | 'stale' | 'soon' | 'none' | 'failed';

const DAY = 24 * 3_600_000;

/** A tag as a push service's Topic (≤ 32 base64url characters), when it can be one. */
const topicOf = (tag: string) => {
  const t = tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return t || undefined;
};

/** The sender: one per services instance (it keeps the imported VAPID key). */
export class Sender {
  private signer: Promise<VapidIdentity> | null = null;

  constructor(private d: FeatureDeps) {}

  get on() {
    return isConfigured(this.d.env);
  }

  private vapid(): Promise<VapidIdentity> {
    const env = this.d.env;
    this.signer ??= importVapidKeys({ publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! }).then((signer) => ({ signer, subject: vapidSubject(env) }));
    return this.signer;
  }

  async prefs(user: string): Promise<Prefs> {
    return prefsOf(await this.d.db.first('SELECT kinds, quiet_from, quiet_to, tz FROM push_prefs WHERE user = ?', user));
  }

  async savePrefs(user: string, p: Prefs) {
    await this.d.db.run(
      'INSERT OR REPLACE INTO push_prefs(user, kinds, quiet_from, quiet_to, tz, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      user, JSON.stringify(p.kinds), p.quiet?.from ?? null, p.quiet?.to ?? null, p.tz, this.d.now(),
    );
  }

  /** services.notify: each person in turn, by their own preferences. */
  async notify(users: string[], note: Note) {
    // (With push not keyed there is nobody to tell, and nothing is written.)
    if (!this.on) return;
    for (const user of new Set(users)) {
      try {
        await this.one(user, note);
      } catch (e) {
        console.warn(JSON.stringify({ ev: 'pushFailed', kind: note.kind ?? 'move', error: String((e as Error)?.message ?? e).slice(0, 120) }));
      }
    }
  }

  /** One note to one person: sent, held for the end of their quiet hours, or let go (and why). */
  async one(user: string, note: Note): Promise<Outcome> {
    const now = this.d.now();
    const kind: NoteKind = note.kind ?? 'move';
    const tag = note.tag ?? kind;
    const p = await this.prefs(user);
    if (!p.kinds[kind]) return 'off';
    if (note.expires !== undefined && note.expires <= now) return 'stale';
    const last = await this.d.db.first<{ at: number }>('SELECT at FROM push_sent WHERE user = ? AND tag = ?', user, tag);
    if (last && now - last.at < NOTE_COOLDOWN_MS) return 'soon';
    const until = quietUntil(p, now);
    if (until !== null) {
      // (Held until their morning: by then a deadline it speaks of may have passed, and it goes unsaid.)
      if (note.expires !== undefined && note.expires <= until) return 'stale';
      await this.d.db.run(
        'INSERT OR REPLACE INTO push_queue(user, tag, kind, note, due_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        user, tag, kind, JSON.stringify({ title: note.title, body: note.body, url: note.url }), until, note.expires ?? null,
      );
      return 'queued';
    }
    const d = await this.deliver(user, { ...note, tag, kind });
    return d.sent ? 'sent' : d.failed ? 'failed' : 'none';
  }

  /** To every device of this person now. */
  async deliver(user: string, note: Note): Promise<Delivery> {
    const now = this.d.now();
    const tag = note.tag ?? note.kind ?? 'move';
    const out: Delivery = { sent: 0, gone: 0, failed: 0 };
    const subs = this.on ? await this.d.db.all<{ id: string; endpoint: string; p256dh: string; auth: string; last_ok: number | null; fails: number }>('SELECT id, endpoint, p256dh, auth, last_ok, fails FROM push_subscriptions WHERE user = ?', user) : [];
    if (subs.length) {
      const payload = JSON.stringify({ title: note.title, body: note.body, url: note.url, tag });
      const vapid = await this.vapid();
      const ttl = Math.round(Math.min(28 * DAY, Math.max(60_000, note.expires !== undefined ? note.expires - now : 2 * DAY)) / 1000);
      const urgency: Urgency = note.kind === 'over' || note.kind === 'friend' ? 'low' : 'normal';
      for (const s of subs) {
        const sub: PushSubscriptionData = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        const r = await sendPush(sub, payload, vapid, { ttl, urgency, topic: topicOf(tag), now });
        if (r.ok) {
          out.sent++;
          // (A device that takes its notes is written down at most hourly: each write is a row.)
          if (s.fails > 0 || s.last_ok === null || now - s.last_ok > 3_600_000) await this.d.db.run('UPDATE push_subscriptions SET last_ok = ?, fails = 0 WHERE id = ?', now, s.id);
        } else if (r.gone) {
          out.gone++;
          await this.d.db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
        } else {
          out.failed++;
          await this.d.db.run('UPDATE push_subscriptions SET fails = fails + 1 WHERE id = ?', s.id);
          console.warn(JSON.stringify({ ev: 'pushRefused', status: r.status, reason: r.reason }));
        }
      }
    }
    await this.d.db.run('INSERT OR REPLACE INTO push_sent(user, tag, at) VALUES (?, ?, ?)', user, tag, now);
    return out;
  }

  /** The notes whose quiet hours are over: one person's several come as one digest. */
  async flush(): Promise<number> {
    const now = this.d.now();
    const rows = await this.d.db.all<{ user: string; tag: string; kind: string; note: string; expires_at: number | null }>('SELECT user, tag, kind, note, expires_at FROM push_queue WHERE due_at <= ? ORDER BY user, due_at LIMIT 500', now);
    const by = new Map<string, typeof rows>();
    for (const r of rows) by.set(r.user, [...(by.get(r.user) ?? []), r]);
    let n = 0;
    for (const [user, list] of by) {
      await this.d.db.batch(list.map((r) => ({ query: 'DELETE FROM push_queue WHERE user = ? AND tag = ?', bindings: [user, r.tag] })));
      const p = await this.prefs(user);
      const fresh = list.filter((r) => (r.expires_at === null || r.expires_at > now) && p.kinds[r.kind as NoteKind] !== false);
      if (!fresh.length) continue;
      const notes = fresh.map((r) => ({ ...(JSON.parse(r.note) as { title: string; body: string; url: string }), tag: r.tag, kind: r.kind as NoteKind, ...(r.expires_at !== null && { expires: r.expires_at }) }));
      try {
        if (notes.length === 1) await this.deliver(user, notes[0]);
        else {
          const moves = notes.filter((x) => x.kind === 'move').length;
          const title = moves === notes.length ? `Your move in ${moves} games` : `${notes.length} notes from the harbour`;
          await this.deliver(user, { title, body: notes.map((x) => x.title).slice(0, 3).join(' · '), url: '/?go=/multi', tag: 'harbour', kind: moves ? 'move' : notes[0].kind });
        }
        n++;
      } catch (e) {
        console.warn(JSON.stringify({ ev: 'pushFailed', at: 'flush', error: String((e as Error)?.message ?? e).slice(0, 120) }));
      }
    }
    return n;
  }
}

const senderOf = (s: Services) => (s as Host).push ?? null;

// ------------------------------------------------------------------ routes

const SubscribeBody = v.strictObject({ subscription: v.unknown(), tz: v.optional(v.pipe(v.string(), v.maxLength(64))) });
const UnsubscribeBody = v.strictObject({ endpoint: v.pipe(v.string(), v.maxLength(2048)) });
const minute = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439));
const PrefsBody = v.strictObject({
  kinds: v.optional(v.strictObject({ move: v.optional(v.boolean()), invite: v.optional(v.boolean()), over: v.optional(v.boolean()), friend: v.optional(v.boolean()) })),
  quiet: v.optional(v.nullable(v.strictObject({ from: minute, to: minute }))),
  tz: v.optional(v.pipe(v.string(), v.maxLength(64))),
});

/** The preferences as the client shows them, with what this server can do. */
async function prefsView(user: string, ctx: Parameters<Handler>[2], push: Sender) {
  const p = await push.prefs(user);
  const devices = await ctx.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user = ?', user);
  return { ...p, devices: devices?.n ?? 0 };
}

const subscribe: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const push = senderOf(ctx.services);
  if (!push?.on) return fail(501, 'Notifications aren’t available on this server.', 'off');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  if (await limited(ctx, 'push', 20, 10)) return fail(429, 'Too many tries: wait a minute.');
  const b = check(SubscribeBody, await body(req, 4096));
  if (!b) return fail(400, 'Bad body.');
  const c = validateSubscription(b.subscription);
  if (!c.ok) return fail(400, 'That isn’t a push subscription this server can use.', c.error);
  const sub = c.subscription;
  const hash = await sha256Hex(sub.endpoint);
  const now = ctx.now();
  // (A device already known under someone else moves to whoever signed it up last.)
  await ctx.db.run(
    'INSERT OR REPLACE INTO push_subscriptions(id, user, endpoint, p256dh, auth, created_at, last_ok, fails) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM push_subscriptions WHERE id = ? AND user = ?), ?), (SELECT last_ok FROM push_subscriptions WHERE id = ? AND user = ?), 0)',
    hash, id.user, sub.endpoint, sub.keys.p256dh, sub.keys.auth, hash, id.user, now, hash, id.user,
  );
  const extra = await ctx.db.all<{ id: string }>('SELECT id FROM push_subscriptions WHERE user = ? ORDER BY created_at DESC, id LIMIT -1 OFFSET ?', id.user, MAX_DEVICES);
  for (const x of extra) await ctx.db.run('DELETE FROM push_subscriptions WHERE id = ?', x.id);
  // A first device: the preferences start from the defaults, quiet hours in its time zone.
  const had = await ctx.db.first('SELECT user FROM push_prefs WHERE user = ?', id.user);
  const tz = cleanZone(b.tz);
  if (!had) await push.savePrefs(id.user, defaultPrefs(tz));
  else if (tz) {
    const p = await push.prefs(id.user);
    if (!p.tz) await push.savePrefs(id.user, { ...p, tz });
  }
  return json(200, await prefsView(id.user, ctx, push));
};

const unsubscribe: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const b = check(UnsubscribeBody, await body(req, 4096));
  if (!b) return fail(400, 'Bad body.');
  const r = await ctx.db.run('DELETE FROM push_subscriptions WHERE id = ? AND user = ?', await sha256Hex(b.endpoint), id.user);
  return json(200, { ok: true, removed: r.changes });
};

const test: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const push = senderOf(ctx.services);
  if (!push?.on) return fail(501, 'Notifications aren’t available on this server.', 'off');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  if (await limited(ctx, 'push-test', 6, 3)) return fail(429, 'That’s a lot of tests: wait a minute.');
  const d = await push.deliver(id.user, { title: 'Word from the harbour', body: 'Notifications are on: this is how “your move” will come.', url: '/?go=/multi', tag: 'test' });
  if (d.sent + d.gone + d.failed === 0) return fail(409, 'No device of yours is signed up for notifications.', 'none');
  return json(200, d);
};

const getPrefs: Handler = async (req, _p, ctx) => {
  const push = senderOf(ctx.services);
  if (!push) return fail(501, 'Notifications aren’t available on this server.', 'off');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  return json(200, await prefsView(id.user, ctx, push));
};

const putPrefs: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const push = senderOf(ctx.services);
  if (!push) return fail(501, 'Notifications aren’t available on this server.', 'off');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  if (await limited(ctx, 'push', 20, 10)) return fail(429, 'Too many tries: wait a minute.');
  const b = check(PrefsBody, await body(req, 2048));
  if (!b) return fail(400, 'Bad body.');
  const p = await push.prefs(id.user);
  for (const k of NOTE_KINDS) if (b.kinds?.[k] !== undefined) p.kinds[k] = b.kinds[k]!;
  if (b.quiet !== undefined) p.quiet = b.quiet;
  if (b.tz !== undefined) {
    const tz = cleanZone(b.tz);
    if (!tz) return fail(400, 'No such time zone.');
    p.tz = tz;
  }
  await push.savePrefs(id.user, p);
  return json(200, await prefsView(id.user, ctx, push));
};

export const push: Feature = {
  id: 'push',
  schema: [
    'CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY, user TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL, last_ok INTEGER, fails INTEGER NOT NULL DEFAULT 0)',
    'CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user)',
    'CREATE TABLE IF NOT EXISTS push_prefs(user TEXT PRIMARY KEY, kinds TEXT NOT NULL, quiet_from INTEGER, quiet_to INTEGER, tz TEXT, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS push_queue(user TEXT NOT NULL, tag TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, due_at INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY (user, tag))',
    'CREATE INDEX IF NOT EXISTS push_queue_due ON push_queue(due_at)',
    'CREATE TABLE IF NOT EXISTS push_sent(user TEXT NOT NULL, tag TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user, tag))',
  ],
  routes: [
    { method: 'POST', path: '/api/push/subscribe', handler: subscribe },
    { method: 'POST', path: '/api/push/unsubscribe', handler: unsubscribe },
    { method: 'POST', path: '/api/push/test', handler: test },
    { method: 'GET', path: '/api/push/prefs', handler: getPrefs },
    { method: 'PUT', path: '/api/push/prefs', handler: putPrefs },
  ],
  flags: (env: ServerEnv) => ({ push: isConfigured(env) }),
  extend(services, deps) {
    const host = services as Host;
    const sender = new Sender(deps);
    host.push = sender;
    // (The note is still recorded first, as the services' own notify does: it is each person's
    // inbox of what was sent their way, whether or not a device of theirs took it.)
    const record = services.notify;
    services.notify = async (users, note) => {
      await record.call(services, users, note);
      await sender.notify(users, note);
    };
    const prev = services.tick;
    services.tick = async () => {
      await prev?.call(services);
      await sender.flush();
    };
  },
};
