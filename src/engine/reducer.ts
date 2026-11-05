// The authoritative game reducer. applyAction() validates an action for a given
// player and returns a new state plus a list of presentation events. It never
// mutates its input, which makes it safe to run on a server or in a replay.
//
// Rule modules (modules/*) handle their own namespaced actions and hook into the base flow at
// fixed points; with no modules in play the reducer is exactly the base game's.

import { COSTS, DISCARD_THRESHOLD, EVENT_DECK_RESHUFFLE_AT, LARGEST_ARMY_MIN, LONGEST_ROAD_MIN, TERRAIN_RESOURCE, emptyCards } from './constants';
import { Ctx, RuleError, assert, fail, isOver, pay, readCounts, transfer, validIndex } from './ctx';
import { MODULES, modulesOf } from './modules';
import type { EndStep, PieceKind } from './modules/api';
import { trackEvents } from './tracker';
import {
  canAfford,
  cardKinds,
  freeRouteOpen,
  hasResources,
  isOpenOffer,
  isLegalRoad,
  isLegalSettlement,
  legalCities,
  legalRobberHexes,
  legalSetupRoads,
  longestRoadFor,
  numbersOf,
  placeAllowed,
  satisfiesDistanceRule,
  stealCandidates,
  stealableKinds,
  totalCards,
  totalVictoryPoints,
  tradeRatios,
  usesCoins,
  victoryTarget,
  COIN_BUYS_PER_TURN,
  COINS_PER_RESOURCE,
  canTakeOil,
} from './rules';
import type { Action, ActionError, ActionResult, BaseAction, Card, CardCounts, DevCardType, GameState, ModuleId, PlayerId, Production, Resource, StealCause, TradeOffer } from './types';
import { CARDS, MODULE_IDS, RESOURCES } from './types';

// ---------------------------------------------------------------------------
// Bonus tiles and victory
// ---------------------------------------------------------------------------

export function updateLongestRoad(ctx: Ctx) {
  const s = ctx.s;
  const lengths = s.players.map((p) => longestRoadFor(s, p.id));
  s.players.forEach((p, i) => (p.longestRoad = lengths[i]));
  const holder = s.longestRoadHolder;
  const max = Math.max(...lengths);
  let next: PlayerId | null;
  if (holder !== null && lengths[holder] >= LONGEST_ROAD_MIN && lengths[holder] === max) {
    // The holder keeps the tile unless someone has strictly more.
    next = holder;
  } else {
    const top = s.players.filter((p) => lengths[p.id] === max).map((p) => p.id);
    next = max >= LONGEST_ROAD_MIN && top.length === 1 ? top[0] : null;
  }
  if (next !== holder) {
    s.longestRoadHolder = next;
    ctx.emit({ type: 'longestRoadChanged', from: holder, to: next, length: next === null ? 0 : lengths[next] });
  }
}

function updateLargestArmy(ctx: Ctx) {
  const s = ctx.s;
  const holder = s.largestArmyHolder;
  const holderKnights = holder === null ? LARGEST_ARMY_MIN - 1 : s.players[holder].playedKnights;
  const challengers = s.players.filter((p) => p.id !== holder && p.playedKnights > holderKnights);
  if (challengers.length === 0) return;
  const best = Math.max(...challengers.map((p) => p.playedKnights));
  const top = challengers.filter((p) => p.playedKnights === best);
  if (top.length !== 1) return;
  s.largestArmyHolder = top[0].id;
  ctx.emit({ type: 'largestArmyChanged', from: holder, to: top[0].id, knights: best });
}

/** Victory waits for the end of the turn when a module says so (disasters can take points away). */
export const endOfTurnVictory = (s: GameState): boolean => modulesOf(s).some((m) => m.endOfTurnVictory);

/** The player whose turn it is wins on reaching their target (immediately, unless victory waits for the end of the turn). */
/** Work out every award afresh (Longest Route and the modules' own): with modules, after any action and before any victory check. */
function refreshAwards(ctx: Ctx) {
  const mods = modulesOf(ctx.s);
  if (mods.length === 0) return;
  updateLongestRoad(ctx);
  for (const m of mods) m.hooks?.awards?.(ctx);
}

export function checkVictory(ctx: Ctx, atEndOfTurn = false) {
  const s = ctx.s;
  if (isOver(s)) return;
  if (endOfTurnVictory(s) && !atEndOfTurn) return;
  // (A win is decided on the awards as they stand: a flood or a landing may just have moved one.)
  refreshAwards(ctx);
  const vp = totalVictoryPoints(s, s.currentPlayer);
  if (vp >= victoryTarget(s, s.currentPlayer)) {
    s.phase = 'gameOver';
    s.winner = s.currentPlayer;
    s.trade = null;
    s.pending = [];
    ctx.emit({ type: 'gameWon', player: s.currentPlayer, points: vp });
  }
}

/** The game ends with nobody winning (Oil: the island is lost). */
export function loseGame(ctx: Ctx, reason: string) {
  const s = ctx.s;
  if (isOver(s)) return;
  s.phase = 'gameOver';
  s.winner = null;
  s.trade = null;
  s.pending = [];
  ctx.emit({ type: 'gameLost', reason });
}

// ---------------------------------------------------------------------------
// Turn structure helpers
// ---------------------------------------------------------------------------

function startTurn(ctx: Ctx, player: PlayerId) {
  const s = ctx.s;
  s.currentPlayer = player;
  s.phase = 'roll';
  s.hasRolled = false;
  s.dice = null;
  s.devCardPlayedThisTurn = false;
  s.resumePhase = null;
  s.trade = null;
  s.freeRoadsLeft = 0;
  s.stealCandidates = [];
  s.endStep = 0;
  s.coinBuys = 0;
  ctx.emit({ type: 'turnStarted', player, turn: s.turn });
  for (const m of modulesOf(s)) m.hooks?.turnStarted?.(ctx);
  checkVictory(ctx);
}

/** End the turn for good: the end-of-turn victory check, then the dice pass. */
function passTurn(ctx: Ctx) {
  const s = ctx.s;
  if (endOfTurnVictory(s)) {
    checkVictory(ctx, true);
    if (isOver(s)) return;
  }
  ctx.emit({ type: 'turnEnded', player: s.currentPlayer });
  s.turn++;
  startTurn(ctx, (s.currentPlayer + 1) % s.players.length);
}

