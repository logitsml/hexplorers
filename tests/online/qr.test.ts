import { describe, expect, it } from 'vitest';
import { dataCodewords, encodeQr, formatBits, qrPath, rsCodewords, versionFor, type QrCode } from '../../src/online/qr';

// A reader written apart from the encoder: it finds the format bits, takes the mask off, reads
// the codewords back in the zigzag, checks every block's Reed–Solomon syndromes come to zero and
// parses the byte-mode text out of them.

const BLOCKS: Record<number, { blocks: number; data: number; ec: number }> = {
  1: { blocks: 1, data: 16, ec: 10 },
  2: { blocks: 1, data: 28, ec: 16 },
  3: { blocks: 1, data: 44, ec: 26 },
  4: { blocks: 2, data: 32, ec: 18 },
  5: { blocks: 2, data: 43, ec: 24 },
  6: { blocks: 4, data: 27, ec: 16 },
};

/** GF(256) by log tables (the encoder multiplies bit by bit). */
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function syndromesZero(block: number[], ec: number) {
  for (let i = 0; i < ec; i++) {
    let s = 0;
    for (const c of block) s = mul(s, EXP[i]) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

function functionMap(size: number, version: number): boolean[][] {
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true;
  };
  // Finders with separators and the format areas beside them.
  mark(0, 0, 9, 9);
  mark(size - 8, 0, 8, 9);
  mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);
  if (version >= 2) mark(size - 9, size - 9, 5, 5);
  return fn;
}

function decode(q: QrCode): { text: string; mask: number } {
  const { size, modules: m } = q;
  const version = (size - 17) / 4;
  // The first copy of the format bits, around the top-left finder.
  let bits = 0;
  const at = (x: number, y: number) => (m[y][x] ? 1 : 0);
  const order: [number, number][] = [];
  for (let i = 0; i <= 5; i++) order.push([8, i]);
  order.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) order.push([14 - i, 8]);
  order.forEach(([x, y], i) => (bits |= at(x, y) << i));
  const raw = bits ^ 0x5412;
  expect(raw >>> 13).toBe(0); // level M
  const mask = (raw >>> 10) & 7;
  expect(formatBits(mask)).toBe(bits);
  // The second copy agrees.
  let second = 0;
  for (let i = 0; i < 8; i++) second |= at(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) second |= at(8, size - 15 + i) << i;
  expect(second).toBe(bits);
  expect(m[size - 8][8]).toBe(true);
  const masks = [
    (x: number, y: number) => (x + y) % 2 === 0,
    (_x: number, y: number) => y % 2 === 0,
    (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const fn = functionMap(size, version);
  const stream: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const up = ((right + 1) & 2) === 0;
    for (let k = 0; k < size; k++) {
      const y = up ? size - 1 - k : k;
      for (const x of [right, right - 1]) if (!fn[y][x]) stream.push((m[y][x] !== masks[mask](x, y)) ? 1 : 0);
    }
  }
  const spec = BLOCKS[version];
  const total = spec.blocks * (spec.data + spec.ec);
  const words: number[] = [];
  for (let i = 0; i < total; i++) words.push(stream.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  // De-interleave and check each block.
  const data: number[] = [];
  const blocks: number[][] = Array.from({ length: spec.blocks }, () => []);
  for (let i = 0; i < spec.data; i++) for (let b = 0; b < spec.blocks; b++) blocks[b].push(words[i * spec.blocks + b]);
  for (let i = 0; i < spec.ec; i++) for (let b = 0; b < spec.blocks; b++) blocks[b].push(words[spec.data * spec.blocks + i * spec.blocks + b]);
  for (const b of blocks) {
    expect(syndromesZero(b, spec.ec)).toBe(true);
    data.push(...b.slice(0, spec.data));
  }
  // Byte mode: 0100, an 8-bit count, then the bytes.
  const bitAt = (i: number) => (data[i >>> 3] >>> (7 - (i & 7))) & 1;
  const read = (from: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bitAt(from + i);
    return v;
  };
  expect(read(0, 4)).toBe(0b0100);
  const count = read(4, 8);
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = read(12 + i * 8, 8);
  return { text: new TextDecoder().decode(bytes), mask };
}

describe('qr', () => {
  it('computes Reed–Solomon codewords as the standard’s worked example does (HELLO WORLD, 1-M)', () => {
    // The data codewords of "HELLO WORLD" in alphanumeric mode at 1-M, and their ten
    // error-correction codewords, as worked through in thonky.com's QR tutorial.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsCodewords(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('writes level M’s format bits as the standard’s table has them', () => {
    // ISO/IEC 18004 Table C.1: M with masks 0 to 7.
    const table = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    table.forEach((t, mask) => expect(formatBits(mask).toString(2).padStart(15, '0')).toBe(t));
  });

  it('pads byte-mode data with the standard’s pad codewords', () => {
    const words = dataCodewords(new TextEncoder().encode('Hi'), 1);
    expect(words).toHaveLength(16);
    // 0100 | 00000010 | 'H' | 'i' | 0000, then 0xEC 0x11 alternating.
    expect(words.slice(0, 4)).toEqual([0x40, 0x24, 0x86, 0x90]);
    expect(words.slice(4, 8)).toEqual([0xec, 0x11, 0xec, 0x11]);
  });

  it('picks the smallest version that holds the text, up to version 6', () => {
    expect(versionFor(14)).toBe(1);
    expect(versionFor(15)).toBe(2);
    expect(versionFor(42)).toBe(3);
    expect(versionFor(62)).toBe(4);
    expect(versionFor(84)).toBe(5);
    expect(versionFor(106)).toBe(6);
    expect(versionFor(107)).toBeNull();
    expect(() => encodeQr('x'.repeat(107))).toThrow();
  });

  // (Each version once with the mask it chose, and every mask on one of them.)
  it('reads back what it wrote, at every version and mask', { timeout: 120_000 }, () => {
    const texts = ['Ahoy', 'http://192.168.1.20:5173/w/BCDFGH', 'https://hexplorers.xyz/r/KQ7M4P', 'x'.repeat(60), 'Ünïcödé ⚓ '.repeat(5), 'y'.repeat(106)];
    expect(texts.map((t) => encodeQr(t).version)).toEqual([1, 3, 3, 4, 5, 6]);
    for (const text of texts) expect(decode(encodeQr(text)).text).toBe(text);
    for (let mask = 0; mask < 8; mask++) expect(decode(encodeQr(texts[2], { mask }))).toEqual({ text: texts[2], mask });
    expect(decode(encodeQr('Ahoy', { minVersion: 2, mask: 5 }))).toEqual({ text: 'Ahoy', mask: 5 });
    expect(encodeQr('Ahoy', { minVersion: 4 }).version).toBe(4);
  });

  it('draws its finders where a reader looks for them', { timeout: 60_000 }, () => {
    const q = encodeQr('https://hexplorers.xyz/r/KQ7M4P');
    const n = q.size;
    for (const [x0, y0] of [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ]) {
      const row = (y: number) => q.modules[y0 + y].slice(x0, x0 + 7).map((d) => (d ? 1 : 0)).join('');
      expect([0, 1, 2, 3, 4, 5, 6].map(row)).toEqual(['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']);
    }
    // The path draws every dark module.
    const dark = q.modules.flat().filter(Boolean).length;
    const area = [...qrPath(q).matchAll(/h(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    expect(area).toBe(dark);
  });
});
