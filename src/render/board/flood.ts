// A flood (the Oil expansion's disaster on a 7): the sea swells up over a coast (one island's, or
// every coast), waves breaking over it, sweeps the settlements on it out to sea and drowns the
// cities down to settlements, then eases back and leaves the coast dark and running wet. The
// sea's part is the ocean's surge (see env/ocean.ts: its flood layer says where, `surge` how high).

import * as THREE from 'three/webgpu';
import { isLand, type Board, type PlayerId } from '../../engine';
import { SEA_LEVEL, hexSdf } from './layout';
import { waterBurst } from '../fx/particles';
import { ease } from '../util/tween';
import { sfx } from '../../audio/sfx';
import type { World } from '../World';
import type { BoardView } from './boardView';
import { Noise } from '../util/noise';

export interface FloodEvent {
  island: number | null;
  washed: number[];
  dropped: number[];
  owners: Record<number, PlayerId>;
}

export interface FloodOptions {
  /** Shown at once, with nothing animated (the flat map). */
  instant?: boolean;
  /** Reduced motion: a lower, quieter swell, buildings taken off without being swept. */
  calm?: boolean;
}

/** How high the sea swells at the waterline (the cliffs stand 0.4 above it). */
const SURGE = 0.52;

/**
 * Where a flood reaches, on the sea's layer grid: all round the island it strikes (and out over the
 * water a little), or everywhere when it strikes every coast.
 */
function reachField(board: Board, island: number | null, size: number, extent: number): Float32Array {
  const field = new Float32Array(size * size);
  if (island === null) return field.fill(1);
  const hexes = board.hexes.filter((h) => isLand(h.terrain) && h.island === island);
  const cell = (2 * extent) / size;
  for (let j = 0; j < size; j++) {
    const z = (j + 0.5) * cell - extent;
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * cell - extent;
      let d = Infinity;
      for (const h of hexes) {
        const dx = x - h.x, dz = z - h.z;
        if (dx * dx + dz * dz > 12) continue;
        d = Math.min(d, hexSdf(dx, dz, 1));
      }
      field[j * size + i] = THREE.MathUtils.smoothstep(-d, -2.4, -0.9);
    }
  }
  return field;
}

/**
 * The flood shown on the island: resolves once the buildings are taken and the sea has begun to
 * ease back (it goes on settling meanwhile). The view's buildings are changed here: washed ones
 * removed, dropped ones made settlements.
 */
export async function flood(world: World, view: BoardView, board: Board, e: FloodEvent, o: FloodOptions = {}) {
  const ocean = world.ocean;
  const instant = !!o.instant || !ocean || !world.boardGroup.visible;
  const settle = () => {
    for (const v of e.washed) void view.removeBuilding(v, false);
    for (const v of e.dropped) void view.setBuilding(v, e.owners[v], 'settlement', false);
  };
  if (instant) {
    settle();
    soak(world, board, e.island);
    return;
  }
  const calm = !!o.calm;
  // (A game left meanwhile takes its flood with it: the sea goes back to the title's at once.)
  const owner = world.disasters;
  const gone = () => {
    if (world.disasters === owner) return false;
    ocean.surge.value = 0;
    ocean.surgeWaves.value = 0;
    return true;
  };
  const { size, extent } = ocean.layerGrid;
  ocean.setLayer(2, reachField(board, e.island, size, extent));
  const height = calm ? SURGE * 0.75 : SURGE;
  const anim = world.animator;
  sfx.play('thunder', { volume: calm ? 0.15 : 0.3 });
  // The swell: up over the coast, waves rolling in on it and breaking white.
  const rising = anim.tween({
    duration: calm ? 1.2 : 1.6,
    easing: ease.inOutCubic,
    update: (t) => {
      if (gone()) return;
      ocean.surge.value = height * t;
      ocean.surgeWaves.value = calm ? 0.4 * t : t;
    },
  }).promise;
  if (!calm) void breakers(world, board, e.island, 4.2);
  await anim.wait(calm ? 0.8 : 1.05);
  // At its height: the settlements swept out to sea, the cities drowned down.
  const taken = Promise.all([
    ...e.washed.map((v) => (calm ? view.removeBuilding(v, true) : sweep(world, view, board, v))),
    ...e.dropped.map((v) => view.setBuilding(v, e.owners[v], 'settlement', true)),
  ]);
  await Promise.all([rising, taken]);
  await anim.wait(calm ? 0.3 : 0.6);
  // Then it eases back, leaving the coast dark and streaming wet.
  soak(world, board, e.island);
  anim.tween({
    duration: calm ? 1.4 : 2.2,
    easing: ease.inOutCubic,
    update: (t) => {
      if (gone()) return;
      ocean.surge.value = height * (1 - t);
      ocean.surgeWaves.value = (calm ? 0.4 : 1) * (1 - t);
    },
    done: () => {
      ocean.surge.value = 0;
      ocean.surgeWaves.value = 0;
      ocean.setLayer(2, null);
    },
  });
  await anim.wait(0.5);
}

