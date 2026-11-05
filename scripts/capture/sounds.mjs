// Every sound in the palette rendered offline and measured, for auditioning a new voice and checking
// it against the old ones. It starts its own Vite dev server on a free port, renders each sound in a
// headless Chromium through an OfflineAudioContext (src/audio/sfx.ts `renderSound`: the game's own
// mastering, centred, at full volume), writes a WAV of each and prints a table.
//
//   node scripts/capture/sounds.mjs                        every sound, into shots/sounds/
//   node scripts/capture/sounds.mjs --only horn,fanfare     only these (a name can carry a rate: horn@1.12)
//   node scripts/capture/sounds.mjs --takes 3               render each three times (the recipes are random) and average
//   node scripts/capture/sounds.mjs --out some/folder       another folder
//   CHROME_PATH=...                                 another Chromium (see scripts/lib/chrome.mjs)
//
// Columns: peak (sample peak, dBFS), mom (the loudest 400 ms, K-weighted, LUFS: how loud it lands),
// int (gated integrated loudness, LUFS), len (seconds until it stays 45 dB under its loudest 50 ms),
// centroid (the spectral centroid of its loudest 400 ms, Hz: how bright it is).

import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const out = resolve(opt('out', 'shots/sounds'));
const takes = Math.max(1, Number(opt('takes', 1)));
const only = opt('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SR = 48000;


const freePort = () =>
  new Promise((ok, fail) => {
    const s = net.createServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

// ------------------------------------------------------------------ measuring

/** A biquad run over a signal (direct form I). */
function biquad(x, b, a) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1, x1 = x[i], y2 = y1, y1 = v;
    y[i] = v;
  }
  return y;
}

/** The loudness meter's K-weighting at 48 kHz: a high shelf for the head, then a high-pass. */
const kWeight = (x) =>
  biquad(biquad(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]), [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);

/** Mean square of a stereo signal in windows of `win` samples stepped by `hop`. */
function blocks(chs, win, hop) {
  const n = chs[0].length;
  const out = [];
  for (let i = 0; i + win <= n; i += hop) {
    let s = 0;
    for (const c of chs) for (let j = i; j < i + win; j++) s += c[j] * c[j];
    out.push({ at: i, ms: s / win });
  }
  return out;
}

const lufs = (ms) => -0.691 + 10 * Math.log10(Math.max(1e-12, ms));
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

/** In-place radix-2 FFT (re, im of length 2^k). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]], [im[i], im[j]] = [im[j], im[i]];
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr;
        im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

/** Spectral centroid over a stretch of the (mono-summed) signal, from Hann-windowed 4096-sample frames. */
function centroid(mono, from, to) {
  const N = 4096;
  let num = 0, den = 0;
  for (let i = from; i + N <= to; i += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let j = 0; j < N; j++) re[j] = mono[i + j] * (0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (N - 1)));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      num += m * ((k * SR) / N);
      den += m;
    }
  }
  return den > 0 ? num / den : 0;
}

function measure(chs) {
  let peak = 0;
  for (const c of chs) for (const v of c) peak = Math.max(peak, Math.abs(v));
  const k = chs.map(kWeight);
  const mom = blocks(k, 0.4 * SR, 0.1 * SR);
  const loudest = mom.reduce((a, b) => (b.ms > a.ms ? b : a), mom[0] ?? { at: 0, ms: 0 });
  // Integrated: 400 ms blocks with 75 % overlap, gated absolutely at -70 and then 10 LU under their mean.
  const abs = mom.filter((b) => lufs(b.ms) > -70);
  const mean = abs.reduce((s, b) => s + b.ms, 0) / Math.max(1, abs.length);
  const rel = abs.filter((b) => lufs(b.ms) > lufs(mean) - 10);
  const integrated = rel.reduce((s, b) => s + b.ms, 0) / Math.max(1, rel.length);
  // Length: until the 50 ms level stays 45 dB under its loudest.
  const short = blocks(chs, 0.05 * SR, 0.01 * SR);
  const top = Math.max(...short.map((b) => b.ms));
  let last = 0;
  for (const b of short) if (b.ms > top * Math.pow(10, -45 / 10)) last = b.at + 0.05 * SR;
  const mono = chs[0].map((v, i) => (v + chs[1][i]) / 2);
  const c = centroid(mono, loudest.at, Math.min(mono.length, loudest.at + 0.4 * SR));
  return { peak: db(peak), mom: lufs(loudest.ms), int: lufs(integrated), len: last / SR, centroid: c };
}

/** 16-bit stereo PCM. */
function wav(chs) {
  const n = chs[0].length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 2; c++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chs[c][i] * 32767))), 44 + i * 4 + c * 2);
  return buf;
}

// ------------------------------------------------------------------ rendering

const port = await freePort();
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1' }, clearScreen: false });
await server.listen();
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
// (Any page of the dev server will do: the sounds are imported straight from the source.)
await page.goto(`http://127.0.0.1:${port}/favicon.svg`).catch(() => {});
const names = await page.evaluate(async () => (await import('/src/audio/sfx.ts')).SFX_NAMES);
const wanted = only.length ? only : names;
mkdirSync(out, { recursive: true });

const rows = [];
for (const want of wanted) {
  const [name, r] = want.split('@');
  const rate = r ? Number(r) : 1;
  if (!names.includes(name)) {
    console.log(`no sound called ${name}`);
    continue;
  }
  const ms = [];
  for (let k = 0; k < takes; k++) {
    // (Raw float samples, base64, both channels: far lighter than a JSON array of numbers.)
    const data = await page.evaluate(
      async ({ name, rate, sr }) => {
        const { renderSound } = await import('/src/audio/sfx.ts');
        const b = await renderSound(name, { rate, seconds: name === 'thunder' ? 8 : 5, sampleRate: sr });
        const enc = (f) => {
          const u = new Uint8Array(f.buffer);
          let s = '';
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
          return btoa(s);
        };
        return [enc(b.getChannelData(0)), enc(b.getChannelData(1))];
      },
      { name, rate, sr: SR },
    );
    const chs = data.map((b64) => {
      const u = Buffer.from(b64, 'base64');
      // (Less the quarter second of silence it starts with.)
      return new Float32Array(u.buffer, u.byteOffset, u.length / 4).subarray(Math.round(0.25 * SR));
    });
    ms.push(measure(chs));
    if (k === 0) {
      // Trimmed to its length (plus a little tail).
      const m = ms[0];
      const n = Math.min(chs[0].length, Math.ceil((m.len + 0.3) * SR));
      writeFileSync(join(out, `${want.replace('@', '-')}.wav`), wav(chs.map((c) => c.subarray(0, n))));
    }
  }
  const avg = (key) => ms.reduce((s, m) => s + m[key], 0) / ms.length;
  rows.push({ name: want, peak: avg('peak'), mom: avg('mom'), int: avg('int'), len: avg('len'), centroid: avg('centroid') });
}

const pad = (s, n) => String(s).padStart(n);
console.log(`${'sound'.padEnd(18)}${pad('peak', 7)}${pad('mom', 7)}${pad('int', 7)}${pad('len', 6)}${pad('centroid', 10)}`);
for (const r of rows) console.log(`${r.name.padEnd(18)}${pad(r.peak.toFixed(1), 7)}${pad(r.mom.toFixed(1), 7)}${pad(r.int.toFixed(1), 7)}${pad(r.len.toFixed(2), 6)}${pad(Math.round(r.centroid), 10)}`);
writeFileSync(join(out, 'sounds.json'), JSON.stringify(rows, null, 1));
await browser.close();
await server.close();
