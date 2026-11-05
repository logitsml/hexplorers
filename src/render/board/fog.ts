// Fog over the face-down hexes of a sea map, and what happens when a route reaches one: the mist
// parts, and the hex comes up out of the sea as land (or the water simply clears).
//
// The island is built from the board as a player sees it (face-down hexes as open water), so
// nothing on it gives away what lies under the fog. A found hex's tile is built then, through the
// terrain pool like every other, and the island's tiles, ground cover and coast are rebuilt
// around it; what stands on the old ones (trees, sheep, mills) is left where it is, since every
// tile but the new one and its neighbours' coasts comes out exactly as it was. Every material the
// new land could need is compiled at the start of the game, from a preview of the board with
// every hex face up (see prepare).

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn,
  attribute,
  float,
  int,
  vec2,
  vec3,
  vec4,
  max,
  uniformArray,
  varying,
  positionGeometry,
  positionLocal,
  positionView,
  mix,
  smoothstep,
  sin,
  time,
  clamp,
  exp,
  uniform,
  mx_noise_float,
  mx_fractal_noise_float,
  perspectiveDepthToViewZ,
  cameraNear,
  cameraFar,
} from 'three/tsl';
import { isLand, type Board, type GameState } from '../../engine';
import { HEX_APOTHEM, SEA_LEVEL, hexSdf } from './layout';
import { fogNumber, hiddenHexes, shownBoard } from './fogBoard';
import { seenBoard } from '../../engine/modules/sea/fog';
import { MAX_TILES, pooled, type TileEffects } from './materials';
import { particleDepth } from '../util/sceneDepth';
import { windDir } from '../env/wind';
import { release } from './release';
import { TileSet } from './tiles';
import { Decor, type Reserved } from './decor';
import type { LifeContext, LifeModule } from './life/common';
import type { World } from '../World';
import { CoastLife } from './life/coast';
import { buildSdfField, type SdfField } from './layout';
import { landHexes, lookOf } from './looks';
import { PropBatches } from './propBatches';
import { ease } from '../util/tween';
import { sfx } from '../../audio/sfx';
import { LampLights } from '../fx/lampLights';
import { Noise } from '../util/noise';

/** Hex ids the fog's per-hex values reach (a sea map's land runs to MAX_TILES; its sea further). */
const FOG_HEXES = MAX_TILES + 27;

/** The fog's own noise, for the ragged edges of its footprint. */
const fogNoise = new Noise(907);

/**
 * The fog's footprint on the sea's layer grid (see Ocean.setLayer), the murk it lays on the water:
 * one field over every face-down hex together (from the distance to the nearest of them, so a run
 * of hexes is one stretch of weather, with no seams), its edge pushed out and in by a slow noise
 * and feathered well past the hexes' borders, and patchy within. The hexes still show through it
 * faintly, as a slightly denser core, so a player can tell which ones are face down.
 */
function fogField(board: Board, hidden: Iterable<number>, size: number, extent: number): Float32Array {
  const field = new Float32Array(size * size);
  const near = new Float32Array(size * size).fill(Infinity);
  const cell = (2 * extent) / size;
  const R = 1.7;
  let i0 = size, i1 = -1, j0 = size, j1 = -1;
  for (const id of hidden) {
    const h = board.hexes[id];
    if (!h) continue;
    const a0 = Math.max(0, Math.floor((h.x - R + extent) / cell)), a1 = Math.min(size - 1, Math.ceil((h.x + R + extent) / cell));
    const b0 = Math.max(0, Math.floor((h.z - R + extent) / cell)), b1 = Math.min(size - 1, Math.ceil((h.z + R + extent) / cell));
    for (let j = b0; j <= b1; j++) {
      const z = (j + 0.5) * cell - extent;
      for (let i = a0; i <= a1; i++) {
        const d = hexSdf((i + 0.5) * cell - extent - h.x, z - h.z, 1);
        const k = j * size + i;
        if (d < near[k]) near[k] = d;
      }
    }
    i0 = Math.min(i0, a0);
    i1 = Math.max(i1, a1);
    j0 = Math.min(j0, b0);
    j1 = Math.max(j1, b1);
  }
  const ss = THREE.MathUtils.smoothstep;
  for (let j = j0; j <= j1; j++) {
    const z = (j + 0.5) * cell - extent;
    for (let i = i0; i <= i1; i++) {
      const k = j * size + i;
      const d = near[k];
      if (d > 0.7) continue;
      const x = (i + 0.5) * cell - extent;
      const warp = fogNoise.fbm2(x * 1.25, z * 1.25, 3) * 0.3;
      const spill = 1 - ss(d + warp, -0.24, 0.36);
      const core = 1 - ss(d, -0.22, 0.06);
      const patchy = 0.8 + 0.2 * (fogNoise.fbm2(x * 0.8 + 31.7, z * 0.8 - 4.1, 2) * 0.5 + 0.5);
      field[k] = Math.max(spill * patchy * 0.72, core);
    }
  }
  return field;
}

/** Layers of mist in the bank, bottom to top, and the bank's height over the sea (a wall of sea fog that hides the hex). */
const LAYERS = 9;
const BANK = 0.7;
/** How far past a hex's outline its mist may reach (where no other face-down hex lies). */
const SPILL = 0.45;
/** The six neighbours' directions (pointy-top hexes, so neighbours lie at 0°, 60°, ... ). */
const SIDES = Array.from({ length: 6 }, (_, k) => [Math.cos((k * Math.PI) / 3), Math.sin((k * Math.PI) / 3)]);

/** Distance from a hex's middle to its outline at angle `a` (circumradius 1; flat sides face ±x). */
function hexRadius(a: number) {
  const step = Math.PI / 3;
  let d = ((a % step) + step) % step;
  if (d > step / 2) d -= step;
  return HEX_APOTHEM / Math.cos(d);
}

