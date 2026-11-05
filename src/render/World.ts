// The 3D world: owns the stage, camera, environment and board, and runs the frame loop.

import * as THREE from 'three/webgpu';
import { isLand, type Board, type GameState, type Terrain } from '../engine';
import { Stage, type Quality } from './core/stage';
import { CameraRig } from './core/cameraRig';
import { Animator } from './util/tween';
import { Noise } from './util/noise';
import { Ocean } from './env/ocean';
import { OceanSim } from './env/oceanSim';
import { ContactMap } from './board/contact';
import { LampLights } from './fx/lampLights';
import type { EventDieResult } from './fx/eventDie';
import { DIE, Dice3D, type DiceSpot } from './fx/dice3d';
import { DiceTotal3D } from './fx/diceTotal';
import { piecesBright } from './board/pieces';
import { cloudCover, cloudDrift, cloudSunDir, withCloudShadows } from './env/clouds';
import { WIND, advanceWind, windStrength } from './env/wind';
import { normalize, positionWorld, cameraPosition } from 'three/tsl';
import { Seagrass } from './env/seagrass';
import { Weather } from './env/weather';
import { sfx } from '../audio/sfx';
import { DETAIL_LAYER, HEX_APOTHEM, buildSdfField, type SdfField, SEA_LEVEL } from './board/layout';
import { TileSet, terrainRings } from './board/tiles';
import { TerrainPool } from './board/terrainPool';
import { TileEffects } from './board/materials';
import { Decor, pieceAnchors, type Reserved } from './board/decor';
import { ParticleSystem, SpriteTextures, waterBurst } from './fx/particles';
import type { LifeContext, LifeModule } from './board/life/common';
import { PastureLife } from './board/life/pasture';
import { FieldsLife } from './board/life/fields';
import { HillsLife } from './board/life/hills';
import { MountainsLife } from './board/life/mountains';
import { CoastLife } from './board/life/coast';
import { ForestLife } from './board/life/forest';
import { ScorchEdges } from './board/life/scorch';
import { Wildlife } from './env/wildlife';
import { DistantScenery, loadScenery } from './env/distant';
import { TimeOfDay, type TimeMode } from './env/timeOfDay';
import type { BoardView } from './board/boardView';
import { spiralOrder } from '../engine/board';
import { ease } from './util/tween';
import { homePose, setBoardFrame } from './core/cameraRig';
import { landHexes } from './board/looks';
import type { FogBank } from './board/fog';
import { hiddenHexes, shownBoard } from './board/fogBoard';
import { loadExpansions, type Expansions } from './loadExpansions';
import type { Disasters } from './board/pollution';
import { PropBatches } from './board/propBatches';
import { release } from './board/release';

const WHITE = new THREE.Color(1, 1, 1);

// Counts additions to any object, so a frame can tell something new joined the scene and give
// its meshes the cloud-shadow hook before they are first drawn. (Added after a mesh has been
// drawn, the hook changes its material and every shader it uses compiles a second time: a
// whole island's worth, frozen for a second, as the game starts.)
let added = 0;
const addChild = THREE.Object3D.prototype.add;
THREE.Object3D.prototype.add = function (this: THREE.Object3D, ...objects: THREE.Object3D[]) {
  added++;
  return addChild.apply(this, objects);
};
const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Low over the sea, looking across to where the island will rise: where the intro sweeps in from. */
const AT_SEA = { yaw: -0.9, pitch: 0.18, distance: 26, target: new THREE.Vector3(0, 0.5, 0), fov: 36, shiftX: 0, shiftY: 0 };
/** The title's view: open sea and the far islands, turning slowly. */
const TITLE_VIEW = { yaw: 0.4, pitch: 0.3, distance: 30, target: new THREE.Vector3(0, 0.5, 0) };

/** The title's view for this screen: on a tall phone, the island's sandbank sits above the menu sheet. */
export const titleView = () => ({ ...TITLE_VIEW, fov: 36, shiftX: 0, shiftY: window.innerWidth < 700 && window.innerHeight > window.innerWidth ? -0.17 * window.innerHeight : 0 });
const lum = (c: THREE.Color) => Math.max(1e-4, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);

/** How long (ms) the island under the flat map goes between frames (see World.coarse). */
const COARSE_MS = 250;
/** A pointy-topped hex's corners from its middle (circumradius 1). */
const HEX_CORNERS: readonly (readonly [number, number])[] = [[0, -1], [HEX_APOTHEM, -0.5], [HEX_APOTHEM, 0.5], [0, 1], [-HEX_APOTHEM, 0.5], [-HEX_APOTHEM, -0.5]];
/** Sent on the window when the board's frame changes (a board built, land found in the fog): the fit follows (app/mapFit.ts). */
export const ISLAND_FRAMED = 'hexplorers:island-framed';

/** Read once per frame from the settings (World has no other link to the UI store). */
let useBrightPieces = () => false;
export function bindBrightPieces(fn: () => boolean) {
  useBrightPieces = fn;
}

export class World {
  stage: Stage;
  rig: CameraRig;
  animator = new Animator();
  effects = new TileEffects();
  /** Lamps that cast real light (High and Ultra). */
  lamps = new LampLights();
  /** The 3D dice, thrown onto the sea beside the island when someone rolls. */
  dice = new Dice3D(this.effects);
  /** The island's middle and the distance to its farthest coast (set with the board). */
  readonly islandCentre = new THREE.Vector3();
  islandRadius = 4.5;
  /** The board's land, as last framed (the editor's draft lends the scenery its own while it's up: see View3D). */
  boardLand: readonly { x: number; z: number }[] = [];
  /**
   * What the home view and the flat map frame (see frameIsland): the bounding box of the land, its
   * harbours and fishing grounds (x0..x1, z0..z1), and the middle of the land's own box (cx, cz).
   */
  islandBox = { x0: -5.25, x1: 5.25, z0: -4.59, z1: 4.59, cx: 0, cz: 0 };
  private diceColor = '#ffffff';
  /** The total over the floating dice. */
  diceTotal = new DiceTotal3D(this.effects);
  /** The roll on its way, shown as a numeral once the dice come to rest. */
  private pendingTotal: { total: number; color: string; speed: number; instant: boolean; event?: EventDieResult } | null = null;
  noise = new Noise(1337);
  /** Builds the terrain of new boards in parallel (its workers started with the first one). */
  readonly terrainPool = typeof Worker === 'undefined' ? null : new TerrainPool();
  private boardGen = 0;
  ocean: Ocean | null = null;
  private oceanSim: OceanSim | null = null;
  weather: Weather;
  seagrass: Seagrass | null = null;
  tiles: TileSet | null = null;
  decor: Decor | null = null;
  sdf: SdfField | null = null;
  boardGroup = new THREE.Group();
  private clock = new THREE.Timer();
  private running = false;
  /** Thunder on its way after a flash (sound is slower than light). */
  private thunder = new Set<ReturnType<typeof setTimeout>>();
  /** Told when the graphics device is lost (nothing more is drawn). */
  onDeviceLost?: (message: string) => void;
  private frameHandlers = new Set<(dt: number, t: number) => void>();
  boardView: BoardView | null = null;
  life: LifeModule[] = [];
  lifeGroup = new THREE.Group();
  /** The life's see-through things, out of its bundle (see LifeContext.glass). */
  glassGroup = new THREE.Group();
  /** The island's life modules' context, and the ground they reserved (kept for a hex found in the fog). */
  lifeCtx: LifeContext | null = null;
  reserved: Reserved = [];
  /** The expansions' render code, loaded with a board that has modules (see render/expansions.ts). */
  ext: Expansions | null = null;
  /** Fog over a sea map's face-down hexes (see board/fog.ts). */
  fog: FogBank | null = null;
  /** Oil's disasters on the island, in a game with oil: pollution and floods (see board/pollution.ts). */
  disasters: Disasters | null = null;
  wildlife: Wildlife | null = null;
  distant: DistantScenery;
  /** The scenery's land and the sea's ripple normals, built on a worker from the start (see init). */
  private scenery = loadScenery();
  private oceanDetail: Uint8Array | null = null;
  time: TimeOfDay;
  particles = {
    dust: new ParticleSystem({ max: 900, style: 'smoke', soft: 0.04, wind: 0.1 }),
    smoke: new ParticleSystem({ max: 1000, style: 'smoke', soft: 0.05, wind: 0.06 }),
    spray: new ParticleSystem({ max: 1600, style: 'droplet', soft: 0.02 }),
    mist: new ParticleSystem({ max: 600, style: 'mist', soft: 0.08, wind: 0.05 }),
    sparkle: new ParticleSystem({ max: 1300, texture: SpriteTextures.spark(), additive: true, wind: 0.03 }),
    soft: new ParticleSystem({ max: 900, texture: SpriteTextures.soft() }),
    leaves: new ParticleSystem({ max: 300, texture: SpriteTextures.leaf(), billboard: false, wind: 0.12 }),
  };
  /** The pools, kept as a list for the frame's walk over them; and those the daylight tints. */
  private pools = Object.values(this.particles);
  private litPools = [this.particles.dust, this.particles.smoke, this.particles.soft, this.particles.leaves, this.particles.spray, this.particles.mist];
  private autoOrbit = false;
  fps = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;

