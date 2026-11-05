// Shared harness for bot-only simulations and the random-legal-action fuzzer.

import {
  CARDS,
  RESOURCES,
  RESOURCE_SUPPLY,
  DEV_DECK,
  PIECES,
  LONGEST_ROAD_MIN,
  LARGEST_ARMY_MIN,
  Rng,
  applyAction,
  createGame,
  emptyCards,
  legalActions,
  longestRoadFor,
  seedFrom,
  totalVictoryPoints,
  victoryTarget,
  withBoard,
  type Action,
  type Card,
  type GameOptions,
  type GameState,
  type PlayerSetup,
} from '../src/engine';
import { modulesOf } from '../src/engine/modules';
import { EXPANSIONS, mixOf, poolFor, type Expansion } from '../src/engine/presets';
import { endOfTurnVictory } from '../src/engine/reducer';
import { actionKey, botDecide, createBotMemory, type BotDifficulty, type BotMemory } from '../src/engine/ai';

const DEV_TOTAL = Object.values(DEV_DECK).reduce((a, b) => a + b, 0);
const COLORS = ['red', 'blue', 'white', 'orange'] as const;

export function setups(n: number): PlayerSetup[] {
  return Array.from({ length: n }, (_, i) => ({ name: `P${i}`, color: COLORS[i], isBot: true }));
}

/** Every playable mix: each subset of the expansions (the base game's empty one too), on each map its pool offers. */
export function mixes(every = true) {
  const ids = EXPANSIONS.map((e) => e.id);
  const out: { label: string; chosen: Expansion[]; map: string }[] = [];
  for (let bits = 0; bits < 1 << ids.length; bits++) {
    const chosen = ids.filter((_, i) => bits & (1 << i));
    // (A preset fixes its own map: the pool doesn't apply, so take it once.)
    const preset = mixOf(chosen).preset?.map;
    const pool = preset ? [preset] : poolFor(chosen);
    // (`every` false: one map of each pool, in turn, so every map is still dealt.)
    for (const map of every ? pool : [pool[bits % pool.length]]) {
      const mix = mixOf(chosen, map);
      if (!mix.playable) continue;
      out.push({ label: `${chosen.join('+') || 'base'}@${mix.map}`, chosen, map });
    }
  }
  return out;
}

/** A game's options as a new game sets them up: with its board dealt (unless it carries one), so the bots play the islands players get. */
export const newGame = (players: number, options: Partial<GameOptions>): Partial<GameOptions> => (options.board ? options : withBoard(players, options));

/**
 * Throws with a descriptive message if any engine invariant is violated. `supply` is each kind of
 * card's total in play (bank and hands together) when a module changes it (oil leaves the game when
 * it's burned or sequestered, so modules that do that pass their own totals); by default the base supply.
 */
