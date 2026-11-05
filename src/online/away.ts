// "While you were away": what changed at the table after the link dropped or the phone slept, in a
// few lines. Read from the records that came in catch-up (the rolls, what you received, the robber,
// trades, builds), or, after a jump to the game whole, from the game as you left it (a mark taken
// when you went) against the game now. Pure.

import type { GameEvent, GameState, PlayerId } from '../engine';
import { CARD_NAMES } from '../game/names';

/** A game as you left it at your last move: enough to say what changed since. */
export interface Mark {
  seq: number;
  turn: number;
  at: number;
  /** Each seat's pieces left (roads, settlements, cities) and knights played. */
  pieces: [number, number, number, number][];
  /** Cards in your hand. */
  hand: number;
  road: PlayerId | null;
  army: PlayerId | null;
  robber: number | null;
}

const handSize = (s: GameState, me: PlayerId) => Object.values(s.players[me]?.hand ?? {}).reduce((a, b) => a + (b ?? 0), 0);

/** The game as it is now, for next time. */
export function markOf(s: GameState, me: PlayerId, at = Date.now()): Mark {
  return {
    seq: s.seq,
    turn: s.turn,
    at,
    pieces: s.players.map((p) => [p.roadsLeft, p.settlementsLeft, p.citiesLeft, p.playedKnights]),
    hand: handSize(s, me),
    road: s.longestRoadHolder,
    army: s.largestArmyHolder,
    robber: s.robberHex,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listText = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** What changed between your last move's game and this one, in a few lines (none: nothing worth a card). */
export function sinceMark(m: Mark, s: GameState, me: PlayerId): string[] {
  if (s.seq <= m.seq) return [];
  const out: string[] = [];
  const turns = s.turn - m.turn;
  if (turns > 0) out.push(`${plural(turns, 'turn')} since your last move.`);
  for (const p of s.players) {
    if (p.id === me) continue;
    const was = m.pieces[p.id];
    if (!was) continue;
    const roads = was[0] - p.roadsLeft;
    const cities = was[2] - p.citiesLeft;
    const settlements = cities - (p.settlementsLeft - was[1]);
    const knights = p.playedKnights - was[3];
    const built = [cities > 0 && plural(cities, 'town', 'towns'), settlements > 0 && plural(settlements, 'house'), roads > 0 && plural(roads, 'road')].filter((x): x is string => !!x);
    if (built.length) out.push(`${p.name} built ${listText(built.map((x) => x.replace(/^1 /, 'a ')))}.`);
    if (knights > 0) out.push(`${p.name} played ${knights === 1 ? 'a knight' : `${knights} knights`}.`);
  }
  const name = (id: PlayerId | null) => (id === null ? '' : id === me ? 'You' : (s.players[id]?.name ?? 'Someone'));
  if (s.longestRoadHolder !== m.road && s.longestRoadHolder !== null) out.push(`${name(s.longestRoadHolder)} ${s.longestRoadHolder === me ? 'have' : 'has'} the longest route now.`);
  if (s.largestArmyHolder !== m.army && s.largestArmyHolder !== null) out.push(`${name(s.largestArmyHolder)} ${s.largestArmyHolder === me ? 'have' : 'has'} the biggest army now.`);
  if (s.robberHex !== m.robber) out.push('The robber has moved.');
  const hand = handSize(s, me) - m.hand;
  if (hand > 0) out.push(`You have ${plural(hand, 'more card')}.`);
  else if (hand < 0) out.push(`You have ${plural(-hand, 'card')} fewer.`);
  return out;
}

const cardsText = (grants: { card: string; n: number }[]) => listText(grants.map((g) => `${g.n} ${(CARD_NAMES[g.card as keyof typeof CARD_NAMES] ?? g.card).toLowerCase()}`));

/** What the records missed while away say, in a few lines: the rolls, what you received, the robber, trades and builds. */
export function fromEvents(events: GameEvent[], me: PlayerId | null, name: (p: PlayerId) => string): string[] {
  const rolls: number[] = [];
  const got = new Map<string, number>();
  const builds = new Map<PlayerId, string[]>();
  const out: string[] = [];
  const who = (p: PlayerId) => (p === me ? 'You' : name(p));
  for (const e of events) {
    switch (e.type) {
      case 'diceRolled':
        rolls.push(e.total);
        break;
      case 'production':
        for (const g of e.grants) if (g.player === me) got.set(g.resource, (got.get(g.resource) ?? 0) + g.amount);
        break;
      case 'robberMoved':
        out.push(`${who(e.player)} moved the robber.`);
        break;
      case 'stolen':
        if (e.victim === me) out.push(`${name(e.thief)} took a card from you.`);
        break;
      case 'tradeExecuted':
        out.push(`${who(e.from)} and ${e.to === me ? 'you' : name(e.to)} traded.`);
        break;
      case 'settlementBuilt':
      case 'cityBuilt':
      case 'roadBuilt':
        if (e.player !== me) builds.set(e.player, [...(builds.get(e.player) ?? []), e.type === 'cityBuilt' ? 'city' : e.type === 'settlementBuilt' ? 'settlement' : 'road']);
        break;
      case 'devCardPlayed':
        if (e.player !== me) out.push(`${name(e.player)} played a ${e.card === 'knight' ? 'knight' : 'development card'}.`);
        break;
      case 'longestRoadChanged':
        if (e.to !== null) out.push(`${who(e.to)} ${e.to === me ? 'have' : 'has'} the longest route.`);
        break;
      case 'largestArmyChanged':
        if (e.to !== null) out.push(`${who(e.to)} ${e.to === me ? 'have' : 'has'} the biggest army.`);
        break;
    }
  }
  const lines: string[] = [];
  if (rolls.length) lines.push(`${rolls.length === 1 ? 'Rolled' : 'Rolls'}: ${rolls.join(', ')}.`);
  if (got.size) lines.push(`You received ${cardsText([...got].map(([card, n]) => ({ card, n })))}.`);
  for (const [p, xs] of builds) {
    const count = (k: string) => xs.filter((x) => x === k).length;
    const parts = [count('city') && plural(count('city'), 'town', 'towns'), count('settlement') && plural(count('settlement'), 'house'), count('road') && plural(count('road'), 'road')].filter((x): x is string => !!x);
    lines.push(`${name(p)} built ${listText(parts.map((x) => x.replace(/^1 /, 'a ')))}.`);
  }
  // (The robber and the trades in the order they came, after the rolls and the builds.)
  return [...lines, ...out].slice(0, 6);
}
