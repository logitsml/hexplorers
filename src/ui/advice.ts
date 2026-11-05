// Small pieces of arithmetic the interface offers as help: what your buildings earn per roll, a
// discard that keeps your best build, the supply's price for a trade you are about to offer, and
// who a tile would hurt. Read-only and from the presented state, like everything the HUD shows.

import { CARDS, COMMODITIES, COSTS, RESOURCES, emptyCards, legalCities, legalSettlements, totalCards, type Card, type GameState, type PlayerId, type CardCounts } from '../engine';
import { CARD_NAMES } from '../game/names';

/** Cards in words: "1 Wool, 2 Ore". */
export const describeCards = (rc: CardCounts) =>
  CARDS.filter((r) => rc[r] > 0)
    .map((r) => `${rc[r]} ${CARD_NAMES[r]}`)
    .join(', ') || 'nothing';

const empty = (): CardCounts => emptyCards();

/**
 * What a player's buildings bring in on an average roll beyond the supply's five resources, which
 * is all the supply shows (commodities, oil, a bounty field's picks): how many cards, and of what.
 */
export function incomeBeyond(i: CardCounts & { picks: number }) {
  const commodities = COMMODITIES.reduce((n, c) => n + i[c], 0);
  const kinds = [commodities > 0 && 'commodities', i.oil > 0 && 'oil', i.picks > 0 && 'picks of your choice'].filter((k): k is string => !!k);
  const words = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}` : (kinds[0] ?? '');
  return { amount: commodities + i.oil + i.picks, words };
}

/** "0.42": an expected count to two places (no leading zero lost, so the column lines up). */
export const perRoll = (x: number) => x.toFixed(2);

const BUILDS: { name: string; cost: CardCounts; ok: (s: GameState, me: PlayerId) => boolean }[] = [
  { name: 'a town', cost: COSTS.city, ok: (s, me) => legalCities(s, me).length > 0 },
  { name: 'a house', cost: COSTS.settlement, ok: (s, me) => legalSettlements(s, me).length > 0 },
  { name: 'a development card', cost: COSTS.devCard, ok: (s) => s.devDeck.length > 0 },
  { name: 'a road', cost: COSTS.road, ok: (s, me) => s.players[me].roadsLeft > 0 },
  { name: 'a second road', cost: COSTS.road, ok: (s, me) => s.players[me].roadsLeft > 1 },
];

/**
 * A discard of `need` cards that keeps the best builds the rest can still pay for (a city, then a
 * settlement, a development card, roads), taking the cards to give up from whatever you hold most
 * of, so what stays is as varied as it can be.
 */
export function suggestDiscard(s: GameState, me: PlayerId, hand: CardCounts, need: number) {
  const budget = totalCards(hand) - need;
  const kept = empty();
  const keeps: string[] = [];
  for (const b of BUILDS) {
    if (!b.ok(s, me)) continue;
    const fits = RESOURCES.every((r) => hand[r] - kept[r] >= b.cost[r]);
    if (!fits || totalCards(kept) + totalCards(b.cost) > budget) continue;
    for (const r of RESOURCES) kept[r] += b.cost[r];
    keeps.push(b.name);
  }
  // (Commodities and oil count on a 7 as well, so they're given up like any other card.)
  const pool = empty();
  for (const r of CARDS) pool[r] = hand[r] - kept[r];
  const discard = empty();
  for (let i = 0; i < need; i++) {
    const r = CARDS.reduce((a, b) => (pool[b] > pool[a] ? b : a));
    if (pool[r] <= 0) break;
    pool[r]--;
    discard[r]++;
  }
  return { discard, keeps };
}

/**
 * What the supply would take for the cards you ask for, paying in a kind you offered at your best
 * rate (a harbour's, else 4:1). Only for a single kind asked for, the usual trade.
 */
export function supplyPrice(ratios: Record<Card, number>, hand: CardCounts, bank: CardCounts, give: CardCounts, get: CardCounts) {
  const wanted = CARDS.filter((r) => get[r] > 0);
  // (The supply never sells oil, and takes it at no rate: Infinity.)
  if (wanted.length !== 1 || wanted[0] === 'oil') return null;
  const g = wanted[0];
  const times = get[g];
  if (bank[g] < times) return null;
  let best: { pay: Card; count: number; ratio: number } | null = null;
  for (const r of CARDS) {
    if (give[r] === 0 || r === g || !Number.isFinite(ratios[r])) continue;
    const count = ratios[r] * times;
    if (!best || count < best.count) best = { pay: r, count, ratio: ratios[r] };
  }
  if (!best) return null;
  return { ...best, get: g, times, affordable: hand[best.pay] >= best.count, cheaper: best.count <= totalCards(give) };
}

/**
 * What a trade with the supply takes, from your rates as they stand (4 of a kind, 3 with a
 * harbour, 2 of a harbour's own resource, or what an expansion makes them): the rate most kinds go
 * at, then any kind that goes for less, as "You need 4 of one kind to trade, or 2 wool."
 */
export function supplyNeeds(kinds: readonly Card[], ratios: Record<Card, number>): string {
  const rates = kinds.map((r) => ratios[r]).filter(Number.isFinite);
  const count = (n: number) => rates.filter((x) => x === n).length;
  // (Ties go to the dearer rate: the cheaper one is then named by its kinds.)
  const most = rates.reduce((a, b) => (count(b) > count(a) || (count(b) === count(a) && b > a) ? b : a), rates[0] ?? 4);
  const less = kinds.filter((r) => ratios[r] < most).sort((a, b) => ratios[a] - ratios[b]);
  const also = less.map((r) => `${ratios[r]} ${CARD_NAMES[r].toLowerCase()}`).join(' or ');
  return `You need ${most} of one kind to trade${also ? `, or ${also}` : ''}.`;
}

/** The players with a building on a tile, and how many of each (whom the robber there would hurt). */
export function playersOn(s: GameState, hex: number) {
  const by = new Map<PlayerId, { settlements: number; cities: number }>();
  for (const v of s.board.hexes[hex].vertices) {
    const b = s.buildings[v];
    if (!b) continue;
    const e = by.get(b.owner) ?? { settlements: 0, cities: 0 };
    if (b.kind === 'city') e.cities++;
    else e.settlements++;
    by.set(b.owner, e);
  }
  return [...by.entries()].map(([player, n]) => ({ player, ...n }));
}
