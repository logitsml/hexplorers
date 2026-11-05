// The link cards' pictures (public/social): the hero (the og:image of the JSON-LD and the PWA's first
// screenshot, 1600x840) and its square thumb.jpg (the og:image and twitter:image of the front
// page), the table and the flat map (1200x900, with the interface, the PWA's screenshots), the stormy
// night (1200x900), and the squares room.jpg (the flat chart, a room's link) and invite.jpg (the
// island close up, an invitation's). trailer.mp4 and watch.jpg are recorded by trailer.mjs.
//
//   node scripts/capture/social.mjs                    every picture, into public/social/
//   node scripts/capture/social.mjs --only hero,night  only these
//   node scripts/capture/social.mjs --out some/folder  elsewhere
//   CHROME_PATH=...                                    another Chromium (see scripts/lib/chrome.mjs)
//
// It needs ffmpeg on the PATH (to size and encode the JPEGs). After a change in the bytes, bump the
// ?v= of the pictures that carry one (index.html, sitemap.xml, src/worker/preview.ts, tests/linkPreview.test.ts).

import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const only = opt('only') ? opt('only').split(',') : null;
const want = (...n) => !only || n.some((x) => only.includes(x));
const OUT = resolve(opt('out', 'public/social'));
mkdirSync(OUT, { recursive: true });

const port = await new Promise((ok) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null, fs: { strict: false } }, clearScreen: false });
await server.listen();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const tmp = mkdtempSync(join(tmpdir(), 'social-'));

/** In the page: play a game forward with the bots and return a save of it at your roll. */
async function buildSave({ preset, seed, turns }) {
  const P = await import('/src/engine/presets.ts');
  const Host = await import('/src/game/host.ts');
  const { PRESET_COLORS } = await import('/src/render/board/pieces.ts');
  const m = preset ? P.mixOf(P.PRESETS.find((p) => p.id === preset).expansions) : { modules: [], map: 'classic', knobs: {}, target: 10 };
  const cfg = { modules: m.modules, map: m.map === 'classic' ? undefined : m.map, knobs: m.knobs, victoryPoints: m.target, name: 'You', color: 'red', opponents: 3, difficulty: 'normal', layout: 'random', numberPlacement: 'spiral', seed };
  const others = PRESET_COLORS.map((c) => c.id).filter((c) => c !== 'red');
  const seats = [{ name: 'You', color: 'red', isBot: true, difficulty: 'normal' }, ...['Ada', 'Bram', 'Cora'].map((name, i) => ({ name, color: others[i], isBot: true, difficulty: 'normal' }))];
  const host = new Host.LocalHost(seats, { seed, layout: cfg.layout, numberPlacement: cfg.numberPlacement, victoryPoints: cfg.victoryPoints, modules: cfg.modules, map: cfg.map, knobs: cfg.knobs });
  for (let k = 0; k < 40000; k++) {
    const s = host.state;
    if (s.phase === 'gameOver') throw new Error(`the game ended at turn ${s.turn}`);
    if (s.turn >= turns && s.currentPlayer === 0 && s.phase === 'roll' && s.pending.length === 0 && !s.trade) break;
    const d = host.nextBotAction();
    if (!d) throw new Error(`no bot could act (turn ${s.turn})`);
    const r = host.submitBot(d);
    if (!r.ok) throw new Error(r.error);
  }
  host.dispose();
  const o = host.state.options;
  return { v: 2, rules: o.rules, ...(o.modules.length > 0 && { moduleRules: o.moduleRules }), cfg, seats: seats.map((s, k) => ({ ...s, isBot: k > 0 })), avatars: [-1, 0, 1, 2], history: host.history, turn: host.state.turn, savedAt: Date.now() };
}

async function page(w, h, time) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('page error:', e.message));
  await p.addInitScript(() => {
    try {
      localStorage.clear();
      localStorage.setItem('exploratory.touchCoach', '1');
    } catch {}
  });
  await p.goto(`${base}/?q=ultra${time !== undefined ? `&time=${time}` : ''}`, { timeout: 180000 });
  await p.waitForFunction(() => window.__ui?.getState().worldReady && window.session?.world, null, { timeout: 180000 });
  await p.waitForTimeout(1500);
  return { ctx, p };
}

async function resume(p, game) {
  const save = await p.evaluate(buildSave, game);
  await p.evaluate(async (s) => {
    await window.session.start(s.cfg, s);
    await window.session.world.settled();
  }, save);
  // (No "Game resumed" line in the log.)
  await p.evaluate(() => window.__ui.getState().set({ log: [] }));
  await p.waitForTimeout(3000);
}

/** The camera lower and closer than the game's own view (a fraction of its pitch and distance). */
const lower = (p, pitch, distance) =>
  p.evaluate(([pitch, distance]) => {
    const rig = window.session.world.rig;
    const pose = rig.snapshot();
    pose.pitch *= pitch;
    pose.distance *= distance;
    rig.jumpTo(pose);
  }, [pitch, distance]);