export function checkInvariants(s: GameState, label: string, supply?: Partial<Record<Card, number>>) {
  const fail = (msg: string): never => {
    throw new Error(`[${label}] seq ${s.seq} turn ${s.turn} phase ${s.phase}: ${msg}`);
  };
  for (const r of CARDS) {
    if (s.bank[r] < 0) fail(`bank ${r} negative`);
    let sum = s.bank[r];
    for (const p of s.players) {
      if (p.hand[r] < 0) fail(`player ${p.id} ${r} negative`);
      sum += p.hand[r];
    }
    const want = supply?.[r] ?? (RESOURCES.includes(r as never) ? RESOURCE_SUPPLY : 0);
    if (sum !== want) fail(`${r} not conserved: ${sum} (want ${want})`);
  }
  for (const p of s.players) if (p.coins < 0) fail(`player ${p.id} coins negative`);
  const devCount = s.devDeck.length + s.players.reduce((n, p) => n + p.devCards.length + p.playedDevCards.length, 0);
  // (A module may replace the development cards with its own deck: then the game's own count holds.)
  if (devCount !== devTotal(s, devCount)) fail(`dev cards not conserved: ${devCount}`);

  const settlements = s.players.map(() => 0);
  const cities = s.players.map(() => 0);
  const roads = s.players.map(() => 0);
  // (A city laid down for want of a settlement piece is still a city piece.)
  for (const b of s.buildings) if (b) (b.kind === 'city' || b.lying ? cities : settlements)[b.owner]++;
  for (const r of s.routes) if (r !== null && r.kind === 'road') roads[r.owner]++;
  const lengths = s.players.map((p) => longestRoadFor(s, p.id));
  for (const p of s.players) {
    if (p.settlementsLeft < 0 || p.citiesLeft < 0 || p.roadsLeft < 0) fail(`player ${p.id} negative pieces`);
    if (p.settlementsLeft + settlements[p.id] !== PIECES.settlements) fail(`player ${p.id} settlements ${p.settlementsLeft}+${settlements[p.id]}`);
    if (p.citiesLeft + cities[p.id] !== PIECES.cities) fail(`player ${p.id} cities ${p.citiesLeft}+${cities[p.id]}`);
    if (p.roadsLeft + roads[p.id] !== PIECES.roads) fail(`player ${p.id} roads ${p.roadsLeft}+${roads[p.id]}`);
    if (p.playedKnights !== p.playedDevCards.filter((c) => c === 'knight').length) fail(`player ${p.id} knight count mismatch`);
    if (p.longestRoad !== lengths[p.id]) fail(`player ${p.id} cached longest route ${p.longestRoad} != ${lengths[p.id]}`);
  }
  if (s.longestRoadHolder !== null) {
    const h = s.longestRoadHolder;
    if (lengths[h] < LONGEST_ROAD_MIN) fail(`longest route holder ${h} has only ${lengths[h]}`);
    if (lengths.some((l) => l > lengths[h])) fail(`longest route holder ${h} (${lengths[h]}) beaten: ${lengths}`);
  }
  if (s.largestArmyHolder !== null) {
    const h = s.largestArmyHolder;
    const k = s.players.map((p) => p.playedKnights);
    if (k[h] < LARGEST_ARMY_MIN) fail(`biggest army holder ${h} has only ${k[h]}`);
    if (k.some((x) => x > k[h])) fail(`biggest army holder ${h} (${k[h]}) beaten: ${k}`);
  }
  if (s.phase !== 'gameOver' && s.phase !== 'setupSettlement' && s.phase !== 'setupRoad' && !endOfTurnVictory(s)) {
    const vp = totalVictoryPoints(s, s.currentPlayer);
    if (vp >= victoryTarget(s, s.currentPlayer)) fail(`current player ${s.currentPlayer} has ${vp} VP but the game continues`);
  }
  if (s.phase === 'gameOver') {
    const w = s.winner;
    // (A game can end with nobody winning: Oil's lost island.)
    if (w !== null && totalVictoryPoints(s, w) < victoryTarget(s, w)) fail('winner below the target');
  }
  for (const m of modulesOf(s)) for (const problem of m.invariants?.(s) ?? []) fail(`${m.id}: ${problem}`);
}

export interface GameResult {
  seed: number;
  players: number;
  layout: 'beginner' | 'random';
  difficulties: BotDifficulty[];
  winner: number | null;
  turns: number;
  actions: number;
  offers: number;
  tradesExecuted: number;
  vp: number[];
  decideCalls: number;
  decideMs: number;
  maxDecideMs: number;
  fallbacks: number;
  /** Non-winners that reached the target off-turn (via a Longest Route transfer) but never got a turn. */
  offTurnReachers: number[];
}

export interface BotGameOptions {
  seed: number;
  players: 3 | 4;
  layout: 'beginner' | 'random';
  /** Any other game options: modules, a map, knobs, a target. */
  options?: Partial<GameOptions>;
  /** Each kind of card's total in play, where modules change it (see checkInvariants). */
  supply?: (s: GameState) => Partial<Record<Card, number>>;
  numberPlacement?: 'spiral' | 'balanced';
  difficulties: BotDifficulty[];
  maxTurns?: number;
  /** Also assert that every non-offer bot action appears in legalActions (slower). */
  crossCheckLegal?: boolean;
}


