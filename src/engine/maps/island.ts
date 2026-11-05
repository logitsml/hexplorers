// The rules every dealt map keeps on its home island (docs/maps.md, The home island), as one check.
// The hard rules come back as breaches, each tagged with its rule, so a test can say which rules
// still fail on which map; the soft ones come back as figures for the dealer to weigh, the same
// figures scripts/all-hands-map.mjs annealed the All Hands map under, made general. It reads a
// board spec (the dealer's own output) and builds the board only for its intersections and
// harbour corners. The base game keeps its own deals and isn't held to it; nor are custom maps.

import { SIDE_DIRS, buildBoard, hexCenter, type BoardSpec, type HexSpec } from '../board';
import { PIPS, TERRAIN_RESOURCE, isLand } from '../constants';
import type { Board, ModuleId, Resource } from '../types';
import { RESOURCES } from '../types';
import { PLAIN, castleCorner, coastOf, hexAtIn, hexDistance, hiddenKeys, homeIslands, isRed, neighboursIn, pipsOf } from './shape';

export type IslandRule = 'castle' | 'desert' | 'rivers' | 'oasis' | 'lake' | 'wells' | 'harbours' | 'grounds' | 'islets' | 'bounty' | 'reds' | 'repeats' | 'landings';

export interface Breach {
  rule: IslandRule;
  text: string;
}

/** The soft rules' figures: lower is better in each but `best`, which is only reported. */
export interface IslandFigures {
  /** The likeliest resource's pips less the least likely's, over the whole board (face-down hexes aside). */
  resources: number;
  /** The islets' pips a hex, the richest's less the poorest's (0 with fewer than two islets). */
  islets: number;
  /**
   * The mean worth of the best three intersections on one half of the home island less the
   * other half's, at the worst of the three ways to halve it across a pair of opposite corners.
   */
  sides: number;
  /** The best intersection's worth less the tenth best's. */
  runaway: number;
  /** The best intersection's worth. */
  best: number;
  /** 2:1 harbours beside a hex of their own resource bearing a 5, 6, 8 or 9. */
  harbours: number;
  /** Pairs of side-by-side home hexes of the same plain terrain. */
  clumps: number;
  /** Under Invasion, the discs on the home coast that repeat a number it already bears. */
  coast: number;
}

const NUMBERS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
/** The two river stamps, source to mouth. */
const STAMPS = [
  ['mountains', 'hills', 'pasture', 'swamp'],
  ['mountains', 'hills', 'swamp'],
];
const GROUND_PAIRS = [
  [4, 10],
  [5, 9],
  [6, 8],
];
const DEG = 180 / Math.PI;

const where = (h: HexSpec) => `${h.q},${h.r}`;
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b).join(',');
/** The smaller angle between two bearings, in degrees. */
const turn = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** What both halves of the check read: the home island, its middle, its islets and its grounds. */
function survey(spec: BoardSpec) {
  const at = hexAtIn(spec);
  const near = neighboursIn(spec);
  const hidden = hiddenKeys(spec);
  const shown = (h: HexSpec) => !hidden.has(where(h));
  const islands = homeIslands(spec);
  const home = islands.flat();
  const homeSet = new Set(home);
  const coastal = coastOf(spec, home);
  const [cx, cz] = home.reduce(([x, z], h) => {
    const [hx, hz] = hexCenter(h.q, h.r);
    return [x + hx / home.length, z + hz / home.length];
  }, [0, 0]);
  /** A hex's bearing from the island's middle, in degrees. */
  const bearing = (x: number, z: number) => Math.atan2(z - cz, x - cx) * DEG;
  const bearingOf = (h: HexSpec) => bearing(...hexCenter(h.q, h.r));
  // (The castle's corner is the castle where there is one, and the corner it would stand on where there isn't.)
  const castle = spec.castle ? at(...spec.castle) : undefined;
  const site = castle ?? castleCorner(home);
  const corner = site ? bearingOf(site) : 0;

  const islet = (h: HexSpec) => isLand(h.terrain) && !homeSet.has(h) && shown(h);
  const islets: HexSpec[][] = [];
  const seen = new Set<HexSpec>();
  for (const h of spec.hexes) {
    if (!islet(h) || seen.has(h)) continue;
    const group = [h];
    seen.add(h);
    for (let i = 0; i < group.length; i++) {
      for (const n of near(group[i])) {
        if (islet(n) && !seen.has(n)) {
          seen.add(n);
          group.push(n);
        }
      }
    }
    islets.push(group);
  }
  const grounds = spec.hexes.filter((h) => h.terrain === 'sea' && h.numbers.length > 0 && shown(h));
  let board: Board | undefined;
  return { spec, at, near, shown, islands, home, homeSet, coastal, centre: [cx, cz] as const, bearing, bearingOf, castle, corner, islets, grounds, board: () => (board ??= buildBoard(spec)) };
}
type Survey = ReturnType<typeof survey>;

