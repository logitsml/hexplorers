// The garrisons' actions: recruiting, promoting and mustering wardens, walls, and a mustered
// warden's march, displacement and chase, plus the retreat a displacement leaves owed.
// `legalGarrisons` lists exactly what `handleGarrisons` accepts.

import { cards } from '../../constants';
import { type Ctx, assert, fail, moveCards, validIndex } from '../../ctx';
import { doSteal } from '../../reducer';
import { canTakeOil, stealableCount, theftChoices } from '../../rules';
import type { Action, GameState, PlayerId } from '../../types';
import { corsairHex, setCorsair } from '../shared';
import type { GarrisonsAction, RetreatPending } from './types';
import {
  WALL_LIMIT,
  canAct,
  canMuster,
  castleEdges,
  chaseOptions,
  displaceTargets,
  freePieces,
  invaded,
  muster,
  placeWarden,
  promote,
  promoteBlocker,
  reach,
  recruitSpots,
  retreatSpots,
  unseat,
  wallSites,
  wardenById,
  wardensChanged,
  wardensOf,
} from './wardens';

/** Recruiting and promoting cost a wool and an ore; mustering a wheat; a wall two brick. */
export const RECRUIT_COST = cards({ wool: 1, ore: 1 });
export const PROMOTE_COST = cards({ wool: 1, ore: 1 });
export const MUSTER_COST = cards({ wheat: 1 });
export const WALL_COST = cards({ brick: 2 });

export const has = (s: GameState, p: PlayerId, cost: ReturnType<typeof cards>) => (['brick', 'wool', 'wheat', 'ore'] as const).every((k) => s.players[p].hand[k] >= cost[k]);

function requireMain(s: GameState, player: PlayerId) {
  assert(s.pending.length === 0, 'Another decision has to be made first.');
  assert(player === s.currentPlayer, 'It is not your turn.');
  assert(s.phase === 'main', `Not allowed during ${s.phase}.`);
}

/** A warden of `player`'s that may act now. */
function actor(s: GameState, player: PlayerId, id: number) {
  const w = wardenById(s, id);
  assert(w && w.owner === player, 'That is not your warden.');
  assert(!invaded(s), 'Wardens march at the end of the turn in this game.');
  assert(canAct(s, w), w.mustered ? 'A warden mustered this turn cannot act yet.' : 'Only a mustered warden can act.');
  return w;
}

