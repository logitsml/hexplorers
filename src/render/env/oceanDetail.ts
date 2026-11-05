// The sea's fine ripple normals (see ocean.ts), as plain texels: built off the main thread with
// the scenery (render/buildWorker.ts) while the renderer starts, or here when there's no worker.

/** The normal map's size in texels, each way. */
export const DETAIL_SIZE = 256;

/** The texels (RGBA) of a tileable normal map made from integer-frequency sine waves (perfectly periodic). */
export function detailNormals(size = DETAIL_SIZE, seed = 3): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const comps = Array.from({ length: 48 }, () => {
    const fx = Math.round((rnd() - 0.5) * 24);
    const fy = Math.round((rnd() - 0.5) * 24);
    const f = Math.max(1, Math.hypot(fx, fy));
    return { fx, fy, amp: 1 / Math.pow(f, 1.3), ph: rnd() * Math.PI * 2 };
  });
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const c of comps) v += c.amp * Math.sin(((c.fx * x + c.fy * y) / size) * Math.PI * 2 + c.ph);
      h[y * size + x] = v;
    }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const d = h[((y - 1 + size) % size) * size + x];
      const u = h[((y + 1) % size) * size + x];
      const nx = (l - r) * 2.2;
      const ny = (d - u) * 2.2;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  return data;
}
