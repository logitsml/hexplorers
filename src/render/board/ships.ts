// The expansions' craft afloat: player ships (Sea Lanes), the merchantman (a caravan's wagon at sea),
// the corsair and the raiders' longships, lofted from hull lines like the harbour boats (ports.ts).
// Units and conventions are the kit's (kit.ts): piece units at PIECE_SCALE, bows along +x, the
// waterline at y = 0.

import * as THREE from 'three/webgpu';
import type { PlayerColor } from '../../engine';
import { MeshBuilder, compose, smoothSphere } from './geom';
import { PLAYER_PALETTE, box, isPaleColor } from './pieces';
import { SURFACE } from './surfaces';
import { C, Kit, shown, v3, streamer, lanternAt, barrel, stripes } from './kit';

// ---------------------------------------------------------------------------------------------
// Hulls: lofted from stations along x (bow +x) and sections round from gunwale to keel, like
// the harbour boats (ports.ts). The waterline is y = 0: the bottom runs below it, so a hull sits
// in the sea rather than on it.
// ---------------------------------------------------------------------------------------------

interface HullLines {
  /** Half-length, half-beam, and freeboard at midships. */
  L: number;
  B: number;
  D: number;
  /** Depth of the keel below the waterline. */
  draught: number;
  /** How fine the bow and stern are (higher: finer). */
  bow: number;
  stern: number;
  /** Rise of the gunwale towards the bow and the stern. */
  sheerBow: number;
  sheerStern: number;
  /** Squared-off stern (a transom): the breadth there doesn't close to nothing. */
  transom?: number;
}

function breadthOf(h: HullLines, u: number) {
  const t = Math.abs(u);
  const fine = u > 0 ? h.bow : h.stern;
  const closed = Math.pow(Math.max(0, 1 - Math.pow(t, fine * 1.4)), 0.55);
  return h.B * (u < 0 && h.transom ? Math.max(closed, h.transom * (1 - (t - 0.9) * 2)) : closed);
}

function sheerOf(h: HullLines, u: number) {
  return h.D + (u > 0 ? h.sheerBow : h.sheerStern) * u * u;
}

/**
 * How far the deck lies below the gunwale, as a share of the freeboard: deep enough that the
 * bulwarks stand up round it as a raised rail, seen from above as well as from the side.
 */
const DECK = 0.32;

/** Where a hull's deck lies at u (−1 stern .. 1 bow). */
const deckOf = (h: HullLines, u: number) => sheerOf(h, u) - h.D * DECK;

/**
 * The hull's shell, coloured by `paint(u, depth)` (u: −1 stern .. 1 bow; depth 0 at the gunwale
 * to 1 at the keel), and a planked deck just below the gunwale, inside raised bulwarks capped by
 * a rail.
 */
function loftHull(k: Kit, h: HullLines, paint: (u: number, depth: number) => THREE.Color, deck: THREE.Color, ST = 22, SEC = 10, planks = 6) {
  const hb = new MeshBuilder();
  const rows: number[][] = [];
  for (let i = 0; i <= ST; i++) {
    const u = -1 + (2 * i) / ST;
    const half = breadthOf(h, u);
    const top = sheerOf(h, u);
    const row: number[] = [];
    for (let j = 0; j <= SEC; j++) {
      const a = (Math.PI * j) / SEC;
      const depth = Math.sin(a);
      // Fuller below the waterline than a semicircle: a flat run to the bilge, then the keel.
      const y = top - Math.pow(depth, 0.8) * (top + h.draught);
      row.push(hb.vertex(u * h.L, y, -Math.cos(a) * half * (1 - 0.1 * depth * depth), paint(u, depth)));
    }
    rows.push(row);
  }
  for (let i = 0; i < ST; i++) for (let j = 0; j < SEC; j++) hb.quad(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]);
  const shell = hb.build(true);
  k.add(shell, new THREE.Matrix4(), (_x, _y, _z, o) => o.setRGB(1, 1, 1));
  // The deck: planks running fore and aft in a few shades, each its own strip with a seam of the
  // dark underdeck showing between them, so from above it reads as laid timber, not a tan tray.
  const db = new MeshBuilder();
  const under = deck.clone().multiplyScalar(0.45);
  const shades = [1, 0.86, 0.95, 0.8, 0.92, 0.88];
  const strip = (z0: number, z1: number, lift: number, c: THREE.Color) => {
    const row: number[][] = [];
    for (let i = 0; i <= ST; i++) {
      const u = -1 + (2 * i) / ST;
      const half = breadthOf(h, u) * 0.97;
      const y = deckOf(h, u) + lift;
      row.push([db.vertex(u * h.L, y, z0 * half, c), db.vertex(u * h.L, y, z1 * half, c)]);
    }
    for (let i = 0; i < ST; i++) db.quad(row[i][0], row[i][1], row[i + 1][1], row[i + 1][0]);
  };
  strip(-1, 1, -0.0006, under);
  for (let p = 0; p < planks; p++) {
    const z0 = -1 + (2 * p) / planks, z1 = -1 + (2 * (p + 1)) / planks;
    const gap = 0.07 / planks;
    strip(z0 + gap, z1 - gap, 0, deck.clone().multiplyScalar(shades[p % shades.length]));
  }
  // The bulwarks' inner faces, from the deck up to the rail (the shell is drawn from outside
  // only, so without them the far side would vanish when seen over the near one).
  const inside = deck.clone().multiplyScalar(0.62);
  for (const side of [-1, 1]) {
    const wall: number[][] = [];
    for (let i = 0; i <= ST; i++) {
      const u = -1 + (2 * i) / ST;
      const z = side * breadthOf(h, u) * 0.985;
      wall.push([db.vertex(u * h.L, sheerOf(h, u), z, inside), db.vertex(u * h.L, deckOf(h, u) - 0.001, z, inside)]);
    }
    for (let i = 0; i < ST; i++) {
      const [a, b, c, d] = [wall[i][0], wall[i + 1][0], wall[i + 1][1], wall[i][1]];
      if (side < 0) db.quad(a, d, c, b);
      else db.quad(a, b, c, d);
    }
  }
  const d = db.build(true);
  k.add(d, new THREE.Matrix4(), (_x, _y, _z, o) => o.setRGB(1, 1, 1));
  // A capping rail along both gunwales, a touch wider than the planking it tops.
  for (const side of [-1, 1])
    for (let i = 0; i < ST; i++) {
      const u0 = -1 + (2 * i) / ST, u1 = -1 + (2 * (i + 1)) / ST;
      k.rod(v3(u0 * h.L, sheerOf(h, u0) + 0.001, side * breadthOf(h, u0)), v3(u1 * h.L, sheerOf(h, u1) + 0.001, side * breadthOf(h, u1)), 0.0021, '#3d2a1a', 4);
    }
}

