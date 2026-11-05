// The scenery beyond the island (render/env/distantShapes.ts), planned without a renderer: it is
// built on a worker and, failing that, on the main thread, so both must come out the same; and
// its mountain ranges, drawn every frame, must stay cheap.

import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import { planScenery } from '../src/render/env/distantShapes';

/** Whether two attributes (or indices) hold exactly the same bits. */
const same = (a: THREE.BufferAttribute | null | undefined, b: THREE.BufferAttribute | null | undefined) => {
  const x = new Uint8Array((a!.array as Float32Array).buffer);
  const y = new Uint8Array((b!.array as Float32Array).buffer);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

describe('the scenery', () => {
  it('is the same every time it is planned', () => {
    const a = planScenery();
    const b = planScenery();
    expect(b.pieces.map((p) => p.look)).toEqual(a.pieces.map((p) => p.look));
    a.pieces.forEach((p, i) => {
      const q = b.pieces[i].geometry;
      for (const name of Object.keys(p.geometry.attributes)) expect(same(q.getAttribute(name) as THREE.BufferAttribute, p.geometry.getAttribute(name) as THREE.BufferAttribute)).toBe(true);
      expect(same(q.index, p.geometry.index)).toBe(true);
    });
    expect(b.ships).toEqual(a.ships);
  });

  it('keeps the ranges on the horizon to separate massifs of few triangles', () => {
    const ranges = planScenery().pieces.filter((p) => p.look === 'range');
    expect(ranges.length).toBeGreaterThan(6);
    const triangles = ranges.reduce((n, p) => n + p.geometry.index!.count / 3, 0);
    expect(triangles).toBeLessThan(60_000);
    // Each its own patch of the horizon, culled on its own (not an arc round the whole island).
    for (const p of ranges) expect(p.geometry.boundingSphere!.radius).toBeLessThan(120);
  });
});
