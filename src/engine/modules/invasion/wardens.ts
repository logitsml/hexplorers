// Wardens on the edges: who fights, how far they walk at the end of a turn, displacement (with
// the garrisons), and the battles that free raided hexes.
//
// Alone, Invasion's wardens come from the muster deck at the lowest rank and always fight; they
// walk 3 edges, or 5 for a wheat. With the garrisons they keep their ranks and their mustered or
// resting state: only mustered wardens fight, a mustered warden walks 5 edges and rests, a resting
// one walks 3, and losses cost a rank rather than the piece.

import { addCoins, type Ctx } from '../../ctx';
import { checkVictory } from '../../reducer';
import type { GameState, PlayerId, Warden } from '../../types';
import { BATTLE_COINS, inv, withGarrisons } from './raids';
import { edgesWithin, orientationOf, sideOrientation, topology } from './topology';
import type { MarchPending, RetreatPending } from './types';

/** Wardens each player has, alone (they're all of the lowest rank). */
export const WARDENS_PER_PLAYER = 6;
/** Pieces of each rank each player has with the garrisons. */
export const RANK_PIECES = 2;
/** A march's reach alone: 3 edges, or 5 for a wheat. */
export const STRIDE = 3;
export const LONG_STRIDE = 5;
/** How far a displacing warden may go, and how far the displaced one retreats. */
export const DISPLACE_REACH = 3;

/** The warden standing on `edge`, if any. */
export const wardenOn = (s: GameState, edge: number): Warden | undefined => s.wardens.find((w) => w.edge === edge);

/** Whether a warden fights in battles: always alone, only while mustered with the garrisons. */
export const fights = (s: GameState, w: Warden): boolean => !withGarrisons(s) || w.mustered;

/** A warden's strength: its rank. */
const strengthOf = (w: Warden): number => w.rank;

/** The fighting wardens on `hex`'s edges. */
function fightersOn(s: GameState, hex: number): Warden[] {
  const edges = s.board.hexes[hex].edges;
  return s.wardens.filter((w) => w.edge !== null && edges.includes(w.edge) && fights(s, w));
}

/** The strength the wardens on `hex`'s edges would fight with as they stand: a battle there frees it when this beats its raiders. */
export const defenceOn = (s: GameState, hex: number): number => fightersOn(s, hex).reduce((n, w) => n + strengthOf(w), 0);

/** Whether a warden may walk or displace this turn (with the garrisons, not on the turn it was mustered). */
export const canAct = (s: GameState, w: Warden): boolean => w.edge !== null && !(withGarrisons(s) && w.mustered && w.musteredTurn === s.turn);

/** How far a warden may walk: free without paying, and at most with a wheat (alone) or as its state allows (with the garrisons). */
export function strideOf(s: GameState, w: Warden): { free: number; max: number } {
  if (withGarrisons(s)) {
    const n = w.mustered ? LONG_STRIDE : STRIDE;
    return { free: n, max: n };
  }
  return { free: STRIDE, max: LONG_STRIDE };
}

/** An edge a warden may finish on: a home edge, empty, and not the castle's. */
export function restingPlace(s: GameState, edge: number): boolean {
  const t = topology(s.board);
  return t.wardenEdge[edge] && !t.castleEdge[edge] && !wardenOn(s, edge);
}

/**
 * Where a warden may walk, with each edge's distance. A long walk (alone, beyond 3 edges) needs a
 * wheat, so it's offered only while the owner has one. Wardens pass through anything on the way.
 */
export function walkTargets(s: GameState, w: Warden): Map<number, number> {
  const out = new Map<number, number>();
  if (!canAct(s, w)) return out;
  const { free, max } = strideOf(s, w);
  const reach = s.players[w.owner].hand.wheat > 0 ? max : free;
  for (const [e, d] of edgesWithin(s.board, w.edge!, reach)) if (d > 0 && restingPlace(s, e)) out.set(e, d);
  return out;
}

