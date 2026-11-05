// The table's own small logic, apart from what draws it: whom the game waits on and since when
// (for Hail), a seat's Looking for / Spare as a card is tapped, quick talk in its groups, who is
// typing, the offer kept to make again at your next turn, a game's awards and its results in a
// line to share. Pure, or nearly (the hail's first-seen times are kept here, by key).

import { CARDS, hasResources, totalCards, type Card, type CardCounts, type GameState, type PlayerId } from '../engine';
import { CARD_NAMES } from '../game/names';
import { HAIL_AFTER_MS, type QuickTalk, type Results, type SeatInfo } from '../net/protocol';

// ------------------------------------------------------------------ whom the table waits on

/**
 * What a seat owes the table now, as a key that stays the same while the same thing is owed (the
 * room's clocks key their obligations the same way, server/room/clock.ts): its turn, a decision
 * an expansion left it, a discard, or an answer to an offer. Null when it owes nothing.
 */
export function owedKey(s: GameState, seat: PlayerId): string | null {
  if (s.phase === 'gameOver') return null;
  if (s.currentPlayer === seat) return `t${s.turn}:${seat}:${s.setupIndex}`;
  const top = s.pending.at(-1);
  if (top) return top.players.includes(seat) ? `p${s.turn}:${s.pending.length}:${top.kind}` : null;
  if (s.phase === 'discard' && s.pendingDiscards[seat] !== undefined) return `d${s.turn}`;
  const t = s.trade;
  if (s.phase === 'main' && t && t.proposer !== seat && (t.to.length === 0 || t.to.includes(seat)) && t.responses[seat] === undefined && t.counters[seat] === undefined) return `x${t.id}`;
  return null;
}

/** When each obligation was first seen here (by its key): a hail waits until it has been owed a while. */
const firstSeen = new Map<string, number>();

/** When this device first saw `seat` owe what it owes now (now, the first time it's asked). */
export function owedSince(s: GameState, seat: PlayerId, now = Date.now()): number | null {
  const key = owedKey(s, seat);
  if (key === null) return null;
  const k = `${seat}|${key}`;
  let at = firstSeen.get(k);
  if (at === undefined) {
    at = now;
    firstSeen.set(k, at);
    // (Kept small: the table only ever waits on a few things at once.)
    if (firstSeen.size > 64) firstSeen.delete(firstSeen.keys().next().value!);
  }
  return at;
}

/** Forget the first-seen times (a new game, or a test). */
export function forgetOwed() {
  firstSeen.clear();
}

/**
 * Whether `me` may hail `seat` now: a person (not the crew, not away, not conceded) the game is
 * waiting on, not yourself, once they've been waited on HAIL_AFTER_MS, and not again within the
 * gap since your last hail (the room holds you to it too). Watching, you can't.
 */
export function canHail(o: { state: GameState; seat: PlayerId; me: PlayerId | null; seats: readonly SeatInfo[]; since: number | null; now: number; lastHail?: number; gap?: number }): boolean {
  if (o.me === null || o.seat === o.me || o.since === null) return false;
  const s = o.seats.find((x) => x.seat === o.seat);
  if (!s || s.kind !== 'human' || s.away || s.conceded) return false;
  const mine = o.seats.find((x) => x.seat === o.me);
  if (!mine || mine.kind !== 'human' || mine.conceded) return false;
  if (owedKey(o.state, o.seat) === null) return false;
  if (o.now - o.since < HAIL_AFTER_MS) return false;
  return o.lastHail === undefined || o.now - o.lastHail >= (o.gap ?? HAIL_AFTER_MS);
}

// ------------------------------------------------------------------ Looking for / Spare

export type Wants = { looking: Card[]; spare: Card[] };
export const NO_WANTS: Wants = { looking: [], spare: [] };

/** A card tapped on one of the lists: on (off the other list, as a card can't be both) or off again. */
export function toggleWant(w: Wants | undefined, card: Card, list: keyof Wants): Wants {
  const cur = w ?? NO_WANTS;
  const other: keyof Wants = list === 'looking' ? 'spare' : 'looking';
  const on = cur[list].includes(card);
  // (Kept in the game's card order, so the tags read the same on every panel.)
  const order = (xs: Card[]) => CARDS.filter((c) => xs.includes(c));
  return {
    [list]: order(on ? cur[list].filter((c) => c !== card) : [...cur[list], card]),
    [other]: order(cur[other].filter((c) => c !== card)),
  } as Wants;
}

/** Two lists the same (the room's word against what was asked). */
export const sameWants = (a: Wants | undefined, b: Wants | undefined) => (a?.looking ?? []).join() === (b?.looking ?? []).join() && (a?.spare ?? []).join() === (b?.spare ?? []).join();

const names = (cs: Card[]) => cs.map((c) => CARD_NAMES[c].toLowerCase()).join(', ');

