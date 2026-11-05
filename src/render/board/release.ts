// Letting the renderer forget objects taken off the board.

import type * as THREE from 'three/webgpu';

/**
 * Tell the renderer that `root` and everything under it are gone for good, so it drops what it
 * keeps for drawing them. It lets go of that when an object or its material is disposed, and
 * the board's materials are kept from game to game (see materials.ts `pooled`), so each mesh
 * has to say so itself. (Batched meshes are left to their owners: disposing one frees its
 * buffers too.)
 *
 * Everything under `root` is cut loose from its parent too. The renderer keeps the first mesh to
 * draw each geometry until that geometry is disposed (its dispose listener holds the mesh's
 * render object), and pooled geometry never is: a stand-in's piece, a disc's face. Still hung
 * in its tree, such a mesh would keep the whole board it was part of, and through the closures
 * in that board's objects the board's view, its contact map and all (about 9 MB a game). Cut
 * loose, it keeps only itself and what hangs under it. (`root` keeps its own parent: the
 * caller takes it off the board, and the island's life releases the long-lived group it shares.)
 */
export function release(root: THREE.Object3D) {
  root.traverse((o) => {
    if (!(o as THREE.BatchedMesh).isBatchedMesh) o.dispose();
    if (o !== root) o.parent = null;
  });
}
