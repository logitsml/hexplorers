// Every screen of the interface at every size, photographed and checked: the title and each page
// of its menu, Settings, How to play (its contents and every page), and in a game the HUD, each
// dialog, the flat map and the expansions' panels. It starts its own Vite server (like shots.mjs),
// plays games forward with the bots and resumes them at your roll, and in each state measures the
// page for what goes wrong at a size: the page scrolling sideways, things cut off at the window's
// edge, text cut short in its box, controls lying over each other, tap targets too small for a
// finger, and text too small to read.
//
//   node scripts/capture/screens.mjs                       every state at every size, into shots/screens/
//   node scripts/capture/screens.mjs --out some/folder     another folder
//   node scripts/capture/screens.mjs --only title,settings only these states (by name, or the start of one)
//   node scripts/capture/screens.mjs --sizes phone,desktop only these sizes
//   node scripts/capture/screens.mjs --list                print the states and sizes
//   CHROME_PATH=...                                another Chromium (see scripts/lib/chrome.mjs)
//
// It writes <out>/<size>/<state>.png, and <out>/report.json and <out>/report.md: for each state
// and size what the checks found, worst first. It exits 1 if a state failed or the page logged errors.

import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

/**
 * The sizes, each with whether it's a touch screen: a desktop, a laptop, a short laptop window, a
 * tablet both ways, phones both ways, and a foldable phone's screens (open, 890×626 points, and
 * turned upright; closed, its 466×678 cover screen, and turned on its side), and the open screen
 * as Safari leaves it on its side, under its bars (951×585).
 */
const SIZES = {
  desktop: [1600, 1000, false],
  laptop: [1280, 720, false],
  short: [1100, 560, false],
  tablet: [1024, 768, true],
  tabletTall: [768, 1024, true],
  landscape: [844, 390, true],
  phone: [390, 844, true],
  small: [360, 640, true],
  duoOpen: [890, 626, true],
  duoOpenTall: [626, 890, true],
  duoCover: [466, 678, true],
  duoCoverSide: [678, 466, true],
  duoSafari: [951, 585, true],
};

/** In the page: what each state does to get there, from the title or from the resumed game. */
const TITLE_STATES = {
  title: async () => {},
  solo: async () => {
    [...document.querySelectorAll('.menu-card')].find((b) => b.textContent.includes('Singleplayer'))?.click();
  },
  soloExpansions: async () => {
    [...document.querySelectorAll('.menu-card')].find((b) => b.textContent.includes('Singleplayer'))?.click();
    await new Promise((r) => setTimeout(r, 900));
    // The set-up page's expansions, opened if they fold.
    const t = [...document.querySelectorAll('button, summary')].find((b) => /expansion/i.test(b.textContent ?? '') && b.offsetParent);
    t?.click();
  },
  multi: async () => {
    [...document.querySelectorAll('.menu-card')].find((b) => b.textContent.includes('Multiplayer'))?.click();
  },
  settings: async () => window.__ui.getState().set({ modal: 'settings' }),
  settingsScrolled: async () => {
    window.__ui.getState().set({ modal: 'settings' });
    await new Promise((r) => setTimeout(r, 700));
    const m = document.querySelector('.modal');
    m?.scrollTo(0, m.scrollHeight);
  },
  rules: async () => window.__ui.getState().set({ modal: 'rules' }),
  rulesExpansions: async () => {
    window.__ui.getState().set({ modal: 'rules' });
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('#rules-tab-expansions')?.click();
  },
  editor: async () => window.__ui.getState().set({ screen: 'editor' }),
};

