// The expansions' works on the land: city walls, guild seats, foundries, bridges, the caravans'
// wagons and the castle. Units and conventions are the kit's (kit.ts).

import * as THREE from 'three/webgpu';
import type { PlayerColor, Track } from '../../engine';
import { compose, smoothSphere } from './geom';
import { PLAYER_PALETTE, box, gable, gableWall } from './pieces';
import { SURFACE } from './surfaces';
import { C, Kit, shown, v3, streamer, barrel, lanternAt, type Paint } from './kit';
import { SKIN, figure } from './figures';
import { BRIDGE, deckY } from './layout';

// ---------------------------------------------------------------------------------------------
// On and beside the buildings: city walls, guild seats, foundries. Walls stand round a city in
// its own frame (it faces +z, as makeCity builds it); seats and foundries stand beside it.
// ---------------------------------------------------------------------------------------------

/**
 * Dressed stone for the walls, the castle and the bridges: paler and warmer than the cities'
 * towers (#9a958d), as a mass of it reads near black under the island's light otherwise.
 */
const STONE = `#${shown('#b4ab9b').getHexString()}`;
const STONE_DARK = `#${shown('#8c8476').getHexString()}`;
/** The castle's roofs: weathered lead, and verdigris copper on the keep, apart from every player's colours. */
const LEAD = shown('#7c8388');
const VERDIGRIS = shown('#6a9a8a');

/** A run of crenellated wall from a to b (on the ground, in xz), `h` high and `t` thick, merlons on its outer face (towards `out`). */
function wallRun(k: Kit, a: THREE.Vector2, b: THREE.Vector2, h: number, t: number, out: number, stone: Paint) {
  const len = a.distanceTo(b);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const mx = (a.x + b.x) / 2, mz = (a.y + b.y) / 2;
  // (Its footing runs below the ground, for where the ground falls away under it.)
  k.surface(SURFACE.stone, () => k.add(new THREE.BoxGeometry(len + t * 0.6, h + 0.03, t), compose(mx, (h - 0.03) / 2, mz, 0, -ang, 0), stone));
  const n = Math.max(2, Math.round(len / 0.011));
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n - 0.5;
    const x = mx + Math.cos(ang) * f * len, z = mz + Math.sin(ang) * f * len;
    for (const side of [out, -out * 0.0]) if (side) k.add(new THREE.BoxGeometry(len / n * 0.55, 0.0065, t * 0.34), compose(x - Math.sin(ang) * side * t * 0.33, h + 0.003, z + Math.cos(ang) * side * t * 0.33, 0, -ang, 0), STONE_DARK);
  }
}

/** A round tower with a crenellated top and a conical roof in `roof` (or, with none, a flat lead one behind its merlons). */
function roundTower(k: Kit, x: number, z: number, r: number, h: number, roof: THREE.Color | null, stone: Paint = STONE) {
  k.surface(SURFACE.stone, () => k.add(new THREE.CylinderGeometry(r, r * 1.08, h + 0.03, 16, 4), compose(x, (h - 0.03) / 2, z), stone));
  k.add(new THREE.CylinderGeometry(r * 1.18, r * 1.12, 0.008, 16), compose(x, h + 0.002, z), STONE_DARK);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.add(new THREE.BoxGeometry(r * 0.42, 0.007, r * 0.3), compose(x + Math.cos(a) * r * 1.1, h + 0.0085, z + Math.sin(a) * r * 1.1, 0, -a, 0), STONE_DARK);
  }
  if (roof) k.surface(SURFACE.roof, () => k.add(new THREE.ConeGeometry(r * 1.3, r * 2.3, 16, 2), compose(x, h + 0.006 + r * 1.15, z), roof));
  else k.add(new THREE.CylinderGeometry(r * 0.98, r * 0.98, 0.002, 16), compose(x, h + 0.006, z), LEAD);
}

/** A slit window that glows at night, on a tower or wall facing direction `a` (radians in xz). */
function slit(k: Kit, x: number, y: number, z: number, a: number, w = 0.003, h = 0.008) {
  k.lit(() => k.add(new THREE.BoxGeometry(0.002, h, w), compose(x, y, z, 0, -a, 0), '#ffcf7a'));
}

/** A hash of three numbers, 0..1, for patterns painted on the vertices. */
function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A square frustum (a four-sided truncated cone) with its faces square to x and z, flat-shaded:
 * half-widths `b` at the foot and `t` at the top, `h` high, centred on its height.
 */
function frustum(b: number, t: number, h: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(t * Math.SQRT2, b * Math.SQRT2, h, 4, 1).rotateY(Math.PI / 4).toNonIndexed();
  g.computeVertexNormals();
  return g;
}

/**
 * A flat, ragged patch on the ground round (x, z), radii rx and rz, painted by `paint`: a little
 * above the model's foot, which marks sinks below the ground on a slope (see ModuleMarks.footing).
 */
function patch(k: Kit, x: number, z: number, rx: number, rz: number, seed: number, paint: Paint) {
  const b = k.b, c = new THREE.Color(), y = 0.0045;
  const at = (px: number, pz: number) => {
    if (typeof paint === 'function') paint(px, y, pz, c);
    else c.copy(typeof paint === 'string' ? C(paint) : paint);
    return b.vertex(px, y, pz, c);
  };
  const N = 30, mid = at(x, z), inner: number[] = [], ring: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rag = 0.82 + 0.1 * Math.sin(a * 3 + seed) + 0.08 * Math.sin(a * 7 + seed * 2.3) + 0.06 * (hash3(i, seed, 0) - 0.5);
    inner.push(at(x + Math.cos(a) * rx * 0.5, z + Math.sin(a) * rz * 0.5));
    ring.push(at(x + Math.cos(a) * rx * rag, z + Math.sin(a) * rz * rag));
  }
  // (Wound to face up.)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    b.tri(mid, inner[j], inner[i]);
    b.quad(inner[i], inner[j], ring[j], ring[i]);
  }
}

/** A gatehouse in a wall at heading θ (the ring's own), `gw` wide: square towers, an arch, gates standing open, pennants over it. */
function gatehouse(k: Kit, mid: THREE.Vector2, theta: number, gw: number, pal: { base: string; trim: string }) {
  // Its own frame: x along the wall, +z inwards (towards the city), y up.
  const G = compose(mid.x, 0, mid.y, 0, -(theta + Math.PI / 2), 0);
  const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => G.clone().multiply(compose(x, y, z, rx, ry, rz));
  const hw = gw / 2 + 0.012;
  for (const s of [-1, 1]) {
    k.surface(SURFACE.stone, () => k.add(new THREE.BoxGeometry(0.024, 0.094, 0.024), at(s * hw, 0.032, 0), STONE));
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1], [0, -1], [1, 0], [-1, 0]]) k.add(new THREE.BoxGeometry(0.0062, 0.007, 0.0062), at(s * hw + dx * 0.0093, 0.0825, dz * 0.0093), STONE_DARK);
    k.lit(() => k.add(new THREE.BoxGeometry(0.003, 0.008, 0.002), at(s * hw, 0.05, -0.0122), '#ffcf7a'));
    // The gates, hinged at the towers and swung in.
    const open = 1.15;
    const dx = -s * Math.cos(open), dz = Math.sin(open);
    k.add(new THREE.BoxGeometry(gw / 2 - 0.001, 0.046, 0.003), at(s * (gw / 2) + dx * (gw / 4), 0.023, dz * (gw / 4), 0, -Math.atan2(dz, dx), 0), '#4a3322');
    const top = new THREE.Vector3(s * hw, 0.086, 0).applyMatrix4(G);
    k.rod(top, top.clone().setY(0.12), 0.0012, '#4a3322', 4);
    streamer(k, top.clone().setY(0.119).setX(top.x - 0.0005), 0.03, 0.01, C(pal.base), C(pal.trim));
  }
  k.surface(SURFACE.stone, () => k.add(new THREE.BoxGeometry(gw + 0.004, 0.016, 0.02), at(0, 0.058, 0), STONE));
  k.add(new THREE.CylinderGeometry(gw / 2, gw / 2, 0.021, 12, 1, false, 0, Math.PI), at(0, 0.05, 0, Math.PI / 2, 0, Math.PI / 2), STONE_DARK);
}

/**
 * City walls: a ring of crenellated stone round the city's footprint (in the city's own frame),
 * a gatehouse wherever a road can leave it (`gates`: headings in that frame), and round towers
 * between them roofed in the owner's colour.
 */
export function makeWall(color: PlayerColor, gates: number[]): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const k = new Kit();
  const roof = C(pal.dark);
  const cx = -0.004, cz = 0.006, rx = 0.15, rz = 0.14;
  const at = (a: number) => new THREE.Vector2(cx + Math.cos(a) * rx, cz + Math.sin(a) * rz);
  const TAU = Math.PI * 2, gate = 0.21;
  const gs = (gates.length ? gates : [Math.PI / 2]).map((g) => ((g % TAU) + TAU) % TAU).sort((p, q) => p - q);
  gs.forEach((g, i) => {
    const next = i + 1 < gs.length ? gs[i + 1] : gs[0] + TAU;
    const arc = next - g;
    // The wall from this gate round to the next, in runs of a fraction of a radian.
    const a0 = g + gate, a1 = next - gate;
    const runs = Math.max(1, Math.ceil((a1 - a0) / 0.5));
    for (let j = 0; j < runs; j++) wallRun(k, at(a0 + ((a1 - a0) * j) / runs), at(a0 + ((a1 - a0) * (j + 1)) / runs), 0.04, 0.012, 1, STONE);
    const towers = Math.max(1, Math.round(arc / 1.7));
    for (let j = 1; j <= towers; j++) {
      const a = g + (arc * j) / (towers + 1);
      const p = at(a);
      roundTower(k, p.x, p.y, 0.016, 0.058, roof);
      slit(k, p.x + Math.cos(a) * 0.0168, 0.036, p.y + Math.sin(a) * 0.0168, a);
    }
    const g0 = at(g - gate), g1 = at(g + gate);
    gatehouse(k, g0.clone().add(g1).multiplyScalar(0.5), g, g0.distanceTo(g1) - 0.024, pal);
  });
  return k.build();
}

