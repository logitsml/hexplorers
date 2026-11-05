// Not a look of its own: the bookkeeping that lets a polluted hex's scorch creep over its edges
// into its neighbours (see materials.ts edgeScorch). With each board it tells the terrain which
// hex lies across each side of each tile, and each frame whether anything is polluted at all (so
// a clean island never looks over its edges).

import { SIDE_DIRS } from '../../../engine/board';
import { MAX_TILES } from '../materials';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import type { LifeContext, LifeModule } from './common';

export class ScorchEdges implements LifeModule {
  constructor(private ctx: LifeContext) {}

  plan(_tiles: TileInfo[]): Reserved {
    return [];
  }

  build() {
    const { effects, tiles } = this.ctx;
    // (Only the rows of the tiles given: the fog builds sets of its own, a preview of the hidden
    // hexes and the island with a found one, and only the latter has every tile's true neighbours.)
    const at = new Map(tiles.tiles.map((t) => [`${t.hex.q},${t.hex.r}`, t.hex.id]));
    for (const t of tiles.tiles) {
      if (t.hex.id >= MAX_TILES) continue;
      const ids = SIDE_DIRS.map(([dq, dr]) => {
        const n = at.get(`${t.hex.q + dq},${t.hex.r + dr}`);
        return n !== undefined && n < MAX_TILES ? n : -1;
      });
      effects.sideValues[t.hex.id * 2].set(ids[0], ids[1], ids[2], ids[3]);
      effects.sideValues[t.hex.id * 2 + 1].set(ids[4], ids[5], -1, -1);
    }
  }

  update() {
    const fx = this.ctx.effects;
    fx.anyScar.value = fx.scarValues.some((v) => v > 0.001) ? 1 : 0;
  }

  produce() {}

  /** (The table is the next board's to fill: a fog module let go must not wipe the island's.) */
  dispose() {}
}
