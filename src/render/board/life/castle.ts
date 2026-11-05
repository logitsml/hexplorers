// The castle's rise (the keep and towers on its flat top are the Invasion pieces'): standing
// stones mark the track up it, a cairn and a waymark post stand at its foot, and a beacon on an
// iron basket keeps watch from a shoulder of the rock, smoking by day and glowing at night. A
// pair of ravens wheels about the crag. Should anything ever stir here, the beacon flares and
// the ravens beat away wider.

import * as THREE from 'three/webgpu';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose, displace, smoothSphere } from '../geom';
import { SURFACE } from '../surfaces';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import type { LifeContext, LifeModule } from './common';
import { release } from '../release';
import type { Lamp } from '../../fx/lampLights';
import { rod } from './folk';
import { FIRE, Parts, clearOfPieces, fireMaterial, stillProps, stokeFire } from './props';

const C = (h: string) => new THREE.Color(h);

/** A raven gliding, about 0.05 across the wings, facing +x. */
function makeRaven(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const black = C('#2a2a30'), sheen = C('#3a3e4e');
  const body = smoothSphere(0.0045, 1);
  body.scale(2.4, 0.9, 1);
  b.addGeometry(body, compose(0, 0, 0), black);
  body.dispose();
  const head = smoothSphere(0.003, 1);
  b.addGeometry(head, compose(0.011, 0.001, 0), black);
  head.dispose();
  const beak = new THREE.ConeGeometry(0.0012, 0.005, 4);
  b.addGeometry(beak, compose(0.0155, 0.0005, 0, 0, 0, -Math.PI / 2), C('#1a1a1e'));
  beak.dispose();
  // Broad wings, their tips fingered, and a wedge of a tail; both faces.
  for (const s of [-1, 1]) {
    const pts = [[0.005, 0.004], [-0.004, 0.004], [-0.008, 0.016], [-0.004, 0.026], [0.0, 0.024], [0.004, 0.012]];
    const ring = pts.map(([x, z]) => b.vertex(x, 0.001 + Math.abs(z) * 0.08, s * z, sheen));
    const ring2 = pts.map(([x, z]) => b.vertex(x, 0.0008 + Math.abs(z) * 0.08, s * z, black, 0, -1, 0));
    for (let i = 1; i + 1 < pts.length; i++) {
      if (s > 0) {
        b.tri(ring[0], ring[i], ring[i + 1]);
        b.tri(ring2[0], ring2[i + 1], ring2[i]);
      } else {
        b.tri(ring[0], ring[i + 1], ring[i]);
        b.tri(ring2[0], ring2[i], ring2[i + 1]);
      }
    }
  }
  const t0 = b.vertex(-0.008, 0.0005, 0.002, black), t1 = b.vertex(-0.017, 0.0005, 0.0045, black), t2 = b.vertex(-0.017, 0.0005, -0.0045, black), t3 = b.vertex(-0.008, 0.0005, -0.002, black);
  b.quad(t0, t1, t2, t3);
  b.quad(t3, t2, t1, t0);
  return b.build(false);
}

interface Rise {
  tile: TileInfo;
  fire: THREE.Mesh;
  glow: Lamp;
  beacon: THREE.Vector3;
  flare: number;
  smokeTimer: number;
  top: number;
  /** Whether the rise found room for its beacon. */
  lit: boolean;
}

export class CastleLife implements LifeModule {
  private tiles: TileInfo[] = [];
  private rises: Rise[] = [];
  private beacons = new Map<number, { x: number; z: number }>();
  private ravens: { rise: Rise; node: THREE.Object3D; phase: number }[] = [];
  private parts: Parts;
  private disposables: { dispose(): void }[] = [];

