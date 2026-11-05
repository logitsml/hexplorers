// The expansions' pieces on the island (render/board/marks.ts), driven without a renderer: the
// batch they're drawn in, and where they stand as the board changes under them.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { applyAction, createGame, isLand, type GameState } from '../src/engine';
import { seenBoard } from '../src/engine/modules/sea/fog';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { ALL_HANDS, mixOf } from '../src/engine/presets';
import { MARKS_CAPACITY, ModuleMarks, type MarksContext } from '../src/render/board/marks';
import { busyAt, planShapes, tileAt, wetAt } from '../src/render/board/standing';
import { Noise } from '../src/render/util/noise';
import { topology } from '../src/engine/modules/invasion/topology';
import type { ParticleSystem } from '../src/render/fx/particles';
import type { LampLights } from '../src/render/fx/lampLights';
import { FOUR, patch } from './helpers';
import { slow, timeout } from './tier';

/** A world for the marks with flat ground, no lamps lit, no smoke drawn, and nothing in the water. */
function context(): MarksContext {
  return {
    ground: () => 0.1,
    smoke: { emit() {} } as unknown as ParticleSystem,
    lamps: { add: (parent: THREE.Object3D) => ({ light: parent.add(new THREE.Object3D()).children.at(-1), gain: 0 }) } as unknown as LampLights,
    rise: () => 0,
    obstacles: () => [],
    speed: () => 1,
    centre: new THREE.Vector3(),
    clear: () => {},
  };
}

const batchOf = (marks: ModuleMarks) => marks.group.children.find((o) => (o as THREE.BatchedMesh).isBatchedMesh) as THREE.BatchedMesh | undefined;

