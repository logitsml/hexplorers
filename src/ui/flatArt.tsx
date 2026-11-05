// The flat map's drawings for the expansions (FlatBoard.tsx lays them out): terrain glyphs in the
// 100-unit box the classic resource icons occupy, wells, fishing grounds, rivers, fog, pollution and
// the raider fleet. Everything here is plain SVG drawn in code, in the flat map's own hand: soft
// fills with a darker edge, a pale highlight, no black outlines. Colours are written as they show
// (the island's palettes are squared by the 3D materials, but SVG isn't).

import { memo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Board, Hex } from '../engine';
import type { RiverCourse } from '../render/board/riverCourse';
import type { TileInfo } from '../render/board/tiles';

export type Pt = [number, number];
type Project = (x: number, z: number) => Pt;

const f1 = (n: number) => n.toFixed(1);
const poly = (p: Pt[]) => p.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ');

/** A small deterministic scatter (so a hex looks the same each time it's drawn). */
const rand = (seed: number, i: number) => {
  const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

// ------------------------------------------------------------------- defs

/** Gradients and patterns the drawings share, once per map. `k` is the map's scale (px per hex radius). */
export const FlatDefs = memo(function FlatDefs({ k }: { k: number }) {
  const hatch = Math.max(5, k * 0.13);
  return (
    <defs>
      <linearGradient id="fa-gold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#fff0a0" />
        <stop offset="0.45" stopColor="#f0bc32" />
        <stop offset="1" stopColor="#b97a14" />
      </linearGradient>
      <linearGradient id="fa-stone" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#ece6d8" />
        <stop offset="0.55" stopColor="#cdc5b5" />
        <stop offset="1" stopColor="#a39b8c" />
      </linearGradient>
      <linearGradient id="fa-slate" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#c8574a" />
        <stop offset="1" stopColor="#8a3328" />
      </linearGradient>
      <radialGradient id="fa-pool" cx="0.42" cy="0.4" r="0.75">
        <stop offset="0" stopColor="#b6f0f0" />
        <stop offset="0.55" stopColor="#4fbad0" />
        <stop offset="1" stopColor="#2b8fae" />
      </radialGradient>
      <radialGradient id="fa-mist" cx="0.5" cy="0.5" r="0.62">
        <stop offset="0" stopColor="#f4f9fb" stopOpacity="0.82" />
        <stop offset="0.7" stopColor="#d5e5ee" stopOpacity="0.62" />
        <stop offset="1" stopColor="#c4d9e6" stopOpacity="0.32" />
      </radialGradient>
      <radialGradient id="fa-oil" cx="0.4" cy="0.35" r="0.7">
        <stop offset="0" stopColor="#4a443e" />
        <stop offset="1" stopColor="#14110f" />
      </radialGradient>
      <pattern id="fa-hatch" width={hatch} height={hatch} patternUnits="userSpaceOnUse" patternTransform="rotate(40)">
        <line x1="0" y1="0" x2="0" y2={hatch} stroke="#2a2420" strokeOpacity="0.34" strokeWidth={Math.max(1.2, k * 0.035)} />
      </pattern>
      <pattern id="fa-mist-hatch" width={hatch * 1.15} height={hatch * 1.15} patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">
        <line x1="0" y1="0" x2="0" y2={hatch * 1.15} stroke="#ffffff" strokeOpacity="0.5" strokeWidth={Math.max(1.2, k * 0.04)} />
      </pattern>
    </defs>
  );
});

// ---------------------------------------------------------------- glyph box

/** Draws its children in a 100-unit box of size `s` centred on (x, y): the classic icons' slot. */
export function Glyph({ x, y, s, label, children, className }: { x: number; y: number; s: number; label?: string; children: ReactNode; className?: string }) {
  return (
    <g className={className} transform={`translate(${f1(x - s / 2)} ${f1(y - s / 2)}) scale(${(s / 100).toFixed(4)})`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {children}
    </g>
  );
}

/** A lumpy nugget-like polygon about (cx, cy). */
function lump(cx: number, cy: number, r: number, seed: number, sides = 7): Pt[] {
  return Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2 + seed;
    const m = r * (0.82 + 0.28 * rand(seed, i));
    return [cx + Math.cos(a) * m, cy + Math.sin(a) * m * 0.88] as Pt;
  });
}

const spark = (x: number, y: number, r: number, fill = '#fff6c8') => (
  <path d={`M${x} ${y - r} Q${x + r * 0.16} ${y - r * 0.16} ${x + r} ${y} Q${x + r * 0.16} ${y + r * 0.16} ${x} ${y + r} Q${x - r * 0.16} ${y + r * 0.16} ${x - r} ${y} Q${x - r * 0.16} ${y - r * 0.16} ${x} ${y - r} Z`} fill={fill} />
);

// ------------------------------------------------------------ the glyphs

/** Bounty field: gold heaped in a pan. */
export const BountyGlyph = memo(function BountyGlyph(p: { x: number; y: number; s: number; label?: string }) {
  const nuggets: [number, number, number, number][] = [
    [34, 58, 12, 1.1],
    [66, 57, 13, 2.4],
    [50, 62, 11, 0.4],
    [42, 44, 14, 3.1],
    [62, 42, 12, 4.6],
    [51, 31, 12, 5.2],
  ];
  return (
    <Glyph {...p}>
      <g transform="translate(50 54) scale(1.16) translate(-50 -54)">
      <ellipse cx="52" cy="82" rx="40" ry="8" fill="#5c3b0e" opacity="0.3" />
      <ellipse cx="50" cy="70" rx="43" ry="17" fill="#3f3b36" />
      <ellipse cx="50" cy="68" rx="43" ry="16" fill="#58534b" stroke="#8d867a" strokeWidth="1.6" />
      <ellipse cx="50" cy="69" rx="35" ry="12" fill="#2f2c28" />
      {nuggets.map(([cx, cy, r, seed], i) => {
        const shape = lump(cx, cy, r, seed);
        return (
          <g key={i}>
            <polygon points={poly(shape)} fill="url(#fa-gold)" stroke="#9a6410" strokeWidth="1.4" strokeLinejoin="round" />
            <polygon points={poly(lump(cx - r * 0.25, cy - r * 0.3, r * 0.42, seed + 1, 5))} fill="#fff4b0" opacity="0.78" />
          </g>
        );
      })}
      {spark(78, 26, 8)}
      {spark(24, 30, 5.5)}
      {spark(66, 16, 4)}
      </g>
    </Glyph>
  );
});

