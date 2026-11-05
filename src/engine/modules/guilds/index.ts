// Guilds: commodities, three improvement tracks with their abilities and seats, the event die,
// three venture decks, and the trader. With the guilds the base development deck and Biggest Army
// are set aside (rule 3): anything that grants a development card grants a venture instead.

import { TERRAIN_COMMODITY, TERRAIN_RESOURCE, emptyCards } from '../../constants';
import { RESOURCES, COMMODITIES, type CardCounts, type Production, type Track } from '../../types';
import type { RuleModule } from '../api';
import { cutOff, isConquered } from '../shared';
import { handleGuilds, legalGuilds } from './actions';
import { guildsBot } from './bot';
import { buildDecks, checkVentureLimit, drawVenture } from './deck';
import {
  ABILITY_LEVEL,
  COMMODITY_SUPPLY,
  EVENT_FACES,
  MAX_LEVEL,
  PREFERRED_RATE,
  SEAT_POINTS,
  TRACKS,
  TRADER_POINTS,
  VENTURE_LIMIT,
  covers,
  guildsOf,
  owe,
  seatVertex,
} from './rules';
import type { GuildsAction, GuildsPending } from './types';
import { VENTURES, ventureCopies } from './ventures';

const levelsZero = (): Record<Track, number> => ({ learning: 0, commerce: 0, statecraft: 0 });

