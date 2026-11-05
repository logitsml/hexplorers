// The maps a game can be played on: their names, what each is like and its own points target.
// deal.ts deals them, from the drawn maps (atlas.ts) and the generators; the classic island
// ('classic') is laid out by board.ts.

import type { ModuleId } from '../types';

interface MapInfo {
  /** Its name on the set-up page. */
  name: string;
  /** Its name in a sentence ("on the classic island"). */
  called: string;
  /** What makes it play differently, in a line for the rules and the set-up page. */
  about: string;
  /** What its sea is played for (a sea map's): First Landing on its islets, or Fog. */
  play?: 'landing' | 'fog';
  /** The modules it needs. */
  needs: ModuleId[];
  /** Its objective's own target (rule 9; the classic island's is 10). */
  target: number;
}

export const MAP_INFO: Record<string, MapInfo> = {
  // (The classic island is laid out by board.ts, not built here, but it is a map like the others.)
  classic: { name: 'Classic island', called: 'the classic island', about: 'the familiar island of nineteen hexes', needs: [], target: 10 },
  longIsle: { name: 'Long Isle', called: 'Long Isle', about: 'nineteen hexes in three long rows: more coast and harbours within reach, and roads racing along it', needs: [], target: 10 },
  isthmus: { name: 'The Isthmus', called: 'the Isthmus', about: 'two lobes joined by a neck of two hexes, where the longest route is won or cut', needs: [], target: 10 },
  horseshoe: { name: 'Horseshoe', called: 'the Horseshoe', about: 'a ring of land round a bay, with an inner coast and an outer one', needs: [], target: 10 },
  wild: { name: 'Wild island', called: 'a wild island', about: 'nineteen hexes grown from the middle, a new shape every game', needs: [], target: 10 },
  archipelago: { name: 'Archipelago', called: 'the archipelago', about: 'three islets across the water, a new spread every game, played for First Landing', play: 'landing', needs: ['sea'], target: 14 },
  strait: { name: 'The Strait', called: 'the Strait', about: 'one large islet across a strait, holding both bounty fields, played for First Landing', play: 'landing', needs: ['sea'], target: 12 },
  twinIsles: { name: 'Twin Isles', called: 'Twin Isles', about: 'two islets of four on either hand, played for First Landing', play: 'landing', needs: ['sea'], target: 13 },
  fogBank: { name: 'Fog Bank', called: 'the Fog Bank', about: 'a bank of fog across the far half of the sea, found by ships, played for Fog', play: 'fog', needs: ['sea'], target: 12 },
  lostSea: { name: 'The Lost Sea', called: 'the Lost Sea', about: 'patches of fog all round the island, played for Fog', play: 'fog', needs: ['sea'], target: 12 },
  allHands: { name: 'All Hands', called: 'the All Hands archipelago', about: 'islets of three, five and three on the far sides, played for First Landing', play: 'landing', needs: ['sea'], target: 14 },
};
