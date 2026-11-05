import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchQuality } from '../src/app/autoQuality';
import { sanitizeSettings, useUI } from '../src/game/store';
import type { World } from '../src/render/World';

/** A stand-in world whose frames the test drives, with a fake clock. */
function rig(frameMs: number) {
  let tick: () => void = () => {};
  const stage = {
    floorScale: 1,
    setFloorScale(k: number) {
      this.floorScale = k;
    },
  };
  const world = { compiling: false, frameMs, stage, onFrame: (fn: () => void) => ((tick = fn), () => {}) } as unknown as World & { compiling: boolean };
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  watchQuality(world);
  const run = (seconds: number, gap: number) => {
    for (let t = 0; t < seconds * 1000; t += gap) {
      now += gap;
      tick();
    }
  };
  return { run, stage, world };
}

describe('auto quality', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { hidden: false });
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    useUI.getState().set({ settings: { ...useUI.getState().settings, quality: 'auto' }, quality: 'medium', qualityProgress: null, screen: 'title' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('never changes or offers a preset, however frames run', () => {
    const slow = rig(30);
    useUI.getState().set({ screen: 'game' });
    slow.run(90, 45);
    expect(useUI.getState().quality).toBe('medium');
    expect(slow.stage.floorScale).toBe(1);
    expect(localStorage.getItem('exploratory.autoQuality')).toBeNull();
  });

  it('on Low, steps the pixel floor down after two slow windows, and keeps a step that helped', () => {
    useUI.getState().set({ quality: 'low' });
    const { run, stage } = rig(8);
    // (About 40 frames a second: no preset below Low, so the resolution goes.)
    run(5, 25);
    run(6, 25);
    expect(stage.floorScale).toBe(1);
    run(6, 25);
    expect(stage.floorScale).toBe(0.7);
    expect(localStorage.getItem('exploratory.pixelFloor')).toBe('0.7');
    // Quicker after it (about 55 a second): kept, and kept for next time.
    run(30, 18);
    expect(stage.floorScale).toBe(0.7);
    expect(localStorage.getItem('exploratory.pixelFloor')).toBe('0.7');
  });

  it('takes back a step of the floor that changed nothing, and steps no further', () => {
    useUI.getState().set({ quality: 'low' });
    const { run, stage } = rig(8);
    run(17, 25);
    expect(stage.floorScale).toBe(0.7);
    // Just as slow after it: back to the whole floor, remembered, and no more steps.
    run(10, 25);
    expect(stage.floorScale).toBe(1);
    expect(localStorage.getItem('exploratory.pixelFloor')).toBe('1');
    run(60, 25);
    expect(stage.floorScale).toBe(1);
  });

  it("doesn't step the floor for frames held at 30 a second with little work in them (a cap)", () => {
    useUI.getState().set({ quality: 'low' });
    const { run, stage } = rig(3);
    run(60, 1000 / 30);
    expect(stage.floorScale).toBe(1);
  });

  it('gives a preset chosen in Settings its whole pixel floor back', () => {
    useUI.getState().set({ quality: 'low' });
    const { run, stage } = rig(8);
    stage.floorScale = 0.45;
    useUI.getState().set({ settings: { ...useUI.getState().settings, quality: 'low' } });
    run(1, 16);
    expect(stage.floorScale).toBe(1);
  });

  it('starts saves from before Auto on Auto, but keeps a preset chosen since', () => {
    expect(sanitizeSettings({ quality: 'high' }).quality).toBe('auto');
    expect(sanitizeSettings({ quality: 'low' }).quality).toBe('low');
    expect(sanitizeSettings({ quality: 'high', v: 2 }).quality).toBe('high');
    expect(sanitizeSettings({}).quality).toBe('auto');
    expect(sanitizeSettings({ quality: 'high', v: 3 }).quality).toBe('high');
  });

  it('defaults to a clear day, moving saves still on the old defaults but keeping later choices', () => {
    expect(sanitizeSettings({})).toMatchObject({ timeOfDay: 'daytime', weather: 'clear' });
    expect(sanitizeSettings({ timeOfDay: 'dynamic', weather: 'changing', v: 2 })).toMatchObject({ timeOfDay: 'daytime', weather: 'clear' });
    expect(sanitizeSettings({ timeOfDay: 'dusk', weather: 'storm', v: 2 })).toMatchObject({ timeOfDay: 'dusk', weather: 'storm' });
    expect(sanitizeSettings({ timeOfDay: 'dynamic', weather: 'changing', v: 3 })).toMatchObject({ timeOfDay: 'dynamic', weather: 'changing' });
  });
});
