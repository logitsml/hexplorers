// Load times, stage by stage, in a real Chrome.
//
//   node scripts/checks/loadtime.mjs [stages]     cold,warm,sail,continue,editor,online (all by default)
//        --url http://localhost:5211       the build (scripts/run/serve-dist.mjs), or the live site
//        --runs 3                          each stage this many times (medians, and every run in --json)
//        --q high                          the quality preset (Auto off, so it stays put)
//        --net none|cable|fast4g|slow4g    the link, throttled by the browser (none: as it is)
//        --cpu 1                           the CPU slowed this many times
//        --webgl                           the WebGL2 backend
//        --cdp http://localhost:9334       drive a Chrome already running (another machine's, through an SSH tunnel)
//        --headed                          a window, not headless (WebGPU on some machines needs one)
//        --json out.json                   every run's numbers
//        --profile sail                    a CPU profile of that stage (the first run), saved beside --json
//        --keep-profile DIR                one browser profile kept across runs (its GPU shader cache warm
//                                          after the first: a returning player), not a fresh one each
//        --steady                          (sail) the frame rate 25 s into the game as well
//
// Stages:
//   cold      a first visit: no cache, no service worker, to the title's menu
//   warm      a second visit in the same browser (the cache, and the service worker once installed)
//   sail      Singleplayer, Set sail, to the island risen and play handed over
//   continue  a game saved, the page reloaded, Continue to play handed over
//   editor    the title's Map editor to its page, then its 3D view
//   online    a harbour opened by one browser, joined cold by another from its link, and sailed
//
// The times come from the page's own marks (performance.mark in app/bootstrap.ts, app/session.ts
// and render/World.ts), so they are the same in a production build and the dev server.

import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { chromePath } from '../lib/chrome.mjs';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const flag = (name) => args.includes(`--${name}`);
const stageArg = args[0] && !args[0].startsWith('--') ? args[0] : 'cold,warm,sail,continue,editor,online';
const STAGES = stageArg.split(',');
const URL = opt('url', 'http://localhost:5211').replace(/\/$/, '');
const RUNS = Number(opt('runs', 3));
const Q = opt('q', 'high');
const NET = opt('net', 'none');
const CPU = Number(opt('cpu', 1));
const WEBGL = flag('webgl');
const CDP = opt('cdp', '');
const JSON_OUT = opt('json', '');
const PROFILE = opt('profile', '');
const KEEP_PROFILE = opt('keep-profile', '');
const STEADY = flag('steady');

// Throughput in bytes a second, latency in ms (Chrome DevTools' and Lighthouse's presets).
const NETS = {
  none: null,
  cable: { latency: 28, downloadThroughput: (5_000_000 / 8) * 0.9, uploadThroughput: (1_000_000 / 8) * 0.9 },
  fast4g: { latency: 150 * 0.4, downloadThroughput: (9_000_000 / 8) * 0.9, uploadThroughput: (1_500_000 / 8) * 0.9 },
  slow4g: { latency: 150 * 3.75, downloadThroughput: (1_600_000 / 8) * 0.9, uploadThroughput: (750_000 / 8) * 0.9 },
};

