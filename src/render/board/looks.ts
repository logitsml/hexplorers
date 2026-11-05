// What each hex is drawn as. The sea is left to the ocean (it is never a tile); every land terrain
// is its own look, the expansions' five as much as the classic six: the bounty field, the swamp,
// the lake, the oasis and the castle's rise each have their own ground (terrain.ts), growth
// (decor.ts) and life (life/*.ts).

import { isLand, type Board, type Hex, type Terrain } from '../../engine';

/** A look: how a land hex is drawn. */
export type Look = Exclude<Terrain, 'sea'>;

/** The hex's look, or null for the sea. */
export const lookOf = (t: Terrain): Look | null => (t === 'sea' ? null : t);

/**
 * Looks that yield nothing of their own, so a blocker on them blights nothing: no crows gather
 * over the desert, a swamp, the oasis or the castle's rock.
 */
export const barren = (look: Look | null) => look === 'desert' || look === 'swamp' || look === 'oasis' || look === 'castle';

const landCache = new WeakMap<Board, Hex[]>();

/** The hexes drawn as tiles: the land, which the board numbers first (see buildBoard), so a tile's index is its hex's id. */
export function landHexes(board: Board): Hex[] {
  let land = landCache.get(board);
  if (!land) {
    land = board.hexes.filter((h) => isLand(h.terrain));
    landCache.set(board, land);
  }
  return land;
}
