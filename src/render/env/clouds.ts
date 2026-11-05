// Cloud shadows: soft patches of shade drifting across the island and the sea with the wind.
// They only take away direct sunlight (applied through each material's received-shadow hook),
// so shaded ground under a cloud keeps its sky light, as it does in reality.
//
// The cloud field is a four-octave noise, far too dear to work out for every pixel of every
// material that takes shadows (and again in the sea's mirror). So it is baked a few times a
// second into a small texture over the cloud layer around the view, which they all sample. The
// wind's drift and the sun's slant are applied when it is sampled, so between bakes the shadows
// still move smoothly; only the noise's slow billowing waits for the next bake.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, If, float, uniform, renderGroup, vec3, vec4, smoothstep, mx_fractal_noise_float, positionWorld, texture, uv, max, abs, length } from 'three/tsl';
import { frameState } from '../util/frame';

// (All the same for every object in a frame, and the drift changes every frame: three's render group,
// written once a render; see render/core/uniformUploads.ts.)
/** 0 = clear sky, 1 = cloud over most of the island. */
export const cloudCover = uniform(0.35).setGroup(renderGroup);
/** How much direct sun a cloud blocks. */
export const cloudDensity = uniform(0.72).setGroup(renderGroup);
/** Wind drift of the cloud field (world units), advanced by World each frame. */
export const cloudDrift = uniform(new THREE.Vector2()).setGroup(renderGroup);
/** Towards the sun (shadows are cast along it from a layer high above). */
export const cloudSunDir = uniform(new THREE.Vector3(0.4, 0.7, -0.5)).setGroup(renderGroup);
/**
 * A squall riding with the raider fleet (board/marks.ts): a dark mass in the cloud field centred
 * at xy on the cloud layer (in the field's own coordinates, drift included), radius z, strength w
 * (0: none, as in every game without the fleet).
 */
export const squall = uniform(new THREE.Vector4(0, 0, 1, 0)).setGroup(renderGroup);

export const LAYER_HEIGHT = 9;
/** Texels across the baked field, and the world units it spans on the cloud layer. */
const SIZE = 768;
const SPAN = 192;
/** Frames between bakes (the noise only billows slowly). */
const BAKE_EVERY = 6;

/** Where the sun ray through world xz (height y) meets the cloud layer, in the field's coordinates. */
const layerPoint = (p: Node<'vec3'>) => {
  const s = cloudSunDir.normalize();
  return p.xz.add(s.xz.div(s.y.max(0.15)).mul(p.y.negate().add(LAYER_HEIGHT))).add(cloudDrift);
};

class CloudField {
  /** The field's corner on the cloud layer at the last bake, and the noise's time then. */
  readonly origin = uniform(new THREE.Vector2(-SPAN / 2, -SPAN / 2));
  private bakeTime = uniform(0);
  readonly target = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
  private quad: THREE.QuadMesh;
  private material = new THREE.NodeMaterial();
  private frames = BAKE_EVERY;
  private fwd = new THREE.Vector3();

  constructor() {
    const t = this.target.texture;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    // The cloud layer's noise at point q, slowly evolving.
    const q = this.origin.add(uv().mul(SPAN));
    const n = mx_fractal_noise_float(vec3(q.mul(0.11), this.bakeTime.mul(0.008)), 4, 2.1, 0.5).mul(0.5).add(0.5);
    // (The squall's edge is torn by noise of its own, so it reads as one more, heavier cloud; and
    // without a squall, none of it is worked out.)
    const storm = Fn(() => {
      const out = float(0).toVar();
      If(squall.w.greaterThan(0), () => {
        const lumps = mx_fractal_noise_float(vec3(q.mul(0.5), this.bakeTime.mul(0.02)), 3, 2.0, 0.5);
        out.assign(smoothstep(squall.z, squall.z.mul(0.25), length(q.sub(squall.xy)).mul(lumps.mul(0.7).add(1))).mul(squall.w));
      });
      return out;
    })();
    this.material.colorNode = vec4(max(n, storm), 0, 0, 1);
    this.material.depthTest = this.material.depthWrite = false;
    this.quad = new THREE.QuadMesh(this.material);
  }

