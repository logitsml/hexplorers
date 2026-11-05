// Rivers: two rivers run down the island to the sea. Building beside them pays coins (one for a
// road, settlement or ship on a river hex, three for a bridge across one), two coins buy a resource
// at most twice a turn (the core's coin market), and coins decide the wealth tiles: strictly the
// most holds the Richest (+1), and everyone tied for the fewest holds a Pauper tile (−1).

import type { RuleModule } from '../api';
import { addCoins, assert, moveCards, validIndex, type Ctx } from '../../ctx';
import { built } from '../../reducer';
import { bridgeSites, hasResources } from '../../rules';
import type { GameState, PlayerId } from '../../types';
import { riversBot } from './bot';
import { shapeRivers } from './map';
import {
  BRIDGE_COINS,
  BRIDGE_COST,
  BRIDGES_EACH,
  RIVER_COINS,
  bridgesLeft,
  coinsOf,
  isLegalBridge,
  legalBridges,
  onRiverCorner,
  onRiverEdge,
  pauperPoints,
  riverGeometry,
  wealthOf,
  wealthPoints,
} from './queries';
import type { RiversState } from './types';

const state = (s: GameState): RiversState => s.ext.rivers!;

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Bring the wealth tiles up to date with the coins, and say so if they changed hands. */
function syncWealth(ctx: Ctx) {
  const r = state(ctx.s);
  const w = wealthOf(coinsOf(ctx.s));
  if (w.richest === r.richest && sameSet(w.paupers, r.paupers)) return;
  ctx.emit({ type: 'rivers/wealthChanged', richest: w.richest, paupers: w.paupers.slice(), was: { richest: r.richest, paupers: r.paupers.slice() } });
  r.richest = w.richest;
  r.paupers = w.paupers;
}

/** Coins for a set-up piece by a river: a building on a river hex's corner, a road or ship on its edge. */
function setupCoin(ctx: Ctx, player: PlayerId, piece: string, at: number) {
  if ((piece === 'settlement' || piece === 'city') && onRiverCorner(ctx.s, at)) addCoins(ctx, player, RIVER_COINS, 'river', { piece, setup: true });
  else if ((piece === 'road' || piece === 'ship') && onRiverEdge(ctx.s, at)) addCoins(ctx, player, RIVER_COINS, 'river', { piece, setup: true });
}

const inSetup = (s: GameState) => s.phase === 'setupSettlement' || s.phase === 'setupRoad';