/** Every hard rule of the home island that `spec` breaks, for a game with `modules`. */
export function islandBreaches(spec: BoardSpec, modules: readonly ModuleId[]): Breach[] {
  const k = survey(spec);
  const out: Breach[] = [];
  const add = (rule: IslandRule) => (text: string) => out.push({ rule, text });
  if (modules.includes('invasion')) invasion(k, add);
  if (modules.includes('rivers')) rivers(k, add('rivers'));
  if (modules.includes('caravans')) oasis(k, add('oasis'));
  if (modules.includes('fisheries')) {
    lake(k, add('lake'));
    grounds(k, add('grounds'));
  }
  if (modules.includes('oil')) wells(k, add('wells'));
  harbours(k, add('harbours'));
  islets(k, add);
  numbers(k, add);
  return out;
}

type Add = (text: string) => void;

function invasion(k: Survey, add: (rule: IslandRule) => Add) {
  const { castle, home, homeSet, coastal } = k;
  if (!castle || castle.terrain !== 'castle' || !homeSet.has(castle) || !coastal(castle)) {
    add('castle')("The castle isn't on the home island's coast");
    return;
  }
  const corner = castleCorner(home)!;
  if (corner !== castle) add('castle')(`The castle stands at ${where(castle)}, not on the lower-left corner (${where(corner)})`);

  const [kx, kz] = hexCenter(castle.q, castle.r);
  const span = (h: HexSpec) => {
    const [x, z] = hexCenter(h.q, h.r);
    return Math.round(((x - kx) ** 2 + (z - kz) ** 2) * 1e6);
  };
  const desert = home.find((h) => h.terrain === 'desert');
  const far = Math.max(...home.filter((h) => coastal(h) && h !== castle).map(span));
  if (desert && (!coastal(desert) || span(desert) < far)) add('desert')(`The desert lies at ${where(desert)}, not on the coastal hex furthest from the castle`);

  // (A number the coast bears twice is a soft matter, IslandFigures.coast: the All Hands map has one.)
  const missing = NUMBERS.filter((n) => !landings(k).includes(n));
  if (missing.length > 0) add('landings')(`The coast lacks ${missing.join(', ')}`);
}

/** The numbers on the home coast, where Invasion's raiders land (the lake is water: they never land there). */
const landings = (k: Survey) => k.home.filter((h) => k.coastal(h) && h.terrain !== 'lake').flatMap((h) => h.numbers);

function rivers(k: Survey, add: Add) {
  const all = k.spec.rivers ?? [];
  if (all.length !== 2) add(`There are ${all.length} rivers, not two`);
  const paths: HexSpec[][] = [];
  all.forEach((rv, i) => {
    const name = i === 0 ? 'The four-hex river' : 'The three-hex river';
    const path = rv.path.map(([q, r]) => k.at(q, r));
    if (path.some((h) => !h || !k.homeSet.has(h))) {
      add(`${name} leaves the home island`);
      return;
    }
    const hexes = path as HexSpec[];
    paths.push(hexes);
    const stamp = STAMPS[i] ?? [];
    if (hexes.map((h) => h.terrain).join() !== stamp.join()) add(`${name} runs ${hexes.map((h) => h.terrain).join(' → ')}, not ${stamp.join(' → ')}`);
    const step = (a: HexSpec, b: HexSpec) => SIDE_DIRS.findIndex(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r);
    const heading = step(hexes[0], hexes[1]);
    if (hexes.some((h, j) => j > 0 && step(hexes[j - 1], h) !== heading)) add(`${name} bends`);
    else if (rv.mouthSide !== (heading + 1) % 6 && rv.mouthSide !== (heading + 5) % 6) add(`${name}'s mouth ${rv.mouthSide === heading ? 'runs straight on' : 'turns back'}, not 60° to the sea`);
    const mouth = hexes[hexes.length - 1];
    const beyond = k.at(mouth.q + SIDE_DIRS[rv.mouthSide][0], mouth.r + SIDE_DIRS[rv.mouthSide][1]);
    if (beyond && isLand(beyond.terrain) && k.shown(beyond)) add(`${name}'s mouth opens onto land`);
  });
  if (paths.length === 2 && paths[0].some((a) => paths[1].some((b) => a === b || hexDistance(a, b) === 1))) add('The two rivers touch');
}