/** Swamp: cattails and reeds standing in dark water. */
export const SwampGlyph = memo(function SwampGlyph(p: { x: number; y: number; s: number; label?: string }) {
  const stems: [number, number, number, boolean][] = [
    [24, 18, 66, false],
    [38, 34, 24, true],
    [52, 50, 14, true],
    [66, 72, 30, true],
    [80, 80, 58, false],
  ];
  return (
    <Glyph {...p}>
      <ellipse cx="52" cy="82" rx="42" ry="10" fill="#33503f" />
      <ellipse cx="52" cy="80" rx="40" ry="8.5" fill="#46684f" />
      <path d="M20 80 q12 -4 24 0 M52 83 q14 -4 28 0" fill="none" stroke="#a9cdb1" strokeOpacity="0.6" strokeWidth="1.6" strokeLinecap="round" />
      {stems.map(([bx, tx, ty, head], i) => (
        <g key={i}>
          <path d={`M${bx} 82 Q${(bx + tx) / 2 + (i % 2 ? 6 : -6)} ${(82 + ty) / 2} ${tx} ${ty}`} fill="none" stroke="#4d7a2a" strokeWidth="3" strokeLinecap="round" />
          {head && (
            <>
              <rect x={tx - 4.2} y={ty - 15} width="8.4" height="19" rx="4.2" fill="#6a3d20" stroke="#3d2411" strokeWidth="1.2" />
              <rect x={tx - 2.6} y={ty - 13} width="2.4" height="12" rx="1.2" fill="#a56a3a" opacity="0.85" />
              <path d={`M${tx} ${ty - 15} v-6`} stroke="#4d7a2a" strokeWidth="1.8" strokeLinecap="round" />
            </>
          )}
        </g>
      ))}
      {/* Blades, to either side of the stalks. */}
      <path d="M30 82 Q22 56 12 40 Q34 54 36 82 Z M60 82 Q62 52 74 38 Q70 62 70 82 Z M46 82 Q44 62 36 50 Q52 62 54 82 Z" fill="#8db84a" stroke="#4d7a2a" strokeWidth="1.2" strokeLinejoin="round" />
    </Glyph>
  );
});

/** Oasis: a palm leaning over a pool, a smaller one beyond. */
export const OasisGlyph = memo(function OasisGlyph(p: { x: number; y: number; s: number; label?: string }) {
  const frond = (cx: number, cy: number, a: number, len: number, key: string) => {
    const r = (a * Math.PI) / 180;
    const ex = cx + Math.cos(r) * len, ey = cy + Math.sin(r) * len + len * 0.28;
    const mx = cx + Math.cos(r) * len * 0.55, my = cy + Math.sin(r) * len * 0.55 - len * 0.22;
    const nx = -Math.sin(r) * len * 0.2, ny = Math.cos(r) * len * 0.2;
    return (
      <path key={key} d={`M${cx} ${cy} Q${mx + nx} ${my + ny} ${ex} ${ey} Q${mx - nx} ${my - ny} ${cx} ${cy} Z`} fill="#3f9440" stroke="#24632a" strokeWidth="1.1" strokeLinejoin="round" />
    );
  };
  return (
    <Glyph {...p}>
      <ellipse cx="46" cy="72" rx="42" ry="19" fill="#8fae52" />
      <ellipse cx="46" cy="72" rx="35" ry="14.5" fill="url(#fa-pool)" stroke="#2b8fae" strokeWidth="1.4" />
      <path d="M26 72 q8 -4 16 0 M50 76 q8 -4 16 0" fill="none" stroke="#e9fbfb" strokeOpacity="0.7" strokeWidth="1.5" strokeLinecap="round" />
      {/* the far palm */}
      <path d="M80 70 Q78 52 82 36" fill="none" stroke="#7a5230" strokeWidth="3.4" strokeLinecap="round" />
      {[-160, -125, -90, -55, -20].map((a, i) => frond(82, 36, a, 14, `f${i}`))}
      {/* the near palm, leaning out over the water */}
      <path d="M30 76 Q28 48 40 20" fill="none" stroke="#6f4a28" strokeWidth="6" strokeLinecap="round" />
      <path d="M30 76 Q28 48 40 20" fill="none" stroke="#a87a48" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 7" />
      {[-175, -145, -115, -85, -55, -25, 5].map((a, i) => frond(40, 20, a, 26, `n${i}`))}
      <circle cx="37" cy="24" r="3.4" fill="#5b3a1c" />
      <circle cx="44" cy="25" r="3.4" fill="#6c4623" />
    </Glyph>
  );
});

/** The castle's keep: a tall central tower, two lower ones, a gate and a pennant. */
export const CastleGlyph = memo(function CastleGlyph(p: { x: number; y: number; s: number; label?: string }) {
  const merlons = (x0: number, x1: number, y: number, n: number, key: string) => {
    const w = (x1 - x0) / (2 * n - 1);
    return Array.from({ length: n }, (_, i) => <rect key={`${key}${i}`} x={x0 + i * 2 * w} y={y - 6} width={w} height="7" fill="url(#fa-stone)" stroke="#6f675a" strokeWidth="1" />);
  };
  return (
    <Glyph {...p}>
      <ellipse cx="50" cy="86" rx="44" ry="8" fill="#2e2a24" opacity="0.32" />
      {/* the side towers */}
      <rect x="10" y="48" width="22" height="38" fill="url(#fa-stone)" stroke="#6f675a" strokeWidth="1.4" />
      <rect x="68" y="48" width="22" height="38" fill="url(#fa-stone)" stroke="#6f675a" strokeWidth="1.4" />
      {merlons(10, 32, 48, 3, 'l')}
      {merlons(68, 90, 48, 3, 'r')}
      {/* the keep */}
      <rect x="30" y="30" width="40" height="56" fill="url(#fa-stone)" stroke="#6f675a" strokeWidth="1.6" />
      <rect x="58" y="30" width="12" height="56" fill="#8a8274" opacity="0.4" />
      {merlons(30, 70, 30, 4, 'k')}
      <path d="M42 86 V68 a8 8 0 0 1 16 0 V86 Z" fill="#2e2a26" stroke="#4a4338" strokeWidth="1.2" />
      <path d="M50 54 v8 M38 44 v6 M62 44 v6 M17 62 v6 M83 62 v6" stroke="#4a4338" strokeWidth="2.6" strokeLinecap="round" />
      {/* the pennant */}
      <path d="M50 24 V4" stroke="#5b4630" strokeWidth="2" strokeLinecap="round" />
      <path d="M50 5 L68 10 L50 16 Z" fill="url(#fa-slate)" stroke="#6a2a20" strokeWidth="1.1" strokeLinejoin="round" />
    </Glyph>
  );
});

