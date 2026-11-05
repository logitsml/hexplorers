// Temporal anti-aliasing for Medium and Low, light enough to take the place of SMAA and FXAA.
//
// SMAA and FXAA smooth the edges of one frame. What they can't do is the island's real aliasing:
// wheat, grass and fences thinner than a pixel, and the sea's glints, which a single frame can
// only catch or miss, so they sparkle and crawl as the camera moves. A temporal AA nudges the
// camera by a different fraction of a pixel each frame and blends the frames, so over a few of
// them every pixel is sampled across its area. three's TRAA (High and Ultra) does it with a
// velocity buffer the scene writes, nine-tap neighbourhoods of colour and depth, and two
// full-screen copies a frame, more than Medium and Low can spare.
//
// This one is leaner:
// - No velocity buffer: where a pixel was last frame is worked out from its depth and the
//   camera's last and current matrices. That is exact for everything standing still, which is
//   the island, the sea's surface and nearly all of the frame; what moves on its own (a ship, a
//   sheep, a die) is caught by the neighbourhood clip below, as in every TAA.
// - In display space: it runs on the finished frame (graded, tone-mapped), as mobile TAAs do, so
//   a glint's brightness can't make it flicker and the frame it reads is 8 bits a channel.
// - Two history buffers in turn, so nothing is copied.
// The history is clipped to the colour range of the pixel and its four neighbours this frame
// (narrowed to their spread about their mean: variance clipping), which keeps it from trailing.
// It costs about what SMAA does on Medium and FXAA on Low.
//
// And it can rebuild the frame finer than the scene is drawn (temporal super-resolution: Medium
// on a 2x screen draws the scene at 1.25x and shows it at 2x, rather than leave the browser to
// stretch it). Each pixel of the frame takes this frame's sample in proportion to how near its centre the
// sample's nudge put it, so over the frames each gathers the samples that fell on it; the history
// is read through a Catmull-Rom filter, which keeps what it has gathered sharp, and kept within
// the whole range of the samples round it rather than their spread (the detail finer than the
// samples lies outside it). Its edges come out about half way to drawing the scene at 2x, for a
// small part of that cost.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, ivec2, uv, uniform, texture, abs, max, min, mix, sqrt, exp, dot, getViewPosition, getScreenPosition, passTexture, context, OnBeforeRenderPipeline, OnAfterRenderPipeline } from 'three/tsl';
import { frameState } from '../util/frame';

const _size = new THREE.Vector2();
let _state: unknown;

/** The camera's nudges: Halton (2, 3), eight points about the pixel's centre, in pixels. */
const halton = (i: number, base: number) => {
  let f = 1, r = 0;
  for (; i > 0; i = Math.floor(i / base)) r += (f /= base) * (i % base);
  return r;
};
const JITTER = Array.from({ length: 8 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

/** The neighbours whose colours bound the history (with the pixel itself). */
const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The share of this frame in a pixel whose centre this frame's nudged sample lands on (less the
 * further off it lands): about ten frames' worth of history while still, at the scene's own
 * resolution.
 */
const BLEND = 0.15;

/** `history` drawn back into the box lo..hi along the line to the box's centre (three's clipAABB). */
const clipToBox = (history: Node<'vec3'>, lo: Node<'vec3'>, hi: Node<'vec3'>) => {
  const centre = hi.add(lo).mul(0.5);
  const v = history.sub(centre);
  const unit = abs(v.div(hi.sub(lo).mul(0.5).add(1e-7)));
  const far = max(unit.x, max(unit.y, unit.z));
  return far.greaterThan(1).select(centre.add(v.div(far)), history);
};

/**
 * `tex` at `at` (uv) through a Catmull-Rom filter, in five bilinear reads (Jimenez's): the history
 * read again each frame at a reprojected place would soften by a bilinear blend every frame it
 * moves; this keeps it sharp.
 */
const catmullRom = (tex: THREE.TextureNode, at: Node<'vec2'>) => {
  const size = vec2(tex.size(0 as never) as unknown as Node<'ivec2'>);
  const p = at.mul(size);
  const t1 = p.sub(0.5).floor().add(0.5);
  const f = p.sub(t1);
  const w0 = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5));
  const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
  const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5));
  const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
  const w12 = w1.add(w2);
  const t12 = t1.add(w2.div(w12)).div(size);
  const t0 = t1.sub(1).div(size), t3 = t1.add(2).div(size);
  const read = (x: Node<'float'>, y: Node<'float'>) => tex.sample(vec2(x, y)).rgb;
  const c = read(t12.x, t0.y).mul(w12.x.mul(w0.y))
    .add(read(t0.x, t12.y).mul(w0.x.mul(w12.y)))
    .add(read(t12.x, t12.y).mul(w12.x.mul(w12.y)))
    .add(read(t3.x, t12.y).mul(w3.x.mul(w12.y)))
    .add(read(t12.x, t3.y).mul(w12.x.mul(w3.y)));
  const total = w12.x.mul(w0.y).add(w0.x.mul(w12.y)).add(w12.x.mul(w12.y)).add(w3.x.mul(w12.y)).add(w12.x.mul(w3.y));
  return c.div(total).max(0);
};

