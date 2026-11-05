// The game at a room's table: the engine state, the bots that play their seats, and every
// viewer's wire view with the records that move it on. Only the room sees the whole state; what
// leaves here for a seat is that seat's patch, its events (eventsFor) and the action as it may see
// it (actionFor).

import { applyAction, createGame, legalActions, totalVictoryPoints, type Action, type GameEvent, type GameOptions, type GameState, type PlayerId, type PlayerSetup } from '../../src/engine';
import { botDecide, cloneMemory, createBotMemory, type BotDifficulty, type BotMemory } from '../../src/engine/ai';
import type { BotProfile } from '../../src/engine/ai/profiles';
import { actionFor, eventsFor, type Viewer } from '../../src/engine/visibility';
import { diffView, viewHash, wireView, type WireView } from '../../src/engine/wire';
import { botProfile } from '../../src/game/host';
import { HASH_EVERY, RESYNC_BATCH_MAX, type GameRecord } from '../../src/net/protocol';
import { isAction, type LogEntry } from './store';

/** A viewer's key: its seat, or 'w' for the spectators (who share one view). */
export type ViewKey = PlayerId | 'w';
export const viewerOf = (k: ViewKey): Viewer => (k === 'w' ? null : k);

export interface BotSeat {
  memory: BotMemory;
  difficulty: BotDifficulty;
  profile: BotProfile;
}

/** Counters for the results card's awards, kept as the game goes. */
export interface TableStats {
  trades: number[];
  harvest: number[];
  sevens: number[];
  robbed: number[];
}

const emptyStats = (n: number): TableStats => ({ trades: Array(n).fill(0), harvest: Array(n).fill(0), sevens: Array(n).fill(0), robbed: Array(n).fill(0) });

/** A seat's wire view: wireView with the server's RNG key never in it, whatever the engine leaves. */
export function seatView(state: GameState, viewer: Viewer): WireView {
  const w = wireView(state, viewer);
  delete (w as { rngKey?: string }).rngKey;
  return w;
}

/**
 * What a decision depends on: when this changes between the seq a seat looked at and the seq its
 * intent arrives at (another seat answered first, the offer moved on), the intent is stale.
 */
export const decisionContext = (s: GameState): string =>
  `${s.phase}|${s.currentPlayer}|${s.trade?.id ?? '-'}|${s.pending.length}:${s.pending.at(-1)?.kind ?? ''}:${(s.pending.at(-1)?.players ?? []).join(',')}`;

/** A seat's own moves on its own turn: these don't depend on what anyone else did since, only on being legal. */
const OWN_MOVES = new Set<Action['type']>([
  'rollDice', 'buildRoad', 'buildSettlement', 'buildCity', 'buyDevCard', 'playKnight', 'playRoadBuilding', 'playInvention', 'playMonopoly',
  'bankTrade', 'offerTrade', 'endTurn', 'undo', 'buyWithCoins', 'sellForCoins', 'placeFreeRoad', 'skipFreeRoads',
]);

/**
 * Events that show nobody anything new: placements, moves and trades made in the open, a seat's
 * own card played, its own cards discarded face up, the turn passing. Anything else (the dice, a
 * card drawn, a theft, a monopoly's count of every hand, a hex turned up from the fog, every module
 * event not named here) counts as a reveal, as does any draw from the game's stream (`reveals`).
 */
const QUIET_EVENTS = new Set<GameEvent['type']>([
  'setupSettlementPlaced', 'setupRoadPlaced', 'startingResources', 'turnStarted', 'turnEnded', 'roadBuilt', 'settlementBuilt', 'cityBuilt',
  'devCardPlayed', 'invention', 'bankTraded', 'tradeOffered', 'tradeResponded', 'tradeCountered', 'tradeExecuted', 'tradeCancelled',
  'longestRoadChanged', 'largestArmyChanged', 'freeRoadsFinished', 'undone', 'coins', 'coinTraded', 'robberMoved', 'nothingToSteal',
  'discardRequired', 'discarded', 'gameWon', 'gameLost',
  // (What the board yields follows from the board and the number: it's the dice that reveal.)
  'production', 'noProduction', 'oil/produced',
  'sea/shipBuilt', 'sea/shipMoved', 'sea/corsairMoved', 'sea/bountyPicked', 'rivers/bridgeBuilt', 'rivers/wealthChanged',
  'garrisons/recruited', 'garrisons/promoted', 'garrisons/mustered', 'garrisons/wall', 'garrisons/placed', 'guilds/played', 'guilds/improved',
  'invasion/marched', 'invasion/halted', 'caravans/auctionOpened', 'caravans/bid', 'caravans/passed', 'caravans/voted', 'caravans/toPlace',
  'caravans/wagonPlaced', 'guilds/trader', 'guilds/routeRemoved', 'fisheries/spent', 'oil/foundryBuilt', 'oil/sequestered', 'almanac/took',
  'almanac/nothing', 'almanac/cracked', 'almanac/repaired', 'harbourmaster/changed',
]);

