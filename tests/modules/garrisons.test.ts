// Garrisons: recruiting, promoting and mustering wardens, their marches, displacements and chases,
// how they block routes and sites, walls, the guilds' warden ventures, the rules under Invasion and
// at sea, plus bot games and fuzzing of the guilds with the garrisons.
//
// Pieces on the beginner island (seed 7) are listed at the top of guilds.test.ts. Seat 0 has a
// settlement at 3 with a road 2–3 (edge 2), and a city at 15 with a road 15–25 (edge 31).

import { describe, expect, it } from 'vitest';
import { beginnerLayout, classicSpec, createGame, handLimit, isLegalRoad, legalActions, legalSettlements, longestRoadFor, type Action, type GameState } from '../../src/engine';
import { placeWells } from '../../src/engine/modules/oil/map';
import { newWardenId } from '../../src/engine/modules/shared';
import { Rng } from '../../src/engine/rng';
import type { BotDifficulty } from '../../src/engine/ai';
import { grant, patch as rawPatch, corsairAt } from '../helpers';
import { runBotGame, runFuzzGame, type GameResult } from '../sim-harness';
import { act, addRoad, game, giveVenture, main, refused, rollAs, setLevel, settle, summarize } from './guilds-helpers';
import { slow, timeout } from '../tier';

/** A patched copy with the cached route lengths brought up to date. */
const patch = (s: GameState, fn: (x: GameState) => void) =>
  rawPatch(s, (x) => {
    fn(x);
    settle(x);
  });

const GG = ['guilds', 'garrisons'] as const;
const play = (card: string, params: Record<string, unknown> = {}): Action => ({ type: 'guilds/play', card, ...params }) as Action;

/** Put a warden on the board (patching); mustered ones were mustered before this turn. */
function warden(s: GameState, owner: number, rank: 1 | 2 | 3, at: { vertex?: number; edge?: number }, mustered = false): number {
  const id = newWardenId(s);
  s.wardens.push({ id, owner, rank, mustered, vertex: at.vertex ?? null, edge: at.edge ?? null, musteredTurn: 0 });
  return id;
}

