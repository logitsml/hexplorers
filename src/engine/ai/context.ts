// Shared evaluation for the heuristic bot: resource values, production, reachability, candidate
// builds ("options") and a hand score used to judge trades, discards and the cards a card or
// venture lets a player pick.

import { COSTS, DEV_DECK, LARGEST_ARMY_MIN, LONGEST_ROAD_MIN, TERRAIN_RESOURCE, cards, emptyCards } from '../constants';
import { memo, Query } from '../memo';
import { modulesOf } from '../modules';
import type { Rng } from '../rng';
import { botRng } from '../keyedRng';
import {
  bridgeSites,
  hexPips,
  placeAllowed,
  pipsOf,
  legalCities,
  legalRoads,
  legalSettlements,
  longestRoadFor,
  publicVictoryPoints,
  satisfiesDistanceRule,
  totalCards,
  totalVictoryPoints,
  tradeRatios,
  vertexConnectsForRoad,
  victoryTarget,
} from '../rules';
import type { Action, GameState, PlayerId, PortType, Resource, CardCounts } from '../types';
import { RESOURCES } from '../types';
import { handEstimate, type HandEstimate } from '../tracker';
import { createBotMemory, type BotMemory } from './memory';
import { PROFILES, type BotDifficulty, type BotProfile } from './profiles';


export { hexPips, pipsOf };

const BASE_VALUE: CardCounts = cards({ brick: 1.0, wood: 1.0, wool: 0.8, wheat: 1.05, ore: 1.0 });
/** Added to the value of any option that wins the game outright. */
export const WIN_BONUS = 50;
const INF = 1 << 20;

type OptionKind = 'city' | 'settlement' | 'longestRoad' | 'devCard';

export interface BuildOption {
  kind: OptionKind;
  /** Rough worth in victory-point equivalents. */
  value: number;
  /** Full cost of reaching the goal (a settlement behind roads includes those roads). */
  cost: CardCounts;
  /** The next concrete action towards the goal and its cost. */
  step: Action;
  stepCost: CardCounts;
  vertex?: number;
  /** Roads still needed before the settlement (0 = can build now). */
  dist?: number;
}

export interface Reach {
  /** Roads needed to connect each intersection to the network (0 = already connected). */
  dist: number[];
  /** First edge to build on a shortest path towards the intersection (-1 if connected). */
  first: number[];
}

export const add = (a: CardCounts, b: CardCounts, k = 1): CardCounts => {
  const out = emptyCards();
  for (const r of RESOURCES) out[r] = a[r] + b[r] * k;
  return out;
};

export const sub = (a: CardCounts, b: CardCounts): CardCounts => add(a, b, -1);

export const missingFor = (hand: CardCounts, cost: CardCounts): CardCounts => {
  const out = emptyCards();
  for (const r of RESOURCES) out[r] = Math.max(0, cost[r] - hand[r]);
  return out;
};


function boardPips(s: GameState): CardCounts {
  const out = emptyCards();
  for (const h of s.board.hexes) {
    const r = TERRAIN_RESOURCE[h.terrain];
    if (r) out[r] += hexPips(s, h);
  }
  return out;
}

/** Board-wide value of each resource: a base value adjusted for scarcity on this board. */
function resourceValues(s: GameState): CardCounts {
  const bp = boardPips(s);
  const avg = RESOURCES.reduce((n, r) => n + bp[r], 0) / RESOURCES.length;
  const out = emptyCards();
  for (const r of RESOURCES) {
    const scarcity = Math.min(1.4, Math.max(0.8, Math.sqrt(avg / Math.max(1, bp[r]))));
    out[r] = BASE_VALUE[r] * scarcity;
  }
  return out;
}

/** Production in pips per resource for every player (cities count double; a robbed hex counts 40%). */
function productionPips(s: GameState): CardCounts[] {
  const out = s.players.map(() => emptyCards());
  s.buildings.forEach((b, v) => {
    if (!b) return;
    const mult = b.kind === 'city' ? 2 : 1;
    for (const h of s.board.vertices[v].hexes) {
      const hex = s.board.hexes[h];
      const r = TERRAIN_RESOURCE[hex.terrain];
      if (!r) continue;
      out[b.owner][r] += hexPips(s, hex) * mult * (h === s.robberHex ? 0.4 : 1);
    }
  });
  return out;
}

