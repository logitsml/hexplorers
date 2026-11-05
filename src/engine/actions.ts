// Enumeration of every concrete action a player may legally take right now.
// Domestic trade offers and counter-offers are omitted (their space is effectively unbounded).

import { countsKey, emptyCards } from './constants';
import { memo, Query } from './memo';
import { modulesOf } from './modules';
import { Rng, seedFrom } from './rng';
import { publicRng } from './keyedRng';
import {
  COIN_BUYS_PER_TURN,
  COINS_PER_RESOURCE,
  canAfford,
  cardKinds,
  freeRouteOpen,
  hasResources,
  isOpenOffer,
  legalCities,
  legalRobberHexes,
  legalRoads,
  legalSettlements,
  legalSetupRoads,
  legalSetupSettlements,
  playableDevCards,
  totalCards,
  tradeRatios,
  usesCoins,
  theftChoices,
} from './rules';
import type { Action, Card, CardCounts, DevCardType, GameState, PlayerId, Resource, TradeReadiness } from './types';
import { RESOURCES } from './types';

/** Above this many distinct discard combinations, a deterministic sample is returned instead. */
export const DISCARD_ENUMERATION_LIMIT = 120;

/** Number of distinct multisets of `count` cards that can be drawn from `hand`. */
function countDiscardCombinations(hand: CardCounts, count: number, kinds: readonly Card[] = RESOURCES): number {
  let ways = new Array<number>(count + 1).fill(0);
  ways[0] = 1;
  for (const r of kinds) {
    const next = new Array<number>(count + 1).fill(0);
    for (let j = 0; j <= count; j++) {
      if (ways[j] === 0) continue;
      for (let k = 0; k <= hand[r] && j + k <= count; k++) next[j + k] += ways[j];
    }
    ways = next;
  }
  return ways[count];
}


/**
 * Discard choices for a hand: every combination when there are at most `limit`, otherwise a
 * deterministic sample of `limit` distinct combinations (drawn from `seed`: a mulberry32 seed, or
 * the stream itself).
 */
export function discardOptions(hand: CardCounts, count: number, seed: number | Rng, limit = DISCARD_ENUMERATION_LIMIT, kinds: readonly Card[] = RESOURCES): CardCounts[] {
  if (count <= 0 || count > totalCards(hand)) return [];
  if (countDiscardCombinations(hand, count, kinds) <= limit) {
    const out: CardCounts[] = [];
    const cur = emptyCards();
    const rec = (i: number, left: number) => {
      if (i === kinds.length) {
        if (left === 0) out.push({ ...cur });
        return;
      }
      const r = kinds[i];
      // Remaining capacity of later kinds bounds how few we may take here.
      let later = 0;
      for (let j = i + 1; j < kinds.length; j++) later += hand[kinds[j]];
      for (let k = Math.max(0, left - later); k <= Math.min(hand[r], left); k++) {
        cur[r] = k;
        rec(i + 1, left - k);
      }
      cur[r] = 0;
    };
    rec(0, count);
    return out;
  }
  const rng = typeof seed === 'number' ? new Rng(seed) : seed;
  const cards: Card[] = [];
  for (const r of kinds) for (let i = 0; i < hand[r]; i++) cards.push(r);
  const seen = new Set<string>();
  const out: CardCounts[] = [];
  for (let attempt = 0; attempt < limit * 8 && out.length < limit; attempt++) {
    const pool = rng.shuffle([...cards]);
    const pick = emptyCards();
    for (let i = 0; i < count; i++) pick[pool[i]]++;
    const k = countsKey(pick);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(pick);
  }
  return out;
}

/** Every legal Invention choice given the current supply. */
export function inventionOptions(bank: CardCounts): Resource[][] {
  const want = Math.min(2, RESOURCES.reduce((n, r) => n + bank[r], 0));
  if (want === 0) return [[]];
  if (want === 1) return RESOURCES.filter((r) => bank[r] > 0).map((r) => [r]);
  const out: Resource[][] = [];
  for (let i = 0; i < RESOURCES.length; i++) {
    for (let j = i; j < RESOURCES.length; j++) {
      const a = RESOURCES[i];
      const b = RESOURCES[j];
      if (a === b ? bank[a] >= 2 : bank[a] >= 1 && bank[b] >= 1) out.push([a, b]);
    }
  }
  return out;
}

