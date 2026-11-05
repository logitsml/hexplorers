// Wheat fields: a dense crop canopy (rows aligned in world space so neighbouring
// fields read as one), wind waves rolling across it, a golden gust ring on
// production, stooks of harvested sheaves and a windmill whose sails spin up.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn,
  attribute,
  float,
  int,
  vec2,
  vec3,
  vec4,
  positionLocal,
  positionWorld,
  normalWorld,
  time,
  sin,
  dot,
  fract,
  abs,
  mix,
  smoothstep,
  length,
  mx_noise_float,
  luminance,
  color,
  max,
} from 'three/tsl';
import { CORNER_OFFSETS } from '../../../engine/board';
import { Rand } from '../../util/noise';
import { MeshBuilder, compose } from '../geom';
import { detailFade, pooled, scarFor, scorch, tilePropMaterial } from '../materials';
import { SURFACE } from '../surfaces';
import type { TileInfo } from '../tiles';
import type { Reserved } from '../decor';
import { WHEAT_ROW_ANGLE } from '../decor';
import { TILE_SCALE } from '../layout';
import { riverAt } from '../riverCourse';
import { smoothstep as smooth } from '../../util/noise';
import type { LifeContext, LifeModule } from './common';
import { release } from '../release';
import { gust, windAt, windDir, windStrength } from '../../env/wind';

const C = (h: string) => new THREE.Color(h);
const CROP_H = 0.085;

function makeWindmill(): { tower: THREE.BufferGeometry; sails: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const plaster = C('#efe6d3');
  const stone = C('#9b958c');
  const timber = C('#5b4130');
  const roof = C('#7a4a2e');
  // Stone footing, a whitewashed tower and a shingled cap (patterns in the shader).
  b.surfaceId = SURFACE.stone;
  const base = new THREE.CylinderGeometry(0.055, 0.065, 0.02, 10);
  b.addGeometry(base, compose(0, 0.01, 0), stone);
  base.dispose();
  b.surfaceId = SURFACE.whitewash;
  const tower = new THREE.CylinderGeometry(0.036, 0.056, 0.17, 10, 4);
  b.addGeometry(tower, compose(0, 0.105, 0), plaster);
  tower.dispose();
  b.surfaceId = SURFACE.plain;
  const band = new THREE.CylinderGeometry(0.047, 0.05, 0.008, 10);
  b.addGeometry(band, compose(0, 0.09, 0), timber);
  band.dispose();
  b.surfaceId = SURFACE.roof;
  const cap = new THREE.ConeGeometry(0.048, 0.07, 10);
  b.addGeometry(cap, compose(0, 0.225, 0), roof);
  cap.dispose();
  b.surfaceId = SURFACE.plain;
  const door = new THREE.BoxGeometry(0.02, 0.034, 0.01);
  b.addGeometry(door, compose(0, 0.037, 0.056), timber);
  door.dispose();
  const win = new THREE.BoxGeometry(0.012, 0.014, 0.008);
  b.addGeometry(win, compose(0, 0.13, 0.044), C('#3b2a1c'));
  win.dispose();
  const hub = new THREE.CylinderGeometry(0.008, 0.008, 0.03, 8);
  b.addGeometry(hub, compose(0, 0.2, 0.05, Math.PI / 2, 0, 0), timber);
  hub.dispose();
  const tw = b.build(false);
  // Four lattice sails with canvas.
  const s = new MeshBuilder();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const arm = new THREE.BoxGeometry(0.006, 0.15, 0.004);
    s.addGeometry(arm, compose(Math.sin(a) * 0.075, Math.cos(a) * 0.075, 0, 0, 0, -a), timber);
    arm.dispose();
    const cloth = new THREE.BoxGeometry(0.028, 0.1, 0.002);
    const ox = Math.sin(a) * 0.09 + Math.cos(a) * 0.017;
    const oy = Math.cos(a) * 0.09 - Math.sin(a) * 0.017;
    s.addGeometry(cloth, compose(ox, oy, 0.002, 0, 0, -a), C('#f1e7d2'));
    cloth.dispose();
    for (let k = 1; k <= 4; k++) {
      const rung = new THREE.BoxGeometry(0.032, 0.003, 0.003);
      const d = 0.035 + k * 0.022;
      s.addGeometry(rung, compose(Math.sin(a) * d + Math.cos(a) * 0.017, Math.cos(a) * d - Math.sin(a) * 0.017, 0.004, 0, 0, -a), timber);
      rung.dispose();
    }
  }
  return { tower: tw, sails: s.build(false) };
}

