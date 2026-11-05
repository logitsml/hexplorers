// Browser smoke test: the game's riskiest paths in a real Chromium with WebGPU, against a running
// dev server (it drives window.session, which only a dev build has). Fails (exit 1) on any page
// error, a stuck flow, or resources that grow from game to game.
//
//   npm run dev
//   npm run smoke          SMOKE_URL=http://localhost:5173  CHROME_PATH=/path/to/chrome  CYCLES=3
//                          MIX=allHands  WATCH=45
//
// After the base game it plays an expansions mix the same way: MIX is a preset's id or
// expansions joined by commas, as `?mix=` takes them (allHands by default; MIX=none skips it),
// and WATCH is how many seconds the bots play a watched game of it.
//
// Chrome is found by scripts/lib/chrome.mjs (CHROME_PATH, Playwright's, or the system's). The page must
// expose `window.session` and `window.__ui` (dev builds do), and serve the source as modules
// (the dev server does), since the mix is looked up in the engine's own presets.

import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';

const URL = (process.env.SMOKE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const CYCLES = Number(process.env.CYCLES ?? 3);
const MIX = process.env.MIX ?? 'allHands';
const WATCH = Number(process.env.WATCH ?? 45);
const CHROME = chromePath();

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal', '--js-flags=--expose-gc'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// (A failed request's console line doesn't say which: the response does.)
page.on('console', (m) => m.type() === 'error' && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
await page.addInitScript(() => {
  try {
    localStorage.removeItem('exploratory.view');
    localStorage.setItem('exploratory.touchCoach', '1');
  } catch {}
});

const ui = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, what, timeout = 150000) =>
  page.waitForFunction(fn, null, { timeout }).then(
    () => true,
    () => (check(false, `timed out: ${what}`), false),
  );

async function newGame() {
  await ui(() => [...document.querySelectorAll('.menu-card')].find((b) => /Singleplayer/.test(b.textContent))?.click());
  await page.waitForSelector('.btn.gold.large', { timeout: 20000 });
  await ui(() => document.querySelector('.btn.gold.large').click());
}

/**
 * Play out the set-up with the first legal spot each time, until the first roll. A decision an
 * expansion asks for on the way (or anything else the set-up offers) takes the first legal move.
 */
async function playSetup() {
  for (let i = 0; i < 60; i++) {
    const ok = await until(() => {
      const s = window.__ui?.getState();
      if (!s?.view) return false;
      if (!String(s.view.phase).startsWith('setup')) return true;
      return ['setupSettlement', 'setupRoad'].includes(s.interaction.kind) || (!s.busy && window.__engine.legalActions(s.view, s.me).length > 0);
    }, 'set-up turn');
    if (!ok) return false;
    const done = await ui(() => {
      const s = window.__ui.getState(), it = s.interaction;
      if (!String(s.view?.phase).startsWith('setup')) return true;
      if (it.kind === 'setupSettlement') window.session.presenter.act({ type: 'placeSetupSettlement', vertex: it.spots[0] });
      else if (it.kind === 'setupRoad') window.session.presenter.act({ type: 'placeSetupRoad', edge: it.spots[0] });
      else {
        const a = window.__engine.legalActions(s.view, s.me)[0];
        if (a) window.session.presenter.act(a);
      }
      return false;
    });
    if (done) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * Wait for `done`, answering meanwhile whatever is asked of you on the others' turns: a no to a
 * bot's offer, and the first legal answer to anything else (an expansion's happening, a bid).
 */
async function settle(done, what, timeout = 150000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await ui(done)) return true;
    await ui(() => {
      const s = window.__ui.getState();
      if (!s.view || s.busy) return;
      const legal = window.__engine.legalActions(s.view, s.me);
      const a = legal.find((x) => x.type === 'respondTrade' && !x.accept) ?? legal[0];
      if (a) window.session.presenter.act(a);
    });
    await page.waitForTimeout(400);
  }
  check(false, `timed out: ${what}`);
  return false;
}