function devCardActions(state: GameState, player: PlayerId): Action[] {
  const out: Action[] = [];
  const types = new Set<DevCardType>(playableDevCards(state, player).map((c) => c.type));
  if (types.has('knight')) out.push({ type: 'playKnight' });
  if (types.has('roadBuilding') && freeRouteOpen(state, player)) out.push({ type: 'playRoadBuilding' });
  if (types.has('invention')) for (const resources of inventionOptions(state.bank)) out.push({ type: 'playInvention', resources });
  if (types.has('monopoly')) for (const resource of RESOURCES) out.push({ type: 'playMonopoly', resource });
  return out;
}

function tradeResponseActions(state: GameState, player: PlayerId): Action[] {
  const t = state.trade;
  if (!t || t.proposer === player) return [];
  if (t.to.length > 0 && !t.to.includes(player)) return [];
  const out: Action[] = [{ type: 'respondTrade', accept: false }];
  // (An open offer is answered with a bid, a counter-offer, never accepted as it stands.)
  if (!isOpenOffer(t) && hasResources(state.players[player].hand, t.get)) out.unshift({ type: 'respondTrade', accept: true });
  return out;
}

function mainPhaseActions(state: GameState, player: PlayerId): Action[] {
  const out: Action[] = [];
  const me = state.players[player];

  if (canAfford(state, player, 'city')) for (const vertex of legalCities(state, player)) out.push({ type: 'buildCity', vertex });
  if (canAfford(state, player, 'settlement')) for (const vertex of legalSettlements(state, player)) out.push({ type: 'buildSettlement', vertex });
  if (canAfford(state, player, 'road')) for (const edge of legalRoads(state, player)) out.push({ type: 'buildRoad', edge });
  if (state.devDeck.length > 0 && canAfford(state, player, 'devCard')) out.push({ type: 'buyDevCard' });
  out.push(...devCardActions(state, player));

  const ratios = tradeRatios(state, player);
  const kinds = cardKinds(state);
  for (const give of kinds) {
    if (!Number.isFinite(ratios[give]) || me.hand[give] < ratios[give]) continue;
    for (const get of kinds) if (get !== give && get !== 'oil' && state.bank[get] >= 1) out.push({ type: 'bankTrade', give, get, times: 1 });
  }

  if (usesCoins(state)) {
    if (state.coinBuys < COIN_BUYS_PER_TURN && me.coins >= COINS_PER_RESOURCE) for (const get of RESOURCES) if (state.bank[get] >= 1) out.push({ type: 'buyWithCoins', get });
    for (const give of kinds) if (Number.isFinite(ratios[give]) && me.hand[give] >= ratios[give]) out.push({ type: 'sellForCoins', give, times: 1 });
  }

  const t = state.trade;
  if (t) {
    if (t.proposer === player) {
      const ready = tradeReadiness(state);
      for (const partner of ready.accepted) out.push({ type: 'acceptTrade', partner });
      for (const partner of ready.counters) out.push({ type: 'acceptTrade', partner, counter: true });
    }
    out.push({ type: 'cancelTrade' });
  }

  out.push({ type: 'endTurn' });
  return out;
}

/**
 * The current validity of commitments volunteered by trade partners. A view carries the host's
 * snapshot because its hidden hands cannot answer this; the host computes it afresh whenever a
 * view is made, so a theft, a payment or a changed oil hold cannot leave a stale commitment ready.
 * This is only for enumerating choices: acceptTrade always rechecks the authoritative hands.
 */
export function tradeReadiness(state: GameState): TradeReadiness {
  const t = state.trade;
  if (!t) return { accepted: [], counters: [] };
  if (t.readiness) return { accepted: t.readiness.accepted.slice(), counters: t.readiness.counters.slice() };
  const canPay = (partner: PlayerId, give: CardCounts, get: CardCounts) =>
    hasResources(state.players[t.proposer].hand, give) &&
    hasResources(state.players[partner].hand, get) &&
    tradeFits(state, t.proposer, partner, give, get);
  return {
    accepted: Object.entries(t.responses).flatMap(([pid, response]) => {
      const partner = Number(pid);
      return response === 'accepted' && canPay(partner, t.give, t.get) ? [partner] : [];
    }),
    counters: Object.entries(t.counters).flatMap(([pid, counter]) => {
      const partner = Number(pid);
      return partner !== t.proposer && canPay(partner, counter.get, counter.give) ? [partner] : [];
    }),
  };
}

