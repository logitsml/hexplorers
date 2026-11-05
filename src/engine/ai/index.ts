// Heuristic computer opponent. botDecide() is pure apart from the per-bot BotMemory it updates, and
// all randomness is derived from the game state, so bot-only games are reproducible.

import { legalActions } from '../actions';
import { withMemo } from '../memo';
import { modulesOf } from '../modules';
import { hasResources, totalCards } from '../rules';
import type { Action, GameState, PlayerId, CardCounts } from '../types';
import { CARDS } from '../types';
import { BotCtx } from './context';
import { createBotMemory, syncTurn, type BotMemory } from './memory';
import { chooseDiscard, chooseRobberHex, chooseVictim } from './robber';
import { chooseSetupRoad, chooseSetupSettlement } from './setup';
import { proposeCounter, resolveOwnOffer, wantsTrade } from './trade';
import { SEARCHED } from './search';
import { chooseFreeRoad, mainPhase, rollPhase } from './turn';

import { PROFILES, type BotDifficulty, type BotProfile } from './profiles';

export type { BotDifficulty, BotPersonality, BotProfile } from './profiles';
export { PERSONALITIES, PROFILES, withPersonality } from './profiles';
export { cloneMemory, createBotMemory, type BotMemory } from './memory';

/** Safety valve: a bot never takes more actions than this in one turn before ending it. */
const MAX_ACTIONS_PER_TURN = 60;

function respond(ctx: BotCtx): Action {
  if (wantsTrade(ctx)) return { type: 'respondTrade', accept: true };
  return proposeCounter(ctx) ?? { type: 'respondTrade', accept: false };
}

/** The module whose decision is owed (the top of the pending stack), and the bot's answer to it. */
function pendingDecision(ctx: BotCtx): Action | null {
  const s = ctx.s;
  const top = s.pending[s.pending.length - 1];
  if (!top || !top.players.includes(ctx.me)) return null;
  const owner = modulesOf(s).find((m) => top.kind.startsWith(`${m.id}/`));
  // (A bot that plays the modules loosely sometimes just takes any legal answer.)
  if (ctx.prof.moduleSlip > 0 && ctx.rng.next() < ctx.prof.moduleSlip) {
    const legal = legalActions(s, ctx.me);
    if (legal.length > 0) return legal[ctx.rng.int(legal.length)];
  }
  // (A module without an answer for this still gets one: the first legal choice.)
  return owner?.bot?.pending?.(ctx, top) ?? legalActions(s, ctx.me)[0] ?? null;
}

/** The first thing a module's bot wants to do now, asked in module order. */
function moduleWish(ctx: BotCtx, when: 'beforeRoll' | 'main' | 'freeRoute'): Action | null {
  // (A bot that plays the modules loosely sometimes lets their optional moves pass: not a free piece
  // that Road Crew leaves owed, which the base planner may have no way to place.)
  if (when !== 'freeRoute' && ctx.prof.moduleSkip > 0 && ctx.s.options.modules.length > 0 && ctx.rng.next() < ctx.prof.moduleSkip) return null;
  for (const m of modulesOf(ctx.s)) {
    const a = m.bot?.[when]?.(ctx);
    if (a) return a;
  }
  return null;
}

function decide(ctx: BotCtx): Action | null {
  const s = ctx.s;
  if (s.pending.length > 0) return pendingDecision(ctx);
  switch (s.phase) {
    case 'setupSettlement':
      return chooseSetupSettlement(ctx);
    case 'setupRoad':
      return chooseSetupRoad(ctx);
    case 'roll':
      return (s.currentPlayer === ctx.me && moduleWish(ctx, 'beforeRoll')) || rollPhase(ctx);
    case 'discard':
      return chooseDiscard(ctx, s.pendingDiscards[ctx.me]);
    case 'moveRobber':
      return chooseRobberHex(ctx);
    case 'steal':
      return chooseVictim(ctx);
    case 'roadBuilding':
      return moduleWish(ctx, 'freeRoute') ?? chooseFreeRoad(ctx);
    case 'main': {
      if (s.currentPlayer !== ctx.me) return respond(ctx);
      if (s.trade && s.trade.proposer === ctx.me) {
        if (ctx.mem.actionsThisTurn >= MAX_ACTIONS_PER_TURN) return { type: 'cancelTrade' };
        return resolveOwnOffer(ctx);
      }
      if (ctx.mem.actionsThisTurn >= MAX_ACTIONS_PER_TURN) return { type: 'endTurn' };
      return moduleWish(ctx, 'main') ?? mainPhase(ctx);
    }
    default:
      return null;
  }
}

