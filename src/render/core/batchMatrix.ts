// The transform of the batched mesh instance being drawn, for a material that needs it in the
// vertex stage (see board/standInBatch.ts): three applies it to positionLocal before the
// material's positionNode runs, so whatever a material adds there in the object's own space (a
// banner's sway) has to be turned by it, and a size read from the object's transform (surface
// patterns) scaled by it.
//
// It reads the instance's matrix as three's own batching does (nodes/accessors/Batch.js): from
// the batched mesh's matrices texture, at the instance three is drawing (batchIndirectIndex, set
// by the batching before positionNode). The texture is the mesh's, so a material made with this
// belongs to that one mesh.

import * as THREE from 'three/webgpu';
import { Fn, batchIndirectIndex, float, int, ivec2, mat4, textureLoad, textureSize } from 'three/tsl';
import type { Node } from 'three/webgpu';

export function batchMatrix(mesh: THREE.BatchedMesh): Node<'mat4'> {
  const tex = (mesh as unknown as { _matricesTexture: THREE.DataTexture })._matricesTexture;
  return Fn(() => {
    const size = int((textureSize(textureLoad(tex), int(0)) as unknown as Node<'ivec2'>).x).toConst();
    const j = float(batchIndirectIndex).mul(4).toInt().toConst();
    const x = j.mod(size).toConst();
    const y = j.div(size).toConst();
    return mat4(textureLoad(tex, ivec2(x, y)), textureLoad(tex, ivec2(x.add(1), y)), textureLoad(tex, ivec2(x.add(2), y)), textureLoad(tex, ivec2(x.add(3), y)));
  })() as unknown as Node<'mat4'>;
}
