// What each module needs to find on the board, checked once the board is built: a game whose map
// lost a module's geography would play with that module doing nothing at all (Fisheries on the
// archipelago did, before the expansions shaped a sea map's home island). Rule 10 puts each of these
// on the home island, and a fishing ground in a channel may touch an islet as well.

import { isLand } from '../constants';
import type { Board, ModuleId } from '../types';

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b).join(',');

/** Everything the modules in play need from `board` and don't find there, as sentences (none when all is well). */
export function missingFeatures(board: Board, modules: readonly ModuleId[]): string[] {
  const out: string[] = [];
  const onHome = (h: number) => isLand(board.hexes[h].terrain) && board.islands[board.hexes[h].island]?.home === true;
  const onCoast = (h: number) => board.hexes[h].edges.some((e) => board.edges[e].coastal);

  if (modules.includes('fisheries')) {
    const lakes = board.hexes.filter((h) => h.terrain === 'lake');
    if (lakes.length !== 1) out.push(`Fisheries needs one lake, and the board has ${lakes.length}`);
    for (const lake of lakes) {
      if (!onHome(lake.id)) out.push(`Fisheries' lake (hex ${lake.id}) is off the home island`);
      if (sorted(lake.numbers) !== '2,3,11,12') out.push(`Fisheries' lake (hex ${lake.id}) bears ${lake.numbers.join('/')}, not 2, 3, 11 and 12`);
    }
    const grounds = board.hexes.filter((h) => h.terrain === 'sea' && h.numbers.length > 0);
    if (grounds.length !== 6) out.push(`Fisheries needs six fishing grounds, and the board has ${grounds.length}`);
    else if (sorted(grounds.flatMap((g) => g.numbers)) !== '4,5,6,8,9,10') out.push('Fisheries’ grounds should bear 4, 5, 6, 8, 9 and 10');
    for (const g of grounds) if (!g.neighbors.some((n) => isLand(board.hexes[n].terrain))) out.push(`Fishing ground ${g.id} touches no land`);
  }

  if (modules.includes('oil')) {
    const wells = board.hexes.filter((h) => h.well);
    if (wells.length !== 3) out.push(`Oil needs three wells, and the board has ${wells.length}`);
    for (const w of wells) if (!onHome(w.id)) out.push(`Oil's well on hex ${w.id} is off the home island`);
  }

  if (modules.includes('rivers')) {
    const rivers = board.features.rivers ?? [];
    if (rivers.length !== 2) out.push(`Rivers needs two rivers, and the board has ${rivers.length}`);
    rivers.forEach((river, i) => {
      const hexes = river.hexes;
      if (hexes.some((h) => !onHome(h))) out.push(`River ${i} leaves the home island`);
      if (hexes.some((h, j) => j > 0 && !board.hexes[hexes[j - 1]].neighbors.includes(h))) out.push(`River ${i} doesn't run through neighbouring hexes`);
      const mouth = hexes[hexes.length - 1];
      if (board.hexes[mouth].terrain !== 'swamp') out.push(`River ${i} ends on ${board.hexes[mouth].terrain}, not a swamp`);
      const site = river.bridgeSites[river.bridgeSites.length - 1];
      if (river.bridgeSites.length !== hexes.length || !board.edges[site].coastal) out.push(`River ${i}'s mouth doesn't meet the sea`);
    });
    if (rivers.length === 2 && rivers[0].hexes.some((a) => rivers[1].hexes.some((b) => a === b || board.hexes[a].neighbors.includes(b)))) out.push('The two rivers touch');
  }

  if (modules.includes('caravans')) {
    const oasis = board.features.oasis;
    if (!oasis) out.push('Wagon Trains needs an oasis');
    else {
      if (board.hexes[oasis.hex].terrain !== 'oasis') out.push(`Wagon Trains' oasis (hex ${oasis.hex}) is ${board.hexes[oasis.hex].terrain}`);
      if (!onHome(oasis.hex)) out.push("Wagon Trains' oasis is off the home island");
      if (oasis.origins.length !== 3) out.push(`Wagon Trains' oasis has ${oasis.origins.length} train origins, not three`);
    }
  }

  if (modules.includes('invasion')) {
    const castle = board.features.castle;
    if (castle === undefined) out.push('Invasion needs a castle');
    else {
      if (board.hexes[castle].terrain !== 'castle') out.push(`Invasion's castle (hex ${castle}) is ${board.hexes[castle].terrain}`);
      if (!onHome(castle) || !onCoast(castle)) out.push("Invasion's castle isn't on the home island's coast");
    }
  }
  return out;
}
