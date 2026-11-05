// A win this turn: a short search over the bot's own moves (builds, the maritime trades that pay for
// them, the free roads, Invention and a Knight for Biggest Army) for a line that reaches its target
// before the turn ends. The plain planner sees one build at a time, so it misses wins that take two
// (a road, then the one that takes Longest Route; a trade, a road and a settlement). Only moves whose
// outcome the bot can know are tried: nothing that draws a card, steals or takes from other hands.

import { inventionOptions } from '../actions';
import { COSTS, LONGEST_ROAD_MIN } from '../constants';
import { modulesOf } from '../modules';
import { applyAction, endOfTurnVictory } from '../reducer';
import { legalCities, legalRoads, legalSettlements, longestRoadFor, playableDevCards, satisfiesDistanceRule, totalVictoryPoints, tradeRatios, victoryTarget } from '../rules';
import type { Action, CardCounts, GameState, PlayerId, Resource } from '../types';
import { RESOURCES } from '../types';
import { BotCtx } from './context';
import { chooseRobberHex } from './robber';

/** The moves the search makes (a move outside these may change the hand: see the bot's memory). */
export const SEARCHED = new Set<Action['type']>(['buildCity', 'buildSettlement', 'buildRoad', 'bankTrade', 'playKnight', 'moveRobber', 'playRoadBuilding', 'placeFreeRoad', 'skipFreeRoads', 'playInvention']);
/**
 * Lines the search may try before giving up (each a few applyActions): the profile's budget, half
 * of it with modules in play, where each move costs more to try.
 */
const budgetFor = (ctx: BotCtx): number => (ctx.s.options.modules.length > 0 ? Math.ceil(ctx.prof.searchBudget / 2) : ctx.prof.searchBudget);
const MAX_DEPTH = 5;
/** The modules' own moves worth trying in a line: those with a known outcome that can move points (no card drawn, nothing taken from a hand). */
const MODULE_MOVES = new Set<string>(['sea/buildShip', 'sea/moveShip', 'sea/placeFreeShip', 'rivers/buildBridge', 'guilds/improve', 'oil/foundry', 'oil/sequester', 'oil/burn', 'buyWithCoins', 'sellForCoins']);
/** Module moves tried in all from one state. */
const MODULE_LINES = 14;

const won = (s: GameState, me: PlayerId) => s.winner === me || (s.phase !== 'gameOver' && endOfTurnVictory(s) && totalVictoryPoints(s, me) >= victoryTarget(s, me));

/** A road worth trying: it lengthens the bot's longest route, or opens (or nearly opens) a settlement spot. */
function roadWorthTrying(s: GameState, me: PlayerId, edge: number, len: number): boolean {
  // (The spots first: the route's length walks every road the bot has.)
  const ed = s.board.edges[edge];
  for (const v of [ed.a, ed.b]) {
    if (!s.buildings[v] && satisfiesDistanceRule(s, v)) return true;
    for (const u of s.board.vertices[v].neighbors) if (!s.buildings[u] && satisfiesDistanceRule(s, u)) return true;
  }
  const routes = s.routes.slice();
  routes[edge] = { owner: me, kind: 'road', builtTurn: s.turn };
  return longestRoadFor({ ...s, routes }, me) > len;
}

/**
 * The maritime trades that pay for `cost` (each one card at the bot's rate), giving what it has most
 * to spare beyond the cost; null when they can't. A plan, not a search: one way to pay is tried.
 */
function payWith(s: GameState, me: PlayerId, cost: CardCounts): Action[] | null {
  const hand = { ...s.players[me].hand };
  const bank = { ...s.bank };
  const ratios = tradeRatios(s, me);
  const out: Action[] = [];
  for (const r of RESOURCES) {
    while (hand[r] < cost[r]) {
      if (bank[r] < 1) return null;
      let give: Resource | null = null;
      for (const g of RESOURCES) {
        if (g === r || hand[g] - cost[g] < ratios[g]) continue;
        if (!give || ratios[g] < ratios[give] || (ratios[g] === ratios[give] && hand[g] - cost[g] > hand[give] - cost[give])) give = g;
      }
      if (!give) return null;
      hand[give] -= ratios[give];
      bank[give] += ratios[give];
      hand[r]++;
      bank[r]--;
      out.push({ type: 'bankTrade', give, get: r, times: 1 });
    }
  }
  return out;
}