/** A dead tree on ashes: what is left of a hex pollution has taken every number from. */
export const WasteGlyph = memo(function WasteGlyph(p: { x: number; y: number; s: number; label?: string }) {
  return (
    <Glyph {...p}>
      <ellipse cx="50" cy="84" rx="40" ry="8" fill="#1d1916" opacity="0.4" />
      <path d="M12 84 q14 -10 28 -3 q14 -8 22 -2 q12 -6 26 5 Z" fill="#4b453d" />
      <path d="M50 84 C48 64 52 48 49 30 M49 56 L30 40 L24 24 M49 46 L68 34 L72 18 M50 66 L64 56 M49 36 L42 14" fill="none" stroke="#3a3128" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M50 82 C48 64 52 48 49 32 M49 56 L31 41 M49 46 L67 35" fill="none" stroke="#7d6c58" strokeWidth="1.3" strokeLinecap="round" opacity="0.8" />
      <path d="M14 76 l8 -3 M70 80 l10 -4 M30 70 l-4 -6" stroke="#1d1916" strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
    </Glyph>
  );
});

/**
 * An oil well as the island has it: a well-sweep over a stone-lined pit, its upright post holding a
 * long pole with a stone lashed to the short end and a bucket on a rope over the dark pit. The pit is
 * broad and nearly black, so the well reads on any hex with no backing of its own. (The oil's
 * gradient is the map's; drawn elsewhere, as in the rules' margin, it falls back to a flat pitch black.)
 */
export const OilWellGlyph = memo(function OilWellGlyph(p: { x: number; y: number; s: number; label?: string }) {
  const ink = '#2b2118';
  return (
    <Glyph {...p}>
      {/* the pit: a ring of stones round the oil */}
      <ellipse cx="44" cy="76" rx="42" ry="19" fill="#f6efe0" fillOpacity="0.8" />
      <ellipse cx="44" cy="76" rx="38" ry="16" fill="#a39a8c" stroke={ink} strokeWidth="2.4" />
      <ellipse cx="44" cy="76" rx="31" ry="11.5" fill="url(#fa-oil) #1d1915" />
      <path d="M26 74 q9 -3.4 18 -1.4" stroke="#ffd0a0" strokeOpacity="0.5" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      {/* the post, its foot in the ground */}
      <path d="M72 80 V32" stroke={ink} strokeWidth="9" strokeLinecap="round" />
      <path d="M72 79 V33" stroke="#8a6038" strokeWidth="5.6" strokeLinecap="round" />
      <path d="M67 31 L72 36 L77 31" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* the sweep: a long pole over the pit, a stone lashed to its short end */}
      <path d="M26 16 L90 42" stroke={ink} strokeWidth="8" strokeLinecap="round" />
      <path d="M26 16 L90 42" stroke="#a87a48" strokeWidth="4.8" strokeLinecap="round" />
      <circle cx="72" cy="34" r="2.4" fill="#3a3430" />
      <path d="M84 40 q8 -5 14 0 q4 7 -2 12 q-8 5 -13 -1 q-4 -6 1 -11 Z" fill="#857d71" stroke={ink} strokeWidth="2.4" strokeLinejoin="round" />
      {/* the rope and its bucket, raised dripping over the pit */}
      <path d="M28 17.5 V52" stroke="#5a4a3a" strokeWidth="2.2" />
      <path d="M21 52 H35 L33 65 H23 Z" fill="#8a6038" stroke={ink} strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M22 57 H34" stroke="#3a3430" strokeWidth="1.6" />
      <path d="M28 66 v4" stroke="#1d1915" strokeWidth="2.4" strokeLinecap="round" />
    </Glyph>
  );
});

// ------------------------------------------------------- ground and overlays

type TileArgs = { id: number; x: number; y: number; k: number; corners: Pt[] };

/**
 * What a terrain adds to its tile besides its icon: only the lake's water (a flat blue pool with a
 * pale edge), since every other tile keeps its one glyph and nothing else.
 */
export const TileGround = memo(function TileGround({ terrain, x, y, k, corners }: TileArgs & { terrain: string }) {
  if (terrain !== 'lake') return null;
  const water = corners.map(([cx, cy]) => [x + (cx - x) * 0.86, y + (cy - y) * 0.86] as Pt);
  return <polygon aria-hidden pointerEvents="none" points={poly(water)} fill="#4f8fb0" stroke="#bfe6f3" strokeOpacity="0.7" strokeWidth={Math.max(1.2, k * 0.03)} strokeLinejoin="round" />;
});

/**
 * Pollution over a land hex: greyed, and on a map big enough for it hatched, with dark smears; every
 * number gone, it's wasteland (ash, cracks). (A small map keeps only the grey: the hatching would
 * be noise there.)
 */
