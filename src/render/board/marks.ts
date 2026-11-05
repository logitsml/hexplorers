// The expansions' pieces on the island: ships, merchantmen and the corsair on the water, the
// raiders' longships out at sea, wardens, raiders and their camps, wagons on their edges, bridges
// over the rivers, the castle on its hex, walls, guild seats and foundries at the buildings, and
// the split across a road a quake has cracked.
// Their models are in ships.ts, figures.ts and works.ts (on the kit in kit.ts).
//
// Every one of them is an instance in one batch drawn with the pieces' material (one draw, and
// one per shadow pass, however many pieces and colours are out), posed each frame from a
// placeholder object that stands where the piece is. The placeholders are what animate (a ship
// sailing to its new edge, a warden marching, the corsair crossing, raiders coming ashore), and
// what the board's sinking at the end of a game moves, as it moves the other pieces.
//
// The state decides what is where: `sync` compares it with what's shown, matches what has moved
// (a ship to another edge, a warden to another spot, the corsair to another hex) and animates the
// difference as asked: at once (a loaded game, reduced motion), gently (anything the presenter
// didn't stage), or staged (a move the presenter waits on).

import * as THREE from 'three/webgpu';
import { isLand, type Board, type GameState } from '../../engine';
import { FLEET_STEPS } from '../../engine/modules/fleet';
import { WIND, windStrength } from '../env/wind';

/** The pieces under sail, which heel to the wind. */
const SAILS = new Set(['ship', 'merchant', 'corsair', 'longship']);
const X_AXIS = new THREE.Vector3(1, 0, 0);
import { MARKS_SCALE, SEA_LEVEL, edgeFrame, hexSdf, roadFrame } from './layout';
import { Animator, ease } from '../util/tween';
import type { ParticleSystem } from '../fx/particles';
import type { Lamp, LampLights } from '../fx/lampLights';
import { WINDOW_LIGHT, lampColor } from '../fx/lamps';
import { makeCorsair, makeCourseBuoy, makeLongship, makeMerchant, makeShip } from './ships';
import { WAKE_SLOTS, seaWakeShape, seaWakes, seaWakesOn } from '../env/ocean';
import { LAYER_HEIGHT, cloudDrift, cloudSunDir, squall } from '../env/clouds';
import type { SeaLift } from './seaLift';
import { CAMP_FIRE, POST_FIRE, TRADER_LAMP, makeRaider, makeRaiderCamp, makeTrader, makeWarden } from './figures';
import { TOKEN_CLEAR } from './layout';
import { CASTLE_FORGE, CASTLE_SMOKE, CRACK_X, FOUNDRY_FIRE, FOUNDRY_SMOKE, makeBridge, makeCastle, makeCrack, makeFoundry, makeSeat, makeWagon, makeWall } from './works';

/** Pieces are modelled in the buildings' units and placed at their scale (see boardView's PIECE_SCALE). */
const SCALE = MARKS_SCALE;
/**
 * The posts, the raiders, their camp and the trader are built with their people at the
 * miniatures' proportions shrunk to the folk's (figures.ts), and placed at the travellers' scale
 * (2.1), so the island has one population: what reads from across it is each post's standard,
 * box, shields or pavilion, not an outsize figure.
 */
const FIGURE = SCALE * 1.15;
/** A player's ship (smaller in a crowded strait: see berth). Any larger and a run of them crowds a strait with their yards. */
const SHIP = SCALE * 1.5;
/** The raiders' longships, larger than the players' craft: the fleet's distance is a clock the whole table watches. */
const LONGSHIP = SCALE * 1.82;
/** Where a hull's waterline rides: a touch over the still sea, so the swell laps its sides but never its deck. */
const AFLOAT = SEA_LEVEL + 0.006;
/** The most a piece leans with a hillside under it (radians); its ground sinks for the rest. */
const LEAN = 0.3;
/** Ground steeper than this (rise over run) is no place to stand: a spot is chosen elsewhere. */
const STEEP = 0.6;
/** How much ground each piece takes from the trees and the grass when it arrives (0: none). */
const CLEARS: Partial<Record<Kind, number>> = { foundry: 0.22, seat: 0.16, castle: 0.5, camp: 0.24, warden: 0.11, raider: 0.05, wall: 0.3, wagon: 0.06, trader: 0.1 };
const FIRE = lampColor(1.0, 0.5, 0.18);
/** A furnace burns deeper than a campfire: orange-red, so its light on grass reads warm rather than lime. */
const FURNACE = lampColor(1.0, 0.34, 0.1);
const CAMP = lampColor(...WINDOW_LIGHT);

/** How a change in the state is shown. */
export type MarksMode = 'none' | 'soft' | 'stage';

type Kind = 'ship' | 'merchant' | 'corsair' | 'longship' | 'buoy' | 'warden' | 'raider' | 'camp' | 'wagon' | 'bridge' | 'wall' | 'seat' | 'foundry' | 'castle' | 'trader' | 'cracked';

/** Where a piece should be, and as what. */
interface Spec {
  kind: Kind;
  /** The model (a key into the geometries kept for the session's board). */
  geo: string;
  make: () => THREE.BufferGeometry;
  x: number;
  y: number;
  z: number;
  /** Heading in xz (radians from +x towards +z): the model's +x points this way. */
  angle: number;
  scale: number;
  /** Rides the swell. */
  afloat?: boolean;
  /** The hex whose rise (as the island comes up out of the sea) it rises with. */
  hex?: number;
  /** A player's piece, held back with the buildings until the island has risen. */
  owned?: boolean;
  /** Its owner, for matching a ship that moved. */
  owner?: number;
  /** A lean with the ground under it (see footing): the turn towards uphill, about x and z. */
  lean?: [number, number];
  /** How open the water is where it floats (see openness): how much it bobs. */
  swell?: number;
}

interface Piece extends Spec {
  key: string;
  obj: THREE.Object3D;
  id: number;
  /** How far it has appeared (0..1): scales it in and out. */
  pop: number;
  /** Swell phase. */
  phase: number;
  /** A tween moving it, cancelled by the next. */
  tween: number;
  gone: boolean;
  lamp: Lamp | null;
  smoke: number;
  /** How much wake it leaves (0..1, eased), and where it was last frame (see wakes). */
  wake: number;
  lx: number;
  lz: number;
  /** The matrix last written for it: the batch's matrices go up to the GPU again only when one changes. */
  m: THREE.Matrix4 | null;
}

export interface MarksContext {
  /** Height of the ground at (x, z). */
  ground: (x: number, z: number) => number;
  smoke: ParticleSystem;
  lamps: LampLights;
  /** A hex's height below its place while the island rises (0 once risen). */
  rise: (hex: number) => number;
  /** What stands in the water off the coast (piers, moored boats), as circles. */
  obstacles: () => { x: number; z: number; r: number }[];
  /** The world's animation speed. */
  speed: () => number;
  /** The island's middle. */
  centre: THREE.Vector3;
  /** Make room for a piece: trees within r of (x, z) go, and the grass and crops are trodden down. */
  clear: (x: number, z: number, r: number) => void;
  /** Whether a piece of radius r at (x, z) would stand in a river or standing water (see standing.ts). */
  wet?: (x: number, z: number, r: number) => boolean;
  /** Whether the terrain keeps the spot for something else: a hex's clearing, lanes, corners, a well's pad. */
  busy?: (x: number, z: number, r: number) => boolean;
  /** How far a flood has lifted the sea at (x, z) (see seaLift.ts): what floats rides up with it. */
  lift?: SeaLift;
}

/** How far a figure, seat or foundry stands from its corner, beside the building there (more round a walled city). */
const BESIDE = 0.34;
const BESIDE_WALLED = 0.4;
/** A foundry beside a walled city stands clear of the ring and its towers. */
const FOUNDRY_WALLED = 0.52;

/**
 * Instances the batch is made with: twice the most pieces any game can have out at once, so that
 * every one of them could be leaving while its successor arrives. A seat has at most 15 ships, 6
 * wardens, 3 walls, 3 bridges and a seat and a foundry at each of its 4 cities (35, so 140 for
 * four seats), and the table at most 36 raiders, 12 camps, 22 wagons, the fleet's 3 longships,
 * the corsair and the castle (75): about 215, so 430 while a whole board changes over. (Cracked
 * roads come one a player a quake and go as they're mended: a handful at most.) It mustn't
 * have to grow: under motion blur three keeps each batch's previous matrices in a texture sized
 * when it was first drawn, and a grown batch overflows it every frame (a RangeError: the
 * travellers' batch is sized so for the same reason, see BATCH_PARTS in travellers.ts).
 */
export const MARKS_CAPACITY = 512;