function endSteps(s: GameState): EndStep[] {
  const steps: EndStep[] = [];
  for (const m of modulesOf(s)) for (const st of m.hooks?.endOfTurn ?? []) steps.push(st);
  // Stable: equal ranks keep module order.
  return steps.map((st, i) => ({ st, i })).sort((a, b) => a.st.rank - b.st.rank || a.i - b.i).map((x) => x.st);
}

/** Run the modules' end-of-turn steps until one waits on a decision, then pass the turn once all have run. */
function runEndOfTurn(ctx: Ctx) {
  const s = ctx.s;
  const steps = endSteps(s);
  while (s.phase === 'endOfTurn' && s.pending.length === 0 && s.endStep < steps.length) steps[s.endStep++].run(ctx);
  if (s.phase === 'endOfTurn' && s.pending.length === 0 && s.endStep >= steps.length) passTurn(ctx);
}

export function finishRobber(ctx: Ctx) {
  const s = ctx.s;
  s.phase = s.resumePhase ?? 'main';
  s.resumePhase = null;
  s.stealCandidates = [];
}

/** Take one random card a theft can take from `victim`'s hand and give it to `thief`. */
export function doSteal(ctx: Ctx, thief: PlayerId, victim: PlayerId, oil = false, by?: StealCause) {
  const s = ctx.s;
  const hand = s.players[victim].hand;
  if (oil) {
    // One oil by name (the caller has checked canTakeOil).
    hand.oil--;
    s.players[thief].hand.oil++;
    ctx.emit({ type: 'stolen', thief, victim, resource: 'oil', named: true, ...(by && { by }) });
    return;
  }
  const cards: Card[] = [];
  for (const r of stealableKinds(s)) for (let i = 0; i < hand[r]; i++) cards.push(r);
  if (cards.length === 0) {
    ctx.emit({ type: 'nothingToSteal', player: thief });
    return;
  }
  const resource = cards[ctx.rng.int(cards.length)];
  hand[resource]--;
  s.players[thief].hand[resource]++;
  ctx.emit({ type: 'stolen', thief, victim, resource, ...(by && { by }) });
}

/**
 * What a roll of `total` grants before the bank pays: each producing hex's take for every building
 * on it, through the modules' yields, and the hexes a blocker stops. (The supply's estimate of
 * income reads this very loop: see income.ts.)
 */
export function rollGrants(s: GameState, total: number): { grants: Production[]; blockedHexes: number[] } {
  const mods = modulesOf(s);
  const grants: Production[] = [];
  const blockedHexes: number[] = [];
  for (const hex of s.board.hexes) {
    if (!numbersOf(s, hex).includes(total)) continue;
    // (Hexes without a resource of their own produce only through the modules: bounty fields, wells, the lake.)
    if (!TERRAIN_RESOURCE[hex.terrain] && mods.length === 0) continue;
    if (hexBlocked(s, hex.id)) {
      blockedHexes.push(hex.id);
      continue;
    }
    grants.push(...hexGrants(s, hex.id));
  }
  return { grants, blockedHexes };
}

/** Whether a blocker stops a hex producing: the robber on it, or a module's rule (the corsair off a fishing ground, raiders holding it). */
export function hexBlocked(s: GameState, hex: number): boolean {
  const h = s.board.hexes[hex];
  return hex === s.robberHex || modulesOf(s).some((m) => m.hooks?.hexBlocked?.(s, h));
}

/**
 * What a hex grants the buildings on it when it produces, through the modules' yields, whether or
 * not it is blocked now (so the table can show what a blocker kept from whom).
 */
export function hexGrants(s: GameState, hex: number): Production[] {
  const mods = modulesOf(s);
  const h = s.board.hexes[hex];
  const resource = TERRAIN_RESOURCE[h.terrain];
  const grants: Production[] = [];
  for (const v of h.vertices) {
    const b = s.buildings[v];
    if (!b) continue;
    let gs: Production[] = resource ? [{ player: b.owner, hex, vertex: v, resource, amount: b.kind === 'city' ? 2 : 1 }] : [];
    for (const m of mods) if (m.hooks?.yields) gs = m.hooks.yields(s, h, v, b, gs);
    grants.push(...gs);
  }
  return grants;
}

function produce(ctx: Ctx, total: number) {
  const s = ctx.s;
  const mods = modulesOf(s);
  const { grants, blockedHexes } = rollGrants(s, total);

  const shortages: Card[] = [];
  const final: Production[] = [];
  for (const r of cardKinds(s)) {
    const rGrants = grants.filter((g) => g.resource === r);
    if (rGrants.length === 0) continue;
    const demand = rGrants.reduce((n, g) => n + g.amount, 0);
    if (demand <= s.bank[r]) {
      final.push(...rGrants);
      continue;
    }
    shortages.push(r);
    const recipients = new Set(rGrants.map((g) => g.player));
    if (recipients.size === 1) {
      // Only one player affected: they receive whatever remains.
      let left = s.bank[r];
      for (const g of rGrants) {
        if (left <= 0) break;
        const amt = Math.min(g.amount, left);
        left -= amt;
        final.push({ ...g, amount: amt });
      }
    }
  }

  for (const g of final) {
    s.bank[g.resource] -= g.amount;
    s.players[g.player].hand[g.resource] += g.amount;
  }
  if (final.length === 0 && blockedHexes.length === 0 && shortages.length === 0) {
    ctx.emit({ type: 'noProduction', total });
  } else {
    ctx.emit({ type: 'production', total, grants: final, blockedHexes, shortages });
  }
  const received = new Set(final.filter((g) => g.amount > 0).map((g) => g.player));
  const base = s.pending.length;
  for (const m of mods) for (const p of m.hooks?.afterProduction?.(ctx, total, final) ?? []) received.add(p);
  const owed = s.pending.length;
  for (const m of mods) m.hooks?.productionFallback?.(ctx, total, received);
  // Rule 6: the fall-backs come last. The stack answers its top first, so what production itself
  // owes (bounty picks, the fish swap) goes above them, and a fall-back can't take a card from the
  // supply that production had already promised.
  if (s.pending.length > owed && owed > base) {
    const fallbacks = s.pending.splice(owed);
    s.pending.splice(base, 0, ...fallbacks);
  }
}

