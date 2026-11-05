// Public card tracker: what each seat can know about every hand, from what happened at the table.
// Production, discards, trades, building costs, Monopoly and the expansions' open card moves
// ('cardsMoved': their costs, picks and gifts) are public; a steal is seen only by the
// thief and the victim, so everyone else learns only that one card moved. Per hand it keeps the
// cards known for certain ("sure") and the expected count of each kind, with the expected counts
// always adding up to the hand's size (which everyone can see). Bots and table talk read this
// instead of the hidden hands.
//
// It tracks the hidden kinds in play: the resources, and the commodities with the guilds. Oil is
// held face up, so it needs no tracking: every estimate reads it straight from the hand.

import { COSTS, emptyCards } from './constants';
import type { Card, CardCounts, GameEvent, GameState, PlayerId } from './types';
import { CARDS, COMMODITIES, RESOURCES } from './types';

const EPS = 1e-9;

/** The kinds the tracker follows in a game: the hidden ones in play. */
export function trackedKinds(s: GameState): readonly Card[] {
  return s.options.modules.includes('guilds') ? TRACKED_GUILDS : RESOURCES;
}
const TRACKED_GUILDS: readonly Card[] = [...RESOURCES, ...COMMODITIES];

/** Index of kind `ri` of kind-slot `k` (0 sure, 1 expected) for `player` seen by `viewer` (n = public), with R kinds tracked. */
const at = (n: number, R: number, viewer: number, player: number, k: 0 | 1, ri: number) => ((viewer * n + player) * 2 + k) * R + ri;

const trackerLength = (n: number, R: number) => (n + 1) * n * 2 * R;

export function emptyTracker(players: number, kinds = RESOURCES.length): number[] {
  return new Array<number>(trackerLength(players, kinds)).fill(0);
}

export interface HandEstimate {
  /** Cards of each kind the viewer knows for certain are in the hand. */
  sure: CardCounts;
  /** Expected cards of each kind (adds up to the hand's size). */
  expected: CardCounts;
  /** The hand's size in tracked (hidden) kinds. */
  total: number;
}

/** The hidden part of a hand's size: what everyone can count but not see. */
const handTotal = (s: GameState, p: PlayerId, kinds: readonly Card[]) => {
  const h = s.players[p].hand;
  let n = 0;
  for (const k of kinds) n += h[k];
  return n;
};

/**
 * What `viewer` (null: a spectator) can know about `player`'s hand. A player's own hand is
 * known exactly, and so is everyone's oil. Falls back to an even guess when the state carries no tracker.
 */
export function handEstimate(s: GameState, viewer: PlayerId | null, player: PlayerId): HandEstimate {
  const kinds = trackedKinds(s);
  const R = kinds.length;
  const total = handTotal(s, player, kinds);
  if (viewer === player) {
    const own = { ...s.players[player].hand };
    return { sure: own, expected: { ...own }, total };
  }
  const n = s.players.length;
  const v = viewer ?? n;
  const t = s.tracker;
  const sure = emptyCards();
  const expected = emptyCards();
  if (t && t.length === trackerLength(n, R)) {
    kinds.forEach((r, ri) => {
      sure[r] = t[at(n, R, v, player, 0, ri)];
      expected[r] = Math.max(sure[r], t[at(n, R, v, player, 1, ri)]);
    });
  }
  normalize(kinds, sure, expected, total);
  sure.oil = expected.oil = s.players[player].hand.oil;
  return { sure, expected, total };
}

/**
 * Whether, as far as `viewer` can tell, `player` might hold `need`: the cards it knows for certain,
 * plus the hand's unknown cards, could cover it. Oil is face up, so it either is there or isn't, and
 * a kind nobody tracks in this game (commodities without the guilds) is in no hand.
 */
export function mightHold(s: GameState, viewer: PlayerId | null, player: PlayerId, need: CardCounts): boolean {
  const e = handEstimate(s, viewer, player);
  const kinds = trackedKinds(s);
  let unknown = e.total;
  for (const k of kinds) unknown -= e.sure[k];
  let beyond = 0;
  for (const k of kinds) beyond += Math.max(0, need[k] - e.sure[k]);
  for (const k of CARDS) if (!kinds.includes(k) && need[k] > e.sure[k]) return false;
  return beyond <= unknown + EPS;
}

/** Make `expected` sum to `total` without going below `sure` (tests and patched states can drift). */
function normalize(kinds: readonly Card[], sure: CardCounts, expected: CardCounts, total: number) {
  const R = kinds.length;
  let sureSum = 0;
  for (const r of kinds) sureSum += sure[r];
  if (sureSum > total + EPS) {
    // Inconsistent certainty: keep the proportions, drop the certainty.
    for (const r of kinds) {
      expected[r] = sureSum > 0 ? (sure[r] * total) / sureSum : total / R;
      sure[r] = 0;
    }
    return;
  }
  const want = total - sureSum;
  let u = 0;
  for (const r of kinds) u += expected[r] - sure[r];
  for (const r of kinds) {
    const ur = u > EPS ? ((expected[r] - sure[r]) * want) / u : want / R;
    expected[r] = sure[r] + ur;
  }
}

