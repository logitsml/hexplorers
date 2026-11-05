// Many stand-ins of one look drawn as one batched mesh (WebGPU): the buildings on the board, the
// expansions' moving parts. Like propBatches.ts's instanced meshes, but its parts may be of any
// shape: a batched mesh holds many geometries and draws every instance of all of them as one
// object, so three prepares it once a frame rather than once a part.
//
// A module places, moves, scales, hides and parents a stand-in (an empty object) as it would the
// mesh; just before each frame is drawn (Stage.beforeDraw) every stand-in's place and visibility
// are copied into its instance, and one gone from the scene gives its instance up.
//
// Every instance shown is drawn, unculled and unsorted: one list for every camera. three would
// cull and sort a batched mesh again for each camera that draws it (the sun's shadow, the sea's
// mirror, the view) into one texture of which instance each draw is, which the GPU reads as the
// last camera left it, while each pass draws the shapes its own camera listed: pieces swapped
// places (a settlement drawn where a city stands). Nor is it culled as a whole: three works its
// bounds out once and never again, though its stand-ins join and move. What it draws still
// changes as they show and hide, which a render bundle wouldn't replay, so it hangs outside the
// board's bundles.
//
// Its material is made for it (it reads each instance's transform from the mesh's own texture:
// see core/batchMatrix.ts), and made again should the mesh need room for more instances (a new
// texture). It lets itself go once its group has left the scene for good (its board was taken
// down).
//
// A batched mesh's geometry has no vertex attributes at all until its first shape joins, and
// three builds a shader for the geometry as it finds it: one built before then (a precompile's,
// with the mesh still empty in the scene) reads no positions, and three never builds it again
// once shapes join, so every instance would be drawn as nothing (the buildings' batch, made empty
// at a game's start, would leave every settlement and city invisible). So shapes known ahead are
// joined as it is made (`shapes`), and should a first shape still join later, its material is
// built afresh.
//
// (Not on WebGL2: there three's batched mesh loses the geometry's vertex colours.)

import { writeMatrix } from '../util/matrices';
import * as THREE from 'three/webgpu';

interface Stand {
  obj: THREE.Object3D;
  id: number;
  seen: boolean;
}

const inverse = new THREE.Matrix4();
const place = new THREE.Matrix4();

export class StandInBatch {
  readonly mesh: THREE.BatchedMesh;
  private geos = new Map<THREE.BufferGeometry, number>();
  private stands: Stand[] = [];
  private seen = false;
  private readonly synced = () => this.sync();

  constructor(
    private make: (mesh: THREE.BatchedMesh) => THREE.Material,
    size: { instances: number; vertices: number; indices: number },
    flags: { castShadow: boolean; receiveShadow: boolean; layers?: number },
    parent: THREE.Object3D,
    private stage: { beforeDraw: Set<() => void> },
    name: string,
    /** Shapes its stand-ins will take, joined now (see the file's comment). */
    shapes: THREE.BufferGeometry[] = [],
  ) {
    const mesh = new THREE.BatchedMesh(size.instances, size.vertices, size.indices);
    mesh.material = make(mesh);
    mesh.castShadow = flags.castShadow;
    mesh.receiveShadow = flags.receiveShadow;
    // (One draw list for every camera, and its bounds never stale: see the file's comment.)
    mesh.perObjectFrustumCulled = mesh.sortObjects = mesh.frustumCulled = false;
    if (flags.layers !== undefined) mesh.layers.mask = flags.layers;
    mesh.name = name;
    this.mesh = mesh;
    for (const g of shapes) this.shape(g);
    parent.add(mesh);
    stage.beforeDraw.add(this.synced);
  }

  /** `geo` joined as one of the mesh's shapes (once), its id; undefined if it can't join (its vertex attributes aren't the others'). */
  private shape(geo: THREE.BufferGeometry): number | undefined {
    let gid = this.geos.get(geo);
    if (gid === undefined) {
      try {
        gid = this.addGeometry(geo);
      } catch {
        return undefined;
      }
      this.geos.set(geo, gid);
    }
    return gid;
  }

