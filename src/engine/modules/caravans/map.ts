// The oasis on the home island (rule 10): it takes the desert's place at the island's centre, and
// its trains start from three alternate corners.

import { type BoardSpec, type HexSpec } from '../../board';
import { centralHex, coastOf, featureHexes, hasRed, homeLand, neighboursIn, rehome } from '../../maps/shape';
import type { Rng } from '../../rng';

/** The oasis's train origins: its upper-left, upper-right and bottom corners (corners run clockwise from the top: N 0 … NW 5). */
export const ORIGIN_CORNERS = [5, 1, 3];

/**
 * Put the oasis at the centre of the home island (the classic island's middle hex). The desert
 * leaves the game: whatever stood at the centre moves to the desert's place with its number, so the
 * rest of the island is as the layout dealt it. Without a desert (another module took it), or with
 * the desert on a coast Invasion has numbered, the centre's numbers move by rule 5 instead.
 */
export function shapeOasis(spec: BoardSpec, rng: Rng) {
  const home = homeLand(spec);
  const taken = featureHexes(spec);
  const centre = centralHex(home, (h) => !taken.has(h));
  if (!centre) return;
  const near = neighboursIn(spec);
  const coastal = coastOf(spec, home);
  const desert = home.find((h) => h.terrain === 'desert' && !(spec.castle && coastal(h)));
  if (desert && desert !== centre) {
    [desert.terrain, centre.terrain] = [centre.terrain, desert.terrain];
    [desert.numbers, centre.numbers] = [centre.numbers, desert.numbers];
    // (Along the spiral the centre always holds the 11; a balanced deal can put a red number
    // there, and in the desert's place it may touch another red: it trades numbers with a hex
    // where it can't.)
    if (hasRed(desert) && near(desert).some(hasRed)) {
      // A partner holds one number, not red, and touches no red but the hex it trades with.
      const ok = home.filter((h) => h !== desert && !taken.has(h) && h.numbers.length === 1 && !hasRed(h) && !near(h).some((n) => n !== desert && hasRed(n)));
      if (ok.length > 0) {
        const other = ok[rng.int(ok.length)];
        [desert.numbers, other.numbers] = [other.numbers, desert.numbers];
      }
    }
  } else if (!desert && centre.numbers.length > 0) {
    const displaced = centre.numbers;
    centre.numbers = [];
    rehome(spec, displaced, new Set<HexSpec>([centre]));
  }
  centre.terrain = 'oasis';
  centre.numbers = [];
  spec.oasis = { at: [centre.q, centre.r], corners: [...ORIGIN_CORNERS] };
}