/** Edges a mustered warden may displace onto (with the garrisons): a weaker warden of another player within 3 edges, never on a castle edge. */
export function displaceTargets(s: GameState, w: Warden): number[] {
  if (!withGarrisons(s) || !w.mustered || !canAct(s, w)) return [];
  const t = topology(s.board);
  const out: number[] = [];
  for (const [e, d] of edgesWithin(s.board, w.edge!, DISPLACE_REACH)) {
    if (d === 0 || t.castleEdge[e]) continue;
    const v = wardenOn(s, e);
    if (v && v.owner !== w.owner && v.rank < w.rank) out.push(e);
  }
  return out;
}

/** Where a displaced warden may retreat to from `from`: an empty edge within 3 that isn't the castle's. */
export function retreatTargets(s: GameState, from: number): number[] {
  const out: number[] = [];
  for (const [e, d] of edgesWithin(s.board, from, DISPLACE_REACH)) if (d > 0 && restingPlace(s, e)) out.push(e);
  return out;
}

/** Whether a warden on a castle edge still has to walk off it (it must, unless it has nowhere to go). */
export const mustWalk = (s: GameState, w: Warden): boolean => w.edge !== null && topology(s.board).castleEdge[w.edge] && walkTargets(s, w).size > 0;

/** `player`'s wardens that may still do something this march. */
function marchers(s: GameState, player: PlayerId, acted: readonly number[]): Warden[] {
  return s.wardens.filter((w) => w.owner === player && !acted.includes(w.id) && (walkTargets(s, w).size > 0 || displaceTargets(s, w).length > 0));
}

/** The march (end of turn, rank 10): the player whose turn it is may move their wardens. */
export function startMarch(ctx: Ctx) {
  const s = ctx.s;
  if (marchers(s, s.currentPlayer, []).length === 0) return;
  s.pending.push({ kind: 'invasion/march', players: [s.currentPlayer], data: { acted: [] } satisfies MarchPending });
}

/** After a warden acts: the march ends by itself once none of the player's wardens can do anything more. */
export function maybeEndMarch(ctx: Ctx) {
  const s = ctx.s;
  const top = s.pending[s.pending.length - 1];
  if (top?.kind !== 'invasion/march') return;
  const player = top.players[0];
  const acted = (top.data as MarchPending).acted;
  if (marchers(s, player, acted).length > 0) return;
  s.pending.pop();
  ctx.emit({ type: 'invasion/halted', player, marched: acted.length > 0 });
}

/** A displaced warden with nowhere to go leaves the board; otherwise its owner owes a retreat. */
export function owedRetreat(ctx: Ctx, victim: Warden, from: number) {
  const s = ctx.s;
  if (retreatTargets(s, from).length === 0) {
    s.wardens = s.wardens.filter((w) => w.id !== victim.id);
    ctx.emit({ type: 'invasion/retreated', player: victim.owner, warden: victim.id, to: null });
    return;
  }
  victim.edge = null;
  s.pending.push({ kind: 'invasion/retreat', players: [victim.owner], data: { warden: victim.id, from } satisfies RetreatPending });
}

/**
 * A warden's loss (with the garrisons): it drops to the next lower rank with a piece free, or
 * further, and is removed when none is. Returns its new rank, or null if removed. Alone, it's removed.
 */
function stepDown(s: GameState, w: Warden): number | null {
  if (withGarrisons(s)) {
    for (let r = w.rank - 1; r >= 1; r--) {
      const used = s.wardens.filter((x) => x.owner === w.owner && x.id !== w.id && x.rank === r).length;
      if (used < RANK_PIECES) {
        w.rank = r as Warden['rank'];
        return r;
      }
    }
  }
  s.wardens = s.wardens.filter((x) => x.id !== w.id);
  return null;
}

/**
 * Players from the roller round in turn order, ranked by dice: the first `slots` of them, rolling
 * again among those tied across the cut.
 */
function rollFor(ctx: Ctx, players: PlayerId[], slots: number, rolls: { player: PlayerId; die: number }[]): PlayerId[] {
  const won: PlayerId[] = [];
  let pool = players.slice();
  let need = slots;
  while (need > 0 && pool.length > need) {
    const thrown = pool.map((player) => ({ player, die: ctx.rng.die() }));
    rolls.push(...thrown);
    const faces = [...new Set(thrown.map((t) => t.die))].sort((a, b) => b - a);
    let next: PlayerId[] = [];
    for (const f of faces) {
      const group = thrown.filter((t) => t.die === f).map((t) => t.player);
      if (group.length <= need) {
        won.push(...group);
        need -= group.length;
        if (need === 0) break;
      } else {
        next = group;
        break;
      }
    }
    pool = next;
  }
  if (need > 0) won.push(...pool.slice(0, need));
  return won;
}

