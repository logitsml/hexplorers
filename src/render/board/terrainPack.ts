// Tile terrain sent between the terrain workers and the main thread: plain arrays, transferred
// rather than copied.

import * as THREE from 'three/webgpu';
import type { TileContext } from './terrain';

export interface PackedGeometry {
  index: Uint16Array | Uint32Array | null;
  attributes: [name: string, array: Float32Array, itemSize: number, normalized: boolean][];
}

export interface TerrainJob {
  id: number;
  ctx: TileContext;
  noiseSeed: number;
  rings: number;
  /** Built only to warm the worker up (see TerrainPool.warm): nothing comes back but the id. */
  warm?: boolean;
}

export interface TerrainResult {
  id: number;
  top: PackedGeometry;
  walls: PackedGeometry;
  inner: PackedGeometry;
}

/** A geometry's index and attributes, with their buffers added to `transfer`. */
export function pack(g: THREE.BufferGeometry, transfer: Transferable[]): PackedGeometry {
  const index = g.index ? (g.index.array as Uint16Array | Uint32Array) : null;
  if (index) transfer.push(index.buffer);
  const attributes: PackedGeometry['attributes'] = [];
  for (const [name, a] of Object.entries(g.attributes)) {
    const attr = a as THREE.BufferAttribute;
    const array = attr.array as Float32Array;
    attributes.push([name, array, attr.itemSize, attr.normalized]);
    transfer.push(array.buffer);
  }
  return { index, attributes };
}

export function unpack(p: PackedGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, array, itemSize, normalized] of p.attributes) g.setAttribute(name, new THREE.BufferAttribute(array, itemSize, normalized));
  if (p.index) g.setIndex(new THREE.BufferAttribute(p.index, 1));
  return g;
}