describe('garrisons: wardens', () => {
  it('recruits a resting recruit for a wool and an ore beside your routes, without the distance rule', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      grant(x, 0, { wool: 1, ore: 1 });
    });
    const spots = legalActions(s, 0).filter((a) => a.type === 'garrisons/recruit');
    expect(spots).toEqual([
      { type: 'garrisons/recruit', vertex: 2 },
      { type: 'garrisons/recruit', vertex: 25 },
    ]);
    expect(refused(s, 0, { type: 'garrisons/recruit', vertex: 14 })).toBe('A recruit stands on an empty intersection beside your routes.');
    const t = act(s, 0, { type: 'garrisons/recruit', vertex: 2 }).state;
    expect(t.wardens).toEqual([{ id: 1, owner: 0, rank: 1, mustered: false, vertex: 2, edge: null, musteredTurn: 0 }]);
    expect(t.players[0].hand.wool).toBe(s.players[0].hand.wool - 1);
    expect(t.players[0].hand.ore).toBe(s.players[0].hand.ore - 1);
  });

  it('has two pieces of each rank: a third recruit waits for a promotion', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      grant(x, 0, { wool: 2, ore: 2 });
      warden(x, 0, 1, { vertex: 2 });
      warden(x, 0, 1, { vertex: 25 });
      addRoad(x, 0, 1);
    });
    expect(refused(s, 0, { type: 'garrisons/recruit', vertex: 1 })).toBe('You have no recruit left: promote one first.');
    const t = act(s, 0, { type: 'garrisons/promote', warden: 1 }).state;
    expect(t.wardens[0].rank).toBe(2);
    expect(applyOk(t, 0, { type: 'garrisons/recruit', vertex: 1 })).toBe(true);
  });

  it('promotes for a wool and an ore, once a warden a turn, and to champion only at Statecraft 3', () => {
    let s = patch(game([...GG]), (x) => {
      main(x, 0);
      grant(x, 0, { wool: 3, ore: 3 });
      warden(x, 0, 2, { vertex: 2 }, true);
    });
    expect(refused(s, 0, { type: 'garrisons/promote', warden: 1 })).toBe('Champions need Statecraft level 3.');
    s = patch(s, (x) => setLevel(x, 0, 'statecraft', 3));
    s = act(s, 0, { type: 'garrisons/promote', warden: 1 }).state;
    expect(s.wardens[0]).toMatchObject({ rank: 3, mustered: true });
    expect(refused(s, 0, { type: 'garrisons/promote', warden: 1 })).toBe('Champions are the highest rank.');
    const t = patch(game([...GG]), (x) => {
      main(x, 0);
      grant(x, 0, { wool: 3, ore: 3 });
      setLevel(x, 0, 'statecraft', 3);
      warden(x, 0, 1, { vertex: 2 });
    });
    const once = act(t, 0, { type: 'garrisons/promote', warden: 1 }).state;
    expect(refused(once, 0, { type: 'garrisons/promote', warden: 1 })).toBe('A warden may be promoted once a turn.');
  });

  it('musters for a wheat; a warden mustered this turn can’t act yet, and a resting one never', () => {
    let s = patch(game([...GG]), (x) => {
      main(x, 0);
      grant(x, 0, { wheat: 1 });
      warden(x, 0, 1, { vertex: 2 });
      addRoad(x, 0, 1);
    });
    expect(refused(s, 0, { type: 'garrisons/march', warden: 1, vertex: 1 })).toBe('Only a mustered warden can act.');
    s = act(s, 0, { type: 'garrisons/muster', warden: 1 }).state;
    expect(s.wardens[0]).toMatchObject({ mustered: true, musteredTurn: s.turn });
    expect(refused(s, 0, { type: 'garrisons/march', warden: 1, vertex: 1 })).toBe('A warden mustered this turn cannot act yet.');
  });

  it('marches along your routes, through your own pieces, to an empty intersection, and rests', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      addRoad(x, 0, 1);
      addRoad(x, 0, 0);
      addRoad(x, 0, 3);
      warden(x, 0, 1, { vertex: 2 }, true);
    });
    // From 2: along 2–1 and 1–0, and through the settlement at 3 onto 3–4.
    const marches = legalActions(s, 0).filter((a) => a.type === 'garrisons/march').map((a) => (a as { vertex: number }).vertex);
    expect(marches).toEqual([0, 1, 4]);
    const t = act(s, 0, { type: 'garrisons/march', warden: 1, vertex: 0 }).state;
    expect(t.wardens[0]).toMatchObject({ vertex: 0, mustered: false });
  });

  it('never marches past an opponent’s warden or building', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      addRoad(x, 0, 1);
      addRoad(x, 0, 0);
      warden(x, 0, 1, { vertex: 2 }, true);
      warden(x, 1, 1, { vertex: 1 });
    });
    expect(legalActions(s, 0).filter((a) => a.type === 'garrisons/march')).toEqual([]);
  });

  it('displaces only a weaker warden, whose owner retreats it along their routes', () => {
    let s = patch(game([...GG]), (x) => {
      main(x, 0);
      addRoad(x, 0, 1);
      addRoad(x, 1, 10);
      warden(x, 0, 2, { vertex: 2 }, true);
      warden(x, 1, 1, { vertex: 1 }, true);
    });
    s = act(s, 0, { type: 'garrisons/displace', warden: 1, target: 2 }).state;
    expect(s.wardens.find((w) => w.id === 1)).toMatchObject({ vertex: 1, mustered: false });
    expect(s.pending.map((p) => [p.kind, p.players])).toEqual([['garrisons/retreat', [1]]]);
    expect(legalActions(s, 1)).toEqual([{ type: 'garrisons/retreat', vertex: 6 }]);
    s = act(s, 1, { type: 'garrisons/retreat', vertex: 6 }).state;
    // It keeps its mustered state.
    expect(s.wardens.find((w) => w.id === 2)).toMatchObject({ vertex: 6, mustered: true });
    const even = patch(game([...GG]), (x) => {
      main(x, 0);
      addRoad(x, 0, 1);
      warden(x, 0, 1, { vertex: 2 }, true);
      warden(x, 1, 1, { vertex: 1 });
    });
    expect(refused(even, 0, { type: 'garrisons/displace', warden: 1, target: 2 })).toBe('You can only displace a weaker warden you can reach along your routes.');
  });

  it('removes a displaced warden with nowhere to go', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      addRoad(x, 0, 1);
      warden(x, 0, 2, { vertex: 2 }, true);
      warden(x, 1, 1, { vertex: 1 });
    });
    const r = act(s, 0, { type: 'garrisons/displace', warden: 1, target: 2 });
    expect(r.state.wardens.map((w) => w.id)).toEqual([1]);
    expect(r.state.pending).toEqual([]);
  });

  it('chases the robber from a corner of its hex, and robs someone on its new hex', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      warden(x, 0, 1, { vertex: 18 }, true);
    });
    const chases = legalActions(s, 0).filter((a) => a.type === 'garrisons/chase' && (a as { hex: number }).hex === 4);
    expect(chases).toEqual([{ type: 'garrisons/chase', warden: 1, blocker: 'robber', hex: 4, victim: 2 }]);
    const before = Object.values(s.players[2].hand).reduce((a, b) => a + b, 0);
    const t = act(s, 0, chases[0]).state;
    expect(t.robberHex).toBe(4);
    expect(Object.values(t.players[2].hand).reduce((a, b) => a + b, 0)).toBe(before - 1);
    expect(t.wardens[0].mustered).toBe(false);
    const far = patch(s, (x) => (x.wardens[0].vertex = 2));
    expect(legalActions(far, 0).some((a) => a.type === 'garrisons/chase')).toBe(false);
  });

  it("blocks opponents' routes and building sites like a building", () => {
    const s = patch(game([...GG]), (x) => {
      addRoad(x, 0, 1);
      addRoad(x, 0, 0);
    });
    expect(longestRoadFor(s, 0)).toBe(3);
    const blocked = patch(s, (x) => warden(x, 1, 1, { vertex: 1 }));
    expect(longestRoadFor(blocked, 0)).toBe(1 + 1);
    expect(isLegalRoad(blocked, 0, 6)).toBe(false);
    expect(isLegalRoad(s, 0, 10)).toBe(true);
    expect(isLegalRoad(blocked, 0, 10)).toBe(false);
    // Nobody builds where a warden stands, its owner included.
    const own = patch(s, (x) => warden(x, 0, 1, { vertex: 0 }));
    expect(legalSettlements(s, 0)).toContain(0);
    expect(legalSettlements(own, 0)).not.toContain(0);
  });

  it('updates Longest Route when a warden splits one', () => {
    // Seat 0's road 0–1–2–3–4–5 round the forest; seat 2's road reaches 2 from its city.
    const s = patch(game([...GG]), (x) => {
      main(x, 2);
      for (const e of [0, 1, 3, 4]) addRoad(x, 0, e);
      x.longestRoadHolder = 0;
      grant(x, 2, { wool: 1, ore: 1 });
    });
    expect(s.players[0].longestRoad).toBe(5);
    const t = act(s, 2, { type: 'garrisons/recruit', vertex: 2 }).state;
    expect(t.players[0].longestRoad).toBe(3);
    expect(t.players[0].longestRoad).toBe(longestRoadFor(t, 0));
    expect(t.longestRoadHolder).toBeNull();
  });
});

