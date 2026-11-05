// Garrisons: wardens in three ranks and city walls. A warden is recruited resting beside your
// routes, promoted a rank at a time and mustered with wheat; a mustered warden may march your
// routes, displace a weaker opponent's warden or chase a blocker, and each of those rests it.
// Wardens block opponents' routes and building sites. Walls raise the hand limit on a 7.
//
// Under Invasion the wardens stand on edges: recruits go to the castle's edges, and Invasion owns
// their marches and battles at the end of the turn. Promoting and mustering stay here.

import type { RuleModule } from '../api';
import { handleGarrisons, legalGarrisons } from './actions';
import { garrisonsBot } from './bot';
import type { GarrisonsAction, RetreatPending, WardenRank } from './types';
import { WALL_HAND_BONUS, WALL_LIMIT, WARDEN_PIECES, countingWalls, freePieces, garrisonsOf, invaded, wardenAt } from './wardens';

export const garrisons: RuleModule = {
  id: 'garrisons',
  rulesVersion: 1,
  requires: ['guilds'],

  init(s) {
    s.ext.garrisons = { promoted: [] };
  },

  handle: (ctx, player, action) => handleGarrisons(ctx, player, action as GarrisonsAction),
  legal: legalGarrisons,

  hooks: {
    turnStarted(ctx) {
      garrisonsOf(ctx.s).promoted = [];
    },

    // Each wall raises its owner's hand limit by two.
    handLimit: (s, player, limit) => limit + WALL_HAND_BONUS * countingWalls(s, player),

    // A warden takes its intersection: nobody builds there.
    placeReason: () => 'A warden occupies that corner: move it before building here',
    canPlace: (s, _player, piece, at) => !((piece === 'settlement' || piece === 'city') && wardenAt(s, at)),

    // An opponent's warden breaks a route like an opponent's building.
    breaksRoute: (s, player, vertex) => s.wardens.some((w) => w.vertex === vertex && w.owner !== player),
  },

  bot: garrisonsBot,

  invariants(s) {
    const out: string[] = [];
    if (!s.ext.garrisons) return ['no garrisons state'];
    // (A displaced warden stands nowhere while its retreat is owed: Invasion's displacements too, where it runs the march.)
    const lifted = new Set(s.pending.filter((p) => p.kind === 'garrisons/retreat' || p.kind === 'invasion/retreat').map((p) => (p.data as RetreatPending).warden));
    const ids = new Set<number>();
    const vertices = new Set<number>();
    const edges = new Set<number>();
    for (const w of s.wardens) {
      if (ids.has(w.id)) out.push(`warden id ${w.id} twice`);
      ids.add(w.id);
      if (w.id >= (s.nextWardenId ?? 1)) out.push(`warden id ${w.id} beyond the counter`);
      if (![1, 2, 3].includes(w.rank)) out.push(`warden ${w.id} rank ${w.rank}`);
      const placed = (w.vertex !== null ? 1 : 0) + (w.edge !== null ? 1 : 0);
      if (placed !== 1 && !(placed === 0 && lifted.has(w.id))) out.push(`warden ${w.id} stands at ${w.vertex}/${w.edge}`);
      if (w.vertex !== null) {
        if (vertices.has(w.vertex)) out.push(`two wardens at ${w.vertex}`);
        vertices.add(w.vertex);
        if (s.buildings[w.vertex]) out.push(`warden ${w.id} on a building`);
        if (invaded(s)) out.push(`warden ${w.id} on an intersection under Invasion`);
      }
      if (w.edge !== null) {
        if (edges.has(w.edge)) out.push(`two wardens on edge ${w.edge}`);
        edges.add(w.edge);
      }
    }
    for (const p of s.players) {
      for (const r of [1, 2, 3] as WardenRank[]) if (freePieces(s, p.id, r) < 0) out.push(`player ${p.id} has more than ${WARDEN_PIECES} of rank ${r}`);
      let walls = 0;
      s.buildings.forEach((b) => {
        if (b?.wall && b.owner === p.id) walls++;
      });
      if (walls > WALL_LIMIT) out.push(`player ${p.id} has ${walls} walls`);
    }
    s.buildings.forEach((b, v) => {
      if (b?.wall && b.kind !== 'city') out.push(`a wall under a house at ${v}`);
    });
    for (const id of lifted) if (!ids.has(id)) out.push(`retreat owed for a missing warden ${id}`);
    return out;
  },
};
