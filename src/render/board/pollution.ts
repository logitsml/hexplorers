// Pollution on the island (the Oil expansion's disasters): a hex that loses a number is blighted
// for good, its ground sooty in spreading patches, its plants dying back, smog hanging over it;
// one that has lost every number is a charred waste, smouldering, with embers in its cracks. The
// shading is the shared materials' (TileEffects.scar, see materials.ts); this keeps the levels,
// the smog, and the moment it strikes: the disc cracking in two and sinking into the ground.

import * as THREE from 'three/webgpu';
import { type Board, type GameState } from '../../engine';
import { destroyedHex } from '../../engine/modules/oil/disaster';
import { TOKEN_RADIUS } from './tokens';
import { DETAIL_LAYER } from './layout';
import { ease } from '../util/tween';
import { release } from './release';
import type { World } from '../World';
import type { BoardView } from './boardView';
import { flood, type FloodEvent, type FloodOptions } from './flood';

/** A hex that has lost a number but still bears another (or never had one to lose). */
const STRUCK = 0.55;

/** The pollution level a hex shows in `s`. */
function scarLevel(s: GameState, hex: number): number {
  if (!s.ext.oil?.lost.some((l) => l.hex === hex)) return 0;
  return destroyedHex(s, hex) ? 1 : STRUCK;
}

interface StrikeOptions {
  /** Shown at once, with nothing animated (the flat map). */
  instant?: boolean;
  /** Reduced motion: no crack or shake, the blight spreading more gently. */
  calm?: boolean;
}

/** The disc's thickness (as tokens.ts builds it). */
const THICK = 0.05;

/** Half a number disc, split along x = 0 (the +x half, or the -x one), to break in two. */
function halfDisc(sign: 1 | -1, rim: THREE.Material, face: THREE.Material, faceData: Record<string, unknown>) {
  const R = TOKEN_RADIUS;
  const pts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(R - 0.012, 0),
    new THREE.Vector2(R, 0.01),
    new THREE.Vector2(R, THICK - 0.012),
    new THREE.Vector2(R - 0.01, THICK),
    new THREE.Vector2(0, THICK + 0.003),
  ];
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 24, sign > 0 ? 0 : Math.PI, Math.PI), rim);
  body.castShadow = true;
  // The broken edge: a slab across the cut (seen for a moment, edge on, as the halves part).
  const cut = new THREE.Mesh(new THREE.PlaneGeometry(2 * R, THICK), rim);
  cut.rotation.y = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
  cut.position.y = THICK / 2;
  const top = new THREE.Mesh(new THREE.CircleGeometry(R - 0.014, 24, sign > 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI), face);
  top.rotation.x = -Math.PI / 2;
  top.position.y = THICK + 0.0035;
  Object.assign(top.userData, faceData);
  // Set up exactly as the whole disc is (tokens.ts): shadowed, and kept out of the sea's mirror.
  // Both are in three's render-object key and pass list, so a half that differed would need its
  // own node builds and pipelines, compiled at the very moment the disc breaks.
  for (const m of [body, cut, top]) {
    m.receiveShadow = true;
    m.layers.set(DETAIL_LAYER);
  }
  g.add(body, cut, top);
  return g;
}

/**
 * The Oil expansion's disasters on the island. Pollution: the level on each tile, the smog over the
 * polluted ones (and smoke and embers over the destroyed), and the strike itself. Floods are
 * flood.ts's, shown through here so the presenter has the one handle.
 */
export class Disasters {
  /** Each polluted hex's level as shown now (the same as TileEffects.scar, kept here for the smog). */
  private levels = new Map<number, number>();
  /** Each polluted hex's level as the game has it (a struck well's stain fades back to this). */
  private steady = new Map<number, number>();
  private unsub: () => void;
  private timers = new Map<number, number>();
  private disposed = false;

  constructor(
    private world: World,
    state: GameState,
  ) {
    this.clear();
    for (const l of state.ext.oil?.lost ?? []) {
      const v = scarLevel(state, l.hex);
      this.steady.set(l.hex, v);
      this.set(l.hex, v);
    }
    this.unsub = world.onFrame((dt) => this.update(dt));
  }

  private set(hex: number, v: number) {
    const fx = this.world.effects;
    if (hex >= fx.scarValues.length) return;
    fx.scarValues[hex] = (fx.scar.array as number[])[hex] = v;
    if (v > 0) this.levels.set(hex, v);
    else this.levels.delete(hex);
  }

  private clear() {
    const fx = this.world.effects;
    for (let i = 0; i < fx.scarValues.length; i++) fx.scarValues[i] = (fx.scar.array as number[])[i] = 0;
    this.levels.clear();
    this.steady.clear();
  }

  /** Ground height on a hex (0 off the island). */
  private ground(hex: number, x: number, z: number) {
    const tiles = this.world.tiles;
    return tiles?.tiles.some((t) => t.hex.id === hex) ? tiles.heightAt(hex, x, z) : 0;
  }

