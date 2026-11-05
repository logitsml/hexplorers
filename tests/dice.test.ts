import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { landingTurn, simulate } from '../src/render/fx/dice3d';

/** How far any corner of die a reaches inside die b (die sizes; 0 if none). */
function overlap(a: { x: THREE.Vector3; q: THREE.Quaternion }, b: { x: THREE.Vector3; q: THREE.Quaternion }) {
  const inv = b.q.clone().invert();
  let worst = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const l = new THREE.Vector3(sx, sy, sz).multiplyScalar(0.47).applyQuaternion(a.q).add(a.x).sub(b.x).applyQuaternion(inv);
    const d = Math.min(0.47 - Math.abs(l.x), 0.47 - Math.abs(l.y), 0.47 - Math.abs(l.z));
    worst = Math.max(worst, d);
  }
  return worst;
}

describe('dice in the water', () => {
  const throws = Array.from({ length: 40 }, () => simulate(new THREE.Vector2(-0.3, 1).normalize()));

  it('never pass through each other', () => {
    let worst = 0;
    for (const t of throws) for (let f = 0; f < t.frames[0].length; f++) worst = Math.max(worst, overlap(t.frames[0][f], t.frames[1][f]), overlap(t.frames[1][f], t.frames[0][f]));
    // (Contacts resolve within a substep; a frame may catch a corner a hair inside.)
    expect(worst).toBeLessThan(0.06);
  });

  it('splash as they go in, and plunge but not too deep', () => {
    for (const t of throws) {
      expect(t.splashes.length).toBeGreaterThanOrEqual(2);
      const deepest = Math.min(...t.frames.flat().map((f) => f.x.y));
      expect(deepest).toBeLessThan(0.05);
      expect(deepest).toBeGreaterThan(-2);
    }
  });

  it('come to rest face up, afloat at their waterline', () => {
    for (const t of throws) {
      for (const fr of t.frames) {
        const end = fr[fr.length - 1];
        expect(end.x.y).toBeCloseTo(0.06, 5);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(end.q.clone().invert());
        expect(Math.max(Math.abs(up.x), Math.abs(up.y), Math.abs(up.z))).toBeCloseTo(1, 4);
      }
    }
  });
});

/** A reproducible visual seed; the engine's RNG is never consumed by a throw. */
function randomOf(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

describe('three dice thrown together', () => {
  const throws = Array.from({ length: 120 }, (_, i) => simulate(new THREE.Vector2(-0.3, 1).normalize(), 3, randomOf(i + 1)));

  it('keeps every pair clear during the flight and settling', () => {
    let worst = 0;
    for (const t of throws) for (let f = 0; f < t.frames[0].length; f++) {
      for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
        worst = Math.max(worst, overlap(t.frames[a][f], t.frames[b][f]), overlap(t.frames[b][f], t.frames[a][f]));
      }
    }
    expect(worst).toBeLessThan(0.06);
  });

  it('lands all three flat and apart, with all rolled faces pointing up', () => {
    const normals = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
    for (const t of throws) {
      expect(t.frames).toHaveLength(3);
      expect(t.splashes.length).toBeGreaterThanOrEqual(3);
      const ends = t.frames.map((fr) => fr[fr.length - 1]);
      for (const end of ends) {
        expect(end.x.y).toBeCloseTo(0.06, 5);
        // This is the same turn applied to the face atlas inside the physical cube. Check every
        // possible numeral, hence also each of the event atlas's six face addresses.
        for (const value of [1, 2, 3, 4, 5, 6]) {
          const normal = normals[[3, 4, 1, 6, 2, 5].indexOf(value)];
          const up = normal.clone().applyQuaternion(landingTurn(end.q, value)).applyQuaternion(end.q);
          expect(up.y).toBeCloseTo(1, 5);
        }
      }
      for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) expect(ends[a].x.distanceTo(ends[b].x)).toBeGreaterThan(1.45);
    }
  });

  it('reproduces the same throw from the same visual seed', () => {
    const dir = new THREE.Vector2(0, 1);
    expect(simulate(dir, 3, randomOf(42))).toEqual(simulate(dir, 3, randomOf(42)));
  });
});


describe('a card pair with separate red and event dice', () => {
  it('lands all four flat, clear of one another', () => {
    let worst = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const t = simulate(new THREE.Vector2(-0.3, 1).normalize(), 4, randomOf(seed));
      expect(t.frames).toHaveLength(4);
      for (let f = 0; f < t.frames[0].length; f++) for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
        worst = Math.max(worst, overlap(t.frames[a][f], t.frames[b][f]), overlap(t.frames[b][f], t.frames[a][f]));
      }
      const ends = t.frames.map((fr) => fr[fr.length - 1]);
      for (const end of ends) {
        expect(end.x.y).toBeCloseTo(0.06, 5);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(end.q.clone().invert());
        expect(Math.max(Math.abs(up.x), Math.abs(up.y), Math.abs(up.z))).toBeCloseTo(1, 4);
      }
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) expect(ends[a].x.distanceTo(ends[b].x)).toBeGreaterThan(1.45);
    }
    expect(worst).toBeLessThan(0.06);
  });
});