describe('garrisons: walls', () => {
  it('raises a wall under a city for two brick, at most three, each adding two to the hand limit', () => {
    let s = patch(game([...GG]), (x) => {
      main(x, 0);
      grant(x, 0, { brick: 8 });
      for (const v of [3]) x.buildings[v]!.kind = 'city';
      x.players[0].citiesLeft--;
      x.players[0].settlementsLeft++;
      x.buildings[25] = { owner: 0, kind: 'city' };
      x.buildings[1] = { owner: 0, kind: 'city' };
      x.players[0].citiesLeft -= 2;
    });
    expect(refused(s, 0, { type: 'garrisons/wall', vertex: 9 })).toBe('A wall goes under one of your towns without one (at most 3).');
    for (const v of [15, 3, 25]) s = act(s, 0, { type: 'garrisons/wall', vertex: v }).state;
    expect(handLimit(s, 0)).toBe(13);
    expect(refused(s, 0, { type: 'garrisons/wall', vertex: 1 })).toBe('A wall goes under one of your towns without one (at most 3).');
    expect(s.players[0].hand.brick).toBe(8 - 6);
  });

  it('spares a walled hand on a 7', () => {
    const s = patch(game([...GG]), (x) => {
      x.buildings[15]!.wall = true;
      grant(x, 0, { wheat: 6 });
    });
    const held = Object.values(s.players[0].hand).reduce((a, b) => a + b, 0);
    expect(held).toBe(9);
    const { state } = rollAs(s, 0, { total: 7 });
    expect(state.pendingDiscards[0]).toBeUndefined();
  });
});