/** The lines worth trying from `s`, each a few actions (the trades, then what they pay for), likeliest wins first. */
function linesFrom(ctx: BotCtx, s: GameState): Action[][] {
  const me = ctx.me;
  // (After a Knight the robber goes where the bot would put it anyway: one move, not every hex.)
  if (s.phase === 'moveRobber') return [[chooseRobberHex(new BotCtx(s, me, 'hard', ctx.mem, ctx.prof))]];
  const len = longestRoadFor(s, me);
  if (s.phase === 'roadBuilding') {
    const roads = legalRoads(s, me).filter((e) => roadWorthTrying(s, me, e, len));
    return [...roads.map((edge): Action[] => [{ type: 'placeFreeRoad', edge }]), [{ type: 'skipFreeRoads' }]];
  }
  if (s.phase !== 'main') return [];
  const out: Action[][] = [];
  const build = (cost: CardCounts, a: Action) => {
    const pay = payWith(s, me, cost);
    if (pay) out.push([...pay, a]);
  };
  for (const vertex of legalCities(s, me)) build(COSTS.city, { type: 'buildCity', vertex });
  for (const vertex of legalSettlements(s, me)) build(COSTS.settlement, { type: 'buildSettlement', vertex });
  const cards = new Set(playableDevCards(s, me).map((c) => c.type));
  if (cards.has('knight')) out.push([{ type: 'playKnight' }]);
  if (cards.has('roadBuilding') && s.players[me].roadsLeft > 0) out.push([{ type: 'playRoadBuilding' }]);
  if (cards.has('invention')) for (const resources of inventionOptions(s.bank)) if (resources.length > 0) out.push([{ type: 'playInvention', resources }]);
  for (const edge of legalRoads(s, me)) if (roadWorthTrying(s, me, edge, len)) build(COSTS.road, { type: 'buildRoad', edge });
  if (ctx.prof.moduleSearch && s.options.modules.length > 0) {
    // (Last: they come after the plain lines, and only so many.)
    let tried = 0;
    for (const m of modulesOf(s)) {
      for (const a of m.legal?.(s, me) ?? []) {
        if (tried >= MODULE_LINES) break;
        if (MODULE_MOVES.has(a.type)) {
          out.push([a]);
          tried++;
        }
      }
    }
  }
  return out;
}

/** A transposition key: what the rest of the line can depend on. */
function keyOf(s: GameState, me: PlayerId): string {
  const p = s.players[me];
  let mine = '';
  s.routes.forEach((r, e) => r?.owner === me && (mine += e + ','));
  s.buildings.forEach((b, v) => b?.owner === me && (mine += (b.kind === 'city' ? 'c' : 's') + v + ','));
  return `${s.phase}|${Object.values(p.hand).join(',')}|${p.devCards.length}|${s.robberHex}|${s.freeRoadsLeft}|${mine}`;
}

/**
 * At most how many points the bot could add this turn, counting cards generously (every card spent
 * at cost, none lost to a trade): when that falls short of its target there's nothing to search.
 */
function pointsWithin(ctx: BotCtx): number {
  const s = ctx.s;
  const p = ctx.player;
  const playable = s.devCardPlayedThisTurn ? [] : p.devCards.filter((c) => c.boughtTurn < s.turn).map((c) => c.type);
  let cards = 0;
  for (const r of Object.keys(ctx.hand) as (keyof typeof ctx.hand)[]) cards += ctx.hand[r];
  // (One development card a turn: Invention brings two cards, Road Crew two roads.)
  const free = s.phase === 'roadBuilding' ? s.freeRoadsLeft : playable.includes('roadBuilding') ? 2 : 0;
  if (playable.includes('invention')) cards += 2;
  let pts = Math.floor(cards / 4);
  // Longest Route: two points, if the roads it lacks are within reach.
  if (s.longestRoadHolder !== ctx.me && p.roadsLeft > 0) {
    const others = Math.max(0, ...ctx.opponents.map((o) => s.players[o].longestRoad));
    const need = Math.max(LONGEST_ROAD_MIN, others + 1) - p.longestRoad;
    if (need <= Math.floor(cards / 2) + free) pts += 2;
  }
  if (playable.includes('knight') && s.largestArmyHolder !== ctx.me) pts += 2;
  // (The modules' own awards and points are too many to bound here: with modules, allow one more.)
  if (s.options.modules.length > 0) pts += 1;
  return pts;
}

/**
 * The first move of a line that wins this turn, or null. Gated on being close: a bot further than
 * `reach` points away can't get there in one turn.
 */
export function winningMove(ctx: BotCtx, reach = 4): Action | null {
  const s0 = ctx.s;
  const me = ctx.me;
  if (s0.currentPlayer !== me || ctx.observed || ctx.vp + reach < ctx.target || ctx.vp + pointsWithin(ctx) < ctx.target) return null;
  // (A search that found nothing holds for the states its own moves lead to, which it has looked
  // through already: it's asked again only once something else has changed the hand, a trade or a
  // card bought.)
  if (ctx.mem.noWinTurn === s0.turn) return null;
  const seen = new Set<string>();
  let budget = budgetFor(ctx);
  let first: Action | null = null;
  const search = (s: GameState, depth: number): boolean => {
    if (depth === 0) return false;
    for (const line of linesFrom(ctx, s)) {
      if (budget-- <= 0) return false;
      let next: GameState | null = s;
      for (const a of line) {
        const r = applyAction(next, me, a);
        if (!r.ok) {
          next = null;
          break;
        }
        next = r.state;
      }
      if (!next) continue;
      if (won(next, me)) return ((first = line[0]), true);
      // (A Knight's theft is where the search stops: what it takes can't be known.)
      if (next.phase === 'steal') continue;
      const k = keyOf(next, me);
      if (seen.has(k)) continue;
      seen.add(k);
      if (search(next, depth - 1)) return ((first = line[0]), true);
    }
    return false;
  };
  if (!search(s0, MAX_DEPTH)) {
    ctx.mem.noWinTurn = s0.turn;
    return null;
  }
  return first;
}