export const Blight = memo(function Blight({ id, x, y, k, corners, waste }: TileArgs & { waste: boolean }) {
  const crack = (a: number, len: number, j: number) => {
    let px = x, py = y;
    const pts: Pt[] = [[px, py]];
    for (let i = 1; i <= 4; i++) {
      const aa = a + (rand(id + j, i) - 0.5) * 0.9;
      px += Math.cos(aa) * len * 0.25 * k;
      py += Math.sin(aa) * len * 0.25 * k;
      pts.push([px, py]);
    }
    return <polyline key={j} points={poly(pts)} fill="none" stroke="#1f1a16" strokeOpacity="0.7" strokeWidth={Math.max(1.2, k * 0.028)} strokeLinecap="round" strokeLinejoin="round" />;
  };
  const fine = k >= 40;
  return (
    <g className="flat-blight" aria-hidden pointerEvents="none">
      <polygon points={poly(corners)} fill={waste ? '#5a544a' : '#4a443a'} opacity={waste ? 0.66 : 0.34} />
      {fine && <polygon points={poly(corners)} fill="url(#fa-hatch)" opacity={waste ? 0.9 : 0.7} />}
      {fine && waste ? Array.from({ length: 6 }, (_, j) => crack((j / 6) * Math.PI * 2 + rand(id, j) * 0.5, 0.78, j)) : null}
      {Array.from({ length: fine ? (waste ? 3 : 2) : 0 }, (_, i) => {
        const a = rand(id + 5, i) * Math.PI * 2;
        const r = (0.3 + rand(id + 6, i) * 0.4) * k;
        return <ellipse key={`s${i}`} cx={x + Math.cos(a) * r} cy={y + Math.sin(a) * r * 0.9} rx={k * 0.18} ry={k * 0.08} fill="#14110f" opacity="0.4" transform={`rotate(${rand(id, i) * 60 - 30} ${f1(x + Math.cos(a) * r)} ${f1(y + Math.sin(a) * r * 0.9)})`} />;
      })}
    </g>
  );
});

/** A fishing ground: one dashed ring round the disc. */
export const FishingGround = memo(function FishingGround({ x, y, k, disc }: { x: number; y: number; k: number; disc: number }) {
  // (Outside the disc even where the map is small enough for the disc to be the bigger of the two.)
  const R = Math.max(k * 0.56, disc + k * 0.12 + 2);
  return <circle aria-hidden pointerEvents="none" cx={x} cy={y} r={R} fill="none" stroke="#f1e7cd" strokeOpacity="0.8" strokeWidth={Math.max(1.2, k * 0.026)} strokeDasharray={`${f1(k * 0.08)} ${f1(k * 0.06)}`} strokeLinecap="round" />;
});

/** A face-down hex: mist hatched over open water, wisps drifting through it. `lifting`: it's just been turned up, and the mist rises. */
export const Mist = memo(function Mist({ x, y, k, corners, id, lifting = false }: TileArgs & { lifting?: boolean }) {
  const w = (dx: number, dy: number, key: number) => (
    <path key={key} className="flat-wisp" style={{ animationDelay: `${-key * 2.3}s` }} d={`M${f1(x + dx * k - k * 0.3)} ${f1(y + dy * k)} q${f1(k * 0.15)} ${f1(-k * 0.12)} ${f1(k * 0.3)} 0 t${f1(k * 0.3)} 0 t${f1(k * 0.3)} 0`} fill="none" stroke="#ffffff" strokeOpacity="0.7" strokeWidth={Math.max(2, k * 0.06)} strokeLinecap="round" />
  );
  return (
    <g className={`flat-mist${lifting ? ' lift' : ''}`} style={{ transformOrigin: `${f1(x)}px ${f1(y)}px` } as CSSProperties} aria-hidden pointerEvents="none">
      <polygon points={poly(corners)} fill="url(#fa-mist)" />
      <polygon points={poly(corners)} fill="url(#fa-mist-hatch)" />
      {w(-0.08, -0.46, 1)}
      {w(0.06, 0.02, 2)}
      {w(-0.1, 0.5, 3 + (id % 2))}
      <text x={x} y={y + k * 0.04} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(14, k * 0.52)} fill="#ffffff" fillOpacity="0.8" stroke="#6f8fa3" strokeOpacity="0.5" strokeWidth={Math.max(1, k * 0.02)} className="flat-num">
        ?
      </text>
    </g>
  );
});

// ------------------------------------------------------------------ rivers

/** A river's stretch across one hex, as the island plans it (render/board/riverCourse.ts), with the hex it crosses. */
export interface Stretch {
  hex: Hex;
  course: RiverCourse;
}

/** The island's planned river stretches: one for each river tile, taken from the tile set the 3D island was built from. */
export function riverStretches(tiles: readonly TileInfo[] | undefined): Stretch[] {
  return (tiles ?? []).filter((t) => t.shape.ctx.river).map((t) => ({ hex: t.hex, course: t.shape.ctx.river! }));
}

/** How much wider the map draws the water than the island does: a river a few pixels across would barely show on a flat board. */
const WIDEN = 1.5;

/**
 * The rivers as the map draws them, over the very course the island's rivers run (so the two views
 * agree: through each hex from the middle of the edge it enters by to the middle of the edge it
 * leaves by, square to both, bending round the disc and clear of the corners). Each stretch is one
 * flat blue with a thin darker outline; a spring is a round pool; in the swamp the water opens out
 * to the beach's edge (`clip`: the land with its beach, so the mouth ends at the shore rather than
 * spilling onto the sea as a pale blob).
 */
