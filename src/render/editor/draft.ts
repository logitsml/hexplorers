// The map editor's 3D view: a draft of the map built in the live world (its sea, sky and light),
// light enough to change on every click. Bevelled tiles in the terrain colours with a few props
// each (the expansions' terrain too), discs, jetties with their badges, wells, rivers, fishing
// grounds, the fog, the home islands' pennants, the robber and the corsair. A painted tile drops
// from the sky, squashes and settles, throwing up spray where it meets the sea; an erased one
// sinks; a disc spins down; a jetty slides out from the coast and its badge pops up; the fog rolls
// in. A random hex shows a die and a disc still to be dealt. The real island, built by the game's
// renderer, is one click away (Test play).

import * as THREE from 'three/webgpu';
import { CORNER_OFFSETS, SIDE_DIRS, cellAt, hexCenter } from '../../engine/board';
import { PIPS } from '../../engine/constants';
import { mouthSide, type CellTerrain, type CustomPortType } from '../../engine/maps/custom';
import { CARD_ICON, asset } from '../../game/names';
import { SEA_LEVEL } from '../board/layout';
import { waterBurst } from '../fx/particles';
import { ease } from '../util/tween';
import type { World } from '../World';

const key = (q: number, r: number) => `${q},${r}`;
/** The tiles' top, above the sea. */
const TOP = 0.12;
/** Pressed flat (see DraftIsland.relief): the level it lies at, clear of the swell, and how much height it keeps. */
export const PRESSED = SEA_LEVEL + 0.25;
const FLAT = 0.04;
const BODY = 0.9;

/** What the draft shows: the map's cells as drawn (or as one deal dealt them), and its pieces. */
export interface DraftScene {
  cells: { q: number; r: number; terrain: CellTerrain; numbers: number[]; owed: boolean; well: boolean; hidden: boolean }[];
  ports: { q: number; r: number; side: number; type: CustomPortType }[];
  robber: [number, number] | null;
  corsair: [number, number] | null;
  home: [number, number][];
  rivers: [number, number][][];
}

type Land = Exclude<CellTerrain, 'sea'>;

/** Each terrain's top and its earth, as the island reads from above. */
const COLOURS: Record<Land, [string, string]> = {
  forest: ['#3c7531', '#5b4630'],
  pasture: ['#86b846', '#6a5236'],
  fields: ['#d9ae43', '#7a5a35'],
  hills: ['#b95d33', '#7d3f22'],
  mountains: ['#7d8791', '#5b5650'],
  desert: ['#d8c28e', '#a88f5c'],
  bounty: ['#a8946a', '#6f5a3c'],
  lake: ['#7fae48', '#5f4c33'],
  swamp: ['#6b7445', '#4d4a30'],
  oasis: ['#dcc58f', '#a88f5c'],
  castle: ['#8d8478', '#5b5650'],
  random: ['#eadcb6', '#b39b6b'],
};

/** A seeded scatter, so a cell's props stay put however often it's rebuilt. */
function rand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Geometries merged into one with a colour per part. */
class Builder {
  parts: THREE.BufferGeometry[] = [];
  add(g: THREE.BufferGeometry, colour: string, at: [number, number, number], scale: [number, number, number] = [1, 1, 1], rot: number | [number, number, number] = 0) {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    geo.deleteAttribute('uv');
    const [rx, ry, rz] = typeof rot === 'number' ? [0, rot, 0] : rot;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(...scale));
    geo.applyMatrix4(m);
    const c = new THREE.Color(colour);
    const n = geo.attributes.position.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.parts.push(geo);
  }
  build(): THREE.BufferGeometry {
    const total = this.parts.reduce((a, g) => a + g.attributes.position.count, 0);
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
    let o = 0;
    for (const g of this.parts) {
      pos.set(g.attributes.position.array as Float32Array, o * 3);
      nor.set(g.attributes.normal.array as Float32Array, o * 3);
      col.set(g.attributes.color.array as Float32Array, o * 3);
      o += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return out;
  }
}

const shapes = {
  // (A six-sided cylinder has corners at ±z: a pointy-topped hex.)
  hex: new THREE.CylinderGeometry(1, 1, 1, 6),
  cone: new THREE.ConeGeometry(1, 1, 7),
  ball: new THREE.IcosahedronGeometry(1, 1),
  box: new THREE.BoxGeometry(1, 1, 1),
  post: new THREE.CylinderGeometry(1, 1, 1, 6),
  round: new THREE.CylinderGeometry(1, 1, 1, 14),
};

