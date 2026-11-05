// Game-state presentation on the 3D board: number discs, player pieces, robber,
// harbours, legal-placement markers, hover ghosts and placement animations.

import * as THREE from 'three/webgpu';
import { keepNormals } from '../util/mrt';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { vec3, vec4, uniform, sin, time, float, attribute, mix } from 'three/tsl';
import { hexBlocked, isLand, longestRoadEdges, numbersOf, type Board, type GameState, type PlayerColor, type PlayerId } from '../../engine';
import { barren, landHexes, lookOf } from './looks';
import type { ModuleMarks, MarksMode } from './marks';
import type { World } from '../World';
import { TokenFactory, type DiscCluster } from './tokens';
import type { Grounds } from './grounds';
import { seaLiftOf } from './seaLift';
import { Harbours, RESOURCE_COLORS } from './ports';
import { StandInBatch } from './standInBatch';
import { Travellers } from './travellers';
import { Crows } from './crows';
import { fogNumber, shownBoard } from './fogBoard';
import { release } from './release';
import { makeHeadland, makeHeadlandRocks, type HeadlandSpec } from './headland';
import { FLAG_OFFSET, PLAYER_PALETTE, ROAD_LENGTH, makeScaffold, piecesNight, makeCity, makeFlag, makePennant, makeRoad, makeRobber, makeSettlement, cobbleColors, flagMaterial, pieceMaterial, roadMaterial, robberMaterial } from './pieces';
import { DETAIL_LAYER, GROUND_DISC_Y, MARKS_SCALE, SEA_LEVEL, TOKEN_CLEAR, TOKEN_Y, edgeFrame, roadFrame } from './layout';
import { Animator, ease } from '../util/tween';
import { waterBurst, type ParticleSystem } from '../fx/particles';
import type { ContactMap } from './contact';
import type { Site } from './decor';
import { sfx } from '../../audio/sfx';
import { WIND_ANGLE } from '../env/wind';
import { WINDOW_LIGHT, lampColor } from '../fx/lamps';
import { instancedMesh } from './instancing';

const WINDOW = lampColor(...WINDOW_LIGHT);


/**
 * Turn a city's flag (if `obj` has one) to fly downwind, whichever way the city faces: the scene
 * has one wind (env/wind.ts), and every flag, pennant and smoke plume on the island goes with it.
 */
function windward(obj: THREE.Object3D) {
  for (const c of obj.children) if (c.userData.flag) c.rotation.y = -WIND_ANGLE - obj.rotation.y;
}

/** A road run on to a corner it shares with another of its seat's (see BoardView.joinRoads), in the road's own frame. */
interface RoadJoin {
  /** Its middle along the edge and its length as a share of ROAD_LENGTH. */
  cx: number;
  sx: number;
  /** Raised by this much to clear the ground at the corner. */
  dy: number;
  /** The cuts at its ends (roadMaterial's aMitre), in the geometry's units. */
  mitre: [number, number, number, number];
  /** How far its joined ends have sunk their bollards, 0..1 (1 once they are all the way joined). */
  sink: number;
}

/** How one end of a road stands: where it stops along its edge, its cuts either side, how far it is raised, and how joined it is (0..1). */
interface JoinShape {
  t: number;
  k0: number;
  k1: number;
  dy: number;
  amt: number;
}

/**
 * One end of a road as it joins (or parts from) the next at a corner: it eases from the shape it
 * stood in (`a`) to the one it is to have (`b`), by `q`, so a join grows and a parting shrinks
 * rather than coming in a frame. Driven by a road being paved to the corner (`drv`) or, failing
 * that, by a short tween of its own (the road's `joining`).
 */
interface JoinEnd {
  /** Where it stops short of the corner, unjoined (± half a road). */
  rest: number;
  a: JoinShape;
  b: JoinShape;
  q: number;
  /** The road being paved to this end's corner, and how far its ramp had got when this ease began. */
  drv: THREE.Object3D | null;
  r0: number;
  /** Bumped at each new target, so an older tween leaves it alone. */
  gen: number;
}

interface RoadJoinState {
  plus: JoinEnd;
  minus: JoinEnd;
  out: RoadJoin;
}

const joinShape = (t: number): JoinShape => ({ t, k0: 0, k1: 0, dy: 0, amt: 0 });
const joinEnd = (rest: number): JoinEnd => ({ rest, a: joinShape(rest), b: joinShape(rest), q: 1, drv: null, r0: 0, gen: 0 });
/** a to b by q (exactly b once q reaches 1). */
const lerpTo = (a: number, b: number, q: number) => (q >= 1 ? b : a + (b - a) * q);
/** Seconds a join takes to form once its corner is reached (as a road is paved to it its own pace sets it: see paveRamp), and to part again. */
const JOIN_IN = 0.3;
const JOIN_OUT = 0.4;
/** A road being paved reaches its far corner over this last share of its length: the joins there form over it. */
const PAVE_JOIN = 0.38;
/** A bridge rises for about this long before the roads run on to it. */
const BRIDGE_JOIN_DELAY = 0.45;
/** A house taken back is gone this long before the roads run on across its corner. */
const HOUSE_JOIN_DELAY = 0.3;

/** How far the joins at the far corner of a road being paved have got, 0..1, eased in over the end of its pave. */
function paveRamp(pave: number | undefined): number {
  if (pave === undefined || pave >= 1) return 1;
  const x = (pave - (1 - PAVE_JOIN)) / PAVE_JOIN;
  return x <= 0 ? 0 : x * x * (3 - 2 * x);
}

/** Roads one seat can have on the board at once (15 to build, and one lifting away as another drops). */
const ROAD_SLOTS = 20;

/** Pieces are modelled at miniature scale and enlarged for readability on the board. */
export const PIECE_SCALE = 1.85;
const ROBBER_SCALE = 1.55;
/** Pennants stand a little larger than the pieces, to read along a route from the overview. */
const PENNANT_SCALE = 2.3;

interface PieceRec {
  obj: THREE.Object3D;
  owner: PlayerId;
  kind: 'settlement' | 'city' | 'road';
  /** Down on the ground (not still dropping into place), so it shades and wears it. */
  landed: boolean;
}

const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.03);

/** A piece's mark on the contact map: what it was (to notice a change), where, and how to make it. */
interface ContactSplat {
  sig: string;
  box: [number, number, number, number];
  splat: () => void;
}

/**
 * The view's own animations (pieces, robber, discs, effects). They run at the world's pace,
 * but apart from its other animations: leaving a game stops them where they are (cancelAll),
 * rather than finishing them, so nothing pops to full size as the island goes under. A
 * cancelled animation's promise still resolves; whatever follows it checks the view first.
 */
class TweenGroup extends Animator {
  private live = new Set<number>();

  tween(opts: Parameters<Animator['tween']>[0]) {
    const r = super.tween(opts);
    this.live.add(r.id);
    void r.promise.then(() => this.live.delete(r.id));
    return r;
  }

  /** Stop every animation where it is, without completing it. */
  cancelAll() {
    for (const id of [...this.live]) this.cancel(id);
    this.live.clear();
  }
}

/**
 * What every board view shares, made once for the session and kept between games: the pieces'
 * materials, the markers' and the robber's. Building these anew for
 * every board would have the renderer keep a little more each game, and compile their shaders again.
 */
interface ViewParts {
  markerTime: ReturnType<typeof uniform<'float'>>;
  pieceMat: THREE.MeshStandardNodeMaterial;
  roadMat: THREE.MeshStandardNodeMaterial;
  ghostMat: THREE.MeshStandardNodeMaterial;
  travellerMat: THREE.MeshStandardNodeMaterial;
  flagMat: THREE.MeshStandardNodeMaterial;
  robberGeo: THREE.BufferGeometry;
  robberMat: THREE.MeshStandardNodeMaterial;
  markerMat: THREE.MeshBasicNodeMaterial;
  ring: THREE.BufferGeometry;
  bar: THREE.BufferGeometry;
  /** The bar a hex's outline is drawn with (six to a hex, pulsing together). */
  hexBar: THREE.BufferGeometry;
  /** Piece geometry by kind, colour and seat (see BoardView.geo). */
  geos: Map<string, THREE.BufferGeometry>;
}

let parts: ViewParts | null = null;

/** Hexes a pick can outline at once (six bars each): the largest board has fewer than this. */
const HEX_MARKS = 64;
/** The length of one outline bar before it is scaled to its side: the capsule's body and both caps. */
const HEX_BAR = ROAD_LENGTH * 0.8 + 0.06;

function addPhase(g: THREE.BufferGeometry, n: number) {
  const ph = new Float32Array(n);
  for (let i = 0; i < n; i++) ph[i] = i * 0.7;
  g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
}

function viewParts(): ViewParts {
  if (parts) return parts;
  const markerTime = uniform(0);
  const ghostMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, roughness: 0.6 });
  ghostMat.opacityNode = sin(time.mul(5)).mul(0.1).add(0.78);
  ghostMat.emissiveNode = vec3(0.35, 0.28, 0.12).mul(sin(time.mul(5)).mul(0.5).add(1));
  keepNormals(ghostMat);
  // Placement markers (instanced, pulsing gold).
  const markerMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const pulse = sin(markerTime.mul(4).add(attribute<'float'>('aPhase', 'float'))).mul(0.5).add(0.5);
  markerMat.colorNode = vec4(mix(vec3(1.0, 0.78, 0.32), vec3(1.0, 0.95, 0.75), pulse), float(1));
  markerMat.opacityNode = pulse.mul(0.35).add(0.55);
  keepNormals(markerMat);
  const ring = new THREE.RingGeometry(0.11, 0.15, 48);
  ring.rotateX(-Math.PI / 2);
  addPhase(ring, 64);
  const bar = new THREE.CapsuleGeometry(0.03, ROAD_LENGTH * 0.8, 4, 12);
  bar.rotateZ(Math.PI / 2);
  addPhase(bar, 80);
  // A hex's outline is six of these, one to a side, and the six pulse as one.
  const hexBar = new THREE.CapsuleGeometry(0.03, ROAD_LENGTH * 0.8, 4, 12);
  hexBar.rotateZ(Math.PI / 2);
  const hexPhase = new Float32Array(HEX_MARKS * 6);
  for (let i = 0; i < hexPhase.length; i++) hexPhase[i] = Math.floor(i / 6) * 0.7;
  hexBar.setAttribute('aPhase', new THREE.InstancedBufferAttribute(hexPhase, 1));
  return (parts = {
    markerTime,
    pieceMat: pieceMaterial(piecesNight),
    roadMat: roadMaterial(piecesNight),
    ghostMat,
    // Travellers aren't game pieces: they keep to the scene's light when pieces are brightened.
    travellerMat: pieceMaterial(piecesNight, { bright: false }),
    flagMat: flagMaterial(piecesNight),
    robberGeo: makeRobber(),
    robberMat: robberMaterial(piecesNight),
    markerMat,
    ring,
    bar,
    hexBar,
    geos: new Map(),
  });
}

/** No bridges to walk (see bridgesShown). */
const NO_BRIDGES = new Map<number, PlayerId>();

export class BoardView {
  group = new THREE.Group();
  /**
   * What holds its shape between moves (the pieces and roads, the discs, the robber, the
   * harbours, the crows): drawn as a render bundle (see render/core/bundles.ts). The rest (the
   * travellers and the expansions' pieces, batched; the placement marks and the ghost, drawn in
   * an order of their own) are in `group` beside it.
   */
  private still = new THREE.Group();
  /**
   * The buildings' bodies, every one a stand-in drawn by one batched mesh (WebGPU: see
   * standInBatch.ts); null on WebGL2, where each is a mesh. Their flags and lamps hang on them.
   */
  private buildBatch: StandInBatch | null = null;
  /**
   * Set once the view is disposed. Every deferred step (a follow-up animation, a timer's
   * effect) checks it, or `cancelled`, before touching the board.
   */
  disposed = false;
  /** Everything on the island is going under with it (see sinkAll). */
  private sunk = false;
  private anim = new TweenGroup();
  private shown!: Board;
  /**
   * The board the island shows (face-down hexes as open water). A hex found in the fog replaces
   * it, and the expansions' pieces are told: a ship off a coast that has just come up moves out
   * past it (see ModuleMarks.setBoard).
   */
  get board(): Board {
    return this.shown;
  }
  set board(board: Board) {
    this.shown = board;
    this.marks?.setBoard(board);
  }
  private tokenFactory = new TokenFactory();
  /** Each numbered hex's discs (one, or a cluster: see TokenFactory.cluster). */
  tokens = new Map<number, DiscCluster>();
  /** The fishing grounds' rigs, fish and gulls (a game with modules: render/expansions.ts). */
  private grounds: Grounds | null = null;
  /** The numbers each hex bears now, where they differ from its printed ones (a resurvey, pollution). */
  private numbersNow = new Map<number, number[]>();
  private harbours: Harbours;
  private travellers: Travellers;
  private colors: PlayerColor[];
  private parts = viewParts();
  private pieceMat = this.parts.pieceMat;
  private roadMat = this.parts.roadMat;
  /**
   * Each seat's roads, one instanced draw for all of them (no shadow: they lie flat, and
   * kept out of the sea's mirror). A road on the board is a placeholder object standing where
   * it is drawn, so it moves, drops and sinks like the other pieces.
   */
  private roadMeshes: THREE.InstancedMesh[] = [];
  /** The expansions' pieces (a game with modules: render/expansions.ts). */
  private marks: ModuleMarks | null = null;
  private roadSlots = new Set<THREE.Object3D>();
  private ghostMat = this.parts.ghostMat;
  private travellerMat = this.parts.travellerMat;
  private geos = this.parts.geos;
  buildings = new Map<number, PieceRec>();
  roads = new Map<number, PieceRec>();
  robber: THREE.Mesh;
  /** The robber's hex, or -1 while it's off the board. */
  robberHex: number;
  private crowFlock = new Crows();
  /** A robber already away from the desert and the other barren looks (a resumed game) gets his crows once he is on show. */
  private crowsDue = false;
  dust: ParticleSystem;
  smoke: ParticleSystem;
  sparkle: ParticleSystem;
  // markers
  private vertexMarkers: THREE.InstancedMesh;
  private edgeMarkers: THREE.InstancedMesh;
  /** Outlines for an expansion's hex pick; null in a base game (see the constructor). */
  private hexMarkers: THREE.InstancedMesh | null = null;
  /** Whether any expansion module is in play (a base game builds none of their extras). */
  private readonly modular: boolean;
  private markerTime = this.parts.markerTime;
  private ghost: THREE.Mesh | null = null;
  private ghostKey = '';
  private unsub: () => void;