  constructor(
    public canvas: HTMLCanvasElement,
    quality: Quality = 'high',
  ) {
    this.stage = new Stage(canvas, quality);
    this.stage.redraw = () => this.running && this.drawEnabled && !this.compiling && !document.hidden && this.stage.render();
    this.rig = new CameraRig(this.stage.camera, canvas);
    // A glance with motion kept down: the camera stays, and the hex it would have looked at glows.
    this.rig.stillCue = (x, z) => {
      const tile = this.tiles?.tiles.find((t) => Math.hypot(t.hex.x - x, t.hex.z - z) < 0.5);
      if (tile) this.glow(tile.hex.id);
    };
    this.stage.scene.add(this.boardGroup);
    for (const p of Object.values(this.particles)) {
      p.mesh.layers.set(DETAIL_LAYER);
      this.stage.scene.add(p.mesh);
    }
    this.distant = new DistantScenery(this.particles.spray, this.particles.mist, this.stage.fogColorAt(normalize(positionWorld.sub(cameraPosition))), this.lamps, this.stage.fogReach);
    this.stage.scene.add(this.distant.group);
    // (The far islands only change with the weather and the hour: see render/core/bundles.ts. Not
    // the lighthouse, whose beam is drawn see-through after dark, nor the ships coming and going.)
    this.stage.bundles.add(this.distant.land);
    this.time = new TimeOfDay(this.stage);
    this.weather = new Weather(this.stage);
    this.weather.onRain = (level) => sfx.setRain(level);
    this.weather.onThunder = (delay, near) => {
      const t = setTimeout(() => {
        this.thunder.delete(t);
        sfx.play('thunder', { rate: 0.75 + 0.45 * near, volume: 0.5 + 0.7 * near, pan: (Math.random() - 0.5) * 1.2 });
      }, delay * 1000);
      this.thunder.add(t);
    };
    // Sounds from places on the island are placed for the camera: across the screen, and as far
    // off as it frames them (a narrow lens far overhead counts as the usual view's distance).
    const heard = new THREE.Vector3();
    const lens = () => Math.tan((this.stage.camera.fov * Math.PI) / 360) / Math.tan((36 * Math.PI) / 360);
    sfx.setLocate((at) => {
      const cam = this.stage.camera;
      heard.set(at.x, at.y ?? 0, at.z);
      const distance = cam.position.distanceTo(heard) * lens();
      heard.project(cam);
      return { pan: heard.z < 1 ? heard.x : 0, distance };
    });
    this.onFrame((dt) => {
      this.sceneTimer -= dt;
      if (this.sceneTimer > 0) return;
      this.sceneTimer = 0.25;
      sfx.setScene({ height: Math.max(0, this.stage.camera.position.y) * lens(), night: this.time.night.value, wind: clamp01(windStrength.value - 0.6), storm: this.weather.storm });
    });
    // A near bolt rings the sea where it lands and jolts the view.
    this.weather.onStrike = (at, near) => {
      this.wildlife?.addRipple(at.x, at.z, 0.6 + 1.4 * near, 2.4);
      if (near > 0.45 && !this.weather.gentle()) this.rig.addShake(0.014 * near);
    };
    this.stage.scene.add(this.weather.group);
    this.stage.scene.add(this.dice.group);
    this.stage.scene.add(this.diceTotal.mesh);
    this.diceTotal.fx = {
      splash: (x, z, s, seven) => {
        this.dice.fx?.splash(x, z, s, 0, 0);
        // A seven surfaces in a shower of gold and ivory sparks (its numeral's colours: no red).
        if (!seven) return;
        for (let k = 0; k < 46; k++) {
          const a = Math.random() * Math.PI * 2;
          const r = DIE * (0.2 + Math.random() * 0.5);
          this.particles.sparkle.emit({
            x: x + Math.cos(a) * r, y: SEA_LEVEL + DIE * (0.4 + Math.random() * 1.6), z: z + Math.sin(a) * r,
            vx: Math.cos(a) * (0.4 + Math.random() * 0.6), vy: 0.5 + Math.random() * 1.1, vz: Math.sin(a) * (0.4 + Math.random() * 0.6),
            life: 0.8 + Math.random() * 0.8, size: 0.03 + Math.random() * 0.02, color: k % 3 ? '#f0c35a' : '#fff1d2', fadeIn: 0.04, drag: 1.1,
          });
        }
      },
    };
    this.dice.fx = {
      splash: (x, z, s, dx, dz) => {
        // A crown thrown up round the die, a plume from the middle and spray carried on ahead.
        const push: [number, number] = [dx * 0.6, dz * 0.6];
        waterBurst(this.particles.spray, this.particles.mist, { x, y: SEA_LEVEL + 0.02, z, count: Math.round(14 + 28 * s), radius: DIE * 0.42, ring: true, up: [0.6, 1.0 + 1.0 * s], out: [0.25, 0.45 + 0.5 * s], push, size: 0.03 + 0.014 * s });
        waterBurst(this.particles.spray, this.particles.mist, { x, y: SEA_LEVEL + 0.03, z, count: Math.round(6 + 14 * s), radius: DIE * 0.15, up: [1.0 + s, 1.6 + 1.4 * s], out: [0.05, 0.2], push, size: 0.026 + 0.012 * s });
        this.wildlife?.addRipple(x, z, 0.3 + 0.5 * s, 1.3 + 0.7 * s);
        this.wildlife?.addRipple(x, z, 0.6 + 0.6 * s, 2.0 + 0.6 * s);
        const pan = THREE.MathUtils.clamp(_v.set(x, SEA_LEVEL, z).project(this.stage.camera).x * 0.7, -0.8, 0.8);
        sfx.play('splash', { volume: 0.3 + 0.55 * s, rate: 1.2 + Math.random() * 0.25, pan });
      },
      ripple: (x, z, size, life) => this.wildlife?.addRipple(x, z, size, life),
      settled: (points) => {
        // The total rises from the water between the dice.
        if (this.pendingTotal) {
          const mid = points.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(points.length);
          const { total, color, speed, instant, event } = this.pendingTotal;
          this.pendingTotal = null;
          this.diceTotal.show(total, color, mid, speed, instant, event);
        }
        // A shimmer of the roller's colour rises from the dice, and a wider ring spreads.
        for (const p of points) {
          this.wildlife?.addRipple(p.x, p.z, 0.75, 1.7);
          for (let k = 0; k < 18; k++) {
            const a = Math.random() * Math.PI * 2;
            const r = 0.06 + Math.random() * 0.12;
            this.particles.sparkle.emit({
              x: p.x + Math.cos(a) * r, y: p.y + 0.12, z: p.z + Math.sin(a) * r,
              vx: Math.cos(a) * 0.22, vy: 0.3 + Math.random() * 0.45, vz: Math.sin(a) * 0.22,
              life: 0.9 + Math.random() * 0.7, size: 0.026 + Math.random() * 0.014, color: this.diceColor, fadeIn: 0.05, drag: 1.3,
            });
          }
        }
      },
    };
  }

  async init(step?: (label: string, progress: number) => Promise<void>) {
    await this.stage.init(step);
    // The GPU gone (a driver reset, the tab starved of memory): stop drawing and say so.
    this.stage.onDeviceLost = (message) => {
      this.running = false;
      this.stage.renderer.setAnimationLoop(null);
      this.onDeviceLost?.(message);
    };
    // A light breeze with a long, low swell: few whitecaps, plenty of glitter.
    // (Without the GPU wave simulation the sea falls back to its simpler waves.)
    this.oceanSim = await OceanSim.create(this.stage.renderer, { wind: 5.5, windDir: 0.6, swell: 0.35, choppiness: 0.9 }).catch((e) => {
      console.warn('wave simulation unavailable', e);
      return null;
    });
    this.effects.sunDir.value.copy(this.stage.sunDir);
    this.running = true;
    this.stage.renderer.setAnimationLoop((time: number) => this.frame(time));
    // (Built meanwhile on a worker; frames draw nothing before the first precompile anyway.)
    const scenery = await this.scenery;
    this.distant.fill(scenery.plan);
    this.oceanDetail = scenery.detail;
  }

  /**
   * While shaders compile ahead of time (see Stage.precompile), frames update but draw nothing.
   * So too before the first board's precompile: a real frame of the bare scene would build the
   * sky's, clouds' and post-processing's pipelines on the spot, holding the GPU (and the loading
   * screen) for seconds on a first visit. (Counted: precompiles can overlap, and the first to
   * finish mustn't let frames draw while another still compiles.)
   */
  get compiling() {
    return this.bootHold || this.compileHolds > 0;
  }
  private bootHold = true;
  private compileHolds = 0;
  /** Precompiles under way, held or live (their dry frames shouldn't be judged as slow). */
  precompiling = 0;

