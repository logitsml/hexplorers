// The links into a room: /r/CODE to join, /w/CODE to watch, and #seat=TOKEN on a link that hands a
// seat to another device (the token in the fragment, which never reaches a server). The Worker
// serves the page for these paths; one that reaches the 404 page instead (or an installed app's
// shortcut) comes as /?go=<path>, so both forms are read.

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_RE } from '../net/protocol';

export interface RoomLink {
  code: string;
  watch: boolean;
  /** A handed-off seat's token (from the fragment). */
  seat?: string;
}

/** A typed or pasted code as the room knows it: upper case, without the spaces and dashes it's shown with. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, ROOM_CODE_LENGTH);
}

/** What may be typed into the code box: only the code's own letters (the rest are dropped as they're typed). */
export function codeInput(input: string): string {
  return [...input.toUpperCase()].filter((c) => ROOM_CODE_ALPHABET.includes(c)).join('').slice(0, ROOM_CODE_LENGTH);
}

export const isCode = (c: string) => ROOM_CODE_RE.test(c);

/** A code as it's read out: 3 + 3. */
export const spacedCode = (c: string) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c);

/** A room's path (its link, without the origin). */
export const roomPath = (code: string, watch = false) => `/${watch ? 'w' : 'r'}/${code}`;

/** The whole link to share. */
export const roomUrl = (code: string, watch = false, origin = location.origin) => `${origin}${roomPath(code, watch)}`;

/** The room a page was opened for, if any: `/r/CODE`, `/w/CODE`, or the 404 page's `/?go=/r/CODE`. */
export function linkFrom(loc: Pick<Location, 'pathname' | 'search' | 'hash'>): RoomLink | null {
  const go = new URLSearchParams(loc.search).get('go');
  const path = go && go.startsWith('/') ? go.split(/[?#]/)[0] : loc.pathname;
  const m = /^\/([rw])\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  const code = normalizeCode(decodeURIComponent(m[2]));
  if (!isCode(code)) return null;
  const seat = new URLSearchParams(loc.hash.replace(/^#/, '')).get('seat') ?? undefined;
  // (The room's seat token: seat.generation.expiry.mac, the last base64url.)
  return { code, watch: m[1] === 'w', ...(seat && /^[A-Za-z0-9_.-]{8,256}$/.test(seat) && { seat }) };
}

/** A replay's path. */
export const replayPath = (id: string) => `/replay/${id}`;

/** The replay a page was opened for, if any: `/replay/ID`, or the 404 page's `/?go=/replay/ID`. */
export function replayFrom(loc: Pick<Location, 'pathname' | 'search'>): string | null {
  const go = new URLSearchParams(loc.search).get('go');
  const path = go && go.startsWith('/') ? go.split(/[?#]/)[0] : loc.pathname;
  const m = /^\/replay\/([A-Za-z0-9_-]{8,32})\/?$/.exec(path);
  return m ? m[1] : null;
}

/**
 * The address bar follows the room you're in (a reload comes back to it), without the seat token
 * (spent once taken up) or the 404 page's ?go=; leaving a room takes it back to the start. Other
 * parameters (?q= and the like, for testing) stay.
 */
export function showRoomInUrl(link: { code: string; watch: boolean } | null) {
  try {
    const params = new URLSearchParams(location.search);
    params.delete('go');
    const qs = params.toString();
    const path = `${link ? roomPath(link.code, link.watch) : '/'}${qs ? `?${qs}` : ''}`;
    if (location.pathname + location.search + location.hash !== path) history.replaceState(history.state, '', path);
  } catch {
    /* (a sandboxed frame: the address stays as it was) */
  }
}

/** A profile's path: /u/HANDLE. */
export const profilePath = (handle: string) => `/u/${encodeURIComponent(handle)}`;

/** The profile a page was opened for, if any: `/u/HANDLE`, or the 404 page's `/?go=/u/HANDLE`. */
export function profileFrom(loc: Pick<Location, 'pathname' | 'search'>): string | null {
  const go = new URLSearchParams(loc.search).get('go');
  const path = go && go.startsWith('/') ? go.split(/[?#]/)[0] : loc.pathname;
  const m = /^\/u\/@?([A-Za-z0-9_]{3,20})\/?$/.exec(path);
  return m ? m[1] : null;
}
