// Shared context for the per-terrain "life" modules (props, ambient animation,
// production effects).

import * as THREE from 'three/webgpu';
import type { TileInfo, TileSet } from '../tiles';
import type { TileEffects } from '../materials';
import type { Animator } from '../../util/tween';
import type { ParticleSystem } from '../../fx/particles';
import type { Noise } from '../../util/noise';
import type { Reserved } from '../decor';
import type { LampLights } from '../../fx/lampLights';
import type { PropBatches } from '../propBatches';

export interface LifeContext {
  tiles: TileSet;
  effects: TileEffects;
  animator: Animator;
  noise: Noise;
  group: THREE.Group;
  /**
   * Where the see-through things go (a river's water, its falls): `group` is drawn as a render
   * bundle, which can't hold anything blended over what's behind it (see render/core/bundles.ts).
   */
  glass: THREE.Group;
  /** The props drawn as instances (see propBatches.ts): `props.mesh` in place of a tile prop's mesh. */
  props: PropBatches;
  particles: {
    dust: ParticleSystem;
    smoke: ParticleSystem;
    sparkle: ParticleSystem;
    soft: ParticleSystem;
    leaves: ParticleSystem;
    spray: ParticleSystem;
    mist: ParticleSystem;
  };
  /** World seconds. */
  now: () => number;
  quality: number;
  /** Lamps that cast real light (see fx/lampLights.ts). */
  lamps: LampLights;
  shake: (amount: number) => void;
  /** Where the modules' pieces may stand (see decor.ts pieceAnchors): props keep clear of them. */
  anchors: Reserved;
  /** How many number discs a hex bears on show now (pollution can take some: see BoardView.discsShown). */
  discsOn?: (hex: number) => number;
}

/**
 * How far the land's workers have downed tools for the rain, 0..1, eased from `was` over a few
 * seconds: they stop as a heavy shower sets in and take up their work again once it eases.
 */
export function shelter(was: number, rain: number, dt: number): number {
  const want = rain > 0.45 ? Math.min(1, (rain - 0.45) / 0.3) : 0;
  return was + (want - was) * Math.min(1, dt * 0.8);
}

export interface LifeModule {
  /** Reserve prop footprints before vegetation is scattered. */
  plan(tiles: TileInfo[]): Reserved;
  build(): void;
  update(dt: number, t: number): void;
  produce(hex: number): void;
  dispose(): void;
}