/** Every page of How to play: its tabs, and each expansion's page. */
const RULE_PAGES = ['sea', 'guilds', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster'];

const GAME_STATES = {
  hud: async () => {},
  trade: async () => window.__ui.getState().set({ modal: 'trade' }),
  bank: async () => window.__ui.getState().set({ modal: 'bank' }),
  devcards: async () => window.__ui.getState().set({ modal: 'devcards' }),
  menu: async () => window.__ui.getState().set({ modal: 'menu' }),
  gameSettings: async () => window.__ui.getState().set({ modal: 'settings' }),
  gameRules: async () => window.__ui.getState().set({ modal: 'rules' }),
  flat: async () => {
    const { setViewMode } = await import('/src/app/viewMode.ts');
    await setViewMode('2d', true);
  },
  log: async () => {
    // The log or the chat, wherever this layout keeps it.
    const b = [...document.querySelectorAll('button')].find((x) => /log|chat/i.test(x.getAttribute('aria-label') ?? x.title ?? '') && x.offsetParent);
    b?.click();
  },
  gameover: async () => {
    const ui = window.__ui.getState();
    const v = structuredClone(ui.view);
    v.phase = 'gameOver';
    v.winner = ui.me;
    ui.set({ view: v, modal: 'gameover' });
  },
};

const out = resolve(opt('out', 'shots/screens'));
const only = opt('only', '')
  .split(',')
  .filter(Boolean);
const sizes = opt('sizes', Object.keys(SIZES).join(','))
  .split(',')
  .filter((s) => SIZES[s]);
const want = (name) => !only.length || only.some((o) => name === o || name.startsWith(o));

if (flag('list')) {
  console.log('sizes:', Object.entries(SIZES).map(([k, [w, h, t]]) => `${k} ${w}×${h}${t ? ' (touch)' : ''}`).join(', '));
  console.log('title:', [...Object.keys(TITLE_STATES), ...RULE_PAGES.map((p) => `rules-${p}`)].join(', '));
  console.log('game (base and allHands):', Object.keys(GAME_STATES).join(', '));
  process.exit(0);
}


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

/** In the page: play a game forward with the bots and return a save of it at the human seat's roll. */
async function buildSave({ preset, seed, turns }) {
  const P = await import('/src/engine/presets.ts');
  const H = await import('/src/game/host.ts');
  const { PRESET_COLORS } = await import('/src/render/board/pieces.ts');
  const m = preset ? P.mixOf(P.PRESETS.find((p) => p.id === preset).expansions) : { modules: [], map: 'classic', knobs: {}, target: 10 };
  const cfg = { modules: m.modules, map: m.map === 'classic' ? undefined : m.map, knobs: m.knobs, victoryPoints: m.target, name: 'You', color: 'red', opponents: 3, difficulty: 'normal', layout: 'random', numberPlacement: 'spiral', seed };
  const others = PRESET_COLORS.map((c) => c.id).filter((c) => c !== 'red');
  const seats = [{ name: 'You', color: 'red', isBot: true, difficulty: 'normal' }, ...['Ada', 'Bram', 'Cora'].map((name, i) => ({ name, color: others[i], isBot: true, difficulty: 'normal' }))];
  const host = new H.LocalHost(seats, { seed, layout: cfg.layout, numberPlacement: cfg.numberPlacement, victoryPoints: cfg.victoryPoints, modules: cfg.modules, map: cfg.map, knobs: cfg.knobs });
  for (let i = 0; i < 40000; i++) {
    const s = host.state;
    if (s.phase === 'gameOver') throw new Error(`the game ended at turn ${s.turn}`);
    if (s.turn >= turns && s.currentPlayer === 0 && s.phase === 'roll' && s.pending.length === 0 && !s.trade) break;
    const d = host.nextBotAction();
    if (!d) throw new Error(`no bot could act (turn ${s.turn}, phase ${s.phase})`);
    const r = host.submitBot(d);
    if (!r.ok) throw new Error(r.error);
  }
  host.dispose();
  const o = host.state.options;
  return { v: 2, rules: o.rules, ...(o.modules.length > 0 && { moduleRules: o.moduleRules }), cfg, seats: seats.map((s, i) => ({ ...s, isBot: i > 0 })), avatars: [-1, 0, 1, 2], history: host.history, turn: host.state.turn, savedAt: Date.now() };
}

/**
 * In the page: the checks. Everything shown (not under the 3D canvas, not hidden) is measured:
 * - `overflow`: the page itself scrolls sideways;
 * - `offscreen`: an element runs past the window's edge without a scrolling box to reach it by;
 * - `clipped`: text cut short in its box (it holds more than it shows, and doesn't scroll);
 * - `overlap`: two controls lying over each other;
 * - `target`: a control smaller than a finger on a touch screen (under 32 px);
 * - `tiny`: text set under 11 px.
 */
function audit() {
  const W = innerWidth, H = innerHeight;
  const found = [];
  const name = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = (el.getAttribute?.('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}${text ? ` “${text}”` : ''}`;
  };
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    // (A closed <details> keeps its content laid out for its opening animation: not shown.)
    const fold = el.closest('details:not([open])');
    if (fold && !el.closest('summary')) return false;
    // (Behind a dialog: inert, or covered by its shade.)
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const scrollsIn = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return true;
    }
    return false;
  };
  if (document.scrollingElement.scrollWidth > W + 1) found.push({ kind: 'overflow', what: `page is ${document.scrollingElement.scrollWidth}px wide in a ${W}px window` });
  const all = [...document.querySelectorAll('body *')].filter((el) => !(el instanceof SVGElement && el.ownerSVGElement) && el.tagName !== 'CANVAS' && shown(el));
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if ((r.right > W + 2 || r.left < -2 || r.bottom > H + 2 || r.top < -2) && !scrollsIn(el) && cs.position !== 'static' && !el.closest('[aria-hidden="true"]'))
      found.push({ kind: 'offscreen', what: name(el), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) {
      const hides = /(hidden|clip)/.test(cs.overflowX + cs.overflowY) || cs.textOverflow === 'ellipsis';
      if (hides && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2)) found.push({ kind: 'clipped', what: name(el) });
      const px = parseFloat(cs.fontSize);
      if (px < 11) found.push({ kind: 'tiny', what: `${name(el)} at ${px}px` });
    }
  }
  // A control is checked only where it can be reached: something of it is on top at its middle
  // (not covered by a dialog's shade or another layer), unless it scrolls out of sight in its box.
  const onTop = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(W - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(H - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return !!hit && (el.contains(hit) || hit.contains(el));
  };
  const controls = all.filter((el) => el.matches('button, a[href], input, select, [role="button"], [role="tab"], summary') && onTop(el));
  const touch = matchMedia('(pointer: coarse)').matches;
  // (What a finger hits: a switch's whole row when it's in a label, and a hit area drawn past the
  // control by its ::before or ::after.)
  const reach = (el) => {
    const r = (el.matches('input') && el.closest('label')) ? el.closest('label').getBoundingClientRect() : el.getBoundingClientRect();
    const out = (v) => Math.max(0, -parseFloat(v) || 0);
    let { width, height } = r;
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content === 'none' || cs.position !== 'absolute') continue;
      width = Math.max(width, r.width + out(cs.left) + out(cs.right));
      height = Math.max(height, r.height + out(cs.top) + out(cs.bottom));
    }
    return { width, height };
  };
  for (const el of controls) {
    const r = reach(el);
    if (touch && (r.width < 32 || r.height < 32) && r.width > 0) found.push({ kind: 'target', what: `${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}` });
  }
  // (A bar that sticks to its box's edge, a page's Set sail or a sheet's buttons, lies over what
  // scrolls under it by design.)
  const stuck = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'sticky') return true;
    return false;
  };
  for (let i = 0; i < controls.length; i++) {
    const a = controls[i].getBoundingClientRect();
    for (let j = i + 1; j < controls.length; j++) {
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
      if (stuck(controls[i]) !== stuck(controls[j])) continue;
      const b = controls[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 4 && h > 4 && w * h > 0.25 * Math.min(a.width * a.height, b.width * b.height)) found.push({ kind: 'overlap', what: `${name(controls[i])} over ${name(controls[j])}` });
    }
  }
  return found;
}

