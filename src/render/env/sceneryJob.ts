// Starts the scenery's worker (render/buildWorker.ts) as early as the page can: the shell in main.tsx
// asks for it before the 3D world's scripts have even arrived, so the land on the horizon is built
// while they download and the renderer starts. Nothing here imports three.js; the world unpacks
// the result (see loadScenery in distant.ts).

import type { SceneryJob, SceneryResult } from '../buildWorker';

let job: Promise<SceneryResult | null> | null = null;

/** The worker's result, or null without a worker or if it failed (the world then builds it itself). */
export function startScenery(): Promise<SceneryResult | null> {
  return (job ??= new Promise((resolve) => {
    if (typeof Worker === 'undefined') return resolve(null);
    let worker: Worker;
    try {
      worker = new Worker(new URL('../buildWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      return resolve(null);
    }
    const done = (r: SceneryResult | null) => {
      worker.terminate();
      resolve(r);
    };
    worker.onmessage = (e: MessageEvent<SceneryResult>) => done(e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      done(null);
    };
    worker.onmessageerror = () => done(null);
    worker.postMessage({ scenery: true } satisfies SceneryJob);
  }));
}
