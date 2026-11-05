// Small mesh-building toolkit for procedural props: accumulate triangles with
// colours, transform sub-parts, and soften normals for volumetric foliage.

import * as THREE from 'three/webgpu';

export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  sur: number[] = [];
  /** Surface pattern for vertices added from now on (see surfaces.ts); 0 = plain colour. */
  surfaceId = 0;

  get vertexCount() {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, c: THREE.Color, nx = 0, ny = 1, nz = 0): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(c.r, c.g, c.b);
    this.sur.push(this.surfaceId);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Append a geometry (positions/normals/colours) with a transform and colour. */
  addGeometry(g: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.Color | ((x: number, y: number, z: number, out: THREE.Color) => void)) {
    const base = this.vertexCount;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    const v = new THREE.Vector3();
    const vn = new THREE.Vector3();
    const c = new THREE.Color();
    const gc = g.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      if (n) vn.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      else vn.set(0, 1, 0);
      if (typeof color === 'function') color(v.x, v.y, v.z, c);
      else c.copy(color);
      if (gc) c.multiply(new THREE.Color(gc.getX(i), gc.getY(i), gc.getZ(i)));
      this.vertex(v.x, v.y, v.z, c, vn.x, vn.y, vn.z);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  build(computeNormals = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    // Only models that use surface patterns carry the attribute (merges need matching sets).
    if (this.sur.some((v) => v !== 0)) g.setAttribute('surface', new THREE.Float32BufferAttribute(this.sur, 1));
    g.setIndex(this.idx);
    if (computeNormals) g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Blend each vertex normal towards the direction from a centre point (soft, volumetric foliage shading). */
export function softenNormals(g: THREE.BufferGeometry, center: THREE.Vector3 | ((x: number, y: number, z: number) => THREE.Vector3), amount: number) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const v = new THREE.Vector3();
  const vn = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    vn.fromBufferAttribute(n, i);
    const c = typeof center === 'function' ? center(v.x, v.y, v.z) : center;
    d.subVectors(v, c).normalize();
    vn.lerp(d, amount).normalize();
    n.setXYZ(i, vn.x, vn.y, vn.z);
  }
  n.needsUpdate = true;
}

/** Displace vertices of an (indexed) geometry along their normals with a function. */
export function displace(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => number) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const v = new THREE.Vector3();
  const vn = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    vn.fromBufferAttribute(n, i);
    const d = fn(v.x, v.y, v.z);
    p.setXYZ(i, v.x + vn.x * d, v.y + vn.y * d, v.z + vn.z * d);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
}

/** Icosphere with merged vertices (so displacement keeps it watertight). */
export function smoothSphere(radius: number, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  g.deleteAttribute('uv');
  const merged = mergeVerticesSimple(g);
  g.dispose();
  merged.computeVertexNormals();
  return merged;
}

function mergeVerticesSimple(g: THREE.BufferGeometry, precision = 1e-4): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const map = new Map<string, number>();
  const out: number[] = [];
  const idx: number[] = [];
  const src = g.getIndex();
  const count = src ? src.count : p.count;
  for (let i = 0; i < count; i++) {
    const vi = src ? src.getX(i) : i;
    const x = p.getX(vi), y = p.getY(vi), z = p.getZ(vi);
    const key = `${Math.round(x / precision)},${Math.round(y / precision)},${Math.round(z / precision)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(x, y, z);
    }
    idx.push(id);
  }
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  r.setIndex(idx);
  return r;
}

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export function compose(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));
}
