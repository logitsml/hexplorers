// Harbours: a timber pier leaving the coast at the port edge, plank gangways to
// both port intersections, a moored sailing boat that bobs on the swell, and a
// badge (ratio + resource icon) floating above the pier head that always faces the
// camera; its rim takes the colour of the player who settles the harbour.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Board, PortType } from '../../engine';
import { SEA_LEVEL, edgeFrame, hexSdf, segDist } from './layout';
import { isLand } from '../../engine';
import type { SeaLift } from './seaLift';
import { MeshBuilder, compose, smoothSphere } from './geom';
import { headlandReach, type HeadlandSpec } from './headland';
import { Rand } from '../util/noise';
import { Fn, attribute, clamp, float, int, positionLocal, positionGeometry, positionWorld, uniformArray, uniform, vec2, vec3, vec4, mix, smoothstep, vertexColor, mx_noise_float, texture, uv } from 'three/tsl';
import type { Animator } from '../util/tween';
import { ease } from '../util/tween';
import { release } from './release';
import { piecesBright } from './pieces';
import { instancedMesh } from './instancing';

const C = (h: string) => new THREE.Color(h);
const PIER_Y = SEA_LEVEL + 0.2;

export const RESOURCE_COLORS: Record<string, string> = {
  brick: '#b5532f',
  wood: '#3f7a35',
  wool: '#9fd16a',
  wheat: '#e2b440',
  ore: '#7b8a9c',
  any: '#f2e6c8',
};

const iconCache = new Map<string, Promise<HTMLImageElement>>();
function loadIcon(name: string): Promise<HTMLImageElement> {
  let p = iconCache.get(name);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => {
        // (Forgotten, so the next harbour asks again rather than settling for the fallback.)
        iconCache.delete(name);
        reject(e);
      };
      img.src = `${import.meta.env.BASE_URL}art/icons/${name}.webp`;
    });
    iconCache.set(name, p);
  }
  return p;
}

// ---------------------------------------------------------------- emblems
// A harbour's badge is a nautical emblem: a shield showing what the harbour trades, a ribbon
// across it with the rate, and an anchor's ring and stock above. The shield's border takes the
// colour of the player who claims the harbour.

const SHIELD_W = 0.36;
const SHIELD_H = 0.42;
const RIBBON_W = 0.48;
const RIBBON_H = 0.125;
const RIBBON_Y = -0.09;

/** A heater shield centred on the origin: square shoulders, sides curving to a point. */
function shieldShape(w: number, h: number, dy = 0): THREE.Shape {
  const s = new THREE.Shape();
  const r = w * 0.09;
  const top = h / 2 + dy, bottom = -h / 2 + dy;
  s.moveTo(-w / 2 + r, top);
  s.lineTo(w / 2 - r, top);
  s.quadraticCurveTo(w / 2, top, w / 2, top - r);
  s.lineTo(w / 2, dy + h * 0.02);
  s.bezierCurveTo(w / 2, dy - h * 0.28, w * 0.2, dy - h * 0.4, 0, bottom);
  s.bezierCurveTo(-w * 0.2, dy - h * 0.4, -w / 2, dy - h * 0.28, -w / 2, dy + h * 0.02);
  s.lineTo(-w / 2, top - r);
  s.quadraticCurveTo(-w / 2, top, -w / 2 + r, top);
  return s;
}

/** Shape geometry with UVs spanning its bounds 0..1 (ShapeGeometry's own are raw positions). */
function shapeGeo(shape: THREE.Shape, segments = 16): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(shape, segments);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y));
  return g;
}

/** The ribbon's front band, gently arched, and its notched tails folded behind each end. */
function ribbonShapes() {
  const w = RIBBON_W, h = RIBBON_H, y = RIBBON_Y, arch = 0.018;
  const band = new THREE.Shape();
  band.moveTo(-w / 2, y - h / 2);
  band.quadraticCurveTo(0, y - h / 2 + arch * 2, w / 2, y - h / 2);
  band.lineTo(w / 2, y + h / 2);
  band.quadraticCurveTo(0, y + h / 2 + arch * 2, -w / 2, y + h / 2);
  band.closePath();
  const tail = (side: number) => {
    const t = new THREE.Shape();
    const x0 = side * (w / 2 - 0.03), x1 = side * (w / 2 + 0.06);
    t.moveTo(x0, y - h / 2 - 0.03);
    t.lineTo(x1, y - h / 2 - 0.03);
    t.lineTo(x1 - side * 0.03, y - 0.03);
    t.lineTo(x1, y + h / 2 - 0.03);
    t.lineTo(x0, y + h / 2 - 0.03);
    t.closePath();
    return t;
  };
  return { band, tails: [tail(-1), tail(1)] };
}

/** The anchor's ring and stock, peeking above the shield. */
function anchorShape(): THREE.Shape[] {
  const ring = new THREE.Shape();
  const cy = SHIELD_H / 2 + 0.05;
  ring.absarc(0, cy, 0.036, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, cy, 0.021, 0, Math.PI * 2, true);
  ring.holes.push(hole);
  const stock = new THREE.Shape();
  const sy = SHIELD_H / 2 + 0.006, sw = 0.24, sh = 0.026;
  stock.moveTo(-sw / 2, sy - sh / 2);
  stock.lineTo(sw / 2, sy - sh / 2);
  stock.absarc(sw / 2, sy, sh / 2, -Math.PI / 2, Math.PI / 2, false);
  stock.lineTo(-sw / 2, sy + sh / 2);
  stock.absarc(-sw / 2, sy, sh / 2, Math.PI / 2, Math.PI * 1.5, false);
  return [ring, stock];
}

/** Parchment canvas with a soft vignette. */
function parchment(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const grd = ctx.createRadialGradient(x + w / 2, y + h * 0.38, Math.min(w, h) * 0.1, x + w / 2, y + h / 2, Math.max(w, h) * 0.62);
  grd.addColorStop(0, '#fbf2dc');
  grd.addColorStop(1, '#e2cc9c');
  ctx.fillStyle = grd;
  ctx.fillRect(x, y, w, h);
}

/** What each harbour can trade, in the order of the emblem atlas's shields. */
const PORT_TYPES: PortType[] = ['brick', 'wood', 'wool', 'wheat', 'ore', 'any'];
const SHIELD_PX = 256;
const SHIELD_PY = Math.round((256 * SHIELD_H) / SHIELD_W);
const RIBBON_PX = 512;
const RIBBON_PY = Math.round((512 * RIBBON_H) / RIBBON_W);
const ATLAS_W = SHIELD_PX * PORT_TYPES.length;
const ATLAS_H = SHIELD_PY + RIBBON_PY;

/**
 * Every harbour's painted parts in one texture, made once for the session: a shield field per
 * kind of harbour (what it trades, or the trade sign for any) along the top, and the ribbon's
 * two rates (2:1, 3:1) below.
 */
let atlas: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; icons: number; font: boolean } | null = null;

const FONT = '"Fraunces Variable", Georgia, serif';

