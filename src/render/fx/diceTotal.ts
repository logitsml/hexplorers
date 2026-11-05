// The total of a roll as a solid numeral: it rises out of the sea above the floating dice,
// faces the camera while it bobs, and sinks again. It is set in the title's display face (the
// digits of Lilita One, see digits.json and digits-OFL.txt), extruded and bevelled, with ivory
// faces and sides in the roller's colour, lit, shadowed and reflected like the dice. A seven
// comes up ivory with a gold rim, turning once as it rises and with a bigger splash: marked, but
// calm (no alarm's red, no glow that throbs).

import * as THREE from 'three/webgpu';
import { texture, uniform, uv, vec2 } from 'three/tsl';
import { Font, type FontData } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import digits from './digits.json';
import { SEA_LEVEL } from '../board/layout';
import type { TileEffects } from '../board/materials';
import { pooled } from '../board/materials';
import { DIE } from './dice3d';
import { EVENT_VALUE, VALUE_EVENT, paintEvent, type EventDieResult } from './eventDie';

const font = new Font(digits as unknown as FontData);

/** Where the numeral's base floats above the water line, clear over the dice. */
const LIFT = DIE * 1.5;
/** How far under the surface its base starts and ends (deep enough to hide it whole). */
const DEPTH = DIE * 2.6;

const IVORY = new THREE.Color('#f4ead2');
const GOLD = new THREE.Color('#f0c35a');

const easeOutBack = (x: number, s: number) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
const easeIn = (x: number) => x * x * x;

interface TotalFx {
  /** The numeral breaks the surface at (x, z), rising or sinking (strength 0..1); `seven` when it is one. */
  splash(x: number, z: number, strength: number, seven: boolean): void;
}

export class DiceTotal3D {
  readonly mesh: THREE.Mesh;
  fx: TotalFx | null = null;
  private faceColor = uniform(IVORY.clone());
  private sideColor = uniform(new THREE.Color('#ffffff'));
  private glow = uniform(0);
  private geometries = new Map<number, THREE.BufferGeometry>();
  private t = -1;
  private speed = 1;
  private instant = false;
  private seven = false;
  private rise = 0.5;
  private hold = 1.5;
  private sink = 0.6;
  private surfaced = false;
  private dived = false;
  private at = new THREE.Vector3();
  private disposed = false;
  private badge: THREE.Mesh | null = null;
  private badgeTexture: THREE.CanvasTexture | null = null;
  private badgeCell = uniform(0);
  private ship = false;