/** An edge a road of `player`'s could ever stand on (land, not a bridge site, and allowed by the modules: not a conquered hex's). */
const roadSite = (s: GameState, player: PlayerId, e: number): boolean => s.board.edges[e].land && !bridgeSites(s).has(e) && placeAllowed(s, player, 'road', e);

/**
 * Multi-source BFS over empty edges a road may take, from everything `player` can build a road
 * out of. Edges no road may ever take (open sea, a river's bridge sites, a conquered hex's) are not
 * walked: a plan never asks for a road there.
 */
export function computeReach(s: GameState, player: PlayerId): Reach {
  const n = s.board.vertices.length;
  const dist = new Array<number>(n).fill(INF);
  const first = new Array<number>(n).fill(-1);
  const queue: number[] = [];
  for (let v = 0; v < n; v++) {
    if (vertexConnectsForRoad(s, player, v)) {
      dist[v] = 0;
      queue.push(v);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi];
    // A route cannot continue through an opponent's building.
    if (dist[v] > 0 && s.buildings[v]) continue;
    for (const e of s.board.vertices[v].edges) {
      if (s.routes[e] !== null || !roadSite(s, player, e)) continue;
      const ed = s.board.edges[e];
      const u = ed.a === v ? ed.b : ed.a;
      if (dist[u] <= dist[v] + 1) continue;
      dist[u] = dist[v] + 1;
      first[u] = dist[v] === 0 ? e : first[v];
      queue.push(u);
    }
  }
  return { dist, first };
}

/** What the modules in play see in a settlement at `v` beyond its resources (fish, oil), in pips of an average resource (see ModuleBot.spotValue). */
export function moduleSpotValue(ctx: BotCtx, v: number): number {
  let x = 0;
  if (ctx.s.options.modules.length > 0) for (const m of modulesOf(ctx.s)) if (m.bot?.spotValue) x += m.bot.spotValue(ctx, v);
  return x;
}

/** What the modules in play add to a settlement spot's worth for `ctx`'s player once, on settling it (see ModuleBot.spotBonus), in VP equivalents. */
export function moduleSpotBonus(ctx: BotCtx, v: number): number {
  let bonus = 0;
  if (ctx.s.options.modules.length > 0) for (const m of modulesOf(ctx.s)) if (m.bot?.spotBonus) bonus += m.bot.spotBonus(ctx, v);
  return bonus;
}

/**
 * The victory-point cards `o` likely holds, as `me` can reckon them: each of their unplayed
 * development cards is one with the chance that an unseen card is a point. (Only how many they hold
 * is public, never which.)
 */
export function hiddenPointsOf(s: GameState, me: PlayerId, o: PlayerId): number {
  const held = s.players[o].devCards.length;
  if (held === 0) return 0;
  const mine = s.players[me].devCards.filter((c) => c.type === 'victoryPoint').length;
  let unseen = s.devDeck.length;
  for (const p of s.players) if (p.id !== me) unseen += p.devCards.length;
  if (unseen <= 0) return 0;
  return held * Math.min(1, Math.max(0, DEV_DECK.victoryPoint - mine) / unseen);
}

export function roadLengthWith(s: GameState, player: PlayerId, edge: number): number {
  const routes = s.routes.slice();
  routes[edge] = { owner: player, kind: 'road', builtTurn: s.turn };
  return longestRoadFor({ ...s, routes }, player);
}

export class BotCtx {
  readonly s: GameState;
  readonly me: PlayerId;
  readonly prof: BotProfile;
  readonly mem: BotMemory;
  readonly rng: Rng;
  readonly target: number;
  readonly hand: CardCounts;
  readonly ratios: Record<Resource, number>;
  readonly vp: number;
  readonly publicVp: number[];
  /** Each player's points as this bot reckons them: the public ones, and for the others the hidden victory-point cards they likely hold. */
  readonly seenVp: number[];
  /** What production counts for at this stage of the game: more early, when it pays out for longer, less near the end. */
  readonly prodScale: number;
  readonly resVal: CardCounts;
  readonly prod: CardCounts[];
  /** True for a model of another player built from what this bot can see (no hidden cards). */
  readonly observed: boolean;
  private optionCache: BuildOption[] | null = null;
  private ownIncome: CardCounts | null = null;
  private noiseCache: number[] = [];
  private fuzzSalt: number | null = null;
  private estimates = new Map<PlayerId, HandEstimate>();
  private models = new Map<PlayerId, BotCtx>();