/** Whether a trade would leave both hands within what the modules allow (Oil's limit). */
export function tradeFits(state: GameState, a: PlayerId, b: PlayerId, aGives: CardCounts, bGives: CardCounts): boolean {
  const mods = modulesOf(state);
  if (!mods.some((m) => m.hooks?.handAllowed)) return true;
  const ha = { ...state.players[a].hand };
  const hb = { ...state.players[b].hand };
  for (const k of cardKinds(state)) {
    ha[k] += bGives[k] - aGives[k];
    hb[k] += aGives[k] - bGives[k];
  }
  return mods.every((m) => (m.hooks?.handAllowed?.(state, a, ha) ?? true) && (m.hooks?.handAllowed?.(state, b, hb) ?? true));
}

/**
 * Every currently legal concrete action for `player`. Each entry is guaranteed to succeed with
 * applyAction on the same state. Domestic trade offers and counter-offers are not enumerated.
 * While a decision is owed, only the module that owns it offers actions.
 */
export function legalActions(state: GameState, player: PlayerId): Action[] {
  if (state.phase === 'gameOver' || !Number.isInteger(player) || player < 0 || player >= state.players.length) return [];
  return memo(state, Query.LegalActions, player, () => enumerate(state, player)).slice();
}

function enumerate(state: GameState, player: PlayerId): Action[] {
  const mods = modulesOf(state);
  const top = state.pending[state.pending.length - 1];
  if (top) {
    const owner = mods.find((m) => top.kind.startsWith(`${m.id}/`));
    return owner?.legal?.(state, player) ?? [];
  }
  const base = baseLegalActions(state, player);
  if (mods.length === 0) return base;
  return [...base, ...mods.flatMap((m) => m.legal?.(state, player) ?? [])];
}

function baseLegalActions(state: GameState, player: PlayerId): Action[] {
  const current = state.currentPlayer === player;
  switch (state.phase) {
    case 'setupSettlement':
      return current ? legalSetupSettlements(state).map((vertex) => ({ type: 'placeSetupSettlement', vertex })) : [];
    case 'setupRoad':
      return current ? legalSetupRoads(state).map((edge) => ({ type: 'placeSetupRoad', edge })) : [];
    case 'roll':
      return current ? [{ type: 'rollDice' }, ...devCardActions(state, player)] : [];
    case 'discard': {
      const need = state.pendingDiscards[player];
      if (need === undefined) return [];
      // A seat's choices must not depend on the hidden dice stream. Earlier games retain their
      // recorded sampler; new games use only the public action counter and the seat number.
      const seed = seedFrom(state.seq * 7 + player * 104729 + (state.options.rules < 3 ? state.rngState : 0));
      return discardOptions(state.players[player].hand, need, publicRng(state, seed), DISCARD_ENUMERATION_LIMIT, cardKinds(state)).map((resources) => ({ type: 'discard', resources }));
    }
    case 'moveRobber':
      return current ? legalRobberHexes(state).map((hex) => ({ type: 'moveRobber', hex })) : [];
    case 'steal':
      return current
        ? state.stealCandidates.flatMap((victim): Action[] => [
            ...theftChoices(state, player, victim).map((t) => ({ type: 'steal' as const, ...t })),
          ])
        : [];
    case 'roadBuilding': {
      if (!current) return [];
      const out: Action[] = legalRoads(state, player).map((edge) => ({ type: 'placeFreeRoad', edge }));
      // Free roads may only be given up when none can be placed (nor a ship, with Sea Lanes).
      if (out.length === 0 && !freeRouteOpen(state, player)) out.push({ type: 'skipFreeRoads' });
      return out;
    }
    case 'main':
      return current ? mainPhaseActions(state, player) : tradeResponseActions(state, player);
    case 'endOfTurn':
    case 'gameOver':
      return [];
  }
}
