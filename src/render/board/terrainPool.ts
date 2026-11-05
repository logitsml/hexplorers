// Tile terrain built in parallel, off the main thread. Every tile's heightfield is independent
// of the others and costs tens of milliseconds (each of its 4,000 vertices, 16,000 on mountains,
// samples the terrain 13 times for its baked occlusion): about 1.5 s for an island on one
// thread. A few workers build them side by side, started once the title is up (see bootstrap),
// so loading the page doesn't wait on their script.

import type { TerrainJob, TerrainResult } from './terrainPack';

interface Task {
  job: TerrainJob;
  batch: number;
  resolve: (r: TerrainResult | null) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A tile that takes longer than this is given up on (and built on the main thread instead). */
const JOB_TIMEOUT_MS = 20000;

export class TerrainPool {
  private idle: Worker[] = [];
  private all: Worker[] = [];
  private queue: Task[] = [];
  private running = new Map<Worker, Task>();
  private batch = 0;
  private closed = false;
  private started = false;
  private pumping = false;

  constructor(private size = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2))) {}

  private start() {
    if (this.started || this.closed) return;
    this.started = true;
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL('../buildWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<TerrainResult>) => this.finish(w, e.data);
      // A worker that fails (its script didn't load, a tile threw, a reply couldn't be read) is
      // retired: whatever it was building goes back to the caller, which builds it itself.
      w.onerror = (e) => {
        e.preventDefault();
        this.retire(w, e);
      };
      w.onmessageerror = (e) => this.retire(w, e);
      this.all.push(w);
      this.idle.push(w);
    }
  }

  /**
   * Start the workers ahead of the first island (they load their script meanwhile), each building
   * one of `samples` for nothing: a worker's first tile runs at about a third of the speed of its
   * later ones (its code not yet compiled), which would otherwise slow the first island's tiles,
   * the mountains most.
   */
  warm(samples: TerrainJob[] = []) {
    this.start();
    // (Not once a board's tiles have been asked for: those warm them up as well as any.)
    if (this.warmed || this.batch > 0) return;
    this.warmed = true;
    for (const [i, job] of samples.slice(0, this.all.length).entries()) {
      this.queue.push({ job: { ...job, id: -1 - i, warm: true }, batch: -1, resolve: () => {}, reject: () => {}, timer: null });
    }
    this.pump();
  }
  private warmed = false;

  /**
   * Start a new set of jobs (a new board's tiles). Jobs still queued from earlier sets are
   * dropped: they resolve to null, as that board has been replaced.
   */
  begin(): number {
    this.start();
    const b = ++this.batch;
    const stale = this.queue.filter((t) => t.batch !== b);
    this.queue = this.queue.filter((t) => t.batch === b);
    for (const t of stale) t.resolve(null);
    return b;
  }

  /** Whether jobs of this set are still wanted. */
  current(batch: number) {
    return batch === this.batch;
  }

  /**
   * Build one tile's geometry (heaviest first, so the last to finish isn't a mountain). Null when
   * its set was replaced before it started; rejects when no worker could build it.
   */
  run(job: TerrainJob, batch = this.batch): Promise<TerrainResult | null> {
    this.start();
    return new Promise((resolve, reject) => {
      if (this.closed || this.all.length === 0) {
        reject(new Error('no terrain workers'));
        return;
      }
      this.queue.push({ job, batch, resolve, reject, timer: null });
      this.queue.sort((a, b) => b.job.rings - a.job.rings);
      // (Once the caller has asked for all of a board's tiles, so the heaviest go out first: sent as
      // they came, the first workers would take the board's first hexes, and its mountains wait.)
      if (!this.pumping) {
        this.pumping = true;
        queueMicrotask(() => {
          this.pumping = false;
          this.pump();
        });
      }
    });
  }

  private finish(w: Worker, result: TerrainResult) {
    const t = this.running.get(w);
    this.running.delete(w);
    if (t?.timer) clearTimeout(t.timer);
    if (!this.idle.includes(w) && this.all.includes(w)) this.idle.push(w);
    t?.resolve(result);
    this.pump();
  }

  private retire(w: Worker, why: unknown) {
    const t = this.running.get(w);
    this.running.delete(w);
    w.terminate();
    this.all = this.all.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
    if (t) {
      if (t.timer) clearTimeout(t.timer);
      t.reject(why);
    }
    if (this.all.length === 0) {
      // None left: everything still waiting is built by its callers.
      const queued = this.queue;
      this.queue = [];
      for (const q of queued) q.reject(why);
    } else this.pump();
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const t = this.queue.shift()!;
      this.running.set(w, t);
      t.timer = setTimeout(() => this.retire(w, new Error('terrain worker timed out')), JOB_TIMEOUT_MS);
      w.postMessage(t.job);
    }
  }

  dispose() {
    this.closed = true;
    for (const w of this.all) w.terminate();
    for (const t of [...this.queue, ...this.running.values()]) {
      if (t.timer) clearTimeout(t.timer);
      t.reject(new Error('terrain pool closed'));
    }
    this.queue = [];
    this.running.clear();
    this.all = [];
    this.idle = [];
  }
}
