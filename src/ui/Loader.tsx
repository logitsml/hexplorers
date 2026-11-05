import { memo, useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { useUI } from '../game/store';
import { BEGINNER_LAYOUT, islandCoords, rowColToAxial } from '../engine/board';
import type { Terrain } from '../engine/types';

/*
 * The loading screen as a surveyor's blueprint: a chart of the outer isles (coastlines of every
 * size and shape with their contours and shoals, ships on the sea routes, and the surveyor's
 * own marks: triangulation, scribbled callouts, rocks, currents) scrolls past under a fixed frame,
 * while the island the game will play on is drafted hex by hex in the middle as it loads, each
 * terrain in its own hatching. All line work, white on blue. Everything that moves is a
 * transform (the chart, the ship) or a one-off stroke drawn in, so it stays smooth on phones
 * and keeps moving while the page is busy. Once the 3D island is ready the screen dives into it.
 */

const R = 50;
const SQ3 = Math.sqrt(3);
/** The chart sheet, in its own units: it repeats left to right. */
const SHEET_W = 1600;
const SHEET_H = 1000;

const hexPoints = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

/** A small seeded generator, so the chart is the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Isle = {
  x: number;
  y: number;
  r: number;
  /** Height over width, and a turn: islands long and short, lying every way. */
  squash: number;
  rot: number;
  /** Phases and strengths of the coast's wobbles (bays, headlands, small inlets). */
  phases: number[];
  amps: number[];
  kind: 'isle' | 'atoll' | 'islet';
};

/** A point on an island's outline scaled by `k` (1 the coast), its centre drawn towards the summit. */
function rim(s: Isle, k: number, a: number) {
  const w = 1 - k;
  const px = s.r * 0.2 * Math.cos(s.phases[0]), py = s.r * 0.2 * Math.sin(s.phases[1]);
  const wob = 1 + s.amps.reduce((sum, amp, j) => sum + amp * Math.sin([2, 3, 5, 9, 13][j] * a + s.phases[j] + w * (j + 1) * 0.6), 0);
  const lx = Math.cos(a) * s.r * k * wob + px * w, ly = Math.sin(a) * s.r * s.squash * k * wob + py * w;
  return [s.x + lx * Math.cos(s.rot) - ly * Math.sin(s.rot), s.y + lx * Math.sin(s.rot) + ly * Math.cos(s.rot)];
}

/** A closed outline round an island: its coast (k 1), a contour inside, or a shoal outside. */
function ring(s: Isle, k: number, points = 84) {
  return Array.from({ length: points }, (_, i) => rim(s, k, (Math.PI * 2 * i) / points).map((v) => v.toFixed(1)).join(',')).join(' ');
}

/** A hand-drawn loop: an uneven ellipse that overshoots where it closes, as a pen does. */
function scribbleLoop(rand: () => number, cx: number, cy: number, rx: number, ry: number) {
  const start = rand() * Math.PI * 2;
  const pts: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const a = start + (Math.PI * 2 * 1.12 * i) / 40;
    const j = 1 + (rand() - 0.5) * 0.08 + 0.05 * Math.sin(a * 3 + start);
    pts.push(`${(cx + Math.cos(a) * rx * j).toFixed(1)},${(cy + Math.sin(a) * ry * j).toFixed(1)}`);
  }
  return `M${pts.join('L')}`;
}