/** A tile's body and its props, centred on its cell, its top at y = TOP. */
function tileGeometry(terrain: Land, seed: number): THREE.BufferGeometry {
  const b = new Builder();
  const [top, earth] = COLOURS[terrain];
  b.add(shapes.hex, earth, [0, TOP - BODY / 2 - 0.04, 0], [0.97, BODY, 0.97]);
  b.add(shapes.hex, top, [0, TOP - 0.03, 0], [0.95, 0.07, 0.95]);
  const rnd = rand(seed);
  const spot = (r0: number, r1: number): [number, number] => {
    const a = rnd() * Math.PI * 2, r = r0 + (r1 - r0) * Math.sqrt(rnd());
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const reeds = (n: number, r0: number, r1: number) => {
    for (let i = 0; i < n; i++) {
      const [x, z] = spot(r0, r1);
      b.add(shapes.cone, rnd() < 0.5 ? '#5d7a2f' : '#7a8f3a', [x, TOP + 0.06, z], [0.025, 0.14 + rnd() * 0.08, 0.025]);
    }
  };
  const palm = (x: number, z: number) => {
    const h = 0.32 + rnd() * 0.1;
    const lean = (rnd() - 0.5) * 0.3;
    b.add(shapes.post, '#7b5a35', [x, TOP + h / 2, z], [0.025, h, 0.025], [lean, 0, lean]);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rnd();
      b.add(shapes.box, '#4f8f3a', [x + Math.cos(a) * 0.09, TOP + h, z + Math.sin(a) * 0.09], [0.2, 0.012, 0.06], [0, -a, -0.35]);
    }
  };
  // (Props keep clear of the middle, where the disc stands.)
  if (terrain === 'forest') {
    for (let i = 0; i < 9; i++) {
      const [x, z] = spot(0.36, 0.72);
      const h = 0.28 + rnd() * 0.16;
      b.add(shapes.post, '#5a3d24', [x, TOP + 0.04, z], [0.025, 0.08, 0.025]);
      b.add(shapes.cone, rnd() < 0.5 ? '#2c5e27' : '#356b2c', [x, TOP + 0.06 + h / 2, z], [0.11, h, 0.11], rnd() * 6);
    }
  } else if (terrain === 'pasture') {
    for (let i = 0; i < 4; i++) {
      const [x, z] = spot(0.38, 0.7);
      b.add(shapes.ball, '#f4f0e6', [x, TOP + 0.06, z], [0.08, 0.06, 0.06], rnd() * 6);
      b.add(shapes.ball, '#2f2a26', [x + 0.07, TOP + 0.07, z], [0.03, 0.03, 0.03]);
    }
    for (let i = 0; i < 7; i++) {
      const [x, z] = spot(0.3, 0.8);
      b.add(shapes.cone, '#6c9e35', [x, TOP + 0.04, z], [0.04, 0.08, 0.04]);
    }
  } else if (terrain === 'fields') {
    for (let row = -3; row <= 3; row++) {
      if (Math.abs(row) < 1) continue;
      const len = 1.15 - Math.abs(row) * 0.17;
      b.add(shapes.box, row % 2 ? '#e6bf4c' : '#c99a33', [0, TOP + 0.025, row * 0.16], [len, 0.05, 0.09]);
    }
  } else if (terrain === 'hills') {
    for (let i = 0; i < 4; i++) {
      const [x, z] = spot(0.4, 0.66);
      b.add(shapes.ball, '#a64f2a', [x, TOP, z], [0.2, 0.12, 0.18], rnd() * 6);
    }
    for (let i = 0; i < 3; i++) {
      const [x, z] = spot(0.35, 0.65);
      b.add(shapes.box, '#8e3b1d', [x, TOP + 0.04, z], [0.1, 0.06, 0.05], rnd() * 6);
    }
  } else if (terrain === 'mountains') {
    for (let i = 0; i < 4; i++) {
      const [x, z] = spot(0.4, 0.62);
      const h = 0.38 + rnd() * 0.22;
      b.add(shapes.cone, '#6f7882', [x, TOP + h / 2 - 0.02, z], [0.22, h, 0.22], rnd() * 6);
      b.add(shapes.cone, '#eef2f4', [x, TOP + h - 0.08, z], [0.075, 0.12, 0.075], rnd() * 6);
    }
  } else if (terrain === 'desert') {
    for (let i = 0; i < 4; i++) {
      const [x, z] = spot(0.3, 0.68);
      b.add(shapes.ball, '#e3cd97', [x, TOP - 0.02, z], [0.26, 0.08, 0.14], rnd() * 6);
    }
    b.add(shapes.post, '#5f8a3a', [0.42, TOP + 0.1, -0.2], [0.03, 0.2, 0.03]);
  } else if (terrain === 'bounty') {
    // A worked stream: gravel, a wooden sluice down it, and spoil heaps from the diggings.
    for (let i = 0; i < 16; i++) {
      const [x, z] = spot(0.32, 0.78);
      b.add(shapes.ball, rnd() < 0.5 ? '#8a8378' : '#6d665c', [x, TOP + 0.01, z], [0.04, 0.025, 0.04], rnd() * 6);
    }
    b.add(shapes.box, '#4f88a8', [-0.15, TOP + 0.005, -0.42], [0.95, 0.015, 0.12], -0.5);
    b.add(shapes.box, '#8a5f3a', [0.38, TOP + 0.08, -0.15], [0.5, 0.06, 0.1], [0, -0.5, 0.25]);
    for (const [dx, dz] of [[0.2, -0.05], [0.56, -0.25]]) b.add(shapes.post, '#5b3d24', [dx, TOP + 0.04, dz], [0.015, 0.1, 0.015]);
    for (let i = 0; i < 3; i++) {
      const [x, z] = spot(0.42, 0.66);
      b.add(shapes.ball, '#7a6748', [x, TOP, z], [0.12, 0.07, 0.1], rnd() * 6);
    }
  } else if (terrain === 'lake') {
    // A round of water in the meadow, with reeds along its edge and a little jetty.
    b.add(shapes.round, '#4f8fb0', [0, TOP + 0.004, 0], [0.62, 0.012, 0.62]);
    b.add(shapes.round, '#6aa9c7', [-0.08, TOP + 0.008, -0.05], [0.4, 0.008, 0.36]);
    reeds(10, 0.62, 0.8);
    b.add(shapes.box, '#8a5f3a', [0.55, TOP + 0.03, 0.28], [0.32, 0.025, 0.09], -0.45);
  } else if (terrain === 'swamp') {
    for (let i = 0; i < 4; i++) {
      const [x, z] = spot(0.36, 0.64);
      b.add(shapes.round, '#2f4a3e', [x, TOP + 0.004, z], [0.13 + rnd() * 0.07, 0.01, 0.1 + rnd() * 0.06], rnd() * 6);
    }
    reeds(14, 0.3, 0.8);
    for (let i = 0; i < 2; i++) {
      const [x, z] = spot(0.45, 0.7);
      b.add(shapes.post, '#4e4632', [x, TOP + 0.08, z], [0.02, 0.16, 0.02], [0.3, 0, 0.2]);
    }
  } else if (terrain === 'oasis') {
    b.add(shapes.round, '#4f8fb0', [0, TOP + 0.004, 0], [0.3, 0.012, 0.24]);
    b.add(shapes.round, '#7aa34a', [0, TOP + 0.002, 0], [0.4, 0.008, 0.33]);
    palm(-0.36, -0.18);
    palm(0.3, -0.32);
    palm(0.12, 0.42);
    for (let i = 0; i < 3; i++) {
      const [x, z] = spot(0.55, 0.78);
      b.add(shapes.ball, '#e8d5a2', [x, TOP - 0.02, z], [0.22, 0.07, 0.12], rnd() * 6);
    }
  } else if (terrain === 'castle') {
    // A rocky rise with a keep and a curtain wall.
    for (let i = 0; i < 5; i++) {
      const [x, z] = spot(0.45, 0.72);
      b.add(shapes.ball, '#7b746b', [x, TOP, z], [0.13, 0.09, 0.12], rnd() * 6);
    }
    b.add(shapes.box, '#a69d8f', [0, TOP + 0.2, -0.05], [0.26, 0.4, 0.26]);
    for (const [dx, dz] of [[-0.11, -0.16], [0.11, -0.16], [-0.11, 0.06], [0.11, 0.06]]) b.add(shapes.box, '#b8afa1', [dx, TOP + 0.43, dz], [0.05, 0.06, 0.05]);
    b.add(shapes.round, '#9a9184', [0.3, TOP + 0.16, 0.22], [0.08, 0.32, 0.08]);
    b.add(shapes.cone, '#5c4a3a', [0.3, TOP + 0.38, 0.22], [0.1, 0.14, 0.1]);
    b.add(shapes.box, '#8f877b', [-0.05, TOP + 0.07, 0.3], [0.6, 0.14, 0.06], 0.2);
    b.add(shapes.box, '#8f877b', [-0.38, TOP + 0.07, 0.05], [0.06, 0.14, 0.5], 0.2);
  } else if (terrain === 'random') {
    // A tile still to be dealt: plain parchment and a die thrown on it.
    const tilt = rnd() * Math.PI;
    b.add(shapes.box, '#fbf6ea', [0.42, TOP + 0.08, -0.26], [0.16, 0.16, 0.16], [0, tilt, 0]);
    const pips: [number, number][] = [[-0.04, -0.04], [0, 0], [0.04, 0.04]];
    for (const [px, pz] of pips) {
      const c = Math.cos(tilt), s = Math.sin(tilt);
      b.add(shapes.ball, '#2b2118', [0.42 + px * c + pz * s, TOP + 0.16, -0.26 - px * s + pz * c], [0.014, 0.008, 0.014]);
    }
    for (let i = 0; i < 4; i++) {
      const [x, z] = spot(0.5, 0.75);
      b.add(shapes.cone, '#c7b48a', [x, TOP + 0.03, z], [0.05, 0.06, 0.05]);
    }
  }
  return b.build();
}

