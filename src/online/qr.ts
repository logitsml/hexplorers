// A small QR code encoder for the harbour's "show code": a room's link, so a friend at the same
// table points their phone's camera at it and comes aboard. Byte mode, error correction level M
// (about 15% of the code can be lost and it still reads, enough for a phone held at an angle over
// a glossy screen), versions 1 to 6: up to 106 bytes, and a room link is about 40. ISO/IEC 18004,
// with the structure of Project Nayuki's reference encoder.

/** Data codewords per version at level M, and how they split into blocks (each block gets `ec` codewords of its own). */
const VERSIONS: { data: number; blocks: number; ec: number }[] = [
  { data: 0, blocks: 0, ec: 0 },
  { data: 16, blocks: 1, ec: 10 },
  { data: 28, blocks: 1, ec: 16 },
  { data: 44, blocks: 1, ec: 26 },
  { data: 64, blocks: 2, ec: 18 },
  { data: 86, blocks: 2, ec: 24 },
  { data: 108, blocks: 4, ec: 16 },
];

export const QR_MAX_VERSION = 6;
/** Level M's two format bits (L 01, M 00, Q 11, H 10). */
const ECL_M = 0;

export interface QrCode {
  version: number;
  /** Modules on a side (17 + 4 × version). */
  size: number;
  mask: number;
  /** Row by row, true for a dark module. */
  modules: boolean[][];
}

// ------------------------------------------------------------------ Reed–Solomon over GF(256)

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
export function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial of this degree (its coefficients, highest power first, without the leading 1). */
function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

/** The error-correction codewords for a block of data. */
export function rsCodewords(data: readonly number[], degree: number): number[] {
  const div = rsDivisor(degree);
  const out = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    for (let i = 0; i < div.length; i++) out[i] ^= gfMul(div[i], factor);
  }
  return out;
}

// ------------------------------------------------------------------ the codewords

/** The smallest version this many bytes fit in (mode, an 8-bit count and the bytes), or null. */
export function versionFor(bytes: number): number | null {
  for (let v = 1; v <= QR_MAX_VERSION; v++) if (4 + 8 + bytes * 8 <= VERSIONS[v].data * 8) return v;
  return null;
}

/** The data codewords for `bytes` in version `v`: byte mode, count, the bytes, terminator and padding. */
export function dataCodewords(bytes: Uint8Array, v: number): number[] {
  const cap = VERSIONS[v].data * 8;
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** The final sequence: the blocks' data codewords interleaved, then their error correction interleaved. */
export function interleave(data: number[], v: number): number[] {
  const { blocks, ec } = VERSIONS[v];
  const per = data.length / blocks;
  const ds: number[][] = [];
  const es: number[][] = [];
  for (let b = 0; b < blocks; b++) {
    const d = data.slice(b * per, (b + 1) * per);
    ds.push(d);
    es.push(rsCodewords(d, ec));
  }
  const out: number[] = [];
  for (let i = 0; i < per; i++) for (const d of ds) out.push(d[i]);
  for (let i = 0; i < ec; i++) for (const e of es) out.push(e[i]);
  return out;
}

// ------------------------------------------------------------------ the symbol

/** The 15 format bits for level M and this mask (BCH(15,5), masked with 101010000010010). */
export function formatBits(mask: number): number {
  const data = (ECL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly m: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly size: number) {
    this.m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  /** A function module (finder, timing, alignment, format), at column x, row y. */
  set(x: number, y: number, dark: boolean) {
    this.m[y][x] = dark;
    this.fn[y][x] = true;
  }
}

function drawFunctions(g: Grid, v: number) {
  const n = g.size;
  // Timing patterns.
  for (let i = 0; i < n; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  // Finders, with their light separators.
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx,
          y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
  }
  // The one alignment pattern versions 2 to 6 have (the others its positions give overlap the finders).
  if (v >= 2) {
    const c = n - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // The format areas (written for real once the mask is chosen), and the dark module.
  drawFormat(g, 0);
}

function drawFormat(g: Grid, mask: number) {
  const n = g.size;
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, true);
}

/** The codewords' bits, two columns at a time from the bottom right, up then down, around the function modules. */
function drawCodewords(g: Grid, words: number[]) {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    // (The vertical timing pattern's column is skipped whole.)
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let k = 0; k < n; k++) {
      const y = upward ? n - 1 - k : k;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (g.fn[y][x] || i >= words.length * 8) continue;
        g.m[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function applyMask(g: Grid, mask: number) {
  const f = MASKS[mask];
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fn[y][x] && f(x, y)) g.m[y][x] = !g.m[y][x];
}

/** How hard a masked symbol is to read (lower is better): long runs, blocks, finder look-alikes and an uneven balance. */
export function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < n; y++) lines.push(m[y]);
  for (let x = 0; x < n; x++) lines.push(m.map((row) => row[x]));
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // A 1:1:3:1:1 run with four light modules on one side looks like a finder to a reader.
    for (let i = 0; i + 7 <= n; i++) {
      if (!finder.every((d, k) => line[i + k] === d)) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
      const lightAfter = i + 11 <= n && [0, 1, 2, 3].every((k) => !line[i + 7 + k]);
      if (lightBefore || lightAfter) score += 40;
    }
  }
  for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  let dark = 0;
  for (const row of m) for (const d of row) if (d) dark++;
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * The QR code for `text` (UTF-8). `mask` fixes the mask (0-7) rather than choosing the most
 * readable; `minVersion` makes it at least that big. Throws when the text is too long for version 6.
 */
export function encodeQr(text: string, o: { mask?: number; minVersion?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  const fit = versionFor(bytes.length);
  if (fit === null) throw new Error(`qr: ${bytes.length} bytes is more than version ${QR_MAX_VERSION} holds`);
  const v = Math.max(fit, Math.min(QR_MAX_VERSION, o.minVersion ?? 1));
  const words = interleave(dataCodewords(bytes, v), v);
  const size = 17 + 4 * v;
  const build = (mask: number) => {
    const g = new Grid(size);
    drawFunctions(g, v);
    drawCodewords(g, words);
    applyMask(g, mask);
    drawFormat(g, mask);
    return g;
  };
  let mask = o.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      const p = penalty(build(k).m);
      if (p < best) {
        best = p;
        mask = k;
      }
    }
  }
  return { version: v, size, mask, modules: build(mask).m };
}

/** The dark modules as one SVG path, a unit square each, offset by a quiet zone of `quiet` modules. */
export function qrPath(code: QrCode, quiet = 4): string {
  let d = '';
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      // (A run along the row is one rectangle.)
      let w = 1;
      while (x + w < code.size && code.modules[y][x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return d;
}
