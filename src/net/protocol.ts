// Online play's wire protocol: every message between a client and its room, and the limits both
// sides hold to. See docs/online/ARCHITECTURE.md. The server validates each ClientMsg against
// src/net/schema.ts before it reaches the room; the client trusts ServerMsg only as far as the
// engine's own checks go.

import type { Action, Card, CardCounts, GameOptions, Knobs, ModuleId, PlayerId } from '../engine';
import type { BotDifficulty } from '../engine/ai/profiles';
import type { WireEvent } from '../engine/visibility';
import type { PatchOp, WireView } from '../engine/wire';

/** Bumped whenever a message changes shape; a client on another version is told to reload. */
export const PROTO = 1;

// ------------------------------------------------------------------ limits

/** The longest client frame the server reads (bytes). */
export const MAX_FRAME = 4096;
/** Messages per second per socket, and the burst allowed above it. */
export const RATE_PER_SECOND = 20;
export const RATE_BURST = 40;
/** A resuming client this many records behind or fewer gets them as one batch; further, a snapshot. */
export const RESYNC_BATCH_MAX = 64;
/** A view hash rides on every this many records. */
export const HASH_EVERY = 16;
/** Chat: characters a line, lines kept by a room, lines a seat may send in 10 s. */
export const CHAT_MAX = 240;
export const CHAT_KEEP = 200;
export const CHAT_BURST = 5;
/** A bot's think time on the server (ms). */
export const BOT_THINK_MIN = 500;
export const BOT_THINK_MAX = 1350;
/** A seat goes to a bot after this many timer expiries in a row, or this long gone on its own turn. */
export const AFK_EXPIRIES = 2;
export const AFK_GONE_MS = 30_000;
/**
 * A person's clock starts once everyone at the table has shown the move that started it (their
 * `seen`), and at the latest this long after its records' own waits (a device that never says).
 */
export const SEEN_CAP_MS = 4000;
/** A seat everyone waits on may be hailed once this long has passed (the room holds each person to one hail every NUDGE_GAP_MS). */
export const HAIL_AFTER_MS = 30_000;
export const NUDGE_GAP_MS = 30_000;
/** A seat's (or the quay's) reactions: one in this long; the rest are let go. */
export const REACT_GAP_MS = 1500;
/** A harbour nobody is in is closed after this long. */
export const HARBOUR_IDLE_MS = 10 * 60_000;
/** A finished room keeps its summary (Sail again, the results card) this long. */
export const OVER_KEEP_MS = 7 * 24 * 3_600_000;
/**
 * Custom maps sent to a room: their JSON at most this long, and at most this many harbours. (The
 * engine's checkRoomMap holds the same numbers, as ROOM_MAP_MAX_BYTES and ROOM_MAP_MAX_HARBOURS in
 * src/engine/maps/custom.ts: the engine doesn't import the protocol. A test keeps them equal.)
 */
export const CUSTOM_MAP_MAX_BYTES = 64 * 1024;
export const CUSTOM_MAP_MAX_HARBOURS = 18;
/** Display names. */
export const NAME_MAX = 24;

/**
 * The heartbeat: a client sends PING every 25 s and the runtime answers PONG itself (a Durable
 * Object's WebSocket auto-response), without waking the room.
 */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';

// ------------------------------------------------------------------ room codes and links

/** No vowels (no words), no 0/O/1/I/L (no misreading). 28^6 ≈ 4.8e8 codes. */
export const ROOM_CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_RE = /^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$/;

// ------------------------------------------------------------------ timers

/**
 * How long a seat has to act (seconds): a turn, the extra a turn gets per action, a single decision
 * owed out of turn (a discard, a trade answer).
 */
export type TimerPreset = 'relaxed' | 'standard' | 'brisk' | 'off';
export const TIMERS: Record<TimerPreset, { turn: number; bonus: number; decision: number } | null> = {
  relaxed: { turn: 150, bonus: 10, decision: 45 },
  standard: { turn: 90, bonus: 6, decision: 30 },
  brisk: { turn: 45, bonus: 4, decision: 15 },
  off: null,
};

/** Clock state as the server sees it, in the server's epoch ms (`now` lets a client correct its skew). */
export interface Timers {
  now: number;
  /** The seat the clock runs for, and when it runs out (absent: no clock). */
  seat?: PlayerId;
  endsAt?: number;
  /** Seats owing a decision out of turn (discard, trade answer) and when theirs runs out. */
  owed?: { seat: PlayerId; endsAt: number }[];
  /** The clocks are stopped (pause vote, everyone away). */
  paused?: boolean;
}

// ------------------------------------------------------------------ rooms and seats

export type SeatKind = 'open' | 'human' | 'bot';

