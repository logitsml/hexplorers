// Real light from the island's lamps (High and Ultra): house windows and door lanterns, cart
// lanterns, the mine lantern, the kiln fires and the lighthouse throw warm pools onto the ground,
// walls and water around them. There can be dozens of them, and under three's default lighting
// every lit pixel would evaluate every light, so they are shaded with Forward+ clustered
// lighting: a compute pass sorts the lights into a grid over the view, and each pixel only visits
// the few whose reach covers it.

import * as THREE from 'three/webgpu';
import type { Node, NodeBuilder, NodeFrame, LightingNode } from 'three/webgpu';
import { Fn, If, Loop, Break, int, float, log, clamp, screenCoordinate, cameraPosition, positionView, dot, directPointLight } from 'three/tsl';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import ClusteredLightsNode from 'three/addons/tsl/lighting/ClusteredLightsNode.js';
import { SEA_LEVEL } from '../board/layout';
import { lampLevel } from './lamps';
import { GroundGlow } from './groundGlow';

/** The internals of three's clustered lights node that the island's version builds on. */
interface ClusterInternals {
  maxLightsPerCluster: number;
  /** The grid's tiles across and down, as a uniform (three updates it with the grid). */
  _gridDimensions: { x: Node<'float'>; y: Node<'float'> };
  _cameraNear: Node<'float'>;
  _cameraFar: Node<'float'>;
  _lightIndexes: unknown;
  _screenClusterIndex: Node<'int'>;
  create(width: number, height: number): void;
  updateProgram(renderer: THREE.Renderer): void;
  updateBefore(frame: NodeFrame): void;
  getTile(i: Node<'int'>): Node<'int'>;
  getLightData(index: Node<'int'>): { color: Node<'vec3'>; decay: Node<'float'>; viewPosition: Node<'vec3'>; distance: Node<'float'> };
}

/** The parts of the node builder the clustered loop uses. */
type BuilderParts = { renderer: THREE.Renderer; context: { reflectedLight: { directDiffuse: Node<'vec3'>; directSpecular: Node<'vec3'> } }; lightsNode: { setupDirectLight(b: unknown, n: unknown, d: unknown): void } };

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Clustered lights, made safe for the sea's mirror. The mirror renders the scene again from a
 * camera below the water, in the middle of the main pass, and every pass shares this node's
 * light grid: rebuilt for the mirror's camera, it would be what the main view reads when it
 * draws. So the grid is only built for views from above the sea, and views from below (the
 * mirror) skip the point lights (the lit windows still show in it, as glowing surfaces).
 */
class IslandLightsNode extends ClusteredLightsNode {
  private builtFrame = -1;
  /**
   * The pixel's cluster, worked out from the grid's size as a uniform. three's own puts the grid's
   * width and area in the shader as constants, so a new canvas size would make every lit material a
   * new shader: on High and Ultra each resize of the window would compile them all again in the
   * frames after it, and so would a change of preset, whose precompile runs at the old resolution.
   */
  private screenCluster: Node<'int'> | null = null;
  /** Bumped when three replaces the light index buffer (a grid larger than it): materials must bind the new one. */
  private indexBuffers = 0;

  create(width: number, height: number) {
    const self = this as unknown as ClusterInternals;
    const before = self._lightIndexes;
    (ClusteredLightsNode.prototype as unknown as ClusterInternals).create.call(this, width, height);
    if (self._lightIndexes !== before) this.indexBuffers++;
    // three hands attributeArray the index array itself where it takes a count, and the storage
    // node keeps the array as its length. The WGSL builder then tests that length against 0 for
    // every lit shader it writes, turning the millions of indexes into one string each time, which
    // on a large canvas adds seconds to Set sail at High. Given the count it stands for, the
    // shaders come out the same (a storage buffer's length isn't written).
    const indexes = self._lightIndexes as { bufferCount: unknown; value: { count: number } } | null;
    if (indexes && typeof indexes.bufferCount !== 'number') indexes.bufferCount = indexes.value.count;
    this.screenCluster ??= Fn(() => {
      const nx = int(self._gridDimensions.x), ny = int(self._gridDimensions.y);
      const tile = screenCoordinate.div(this.tileSize).floor();
      // (Exponential depth slices, as three's own.)
      const perLog = float(1).div(log(self._cameraFar.div(self._cameraNear)));
      const slice = clamp(log(positionView.z.negate().div(self._cameraNear)).mul(perLog).mul(this.zSlices).floor(), 0, this.zSlices - 1);
      return int(tile.x).add(int(tile.y).mul(nx)).add(int(slice).mul(nx.mul(ny)));
    })().toVar();
    self._screenClusterIndex = this.screenCluster;
  }

