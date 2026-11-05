// Whether WebGPU will run the game here, found out before the renderer touches the page's canvas.
//
// three's renderer falls back to WebGL2 by itself when WebGPU fails to start, but a failure after
// it has taken the canvas's WebGPU context (a device that can't be made with the features asked
// for, a context that won't configure) leaves the canvas unable to give a WebGL2 one either: the
// game then couldn't start at all ("Cannot read properties of null (reading
// 'getSupportedExtensions')"), as an older Chrome on Android did. Older browsers can also offer
// WebGPU but reject the WGSL three writes (`@interpolate(flat, either)`, in Chrome before about
// version 131), so every shader that uses it fails to build and the island draws in pieces.
//
// So the device is made here, as three would make it, and tried on a throwaway canvas and with a
// shader of three's kind; the renderer is handed the device (nothing is made twice), or told to use
// WebGL2 from the start.

/** The device to draw with, or null for WebGL2. */
export type GpuChoice = GPUDevice | null;

let probe: Promise<GpuChoice> | null = null;

/**
 * The features three's WebGPU backend asks a device for, where the adapter has them (its
 * GPUFeatureName, which three doesn't export): the device made here is the one three draws with.
 */
export const FEATURES = [
  'core-features-and-limits',
  'depth-clip-control',
  'depth32float-stencil8',
  'texture-compression-bc',
  'texture-compression-bc-sliced-3d',
  'texture-compression-etc2',
  'texture-compression-astc',
  'texture-compression-astc-sliced-3d',
  'timestamp-query',
  'indirect-first-instance',
  'shader-f16',
  'rg11b10ufloat-renderable',
  'bgra8unorm-storage',
  'float32-filterable',
  'float32-blendable',
  'clip-distances',
  'dual-source-blending',
  'subgroups',
  'texture-formats-tier1',
  'texture-formats-tier2',
];

/** A shader in the dialect three writes, which a browser too old for it refuses. */
const DIALECT = `
struct V { @builtin(position) p: vec4<f32>, @location(0) @interpolate(flat, either) layer: u32 };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V { return V(vec4<f32>(0.0, 0.0, 0.0, 1.0), i); }
@fragment fn fs(v: V) -> @location(0) vec4<f32> { return vec4<f32>(f32(v.layer)); }
`;

async function choose(): Promise<GpuChoice> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu || new URLSearchParams(location.search).has('webgl')) return null;
  let device: GPUDevice | null = null;
  try {
    // (As three's WebGPU backend asks: the compatibility level, and each feature it knows that the adapter has.)
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance', featureLevel: 'compatibility' } as GPURequestAdapterOptions);
    if (!adapter) return null;
    device = await adapter.requestDevice({ requiredFeatures: FEATURES.filter((f) => adapter.features.has(f)) as GPUFeatureName[] });
    // (Lost before the renderer has it, say to the GPU process restarting: WebGL2 then.)
    void device.lost.then(() => (lost = true));
    let ok = true;
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code: DIALECT });
    const info = await module.getCompilationInfo();
    if (info.messages.some((m) => m.type === 'error')) ok = false;
    const context = document.createElement('canvas').getContext('webgpu') as GPUCanvasContext | null;
    if (!context) ok = false;
    else context.configure({ device, format: gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
    if (await device.popErrorScope()) ok = false;
    context?.unconfigure();
    if (ok) return device;
  } catch {
    /* no usable WebGPU */
  }
  device?.destroy();
  return null;
}

/** Set if the probe's device was lost. */
let lost = false;

/** How long the probe may take before the game starts on WebGL2 instead (a driver that never answers). */
const PATIENCE_MS = 4000;

/** Starts the probe (once) and resolves with its answer. */
export function probeGpu(): Promise<GpuChoice> {
  return (probe ??= new Promise<GpuChoice>((resolve) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      resolve(null);
    }, PATIENCE_MS);
    void choose().then((device) => {
      clearTimeout(timer);
      // (One that came too late is let go: the game has gone on without it.)
      if (late) device?.destroy();
      else resolve(device);
    });
  }));
}

let settled: GpuChoice | undefined;

/** The probe's answer once awaited (see probeGpu); undefined if it was never run. */
export function probedGpu(): GpuChoice | undefined {
  return settled;
}

/** Waits for the probe and keeps its answer for the renderer. */
export async function settleGpu(): Promise<GpuChoice> {
  const device = await probeGpu();
  settled = device && !lost ? device : null;
  return settled;
}