describe('the expansions’ pieces', () => {
  slow('never grow their batch, over whole games with every module out', () => {
    // (The review's game: All Hands but the fleet, to 25 points, seed 14; and all of it.)
    const all = mixOf(ALL_HANDS);
    const games = [
      { modules: all.modules.filter((m) => m !== 'fleet'), seed: 14, target: 25 },
      { modules: all.modules, seed: 3, target: all.target },
    ];
    let peak = 0;
    for (const g of games) {
      let state: GameState = createGame(FOUR, { layout: 'random', seed: g.seed, modules: g.modules, map: all.map, knobs: all.knobs, victoryPoints: g.target }).state;
      const marks = new ModuleMarks(state.board, new THREE.MeshStandardNodeMaterial(), context());
      const memories = state.players.map(() => createBotMemory());
      let t = 0;
      for (let step = 0; state.phase !== 'gameOver' && state.turn < 400; step++) {
        let acted = false;
        for (let i = 0; i < state.players.length && !acted; i++) {
          const p = (state.seq + i) % state.players.length;
          const action = botDecide(state, p, memories[p], 'hard');
          if (!action) continue;
          const r = applyAction(state, p, action);
          if (!r.ok) throw new Error(r.error);
          state = r.state;
          acted = true;
        }
        if (!acted) break;
        // Shown as a game shows it (staged, so pieces leave as others arrive), a little time between.
        void marks.sync(state, 'stage');
        for (let k = 0; k < 3; k++) marks.update(0.1, (t += 0.1));
        const b = batchOf(marks);
        if (b) {
          peak = Math.max(peak, b.instanceCount);
          expect(b.maxInstanceCount).toBe(MARKS_CAPACITY);
        }
      }
      marks.dispose();
    }
    // (These games put out more than 64, so a smaller batch would have to grow. The room is for
    // the most any game could put out, twice over.)
    expect(peak).toBeGreaterThan(64);
    expect(peak * 2).toBeLessThan(MARKS_CAPACITY);
  }, timeout(120_000));

  slow('stand on dry, open ground: no figure in a river, a pool or the clearing, on All Hands boards', () => {
    // The island's own tile shapes (planned as the world plans them, with its noise), so the
    // marks can ask the ground what the game asks it: every coastal hex holds raiders (a knot
    // and a camp), wardens stand on every coastal edge and at every third corner, and the
    // trader on the first hex with a resource.
    const all = mixOf(ALL_HANDS);
    const noise = new Noise(1337);
    const wet: string[] = [];
    let checked = 0;
    for (const seed of [3, 7, 14, 21, 33]) {
      const start = createGame(FOUR, { layout: 'random', seed, modules: all.modules, map: all.map, knobs: all.knobs, victoryPoints: all.target }).state;
      const tiles = planShapes(start.board, noise, seed);
      const ground = (x: number, z: number) => {
        const t = tileAt(tiles, x, z);
        return t ? t.shape.height(x - t.hex.x, z - t.hex.z) : 0;
      };
      const ctx: MarksContext = { ...context(), ground, wet: (x, z, r) => wetAt(tiles, x, z, r), busy: (x, z, r) => busyAt(tiles, x, z, r) };
      const state = patch(start, (s) => {
        const coast = topology(s.board).coastal;
        s.ext.invasion!.raiders = s.board.hexes.map((h) => (isLand(h.terrain) && coast[h.id] ? 3 : 0));
        let id = 0;
        s.wardens = [];
        s.board.edges.forEach((e, i) => {
          if (e.coastal && e.hexes.some((h) => isLand(s.board.hexes[h].terrain))) s.wardens.push({ id: id++, owner: i % 4, rank: ((i % 3) + 1) as 1 | 2 | 3, mustered: i % 2 === 0, vertex: null, edge: i, musteredTurn: 0 });
        });
        s.board.vertices.forEach((v, i) => {
          if (i % 3 === 0 && v.hexes.some((h) => isLand(s.board.hexes[h].terrain))) s.wardens.push({ id: id++, owner: i % 4, rank: ((i % 3) + 1) as 1 | 2 | 3, mustered: i % 2 === 1, vertex: i, edge: null, musteredTurn: 0 });
        });
        const hex = s.board.hexes.find((h) => isLand(h.terrain) && h.numbers.length && h.terrain !== 'desert')!;
        s.ext.guilds!.trader = { hex: hex.id, owner: 0 };
      });
      const marks = new ModuleMarks(state.board, new THREE.MeshStandardNodeMaterial(), ctx);
      void marks.sync(state, 'none');
      marks.update(0.1, 0);
      const pieces = (marks as unknown as { pieces: Map<string, { kind: string; x: number; z: number }> }).pieces;
      let camps = 0, raiders = 0;
      for (const [key, p] of pieces) {
        if (p.kind === 'camp') camps++;
        if (p.kind === 'raider') raiders++;
        if (p.kind !== 'raider' && p.kind !== 'camp' && p.kind !== 'warden' && p.kind !== 'trader') continue;
        checked++;
        if (wetAt(tiles, p.x, p.z, p.kind === 'raider' ? 0.03 : 0.07)) {
          const w = p.kind === 'warden' ? state.wardens[Number(key.split(':')[1])] : null;
          wet.push(`seed ${seed}: ${key}${w ? ` (edge ${w.edge}, corner ${w.vertex})` : ''} at ${p.x.toFixed(2)}, ${p.z.toFixed(2)} (${tileAt(tiles, p.x, p.z)?.hex.terrain})`);
        }
      }
      // (A knot of three and one camp per hex held, however many raiders are on it.)
      expect(raiders).toBe(camps * 3);
      marks.dispose();
    }
    expect(checked).toBeGreaterThan(200);
    expect(wet).toEqual([]);
  }, timeout(60_000));

  it('move off a coast that comes up out of the fog', () => {
    // The Fog Bank, seed 7: a face-down land hex, and a ship on its side to the open water.
    const mix = mixOf(['sea'], 'fogBank');
    const start = createGame(FOUR, { layout: 'random', seed: 7, modules: mix.modules, map: 'fogBank', knobs: mix.knobs, victoryPoints: mix.target }).state;
    const hidden = start.ext.sea!.fog!.hidden;
    const hex = hidden.find((h) => isLand(start.board.hexes[h].terrain) && start.board.hexes[h].edges.some((e) => start.board.edges[e].hexes.some((x) => x !== h && !hidden.includes(x))))!;
    const edge = start.board.hexes[hex].edges.find((e) => start.board.edges[e].hexes.length === 2 && start.board.edges[e].hexes.every((x) => x === hex || (start.board.hexes[x].terrain === 'sea' && !hidden.includes(x))))!;
    expect(edge).toBeDefined();
    const state = patch(start, (s) => (s.routes[edge] = { owner: 0, kind: 'ship', builtTurn: 0 }));
    const marks = new ModuleMarks(seenBoard(state.board, hidden), new THREE.MeshStandardNodeMaterial(), context());
    void marks.sync(state, 'none');
    // (The ship's own instance: the corsair, placed first so ships keep clear of it, may be another.)
    const ship = () => (marks as unknown as { pieces: Map<string, { id: number }> }).pieces.get(`ship:${edge}`)!.id;
    const at = () => {
      marks.update(0.1, 0);
      const m = batchOf(marks)!.getMatrixAt(ship(), new THREE.Matrix4()).elements;
      return { x: m[12], z: m[14] };
    };
    const land = state.board.hexes[hex];
    const off = (p: { x: number; z: number }) => Math.hypot(p.x - land.x, p.z - land.z);
    // Face down, the edge is open water both sides: the ship sits at its middle.
    const [a, c] = [state.board.vertices[state.board.edges[edge].a], state.board.vertices[state.board.edges[edge].b]];
    const before = at();
    expect(before.x).toBeCloseTo((a.x + c.x) / 2, 3);
    expect(before.z).toBeCloseTo((a.z + c.z) / 2, 3);
    // Found: the edge is coast, and the ship goes out past the new land's cliffs.
    marks.setBoard(seenBoard(state.board, hidden.filter((h) => h !== hex)));
    for (let i = 0; i < 20; i++) marks.update(0.1, 0);
    const after = at();
    expect(off(after) - off(before)).toBeGreaterThan(0.25);
    marks.dispose();
  });
});
