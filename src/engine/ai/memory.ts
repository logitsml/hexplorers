import type { Card } from '../types';

/** Per-bot scratch state that survives between botDecide calls. Plain data, safe to structuredClone. */
export interface BotMemory {
  /** state.turn the per-turn counters below refer to. */
  turn: number;
  /** Domestic offers proposed this turn. */
  offersMade: number;
  /** Keys of offers already proposed this turn (never repeat an offer). */
  offerKeys: string[];
  /** Offers nobody took, with the turn they lapsed (not re-proposed for a couple of rounds). */
  refused: { key: string; turn: number }[];
  /** Maritime trades made this turn. */
  bankTrades: number;
  /** Resources given to / received from the bank this turn (prevents trading back and forth). */
  gaveToBank: Card[];
  gotFromBank: Card[];
  /** Actions this bot took during its own current turn (safety valve against loops). */
  actionsThisTurn: number;
  /**
   * When true, a proposing bot waits until human seats have answered as well. By default it resolves as
   * soon as every bot seat has answered, so a UI that wants humans to take part should either set this
   * (and guarantee humans always answer) or delay calling botDecide for the proposer.
   */
  waitForHumans: boolean;
  /** Number of times the bot's preferred action was illegal and a fallback was used (should stay 0). */
  fallbacks: number;
  /** What a module's bot remembers between turns, as plain numbers (who last held the Soggy Boot, say). */
  notes: Record<string, number>;
  /** The turn in which a full search found no win (see search.ts), until a move outside it changes the hand. */
  noWinTurn?: number;
}

export function createBotMemory(opts: { waitForHumans?: boolean } = {}): BotMemory {
  return {
    turn: -1,
    offersMade: 0,
    offerKeys: [],
    refused: [],
    bankTrades: 0,
    gaveToBank: [],
    gotFromBank: [],
    actionsThisTurn: 0,
    waitForHumans: opts.waitForHumans ?? false,
    fallbacks: 0,
    notes: {},
  };
}

/** A bot's decision runs on a copy; the host keeps the copy only if the action is applied. */
export function cloneMemory(m: BotMemory): BotMemory {
  return { ...m, offerKeys: m.offerKeys.slice(), refused: m.refused.slice(), gaveToBank: m.gaveToBank.slice(), gotFromBank: m.gotFromBank.slice(), notes: { ...m.notes } };
}

export function syncTurn(mem: BotMemory, turn: number) {
  if (mem.turn === turn) return;
  mem.turn = turn;
  mem.offersMade = 0;
  mem.offerKeys = [];
  mem.bankTrades = 0;
  mem.gaveToBank = [];
  mem.gotFromBank = [];
  mem.actionsThisTurn = 0;
  mem.noWinTurn = undefined;
}