  /** `seen`: model player `me` as another seat would, from this estimate of their hand. */
  constructor(s: GameState, me: PlayerId, diff: BotDifficulty, mem: BotMemory, prof: BotProfile = PROFILES[diff], seen?: CardCounts) {
    this.s = s;
    this.me = me;
    this.prof = prof;
    this.mem = mem;
    this.observed = !!seen;
    this.rng = botRng(s, me);
    // (The game's target as the modules in play adjust it.)
    this.target = victoryTarget(s, me);
    this.hand = seen ?? s.players[me].hand;
    // (The tables below depend only on the state: a bot's models of the other seats share them.)
    this.ratios = memo(s, Query.TradeRatios, me, () => tradeRatios(s, me));
    this.vp = seen ? publicVictoryPoints(s, me) : totalVictoryPoints(s, me);
    this.publicVp = memo(s, Query.PublicPoints, 0, () => s.players.map((p) => publicVictoryPoints(s, p.id)));
    const progress = Math.min(1, Math.max(...this.publicVp) / this.target);
    this.prodScale = 1 + prof.prodTaper * (0.5 - progress);
    this.seenVp = prof.readHidden ? this.publicVp.map((v, o) => (o === me ? v : v + hiddenPointsOf(s, me, o))) : this.publicVp;
    this.resVal = memo(s, Query.ResourceValues, 0, () => resourceValues(s));
    this.prod = memo(s, Query.ProductionPips, 0, () => productionPips(s));
  }

  get player() {
    return this.s.players[this.me];
  }

  /** What this bot can know about `o`'s hand (the card tracker; never the hand itself). */
  estimate(o: PlayerId): HandEstimate {
    let e = this.estimates.get(o);
    if (!e) {
      e = handEstimate(this.s, this.me, o);
      this.estimates.set(o, e);
    }
    return e;
  }

  /** Chance that `o` holds `need`, judged from the tracker. */
  holdChance(o: PlayerId, need: CardCounts): number {
    const e = this.estimate(o);
    let unknown = e.total;
    for (const r of RESOURCES) unknown -= e.sure[r];
    let p = 1;
    for (const r of RESOURCES) {
      if (need[r] <= e.sure[r]) continue;
      // Beyond the certain cards, only unknown ones could make up the rest.
      if (need[r] > e.sure[r] + unknown + 1e-9) return 0;
      p *= Math.min(1, e.expected[r] / need[r]);
    }
    return p;
  }

  /** `o` as this bot sees them: their plans scored on the estimate of their hand. */
  model(o: PlayerId): BotCtx {
    let m = this.models.get(o);
    if (!m) {
      // (Blocking doesn't change what a hand is worth to them, and is the costly part.)
      m = new BotCtx(this.s, o, 'normal', createBotMemory(), { ...this.prof, blockWeight: 0 }, this.estimate(o).expected);
      this.models.set(o, m);
    }
    return m;
  }

  /** How much `o` would gain (in their own hand score) by giving `oGives` for `oGets`. */
  gainFor(o: PlayerId, oGives: CardCounts, oGets: CardCounts): number {
    const m = this.model(o);
    const h = m.hand;
    const after = add(sub(h, oGives), oGets);
    for (const r of RESOURCES) if (after[r] < 0) after[r] = 0;
    return m.scoreHand(after) - m.scoreHand(h);
  }

  /** What helping `o` costs this bot per unit of their gain (more for a leader). */
  partnerCost(o: PlayerId): number {
    return this.prof.partnerWeight * Math.min(2, this.threat(o) / 1.6);
  }

  get opponents(): PlayerId[] {
    return this.s.players.filter((p) => p.id !== this.me).map((p) => p.id);
  }

  reach(player: PlayerId): Reach {
    return memo(this.s, Query.Reach, player, () => computeReach(this.s, player));
  }

  /** Expected cards per full round of turns, per resource. */
  income(player: PlayerId = this.me): CardCounts {
    // (rounds() asks for the bot's own for every option and hand it weighs.)
    if (player === this.me) return (this.ownIncome ??= this.incomeOf(player));
    return this.incomeOf(player);
  }

  private incomeOf(player: PlayerId): CardCounts {
    const out = emptyCards();
    const n = this.s.players.length;
    for (const r of RESOURCES) out[r] = (this.prod[player][r] * n) / 36;
    return out;
  }