  // (Not the light-sorting compute's key, as three's is: it changes with the grid's size, which
  // the shading now reads from a uniform. The index buffer is what the materials bind.)
  customCacheKey() {
    return THREE.LightsNode.prototype.customCacheKey.call(this) * 31 + this.indexBuffers;
  }

  updateBefore(frame: NodeFrame) {
    if (!frame.camera || _p.setFromMatrixPosition(frame.camera.matrixWorld).y <= SEA_LEVEL) return undefined;
    // Once a frame: the ambient-occlusion prepass and the main pass share the camera and the
    // lights, and the grid is sized to the canvas, not the pass.
    if (frame.frameId === this.builtFrame) return undefined;
    this.builtFrame = frame.frameId;
    (ClusteredLightsNode.prototype as unknown as ClusterInternals).updateBefore.call(this, frame);
    return undefined;
  }

  setupLights(nodeBuilder: NodeBuilder, lightNodes: LightingNode[]) {
    const builder = nodeBuilder as unknown as BuilderParts;
    const self = this as unknown as ClusterInternals;
    self.updateProgram(builder.renderer);
    const lightingModel = builder.context.reflectedLight;
    lightingModel.directDiffuse.toStack();
    lightingModel.directSpecular.toStack();
    // The sun, sky and other built-in lights, as usual.
    THREE.LightsNode.prototype.setupLights.call(this, nodeBuilder, lightNodes);
    Fn(() => {
      If(cameraPosition.y.greaterThan(SEA_LEVEL), () => {
        Loop(self.maxLightsPerCluster, ({ i }: { i: Node<'int'> }) => {
          const lightIndex = self.getTile(i);
          If(lightIndex.equal(int(0)), () => {
            Break();
          });
          const { color, decay, viewPosition, distance } = self.getLightData(lightIndex.sub(1));
          const lightVector = viewPosition.sub(positionView);
          If(distance.equal(0).or(dot(lightVector, lightVector).lessThanEqual(distance.mul(distance))), () => {
            // (r186 takes `lightVector`; its type declaration still names the older parameter.)
            const pointLight = directPointLight as unknown as (o: { color: Node; lightVector: Node; cutoffDistance: Node; decayExponent: Node }) => unknown;
            builder.lightsNode.setupDirectLight(builder, this, pointLight({ color, lightVector, cutoffDistance: distance, decayExponent: decay }));
          });
        });
      });
    }, 'void')();
  }
}

/** Clustered lighting with the island's lights node (see above). */
export class IslandLighting extends ClusteredLighting {
  createNode(lights: THREE.Light[] = []) {
    return new IslandLightsNode(this.maxLights, this.tileSize, this.zSlices, this.maxLightsPerCluster).setLights(lights);
  }
}

export interface Lamp {
  light: THREE.PointLight;
  /** Where the lamp is: an empty object on what carries it (the light itself is in LampLights.group). */
  anchor: THREE.Object3D;
  /** Brightness at night, before `gain`. */
  strength: number;
  /** Share of its night brightness it keeps by day (a fire burns all day; a window is dark). */
  day: number;
  /** How much it flickers (0 = steady). */
  flicker: number;
  /** Set by the lamp's owner each frame: fire heat, a lamp hidden under the sea... */
  gain: number;
  seed: number;
  /** Frames in a row the lamp has been out of the scene (see LampLights.update). */
  away: number;
  /** Radius of the pool of light it lays on the ground when lamps cast none (0: none; see groundGlow.ts). */
  pool: number;
}

/** Frames a lamp may spend out of the scene before it is forgotten (see LampLights.update). */
const AWAY_FRAMES = 240;

/**
 * Every lamp in the world. Owners attach a light to the object it belongs to (a house, a cart, a
 * kiln) and can forget it: a lamp whose object has left the scene is dropped, once it has stayed
 * out for a few seconds (a new board's life is built before it joins the scene, and its kilns
 * and lanterns must still be lit when it does), and so is one whose light an owner took away.
 *
 * What the owner holds is an anchor, an empty object where the lamp hangs; the light itself is in
 * a group of the lamps' own at the top of the scene, moved to its anchor each frame. A light in
 * the board's groups would keep them from being drawn as render bundles (a light in one lights
 * only the bundle's own list: see render/core/bundles.ts), and every board has kilns, lit by day.
 */
