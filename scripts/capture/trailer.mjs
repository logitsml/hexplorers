// The trailer (public/social/trailer.mp4) and the watch link's picture (watch.jpg), recorded from
// the 3D canvas alone, with no interface: the dive into a new game and the island rising, a pause,
// the island sinking back into the sea as leaving a game has it, and the camera flying back to the
// very pose it started from. It loops: the camera stands still at that pose for the first and last
// second, and the last second is crossed into the first, so the clip plays round without a seam.
//
// It runs on game time: every clock that reads performance.now (the game's, and the renderer's,
// which the sea's ripples and foam keep time by) steps 1/30 s for each frame drawn, and each frame
// is encoded (WebCodecs, H.264) with its own timestamp, so the clip is an even 30 fps however slowly
// the machine draws. The whale is held back and the far ships ride at anchor, so the sea at the end
// is the sea at the start; the set-up's placement rings stay off. It starts its own Vite dev server
// (the page's dev hooks drive it) on a free port.
//
//   node scripts/capture/trailer.mjs                    into public/social (trailer.mp4, watch.jpg)
//   node scripts/capture/trailer.mjs --out dir          elsewhere, with every poster frame kept
//   node scripts/capture/trailer.mjs --seed 11 --q high --bitrate 2300000
//   CHROME_PATH=...                                     another Chromium (H.264 encoding needs one that has it)

import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const out = resolve(opt('out', 'public/social'));
const keepPosters = opt('out') !== undefined;
const quality = opt('q', 'high');
const seed = Number(opt('seed', 11));
const bitrate = Number(opt('bitrate', 2_300_000));
const W = 1280, H = 720, FPS = 30;
/** Frames crossed at the seam, and seconds the camera stands still before the dive. */
const K = 30, PRE = 1.3;
/** Frames the risen island holds still before it sinks (its last harbours finish in the first of them). */
const HOLD = 75;
/** The frame (of the clip) the watch link's picture is: the island up, its harbours built. */
const POSTER = Number(opt('poster', 180));

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