const ORDER = ['overflow', 'offscreen', 'overlap', 'clipped', 'target', 'tiny'];

mkdirSync(out, { recursive: true });
const port = await freePort();
// (fs.strict off: a snapshot of the tree may reach its node_modules through a link.)
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1', fs: { strict: false } }, clearScreen: false });
await server.listen();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal'],
});

const report = {};
let failed = false;
const note = (size, state, found) => {
  (report[state] ??= {})[size] = found;
};
/** In the page: wait (up to 4 s) for the interface to stop moving, so nothing is measured mid-animation. */
async function settle() {
  const snap = () => [...document.querySelectorAll('#root *')].slice(0, 4000).map((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; }).join(';');
  let last = snap();
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const now = snap();
    if (now === last) return;
    last = now;
  }
}

const shoot = async (page, size, state) => {
  await page.waitForTimeout(600);
  await page.evaluate(settle);
  const found = await page.evaluate(audit);
  mkdirSync(join(out, size), { recursive: true });
  // (The interface is what's measured: the island is held on its last frame for the photograph,
  // so a busy machine isn't left waiting on the 3D for one.)
  await page.evaluate(() => window.session?.world && (window.session.world.drawEnabled = false));
  await page.screenshot({ path: join(out, size, `${state}.png`), timeout: 120000 });
  await page.evaluate(() => window.session?.world && (window.session.world.drawEnabled = true));
  note(size, state, found);
  console.log(`${size} ${state}: ${found.length ? ORDER.map((k) => [k, found.filter((f) => f.kind === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') : 'clean'}`);
};

