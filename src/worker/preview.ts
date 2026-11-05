// What a shared link shows when it's pasted into a chat (Discord, iMessage, Slack, X...): the
// page's own card for the game itself (index.html), and these for the links that say more: an
// invitation to play, a room's link, and the crew at play with a clip of the island rising.
//
// Kept small on purpose: a square picture, which the chats show as a thumbnail beside the text
// rather than a banner across the conversation (a wide picture with `summary_large_image` drew a
// card most of a phone's screen tall in Discord). The clip of the island rising goes with the watch
// link and with the game's own link, in every chat (Discord draws it as a player).
//
// Pure (no Worker APIs), so it can be tested; src/worker/index.ts writes it into the page.

export interface Preview {
  title: string;
  description: string;
  /** Where the link leads, as the card names it (the link itself). */
  url: string;
  image: { path: string; width: number; height: number; alt: string };
  /** A clip for the card (only the watch link's). */
  video?: { path: string; width: number; height: number };
  /** `summary`: a thumbnail beside the text; `summary_large_image`: a picture across the card. */
  card: 'summary' | 'summary_large_image';
  /** Kept out of search results: invitations and rooms are for the people they're sent to. */
  noindex: boolean;
}

/**
 * The clip: the island rising out of the sea at a game's start and sinking back, the camera ending
 * where it began, so it plays round without a seam (16 s, H.264, 4.7 MB, recorded by
 * scripts/capture/trailer.mjs).
 */
// (Named with its version: the files under /social are kept a day wherever they're fetched, so a
// new cut under the old name went on showing the old one.)
export const TRAILER = { path: '/social/trailer.mp4?v=5', width: 1280, height: 720 };

/** A room's code as the room server will hand them out: letters and digits, read in capitals. */
const ROOM = /^[A-Za-z0-9]{3,10}$/;

/** Who sent the link, as they gave their name: one line, no markup, a name's length. */
export function senderName(raw: string | null): string | null {
  if (!raw) return null;
  // (Control characters, angle brackets and runs of space go; the rest is shown as text.)
  const name = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return null;
  return [...name].length > 24 ? [...name].slice(0, 23).join('').trimEnd() + '…' : name;
}

const PLAYS = 'It plays in your browser, on a computer or a phone: free, with no sign-up.';

/** The card for `url`, or null for a link that shows the game's own (index.html's). */
export function previewFor(url: URL): Preview | null {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const from = senderName(url.searchParams.get('from'));
  const link = url.origin + path + (from ? `?from=${encodeURIComponent(from)}` : '');
  const join = /^\/join\/([^/]+)$/.exec(path);
  if (join && ROOM.test(join[1])) {
    const code = join[1].toUpperCase();
    return {
      title: from ? `${from} saved you a seat · room ${code}` : `Join room ${code} on Hexplorers`,
      description: `A game of Hexplorers is waiting for you in room ${code}. Sail, trade and prosper on the same 3D island together. ${PLAYS}`,
      url: link,
      image: { path: '/social/room.jpg?v=5', width: 600, height: 600, alt: 'The island as a flat chart, its hexes numbered and roads and houses drawn in each player’s colour.' },
      card: 'summary',
      noindex: true,
    };
  }
  if (path === '/invite') {
    return {
      title: from ? `${from} invited you to Hexplorers` : 'You’re invited to Hexplorers',
      description: `Come and sail, trade and prosper on a living 3D island, against a crew of computer players. ${PLAYS}`,
      url: link,
      image: { path: '/social/invite.jpg?v=5', width: 600, height: 600, alt: 'An island of hexagonal fields and forests seen from above, with houses, roads and harbours in each player’s colour.' },
      card: 'summary',
      noindex: true,
    };
  }
  if (path === '/watch') {
    return {
      title: 'Watch the crew play Hexplorers',
      description: 'Four computer players sail, trade and prosper on a living 3D island, through changing weather and nightfall. Pull up a chair, then start a game of your own.',
      url: url.origin + '/watch',
      image: { path: '/social/watch.jpg?v=5', width: 1280, height: 720, alt: 'The island risen out of the sea, its harbours built round the coast, their boats moored at the piers.' },
      video: TRAILER,
      card: 'summary_large_image',
      noindex: false,
    };
  }
  return null;
}
