// A small picture of a map: its land in the terrain colours on a blue sea, for the library and the
// set-up page (a custom map, or one deal of a map the game deals).

import { hexCenter } from '../../engine/board';
import { isLand } from '../../engine/constants';
import type { CellTerrain } from '../../engine/maps/custom';
import type { Terrain } from '../../engine/types';
import { FILL } from '../FlatBoard';

/** What a thumbnail needs of a map: its cells, and which lie face down. */
export interface ThumbMap {
  hexes: readonly { q: number; r: number; terrain: CellTerrain | Terrain; hidden?: boolean }[];
}

const CORNERS = Array.from({ length: 6 }, (_, i) => {
  const a = ((-90 + 60 * i) * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
});

export function MapThumb({ map, size = 96 }: { map: ThumbMap; size?: number }) {
  const cells = map.hexes.map((h) => ({ h, c: hexCenter(h.q, h.r) }));
  const xs = cells.map(({ c }) => c[0]), zs = cells.map(({ c }) => c[1]);
  const [x0, x1, z0, z1] = cells.length ? [Math.min(...xs) - 1, Math.max(...xs) + 1, Math.min(...zs) - 1.1, Math.max(...zs) + 1.1] : [-1, 1, -1, 1];
  return (
    <svg className="map-thumb" width={size} height={size} viewBox={`${x0} ${z0} ${x1 - x0} ${z1 - z0}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {cells.map(({ h, c: [x, z] }) => (
        <polygon
          key={`${h.q},${h.r}`}
          points={CORNERS.map(([dx, dz]) => `${(x + dx * 0.98).toFixed(2)},${(z + dz * 0.98).toFixed(2)}`).join(' ')}
          fill={h.terrain === 'random' ? '#e9dcbd' : isLand(h.terrain) ? FILL[h.terrain] : 'rgba(255,255,255,0.12)'}
          fillOpacity={h.hidden ? 0.45 : 1}
          stroke={h.terrain !== 'sea' ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.25)'}
          strokeWidth="0.06"
        />
      ))}
    </svg>
  );
}