/**
 * The fog bank's geometry: over each face-down hex a stack of discs reaching SPILL past its
 * outline, each vertex carrying its hex, its layer (0 at the water, 1 at the top), the hex's
 * middle, and which of its six neighbours are face down too (aSidesA: the first three, aSidesB:
 * the rest). The shader shares the mist out between neighbouring hexes by those, so the discs'
 * overlaps add up to one even bank, while towards open water it spills out freely.
 */
function bankGeometry(board: Board, hidden: number[]): THREE.BufferGeometry {
  const RINGS = 6, SEGS = 36;
  const pos: number[] = [], hex: number[] = [], layer: number[] = [], centre: number[] = [], sidesA: number[] = [], sidesB: number[] = [];
  const idx: number[] = [];
  const fogged = hidden.map((id) => board.hexes[id]);
  for (const id of hidden) {
    const h = board.hexes[id];
    const side = SIDES.map(([dx, dz]) => (fogged.some((o) => Math.hypot(o.x - h.x - dx * 2 * HEX_APOTHEM, o.z - h.z - dz * 2 * HEX_APOTHEM) < 0.1) ? 1 : 0));
    for (let l = 0; l < LAYERS; l++) {
      const u = l / (LAYERS - 1);
      // Closer together low down, where the mist lies thickest on the water.
      const y = SEA_LEVEL + 0.012 + Math.pow(u, 1.6) * BANK;
      const base = pos.length / 3;
      for (let r = 0; r <= RINGS; r++) {
        const f = r / RINGS;
        const n = r === 0 ? 1 : SEGS;
        for (let s = 0; s < n; s++) {
          const a = (s / SEGS) * Math.PI * 2;
          const rad = f * (hexRadius(a) + SPILL);
          pos.push(h.x + Math.cos(a) * rad, y, h.z + Math.sin(a) * rad);
          hex.push(id);
          layer.push(u);
          centre.push(h.x, h.z);
          sidesA.push(side[0], side[1], side[2]);
          sidesB.push(side[3], side[4], side[5]);
        }
      }
      for (let s = 0; s < SEGS; s++) idx.push(base, base + 1 + ((s + 1) % SEGS), base + 1 + s);
      for (let r = 1; r < RINGS; r++) {
        const a0 = base + 1 + (r - 1) * SEGS, b0 = base + 1 + r * SEGS;
        for (let s = 0; s < SEGS; s++) {
          const a = a0 + s, a1 = a0 + ((s + 1) % SEGS), b = b0 + s, b1 = b0 + ((s + 1) % SEGS);
          idx.push(a, a1, b, a1, b1, b);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aHex', new THREE.Float32BufferAttribute(hex, 1));
  g.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
  g.setAttribute('aCentre', new THREE.Float32BufferAttribute(centre, 2));
  g.setAttribute('aSidesA', new THREE.Float32BufferAttribute(sidesA, 3));
  g.setAttribute('aSidesB', new THREE.Float32BufferAttribute(sidesB, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Per hex: how far its fog has parted (0 face down, 1 gone). Shared by the session's bank material. */
const clearArray = uniformArray(new Array(FOG_HEXES).fill(0), 'float');
const clearing = clearArray.array as number[];
/** 1 while the bank's light may flicker (0 under reduced motion: see FogBank.update). */
const flicker = uniform(1);
/** Per hex: how far its fog has thinned for being within reach of your pieces (eased: see setReach). */
const reachArray = uniformArray(new Array(FOG_HEXES).fill(0), 'float');
const reaching = reachArray.array as number[];

/**
 * The fog bank's material, one for the session: unlit mist in the scene's light (the same light
 * the mist particles take). A volume of seven layers: its top billows up and down (each layer
 * shows only below the bank's height there), sunlit and white where it rises towards the sun,
 * cooler and bluish in its hollows and underneath; billowing slowly downwind; feathered out past
 * the face-down hexes' borders with a ragged edge (the hexes themselves only a faint denser core);
 * fading where it meets the cliffs and the sea (soft, like the particles); and pushed outward and
 * up as a hex's fog parts.
 */
function bankMaterial(effects: TileEffects, light: Node<'color'>): THREE.MeshBasicNodeMaterial {
  return pooled(effects, 'fogBank', () => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.fog = true;
    const hexId = attribute<'float'>('aHex', 'float');
    const layer = attribute<'float'>('aLayer', 'float');
    const centre = attribute<'vec2'>('aCentre', 'vec2');
    const sidesA = attribute<'vec3'>('aSidesA', 'vec3');
    const sidesB = attribute<'vec3'>('aSidesB', 'vec3');
    const clear = clearArray.element(int(hexId)) as unknown as Node<'float'>;
    const near = reachArray.element(int(hexId)) as unknown as Node<'float'>;
    m.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const out = p.xz.sub(centre);
      // Parting: wheeled round the hex as it is torn open (the upper layers further), rolled
      // outward and lifted, as if a wind had come down on it.
      const turn = clear.mul(clear).mul(layer.mul(0.9).add(0.5));
      const c = turn.cos(), sn = turn.sin();
      const spun = vec2(out.x.mul(c).sub(out.y.mul(sn)), out.x.mul(sn).add(out.y.mul(c)));
      const push = clear.mul(clear.mul(0.8).add(0.5)).mul(layer.mul(0.8).add(0.55));
      p.x.assign(centre.x.add(spun.x.mul(push.add(1))));
      p.z.assign(centre.y.add(spun.y.mul(push.add(1))));
      p.y.addAssign(clear.mul(layer.mul(0.55).add(0.08)));
      // A slow heave, out of step from hex to hex.
      p.y.addAssign(sin(time.mul(0.35).add(hexId.mul(2.3)).add(layer.mul(1.7))).mul(0.018).mul(layer));
      return p;
    })();
    // Where this point lies (as built, before any parting pushes it about), from its hex's middle.
    const at = positionGeometry.xz;
    const q = at.sub(centre);
    // Shared out with face-down neighbours: towards each one the mist hands over across the
    // shared side (the two shares always adding up to one), towards open water it spills.
    const side = (k: number, fogged: Node<'float'>) => {
      const e = q.x.mul(SIDES[k][0]).add(q.y.mul(SIDES[k][1])).sub(HEX_APOTHEM);
      return { share: mix(float(1), smoothstep(0.28, -0.28, e), fogged), free: mix(float(-9), e, fogged.oneMinus()) };
    };
    const s6 = [side(0, sidesA.x), side(1, sidesA.y), side(2, sidesA.z), side(3, sidesB.x), side(4, sidesB.y), side(5, sidesB.z)];
    const share = s6.reduce((acc, s) => acc.mul(s.share), float(1) as Node<'float'>);
    const free = s6.reduce((acc, s) => max(acc, s.free), float(-9) as Node<'float'>);
    // Drifting slowly downwind and rolling as it goes, a little drawn out along the wind.
    const along = at.x.mul(windDir.x).add(at.y.mul(windDir.y)).sub(time.mul(0.05));
    const across = at.y.mul(windDir.x).sub(at.x.mul(windDir.y));
    const drift = vec2(along, across);
    // The bank's height here (0..1 of its layers): great slow billows, low and thin at its margins.
    const billow = (d: Node<'vec2'>) => mx_fractal_noise_float(vec3(d.x.mul(1.1), d.y.mul(1.5), time.mul(0.03)), 3, 2.0, 0.5).mul(0.5).add(0.5);
    // (The broad shapes, the bank's height and its shading, are worked out at the vertices: they
    // are slow, and the many overlapping layers make every pixel's noise count several times.)
    const lump = varying(billow(drift));
    // Towers: now and then a great slow head of it heaves up above the rest.
    const tower = varying(mx_fractal_noise_float(vec3(drift.mul(0.6), time.mul(0.018).add(7.3)), 2, 2.0, 0.5).mul(0.5).add(0.5));
    // Towards the sun: where the bank stands higher there, this side of it is in its shade.
    const sunward = effects.sunDir.xz.normalize();
    const lumpSun = varying(billow(drift.add(vec2(sunward.x.mul(windDir.x).add(sunward.y.mul(windDir.y)), sunward.y.mul(windDir.x).sub(sunward.x.mul(windDir.y))).mul(0.22))));
    const ragged = varying(mx_fractal_noise_float(vec3(at.mul(1.6), time.mul(0.02)), 2, 2.0, 0.5).mul(0.2));
    const edge = smoothstep(0.38, -0.26, free.add(ragged));
    const cover = edge.mul(share);
    const heave = smoothstep(0.55, 0.85, tower);
    // (Over a hex within reach of your pieces the bank sits lower and thinner, and its lantern brighter.)
    const top = lump.mul(0.62).add(heave.mul(0.38)).add(0.22).mul(cover.mul(0.55).add(0.45)).mul(near.mul(-0.35).add(1));
    const density = Fn(() => {
      // Wisps and holes within it, and each layer shown only below the bank's top here; over the
      // hexes themselves its body is unbroken low down, so nothing beneath shows through.
      const n = mx_fractal_noise_float(vec3(along.mul(1.6), across.mul(2.3), layer.mul(1.3).add(time.mul(0.05))), 2, 2.1, 0.55);
      const body = smoothstep(0.6, 0.95, cover).mul(float(1).sub(layer).mul(0.85));
      const wisp = max(smoothstep(-0.7, 0.25, n.sub(layer.mul(0.2))), body);
      const below = smoothstep(top, top.sub(0.2), layer);
      // (Thinner at the very bottom, so the bank sits softly on the water.)
      const thick = mix(float(0.36), float(0.2), layer).mul(smoothstep(0.0, 0.25, layer).mul(0.5).add(0.5));
      return clamp(wisp.mul(below).mul(cover).mul(thick).mul(near.mul(-0.3).add(1)), 0, 1);
    })();
    // A light deep in it, drifting about each face-down hex as a lantern would on an unseen shore,
    // seen only as a warm blur through the mist, brighter low down; and, now and then, a silent
    // flicker of light inside the bank, as if a storm were caught in it.
    const seed = hexId.mul(1.7);
    const wander = centre.add(vec2(sin(time.mul(0.13).add(seed)), sin(time.mul(0.11).add(seed.mul(1.9)).add(1.3))).mul(0.4));
    const gd = at.sub(wander);
    const lantern = varying(exp(gd.dot(gd).mul(-7)).mul(sin(time.mul(0.7).add(seed.mul(3.1))).mul(0.25).add(0.75)).mul(float(1).sub(layer.mul(0.7))).mul(near.mul(0.7).add(1)));
    const storm = smoothstep(0.55, 0.75, mx_noise_float(vec3(time.mul(0.35), hexId.mul(5.7), 0.5)));
    const flash = varying(storm.mul(sin(time.mul(23).add(hexId)).mul(0.5).add(0.5)).mul(float(1).sub(layer.sub(0.45).abs().mul(1.4)).max(0)).mul(cover).mul(flicker));
    // Soft where the bank meets whatever is behind it (the sea, the cliffs of the coast beside it).
    const sceneZ = perspectiveDepthToViewZ(particleDepth, cameraNear, cameraFar);
    const soft = smoothstep(0, 0.16, positionView.z.sub(sceneZ));
    // Sunlit and nearly white at the top of the bank, cool blue-grey in its hollows, underneath and
    // on the side turned from the sun.
    // (Seen from above, the billows read by their light: the slopes turned from the sun fall well
    // into shade, and low ground in the bank is darker still, shut in under the heads round it.)
    const lit = smoothstep(top.sub(0.45), top, layer).mul(clamp(lumpSun.sub(lump).mul(-5).add(1), 0.25, 1));
    const shade = mix(vec3(0.44, 0.51, 0.63), vec3(1.0, 0.985, 0.96), lit).mul(smoothstep(0.25, 0.85, top).mul(0.22).add(0.78));
    // (The lantern and the flicker are light of their own: they show at night, when the mist is dim.)
    const glow = vec3(1.0, 0.72, 0.4).mul(lantern.mul(0.55)).add(vec3(0.75, 0.8, 1.0).mul(flash.mul(0.9)));
    m.colorNode = vec4(shade.mul(light).add(glow), 1);
    m.opacityNode = density.mul(lantern.mul(0.35).add(1)).mul(soft).mul(clear.oneMinus());
    return m;
  });
}

/** The preview of the board with every hex face up, kept only for the game-start compile. */
interface Preview {
  group: THREE.Group;
  tiles: TileSet;
  decor: Decor;
  life: LifeModule[];
  props: PropBatches;
}

interface RevealOptions {
  /** Shown at once, with nothing animated (the flat map, or a game being caught up). */
  instant?: boolean;
  /** Reduced motion: a shorter, gentler rise, no shake, less spray. */
  calm?: boolean;
}

/**
 * The fog bank over a sea map's face-down hexes (one draw for all of them), the murk in the water
 * under it (the sea's fog layer), stray wisps drifting off it, and the reveal.
 */
export class FogBank {
  readonly hidden: Set<number>;
  private mesh: THREE.Mesh | null = null;
  private preview: Preview | null = null;
  private disposed = false;
  private unsub: () => void;
  private wispTimer = 0;
  /** The board the island shows now (face-down hexes as sea). */
  board: Board;

  constructor(
    private world: World,
    state: GameState,
  ) {
    this.hidden = new Set(hiddenHexes(state));
    this.board = shownBoard(state);
    for (let i = 0; i < clearing.length; i++) clearing[i] = reaching[i] = 0;
    this.rebuildBank();
    this.paintSea();
    this.unsub = world.onFrame((dt) => this.update(dt));
  }

  /** The bank's mesh over the hexes still face down (rebuilt as they turn up: it's small). */
  private rebuildBank() {
    this.dropBank();
    const ids = [...this.hidden].filter((h) => h < FOG_HEXES && this.board.hexes[h]);
    if (!ids.length) return;
    const mesh = new THREE.Mesh(bankGeometry(this.board, ids), bankMaterial(this.world.effects, this.world.particles.mist.light));
    mesh.renderOrder = 20;
    mesh.frustumCulled = false;
    mesh.name = 'fog';
    this.world.boardGroup.add(mesh);
    this.mesh = mesh;
  }

  private dropBank() {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    release(this.mesh);
    this.mesh = null;
  }

  /** The murk in the water under the hexes still face down. */
  private paintSea() {
    const ocean = this.world.ocean;
    if (!ocean) return;
    const { size, extent } = ocean.layerGrid;
    // (Only while the island is up: sunk, before the opening or after leaving, the sea is the title's.)
    this.murky = this.world.boardGroup.visible && this.hidden.size > 0;
    ocean.setLayer(1, this.murky ? fogField(this.board, this.hidden, size, extent) : null);
    ocean.fogClear.value.set(0, 0, 0);
  }

  /** Whether the sea's fog layer is painted now. */
  private murky = false;

  /** The face-down hexes within reach of your pieces (see fogBoard.ts fogWithinReach), which the bank thins over. */
  private reach = new Set<number>();
  setReach(hexes: Iterable<number>) {
    this.reach = new Set(hexes);
  }

  /** Until a foghorn next sounds from somewhere in the bank. */
  private hornTimer = 12 + Math.random() * 10;

  /** Wisps of mist drifting off the bank, now and then. */
  private update(dt: number) {
    if (this.disposed) return;
    // The murk goes with the island when it sinks (leaving the game), and comes with it when it rises.
    if (this.murky !== (this.world.boardGroup.visible && this.hidden.size > 0)) this.paintSea();
    if (!this.hidden.size || !this.world.boardGroup.visible) return;
    flicker.value = this.world.weather.gentle() ? 0 : 1;
    for (const h of this.hidden) if (h < FOG_HEXES) reaching[h] += ((this.reach.has(h) ? 1 : 0) - reaching[h]) * Math.min(1, dt * 1.5);
    // Now and then, far off in it, a foghorn.
    this.hornTimer -= dt;
    if (this.hornTimer <= 0) {
      this.hornTimer = 28 + Math.random() * 30;
      const ids = [...this.hidden];
      const far = this.board.hexes[ids[Math.floor(Math.random() * ids.length)]];
      if (far) sfx.play('foghorn', { at: { x: far.x, z: far.z }, volume: 0.5, rate: 0.95 + Math.random() * 0.1 });
    }
    this.wispTimer -= dt;
    if (this.wispTimer > 0) return;
    this.wispTimer = 0.9 / Math.sqrt(this.hidden.size);
    const ids = [...this.hidden];
    const h = this.board.hexes[ids[Math.floor(Math.random() * ids.length)]];
    if (!h) return;
    const a = Math.random() * Math.PI * 2;
    const r = 0.5 + Math.random() * 0.6;
    this.world.particles.mist.emit({
      x: h.x + Math.cos(a) * r,
      y: SEA_LEVEL + 0.12 + Math.random() * 0.2,
      z: h.z + Math.sin(a) * r,
      vx: Math.cos(a) * 0.03,
      vy: 0.008,
      vz: Math.sin(a) * 0.03,
      life: 6 + Math.random() * 4,
      size: 0.3 + Math.random() * 0.25,
      grow: 1.8,
      color: '#eef1f4',
      alpha: 0.12,
      drag: 0.05,
      fadeIn: 0.3,
    });
  }

  /**
   * Build a preview of the face-down hexes whose looks the island doesn't show yet, hidden, so
   * the game-start compile sees every material they could need (their terrain, ground cover and
   * life). It stays, hidden, until every hex is found: three keeps a
   * compiled pipeline only while some mesh holds it.
   */
  async prepare(state: GameState, alive: () => boolean) {
    const w = this.world;
    if (!this.hidden.size || !w.lifeCtx) return;
    // Only looks the island doesn't show yet need it (one hex of each: a hex's materials are its
    // look's). The rest are compiled already, and what a found hex adds of its own (its tile's
    // materials, its batches of ground cover) is compiled in slices as it comes up (see prebuild).
    const shown = new Set(landHexes(this.board).map((h) => lookOf(h.terrain)));
    const keep = new Map<string, number>();
    for (const id of this.hidden) {
      const t = state.board.hexes[id].terrain;
      const look = isLand(t) ? lookOf(t) : null;
      if (look && !shown.has(look) && !keep.has(look)) keep.set(look, id);
    }
    if (!keep.size) return;
    const ids = new Set(keep.values());
    const board: Board = { ...state.board, hexes: state.board.hexes.map((h) => (ids.has(h.id) || !isLand(h.terrain) ? h : { ...h, terrain: 'sea' })) };
    const tiles = await TileSet.create(board, w.effects, w.noise, state.options.seed, w.terrainPool);
    if (!alive() || this.disposed) {
      tiles.dispose();
      return;
    }
    const group = new THREE.Group();
    group.visible = false;
    group.name = 'fog-preview';
    // (Its lamps are never lit: no lights join the scene for it.)
    const glass = new THREE.Group();
    // (Its own props, so its batched parts compile here and go with it: see dropPreview.)
    // (Not warmed: the game-start compile is what it is for.)
    const props = new PropBatches(w.effects, group, w.stage, w.lifeCtx.props.batching ? glass : null);
    const ctx: LifeContext = { ...w.lifeCtx, tiles, group: new THREE.Group(), glass, props, lamps: new LampLights() };
    const life = w.lifeModules(ctx);
    const reserved: Reserved = [];
    for (const m of life) reserved.push(...m.plan(tiles.tiles));
    const decor = new Decor(tiles, w.effects, w.noise, w.stage.quality.foliage, reserved);
    for (const m of life) m.build();
    group.add(tiles.group, decor.group, ctx.group, ctx.glass);
    w.boardGroup.add(group);
    this.preview = { group, tiles, decor, life, props };
  }

  /** Reveals run one after another (an action can turn up two hexes). */
  private queue: Promise<void> = Promise.resolve();

  /** Set once the game is left (see stop). */
  private ended = false;

  /** Whether a reveal may go on: the bank is still the island's, and its game is still being played. */
  private live() {
    return !this.disposed && !this.ended && this.world.fog === this;
  }

  /**
   * The game is being left (Session.end, before it finishes the running tweens): a reveal stops
   * where it is, so nothing it hasn't done yet happens on the island sinking away or on the
   * title's sea after it (no terrain swapped in, no disc, no new coast, no rise), and its tweens,
   * finished early by the quit, change nothing more. A rebuilt island ready but not yet swapped in
   * is let go when its reveal next wakes. The bank itself stays, and goes down with the island,
   * until the board is cleared; only the sea boiling over a hex coming up is calmed, since the
   * land that would have calmed it never breaks the surface.
   */
  stop() {
    if (this.ended) return;
    this.ended = true;
    const u = this.world.ocean?.shoaling;
    if (u && u.value.z > 0) this.shoal(u.value.x, u.value.y, 0, 0.6);
  }

  /**
   * A face-down hex turned up in `next`: its fog parts, and land comes up out of the sea with its
   * number disc spinning down onto it (a sea hex just clears). Resolves once it has settled.
   */
  reveal(next: GameState, hex: number, o: RevealOptions = {}): Promise<void> {
    // (Meshes made meanwhile warm up once it's done: its own compile does the hex's, see World.warm.)
    const w = this.world;
    const run = this.queue.then(() => {
      w.warmHolds++;
      return this.revealNow(next, hex, o).finally(() => w.warmHolds--);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async revealNow(next: GameState, hex: number, o: RevealOptions) {
    const w = this.world;
    // (Every step below starts only while the game is still on: see stop.)
    if (!this.live() || !this.hidden.has(hex)) return;
    this.hidden.delete(hex);
    // (From this bank's own list, not `next`'s: another hex the same move found is still to come.)
    const board = this.hidden.size ? seenBoard(next.board, [...this.hidden]) : next.board;
    const h = board.hexes[hex];
    const land = isLand(h.terrain);
    const instant = !!o.instant || !w.boardGroup.visible;
    const calm = !!o.calm;
    // The land's tile is built meanwhile (in the terrain pool's workers), as the fog parts.
    const built = land ? TileSet.create(board, w.effects, w.noise, next.options.seed, w.terrainPool) : null;
    const parted = instant ? Promise.resolve() : this.part(h.x, h.z, hex, calm);
    if (!land) {
      await parted;
      if (!this.live()) return;
      this.board = board;
      if (w.boardView) w.boardView.board = board;
      this.rebuildBank();
      this.paintSea();
      return;
    }
    const started = performance.now();
    // Meanwhile the sea over it boils, and pales as the land comes up beneath.
    if (!instant) this.shoal(h.x, h.z, 1, calm ? 0.6 : 1.4);
    const tiles = await built!;
    if (!this.live() || !w.tiles || !w.lifeCtx) {
      tiles.dispose();
      return;
    }
    const sdf = buildSdfField(board);
    const ready = await this.prebuild(tiles, hex, instant);
    if (!ready) return;
    // The tile goes in under the sea (unseen) once the fog over it is mostly gone.
    const due = (calm ? 350 : 700) - (performance.now() - started);
    if (!instant && due > 0) await w.animator.wait(due / 1000);
    // (Left meanwhile: the rebuilt island, in the scene but hidden, goes unused.)
    if (!this.live()) {
      ready.drop();
      return;
    }
    this.board = board;
    ready.commit();
    const view = w.boardView;
    if (view) view.board = board;
    const n = fogNumber(next, hex) ?? h.numbers[0];
    const disc = n !== undefined && view ? view.addDisc(hex, n, !instant) : null;
    if (instant) {
      this.settle(tiles, sdf, board);
      await parted;
      return;
    }
    await Promise.all([parted, this.rise(tiles, hex, sdf, board, calm)]);
    if (!this.live()) return;
    if (disc) await this.dropDisc(disc, calm);
    if (!this.hidden.size) this.dropPreview();
  }

  /**
   * The fog over a hex parting: rolled outward off it and thinning to nothing, wisps streaming
   * away, the murk going out of the water. Then the bank is redrawn without it.
   */
  private async part(x: number, z: number, hex: number, calm: boolean) {
    const w = this.world;
    const ocean = w.ocean;
    sfx.play('whoosh', { at: { x, z }, volume: calm ? 0.25 : 0.45 });
    if (!calm) {
      // A ring of it blown out low over the water all round, as if a gust had come straight down...
      for (let i = 0; i < 30; i++) {
        const a = (i / 30) * Math.PI * 2 + Math.random() * 0.2;
        const r = hexRadius(a) * (0.75 + Math.random() * 0.2);
        const v = 0.7 + Math.random() * 0.35;
        w.particles.mist.emit({
          x: x + Math.cos(a) * r,
          y: SEA_LEVEL + 0.05 + Math.random() * 0.08,
          z: z + Math.sin(a) * r,
          vx: Math.cos(a) * v,
          vy: 0.01,
          vz: Math.sin(a) * v,
          life: 1.6 + Math.random() * 0.8,
          size: 0.22 + Math.random() * 0.14,
          grow: 3.2,
          color: '#dfe5ea',
          alpha: 0.2,
          drag: 1.3,
          fadeIn: 0.08,
        });
      }
      // ...the rest torn off it upward in a slow column, thinning as it climbs.
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 0.35;
        w.particles.mist.emit({
          x: x + Math.cos(a) * r,
          y: SEA_LEVEL + 0.2 + Math.random() * 0.3,
          z: z + Math.sin(a) * r,
          vx: Math.cos(a) * 0.05,
          vy: 0.25 + Math.random() * 0.2,
          vz: Math.sin(a) * 0.05,
          life: 2.6 + Math.random(),
          size: 0.3 + Math.random() * 0.2,
          grow: 2.8,
          color: '#f1f3f5',
          alpha: 0.14,
          drag: 0.6,
          fadeIn: 0.2,
        });
      }
      for (let i = 0; i < 22; i++) {
        const a = (i / 18) * Math.PI * 2 + Math.random() * 0.3;
        const r = 0.35 + Math.random() * 0.5;
        w.particles.mist.emit({
          x: x + Math.cos(a) * r,
          y: SEA_LEVEL + 0.1 + Math.random() * 0.35,
          z: z + Math.sin(a) * r,
          vx: Math.cos(a) * (0.35 + Math.random() * 0.25),
          vy: 0.04 + Math.random() * 0.05,
          vz: Math.sin(a) * (0.35 + Math.random() * 0.25),
          life: 2.2 + Math.random() * 1.2,
          size: 0.28 + Math.random() * 0.2,
          grow: 2.6,
          color: '#c9d1d7',
          alpha: 0.17,
          drag: 0.8,
          fadeIn: 0.15,
        });
      }
    }
    await w.animator.tween({
      duration: calm ? 0.8 : 1.6,
      easing: ease.outCubic,
      update: (t) => {
        if (!this.live()) return;
        if (hex < FOG_HEXES) clearing[hex] = t;
        ocean?.fogClear.value.set(x, z, t);
      },
    }).promise;
    if (!this.live()) return;
    this.rebuildBank();
    this.paintSea();
    if (hex < FOG_HEXES) clearing[hex] = 0;
  }

  /**
   * The island rebuilt with the found hex: its tiles (every one but the new tile and its
   * neighbours' coasts comes out as it was), the ground cover over them, the coast's beaches and
   * seals all round, and the new hex's own life. What lives on the other hexes stays as it is.
   * Built over a few frames out of sight and compiled there, then swapped in at once by `commit`
   * (or, if the game is left before then, let go by `drop`); it resolves to null if the game went
   * while it was building. The new tile starts under the sea, unless it's shown at once. The old
   * meshes go only once the new ones have been drawn: they share their render pipelines, which
   * three would otherwise drop with the last mesh using them and compile again (the terrain's
   * alone take seconds).
   */
  private async prebuild(tiles: TileSet, hex: number, instant: boolean): Promise<{ commit: () => void; drop: () => null } | null> {
    const w = this.world;
    const fx = w.effects;
    const ctx = w.lifeCtx!;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const alive = () => this.live() && w.lifeCtx === ctx;
    const tile = tiles.tiles.find((t) => t.hex.id === hex)!;
    // The new hex's life and the whole coast's, in a group of their own until they join the island
    // (with the island's own context otherwise, its tiles read live).
    const was = ctx.tiles;
    ctx.tiles = tiles;
    const group = new THREE.Group();
    const glass = new THREE.Group();
    const sub = Object.assign(Object.create(ctx) as LifeContext, { group, glass });
    const fresh = w.lifeModules(sub);
    const reserved: Reserved = [];
    for (const m of fresh) reserved.push(...m.plan(m instanceof CoastLife ? tiles.tiles : [tile]));
    // (The building is done in parts with frames between, as the island's first is: see World.buildIsland.)
    await frame();
    // Ground cover is placed hex by hex from each one's own seed, so only the new hex's is new.
    const decor = new Decor(tiles, fx, w.noise, w.stage.quality.foliage, [...w.reserved, ...reserved]);
    const parts = [tiles.group, decor.group, group, glass];
    /** The modules still to be let go with the rest: every one, until those with nothing here are (see below). */
    let own: LifeModule[] = fresh;
    const drop = () => {
      for (const g of parts) g.removeFromParent();
      decor.dispose();
      for (const m of own) m.dispose();
      tiles.dispose();
      release(group);
      // (The island's own life reads its tiles through the context: back to the ones it stands on.)
      if (ctx.tiles === tiles) ctx.tiles = was;
      return null;
    };
    await frame();
    if (!alive()) return drop();
    const kept: LifeModule[] = [];
    const unused: LifeModule[] = [];
    for (const m of fresh) {
      await frame();
      if (!alive()) return drop();
      const n = group.children.length;
      m.build();
      // (Modules for terrains the new hex isn't add nothing, and aren't kept.)
      if (m instanceof CoastLife || group.children.length > n) kept.push(m);
      else unused.push(m);
    }
    // A module's dispose lets go of its context's group, and these share one with the modules
    // kept (the new coast among them): they let go of a group of their own instead, empty as
    // what they added is. (Releasing the shared one cut the new coast loose from it, so the next
    // found hex couldn't take it out: every coast stayed in the scene, drawn under the next.)
    if (unused.length) {
      sub.group = new THREE.Group();
      for (const m of unused) m.dispose();
      sub.group = group;
    }
    own = kept;
    // Into the scene hidden, and compiled there in slices while frames go on: every instanced
    // batch of ground cover is a render object of its own to three (some tens of milliseconds
    // to build each), which drawn all at once stalled the swap's frame for a second or two.
    for (const g of parts) g.visible = false;
    w.boardGroup.add(tiles.group, decor.group);
    w.lifeGroup.add(group);
    w.glassGroup.add(glass);
    await w.precompile(undefined, true, true, () => !alive(), parts);
    await frame();
    if (!alive()) return drop();
    return { commit: () => this.commit(tiles, hex, instant, parts, decor, group, kept, reserved), drop };
  }

  /** The rebuilt island swapped in, in one frame (see prebuild). */
  private commit(tiles: TileSet, hex: number, instant: boolean, parts: THREE.Object3D[], decor: Decor, group: THREE.Group, kept: LifeModule[], reserved: Reserved) {
    const w = this.world;
    const fx = w.effects;
    for (const g of parts) g.visible = true;
    const rise = fx.rise.array as number[];
    const dry = fx.dry.array as number[];
    fx.riseValues[hex] = rise[hex] = instant ? 0 : -3.2;
    fx.dryValues[hex] = dry[hex] = instant ? -1000 : 1e6;
    if (!instant) {
      tiles.pending.add(hex);
      // (Earth on its neighbours' sides facing it until it's up, as while the island first rises.)
      tiles.inner.visible = true;
    }
    const oldTiles = w.tiles!;
    const oldDecor = w.decor;
    const oldCoast = w.life.filter((m) => m instanceof CoastLife);
    const oldCoastGroup = this.coastGroup ?? w.lifeGroup.getObjectByName('coast') ?? null;
    oldTiles.group.removeFromParent();
    oldDecor?.group.removeFromParent();
    oldCoastGroup?.removeFromParent();
    // (And from whichever group holds it, should its link up have been cut.)
    if (oldCoastGroup) for (const g of w.lifeGroup.children) g.remove(oldCoastGroup);
    w.tiles = tiles;
    w.boardGroup.add(tiles.group);
    w.decor = decor;
    w.boardGroup.add(decor.group);
    // (The new tiles and ground cover are bundles, as the ones they replace are: see render/core/bundles.ts.)
    w.stage.bundles.add(tiles.group);
    w.stage.bundles.add(decor.group);
    w.lifeGroup.add(group);
    this.coastGroup = group.getObjectByName('coast') ?? null;
    w.reserved.push(...reserved);
    w.life = [...w.life.filter((m) => !(m instanceof CoastLife)), ...kept];
    // (Trees and grass round the buildings standing are cleared and trodden again.)
    w.boardView?.reclear();
    setTimeout(() => {
      oldTiles.dispose();
      oldDecor?.dispose();
      for (const m of oldCoast) m.dispose();
    }, 700);
  }

  /** The coast's life's own group, as rebuilt last (see World.lifeModules). */
  private coastGroup: THREE.Object3D | null = null;

  /** The coast redrawn round the new land: the sea's shallows and surf, the sea grass, the frame. */
  private coast(sdf: SdfField, board: Board) {
    const w = this.world;
    if (!w.sdf || !w.ocean) return;
    const land = landHexes(board);
    // (In place: the wildlife holds the same field.)
    w.sdf.data.set(sdf.data);
    w.ocean.setIsland(w.sdf, land);
    w.seagrass?.place(w.sdf);
    w.frameIsland(land, board);
  }

  /** Shown at once: the coast as it is now, nothing still to rise. */
  private settle(tiles: TileSet, sdf: SdfField, board: Board) {
    tiles.inner.visible = false;
    tiles.pending.clear();
    this.coast(sdf, board);
  }

  /**
   * The new tile surges up out of the sea, as the island's tiles do at the start: up past the
   * surface in a burst of spray, a heavy bob as it settles, water streaming off it. Calm: a
   * steady rise with no overshoot or shake.
   */
  private rise(tiles: TileSet, hex: number, sdf: SdfField, board: Board, calm: boolean): Promise<void> {
    const w = this.world;
    const fx = w.effects;
    const rise = fx.rise.array as number[];
    const dry = fx.dry.array as number[];
    const h = board.hexes[hex];
    const SURGE = 0.55;
    const height = (t: number) => {
      if (calm) return -3.2 * Math.pow(1 - t, 3);
      if (t < SURGE) return -3.2 + 3.3 * (1 - Math.pow(1 - t / SURGE, 3));
      const s = t - SURGE;
      return 0.1 * Math.exp(-7 * s) * Math.cos(13 * s);
    };
    let breached = false;
    return w.animator.tween({
      duration: calm ? 1.1 : 1.5,
      easing: ease.linear,
      update: (t) => {
        if (!this.live() || w.tiles !== tiles) return;
        const y = t >= 1 ? 0 : height(t);
        fx.riseValues[hex] = rise[hex] = y;
        if (!breached && y > -0.3) {
          breached = true;
          fx.dryValues[hex] = dry[hex] = fx.now.value + 0.8;
          // (The new coastline appears as the land breaks the surface, under its spray.)
          this.coast(sdf, board);
          this.shoal(h.x, h.z, 0, 1.2);
          this.emerge(h.x, h.z, calm);
          if (!calm) this.motes(h.x, h.z);
          w.boardView?.breach(h.x, h.z);
          if (!calm) w.rig.addShake(0.01);
        }
      },
      done: () => {
        if (!this.live() || w.tiles !== tiles) return;
        fx.riseValues[hex] = rise[hex] = 0;
        tiles.pending.delete(hex);
        if (!tiles.pending.size) tiles.inner.visible = false;
        if (!calm) w.boardView?.drain(h.x, h.z);
      },
    }).promise;
  }

  /** The found hex's number disc spins down onto it and lands face up, as at the start. */
  private dropDisc(tok: { group: THREE.Group }, calm: boolean): Promise<void> {
    const w = this.world;
    const g = tok.group;
    const y0 = g.position.y;
    g.visible = true;
    return w.animator.tween({
      duration: calm ? 0.5 : 0.9,
      easing: ease.linear,
      update: (t) => {
        if (!this.live()) return;
        const f = Math.min(1, t / 0.6);
        if (calm) g.position.y = y0 + (1 - t) * 0.25;
        else if (t < 0.6) g.position.y = y0 + (1 - f * f) * 1.1;
        else g.position.y = y0 + Math.sin(((t - 0.6) / 0.4) * Math.PI) * 0.05 * (1 - (t - 0.6) / 0.4);
        g.rotation.x = calm ? 0 : (1 - f) * Math.PI * 3;
        g.scale.setScalar(0.35 + 0.65 * Math.min(1, t * 1.8));
      },
      done: () => {
        if (!this.live()) return;
        g.position.y = y0;
        g.rotation.x = 0;
        g.scale.setScalar(1);
        w.boardView?.dustBurst(new THREE.Vector3(g.position.x, y0, g.position.z), 8, 0.12);
        sfx.play('cardLand', { volume: 0.5 });
      },
    }).promise;
  }

  private shoalTween = -1;

  /** The sea over a hex boiling and paling (to `to`, over `seconds`) as land comes up under it. */
  private shoal(x: number, z: number, to: number, seconds: number) {
    const w = this.world;
    const u = w.ocean?.shoaling;
    if (!u) return;
    if (this.shoalTween >= 0) w.animator.cancel(this.shoalTween);
    const from = u.value.z;
    u.value.x = x;
    u.value.y = z;
    this.shoalTween = w.animator.tween({
      duration: seconds,
      easing: ease.inOutCubic,
      update: (t) => {
        if (!this.disposed) u.value.z = from + (to - from) * t;
      },
    }).id;
  }

  /**
   * The new coast just broken the surface: its surf gathers in patches that spread until they
   * join (the sea's `emerging`), and the water pouring off its edges throws up spray in uneven
   * bursts here and there along them, never as one even ring.
   */
  private emerge(x: number, z: number, calm: boolean) {
    const w = this.world;
    const u = w.ocean?.emerging;
    if (u) {
      u.value.set(x, z, 1);
      w.animator.tween({
        duration: calm ? 1.6 : 3.2,
        easing: ease.inOutCubic,
        update: (t) => {
          if (!this.disposed) u.value.z = 1 - t;
        },
      });
    }
    if (calm) return;
    const { spray, mist } = w.particles;
    for (let b = 0; b < 7; b++) {
      // A burst at a random place along the outline (a pointy-top hex: corners at ±z).
      const a = Math.random() * Math.PI * 2;
      const r = hexRadius(a) * 0.98;
      const bx = x + Math.cos(a) * r, bz = z + Math.sin(a) * r;
      const n = 4 + Math.floor(Math.random() * 9);
      for (let i = 0; i < n; i++) {
        const j = (Math.random() - 0.5) * 0.12;
        const up = 0.35 + Math.random() * 0.55;
        spray.emit({
          x: bx - Math.sin(a) * j,
          y: SEA_LEVEL + 0.02,
          z: bz + Math.cos(a) * j,
          vx: Math.cos(a) * (0.15 + Math.random() * 0.25) + (Math.random() - 0.5) * 0.1,
          vy: up,
          vz: Math.sin(a) * (0.15 + Math.random() * 0.25) + (Math.random() - 0.5) * 0.1,
          life: 0.5 + Math.random() * 0.4,
          size: 0.01 + Math.random() * 0.014,
          gravity: 1.6,
          color: '#eef6f6',
        });
      }
      if (Math.random() < 0.6)
        mist.emit({ x: bx, y: SEA_LEVEL + 0.04, z: bz, vx: Math.cos(a) * 0.06, vy: 0.05, vz: Math.sin(a) * 0.06, life: 1.4 + Math.random(), size: 0.07, grow: 2.4, color: '#f2f7f7', alpha: 0.22, drag: 0.4, fadeIn: 0.15 });
    }
  }

  /**
   * Found: motes of gold light drift up off the new land as it breaks the surface, as the last of
   * the mist burns off in the sun.
   */
  private motes(x: number, z: number) {
    const { sparkle } = this.world.particles;
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * hexRadius(a) * 0.9;
      sparkle.emit({
        x: x + Math.cos(a) * r,
        y: SEA_LEVEL + 0.08 + Math.random() * 0.1,
        z: z + Math.sin(a) * r,
        vx: (Math.random() - 0.5) * 0.06,
        vy: 0.18 + Math.random() * 0.3,
        vz: (Math.random() - 0.5) * 0.06,
        life: 1.4 + Math.random() * 1.4,
        size: 0.035 + Math.random() * 0.035,
        grow: 0.2,
        color: Math.random() < 0.7 ? '#ffe2a0' : '#fff6dc',
        drag: 0.9,
        spin: 2,
      });
    }
  }

  /** The preview's job is done (every hex is found, or the game is over). */
  private dropPreview() {
    const p = this.preview;
    if (!p) return;
    this.preview = null;
    p.group.removeFromParent();
    for (const m of p.life) m.dispose();
    p.props.dispose();
    p.decor.dispose();
    p.tiles.dispose();
    release(p.group);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsub();
    this.dropPreview();
    this.dropBank();
    this.world.ocean?.setLayer(1, null);
    this.world.ocean?.fogClear.value.set(0, 0, 0);
    this.world.ocean?.shoaling.value.set(0, 0, 0);
    this.world.ocean?.emerging.value.set(0, 0, 0);
  }
}