/** Whether `player` has anything to do in `state` (cheap check before any evaluation). */
function hasWork(state: GameState, player: PlayerId): boolean {
  if (state.phase === 'gameOver') return false;
  const top = state.pending[state.pending.length - 1];
  if (top) return top.players.includes(player);
  if (state.phase === 'endOfTurn') return false;
  if (state.phase === 'discard') return state.pendingDiscards[player] !== undefined;
  if (state.currentPlayer === player) return true;
  if (state.phase !== 'main' || !state.trade) return false;
  const t = state.trade;
  if (t.proposer === player) return false;
  if (t.to.length > 0 && !t.to.includes(player)) return false;
  return t.responses[player] === undefined && t.counters[player] === undefined;
}

/**
 * Order-independent identity of an action (for comparing against legalActions entries). A trade
 * answer's `offer` is a precondition, not part of the move: it isn't counted.
 */
export function actionKey(a: Action): string {
  const o = a as unknown as Record<string, unknown>;
  return Object.keys(o)
    .filter((k) => o[k] !== undefined && k !== 'offer')
    .sort()
    .map((k) => `${k}=${JSON.stringify(o[k])}`)
    .join('|');
}

const validCounts = (rc: CardCounts) => CARDS.every((r) => Number.isInteger(rc[r]) && rc[r] >= 0);

/** Both sides non-empty, no resource on both sides, and `hand` covers what is given. */
const validTrade = (give: CardCounts, get: CardCounts, hand: CardCounts) =>
  validCounts(give) &&
  validCounts(get) &&
  totalCards(give) > 0 &&
  totalCards(get) > 0 &&
  CARDS.every((r) => give[r] === 0 || get[r] === 0) &&
  hasResources(hand, give);

/** Cheap legality check (no state clone): legalActions membership, plus direct checks for offers, counters and discards. */
function isLegal(state: GameState, player: PlayerId, action: Action): boolean {
  const me = state.players[player];
  if (action.type === 'offerTrade') {
    return state.phase === 'main' && state.currentPlayer === player && validTrade(action.give, action.get, me.hand);
  }
  if (action.type === 'counterTrade') {
    const t = state.trade;
    return (
      state.phase === 'main' &&
      !!t &&
      t.proposer !== player &&
      (t.to.length === 0 || t.to.includes(player)) &&
      validTrade(action.give, action.get, me.hand)
    );
  }
  if (action.type === 'discard') {
    const need = state.pendingDiscards[player];
    return state.phase === 'discard' && need !== undefined && validCounts(action.resources) && totalCards(action.resources) === need && hasResources(me.hand, action.resources);
  }
  const key = actionKey(action);
  // (Only an action of the same type can have the same key: the others needn't be keyed.)
  return legalActions(state, player).some((a) => a.type === action.type && actionKey(a) === key);
}

const SAFE_ORDER: Action['type'][] = ['endTurn', 'rollDice', 'skipFreeRoads', 'cancelTrade', 'respondTrade'];

/** The actions that answer (or settle) the open trade offer, and carry its id in online play. */
const TRADE_ANSWERS = new Set<Action['type']>(['respondTrade', 'counterTrade', 'acceptTrade', 'cancelTrade']);

function fallback(state: GameState, player: PlayerId): Action | null {
  const legal = legalActions(state, player);
  if (legal.length === 0) return null;
  for (const type of SAFE_ORDER) {
    const a = legal.find((x) => x.type === type && (x.type !== 'respondTrade' || !x.accept));
    if (a) return a;
  }
  return legal[0];
}