/**
 * The gilded emblem on a guild seat's standard: an open book for Learning, a purse of coin for
 * Commerce, a crown for Statecraft. Built round (x, y, z), about 0.024 across.
 */
function emblem(k: Kit, track: Track, x: number, y: number, z: number) {
  const gold = shown('#e0b24a'), deep = shown('#b07a22');
  if (track === 'learning') {
    for (const s of [-1, 1]) {
      k.add(box(0.016, 0.022, 0.0024, 0.001), compose(x, y, z + s * 0.0068, s * 0.5, 0, 0), deep);
      k.add(box(0.0148, 0.0205, 0.002, 0.0008), compose(x + 0.0004, y + 0.0004, z + s * 0.0058, s * 0.5, 0, 0), C('#f2ead8'));
    }
    k.add(new THREE.CylinderGeometry(0.0016, 0.0016, 0.016, 6).rotateZ(Math.PI / 2), compose(x, y - 0.0102, z), gold);
  } else if (track === 'commerce') {
    const bag = smoothSphere(0.0095, 2);
    bag.scale(1, 0.95, 1);
    k.add(bag, compose(x, y - 0.002, z), deep);
    k.add(new THREE.CylinderGeometry(0.0034, 0.005, 0.006, 10), compose(x, y + 0.0085, z), deep);
    k.add(new THREE.TorusGeometry(0.0042, 0.0012, 5, 12).rotateX(Math.PI / 2), compose(x, y + 0.0065, z), gold);
    for (const [dx, dy, a] of [[0.009, -0.009, 0.4], [-0.006, -0.011, -0.6]]) k.add(new THREE.CylinderGeometry(0.0045, 0.0045, 0.0012, 12), compose(x + dx, y + dy, z + 0.004, Math.PI / 2 + a, 0, a), gold);
  } else {
    k.add(new THREE.CylinderGeometry(0.0105, 0.0105, 0.0055, 16, 1, true), compose(x, y - 0.006, z), gold);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      k.add(new THREE.ConeGeometry(0.0028, 0.009, 5), compose(x + Math.cos(a) * 0.0103, y + 0.0015, z + Math.sin(a) * 0.0103), gold);
      k.add(smoothSphere(0.0015, 0), compose(x + Math.cos(a) * 0.0103, y + 0.0062, z + Math.sin(a) * 0.0103), gold);
      k.add(smoothSphere(0.0016, 0), compose(x + Math.cos(a + 0.5) * 0.0108, y - 0.006, z + Math.sin(a + 0.5) * 0.0108), i % 2 ? shown('#b8242a') : shown('#2a6ab8'));
    }
  }
}

/**
 * Each guild track's colour (as its cards' band in the interface), deepened to sit on the board
 * beside the players' colours: the hall's accent, its emblem board and its awnings.
 */
const TRACK_COLOR: Record<Track, string> = { learning: '#3f6f8a', commerce: '#a8743a', statecraft: '#7b4a86' };

/** The track's emblem as a model of its own, to set wherever it's wanted at any size. */
function emblemModel(track: Track) {
  const e = new Kit();
  emblem(e, track, 0, 0, 0);
  return e.build();
}

const WHITE = new THREE.Color(1, 1, 1);

/** The guildhall's shared body, in its own frame: the door (+x) faces out from the building. */
const HALL = { x0: -0.035, x1: 0.035, z: 0.029, ground: 0.032, jetty: 0.006, upper: 0.03, rise: 0.064 };

/**
 * A guild seat: a guildhall beside the city. One hall for every track: a ground floor of coursed
 * stone with an arched door (+x, out from the building), a timber-framed upper storey jettied out
 * over it on three sides, a steep roof tiled in the owner's colour (as their houses are), and on the front gable a painted board of the
 * track's colour bearing its gilded emblem, with the owner's banners hanging either side. On the
 * roof, each track's own mark, so the three read apart from across the island: a little
 * observatory dome for Learning, a gilded weathervane on a cupola over an arcade of market stalls
 * for Commerce, and a bell tower with a clock for Statecraft.
 */
export function makeSeat(color: PlayerColor, track: Track): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const k = new Kit();
  // (Colours chosen as they should look go through shown(); the players' palettes are stored
  // already squared-for, as pieces.ts keeps them.)
  const own = C(pal.base), trim = C(pal.trim), field = shown(TRACK_COLOR[track]), gold = shown('#e0b24a');
  const stone = shown('#b2a48e'), plaster = shown('#eadfc6'), beam = shown('#3e2a1c'), roof = C(pal.dark);
  const glass = shown('#ffcf7a');
  const { x0, x1, z, ground, jetty, upper, rise } = HALL;
  const W = x1 - x0, cx = (x0 + x1) / 2;
  const u0 = ground, u1 = ground + upper;
  const ux1 = x1 + jetty, uz = z + jetty;
  // Ground floor: coursed stone, run on into the ground for a slope.
  k.surface(SURFACE.stone, () => k.add(box(W, ground + 0.03, z * 2, 0.002), compose(cx, (ground - 0.03) / 2, 0), stone));
  // The upper storey, out over the front and both sides, on a bressumer beam and brackets.
  const UW = ux1 - x0, ucx = (x0 + ux1) / 2;
  k.add(box(UW, upper, uz * 2, 0.0015), compose(ucx, (u0 + u1) / 2, 0), plaster);
  k.add(new THREE.BoxGeometry(UW + 0.002, 0.004, uz * 2 + 0.002), compose(ucx, u0 + 0.001, 0), beam);
  for (let i = 0; i < 4; i++) {
    const f = -z + 0.006 + (i * (2 * z - 0.012)) / 3;
    k.add(new THREE.BoxGeometry(0.0026, 0.0026, 0.009), compose(x1 + 0.003, u0 - 0.003, f, 0, Math.PI / 2, 0.75), beam);
    for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.0026, 0.0026, 0.009), compose(x0 + 0.01 + i * 0.016, u0 - 0.003, s * (z + 0.003), s * -0.75, 0, 0), beam);
  }
  // Its timbers: posts, a rail and braces on every face, standing proud of the plaster.
  const studs = (n: number, len: number, put: (t: number, w: number, h: number, y: number, rz?: number) => void) => {
    for (let i = 0; i <= n; i++) put(-len / 2 + (i * len) / n, 0.0028, upper, (u0 + u1) / 2);
    put(0, len, 0.0026, u0 + upper * 0.52);
    put(0, len, 0.003, u1 - 0.0015);
    for (let i = 0; i < n; i++) if (i % 2 === 0) put(-len / 2 + ((i + 0.5) * len) / n, 0.0022, Math.hypot(len / n, upper * 0.48), u0 + upper * 0.26, i % 4 ? 0.75 : -0.75);
  };
  studs(6, UW, (t, w, h, y, rz = 0) => {
    for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(w, h, 0.0016), compose(ucx + t, y, s * (uz + 0.0006), 0, 0, rz), beam);
  });
  studs(5, uz * 2, (t, w, h, y, rz = 0) => k.add(new THREE.BoxGeometry(0.0016, h, w), compose(ux1 + 0.0006, y, t, rz, 0, 0), beam));
  // The roof: steep, tiled in the owner's colour, its ridge running out to the front gable, and a chimney.
  k.add(gableWall(uz * 2, UW - 0.002, rise), compose(ucx, u1, 0, 0, Math.PI / 2, 0), plaster);
  k.surface(SURFACE.roof, () => k.add(gable(uz * 2, UW, rise, 0.006, 0.006), compose(ucx, u1 - 0.001, 0, 0, Math.PI / 2, 0), roof));
  k.add(box(UW + 0.016, 0.005, 0.007, 0.0015), compose(ucx, u1 + rise + 0.001, 0), roof.clone().offsetHSL(0, 0, -0.06));
  k.surface(SURFACE.stone, () => k.add(box(0.012, 0.04, 0.012, 0.002), compose(x0 + 0.014, u1 + rise * 0.55, -uz * 0.45), stone));
  // The front gable's timbers, and the emblem board: a diamond of the track's colour, rimmed in gold.
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.0016, 0.0026, Math.hypot(uz, rise) - 0.004), compose(ux1 + 0.0007, u1 + rise / 2, (s * uz) / 2, s * Math.atan2(rise, uz), 0, 0), beam);
  const by = u1 + rise * 0.42;
  k.add(new THREE.BoxGeometry(0.003, 0.03, 0.03), compose(ux1 + 0.0016, by, 0, Math.PI / 4, 0, 0), gold);
  k.add(new THREE.BoxGeometry(0.003, 0.026, 0.026), compose(ux1 + 0.0028, by, 0, Math.PI / 4, 0, 0), field);
  k.add(emblemModel(track), compose(ux1 + 0.006, by, 0, 0, 0, 0, 0.72), WHITE);
  // The door: arched, iron-studded, under a lit fanlight, a lantern either side.
  k.add(box(0.004, 0.022, 0.016, 0.001), compose(x1 + 0.0012, 0.011, 0), shown('#4a3020'));
  k.add(new THREE.CylinderGeometry(0.008, 0.008, 0.004, 12, 1, false, 0, Math.PI), compose(x1 + 0.0012, 0.022, 0, Math.PI / 2, Math.PI / 2, Math.PI / 2), shown('#4a3020'));
  k.lit(() => k.add(new THREE.CylinderGeometry(0.0062, 0.0062, 0.004, 12, 1, false, 0, Math.PI), compose(x1 + 0.0018, 0.0225, 0, Math.PI / 2, Math.PI / 2, Math.PI / 2), glass));
  k.add(new THREE.TorusGeometry(0.0086, 0.0015, 4, 12, Math.PI).rotateY(Math.PI / 2), compose(x1 + 0.0016, 0.022, 0), shown('#d8c8a8'));
  for (const s of [-1, 1]) {
    k.rod(v3(x1 + 0.001, 0.026, s * 0.014), v3(x1 + 0.005, 0.026, s * 0.014), 0.0007, beam, 4);
    lanternAt(k, x1 + 0.005, 0.021, s * 0.014, 0.75);
  }
  // Windows: tall ones in the stone below, and leaded ones in the timbering above, lit at dusk.
  k.lit(() => {
    for (const s of [-1, 1]) for (const x of [-0.016, 0.012]) k.add(new THREE.BoxGeometry(0.009, 0.014, 0.002), compose(x, 0.016, s * (z + 0.0006)), glass);
    for (const s of [-1, 1]) for (const x of [-0.022, 0.0, 0.022]) k.add(new THREE.BoxGeometry(0.008, 0.01, 0.002), compose(x, u0 + upper * 0.5, s * (uz + 0.001)), glass);
  });
  for (const s of [-1, 1]) for (const x of [-0.022, 0.0, 0.022]) k.add(new THREE.BoxGeometry(0.0012, 0.011, 0.0024), compose(x, u0 + upper * 0.5, s * (uz + 0.0012)), beam);
  // The owner's banners, hung from the jetty either side of the board, a band of the track's colour across them.
  for (const s of [-1, 1]) {
    const bz = s * (uz - 0.007), top = u1 - 0.001;
    k.rod(v3(ux1, top, bz), v3(ux1 + 0.008, top, bz), 0.0008, beam, 4);
    k.swaying(top, 0.03, 0.5, () =>
      k.cloth(3, 6, (uu, vv) => v3(ux1 + 0.0065 + Math.sin(vv * 3 + s) * 0.0008, top - 0.001 - vv * (0.028 - 0.004 * Math.abs(2 * uu - 1)), bz - 0.0055 + uu * 0.011), (uu, vv) => (vv > 0.62 && vv < 0.76 ? field : uu < 0.14 || uu > 0.86 ? trim : own)),
    );
  }
  // And on the roof, the track's own mark.
  const ridge = u1 + rise;
  if (track === 'learning') observatory(k, x0 + 0.03, ridge, field, gold);
  else if (track === 'commerce') market(k, ux1, ridge, ucx, field, gold, own, trim);
  else belfry(k, x0 + 0.002, ridge, field, gold, stone);
  return k.build();
}

