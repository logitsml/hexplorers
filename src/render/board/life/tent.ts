// A ridge tent for the expansions' camps (the bounty field's prospectors, the oasis's drovers):
// striped canvas over a ridge pole, its door flaps tied back, guy-ropes pegged out at each end
// and corner, a rug on the floor and a lantern hung from the ridge. The inside is drawn as sunlit
// canvas (light comes through it), with its normals turned up to the sky, so the open front
// reads as a warm, lived-in room rather than a black hole; at night the lantern (drawn by the
// caller in the campfire's material, with a lamp) lights it.

import * as THREE from 'three/webgpu';
import type { MeshBuilder } from '../geom';
import { compose } from '../geom';
import { SURFACE } from '../surfaces';
import { rod } from './folk';

const C = (h: string) => new THREE.Color(h);

interface TentLook {
  /** The canvas's two stripe colours (the same twice for a plain tent). */
  stripes: [string, string];
  /** How many stripes run down each slope, front to back. */
  bands: number;
  /** The canvas inside, lit through (a warm, paler tone of the outside). */
  inside: string;
  /** The floor rug's two colours. */
  rug: [string, string];
  pole: string;
  rope: string;
}

export const PROSPECTOR_TENT: TentLook = {
  stripes: ['#e4dcc6', '#cfc2a2'],
  bands: 3,
  inside: '#f4e6c4',
  rug: ['#8a3a2a', '#c99a3a'],
  pole: '#6a4a2e',
  rope: '#cdbb94',
};

export const DROVER_TENT: TentLook = {
  stripes: ['#ece2cf', '#b8462f'],
  bands: 7,
  inside: '#f6dcb4',
  rug: ['#a8382a', '#d0a040'],
  pole: '#6a4a2e',
  rope: '#d8c8a4',
};

/**
 * Builds a tent into `b`, standing at (x, z) on the ground height `ground` gives, its door facing
 * `a` (radians, about +y from +x), `len` long along its ridge, `wide` across and `high` at the
 * ridge. Returns where the lantern hangs (for the caller's flame and lamp), in the same frame.
 */