/** Event deck: the next card's dice pair, reshuffling all 36 once only a few remain (they never come up). */
function drawEventCard(ctx: Ctx): [number, number] {
  const s = ctx.s;
  if (!s.eventCards || s.eventCards.length <= EVENT_DECK_RESHUFFLE_AT) s.eventCards = ctx.rng.shuffle(Array.from({ length: 36 }, (_, i) => i));
  const card = s.eventCards.pop()!;
  return [1 + Math.floor(card / 6), 1 + (card % 6)];
}

/** The roll's outcome once its happenings are settled: production, or the 7. */
function finishRoll(ctx: Ctx, total: number) {
  if (total === 7) {
    resolveSeven(ctx);
  } else {
    produce(ctx, total);
    ctx.s.phase = 'main';
  }
}

/** The hand size a 7 leaves alone. */
export function handLimit(s: GameState, player: PlayerId): number {
  let limit = DISCARD_THRESHOLD;
  for (const m of modulesOf(s)) if (m.hooks?.handLimit) limit = m.hooks.handLimit(s, player, limit);
  return limit;
}

/** After the discards of a 7, or for a Knight: a module may take over the robber's step; otherwise the robber moves. */
export function enterRobberPhase(ctx: Ctx, cause: 'seven' | 'knight' = 'seven') {
  const s = ctx.s;
  const mods = modulesOf(s);
  // Rule 4: while any module holds the blockers back, none of them moves, and nobody is robbed.
  if (mods.some((m) => m.hooks?.blockersWaiting?.(s))) {
    ctx.emit({ type: 'nothingToSteal', player: s.currentPlayer });
    finishRobber(ctx);
    return;
  }
  for (const m of mods) if (m.hooks?.robberStep?.(ctx, cause)) return;
  if (legalRobberHexes(s).length === 0) {
    // (Nowhere it may go, say a friendly robber with no desert: it stays where it is.)
    ctx.emit({ type: 'nothingToSteal', player: s.currentPlayer });
    finishRobber(ctx);
    return;
  }
  s.phase = 'moveRobber';
}

/** Resolve a 7: discards, then the robber's step. Also used by happenings that count as a 7. */
export function resolveSeven(ctx: Ctx) {
  const s = ctx.s;
  const pending: Record<number, number> = {};
  for (const p of s.players) {
    const n = totalCards(p.hand);
    if (n > handLimit(s, p.id)) pending[p.id] = Math.floor(n / 2);
  }
  s.resumePhase = 'main';
  if (Object.keys(pending).length > 0) {
    s.pendingDiscards = pending;
    s.phase = 'discard';
    ctx.emit({ type: 'discardRequired', players: { ...pending } });
  } else {
    enterRobberPhase(ctx);
  }
}

function requireCurrent(s: GameState, player: PlayerId) {
  assert(player === s.currentPlayer, 'It is not your turn.');
}

function requirePhase(s: GameState, ...phases: GameState['phase'][]) {
  assert(phases.includes(s.phase), `Not allowed during ${s.phase}.`);
}

/** Run one stage of the modules' after-build hooks. */
function afterBuild(ctx: Ctx, player: PlayerId, piece: PieceKind, at: number, stage: 'reward' | 'award' | 'threat') {
  for (const m of modulesOf(ctx.s)) m.hooks?.afterBuild?.(ctx, player, piece, at, stage);
}

/**
 * A piece has been placed in play: the builder's rewards, then the awards (Longest Route first),
 * then the threats, then the victory check (rule 7).
 */
export function built(ctx: Ctx, player: PlayerId, piece: PieceKind, at: number, routeChanged: boolean) {
  afterBuild(ctx, player, piece, at, 'reward');
  if (routeChanged) updateLongestRoad(ctx);
  afterBuild(ctx, player, piece, at, 'award');
  afterBuild(ctx, player, piece, at, 'threat');
  checkVictory(ctx);
}

/**
 * A route piece (a ship) has moved from one edge to another: the modules' after-move hooks (a
 * river's fee), then Longest Route, then the victory check.
 */
export function moved(ctx: Ctx, player: PlayerId, piece: PieceKind, from: number, to: number) {
  for (const m of modulesOf(ctx.s)) m.hooks?.afterMove?.(ctx, player, piece, from, to);
  updateLongestRoad(ctx);
  checkVictory(ctx);
}

/** A set-up piece has been placed: move on to the next placement, or start the game. */
export function finishSetupPlacement(ctx: Ctx) {
  const s = ctx.s;
  s.lastSetupSettlement = null;
  s.setupIndex++;
  updateLongestRoad(ctx);
  if (s.setupIndex >= s.setupOrder.length) {
    s.turn = 1;
    startTurn(ctx, s.firstPlayer);
  } else {
    s.setupRound = s.setupIndex < s.players.length ? 1 : 2;
    s.currentPlayer = s.setupOrder[s.setupIndex];
    s.phase = 'setupSettlement';
  }
}