export const guilds: RuleModule = {
  id: 'guilds',
  rulesVersion: 3,

  init(s, rng) {
    // The ventures replace the development deck, and the commodities join the supply.
    s.devDeck = [];
    for (const c of COMMODITIES) s.bank[c] = COMMODITY_SUPPLY;
    s.ext.guilds = {
      eventDie: null,
      levels: s.players.map(levelsZero),
      seatsForGood: [],
      decks: buildDecks(s, rng),
      hands: s.players.map(() => []),
      shown: s.players.map(() => []),
      trader: null,
      charter: [],
      settled: null,
      augured: false,
      numbers: {},
      // (Games recorded under the earlier rules carry neither.)
      ...(s.options.moduleRules.guilds! >= 3 && { wind: false, lit: [] }),
    };
  },

  handle: (ctx, player, action) => handleGuilds(ctx, player, action as GuildsAction),
  legal: legalGuilds,

  hooks: {
    // The second set-up round places a city; its starting cards are resources only (the base hands them out).
    setupSecondKind: () => 'city',

    turnStarted(ctx) {
      const g = guildsOf(ctx.s);
      g.charter = [];
      g.eventDie = null;
      if (g.wind) g.wind = false;
      // A lighthouse burns until its owner's next turn begins.
      if (g.lit?.some((l) => l.owner === ctx.s.currentPlayer)) g.lit = g.lit.filter((l) => l.owner !== ctx.s.currentPlayer);
    },

    rollDice(ctx, settled) {
      const g = guildsOf(ctx.s);
      if (!g.settled) return settled;
      const dice = g.settled;
      g.settled = null;
      g.augured = true;
      return { dice, total: dice[0] + dice[1] };
    },

    afterRoll(ctx) {
      const s = ctx.s;
      const g = guildsOf(s);
      // (Rolled with the production dice.)
      const face = EVENT_FACES[ctx.dice.int(EVENT_FACES.length)];
      // The red die is one of the production dice, as rolled or as the augury set it. When the
      // number comes from a card (the event deck, the Almanac) it is rolled on its own.
      const separate = (s.options.eventDeck || s.options.modules.includes('almanac')) && !g.augured;
      const red = separate ? ctx.dice.die() : s.dice![0];
      g.augured = false;
      g.eventDie = { face, red };
      ctx.emit({ type: 'guilds/eventDie', player: s.currentPlayer, face, red, independentRed: separate });
      if (face === 'ship') return;
      const n = s.players.length;
      for (let i = 0; i < n; i++) {
        const p = (s.currentPlayer + i) % n;
        if (covers(g.levels[p][face], red)) drawVenture(ctx, p, face);
      }
    },

    numbersOf: (s, hex, nums) => s.ext.guilds!.numbers[hex.id] ?? nums,

    yields(s, hex, vertex, b, grants) {
      // A seat cut off by conquest produces nothing at all.
      if (b.seat && cutOff(s, vertex)) return [];
      const c = TERRAIN_COMMODITY[hex.terrain];
      if (!c || b.kind !== 'city') return grants;
      // A city on forest, pasture or mountains takes one resource and one commodity.
      const r = TERRAIN_RESOURCE[hex.terrain];
      const out: Production[] = [];
      for (const g of grants) {
        if (g.resource === r && g.amount >= 2) out.push({ ...g, amount: g.amount - 1 }, { ...g, resource: c, amount: 1 });
        else out.push(g);
      }
      return out;
    },

    productionFallback(ctx, _total, received) {
      // The Learning ability: whoever took no cards (oil and bounty picks count; fish and coins
      // don't) picks a resource.
      const s = ctx.s;
      if (!RESOURCES.some((r) => s.bank[r] > 0)) return;
      const g = guildsOf(s);
      const n = s.players.length;
      for (let i = n - 1; i >= 0; i--) {
        const p = (s.currentPlayer + i) % n;
        if (g.levels[p].learning >= ABILITY_LEVEL && !received.has(p)) owe(s, p, { kind: 'guilds/pick' });
      }
    },

    // Rule 3: anything that grants a development card (seven fish) grants the top card of a venture
    // deck of the taker's choice. It's drawn as any venture is: a victory venture is shown at once,
    // and a hand over the limit is put right at once off your turn, or by the end of your actions on it.
    freeCardDecks: (s) => TRACKS.filter((t) => guildsOf(s).decks[t].length > 0),
    dealFreeCard(ctx, player, deck) {
      drawVenture(ctx, player, deck as Track);
    },

    buildingWorth: (s, vertex, worth) => (s.buildings[vertex]?.seat ? worth + SEAT_POINTS : worth),

    victoryPoints(s, player) {
      const g = guildsOf(s);
      return g.shown[player].length + (g.trader?.owner === player ? TRADER_POINTS : 0);
    },

    tradeRatios(s, player, ratios) {
      const g = guildsOf(s);
      const out = { ...ratios };
      const better = (k: keyof CardCounts) => (out[k] = Math.min(out[k], PREFERRED_RATE));
      if (g.levels[player].commerce >= ABILITY_LEVEL) for (const c of COMMODITIES) better(c);
      if (player === s.currentPlayer) for (const k of g.charter) better(k);
      // The trade wind: one card fewer on every trade, down to the preferred rate.
      if (player === s.currentPlayer && g.wind) for (const k of Object.keys(out) as (keyof CardCounts)[]) if (out[k] > PREFERRED_RATE && Number.isFinite(out[k])) out[k]--;
      if (g.trader?.owner === player) {
        const r = TERRAIN_RESOURCE[s.board.hexes[g.trader.hex].terrain];
        if (r) better(r);
      }
      return out;
    },

    // A lit hex is closed to the robber (unless that would leave it nowhere to go).
    robberHexes(s, hexes) {
      const lit = s.ext.guilds?.lit;
      if (!lit?.length) return hexes;
      const open = hexes.filter((h) => !lit.some((l) => l.hex === h));
      return open.length > 0 ? open : hexes;
    },

    awards(ctx) {
      // The trader is lost if its hex is conquered (Invasion).
      const g = guildsOf(ctx.s);
      if (g.trader && isConquered(ctx.s, g.trader.hex)) {
        g.trader = null;
        ctx.emit({ type: 'guilds/trader', player: null, hex: null });
      }
    },

    endOfTurn: [
      {
        // You have until the end of your actions to get back to the venture limit.
        rank: 5,
        run(ctx) {
          checkVentureLimit(ctx.s, ctx.s.currentPlayer);
        },
      },
      {
        // (And again once every other step has run, in case one of them handed out a venture.)
        rank: 95,
        run(ctx) {
          checkVentureLimit(ctx.s, ctx.s.currentPlayer);
        },
      },
    ],

    redact(s, viewer) {
      const g = guildsOf(s);
      g.hands = g.hands.map((h, p) => (p === viewer ? h : h.map(() => 'hidden' as const)));
      for (const t of TRACKS) g.decks[t] = g.decks[t].map(() => 'hidden' as const);
      // What a spymaster or a tribute revealed is for the eyes of whoever played it.
      for (const p of s.pending) {
        if (!p.kind.startsWith('guilds/') || (viewer !== null && p.players.includes(viewer))) continue;
        const d = p.data as GuildsPending;
        if (d.kind === 'guilds/spy') d.seen = d.seen.map(() => 'hidden' as const);
        if (d.kind === 'guilds/tribute') d.seen = emptyCards();
      }
    },
  },

  bot: guildsBot,

  invariants(s) {
    const out: string[] = [];
    const g = s.ext.guilds;
    if (!g) return ['no guilds state'];
    if (s.devDeck.length > 0) out.push('the development deck is in play');
    // Every venture is somewhere: a deck, a hand or shown.
    const count = new Map<string, number>();
    const tally = (c: string) => count.set(c, (count.get(c) ?? 0) + 1);
    for (const t of TRACKS) g.decks[t].forEach(tally);
    g.hands.forEach((h) => h.forEach(tally));
    g.shown.forEach((h) => h.forEach(tally));
    for (const [id, def] of Object.entries(VENTURES)) {
      const want = ventureCopies(s, def);
      if ((count.get(id) ?? 0) !== want) out.push(`venture ${id}: ${count.get(id) ?? 0} of ${want}`);
    }
    for (const t of TRACKS) for (const c of g.decks[t]) if (c !== 'hidden' && VENTURES[c].track !== t) out.push(`${c} in the ${t} deck`);
    g.hands.forEach((h, p) => {
      if (h.some((c) => c !== 'hidden' && VENTURES[c].victory)) out.push(`player ${p} holds a victory venture`);
      const owesDiscard = s.pending.some((x) => x.kind === 'guilds/ventureLimit' && x.players.includes(p));
      if (h.length > VENTURE_LIMIT && p !== s.currentPlayer && !owesDiscard && s.phase !== 'gameOver') out.push(`player ${p} holds ${h.length} ventures off their turn`);
    });
    g.levels.forEach((l, p) => {
      for (const t of TRACKS) if (!(l[t] >= 0 && l[t] <= MAX_LEVEL)) out.push(`player ${p} ${t} level ${l[t]}`);
    });
    // Seats: one per track at most, on a city, held by someone at level 4 or more.
    for (const t of TRACKS) {
      const at = s.buildings.filter((b) => b?.seat === t);
      if (at.length > 1) out.push(`${at.length} ${t} seats`);
      const v = seatVertex(s, t);
      if (v !== null) {
        const b = s.buildings[v]!;
        if (b.kind !== 'city') out.push(`the ${t} seat is not on a town`);
        if (g.levels[b.owner][t] < 4) out.push(`the ${t} seat is held below level 4`);
        if (g.seatsForGood.includes(t) && g.levels[b.owner][t] < MAX_LEVEL) out.push(`the ${t} seat is held for good below level 5`);
      } else if (g.seatsForGood.includes(t)) out.push(`the ${t} seat is held for good but stands nowhere`);
      if (v !== null && !s.options.knobs.stackUpgrades && s.buildings[v]!.foundry) out.push(`the ${t} seat shares a town with a foundry`);
    }
    if (g.trader) {
      const h = s.board.hexes[g.trader.hex];
      if (!h || !TERRAIN_RESOURCE[h.terrain]) out.push('the trader stands on a hex without a resource');
    }
    return out;
  },
};