  private hexAt(hex: number) {
    return this.world.boardView?.board.hexes[hex] ?? null;
  }

  /** Smog over each polluted hex, and over a destroyed one smoke rising from where it smoulders. */
  private update(dt: number) {
    if (this.disposed || !this.levels.size || !this.world.boardGroup.visible) return;
    const { smoke, sparkle } = this.world.particles;
    const night = this.world.effects.night.value;
    for (const [hex, level] of this.levels) {
      const h = this.hexAt(hex);
      if (!h) continue;
      let t = (this.timers.get(hex) ?? Math.random()) - dt;
      while (t <= 0) {
        const dead = level > 0.75;
        t += dead ? 0.16 : 0.5;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 0.72;
        const x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
        const y = this.ground(hex, x, z);
        // A low brown haze that hangs and drifts off downwind.
        smoke.emit({
          x,
          y: y + 0.04 + Math.random() * 0.1,
          z,
          vx: (Math.random() - 0.5) * 0.02,
          vy: 0.012 + Math.random() * 0.01,
          vz: (Math.random() - 0.5) * 0.02,
          life: 6 + Math.random() * 3,
          size: 0.2 + Math.random() * 0.16,
          grow: 2.6,
          color: dead ? '#4a443d' : '#6e665a',
          alpha: dead ? 0.26 : 0.17,
          drag: 0.3,
          fadeIn: 0.25,
        });
        if (!dead) continue;
        // Smouldering: thin dark smoke climbing from three fixed spots, and sparks by night.
        const k = Math.floor(Math.random() * 3);
        const sa = hex * 2.1 + k * 2.09, sr = 0.25 + ((hex * 7 + k * 3) % 5) * 0.08;
        const sx = h.x + Math.cos(sa) * sr, sz = h.z + Math.sin(sa) * sr;
        const sy = this.ground(hex, sx, sz);
        smoke.emit({
          x: sx + (Math.random() - 0.5) * 0.04,
          y: sy + 0.02,
          z: sz + (Math.random() - 0.5) * 0.04,
          vx: (Math.random() - 0.5) * 0.02,
          vy: 0.11 + Math.random() * 0.05,
          vz: (Math.random() - 0.5) * 0.02,
          life: 3.5 + Math.random() * 1.5,
          size: 0.04,
          grow: 6,
          color: '#36322e',
          alpha: 0.42,
          drag: 0.25,
          fadeIn: 0.15,
        });
        if (Math.random() < 0.15 + night * 0.4)
          sparkle.emit({
            x: sx,
            y: sy + 0.03,
            z: sz,
            vx: (Math.random() - 0.5) * 0.06,
            vy: 0.2 + Math.random() * 0.15,
            vz: (Math.random() - 0.5) * 0.06,
            life: 0.9 + Math.random() * 0.8,
            size: 0.014,
            grow: 0.4,
            color: Math.random() < 0.5 ? '#ff8a3a' : '#ffc070',
            drag: 0.6,
            fadeIn: 0.05,
          });
      }
      this.timers.set(hex, t);
    }
  }

  /**
   * Pollution strikes `hex` in `next`, taking `number`: the disc showing it cracks in two and sinks
   * into the ground in a gout of dark smoke, while the blight spreads over the hex (to a charred
   * waste if that was its last number). Resolves once it has.
   */
  async strike(next: GameState, hex: number, number: number, o: StrikeOptions = {}) {
    const w = this.world;
    const to = scarLevel(next, hex);
    const from = this.levels.get(hex) ?? 0;
    this.steady.set(hex, to);
    const h = this.hexAt(hex);
    if (o.instant || !h || !w.boardGroup.visible) {
      this.set(hex, to);
      return;
    }
    const calm = !!o.calm;
    const view = w.boardView;
    const tok = view?.tokens.get(hex);
    // (The disc showing the number lost breaks: on a hex bearing several, the others stay.)
    const disc = tok?.group.visible ? tok.discs.find((d) => d.group.visible && d.n === number) : undefined;
    const cracking = disc && !calm ? this.crack(disc.group, hex) : null;
    if (disc && calm) disc.group.visible = false;
    // A gout of dark smoke off the hex as it's struck.
    for (let i = 0; i < (calm ? 8 : 26); i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.6;
      const x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
      w.particles.smoke.emit({
        x,
        y: this.ground(hex, x, z) + 0.05,
        z,
        vx: Math.cos(a) * 0.08,
        vy: 0.08 + Math.random() * 0.1,
        vz: Math.sin(a) * 0.08,
        life: 3 + Math.random() * 2,
        size: 0.16 + Math.random() * 0.14,
        grow: 3.2,
        color: '#3f3a34',
        alpha: 0.5,
        drag: 0.9,
        fadeIn: 0.1,
      });
    }
    if (!calm) w.rig.addShake(0.004);
    // The blight spreads over the hex, in patches growing until they meet.
    const spread = w.animator.tween({
      duration: calm ? 1.2 : 2.6,
      easing: ease.inOutCubic,
      update: (t) => {
        if (!this.disposed) this.set(hex, from + (to - from) * t);
      },
    }).promise;
    await Promise.all([spread, cracking]);
  }