/** Whether every module allows `player` this hand (Oil's limit). */
function handAllowed(s: GameState, player: PlayerId, hand: CardCounts): boolean {
  return modulesOf(s).every((m) => m.hooks?.handAllowed?.(s, player, hand) ?? true);
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handle(ctx: Ctx, player: PlayerId, action: Action) {
  const s = ctx.s;
  assert(s.phase !== 'gameOver', 'The game is over.');
  assert(player >= 0 && player < s.players.length, 'Unknown player.');

  // A module's action goes to its module; while a decision is owed, only module actions can answer it.
  const slash = action.type.indexOf('/');
  if (slash > 0) {
    const id = action.type.slice(0, slash) as ModuleId;
    assert(MODULE_IDS.includes(id) && s.options.modules.includes(id), 'That is not part of this game.');
    const top = s.pending[s.pending.length - 1];
    assert(!top || top.kind.startsWith(`${id}/`), 'Another decision has to be made first.');
    const m = MODULES[id];
    assert(m.handle, 'That is not part of this game.');
    m.handle(ctx, player, action);
    return;
  }
  assert(s.pending.length === 0, 'Another decision has to be made first.');
  assert(s.phase !== 'endOfTurn', 'The turn is ending.');
  handleBase(ctx, player, action as BaseAction);
}

function handleBase(ctx: Ctx, player: PlayerId, action: BaseAction) {
  const s = ctx.s;
  const me = s.players[player];

  switch (action.type) {
    // ----------------------------------------------------------------- setup
    case 'placeSetupSettlement': {
      requirePhase(s, 'setupSettlement');
      requireCurrent(s, player);
      const v = action.vertex;
      assert(Number.isInteger(v) && v >= 0 && v < s.board.vertices.length, 'Invalid intersection.');
      assert(satisfiesDistanceRule(s, v), 'Houses must be at least two edges from every other building.');
      assert(placeAllowed(s, player, 'settlement', v), 'You cannot start there.');
      let kind: 'settlement' | 'city' = 'settlement';
      if (s.setupRound === 2) for (const m of modulesOf(s)) kind = m.hooks?.setupSecondKind?.(s) ?? kind;
      s.buildings[v] = { owner: player, kind };
      if (kind === 'city') me.citiesLeft--;
      else me.settlementsLeft--;
      s.lastSetupSettlement = v;
      ctx.emit({ type: 'setupSettlementPlaced', player, vertex: v });
      if (s.setupRound === 2) {
        const grants: { hex: number; resource: Card }[] = [];
        for (const h of s.board.vertices[v].hexes) {
          const res = TERRAIN_RESOURCE[s.board.hexes[h].terrain];
          if (res && s.bank[res] > 0) {
            s.bank[res]--;
            me.hand[res]++;
            grants.push({ hex: h, resource: res });
          }
        }
        ctx.emit({ type: 'startingResources', player, vertex: v, grants });
        for (const m of modulesOf(s)) m.hooks?.startingGrants?.(ctx, player, v);
      }
      for (const m of modulesOf(s)) m.hooks?.afterSetupPiece?.(ctx, player, kind, v);
      s.phase = 'setupRoad';
      return;
    }
    case 'placeSetupRoad': {
      requirePhase(s, 'setupRoad');
      requireCurrent(s, player);
      assert(legalSetupRoads(s).includes(action.edge), 'Your starting road must touch the house you just placed.');
      s.routes[action.edge] = { owner: player, kind: 'road', builtTurn: s.turn };
      me.roadsLeft--;
      ctx.emit({ type: 'setupRoadPlaced', player, edge: action.edge });
      for (const m of modulesOf(s)) m.hooks?.afterSetupPiece?.(ctx, player, 'road', action.edge);
      finishSetupPlacement(ctx);
      return;
    }

    // ------------------------------------------------------------ production
    case 'rollDice': {
      requirePhase(s, 'roll');
      requireCurrent(s, player);
      let rolled: { dice: [number, number]; total: number } | undefined;
      for (const m of modulesOf(s)) if (m.hooks?.rollDice) rolled = m.hooks.rollDice(ctx, rolled);
      if (!rolled) {
        const dice = s.options.eventDeck ? drawEventCard(ctx) : ([ctx.dice.die(), ctx.dice.die()] as [number, number]);
        rolled = { dice, total: dice[0] + dice[1] };
      }
      const { dice, total } = rolled;
      s.dice = dice;
      s.hasRolled = true;
      ctx.emit({ type: 'diceRolled', player, dice: [dice[0], dice[1]], total });
      for (const m of modulesOf(s)) {
        m.hooks?.afterRoll?.(ctx, total);
        if (isOver(s)) return;
      }
      // Decisions the event die or a happening left owed come first: production (or the 7) waits
      // for them, and follows once the last is made (see applyAction).
      if (s.pending.length > 0) {
        s.productionOwed = total;
        return;
      }
      finishRoll(ctx, total);
      return;
    }
    case 'discard': {
      requirePhase(s, 'discard');
      const need = s.pendingDiscards[player];
      assert(need !== undefined, 'You do not need to discard.');
      const cards = readCounts(action.resources);
      assert(cards, 'Invalid discard.');
      assert(totalCards(cards) === need, `You must discard exactly ${need} cards.`);
      assert(hasResources(me.hand, cards), 'You do not have those cards.');
      transfer(me.hand, s.bank, cards);
      delete s.pendingDiscards[player];
      ctx.emit({ type: 'discarded', player, resources: { ...cards } });
      if (Object.keys(s.pendingDiscards).length === 0) enterRobberPhase(ctx);
      return;
    }
    case 'moveRobber': {
      requirePhase(s, 'moveRobber');
      requireCurrent(s, player);
      const h = action.hex;
      assert(Number.isInteger(h) && h >= 0 && h < s.board.hexes.length, 'Invalid hex.');
      if (!legalRobberHexes(s).includes(h)) {
        assert(h !== s.robberHex, 'The robber must move to a different hex.');
        fail(s.options.friendlyRobber ? 'The friendly robber spares players with 2 points or fewer.' : 'The robber stays on land.');
      }
      const from = s.robberHex;
      s.robberHex = h;
      ctx.emit({ type: 'robberMoved', player, from, to: h });
      const candidates = stealCandidates(s, h, player);
      if (candidates.length === 0) {
        ctx.emit({ type: 'nothingToSteal', player });
        finishRobber(ctx);
      } else if (candidates.length === 1 && !canTakeOil(s, player, candidates[0])) {
        doSteal(ctx, player, candidates[0]);
        finishRobber(ctx);
      } else {
        // (A lone victim with oil to name is still a choice: a card at random, or the oil.)
        s.stealCandidates = candidates;
        s.phase = 'steal';
      }
      return;
    }
    case 'steal': {
      requirePhase(s, 'steal');
      requireCurrent(s, player);
      assert(s.stealCandidates.includes(action.victim), 'You cannot rob that player.');
      assert(!action.oil || canTakeOil(s, player, action.victim), 'You have no room for their oil.');
      // (With no blocker on the board, a 7's theft is Invasion's own: from anyone.)
      const unblocked = s.robberHex === null && (s.ext.sea?.corsair ?? null) === null;
      doSteal(ctx, player, action.victim, !!action.oil, unblocked ? 'seven' : undefined);
      finishRobber(ctx);
      return;
    }

    // -------------------------------------------------------------- building
    case 'buildRoad': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      assert(validIndex(action.edge, s.board.edges.length), 'Invalid edge.');
      assert(me.roadsLeft > 0, 'You have no roads left.');
      assert(canAfford(s, player, 'road'), 'You cannot afford a road.');
      assert(isLegalRoad(s, player, action.edge), 'A road must connect to your own road or building.');
      pay(s, player, COSTS.road);
      s.routes[action.edge] = { owner: player, kind: 'road', builtTurn: s.turn };
      me.roadsLeft--;
      ctx.emit({ type: 'roadBuilt', player, edge: action.edge, free: false });
      built(ctx, player, 'road', action.edge, true);
      return;
    }
    case 'buildSettlement': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      assert(validIndex(action.vertex, s.board.vertices.length), 'Invalid intersection.');
      assert(me.settlementsLeft > 0, 'You have no houses left. Upgrade one to a town first.');
      assert(canAfford(s, player, 'settlement'), 'You cannot afford a house.');
      assert(isLegalSettlement(s, player, action.vertex), 'That intersection is not available.');
      pay(s, player, COSTS.settlement);
      s.buildings[action.vertex] = { owner: player, kind: 'settlement' };
      me.settlementsLeft--;
      ctx.emit({ type: 'settlementBuilt', player, vertex: action.vertex });
      built(ctx, player, 'settlement', action.vertex, true);
      return;
    }
    case 'buildCity': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      assert(validIndex(action.vertex, s.board.vertices.length), 'Invalid vertex.');
      const b = s.buildings[action.vertex];
      assert(b && b.owner === player && b.kind === 'settlement', 'Towns must replace one of your houses.');
      // (A city laid down for want of a settlement piece is still a city piece: standing it up takes none.)
      assert(me.citiesLeft > 0 || b.lying, 'You have no towns left.');
      assert(canAfford(s, player, 'city'), 'You cannot afford a town.');
      assert(legalCities(s, player).includes(action.vertex), b.lying ? 'Not allowed here.' : 'Rebuild your fallen town first.');
      pay(s, player, COSTS.city);
      b.kind = 'city';
      if (b.lying) delete b.lying;
      else {
        me.settlementsLeft++;
        me.citiesLeft--;
      }
      ctx.emit({ type: 'cityBuilt', player, vertex: action.vertex });
      built(ctx, player, 'city', action.vertex, false);
      return;
    }
    case 'buyDevCard': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      assert(s.devDeck.length > 0, 'The development deck is empty.');
      assert(canAfford(s, player, 'devCard'), 'You cannot afford a development card.');
      pay(s, player, COSTS.devCard);
      const card = s.devDeck.pop()!;
      me.devCards.push({ type: card, boughtTurn: s.turn });
      ctx.emit({ type: 'devCardBought', player, card });
      checkVictory(ctx);
      return;
    }

    // ------------------------------------------------------ development cards
    case 'playKnight':
    case 'playRoadBuilding':
    case 'playInvention':
    case 'playMonopoly': {
      requirePhase(s, 'roll', 'main');
      requireCurrent(s, player);
      assert(!s.devCardPlayedThisTurn, 'One development card a turn.');
      const cardType: DevCardType =
        action.type === 'playKnight'
          ? 'knight'
          : action.type === 'playRoadBuilding'
            ? 'roadBuilding'
            : action.type === 'playInvention'
              ? 'invention'
              : 'monopoly';
      const idx = me.devCards.findIndex((c) => c.type === cardType && c.boughtTurn < s.turn);
      assert(idx >= 0, me.devCards.some((c) => c.type === cardType) ? 'You cannot play a card on the turn you built it.' : 'You do not have that card.');

      // Validate parameters before consuming the card.
      if (action.type === 'playInvention') {
        // Array.from turns holes into undefined, which `every` would otherwise skip.
        assert(Array.isArray(action.resources) && Array.from(action.resources).every((r) => RESOURCES.includes(r)), 'Invalid resources.');
        const bankTotal = RESOURCES.reduce((n, r) => n + s.bank[r], 0);
        const want = Math.min(2, bankTotal);
        assert(action.resources.length === want, `Choose ${want} resource${want === 1 ? '' : 's'}.`);
        const req = emptyCards();
        for (const r of action.resources) req[r]++;
        assert(hasResources(s.bank, req), 'The supply does not have those resources.');
      }
      if (action.type === 'playMonopoly') assert(RESOURCES.includes(action.resource), 'Invalid resource.');
      if (action.type === 'playRoadBuilding') assert(freeRouteOpen(s, player), 'You have nowhere to build a road.');

      me.devCards.splice(idx, 1);
      me.playedDevCards.push(cardType);
      s.devCardPlayedThisTurn = true;
      ctx.emit({ type: 'devCardPlayed', player, card: cardType });

      if (action.type === 'playKnight') {
        me.playedKnights++;
        updateLargestArmy(ctx);
        checkVictory(ctx);
        if (isOver(s)) return;
        s.resumePhase = s.hasRolled ? 'main' : 'roll';
        enterRobberPhase(ctx, 'knight');
      } else if (action.type === 'playRoadBuilding') {
        s.freeRoadsLeft = 2;
        s.resumePhase = s.hasRolled ? 'main' : 'roll';
        s.phase = 'roadBuilding';
        // (Without other pieces, no more roads than are left in the supply.)
        if (!modulesOf(s).some((m) => m.hooks?.canPlaceFreeRoute)) s.freeRoadsLeft = Math.min(2, me.roadsLeft);
      } else if (action.type === 'playInvention') {
        for (const r of action.resources) {
          s.bank[r]--;
          me.hand[r]++;
        }
        ctx.emit({ type: 'invention', player, resources: [...action.resources] });
      } else {
        const taken: Record<number, number> = {};
        for (const p of s.players) {
          if (p.id === player) continue;
          const n = p.hand[action.resource];
          if (n > 0) {
            taken[p.id] = n;
            p.hand[action.resource] = 0;
            me.hand[action.resource] += n;
          }
        }
        ctx.emit({ type: 'monopoly', player, resource: action.resource, taken });
      }
      return;
    }
    case 'placeFreeRoad': {
      requirePhase(s, 'roadBuilding');
      requireCurrent(s, player);
      assert(validIndex(action.edge, s.board.edges.length), 'Invalid edge.');
      assert(me.roadsLeft > 0, 'You have no roads left.');
      assert(isLegalRoad(s, player, action.edge), 'A road must connect to your own road or building.');
      s.routes[action.edge] = { owner: player, kind: 'road', builtTurn: s.turn };
      me.roadsLeft--;
      s.freeRoadsLeft--;
      ctx.emit({ type: 'roadBuilt', player, edge: action.edge, free: true });
      built(ctx, player, 'road', action.edge, true);
      if (isOver(s)) return;
      finishFreeRoute(ctx, player);
      return;
    }
    case 'skipFreeRoads': {
      requirePhase(s, 'roadBuilding');
      requireCurrent(s, player);
      assert(!freeRouteOpen(s, player), 'Place your free roads: there is still room for one.');
      s.freeRoadsLeft = 0;
      s.phase = s.resumePhase ?? 'main';
      s.resumePhase = null;
      ctx.emit({ type: 'freeRoadsFinished', player });
      return;
    }

    // ---------------------------------------------------------------- trading
    case 'bankTrade': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      const times = action.times ?? 1;
      assert(Number.isInteger(times) && times >= 1, 'Invalid trade amount.');
      const kinds = cardKinds(s);
      assert(kinds.includes(action.give) && kinds.includes(action.get), 'Invalid resource.');
      assert(action.give !== action.get, 'You must receive a different resource.');
      assert(action.get !== 'oil', 'The bank never sells oil.');
      const ratio = tradeRatios(s, player)[action.give];
      assert(Number.isFinite(ratio), `The bank does not take ${action.give}.`);
      const giveCount = ratio * times;
      assert(me.hand[action.give] >= giveCount, `You need ${giveCount} ${action.give}.`);
      assert(s.bank[action.get] >= times, `The supply has no ${action.get} left.`);
      me.hand[action.give] -= giveCount;
      s.bank[action.give] += giveCount;
      s.bank[action.get] -= times;
      me.hand[action.get] += times;
      ctx.emit({ type: 'bankTraded', player, give: action.give, giveCount, get: action.get, getCount: times });
      return;
    }
    case 'offerTrade': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      // (Asking nothing in particular is an open offer: the others answer it with what they'd give.)
      const [give, get] = validateTradeShape(s, action.give, action.get, true);
      assert(hasResources(me.hand, give), 'You do not have the cards you are offering.');
      // Reject malformed recipient lists rather than quietly widening them to everyone;
      // only an omitted list means "everyone". Checked as a dense copy: `every` skips holes.
      assert(action.to === undefined || Array.isArray(action.to), 'Invalid trade recipients.');
      const to = action.to === undefined ? [] : Array.from(action.to);
      assert(
        to.every((p, i) => validIndex(p, s.players.length) && p !== player && to.indexOf(p) === i),
        'Invalid trade recipients.',
      );
      s.trade = {
        id: s.nextTradeId++,
        proposer: player,
        give,
        get,
        to: to.slice(),
        responses: {},
        counters: {},
      };
      ctx.emit({ type: 'tradeOffered', offer: cloneTrade(s.trade) });
      return;
    }
    case 'respondTrade': {
      requirePhase(s, 'main');
      requireOffer(s, action.offer);
      const t = s.trade;
      assert(t, 'There is no trade offer.');
      assert(player !== t.proposer, 'You cannot respond to your own offer.');
      assert(t.to.length === 0 || t.to.includes(player), 'This offer is not addressed to you.');
      assert(typeof action.accept === 'boolean', 'Invalid response.');
      if (action.accept) assert(!isOpenOffer(t), 'This offer asks what you would give: answer it with a counter-offer.');
      if (action.accept) assert(hasResources(me.hand, t.get), 'You do not have the requested cards.');
      t.responses[player] = action.accept ? 'accepted' : 'rejected';
      ctx.emit({ type: 'tradeResponded', player, accept: action.accept });
      return;
    }
    case 'counterTrade': {
      requirePhase(s, 'main');
      requireOffer(s, action.offer);
      const t = s.trade;
      assert(t, 'There is no trade offer to counter.');
      assert(player !== t.proposer, 'You cannot counter your own offer.');
      assert(t.to.length === 0 || t.to.includes(player), 'This offer is not addressed to you.');
      const [give, get] = validateTradeShape(s, action.give, action.get);
      assert(hasResources(me.hand, give), 'You do not have the cards you are offering.');
      t.counters[player] = { give, get };
      delete t.responses[player];
      ctx.emit({ type: 'tradeCountered', player, give: { ...give }, get: { ...get } });
      return;
    }
    case 'acceptTrade': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      requireOffer(s, action.offer);
      const t = s.trade;
      assert(t && t.proposer === player, 'There is no offer of yours to accept.');
      const partner = action.partner;
      assert(partner !== player && validIndex(partner, s.players.length), 'Invalid trading partner.');
      assert(action.counter === undefined || typeof action.counter === 'boolean', 'Invalid trade acceptance.');
      const other = s.players[partner];
      let give: CardCounts;
      let get: CardCounts;
      if (action.counter) {
        const c = t.counters[partner];
        assert(c, 'That player has not made a counter-offer.');
        give = c.get; // what the proposer gives
        get = c.give; // what the proposer receives
      } else {
        assert(t.responses[partner] === 'accepted', 'That player has not accepted the offer.');
        give = t.give;
        get = t.get;
      }
      assert(hasResources(me.hand, give), 'You no longer have the offered cards.');
      assert(hasResources(other.hand, get), `${other.name} no longer has the requested cards.`);
      const mine = { ...me.hand };
      const theirs = { ...other.hand };
      transfer(mine, theirs, give);
      transfer(theirs, mine, get);
      assert(handAllowed(s, player, mine) && handAllowed(s, partner, theirs), 'That would leave someone holding more oil than they may.');
      transfer(me.hand, other.hand, give);
      transfer(other.hand, me.hand, get);
      s.trade = null;
      ctx.emit({ type: 'tradeExecuted', from: player, to: partner, give: { ...give }, get: { ...get } });
      return;
    }
    case 'cancelTrade': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      requireOffer(s, action.offer);
      assert(s.trade, 'There is no trade offer.');
      s.trade = null;
      ctx.emit({ type: 'tradeCancelled', player });
      return;
    }

    case 'undo': {
      const u = s.undo;
      assert(u && u.player === player, 'Nothing to take back.');
      const b = u.before;
      const refund = emptyCards();
      const returned = emptyCards();
      for (const r of CARDS) {
        const d = b.players[player].hand[r] - me.hand[r];
        if (d > 0) refund[r] = d;
        else returned[r] = -d;
      }
      // Back exactly as it was (the action counter keeps counting). An offer made since stays open:
      // taking a piece back only returns cards, so whoever answered can still trade.
      ctx.s = { ...cloneState(b), seq: s.seq, trade: s.trade && cloneTrade(s.trade), nextTradeId: s.nextTradeId };
      let at = s.routes.findIndex((r, e) => (r?.owner ?? null) !== (b.routes[e]?.owner ?? null));
      let kind: 'road' | 'settlement' | 'city' = 'road';
      if (at < 0) {
        at = s.buildings.findIndex((x, v) => x?.kind !== b.buildings[v]?.kind);
        kind = b.buildings[at] ? 'city' : 'settlement';
      }
      if (at < 0) {
        // A bank trade: the cards go back the other way.
        const give = CARDS.find((r) => returned[r] > 0)!;
        const get = CARDS.find((r) => refund[r] > 0)!;
        ctx.emit({ type: 'bankTraded', player, give, giveCount: returned[give], get, getCount: refund[get], undo: true });
        return;
      }
      ctx.emit({ type: 'undone', player, kind, at, refund, returned });
      if (s.longestRoadHolder !== b.longestRoadHolder) {
        const to = b.longestRoadHolder;
        ctx.emit({ type: 'longestRoadChanged', from: s.longestRoadHolder, to, length: to === null ? 0 : b.players[to].longestRoad });
      }
      return;
    }

    case 'buyWithCoins': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      assert(usesCoins(s), 'There are no coins in this game.');
      assert(RESOURCES.includes(action.get), 'Coins buy resources only.');
      assert(s.coinBuys < COIN_BUYS_PER_TURN, `Coins buy at most ${COIN_BUYS_PER_TURN} resources a turn.`);
      assert(me.coins >= COINS_PER_RESOURCE, `A resource costs ${COINS_PER_RESOURCE} coins.`);
      assert(s.bank[action.get] >= 1, `The supply has no ${action.get} left.`);
      me.coins -= COINS_PER_RESOURCE;
      s.bank[action.get]--;
      me.hand[action.get]++;
      s.coinBuys++;
      ctx.emit({ type: 'coinTraded', player, card: action.get, cards: 1, coins: COINS_PER_RESOURCE, bought: true });
      return;
    }
    case 'sellForCoins': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      assert(usesCoins(s), 'There are no coins in this game.');
      const times = action.times ?? 1;
      assert(Number.isInteger(times) && times >= 1, 'Invalid trade amount.');
      assert(cardKinds(s).includes(action.give), 'Invalid card.');
      const ratio = tradeRatios(s, player)[action.give];
      assert(Number.isFinite(ratio), `The bank does not take ${action.give}.`);
      const giveCount = ratio * times;
      assert(me.hand[action.give] >= giveCount, `You need ${giveCount} ${action.give}.`);
      me.hand[action.give] -= giveCount;
      s.bank[action.give] += giveCount;
      me.coins += times;
      ctx.emit({ type: 'coinTraded', player, card: action.give, cards: giveCount, coins: times, bought: false });
      return;
    }

    case 'endTurn': {
      requirePhase(s, 'main');
      requireCurrent(s, player);
      if (endSteps(s).length > 0) {
        s.trade = null;
        s.phase = 'endOfTurn';
        s.endStep = 0;
        runEndOfTurn(ctx);
        return;
      }
      passTurn(ctx);
      return;
    }

    default: {
      const never: never = action;
      fail(`Unknown action ${(never as Action).type}`);
    }
  }
}

