// The host of an online game, on the client: the GameHost the presenter plays through when the
// room on the server is the authority. It holds this seat's WireView, applies each record's patch
// to it (checking the view's hash whenever one rides along), and hands the presenter the same
// { actor, action, events, state } messages LocalHost would, the state inflated from the view and
// the events with their secrets left out. Moves are checked here against the newest view (a seat
// has every legal choice its full state would give it), sent as intents, and refused later if the
// room won't have them. A bot run comes as one batch with each record's think time on it: those
// are held back here, one after another as each is shown, so the bots seem to think as they do in
// a game against the crew.

import { applyAction, type Action, type GameEvent, type GameState, type PlayerId } from '../engine';
import { KEYLESS_DRAW } from '../engine/ctx';
import type { BotDifficulty } from '../engine/ai';
import type { BotProfile } from '../engine/ai/profiles';
import type { WireEvent } from '../engine/visibility';
import { applyPatch, inflateView, viewHash, type WireView } from '../engine/wire';
import { botProfile, type BotDecision, type GameHost, type HostClock, type HostMessage, type SubmitResult } from '../game/host';
import type { ClientMsg, GameRecord, NackCode, SeatInfo, ServerMsg } from '../net/protocol';

/** A snapshot as the server sends it. */
export type Snap = Extract<ServerMsg, { t: 'snap' }>;

export interface RemoteHostOptions {
  /** Your seat, or null watching from the quay. */
  seat: PlayerId | null;
  snap: Snap;
  seats: SeatInfo[];
  send: (m: ClientMsg) => boolean;
  /**
   * Ask the room again: a record missing (a gap in the sequence) or a view that has gone wrong (a
   * hash that doesn't match). The client reconnects; its hello carries `resumeInfo()`.
   */
  resync: () => void;
  clock?: HostClock;
  /** What a record's think time is multiplied by: the bot pace over the animation speed (1 when absent). */
  waitScale?: () => number;
  /** The last move the room has from this seat (welcome's `you.ackN`): this host numbers its own after it. */
  ackN?: number;
}

/** Released but not yet shown this many records behind, the presentation hurries (and skips the bots' pauses). */
export const CATCH_UP_BEHIND = 4;
/**
 * This many records received and not yet shown, the presentation has fallen behind the room
 * itself (a hidden tab, a slow device at a quick table: more than a bot run's worth), and hurries
 * until it is nearly level again.
 */
export const CATCH_UP_LAG = 16;
/** A move sent and not answered in this long is let go: the guard against a second one lifts. */
export const INFLIGHT_MS = 8000;
/** The longest the next bot move waits on the presenter to report the last one shown. */
export const PRESENT_CAP_MS = 20_000;
/**
 * The room hears how far this seat has shown the game at most this often (the newest only): a run
 * or a catch-up shown quickly would otherwise spend the socket's allowance of messages (20 a
 * second), and the move that follows it would be refused as too many.
 */
export const SEEN_EVERY_MS = 400;

const realClock: HostClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Trade answers name the offer they answer, so an answer to an offer that has moved on is refused. */
const ANSWERS = new Set<Action['type']>(['respondTrade', 'counterTrade', 'acceptTrade', 'cancelTrade']);

/** Accepting an answer to your offer that the room says the partner can still pay for (TradeOffer.readiness). */
function partnerReady(s: GameState, a: Action): boolean {
  if (a.type !== 'acceptTrade') return false;
  const r = s.trade?.readiness;
  return !!r && (a.counter ? r.counters : r.accepted).includes(a.partner);
}

/** A refusal in words, the server's own reason where it gives one that helps. */
export function nackText(code: NackCode, error: string): string {
  switch (code) {
    case 'stale':
      return 'Too late: the table had moved on';
    case 'slow':
      return 'One move at a time, please';
    case 'auth':
      return 'This seat isn’t yours any more';
    default:
      return error || 'That move was refused';
  }
}

interface Held {
  msg: HostMessage;
  wait: number;
  /** Its think time has run (or is running): it goes as soon as it may. */
  waited: boolean;
}

export class RemoteHost implements GameHost {
  readonly remote = true;
  readonly scripted = false;
  readonly scriptProgress = null;
  /** The room's game is paused (a vote, everyone away): set by the room's client. */
  paused = false;
  onError: ((error: string) => void) | null = null;
  readonly me: PlayerId | null;
  readonly initialEvents: GameEvent[];
  /** The game was under way when this client came in (a snapshot without the opening's events): its pieces are shown, not introduced. */
  readonly resumed: boolean;

