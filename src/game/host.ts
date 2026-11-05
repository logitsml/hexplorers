// The game host: what the presenter and the session play through. Locally (LocalHost) it is the
// authority, owning the engine state and the bots; online (src/online/remoteHost.ts) the room on
// the server is, and the host there streams the same { actor, action, events, state } messages,
// built from each seat's redacted view.

import { applyAction, createGame, mightHold, type Action, type GameEvent, type GameOptions, type GameSecret, type GameState, type PlayerId, type PlayerSetup } from '../engine';
import { botDecide, cloneMemory, createBotMemory, type BotDifficulty, type BotMemory } from '../engine/ai';
import { PROFILES, withPersonality, type BotPersonality, type BotProfile } from '../engine/ai/profiles';
import { voiceOf } from './names';

export interface BotDecision {
  player: PlayerId;
  action: Action;
  memory: BotMemory;
}

export interface HostMessage {
  actor: PlayerId | null;
  /** Online, another seat's move comes as its type alone (see engine/visibility.ts, actionFor). */
  action: Action | null;
  /** Online, the events as this seat may see them: a secret field (a stolen card, a card drawn) is left out. */
  events: GameEvent[];
  state: GameState;
  /** The room's record number (online only): the presenter reports it once shown (GameHost.presented). */
  seq?: number;
  /**
   * The view has jumped to `state` without its events (a resync far behind): the board is set to
   * it at once rather than played out.
   */
  jump?: boolean;
}

export type SubmitResult = { ok: true } | { ok: false; error: string };

/**
 * What the presenter and the session need of a host. LocalHost is one; RemoteHost (online) is the
 * other, where `state` is the room's view as far as it has been handed to the presenter, the bots
 * move on the server (`nextBotAction` is always null) and a submitted move is checked here, sent,
 * and refused later (through `onError`) if the room won't have it.
 */
export interface GameHost {
  /** The game as the presenter is to show it once its queue is played out. */
  readonly state: GameState;
  /** The events the game began with (a beginner set-up's pieces, who goes first). */
  readonly initialEvents: GameEvent[];
  subscribe(fn: (m: HostMessage) => void): () => void;
  isBot(p: PlayerId): boolean;
  difficultyOf(p: PlayerId): BotDifficulty;
  profileOf(p: PlayerId): BotProfile;
  /** A replay: every move is recorded, nobody decides. */
  readonly scripted: boolean;
  readonly scriptProgress: { at: number; total: number } | null;
  readonly paused: boolean;
  submit(actor: PlayerId, action: Action): SubmitResult;
  nextBotAction(): BotDecision | null;
  submitBot(d: BotDecision): SubmitResult;
  dispose(): void;
  /** Online: the room is the authority (no bots here, no local table talk, others are people too). */
  readonly remote?: boolean;
  /** Online, watching from the quay: no seat of your own. */
  readonly spectator?: boolean;
  /** Online, far enough behind the room that the presentation should hurry to catch up. */
  readonly catchUp?: boolean;
  /** Online: the presenter has shown the game up to record `seq` (all it was handed, when absent). */
  presented?(seq?: number): void;
  /** Online: a move that went out and came back refused (the presenter shows why). */
  onError?: ((error: string) => void) | null;
}

export interface SeatConfig extends PlayerSetup {
  difficulty?: BotDifficulty;
  /** A bot's character; by default the one that goes with its name (see names.ts's crew). */
  personality?: BotPersonality;
}

/** The character that goes with a crew member's name (each matches their table-talk voice). */
export function personalityOf(name: string): BotPersonality | undefined {
  return voiceOf(name);
}

/**
 * A phone or a small laptop (a browser reporting four cores or 4 GB or fewer): the bots there think
 * with half the win search's budget, so a rare long think doesn't stall a turn. (Never on a server
 * or in tests, whose bots play the same on every machine.)
 */