/**
 * The battles (end of turn, rank 20): every coastal hex holding a raider, clockwise from the
 * castle. The fighting wardens on its edges free it when their strength beats its raiders; the
 * raiders become prisoners, shared among the participants, and a die then picks an edge
 * orientation whose participating wardens fall. Each hex is fought with the wardens as they stand
 * after the one before.
 */
export function fightBattles(ctx: Ctx) {
  const s = ctx.s;
  const i = inv(s);
  const n = s.players.length;
  const turnOrder = (ps: Iterable<PlayerId>) => [...ps].sort((a, b) => ((a - s.currentPlayer + n) % n) - ((b - s.currentPlayer + n) % n));
  for (const hex of topology(s.board).coast) {
    const raiders = i.raiders[hex];
    if (raiders < 1) continue;
    const fighters = fightersOn(s, hex);
    if (fighters.length === 0) continue;
    const strengthBy = new Map<PlayerId, number>();
    for (const w of fighters) strengthBy.set(w.owner, (strengthBy.get(w.owner) ?? 0) + strengthOf(w));
    const strength = [...strengthBy.values()].reduce((a, b) => a + b, 0);
    const participants = turnOrder(strengthBy.keys());
    // (Not enough to beat them: nothing happens.)
    if (strength <= raiders) continue;
    const prisoners: Record<number, number> = {};
    const coins: Record<number, number> = {};
    const rolls: { player: PlayerId; die: number }[] = [];
    i.raiders[hex] = 0;
    const give = (p: PlayerId, k: number) => (prisoners[p] = (prisoners[p] ?? 0) + k);
    const pay = (p: PlayerId) => (coins[p] = (coins[p] ?? 0) + BATTLE_COINS);
    if (participants.length === 1) give(participants[0], raiders);
    else if (raiders >= participants.length) {
      for (const p of participants) give(p, 1);
      const left = raiders - participants.length;
      if (left > 0) {
        // The rest go to the greatest strength; tied players roll, and each who loses takes coins.
        const top = Math.max(...strengthBy.values());
        const tied = participants.filter((p) => strengthBy.get(p) === top);
        const winner = tied.length === 1 ? tied[0] : rollFor(ctx, tied, 1, rolls)[0];
        give(winner, left);
        for (const p of tied) if (p !== winner) pay(p);
      }
    } else {
      // Too few to go round: everyone rolls, prisoners go from the highest down, the rest take coins.
      const lucky = rollFor(ctx, participants, raiders, rolls);
      for (const p of participants) {
        if (lucky.includes(p)) give(p, 1);
        else pay(p);
      }
    }
    for (const [p, k] of Object.entries(prisoners)) i.prisoners[Number(p)] += k;
    ctx.emit({ type: 'invasion/battle', hex, raiders, conquered: raiders >= 3, strength, participants, prisoners, coins, rolls });
    for (const [p, k] of Object.entries(coins)) addCoins(ctx, Number(p), k, 'battle');

    // Losses: the participating wardens on the edges of the picked orientation.
    const die = ctx.rng.die();
    const side = orientationOf(die);
    const lost: { warden: number; owner: PlayerId; rank: number; to: number | null }[] = [];
    for (const w of fighters) {
      if (sideOrientation(s.board, hex, w.edge!) !== side) continue;
      const rank = w.rank;
      lost.push({ warden: w.id, owner: w.owner, rank, to: stepDown(s, w) });
    }
    ctx.emit({ type: 'invasion/losses', hex, die, wardens: lost });
    for (const l of lost) addCoins(ctx, l.owner, BATTLE_COINS, 'wardenLost');
  }
  // Prisoners are points: the player whose turn it is may have won.
  checkVictory(ctx);
}