describe('garrisons: the warden ventures', () => {
  it('forge: promotes up to two wardens for free', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'forge');
      warden(x, 0, 1, { vertex: 2 });
      warden(x, 0, 1, { vertex: 25 });
    });
    const t = act(s, 0, play('forge', { wardens: [1, 2] })).state;
    expect(t.wardens.map((w) => w.rank)).toEqual([2, 2]);
    expect(t.players[0].hand).toEqual(s.players[0].hand);
  });

  it('rally: musters all your wardens for free', () => {
    const s = patch(game([...GG]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'rally');
      warden(x, 0, 1, { vertex: 2 });
      warden(x, 0, 2, { vertex: 25 });
    });
    const t = act(s, 0, play('rally')).state;
    expect(t.wardens.map((w) => [w.mustered, w.musteredTurn])).toEqual([
      [true, t.turn],
      [true, t.turn],
    ]);
  });

  it("agitators: displace an opponent's warden by your routes without one of your own", () => {
    let s = patch(game([...GG]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'agitators');
      addRoad(x, 1, 10);
      warden(x, 1, 3, { vertex: 2 }, true);
      addRoad(x, 2, 21);
    });
    expect(legalActions(s, 0).filter((a) => a.type === 'guilds/play')).toEqual([play('agitators', { warden: 1 })]);
    s = act(s, 0, play('agitators', { warden: 1 })).state;
    // Seat 1 has no route at 2: its warden leaves the board.
    expect(s.wardens).toEqual([]);
  });

  it('treachery: the target gives up a warden of their choice, and you may put one in of the same rank or lower', () => {
    let s = patch(game([...GG]), (x) => {
      main(x, 0);
      giveVenture(x, 0, 'treachery');
      warden(x, 1, 2, { vertex: 30 }, true);
      warden(x, 1, 1, { vertex: 39 });
    });
    s = act(s, 0, play('treachery', { target: 1 })).state;
    expect(s.pending.map((p) => [p.kind, p.players])).toEqual([['guilds/surrender', [1]]]);
    s = act(s, 1, { type: 'guilds/surrender', warden: 1 }).state;
    expect(s.pending.map((p) => [p.kind, p.players])).toEqual([['guilds/plant', [0]]]);
    const ranks = new Set(legalActions(s, 0).map((a) => (a as { rank: number }).rank));
    expect([...ranks].sort()).toEqual([0, 1, 2]);
    s = act(s, 0, { type: 'guilds/plant', rank: 2, vertex: 25 }).state;
    expect(s.wardens.find((w) => w.owner === 0)).toMatchObject({ rank: 2, vertex: 25, mustered: true });
    expect(s.wardens.filter((w) => w.owner === 1).map((w) => w.rank)).toEqual([1]);
  });

  it('masonry needs the garrisons, and so its card is only dealt with them', () => {
    const s = game([...GG]);
    expect(Object.values(s.ext.guilds!.decks).flat()).toContain('masonry');
  });
});

