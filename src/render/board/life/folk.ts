// The people of the expansions' looks (the prospectors, the fisher, the caravan's drovers), built
// like the classic miner: a few primitives, coloured on the vertices, 0.0332 to the top of the head
// before FOLK_SCALE. The arm is its own geometry, pivoting at the shoulder, so it can swing a pick,
// rock a cradle or pull an oar.

import * as THREE from 'three/webgpu';
import { MeshBuilder, compose, smoothSphere } from '../geom';

const C = (h: string) => new THREE.Color(h);

/**
 * How tall a person stands on the island, to the top of the head (world units): the travellers
 * on the roads, the wardens, raiders and the trader, and every worker on the land. One height for
 * all of them, so nobody is a head shorter for the hex they work on.
 */
export const HUMAN_HEIGHT = 0.083;

/** The land's workers' model (this file's, and the miners' and the clay diggers' built alike) to the top of the head. */
const FOLK_HEAD_TOP = 0.0332;

/** The scale a worker built on this model is placed at, so they stand HUMAN_HEIGHT tall. */
export const FOLK_SCALE = HUMAN_HEIGHT / FOLK_HEAD_TOP;

export interface FolkLook {
  coat: string;
  legs?: string;
  skin?: string;
  hat?: 'brim' | 'cap' | 'wrap' | 'none';
  hatColor?: string;
  /** A long robe to the ground instead of legs (the drovers). */
  robe?: boolean;
  /** Kneeling (the panner at the pond's edge). */
  kneel?: boolean;
}

/** A standing (or kneeling) figure facing +x, feet at the origin. */
export function makeFolk(o: FolkLook): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const skin = C(o.skin ?? '#e2b48c');
  const k = o.kneel ? 0.62 : 1;
  if (o.robe) {
    const robe = new THREE.CylinderGeometry(0.0045, 0.0075, 0.024, 8);
    b.addGeometry(robe, compose(0, 0.012, 0), C(o.coat));
    robe.dispose();
  } else {
    const legs = new THREE.CylinderGeometry(0.0035, 0.004, 0.012 * k, 6);
    b.addGeometry(legs, compose(o.kneel ? 0.002 : 0, 0.006 * k, 0, 0, 0, o.kneel ? 0.5 : 0), C(o.legs ?? '#3e3a44'));
    legs.dispose();
    const body = new THREE.CylinderGeometry(0.0045, 0.0055, 0.013, 8);
    b.addGeometry(body, compose(0, 0.012 * k + 0.0065, 0), C(o.coat));
    body.dispose();
  }
  const top = (o.robe ? 0.024 : 0.012 * k + 0.013) + 0.004;
  const head = smoothSphere(0.0042, 1);
  b.addGeometry(head, compose(0, top, 0), skin);
  head.dispose();
  const hat = C(o.hatColor ?? '#5a4a36');
  if (o.hat === 'brim') {
    const brim = new THREE.CylinderGeometry(0.0085, 0.0085, 0.0012, 12);
    b.addGeometry(brim, compose(0, top + 0.0032, 0), hat);
    brim.dispose();
    const crown = new THREE.CylinderGeometry(0.0034, 0.0042, 0.0048, 10);
    b.addGeometry(crown, compose(0, top + 0.0055, 0), hat);
    crown.dispose();
  } else if (o.hat === 'cap') {
    const cap = new THREE.CylinderGeometry(0.0046, 0.0052, 0.003, 8);
    b.addGeometry(cap, compose(0, top + 0.0035, 0), hat);
    cap.dispose();
  } else if (o.hat === 'wrap') {
    const wrap = smoothSphere(0.0052, 1);
    wrap.scale(1, 0.75, 1);
    b.addGeometry(wrap, compose(-0.0004, top + 0.0022, 0), hat);
    wrap.dispose();
  }
  return b.build(false);
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A plank, post or log from `a` to `b` (a box w by d across, or a cylinder of radius w when d is
 * omitted), for props laid along a slope: a sluice's boards, a jetty's piles, a tent's poles.
 */
export function rod(mb: MeshBuilder, a: THREE.Vector3, b: THREE.Vector3, w: number, color: THREE.Color | ((x: number, y: number, z: number, out: THREE.Color) => void), d?: number, roll: number | 'flat' = 0) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  // 'flat': a board lying flat, its width level across the run and its thickness upright (the
  // turn from +y onto the run is about a level axis, so the box is first turned to lie along it).
  const turn = roll === 'flat' ? Math.atan2(dir.x, dir.z) : roll;
  dir.divideScalar(len || 1);
  const g = d === undefined ? new THREE.CylinderGeometry(w, w, len, 6) : new THREE.BoxGeometry(w, len, d);
  if (turn) g.rotateY(turn);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  mb.addGeometry(g, m, color);
  g.dispose();
}

/** Where the arm hangs from on a figure (local, before scale). */
export function shoulder(o: FolkLook) {
  const k = o.kneel ? 0.62 : 1;
  return new THREE.Vector3(0.001, o.robe ? 0.02 : 0.012 * k + 0.011, 0.0055);
}

/**
 * An arm hanging from the shoulder (pointing down -y from the origin) holding a tool: rotate it
 * about z to swing it forward (+x) and up.
 */
export function makeArm(tool: 'pick' | 'pan' | 'shovel' | 'oar' | 'none', coat: string, skin = '#e2b48c'): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const sleeve = new THREE.CylinderGeometry(0.0016, 0.0018, 0.011, 5);
  b.addGeometry(sleeve, compose(0, -0.0055, 0), C(coat));
  sleeve.dispose();
  const hand = smoothSphere(0.0017, 0);
  b.addGeometry(hand, compose(0, -0.0115, 0), C(skin));
  hand.dispose();
  const wood = C('#7c5a3a'), iron = C('#55504c');
  if (tool === 'pick' || tool === 'shovel') {
    const handle = new THREE.BoxGeometry(0.0014, 0.018, 0.0014);
    b.addGeometry(handle, compose(0.006, -0.012, 0, 0, 0, Math.PI / 2), wood);
    handle.dispose();
    const head = tool === 'pick' ? new THREE.BoxGeometry(0.0016, 0.011, 0.0018) : new THREE.BoxGeometry(0.0055, 0.006, 0.0008);
    b.addGeometry(head, compose(0.0145, -0.012, 0, 0, tool === 'shovel' ? Math.PI / 2 : 0, 0), iron);
    head.dispose();
  } else if (tool === 'pan') {
    const pan = new THREE.CylinderGeometry(0.0062, 0.0042, 0.0018, 12, 1, true);
    b.addGeometry(pan, compose(0.004, -0.0125, 0), C('#4a4642'));
    pan.dispose();
    const floor = new THREE.CircleGeometry(0.0042, 12);
    b.addGeometry(floor, compose(0.004, -0.0133, 0, -Math.PI / 2, 0, 0), C('#5a544c'));
    floor.dispose();
  } else if (tool === 'oar') {
    const loom = new THREE.BoxGeometry(0.0012, 0.03, 0.0012);
    b.addGeometry(loom, compose(0.012, -0.012, 0, 0, 0, Math.PI / 2 - 0.25), wood);
    loom.dispose();
    const blade = new THREE.BoxGeometry(0.0045, 0.009, 0.0007);
    b.addGeometry(blade, compose(0.027, -0.016, 0, 0, Math.PI / 2, Math.PI / 2 - 0.25), wood);
    blade.dispose();
  }
  return b.build(false);
}
