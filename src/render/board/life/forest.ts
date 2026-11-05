// Forests and desert. Forests drop the occasional leaf; on production a tree is
// felled (it tips over with a creak, leaves and wood chips fly), then a sapling
// regrows in its place. The desert has drifting sand and the odd tumbleweed.

import * as THREE from 'three/webgpu';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose } from '../geom';
import { tilePropMaterial } from '../materials';
import type { TileInfo } from '../tiles';
import type { Decor, Reserved } from '../decor';
import type { LifeContext, LifeModule } from './common';
import { release } from '../release';
import { ease } from '../../util/tween';
import { WIND, WIND_ANGLE, windAt } from '../../env/wind';


function makeTumbleweed(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const r = new Rand(9);
  for (let i = 0; i < 26; i++) {
    const g = new THREE.TorusGeometry(0.022 + r.range(0, 0.008), 0.0014, 3, 14);
    b.addGeometry(g, compose(0, 0, 0, r.range(0, 6), r.range(0, 6), r.range(0, 6)), new THREE.Color(r.chance(0.5) ? '#a58a55' : '#8a7046'));
    g.dispose();
  }
  return b.build(false);
}

export class ForestLife implements LifeModule {
  private desert: TileInfo | null = null;
  private leafTimer = 0;
  private sandTimer = 0;
  private weed: { mesh: THREE.Mesh; active: boolean; t: number; from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  private weedCooldown = 8;
  private disposables: { dispose(): void }[] = [];

  constructor(
    private ctx: LifeContext,
    private decor: () => Decor | null,
  ) {}

  plan(tiles: TileInfo[]): Reserved {
    this.desert = tiles.find((t) => t.shape.terrain === 'desert') ?? null;
    return [];
  }

  build() {
    if (this.desert) {
      const geo = makeTumbleweed();
      const mat = tilePropMaterial(this.ctx.effects, this.desert.hex.id, { roughness: 1 });
      this.disposables.push(geo, mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.visible = false;
      this.ctx.group.add(mesh);
      this.weed = { mesh, active: false, t: 0, from: new THREE.Vector3(), to: new THREE.Vector3() };
    }
  }

  update(dt: number) {
    const d = this.decor();
    // Ambient leaves drifting down from broadleaf trees.
    this.leafTimer -= dt;
    if (d && this.leafTimer <= 0 && d.trees.length) {
      this.leafTimer = 0.35 + Math.random() * 0.5;
      const leafy = d.trees.filter((t) => !t.batch.startsWith('pine'));
      const tree = (leafy.length ? leafy : d.trees)[Math.floor(Math.random() * (leafy.length || d.trees.length))];
      // (Not from a tree that is down, or gone for a building.)
      if (!tree.cleared && !tree.felled && (this.ctx.effects.riseValues[tree.hex] ?? 0) > -0.05 && this.ctx.effects.get(tree.hex).y < 0.5) {
        this.ctx.particles.leaves.emit({
          x: tree.x + (Math.random() - 0.5) * 0.12,
          y: tree.y + 0.28 * tree.scale,
          z: tree.z + (Math.random() - 0.5) * 0.12,
          vx: (Math.random() - 0.5) * 0.04,
          vy: -0.05,
          vz: (Math.random() - 0.5) * 0.04,
          life: 4 + Math.random() * 2,
          size: 0.018,
          color: Math.random() < 0.5 ? '#8fbf45' : '#d9b84a',
          spin: 3 + Math.random() * 3,
          drag: 0.4,
          gravity: 0.01,
          fadeIn: 0.1,
        });
      }
    }
    // Desert: wisps of sand and a tumbleweed now and then.
    if (this.desert && (this.ctx.effects.riseValues[this.desert.hex.id] ?? 0) > -0.05) {
      this.sandTimer -= dt;
      if (this.sandTimer <= 0) {
        this.sandTimer = 0.18;
        const a = Math.random() * Math.PI * 2;
        const r = 0.3 + Math.random() * 0.45;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        this.ctx.particles.dust.emit({
          x: this.desert.hex.x + x,
          y: this.desert.shape.height(x, z) + 0.01,
          z: this.desert.hex.z + z,
          vx: WIND.x * 0.06 * windAt(this.desert.hex.x + x, this.desert.hex.z + z) + (Math.random() - 0.5) * 0.03,
          vy: 0.01,
          vz: WIND.y * 0.06 * windAt(this.desert.hex.x + x, this.desert.hex.z + z) + (Math.random() - 0.5) * 0.03,
          life: 2.2,
          size: 0.05,
          grow: 2,
          color: '#e9cf98',
          alpha: 0.25,
          drag: 0.3,
        });
      }
      const w = this.weed;
      if (w) {
        if (!w.active) {
          this.weedCooldown -= dt;
          if (this.weedCooldown <= 0) {
            // Blown across the desert, downwind.
            const a = WIND_ANGLE + Math.PI + (Math.random() - 0.5) * 0.8;
            w.from.set(this.desert.hex.x + Math.cos(a) * 0.55, 0, this.desert.hex.z + Math.sin(a) * 0.55);
            w.to.set(this.desert.hex.x - Math.cos(a) * 0.55, 0, this.desert.hex.z - Math.sin(a) * 0.55);
            w.t = 0;
            w.active = true;
            w.mesh.visible = true;
          }
        } else {
          const p = w.from.clone().lerp(w.to, w.t);
          w.t += dt * 0.12 * windAt(p.x, p.z) * 1.3;
          const lx = p.x - this.desert.hex.x, lz = p.z - this.desert.hex.z;
          const bounce = Math.abs(Math.sin(w.t * 30)) * 0.02;
          w.mesh.position.set(p.x, this.desert.shape.height(lx, lz) + 0.022 + bounce, p.z);
          w.mesh.rotation.x += dt * 5;
          w.mesh.rotation.z += dt * 2;
          w.mesh.scale.setScalar(Math.min(1, Math.sin(Math.min(1, w.t) * Math.PI) * 4));
          if (w.t >= 1) {
            w.active = false;
            w.mesh.visible = false;
            this.weedCooldown = 12 + Math.random() * 18;
          }
        }
      }
    }
  }

  produce(hex: number) {
    const d = this.decor();
    if (!d) return;
    const candidates = d.trees.filter((t) => t.hex === hex && !t.felled && !t.cleared);
    if (!candidates.length) return;
    // Prefer a tree near the front so the player sees it fall.
    const tree = candidates.sort((a, b) => b.z - a.z)[Math.floor(Math.random() * Math.min(3, candidates.length))];
    tree.felled = true;
    const dir = Math.random() * Math.PI * 2;
    const axis = new THREE.Vector3(Math.cos(dir), 0, Math.sin(dir));
    const base = new THREE.Vector3(tree.x, tree.y - 0.004, tree.z);
    const rotY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree.rot);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const a = this.ctx.animator;
    a.tween({
      duration: 1.1,
      easing: ease.inCubic,
      update: (u) => {
        // A building put up meanwhile cleared the tree: it stays gone.
        if (tree.cleared) return;
        q.setFromAxisAngle(axis, u * 1.45).multiply(rotY);
        s.setScalar(tree.scale);
        m.compose(base, q, s);
        d.setTreeMatrix(tree, m);
      },
      done: () => {
        // Crash: leaves and chips burst where the crown lands.
        const tip = new THREE.Vector3(0, 0.3 * tree.scale, 0).applyAxisAngle(axis, 1.45).add(base);
        for (let i = 0; i < 26; i++) {
          this.ctx.particles.leaves.emit({
            x: tip.x,
            y: tip.y + 0.05,
            z: tip.z,
            vx: (Math.random() - 0.5) * 0.5,
            vy: 0.25 + Math.random() * 0.35,
            vz: (Math.random() - 0.5) * 0.5,
            life: 1.8 + Math.random(),
            size: 0.02,
            color: Math.random() < 0.6 ? '#4f8f2a' : '#9cc24a',
            spin: 6,
            gravity: 0.25,
            drag: 1.5,
          });
        }
        for (let i = 0; i < 12; i++) {
          this.ctx.particles.dust.emit({ x: tip.x, y: tip.y, z: tip.z, vx: (Math.random() - 0.5) * 0.3, vy: 0.08, vz: (Math.random() - 0.5) * 0.3, life: 1.1, size: 0.05, grow: 2.4, color: '#c9b892', alpha: 0.45, drag: 2.2 });
        }
        if (!tree.cleared) this.ctx.shake(0.02);
      },
    });
    // Sink the log away and regrow a sapling.
    a.tween({
      delay: 2.4,
      duration: 0.6,
      update: (u) => {
        if (tree.cleared) return;
        q.setFromAxisAngle(axis, 1.45).multiply(rotY);
        s.setScalar(tree.scale * (1 - u));
        m.compose(base.clone().setY(base.y - u * 0.05), q, s);
        d.setTreeMatrix(tree, m);
      },
    });
    a.tween({
      delay: 3.2,
      duration: 2.2,
      easing: ease.outBack,
      update: (u) => {
        // (Not up through a house built on the spot meanwhile.)
        if (tree.cleared) return;
        s.setScalar(Math.max(0.001, tree.scale * u));
        m.compose(base, rotY, s);
        d.setTreeMatrix(tree, m);
      },
      done: () => {
        tree.felled = false;
        // Cleared while down: make sure it is hidden, whatever frame the clearing caught.
        if (tree.cleared) d.setTreeMatrix(tree, m.makeScale(0, 0, 0));
      },
    });
  }

  dispose() {
    // (Everything the island's life put on the board goes with it: see release.)
    release(this.ctx.group);
    this.disposables.forEach((x) => x.dispose());
  }
}
