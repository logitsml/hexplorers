// The kit the expansions' pieces are modelled with (ships.ts, figures.ts, works.ts), in the idiom of
// pieces.ts: built from primitives in a MeshBuilder, coloured on the vertices (stored as square roots
// of what they render as: the pieces' material squares them, see vertexAlbedo), with `glow` for
// lanterns, windows and fires, `sway` for sailcloth and banners, and `surface` for masonry, roof
// courses and canvas. Every model is drawn by the pieces' own material in one batch (see marks.ts), so
// each carries the same three attributes, and none needs a shader of its own.
//
// Units: like the settlement and the city, a model is built in "piece units" and placed at
// PIECE_SCALE (1.85), so its coursed stone matches theirs. Bows, fronts and spans run along +x;
// the ground (or the waterline, for anything afloat) is y = 0.

import * as THREE from 'three/webgpu';
import { MeshBuilder, compose } from './geom';

export const C = (h: string) => new THREE.Color(h);

/**
 * A vertex colour that renders as `hex`: its square root (the material squares vertex colours),
 * for the colours here that are chosen by how they should look rather than tuned by eye.
 */
export function shown(hex: string): THREE.Color {
  const c = new THREE.Color(hex);
  return c.setRGB(Math.sqrt(c.r), Math.sqrt(c.g), Math.sqrt(c.b));
}

export type Paint = THREE.Color | string | ((x: number, y: number, z: number, out: THREE.Color) => void);

/**
 * A model being assembled: a MeshBuilder plus the vertex ranges that glow at night or sway in
 * the wind (as pieces.ts marks them), finished with all three attributes the material reads.
 */
export class Kit {
  readonly b = new MeshBuilder();
  private glow: [number, number, number][] = [];
  private sway: { from: number; to: number; top: number; drop: number; amount: number; axis: 'y' | 'x' }[] = [];

  /** Append a geometry (consumed) under a transform, in a colour or a colour function. */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, c: Paint) {
    this.b.addGeometry(g, m, typeof c === 'string' ? C(c) : c);
    g.dispose();
  }

  /** Everything added inside fn carries this surface pattern (see surfaces.ts). */
  surface(id: number, fn: () => void) {
    const was = this.b.surfaceId;
    this.b.surfaceId = id;
    fn();
    this.b.surfaceId = was;
  }

  /** Everything added inside fn glows at night (by `level`: a window 1, embers more). */
  lit(fn: () => void, level = 1) {
    const s = this.b.vertexCount;
    fn();
    this.glow.push([s, this.b.vertexCount, level]);
  }

  /**
   * Everything added inside fn sways, more the further it hangs below `top` (over `drop`), or,
   * with axis 'x', the further it flies out past x = `top` (a pennant from its pole).
   */
  swaying(top: number, drop: number, amount: number, fn: () => void, axis: 'y' | 'x' = 'y') {
    const s = this.b.vertexCount;
    fn();
    this.sway.push({ from: s, to: this.b.vertexCount, top, drop, amount, axis });
  }

  /** A rod of radius r from a to b. */
  rod(a: THREE.Vector3, b: THREE.Vector3, r: number, c: Paint, sides = 5) {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r, r, len, sides, 1, true);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    this.add(g, new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), c);
  }

  /**
   * A sheet of cloth both ways round (the material draws front faces only): a grid of nu × nv
   * cells through `at(u, v)`, coloured by `paint(u, v)`, its two faces `thick` apart. They stand
   * well apart: the shadow pass draws the face turned from the sun, and a sunlit face hardly in
   * front of it shadowed itself in speckles.
   */
  cloth(nu: number, nv: number, at: (u: number, v: number) => THREE.Vector3, paint: (u: number, v: number) => THREE.Color, thick = 0.0016) {
    const p = (u: number, v: number) => at(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
    for (const side of [1, -1]) {
      const rows: number[][] = [];
      for (let j = 0; j <= nv; j++) {
        const row: number[] = [];
        for (let i = 0; i <= nu; i++) {
          const u = i / nu, v = j / nv;
          const du = p(u + 0.01, v).sub(p(u - 0.01, v));
          const dv = p(u, v + 0.01).sub(p(u, v - 0.01));
          const n = du.cross(dv);
          if (n.lengthSq() < 1e-14) n.set(0, 0, 1);
          n.normalize().multiplyScalar(side);
          const q = p(u, v).addScaledVector(n, thick / 2);
          // Shaded as if lit through: both faces' normals lean up to the sky, so a banner or sail
          // seen from its far side reads in its colours rather than as a black cut-out.
          const lit = n.clone().add(UP_LEAN).normalize();
          row.push(this.b.vertex(q.x, q.y, q.z, paint(u, v), lit.x, lit.y, lit.z));
        }
        rows.push(row);
      }
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const [a, b, c, d] = [rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]];
          // (Wound so each face is seen from the side its normal points to: (b − a) × (d − a) runs along n.)
          if (side > 0) this.b.quad(a, b, c, d);
          else this.b.quad(a, d, c, b);
        }
    }
  }

  build(): THREE.BufferGeometry {
    const g = this.b.build(false);
    const pos = g.getAttribute('position');
    const n = pos.count;
    const glow = new Float32Array(n);
    const sway = new Float32Array(n);
    for (const [a, b, level] of this.glow) glow.fill(level, a, b);
    for (const r of this.sway)
      for (let i = r.from; i < r.to; i++) {
        const d = r.axis === 'y' ? r.top - pos.getY(i) : pos.getX(i) - r.top;
        sway[i] = r.amount * Math.min(1, Math.max(0, Math.abs(d) / r.drop));
      }
    g.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
    g.setAttribute('sway', new THREE.BufferAttribute(sway, 1));
    if (!g.getAttribute('surface')) g.setAttribute('surface', new THREE.BufferAttribute(new Float32Array(n), 1));
    return g;
  }
}

