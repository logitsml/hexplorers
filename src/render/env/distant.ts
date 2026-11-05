// Scenery beyond the island: sea stacks, rocky islets and hazy islands on the
// horizon, a lighthouse on a rocky islet with a sweeping beam, sailing ships on
// slow courses and the occasional whale surfacing with a spout.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { keepNormals } from '../util/mrt';
import { Fn, uniform, vec3, vec4, float, smoothstep, positionLocal, positionWorld, positionGeometry, normalGeometry, attribute, vertexColor, cameraPosition } from 'three/tsl';
import { Noise, Rand } from '../util/noise';
import { MeshBuilder, compose, displace, smoothSphere } from '../board/geom';
import { SEA_LEVEL } from '../board/layout';
import { landMaterial, rangeMaterial } from './landmass';
import { planScenery, type SceneryPlan } from './distantShapes';
import { detailNormals } from './oceanDetail';
import { unpack } from '../board/terrainPack';
import { startScenery } from './sceneryJob';
import { waterBurst, type ParticleSystem } from '../fx/particles';
import { lampColor, lampLevel } from '../fx/lamps';
import { SURFACE, lighthouseBands, surfaceShade, worldScale } from '../board/surfaces';
import type { LampLights } from '../fx/lampLights';

const LIGHTHOUSE = lampColor(1.0, 0.92, 0.7);

const C = (h: string) => new THREE.Color(h);

function makeLighthouse(): { body: THREE.BufferGeometry; lamp: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const rocks = new Rand(5);
  const noise = new Noise(5);
  for (let i = 0; i < 9; i++) {
    const r = smoothSphere(0.35 + rocks.range(0, 0.3), 2);
    displace(r, (x, y, z) => noise.noise3(x * 3 + i, y * 3, z * 3) * 0.12);
    const a = (i / 9) * Math.PI * 2;
    b.addGeometry(r, compose(Math.cos(a) * 0.55, -0.05 + rocks.range(0, 0.2), Math.sin(a) * 0.55, 0, 0, 0, 1, 0.7, 1), C(i % 2 ? '#7d746b' : '#655d55'));
    r.dispose();
  }
  b.surfaceId = SURFACE.stone;
  const base = new THREE.CylinderGeometry(0.42, 0.5, 0.25, 20);
  b.addGeometry(base, compose(0, 0.2, 0), C('#9a9187'));
  base.dispose();
  // Striped tower (the bands are painted in its material, crisp at any height).
  b.surfaceId = SURFACE.stripes;
  const tower = new THREE.CylinderGeometry(0.2, 0.3, 1.6, 24, 8);
  b.addGeometry(tower, compose(0, 1.1, 0), C('#f3efe8'));
  tower.dispose();
  b.surfaceId = SURFACE.plain;
  const gallery = new THREE.CylinderGeometry(0.3, 0.28, 0.06, 24);
  b.addGeometry(gallery, compose(0, 1.93, 0), C('#3b3b3e'));
  gallery.dispose();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rail = new THREE.CylinderGeometry(0.008, 0.008, 0.12, 4);
    b.addGeometry(rail, compose(Math.cos(a) * 0.29, 2.0, Math.sin(a) * 0.29), C('#2b2b2e'));
    rail.dispose();
  }
  const roof = new THREE.ConeGeometry(0.2, 0.28, 20);
  b.addGeometry(roof, compose(0, 2.42, 0), C('#b02b24'));
  roof.dispose();
  const ball = smoothSphere(0.035, 1);
  b.addGeometry(ball, compose(0, 2.58, 0), C('#3b3b3e'));
  ball.dispose();
  const body = b.build(false);
  const lamp = new THREE.CylinderGeometry(0.17, 0.17, 0.26, 16);
  lamp.translate(0, 2.13, 0);
  return { body, lamp };
}