function oasis(k: Survey, add: Add) {
  const at = k.spec.oasis ? k.at(...k.spec.oasis.at) : undefined;
  if (!at || at.terrain !== 'oasis' || !k.homeSet.has(at)) {
    add("There's no oasis on the home island");
    return;
  }
  const off = (h: HexSpec) => {
    const [x, z] = hexCenter(h.q, h.r);
    return Math.round(((x - k.centre[0]) ** 2 + (z - k.centre[1]) ** 2) * 1e6);
  };
  if (off(at) > Math.min(...k.home.map(off))) add(`The oasis stands at ${where(at)}, off the island's middle`);
}

function lake(k: Survey, add: Add) {
  const lakes = k.spec.hexes.filter((h) => h.terrain === 'lake');
  if (lakes.length !== 1) add(`There are ${lakes.length} lakes, not one`);
  for (const h of lakes) {
    if (!k.homeSet.has(h)) add(`The lake at ${where(h)} is off the home island`);
    else if (k.near(h).length < 6 || k.near(h).some((n) => !k.homeSet.has(n))) add(`The lake at ${where(h)} isn't inland`);
    if (sorted(h.numbers) !== '2,3,11,12') add(`The lake bears ${h.numbers.join(', ')}, not 2, 3, 11 and 12`);
  }
}

function grounds(k: Survey, add: Add) {
  const gs = k.grounds;
  if (gs.length !== 6) add(`There are ${gs.length} fishing grounds, not six`);
  if (sorted(gs.flatMap((g) => g.numbers)) !== '4,5,6,8,9,10') add('The grounds don’t bear 4, 5, 6, 8, 9 and 10');
  for (const g of gs) if (!k.near(g).some((n) => k.homeSet.has(n))) add(`The ground at ${where(g)} touches no home island`);
  // Spaced round one island (a map starting on two shares them, and isn't held to this).
  if (k.islands.length !== 1 || gs.length !== 6) return;
  const round = gs.map((g) => ({ g, at: k.bearingOf(g) })).sort((a, b) => a.at - b.at);
  const gaps = round.map((x, i) => turn(x.at, round[(i + 1) % round.length].at));
  if (gaps.some((d) => d < 30 || d > 90)) add(`The grounds aren't spread round the island: gaps of ${gaps.map((d) => Math.round(d)).join('°, ')}°`);
  // Each half of the island (three grounds in a row) gets one of each pair.
  const split = [0, 1, 2].some((s) => {
    const half = new Set([0, 1, 2].flatMap((i) => round[(s + i) % 6].g.numbers));
    return GROUND_PAIRS.every(([a, b]) => half.has(a) !== half.has(b));
  });
  if (!split) add('A pair of ground numbers (4 and 10, 5 and 9, 6 and 8) lies on one side of the island');
}

function wells(k: Survey, add: Add) {
  const all = k.spec.hexes.filter((h) => h.well);
  if (all.length !== 3) add(`There are ${all.length} wells, not three`);
  for (const w of all) if (!k.homeSet.has(w)) add(`The well at ${where(w)} is off the home island`);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (hexDistance(all[i], all[j]) === 1) add(`The wells at ${where(all[i])} and ${where(all[j])} stand side by side`);
  const desert = k.home.some((h) => h.terrain === 'desert');
  const swamp = k.home.some((h) => h.terrain === 'swamp');
  const numbered = all.find((w) => w.terrain === 'desert') ?? (desert ? undefined : all.find((w) => w.terrain === 'swamp'));
  if ((desert || swamp) && !numbered) add(desert ? 'No well on the desert' : 'No well on a river mouth’s swamp');
  else if (numbered && numbered.numbers.length !== 1) add(`The numbered well bears ${numbered.numbers.length} numbers`);
  // The second-likeliest pasture and the second-least-likely forest (the only one, where it's alone).
  for (const [terrain, likeliest, name] of [
    ['pasture', true, 'second-likeliest pasture'],
    ['forest', false, 'second-least-likely forest'],
  ] as const) {
    const group = k.home.filter((h) => h.terrain === terrain);
    if (group.length === 0) continue;
    const ranked = group.map(pipsOf).sort((a, b) => (likeliest ? b - a : a - b));
    const want = ranked[Math.min(1, ranked.length - 1)];
    if (!all.some((w) => w.terrain === terrain && pipsOf(w) === want)) add(`No well on the ${name} (${want} pips)`);
  }
}

