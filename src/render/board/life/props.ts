// Drawing for the expansions' looks' life with as few materials as possible. Every material
// instance costs a node build at the game-start precompile (and its shadow variant another), and
// every mesh a draw in each pass, so these modules share one material: each look's still props
// for all its tiles are one mesh with a per-vertex tile, and every moving part a mesh of its own
// hung on an Object3D the module animates. Fires share one unlit material.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pooled, propMaterial, type TileEffects } from '../materials';
import { lampColor, lampLevel } from '../../fx/lamps';
import { DETAIL_LAYER } from '../layout';
import type { Reserved } from '../decor';
import type { PropBatches } from '../propBatches';

export const FIRE = lampColor(1.9, 1.0, 0.35);

/**
 * One mesh of still props for several tiles: each part's geometry is in its tile's local frame
 * (x and z from the hex centre, y in the world) and is moved onto the tile and tagged with it.
 * The merged geometry is the module's to free, so it goes on `owned` (its disposables): taking
 * the mesh off the board (`release`) lets the renderer forget the mesh, but its buffers go only
 * when the geometry itself is disposed, and every game and every hex found in the fog left one.
 */
export function stillProps(effects: TileEffects, parts: { geo: THREE.BufferGeometry; hex: { id: number; x: number; z: number } }[], owned: { dispose(): void }[]): THREE.Mesh | null {
  if (!parts.length) return null;
  const geos = parts.map(({ geo, hex }) => {
    const g = geo.clone();
    g.translate(hex.x, 0, hex.z);
    const n = g.getAttribute('position').count;
    if (!g.getAttribute('surface')) g.setAttribute('surface', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('tile', new THREE.Float32BufferAttribute(new Float32Array(n).fill(hex.id), 1));
    return g;
  });
  const merged = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  owned.push(merged);
  const mesh = new THREE.Mesh(merged, lifeMaterial(effects));
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/** Whether a prop of radius `r` at (x, z) on a hex keeps clear of where pieces may stand. */
export function clearOfPieces(anchors: Reserved, hex: number, x: number, z: number, r: number) {
  return anchors.every((a) => a.hex !== hex || Math.hypot(x - a.x, z - a.z) > a.r + r);
}

/** The one material for these looks' props, still and moving (patterns from the surface ids). */
const LIFE_LOOK = { roughness: 0.85, surfaces: true };
const lifeMaterial = (effects: TileEffects) => propMaterial(effects, LIFE_LOOK);
/** (The layers of a part set to DETAIL_LAYER alone.) */
const DETAIL_MASK = new THREE.Layers();
DETAIL_MASK.set(DETAIL_LAYER);

/**
 * Moving parts: each one hung on an Object3D the module animates, on the shared material. With
 * the board's prop batches (`props`, see propBatches.ts) a part is a stand-in drawn as an
 * instance, every part of a kind across the board one draw. (Instanced meshes of one material
 * share their shaders at the same capacity: see core/instanceShaders.ts.) Without them, a mesh
 * of its own, its geometry copied once per tile to carry the tile its effects come from.
 */
export class Parts {
  private copies = new Map<string, THREE.BufferGeometry>();

  constructor(
    private effects: TileEffects,
    private props?: PropBatches,
  ) {}

  add(geo: THREE.BufferGeometry, node: THREE.Object3D, tile: number, castShadow = false) {
    // (A batched part of any shape where there are batched meshes; else an instance of its own
    // shape, or a mesh.)
    const batched = this.props?.part(this.copy(geo, tile), LIFE_LOOK, castShadow, DETAIL_MASK.mask) ?? null;
    const part = batched ?? (this.props ? this.props.mesh(geo, lifeMaterial(this.effects), tile) : new THREE.Mesh(this.copy(geo, tile), lifeMaterial(this.effects)));
    part.castShadow = castShadow;
    part.receiveShadow = true;
    // (Small things the sea's mirror can do without: see DETAIL_LAYER.)
    part.layers.set(DETAIL_LAYER);
    node.add(part);
    return part;
  }

  /** `geo` tagged with `tile` (and blank surface ids where it has none), once per tile. */
  private copy(geo: THREE.BufferGeometry, tile: number) {
    const key = `${geo.uuid}:${tile}`;
    let g = this.copies.get(key);
    if (!g) {
      g = geo.clone();
      const n = g.getAttribute('position').count;
      if (!g.getAttribute('surface')) g.setAttribute('surface', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
      g.setAttribute('tile', new THREE.Float32BufferAttribute(new Float32Array(n).fill(tile), 1));
      this.copies.set(key, g);
    }
    return g;
  }

  dispose() {
    for (const g of this.copies.values()) g.dispose();
    this.copies.clear();
  }
}

/** The one unlit material every campfire and beacon of these looks burns with. */
export function fireMaterial(effects: TileEffects): THREE.MeshBasicNodeMaterial {
  return pooled(effects, 'lifeFire', () => new THREE.MeshBasicNodeMaterial({ color: '#ffb35a' }));
}

/** Set the shared fire's colour for this frame: a flicker, bright as any lamp at night. */
export function stokeFire(effects: TileEffects, t: number) {
  const flick = 0.8 + Math.sin(t * 11) * 0.12 + Math.sin(t * 27) * 0.08;
  fireMaterial(effects).color.copy(FIRE).multiplyScalar(flick * lampLevel(effects.night.value, 0.7));
  return flick;
}
