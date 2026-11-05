// The README's photographs (docs/images): the game in progress at your turn, the title, an All Hands
// archipelago, the map editor, and the island at golden hour. It starts its own Vite server, plays
// games forward with the bots, resumes them at your roll at Ultra, and photographs each at twice the
// size it's shown (1600×1000, the hero as it is), then sizes them down.
//
//   node scripts/capture/readme.mjs                  every picture, into docs/images/
//   node scripts/capture/readme.mjs --only hero,title  only these
//   CHROME_PATH=...                                 another Chromium (see scripts/lib/chrome.mjs)
//
// It needs ffmpeg on the PATH (to size and encode the JPEGs).

import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const args = process.argv.slice(2);
const i = args.indexOf('--only');
const only = i >= 0 ? args[i + 1].split(',') : null;
const want = (n) => !only || only.includes(n);
const OUT = resolve('docs/images');
const W = 1600, H = 1000;

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
const tmp = mkdtempSync(join(tmpdir(), 'readme-'));

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

async function page(time) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    try {
      localStorage.clear();
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

/** The picture, sized to `w` wide (the page is photographed at 1600). */
async function save(p, name, w) {
  const png = join(tmp, `${name}.png`);
  await p.screenshot({ path: png });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', png, '-vf', `scale=${w}:-2:flags=lanczos`, '-q:v', '3', join(OUT, `${name}.jpg`)]);
  console.log(`${name}.jpg`);
}

try {
  if (want('hero')) {
    // A game in progress at your turn, the dice landing in the sea.
    const { ctx, p } = await page();
    await resume(p, { preset: null, seed: 7, turns: 18 });
    await p.evaluate(() => window.session.act({ type: 'rollDice' }));
    await p.waitForTimeout(1300);
    await save(p, 'hero', 1600);
    await ctx.close();
  }
  if (want('title')) {
    const { ctx, p } = await page();
    await p.waitForTimeout(1500);
    await save(p, 'title', 800);
    await ctx.close();
  }
  if (want('all-hands')) {
    const { ctx, p } = await page();
    await resume(p, { preset: 'allHands', seed: 84, turns: 22 });
    await save(p, 'all-hands', 800);
    await ctx.close();
  }
  if (want('map-editor')) {
    const { ctx, p } = await page();
    // (One of its own templates, finished and ready to play: the great island, 37 hexes.)
    await p.evaluate(async () => {
      window.__ui.getState().set({ screen: 'editor' });
      await new Promise((r) => setTimeout(r, 2500));
      const { useEditor } = await import('/src/ui/editor/store.ts');
      const { TEMPLATES } = await import('/src/ui/editor/templates.ts');
      const t = TEMPLATES.find((x) => x.id === 'big');
      useEditor.getState().fresh({ ...t.make(), name: t.name });
    });
    await p.waitForTimeout(3000);
    await save(p, 'map-editor', 800);
    await ctx.close();
  }
  if (want('golden-hour')) {
    // The island alone, low evening light, from a little lower than the game's own view.
    const { ctx, p } = await page(0.455);
    await resume(p, { preset: null, seed: 7, turns: 18 });
    // (Everything over the canvas goes, and the glass the renderer draws under each panel: see render/core/frost.ts.)
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
    await p.evaluate(() => {
      const rig = window.session.world.rig;
      const pose = rig.snapshot();
      pose.pitch *= 0.62;
      pose.distance *= 0.78;
      rig.jumpTo(pose);
    });
    await p.waitForTimeout(2500);
    await save(p, 'golden-hour', 800);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
}
