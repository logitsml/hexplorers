// What the client knows of the room it is in: the room itself (settings, seats and who's there),
// who you are in it, the harbour's chat, the clocks and the connection. Fed by RoomClient
// (client.ts) from the server's messages; read by the harbour and the table's online overlays.
// The game itself is not here: it goes through RemoteHost to the presenter and the game's store.

import { create } from 'zustand';
import type { PlayerId } from '../engine';
import type { ChatLine, NoticeKind, Reaction, RoomInfo, SeatInfo, ServerMsg, Timers, You } from '../net/protocol';

/**
 * The socket's state. 'connecting': the first time; 'open': welcomed; 'reconnecting': lost and
 * trying again (after a backoff); 'offline': the device says it has no network, so it waits for
 * it; 'closed': left, refused or replaced, for good.
 */
export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'closed';

export interface OnlineNotice {
  id: number;
  kind: NoticeKind | 'error';
  seat?: PlayerId;
  text: string;
  /** Said here, not by the room (that you hailed someone). */
  local?: boolean;
}

/** A reaction as it floats up from its sender's panel (or the quay's count), a moment each. */
export interface FloatingReaction {
  id: number;
  from: PlayerId | null;
  r: Reaction;
}

export interface OnlineStore {
  /** The room's code (null: in no room). */
  code: string | null;
  watch: boolean;
  link: LinkState;
  /** Why the link closed for good (a room that doesn't exist, a seat handed to another device). */
  closedWhy: string | null;
  /** The seat went to another tab or device: this one can take it back. */
  rejoin: boolean;
  you: You | null;
  room: RoomInfo | null;
  /** The harbour's chat (in a game the table talk carries it, in the game's store). */
  chat: ChatLine[];
  /** The clocks as last sent, and the server's time less this device's when they came. */
  timers: Timers | null;
  skew: number;
  /** Who is typing in the chat. */
  typing: Record<number, boolean>;
  /** The reactions floating up just now. */
  reactions: FloatingReaction[];
  /** When you last hailed someone (this device's clock): the next waits out the room's gap. */
  hailedAt: number | null;
  /** The last few notices, for the harbour's and the table's toasts. */
  notices: OnlineNotice[];
  /** A transfer link's token for your seat, once asked for (memory only: never stored, never logged). */
  handoff: string | null;
  /** The server runs a newer protocol: this page has to reload. */
  upgrade: boolean;
  /** The game has started (or was under way when you came in): the island is being raised. */
  playing: boolean;
  /** Another tab of this browser is aboard this room as the same sailor: the harbour asks which this tab is to be. */
  twin: boolean;
  /** Game over: the dice key, the seats' nonces and the whole log, to check every roll by (kept for the results card). */
  reveal: Extract<ServerMsg, { t: 'reveal' }> | null;
  set: (p: Partial<OnlineStore>) => void;
  notice: (n: Omit<OnlineNotice, 'id'>, ms?: number) => void;
  react: (from: PlayerId | null, r: Reaction, ms?: number) => void;
}

let ids = 1;

export const EMPTY_ROOM = { code: null, watch: false, link: 'closed', closedWhy: null, rejoin: false, you: null, room: null, chat: [], timers: null, skew: 0, typing: {}, reactions: [], hailedAt: null, notices: [], handoff: null, upgrade: false, playing: false, twin: false, reveal: null } satisfies Omit<OnlineStore, 'set' | 'notice' | 'react'>;

/** How long a reaction floats; at most this many at once (a busy table's are let go). */
export const REACTION_MS = 1800;
const REACTIONS_AT_ONCE = 6;

export const useOnline = create<OnlineStore>((set, get) => ({
  ...EMPTY_ROOM,
  set,
  notice: (n, ms = 4200) => {
    const id = ids++;
    set({ notices: [...get().notices.slice(-3), { ...n, id }] });
    setTimeout(() => set({ notices: get().notices.filter((x) => x.id !== id) }), ms);
  },
  react: (from, r, ms = REACTION_MS) => {
    const id = ids++;
    set({ reactions: [...get().reactions.slice(-(REACTIONS_AT_ONCE - 1)), { id, from, r }] });
    setTimeout(() => set({ reactions: get().reactions.filter((x) => x.id !== id) }), ms);
  },
}));

/** The seat this client holds in the room, if any. */
export function mySeat(s: Pick<OnlineStore, 'you' | 'room'>): SeatInfo | null {
  const seat = s.you?.seat;
  return seat === null || seat === undefined ? null : (s.room?.seats.find((x) => x.seat === seat) ?? null);
}

/** Whether you are the room's host (`room.host` names a seat, or a public id before one is taken). */
export function amHost(s: Pick<OnlineStore, 'you' | 'room'>): boolean {
  if (!s.you || !s.room) return false;
  return s.you.host || s.room.host === s.you.user || (s.you.seat !== null && s.room.host === String(s.you.seat));
}

/** A server time (epoch ms) as this device's clock reads it. */
export const localTime = (serverMs: number, skew: number) => serverMs - skew;
