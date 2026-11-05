// While Settings say Auto, on the presets that draw the scene under the frame and rebuild it finer
// (Medium and Low: see Stage.resolutionGive), the scene gives up a little resolution when the GPU
// falls behind, and takes it back once the GPU has room again. A fanless laptop that has warmed up
// draws the same frame slower than it did cold: it can hold Medium at 60 frames a second for its
// first minutes and then drop every few frames to 30, a judder far more visible than a tenth of the
// scene's pixels each way, which the temporal AA mostly rebuilds. It never
// goes below a fifth each way (about Low's own resolution, with Medium's light and AO), changes no
// shader, and is not remembered: each visit starts whole.
//
// A frame is judged by the time from the start of its drawing to the GPU finishing it
// (Stage.frameTimes): over about 13 ms while frames miss the 60 a second they're held to, a step
// down; after a few seconds of no misses with room for the step up within 15 ms (judged as if all
// of a frame's time scaled with its pixels, which overstates it), a step back up. A step up that
// has to be taken back straight away makes the next one wait twice as long (up to half a minute),
// so a frame on the edge settles rather than see-sawing. Nothing is judged while shaders build, the
// frames aren't the game's own (the flat map, the idle title, a pause, a hidden tab), or little GPU
// work is held at 30 a second (a battery saver), and not for a moment after a step.

import { useUI } from '../game/store';
import type { World } from '../render/World';

/** The scene's share of its resolution each way, step by step. */
const STEPS = [1, 0.9, 0.8];
/** A frame later than this (ms) missed its refresh at 60 a second. */
const LATE = 22;
/** Seconds of no misses before a step back up, at first (doubled after each one taken back, up to MAX_CALM). */
const CALM = 3;
const MAX_CALM = 32;

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))];

export function watchResolution(world: World) {
  const stage = world.stage;
  let step = 0;
  let gaps: number[] = [];
  let work: number[] = [];
  let since = 0;
  let last = 0;
  let quietUntil = 0;
  let calm = CALM;
  let wasPaced = false;
  /** When the last step up was taken (to tell one that didn't hold). */
  let upAt = -Infinity;
  const set = (i: number, now: number) => {
    if (i > step && now - upAt < 6000) calm = Math.min(MAX_CALM, calm * 2);
    if (i < step) upAt = now;
    step = i;
    stage.setResolutionGive(STEPS[i]);
    // (The first frames at the new size make its buffers: not judged.)
    quietUntil = now + 1500;
  };
  return world.onFrame(() => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    const ui = useUI.getState();
    const on = ui.settings.quality === 'auto' && stage.quality.aa === 'reproject';
    stage.timeFrames = on;
    if (!on && step !== 0) {
      set(0, now);
      calm = CALM;
    }
    const building = !!ui.qualityProgress || world.compiling || (world.precompiling ?? 0) > 0;
    if (building) quietUntil = Math.max(quietUntil, now + 3000);
    // (Gaps from before the pacing changed say nothing about frames since: started again.)
    const paced = !!world.pacedAt90;
    if (paced !== wasPaced) {
      wasPaced = paced;
      quietUntil = Math.max(quietUntil, now + 1000);
    }
    if (!on || building || world.drawEnabled === false || world.coarse || world.idling || ui.paused || document.hidden || now < quietUntil || gap > 250) {
      gaps = [];
      work = [];
      stage.frameTimes.length = 0;
      since = now;
      return;
    }
    gaps.push(gap);
    work.push(world.frameMs);
    const span = now - since;
    if (span < 1000 || gaps.length < 20) return;
    const times = stage.frameTimes;
    if (times.length < 20) return;
    // A step down is judged on the last second or so (a judder shows at once), a step back up on
    // all the frames since the last judgement, a few seconds of them at least.
    const recent = gaps.slice(-60);
    // (On a 90 Hz screen paced to 60, every other gap is two refreshes, 22 ms: a frame is late at
    // three. Two and a half, from the refresh as measured, so a 72 or 75 Hz one is judged right too.)
    const lateAt = world.pacedAt90 ? world.refreshMs * 2.5 : LATE;
    const late = recent.filter((g) => g > lateAt).length / recent.length;
    const cpu = quantile(work.slice(-60), 0.5);
    // Held to 30 a second with little work in them: a cap that no resolution lifts.
    const capped = cpu < 6 && recent.filter((g) => g > 31 && g < 36).length / recent.length > 0.8;
    // The frame's own work on the CPU past most of a refresh: fewer pixels wouldn't help either.
    const gpuBound = !capped && cpu < 12 && quantile(times.slice(-60), 0.5) > 13;
    if (late > 0.08 && gpuBound && step < STEPS.length - 1) set(step + 1, now);
    else if (step > 0 && span >= calm * 1000 && gaps.filter((g) => g > lateAt).length / gaps.length < 0.02) {
      const k = STEPS[step - 1] / STEPS[step];
      if (quantile(times, 0.9) * k * k < 15) set(step - 1, now);
    } else if (span < Math.max(3000, step > 0 ? calm * 1000 : 0)) return;
    gaps = [];
    work = [];
    times.length = 0;
    since = now;
  });
}