export class LampLights {
  private lamps = new Set<Lamp>();
  /** The lights, at the top of the scene (put there by update). */
  readonly group = new THREE.Group();
  /** Lights are only in the scene (and so only cost anything) while point lighting is on. */
  enabled = false;

  add(
    parent: THREE.Object3D,
    position: THREE.Vector3Like,
    opts: { color: THREE.Color; distance: number; strength: number; decay?: number; day?: number; flicker?: number; pool?: number },
  ): Lamp {
    const light = new THREE.PointLight(opts.color, 0, opts.distance, opts.decay ?? 1);
    light.castShadow = false;
    // (Dark until update has put it at its anchor.)
    light.visible = false;
    this.group.add(light);
    const anchor = new THREE.Object3D();
    anchor.position.set(position.x, position.y, position.z);
    parent.add(anchor);
    const lamp: Lamp = { light, anchor, strength: opts.strength, day: opts.day ?? 0, flicker: opts.flicker ?? 0.06, gain: 1, seed: Math.random() * 100, away: 0, pool: opts.pool ?? 0 };
    if (lamp.pool > 0) this.glow ??= new GroundGlow();
    this.lamps.add(lamp);
    return lamp;
  }

  /** Pools of light on the ground for lamps that ask for one, while lamps cast none (see groundGlow.ts). */
  private glow: GroundGlow | null = null;

  /**
   * The ground glow's mesh, made the first time it's wanted: the expansions' pieces ask for it
   * with their stand-in, so it compiles with the game (a base game never makes it).
   */
  groundGlow(): THREE.Object3D {
    this.glow ??= new GroundGlow();
    return this.glow.mesh;
  }

  /** The lamps carried by `root` or anything under it (to dim them as it goes). */
  under(root: THREE.Object3D): Lamp[] {
    const out: Lamp[] = [];
    for (const lamp of this.lamps) {
      for (let o: THREE.Object3D | null = lamp.anchor; o; o = o.parent) {
        if (o === root) {
          out.push(lamp);
          break;
        }
      }
    }
    return out;
  }

  update(night: number, t: number, scene: THREE.Object3D) {
    const full = lampLevel(1);
    // (Pools only stand in for real light, and only after dusk.)
    const glow = this.glow;
    const pools = glow && !this.enabled ? THREE.MathUtils.smoothstep(night, 0.15, 0.7) : 0;
    if (glow) {
      if (!glow.mesh.parent) scene.add(glow.mesh);
      glow.begin();
    }
    if (this.group.parent !== scene) scene.add(this.group);
    for (const lamp of this.lamps) {
      const { light, anchor } = lamp;
      // (Its light taken away by its owner: gone.)
      if (light.parent !== this.group) {
        anchor.removeFromParent();
        this.lamps.delete(lamp);
        continue;
      }
      let root: THREE.Object3D = anchor;
      while (root.parent) root = root.parent;
      if (root !== scene) {
        light.visible = false;
        if (++lamp.away > AWAY_FRAMES) {
          light.removeFromParent();
          anchor.removeFromParent();
          this.lamps.delete(lamp);
        }
        continue;
      }
      lamp.away = 0;
      // (Hidden with what carries it: dark.)
      let shown = true;
      for (let o: THREE.Object3D | null = anchor; o && shown; o = o.parent) shown = o.visible;
      if (!shown) {
        light.visible = false;
        continue;
      }
      anchor.getWorldPosition(light.position);
      const s = lamp.seed;
      const flicker = 1 + lamp.flicker * (Math.sin(t * 7.3 + s) * 0.6 + Math.sin(t * 17.9 + s * 1.7) * 0.4);
      if (!this.enabled) {
        light.visible = false;
        if (pools > 0 && lamp.pool > 0) {
          // Laid level at the foot of what carries the lamp (its height above that, scaled).
          _p.copy(light.position);
          const lift = anchor.parent ? anchor.position.y * anchor.parent.getWorldScale(_s).y : 0;
          glow!.put(_p.x, _p.y - lift + 0.014, _p.z, lamp.pool, light.color, lamp.strength * lamp.gain * flicker * pools * 0.45);
        }
        continue;
      }
      light.intensity = (lamp.strength * lampLevel(night, lamp.day * full)) / full * lamp.gain * flicker;
      // A dark lamp (a window by day) stays out of the light grid.
      light.visible = light.intensity > 0;
    }
    glow?.end();
  }
}