describe('garrisons: under Invasion', () => {
  const invaded = () =>
    patch(game(['guilds', 'garrisons', 'invasion']), (x) => {
      main(x, 0);
      x.board = structuredClone(x.board);
      x.board.features.castle = 9;
      grant(x, 0, { wool: 2, ore: 2, wheat: 2 });
    });

  it('recruits onto an empty edge of the castle', () => {
    const s = invaded();
    const recruits = legalActions(s, 0).filter((a) => a.type === 'garrisons/recruit');
    expect(recruits.map((a) => (a as { edge: number }).edge).sort((a, b) => a - b)).toEqual([...s.board.hexes[9].edges].sort((a, b) => a - b));
    const t = act(s, 0, { type: 'garrisons/recruit', edge: 26 }).state;
    expect(t.wardens[0]).toMatchObject({ vertex: null, edge: 26, mustered: false });
    expect(refused(s, 0, { type: 'garrisons/recruit', vertex: 2 })).toBe('Recruits muster on an empty edge of the castle.');
  });

  it("leaves marching to Invasion, and musters only off the castle's edges", () => {
    const s = patch(invaded(), (x) => {
      warden(x, 0, 1, { edge: 26 });
      warden(x, 0, 1, { edge: 2 }, true);
    });
    const kinds = new Set(legalActions(s, 0).map((a) => a.type));
    expect(kinds.has('garrisons/march')).toBe(false);
    expect(kinds.has('garrisons/chase')).toBe(false);
    expect(refused(s, 0, { type: 'garrisons/muster', warden: 1 })).toBe('That warden cannot be mustered.');
    expect(refused(s, 0, { type: 'garrisons/march', warden: 2, vertex: 1 })).toBe('Wardens march at the end of the turn in this game.');
    const t = patch(s, (x) => (x.wardens[0].edge = 3));
    expect(act(t, 0, { type: 'garrisons/muster', warden: 1 }).state.wardens[0].mustered).toBe(true);
  });

  it('wardens on edges neither block routes nor take building sites', () => {
    const s = patch(invaded(), (x) => {
      warden(x, 1, 1, { edge: 1 });
      warden(x, 1, 1, { edge: 0 });
    });
    expect(isLegalRoad(s, 0, 1)).toBe(true);
    expect(isLegalRoad(s, 0, 0)).toBe(false);
    expect(legalSettlements(patch(s, (x) => addRoad(x, 0, 1)), 0)).toContain(1);
  });
});