/** Everything on the chart, laid out once (seeded, so it is the same every time). */
function buildChart() {
  const rand = rng(11);
  const isles: Isle[] = [];
  const free = (x: number, y: number, r: number) => isles.every((p) => Math.hypot(p.x - x, p.y - y) > (p.r + r) * 1.15 + 26);
  const place = (r: number, kind: Isle['kind']) => {
    for (let t = 0; t < 400; t++) {
      const squash = kind === 'atoll' ? 0.8 + rand() * 0.2 : 0.45 + rand() * 0.55;
      const x = 50 + r + rand() * (SHEET_W - 100 - 2 * r);
      const y = 50 + r + rand() * (SHEET_H - 100 - 2 * r);
      if (!free(x, y, r)) continue;
      const rough = kind === 'islet' ? 0.6 : 1;
      const isle: Isle = {
        x,
        y,
        r,
        squash,
        rot: rand() * Math.PI,
        phases: [0, 1, 2, 3, 4].map(() => rand() * Math.PI * 2),
        amps: [0.08 + rand() * 0.14, 0.04 + rand() * 0.1, 0.02 + rand() * 0.06, 0.01 + rand() * 0.03, rand() * 0.02].map((v) => v * rough),
        kind,
      };
      isles.push(isle);
      return isle;
    }
    return null;
  };
  // Large to small, so the big ones find room first.
  for (const r of [170, 132, 108]) place(r, 'isle');
  for (const r of [86, 74, 62]) place(r, 'isle');
  place(60, 'atoll');
  for (const r of [48, 40, 34, 28, 22, 18]) place(r, 'isle');
  // Little archipelagos: a scatter of islets round a point.
  const clusters: { x: number; y: number; r: number }[] = [];
  for (let c = 0; c < 3; c++) {
    const hub = place(46, 'islet');
    if (!hub) continue;
    isles.pop();
    clusters.push(hub);
    const n = 4 + Math.floor(rand() * 4);
    const islets: { x: number; y: number; r: number }[] = [];
    for (let i = 0, t = 0; i < n && t < 200; t++) {
      const a = rand() * Math.PI * 2, d = rand() * hub.r * 1.1;
      const s = 6 + rand() * 11;
      const x = hub.x + Math.cos(a) * d, y = hub.y + Math.sin(a) * d * 0.7;
      // Apart from one another, with a channel of sea between.
      if (islets.some((o) => Math.hypot(o.x - x, o.y - y) < (o.r + s) * 1.25 + 4)) continue;
      islets.push({ x, y, r: s });
      i++;
      isles.push({
        ...hub,
        x,
        y,
        r: s,
        squash: 0.4 + rand() * 0.5,
        rot: rand() * Math.PI,
        phases: hub.phases.map(() => rand() * 6.28),
        amps: [0.18 + rand() * 0.15, 0.08 + rand() * 0.1, 0.04, 0.02, 0],
        kind: 'islet',
      });
    }
  }
  const main = isles.filter((s) => s.kind !== 'islet');
  const peak = (s: Isle) => rim(s, 0.001, 0);

  // Sea routes between neighbouring islands; ships under sail along some of them.
  const routes: { d: string; ship?: { x: number; y: number; angle: number; size: number } }[] = [];
  const linked = new Set<string>();
  for (const s of main) {
    const near = main.filter((o) => o !== s).sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y))[0];
    const key = [main.indexOf(s), main.indexOf(near)].sort().join('-');
    if (!near || linked.has(key) || routes.length >= 8) continue;
    linked.add(key);
    const nx = -(near.y - s.y), ny = near.x - s.x, len = Math.hypot(nx, ny) || 1;
    const bend = (rand() - 0.5) * 0.5 * len;
    const cx = (s.x + near.x) / 2 + (nx / len) * bend, cy = (s.y + near.y) / 2 + (ny / len) * bend;
    const route: (typeof routes)[number] = { d: `M${s.x.toFixed(0)} ${s.y.toFixed(0)}Q${cx.toFixed(0)} ${cy.toFixed(0)} ${near.x.toFixed(0)} ${near.y.toFixed(0)}` };
    if (routes.length % 2 === 0) {
      // A ship partway along, heading the way the route runs there.
      const t = 0.42 + rand() * 0.16;
      const bx = (1 - t) * (1 - t) * s.x + 2 * (1 - t) * t * cx + t * t * near.x, by = (1 - t) * (1 - t) * s.y + 2 * (1 - t) * t * cy + t * t * near.y;
      const tx = 2 * (1 - t) * (cx - s.x) + 2 * t * (near.x - cx), ty = 2 * (1 - t) * (cy - s.y) + 2 * t * (near.y - cy);
      if (main.every((o) => Math.hypot(o.x - bx, o.y - by) > o.r * 1.4)) route.ship = { x: bx, y: by, angle: Math.atan2(ty, tx), size: 1.1 + rand() * 0.5 };
    }
    routes.push(route);
  }
  // A few more ships out in open water, and rowing boats close in.
  const openWater = (x: number, y: number, m: number) => isles.every((o) => Math.hypot(o.x - x, o.y - y) > o.r * 1.45 + m);
  const ships: { x: number; y: number; angle: number; size: number; kind: 'ship' | 'boat' }[] = [];
  for (let t = 0; t < 300 && ships.length < 6; t++) {
    const x = 60 + rand() * (SHEET_W - 120), y = 60 + rand() * (SHEET_H - 120);
    if (!openWater(x, y, 30) || ships.some((s) => Math.hypot(s.x - x, s.y - y) < 160)) continue;
    ships.push({ x, y, angle: rand() * Math.PI * 2, size: 1 + rand() * 0.6, kind: ships.length % 3 === 2 ? 'boat' : 'ship' });
  }

  // Survey marks: triangulation between summits, callouts with scribbled codes, loops drawn
  // round the archipelagos, rocks, currents and the odd doodle in the margins.
  const stations = main.filter((s) => s.kind === 'isle' && s.r > 40).map(peak);
  const triangulation: string[] = [];
  for (let i = 0; i + 1 < stations.length; i++) {
    triangulation.push(`M${stations[i][0].toFixed(0)} ${stations[i][1].toFixed(0)}L${stations[i + 1][0].toFixed(0)} ${stations[i + 1][1].toFixed(0)}`);
    if (i + 2 < stations.length && i % 2 === 0) triangulation.push(`M${stations[i][0].toFixed(0)} ${stations[i][1].toFixed(0)}L${stations[i + 2][0].toFixed(0)} ${stations[i + 2][1].toFixed(0)}`);
  }
  const codes = ['A·3', 'B7', 'c.12', '?', 'D2', '41', 'E·9', '×', 'F4'];
  const callouts = main.slice(0, 9).map((s, i) => {
    const a = rand() * Math.PI * 2;
    const [cx, cy] = rim(s, 1, a);
    const out = 26 + rand() * 30;
    const ex = cx + Math.cos(a) * out, ey = cy + Math.sin(a) * out;
    const dir = Math.cos(a) >= 0 ? 1 : -1;
    return { d: `M${cx.toFixed(0)} ${cy.toFixed(0)}L${ex.toFixed(0)} ${ey.toFixed(0)}h${dir * 16}`, x: ex + dir * 20, y: ey + 4, anchor: dir > 0 ? 'start' : 'end', text: codes[i % codes.length] };
  });
  const loops = clusters.map((c) => scribbleLoop(rand, c.x, c.y, c.r * 1.5, c.r * 1.15));
  const rocks: [number, number][] = [];
  for (let t = 0; t < 400 && rocks.length < 26; t++) {
    const s = main[Math.floor(rand() * main.length)];
    const a = rand() * Math.PI * 2;
    const [x, y] = rim(s, 1.25 + rand() * 0.25, a);
    if (openWater(x, y, -s.r * 0.2)) rocks.push([x, y]);
  }
  const currents: string[] = [];
  for (let t = 0; t < 300 && currents.length < 4; t++) {
    const x = 80 + rand() * (SHEET_W - 240), y = 80 + rand() * (SHEET_H - 160);
    if (!openWater(x, y, 40) || !openWater(x + 120, y, 40)) continue;
    const lift = (rand() - 0.5) * 50;
    currents.push(`M${x.toFixed(0)} ${y.toFixed(0)}q60 ${lift.toFixed(0)} 120 0m-11 -7l11 7l-12 5`);
  }
  const doodles: string[] = [];
  for (let t = 0; t < 300 && doodles.length < 5; t++) {
    const x = 60 + rand() * (SHEET_W - 160), y = 60 + rand() * (SHEET_H - 120);
    if (!openWater(x, y, 30)) continue;
    let d = `M${x.toFixed(0)} ${y.toFixed(0)}`;
    const n = 4 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) d += `q${(5 + rand() * 4).toFixed(1)} ${(-7 - rand() * 5).toFixed(1)} ${(10 + rand() * 4).toFixed(1)} 0`;
    doodles.push(d);
  }
  // Depth soundings in open water.
  const soundings: { x: number; y: number; d: number }[] = [];
  for (let t = 0; t < 2000 && soundings.length < 40; t++) {
    const x = 40 + rand() * (SHEET_W - 80), y = 40 + rand() * (SHEET_H - 80);
    if (openWater(x, y, 14)) soundings.push({ x, y, d: Math.round(4 + rand() * 38) });
  }
  return { isles, routes, ships, triangulation, stations, callouts, loops, rocks, currents, doodles, soundings };
}