function harbours(k: Survey, add: Add) {
  const board = k.board();
  const ports = board.ports.map((p) => ({ ...p, at: k.at(board.hexes[p.hex].q, board.hexes[p.hex].r)! }));
  for (const p of ports) {
    if (!k.homeSet.has(p.at)) add(`A harbour stands off the home island, at ${where(p.at)}`);
    if (p.at === k.castle) add('A harbour stands on the castle');
    const beyond = k.at(p.at.q + SIDE_DIRS[p.side][0], p.at.r + SIDE_DIRS[p.side][1]);
    if (beyond && k.grounds.includes(beyond)) add(`The harbour at ${where(p.at)} faces a fishing ground`);
    for (const rv of k.spec.rivers ?? []) {
      const [q, r] = rv.path[rv.path.length - 1];
      if (p.at.q === q && p.at.r === r && p.side === rv.mouthSide) add(`A harbour stands on a river's mouth, at ${where(p.at)}`);
    }
  }
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) if (ports[i].vertices.some((v) => ports[j].vertices.includes(v))) add(`The harbours at ${where(ports[i].at)} and ${where(ports[j].at)} share a corner`);
  }
  const twoOne = RESOURCES.map((r) => ports.filter((p) => p.type === r).length);
  if (twoOne.some((n) => n !== 1)) add(`The 2:1 harbours aren't one for each resource (${RESOURCES.map((r, i) => `${twoOne[i]} ${r}`).join(', ')})`);
}

function islets(k: Survey, rule: (rule: IslandRule) => Add) {
  for (const h of k.islets.flat()) if (h.terrain === 'bounty' && h.numbers.some(isRed)) rule('bounty')(`The bounty field at ${where(h)} bears a red number`);
  for (const h of k.home) if (h.terrain === 'bounty') rule('bounty')(`A bounty field stands on the home island, at ${where(h)}`);
  if (k.islets.length === 0) return;
  const add = rule('islets');
  const bearings: number[] = [];
  for (const islet of k.islets) {
    const name = `The islet at ${where(islet[0])}`;
    const off = Math.min(...islet.flatMap((h) => k.home.map((x) => hexDistance(h, x))));
    if (off !== 2) add(`${name} lies ${off - 1} sea hexes off the home coast, not one`);
    const [x, z] = islet.reduce(([x, z], h) => {
      const [hx, hz] = hexCenter(h.q, h.r);
      return [x + hx / islet.length, z + hz / islet.length];
    }, [0, 0]);
    const at = k.bearing(x, z);
    bearings.push(at);
    if (turn(at, k.corner) <= 60) add(`${name} lies off the castle's corner`);
  }
  // Round three sides at most: every islet within half a turn of the others.
  const round = bearings.sort((a, b) => a - b);
  const widest = Math.max(...round.map((b, i) => (i + 1 < round.length ? round[i + 1] - b : round[0] + 360 - b)));
  if (round.length > 1 && 360 - widest > 180) add(`The islets lie round more than three sides (${Math.round(360 - widest)}° of the island)`);
}

function numbers(k: Survey, add: (rule: IslandRule) => Add) {
  const numbered = k.spec.hexes.filter((h) => h.numbers.length > 0 && k.shown(h));
  const order = new Map(numbered.map((h, i) => [h, i]));
  for (const h of numbered) {
    if (h.numbers.filter(isRed).length > 1) add('reds')(`The hex at ${where(h)} bears two red numbers`);
    for (const n of k.near(h)) {
      if ((order.get(n) ?? -1) <= order.get(h)!) continue;
      if (h.numbers.some(isRed) && n.numbers.some(isRed)) add('reds')(`Red numbers touch at ${where(h)} and ${where(n)}`);
      // (The lake's four are its own: they may sit beside the same numbers elsewhere.)
      if (h.terrain === 'lake' || n.terrain === 'lake') continue;
      const both = h.numbers.filter((x) => n.numbers.includes(x));
      if (both.length > 0) add('repeats')(`${both.join(' and ')} touch${both.length > 1 ? '' : 'es'} itself at ${where(h)} and ${where(n)}`);
    }
  }
}