  constructor(
    private world: World,
    state: GameState,
  ) {
    // (Face-down hexes show as open water: see fog.ts.)
    this.board = shownBoard(state);
    this.colors = state.players.map((p) => p.color);
    // Piece geometry is kept for colours in play: any from an earlier game's other colours goes.
    for (const [key, g] of this.geos) {
      if (this.colors.includes(key.split(':')[1])) continue;
      g.dispose();
      this.geos.delete(key);
    }
    this.colors.forEach((c, seat) => {
      const m = instancedMesh(this.geo('road', c), this.roadMat, ROAD_SLOTS);
      m.count = 0;
      m.castShadow = false;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.layers.set(DETAIL_LAYER);
      m.userData.seat = seat;
      m.userData.cobble = cobbleColors(c);
      this.roadMeshes.push(m);
      this.still.add(m);
    });

    // Number discs at the centre of each producing hex: a cluster where it has several numbers.
    this.tokenFactory.attach(this.still, world.stage);
    for (const hex of this.board.hexes) {
      // (A hex found in the fog drew its number then, from the face-down discs.)
      const found = hex.numbers.length ? undefined : fogNumber(state, hex.id);
      const numbers = found === undefined ? hex.numbers : [found];
      if (!numbers.length) continue;
      if (found !== undefined) this.numbersNow.set(hex.id, numbers);
      const land = isLand(hex.terrain);
      const ground = (x: number, z: number) => (land ? world.tiles!.heightAt(hex.id, hex.x + x, hex.z + z) : 0);
      const g0 = ground(0, 0);
      const tok = this.tokenFactory.cluster(numbers, (x, z) => ground(x, z) - g0, hex.terrain);
      // (A fishing ground's discs ride its raft, on the water: see grounds.ts.)
      const y = land ? g0 + TOKEN_Y - 0.02 : GROUND_DISC_Y;
      tok.group.position.set(hex.x, y, hex.z);
      tok.group.rotation.y = 0;
      this.still.add(tok.group);
      this.tokens.set(hex.id, tok);
    }
    // A resumed game's discs show the numbers its hexes bear now (a resurvey's swaps, pollution's
    // losses), not the printed ones the first commit after the intro would otherwise correct.
    this.syncNumbers(state);
    // The fishing grounds' rafts, floats, fish and gulls.
    const ext = world.ext;
    if (ext) {
      this.grounds = new ext.Grounds(this.board, world.effects, world.particles.spray, (x, z, size, life) => world.wildlife?.addRipple(x, z, size, life), this.tokens, seaLiftOf(world));
      this.still.add(this.grounds.group);
    }

    this.harbours = new Harbours(this.board, (v) => this.headlandSpec(v));
    this.harbours.camera = world.stage.camera;
    // (Its boats are batched, out of the bundle that holds the harbours: see Harbours.attach.)
    this.harbours.attach(this.group, world.stage, !!(world.stage.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend);
    this.harbours.lift = seaLiftOf(world);
    if (state.longestRoadHolder !== null) this.longest = new Set(longestRoadEdges(state, state.longestRoadHolder).filter((e) => state.routes[e]?.kind === 'road'));
    this.travellers = new Travellers(
      this.board,
      this.colors,
      this.travellerMat,
      (x, z) => this.groundY(x, z),
      this.roads,
      this.buildings,
      (x, z, r, a) => this.world.effects.trail.stamp(x, z, r, a),
      this.world.lamps,
      // (A resumed game's bridges are crossed once they've appeared, not while they wait to pop in.)
      () => (this.bridgesShown ? this.bridges : NO_BRIDGES),
      MARKS_SCALE,
    );
    this.group.add(this.travellers.group);
    this.harbours.group.name = 'harbours';
    this.still.add(this.harbours.group);
    world.boardView = this;

    // Robber.
    this.robber = new THREE.Mesh(this.parts.robberGeo, this.parts.robberMat);
    this.robber.scale.setScalar(ROBBER_SCALE);
    this.robber.castShadow = true;
    this.robber.receiveShadow = true;
    this.robberHex = state.robberHex ?? -1;
    if (state.robberHex === null) this.robber.visible = false;
    else this.placeRobberAt(state.robberHex);
    this.still.add(this.robber);
    this.still.add(this.crowFlock.group);
    this.crowsDue = state.robberHex !== null && !barren(lookOf(this.board.hexes[state.robberHex]?.terrain ?? 'desert'));

    // Particles: the world's shared pools.
    this.dust = world.particles.dust;
    this.smoke = world.particles.smoke;
    this.sparkle = world.particles.sparkle;

    // Placement markers (instanced, pulsing gold).
    const { markerMat, ring, bar } = this.parts;
    this.vertexMarkers = instancedMesh(ring, markerMat, 64);
    this.vertexMarkers.count = 0;
    this.vertexMarkers.renderOrder = 30;
    this.edgeMarkers = instancedMesh(bar, markerMat, 80);
    this.edgeMarkers.count = 0;
    this.edgeMarkers.renderOrder = 30;
    this.vertexMarkers.frustumCulled = this.edgeMarkers.frustumCulled = false;
    this.group.add(this.vertexMarkers, this.edgeMarkers);
    // Hex outlines are for an expansion's pick alone (the robber's targets keep to the hover glow,
    // see Presenter.syncMarkers), so a base game builds neither them nor their shaders: an
    // instanced mesh is a node build and a vertex program of its own in each pass.
    this.modular = state.options.modules.length > 0;
    if (this.modular) {
      const hex = (this.hexMarkers = instancedMesh(this.parts.hexBar, markerMat, HEX_MARKS * 6));
      hex.count = 0;
      hex.visible = false;
      hex.renderOrder = 30;
      hex.frustumCulled = false;
      this.group.add(hex);
    }

    // (A URL's ?nobatch draws them as meshes, to compare.)
    if ((world.stage.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend && !new URLSearchParams(location.search).has('nobatch')) {
      // Room for every seat's settlements and cities (it grows if a game needs more).
      const verts = (k: 'settlement' | 'city') => this.geo(k, this.colors[0], 0).getAttribute('position').count;
      const idx = (k: 'settlement' | 'city') => this.geo(k, this.colors[0], 0).index?.count ?? 0;
      const seats = this.colors.length;
      // (Every seat's shapes joined now, so its shaders are built for them by the game's start: see standInBatch.ts.)
      const shapes = this.colors.flatMap((c, seat) => [this.geo('settlement', c, seat), this.geo('city', c, seat)]);
      this.buildBatch = new StandInBatch((mesh) => pieceMaterial(piecesNight, {}, mesh), { instances: 16 * seats, vertices: (verts('settlement') + verts('city')) * seats, indices: (idx('settlement') + idx('city')) * seats }, { castShadow: true, receiveShadow: true }, this.group, world.stage, 'buildings', shapes);
    }
    for (let v = 0; v < state.buildings.length; v++) {
      const b = state.buildings[v];
      if (b) this.setBuilding(v, b.owner, b.kind, false);
    }
    // (Ships and bridges are the expansions' pieces: see marks.ts.)
    state.routes.forEach((r, e) => {
      if (r?.kind === 'road') this.setRoad(e, r.owner, false);
      else if (r?.kind === 'bridge') this.bridges.set(e, r.owner);
      if (r && r.kind !== 'road') this.crossings.set(e, r.owner);
    });
    // The expansions' pieces, in one batch with the pieces' material (see marks.ts).
    if (ext) {
      const marks = new ext.ModuleMarks(this.board, this.pieceMat, {
      ground: (x, z) => this.groundY(x, z),
      smoke: world.particles.smoke,
      lamps: world.lamps,
      rise: (hex) => world.effects.riseValues[hex] ?? 0,
      obstacles: () => this.waterObstacles(),
      speed: () => world.animator.speed,
      centre: world.islandCentre,
      clear: (x, z, r) => {
        world.decor?.clearAround(x, z, r, world.animator);
        world.decor?.trample(x, z, r * 1.3, world.animator);
      },
      wet: (x, z, r) => ext.wetAt(world.tiles?.tiles ?? [], x, z, r),
      busy: (x, z, r) => ext.busyAt(world.tiles?.tiles ?? [], x, z, r),
      lift: seaLiftOf(world),
      });
      this.group.add(marks.group);
      void marks.sync(state, 'none');
      this.marks = marks;
    }

    this.group.add(this.still);
    world.boardGroup.add(this.group);
    world.stage.bundles.add(this.still);
    this.unsub = world.onFrame((dt, t) => this.update(dt, t));
  }

  private geo(kind: 'settlement' | 'city' | 'road', color: PlayerColor, seat = -1): THREE.BufferGeometry {
    const key = `${kind}:${color}:${seat}`;
    let g = this.geos.get(key);
    if (!g) {
      g = kind === 'settlement' ? makeSettlement(color, seat) : kind === 'city' ? makeCity(color, seat) : makeRoad(color);
      if (kind === 'road') {
        // Each instance's mitred ends and axes (see roadMaterial and writeRoads). (Not marked
        // dynamic: three would send them again at every draw, though they change only now and then.)
        for (const name of ['aMitre', 'aAxis']) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(ROAD_SLOTS * 4), 4));
        g.setAttribute('aGlow', new THREE.InstancedBufferAttribute(new Float32Array(ROAD_SLOTS), 1));
      }
      this.geos.set(key, g);
    }
    return g;
  }

  /** A city's flag in a colour (kept with the pieces' geometry). */
  private flagGeo(color: PlayerColor) {
    const key = `flag:${color}:-1`;
    let g = this.geos.get(key);
    if (!g) {
      g = makeFlag(color);
      this.geos.set(key, g);
    }
    return g;
  }

  groundY(x: number, z: number): number {
    // Lanes and corners are flat; sample the nearest tile for robustness.
    let best = -1;
    let bd = Infinity;
    for (const h of landHexes(this.board)) {
      const d = (h.x - x) ** 2 + (h.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = h.id;
      }
    }
    // (0 once the board is gone: a straggling caller gets the sea floor rather than a throw.)
    return this.world.tiles?.tiles.length ? this.world.tiles.heightAt(best, x, z) : 0;
  }

  vertexPos(v: number): THREE.Vector3 {
    const vx = this.board.vertices[v];
    return new THREE.Vector3(vx.x, this.groundY(vx.x, vx.z), vx.z);
  }

  // ------------------------------------------------------------------ pieces

  private buildingObject(kind: 'settlement' | 'city', owner: PlayerId): THREE.Object3D {
    const color = this.colors[owner];
    // (Each seat's buildings carry its mark, as well as its colour.)
    const geo = this.geo(kind, color, owner);
    const body = new THREE.Object3D();
    const mesh = this.buildBatch?.add(body, geo) ? body : new THREE.Mesh(geo, this.pieceMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Light spilling from the door lanterns and windows onto the walls and ground in front;
    // a city's tower windows light its yard too.
    const lamps = this.world.lamps;
    const spill = { color: WINDOW, distance: kind === 'city' ? 0.65 : 0.55, strength: 0.95 };
    if (kind === 'settlement') lamps.add(mesh, { x: 0.01, y: 0.06, z: 0.095 }, spill);
    else {
      lamps.add(mesh, { x: -0.015, y: 0.065, z: 0.105 }, spill);
      lamps.add(mesh, { x: 0.065, y: 0.1, z: 0.035 }, { ...spill, strength: 0.4 });
    }
    if (kind === 'city') {
      const flag = new THREE.Mesh(this.flagGeo(color), this.parts.flagMat);
      flag.position.copy(FLAG_OFFSET);
      flag.castShadow = true;
      flag.userData.flag = true;
      mesh.add(flag);
    }
    return mesh;
  }

  /**
   * Hidden stand-ins for what first appears once play is under way (a settlement, a city and its
   * flag, a road, their placement ghosts and a traveller), for the game-start precompile: each
   * would otherwise build its shaders on first sight and stall that frame, which phones feel most.
   * (Shaders differ by material and the set of vertex attributes, not by colour or shape.) Every
   * seat's pieces are built now too, rather than on their first move.
   *
   * They stay, hidden, until the board is disposed: the renderer keeps a compiled pipeline only
   * while some object uses it, so taking them away after the precompile threw away what it built,
   * and the first settlement, road, flag and pennant compiled theirs on the spot after all (a
   * stall of over a second on a phone).
   */
  standIns() {
    this.colors.forEach((c, seat) => {
      this.geo('settlement', c, seat);
      this.geo('city', c, seat);
      this.geo('road', c);
    });
    const group = new THREE.Group();
    group.visible = false;
    const color = this.colors[0];
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, shadow = true) => {
      const m = new THREE.Mesh(geometry, material);
      m.castShadow = m.receiveShadow = shadow;
      m.frustumCulled = false;
      group.add(m);
      return m;
    };
    for (const kind of ['settlement', 'city'] as const) add(this.geo(kind, color, 0), this.pieceMat);
    for (const kind of ['settlement', 'city', 'road'] as const) add(this.geo(kind, color), this.ghostMat, false);
    // (As the roads' own batches are: their capacity and layer are part of the shader.)
    const road = instancedMesh(this.geo('road', color), this.roadMat, ROAD_SLOTS);
    road.count = 1;
    road.userData.cobble = cobbleColors(color);
    road.castShadow = false;
    road.receiveShadow = true;
    road.frustumCulled = false;
    road.layers.set(DETAIL_LAYER);
    group.add(road);
    const walker = this.travellers.standIn();
    add(this.flagGeo(color), this.parts.flagMat).receiveShadow = false;
    const crow = this.crowFlock.standIn();
    group.add(crow);
    const pennant = instancedMesh(this.pennantGeo(color), this.parts.flagMat, ROAD_SLOTS);
    pennant.count = 1;
    pennant.castShadow = true;
    pennant.frustumCulled = false;
    group.add(pennant);
    // (The expansions' pieces: none in a base game; their own batch is readied, see ModuleMarks.standIn.)
    const marks = this.modular ? (this.marks?.standIn() ?? null) : null;
    this.group.add(group);
    this.dropStandIns = () => {
      this.dropStandIns = null;
      group.removeFromParent();
      walker();
      marks?.();
      release(group);
    };
  }

