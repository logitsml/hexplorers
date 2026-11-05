// Procedural vegetation and natural props. Geometry is built once per variant
// and instanced across the board. All sizes are in board units (hex radius = 1);
// geometry origins sit on the ground so instances can be dropped onto terrain.

import * as THREE from 'three/webgpu';
import { Noise, Rand } from '../util/noise';
import { MeshBuilder, compose, displace, smoothSphere, softenNormals, v3 } from './geom';

const col = (h: string) => new THREE.Color(h);
const tmpC = new THREE.Color();

// ---------------------------------------------------------------------------
// Conifer: trunk + layered drooping needle skirts with lobed, jagged tips.
// ---------------------------------------------------------------------------

export function makePine(seed: number, noise: Noise): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const height = r.range(0.42, 0.52);
  const trunkR = 0.018;
  const bark = col('#5b3b24');
  const barkDark = col('#3e2716');

  // Trunk (tapered, slightly leaning).
  const segs = 7;
  const rings = 5;
  const lean = r.range(-0.02, 0.02);
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const y = t * height * 0.75;
    const rad = trunkR * (1 - t * 0.7);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      b.vertex(Math.cos(a) * rad + lean * t, y, Math.sin(a) * rad, tmpC.copy(barkDark).lerp(bark, (i % 2) * 0.5 + t * 0.3), Math.cos(a), 0, Math.sin(a));
    }
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * segs + i, a1 = j * segs + ((i + 1) % segs);
      const c = (j + 1) * segs + i, c1 = (j + 1) * segs + ((i + 1) % segs);
      b.quad(a, c, c1, a1);
    }

  // Foliage tiers from bottom (wide) to top (narrow).
  const tiers = r.int(3) + 7;
  const base = height * 0.16;
  const deep = col('#245a26');
  const midG = col('#3a7d33');
  const tip = col('#8cc043');
  const tipWarm = col('#b2d04f');
  const radial = 22;
  const ringsT = 4;
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const y0 = base + t * (height - base) * 0.88;
    const outerR = (1 - t) * 0.15 + 0.03 + r.range(-0.008, 0.008);
    const droop = outerR * 0.85;
    const tierH = (height - base) / tiers * 1.7;
    const lobes = 5 + r.int(3);
    const phase = r.range(0, Math.PI * 2);
    const rows: number[][] = [];
    // Upper surface: from the trunk top of the tier out to the drooping tips.
    for (let j = 0; j <= ringsT; j++) {
      const s = j / ringsT;
      const row: number[] = [];
      for (let i = 0; i < radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        const lobe = 1 + 0.22 * Math.sin(a * lobes + phase) + 0.12 * noise.noise2(Math.cos(a) * 3 + seed, Math.sin(a) * 3 + k);
        const rad = outerR * s * lobe;
        const y = y0 + tierH * (1 - s) - droop * s * s * (0.8 + 0.2 * lobe) + noise.noise2(a * 2 + k, seed) * 0.006 * s;
        tmpC.copy(deep).lerp(midG, Math.min(1, s * 1.2)).lerp(s > 0.75 ? tipWarm : tip, Math.max(0, s - 0.55) * 1.6 * (0.6 + t * 0.5));
        row.push(b.vertex(Math.cos(a) * rad, y, Math.sin(a) * rad, tmpC));
      }
      rows.push(row);
    }
    for (let j = 0; j < ringsT; j++)
      for (let i = 0; i < radial; i++) {
        const i1 = (i + 1) % radial;
        b.quad(rows[j][i], rows[j][i1], rows[j + 1][i1], rows[j + 1][i]);
      }
    // Underside: from the tips back to the trunk, slightly lower, darker.
    const under: number[] = [];
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      under.push(b.vertex(Math.cos(a) * trunkR * 2, y0 - tierH * 0.15, Math.sin(a) * trunkR * 2, deep));
    }
    const last = rows[ringsT];
    for (let i = 0; i < radial; i++) {
      const i1 = (i + 1) % radial;
      b.quad(last[i], last[i1], under[i1], under[i]);
    }
  }
  // Top spike.
  const topY = height * 1.02;
  const apex = b.vertex(0, topY, 0, tip);
  const ring: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ring.push(b.vertex(Math.cos(a) * 0.022, topY - 0.07, Math.sin(a) * 0.022, midG));
  }
  for (let i = 0; i < 8; i++) b.tri(apex, ring[(i + 1) % 8], ring[i]);

  const g = b.build(true);
  // Each tree lights as one soft cone (outward and a little up), not as separate facets.
  softenNormals(g, (_x, y) => v3(0, Math.min(y, height * 0.9) - 0.09, 0), 0.72);
  return g;
}

// ---------------------------------------------------------------------------
// Broadleaf: branching trunk with a canopy of lumpy leaf clumps.
// ---------------------------------------------------------------------------

