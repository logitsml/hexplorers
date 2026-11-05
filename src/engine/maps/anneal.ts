// The dealer's last step (docs/maps.md): with the features in place, the island's terrain, its
// number discs, the fishing grounds' numbers and the harbours' kinds are traded about by simulated
// annealing until the home island's rules hold and its soft rules are as well met as a few thousand
// steps can make them. The score is maps/island.ts's, worked on arrays: its hard rules
// (islandBreaches) weigh far more than any soft one, and its figures (islandFigures) weigh as
// docs/maps.md gives them. tests/island.test.ts holds the result
// to the check itself, so the two can't drift apart unseen.
//
// What moves: a plain tile's terrain (not a river's, a feature's or the desert's), within the home
// island or within the islets; a hex's whole set of discs, or one disc of a hex bearing two (rule 5's
// moved-on numbers); a ground's number; a harbour's kind; and the numbered well between the two
// river mouths. What stays: the features, the bounty fields and the lake's numbers. Oil's
// other wells are found afresh from the board as it lies (the second-likeliest pasture, the
// second-least-likely forest, a spare where a feature took those, apart if they can be).

import { buildBoard, hexCenter, type BoardSpec } from '../board';
import { PIPS, TERRAIN_RESOURCE, isLand } from '../constants';
import type { Rng } from '../rng';
import type { ModuleId, PortType, Resource, Terrain } from '../types';
import { RESOURCES } from '../types';
import { PLAIN, coastOf, hexAtIn, hiddenKeys, homeIslands, neighboursIn } from './shape';

/** Steps of annealing at set-up. */
const STEPS = 3000;
/** What one broken hard rule weighs against the soft figures while annealing (the best kept is the one breaking fewest). */
const HARD = 100;
const T_START = 10;
const T_END = 0.05;
const LANDINGS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
const PAIRS = [
  [4, 10],
  [5, 9],
  [6, 8],
];
const DEG = 180 / Math.PI;

const isRed = (n: number) => n === 6 || n === 8;