  /** Takes the precompile's stand-ins away (with the board). */
  private dropStandIns: (() => void) | null = null;

  /**
   * A number disc for a hex found in the fog, standing on its tile (hidden until it's dropped
   * onto it, with `hidden`).
   */
  addDisc(hex: number, n: number, hidden = false) {
    const h = this.board.hexes[hex];
    const ground = (x: number, z: number) => this.world.tiles!.heightAt(hex, h.x + x, h.z + z);
    const g0 = ground(0, 0);
    let tok = this.tokens.get(hex);
    if (!tok) {
      tok = this.tokenFactory.cluster([n], (x, z) => ground(x, z) - g0);
      this.still.add(tok.group);
      this.tokens.set(hex, tok);
    } else tok.setNumbers([n]);
    tok.group.position.set(h.x, g0 + TOKEN_Y - 0.02, h.z);
    tok.group.visible = !hidden;
    this.numbersNow.set(hex, [n]);
    return tok;
  }

  /**
   * The ground cover was rebuilt (a hex found in the fog): clear the trees and tread the grass
   * round every building standing again, at once.
   */
  reclear() {
    const decor = this.world.decor;
    if (!decor) return;
    const now = { tween: (o: { update: (t: number) => void }) => o.update(1) };
    for (const [v, r] of this.buildings) {
      if (r.kind === 'road') continue;
      const p = this.board.vertices[v];
      const site = this.siteOf(r.kind, p.x, p.z);
      decor.clearAround(p.x, p.z, site.clear, now);
      decor.trample(p.x, p.z, site.trample, now);
    }
  }

  /** What stands on the land as the island sinks, each with the hexes it stands on (see rideGround). */
  private riders: { o: THREE.Object3D; y0: number; hexes: number[] }[] = [];

  /**
   * Leaving the game: what stands on the land (the discs and the robber on their hexes, pieces on
   * their corners and edges) is left to ride its ground down into the sea (rideGround); the rest
   * (a fishing ground's discs on the water) drops away and is gone, from the coast inwards over
   * `spread` seconds. Animations still under way stop where they are (none is finished first), the
   * placement markers and ghost go, and the travellers stop. (Were everything to drop away and
   * shrink to nothing before the tiles went, the numbers would vanish in mid-air.)
   */
  sinkAll(spread: number) {
    this.anim.cancelAll();
    this.sunk = true;
    this.marks?.stop();
    this.showMarkers(null);
    this.showGhost(null);
    this.travellers.stopped = true;
    this.crows(null);
    this.harbours.previewAt(null, '#000000');
    if (this.pennants) {
      this.pennants.removeFromParent();
      release(this.pennants);
      this.pennants = null;
    }
    const items: THREE.Object3D[] = [];
    // (Containers sit at the origin, however deep; their contents are what stand on the island.)
    // (Not the harbours: they place their own parts every frame, and go down by sinkHarbours.)
    const collect = (c: THREE.Object3D) => {
      if ((c as THREE.InstancedMesh).isInstancedMesh || (c as THREE.BatchedMesh).isBatchedMesh || !c.visible || c === this.harbours.group) return;
      if (c.position.lengthSq() < 1e-6 && c.children.length) c.children.forEach(collect);
      else items.push(c);
    };
    this.group.children.forEach(collect);
    // What stands on the land, and on which of its hexes: a piece on a corner or an edge goes down
    // with the first of them to go.
    const ground = new Map<THREE.Object3D, number[]>();
    const land = (hexes: number[]) => hexes.filter((h) => isLand(this.board.hexes[h].terrain));
    const stand = (o: THREE.Object3D, hexes: number[]) => hexes.length && ground.set(o, hexes);
    for (const [hex, d] of this.tokens) stand(d.group, land([hex]));
    if (this.robberHex >= 0) stand(this.robber, land([this.robberHex]));
    for (const [v, p] of this.buildings) stand(p.obj, land(this.board.vertices[v].hexes));
    for (const [e, p] of this.roads) stand(p.obj, land(this.board.edges[e].hexes));
    this.riders = [];
    const far = Math.max(1, ...items.map((o) => Math.hypot(o.position.x, o.position.z)));
    for (const o of items) {
      const hexes = ground.get(o);
      if (hexes) {
        this.riders.push({ o, y0: o.position.y, hexes });
        continue;
      }
      const y0 = o.position.y;
      const s0 = o.scale.clone();
      const lamps = this.world.lamps.under(o);
      const gains = lamps.map((l) => l.gain);
      this.anim.tween({
        delay: (1 - Math.hypot(o.position.x, o.position.z) / far) * spread,
        duration: 0.45,
        easing: ease.inQuad,
        update: (t) => {
          o.position.y = y0 - 0.35 * t;
          o.scale.copy(s0).multiplyScalar(Math.max(0.001, 1 - t));
          lamps.forEach((l, i) => (l.gain = gains[i] * (1 - t)));
        },
      });
    }
  }

  /**
   * Move what stands on the land with its ground as the island sinks (see sinkAll): `riseOf`, a
   * hex's height off its place (a heave above, then down into the sea).
   */
  rideGround(riseOf: (hex: number) => number) {
    for (const r of this.riders) {
      let y = Infinity;
      for (const h of r.hexes) y = Math.min(y, riseOf(h));
      r.o.position.y = r.y0 + y;
    }
  }

  /** Hide pieces restored from a saved game until the island has risen. */
  hidePieces() {
    for (const r of [...this.buildings.values(), ...this.roads.values()]) r.obj.visible = false;
    for (const [v, h] of this.headlands) {
      h.group.visible = false;
      this.harbours.setStairs(v, false);
    }
    // (Their harbours' claims too: they colour in as the buildings land.)
    this.harbours.hideClaims();
    this.marks?.hide();
    this.contactsDirty = true;
    this.joinsDirty = true;
  }

  /**
   * Put the restored pieces back in the order they were built: the settlements and cities drop in,
   * then each seat's roads are laid out from its houses a link at a time, every one paved from the
   * end that joins what is already there.
   */
  async revealPieces() {
    if (this.cancelled) return;
    this.bridgesShown = false;
    const lands = [...this.headlands.entries()].map(([v, h]) => {
      h.group.visible = true;
      this.harbours.setStairs(v, true);
      return this.raiseHeadland(h.group);
    });
    await Promise.all(lands);
    if (this.cancelled) return;
    const drops: Promise<void>[] = [];
    const after = (delay: number, fn: () => Promise<void> | void) => drops.push(this.anim.wait(delay).then(() => (this.cancelled ? undefined : fn())));
    // When each corner's network is there to build on: a house once it has landed, a road's far end once laid.
    const ready = new Map<string, number>();
    const at = (owner: PlayerId, v: number) => `${owner}:${v}`;
    let i = 0;
    for (const [v, r] of this.buildings) {
      const pos = r.obj.position.clone();
      const delay = i++ * 0.05;
      r.landed = false;
      ready.set(at(r.owner, v), delay + 0.55);
      after(delay, () => {
        r.obj.visible = true;
        const spot = this.harbours.unveil(v);
        if (spot) this.sparkleBurst(spot, 24, PLAYER_PALETTE[this.colors[r.owner]].light);
        return this.animateDrop(r, pos, 0.8);
      });
    }
    // The expansions' pieces (ships, bridges) come with the houses, and the roads go on across them.
    let end = i * 0.05 + 0.55;
    // (Roads go on across them only once they are shown.)
    const shownAt = end;
    after(end, async () => {
      await this.marks?.reveal();
      this.bridgesShown = true;
    });
    // Out along each network, nearest the houses first (a road that joins none is laid from its first
    // end once the rest are down).
    const pending = new Map(this.roads);
    for (const r of pending.values()) r.landed = false;
    const LINK = 0.3;
    const cross = () => {
      for (let more = true; more; ) {
        more = false;
        for (const [e, owner] of this.crossings) {
          const { a, b } = this.board.edges[e];
          const ta = ready.get(at(owner, a)), tb = ready.get(at(owner, b));
          if ((ta === undefined) === (tb === undefined)) continue;
          ready.set(at(owner, ta === undefined ? a : b), Math.max(ta ?? tb!, shownAt) + LINK);
          more = true;
        }
      }
    };
    while (pending.size) {
      cross();
      const layer: [number, PieceRec, boolean, number][] = [];
      for (const [e, r] of pending) {
        const { a, b } = this.board.edges[e];
        const ta = ready.get(at(r.owner, a)), tb = ready.get(at(r.owner, b));
        if (ta === undefined && tb === undefined) continue;
        const fromB = ta === undefined || (tb !== undefined && tb < ta);
        layer.push([e, r, fromB, fromB ? tb! : ta!]);
      }
      if (!layer.length) {
        const [e, r] = pending.entries().next().value!;
        layer.push([e, r, false, end]);
      }
      for (const [e, r, fromB, start] of layer) {
        pending.delete(e);
        const { a, b } = this.board.edges[e];
        const near = at(r.owner, fromB ? b : a), far = at(r.owner, fromB ? a : b);
        if (!ready.has(near)) ready.set(near, start);
        const done = start + LINK;
        if (!ready.has(far) || ready.get(far)! > done) ready.set(far, done);
        end = Math.max(end, start + 0.75);
        after(start, () => {
          r.obj.visible = true;
          // (Its joins form as it is laid: see animatePave.)
          this.joinsDirty = true;
          return this.animatePave(r, fromB);
        });
      }
    }
    await Promise.all(drops);
  }

  private headlands = new Map<number, { group: THREE.Group; geos: THREE.BufferGeometry[] }>();

  /** What stands in the sea off the coast (piers, moored boats, headlands), as circles in xz. */
  waterObstacles() {
    const out = this.harbours.waterObstacles();
    for (const h of this.headlands.values()) out.push({ x: h.group.position.x, z: h.group.position.z, r: 0.5 });
    return out;
  }

  /**
   * A coastal corner (one or two land hexes) gets a lobe of new land under its building.
   * Returns the headland when it was just created (so the caller can raise it first).
   */
  /** The headland a building at corner `v` stands on (or null: an inland corner). */
  private headlandSpec(v: number): HeadlandSpec | null {
    const vx = this.board.vertices[v];
    const land = this.landAt(v);
    if (land.length >= 3 || land.length === 0 || !this.world.tiles) return null;
    let cx = 0, cz = 0;
    for (const h of land) {
      cx += this.board.hexes[h].x;
      cz += this.board.hexes[h].z;
    }
    cx /= land.length;
    cz /= land.length;
    const dx = vx.x - cx, dz = vx.z - cz;
    const d = Math.hypot(dx, dz) || 1;
    const hex = this.board.hexes[land[0]];
    return { dirX: dx / d, dirZ: dz / d, radius: land.length === 1 ? 0.2 : 0.16, topY: this.groundY(vx.x, vx.z), tile: hex.id, terrain: lookOf(hex.terrain)!, seed: v * 13 + 5 };
  }

  /** The land hexes at corner `v` (a coast is where there are fewer than three). */
  private landAt(v: number): number[] {
    return this.board.vertices[v].hexes.filter((h) => isLand(this.board.hexes[h].terrain));
  }

  private ensureHeadland(v: number, kind: 'settlement' | 'city'): THREE.Group | null {
    const vx = this.board.vertices[v];
    if (this.landAt(v).length >= 3) return null;
    const have = this.headlands.get(v);
    if (have) {
      // Hidden until the island rose (beginner set-up): raise it now like a new one.
      if (!have.group.visible) {
        have.group.visible = true;
        this.harbours.setStairs(v, true);
        return have.group;
      }
      if (kind === 'city') this.growHeadland(have.group, 1.25);
      else if (have.group.scale.x > 1.01) this.growHeadland(have.group, 1);
      return null;
    }
    const tiles = this.world.tiles;
    const spec = this.headlandSpec(v);
    if (!tiles || !spec) return null;
    const g = makeHeadland(spec);
    const rocksGeo = makeHeadlandRocks(spec);
    // The cliff and its boulders share the cliffs' material: one mesh.
    const cliff = mergeGeometries([g.wall, rocksGeo]) ?? g.wall;
    if (cliff !== g.wall) {
      g.wall.dispose();
      rocksGeo.dispose();
    }
    const group = new THREE.Group();
    const top = new THREE.Mesh(g.top, tiles.top.material);
    const wall = new THREE.Mesh(cliff, tiles.walls.material);
    top.receiveShadow = wall.receiveShadow = true;
    top.castShadow = wall.castShadow = true;
    group.add(top, wall);
    group.position.set(vx.x, 0, vx.z);
    if (kind === 'city') group.scale.set(1.25, 1, 1.25);
    this.still.add(group);
    this.headlands.set(v, { group, geos: [g.top, cliff] });
    // (Its harbour's stairs, if any, now start from its edge.)
    this.harbours.setStairs(v, true);
    return group;
  }

  private growHeadland(group: THREE.Group, to: number) {
    const from = group.scale.x;
    return this.anim.tween({ duration: 0.6, easing: ease.outBack, update: (t) => group.scale.set(from + (to - from) * t, 1, from + (to - from) * t) }).promise;
  }

  /** Land taken back: it sinks into the sea with a splash, and is hidden (to rise again if built on). */
  private sinkHeadland(group: THREE.Group): Promise<void> {
    sfx.play('splash', { volume: 0.5 });
    waterBurst(this.world.particles.spray, this.world.particles.mist, { x: group.position.x, y: SEA_LEVEL + 0.02, z: group.position.z, count: 26, radius: 0.22, up: [0.4, 0.9], out: [0.12, 0.3], size: 0.03 });
    const y0 = group.position.y;
    return this.anim.tween({ duration: 0.7, easing: ease.inCubic, update: (t) => (group.position.y = y0 - 0.55 * t) }).promise.then(() => {
      if (this.cancelled) return;
      group.visible = false;
      group.position.y = 0;
    });
  }

