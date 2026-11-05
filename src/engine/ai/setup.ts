// Opening placement: score intersections by pips, diversity, board scarcity, ports and fit with the
// first settlement; point the starting road at the best follow-up spot.

import { TERRAIN_RESOURCE, emptyCards } from '../constants';
import { hexPips, legalSetupRoads, legalSetupSettlements, numbersOf, satisfiesDistanceRule } from '../rules';
import type { Action, CardCounts } from '../types';
import { RESOURCES } from '../types';
import { modulesOf } from '../modules';
import { moduleSpotBonus, moduleSpotValue, type BotCtx } from './context';

interface SpotInfo {
  pips: CardCounts;
  numbers: number[];
  value: number;
}

function spotInfo(ctx: BotCtx, v: number): SpotInfo {
  const s = ctx.s;
  const pips = emptyCards();
  const numbers: number[] = [];
  let value = 0;
  for (const h of s.board.vertices[v].hexes) {
    const hex = s.board.hexes[h];
    const r = TERRAIN_RESOURCE[hex.terrain];
    const nums = numbersOf(s, hex);
    if (!r || nums.length === 0) continue;
    const p = hexPips(s, hex);
    pips[r] += p;
    numbers.push(...nums);
    value += p * ctx.resVal[r];
  }
  value += moduleSpotValue(ctx, v);
  return { pips, numbers, value };
}

function ownSettlements(ctx: BotCtx): number[] {
  const out: number[] = [];
  ctx.s.buildings.forEach((b, v) => {
    if (b && b.owner === ctx.me) out.push(v);
  });
  return out;
}

function setupScore(ctx: BotCtx, v: number, existing: SpotInfo | null): number {
  const s = ctx.s;
  const info = spotInfo(ctx, v);
  const combined = existing ? RESOURCES.map((r) => existing.pips[r] + info.pips[r]) : RESOURCES.map((r) => info.pips[r]);
  const has = (r: (typeof RESOURCES)[number]) => combined[RESOURCES.indexOf(r)] > 0;
  const distinctHere = RESOURCES.filter((r) => info.pips[r] > 0).length;
  let score = info.value;

  if (!existing) {
    score += ctx.prof.setupDiversity * distinctHere;
    if (info.pips.brick > 0 && info.pips.wood > 0) score += 0.5 * ctx.prof.setupBrickWood;
    if (info.pips.wheat > 0 && info.pips.ore > 0) score += 0.6 * ctx.prof.setupWheatOre;
  } else {
    const before = RESOURCES.filter((r) => existing.pips[r] > 0).length;
    const after = RESOURCES.filter((r) => has(r)).length;
    score += (ctx.prof.setupDiversity + 0.1) * (after - before) + 0.2 * distinctHere;
    score += has('brick') && has('wood') ? ctx.prof.setupBrickWood : -0.6 * ctx.prof.setupBrickWood;
    if (has('wheat') && has('ore')) score += ctx.prof.setupWheatOre;
    score -= 0.35 * (RESOURCES.length - after);
    // Starting cards from the second settlement: brick and wood allow an early road/settlement.
    if (info.pips.brick > 0) score += 0.15;
    if (info.pips.wood > 0) score += 0.15;
    for (const n of info.numbers) if (existing.numbers.includes(n)) score -= 0.25;
  }

  const port = s.board.vertices[v].port;
  const totalCombined = combined.reduce((a, b) => a + b, 0);
  if (port === 'any') score += ctx.prof.setupAnyPort + 0.03 * totalCombined;
  else if (port) {
    const own = combined[RESOURCES.indexOf(port)];
    score += own >= 4 ? 0.12 * own : 0.1;
  }

  if (ctx.prof.setupLookahead > 0) {
    // Expansion potential: best still-open spot two edges away.
    let best = 0;
    for (const u of s.board.vertices[v].neighbors) {
      for (const w of s.board.vertices[u].neighbors) {
        if (w === v || s.board.vertices[v].neighbors.includes(w)) continue;
        if (!satisfiesDistanceRule(s, w)) continue;
        best = Math.max(best, spotInfo(ctx, w).value);
      }
    }
    score += ctx.prof.setupLookahead * best;
  }
  // What the modules see in the spot, from victory-point equivalents to these pip-value units
  // (spotValue counts a pip of value as a tenth of a point).
  return score + 10 * moduleSpotBonus(ctx, v);
}

function pickWeighted<T>(ctx: BotCtx, scored: { item: T; score: number }[]): T {
  scored.sort((a, b) => b.score - a.score);
  if (ctx.prof.setupPick === 'best' || scored.length === 1) return scored[0].item;
  if (ctx.prof.setupPick === 'nearBest') {
    // Mostly the best; occasionally a near-equal alternative for variety.
    const top = scored.filter((x) => x.score >= scored[0].score - 0.4).slice(0, 3);
    return top[ctx.rng.int(top.length)].item;
  }
  const top = scored.slice(0, 6);
  const weights = top.map((x) => Math.exp((x.score - top[0].score) / 1.5));
  let t = ctx.rng.next() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < top.length; i++) {
    t -= weights[i];
    if (t <= 0) return top[i].item;
  }
  return top[0].item;
}

export function chooseSetupSettlement(ctx: BotCtx): Action {
  const mine = ownSettlements(ctx);
  const existing = mine.length > 0 ? spotInfo(ctx, mine[0]) : null;
  const scored = legalSetupSettlements(ctx.s).map((v) => ({ item: v, score: setupScore(ctx, v, existing) }));
  return { type: 'placeSetupSettlement', vertex: pickWeighted(ctx, scored) };
}

/** Each legal starting road with its score: the spots it points at, near (a settlement) and far (two), and the room to branch. */
function roadScores(ctx: BotCtx): { item: number; score: number }[] {
  const s = ctx.s;
  const v = s.lastSetupSettlement!;
  return legalSetupRoads(s).map((e) => {
    const ed = s.board.edges[e];
    const u = ed.a === v ? ed.b : ed.a;
    let near = 0;
    let far = 0;
    for (const w of s.board.vertices[u].neighbors) {
      if (w === v) continue;
      if (satisfiesDistanceRule(s, w)) near = Math.max(near, spotInfo(ctx, w).value + (s.board.vertices[w].port ? 0.6 : 0));
      for (const x of s.board.vertices[w].neighbors) {
        if (x === u || !satisfiesDistanceRule(s, x)) continue;
        far = Math.max(far, spotInfo(ctx, x).value);
      }
    }
    const openEdges = s.board.vertices[u].edges.filter((x) => s.routes[x] === null).length;
    return { item: e, score: near + 0.35 * far + 0.2 * openEdges };
  });
}

export function chooseSetupRoad(ctx: BotCtx): Action {
  const scored = roadScores(ctx);
  // A module may prefer another kind of piece for the start (a ship toward a first landing).
  const best = scored.length > 0 ? Math.max(...scored.map((x) => x.score)) : 0;
  for (const m of modulesOf(ctx.s)) {
    const a = m.bot?.setupRoute?.(ctx, best);
    if (a) return a;
  }
  return { type: 'placeSetupRoad', edge: pickWeighted(ctx, scored) };
}
