// The travellers on the players' roads (render/board/travellers.ts), driven without a renderer:
// they go the length of a network from house to house, over their own bridge, and turn round at
// another seat's house, which breaks the network there.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { createGame, type PlayerId } from '../src/engine';
import { Travellers } from '../src/render/board/travellers';
import { MARKS_SCALE } from '../src/render/board/layout';
import { FOUR } from './helpers';

const board = createGame(FOUR, { seed: 5 }).state.board;
const other = (e: number, v: number) => (board.edges[e].a === v ? board.edges[e].b : board.edges[e].a);
const land = (v: number) => board.vertices[v].land;

/** Three links of land in a row, corner to corner: v[0] e[0] v[1] e[1] v[2] e[2] v[3]. */
function row() {
  for (const start of board.vertices) {
    if (!start.land) continue;
    const v = [start.id];
    const e: number[] = [];
    while (e.length < 3) {
      const at = v.at(-1)!;
      const next = board.vertices[at].edges.find((x) => !e.includes(x) && land(other(x, at)) && !v.includes(other(x, at)));
      if (next === undefined) break;
      e.push(next);
      v.push(other(next, at));
    }
    if (e.length === 3) return { v, e };
  }
  throw new Error('no row of three links');
}

type Rec = { owner: PlayerId; obj: THREE.Object3D; kind: string };
const piece = (owner: PlayerId, kind = 'road'): Rec => ({ owner, obj: new THREE.Object3D(), kind });

/** Three minutes of the walkers out; where each went (the links it was on) and how high it stood on each. */
function walk(roads: Map<number, Rec>, buildings: Map<number, Rec>, bridges: Map<number, PlayerId>) {
  const t = new Travellers(board, ['red', 'blue', 'white', 'orange'], new THREE.MeshStandardNodeMaterial(), () => 0, roads, buildings, undefined, null, () => bridges, MARKS_SCALE);
  const on = new Map<number, number>();
  const near = new Map<number, number>();
  const walkers = (t as unknown as { walkers: { owner: PlayerId; edge: number; kind: string; root: THREE.Object3D }[] }).walkers;
  for (let i = 0; i < 180 * 30; i++) {
    t.update(1 / 30, i / 30);
    for (const w of walkers) {
      if (w.owner !== 0 || w.kind !== 'walker') continue;
      on.set(w.edge, Math.max(on.get(w.edge) ?? -Infinity, w.root.position.y));
      for (const [v] of buildings) {
        const d = Math.hypot(w.root.position.x - board.vertices[v].x, w.root.position.z - board.vertices[v].z);
        near.set(v, Math.min(near.get(v) ?? Infinity, d));
      }
    }
  }
  return { on, near };
}

describe('the travellers', () => {
  const { v, e } = row();
  // (Their paces, pauses and turnings are random: the same every run here.)
  beforeEach(() => {
    let x = 12345;
    vi.spyOn(Math, 'random').mockImplementation(() => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648));
  });
  afterEach(() => vi.restoreAllMocks());

  it('go house to house along their roads and over their bridge', () => {
    const roads = new Map([[e[0], piece(0)], [e[2], piece(0)]]);
    const buildings = new Map([[v[0], piece(0, 'settlement')], [v[3], piece(0, 'settlement')]]);
    const { on, near } = walk(roads, buildings, new Map([[e[1], 0]]));
    // Every link of the way, the bridge in the middle too, and up to both houses (turning round
    // with a loop short of them, well within the link: the next corner is a whole link away).
    for (const x of e) expect(on.has(x)).toBe(true);
    expect(near.get(v[0])).toBeLessThan(0.4);
    expect(near.get(v[3])).toBeLessThan(0.4);
    // On the bridge they walk its deck, up over its arch (the ground here is at 0).
    expect(on.get(e[1])!).toBeGreaterThan(0.05);
  });

  it('turn round at another seat’s house, which breaks the way', () => {
    const roads = new Map([[e[0], piece(0)], [e[1], piece(0)], [e[2], piece(0)]]);
    const buildings = new Map([[v[0], piece(0, 'settlement')], [v[2], piece(1, 'settlement')]]);
    const { on } = walk(roads, buildings, new Map());
    expect(on.size).toBeGreaterThan(0);
    // Whichever side of it they start on, they never get past it.
    const before = on.has(e[0]) || on.has(e[1]);
    expect(before && on.has(e[2])).toBe(false);
  });

  it('keep off another seat’s bridge', () => {
    const roads = new Map([[e[0], piece(0)], [e[2], piece(0)]]);
    const { on } = walk(roads, new Map(), new Map([[e[1], 1]]));
    expect(on.has(e[1])).toBe(false);
  });
});