  /** Estimated rounds until `cost` is affordable from `hand`, counting maritime trades of surplus. */
  rounds(cost: CardCounts, hand: CardCounts = this.hand): number {
    const inc = this.income();
    const totalInc = RESOURCES.reduce((n, r) => n + inc[r], 0);
    const miss = emptyCards();
    let missing = 0;
    let trades = 0;
    for (const r of RESOURCES) {
      const m = cost[r] - hand[r];
      if (m > 0) {
        miss[r] = m;
        missing += m;
      } else trades += Math.floor(-m / this.ratios[r]);
    }
    if (missing === 0) return 0;
    const rate = (r: Resource) => inc[r] + (0.5 * (totalInc - inc[r])) / 4 + 0.03;
    let used = 0;
    while (trades > 0 && missing > 0) {
      let worst: Resource = 'brick';
      let worstT = -1;
      for (const r of RESOURCES) {
        if (miss[r] <= 0) continue;
        const t = miss[r] / rate(r);
        if (t > worstT) {
          worstT = t;
          worst = r;
        }
      }
      miss[worst]--;
      missing--;
      trades--;
      used++;
    }
    let t = 0;
    for (const r of RESOURCES) if (miss[r] > 0) t = Math.max(t, miss[r] / rate(r));
    return t + 0.2 * used;
  }

  /** Port worth for this player, given the pips a new building there would add. */
  portValue(port: PortType | null, addedPips: CardCounts): number {
    if (!port) return 0;
    const prod = this.prod[this.me];
    if (port === 'any') {
      if (RESOURCES.every((r) => this.ratios[r] <= 3)) return 0;
      const total = RESOURCES.reduce((n, r) => n + prod[r] + addedPips[r], 0);
      return 0.15 + Math.min(0.3, total * 0.015);
    }
    if (this.ratios[port] <= 2) return 0;
    return Math.min(0.6, 0.06 * (prod[port] + addedPips[port]));
  }

  /** Value (in VP equivalents, excluding the settlement's own VP) of settling intersection `v`. */
  spotValue(v: number): number {
    const s = this.s;
    const prod = this.prod[this.me];
    const added = emptyCards();
    let val = 0;
    const fresh = new Set<Resource>();
    for (const h of s.board.vertices[v].hexes) {
      const hex = s.board.hexes[h];
      const r = TERRAIN_RESOURCE[hex.terrain];
      if (!r) continue;
      const p = hexPips(s, hex) * (h === s.robberHex ? 0.7 : 1);
      added[r] += p;
      const marginal = this.resVal[r] * (1.25 - 0.45 * Math.min(1, prod[r] / 10));
      val += p * marginal;
      if (prod[r] === 0 && p > 0) fresh.add(r);
    }
    val += moduleSpotValue(this, v);
    return 0.1 * this.prodScale * val + 0.12 * fresh.size + this.portValue(s.board.vertices[v].port, added) + moduleSpotBonus(this, v);
  }

  cityValue(v: number): number {
    const s = this.s;
    let val = 0;
    for (const h of s.board.vertices[v].hexes) {
      const hex = s.board.hexes[h];
      const r = TERRAIN_RESOURCE[hex.terrain];
      if (!r) continue;
      val += hexPips(s, hex) * this.resVal[r] * (h === s.robberHex ? 0.6 : 1);
    }
    val += moduleSpotValue(this, v);
    return 1 + 0.1 * this.prodScale * val;
  }

  /** Discount for a target an opponent can reach sooner (or as soon) as we can. */
  contest(v: number, d: number): number {
    let f = 1;
    for (const o of this.opponents) {
      if (this.s.players[o].settlementsLeft <= 0) continue;
      const od = this.reach(o).dist[v];
      if (od < d) f = Math.min(f, this.prof.contestBehind);
      else if (od === d) f = Math.min(f, this.prof.contestTie);
    }
    return f;
  }

  /** Worth of taking `v` before an opponent who is heading there (in VP equivalents). */
  denial(v: number): number {
    if (this.prof.blockWeight <= 0) return 0;
    let worth = 0;
    for (const h of this.s.board.vertices[v].hexes) {
      const hex = this.s.board.hexes[h];
      const r = TERRAIN_RESOURCE[hex.terrain];
      if (r) worth += hexPips(this.s, hex) * this.resVal[r];
    }
    let best = 0;
    for (const o of this.opponents) {
      if (this.s.players[o].settlementsLeft <= 0) continue;
      const d = this.reach(o).dist[v];
      if (d > 2) continue;
      best = Math.max(best, Math.min(2, this.threat(o) / 1.6) * Math.pow(0.6, d));
    }
    return this.prof.blockWeight * 0.06 * worth * best;
  }