  constructor(private effects: TileEffects) {
    // TextGeometry puts the front and back faces in group 0 and the sides and bevels in group 1.
    const face = new THREE.MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0 });
    face.colorNode = this.faceColor;
    face.emissiveNode = this.faceColor.mul(this.glow);
    const side = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.05 });
    side.colorNode = this.sideColor;
    side.emissiveNode = this.sideColor.mul(this.glow.mul(0.6));
    this.mesh = new THREE.Mesh(this.geometry(7), [face, side]);
    this.mesh.name = 'dice total';
    this.mesh.castShadow = true;
    this.mesh.rotation.order = 'YXZ';
    this.mesh.visible = false;
    // (The event die's badge is made by prepare, for the rules that throw that die.)
    // The other numerals are built while the page is idle (each is a few milliseconds of
    // extrusion and bevelling), not the moment the dice settle on one.
    const idle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 250));
    const queue = [6, 8, 5, 9, 4, 10, 3, 11, 2, 12];
    const next = () => {
      const n = queue.shift();
      if (n === undefined || this.disposed) return;
      this.geometry(n);
      idle(next);
    };
    idle(next);
  }

  private geometry(n: number) {
    let g = this.geometries.get(n);
    if (!g) {
      g = new TextGeometry(String(n), { font, size: DIE * 1.7, depth: DIE * 0.34, curveSegments: 8, bevelEnabled: true, bevelThickness: DIE * 0.07, bevelSize: DIE * 0.05, bevelSegments: 3 });
      // Centred across and through, standing on its base.
      g.computeBoundingBox();
      const b = g.boundingBox!;
      g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
      this.geometries.set(n, g);
    }
    return g;
  }

  /**
   * The event die's badge beside the total, for the rules that throw that die. Made as the board
   * is set, so the game-start precompile builds it; its atlas address changes with the result, so
   * no texture, geometry or material is created as the dice land. A base game never makes it.
   */
  prepare(eventDie: boolean) {
    if (!eventDie || this.badge) return;
    const canvas = document.createElement('canvas');
    canvas.width = 128 * 4;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = '#f4ead2';
      ctx.beginPath();
      ctx.roundRect(i * 128 + 3, 3, 122, 122, 22);
      ctx.fill();
      paintEvent(ctx, VALUE_EVENT[i === 0 ? 0 : i + 2], i * 128 + 20, 17, 88);
    }
    this.badgeTexture = new THREE.CanvasTexture(canvas);
    this.badgeTexture.colorSpace = THREE.SRGBColorSpace;
    const badgeMat = pooled(this.effects, 'dice:eventBadge', () => new THREE.MeshStandardNodeMaterial({ roughness: 0.42, transparent: true }));
    const texel = texture(this.badgeTexture, uv().mul(vec2(0.25, 1)).add(vec2(this.badgeCell, 0)));
    badgeMat.colorNode = texel.rgb;
    badgeMat.opacityNode = texel.a;
    badgeMat.emissiveNode = texel.rgb.mul(0.24);
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(DIE * 1.15, DIE * 1.15), badgeMat);
    badge.visible = false;
    this.mesh.add(badge);
    this.badge = badge;
  }

  /** Raise `total` above the dice resting at `at`, in the roller's colour. */
  show(total: number, color: string, at: THREE.Vector3, speed: number, instant: boolean, event?: EventDieResult) {
    if (this.badge) this.badge.visible = !!event;
    this.ship = event?.face === 'ship';
    if (event && this.badge) {
      this.badgeCell.value = (event.face === 'ship' ? 0 : EVENT_VALUE[event.face] - 3) / 4;
      this.mesh.geometry = this.geometry(total);
      this.mesh.geometry.computeBoundingBox();
      this.badge.position.set(this.mesh.geometry.boundingBox!.max.x + DIE * 0.8, DIE * 0.85, DIE * 0.2);
    }
    this.seven = total === 7;
    this.mesh.geometry = this.geometry(total);
    this.faceColor.value.copy(IVORY);
    this.sideColor.value.set(this.seven ? GOLD : color);
    this.at.copy(at);
    this.speed = Math.max(0.25, speed);
    this.instant = instant;
    this.rise = this.seven ? 0.62 : 0.5;
    this.hold = this.seven ? 2.2 : 1.5;
    this.sink = 0.6;
    this.surfaced = this.dived = instant;
    this.t = instant ? this.rise : 0;
    this.mesh.visible = true;
  }

  hide() {
    this.t = -1;
    this.mesh.visible = false;
  }

  update(dt: number, camera: THREE.Camera) {
    if (this.t < 0) return;
    this.t += dt * this.speed;
    const { rise, hold, sink } = this;
    const end = rise + hold + sink;
    if (this.t >= end) return this.hide();
    const m = this.mesh;
    let y: number;
    let spin = 0;
    if (this.t < rise) {
      const k = this.t / rise;
      y = THREE.MathUtils.lerp(-DEPTH, LIFT, easeOutBack(k, 1.4));
      // A seven turns once as it comes up, easing to a stop.
      if (this.seven) spin = (1 - k) ** 2 * Math.PI * 2;
    } else if (this.t < rise + hold || this.instant) {
      const k = this.t - rise;
      y = LIFT + Math.sin(k * 2.6) * DIE * 0.05;
    } else {
      const k = (this.t - rise - hold) / sink;
      y = THREE.MathUtils.lerp(LIFT, -DEPTH, easeIn(k));
    }
    if (!this.surfaced && y > 0) {
      this.surfaced = true;
      this.fx?.splash(this.at.x, this.at.z, this.seven ? 1 : 0.6, this.seven);
    }
    if (this.surfaced && !this.dived && this.t >= rise + hold && y < 0) {
      this.dived = true;
      this.fx?.splash(this.at.x, this.at.z, 0.4, false);
    }
    // With reduced motion it simply stands there for its time.
    if (this.instant) y = LIFT;
    m.position.set(this.at.x, SEA_LEVEL + y, this.at.z);
    // Turned to the camera and leaning back towards it (seen from above, an upright numeral
    // would look squashed), swaying on the swell.
    const dx = camera.position.x - this.at.x, dz = camera.position.z - this.at.z;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(camera.position.y - m.position.y, Math.hypot(dx, dz));
    const life = this.t;
    m.rotation.set(-pitch * 0.7, yaw + spin, this.instant ? 0 : Math.sin(life * 1.9) * 0.06);
    // A ship gets a short pulse alongside the fleet's next step, rather than an extra pause
    // inserted before the engine's production or pending decisions.
    this.badge?.scale.setScalar(this.ship && !this.instant ? 1 + 0.12 * Math.exp(-life * 3) * Math.sin(life * 12) : 1);
    // A little light of its own keeps the ivory clean when the face leans away from the sun (a
    // steady one, a seven's too: a glow that throbs reads as an alarm).
    this.glow.value = 0.24;
  }

  dispose() {
    this.disposed = true;
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
    this.badge?.geometry.dispose();
    (this.badge?.material as THREE.Material | undefined)?.dispose();
    this.badgeTexture?.dispose();
    for (const mat of this.mesh.material as THREE.Material[]) mat.dispose();
  }
}