/** Planking in strakes of two shades, a painted band under the rail, and a dark bottom. */
function strakes(plank: string, band: THREE.Color, bottom = '#2f2622') {
  const a = C(plank), b = C(plank).multiplyScalar(0.82), btm = C(bottom);
  return (_u: number, depth: number) => (depth < 0.16 ? band : depth > 0.82 ? btm : Math.floor(depth * 7) % 2 ? a : b);
}

/** Turn a point about the vertical through (x, 0) by `a`. */
function swing(p: THREE.Vector3, x: number, a: number) {
  if (!a) return p;
  const dx = p.x - x, c = Math.cos(a), sn = Math.sin(a);
  return p.set(x + dx * c + p.z * sn, p.y, -dx * sn + p.z * c);
}

/**
 * A square sail hung from a yard at height `yard`, `w` across and `h` deep, bellied forward (+x),
 * the yard braced round by `brace` (as for a wind on the quarter: it also keeps the sail's face
 * in view from the side, where a square sail would otherwise be seen edge on).
 */
function squareSail(k: Kit, x: number, yard: number, w: number, h: number, belly: number, paint: (u: number, v: number) => THREE.Color, brace = 0, floor = 0, spar = '#4a3322', nu = 12, nv = 8) {
  k.rod(swing(v3(x + 0.002, yard + 0.002, -w * 0.58), x, brace), swing(v3(x + 0.002, yard + 0.002, w * 0.58), x, brace), 0.0018, spar, 5);
  nightFloor(k, floor, () =>
    k.swaying(yard, h, 0.55, () => {
      k.surface(SURFACE.canvas, () =>
        crispCloth(k, nu, nv, (u, v) => swing(v3(x + 0.004 + belly * Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.12 + 0.8 * v)), yard - v * h, (u - 0.5) * w * (1 - 0.06 * v)), x, brace), paint),
      );
    }),
  );
}

/**
 * Sailcloth whose colours keep crisp edges: like Kit.cloth (both faces, normals leaning to the
 * sky so the far face reads in its colours), but every cell has its own corners, painted at its
 * middle, so a stripe, a hem or a roundel stops at a seam instead of smearing across the next cell
 * (as shared corners blended them, which made the raiders' stripes read as soft pink bars).
 */
function crispCloth(k: Kit, nu: number, nv: number, at: (u: number, v: number) => THREE.Vector3, paint: (u: number, v: number) => THREE.Color, thick = 0.0016) {
  const p = (u: number, v: number) => at(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
  const normal = (u: number, v: number, side: number) => {
    const n = p(u + 0.01, v).sub(p(u - 0.01, v)).cross(p(u, v + 0.01).sub(p(u, v - 0.01)));
    if (n.lengthSq() < 1e-14) n.set(0, 0, 1);
    return n.normalize().multiplyScalar(side);
  };
  for (const side of [1, -1])
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const c = paint((i + 0.5) / nu, (j + 0.5) / nv);
        const corner = (a: number, b: number) => {
          const u = (i + a) / nu, v = (j + b) / nv;
          const n = normal(u, v, side);
          const q = p(u, v).addScaledVector(n, thick / 2);
          const lit = n.add(SKY_LEAN).normalize();
          return k.b.vertex(q.x, q.y, q.z, c, lit.x, lit.y, lit.z);
        };
        const [a, b, cc, d] = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
        if (side > 0) k.b.quad(a, b, cc, d);
        else k.b.quad(a, d, cc, b);
      }
}
const SKY_LEAN = new THREE.Vector3(0, 0.5, 0);

/**
 * Cloth that keeps a floor of its own colour after dark (`level`: a share of the lamps' night
 * brightness, so a tenth is restrained): an owner's sail still reads as theirs at night, as the
 * lit windows say whose a house is. A negative glow is how the pieces' material is told it's
 * a floor in the piece's colour rather than a lamp (see pieceMaterial).
 */
function nightFloor(k: Kit, level: number, fn: () => void) {
  if (level > 0) k.lit(fn, -level);
  else fn();
}

/**
 * An owner's sail: their colour edge to edge, hemmed with a bolt rope in the trim and the
 * corners doubled with patches a shade darker where the sheets pull (the merchantman and the
 * raiders carry stripes and bands, so a plain field of colour is a player's).
 */
function ownerSail(base: THREE.Color, trim: THREE.Color, dark: THREE.Color) {
  return (u: number, v: number) => {
    if (Math.min(u, 1 - u, v * 1.1, (1 - v) * 1.1) < 0.05) return trim;
    if (Math.min(u, 1 - u) + Math.min(v, 1 - v) < 0.24) return dark;
    return base;
  };
}