export function runBotGame(o: BotGameOptions): GameResult {
  const maxTurns = o.maxTurns ?? 600;
  const label = `bot seed=${o.seed} n=${o.players} ${o.layout} ${o.difficulties.join(',')}`;
  let state = createGame(setups(o.players), newGame(o.players, { layout: o.layout, seed: o.seed, numberPlacement: o.numberPlacement ?? 'spiral', ...o.options })).state;
  // (A module's own totals, for the kinds it changes, over the game's starting supply for the rest.)
  const supply = (st: GameState) => ({ ...defaultSupply(st), ...o.supply?.(st) });
  checkInvariants(state, label, supply(state));
  const memories: BotMemory[] = state.players.map(() => createBotMemory());
  const res: GameResult = {
    seed: o.seed,
    players: o.players,
    layout: o.layout,
    difficulties: o.difficulties,
    winner: null,
    turns: 0,
    actions: 0,
    offers: 0,
    tradesExecuted: 0,
    vp: [],
    decideCalls: 0,
    decideMs: 0,
    maxDecideMs: 0,
    fallbacks: 0,
    offTurnReachers: [],
  };
  const reachedOffTurn = new Set<number>();
  const n = o.players;

  while (state.phase !== 'gameOver') {
    if (state.turn > maxTurns) throw new Error(`[${label}] exceeded ${maxTurns} turns`);
    let acted = false;
    // Rotate the polling order so no seat is systematically asked first.
    const start = state.seq % n;
    for (let i = 0; i < n; i++) {
      const p = (start + i) % n;
      const t0 = performance.now();
      const action = botDecide(state, p, memories[p], o.difficulties[p]);
      const dt = performance.now() - t0;
      res.decideCalls++;
      res.decideMs += dt;
      if (dt > res.maxDecideMs) res.maxDecideMs = dt;
      if (!action) continue;
      if (o.crossCheckLegal && action.type !== 'offerTrade' && action.type !== 'discard') {
        if (!legalActions(state, p).some((a) => actionKey(a) === actionKey(action))) throw new Error(`[${label}] bot action not in legalActions: ${JSON.stringify(action)}`);
      }
      const r = applyAction(state, p, action);
      if (!r.ok) throw new Error(`[${label}] bot ${p} illegal ${JSON.stringify(action)}: ${r.error}`);
      if (action.type === 'offerTrade') res.offers++;
      if (r.events.some((e) => e.type === 'tradeExecuted')) res.tradesExecuted++;
      const before = state;
      state = r.state;
      res.actions++;
      checkInvariants(state, label, supply(state));
      for (const pl of state.players) {
        if (pl.id === state.currentPlayer || totalVictoryPoints(state, pl.id) < state.options.victoryPoints) continue;
        // (The action that ends the game counts only for those it lifted to the target: battles
        // hand out prisoners to several players at once, and only the player whose turn it is wins.)
        if (state.phase !== 'gameOver' || totalVictoryPoints(before, pl.id) < before.options.victoryPoints) reachedOffTurn.add(pl.id);
      }
      acted = true;
      break;
    }
    if (!acted) throw new Error(`[${label}] deadlock: no bot acted (phase ${state.phase}, current ${state.currentPlayer}, pending ${JSON.stringify(state.pending.at(-1))}, trade ${JSON.stringify(state.trade)})`);
  }

  res.winner = state.winner;
  res.turns = state.turn;
  res.vp = state.players.map((p) => totalVictoryPoints(state, p.id));
  res.fallbacks = memories.reduce((a, m) => a + m.fallbacks, 0);
  for (const p of state.players) {
    if (state.winner !== null && p.id !== state.winner && res.vp[p.id] >= victoryTarget(state, p.id)) {
      if (!reachedOffTurn.has(p.id)) throw new Error(`[${label}] non-winner ${p.id} has ${res.vp[p.id]} VP`);
      res.offTurnReachers.push(p.id);
    }
  }
  return res;
}

/** Development cards in play: the base deck's, or with modules, as many as the first state checked of the game held. */
const devTotals = new WeakMap<object, number>();
function devTotal(s: GameState, count: number): number {
  if (s.options.modules.length === 0) return DEV_TOTAL;
  let total = devTotals.get(s.options);
  if (total === undefined) {
    total = count;
    devTotals.set(s.options, total);
  }
  return total;
}

/** Every kind of card's total at the start (bank plus hands): what checkInvariants holds a game to by default. */
const supplyCache = new WeakMap<object, Partial<Record<Card, number>>>();
/** Every kind of card in `s`, bank and hands together: the supply to hold a scene's later states to. */
export function cardsInPlay(s: GameState): Partial<Record<Card, number>> {
  const out: Partial<Record<Card, number>> = {};
  for (const r of CARDS) out[r] = s.bank[r] + s.players.reduce((n, p) => n + p.hand[r], 0);
  return out;
}

