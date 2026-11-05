// Sea Lanes: ships on the sea edges, bounty fields, the corsair, and the objectives a sea map is
// played for (First Landing and Fog). See docs/expansions.md and docs/all-hands.md. A ship costs
// 1 wood + 1 wool, each player has 15, and a first landing is worth 2.

import { legalRobberHexes } from '../../rules';
import type { Action, GameState, PlayerId } from '../../types';
import type { RuleModule } from '../api';
import { corsairStays } from '../shared';
import { BOUNTY_PICK, oweBounty, pickOptions, pickSize } from './bounty';
import { seaBot } from './bot';
import { revealBeside, seenBoard, seenOptions } from './fog';
import { BLOCKER, handleSea, offerBlockers, type BlockerPending } from './handle';
import {
  FIRST_LANDING_POINTS,
  SHIPS,
  SHIP_COST,
  bountyOwed,
  corsairHexes,
  isHidden,
  isKnownLand,
  isOpenSea,
  islandOf,
  legalMoves,
  legalSetupShips,
  legalShips,
  onHome,
  seaState,
} from './rules';
import type { SeaState } from './types';

export { corsairRaid, offerBlockers, type CorsairVictims } from './handle';
export { SHIPS, SHIP_COST, FIRST_LANDING_POINTS } from './rules';

function legal(s: GameState, player: PlayerId): Action[] {
  const st = seaState(s);
  const top = s.pending[s.pending.length - 1];
  if (top) {
    if (!top.players.includes(player)) return [];
    if (top.kind === BLOCKER) {
      const out: Action[] = [];
      if ((top.data as BlockerPending).robber) for (const hex of legalRobberHexes(s)) out.push({ type: 'sea/moveRobber', hex });
      for (const hex of corsairHexes(s)) out.push({ type: 'sea/moveCorsair', hex });
      return out;
    }
    if (top.kind === BOUNTY_PICK) return pickOptions(s.bank, pickSize(s, top)).map((resources) => ({ type: 'sea/pickBounty', resources }));
    return [];
  }
  if (player !== s.currentPlayer) return [];
  switch (s.phase) {
    case 'setupRoad':
      return legalSetupShips(s).map((edge) => ({ type: 'sea/placeSetupShip', edge }));
    case 'roadBuilding':
      return s.freeRoadsLeft > 0 ? legalShips(s, player).map((edge) => ({ type: 'sea/placeFreeShip', edge })) : [];
    case 'main': {
      const out: Action[] = [];
      const hand = s.players[player].hand;
      if (st.shipsLeft[player] > 0 && hand.wood >= SHIP_COST.wood && hand.wool >= SHIP_COST.wool) {
        for (const edge of legalShips(s, player)) out.push({ type: 'sea/buildShip', edge });
      }
      for (const [from, to] of legalMoves(s, player)) out.push({ type: 'sea/moveShip', from, to });
      return out;
    }
    default:
      return [];
  }
}

function invariants(s: GameState): string[] {
  const st = s.ext.sea;
  if (!st) return ['no sea state'];
  const out: string[] = [];
  const ships = s.players.map(() => 0);
  s.routes.forEach((r, e) => {
    if (r?.kind !== 'ship') return;
    ships[r.owner]++;
    if (!s.board.edges[e].sea) out.push(`a ship on land edge ${e}`);
  });
  s.players.forEach((p) => {
    if (st.shipsLeft[p.id] < 0 || st.shipsLeft[p.id] + ships[p.id] !== SHIPS) out.push(`player ${p.id} ships ${st.shipsLeft[p.id]}+${ships[p.id]}`);
    if (st.movedTurn[p.id] > s.turn) out.push(`player ${p.id} moved a ship in a later turn`);
  });
  if (st.corsair !== null && !isOpenSea(s, st.corsair)) out.push(`the corsair on ${st.corsair}, not open water`);
  if (st.landed) {
    st.landed.forEach((islands, p) => {
      if (new Set(islands).size !== islands.length) out.push(`player ${p} landed twice on an island`);
      if (islands.some((i) => !s.board.islands[i] || s.board.islands[i].home)) out.push(`player ${p} landed on home`);
    });
  }
  if (st.fog) {
    const f = st.fog;
    if (f.pool.length + Object.keys(f.drawn).length !== f.discs) out.push('fog number discs not conserved');
    for (const h of f.hidden) {
      if (f.drawn[h] !== undefined) out.push(`face-down hex ${h} has a number`);
      for (const v of s.board.hexes[h].vertices) if (s.buildings[v]) out.push(`a building beside face-down hex ${h}`);
    }
  }
  return out;
}

