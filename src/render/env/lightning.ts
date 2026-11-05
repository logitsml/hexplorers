// Lightning for storms: a branching channel of white-hot light from the cloud base down to the
// sea. It is drawn as ribbons turned to the camera when it strikes: a thin, very bright core
// inside a wide violet halo (which the bloom spreads further), forking into branches that
// thin out and stop short, with a glow on the water where it lands. Weather times the strokes
// and flashes the scene with them. One mesh, kept in the scene from the start (so its shaders
// are compiled with everything else) and reshaped for each strike.

import * as THREE from 'three/webgpu';
import { attribute, clamp, dot, float, mix, step, uniform, vec3 } from 'three/tsl';
import { SEA_LEVEL } from '../board/layout';

/** Room for the main channel, its branches and the glow (in quads). */
const MAX_QUADS = 520;

const tmp = new THREE.Vector3();
const side = new THREE.Vector3();
const dir = new THREE.Vector3();

export class Lightning {
  readonly mesh: THREE.Mesh;
  /** How bright the channel is now: the strokes' envelope (Weather drives it). */
  readonly glow = uniform(0);
  /** How much of the branches still shows: they light with the first stroke, then fade. */
  readonly branches = uniform(1);
  private geometry = new THREE.BufferGeometry();
  private pos: Float32Array;
  private edge: Float32Array;
  private kind: Float32Array;
  private alpha: Float32Array;
  private branch: Float32Array;
  private quads = 0;

  constructor() {
    const n = MAX_QUADS * 6;
    this.pos = new Float32Array(n * 3);
    this.edge = new Float32Array(n * 2);
    this.kind = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.branch = new Float32Array(n);
    const g = this.geometry;
    // (Not marked dynamic: three would send them again at every draw of the bolt, which is built once a strike.)
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aEdge', new THREE.BufferAttribute(this.edge, 2));
    g.setAttribute('aKind', new THREE.BufferAttribute(this.kind, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aBranch', new THREE.BufferAttribute(this.branch, 1));
    g.setDrawRange(0, 0);

    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    // Additive, so both faces go in one draw rather than three's two passes.
    m.forceSinglePass = true;
    // Kinds: 0 the core, 1 its halo, 2 the glow on the water. Ribbons fade across their width
    // (edge.x), the glow from its middle out (edge.xy).
    const e = attribute<'vec2'>('aEdge', 'vec2');
    const k = attribute<'float'>('aKind', 'float');
    const isGlow = step(1.5, k);
    const isHalo = step(0.5, k).mul(float(1).sub(isGlow));
    const isCore = float(1).sub(step(0.5, k));
    const r2 = mix(e.x.mul(e.x), dot(e, e), isGlow);
    const fall = clamp(float(1).sub(r2), 0, 1);
    // Far brighter than white at the core, so it burns out and blooms.
    const color = vec3(1.0, 0.97, 1.0)
      .mul(isCore.mul(5))
      .add(vec3(0.55, 0.6, 1.0).mul(isHalo.mul(1.6)))
      .add(vec3(0.75, 0.8, 1.0).mul(isGlow.mul(1.5)));
    m.colorNode = color;
    m.opacityNode = fall
      .mul(fall)
      .mul(attribute<'float'>('aAlpha', 'float'))
      .mul(mix(float(1), this.branches, attribute<'float'>('aBranch', 'float')))
      .mul(this.glow);
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'lightning';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
  }

  /** Shape a new bolt striking `ground` (on the sea), seen from `eye`. */
  shape(ground: THREE.Vector3, eye: THREE.Vector3) {
    this.quads = 0;
    const distance = eye.distanceTo(ground);
    // Wide enough to read at any distance: a few pixels of core, a broad halo round it.
    const core = Math.max(0.045, distance * 0.0032);
    // From the cloud base; but seen from high above (the game's view), from below the camera, or
    // most of the bolt would be behind it.
    const height = Math.min(34 + Math.random() * 14, Math.max(8, (eye.y - SEA_LEVEL) * 0.8));
    // The channel leans a little and starts somewhere in the cloud above.
    const top = new THREE.Vector3(ground.x + (Math.random() - 0.5) * height * 0.5, SEA_LEVEL + height, ground.z + (Math.random() - 0.5) * height * 0.5);
    const main = channel(top, ground.clone().setY(SEA_LEVEL), 6, 0.32);
    this.ribbon(main, core, eye, 0);
    // Branches fork off the upper two thirds, heading down and outwards, and stop short.
    const forks = 3 + Math.floor(Math.random() * 4);
    for (let f = 0; f < forks; f++) {
      const i = Math.floor((0.08 + Math.random() * 0.6) * (main.length - 1));
      const from = main[i];
      const out = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      const len = height * (0.15 + Math.random() * 0.3);
      const to = from.clone().addScaledVector(out, len * (0.5 + Math.random() * 0.5)).add(new THREE.Vector3(0, -len * (0.6 + Math.random() * 0.5), 0));
      const twig = channel(from, to, 4, 0.38);
      this.ribbon(twig, core * 0.55, eye, 1, 0.75);
      // And sometimes a fork of the fork.
      if (Math.random() < 0.5) {
        const j = Math.floor(twig.length * (0.3 + Math.random() * 0.4));
        const out2 = out.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, (Math.random() - 0.5) * 2);
        const to2 = twig[j].clone().addScaledVector(out2, len * 0.3).add(new THREE.Vector3(0, -len * 0.35, 0));
        this.ribbon(channel(twig[j], to2, 3, 0.4), core * 0.35, eye, 1, 0.55);
      }
    }
    // The water lights up where it lands.
    this.glowDisc(ground.clone().setY(SEA_LEVEL + 0.02), Math.max(0.55, core * 12));
    const g = this.geometry;
    for (const name of ['position', 'aEdge', 'aKind', 'aAlpha', 'aBranch']) g.getAttribute(name).needsUpdate = true;
    g.setDrawRange(0, this.quads * 6);
  }

  /** Core and halo quads along a polyline, turned to face `eye`. */
  private ribbon(points: THREE.Vector3[], width: number, eye: THREE.Vector3, isBranch: number, alpha = 1) {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      dir.subVectors(b, a);
      tmp.addVectors(a, b).multiplyScalar(0.5).sub(eye).negate();
      side.crossVectors(dir, tmp).normalize();
      // Thinner towards the ends of a branch, as the charge runs out.
      const taper = isBranch ? 1 - (0.7 * i) / points.length : 1;
      this.quad(a, b, side, width * taper, 0, alpha, isBranch);
      this.quad(a, b, side, width * taper * 4.5, 1, alpha * 0.28, isBranch);
    }
  }

