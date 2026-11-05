// Sea Lanes' actions, and the steps the rest of the engine (or another module) can take through
// it: building and moving ships, the blocker choice after a 7 or a Knight, and bounty picks.

import { emptyCards } from '../../constants';
import { Ctx, assert, fail, moveCards, validIndex } from '../../ctx';
import { built, doSteal, finishFreeRoute, finishRobber, finishSetupPlacement, moved } from '../../reducer';
import { canTakeOil, hasResources, legalRobberHexes, stealCandidates } from '../../rules';
import type { Action, PlayerId, Resource } from '../../types';
import { RESOURCES } from '../../types';
import { modulesOf } from '../index';
import { BOUNTY_PICK, pickSize } from './bounty';
import { revealBeside } from './fog';
import {
  SHIP_COST,
  anyVictims,
  corsairHexes,
  corsairVictims,
  isLegalMove,
  isLegalShip,
  legalSetupShips,
  seaState,
} from './rules';
import type { BlockerChoice, BountyOwed, SeaAction } from './types';

export const BLOCKER = 'sea/blocker';

/** Whom a blocker step robs once the corsair has moved: ship owners on its hex, or (Invasion's 7) anyone. */
export type CorsairVictims = 'ships' | 'anyone';

/** The decision a 7 or a Knight leaves when the corsair can move: robber or corsair, and where. */
export interface BlockerPending extends BlockerChoice {
  /** Whether the robber is a choice (an invader may have taken it off the board). */
  robber: boolean;
  victims: CorsairVictims;
}

/**
 * Leave the player whose turn it is the blocker choice: move the robber to a land hex, or the
 * corsair to a sea hex. Returns false when the corsair can't move (no open water), leaving the
 * robber's step to the base game. The mixing phase can offer the corsair alone, robbing anyone.
 */
export function offerBlockers(ctx: Ctx, cause: 'seven' | 'knight', opts: { robber?: boolean; victims?: CorsairVictims } = {}): boolean {
  const s = ctx.s;
  if (corsairHexes(s).length === 0) return false;
  const robber = (opts.robber ?? true) && legalRobberHexes(s).length > 0;
  s.phase = 'moveRobber';
  s.pending.push({ kind: BLOCKER, players: [s.currentPlayer], data: { cause, robber, victims: opts.victims ?? 'ships' } satisfies BlockerPending });
  return true;
}

/** After a blocker has moved: rob the one candidate, leave a choice of several, or carry on. */
function rob(ctx: Ctx, thief: PlayerId, candidates: PlayerId[]) {
  const s = ctx.s;
  if (candidates.length === 0) {
    ctx.emit({ type: 'nothingToSteal', player: thief });
    finishRobber(ctx);
  } else if (candidates.length === 1 && !canTakeOil(s, thief, candidates[0])) {
    doSteal(ctx, thief, candidates[0]);
    finishRobber(ctx);
  } else {
    // (A lone victim with oil to name is still a choice: a card at random, or the oil.)
    s.stealCandidates = candidates;
    s.phase = 'steal';
  }
}

/**
 * Move the corsair to `hex` and rob: a ship owner on its edges, or (with `victims: 'anyone'`, the
 * flagship's 7 under Invasion) any player. The steal follows the base game's: one card at random,
 * the thief choosing among several victims.
 */
export function corsairRaid(ctx: Ctx, player: PlayerId, hex: number, victims: CorsairVictims = 'ships') {
  const s = ctx.s;
  const st = seaState(s);
  const from = st.corsair;
  st.corsair = hex;
  ctx.emit({ type: 'sea/corsairMoved', player, from, to: hex });
  rob(ctx, player, victims === 'ships' ? corsairVictims(s, hex, player) : anyVictims(s, player));
}

function requireTurn(ctx: Ctx, player: PlayerId, phase: string) {
  assert(ctx.s.phase === phase, `Not allowed during ${ctx.s.phase}.`);
  assert(player === ctx.s.currentPlayer, 'It is not your turn.');
}

/** The pending decision on top, if it's `kind` and `player` owes it. */
function owed(ctx: Ctx, player: PlayerId, kind: string) {
  const top = ctx.s.pending[ctx.s.pending.length - 1];
  assert(top && top.kind === kind, 'That decision is not owed now.');
  assert(top.players.includes(player), 'That decision is not yours.');
  return top;
}

function placeShip(ctx: Ctx, player: PlayerId, edge: number, free: boolean, setup: boolean) {
  const s = ctx.s;
  s.routes[edge] = { owner: player, kind: 'ship', builtTurn: s.turn };
  seaState(s).shipsLeft[player]--;
  ctx.emit({ type: 'sea/shipBuilt', player, edge, free, setup });
}