export const Rivers = memo(function Rivers({ stretches, P, k, clip }: { stretches: Stretch[]; P: Project; k: number; clip?: string }) {
  if (stretches.length === 0) return null;
  return (
    <g className="flat-rivers" aria-hidden pointerEvents="none">
      <g clipPath={clip ? `url(#${clip})` : undefined}>
      {stretches.map(({ hex, course: c }) => {
        const n = c.pts.length / 2;
        // The centreline in the hex's own coordinates, and the water's half-width along it (world units).
        const line: { x: number; z: number; h: number }[] = [];
        for (let i = 0; i < n; i++) {
          const u = i / (n - 1);
          // (The swamp's river opens out as it goes: from the width the last stretch came in with to a broad mouth.)
          const open = c.mouth ? 1 + 0.9 * u * u * (3 - 2 * u) : 1;
          line.push({ x: c.pts[i * 2], z: c.pts[i * 2 + 1], h: c.half[i] * WIDEN * open });
        }
        if (c.mouth) {
          // The estuary: on out past the coast edge, spreading (the clip ends it at the beach's edge).
          const a = ((-60 + 60 * c.out) * Math.PI) / 180;
          const dx = Math.cos(a), dz = Math.sin(a);
          const last = line[line.length - 1];
          const fan = [1.1, 1.28, 1.36, 1.28, 1.0, 0.45];
          fan.forEach((f, j) => line.push({ x: last.x + dx * 0.06 * (j + 1), z: last.z + dz * 0.06 * (j + 1), h: last.h * f }));
        }
        const at = (p: { x: number; z: number }): Pt => P(hex.x + p.x, hex.z + p.z);
        const ribbon = (grow: number): string => {
          const left: Pt[] = [], right: Pt[] = [];
          line.forEach((p, i) => {
            const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
            const dx = b.x - a.x, dz = b.z - a.z;
            const l = Math.hypot(dx, dz) || 1;
            const nx = -dz / l, nz = dx / l;
            const half = Math.max(1.6 / k, p.h + grow);
            left.push(at({ x: p.x + nx * half, z: p.z + nz * half }));
            right.push(at({ x: p.x - nx * half, z: p.z - nz * half }));
          });
          return `M${[...left, ...right.reverse()].map(([x, y]) => `${f1(x)} ${f1(y)}`).join(' L')} Z`;
        };
        const spring = at(line[0]);
        return (
          <g key={hex.id}>
            <path d={ribbon(0)} fill="#4f9fc6" stroke="#2c6d91" strokeWidth={Math.max(1, k * 0.022)} strokeLinejoin="round" />
            {c.in < 0 && <circle cx={spring[0]} cy={spring[1]} r={Math.max(3, k * 0.085)} fill="#4f9fc6" stroke="#2c6d91" strokeWidth={Math.max(1, k * 0.022)} />}
          </g>
        );
      })}
      </g>
    </g>
  );
});

// ------------------------------------------------------------- number discs

/** The smallest a number disc is drawn (px): the numbers must read on a phone. */
export const DISC_MIN = 11;

/** The smallest a disc of a hex with several numbers may shrink to (px), before they may crowd a corner. */
const DISC_FLOOR = 8;

/** The discs' places on a hex with several numbers, in disc radii from the group's middle: a row of two, a triangle of three, a square of four, then rows of three. */
function discGroup(n: number): Pt[] {
  const g = 1.06;
  if (n === 2) return [[-g, 0], [g, 0]];
  if (n === 3) return [[-g, 0.61], [g, 0.61], [0, -1.22]];
  if (n === 4) return [[-g, -g], [g, -g], [-g, g], [g, g]];
  const rows = Math.ceil(n / 3);
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / 3);
    const count = Math.min(3, n - row * 3);
    return [(i % 3 - (count - 1) / 2) * 2 * g, (row - (rows - 1) / 2) * 2 * g] as Pt;
  });
}

/**
 * Where a hex's number discs go, as offsets from its centre in px, and their radius. One disc sits
 * under the icon; several stand together as a group (see discGroup), sized to the largest that
 * keeps every disc inside the hex, clear of the others, and clear of a city at any corner, so a
 * piece never covers a number or its pips. The group sits under the icon, or higher on the hex
 * when that leaves the discs larger (the lake has no icon and centres them).
 */
export function discSpots(n: number, k: number, icon: boolean): { dx: number; dy: number; r: number }[] {
  if (n === 0) return [];
  if (n === 1) {
    const dy = icon ? k * 0.24 : 0;
    return [{ dx: 0, dy, r: Math.max(DISC_MIN, k * 0.29) }];
  }
  const unit = discGroup(n);
  // (A city's footprint round its corner, with its halo; and the hex's inside, short of the roads on its edges.)
  const city = Math.max(10, k * 0.3) * 1.45;
  const inside = k * 0.866 - Math.max(5, k * 0.16) * 0.8;
  const corners: Pt[] = Array.from({ length: 6 }, (_, i) => [Math.cos(((i * 60 - 90) * Math.PI) / 180) * k, Math.sin(((i * 60 - 90) * Math.PI) / 180) * k]);
  const fits = (r: number, cy: number) =>
    unit.every(([ux, uy]) => {
      const x = ux * r;
      const y = cy + uy * r;
      return Math.hypot(x, y) + r <= inside && corners.every(([cx, cz]) => Math.hypot(x - cx, y - cz) >= r + city);
    });
  const largest = (cy: number) => {
    for (let r = k * 0.27; r >= DISC_FLOOR; r -= 0.25) if (fits(r, cy)) return r;
    return 0;
  };
  const low = icon ? k * (n > 2 ? 0.2 : 0.28) : 0;
  let best = { cy: low, r: largest(low) };
  for (const cy of icon ? [low * 0.5, 0] : []) {
    const r = largest(cy);
    // (Higher only for a clearly larger disc: under the icon reads best.)
    if (r > best.r * 1.12) best = { cy, r };
  }
  const r = best.r || DISC_FLOOR;
  return unit.map(([ux, uy]) => ({ dx: ux * r, dy: best.cy + uy * r, r }));
}

// --------------------------------------------------- keeping pieces apart

/** What a badge or piece must stand clear of, in hex radii from the hex's centre: a circle, or (with `to`) a stretch of road. */
export interface Avoid {
  x: number;
  z: number;
  r: number;
  to?: [number, number];
  /** How much it matters (a soft thing, like the icon behind, counts for less). */
  w?: number;
}

/**
 * The candidate spot (offsets from a hex's centre, in hex radii) with the most room round a piece of
 * `radius` from everything in `avoid`; the first candidate wins a tie, so a piece stays where it
 * has always stood unless something is in the way.
 */
export function clearSpot(cands: Pt[], radius: number, avoid: Avoid[]): Pt {
  let best = cands[0], top = -Infinity;
  cands.forEach((c, i) => {
    const score = roomAt(c, radius, avoid) + (i === 0 ? 0.03 : 0);
    if (score > top) {
      top = score;
      best = c;
    }
  });
  return best;
}