/** Learning's mark: a drum astride the ridge under a copper dome, its shutter open and a brass telescope out of it. */
function observatory(k: Kit, x: number, ridge: number, field: THREE.Color, gold: THREE.Color) {
  const y = ridge - 0.012;
  const copper = shown('#5f9a8a');
  k.add(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 18), compose(x, y + 0.01, 0), shown('#e2d6bc'));
  k.add(new THREE.CylinderGeometry(0.0172, 0.0172, 0.003, 18), compose(x, y + 0.02, 0), field);
  k.surface(SURFACE.roof, () => k.add(new THREE.SphereGeometry(0.0168, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), compose(x, y + 0.021, 0), copper));
  // The shutter's slit, down the dome's front, and the telescope leaning out of it.
  k.add(new THREE.BoxGeometry(0.004, 0.003, 0.006), compose(x + 0.0115, y + 0.031, 0, 0, 0, -0.8), shown('#1e2228'));
  k.add(new THREE.BoxGeometry(0.0035, 0.003, 0.0055), compose(x + 0.004, y + 0.0372, 0, 0, 0, -0.25), shown('#1e2228'));
  k.rod(v3(x + 0.004, y + 0.027, 0), v3(x + 0.024, y + 0.041, 0), 0.0022, shown('#c89a3a'), 8);
  k.add(smoothSphere(0.0022, 1), compose(x, y + 0.0385, 0), gold);
  k.lit(() => k.add(new THREE.BoxGeometry(0.002, 0.007, 0.006), compose(x + 0.0161, y + 0.01, 0), shown('#ffcf7a')), 1);
}

/**
 * Commerce's mark: an arcade of market stalls along the front under striped awnings, with goods
 * on their boards, and a cupola on the ridge carrying a gilded weathervane.
 */
function market(k: Kit, front: number, ridge: number, ucx: number, field: THREE.Color, gold: THREE.Color, own: THREE.Color, trim: THREE.Color) {
  const cream = shown('#efe6d2'), wood = shown('#6b4a2e');
  const depth = 0.022, z = HALL.z + HALL.jetty;
  for (const zz of [-z + 0.002, -0.009, 0.009, z - 0.002]) k.add(new THREE.BoxGeometry(0.0026, 0.026, 0.0026), compose(front + depth - 0.002, 0.013, zz), wood);
  k.add(new THREE.BoxGeometry(0.003, 0.003, z * 2), compose(front + depth - 0.002, 0.0265, 0), wood);
  // Awnings, sloping out from under the jetty, striped in the track's colour and cream.
  k.swaying(0.03, 0.01, 0.25, () => {
    for (let i = 0; i < 10; i++) {
      const zz = -z + (i + 0.5) * ((2 * z) / 10);
      k.add(new THREE.BoxGeometry(depth + 0.004, 0.0016, (2 * z) / 10 + 0.0002), compose(front + depth / 2, 0.0295, zz, 0, 0, -0.3), i % 2 ? cream : field);
    }
    for (let i = 0; i < 10; i++) k.add(new THREE.ConeGeometry(0.0026, 0.004, 4).rotateX(Math.PI), compose(front + depth + 0.002, 0.0225, -z + (i + 0.5) * ((2 * z) / 10)), i % 2 ? field : cream);
  });
  // Boards and goods: produce, bolts of cloth in the owner's colours, a crate, sacks.
  for (const s of [-1, 1]) {
    k.add(box(0.012, 0.009, 0.016, 0.0012), compose(front + depth - 0.009, 0.0045, s * 0.019), wood);
    const goods = [shown('#d24a3a'), shown('#f0b43a'), shown('#7aa346'), shown('#c78a4a')];
    for (let i = 0; i < 6; i++) k.add(new THREE.IcosahedronGeometry(0.0026, 0), compose(front + depth - 0.012 + (i % 2) * 0.006, 0.0105, s * 0.019 - 0.006 + Math.floor(i / 2) * 0.006), goods[(i + (s > 0 ? 1 : 0)) % 4]);
  }
  for (const [zz, c] of [[-0.004, own], [0.0, trim], [0.004, field]] as const) k.add(new THREE.CylinderGeometry(0.0022, 0.0022, 0.012, 8).rotateX(Math.PI / 2), compose(front + depth - 0.006, 0.006, zz, 0, 0.25, 0), c);
  // The cupola: an open lantern of posts under a gilded cap, and the vane above it.
  const cx = ucx + 0.004, y = ridge - 0.004;
  k.add(box(0.016, 0.008, 0.016, 0.0012), compose(cx, y + 0.004, 0), shown('#e2d6bc'));
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) k.add(new THREE.BoxGeometry(0.0022, 0.012, 0.0022), compose(cx + sx * 0.006, y + 0.014, sz * 0.006), wood);
  k.lit(() => k.add(new THREE.BoxGeometry(0.009, 0.009, 0.009), compose(cx, y + 0.013, 0), shown('#ffcf7a')), 0.8);
  k.surface(SURFACE.roof, () => k.add(new THREE.ConeGeometry(0.0125, 0.014, 4).rotateY(Math.PI / 4), compose(cx, y + 0.027, 0), field));
  k.add(smoothSphere(0.0022, 1), compose(cx, y + 0.0345, 0), gold);
  k.rod(v3(cx, y + 0.034, 0), v3(cx, y + 0.058, 0), 0.0008, gold, 4);
  // The vane: an arrow over the four points, and a cockerel standing on it.
  k.add(new THREE.BoxGeometry(0.022, 0.0016, 0.0012), compose(cx, y + 0.05, 0), gold);
  k.add(new THREE.ConeGeometry(0.0028, 0.006, 4).rotateZ(-Math.PI / 2), compose(cx + 0.013, y + 0.05, 0), gold);
  k.add(new THREE.BoxGeometry(0.004, 0.006, 0.001), compose(cx - 0.011, y + 0.05, 0), gold);
  const bird = smoothSphere(0.0042, 1);
  bird.scale(1.3, 1, 0.45);
  k.add(bird, compose(cx - 0.001, y + 0.0555, 0), gold);
  k.add(new THREE.ConeGeometry(0.0034, 0.008, 4), compose(cx - 0.0065, y + 0.058, 0, 0, 0, 0.9, 1, 1, 0.4), gold);
  k.add(smoothSphere(0.0022, 1), compose(cx + 0.0035, y + 0.0595, 0), gold);
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) k.add(new THREE.BoxGeometry(dx ? 0.009 : 0.0009, 0.0009, dz ? 0.009 : 0.0009), compose(cx + dx * 0.0045, y + 0.044, dz * 0.0045), gold);
}

/**
 * Statecraft's mark: a stone bell tower rising through the hall's back, a clock on its face, an
 * open belfry with its bell, and a spire of the track's colour crowned in gold.
 */
