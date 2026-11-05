// Why a venture has nothing to do, in words. It lives beside the cards rather than in the panel,
// so it can't drift from the options the engine offers (the legal actions and the bots read
// those), and a test holds the two together: a reason comes back exactly when a card's options
// are empty.

import { RESOURCES, type CardCounts, type GameState, type PlayerId } from '../../types';
import { legalCities, freeRouteOpen } from '../../rules';
import { WALL_LIMIT, invaded, wallsOf, wardensOf } from '../garrisons/wardens';
import type { VentureId } from './types';
import { VENTURES, coastBuildings, openRoad, townCost } from './ventures';

/** What `cost` still lacks of `have`, as "1 brick and 2 wheat" (empty when nothing). */
export function lacking(have: CardCounts, cost: Partial<CardCounts>): string {
  const parts = RESOURCES.filter((r) => (cost[r] ?? 0) > have[r]).map((r) => `${(cost[r] ?? 0) - have[r]} ${r}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}

/**
 * Why `card` has nothing to do for `player` just now, or null when it has a way to be played.
 * This is the card's own reason (the one its options came back empty for); whose turn it is and
 * which phase belong to the caller. A hoist is never played on its own, so it always has one.
 */
export function ventureIdleReason(s: GameState, player: PlayerId, card: VentureId): string | null {
  const def = VENTURES[card];
  if (!def.options) return 'Spent with an improvement, for one commodity less';
  if (def.options(s, player).length > 0) return null;
  const hand = s.players[player].hand;
  switch (card) {
    case 'masonry':
      if (wallsOf(s, player) >= WALL_LIMIT) return `All ${WALL_LIMIT} of your walls are standing`;
      return s.buildings.some((b) => b?.owner === player && b.kind === 'city') ? 'Every town of yours has a wall' : 'You have no town to wall';
    case 'resurvey':
      return 'No two number discs can be swapped';
    case 'townPlanning': {
      const lack = lacking(hand, townCost(s));
      if (lack) return `You need ${lack} more`;
      return legalCities(s, player).length ? 'Nothing to raise' : 'No house of yours to raise';
    }
    case 'salvage':
      return coastBuildings(s, player) > 0 ? 'The supply has no resources left' : 'None of your buildings stands on the coast';
    case 'stockpile':
      return 'The supply has no commodities left';
    case 'tradeWind':
      return 'The trade wind is already up this turn';
    case 'lighthouse':
      return 'You have no land hex to light that is not lit already';
    case 'pathfinders':
    case 'pilot':
      return freeRouteOpen(s, player) ? 'Nothing to build' : 'Nowhere to build a free road';
    case 'forge':
      return wardensOf(s, player).some((w) => w.vertex !== null || w.edge !== null) ? 'No warden of yours can be promoted' : 'You have no warden on the board';
    case 'barter':
      if (!RESOURCES.some((r) => hand[r] > 0)) return 'You have no resource to offer';
      return 'Nobody else holds a commodity';
    case 'tribute':
      return 'Nobody with more points has a card to take';
    case 'trader':
      return 'No hex beside your buildings can take the trader';
    case 'charterFleet':
      return 'Everything is chartered already this turn';
    case 'rightOfWay':
      // (Open roads that all lie on a river need a coin to take up.)
      return s.routes.some((_, edge) => openRoad(s, edge)) ? 'Taking a road off a river costs a coin' : 'No open road or ship to remove';
    case 'rally':
      return 'No warden of yours is waiting to be mustered';
    case 'spymaster':
      return 'Nobody else holds a venture';
    case 'agitators':
      return invaded(s) ? 'No raiders on the island' : "No opponent's warden stands beside your routes";
    case 'taxCollectors':
      return 'Nowhere to send the tax collectors';
    case 'treachery':
      return 'Nobody else has a warden on the board';
    default:
      return 'Nothing for it to do right now';
  }
}