  /** While a quality change is prepared: the camera holds still too (see session.applyQuality). */
  held = false;
  /** How much faster the camera flies than the clock: INTRO_RUSH while a skipped opening plays out (see session.skipIntro), else 1. */
  introRush = 1;

  /**
   * Off while the map editor covers the island: the game goes on (animations, the camera, the
   * clock) but nothing is drawn, so the GPU rests.
   */
  drawEnabled = true;

  /**
   * Set while the flat 2D map covers the island (app/viewMode.ts): the island is drawn only now and
   * then (`COARSE_MS`), so the GPU mostly rests but the canvas always holds a current frame, which
   * the page can show again at once (a canvas left idle is slow to show its first frame, and one
   * resized while undrawn is cleared).
   */
  coarse = false;
  private lastDrawn = 0;

  /**
   * Compile what the current view needs (and, with `hidden`, what isn't shown yet) before drawing
   * it. With `live`, frames go on being drawn meanwhile: for when everything visible is compiled
   * already and the rest is hidden (a new board, still hidden by setBoard).
   */
  async precompile(progress?: (done: number, total: number) => void, hidden = false, live = false, cancelled?: () => boolean, only?: THREE.Object3D[]) {
    // (Nothing compiled yet, nothing drawn yet: frames wait for this one whatever `live` says.)
    const hold = !live || this.compiling;
    if (hold) this.compileHolds++;
    this.precompiling++;
    this.seenAdded = added;
    this.patchCloudShadows();
    // (The title's board, which has no island, and the dice: see deferIsland.)
    const skip = this.islandDeferred === this.boardGen && !this.warmIsland ? [this.boardGroup, this.dice.group, this.diceTotal.mesh] : undefined;
    try {
      await this.stage.precompile(progress, hidden, cancelled, live, only, skip);
      // (The board's whole island compiled: what is made from here on is warmed before it shows, see warm.)
      if (!only && !skip && !this.warmIsland && !cancelled?.()) this.compiledGen = this.boardGen;
    } finally {
      this.precompiling--;
      if (hold) {
        this.compileHolds--;
        this.bootHold = false;
      }
    }
  }

  /** Run before each frame is drawn (see Stage.beforeDraw): for the board's batches, with compiled and warm. */
  get beforeDraw() {
    return this.stage.beforeDraw;
  }

  /**
   * Whether a throwaway island is up in the hidden board group, built only to fill the GPU's shader
   * cache (see warmBoard). It is never drawn, and the title's sea, sandbank and camera are not
   * touched by it: setBoard's own first steps (sinking, reshaping the sea, framing the island)
   * are what made an earlier attempt visible.
   */
  warmIsland = false;

  /**
   * On the title, build an island for `state` into the board group (hidden, as it is for the title
   * and as a new board is until it rises), without touching anything the title shows, so that a
   * precompile can build every pipeline a game's first board needs while the player is still at
   * the menus. Take it away again with dropWarm. False if a board is up already or it was
   * asked to stop.
   */
  async warmBoard(state: GameState, cancelled: () => boolean) {
    if (this.warmIsland || this.tiles || this.boardView || this.islandDeferred !== this.boardGen || this.ext || state.options.modules.length) return false;
    const gen = this.boardGen;
    const board = shownBoard(state);
    this.warmIsland = true;
    try {
      const tiles = TileSet.create(board, this.effects, this.noise, state.options.seed, this.terrainPool);
      tiles.catch(() => {});
      // (Its terrain on the workers meanwhile: a real board asked for stops this, see buildIsland.)
      await this.buildIsland(gen, state, board, buildSdfField(board), tiles);
      return gen === this.boardGen && !cancelled();
    } catch (e) {
      this.dropWarm();
      throw e;
    }
  }

  /** Compile what the throwaway island (warmBoard) needs, live: the title's frames go on meanwhile. */
  async warmCompile(cancelled: () => boolean) {
    await this.precompile(undefined, true, true, cancelled);
  }

  /** Let go of the throwaway island, leaving the title as it was (a real board's setBoard clears it just the same). */
  dropWarm() {
    if (!this.warmIsland) return;
    this.warmIsland = false;
    this.clearBoard();
    this.sink();
  }

  /** The board whose island has been compiled whole (see precompile). */
  private compiledGen = -1;

  /** Whether the board's island has been compiled whole, so a mesh made now would build its shaders on sight. */
  get compiled() {
    return this.compiledGen === this.boardGen;
  }

  /**
   * Compile `objects` (hidden till then, and shown once done) while frames go on, their shaders
   * built a stage at a time (see Stage.precompile): for meshes made mid-game, which drawn at once
   * would build their shaders in the frame they first show in.
   */
  warm(objects: THREE.Object3D[]): Promise<void> {
    for (const o of objects) o.visible = false;
    // One at a time, and only once no other compile is running (a found hex's, which these often
    // come with): each hides all but what it compiles in its dry frames. Never from inside the
    // frame that asked (its batches are synced as it draws): a dry frame would run within it.
    const run = this.warming.then(async () => {
      const gen = this.boardGen;
      do await new Promise((resolve) => setTimeout(resolve, 0));
      while ((this.precompiling > 0 || this.warmHolds > 0) && gen === this.boardGen);
      if (gen === this.boardGen) await this.precompile(undefined, true, true, () => gen !== this.boardGen, objects);
    });
    this.warming = run.catch(() => {});
    return run.finally(() => {
      for (const o of objects) o.visible = true;
    });
  }

  private warming: Promise<void> = Promise.resolve();
  /** While above 0 (a found hex being readied: see board/fog.ts), warming waits. */
  warmHolds = 0;

  /**
   * Set at start-up, before the title's board: only its sea is the title's (the clear shallows over
   * where an island would wait), so setBoard builds no island for it, and precompiles pass by the
   * board and the dice (first seen in a game). Building and compiling an island under the title's
   * sea, for the first game's shaders, would gain nothing: clearing it for that game's own island
   * lets all of them go (and an instanced mesh's are its own, never shared), so the game builds them
   * all again, while the title stutters for its first seconds at High.
   */
  deferIsland = false;
  /** The board whose island was left out (its boardGen): the title's. */
  private islandDeferred = -1;

  /**
   * Resolves once frames come at an even pace again: the first frames after a board is built
   * compile its shaders and can take seconds.
   */
  settled(timeout = 25000) {
    return new Promise<void>((resolve) => {
      // A hidden tab draws no frames; its shaders compile once it's shown.
      if (document.hidden) return resolve();
      const t0 = performance.now();
      let last = t0;
      let calm = 0;
      const done = () => {
        off();
        clearTimeout(fallback);
        resolve();
      };
      const off = this.onFrame(() => {
        const now = performance.now();
        calm = now - last < 70 ? calm + 1 : 0;
        last = now;
        if (calm >= 5 || now - t0 > timeout) done();
      });
      // (Should frames stop altogether, a lost device or a stopped loop, it resolves all the same.)
      const fallback = setTimeout(done, timeout + 1000);
    });
  }

  onFrame(fn: (dt: number, t: number) => void) {
    this.frameHandlers.add(fn);
    return () => this.frameHandlers.delete(fn);
  }

  /**
   * Start building the island of a game about to begin, its terrain on the workers, before the
   * board is asked for (the set-up page, Continue): setBoard then takes it as it is, or builds
   * afresh for any other board. (Its tiles take seconds, which this overlaps with the set-up.)
   */
  prepareIsland(state: GameState) {
    if (this.terrainPool) TileSet.prepare(shownBoard(state), this.noise, state.options.seed, this.terrainPool);
  }

  /** The terrain's workers started, each warming up on a tile of a different look (see TerrainPool.warm). */
  warmTerrain() {
    const looks: Terrain[] = ['mountains', 'hills', 'forest', 'fields', 'pasture', 'desert'];
    const sides = [true, true, true, true, true, true];
    this.terrainPool?.warm(looks.map((terrain, i) => ({ id: 0, ctx: { terrain, cx: 0, cz: 0, seed: 101 + i, connected: sides.map((_, k) => k % 2 === 0), landSide: sides, discs: 1 }, noiseSeed: this.noise.seed, rings: terrainRings() })));
  }

