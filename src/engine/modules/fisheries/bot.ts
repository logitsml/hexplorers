// The bot's fishing: settle by good fishing grounds, spend fish where they finish something, keep
// the purse under the limit, and pass the boot on when that gains something.

import type { BotCtx } from '../../ai/context';
import { nameOil } from '../../ai/robber';
import { hexPips, hasResources } from '../../rules';
import type { Action, Pending, PlayerId, Resource } from '../../types';
import { RESOURCES } from '../../types';
import type { ModuleBot } from '../api';
import { corsairHex } from '../shared';
import { legalFisheries } from './actions';
import { cheapestPay, fishOf, fisheriesOf, isFishHex } from './fish';
import { fishCosts, FISH_LIMIT, type FishBuy, type FisheriesAction, type Token } from './types';

/**
 * What a fish token is worth, in pips of an average resource. A token shows about 1.8 fish, and
 * fish buy at between four (a resource) and two and a half (a road, a card) to the card.
 */
const TOKEN_WORTH = 0.55;

type Spend = Extract<FisheriesAction, { pay: Token[] }>;

/** Fish production a settlement at `v` would add, discounted where a blocker sits or the purse is nearly full. */
function spotValue(ctx: BotCtx, v: number): number {
  const s = ctx.s;
  const corsair = corsairHex(s);
  let pips = 0;
  for (const h of s.board.vertices[v].hexes) {
    const hex = s.board.hexes[h];
    if (!isFishHex(hex)) continue;
    pips += hexPips(s, hex) * (h === s.robberHex || h === corsair ? 0.6 : 1);
  }
  if (pips === 0) return 0;
  // (How many tokens a player holds is public; only their values are secret.)
  const held = fisheriesOf(s).tokens[ctx.me].length;
  return pips * TOKEN_WORTH * (held >= FISH_LIMIT - 1 ? 0.5 : 1);
}

/** Pips of this bot's production (fish included) under the robber. */
function blockedPips(ctx: BotCtx): number {
  const s = ctx.s;
  if (s.robberHex === null) return 0;
  const hex = s.board.hexes[s.robberHex];
  let n = 0;
  for (const v of hex.vertices) {
    const b = s.buildings[v];
    if (b && b.owner === ctx.me) n += hexPips(s, hex) * (b.kind === 'city' ? 2 : 1);
  }
  return n;
}

/** Of these ways to buy the same thing, the one paid as `cheapestPay` would pay. */
function cheapest<T extends Spend>(acts: T[]): T | null {
  const pay = cheapestPay(acts.map((a) => a.pay));
  return acts.find((a) => a.pay === pay) ?? null;
}

/**
 * Where another module's deck stands in for the development cards (rule 3), the deck seven fish
 * should draw from. The guilds' decks are ranked as the guilds' own bot ranks them when it draws a
 * venture of its choice: Commerce (the trader, the monopolies), then Learning (the cheap city, the
 * harvests), then Statecraft. Any other deck (Invasion's muster deck) is the only one offered.
 */
const DECK_RANK: Readonly<Record<string, number>> = { commerce: 3, learning: 2, statecraft: 1 };

/** Of the free-card buys on offer, the cheapest payment for the best deck. */
function bestCard(acts: Extract<FisheriesAction, { type: 'fisheries/card' }>[]): Extract<FisheriesAction, { type: 'fisheries/card' }> | null {
  let deck: string | undefined;
  let rank = -Infinity;
  for (const a of acts) {
    const r = a.deck === undefined ? 0 : (DECK_RANK[a.deck] ?? 0);
    if (r > rank) {
      rank = r;
      deck = a.deck;
    }
  }
  return cheapest(acts.filter((a) => a.deck === deck));
}

function buying<K extends FishBuy>(acts: FisheriesAction[], buy: K): Extract<FisheriesAction, { type: `fisheries/${K}` }>[] {
  return acts.filter((a) => a.type === `fisheries/${buy}`) as Extract<FisheriesAction, { type: `fisheries/${K}` }>[];
}