  /**
   * Set the field's texture up on the GPU before any material binds it. Bound first, three gives
   * it a plain texture, and replaces that when the field is first drawn into: materials built in
   * between (all of a precompile's) would go on sampling the plain, empty one, so no cloud shade.
   */
  init(renderer: THREE.Renderer) {
    renderer.initRenderTarget(this.target);
  }

  /** The noise (0..1) at a cloud layer point; past the field's edge it fades to clear sky. */
  sample(q: Node<'vec2'>) {
    const f = q.sub(this.origin).div(SPAN);
    const n = texture(this.target.texture, f).r;
    const edge = smoothstep(0.5, 0.43, max(abs(f.x.sub(0.5)), abs(f.y.sub(0.5))));
    return n.mul(edge);
  }

  /** Re-bake now and then, centred a little ahead of the camera on the cloud layer. */
  update(renderer: THREE.Renderer, camera: THREE.Camera) {
    // (Dry frames only need its pipeline: they draw nothing, and the field they clear is baked
    // again by the next real frame.)
    if (frameState.dry) this.frames = BAKE_EVERY;
    else if (++this.frames < BAKE_EVERY) return;
    if (!frameState.dry) {
      this.frames = 0;
      const fwd = camera.getWorldDirection(this.fwd).setY(0);
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const s = cloudSunDir.value;
      const sl = s.length() || 1;
      const k = LAYER_HEIGHT / Math.max(0.15, s.y / sl) / sl;
      // The point 40 units ahead (most of what is seen lies within the field), on the layer.
      const cx = camera.position.x + fwd.x * 40 + s.x * k + cloudDrift.value.x;
      const cz = camera.position.z + fwd.z * 40 + s.z * k + cloudDrift.value.y;
      // Snapped to whole texels, so a re-centred field samples the noise at the same points.
      const texel = SPAN / SIZE;
      this.origin.value.set(Math.round((cx - SPAN / 2) / texel) * texel, Math.round((cz - SPAN / 2) / texel) * texel);
      this.bakeTime.value = performance.now() / 1000;
    }
    const target = renderer.getRenderTarget();
    const mrt = renderer.getMRT();
    renderer.setMRT(null);
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(target);
    renderer.setMRT(mrt);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}

/** The baked cloud field, re-baked by the stage each frame it draws. */
export const cloudField = new CloudField();

/** Fraction of direct sun reaching world position p (1 = clear, lower under a cloud). */
export const cloudShade = Fn(([p]: [Node<'vec3'>]) => {
  const n = cloudField.sample(layerPoint(p));
  const lo = cloudCover.oneMinus().mul(0.6).add(0.2);
  const cover = smoothstep(lo, lo.add(0.14), n);
  return cover.mul(cloudDensity).oneMinus();
});

/**
 * The cloud shade at the fragment being drawn, as one shared node, so a material that also
 * uses it in its own shading (the sea) evaluates it once rather than twice.
 */
export const cloudShadeHere = cloudShade(positionWorld);

/** Hook for a material's received shadow: the sun's own shadow times the cloud shade. */
export function withCloudShadows(m: THREE.Material) {
  const nm = m as THREE.NodeMaterial & { userData: { clouds?: boolean } };
  if (!nm.isNodeMaterial || nm.userData.clouds || nm.receivedShadowNode) return;
  nm.userData.clouds = true;
  // (three calls this with the shadow value; its typings declare it argument-less.)
  nm.receivedShadowNode = Fn(([shadow]: [Node<'float'>]) => shadow.mul(cloudShadeHere)) as unknown as typeof nm.receivedShadowNode;
  nm.needsUpdate = true;
}