  /**
   * Build a board, hidden and sunk under the sea until introSequence raises it: shown straight
   * away, its first frame would build all its shaders at once and hold the page, so the caller
   * precompiles it first (frames of the sea go on meanwhile).
   */
  async setBoard(state: GameState, progress?: (f: number) => void) {
    // (A newer board may be asked for while this one is being built: the newest wins.)
    const gen = ++this.boardGen;
    performance.mark('world: board asked');
    // The expansions' pieces, features and terrains come from a chunk of their own, loaded before
    // anything is built (warmed on the set-up page, so this is usually a cache hit).
    // (Kept only if this board is still the one wanted: a newer request may have come meanwhile.)
    const ext = state.options.modules.length ? await loadExpansions() : null;
    if (gen !== this.boardGen) return;
    progress?.(0.05);
    this.ext = ext;
    // The event die, the red die and the badge are the event die rules' alone (the guilds
    // module's): made now, before the game-start precompile, and never for a base game.
    const eventDie = state.options.modules.includes('guilds');
    this.dice.prepare(eventDie);
    this.diceTotal.prepare(eventDie);
    this.boardGroup.visible = false;
    this.warmIsland = false;
    this.clearBoard();
    // Sunk straight away: the title's sandbank then really drops into the deep (the floor under
    // the island goes down with its tiles), and no surf rings a coast that isn't up.
    this.sink();
    if (this.ocean) this.ocean.shoreline.value = 0;
    // (Face-down hexes show as open water: the island gives nothing away. See board/fog.ts.)
    const board = shownBoard(state);
    const sdf = (this.sdf = buildSdfField(board));
    // (The land alone: a map's sea hexes are the ocean's.)
    const land = landHexes(board);
    this.frameIsland(land, board);
    // The terrain goes to the workers straight away, built while the last sandbank drops away.
    // (The title's board has none: see deferIsland. A failure is the island's to report, below.)
    const tiles = this.deferIsland ? null : TileSet.create(board, this.effects, this.noise, state.options.seed, this.terrainPool);
    tiles?.catch(() => {});
    if (!this.ocean) {
      this.ocean = new Ocean({ sdf: this.sdf, sunDir: this.stage.sunDir, sun: this.stage.sun, tiles: land, rise: this.effects.rise, sim: this.oceanSim, detail: this.oceanDetail });
      this.oceanDetail = null;
      this.ocean.setMirror(this.stage.quality.reflections);
      this.seagrass = new Seagrass(this.sdf);
      this.stage.scene.add(this.ocean.mesh, this.ocean.seabed, this.seagrass.mesh);
      this.stage.passOwners.add(this.ocean.mesh);
    } else {
      // (The title's sandbank drops away first, so it isn't reshaped in plain view.)
      await this.shoal(false);
      performance.mark('world: shoal down');
      if (gen !== this.boardGen) {
        void tiles?.then((t) => t.dispose(), () => {});
        return;
      }
      this.ocean.setIsland(this.sdf, land);
      this.seagrass?.place(this.sdf);
    }
    this.ocean.bank.value.set(this.islandCentre.x, this.islandCentre.z, this.islandRadius);
    // A fresh contact map per board (created after the renderer is up; see contact.ts).
    this.effects.contact.dispose();
    this.effects.contact = new ContactMap();
    this.effects.trail.clear();
    if (this.deferIsland) {
      // The title's board: no island (see deferIsland), and so no surf ringing a coast.
      this.deferIsland = false;
      this.islandDeferred = gen;
      this.ocean.shoreline.value = 0;
      this.effects.surf.value = 0;
      return;
    }
    progress?.(0.3);
    await this.buildIsland(gen, state, board, sdf, tiles ?? undefined, progress);
  }

