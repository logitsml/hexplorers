// The tab icon's art: one hexagonal board tile per moment of play, drawn on a 64-unit canvas.
// A rim, a fill that says whose moment it is (a player's colour, gold for a win), and one glyph
// that says what (a die, a number token, a house, the robber...). Every glyph is measured once and
// fitted to the same size, centred on its ink, so the set reads alike at 16 px.

export type FaviconArt =
  | { kind: 'brand' }
  | { kind: 'loading'; progress: number }
  | { kind: 'roll'; color: string }
  | { kind: 'rolling'; color: string; total: number }
  | { kind: 'rolled'; color: string; total: number }
  | { kind: 'thinking'; color: string }
  | { kind: 'place'; color: string }
  | { kind: 'built'; color: string; what: 'road' | 'settlement' | 'city' }
  | { kind: 'offer'; left: number }
  | { kind: 'paused' }
  | { kind: 'replay'; progress: number }
  | { kind: 'won' }
  | { kind: 'lost'; color: string };

type Ctx = CanvasRenderingContext2D;

const TAU = Math.PI * 2;
const INK = '#2b2118';
const CREAM = '#f6e7c1';
const RIM = '#f3e2b8';
const RED = '#b3261e';
const BLUE = '#3d8bff';
const TRACK = '#e9dcb8';

/** How long the dice tumble before they land (seconds, at normal animation speed). */
export const TUMBLE = 1.1;

function hexPath(ctx: Ctx, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * TAU) / 6;
    const x = 32 + r * Math.cos(a), y = 32 + r * Math.sin(a);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

/** The point a fraction f (0..1, clockwise from the top corner) of the way round a hex. */
function hexPoint(r: number, f: number): [number, number] {
  const k = (((f % 1) + 1) % 1) * 6, i = Math.floor(k), u = k - i;
  const a0 = -Math.PI / 2 + (i * TAU) / 6, a1 = a0 + TAU / 6;
  return [32 + r * (Math.cos(a0) * (1 - u) + Math.cos(a1) * u), 32 + r * (Math.sin(a0) * (1 - u) + Math.sin(a1) * u)];
}

function hexArc(ctx: Ctx, r: number, from: number, to: number) {
  ctx.beginPath();
  ctx.moveTo(...hexPoint(r, from));
  for (let i = Math.floor(from * 6) + 1; i / 6 < to; i++) ctx.lineTo(...hexPoint(r, i / 6));
  ctx.lineTo(...hexPoint(r, to));
}

function lum(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k))));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/**
 * The tile: a dark outline (so it holds on light and dark tab strips alike), a rim, an optional
 * ring along the rim (progress, or a countdown), and the fill, lit from the top. Returns the
 * glyph colour that reads best on the fill.
 */