let chart: ReturnType<typeof buildChart> | null = null;

/**
 * A ship under sail, upright as charts draw them, facing the way it heads; its wake trails
 * behind along the course.
 */
function Ship({ x, y, angle, size, kind }: { x: number; y: number; angle: number; size: number; kind: 'ship' | 'boat' }) {
  const flip = Math.cos(angle) < 0;
  const course = (((flip ? Math.PI - angle : angle) * 180) / Math.PI + 540) % 360 - 180;
  return (
    <g className="bp-ship" transform={`translate(${x.toFixed(0)} ${y.toFixed(0)}) scale(${(flip ? -size : size).toFixed(2)} ${size.toFixed(2)})`}>
      <path className="wake" transform={`rotate(${course.toFixed(0)})`} d="M-16 3q-22 3 -50 11M-16 3q-24 -3 -48 -9" />
      {kind === 'boat' ? (
        <path d="M-10 -1Q-7 4 0 4Q7 4 10 -1ZM0 -1V-16M0 -15L8 -3H0Z" />
      ) : (
        <>
          <path d="M-17 -1Q-12 6 0 6Q12 6 17 -2Z" />
          <path d="M-5 -1V-27M7 -1V-21" />
          <path d="M-5 -26Q4 -17 -5 -5ZM7 -20Q14 -12 7 -4ZM7 -21L18 -3" />
        </>
      )}
    </g>
  );
}