/** Only the island: everything over the canvas goes, and the glass the renderer draws under each panel (render/core/frost.ts). */
async function bare(p) {
  await p.addStyleTag({ content: 'body > :not(#scene) { visibility: hidden !important; }' });
  await p.evaluate(() => {
    const stage = window.session.world.stage;
    const render = stage.render.bind(stage);
    stage.render = (...a) => {
      const n = stage.frost.count.value;
      stage.frost.count.value = 0;
      try {
        return render(...a);
      } finally {
        stage.frost.count.value = n;
      }
    };
  });
}

const flatMap = (p) => p.evaluate(async () => (await import('/src/app/viewMode.ts')).setViewMode('2d', true));

/** The page photographed, optionally cropped (x, y, w, h), sized to `w` x `h`, into <OUT>/<name>.jpg. */
async function save(p, name, w, h, crop) {
  const png = join(tmp, `${name}.png`);
  await p.screenshot({ path: png });
  jpg(png, name, w, h, crop);
}
function jpg(png, name, w, h, crop) {
  const vf = [crop ? `crop=${crop.join(':')}` : null, `scale=${w}:${h}:flags=lanczos`].filter(Boolean).join(',');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', png, '-vf', vf, '-q:v', '3', join(OUT, `${name}.jpg`)]);
  console.log(`${name}.jpg ${w}x${h}`);
}

try {
  if (want('hero')) {
    // Evening light, the dice splashing into the sea beside the island; no interface.
    const { ctx, p } = await page(1600, 840, 0.455);
    await resume(p, { preset: null, seed: 7, turns: 18 });
    await bare(p);
    await lower(p, 0.55, 0.72);
    await p.evaluate(() => window.session.act({ type: 'rollDice' }));
    await p.waitForTimeout(1300);
    const png = join(tmp, 'hero.png');
    await p.screenshot({ path: png });
    jpg(png, 'hero', 1600, 840);
    await ctx.close();
  }
  if (want('thumb')) {
    // Its own composition, not a crop: low and close on the coast where the dice land, so the splash
    // and the total fill the lower right and a few hexes with their houses, roads and a harbour the rest.
    const [pitch, distance, k, dz] = process.env.THUMB_POSE ? JSON.parse(process.env.THUMB_POSE) : [0.45, 0.3, 0.7, -2.2];
    const { ctx, p } = await page(900, 900, 0.455);
    await resume(p, { preset: null, seed: 7, turns: 18 });
    await bare(p);
    await p.evaluate(() => window.session.act({ type: 'rollDice' }));
    await p.waitForTimeout(1200);
    await p.evaluate(([pitch, distance, k, dz]) => {
      const w = window.session.world;
      const rig = w.rig;
      const d = w.diceTotal.mesh.position;
      const pose = rig.snapshot();
      pose.pitch *= pitch;
      pose.distance *= distance;
      // (The camera aims between the island's middle and the dice.)
      pose.target.x = d.x * k;
      pose.target.z = d.z * k;
      pose.target.z += dz;
      rig.jumpTo(pose);
    }, [pitch, distance, k, dz]);
    await p.waitForTimeout(200);
    await save(p, 'thumb', 600, 600);
    await ctx.close();
  }
  if (want('table')) {
    // A game at your turn, with its interface.
    const { ctx, p } = await page(1200, 900);
    await resume(p, { preset: null, seed: 7, turns: 18 });
    await save(p, 'table', 1200, 900);
    await ctx.close();
  }
  if (want('map')) {
    const { ctx, p } = await page(1200, 900);
    await resume(p, { preset: null, seed: 7, turns: 18 });
    await flatMap(p);
    await p.waitForSelector('.flat-board');
    await p.waitForTimeout(2500);
    await save(p, 'map', 1200, 900);
    await ctx.close();
  }
  if (want('room')) {
    // The flat chart alone, cropped square.
    const { ctx, p } = await page(1200, 900);
    await resume(p, { preset: null, seed: 7, turns: 18 });
    await flatMap(p);
    await p.waitForSelector('.flat-board');
    await p.addStyleTag({ content: '#root { visibility: hidden !important; } .flat-board, .flat-board * { visibility: visible !important; }' });
    await p.waitForTimeout(2500);
    await save(p, 'room', 600, 600, [680, 680, 250, 65]);
    await ctx.close();
  }
  if (want('invite')) {
    // The island close up, from above its harbours, as a square.
    const { ctx, p } = await page(900, 900, 0.3);
    await resume(p, { preset: null, seed: 7, turns: 18 });
    await bare(p);
    await lower(p, 0.8, 0.45);
    await p.waitForTimeout(2500);
    await save(p, 'invite', 600, 600, [780, 780, 60, 60]);
    await ctx.close();
  }
  if (want('night')) {
    // A stormy night on the island.
    const { ctx, p } = await page(1200, 900, 0.68);
    await resume(p, { preset: null, seed: 7, turns: 18 });
    await bare(p);
    await lower(p, 0.6, 0.6);
    await p.evaluate(() => window.session.world.weather.setMode('storm', 0, true));
    await p.waitForTimeout(8000);
    await save(p, 'night', 1200, 900);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
}