export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** How far cloth normals lean to the sky (see Kit.cloth). */
const UP_LEAN = new THREE.Vector3(0, 0.5, 0);


// ---------------------------------------------------------------------------------------------
// Small props more than one kind of piece carries.
// ---------------------------------------------------------------------------------------------

export function streamer(k: Kit, at: THREE.Vector3, len: number, h: number, c: THREE.Color, hem?: THREE.Color) {
  k.swaying(at.x, len, 1, () =>
    k.cloth(6, 2, (u, v) => {
      const depth = h * (1 - 0.55 * u);
      const notch = u > 0.99 ? Math.sin(Math.PI * v) * depth * 0.9 : 0;
      return v3(at.x - u * len + notch, at.y - (v - 0.5) * depth - u * h * 0.25, Math.sin(u * 5) * 0.002);
    }, (u) => (hem && u < 0.12 ? hem : c)), 'x');
}

/** A lantern on a bracket: a lit glass in a dark frame. */
export function lanternAt(k: Kit, x: number, y: number, z: number, s = 1) {
  k.lit(() => k.add(new THREE.BoxGeometry(0.006 * s, 0.008 * s, 0.006 * s), compose(x, y, z), '#ffd27a'), 1.4);
  k.add(new THREE.ConeGeometry(0.0055 * s, 0.004 * s, 4), compose(x, y + 0.006 * s, z, 0, Math.PI / 4, 0), '#2a2420');
}

/** Vertical stripes across a sail: `n` of them, alternating, with an optional band along the head. */
export const stripes = (n: number, a: THREE.Color, b: THREE.Color, head?: THREE.Color) => (u: number, v: number) => (head && v < 0.09 ? head : Math.floor(u * n * 0.9999) % 2 ? b : a);

/** A barrel standing on end: staves and two dark hoops. */
export function barrel(k: Kit, x: number, y: number, z: number, r = 0.0055, hgt = 0.011) {
  k.add(new THREE.CylinderGeometry(r, r, hgt, 8), compose(x, y + hgt / 2, z), (_x, yy, _z, o) => o.set(Math.abs(yy - y - hgt / 2) > hgt * 0.32 ? '#3d3a36' : '#8a5f38'));
}
