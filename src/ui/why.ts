// Why a control can't be used right now, in words. A greyed-out button only said so in its
// tooltip, which keyboard and touch never see: these reasons go in the button's description,
// and pressing it anyway shows (and reads out) the reason in the error bar.

import { COSTS, RESOURCES, devCardsInGame, placeReason, legalCities, legalRoads, legalSettlements, type GameState, type CardCounts } from '../engine';
import { showError, useUI } from '../game/store';
import { session } from '../app/session';
import { CARD_NAMES } from '../game/names';
import { cardForSale } from '../game/commands';
import { lacking, type ExtraBuild } from '../game/builds';
import { isTouch } from './useCompact';

/** (`build` is the phone's Build button, which opens the sheet of builds whenever the turn is yours to play: each build there says what it lacks.) */
export type ActionKey = 'roll' | 'build' | 'road' | 'settlement' | 'city' | 'dev' | 'trade' | 'bank' | 'end';

/** What a cost still lacks, as "1 brick and 2 wheat" (oil too, for a foundry). */
export function shortfall(have: CardCounts, cost: CardCounts) {
  const parts = lacking(have, cost);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}

/** What the phase is waiting for, when it isn't the time for building or trading. */
function phaseReason(s: GameState, me: number): string {
  switch (s.phase) {
    case 'roll':
      return 'Roll the dice first';
    case 'discard':
      return s.pendingDiscards[me] !== undefined ? 'Choose your cards to discard first' : 'Waiting for players to discard';
    case 'moveRobber':
      return 'Move the robber first';
    case 'steal':
      return 'Choose who to rob first';
    case 'roadBuilding':
      return 'Place your free roads first';
    case 'setupSettlement':
    case 'setupRoad':
      return 'Not while the first houses are placed';
    case 'gameOver':
      return 'The game is over';
    case 'endOfTurn':
      return 'The turn is ending';
    default:
      return 'Not right now';
  }
}

/** Why nothing of yours can be done now (it's not your turn, a move is still showing, a decision is owed), or null. */
function turnBlocked(): string | null {
  const { view: s, me, busy, replay } = useUI.getState();
  if (!s) return 'No game in progress';
  if (replay || session.presenter?.spectating) return 'You are watching this game';
  if (s.phase === 'gameOver') return 'The game is over';
  if (s.currentPlayer !== me) return s.phase === 'discard' ? phaseReason(s, me) : `It's ${s.players[s.currentPlayer].name}'s turn`;
  if (busy) return 'Wait for the last move to finish';
  // (An expansion's decision owed, by you or anyone, holds up everything else.)
  const top = s.pending[s.pending.length - 1];
  if (top) return top.players.includes(me) ? 'Make your decision first' : `Waiting for ${top.players.map((x) => s.players[x].name).join(', ')} to decide`;
  return null;
}

/**
 * Why a move of your own made in `phase` (an expansion's: an improvement, a venture, burning oil)
 * can't be made now, before any reason of the move's own; null when the turn is yours to play.
 */
export function whyNotNow(phase: 'main' | 'roll' = 'main'): string | null {
  const blocked = turnBlocked();
  if (blocked) return blocked;
  const { view: s, me } = useUI.getState();
  if (s!.phase === phase) return null;
  if (phase === 'roll') return s!.phase === 'main' ? 'Only before you roll' : phaseReason(s!, me);
  return phaseReason(s!, me);
}

/** Why `key` can't be done now, or null when it can. */
export function whyNot(key: ActionKey): string | null {
  const blocked = turnBlocked();
  const { view: s, me } = useUI.getState();
  if (blocked || !s) return blocked;
  if (key === 'roll') return s.phase === 'roll' ? null : s.phase === 'main' ? 'You have rolled this turn' : phaseReason(s, me);
  if (s.phase !== 'main') return phaseReason(s, me);
  if (key === 'road' || key === 'settlement' || key === 'city' || key === 'dev') return buildBlock(s, me, key)?.why ?? null;
  return null;
}

type BuildKey = 'road' | 'settlement' | 'city' | 'dev';

