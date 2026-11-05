// Crows circling over the robber's hex: a few black birds wheeling on the air above where he
// stands, flapping now and then and gliding between. They fly in when he lands and off when
// he leaves (or the island goes under). Bodies and wings are two instanced draws in all.

import * as THREE from 'three/webgpu';
import { MeshBuilder, compose, smoothSphere } from './geom';
import { DETAIL_LAYER } from './layout';
import { follow } from '../util/angle';
import { instancedMesh } from './instancing';

const COUNT = 5;
const C = (h: string) => new THREE.Color(h);

/** A crow's body, head, beak and tail, facing +x, about 0.07 long. */
function makeBody(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const black = C('#1c1c22'), beak = C('#2e2a26');
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color) => {
    b.addGeometry(g, m, c);
    g.dispose();
  };
  add(smoothSphere(0.012, 1), compose(0, 0, 0, 0, 0, 0, 2.0, 0.85, 0.85), black);
  add(smoothSphere(0.0085, 1), compose(0.024, 0.004, 0), black);
  add(new THREE.ConeGeometry(0.0034, 0.012, 5), compose(0.035, 0.003, 0, 0, 0, -Math.PI / 2), beak);
  // A wedge of tail feathers.
  add(new THREE.BoxGeometry(0.022, 0.0015, 0.016), compose(-0.028, -0.001, 0, 0, 0, 0.08), black);
  return b.build(false);
}

/** One wing, hinged at the origin and reaching out along +z, its tip swept back. */
function makeWing(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const c = C('#18181e');
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4) => {
    b.addGeometry(g, m, c);
    g.dispose();
  };
  add(new THREE.BoxGeometry(0.024, 0.0016, 0.03), compose(0, 0, 0.015));
  add(new THREE.BoxGeometry(0.018, 0.0014, 0.028), compose(-0.006, 0, 0.042, 0, 0.35, 0));
  return b.build(false);
}

let shared: { body: THREE.BufferGeometry; wing: THREE.BufferGeometry; material: THREE.MeshStandardNodeMaterial } | null = null;

/** The crows' geometry and material, made once and kept for every game. */
function parts() {
  return (shared ??= {
    body: makeBody(),
    wing: makeWing(),
    material: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 }),
  });
}

interface Crow {
  angle: number;
  speed: number;
  radius: number;
  height: number;
  phase: number;
  /** Seconds of flapping left, then of gliding. */
  flap: number;
  glide: number;
  wing: number;
}