const port = await freePort();
// (node_modules may be a link to another checkout's: its fonts are served from where it leads.)
const allow = [process.cwd(), realpathSync('node_modules')];
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null, fs: { allow } }, clearScreen: false });
await server.listen();
const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  // (The preset is set, not only asked for with ?q=: left on Auto, a slow frame steps it down.)
  await page.addInitScript((quality) => {
    try {
      localStorage.clear();
      localStorage.setItem('exploratory.touchCoach', '1');
      localStorage.setItem('exploratory.settings', JSON.stringify({ quality, v: 3 }));
    } catch {}
  }, quality);
  await page.goto(`http://127.0.0.1:${port}/?q=${quality}&seed=${seed}`, { timeout: 600000 });
  await page.waitForFunction(() => window.__ui?.getState().worldReady && window.session?.world && performance.getEntriesByName('load: title').length > 0, null, { timeout: 600000 });
  await page.evaluate((q) => {
    const ui = window.__ui.getState();
    ui.set({ settings: { ...ui.settings, quality: q } });
  }, quality);
  await page.waitForTimeout(2500);
  await page.evaluate(() => [...document.querySelectorAll('.menu-card')].find((b) => /Singleplayer/.test(b.textContent))?.click());
  await page.waitForSelector('.btn.gold.large', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const ok = await page.evaluate(
    async ({ W, H, FPS, K, PRE, HOLD, bitrate, POSTER }) => {
      const config = { codec: 'avc1.4d0029', width: W, height: H, bitrate, framerate: FPS, avc: { format: 'avc' }, latencyMode: 'quality' };
      if (!(await VideoEncoder.isConfigSupported(config)).supported) return 'H.264 encoding unsupported in this Chromium (set CHROME_PATH to Google Chrome)';
      const src = document.getElementById('scene');
      const R = (window.__rec = { chunks: [], description: null, error: null, posters: [], log: [] });
      const enc = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta?.decoderConfig?.description) R.description = new Uint8Array(meta.decoderConfig.description.buffer ?? meta.decoderConfig.description);
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          R.chunks.push({ key: chunk.type === 'key', ts: chunk.timestamp, data });
        },
        error: (e) => (R.error = String(e)),
      });
      enc.configure(config);
      const s = window.session, w = s.world, rig = w.rig;
      // Every frame is drawn into one canvas at the clip's size (the 3D canvas may be larger, at
      // the preset's pixel ratio), and the seam's frames are mixed there.
      const mix = document.createElement('canvas');
      mix.width = W;
      mix.height = H;
      const g = mix.getContext('2d');
      const kept = [];
      let on = false, n = 0, total = Infinity, start = null, phase = 'intro', since = 0, frameTime = 0;
      R.done = new Promise((resolve) => {
        const render = w.stage.render.bind(w.stage);
        w.stage.render = (...a) => {
          // (Nor the interface's glass, whose frost is drawn into the frame under each panel.)
          if (on) w.stage.frost.count.value = 0;
          render(...a);
          if (!on || n >= total) return;
          // (The next frame is 1/30 s on, for every clock.)
          frameTime++;
          const i = n++;
          // The script, in frames of game time.
          if (phase === 'intro' && !s.introducing && s.presenter) (phase = 'hold'), (since = i), R.log.push(`risen ${i}`);
          if (phase === 'hold' && i - since >= HOLD) {
            phase = 'outro';
            R.log.push(`sinking ${i}`);
            // (The title's shallows stay down, as they were at the start.)
            w.shoal = () => Promise.resolve();
            const outro = w.outroSequence.bind(w);
            w.outroSequence = async (...args) => {
              await outro(...args);
              // Back to where the dive began (rather than the title's view, a turn of the island away),
              // then still there for the last K frames, as for the first K before the dive.
              w.setAutoOrbit(false);
              void rig.flyTo(start, 2.6);
              total = n + Math.round(2.6 * FPS) + 4 + K;
              R.log.push(`returning ${n}, total ${total}`);
            };
            void s.quitToTitle();
          }
          g.globalAlpha = 1;
          g.drawImage(src, 0, 0, W, H);
          if (i < K) {
            kept.push(new VideoFrame(mix, { timestamp: 0 }));
            return;
          }
          if (i >= total - K) {
            // The seam: the end crossed into the start, which follows it when the clip plays round.
            const j = i - (total - K);
            g.globalAlpha = j / K;
            g.drawImage(kept[j], 0, 0, W, H);
          }
          const ts = Math.round(((i - K) * 1e6) / FPS);
          const frame = new VideoFrame(mix, { timestamp: ts, duration: Math.round(1e6 / FPS) });
          enc.encode(frame, { keyFrame: (i - K) % 60 === 0 });
          frame.close();
          if (i - K === POSTER || (i % 15 === 0 && i - K > 120 && i - K < 300)) R.posters.push([i - K, mix.toDataURL('image/jpeg', 0.9)]);
          if (i === total - 1) {
            kept.forEach((f) => f.close());
            enc.flush().then(resolve);
          }
        };
      });
      window.__ui.subscribe((st, p) => {
        if (st.screen !== 'game' || p.screen === 'game' || on) return;
        // Game time for every clock that reads performance.now: 1/30 s a drawn frame.
        const base = performance.now();
        performance.now = () => base + (frameTime * 1000) / FPS;
        // The camera still at its pose for a while before the dive (and so at the end, after it).
        w.setAutoOrbit(false);
        const intro = w.introSequence.bind(w);
        w.introSequence = async (...args) => {
          await w.animator.wait(PRE);
          return intro(...args);
        };
        const q = rig.pose;
        start = { target: q.target.clone(), distance: q.distance, pitch: q.pitch, yaw: q.yaw, fov: q.fov, shiftX: q.shiftX, shiftY: q.shiftY, lens: q.lens };
        // (No whale surfacing across the seam, and the far ships at anchor: sailing on, they were
        // elsewhere at the end, and crossed over from there.)
        w.distant.whale.next = 1e9;
        for (const ship of w.distant.ships) ship.speed = 0;
        // (Nor the set-up's placement rings, which come up for the player's first turn in the pause.)
        s.view.showMarkers = () => {};
        on = true;
      });
      return 'ok';
    },
    { W, H, FPS, K, PRE, HOLD, bitrate, POSTER },
  );
  if (ok !== 'ok') throw new Error(ok);
  await page.evaluate(() => {
    document.querySelector('.btn.gold.large').click();
    // (The clip has no interface, so the island is framed for the whole picture: the map's fit
    // keeps clear only of panels that show, see app/mapFit.ts.)
    const style = document.createElement('style');
    style.textContent = '.ui-layer { display: none !important; }';
    document.head.append(style);
  });
  await page.waitForFunction(() => window.__ui.getState().screen === 'game', null, { timeout: 180000 });
  await page.evaluate(() => window.__rec.done, null);
  const rec = await page.evaluate(() => {
    const R = window.__rec;
    const b64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return { error: R.error, log: R.log, description: b64(R.description), chunks: R.chunks.map((c) => ({ key: c.key, ts: c.ts, data: b64(c.data) })), posters: R.posters };
  });
  if (rec.error) throw new Error(rec.error);
  mkdirSync(out, { recursive: true });
  const chunks = rec.chunks.map((c) => ({ key: c.key, ts: c.ts, data: Buffer.from(c.data, 'base64') }));
  const mp4 = mux(Buffer.from(rec.description, 'base64'), chunks);
  writeFileSync(join(out, 'trailer.mp4'), mp4);
  for (const [i, url] of rec.posters) {
    const jpg = Buffer.from(url.split(',')[1], 'base64');
    if (i === POSTER) writeFileSync(join(out, 'watch.jpg'), jpg);
    if (keepPosters) writeFileSync(join(out, `poster-${String(i).padStart(3, '0')}.jpg`), jpg);
  }
  console.log(`${rec.log.join(' | ')} | ${chunks.length} frames = ${(chunks.length / FPS).toFixed(2)} s, ${(mp4.length / 1e6).toFixed(2)} MB -> ${join(out, 'trailer.mp4')}`);
} finally {
  await browser.close();
  await server.close();
}