function makeShip(): { hull: THREE.BufferGeometry; sails: THREE.BufferGeometry } {
  const b = new MeshBuilder();
  const hull = new THREE.SphereGeometry(0.5, 24, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const hp = hull.getAttribute('position');
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    const bow = x > 0 ? 1 - (x / 0.5) * 0.45 : 1 - (-x / 0.5) * 0.15;
    hp.setXYZ(i, x * 2.2, y * 0.75, z * 0.6 * bow);
  }
  hull.computeVertexNormals();
  // Planked hull, deck and sterncastle (seams and boards in the shader).
  b.surfaceId = SURFACE.planks;
  b.addGeometry(hull, compose(0, 0.32, 0), (_x, y, _z, o) => o.set(y > 0.24 ? '#7a4a2a' : y > 0.12 ? '#2f2a26' : '#5a3a22'));
  hull.dispose();
  const deck = new THREE.BoxGeometry(2.0, 0.06, 0.5);
  b.addGeometry(deck, compose(-0.05, 0.33, 0), C('#a47a4c'));
  deck.dispose();
  const castle = new THREE.BoxGeometry(0.45, 0.22, 0.5);
  b.addGeometry(castle, compose(-0.85, 0.45, 0), C('#6b4026'));
  castle.dispose();
  b.surfaceId = SURFACE.plain;
  for (const [x, h] of [
    [0.45, 1.9],
    [-0.25, 2.3],
    [-0.85, 1.5],
  ]) {
    const m = new THREE.CylinderGeometry(0.025, 0.035, h, 6);
    b.addGeometry(m, compose(x, 0.33 + h / 2, 0), C('#3e2a1a'));
    m.dispose();
  }
  const hullGeo = b.build(false);
  const s = new MeshBuilder();
  s.surfaceId = SURFACE.canvas;
  const sailSpec: [number, number, number, number][] = [
    [0.45, 0.95, 0.75, 0.7],
    [0.45, 1.6, 0.6, 0.45],
    [-0.25, 1.05, 0.9, 0.85],
    [-0.25, 1.85, 0.72, 0.55],
    [-0.85, 1.05, 0.6, 0.55],
  ];
  for (const [x, y, w, h] of sailSpec) {
    const rows = 4, cols = 5;
    const vs: number[][] = [];
    for (let j = 0; j <= rows; j++) {
      const row: number[] = [];
      for (let i = 0; i <= cols; i++) {
        const u = i / cols, v = j / rows;
        const belly = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.12;
        row.push(s.vertex(x + belly, y - h / 2 + v * h, (u - 0.5) * w, C('#f2e9d6')));
      }
      vs.push(row);
    }
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) s.quad(vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]);
  }
  return { hull: hullGeo, sails: s.build(true) };
}

export class DistantScenery {
  group = new THREE.Group();
  private ships: { obj: THREE.Object3D; r: number; angle: number; speed: number; cx: number; cz: number; phase: number }[] = [];
  private beam: THREE.Mesh;
  private beamPivot = new THREE.Object3D();
  private lampMat: THREE.MeshBasicNodeMaterial;
  beamStrength = uniform(0.15);
  private whale: { obj: THREE.Mesh; t: number; next: number; x: number; z: number; heading: number; blown: boolean };
  private disposables: { dispose(): void }[] = [];
  lighthousePos = new THREE.Vector3(-17, SEA_LEVEL + 0.05, -13);
  /** The land and the ships, filled in once their shapes are built (see fill). */
  /** The far islands themselves (still: drawn as a render bundle, see World). */
  readonly land = new THREE.Group();
  private fleet = new THREE.Group();
  private nearLand: THREE.MeshStandardNodeMaterial;
  private farLand: THREE.MeshStandardNodeMaterial;
  private treeMat: THREE.MeshStandardNodeMaterial;
  private rangeMat: THREE.MeshStandardNodeMaterial;
  private shipParts: { hull: THREE.BufferGeometry; sails: THREE.BufferGeometry; shipMat: THREE.Material; sailMat: THREE.Material };