const historyTarget = () => {
  const t = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
  t.texture.name = 'ReprojectAA.history';
  return t;
};

type RendererUtils = { resetRendererState(r: THREE.Renderer, s?: unknown): unknown; restoreRendererState(r: THREE.Renderer, s: unknown): void };
type Builder = { renderPipeline?: unknown; context: { renderPipelineState?: { viewOffsetOwner?: unknown } }; getSharedContext(): object };

export class ReprojectAANode extends THREE.TempNode {
  static get type() {
    return 'ReprojectAANode';
  }

  private history = [historyTarget(), historyTarget()];
  /** The history this frame writes (the other is read). */
  private write = 0;
  private material = new THREE.NodeMaterial();
  private quad = new THREE.QuadMesh(this.material);
  private historyIn = texture(this.history[1].texture);
  private result = passTexture(this as unknown as THREE.PassNode, this.history[0].texture);
  /** The camera's projection without its nudge, now and last frame, and its view last frame. */
  private projection = new THREE.Matrix4();
  private projectionInverse = uniform(new THREE.Matrix4());
  private cameraWorld = uniform(new THREE.Matrix4());
  private lastView = uniform(new THREE.Matrix4());
  private lastProjection = uniform(new THREE.Matrix4());
  /** 1 for a frame with no history to blend (the first, or just resized). */
  private fresh = uniform(1);
  /**
   * The scene's resolution as a share of the frame's (each way): under 1 the frame is rebuilt
   * finer than the scene is drawn (temporal super-resolution: see Stage's sceneScale).
   */
  scale = 1;
  private scaleU = uniform(1);
  /** This frame's nudge, in the scene's pixels. */
  private nudge = uniform(new THREE.Vector2());
  private jitterIndex = 0;
  private jittered = false;

  constructor(
    /** The finished frame, as a texture the size of the drawing buffer. */
    private input: THREE.TextureNode,
    /** The scene's depth. */
    private depth: THREE.TextureNode,
    private camera: THREE.PerspectiveCamera,
  ) {
    super('vec4');
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
  }

  getTextureNode() {
    return this.result;
  }

  /**
   * Nudge the camera by this frame's fraction of a pixel (its projection kept unnudged first): a
   * pixel of the scene as drawn, `width` and `height` the frame's.
   */
  private jitter(width: number, height: number) {
    this.camera.updateProjectionMatrix();
    this.projection.copy(this.camera.projectionMatrix);
    const [x, y] = JITTER[this.jitterIndex];
    const w = Math.max(1, Math.round(width * this.scale)), h = Math.max(1, Math.round(height * this.scale));
    this.camera.setViewOffset(w, h, x, y, w, h);
    this.nudge.value.set(x, y);
    this.jittered = true;
  }

  private unjitter() {
    if (!this.jittered) return;
    this.camera.clearViewOffset();
    this.jittered = false;
    this.jitterIndex = (this.jitterIndex + 1) % JITTER.length;
  }

  updateBefore(frame: THREE.NodeFrame): undefined {
    const renderer = frame.renderer!;
    const r = renderer as unknown as THREE.WebGPURenderer;
    const { width, height } = r.getDrawingBufferSize(_size);
    for (const t of this.history) {
      if (t.width !== width || t.height !== height) {
        t.setSize(width, height);
        this.fresh.value = 1;
      }
    }
    // (The first frame with this node: its nudge comes from the pipeline's hook from the next on.)
    if (!this.jittered && !frameState.dry) this.projection.copy(this.camera.projectionMatrix);
    this.projectionInverse.value.copy(this.projection).invert();
    this.cameraWorld.value.copy(this.camera.matrixWorld);
    this.scaleU.value = this.scale;
    const utils = (THREE as unknown as { RendererUtils: RendererUtils }).RendererUtils;
    _state = utils.resetRendererState(renderer, _state);
    r.setRenderTarget(this.history[this.write]);
    this.quad.render(r);
    utils.restoreRendererState(renderer, _state);
    // (A dry frame draws nothing: the history stays as it was, to be read again.)
    if (frameState.dry) return undefined;
    this.result.value = this.history[this.write].texture;
    this.historyIn.value = this.history[this.write].texture;
    this.write = 1 - this.write;
    this.lastView.value.copy(this.camera.matrixWorldInverse);
    this.lastProjection.value.copy(this.projection);
    this.fresh.value = 0;
    return undefined;
  }