export function handleSea(ctx: Ctx, player: PlayerId, action: Action) {
  const s = ctx.s;
  const st = seaState(s);
  const a = action as SeaAction;
  switch (a.type) {
    case 'sea/buildShip': {
      assert(s.pending.length === 0, 'Another decision has to be made first.');
      requireTurn(ctx, player, 'main');
      assert(validIndex(a.edge, s.board.edges.length), 'Invalid edge.');
      assert(st.shipsLeft[player] > 0, 'You have no ships left.');
      assert(hasResources(s.players[player].hand, SHIP_COST), 'You cannot afford a ship.');
      assert(isLegalShip(s, player, a.edge), 'A ship must join your own ship or building, on open water clear of the corsair.');
      moveCards(ctx, player, null, SHIP_COST, 'ship');
      placeShip(ctx, player, a.edge, false, false);
      built(ctx, player, 'ship', a.edge, true);
      return;
    }
    case 'sea/moveShip': {
      assert(s.pending.length === 0, 'Another decision has to be made first.');
      requireTurn(ctx, player, 'main');
      assert(validIndex(a.from, s.board.edges.length) && validIndex(a.to, s.board.edges.length), 'Invalid edge.');
      assert(st.movedTurn[player] !== s.turn, 'One ship move a turn.');
      assert(isLegalMove(s, player, a.from, a.to), 'That ship cannot move there.');
      s.routes[a.to] = s.routes[a.from];
      s.routes[a.from] = null;
      st.movedTurn[player] = s.turn;
      ctx.emit({ type: 'sea/shipMoved', player, from: a.from, to: a.to });
      revealBeside(ctx, player, a.to);
      // (The other modules' after-move hooks, then the route and the victory check.)
      moved(ctx, player, 'ship', a.from, a.to);
      return;
    }
    case 'sea/placeFreeShip': {
      assert(s.pending.length === 0, 'Another decision has to be made first.');
      requireTurn(ctx, player, 'roadBuilding');
      assert(validIndex(a.edge, s.board.edges.length), 'Invalid edge.');
      assert(s.freeRoadsLeft > 0, 'No free pieces left.');
      assert(st.shipsLeft[player] > 0, 'You have no ships left.');
      assert(isLegalShip(s, player, a.edge), 'A ship must join your own ship or building, on open water clear of the corsair.');
      s.freeRoadsLeft--;
      placeShip(ctx, player, a.edge, true, false);
      built(ctx, player, 'ship', a.edge, true);
      if (s.phase === 'gameOver') return;
      finishFreeRoute(ctx, player);
      return;
    }
    case 'sea/placeSetupShip': {
      assert(s.pending.length === 0, 'Another decision has to be made first.');
      requireTurn(ctx, player, 'setupRoad');
      assert(legalSetupShips(s).includes(a.edge), 'A starting ship goes on open water beside the building you just placed.');
      placeShip(ctx, player, a.edge, false, true);
      for (const m of modulesOf(s)) m.hooks?.afterSetupPiece?.(ctx, player, 'ship', a.edge);
      finishSetupPlacement(ctx);
      return;
    }
    case 'sea/moveRobber': {
      const top = owed(ctx, player, BLOCKER);
      const data = top.data as BlockerPending;
      assert(data.robber, 'The robber cannot move now.');
      assert(Number.isInteger(a.hex) && legalRobberHexes(s).includes(a.hex), 'The robber cannot go there.');
      s.pending.pop();
      const from = s.robberHex;
      s.robberHex = a.hex;
      ctx.emit({ type: 'robberMoved', player, from, to: a.hex });
      rob(ctx, player, stealCandidates(s, a.hex, player));
      return;
    }
    case 'sea/moveCorsair': {
      const top = owed(ctx, player, BLOCKER);
      assert(Number.isInteger(a.hex) && corsairHexes(s).includes(a.hex), 'The corsair cannot go there.');
      s.pending.pop();
      corsairRaid(ctx, player, a.hex, (top.data as BlockerPending).victims);
      return;
    }
    case 'sea/pickBounty': {
      const top = owed(ctx, player, BOUNTY_PICK);
      const data = top.data as BountyOwed;
      assert(Array.isArray(a.resources) && Array.from(a.resources).every((r) => RESOURCES.includes(r)), 'A bounty pick is resources only.');
      const size = pickSize(s, top);
      assert(a.resources.length === size, `Choose ${size} resource${size === 1 ? '' : 's'}.`);
      const want = new Map<Resource, number>();
      for (const r of a.resources) want.set(r, (want.get(r) ?? 0) + 1);
      for (const [r, k] of want) assert(s.bank[r] >= k, `The supply has too little ${r}.`);
      const got = emptyCards();
      for (const r of a.resources) got[r]++;
      moveCards(ctx, null, player, got, 'bounty');
      s.pending.pop();
      ctx.emit({ type: 'sea/bountyPicked', player, resources: [...a.resources], reason: data.reason });
      return;
    }
    default:
      fail(`Unknown action ${(a as Action).type}`);
  }
}