  /** The newest view received, its record number and the game it inflates to (built when first asked for). */
  private view: WireView;
  private seq: number;
  private latest: GameState | null = null;
  /** What the presenter has been handed, and how far it has reported showing it. */
  private shown: GameState;
  private shownSeq: number;
  private presentedSeq: number;
  /** Records received and not yet handed over (a bot's think time, or one still to be shown ahead of them). */
  private held: Held[] = [];
  private holdTimer: unknown = null;
  private stallTimer: unknown = null;
  /** The last `seen` sent (its record, and when), and the one waiting to go after it. */
  private seenSeq = -1;
  private seenAt = -Infinity;
  private seenTimer: unknown = null;
  /** Records up to this one came in as a catch-up (a resume): shown quickly, without the bots' pauses. */
  private catchUpTo = -1;
  /** Fallen behind the room by more than a bot run (see CATCH_UP_LAG), until nearly level again. */
  private lagging = false;
  private listeners = new Set<(m: HostMessage) => void>();
  private seats: SeatInfo[];
  private n = 0;
  private inflight: { n: number; key: string; timer: unknown } | null = null;
  /** The view went wrong: the next resume asks for it whole. */
  private desynced = false;
  /** The presenter has shown the game it began from (its intro): until then nothing is handed over. */
  private started = false;
  private disposed = false;
  private clock: HostClock;

  constructor(private o: RemoteHostOptions) {
    this.me = o.seat;
    this.seats = o.seats;
    this.clock = o.clock ?? realClock;
    this.view = o.snap.view;
    this.seq = this.shownSeq = this.presentedSeq = o.snap.seq;
    // (After a reload, or on the device a seat was handed to, the room already has moves from this
    // seat: one numbered at or below them would be taken for one it had.)
    this.n = Math.max(o.ackN ?? 0, o.snap.ackN ?? 0);
    this.shown = inflateView(this.view, this.me);
    this.initialEvents = (o.snap.initialEvents ?? []) as GameEvent[];
    this.resumed = o.snap.initialEvents === undefined;
  }

  get state(): GameState {
    return this.shown;
  }

  /** The newest game received (what a move is checked against), which may be ahead of `state`. */
  get newest(): GameState {
    return (this.latest ??= inflateView(this.view, this.me));
  }

  /** The newest record received. */
  get lastSeq() {
    return this.seq;
  }

  /** Watching: from the quay, or at a seat you conceded (the crew sails it; nothing prompts you for it). */
  get spectator() {
    return this.me === null || !!this.seat(this.me)?.conceded;
  }

  /** Records received but not yet handed to the presenter. */
  get backlog() {
    return this.held.length;
  }

  get catchUp() {
    return this.lagging || this.presentedSeq < this.catchUpTo || this.shownSeq - this.presentedSeq >= CATCH_UP_BEHIND;
  }

  private gauge() {
    const behind = this.seq - this.presentedSeq;
    if (behind >= CATCH_UP_LAG) this.lagging = true;
    else if (behind <= 1) this.lagging = false;
  }

  /** What a reconnect's hello says it has (null: ask for the view whole). */
  resumeInfo(): { last: number; hash: string } | null {
    return this.desynced ? null : { last: this.seq, hash: viewHash(this.view) };
  }

  /** The seats as the room now has them (who is a bot, at what difficulty). */
  setSeats(seats: SeatInfo[]) {
    this.seats = seats;
  }