/** Quiet for this actor: cards moved from the supply or its own hand show nothing of anyone else's. */
const quiet = (e: GameEvent, actor: PlayerId) =>
  e.type === 'cardsMoved' ? e.from === null || e.from === actor : e.type === 'almanac/gave' ? e.from === actor : QUIET_EVENTS.has(e.type);

/**
 * Whether an action showed anyone something that wasn't theirs to know before it: it drew from the
 * game's stream (the dice, a deck, a theft), or one of its events isn't quiet. A room never lets a
 * reveal reach a socket before the action is in storage (Room.persist): the turn under way may be
 * lost in a crash, but only its quiet moves, which show nothing to choose differently by.
 */
export function reveals(actor: PlayerId, rngBefore: number, after: GameState, events: readonly GameEvent[]): boolean {
  return after.rngState !== rngBefore || events.some((e) => !quiet(e, actor));
}

/**
 * A roll that was the only move anyone could make (no card to play first, nobody else with a move):
 * from the same state it's the only move again, and the dice come out the same (the stream is
 * counted by draws, not by time), so after a rollback to that state the roll shows nothing anyone
 * could act on. Such a roll needn't be stored before it's sent, when nothing came before it unstored.
 */
export function forcedRoll(before: GameState, actor: PlayerId, action: Action): boolean {
  if (action.type !== 'rollDice' || before.phase !== 'roll' || before.pending.length) return false;
  return before.players.every((p) => {
    const legal = legalActions(before, p.id);
    return p.id === actor ? legal.length === 1 && legal[0].type === 'rollDice' : legal.length === 0;
  });
}

export class Table {
  state: GameState;
  initialEvents: GameEvent[];
  /** Seats a bot plays (bot seats, and people's seats while they're away or after they conceded). */
  readonly bots = new Map<PlayerId, BotSeat>();
  /** The viewers whose views are kept up to date (every person's seat; the spectators while any watch). */
  readonly views = new Map<ViewKey, WireView>();
  /** Each kept viewer's last records, for a quick catch-up after a reconnect. */
  readonly rings = new Map<ViewKey, GameRecord[]>();
  /** The seq the decision context last changed at. */
  ctxSince = 0;
  private ctxKey: string;
  stats: TableStats;
  readonly humans: boolean;

  constructor(
    readonly setups: PlayerSetup[],
    readonly options: GameOptions,
    readonly rngKey: string,
    private difficultyOf: (p: PlayerId) => BotDifficulty,
  ) {
    const { state, events } = createGame(setups, options, { rngKey });
    this.state = state;
    this.initialEvents = events;
    this.ctxKey = decisionContext(state);
    this.stats = emptyStats(setups.length);
    this.humans = setups.some((s) => !s.isBot);
    this.count(events);
  }

  /** A bot takes this seat from here, with a fresh memory. */
  botTakes(p: PlayerId) {
    const difficulty = this.difficultyOf(p);
    this.bots.set(p, { memory: createBotMemory({ waitForHumans: this.humans }), difficulty, profile: botProfile(difficulty, this.setups[p].name) });
  }

  /** The bot gives the seat back to its person. */
  botLeaves(p: PlayerId) {
    this.bots.delete(p);
  }

  get over() {
    return this.state.phase === 'gameOver';
  }

  /**
   * An intent is stale when the decision it answers has moved on since the seq it was made at:
   * a seat's own moves on its own turn stay good while they're legal.
   */
  isStale(actor: PlayerId, action: Action, at: number): boolean {
    if (at >= this.ctxSince) return false;
    return !(actor === this.state.currentPlayer && OWN_MOVES.has(action.type));
  }

  /** Apply an action (anyone's): the engine's verdict and, when it went through, the events. */
  apply(actor: PlayerId, action: Action): { ok: true; events: GameEvent[] } | { ok: false; error: string } {
    let res;
    try {
      res = applyAction(this.state, actor, action);
    } catch (e) {
      // (The engine works on a clone: the state is untouched.)
      return { ok: false, error: `The engine failed: ${(e as Error).message}` };
    }
    if (!res.ok) return res;
    this.state = res.state;
    const key = decisionContext(res.state);
    if (key !== this.ctxKey) {
      this.ctxKey = key;
      this.ctxSince = res.state.seq;
    }
    this.count(res.events);
    return { ok: true, events: res.events };
  }

