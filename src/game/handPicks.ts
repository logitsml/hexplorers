// Cards an expansion asks for out of a hand, which the engine takes one card at a time: an unrest's
// discard, a dowry's or a barter's give, a tribute's take. A person chooses them together, in the
// base game's discard picker (ui/modules/CardPicks.tsx), and the moves go out one card each
// (Presenter.actAll), each the very move legalActions lists. Read from the game and nothing else,
// so it serves a redacted view online: the hand picked from is your own, or for a tribute, what
// the venture showed you of theirs.

import { COMMODITIES, emptyCards, legalActions, type Action, type Card, type CardCounts, type GameState, type Pending, type PlayerId } from '../engine';
import { ventureKinds } from '../engine/modules/guilds/ventures';
import type { GuildsPending } from '../engine/modules/guilds/types';

/** The decisions answered card by card from a hand, and the move that answers each card. */
const MOVES = { 'guilds/discard': 'guilds/discardCard', 'guilds/give': 'guilds/give', 'guilds/tribute': 'guilds/take' } as const;

export type HandPickKind = keyof typeof MOVES;

export interface HandPick {
  kind: HandPickKind;
  /** What it's for, in the words the dialog uses. */
  reason: 'unrest' | 'dowry' | 'barter' | 'tribute';
  /** How many cards to choose. */
  need: number;
  /** The kinds that may be chosen, and how many there are of each to choose from. */
  kinds: Card[];
  max: CardCounts;
  /** Whose cards they are: yours, or the player a tribute takes from. */
  from: PlayerId;
  /** Who they go to: null for the supply. */
  to: PlayerId | null;
}

/** The hand pick you owe now, if the decision on top of the stack is one. */
export function handPick(s: GameState, me: PlayerId): HandPick | null {
  const top = s.pending[s.pending.length - 1] as Pending | undefined;
  if (!top || !top.players.includes(me) || !(top.kind in MOVES)) return null;
  const d = top.data as GuildsPending;
  const hand = s.players[me].hand;
  const of = (kinds: Card[], counts: CardCounts) => {
    const max = emptyCards();
    for (const k of kinds) max[k] = counts[k];
    return max;
  };
  const pick = (reason: HandPick['reason'], left: number, kinds: Card[], counts: CardCounts, from: PlayerId, to: PlayerId | null): HandPick => {
    const max = of(kinds, counts);
    // (The engine settles the decision early once the hand runs out, so no more is ever asked.)
    const held = kinds.reduce((n, k) => n + max[k], 0);
    return { kind: top.kind as HandPickKind, reason, need: Math.min(left, held), kinds, max, from, to };
  };
  if (d.kind === 'guilds/discard') return pick('unrest', d.left, ventureKinds(s), hand, me, null);
  if (d.kind === 'guilds/give') return pick(d.reason, d.left, d.only === 'commodities' ? [...COMMODITIES] : ventureKinds(s), hand, me, d.to);
  if (d.kind === 'guilds/tribute') return pick('tribute', d.left, ventureKinds(s), d.seen, d.target, me);
  return null;
}

/**
 * The moves that make a hand pick, one card each in the order of `kinds`: each one legalActions
 * lists now (the engine takes the same move again for a second card of a kind). Null unless
 * `chosen` is a whole answer: `need` cards, none beyond what there is.
 */
export function handPickMoves(s: GameState, me: PlayerId, pick: HandPick, chosen: CardCounts): Action[] | null {
  const legal = legalActions(s, me).filter((a) => a.type === MOVES[pick.kind]);
  const out: Action[] = [];
  for (const k of pick.kinds) {
    if (chosen[k] > pick.max[k]) return null;
    if (chosen[k] === 0) continue;
    const a = legal.find((x) => (x as { card: Card }).card === k);
    if (!a) return null;
    for (let i = 0; i < chosen[k]; i++) out.push(a);
  }
  return out.length === pick.need ? out : null;
}