function belfry(k: Kit, x: number, ridge: number, field: THREE.Color, gold: THREE.Color, stone: THREE.Color) {
  const T = 0.03, top = ridge + 0.038;
  k.surface(SURFACE.stone, () => k.add(box(T, top + 0.03, T, 0.002), compose(x, (top - 0.03) / 2, 0), stone));
  k.add(box(T + 0.004, 0.004, T + 0.004, 0.001), compose(x, top, 0), shown('#8c8476'));
  // The belfry: four corner piers, the bell hung between them, a rail round its floor.
  const bh = 0.026;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) k.surface(SURFACE.stone, () => k.add(new THREE.BoxGeometry(0.006, bh, 0.006), compose(x + sx * (T / 2 - 0.003), top + bh / 2, sz * (T / 2 - 0.003)), stone));
  k.add(new THREE.CylinderGeometry(0.0032, 0.0072, 0.011, 12), compose(x, top + bh * 0.48, 0), shown('#b8862e'));
  k.add(new THREE.TorusGeometry(0.0072, 0.0012, 4, 12).rotateX(Math.PI / 2), compose(x, top + bh * 0.48 - 0.0055, 0), shown('#8a6420'));
  k.add(new THREE.BoxGeometry(0.0016, 0.003, T - 0.008), compose(x, top + bh * 0.48 + 0.007, 0), shown('#3e2a1c'));
  k.add(box(T + 0.006, 0.005, T + 0.006, 0.0012), compose(x, top + bh + 0.0025, 0), shown('#8c8476'));
  // The spire, its foot flared like a bell-cast roof, and a crown on its point.
  k.surface(SURFACE.roof, () => k.add(new THREE.ConeGeometry(T * 0.8, 0.06, 4, 3).rotateY(Math.PI / 4), compose(x, top + bh + 0.035, 0), field));
  k.add(smoothSphere(0.0026, 1), compose(x, top + bh + 0.066, 0), gold);
  k.add(new THREE.CylinderGeometry(0.0042, 0.0038, 0.003, 8, 1, true), compose(x, top + bh + 0.0705, 0), gold);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    k.add(new THREE.ConeGeometry(0.0011, 0.0034, 4), compose(x + Math.cos(a) * 0.0038, top + bh + 0.0735, Math.sin(a) * 0.0038), gold);
  }
  // The clock, on the face looking out (+x) above the roof, and a lit slit below it.
  const cy = ridge + 0.016;
  k.add(new THREE.CylinderGeometry(0.0095, 0.0095, 0.002, 18).rotateZ(Math.PI / 2), compose(x + T / 2 + 0.001, cy, 0), gold);
  k.add(new THREE.CylinderGeometry(0.008, 0.008, 0.002, 18).rotateZ(Math.PI / 2), compose(x + T / 2 + 0.0016, cy, 0), shown('#f2ead8'));
  k.add(new THREE.BoxGeometry(0.001, 0.0065, 0.0012), compose(x + T / 2 + 0.0028, cy + 0.0028, 0), shown('#1e1a16'));
  k.add(new THREE.BoxGeometry(0.001, 0.0012, 0.005), compose(x + T / 2 + 0.0028, cy, 0.0022), shown('#1e1a16'));
  k.lit(() => k.add(new THREE.BoxGeometry(0.002, 0.01, 0.004), compose(x + T / 2 + 0.0006, ridge - 0.008, 0), shown('#ffcf7a')));
}

/** Where a foundry's stack breathes out and its furnace glows (model units, see makeFoundry). */
export const FOUNDRY_SMOKE = new THREE.Vector3(0.004, 0.152, -0.045);
/** (Before the furnace's front mouth, over the casting bed.) */
export const FOUNDRY_FIRE = new THREE.Vector3(-0.03, 0.018, 0.026);

/**
 * A foundry beside its city, the island's industrial landmark: a squat stone blast furnace with
 * iron bands and an open throat, charged by a timber bridge from a walled bank at its end, its
 * arched mouths glowing front and back; a thick brick stack corbelled at the crown; a brick casting
 * shed with a louvred ridge; and in front of the furnace a bed of sand where the iron runs out in
 * a glowing comb of pigs. It all stands on a dark apron of cinders, so its light falls on slag and
 * reads as heat (on grass, orange light read lime). Faces: the furnace's mouths look ±z, its bank −x.
 */
