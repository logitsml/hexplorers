// Motion vectors for what a material moves itself.
//
// three works out how far each pixel moved since the last frame (the velocity buffer, which the
// temporal AA fetches each pixel's history by) from where its vertex is now and where it was:
// where it was is the geometry's own position moved by last frame's object, instance and batch
// matrices. A material's positionNode isn't in that, so whatever a material moves itself would read
// as moving by that much every frame, standing still. The sea is laid at sea level (0.4 below its
// geometry) and heaved by its waves: with the camera still, its velocity would read many pixels
// (against 0 on the land), so the temporal AA would fetch each sea pixel's history from that far off
// and its variance clip throw most of it out: a sea with little of the AA's smoothing or stability. The swaying crops and trees likewise, by their sway.
//
// Here what a material's positionNode moves a vertex by is carried into where it was as well: it
// is taken to have moved with its object since the last frame (between two frames a sway or a
// swell moves it far less than a pixel), and only real motion (the camera, objects, instances,
// bones) is left in the vectors. Only where a pass records velocity (TRAA's, on High and Ultra).

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { positionLocal, positionPrevious, subBuild } from 'three/tsl';

type Builder = { needsPreviousData?(): boolean };
type Material = { positionNode: Node | null; setupPosition(builder: Builder): Node };
type Setup = Material['setupPosition'] & { carried?: true };

export function carryDisplacementToMotion() {
  const proto = THREE.NodeMaterial.prototype as unknown as Material;
  const setup = proto.setupPosition as Setup;
  if (setup.carried) return;
  const carried: Setup = function (this: Material, builder: Builder) {
    const node = this.positionNode;
    if (!node || !builder.needsPreviousData?.()) return setup.call(this, builder);
    // three's own steps up to the material's (morphs, skinning, batching, instancing: each moves
    // last frame's position too), then the material's, noting the position before it.
    this.positionNode = null;
    try {
      setup.call(this, builder);
    } finally {
      this.positionNode = node;
    }
    const before = positionLocal.toVar();
    positionLocal.assign((subBuild as unknown as (n: Node, name: string, type: string) => Node)(node, 'POSITION', 'vec3'));
    (positionPrevious as unknown as Node<'vec3'>).addAssign(positionLocal.sub(before));
    return positionLocal;
  };
  carried.carried = true;
  proto.setupPosition = carried;
}
