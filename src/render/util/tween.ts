// Tiny frame-driven animation system. Everything that animates registers here so
// that it is ticked by the render loop and can be cancelled (no orphaned timers).

type Easing = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
};

interface Task {
  id: number;
  elapsed: number;
  delay: number;
  duration: number;
  easing: Easing;
  update: (t: number, raw: number) => void;
  done?: () => void;
  resolve: () => void;
  cancelled: boolean;
}

export class Animator {
  private tasks = new Map<number, Task>();
  /** This tick's tasks (a list kept from frame to frame, rather than a new array each one). */
  private ticking: Task[] = [];
  private nextId = 1;
  /** Global speed multiplier (settings: animation speed). */
  speed = 1;

  tween(opts: {
    duration: number;
    delay?: number;
    easing?: Easing;
    update: (t: number, raw: number) => void;
    done?: () => void;
  }): { id: number; promise: Promise<void> } {
    const id = this.nextId++;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.tasks.set(id, {
      id,
      elapsed: 0,
      delay: opts.delay ?? 0,
      duration: Math.max(1e-4, opts.duration),
      easing: opts.easing ?? ease.inOutCubic,
      update: opts.update,
      done: opts.done,
      resolve,
      cancelled: false,
    });
    return { id, promise };
  }

  /** Resolves after `seconds` of (scaled) animation time. */
  wait(seconds: number): Promise<void> {
    return this.tween({ duration: seconds, update: () => {} }).promise;
  }

  cancel(id: number, complete = false) {
    const t = this.tasks.get(id);
    if (!t) return;
    this.tasks.delete(id);
    t.cancelled = true;
    // (As in tick: something an animation moves may already be taken down, and the rest still finish.)
    if (complete) {
      try {
        t.update(1, 1);
        t.done?.();
      } catch (e) {
        console.error(e);
      }
    }
    t.resolve();
  }

  /** Finish every running animation immediately (used when skipping). */
  finishAll() {
    for (const id of [...this.tasks.keys()]) this.cancel(id, true);
  }

  tick(dt: number) {
    if (this.tasks.size === 0) return;
    const step = dt * this.speed;
    // A snapshot: tasks started by these updates begin next tick, as they always have.
    const list = this.ticking;
    list.length = 0;
    for (const t of this.tasks.values()) list.push(t);
    for (const t of list) {
      if (t.cancelled) continue;
      t.elapsed += step;
      if (t.elapsed < t.delay) continue;
      const raw = Math.min(1, (t.elapsed - t.delay) / t.duration);
      try {
        t.update(t.easing(raw), raw);
        if (raw >= 1) {
          this.tasks.delete(t.id);
          t.done?.();
        }
      } catch (e) {
        // One that throws (an animation of something already taken down, say) is dropped, and
        // whatever waits on it carries on: left in, it would throw at every tick, and the frame
        // after it (the camera, the drawing) would never run again.
        console.error('animation failed', e);
        this.tasks.delete(t.id);
        t.cancelled = true;
        t.resolve();
        continue;
      }
      if (raw >= 1) t.resolve();
    }
    list.length = 0;
  }
}