  constructor(
    private spray: ParticleSystem,
    private mist: ParticleSystem,
    /** Colour of the haze in the view direction (the scene fog's, glowing towards the sun). */
    haze: Node<'vec3'>,
    lamps: LampLights,
    /** Where the scene's fog is thickest (nearer in rain), which the ranges' haze follows. */
    fogFar: Node<'float'>,
  ) {
    // The land (sea stacks, islets, far islands and the ranges) is built off the main thread and
    // added by fill(): it goes first, in a group of its own, so the scene keeps its order.
    this.nearLand = landMaterial({ scale: 1 });
    // (No snow: the far islands are lower than the ranges behind them, which only carry it on
    // their highest summits.)
    this.farLand = landMaterial({ scale: 4, turfSlope: 0.5 });
    this.treeMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 });
    // The ranges skip scene fog (it would erase them) and fade into the haze instead, each band
    // further off paler and bluer, like real aerial perspective: the air between them and the
    // island scatters exponentially with distance (Beer–Lambert), about as the scene's fog has the
    // far islands at a hundred units. When rain or a storm closes in (the fog's far end comes in,
    // from 210 to 120) it thickens much faster than the fog's range shrinks, so the ranges are
    // gone in a downpour, as the far islands nearer by are. It lies heaviest low down, so the
    // summits stand out against the sky while the foothills melt into the sea mist.
    const hazeK = Fn(() => {
      const d = positionWorld.sub(cameraPosition).length();
      // (The weather's own fog reach, not the reach lifted for a camera pulled far back: that
      // would thin the haze the further off the camera is.)
      const clear = fogFar.div(210);
      const air = d.negate().div(clear.mul(clear).mul(clear).mul(270)).exp().oneMinus();
      const low = smoothstep(8, 0, positionWorld.y.sub(SEA_LEVEL)).mul(0.06);
      return air.add(low).min(0.93);
    })();
    this.rangeMat = rangeMaterial({ color: haze, amount: hazeK });
    this.disposables.push(this.nearLand, this.farLand, this.treeMat, this.rangeMat);
    this.group.add(this.land);

    // Lighthouse.
    const lh = makeLighthouse();
    this.disposables.push(lh.body, lh.lamp);
    // Bands and stonework painted in the shader at the lighthouse's own scale (patterns made
    // four times larger than on the board pieces, since it is seen from far off).
    const lhMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.7 });
    lhMat.colorNode = Fn(() => {
      const id = attribute<'float'>('surface', 'float');
      const p = positionGeometry;
      const blocks = surfaceShade(float(SURFACE.stone), p.mul(0.25), normalGeometry, worldScale.mul(4));
      const c = id.greaterThan(SURFACE.stripes - 0.5).select(lighthouseBands(p), vertexColor().rgb);
      return vec4(c.mul(id.greaterThan(0.5).select(blocks, float(1))), 1);
    })();
    this.lampMat = new THREE.MeshBasicNodeMaterial({ color: '#fff0c2' });
    this.disposables.push(lhMat, this.lampMat);
    const lighthouse = new THREE.Group();
    const body = new THREE.Mesh(lh.body, lhMat);
    body.castShadow = body.receiveShadow = true;
    const lamp = new THREE.Mesh(lh.lamp, this.lampMat);
    lighthouse.add(body, lamp);
    // Its lamp lights the tower top, the rocks below and the water round them at night.
    lamps.add(lighthouse, { x: 0, y: 2.13, z: 0 }, { color: LIGHTHOUSE, distance: 4.5, strength: 2.2, flicker: 0 });
    lighthouse.position.copy(this.lighthousePos);
    lighthouse.scale.setScalar(0.5);
    this.group.add(lighthouse);
    // Beam: a long additive cone that sweeps around.
    const beamGeo = new THREE.ConeGeometry(1.4, 16, 24, 1, true);
    beamGeo.rotateZ(Math.PI / 2);
    beamGeo.translate(8, 0, 0);
    const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const strength = this.beamStrength;
    beamMat.colorNode = vec4(vec3(1.0, 0.86, 0.55), float(1));
    beamMat.opacityNode = Fn(() => {
      const along = positionLocal.x.div(16);
      return smoothstep(1.0, 0.0, along).mul(strength).mul(0.55);
    })();
    // Additive: both faces in one draw (order doesn't matter), not three's two-pass double side.
    beamMat.forceSinglePass = true;
    keepNormals(beamMat);
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    // After the sea (10), which would otherwise paint over it wherever water lies behind it.
    this.beam.renderOrder = 11;
    this.disposables.push(beamGeo, beamMat);
    this.beamPivot.position.set(0, 2.13, 0);
    this.beamPivot.add(this.beam);
    lighthouse.add(this.beamPivot);

    // Ships (set on their courses by fill()).
    const ship = makeShip();
    this.disposables.push(ship.hull, ship.sails);
    // Planking and sail panels at the ships' scale (patterns 2.5× those on the board pieces).
    const shipMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
    shipMat.colorNode = vec4(vertexColor().rgb.mul(surfaceShade(attribute<'float'>('surface', 'float'), positionGeometry.mul(0.4), normalGeometry, worldScale.div(0.4))), 1);
    const sailMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, side: THREE.DoubleSide });
    // (The sails stand in the y–z plane, so their panels run across z.)
    const sp = positionGeometry.mul(0.4);
    sailMat.colorNode = vec4(vertexColor().rgb.mul(surfaceShade(float(SURFACE.canvas), vec3(sp.z, sp.y, sp.x), normalGeometry, worldScale.div(0.4))), 1);
    this.disposables.push(shipMat, sailMat);
    this.shipParts = { hull: ship.hull, sails: ship.sails, shipMat, sailMat };
    this.group.add(this.fleet);

    // Whale back (a smooth dark hump) that surfaces now and then.
    const whaleGeo = smoothSphere(1, 3);
    whaleGeo.scale(2.2, 0.55, 0.8);
    const whaleMat = new THREE.MeshStandardNodeMaterial({ color: '#2f3a44', roughness: 0.35 });
    this.disposables.push(whaleGeo, whaleMat);
    const whale = new THREE.Mesh(whaleGeo, whaleMat);
    whale.visible = false;
    this.group.add(whale);
    this.whale = { obj: whale, t: -1, next: 14, x: 0, z: 0, heading: 0, blown: false };
  }

  /** Add the land and set the ships sailing, from the scenery's plan (see loadScenery). */
  fill(plan: SceneryPlan) {
    const looks = { near: [this.nearLand, true], trees: [this.treeMat, true], far: [this.farLand, false], range: [this.rangeMat, false] } as const;
    for (const p of plan.pieces) {
      const [mat, shadows] = looks[p.look];
      this.disposables.push(p.geometry);
      const m = new THREE.Mesh(p.geometry, mat);
      m.position.set(p.x, SEA_LEVEL + p.y, p.z);
      m.rotation.y = p.rot;
      m.castShadow = m.receiveShadow = shadows;
      this.land.add(m);
    }
    const { hull: hullGeo, sails: sailGeo, shipMat, sailMat } = this.shipParts;
    plan.ships.forEach((course, i) => {
      const g = new THREE.Group();
      const hull = new THREE.Mesh(hullGeo, shipMat);
      const sails = new THREE.Mesh(sailGeo, sailMat);
      hull.castShadow = sails.castShadow = true;
      g.add(hull, sails);
      g.scale.setScalar(0.55 + i * 0.1);
      this.fleet.add(g);
      this.ships.push({ obj: g, r: 15 + i * 7, ...course });
    });
  }

  update(dt: number, t: number, night: number) {
    // Lighthouse: lamp brightness and beam sweep (stronger at dusk and night).
    this.beamPivot.rotation.y = t * 0.6;
    // A quiet daytime landmark; the lamp and beam only come alive at dusk and night.
    this.lampMat.color.copy(LIGHTHOUSE).multiplyScalar(lampLevel(night, 0.45));
    this.beamStrength.value = night * 0.75;
    this.beam.visible = night > 0.05;
    for (const s of this.ships) {
      s.angle += s.speed * dt;
      const x = s.cx + Math.cos(s.angle) * s.r;
      const z = s.cz + Math.sin(s.angle) * s.r;
      s.obj.position.set(x, SEA_LEVEL - 0.08 + Math.sin(t * 0.9 + s.phase) * 0.04, z);
      s.obj.rotation.y = -(s.angle + (s.speed > 0 ? Math.PI / 2 : -Math.PI / 2));
      s.obj.rotation.z = Math.sin(t * 0.7 + s.phase) * 0.04;
      s.obj.rotation.x = Math.sin(t * 0.55 + s.phase * 1.3) * 0.03;
    }
    const w = this.whale;
    if (w.t < 0 && (w.next -= dt) <= 0) {
      const a = Math.random() * Math.PI * 2;
      const d = 16 + Math.random() * 10;
      w.x = Math.cos(a) * d;
      w.z = Math.sin(a) * d;
      w.heading = a + Math.PI / 2;
      w.t = 0;
      w.blown = false;
    }
    // (Placed below before it's shown: shown first, it would be drawn for a frame where it last was,
    // the first time the middle of the island, afloat on the sea.)
    if (w.t >= 0) {
      w.t += dt / 7;
      const u = w.t;
      const rise = Math.sin(Math.min(1, u) * Math.PI);
      w.obj.position.set(w.x + Math.cos(w.heading) * u * 3, SEA_LEVEL - 0.9 + rise * 0.75, w.z + Math.sin(w.heading) * u * 3);
      w.obj.rotation.y = -w.heading;
      w.obj.visible = true;
      if (u > 0.35 && !w.blown) {
        w.blown = true;
        waterBurst(this.spray, this.mist, { x: w.obj.position.x, y: SEA_LEVEL + 0.4, z: w.obj.position.z, count: 60, radius: 0.08, up: [1.8, 3.0], out: [0.05, 0.3], size: 0.09 });
      }
      if (u >= 1) {
        w.t = -1;
        w.obj.visible = false;
        w.next = 25 + Math.random() * 35;
      }
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.group.clear();
  }
}

/** The scenery's plan and the sea's ripple normals, built by render/buildWorker.ts. */
export interface Scenery {
  plan: SceneryPlan;
  detail: Uint8Array;
}

/**
 * The scenery beyond the island and the sea's ripple normals, built on a worker (started with the
 * page, see sceneryJob.ts) so the main thread is free meanwhile: a few hundred milliseconds of
 * work on a phone. Without a worker, or if it failed, they are built here.
 */
export async function loadScenery(): Promise<Scenery> {
  const built = await startScenery();
  if (!built) return { plan: planScenery(), detail: detailNormals() };
  const { plan, detail } = built;
  return { plan: { ships: plan.ships, pieces: plan.pieces.map((p) => ({ ...p, geometry: unpack(p.geometry) })) }, detail };
}
