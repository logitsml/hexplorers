// The drawn maps (maps/outline.ts): each a drawing of its home island, islets and fog, everything
// on it dealt each game by the home island's rules (docs/maps.md). Each layout is our own, drawn to
// general principles of a fair map rather than copied from any other. The islets and the fog keep
// to the three sides furthest from the castle's corner (the lower left), one sea hex off the home
// coast, and no land lies more than five steps from the middle.

import type { Outline } from './outline';

export const DRAWN: Record<string, Outline> = {
  // The classic island's nineteen hexes in three long rows: two more coastal hexes than the
  // classic island, so more harbours within reach and the roads racing along its length.
  longIsle: {
    art: `
 o o o o o o
o o o o o o o
 o o o o o o
`,
  },
  // Two lobes joined by a neck of two hexes, where the longest route is won or cut.
  isthmus: {
    art: `
 o o o
o o o o
 o o o o o o
      o o o o
       o o o
`,
  },
  // A ring of land round a bay open to the south: an inner coast and an outer one.
  horseshoe: {
    art: `
  o o o o o
 o o o o o o
o o o     o o
 o o       o
`,
  },
  // One large islet across a strait to the north-east, holding both bounty fields.
  strait: {
    art: `
     i i
    i i i i
         i
  o o o
 o o o o
o o o o o
 o o o o
  o o o
`,
  },
  // Two islets of four, one to the north-west and one to the east.
  twinIsles: {
    art: `
 i
i i
 i
    o o o
   o o o o   i i
  o o o o o   i i
   o o o o
    o o o
`,
  },
  // A bank of fog across the far half of the sea, a sea hex off the home coast.
  fogBank: {
    art: `
  ? ? ? ? ? ?
 ?           ?
?   o o o   ? ?
   o o o o   ?
  o o o o o   ?
   o o o o   ?
    o o o   ?
`,
  },
  // Patches of fog all round the island, open water between them.
  lostSea: {
    art: `
    ? ?     ?
             ?
      o o o
 ?   o o o o
?   o o o o o   ?
     o o o o   ?
      o o o
   ?
    ?     ? ?
`,
  },
  // The All Hands map (docs/all-hands.md): the classic island, and islets of three, five and three
  // to the north, east and south-east.
  allHands: {
    art: `
   i
  i i
         i
  o o o   i
 o o o o   i
o o o o o   i
 o o o o   i
  o o o
         i i
          i
`,
  },
};
