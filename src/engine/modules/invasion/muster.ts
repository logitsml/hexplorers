// The muster deck: Invasion's own cards, which replace the development cards when the guilds'
// ventures don't. Each is bought for a development card's price and played at once; a card that
// can do nothing (an ambush with no raider on the board, a warden with no piece or edge for it)
// goes to the discard and another is drawn in its place.

import { COSTS } from '../../constants';
import { addCoins, assert, fail, moveCards, validIndex, type Ctx } from '../../ctx';
import type { Rng } from '../../rng';
import { canAfford } from '../../rules';
import type { Action, GameState, PlayerId } from '../../types';
import { newWardenId } from '../shared';
import { inv, takeRaider, unlimitedRaiders } from './raids';
import { topology } from './topology';
import type { CardPending, InvasionAction, MusterCard, RaiderMove } from './types';
import { WARDENS_PER_PLAYER, wardenOn } from './wardens';

/** The answers to a muster card. */
type CardAction = Extract<InvasionAction, { type: 'invasion/levy' | 'invasion/outrider' | 'invasion/ambush' | 'invasion/turncoat' }>;

export const MUSTER_DECK: Record<MusterCard, number> = { levy: 14, outrider: 4, ambush: 4, turncoat: 4 };
export const MUSTER_TOTAL = Object.values(MUSTER_DECK).reduce((a, b) => a + b, 0);
/** Coins a turncoat pays. */
export const TURNCOAT_COINS = 2;
/** Raiders a turncoat leads away. */
const TURNCOAT_RAIDERS = 2;

export function newMusterDeck(rng: Rng): MusterCard[] {
  const deck: MusterCard[] = [];
  for (const [card, n] of Object.entries(MUSTER_DECK) as [MusterCard, number][]) for (let k = 0; k < n; k++) deck.push(card);
  return rng.shuffle(deck);
}

/** Wardens `player` still has off the board (alone, all six are the lowest rank). */
export const freeWardens = (s: GameState, player: PlayerId): number => WARDENS_PER_PLAYER - s.wardens.filter((w) => w.owner === player).length;

/** Empty castle edges, for a levy. */
export function levyEdges(s: GameState): number[] {
  const t = topology(s.board);
  if (t.castle === null) return [];
  return s.board.hexes[t.castle].edges.filter((e) => !wardenOn(s, e));
}

/** Any empty edge a warden may stand on, for an outrider. */
export function outriderEdges(s: GameState): number[] {
  const t = topology(s.board);
  return s.board.edges.filter((e) => t.wardenEdge[e.id] && !wardenOn(s, e.id)).map((e) => e.id);
}

/** Coastal hexes with a raider to take prisoner, for an ambush. */
export const ambushHexes = (s: GameState): number[] => topology(s.board).coast.filter((h) => inv(s).raiders[h] > 0);

function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  items.forEach((x, i) => {
    for (const rest of combinations(items.slice(i + 1), k - 1)) out.push([x, ...rest]);
  });
  return out;
}

/** One way to play a turncoat: raiders from these hexes (null: the supply) to these, each list clockwise from the castle. */
interface TurncoatOption {
  from: (number | null)[];
  to: number[];
}

/**
 * Every way to play a turncoat: two raiders from two different coastal hexes to two other coastal
 * hexes not yet conquered, taking from the supply what the board lacks. Where two can't move, as
 * many as can.
 */
export function turncoatOptions(s: GameState): TurncoatOption[] {
  const t = topology(s.board);
  const raiders = inv(s).raiders;
  const raided = t.coast.filter((h) => raiders[h] > 0);
  const spare = unlimitedRaiders(s) ? TURNCOAT_RAIDERS : Math.min(TURNCOAT_RAIDERS, inv(s).supply);
  for (let n = TURNCOAT_RAIDERS; n >= 1; n--) {
    const k = Math.min(n, raided.length);
    if (n - k > spare) continue;
    const out: TurncoatOption[] = [];
    for (const src of combinations(raided, k)) {
      const dests = t.coast.filter((h) => raiders[h] < 3 && !src.includes(h));
      const from = [...src, ...Array<null>(n - k).fill(null)];
      for (const to of combinations(dests, n)) out.push({ from, to });
    }
    if (out.length > 0) return out;
  }
  return [];
}

const optionKey = (from: (number | null)[], to: number[]) =>
  `${from.map((h) => (h === null ? 'supply' : h)).sort().join(',')}>${to.slice().sort((a, b) => a - b).join(',')}`;

/** Whether `card` can do anything for `player` now. */
function cardUsable(s: GameState, player: PlayerId, card: MusterCard): boolean {
  switch (card) {
    case 'levy':
      return freeWardens(s, player) > 0 && levyEdges(s).length > 0;
    case 'outrider':
      return freeWardens(s, player) > 0 && outriderEdges(s).length > 0;
    case 'ambush':
      return ambushHexes(s).length > 0;
    case 'turncoat':
      return true;
  }
}

function draw(ctx: Ctx): MusterCard {
  const i = inv(ctx.s);
  if (i.deck.length === 0) {
    i.deck = ctx.rng.shuffle(i.discard);
    i.discard = [];
  }
  return i.deck.pop()!;
}

/** The muster deck's name where something grants "a development card" (rule 3: seven fish). */
export const MUSTER = 'muster';

/** Whether a muster card is left to draw (the discard is shuffled back when the deck runs out). */
export const musterLeft = (s: GameState): boolean => inv(s).deck.length + inv(s).discard.length > 0;

