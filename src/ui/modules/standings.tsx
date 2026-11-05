// What every seat holds that the expansions count, as the table sees it: coins (and the rivers'
// wealth tile they win or lose), fish tokens and the Soggy Boot, prisoners, defence tokens, and in a
// game whose development cards the guilds replace, the ventures held. All of it is public (coins
// by the engine's own account; fish tokens and a venture hand only by their number), so it goes on
// every player's card, beside the resource cards and routes: the Richest and Pauper tiles turn on who has most
// and fewest coins, which you can only judge with everyone's coins in view.

import type { GameState, PlayerId } from '../../engine';
import { tokensOf } from '../../game/holdings';
import { TOKEN_ICON, AWARD_ART, SEAT_ART, TRACK_ICON } from '../../game/names';
import { count } from '../../game/modulePanels';
import { TRACK_NAMES } from '../../game/tableWords';
import { SEAT_POINTS, TRACKS, TRADER_POINTS, seatHolder } from '../../engine/modules/guilds/rules';
import { pauperPoints } from '../../engine/modules/rivers/queries';
import { HARBOUR_AWARD_POINTS } from '../../engine/modules/harbourmaster/points';

/** One thing a seat holds: its painted token, how many, and its name (on hover and for screen readers). */
export interface Standing {
  key: string;
  icon: string;
  n: number;
  label: string;
}

/** What `seat` holds that the expansions count, each as its token and a number. */
export function standingsOf(s: GameState, seat: PlayerId): Standing[] {
  const out: Standing[] = [];
  // Coins, fish and prisoners as every view of a hand names them (game/holdings.ts). Fish tokens
  // lie face down: how many a seat holds is public, what they're worth isn't, so every card counts
  // tokens, as the resource stat counts cards; your own values are in your hand.
  for (const t of tokensOf(s, seat, false)) if (t.id !== 'prisoner' || t.n > 0) out.push({ key: t.id, icon: t.icon, n: t.n, label: t.label });
  const defence = s.ext.fleet?.tokens[seat] ?? 0;
  if (defence > 0) out.push({ key: 'defence', icon: TOKEN_ICON.defence, n: defence, label: `${count(defence, 'defence token')} (a point each)` });
  return out;
}

/**
 * What a seat holds that changes hands and moves its points or what it needs to win, as its badge:
 * the Port Captain and Steward awards, a guild seat, the trader, the rivers' Richest (+1) or
 * Pauper (−1) tile, the Soggy Boot.
 */
export interface Mark {
  key: string;
  icon: string;
  text: string;
  label: string;
  tone: 'good' | 'bad';
}

export function marksOf(s: GameState, seat: PlayerId): Mark[] {
  const out: Mark[] = [];
  if (s.ext.harbourmaster?.holder === seat) out.push({ key: 'harbourmaster', icon: AWARD_ART.harbourmaster, text: `Port Captain +${HARBOUR_AWARD_POINTS}`, label: `The Port Captain award: the most points on harbours, +${HARBOUR_AWARD_POINTS} victory points`, tone: 'good' });
  if (s.ext.oil?.steward === seat) out.push({ key: 'steward', icon: AWARD_ART.steward, text: 'Steward +1', label: 'The Steward: the most oil sequestered, +1 victory point', tone: 'good' });
  const g = s.ext.guilds;
  if (g) {
    for (const t of TRACKS) {
      if (seatHolder(s, t) !== seat) continue;
      const kept = g.seatsForGood.includes(t) ? ', held for good' : ' (the first to reach level 5 takes it for good)';
      out.push({ key: `seat-${t}`, icon: SEAT_ART[t], text: `${TRACK_NAMES[t]} seat +${SEAT_POINTS}`, label: `The ${TRACK_NAMES[t]} seat: +${SEAT_POINTS} victory points on its town${kept}`, tone: 'good' });
    }
    if (g.trader?.owner === seat) out.push({ key: 'trader', icon: TRACK_ICON.commerce, text: `Trader +${TRADER_POINTS}`, label: `The Trader: +${TRADER_POINTS} victory point while held, and its hex’s resource traded 2:1`, tone: 'good' });
  }
  const rivers = s.ext.rivers;
  if (rivers?.richest === seat) out.push({ key: 'richest', icon: AWARD_ART.richest, text: 'Richest +1', label: 'The Richest tile: the most coins, +1 victory point', tone: 'good' });
  if (rivers?.paupers.includes(seat)) out.push({ key: 'pauper', icon: AWARD_ART.pauper, text: `Pauper −${pauperPoints(s)}`, label: `A Pauper tile: the fewest coins, −${pauperPoints(s)} victory points`, tone: 'bad' });
  if (s.ext.fisheries?.boot === seat) out.push({ key: 'boot', icon: TOKEN_ICON.boot, text: 'Soggy Boot', label: 'The Soggy Boot: a point more to win', tone: 'bad' });
  return out;
}

/** How many ventures a seat holds, when the guilds are in play (the count is public; the cards aren't). */
export function venturesHeld(s: GameState, seat: PlayerId): number | null {
  return s.ext.guilds ? (s.ext.guilds.hands[seat]?.length ?? 0) : null;
}

/** A venture card, drawn small for the player cards' stats (the guilds' stand-in for the development card's icon). */
export function VentureGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg className="ui-icon venture-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="5.5" y="2.5" width="13" height="19" rx="2.4" transform="rotate(8 12 12)" fill="#c9a96e" stroke="#6b4a26" strokeWidth="1.2" />
      <rect x="4.5" y="2.5" width="13" height="19" rx="2.4" fill="#f6ead0" stroke="#6b4a26" strokeWidth="1.4" />
      <rect x="6.6" y="4.6" width="8.8" height="8" rx="1" fill="#6f93b5" />
      <path d="M6.6 10.6l2.6-2.4 2 1.6 1.7-1.3 2.5 2.1v2H6.6z" fill="#5d7b3a" />
      <path d="M7 15.6h8M7 18h5.6" stroke="#8a6a42" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
