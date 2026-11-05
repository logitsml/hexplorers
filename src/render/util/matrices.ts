// Writing an instance's matrix only where it changed. A batch that copies every stand-in's place
// in each frame marks its whole buffer for upload each frame, though nearly all of an island's
// props stand still: tens of kilobytes a frame, and on WebGL a buffer re-made per batch (a slow
// phone's CPU felt it more than anything else the props cost).

import type * as THREE from 'three/webgpu';

/** Copies `m` into `array` at `offset` (16 floats); whether anything there changed. */
export function writeMatrix(array: ArrayLike<number> & { [i: number]: number }, offset: number, m: THREE.Matrix4): boolean {
  const e = m.elements;
  let changed = false;
  for (let i = 0; i < 16; i++) {
    // (Compared as stored: a Float32Array keeps a rounded copy of the matrix's doubles.)
    const was = array[offset + i];
    array[offset + i] = e[i];
    if (array[offset + i] !== was) changed = true;
  }
  return changed;
}

/** Sets `array[i]` to `v`; whether it changed (as stored). */
export function writeValue(array: ArrayLike<number> & { [i: number]: number }, i: number, v: number): boolean {
  const was = array[i];
  array[i] = v;
  return array[i] !== was;
}