export interface SeatInfo {
  seat: PlayerId;
  kind: SeatKind;
  name: string;
  color: string;
  /** Avatar code (ui/Avatar.tsx), or a bot's portrait. */
  avatar?: number;
  /** The occupant's public id (a guest's or an account's; never a secret). */
  user?: string;
  /** The occupant's public handle, for an account (links to /u/HANDLE). */
  handle?: string;
  ready?: boolean;
  online?: boolean;
  /** A bot is playing this person's seat while they're away. */
  away?: boolean;
  /** They conceded: the crew plays their seat to the end, and it isn't theirs to take back. */
  conceded?: boolean;
  difficulty?: BotDifficulty;
  /** Rating tier and its value, for rated games. */
  tier?: string;
  rating?: number;
  /** "Fair winds": the share of their recent games they saw through (0..1), when known. */
  reliability?: number;
  /**
   * "Looking for" and "Spare": the cards this person says they want and would part with, for
   * everyone to read (their own word, never their hand), until the end of their own turn.
   */
  wants?: { looking: Card[]; spare: Card[] };
}

/** What the host sets in the harbour. Validated on the server: knobs only from presets. */
export interface RoomSettings {
  /** Seats at the table. */
  seats: 3 | 4;
  /** A preset id (presets.ts) or 'custom'. */
  preset: string;
  modules: ModuleId[];
  map: string;
  layout: GameOptions['layout'];
  numberPlacement: GameOptions['numberPlacement'];
  victoryPoints: number;
  friendlyRobber: boolean;
  eventDeck: boolean;
  knobs: Partial<Knobs>;
  /** A custom map's id (uploaded with POST /api/maps), when map is 'custom'. */
  customMapId?: string;
  timer: TimerPreset;
  /** Who may watch: anyone with the link, or nobody. */
  spectators: 'link' | 'none';
  /** Bots take the seats nobody claims when the host starts. */
  botsFill: boolean;
  botDifficulty: BotDifficulty;
  /** Take-backs of a piece just placed (the engine's undo). */
  takeBacks: boolean;
  /** Free chat (quick talk is always on). */
  freeChat: boolean;
  /** Counted for ratings (the host's choice). */
  rated: boolean;
}

export type RoomPhase = 'harbour' | 'playing' | 'over' | 'abandoned';

export interface RoomInfo {
  code: string;
  phase: RoomPhase;
  settings: RoomSettings;
  seats: SeatInfo[];
  /** The seat (or, before taking one, the public id) of the room's host. */
  host: string;
  spectators: number;
  createdAt: number;
  /** Set once play starts: the dice commitment C (see ARCHITECTURE.md, "Fair dice"). */
  commit?: string;
  /** A pause asked for: who asked, the seats that agreed, and whether enough did (`on`: the clocks and the crew are stopped). */
  pause?: { by: PlayerId; votes: PlayerId[]; at: number; on?: boolean } | null;
  /** The game's results, once it is over. */
  results?: Results;
  /** "Sail again": the code of the room this one's seats were invited to, once someone asked. */
  rematch?: string;
}

export interface Results {
  winner: PlayerId | null;
  /** Final standing, best first. */
  standings: { seat: PlayerId; points: number; conceded?: boolean; away?: boolean }[];
  turns: number;
  durationMs: number;
  /** The replay of this game (GET /api/replays/:id). */
  replay?: string;
  /** Rating changes for rated games. */
  ratings?: { seat: PlayerId; before: number; after: number; tier: string }[];
  /** Highlights for the results card: longest route, biggest army, most trades, luckiest roller... */
  awards?: { seat: PlayerId; award: string; value?: number }[];
}

// ------------------------------------------------------------------ table talk

/** Quick talk: words every client can show in the player's language, so they need no moderation. */
export const QUICK_TALK = [
  'hello', 'goodLuck', 'niceMove', 'thanks', 'sorry', 'oops', 'wellPlayed', 'goodGame',
  'oneMoment', 'yourTurn', 'anyWool', 'anyGrain', 'anyLumber', 'anyBrick', 'anyOre', 'noTrades', 'deal', 'noDeal',
] as const;
export type QuickTalk = (typeof QUICK_TALK)[number];

export const REACTIONS = ['wave', 'laugh', 'wow', 'cheer', 'groan', 'think', 'heart', 'anchor'] as const;
export type Reaction = (typeof REACTIONS)[number];