/** One hand as one viewer sees it, edited in place. */
class View {
  /** Where this view's sure and expected counts start in the tracker. */
  private s0: number;
  private e0: number;
  constructor(
    private t: number[],
    n: number,
    private R: number,
    v: number,
    p: number,
  ) {
    this.s0 = at(n, R, v, p, 0, 0);
    this.e0 = at(n, R, v, p, 1, 0);
  }
  sure(ri: number) {
    return this.t[this.s0 + ri];
  }
  exp(ri: number) {
    return this.t[this.e0 + ri];
  }
  set(ri: number, sure: number, exp: number) {
    this.t[this.s0 + ri] = sure;
    this.t[this.e0 + ri] = Math.max(sure, exp);
  }
  total() {
    let n = 0;
    for (let i = 0; i < this.R; i++) n += this.exp(i);
    return n;
  }
  gain(ri: number, k: number) {
    this.set(ri, this.sure(ri) + k, this.exp(ri) + k);
  }
  /** `k` cards of a kind left the hand openly. Beyond the sure ones they were unknown cards, now revealed. */
  lose(ri: number, k: number) {
    const fromSure = Math.min(k, this.sure(ri));
    const fromUnknown = k - fromSure;
    const u = this.exp(ri) - this.sure(ri) - fromUnknown;
    this.set(ri, this.sure(ri) - fromSure, this.sure(ri) - fromSure + Math.max(0, u));
    if (u < -EPS) this.takeUnknown(-u, ri);
  }
  /** Remove `k` unknown cards spread over the other kinds (the estimate had them elsewhere). */
  private takeUnknown(k: number, except: number) {
    let pool = 0;
    for (let i = 0; i < this.R; i++) if (i !== except) pool += this.exp(i) - this.sure(i);
    if (pool <= EPS) return;
    const f = Math.max(0, (pool - k) / pool);
    for (let i = 0; i < this.R; i++) if (i !== except) this.set(i, this.sure(i), this.sure(i) + (this.exp(i) - this.sure(i)) * f);
  }
  /** The hand holds exactly `k` of a kind (Monopoly shows it). */
  reveal(ri: number, k: number) {
    const before = this.exp(ri);
    this.set(ri, k, k);
    // The rest of the hand's unknown cards make up the difference.
    const shift = before - k;
    let pool = 0;
    for (let i = 0; i < this.R; i++) if (i !== ri) pool += this.exp(i) - this.sure(i);
    if (shift > 0) {
      const each = pool > EPS ? null : shift / (this.R - 1);
      for (let i = 0; i < this.R; i++) {
        if (i === ri) continue;
        const ui = this.exp(i) - this.sure(i);
        this.set(i, this.sure(i), this.sure(i) + ui + (each ?? (ui / pool) * shift));
      }
    } else if (shift < 0) this.takeUnknown(-shift, ri);
  }
  /** One card of unknown kind leaves the hand; returns the chance it was each kind. */
  loseUnknown(): number[] {
    const total = this.total();
    const p = Array.from({ length: this.R }, (_, i) => (total > EPS ? this.exp(i) / total : 0));
    for (let i = 0; i < this.R; i++) {
      const s = this.sure(i);
      // Any certain card might have been the one taken.
      this.set(i, Math.max(0, s - 1), this.exp(i) - p[i]);
    }
    return p;
  }
  gainUnknown(p: number[]) {
    for (let i = 0; i < this.R; i++) this.set(i, this.sure(i), this.exp(i) + p[i]);
  }
}

/** Each tracked kind's place in the tracker, per list of kinds. */
const kindIndex = new WeakMap<readonly Card[], Map<Card, number>>();