export function anneal(spec: BoardSpec, modules: readonly ModuleId[], rng: Rng, steps = STEPS) {
  const hexes = spec.hexes;
  const index = new Map(hexes.map((h, i) => [h, i]));
  const at = hexAtIn(spec);
  const neighbours = neighboursIn(spec);
  const near = hexes.map((h) => neighbours(h).map((n) => index.get(n)!));
  const hidden = hiddenKeys(spec);
  const shown = hexes.map((h) => !hidden.has(`${h.q},${h.r}`));
  const home = homeIslands(spec).flat();
  const isHome = hexes.map(() => false);
  for (const h of home) isHome[index.get(h)!] = true;
  const coastal = coastOf(spec, home);
  const lake = hexes.map((h) => h.terrain === 'lake');
  const all = hexes.map((_, i) => i);
  const onRiver = new Set((spec.rivers ?? []).flatMap((rv) => rv.path.map(([q, r]) => index.get(at(q, r)!)!)));
  const terr: Terrain[] = hexes.map((h) => h.terrain);
  const nums: number[][] = hexes.map((h) => h.numbers);
  const kinds: PortType[] = spec.ports.map((p) => p.type);

  // Oil (docs/maps.md, The wells): the numbered well stays on the desert or on a river mouth's
  // swamp, and every other well is found afresh from the board as it lies. The pasture and forest
  // wells take the second-likeliest pasture and the second-least-likely forest; a spare well (where
  // a feature took every pasture or forest, or the desert and the swamps) takes a hills, fields or
  // mountains hex and keeps its number. They stand apart if they can, a spare on a 5 or a 9 if it can.
  const oil = modules.includes('oil');
  const wells = all.filter((i) => hexes[i].well);
  let kept = oil ? (wells.find((i) => terr[i] === 'desert' || terr[i] === 'swamp') ?? -1) : -1;
  const wantPasture = oil && wells.some((i) => terr[i] === 'pasture');
  const wantForest = oil && wells.some((i) => terr[i] === 'forest');
  const spares = oil ? wells.length - Number(kept >= 0) - Number(wantPasture) - Number(wantForest) : 0;
  const pinned = new Set(oil ? [kept].filter((i) => i >= 0) : wells);
  // The numbered well on a swamp may stand on either river mouth's (the move below): on a crowded
  // island the four-hex river's own pasture can be the only one, beside its swamp.
  const robber = spec.robber ? index.get(at(...spec.robber)!) : undefined;
  const swamps = kept >= 0 && terr[kept] === 'swamp' ? all.filter((i) => isHome[i] && terr[i] === 'swamp' && i !== robber) : [];
  if (swamps.length !== 2) swamps.length = 0;

  const tiles = all.filter((i) => shown[i] && PLAIN.includes(terr[i]) && !onRiver.has(i) && !pinned.has(i));
  const discs = all.filter((i) => shown[i] && isLand(terr[i]) && nums[i].length > 0 && !lake[i] && !pinned.has(i));
  const grounds = all.filter((i) => shown[i] && terr[i] === 'sea' && nums[i].length > 0);
  const numbered = all.filter((i) => shown[i] && (nums[i].length > 0 || swamps.includes(i)));
  const pairs: [number, number][] = [];
  for (const i of numbered) for (const j of near[i]) if (j > i && numbered.includes(j)) pairs.push([i, j]);
  const bounty = all.filter((i) => shown[i] && terr[i] === 'bounty');
  const shownLand = all.filter((i) => shown[i] && isLand(terr[i]));
  const homeIdx = all.filter((i) => isHome[i]);
  const shore = homeIdx.filter((i) => coastal(hexes[i]) && !lake[i]);
  const invasion = modules.includes('invasion') && !!spec.castle;

  const islets: number[][] = [];
  const seen = new Set<number>();
  for (const i of shownLand) {
    if (isHome[i] || seen.has(i)) continue;
    const group = [i];
    seen.add(i);
    for (let g = 0; g < group.length; g++) for (const j of near[group[g]]) if (shown[j] && isLand(terr[j]) && !isHome[j] && !seen.has(j)) (seen.add(j), group.push(j));
    islets.push(group);
  }

  // The grounds in order round the island, for their pairs' split (one home island only).
  const [cx, cz] = home.reduce(([x, z], h) => {
    const [hx, hz] = hexCenter(h.q, h.r);
    return [x + hx / home.length, z + hz / home.length];
  }, [0, 0]);
  const bearing = (x: number, z: number) => Math.atan2(z - cz, x - cx) * DEG;
  const splitting = modules.includes('fisheries') && grounds.length === 6 && homeIslands(spec).length === 1;
  const round = [...grounds].sort((a, b) => bearing(...hexCenter(hexes[a].q, hexes[a].r)) - bearing(...hexCenter(hexes[b].q, hexes[b].r)));

  // The intersections that count: those on a home hex other than the castle, with their hexes, and
  // which half of the island each lies in, for each of the three ways of halving it.
  const board = buildBoard(spec);
  const idOf = (id: number) => index.get(at(board.hexes[id].q, board.hexes[id].r)!)!;
  const spots = board.vertices
    .map((v) => ({ v, hs: v.hexes.map(idOf) }))
    .filter(({ hs }) => hs.some((i) => isHome[i] && terr[i] !== 'castle'))
    .map(({ v, hs }) => ({
      hs,
      halves: [0, 60, 120].map((a) => {
        const d = (v.x - cx) * Math.cos(a / DEG) + (v.z - cz) * Math.sin(a / DEG);
        return d > 1e-6 ? 1 : d < -1e-6 ? -1 : 0;
      }),
    }));
  const harbours = board.ports.map((p) => [...new Set(p.vertices.flatMap((v) => board.vertices[v].hexes.map(idOf)))]);

  const river = Uint8Array.from(all, (i) => (onRiver.has(i) ? 1 : 0));
  const ground = Uint8Array.from(all, (i) => (grounds.includes(i) ? 1 : 0));
  const pip = new Float64Array(hexes.length);
  const reds = new Uint8Array(hexes.length);
  const well = new Uint8Array(hexes.length);
  const coastCount = new Uint8Array(13);
  const res = new Float64Array(RESOURCES.length);
  const top = new Float64Array(10);
  const halfTop = new Float64Array(18);
  const live = all.filter((i) => shown[i] && (isLand(terr[i]) || grounds.includes(i)));
  const RES = Object.fromEntries(Object.entries(TERRAIN_RESOURCE).map(([t, r]) => [t, r ? RESOURCES.indexOf(r) : -1])) as Record<Terrain, number>;
  /** Each hex's resource, as an index into RESOURCES (-1 for none), traded with its terrain. */
  const rc = Int8Array.from(all, (i) => RES[terr[i]]);
  const isBounty = Uint8Array.from(all, (i) => (terr[i] === 'bounty' ? 1 : 0));
  /** Keep the `size` largest values seen, largest first, in `into` from `from`. */
  const keep = (into: Float64Array, from: number, size: number, w: number) => {
    for (let k = from; k < from + size; k++) {
      if (w > into[k]) {
        for (let m = from + size - 1; m > k; m--) into[m] = into[m - 1];
        into[k] = w;
        return;
      }
    }
  };

  /** The pips the pasture (or forest) well should bear: the second from the top (or the bottom), or the only one's. */
  const wantPips = (terrain: Terrain, likeliest: boolean) => {
    let first = NaN;
    let second = NaN;
    for (const i of homeIdx) {
      if (terr[i] !== terrain) continue;
      const p = likeliest ? pip[i] : -pip[i];
      if (Number.isNaN(first) || p > first) [first, second] = [p, first];
      else if (Number.isNaN(second) || p > second) second = p;
    }
    const want = Number.isNaN(second) ? first : second;
    return likeliest ? want : -want;
  };
  const SPARE: readonly Terrain[] = ['hills', 'fields', 'mountains'];
  /** Every well for the board as it lies, and how many pairs of them touch (a well with nowhere to go counts as one). */
  const findWells = (): { wells: number[]; touching: number } => {
    const ranked = (terrain: Terrain, likeliest: boolean) => {
      const want = wantPips(terrain, likeliest);
      return homeIdx.filter((i) => terr[i] === terrain && pip[i] === want);
    };
    const ps = wantPasture ? ranked('pasture', true) : [];
    const fs = wantForest ? ranked('forest', false) : [];
    const touching = (ws: readonly number[]) => {
      let t = 0;
      for (let x = 0; x < ws.length; x++) for (let y = x + 1; y < ws.length; y++) if (near[ws[x]].includes(ws[y])) t++;
      return t;
    };
    const plain59 = (i: number) => (nums[i].some((n) => n === 5 || n === 9) ? 0 : 1);
    // (The fewest pairs touching, then the fewest spares without a 5 or a 9.)
    let best: { wells: number[]; touching: number; key: number } = { wells: [], touching: Infinity, key: Infinity };
    for (const p of ps.length > 0 ? ps : [-1]) {
      for (const f of fs.length > 0 ? fs : [-1]) {
        const ranked = [kept, p, f].filter((i) => i >= 0);
        const chosen = [...ranked];
        for (let k = 0; k < spares; k++) {
          let pick = -1;
          let key = Infinity;
          for (const i of homeIdx) {
            if (!SPARE.includes(terr[i]) || onRiver.has(i) || nums[i].length === 0 || chosen.includes(i)) continue;
            const t = chosen.filter((w) => near[w].includes(i)).length * 2 + plain59(i);
            if (t < key) (key = t), (pick = i);
          }
          if (pick >= 0) chosen.push(pick);
        }
        const t = touching(chosen);
        const key = t * 100 + chosen.slice(ranked.length).reduce((n, i) => n + plain59(i), 0);
        if (key < best.key) best = { wells: chosen, touching: t, key };
      }
    }
    return { wells: best.wells, touching: best.touching + wells.length - best.wells.length };
  };

  const score = (): { hard: number; soft: number; wells: number[] } => {
    for (const i of live) {
      let p = 0;
      let r = 0;
      for (const n of nums[i]) {
        p += PIPS[n] ?? 0;
        if (isRed(n)) r++;
      }
      pip[i] = p;
      reds[i] = r;
    }
    let hard = 0;
    for (const i of numbered) if (reds[i] > 1) hard++;
    for (const [i, j] of pairs) {
      if (reds[i] && reds[j]) hard++;
      if (lake[i] || lake[j]) continue;
      for (const n of nums[i]) {
        if (nums[j].includes(n)) {
          hard++;
          break;
        }
      }
    }
    for (const i of bounty) if (reds[i]) hard++;
    let repeats = 0;
    if (invasion) {
      coastCount.fill(0);
      for (const i of shore) for (const n of nums[i]) coastCount[n]++;
      for (const n of LANDINGS) {
        if (coastCount[n] === 0) hard++;
        else repeats += coastCount[n] - 1;
      }
    }
    if (splitting) {
      let split = false;
      for (let s = 0; s < 3 && !split; s++) {
        split = PAIRS.every(([a, b]) => {
          let ina = false;
          let inb = false;
          for (let k = 0; k < 3; k++) {
            const g = nums[round[(s + k) % 6]];
            if (g.includes(a)) ina = true;
            if (g.includes(b)) inb = true;
          }
          return ina !== inb;
        });
      }
      if (!split) hard++;
    }
    well.fill(0);
    let found: { wells: number[]; touching: number } = { wells, touching: 0 };
    if (oil) {
      found = findWells();
      hard += found.touching;
    }
    for (const i of found.wells) well[i] = 1;

    // The soft figures, as islandFigures has them.
    res.fill(0);
    for (const i of shownLand) if (rc[i] >= 0) res[rc[i]] += pip[i];
    let most = -Infinity;
    let least = Infinity;
    for (const x of res) (most = Math.max(most, x)), (least = Math.min(least, x));
    let isletGap = 0;
    if (islets.length > 1) {
      let hi = -Infinity;
      let lo = Infinity;
      for (const g of islets) {
        let t = 0;
        for (const i of g) t += pip[i];
        hi = Math.max(hi, t / g.length);
        lo = Math.min(lo, t / g.length);
      }
      isletGap = hi - lo;
    }
    top.fill(-1);
    halfTop.fill(-1);
    for (const s of spots) {
      let w = 0;
      for (const i of s.hs) {
        if (rc[i] >= 0 || isBounty[i]) w += pip[i];
        if (well[i]) w += 0.6 * pip[i];
        if (lake[i]) w += 2.4;
        if (ground[i]) w += 0.4 * pip[i];
        if (river[i]) w += 0.5;
      }
      keep(top, 0, 10, w);
      for (let a = 0; a < 3; a++) if (s.halves[a] !== 0) keep(halfTop, (a * 2 + (s.halves[a] > 0 ? 0 : 1)) * 3, 3, w);
    }
    const mean3 = (from: number) => {
      let t = 0;
      let c = 0;
      for (let k = from; k < from + 3; k++) if (halfTop[k] >= 0) (t += halfTop[k]), c++;
      return t / Math.max(1, c);
    };
    let sides = 0;
    for (let a = 0; a < 3; a++) sides = Math.max(sides, Math.abs(mean3(a * 6) - mean3(a * 6 + 3)));
    const runaway = spots.length >= 10 ? top[0] - top[9] : 0;
    let clumps = 0;
    for (const i of homeIdx) if (rc[i] >= 0) for (const j of near[i]) if (j > i && isHome[j] && rc[j] === rc[i]) clumps++;
    let rich = 0;
    for (let k = 0; k < kinds.length; k++) {
      const kind = RESOURCES.indexOf(kinds[k] as Resource);
      if (kind < 0) continue;
      for (const i of harbours[k]) {
        if (rc[i] === kind && nums[i].some((n) => (PIPS[n] ?? 0) >= 4)) {
          rich++;
          break;
        }
      }
    }
    const soft =
      3 * (most - least) + 6 * isletGap + 2 * sides + 1.5 * clumps + 2 * Math.max(0, runaway - 2) + 2 * Math.max(0, top[0] - 13) + 30 * repeats + 2 * rich;
    return { hard, soft, wells: found.wells };
  };

  // The moves: each swaps two things of one kind, and is undone by swapping them back. Terrain
  // trades within the home island or within the islets, so each keeps the bag its map dealt it.
  interface Move {
    weight: number;
    pool: readonly number[];
    /** Make the move between `a` and `b` if it changes anything, returning how to take it back. */
    make: (a: number, b: number) => (() => void) | null;
  }
  const swapping =
    <T>(xs: T[], same: (a: number, b: number) => boolean = () => false) =>
    (a: number, b: number) => {
      if (same(a, b)) return null;
      const undo = () => ([xs[a], xs[b]] = [xs[b], xs[a]]);
      undo();
      return undo;
    };
  const homeTiles = tiles.filter((i) => isHome[i]);
  const isletTiles = tiles.filter((i) => !isHome[i]);
  const tile = (a: number, b: number) => {
    if (terr[a] === terr[b]) return null;
    const undo = () => (([terr[a], terr[b]] = [terr[b], terr[a]]), ([rc[a], rc[b]] = [rc[b], rc[a]]));
    undo();
    return undo;
  };
  const candidates: Move[] = [
    { weight: 4, pool: homeTiles, make: tile },
    { weight: 1, pool: isletTiles, make: tile },
    { weight: 4, pool: discs, make: swapping(nums, (a, b) => nums[a].join() === nums[b].join()) },
    // (A hex's second disc handed on to a hex bearing one, as rule 5 moves a displaced number on:
    // a crowded coast can then still bear every landing number.)
    {
      weight: discs.some((i) => nums[i].length > 1) ? 1 : 0,
      pool: discs,
      make: (a, b) => {
        const [from, to] = [nums[a], nums[b]];
        if (from.length < 2 || to.length !== 1) return null;
        const k = rng.int(from.length);
        if (to.includes(from[k])) return null;
        nums[a] = from.filter((_, i) => i !== k);
        nums[b] = [...to, from[k]];
        return () => ((nums[a] = from), (nums[b] = to));
      },
    },
    // (One disc of a pair traded for another hex's: a pair stuck on Invasion's coast can then
    // come away without a landing number leaving the coast on the way.)
    {
      weight: discs.some((i) => nums[i].length > 1) ? 1 : 0,
      pool: discs,
      make: (a, b) => {
        const [x, y] = [nums[a], nums[b]];
        if (x.length < 2 && y.length < 2) return null;
        const [i, j] = [rng.int(x.length), rng.int(y.length)];
        if (x[i] === y[j] || x.includes(y[j]) || y.includes(x[i])) return null;
        nums[a] = x.map((n, k) => (k === i ? y[j] : n));
        nums[b] = y.map((n, k) => (k === j ? x[i] : n));
        return () => ((nums[a] = x), (nums[b] = y));
      },
    },
    { weight: 1, pool: grounds, make: swapping(nums) },
    { weight: 1, pool: kinds.map((_, k) => k), make: swapping(kinds, (a, b) => kinds[a] === kinds[b]) },
    // (The numbered well and its discs, from one river mouth's swamp to the other.)
    {
      weight: 1,
      pool: swamps,
      make: (a, b) => {
        const undo = () => (([nums[a], nums[b]] = [nums[b], nums[a]]), (kept = kept === a ? b : a));
        undo();
        return undo;
      },
    },
  ];
  const moves = candidates.filter((m) => m.pool.length >= 2 && m.weight > 0);
  const total = moves.reduce((t, m) => t + m.weight, 0);

  // The best island seen is kept in arrays of its own (copied into, not made afresh, as it improves).
  const best = { hard: Infinity, soft: Infinity, wells, terr: [...terr], nums: [...nums], kinds: [...kinds], kept };
  const remember = (found: { hard: number; soft: number; wells: number[] }) => {
    Object.assign(best, found, { kept });
    for (const i of all) (best.terr[i] = terr[i]), (best.nums[i] = nums[i]);
    kinds.forEach((k, i) => (best.kinds[i] = k));
  };
  const cost = (s: { hard: number; soft: number }) => HARD * s.hard + s.soft;
  /** Anneal for `steps` from temperature `hot` down. */
  const run = (steps: number, hot: number) => {
    let now = score();
    if (now.hard < best.hard || (now.hard === best.hard && now.soft < best.soft)) remember(now);
    for (let step = 0; step < steps && moves.length > 0; step++) {
      let pick = rng.next() * total;
      const move = moves.find((m) => (pick -= m.weight) < 0) ?? moves[moves.length - 1];
      const a = move.pool[rng.int(move.pool.length)];
      const b = move.pool[rng.int(move.pool.length)];
      const undo = a === b ? null : move.make(a, b);
      if (!undo) continue;
      const next = score();
      const t = hot * Math.pow(T_END / hot, step / steps);
      const delta = cost(next) - cost(now);
      if (delta <= 0 || rng.next() < Math.exp(-delta / t)) {
        now = next;
        if (next.hard < best.hard || (next.hard === best.hard && next.soft < best.soft)) remember(next);
      } else undo();
    }
  };
  run(steps, T_START);
  // (Now and then a crowded island ends with a rule still broken: anneal the best one again.)
  for (let again = 0; again < 5 && best.hard > 0; again++) {
    for (const i of all) (terr[i] = best.terr[i]), (rc[i] = RES[terr[i]]), (nums[i] = best.nums[i]);
    best.kinds.forEach((k, i) => (kinds[i] = k));
    kept = best.kept;
    run(steps, T_START);
  }

  // The best island seen, written back.
  const twelve = spec.robber ? at(...spec.robber) : undefined;
  const robberOnTwelve = !!twelve && twelve.numbers.includes(12);
  hexes.forEach((h, i) => {
    h.terrain = best.terr[i];
    h.numbers = best.nums[i];
  });
  spec.ports.forEach((p, k) => (p.type = best.kinds[k]));
  if (oil) {
    for (const i of wells) delete hexes[i].well;
    for (const i of best.wells) hexes[i].well = true;
  }
  // (A map whose robber starts on the 12 keeps it there.)
  if (robberOnTwelve) {
    const on = hexes.find((h) => isLand(h.terrain) && h.numbers.includes(12) && !hidden.has(`${h.q},${h.r}`));
    if (on) spec.robber = [on.q, on.r];
  }
  return { hard: best.hard, soft: best.soft };
}