export const rivers: RuleModule = {
  id: 'rivers',
  rulesVersion: 2,

  init(s) {
    s.ext.rivers = {
      bridgesLeft: s.players.map(() => BRIDGES_EACH),
      richest: null,
      // Everyone starts with no coins, so everyone starts with a Pauper tile.
      paupers: s.players.map((p) => p.id),
      startCoinsOwed: s.options.layout === 'beginner',
    };
    // The robber starts on a swamp (the three-hex river's, as the source pictures it) where there is
    // no desert, unless an invader keeps it off the board (rule 4: the raider fleet until its first
    // landing; Invasion has no robber). Modules after this one that delay it take it off again.
    const swamps = riverGeometry(s.board).swamps;
    const delayed = s.options.modules.includes('fleet') || s.options.modules.includes('invasion');
    if (swamps.length > 0 && s.board.desertHex === null && s.robberHex === null && !delayed) s.robberHex = swamps[swamps.length - 1];
  },

  handle(ctx, player, action) {
    const s = ctx.s;
    switch (action.type) {
      case 'rivers/buildBridge': {
        assert(s.phase === 'main', `Not allowed during ${s.phase}.`);
        assert(player === s.currentPlayer, 'It is not your turn.');
        assert(validIndex(action.edge, s.board.edges.length), 'Invalid edge.');
        assert(bridgesLeft(s, player) > 0, 'You have no bridges left.');
        assert(hasResources(s.players[player].hand, BRIDGE_COST), 'A bridge costs 2 brick and 1 wood.');
        assert(bridgeSites(s).has(action.edge), 'Bridges go only where a river crosses an edge or meets the sea.');
        assert(isLegalBridge(s, player, action.edge), 'A bridge must join your own road, bridge or building.');
        moveCards(ctx, player, null, BRIDGE_COST, 'bridge');
        s.routes[action.edge] = { owner: player, kind: 'bridge', builtTurn: s.turn };
        state(s).bridgesLeft[player]--;
        ctx.emit({ type: 'rivers/bridgeBuilt', player, edge: action.edge });
        built(ctx, player, 'bridge', action.edge, true);
        return;
      }
      default:
        assert(false, `Unknown action ${(action as { type: string }).type}`);
    }
  },

  legal(s, player) {
    if (s.phase !== 'main' || s.currentPlayer !== player || !hasResources(s.players[player].hand, BRIDGE_COST)) return [];
    return legalBridges(s, player).map((edge) => ({ type: 'rivers/buildBridge', edge }));
  },

  hooks: {
    shapeMap: shapeRivers,

    afterSetupPiece(ctx, player, piece, at) {
      setupCoin(ctx, player, piece, at);
      syncWealth(ctx);
    },

    placeReason: (_s, _player, _piece, _at) => 'A river crossing needs a bridge',
    canPlace(s, _player, piece, at) {
      // A bridge site takes only a bridge (roads are kept off by the core; this covers ships).
      return piece === 'bridge' || piece === 'settlement' || piece === 'city' || !bridgeSites(s).has(at);
    },

    afterBuild(ctx, player, piece, at, stage) {
      if (stage === 'reward') {
        if (piece === 'bridge') addCoins(ctx, player, BRIDGE_COINS, 'bridge');
        else if (piece === 'settlement' && onRiverCorner(ctx.s, at)) addCoins(ctx, player, RIVER_COINS, 'river', { piece });
        else if ((piece === 'road' || piece === 'ship') && onRiverEdge(ctx.s, at)) addCoins(ctx, player, RIVER_COINS, 'river', { piece });
      } else if (stage === 'award') syncWealth(ctx);
    },

    canMove(s, player, piece, from, to) {
      if (bridgeSites(s).has(to)) return false;
      // Leaving a river edge costs a coin.
      return piece !== 'ship' || !onRiverEdge(s, from) || s.players[player].coins >= RIVER_COINS;
    },

    afterMove(ctx, player, piece, from) {
      if (piece === 'ship' && onRiverEdge(ctx.s, from)) addCoins(ctx, player, -RIVER_COINS, 'riverLeft', { piece });
    },

    victoryPoints(s, player) {
      // Counted from the coins as they are, so the tiles move the moment the coins do.
      return wealthPoints(wealthOf(coinsOf(s)), player, pauperPoints(s));
    },

    afterAction(ctx) {
      const s = ctx.s;
      const r = state(s);
      if (r.startCoinsOwed && !inSetup(s)) {
        r.startCoinsOwed = false;
        s.buildings.forEach((b, v) => b && setupCoin(ctx, b.owner, b.kind, v));
        s.routes.forEach((rt, e) => rt && setupCoin(ctx, rt.owner, rt.kind, e));
      }
    },

    awards: syncWealth,
  },

  bot: riversBot,

  invariants(s) {
    const out: string[] = [];
    const r = s.ext.rivers;
    if (!r) return ['no rivers state'];
    const sites = bridgeSites(s);
    const onBoard = s.players.map(() => 0);
    s.routes.forEach((rt, e) => {
      if (!rt) return;
      if (rt.kind === 'bridge') {
        onBoard[rt.owner]++;
        if (!sites.has(e)) out.push(`bridge on edge ${e}, which is no bridge site`);
      } else if (sites.has(e)) out.push(`${rt.kind} on bridge site ${e}`);
    });
    s.players.forEach((p) => {
      if (r.bridgesLeft[p.id] < 0 || r.bridgesLeft[p.id] + onBoard[p.id] !== BRIDGES_EACH) out.push(`player ${p.id} bridges ${r.bridgesLeft[p.id]}+${onBoard[p.id]}`);
      if (!Number.isInteger(p.coins) || p.coins < 0) out.push(`player ${p.id} coins ${p.coins}`);
    });
    // (A game that has just ended skips the last update.)
    if (s.phase !== 'gameOver' && !r.startCoinsOwed) {
      const w = wealthOf(coinsOf(s));
      if (w.richest !== r.richest || !sameSet(w.paupers, r.paupers)) out.push(`wealth tiles ${r.richest}/${r.paupers} behind the coins ${coinsOf(s)}`);
    }
    return out;
  },
};