  /**
   * Draw `obj` (a stand-in) as an instance of `geo`. False when `geo` can't join this batch (its
   * vertex attributes aren't the others'): the caller draws it as a mesh instead.
   */
  add(obj: THREE.Object3D, geo: THREE.BufferGeometry): boolean {
    const mesh = this.mesh;
    const gid = this.shape(geo);
    if (gid === undefined) return false;
    if (mesh.instanceCount >= mesh.maxInstanceCount) {
      mesh.setInstanceCount(mesh.maxInstanceCount * 2);
      // (Its matrices are in a new texture, which the material reads.)
      const old = mesh.material as THREE.Material;
      mesh.material = this.make(mesh);
      old.dispose();
    }
    const id = mesh.addInstance(gid);
    // (Until its first frame: nowhere.)
    mesh.setVisibleAt(id, false);
    this.stands.push({ obj, id, seen: false });
    this.ids.set(obj, id);
    return true;
  }

  private ids = new WeakMap<THREE.Object3D, number>();

  /**
   * The colour `obj`'s instance is drawn in, its material's times this (see setColorAt). Set one
   * before the mesh is first compiled: the instance colours are part of its shaders.
   */
  setColor(obj: THREE.Object3D, color: THREE.Color) {
    const id = this.ids.get(obj);
    if (id !== undefined) this.mesh.setColorAt(id, color);
  }

  private addGeometry(geo: THREE.BufferGeometry) {
    const mesh = this.mesh as THREE.BatchedMesh & { _nextVertexStart: number; _nextIndexStart: number; _maxVertexCount: number; _maxIndexCount: number };
    const v = geo.getAttribute('position').count, i = geo.index?.count ?? 0;
    // (Room for it, by doubling, as the instances grow.)
    if (mesh._nextVertexStart + v > mesh._maxVertexCount || mesh._nextIndexStart + i > mesh._maxIndexCount) {
      mesh.setGeometrySize(Math.max(mesh._maxVertexCount * 2, mesh._nextVertexStart + v), Math.max(mesh._maxIndexCount * 2, mesh._nextIndexStart + i));
    }
    // (The first shape gives the mesh its vertex attributes: a shader built before it is built again.)
    const first = !mesh.geometry.getAttribute('position');
    const gid = mesh.addGeometry(geo);
    if (first) (mesh.material as THREE.Material).needsUpdate = true;
    return gid;
  }

  /** Each stand-in's place and visibility into its instance (once the scene's transforms are up to date). */
  sync() {
    const mesh = this.mesh;
    let root: THREE.Object3D = mesh;
    while (root.parent) root = root.parent;
    const inScene = (root as THREE.Scene).isScene === true;
    if (inScene) this.seen = true;
    else {
      // Its board was taken down.
      if (this.seen) this.dispose();
      return;
    }
    inverse.copy(mesh.matrixWorld).invert();
    const texture = (mesh as unknown as { _matricesTexture: THREE.DataTexture })._matricesTexture;
    const matrices = texture.image.data as Float32Array;
    let moved = false;
    for (let k = this.stands.length - 1; k >= 0; k--) {
      const s = this.stands[k];
      let top: THREE.Object3D = s.obj;
      while (top.parent) top = top.parent;
      if (top !== root) {
        if (s.seen) {
          mesh.deleteInstance(s.id);
          this.stands.splice(k, 1);
        }
        continue;
      }
      s.seen = true;
      const shown = onShow(s.obj);
      mesh.setVisibleAt(s.id, shown);
      // (Its matrix goes up only if it moved: most stand still.)
      if (shown && writeMatrix(matrices, s.id * 16, place.multiplyMatrices(inverse, s.obj.matrixWorld))) moved = true;
    }
    if (moved) texture.needsUpdate = true;
  }

  dispose() {
    this.stage.beforeDraw.delete(this.synced);
    this.mesh.removeFromParent();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.stands = [];
    this.geos.clear();
  }
}

/** Whether `o` is drawn: it and every group it is in shown. */
function onShow(o: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