function makeStook(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const straw = C('#d6ac52');
  const dark = C('#a8823a');
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const g = new THREE.ConeGeometry(0.012, 0.075, 6, 1, true);
    b.addGeometry(g, compose(Math.cos(a) * 0.012, 0.035, Math.sin(a) * 0.012, Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25), (_x, y, _z, o) => o.copy(dark).lerp(straw, Math.min(1, y / 0.06)));
    g.dispose();
  }
  const tie = new THREE.TorusGeometry(0.016, 0.003, 4, 12);
  b.addGeometry(tie, compose(0, 0.04, 0, Math.PI / 2, 0, 0), C('#8a6a2a'));
  tie.dispose();
  return b.build(false);
}

interface Mill {
  tile: TileInfo;
  sails: THREE.Object3D;
  speed: number;
  boost: number;
  angle: number;
  /** Current turning rate: the sails gather speed in a gust and run down after it. */
  spin: number;
  x: number;
  z: number;
}

export class FieldsLife implements LifeModule {
  private tiles: TileInfo[] = [];
  private mills: Mill[] = [];
  private anchors = new Map<number, { x: number; z: number; angle: number }>();
  private stooks = new Map<number, { x: number; z: number; r: number }[]>();
  private disposables: { dispose(): void }[] = [];

  constructor(private ctx: LifeContext) {}

  plan(tiles: TileInfo[]): Reserved {
    this.tiles = tiles.filter((t) => t.shape.terrain === 'fields');
    const res: Reserved = [];
    for (const t of this.tiles) {
      const rnd = new Rand(t.shape.seed + 91);
      // Windmill near the anchor, nudged until it fits clear of lanes and corners.
      // The sails sweep ~0.2 around the tower: keep the whole mill clear of lanes, corners and the disc.
      let a = t.shape.features.anchor ?? { x: 0.5, z: -0.2, angle: 0 };
      for (let k = 0; k < 120 && !(t.shape.canPlace(a.x, a.z, 0.17) && Math.hypot(a.x, a.z) > 0.48); k++) {
        const ang = rnd.range(0, Math.PI * 2);
        const r = rnd.range(0.44, 0.52);
        a = { x: Math.cos(ang) * r, z: Math.sin(ang) * r, angle: ang };
      }
      this.anchors.set(t.hex.id, a);
      res.push({ hex: t.hex.id, x: a.x, z: a.z, r: 0.12 });
      const st: { x: number; z: number; r: number }[] = [];
      for (let k = 0; k < 30 && st.length < 1 + rnd.int(3); k++) {
        const x = rnd.range(-0.6, 0.6), z = rnd.range(-0.6, 0.6);
        if (!t.shape.canPlace(x, z, 0.03)) continue;
        if (Math.hypot(x - a.x, z - a.z) < 0.18 || st.some((s) => Math.hypot(s.x - x, s.z - z) < 0.12)) continue;
        st.push({ x, z, r: 0.035 });
      }
      this.stooks.set(t.hex.id, st);
      for (const s of st) res.push({ hex: t.hex.id, ...s });
    }
    return res;
  }

  build() {
    const { effects, group, props } = this.ctx;
    const mill = makeWindmill();
    const stookGeo = makeStook();
    this.disposables.push(mill.tower, mill.sails, stookGeo);
    // One crop material for every field: which tile, and its centre, come with the geometry.
    const canopyMat = this.tiles.length ? pooled(effects, 'canopy', () => this.canopyMaterial()) : null;
    if (canopyMat) this.disposables.push(canopyMat);
    for (const t of this.tiles) {
      // Crop canopy.
      const canopy = this.buildCanopy(t, canopyMat!);
      group.add(canopy);
      this.disposables.push(canopy.geometry);
      const mat = tilePropMaterial(effects, t.hex.id, { roughness: 0.85 });
      this.disposables.push(mat);
      const a = this.anchors.get(t.hex.id)!;
      const towerMat = tilePropMaterial(effects, t.hex.id, { roughness: 0.85, surfaces: true });
      this.disposables.push(towerMat);
      const tower = props.mesh(mill.tower, towerMat);
      const y = t.shape.height(a.x, a.z) - 0.004;
      tower.position.set(t.hex.x + a.x, y, t.hex.z + a.z);
      // Face the sails roughly towards the default camera with some variety.
      const yaw = Math.PI * 0.15 + Math.sin(t.hex.id * 3.1) * 0.6;
      tower.rotation.y = yaw;
      tower.scale.setScalar(1.6);
      tower.castShadow = tower.receiveShadow = true;
      const sails = props.mesh(mill.sails, mat);
      sails.position.set(0, 0.2, 0.066);
      sails.castShadow = true;
      tower.add(sails);
      group.add(tower);
      this.mills.push({ tile: t, sails, speed: 0.7 + Math.sin(t.hex.id) * 0.15, boost: 0, angle: t.hex.id, spin: 0.7, x: tower.position.x, z: tower.position.z });
      for (const s of this.stooks.get(t.hex.id)!) {
        const m = props.mesh(stookGeo, mat);
        m.position.set(t.hex.x + s.x, t.shape.height(s.x, s.z) - 0.003, t.hex.z + s.z);
        m.rotation.y = s.x * 13;
        m.scale.setScalar(1.3);
        m.castShadow = m.receiveShadow = true;
        group.add(m);
      }
    }
  }