/** Your first roll, presented (under the Almanac a draw stands in for it: the first legal move), with anything it asks of you answered. */
async function firstRoll() {
  if (!(await settle(() => { const s = window.__ui.getState(); return s.view?.phase === 'roll' && s.view.currentPlayer === s.me && s.view.pending.length === 0 && !s.busy; }, 'your first roll'))) return false;
  await ui(() => {
    const s = window.__ui.getState();
    if (window.session.presenter.act({ type: 'rollDice' }) !== null) window.session.presenter.act(window.__engine.legalActions(s.view, s.me)[0]);
  });
  return settle(() => { const s = window.__ui.getState(); return s.view?.phase !== 'roll' && !s.busy; }, 'the roll presented', 60000);
}

/** 2D and back, then back to the title. */
async function flatAndQuit() {
  await ui(() => document.querySelector('.view-toggle')?.click());
  check(await until(() => window.__ui.getState().flatPhase === 'shown', '2D map', 15000), 'switches to 2D');
  await ui(() => document.querySelector('.view-toggle')?.click());
  check(await until(() => window.__ui.getState().flatPhase === null && !window.session.world.rig.flying && !window.session.world.rig.locked, 'back to 3D', 15000), 'switches back to 3D');
  check(await quit(), 'quits to the title');
}

/** Start and leave `CYCLES` games (`of`: of the mix, or the base game), and say what each left behind (as the title counts it). */
async function cycles(of, mixed) {
  await page.waitForTimeout(3500);
  const first = await census();
  for (let i = 0; i < CYCLES; i++) {
    await newGame();
    await until(() => window.__ui.getState().screen === 'game' && window.__ui.getState().interaction.kind !== 'idle' && !window.session.world.rig.flying, `game${of} ${i + 1}`);
    if (i === 0) check((await ui(() => window.__ui.getState().view?.options.modules.length ?? 0)) > 0 === mixed, `the set-up page starts ${mixed ? 'the mix' : 'the base game'} again`);
    await page.waitForTimeout(800);
    await quit();
    await page.waitForTimeout(3500);
  }
  const last = await census();
  const mbPerGame = (last.heap - first.heap) / 1048576 / CYCLES;
  console.log(`     per game${of}: heap ${mbPerGame.toFixed(2)} MB, geometries ${last.geometries - first.geometries}, textures ${last.textures - first.textures}, objects ${last.objects - first.objects}`);
  // (Counts wander by a few between games as effects finish; a leak climbs every game.)
  check(last.geometries - first.geometries <= 8 && last.textures - first.textures <= 2, `GPU resources stay flat (games${of})`);
  // (Growth only, as for the GPU: the title keeps the last game's sunk island, and the islands of a
  // random map differ, so a later count can come out lower without anything having gone missing.)
  check(last.objects - first.objects <= 8, `scene objects stay flat (games${of})`);
  check(mbPerGame < 1.5, `heap growth under 1.5 MB per game${of}`);
}

async function census() {
  await ui(() => {
    window.gc?.();
    window.gc?.();
  });
  await page.waitForTimeout(300);
  return ui(() => {
    const w = window.session.world, r = w.stage.renderer;
    let objects = 0;
    w.stage.scene.traverse(() => objects++);
    return { heap: performance.memory?.usedJSHeapSize ?? 0, geometries: r.info.memory.geometries, textures: r.info.memory.textures, objects };
  });
}

async function quit() {
  await ui(() => void window.session.quitToTitle());
  return until(() => window.__ui.getState().screen === 'title', 'back to the title', 30000);
}

// 1. Boot. (The engine, as the page serves it, for the legal moves and the presets.)
await page.goto(`${URL}/?seed=7&q=low`);
check(await until(() => !!document.querySelector('.menu-card'), 'title menu'), 'title menu shows');
await ui(async () => {
  window.__engine = await import('/src/engine/index.ts');
  window.__presets = await import('/src/engine/presets.ts');
});
await page.waitForTimeout(2000);

// 2. A game: set-up, a roll, 2D and back.
await newGame();
check(await playSetup(), 'set-up plays through');
check(await firstRoll(), 'a roll is presented');
await flatAndQuit();

// 3. Leaving in the middle of the intro.
await page.waitForTimeout(2500);
await newGame();
await until(() => window.session.introducing, 'intro starts');
await page.waitForTimeout(2500);
check(await quit(), 'leaving mid-intro returns to the title');
check(await ui(() => !window.session.introducing), 'the intro stopped');