/** Apply a batch of events to `s.tracker` (which must be `s`'s own copy). `s` is the state after them. */
export function trackEvents(s: GameState, events: GameEvent[]) {
  const n = s.players.length;
  const kinds = trackedKinds(s);
  const R = kinds.length;
  if (!s.tracker || s.tracker.length !== trackerLength(n, R)) s.tracker = emptyTracker(n, R);
  const t = s.tracker;
  let index = kindIndex.get(kinds);
  if (!index) kindIndex.set(kinds, (index = new Map<Card, number>(kinds.map((k, i) => [k, i]))));
  // Untracked kinds (oil) are -1: every View method is skipped for them.
  const RI = (k: Card) => index.get(k) ?? -1;
  const views = (p: PlayerId) => Array.from({ length: n + 1 }, (_, v) => new View(t, n, R, v, p));
  const each = (p: PlayerId, fn: (h: View) => void) => views(p).forEach(fn);
  const gainAll = (p: PlayerId, rc: CardCounts) => each(p, (h) => kinds.forEach((r, ri) => rc[r] > 0 && h.gain(ri, rc[r])));
  const loseAll = (p: PlayerId, rc: CardCounts) => each(p, (h) => kinds.forEach((r, ri) => rc[r] > 0 && h.lose(ri, rc[r])));
  for (const [i, e] of events.entries()) {
    switch (e.type) {
      case 'production':
        for (const g of e.grants) if (RI(g.resource) >= 0) each(g.player, (h) => h.gain(RI(g.resource), g.amount));
        break;
      case 'startingResources':
        for (const g of e.grants) if (RI(g.resource) >= 0) each(e.player, (h) => h.gain(RI(g.resource), 1));
        break;
      case 'discarded':
        loseAll(e.player, e.resources);
        break;
      case 'stolen': {
        const ri = RI(e.resource);
        if (ri < 0) break;
        for (let v = 0; v <= n; v++) {
          const victim = new View(t, n, R, v, e.victim);
          const thief = new View(t, n, R, v, e.thief);
          // (Oil taken by name is taken openly: everyone knows the card.)
          if (v === e.thief || v === e.victim || e.named) {
            victim.lose(ri, 1);
            thief.gain(ri, 1);
          } else thief.gainUnknown(victim.loseUnknown());
        }
        break;
      }
      case 'monopoly': {
        const ri = RI(e.resource);
        let sum = 0;
        for (const p of s.players) {
          if (p.id === e.player) continue;
          const k = e.taken[p.id] ?? 0;
          sum += k;
          each(p.id, (h) => {
            h.reveal(ri, k);
            h.lose(ri, k);
          });
        }
        each(e.player, (h) => h.gain(ri, sum));
        break;
      }
      case 'invention':
        for (const r of e.resources) each(e.player, (h) => h.gain(RI(r), 1));
        break;
      case 'bankTraded':
        each(e.player, (h) => {
          if (RI(e.give) >= 0) h.lose(RI(e.give), e.giveCount);
          if (RI(e.get) >= 0) h.gain(RI(e.get), e.getCount);
        });
        break;
      case 'cardsMoved':
        if (e.from !== null) loseAll(e.from, e.cards);
        if (e.to !== null) gainAll(e.to, e.cards);
        break;
      case 'coinTraded':
        if (RI(e.card) >= 0) each(e.player, (h) => (e.bought ? h.gain(RI(e.card), e.cards) : h.lose(RI(e.card), e.cards)));
        break;
      case 'tradeExecuted':
        loseAll(e.from, e.give);
        gainAll(e.to, e.give);
        loseAll(e.to, e.get);
        gainAll(e.from, e.get);
        break;
      case 'roadBuilt':
        if (!e.free) loseAll(e.player, COSTS.road);
        break;
      case 'settlementBuilt':
        loseAll(e.player, COSTS.settlement);
        break;
      case 'cityBuilt': {
        // A module may have paid a different city cost in the preceding open move (Town
        // Planning). That payment is already tracked, just as the presenter already shows it.
        const paid = events[i - 1];
        if (!(paid?.type === 'cardsMoved' && paid.from === e.player && paid.to === null)) loseAll(e.player, COSTS.city);
        break;
      }
      case 'devCardBought':
        loseAll(e.player, COSTS.devCard);
        break;
    }
  }
  // Everyone knows their own hand, and every hand's size is public.
  for (const p of s.players) {
    const own = new View(t, n, R, p.id, p.id);
    kinds.forEach((r, ri) => own.set(ri, p.hand[r], p.hand[r]));
    const total = handTotal(s, p.id, kinds);
    for (let v = 0; v <= n; v++) if (v !== p.id) normalizeAt(t, at(n, R, v, p.id, 0, 0), at(n, R, v, p.id, 1, 0), R, total);
  }
}

/**
 * normalize() on one view of a hand where it lies in the tracker (its sure counts from `s0`, its
 * expected ones from `e0`), with the same arithmetic in the same order, so the result is the same
 * to the last bit. (It runs for every view of every hand after every action.)
 */
function normalizeAt(t: number[], s0: number, e0: number, R: number, total: number) {
  let sureSum = 0;
  for (let i = 0; i < R; i++) sureSum += t[s0 + i];
  if (sureSum > total + EPS) {
    for (let i = 0; i < R; i++) {
      t[e0 + i] = sureSum > 0 ? (t[s0 + i] * total) / sureSum : total / R;
      t[s0 + i] = 0;
    }
    return;
  }
  const want = total - sureSum;
  let u = 0;
  for (let i = 0; i < R; i++) u += t[e0 + i] - t[s0 + i];
  for (let i = 0; i < R; i++) {
    const ur = u > EPS ? ((t[e0 + i] - t[s0 + i]) * want) / u : want / R;
    t[e0 + i] = t[s0 + i] + ur;
  }
}

/** The tracker as `viewer` may see it: other seats' private knowledge (of steals) becomes the public view. */
export function redactTracker(s: GameState, viewer: PlayerId | null): number[] | undefined {
  const t = s.tracker;
  const n = s.players.length;
  const R = trackedKinds(s).length;
  if (!t || t.length !== trackerLength(n, R)) return t?.slice();
  const out = t.slice();
  const row = n * 2 * R;
  for (let v = 0; v < n; v++) {
    if (v === viewer) continue;
    for (let i = 0; i < row; i++) out[v * row + i] = t[n * row + i];
  }
  return out;
}