export const REPORT_REASONS = ['abuse', 'cheating', 'spam', 'name', 'afk', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ChatLine {
  id: number;
  at: number;
  /** The seat that spoke; null for the table (a notice) and for spectators. */
  from: PlayerId | null;
  /** Free text (already filtered on the server), or a quick-talk word. */
  text?: string;
  quick?: QuickTalk;
  /** A bot's table talk (server-side TableTalk). */
  bot?: boolean;
  /** Only to this seat (a bot's word to you, a whisper). */
  to?: PlayerId;
  /** A deal a bot would take, offered to `to` with one click (only server bots attach one; from the asker's side: give, get). */
  offer?: { give: CardCounts; get: CardCounts };
}

// ------------------------------------------------------------------ client → server

export type NackCode = 'stale' | 'rule' | 'bad' | 'order' | 'slow' | 'auth';

export type ClientMsg =
  /** First message on every socket. `last`/`hash`: a reconnect, from that seq. `watch`: as a spectator. */
  | { t: 'hello'; proto: number; build: string; token: string; last?: number; hash?: string; watch?: boolean; seat?: string }
  // Harbour (before play)
  | { t: 'claim'; seat: PlayerId; name?: string; color?: string; avatar?: number }
  | { t: 'unclaim' }
  | { t: 'ready'; on: boolean }
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'seatBot'; seat: PlayerId; difficulty: BotDifficulty | null }
  | { t: 'kick'; seat: PlayerId }
  // (`force`: the host sets sail though someone seated isn't ready yet, having been asked.)
  | { t: 'start'; force?: boolean }
  // Play
  | { t: 'entropy'; nonce: string }
  | { t: 'act'; n: number; at: number; a: Action }
  | { t: 'seen'; seq: number }
  | { t: 'back' }
  | { t: 'pause'; on: boolean }
  | { t: 'concede' }
  | { t: 'nudge'; seat: PlayerId }
  /** Looking for / Spare (each kind once, none in both; empty lists clear it). */
  | { t: 'wants'; looking: Card[]; spare: Card[] }
  // Table talk
  | { t: 'chat'; text?: string; quick?: QuickTalk }
  | { t: 'react'; r: Reaction }
  | { t: 'typing'; on: boolean }
  // Seats and safety
  | { t: 'transfer'; seat: PlayerId } // host: hand the host's role to this seat
  | { t: 'handoff' } // make a transfer link for my seat (another device takes it; mine stops working)
  | { t: 'report'; seat: PlayerId; reason: ReportReason; note?: string }
  | { t: 'rematch' }
  | { t: 'leave' };

// ------------------------------------------------------------------ server → client

/** One game record as a seat sees it. */
export interface GameRecord {
  seq: number;
  actor: PlayerId;
  /** The whole action for its own actor; `{type}` for everyone else (actionFor). */
  a: Action | { type: Action['type'] };
  e: WireEvent[];
  /** Patch from this seat's previous view to the one after this record. */
  p: PatchOp[];
  /** viewHash of the view after this record, every HASH_EVERY records. */
  h?: string;
  /** The intent this answers, for the actor (cumulative ack). */
  ackN?: number;
  timers?: Timers;
  /** The pause (ms) a client holds before presenting this record: a bot's think time, so a whole bot run can go out as one batch. */
  wait?: number;
}

export interface You {
  /** The seat you hold, or null watching or in the harbour without one. */
  seat: PlayerId | null;
  user: string;
  host: boolean;
  watch: boolean;
  /** Your seat's generation: a newer one elsewhere (a hand-off) ends this socket. */
  gen?: number;
  /** The last intent number the room has from your seat (number the next one above it, after a reload too). */
  ackN?: number;
  /** Your papers say quick talk only: free text is neither yours to send nor shown to you. */
  quick?: boolean;
}

export type NoticeKind =
  | 'nudged' | 'kicked' | 'hostChanged' | 'paused' | 'resumed' | 'away' | 'back' | 'conceded'
  | 'left' | 'joined' | 'timeout' | 'handedOff' | 'reported' | 'abandoned' | 'starting';

export type ServerMsg =
  | { t: 'welcome'; proto: number; you: You; room: RoomInfo; chat: ChatLine[] }
  | { t: 'room'; room: RoomInfo }
  /** A whole view: on start, on a resume too far behind, or after a hash mismatch. */
  | { t: 'snap'; seq: number; view: WireView; hash: string; initialEvents?: WireEvent[]; timers?: Timers; ackN?: number }
  | ({ t: 'g' } & GameRecord)
  | { t: 'gb'; list: GameRecord[] }
  | { t: 'nack'; n: number; code: NackCode; error: string; ackN?: number }
  | { t: 'chat'; line: ChatLine }
  | { t: 'react'; from: PlayerId | null; r: Reaction }
  | { t: 'typing'; seat: PlayerId; on: boolean }
  | { t: 'presence'; seats: { seat: PlayerId; online: boolean; away: boolean }[]; spectators: number }
  | { t: 'timers'; timers: Timers }
  | { t: 'notice'; kind: NoticeKind; seat?: PlayerId; text?: string }
  /** A transfer link's token for your seat (put in a #fragment, never a query). */
  | { t: 'handoff'; token: string }
  | { t: 'upgrade'; need: number }
  /** Game over: the dice key, the seats' nonces and the whole log, so anyone can check every roll. */
  | { t: 'reveal'; key: string; nonces: (string | null)[]; log: { actor: PlayerId; action: Action }[]; options: Partial<GameOptions> }
  | { t: 'error'; code: string; error: string };

// ------------------------------------------------------------------ HTTP shapes

export interface FeatureFlags {
  online: boolean;
  guests: boolean;
  passkeys: boolean;
  google: boolean;
  apple: boolean;
  discord: boolean;
  email: boolean;
  push: boolean;
  turnstile: boolean;
  og: boolean;
}

export interface ServerConfig {
  proto: number;
  build: string;
  features: FeatureFlags;
  vapidPublicKey?: string;
  turnstileSiteKey?: string;
}

/** A signed-in identity as the client holds it (the token is a bearer secret: localStorage only). */
export interface Identity {
  user: string;
  token: string;
  name: string;
  /** Present for an account (not a guest). */
  handle?: string;
  guest: boolean;
}