/** A well-sweep: a stone well-head, a post and a long pole with its bucket, off the hex's middle. */
function wellGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  b.add(shapes.round, '#8b857b', [0, 0.05, 0], [0.09, 0.1, 0.09]);
  b.add(shapes.round, '#1f2a2e', [0, 0.101, 0], [0.065, 0.004, 0.065]);
  b.add(shapes.post, '#5b3d24', [0.12, 0.15, 0], [0.018, 0.3, 0.018]);
  b.add(shapes.box, '#7a5532', [0.06, 0.3, 0], [0.42, 0.018, 0.018], [0, 0, 0.45]);
  b.add(shapes.box, '#3a2a1c', [-0.12, 0.17, 0], [0.004, 0.2, 0.004]);
  b.add(shapes.round, '#6b4a2b', [-0.12, 0.07, 0], [0.03, 0.05, 0.03]);
  b.add(shapes.box, '#2e2a27', [0.22, 0.22, 0], [0.06, 0.06, 0.06]);
  return b.build();
}

/** The fog over a hex: a flattened bank of soft puffs. */
function fogGeometry(seed: number): THREE.BufferGeometry {
  const b = new Builder();
  const rnd = rand(seed * 31 + 7);
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.62;
    const s = 0.32 + rnd() * 0.18;
    b.add(shapes.ball, i % 3 ? '#f4f7f9' : '#e2e9ee', [Math.cos(a) * r, rnd() * 0.08, Math.sin(a) * r], [s, s * 0.45, s]);
  }
  return b.build();
}

/** A ring of buoys round a fishing ground. */
function buoysGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.add(shapes.ball, i % 2 ? '#f4f0e6' : '#c8402f', [Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55], [0.045, 0.04, 0.045]);
  }
  for (let i = 0; i < 16; i++) {
    const a = ((i + 0.5) / 16) * Math.PI * 2;
    b.add(shapes.box, '#d9c9a0', [Math.cos(a) * 0.55, -0.01, Math.sin(a) * 0.55], [0.2, 0.006, 0.006], [0, -a + Math.PI / 2, 0]);
  }
  return b.build();
}

/** The corsair's galley: a dark hull, a mast and a black sail. */
function corsairGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  b.add(shapes.box, '#2b2420', [0, 0.04, 0], [0.5, 0.09, 0.16]);
  b.add(shapes.cone, '#2b2420', [0.3, 0.04, 0], [0.08, 0.14, 0.08], [0, 0, -Math.PI / 2]);
  b.add(shapes.box, '#3a2f28', [-0.2, 0.11, 0], [0.12, 0.06, 0.14]);
  b.add(shapes.post, '#4a3626', [0, 0.3, 0], [0.012, 0.46, 0.012]);
  b.add(shapes.box, '#141210', [0.02, 0.33, 0], [0.02, 0.28, 0.3], [0, 0, 0.05]);
  b.add(shapes.box, '#8a1f17', [0, 0.55, 0.05], [0.004, 0.05, 0.1]);
  return b.build();
}

/** A home island's pennant: a pole and a swallow-tailed flag. */
function pennantGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  b.add(shapes.post, '#5b3d24', [0, 0.25, 0], [0.014, 0.5, 0.014]);
  b.add(shapes.ball, '#d9b24a', [0, 0.51, 0], [0.025, 0.025, 0.025]);
  b.add(shapes.box, '#b8302a', [0.11, 0.44, 0], [0.2, 0.1, 0.008]);
  b.add(shapes.box, '#f0d58a', [0.11, 0.44, 0.005], [0.2, 0.025, 0.004]);
  return b.build();
}

// ------------------------------------------------------------------ discs and badges

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, s: number) => void, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const FONT = '"Fraunces Variable", Georgia, serif';