  /** How far round a building trees are cleared and ground cover trodden. */
  private siteOf(kind: 'settlement' | 'city', x: number, z: number): Site {
    return kind === 'city' ? { x, z, clear: 0.24, trample: 0.55 } : { x, z, clear: 0.17, trample: 0.4 };
  }

  /** The buildings standing (but the one at `except`), as sites. */
  private sites(except: number): Site[] {
    const out: Site[] = [];
    for (const [v, r] of this.buildings) {
      if (v === except || r.kind === 'road') continue;
      const p = this.board.vertices[v];
      out.push(this.siteOf(r.kind, p.x, p.z));
    }
    return out;
  }

  /** The new land pushes up out of the sea with spray, then settles. */
  private raiseHeadland(group: THREE.Group): Promise<void> {
    sfx.play('splash', { volume: 0.7 });
    waterBurst(this.world.particles.spray, this.world.particles.mist, { x: group.position.x, y: SEA_LEVEL + 0.02, z: group.position.z, count: 40, radius: 0.24, up: [0.5, 1.1], out: [0.15, 0.4], size: 0.035 });
    group.position.y = -0.55;
    return this.anim
      .tween({ duration: 0.75, easing: ease.outBack, update: (t) => (group.position.y = -0.55 * (1 - t)) })
      .promise.then(() => {
        if (this.cancelled) return;
        this.dustBurst(new THREE.Vector3(group.position.x, this.groundY(group.position.x, group.position.z), group.position.z), 10, 0.12);
      });
  }

  setBuilding(v: number, owner: PlayerId, kind: 'settlement' | 'city', animate = true): Promise<void> {
    const prev = this.buildings.get(v);
    const pos = this.vertexPos(v);
    const fresh = this.ensureHeadland(v, kind);
    const obj = this.buildingObject(kind, owner);
    obj.position.copy(pos);
    const decor = this.world.decor;
    const site = this.siteOf(kind, pos.x, pos.z);
    const downgrade = prev?.kind === 'city' && kind === 'settlement';
    if (downgrade) {
      // A city taken back: the trees and ground cover it took beyond a settlement's come back.
      const others = [...this.sites(v), site];
      decor?.regrowAround(pos.x, pos.z, 0.24, others, this.world.animator);
      decor?.untrample(pos.x, pos.z, 0.55, others, this.world.animator);
    } else {
      decor?.clearAround(pos.x, pos.z, site.clear, this.world.animator);
      decor?.trample(pos.x, pos.z, site.trample, this.world.animator);
    }
    obj.userData.baseScale = PIECE_SCALE;
    // Face roughly outward from the island centre with a little per-site variety.
    obj.rotation.y = Math.atan2(pos.x, pos.z) + ((v * 37) % 7) * 0.12 - 0.36;
    windward(obj);
    this.still.add(obj);
    const rec: PieceRec = { obj, owner, kind, landed: !animate };
    this.buildings.set(v, rec);
    this.contactsDirty = true;
    // (Roads joined at this corner part from it as the house comes down.)
    this.joinsDirty = true;
    if (!animate) this.joinSnap = true;
    const claimed = this.harbours.claim(v, PLAYER_PALETTE[this.colors[owner]].ui, animate);
    if (claimed && animate) this.sparkleBurst(claimed, 24, PLAYER_PALETTE[this.colors[owner]].light);
    if (!animate) {
      obj.scale.setScalar(PIECE_SCALE);
      if (prev) this.removeObj(prev.obj);
      return Promise.resolve();
    }
    if (prev && kind === 'city') return this.animateUpgrade(prev.obj, rec, pos);
    if (downgrade) return this.animateDowngrade(prev.obj, rec, pos);
    if (prev) this.removeObj(prev.obj);
    if (fresh) {
      // Land first, then the house drops onto it.
      obj.scale.setScalar(0.001);
      return this.raiseHeadland(fresh).then(() => (this.cancelled ? undefined : this.animateDrop(rec, pos, 0.9)));
    }
    return this.animateDrop(rec, pos, 0.9);
  }

  setRoad(e: number, owner: PlayerId, animate = true): Promise<void> {
    const old = this.roads.get(e);
    if (old) this.removeObj(old.obj);
    const f = roadFrame(this.board, e);
    // (Drawn by its seat's instanced roads: see writeRoads.)
    const mesh = new THREE.Object3D();
    mesh.userData.seat = owner;
    this.roadSlots.add(mesh);
    const y = Math.max(this.groundY(f.ax * 0.75 + f.bx * 0.25, f.az * 0.75 + f.bz * 0.25), this.groundY(f.x, f.z)) + 0.002;
    mesh.position.set(f.x, y, f.z);
    mesh.rotation.y = -f.angle;
    mesh.userData.baseScale = 1;
    mesh.userData.edge = e;
    mesh.userData.y = y;
    this.still.add(mesh);
    const rec: PieceRec = { obj: mesh, owner, kind: 'road', landed: !animate };
    this.roads.set(e, rec);
    this.contactsDirty = true;
    this.joinsDirty = true;
    if (!animate) {
      this.joinSnap = true;
      return Promise.resolve();
    }
    // (Laid out from the seat's house or road it joins, not towards it.)
    const { a, b } = this.board.edges[e];
    return this.animatePave(rec, !this.joins(owner, a, e) && this.joins(owner, b, e));
  }

  /** Whether a seat's house stands at corner v, or another of its roads ends there (not edge e). */
  private joins(owner: PlayerId, v: number, e: number) {
    if (this.buildings.get(v)?.owner === owner) return true;
    return this.board.vertices[v].edges.some((x) => x !== e && this.roads.get(x)?.owner === owner);
  }

  /** Take a road off the board (taken back): it lifts and shrinks away. */
  removeRoad(e: number, animate = true): Promise<void> {
    const r = this.roads.get(e);
    if (!r) return Promise.resolve();
    this.roads.delete(e);
    this.contactsDirty = true;
    // (Roads that were joined to it part from where it stood as it lifts away. It keeps its own shape till it is gone.)
    this.joinsDirty = true;
    if (!animate) this.joinSnap = true;
    return this.liftAway(r.obj, animate);
  }

  /** Take a settlement off the board (taken back); its harbour and any headland built for it go too. */
  removeBuilding(v: number, animate = true): Promise<void> {
    const b = this.buildings.get(v);
    if (!b) return Promise.resolve();
    this.buildings.delete(v);
    this.contactsDirty = true;
    // (The roads that meet at its corner run on across it once it has lifted away.)
    this.joinsDirty = true;
    if (!animate) this.joinSnap = true;
    else this.joinDelay = Math.max(this.joinDelay, HOUSE_JOIN_DELAY);
    this.harbours.release(v, (x) => (this.buildings.has(x) ? PLAYER_PALETTE[this.colors[this.buildings.get(x)!.owner]].ui : null), animate);
    // The trees it cleared grow back and the ground cover it trod down springs up again.
    const p = this.board.vertices[v];
    const site = this.siteOf(b.kind === 'city' ? 'city' : 'settlement', p.x, p.z);
    const others = this.sites(v);
    this.world.decor?.regrowAround(p.x, p.z, site.clear, others, this.world.animator);
    this.world.decor?.untrample(p.x, p.z, site.trample, others, this.world.animator);
    const land = this.headlands.get(v);
    // (A hidden headland rises again if someone builds here later.)
    return this.liftAway(b.obj, animate).then(() => {
      if (!land || this.cancelled) return;
      if (!animate) {
        land.group.visible = false;
        this.harbours.setStairs(v, false);
        return;
      }
      land.group.scale.set(1, 1, 1);
      return this.sinkHeadland(land.group).then(() => {
        if (!this.cancelled) this.harbours.setStairs(v, false);
      });
    });
  }

  private liftAway(obj: THREE.Object3D, animate: boolean): Promise<void> {
    if (!animate) {
      this.removeObj(obj);
      return Promise.resolve();
    }
    const y0 = obj.position.y;
    const k = obj.scale.x;
    return this.anim
      .tween({ duration: 0.4, easing: ease.inQuad, update: (t) => (obj.position.y = y0 + t * 0.35, obj.scale.setScalar(k * (1 - t))) })
      .promise.then(() => {
        if (!this.cancelled) this.removeObj(obj);
      });
  }

  private removeObj(o: THREE.Object3D) {
    o.removeFromParent();
    release(o);
  }

  /**
   * A road built: laid from one end to the other as you watch, its cobbles running out along the
   * edge with a little dust thrown up where they're being set, rather than dropped from the sky
   * like a house, from its edge's first end (or from its second, `fromB`). (Drawn by writeRoads,
   * which reads userData.pave and userData.paveFromB.)
   */
  private animatePave(rec: PieceRec, fromB = false): Promise<void> {
    const obj = rec.obj;
    rec.landed = false;
    obj.userData.pave = 0;
    obj.userData.paveFromB = fromB;
    // (The corner it is laid out from: the joins there form at once, those at its far corner as it arrives.)
    const edge = this.board.edges[obj.userData.edge as number];
    obj.userData.paveFrom = fromB ? edge.b : edge.a;
    const side = fromB ? -1 : 1;
    let puffed = 0;
    return this.anim
      .tween({
        duration: 0.75,
        easing: ease.outCubic,
        update: (t) => {
          obj.userData.pave = t;
          if (t - puffed < 0.12 || t > 0.97) return;
          puffed = t;
          obj.updateMatrix();
          const at = this.paveAt.set(side * (-ROAD_LENGTH / 2 + ROAD_LENGTH * t), 0.02, 0).applyMatrix4(obj.matrix);
          this.dustBurst(at, 3, 0.05);
        },
      })
      .promise.then(() => {
        obj.userData.pave = 1;
        if (this.cancelled) return;
        rec.landed = true;
        this.contactsDirty = true;
      });
  }

  private paveAt = new THREE.Vector3();

  private animateDrop(rec: PieceRec, pos: THREE.Vector3, height: number): Promise<void> {
    const obj = rec.obj;
    const a = this.anim;
    const k = (obj.userData.baseScale as number) ?? 1;
    rec.landed = false;
    obj.position.set(pos.x, pos.y + height, pos.z);
    obj.scale.setScalar(0.001);
    return a
      .tween({
        duration: 0.55,
        easing: ease.inQuad,
        update: (t) => {
          obj.position.y = pos.y + height * (1 - t);
          const s = Math.min(1, 0.4 + t * 1.2) * k;
          obj.scale.set(s, s, s);
        },
      })
      .promise.then(() => {
        if (this.cancelled) return;
        rec.landed = true;
        this.contactsDirty = true;
        this.dustBurst(pos, 14, 0.14);
        return a.tween({
          duration: 0.4,
          easing: ease.linear,
          update: (t) => {
            const sq = Math.sin(t * Math.PI) * Math.exp(-t * 2.5);
            obj.scale.set(k * (1 + sq * 0.18), k * (1 - sq * 0.24), k * (1 + sq * 0.18));
          },
          done: () => obj.scale.set(k, k, k),
        }).promise;
      });
  }

  /**
   * A settlement becoming a city: scaffolding goes up round the house as it comes down, the city
   * rises inside it, and the scaffold is struck once it stands (with a little dust).
   */
  private animateUpgrade(old: THREE.Object3D, rec: PieceRec, pos: THREE.Vector3): Promise<void> {
    const a = this.anim;
    const city = rec.obj;
    city.scale.set(0.001, 0.001, 0.001);
    rec.landed = true;
    let scaffold: THREE.Mesh | null = null;
    if (!this.scaffoldGeo) this.scaffoldGeo = makeScaffold();
    scaffold = new THREE.Mesh(this.scaffoldGeo, this.pieceMat);
    scaffold.castShadow = scaffold.receiveShadow = true;
    scaffold.position.copy(pos);
    scaffold.rotation.y = city.rotation.y;
    scaffold.scale.set(PIECE_SCALE, 0.001, PIECE_SCALE);
    this.still.add(scaffold);
    a.tween({ duration: 0.4, easing: ease.outCubic, update: (t) => scaffold && scaffold.scale.setY(PIECE_SCALE * Math.max(0.001, t)) });
    const strike = (): Promise<void> => {
      const sc = scaffold;
      scaffold = null;
      if (!sc) return Promise.resolve();
      if (this.cancelled) {
        this.removeObj(sc);
        return Promise.resolve();
      }
      this.dustBurst(pos, 12, 0.18);
      return a
        .tween({ duration: 0.35, easing: ease.inQuad, update: (t) => sc.scale.setY(PIECE_SCALE * Math.max(0.001, 1 - t)) })
        // (Released, not only taken off: the pieces' shared material would keep it otherwise.)
        .promise.then(() => this.removeObj(sc));
    };
    return a
      .tween({
        duration: 0.45,
        easing: ease.inCubic,
        update: (t) => {
          old.scale.set(PIECE_SCALE * (1 + t * 0.15), PIECE_SCALE * (1 - t * 0.9), PIECE_SCALE * (1 + t * 0.15));
          old.position.y = pos.y - t * 0.02;
        },
        done: () => this.removeObj(old),
      })
      .promise.then(() => {
        if (this.cancelled) return;
        this.removeObj(old);
        this.dustBurst(pos, 26, 0.2);
        this.sparkleBurst(pos.clone().setY(pos.y + 0.15), 30, '#ffe7a0');
        return a.tween({
          duration: 0.9,
          easing: ease.outElastic,
          update: (t) => {
            const s = Math.max(0.001, t) * PIECE_SCALE;
            city.scale.set(s, s, s);
          },
          done: () => city.scale.set(PIECE_SCALE, PIECE_SCALE, PIECE_SCALE),
        }).promise;
      })
      .then(strike, (e) => {
        void strike();
        throw e;
      });
  }

  /** The upgrade's scaffold (made on the first upgrade, kept with the board's pieces' geometry). */
  private scaffoldGeo: THREE.BufferGeometry | null = null;