export function makeBroadleaf(seed: number, noise: Noise, opts: { birch?: boolean } = {}): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const h = r.range(0.3, 0.38);
  const bark = opts.birch ? col('#e8e2d2') : col('#6a4a2f');
  const barkDark = opts.birch ? col('#4a4440') : col('#4a321e');
  // Trunk as a lathe-like tube.
  const trunk = new THREE.CylinderGeometry(0.012, 0.022, h * 0.62, 7, 3, true);
  b.addGeometry(trunk, compose(0, h * 0.31, 0, 0, 0, r.range(-0.08, 0.08)), (x, y, z, out) => {
    out.copy(bark);
    if (opts.birch && noise.noise2(y * 60, Math.atan2(z, x) * 2) > 0.45) out.copy(barkDark);
    else out.lerp(barkDark, 0.25);
  });
  trunk.dispose();
  // Branches.
  for (let i = 0; i < 3; i++) {
    const br = new THREE.CylinderGeometry(0.006, 0.01, 0.12, 5, 1, true);
    const a = (i / 3) * Math.PI * 2 + r.range(-0.4, 0.4);
    const m = compose(Math.cos(a) * 0.03, h * 0.58, Math.sin(a) * 0.03, 0, -a, 0.85);
    b.addGeometry(br, m, bark);
    br.dispose();
  }
  // Canopy clumps.
  const leafA = opts.birch ? col('#a6cc4c') : col('#5a9e2c');
  const leafB = opts.birch ? col('#dfe873') : col('#a3d24a');
  const leafDeep = col('#326822');
  const clumps = 9 + r.int(6);
  const center = v3(0, h * 0.82, 0);
  for (let i = 0; i < clumps; i++) {
    const u = r.range(0, Math.PI * 2);
    const v = r.range(-0.35, 1);
    const rr = r.range(0.06, 0.11);
    const cx = Math.cos(u) * Math.sqrt(1 - v * v) * 0.09;
    const cz = Math.sin(u) * Math.sqrt(1 - v * v) * 0.09;
    const cy = center.y + v * 0.07;
    const sph = smoothSphere(rr, 2);
    displace(sph, (x, y, z) => noise.noise3(x * 30 + i, y * 30 + seed, z * 30) * rr * 0.28);
    b.addGeometry(sph, compose(cx, cy, cz), (x, y, z, out) => {
      const top = THREE.MathUtils.clamp((y - center.y + 0.1) / 0.22, 0, 1);
      const outward = THREE.MathUtils.clamp(Math.hypot(x, z) / 0.17, 0, 1);
      out.copy(leafDeep).lerp(leafA, 0.35 + outward * 0.4).lerp(leafB, top * 0.65 * (0.6 + 0.4 * noise.noise2(x * 40, z * 40)));
    });
    sph.dispose();
  }
  const g = b.build(false);
  softenNormals(g, (_x, y) => (y > h * 0.55 ? center : v3(0, y, 0)), 0.8);
  return g;
}

// ---------------------------------------------------------------------------
// Undergrowth
// ---------------------------------------------------------------------------

export function makeBush(seed: number, noise: Noise, flowering = false): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const leaf = col('#3f7a26');
  const light = col('#86b947');
  const bloom = col(r.pick(['#f2a7c3', '#fff1b8', '#c9a7f2']));
  const n = 4 + r.int(3);
  for (let i = 0; i < n; i++) {
    const a = r.range(0, Math.PI * 2);
    const rr = r.range(0.035, 0.055);
    const sph = smoothSphere(rr, 2);
    displace(sph, (x, y, z) => noise.noise3(x * 50 + i, y * 50, z * 50 + seed) * rr * 0.3);
    b.addGeometry(sph, compose(Math.cos(a) * 0.035, rr * 0.75 + r.range(0, 0.02), Math.sin(a) * 0.035), (x, y, z, out) => {
      out.copy(leaf).lerp(light, THREE.MathUtils.clamp(y / 0.09, 0, 1));
      if (flowering && noise.noise3(x * 120, y * 120, z * 120) > 0.55) out.copy(bloom);
    });
    sph.dispose();
  }
  const g = b.build(false);
  softenNormals(g, v3(0, 0.02, 0), 0.75);
  return g;
}

/** A tuft of curved grass blades. */
export function makeGrassTuft(seed: number, opts: { blades?: number; height?: number; dry?: boolean; lush?: boolean } = {}): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const blades = opts.blades ?? 7;
  const H = opts.height ?? 0.06;
  const root = opts.dry ? col('#7d7a3a') : col('#3f7a22');
  const tipC = opts.dry ? col('#d8c77a') : opts.lush ? col('#b4e05a') : col('#9ccc4c');
  for (let k = 0; k < blades; k++) {
    const a = r.range(0, Math.PI * 2);
    const lean = r.range(0.15, 0.6);
    const h = H * r.range(0.6, 1.15);
    const w = 0.0055 * r.range(0.7, 1.2);
    const ox = r.range(-0.012, 0.012), oz = r.range(-0.012, 0.012);
    const dx = Math.cos(a), dz = Math.sin(a);
    const px = -dz, pz = dx;
    const segs = 4;
    const left: number[] = [];
    const right: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const bend = lean * t * t * h;
      const y = h * t;
      const ww = w * (1 - t * 0.92);
      tmpC.copy(root).lerp(tipC, t);
      const cx = ox + dx * bend, cz = oz + dz * bend;
      left.push(b.vertex(cx + px * ww, y, cz + pz * ww, tmpC, dx * 0.3, 1, dz * 0.3));
      right.push(b.vertex(cx - px * ww, y, cz - pz * ww, tmpC, dx * 0.3, 1, dz * 0.3));
    }
    for (let s = 0; s < segs; s++) {
      b.quad(left[s], right[s], right[s + 1], left[s + 1]);
      b.quad(right[s], left[s], left[s + 1], right[s + 1]);
    }
  }
  return b.build(false);
}