export const sea: RuleModule = {
  id: 'sea',
  rulesVersion: 1,

  init(s) {
    const objectives = s.board.objectives ?? [];
    const st: SeaState = {
      corsair: s.board.features.corsair ?? null,
      shipsLeft: s.players.map(() => SHIPS),
      movedTurn: s.players.map(() => -1),
    };
    if (objectives.some((o) => o.id === 'firstLanding')) st.landed = s.players.map(() => []);
    const fog = objectives.find((o) => o.id === 'fog');
    if (fog) st.fog = { hidden: [...(fog.hexes ?? [])], pool: [...(fog.numbers ?? [])], drawn: {}, discs: fog.numbers?.length ?? 0 };
    s.ext.sea = st;
  },

  handle: handleSea,
  legal,

  hooks: {
    afterSetupPiece(ctx, player, piece, at) {
      if (piece === 'road' || piece === 'ship' || piece === 'bridge') revealBeside(ctx, player, at);
    },

    numbersOf(s, hex, numbers) {
      const drawn = s.ext.sea?.fog?.drawn[hex.id];
      return drawn === undefined ? numbers : [...numbers, drawn];
    },

    afterProduction(ctx, total) {
      const owed = bountyOwed(ctx.s, total);
      oweBounty(ctx, owed, 'production');
      return [...owed.keys()].filter((p) => owed.get(p)! > 0);
    },
    afterYields(s, player, total) {
      const picks = bountyOwed(s, total).get(player) ?? 0;
      return picks > 0 ? { picks } : undefined;
    },

    robberStep(ctx, cause) {
      // Invasion takes over the 7's theft, and so removes every blocker (rule 4): its own step then
      // steals from anyone. Where the corsair stays (the corsairStays knob, All Hands' decision 1),
      // every 7 still moves it, and its theft may take from anyone, as Invasion's own 7 would.
      if (ctx.s.options.modules.includes('invasion')) return corsairStays(ctx.s) && offerBlockers(ctx, cause, { robber: false, victims: 'anyone' });
      return offerBlockers(ctx, cause);
    },

    robberHexes(s, hexes) {
      return s.ext.sea?.fog ? hexes.filter((h) => !isHidden(s, h)) : hexes;
    },

    placeReason: (s, _player, piece, _at) => s.phase === 'setupSettlement' ? 'Place your starting house on a home island' : piece === 'ship' ? 'A ship needs open water in view' : 'Explore the neighbouring fog before building here',
    canPlace(s, _player, piece, at) {
      // Set-up goes on a home island.
      if (s.phase === 'setupSettlement' && (piece === 'settlement' || piece === 'city') && !onHome(s, at)) return false;
      if (!s.ext.sea?.fog) return true;
      // Fog: nothing is built on what nobody has seen. A road needs land in view, a ship open water.
      if (piece === 'settlement' || piece === 'city') return !s.board.vertices[at].hexes.some((h) => isHidden(s, h));
      const hexes = s.board.edges[at].hexes;
      if (piece === 'ship') return hexes.some((h) => isOpenSea(s, h));
      return hexes.some((h) => isKnownLand(s, h));
    },

    afterBuild(ctx, player, piece, at, stage) {
      if (stage !== 'reward') return;
      if (piece === 'road' || piece === 'ship' || piece === 'bridge') revealBeside(ctx, player, at);
      const st = seaState(ctx.s);
      if (piece === 'settlement' && st.landed) {
        // First Landing: once per player per island, for good.
        const island = islandOf(ctx.s, at);
        if (island >= 0 && !ctx.s.board.islands[island].home && !st.landed[player].includes(island)) {
          st.landed[player].push(island);
          ctx.emit({ type: 'sea/firstLanding', player, island, vertex: at, points: FIRST_LANDING_POINTS });
        }
      }
    },

    canPlaceFreeRoute(s, player) {
      return legalShips(s, player, true).length > 0;
    },

    victoryPoints(s, player) {
      return (s.ext.sea?.landed?.[player].length ?? 0) * FIRST_LANDING_POINTS;
    },

    redact(s) {
      const fog = s.ext.sea?.fog;
      if (!fog) return;
      // Nobody knows what's face down, nor the order of the discs still to draw; not even from the
      // custom map the game was dealt from.
      s.options = seenOptions(s.options, s.board, fog.hidden);
      s.board = seenBoard(s.board, fog.hidden);
      fog.pool = fog.pool.map(() => 0);
    },
  },

  bot: seaBot,
  invariants,
};
