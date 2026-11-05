import { describe, expect, it, vi } from 'vitest';
import { Animator } from '../src/render/util/tween';

describe('the animator', () => {
  it('drops an animation that throws, and carries on with the rest', async () => {
    const a = new Animator();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let ticks = 0;
    const bad = a.tween({ duration: 1, update: () => { throw new Error('gone'); } });
    const good = a.tween({ duration: 0.5, update: () => void ticks++ });
    a.tick(0.25);
    a.tick(0.25);
    a.tick(0.25);
    await expect(bad.promise).resolves.toBeUndefined();
    await expect(good.promise).resolves.toBeUndefined();
    expect(ticks).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