export function makeFoundry(): THREE.BufferGeometry {
  const k = new Kit();
  // (Every colour here is chosen as it should look, so it goes through shown().)
  const brick = shown('#9a4a32'), brickDark = shown('#68342a'), soot = shown('#2c2724');
  const sandstone = shown('#aa9a82'), dressed = shown('#c4b498'), iron = shown('#34312e');
  const slate = shown('#4f545c'), timber = shown('#5a3f2a'), earth = shown('#5e4c38');
  const ember = shown('#ff7a26'), flame = shown('#ffb35a');
  // The apron: cinders and slag, rusty and ashen in patches, ragged at its edge.
  const cinder = shown('#2a2421'), rust = shown('#4c3324'), ash = shown('#57514b');
  patch(k, -0.004, 0.002, 0.094, 0.077, 3, (x, _y, z, o) => {
    const n = hash3(Math.floor(x * 90), 0, Math.floor(z * 90));
    o.copy(cinder).lerp(n > 0.72 ? rust : ash, n > 0.72 ? 0.7 : n < 0.22 ? 0.55 : 0);
  });
  k.lit(() => {
    for (let i = 0; i < 14; i++) {
      const a = hash3(i, 7, 1) * Math.PI * 2, r = 0.02 + hash3(i, 3, 9) * 0.05;
      k.add(new THREE.BoxGeometry(0.0022, 0.0012, 0.0022), compose(-0.03 + Math.cos(a) * r, 0.005, 0.03 + Math.sin(a) * r * 0.6, 0, a, 0), ember);
    }
  }, 1.3);

  // The furnace: a truncated stone pyramid on a footing that runs on into the ground, sooted
  // towards its top, girt with iron bands and a dressed string course.
  const FX = -0.03, FZ = 0.006, FOOT = -0.02, TOP = 0.072;
  const hw = (y: number) => 0.026 + (0.0155 - 0.026) * ((y - FOOT) / (TOP - FOOT));
  k.surface(SURFACE.stone, () =>
    k.add(frustum(hw(FOOT), hw(TOP), TOP - FOOT), compose(FX, (TOP + FOOT) / 2, FZ), (_x, y, _z, o) => o.copy(sandstone).lerp(soot, THREE.MathUtils.smoothstep(y, 0.05, TOP) * 0.6)),
  );
  for (const [y, h, c] of [[0.017, 0.004, iron], [0.044, 0.005, dressed], [0.062, 0.0035, iron]] as const) k.add(frustum(hw(y - h / 2) + 0.0012, hw(y + h / 2) + 0.0012, h), compose(FX, y, FZ), c);
  // Its throat: a short open drum of brick on top, fire showing inside it.
  k.add(new THREE.CylinderGeometry(0.0118, 0.0128, 0.013, 12, 1, true), compose(FX, TOP + 0.0055, FZ), brickDark);
  k.add(new THREE.TorusGeometry(0.0122, 0.0015, 4, 12).rotateX(Math.PI / 2), compose(FX, TOP + 0.012, FZ), iron);
  k.lit(() => k.add(new THREE.CircleGeometry(0.0112, 12).rotateX(-Math.PI / 2), compose(FX, TOP + 0.008, FZ), flame), 3);
  // Two arched mouths, front (+z) and back (−z), so one glows whichever way it's seen.
  mouth(k, compose(FX, 0, FZ + hw(0.012) - 0.0004), ember, flame, dressed);
  mouth(k, compose(FX, 0, FZ - hw(0.012) + 0.0004, 0, Math.PI, 0), ember, flame, dressed);

  // The bank at its end, walled in stone with an earth slope behind, and the timber bridge the
  // ore is barrowed up to the throat on.
  const BH = 0.05;
  k.surface(SURFACE.stone, () => k.add(new THREE.BoxGeometry(0.026, BH + 0.03, 0.044), compose(-0.09, (BH - 0.03) / 2, 0), (_x, y, _z, o) => o.copy(y > BH - 0.002 ? earth : C(STONE))));
  const slope = new THREE.Shape();
  slope.moveTo(0, -0.02);
  slope.lineTo(0.024, -0.02);
  slope.lineTo(0, BH);
  slope.closePath();
  k.add(new THREE.ExtrudeGeometry(slope, { depth: 0.044, bevelEnabled: false }), compose(-0.103, 0, 0.022, 0, Math.PI, 0), earth);
  const A = v3(-0.078, BH + 0.001, 0), B = v3(FX - hw(TOP) - 0.001, TOP + 0.002, 0);
  const along = B.clone().sub(A), len = along.length();
  const side = v3(-along.z, 0, along.x).normalize();
  const deck = compose((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2, -Math.atan2(along.y, Math.hypot(along.x, along.z)), Math.atan2(along.x, along.z), 0);
  k.add(new THREE.BoxGeometry(0.015, 0.0025, len + 0.004), deck, timber);
  for (const s of [-1, 1]) {
    const off = side.clone().multiplyScalar(s * 0.0075).setY(0.009);
    k.rod(A.clone().add(off), B.clone().add(off), 0.0009, timber, 4);
    for (const f of [0.15, 0.85]) {
      const p = A.clone().lerp(B, f).addScaledVector(side, s * 0.0075);
      k.rod(p, p.clone().setY(p.y + 0.009), 0.0009, timber, 4);
    }
  }
  const mid = A.clone().lerp(B, 0.5);
  for (const s of [-1, 1]) k.rod(mid.clone().addScaledVector(side, s * 0.006).setY(-0.01), mid.clone().addScaledVector(side, s * 0.006).setY(mid.y - 0.001), 0.0016, timber, 5);

  // The stack: thick, tapering, banded brick on a stone plinth, black at the crown, corbelled out
  // under its lip, and glowing inside it at night.
  const [cx, , cz] = FOUNDRY_SMOKE.toArray();
  const ht = FOUNDRY_SMOKE.y - 0.006;
  k.surface(SURFACE.stone, () => k.add(box(0.034, 0.05, 0.034, 0.002), compose(cx, 0.005, cz), C(STONE)));
  k.add(new THREE.CylinderGeometry(0.0105, 0.0148, ht - 0.03, 14, 6), compose(cx, 0.03 + (ht - 0.03) / 2, cz), (_x, y, _z, o) => o.copy(brick).lerp(soot, THREE.MathUtils.smoothstep(y, ht - 0.045, ht) * 0.85));
  const r = (y: number) => 0.0148 + (0.0105 - 0.0148) * ((y - 0.03) / (ht - 0.03));
  for (const y of [0.075, 0.118]) k.add(new THREE.CylinderGeometry(r(y) + 0.0014, r(y) + 0.0014, 0.0045, 14), compose(cx, y, cz), brickDark);
  k.add(new THREE.CylinderGeometry(r(ht) + 0.0032, r(ht) + 0.0012, 0.006, 14, 1, true), compose(cx, ht - 0.002, cz), soot);
  k.add(new THREE.CylinderGeometry(r(ht) + 0.0032, r(ht) + 0.0032, 0.004, 14, 1, true), compose(cx, ht + 0.003, cz), soot);
  k.add(new THREE.TorusGeometry(r(ht) + 0.0016, 0.0017, 4, 14).rotateX(Math.PI / 2), compose(cx, ht + 0.005, cz), soot);
  k.lit(() => k.add(new THREE.CircleGeometry(r(ht) + 0.001, 14).rotateX(-Math.PI / 2), compose(cx, ht + 0.001, cz), ember), 1.6);

  // The casting shed: brick under one slate gable, ridge along it, a louvred vent on the ridge
  // that glows at night, its great doors open on the furnace's side.
  const SX = 0.038, SZ = -0.002, W = 0.064, D = 0.052, H = 0.036;
  k.surface(SURFACE.stone, () => k.add(new THREE.BoxGeometry(W, H + 0.03, D), compose(SX, (H - 0.03) / 2, SZ), (_x, y, _z, o) => o.copy(y < 0.006 ? brickDark : brick)));
  k.add(gableWall(D, W - 0.002, 0.024), compose(SX, H, SZ, 0, Math.PI / 2, 0), brick);
  k.surface(SURFACE.roof, () => k.add(gable(D, W, 0.026, 0.005, 0.005), compose(SX, H - 0.001, SZ, 0, Math.PI / 2, 0), slate));
  k.lit(() => k.add(new THREE.BoxGeometry(0.03, 0.005, 0.011), compose(SX, H + 0.026, SZ), flame), 0.9);
  for (let i = 0; i < 5; i++) k.add(new THREE.BoxGeometry(0.0022, 0.0055, 0.0125), compose(SX - 0.012 + i * 0.006, H + 0.0262, SZ), iron);
  k.surface(SURFACE.roof, () => k.add(gable(0.014, 0.034, 0.008, 0.002, 0.003), compose(SX, H + 0.028, SZ, 0, Math.PI / 2, 0), slate));
  const front = SZ + D / 2;
  k.add(new THREE.BoxGeometry(0.024, 0.027, 0.002), compose(SX - 0.006, 0.0135, front + 0.0004), soot);
  k.lit(() => k.add(new THREE.BoxGeometry(0.02, 0.023, 0.002), compose(SX - 0.006, 0.0115, front + 0.0008), shown('#ff9a46')), 1.3);
  k.add(new THREE.BoxGeometry(0.028, 0.004, 0.004), compose(SX - 0.006, 0.0285, front + 0.001), timber);
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.0115, 0.025, 0.002), compose(SX - 0.006 + s * (0.012 + Math.cos(1.2) * 0.0058), 0.0125, front + Math.sin(1.2) * 0.0058, 0, s * 1.2, 0), timber);
  k.lit(() => {
    for (const x of [-0.016, 0.014]) k.add(new THREE.BoxGeometry(0.009, 0.011, 0.002), compose(SX + x, 0.021, SZ - D / 2 - 0.0005), shown('#ffb35a'));
    k.add(new THREE.BoxGeometry(0.002, 0.011, 0.012), compose(SX + W / 2 + 0.0005, 0.02, SZ), shown('#ffb35a'));
  }, 1.1);

  // The casting bed in front of the furnace: a runner of molten iron out of the mouth and the
  // pigs either side of it, on a bed of dark sand.
  const z0 = FZ + hw(0) + 0.004, z1 = 0.07;
  k.add(new THREE.BoxGeometry(0.036, 0.006, z1 - z0 + 0.006), compose(FX, 0.003, (z0 + z1) / 2), shown('#4a3c30'));
  k.lit(() => {
    k.add(new THREE.BoxGeometry(0.0036, 0.0016, z1 - z0), compose(FX, 0.0062, (z0 + z1) / 2), ember);
    for (let i = 0; i < 4; i++)
      for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.0125, 0.0013, 0.0028), compose(FX + s * 0.0085, 0.0061, z0 + 0.008 + i * 0.0085), ember.clone().lerp(flame, 0.25));
    // (And a short runner out of the back mouth, into a pig bed of its own.)
    k.add(new THREE.BoxGeometry(0.0034, 0.0014, 0.02), compose(FX, 0.0062, FZ - hw(0) - 0.012), ember);
    for (let i = 0; i < 2; i++) for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.01, 0.0013, 0.0026), compose(FX + s * 0.0075, 0.0061, FZ - hw(0) - 0.01 - i * 0.008), ember.clone().lerp(flame, 0.25));
  }, 2);
  k.add(new THREE.BoxGeometry(0.03, 0.006, 0.026), compose(FX, 0.003, FZ - hw(0) - 0.013), shown('#4a3c30'));

  // Heaps of ore, limestone and coal, and pigs of iron stacked by the shed door.
  const heap = (x: number, z: number, rr: number, c: THREE.Color, s = 0.55) => {
    const g = smoothSphere(rr, 1);
    g.scale(1.15, s, 1);
    k.add(g, compose(x, 0.0015, z), c);
  };
  heap(-0.072, 0.046, 0.013, shown('#7c4632'));
  heap(-0.07, -0.046, 0.009, shown('#bdb4a2'), 0.6);
  heap(0.062, 0.043, 0.013, shown('#1f1d1c'));
  for (let i = 0; i < 6; i++) k.add(new THREE.BoxGeometry(0.012, 0.0035, 0.0045), compose(0.028, 0.002 + Math.floor(i / 3) * 0.0036, 0.04 + (i % 3) * 0.005 - (Math.floor(i / 3) ? 0.0025 : 0), 0, Math.floor(i / 3) ? Math.PI / 2 : 0, 0), shown('#5d5b58'));
  return k.build();
}

/**
 * A furnace mouth in its own frame (the face's outward normal +z, the ground y = 0): a dark arched
 * opening with the fire inside it, framed in dressed stone.
 */
function mouth(k: Kit, at: THREE.Matrix4, ember: THREE.Color, flame: THREE.Color, dressed: THREE.Color) {
  const m = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => at.clone().multiply(compose(x, y, z, rx, ry, rz));
  k.add(new THREE.BoxGeometry(0.0135, 0.013, 0.004), m(0, 0.0065, 0.0008), shown('#141110'));
  k.add(new THREE.CylinderGeometry(0.00675, 0.00675, 0.004, 10, 1, false, 0, Math.PI), m(0, 0.013, 0.0008, Math.PI / 2, 0, Math.PI / 2), shown('#141110'));
  k.lit(() => {
    k.add(new THREE.BoxGeometry(0.0105, 0.012, 0.003), m(0, 0.006, 0.0018), ember);
    k.add(new THREE.CylinderGeometry(0.0052, 0.0052, 0.003, 10, 1, false, 0, Math.PI), m(0, 0.012, 0.0018, Math.PI / 2, 0, Math.PI / 2), flame);
  }, 2.6);
  k.add(new THREE.TorusGeometry(0.0084, 0.0017, 4, 10, Math.PI), m(0, 0.013, 0.0016), dressed);
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.0032, 0.013, 0.0032), m(s * 0.0084, 0.0065, 0.0016), dressed);
}

// ---------------------------------------------------------------------------------------------
// On the edges: bridges over the rivers, and the caravans' wagons.
// ---------------------------------------------------------------------------------------------

// (The bridge's measures and its deck's line are layout.ts's BRIDGE and deckY: the travellers cross it by them.
// The arch spans the river, which crosses the edge at its middle, springing from well below the banks so the
// water runs under it however deep the channel is cut; the deck reaches just past both corners, so it meets
// a road of its seat that runs on to a corner (boardView.joinRoads) with no gap.)

/** A strip following the deck along x, from `lo` to `hi` above it, `d` thick, at z (its middle). */
function deckStrip(lo: number, hi: number, x0: number, x1: number, z: number, d: number) {
  const s = new THREE.Shape();
  const n = 20;
  s.moveTo(x0, deckY(x0) + lo);
  for (let i = 0; i <= n; i++) s.lineTo(x0 + ((x1 - x0) * i) / n, deckY(x0 + ((x1 - x0) * i) / n) + hi);
  for (let i = n; i >= 0; i--) s.lineTo(x0 + ((x1 - x0) * i) / n, deckY(x0 + ((x1 - x0) * i) / n) + lo);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, 0, z - d / 2);
  return g;
}

/**
 * A humpbacked stone bridge along an edge, in place of a road: one arch over the river with its
 * voussoirs picked out, parapets coped in the owner's colour, a deck of flags tinted towards
 * it like the roads' cobbles, and newel posts at the ends, one flying the owner's pennant.
 */
