// Ground glow: the stand-in for lamp light where there is none. Clustered lamp light (lampLights.ts)
// needs WebGPU and the High or Ultra preset; elsewhere the lamps cast nothing, and a camp, a
// resting warden or a foundry at night is left with only its own lit surfaces. So a lamp that asks
// for one (fires, furnaces, a gin's lantern and its pitch fire: never a window, whose lit glass still shows) gets
// a soft pool of its colour laid on the ground under it, added to what's there, shown only while
// real light is off and only after dusk. One instanced mesh draws them all.

import * as THREE from 'three/webgpu';
import { float, smoothstep, uv, vec3 } from 'three/tsl';
import { DETAIL_LAYER } from '../board/layout';
import { instancedMesh } from '../board/instancing';

/** The most pools at once (a late game's camps, resting wardens, foundries and gins, with room). */
const POOLS = 64;

export class GroundGlow {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private inv = new THREE.Matrix4();

  constructor() {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    // Brightest under the fire, falling off smoothly to nothing at the rim (no texture: a
    // distance from the quad's middle). The pool's colour and strength are the instance's colour.
    const d = uv().sub(0.5).length().mul(2);
    const fall = smoothstep(float(1), float(0), d);
    material.colorNode = vec3(1, 1, 1);
    material.opacityNode = fall.mul(fall);
    const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.mesh = instancedMesh(quad, material, POOLS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, this.c.setRGB(0, 0, 0));
    this.mesh.count = 1;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    // (Pools are spread over the island and move with their pieces: bounds would go stale.)
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'ground glow';
    // (Not worth a pass of the sea's mirror: see DETAIL_LAYER.)
    this.mesh.layers.set(DETAIL_LAYER);
    // Drawn after the ground and the pieces it lies over.
    this.mesh.renderOrder = 2;
  }

  /** Start a frame's pools (positions are given in the world; the mesh may hang anywhere). */
  begin() {
    this.n = 0;
    const parent = this.mesh.parent;
    if (parent) this.inv.copy(parent.matrixWorld).invert();
    else this.inv.identity();
  }

  /** A pool of radius r, lying level at (x, y, z), in linear colour `color` at `strength`. */
  put(x: number, y: number, z: number, r: number, color: THREE.Color, strength: number) {
    if (this.n >= POOLS || strength <= 0.001) return;
    this.m.compose(this.p.set(x, y, z), this.q, this.s.setScalar(r)).premultiply(this.inv);
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, this.c.copy(color).multiplyScalar(strength));
    this.n++;
  }

  end() {
    // (At least one instance, a dark one when there's none, so the stand-in compiles as drawn.)
    if (this.n === 0) this.mesh.setColorAt(0, this.c.setRGB(0, 0, 0));
    this.mesh.count = Math.max(1, this.n);
    this.mesh.visible = this.n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