/**
 * Next action this bot wants to take right now, or null if it has nothing to do (not its turn and
 * nothing pending for it, or it is waiting for answers to its trade offer).
 */
export function botDecide(
  state: GameState,
  player: PlayerId,
  memory: BotMemory,
  difficulty: BotDifficulty,
  /** Optional override of the difficulty's parameters (for tuning and experiments). */
  profile: BotProfile = PROFILES[difficulty],
): Action | null {
  if (!Number.isInteger(player) || player < 0 || player >= state.players.length || !hasWork(state, player)) return null;
  // (The state doesn't change while the bot thinks: what it asks of it is worked out once.)
  return withMemo(state, () => decideNow(state, player, memory, difficulty, profile));
}

function decideNow(state: GameState, player: PlayerId, memory: BotMemory, difficulty: BotDifficulty, profile: BotProfile): Action | null {
  syncTurn(memory, state.turn);
  const ctx = new BotCtx(state, player, difficulty, memory, profile);
  let action = decide(ctx);
  if (!action) return null;
  if (!isLegal(state, player, action)) {
    memory.fallbacks++;
    action = fallback(state, player);
    if (!action) return null;
  }
  // A keyed (online) game's trade answers name the offer they answer, so one that arrives late is
  // refused rather than taken for an answer to the next. (Local games answer as they always have,
  // so their saves, replays and golden games stay as recorded.)
  if (state.options.rng === 'chacha20' && state.trade && TRADE_ANSWERS.has(action.type)) action = { ...action, offer: state.trade.id } as Action;
  if (state.currentPlayer === player) memory.actionsThisTurn++;
  // (A move the win search doesn't make may bring what it lacked: a trade, a card bought, a theft.)
  if (memory.noWinTurn !== undefined && !SEARCHED.has(action.type)) memory.noWinTurn = undefined;
  if (action.type === 'bankTrade') {
    memory.bankTrades++;
    memory.gaveToBank.push(action.give);
    memory.gotFromBank.push(action.get);
  }
  return action;
}

/**
 * The answer a normal bot would give, sitting in `player`'s seat, to the decision `player` owes now:
 * for the interface to suggest (a castle exit for a warden that must leave it, the road a quake
 * should crack). Only a module's own answer (never the first legal move a bot falls back on), and
 * only a legal one; null when nothing is owed. Like every bot, it reads only public information.
 */
export function suggestAnswer(state: GameState, player: PlayerId): Action | null {
  const top = state.pending[state.pending.length - 1];
  if (!top || !top.players.includes(player)) return null;
  const owner = modulesOf(state).find((m) => top.kind.startsWith(`${m.id}/`));
  if (!owner?.bot?.pending) return null;
  return withMemo(state, () => {
    // (A suggestion is a judgement as good as the bot can make: none of the loose play of its levels.)
    const a = owner.bot!.pending!(new BotCtx(state, player, 'normal', createBotMemory({ waitForHumans: true }), { ...PROFILES.normal, moduleNoise: 0 }), top);
    return a && isLegal(state, player, a) ? a : null;
  });
}

/**
 * Whether `bot` would accept `proposer`'s offer (the proposer gives `give` and wants `get`), judged
 * exactly as it would judge that offer on the table. For deals a bot suggests in the table talk.
 */
export function wouldAccept(
  state: GameState,
  bot: PlayerId,
  proposer: PlayerId,
  give: CardCounts,
  get: CardCounts,
  difficulty: BotDifficulty,
  profile: BotProfile = PROFILES[difficulty],
): boolean {
  // (As the state stands when the bot answers, just after the offer: its chance is seeded by the
  // action count, which the offer moves on by one, and the offer takes the next trade's number.)
  const s: GameState = { ...state, seq: state.seq + 1, nextTradeId: state.nextTradeId + 1, trade: { id: state.nextTradeId, proposer, give, get, to: [bot], responses: {}, counters: {} } };
  return wantsTrade(new BotCtx(s, bot, difficulty, createBotMemory({ waitForHumans: true }), profile));
}