// 4. Resources stay flat from game to game.
await cycles('', false);

// 5. The expansions: the mix chosen on the set-up page, its set-up and a roll, a watched game of
// it, and resources flat from one game of it to the next.
if (MIX !== 'none') {
  await page.waitForTimeout(2500);
  await ui(() => [...document.querySelectorAll('.menu-card')].find((b) => /Singleplayer/.test(b.textContent))?.click());
  await page.waitForSelector('.btn.gold.large', { timeout: 20000 });
  const chosen = await ui(async (mix) => {
    const { PRESETS, EXPANSIONS } = window.__presets;
    const preset = PRESETS.find((p) => p.id === mix);
    const ids = preset ? preset.expansions : mix.split(',');
    if (!ids.every((id) => EXPANSIONS.some((e) => e.id === id))) return `no such mix: ${mix}`;
    const section = [...document.querySelectorAll('details.options')].find((d) => d.querySelector('.summary-label')?.textContent === 'Expansions');
    if (!section) return 'no Expansions section on the set-up page';
    section.open = true;
    const frame = () => new Promise((r) => setTimeout(r, 100));
    const buttons = () => [...section.querySelectorAll('button')];
    // (One press at a time: each toggle builds on the choice the page last rendered.)
    if (preset) buttons().find((b) => b.textContent.trim() === preset.name)?.click();
    else
      for (const id of ids) {
        const name = EXPANSIONS.find((e) => e.id === id).name;
        buttons().find((b) => b.querySelector('.expansion-name')?.textContent === name && b.getAttribute('aria-pressed') !== 'true')?.click();
        await frame();
      }
    await frame();
    const on = buttons().filter((b) => b.querySelector('.expansion-name') && b.getAttribute('aria-pressed') === 'true').map((b) => b.querySelector('.expansion-name').textContent);
    const want = ids.map((id) => EXPANSIONS.find((e) => e.id === id).name);
    return on.length === want.length && want.every((n) => on.includes(n)) ? null : `the page shows ${on.join(', ') || 'no expansions'}, not ${want.join(', ')}`;
  }, MIX);
  check(chosen === null, `the set-up page takes ${MIX}${chosen ? `: ${chosen}` : ''}`);
  await ui(() => document.querySelector('.btn.gold.large').click());
  check(await until(() => (window.__ui.getState().view?.options.modules.length ?? 0) > 0, `a game of ${MIX}`), `a game of ${MIX} starts`);
  check(await playSetup(), `set-up plays through (${MIX})`);
  check(await firstRoll(), `a roll is presented (${MIX})`);
  await flatAndQuit();

  // The bots play it for a while: its pieces, panels and events, told at the table.
  await page.waitForTimeout(2500);
  await ui(async (mix) => {
    const { PRESETS, EXPANSIONS, mixOf } = window.__presets;
    const ids = PRESETS.find((p) => p.id === mix)?.expansions ?? mix.split(',').filter((id) => EXPANSIONS.some((e) => e.id === id));
    const m = mixOf(ids);
    void window.session.start({ modules: m.modules, map: m.map === 'classic' ? undefined : m.map, knobs: m.knobs, victoryPoints: m.target, name: 'You', color: 'red', opponents: 3, difficulty: 'normal', layout: 'random', numberPlacement: 'spiral', seed: 7, watch: true });
  }, MIX);
  check(await until(() => window.__ui.getState().screen === 'game' && (window.__ui.getState().view?.turn ?? 0) > 0, `the watched game of ${MIX} under way`), `a watched game of ${MIX} gets going`);
  // (Counted in moves, not turns: an All Hands turn can hold fifteen moves, each presented in turn.)
  const moves = () => ui(() => window.session.host?.history.length ?? 0);
  const before = await moves();
  await page.waitForTimeout(WATCH * 1000);
  const played = (await moves()) - before;
  console.log(`     watched ${WATCH} s: ${played} moves, to turn ${await ui(() => window.__ui.getState().view?.turn ?? 0)}`);
  check(played >= 10, `the bots play on (${MIX})`);
  check(await quit(), `quits the watched game (${MIX})`);

  // (The set-up page keeps the mix, so these are games of it too.)
  await cycles(` of ${MIX}`, true);
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
