// The Almanac's deck: 36 cards, one per result of two dice, each with a happening, and the new year.
//
// Every card comes up equally often, so a happening's number decides only what
// it meets: the Physician calling on a 2 would see almost nobody. Each happening other than Washing
// Day sits on one mirrored pair of cards, (a, b) and (7-a, 7-b), whose totals n and 14-n are
// equally likely, and Washing Day takes one pair on every number, so no number carries a happening
// twice. Card by card (first die, second die), with the higher numbers mirroring the lower:
//
//   | Number | Cards                     | Happenings, in the same order                               |
//   |--------|---------------------------|-------------------------------------------------------------|
//   | 2      | 1-1                       | Washing Day                                                 |
//   | 3      | 1-2, 2-1                  | Washing Day, Harvest Home                                   |
//   | 4      | 1-3, 2-2, 3-1             | Washing Day, Mirror Bay, The Joust                          |
//   | 5      | 1-4, 2-3, 3-2, 4-1        | Washing Day, Shoulder to the Wheel, Tug-of-War, The         |
//   |        |                           | Fallen Purse                                                |
//   | 6      | 1-5, 2-4, 3-3, 4-2, 5-1   | Washing Day, The Physician Calls, The Road Splits, Over     |
//   |        |                           | the Fence, Hue and Cry                                      |
//   | 7      | all six                   | Granary Thieves                                             |
//   | 8-12   | (a, b) on 14-n            | as (7-a, 7-b) on n: 6-2 Washing Day, 5-3 The Physician      |
//   |        |                           | Calls, 4-4 The Road Splits, 3-5 Over the Fence, 2-6 Hue     |
//   |        |                           | and Cry, and so on                                          |
//
// That is ten Washing Days, two of each of the ten other happenings and six Granary Thieves. The
// Physician Calls and Hue and Cry sit on the busiest numbers, where they bite; Harvest Home on the
// lean 3 and 11, where it consoles.

import type { Ctx } from '../../ctx';
import type { Happening } from './types';

/** The new year's place in the deck. */
export const NEW_YEAR = 36;

/** Cards dealt under the new year: they never come up before the deck is rebuilt. */
export const UNDER_NEW_YEAR = 5;

/** A card's dice. */
export const cardDice = (card: number): [number, number] => [1 + Math.floor(card / 6), 1 + (card % 6)];

/** The happenings on each number from 2 to 6, in the order of the first die (1 up); 8-12 mirror them. */
const LOW_HALF: Record<number, Happening[]> = {
  2: ['fairDay'],
  3: ['fairDay', 'harvest'],
  4: ['fairDay', 'calmSeas', 'tournament'],
  5: ['fairDay', 'helpingHand', 'quarrel', 'windfall'],
  6: ['fairDay', 'sickness', 'quake', 'gifts', 'robberFlees'],
};

/** Each card's happening, by card. */
export const HAPPENINGS: readonly Happening[] = Array.from({ length: 36 }, (_, card) => {
  const [a, b] = cardDice(card);
  const total = a + b;
  if (total === 7) return 'thieves';
  // A card on 8-12 carries its mirror's happening: (a, b) mirrors (7-a, 7-b).
  return total < 7 ? LOW_HALF[total][a - 1] : LOW_HALF[14 - total][7 - a - 1];
});

/** Shuffle all 36 cards, deal five, lay the new year on them and the rest on top (top last). */
export function buildDeck(shuffle: <T>(cards: T[]) => T[]): number[] {
  const cards = shuffle(Array.from({ length: 36 }, (_, i) => i));
  return [...cards.slice(0, UNDER_NEW_YEAR), NEW_YEAR, ...cards.slice(UNDER_NEW_YEAR)];
}

/** Draw until a card that isn't the new year, rebuilding the deck each time the new year comes up. */
export function drawCard(ctx: Ctx): number {
  const st = ctx.s.ext.almanac!;
  for (;;) {
    const card = st.deck.pop()!;
    if (card !== NEW_YEAR) return card;
    st.deck = buildDeck((cards) => ctx.rng.shuffle(cards));
    ctx.emit({ type: 'almanac/newYear' });
  }
}
