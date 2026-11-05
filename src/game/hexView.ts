// How a hex looks to the person at the table: the one place the words (tooltips, the screen
// reader's island, spot descriptions, log lines, the panels' "the 5 hills") learn what a hex is.
//
// The state the interface holds is the host's own, so it still knows what lies under the fog and
// carries printed numbers that production no longer honours. The island and the flat map draw the
// board as a player sees it (see render/board/fog.ts `shownBoard`: face-down hexes as open water),
// and text must say no more than they show. Reading `hex.terrain` or `hex.numbers` for a sentence
// leaks a hidden hex's terrain and resource, and misstates a revealed one (the number it drew from
// the face-down discs is not printed on it, and pollution takes printed numbers away): ask here.

import { TERRAIN_RESOURCE, isLand, numbersOf, pipsOf, type GameState, type Resource, type Terrain } from '../engine';
import { isHidden } from '../engine/modules/sea/rules';
import { TERRAIN_NAMES } from './names';

interface SeenHex {
  id: number;
  /** Still face down: nobody has found what lies under the fog (which is the same for every seat). */
  hidden: boolean;
  /** What it shows as: open water while face down, so never the terrain beneath. */
  terrain: Terrain;
  /** Whether it shows as land. */
  land: boolean;
  /** What it produces, as far as anyone can tell (none for a hidden hex). */
  resource: Resource | null;
  /** The production numbers it bears now: the fog's drawn one in, the ones pollution took out. */
  numbers: number[];
  /** Its production chance in pips, from those numbers. */
  pips: number;
  /** Its name as a title: "Unexplored", "Fishing ground", "Hills". */
  label: string;
  /** Its name in a sentence: "unexplored hex", "fishing ground", "open sea", "hills". */
  kind: string;
}

/** Hex `id` as the human seat sees it in `state`. */
export function seenHex(state: GameState, id: number): SeenHex {
  if (isHidden(state, id)) {
    return { id, hidden: true, terrain: 'sea', land: false, resource: null, numbers: [], pips: 0, label: 'Unexplored', kind: 'unexplored hex' };
  }
  const hex = state.board.hexes[id];
  const numbers = numbersOf(state, hex);
  // (A fishing ground is a sea hex that was printed with numbers, and stays one when pollution takes them all.)
  const fishing = hex.terrain === 'sea' && hex.numbers.length > 0;
  return {
    id,
    hidden: false,
    terrain: hex.terrain,
    land: isLand(hex.terrain),
    resource: TERRAIN_RESOURCE[hex.terrain],
    numbers,
    pips: numbers.reduce((sum, n) => sum + pipsOf(n), 0),
    label: fishing ? 'Fishing ground' : TERRAIN_NAMES[hex.terrain],
    kind: fishing ? 'fishing ground' : hex.terrain === 'sea' ? 'open sea' : TERRAIN_NAMES[hex.terrain].toLowerCase(),
  };
}

/** A hex in words, by its numbers and kind: "the 5 hills", "the oasis", "the unexplored hex". */
export function hexPlace(s: GameState, h: number): string {
  const { numbers, kind } = seenHex(s, h);
  return `the ${numbers.length ? `${numbers.join('/')} ` : ''}${kind}`;
}

/** Where an edge lies, in words: "between the 5 hills and the 9 forest", "on the shore of the 6 fields". */
export function edgePlace(s: GameState, e: number): string {
  // (Land as it shows: a face-down hex is open water until a route reaches it.)
  const land = s.board.edges[e].hexes.filter((h) => seenHex(s, h).land);
  if (land.length === 0) return 'out at sea';
  if (land.length === 1) return `on the shore of ${hexPlace(s, land[0])}`;
  return `between ${hexPlace(s, land[0])} and ${hexPlace(s, land[1])}`;
}