/** The soft rules' figures for `spec` (see IslandFigures). */
export function islandFigures(spec: BoardSpec): IslandFigures {
  const k = survey(spec);
  const board = k.board();
  const shownLand = spec.hexes.filter((h) => isLand(h.terrain) && k.shown(h));

  const pips = new Map<Resource, number>(RESOURCES.map((r) => [r, 0]));
  for (const h of shownLand) {
    const r = TERRAIN_RESOURCE[h.terrain];
    if (r) pips.set(r, pips.get(r)! + pipsOf(h));
  }
  const perHex = k.islets.map((islet) => islet.reduce((t, h) => t + pipsOf(h), 0) / islet.length);

  // An intersection's worth (as All Hands was annealed): what its hexes produce, and something for
  // a well's oil, the lake's and a ground's fish, and a river's coins.
  const onRiver = new Set((spec.rivers ?? []).flatMap((rv) => rv.path.map(([q, r]) => k.at(q, r))));
  const worth = (hexes: readonly HexSpec[]) =>
    hexes.reduce((t, h) => {
      if (TERRAIN_RESOURCE[h.terrain] || h.terrain === 'bounty') t += pipsOf(h);
      if (h.well) t += 0.6 * pipsOf(h);
      if (h.terrain === 'lake') t += 0.4 * 6;
      if (k.grounds.includes(h)) t += 0.4 * pipsOf(h);
      if (onRiver.has(h)) t += 0.5;
      return t;
    }, 0);
  const spots = board.vertices
    .map((v) => ({ v, hexes: v.hexes.map((id) => k.at(board.hexes[id].q, board.hexes[id].r)!) }))
    .filter(({ hexes }) => hexes.some((h) => k.homeSet.has(h) && h.terrain !== 'castle'))
    .map(({ v, hexes }) => ({ x: v.x, z: v.z, worth: worth(hexes) }));
  const ranked = spots.map((s) => s.worth).sort((a, b) => b - a);
  const top3 = (xs: number[]) => {
    const best = xs.sort((a, b) => b - a).slice(0, 3);
    return best.reduce((t, x) => t + x, 0) / Math.max(1, best.length);
  };
  // (Halved across each pair of opposite corners: the castle's corner and the far one is one way.)
  const sides = Math.max(
    ...[0, 60, 120].map((a) => {
      const [ux, uz] = [Math.cos(a / DEG), Math.sin(a / DEG)];
      const side = (s: { x: number; z: number }) => (s.x - k.centre[0]) * ux + (s.z - k.centre[1]) * uz;
      return Math.abs(top3(spots.filter((s) => side(s) > 1e-6).map((s) => s.worth)) - top3(spots.filter((s) => side(s) < -1e-6).map((s) => s.worth)));
    }),
  );

  let rich = 0;
  for (const p of board.ports) {
    if (p.type === 'any') continue;
    const beside = new Set(p.vertices.flatMap((v) => board.vertices[v].hexes));
    if ([...beside].some((id) => TERRAIN_RESOURCE[board.hexes[id].terrain] === p.type && board.hexes[id].numbers.some((n) => (PIPS[n] ?? 0) >= 4))) rich++;
  }
  let clumps = 0;
  for (const h of k.home) for (const n of k.near(h)) if (k.homeSet.has(n) && PLAIN.includes(h.terrain) && n.terrain === h.terrain && where(n) < where(h)) clumps++;

  return {
    resources: Math.max(...pips.values()) - Math.min(...pips.values()),
    islets: perHex.length > 1 ? Math.max(...perHex) - Math.min(...perHex) : 0,
    sides,
    runaway: ranked.length >= 10 ? ranked[0] - ranked[9] : 0,
    best: ranked[0] ?? 0,
    harbours: rich,
    clumps,
    coast: k.castle ? landings(k).length - new Set(landings(k)).size : 0,
  };
}
