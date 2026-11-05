// Names the table and the panels share, defined once so the log, the banners, the chips and the
// screen-reader news all say the same thing: the guild tracks, the Almanac's happenings (a title,
// and what each does in this game's mix), and which blockers a 7 stirs.

import type { GameState, Track } from '../engine';
import type { Happening } from '../engine/modules/almanac/types';

export const TRACK_NAMES: Record<Track, string> = { learning: 'Learning', commerce: 'Commerce', statecraft: 'Statecraft' };

/** The blockers a 7 moves in this game, by the mix (Invasion takes the robber away, and the corsair unless a game keeps it). */
export function sevenBlockers(s: GameState): ('robber' | 'corsair')[] {
  const m = s.options.modules;
  const robber = !m.includes('invasion');
  const corsair = m.includes('sea') && (robber || !!s.options.knobs.corsairStays);
  return [...(robber ? ['robber' as const] : []), ...(corsair ? ['corsair' as const] : [])];
}

/** Whether the raider fleet still holds the blockers off the board (until its first attack). */
export const blockersHeld = (s: GameState): boolean => s.options.modules.includes('fleet') && s.ext.fleet?.attacks === 0;

const HAPPENING_NAMES: Record<Happening, string> = {
  fairDay: 'Washing Day',
  calmSeas: 'Mirror Bay',
  quarrel: 'Tug-of-War',
  quake: 'The Road Splits',
  sickness: 'The Physician Calls',
  gifts: 'Over the Fence',
  helpingHand: 'Shoulder to the Wheel',
  harvest: 'Harvest Home',
  robberFlees: 'Hue and Cry',
  tournament: 'The Joust',
  windfall: 'The Fallen Purse',
  thieves: 'Granary Thieves',
};

/**
 * A happening's name, as this game has it. (Hue and Cry chases off the robber, or the corsair where
 * Invasion has done away with the robber: its line says which.)
 */
export function happeningName(_s: GameState, h: Happening): string {
  return HAPPENING_NAMES[h];
}

/** What a happening does, in a sentence (as this game's modules have it). */
export function happeningLine(s: GameState, h: Happening): string {
  const wardens = s.options.modules.includes('garrisons') || s.options.modules.includes('invasion');
  const army = wardens ? 'the greatest warden strength' : 'the biggest army';
  switch (h) {
    case 'fairDay':
      return 'Nothing out of the ordinary.';
    case 'calmSeas':
      return 'Whoever has the most buildings on harbours takes a resource.';
    case 'quarrel':
      return `Whoever has ${army} robs anyone of a card.`;
    case 'quake':
      return 'Everyone cracks a road: no new routes until it is mended.';
    case 'sickness':
      return 'Towns take one resource from each hex, and no commodity.';
    case 'gifts':
      return 'Everyone passes a card to the player on their left.';
    case 'helpingHand':
      return 'The leaders each give a card to someone with fewer points.';
    case 'harvest':
      return 'Everyone takes a resource of their choice.';
    case 'robberFlees':
      // (The engine sends him to a desert, else a swamp, else off the board.)
      return s.options.modules.includes('invasion') ? 'The corsair leaves the board until the next 7.' : 'The robber retreats to a desert, or a swamp if there is none, stealing nothing.';
    case 'tournament':
      return `Whoever has ${army} takes a resource.`;
    case 'windfall':
      return 'Whoever holds the longest route robs anyone of a card.';
    case 'thieves': {
      // (While the raider fleet holds them off the board, a 7 moves nothing.)
      const b = blockersHeld(s) ? [] : sevenBlockers(s);
      const moves = b.length === 2 ? 'the robber or the corsair moves' : b.length === 1 ? `the ${b[0]} moves` : '';
      return moves ? `A 7: ${moves} and big hands lose half.` : 'A 7: big hands lose half.';
    }
  }
}

/** The Almanac's line when the Augury named a 7: the card's happening is passed over. */
export const AUGURY_SEVEN = 'The Augury named a 7, so this card’s happening is passed over.';

/** Every happening (for the reasons a happening's card moves give). */
export const HAPPENINGS = Object.keys(HAPPENING_NAMES) as Happening[];