/** A disc's face: its number and dots, or (`n` 0) a "?" for a number still to be dealt. */
function discFace(n: number) {
  return canvasTexture((ctx, s) => {
    ctx.fillStyle = n ? '#f7efdc' : '#efe2c2';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#bfa877';
    ctx.lineWidth = s * 0.03;
    ctx.setLineDash(n ? [] : [s * 0.05, s * 0.04]);
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    const red = n === 6 || n === 8;
    ctx.fillStyle = red ? '#b8302a' : n ? '#2b2118' : '#8a6c45';
    ctx.font = `700 ${s * (n >= 10 ? 0.4 : 0.46)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n ? String(n) : '?', s / 2, s * (n ? 0.46 : 0.52));
    const pips = PIPS[n] ?? 0;
    for (let i = 0; i < pips; i++) {
      ctx.beginPath();
      ctx.arc(s / 2 + (i - (pips - 1) / 2) * s * 0.07, s * 0.72, s * 0.022, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

const icons = new Map<string, HTMLImageElement>();
function icon(src: string, then: () => void) {
  let img = icons.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    icons.set(src, img);
  }
  if (img.complete && img.naturalWidth) return img;
  img.addEventListener('load', then, { once: true });
  return null;
}

/** A harbour's round badge (as the flat map's), drawn on a canvas: 3:1, a resource's 2:1, or a "?" for a type still to be dealt. */
function badgeTexture(type: CustomPortType) {
  const tex = canvasTexture(() => {});
  const draw = () => {
    const c = tex.image as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const s = c.width;
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = type === 'random' ? '#efe2c2' : '#f4e9cf';
    ctx.strokeStyle = '#8a6c45';
    ctx.lineWidth = s * 0.05;
    ctx.setLineDash(type === 'random' ? [s * 0.07, s * 0.05] : []);
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2b2118';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (type === 'any') {
      ctx.font = `700 ${s * 0.3}px ${FONT}`;
      ctx.fillText('3:1', s / 2, s * 0.52);
    } else if (type === 'random') {
      ctx.fillStyle = '#8a6c45';
      ctx.font = `700 ${s * 0.46}px ${FONT}`;
      ctx.fillText('?', s / 2, s * 0.54);
    } else {
      const img = icon(asset(CARD_ICON[type]), () => {
        draw();
        tex.needsUpdate = true;
      });
      if (img) ctx.drawImage(img, s * 0.28, s * 0.12, s * 0.44, s * 0.44);
      ctx.font = `700 ${s * 0.2}px ${FONT}`;
      ctx.fillText('2:1', s / 2, s * 0.72);
    }
    tex.needsUpdate = true;
  };
  draw();
  return tex;
}

// ------------------------------------------------------------------ the draft

interface Tile {
  terrain: Land;
  group: THREE.Group;
}

/** A flat hexagonal ring round a cell's centre, between `inner` and `outer` of its corners' reach, facing up. */
function hexRing(inner: number, outer: number) {
  const at = (k: number) => CORNER_OFFSETS.map(([x, z]) => new THREE.Vector2(x * k, z * k));
  const shape = new THREE.Shape(at(outer));
  shape.holes.push(new THREE.Path(at(inner)));
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
}

/** A small draft with a piece of every kind, for DraftIsland.warm. */
const SAMPLE: DraftScene = {
  cells: [
    { q: 0, r: 0, terrain: 'forest', numbers: [6], owed: false, well: true, hidden: false },
    { q: 1, r: 0, terrain: 'lake', numbers: [2, 12], owed: false, well: false, hidden: false },
    { q: 0, r: 1, terrain: 'random', numbers: [], owed: true, well: false, hidden: true },
    { q: -1, r: 1, terrain: 'swamp', numbers: [], owed: false, well: false, hidden: false },
    { q: 1, r: -1, terrain: 'sea', numbers: [4], owed: false, well: false, hidden: false },
    { q: -1, r: 0, terrain: 'sea', numbers: [], owed: false, well: false, hidden: true },
  ],
  ports: [
    { q: 0, r: 0, side: 0, type: 'any' },
    { q: 1, r: 0, side: 1, type: 'random' },
  ],
  robber: [0, 0],
  corsair: [-1, 0],
  home: [[0, 0]],
  rivers: [
    [
      [0, 0],
      [-1, 1],
    ],
  ],
};

/** The warm-up's draft, kept hidden once compiled (see DraftIsland.warm). */
let warming: Promise<void> | null = null;

export class DraftIsland {
  /**
   * Compile the draft's shaders before its first showing: a small draft with a piece of every
   * kind, compiled hidden. Once a page. It is kept (hidden) afterwards, because the renderer lets go
   * of what it built for a material once nothing drawn with it is left, and the next draft's
   * materials, though new, are the same as its own: so they find their shaders built. (Built on
   * sight instead, they would hold frames for a good part of a second on going to 3D, and longer on
   * a phone.)
   *
   * The frames hold while it compiles: usually the flat board covers the island then, so none would
   * be drawn anyway, and built within the compile's own frames it's done many times sooner than by
   * the staged builds that let frames go on (World.warm), which wait their turn between frames that
   * a phone takes long over.
   */
  static warm(world: World): Promise<void> {
    return (warming ??= (async () => {
      const keeper = new DraftIsland(world);
      keeper.still = true;
      keeper.setScene(SAMPLE, [], new Set());
      keeper.group.position.y = -40;
      keeper.offFrame();
      keeper.group.visible = false;
      await world.precompile(undefined, true, false, undefined, [keeper.group]);
    })().catch((e) => {
      // (Not warmed: the first draft builds its shaders on sight.)
      console.warn('the editor’s 3D draft could not be compiled ahead', e);
    }));
  }

  readonly group = new THREE.Group();
  /** Reduced motion: changes land at once, without drops, sinkings or spray. */
  still = false;
  private material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  private fogMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, transparent: true, opacity: 0.62, depthWrite: false });
  private riverMaterial = new THREE.MeshStandardMaterial({ color: '#3f8fc4', roughness: 0.25, metalness: 0.05, side: THREE.DoubleSide });
  private seaMaterial = new THREE.MeshBasicMaterial({ color: '#bfe6f5', transparent: true, opacity: 0.22, depthWrite: false });
  private gridMaterial = new THREE.LineBasicMaterial({ color: '#e8f6fb', transparent: true, opacity: 0.32 });
  private aimMaterial = new THREE.MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.95, depthWrite: false });
  private ghostMaterial = new THREE.MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.4, depthWrite: false });
  private ringGeometry = hexRing(0.8, 0.97);
  private tiles = new Map<string, Tile>();
  private seas = new Map<string, THREE.Mesh>();
  private discs = new Map<string, THREE.Group>();
  private wells = new Map<string, THREE.Group>();
  private fogs = new Map<string, THREE.Group>();
  private harbours = new Map<string, THREE.Group>();
  private flags = new Map<string, THREE.Group>();
  private robber: THREE.Group | null = null;
  private robberAt = '';
  private corsair: THREE.Group | null = null;
  private corsairAt = '';
  private rivers: THREE.Group | null = null;
  private riversSig = '';
  private grid: THREE.LineSegments | null = null;
  private gridKeys = new Set<string>();
  /** The aim's marks, made as needed and kept (rings round cells, bars along coasts; faint for images round the middle). */
  private aims = new Map<string, THREE.Mesh[]>();
  private aimShown: THREE.Mesh[] = [];
  private faces = new Map<number, THREE.Texture>();
  private discSide = new THREE.MeshStandardMaterial({ color: '#e8dcc0', roughness: 0.6 });
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TOP);
  private sea = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SEA_LEVEL);
  private disposed = false;
  private badgePlane = new THREE.PlaneGeometry(1, 1);
  private badges = new Set<THREE.Mesh>();
  private offFrame: () => void;
  private q = new THREE.Quaternion();
  /** Geometry shared by every copy (never disposed with a piece). */
  private shared: { well: THREE.BufferGeometry; buoys: THREE.BufferGeometry; corsair: THREE.BufferGeometry; pennant: THREE.BufferGeometry; disc: THREE.BufferGeometry };

  constructor(private world: World) {
    this.group.name = 'map-editor-draft';
    this.shared = { well: wellGeometry(), buoys: buoysGeometry(), corsair: corsairGeometry(), pennant: pennantGeometry(), disc: new THREE.CylinderGeometry(0.3, 0.31, 0.05, 32) };
    // (One of each kind of mark from the start, hidden: so the warm-up compiles them too.)
    for (const kind of ['ring', 'ring~', 'bar', 'bar~']) this.aimMesh(kind, 0);
    world.stage.scene.add(this.group);
    // The badges turn to the camera every frame (their parents' turn taken out); the corsair rides the swell.
    this.offFrame = world.onFrame((_dt, t) => {
      for (const b of this.badges) {
        b.parent!.getWorldQuaternion(this.q).invert();
        b.quaternion.copy(this.q.multiply(world.stage.camera.quaternion));
      }
      const ship = this.corsair?.children[0];
      if (ship && !this.still) {
        ship.position.y = Math.sin(t * 1.6) * 0.018;
        ship.rotation.z = Math.sin(t * 1.1) * 0.05;
        ship.rotation.x = Math.sin(t * 1.3 + 1) * 0.03;
      }
    });
  }

  /**
   * The point on the board (world x, z) under a pointer at client (x, y), or null off the water: on
   * a tile's top where that is land, else on the sea (seen low, the two are a cell apart).
   */
  pick(clientX: number, clientY: number): [number, number] | null {
    const rect = this.world.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.world.stage.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.plane, hit) && this.tiles.has(key(...cellAt(hit.x, hit.z)))) return [hit.x, hit.z];
    return this.raycaster.ray.intersectPlane(this.sea, hit) ? [hit.x, hit.z] : null;
  }

  /**
   * Mark what the tool would act on: a ring round each cell (or, with `side`, a bar along that
   * stretch of its coast), faint for the images round the middle (`ghost`), as the flat board does.
   */
  setAim(marks: readonly { q: number; r: number; side?: number; ghost?: boolean }[]) {
    for (const m of this.aimShown) m.visible = false;
    this.aimShown.length = 0;
    const used: Record<string, number> = {};
    for (const at of marks) {
      const kind = `${at.side === undefined ? 'ring' : 'bar'}${at.ghost ? '~' : ''}`;
      const mesh = this.aimMesh(kind, (used[kind] = (used[kind] ?? -1) + 1));
      const [x, z] = hexCenter(at.q, at.r);
      const y = this.tiles.has(key(at.q, at.r)) ? TOP + 0.02 : SEA_LEVEL + 0.05;
      if (at.side === undefined) mesh.position.set(x, y, z);
      else {
        const a = CORNER_OFFSETS[at.side], b = CORNER_OFFSETS[(at.side + 1) % 6];
        mesh.position.set(x + (a[0] + b[0]) / 2, y + 0.02, z + (a[1] + b[1]) / 2);
        mesh.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      }
      mesh.visible = true;
      this.aimShown.push(mesh);
    }
  }

  /** The `i`th mark of a kind ('ring' or 'bar', '~' for a faint one), made if there are fewer. */
  private aimMesh(kind: string, i: number) {
    let pool = this.aims.get(kind);
    if (!pool) this.aims.set(kind, (pool = []));
    while (pool.length <= i) {
      const bar = kind.startsWith('bar');
      const m = new THREE.Mesh(bar ? shapes.box : this.ringGeometry, kind.endsWith('~') ? this.ghostMaterial : this.aimMaterial);
      if (bar) m.scale.set(1, 0.04, 0.1);
      m.renderOrder = 10;
      m.visible = false;
      this.group.add(m);
      pool.push(m);
    }
    return pool[i];
  }

  /** The grid of cells that can be painted, as faint rings on the water. */
  private setGrid(cells: readonly (readonly [number, number])[]) {
    // (Left as it is when the same cells are given again: an edit that grew nothing.)
    if (cells.length === this.gridKeys.size && cells.every(([q, r]) => this.gridKeys.has(key(q, r)))) return;
    this.gridKeys = new Set(cells.map(([q, r]) => key(q, r)));
    if (this.grid) {
      this.group.remove(this.grid);
      this.grid.geometry.dispose();
    }
    const pts: THREE.Vector3[] = [];
    for (const [q, r] of cells) {
      const [x, z] = hexCenter(q, r);
      for (let i = 0; i < 6; i++) {
        const a = CORNER_OFFSETS[i], b = CORNER_OFFSETS[(i + 1) % 6];
        pts.push(new THREE.Vector3(x + a[0] * 0.94, 0, z + a[1] * 0.94), new THREE.Vector3(x + b[0] * 0.94, 0, z + b[1] * 0.94));
      }
    }
    this.grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), this.gridMaterial);
    this.grid.position.y = SEA_LEVEL + 0.03;
    this.grid.renderOrder = 2;
    this.group.add(this.grid);
  }

  /**
   * Bring the draft to `scene`. Cells in `fresh` (the last edit's) arrive with their motion; the
   * rest change at once (an undo, a newly opened map) unless `animateAll` (then each in turn,
   * `cascade` seconds apart: an island assembling, or a deal being dealt again).
   */
  setScene(scene: DraftScene, grid: readonly (readonly [number, number])[], fresh: ReadonlySet<string>, animateAll = false, cascade = 0.06) {
    if (this.disposed) return;
    this.setGrid(grid);
    const anim = (c: string) => !this.still && (animateAll || fresh.has(c));
    const want = new Map(scene.cells.map((h) => [key(h.q, h.r), h]));
    let k = 0;
    const next = () => (animateAll ? k++ * cascade : 0);

    // Land.
    for (const [c, t] of this.tiles) {
      const h = want.get(c);
      if (h && h.terrain === t.terrain) continue;
      this.tiles.delete(c);
      this.sink(t.group, anim(c) && !(h && h.terrain !== 'sea'));
    }
    for (const h of scene.cells) {
      const c = key(h.q, h.r);
      if (h.terrain === 'sea' || this.tiles.has(c)) continue;
      const mesh = new THREE.Mesh(tileGeometry(h.terrain, (h.q + 17) * 131 + (h.r + 17) * 7), this.material);
      mesh.castShadow = mesh.receiveShadow = true;
      const group = new THREE.Group();
      group.add(mesh);
      const [x, z] = hexCenter(h.q, h.r);
      group.position.set(x, 0, z);
      this.group.add(group);
      this.tiles.set(c, { terrain: h.terrain, group });
      if (anim(c)) this.drop(group, x, z, next());
    }
    // Open water.
    for (const [c, m] of this.seas) {
      if (want.get(c)?.terrain === 'sea') continue;
      this.seas.delete(c);
      this.group.remove(m);
    }
    for (const h of scene.cells) {
      const c = key(h.q, h.r);
      if (h.terrain !== 'sea' || this.seas.has(c)) continue;
      const m = new THREE.Mesh(shapes.hex, this.seaMaterial);
      const [x, z] = hexCenter(h.q, h.r);
      m.position.set(x, SEA_LEVEL + 0.02, z);
      m.scale.set(0.93, 0.01, 0.93);
      m.renderOrder = 1;
      this.group.add(m);
      this.seas.set(c, m);
      if (anim(c)) {
        this.ripple(x, z);
        this.world.animator.tween({ duration: 0.5, easing: ease.outBack, update: (t) => m.scale.set(0.93 * t, 0.01, 0.93 * t) });
      }
    }
    // Discs: a number, a lake's four in a ring, a fishing ground's afloat in its buoys, or a "?" still to be dealt.
    const discKey = (h: DraftScene['cells'][number]) => `${key(h.q, h.r)}:${h.terrain === 'sea' ? 'g' : h.terrain === 'lake' ? 'l' : 'n'}:${h.numbers.join('/')}:${h.owed ? '?' : ''}`;
    const discWant = new Map(scene.cells.filter((h) => h.numbers.length > 0 || (h.owed && h.terrain !== 'sea')).map((h) => [discKey(h), h]));
    for (const [d, g] of this.discs) {
      if (discWant.has(d)) continue;
      this.discs.delete(d);
      this.lift(g, anim(d.split(':')[0]));
    }
    for (const [d, h] of discWant) {
      if (this.discs.has(d)) continue;
      const [x, z] = hexCenter(h.q, h.r);
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      if (h.terrain === 'sea') {
        const buoys = new THREE.Mesh(this.shared.buoys, this.material);
        buoys.position.y = SEA_LEVEL + 0.03;
        g.add(buoys);
        g.add(this.disc(h.numbers[0], 0, SEA_LEVEL + 0.05, 0, 0.85));
      } else if (h.terrain === 'lake') {
        h.numbers.forEach((n, i) => {
          const a = ((i + 0.5) / h.numbers.length) * Math.PI * 2 - Math.PI / 2;
          g.add(this.disc(n, Math.cos(a) * 0.42, TOP + 0.03, Math.sin(a) * 0.42, 0.62));
        });
      } else g.add(this.disc(h.owed ? 0 : h.numbers[0], 0, TOP + 0.03, 0, 1));
      this.group.add(g);
      this.discs.set(d, g);
      if (anim(key(h.q, h.r))) this.spinDown(g, animateAll ? 0.3 + k * cascade * 0.6 : 0.08);
    }
    // Wells.
    this.syncPieces(this.wells, new Map(scene.cells.filter((h) => h.well && h.terrain !== 'sea').map((h) => [key(h.q, h.r), h])), (h) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(this.shared.well, this.material);
      m.castShadow = true;
      g.add(m);
      const [x, z] = hexCenter(h.q, h.r);
      g.position.set(x - 0.44, TOP, z + 0.24);
      return g;
    }, anim, 'pop');
    // The fog.
    this.syncPieces(this.fogs, new Map(scene.cells.filter((h) => h.hidden).map((h) => [key(h.q, h.r), h])), (h) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(fogGeometry((h.q + 9) * 37 + h.r), this.fogMaterial);
      m.renderOrder = 4;
      g.add(m);
      const [x, z] = hexCenter(h.q, h.r);
      g.position.set(x, (h.terrain === 'sea' ? SEA_LEVEL : TOP) + 0.2, z);
      return g;
    }, anim, 'roll');
    // Harbours.
    const portWant = new Map(scene.ports.map((p) => [`${p.q},${p.r},${p.side}:${p.type}`, p]));
    for (const [id, g] of this.harbours) {
      if (portWant.has(id)) continue;
      this.harbours.delete(id);
      this.lift(g, !this.still);
    }
    for (const [id, p] of portWant) {
      if (this.harbours.has(id)) continue;
      this.harbours.set(id, this.harbour(p.q, p.r, p.side, p.type, anim(key(p.q, p.r))));
    }
    // The home islands' pennants.
    this.syncPieces(this.flags, new Map(scene.home.map(([q, r]) => [key(q, r), { q, r }])), (h) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(this.shared.pennant, this.material);
      m.castShadow = true;
      g.add(m);
      const [x, z] = hexCenter(h.q, h.r);
      g.position.set(x + 0.38, TOP, z + 0.36);
      return g;
    }, anim, 'pop');
    // The robber.
    const robKey = scene.robber ? key(...scene.robber) : '';
    if (robKey !== this.robberAt) {
      if (this.robber) this.lift(this.robber, !this.still);
      this.robber = null;
      this.robberAt = robKey;
      if (scene.robber) {
        this.robber = this.robberFigure();
        const [x, z] = hexCenter(...scene.robber);
        this.robber.position.set(x + 0.32, TOP, z - 0.3);
        this.group.add(this.robber);
        if (!this.still && (fresh.has(robKey) || animateAll)) this.drop(this.robber, x, z, 0.1, false);
      }
    }
    // The corsair, sailing in from beyond the map.
    const corKey = scene.corsair ? key(...scene.corsair) : '';
    if (corKey !== this.corsairAt) {
      if (this.corsair) this.lift(this.corsair, !this.still);
      this.corsair = null;
      this.corsairAt = corKey;
      if (scene.corsair) {
        const g = new THREE.Group();
        const ship = new THREE.Mesh(this.shared.corsair, this.material);
        ship.castShadow = true;
        g.add(ship);
        const [x, z] = hexCenter(...scene.corsair);
        g.position.set(x, SEA_LEVEL + 0.02, z);
        g.rotation.y = 0.6;
        this.group.add(g);
        this.corsair = g;
        if (!this.still && (fresh.has(corKey) || animateAll)) {
          const from = 1.6;
          this.world.animator.tween({ duration: 0.9, easing: ease.outCubic, update: (t) => g.position.set(x - Math.cos(0.6) * from * (1 - t), SEA_LEVEL + 0.02, z + Math.sin(0.6) * from * (1 - t)) });
          this.ripple(x, z);
        }
      }
    }
    // Rivers.
    this.setRivers(scene, fresh, animateAll);
  }

  /**
   * Keep a set of one-per-cell pieces (wells, fog, pennants) in step with `want`: new ones made by
   * `make` and brought in ('pop' springs up, 'roll' rolls in like fog), gone ones taken away.
   */
  private syncPieces<T>(have: Map<string, THREE.Group>, want: Map<string, T>, make: (h: T) => THREE.Group, anim: (c: string) => boolean, how: 'pop' | 'roll') {
    for (const [c, g] of have) {
      if (want.has(c)) continue;
      have.delete(c);
      if (how === 'roll' && anim(c)) {
        const y0 = g.position.y;
        this.world.animator.tween({
          duration: 0.6,
          easing: ease.inOutCubic,
          update: (t) => {
            g.position.y = y0 + t * 0.5;
            g.scale.setScalar(Math.max(0.001, 1 + t * 0.4));
            g.scale.y = Math.max(0.001, 1 - t);
          },
          done: () => this.release(g),
        });
      } else this.lift(g, anim(c));
    }
    for (const [c, h] of want) {
      if (have.has(c)) continue;
      const g = make(h);
      this.group.add(g);
      have.set(c, g);
      if (!anim(c)) continue;
      if (how === 'roll') {
        g.scale.setScalar(0.001);
        const y0 = g.position.y;
        this.world.animator.tween({
          duration: 0.8,
          easing: ease.outCubic,
          update: (t) => {
            g.scale.set(0.3 + 0.7 * t, Math.max(0.001, t), 0.3 + 0.7 * t);
            g.position.y = y0 + (1 - t) * 0.3;
            g.rotation.y = (1 - t) * 0.8;
          },
        });
        const p = this.world.particles;
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * Math.PI * 2;
          p.mist.emit({ x: g.position.x + Math.cos(a) * 0.5, y: y0, z: g.position.z + Math.sin(a) * 0.5, vx: Math.cos(a) * 0.15, vy: 0.04, vz: Math.sin(a) * 0.15, life: 1.4, size: 0.4, grow: 1.8, color: '#f2f5f7', alpha: 0.35, drag: 0.8 });
        }
      } else {
        g.scale.setScalar(0.001);
        this.world.animator.tween({ duration: 0.45, easing: ease.outBack, update: (t) => g.scale.setScalar(Math.max(0.001, t)) });
      }
    }
  }

  /** The rivers as blue ribbons from spring to mouth, run on past the coast into the sea; rebuilt when they change. */
  private setRivers(scene: DraftScene, fresh: ReadonlySet<string>, animateAll: boolean) {
    const cells = scene.cells;
    const sig = JSON.stringify(scene.rivers) + scene.rivers.flat().map(([q, r]) => cells.find((h) => h.q === q && h.r === r)?.terrain ?? '').join();
    if (sig === this.riversSig) return;
    this.riversSig = sig;
    if (this.rivers) this.release(this.rivers);
    this.rivers = null;
    if (scene.rivers.length === 0) return;
    const g = new THREE.Group();
    const grow: { mesh: THREE.Mesh; count: number }[] = [];
    for (const path of scene.rivers) {
      const pts = path.map(([q, r]) => {
        const [x, z] = hexCenter(q, r);
        return new THREE.Vector3(x, TOP + 0.03, z);
      });
      // (Out through the mouth's coast side, down to the sea.)
      const side = mouthSide({ hexes: cells }, path);
      if (side >= 0) {
        const [q, r] = path[path.length - 1];
        const [x, z] = hexCenter(q, r);
        const [nx, nz] = hexCenter(q + SIDE_DIRS[side][0], r + SIDE_DIRS[side][1]);
        pts.push(new THREE.Vector3(x + (nx - x) * 0.5, TOP + 0.01, z + (nz - z) * 0.5), new THREE.Vector3(x + (nx - x) * 0.72, SEA_LEVEL + 0.04, z + (nz - z) * 0.72));
      }
      if (pts.length < 2) pts.push(pts[0].clone().add(new THREE.Vector3(0.01, 0, 0.3)));
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      const n = Math.max(8, pts.length * 10);
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = curve.getPoint(t);
        const d = curve.getTangent(t);
        const w = 0.07 + 0.05 * t;
        const nx = -d.z, nz = d.x;
        const l = Math.hypot(nx, nz) || 1;
        pos.push(p.x + (nx / l) * w, p.y, p.z + (nz / l) * w, p.x - (nx / l) * w, p.y, p.z - (nz / l) * w);
        if (i < n) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, this.riverMaterial);
      mesh.receiveShadow = true;
      mesh.renderOrder = 3;
      g.add(mesh);
      if (!this.still && (animateAll || path.some(([q, r]) => fresh.has(key(q, r))))) grow.push({ mesh, count: idx.length });
    }
    this.group.add(g);
    this.rivers = g;
    // A river just drawn runs down its course from the spring.
    for (const { mesh, count } of grow) {
      const geo = mesh.geometry as THREE.BufferGeometry;
      geo.setDrawRange(0, 0);
      this.world.animator.tween({ duration: 0.6, easing: ease.outCubic, update: (t) => geo.setDrawRange(0, Math.ceil((count * t) / 6) * 6), done: () => geo.setDrawRange(0, Infinity) });
    }
  }

  /** Each pressed piece's own height (see relief), and how far it stands out now (0 flat, 1 full). */
  private reliefBase = new Map<THREE.Object3D, number>();
  private reliefAt = new Map<THREE.Object3D, number>();
  private reliefGen = 0;

  /**
   * Press the island flat, a map lying just over the water as the flat board draws it (`to` 0), or
   * raise it back into relief (1). Every tile and what stands on it is squeezed towards that level
   * and stretched back out of it: rising, they spring up in a wave from the middle outwards, each
   * overshooting a little as if pushed up from below; going flat, they settle from the coast
   * inwards. Over `duration` s (at once with reduced motion); resolves when it's done.
   */
  relief(to: 0 | 1, duration = 1.2): Promise<void> {
    const gen = ++this.reliefGen;
    const pieces: THREE.Object3D[] = [...[...this.tiles.values()].map((t) => t.group), ...this.discs.values(), ...this.wells.values(), ...this.fogs.values(), ...this.harbours.values(), ...this.flags.values()];
    for (const g of [this.robber, this.corsair, this.rivers]) if (g) pieces.push(g);
    for (const g of pieces) if (!this.reliefBase.has(g)) this.reliefBase.set(g, g.position.y);
    const apply = (g: THREE.Object3D, u: number) => {
      const s = FLAT + (1 - FLAT) * u;
      g.scale.y = s;
      g.position.y = PRESSED + (this.reliefBase.get(g)! - PRESSED) * s;
      this.reliefAt.set(g, u);
    };
    const settle = () => {
      if (gen !== this.reliefGen || to !== 1) return;
      for (const [g, y] of this.reliefBase) {
        g.position.y = y;
        g.scale.y = 1;
      }
      this.reliefBase.clear();
      this.reliefAt.clear();
    };
    if (duration <= 0 || this.still) {
      for (const g of pieces) apply(g, to);
      settle();
      return Promise.resolve();
    }
    let reach = 1;
    for (const g of pieces) reach = Math.max(reach, Math.hypot(g.position.x, g.position.z));
    // (The wave takes the first part of the time to cross the island; each piece moves in the rest.)
    const spread = duration * 0.45;
    for (const g of pieces) {
      const from = this.reliefAt.get(g) ?? 1;
      const d = Math.hypot(g.position.x, g.position.z) / reach;
      this.world.animator.tween({
        delay: (to ? d : 1 - d) * spread,
        duration: duration - spread,
        easing: to ? ease.outBack : ease.inOutCubic,
        update: (t) => gen === this.reliefGen && !this.disposed && apply(g, from + (to - from) * t),
      });
    }
    return this.world.animator.wait(duration).then(settle);
  }

  /** A tile falling from the sky: down fast, squashed as it hits the sea, a bounce, then still. */
  private drop(g: THREE.Object3D, x: number, z: number, delay = 0, splash = true) {
    const H = 3.2;
    let hit = false;
    g.position.y = H;
    g.visible = delay === 0;
    this.world.animator.tween({
      delay,
      duration: 0.95,
      easing: ease.linear,
      update: (t) => {
        if (this.disposed) return;
        g.visible = true;
        const fall = 0.42;
        if (t < fall) {
          const u = t / fall;
          g.position.y = H * (1 - u * u);
          g.scale.set(0.92, 1.12, 0.92);
          return;
        }
        if (!hit) {
          hit = true;
          if (splash) this.splash(x, z);
          this.world.rig.addShake(0.006);
        }
        const s = (t - fall) / (1 - fall);
        // (A squash on landing, springing back with a little bounce that dies away.)
        const wob = Math.exp(-6 * s) * Math.cos(14 * s);
        g.position.y = 0.06 * Math.max(0, Math.sin(s * Math.PI * 2.2)) * (1 - s);
        g.scale.set(1 + 0.08 * wob, 1 - 0.16 * wob, 1 + 0.08 * wob);
      },
      done: () => {
        g.position.y = 0;
        g.scale.set(1, 1, 1);
        g.visible = true;
      },
    });
  }

  /** A tile going under: a tilt, down into the sea, gone. */
  private sink(g: THREE.Object3D, animate: boolean) {
    if (!animate) {
      this.release(g);
      return;
    }
    const tilt = (Math.random() - 0.5) * 0.4;
    this.ripple(g.position.x, g.position.z);
    this.world.animator.tween({
      duration: 0.7,
      easing: ease.inOutCubic,
      update: (t) => {
        g.position.y = -1.6 * t;
        g.rotation.z = tilt * t;
      },
      done: () => this.release(g),
    });
  }

  /** A disc, a jetty or a piece taken off: up and shrinking away. */
  private lift(g: THREE.Object3D, animate: boolean) {
    if (!animate) {
      this.release(g);
      return;
    }
    const y0 = g.position.y;
    this.world.animator.tween({
      duration: 0.3,
      easing: ease.inOutCubic,
      update: (t) => {
        g.position.y = y0 + t * 0.4;
        g.scale.setScalar(Math.max(0.001, 1 - t));
      },
      done: () => this.release(g),
    });
  }

  private release(g: THREE.Object3D) {
    this.group.remove(g);
    const keepGeo = new Set<THREE.BufferGeometry>([shapes.hex, this.badgePlane, ...Object.values(this.shared)]);
    const keepMat = new Set<THREE.Material>([this.material, this.fogMaterial, this.riverMaterial, this.seaMaterial, this.discSide]);
    g.traverse((o) => {
      // (The renderer keeps what it draws a mesh with until the mesh says it's gone: shared
      // geometry and the kept materials are never disposed, so each mesh says so itself.)
      o.dispose?.();
      if (!(o instanceof THREE.Mesh)) return;
      if (!keepGeo.has(o.geometry)) o.geometry.dispose();
      for (const m of [o.material].flat() as THREE.Material[]) if (!keepMat.has(m)) m.dispose();
      if (this.badges.delete(o)) (o.material as THREE.MeshBasicMaterial).map?.dispose();
    });
  }

  private splash(x: number, z: number) {
    const p = this.world.particles;
    waterBurst(p.spray, p.mist, { x, y: SEA_LEVEL + 0.03, z, count: 34, radius: 0.95, ring: true, up: [0.7, 1.5], out: [0.3, 0.7], size: 0.04 });
    // (Dust off the land as it settles.)
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      p.dust.emit({ x: x + Math.cos(a) * 0.7, y: TOP + 0.05, z: z + Math.sin(a) * 0.7, vx: Math.cos(a) * 0.25, vy: 0.15, vz: Math.sin(a) * 0.25, life: 0.9, size: 0.12, grow: 2, color: '#d8cdb4', alpha: 0.35, drag: 1.5 });
    }
  }

  private ripple(x: number, z: number) {
    const p = this.world.particles;
    waterBurst(p.spray, p.mist, { x, y: SEA_LEVEL + 0.02, z, count: 14, radius: 0.7, ring: true, up: [0.4, 0.8], out: [0.2, 0.4], size: 0.03 });
  }

  /** A disc (`n` 0: one still to be dealt) at (x, y, z) within its group, at `scale`. */
  private disc(n: number, x: number, y: number, z: number, scale: number) {
    let face = this.faces.get(n);
    if (!face) this.faces.set(n, (face = discFace(n)));
    const top = new THREE.MeshStandardMaterial({ map: face, roughness: 0.55 });
    const m = new THREE.Mesh(this.shared.disc, [this.discSide, top, this.discSide]);
    m.castShadow = true;
    m.position.set(x, y + 0.025 * scale, z);
    m.scale.setScalar(scale);
    // (The cylinder's cap is mapped a quarter turn round: turned back, the number reads from the south.)
    m.rotation.y = Math.PI / 2;
    return m;
  }

  private spinDown(g: THREE.Object3D, delay: number) {
    g.visible = false;
    this.world.animator.tween({
      delay,
      duration: 0.75,
      easing: ease.linear,
      update: (t) => {
        g.visible = true;
        const f = Math.min(1, t / 0.6);
        g.position.y = (1 - f * f) * 1.0 + (t > 0.6 ? Math.sin(((t - 0.6) / 0.4) * Math.PI) * 0.04 : 0);
        g.rotation.x = (1 - f) * Math.PI * 3;
        g.scale.setScalar(0.4 + 0.6 * Math.min(1, t * 1.8));
      },
      done: () => {
        g.position.y = 0;
        g.rotation.x = 0;
        g.scale.setScalar(1);
      },
    });
  }

  /** A jetty out from the middle of the coast side, with a post and the harbour's badge over the water. */
  private harbour(q: number, r: number, side: number, type: CustomPortType, animate: boolean) {
    const [hx, hz] = hexCenter(q, r);
    const a = CORNER_OFFSETS[side], b = CORNER_OFFSETS[(side + 1) % 6];
    const mx = hx + (a[0] + b[0]) / 2, mz = hz + (a[1] + b[1]) / 2;
    const out = Math.atan2(mz - hz, mx - hx);
    const g = new THREE.Group();
    g.position.set(mx, 0, mz);
    g.rotation.y = -out;
    const deck = new Builder();
    deck.add(shapes.box, '#8a5f3a', [0.3, TOP - 0.05, 0], [0.62, 0.04, 0.2]);
    for (const [dx, dz] of [[0.12, 0.09], [0.12, -0.09], [0.55, 0.09], [0.55, -0.09]]) deck.add(shapes.post, '#5b3d24', [dx, TOP - 0.3, dz], [0.025, 0.5, 0.025]);
    deck.add(shapes.post, '#5b3d24', [0.6, TOP + 0.15, 0], [0.025, 0.4, 0.025]);
    const jetty = new THREE.Mesh(deck.build(), this.material);
    jetty.castShadow = true;
    g.add(jetty);
    // (A plane kept facing the camera: the badge reads from any angle.)
    const badge = new THREE.Mesh(this.badgePlane, new THREE.MeshBasicMaterial({ map: badgeTexture(type), transparent: true, alphaTest: 0.05, side: THREE.DoubleSide }));
    badge.position.set(0.62, TOP + 0.55, 0);
    badge.scale.setScalar(0.5);
    badge.renderOrder = 3;
    g.add(badge);
    this.badges.add(badge);
    this.group.add(g);
    if (animate && !this.still) {
      jetty.scale.set(0.01, 1, 1);
      badge.scale.setScalar(0.001);
      this.world.animator.tween({ duration: 0.35, easing: ease.outCubic, update: (t) => jetty.scale.set(Math.max(0.01, t), 1, 1) });
      this.world.animator.tween({ delay: 0.25, duration: 0.45, easing: ease.outBack, update: (t) => badge.scale.setScalar(Math.max(0.001, 0.5 * t)) });
      const p = this.world.particles;
      waterBurst(p.spray, p.mist, { x: mx + Math.cos(out) * 0.5, y: SEA_LEVEL + 0.02, z: mz + Math.sin(out) * 0.5, count: 8, radius: 0.15, ring: true, up: [0.4, 0.7], out: [0.1, 0.3], size: 0.03 });
    }
    return g;
  }

  private robberFigure() {
    const b = new Builder();
    b.add(shapes.cone, '#2e2a27', [0, 0.16, 0], [0.09, 0.32, 0.09]);
    b.add(shapes.ball, '#2e2a27', [0, 0.36, 0], [0.065, 0.065, 0.065]);
    const m = new THREE.Mesh(b.build(), this.material);
    m.castShadow = true;
    const g = new THREE.Group();
    g.add(m);
    return g;
  }

  /** The middle and reach of the grid, for the camera. */
  static frame(radius: number) {
    return { distance: 8 + radius * 4.2, radius: 2 + radius * 1.6 };
  }

  dispose() {
    this.disposed = true;
    this.offFrame();
    for (const t of this.tiles.values()) this.release(t.group);
    for (const g of [...this.discs.values(), ...this.harbours.values(), ...this.wells.values(), ...this.fogs.values(), ...this.flags.values()]) this.release(g);
    for (const g of [this.robber, this.corsair, this.rivers]) if (g) this.release(g);
    for (const m of this.seas.values()) this.group.remove(m);
    this.grid?.geometry.dispose();
    this.ringGeometry.dispose();
    for (const t of this.faces.values()) t.dispose();
    for (const g of Object.values(this.shared)) g.dispose();
    for (const m of [this.material, this.fogMaterial, this.riverMaterial, this.seaMaterial, this.gridMaterial, this.aimMaterial, this.ghostMaterial, this.discSide]) m.dispose();
    this.badgePlane.dispose();
    this.world.stage.scene.remove(this.group);
  }
}