  /** Crop surface for one tile: a raised, row-textured canopy over the field area. */
  private buildCanopy(t: TileInfo, material: THREE.Material): THREE.Mesh {
    const rings = 46;
    const pos: number[] = [];
    const mk: number[] = [];
    const idx: number[] = [];
    const starts: number[] = [];
    const reserved = [{ ...this.anchors.get(t.hex.id)!, r: 0.13 }, ...this.stooks.get(t.hex.id)!.map((s) => ({ ...s, r: 0.05 }))];
    // Where a river runs through the field the crop falls away gently to a hedged bank (see
    // decor.ts fields) instead of standing over the water in a sheer wall.
    const river = t.shape.ctx.river;
    const bank = (x: number, z: number) => {
      const q = river ? riverAt(river, x, z) : null;
      return q ? smooth(q.half + 0.05, q.half + 0.17, q.d) : 1;
    };
    const cropMask = (x: number, z: number) => {
      // Soft field mask: inside lanes/corners/clearing, sloping down over several steps so
      // the crop's edge leans out like a stand of stalks rather than a cut terrace.
      let m = 0;
      for (const margin of [0, 0.012, 0.024, 0.036, 0.05]) if (t.shape.canPlace(x, z, margin)) m += 0.2;
      m = Math.min(m, bank(x, z));
      for (const r of reserved) {
        const d = Math.hypot(x - r.x, z - r.z);
        if (d < r.r) m *= Math.max(0, (d - r.r * 0.6) / (r.r * 0.4));
      }
      return m;
    };
    let v = 0;
    for (let k = 0; k <= rings; k++) {
      starts.push(v);
      const count = k === 0 ? 1 : 6 * k;
      for (let i = 0; i < count; i++) {
        let x = 0, z = 0;
        if (k > 0) {
          const c = Math.floor(i / k);
          const u = (i % k) / k;
          const [ax, az] = CORNER_OFFSETS[c];
          const [bx, bz] = CORNER_OFFSETS[(c + 1) % 6];
          x = (ax + (bx - ax) * u) * (k / rings) * TILE_SCALE * 0.97;
          z = (az + (bz - az) * u) * (k / rings) * TILE_SCALE * 0.97;
        }
        const m = cropMask(x, z);
        const ground = t.shape.height(x, z);
        const wx = x + t.hex.x, wz = z + t.hex.z;
        const hvar = 0.85 + 0.25 * (this.ctx.noise.noise2(wx * 4, wz * 4) * 0.5 + 0.5);
        // Ragged border: stalks along the edge stand at uneven heights.
        const rag = m < 1 ? 0.7 + 0.5 * (this.ctx.noise.noise2(wx * 19, wz * 19) * 0.5 + 0.5) : 1;
        pos.push(wx, ground + CROP_H * Math.pow(m, 0.7) * hvar * rag - 0.01 * (1 - m), wz);
        mk.push(m);
        v++;
      }
    }
    for (let k = 1; k <= rings; k++) {
      const inner = starts[k - 1];
      const outer = starts[k];
      const outerCount = 6 * k;
      const innerCount = k === 1 ? 1 : 6 * (k - 1);
      for (let c = 0; c < 6; c++)
        for (let s = 0; s < k; s++) {
          const o0 = outer + ((c * k + s) % outerCount);
          const o1 = outer + ((c * k + s + 1) % outerCount);
          const iIdx = (k - 1) * c + s;
          const i0 = k === 1 ? inner : inner + (iIdx % innerCount);
          const tri = (a: number, b: number, cc: number) => {
            if (mk[a] + mk[b] + mk[cc] > 0.05) idx.push(a, b, cc);
          };
          tri(i0, o1, o0);
          if (s < k - 1) tri(i0, inner + ((iIdx + 1) % innerCount), o1);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('crop', new THREE.Float32BufferAttribute(mk, 1));
    // The tile (for its effects and rise) and its centre (for its production's gust ring).
    const n = mk.length;
    g.setAttribute('tile', new THREE.Float32BufferAttribute(new Float32Array(n).fill(t.hex.id), 1));
    const centre = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) centre.set([t.hex.x, t.hex.z], i * 2);
    g.setAttribute('centre', new THREE.Float32BufferAttribute(centre, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private canopyMaterial() {
    const { effects } = this.ctx;
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.78, metalness: 0 });
    const tile = attribute<'float'>('tile', 'float');
    const fx = effects.node.element(int(tile)) as unknown as Node<'vec4'>;
    const riseN = effects.rise.element(int(tile)) as unknown as Node<'float'>;
    const crop = attribute<'float'>('crop', 'float');
    const perp = vec2(-Math.sin(WHEAT_ROW_ANGLE), Math.cos(WHEAT_ROW_ANGLE));
    const center = attribute<'vec2'>('centre', 'vec2');
    const gustAge = effects.now.sub(fx.w);
    const gustRing = Fn(() => {
      const d = length(positionWorld.xz.sub(center));
      const front = gustAge.mul(1.1);
      return smoothstep(0.18, 0.0, abs(d.sub(front))).mul(smoothstep(1.6, 0.4, gustAge)).mul(smoothstep(0.0, 0.05, gustAge));
    });
    m.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const w = p.xz;
      // Gusts roll across the crop as waves of bowing ears, with a fine ripple riding on them.
      const g = gust(w);
      const ripple = sin(dot(w, windDir).mul(9).sub(time.mul(3.4))).mul(0.5).add(0.5);
      const n = mx_noise_float(vec3(w.mul(2.2), time.mul(0.35)));
      const sway = g.mul(0.75).add(ripple.mul(g.mul(0.15).add(0.05))).add(n.mul(0.12)).mul(0.014).mul(windStrength).mul(crop);
      const d = length(w.sub(center));
      const front = gustAge.mul(1.1);
      const ring = smoothstep(0.2, 0.0, abs(d.sub(front))).mul(smoothstep(1.6, 0.4, gustAge)).mul(smoothstep(0.0, 0.05, gustAge));
      p.y.subAssign(sway.mul(0.6).add(ring.mul(0.03).mul(crop)));
      p.xz.addAssign(windDir.mul(sway));
      p.y.addAssign(riseN);
      return p;
    })();
    m.colorNode = Fn(() => {
      const w = positionWorld.xz;
      // Rows that waver a little, as sown by hand, rather than ruled lines.
      const row = fract(dot(w, perp).add(mx_noise_float(vec3(w.mul(3), 4.1)).mul(0.018)).div(0.05));
      // Fine detail fades to its average before a pixel is too coarse for it (no shimmer as the
      // camera moves).
      const furrow = smoothstep(0.32, 0.5, abs(row.sub(0.5))).mul(detailFade(20));
      const ears = mx_noise_float(vec3(w.mul(60), 0)).mul(0.5).mul(detailFade(60)).add(0.5);
      const patches = mx_noise_float(vec3(w.mul(3.5), 1.7)).mul(0.5).add(0.5);
      const gold = mix(color('#b98a2e'), color('#e6bd52'), patches.mul(0.7).add(ears.mul(0.3)));
      const full = mix(gold, color('#9c9440'), smoothstep(0.75, 1.0, patches).mul(0.35));
      // Ripening with the season (effects.season): a green-gold crop at the start of the game that
      // turns to gold over its first rounds, patch by patch rather than all at once.
      const young = mix(color('#9aa548'), color('#c2b452'), patches.mul(0.6).add(ears.mul(0.4)));
      const ripen = smoothstep(0.0, 0.7, effects.season.mul(1.25).sub(patches.mul(0.35)).add(0.35));
      const ripe = mix(young, full, ripen);
      // The bed's sides: wherever the crop mask falls short of full (the skirt, however gently it
      // slopes, which read as a sheet of the top's colour) or the surface turns steep.
      const side = max(smoothstep(0.85, 0.45, normalWorld.y), smoothstep(0.97, 0.55, crop));
      // The sides are a stand of stalks seen from the side: streaked upright at three sizes (the
      // broadest never fades, so even from the table the edge is a crop and not a painted wall),
      // gold where the ears catch the light and darkening down to an olive foot in the stalks'
      // shade, where the bed meets the ground (the crop mask runs from 0 at the foot to 1 on top).
      const y = positionWorld.y;
      const broad = mx_noise_float(vec3(w.mul(13), y.mul(0.6))).mul(0.5).add(0.5);
      const mid = mx_noise_float(vec3(w.mul(42), y.mul(1.4))).mul(0.5).mul(detailFade(42)).add(0.5);
      const fine = mx_noise_float(vec3(w.mul(150), y.mul(3))).mul(0.5).mul(detailFade(150)).add(0.5);
      // (Banded hard, so stalks and the shade between them read apart rather than as a mottle.)
      const bands = smoothstep(0.38, 0.62, broad.mul(0.6).add(mid.mul(0.4)));
      const stalks = bands.mul(0.7).add(fine.mul(0.3));
      const foot = smoothstep(0.0, 0.9, crop);
      const stalk = mix(color('#4f4720'), color('#cfa94a'), stalks).mul(mix(float(0.3), float(1), foot));
      const c = mix(ripe.mul(float(1).sub(furrow.mul(0.26).mul(float(1).sub(side)))), stalk, side.mul(0.85)).toVar();
      const l = luminance(c);
      c.assign(mix(c, vec3(l, l, l).mul(vec3(0.62, 0.66, 0.78)), fx.y.mul(0.72)));
      // Pollution: the crop blighted, and burnt to black stubble on a destroyed hex.
      return vec4(scorch(c, scarFor(effects, tile)), 1);
    })();
    m.emissiveNode = Fn(() => {
      const w = positionWorld.xz;
      // The wind's sheen and gust flashes are sunlight catching the ears: they fade with the
      // sun (or the field glows in the dark). The production glow keeps a dimmer night share.
      const sun = smoothstep(0.02, 0.35, luminance(effects.sunTint));
      const sheen = smoothstep(0.3, 0.95, gust(w)).mul(0.06).mul(sun);
      const glow = gustRing().mul(0.5).mul(sun).add(fx.x.mul(0.18).mul(sun.mul(0.6).add(0.4)));
      return color('#ffc85a').mul(sheen.add(glow)).mul(crop.mul(0.8).add(0.2)).mul(float(1).sub(fx.y.mul(0.8))).mul(scarFor(effects, tile).oneMinus());
    })();
    return m;
  }