/** Fern: radial fronds made of tapered, arching strips with leaflet notches. */
export function makeFern(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const fronds = 6 + r.int(4);
  const dark = col('#2f6420');
  const light = col('#7db23c');
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + r.range(-0.2, 0.2);
    const len = r.range(0.07, 0.1);
    const dx = Math.cos(a), dz = Math.sin(a);
    const px = -dz, pz = dx;
    const segs = 7;
    const rowsL: number[] = [];
    const rowsC: number[] = [];
    const rowsR: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const d = len * t;
      const y = Math.sin(t * Math.PI * 0.85) * len * 0.45;
      const notch = s % 2 === 0 ? 1 : 0.55;
      const w = 0.016 * Math.sin(t * Math.PI) * notch + 0.001;
      tmpC.copy(dark).lerp(light, t);
      rowsC.push(b.vertex(dx * d, y + 0.004, dz * d, tmpC));
      rowsL.push(b.vertex(dx * d + px * w, y - w * 0.5, dz * d + pz * w, tmpC));
      rowsR.push(b.vertex(dx * d - px * w, y - w * 0.5, dz * d - pz * w, tmpC));
    }
    for (let s = 0; s < segs; s++) {
      b.quad(rowsC[s], rowsL[s], rowsL[s + 1], rowsC[s + 1]);
      b.quad(rowsC[s], rowsC[s + 1], rowsR[s + 1], rowsR[s]);
      b.quad(rowsL[s], rowsC[s], rowsC[s + 1], rowsL[s + 1]);
      b.quad(rowsR[s + 1], rowsC[s + 1], rowsC[s], rowsR[s]);
    }
  }
  const g = b.build(true);
  softenNormals(g, v3(0, -0.02, 0), 0.5);
  return g;
}

/** A clump of small flowers (white petals; tinted per instance). */
export function makeFlowerClump(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const stem = col('#4f8a2a');
  const petal = col('#ffffff');
  const heart = col('#ffd84a');
  const n = 3 + r.int(4);
  for (let i = 0; i < n; i++) {
    const x = r.range(-0.025, 0.025), z = r.range(-0.025, 0.025);
    const h = r.range(0.025, 0.05);
    // stem
    const s0 = b.vertex(x - 0.0015, 0, z, stem);
    const s1 = b.vertex(x + 0.0015, 0, z, stem);
    const s2 = b.vertex(x + 0.001, h, z, stem);
    const s3 = b.vertex(x - 0.001, h, z, stem);
    b.quad(s0, s1, s2, s3);
    b.quad(s1, s0, s3, s2);
    // blossom: 5 petals around a centre
    const c = b.vertex(x, h + 0.002, z, heart);
    const ring: number[] = [];
    const pr = r.range(0.007, 0.011);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const rr = k % 2 === 0 ? pr : pr * 0.45;
      ring.push(b.vertex(x + Math.cos(a) * rr, h + (k % 2 === 0 ? 0.001 : 0.002), z + Math.sin(a) * rr, petal));
    }
    for (let k = 0; k < 10; k++) {
      b.tri(c, ring[(k + 1) % 10], ring[k]);
      b.tri(c, ring[k], ring[(k + 1) % 10]);
    }
  }
  return b.build(false);
}

/** Ripe wheat stalk clump: stems, leaves and plump bearded ears. */
export function makeWheatClump(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const stemC = col('#b98d34');
  const stemLow = col('#7d8a32');
  const ear = col('#e2b24f');
  const earTip = col('#f3d27a');
  const n = 4 + r.int(3);
  for (let i = 0; i < n; i++) {
    const x = r.range(-0.018, 0.018), z = r.range(-0.018, 0.018);
    const h = r.range(0.1, 0.13);
    const lean = r.range(-0.012, 0.012);
    const segs = 3;
    const L: number[] = [], R: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      tmpC.copy(stemLow).lerp(stemC, t);
      L.push(b.vertex(x - 0.0014 + lean * t * t, h * t, z, tmpC));
      R.push(b.vertex(x + 0.0014 + lean * t * t, h * t, z, tmpC));
    }
    for (let s = 0; s < segs; s++) {
      b.quad(L[s], R[s], R[s + 1], L[s + 1]);
      b.quad(R[s], L[s], L[s + 1], R[s + 1]);
    }
    // Ear: stacked kernels (two rows of small diamonds) forming a plump spike.
    const ex = x + lean, ey = h;
    const kernels = 7;
    for (let k = 0; k < kernels; k++) {
      const t = k / kernels;
      const ky = ey + t * 0.04;
      const kw = 0.0055 * (1 - t * 0.55);
      for (const side of [-1, 1]) {
        const cx = ex + side * kw * 0.6;
        tmpC.copy(ear).lerp(earTip, t);
        const a0 = b.vertex(cx, ky, z - kw * 0.6, tmpC, side, 0.3, 0);
        const a1 = b.vertex(cx + side * kw * 0.8, ky + 0.004, z, tmpC, side, 0.3, 0);
        const a2 = b.vertex(cx, ky + 0.009, z + kw * 0.6, tmpC, side, 0.3, 0);
        const a3 = b.vertex(cx - side * kw * 0.4, ky + 0.004, z, tmpC, -side, 0.3, 0);
        b.quad(a0, a1, a2, a3);
        b.quad(a3, a2, a1, a0);
      }
    }
    // Awns (beard).
    const aw0 = b.vertex(ex - 0.0005, ey + 0.04, z, earTip);
    const aw1 = b.vertex(ex + 0.0005, ey + 0.04, z, earTip);
    const aw2 = b.vertex(ex + lean * 0.5, ey + 0.065, z, earTip);
    b.tri(aw0, aw1, aw2);
    b.tri(aw1, aw0, aw2);
    // A leaf.
    const la = r.range(0, Math.PI * 2);
    const l0 = b.vertex(x, h * 0.35, z, stemLow);
    const l1 = b.vertex(x + Math.cos(la) * 0.03, h * 0.5, z + Math.sin(la) * 0.03, stemC);
    const l2 = b.vertex(x + Math.cos(la + 0.3) * 0.008, h * 0.42, z + Math.sin(la + 0.3) * 0.008, stemLow);
    b.tri(l0, l1, l2);
    b.tri(l0, l2, l1);
  }
  return b.build(false);
}