/** A free route piece has gone down: finish Road Crew when none are left or none fit. */
export function finishFreeRoute(ctx: Ctx, player: PlayerId) {
  const s = ctx.s;
  if (s.freeRoadsLeft <= 0 || !freeRouteOpen(s, player)) {
    s.freeRoadsLeft = 0;
    s.phase = s.resumePhase ?? 'main';
    s.resumePhase = null;
    ctx.emit({ type: 'freeRoadsFinished', player });
  }
}

/**
 * A trade answer that names its offer (online play does) answers that offer or none: one that came
 * in after the offer was settled or replaced is refused, not taken for an answer to the next. An
 * answer without `offer` (every recorded game's) answers whatever offer is open, as it always has.
 */
function requireOffer(s: GameState, offer: unknown) {
  if (offer === undefined) return;
  assert(Number.isInteger(offer), 'Invalid offer id.');
  assert(s.trade?.id === offer, s.trade ? `That offer was replaced: offer ${s.trade.id} is open now.` : 'That offer is no longer open.');
}

/** `open`: an offer may ask nothing in return (an open offer, answered with counter-offers). */
function validateTradeShape(s: GameState, give: unknown, get: unknown, open = false): [CardCounts, CardCounts] {
  const g = readCounts(give);
  const w = readCounts(get);
  assert(g && w, 'Invalid trade.');
  const kinds = cardKinds(s);
  assert(CARDS.every((k) => kinds.includes(k) || (g[k] === 0 && w[k] === 0)), 'Invalid trade.');
  assert(totalCards(g) > 0 && (open || totalCards(w) > 0), 'Both sides of a trade must include at least one card.');
  assert(CARDS.every((r) => g[r] === 0 || w[r] === 0), 'You may not trade a resource for the same resource.');
  return [g, w];
}