/** Buy the top muster card and play it: its choice is owed at once (or made, when there is none). */
export function buy(ctx: Ctx, player: PlayerId) {
  const s = ctx.s;
  assert(musterLeft(s), 'The muster deck is empty.');
  assert(canAfford(s, player, 'devCard'), 'You cannot afford a muster card.');
  moveCards(ctx, player, null, COSTS.devCard, 'muster card');
  ctx.emit({ type: 'invasion/bought', player });
  dealMuster(ctx, player);
}

/**
 * `player` takes the top muster card, paid for already or free (seven fish), and plays it as a
 * bought one is played: its choice is owed at once, or made when there is none.
 */
export function dealMuster(ctx: Ctx, player: PlayerId) {
  const s = ctx.s;
  const i = inv(s);
  // (Bounded, in case every card left is one that can do nothing: the card is then lost.)
  for (let k = 0; k < MUSTER_TOTAL; k++) {
    const card = draw(ctx);
    const usable = cardUsable(s, player, card);
    ctx.emit({ type: 'invasion/drew', player, card, wasted: !usable });
    if (!usable) {
      i.discard.push(card);
      continue;
    }
    if (card === 'turncoat' && turncoatOptions(s).length === 0) {
      // Nothing can move: the coins are all it brings.
      i.discard.push(card);
      addCoins(ctx, player, TURNCOAT_COINS, 'turncoat');
      ctx.emit({ type: 'invasion/raidersLed', player, moves: [] });
      return;
    }
    s.pending.push({ kind: 'invasion/card', players: [player], data: { card } satisfies CardPending });
    return;
  }
}

/** The answers to a muster card's decision. */
export function cardAnswers(s: GameState, card: MusterCard): Action[] {
  switch (card) {
    case 'levy':
      return levyEdges(s).map((edge) => ({ type: 'invasion/levy', edge }));
    case 'outrider':
      return outriderEdges(s).map((edge) => ({ type: 'invasion/outrider', edge }));
    case 'ambush':
      return ambushHexes(s).map((hex) => ({ type: 'invasion/ambush', hex }));
    case 'turncoat':
      return turncoatOptions(s).map((o) => ({ type: 'invasion/turncoat', moves: o.from.map((from, k) => ({ from, to: o.to[k] })) }));
  }
}

/** A new lowest-rank warden for `player` on `edge` (alone, wardens are always ready to fight). */
function raiseWarden(ctx: Ctx, player: PlayerId, edge: number, card: 'levy' | 'outrider') {
  const s = ctx.s;
  const id = newWardenId(s);
  s.wardens.push({ id, owner: player, rank: 1, mustered: true, vertex: null, edge, musteredTurn: 0 });
  ctx.emit({ type: 'invasion/wardenRaised', player, warden: id, edge, card });
}

/** Play the owed card as `player` chose. */
export function playCard(ctx: Ctx, player: PlayerId, action: CardAction) {
  const s = ctx.s;
  const i = inv(s);
  const top = s.pending[s.pending.length - 1];
  assert(top?.kind === 'invasion/card' && top.players.includes(player), 'There is no muster card of yours to play.');
  const card = (top.data as CardPending).card;
  assert(action.type === `invasion/${card}`, `Play your ${card}.`);
  // (Every field is checked: an action from the network can carry anything.)
  switch (action.type) {
    case 'invasion/levy': {
      const edge: unknown = action.edge;
      assert(validIndex(edge, s.board.edges.length) && levyEdges(s).includes(edge), 'Choose an empty edge of the castle.');
      raiseWarden(ctx, player, edge, 'levy');
      break;
    }
    case 'invasion/outrider': {
      const edge: unknown = action.edge;
      assert(validIndex(edge, s.board.edges.length) && outriderEdges(s).includes(edge), 'Choose an empty edge on the home island.');
      raiseWarden(ctx, player, edge, 'outrider');
      break;
    }
    case 'invasion/ambush': {
      const hex: unknown = action.hex;
      assert(validIndex(hex, s.board.hexes.length) && ambushHexes(s).includes(hex), 'Choose a coastal hex with a raider on it.');
      i.raiders[hex]--;
      i.prisoners[player]++;
      ctx.emit({ type: 'invasion/captured', player, hex });
      break;
    }
    case 'invasion/turncoat': {
      const moves: unknown = action.moves;
      assert(Array.isArray(moves), 'Invalid moves.');
      const list = Array.from(moves) as unknown[];
      assert(
        list.every((m) => !!m && typeof m === 'object' && ((m as RaiderMove).from === null || validIndex((m as RaiderMove).from, s.board.hexes.length)) && validIndex((m as RaiderMove).to, s.board.hexes.length)),
        'Invalid moves.',
      );
      const ms = list as RaiderMove[];
      const key = optionKey(
        ms.map((m) => m.from),
        ms.map((m) => m.to),
      );
      if (!turncoatOptions(s).some((o) => optionKey(o.from, o.to) === key)) fail('Lead two raiders from two coastal hexes to two others not yet conquered.');
      addCoins(ctx, player, TURNCOAT_COINS, 'turncoat');
      for (const m of ms) {
        if (m.from === null) takeRaider(ctx);
        else i.raiders[m.from]--;
        i.raiders[m.to]++;
      }
      ctx.emit({ type: 'invasion/raidersLed', player, moves: ms.map((m) => ({ from: m.from, to: m.to })) });
      break;
    }
  }
  s.pending.pop();
  i.discard.push(card);
}