/**
 * One sheet of the chart; copies side by side scroll as one. Memoised (it has no props): the
 * loader re-renders on every progress step, and the sheet is a few thousand SVG nodes.
 */
const ChartSheet = memo(function ChartSheet() {
  chart ??= buildChart();
  const c = chart;
  return (
    <svg className="bp-sheet" viewBox={`0 0 ${SHEET_W} ${SHEET_H}`} preserveAspectRatio="xMidYMid slice" aria-hidden>
      <g className="bp-grid">
        {Array.from({ length: SHEET_W / 40 }, (_, i) => (
          <line key={`v${i}`} x1={i * 40} y1={0} x2={i * 40} y2={SHEET_H} strokeOpacity={i % 5 ? 0.06 : 0.13} />
        ))}
        {Array.from({ length: SHEET_H / 40 + 1 }, (_, i) => (
          <line key={`h${i}`} x1={0} y1={i * 40} x2={SHEET_W} y2={i * 40} strokeOpacity={i % 5 ? 0.06 : 0.13} />
        ))}
      </g>
      <g className="bp-routes">
        {c.routes.map((r, i) => (
          <path key={i} d={r.d} />
        ))}
      </g>
      <g className="bp-survey">
        {c.triangulation.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      {c.isles.map((s, i) => (
        <g key={i} className="bp-isle">
          {s.kind !== 'islet' && <polygon className="bp-shoal far" points={ring(s, 1.36)} />}
          <polygon className="bp-shoal" points={ring(s, s.kind === 'islet' ? 1.5 : 1.16)} />
          <polygon className="bp-coast" points={ring(s, 1)} />
          {s.kind === 'atoll' && (
            <>
              <polygon className="bp-lagoon" points={ring(s, 0.68)} />
              <polygon className="bp-contour" points={ring(s, 0.84)} />
            </>
          )}
          {s.kind === 'isle' && [0.7, 0.44, 0.22].filter((k) => s.r * k > 9).map((k) => <polygon key={k} className="bp-contour" points={ring(s, k)} />)}
        </g>
      ))}
      <g className="bp-marks">
        {c.stations.map(([x, y], i) => (
          <g key={i}>
            <path className="bp-peak" d={`M${(x - 5).toFixed(0)} ${(y + 4).toFixed(0)}l5 -9l5 9z`} />
            <text className="bp-height" x={x + 9} y={y + 4}>
              {Math.round(120 + ((i * 97) % 280))}
            </text>
          </g>
        ))}
        {c.callouts.map((k, i) => (
          <g key={i}>
            <path d={k.d} />
            <text className="bp-note" x={k.x} y={k.y} textAnchor={k.anchor as 'start' | 'end'}>
              {k.text}
            </text>
          </g>
        ))}
        {c.loops.map((d, i) => (
          <path key={i} className="bp-loop" d={d} />
        ))}
        {c.rocks.map(([x, y], i) => (
          <path key={i} d={i % 3 ? `M${(x - 3).toFixed(1)} ${y.toFixed(1)}h6M${x.toFixed(1)} ${(y - 3).toFixed(1)}v6` : `M${(x - 3).toFixed(1)} ${(y - 3).toFixed(1)}l6 6M${(x + 3).toFixed(1)} ${(y - 3).toFixed(1)}l-6 6`} />
        ))}
        {c.currents.map((d, i) => (
          <path key={i} className="bp-current" d={d} />
        ))}
        {c.doodles.map((d, i) => (
          <path key={i} className="bp-doodle" d={d} />
        ))}
      </g>
      <g className="bp-ships">
        {c.routes.map((r, i) => r.ship && <Ship key={`r${i}`} {...r.ship} kind="ship" />)}
        {c.ships.map((s, i) => (
          <Ship key={i} {...s} />
        ))}
      </g>
      <g className="bp-soundings">
        {c.soundings.map((p, i) => (
          <text key={i} x={p.x} y={p.y}>
            {p.d}
          </text>
        ))}
      </g>
      {/* A compass rose and a scale, as on any survey sheet. */}
      <g className="bp-rose" transform="translate(760 470)">
        <circle r={46} />
        <circle r={38} strokeDasharray="2 4" />
        {Array.from({ length: 32 }, (_, k) => {
          const a = (Math.PI * 2 * k) / 32, l = k % 8 === 0 ? 30 : k % 4 === 0 ? 20 : 10;
          return <line key={k} x1={Math.sin(a) * (46 - l)} y1={-Math.cos(a) * (46 - l)} x2={Math.sin(a) * 46} y2={-Math.cos(a) * 46} />;
        })}
        <path d="M0 -60L7 -12L0 -18L-7 -12Z" />
        <text y={-66} textAnchor="middle">
          N
        </text>
      </g>
      <g className="bp-scale" transform="translate(90 940)">
        {[0, 1, 2, 3, 4].map((k) => (
          <rect key={k} x={k * 40} y={0} width={40} height={6} className={k % 2 ? 'fill' : ''} />
        ))}
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <text key={k} x={k * 40} y={22} textAnchor="middle">
            {k}
          </text>
        ))}
        <text x={230} y={6}>
          leagues
        </text>
      </g>
    </svg>
  );
});