/** Trade offers are nested records; copied whole whenever one leaves the reducer. */
function cloneTrade(t: TradeOffer): TradeOffer {
  return {
    ...t,
    give: { ...t.give },
    get: { ...t.get },
    to: t.to.slice(),
    responses: { ...t.responses },
    counters: Object.fromEntries(Object.entries(t.counters).map(([k, c]) => [k, { give: { ...c.give }, get: { ...c.get } }])) as TradeOffer['counters'],
    ...(t.readiness && { readiness: { accepted: t.readiness.accepted.slice(), counters: t.readiness.counters.slice() } }),
  };
}

/**
 * Copy of the mutable parts of a state. The board, options and set-up order never change
 * after creation and are shared, which makes an action about 60× cheaper than a deep clone
 * (the board was ~93% of the copy). Module state is plain data and copied whole.
 */
export function cloneState(s: GameState): GameState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, hand: { ...p.hand }, devCards: p.devCards.map((c) => ({ ...c })), playedDevCards: p.playedDevCards.slice() })),
    buildings: s.buildings.map((b) => (b ? { ...b } : null)),
    routes: s.routes.map((r) => (r ? { ...r } : null)),
    bank: { ...s.bank },
    devDeck: s.devDeck.slice(),
    dice: s.dice ? [s.dice[0], s.dice[1]] : null,
    pendingDiscards: { ...s.pendingDiscards },
    stealCandidates: s.stealCandidates.slice(),
    trade: s.trade && cloneTrade(s.trade),
    eventCards: s.eventCards?.slice(),
    tracker: s.tracker?.slice(),
    pending: s.pending.length === 0 ? [] : clonePlain(s.pending),
    wardens: s.wardens.map((w) => ({ ...w })),
    ext: s.options.modules.length === 0 ? {} : clonePlain(s.ext),
  };
}