export function makeBridge(color: PlayerColor): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const k = new Kit();
  const { L, W, span, spring, foot } = BRIDGE;
  const rise = span / 2;
  const s = new THREE.Shape();
  s.moveTo(-L / 2, foot);
  for (let i = 0; i <= 28; i++) s.lineTo(-L / 2 + (L * i) / 28, deckY(-L / 2 + (L * i) / 28));
  s.lineTo(L / 2, foot);
  s.lineTo(span / 2, foot);
  for (let j = 0; j <= 16; j++) {
    const a = (Math.PI * j) / 16;
    s.lineTo((span / 2) * Math.cos(a), spring + rise * Math.sin(a));
  }
  s.lineTo(-span / 2, foot);
  s.closePath();
  const body = new THREE.ExtrudeGeometry(s, { depth: W, bevelEnabled: false });
  body.translate(0, 0, -W / 2);
  const stone = C(STONE), flags = C(STONE).lerp(C(pal.base), 0.3);
  k.surface(SURFACE.stone, () => k.add(body, new THREE.Matrix4(), (x, y, _z, o) => o.copy(y > deckY(x) - 0.0015 ? flags : stone)));
  // The voussoirs: a ring of paler stones round the arch, proud of both faces.
  for (const side of [-1, 1])
    for (let j = 0; j <= 10; j++) {
      const a = (Math.PI * j) / 10;
      const r = span / 2 + 0.006;
      k.add(new THREE.BoxGeometry(0.0055, 0.011, 0.002), compose(r * Math.cos(a), spring + (rise + 0.006) * Math.sin(a), side * (W / 2 + 0.0008), 0, 0, a - Math.PI / 2), C(STONE).lerp(C('#f2ead8'), 0.25));
    }
  // A cutwater-like string course under the parapets, the parapets, and their coping.
  const coping = C(pal.base), cap = C(pal.trim);
  for (const side of [-1, 1]) {
    const z = side * (W / 2 - 0.003);
    k.surface(SURFACE.stone, () => k.add(deckStrip(-0.001, 0.013, -L / 2 + 0.012, L / 2 - 0.012, z, 0.0065), new THREE.Matrix4(), stone));
    k.add(deckStrip(0.013, 0.0165, -L / 2 + 0.012, L / 2 - 0.012, z, 0.0085), new THREE.Matrix4(), coping);
    k.add(deckStrip(-0.006, -0.003, -L / 2, L / 2, side * (W / 2 + 0.001), 0.0035), new THREE.Matrix4(), C(STONE_DARK));
    for (const end of [-1, 1]) {
      const x = end * (L / 2 - 0.008);
      k.surface(SURFACE.stone, () => k.add(box(0.012, 0.026, 0.011, 0.0015), compose(x, deckY(x) + 0.008, z), stone));
      k.add(new THREE.CylinderGeometry(0.0, 0.0072, 0.007, 4), compose(x, deckY(x) + 0.0245, z, 0, Math.PI / 4, 0), cap);
    }
  }
  // The owner's pennant on one newel post.
  const px = L / 2 - 0.008, pz = W / 2 - 0.003;
  k.rod(v3(px, deckY(px) + 0.026, pz), v3(px, deckY(px) + 0.06, pz), 0.0011, '#4a3322', 4);
  streamer(k, v3(px - 0.0005, deckY(px) + 0.059, pz), 0.026, 0.009, C(pal.base), C(pal.trim));
  return k.build();
}

/** An ox facing +x, hooves at (x, 0, z): a heavy body, short legs, a lowered head and curving horns. */
function ox(k: Kit, x: number, z: number, coat: string) {
  const body = smoothSphere(0.011, 1);
  body.scale(2.0, 1.05, 0.95);
  k.add(body, compose(x, 0.024, z), coat);
  k.add(smoothSphere(0.009, 1), compose(x + 0.013, 0.027, z), coat);
  for (const [dx, dz] of [[0.013, 0.005], [0.013, -0.005], [-0.014, 0.005], [-0.014, -0.005]]) {
    k.add(new THREE.CylinderGeometry(0.0028, 0.0022, 0.016, 6), compose(x + dx, 0.008, z + dz), coat);
    k.add(new THREE.CylinderGeometry(0.0022, 0.0024, 0.002, 6), compose(x + dx, 0.001, z + dz), '#2a201a');
  }
  const head = smoothSphere(0.0058, 1);
  head.scale(1.5, 1, 1);
  k.add(head, compose(x + 0.025, 0.024, z, 0, 0, -0.5), coat);
  k.add(smoothSphere(0.0036, 1), compose(x + 0.0305, 0.0195, z), C(coat).multiplyScalar(0.7));
  for (const s of [-1, 1]) k.add(new THREE.ConeGeometry(0.0013, 0.009, 5), compose(x + 0.023, 0.031, z + s * 0.0062, s * -1.1, 0, 0.5), '#e6dcc4');
  k.add(new THREE.ConeGeometry(0.0022, 0.012, 5), compose(x - 0.023, 0.02, z, 0, 0, Math.PI - 0.15), coat);
}

/**
 * A caravan's wagon on a land edge: a covered wagon with a canvas tilt over its hoops, a carter
 * on the bench and a yoke of oxen, in the plain browns and creams of a train that is no one's.
 */
export function makeWagon(): THREE.BufferGeometry {
  const k = new Kit();
  const wood = '#8a6440', dark = '#5e4128';
  // Wheels: big at the back, smaller at the front, each a rim, a hub and spokes.
  for (const [x, r] of [[-0.016, 0.011], [0.018, 0.0092]] as const)
    for (const s of [-1, 1]) {
      const m = compose(x, r, s * 0.016, 0, 0, 0);
      k.add(new THREE.TorusGeometry(r - 0.0009, 0.0011, 5, 18), m, '#4f3420');
      k.add(new THREE.CylinderGeometry(0.002, 0.002, 0.004, 8).rotateX(Math.PI / 2), m, '#3a2818');
      for (let i = 0; i < 4; i++) k.add(new THREE.BoxGeometry(0.0007, r * 2 - 0.002, 0.0009), compose(x, r, s * 0.016, 0, 0, (i * Math.PI) / 4), '#6b4a2e');
    }
  k.add(new THREE.CylinderGeometry(0.001, 0.001, 0.034, 5).rotateX(Math.PI / 2), compose(-0.016, 0.011, 0), dark);
  k.add(new THREE.CylinderGeometry(0.001, 0.001, 0.034, 5).rotateX(Math.PI / 2), compose(0.018, 0.0092, 0), dark);
  // Bed and side boards.
  k.add(new THREE.BoxGeometry(0.052, 0.005, 0.026), compose(0, 0.017, 0), wood);
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.05, 0.007, 0.0016), compose(0, 0.023, s * 0.0125), dark);
  // The tilt: canvas over five hoops, closed at the back by a drawn-up flap.
  const tilt = new THREE.CylinderGeometry(0.0145, 0.0145, 0.046, 16, 1, true, 0, Math.PI);
  k.surface(SURFACE.canvas, () => k.add(tilt, compose(-0.002, 0.024, 0, 0, 0, Math.PI / 2), (x, _y, _z, o) => o.set(Math.abs(((x + 0.025) % 0.0115) - 0.0057) < 0.0007 ? '#d8cbb0' : '#efe6d2')));
  for (let i = 0; i < 5; i++) k.add(new THREE.TorusGeometry(0.0147, 0.0007, 4, 14, Math.PI), compose(-0.024 + i * 0.011, 0.024, 0, 0, Math.PI / 2, 0), dark);
  k.add(new THREE.CircleGeometry(0.0143, 14, 0, Math.PI), compose(-0.024, 0.024, 0, 0, -Math.PI / 2, 0), '#d8cbb0');
  k.add(new THREE.CircleGeometry(0.0143, 14, 0, Math.PI), compose(0.0205, 0.024, 0, 0, Math.PI / 2, 0), '#3a2a1e');
  // The carter on the bench, in a hood, reins in hand.
  k.add(new THREE.BoxGeometry(0.006, 0.003, 0.022), compose(0.026, 0.029, 0), dark);
  // (At 0.53 the carter is a warden's size, as tall as everyone else: the wagon is drawn larger.)
  const M = compose(0.026, 0.0305, 0.003, 0, 0, 0, 0.53);
  figure(k, { at: M, body: C('#7a6a4a'), trim: C('#d8cbb0'), legs: '#5a4636', skin: SKIN[1], helm: 'bare', seated: true });
  k.add(new THREE.ConeGeometry(0.0078, 0.009, 8), M.clone().multiply(compose(0.0006, 0.046, 0)), '#6b5a3c');
  // The tongue and a yoke of oxen, one dun and one cream.
  k.rod(v3(0.02, 0.012, 0), v3(0.07, 0.022, 0), 0.0013, dark);
  ox(k, 0.058, 0.0095, '#b88a5a');
  ox(k, 0.058, -0.0095, '#ddd0b4');
  k.add(new THREE.BoxGeometry(0.004, 0.003, 0.036), compose(0.07, 0.034, 0), wood);
  return k.build();
}

/** Where a crack crosses its road, from the road's middle along it (world units). */
export const CRACK_X = 0.1;

/**
 * A road a quake has cracked (Almanac), laid over the road in its frame (world units, along x, as
 * makeRoad builds it: the cobbles' top at 0.026, the kerbs' at 0.03, 0.1 wide): a dark split
 * zigzagging across it and through both kerbs, the cobbles beside it heaved up and loose, a slab
 * tipped on its edge, rubble spilt on the verges, and a trestle barring the way until it's mended.
 * It keeps to one end of the road (at CRACK_X), clear of a wagon standing at its middle, and its
 * trestle short of a walled city's gate.
 */