  update(dt: number) {
    for (const m of this.mills) {
      const blighted = this.ctx.effects.get(m.tile.hex.id).y > 0.5;
      const target = blighted ? 0.05 : m.speed * windAt(m.x, m.z) * 1.1;
      m.spin += (target - m.spin) * Math.min(1, dt * 0.7);
      m.boost = Math.max(0, m.boost - dt * 0.9);
      m.angle += (m.spin + m.boost * 7) * dt;
      m.sails.rotation.z = -m.angle;
    }
  }

  produce(hex: number) {
    const m = this.mills.find((x) => x.tile.hex.id === hex);
    if (m) m.boost = 1.6;
    const t = this.tiles.find((x) => x.hex.id === hex);
    if (!t) return;
    // Chaff and golden grain motes lifting off the field.
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.35 + Math.random() * 0.4;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      this.ctx.particles.sparkle.emit({
        x: t.hex.x + x,
        y: t.shape.height(x, z) + CROP_H + 0.02,
        z: t.hex.z + z,
        vx: Math.cos(a) * 0.1 + 0.08,
        vy: 0.2 + Math.random() * 0.3,
        vz: Math.sin(a) * 0.1,
        life: 1.4 + Math.random(),
        size: 0.022 + Math.random() * 0.02,
        grow: 0.5,
        color: '#ffd36b',
        drag: 1,
        fadeIn: 0.2,
      });
    }
  }

  dispose() {
    // (Everything the island's life put on the board goes with it: see release.)
    release(this.ctx.group);
    this.disposables.forEach((d) => d.dispose());
    this.mills = [];
  }
}

