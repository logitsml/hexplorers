// The Sea Glass panels' frost, drawn into the frame under each panel instead of by the browser.
//
// Each glass panel of the HUD shows the island under it blurred, flattened and lifted (its CSS
// backdrop-filter: blur(7px) contrast() brightness() saturate(1.8), see styles/glass.css). The
// browser can only do that by reading the frame back from under every panel and filtering it, every
// frame, since the frame under them changes every frame: a large share of the GPU's time, the blur
// nearly all of it, its radius hardly at all.
//
// Here the frame (as shown: graded, tone-mapped) is drawn once more at half a texel per CSS pixel,
// blurred to the same 7 CSS pixels, given the same contrast, brightness and saturation, and laid in
// under the panels' rounded boxes as the frame goes to the screen. The panels keep their tint, grain
// and rim over it; app/frost.ts says where they are and takes the browser's filter off them.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, Loop, abs, clamp, convertToTexture, dot, float, int, length, max, min, mix, screenCoordinate, screenUV, uniform, uniformArray, vec3 } from 'three/tsl';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';

/** The most panels frosted at once. */
export const FROST_MAX = 16;
/** The CSS blur's radius (its standard deviation), in CSS pixels. */
const BLUR_CSS = 7;
/** Texels per CSS pixel of the frame drawn for the frost. */
const DENSITY = 0.5;

export class Frost {
  /** Each panel's box in the canvas's pixels (left, top, right, bottom). */
  readonly boxes = uniformArray(Array.from({ length: FROST_MAX }, () => new THREE.Vector4()), 'vec4');
  /** Each panel's corner radius (canvas pixels) and how much of it shows (its opacity). */
  readonly looks = uniformArray(Array.from({ length: FROST_MAX }, () => new THREE.Vector4()), 'vec4');
  readonly count = uniform(0, 'int');
  /** The CSS filter's contrast and brightness, as app/glassLight.ts sets them from the sky. */
  readonly contrast = uniform(0.25);
  readonly brightness = uniform(1.65);
  /** The frame drawn small for the blur (sized by setScale), while the chain has one. */
  private source: (Node<'vec4'> & { setResolutionScale(k: number): void }) | null = null;
  private pixelRatio = 1;
  private active = false;

  /**
   * `frame` (the shown frame's colour, sRGB) with the frost laid in under the panels; the nodes that
   * own render targets are handed to `own`.
   */
  apply(shown: Node<'vec4'>, frame: Node<'vec3'>, own: <T>(node: T) => T): Node<'vec3'> {
    const source = own(convertToTexture(shown)) as unknown as Node<'vec4'> & { setResolutionScale(k: number): void };
    this.source = source;
    this.setScale();
    // (three's blur spreads over (3 + 2s) / 3 texels: 3.5, the CSS radius at half a texel a pixel.)
    const blurred = (own(gaussianBlur(source, null, (3 * BLUR_CSS * DENSITY - 3) / 2)) as unknown as { getTextureNode(): { sample(uv: Node<'vec2'>): Node<'vec4'> } }).getTextureNode();
    const { boxes, looks, count } = this;
    const cover = Fn(() => {
      const m = float(0).toVar();
      Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }: { i: Node<'int'> }) => {
        const box = boxes.element(i) as unknown as Node<'vec4'>;
        const look = looks.element(i) as unknown as Node<'vec4'>;
        const half = box.zw.sub(box.xy).mul(0.5);
        const q = abs(screenCoordinate.sub(box.xy.add(half))).sub(half.sub(look.x));
        const d = length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(look.x);
        m.assign(max(m, clamp(float(0.5).sub(d), 0, 1).mul(look.y)));
      });
      return m;
    })();
    // The CSS filters in turn, each clamped as the browser's are: contrast, brightness, saturate(1.8).
    const filtered = Fn(() => {
      const c = blurred.sample(screenUV).rgb;
      const lifted = clamp(clamp(c.sub(0.5).mul(this.contrast).add(0.5), 0, 1).mul(this.brightness), 0, 1);
      const grey = dot(lifted, vec3(0.213, 0.715, 0.072));
      return clamp(mix(vec3(grey), lifted, 1.8), 0, 1);
    })();
    return mix(frame, filtered, cover);
  }

  /** The canvas's pixels per CSS pixel (the renderer's pixel ratio), for the small frame's size. */
  setPixelRatio(pr: number) {
    this.pixelRatio = pr;
    this.setScale();
  }

  /** Whether any panel is frosted here: without one, the small frame is drawn at a hundredth of the canvas's size. */
  setActive(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    this.setScale();
  }

  private setScale() {
    this.source?.setResolutionScale(this.active ? DENSITY / Math.max(0.5, this.pixelRatio) : 0.01);
  }
}
