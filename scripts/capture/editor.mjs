// Screenshots of the map editor at work against a running dev server: each shape template opened
// from the library and built on by dragging the brush past the edge of the map (the grid grows with
// it), photographed flat and in 3D, and for two of them played (Play, then Set sail) and
// photographed in the game.
//
//   EDITOR_URL=http://localhost:5183 node scripts/capture/editor.mjs --out shots/editor
//        --sizes desktop,phone        1440x900 with a mouse, 390x844 on a touch screen (both by default)
//        --templates rectangle,atoll  which templates (by id); all five shape templates by default
//        --no-play                    leave out the games
//        --q medium                   the quality preset
//
// It writes <out>/<size>-<template>-2d.png, and -3d.png and -game.png for the offshore and
// rectangle templates (on a phone the offshore map isn't played: it needs Sea Lanes, chosen in the
// check's panel, which a phone keeps in a sheet), and prints the page's console errors (exit 1 if any).

import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const URL = (process.env.EDITOR_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const OUT = resolve(opt('out', 'shots/editor'));
const Q = opt('q', 'medium');
const SIZES = { desktop: { w: 1440, h: 900, touch: false }, phone: { w: 390, h: 844, touch: true } };
const sizes = opt('sizes', 'desktop,phone').split(',');
const TEMPLATES = { rectangle: 'Rectangle', strip: 'Long island', atoll: 'Atoll', isles: 'Four isles', offshore: 'Home isle and offshore isles' };
const templates = opt('templates', Object.keys(TEMPLATES).join(',')).split(',');
/** The two that are also photographed in 3D and played: an offshore-islands map and a rectangle. */
const played = ['offshore', 'rectangle'].filter((t) => templates.includes(t));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const errors = [];

for (const name of sizes) {
  const size = SIZES[name];
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: 1 });
  await ctx.addInitScript((q) => {
    try {
      localStorage.setItem('exploratory.settings', JSON.stringify({ v: 3, quality: q }));
      localStorage.setItem('exploratory.touchCoach', '1');
      // (Every page opens the editor flat: the view chosen in 3D on an earlier page is remembered.)
      localStorage.setItem('exploratory.editorView', '2d');
    } catch {}
  }, Q);
  // One page for the flat shots of every template, and a fresh one for each template played.
  for (const id of templates) {
    const deep = !flag('no-play') && played.includes(id);
    // (On a phone the check is a sheet: only the rectangle, which needs no expansion, is played there.)
    const plays = deep && (!size.touch || id === 'rectangle');
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}/${id}: ${e.message}`));
    page.on('console', async (m) => {
      if (m.type() !== 'error') return;
      // (React's `%s` placeholders are filled by the arguments: the key and the component stack.)
      const parts = await Promise.all(m.args().map((a) => a.evaluate((x) => String(x)).catch(() => '?')));
      errors.push(`${name}/${id}: ${parts.join(' | ').slice(0, 600)}`);
    });
    // (A map left unsaved in the browser asks before another is started: yes.)
    page.on('dialog', (d) => void d.accept());
    const shot = (what) => page.screenshot({ path: join(OUT, `${name}-${id}-${what}.png`) });
    await page.goto(`${URL}/?seed=7&q=${Q}`, { timeout: 300000 });
    await page.waitForFunction(() => !!document.querySelector('.menu-card') && window.__ui?.getState().worldReady, null, { timeout: 600000 });
    await page.locator('.menu-card', { hasText: 'Map editor' }).first().click();
    await page.waitForSelector('.map-editor', { timeout: 60000 });
    // The template, from the library (on a phone, in the ⋯ menu).
    if (size.touch) {
      await page.locator('.ed-more').click();
      await page.locator('.ed-menu button', { hasText: 'Maps' }).first().click();
    } else await page.locator('.ed-top button', { hasText: 'Maps' }).first().click();
    await page.locator('.ed-card', { hasText: TEMPLATES[id] }).first().click();
    await page.waitForSelector('.ed-board2d .ed-sea', { state: 'attached', timeout: 30000 }).catch(async (e) => {
      await shot('no-board');
      throw e;
    });
    await page.waitForTimeout(1200);
    // The brush dragged east past the edge of the map: from its easternmost cell, two and a half cells out.
    const path = await page.evaluate(() => {
      // (Read off the drawn board: the rightmost hex, and its width.)
      const hexes = [...document.querySelectorAll('.ed-board2d .ed-sea, .ed-board2d .ed-tile polygon')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 4);
      const east = hexes.reduce((a, r) => (r.right > a.right ? r : a), hexes[0]);
      const cx = east.left + east.width / 2, cy = east.top + east.height / 2;
      return Array.from({ length: 6 }, (_, k) => [cx + (k / 2) * east.width, cy]);
    });
    await page.mouse.move(path[0][0], path[0][1]);
    await page.mouse.down();
    for (const [x, y] of path.slice(1)) await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
    // The land just painted is left numberless: its numbers are dealt at the start of each game.
    await page.locator('#ed-tab-numbers').click();
    await page.locator('.ed-switch', { hasText: 'Deal numbers' }).click();
    await page.locator('#ed-tab-land').click();
    // (Settled: the board refits to the grown grid once the stroke is over.)
    await page.waitForTimeout(1200);
    await shot('2d');
    if (deep) {
      // Sea Lanes for the islands (from the check's expansions, when its panel is up), then the same map in 3D.
      if (id === 'offshore' && !size.touch) await page.locator('button', { hasText: /^Sea Lanes$/ }).first().click();
      await page.locator('button[aria-label="3D island"]').click();
      await page.waitForSelector('.ed-raising', { state: 'detached', timeout: 300000 }).catch(() => {});
      await page.waitForTimeout(4500);
      await shot('3d');
      console.log(`${name}/${id}: ${await page.locator('.menu-card').count()} title menu cards in the page while the editor is up`);
    }
    if (plays) {
      // Played: Play, then Set sail on the set-up page it opens.
      if (size.touch) {
        await page.locator('.ed-more').click();
        await page.locator('.ed-menu button.gold').click();
      } else await page.locator('.ed-top .btn.gold', { hasText: 'Play' }).first().click();
      // The set-up page opens with the map chosen. (The title stays mounted behind the editor, as it
      // does without these changes, so the menu may be showing instead: Singleplayer opens the page,
      // and the map, kept in the library by Play, is chosen among the islands, with Sea Lanes for the isles.)
      const sail = page.locator('button', { hasText: 'Set sail' }).first();
      if (!(await sail.isVisible({ timeout: 4000 }).catch(() => false))) {
        await page.locator('.menu-card', { hasText: 'Singleplayer' }).first().click();
        if (id === 'offshore') await page.getByRole('button', { name: /^Sea Lanes/ }).first().click();
        await page.locator('.map-choice.custom').first().evaluate((el) => el.click());
        await page.waitForTimeout(800);
      }
      await page.locator('button', { hasText: 'Set sail' }).first().click({ timeout: 60000 }).catch(async (e) => {
        await shot('stuck');
        throw e;
      });
      await page.waitForFunction(() => window.__ui?.getState().screen === 'game' && !window.__ui.getState().busy && !window.session.world.rig.flying, null, { timeout: 600000, polling: 500 });
      await page.waitForTimeout(5000);
      await shot('game');
    }
    await page.close();
    console.log(`${name}: ${id}${deep ? ' (3D, played)' : ''}`);
  }
  await ctx.close();
}
await browser.close();
if (errors.length) {
  console.log(`\n${errors.length} console errors:\n  ${[...new Set(errors)].join('\n  ')}`);
  process.exit(1);
}
console.log('\nNo console errors.');