export class ModuleMarks {
  readonly group = new THREE.Group();
  private batch: THREE.BatchedMesh | null = null;
  /**
   * The batch's geometry room, made big enough at the start for a full game's models (a late All
   * Hands board holds 33-40 of them, about 120k vertices): growing it mid-game rebuilds the
   * batch's geometry on the frame a new model first appears.
   */
  private room = { vertices: 131072, indices: 393216 };
  private used = { vertices: 0, indices: 0 };
  private geos = new Map<string, { geo: THREE.BufferGeometry; id: number }>();
  private pieces = new Map<string, Piece>();
  private anim = new Animator();
  /** Players' pieces held out of sight until the island has risen (see hide). */
  private held = false;
  private tmp = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private lean = new THREE.Quaternion();
  private heel = new THREE.Quaternion();
  private axis = new THREE.Vector3();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private stopped = false;
  /** The state last shown, and how many things stood in the water then (see update). */
  private last: GameState | null = null;
  private obstacleCount = 0;
  private recheck = 0;

  constructor(
    private board: Board,
    private material: THREE.Material,
    private ctx: MarksContext,
  ) {
    this.group.name = 'module marks';
  }

  // ------------------------------------------------------------------ the batch

  /** A new instance of a model in the batch. */
  private instance(key: string, make: () => THREE.BufferGeometry): number {
    const id = this.geoId(key, make);
    const batch = this.batch!;
    // (Never reached in play: see MARKS_CAPACITY.)
    if (batch.instanceCount >= batch.maxInstanceCount) batch.setInstanceCount(batch.maxInstanceCount * 2);
    return batch.addInstance(id);
  }

  /** A model's place in the batch, added (and the batch grown, if it must be) the first time it's wanted. */
  private geoId(key: string, make: () => THREE.BufferGeometry): number {
    let batch = this.batch;
    if (!batch) {
      batch = this.batch = new THREE.BatchedMesh(MARKS_CAPACITY, this.room.vertices, this.room.indices, this.material);
      batch.castShadow = true;
      batch.receiveShadow = true;
      batch.sortObjects = false;
      // Never culled: the batch's bounds as a whole go stale as its pieces move, and culling
      // piece by piece dropped the castle from close views it filled (as the travellers' batch,
      // whose culling is off for the same reasons). Its pieces are few and light.
      batch.frustumCulled = false;
      batch.perObjectFrustumCulled = false;
      batch.name = 'module pieces';
      this.group.add(batch);
    }
    let g = this.geos.get(key);
    if (!g) {
      const geo = make();
      const v = geo.getAttribute('position').count, i = geo.getIndex()!.count;
      if (this.used.vertices + v > this.room.vertices || this.used.indices + i > this.room.indices) {
        this.room.vertices = Math.max(this.room.vertices * 2, this.used.vertices + v);
        this.room.indices = Math.max(this.room.indices * 2, this.used.indices + i);
        batch.setGeometrySize(this.room.vertices, this.room.indices);
      }
      g = { geo, id: batch.addGeometry(geo) };
      this.used.vertices += v;
      this.used.indices += i;
      this.geos.set(key, g);
    }
    return g.id;
  }

  /** Where a piece stands now, by its key ('corsair', `camp:${hex}`), or null when it isn't out. */
  where(key: string): THREE.Vector3 | null {
    const p = this.pieces.get(key);
    return p && !p.gone ? p.obj.position.clone() : null;
  }