  /**
   * The disc breaks in two: a jolt, then the halves fall apart and tip,
   * sinking into the blighted ground as smoke rises out of the crack. The disc itself is hidden
   * (the view takes it off the board for good when it next syncs its numbers).
   */
  private crack(disc: THREE.Group, hex: number): Promise<void> {
    const w = this.world;
    const body = disc.children[0] as THREE.Mesh;
    const face = disc.children[1] as THREE.Mesh;
    const pieces = ([1, -1] as const).map((sign) => {
      const half = halfDisc(sign, body.material as THREE.Material, face.material as THREE.Material, face.userData);
      const pivot = new THREE.Group();
      pivot.position.copy(disc.position);
      pivot.scale.copy(disc.scale);
      pivot.rotation.y = disc.rotation.y + hex * 0.7;
      pivot.add(half);
      disc.parent!.add(pivot);
      return { sign, half, pivot };
    });
    // (Where it stands in the world, for the smoke and dust: it sits in its hex's cluster.)
    const at = disc.getWorldPosition(new THREE.Vector3());
    // (Hidden only once the halves stand in its place, so it never blinks out.)
    disc.visible = false;
    const y0 = disc.position.y;
    const anim = w.animator.tween({
      duration: 1.9,
      easing: ease.linear,
      update: (t) => {
        if (this.disposed) return;
        // A jolt as it breaks, then the fall: apart, tipping outward, and down into the ground.
        const jolt = t < 0.12 ? Math.sin((t / 0.12) * Math.PI) * 0.025 : 0;
        const f = ease.inOutCubic(Math.min(1, Math.max(0, (t - 0.1) / 0.7)));
        const sink = ease.inCubic(Math.min(1, Math.max(0, (t - 0.35) / 0.65)));
        for (const p of pieces) {
          p.pivot.position.y = y0 + jolt - sink * (THICK + 0.05);
          p.half.position.x = p.sign * f * 0.035;
          p.half.rotation.z = p.sign * f * 0.32;
          p.half.position.y = f * 0.012;
        }
        if (t > 0.1 && t < 0.9 && Math.random() < 0.5) {
          w.particles.smoke.emit({
            x: at.x + (Math.random() - 0.5) * 0.06,
            y: at.y + 0.02,
            z: at.z + (Math.random() - 0.5) * 0.06,
            vx: 0,
            vy: 0.1 + Math.random() * 0.06,
            vz: 0,
            life: 2 + Math.random(),
            size: 0.04,
            grow: 4,
            color: '#3a3530',
            alpha: 0.4,
            drag: 0.3,
          });
        }
      },
    }).promise;
    w.boardView?.dustBurst(at.clone(), 10, 0.14);
    return anim.then(() => {
      for (const p of pieces) {
        p.pivot.removeFromParent();
        p.half.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        release(p.pivot);
      }
    });
  }

  /**
   * A well struck (its oil leaves the game): a gout of black, oily smoke from it, and its ground
   * fouled for a while, fading as it clears (wells aren't lost for good).
   */
  wellStruck(hex: number, o: StrikeOptions = {}) {
    const w = this.world;
    const h = this.hexAt(hex);
    if (o.instant || !h || !w.boardGroup.visible) return;
    const calm = !!o.calm;
    for (let i = 0; i < (calm ? 10 : 34); i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.35;
      const x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
      w.particles.smoke.emit({
        x,
        y: this.ground(hex, x, z) + 0.04,
        z,
        vx: Math.cos(a) * 0.05,
        vy: 0.18 + Math.random() * 0.2,
        vz: Math.sin(a) * 0.05,
        life: 3 + Math.random() * 2,
        size: 0.08 + Math.random() * 0.08,
        grow: 4,
        color: '#1d1b19',
        alpha: 0.5,
        drag: 0.5,
        fadeIn: 0.1,
      });
    }
    // (A stain that fades back to what pollution has left there for good.)
    w.animator.tween({
      duration: calm ? 6 : 12,
      easing: ease.linear,
      update: (t) => {
        if (this.disposed) return;
        const pulse = Math.min(1, t * 8) * (1 - t);
        this.set(hex, Math.max(this.steady.get(hex) ?? 0, 0.45 * pulse));
      },
      done: () => {
        if (!this.disposed) this.set(hex, this.steady.get(hex) ?? 0);
      },
    });
  }

  /** A flood (see flood.ts). */
  flood(view: BoardView, board: Board, e: FloodEvent, o: FloodOptions = {}) {
    return flood(this.world, view, board, e, o);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsub();
    this.clear();
    // (A flood still under way when the game is left goes with it.)
    const ocean = this.world.ocean;
    if (ocean) {
      ocean.surge.value = 0;
      ocean.surgeWaves.value = 0;
      ocean.setLayer(2, null);
    }
  }
}
