// What each person wants to hear about, and when not: the kinds of notes (your move at a live table
// they're away from, invitations, a game's end, friend requests) and quiet hours in their own time
// zone (default 22:00 to 08:00). Pure functions, so the rules can be tested on their own.

import type { NoteKind } from '../../core/ports';

export const NOTE_KINDS: readonly NoteKind[] = ['move', 'invite', 'over', 'friend'];

export interface Prefs {
  kinds: Record<NoteKind, boolean>;
  /** Minutes after midnight in `tz`: no notes from `from` until `to` (null: no quiet hours). */
  quiet: { from: number; to: number } | null;
  /** An IANA time zone (the device's, sent when it signs up); without one there are no quiet hours. */
  tz: string | null;
}

export const DEFAULT_QUIET = { from: 22 * 60, to: 8 * 60 };

export const defaultPrefs = (tz: string | null = null): Prefs => ({
  kinds: { move: true, invite: true, over: true, friend: true },
  quiet: { ...DEFAULT_QUIET },
  tz,
});

/** A time zone the platform knows (null otherwise). */
export function cleanZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** The minutes after midnight it is in `tz` at `now`. */
export function localMinutes(now: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/** In quiet hours at `now`: when they end (epoch ms); null when it isn't quiet. */
export function quietUntil(p: Prefs, now: number): number | null {
  if (!p.quiet || !p.tz || p.quiet.from === p.quiet.to) return null;
  const m = localMinutes(now, p.tz);
  const { from, to } = p.quiet;
  const quiet = from < to ? m >= from && m < to : m >= from || m < to;
  if (!quiet) return null;
  const left = (to - m + 1440) % 1440;
  // (To the minute: the seconds already gone this minute come off.)
  return now + left * 60_000 - (now % 60_000);
}

/** A stored row back as preferences (anything missing or unreadable takes the default). */
export function prefsOf(row: { kinds?: unknown; quiet_from?: unknown; quiet_to?: unknown; tz?: unknown } | null): Prefs {
  const p = defaultPrefs();
  if (!row) return p;
  try {
    const k = JSON.parse(String(row.kinds ?? '{}')) as Partial<Record<NoteKind, unknown>>;
    for (const kind of NOTE_KINDS) if (typeof k[kind] === 'boolean') p.kinds[kind] = k[kind] as boolean;
  } catch {
    // (The defaults.)
  }
  const from = Number(row.quiet_from);
  const to = Number(row.quiet_to);
  p.quiet = row.quiet_from === null || row.quiet_from === undefined || !Number.isInteger(from) || !Number.isInteger(to) ? null : { from, to };
  p.tz = cleanZone(row.tz);
  return p;
}