const SMALL_DEVICE =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  (((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4);

/** A bot's full parameters: its difficulty, with its character on top. */
export function botProfile(difficulty: BotDifficulty, name: string, personality?: BotPersonality): BotProfile {
  const base = PROFILES[difficulty];
  const profile = SMALL_DEVICE ? { ...base, searchBudget: Math.ceil(base.searchBudget / 2) } : base;
  return withPersonality(profile, personality ?? personalityOf(name));
}

/** How long a bot's offer waits for a person before the host declines it for them. */
export const OFFER_DEADLINE_MS = 60_000;

/** Timers the host uses (swappable in tests). */
export interface HostClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: HostClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class LocalHost implements GameHost {
  state: GameState;
  private bots = new Map<PlayerId, { memory: BotMemory; difficulty: BotDifficulty; profile: BotProfile }>();
  private listeners = new Set<(m: HostMessage) => void>();
  initialEvents: GameEvent[];
  readonly history: { actor: PlayerId; action: Action }[] = [];
  /** A replay: recorded moves served in place of the bots' decisions, from `at`. */
  private script: { list: { actor: PlayerId; action: Action }[]; at: number } | null = null;
  /** A paused replay serves nothing until it resumes. */
  paused = false;
  /** Backstop for a bot's offer that a person hasn't answered (the table's own timer can pause). */
  private deadline: { offer: number; timer: unknown; left: number; since: number } | null = null;
  /** How long that backstop waits (0: offers wait for an answer however long it takes). */
  private offerWait = OFFER_DEADLINE_MS;
  /** While held (a dialog open, play paused, the tab hidden), the backstop's clock stops. */
  private offerHeld = false;
  private disposed = false;

  constructor(
    seats: SeatConfig[],
    options: Partial<GameOptions>,
    private clock: HostClock = realClock,
    /** A keyed game's secret (an online game's replay: its key, revealed at the end). */
    secret?: GameSecret,
  ) {
    const { state, events } = createGame(seats, options, secret);
    this.state = state;
    this.initialEvents = events;
    const humans = seats.some((s) => !s.isBot);
    seats.forEach((s, i) => {
      const difficulty = s.difficulty ?? 'normal';
      if (s.isBot) this.bots.set(i, { memory: createBotMemory({ waitForHumans: humans }), difficulty, profile: botProfile(difficulty, s.name, s.personality) });
    });
  }

  /**
   * Re-apply a saved action list without presenting it (resuming a game), under the rules the save
   * says it was played with. Bots re-make each of their decisions on the way, so their per-turn
   * memory (offers made, supply trades) is rebuilt exactly and a game resumed mid-turn plays on as
   * it would have.
   */
  replay(list: { actor: PlayerId; action: Action }[], onEvents?: (events: GameEvent[]) => void) {
    this.replayFrom(list, onEvents);
    // (An offer open when the game was saved gets its backstop again, as a live one has.)
    this.watchOffer();
  }

  private replayFrom(list: { actor: PlayerId; action: Action }[], onEvents?: (events: GameEvent[]) => void) {
    for (const { actor, action } of list) {
      const bot = this.bots.get(actor);
      let memory: BotMemory | null = null;
      if (bot) {
        const m = cloneMemory(bot.memory);
        const d = botDecide(this.state, actor, m, bot.difficulty, bot.profile);
        if (d && JSON.stringify(d) === JSON.stringify(action)) memory = m;
      }
      const res = applyAction(this.state, actor, action);
      if (!res.ok) throw new Error(`replay failed at action ${this.history.length}: ${res.error}`);
      this.state = res.state;
      this.history.push({ actor, action });
      if (bot && memory) bot.memory = memory;
      onEvents?.(res.events);
    }
  }

  subscribe(fn: (m: HostMessage) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  isBot(p: PlayerId) {
    return this.bots.has(p);
  }

  difficultyOf(p: PlayerId): BotDifficulty {
    return this.bots.get(p)?.difficulty ?? 'normal';
  }

  /** A bot's full parameters (difficulty and character), e.g. for judging deals it would take. */
  profileOf(p: PlayerId): BotProfile {
    return this.bots.get(p)?.profile ?? PROFILES.normal;
  }

  /** Play back recorded moves (a replay): each one is due in turn, as a bot's would be. */
  setScript(list: { actor: PlayerId; action: Action }[]) {
    this.script = { list, at: 0 };
  }

  get scripted() {
    return this.script !== null;
  }

  /** How far through the recorded moves (moves made, moves in all). */
  get scriptProgress() {
    return this.script ? { at: this.script.at, total: this.script.list.length } : null;
  }

  /** An action from a person at the table. Bots' seats and replays only move through submitBot. */
  submit(actor: PlayerId, action: Action): SubmitResult {
    if (this.script) return { ok: false, error: 'This is a replay.' };
    if (this.bots.has(actor)) return { ok: false, error: 'That seat is played by the computer.' };
    return this.apply(actor, action);
  }

  private apply(actor: PlayerId, action: Action): SubmitResult {
    if (this.disposed) return { ok: false, error: 'The game has ended.' };
    const res = applyAction(this.state, actor, action);
    if (!res.ok) return res;
    this.state = res.state;
    this.history.push({ actor, action });
    this.watchOffer();
    const msg: HostMessage = { actor, action, events: res.events, state: res.state };
    for (const l of this.listeners) l(msg);
    return { ok: true };
  }

  /**
   * The next bot action that is due, if any. Nothing is applied and the bots' memory is not
   * touched: the decision carries its own updated copy, adopted by `submitBot` only if the
   * action goes through (so a decision that is dropped or retried never counts twice).
   */
  nextBotAction(): BotDecision | null {
    const s = this.state;
    if (s.phase === 'gameOver') return null;
    if (this.script) {
      const next = this.script.list[this.script.at];
      // (A replay keeps no bot memory: the moves are already decided.)
      return this.paused || !next ? null : { player: next.actor, action: next.action, memory: null as unknown as BotMemory };
    }
    // Priority: the current player, then any bot with pending discards, then trade responders.
    const order = [s.currentPlayer, ...s.players.map((p) => p.id).filter((p) => p !== s.currentPlayer)];
    for (const p of order) {
      const bot = this.bots.get(p);
      if (!bot) continue;
      const memory = cloneMemory(bot.memory);
      const action = botDecide(s, p, memory, bot.difficulty, bot.profile);
      if (action) return { player: p, action, memory };
    }
    return null;
  }

  submitBot(d: BotDecision): SubmitResult {
    if (this.script) {
      const r = this.apply(d.player, d.action);
      if (r.ok) this.script.at++;
      return r;
    }
    if (!this.bots.has(d.player)) return { ok: false, error: 'That seat is not played by the computer.' };
    const r = this.apply(d.player, d.action);
    const bot = this.bots.get(d.player);
    if (r.ok && bot) bot.memory = d.memory;
    return r;
  }

  /** People a bot's open offer is still waiting on. */
  private awaitedPeople(): PlayerId[] {
    const t = this.state.trade;
    if (!t || !this.bots.has(t.proposer) || this.state.phase !== 'main') return [];
    return this.state.players
      .filter((p) => p.id !== t.proposer && !this.bots.has(p.id) && (t.to.length === 0 || t.to.includes(p.id)))
      // (Whom the bot waits for, as it judges it: from the table, not from the hand. See resolveOwnOffer.)
      .filter((p) => t.responses[p.id] === undefined && t.counters[p.id] === undefined && mightHold(this.state, t.proposer, p.id, t.get))
      .map((p) => p.id);
  }

  /** Start (or drop) the backstop timer for the open offer. */
  private watchOffer() {
    const t = this.state.trade;
    const waiting = !this.script && t && this.awaitedPeople().length > 0;
    if (this.deadline && (!waiting || this.deadline.offer !== t!.id)) {
      if (this.deadline.timer !== null) this.clock.clearTimeout(this.deadline.timer);
      this.deadline = null;
    }
    if (!waiting || this.deadline || !this.offerWait) return;
    this.deadline = { offer: t!.id, timer: null, left: this.offerWait, since: 0 };
    this.runDeadline();
  }

  private runDeadline() {
    const d = this.deadline;
    if (!d || d.timer !== null || this.offerHeld) return;
    d.since = this.clock.now();
    d.timer = this.clock.setTimeout(() => this.expireOffer(d.offer), d.left);
  }

  /** Set how long an offer waits for a person (0: no limit); an open offer starts over on it. */
  setOfferWait(ms: number) {
    if (ms === this.offerWait) return;
    this.offerWait = ms;
    if (this.deadline?.timer != null) this.clock.clearTimeout(this.deadline.timer);
    this.deadline = null;
    this.watchOffer();
  }

  /** Stop (or restart) the offer backstop's clock, keeping the time it has left. */
  holdOffers(on: boolean) {
    if (on === this.offerHeld) return;
    this.offerHeld = on;
    const d = this.deadline;
    if (!d) return;
    if (on && d.timer !== null) {
      this.clock.clearTimeout(d.timer);
      d.timer = null;
      d.left = Math.max(0, d.left - (this.clock.now() - d.since));
    } else if (!on) this.runDeadline();
  }

  /** Time is up for a bot's offer: everyone it still waits on declines. */
  private expireOffer(offer: number) {
    if (!this.deadline || this.deadline.offer !== offer) return;
    this.deadline = null;
    for (const p of this.awaitedPeople()) {
      if (this.state.trade?.id !== offer) return;
      this.apply(p, { type: 'respondTrade', accept: false });
    }
  }

  /** Stop the host's timers and drop its listeners (the game was left). */
  dispose() {
    this.disposed = true;
    if (this.deadline?.timer != null) this.clock.clearTimeout(this.deadline.timer);
    this.deadline = null;
    this.listeners.clear();
  }
}