export function handleGarrisons(ctx: Ctx, player: PlayerId, a: GarrisonsAction) {
  const s = ctx.s;
  if (a.type === 'garrisons/retreat') {
    const top = s.pending[s.pending.length - 1];
    assert(top && top.kind === 'garrisons/retreat' && top.players.includes(player), 'You have no warden to move.');
    const d = top.data as RetreatPending;
    assert(validIndex(a.vertex, s.board.vertices.length) && retreatSpots(s, d).includes(a.vertex), 'Your warden must retreat along your routes to an empty intersection.');
    const w = wardenById(s, d.warden)!;
    s.pending.pop();
    w.vertex = a.vertex;
    ctx.emit({ type: 'garrisons/retreated', player, warden: w.id, from: d.from, to: a.vertex });
    wardensChanged(ctx);
    return;
  }
  requireMain(s, player);
  switch (a.type) {
    case 'garrisons/recruit': {
      assert(freePieces(s, player, 1) > 0, 'You have no recruit left: promote one first.');
      assert(has(s, player, RECRUIT_COST), 'A recruit costs a wool and an ore.');
      let at: { vertex: number | null; edge: number | null };
      if (invaded(s)) {
        assert(a.vertex === undefined && a.edge !== undefined && castleEdges(s).includes(a.edge), 'Recruits muster on an empty edge of the castle.');
        at = { vertex: null, edge: a.edge };
      } else {
        assert(a.edge === undefined && a.vertex !== undefined && recruitSpots(s, player).includes(a.vertex), 'A recruit stands on an empty intersection beside your routes.');
        at = { vertex: a.vertex, edge: null };
      }
      moveCards(ctx, player, null, RECRUIT_COST, 'recruit');
      const w = placeWarden(s, player, 1, at);
      ctx.emit({ type: 'garrisons/recruited', player, warden: w.id, vertex: w.vertex, edge: w.edge });
      wardensChanged(ctx);
      return;
    }
    case 'garrisons/promote': {
      const w = wardenById(s, a.warden);
      const why = promoteBlocker(s, player, w);
      assert(why === null, why ?? '');
      assert(has(s, player, PROMOTE_COST), 'Promotion costs a wool and an ore.');
      moveCards(ctx, player, null, PROMOTE_COST, 'promotion');
      promote(ctx, w!, false);
      return;
    }
    case 'garrisons/muster': {
      const w = wardenById(s, a.warden);
      assert(canMuster(s, player, w), 'That warden cannot be mustered.');
      assert(has(s, player, MUSTER_COST), 'Mustering costs a wheat.');
      moveCards(ctx, player, null, MUSTER_COST, 'muster');
      muster(s, w!);
      ctx.emit({ type: 'garrisons/mustered', player, wardens: [w!.id], free: false });
      return;
    }
    case 'garrisons/wall': {
      assert(validIndex(a.vertex, s.board.vertices.length) && wallSites(s, player).includes(a.vertex), `A wall goes under one of your towns without one (at most ${WALL_LIMIT}).`);
      assert(has(s, player, WALL_COST), 'A wall costs two brick.');
      moveCards(ctx, player, null, WALL_COST, 'wall');
      s.buildings[a.vertex]!.wall = true;
      ctx.emit({ type: 'garrisons/wall', player, vertex: a.vertex, free: false });
      return;
    }
    case 'garrisons/march': {
      const w = actor(s, player, a.warden);
      assert(validIndex(a.vertex, s.board.vertices.length) && reach(s, player, w.vertex!).stops.includes(a.vertex), 'Wardens march along your routes to an empty intersection.');
      const from = w.vertex!;
      w.vertex = a.vertex;
      w.mustered = false;
      ctx.emit({ type: 'garrisons/marched', player, warden: w.id, from, to: a.vertex });
      wardensChanged(ctx);
      return;
    }
    case 'garrisons/displace': {
      const w = actor(s, player, a.warden);
      assert(displaceTargets(s, w).includes(a.target), 'You can only displace a weaker warden you can reach along your routes.');
      const t = wardenById(s, a.target)!;
      const from = w.vertex!;
      const at = t.vertex!;
      // The displacer takes the spot first; the displaced warden then retreats from there.
      w.vertex = at;
      w.mustered = false;
      ctx.emit({ type: 'garrisons/displaced', player, warden: w.id, target: t.id, targetOwner: t.owner, from: at });
      unseat(ctx, t);
      ctx.emit({ type: 'garrisons/marched', player, warden: w.id, from, to: at });
      wardensChanged(ctx);
      return;
    }
    case 'garrisons/chase': {
      const w = actor(s, player, a.warden);
      assert(a.blocker === 'robber' || a.blocker === 'corsair', 'Unknown blocker.');
      const opt = chaseOptions(s, w, a.blocker).find((o) => o.hex === a.hex);
      assert(opt, a.blocker === 'robber' ? 'Your warden must stand beside the robber, and send it to another hex.' : 'Your warden must stand beside the corsair, and send it to another sea hex.');
      if (opt.victims.length > 0) {
        assert(a.victim !== undefined && opt.victims.includes(a.victim), 'Choose whom to rob.');
        assert(a.oil ? canTakeOil(s, player, a.victim) : stealableCount(s, a.victim) > 0, a.oil ? 'You have no room for their oil.' : 'They have no card to take.');
      } else assert(a.victim === undefined && !a.oil, 'There is nobody to rob there.');
      const from = a.blocker === 'robber' ? s.robberHex : corsairHex(s);
      if (a.blocker === 'robber') {
        s.robberHex = a.hex;
        ctx.emit({ type: 'robberMoved', player, from, to: a.hex });
      } else setCorsair(s, a.hex);
      ctx.emit({ type: 'garrisons/chased', player, warden: w.id, blocker: a.blocker, from, to: a.hex });
      w.mustered = false;
      if (a.victim !== undefined) doSteal(ctx, player, a.victim, !!a.oil, 'warden');
      else ctx.emit({ type: 'nothingToSteal', player });
      return;
    }
    default: {
      const never: never = a;
      fail(`Unknown action ${(never as Action).type}`);
    }
  }
}

export function legalGarrisons(s: GameState, player: PlayerId): Action[] {
  const top = s.pending[s.pending.length - 1];
  if (top) {
    if (top.kind !== 'garrisons/retreat' || !top.players.includes(player)) return [];
    return retreatSpots(s, top.data as RetreatPending).map((vertex) => ({ type: 'garrisons/retreat', vertex }));
  }
  if (player !== s.currentPlayer || s.phase !== 'main') return [];
  const out: Action[] = [];
  const mine = wardensOf(s, player);
  if (has(s, player, WALL_COST)) for (const vertex of wallSites(s, player)) out.push({ type: 'garrisons/wall', vertex });
  if (has(s, player, RECRUIT_COST) && freePieces(s, player, 1) > 0) {
    if (invaded(s)) for (const edge of castleEdges(s)) out.push({ type: 'garrisons/recruit', edge });
    else for (const vertex of recruitSpots(s, player)) out.push({ type: 'garrisons/recruit', vertex });
  }
  if (has(s, player, PROMOTE_COST)) for (const w of mine) if (promoteBlocker(s, player, w) === null) out.push({ type: 'garrisons/promote', warden: w.id });
  if (has(s, player, MUSTER_COST)) for (const w of mine) if (canMuster(s, player, w)) out.push({ type: 'garrisons/muster', warden: w.id });
  for (const w of mine) {
    if (!canAct(s, w)) continue;
    for (const vertex of reach(s, player, w.vertex!).stops) out.push({ type: 'garrisons/march', warden: w.id, vertex });
    for (const target of displaceTargets(s, w)) out.push({ type: 'garrisons/displace', warden: w.id, target });
    for (const blocker of ['robber', 'corsair'] as const) {
      for (const { hex, victims } of chaseOptions(s, w, blocker)) {
        if (victims.length === 0) out.push({ type: 'garrisons/chase', warden: w.id, blocker, hex });
        else for (const victim of victims) for (const t of theftChoices(s, player, victim)) out.push({ type: 'garrisons/chase', warden: w.id, blocker, hex, ...t });
      }
    }
  }
  return out;
}