// ---------------------------------------------------------------------------
// Rocks
// ---------------------------------------------------------------------------

export function makeRock(seed: number, noise: Noise, opts: { flat?: number; color?: string; jagged?: number } = {}): THREE.BufferGeometry {
  const r = new Rand(seed);
  const g = smoothSphere(1, 4);
  const sx = r.range(0.8, 1.3), sy = r.range(0.55, 0.85) * (opts.flat ?? 1), sz = r.range(0.8, 1.2);
  g.scale(sx, sy, sz);
  g.computeVertexNormals();
  const jag = opts.jagged ?? 1;
  displace(g, (x, y, z) => noise.fbm2(x * 1.6 + seed, z * 1.6 + y, 4) * 0.22 * jag + noise.noise3(x * 5, y * 5 + seed, z * 5) * 0.06 * jag);
  // Flatten the bottom so it sits on the ground.
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) < -0.15) p.setY(i, -0.15 + (p.getY(i) + 0.15) * 0.2);
  g.translate(0, 0.12, 0);
  g.computeVertexNormals();
  const base = col(opts.color ?? '#8d8a8f');
  const dark = col('#5a5760');
  const colors: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const n = noise.noise3(p.getX(i) * 3 + seed, p.getY(i) * 3, p.getZ(i) * 3) * 0.5 + 0.5;
    tmpC.copy(dark).lerp(base, 0.45 + n * 0.55);
    colors.push(tmpC.r, tmpC.g, tmpC.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Small props
// ---------------------------------------------------------------------------

export function makeMushrooms(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const n = 2 + r.int(3);
  for (let i = 0; i < n; i++) {
    const x = r.range(-0.02, 0.02), z = r.range(-0.02, 0.02);
    const h = r.range(0.012, 0.022);
    const stem = new THREE.CylinderGeometry(0.0025, 0.0035, h, 6, 1);
    b.addGeometry(stem, compose(x, h / 2, z), col('#f2ead8'));
    stem.dispose();
    const cap = new THREE.SphereGeometry(0.009, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    b.addGeometry(cap, compose(x, h - 0.001, z, 0, 0, 0, 1, 0.7, 1), (cx, _cy, cz, out) => {
      out.set('#c8321f');
      const sp = Math.sin(cx * 900) * Math.sin(cz * 900);
      if (sp > 0.6) out.set('#fff6e8');
    });
    cap.dispose();
  }
  return b.build(false);
}

export function makeLogPile(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const bark = col('#6b4a2c');
  const end = col('#e2b878');
  const rowsCount = [3, 2, 1];
  rowsCount.forEach((count, row) => {
    for (let i = 0; i < count; i++) {
      const rad = 0.013;
      const len = 0.09 + r.range(-0.01, 0.01);
      const log = new THREE.CylinderGeometry(rad, rad, len, 10, 1, false);
      const x = (i - (count - 1) / 2) * rad * 2.05;
      const y = rad + row * rad * 1.75;
      b.addGeometry(log, compose(x, y, r.range(-0.006, 0.006), Math.PI / 2, 0, 0), (_cx, _cy, cz, out) => {
        out.copy(Math.abs(cz) > len / 2 - 0.0005 ? end : bark);
      });
      log.dispose();
    }
  });
  return b.build(false);
}

export function makeStump(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const h = r.range(0.025, 0.035);
  const st = new THREE.CylinderGeometry(0.022, 0.03, h, 12, 1);
  b.addGeometry(st, compose(0, h / 2, 0), (_x, y, _z, out) => out.set(y > h * 0.49 ? '#e0b679' : '#5e4128'));
  st.dispose();
  return b.build(false);
}

/** Ribbed cactus limb: a cylinder with rounded top, fluted into vertical ribs. */
function cactusLimb(b: MeshBuilder, r: number, h: number, m: THREE.Matrix4, base: THREE.Color, ribs = 10) {
  const g = new THREE.CylinderGeometry(r, r * 1.05, h, ribs * 4, Math.max(8, Math.round(h / 0.006)), true);
  g.translate(0, h / 2, 0);
  const cap = new THREE.SphereGeometry(r, ribs * 2, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.translate(0, h, 0);
  for (const geo of [g, cap]) {
    const p = geo.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 + 0.2 * Math.pow(Math.abs(Math.cos(a * ribs * 0.5)), 0.6) - 0.1;
      p.setX(i, x * k);
      p.setZ(i, z * k);
    }
    geo.computeVertexNormals();
    const c = new THREE.Color();
    b.addGeometry(geo, m, (x, y, z, out) => {
      out.copy(base);
      // Lighter rib crests with pale spine speckle, darker grooves.
      const a = Math.atan2(z - m.elements[14], x - m.elements[12]);
      const crest = Math.cos(a * ribs);
      out.multiplyScalar(0.8 + crest * 0.2);
      // Faint vertical streaking and a paler, woodier base.
      out.lerp(c.set('#8aa866'), Math.max(0, Math.sin(a * 23 + y * 40)) * 0.12);
      if (y - m.elements[13] < 0.015) out.lerp(c.set('#9a8a5c'), 0.35);
    });
    geo.dispose();
  }
  // Areoles along each rib crest, each with a small fan of pale spines pointing outward.
  const spine = new THREE.ConeGeometry(0.0007, 0.0075, 3, 1, true);
  spine.translate(0, 0.00375, 0);
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  const pale = new THREE.Color('#efe3bf');
  for (let k = 0; k < ribs; k++) {
    const a = (k / ribs) * Math.PI * 2;
    const rr = r * 1.1;
    for (let y = 0.012; y < h - 0.004; y += 0.014) {
      for (let n = 0; n < 3; n++) {
        pos.set(Math.cos(a) * rr, y + (k % 2) * 0.007, Math.sin(a) * rr);
        // Point outward from the rib, fanned up/down and sideways.
        e.set((n - 1) * 0.5, -a, -Math.PI / 2 + (n - 1) * 0.35, 'YXZ');
        q.setFromEuler(e);
        const local = new THREE.Matrix4().compose(pos, q, one);
        b.addGeometry(spine, m.clone().multiply(local), pale);
      }
    }
  }
  spine.dispose();
}

/** Desert cacti: 0 = saguaro with arms, 1 = barrel cactus with a flower crown, 2 = prickly pear. */
export function makeCactus(seed: number, kind: 0 | 1 | 2): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const green = new THREE.Color('#6b9a4e');
  if (kind === 0) {
    const h = r.range(0.17, 0.22);
    cactusLimb(b, 0.017, h, compose(0, 0, 0), green);
    // Two arms on opposite sides at different heights (sometimes a third), clearly upturned.
    const arms = 2 + (r.chance(0.35) ? 1 : 0);
    for (let i = 0; i < arms; i++) {
      const a = i === 0 ? 0 : i === 1 ? Math.PI : Math.PI / 2;
      const ay = h * (i === 0 ? r.range(0.4, 0.5) : r.range(0.52, 0.64));
      const reach = 0.04;
      const ca = Math.cos(a), sa = Math.sin(a);
      const elbow = new THREE.CylinderGeometry(0.0115, 0.0115, reach, 12, 1, true);
      b.addGeometry(elbow, compose(ca * reach * 0.5, ay, sa * reach * 0.5, 0, -a, Math.PI / 2), green.clone().multiplyScalar(0.9));
      elbow.dispose();
      const knee = smoothSphere(0.0118, 1);
      b.addGeometry(knee, compose(ca * reach, ay, sa * reach), green.clone().multiplyScalar(0.9));
      knee.dispose();
      cactusLimb(b, 0.0115, h * r.range(0.32, 0.45), compose(ca * reach, ay, sa * reach), green, 8);
    }
    if (r.chance(0.5)) {
      const bloom = smoothSphere(0.006, 1);
      b.addGeometry(bloom, compose(0, h + 0.016, 0, 0, 0, 0, 1, 0.6, 1), new THREE.Color('#f6efe0'));
      bloom.dispose();
    }
  } else if (kind === 1) {
    const g = new THREE.SphereGeometry(0.03, 24, 12);
    g.scale(1, 0.85, 1);
    g.translate(0, 0.022, 0);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const k = 1 + 0.1 * Math.cos(Math.atan2(z, x) * 14);
      p.setX(i, x * k);
      p.setZ(i, z * k);
    }
    g.computeVertexNormals();
    b.addGeometry(g, compose(0, 0, 0), (x, _y, z, out) => {
      out.set('#7a9e4c').multiplyScalar(0.8 + 0.2 * Math.cos(Math.atan2(z, x) * 14));
    });
    g.dispose();
    // Hooked spines along the barrel's ribs.
    const spine = new THREE.ConeGeometry(0.0008, 0.008, 3, 1, true);
    spine.translate(0, 0.004, 0);
    const out = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion();
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      for (let th = 0.35; th < 1.9; th += 0.28) {
        out.set(Math.sin(th) * Math.cos(a), Math.cos(th) * 0.85, Math.sin(th) * Math.sin(a)).normalize();
        q.setFromUnitVectors(up, out);
        const p = new THREE.Vector3(Math.sin(th) * Math.cos(a) * 0.033, 0.022 + Math.cos(th) * 0.028, Math.sin(th) * Math.sin(a) * 0.033);
        b.addGeometry(spine, new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)), new THREE.Color('#e9cf8f'));
      }
    }
    spine.dispose();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const f = smoothSphere(0.006, 1);
      b.addGeometry(f, compose(Math.cos(a) * 0.009, 0.05, Math.sin(a) * 0.009, 0, 0, 0, 1, 0.6, 1), new THREE.Color(r.chance(0.5) ? '#f2c33a' : '#e86a4a'));
      f.dispose();
    }
  } else {
    // Prickly pear: flat oval pads stacked at angles, with a few red fruits.
    const pads: [number, number, number, number][] = [[0, 0.03, 0, 0]];
    for (let i = 0; i < 4; i++) {
      const parent = pads[r.int(pads.length)];
      const a = r.range(-0.9, 0.9);
      pads.push([parent[0] + Math.sin(a) * 0.03, parent[1] + 0.035, parent[2] + r.range(-0.006, 0.006), a]);
    }
    for (const [x, y, z, a] of pads) {
      const pad = smoothSphere(0.022, 2);
      pad.scale(0.85, 1, 0.28);
      b.addGeometry(pad, compose(x, y, z, 0, r.range(-0.5, 0.5), a), (px, py, _pz, out) => {
        out.set('#6a9a48');
        if (Math.sin(px * 700 + py * 900) > 0.92) out.set('#efe2b8');
      });
      pad.dispose();
      if (r.chance(0.5)) {
        const fruit = smoothSphere(0.005, 1);
        b.addGeometry(fruit, compose(x + Math.sin(a) * 0.02, y + Math.cos(a) * 0.022, z, 0, 0, 0, 0.8, 1.2, 0.8), new THREE.Color('#b8304a'));
        fruit.dispose();
      }
    }
  }
  return b.build(false);
}