export function makeCrack(color: PlayerColor): THREE.BufferGeometry {
  const pal = PLAYER_PALETTE[color];
  const k = new Kit();
  // (The cobbles as the road's material paints them, weathered grey tinted towards the owner,
  // stored like the road's own colours; the rest chosen as they should look, through shown().)
  const cobble = C('#a39b8c').lerp(C(pal.light), 0.3), dark = shown('#15110e'), rubble = shown('#8a8378');
  const X = CRACK_X;
  const zs = [-0.054, -0.036, -0.018, 0, 0.018, 0.036, 0.054];
  const xs = zs.map((_, i) => X + [0.004, -0.006, 0.007, -0.003, 0.008, -0.005, 0.003][i]);
  const top = (z: number) => (Math.abs(z) > 0.032 ? 0.0306 : 0.0266);
  for (let i = 0; i + 1 < zs.length; i++) {
    const ax = xs[i], az = zs[i], bx = xs[i + 1], bz = zs[i + 1];
    const len = Math.hypot(bx - ax, bz - az), w = 0.0075 - Math.abs(i - 2.5) * 0.0011;
    k.add(new THREE.BoxGeometry(len + 0.003, 0.0014, w), compose((ax + bx) / 2, top((az + bz) / 2), (az + bz) / 2, 0, -Math.atan2(bz - az, bx - ax), 0), dark);
  }
  // The split down both sides of the bed, and its kerbs pushed apart a little.
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.007, 0.03, 0.002), compose(xs[s < 0 ? 0 : 6], 0.015, s * 0.0505), dark);
  // Heaved cobbles either side of it, tipped every which way.
  for (let i = 0; i < 12; i++) {
    const side = i % 2 ? 1 : -1, z = -0.03 + (i * 0.06) / 11;
    const tint = cobble.clone().multiplyScalar(0.85 + hash3(i, 2, 5) * 0.3);
    k.add(box(0.011, 0.006, 0.009, 0.0015), compose(X + side * (0.011 + hash3(i, 1, 1) * 0.008), 0.0275 + hash3(i, 4, 2) * 0.002, z, (hash3(i, 9, 3) - 0.5) * 1.1, hash3(i, 5, 7) * 3, side * (0.25 + hash3(i, 6, 1) * 0.35)), tint);
  }
  // A slab tipped up on the far side of the split.
  k.add(box(0.024, 0.005, 0.03, 0.0012), compose(X + 0.024, 0.031, -0.008, 0.08, 0.2, 0.32), cobble.clone().multiplyScalar(0.9));
  // Rubble spilt on the verges.
  for (let i = 0; i < 8; i++) {
    const side = i % 2 ? 1 : -1;
    k.add(new THREE.IcosahedronGeometry(0.004 + hash3(i, 3, 3) * 0.003, 0), compose(X - 0.02 + hash3(i, 8, 1) * 0.05, 0.003, side * (0.062 + hash3(i, 2, 9) * 0.014), hash3(i, 1, 4) * 3, hash3(i, 7, 2) * 3, 0), rubble.clone().multiplyScalar(0.85 + hash3(i, 0, 6) * 0.3));
  }
  // The trestle: two splayed legs each end and a rail striped red and white across the road.
  const tx = X + 0.068, red = shown('#b8342a'), white = shown('#eee6d6'), wood = shown('#6b4a2e');
  for (const s of [-1, 1])
    for (const d of [-1, 1]) k.rod(v3(tx + d * 0.012, 0.026, s * 0.034), v3(tx, 0.058, s * 0.034), 0.0016, wood, 5);
  for (let i = 0; i < 6; i++) k.add(new THREE.BoxGeometry(0.004, 0.008, 0.0144), compose(tx, 0.06, -0.036 + i * 0.0144), i % 2 ? white : red);
  return k.build();
}

// ---------------------------------------------------------------------------------------------
// The castle (Invasion): the island's stronghold, on its own hex.
// ---------------------------------------------------------------------------------------------

/** Ivy creeping up the castle's stone from the foot in patches (a paint for its walls and towers). */
function ivied(base: THREE.Color): Paint {
  const leaf = shown('#4b6c2f'), deep = shown('#38532a');
  return (x, y, z, o) => {
    const n = Math.sin(x * 61 + Math.sin(z * 47) * 2) * Math.sin(z * 53 + y * 29 + Math.sin(x * 37));
    const reach = 0.026 + 0.018 * Math.sin(x * 83 + z * 71);
    o.copy(base);
    if (n > 0.3 && y < reach) o.copy(hash3(Math.floor(x * 400), Math.floor(y * 400), Math.floor(z * 400)) > 0.5 ? leaf : deep);
  };
}

/** The bailey's smithy, set against the curtain wall (its frame: x along the wall, +z into the courtyard). */
const SMITHY = compose(0.0389, 0, -0.1334, 0, -Math.PI / 6, 0);
/** Where the castle's forge glows and its chimney smokes (model units, see makeCastle). */
export const CASTLE_FORGE = new THREE.Vector3(-0.008, 0.016, 0.02).applyMatrix4(SMITHY);
export const CASTLE_SMOKE = new THREE.Vector3(-0.008, 0.056, 0.004).applyMatrix4(SMITHY);

/**
 * The castle on its hex, about 0.35 across on the board: a hexagonal curtain wall following the
 * hex, ivied at its foot, a round tower at each corner (flat behind their merlons, but for two low
 * lead cones at the back), a gatehouse (towards +x, which faces the island) with its portcullis
 * half up and a lantern either side, and one dominant square keep: battered at its foot, with
 * pilasters, corbelled turrets at its corners and a tall verdigris roof, flying the castle's own
 * banner (bone and gold with a black lozenge). In the bailey: a hall against the back wall, a
 * well, a smithy whose forge glows through the night, a cart of barrels, hay and a tree on a
 * floor of trodden earth. No player owns it, so nothing on it is a player's colour.
 */
