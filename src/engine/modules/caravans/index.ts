// Wagon Trains: an oasis at the centre of the island, neutral wagon trains running out from three of
// its corners, and an end-of-turn auction that decides where each new wagon goes. A wagon over a
// route piece adds 1 to its owner's route, and a building between two wagons is worth a point more.

import { validIndex } from '../../ctx';
import { bridgeSites } from '../../rules';
import type { RuleModule } from '../api';
import { handleAuction, auctionActions, openAuction, BID, VOTE, PLACE } from './auction';
import { caravansBot } from './bot';
import { shapeOasis } from './map';
import { WAGONS, caravansOf, hasWagon, wagonPoint } from './trains';

/**
 * Wagon Trains play to two points more (rule 9): 12 on the classic island. The target is the game's
 * own option, set from the presets' formula (engine/presets.ts targetFor), so no hook adds it again.
 */
export const CARAVANS_TARGET = 12;

export const caravans: RuleModule = {
  id: 'caravans',
  rulesVersion: 1,

  init(s) {
    const origins = s.board.features.oasis?.origins ?? [];
    s.ext.caravans = { supply: WAGONS, trains: origins.map((o) => ({ origin: o, edges: [], head: o })), owed: false, auction: null, lastAuction: null };
    // The robber waits beside the board until the first 7 or Knight brings it onto any land hex.
    s.robberHex = null;
  },

  handle: handleAuction,
  legal: auctionActions,

  hooks: {
    shapeMap(spec, _options, rng) {
      shapeOasis(spec, rng);
    },

    turnStarted(ctx) {
      caravansOf(ctx.s).owed = false;
    },

    afterBuild(ctx, player, piece, _at, stage) {
      // Placing any number of settlements or cities on your turn earns one wagon for its end.
      if (stage === 'reward' && (piece === 'settlement' || piece === 'city') && player === ctx.s.currentPlayer) caravansOf(ctx.s).owed = true;
    },

    routeBonus(s, player, edge) {
      return s.routes[edge]?.owner === player && hasWagon(s, edge) ? 1 : 0;
    },

    buildingWorth(s, vertex, worth) {
      return wagonPoint(s, vertex) ? worth + 1 : worth;
    },

    endOfTurn: [{ rank: 30, run: openAuction }],
  },

  bot: caravansBot,

  invariants(s) {
    const st = s.ext.caravans;
    if (!st) return ['no caravans state'];
    const out: string[] = [];
    const oasis = s.board.features.oasis;
    const ring = new Set(oasis ? s.board.hexes[oasis.hex].edges : []);
    const sites = bridgeSites(s);
    const seen = new Set<number>();
    st.trains.forEach((t, i) => {
      if (oasis && !oasis.origins.includes(t.origin)) out.push(`train ${i} starts off the oasis`);
      let v = t.origin;
      t.edges.forEach((e, j) => {
        if (!validIndex(e, s.board.edges.length)) {
          out.push(`train ${i} has a wagon on no edge (${e})`);
          return;
        }
        if (seen.has(e)) out.push(`two wagons on edge ${e}`);
        seen.add(e);
        if (j === 0 && ring.has(e)) out.push(`train ${i} starts along the oasis`);
        if (sites.has(e) && s.routes[e]?.kind !== 'bridge') out.push(`a wagon fords the river at edge ${e}`);
        const ed = s.board.edges[e];
        if (ed.a !== v && ed.b !== v) out.push(`train ${i} breaks before its wagon ${j}`);
        v = ed.a === v ? ed.b : ed.a;
      });
      if (t.head !== v) out.push(`train ${i}'s front is at ${t.head}, its last wagon at ${v}`);
    });
    if (st.supply < 0 || st.supply + seen.size !== WAGONS) out.push(`wagons not conserved: ${st.supply} beside the board, ${seen.size} on it`);
    if (st.lastAuction && !validIndex(st.lastAuction.edge, s.board.edges.length)) out.push(`the last auction's wagon went on no edge (${st.lastAuction.edge})`);
    if (s.phase !== 'gameOver') {
      const top = s.pending[s.pending.length - 1];
      const mine = s.pending.filter((p) => p.kind.startsWith('caravans/'));
      const a = st.auction;
      if (!a && mine.length > 0) out.push('a wagon decision is owed with no auction');
      if (a) {
        if (s.phase !== 'endOfTurn') out.push(`an auction outside the end of the turn (${s.phase})`);
        if (mine.length !== 1 || top !== mine[0]) out.push('an auction without its decision on top');
        else {
          const want = { bids: BID, ballots: VOTE, place: PLACE }[a.stage];
          if (top.kind !== want || top.players.length !== 1 || top.players[0] !== a.queue[0]) out.push(`the auction (${a.stage}, ${a.queue}) and its decision (${top.kind}, ${top.players}) disagree`);
        }
        for (const b of a.bids) {
          for (const [k, n] of Object.entries(b.cards)) if (n > s.players[b.player].hand[k as keyof typeof b.cards]) out.push(`player ${b.player} bid ${k} they no longer hold`);
        }
      }
    }
    return out;
  },
};