for (const size of sizes) {
  const [width, height, touch] = SIZES[size];
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      localStorage.setItem('exploratory.touchCoach', '1');
    } catch {}
  });
  const fresh = async () => {
    await page.goto(`${base}/?q=low&time=0.42&seed=7`, { timeout: 180000 });
    await page.waitForFunction(() => window.__ui?.getState().worldReady && window.session?.world, null, { timeout: 180000 });
    await page.waitForTimeout(1200);
  };
  try {
    // The title: each state from a fresh title (a menu page or a dialog left open would colour the next).
    for (const state of Object.keys(TITLE_STATES)) {
      if (!want(state)) continue;
      await fresh();
      await page.evaluate(TITLE_STATES[state]);
      await shoot(page, size, state);
    }
    if (RULE_PAGES.some((p) => want(`rules-${p}`))) {
      await fresh();
      await page.evaluate(() => window.__ui.getState().set({ modal: 'rules' }));
      await page.waitForTimeout(600);
      for (const p of RULE_PAGES) {
        if (!want(`rules-${p}`)) continue;
        await page.evaluate(() => document.querySelector('#rules-tab-expansions')?.click());
        await page.waitForTimeout(400);
        const ok = await page.evaluate((p) => {
          const entry = [...document.querySelectorAll('.rules-entry')].find((e) => e.textContent.toLowerCase().includes(p === 'sea' ? 'sea' : p.slice(0, 5)));
          entry?.click();
          return !!entry;
        }, p);
        if (!ok) continue;
        await shoot(page, size, `rules-${p}`);
        await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => /back|contents/i.test(b.textContent ?? ''))?.click());
      }
    }
    // In a game: the classic island, then All Hands (the expansions' panels).
    for (const [game, preset, turns] of [['base', null, 18], ['allHands', 'allHands', 22]]) {
      if (!Object.keys(GAME_STATES).some((s) => want(`${game}-${s}`) || want(s))) continue;
      await fresh();
      const save = await page.evaluate(buildSave, { preset, seed: preset ? 84 : 7, turns });
      await page.evaluate(async (save) => {
        await window.session.start(save.cfg, save);
        await window.session.world.settled();
        window.__resumed = structuredClone(window.__ui.getState().view);
      }, save);
      await page.waitForTimeout(1500);
      for (const state of Object.keys(GAME_STATES)) {
        const label = `${game}-${state}`;
        if (!want(label) && !want(state)) continue;
        await page.evaluate(async () => {
          window.__ui.getState().set({ view: structuredClone(window.__resumed), interaction: { kind: 'idle' }, choice: null, modal: null });
          window.session.presenter.updateInteraction(window.__resumed);
          const { setViewMode } = await import('/src/app/viewMode.ts');
          await setViewMode('3d', true);
        });
        await page.waitForTimeout(500);
        await page.evaluate(GAME_STATES[state]);
        await shoot(page, size, label);
      }
    }
  } catch (e) {
    failed = true;
    console.log(`FAIL ${size}: ${e?.message ?? e}`);
    await page.screenshot({ path: join(out, `${size}-FAILED.png`) }).catch(() => {});
  }
  if (errors.length) {
    failed = true;
    note(size, 'console', errors.map((e) => ({ kind: 'error', what: e.slice(0, 300) })));
    console.log(`FAIL ${size}: ${errors.length} console errors\n     ${errors.slice(0, 5).join('\n     ')}`);
  }
  await ctx.close();
}
await browser.close();
await server.close();

writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const md = ['# Screens', '', `Sizes: ${sizes.map((s) => `${s} ${SIZES[s].slice(0, 2).join('×')}`).join(', ')}`, ''];
for (const [state, bySize] of Object.entries(report)) {
  md.push(`## ${state}`, '');
  for (const [size, found] of Object.entries(bySize)) {
    if (!found.length) {
      md.push(`- **${size}**: clean`);
      continue;
    }
    md.push(`- **${size}**:`);
    const sorted = [...found].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    const seen = new Set();
    for (const f of sorted) {
      const line = `${f.kind}: ${f.what}${f.rect ? ` [${f.rect.join(', ')}]` : ''}`;
      if (seen.has(line)) continue;
      seen.add(line);
      md.push(`  - ${line}`);
    }
  }
  md.push('');
}
writeFileSync(join(out, 'report.md'), md.join('\n'));
console.log(failed ? `\nsome states failed (see ${out}/report.md)` : `\nall shots and the report in ${out}`);
process.exit(failed ? 1 : 0);