const launchArgs = ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required', process.env.JSFLAGS ?? '--js-flags=--expose-gc'];
// A browser of its own for each run (a fresh profile: nothing in the GPU's shader cache either, as on
// a first visit), or the one at --cdp.
let browser = null;
const launch = async () => {
  if (CDP) return chromium.connectOverCDP(CDP);
  if (!KEEP_PROFILE) return chromium.launch({ executablePath: chromePath(), headless: !flag('headed'), args: launchArgs });
  // (A persistent profile is a context of its own: its browser stands in, with newContext giving back that one context, emptied of pages.)
  const ctx = await chromium.launchPersistentContext(KEEP_PROFILE, { executablePath: chromePath(), headless: !flag('headed'), args: launchArgs, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  let ready = false;
  return {
    contexts: () => [ctx],
    newContext: async () => {
      for (const p of ctx.pages()) await p.close().catch(() => {});
      if (!ready) {
        ready = true;
        await ctx.addInitScript(probe);
      }
      // (Each run's game starts afresh: no save, the settings set again.)
      await ctx.clearCookies();
      return Object.assign(Object.create(ctx), { close: async () => {} });
    },
    close: () => ctx.close(),
  };
};

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const ms = (x) => (x == null ? '—' : `${Math.round(x)}`);
const kb = (x) => (x == null ? '—' : `${(x / 1024).toFixed(0)}`);

/** What every page records from its start: long tasks, paints, and when the menu and the editor first show. */
function probe() {
  const lt = (window.__lt = { long: [], seen: {} });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) lt.long.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  const look = () => {
    const at = performance.now();
    const once = (k, ok) => ok && lt.seen[k] === undefined && (lt.seen[k] = at);
    once('loader', !!document.querySelector('.loader, .loading, [class*="loader"]'));
    once('menu', [...document.querySelectorAll('.menu-card')].some((b) => /Singleplayer/.test(b.textContent)));
    once('editor', !!document.querySelector('.map-editor'));
    once('harbour', !!document.querySelector('.harbour .room-code'));
  };
  new MutationObserver(look).observe(document, { childList: true, subtree: true });
  // Every animation frame's time, for the lag between them.
  lt.frames = [];
  const raf = (t) => {
    lt.frames.push(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  // (The click itself, not when the script asked for it: Playwright first waits for the button to stop moving.)
  addEventListener('click', () => (lt.click = performance.now()), true);
}

async function newContext(q) {
  // (One page drawing at a time: two in one browser share its GPU process, and the second's
  // start-up crawled, once past three minutes.)
  for (const c of browser.contexts()) for (const p of c.pages()) await p.close().catch(() => {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  if (KEEP_PROFILE) {
    // (A kept profile's storage would carry the last run's save and settings.)
    await ctx.addInitScript((q) => {
      try {
        if (!sessionStorage.getItem('lt.cleared')) {
          sessionStorage.setItem('lt.cleared', '1');
          localStorage.clear();
        }
        localStorage.setItem('exploratory.settings', JSON.stringify({ v: 3, quality: q }));
        localStorage.setItem('exploratory.touchCoach', '1');
      } catch {}
    }, q);
    return ctx;
  }
  await ctx.addInitScript((q) => {
    try {
      if (!localStorage.getItem('exploratory.settings')) localStorage.setItem('exploratory.settings', JSON.stringify({ v: 3, quality: q }));
      localStorage.setItem('exploratory.touchCoach', '1');
    } catch {}
  }, q);
  await ctx.addInitScript(probe);
  return ctx;
}

async function newPage(ctx) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  if (NETS[NET]) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NETS[NET] });
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && console.log(`  console: ${m.text().slice(0, 200)}`));
  return { page, cdp };
}

const params = () => `?q=${Q}${WEBGL ? '&webgl' : ''}`;
const wait = (page, fn, arg, timeout = 180_000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });

/** The page's marks (name → ms since its start, the last of each name) and its resources. */
async function timeline(page) {
  return page.evaluate(() => {
    const click = window.__lt.click;
    const marks = {};
    for (const m of performance.getEntriesByType('mark')) marks[m.name] = m.startTime;
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]));
    const res = performance.getEntriesByType('resource').map((r) => ({ name: r.name.replace(location.origin, ''), type: r.initiatorType, start: r.startTime, end: r.responseEnd, transfer: r.transferSize, body: r.decodedBodySize }));
    const measures = performance.getEntriesByType('measure').map((m) => [m.name, m.startTime, m.duration]);
    return { frames: window.__lt.frames, click, measures, marks, nav: nav && { ttfb: nav.responseStart, doc: nav.responseEnd, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd }, paint, res, long: window.__lt.long, seen: window.__lt.seen, now: performance.now() };
  });
}

/** The frames between two moments: how many took over 50 ms, the longest, and the time lost to them beyond a 60 Hz frame. */
function jank(frames, from, to) {
  let long = 0, max = 0, lost = 0, n = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i] < from || frames[i] > to) continue;
    const gap = frames[i] - frames[i - 1];
    n++;
    max = Math.max(max, gap);
    if (gap > 50) {
      long++;
      lost += gap - 16.7;
    }
  }
  return { long, max, lost, fps: n ? (n * 1000) / Math.max(1, to - from) : 0 };
}