// ---------------------------------------------------------------------------
// The expansions' looks: the oasis's palms, the swamp's and the lake's water plants, the
// swamp's dead snags and the lake's willow.
// ---------------------------------------------------------------------------

/** A strip of quads, both faces, through a list of centre points with a half-width at each. */
function ribbon(b: MeshBuilder, pts: THREE.Vector3[], side: THREE.Vector3[], colors: THREE.Color[], droop = 0) {
  const L: number[] = [], R: number[] = [], L2: number[] = [], R2: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], s = side[i];
    // The two edges hang a little below the spine, so a frond or a leaf has a fold down its middle.
    const dy = -droop * s.length();
    L.push(b.vertex(p.x + s.x, p.y + s.y + dy, p.z + s.z, colors[i]));
    R.push(b.vertex(p.x - s.x, p.y - s.y + dy, p.z - s.z, colors[i]));
    L2.push(b.vertex(p.x + s.x, p.y + s.y + dy, p.z + s.z, colors[i], 0, -1, 0));
    R2.push(b.vertex(p.x - s.x, p.y - s.y + dy, p.z - s.z, colors[i], 0, -1, 0));
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    b.quad(L[i], R[i], R[i + 1], L[i + 1]);
    b.quad(R2[i], L2[i], L2[i + 1], R2[i + 1]);
  }
}