  setup(builder: unknown) {
    const b = builder as Builder;
    const state = b.context.renderPipelineState;
    if (b.renderPipeline && state && !state.viewOffsetOwner) {
      state.viewOffsetOwner = this;
      // (Not for a dry frame: it draws nothing, and its history isn't kept.)
      const renderer = (builder as { renderer: THREE.WebGPURenderer }).renderer;
      OnBeforeRenderPipeline(() => {
        if (frameState.dry) return;
        const { width, height } = renderer.getDrawingBufferSize(_size);
        this.jitter(width, height);
      });
      OnAfterRenderPipeline(() => this.unjitter());
    }
    const input = this.input;
    const resolve = Fn(() => {
      const here = uv();
      // This pixel's centre among the scene's pixels as drawn (fewer than the frame's when it is
      // rebuilt finer), the one whose nudged sample lies nearest it, and how near: a sample right
      // on the centre counts fully, one a pixel of the frame away hardly at all, so over the
      // frames, as the nudges move the samples about, each pixel gathers those that fell on it.
      const size = vec2(input.size(0 as never) as unknown as Node<'ivec2'>);
      const centre = here.mul(size);
      const tap = ivec2(centre.sub(0.5).sub(this.nudge).round());
      const off = centre.sub(vec2(tap).add(0.5).add(this.nudge)).div(this.scaleU);
      const near = exp(dot(off, off).mul(-2.3));
      // That sample and its four neighbours this frame: their range, mean and spread.
      const current = input.load(tap).rgb;
      const lo = current.toVar(), hi = current.toVar(), sum = current.toVar(), sq = current.mul(current).toVar();
      for (const [x, y] of NEIGHBOURS) {
        const c = input.load(tap.add(ivec2(x, y))).rgb;
        lo.assign(min(lo, c));
        hi.assign(max(hi, c));
        sum.addAssign(c);
        sq.addAssign(c.mul(c));
      }
      // Where this pixel's surface was last frame, from its depth.
      const z: Node<'float'> = this.depth.load(tap).r;
      const view = getViewPosition(here, z, this.projectionInverse);
      const world = this.cameraWorld.mul(vec4(view, 1));
      const before = getScreenPosition(this.lastView.mul(world).xyz, this.lastProjection);
      const history = catmullRom(this.historyIn, before);
      // The history kept to what this frame shows round the pixel: within its colours' spread
      // about their mean where the scene is drawn as finely as the frame, but within their whole
      // range where the frame is finer (a pixel's own detail, finer than the scene's samples, often
      // lies outside their spread, and clipped to it would be lost).
      const n = NEIGHBOURS.length + 1;
      const mean = sum.div(n);
      const spread = sqrt(max(sq.div(n).sub(mean.mul(mean)), vec3(0))).mul(this.scaleU.lessThan(0.99).select(float(8), float(1.25)));
      const clipped = clipToBox(history, max(lo, mean.sub(spread)), min(hi, mean.add(spread)));
      // Where there is no history (the first frame, or off the last one's edge), this frame
      // alone, smoothly filled between its samples.
      const outside = before.x.lessThan(0).or(before.x.greaterThan(1)).or(before.y.lessThan(0)).or(before.y.greaterThan(1)).or(this.fresh.greaterThan(0.5));
      return vec4(outside.select(input.sample(here).rgb, mix(clipped, current, near.mul(BLEND))), 1);
    });
    // (The pipeline's context, as three's own passes take it.)
    this.material.contextNode = context(b.getSharedContext());
    this.material.fragmentNode = resolve();
    this.material.name = 'ReprojectAA';
    this.material.needsUpdate = true;
    return this.result;
  }

  dispose() {
    super.dispose();
    for (const t of this.history) t.dispose();
    this.material.dispose();
  }
}
