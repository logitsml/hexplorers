// Collects instance transforms per geometry variant and produces InstancedMeshes
// with the per-instance attributes the shared materials expect (aTile, aPhase, aColor).

import * as THREE from 'three/webgpu';
import { DETAIL_LAYER } from './layout';

export interface InstanceSpec {
  matrix: THREE.Matrix4;
  /** Its transform as placed, before anything trod it down (see Decor.trample). */
  orig?: THREE.Matrix4;
  tile: number;
  phase?: number;
  color?: THREE.Color;
}

class InstanceBatch {
  items: InstanceSpec[] = [];
  mesh: THREE.InstancedMesh | null = null;

  constructor(
    public geometry: THREE.BufferGeometry,
    public material: THREE.Material,
    /** `detail`: small clutter kept out of the water's mirror (see DETAIL_LAYER). */
    public opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string; detail?: boolean } = {},
  ) {}

  add(spec: InstanceSpec): number {
    this.items.push(spec);
    return this.items.length - 1;
  }

  build(): THREE.InstancedMesh | null {
    if (this.items.length === 0) return null;
    const n = this.items.length;
    // Instanced attributes live on a per-batch clone so shared variant geometry stays clean.
    const geo = this.geometry.clone();
    // Per-instance data in one interleaved buffer (tile, phase, rise scale, colour): WebGPU
    // allows only 8 vertex buffers per pipeline, and the instance matrix already takes one.
    const STRIDE = 6;
    const data = new Float32Array(n * STRIDE);
    const col1 = new THREE.Vector3();
    const mesh = new THREE.InstancedMesh(geo, this.material, capacity(n));
    // (Only the batch's own are drawn: the rest of the capacity is never shown.)
    mesh.count = n;
    this.items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.matrix);
      const c = it.color ?? WHITE;
      const o = i * STRIDE;
      data[o] = it.tile;
      data[o + 1] = it.phase ?? phaseAt(it.matrix.elements[12], it.matrix.elements[14]);
      // Inverse vertical scale, so the tile-rise offset applied in local space is world-sized.
      data[o + 2] = 1 / Math.max(1e-4, col1.setFromMatrixColumn(it.matrix, 1).length());
      data[o + 3] = c.r;
      data[o + 4] = c.g;
      data[o + 5] = c.b;
    });
    const buf = new THREE.InstancedInterleavedBuffer(data, STRIDE, 1);
    geo.setAttribute('aTile', new THREE.InterleavedBufferAttribute(buf, 1, 0));
    geo.setAttribute('aPhase', new THREE.InterleavedBufferAttribute(buf, 1, 1));
    geo.setAttribute('aRiseScale', new THREE.InterleavedBufferAttribute(buf, 1, 2));
    geo.setAttribute('aColor', new THREE.InterleavedBufferAttribute(buf, 3, 3));
    if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = this.opts.castShadow ?? true;
    mesh.receiveShadow = this.opts.receiveShadow ?? true;
    mesh.name = this.opts.name ?? '';
    if (this.opts.detail) mesh.layers.set(DETAIL_LAYER);
    mesh.computeBoundingSphere();
    this.mesh = mesh;
    return mesh;
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.mesh?.dispose();
    this.mesh = null;
  }
}

const WHITE = new THREE.Color(1, 1, 1);

/** A sway phase from where an instance stands: the same on every load, as the rest of the board. */
function phaseAt(x: number, z: number): number {
  const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * 6.283;
}

/**
 * The instance capacity for `n` instances: the next power of two (at least 64) while the matrices
 * fit three's uniform buffer, `n` past it. Up to 64 KiB of matrices three declares them as a
 * fixed-length array in the vertex shader, so two batches of one material share their shaders
 * and node builds only at the same capacity (see core/instanceShaders.ts and instanceBuilds.ts).
 * Most of a board's batches are small, and each size has builds of its own in every pass: a floor
 * of 64 lets nearly all of them share, for 4 KB of matrices a small batch. Beyond 64 KiB they are vertex attributes,
 * with no length in the shader.
 */
export function capacity(n: number) {
  const p = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, n))));
  return p * 64 <= 65536 ? p : n;
}

/**
 * An instanced mesh of `n` instances made at its capacity (see capacity), drawing all `n` to
 * start with as three's own would: its owner sets `count` as it shows more or fewer.
 */
export function instancedMesh<G extends THREE.BufferGeometry, M extends THREE.Material>(geometry: G, material: M, n: number): THREE.InstancedMesh<G, M> {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity(n));
  mesh.count = n;
  return mesh;
}

/** Groups batches by key so modules can say batch('pine0').add(...). */
export class BatchSet {
  batches = new Map<string, InstanceBatch>();

  define(key: string, geometry: THREE.BufferGeometry, material: THREE.Material, opts?: InstanceBatch['opts']) {
    const b = new InstanceBatch(geometry, material, opts);
    this.batches.set(key, b);
    return b;
  }

  get(key: string): InstanceBatch {
    const b = this.batches.get(key);
    if (!b) throw new Error(`Unknown batch ${key}`);
    return b;
  }

  buildAll(parent: THREE.Object3D) {
    for (const b of this.batches.values()) {
      const m = b.build();
      if (m) parent.add(m);
    }
  }

  dispose() {
    for (const b of this.batches.values()) {
      b.dispose();
      b.geometry.dispose();
    }
    this.batches.clear();
  }
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export function trs(x: number, y: number, z: number, ry = 0, s = 1, sy = s, rx = 0, rz = 0): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _s.set(s, sy, s);
  _p.set(x, y, z);
  return new THREE.Matrix4().compose(_p, _q, _s);
}
