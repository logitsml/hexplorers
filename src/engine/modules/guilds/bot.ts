// The guilds' bot: improvements first (they're paid in commodities, which nothing else wants),
// ventures by simple per-card judgements, surplus commodities traded for what the base planner is
// short of, and answers to every decision the guilds leave owed. Every action it returns is taken
// from the module's own legal lists, so it can't drift from the rules.

import { TERRAIN_RESOURCE } from '../../constants';
import { hexPips, numbersOf, totalVictoryPoints } from '../../rules';
import type { Action, Card, CardCounts, GameState, Pending, PlayerId, Resource, Track } from '../../types';
import { RESOURCES } from '../../types';
import type { BotCtx } from '../../ai/context';
import { robberHexScore } from '../../ai/robber';
import type { ModuleBot } from '../api';
import { cutOff, isConquered, raidersOn } from '../shared';
import { FLEET_STEPS } from '../fleet';
import { rallyWorth } from '../garrisons/bot';
import { legalGuilds, ventureActions } from './actions';
import { improveOptions, seatChange } from './improve';
import { ABILITY_LEVEL, MAX_LEVEL, SEAT_LEVEL, TRACKS, TRACK_COMMODITY, guildsOf } from './rules';
import type { GuildsAction, GuildsPending, VentureId } from './types';
import { resurveyed, unrestFloor, unrestLoss, ventureCards } from './ventures';

type Play = Extract<GuildsAction, { type: 'guilds/play' }>;