describe('garrisons: at sea', () => {
  /** The beginner island in a ring of sea, carried as the game's board. */
  const SEA_RING = (() => {
    const spec = classicSpec(beginnerLayout());
    const land = new Set(spec.hexes.map((h) => `${h.q},${h.r}`));
    const ring: [number, number][] = [];
    for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === 3 && !land.has(`${q},${r}`)) ring.push([q, r]);
    spec.hexes.push(...ring.map(([q, r]) => ({ q, r, terrain: 'sea' as const, numbers: [] })));
    return spec;
  })();
  /** The same, with Oil's three wells on it (a carried board is played as it comes). */
  const OIL_RING = (() => {
    const spec = structuredClone(SEA_RING);
    placeWells(spec, new Rng(7));
    return spec;
  })();

  /** A coastal intersection, a sea intersection beyond it and one beyond that, along sea edges. */
  function seaPath(s: GameState): { c: number; x: number; y: number; e1: number; e2: number } {
    const seaOnly = (v: number) => !s.board.vertices[v].land;
    for (const c of s.board.vertices) {
      if (!c.land || s.buildings[c.id]) continue;
      for (const e1 of c.edges) {
        const ed = s.board.edges[e1];
        const x = ed.a === c.id ? ed.b : ed.a;
        if (!ed.sea || !seaOnly(x)) continue;
        for (const e2 of s.board.vertices[x].edges) {
          const ed2 = s.board.edges[e2];
          const y = ed2.a === x ? ed2.b : ed2.a;
          if (e2 !== e1 && ed2.sea && seaOnly(y)) return { c: c.id, x, y, e1, e2 };
        }
      }
    }
    throw new Error('no sea path');
  }

  it('marches along ships, through your own building, to an intersection where only sea hexes meet', () => {
    const s0 = createGame([0, 1, 2, 3].map((i) => ({ name: `P${i}`, color: '', isBot: false })), { board: SEA_RING, layout: 'beginner', seed: 7, modules: ['sea', 'guilds', 'garrisons'], victoryPoints: 13 }).state;
    const s = patch(s0, (z) => {
      const { c, x, e1, e2 } = seaPath(z);
      main(z, 0);
      z.ext.sea = corsairAt(z, null);
      z.buildings[c] = { owner: 0, kind: 'settlement' };
      z.players[0].settlementsLeft--;
      z.routes[e1] = { owner: 0, kind: 'ship', builtTurn: 0 };
      z.routes[e2] = { owner: 0, kind: 'ship', builtTurn: 0 };
      warden(z, 0, 1, { vertex: x }, true);
    });
    const { y } = seaPath(s0);
    const marches = legalActions(s, 0).filter((a) => a.type === 'garrisons/march').map((a) => (a as { vertex: number }).vertex);
    expect(marches).toContain(y);
    expect(s.board.vertices[y].land).toBe(false);
  });

  it('chases the corsair from a corner of its hex to another sea hex, robbing a ship owner there', () => {
    const s0 = createGame([0, 1, 2, 3].map((i) => ({ name: `P${i}`, color: '', isBot: false })), { board: SEA_RING, layout: 'beginner', seed: 7, modules: ['sea', 'guilds', 'garrisons'], victoryPoints: 13 }).state;
    const { x } = seaPath(s0);
    const here = s0.board.vertices[x].hexes.find((h) => s0.board.hexes[h].terrain === 'sea')!;
    const there = s0.board.hexes.find((h) => h.terrain === 'sea' && h.id !== here && !h.vertices.includes(x))!;
    const s = patch(s0, (z) => {
      main(z, 0);
      z.ext.sea = corsairAt(z, here);
      warden(z, 0, 1, { vertex: x }, true);
      z.routes[there.edges[0]] = { owner: 1, kind: 'ship', builtTurn: 0 };
      z.ext.sea!.shipsLeft[1]--;
    });
    const chase = { type: 'garrisons/chase', warden: 1, blocker: 'corsair', hex: there.id, victim: 1 } as Action;
    expect(legalActions(s, 0)).toContainEqual(chase);
    const t = act(s, 0, chase).state;
    expect(t.ext.sea!.corsair).toBe(there.id);
    expect(t.robberHex).toBe(s.robberHex);
  });

  it('never chases the corsair onto a face-down hex: only where it could sail itself', () => {
    const s0 = createGame([0, 1, 2, 3].map((i) => ({ name: `P${i}`, color: '', isBot: false })), { board: SEA_RING, layout: 'beginner', seed: 7, modules: ['sea', 'guilds', 'garrisons'], victoryPoints: 13 }).state;
    const { x } = seaPath(s0);
    const here = s0.board.vertices[x].hexes.find((h) => s0.board.hexes[h].terrain === 'sea')!;
    const hidden = s0.board.hexes.find((h) => h.terrain === 'sea' && h.id !== here && !h.vertices.includes(x))!;
    const s = patch(s0, (z) => {
      main(z, 0);
      z.ext.sea = corsairAt(z, here);
      z.ext.sea.fog = { hidden: [hidden.id], pool: [], drawn: {}, discs: 0 };
      warden(z, 0, 1, { vertex: x }, true);
    });
    const to = legalActions(s, 0).flatMap((a) => (a.type === 'garrisons/chase' && a.blocker === 'corsair' ? [a.hex] : []));
    expect(to.length).toBeGreaterThan(0);
    expect(to).not.toContain(hidden.id);
  });

  it('with Oil, a chase may name oil, from a ship owner the corsair finds or a builder the robber does', () => {
    const s0 = createGame([0, 1, 2, 3].map((i) => ({ name: `P${i}`, color: '', isBot: false })), { board: OIL_RING, layout: 'beginner', seed: 7, modules: ['sea', 'guilds', 'garrisons', 'oil'], victoryPoints: 15 }).state;
    const { x } = seaPath(s0);
    const here = s0.board.vertices[x].hexes.find((h) => s0.board.hexes[h].terrain === 'sea')!;
    const there = s0.board.hexes.find((h) => h.terrain === 'sea' && h.id !== here && !h.vertices.includes(x))!;
    const chases = (z: GameState, blocker: string) => legalActions(z, 0).filter((a) => a.type === 'garrisons/chase' && (a as { blocker: string }).blocker === blocker);
    /** `p` holds nothing but oil. */
    const onlyOil = (z: GameState, p: number) => {
      for (const k of Object.keys(z.players[p].hand) as (keyof GameState['bank'])[]) {
        z.bank[k] += z.players[p].hand[k];
        z.players[p].hand[k] = 0;
      }
      grant(z, p, { oil: 2 });
    };

    const atSea = patch(s0, (z) => {
      main(z, 0);
      z.ext.sea = corsairAt(z, here);
      warden(z, 0, 1, { vertex: x }, true);
      z.routes[there.edges[0]] = { owner: 1, kind: 'ship', builtTurn: 0 };
      z.ext.sea!.shipsLeft[1]--;
      onlyOil(z, 1);
    });
    const named = { type: 'garrisons/chase', warden: 1, blocker: 'corsair', hex: there.id, victim: 1, oil: true } as Action;
    expect(chases(atSea, 'corsair').filter((a) => (a as { hex: number }).hex === there.id)).toEqual([named]);
    expect(refused(atSea, 0, { ...named, oil: undefined } as Action)).toBe('They have no card to take.');
    const t = act(atSea, 0, named).state;
    expect([t.players[0].hand.oil, t.players[1].hand.oil]).toEqual([1, 1]);

    // On land, as in the robber's chase above: from beside the desert to hex 4, where seat 2 builds.
    // (With Oil the robber waits off the board until it's moved: it's put back on the desert here.)
    const onLand = patch(s0, (z) => {
      main(z, 0);
      z.robberHex = 9;
      warden(z, 0, 1, { vertex: 18 }, true);
      onlyOil(z, 2);
    });
    const toFour = chases(onLand, 'robber').filter((a) => (a as { hex: number }).hex === 4);
    expect(toFour).toEqual([{ type: 'garrisons/chase', warden: 1, blocker: 'robber', hex: 4, victim: 2, oil: true }]);
    const u = act(onLand, 0, toFour[0]).state;
    expect([u.players[0].hand.oil, u.players[2].hand.oil]).toEqual([1, 1]);
  });
});

