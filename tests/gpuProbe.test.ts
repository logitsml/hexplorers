import { describe, expect, it } from 'vitest';
import { GPUFeatureName } from 'three/src/renderers/webgpu/utils/WebGPUConstants.js';
import { FEATURES } from '../src/render/core/gpuProbe';

describe('the WebGPU probe', () => {
  it('asks the device for the features three asks for, so three can draw with it', () => {
    expect([...FEATURES].sort()).toEqual(Object.values(GPUFeatureName).sort());
  });
});
