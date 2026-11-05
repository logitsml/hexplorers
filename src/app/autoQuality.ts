// While Settings say Auto, watch how frames run once they have settled. The preset itself is never
// changed or offered here: a step down taken by itself can mistake a game's start (its shaders
// building, then the island rising) for a slow device, and an offer to step down is one note too
// many over a game's start. The preset is the device's pick (deviceQuality.ts) or the
// player's, in Settings; Medium and Low then shed resolution as they need (autoResolution.ts).
//
// On the lowest preset, the resolution goes: the pixel floor that keeps a small screen's board sharp
// (Stage.floorScale), a step at a time while frames run under about 52 a second, remembered for
// next time. On a phone drawing the floor's 0.8 MP, that is most of what a frame costs. As with
// the presets, a step that didn't help is taken back, and a 30-a-second cap isn't stepped for.

import { useUI } from '../game/store';
import type { World } from '../render/World';
import { rememberFloor, stepDown } from './deviceQuality';

/** Seconds of frames judged at a time. */
const WINDOW = 6;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
/**
 * The mean, its slowest twentieth left out (a hitch). Frames land on whole refreshes (16.7 or
 * 33.3 ms at 60 Hz), so the median jumps between the two while the rate moves from 35 to 55 a
 * second: the resolution's steps, which move it that much, are judged on this.
 */
const trimmedMean = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(xs.length * 0.95)));
  return s.reduce((a, b) => a + b, 0) / s.length;
};
/** The pixel floor's steps down (see Stage.floorScale). */
const FLOOR_STEPS = [1, 0.7, 0.45, 0];

export function watchQuality(world: World) {
  let gaps: number[] = [];
  let cpu: number[] = [];
  let since = 0;
  let last = 0;
  // Nothing is judged for a while after loading or a switch (shaders and caches warming up).
  let quietUntil = performance.now() + 5000;
  /** When the current game began (its intro's frames aren't judged). */
  let gameSince = Infinity;
  /** Windows in a row that ran under about 52 frames a second (the pixel floor steps after two). */
  let floorSlow = 0;
  /** The last step of the pixel floor, until the next judgement of the same screen says whether it helped; and whether one didn't. */
  let floorStepped: { from: number; mean: number; screen: string } | null = null;
  let floorHeld = false;
  return world.onFrame(() => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    const ui = useUI.getState();
    if (ui.screen !== 'game') gameSince = Infinity;
    else if (gameSince === Infinity) gameSince = now;
    // (Not judged while frames aren't the game's own: compiling, under the flat map where nothing
    // is drawn, held to the idle title's pace, paused, or hidden.)
    // (A preset chosen in Settings draws at its own resolution: the floor's whole again.)
    if (ui.settings.quality !== 'auto' && world.stage.floorScale !== 1) {
      world.stage.setFloorScale(1);
      // (And Auto, chosen again later, starts from the whole floor too.)
      rememberFloor(1);
    }
    // (Nor for a while after any compile: the first frames to draw what it built still upload and
    // record it.)
    const building = !!ui.qualityProgress || world.compiling || (world.precompiling ?? 0) > 0;
    if (building) quietUntil = Math.max(quietUntil, now + 8000);
    if (ui.settings.quality !== 'auto' || building || world.drawEnabled === false || world.coarse || world.idling || ui.paused || document.hidden || now < quietUntil || gap > 250) {
      gaps = [];
      cpu = [];
      since = now;
      return;
    }
    gaps.push(gap);
    cpu.push(world.frameMs);
    if (now - since < WINDOW * 1000) return;
    const work = median(cpu), mean = trimmedMean(gaps);
    // (How many frames came exactly two refreshes apart, as a 30-a-second cap holds them.)
    const heldShare = gaps.filter((g) => g > 31 && g < 36).length / gaps.length;
    gaps = [];
    cpu = [];
    since = now;
    // On the lowest preset and under about 52 twice running: a step of the resolution down (no
    // shaders to build, so it's judged again sooner). Not taken back as a preset is: a game's
    // frames vary more from one moment to the next than a step changes them, and a step too
    // many costs a little sharpness, not smoothness.
    const floor = world.stage.floorScale, nextFloor = FLOOR_STEPS.find((k) => k < floor);
    // (Not in a game's first twenty seconds, its intro: those frames are the heaviest a game has,
    // and a step then shows as a pop while the island rises.)
    const settled = ui.screen !== 'game' || now - gameSince > 20000;
    // Frames held at 30 a second with little work in them are a cap (iOS Low Power Mode, a
    // battery saver, a 30 Hz screen), not slow drawing: fewer pixels wouldn't help.
    const capped = work < 6 && heldShare > 0.8;
    // (Only on the lowest preset: above it, autoResolution.ts has the resolution.)
    const lower = stepDown(ui.quality);
    // A step that didn't help (not even about a twelfth quicker, judged on the same screen): back
    // to where it was, remembered, and no more steps. (A step judged across a change of screen
    // proves nothing either way: it stays.)
    if (floorStepped) {
      const { from, mean: before, screen } = floorStepped;
      floorStepped = null;
      if (screen === ui.screen && settled && mean > before * 0.92) {
        floorHeld = true;
        rememberFloor(from);
        quietUntil = now + 4000;
        world.stage.setFloorScale(from);
        return;
      }
    }
    floorSlow = mean > 19 && !lower && settled && !capped ? floorSlow + 1 : 0;
    if (floorSlow >= 2 && nextFloor !== undefined && !floorHeld) {
      floorSlow = 0;
      floorStepped = { from: floor, mean, screen: ui.screen };
      rememberFloor(nextFloor);
      quietUntil = now + 4000;
      world.stage.setFloorScale(nextFloor);
    }
  });
}