  /**
   * Ready the batch for the game-start precompile, in a game with the expansions' pieces: the real
   * batch is made now if it isn't yet, holding one piece out of sight while the shaders build, so
   * its node builds (three makes them per batch, in every pass) are done before the game rather
   * than on the frame the first ship, seat or wall appears. Returns what takes that piece away.
   */
  standIn(): (() => void) | null {
    // The pools of firelight that stand in for lamp light where there is none (see groundGlow.ts):
    // made now, so they compile with the game. (In the scene itself, not under the board, whose
    // release at the game's end would let the renderer forget them.)
    let root: THREE.Object3D = this.group;
    while (root.parent) root = root.parent;
    const glow = this.ctx.lamps.groundGlow?.();
    if (glow && !glow.parent && (root as THREE.Scene).isScene) root.add(glow);
    // (A game resumed with pieces out has its batch, pieces and all, in the scene already.)
    if (this.batch && this.pieces.size) return null;
    const id = this.instance('raider', makeRaider);
    this.batch!.setMatrixAt(id, new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4));
    return () => this.batch?.deleteInstance(id);
  }

  // ------------------------------------------------------------------ where things go

  /**
   * Circles in the water a hull keeps clear of, gathered afresh by each `desired`: the harbours'
   * piers and moored boats, the fishing grounds' rafts and nets, and each hull already placed.
   */
  private water: { x: number; z: number; r: number }[] = [];

  /** The land hexes, for keeping hulls off the coast (see clearance). */
  private landHexes: { x: number; z: number }[] | null = null;
  /** What is near the spot being berthed (see berth): the water's circles and the land. */
  private nearWater: { x: number; z: number; r: number }[] = [];
  private nearLand: { x: number; z: number }[] = [];

  /**
   * The room a hull (half-length `half`, half-beam `beam`) at (x, z) heading `a` has from
   * everything in the water near it and from the coast (the cliffs' rocks reach a little way out);
   * below 0 it touches.
   */
  private clearance(x: number, z: number, a: number, half: number, beam: number) {
    const ax = Math.cos(a), az = Math.sin(a);
    let m = Infinity;
    for (const f of [-0.9, -0.45, 0, 0.45, 0.9]) {
      const px = x + ax * half * f, pz = z + az * half * f;
      for (const o of this.nearWater) m = Math.min(m, Math.hypot(o.x - px, o.z - pz) - o.r - beam);
      for (const h of this.nearLand) m = Math.min(m, hexSdf(px - h.x, pz - h.z, 1) - beam - 0.1);
    }
    return m;
  }

  /** A hull takes its place in the water, so the next keeps clear of it. */
  private moor(x: number, z: number, a: number, half: number, beam: number) {
    const ax = Math.cos(a), az = Math.sin(a);
    for (const f of [-0.9, -0.45, 0, 0.45, 0.9]) this.water.push({ x: x + ax * half * f, z: z + az * half * f, r: beam + 0.04 });
  }

  /**
   * The first of `spots` (heading `a`) where a hull clears everything, or else the roomiest. Where
   * nothing has room (a run of ships in a narrow strait), the hull is made smaller, down to 0.7 of
   * its size, until one does: crowded water shows smaller ships, never two in one another. It is
   * moored there; `fit` is the share of its size it keeps.
   */
  private berth(spots: { x: number; z: number; a: number }[], half: number, beam: number) {
    // (Only what could touch it is worth testing.)
    const o = spots[0], R = half + 1.6;
    this.nearWater = this.water.filter((w) => Math.hypot(w.x - o.x, w.z - o.z) < R + w.r);
    this.landHexes ??= this.board.hexes.filter((h) => isLand(h.terrain));
    this.nearLand = this.landHexes.filter((h) => Math.hypot(h.x - o.x, h.z - o.z) < R + 1.4);
    let best = spots[0], most = -Infinity, fit = 1;
    for (const k of [1, 0.9, 0.8, 0.7]) {
      let found = false;
      for (const c of spots) {
        const r = this.clearance(c.x, c.z, c.a, half * k, beam * k);
        if (r >= 0.05) {
          [best, most, fit, found] = [c, r, k, true];
          break;
        }
        if (r > most) [best, most, fit] = [c, r, k];
      }
      if (found || most >= 0) break;
    }
    this.moor(best.x, best.z, best.a, half * fit, beam * fit);
    return { ...best, fit };
  }

  /**
   * How open the water is at (x, z), 0.15 under the coast to 1 well out (as the sea's own shore
   * factor damps its swell, from the distance to the nearest land): hulls ride higher, and bob
   * more, where the swell runs higher.
   */
  private openness(x: number, z: number) {
    let d = Infinity;
    for (const h of this.board.hexes) if (isLand(h.terrain)) d = Math.min(d, Math.hypot(h.x - x, h.z - z));
    return THREE.MathUtils.smoothstep(d - 0.95, -0.05, 2.2) * 0.85 + 0.15;
  }

  /** Where a hull floats, given how open the water is there: the swell's crests stay below its deck. */
  private afloatY(x: number, z: number) {
    return AFLOAT + 0.012 + 0.05 * this.openness(x, z);
  }

  /**
   * Where an edge's hull floats (half-length `half`, half-beam `beam`): about a sea edge's middle,
   * or off a coast edge, out past the cliffs, sliding along the coast or further out until it
   * clears the harbours, the fishing grounds and the hulls already placed. `heading` turns it
   * (a convoy's bows follow its route; otherwise it lies along the edge), and `held` is where it
   * lies now, if it is already there: it keeps that berth while it still has room.
   */
  private atSea(e: number, half: number, beam: number, heading?: number, held?: { x: number; z: number; a: number }) {
    const f = edgeFrame(this.board, e);
    const sea = this.board.edges[e].hexes.map((h) => this.board.hexes[h]).filter((h) => !isLand(h.terrain));
    const land = this.board.edges[e].hexes.some((h) => isLand(this.board.hexes[h].terrain));
    const ax = Math.cos(f.angle), az = Math.sin(f.angle);
    // Out from the coast (towards the sea hex), or either way across a sea edge.
    let ux = -az, uz = ax;
    if (land && sea.length) {
      const d = Math.hypot(sea[0].x - f.x, sea[0].z - f.z) || 1;
      ux = (sea[0].x - f.x) / d;
      uz = (sea[0].z - f.z) / d;
    }
    const outs = land && sea.length ? [0.3, 0.44, 0.6, 0.78, 0.96, 1.1] : [0, 0.18, -0.18, 0.34, -0.34];
    const spots: { x: number; z: number; a: number }[] = [];
    if (held) spots.push(held);
    const a0 = heading ?? f.angle;
    // (Nearest first; then swung a little off the line of the edge, as a ship at anchor lies to the wind.)
    for (const turn of [0, 0.3, -0.3]) for (const out of outs) for (const along of [0, 0.18, -0.18, 0.34, -0.34, 0.48, -0.48]) spots.push({ x: f.x + ux * out + ax * along, z: f.z + uz * out + az * along, a: a0 + turn });
    const at = this.berth(spots, half, beam);
    return { x: at.x, z: at.z, angle: at.a, fit: at.fit };
  }

  /** Where a piece already on the board lies, if it is there to stay (not leaving): a berth it may keep. */
  private heldAt(key: string) {
    const p = this.pieces.get(key);
    return p && !p.gone ? { x: p.x, z: p.z, a: p.angle } : undefined;
  }

  /**
   * Which way each ship's bow points: along its route, so a run of ship edges reads as a convoy
   * in line astern, sailing from the end at the owner's building (or the run's first corner) to
   * the loose end, the lead ship there. Each run is one owner's chain of ship edges.
   */
  private convoys(s: GameState) {
    const heading = new Map<number, number>();
    const board = this.board;
    const ships = new Map<number, number>();
    s.routes.forEach((r, e) => {
      if (r?.kind === 'ship') ships.set(e, r.owner);
    });
    const seen = new Set<number>();
    for (const [e0, owner] of ships) {
      if (seen.has(e0)) continue;
      // The run: every ship edge of this owner joined to it, corner to corner.
      const run: number[] = [];
      const todo = [e0];
      seen.add(e0);
      while (todo.length) {
        const e = todo.pop()!;
        run.push(e);
        for (const v of [board.edges[e].a, board.edges[e].b])
          for (const n of board.vertices[v].edges)
            if (!seen.has(n) && ships.get(n) === owner) {
              seen.add(n);
              todo.push(n);
            }
      }
      const degree = (v: number) => board.vertices[v].edges.filter((n) => ships.get(n) === owner).length;
      const ends = [...new Set(run.flatMap((e) => [board.edges[e].a, board.edges[e].b]))].filter((v) => degree(v) === 1);
      const home = (v: number) => s.buildings[v]?.owner === owner;
      const start = ends.find(home) ?? ends.sort((p, q) => p - q)[0] ?? board.edges[e0].a;
      // Walk out from the start, each edge's bow towards the corner further along.
      const order = new Map<number, number>([[start, 0]]);
      const queue = [start];
      while (queue.length) {
        const v = queue.shift()!;
        for (const e of board.vertices[v].edges) {
          if (ships.get(e) !== owner || heading.has(e)) continue;
          const w = board.edges[e].a === v ? board.edges[e].b : board.edges[e].a;
          const a = board.vertices[v], b = board.vertices[w];
          heading.set(e, Math.atan2(b.z - a.z, b.x - a.x));
          if (!order.has(w)) {
            order.set(w, order.get(v)! + 1);
            queue.push(w);
          }
        }
      }
    }
    return heading;
  }

  /**
   * The lowest ground under a base of radius r at (x, z), and how far the piece leans with the
   * slope there: up to LEAN, as a miniature settles on a hillside, its base sunk for the rest
   * of the slope so no edge of it stands off the downhill side.
   */
  private footing(x: number, z: number, r: number) {
    const g = this.ctx.ground;
    const gx = (g(x + r, z) - g(x - r, z)) / (2 * r), gz = (g(x, z + r) - g(x, z - r)) / (2 * r);
    const slope = Math.hypot(gx, gz);
    const tilt = Math.min(Math.atan(slope), LEAN);
    const rest = Math.max(0, slope - Math.tan(tilt));
    return { y: g(x, z) - rest * r - 0.002, lean: slope > 1e-4 ? ([(gx / slope) * tilt, (gz / slope) * tilt] as [number, number]) : undefined };
  }

  /** The ground's slope (rise over run) under a piece of radius r at (x, z). */
  private slope(x: number, z: number, r: number) {
    const g = this.ctx.ground;
    return Math.hypot((g(x + r, z) - g(x - r, z)) / (2 * r), (g(x, z + r) - g(x, z - r)) / (2 * r));
  }

  /**
   * How bad a spot is for a piece of radius r: its slope, more if it is on ground the terrain
   * keeps for something else, and far more if it is in the water (both when the board can say),
   * so that dry ground wins over everything else.
   */
  private cost(x: number, z: number, r: number, strict = true) {
    let c = this.slope(x, z, r);
    if (c > STEEP) c += 2;
    if (this.ctx.wet?.(x, z, r)) c += 100;
    if (strict && this.ctx.busy?.(x, z, r)) c += 4;
    for (const t of this.taken) if (Math.hypot(t.x - x, t.z - z) < t.r + r) c += 3;
    return c;
  }

  /** The ground the pieces placed so far by this `desired` stand on, so the next keeps off it. */
  private taken: { x: number; z: number; r: number }[] = [];

  /** The best of `spots` for a piece of radius r (the first costing nothing, else the cheapest). */
  private pick<T extends { x: number; z: number }>(spots: T[], r: number, strict = true): T {
    let best = spots[0], least = Infinity;
    for (const s of spots) {
      const c = this.cost(s.x, s.z, r, strict);
      if (c < least) [best, least] = [s, c];
      if (c < 0.25) break;
    }
    return best;
  }

  /** A spot at or near (x, z) for a piece of radius r: the spot itself if it's dry and flat, else the best within `reach`. */
  private settle(x: number, z: number, r: number, reach: number, strict = true) {
    const spots = [{ x, z }];
    for (const d of [0.5, 1]) for (let i = 0; i < 8; i++) spots.push({ x: x + Math.cos(i * 0.785 + d) * reach * d, z: z + Math.sin(i * 0.785 + d) * reach * d });
    return this.pick(spots, r, strict);
  }

  /** Where the `k`th raider (-1, 0, 1) of a knot stands about its site: out on the side they came from, settled on dry ground. */
  private knotSpot(at: { x: number; z: number; a: number }, k: number) {
    const a = at.a + k * 0.7;
    const x = at.x + Math.cos(a) * 0.12, z = at.z + Math.sin(a) * 0.12;
    // (Close by if the ground there is dry; a swamp's pools can leave no dry footing that near,
    // so the raider looks further out before it would stand in the water.)
    let p = this.settle(x, z, 0.04, 0.07);
    for (const reach of [0.14, 0.22]) {
      if (!this.ctx.wet?.(p.x, p.z, 0.04)) break;
      p = this.settle(x, z, 0.04, reach);
    }
    return p;
  }

  /**
   * Where raiders make their stand on a hex: the best spot on a ring about its middle (flat, dry,
   * off the clearing, the lanes and the hex's landmark), and where the choice is close, towards
   * the camera's usual place (+z), where the hex's own peak or trees can't hide it. Cached by
   * hex; the board's change clears it.
   */
  private sites = new Map<number, { x: number; z: number; a: number }>();
  private site(hex: number) {
    let s = this.sites.get(hex);
    if (!s) {
      const h = this.board.hexes[hex];
      const spots: { x: number; z: number; a: number; c: number }[] = [];
      for (let i = 0; i < 12; i++) for (const r of [0.48, 0.4, 0.56]) {
        const a = (i / 12) * Math.PI * 2 + hex * 0.37;
        const x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
        // (The knot of three stands about it, so their ground counts too, as it is before they
        // settle: a dry site with a wet knot can still cost less than a wet site; a little for
        // lying away from the camera, and for leaving the ring's middle radius.)
        let c = this.cost(x, z, 0.09) + this.damp(x, z) + (1 - Math.sin(a)) * 0.3 + Math.abs(r - 0.48) * 2;
        for (const k of [-1, 0, 1]) c += this.cost(x + Math.cos(a + k * 0.7) * 0.12, z + Math.sin(a + k * 0.7) * 0.12, 0.04) * 0.1;
        spots.push({ x, z, a, c });
      }
      spots.sort((p, q) => p.c - q.c);
      // (A swamp can be pools and river all round the ring: then the whole hex is searched more
      // finely, and dry ground the terrain keeps for something else beats standing in the water.)
      if (spots[0].c >= 100) {
        for (let i = 0; i < 36; i++) for (let r = 0.2; r <= 0.76; r += 0.04) {
          const a = (i / 36) * Math.PI * 2 + hex * 0.37;
          const x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
          spots.push({ x, z, a, c: this.cost(x, z, 0.09) + this.damp(x, z) + (1 - Math.sin(a)) * 0.3 });
        }
        spots.sort((p, q) => p.c - q.c);
      }
      s = spots[0];
      this.sites.set(hex, s);
    }
    return s;
  }

  /**
   * Water within a camp's footprint that its edge samples can miss: the board samples a spot's
   * middle and four points round it, so a pool can lie between them at one size and not another.
   */
  private damp(x: number, z: number) {
    return this.ctx.wet?.(x, z, 0.05) || this.ctx.wet?.(x, z, 0.07) ? 100 : 0;
  }

  /**
   * The spots beside a corner, clear of its roads: towards the middle of each hex round it (land
   * first), at `r`. A seat, a foundry and a warden at one building take one each.
   */
  private beside(v: number, r: number) {
    const vx = this.board.vertices[v];
    return vx.hexes
      .map((h) => {
        const hx = this.board.hexes[h];
        const d = Math.hypot(hx.x - vx.x, hx.z - vx.z) || 1;
        // Facing out from the building.
        return { x: vx.x + ((hx.x - vx.x) / d) * r, z: vx.z + ((hx.z - vx.z) / d) * r, angle: Math.atan2(hx.z - vx.z, hx.x - vx.x), land: isLand(hx.terrain) };
      })
      // Land first, and then the side nearest the camera's usual place (+z), where the building can't hide it.
      .sort((p, q) => Number(q.land) - Number(p.land) || q.z - p.z);
  }

  /**
   * A spot beside the building at corner v for one more piece: the `prefer`red one (0 the front,
   * 2 the back) if it's free, or else any free one on land, or any free one at all.
   */
  private claim(taken: Map<number, Set<number>>, v: number, prefer: number, r: number) {
    const spots = this.beside(v, r);
    const used = taken.get(v) ?? new Set<number>();
    taken.set(v, used);
    const order = [prefer, 0, 1, 2].filter((i) => i < spots.length);
    const i = order.find((i) => !used.has(i) && spots[i].land) ?? order.find((i) => !used.has(i)) ?? order[0];
    used.add(i);
    return spots[i];
  }

  /**
   * The turn of the building at corner v, as boardView.setBuilding gives it (outward from the
   * island's middle, with a little variety), as a heading: a wall is modelled in its city's own
   * frame, so it takes the same turn.
   */
  private buildingAngle(v: number) {
    const vx = this.board.vertices[v];
    return -(Math.atan2(vx.x, vx.z) + ((v * 37) % 7) * 0.12 - 0.36);
  }

  /** Where everything the state has should be. */
  private desired(s: GameState): Map<string, Spec> {
    const out = new Map<string, Spec>();
    const colors = s.players.map((p) => p.color);
    const ground = this.ctx.ground;
    const put = (key: string, spec: Spec) => out.set(key, spec);
    const board = this.board;
    this.taken = [];
    // What a hull keeps clear of: the harbours, and each fishing ground's raft and ring of nets.
    this.water = [...this.ctx.obstacles(), ...board.hexes.filter((h) => !isLand(h.terrain) && h.numbers.length).map((h) => ({ x: h.x, z: h.z, r: 0.62 }))];
    // Hulls on the water: those already shown are berthed first, each keeping its spot while it
    // still has room, so a newcomer finds room round them rather than pushing them aside.
    type Berth = { x: number; z: number; a: number };
    const hulls: { key: string; place: (held?: Berth) => void; keeps?: (held: Berth) => boolean }[] = [];
    const corsair = s.ext.sea?.corsair ?? null;
    if (corsair !== null) {
      // Lying off the hex's middle (where a fishing ground moors its raft), broadside to the
      // island, on its seaward side if there's room there, or else round the hex until there is.
      const h = board.hexes[corsair];
      hulls.push({
        key: 'corsair',
        // (Its old berth counts only while it is still at this hex: moved, it comes as a newcomer.)
        keeps: (held) => Math.hypot(held.x - h.x, held.z - h.z) < 0.9,
        place: (held) => {
          const a0 = Math.atan2(h.z - this.ctx.centre.z, h.x - this.ctx.centre.x);
          const spots: { x: number; z: number; a: number }[] = [];
          if (held) spots.push(held);
          for (const r of [0.45, 0.62, 0.78]) for (const k of [0, 1, -1, 2, -2, 3]) {
            const a = a0 + (k * Math.PI) / 3;
            spots.push({ x: h.x + Math.cos(a) * r, z: h.z + Math.sin(a) * r, a: a + Math.PI / 2 });
          }
          const at = this.berth(spots, 0.4, 0.17);
          put('corsair', { kind: 'corsair', geo: 'corsair', make: makeCorsair, x: at.x, y: this.afloatY(at.x, at.z), z: at.z, angle: at.a, scale: SCALE * 1.3 * at.fit, afloat: true, swell: this.openness(at.x, at.z) });
        },
      });
    }
    const heading = this.convoys(s);
    // Ships, and bridges over the rivers.
    s.routes.forEach((r, e) => {
      if (r?.kind === 'ship') {
        const c = colors[r.owner], owner = r.owner;
        hulls.push({
          key: `ship:${e}`,
          place: (held) => {
            const at = this.atSea(e, 0.37, 0.1, heading.get(e), held);
            put(`ship:${e}`, { kind: 'ship', geo: `ship:${c}`, make: () => makeShip(c), x: at.x, y: this.afloatY(at.x, at.z), z: at.z, angle: at.angle, scale: SHIP * at.fit, afloat: true, owned: true, owner, swell: this.openness(at.x, at.z) });
          },
        });
      } else if (r?.kind === 'bridge') {
        const c = colors[r.owner];
        const f = edgeFrame(board, e);
        // (The banks either side of the river, not the river bed at its middle.)
        const y = Math.max(ground(f.ax * 0.7 + f.bx * 0.3, f.az * 0.7 + f.bz * 0.3), ground(f.ax * 0.3 + f.bx * 0.7, f.az * 0.3 + f.bz * 0.7));
        put(`bridge:${e}`, { kind: 'bridge', geo: `bridge:${c}`, make: () => makeBridge(c), x: f.x, y, z: f.z, angle: f.angle, scale: SCALE, owned: true });
      } else if (r?.kind === 'road' && r.cracked) {
        // A road a quake has cracked (Almanac): the split laid over it, where and as the road
        // stands (boardView.setRoad), until it's mended.
        const c = colors[r.owner];
        const f = roadFrame(board, e);
        const y = Math.max(ground(f.ax * 0.75 + f.bx * 0.25, f.az * 0.75 + f.bz * 0.25), ground(f.x, f.z)) + 0.002;
        put(`cracked:${e}`, { kind: 'cracked', geo: `cracked:${c}`, make: () => makeCrack(c), x: f.x, y, z: f.z, angle: f.angle, scale: 1, owned: true });
      }
    });
    const fleet = s.ext.fleet;
    if (fleet) {
      for (let i = 0; i < 3; i++) {
        const at = this.fleetSpot(fleet.position, i);
        put(`fleet:${i}`, { kind: 'longship', geo: `longship:${i}`, make: () => makeLongship(i), x: at.x, y: this.afloatY(at.x, at.z), z: at.z, angle: at.angle, scale: LONGSHIP, afloat: true, swell: this.openness(at.x, at.z) });
      }
      // A buoy at every step still to sail, the last off the coast where the fleet will land:
      // the line of them is the fleet's clock, one going under as it passes each.
      const course = this.fleetCourse();
      for (let k = fleet.position + 1; k <= FLEET_STEPS; k++) {
        const landing = k === FLEET_STEPS;
        const p = course.at(k);
        // (The landing buoy keeps clear of a harbour or a fishing ground there, along the coast.)
        const at = landing ? this.berth([0, 0.25, -0.25, 0.5, -0.5].map((o) => ({ x: p.x - course.uz * o, z: p.z + course.ux * o, a: course.bearing })), 0.04, 0.04) : { x: p.x, z: p.z, a: course.bearing };
        put(`buoy:${k}`, { kind: 'buoy', geo: landing ? 'buoy:landing' : 'buoy', make: () => makeCourseBuoy(landing), x: at.x, y: AFLOAT + 0.004, z: at.z, angle: course.bearing + Math.PI / 2 + k, scale: SCALE * (landing ? 1.7 : 1.5), afloat: true, swell: this.openness(at.x, at.z) });
      }
    }
    // Raiders in a knot at their stand on each hex they hold, facing out the way they came in;
    // three make a camp there, and more raiders a bigger camp rather than more figures.
    s.ext.invasion?.raiders.forEach((n, hex) => {
      // (A hex no raider holds has no stand: nothing to place, and no ground to keep for them.)
      if (n <= 0) return;
      const at = this.site(hex);
      for (let i = 0; i < Math.min(n, 3); i++) {
        const k = i === 0 ? 0 : i === 1 ? -1 : 1;
        const p = this.knotSpot(at, k);
        const foot = this.footing(p.x, p.z, 0.035);
        put(`raider:${hex}:${i}`, { kind: 'raider', geo: 'raider', make: makeRaider, x: p.x, y: foot.y, z: p.z, angle: at.a + k * 0.35, scale: FIGURE, hex, lean: foot.lean });
      }
      this.taken.push({ x: at.x, z: at.z, r: 0.16 });
      if (n >= 3) {
        const size = n >= 6 ? 3 : n >= 4 ? 2 : 1;
        const foot = this.footing(at.x, at.z, 0.1);
        put(`camp:${hex}`, { kind: 'camp', geo: `camp:${size}`, make: () => makeRaiderCamp(size), x: at.x, y: foot.y, z: at.z, angle: at.a + Math.PI, scale: FIGURE, hex, lean: foot.lean });
      }
    });
    // The guilds' trader at his stall: on his hex, at the edge of its clearing on the side of
    // the building he trades beside, facing the disc.
    const trader = s.ext.guilds?.trader;
    if (trader) {
      const h = board.hexes[trader.hex];
      const near = h.vertices.find((v) => s.buildings[v]?.owner === trader.owner) ?? h.vertices[0];
      const vx = board.vertices[near];
      const a = Math.atan2(vx.z - h.z, vx.x - h.x) + 0.35;
      const p = this.settle(h.x + Math.cos(a) * (TOKEN_CLEAR + 0.1), h.z + Math.sin(a) * (TOKEN_CLEAR + 0.1), 0.08, 0.1);
      const foot = this.footing(p.x, p.z, 0.07);
      this.taken.push({ x: p.x, z: p.z, r: 0.1 });
      put('trader', { kind: 'trader', geo: `trader:${colors[trader.owner]}`, make: () => makeTrader(colors[trader.owner]), x: p.x, y: foot.y, z: p.z, angle: Math.atan2(h.z - p.z, h.x - p.x), scale: FIGURE, owned: true, owner: trader.owner, lean: foot.lean });
    }
    // The castle, on its hex, its gate towards the island's middle.
    const castle = board.features.castle;
    if (castle !== undefined && s.ext.invasion) {
      const h = board.hexes[castle];
      const c = this.ctx.centre;
      put('castle', { kind: 'castle', geo: 'castle', make: makeCastle, x: h.x, y: ground(h.x, h.z), z: h.z, angle: Math.atan2(c.z - h.z, c.x - h.x), scale: SCALE, hex: castle });
    }
    // At the buildings: walls round cities, and seats and foundries beside them.
    const taken = new Map<number, Set<number>>();
    s.buildings.forEach((b, v) => {
      if (!b) return;
      const c = colors[b.owner];
      const vx = board.vertices[v];
      if (b.wall) {
        // A gatehouse wherever a road can leave the city (headings in the wall's own frame).
        const turn = this.buildingAngle(v);
        const gates = vx.edges.filter((e) => board.edges[e].land).map((e) => {
          const o = board.vertices[board.edges[e].a === v ? board.edges[e].b : board.edges[e].a];
          return Math.atan2(o.z - vx.z, o.x - vx.x) - turn;
        });
        const key = gates.map((g) => Math.round((((g % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * 100)).sort((p, q) => p - q).join(',');
        put(`wall:${v}`, { kind: 'wall', geo: `wall:${c}:${key}`, make: () => makeWall(c, gates), x: vx.x, y: ground(vx.x, vx.z), z: vx.z, angle: turn, scale: SCALE, owned: true });
      }
      // A seat goes in front (towards the camera's usual place), wardens to the side, a foundry
      // behind (its chimney rises over the city anyway).
      const r = b.wall ? BESIDE_WALLED : BESIDE;
      if (b.foundry) {
        // (Further out than the rest, clear of a wall's ring and its towers.)
        const p = this.claim(taken, v, 2, b.wall ? FOUNDRY_WALLED : r);
        const foot = this.footing(p.x, p.z, 0.13);
        put(`foundry:${v}`, { kind: 'foundry', geo: 'foundry', make: makeFoundry, x: p.x, y: foot.y, z: p.z, angle: p.angle + Math.PI / 2, scale: SCALE * 1.15, owned: true });
      }
      if (b.seat) {
        const p = this.claim(taken, v, 0, r);
        const track = b.seat;
        put(`seat:${v}`, { kind: 'seat', geo: `seat:${c}:${track}`, make: () => makeSeat(c, track), x: p.x, y: this.footing(p.x, p.z, 0.12).y, z: p.z, angle: p.angle, scale: SCALE * 1.4, owned: true });
      }
    });
    // Wardens: on their edges (Invasion), or beside the building at their corner.
    for (const w of s.wardens) {
      const c = colors[w.owner];
      const geo = `warden:${c}:${w.rank}:${w.mustered ? 1 : 0}`;
      const make = () => makeWarden(c, w.rank, w.mustered);
      let x: number, z: number, angle: number;
      const r = w.rank === 3 ? 0.1 : 0.085;
      if (w.edge !== null) {
        // Beside the road, on the landward side, facing out to sea (or across the edge, inland):
        // along the edge or further in, wherever the ground is dry and flat enough for a post.
        const f = edgeFrame(board, w.edge);
        const land = board.edges[w.edge].hexes.map((h) => board.hexes[h]).filter((h) => isLand(h.terrain));
        const sea = board.edges[w.edge].hexes.map((h) => board.hexes[h]).find((h) => !isLand(h.terrain));
        const toward = land[0] ?? board.hexes[board.edges[w.edge].hexes[0]];
        const d = Math.hypot(toward.x - f.x, toward.z - f.z) || 1;
        const ux = (toward.x - f.x) / d, uz = (toward.z - f.z) / d;
        const ax = Math.cos(f.angle), az = Math.sin(f.angle);
        const spots: { x: number; z: number }[] = [];
        for (const out of [0.14, 0.2, 0.27, 0.34, 0.42]) for (const along of [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4]) spots.push({ x: f.x + ux * out + ax * along, z: f.z + uz * out + az * along });
        // (The lanes beside an edge are a post's place: only the water and the slope count here.)
        ({ x, z } = this.pick(spots, r, false));
        angle = sea ? Math.atan2(sea.z - f.z, sea.x - f.x) : Math.atan2(f.z - toward.z, f.x - toward.x);
      } else if (w.vertex !== null) {
        const b = s.buildings[w.vertex];
        const p = this.claim(taken, w.vertex, 1, b?.wall ? BESIDE_WALLED : b ? BESIDE : 0.12);
        ({ x, z } = this.settle(p.x, p.z, r, 0.1, false));
        angle = p.angle;
      } else continue;
      const foot = this.footing(x, z, r * 0.7);
      this.taken.push({ x, z, r });
      put(`warden:${w.id}`, { kind: 'warden', geo, make, x, y: foot.y, z, angle, scale: FIGURE, owned: true, owner: w.owner, lean: foot.lean });
    }
    // The caravans' wagons, facing the way their train runs (a merchantman where the edge is at sea).
    for (const t of s.ext.caravans?.trains ?? []) {
      let from = t.origin;
      for (const e of t.edges) {
        const edge = board.edges[e];
        const to = edge.a === from ? edge.b : edge.a;
        const a = board.vertices[from], b = board.vertices[to];
        const angle = Math.atan2(b.z - a.z, b.x - a.x);
        if (!edge.land) {
          hulls.push({
            key: `wagon:${e}`,
            place: (held) => {
              const at = this.atSea(e, 0.23, 0.085, angle, held);
              put(`wagon:${e}`, { kind: 'merchant', geo: 'merchant', make: makeMerchant, x: at.x, y: this.afloatY(at.x, at.z), z: at.z, angle: at.angle, scale: SCALE * 1.2 * at.fit, afloat: true, owned: true, swell: this.openness(at.x, at.z) });
            },
          });
        } else {
          const f = edgeFrame(board, e);
          // On top of whatever route is there: a road's cobbles, or a bridge's deck.
          const r = s.routes[e];
          const lift = r?.kind === 'road' ? 0.03 : r?.kind === 'bridge' ? 0.064 : 0;
          put(`wagon:${e}`, { kind: 'wagon', geo: 'wagon', make: makeWagon, x: f.x, y: ground(f.x, f.z) + lift, z: f.z, angle, scale: SCALE * 1.35, owned: true });
        }
        from = to;
      }
    }
    // (Shown first, at their berths if they still fit; then the newcomers, in the order they came.)
    const held = hulls.map((h) => {
      const at = this.heldAt(h.key);
      return at && (!h.keeps || h.keeps(at)) ? at : undefined;
    });
    hulls.forEach((h, i) => held[i] && h.place(held[i]));
    hulls.forEach((h, i) => held[i] || h.place());
    return out;
  }

  /**
   * The island shows another board (a hex found in the fog came up as land): where every piece
   * stands is worked out again on it, and those it moves glide there, as a ship on an edge that's
   * just become coast goes out past the new cliffs. (The rings round hexes are sorted by the
   * ground's height, which the new land changed, so they go too.)
   */
  setBoard(board: Board) {
    if (board === this.board) return;
    this.board = board;
    this.sites.clear();
    this.course = null;
    this.landHexes = null;
    if (this.last) void this.place(this.last, 'soft');
  }

  /**
   * The raider fleet's course: in from the north-north-west, from a start inside the home view's
   * frame to a landing just off the first coast on the way to the island's middle, in FLEET_STEPS
   * equal steps (`at(k)`: the point after k of them). Worked out once per board.
   */
  private course: { at: (k: number) => { x: number; z: number }; ux: number; uz: number; bearing: number; step: number } | null = null;
  private fleetCourse() {
    if (this.course) return this.course;
    const c = this.ctx.centre;
    const land = this.board.hexes.filter((h) => isLand(h.terrain));
    let reach = 0;
    for (const h of land) reach = Math.max(reach, Math.hypot(h.x - c.x, h.z - c.z));
    // (Pointing out along the bearing the fleet comes in on.)
    const bearing = -Math.PI / 2 - 0.35;
    const ux = Math.cos(bearing), uz = Math.sin(bearing);
    const start = reach + 2.9;
    // In from the start until a ship's length off the nearest land.
    let end = start;
    const near = (x: number, z: number) => land.reduce((m, h) => Math.min(m, Math.hypot(h.x - x, h.z - z)), Infinity);
    while (end > 0 && near(c.x + ux * end, c.z + uz * end) > 1.6) end -= 0.04;
    const step = (start - end) / FLEET_STEPS;
    this.course = { at: (k) => ({ x: c.x + ux * (start - step * k), z: c.z + uz * (start - step * k) }), ux, uz, bearing, step };
    return this.course;
  }

  /**
   * Where the fleet's longship i lies after `position` steps: the leader's bow at the step's
   * buoy, the other two abreast a little astern of it, all heading in.
   */
  private fleetSpot(position: number, i: number) {
    const course = this.fleetCourse();
    const p = course.at(Math.min(Math.max(position, 0), FLEET_STEPS));
    const half = 0.13 * LONGSHIP;
    const back = half + (i === 0 ? 0 : 0.55), side = i === 0 ? 0 : i === 1 ? -0.66 : 0.66;
    const { ux, uz } = course;
    return { x: p.x + ux * back - uz * side, z: p.z + uz * back + ux * side, angle: course.bearing + Math.PI + (i - 1) * 0.06 };
  }

  /** Where the fleet's leader is (for a camera to look at). */
  fleetFocus(s: GameState) {
    return s.ext.fleet ? this.fleetSpot(s.ext.fleet.position, 0) : null;
  }

  // ------------------------------------------------------------------ keeping up with the state

  /**
   * Bring the pieces up to date with `s`: at once (`none`), gently (`soft`: pieces appear and go,
   * and moves glide), or staged (`stage`: ships sail, wardens march, raiders come ashore, wagons
   * roll in). Resolves when what it started has finished.
   */
  sync(s: GameState, mode: MarksMode = 'soft'): Promise<void> {
    // (A new game's pieces were held for the island's rise too, and have no reveal of their own.)
    if (this.held) void this.reveal();
    return this.place(s, mode);
  }

  private place(s: GameState, mode: MarksMode): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.last = s;
    this.obstacleCount = this.ctx.obstacles().length;
    const want = this.desired(s);
    // Held back until the island has risen: anything new now simply appears with the rest.
    if (this.held) mode = 'none';
    // A ship gone from one edge and one of the same owner's new on another: it sailed there.
    const left = [...this.pieces.values()].filter((p) => p.kind === 'ship' && !p.gone && !want.has(p.key));
    for (const [key, spec] of want) {
      if (spec.kind !== 'ship' || this.pieces.has(key)) continue;
      let best = -1, bd = Infinity;
      left.forEach((p, i) => {
        const d = Math.hypot(p.x - spec.x, p.z - spec.z);
        if (p.owner === spec.owner && d < bd) [best, bd] = [i, d];
      });
      if (best < 0) continue;
      const p = left.splice(best, 1)[0];
      this.pieces.delete(p.key);
      p.key = key;
      this.pieces.set(key, p);
    }
    const waits: Promise<void>[] = [];
    for (const p of [...this.pieces.values()]) if (!want.has(p.key)) waits.push(this.leave(p, mode));
    let order = 0;
    for (const [key, spec] of want) {
      const p = this.pieces.get(key);
      if (p && !p.gone) waits.push(this.change(p, spec, mode));
      else {
        // (One still on its way out is let go at once, and a new one comes.)
        if (p) this.remove(p);
        waits.push(this.arrive(key, spec, mode, order++));
      }
    }
    return Promise.all(waits).then(() => {});
  }

  /** A tween on a piece, replacing any it had. */
  private tween(p: Piece, opts: { duration: number; delay?: number; easing?: (t: number) => number; update: (t: number) => void; done?: () => void }) {
    if (p.tween) this.anim.cancel(p.tween);
    const t = this.anim.tween({ easing: ease.linear, ...opts });
    p.tween = t.id;
    return t.promise;
  }

  private arrive(key: string, spec: Spec, mode: MarksMode, order: number): Promise<void> {
    const obj = new THREE.Object3D();
    obj.position.set(spec.x, spec.y, spec.z);
    obj.rotation.y = -spec.angle;
    obj.scale.setScalar(spec.scale);
    this.group.add(obj);
    const p: Piece = { ...spec, key, obj, id: this.instance(spec.geo, spec.make), pop: 1, phase: Math.random() * Math.PI * 2, tween: 0, gone: false, lamp: null, smoke: Math.random(), wake: 0, lx: spec.x, lz: spec.z, m: null };
    this.pieces.set(key, p);
    this.light(p);
    const room = CLEARS[spec.kind];
    if (room) this.ctx.clear(spec.x, spec.z, room);
    if (mode === 'none') return Promise.resolve();
    p.pop = 0;
    const soft = mode === 'soft';
    const from = this.v.set(spec.x, spec.y, spec.z).clone();
    let duration = 0.5, delay = 0;
    if (!soft && spec.kind === 'ship') {
      // Launched: from under the coast out to its place on the water.
      const e = Number(key.split(':')[1]);
      const f = edgeFrame(this.board, e);
      from.set(f.x * 0.6 + spec.x * 0.4, spec.y + 0.03, f.z * 0.6 + spec.z * 0.4);
      duration = 1.2;
    } else if (!soft && spec.kind === 'raider' && spec.hex !== undefined) {
      // Coming ashore: running in from the coast side of the ring.
      const h = this.board.hexes[spec.hex];
      const d = Math.hypot(spec.x - h.x, spec.z - h.z) || 1;
      from.set(spec.x + ((spec.x - h.x) / d) * 0.42, spec.y, spec.z + ((spec.z - h.z) / d) * 0.42);
      duration = 0.9;
      delay = Number(key.split(':')[2]) * 0.18;
    } else if (!soft && spec.kind === 'wagon') {
      from.set(spec.x - Math.cos(spec.angle) * 0.28, spec.y, spec.z - Math.sin(spec.angle) * 0.28);
      duration = 0.9;
    } else if (spec.kind === 'bridge') {
      from.y -= 0.14;
      duration = 0.8;
    } else if (spec.kind === 'cracked') {
      // The road splits with a puff of dust where the crack runs across it.
      this.dust(spec);
      duration = 0.35;
    } else delay = soft ? 0 : Math.min(order, 6) * 0.06;
    const to = new THREE.Vector3(spec.x, spec.y, spec.z);
    const hop = spec.kind === 'raider' || spec.kind === 'wagon';
    return this.tween(p, {
      duration,
      delay,
      update: (t) => {
        const u = ease.outCubic(t);
        p.pop = Math.min(1, spec.kind === 'ship' || hop ? t * 3 : ease.outBack(t));
        p.obj.position.lerpVectors(from, to, u);
        if (hop) p.obj.position.y += Math.abs(Math.sin(t * Math.PI * 4)) * 0.012 * (1 - t);
      },
      done: () => {
        p.pop = 1;
        p.obj.position.copy(to);
      },
    });
  }

  private leave(p: Piece, mode: MarksMode): Promise<void> {
    if (p.gone) return Promise.resolve();
    p.gone = true;
    const remove = () => this.remove(p);
    if (mode === 'none') {
      remove();
      return Promise.resolve();
    }
    const y0 = p.obj.position.y;
    return this.tween(p, {
      duration: p.afloat ? 0.9 : 0.4,
      easing: ease.inQuad,
      update: (t) => {
        p.pop = 1 - t;
        // (A ship goes down by the bow: lower in the water as it shrinks.)
        if (p.afloat) p.obj.position.y = y0 - t * 0.06;
      },
      done: remove,
    });
  }

  /** Take a piece off the board now. */
  private remove(p: Piece) {
    if (p.tween) this.anim.cancel(p.tween);
    p.tween = 0;
    if (p.id >= 0) this.batch?.deleteInstance(p.id);
    p.id = -1;
    p.lamp?.light.removeFromParent();
    p.lamp = null;
    p.obj.removeFromParent();
    if (this.pieces.get(p.key) === p) this.pieces.delete(p.key);
  }

  /** A piece still on the board: changed (a warden promoted, mustered or stood down), moved, or both. */
  private change(p: Piece, spec: Spec, mode: MarksMode): Promise<void> {
    const waits: Promise<void>[] = [];
    if (spec.geo !== p.geo) {
      // (Swapping the model under the same instance, rather than a new one, keeps its pose.)
      this.batch!.setGeometryIdAt(p.id, this.geoId(spec.geo, spec.make));
      p.geo = spec.geo;
      p.make = spec.make;
      this.light(p);
      if (mode !== 'none') p.pop = 0.4;
    }
    const moved = Math.hypot(spec.x - p.x, spec.z - p.z) > 1e-3 || Math.abs(spec.y - p.y) > 1e-3 || Math.abs(angleDiff(spec.angle, p.angle)) > 1e-3;
    const from = { x: p.obj.position.x, y: p.obj.position.y, z: p.obj.position.z, a: -p.obj.rotation.y };
    Object.assign(p, { x: spec.x, y: spec.y, z: spec.z, angle: spec.angle, scale: spec.scale, owner: spec.owner, hex: spec.hex, lean: spec.lean, swell: spec.swell });
    const scale0 = p.obj.scale.x;
    if (mode === 'none' || (!moved && p.pop >= 1 && Math.abs(scale0 - spec.scale) < 1e-4)) {
      if (p.tween && mode === 'none') this.anim.cancel(p.tween);
      p.pop = 1;
      p.obj.position.set(spec.x, spec.y, spec.z);
      p.obj.rotation.y = -spec.angle;
      p.obj.scale.setScalar(spec.scale);
      return Promise.resolve();
    }
    const dist = Math.hypot(spec.x - from.x, spec.z - from.z);
    const travel = Math.atan2(spec.z - from.z, spec.x - from.x);
    const sails = p.kind === 'ship' || p.kind === 'corsair' || p.kind === 'longship' || p.kind === 'merchant';
    const marches = p.kind === 'warden' || p.kind === 'raider';
    const duration = mode === 'soft' ? 0.6 : p.kind === 'longship' ? 2.6 : p.kind === 'corsair' ? 1.8 : sails ? 1.4 : marches ? 0.4 + dist * 0.9 : 0.6;
    const pop0 = p.pop;
    const turns = dist > 0.05 && (sails || marches);
    waits.push(
      this.tween(p, {
        duration,
        update: (t) => {
          const u = ease.inOutCubic(t);
          p.pop = pop0 + (1 - pop0) * Math.min(1, t * 2);
          p.obj.position.set(from.x + (spec.x - from.x) * u, from.y + (spec.y - from.y) * u, from.z + (spec.z - from.z) * u);
          // (A hull made smaller to fit a crowded strait, or let grow again, changes size on the way.)
          p.obj.scale.setScalar(scale0 + (spec.scale - scale0) * u);
          // A march is a run of little steps; a sailing piece heels into its turn.
          if (marches && dist > 0.05) p.obj.position.y += Math.abs(Math.sin(t * Math.PI * Math.max(2, Math.round(dist * 10)))) * 0.01;
          let a = from.a + angleDiff(spec.angle, from.a) * u;
          if (turns) {
            // Turning to the way it's going, going, then turning to rest as it should.
            const into = THREE.MathUtils.smoothstep(t, 0, 0.22), out = THREE.MathUtils.smoothstep(t, 0.72, 1);
            const head = from.a + angleDiff(travel, from.a) * into;
            a = head + angleDiff(spec.angle, head) * out;
          }
          p.obj.rotation.y = -a;
        },
        done: () => {
          p.pop = 1;
          p.obj.position.set(spec.x, spec.y, spec.z);
          p.obj.rotation.y = -spec.angle;
          p.obj.scale.setScalar(spec.scale);
        },
      }),
    );
    return Promise.all(waits).then(() => {});
  }

  /** The light a piece casts at night: a foundry's furnace, the castle's forge, a camp's fire, a post's brazier or campfire, the trader's lantern. */
  private light(p: Piece) {
    p.lamp?.light.removeFromParent();
    p.lamp = null;
    // (Each fire also asks for a pool of its light on the ground, for where lamps cast none: see
    // groundGlow.ts.) A furnace's and a forge's reach is short and their daylight floor low, so by
    // day they warm only the ground at their mouths, as the hills' kilns do, and stand beside a
    // city's walls without flooding them; at dusk they come up with every other light.
    if (p.kind === 'foundry') p.lamp = this.ctx.lamps.add(p.obj, { x: FOUNDRY_FIRE.x, y: FOUNDRY_FIRE.y, z: FOUNDRY_FIRE.z + 0.012 }, { color: FURNACE, distance: 0.45, strength: 1.0, day: 0.08, flicker: 0.16, pool: 0.3 });
    else if (p.kind === 'castle') p.lamp = this.ctx.lamps.add(p.obj, CASTLE_FORGE, { color: FURNACE, distance: 0.32, strength: 0.75, day: 0.06, flicker: 0.2, pool: 0.18 });
    else if (p.kind === 'camp') p.lamp = this.ctx.lamps.add(p.obj, CAMP_FIRE, { color: FIRE, distance: 0.55, strength: 0.9, day: 0.2, flicker: 0.22, pool: 0.24 });
    else if (p.kind === 'warden') p.lamp = this.ctx.lamps.add(p.obj, this.fireOf(p), { color: FIRE, distance: 0.42, strength: 0.65, day: 0.12, flicker: 0.22, pool: 0.18 });
    else if (p.kind === 'trader') p.lamp = this.ctx.lamps.add(p.obj, TRADER_LAMP, { color: CAMP, distance: 0.32, strength: 0.5, day: 0, flicker: 0.05, pool: 0.12 });
  }

  /** Where a post's fire is: the brazier of a mustered warden, the campfire of one at rest (model units). */
  private fireOf(p: Piece) {
    return p.geo.endsWith(':0') ? POST_FIRE.resting : POST_FIRE.mustered;
  }

  // ------------------------------------------------------------------ each frame

  update(dt: number, t: number) {
    this.anim.speed = this.ctx.speed();
    this.anim.tick(dt);
    // Harbours are built once the island is up, after a loaded game's pieces are placed: ships
    // moored where a pier now stands move off it.
    this.recheck -= dt;
    if (this.recheck <= 0 && this.last && !this.stopped) {
      this.recheck = 0.5;
      if (this.ctx.obstacles().length !== this.obstacleCount) void this.place(this.last, 'soft');
    }
    const batch = this.batch;
    if (!batch) return;
    for (const p of this.pieces.values()) {
      const o = p.obj;
      const shown = o.visible && !(this.held && p.owned) && p.pop > 0.002 && o.scale.x > 1e-4;
      batch.setVisibleAt(p.id, shown);
      if (p.lamp) p.lamp.gain = shown ? Math.min(1, p.pop) : 0;
      if (!shown) continue;
      let y = o.position.y + (p.hex !== undefined ? this.ctx.rise(p.hex) : 0);
      this.e.set(0, o.rotation.y, 0);
      if (p.afloat) {
        // Riding the swell: a slow bob (more out in open water), a roll and a pitch, and a little
        // yaw on the anchor; and up with the sea when a flood's surge lifts it.
        const k = SCALE / p.scale;
        y += Math.sin(t * 1.3 + p.phase) * (0.002 + 0.004 * (p.swell ?? 1)) + (this.ctx.lift?.(o.position.x, o.position.z) ?? 0);
        this.e.x = Math.sin(t * 1.1 + p.phase) * 0.05 * k;
        this.e.z = Math.sin(t * 0.9 + p.phase * 1.3) * 0.028 * k;
        this.e.y += Math.sin(t * 0.3 + p.phase) * 0.03;
      }
      this.q.setFromEuler(this.e);
      if (p.afloat && SAILS.has(p.kind)) {
        // Heeled away from the wind (the scene's one wind, env/wind.ts), as far as it's on the
        // beam and as hard as it blows: a flat sea and an upright hull in a calm, well over in a storm.
        const a = -o.rotation.y;
        const beam = WIND.y * Math.cos(a) - WIND.x * Math.sin(a);
        const heel = 0.075 * Math.max(0, windStrength.value - 0.5) * beam;
        this.q.multiply(this.heel.setFromAxisAngle(X_AXIS, heel));
      }
      if (p.lean) {
        // Leaning with the hillside: turned about the level line across the slope, uphill side up.
        const [lx, lz] = p.lean;
        const a = Math.hypot(lx, lz);
        this.lean.setFromAxisAngle(this.axis.set(-lz / a, 0, lx / a), a);
        this.q.premultiply(this.lean);
      }
      this.s.copy(o.scale).multiplyScalar(Math.max(1e-4, p.pop));
      const m = this.tmp.compose(this.v.set(o.position.x, y, o.position.z), this.q, this.s);
      if (!p.m?.equals(m)) batch.setMatrixAt(p.id, (p.m ??= new THREE.Matrix4()).copy(m));
      if (!this.stopped && p.pop >= 1) this.breathe(p, dt, y);
    }
    this.wakes(dt);
    this.storm();
  }

  /** What a hull's wake is shaped by (half-length and half-beam in model units, the beam taking in a bank of oars). */
  private static HULLS: Partial<Record<Kind, [number, number]>> = { ship: [0.105, 0.03], merchant: [0.095, 0.035], corsair: [0.15, 0.05], longship: [0.13, 0.05] };

  /**
   * The hulls under way leave wakes on the sea (see seaWakes in env/ocean.ts): the fleet always
   * (it is rowing in, its clock running), any other hull while it sails, its wake easing in and
   * out with its speed. The strongest take the sea's few slots.
   */
  /** The hulls leaving wakes this frame (kept between frames: wakes runs every frame). */
  private lit: Piece[] = [];
  private byWake = (a: Piece, b: Piece) => b.wake * b.pop - a.wake * a.pop;

  private wakes(dt: number) {
    const lit = this.lit;
    lit.length = 0;
    for (const p of this.pieces.values()) {
      const hull = ModuleMarks.HULLS[p.kind];
      if (!hull) continue;
      const o = p.obj;
      const speed = dt > 0 ? Math.hypot(o.position.x - p.lx, o.position.z - p.lz) / dt : 0;
      p.lx = o.position.x;
      p.lz = o.position.z;
      const want = p.gone || !o.visible || (this.held && p.owned) ? 0 : p.kind === 'longship' ? 1 : Math.min(1, speed / 0.35);
      p.wake += (want - p.wake) * Math.min(1, dt * (want > p.wake ? 3 : 0.8));
      if (p.wake * p.pop > 0.02) lit.push(p);
    }
    if (lit.length > 1) lit.sort(this.byWake);
    seaWakesOn.value = lit.length ? 1 : 0;
    for (let i = 0; i < WAKE_SLOTS; i++) {
      const p = lit[i];
      const w = seaWakes.array[i] as THREE.Vector4, shape = seaWakeShape.array[i] as THREE.Vector4;
      if (!p) {
        shape.x = 0;
        continue;
      }
      const [half, beam] = ModuleMarks.HULLS[p.kind]!;
      const a = -p.obj.rotation.y, sc = p.obj.scale.x * Math.min(1, p.pop);
      w.set(p.obj.position.x, p.obj.position.z, Math.cos(a), Math.sin(a));
      shape.set(Math.min(1, p.wake * p.pop) * (p.kind === 'longship' ? 0.65 : 0.6), half * sc, beam * sc, 0);
    }
  }

  /**
   * A squall rides with the raider fleet: a dark mass in the cloud field over it (see clouds.ts),
   * its shadow on the sea growing wider and heavier with every step the fleet comes closer.
   */
  private storm() {
    const v = squall.value as THREE.Vector4;
    const fleet = this.last?.ext.fleet;
    // (Its three longships' middle and how far they've come in, without making arrays each frame.)
    let x = 0, z = 0, n = 0, pop = 1;
    if (fleet && !this.stopped)
      for (let i = 0; i < 3; i++) {
        const p = this.pieces.get(`fleet:${i}`);
        if (!p || p.gone) continue;
        x += p.obj.position.x;
        z += p.obj.position.z;
        pop = Math.min(pop, p.pop);
        n++;
      }
    if (!fleet || n === 0) {
      v.w = 0;
      return;
    }
    x /= n;
    z /= n;
    // (Somewhat ahead of the fleet, the weather it brings with it.)
    const c = this.fleetCourse();
    x -= c.ux * 0.5;
    z -= c.uz * 0.5;
    const t = Math.min(1, Math.max(0, fleet.position / (FLEET_STEPS - 1)));
    // Where the sun's ray through that point of the sea meets the cloud layer, as the field is drawn (clouds.ts layerPoint).
    const sun = cloudSunDir.value as THREE.Vector3;
    const sl = sun.length() || 1;
    const k = (LAYER_HEIGHT - AFLOAT) / Math.max(0.15, sun.y / sl) / sl;
    const drift = cloudDrift.value as THREE.Vector2;
    v.set(x + sun.x * k + drift.x, z + sun.z * k + drift.y, 1.7 + 1.9 * t, (0.75 + 0.25 * t) * Math.min(1, pop));
  }

  /** A puff of dust along a road as it cracks (in its frame: the split runs across it at CRACK_X, see makeCrack). */
  private dust(spec: Spec) {
    const ax = Math.cos(spec.angle), az = Math.sin(spec.angle);
    for (let i = 0; i < 14; i++) {
      const across = (Math.random() - 0.5) * 0.11, along = CRACK_X + (Math.random() - 0.5) * 0.03;
      this.ctx.smoke.emit({
        x: spec.x + ax * along - az * across,
        y: spec.y + 0.03,
        z: spec.z + az * along + ax * across,
        vx: (Math.random() - 0.5) * 0.08,
        vy: 0.05 + Math.random() * 0.06,
        vz: (Math.random() - 0.5) * 0.08,
        life: 1.2 + Math.random() * 0.8,
        size: 0.02,
        grow: 3,
        color: '#b8ab94',
        alpha: 0.4,
        drag: 1.2,
        fadeIn: 0.05,
      });
    }
  }

  /** Smoke from a foundry's stack, and a thin wisp from a camp's fire, a post's or the castle's forge. */
  private breathe(p: Piece, dt: number, y: number) {
    if (p.kind !== 'foundry' && p.kind !== 'camp' && p.kind !== 'warden' && p.kind !== 'castle') return;
    p.smoke -= dt;
    if (p.smoke > 0) return;
    const foundry = p.kind === 'foundry';
    p.smoke = foundry ? 0.22 + Math.random() * 0.15 : p.kind === 'camp' || p.kind === 'castle' ? 0.5 + Math.random() * 0.4 : 1.4 + Math.random();
    const at = foundry ? FOUNDRY_SMOKE : p.kind === 'castle' ? CASTLE_SMOKE : p.kind === 'camp' ? this.v.copy(CAMP_FIRE).setY(0.02) : this.v.copy(this.fireOf(p)).setY(this.fireOf(p).y + 0.008);
    const w = at.clone().multiply(p.obj.scale).applyAxisAngle(UP, p.obj.rotation.y);
    this.ctx.smoke.emit({
      x: p.obj.position.x + w.x,
      y: y + w.y,
      z: p.obj.position.z + w.z,
      vx: (Math.random() - 0.5) * 0.02,
      vy: foundry ? 0.16 + Math.random() * 0.05 : 0.07 + Math.random() * 0.03,
      vz: (Math.random() - 0.5) * 0.02,
      life: foundry ? 3.6 + Math.random() : 2.4 + Math.random(),
      size: foundry ? 0.03 : 0.016,
      grow: foundry ? 5.5 : 4,
      color: foundry ? '#5a5552' : '#cfc9c2',
      alpha: foundry ? 0.42 : 0.26,
      drag: 0.2,
      fadeIn: 0.15,
    });
  }

  // ------------------------------------------------------------------ the board's own moments

  /** Players' pieces wait out of sight while the island rises (the castle, the raiders and the fleet don't). */
  hide() {
    this.held = true;
  }

  /** The island is up: the players' pieces appear, one after another. */
  reveal(): Promise<void> {
    if (!this.held) return Promise.resolve();
    this.held = false;
    let i = 0;
    const waits: Promise<void>[] = [];
    for (const p of this.pieces.values()) {
      if (!p.owned || p.gone) continue;
      p.pop = 0;
      waits.push(this.tween(p, { duration: 0.5, delay: i++ * 0.05, update: (t) => (p.pop = ease.outBack(t)), done: () => (p.pop = 1) }));
    }
    return Promise.all(waits).then(() => {});
  }

  /** The island is going under: nothing more starts, and what's moving stops where it is. */
  stop() {
    this.stopped = true;
    for (const p of this.pieces.values()) if (p.tween) this.anim.cancel(p.tween);
  }

  dispose() {
    this.stop();
    // (The sea and the sky forget the fleet and the hulls with the board.)
    for (let i = 0; i < WAKE_SLOTS; i++) (seaWakeShape.array[i] as THREE.Vector4).x = 0;
    seaWakesOn.value = 0;
    (squall.value as THREE.Vector4).w = 0;
    for (const p of this.pieces.values()) {
      p.lamp?.light.removeFromParent();
      p.obj.removeFromParent();
    }
    this.pieces.clear();
    this.batch?.dispose();
    this.batch = null;
    for (const g of this.geos.values()) g.geo.dispose();
    this.geos.clear();
    this.group.clear();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** The shortest signed turn from b to a. */
function angleDiff(a: number, b: number) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