/** What stops a build in your turn's main phase, said in full (`why`) and in a few words (`note`), or null. */
function buildBlock(s: GameState, me: number, key: BuildKey): { why: string; note: string } | null {
  const p = s.players[me];
  const need = (cost: CardCounts) => {
    const lack = shortfall(p.hand, cost);
    // (The note names each kind short, "need 1 brick, 1 wood", to fit under a tile.)
    const short = RESOURCES.filter((r) => cost[r] > p.hand[r]).map((r) => `${cost[r] - p.hand[r]} ${CARD_NAMES[r].toLowerCase()}`);
    return lack ? { why: `You need ${lack} more`, note: `need ${short.join(', ')}` } : null;
  };
  const room = (why: string) => ({ why, note: 'no spot' });
  switch (key) {
    case 'road':
      if (p.roadsLeft <= 0) return { why: 'All your roads are built', note: 'all built' };
      return need(COSTS.road) ?? (legalRoads(s, me).length ? null : room(placeReason(s, me, 'road') ?? 'No free edge joins your roads'));
    case 'settlement':
      if (p.settlementsLeft <= 0) return { why: 'All your houses are built: make one a town', note: 'all built' };
      return need(COSTS.settlement) ?? (legalSettlements(s, me).length ? null : room(placeReason(s, me, 'settlement') ?? 'No room: a house needs your road and two edges from any building'));
    case 'city':
      if (p.citiesLeft <= 0) return { why: 'All your towns are built', note: 'all built' };
      return need(COSTS.city) ?? (legalCities(s, me).length ? null : room(placeReason(s, me, 'city') ?? 'No house of yours to make a town'));
    case 'dev':
      // (With Invasion alone, the muster deck stands in at the same price, and never runs dry: played cards go back.)
      if (cardForSale(s) === 'muster') return need(COSTS.devCard);
      if (!devCardsInGame(s)) return { why: 'This game has no development cards', note: 'none here' };
      if (s.devDeck.length === 0) return { why: 'No development cards are left', note: 'none left' };
      return need(COSTS.devCard);
  }
}

/**
 * What a build lacks in a few words, for under its tile in the phone's Build sheet ("need 1
 * wood"), so a greyed tile says why before it is tapped (tapped, it still gives the reason in
 * full). Null when it can be built, or when nothing can be (it isn't your turn to build at all).
 */
export function buildNote(key: BuildKey): string | null {
  if (whyNot('build')) return null;
  const { view: s, me } = useUI.getState();
  return s ? (buildBlock(s, me, key)?.note ?? null) : null;
}

/**
 * Why an expansion's build (game/builds.ts) can't be made now, the turn's reason before the
 * build's own, with the build's in a few words for under its tile (none when it isn't your turn to
 * build at all, as `buildNote`).
 */
export function extraBuildReason(b: ExtraBuild): { why: string | null; note: string | null } {
  const turn = whyNot('build');
  return turn ? { why: turn, note: null } : { why: b.block?.why ?? null, note: b.block?.note ?? null };
}

/** Show why for a moment in the error bar (it is read out too); a newer message is left alone. */
export function explain(reason: string | null) {
  if (reason) showError(reason);
}

/**
 * Why a click on the island missed every spot offered while placing (none when nothing is being
 * placed). A rule an expansion adds says so first (see engine placeReason).
 */
export function missReason(kind: string): string | null {
  const { view: s, me } = useUI.getState();
  const piece = kind === 'road' || kind === 'setupRoad' ? 'road' : kind === 'settlement' || kind === 'setupSettlement' ? 'settlement' : kind === 'city' ? 'city' : null;
  const modular = s && piece ? placeReason(s, me, piece) : null;
  if (modular) return modular;
  switch (kind) {
    case 'road':
      return 'Not there: a road goes on a glowing edge, joined to your roads or houses';
    case 'setupRoad':
      return 'Not there: the road goes on a glowing edge beside the house you just placed';
    case 'settlement':
      return 'Not there: a house goes on a glowing corner, joined to your road and two edges from any building';
    case 'setupSettlement':
      return 'Not there: a house goes on a glowing corner, two edges from any other building';
    case 'city':
      return 'Not there: choose one of your glowing houses to make it a town';
    case 'robber':
      return 'Not there: move the robber to any other hex';
    default:
      return null;
  }
}

/** What to do while choosing where to build. */
export function placingText(kind: 'road' | 'settlement' | 'city', free = false) {
  const touch = isTouch();
  const pick = touch ? 'Tap' : 'Choose';
  if (kind === 'road' && free) return `Place your free roads: ${pick.toLowerCase()} a glowing edge`;
  const what = kind === 'road' ? `${pick} a glowing edge for your road` : kind === 'settlement' ? `${pick} a glowing corner for your house` : `${pick} one of your houses to make it a town`;
  return touch ? what : `${what} (or the arrow keys, then Enter). Esc or right-click cancels`;
}
