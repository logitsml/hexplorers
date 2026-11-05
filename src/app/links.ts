// The links the game can be opened from besides its own address (each with a card of its own when
// it's shared: see src/worker/preview.ts): /watch, a game of the crew to watch; /invite, an
// invitation to play (?from= who sent it); and /join/CODE, a room's link, for online play once
// it's here. Read once as the page opens; the address is then the game's own again, so a reload
// or a link copied from the bar is the plain game (bar /watch, which is what a reload should do).

import { senderName } from '../worker/preview';

export interface Arrival {
  /** Opened from the watch link (as ?watch). */
  watch: boolean;
  /** A room's code, from its link. */
  room: string | null;
  /** Who sent the invitation or the room's link, if they said. */
  from: string | null;
}

function arrive(): Arrival {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const room = /^\/join\/([A-Za-z0-9]{3,10})$/.exec(path)?.[1].toUpperCase() ?? null;
  const from = senderName(new URLSearchParams(location.search).get('from'));
  const watch = path === '/watch';
  if (room || path === '/invite') history.replaceState(history.state, '', '/');
  // The tab says only the game's name: the page's longer title is for search results, and a
  // card's (written in by the Worker) for the chat the link was sent to.
  document.title = 'Hexplorers';
  return { watch, room, from };
}

export const arrival: Arrival = arrive();