/** The resource the bot most lacks for `cost`, or null if it lacks none. */
function mostLacking(ctx: BotCtx, cost: Record<Resource, number>, acts: Extract<FisheriesAction, { type: 'fisheries/take' }>[]): Resource | null {
  let best: Resource | null = null;
  let bestScore = 0;
  for (const r of RESOURCES) {
    const lack = cost[r] - ctx.hand[r];
    if (lack <= 0 || !acts.some((a) => a.resource === r)) continue;
    const score = lack * ctx.resVal[r];
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/**
 * A theft worth paying fish for before the purse is full: from the player whose hand, as far as
 * the tracker shows, is likeliest to hold what the bot's plans lack, and not a loser's: a stolen
 * card is a swing between two hands. Null when no hand is worth the fish.
 */
function worthyTheft(ctx: BotCtx, steals: Extract<FisheriesAction, { type: 'fisheries/steal' }>[]): Extract<FisheriesAction, { type: 'fisheries/steal' }> | null {
  const base = ctx.scoreHand(ctx.hand);
  let best: { victim: PlayerId; worth: number } | null = null;
  for (const victim of new Set(steals.map((a) => a.victim))) {
    const e = ctx.estimate(victim);
    if (e.total < 3) continue;
    // What a card from their hand would add to the bot's, on average.
    let gain = 0;
    for (const r of RESOURCES) gain += (e.expected[r] / e.total) * (ctx.scoreHand({ ...ctx.hand, [r]: ctx.hand[r] + 1 }) - base);
    const worth = gain + 0.05 * Math.min(2, ctx.threat(victim) / 1.6) + 0.01 * e.total;
    if (!best || worth > best.worth) best = { victim, worth };
  }
  if (!best || best.worth < 0.18 * ctx.fuzz(best.victim)) return null;
  const oil = nameOil(ctx, best.victim);
  return cheapest(steals.filter((a) => a.victim === best!.victim && !!a.oil === oil));
}

/** Spending that finishes or advances the bot's plan, or keeps its purse from overflowing. */
function spendFish(ctx: BotCtx, acts: FisheriesAction[], beforeRoll: boolean): Action | null {
  const tokens = fisheriesOf(ctx.s).tokens[ctx.me];
  if (fishOf(tokens) < fishCosts(ctx.s).steal) return null;
  const full = tokens.length >= FISH_LIMIT - 1;
  // Before rolling, spend only to make room for the catch.
  if (beforeRoll && !full) return null;
  const goal = ctx.rankedOptions()[0]?.option;
  const take = buying(acts, 'take');

  // A road the plan needs and the hand can't pay for.
  if (goal && goal.step.type === 'buildRoad' && !hasResources(ctx.hand, goal.stepCost)) {
    const a = cheapest(buying(acts, 'route'));
    if (a) return a;
  }
  // The one card the next step lacks.
  if (goal) {
    let lacking = 0;
    for (const r of RESOURCES) lacking += Math.max(0, goal.stepCost[r] - ctx.hand[r]);
    const r = lacking === 1 ? mostLacking(ctx, goal.stepCost, take) : null;
    if (r) {
      const a = cheapest(take.filter((x) => x.resource === r));
      if (a) return a;
    }
  }
  // Seven fish: a free card (from the best deck, where there's a choice).
  const card = bestCard(buying(acts, 'card'));
  if (card) return card;
  if (!full) {
    // A purse beginning to fill: three fish for a card from a hand that holds what the plan lacks.
    if (tokens.length >= FISH_LIMIT - 3) return worthyTheft(ctx, buying(acts, 'steal'));
    return null;
  }
  // Near the limit: turn fish into what the plan lacks, or into a card stolen from the strongest player.
  const r = goal ? mostLacking(ctx, goal.cost, take) : null;
  if (r) {
    const a = cheapest(take.filter((x) => x.resource === r));
    if (a) return a;
  }
  const steals = buying(acts, 'steal');
  if (steals.length > 0) {
    let victim = steals[0].victim;
    for (const a of steals) if (ctx.threat(a.victim) > ctx.threat(victim)) victim = a.victim;
    const oil = nameOil(ctx, victim);
    return cheapest(steals.filter((a) => a.victim === victim && !!a.oil === oil));
  }
  return null;
}

/**
 * Where to pass the boot, if anywhere. It only holds its holder back once they could win, so it
 * goes to a player strictly ahead whenever there is one; to a player level on points only near
 * the end, when the extra point the bot would need starts to matter, and never straight back to
 * whoever handed it over (two level leaders would otherwise pass it to and fro every turn).
 */
type PassBoot = Extract<FisheriesAction, { type: 'fisheries/passBoot' }>;

function bootPass(ctx: BotCtx, passes: PassBoot[], from: number): PassBoot | null {
  const mine = ctx.publicVp[ctx.me];
  const better = (a: PlayerId, b: PlayerId) => ctx.publicVp[a] > ctx.publicVp[b] || (ctx.publicVp[a] === ctx.publicVp[b] && ctx.threat(a) > ctx.threat(b));
  const ahead = passes.filter((a) => ctx.publicVp[a.to] > mine);
  // (The bot's own target counts the boot it holds; a point or two short of it is near the end.)
  const level = ctx.vp + 2 >= ctx.target ? passes.filter((a) => ctx.publicVp[a.to] === mine && a.to !== from) : [];
  const pool = ahead.length > 0 ? ahead : level;
  if (pool.length === 0) return null;
  let to = pool[0].to;
  for (const a of pool) if (better(a.to, to)) to = a.to;
  return { type: 'fisheries/passBoot', to };
}

/**
 * Who handed the bot the boot since its last turn, as far as it saw: whoever held it when it last
 * looked on its own turn (-1 if it drew the boot itself, or doesn't know). Noted once a turn.
 */
function bootGiver(ctx: BotCtx): number {
  const s = ctx.s;
  const notes = ctx.mem.notes;
  const holder = fisheriesOf(s).boot ?? -1;
  if (notes.bootTurn !== s.turn) {
    const seen = notes.bootSeen ?? -1;
    notes.bootFrom = holder === ctx.me && seen !== ctx.me ? seen : -1;
    notes.bootTurn = s.turn;
  }
  notes.bootSeen = holder;
  return notes.bootFrom;
}

function wish(ctx: BotCtx, beforeRoll: boolean): Action | null {
  const from = ctx.s.currentPlayer === ctx.me ? bootGiver(ctx) : -1;
  const acts = legalFisheries(ctx.s, ctx.me) as FisheriesAction[];
  if (acts.length === 0) return null;

  const passes = acts.filter((a): a is PassBoot => a.type === 'fisheries/passBoot');
  if (passes.length > 0) {
    const pass = bootPass(ctx, passes, from);
    if (pass) {
      ctx.mem.notes.bootSeen = pass.to;
      return pass;
    }
  }

  // Send away a blocker sitting on our own production.
  const blockers = buying(acts, 'blocker');
  if (blockedPips(ctx) >= 5) {
    const a = cheapest(blockers.filter((x) => x.blocker === 'robber'));
    if (a) return a;
  }
  const corsair = corsairHex(ctx.s);
  if (corsair !== null && isFishHex(ctx.s.board.hexes[corsair]) && ctx.s.board.hexes[corsair].vertices.some((v) => ctx.s.buildings[v]?.owner === ctx.me)) {
    const a = cheapest(blockers.filter((x) => x.blocker === 'corsair'));
    if (a) return a;
  }
  return spendFish(ctx, acts, beforeRoll);
}

export const fisheriesBot: ModuleBot = {
  pending(ctx: BotCtx, p: Pending): Action | null {
    if (p.kind !== 'fisheries/swap') return null;
    const f = fisheriesOf(ctx.s);
    // A fresh token shows about 1.8 fish: worth it for a 1, unless the boot may well come up.
    const bootRisk = f.boot === null && f.supply.length + f.discard.length < 10;
    return { type: 'fisheries/swap', give: f.tokens[ctx.me].includes(1) && !bootRisk ? 1 : null };
  },
  beforeRoll: (ctx) => wish(ctx, true),
  main: (ctx) => wish(ctx, false),
  spotValue,
};