  /** Worth of a settlement at `v` cutting an opponent's long route (chiefly the Longest Route holder's). */
  routeBreak(v: number): number {
    if (this.prof.blockWeight <= 0) return 0;
    const s = this.s;
    let val = 0;
    for (const o of this.opponents) {
      const len = s.players[o].longestRoad;
      if (len < 4 || !s.board.vertices[v].edges.some((e) => s.routes[e]?.owner === o)) continue;
      const buildings = s.buildings.slice();
      buildings[v] = { owner: this.me, kind: 'settlement' };
      const after = longestRoadFor({ ...s, buildings }, o);
      if (after >= len) continue;
      const holder = s.longestRoadHolder === o;
      val += Math.min(3, len - after) / 3 * (holder ? 1.5 : 0.4) * Math.min(2, this.threat(o) / 1.6);
    }
    return this.prof.blockWeight * val;
  }

  /** Longest Route consequences of building one road on `edge` (0 if irrelevant). */
  longestRoadGain(edge: number, myLen: number, others: number): number {
    const s = this.s;
    const newLen = roadLengthWith(s, this.me, edge);
    if (newLen <= myLen) return 0;
    if (s.longestRoadHolder === this.me) return others >= myLen - 1 ? 0.45 : 0;
    const need = Math.max(LONGEST_ROAD_MIN, others + 1);
    if (newLen >= need) return 2 + (this.vp + 2 >= this.target ? WIN_BONUS : 0);
    const gap = need - newLen;
    if (gap === 1) return this.prof.longestRoadGap1;
    if (gap === 2) return this.prof.longestRoadGap2;
    return 0;
  }

  /** Every candidate goal for this player right now. */
  options(): BuildOption[] {
    if (this.optionCache) return this.optionCache;
    const s = this.s;
    const me = this.me;
    const p = this.player;
    const out: BuildOption[] = [];
    const winByOne = this.vp + 1 >= this.target ? WIN_BONUS : 0;

    // (legalCities knows when no city piece is free, and that a laid-down city needs none.)
    for (const v of legalCities(s, me)) {
      out.push({ kind: 'city', value: this.prof.cityWeight * this.cityValue(v) + winByOne, cost: COSTS.city, stepCost: COSTS.city, step: { type: 'buildCity', vertex: v }, vertex: v, dist: 0 });
    }

    if (p.settlementsLeft > 0) {
      for (const v of legalSettlements(s, me)) {
        out.push({
          kind: 'settlement',
          value: this.prof.settlementWeight * (1 + this.spotValue(v)) + this.denial(v) + this.routeBreak(v) + winByOne,
          cost: COSTS.settlement,
          stepCost: COSTS.settlement,
          step: { type: 'buildSettlement', vertex: v },
          vertex: v,
          dist: 0,
        });
      }
      if (p.roadsLeft > 0) {
        const reach = this.reach(me);
        const maxD = Math.min(p.roadsLeft, this.prof.maxRoadDistance);
        const targets: BuildOption[] = [];
        // (A module can forbid a first road the search would take: a quake's crack, a reserved edge.)
        const roadOk = s.options.modules.length > 0 ? new Set(legalRoads(s, me)) : null;
        for (let w = 0; w < s.board.vertices.length; w++) {
          const d = reach.dist[w];
          if (d < 1 || d > maxD || !satisfiesDistanceRule(s, w) || !placeAllowed(s, me, 'settlement', w)) continue;
          if (roadOk && !roadOk.has(reach.first[w])) continue;
          const value = (this.prof.settlementWeight * (1 + this.spotValue(w)) + this.denial(w)) * Math.pow(this.prof.roadDecay, d) * this.contest(w, d);
          targets.push({
            kind: 'settlement',
            value,
            cost: add(COSTS.settlement, COSTS.road, d),
            stepCost: COSTS.road,
            step: { type: 'buildRoad', edge: reach.first[w] },
            vertex: w,
            dist: d,
          });
        }
        targets.sort((a, b) => b.value - a.value);
        out.push(...targets.slice(0, 3));
      }
    }

    if (p.roadsLeft > 0) {
      const myLen = p.longestRoad;
      const others = Math.max(0, ...this.opponents.map((o) => s.players[o].longestRoad));
      const need = Math.max(LONGEST_ROAD_MIN, others + 1);
      const worthChecking = s.longestRoadHolder === me ? others >= myLen - 1 : need - (myLen + 1) <= 2;
      if (worthChecking) {
        let best: BuildOption | null = null;
        for (const e of legalRoads(s, me)) {
          const value = this.longestRoadGain(e, myLen, others);
          if (value > 0 && (!best || value > best.value)) {
            best = { kind: 'longestRoad', value, cost: COSTS.road, stepCost: COSTS.road, step: { type: 'buildRoad', edge: e } };
          }
        }
        if (best) out.push(best);
      }
    }

    if (s.devDeck.length > 0) {
      let value = this.prof.devCardValue;
      if (!out.some((o) => o.kind === 'settlement')) value += 0.2;
      if (this.vp >= this.target - 3) value += 0.15;
      const myArmy = p.playedKnights + (this.observed ? 0 : p.devCards.filter((c) => c.type === 'knight').length);
      const maxOpp = Math.max(0, ...this.opponents.map((o) => s.players[o].playedKnights));
      if (s.largestArmyHolder !== me && myArmy + 1 >= Math.max(LARGEST_ARMY_MIN, maxOpp + 1)) value += 0.25;
      out.push({ kind: 'devCard', value, cost: COSTS.devCard, stepCost: COSTS.devCard, step: { type: 'buyDevCard' } });
    }

    this.optionCache = out;
    return out;
  }