  subscribe(fn: (m: HostMessage) => void) {
    this.listeners.add(fn);
    // (Records that came while the island was being raised wait for the presenter to listen.)
    this.pump();
    return () => void this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------ the room's messages

  /**
   * A game message from the room. `catchUp`: these records are what was missed while away (the
   * first batch after a resume), to be shown quickly.
   */
  receive(m: ServerMsg, o: { catchUp?: boolean } = {}) {
    if (this.disposed) return;
    switch (m.t) {
      case 'snap':
        this.snap(m);
        break;
      case 'g':
        this.record(m);
        break;
      case 'gb':
        for (const r of m.list) if (!this.record(r)) break;
        if (o.catchUp && m.list.length) this.catchUpTo = Math.max(this.catchUpTo, m.list[m.list.length - 1].seq);
        break;
      case 'nack':
        this.nack(m.n, m.code, m.error);
        if (m.ackN !== undefined) this.ack(m.ackN);
        return;
      default:
        return;
    }
    this.gauge();
    this.pump();
  }

  /** A whole view: the game jumps to it (what was held is superseded), as soon as the presenter may take it. */
  private snap(m: Snap) {
    if (viewHash(m.view) !== m.hash) console.warn(`online: the snapshot at ${m.seq} doesn't hash as the room said`);
    if (m.ackN !== undefined) this.n = Math.max(this.n, m.ackN);
    this.view = m.view;
    this.seq = m.seq;
    this.latest = null;
    this.desynced = false;
    if (this.holdTimer !== null) this.clock.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.clearInflight();
    // (A room that started its count again is followed.)
    this.presentedSeq = Math.min(this.presentedSeq, m.seq);
    this.catchUpTo = -1;
    this.held = [{ msg: { actor: null, action: null, events: [], state: this.newest, seq: m.seq, jump: true }, wait: 0, waited: true }];
  }

  /** One record: patched in, checked, and held for its turn. False when the view had to be asked for again. */
  private record(r: GameRecord): boolean {
    if (r.ackN !== undefined) this.ack(r.ackN);
    if (this.desynced) return false;
    // (Already had: a resume's batch can overlap what came before the drop.)
    if (r.seq <= this.seq) return true;
    if (r.seq !== this.seq + 1) {
      // A record went missing: the resume's batch brings it, and the ones after it.
      console.warn(`online: record ${this.seq + 1} missing (got ${r.seq}); resuming`);
      this.o.resync();
      return false;
    }
    let next: WireView;
    try {
      next = applyPatch(this.view, r.p);
    } catch (e) {
      console.warn(`online: record ${r.seq}'s patch doesn't apply; asking for the view`, e);
      return this.lost();
    }
    if (r.h !== undefined && viewHash(next) !== r.h) {
      console.warn(`online: the view after record ${r.seq} doesn't match the room's; asking for it whole`);
      return this.lost();
    }
    this.view = next;
    this.seq = r.seq;
    this.latest = null;
    const msg: HostMessage = { actor: r.actor, action: r.a as Action, events: r.e as WireEvent[] as GameEvent[], state: this.newest, seq: r.seq };
    this.held.push({ msg, wait: Math.max(0, r.wait ?? 0), waited: false });
    return true;
  }

  /** The view can't be trusted: drop what's held of it and ask for it whole. */
  private lost(): boolean {
    this.desynced = true;
    this.held = [];
    this.o.resync();
    return false;
  }

  // ------------------------------------------------------------------ handing records over

  /**
   * Hand over what may go now, in order. A record with a think time waits until the one before it
   * has been shown and then for its pause (scaled as the bots' own are in a local game); one
   * without (a person's move) goes at once. Catching up, nothing waits.
   */
  private pump() {
    if (this.disposed || !this.started) return;
    if (this.holdTimer !== null) {
      // (A pause under way is cut short once the presentation has to catch up.)
      if (!this.catchUp) return;
      this.clock.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    while (this.held.length && this.listeners.size) {
      const head = this.held[0];
      if (head.wait > 0 && !this.catchUp && !head.waited) {
        if (this.presentedSeq < this.shownSeq) {
          this.watchStall();
          return;
        }
        head.waited = true;
        const ms = head.wait * Math.max(0, this.o.waitScale?.() ?? 1);
        if (ms >= 1) {
          this.holdTimer = this.clock.setTimeout(() => {
            this.holdTimer = null;
            this.pump();
          }, ms);
          return;
        }
      }
      this.held.shift();
      this.release(head.msg);
    }
  }

  private release(m: HostMessage) {
    this.shown = m.state;
    this.shownSeq = m.seq ?? this.shownSeq;
    for (const l of this.listeners) l(m);
  }

  /** A presenter that never says it has shown a record mustn't hold the bots' moves for ever. */
  private watchStall() {
    if (this.stallTimer !== null) return;
    const at = this.presentedSeq;
    this.stallTimer = this.clock.setTimeout(() => {
      this.stallTimer = null;
      if (this.presentedSeq === at && this.presentedSeq < this.shownSeq) this.presentedSeq = this.shownSeq;
      this.pump();
    }, PRESENT_CAP_MS);
  }

  /**
   * The presenter has shown the game up to `seq` (all it was handed, when absent: at first, the
   * game it began from): the room hears it, and the next record may come.
   */
  presented(seq = this.shownSeq) {
    if (this.disposed) return;
    const first = !this.started;
    this.started = true;
    if (first || seq > this.presentedSeq) {
      this.presentedSeq = Math.max(this.presentedSeq, Math.min(seq, this.shownSeq));
      if (this.stallTimer !== null) this.clock.clearTimeout(this.stallTimer);
      this.stallTimer = null;
      this.reportSeen();
    }
    this.gauge();
    this.pump();
  }

  /** Tell the room how far this seat has shown the game: now, or (just told) once SEEN_EVERY_MS has passed. */
  private reportSeen() {
    // (Only a seat's pace holds the bots; the quay's doesn't.)
    if (this.me === null || this.seenTimer !== null || this.presentedSeq <= this.seenSeq) return;
    const wait = this.seenAt + SEEN_EVERY_MS - this.clock.now();
    if (wait > 0) {
      this.seenTimer = this.clock.setTimeout(() => {
        this.seenTimer = null;
        if (!this.disposed) this.reportSeen();
      }, wait);
      return;
    }
    this.seenSeq = this.presentedSeq;
    this.seenAt = this.clock.now();
    this.o.send({ t: 'seen', seq: this.presentedSeq });
  }

  // ------------------------------------------------------------------ your moves

  submit(actor: PlayerId, action: Action): SubmitResult {
    if (this.disposed) return { ok: false, error: 'The game has ended.' };
    if (this.me === null) return { ok: false, error: 'You are watching this game.' };
    if (actor !== this.me) return { ok: false, error: 'That isn’t your seat.' };
    const a = this.withOffer(action);
    const key = JSON.stringify(a);
    // A second press while the first is on its way: the same move is the same press; another waits.
    if (this.inflight) return this.inflight.key === key ? { ok: true } : { ok: false, error: 'One moment: your last move is still on its way' };
    const res = applyAction(this.newest, this.me, a);
    // (A move that draws, a roll or a card from a deck, is refused on a view at the draw, which only
    // the room can make: everything up to it held, and the room checks the rest. Trading with an
    // answer to your offer turns on the partner's hand, which this view only guesses at: the room's
    // word that they can still pay, the offer's readiness, stands in for it.)
    if (!res.ok && res.error !== KEYLESS_DRAW && !partnerReady(this.newest, a)) return res;
    const n = ++this.n;
    // `at`: the record the move was decided on (what you were shown), so the room can tell a move
    // made on news since overtaken.
    if (!this.o.send({ t: 'act', n, at: this.shownSeq, a })) return { ok: false, error: 'Not connected: trying to reconnect…' };
    this.inflight = { n, key, timer: this.clock.setTimeout(() => this.clearInflight(n), INFLIGHT_MS) };
    return { ok: true };
  }

  /** A trade answer names the offer it answers: the one you were shown, else the newest. */
  private withOffer(a: Action): Action {
    if (!ANSWERS.has(a.type) || (a as { offer?: number }).offer !== undefined) return a;
    const id = (this.shown.trade ?? this.newest.trade)?.id;
    return id === undefined ? a : ({ ...a, offer: id } as Action);
  }

  /** The room has answered every move up to `n` (the next is numbered above it). */
  private ack(n: number) {
    this.n = Math.max(this.n, n);
    if (this.inflight && n >= this.inflight.n) this.clearInflight();
  }

  private nack(n: number, code: NackCode, error: string) {
    if (this.inflight && this.inflight.n === n) this.clearInflight();
    // (Out of order: a move the room already had, or one past the game's end. Nothing a person did wrong.)
    if (code === 'order') return;
    this.onError?.(nackText(code, error));
  }

  private clearInflight(n?: number) {
    if (!this.inflight || (n !== undefined && this.inflight.n !== n)) return;
    this.clock.clearTimeout(this.inflight.timer);
    this.inflight = null;
  }

  /** A move is on its way and unanswered. */
  get sending() {
    return this.inflight !== null;
  }

  // ------------------------------------------------------------------ the seats

  private seat(p: PlayerId) {
    return this.seats.find((s) => s.seat === p);
  }

  isBot(p: PlayerId) {
    const s = this.seat(p);
    return s ? s.kind === 'bot' : !!this.shown.players[p]?.isBot;
  }

  difficultyOf(p: PlayerId): BotDifficulty {
    return this.seat(p)?.difficulty ?? 'normal';
  }

  profileOf(p: PlayerId): BotProfile {
    return botProfile(this.difficultyOf(p), this.shown.players[p]?.name ?? '');
  }

  /** The bots move on the server. */
  nextBotAction(): BotDecision | null {
    return null;
  }

  submitBot(): SubmitResult {
    return { ok: false, error: 'The room moves its own crew.' };
  }

  dispose() {
    this.disposed = true;
    for (const t of [this.holdTimer, this.stallTimer, this.seenTimer, this.inflight?.timer]) if (t !== null && t !== undefined) this.clock.clearTimeout(t);
    this.holdTimer = this.stallTimer = this.seenTimer = null;
    this.inflight = null;
    this.held = [];
    this.listeners.clear();
  }
}