  /**
   * The island of the board setBoard is building (`gen`): its tiles (from `building`, or built
   * here), what grows and lives on them.
   */
  private async buildIsland(gen: number, state: GameState, board: Board, sdf: SdfField, building?: Promise<TileSet>, progress?: (f: number) => void) {
    const tiles = await (building ?? TileSet.create(board, this.effects, this.noise, state.options.seed, this.terrainPool));
    if (gen !== this.boardGen) {
      tiles.dispose();
      return;
    }
    progress?.(0.55);
    this.tiles = tiles;
    this.boardGroup.add(this.tiles.group);
    this.stage.bundles.add(this.tiles.group);
    performance.mark('world: tiles built');
    // The rest is a few hundred milliseconds of building, done in parts so the page keeps drawing
    // (the loading screen, or the title's "Setting sail") in between. The island's life is
    // installed only once it is all built, as frames update it.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
    await pause();
    if (gen !== this.boardGen) return;
    const ctx: LifeContext = {
      tiles: this.tiles,
      effects: this.effects,
      animator: this.animator,
      noise: this.noise,
      group: this.lifeGroup,
      glass: this.glassGroup,
      props: new PropBatches(this.effects, this.lifeGroup, this, (this.stage.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend && !new URLSearchParams(location.search).has('nobatch') ? this.glassGroup : null),
      particles: this.particles,
      now: () => this.effects.now.value,
      quality: this.stage.quality.foliage,
      lamps: this.lamps,
      shake: (a) => this.rig.addShake(a),
      anchors: pieceAnchors(state),
      discsOn: (hex) => this.boardView?.discsShown(hex) ?? Infinity,
    };
    // (The life group is in the scene before its lamps are registered: lamps found outside the
    // scene are let go, see lampLights.ts.)
    this.boardGroup.add(this.lifeGroup, this.glassGroup);
    const life = this.lifeModules(ctx);
    const reserved: Reserved = [...ctx.anchors];
    // The modules' features on the land: rivers in their channels, the oil wells.
    if (this.ext) (life as LifeModule[]).push(new this.ext.RiversLife(ctx), new this.ext.WellsLife(ctx));
    for (const m of life) reserved.push(...m.plan(this.tiles.tiles));
    this.decor = new Decor(this.tiles, this.effects, this.noise, this.stage.quality.foliage, reserved);
    this.boardGroup.add(this.decor.group);
    this.stage.bundles.add(this.decor.group);
    for (const [i, m] of life.entries()) {
      progress?.(0.6 + (0.35 * i) / life.length);
      await pause();
      if (gen !== this.boardGen) {
        // (Its prop batches too: they hook every frame, and clearBoard only reaches a finished board's.)
        for (const x of life) x.dispose();
        ctx.props.dispose();
        return;
      }
      m.build();
    }
    this.life = life;
    this.lifeCtx = ctx;
    this.stage.bundles.add(this.lifeGroup);
    this.reserved = reserved;
    if (this.ext && hiddenHexes(state).length) {
      this.fog = new this.ext.FogBank(this, state);
      await this.fog.prepare(state, () => gen === this.boardGen);
      if (gen !== this.boardGen) return;
    }
    if (this.ext && state.ext.oil) this.disasters = new this.ext.Disasters(this, state);
    this.wildlife = new Wildlife(board, sdf, this.particles.smoke, { x: this.islandCentre.x, z: this.islandCentre.z, radius: this.islandRadius });
    this.wildlife.riseOf = (hex) => this.effects.riseValues[hex] ?? 0;
    this.boardGroup.add(this.wildlife.group);
    this.extraProduce = (hex) => {
      for (const m of this.life) m.produce(hex);
    };
    this.sink();
    performance.mark('world: board built');
  }

  /**
   * The island's middle and reach (the weather's coast, the sea's bank and where the dice land: the
   * centroid of the land and the circle round it), and the camera's frame: the bounding box of
   * what a player should see at home, the land and, from the board, its harbours' signs and its
   * fishing grounds (`islandBox`), which the home view (cameraRig) and the flat map (viewMode) fit
   * by its own shape. A circle fits the classic island, but on a wide archipelago it is set by the
   * farthest corner and leaves most of the window to empty sea.
   */
  frameIsland(land: readonly { x: number; z: number }[], board?: Board) {
    this.boardLand = land;
    this.distant.keepClear(land);
    this.islandCentre.set(0, 0, 0);
    for (const h of land) this.islandCentre.x += h.x / land.length, (this.islandCentre.z += h.z / land.length);
    this.islandRadius = Math.max(...land.map((h) => Math.hypot(h.x - this.islandCentre.x, h.z - this.islandCentre.z))) + 1.15;
    this.weather.coast = this.islandRadius;
    this.weather.centre.set(this.islandCentre.x, this.islandCentre.z);
    // The land's box, to its tiles' corners (pointy-topped hexes of circumradius 1).
    const box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    // The same things as points too, for the home view (a tilted board's extent isn't its box's).
    const points: number[] = [];
    const add = (x: number, z: number, rx: number, rz = rx) => {
      box.x0 = Math.min(box.x0, x - rx);
      box.x1 = Math.max(box.x1, x + rx);
      box.z0 = Math.min(box.z0, z - rz);
      box.z1 = Math.max(box.z1, z + rz);
    };
    for (const h of land) {
      add(h.x, h.z, HEX_APOTHEM, 1);
      for (const [dx, dz] of HEX_CORNERS) points.push(h.x + dx, h.z + dz);
    }
    const cx = (box.x0 + box.x1) / 2, cz = (box.z0 + box.z1) / 2;
    if (board) {
      const shown = new Set(land.map((h) => `${h.x},${h.z}`));
      // A harbour's sign stands out from the middle of its coast edge (as the flat map's badge does).
      for (const port of board.ports) {
        const h = board.hexes[port.hex];
        if (!shown.has(`${h.x},${h.z}`)) continue;
        const [a, b] = port.vertices.map((v) => board.vertices[v]);
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const l = Math.hypot(mx - h.x, mz - h.z) || 1;
        const sx = mx + ((mx - h.x) / l) * 0.62, sz = mz + ((mz - h.z) / l) * 0.62;
        add(sx, sz, 0.3);
        points.push(sx - 0.3, sz - 0.3, sx + 0.3, sz - 0.3, sx - 0.3, sz + 0.3, sx + 0.3, sz + 0.3);
      }
      // A fishing ground's net ring round its disc, out on the water.
      for (const h of board.hexes) {
        if (isLand(h.terrain) || h.numbers.length === 0) continue;
        add(h.x, h.z, 0.75);
        for (let i = 0; i < 8; i++) points.push(h.x + Math.cos((i * Math.PI) / 4) * 0.75, h.z + Math.sin((i * Math.PI) / 4) * 0.75);
      }
    }
    this.islandBox = { ...box, cx, cz };
    // (Aimed at the middle of the land: the classic island's harbours lean east, and its home view
    // looks at its middle.)
    setBoardFrame(cx, cz, Math.max(...land.map((h) => Math.hypot(h.x - cx, h.z - cz))) + 1.15, points);
    // The fit of the map and the home view follows the board: the HUD's side of it is app/mapFit.ts.
    window.dispatchEvent(new Event(ISLAND_FRAMED));
  }

  /**
   * Called just before the opening's flight to the home view, for the app to measure the HUD's
   * panels (set by app/mapFit.ts; the home view is fitted to what they leave).
   */
  measureHome: () => void = () => {};

  /**
   * The island's life, one module per kind of terrain and its coast. (The coast's is in a group of
   * its own, so it can be rebuilt alone round a hex found in the fog: see board/fog.ts.)
   */
  lifeModules(ctx: LifeContext): LifeModule[] {
    const coast = new THREE.Group();
    coast.name = 'coast';
    ctx.group.add(coast);
    const coastCtx = Object.assign(Object.create(ctx) as LifeContext, { group: coast });
    const base = [new PastureLife(ctx, () => this.decor), new FieldsLife(ctx), new HillsLife(ctx), new MountainsLife(ctx), new ForestLife(ctx, () => this.decor), new CoastLife(coastCtx)];
    // (The expansions' terrains only come with a board that has modules, whose chunk is loaded.)
    const ext = this.ext;
    const added = ext ? [new ext.BountyLife(ctx), new ext.SwampLife(ctx), new ext.LakeLife(ctx), new ext.OasisLife(ctx), new ext.CastleLife(ctx)] : [];
    return [...base, ...added, new ScorchEdges(ctx)];
  }

  clearBoard() {
    this.fog?.dispose();
    this.fog = null;
    this.disasters?.dispose();
    this.disasters = null;
    this.lifeCtx?.props.dispose();
    this.lifeCtx = null;
    this.reserved = [];
    this.tiles?.dispose();
    this.decor?.dispose();
    this.decor = null;
    for (const m of this.life) m.dispose();
    this.life = [];
    this.lifeGroup.clear();
    // (The renderer forgets them only when told: see release.ts. The modules release the life's
    // group they share, and its see-through things are here.)
    release(this.glassGroup);
    this.glassGroup.clear();
    this.wildlife?.dispose();
    this.wildlife = null;
    for (const p of Object.values(this.particles)) p.clear();
    for (let i = 0; i < this.effects.values.length; i++) {
      this.effects.values[i].set(0, 0, 0, -100);
      this.effects.riseValues[i] = 0;
      this.effects.dryValues[i] = -1000;
    }
    this.boardView = null;
    this.tiles = null;
    this.fireflyTiles = null;
    this.boardGroup.clear();
    // Dice still rolling, and a total still to rise, belonged to the old game.
    this.pendingTotal = null;
    this.diceTotal.hide();
    this.dice.group.visible = false;
  }

  private cloudPatchFrame = 0;
  private seenAdded = -1;
  private lightTint = new THREE.Color();
  private skyTint = new THREE.Color();

  /** Give every shadow-receiving material the cloud-shadow hook (new ones appear as pieces are built). */
  private patchCloudShadows() {
    this.stage.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.receiveShadow) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) withCloudShadows(mat);
    });
  }

  /** CPU time of the last frame's work (updates and render submission), in ms. */
  frameMs = 0;

  /** When the last frame ran (for the lighter presets' 60-a-second cap, and the title's 30). */
  private lastFrameAt = 0;
  /** The last refresh, the screen's refresh period (ms, see frame), and when the next frame is due on a 90 Hz screen (see QualitySettings.cap60At90). */
  private lastVsync = 0;
  refreshMs = 1000 / 60;
  private gaps = new Float32Array(32);
  private sorted = new Float32Array(32);
  private gapAt = 0;
  private dueAt = 0;
  /** Whether frames are drawn two refreshes in three, on a 90 Hz screen (see QualitySettings.cap60At90): every other gap is then two refreshes long. */
  pacedAt90 = false;

  /** Set by the app while the title's menu is up (see bootstrap): its frames may be held back (see idling). */
  titleIdle = false;

  /**
   * Whether frames are held to 30 a second: on the title, while the sea only turns slowly behind
   * the menu (never in a flight, which wants every frame). The GPU, and a game being set up under
   * it, has the rest. (Frame times then say nothing about the device: see autoQuality.)
   */
  get idling() {
    return this.titleIdle && this.autoOrbit && !this.rig.flying;
  }

  private frame(vsync?: number) {
    if (!this.running) return;
    const started = performance.now();
    // Every other refresh on a 120 Hz screen (one at 144 Hz runs about 72): a refresh under 10 ms
    // since the last frame is skipped, which leaves 60 to 90 Hz screens alone; on the idle title,
    // every refresh under 29 ms since (every other at 60 Hz, every fourth at 120 Hz). (Timed by
    // the refreshes themselves, which are even, rather than by when the callback happens to run;
    // the clock keeps going, so the frame drawn takes the skipped one's time with it.)
    const at = vsync ?? started;
    // The screen's refresh, as the refreshes come: the shorter end (a quarter of the way up) of the
    // last 32 gaps between them, so frames too slow for every refresh don't read as a slower
    // screen, and a phone that changes its rate is followed within half a second or so. (With a
    // margin each way, so a rate on the edge doesn't flip the pacing on and off.)
    const raw = at - this.lastVsync;
    this.lastVsync = at;
    if (raw > 4 && raw < 40) {
      this.gaps[this.gapAt++ % this.gaps.length] = raw;
      if (this.gapAt % 8 === 0 && this.gapAt >= this.gaps.length) {
        this.sorted.set(this.gaps);
        this.refreshMs = this.sorted.sort()[this.gaps.length >> 2];
      }
    }
    const q = this.stage.quality;
    const r = this.refreshMs, was = this.pacedAt90;
    this.pacedAt90 = !this.idling && q.cap60 && q.cap60At90 && (was ? r > 10 && r < 15.5 : r > 10.5 && r < 14.5);
    if (this.pacedAt90) {
      // On a 90 Hz screen (see QualitySettings.cap60At90): a frame is due every 60th of a second,
      // drawn at the first refresh that reaches it (less a little, for the refreshes' jitter).
      if (at < this.dueAt - 2 && at >= this.lastFrameAt) return;
      // (After a stall the count starts again, rather than drawing the missed frames back to back.)
      this.dueAt = at - this.dueAt > 1000 / 60 ? at + 1000 / 60 : this.dueAt + 1000 / 60;
    } else {
      const gap = this.idling ? 29 : q.cap60 ? 10 : 0;
      if (gap && at - this.lastFrameAt < gap && at >= this.lastFrameAt) return;
      this.dueAt = at + 1000 / 60;
    }
    this.lastFrameAt = at;
    this.clock.update();
    // (Animation keeps time down to ten frames a second; only a longer stall, a shader built on
    // sight, holds it back. At 20 it ran slow: Firefox's first game at 20 to 10 frames a second
    // stretched the island's 6.7 s rise to 17.7 s, all of it waited out before play.)
    const dt = Math.min(0.1, this.clock.getDelta());
    const t = this.clock.getElapsed();
    this.effects.now.value = t;
    this.animator.tick(dt);
    this.rig.update(this.held ? 0 : dt * this.introRush);
    const p = this.rig.pose;
    // Far overhead (the flat view and the flight to it) the fog keeps its usual reach from the island.
    this.stage.fogLift = Math.max(0, p.distance - 40);
    this.stage.focus.value = p.distance;
    this.stage.focalRange.value = Math.max(6, p.distance * 1.45);
    this.stage.setBokehScale(0.35 + 0.65 * THREE.MathUtils.smoothstep(p.distance, 2, 10));
    // (Never under the flat map: its camera is locked overhead, north up.) Slowly: once round in
    // about five minutes.
    if (this.autoOrbit && !this.rig.locked) this.rig.goal.yaw += dt * 0.021;
    this.time.update(dt);
    const night = this.time.night.value;
    // Weather scales the time-of-day light, so it runs right after it.
    this.weather.update(dt, night);
    this.effects.wet.value = this.weather.wet.value;
    this.effects.night.value = night;
    // Bright pieces ease in and out rather than snapping.
    piecesBright.value += ((useBrightPieces() ? 1 : 0) - piecesBright.value) * Math.min(1, dt * 6);
    this.effects.rain.value = this.weather.rain.value;
    this.effects.season.value += (this.seasonTarget - this.effects.season.value) * Math.min(1, dt * 0.4);
    // Puddles fill through a shower and drain slowly once it stops.
    const pd = this.effects.puddles;
    pd.value = THREE.MathUtils.clamp(pd.value + dt * (this.weather.rain.value > 0.2 ? 0.03 * this.weather.rain.value * this.weather.pace : -0.012 * this.weather.dryPace), 0, 1);
    advanceWind(dt, 1 + 0.9 * this.weather.overcast + 0.9 * this.weather.storm);
    // Cloud shadows drift downwind (the shade samples the cloud field at p + drift, so the
    // drift runs against the wind); more cloud when the weather closes in.
    cloudDrift.value.x -= dt * 0.34 * windStrength.value * WIND.x;
    cloudDrift.value.y -= dt * 0.34 * windStrength.value * WIND.y;
    cloudCover.value = 0.32 + 0.6 * this.weather.overcast;
    cloudSunDir.value.copy(this.stage.sunDir);
    if (this.ocean && this.tiles) {
      // Surf rings the coast only once every tile is up: until then the final coastline would
      // draw a line of foam across open water in front of the tiles still rising.
      let low = 0;
      for (const t of this.tiles.tiles) if (!this.tiles.pending.has(t.hex.id)) low = Math.min(low, this.effects.riseValues[t.hex.id]);
      this.ocean.shoreline.value = THREE.MathUtils.smoothstep(low, -0.6, -0.05);
      this.effects.surf.value = this.ocean.shoreline.value;
    }
    if (this.ocean) {
      this.ocean.rain.value = this.weather.rain.value;
      this.ocean.chop.value = 1 + 0.35 * this.weather.overcast;
    }
    this.effects.sunDir.value.copy(this.stage.sunDir);
    this.effects.sunTint.value.copy(this.stage.sun.color).multiplyScalar((this.stage.sun.intensity / 3.3) * (1 - night));
    // The colour of the light on the scene (the sun's and the sky's, more sky under cloud), at
    // unit luminance: smoke, dust and spray are unlit sprites and the sea's body is self-lit,
    // so both take it on to stay in step with the land (golden at sunset, cool at night).
    const tint = this.lightTint.copy(this.stage.sun.color).multiplyScalar(1 / lum(this.stage.sun.color));
    const sky = this.skyTint.copy(this.stage.hemi.color).multiplyScalar(1 / lum(this.stage.hemi.color));
    tint.lerp(sky, 1 - 0.55 * (1 - 0.6 * this.weather.overcast));
    tint.multiplyScalar(1 / lum(tint));
    // (At night the sea already takes its own moonlit blue; the tint would only deepen it.)
    if (this.ocean) this.ocean.lightTint.value.copy(tint).lerp(WHITE, 0.8 * night);
    const dim = 1 - 0.72 * night;
    for (const p of this.litPools)
      p.light.value.setRGB(1, 1, 1).lerp(tint, 0.7).multiplyScalar(dim);
    this.ocean?.sunDir.value.copy(this.stage.sunDir);
    this.ocean?.sunColor.value.copy(this.stage.sun.color);
    // Under cloud the sea turns greyer and darker.
    if (this.ocean) {
      this.ocean.daylight.value = (1 - night * 0.92) * (1 - 0.35 * this.weather.overcast);
      this.ocean.setReflections(this.stage.scene.environment, this.time.reflections * (1 - 0.35 * this.weather.overcast));
    }
    this.boardView?.setNight(night);
    this.distant.update(dt, t, night);
    // An island under the sea (the title's, or one just left) rests: no flocks, mills or trails.
    if (this.boardGroup.visible) {
      for (const m of this.life) m.update(dt, t);
      this.wildlife?.update(dt, t);
      this.fireflies(dt, night);
    }
    if (this.wildlife) this.wildlife.daylight.value = 1 - night;
    for (const p of this.pools) p.update(dt);
    for (const fn of this.frameHandlers) fn(dt, t);
    this.dice.update(dt, this.stage.camera);
    this.diceTotal.update(dt, this.stage.camera);
    this.lamps.enabled = this.stage.pointLightsOn;
    this.lamps.update(night, t, this.stage.scene);
    this.effects.trail.update(dt);
    const draw = this.drawEnabled && (!this.coarse || started - this.lastDrawn >= COARSE_MS);
    if (draw) this.lastDrawn = started;
    // The wave simulation runs on the GPU just ahead of the frame that samples it.
    if (draw) this.ocean?.sim?.update(t, dt, this.weather.pace);
    // Right before drawing, so nothing added this frame is drawn without its hook; the
    // occasional sweep catches a material swapped on a mesh already there.
    if (added !== this.seenAdded || ++this.cloudPatchFrame % 240 === 0) {
      this.seenAdded = added;
      this.patchCloudShadows();
    }
    // (Low and Medium redraw shadows every other frame; a thrown die's must keep up with it.)
    if (this.dice.active) this.stage.sun.shadow.needsUpdate = true;
    if (!this.compiling && draw) this.stage.render();
    // (Undrawn, the camera's matrices are still kept current: cards fly from board positions projected through it.)
    else this.stage.camera.updateMatrixWorld();
    this.frameMs = performance.now() - started;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }

  private fireflyTiles: { set: TileSet; list: TileSet['tiles'] } | null = null;

  /** Fireflies drift over forests and meadows at night. */
  private fireflies(dt: number, night: number) {
    if (night < 0.4 || !this.tiles) return;
    this.fireflyTimer -= dt;
    if (this.fireflyTimer > 0) return;
    this.fireflyTimer = 0.12 / night;
    if (this.fireflyTiles?.set !== this.tiles)
      this.fireflyTiles = { set: this.tiles, list: this.tiles.tiles.filter((x) => x.shape.terrain === 'forest' || x.shape.terrain === 'pasture' || x.shape.terrain === 'fields') };
    const tiles = this.fireflyTiles.list;
    if (!tiles.length) return;
    const t = tiles[Math.floor(Math.random() * tiles.length)];
    // (Only over tiles that are up, and at their height as they rise.)
    const rise = this.effects.riseValues[t.hex.id] ?? 0;
    if (rise < -0.05) return;
    const a = Math.random() * Math.PI * 2;
    const r = 0.3 + Math.random() * 0.5;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    this.particles.sparkle.emit({
      x: t.hex.x + x,
      y: t.shape.height(x, z) + rise + 0.08 + Math.random() * 0.2,
      z: t.hex.z + z,
      vx: (Math.random() - 0.5) * 0.06,
      vy: (Math.random() - 0.3) * 0.04,
      vz: (Math.random() - 0.5) * 0.06,
      life: 2.5 + Math.random() * 2,
      size: 0.022,
      grow: 1,
      color: '#d9ff7a',
      fadeIn: 0.3,
      drag: 0.2,
    });
  }

  /**
   * Throw the dice onto the sea to show `values` (see fx/dice3d.ts), lit in the roller's colour.
   * `covered` says whether a screen point (CSS pixels) is under the HUD, to keep them in sight.
   */
  throwDice(values: [number, number], color: string, speed: number, instant: boolean, covered?: (x: number, y: number) => boolean, event?: EventDieResult) {
    this.diceColor = color;
    this.pendingTotal = { total: values[0] + values[1], color, speed, instant, event };
    this.diceTotal.hide();
    const plan = this.dice.plan(event);
    this.dice.throw(values, plan, this.diceSpot(plan.path, covered), color, speed, instant, event);
  }

  /**
   * Where the dice come to rest: on open water in view and clear of the HUD, as near as can be
   * to the right of the middle of the screen; and which way they are thrown from (from the
   * viewer's side if it can be, otherwise turned) so that their whole flight stays over open
   * water, clear of piers, moored boats and headlands, and away from the camera.
   */
  private diceSpot(path: [number, number, number][], covered?: (x: number, y: number) => boolean): DiceSpot {
    const cam = this.stage.camera;
    const fwd = cam.getWorldDirection(new THREE.Vector3()).setY(0);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).setY(0);
    const away = (fwd.lengthSq() > up.lengthSq() ? fwd : up).normalize();
    const right = new THREE.Vector3(-away.z, 0, away.x);
    const C = this.islandCentre, R = this.islandRadius, sdf = this.sdf;
    const fallback = { at: C.clone().addScaledVector(right, R + 1.2).setY(SEA_LEVEL), away };
    if (!sdf) return fallback;
    const obstacles = this.boardView?.waterObstacles() ?? [];
    const sea = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SEA_LEVEL);
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const spots: { p: THREE.Vector3; score: number }[] = [];
    const hit = new THREE.Vector3();
    for (let i = 0; i <= 15; i++) {
      for (let j = 0; j <= 13; j++) {
        ndc.set(-0.65 + i * 0.1, -0.65 + j * 0.1);
        ray.setFromCamera(ndc, cam);
        const p = ray.ray.intersectPlane(sea, hit);
        if (!p || Math.hypot(p.x - C.x, p.z - C.z) > R + 6) continue;
        const coast = sdf.sample(p.x, p.z);
        // Off the coast, with room round piers and boats (and the badges over the piers).
        if (coast < 1.1 || obstacles.some((o) => Math.hypot(p.x - o.x, p.z - o.z) < o.r + DIE * 1.4 + 0.25)) continue;
        // Nearest the right of the middle of the view, preferring open water.
        spots.push({ p: p.clone(), score: Math.hypot(ndc.x - 0.4, ndc.y) + Math.max(0, 1.8 - coast) * 0.25 });
      }
    }
    // The best two dozen are plenty (each is tried at several throws along the whole flight).
    spots.sort((a, b) => a.score - b.score);
    spots.length = Math.min(spots.length, 24);
    const css = (p: THREE.Vector3) => {
      _v.copy(p).project(cam);
      return [((_v.x + 1) / 2) * this.canvas.clientWidth, ((1 - _v.y) / 2) * this.canvas.clientHeight] as const;
    };
    const turns = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9, Math.PI];
    const aw = new THREE.Vector3(), bk = new THREE.Vector3(), rt = new THREE.Vector3();
    const probes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    // Every point of the flight over open water (deeper where it goes under), clear of what
    // stands in the sea while low, and not near the camera.
    const flightClear = (p: THREE.Vector3) =>
      path.every(([x, y, z]) => {
        const wx = p.x + (rt.x * x + bk.x * z) * DIE, wz = p.z + (rt.z * x + bk.z * z) * DIE;
        if (sdf.sample(wx, wz) < (y < 0.3 ? 0.8 : y < 1.6 ? 0.45 : 0.2)) return false;
        if (y < 1.4 && obstacles.some((o) => Math.hypot(wx - o.x, wz - o.z) < o.r + DIE * 0.75)) return false;
        return Math.hypot(wx - cam.position.x, SEA_LEVEL + y * DIE - cam.position.y, wz - cam.position.z) > 1.6;
      });
    // In sight first; if nowhere in sight will do, anywhere clear.
    for (const sight of covered ? [true, false] : [false]) {
      for (const { p } of spots) {
        // In sight: the dice, either side of the spot and the total above them, clear of the panels.
        if (sight && covered) {
          probes[0].copy(p);
          probes[1].copy(p).addScaledVector(right, DIE * 1.6);
          probes[2].copy(p).addScaledVector(right, -DIE * 1.6);
          probes[3].copy(p).setY(SEA_LEVEL + DIE * 2.5);
          if (probes.some((x) => covered(...css(x)))) continue;
        }
        for (const turn of turns) {
          aw.copy(away).applyAxisAngle(UP, turn);
          bk.copy(aw).negate();
          rt.set(bk.z, 0, -bk.x);
          if (flightClear(p)) return { at: p, away: aw.clone() };
        }
      }
    }
    return fallback;
  }

  setQuality(q: Quality, resize = true) {
    this.stage.setQuality(q, resize);
    this.ocean?.setMirror(this.stage.quality.reflections);
  }

  /** `quick`: the player chose it in Settings, so the day turns to it in a few seconds (see TimeOfDay.setMode). */
  setTimeMode(m: TimeMode, quick = false) {
    this.time.setMode(m, quick);
  }

  private sceneTimer = 0;

  /** Bumped by every change of auto-orbit, so a late "start orbiting" can tell it's been overruled. */
  private orbitGen = 0;

  setAutoOrbit(on: boolean) {
    this.orbitGen++;
    this.autoOrbit = on;
  }

  /**
   * Back over the sea as the title has it, turning on from there: unless something has taken the
   * camera meanwhile (a flight replaced by another ends early, and the editor's 3D view coming
   * back would have found the island turning under it).
   */
  flyToTitle(duration = 1.2, still: () => boolean = () => true) {
    const g = this.orbitGen;
    const t = titleView();
    return this.rig.flyTo({ ...t, target: t.target.clone() }, duration).then(() => g === this.orbitGen && still() && this.setAutoOrbit(true));
  }

  /**
   * Leaving a game: the island goes back under the sea, the tiles from the coast inwards with
   * what stands on them riding them down, each heaving a moment as the ground gives way
   * before it plunges, the sea closing over it in spray and rings, while the camera draws back
   * to the waterline to watch. It ends sunk and hidden, the title's open sea, with the camera
   * rising to the title's view (and turning on from there). `gentle`: one quick, quiet settling.
   */
  async outroSequence(view: BoardView | null, gentle = false) {
    const fx = this.effects;
    const rise = fx.rise.array as number[];
    const dry = fx.dry.array as number[];
    this.setAutoOrbit(false);
    void this.rig.flyTo({ ...AT_SEA, yaw: this.rig.pose.yaw - 0.5, pitch: 0.24, distance: 22 }, gentle ? 1 : 2.4);
    view?.sinkAll(gentle ? 0.2 : 0.8);
    void view?.sinkHarbours(gentle);
    await this.animator.wait(gentle ? 0.25 : 0.9);
    if (this.tiles) this.tiles.inner.visible = true;
    this.animator.tween({ duration: 1, easing: ease.linear, update: (t) => (fx.shoreRocks.value = 1 - t) });
    const centre = this.islandCentre;
    const hexes = [...(this.tiles?.tiles ?? [])].map((t) => t.hex).sort((a, b) => Math.hypot(b.x - centre.x, b.z - centre.z) - Math.hypot(a.x - centre.x, a.z - centre.z));
    const step = gentle ? 0.02 : 0.13;
    const fall = gentle ? 0.7 : 1.5;
    hexes.forEach((hex, i) => {
      let under = false;
      this.animator.tween({
        delay: i * step + (gentle ? 0 : ((hex.id * 37) % 7) * 0.015),
        duration: fall,
        easing: ease.linear,
        update: (t) => {
          // A heave as the ground gives way, then an ever faster plunge.
          const y = gentle ? -3.2 * t * t : t < 0.18 ? 0.09 * Math.sin((t / 0.18) * Math.PI) : -3.2 * Math.pow((t - 0.18) / 0.82, 2.1);
          fx.riseValues[hex.id] = y;
          rise[hex.id] = y;
          if (!under && y < -0.2) {
            under = true;
            fx.dryValues[hex.id] = dry[hex.id] = 1e6;
            if (!gentle) {
              view?.breach(hex.x, hex.z);
              this.rig.addShake(0.006);
            }
          }
        },
      });
    });
    // What stands on the land goes down with it (see BoardView.sinkAll).
    const sinking = (hexes.length - 1) * step + fall + 0.2;
    this.animator.tween({ duration: sinking, easing: ease.linear, update: () => view?.rideGround((h) => fx.riseValues[h] ?? 0) });
    await this.animator.wait(sinking);
    this.boardGroup.visible = false;
    this.sink();
    void this.shoal(true, gentle ? 1 : 2.4);
    // (Only if nothing has taken the camera since, such as a new game diving in.)
    const g = this.orbitGen;
    void this.rig.flyTo(titleView(), gentle ? 1.2 : 2.6).then(() => g === this.orbitGen && this.setAutoOrbit(true));
  }

  /**
   * The sunken island's sandbank: up, its floor stays just under the surface (the title's clear
   * shallows over where the island waits); down, it goes deep with the tiles, ready for them to
   * rise. Over `duration` seconds (0: at once).
   */
  shoal(up: boolean, duration = 0.5): Promise<void> {
    const u = this.ocean?.bedFollow;
    const to = up ? 0 : 1;
    if (!u || u.value === to) return Promise.resolve();
    if (duration <= 0) {
      u.value = to;
      return Promise.resolve();
    }
    const from = u.value;
    return this.animator.tween({ duration, easing: ease.inOutCubic, update: (t) => (u.value = from + (to - from) * t) }).promise;
  }

  /** Every tile under the sea, and wet: how a board waits to rise (each dries once it is up). */
  private sink() {
    const fx = this.effects;
    const dry = fx.dry.array as number[];
    for (let i = 0; i < fx.riseValues.length; i++) fx.riseValues[i] = -3.2;
    for (let i = 0; i < fx.dryValues.length; i++) fx.dryValues[i] = dry[i] = 1e6;
  }

  /**
   * Cinematic opening: the camera sweeps in while the tiles surge up out of the sea one by one
   * (throwing up water as they break the surface, heaving past it, settling with a bob and
   * shedding water), the number discs spin down onto them, the harbours are built round the
   * coast and the robber climbs out of the desert. `cancelled`: the game was left (or restarted)
   * meanwhile; the intro stops where it is, so nothing it hasn't done yet happens on the island
   * sinking away (its tweens, finished early by the quit, change nothing more).
   */
  async introSequence(view: BoardView, cancelled: () => boolean = () => false, overSea: () => void = () => {}) {
    const fx = this.effects;
    const board = view.board;
    const rise = fx.rise.array as number[];
    const dry = fx.dry.array as number[];
    this.sink();
    for (const t of view.tokens.values()) t.group.visible = false;
    view.robber.visible = false;
    view.hideHarbours();
    // Every tile rises alone, so each needs earth on all sides until its neighbours arrive.
    if (this.tiles) this.tiles.inner.visible = true;
    fx.shoreRocks.value = 0;
    this.boardGroup.visible = true;
    // First down to the water (from the title's view, or the last game's), then the sweep in.
    // (Brisk: it runs every game, and play waits on it. About four and a half seconds, all told.)
    this.setAutoOrbit(false);
    await this.rig.flyTo(AT_SEA, 0.85);
    if (cancelled()) return;
    // (Home as the HUD's panels leave it: they are in the page, unseen, and measured just before.)
    this.measureHome();
    const flight = this.rig.flyTo(homePose(), 3.4);
    // (Once the sweep has tipped the camera down onto the water, away from the bright sky its glass
    // would turn milky over, the HUD comes in: pitch 0.3 at the title, 0.92 over the board.)
    void (async () => {
      for (let t = 0; t < 3.4 && this.rig.pose.pitch < 0.62 && !cancelled(); t += 0.1) await this.animator.wait(0.1);
      overSea();
    })();
    // The classic island rises from the centre out along its spiral; any other map from its
    // centre outwards, nearest first (only the land rises: the sea is already there).
    const land = landHexes(board);
    const spiral = spiralOrder(0)
      .map(([q, r]) => land.find((h) => h.q === q && h.r === r))
      .reverse();
    const c = this.islandCentre;
    const order = spiral.length === land.length && spiral.every(Boolean) ? (spiral as typeof land) : [...land].sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z) || a.id - b.id);
    // Height over the tile's rise: a fast surge that carries it a little above the surface,
    // then a damped bob as it settles, like a heavy thing coming to rest in water.
    const SURGE = 0.55;
    const height = (t: number) => {
      if (t < SURGE) {
        const u = t / SURGE;
        return -3.2 + 3.3 * (1 - Math.pow(1 - u, 3));
      }
      const s = t - SURGE;
      return 0.1 * Math.exp(-7 * s) * Math.cos(13 * s);
    };
    order.forEach((hex, i) => {
      let breached = false;
      this.animator.tween({
        delay: 0.25 + i * 0.065 + ((hex.id * 37) % 7) * 0.012,
        duration: 1.5,
        easing: ease.linear,
        update: (t) => {
          if (cancelled()) return;
          const y = t >= 1 ? 0 : height(t);
          fx.riseValues[hex.id] = y;
          rise[hex.id] = y;
          if (!breached && y > -0.3) {
            breached = true;
            fx.dryValues[hex.id] = dry[hex.id] = fx.now.value + 0.8;
            // (Rushed, a splash for every sixth: nineteen at once would roar.)
            view.breach(hex.x, hex.z, this.introRush === 1 || i % 6 === 0);
            // (Nor do nineteen shakes come at once: they add up faster than they die away.)
            if (this.introRush === 1) this.rig.addShake(0.01);
          }
        },
        done: () => !cancelled() && view.drain(hex.x, hex.z),
      });
    });
    // (Until the last, at the coast, has broken the surface.)
    await this.animator.wait(0.25 + order.length * 0.065 + 0.7);
    if (cancelled()) return;
    if (this.tiles) this.tiles.inner.visible = false;
    // The coastline is whole now: boulders gather at the foot of the sea cliffs.
    this.animator.tween({ duration: 2.6, easing: ease.linear, update: (t) => (fx.shoreRocks.value = t) });
    // (Play needn't wait for the last harbours' badges to come up: they finish as it starts.)
    void view.buildHarbours();
    // Number discs spin down face-down and land face-up (the fishing grounds' last, on the water).
    let k = 0;
    for (const hex of [...order, ...board.hexes.filter((h) => !isLand(h.terrain) && h.numbers.length)]) {
      const tok = view.tokens.get(hex.id);
      // (A resumed game's disc that pollution took stays off the board.)
      if (!tok || !view.discShown(hex.id)) continue;
      const g = tok.group;
      const y0 = g.position.y;
      // (A landing sound for every third disc: they land 45 ms apart, and twenty at once clatter.)
      const sounds = k % 3 === 0;
      this.animator.tween({
        delay: k++ * 0.045,
        duration: 0.8,
        easing: ease.linear,
        update: (t) => {
          if (cancelled()) return;
          g.visible = true;
          const f = Math.min(1, t / 0.6);
          if (t < 0.6) g.position.y = y0 + (1 - f * f) * 1.1;
          else {
            const s = (t - 0.6) / 0.4;
            g.position.y = y0 + Math.sin(s * Math.PI) * 0.05 * (1 - s);
          }
          g.rotation.x = (1 - f) * Math.PI * 3;
          g.scale.setScalar(0.35 + 0.65 * Math.min(1, t * 1.8));
        },
        done: () => {
          if (cancelled()) return;
          g.position.y = y0;
          g.rotation.x = 0;
          g.scale.setScalar(1);
          view.dustBurst(new THREE.Vector3(g.position.x, y0, g.position.z), 8, 0.12);
          if (sounds && this.introRush === 1) sfx.play('cardLand', { volume: 0.5 });
        },
      });
    }
    // The robber climbs up out of the desert sand (where the game has one on the board), as the
    // last discs land.
    const robbed = async () => {
      if (view.robberHex < 0) return;
      await this.animator.wait(k * 0.045 * 0.5 + 0.3);
      if (cancelled()) return;
      const robber = view.robber;
      const ry = robber.position.y;
      robber.position.y = ry - 0.5;
      robber.visible = true;
      view.dustBurst(robber.position.clone().setY(ry), 26, 0.2);
      this.rig.addShake(0.03);
      await this.animator.tween({ duration: 0.7, easing: ease.outBack, update: (t) => (robber.position.y = ry - 0.5 * (1 - t)) }).promise;
    };
    await Promise.all([this.animator.wait(k * 0.045 + 0.5), robbed(), flight]);
  }

  /** Production highlight on a hex: golden glow pulse, disc bounce and terrain-specific life. */
  produce(hex: number) {
    this.glow(hex);
    const view = this.boardView;
    if (!view) return;
    const tok = view.tokens.get(hex);
    if (tok) {
      const g = tok.group;
      const y0 = g.userData.baseY ?? (g.userData.baseY = g.position.y);
      tok.highlight.value = 1;
      this.animator.tween({
        duration: 0.9,
        easing: ease.linear,
        update: (t) => {
          g.position.y = y0 + Math.sin(t * Math.PI) * 0.22;
          g.rotation.y = t * Math.PI * 2;
        },
        done: () => {
          g.position.y = y0;
          g.rotation.y = 0;
        },
      });
      this.animator.tween({ delay: 1.6, duration: 0.8, update: (t) => (tok.highlight.value = 1 - t) });
    }
    view.produceEffect(hex);
  }

  /** The golden glow alone, nothing moving: production's pulse, and a glance's mark under reduced motion. */
  glow(hex: number) {
    const fx = this.effects.get(hex);
    this.animator.tween({
      duration: 2.4,
      easing: ease.linear,
      update: (t) => (fx.x = Math.sin(Math.min(1, t * 3) * Math.PI * 0.5) * (1 - Math.max(0, (t - 0.55) / 0.45))),
      done: () => (fx.x = 0),
    });
    fx.w = this.effects.now.value;
  }

  celebrate() {
    this.boardView?.fireworks();
    this.setAutoOrbit(true);
  }

  /** Dynamic time of day follows the game's rounds (see Settings). */
  setTimeFromTurn(turn: number, players: number) {
    this.time.setTurn(turn, players);
    // The crops ripen over the first ten rounds or so, and then stand ready for the harvest.
    this.seasonTarget = Math.min(1, turn / Math.max(1, players) / 10);
  }

  /** Where the season is heading (eased into effects.season in the frame: crops don't ripen in a jump). */
  private seasonTarget = 0;

  /**
   * Straight to the time of day and the season, for a board just set: Play again after a late game
   * would otherwise see the fields unripen through the intro, and a resumed one ripen.
   */
  snapTime() {
    this.time.snap();
    this.effects.season.value = this.seasonTarget;
  }

  private fireflyTimer = 0;
  /** Terrain-specific production life for a hex (installed in setBoard). */
  extraProduce: ((hex: number) => void) | null = null;

  dispose() {
    for (const t of this.thunder) clearTimeout(t);
    this.thunder.clear();
    this.terrainPool?.dispose();
    this.running = false;
    this.stage.renderer.setAnimationLoop(null);
    this.clearBoard();
    this.ocean?.dispose();
    this.ocean = null;
    this.seagrass?.dispose();
    this.seagrass = null;
    for (const p of Object.values(this.particles)) p.dispose();
    this.effects.contact.dispose();
    this.effects.trail.dispose();
    this.dice.dispose();
    this.diceTotal.dispose();
    this.distant.dispose();
    this.weather.dispose();
    this.time.dispose();
    this.rig.dispose();
    this.stage.dispose();
    this.frameHandlers.clear();
  }
}