/** How much room a badge of `radius` at `c` has from the nearest thing it must keep clear of (hex radii; negative where it overlaps). */
function roomAt([cx, cz]: Pt, radius: number, avoid: Avoid[]): number {
  let room = Infinity;
  for (const a of avoid) {
    let d: number;
    if (a.to) {
      const dx = a.to[0] - a.x, dz = a.to[1] - a.z;
      const l2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cz - a.z) * dz) / l2));
      d = Math.hypot(cx - (a.x + dx * u), cz - (a.z + dz * u));
    } else d = Math.hypot(cx - a.x, cz - a.z);
    room = Math.min(room, (d - a.r - radius) * (a.w ?? 1));
  }
  return room;
}

/** How big a harbour's tag is drawn (px, its half-width): on a small map still big enough for its 3:1 at 10 px. */
export const harbourRadius = (k: number) => Math.max(Math.min(16, k * 0.5), k * 0.27);

/** Where each harbour's badge stands, in world units: out from the middle of its edge, in the sea beyond the coast. */
export function harbourSpots(board: Board, down: readonly number[]): { port: Board['ports'][number]; x: number; z: number }[] {
  return board.ports
    .filter((port) => !down.includes(port.hex))
    .map((port) => {
      const h = board.hexes[port.hex];
      const [a, b] = port.vertices.map((v) => board.vertices[v]);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const len = Math.hypot(mx - h.x, mz - h.z) || 1;
      return { port, x: mx + ((mx - h.x) / len) * 0.62, z: mz + ((mz - h.z) / len) * 0.62 };
    });
}

// --------------------------------------------------------------- raiders

/**
 * Where a hex's raiders stand on the map, in px from its centre, and the token's radius: one token
 * for them all (Raider draws their count beside it), so it has room for a helmet that reads, set
 * between the hex's middle and its edge on the side of the coast they landed from (`coast`, a unit
 * direction in world x/z), and turned round from there as far as it takes to stay clear of the
 * hex's icon, discs and pieces (`avoid`, in hex radii). (Rows of small tokens along the top
 * covered the resource icon, the hex's identity.)
 */
export function raiderSpot(n: number, k: number, coast: Pt, avoid: Avoid[]): { dx: number; dy: number; r: number } | null {
  if (n <= 0) return null;
  const r = Math.max(8, k * 0.22);
  const [x, z] = ringSpot(coast, r / k, avoid);
  return { dx: x * k, dy: z * k, r };
}

/**
 * A spot for a token of `radius` (hex radii) between a hex's middle and its edge: towards `dir` if
 * that's clear, else turned round from there in steps of 30° to wherever has most room from what's
 * in `avoid`, the first direction being worth a little room.
 */
export function ringSpot(dir: Pt, radius: number, avoid: Avoid[], ring = 0.5): Pt {
  const a0 = Math.atan2(dir[1], dir[0]);
  let best: Pt = [Math.cos(a0) * ring, Math.sin(a0) * ring], top = -Infinity;
  // (A crowded hex, several discs and buildings round it, may only have room out by the rim: a
  // second, wider ring, worth a little less.)
  for (const [r, cost] of [[ring, 0], [ring + 0.14, 0.05]] as const)
    for (const step of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) {
      const a = a0 + (step * Math.PI) / 6;
      const c: Pt = [Math.cos(a) * r, Math.sin(a) * r];
      const score = roomAt(c, radius, avoid) - Math.abs(step) * 0.035 - cost;
      if (score > top) {
        top = score;
        best = c;
      }
    }
  return best;
}

/**
 * The trader (Guilds' venture): a market stall under an awning in its holder's colours, goods on the
 * counter, `mark` (the holder's seat mark) on its front. Drawn in a box of ±s round (x, y).
 */
export function TraderStall({ x, y, s, color, trim, mark, label }: { x: number; y: number; s: number; color: string; trim: string; mark?: ReactNode; label: string }) {
  const ink = '#2b2118';
  // The awning's scallops along its lower edge, alternating the holder's colour and canvas.
  const scallops = [-0.75, -0.25, 0.25, 0.75];
  return (
    <g role="img" aria-label={label}>
      <g transform={`translate(${f1(x)} ${f1(y)}) scale(${s.toFixed(2)})`} strokeLinejoin="round">
        <ellipse cx="0.12" cy="0.92" rx="1.05" ry="0.26" fill="#000" opacity="0.3" />
        <line x1="-0.78" y1="0.1" x2="-0.78" y2="-0.55" stroke="#5a3d22" strokeWidth="0.13" />
        <line x1="0.78" y1="0.1" x2="0.78" y2="-0.55" stroke="#5a3d22" strokeWidth="0.13" />
        <rect x="-0.92" y="0.05" width="1.84" height="0.78" rx="0.06" fill="#b98a52" stroke={ink} strokeOpacity="0.85" strokeWidth="0.1" />
        <line x1="-0.92" y1="0.3" x2="0.92" y2="0.3" stroke="#8a6038" strokeWidth="0.07" />
        <circle cx="-0.5" cy="-0.02" r="0.17" fill="#e0b84a" stroke={ink} strokeOpacity="0.6" strokeWidth="0.05" />
        <circle cx="-0.2" cy="-0.04" r="0.15" fill="#b95d33" stroke={ink} strokeOpacity="0.6" strokeWidth="0.05" />
        <circle cx="0.5" cy="-0.03" r="0.16" fill="#efe9dc" stroke={ink} strokeOpacity="0.6" strokeWidth="0.05" />
        <path d="M-1.05 -0.5 L-0.82 -1.12 H0.82 L1.05 -0.5 Z" fill={color} stroke={ink} strokeOpacity="0.85" strokeWidth="0.1" />
        <path d="M-0.42 -1.12 L-0.52 -0.5 H-0.18 L-0.14 -1.12 Z M0.14 -1.12 L0.18 -0.5 H0.52 L0.42 -1.12 Z" fill={trim} opacity="0.9" />
        {scallops.map((cx, i) => (
          <path key={i} d={`M${cx - 0.25} -0.5 a0.25 0.22 0 0 0 0.5 0 Z`} fill={i % 2 ? trim : color} stroke={ink} strokeOpacity="0.7" strokeWidth="0.07" />
        ))}
        {mark && <g transform="translate(0 0.56) scale(0.24)">{mark}</g>}
      </g>
    </g>
  );
}