/** Steps the raider fleet still has to sail (Infinity without it). */
function fleetDistance(s: GameState): number {
  const f = s.ext.fleet;
  return f ? FLEET_STEPS - f.position : Infinity;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Rough worth of holding each venture, for choosing what to keep, discard or take. */
const KEEP_VALUE: Record<VentureId, number> = {
  augury: 1.2,
  hoist: 1,
  masonry: 0.8,
  resurvey: 0.5,
  waterworks: 1.1,
  townPlanning: 1.6,
  deepSeams: 1.1,
  pathfinders: 1.1,
  forge: 0.7,
  encyclopaedia: 5,
  barter: 0.8,
  tribute: 1.4,
  trader: 2.5,
  charterFleet: 0.7,
  cornerMarket: 1.6,
  cartel: 0.9,
  rightOfWay: 0.4,
  rally: 0.7,
  spymaster: 1,
  agitators: 0.4,
  unrest: 1,
  taxCollectors: 1,
  treachery: 0.7,
  grandCharter: 5,
  dowry: 1.2,
  salvage: 1.2,
  pilot: 1.1,
  tradeWind: 0.8,
  customs: 1.1,
  stockpile: 1.3,
  lighthouse: 0.6,
};

/** How much a level on `track` is worth to the bot (in rough victory-point terms). */
function levelValue(ctx: BotCtx, track: Track, level: number): number {
  const s = ctx.s;
  // Each level widens the red-die range by one face: more ventures on that track's face.
  let v = 0.35;
  if (level === ABILITY_LEVEL) {
    if (track === 'learning') v += 0.5;
    if (track === 'commerce') v += 0.6;
    if (track === 'statecraft') v += s.options.modules.includes('garrisons') ? 0.4 : 0.1;
  }
  const change = seatChange(s, ctx.me, track, level);
  if (change === 'take') v += 2.5;
  else if (change === 'keep') v += 1;
  else if (level >= SEAT_LEVEL) v += 0.3; // still in the race for the seat
  return v;
}

/** The commodity cards worth keeping toward the next levels, and what the rest are worth. */
function commodityWorth(ctx: BotCtx, hand: CardCounts): number {
  const g = guildsOf(ctx.s);
  let v = 0;
  for (const t of TRACKS) {
    const c = TRACK_COMMODITY[t];
    const level = g.levels[ctx.me][t];
    const need = level < MAX_LEVEL ? level + 1 : 0;
    const spare = 1 / ((ctx.ratios as Record<Card, number>)[c] ?? 4);
    const n = hand[c];
    v += 0.28 * Math.min(n, need) + 0.5 * spare * Math.max(0, n - need);
  }
  return v;
}

/** A card the bot holds to its plans' least cost (for giving, discarding). */
function cheapest(ctx: BotCtx, kinds: readonly Card[]): Card | null {
  let best: Card | null = null;
  let bestScore = -Infinity;
  const hand = { ...ctx.hand };
  for (const k of kinds) {
    if (hand[k] <= 0) continue;
    hand[k]--;
    const score = ctx.scoreHand(hand);
    hand[k]++;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

/** The card that would help the bot most (for taking, picking). */
function dearest(ctx: BotCtx, kinds: readonly Card[]): Card | null {
  let best: Card | null = null;
  let bestScore = -Infinity;
  const hand = { ...ctx.hand };
  for (const k of kinds) {
    hand[k]++;
    const score = ctx.scoreHand(hand);
    hand[k]--;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

/** A hex that pays nothing however the dice fall: under the robber, or held by the raiders (Invasion). */
const idle = (s: GameState, hex: number) => hex === s.robberHex || isConquered(s, hex);

/** Cards the bot would get if the production dice showed `total` (a building the raiders have cut off gets none). */
function incomeOn(s: GameState, player: PlayerId, total: number): number {
  let n = 0;
  for (const h of s.board.hexes) {
    if (idle(s, h.id) || !numbersOf(s, h).includes(total)) continue;
    for (const v of h.vertices) {
      const b = s.buildings[v];
      if (b?.owner === player && !cutOff(s, v)) n += b.kind === 'city' ? 2 : 1;
    }
  }
  return n;
}

/** Pips `player` draws from the board with the guilds' numbers as they stand (or as `numbers` would put them). */
function pipsFor(s: GameState, player: PlayerId): number {
  let n = 0;
  s.buildings.forEach((b, v) => {
    if (!b || b.owner !== player || cutOff(s, v)) return;
    for (const h of s.board.vertices[v].hexes) {
      const hex = s.board.hexes[h];
      if (idle(s, h) || !TERRAIN_RESOURCE[hex.terrain]) continue;
      n += hexPips(s, hex) * (b.kind === 'city' ? 2 : 1);
    }
  });
  return n;
}

// ---------------------------------------------------------------------------
// Ventures
// ---------------------------------------------------------------------------

const plays = (ctx: BotCtx, card: VentureId): Play[] => ventureActions(ctx.s, ctx.me).filter((a): a is Play => a.type === 'guilds/play' && a.card === card);

const vp = (s: GameState, p: PlayerId) => totalVictoryPoints(s, p);

/** Whether (and how) to play `card` now. */
function judge(ctx: BotCtx, card: VentureId): Action | null {
  const s = ctx.s;
  const me = ctx.me;
  const options = plays(ctx, card);
  if (options.length === 0) return null;
  const best = <T>(xs: T[], score: (x: T) => number, min = -Infinity): T | null => {
    let out: T | null = null;
    let top = min;
    let i = 0;
    for (const x of xs) {
      // (A bot that plays loosely misjudges how much a card or a place is worth.)
      const sc = score(x) * ctx.fuzz(i++);
      if (sc > top) {
        top = sc;
        out = x;
      }
    }
    return out;
  };
  switch (card) {
    case 'trader': {
      if (guildsOf(s).trader?.owner === me) return null;
      // The hex whose resource the bot produces most of (the 2:1 is worth the most there).
      return best(options, (a) => {
        const r = TERRAIN_RESOURCE[s.board.hexes[a.hex!].terrain]!;
        return ctx.prod[me][r] + 0.1 * hexPips(s, s.board.hexes[a.hex!]);
      });
    }
    case 'townPlanning':
      return best(options, (a) => ctx.cityValue(a.vertex!));
    case 'waterworks':
    case 'deepSeams': {
      const r: Resource = card === 'waterworks' ? 'wheat' : 'ore';
      const terrain = card === 'waterworks' ? 'fields' : 'mountains';
      const hexes = s.board.hexes.filter((h) => h.terrain === terrain && h.vertices.some((v) => s.buildings[v]?.owner === me)).length;
      return hexes >= 1 && s.bank[r] >= 2 ? options[0] : null;
    }
    case 'cornerMarket':
      return best(options, (a) => ctx.opponents.reduce((n, o) => n + Math.min(2, ctx.estimate(o).expected[a.kind!]), 0) * (ctx.resVal[a.kind as Resource] ?? 1), 2.2);
    case 'cartel':
      return best(options, (a) => ctx.opponents.reduce((n, o) => n + Math.min(1, ctx.estimate(o).expected[a.kind!]), 0), 1.4);
    case 'tribute':
      return best(options, (a) => ventureCards(s, a.target!), 1.5);
    case 'spymaster':
      return best(options, (a) => guildsOf(s).hands[a.target!].length, 0.5);
    case 'dowry': {
      const givers = ctx.opponents.filter((o) => vp(s, o) > vp(s, me) && ventureCards(s, o) > 0);
      return givers.length > 0 ? options[0] : null;
    }
    case 'unrest': {
      const lost = ctx.opponents.filter((o) => vp(s, o) >= vp(s, me) && ventureCards(s, o) >= unrestFloor(s)).reduce((n, o) => n + unrestLoss(s, ventureCards(s, o)), 0);
      return lost >= 3 ? options[0] : null;
    }
    case 'barter':
      return RESOURCES.some((r) => ctx.hand[r] >= 2) ? options[0] : null;
    case 'charterFleet':
      return best(options, (a) => ctx.hand[a.kind!], 3.5);
    case 'pathfinders':
    case 'pilot': {
      const useful = ctx.options().some((o) => (o.kind === 'settlement' && (o.dist ?? 0) >= 1 && (o.dist ?? 0) <= 2) || (o.kind === 'longestRoad' && o.value >= 0.45));
      return useful ? options[0] : null;
    }
    case 'salvage':
    case 'stockpile':
      return options[0];
    case 'customs':
      return best(options, (a) => ctx.opponents.reduce((n, o) => n + (ctx.estimate(o).expected[a.kind!] >= 2 ? 1 : 0), 0) * (ctx.resVal[a.kind as Resource] ?? 0.8), 1.4);
    case 'tradeWind': {
      // Worth it when a trade toward the plan is a card short of its rate.
      const goal = ctx.rankedOptions()[0]?.option;
      if (!goal || !RESOURCES.some((r) => goal.cost[r] > ctx.hand[r] && s.bank[r] > 0)) return null;
      const ratios = ctx.ratios as Record<Card, number>;
      const near = ([...RESOURCES, ...TRACKS.map((t) => TRACK_COMMODITY[t])] as Card[]).some((k) => ratios[k] > 2 && ctx.hand[k] - (goal.cost[k as Resource] ?? 0) === ratios[k] - 1);
      return near ? options[0] : null;
    }
    case 'lighthouse': {
      // Cover the hex that pays the bot most, unless the robber already sits there or one of its lighthouses burns.
      if (guildsOf(s).lit?.some((l) => l.owner === me)) return null;
      const worth = (hex: number) => {
        const h = s.board.hexes[hex];
        if (hex === s.robberHex || !TERRAIN_RESOURCE[h.terrain]) return 0;
        return h.vertices.reduce((n, v) => n + (s.buildings[v]?.owner === me ? (s.buildings[v]!.kind === 'city' ? 2 : 1) : 0), 0) * hexPips(s, h);
      };
      return best(options, (a) => worth(a.hex!), 4);
    }
    case 'taxCollectors':
      return best(options, (a) => robberHexScore(ctx, a.hex!), 3);
    case 'masonry':
      return options[0];
    case 'forge': {
      const two = options.find((a) => a.wardens!.length === 2);
      if (two) return two;
      return fleetDistance(s) <= 3 ? options[0] : null;
    }
    case 'rally':
      // (Under Invasion: when the wardens it stands up would win battles this turn.)
      return fleetDistance(s) <= 1 || rallyWorth(ctx) >= 0.4 ? options[0] : null;
    case 'treachery':
      // Against the leader, while there's a fleet to defend against.
      return s.ext.fleet ? best(options, (a) => ctx.threat(a.target!)) : null;
    case 'agitators': {
      // Under Invasion: a prisoner from the hex whose raiders press hardest on the bot's own buildings.
      if (options.some((a) => a.hex !== undefined)) {
        const mine = (hex: number) => s.board.hexes[hex].vertices.filter((v) => s.buildings[v]?.owner === me).length;
        return best(options, (a) => raidersOn(s, a.hex!) * (1 + mine(a.hex!)), 1);
      }
      // Clear an opponent's warden off a spot the bot wants to settle.
      const wanted = new Set(ctx.options().filter((o) => o.kind === 'settlement' && o.vertex !== undefined).map((o) => o.vertex!));
      return options.find((a) => {
        const w = s.wardens.find((x) => x.id === a.warden);
        return !!w && w.vertex !== null && (wanted.has(w.vertex) || s.board.vertices[w.vertex].neighbors.some((n) => wanted.has(n)));
      }) ?? null;
    }
    case 'rightOfWay': {
      // Cut the Longest Route holder's open road when it is someone else's.
      const holder = s.longestRoadHolder;
      if (holder === null || holder === me) return null;
      return options.find((a) => s.routes[a.edge!]?.owner === holder) ?? null;
    }
    case 'resurvey': {
      const before = pipsFor(s, me);
      return best(
        options,
        (a) => {
          const [x, y] = a.hexes!;
          const g = guildsOf(s);
          // (As the venture itself swaps them, so a polluted number isn't counted lost twice.)
          const swapped: GameState = { ...s, ext: { ...s.ext, guilds: { ...g, numbers: { ...g.numbers, ...resurveyed(s, x, y) } } } };
          const gain = pipsFor(swapped, me) - before;
          const hurt = Math.max(0, ...ctx.opponents.map((o) => pipsFor(swapped, o) - pipsFor(s, o)));
          return gain - 0.5 * hurt;
        },
        2.5,
      );
    }
    default:
      return null;
  }
}

/** The best improvement the bot can make now, or null. */
function chooseImprovement(ctx: BotCtx): Action | null {
  const g = guildsOf(ctx.s);
  let best: Action | null = null;
  let top = -Infinity;
  for (const a of improveOptions(ctx.s, ctx.me)) {
    const level = g.levels[ctx.me][a.track] + 1;
    // A hoist is worth spending on the dearer levels.
    const hoistUse = a.hoist ? (level >= 3 ? 0.2 : -0.5) : 0;
    let seatSpot = 0;
    if (a.vertex !== undefined) seatSpot = -0.01 * ctx.cityValue(a.vertex);
    const score = (levelValue(ctx, a.track, level) - 0.04 * level + hoistUse + seatSpot) * ctx.fuzz(TRACKS.indexOf(a.track) + 100);
    if (score > top) {
      top = score;
      best = a;
    }
  }
  return best;
}

/**
 * Surplus commodities traded at the bank for what the base planner's top goal is short of (the
 * planner only trades resources). Keeps what the next level of each track needs.
 */
function tradeCommodities(ctx: BotCtx): Action | null {
  if (ctx.mem.bankTrades >= ctx.prof.bankTrades) return null;
  const goal = ctx.rankedOptions()[0]?.option;
  if (!goal) return null;
  const short = RESOURCES.filter((r) => goal.cost[r] > ctx.hand[r] && ctx.s.bank[r] > 0 && !ctx.mem.gaveToBank.includes(r));
  if (short.length === 0) return null;
  const g = guildsOf(ctx.s);
  const ratios = ctx.ratios as Record<Card, number>;
  for (const t of TRACKS) {
    const c = TRACK_COMMODITY[t];
    const level = g.levels[ctx.me][t];
    const keep = level < MAX_LEVEL ? level + 1 : 0;
    if (ctx.hand[c] - keep >= ratios[c] && !ctx.mem.gotFromBank.includes(c)) {
      const get = short.sort((a, b) => goal.cost[b] - ctx.hand[b] - (goal.cost[a] - ctx.hand[a]))[0];
      return { type: 'bankTrade', give: c, get, times: 1 };
    }
  }
  return null;
}

/** The augury: set the dice on the total that pays the bot best against its rivals. */
function augury(ctx: BotCtx): Action | null {
  const options = plays(ctx, 'augury');
  if (options.length === 0) return null;
  let best: Play | null = null;
  let top = 2.5;
  for (const a of options) {
    const t = a.dice![0] + a.dice![1];
    if (t === 7) continue;
    const mine = incomeOn(ctx.s, ctx.me, t);
    const theirs = Math.max(0, ...ctx.opponents.map((o) => incomeOn(ctx.s, o, t)));
    const score = mine - 0.4 * theirs;
    if (score > top) {
      top = score;
      best = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Decisions owed
// ---------------------------------------------------------------------------

/** What holding `card` is worth to the bot now (a trader card is little use while it holds the trader). */
function keepValue(ctx: BotCtx, card: VentureId): number {
  if (card === 'trader' && guildsOf(ctx.s).trader?.owner === ctx.me) return 0.3;
  return KEEP_VALUE[card];
}

/** The venture the bot minds losing least. */
function leastVenture(ctx: BotCtx, cards: readonly string[]): VentureId {
  return ([...cards] as VentureId[]).sort((a, b) => keepValue(ctx, a) - keepValue(ctx, b))[0];
}

/** The deck the bot would draw from. */
function preferredDeck(ctx: BotCtx): Track {
  const g = guildsOf(ctx.s);
  const open = TRACKS.filter((t) => g.decks[t].length > 0);
  // Commerce has the trader and the monopolies; Learning the cheap city and harvests.
  const order: Track[] = ['commerce', 'learning', 'statecraft'];
  return order.find((t) => open.includes(t)) ?? open[0];
}

function answer(ctx: BotCtx, p: Pending): Action | null {
  const s = ctx.s;
  const d = p.data as GuildsPending;
  const legal = legalGuilds(s, ctx.me);
  const pick = (match: (a: Action) => boolean) => legal.find(match) ?? legal[0] ?? null;
  switch (d.kind) {
    case 'guilds/ventureLimit': {
      const card = leastVenture(ctx, guildsOf(s).hands[ctx.me]);
      return pick((a) => a.type === 'guilds/discardVenture' && a.card === card);
    }
    case 'guilds/give':
    case 'guilds/discard': {
      const kinds = legal.map((a) => (a as { card: Card }).card);
      const card = cheapest(ctx, kinds);
      return pick((a) => (a as { card?: Card }).card === card);
    }
    case 'guilds/tribute': {
      const kinds = legal.map((a) => (a as { card: Card }).card);
      const card = dearest(ctx, kinds);
      return pick((a) => (a as { card?: Card }).card === card);
    }
    case 'guilds/spy': {
      const cards = legal.map((a) => (a as { card: VentureId | null }).card).filter((c): c is VentureId => c !== null);
      if (cards.length === 0) return pick(() => true);
      const card = [...cards].sort((a, b) => keepValue(ctx, b) - keepValue(ctx, a))[0];
      return pick((a) => a.type === 'guilds/takeVenture' && a.card === card);
    }
    case 'guilds/pick': {
      const kinds = legal.map((a) => (a as { resource: Resource | null }).resource).filter((r): r is Resource => r !== null);
      const r = dearest(ctx, kinds);
      return pick((a) => a.type === 'guilds/pick' && a.resource === r);
    }
    case 'guilds/drawChoice': {
      const t = preferredDeck(ctx);
      return pick((a) => a.type === 'guilds/draw' && a.track === t);
    }
    case 'guilds/barter': {
      const offers = legal.filter((a) => a.type === 'guilds/offer' && a.resource !== null).map((a) => (a as { resource: Resource }).resource);
      const r = cheapest(ctx, offers);
      return pick((a) => a.type === 'guilds/offer' && a.resource === r);
    }
    case 'guilds/rebuild': {
      const wanted = ctx.options().filter((o) => o.step.type === 'buildRoad').sort((a, b) => b.value - a.value);
      for (const o of wanted) {
        const edge = (o.step as { edge: number }).edge;
        const a = legal.find((x) => x.type === 'guilds/rebuild' && x.edge === edge);
        if (a) return a;
      }
      return pick((a) => a.type === 'guilds/rebuild' && a.edge === null);
    }
    case 'guilds/surrender': {
      const mine = s.wardens.filter((w) => w.owner === ctx.me && (w.vertex !== null || w.edge !== null));
      const w = [...mine].sort((a, b) => a.rank - b.rank || Number(a.mustered) - Number(b.mustered))[0];
      return pick((a) => a.type === 'guilds/surrender' && a.warden === w?.id);
    }
    case 'guilds/plant': {
      // The highest rank allowed, on a spot the bot doesn't want for a settlement.
      const wanted = new Set(ctx.options().filter((o) => o.kind === 'settlement' && o.vertex !== undefined).map((o) => o.vertex!));
      const places = legal.filter((a): a is Extract<Action, { type: 'guilds/plant' }> => a.type === 'guilds/plant' && a.rank > 0);
      places.sort((a, b) => b.rank - a.rank || Number(wanted.has(a.vertex ?? -1)) - Number(wanted.has(b.vertex ?? -1)));
      return places[0] ?? pick(() => true);
    }
  }
}

export const guildsBot: ModuleBot = {
  pending: (ctx, p) => answer(ctx, p),

  beforeRoll: (ctx) => augury(ctx),

  main(ctx) {
    const s = ctx.s;
    if (s.phase !== 'main') return null;
    // Commodities buy improvements and nothing else: spend them first.
    const imp = chooseImprovement(ctx);
    if (imp) return imp;
    for (const card of new Set(guildsOf(s).hands[ctx.me])) {
      if (card === 'hidden') continue;
      const a = judge(ctx, card);
      if (a) return a;
    }
    return tradeCommodities(ctx);
  },

  handValue: (ctx, hand) => commodityWorth(ctx, hand),
};