function defaultSupply(s: GameState): Partial<Record<Card, number>> {
  // Keyed on the options object, which every state of one game shares.
  let sup = supplyCache.get(s.options);
  if (!sup) {
    sup = {};
    for (const r of CARDS) sup[r] = s.bank[r] + s.players.reduce((n, p) => n + p.hand[r], 0);
    supplyCache.set(s.options, sup);
  }
  return sup;
}

export interface FuzzResult {
  steps: number;
  checkedActions: number;
  finished: boolean;
  phases: Record<string, number>;
}

function randomOffer(s: GameState, p: number, rng: Rng): Action | null {
  const hand = s.players[p].hand;
  const have = RESOURCES.filter((r) => hand[r] > 0);
  if (have.length === 0) return null;
  const give = emptyCards();
  const g = have[rng.int(have.length)];
  give[g] = 1 + rng.int(Math.min(2, hand[g]));
  const others = RESOURCES.filter((r) => r !== g);
  const get = emptyCards();
  get[others[rng.int(others.length)]] = 1 + rng.int(2);
  return { type: 'offerTrade', give, get };
}

/**
 * Plays a game by picking uniformly among legal actions. When `verifyAll` is set, every entry of every
 * player's legalActions is applied (on a throwaway copy) at every step and must succeed.
 */
export function runFuzzGame(
  seed: number,
  players: 3 | 4,
  layout: 'beginner' | 'random',
  steps: number,
  verifyAll: boolean,
  options: Partial<GameOptions> = {},
  supplyOf?: (s: GameState) => Partial<Record<Card, number>>,
): FuzzResult {
  const label = `fuzz seed=${seed} n=${players} ${layout} ${(options.modules ?? []).join('+')}`;
  let state = createGame(setups(players), newGame(players, { layout, seed, numberPlacement: seed % 2 ? 'balanced' : 'spiral', ...options })).state;
  const supply = (st: GameState) => ({ ...defaultSupply(st), ...supplyOf?.(st) });
  const rng = new Rng(seedFrom(seed * 7919 + 13));
  const out: FuzzResult = { steps: 0, checkedActions: 0, finished: false, phases: {} };
  checkInvariants(state, label, supply(state));

  for (let step = 0; step < steps && state.phase !== 'gameOver'; step++) {
    const per = state.players.map((p) => legalActions(state, p.id));
    if (verifyAll) {
      per.forEach((acts, p) => {
        for (const a of acts) {
          const r = applyAction(state, p, a);
          if (!r.ok) throw new Error(`[${label}] step ${step}: legal action failed for ${p} ${JSON.stringify(a)}: ${r.error}`);
          out.checkedActions++;
        }
      });
    }
    const actors = per.map((a, p) => (a.length > 0 ? p : -1)).filter((p) => p >= 0);
    if (actors.length === 0) throw new Error(`[${label}] step ${step}: nobody can act in phase ${state.phase}`);
    let actor: number;
    if (state.phase === 'main' && state.trade && actors.length > 1 && rng.next() < 0.6) {
      const responders = actors.filter((p) => p !== state.currentPlayer);
      actor = responders.length > 0 ? responders[rng.int(responders.length)] : state.currentPlayer;
    } else {
      actor = actors.includes(state.currentPlayer) ? state.currentPlayer : actors[rng.int(actors.length)];
    }
    const choices = [...per[actor]];
    if (state.phase === 'main' && actor === state.currentPlayer && !state.trade && rng.next() < 0.15) {
      const offer = randomOffer(state, actor, rng);
      if (offer) choices.push(offer);
    }
    const action = choices[rng.int(choices.length)];
    const r = applyAction(state, actor, action);
    if (!r.ok && action.type !== 'offerTrade') throw new Error(`[${label}] step ${step}: chosen action failed ${JSON.stringify(action)}: ${r.error}`);
    if (r.ok) state = r.state;
    out.phases[state.phase] = (out.phases[state.phase] ?? 0) + 1;
    checkInvariants(state, label, supply(state));
    out.steps++;
  }
  out.finished = state.phase === 'gameOver';
  return out;
}