/** Each terrain's hatching, as a draughtsman would mark it. */
const HATCH: Record<Terrain, string> = {
  forest: 'bp-forest',
  pasture: 'bp-pasture',
  fields: 'bp-fields',
  hills: 'bp-hills',
  mountains: 'bp-mountains',
  desert: 'bp-desert',
  bounty: 'bp-fields',
  swamp: 'bp-pasture',
  lake: 'bp-desert',
  oasis: 'bp-desert',
  castle: 'bp-mountains',
  sea: 'bp-desert',
};

function Hatches() {
  return (
    <defs>
      <pattern id="bp-forest" width={14} height={12} patternUnits="userSpaceOnUse">
        <circle cx={3.5} cy={3.5} r={2.6} />
        <circle cx={10.5} cy={9.5} r={2.6} />
      </pattern>
      <pattern id="bp-pasture" width={12} height={10} patternUnits="userSpaceOnUse">
        <path d="M1.5 7l1.6-3.2 1.6 3.2M7.5 3l1.4-2.6 1.4 2.6" />
      </pattern>
      <pattern id="bp-fields" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
        <path d="M0 3H6" />
      </pattern>
      <pattern id="bp-hills" width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <path d="M0 0V7M0 0H7" />
      </pattern>
      <pattern id="bp-mountains" width={16} height={11} patternUnits="userSpaceOnUse">
        <path d="M1 9l4-6.5 4 6.5M9 10.5l3-4.5 3 4.5" />
      </pattern>
      <pattern id="bp-desert" width={10} height={10} patternUnits="userSpaceOnUse">
        <circle cx={2.5} cy={2.5} r={0.8} className="dot" />
        <circle cx={7.5} cy={7} r={0.8} className="dot" />
      </pattern>
    </defs>
  );
}

/** The beginner island's tiles, charted from the middle outwards. */
function useTiles() {
  return useMemo(() => {
    const terrain = new Map<string, [Terrain, number | null]>();
    BEGINNER_LAYOUT.forEach((row, ri) =>
      row.forEach((cell, ci) => {
        const [q, r] = rowColToAxial(ri + 1, ci + 1);
        terrain.set(`${q},${r}`, cell);
      }),
    );
    return islandCoords()
      .map(([q, r]) => {
        const [t, n] = terrain.get(`${q},${r}`) ?? ['desert', null];
        return { q, r, t, n, x: R * SQ3 * (q + r / 2), y: R * 1.5 * r };
      })
      .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  }, []);
}

/** The island being drafted: each hex drawn in, hatched and numbered as loading goes on. */
function DraftIsland({ progress }: { progress: number }) {
  return <DraftTiles shown={Math.min(TILE_COUNT, Math.floor(progress * (TILE_COUNT + 2)))} />;
}

const TILE_COUNT = islandCoords().length;