/**
 * What structuredClone makes of plain data (objects, arrays and what they hold), made several
 * times faster by copying in place of serialising. As with structuredClone, an object held in two
 * places is copied once and stays shared, and an array's holes stay holes; anything other than a
 * plain object or array (which module state shouldn't hold) is left to structuredClone.
 */
export function clonePlain<T>(v: T, seen = new Map<object, unknown>()): T {
  if (typeof v !== 'object' || v === null) return v;
  const done = seen.get(v);
  if (done !== undefined) return done as T;
  const proto = Object.getPrototypeOf(v);
  if (proto === Array.prototype) {
    const a = v as unknown as unknown[];
    const out = new Array<unknown>(a.length);
    seen.set(v, out);
    for (let i = 0; i < a.length; i++) if (i in a) out[i] = clonePlain(a[i], seen);
    return out as T;
  }
  if (proto === Object.prototype) {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    seen.set(v, out);
    for (const k of Object.keys(o)) out[k] = clonePlain(o[k], seen);
    return out as T;
  }
  const out = structuredClone(v);
  seen.set(v, out);
  return out;
}

export function applyAction(state: GameState, player: PlayerId, action: Action): ActionResult | ActionError {
  if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') return { ok: false, error: 'Invalid action.' };
  if (!Number.isInteger(player) || player < 0 || player >= state.players.length) return { ok: false, error: 'Invalid player.' };
  const ctx = new Ctx(cloneState(state));
  try {
    handle(ctx, player, action);
    // A roll waits on the decisions its happenings left owed; once they're made, it carries on.
    if (ctx.s.productionOwed !== undefined && ctx.s.pending.length === 0 && !isOver(ctx.s)) {
      const total = ctx.s.productionOwed;
      delete ctx.s.productionOwed;
      finishRoll(ctx, total);
    }
    // The turn's end waits on decisions; once they're made, it carries on.
    if (ctx.s.phase === 'endOfTurn' && ctx.s.pending.length === 0) runEndOfTurn(ctx);
    const mods = modulesOf(ctx.s);
    // With modules an award can move with no piece placed (a hex conquered or freed, a building
    // flooded, a landing the hooks make): every one is worked out afresh after each action, the
    // game's last included, so the final standings are right.
    if (mods.length > 0 && isOver(ctx.s)) refreshAwards(ctx);
    if (mods.length > 0 && !isOver(ctx.s)) {
      for (const m of mods) m.hooks?.afterAction?.(ctx);
      // (An award that moved can decide the game: only for the player whose turn it is. The check
      // refreshes the awards itself where it goes on to count the points, so they aren't worked
      // out twice.)
      const check = ctx.s.phase !== 'setupSettlement' && ctx.s.phase !== 'setupRoad';
      if (!check || isOver(ctx.s) || endOfTurnVictory(ctx.s)) refreshAwards(ctx);
      if (check) checkVictory(ctx);
    }
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message };
    throw e;
  }
  ctx.s.rngState = ctx.rng.state;
  ctx.s.seq++;
  // (A take-back restores the tracker with the rest of the state.)
  if (action.type !== 'undo') trackEvents(ctx.s, ctx.events);
  // A piece just placed (or a bank trade) may be taken back until anything else happens; trade
  // talk doesn't count, as no cards change hands. Nothing that rolled dice (a landing), left a
  // decision owed or brought something hidden to light (a face-down hex) can be taken back.
  if (UNDOABLE.has(action.type) && !isOver(ctx.s) && ctx.rng.state === state.rngState && ctx.s.pending.length === 0 && !ctx.revealed) ctx.s.undo = { player, before: state };
  else if (action.type !== 'undo' && !KEEPS_UNDO.has(action.type)) ctx.s.undo = null;
  return { ok: true, state: ctx.s, events: ctx.events };
}

const UNDOABLE = new Set<Action['type']>(['buildRoad', 'buildSettlement', 'buildCity', 'placeSetupSettlement', 'bankTrade']);
const KEEPS_UNDO = new Set<Action['type']>(['offerTrade', 'respondTrade', 'counterTrade', 'cancelTrade']);

/** Convenience for tests and tools: apply or throw. */
export function mustApply(state: GameState, player: PlayerId, action: Action): ActionResult {
  const res = applyAction(state, player, action);
  if (!res.ok) throw new Error(`${action.type} by ${player}: ${res.error}`);
  return res;
}

export type { Resource };