  /** A city taken back to a settlement: the city settles down into the ground, the cottage pops up. */
  private animateDowngrade(old: THREE.Object3D, rec: PieceRec, pos: THREE.Vector3): Promise<void> {
    const a = this.anim;
    const house = rec.obj;
    house.scale.set(0.001, 0.001, 0.001);
    rec.landed = true;
    const k = old.scale.x;
    return a
      .tween({
        duration: 0.4,
        easing: ease.inCubic,
        update: (t) => {
          old.scale.set(k * (1 + t * 0.1), k * (1 - t * 0.95), k * (1 + t * 0.1));
          old.position.y = pos.y - t * 0.02;
        },
      })
      .promise.then(() => {
        if (this.cancelled) return;
        this.removeObj(old);
        this.dustBurst(pos, 20, 0.16);
        return a.tween({
          duration: 0.6,
          easing: ease.outBack,
          update: (t) => house.scale.setScalar(Math.max(0.001, t) * PIECE_SCALE),
          done: () => house.scale.setScalar(PIECE_SCALE),
        }).promise;
      });
  }

  dustBurst(pos: THREE.Vector3, n: number, spread: number) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const sp = spread * (0.6 + Math.random() * 0.8);
      this.dust.emit({
        x: pos.x + Math.cos(a) * 0.04,
        y: pos.y + 0.02,
        z: pos.z + Math.sin(a) * 0.04,
        vx: Math.cos(a) * sp,
        vy: 0.05 + Math.random() * 0.08,
        vz: Math.sin(a) * sp,
        life: 0.8 + Math.random() * 0.5,
        size: 0.05 + Math.random() * 0.04,
        grow: 2.6,
        color: '#d9c8a8',
        alpha: 0.55,
        drag: 3.2,
      });
    }
  }

  /** Screen point just above the building at vertex `v` (where produced cards gather). */
  buildingScreen(v: number) {
    return this.toScreen(this.vertexPos(v).add(new THREE.Vector3(0, 0.16, 0)));
  }

  /**
   * A harvest on its way: a stream of motes in the resource's colour arcs up out of the tile and
   * comes down on the building that earned it, landing as its card does (the card makes the same
   * trip over the board), so the island itself shows who is gathering what.
   */
  harvestArc(hex: number, v: number, color: string, travel: number, amount = 1) {
    const h = this.board.hexes[hex];
    const from = new THREE.Vector3(h.x, this.groundY(h.x, h.z) + 0.1, h.z);
    const to = this.vertexPos(v).add(new THREE.Vector3(0, 0.14, 0));
    // (Rising about half a tile on the way, whatever the time the trip takes.)
    const g = (8 * 0.5) / (travel * travel);
    const n = 12 + amount * 6;
    for (let i = 0; i < n; i++) {
      // A stream, not a clump: each mote a moment after the last, from a little way round the tile.
      const T = travel * (0.9 + Math.random() * 0.14);
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.14;
      const x = from.x + Math.cos(a) * r, z = from.z + Math.sin(a) * r;
      void this.anim.wait(i * 0.016).then(() =>
        !this.cancelled && this.sparkle.emit({
          x,
          y: from.y,
          z,
          vx: (to.x - x) / T,
          vy: (to.y - from.y + 0.5 * g * T * T) / T,
          vz: (to.z - z) / T,
          life: T + 0.12,
          size: 0.055 + Math.random() * 0.035,
          grow: 0.1,
          color,
          gravity: g,
          fadeIn: 0.06,
        }),
      );
    }
  }

  /** Vertex adjacency: for each intersection, its edges and where they lead. */
  private links: { edge: number; to: number }[][] | null = null;

  /**
   * The shortest way along `player`'s roads (on show) from a corner of `hex` to the building at
   * `v`, as world points on the verge, or null if no road of theirs leads there (within a few).
   */
  private roadPath(player: PlayerId, v: number, hex: number): { x: number; z: number }[] | null {
    if (!this.links) {
      this.links = this.board.vertices.map(() => []);
      for (const e of this.board.edges) {
        this.links[e.a].push({ edge: e.id, to: e.b });
        this.links[e.b].push({ edge: e.id, to: e.a });
      }
    }
    const owns = (e: number) => {
      const r = this.roads.get(e);
      return !!r && r.owner === player && r.obj.visible && r.landed;
    };
    // Breadth first from the building, out to the nearest other corner of the tile.
    const back = new Map<number, { from: number; edge: number }>([[v, { from: -1, edge: -1 }]]);
    let frontier = [v];
    let found = -1;
    for (let depth = 0; depth < 4 && found < 0 && frontier.length; depth++) {
      const next: number[] = [];
      for (const u of frontier) {
        for (const l of this.links[u]) {
          if (back.has(l.to) || !owns(l.edge)) continue;
          back.set(l.to, { from: u, edge: l.edge });
          if (this.board.vertices[l.to].hexes.includes(hex)) {
            found = l.to;
            break;
          }
          next.push(l.to);
        }
        if (found >= 0) break;
      }
      frontier = next;
    }
    if (found < 0) return null;
    // From the tile's corner back to the building, road by road, keeping to the right.
    const pts: { x: number; z: number }[] = [];
    for (let u = found; u !== v; ) {
      const step = back.get(u)!;
      const f = roadFrame(this.board, step.edge);
      const e = this.board.edges[step.edge];
      const from = e.a === u ? { x: f.ax, z: f.az } : { x: f.bx, z: f.bz };
      const to = e.a === u ? { x: f.bx, z: f.bz } : { x: f.ax, z: f.az };
      const dx = to.x - from.x, dz = to.z - from.z;
      const len = Math.hypot(dx, dz) || 1;
      const ox = (-dz / len) * 0.021, oz = (dx / len) * 0.021;
      // (Clear of whatever stands at the corner it starts from, and short of the door it ends at.)
      const a0 = pts.length ? 0 : 0.14 / len, a1 = step.from === v ? 1 - 0.16 / len : 1;
      pts.push({ x: from.x + dx * a0 + ox, z: from.z + dz * a0 + oz }, { x: from.x + dx * a1 + ox, z: from.z + dz * a1 + oz });
      u = step.from;
    }
    return pts;
  }

  /**
   * A harvest brought home: for each grant whose building its owner can reach by road from the
   * producing tile, a porter carries a crate of it along those roads to the door, arriving after
   * `duration` seconds. (Grants with no such road go by the card flight alone.)
   */
  harvestCarts(grants: { player: number; vertex: number; hex: number; resource: string }[], duration: number): void {
    if (this.cancelled) return;
    const seen = new Set<string>();
    for (const g of grants) {
      const key = `${g.vertex}:${g.hex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = this.buildings.get(g.vertex);
      if (!b || b.owner !== g.player || !b.obj.visible) continue;
      const path = this.roadPath(g.player, g.vertex, g.hex);
      if (path) this.travellers.deliver(g.player, path, RESOURCE_COLORS[g.resource] ?? '#c9b48a', duration);
    }
  }

  /** The pennants along the Longest Route, and their pop (0..1) as they go up or come down. */
  private pennants: THREE.InstancedMesh | null = null;
  private pennantAt: THREE.Matrix4[] = [];

  /**
   * Pennants in `player`'s colour along the edges of the Longest Route (or none, with null):
   * they spring up one after another along it, and the last ones fold away.
   */
  setLongestRoute(player: number | null, edges: number[]): void {
    const old = this.pennants;
    if (old) {
      // The old route's come down.
      const at = this.pennantAt;
      const m = new THREE.Matrix4(), s = new THREE.Matrix4();
      this.anim.tween({
        duration: 0.35,
        easing: ease.inQuad,
        update: (t) => {
          at.forEach((base, i) => old.setMatrixAt(i, m.multiplyMatrices(base, s.makeScale(1 - t + 1e-3, 1 - t + 1e-3, 1 - t + 1e-3))));
          old.instanceMatrix.needsUpdate = true;
        },
      }).promise.then(() => {
        old.removeFromParent();
        release(old);
      });
      this.pennants = null;
      this.pennantAt = [];
    }
    const shown = edges.filter((e) => this.roads.get(e)?.owner === player).slice(0, ROAD_SLOTS);
    if (player === null || !shown.length || this.cancelled) return;
    // (Always the roads' capacity, the count set to the route: the capacity is part of the
    // shader, so a route of another length would compile its own on the spot. See standIns.)
    const mesh = instancedMesh(this.pennantGeo(this.colors[player]), this.parts.flagMat, ROAD_SLOTS);
    mesh.count = shown.length;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    const at = shown.map((e) => {
      const f = roadFrame(this.board, e);
      // On the outer kerb at the road's middle, a little toward one end.
      const dx = Math.cos(f.angle), dz = Math.sin(f.angle);
      const x = f.x + dx * 0.08 - dz * 0.052, z = f.z + dz * 0.08 + dx * 0.052;
      const r = this.roads.get(e)!;
      // (Its streamer flies downwind, as the cities' flags do.)
      return new THREE.Matrix4().compose(new THREE.Vector3(x, r.obj.position.y + 0.03, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -WIND_ANGLE), new THREE.Vector3(PENNANT_SCALE, PENNANT_SCALE, PENNANT_SCALE));
    });
    const m = new THREE.Matrix4(), s = new THREE.Matrix4();
    for (let i = 0; i < at.length; i++) mesh.setMatrixAt(i, m.multiplyMatrices(at[i], s.makeScale(1e-3, 1e-3, 1e-3)));
    this.still.add(mesh);
    this.pennants = mesh;
    this.pennantAt = at;
    const n = at.length;
    this.anim.tween({
      duration: 0.5 + n * 0.08,
      easing: ease.linear,
      update: (t) => {
        at.forEach((base, i) => {
          const u = Math.min(1, Math.max(0, (t * (0.5 + n * 0.08) - i * 0.08) / 0.5));
          const k = Math.max(1e-3, ease.outBack(u));
          mesh.setMatrixAt(i, m.multiplyMatrices(base, s.makeScale(k, k, k)));
        });
        mesh.instanceMatrix.needsUpdate = true;
      },
    });
  }

  /** A pennant in a colour (kept with the pieces' geometry). */
  private pennantGeo(color: PlayerColor) {
    const key = `pennant:${color}:-1`;
    let g = this.geos.get(key);
    if (!g) {
      g = makePennant(color);
      this.geos.set(key, g);
    }
    return g;
  }

  /**
   * `player` traded at a harbour for `resource` (or at 3:1, with 'any'): the boat of one of their
   * harbours for it (or a 3:1 one) puts out to sea and comes back.
   */
  harbourTrade(player: number, resource: string | 'any'): void {
    if (this.cancelled) return;
    let pick = -1, general = -1;
    this.board.ports.forEach((port, i) => {
      if (!port.vertices.some((v) => this.buildings.get(v)?.owner === player)) return;
      if (port.type === resource && resource !== 'any') pick = pick < 0 ? i : pick;
      else if (port.type === 'any' && general < 0) general = i;
    });
    if (pick < 0) pick = general;
    if (pick >= 0) this.harbours.sail(pick, this.anim);
  }

  /**
   * The building spot `vertex` is hovered (or focused) by `player`: if it would claim a harbour,
   * that harbour's badge pulses in their colour. Null stops it.
   */
  previewHarbour(vertex: number | null, player: number): void {
    const color = PLAYER_PALETTE[this.colors[player] ?? this.colors[0]].ui;
    this.harbours.previewAt(this.cancelled ? null : vertex, color);
  }

  /** A produced card lands at a building: it bobs, with a few sparkles in its owner's colour. */
  receiveAt(v: number, owner: number) {
    const b = this.buildings.get(v);
    if (!b) return;
    const o = b.obj;
    const k = (o.userData.baseScale as number) ?? PIECE_SCALE;
    if (this.cancelled || o.scale.x < k * 0.9) return;
    this.anim.tween({
      duration: 0.32,
      update: (t) => o.scale.setScalar(k * (1 + Math.sin(t * Math.PI) * 0.07)),
      done: () => o.scale.setScalar(k),
    });
    this.sparkleBurst(this.vertexPos(v).add(new THREE.Vector3(0, 0.12, 0)), 5, PLAYER_PALETTE[this.colors[owner]].light);
  }

  sparkleBurst(pos: THREE.Vector3, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      this.sparkle.emit({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        vx: Math.cos(a) * (0.2 + Math.random() * 0.4),
        vy: 0.3 + up * 0.6,
        vz: Math.sin(a) * (0.2 + Math.random() * 0.4),
        life: 0.7 + Math.random() * 0.6,
        size: 0.03 + Math.random() * 0.03,
        grow: 0.3,
        color,
        gravity: 0.9,
        drag: 1.5,
        spin: 3,
      });
    }
  }

  // ------------------------------------------------------------------ robber

  /** Where the corsair rides on its sea hex (a theft by it is lifted from here): where it berthed, once it's there. */
  corsairSpot(hexId: number): THREE.Vector3 {
    const h = this.board.hexes[hexId];
    const at = this.marks?.where('corsair');
    // (Mid-crossing, or not yet out, it's the hex's own water.)
    return at && Math.hypot(at.x - h.x, at.z - h.z) < 1 ? at : new THREE.Vector3(h.x, SEA_LEVEL, h.z);
  }

  /** Where the piece stopping a hex stands: the robber, the raiders' camp on it or the corsair off it. */
  blockerSpot(hexId: number): THREE.Vector3 {
    if (hexId === this.robberHex) return this.robberSpot(hexId);
    const camp = this.marks?.where(`camp:${hexId}`);
    if (camp) return camp;
    return isLand(this.board.hexes[hexId].terrain) ? this.robberSpot(hexId) : this.corsairSpot(hexId);
  }

  robberSpot(hexId: number): THREE.Vector3 {
    const h = this.board.hexes[hexId];
    // Stand just behind-left of the disc, on the clearing; behind a pair of discs, between
    // them; in the middle of a square of four (the lake's), where they leave room.
    const discs = h.numbers.length;
    const ox = discs === 2 ? 0 : discs === 3 ? -TOKEN_CLEAR * 1.1 : discs >= 4 ? 0 : -TOKEN_CLEAR * 0.55;
    const oz = discs === 2 ? -TOKEN_CLEAR * 0.66 : discs === 3 ? -TOKEN_CLEAR * 0.75 : discs >= 4 ? 0 : -TOKEN_CLEAR * 0.5;
    const x = h.x + ox;
    const z = h.z + oz;
    return new THREE.Vector3(x, this.world.tiles!.heightAt(hexId, x, z) + 0.002, z);
  }

  placeRobberAt(hexId: number) {
    this.robber.position.copy(this.robberSpot(hexId));
    this.robber.rotation.y = 0.5;
    this.robberHex = hexId;
    this.blightHex = hexId;
  }

  /** The hex the robber's blight settles on (eased in update, and only while he is on show); -1: none. */
  private blightHex = -1;
  /** Counts robber moves, so a move overtaken by the next one doesn't land its blight. */
  private robberMoves = 0;
  private robberTween = -1;

  /** Arc the robber across to its next hex with a smoky take-off and landing. Resolves when landed. */
  moveRobber(to: number): Promise<void> {
    const from = this.robber.position.clone();
    const target = this.robberSpot(to);
    this.robberHex = to;
    const move = ++this.robberMoves;
    // (A move still in the air is overtaken: he sets off again from where he is.)
    this.anim.cancel(this.robberTween);
    this.blightHex = -1;
    this.crows(null);
    this.smokePuff(from, 18);
    const a = this.anim;
    const r0 = this.robber.rotation.y;
    const flight = a.tween({
      duration: 1.0,
      easing: ease.inOutCubic,
      update: (t) => {
        this.robber.position.lerpVectors(from, target, t);
        this.robber.position.y += Math.sin(t * Math.PI) * 0.9;
        this.robber.rotation.y = r0 + t * (0.5 + Math.PI * 2 - r0);
      },
    });
    this.robberTween = flight.id;
    return flight.promise.then(() => {
      if (this.cancelled || move !== this.robberMoves) return;
      this.robber.position.copy(target);
      this.robber.rotation.y = 0.5;
      this.smokePuff(target, 26);
      this.world.rig.addShake(0.05);
      this.blightHex = to;
      this.crows(to);
      return a.wait(0.7);
    });
  }

  /**
   * Crows circling over the robber's hex (they fly in), or none (they fly off). Called as the
   * robber lands and leaves.
   */
  crows(hex: number | null) {
    this.crowsDue = false;
    this.crowFlock.set(hex === null || this.cancelled ? null : this.robberSpot(hex));
  }

  /** Ease each tile's robber blight toward where he stands (none while he's hidden). */
  private updateBlight(dt: number) {
    const step = dt * this.world.animator.speed / 0.75;
    const at = this.robber.visible ? this.blightHex : -1;
    const values = this.world.effects.values;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const want = i === at ? 1 : 0;
      if (v.y !== want) v.y = want > v.y ? Math.min(want, v.y + step) : Math.max(want, v.y - step);
    }
  }

  smokePuff(pos: THREE.Vector3, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.smoke.emit({
        x: pos.x + Math.cos(a) * 0.05,
        y: pos.y + 0.05 + Math.random() * 0.1,
        z: pos.z + Math.sin(a) * 0.05,
        vx: Math.cos(a) * 0.18,
        vy: 0.12 + Math.random() * 0.12,
        vz: Math.sin(a) * 0.18,
        life: 1.2 + Math.random() * 0.6,
        size: 0.09 + Math.random() * 0.06,
        grow: 2.4,
        color: '#4a4650',
        alpha: 0.6,
        drag: 1.8,
      });
    }
  }

  // ---------------------------------------------------------------- markers

  /**
   * Light the spots a pick can be made at: rings on corners, bars along edges, and a hex's outline
   * (six bars drawn a little inside its border, where the lanes are flat) for a hex pick.
   */
  showMarkers(kind: 'vertex' | 'edge' | 'hex' | null, ids: number[] = []) {
    const m = new THREE.Matrix4();
    if (kind === 'vertex') {
      ids.slice(0, 64).forEach((v, i) => {
        const p = this.vertexPos(v);
        m.makeTranslation(p.x, p.y + 0.012, p.z);
        this.vertexMarkers.setMatrixAt(i, m);
      });
      this.vertexMarkers.count = Math.min(64, ids.length);
      this.vertexMarkers.instanceMatrix.needsUpdate = true;
    } else this.vertexMarkers.count = 0;
    if (kind === 'edge') {
      ids.slice(0, 80).forEach((e, i) => {
        const f = roadFrame(this.board, e);
        const y = this.groundY(f.x, f.z) + 0.03;
        m.compose(new THREE.Vector3(f.x, y, f.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -f.angle), new THREE.Vector3(1, 1, 1));
        this.edgeMarkers.setMatrixAt(i, m);
      });
      this.edgeMarkers.count = Math.min(80, ids.length);
      this.edgeMarkers.instanceMatrix.needsUpdate = true;
    } else this.edgeMarkers.count = 0;
    const hexMarkers = this.hexMarkers;
    if (!hexMarkers) return;
    if (kind === 'hex') {
      // (The outline sits 10% of the way in, as the flat map's does: its sides shrink by the same share.)
      const shown = ids.slice(0, HEX_MARKS);
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      shown.forEach((id, i) => {
        const hex = this.board.hexes[id];
        hex.edges.forEach((e, j) => {
          const f = edgeFrame(this.board, e);
          const side = Math.hypot(f.bx - f.ax, f.bz - f.az);
          const dx = hex.x - f.x;
          const dz = hex.z - f.z;
          const d = Math.hypot(dx, dz) || 1;
          const inset = d * 0.1;
          // (Sea hexes have no ground: the outline rides just above the water. Asking the ground
          // there would answer with the nearest land tile's rim, which stands 0.45 above the sea.)
          const y = (hex.terrain === 'sea' ? SEA_LEVEL : this.groundY(f.x, f.z)) + 0.03;
          m.compose(
            new THREE.Vector3(f.x + (dx / d) * inset, y, f.z + (dz / d) * inset),
            q.setFromAxisAngle(up, -f.angle),
            new THREE.Vector3((side - (2 * inset) / Math.sqrt(3)) / HEX_BAR, 1, 1),
          );
          hexMarkers.setMatrixAt(i * 6 + j, m);
        });
      });
      hexMarkers.count = shown.length * 6;
      hexMarkers.instanceMatrix.needsUpdate = true;
    } else hexMarkers.count = 0;
    // (Out of the draw list while it has nothing to show: an empty draw is still a call.)
    hexMarkers.visible = hexMarkers.count > 0;
  }

  /** Translucent preview of a piece at a spot (or hide with null). */
  showGhost(kind: 'settlement' | 'city' | 'road' | null, id = -1, owner: PlayerId = 0) {
    const key = kind ? `${kind}:${id}:${owner}` : '';
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    if (this.ghost) {
      this.ghost.removeFromParent();
      release(this.ghost);
      this.ghost = null;
    }
    if (!kind) return;
    const mesh = new THREE.Mesh(this.geo(kind, this.colors[owner]), this.ghostMat);
    if (kind === 'road') {
      const f = roadFrame(this.board, id);
      mesh.position.set(f.x, this.groundY(f.x, f.z) + 0.004, f.z);
      mesh.rotation.y = -f.angle;
    } else {
      const p = this.vertexPos(id);
      mesh.position.copy(p);
      mesh.rotation.y = Math.atan2(p.x, p.z) + ((id * 37) % 7) * 0.12 - 0.36;
      mesh.scale.setScalar(PIECE_SCALE);
    }
    mesh.renderOrder = 25;
    this.ghost = mesh;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------- picking

  private ray = new THREE.Raycaster();
  private pickPoint = new THREE.Vector3();

  /**
   * Where the pointer (normalised device coords) meets the board plane, and the hex under it.
   * The returned point is reused by the next call.
   */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): { hex: number; point: THREE.Vector3 } | null {
    this.ray.setFromCamera(ndc, camera);
    const p = this.ray.ray.intersectPlane(plane, this.pickPoint);
    if (!p) return null;
    let hex = -1, hd = Infinity;
    for (const h of this.board.hexes) {
      const d = (h.x - p.x) ** 2 + (h.z - p.z) ** 2;
      if (d < hd) {
        hd = d;
        hex = h.id;
      }
    }
    if (hd > 0.95 * 0.95) hex = -1;
    return { hex, point: p };
  }

  /** Screen position (CSS pixels) of a world point, for UI overlays and card flights. */
  toScreen(p: THREE.Vector3): { x: number; y: number } {
    const v = p.clone().project(this.world.stage.camera);
    const c = this.world.canvas;
    return { x: ((v.x + 1) / 2) * c.clientWidth, y: ((1 - v.y) / 2) * c.clientHeight };
  }

  hexScreen(hexId: number) {
    const h = this.board.hexes[hexId];
    return this.toScreen(new THREE.Vector3(h.x, 0.1, h.z));
  }

  /** Lift and glow every number disc showing `n` (the dice result). */
  /**
   * `s`: the game as it stands, so a hex any blocker stops (the robber, the corsair off a fishing
   * ground, raiders holding it) glows dimly by the engine's own rule, with smoke from that blocker.
   */
  pulseNumber(n: number, s?: GameState) {
    if (this.cancelled) return;
    for (const hex of this.board.hexes) {
      if (!(this.numbersNow.get(hex.id) ?? hex.numbers).includes(n)) continue;
      const tok = this.tokens.get(hex.id);
      if (!tok) continue;
      const blocked = s ? hexBlocked(s, hex.id) : hex.id === this.robberHex;
      // (Of a cluster, only the discs showing the number rolled.)
      tok.pulse(n, blocked ? 0.25 : 0.8, (rise, glow) => {
        this.anim.tween({ duration: 0.7, easing: ease.linear, update: rise, done: () => rise(0) });
        this.anim.tween({ delay: 1.6, duration: 0.9, update: glow });
      });
      if (blocked) this.smokePuff(this.blockerSpot(hex.id), 10);
      else if (!isLand(hex.terrain)) this.grounds?.flurry(hex.id);
    }
  }

  /** White-water spray where a tile breaks the surface. */
  /** A tile breaking the surface: water thrown up and out all round its edge, rings spreading (and, with `sound`, its splash). */
  breach(x: number, z: number, sound = true) {
    waterBurst(this.world.particles.spray, this.world.particles.mist, { x, y: SEA_LEVEL + 0.03, z, count: 42, radius: 0.92, ring: true, up: [0.8, 1.7], out: [0.3, 0.7], size: 0.04 });
    for (let k = 0; k < 3; k++) this.world.wildlife?.addRipple(x, z, 1.05 + k * 0.4, 1.5 + k * 0.45);
    if (sound) sfx.play('splash', { volume: 0.35 });
  }

  /** Sea water running off a freshly risen tile's edges for a moment. */
  drain(x: number, z: number) {
    const spray = this.world.particles.spray;
    let n = 0;
    this.anim.tween({
      duration: 1.2,
      easing: ease.linear,
      update: (t) => {
        for (const want = Math.floor(t * 36); n < want; n++) {
          const a = Math.random() * Math.PI * 2;
          const r = 0.93 + Math.random() * 0.05;
          spray.emit({
            x: x + Math.cos(a) * r,
            y: -0.02 - Math.random() * 0.12,
            z: z + Math.sin(a) * r,
            vx: Math.cos(a) * 0.12,
            vy: -0.15,
            vz: Math.sin(a) * 0.12,
            life: 0.6 + Math.random() * 0.3,
            size: 0.012 + Math.random() * 0.012,
            color: '#e9f4f8',
            alpha: 0.7,
            gravity: 3.2,
            drag: 0.4,
          });
        }
      },
    });
  }

  /** The pieces on show (or their landing) changed since the contact map was last splatted. */
  private contactsDirty = true;
  /** The bridges on the board and their seats: a road meeting its seat's bridge at a corner runs on to it, as it does to another road. */
  private bridges = new Map<number, PlayerId>();
  /** Whether the bridges are on show (false while a resumed game's pieces wait to be revealed). */
  private bridgesShown = true;
  /** The routes that aren't roads (ships, bridges) as the game opened, which the reveal lays roads on across. */
  private crossings = new Map<number, PlayerId>();
  private contactWait = 0;
  private contactMap: ContactMap | null = null;
  /** What each piece last splatted ('v12', 'e40'), and over what box, so only changes are redone. */
  private splatted = new Map<string, ContactSplat>();

  /**
   * Re-splat the ground contact of buildings and roads (those on the ground, not still in the
   * air) when they change: shade under each building and trodden earth round it, and wear at
   * road ends and along kerbs. Only round what changed (the rest of the map is left as it is),
   * and at most a few times a second, as a resumed game's pieces land in quick succession; all
   * at once on a new board's fresh map.
   */
  private refreshContacts(dt: number) {
    const map = this.world.effects.contact;
    this.contactWait -= dt;
    const fresh = map !== this.contactMap;
    if (!fresh && (!this.contactsDirty || this.contactWait > 0)) return;
    this.contactsDirty = false;
    this.contactWait = 0.25;
    this.contactMap = map;
    const want = new Map<string, ContactSplat>();
    for (const [v, r] of this.buildings) {
      if (!r.obj.visible || !r.landed) continue;
      const p = this.vertexPos(v);
      const city = r.kind === 'city';
      const reach = city ? 0.6 : 0.42;
      want.set(`v${v}`, {
        sig: r.kind,
        box: [p.x - reach, p.z - reach, p.x + reach, p.z + reach],
        splat: () => {
          // (Pieces are drawn 1.85× up: a settlement reaches ~0.15 from its vertex, a city ~0.25.)
          map.splat('live', p.x, p.z, city ? 0.32 : 0.22, 0.5, 0);
          map.splat('live', p.x, p.z, reach, 0, 0.9);
        },
      });
    }
    for (const [id, r] of this.roads) {
      if (!r.obj.visible || !r.landed) continue;
      const f = roadFrame(this.board, id);
      const dx = Math.cos(f.angle), dz = Math.sin(f.angle);
      // (A road joined at a corner reaches it: see joinRoads. Wear follows a join once it has formed, or parted.)
      const st = r.obj.userData.joinState as RoadJoinState | undefined;
      const lo = st ? this.settledT(st.minus) : -ROAD_LENGTH / 2, hi = st ? this.settledT(st.plus) : ROAD_LENGTH / 2;
      const join = lo !== -ROAD_LENGTH / 2 || hi !== ROAD_LENGTH / 2;
      const reach = Math.max(-lo, hi);
      const hx = Math.abs(dx) * reach + 0.16, hz = Math.abs(dz) * reach + 0.16;
      want.set(`e${id}`, {
        sig: join ? `road:${lo.toFixed(3)}:${hi.toFixed(3)}` : 'road',
        box: [f.x - hx, f.z - hz, f.x + hx, f.z + hz],
        splat: () => {
          for (const end of [lo, hi]) {
            // (Where it meets another of its seat's, the corner is paved: no worn end there.)
            if (Math.abs(end) > ROAD_LENGTH / 2 + 0.01) continue;
            map.splat('live', f.x + dx * end, f.z + dz * end, 0.16, 0, 0.8);
          }
          for (let u = lo + 0.01; u <= hi - 0.01; u += 0.04) {
            for (const side of [-1, 1]) map.splat('live', f.x + dx * u - dz * side * 0.056, f.z + dz * u + dx * side * 0.056, 0.035, 0.3, 0.25);
          }
        },
      });
    }
    // The boxes round whatever appeared, went or changed.
    const changed: ContactSplat['box'][] = [];
    if (!fresh) {
      for (const [k, w] of want) {
        const had = this.splatted.get(k);
        if (!had || had.sig !== w.sig) changed.push(w.box);
        if (had && had.sig !== w.sig) changed.push(had.box);
      }
      for (const [k, had] of this.splatted) if (!want.has(k)) changed.push(had.box);
      if (!changed.length) return;
    }
    this.splatted = want;
    if (fresh) {
      map.clear('live');
      for (const w of want.values()) w.splat();
    } else {
      for (const b of changed) map.clearBox('live', b[0], b[1], b[2], b[3]);
      const meets = (a: ContactSplat['box'], b: ContactSplat['box']) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
      for (const w of want.values()) if (changed.some((b) => meets(b, w.box))) w.splat();
    }
    map.commit();
  }

  /** Harbours not yet built (before the opening). */
  hideHarbours() {
    this.harbours.setBuilt(false);
  }

  /** Build the harbours around the coast (opening sequence). */
  buildHarbours(): Promise<void> {
    return this.harbours.construct(this.world.animator, (x, z, big) => {
      waterBurst(this.world.particles.spray, this.world.particles.mist, { x, y: SEA_LEVEL + 0.02, z, count: big ? 26 : 16, radius: 0.08, up: [0.5, 1.1], out: [0.2, 0.45], size: 0.03 });
      this.world.wildlife?.addRipple(x, z, big ? 0.35 : 0.25, 1.2);
    });
  }

  /** The harbours go down with the island (leaving a game): see Harbours.submerge. */
  sinkHarbours(gentle = false): Promise<void> {
    return this.harbours.submerge(this.world.animator, gentle, (x, z) => {
      waterBurst(this.world.particles.spray, this.world.particles.mist, { x, y: SEA_LEVEL + 0.02, z, count: 14, radius: 0.07, up: [0.4, 0.9], out: [0.15, 0.35], size: 0.028 });
      this.world.wildlife?.addRipple(x, z, 0.25, 1.1);
    });
  }

  /** Generic production flourish: golden motes rising from the hex (terrain modules add more). */
  produceEffect(hex: number) {
    const h = this.board.hexes[hex];
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.7;
      this.sparkle.emit({
        x: h.x + Math.cos(a) * r,
        y: 0.1 + Math.random() * 0.15,
        z: h.z + Math.sin(a) * r,
        vx: 0,
        vy: 0.35 + Math.random() * 0.45,
        vz: 0,
        life: 1.2 + Math.random() * 0.8,
        size: 0.035 + Math.random() * 0.03,
        grow: 0.4,
        color: '#ffd77a',
        drag: 0.8,
        fadeIn: 0.25,
      });
    }
    this.world.extraProduce?.(hex);
  }

  /** Victory fireworks over the island in every player's colour. */
  fireworks() {
    const colors = this.colors.map((c) => PLAYER_PALETTE[c].light);
    let bursts = 0;
    const fire = () => {
      // (Not over the next game, or the title, once this one is left.)
      if (this.cancelled || bursts++ > 18) return;
      const x = (Math.random() - 0.5) * 7;
      const z = (Math.random() - 0.5) * 6;
      const y = 2.5 + Math.random() * 2;
      const col = colors[bursts % colors.length];
      for (let i = 0; i < 60; i++) {
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const sq = Math.sqrt(1 - u * u);
        const sp = 1.2 + Math.random() * 0.4;
        this.sparkle.emit({ x, y, z, vx: sq * Math.cos(th) * sp, vy: u * sp, vz: sq * Math.sin(th) * sp, life: 1.4 + Math.random() * 0.6, size: 0.07, grow: 0.3, color: col, gravity: 0.8, drag: 1.4 });
      }
      void this.anim.wait(0.35 + Math.random() * 0.4).then(fire);
    };
    fire();
  }

  // ----------------------------------------------------------------- update

  setNight(v: number) {
    piecesNight.value = v;
    this.harbours.setNight(v);
  }

  private chimneyTimer = 0;
  private chimneyTmp = new THREE.Vector3();

  /** Draw every road where its placeholder stands (and as it is scaled), seat by seat. */
  private roadCounts: number[] = [];
  /** Which seats' roads changed this frame (only those go up to the GPU again). */
  private roadChanged: boolean[] = [];

  private writeRoads() {
    const counts = this.roadCounts, changed = this.roadChanged;
    for (let i = 0; i < this.roadMeshes.length; i++) {
      counts[i] = 0;
      changed[i] = false;
    }
    for (const slot of this.roadSlots) {
      if (slot.parent !== this.still) {
        this.roadSlots.delete(slot);
        continue;
      }
      if (!slot.visible) continue;
      const seat = slot.userData.seat as number;
      const mesh = this.roadMeshes[seat];
      if (!mesh || counts[seat] >= ROAD_SLOTS) continue;
      slot.updateMatrix();
      const join = slot.userData.join as RoadJoin | undefined;
      let matrix = join ? this.joinMatrix.multiplyMatrices(slot.matrix, this.joinLocal.makeScale(join.sx, 1, 1).setPosition(join.cx, join.dy, 0)) : slot.matrix;
      // (Being laid: only the stretch paved so far, from the end it started at: see animatePave.)
      const pave = slot.userData.pave as number | undefined;
      let cut = 1;
      if (pave !== undefined && pave < 1) {
        const k = Math.max(1e-3, pave);
        // (The cuts at its ends are shifted along the instance's axis, which this shortens.)
        cut = 1 / k;
        const side = slot.userData.paveFromB ? -1 : 1;
        matrix = this.paveMatrix.multiplyMatrices(matrix, this.paveLocal.makeScale(k, 1, 1).setPosition(side * (-ROAD_LENGTH / 2) * (1 - k), 0, 0));
      }
      const i = counts[seat]++;
      // (Eased in and out as the award changes hands, and settled once it is all but there.)
      const want = this.longest.has(slot.userData.edge as number) ? 1 : 0;
      const was = (slot.userData.glow as number | undefined) ?? 0;
      const g = Math.abs(want - was) < 1e-3 ? want : was + (want - was) * Math.min(1, this.lastDt * 2);
      slot.userData.glow = g;
      if (this.writeRoad(mesh, i, matrix, join, g, cut)) changed[seat] = true;
    }
    for (let i = 0; i < this.roadMeshes.length; i++) {
      const m = this.roadMeshes[i];
      // (Roads lie still nearly all the time: unchanged, nothing is sent again.)
      if (m.count === counts[i] && !changed[i]) continue;
      m.count = counts[i];
      m.instanceMatrix.needsUpdate = true;
      m.geometry.getAttribute('aMitre').needsUpdate = true;
      m.geometry.getAttribute('aGlow').needsUpdate = true;
      m.geometry.getAttribute('aAxis').needsUpdate = true;
    }
  }

  /** Write one road's instance (its matrix, mitred ends, axes and glow); whether anything in it changed. */
  private writeRoad(mesh: THREE.InstancedMesh, i: number, matrix: THREE.Matrix4, join: RoadJoin | undefined, glow: number, cut: number) {
    const me = matrix.elements, mats = mesh.instanceMatrix.array;
    const mitre = mesh.geometry.getAttribute('aMitre') as THREE.InstancedBufferAttribute;
    const axis = mesh.geometry.getAttribute('aAxis') as THREE.InstancedBufferAttribute;
    const glows = mesh.geometry.getAttribute('aGlow') as THREE.InstancedBufferAttribute;
    const m0 = (join?.mitre[0] ?? 0) * cut, m1 = (join?.mitre[1] ?? 0) * cut, m2 = (join?.mitre[2] ?? 0) * cut, m3 = (join?.mitre[3] ?? 0) * cut;
    // (A join still forming sinks its bollards by as much, in the axis' height: see roadMaterial.)
    const sink = me[5] * (join?.sink ?? 1);
    // (Compared as stored, in single precision.)
    let same = glows.array[i] === Math.fround(glow);
    for (let k = 0; same && k < 16; k++) same = mats[i * 16 + k] === Math.fround(me[k]);
    const mt = mitre.array, ax = axis.array;
    same &&= mt[i * 4] === Math.fround(m0) && mt[i * 4 + 1] === Math.fround(m1) && mt[i * 4 + 2] === Math.fround(m2) && mt[i * 4 + 3] === Math.fround(m3);
    same &&= ax[i * 4] === Math.fround(me[0]) && ax[i * 4 + 1] === Math.fround(me[1]) && ax[i * 4 + 2] === Math.fround(me[2]) && ax[i * 4 + 3] === Math.fround(sink);
    if (same) return false;
    mesh.setMatrixAt(i, matrix);
    axis.setXYZW(i, me[0], me[1], me[2], sink);
    mitre.setXYZW(i, m0, m1, m2, m3);
    glows.setX(i, glow);
    return true;
  }

  /** The edges of the longest route, its award holder's (see syncMarks), which shimmer. */
  private longest = new Set<number>();
  private lastDt = 0;

  private joinMatrix = new THREE.Matrix4();
  private paveMatrix = new THREE.Matrix4();
  private paveLocal = new THREE.Matrix4();
  private joinLocal = new THREE.Matrix4();

  /**
   * Join each seat's roads where they meet at a corner with no building on it: a lone road stops
   * short of both corners (leaving room for a house), but two or three of one seat's meeting at an
   * empty corner run on to where their lines cross and are cut on the mitre there, so they read as
   * one road turning or forking. Another seat's road, a building, or a road still in the air keeps
   * them apart. (Along the coast a road is drawn in toward the land, so the lines cross a little
   * inland of the corner: there the others stop short to meet it.)
   *
   * This works out where each end is to stand; the ends then ease there (see JoinEnd, easeJoins):
   * as a road is paved to its far corner the joins there form over the end of its pave, those at
   * the corner it was laid out from over a short ease, and a join that a house, a bridge or a
   * removed road breaks (or makes) eases away (or in) in the same time. (Roads count from when
   * they are laid out, not once they have landed.)
   */
  private joinRoads() {
    this.joinsDirty = false;
    const snap = this.joinSnap, delay = this.joinDelay;
    this.joinSnap = false;
    this.joinDelay = 0;
    const at = new Map<string, number[]>();
    for (const [e, r] of this.roads) {
      if (!r.obj.visible) continue;
      const edge = this.board.edges[e];
      for (const v of [edge.a, edge.b]) {
        if (this.buildings.has(v)) continue;
        const key = `${v}:${r.owner}`;
        const list = at.get(key);
        if (list) list.push(e);
        else at.set(key, [e]);
      }
    }
    // A bridge joins its seat's roads at its corners too (it spans its edge to them: works.ts makeBridge).
    for (const [e, owner] of this.bridges) {
      const edge = this.board.edges[e];
      for (const v of [edge.a, edge.b]) {
        if (this.buildings.has(v)) continue;
        at.get(`${v}:${owner}`)?.push(e);
      }
    }
    const half = ROAD_LENGTH / 2;
    type End = { t: number; k: (number | undefined)[]; x: number; z: number; drv: THREE.Object3D | null };
    const ends = new Map<number, { plus?: End; minus?: End }>();
    for (const [key, edges] of at) {
      if (edges.length < 2) continue;
      const v = Number(key.split(':')[0]);
      // (Only the roads are cut and stretched; a bridge is a line the crossing is taken over.)
      if (!edges.some((e) => this.roads.has(e))) continue;
      // A road being paved to this corner (from its other end) carries the joins here as it arrives.
      let drv: THREE.Object3D | null = null, behind = 1;
      for (const e of edges) {
        const o = this.roads.get(e)?.obj;
        const pave = o?.userData.pave as number | undefined;
        if (!o || pave === undefined || pave >= 1 || o.userData.paveFrom === v) continue;
        const ramp = paveRamp(pave);
        if (ramp < behind) [drv, behind] = [o, ramp];
      }
      const lines = edges.map((e) => {
        const f = this.bridges.has(e) ? edgeFrame(this.board, e) : roadFrame(this.board, e);
        const dx = Math.cos(f.angle), dz = Math.sin(f.angle);
        // Pointing away from the corner along the road.
        const away = this.board.edges[e].b === v ? -1 : 1;
        return { e, x: f.x, z: f.z, dx, dz, ux: dx * away, uz: dz * away, plus: away < 0 };
      });
      // Where the lines come nearest to crossing (least squares: exact for two, and for three
      // that meet, as they do at a corner of the coast).
      let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      for (const l of lines) {
        const m11 = 1 - l.dx * l.dx, m12 = -l.dx * l.dz, m22 = 1 - l.dz * l.dz;
        a11 += m11;
        a12 += m12;
        a22 += m22;
        b1 += m11 * l.x + m12 * l.z;
        b2 += m12 * l.x + m22 * l.z;
      }
      const det = a11 * a22 - a12 * a12;
      if (Math.abs(det) < 1e-6) continue;
      const jx = (a22 * b1 - a12 * b2) / det, jz = (a11 * b2 - a12 * b1) / det;
      for (const l of lines) {
        if (!this.roads.has(l.e)) continue;
        const t = (jx - l.x) * l.dx + (jz - l.z) * l.dz;
        // (A crossing far from where this road would end is no corner of it.)
        if (Math.abs(t) < half || Math.abs(t) > 0.62) continue;
        const k: (number | undefined)[] = [undefined, undefined];
        for (const n of lines) {
          if (n === l) continue;
          // The mitre: the line through the crossing that halves the angle between the two roads,
          // as x shifted per unit of z across this one (z: its left, as the instance turns it).
          let bx = l.ux + n.ux, bz = l.uz + n.uz;
          const bl = Math.hypot(bx, bz) || 1;
          bx /= bl;
          bz /= bl;
          const along = bx * l.dx + bz * l.dz, across = -bx * l.dz + bz * l.dx;
          if (Math.abs(across) < 1e-3) continue;
          k[across > 0 ? 0 : 1] = along / across;
        }
        if (k[0] === undefined && k[1] === undefined) continue;
        // A side with no road beside it carries the same cut straight on (the outside of a bend).
        k[0] ??= k[1];
        k[1] ??= k[0];
        const rec = ends.get(l.e) ?? {};
        rec[l.plus ? 'plus' : 'minus'] = { t, k, x: jx, z: jz, drv };
        ends.set(l.e, rec);
      }
    }
    // Each road's ends to where they are now to stand (a road not on show, or no longer joined, to where it stops short).
    const batches = new Map<string, { retract: boolean; ends: JoinEnd[]; gens: number[] }>();
    for (const [e, r] of this.roads) {
      const obj = r.obj;
      let st = obj.userData.joinState as RoadJoinState | undefined;
      if (!obj.visible) {
        // (Laid out later: it joins as it is.)
        if (st) {
          this.settleJoin(st, false);
          obj.userData.join = undefined;
          this.joining.delete(obj);
        }
        continue;
      }
      const want = ends.get(e);
      if (!st && !want) continue;
      st ??= { plus: joinEnd(half), minus: joinEnd(-half), out: { cx: 0, sx: 1, dy: 0, mitre: [0, 0, 0, 0], sink: 0 } };
      obj.userData.joinState = st;
      // Raised to clear the ground at the corners it now reaches (it lies flat, as every road does).
      const y0 = (obj.userData.y as number | undefined) ?? obj.position.y;
      this.retarget(st.plus, want?.plus, y0, snap, batches);
      this.retarget(st.minus, want?.minus, y0, snap, batches);
      if (this.applyJoin(obj, st)) this.joining.add(obj);
    }
    // (One tween for the ends that start together; an end given a newer target since is left alone.)
    for (const batch of batches.values()) {
      const { ends: list, gens } = batch;
      void this.anim.tween({
        duration: batch.retract ? JOIN_OUT : JOIN_IN,
        delay: batch.retract ? 0 : delay,
        easing: batch.retract ? ease.inOutCubic : ease.outCubic,
        update: (t) => {
          for (let i = 0; i < list.length; i++) if (list[i].gen === gens[i]) list[i].q = t;
        },
      }).promise;
    }
  }

  /**
   * Set an end to ease to where `want` puts it (or, with none, back to where it stops short):
   * from where it stands now, at once if the join is set (snap), with the road being paved to the
   * corner, or in a tween of its own (collected in `batches`).
   */
  private retarget(end: JoinEnd, want: { t: number; k: (number | undefined)[]; x: number; z: number; drv: THREE.Object3D | null } | undefined, y0: number, snap: boolean, batches: Map<string, { retract: boolean; ends: JoinEnd[]; gens: number[] }>) {
    const b = end.b;
    const k0 = (want?.k[0] ?? 0), k1 = (want?.k[1] ?? 0);
    if (want ? b.amt === 1 && Math.abs(b.t - want.t) < 1e-6 && Math.abs(b.k0 - k0) < 1e-6 && Math.abs(b.k1 - k1) < 1e-6 : b.amt === 0) return;
    // Start from where it stands.
    const a = end.a, q = end.q;
    a.t = lerpTo(a.t, b.t, q);
    a.k0 = lerpTo(a.k0, b.k0, q);
    a.k1 = lerpTo(a.k1, b.k1, q);
    a.dy = lerpTo(a.dy, b.dy, q);
    a.amt = lerpTo(a.amt, b.amt, q);
    if (want) {
      b.t = want.t;
      b.k0 = k0;
      b.k1 = k1;
      b.dy = Math.max(0, this.groundY(want.x, want.z) + 0.002 - y0);
      b.amt = 1;
    } else {
      b.t = end.rest;
      b.k0 = b.k1 = b.dy = b.amt = 0;
    }
    end.q = 0;
    end.gen++;
    end.drv = null;
    if (want?.drv) {
      const ramp = paveRamp(want.drv.userData.pave as number | undefined);
      if (ramp < 1) {
        end.drv = want.drv;
        end.r0 = ramp;
        return;
      }
    }
    if (snap) {
      Object.assign(a, b);
      end.q = 1;
      return;
    }
    const retract = !want;
    const key = retract ? 'out' : 'in';
    let batch = batches.get(key);
    if (!batch) batches.set(key, (batch = { retract, ends: [], gens: [] }));
    batch.ends.push(end);
    batch.gens.push(end.gen);
  }

  /** An end's place along its edge as the ground under it was last left (the new shape once it has formed). */
  private settledT(end: JoinEnd) {
    return end.q >= 1 ? end.b.t : end.a.t;
  }

  /** Put every end of a road at where it is to stand (or, `join`, leave its target to be eased to). */
  private settleJoin(st: RoadJoinState, join: boolean) {
    for (const end of [st.plus, st.minus]) {
      if (!join) {
        end.b.t = end.rest;
        end.b.k0 = end.b.k1 = end.b.dy = end.b.amt = 0;
      }
      Object.assign(end.a, end.b);
      end.q = 1;
      end.drv = null;
      end.gen++;
    }
  }

  /** Roads whose joins are still forming or parting (see JoinEnd). */
  private joining = new Set<THREE.Object3D>();
  /** The roads' joins are to be worked out again (a road, house or bridge came or went). */
  private joinsDirty = true;
  /** The change in hand is made without animation: ends take their places at once. */
  private joinSnap = false;
  /** Seconds the ends held off before running on to a corner what was just cleared. */
  private joinDelay = 0;

  /** Where a road's ends stand now, written to its join (for writeRoads); whether it is still moving. */
  private applyJoin(obj: THREE.Object3D, st: RoadJoinState): boolean {
    const P = st.plus, M = st.minus, out = st.out, m = out.mitre;
    const hi = lerpTo(P.a.t, P.b.t, P.q), lo = lerpTo(M.a.t, M.b.t, M.q);
    const sx = (hi - lo) / ROAD_LENGTH;
    out.cx = (hi + lo) / 2;
    out.sx = sx;
    out.dy = Math.max(lerpTo(P.a.dy, P.b.dy, P.q), lerpTo(M.a.dy, M.b.dy, M.q));
    m[0] = lerpTo(P.a.k0, P.b.k0, P.q) / sx;
    m[1] = lerpTo(P.a.k1, P.b.k1, P.q) / sx;
    m[2] = lerpTo(M.a.k0, M.b.k0, M.q) / sx;
    m[3] = lerpTo(M.a.k1, M.b.k1, M.q) / sx;
    out.sink = Math.max(lerpTo(P.a.amt, P.b.amt, P.q), lerpTo(M.a.amt, M.b.amt, M.q));
    // (A road with neither end joined is drawn as every lone one is.)
    obj.userData.join = out.sink > 0 || P.q < 1 || M.q < 1 ? out : undefined;
    return P.q < 1 || M.q < 1;
  }

  /**
   * Ease the roads' joins on a frame: an end whose road is being paved up to its corner follows
   * that pave (on from where it had got), the rest their tweens; each road is drawn as it now stands,
   * and settled once all its ends are there (when the ground's wear there is redone).
   */
  private easeJoins() {
    if (!this.joining.size) return;
    for (const obj of this.joining) {
      const edge = obj.userData.edge as number;
      const st = obj.userData.joinState as RoadJoinState | undefined;
      if (!st || this.roads.get(edge)?.obj !== obj) {
        this.joining.delete(obj);
        continue;
      }
      this.driveEnd(st.plus);
      this.driveEnd(st.minus);
      if (this.applyJoin(obj, st)) continue;
      this.joining.delete(obj);
      this.settleJoin(st, true);
      this.contactsDirty = true;
    }
  }

  /** An end eased by a road being paved to its corner: as far as that has got, and no further back. */
  private driveEnd(end: JoinEnd) {
    const drv = end.drv;
    if (!drv) return;
    // (A road taken away mid-way leaves its joins done.)
    const live = this.roads.get(drv.userData.edge as number)?.obj === drv;
    const ramp = live ? paveRamp(drv.userData.pave as number | undefined) : 1;
    const q = end.r0 >= 1 ? 1 : (ramp - end.r0) / (1 - end.r0);
    if (q > end.q) end.q = Math.min(1, q);
    if (end.q >= 1) {
      end.q = 1;
      end.drv = null;
    }
  }

  private update(dt: number, t: number) {
    this.anim.speed = this.world.animator.speed;
    this.anim.tick(dt);
    this.lastDt = dt;
    if (this.joinsDirty) this.joinRoads();
    this.easeJoins();
    this.writeRoads();
    this.markerTime.value = t;
    this.harbours.update(dt, t);
    // (The travellers keep to the light and the weather: see Travellers.ambient.)
    this.travellers.ambient.night = piecesNight.value;
    this.travellers.ambient.rain = this.world.weather.rain.value;
    this.travellers.update(dt, t);
    this.marks?.update(dt, t);
    this.grounds?.update(dt, t);
    this.refreshContacts(dt);
    this.updateBlight(dt);
    if (this.crowsDue && this.robber.visible && !this.cancelled) this.crows(this.robberHex);
    this.crowFlock.update(dt, t);
    // Thin wood smoke curling from the chimneys of settlements and cities.
    this.chimneyTimer -= dt;
    if (this.chimneyTimer <= 0 && this.buildings.size) {
      this.chimneyTimer = 0.9 / Math.max(1, this.buildings.size);
      let pick = Math.floor(Math.random() * this.buildings.size);
      let rec: PieceRec | null = null;
      for (const r of this.buildings.values()) if (pick-- === 0) rec = r;
      if (rec && !this.sunk && rec.obj.visible && rec.obj.scale.x > PIECE_SCALE * 0.9) {
        const p = rec.kind === 'city' ? this.chimneyTmp.set(-0.06, 0.16, 0) : this.chimneyTmp.set(0.031, 0.143, -0.02);
        rec.obj.localToWorld(p);
        this.smoke.emit({
          x: p.x,
          y: p.y,
          z: p.z,
          vx: (Math.random() - 0.5) * 0.015,
          vy: 0.07 + Math.random() * 0.03,
          vz: (Math.random() - 0.5) * 0.015,
          life: 3 + Math.random() * 1.2,
          size: 0.018,
          grow: 4.5,
          color: '#d9d4cc',
          alpha: 0.32,
          drag: 0.15,
          fadeIn: 0.2,
        });
      }
    }
    // Robber idles with a slow menacing sway.
    this.robber.rotation.z = Math.sin(t * 0.8) * 0.02;
  }

  /** The view has been left (sinking with the island, or disposed): nothing new may start. */
  get cancelled() {
    return this.disposed || this.sunk;
  }

  /**
   * Bring the expansions' pieces up to date with `s` (after every move the presenter shows, and
   * as it stages a move of theirs): see ModuleMarks.sync for the modes. Resolves when they're done.
   */
  syncMarks(s: GameState, mode: MarksMode = 'soft'): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const done = this.marks?.sync(s, mode) ?? Promise.resolve();
    this.syncNumbers(s);
    // (A bridge's corners are joints for its seat's roads: see joinRoads.)
    const bridges = new Map<number, PlayerId>();
    s.routes.forEach((r, e) => r?.kind === 'bridge' && bridges.set(e, r.owner));
    if (bridges.size !== this.bridges.size || [...bridges].some(([e, o]) => this.bridges.get(e) !== o)) {
      // (The roads run on to a new bridge once it has risen, and part from one as it goes.)
      const built = [...bridges.keys()].some((e) => !this.bridges.has(e));
      this.bridges = bridges;
      this.contactsDirty = true;
      this.joinsDirty = true;
      if (mode === 'none') this.joinSnap = true;
      else if (built) this.joinDelay = Math.max(this.joinDelay, BRIDGE_JOIN_DELAY);
    }
    const holder = s.longestRoadHolder;
    this.longest = new Set(holder === null ? [] : longestRoadEdges(s, holder).filter((e) => s.routes[e]?.kind === 'road'));
    return done;
  }

  /** Where the raider fleet's leading longship is, or null without one. */
  fleetFocus(s: GameState) {
    return this.marks?.fleetFocus(s) ?? null;
  }

  /** How many of a hex's discs show (pollution takes numbers away). */
  discsShown(hex: number): number {
    return (this.numbersNow.get(hex) ?? this.board.hexes[hex].numbers).length;
  }

  /** Whether a hex's disc shows (pollution can take every number a hex had). */
  discShown(hex: number): boolean {
    return (this.numbersNow.get(hex) ?? this.board.hexes[hex].numbers).length > 0;
  }

  /**
   * Reprint the discs whose numbers have changed: a resurvey swaps them, and pollution takes them
   * away for good (a disc with no number left is lifted off the board).
   */
  private syncNumbers(s: GameState) {
    if (!s.options.modules.length) return;
    for (const hex of s.board.hexes) {
      const tok = this.tokens.get(hex.id);
      if (!tok) continue;
      const now = numbersOf(s, hex);
      const was = this.numbersNow.get(hex.id) ?? hex.numbers;
      if (now.length === was.length && now.every((k, i) => k === was[i])) continue;
      this.numbersNow.set(hex.id, now);
      if (now.length) tok.setNumbers(now);
      tok.group.visible = now.length > 0;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.anim.cancelAll();
    if (this.world.boardView === this) this.world.boardView = null;
    this.unsub();
    this.group.removeFromParent();
    this.tokenFactory.dispose();
    this.grounds?.dispose();
    this.marks?.dispose();
    this.harbours.dispose();
    this.travellers.dispose();
    this.crowFlock.dispose();
    for (const h of this.headlands.values()) h.geos.forEach((g) => g.dispose());
    this.headlands.clear();
    this.vertexMarkers.dispose();
    this.edgeMarkers.dispose();
    this.hexMarkers?.dispose();
    for (const m of this.roadMeshes) m.dispose();
    this.scaffoldGeo?.dispose();
    this.dropStandIns?.();
    // (Piece geometry, materials and the discs' parts are kept for the next board: see viewParts.)
    release(this.group);
  }
}