export function buildTent(
  b: MeshBuilder,
  x: number,
  z: number,
  a: number,
  ground: (x: number, z: number) => number,
  look: TentLook,
  len = 0.15,
  wide = 0.11,
  high = 0.085,
): THREE.Vector3 {
  const y0 = ground(x, z);
  const fwd = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  /** u along the ridge (-1 back .. 1 front), v across (-1..1), y up from the ground at the centre. */
  const P = (u: number, v: number, y: number) => new THREE.Vector3(x, y0 + y, z).addScaledVector(fwd, (u * len) / 2).addScaledVector(side, (v * wide) / 2);
  // A low wall under each eave, so the slopes meet the ground at a pitch a tent has.
  const eave = high * 0.18;
  const sag = (u: number) => -0.004 * (1 - u * u) * (1 - Math.abs(u) * 0.2);
  const stripe = [C(look.stripes[0]), C(look.stripes[1])];
  const inside = C(look.inside);
  b.surfaceId = SURFACE.canvas;
  // The two slopes, ridge to eave, and the walls below them: outside, then the lit inside.
  for (const sd of [-1, 1]) {
    const nOut = new THREE.Vector3().addScaledVector(side, sd * high).addScaledVector(new THREE.Vector3(0, 1, 0), wide / 2).normalize();
    const nIn = new THREE.Vector3(0, 1, 0).addScaledVector(side, -sd * 0.35).normalize();
    for (let k = 0; k < look.bands; k++) {
      const u0 = (k / look.bands) * 2 - 1, u1 = ((k + 1) / look.bands) * 2 - 1;
      const col = stripe[k % 2];
      const quad = (pts: THREE.Vector3[], n: THREE.Vector3, c: THREE.Color, flip: boolean) => {
        const ids = pts.map((p) => b.vertex(p.x, p.y, p.z, c, n.x, n.y, n.z));
        if (flip) b.quad(ids[3], ids[2], ids[1], ids[0]);
        else b.quad(ids[0], ids[1], ids[2], ids[3]);
      };
      const roof = [P(u0, 0, high + sag(u0)), P(u1, 0, high + sag(u1)), P(u1, sd, eave), P(u0, sd, eave)];
      const wall = [P(u0, sd, eave), P(u1, sd, eave), P(u1, sd * 1.02, -0.003), P(u0, sd * 1.02, -0.003)];
      // (Wound so the outside faces out on either slope.)
      const out = sd > 0;
      quad(roof, nOut, col, out);
      quad(wall, new THREE.Vector3().addScaledVector(side, sd), col.clone().multiplyScalar(0.9), out);
      // The inside: a touch inset, paler where the sun comes through the pale stripes.
      const inset = (p: THREE.Vector3) => p.clone().addScaledVector(side, -sd * 0.0012).setY(p.y - 0.001);
      const ic = inside.clone().multiplyScalar(k % 2 ? 0.86 : 1);
      quad(roof.map(inset), nIn, ic, !out);
      quad(wall.map(inset), nIn, ic.clone().multiplyScalar(0.92), !out);
    }
  }
  // The back: a gable closing the ridge's far end (outside and in).
  {
    const back = [P(-1, -1.02, -0.003), P(-1, -1, eave), P(-1, 0, high + sag(-1)), P(-1, 1, eave), P(-1, 1.02, -0.003)];
    const nb = fwd.clone().negate();
    const col = stripe[0].clone().multiplyScalar(0.92);
    const o = back.map((p) => b.vertex(p.x, p.y, p.z, col, nb.x, nb.y, nb.z));
    b.tri(o[0], o[4], o[1]);
    b.tri(o[1], o[4], o[3]);
    b.tri(o[1], o[3], o[2]);
    const ni = new THREE.Vector3(0, 1, 0).addScaledVector(fwd, 0.4).normalize();
    const i = back.map((p) => {
      const q = p.clone().addScaledVector(fwd, 0.0012);
      return b.vertex(q.x, q.y, q.z, inside.clone().multiplyScalar(0.9), ni.x, ni.y, ni.z);
    });
    b.tri(i[0], i[1], i[4]);
    b.tri(i[1], i[3], i[4]);
    b.tri(i[1], i[2], i[3]);
  }
  // The door flaps, tied back against the front of each slope: a triangle of canvas, folded.
  for (const sd of [-1, 1]) {
    const top = P(1.02, 0, high * 0.96), foot = P(1.04, sd * 1.06, -0.002), tie = P(0.55, sd * 1.12, eave * 1.6);
    const n = new THREE.Vector3().addScaledVector(side, sd).addScaledVector(fwd, 0.6).normalize();
    const col = stripe[1].clone().multiplyScalar(0.95);
    const ids = [top, foot, tie].map((p) => b.vertex(p.x, p.y, p.z, col, n.x, n.y, n.z));
    if (sd > 0) b.tri(ids[0], ids[2], ids[1]);
    else b.tri(ids[0], ids[1], ids[2]);
    const back = [top, foot, tie].map((p) => b.vertex(p.x, p.y, p.z, inside, -n.x, -n.y, -n.z));
    if (sd > 0) b.tri(back[0], back[1], back[2]);
    else b.tri(back[0], back[2], back[1]);
  }
  b.surfaceId = 0;
  // The rug, laid on the floor and out over the threshold.
  const rug = new THREE.PlaneGeometry(len * 0.8, wide * 0.7);
  const rp = P(0.15, 0, 0.0015);
  const [r0, r1] = [C(look.rug[0]), C(look.rug[1])];
  b.addGeometry(rug, compose(rp.x, rp.y, rp.z, -Math.PI / 2, -a, 0), (px, _py, pz, o) => o.copy(Math.abs(Math.sin(px * 150) + Math.cos(pz * 130)) > 1.05 ? r1 : r0));
  rug.dispose();
  // Poles at each end and the ridge pole between them, standing a little proud.
  const pole = C(look.pole);
  for (const u of [-1, 1]) rod(b, P(u * 1.02, 0, -0.004), P(u * 1.02, 0, high + 0.012), 0.0024, pole);
  rod(b, P(-1.06, 0, high + 0.002), P(1.06, 0, high + 0.002), 0.0018, pole);
  // Guy-ropes: one out from each pole's head along the ridge, and one from each eave corner.
  const rope = C(look.rope);
  const peg = (p: THREE.Vector3) => rod(b, p.clone().setY(p.y - 0.004), p.clone().setY(p.y + 0.008), 0.0016, pole);
  const pegAt = (u: number, v: number) => {
    const p = P(u, v, 0);
    p.y = ground(p.x, p.z);
    return p;
  };
  for (const u of [-1, 1]) {
    const head = P(u * 1.02, 0, high + 0.01), g = pegAt(u * 1.75, 0);
    rod(b, head, g, 0.0007, rope);
    peg(g);
  }
  for (const u of [-1, 1])
    for (const v of [-1, 1]) {
      const corner = P(u * 0.92, v, eave), g = pegAt(u * 1.3, v * 1.9);
      rod(b, corner, g, 0.0006, rope);
      peg(g);
    }
  // The lantern's hook: hanging from the ridge just inside the door.
  return P(0.45, 0, high * 0.62);
}