const _m = new THREE.Matrix4();
const _w = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class Crows {
  group = new THREE.Group();
  private bodies: THREE.InstancedMesh;
  private wings: THREE.InstancedMesh;
  private crows: Crow[] = [];
  /** Where they circle (eased toward the target), and whether they should be there at all. */
  private centre = new THREE.Vector3();
  private target = new THREE.Vector3();
  private wanted = false;
  /** 0 away .. 1 circling. */
  private presence = 0;
  /** The way they come in from (and go off to). */
  private from = new THREE.Vector3(1, 0, 0);

  constructor() {
    const p = parts();
    this.bodies = instancedMesh(p.body, p.material, COUNT);
    this.wings = instancedMesh(p.wing, p.material, COUNT * 2);
    for (const m of [this.bodies, this.wings]) {
      m.castShadow = true;
      m.frustumCulled = false;
      m.layers.set(DETAIL_LAYER);
      m.count = 0;
      this.group.add(m);
    }
    for (let i = 0; i < COUNT; i++) {
      this.crows.push({
        angle: (i / COUNT) * Math.PI * 2 + Math.random() * 0.6,
        speed: (0.7 + Math.random() * 0.35) * (i % 4 === 3 ? -1 : 1),
        radius: 0.28 + Math.random() * 0.3,
        height: 0.55 + Math.random() * 0.3,
        phase: Math.random() * 6,
        flap: Math.random() * 1.5,
        glide: 0,
        wing: 0,
      });
    }
  }

  /**
   * A hidden crow for the game-start precompile (see BoardView.standIns): a body and its wings,
   * each at the flock's own capacity and layer, which are part of the shader (a one-slot stand-in
   * compiled a pipeline the flock never used).
   */
  standIn(): THREE.Group {
    const p = parts();
    const g = new THREE.Group();
    for (const [geo, slots] of [[p.body, COUNT], [p.wing, COUNT * 2]] as const) {
      const m = instancedMesh(geo, p.material, slots);
      m.count = 1;
      m.castShadow = true;
      m.frustumCulled = false;
      m.layers.set(DETAIL_LAYER);
      g.add(m);
    }
    return g;
  }

  /** Circle over (x, y, z) (the robber's spot), or fly off with null. */
  set(at: THREE.Vector3 | null) {
    if (!at) {
      this.wanted = false;
      return;
    }
    if (this.presence <= 0.001) {
      // Arriving: straight to the new spot, from a random quarter of the sky.
      this.centre.copy(at);
      const a = Math.random() * Math.PI * 2;
      this.from.set(Math.cos(a), 0, Math.sin(a));
    }
    this.target.copy(at);
    this.wanted = true;
  }

  update(dt: number, t: number) {
    this.presence = this.wanted ? Math.min(1, this.presence + dt / 2.2) : Math.max(0, this.presence - dt / 1.8);
    const shown = this.presence > 0.001;
    this.bodies.count = shown ? COUNT : 0;
    this.wings.count = shown ? COUNT * 2 : 0;
    if (!shown) return;
    this.centre.lerp(this.target, follow(dt, 0.9));
    // Eased in and out: far off and high up, then round the hex.
    const k = this.presence * this.presence * (3 - 2 * this.presence);
    this.crows.forEach((c, i) => {
      c.angle += c.speed * dt / Math.max(0.2, c.radius) * 0.35;
      if (c.flap > 0) {
        c.flap -= dt;
        if (c.flap <= 0) c.glide = 1.2 + Math.random() * 2.2;
      } else if ((c.glide -= dt) <= 0) c.flap = 0.6 + Math.random() * 1.2;
      // Wings beat while flapping and settle into a shallow glide otherwise.
      const want = c.flap > 0 ? Math.sin(t * 13 + c.phase) * 0.75 : 0.12 + Math.sin(t * 1.7 + c.phase) * 0.05;
      c.wing += (want - c.wing) * follow(dt, c.flap > 0 ? 30 : 6);
      const r = c.radius * (1 + Math.sin(t * 0.37 + c.phase) * 0.15);
      const dir = Math.sign(c.speed);
      const cx = this.centre.x + Math.cos(c.angle) * r, cz = this.centre.z + Math.sin(c.angle) * r;
      const cy = this.centre.y + c.height + Math.sin(t * 0.9 + c.phase) * 0.06;
      // From afar: out along `from`, and higher.
      const far = (1 - k) * (5 + i * 0.4);
      _p.set(cx + this.from.x * far, cy + (1 - k) * 2.5, cz + this.from.z * far);
      // Heading along the circle, banked into the turn.
      const heading = c.angle + (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      _e.set(-0.42 * dir, -heading, 0, 'YXZ');
      _q.setFromEuler(_e);
      // (Birds are drawn about twice life against the people, so they read in flight: see
      // life/pasture.ts on sizes.)
      const size = 0.62 * Math.min(1, this.presence * 4);
      this.bodies.setMatrixAt(i, _m.compose(_p, _q, _s.setScalar(size)));
      for (const side of [1, -1]) {
        // The right wing as modelled; the left turned over onto the other side.
        _w.makeRotationX(side > 0 ? -c.wing : Math.PI + c.wing);
        _w.setPosition(0.004, 0.004, 0);
        this.wings.setMatrixAt(i * 2 + (side > 0 ? 0 : 1), _w.premultiply(_m));
      }
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.wings.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.bodies.dispose();
    this.wings.dispose();
    this.group.removeFromParent();
  }
}