function drawShield(ctx: CanvasRenderingContext2D, i: number, img: HTMLImageElement | null) {
  const x0 = i * SHIELD_PX;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, 0, SHIELD_PX, SHIELD_PY);
  ctx.clip();
  parchment(ctx, x0, 0, SHIELD_PX, SHIELD_PY);
  // A fine inner keyline following the shield.
  ctx.save();
  ctx.translate(x0, 0);
  ctx.scale(SHIELD_PX / SHIELD_W, -SHIELD_PY / SHIELD_H);
  ctx.translate(SHIELD_W / 2, -SHIELD_H / 2);
  const inner = shieldShape(SHIELD_W * 0.86, SHIELD_H * 0.88);
  ctx.beginPath();
  inner.getPoints(24).forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.lineWidth = 0.004;
  ctx.strokeStyle = 'rgba(122, 90, 52, 0.55)';
  ctx.stroke();
  ctx.restore();
  // The icon sits in the upper part, clear of the ribbon.
  const size = SHIELD_PX * 0.58, cx = x0 + SHIELD_PX / 2, cy = SHIELD_PY * 0.34;
  if (img) ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
  else {
    ctx.fillStyle = RESOURCE_COLORS[PORT_TYPES[i]];
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.36, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawRibbons(ctx: CanvasRenderingContext2D) {
  ['2:1', '3:1'].forEach((rate, j) => {
    const x0 = j * RIBBON_PX, y0 = SHIELD_PY;
    parchment(ctx, x0, y0, RIBBON_PX, RIBBON_PY);
    ctx.fillStyle = '#2c2118';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(RIBBON_PY * 0.86)}px ${FONT}`;
    ctx.fillText(rate, x0 + RIBBON_PX / 2, y0 + RIBBON_PY * 0.55);
  });
}

/** The emblem atlas (drawn on first use; icons painted in as they load, the rates redrawn once the display font is in). */
function emblemAtlas() {
  if (!atlas) {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_W;
    canvas.height = ATLAS_H;
    const ctx = canvas.getContext('2d')!;
    PORT_TYPES.forEach((_, i) => drawShield(ctx, i, null));
    drawRibbons(ctx);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    const a = (atlas = { canvas, texture: t, icons: 0, font: document.fonts?.check?.(`700 32px ${FONT}`) ?? true });
    PORT_TYPES.forEach((type, i) =>
      loadIcon(type === 'any' ? 'trade' : type)
        .then((img) => {
          drawShield(ctx, i, img);
          a.icons++;
          t.needsUpdate = true;
        })
        .catch(() => {}),
    );
  } else if (!atlas.font && document.fonts?.check?.(`700 32px ${FONT}`)) {
    // The display font had not loaded when the rates were first lettered.
    atlas.font = true;
    drawRibbons(atlas.canvas.getContext('2d')!);
    atlas.texture.needsUpdate = true;
  }
  if (atlas.icons < PORT_TYPES.length) {
    // (An icon that failed to load is asked for again with the next board.)
    const a = atlas;
    const ctx = a.canvas.getContext('2d')!;
    PORT_TYPES.forEach((type, i) => loadIcon(type === 'any' ? 'trade' : type).then((img) => {
      drawShield(ctx, i, img);
      a.texture.needsUpdate = true;
    }).catch(() => {}));
  }
  return atlas.texture;
}

function makePier(length: number, rnd: Rand): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const plank = C('#8a6440');
  const plankDark = C('#6b4b2e');
  const post = C('#4a3424');
  const deckY = 0;
  const width = 0.22;
  const planks = Math.round(length / 0.04);
  for (let i = 0; i < planks; i++) {
    const g = new THREE.BoxGeometry(0.036, 0.014, width + rnd.range(-0.008, 0.008));
    b.addGeometry(g, compose(i * 0.04 + 0.02, deckY + rnd.range(-0.002, 0.002), 0, 0, rnd.range(-0.04, 0.04), 0), (i % 3 === 0 ? plankDark : plank).clone().offsetHSL(0, 0, rnd.range(-0.03, 0.03)));
    g.dispose();
  }
  // Stringers and posts going down into the water.
  for (const side of [-1, 1]) {
    const s = new THREE.BoxGeometry(length, 0.014, 0.012);
    b.addGeometry(s, compose(length / 2, deckY - 0.01, side * (width / 2 - 0.008)), post);
    s.dispose();
    for (let x = 0.04; x < length; x += 0.12) {
      const p = new THREE.CylinderGeometry(0.013, 0.016, 0.5, 8);
      b.addGeometry(p, compose(x, deckY - 0.23, side * (width / 2 + 0.002)), post);
      p.dispose();
    }
  }
  // Mooring bollards at the end.
  for (const side of [-1, 1]) {
    const bo = new THREE.CylinderGeometry(0.008, 0.01, 0.03, 8);
    b.addGeometry(bo, compose(length - 0.02, deckY + 0.02, side * 0.05), post);
    bo.dispose();
  }
  return b.build(false);
}

/** A thin rod between two points (rigging, rails, oars). */
function rod(b: MeshBuilder, a: THREE.Vector3, c: THREE.Vector3, r: number, color: THREE.Color, sides = 4) {
  const len = a.distanceTo(c);
  const g = new THREE.CylinderGeometry(r, r, len, sides, 1, true);
  const mid = a.clone().add(c).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize());
  b.addGeometry(g, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)), color);
  g.dispose();
}

/**
 * A clinker-built harbour boat about 0.25 long (bow towards +x): a lofted plank hull with
 * a painted top strake, thwarts, stem and sternpost, rudder and tiller, a gaff-rigged mast
 * with stays, oars and a little cargo. The sail is separate (double-sided material).
 */
function makeBoat(trim: string, rnd: Rand): { hull: THREE.BufferGeometry; sail: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const L = 0.125, B = 0.048, D = 0.04;
  const ST = 20, SEC = 10;
  const plank = C('#8a5d38'), plankDark = C('#5e3c22'), inner = C('#b48a5a'), bottom = C('#3a2a22');
  const trimC = C(trim);
  // Hull lines: half-breadth narrows to a fine bow and a fuller transom-less stern; the sheer
  // rises at both ends.
  const breadth = (u: number) => {
    const t = Math.abs(u);
    const fine = u > 0 ? 1.7 : 1.25;
    return B * Math.pow(Math.max(0, 1 - Math.pow(t, fine * 1.4)), 0.55);
  };
  const sheer = (u: number) => D + 0.012 * u * u + (u > 0 ? 0.004 * u : 0);
  const shell = (scale: number, flip: boolean, colorAt: (v: number, u: number) => THREE.Color) => {
    const rows: number[][] = [];
    for (let i = 0; i <= ST; i++) {
      const u = -1 + (2 * i) / ST;
      const x = u * L;
      const hb = breadth(u) * scale;
      const top = sheer(u);
      const row: number[] = [];
      for (let j = 0; j <= SEC; j++) {
        const v = j / SEC; // 0 = port gunwale, 0.5 = keel, 1 = starboard gunwale
        const a = Math.PI * v;
        const z = -Math.cos(a) * hb;
        const y = top - Math.sin(a) * (top - 0.004) * scale - (1 - scale) * 0.004;
        // Clinker lands: each strake steps slightly outward at its lower edge.
        const strake = Math.floor(Math.sin(a) * 5);
        const step = 1 + (Math.sin(a) * 5 - strake) * 0.025;
        row.push(b.vertex(x, y, z * step, colorAt(v, u)));
      }
      rows.push(row);
    }
    for (let i = 0; i < ST; i++)
      for (let j = 0; j < SEC; j++) {
        const q = [rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]];
        if (flip) b.quad(q[3], q[2], q[1], q[0]);
        else b.quad(q[0], q[1], q[2], q[3]);
      }
  };
  shell(1, false, (v) => {
    const depth = Math.sin(Math.PI * v);
    if (depth < 0.2) return trimC;
    if (depth > 0.86) return bottom;
    const strake = Math.floor(depth * 5);
    return strake % 2 ? plank : plank.clone().lerp(plankDark, 0.25);
  });
  shell(0.9, true, (v) => inner.clone().multiplyScalar(0.85 + 0.15 * Math.sin(Math.PI * v)));
  const g0 = b.build(true);
  const hb = new MeshBuilder();
  hb.addGeometry(g0, new THREE.Matrix4(), (_x, _y, _z, o) => o.setRGB(1, 1, 1));
  g0.dispose();
  // Gunwale rails, stem and sternpost, keel.
  const wood = C('#4f3420');
  for (const side of [-1, 1]) {
    for (let i = 0; i < ST; i++) {
      const u0 = -1 + (2 * i) / ST, u1 = -1 + (2 * (i + 1)) / ST;
      rod(hb, new THREE.Vector3(u0 * L, sheer(u0) + 0.002, side * breadth(u0)), new THREE.Vector3(u1 * L, sheer(u1) + 0.002, side * breadth(u1)), 0.0022, wood);
    }
  }
  rod(hb, new THREE.Vector3(L * 0.98, 0.004, 0), new THREE.Vector3(L * 1.04, sheer(1) + 0.012, 0), 0.003, wood);
  rod(hb, new THREE.Vector3(-L * 0.98, 0.004, 0), new THREE.Vector3(-L * 1.02, sheer(-1) + 0.008, 0), 0.003, wood);
  rod(hb, new THREE.Vector3(-L, 0.001, 0), new THREE.Vector3(L, 0.001, 0), 0.0025, wood);
  // Thwarts (seats) and floorboards.
  for (const u of [-0.45, 0.05, 0.5]) {
    const w = breadth(u) * 1.8;
    const th = new THREE.BoxGeometry(0.014, 0.003, w);
    hb.addGeometry(th, compose(u * L, D * 0.72, 0), C('#a47a4c'));
    th.dispose();
  }
  const floor = new THREE.BoxGeometry(L * 1.3, 0.002, B * 0.7);
  hb.addGeometry(floor, compose(0, 0.012, 0), C('#9a7048'));
  floor.dispose();
  // Rudder and tiller.
  const rudder = new THREE.BoxGeometry(0.022, 0.04, 0.003);
  hb.addGeometry(rudder, compose(-L * 1.06, 0.018, 0), C('#5e3c22'));
  rudder.dispose();
  rod(hb, new THREE.Vector3(-L * 1.05, sheer(-1) + 0.004, 0), new THREE.Vector3(-L * 0.72, sheer(-0.75) + 0.008, 0.004), 0.0018, wood);
  // Mast, gaff and boom.
  const mastX = L * 0.42;
  const mastTop = 0.3;
  rod(hb, new THREE.Vector3(mastX, 0.01, 0), new THREE.Vector3(mastX, mastTop, 0), 0.0034, C('#6b4a2e'), 6);
  rod(hb, new THREE.Vector3(mastX, 0.07, 0), new THREE.Vector3(mastX - 0.17, 0.075, 0), 0.0025, C('#6b4a2e'), 6);
  rod(hb, new THREE.Vector3(mastX, 0.24, 0), new THREE.Vector3(mastX - 0.13, 0.29, 0), 0.002, C('#6b4a2e'), 6);
  // Standing rigging: forestay and shrouds.
  const rope = C('#d2c29c');
  rod(hb, new THREE.Vector3(mastX, mastTop - 0.01, 0), new THREE.Vector3(L * 1.03, sheer(1) + 0.01, 0), 0.0008, rope, 3);
  for (const side of [-1, 1]) rod(hb, new THREE.Vector3(mastX, mastTop - 0.02, 0), new THREE.Vector3(mastX - 0.01, sheer(0.4), side * breadth(0.4)), 0.0007, rope, 3);
  // Oars resting across the thwarts.
  for (const side of [-1, 1]) rod(hb, new THREE.Vector3(-L * 0.6, D + 0.004, side * B * 0.55), new THREE.Vector3(L * 0.55, D + 0.006, side * B * 0.75), 0.0016, C('#b08a5e'), 4);
  // Cargo: a barrel, a sack and a crate near the stern.
  const barrel = new THREE.CylinderGeometry(0.009, 0.009, 0.02, 10);
  hb.addGeometry(barrel, compose(-L * 0.25, 0.022, 0.01), (_x, y, _z, o) => o.set(Math.abs(y - 0.022) > 0.006 ? '#3d3a36' : '#8a5f38'));
  barrel.dispose();
  const sack = smoothSphere(0.01, 1);
  sack.scale(1.2, 0.8, 1);
  hb.addGeometry(sack, compose(-L * 0.25, 0.018, -0.014), C('#c9b48a'));
  sack.dispose();
  const crate = new THREE.BoxGeometry(0.018, 0.016, 0.018);
  hb.addGeometry(crate, compose(-L * 0.62, 0.02, 0, 0, rnd.range(0, 1), 0), C('#9a6d3f'));
  crate.dispose();
  const hull = hb.build(false);

  // Gaff sail: four-sided, billowed, with vertical panel seams, a trim band and reef points.
  const sb = new MeshBuilder();
  const rows = 10, cols = 8;
  const cream = C('#f1e7d2'), seam = C('#d8cbb0');
  const verts: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    const row: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      // Luff along the mast (u=0), leech at the end of boom/gaff (u=1).
      const footX = mastX - u * 0.165, footY = 0.078;
      const headX = mastX - u * 0.125, headY = 0.245 + u * 0.04;
      const x = footX + (headX - footX) * v;
      const y = footY + (headY - footY) * v;
      const z = Math.sin(u * Math.PI) * Math.sin(v * Math.PI * 0.9 + 0.15) * 0.022;
      let c = cream;
      if (i % 2 === 1 && Math.abs(u * cols - Math.round(u * cols)) < 0.01) c = seam;
      if (v > 0.18 && v < 0.27) c = C(trim).lerp(cream, 0.15);
      if (Math.abs(v - 0.1) < 0.02 && i % 2 === 0) c = seam;
      row.push(sb.vertex(x, y, z, c));
    }
    verts.push(row);
  }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) sb.quad(verts[j][i], verts[j][i + 1], verts[j + 1][i + 1], verts[j + 1][i]);
  // Pennant at the masthead.
  const p0 = sb.vertex(mastX, mastTop, 0, C(trim));
  const p1 = sb.vertex(mastX, mastTop - 0.016, 0, C(trim));
  const p2 = sb.vertex(mastX - 0.04, mastTop - 0.006, 0.004, C(trim));
  sb.tri(p0, p1, p2);
  const sail = sb.build(true);
  return { hull, sail };
}

/**
 * Tags a dock part for the construction animation: which harbour it belongs to and how far
 * along the build it is laid (0 at the top of the stairs .. 1 at the pier head).
 */
function tagBuild(g: THREE.BufferGeometry, port: number, along: (x: number, y: number, z: number) => number, stair = 0, short = 0) {
  const pos = g.getAttribute('position');
  const a = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) a[i] = along(pos.getX(i), pos.getY(i), pos.getZ(i));
  g.setAttribute('aAlong', new THREE.BufferAttribute(a, 1));
  g.setAttribute('aPort', new THREE.BufferAttribute(new Float32Array(pos.count).fill(port), 1));
  // Which flight of stairs this is (0: not stairs), and whether it is the short one that starts
  // at a headland's edge (see Harbours.setStairs).
  g.setAttribute('aStair', new THREE.BufferAttribute(new Float32Array(pos.count).fill(stair), 1));
  g.setAttribute('aShort', new THREE.BufferAttribute(new Float32Array(pos.count).fill(short), 1));
  return g;
}

/** A flight of wooden steps from `top` down to `bottom` (world coordinates). */
function makeStairs(top: THREE.Vector3, bottom: THREE.Vector3): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const wood = C('#8a6440'), dark = C('#5e432a'), rope = C('#cdb88d');
  const flat = new THREE.Vector3(bottom.x - top.x, 0, bottom.z - top.z);
  const run = flat.length();
  const dir = flat.clone().normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const drop = top.y - bottom.y;
  const steps = Math.max(4, Math.round(run / 0.034));
  const tread = run / steps, rise = drop / steps;
  const yaw = Math.atan2(-dir.z, dir.x);
  const W = 0.085;
  for (let i = 0; i < steps; i++) {
    const p = top.clone().addScaledVector(dir, (i + 0.5) * tread);
    p.y = top.y - (i + 1) * rise + 0.004;
    const g = new THREE.BoxGeometry(tread * 1.08, 0.008, W);
    b.addGeometry(g, compose(p.x, p.y, p.z, 0, yaw, 0), (i % 2 ? wood : wood.clone().offsetHSL(0, 0, -0.03)));
    g.dispose();
  }
  // Stringers under both edges, following the pitch.
  for (const s of [-1, 1]) {
    const a = top.clone().addScaledVector(side, s * (W / 2 + 0.004)).add(new THREE.Vector3(0, -0.012, 0));
    const c = bottom.clone().addScaledVector(side, s * (W / 2 + 0.004)).add(new THREE.Vector3(0, -0.012, 0));
    rod(b, a, c, 0.006, dark, 4);
  }
  // Posts at the top and bottom, and a rope rail between them on both sides.
  for (const s of [-1, 1]) {
    const tp = top.clone().addScaledVector(side, s * (W / 2 + 0.006));
    const bp = bottom.clone().addScaledVector(side, s * (W / 2 + 0.006));
    rod(b, tp.clone().add(new THREE.Vector3(0, -0.02, 0)), tp.clone().add(new THREE.Vector3(0, 0.07, 0)), 0.005, dark, 6);
    rod(b, bp.clone().add(new THREE.Vector3(0, -0.02, 0)), bp.clone().add(new THREE.Vector3(0, 0.07, 0)), 0.005, dark, 6);
    // Rope sags a little between the posts.
    const segs = 6;
    let prev = tp.clone().add(new THREE.Vector3(0, 0.062, 0));
    for (let k = 1; k <= segs; k++) {
      const u = k / segs;
      const q = tp.clone().lerp(bp, u).add(new THREE.Vector3(0, 0.062 - Math.sin(u * Math.PI) * 0.018, 0));
      rod(b, prev, q, 0.0016, rope, 3);
      prev = q;
    }
  }
  return b.build(false);
}

const FACE_DAY = new THREE.Color(0.86, 0.84, 0.8);
/** Rim of an unclaimed badge: dark walnut, so every player colour (white included) stands out. */
const RIM_FREE = new THREE.Color('#5a4128');
const BADGE_Y = PIER_Y + 0.62;

/** Share of the build taken by the stairs; the pier is laid over the rest. */
const STAIRS = 0.35;

/** Harbours a board can have (more than any board has): the size of the shared build state. */
const MAX_PORTS = 24;

interface Badge {
  /** Where the badge is and how it faces (not in the scene: it poses the badge's instance). */
  obj: THREE.Object3D;
  /** Which shield it shows (see PORT_TYPES), and whether its ribbon reads 3:1. */
  type: number;
  any: boolean;
  /** Rim colour by day; animates from `from` towards it while `anim` < 1. */
  rimColor: THREE.Color;
  from: THREE.Color;
  /** The rim as drawn this frame. */
  rim: THREE.Color;
  anim: number;
  owner: string | null;
  vertices: number[];
  phase: number;
  /** 0..1 rising out of the water during construction. */
  rise: number;
  /** Claimed, but showing walnut until its building is on show (a resumed game: see unveil). */
  veiled: boolean;
}

/**
 * What every board's harbours share, made once for the session: the emblem's geometry (all its
 * layers, back to front, in one), its material and the boats' and docks' materials. A board's
 * own harbours only bring their geometry and where things stand.
 */
interface HarbourParts {
  badge: THREE.BufferGeometry;
  badgeMat: THREE.MeshBasicNodeMaterial;
  /** 1 by day, dimmer at night: the parchment and tails (the rims are dimmed with their colour). */
  dim: ReturnType<typeof uniform<'float'>>;
  woodMat: THREE.MeshStandardNodeMaterial;
  sailMat: THREE.MeshStandardNodeMaterial;
  dockMat: THREE.MeshStandardNodeMaterial;
  /** Per harbour 0..1.2: how much of its stairs and pier is built (see construct()). */
  buildValues: number[];
  /** Per flight of stairs: 1 while a headland stands at its top (its short flight shows), else 0. */
  shortValues: number[];
  /** Per harbour 0..1: how much of its boat shows (see Harbours.update). */
  boatValues: number[];
}

let shared: HarbourParts | null = null;

/** The emblem: anchor, outline, claim border, field, ribbon tails and ribbon, with which layer each vertex is. */
function badgeGeometry() {
  const layers = [
    new THREE.ShapeGeometry(anchorShape(), 12),
    shapeGeo(shieldShape(SHIELD_W + 0.03, SHIELD_H + 0.035)),
    shapeGeo(shieldShape(SHIELD_W, SHIELD_H)),
    shapeGeo(shieldShape(SHIELD_W - 0.05, SHIELD_H - 0.055, 0.004)),
    new THREE.ShapeGeometry(ribbonShapes().tails),
    shapeGeo(ribbonShapes().band),
  ];
  layers.forEach((g, i) => {
    g.translate(0, 0, i * 0.002);
    g.setAttribute('layer', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(i), 1));
  });
  const merged = mergeGeometries(layers)!;
  layers.forEach((g) => g.dispose());
  return merged;
}

function harbourParts(): HarbourParts {
  if (shared) {
    emblemAtlas();
    return shared;
  }
  const atlasTex = emblemAtlas();
  // Badges: unlit, so the rate stays legible whatever the sun is doing; tone-mapped with the
  // scene and dimmed at night. Each badge's shield, rate and rim come with its instance.
  const dim = uniform(1);
  const badgeMat = new THREE.MeshBasicNodeMaterial();
  const layer = attribute<'float'>('layer', 'float');
  const kind = attribute<'float'>('aType', 'float');
  const rate = attribute<'float'>('aAny', 'float');
  const rim = attribute<'vec3'>('aRim', 'vec3');
  badgeMat.colorNode = Fn(() => {
    const u = uv();
    // (The canvas is flipped: its first row is the texture's top.)
    const shieldUV = vec2(u.x.add(kind).mul(1 / PORT_TYPES.length), float(1).sub(float(1).sub(u.y).mul(SHIELD_PY / ATLAS_H)));
    const ribbonUV = vec2(u.x.add(rate).mul(RIBBON_PX / ATLAS_W), float(1).sub(float(1).sub(u.y).mul(RIBBON_PY / ATLAS_H).add(SHIELD_PY / ATLAS_H)));
    const day = vec3(FACE_DAY.r, FACE_DAY.g, FACE_DAY.b).mul(dim);
    const face = texture(atlasTex, shieldUV).rgb.mul(day);
    const ribbon = texture(atlasTex, ribbonUV).rgb.mul(day);
    const e = new THREE.Color('#3a2918'), tl = new THREE.Color('#8f7148');
    const edge = vec3(e.r, e.g, e.b);
    const tail = vec3(tl.r, tl.g, tl.b).mul(dim);
    const c = layer.lessThan(1.5).select(edge, layer.lessThan(2.5).select(rim, layer.lessThan(3.5).select(face, layer.lessThan(4.5).select(tail, ribbon))));
    return vec4(c, 1);
  })();
  // Hulls: worn paint, and a band of green grime just above the waterline (the boats float
  // with the water at about 0.0125 up their hulls). Sails: sun-bleached towards the head,
  // stained along the foot.
  const woodMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  woodMat.colorNode = Fn(() => {
    const p = positionGeometry;
    const worn = mx_noise_float(p.mul(90)).mul(0.07).add(1);
    const grime = smoothstep(0.024, 0.014, p.y).mul(smoothstep(0.004, 0.01, p.y)).mul(mx_noise_float(p.mul(140)).mul(0.25).add(0.75));
    return vec4(mix(vertexColor().rgb.mul(worn), vec3(0.05, 0.065, 0.03), grime.mul(0.55)), 1);
  })();
  const sailMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, side: THREE.DoubleSide });
  sailMat.colorNode = Fn(() => {
    const p = positionGeometry;
    const weather = mx_noise_float(p.mul(40)).mul(0.05).add(smoothstep(0.08, 0.28, p.y).mul(0.04)).add(1);
    const foot = smoothstep(0.1, 0.078, p.y).mul(0.12);
    return vec4(vertexColor().rgb.mul(weather).mul(foot.oneMinus()), 1);
  })();
  // A boat sailing in from open water fades in as it comes (and out as it puts out to sea):
  // dissolved a pixel at a time, which the temporal anti-aliasing blends into a fade, so the
  // boats stay opaque, sorted and shadowed like every other piece.
  const boatValues: number[] = new Array(MAX_PORTS).fill(1);
  const boatShown = uniformArray(boatValues, 'float').element(int(attribute<'float'>('aBoat', 'float'))) as unknown as Node<'float'>;
  for (const m of [woodMat, sailMat]) {
    m.opacityNode = boatShown;
    m.alphaHash = true;
  }
  // Construction: each part waits below the sea until the build front reaches it, then
  // pushes up into place, so the stairs and then the pier grow out from the shore.
  // Posts and stair feet are dark and slick where the sea washes them, and green with weed
  // right at the water.
  const buildValues: number[] = new Array(MAX_PORTS).fill(1.2);
  const build = uniformArray(buildValues, 'float');
  const shortValues: number[] = new Array(MAX_PORTS * 2 + 1).fill(0);
  const short = uniformArray(shortValues, 'float');
  const dockMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  const wetBand = smoothstep(SEA_LEVEL + 0.035, SEA_LEVEL + 0.004, positionWorld.y);
  dockMat.colorNode = Fn(() => {
    const weed = smoothstep(SEA_LEVEL + 0.014, SEA_LEVEL - 0.008, positionWorld.y).mul(mx_noise_float(positionWorld.mul(36)).mul(0.5).add(0.5));
    const c = vertexColor().rgb.mul(wetBand.mul(0.45).oneMinus());
    return vec4(mix(c, vec3(0.03, 0.05, 0.015), weed.mul(0.65)), 1);
  })();
  dockMat.roughnessNode = mix(float(0.85), float(0.35), wetBand);
  dockMat.positionNode = Fn(() => {
    const progress = build.element(int(attribute<'float'>('aPort', 'float'))) as unknown as Node<'float'>;
    const placed = clamp(progress.sub(attribute<'float'>('aAlong', 'float')).div(0.09), 0, 1);
    const left = float(1).sub(placed);
    // Of a corner's two flights of stairs, the one for the ground there now (see setStairs).
    const wanted = (short.element(int(attribute<'float'>('aStair', 'float'))) as unknown as Node<'float'>).sub(attribute<'float'>('aShort', 'float')).abs().lessThan(0.5);
    return positionLocal.add(vec3(0, placed.greaterThan(0).and(wanted).select(left.mul(left).mul(-0.5), float(-8)), 0));
  })();
  return (shared = { badge: badgeGeometry(), badgeMat, dim, woodMat, sailMat, dockMat, buildValues, shortValues, boatValues });
}

/**
 * How far each harbour's pier runs out (0.78 from its edge, as every pier on the classic island
 * does), shortened where its head would come within a quarter of a hex of another pier or of
 * land across the water: facing harbours across a strait stop short of each other instead of
 * meeting in a T. And how much open water a moored boat would have on either side of a pier.
 */
function pierReach(board: Board) {
  const FULL = 0.78, CLEAR = 0.25, SHORTEST = 0.4;
  const land = board.hexes.filter((h) => isLand(h.terrain));
  const piers = board.ports.map((port) => {
    const f = edgeFrame(board, port.edge);
    const hex = board.hexes[port.hex];
    const d = Math.hypot(f.x - hex.x, f.z - hex.z) || 1;
    return { x: f.x, z: f.z, ox: (f.x - hex.x) / d, oz: (f.z - hex.z) / d, hex: port.hex, len: FULL };
  });
  const head = (p: (typeof piers)[number], len = p.len) => ({ x: p.x + p.ox * len, z: p.z + p.oz * len });
  // Land across the water: any land hex but the pier's own (whose coast it leaves from).
  const toLand = (x: number, z: number, own: number) => land.reduce((m, h) => (h.id === own ? m : Math.min(m, hexSdf(x - h.x, z - h.z, 1))), Infinity);
  const crowded = (i: number) => {
    const p = piers[i], h = head(p);
    if (toLand(h.x, h.z, p.hex) < CLEAR) return true;
    return piers.some((q, j) => j !== i && segDist(h.x, h.z, q.x, q.z, head(q).x, head(q).z) < CLEAR);
  };
  // (Rounds in which every crowded pier draws back a little, so two facing piers share the strait.)
  for (let round = 0; round < 10; round++) {
    const short = piers.map((_, i) => crowded(i));
    if (!short.some(Boolean)) break;
    piers.forEach((p, i) => short[i] && (p.len = Math.max(SHORTEST, p.len - 0.05)));
  }
  const room = (i: number, side: number) => {
    const p = piers[i];
    const x = p.x + p.ox * p.len * 0.7 - p.oz * side * 0.3, z = p.z + p.oz * p.len * 0.7 + p.ox * side * 0.3;
    let m = toLand(x, z, -1);
    piers.forEach((q, j) => j !== i && (m = Math.min(m, segDist(x, z, q.x, q.z, head(q).x, head(q).z))));
    return m;
  };
  return { lengths: piers.map((p) => p.len), room };
}

export class Harbours {
  group = new THREE.Group();
  /**
   * The boats' hulls and sails, each one batched mesh for every harbour (a draw each, and one each
   * in the shadow map, rather than two per boat), drawn from the stand-ins in the boats' groups
   * just before each frame is. A batched mesh culls its own parts as it is drawn, which a render
   * bundle can't replay, so these hang outside the board's bundle (see attach).
   */
  private hulls: BoatBatch = { parts: [], mesh: null };
  private sails: BoatBatch = { parts: [], mesh: null };
  private stage: { beforeDraw: Set<() => void> } | null = null;
  private readonly synced = () => this.syncBoats();
  private boats: { obj: THREE.Object3D; baseY: number; phase: number; yaw: number; x: number; z: number; ox: number; oz: number; arrive: number; trip: number }[] = [];
  private parts = harbourParts();
  /** Per harbour 0..1: how much of the stairs and pier has been built (see construct()). Shared by every board's harbours. */
  private buildValues = this.parts.buildValues;
  private heads: { x: number; z: number; len: number }[] = [];
  private badges: Badge[] = [];
  /** Every badge, one instanced draw: its pose, rim colour, shield and rate per instance. */
  private badgeMesh: THREE.InstancedMesh | null = null;
  private rimData: Float32Array = new Float32Array(0);
  private rimAttr: THREE.InstancedBufferAttribute | null = null;
  /** The badge pulsing for a hovered building spot (a preview of the claim), in the player's colour. */
  private preview: { badge: Badge; color: THREE.Color } | null = null;
  /** Set by the board view so the badges can turn towards the viewer. */
  camera: THREE.Camera | null = null;
  /** Set by the board view: how far a flood lifts the sea (see seaLift.ts), which the moored boats ride. */
  lift: SeaLift | null = null;
  /** Each port intersection's flight of stairs (its slot in the shared stair state). */
  private stairOf = new Map<number, number>();
  private night = 0;
  private disposables: { dispose(): void }[] = [];

  /** Night 0..1: badges keep enough moonlight to stay readable without glowing (more of it with "Bright pieces": see update). */
  setNight(night: number) {
    this.night = night;
  }

  /** Everything built (0) or nothing yet: piers under the sea, boats away, badges submerged. */
  setBuilt(built: boolean) {
    const v = built ? 1 : 0;
    this.buildValues.fill(built ? 1.2 : 0);
    for (const b of this.boats) b.arrive = v;
    for (const b of this.badges) b.rise = v;
  }

  /**
   * Builds every harbour, one after another around the coast: stairs and pier push up out of
   * the sea from the shore outward, the boat sails in to moor, and the badge rises from the water.
   * `splash` is called where water is thrown up.
   */
  construct(anim: Animator, splash: (x: number, z: number, big: boolean) => void): Promise<void> {
    this.setBuilt(false);
    let last: Promise<void> = Promise.resolve();
    this.heads.forEach((_, i) => {
      const d = i * 0.1;
      let splashed = false;
      anim.tween({
        delay: d,
        duration: 1.3,
        easing: ease.linear,
        update: (t) => {
          this.buildValues[i] = t * 1.2;
          if (!splashed && t * 1.2 > 1) {
            splashed = true;
            splash(this.heads[i].x, this.heads[i].z, false);
          }
        },
      });
      anim.tween({ delay: d, duration: 2.4, easing: ease.linear, update: (t) => (this.boats[i].arrive = Math.max(0.001, t)) });
      last = anim.tween({
        delay: d + 0.95,
        duration: 0.75,
        easing: ease.linear,
        update: (t) => (this.badges[i].rise = t),
        done: () => splash(this.badges[i].obj.position.x, this.badges[i].obj.position.z, true),
      }).promise;
    });
    return last;
  }

  /**
   * The harbours go down with the island, around the coast in turn: each badge bobs and sinks
   * back into the water (with a splash), its boat puts out to sea, and stairs and pier go under.
   * `gentle`: all at once and quickly, without splashes.
   */
  submerge(anim: Animator, gentle: boolean, splash: (x: number, z: number) => void): Promise<void> {
    let last: Promise<void> = Promise.resolve();
    this.preview = null;
    this.badges.forEach((b, i) => {
      const d = gentle ? 0 : i * 0.1;
      const rise = b.rise;
      last = anim.tween({
        delay: d,
        duration: gentle ? 0.35 : 0.75,
        easing: ease.linear,
        update: (t) => (b.rise = rise * (1 - t)),
        done: () => !gentle && splash(b.obj.position.x, b.obj.position.z),
      }).promise;
    });
    this.boats.forEach((b, i) => {
      const arrive = b.arrive;
      anim.tween({ delay: gentle ? 0 : i * 0.1, duration: gentle ? 0.5 : 2.2, easing: ease.linear, update: (t) => (b.arrive = arrive * (1 - t)) });
    });
    this.heads.forEach((_, i) => {
      const v = this.buildValues[i];
      anim.tween({ delay: gentle ? 0 : 0.3 + i * 0.1, duration: gentle ? 0.4 : 1.1, easing: ease.inQuad, update: (t) => (this.buildValues[i] = v * (1 - t)) });
    });
    return last;
  }

  /** A building at `v` was taken back: the badge goes to whoever else holds the harbour, or back to walnut. */
  release(v: number, colorAt: (v: number) => string | null, animate: boolean) {
    const b = this.badges.find((x) => x.vertices.includes(v));
    if (!b) return;
    const keep = b.vertices.filter((x) => x !== v).map(colorAt).find((c) => c) ?? null;
    if (b.owner === keep) return;
    b.owner = keep;
    b.from.copy(b.veiled ? RIM_FREE : b.rimColor);
    b.veiled = false;
    if (keep) b.rimColor.set(keep);
    else b.rimColor.copy(RIM_FREE);
    b.anim = animate ? 0 : 1;
  }

  /**
   * A building on intersection `v` claims the harbour there (if any): the badge rim turns the
   * owner's colour. Returns the badge position when that changed something, for a little flourish.
   */
  claim(v: number, color: string, animate: boolean): THREE.Vector3 | null {
    const b = this.badges.find((x) => x.vertices.includes(v));
    if (!b || (b.owner === color && !b.veiled)) return null;
    b.owner = color;
    b.from.copy(b.veiled ? RIM_FREE : b.rimColor);
    b.veiled = false;
    b.rimColor.set(color);
    b.anim = animate ? 0 : 1;
    return b.obj.position.clone();
  }

  /** Claims made so far show as walnut until `unveil`ed (pieces hidden until the island has risen). */
  hideClaims() {
    for (const b of this.badges) if (b.owner) b.veiled = true;
  }

  /** The building at `v` is on show again: its harbour's claim colours in. Returns where, if it did. */
  unveil(v: number): THREE.Vector3 | null {
    const b = this.badges.find((x) => x.vertices.includes(v));
    if (!b || !b.veiled) return null;
    b.veiled = false;
    b.from.copy(RIM_FREE);
    b.anim = 0;
    return b.obj.position.clone();
  }

  /** Pulse the badge of the harbour at intersection `v` in `color` (a claim to come), or stop with null. */
  previewAt(v: number | null, color: string) {
    const b = v === null ? undefined : this.badges.find((x) => x.vertices.includes(v));
    this.preview = b ? { badge: b, color: new THREE.Color(color) } : null;
  }

  /**
   * A headland has risen at intersection `v` (true) or gone (false): its stairs start from the
   * headland's edge instead of the corner, so they don't run through the new land.
   */
  setStairs(v: number, headland: boolean) {
    const slot = this.stairOf.get(v);
    if (slot !== undefined) this.parts.shortValues[slot] = headland ? 1 : 0;
  }

  /** Harbour `i`'s boat puts out to sea and comes back (a trade made there). */
  sail(i: number, anim: Animator) {
    const b = this.boats[i];
    if (!b || b.trip > 0 || b.arrive < 1) return;
    anim.tween({ duration: 7, easing: ease.linear, update: (t) => (b.trip = t), done: () => (b.trip = 0) });
  }

  /**
   * `headland`: the headland a building at an intersection would raise (if it would), so the
   * stairs from it can have a second, shorter flight from the headland's edge.
   */
  constructor(board: Board, headland: (v: number) => HeadlandSpec | null = () => null) {
    const { dockMat } = this.parts;
    this.parts.shortValues.fill(0);
    const rnd = new Rand(4242);
    const staticParts: THREE.BufferGeometry[] = [];
    const reach = pierReach(board);
    for (const [n, port] of board.ports.entries()) {
      const f = edgeFrame(board, port.edge);
      const hex = board.hexes[port.hex];
      const out = new THREE.Vector2(f.x - hex.x, f.z - hex.z).normalize();
      const yaw = Math.atan2(-out.y, out.x);
      const pierLen = reach.lengths[n];
      const pi = this.heads.length;
      if (pi >= MAX_PORTS) break;
      this.buildValues[pi] = 1.2;
      // Laid plank by plank: every vertex of a plank shares its plank's place in the build.
      const pier = tagBuild(makePier(pierLen, rnd), pi, (x) => STAIRS + (1 - STAIRS) * Math.min(1, Math.floor(Math.max(0, x) / 0.04) * 0.04 / pierLen));
      this.heads.push({ x: f.x + out.x * pierLen, z: f.z + out.y * pierLen, len: pierLen });
      // Piers and stairs never move: they are merged into one mesh for all ports.
      pier.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(f.x + out.x * 0.02, PIER_Y, f.z + out.y * 0.02), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)));
      staticParts.push(pier);
      // Stairs from each port intersection down to the pier head: treads on two stringers,
      // newel posts at the top and a rope handrail on the seaward side.
      for (const vid of port.vertices) {
        const v = board.vertices[vid];
        const start = new THREE.Vector3(v.x, 0.03, v.z);
        const end = new THREE.Vector3(f.x + out.x * 0.08, PIER_Y + 0.005, f.z + out.y * 0.08);
        const run = Math.hypot(end.x - start.x, end.z - start.z);
        const slot = Math.min(1 + this.stairOf.size, MAX_PORTS * 2);
        this.stairOf.set(vid, slot);
        const alongOf = (x: number, z: number) => STAIRS * Math.min(1, Math.max(0, ((x - start.x) * (end.x - start.x) + (z - start.z) * (end.z - start.z)) / (run * run)));
        staticParts.push(tagBuild(makeStairs(start, end), pi, (x, _y, z) => alongOf(x, z), slot, 0));
        // With a headland raised at the corner, a flight from the headland's edge.
        const spec = headland(vid);
        if (spec) {
          const dx = (end.x - start.x) / run, dz = (end.z - start.z) / run;
          const s = headlandReach(spec, dx, dz) + 0.015;
          if (s < run - 0.12) {
            const top = new THREE.Vector3(v.x + dx * s, spec.topY - 0.034, v.z + dz * s);
            staticParts.push(tagBuild(makeStairs(top, end), pi, (x, _y, z) => alongOf(x, z), slot, 1));
          }
        }
      }
      // Boat moored beside the pier end.
      const { hull, sail } = makeBoat(RESOURCE_COLORS[port.type], rnd);
      for (const g of [hull, sail]) g.setAttribute('aBoat', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(pi), 1));
      const boat = new THREE.Group();
      // (Stand-ins: every boat's hull and sail are drawn by the harbours' batched meshes, see syncBoats.)
      const hm = new THREE.Object3D();
      const sm = new THREE.Object3D();
      boat.add(hm, sm);
      this.hulls.parts.push({ geo: hull, obj: hm });
      this.sails.parts.push({ geo: sail, obj: sm });
      // (Moored on the side with open water: a pier facing another across a strait, or running
      // along a coast, keeps its boat off the other pier and the rocks.)
      let side = rnd.chance(0.5) ? 1 : -1;
      if (reach.room(n, side) < 0.3 && reach.room(n, -side) > reach.room(n, side)) side = -side;
      const px = f.x + out.x * (pierLen * 0.7) + -out.y * side * 0.3;
      const pz = f.z + out.y * (pierLen * 0.7) + out.x * side * 0.3;
      boat.position.set(px, SEA_LEVEL - 0.02, pz);
      boat.rotation.y = yaw + rnd.range(-0.1, 0.1);
      boat.scale.setScalar(1.6);
      this.group.add(boat);
      this.boats.push({ obj: boat, baseY: SEA_LEVEL - 0.02, phase: rnd.range(0, 6.28), yaw: boat.rotation.y, x: px, z: pz, ox: out.x, oz: out.y, arrive: 1, trip: 0 });
      this.disposables.push(hull, sail);
      // Badge: a medallion floating above the pier head. It is solid geometry, so it sorts,
      // occludes and blurs (depth of field) like everything else, casting no shadow (a disc's
      // shadow on the water would read as a hole).
      const obj = new THREE.Object3D();
      obj.position.set(f.x + out.x * (pierLen * 0.6), BADGE_Y, f.z + out.y * (pierLen * 0.6));
      const type = Math.max(0, PORT_TYPES.indexOf(port.type));
      this.badges.push({ obj, type, any: port.type === 'any', rimColor: RIM_FREE.clone(), from: RIM_FREE.clone(), rim: RIM_FREE.clone(), anim: 1, owner: null, vertices: [...port.vertices], phase: rnd.range(0, 6.28), rise: 1, veiled: false });
    }
    this.batchBoats();
    if (this.badges.length) {
      const n = this.badges.length;
      const geo = this.parts.badge.clone();
      const kinds = new Float32Array(n), rates = new Float32Array(n);
      this.badges.forEach((b, i) => {
        kinds[i] = b.type;
        rates[i] = b.any ? 1 : 0;
      });
      this.rimData = new Float32Array(n * 3);
      // (Not marked dynamic: three would send it again at every draw, though it changes only now and then.)
      this.rimAttr = new THREE.InstancedBufferAttribute(this.rimData, 3);
      geo.setAttribute('aType', new THREE.InstancedBufferAttribute(kinds, 1));
      geo.setAttribute('aAny', new THREE.InstancedBufferAttribute(rates, 1));
      geo.setAttribute('aRim', this.rimAttr);
      const mesh = (this.badgeMesh = instancedMesh(geo, this.parts.badgeMat, n));
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.name = 'badges';
      this.group.add(mesh);
      this.disposables.push(geo, mesh);
    }
    // (A board without harbours has no docks.)
    if (!staticParts.length) return;
    const merged = mergeGeometries(staticParts);
    staticParts.forEach((g) => g.dispose());
    const dock = new THREE.Mesh(merged, dockMat);
    dock.castShadow = dock.receiveShadow = true;
    this.group.add(dock);
    this.disposables.push(merged);
  }

  update(dt: number, t: number) {
    // (Read as a game piece is: with "Bright pieces" a badge keeps most of its daylight after dark.)
    const dim = 1 - 0.62 * this.night * (1 - 0.7 * piecesBright.value);
    this.parts.dim.value = dim;
    const mesh = this.badgeMesh;
    this.badges.forEach((b, i) => {
      // Facing the camera, bobbing gently and rocking a little, like a float. Sized for the
      // overview; up close it shrinks so it doesn't dwarf the buildings.
      let size = 1;
      if (this.camera) {
        b.obj.quaternion.copy(this.camera.quaternion);
        size = THREE.MathUtils.clamp(this.camera.position.distanceTo(b.obj.position) / 12, 0.5, 1.35);
      }
      b.obj.rotateZ(Math.sin(t * 0.9 + b.phase) * 0.05);
      // Rising out of the water during construction (springing past its height, then settling).
      const up = b.rise >= 1 ? 1 : ease.outBack(b.rise);
      b.obj.position.y = SEA_LEVEL - 0.25 + (BADGE_Y - SEA_LEVEL + 0.25) * up + Math.sin(t * 1.4 + b.phase) * 0.018;
      size *= Math.min(1, b.rise * 1.6);
      const rim = b.veiled ? RIM_FREE : b.rimColor;
      if (b.anim < 1) {
        // A claim: the rim blends to the owner's colour while the badge pops.
        b.anim = Math.min(1, b.anim + dt / 0.7);
        b.rim.copy(b.from).lerp(rim, b.anim * b.anim * (3 - 2 * b.anim));
      } else b.rim.copy(rim);
      let pop = 1 + Math.sin(b.anim * Math.PI) * 0.28;
      if (this.preview?.badge === b) {
        // A spot that would claim this harbour is hovered: the rim pulses toward the player's colour.
        const pulse = 0.5 + 0.5 * Math.sin(t * 6.5);
        b.rim.lerp(this.preview.color, 0.45 + 0.4 * pulse);
        pop *= 1.04 + 0.06 * pulse;
      }
      b.rim.multiplyScalar(dim);
      b.obj.scale.setScalar(Math.max(1e-4, size * pop));
      if (!mesh) return;
      b.obj.updateMatrix();
      mesh.setMatrixAt(i, b.obj.matrix);
      const rims = this.rimData;
      // (The rims hold still between claims and dusks: sent again only when one changes.)
      if (rims[i * 3] !== Math.fround(b.rim.r) || rims[i * 3 + 1] !== Math.fround(b.rim.g) || rims[i * 3 + 2] !== Math.fround(b.rim.b)) {
        rims[i * 3] = b.rim.r;
        rims[i * 3 + 1] = b.rim.g;
        rims[i * 3 + 2] = b.rim.b;
        this.rimAttr!.needsUpdate = true;
      }
    });
    if (mesh) mesh.instanceMatrix.needsUpdate = true;
    for (const [i, b] of this.boats.entries()) {
      // Sailing in from open water to its mooring during construction.
      const away = b.arrive >= 1 ? 0 : 1 - ease.outCubic(b.arrive);
      // A trade: out to sea and back, turning about at the far end and again at the mooring.
      const trip = b.trip > 0 ? Math.sin(Math.min(1, b.trip / 0.92) * Math.PI) : 0;
      const turn = b.trip > 0 ? THREE.MathUtils.smoothstep(b.trip, 0.38, 0.54) * Math.PI - THREE.MathUtils.smoothstep(b.trip, 0.9, 1) * Math.PI : 0;
      b.obj.visible = b.arrive > 0;
      this.parts.boatValues[i] = b.arrive >= 1 ? 1 : THREE.MathUtils.smoothstep(b.arrive, 0, 0.3);
      b.obj.position.x = b.x + b.ox * (5 * away + 1.6 * trip);
      b.obj.position.z = b.z + b.oz * (5 * away + 1.6 * trip);
      b.obj.position.y = b.baseY + Math.sin(t * 1.3 + b.phase) * 0.012 + (this.lift?.(b.obj.position.x, b.obj.position.z) ?? 0);
      b.obj.rotation.z = Math.sin(t * 1.1 + b.phase) * 0.05 * (1 + trip);
      b.obj.rotation.x = Math.sin(t * 0.9 + b.phase * 1.3) * 0.035;
      b.obj.rotation.y = b.yaw + turn + Math.sin(t * 0.3 + b.phase) * 0.06;
    }
  }

  /**
   * What stands in the water off the coast (piers from the shore out to their heads, and the
   * boats moored beside them), as circles in xz, for things that must keep clear.
   */
  waterObstacles(): { x: number; z: number; r: number }[] {
    const out: { x: number; z: number; r: number }[] = [];
    this.heads.forEach((h, i) => {
      const b = this.boats[i];
      for (let k = 0; k <= 3; k++) out.push({ x: h.x - b.ox * h.len * (k / 3), z: h.z - b.oz * h.len * (k / 3), r: 0.16 });
      out.push({ x: b.x, z: b.z, r: 0.38 });
    });
    return out;
  }

  /**
   * The batched boats go under `parent` (out of the board's bundle), drawn from their stand-ins
   * before each frame. On WebGL2 (`batched` false) three's batched mesh loses the hulls' painted
   * vertex colours, so there each boat's hull and sail are meshes in its group.
   */
  attach(parent: THREE.Object3D, stage: { beforeDraw: Set<() => void> }, batched = true) {
    if (!batched) {
      const { woodMat, sailMat } = this.parts;
      for (const [b, material] of [
        [this.hulls, woodMat],
        [this.sails, sailMat],
      ] as const) {
        for (const part of b.parts) {
          const mesh = new THREE.Mesh(part.geo, material);
          mesh.castShadow = true;
          part.obj.add(mesh);
        }
        b.mesh?.dispose();
        b.mesh = null;
      }
      return;
    }
    for (const b of [this.hulls, this.sails]) if (b.mesh) parent.add(b.mesh);
    this.stage = stage;
    stage.beforeDraw.add(this.synced);
  }

  private batchBoats() {
    const { woodMat, sailMat } = this.parts;
    for (const [b, material] of [
      [this.hulls, woodMat],
      [this.sails, sailMat],
    ] as const) {
      if (!b.parts.length) continue;
      let vertices = 0, indices = 0;
      for (const { geo } of b.parts) {
        vertices += geo.getAttribute('position').count;
        indices += geo.index?.count ?? 0;
      }
      const mesh = new THREE.BatchedMesh(b.parts.length, vertices, indices, material);
      for (const part of b.parts) part.id = mesh.addInstance(mesh.addGeometry(part.geo));
      mesh.castShadow = true;
      // One draw list for every camera, never culled: three culls and sorts a batched mesh for
      // each camera into one texture the GPU reads as the last left it, so hulls swapped places,
      // and its bounds would stay where the boats first were (see standInBatch.ts).
      mesh.perObjectFrustumCulled = mesh.sortObjects = mesh.frustumCulled = false;
      mesh.name = 'boats';
      b.mesh = mesh;
    }
  }

  /** Each boat's hull and sail where their stand-ins are now (after the scene's transforms are up to date). */
  syncBoats() {
    for (const b of [this.hulls, this.sails]) {
      const mesh = b.mesh;
      if (!mesh?.parent) continue;
      let root: THREE.Object3D = mesh;
      while (root.parent) root = root.parent;
      boatInverse.copy(mesh.matrixWorld).invert();
      for (const part of b.parts) {
        const id = part.id!;
        const shown = onShow(part.obj, root);
        mesh.setVisibleAt(id, shown);
        if (shown) mesh.setMatrixAt(id, boatPlace.multiplyMatrices(boatInverse, part.obj.matrixWorld));
      }
    }
  }

  dispose() {
    this.stage?.beforeDraw.delete(this.synced);
    for (const b of [this.hulls, this.sails]) {
      b.mesh?.removeFromParent();
      // (Its buffers and textures are its own: see release.ts.)
      b.mesh?.dispose();
      b.mesh = null;
      b.parts = [];
    }
    release(this.group);
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.group.clear();
  }
}

interface BoatBatch {
  parts: { geo: THREE.BufferGeometry; obj: THREE.Object3D; id?: number }[];
  mesh: THREE.BatchedMesh | null;
}

const boatInverse = new THREE.Matrix4();
const boatPlace = new THREE.Matrix4();

/** Whether `o` is drawn: it and every group it is in shown, up to `root`. */
function onShow(o: THREE.Object3D, root: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (!p.parent) return p === root;
  }
  return false;
}