/** Main-thread time held by long tasks between two moments, and the longest. */
function blocking(long, from, to) {
  let sum = 0;
  let max = 0;
  for (const [s, d] of long) {
    if (s + d < from || s > to) continue;
    sum += d;
    max = Math.max(max, d);
  }
  return { sum, max };
}

const kind = (r) => {
  const n = r.name.split('?')[0];
  if (/\.js$/.test(n)) return 'js';
  if (/\.css$/.test(n)) return 'css';
  if (/\.woff2?$/.test(n)) return 'font';
  if (/\.(webp|png|jpg|svg|avif)$/.test(n)) return 'image';
  if (/^\/api\//.test(n)) return 'api';
  return 'other';
};

/** Bytes over the wire and decoded, by kind, for resources that finished before `until` (ms). */
function bytes(res, until = Infinity, from = 0) {
  const out = {};
  for (const r of res) {
    if (r.end > until || r.start < from) continue;
    const k = kind(r);
    const o = (out[k] ??= { n: 0, transfer: 0, body: 0 });
    o.n++;
    o.transfer += r.transfer;
    o.body += r.body;
  }
  return out;
}

async function withProfile(cdp, on, fn) {
  if (!on) return [await fn(), null];
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const r = await fn();
  const { profile } = await cdp.send('Profiler.stop');
  return [r, profile];
}

function saveProfile(name, profile) {
  if (!profile) return;
  const file = `${JSON_OUT ? JSON_OUT.replace(/\.json$/, '') : 'loadtime'}-${name}.cpuprofile`;
  writeFileSync(file, JSON.stringify(profile));
  // Self time per function, the top 25.
  const by = new Map();
  const dt = new Map();
  const { samples, timeDeltas, nodes } = profile;
  for (let i = 0; i < samples.length; i++) dt.set(samples[i], (dt.get(samples[i]) ?? 0) + (timeDeltas[i] ?? 0) / 1000);
  for (const n of nodes) {
    const { functionName, url, lineNumber, columnNumber } = n.callFrame;
    const k = `${functionName || '(anon)'} ${url.replace(/^.*\//, '')}:${lineNumber + 1}:${columnNumber + 1}`;
    by.set(k, (by.get(k) ?? 0) + (dt.get(n.id) ?? 0));
  }
  console.log(`  profile saved to ${file}; self time:`);
  for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${v.toFixed(0).padStart(6)} ms  ${k}`);
}

// ------------------------------------------------------------------ the stages

/** The title from a navigation: when each part of start-up was reached, from the page's start. */
function titleNumbers(t) {
  const m = t.marks;
  const menu = t.seen.menu;
  const blk = blocking(t.long, 0, menu ?? t.now);
  return {
    ttfb: t.nav?.ttfb,
    fcp: t.paint['first-contentful-paint'],
    loader: t.seen.loader,
    scripts: m['load: Sharpening the quills'],
    device: m['load: Mixing the inks'],
    environment: m['load: Charting wind and water'],
    world: m['load: Sketching the coastline'],
    requested: m['load: shaders requested'],
    compiled: m['load: shaders compiled'],
    settled: m['load: Land ho!'],
    title: m['load: title'],
    menu,
    blocked: blk.sum,
    longest: blk.max,
    bytes: bytes(t.res, menu ?? Infinity),
    after: bytes(t.res, Infinity, menu ?? Infinity),
    js: t.res.filter((r) => kind(r) === 'js' && r.end <= (menu ?? Infinity)).map((r) => ({ name: r.name.replace(/^\/assets\//, ''), transfer: r.transfer, body: r.body, end: r.end })),
  };
}

async function toTitle(page) {
  await wait(page, () => window.__lt.seen.menu !== undefined && performance.getEntriesByName('load: title').length > 0);
  // (The menu's cards slide in over 0.8 s and more: a click before then can miss.)
  await page.waitForTimeout(1500);
}

async function cold(run) {
  const ctx = await newContext(Q);
  const { page, cdp } = await newPage(ctx);
  const [, profile] = await withProfile(cdp, PROFILE === 'cold' && run === 0, async () => {
    await page.goto(`${URL}/${params()}`);
    await toTitle(page);
  });
  saveProfile('cold', profile);
  const r = titleNumbers(await timeline(page));
  return { r, ctx, page };
}

async function warm(run, prev) {
  // The cold visit's browser: its cache, and its service worker (registered once the title is up).
  const ctx = prev?.ctx ?? (await cold(run)).ctx;
  await (prev?.page ?? ctx.pages()[0]).waitForTimeout(4000);
  const sw = await (prev?.page ?? ctx.pages()[0]).evaluate(async () => !!(await navigator.serviceWorker?.getRegistration())?.active);
  for (const p of ctx.pages()) await p.close();
  const { page, cdp } = await newPage(ctx);
  const [, profile] = await withProfile(cdp, PROFILE === 'warm' && run === 0, async () => {
    await page.goto(`${URL}/${params()}`);
    await toTitle(page);
  });
  saveProfile('warm', profile);
  const r = { ...titleNumbers(await timeline(page)), sw };
  return { r, ctx, page };
}

/** From the title: Singleplayer, Set sail, until play is handed over. */
async function sailFrom(page, cdp, profileName) {
  await page.locator('.menu-card', { hasText: 'Singleplayer' }).click();
  await page.waitForSelector('.btn.gold.large', { timeout: 20000 });
  await page.waitForTimeout(800);
  const t0 = await page.evaluate(() => performance.now());
  const [, profile] = await withProfile(cdp, !!profileName, async () => {
    await page.locator('.btn.gold.large').click();
    await wait(page, (t0) => performance.getEntriesByName('game: playable').some((e) => e.startTime > t0), t0);
  });
  saveProfile(profileName, profile);
  // (The frames just after play is handed over too, and with --steady, 25 to 30 s into the game.)
  await page.waitForTimeout(STEADY ? 30500 : 6500);
  return gameNumbers(await timeline(page), t0);
}

/** A game's start from `t0` (the click): each part, from the click. */
function gameNumbers(t, t0) {
  // (From the click, where it came after t0.)
  if (t.click > t0) t0 = t.click;
  const after = (name) => {
    const e = t.marks[name];
    return e !== undefined && e >= t0 ? e - t0 : null;
  };
  const shown = after('game: shown');
  const blkBuild = blocking(t.long, t0, t0 + (shown ?? 0));
  const abs = (name) => (t.marks[name] !== undefined && t.marks[name] >= t0 ? t.marks[name] : null);
  const shownAt = abs('game: shown'), playAt = abs('game: playable');
  const during = jank(t.frames, t0, shownAt ?? t.now), intro = shownAt && playAt ? jank(t.frames, shownAt, playAt) : null, later = playAt ? jank(t.frames, playAt, Math.min(t.now, playAt + 6000)) : null;
  return {
    lagLong: during.long,
    lagMax: during.max,
    lagLost: during.lost,
    introLong: intro?.long,
    introMax: intro?.max,
    introFps: intro?.fps,
    afterLong: later?.long,
    afterMax: later?.max,
    afterFps: later?.fps,
    ...(STEADY && playAt && { steadyFps: jank(t.frames, playAt + 25000, playAt + 30000).fps, steadyMax: jank(t.frames, playAt + 25000, playAt + 30000).max }),
    parts: after('sail: parts'),
    asked: after('world: board asked'),
    shoal: after('world: shoal down'),
    tiles: after('world: tiles built'),
    board: after('world: board built'),
    view: after('sail: view built'),
    compileStart: after('sail: compile'),
    gpuWait: after('precompile: pipelines'),
    compiled: after('sail: compiled'),
    shown,
    playable: after('game: playable'),
    intro: shown != null && after('game: playable') != null ? after('game: playable') - shown : null,
    blocked: blkBuild.sum,
    longest: blkBuild.max,
    bytes: bytes(t.res, Infinity, t0),
    ...(process.env.MEASURES && { measures: t.measures.filter((m) => m[1] >= t0).map(([n, s, d]) => `${n}@${Math.round(s - t0)}+${Math.round(d)}`).join(' ') }),
  };
}

async function sail(run) {
  const ctx = await newContext(Q);
  const { page, cdp } = await newPage(ctx);
  await page.goto(`${URL}/${params()}`);
  await toTitle(page);
  // (The game's parts arrive a second after the title: as a player would, given a moment.)
  await page.waitForTimeout(2500);
  const r = await sailFrom(page, cdp, PROFILE === 'sail' && run === 0 ? 'sail' : '');
  return { r, ctx, page };
}

async function continueGame(run, prev) {
  const { ctx, page: old } = prev?.ctx ? prev : await sail(run);
  // The save is written at once for a new game; let it settle, then come back.
  await old.waitForTimeout(1500);
  await old.close();
  const { page, cdp } = await newPage(ctx);
  await page.goto(`${URL}/${params()}`);
  await toTitle(page);
  await page.waitForTimeout(2500);
  const t0 = await page.evaluate(() => performance.now());
  const [, profile] = await withProfile(cdp, PROFILE === 'continue' && run === 0, async () => {
    await page.locator('.menu-card', { hasText: 'Continue' }).click();
    await wait(page, (t0) => performance.getEntriesByName('game: playable').some((e) => e.startTime > t0), t0);
  });
  saveProfile('continue', profile);
  const r = gameNumbers(await timeline(page), t0);
  return { r, ctx, page };
}

async function editor(run) {
  const ctx = await newContext(Q);
  const { page, cdp } = await newPage(ctx);
  await page.goto(`${URL}/${params()}`);
  await toTitle(page);
  await page.waitForTimeout(2500);
  const t0 = await page.evaluate(() => performance.now());
  const [r, profile] = await withProfile(cdp, PROFILE === 'editor' && run === 0, async () => {
    await page.locator('.menu-card', { hasText: 'Map editor' }).click();
    await wait(page, () => !!document.querySelector('.map-editor'));
    const shown = (await page.evaluate(() => window.__lt.seen.editor)) - t0;
    // Its 3D view: the draft island raised from the page's 3D button.
    await page.waitForTimeout(2500);
    const t1 = await page.evaluate(() => performance.now());
    const button = page.getByRole('button', { name: '3D island' }).first();
    let view3d = null;
    if (await button.count()) {
      await button.click();
      await wait(page, (t1) => performance.getEntriesByName('editor: 3d shown').some((e) => e.startTime > t1), t1, 60_000).catch(() => null);
      const m = await page.evaluate((t1) => performance.getEntriesByName('editor: 3d shown').find((e) => e.startTime > t1)?.startTime, t1);
      view3d = m ? m - t1 : null;
    }
    const t = await timeline(page);
    const blk = blocking(t.long, t0, t0 + shown);
    return { shown, view3d, blocked: blk.sum, longest: blk.max, bytes: bytes(t.res, Infinity, t0) };
  });
  saveProfile('editor', profile);
  return { r, ctx, page };
}

async function online(run) {
  // The host, in a browser of its own (as another machine would be: two pages drawing in one
  // browser share its GPU process, and the second's start-up crawled): the Multiplayer page, a room opened.
  const hostBrowser = CDP ? browser : await launch();
  const keep = browser;
  browser = hostBrowser;
  const hostCtx = await newContext(Q);
  browser = keep;
  const host = await newPage(hostCtx);
  await host.page.goto(`${URL}/${params()}`);
  await toTitle(host.page);
  await host.page.locator('.menu-card', { hasText: 'Multiplayer' }).click();
  // (Its two ways aboard first: Host a room, then the room's set-up.)
  await host.page.getByRole('button', { name: /Host a room/ }).first().click({ timeout: 30_000 });
  await wait(host.page, () => [...document.querySelectorAll('button')].some((b) => /Open (a harbour|the room)/.test(b.textContent) && b.getAttribute('aria-disabled') !== 'true'), undefined, 60_000);
  await host.page.getByRole("button", { name: /Open (a harbour|the room)/ }).click();
  await wait(host.page, () => !!document.querySelector('.harbour .room-code') && [...document.querySelectorAll('.seat-card')].some((c) => c.classList.contains('mine')), undefined, 60_000);
  const code = (await host.page.locator('.room-code').textContent()).replace(/\s/g, '');
  // The guest: cold, from the room's link.
  const ctx = await newContext(Q);
  const { page, cdp } = await newPage(ctx);
  await page.goto(`${URL}/r/${code}${params()}`);
  await wait(page, () => !!document.querySelector('.harbour .room-code') && !!document.querySelector('.come-aboard'));
  const tl = await timeline(page);
  const harbour = tl.seen.harbour;
  const title = tl.marks['load: title'];
  await page.locator('.come-aboard button', { hasText: 'Take a seat' }).click();
  await wait(page, () => [...document.querySelectorAll('.seat-card')].some((c) => c.classList.contains('mine')));
  await page.locator('.my-seat .swatch:not([disabled]):not(.on)').first().click();
  await page.getByRole('button', { name: /Ready/ }).click();
  await wait(host.page, () => [...document.querySelectorAll('.seat-card.human')].some((c) => !c.classList.contains('mine') && c.classList.contains('ready')));
  const t0 = await page.evaluate(() => performance.now());
  const [, profile] = await withProfile(cdp, PROFILE === 'online' && run === 0, async () => {
    await host.page.getByRole('button', { name: /Set sail/ }).click();
    await wait(page, (t0) => performance.getEntriesByName('game: playable').some((e) => e.startTime > t0), t0);
  });
  saveProfile('online', profile);
  const g = gameNumbers(await timeline(page), t0);
  await hostCtx.close();
  if (hostBrowser !== browser) await hostBrowser.close().catch(() => {});
  return { r: { harbour, title, ...g }, ctx, page };
}

// ------------------------------------------------------------------ run and report

const all = {};
console.log(`${URL}  q=${Q}  net=${NET}  cpu=${CPU}x${WEBGL ? '  webgl' : ''}  runs=${RUNS}${CDP ? `  cdp=${CDP}` : ''}`);
for (let run = 0; run < RUNS; run++) {
  browser = await launch();
  let coldRun = null;
  let sailRun = null;
  for (const s of STAGES) {
    try {
      let out;
      if (s === 'cold') out = coldRun = await cold(run);
      else if (s === 'warm') out = await warm(run, coldRun);
      else if (s === 'sail') out = sailRun = await sail(run);
      else if (s === 'continue') out = await continueGame(run, sailRun);
      else if (s === 'editor') out = await editor(run);
      else if (s === 'online') out = await online(run);
      else throw new Error(`no stage ${s}`);
      (all[s] ??= []).push(out.r);
      const { bytes: _b, after: _a, js: _j, ...brief } = out.r;
      console.log(`run ${run + 1} ${s}: ${Object.entries(brief).map(([k, v]) => `${k}=${typeof v === 'number' ? ms(v) : v}`).join(' ')}`);
    } catch (e) {
      console.log(`run ${run + 1} ${s}: FAILED ${e.message.split('\n')[0]}`);
      // (What each page showed, beside --json.)
      if (JSON_OUT) for (const [i, p] of browser.contexts().flatMap((c) => c.pages()).entries()) await p.screenshot({ path: `${JSON_OUT.replace(/\.json$/, '')}-${s}-failed-${i}.png` }).catch(() => {});
    }
  }
  for (const c of browser.contexts()) if (!CDP || c !== browser.contexts()[0]) await c.close().catch(() => {});
  if (!CDP) await browser.close().catch(() => {});
}

console.log('\nmedians (ms from the page start for cold/warm, from the click for the rest; KB):');
for (const [s, runs] of Object.entries(all)) {
  const keys = Object.keys(runs[0]).filter((k) => typeof runs[0][k] === 'number');
  console.log(`  ${s.padEnd(9)} ${keys.map((k) => `${k}=${ms(median(runs.map((r) => r[k])))}`).join(' ')}`);
  const b = runs[0].bytes;
  if (b) console.log(`  ${''.padEnd(9)} bytes: ${Object.entries(b).map(([k, v]) => `${k} ${v.n}× ${kb(v.transfer)}/${kb(v.body)}`).join(', ')}`);
  if (runs[0].after) console.log(`  ${''.padEnd(9)} after the menu: ${Object.entries(runs[0].after).map(([k, v]) => `${k} ${v.n}× ${kb(v.transfer)}/${kb(v.body)}`).join(', ')}`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ url: URL, q: Q, net: NET, cpu: CPU, webgl: WEBGL, at: new Date().toISOString(), runs: all }, null, 1));
if (CDP) await browser.close().catch(() => {});