/** A triangular (lateen) sail along the hull: tack low and forward, the yard's peak high and aft, the clew low and aft. */
function lateenSail(k: Kit, tack: THREE.Vector3, peak: THREE.Vector3, clew: THREE.Vector3, belly: number, paint: (u: number, v: number) => THREE.Color, mast = 0, swung = 0, floor = 0, spar = '#3d2a1a', yardR = 0.0016) {
  // (Swung out from the centreline about its mast, as a lateen yard is with the wind abeam.)
  [tack, peak, clew] = [tack, peak, clew].map((p) => swing(p.clone(), mast, swung));
  k.rod(tack.clone().lerp(peak, -0.08), peak.clone().lerp(tack, -0.04), yardR, spar, 5);
  nightFloor(k, floor, () =>
    k.swaying(Math.max(peak.y, tack.y), Math.max(peak.y, tack.y) - clew.y, 0.45, () => {
      k.surface(SURFACE.canvas, () =>
        crispCloth(k, 8, 5, (u, v) => {
          const foot = tack.clone().lerp(clew, u);
          const head = tack.clone().lerp(peak, u);
          return foot.lerp(head, v).add(v3(0, 0, belly * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)));
        }, paint),
      );
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Ships (Sea Lanes), a merchantman (a caravan's wagon at sea), the corsair, the raiders' longships.
// ---------------------------------------------------------------------------------------------

const ROPE = '#d2c29c';

/**
 * A player's ship: a round-sterned trader with a raised sterncastle, a big square mainsail in
 * the owner's colour (hemmed and with a roundel in their trim, so it reads as theirs from across
 * the island), a small lateen mizzen, a pennant at the masthead and a lantern at the stern. The
 * castles' tops are painted in the owner's colour too, the surfaces the usual high camera sees
 * most of. About 0.4 long on the board.
 */
export function makeShip(color: PlayerColor): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const k = new Kit();
  const base = C(pal.base), trim = C(pal.trim), dark = C(pal.dark);
  const pale = isPaleColor(color);
  const h: HullLines = { L: 0.105, B: 0.03, D: 0.022, draught: 0.014, bow: 1.5, stern: 1.0, sheerBow: 0.012, sheerStern: 0.014, transom: 0.6 };
  // (A wide band in the owner's colour under the rail, over a dark wale.)
  const wale = C('#3a2a1e'), plank = C('#8a5d38'), plank2 = C('#8a5d38').multiplyScalar(0.82), bottom = C('#2f2622');
  loftHull(k, h, (_u, depth) => (depth < 0.2 ? base : depth < 0.25 ? wale : depth > 0.82 ? bottom : Math.floor(depth * 7) % 2 ? plank : plank2), C('#b8915e'));
  const deckAt = (u: number) => deckOf(h, u);
  // Sterncastle: a deckhouse with a rail and lit windows, its roof in the owner's colour.
  const sx = -0.077, sw = breadthOf(h, -0.73) * 1.9, sy = deckAt(-0.73);
  k.add(box(0.044, 0.017, sw, 0.002), compose(sx, sy + 0.0085, 0), dark);
  k.add(box(0.046, 0.0025, sw + 0.002, 0.001), compose(sx, sy + 0.0178, 0), pale ? dark : base);
  for (const s of [-1, 1]) {
    k.rod(v3(sx - 0.023, sy + 0.021, s * (sw / 2 + 0.001)), v3(sx + 0.023, sy + 0.021, s * (sw / 2 + 0.001)), 0.0012, '#4a3322', 4);
    for (const dx of [-0.022, 0, 0.022]) k.rod(v3(sx + dx, sy + 0.018, s * (sw / 2 + 0.001)), v3(sx + dx, sy + 0.0215, s * (sw / 2 + 0.001)), 0.0008, '#4a3322', 3);
  }
  for (const s of [-1, 1]) k.lit(() => k.add(new THREE.BoxGeometry(0.008, 0.006, 0.002), compose(sx + 0.006, sy + 0.009, s * (sw / 2 + 0.0008)), '#ffcf7a'));
  lanternAt(k, -h.L - 0.004, sheerOf(h, -1) + 0.014, 0);
  // Forecastle: a low platform in the bow, decked in the owner's colour.
  const fw = breadthOf(h, 0.8) * 1.7;
  k.add(box(0.026, 0.009, fw, 0.002), compose(0.082, deckAt(0.8) + 0.0045, 0), dark);
  k.add(box(0.024, 0.0022, fw - 0.002, 0.001), compose(0.082, deckAt(0.8) + 0.0095, 0), pale ? dark : base);
  // Rudder, bowsprit, and the mast with a fighting top.
  k.add(new THREE.BoxGeometry(0.014, 0.03, 0.003), compose(-h.L - 0.002, 0.002, 0), '#4a3322');
  const sprit = v3(h.L + 0.035, sheerOf(h, 1) + 0.018, 0);
  k.rod(v3(h.L * 0.8, deckAt(0.8) + 0.006, 0), sprit, 0.0018, '#5e3c22');
  const mx = 0.012, top = 0.21;
  k.rod(v3(mx, deckAt(0.1), 0), v3(mx, top, 0), 0.0026, '#5e3c22', 6);
  k.add(new THREE.CylinderGeometry(0.0075, 0.0055, 0.007, 10, 1, true), compose(mx, 0.192, 0), '#4a3322');
  // The mainsail, the owner's from edge to edge, and the mizzen in their trim with a hem of
  // their colour. Both keep a floor of their own colour at night.
  squareSail(k, mx, 0.18, 0.114, 0.1, 0.018, ownerSail(base, pale ? dark : trim.clone().lerp(base, 0.1), pale ? C(pal.trim) : dark), 0.7, 0.075);
  const cream = trim.clone().lerp(C('#efe6d2'), pale ? 0.85 : 0.2);
  k.rod(v3(-0.076, sy + 0.018, 0), v3(-0.076, sy + 0.1, 0), 0.0018, '#5e3c22');
  lateenSail(k, v3(-0.05, sy + 0.034, 0), v3(-0.1, sy + 0.1, 0), v3(-0.106, sy + 0.03, 0), 0.006, (u, v) => (v < 0.12 || u > 0.9 ? base : cream), 0, 0, 0.05);
  // Standing rigging: forestay to the bowsprit, backstay, shrouds.
  k.rod(v3(mx, top - 0.01, 0), sprit, 0.0007, ROPE, 3);
  k.rod(v3(mx, top - 0.016, 0), v3(-h.L * 0.9, sheerOf(h, -0.9) + 0.02, 0), 0.0007, ROPE, 3);
  for (const s of [-1, 1]) for (const dx of [-0.008, 0.006]) k.rod(v3(mx, 0.188, 0), v3(mx + dx, sheerOf(h, 0.1), s * breadthOf(h, 0.1)), 0.0006, ROPE, 3);
  // Masthead pennant, lit like the sails.
  k.rod(v3(mx, top, 0), v3(mx, top + 0.014, 0), 0.0011, '#4a3322', 4);
  nightFloor(k, 0.075, () => streamer(k, v3(mx - 0.001, top + 0.013, 0), 0.05, 0.013, base, trim));
  // Cargo amidships: a hatch with its coaming, a barrel and a coil of rope.
  k.add(box(0.022, 0.004, 0.022, 0.001), compose(-0.026, deckAt(-0.25) + 0.002, 0), '#4a3322');
  k.add(new THREE.BoxGeometry(0.018, 0.0012, 0.018), compose(-0.026, deckAt(-0.25) + 0.0042, 0), '#6e4c2e');
  barrel(k, 0.04, deckAt(0.4), 0.01);
  barrel(k, 0.046, deckAt(0.44), -0.004, 0.005, 0.01);
  k.add(new THREE.TorusGeometry(0.0045, 0.0016, 4, 10).rotateX(Math.PI / 2), compose(0.045, deckAt(0.45) + 0.0016, -0.012), ROPE);
  return k.build();
}

/**
 * A merchantman for a caravan's wagon at sea: a beamy cog, castles fore and aft, a cream sail
 * with a russet band, and its goods on deck. Neutral: it belongs to no one.
 */
export function makeMerchant(): THREE.BufferGeometry {
  const k = new Kit();
  const h: HullLines = { L: 0.095, B: 0.035, D: 0.026, draught: 0.015, bow: 1.0, stern: 0.9, sheerBow: 0.014, sheerStern: 0.012, transom: 0.75 };
  loftHull(k, h, strakes('#9a6d44', C('#5e4128')), C('#c09a66'));
  const deckAt = (u: number) => deckOf(h, u);
  for (const [x, u, len] of [[-0.072, -0.76, 0.04], [0.074, 0.78, 0.03]] as const) {
    const w = breadthOf(h, u) * 1.95;
    k.add(box(len, 0.016, w, 0.002), compose(x, deckAt(u) + 0.008, 0), '#7a5432');
    // Crenellated rails round the castles' tops.
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.004, 0.005, 0.003), compose(x - len / 2 + 0.004 + (i * (len - 0.008)) / 4, deckAt(u) + 0.019, s * (w / 2)), '#5e4128');
  }
  k.lit(() => k.add(new THREE.BoxGeometry(0.002, 0.006, 0.01), compose(-h.L - 0.0005, deckAt(-0.9) + 0.008, 0), '#ffcf7a'));
  k.add(new THREE.BoxGeometry(0.014, 0.03, 0.003), compose(-h.L - 0.003, 0.004, 0), '#4a3322');
  const mx = 0.004, top = 0.18;
  k.rod(v3(mx, deckAt(0), 0), v3(mx, top, 0), 0.0028, '#5e3c22', 6);
  const cream = C('#efe6d2'), russet = shown('#a8452c');
  squareSail(k, mx, 0.158, 0.1, 0.09, 0.016, (_u, v) => (v > 0.36 && v < 0.6 ? russet : cream), -0.45);
  k.rod(v3(mx, top - 0.01, 0), v3(h.L + 0.01, sheerOf(h, 1) + 0.01, 0), 0.0007, ROPE, 3);
  for (const s of [-1, 1]) k.rod(v3(mx, top - 0.02, 0), v3(mx - 0.006, sheerOf(h, 0), s * breadthOf(h, 0)), 0.0006, ROPE, 3);
  streamer(k, v3(mx - 0.001, top + 0.002, 0), 0.034, 0.009, russet, cream);
  // Goods: barrels, crates and a bale amidships.
  for (const [x, z] of [[-0.03, 0.012], [-0.03, -0.004], [-0.042, 0.004]]) barrel(k, x, deckAt(-0.35), z, 0.006, 0.012);
  k.add(new THREE.BoxGeometry(0.013, 0.011, 0.013), compose(0.03, deckAt(0.3) + 0.0055, -0.01, 0, 0.3, 0), '#9a6d3f');
  k.add(new THREE.BoxGeometry(0.011, 0.009, 0.011), compose(0.042, deckAt(0.4) + 0.0045, 0.009, 0, -0.2, 0), '#b08250');
  const bale = smoothSphere(0.008, 1);
  bale.scale(1.3, 0.8, 1);
  k.add(bale, compose(0.022, deckAt(0.2) + 0.007, 0.012), '#d9c8a2');
  return k.build();
}

/**
 * The corsair: a long, low galley half as long again as a ship, black from waterline to sail,
 * with a blood-red wale, an iron ram at the bow, a bank of oars down each side, two black lateen
 * sails and long red streamers, and a red lantern on its poop.
 */
export function makeCorsair(): THREE.BufferGeometry {
  const k = new Kit();
  const h: HullLines = { L: 0.15, B: 0.03, D: 0.02, draught: 0.012, bow: 2.0, stern: 1.2, sheerBow: 0.008, sheerStern: 0.018 };
  const red = shown('#9a1f18'), black = shown('#262220');
  // The sails a weathered charcoal a step lighter than the hull, edged in a bone-pale bolt rope
  // with a red foot, on spars of bare, paler wood: dark against dark, the hull, the yards and the
  // canvas each keep their own outline (all three black, they merged into one shape).
  const sail = shown('#3d3633'), rope = shown('#b8aa90'), spar = `#${shown('#6a5440').getHexString()}`;
  loftHull(k, h, strakes(`#${shown('#2c2826').getHexString()}`, red, '#1a1614'), shown('#6a5644'));
  const deckAt = (u: number) => deckOf(h, u);
  // The ram: an iron beak just above the waterline, and a raked stem rising over it.
  k.add(new THREE.ConeGeometry(0.0055, 0.04, 6).rotateZ(-Math.PI / 2), compose(h.L + 0.014, 0.003, 0, 0, 0, 0, 1, 0.7, 1), '#4a4744');
  k.rod(v3(h.L * 0.98, 0.0, 0), v3(h.L + 0.012, sheerOf(h, 1) + 0.016, 0), 0.0024, black);
  // A raised poop aft, with a red lantern and a black flag on a staff.
  const py = deckAt(-0.82);
  k.add(box(0.04, 0.014, breadthOf(h, -0.82) * 1.9, 0.002), compose(-0.12, py + 0.007, 0), '#241f1c');
  k.add(box(0.044, 0.003, breadthOf(h, -0.82) * 1.9 + 0.004, 0.001), compose(-0.12, py + 0.015, 0), red);
  k.lit(() => k.add(new THREE.BoxGeometry(0.007, 0.009, 0.007), compose(-h.L - 0.006, sheerOf(h, -1) + 0.02, 0), '#ff8a5a'), 1.6);
  k.add(new THREE.ConeGeometry(0.006, 0.005, 4), compose(-h.L - 0.006, sheerOf(h, -1) + 0.027, 0, 0, Math.PI / 4, 0), '#1a1614');
  k.rod(v3(-0.135, py + 0.015, 0), v3(-0.135, py + 0.065, 0), 0.0012, '#1a1614', 4);
  k.swaying(-0.135, 0.03, 0.9, () => k.cloth(5, 3, (u, v) => v3(-0.136 - u * 0.03, py + 0.064 - v * 0.02, Math.sin(u * 4) * 0.002), (u, v) => (v < 0.15 || v > 0.85 || u > 0.88 ? red : black)), 'x');
  // Oars: a bank of nine down each side, blades in the water.
  for (const s of [-1, 1])
    for (let i = 0; i < 9; i++) {
      const u = -0.6 + i * 0.14;
      const at = v3(u * h.L, sheerOf(h, u) - 0.002, s * breadthOf(h, u));
      const blade = v3(u * h.L - 0.008, -0.004, s * (breadthOf(h, u) + 0.05));
      k.rod(at, blade, 0.0017, '#4a3a2e', 4);
      k.add(new THREE.BoxGeometry(0.011, 0.002, 0.0055), compose(blade.x, blade.y + 0.001, blade.z, 0, 0, 0), '#4a3a2e');
    }
  // Two masts, raked forward, with black lateen sails and red streamers.
  for (const [x, ht, w] of [[0.055, 0.19, 0.11], [-0.04, 0.22, 0.13]] as const) {
    k.rod(v3(x, deckAt(x / h.L), 0), v3(x + 0.006, ht, 0), 0.003, spar, 6);
    lateenSail(k, v3(x + w * 0.45, deckAt(x / h.L) + 0.03, 0), v3(x - w * 0.55, ht + 0.012, 0), v3(x - w * 0.45, deckAt(x / h.L) + 0.024, 0), 0.014, (u, v) => (v < 0.12 ? red : u > 0.9 || v > 0.9 ? rope : sail), x, 0.55, 0, spar, 0.0024);
    k.rod(v3(x + 0.006, ht, 0), v3(x + 0.006, ht + 0.014, 0), 0.0011, '#1a1614', 4);
    streamer(k, v3(x + 0.005, ht + 0.013, 0), 0.07, 0.012, red);
    for (const s of [-1, 1]) k.rod(v3(x + 0.005, ht - 0.02, 0), v3(x - 0.004, sheerOf(h, x / h.L), s * breadthOf(h, x / h.L)), 0.0006, '#6a5a48', 3);
  }
  return k.build();
}

/**
 * The fleet's three longships are kin, not copies: each has its own sail, its own run of shield
 * colours and its crew at another point of the stroke.
 */
const LONGSHIPS = [
  { sail: ['#a3261d', '#efe6d2'], stripes: 6, stroke: 0.32, shields: ['#a3261d', '#efe6d2', '#2c2724', '#c8902e'] },
  { sail: ['#a3261d', '#2c2724'], stripes: 4, stroke: -0.05, shields: ['#efe6d2', '#a3261d', '#c8902e', '#3d5a7a'] },
  { sail: ['#c8902e', '#a3261d'], stripes: 8, stroke: 0.15, shields: ['#2c2724', '#c8902e', '#a3261d', '#efe6d2'] },
];

/** Tunics, faces and helmets for a longship's rowers. */
const TUNICS = ['#7a3a2a', '#5e5a3a', '#4a5a6a', '#8a6a3a', '#6a4a5a', '#3a4a3a'];
const SKIN = ['#e0b08a', '#c9926a', '#d8a47c'];

/**
 * A raider's longship: long and open, its stem and stern curling up into a carved head and
 * tail, a crew at the oars on their benches, round shields leaning out from the rail (the
 * longship's own outline from above, a beaded rim of colour), and a square sail in bold stripes.
 * `kind` picks one of the fleet's three.
 */
export function makeLongship(kind = 0): THREE.BufferGeometry {
  const look = LONGSHIPS[kind % LONGSHIPS.length];
  const k = new Kit();
  const h: HullLines = { L: 0.13, B: 0.027, D: 0.022, draught: 0.01, bow: 1.25, stern: 1.25, sheerBow: 0.022, sheerStern: 0.02 };
  const tar = '#3a2a1e';
  const [sa, sb] = look.sail.map((c) => (c === '#efe6d2' ? C(c) : shown(c)));
  loftHull(k, h, strakes('#7a5232', C(tar)), C('#8a6844'), 22, 10, 5);
  const deckAt = (u: number) => deckOf(h, u);
  // Stem and stern posts curling inward, the stem ending in a carved beast's head.
  for (const end of [1, -1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const a = t * Math.PI * (end > 0 ? 1.15 : 1.35);
      const r = 0.026 * (1 - 0.35 * t);
      pts.push(v3(end * (h.L * 0.97 + Math.sin(a) * r * 0.9), sheerOf(h, end) - 0.006 + (1 - Math.cos(a)) * r, 0));
    }
    for (let i = 0; i < 8; i++) k.rod(pts[i], pts[i + 1], 0.0032 * (1 - i * 0.06), tar, 6);
    if (end > 0) {
      const tip = pts[8];
      const head = smoothSphere(0.005, 1);
      head.scale(1.6, 0.9, 0.8);
      k.add(head, compose(tip.x - 0.004, tip.y + 0.002, 0, 0, 0, -0.5), tar);
      k.add(new THREE.ConeGeometry(0.0022, 0.008, 5), compose(tip.x - 0.008, tip.y + 0.007, 0, 0, 0, 0.6), tar);
      for (const s of [-1, 1]) k.lit(() => k.add(smoothSphere(0.0011, 0), compose(tip.x - 0.002, tip.y + 0.003, s * 0.0035), '#ffb35a'), 0.6);
    }
  }
  // Benches across the hull, a rower on each side of each (facing aft, as rowers sit), and the
  // oars out from their hands, all at one point of the stroke but none quite parallel.
  const STATIONS = 7;
  for (let i = 0; i < STATIONS; i++) {
    const u = -0.54 + i * 0.175;
    const half = breadthOf(h, u), y = deckAt(u);
    k.add(new THREE.BoxGeometry(0.005, 0.0022, half * 1.9), compose(u * h.L, y + 0.0045, 0), '#5e4128');
    for (const s of [-1, 1]) {
      const n = i * 2 + (s > 0 ? 1 : 0) + kind * 5;
      const tunic = shown(TUNICS[n % TUNICS.length]);
      const z = s * half * 0.5;
      const body = smoothSphere(0.0042, 0);
      body.scale(0.9, 1.25, 1);
      // (Leaning back into the stroke, or forward out of it.)
      const lean = look.stroke * 0.6;
      k.add(body, compose(u * h.L - 0.002 * lean, y + 0.0095, z, 0, 0, lean), tunic);
      const hx = u * h.L - 0.0045 * lean - 0.001, hy = y + 0.0158;
      k.add(smoothSphere(0.0031, 0), compose(hx, hy, z), shown(SKIN[n % SKIN.length]));
      // Every third rower in a helmet, the rest bareheaded or hooded.
      if (n % 3 === 0) k.add(new THREE.SphereGeometry(0.0033, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2), compose(hx, hy + 0.0006, z), '#6a6662');
      else if (n % 3 === 1) k.add(new THREE.SphereGeometry(0.0034, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2), compose(hx, hy + 0.0003, z), tunic.clone().multiplyScalar(0.8));
      // The oar: from the rower's hands out over the rail, swept by the stroke, the blade dipped.
      const jit = Math.sin(n * 2.3) * 0.06, dip = 0.002 * Math.sin(n * 1.7);
      const sweep = look.stroke + jit;
      const at = v3(u * h.L + 0.006, sheerOf(h, u) - 0.0015, s * half);
      const reach = 0.047 + 0.003 * Math.sin(n * 0.9);
      const blade = v3(u * h.L - Math.sin(sweep) * reach, -0.004 + dip - Math.max(0, -sweep) * 0.006, s * (half + Math.cos(sweep) * reach));
      k.rod(v3(at.x + 0.004, y + 0.012, s * half * 0.62), at, 0.0014, '#6a4a2e', 4);
      k.rod(at, blade, 0.0015, '#6a4a2e', 4);
      k.add(new THREE.BoxGeometry(0.011, 0.0018, 0.0055), compose(blade.x, blade.y + 0.001, blade.z, 0, -s * sweep * 0.5, 0), '#5a3e26');
    }
  }
  // A sea chest or two and a coil of rope by the mast; a steering oar on the starboard quarter.
  k.add(box(0.012, 0.006, 0.008, 0.001), compose(0.012, deckAt(0.1) + 0.003, -0.008), '#6a4a2e');
  k.add(new THREE.TorusGeometry(0.004, 0.0014, 4, 10).rotateX(Math.PI / 2), compose(-0.012, deckAt(-0.1) + 0.0014, 0.007), ROPE);
  k.rod(v3(-h.L * 0.82, sheerOf(h, -0.82) + 0.004, breadthOf(h, -0.82) + 0.002), v3(-h.L * 0.98, -0.008, breadthOf(h, -0.9) + 0.006), 0.0018, tar, 4);
  k.add(new THREE.BoxGeometry(0.014, 0.012, 0.002), compose(-h.L * 0.98, -0.006, breadthOf(h, -0.9) + 0.006, 0, 0, 0.3), tar);
  // Shields along the rail, overlapping, each leaning out so its face shows from above as well
  // as from the side: halved in two of the ship's colours, rimmed, with an iron boss.
  const SHIELDS = 10;
  for (const s of [-1, 1])
    for (let i = 0; i < SHIELDS; i++) {
      const u = -0.7 + (i * 1.4) / (SHIELDS - 1);
      const n = i + (s > 0 ? 2 : 0);
      const ca = shown(look.shields[n % 4]), cb = shown(look.shields[(n + 1 + (i % 2)) % 4]);
      const r = 0.0105;
      const disc = new THREE.CylinderGeometry(r, r, 0.0016, 10);
      // (Painted in its own frame: one half and the other, a dark rim round both.)
      const cols = new Float32Array(disc.getAttribute('position').count * 3);
      const p = disc.getAttribute('position');
      for (let j = 0; j < p.count; j++) {
        const x = p.getX(j), z = p.getZ(j);
        const c = Math.hypot(x, z) > r * 0.86 ? C('#3a2e24') : x * Math.cos(n) + z * Math.sin(n) > 0 ? ca : cb;
        cols.set([c.r, c.g, c.b], j * 3);
      }
      disc.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      const tilt = 0.95;
      const z = s * (breadthOf(h, u) + 0.0042), y = sheerOf(h, u) + 0.0012;
      // The disc's axis turned from up to outward and a little up.
      disc.rotateX(s * (Math.PI / 2 - tilt));
      k.add(disc, compose(u * h.L, y, z), C('#ffffff'));
      k.add(smoothSphere(0.0021, 0), compose(u * h.L, y + Math.sin(tilt) * 0.001, z + s * Math.cos(tilt) * 0.001), '#6a6662');
    }
  // Mast and the striped square sail, its hem and corners doubled in dark cloth.
  const top = 0.18;
  k.rod(v3(0, deckAt(0), 0), v3(0, top, 0), 0.0028, tar, 6);
  const hem = C('#3a2e24');
  const st = stripes(look.stripes, sa, sb);
  squareSail(k, 0, 0.16, 0.112, 0.09, 0.02, (u, v) => (v < 0.06 || v > 0.94 || Math.min(u, 1 - u) + Math.min(v, 1 - v) < 0.16 ? hem : st(u, v)), 0.3 + kind * 0.08, 0, tar, look.stripes * 2, 6);
  for (const s of [-1, 1]) k.rod(v3(0, top - 0.01, 0), v3(-0.004, sheerOf(h, 0), s * breadthOf(h, 0)), 0.0006, ROPE, 3);
  k.rod(v3(0, top - 0.01, 0), v3(h.L * 0.9, sheerOf(h, 0.9), 0), 0.0006, ROPE, 3);
  k.rod(v3(0, top - 0.01, 0), v3(-h.L * 0.9, sheerOf(h, -0.9), 0), 0.0006, ROPE, 3);
  // A raven-black streamer at the masthead.
  k.rod(v3(0, top, 0), v3(0, top + 0.012, 0), 0.0011, tar, 4);
  streamer(k, v3(-0.001, top + 0.011, 0), 0.05, 0.012, C('#2c2724'), sa);
  return k.build();
}

/**
 * A buoy on the raider fleet's course: a tarred spar float banded in the raiders' red, with a
 * black pennant. One stands at every step the fleet has still to sail, so the line of them
 * between the fleet and the coast is its clock. The last, off the coast where it will land, is a
 * bigger barrel buoy carrying a tall war flag and a red lantern lit after dark.
 */
export function makeCourseBuoy(landing = false): THREE.BufferGeometry {
  const k = new Kit();
  const red = shown('#b8281e'), tar = '#2c2420', black = C('#2c2724'), cream = C('#efe6d2');
  if (!landing) {
    // (Squat and bright enough to read as a dot from the home view: a red can on a pale collar.)
    k.add(new THREE.CylinderGeometry(0.02, 0.022, 0.008, 12), compose(0, 0.002, 0), cream);
    k.add(new THREE.CylinderGeometry(0.008, 0.016, 0.05, 10), compose(0, 0.03, 0), (_x, y, _z, o) => o.copy(y > 0.036 && y < 0.044 ? cream : red));
    k.rod(v3(0, 0.054, 0), v3(0, 0.08, 0), 0.0014, tar, 4);
    streamer(k, v3(-0.0005, 0.079, 0), 0.03, 0.012, black, red);
    return k.build();
  }
  k.add(new THREE.CylinderGeometry(0.017, 0.015, 0.026, 12), compose(0, 0.006, 0), (_x, y, _z, o) => o.copy(Math.floor((y + 0.007) / 0.0065) % 2 ? red : black));
  k.add(new THREE.TorusGeometry(0.0165, 0.002, 4, 14).rotateX(Math.PI / 2), compose(0, 0.019, 0), tar);
  k.rod(v3(0, 0.019, 0), v3(0, 0.1, 0), 0.0016, tar, 5);
  k.swaying(0, 0.04, 1, () => k.cloth(6, 3, (u, v) => v3(-u * 0.04, 0.097 - v * 0.024 - u * 0.004, Math.sin(u * 5) * 0.002), (u, v) => (v > 0.4 && v < 0.6 ? red : u > 0.85 && Math.abs(v - 0.5) < 0.28 ? red : black)), 'x');
  k.lit(() => k.add(new THREE.BoxGeometry(0.006, 0.008, 0.006), compose(0.004, 0.072, 0), '#ff6a4a'), 1.6);
  k.add(new THREE.ConeGeometry(0.0055, 0.004, 4), compose(0.004, 0.078, 0, 0, Math.PI / 4, 0), tar);
  return k.build();
}

/**
 * A fishing ground's skiff (grounds.ts): a small open boat moored inside the ring of nets, a
 * fisherman in yellow oilskins hauling at the stern, the net heaped in the bow with a gull
 * perched on the stem, oars shipped, and a lantern on a pole lit after dark. About 0.13 long
 * before the grounds' scale; built on the kit for its hull, drawn with the sea props' material.
 */
export function makeSkiff(): THREE.BufferGeometry {
  const k = new Kit();
  const h: HullLines = { L: 0.065, B: 0.021, D: 0.013, draught: 0.008, bow: 1.3, stern: 1.0, sheerBow: 0.008, sheerStern: 0.004, transom: 0.7 };
  loftHull(k, h, strakes('#9a7048', shown('#2f6f86'), '#3a3a30'), C('#a8845a'), 14, 8, 3);
  const deckAt = (u: number) => deckOf(h, u);
  // Thwarts, and the oars shipped along them.
  for (const u of [-0.45, 0.15]) k.add(new THREE.BoxGeometry(0.006, 0.002, breadthOf(h, u) * 1.9), compose(u * h.L, deckAt(u) + 0.006, 0), '#6e4c2e');
  for (const s of [-1, 1]) k.rod(v3(-0.05, sheerOf(h, -0.7) + 0.001, s * 0.011), v3(0.05, sheerOf(h, 0.7) + 0.001, s * 0.009), 0.0011, '#8a6a44', 4);
  // The fisherman: seated on the after thwart, leaning out over the side to the net.
  const oil = shown('#d9a92e');
  const body = smoothSphere(0.0068, 1);
  body.scale(0.9, 1.25, 0.95);
  k.add(body, compose(-0.03, deckAt(-0.45) + 0.0135, 0.004, 0.25, 0, 0), oil);
  k.add(smoothSphere(0.0042, 1), compose(-0.03, deckAt(-0.45) + 0.0235, 0.0075), shown('#d8a47c'));
  k.add(new THREE.ConeGeometry(0.0062, 0.0045, 10), compose(-0.03, deckAt(-0.45) + 0.0282, 0.0075), oil.clone().multiplyScalar(0.85));
  for (const s of [-1, 1]) k.rod(v3(-0.03 + s * 0.004, deckAt(-0.45) + 0.017, 0.008), v3(-0.026 + s * 0.006, sheerOf(h, -0.4) + 0.003, breadthOf(h, -0.4) + 0.002), 0.0019, oil, 4);
  // The net heaped in the bow, dark and lumpy, and over the side into the water.
  const heap = smoothSphere(0.011, 1);
  heap.scale(1.3, 0.5, 1);
  k.add(heap, compose(0.032, deckAt(0.5) + 0.004, 0), (x, _y, z, o) => o.copy(C('#4a5240')).multiplyScalar(0.8 + 0.25 * Math.sin(x * 900 + z * 700)));
  k.rod(v3(0.02, sheerOf(h, 0.3), breadthOf(h, 0.3)), v3(0.01, -0.006, breadthOf(h, 0.3) + 0.016), 0.0016, '#4a5240', 4);
  // A gull on the stem post.
  k.rod(v3(h.L * 0.96, sheerOf(h, 0.96), 0), v3(h.L * 0.98, sheerOf(h, 1) + 0.01, 0), 0.0016, '#5e4128', 4);
  const gull = smoothSphere(0.0045, 1);
  gull.scale(1.5, 0.85, 0.85);
  k.add(gull, compose(h.L * 0.98, sheerOf(h, 1) + 0.0145, 0), '#f2f2ee');
  k.add(smoothSphere(0.0026, 1), compose(h.L * 0.98 + 0.0055, sheerOf(h, 1) + 0.018, 0), '#f6f6f2');
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.008, 0.0012, 0.0024), compose(h.L * 0.98 - 0.0015, sheerOf(h, 1) + 0.0158, s * 0.0032, 0, 0, -0.15), '#9aa0a6');
  k.add(new THREE.ConeGeometry(0.0008, 0.0035, 4), compose(h.L * 0.98 + 0.0092, sheerOf(h, 1) + 0.0178, 0, 0, 0, -Math.PI / 2), '#e3a83c');
  // The lantern pole at the stern, its lantern lit after dark.
  k.rod(v3(-h.L * 0.88, deckAt(-0.88), 0), v3(-h.L * 0.88, 0.07, 0), 0.0012, '#4a3a2e', 4);
  k.rod(v3(-h.L * 0.88, 0.068, 0), v3(-h.L * 0.88 + 0.008, 0.068, 0), 0.0009, '#4a3a2e', 3);
  lanternAt(k, -h.L * 0.88 + 0.008, 0.06, 0, 0.9);
  return k.build();
}