  /**
   * Noise on a module judge's valuation of the thing named by `key` (a card, a place), as a
   * multiplier near 1: wide for easy bots, slight for normal, none for hard. The same key gets the
   * same factor throughout one decision, so a judge compares like with like.
   */
  fuzz(key: number): number {
    const spread = this.prof.moduleNoise;
    if (spread <= 0) return 1;
    // (A salt from the bot's own stream, once; each key is then mixed in with plain arithmetic.)
    this.fuzzSalt ??= Math.floor(botRng(this.s, this.me).next() * 4294967296);
    let h = Math.imul(this.fuzzSalt ^ Math.imul(key + 1, 0x9e3779b1), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
    h ^= h >>> 13;
    return 1 - spread / 2 + spread * ((h >>> 0) / 4294967296);
  }

  /** Per-option multiplicative noise (easy bots are erratic, normal slightly, hard not at all). */
  private noise(i: number): number {
    while (this.noiseCache.length <= i) {
      const spread = this.prof.noise;
      this.noiseCache.push(1 - spread / 2 + spread * this.rng.next());
    }
    return this.noiseCache[i];
  }

  /** Options ordered by urgency-discounted value for the given hand. */
  rankedOptions(hand: CardCounts = this.hand): { option: BuildOption; score: number }[] {
    return this.options()
      .map((option, i) => ({ option, score: (option.value * this.noise(i)) / (1 + this.prof.waitDiscount * this.rounds(option.cost, hand)) }))
      .sort((a, b) => b.score - a.score);
  }

  /** How good a hand is for this player's plans; differences drive trades, discards and the picks cards and ventures ask for. */
  scoreHand(hand: CardCounts): number {
    let best = 0;
    let second = 0;
    for (const option of this.options()) {
      const v = Math.min(option.value, 5) / (1 + this.prof.waitDiscount * this.rounds(option.cost, hand));
      if (v > best) {
        second = best;
        best = v;
      } else if (v > second) second = v;
    }
    let generic = 0;
    for (const r of RESOURCES) generic += this.resVal[r] * 0.25 * (1 - Math.pow(0.8, hand[r]));
    const total = totalCards(hand);
    const risk = total > 7 ? 0.05 * (total - 7) : 0;
    // (What the modules' own plans see in the hand: commodities toward improvements, oil.)
    let extra = 0;
    for (const m of modulesOf(this.s)) if (m.bot?.handValue) extra += m.bot.handValue(this, hand);
    return best + 0.3 * second + 0.2 * generic - risk + extra;
  }

  /** Strongest opponent by public points (ties: more cards). */
  leader(): PlayerId | null {
    let best: PlayerId | null = null;
    for (const o of this.opponents) {
      if (best === null) best = o;
      else {
        const a = this.seenVp[o];
        const b = this.seenVp[best];
        if (a > b || (a === b && totalCards(this.s.players[o].hand) > totalCards(this.s.players[best].hand))) best = o;
      }
    }
    return best;
  }

  /** How much harming `o` is worth relative to an average opponent. */
  threat(o: PlayerId): number {
    const vp = this.seenVp[o];
    let t = 0.6 + 0.25 * vp;
    if (vp >= this.target - 2) t += 1;
    if (o === this.leader()) t += 0.4;
    return t;
  }
}