function tile(ctx: Ctx, fill: string, o: { rim?: string; glow?: number; ring?: { from?: number; to: number; color: string; track: string } } = {}) {
  const pale = contrast(fill, INK) > contrast(fill, CREAM);
  ctx.save();
  hexPath(ctx, 31.5);
  ctx.fillStyle = 'rgba(20,12,4,0.55)';
  ctx.fill();
  hexPath(ctx, 30.2);
  ctx.fillStyle = o.ring?.track ?? o.rim ?? (pale ? '#7a6650' : RIM);
  ctx.fill();
  if (o.ring && o.ring.to - (o.ring.from ?? 0) > 0.002) {
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = o.ring.color;
    hexArc(ctx, 28.3, o.ring.from ?? 0, o.ring.to);
    ctx.stroke();
  }
  hexPath(ctx, 26.4);
  const g = ctx.createLinearGradient(0, 8, 0, 56);
  g.addColorStop(0, shade(fill, 0.18));
  g.addColorStop(1, shade(fill, -0.16));
  ctx.fillStyle = g;
  ctx.fill();
  if (o.glow) {
    hexPath(ctx, 26.4);
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(255,255,255,${o.glow})`;
    ctx.stroke();
  }
  ctx.restore();
  return pale ? INK : CREAM;
}

/** A number disc, as on the board. */
function token(ctx: Ctx, r = 17.5, fill = CREAM) {
  ctx.beginPath();
  ctx.arc(32, 32, r, 0, TAU);
  ctx.fillStyle = 'rgba(20,12,4,0.35)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(32, 31, r, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
}

function numeral(ctx: Ctx, n: number, color: string) {
  const two = n >= 10;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `900 ${two ? 25 : 29}px "Fraunces Variable", Georgia, serif`;
  ctx.letterSpacing = two ? '-2px' : '0px';
  // Centred on the ink itself, not the advance box (digits differ in their side bearings).
  const m = ctx.measureText(String(n));
  ctx.fillText(String(n), 32 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2, 31 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  ctx.letterSpacing = '0px';
}

const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

function die(ctx: Ctx, face: number) {
  const s = 14.5;
  ctx.save();
  ctx.translate(32, 32);
  ctx.fillStyle = 'rgba(20,12,4,0.4)';
  ctx.beginPath();
  ctx.roundRect(-s, -s + 1.5, 2 * s, 2 * s, 5);
  ctx.fill();
  ctx.fillStyle = '#fffaf0';
  ctx.beginPath();
  ctx.roundRect(-s, -s, 2 * s, 2 * s, 5);
  ctx.fill();
  ctx.fillStyle = INK;
  for (const [x, y] of PIPS[face]) {
    ctx.beginPath();
    ctx.arc(x * 7.4, y * 7.4, face >= 4 ? 3.4 : 4.3, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function house(ctx: Ctx, color: string, city = false) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.fillStyle = color;
  ctx.beginPath();
  if (!city) {
    ctx.moveTo(-12, 12); ctx.lineTo(-12, -2); ctx.lineTo(0, -13); ctx.lineTo(12, -2); ctx.lineTo(12, 12);
  } else {
    // A hall with a tower.
    ctx.moveTo(-15, 12); ctx.lineTo(-15, 0); ctx.lineTo(-7, -7); ctx.lineTo(1, 0); ctx.lineTo(1, -8); ctx.lineTo(8, -15); ctx.lineTo(15, -8); ctx.lineTo(15, 12);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function road(ctx: Ctx, color: string) {
  ctx.save();
  ctx.translate(32, 32);
  ctx.rotate(-Math.PI / 6);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-17, -5, 34, 10, 3);
  ctx.fill();
  ctx.restore();
}

function robber(ctx: Ctx, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(32, 20.5, 6.5, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(24, 46); ctx.quadraticCurveTo(23, 30, 32, 27); ctx.quadraticCurveTo(41, 30, 40, 46);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(21, 43, 22, 5, 2.5);
  ctx.fill();
}

/** Two arrows passing: what you'd get (green, above) and give (red-brown, below), as in the trade dialog. */
function arrows(ctx: Ctx) {
  const arrow = (y: number, dir: number, color: string) => {
    const x0 = dir > 0 ? 16 : 48, x1 = dir > 0 ? 40 : 24, tip = dir > 0 ? 49 : 15;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, y - 3.6); ctx.lineTo(x1, y - 3.6); ctx.lineTo(x1, y - 9); ctx.lineTo(tip, y); ctx.lineTo(x1, y + 9); ctx.lineTo(x1, y + 3.6); ctx.lineTo(x0, y + 3.6);
    ctx.closePath();
    ctx.fill();
  };
  arrow(23, 1, '#2f7a43');
  arrow(41, -1, '#b0502f');
}

/** Three dots; with `t`, a wave runs through them. */
function dots(ctx: Ctx, color: string, t: number | null = null) {
  ctx.fillStyle = color;
  for (let i = 0; i < 3; i++) {
    const lift = t === null ? 0 : Math.max(0, Math.sin(t * 5 - i * 0.9)) * 4;
    ctx.beginPath();
    ctx.arc(19 + i * 13, 33 - lift, 5, 0, TAU);
    ctx.fill();
  }
}

function pause(ctx: Ctx) {
  ctx.fillStyle = CREAM;
  ctx.beginPath();
  ctx.roundRect(21, 19, 8, 26, 2);
  ctx.roundRect(35, 19, 8, 26, 2);
  ctx.fill();
}

function play(ctx: Ctx) {
  ctx.fillStyle = CREAM;
  ctx.beginPath();
  ctx.moveTo(25, 18); ctx.lineTo(46, 32); ctx.lineTo(25, 46);
  ctx.closePath();
  ctx.fill();
}

function crown(ctx: Ctx, color: string, jewel?: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(15, 43); ctx.lineTo(13, 21); ctx.lineTo(23.5, 31); ctx.lineTo(32, 16); ctx.lineTo(40.5, 31); ctx.lineTo(51, 21); ctx.lineTo(49, 43);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(15, 44.5, 34, 5, 2);
  ctx.fill();
  if (jewel) {
    ctx.fillStyle = jewel;
    ctx.beginPath();
    ctx.arc(32, 35, 3.4, 0, TAU);
    ctx.fill();
  }
}

function sparkles(ctx: Ctx, t: number) {
  for (const [x, y, phase] of [[14, 14, 0], [51, 17, 1.7], [49, 50, 3.1], [13, 47, 4.4]]) {
    const a = Math.max(0, Math.sin(t * 3 + phase));
    if (a < 0.05) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(a, a);
    ctx.fillStyle = '#fffbe8';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = i % 2 ? 1.6 : 6;
      ctx.lineTo(r * Math.cos((i * Math.PI) / 4), r * Math.sin((i * Math.PI) / 4));
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Each glyph's ink bounds (64-unit space), measured once by drawing it off screen. */
const boxes = new Map<string, { cx: number; cy: number; w: number; h: number }>();
function inkBox(key: string, shape: (ctx: Ctx) => void) {
  let b = boxes.get(key);
  if (b) return b;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.scale(4, 4);
  shape(x);
  const d = x.getImageData(0, 0, 256, 256).data;
  let x0 = 256, y0 = 256, x1 = -1, y1 = -1;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 40) continue;
    const p = (i - 3) / 4, px = p % 256, py = (p / 256) | 0;
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  b = { cx: (x0 + x1 + 1) / 8, cy: (y0 + y1 + 1) / 8, w: (x1 - x0 + 1) / 4, h: (y1 - y0 + 1) / 4 };
  boxes.set(key, b);
  return b;
}

/**
 * Each glyph's longer side in units, and where the eye wants it from the centre of its ink: a
 * house's light roof makes its box look low, a triangle's weight sits behind its point.
 */
const SIZES = {
  die: [30, 0, 0],
  house: [29, 0, -1],
  city: [31, 0, -1],
  road: [34, 0, 0],
  robber: [33, 0, -1],
  dots: [32, 0, 0],
  arrows: [32, 0, 0],
  pause: [27, 0, 0],
  play: [27, 1.2, 0],
  crown: [32, 0, -1],
} satisfies Record<string, [number, number, number]>;

/** Draw a glyph at its fitted size and centre; `shape` is the resting form that was measured. */
function fitted(ctx: Ctx, key: keyof typeof SIZES, paint: (ctx: Ctx) => void, o: { shape?: (ctx: Ctx) => void; scale?: number; rot?: number; dy?: number } = {}) {
  const b = inkBox(key, o.shape ?? paint);
  const [size, ox, oy] = SIZES[key];
  const k = (size / Math.max(b.w, b.h)) * (o.scale ?? 1);
  ctx.save();
  ctx.translate(32 + ox, 32 + oy + (o.dy ?? 0));
  if (o.rot) ctx.rotate(o.rot);
  ctx.scale(k, k);
  ctx.translate(-b.cx, -b.cy);
  paint(ctx);
  ctx.restore();
}

const ease = (x: number) => 1 - (1 - x) ** 3;

/** What a roll shows once landed: its number on a disc, or the robber for a seven. */
function landed(ctx: Ctx, total: number, k: number) {
  if (total === 7) {
    ctx.save();
    ctx.globalAlpha = k;
    fitted(ctx, 'robber', (c) => robber(c, '#f0e2c4'));
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.translate(32, 32);
  ctx.scale(0.7 + 0.3 * k, 0.7 + 0.3 * k);
  ctx.translate(-32, -32);
  token(ctx);
  numeral(ctx, total, total === 6 || total === 8 ? RED : INK);
  ctx.restore();
}

/** Paint `a` at `t` seconds into it (its animations are functions of t; any fixed t is a still). */
export function paintFavicon(ctx: Ctx, a: FaviconArt, t: number) {
  ctx.clearRect(0, 0, 64, 64);
  switch (a.kind) {
    case 'brand':
      tile(ctx, '#2f7d4a');
      token(ctx);
      numeral(ctx, 8, RED);
      return;
    case 'loading':
      tile(ctx, '#2f6f8f', { ring: { to: a.progress, color: BLUE, track: TRACK } });
      token(ctx, 13, 'rgba(246,231,193,0.92)');
      numeral(ctx, 8, RED);
      return;
    case 'roll': {
      // Your move: the die rocks and the rim breathes.
      tile(ctx, a.color, { glow: 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 4)) });
      fitted(ctx, 'die', (c) => die(c, 3), { shape: (c) => die(c, 1), rot: Math.sin(t * 4) * 0.12 });
      return;
    }
    case 'rolling': {
      tile(ctx, a.total === 7 && t > TUMBLE ? '#3b3f48' : a.color);
      const k = Math.min(1, t / TUMBLE);
      if (k < 1) {
        const face = 1 + (Math.floor(t * 14) % 6);
        fitted(ctx, 'die', (c) => die(c, face), { shape: (c) => die(c, 1), rot: (1 - ease(k)) * 9, scale: 0.75 + 0.25 * ease(k), dy: -Math.sin(k * Math.PI) * 4 });
      } else landed(ctx, a.total, Math.min(1, (t - TUMBLE) / 0.25));
      return;
    }
    case 'rolled':
      tile(ctx, a.total === 7 ? '#3b3f48' : a.color);
      landed(ctx, a.total, 1);
      return;
    case 'thinking': {
      const ink = tile(ctx, a.color);
      fitted(ctx, 'dots', (c) => dots(c, ink, t), { shape: (c) => dots(c, ink) });
      return;
    }
    case 'place': {
      const ink = tile(ctx, a.color, { glow: 0.2 + 0.3 * (0.5 + 0.5 * Math.sin(t * 4)) });
      fitted(ctx, 'house', (c) => house(c, ink));
      return;
    }
    case 'built': {
      // It pops in, overshooting a little, as the tile flashes.
      const k = ease(Math.min(1, t / 0.35));
      const ink = tile(ctx, a.color, { glow: 0.6 * (1 - Math.min(1, t / 1.2)) });
      const scale = 0.4 + 0.6 * k + Math.sin(Math.min(1, t / 0.5) * Math.PI) * 0.12;
      if (a.what === 'road') fitted(ctx, 'road', (c) => road(c, ink), { scale });
      else if (a.what === 'city') fitted(ctx, 'city', (c) => house(c, ink, true), { scale });
      else fitted(ctx, 'house', (c) => house(c, ink), { scale });
      return;
    }
    case 'offer': {
      // The rim is the time left to answer: green, then amber, then red.
      const color = a.left > 0.5 ? '#3f9a52' : a.left > 0.2 ? '#e0a020' : '#d2452f';
      tile(ctx, '#f1dfae', { ring: { from: 1 - a.left, to: 1, color, track: '#c8b48a' } });
      fitted(ctx, 'arrows', arrows);
      return;
    }
    case 'paused':
      tile(ctx, '#6d675f');
      fitted(ctx, 'pause', pause);
      return;
    case 'replay':
      tile(ctx, '#2f6f8f', { ring: { to: a.progress, color: BLUE, track: TRACK } });
      fitted(ctx, 'play', play);
      return;
    case 'won':
      tile(ctx, '#c08214', { rim: '#ffe9a8', glow: 0.35 + 0.25 * Math.sin(t * 3) });
      fitted(ctx, 'crown', (c) => crown(c, '#fff6dc', '#c0392b'));
      sparkles(ctx, t);
      return;
    case 'lost': {
      const ink = tile(ctx, a.color);
      fitted(ctx, 'crown', (c) => crown(c, ink));
      return;
    }
  }
}