/**
 * A raider token: a dark charcoal disc with a pale horned helmet on it (so it can't be mistaken for
 * a number's cream disc), its count beside it when there are several. Three conquer the hex: the
 * token's rim doubles.
 */
export function Raider({ x, y, r, n = 1 }: { x: number; y: number; r: number; n?: number }) {
  const conquered = n >= 3;
  const bone = '#e6dcc4';
  return (
    <g role="img" aria-label={n === 1 ? 'A raider' : `${n} raiders${conquered ? ': the hex is conquered' : ''}`}>
      <g transform={`translate(${f1(x)} ${f1(y)}) scale(${r.toFixed(2)})`}>
        <circle r="1" fill="#2c2825" stroke={bone} strokeWidth={conquered ? 0.2 : 0.12} />
        {conquered && <circle r="1.2" fill="none" stroke={bone} strokeWidth="0.1" />}
        <path d="M-0.5 -0.08 Q-0.96 -0.12 -0.88 -0.74 M0.5 -0.08 Q0.96 -0.12 0.88 -0.74" fill="none" stroke={bone} strokeWidth="0.2" strokeLinecap="round" />
        <path d="M-0.5 0.38 V-0.04 Q-0.5 -0.62 0 -0.62 Q0.5 -0.62 0.5 -0.04 V0.38 Z" fill={bone} />
        <rect x="-0.5" y="0.12" width="1" height="0.15" fill="#2c2825" />
        <path d="M0 0.12 V0.62" stroke="#2c2825" strokeWidth="0.17" strokeLinecap="round" />
      </g>
      {n > 1 && (
        <g transform={`translate(${f1(x + r * 0.78)} ${f1(y - r * 0.72)})`}>
          <circle r={Math.max(5.5, r * 0.5)} fill="#d4cdbf" stroke="#2c2825" strokeWidth={Math.max(1, r * 0.08)} />
          <text y={Math.max(5.5, r * 0.5) * 0.08} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(8, r * 0.72)} fontWeight="700" fill="#2c2825" className="flat-num">
            {n}
          </text>
        </g>
      )}
    </g>
  );
}

// ----------------------------------------------------------- the raider fleet

/** A longship seen from above, bow to +x: dark hull, a row of shields, oars, a striped square sail. */
function Longship({ s, tint = '#2a2522' }: { s: number; tint?: string }) {
  const L = s, W = s * 0.2;
  const oars = Array.from({ length: 6 }, (_, i) => -L * 0.55 + i * L * 0.22);
  return (
    <g>
      <g stroke="#e9dfc5" strokeOpacity="0.8" strokeWidth={Math.max(0.8, s * 0.035)} strokeLinecap="round">
        {oars.map((x, i) => (
          <g key={i}>
            <line x1={x} y1={-W * 0.9} x2={x - L * 0.1} y2={-W * 1.9} />
            <line x1={x} y1={W * 0.9} x2={x - L * 0.1} y2={W * 1.9} />
          </g>
        ))}
      </g>
      <path d={`M${-L} ${-W * 0.1} Q${-L * 0.6} ${-W * 1.1} ${-L * 0.05} ${-W} Q${L * 0.6} ${-W * 0.85} ${L} ${-W * 0.1} Q${L * 0.6} ${W * 0.85} ${-L * 0.05} ${W} Q${-L * 0.6} ${W * 1.1} ${-L} ${W * 0.1} Z`} fill={tint} stroke="#0f0c0a" strokeWidth={Math.max(0.8, s * 0.04)} strokeLinejoin="round" />
      <path d={`M${L * 0.98} ${-W * 0.1} q${L * 0.1} ${-W * 0.5} ${L * 0.02} ${-W * 1.4} q${-L * 0.03} ${W * 0.5} ${-L * 0.1} ${W * 0.8}`} fill={tint} stroke="#0f0c0a" strokeWidth={Math.max(0.8, s * 0.035)} strokeLinejoin="round" />
      <path d={`M${-L * 0.85} 0 H${L * 0.85}`} stroke="#5a4630" strokeWidth={Math.max(1, W * 0.42)} strokeLinecap="round" opacity="0.9" />
      {Array.from({ length: 7 }, (_, i) => (
        <circle key={i} cx={-L * 0.55 + i * L * 0.18} cy={i % 2 ? -W * 0.78 : W * 0.78} r={Math.max(0.9, W * 0.2)} fill={i % 2 ? '#c8a24a' : '#8c2b22'} />
      ))}
      <rect x={-L * 0.1} y={-W * 1.45} width={L * 0.24} height={W * 2.9} rx={W * 0.12} fill="#efe4c8" stroke="#8c7a55" strokeWidth={Math.max(0.8, s * 0.03)} />
      <rect x={-L * 0.1} y={-W * 1.45} width={L * 0.08} height={W * 2.9} fill="#a8322a" />
      <rect x={L * 0.06} y={-W * 1.45} width={L * 0.08} height={W * 2.9} fill="#a8322a" />
      <circle cx={L * 0.02} cy="0" r={Math.max(1, W * 0.22)} fill="#3a2a1a" />
    </g>
  );
}

/**
 * Where the fleet's track runs: out on the sea in a corner of `within` (a part of the window), clear of the island and its
 * harbours, from the far end (where the fleet sets out) to the near end (the landing). The corner is
 * the one with the most room, preferring the top ones (the hand and the dock fill the bottom).
 */