/** A date palm: a ringed trunk curving up out of the sand, a crown of arching fronds, and dates under it. */
export function makePalm(seed: number, noise: Noise): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const h = r.range(0.36, 0.46);
  const lean = r.range(0.04, 0.09);
  const bark = col('#8c6c4a'), barkDark = col('#5a4330');
  const at = (t: number) => new THREE.Vector3(lean * t * t, h * t, 0);
  // Trunk: a tube along a gentle curve, its bark ringed where old fronds fell.
  const segs = 7, rings = 14;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const c = at(t);
    const rad = 0.014 * (1 - t * 0.35) * (1 + (j % 2) * 0.12);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      b.vertex(c.x + Math.cos(a) * rad, c.y, c.z + Math.sin(a) * rad, tmpC.copy(barkDark).lerp(bark, (j % 2) * 0.6 + 0.2), Math.cos(a), 0, Math.sin(a));
    }
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * segs + i, a1 = j * segs + ((i + 1) % segs);
      const c = (j + 1) * segs + i, c1 = (j + 1) * segs + ((i + 1) % segs);
      b.quad(a, a1, c1, c);
    }
  const crown = at(1);
  // Fronds: each a rachis rising out of the crown and arching over, combed with narrow leaflets
  // staggered down both its sides, swept forward and drooping in a shallow V (so from above a
  // frond reads as a feather, not a paddle), longest a third of the way out and dwindling to the
  // tip. The upper fronds stand up fresh and bright; the lowest hang down dry and brown.
  const fronds = 9 + r.int(3);
  const base = col('#3f7428'), mid = col('#5f9a34'), tip = col('#a7c95a');
  const dryBase = col('#7a6236'), dryTip = col('#b39a5e');
  const rachisCol = col('#6f8a3a');
  const UPV = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < fronds + 2; k++) {
    // (The last two are the dead fronds, hanging close under the crown.)
    const dead = k >= fronds;
    const yaw = dead ? r.range(0, Math.PI * 2) : (k / fronds) * Math.PI * 2 + r.range(-0.2, 0.2);
    const len = dead ? r.range(0.11, 0.14) : r.range(0.18, 0.23);
    const up = dead ? -1.05 : k % 3 === 0 ? r.range(0.7, 0.95) : r.range(0.25, 0.55);
    const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    const n = 12;
    const spine: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const droopT = dead ? 0.15 * t * t : 0.9 * t * t;
      spine.push(crown.clone().addScaledVector(dir, len * t * Math.cos(up * (1 - t))).add(new THREE.Vector3(0, len * (Math.sin(up) * t - droopT), 0)));
    }
    const pointAt = (u: number) => {
      const f = Math.min(n - 1e-6, Math.max(0, u * n));
      const i = Math.floor(f);
      return spine[i].clone().lerp(spine[i + 1], f - i);
    };
    // The rachis: a thin, stiff stalk.
    const rc = dead ? dryBase : rachisCol;
    ribbon(b, spine, spine.map((_, i) => across.clone().multiplyScalar(0.0022 * (1 - (i / n) * 0.7))), spine.map(() => rc));
    // The leaflets, alternating sides half a step apart.
    const count = dead ? 8 : 13;
    for (let j = 1; j < count * 2; j++) {
      const sd = j % 2 ? 1 : -1;
      const u = 0.08 + (j / (count * 2)) * 0.9;
      const o = pointAt(u);
      const tangent = pointAt(Math.min(1, u + 0.02)).sub(pointAt(Math.max(0, u - 0.02))).normalize();
      const out = new THREE.Vector3().crossVectors(tangent, UPV).normalize().multiplyScalar(-sd);
      if (!isFinite(out.x)) out.copy(across).multiplyScalar(sd);
      // Swept towards the tip and hanging down from the rachis: the V of the frond.
      const sweep = 0.55 + u * 0.35;
      const d = out.multiplyScalar(Math.cos(sweep)).addScaledVector(tangent, Math.sin(sweep)).add(new THREE.Vector3(0, dead ? -0.6 : -0.32 - u * 0.25, 0)).normalize();
      const ll = (dead ? 0.04 : 0.062) * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.25 + 0.05)), 0.55) * r.range(0.85, 1.1);
      const w = 0.0062 * (dead ? 0.7 : 1);
      const c0 = new THREE.Color().copy(dead ? dryBase : base).lerp(dead ? dryTip : mid, Math.min(1, u * 1.8));
      const c1 = new THREE.Color().copy(dead ? dryTip : mid).lerp(dead ? dryTip : tip, Math.max(0, u * 1.4 - 0.3));
      const pts = [o, o.clone().addScaledVector(d, ll * 0.5).add(new THREE.Vector3(0, -ll * 0.08, 0)), o.clone().addScaledVector(d, ll).add(new THREE.Vector3(0, -ll * 0.22, 0))];
      ribbon(b, pts, [tangent.clone().multiplyScalar(w * 0.5), tangent.clone().multiplyScalar(w * 0.42), tangent.clone().multiplyScalar(0.0004)], [c0, c0.clone().lerp(c1, 0.5), c1]);
    }
  }
  // Dates hanging under the crown.
  for (let k = 0; k < 3; k++) {
    const a = r.range(0, Math.PI * 2);
    const bunch = smoothSphere(0.012, 1);
    bunch.scale(1, 1.4, 1);
    displace(bunch, (x, y, z) => noise.noise3(x * 300, y * 300 + seed, z * 300) * 0.002);
    b.addGeometry(bunch, compose(crown.x + Math.cos(a) * 0.016, crown.y - 0.018, crown.z + Math.sin(a) * 0.016), col(k % 2 ? '#a05a26' : '#7e4220'));
    bunch.dispose();
  }
  return b.build(false);
}