  private quad(a: THREE.Vector3, b: THREE.Vector3, s: THREE.Vector3, width: number, kind: number, alpha: number, isBranch: number) {
    if (this.quads >= MAX_QUADS) return;
    const h = width / 2;
    const corners: [THREE.Vector3, number][] = [
      [a, -1],
      [a, 1],
      [b, 1],
      [a, -1],
      [b, 1],
      [b, -1],
    ];
    this.write(corners.map(([p, u]) => [p.x + s.x * h * u, p.y + s.y * h * u, p.z + s.z * h * u, u, 0]), kind, alpha, isBranch);
  }

  private glowDisc(c: THREE.Vector3, r: number) {
    const v = (u: number, w: number) => [c.x + u * r, c.y, c.z + w * r, u, w];
    this.write([v(-1, -1), v(1, -1), v(1, 1), v(-1, -1), v(1, 1), v(-1, 1)], 2, 0.6, 0);
  }

  private write(verts: number[][], kind: number, alpha: number, isBranch: number) {
    if (this.quads >= MAX_QUADS) return;
    let o = this.quads * 6;
    for (const [x, y, z, u, w] of verts) {
      this.pos.set([x, y, z], o * 3);
      this.edge.set([u, w], o * 2);
      this.kind[o] = kind;
      this.alpha[o] = alpha;
      this.branch[o] = isBranch;
      o++;
    }
    this.quads++;
  }

  dispose() {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/**
 * A jagged path from `a` to `b` by midpoint displacement: each halving kinks the middle of
 * every segment sideways by up to `rough` of its length, so the bolt is crooked at every scale.
 */
function channel(a: THREE.Vector3, b: THREE.Vector3, depth: number, rough: number): THREE.Vector3[] {
  let pts = [a.clone(), b.clone()];
  for (let d = 0; d < depth; d++) {
    const next: THREE.Vector3[] = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      const len = p.distanceTo(q);
      const mid = p.clone().add(q).multiplyScalar(0.5);
      mid.x += (Math.random() - 0.5) * 2 * rough * len;
      mid.z += (Math.random() - 0.5) * 2 * rough * len;
      mid.y += (Math.random() - 0.5) * rough * len * 0.6;
      next.push(mid, q);
    }
    pts = next;
  }
  return pts;
}
