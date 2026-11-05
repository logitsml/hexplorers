import { useEffect, useState } from 'react';
import { session } from '../app/session';

/** Development overlay (?perf): frame rate, GPU time and renderer counters. */
export function PerfOverlay() {
  const [stats, setStats] = useState<Record<string, string | number>>({});
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const w = session.world;
      if (w) {
        const r = w.stage.renderer;
        let gpu = '–';
        try {
          await r.resolveTimestampsAsync('render');
          const ts = r.info.render.timestamp;
          if (ts) gpu = `${ts.toFixed(2)} ms`;
        } catch {
          /* timestamps unsupported */
        }
        if (!alive) return;
        setStats({
          fps: Math.round(w.fps),
          gpu,
          calls: r.info.render.drawCalls,
          tris: `${(r.info.render.triangles / 1e6).toFixed(2)} M`,
          geo: r.info.memory.geometries,
          tex: r.info.memory.textures,
          aa: w.stage.quality.aa,
          backend: (r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2',
        });
      }
      if (alive) setTimeout(tick, 500);
    };
    tick();
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div style={{ position: 'fixed', left: 8, bottom: 8, zIndex: 200, font: '11px/1.4 ui-monospace, monospace', color: '#e8f4ff', background: 'rgba(8,14,22,0.78)', padding: '6px 8px', borderRadius: 6, pointerEvents: 'none' }}>
      {Object.entries(stats).map(([k, v]) => (
        <div key={k}>
          {k}: {v}
        </div>
      ))}
    </div>
  );
}
