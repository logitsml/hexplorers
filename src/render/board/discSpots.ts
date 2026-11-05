// Where a hex's number discs stand, shared by the discs themselves (tokens.ts), the terrain that
// keeps their ground clear and flat (terrain.ts, which also runs in the terrain workers, so this
// file stays free of three and the DOM) and the lake's rafts (life/lake.ts).

import type { Terrain } from '../../engine';

/** A number disc's radius at full size. */
export const TOKEN_RADIUS = 0.215;

export interface DiscSpot {
  x: number;
  z: number;
  /** The disc's scale. */
  s: number;
}

/**
 * The lake's four discs float in the middle of the lake, on rafts moored together round an islet
 * there, in a square like any hex's four: they sit where a hex's numbers are looked for, and the
 * open water round them stays wide for the ducks, the boat and the jetty. In the square's order:
 * back left, back right, front left, front right.
 */
const LAKE_SPOTS: DiscSpot[] = [0, 1, 2, 3].map((i) => ({ x: (i % 2 ? 1 : -1) * 0.16, z: (i < 2 ? -1 : 1) * 0.16, s: 0.6 }));
/** The islet in the lake's middle that the rafts are moored to (and the robber stands on). */
export const LAKE_ISLET_RADIUS = 0.06;

/**
 * Where each of `n` discs on one hex stands about its centre, and how large: one in the middle;
 * two side by side; three in a triangle; four in a square (or, on the lake, out on its water).
 * Smaller as there are more, so the cluster stays on the ground the terrain keeps for it.
 */
export function discSpots(n: number, terrain?: Terrain): DiscSpot[] {
  // (The lake keeps its rafts when pollution takes some of its numbers: the rest stay afloat.)
  if (terrain === 'lake' && n >= 1 && n <= 4) return LAKE_SPOTS.slice(0, n);
  if (n <= 1) return [{ x: 0, z: 0, s: 1 }];
  if (n === 2) return [-1, 1].map((k) => ({ x: k * 0.188, z: 0, s: 0.83 }));
  if (n === 3)
    return [-90, 30, 150].map((a) => ({ x: Math.cos((a * Math.PI) / 180) * 0.2, z: Math.sin((a * Math.PI) / 180) * 0.2 + 0.02, s: 0.76 }));
  const s = 0.66;
  const d = TOKEN_RADIUS * s + 0.012;
  return Array.from({ length: n }, (_, i) => ({ x: (i % 2 ? 1 : -1) * d, z: (Math.floor(i / 2) % 2 ? 1 : -1) * d, s }));
}