/** Bulrushes: a clump of stems, some carrying their brown heads, and long arching blades. */
export function makeReeds(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const low = col('#4d6a2a'), high = col('#a7b45c'), head = col('#5e3a20');
  const stems = 7 + r.int(4);
  for (let i = 0; i < stems; i++) {
    const x = r.range(-0.014, 0.014), z = r.range(-0.014, 0.014);
    const h = r.range(0.08, 0.135);
    const lx = r.range(-0.01, 0.01), lz = r.range(-0.01, 0.01);
    const pts: THREE.Vector3[] = [], side: THREE.Vector3[] = [], cols: THREE.Color[] = [];
    const a = r.range(0, Math.PI);
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      pts.push(new THREE.Vector3(x + lx * t * t, h * t, z + lz * t * t));
      side.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.0013 * (1 - t * 0.5)));
      cols.push(new THREE.Color().copy(low).lerp(high, t));
    }
    ribbon(b, pts, side, cols);
    if (i % 3 === 0) {
      const cat = new THREE.CylinderGeometry(0.0032, 0.0032, 0.022, 6);
      b.addGeometry(cat, compose(x + lx * 0.8, h * 0.84, z + lz * 0.8), head);
      cat.dispose();
    }
  }
  for (let i = 0; i < 5; i++) {
    const a = r.range(0, Math.PI * 2);
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    const h = r.range(0.07, 0.1), out = r.range(0.02, 0.04);
    const pts: THREE.Vector3[] = [], side: THREE.Vector3[] = [], cols: THREE.Color[] = [];
    for (let s = 0; s <= 5; s++) {
      const t = s / 5;
      pts.push(new THREE.Vector3(dir.x * out * t * t, (h * Math.sin(t * 1.4)) / Math.sin(1.4), dir.z * out * t * t));
      side.push(across.clone().multiplyScalar(0.003 * (1 - t * 0.85)));
      cols.push(new THREE.Color().copy(low).lerp(high, t * 0.8));
    }
    ribbon(b, pts, side, cols);
  }
  return b.build(false);
}

/** Lily pads floating in a cluster, notched to the stem, one of them in flower. */
export function makeLilyPads(seed: number): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const n = 3 + r.int(3);
  for (let k = 0; k < n; k++) {
    const cx = r.range(-0.03, 0.03), cz = r.range(-0.03, 0.03);
    const rad = r.range(0.009, 0.016);
    const notch = r.range(0, Math.PI * 2);
    const c = new THREE.Color().copy(col('#4a7a2c')).lerp(col('#86ad48'), r.next());
    const centre = b.vertex(cx, 0.0012, cz, c);
    const ring: number[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = notch + 0.35 + (i / 12) * (Math.PI * 2 - 0.7);
      ring.push(b.vertex(cx + Math.cos(a) * rad, 0.0005, cz + Math.sin(a) * rad, tmpC.copy(c).multiplyScalar(0.85)));
    }
    for (let i = 0; i < 12; i++) b.tri(centre, ring[i + 1], ring[i]);
    if (k === 0 && r.chance(0.7)) {
      const pink = r.chance(0.5);
      for (let p = 0; p < 6; p++) {
        const petal = new THREE.ConeGeometry(0.0028, 0.008, 4);
        const a = (p / 6) * Math.PI * 2;
        b.addGeometry(petal, compose(cx + Math.cos(a) * 0.002, 0.004, cz + Math.sin(a) * 0.002, Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5), col(pink ? '#f4b6c8' : '#f6f1e4'));
        petal.dispose();
      }
      const heart = smoothSphere(0.0018, 0);
      b.addGeometry(heart, compose(cx, 0.005, cz), col('#f2c94a'));
      heart.dispose();
    }
  }
  return b.build(false);
}