  constructor(private ctx: LifeContext) {
    this.parts = new Parts(ctx.effects, ctx.props);
  }

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'castle');
    const res: Reserved = [];
    for (const t of this.tiles) {
      const pl = t.shape.features.plateau!;
      const foot = pl.track[0];
      // The beacon stands on a shoulder of the rise, round from the track's foot (behind the
      // castle as the camera sees it where it can).
      const rnd = new Rand(t.shape.seed * 19 + 2);
      let best: { x: number; z: number } | null = null, score = -Infinity;
      for (let k = 0; k < 40; k++) {
        const a = rnd.range(0, Math.PI * 2), r = rnd.range(0.48, 0.56);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (!t.shape.canPlace(x, z, 0.04) || Math.hypot(x - foot.x, z - foot.z) < 0.3 || !clearOfPieces(this.ctx.anchors, t.hex.id, x, z, 0.04)) continue;
        const s = -z + Math.hypot(x - foot.x, z - foot.z) * 0.5;
        if (s > score) (score = s), (best = { x, z });
      }
      if (best) {
        this.beacons.set(t.hex.id, best);
        res.push({ hex: t.hex.id, x: best.x, z: best.z, r: 0.06 });
      }
      res.push({ hex: t.hex.id, x: foot.x, z: foot.z, r: 0.07 });
    }
    return res;
  }

  build() {
    const { effects, group } = this.ctx;
    const fireGeo = new THREE.ConeGeometry(0.011, 0.03, 7);
    fireGeo.translate(0, 0.015, 0);
    const ravenGeo = makeRaven();
    this.disposables.push(fireGeo, ravenGeo);
    // Every castle rise's waymarks and beacon in one mesh.
    const still = this.tiles.map((t) => ({ geo: this.buildStatic(t), hex: t.hex }));
    const mesh = stillProps(effects, still, this.disposables);
    still.forEach((p) => p.geo.dispose());
    if (mesh) group.add(mesh);
    for (const t of this.tiles) {
      const bc = this.beacons.get(t.hex.id);
      const fire = new THREE.Mesh(fireGeo, fireMaterial(effects));
      const by = bc ? t.shape.height(bc.x, bc.z) + 0.09 : 0;
      fire.position.set(t.hex.x + (bc?.x ?? 0), by, t.hex.z + (bc?.z ?? 0));
      fire.visible = !!bc;
      group.add(fire);
      const glow = this.ctx.lamps.add(group, { x: fire.position.x, y: by + 0.03, z: fire.position.z }, { color: FIRE, distance: 0.6, strength: bc ? 0.4 : 0 });
      const rise: Rise = { tile: t, fire, glow, beacon: fire.position.clone(), flare: 0, smokeTimer: 0, top: t.shape.features.plateau!.y, lit: !!bc };
      this.rises.push(rise);
      for (let k = 0; k < 2; k++) {
        const node = new THREE.Group();
        // (Ravens are the big crows: larger than the robber's, as the birds go on the island, see pasture.ts.)
        node.scale.setScalar(1.98);
        group.add(node);
        this.parts.add(ravenGeo, node, t.hex.id);
        this.ravens.push({ rise, node, phase: k * Math.PI + t.hex.id });
      }
    }
  }

  /** The waymarks, the cairn and the beacon's post and basket, in one mesh (tile-local x and z, world y). */
  private buildStatic(t: TileInfo): THREE.BufferGeometry {
    const b = new MeshBuilder();
    const pl = t.shape.features.plateau!;
    const h = (x: number, z: number) => t.shape.height(x, z);
    const rnd = new Rand(t.shape.seed * 23 + 9);
    const stone = (x: number, z: number, s: number, tall: number, c: string) => {
      const g = smoothSphere(1, 1);
      displace(g, (px, py, pz) => Math.sin(px * 9 + py * 7 + pz * 11 + x * 40) * 0.08);
      b.addGeometry(g, compose(x, h(x, z) + s * tall * 0.6, z, rnd.range(-0.1, 0.1), rnd.range(0, 6.28), rnd.range(-0.1, 0.1), s, s * tall, s), C(c));
      g.dispose();
    };
    // Standing stones beside the track every so often, on its outer side.
    for (let i = 3; i < pl.track.length - 2; i += 4) {
      const p = pl.track[i], q = pl.track[i + 1];
      const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
      const nx = dz / l, nz = -dx / l;
      const out = Math.sign(nx * p.x + nz * p.z) || 1;
      stone(p.x + nx * out * 0.045, p.z + nz * out * 0.045, 0.009, 2.2, rnd.chance(0.5) ? '#9a958c' : '#8a857c');
    }
    // A cairn and a waymark post where the track leaves the lane.
    const f = pl.track[0], f1 = pl.track[1];
    const side = { x: -(f1.z - f.z), z: f1.x - f.x };
    const sl = Math.hypot(side.x, side.z) || 1;
    const cx = f.x + (side.x / sl) * 0.05, cz = f.z + (side.z / sl) * 0.05;
    for (let k = 0; k < 7; k++) {
      const y = k < 4 ? 0 : k < 6 ? 1 : 2;
      const a = k * 1.7;
      const g = smoothSphere(0.009 - y * 0.0018, 1);
      b.addGeometry(g, compose(cx + (y < 2 ? Math.cos(a) * 0.008 * (2 - y) : 0), h(cx, cz) + 0.005 + y * 0.009, cz + (y < 2 ? Math.sin(a) * 0.008 * (2 - y) : 0), 0, a, 0, 1, 0.75, 1), C(k % 2 ? '#a5a097' : '#8b867e'));
      g.dispose();
    }
    const px = f.x - (side.x / sl) * 0.045, pz = f.z - (side.z / sl) * 0.045, py = h(px, pz);
    rod(b, new THREE.Vector3(px, py - 0.004, pz), new THREE.Vector3(px, py + 0.07, pz), 0.0028, C('#6a4a2e'), 0.0028);
    b.surfaceId = SURFACE.planks;
    const sign = new THREE.BoxGeometry(0.03, 0.012, 0.002);
    b.addGeometry(sign, compose(px + 0.01, py + 0.058, pz, 0, -Math.atan2(f1.z - f.z, f1.x - f.x), 0.1), C('#8a6a48'));
    sign.dispose();
    b.surfaceId = 0;
    // The beacon: a stout post, an iron basket of logs on top.
    const bc = this.beacons.get(t.hex.id);
    if (bc) {
      const by = h(bc.x, bc.z);
      rod(b, new THREE.Vector3(bc.x, by - 0.01, bc.z), new THREE.Vector3(bc.x, by + 0.085, bc.z), 0.0045, C('#4e3a28'));
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        rod(b, new THREE.Vector3(bc.x + Math.cos(a) * 0.012, by + 0.03, bc.z + Math.sin(a) * 0.012), new THREE.Vector3(bc.x, by + 0.002, bc.z), 0.0015, C('#5a4632'));
        rod(b, new THREE.Vector3(bc.x + Math.cos(a) * 0.006, by + 0.082, bc.z + Math.sin(a) * 0.006), new THREE.Vector3(bc.x + Math.cos(a) * 0.016, by + 0.1, bc.z + Math.sin(a) * 0.016), 0.0012, C('#2e2c2a'));
      }
      const ring = new THREE.TorusGeometry(0.016, 0.0013, 4, 12);
      b.addGeometry(ring, compose(bc.x, by + 0.1, bc.z, Math.PI / 2, 0, 0), C('#2e2c2a'));
      b.addGeometry(ring, compose(bc.x, by + 0.088, bc.z, Math.PI / 2, 0, 0, 0.65), C('#2e2c2a'));
      ring.dispose();
      for (let k = 0; k < 3; k++) rod(b, new THREE.Vector3(bc.x - 0.008, by + 0.088 + k * 0.003, bc.z + (k - 1) * 0.005), new THREE.Vector3(bc.x + 0.008, by + 0.09 + k * 0.003, bc.z + (k - 1) * 0.004), 0.0022, C('#3a2a1c'));
    }
    return b.build(false);
  }

  update(dt: number, t: number) {
    const { effects, particles } = this.ctx;
    const flame = stokeFire(effects, t);
    for (const r of this.rises) {
      const id = r.tile.hex.id;
      const rise = effects.riseValues[id] ?? 0;
      // (No beacon burns on a hex pollution has destroyed.)
      const up = rise > -0.05 && r.lit && (effects.scarValues[id] ?? 0) < 0.85;
      r.fire.visible = up;
      r.flare = Math.max(0, r.flare - dt * 0.3);
      const heat = flame * (0.9 + Math.sin(t * 7 + id * 3) * 0.1) * (1 + r.flare * 2);
      r.fire.scale.set(1 + r.flare * 0.4, 0.85 + Math.sin(t * 8 + id) * 0.15 + r.flare * 0.8, 1 + r.flare * 0.4);
      r.fire.position.y = r.beacon.y + Math.max(0, rise);
      r.glow.gain = up ? heat : 0;
      if (up && (r.smokeTimer -= dt * (1 + r.flare * 3)) <= 0) {
        r.smokeTimer = 0.32 + Math.random() * 0.2;
        particles.smoke.emit({
          x: r.beacon.x, y: r.beacon.y + 0.03 + Math.max(0, rise), z: r.beacon.z,
          vx: (Math.random() - 0.5) * 0.02, vy: 0.13 + Math.random() * 0.05, vz: (Math.random() - 0.5) * 0.02,
          life: 3 + Math.random(), size: 0.025, grow: 5, color: r.flare > 0.2 ? '#6a6460' : '#cfc9c2', alpha: 0.34, drag: 0.2, fadeIn: 0.15,
        });
      }
    }
    this.ravens.forEach(({ rise: r, node, phase }, i) => {
      const rise = effects.riseValues[r.tile.hex.id] ?? 0;
      // Wide, slow circles about the crag, rising and falling on the air, wider when startled.
      const ph = t * 0.32 + phase;
      const rad = 0.42 + 0.08 * Math.sin(ph * 0.7) + r.flare * 0.3;
      const x = r.tile.hex.x + Math.cos(ph) * rad, z = r.tile.hex.z + Math.sin(ph) * rad;
      node.position.set(x, r.top + 0.22 + 0.05 * Math.sin(ph * 1.3 + i), z);
      node.rotation.set(-0.35, -(ph + Math.PI / 2), 0, 'YXZ');
      node.visible = rise > -0.05 && (effects.scarValues[r.tile.hex.id] ?? 0) < 0.85;
    });
  }

  produce(hex: number) {
    const r = this.rises.find((x) => x.tile.hex.id === hex);
    if (r) r.flare = 1;
  }

  dispose() {
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.parts.dispose();
    this.ravens = [];
    this.rises = [];
  }
}
