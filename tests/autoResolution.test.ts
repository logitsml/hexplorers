import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchResolution } from '../src/app/autoResolution';
import { useUI } from '../src/game/store';
import type { World } from '../src/render/World';

/** A stand-in world whose frames the test drives, with a fake clock and GPU times it makes up. */
function rig(aa: 'reproject' | 'taa' = 'reproject') {
  let tick: () => void = () => {};
  const stage = {
    quality: { aa },
    resolutionGive: 1,
    frameTimes: [] as number[],
    timeFrames: false,
    setResolutionGive(k: number) {
      this.resolutionGive = k;
    },
  };
  const world = { compiling: false, drawEnabled: true, idling: false, frameMs: 4, stage, onFrame: (fn: () => void) => ((tick = fn), () => {}) } as unknown as World & { frameMs: number };
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  watchResolution(world);
  /** `seconds` of frames `gap` ms apart, each taking `gpu` ms to draw. */
  const run = (seconds: number, gap: number, gpu: number) => {
    for (let t = 0; t < seconds * 1000; t += gap) {
      now += gap;
      tick();
      stage.frameTimes.push(gpu);
    }
  };
  return { run, stage, world };
}

describe('auto resolution', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { hidden: false });
    useUI.getState().set({ settings: { ...useUI.getState().settings, quality: 'auto' }, quality: 'medium', qualityProgress: null, paused: false, screen: 'game' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gives up a step of the resolution while the GPU makes frames miss their refresh, down to its last', () => {
    const { run, stage } = rig();
    run(1.2, 25, 19);
    expect(stage.resolutionGive).toBe(0.9);
    expect(stage.timeFrames).toBe(true);
    // (Not judged for a moment after a step.)
    run(1.4, 25, 19);
    expect(stage.resolutionGive).toBe(0.9);
    run(1.2, 25, 19);
    expect(stage.resolutionGive).toBe(0.8);
    run(10, 25, 19);
    expect(stage.resolutionGive).toBe(0.8);
  });

  it('takes the resolution back a step at a time once the GPU has room for it', () => {
    const { run, stage } = rig();
    run(1.2, 25, 19);
    expect(stage.resolutionGive).toBe(0.9);
    // Keeping up, but not with room for a fifth more pixels: stays.
    run(6, 16.7, 12.8);
    expect(stage.resolutionGive).toBe(0.9);
    run(6, 16.7, 10);
    expect(stage.resolutionGive).toBe(1);
  });

  it('waits longer before stepping up again after a step up that had to be taken back', () => {
    const { run, stage } = rig();
    run(1.2, 25, 19);
    run(5, 16.7, 10);
    expect(stage.resolutionGive).toBe(1);
    // Straight back down (once the moment after the step is over): the next step up waits six seconds rather than three.
    run(2.8, 25, 19);
    expect(stage.resolutionGive).toBe(0.9);
    run(5, 16.7, 10);
    expect(stage.resolutionGive).toBe(0.9);
    run(3, 16.7, 10);
    expect(stage.resolutionGive).toBe(1);
  });

  it("leaves it whole when it's the CPU that is late, or frames held at 30 with little in them", () => {
    const busy = rig();
    busy.world.frameMs = 20;
    busy.run(6, 25, 19);
    expect(busy.stage.resolutionGive).toBe(1);
    vi.restoreAllMocks();
    const capped = rig();
    capped.run(6, 33.3, 14);
    expect(capped.stage.resolutionGive).toBe(1);
  });

  it("doesn't touch High's (no rebuilt frame to hide it), nor a preset chosen in Settings", () => {
    const high = rig('taa');
    high.run(6, 25, 19);
    expect(high.stage.resolutionGive).toBe(1);
    expect(high.stage.timeFrames).toBe(false);
    vi.restoreAllMocks();
    useUI.getState().set({ settings: { ...useUI.getState().settings, quality: 'medium' } });
    const fixed = rig();
    fixed.run(6, 25, 19);
    expect(fixed.stage.resolutionGive).toBe(1);
  });

  it('gives the whole resolution back when Auto is left', () => {
    const { run, stage } = rig();
    run(1.2, 25, 19);
    expect(stage.resolutionGive).toBe(0.9);
    useUI.getState().set({ settings: { ...useUI.getState().settings, quality: 'medium' } });
    run(0.1, 25, 19);
    expect(stage.resolutionGive).toBe(1);
  });

  it("doesn't judge frames while shaders build, nor for a while after", () => {
    const { run, stage, world } = rig();
    (world as unknown as { compiling: boolean }).compiling = true;
    run(5, 25, 19);
    (world as unknown as { compiling: boolean }).compiling = false;
    run(2.5, 25, 19);
    expect(stage.resolutionGive).toBe(1);
    run(2, 25, 19);
    expect(stage.resolutionGive).toBe(0.9);
  });
});