/** A seat's word in a line: "Looking for ore, wool · Spare brick" (empty: nothing said). */
export function wantsText(w: Wants | undefined): string {
  if (!w) return '';
  return [w.looking.length && `Looking for ${names(w.looking)}`, w.spare.length && `Spare ${names(w.spare)}`].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ quick talk

/** Quick talk in its groups, for the chat's tabs (every word once). */
export const QUICK_GROUPS: { id: string; label: string; words: QuickTalk[] }[] = [
  { id: 'greet', label: 'Greet', words: ['hello', 'goodLuck', 'thanks', 'sorry', 'oops'] },
  { id: 'trade', label: 'Trade', words: ['anyWool', 'anyGrain', 'anyLumber', 'anyBrick', 'anyOre', 'noTrades', 'deal', 'noDeal'] },
  { id: 'cheer', label: 'Cheer', words: ['niceMove', 'wellPlayed', 'goodGame'] },
  { id: 'pace', label: 'Pace', words: ['oneMoment', 'yourTurn'] },
];

/** Who is typing, in words ("Ana is typing…", "Ana and Ben are typing…"); not you. */
export function typingText(typing: Record<number, boolean>, seats: readonly Pick<SeatInfo, 'seat' | 'name'>[], me: PlayerId | null): string {
  const who = seats.filter((s) => s.seat !== me && typing[s.seat]).map((s) => s.name);
  if (!who.length) return '';
  if (who.length === 1) return `${who[0]} is typing…`;
  return `${who.slice(0, -1).join(', ')} and ${who.at(-1)} are typing…`;
}

/**
 * Says you're typing while there's something in the line, and that you've stopped once it has
 * gone quiet for a few seconds, been sent or been cleared: a word each way, not one a key.
 */
export class TypingSignal {
  private on = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private send: (on: boolean) => void,
    private quietMs = 4000,
    private clock: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
  ) {}

  /** The line now reads `text`. */
  input(text: string) {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
    if (!text.trim()) return this.stop();
    if (!this.on) {
      this.on = true;
      this.send(true);
    }
    this.timer = this.clock.set(() => {
      this.timer = null;
      this.stop();
    }, this.quietMs);
  }

  /** Sent, cleared, or the panel closed. */
  stop() {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
    if (!this.on) return;
    this.on = false;
    this.send(false);
  }
}

// ------------------------------------------------------------------ the offer to make again

/** An offer you made, to make again at your next turn in one tap (who it went to too). */
export interface KeptOffer {
  give: CardCounts;
  get: CardCounts;
  to: PlayerId[];
  /** The turn it was made in. */
  turn: number;
}

/**
 * The offer to make again now, if any: it's your turn's main phase with no offer out and nothing
 * owed, it was made in an earlier turn, and you still hold what it gives (its partners still at
 * the table). This stands in for "standing offers" (an answer the room would give for you while
 * you're away): one tap from you rather than a deal struck in your absence, which nobody should
 * find made on their behalf.
 */
export function offerAgain(kept: KeptOffer | null, s: GameState, me: PlayerId | null): KeptOffer | null {
  if (!kept || me === null) return null;
  if (s.phase !== 'main' || s.currentPlayer !== me || s.trade || s.pending.length > 0) return null;
  if (s.turn <= kept.turn) return null;
  if (totalCards(kept.give) === 0 || totalCards(kept.get) === 0 || !hasResources(s.players[me].hand, kept.give)) return null;
  if (kept.to.some((p) => !s.players[p] || p === me)) return null;
  return kept;
}

// ------------------------------------------------------------------ the results

/** A game's highlights (Results.awards), as a badge says them: a short name and its figure. */
export function awardText(award: string, value?: number): { label: string; short: string } {
  const n = value ?? 0;
  const of = (one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  switch (award) {
    case 'longestRoute':
      return { label: `Longest Route: ${of('road')}`, short: 'Longest Route' };
    case 'largestArmy':
      return { label: `Biggest Army: ${of('knight')}`, short: 'Biggest Army' };
    case 'mostTrades':
      return { label: `Most trades: ${n}`, short: 'Most trades' };
    case 'bestHarvest':
      return { label: `Best harvest: ${of('card')}`, short: 'Best harvest' };
    case 'mostSevens':
      return { label: `Most sevens rolled: ${n}`, short: 'Most sevens' };
    case 'mostRobbed':
      return { label: `Robbed most often: ${of('time')}`, short: 'Most robbed' };
    default:
      return { label: award, short: award };
  }
}

/** A finished game in one line to share, with its replay's link: "Wren won · Wren 10 · Ana 8 · Ben 6 (conceded) · 64 turns". */
export function shareText(r: Results, seats: readonly Pick<SeatInfo, 'seat' | 'name'>[], me: PlayerId | null): string {
  const name = (p: PlayerId) => (p === me ? 'You' : (seats.find((s) => s.seat === p)?.name ?? `Seat ${p + 1}`));
  const head = r.winner === null ? 'Nobody won' : r.winner === me ? 'I won' : `${name(r.winner)} won`;
  const rows = r.standings.map((s) => `${s.seat === me ? 'Me' : name(s.seat)} ${s.points}${s.conceded ? ' (conceded)' : ''}`);
  return `${head} in Hexplorers · ${rows.join(' · ')} · ${r.turns} turns`;
}

/** The cards an offer is for, in words ("2 wool for 1 ore"), for the line that makes it again. */
export function offerWords(o: Pick<KeptOffer, 'give' | 'get'>): string {
  const side = (c: CardCounts) => CARDS.filter((k) => c[k] > 0).map((k) => `${c[k]} ${CARD_NAMES[k].toLowerCase()}`).join(', ');
  return `${side(o.give)} for ${side(o.get)}`;
}