export function makeCastle(): THREE.BufferGeometry {
  const k = new Kit();
  const bone = shown('#ece2cc'), gold = shown('#d8a93a'), sable = shown('#1d1b1d');
  const stone = C(STONE), ivy = ivied(stone);
  const R = 0.165;
  const corner = (i: number) => new THREE.Vector2(Math.cos(((i + 0.5) * Math.PI) / 3) * R, Math.sin(((i + 0.5) * Math.PI) / 3) * R);
  // The bailey's floor: trodden earth, paler along the way from the gate to the keep.
  const earth = shown('#948266'), path = shown('#b3a282');
  k.add(new THREE.CircleGeometry(R - 0.006, 6, Math.PI / 6).rotateX(-Math.PI / 2), compose(0, 0.0025, 0), (x, _y, z, o) => o.copy(earth).lerp(path, Math.abs(z) < 0.02 && x > 0 ? 1 : 0.15 * hash3(Math.floor(x * 120), 0, Math.floor(z * 120))));
  // The curtain wall: six runs, the one facing +x (between corners 5 and 0) broken by the gate.
  const gateHalf = 0.03;
  for (let i = 0; i < 6; i++) {
    const a = corner(i), b = corner((i + 1) % 6);
    if (i === 5) {
      const gl = new THREE.Vector2(R * Math.cos(Math.PI / 6), -gateHalf), gr = new THREE.Vector2(R * Math.cos(Math.PI / 6), gateHalf);
      wallRun(k, a, gl, 0.042, 0.013, 1, STONE);
      wallRun(k, gr, b, 0.042, 0.013, 1, STONE);
    } else wallRun(k, a, b, 0.042, 0.013, -1, ivy);
  }
  for (let i = 0; i < 6; i++) {
    const p = corner(i);
    roundTower(k, p.x, p.y, 0.019, 0.064, i === 2 || i === 3 ? LEAD : null, i === 5 || i === 0 ? STONE : ivy);
    const a = Math.atan2(p.y, p.x);
    slit(k, p.x + Math.cos(a) * 0.0195, 0.04, p.y + Math.sin(a) * 0.0195, a);
  }
  // The gatehouse: two round towers either side of the passage, an arch, the portcullis, a ramp,
  // and a lantern on a bracket either side of the arch.
  const gx = R * Math.cos(Math.PI / 6);
  for (const s of [-1, 1]) {
    roundTower(k, gx + 0.004, s * (gateHalf + 0.006), 0.017, 0.072, null);
    slit(k, gx + 0.021, 0.05, s * (gateHalf + 0.006), 0);
    k.rod(v3(gx + 0.013, 0.036, s * (gateHalf - 0.004)), v3(gx + 0.019, 0.036, s * (gateHalf - 0.004)), 0.0008, '#2a2420', 4);
    lanternAt(k, gx + 0.019, 0.031, s * (gateHalf - 0.004), 0.9);
  }
  k.surface(SURFACE.stone, () => k.add(box(0.022, 0.018, gateHalf * 2 + 0.006, 0.002), compose(gx + 0.002, 0.055, 0), STONE));
  for (let i = 0; i < 5; i++) k.add(new THREE.BoxGeometry(0.008, 0.007, 0.006), compose(gx + 0.009, 0.0675, -0.024 + i * 0.012), STONE_DARK);
  k.add(new THREE.CylinderGeometry(gateHalf, gateHalf, 0.024, 14, 1, false, 0, Math.PI), compose(gx + 0.002, 0.044, 0, Math.PI / 2, Math.PI / 2, Math.PI / 2), '#2a2420');
  k.add(new THREE.BoxGeometry(0.024, 0.044, gateHalf * 2 - 0.002), compose(gx + 0.002, 0.022, 0), '#2a2420');
  for (let i = 0; i < 7; i++) k.add(new THREE.BoxGeometry(0.0016, 0.03, 0.0016), compose(gx + 0.0145, 0.052, -gateHalf + 0.006 + i * 0.008), '#3d3a36');
  for (let i = 0; i < 3; i++) k.add(new THREE.BoxGeometry(0.0016, 0.0016, gateHalf * 2 - 0.004), compose(gx + 0.0145, 0.04 + i * 0.01, 0), '#3d3a36');
  k.add(box(0.04, 0.003, gateHalf * 1.6, 0.001), compose(gx + 0.032, 0.002, 0, 0, 0, -0.08), '#6b4a2e');
  // The keep: one tall square tower over everything, battered at its foot, a pilaster up each
  // face, a string course, battlements, a corbelled turret at each corner, and a verdigris roof.
  const kx = -0.024, kw = 0.074, kh = 0.165;
  k.surface(SURFACE.stone, () => {
    k.add(box(kw, kh + 0.03, kw, 0.003), compose(kx, (kh - 0.03) / 2, 0), stone);
    k.add(frustum(kw / 2 + 0.006, kw / 2 + 0.0005, 0.036), compose(kx, -0.002, 0), STONE_DARK);
  });
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) k.add(box(az ? 0.012 : 0.004, kh - 0.02, ax ? 0.012 : 0.004, 0.001), compose(kx + (ax * (kw + 0.002)) / 2, (kh - 0.02) / 2 + 0.01, (az * (kw + 0.002)) / 2), stone);
  k.add(box(kw + 0.006, 0.005, kw + 0.006, 0.0012), compose(kx, 0.1, 0), STONE_DARK);
  k.add(box(kw + 0.008, 0.007, kw + 0.008, 0.0015), compose(kx, kh + 0.002, 0), STONE_DARK);
  for (let i = 0; i < 6; i++)
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const f = -kw / 2 + 0.012 + (i * (kw - 0.024)) / 5;
      k.add(new THREE.BoxGeometry(az ? 0.007 : 0.004, 0.008, ax ? 0.007 : 0.004), compose(kx + (ax ? (ax * (kw + 0.004)) / 2 : f), kh + 0.0095, az ? (az * (kw + 0.004)) / 2 : f), STONE_DARK);
    }
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const tx = kx + (sx * kw) / 2, tz = (sz * kw) / 2;
    k.add(new THREE.ConeGeometry(0.0115, 0.016, 12).rotateX(Math.PI), compose(tx, kh - 0.024, tz), STONE_DARK);
    k.surface(SURFACE.stone, () => k.add(new THREE.CylinderGeometry(0.0115, 0.0115, 0.03, 12), compose(tx, kh - 0.001, tz), stone));
    k.surface(SURFACE.roof, () => k.add(new THREE.ConeGeometry(0.0145, 0.03, 12, 2), compose(tx, kh + 0.029, tz), VERDIGRIS));
  }
  k.surface(SURFACE.roof, () => k.add(new THREE.ConeGeometry((kw / 2) * Math.SQRT2 * 0.9, 0.078, 4, 3).rotateY(Math.PI / 4), compose(kx, kh + 0.045, 0), VERDIGRIS));
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
    for (const y of [0.05, 0.085, 0.13]) {
      const a = Math.atan2(az, ax), off = y === 0.085 ? 0 : 0.016;
      for (const s of y === 0.085 ? [0] : [-1, 1]) k.lit(() => k.add(new THREE.BoxGeometry(0.002, 0.012, 0.006), compose(kx + ax * (kw / 2 + 0.0006) - az * s * off, y, az * (kw / 2 + 0.0006) + ax * s * off, 0, -a, 0), '#ffcf7a'));
    }
  k.add(box(0.016, 0.026, 0.004, 0.001), compose(kx + kw / 2 + 0.001, 0.013, 0), '#3b2616');
  k.add(box(0.022, 0.004, 0.02, 0.001), compose(kx + kw / 2 + 0.008, 0.002, 0), STONE_DARK);
  // The keep's banner, from a pole on the roof's point: bone, bordered and banded in gold, a black lozenge on it.
  const pole = kh + 0.084, top = pole + 0.07;
  k.rod(v3(kx, pole, 0), v3(kx, top, 0), 0.0022, '#3d2b1c', 6);
  k.add(smoothSphere(0.0032, 1), compose(kx, top + 0.003, 0), gold);
  k.swaying(kx, 0.06, 1, () =>
    k.cloth(10, 6, (u, v) => v3(kx - 0.002 - u * 0.062, top - 0.004 - v * 0.04 * (1 - 0.2 * u), Math.sin(u * 4 + v) * 0.003), (u, v) => (v < 0.1 || v > 0.9 || u > 0.93 ? gold : Math.abs(u - 0.46) * 2.4 + Math.abs(v - 0.5) < 0.3 ? sable : bone)), 'x');
  // Pennants on the gate towers, bone and gold.
  for (const s of [-1, 1]) {
    const y = 0.072 + 0.012;
    k.rod(v3(gx + 0.004, y - 0.004, s * (gateHalf + 0.006)), v3(gx + 0.004, y + 0.03, s * (gateHalf + 0.006)), 0.0011, '#3d2b1c', 4);
    streamer(k, v3(gx + 0.0035, y + 0.029, s * (gateHalf + 0.006)), 0.03, 0.01, bone, gold);
  }
  // In the bailey: a hall against the back wall under lead, lit windows, a chimney.
  k.surface(SURFACE.stone, () => k.add(box(0.04, 0.03, 0.08, 0.002), compose(-0.105, 0.015, 0), C(STONE).lerp(C('#c8b89a'), 0.3)));
  k.surface(SURFACE.roof, () => k.add(gable(0.04, 0.08, 0.026, 0.006, 0.006), compose(-0.105, 0.029, 0), LEAD));
  k.surface(SURFACE.stone, () => k.add(box(0.01, 0.03, 0.01, 0.0015), compose(-0.112, 0.05, 0.025), STONE));
  for (const z of [-0.025, 0, 0.025]) k.lit(() => k.add(new THREE.BoxGeometry(0.002, 0.01, 0.006), compose(-0.0845, 0.016, z), '#ffcf7a'));
  // The well, under a little roof on two posts.
  k.surface(SURFACE.stone, () => k.add(new THREE.CylinderGeometry(0.008, 0.0085, 0.009, 12, 1, true), compose(0.06, 0.0045, 0.06), STONE));
  k.add(new THREE.CircleGeometry(0.0072, 12).rotateX(-Math.PI / 2), compose(0.06, 0.007, 0.06), '#1e2a33');
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.0018, 0.022, 0.0018), compose(0.06 + s * 0.0075, 0.012, 0.06), '#4a3322');
  k.add(gable(0.018, 0.012, 0.007, 0.002, 0.002), compose(0.06, 0.022, 0.06, 0, Math.PI / 2, 0), LEAD);
  // The smithy against the wall: a lean-to of shingles on two posts over a forge glowing on its
  // hearth, its hood and chimney up through the roof, an anvil and a trough before it.
  const sm = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => SMITHY.clone().multiply(compose(x, y, z, rx, ry, rz));
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.0026, 0.028, 0.0026), sm(s * 0.022, 0.014, 0.028), '#4a3322');
  k.surface(SURFACE.roof, () => k.add(new THREE.BoxGeometry(0.052, 0.003, 0.036), sm(0, 0.033, 0.016, 0.3, 0, 0), shown('#6a5a4a')));
  k.surface(SURFACE.stone, () => k.add(box(0.018, 0.012, 0.013, 0.0015), sm(-0.008, 0.006, 0.009), STONE_DARK));
  k.lit(() => k.add(new THREE.BoxGeometry(0.012, 0.002, 0.008), sm(-0.008, 0.0125, 0.01), shown('#ff7a26')), 2.4);
  k.surface(SURFACE.stone, () => k.add(box(0.009, 0.042, 0.009, 0.0012), sm(-0.008, 0.033, 0.004), STONE_DARK));
  k.add(new THREE.BoxGeometry(0.008, 0.005, 0.004), sm(0.01, 0.006, 0.018), '#2e2c2a');
  k.add(new THREE.BoxGeometry(0.004, 0.004, 0.004), sm(0.01, 0.002, 0.018), '#2e2c2a');
  k.add(box(0.014, 0.006, 0.007, 0.001), sm(0.0, 0.003, 0.03), '#5a4028');
  k.add(new THREE.BoxGeometry(0.012, 0.0008, 0.005), sm(0.0, 0.006, 0.03), shown('#3a5a6a'));
  // A cart of barrels by the way in, a stack of hay, and a tree in the corner of the yard.
  const cart = compose(0.085, 0, -0.052, 0, 0.5, 0);
  const ct = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => cart.clone().multiply(compose(x, y, z, rx, ry, rz));
  k.add(box(0.03, 0.003, 0.016, 0.001), ct(0, 0.011, 0), '#7a5a3a');
  for (const s of [-1, 1]) k.add(new THREE.TorusGeometry(0.0075, 0.0012, 4, 12), ct(-0.004, 0.0075, s * 0.0095), '#3d2a1c');
  k.rod(v3(0.015, 0.011, 0).applyMatrix4(cart), v3(0.035, 0.004, 0).applyMatrix4(cart), 0.001, '#4a3322');
  for (const [x, z] of [[-0.008, -0.004], [0.004, 0.004], [-0.006, 0.005]]) {
    const p = v3(x, 0.0125, z).applyMatrix4(cart);
    barrel(k, p.x, p.y, p.z, 0.0042, 0.009);
  }
  for (const [x, z] of [[0.1, -0.03], [0.108, -0.022]]) barrel(k, x, 0, z, 0.0055, 0.011);
  const hay = smoothSphere(0.012, 1);
  hay.scale(1.2, 0.75, 1);
  k.add(hay, compose(0.03, 0.006, 0.108), shown('#c8a04a'));
  k.add(new THREE.CylinderGeometry(0.002, 0.0028, 0.03, 6), compose(-0.05, 0.015, 0.097), '#5a4028');
  for (const [dx, dy, dz, r] of [[0, 0.036, 0, 0.014], [0.008, 0.03, 0.006, 0.01], [-0.007, 0.042, -0.004, 0.009]]) k.add(smoothSphere(r, 1), compose(-0.05 + dx, dy, 0.097 + dz), shown('#557a34'));
  return k.build();
}