/** H.264 chunks (avcC description, frames in decode order) -> a plain MP4 with its index first. */
function mux(avcc, chunks) {
  const TS = 90000, DUR = TS / FPS, n = chunks.length, dur = n * DUR;
  const u32 = (...v) => {
    const b = Buffer.alloc(v.length * 4);
    v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
    return b;
  };
  const u16 = (...v) => {
    const b = Buffer.alloc(v.length * 2);
    v.forEach((x, i) => b.writeUInt16BE(x & 0xffff, i * 2));
    return b;
  };
  const zero = (k) => Buffer.alloc(k);
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
  };
  const full = (type, version, flags, ...parts) => box(type, u32((version << 24) | flags), ...parts);
  const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
  const mvhd = full('mvhd', 0, 0, u32(0, 0, TS, dur, 0x10000), u16(0x100), zero(10), matrix, zero(24), u32(2));
  const tkhd = full('tkhd', 0, 3, u32(0, 0, 1, 0, dur), zero(8), u16(0, 0, 0, 0), matrix, u32(W << 16, H << 16));
  const mdhd = full('mdhd', 0, 0, u32(0, 0, TS, dur), u16(0x55c4, 0));
  const hdlr = full('hdlr', 0, 0, u32(0), Buffer.from('vide'), zero(12), Buffer.from('VideoHandler\0'));
  const vmhd = full('vmhd', 0, 1, zero(8));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const avc1 = box('avc1', zero(6), u16(1), zero(16), u16(W, H), u32(0x480000, 0x480000), zero(4), u16(1), zero(32), u16(0x18, 0xffff), box('avcC', avcc));
  const stsd = full('stsd', 0, 0, u32(1), avc1);
  const stts = full('stts', 0, 0, u32(1, n, DUR));
  // Composition offsets, should the encoder have reordered any frame.
  const order = chunks.map((c) => c.ts).sort((a, b) => a - b);
  const cto = chunks.map((c, i) => Math.max(0, Math.round(((c.ts - order[i]) * TS) / 1e6)));
  const ctts = cto.some(Boolean) ? full('ctts', 0, 0, u32(n), ...cto.map((o) => u32(1, o))) : zero(0);
  const keys = chunks.flatMap((c, i) => (c.key ? [i + 1] : []));
  const stss = full('stss', 0, 0, u32(keys.length), ...keys.map((k) => u32(k)));
  const stsz = full('stsz', 0, 0, u32(0, n), ...chunks.map((c) => u32(c.data.length)));
  const stsc = full('stsc', 0, 0, u32(1, 1, n, 1));
  const moov = (offset) => {
    const stbl = box('stbl', stsd, stts, ctts, stss, stsz, stsc, full('stco', 0, 0, u32(1, offset)));
    return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl))));
  };
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2avc1mp41'));
  const head = ftyp.length + moov(0).length + 8;
  return Buffer.concat([ftyp, moov(head), box('mdat', ...chunks.map((c) => c.data))]);
}