describe('garrisons: bots and fuzzing', () => {
  const results: GameResult[] = [];
  const diffs = (g: number, n: number): BotDifficulty[] => Array.from({ length: n }, (_, i) => (['easy', 'normal', 'hard'] as const)[(g + i) % 3]);

  slow('16 bot games of the guilds with the garrisons finish with no fall-backs', () => {
    for (let g = 0; g < 16; g++) {
      const n = g % 2 ? 3 : 4;
      const r = runBotGame({ seed: 8000 + g, players: n as 3 | 4, layout: g % 4 === 0 ? 'beginner' : 'random', difficulties: diffs(g, n), options: { modules: [...GG], victoryPoints: 13 }, crossCheckLegal: g % 4 === 1 });
      expect(r.winner).not.toBeNull();
      expect(r.fallbacks).toBe(0);
      results.push(r);
    }
    summarize('guilds + garrisons', results);
  }, timeout(120_000));

  slow('every legal action applies under random play', () => {
    let checked = 0;
    for (let g = 0; g < 4; g++) checked += runFuzzGame(8100 + g, g % 2 ? 3 : 4, g % 2 ? 'random' : 'beginner', 700, true, { modules: [...GG], victoryPoints: 13 }).checkedActions;
    for (let g = 0; g < 6; g++) runFuzzGame(8200 + g, g % 2 ? 3 : 4, 'random', 2000, false, { modules: [...GG], victoryPoints: 13 });
    expect(checked).toBeGreaterThan(5000);
  }, timeout(120_000));
});

function applyOk(s: GameState, p: number, a: Action): boolean {
  return legalActions(s, p).some((x) => JSON.stringify(x) === JSON.stringify(a));
}
