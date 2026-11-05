// The table's clocks: whose move is owed, and by when. A person's turn has a clock (TIMERS:
// `turn` seconds, `bonus` more per action), stopped while it waits on others; a decision owed out
// of turn (a discard, an answer to an offer, a module's choice) has its own. A clock only starts once the move that set it running has been shown at the table:
// when every person here has said so (`seen`), or at the latest the batch's waits plus SEEN_CAP_MS
// after it went out, so nobody loses time to the animations and a device that never says holds
// nobody up for long.

import type { GameState, PlayerId } from '../../src/engine';
import { TIMERS, type RoomSettings, type Timers } from '../../src/net/protocol';

export type ClockKind = 'turn' | 'decision';

export interface Clock {
  seat: PlayerId;
  /** What it's for: the same key on the next look means the same obligation, still owed. */
  key: string;
  kind: ClockKind;
  /** Time left (ms) as of `since`; running when `since` is set (it runs out at since + left). */
  left: number;
  since: number | null;
  /**
   * Set to start later (`since` ahead of now) until the table has seen the game up to this record:
   * then it starts at once (see release).
   */
  seq?: number;
  /**
   * How much sooner it started than its cap, once released: the room's alarm stays where the cap
   * put it (moving it earlier would be a storage write a turn), so a seat that lets its clock run
   * out is timed out at most this much after its clock reads nothing left.
   */
  slack?: number;
}

export interface ClockState {
  clocks: Clock[];
}

export const emptyClocks = (): ClockState => ({ clocks: [] });

export interface Owed {
  seat: PlayerId;
  key: string;
  kind: 'turn' | 'decision';
}

/** What each seat owes now: the turn's player its turn, the others any decision out of turn. */
export function owed(s: GameState): Owed[] {
  if (s.phase === 'gameOver') return [];
  const out: Owed[] = [{ seat: s.currentPlayer, key: `t${s.turn}:${s.currentPlayer}:${s.setupIndex}`, kind: 'turn' }];
  const top = s.pending.at(-1);
  for (const p of s.players) {
    if (p.id === s.currentPlayer) continue;
    if (top) {
      if (top.players.includes(p.id)) out.push({ seat: p.id, key: `p${s.turn}:${s.pending.length}:${top.kind}`, kind: 'decision' });
      continue;
    }
    if (s.phase === 'discard' && s.pendingDiscards[p.id] !== undefined) out.push({ seat: p.id, key: `d${s.turn}`, kind: 'decision' });
    const t = s.trade;
    if (s.phase === 'main' && t && t.proposer !== p.id && (t.to.length === 0 || t.to.includes(p.id)) && t.responses[p.id] === undefined && t.counters[p.id] === undefined) {
      out.push({ seat: p.id, key: `x${t.id}`, kind: 'decision' });
    }
  }
  return out;
}

export const endsAt = (c: Clock) => (c.since === null ? null : c.since + c.left);

export interface ClockInput {
  state: GameState;
  settings: RoomSettings;
  /** Seats a person plays right now (not a bot, not away). */
  people: (p: PlayerId) => boolean;
  /** Actions each seat's person made since the last look (each earns the turn its bonus). */
  acted: Map<PlayerId, number>;
  /** When a new or restarted clock starts at the latest (now, plus the batch's waits and SEEN_CAP_MS). */
  startAt: number;
  /** The record the clocks started now wait to have been seen (the game's newest). */
  seq?: number;
  now: number;
  /** Every clock stopped (a pause, or nobody at the table). */
  stopped: boolean;
}

/** The clocks after a change: kept where the obligation is the same, new where it's new, gone where it's met. */
export function nextClocks(prev: ClockState, x: ClockInput): ClockState {
  const preset = TIMERS[x.settings.timer];
  if (!preset) return emptyClocks();
  const due = owed(x.state).filter((o) => x.people(o.seat));
  const others = due.some((o) => o.kind === 'decision');
  const clocks: Clock[] = [];
  for (const o of due) {
    const kind: ClockKind = o.kind;
    const full = (kind === 'turn' ? preset.turn : preset.decision) * 1000;
    const old = prev.clocks.find((c) => c.seat === o.seat && c.key === o.key);
    const c: Clock = old ? { ...old } : { seat: o.seat, key: o.key, kind, left: full, since: null };
    if (kind === 'turn' && old) c.left += (x.acted.get(o.seat) ?? 0) * preset.bonus * 1000;
    // A turn waits (its clock stopped) while others owe their answers; everything waits while stopped.
    const run = !x.stopped && !(kind === 'turn' && others);
    if (run && c.since === null) {
      c.since = x.startAt;
      delete c.slack;
      if (x.startAt > x.now && x.seq !== undefined) c.seq = x.seq;
      else delete c.seq;
    } else if (!run && c.since !== null) {
      c.left = Math.max(0, c.left - Math.max(0, x.now - c.since));
      c.since = null;
      delete c.seq;
      delete c.slack;
    }
    clocks.push(c);
  }
  return { clocks };
}

/**
 * The table has shown the game up to `seen` (the least any person here has said): clocks waiting
 * on a record up to it start now rather than at their cap. Null when nothing changed.
 */
export function release(cs: ClockState, seen: number, now: number): ClockState | null {
  let changed = false;
  const clocks = cs.clocks.map((c) => {
    if (c.seq === undefined || c.since === null || c.seq > seen) return c;
    changed = true;
    const since = Math.min(c.since, now);
    const r: Clock = { ...c, since, slack: (c.slack ?? 0) + (c.since - since) };
    delete r.seq;
    return r;
  });
  return changed ? { clocks } : null;
}

/** The clocks that have run out by `now`. */
export const expired = (cs: ClockState, now: number): Clock[] => cs.clocks.filter((c) => {
  const e = endsAt(c);
  return e !== null && e <= now;
});

/** When the room next wakes for a clock: as its cap had it (see Clock.slack), never earlier. */
export function nextDue(cs: ClockState): number | null {
  let best: number | null = null;
  for (const c of cs.clocks) {
    const end = endsAt(c);
    const e = end === null ? null : end + (c.slack ?? 0);
    if (e !== null && (best === null || e < best)) best = e;
  }
  return best;
}

/** The clocks as the seats see them. */
export function timersView(cs: ClockState, now: number, paused: boolean): Timers {
  const t: Timers = { now };
  const turn = cs.clocks.find((c) => c.kind === 'turn');
  if (turn) {
    t.seat = turn.seat;
    const e = endsAt(turn);
    if (e !== null) t.endsAt = e;
  }
  const owedOut = cs.clocks.filter((c) => c.kind === 'decision' && endsAt(c) !== null).map((c) => ({ seat: c.seat, endsAt: endsAt(c)! }));
  if (owedOut.length) t.owed = owedOut;
  if (paused) t.paused = true;
  return t;
}

export const sameTimers = (a: Timers | null, b: Timers) => a !== null && JSON.stringify({ ...a, now: 0 }) === JSON.stringify({ ...b, now: 0 });