export function fleetTrack(board: Board, P: Project, k: number, cx: number, cy: number, within: { x: number; y: number; w: number; h: number }): { from: Pt; to: Pt } | null {
  const land: Pt[] = board.hexes.filter((h) => h.terrain !== 'sea').map((h) => P(h.x, h.z));
  const ports: Pt[] = board.ports.map((port) => {
    const h = board.hexes[port.hex];
    const [a, b] = port.vertices.map((v) => board.vertices[v]);
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const l = Math.hypot(mx - h.x, mz - h.z) || 1;
    return P(mx + ((mx - h.x) / l) * 0.62, mz + ((mz - h.z) / l) * 0.62);
  });
  // (The track's ends keep in by a margin and a longship's length, which stands out from its end.)
  const edge = Math.max(18, k * 0.3) + Math.max(14, k * 0.62);
  const hw = Math.min(cx - within.x, within.x + within.w - cx) - edge, hh = Math.min(cy - within.y, within.y + within.h - cy) - edge;
  let best: { from: Pt; to: Pt; score: number } | null = null;
  for (const [deg, bias] of [[-45, 0.12], [-135, 0.1], [-60, 0.02], [-120, 0.02], [-30, 0], [-150, 0], [45, -0.15], [135, -0.15]] as const) {
    const a = (deg * Math.PI) / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    const far = Math.min(hw / Math.abs(ux), hh / Math.abs(uy));
    const step = k * 0.05;
    // Walk in from the window's edge until something is in the way.
    let t = far;
    for (; t > 0; t -= step) {
      const qx = cx + ux * t, qy = cy + uy * t;
      if (land.some(([lx, ly]) => Math.hypot(qx - lx, qy - ly) < k * 1.5) || ports.some(([lx, ly]) => Math.hypot(qx - lx, qy - ly) < k * 0.75)) break;
    }
    const len = far - t - step;
    if (len < k * 0.8) continue;
    const score = len / k + bias;
    // (A short track: the seven steps about three-quarters of a hex apiece, never reaching further than the room allows.)
    const near = t + step * 1.5, out = Math.min(far, near + k * 5.6);
    if (!best || score > best.score) best = { from: [cx + ux * out, cy + uy * out], to: [cx + ux * near, cy + uy * near], score };
  }
  return best ? { from: best.from, to: best.to } : null;
}

/**
 * Whether a piece drawn at `at` should glide to where it is now: for a moment after `at` changes
 * (the robber to a new hex, the fleet a step on), and not when only the map under it moved
 * (`frame`: the layout, which changes on every step of a pan or a zoom), or it would trail behind.
 */
export function useGlide(at: unknown, frame: unknown, ms: number) {
  const seen = useRef({ at, frame, until: 0 });
  const s = seen.current;
  if (s.at !== at) {
    s.at = at;
    s.until = performance.now() + ms;
  }
  if (s.frame !== frame) {
    s.frame = frame;
    s.until = 0;
  }
  return performance.now() < s.until;
}

/** The raider fleet's track: a wake dashed out to the island, its stations, and the longships at the one they've reached. */
export function FleetTrack({ track, k, position, steps, epoch }: { track: { from: Pt; to: Pt }; k: number; position: number; steps: number; epoch: number }) {
  const { from, to } = track;
  const at = (i: number): Pt => [from[0] + (to[0] - from[0]) * (i / steps), from[1] + (to[1] - from[1]) * (i / steps)];
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const here = at(Math.min(position, steps));
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const s = Math.max(14, Math.min(k * 0.62, len / 4.5));
  const fs = Math.max(9, k * 0.2);
  const dot = Math.max(2.2, k * 0.045);
  const px = -Math.sin(ang), py = Math.cos(ang);
  const label = `Raider fleet: ${position} of ${steps} steps to the island`;
  const glide = useGlide(position, track, 1100);
  return (
    <g className="flat-fleet" role="img" aria-label={label}>
      <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke="#e6f3f7" strokeOpacity="0.4" strokeWidth={Math.max(1.5, k * 0.035)} strokeDasharray={`${f1(k * 0.1)} ${f1(k * 0.09)}`} strokeLinecap="round" />
      {position > 0 && <line x1={from[0]} y1={from[1]} x2={here[0]} y2={here[1]} stroke="#f4fbfd" strokeOpacity="0.8" strokeWidth={Math.max(2, k * 0.05)} strokeLinecap="round" />}
      {Array.from({ length: steps + 1 }, (_, i) => {
        const [x, y] = at(i);
        const landing = i === steps;
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={landing ? dot * 1.7 : dot} fill={i <= position ? '#f4fbfd' : '#0c4a6e'} stroke={landing ? '#8c2b22' : '#bfe0ec'} strokeOpacity={landing ? 1 : 0.8} strokeWidth={landing ? Math.max(1.4, dot * 0.7) : Math.max(1, dot * 0.4)} />
          </g>
        );
      })}
      {/* (Keyed by the attacks so far: after a landing the fleet is simply back at the start, not sailing back to it.) */}
      <g key={epoch} className="flat-fleet-ship" style={{ transform: `translate(${f1(here[0])}px, ${f1(here[1])}px)`, ...(!glide && { transition: 'none' }) }}>
        <g transform={`rotate(${f1((ang * 180) / Math.PI)})`}>
          <g className="flat-bob">
            <path d={`M${f1(-s * 1.05)} 0 L${f1(-s * 2.5)} ${f1(-s * 0.42)} M${f1(-s * 1.05)} 0 L${f1(-s * 2.5)} ${f1(s * 0.42)}`} fill="none" stroke="#f4fbfd" strokeOpacity="0.45" strokeWidth={Math.max(1, s * 0.07)} strokeLinecap="round" />
            <g transform={`translate(${f1(-s * 1.2)} ${f1(-s * 0.7)}) scale(0.6)`}><Longship s={s} /></g>
            <g transform={`translate(${f1(-s * 1.2)} ${f1(s * 0.7)}) scale(0.6)`}><Longship s={s} /></g>
            <Longship s={s} tint="#241f1c" />
          </g>
        </g>
        <g transform={`translate(${f1(px * s * 1.7)} ${f1(py * s * 1.7)})`}>
          <rect x={-fs * 1.3} y={-fs * 0.78} width={fs * 2.6} height={fs * 1.56} rx={fs * 0.78} fill="#f7efdc" stroke="#8c2b22" strokeWidth={Math.max(1, k * 0.025)} />
          <text x="0" y={fs * 0.06} textAnchor="middle" dominantBaseline="middle" fontSize={fs} fill="#8c2b22" className="flat-num">
            {position}/{steps}
          </text>
        </g>
      </g>
    </g>
  );
}
