// Fisheries: a lake inside the island and six fishing grounds off its coast produce face-down fish
// tokens, which buy actions on your turn; one token is an Soggy Boot, which raises its holder's target.

import { modulesOf } from '../../modules';
import { numbersOf } from '../../rules';
import type { RuleModule } from '../api';
import { corsairHex, setCorsair } from '../shared';
import { handleFisheries, legalFisheries } from './actions';
import { fisheriesBot } from './bot';
import { fisheriesOf, fishes, freshSupply, isFishHex, runQueue, tokenProblems, tokensFor, touchesFish } from './fish';
import { shapeFishingMap } from './map';
import { HIDDEN } from './types';

export const fisheries: RuleModule = {
  id: 'fisheries',
  rulesVersion: 2,

  init(s, rng) {
    // The robber waits beside the board until the first 7 or Knight card, and so does the corsair
    // with Sea Lanes (rule 4: a blocker any module delays starts off the board).
    s.robberHex = null;
    setCorsair(s, null);
    s.ext.fisheries = {
      supply: freshSupply(s, (a) => rng.shuffle(a)),
      discard: [],
      tokens: s.players.map(() => []),
      boot: null,
      queue: [],
      sevenSeen: false,
      swapTurn: s.players.map(() => -1),
    };
  },

  handle: handleFisheries,
  legal: legalFisheries,

  hooks: {
    shapeMap: shapeFishingMap,

    // A second set-up building on the lake or a fishing ground brings a token with its cards.
    startingGrants(ctx, player, vertex) {
      if (!touchesFish(ctx.s, vertex)) return;
      fisheriesOf(ctx.s).queue.push(player);
      runQueue(ctx);
    },

    afterRoll(ctx, total) {
      if (total === 7) ctx.s.ext.fisheries!.sevenSeen = true;
    },
    // (Until the first 7 or Knight card, even when the fleet's first attack would bring them in.)
    blockerHeld: (s) => !s.ext.fisheries?.sevenSeen && !s.players.some((p) => p.playedKnights > 0),

    // The corsair blocks a fishing ground it stops on, as the robber blocks the lake.
    hexBlocked: (s, hex) => isFishHex(hex) && hex.terrain === 'sea' && corsairHex(s) === hex.id,

    // Each building on a producing lake or fishing ground draws its tokens: the roller's first, then
    // clockwise, each player's one at a time.
    afterProduction(ctx, total) {
      const s = ctx.s;
      const mods = modulesOf(s);
      const due = s.players.map(() => 0);
      for (const hex of s.board.hexes) {
        if (!isFishHex(hex) || !numbersOf(s, hex).includes(total)) continue;
        if (hex.id === s.robberHex || mods.some((m) => m.hooks?.hexBlocked?.(s, hex))) continue;
        for (const v of hex.vertices) if (fishes(s, v)) due[s.buildings[v]!.owner] += tokensFor(s.buildings[v]!);
      }
      const f = fisheriesOf(s);
      const n = s.players.length;
      for (let i = 0; i < n; i++) {
        const p = (s.currentPlayer + i) % n;
        for (let k = 0; k < due[p]; k++) f.queue.push(p);
      }
      runQueue(ctx);
    },

    // The boot's holder needs one point more.
    victoryTarget: (s, player, target) => (s.ext.fisheries?.boot === player ? target + 1 : target),

    // Tokens are face down: other hands show only how many, and the supply only its size.
    redact(s, viewer) {
      const f = s.ext.fisheries;
      if (!f) return;
      f.supply = f.supply.map(() => HIDDEN);
      f.tokens = f.tokens.map((hand, p) => (p === viewer ? hand : hand.map(() => HIDDEN)));
    },
  },

  bot: fisheriesBot,

  invariants: tokenProblems,
};