/** (Memoised on how many tiles are drawn, which changes far less often than the progress.) */
const DraftTiles = memo(function DraftTiles({ shown }: { shown: number }) {
  const tiles = useTiles();
  const W = R * SQ3 * 2.5;
  return (
    <svg className="bp-island" viewBox="-270 -250 540 520" aria-hidden>
      <Hatches />
      <polygon className={`bp-bound${shown > 0 ? ' on' : ''}`} points={hexPoints(0, 0, R * 5.3)} transform="rotate(30)" />
      {tiles.map((h, i) => (
        <g key={`${h.q},${h.r}`} className={`bp-hex${i < shown ? ' on' : ''}`}>
          <polygon className="hatch" points={hexPoints(h.x, h.y, R - 7)} fill={`url(#${HATCH[h.t]})`} />
          <polygon className="edge" points={hexPoints(h.x, h.y, R - 2)} pathLength={1} />
          {h.n !== null && (
            <g className="disc">
              <circle cx={h.x} cy={h.y} r={13} />
              <text x={h.x} y={h.y + 4.5} textAnchor="middle">
                {h.n}
              </text>
            </g>
          )}
        </g>
      ))}
      {/* A dimension line under it, as on any drawing. */}
      <g className={`bp-dim${shown >= tiles.length ? ' on' : ''}`}>
        <path d={`M${-W} 232V250M${W} 232V250M${-W} 241H-64M64 241H${W}M${-W} 241l9 -4v8zM${W} 241l-9 -4v8z`} />
        <text x={0} y={245} textAnchor="middle">
          5 leagues
        </text>
      </g>
    </svg>
  );
});

/** Progress as a sea route: the ship sails it left to right, inking the way behind it. */
function Route({ progress }: { progress: number }) {
  // Only ever forward, whatever a step reports.
  const furthest = useRef(0);
  furthest.current = Math.max(furthest.current, Math.min(1, Math.max(0, progress)));
  const p = furthest.current;
  const done = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  // The ship eases towards the progress a frame at a time. (A CSS transition, retargeted as each
  // step comes in after the page has been busy building shaders, can restart from where Safari
  // last saw it, behind where it was drawn: the ship would jump back and sail on again. Moved each
  // frame it can only pause through a busy moment, never sail backwards.)
  useEffect(() => {
    let raf = 0, at = 0, last = performance.now();
    const sail = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const to = furthest.current;
      at = to - at < 0.0005 ? to : at + (to - at) * Math.min(1, dt * 3.2);
      if (done.current) done.current.style.transform = `scaleX(${at})`;
      if (head.current) head.current.style.transform = `translateX(${at * 100}%)`;
      raf = requestAnimationFrame(sail);
    };
    raf = requestAnimationFrame(sail);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="bp-route" role="progressbar" aria-label="Loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
      <div className="bp-route-line" />
      <div className="bp-route-done" ref={done} />
      <div className="bp-route-head" ref={head}>
        <svg className="bp-route-ship" viewBox="-16 -26 32 32" aria-hidden>
          <g className="bp-ship-bob">
            <path d="M-13 0H13L8.5 6H-8.5Z" />
            <path d="M-1 -1V-24M-1 -22L10 -5H-1Z" />
            <path d="M-3 -18L-12 -5H-3Z" />
            <path d="M-1 -24l6 2l-6 2" />
          </g>
        </svg>
      </div>
      <span className="bp-route-end" aria-hidden />
    </div>
  );
}

export function Loader() {
  const { label, progress, error, lost } = useUI((s) => s.loading);
  return (
    <motion.div className="loader bp" exit={{ opacity: 0, scale: 1.5, transition: { duration: 0.8, ease: [0.55, 0, 0.75, 0.2] } }}>
      <div className="bp-sea" aria-hidden>
        <div className="bp-drift">
          <ChartSheet />
          <ChartSheet />
        </div>
      </div>
      <div className="bp-frame" aria-hidden />
      <div className="bp-body">
        <h1 className="logo">Hexplorers</h1>
        <DraftIsland progress={error ? 0 : progress} />
        {error ? (
          <div className="loader-error parchment" role="alert">
            <p>{lost ? 'The 3D view stopped.' : 'The 3D view couldn’t start.'}</p>
            <p className="detail">{error}</p>
            <button className="btn gold" onClick={() => location.reload()}>
              {lost ? 'Reload' : 'Try again'}
            </button>
          </div>
        ) : (
          <div className="bp-progress">
            <Route progress={progress} />
            {/* (A CSS fade, keyed on the label: it runs on the compositor, so it finishes while the
                page is busy compiling shaders, where a letter-by-letter morph froze half-drawn.) */}
            <div className="loader-label" aria-live="polite">
              <span key={label}>{label}</span>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