/** The flood's own noise, for the ragged line it reached up the shore. */
const markNoise = new Noise(613);

/**
 * The flooded coast's tiles soaked: dark, drying in patches over the next half minute (see
 * materials.ts), from the top of the shore down to the water's edge, with a line of wrack (weed
 * and flotsam) left along the highest reach of the water. How far up it reached is marked on the
 * contact map: by the distance inland, as the swell stood (see the ocean's swellAt), with a
 * ragged edge. (Marked all round; only the soaked tiles show it.)
 */
function soak(world: World, board: Board, island: number | null) {
  const fx = world.effects;
  const sdf = world.sdf;
  if (sdf)
    fx.contact.setFlood((x, z) => {
      const s = sdf.sample(x, z);
      if (s < -0.95) return 0;
      return THREE.MathUtils.smoothstep(s + markNoise.fbm2(x * 2.6, z * 2.6, 2) * 0.12, -0.72, -0.12);
    });
  const soaked = fx.soak.array as number[];
  const now = fx.now.value;
  for (const t of world.tiles?.tiles ?? []) {
    if (island !== null && board.hexes[t.hex.id]?.island !== island) continue;
    if (t.shape.ctx.landSide.every(Boolean)) continue;
    fx.soakValues[t.hex.id] = soaked[t.hex.id] = now;
  }
}

/** White water thrown up along the flooded coast while the waves break over it. */
function breakers(world: World, board: Board, island: number | null, seconds: number) {
  const shore = board.edges.filter((ed) => ed.coastal && ed.hexes.some((h) => isLand(board.hexes[h].terrain) && (island === null || board.hexes[h].island === island)));
  if (!shore.length) return null;
  let n = 0;
  return world.animator.tween({
    duration: seconds,
    easing: ease.linear,
    update: (t) => {
      for (const want = Math.floor(t * seconds * 9); n < want; n++) {
        const ed = shore[Math.floor(Math.random() * shore.length)];
        const a = board.vertices[ed.a], b = board.vertices[ed.b];
        const u = Math.random();
        const x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u;
        const up = Math.sin(Math.min(1, t * 2.2) * Math.PI * 0.5) * (1 - Math.max(0, (t - 0.55) / 0.45));
        waterBurst(world.particles.spray, world.particles.mist, { x, y: SEA_LEVEL + 0.08 + up * 0.38, z, count: 10, radius: 0.1, up: [0.5, 1.1], out: [0.15, 0.4], size: 0.032 });
      }
    },
  }).promise;
}

/**
 * A settlement swept away: lifted off its corner by the water, carried seaward, tipping over as it
 * goes, and drawn under in a swirl of foam, then gone from the board.
 */
function sweep(world: World, view: BoardView, board: Board, v: number): Promise<void> {
  const rec = view.buildings.get(v);
  if (!rec) return Promise.resolve();
  const obj = rec.obj;
  const vx = board.vertices[v];
  // Seaward: down the island's distance field.
  const sdf = world.sdf;
  const e = 0.05;
  let dx = sdf ? sdf.sample(vx.x + e, vx.z) - sdf.sample(vx.x - e, vx.z) : vx.x;
  let dz = sdf ? sdf.sample(vx.x, vx.z + e) - sdf.sample(vx.x, vx.z - e) : vx.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const from = obj.position.clone();
  const r0 = obj.rotation.clone();
  const spin = (v % 2 ? 1 : -1) * (0.6 + ((v * 37) % 5) * 0.1);
  let splashed = false;
  return world.animator
    .tween({
      duration: 1.7,
      easing: ease.linear,
      update: (t) => {
        if (view.cancelled) return;
        // Lifted and carried out, bobbing, then pulled down.
        const out = ease.outCubic(Math.min(1, t / 0.8)) * 0.55;
        const bob = Math.sin(t * 9) * 0.012 * (1 - t);
        const down = ease.inCubic(Math.max(0, (t - 0.45) / 0.55));
        obj.position.set(from.x + dx * out, from.y + 0.05 * Math.sin(Math.min(1, t * 3) * Math.PI * 0.5) + bob - down * 0.75, from.z + dz * out);
        obj.rotation.set(r0.x + dz * t * 0.9, r0.y + spin * t, r0.z - dx * t * 0.9);
        if (!splashed && t > 0.6) {
          splashed = true;
          waterBurst(world.particles.spray, world.particles.mist, { x: obj.position.x, y: SEA_LEVEL + SURGE * 0.8, z: obj.position.z, count: 22, radius: 0.08, up: [0.4, 0.9], out: [0.15, 0.35], size: 0.03 });
          world.wildlife?.addRipple(obj.position.x, obj.position.z, 0.3, 1.2);
        }
      },
    })
    .promise.then(() => view.removeBuilding(v, false));
}
