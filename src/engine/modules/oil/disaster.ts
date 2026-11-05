// The disaster at the end of a turn that filled the track: a 7 floods the coasts, any other total
// pollutes a hex bearing it. The fifth number lost (by default) loses the island.

import { isLand } from '../../constants';
import type { Ctx } from '../../ctx';
import { loseGame, updateLongestRoad } from '../../reducer';
import { numbersOf } from '../../rules';
import type { GameState, PlayerId } from '../../types';
import { TRACK_MAX, WELL_LOSS, floodsOneIsland, isCoastal, oilOf, pollutionLimit } from './rules';

/** The end-of-turn step (rank 40): roll for a disaster if the track stands at 5, then reset it. */
export function disasterStep(ctx: Ctx) {
  const s = ctx.s;
  const st = oilOf(s);
  if (st.track < TRACK_MAX) return;
  const dice: [number, number] = [ctx.rng.die(), ctx.rng.die()];
  const total = dice[0] + dice[1];
  ctx.emit({ type: 'oil/disaster', player: s.currentPlayer, dice, total });
  st.track = 0;
  if (total === 7) flood(ctx);
  else pollute(ctx, total);
}

/** The island a building stands on (an intersection's land hexes are always one island's). */
const islandOf = (s: GameState, vertex: number): number => {
  const h = s.board.vertices[vertex].hexes.find((x) => isLand(s.board.hexes[x].terrain));
  return h === undefined ? -1 : s.board.hexes[h].island;
};

/** Islands with a land hex still bearing `n`. */
function islandsBearing(s: GameState, n: number): number[] {
  return s.board.islands.filter((isl) => isl.hexes.some((h) => isLand(s.board.hexes[h].terrain) && numbersOf(s, s.board.hexes[h]).includes(n))).map((isl) => isl.id);
}

export function flood(ctx: Ctx) {
  const s = ctx.s;
  let island: number | null = null;
  let number: number | null = null;
  if (floodsOneIsland(s)) {
    // A second roll, not a 7, picks the island: one at random of those still bearing it.
    do number = ctx.rng.die() + ctx.rng.die();
    while (number === 7);
    const candidates = islandsBearing(s, number);
    if (candidates.length === 0) {
      ctx.emit({ type: 'oil/flood', island: null, number, washed: [], dropped: [], lying: [], walls: [], owners: {} });
      return;
    }
    island = candidates.length === 1 ? candidates[0] : candidates[ctx.rng.int(candidates.length)];
  }
  const hit: number[] = [];
  s.buildings.forEach((b, v) => {
    if (b && isCoastal(s, v) && (island === null || islandOf(s, v) === island)) hit.push(v);
  });
  const washed: number[] = [];
  const dropped: number[] = [];
  const lying: number[] = [];
  const walls: number[] = [];
  // (Whose each building was, read before the water takes any of them.)
  const owners: Record<number, PlayerId> = {};
  for (const v of hit) owners[v] = s.buildings[v]!.owner;
  // Settlements go first, so the pieces they free can take the cities that drop.
  for (const v of hit) {
    const b = s.buildings[v]!;
    if (b.kind !== 'settlement') continue;
    const owner = s.players[b.owner];
    // (A city lying down for want of a settlement piece is still a city piece.)
    if (b.lying) owner.citiesLeft++;
    else owner.settlementsLeft++;
    s.buildings[v] = null;
    washed.push(v);
  }
  for (const v of hit) {
    const b = s.buildings[v];
    if (!b || b.kind !== 'city' || b.foundry || b.seat) continue;
    if (b.wall) {
      delete b.wall;
      walls.push(v);
      continue;
    }
    const owner = s.players[b.owner];
    b.kind = 'settlement';
    if (owner.settlementsLeft > 0) {
      owner.settlementsLeft--;
      owner.citiesLeft++;
    } else {
      b.lying = true;
      lying.push(v);
    }
    dropped.push(v);
  }
  // (Only the corners the flood changed keep their owners in the event.)
  const hurt = new Set([...washed, ...dropped, ...walls]);
  ctx.emit({ type: 'oil/flood', island, number, washed, dropped, lying, walls, owners: Object.fromEntries(Object.entries(owners).filter(([v]) => hurt.has(Number(v)))) });
  if (washed.length > 0) updateLongestRoad(ctx);
}

export function pollute(ctx: Ctx, total: number) {
  const s = ctx.s;
  const st = oilOf(s);
  const candidates = s.board.hexes.filter((h) => numbersOf(s, h).includes(total));
  if (candidates.length === 0) {
    ctx.emit({ type: 'oil/spared', number: total });
    return;
  }
  const hex = candidates.length === 1 ? candidates[0] : candidates[ctx.rng.int(candidates.length)];
  if (hex.well) {
    // Up to three oil leave the game: the supply's first, then the players', one at a time from the roller.
    const fromSupply = Math.min(WELL_LOSS, s.bank.oil);
    s.bank.oil -= fromSupply;
    let left = WELL_LOSS - fromSupply;
    const fromHands: Record<number, number> = {};
    const n = s.players.length;
    let moved = true;
    while (left > 0 && moved) {
      moved = false;
      for (let i = 0; i < n && left > 0; i++) {
        const p: PlayerId = (s.currentPlayer + i) % n;
        if (s.players[p].hand.oil === 0) continue;
        s.players[p].hand.oil--;
        fromHands[p] = (fromHands[p] ?? 0) + 1;
        left--;
        moved = true;
      }
    }
    st.destroyed += WELL_LOSS - left;
    ctx.emit({ type: 'oil/wellPolluted', hex: hex.id, fromSupply, fromHands });
    return;
  }
  st.lost.push({ hex: hex.id, number: total });
  ctx.emit({ type: 'oil/polluted', hex: hex.id, number: total, lost: st.lost.length });
  if (st.lost.length >= pollutionLimit(s)) {
    ctx.emit({ type: 'oil/islandLost', steward: st.steward });
    loseGame(ctx, 'The island is lost to pollution.');
  }
}

/**
 * A hex pollution has destroyed: it has lost every number it bore. (One that bore two and lost one
 * still produces on the other; a hex that never had a number, a desert, isn't destroyed.)
 */
export function destroyedHex(s: GameState, hex: number): boolean {
  const lost = s.ext.oil?.lost;
  if (!lost || !lost.some((l) => l.hex === hex)) return false;
  return numbersOf(s, s.board.hexes[hex]).length === 0;
}

/** The numbers a hex still bears: pollution takes one instance of its number for each time it struck. */
export function survivingNumbers(s: GameState, hexId: number, numbers: number[]): number[] {
  const lost = s.ext.oil?.lost;
  if (!lost || lost.length === 0) return numbers;
  let out = numbers;
  for (const l of lost) {
    if (l.hex !== hexId) continue;
    const i = out.indexOf(l.number);
    if (i >= 0) out = [...out.slice(0, i), ...out.slice(i + 1)];
  }
  return out;
}