/** A dead tree standing in the swamp: silvered wood, broken limbs, and moss hanging in strands. */
export function makeSnag(seed: number, noise: Noise): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const wood = col('#c3bcb3'), dark = col('#9f9992'), mossC = col('#8d9a58');
  const h = r.range(0.2, 0.3);
  const lean = r.range(-0.18, 0.18);
  const shade = (x: number, y: number, z: number, out: THREE.Color) => {
    out.copy(dark).lerp(wood, 0.45 + 0.55 * (noise.noise3(x * 90 + seed, y * 30, z * 90) * 0.5 + 0.5));
    // Darker where the water has soaked the foot of it.
    if (y < 0.03) out.lerp(dark, 0.6 * (1 - y / 0.03));
  };
  const trunk = new THREE.CylinderGeometry(0.009, 0.026, h, 8, 5, true);
  displace(trunk, (x, y, z) => noise.noise3(x * 80, y * 40 + seed, z * 80) * 0.004);
  b.addGeometry(trunk, compose(lean * h * 0.5, h * 0.5, 0, 0, 0, -lean), shade);
  trunk.dispose();
  // Root flare at the waterline.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r.range(-0.3, 0.3);
    const root = new THREE.ConeGeometry(0.012, 0.05, 5, 1, true);
    b.addGeometry(root, compose(Math.cos(a) * 0.018, 0.004, Math.sin(a) * 0.012, 0, -a, 1.25), shade);
    root.dispose();
  }
  // Broken limbs, angled up and out, and a few strands of moss hanging from them.
  const limbs = 4 + r.int(3);
  for (let i = 0; i < limbs; i++) {
    const t = r.range(0.45, 0.85);
    const a = r.range(0, Math.PI * 2);
    const len = r.range(0.07, 0.13) * (1.2 - t);
    const tilt = r.range(0.6, 1.1);
    const x0 = lean * h * t, y0 = h * t;
    const limb = new THREE.CylinderGeometry(0.0025, 0.0065, len, 5, 1, true);
    limb.translate(0, len / 2, 0);
    b.addGeometry(limb, compose(x0, y0, 0, 0, -a, tilt), shade);
    limb.dispose();
    const ex = x0 + Math.cos(a) * Math.sin(tilt) * len, ey = y0 + Math.cos(tilt) * len, ez = Math.sin(a) * Math.sin(tilt) * len;
    // Twigs forking off each limb, thinner and steeper, so it reads as a tree and not a post.
    for (let k = 0; k < 2; k++) {
      const u = r.range(0.5, 0.9);
      const sx = x0 + (ex - x0) * u, sy = y0 + (ey - y0) * u, sz = ez * u;
      const ta = a + r.range(-0.9, 0.9), tl = len * r.range(0.4, 0.65), tt = tilt * r.range(0.4, 0.8);
      const twig = new THREE.CylinderGeometry(0.0009, 0.0026, tl, 4, 1, true);
      twig.translate(0, tl / 2, 0);
      b.addGeometry(twig, compose(sx, sy, sz, 0, -ta, tt), shade);
      twig.dispose();
    }
    for (let k = 0; k < 2; k++) {
      const u = r.range(0.4, 1);
      const sx = x0 + (ex - x0) * u, sy = y0 + (ey - y0) * u, sz = ez * u;
      const drop = r.range(0.03, 0.06);
      const pts = [0, 1, 2, 3].map((j) => new THREE.Vector3(sx + Math.sin(j) * 0.002, sy - (drop * j) / 3, sz));
      const side = pts.map((_, j) => new THREE.Vector3(Math.cos(a + 1.57), 0, Math.sin(a + 1.57)).multiplyScalar(0.0035 * (1 - j / 4)));
      ribbon(b, pts, side, pts.map((_, j) => new THREE.Color().copy(mossC).multiplyScalar(1 - j * 0.08)));
    }
  }
  return b.build(false);
}

/** A weeping willow: a stout trunk, a rounded crown and a curtain of hanging strands. */
export function makeWillow(seed: number, noise: Noise): THREE.BufferGeometry {
  const r = new Rand(seed);
  const b = new MeshBuilder();
  const h = r.range(0.3, 0.36);
  const trunk = new THREE.CylinderGeometry(0.014, 0.026, h * 0.6, 7, 3, true);
  displace(trunk, (x, y, z) => noise.noise3(x * 60, y * 20 + seed, z * 60) * 0.004);
  b.addGeometry(trunk, compose(0, h * 0.3, 0, 0, 0, r.range(-0.1, 0.1)), (_x, y, _z, out) => out.copy(col('#4e3a28')).lerp(col('#6f5a44'), y * 4));
  trunk.dispose();
  const leafDeep = col('#4f7a2a'), leaf = col('#8fb44a'), leafTip = col('#c8d870');
  const top = h * 0.72;
  for (let i = 0; i < 7; i++) {
    const u = r.range(0, Math.PI * 2), d = r.range(0, 0.06);
    const sph = smoothSphere(r.range(0.06, 0.085), 2);
    sph.scale(1, 0.7, 1);
    displace(sph, (x, y, z) => noise.noise3(x * 30 + i, y * 30 + seed, z * 30) * 0.01);
    b.addGeometry(sph, compose(Math.cos(u) * d, top + r.range(0, 0.04), Math.sin(u) * d), (_x, y, _z, out) => out.copy(leafDeep).lerp(leaf, Math.min(1, (y - top + 0.05) / 0.12)));
    sph.dispose();
  }
  // The curtain: strands falling from round the crown nearly to the ground.
  const strands = 46;
  for (let i = 0; i < strands; i++) {
    const a = (i / strands) * Math.PI * 2 + r.range(-0.06, 0.06);
    const rad = r.range(0.08, 0.13);
    const y0 = top + r.range(-0.01, 0.05);
    const len = r.range(0.14, 0.2);
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    const pts: THREE.Vector3[] = [], side: THREE.Vector3[] = [], cols: THREE.Color[] = [];
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      pts.push(new THREE.Vector3(dir.x * (rad + 0.02 * Math.sin(t * 2)), y0 - len * t, dir.z * (rad + 0.02 * Math.sin(t * 2))));
      side.push(across.clone().multiplyScalar(0.007 * (1 - t * 0.6)));
      cols.push(new THREE.Color().copy(leaf).lerp(leafTip, t));
    }
    ribbon(b, pts, side, cols);
  }
  const g = b.build(false);
  softenNormals(g, (_x, y) => (y > h * 0.4 ? v3(0, top, 0) : v3(0, y, 0)), 0.6);
  return g;
}
