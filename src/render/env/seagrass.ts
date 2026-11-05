// Seagrass and kelp swaying on the shallow shelf around the island. Visible through the
// clear shallows; each clump leans with the surge in a slow back-and-forth.

import * as THREE from 'three/webgpu';
import { Fn, attribute, clamp, cos, positionGeometry, positionLocal, sin, time } from 'three/tsl';
import { DETAIL_LAYER, SEA_LEVEL, type SdfField } from '../board/layout';
import { Rand } from '../util/noise';
import { instancedMesh } from '../board/instancing';

const MAX = 900;

function bladeGeometry(): THREE.BufferGeometry {
  // A clump of tapered, gently curved ribbons around the origin.
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const SEG = 6;
  const blades = 5;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.7;
    const ox = Math.cos(a) * 0.035, oz = Math.sin(a) * 0.035;
    const h = 0.22 + ((b * 37) % 11) / 11 * 0.16;
    const lean = 0.05 + ((b * 13) % 7) / 7 * 0.05;
    const w0 = 0.022;
    const base = pos.length / 3;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const w = w0 * (1 - t * 0.85);
      const y = t * h;
      const bend = lean * t * t;
      const cx = ox + Math.cos(a) * bend, cz = oz + Math.sin(a) * bend;
      const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
      pos.push(cx - px, y, cz - pz, cx + px, y, cz + pz);
      const g = 0.26 + t * 0.16;
      col.push(0.13 + t * 0.08, g, 0.11, 0.13 + t * 0.08, g, 0.11);
      if (i < SEG) {
        const k = base + i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class Seagrass {
  mesh: THREE.InstancedMesh;
  private phase: THREE.InstancedBufferAttribute;

  constructor(sdf: SdfField) {
    const geo = bladeGeometry();
    this.phase = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    geo.setAttribute('aPhase', this.phase);
    const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    const ph = attribute<'float'>('aPhase', 'float');
    mat.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const h = clamp(positionGeometry.y.div(0.35), 0, 1);
      const surge = sin(time.mul(0.9).add(ph)).mul(0.07).add(sin(time.mul(2.1).add(ph.mul(2.3))).mul(0.015));
      p.x.addAssign(surge.mul(h).mul(h));
      p.z.addAssign(cos(time.mul(0.7).add(ph.mul(1.3))).mul(0.04).mul(h).mul(h));
      return p;
    })();
    this.mesh = instancedMesh(geo, mat, MAX);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    // All under water: kept out of the sea's mirror.
    this.mesh.layers.set(DETAIL_LAYER);
    this.place(sdf);
  }

  place(sdf: SdfField) {
    const r = new Rand(91);
    const rnd = () => r.next();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    let n = 0;
    const R = sdf.extent * 0.95;
    for (let tries = 0; tries < 40000 && n < MAX; tries++) {
      const x = (rnd() * 2 - 1) * R, z = (rnd() * 2 - 1) * R;
      const s = sdf.sample(x, z);
      if (s < 0.6 || s > 1.25) continue;
      // Patchy meadows rather than an even carpet.
      const patch = Math.sin(x * 1.7 + Math.sin(z * 1.3) * 2) * Math.cos(z * 1.9 - x * 0.6);
      if (patch < 0.15) continue;
      const shelf = THREE.MathUtils.smoothstep(s, 0.05, 1.8);
      const depth = 0.42 + shelf * 3.2;
      const y = SEA_LEVEL - depth;
      const k = 0.8 + rnd() * 0.9;
      // Tallest blade is ~0.38 (+ sway); keep every tip well under the surface.
      const sy = Math.min(k * (0.8 + rnd() * 0.7), (depth - 0.14) / 0.42);
      if (sy < 0.3) continue;
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      m.compose(v.set(x, y - 0.01, z), q, sc.set(k, sy, k));
      this.mesh.setMatrixAt(n, m);
      this.phase.setX(n, rnd() * Math.PI * 2);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.phase.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