  /** The next move a bot wants to make, with the memory it would keep: the turn's player first, then the others in seat order. */
  nextBot(): { player: PlayerId; action: Action; memory: BotMemory } | null {
    const s = this.state;
    if (s.phase === 'gameOver') return null;
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

  /** What a bot would do for seat `p` now, on a memory of its own (a timer's move for a person). */
  botMoveFor(p: PlayerId): Action | null {
    const difficulty = this.difficultyOf(p);
    return botDecide(this.state, p, createBotMemory({ waitForHumans: this.humans }), difficulty, botProfile(difficulty, this.setups[p].name));
  }

  /** Start keeping a viewer's view (it gets a snapshot first). */
  keep(k: ViewKey) {
    if (!this.views.has(k)) {
      this.views.set(k, seatView(this.state, viewerOf(k)));
      this.rings.set(k, []);
    }
  }

  drop(k: ViewKey) {
    this.views.delete(k);
    this.rings.delete(k);
  }

  /** Each kept viewer's record of the action just applied: its patch, events and action as it may see them. */
  records(actor: PlayerId, action: Action, events: GameEvent[]): Map<ViewKey, GameRecord> {
    const out = new Map<ViewKey, GameRecord>();
    const seq = this.state.seq;
    for (const [k, prev] of this.views) {
      const viewer = viewerOf(k);
      const next = seatView(this.state, viewer);
      const rec: GameRecord = { seq, actor, a: actionFor(action, actor, viewer), e: eventsFor(events, viewer), p: diffView(prev, next) };
      if (seq % HASH_EVERY === 0) rec.h = viewHash(next);
      this.views.set(k, next);
      const ring = this.rings.get(k)!;
      ring.push(rec);
      if (ring.length > RESYNC_BATCH_MAX) ring.shift();
      out.set(k, rec);
    }
    return out;
  }

  /** The records after `seq` for a viewer, if they're all still kept (a quick catch-up), else null. */
  since(k: ViewKey, seq: number): GameRecord[] | null {
    const ring = this.rings.get(k);
    if (!ring) return null;
    if (seq === this.state.seq) return [];
    const first = ring[0]?.seq ?? Infinity;
    if (seq + 1 < first || seq > this.state.seq) return null;
    return ring.filter((r) => r.seq > seq);
  }

  view(k: ViewKey): WireView {
    this.keep(k);
    return this.views.get(k)!;
  }

  points(): number[] {
    return this.state.players.map((p) => totalVictoryPoints(this.state, p.id));
  }

  private count(events: GameEvent[]) {
    const st = this.stats;
    for (const e of events) {
      if (e.type === 'tradeExecuted') {
        st.trades[e.from]++;
        st.trades[e.to]++;
      } else if (e.type === 'production') {
        for (const g of e.grants) st.harvest[g.player] += g.amount;
      } else if (e.type === 'diceRolled' && e.total === 7) st.sevens[e.player]++;
      else if (e.type === 'stolen') st.robbed[e.victim]++;
    }
  }

  /**
   * Re-apply logged entries (rehydrating after the room was evicted). Bots re-make each of their
   * decisions on the way, as LocalHost.replay does, so their memory comes back exactly; a seat
   * changing hands starts its bot's memory afresh, as it did live.
   */
  replay(entries: LogEntry[], onAction?: (e: Extract<LogEntry, { p: PlayerId }>, events: GameEvent[]) => void) {
    for (const e of entries) {
      if (!isAction(e)) {
        if (e.bot) this.botTakes(e.c);
        else this.botLeaves(e.c);
        continue;
      }
      const bot = this.bots.get(e.p);
      let memory: BotMemory | null = null;
      if (bot && e.by === 'bot') {
        const m = cloneMemory(bot.memory);
        const d = botDecide(this.state, e.p, m, bot.difficulty, bot.profile);
        if (d && JSON.stringify(d) === JSON.stringify(e.a)) memory = m;
      }
      const r = this.apply(e.p, e.a);
      if (!r.ok) throw new Error(`replay failed at seq ${this.state.seq}: ${r.error}`);
      if (bot && memory) bot.memory = memory;
      onAction?.(e, r.events);
    }
  }

  /** The table as a checkpoint: the bots' memories and the counters (the state itself is stored apart). */
  checkpointExtra() {
    return {
      bots: [...this.bots].map(([p, b]) => ({ p, memory: b.memory })),
      stats: this.stats,
      ctxSince: this.ctxSince,
    };
  }

  /** Back to a checkpoint's state, with its bots and counters. */
  restore(state: GameState, extra: ReturnType<Table['checkpointExtra']>) {
    this.state = state;
    this.ctxKey = decisionContext(state);
    this.ctxSince = extra.ctxSince;
    this.stats = extra.stats;
    this.bots.clear();
    for (const { p, memory } of extra.bots) {
      this.botTakes(p);
      this.bots.get(p)!.memory = memory;
    }
    this.views.clear();
    this.rings.clear();
  }
}
