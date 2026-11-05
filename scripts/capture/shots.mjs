// Repeatable screenshots of the island, for before/after comparisons of pieces, terrain and
// effects. It starts its own Vite dev server on a free port (so several checkouts can run it at
// once), plays a game forward with the bots in the page, resumes it at the human seat's next roll
// (so nothing moves), and photographs named views, with the renderer's draw calls and triangles.
//
//   node scripts/capture/shots.mjs                       every scene, WebGPU, into shots/
//   node scripts/capture/shots.mjs --out shots/before    another folder
//   node scripts/capture/shots.mjs --only allHands,sea   only these scenes (by name)
//   node scripts/capture/shots.mjs --shot castle,ship    only shots whose name contains one of these
//   node scripts/capture/shots.mjs --webgl               the WebGL2 backend instead (--both: each)
//   node scripts/capture/shots.mjs --hud                 keep the interface showing (a flat map shot, `flat: true`, always shows the map)
//   node scripts/capture/shots.mjs --flat-js f.js        run f.js in the page before each flat-map shot's photograph
//   node scripts/capture/shots.mjs --flat --reduce        flat dice, reduced motion (with the HUD)
//   node scripts/capture/shots.mjs --roll 8               you roll, and production plays out for 8 s first
//   node scripts/capture/shots.mjs --speed 2              animation speed for roll shots
//   node scripts/capture/shots.mjs --list                print the scenes and shots
//   node scripts/capture/shots.mjs --probe probe.js      print an expression's value in each scene's page (the save it resumed is window.__save)
//   node scripts/capture/shots.mjs --cpuprofile dir      record 5 s of each scene's page with the CPU profiler (dir/<scene>.cpuprofile,
//                                                opened by Chrome DevTools' Performance panel) and print its heaviest functions
//   node scripts/capture/shots.mjs --compiles out.json   attribute every pipeline, shader program and node build to the object,
//                                                material, geometry and pass that caused it (scripts/capture/compiles-hook.js;
//                                                diff two runs with scripts/capture/compiles-diff.mjs). Run from another
//                                                checkout's folder (node <this>/scripts/shots.mjs) to measure that tree.
//   ... --compiles out.json --compiles-dedupe    the same, with every instanced mesh's matrix buffer named alike (an
//                                                experiment: how many programs three's per-node buffer names cost)
//   CHROME_PATH=...                              another Chromium (see scripts/lib/chrome.mjs)
//
// It writes <out>/<backend>/<scene>-<shot>.png and <out>/<backend>/stats.json: for each shot its
// draw calls and triangles (median and max over 30 frames), the page's console errors, and for each
// scene how long the title took to load and how long the game's shaders took to compile. A shot
// whose subject isn't on the board (no foundry built yet) is listed as missing, not failed.

import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

/** Close-ups: what to look at, from how far, at what pitch (radians above the horizon) and turn. */
const near = (focus, extra = {}) => ({ focus, distance: 5.2, pitch: 0.62, yaw: 0.5, ...extra });

/** A step run in the page before a shot, as source (a shot is passed to the page, so it holds no functions). */
const inPage = (fn, arg) => ({ ui: `(${fn})(${JSON.stringify(arg)})` });

/** In the page: turn the expansions' ledger to a page (by its tab), so a shot shows that panel. */
const ledgerPage = (page) =>
  inPage((name) => {
    const tab = [...document.querySelectorAll('.ledger-tabs button')].find((b) => b.textContent.startsWith(name));
    tab?.click();
  }, page);

/**
 * In the page: dress the shown game for a panel's shot (the game is paused at your roll, so nothing
 * overwrites it): your ventures, the Almanac's card, a decision owed on top of the stack. Only the
 * interface's copy changes; the host's game is untouched.
 */
const dress = (d) =>
  inPage((d) => {
    const ui = window.__ui.getState();
    // (`fresh` dresses the game as it was before any shot dressed it; otherwise dressings add up.)
    window.__undressed ??= ui.view;
    const v = structuredClone(d.fresh ? window.__undressed : ui.view);
    if (d.fresh) ui.set({ banners: [] });
    if (d.hand) v.ext.guilds.hands[ui.me] = d.hand;
    if (d.almanac) Object.assign(v.ext.almanac, d.almanac);
    if (d.pending) v.pending.push({ ...d.pending, players: [ui.me] });
    ui.set({ view: v });
    if (d.syncDecision) window.session.presenter?.updateInteraction(v);
    if (d.page) [...document.querySelectorAll('.ledger-tabs button')].find((b) => b.textContent.startsWith(d.page))?.click();
  }, d);

/** In the page, once the dressing has drawn: the pointer over the `n`th of a kind of card (its preview opens beside it). */
const hoverCard = (selector, n) =>
  inPage(
    ({ selector, n }) =>
      setTimeout(() => {
        const el = document.querySelectorAll(selector)[n];
        el?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      }, 400),
    { selector, n },
  );

/** In the page, on a phone: open the ledger's sheet at a page (by its tab). */
const openSheet = (page) =>
  inPage(
    (page) =>
      setTimeout(() => {
        document.querySelector('.ledger-btn')?.click();
        setTimeout(() => [...document.querySelectorAll('.ledger-tabs button')].find((b) => b.textContent.startsWith(page))?.click(), 300);
      }, 300),
    page,
  );
/**
 * In the page: the defender's banner, and the defence token lifting off it on its way to seat `to`
 * (the presenter's own flight), at ordinary speed and started just as the shot's settling wait ends,
 * so `after` is the time into the flight.
 */
const tokenFlight = (b, to) => ({
  ui: `${banner(b).ui}; (() => { const ui = window.__ui.getState(); ui.set({ hurry: false, settings: { ...ui.settings, animationSpeed: 1 } }); setTimeout(() => window.session.presenter.flyToken('art/icons/defence.webp', ${to}).catch(() => {}), 850); })()`,
});

/** In the page: hang a banner (with its painting) as the presenter would for an award or a happening. */
const banner = (b) =>
  inPage((b) => {
    const ui = window.__ui.getState();
    ui.set({ banners: [] });
    ui.pushBanner(b, 60000);
  }, b);

/**
 * Each scene is one game, played forward by the bots to `turns` (and on, up to 60 turns more, until
 * everything in `need` is on the board), at a frozen time of day. Its shots are camera views of
 * that one board. The first shot of a scene is always the home view.
 */
/** Each expansion's page as its contents entry names it. */
const PAGE_NAMES = { sea: 'Sea Lanes', guilds: 'Guilds & Garrisons', invasion: 'Invasion', rivers: 'Rivers', caravans: 'Wagon Trains', fisheries: 'Fisheries', oil: 'Oil', almanac: 'Almanac', harbourmaster: 'Port Captain' };

/** In the page: the tooltip's words, and the screen reader's island entries for the tiles that are face down or drew a number. */
const HOVER_TEXT = `(() => {
  const li = [...document.querySelectorAll('section[aria-label="The island, tile by tile"] li')].map((x) => x.textContent);
  const s = window.__ui.getState().view;
  const fog = s.ext.sea.fog;
  return {
    tooltip: document.querySelector('.tooltip')?.innerText ?? null,
    unexplored: li.filter((t) => t.startsWith('Unexplored')),
    hiddenCount: fog.hidden.length,
    found: li.filter((t) => t.includes('number')).slice(0, 3),
  };
})()`;

/**
 * In the page: every guild track's seat on a building, three near one another (cities first), and
 * one road of each player cracked by a quake, as the state would have them, shown at once. Only
 * the interface's copy and the marks change; the host's game is untouched.
 */
const dressWorks = inPage(() => {
  const ui = window.__ui.getState();
  const v = structuredClone(ui.view);
  const built = v.buildings.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  const at = (i) => v.board.vertices[i];
  const first = built.find((i) => v.buildings[i].kind === 'city') ?? built[0];
  const near = built.sort((a, b) => Number(v.buildings[b].kind === 'city') - Number(v.buildings[a].kind === 'city') || Math.hypot(at(a).x - at(first).x, at(a).z - at(first).z) - Math.hypot(at(b).x - at(first).x, at(b).z - at(first).z));
  for (const b of v.buildings) if (b) delete b.seat;
  ['learning', 'commerce', 'statecraft'].forEach((t, k) => near[k] !== undefined && (v.buildings[near[k]].seat = t));
  v.players.forEach((_, p) => {
    const e = v.routes.findIndex((r) => r?.owner === p && r.kind === 'road');
    if (e >= 0) v.routes[e].cracked = true;
  });
  ui.set({ view: v });
  void window.session.view.syncMarks(v, 'none');
});

export const SCENES = [
  {
    name: 'base',
    mix: null,
    seed: 7,
    turns: 18,
    time: 0.42,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'city', ...near('city') },
      { name: 'junction', ...near('junction', { distance: 2.2, pitch: 0.75 }) },
      // People and animals at one scale: a flock with its walkers, goats, the clay diggers.
      { name: 'pasture', ...near('terrain:pasture', { distance: 2.2, pitch: 0.55 }) },
      { name: 'mountains', ...near('terrain:mountains', { distance: 2.4, pitch: 0.55 }) },
      { name: 'hills', ...near('terrain:hills', { distance: 2.2, pitch: 0.55 }) },
      { name: 'walker', ...near('junction', { distance: 1.4, pitch: 0.5, yaw: 1.1 }) },
      { name: 'flat', flat: true },
    ],
  },
  // The weather and the day as the player changes them in Settings (each comes on quickly), and
  // what the island does in them: the flock huddled in the rain, bedded down and lanterns out at night.
  {
    name: 'baseWeather',
    mix: null,
    seed: 7,
    turns: 18,
    time: 0.42,
    shots: [
      { name: 'rain', focus: 'home', ui: "window.session.world.weather.setMode('rain', 0, true)", after: 7000 },
      { name: 'rain-pasture', ...near('terrain:pasture', { distance: 2.2, pitch: 0.55 }), after: 3000 },
      { name: 'storm', focus: 'home', ui: "window.session.world.weather.setMode('storm', 0, true)", after: 6000 },
      { name: 'clear', focus: 'home', ui: "window.session.world.weather.setMode('clear', 0, true)", after: 6000 },
    ],
  },
  { name: 'baseNight', mix: null, seed: 7, turns: 18, time: 0.72, shots: [{ name: 'home', focus: 'home', after: 12000 }, { name: 'pasture', ...near('terrain:pasture', { distance: 2.2, pitch: 0.55 }) }, { name: 'walker', ...near('junction', { distance: 1.6, pitch: 0.5, yaw: 1.1 }) }] },
  {
    name: 'allHands',
    mix: 'allHands',
    // (Of 48 seeds on the dealt map, the one that brings every piece out soonest: ships, a bridge,
    // a wall, a guild seat, a foundry, a lost number and posts of both ranks by turn 45, and the
    // corsair on the water again by turn 62.)
    seed: 39,
    turns: 40,
    need: ['ship', 'bridge', 'wall', 'seat', 'foundry', 'lost', 'post2', 'post3', 'corsair'],
    time: 0.42,
    budget: true,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'castle', ...near('castle') },
      { name: 'oasis', ...near('oasis') },
      { name: 'lake', ...near('terrain:lake') },
      { name: 'swamp', ...near('terrain:swamp') },
      { name: 'bounty', ...near('terrain:bounty') },
      { name: 'well', ...near('well') },
      { name: 'gin', ...near('gin', { distance: 2.6, pitch: 0.5 }) },
      { name: 'sweep', ...near('sweep', { distance: 2.2, pitch: 0.55 }) },
      { name: 'river', ...near('river') },
      { name: 'bridge', ...near('bridge') },
      { name: 'mouth', ...near('mouth', { distance: 3.4, pitch: 0.42, yaw: 0.9 }) },
      { name: 'source', ...near('source', { distance: 3.6 }) },
      { name: 'mill', ...near('mill', { distance: 1.9, pitch: 0.55, yaw: 0.4 }) },
      { name: 'ship', ...near('ship') },
      { name: 'corsair', ...near('corsair') },
      { name: 'warden', ...near('warden', { distance: 4.2 }) },
      { name: 'raider', ...near('raider', { distance: 4.2 }) },
      { name: 'wagon', ...near('wagon', { distance: 4.2 }) },
      { name: 'wall', ...near('wall', { distance: 4.2 }) },
      { name: 'seat', ...near('seat', { distance: 4.2 }) },
      { name: 'foundry', ...near('foundry', { distance: 4.2 }) },
      { name: 'ground', ...near('ground') },
      { name: 'netting', ...near('ground', { distance: 2.0, pitch: 0.8, yaw: 0.3 }) },
      { name: 'cluster', ...near('terrain:lake', { distance: 2.2, pitch: 0.95 }) },
      { name: 'lost', ...near('lost') },
      { name: 'overhead', focus: 'home', pitch: 1.38, distanceScale: 1.05 },
      { name: 'castle-near', ...near('castle', { distance: 2.6, pitch: 0.5 }) },
      { name: 'ship-near', ...near('ship', { distance: 2.0, pitch: 0.45 }) },
      { name: 'corsair-near', ...near('corsair', { distance: 2.4, pitch: 0.5 }) },
      { name: 'warden-near', ...near('warden', { distance: 1.6, pitch: 0.5 }) },
      { name: 'raider-near', ...near('raider', { distance: 1.8, pitch: 0.5 }) },
      { name: 'post2', ...near('warden:2', { distance: 1.8, pitch: 0.5 }) },
      { name: 'post3', ...near('warden:3', { distance: 1.8, pitch: 0.5 }) },
      { name: 'post-rest', ...near('warden:rest', { distance: 1.8, pitch: 0.5 }) },
      { name: 'camp', ...near('camp', { distance: 2.2, pitch: 0.5 }) },
      { name: 'trader', ...near('trader', { distance: 1.8, pitch: 0.5 }) },
      { name: 'post-edge', ...near('warden:edge', { distance: 1.8, pitch: 0.5 }) },
      { name: 'wagon-near', ...near('wagon', { distance: 1.6, pitch: 0.5 }) },
      { name: 'wall-near', ...near('wall', { distance: 2.0, pitch: 0.55 }) },
      { name: 'bridge-near', ...near('bridge', { distance: 1.8, pitch: 0.5 }) },
      { name: 'foundry-near', ...near('foundry', { distance: 1.8, pitch: 0.5 }) },
      // A flood on one island (All Hands floods one at a time), mid-way, close and from home.
      { name: 'flood', ...near('coastal', { distance: 6, pitch: 0.5 }), act: 'flood', until: 'window.session.world.ocean.surge.value > 0.42', after: 1 },
      { name: 'floodHome', focus: 'home', after: 1 },
      // A hex producing, caught a moment in (its life's production effect).
      { name: 'bountyYield', ...near('terrain:bounty', { distance: 3.4, pitch: 0.75 }), produce: 0.7 },
      { name: 'lakeYield', ...near('terrain:lake', { distance: 3.4, pitch: 0.75 }), produce: 0.9 },
      { name: 'flat', flat: true },
    ],
  },
  {
    name: 'voyage',
    mix: 'longVoyage',
    seed: 5,
    turns: 20,
    time: 0.38,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'fleet', ...near('fleet', { distance: 6 }) },
      { name: 'fleet-near', ...near('fleet', { distance: 2.6, pitch: 0.45 }) },
      { name: 'ship', ...near('ship') },
      { name: 'ship-near', ...near('ship', { distance: 2.0, pitch: 0.45 }) },
      { name: 'corsair', ...near('corsair') },
      { name: 'seat', ...near('seat', { distance: 3.6 }) },
      { name: 'seat-near', ...near('seat', { distance: 1.8, pitch: 0.45 }) },
      { name: 'warden-near', ...near('warden', { distance: 1.6, pitch: 0.5 }) },
      { name: 'wall-near', ...near('wall', { distance: 2.0, pitch: 0.55 }) },
      { name: 'flat', flat: true },
    ],
  },
  { name: 'allHandsNight', mix: 'allHands', seed: 7, turns: 22, need: ['foundry'], time: 0.72, shots: [{ name: 'home', focus: 'home' }, { name: 'foundry', ...near('foundry', { distance: 4.2 }) }, { name: 'swamp', ...near('terrain:swamp') }, { name: 'gin', ...near('gin', { distance: 2.6, pitch: 0.5 }) }, { name: 'netting', ...near('ground', { distance: 2.0, pitch: 0.8, yaw: 0.3 }) }, { name: 'foundry-near', ...near('foundry', { distance: 1.8, pitch: 0.5 }) }, { name: 'warden-near', ...near('warden', { distance: 1.6, pitch: 0.5 }) }, { name: 'castle-near', ...near('castle', { distance: 2.6, pitch: 0.5 }) }] },
  { name: 'sea', mix: 'sea', seed: 11, turns: 24, need: ['ship'], time: 0.25, shots: [{ name: 'home', focus: 'home' }, { name: 'ship', ...near('ship') }, { name: 'corsair', ...near('corsair') }, { name: 'bounty', ...near('terrain:bounty') }, { name: 'flat', flat: true }] },
  {
    name: 'fog',
    mix: 'sea',
    map: 'fogBank',
    seed: 5,
    turns: 10,
    time: 0.12,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'fog', ...near('fog') },
      // The pointer over a face-down hex with land under it (needs --hud): its tooltip and the screen reader's island must say only "Unexplored".
      { name: 'hover', ...near('fogLand', { distance: 6 }), hover: 'hidden', js: HOVER_TEXT },
      // A face-down land hex found, mid-way: the fog parting, the tile breaking the surface, settled.
      { name: 'part', ...near('fogLand', { distance: 6 }), act: 'reveal', after: 700 },
      { name: 'boil', ...near('fogLand', { distance: 6 }), still: true, after: 900 },
      { name: 'rise', ...near('fogLand', { distance: 6 }), still: true, until: 'window.session.world.effects.riseValues[window.__actHex] > -0.45', after: 1 },
      { name: 'surge', ...near('fogLand', { distance: 6 }), still: true, after: 380 },
      { name: 'found', ...near('fogLand', { distance: 6 }), still: true, after: 2600 },
      { name: 'flat', flat: true },
    ],
  },
  // The bank at night: its lanterns and flickers show.
  { name: 'fogNight', mix: 'sea', map: 'fogBank', seed: 5, turns: 10, time: 0.72, shots: [{ name: 'home', focus: 'home' }, { name: 'fog', ...near('fog') }] },
  // Oil alone, a turn before its first flood: every coast floods (driven in the page, and shot mid-way).
  {
    name: 'oilFlood',
    mix: 'oil',
    seed: 2,
    turns: 33,
    time: 0.42,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'flood', ...near('coastal', { distance: 6, pitch: 0.5 }), act: 'flood', until: 'window.session.world.ocean.surge.value > 0.42', after: 1 },
      { name: 'swept', ...near('coastal', { distance: 6, pitch: 0.5 }), still: true, after: 1100 },
      { name: 'ebb', ...near('coastal', { distance: 6, pitch: 0.5 }), still: true, until: 'window.session.world.ocean.surge.value < 0.04', after: 300 },
      { name: 'wide', focus: 'home', act: 'flood', until: 'window.session.world.ocean.surge.value > 0.45', after: 1 },
    ],
  },
  // Later in a game on the fog map, resumed: the hexes found so far are land, with their numbers.
  {
    name: 'fogFound',
    mix: 'sea',
    map: 'fogBank',
    seed: 7,
    turns: 34,
    time: 0.3,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'found', ...near('found') },
      // The pointer over a hex found in the fog (needs --hud): its terrain, resource and the number it drew.
      { name: 'hover', ...near('found'), still: true, hover: 'found', js: HOVER_TEXT },
    ],
  },
  // Each drawn and grown map of the pools (docs/maps.md), early in a game with the features it deals.
  ...[
    ['longIsle', 'invasion,rivers,caravans,fisheries,oil'],
    ['isthmus', 'rivers,fisheries'],
    ['horseshoe', 'invasion,caravans'],
    ['wild', 'rivers,caravans,oil'],
    ['strait', 'sea,fisheries'],
    ['twinIsles', 'sea,rivers'],
    ['lostSea', 'sea,oil'],
  ].map(([map, mix]) => ({ name: `map-${map}`, mix, map, seed: 3, turns: 6, time: 0.3, shots: [{ name: 'home', focus: 'home' }, { name: 'flat', flat: true }] })),
  { name: 'siege', mix: 'siege', seed: 15, turns: 26, need: ['post2', 'post3'], time: 0.53, shots: [{ name: 'home', focus: 'home' }, { name: 'castle', ...near('castle') }, { name: 'raider', ...near('raider', { distance: 4.2 }) }, { name: 'warden', ...near('warden', { distance: 4.2 }) }, { name: 'post2', ...near('warden:2', { distance: 1.8, pitch: 0.5 }) }, { name: 'post3', ...near('warden:3', { distance: 1.8, pitch: 0.5 }) }, { name: 'post-rest', ...near('warden:rest', { distance: 1.8, pitch: 0.5 }) }, { name: 'camp', ...near('camp', { distance: 2.2, pitch: 0.5 }) }, { name: 'flat', flat: true }] },
  { name: 'rivermouth', mix: 'rivermouth', seed: 10, turns: 22, time: 0.42, shots: [{ name: 'home', focus: 'home' }, { name: 'river', ...near('river') }, { name: 'bridge', ...near('bridge') }, { name: 'source', ...near('source', { distance: 4.2 }) }, { name: 'stream', ...near('river', { distance: 2.4, pitch: 0.7, yaw: 0.2 }) }, { name: 'mill', ...near('mill', { distance: 1.9, pitch: 0.55, yaw: 0.4 }) }, { name: 'mouth', ...near('mouth', { distance: 3.4, pitch: 0.42, yaw: 0.9 }) }, { name: 'fall', ...near('mouth', { distance: 1.6, pitch: 0.2, yaw: 0 }) }, { name: 'fall-side', ...near('mouth', { distance: 1.6, pitch: 0.2, yaw: 5.25 }) }, { name: 'oasis', ...near('oasis') }, { name: 'wagon', ...near('wagon', { distance: 4.2 }) }, { name: 'flat', flat: true }] },
  { name: 'fisheries', mix: 'fishingArchipelago', seed: 4, turns: 16, time: 0.25, shots: [{ name: 'home', focus: 'home' }, { name: 'lake', ...near('terrain:lake') }, { name: 'ground', ...near('ground') }, { name: 'netting', ...near('ground', { distance: 2.0, pitch: 0.8, yaw: 0.3 }) }, { name: 'flat', flat: true }] },
  // The wardens' posts at every rank (played on until a mustered rank 2 and 3 stand), and a camp.
  { name: 'posts', mix: 'siege', seed: 11, turns: 50, need: ['post3'], time: 0.42, shots: [{ name: 'home', focus: 'home' }, { name: 'post2', ...near('warden:2', { distance: 1.8, pitch: 0.5 }) }, { name: 'post3', ...near('warden:3', { distance: 1.8, pitch: 0.5 }) }, { name: 'post2-mid', ...near('warden:2', { distance: 4.2 }) }, { name: 'post3-mid', ...near('warden:3', { distance: 4.2 }) }, { name: 'post-rest', ...near('warden:rest', { distance: 1.8, pitch: 0.5 }) }, { name: 'camp', ...near('camp', { distance: 2.2, pitch: 0.5 }) }] },
  { name: 'allHandsLate', mix: 'allHands', seed: 14, turns: 27, need: ['seat', 'foundry', 'wall'], time: 0.25, shots: [{ name: 'home', focus: 'home' }, { name: 'seat', ...near('seat', { distance: 4.2 }) }, { name: 'wall', ...near('wall', { distance: 4.2 }) }, { name: 'foundry', ...near('foundry', { distance: 4.2 }) }] },
  // The works up close (the same game, dressed: all three guildhalls, a cracked road of each player).
  {
    name: 'works',
    mix: 'allHands',
    seed: 14,
    turns: 27,
    need: ['seat', 'foundry', 'wall'],
    time: 0.42,
    prep: dressWorks.ui,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'guilds', ...near('mark:seat:commerce', { distance: 3.4, pitch: 0.55 }) },
      { name: 'seat-learning', ...near('mark:seat:learning', { distance: 1.25, pitch: 0.42 }) },
      { name: 'seat-commerce', ...near('mark:seat:commerce', { distance: 1.25, pitch: 0.42 }) },
      { name: 'seat-statecraft', ...near('mark:seat:statecraft', { distance: 1.25, pitch: 0.42 }) },
      { name: 'foundry-close', ...near('mark:foundry', { distance: 1.2, pitch: 0.45 }) },
      { name: 'foundry-back', ...near('mark:foundry', { distance: 1.2, pitch: 0.45, yaw: 2.6 }) },
      { name: 'cracked', ...near('mark:cracked', { distance: 1.1, pitch: 1.0 }) },
      { name: 'cracked-wide', ...near('mark:cracked', { distance: 3.2, pitch: 0.8 }) },
      { name: 'castle-close', ...near('castle', { distance: 1.4, pitch: 0.7, yaw: 0.9 }) },
    ],
  },
  { name: 'worksNight', mix: 'allHands', seed: 14, turns: 27, need: ['seat', 'foundry', 'wall'], time: 0.72, prep: dressWorks.ui, shots: [{ name: 'home', focus: 'home' }, { name: 'guilds', ...near('mark:seat:commerce', { distance: 3.4, pitch: 0.55 }) }, { name: 'foundry-close', ...near('mark:foundry', { distance: 1.2, pitch: 0.45 }) }, { name: 'cracked', ...near('mark:cracked', { distance: 1.1, pitch: 1.0 }) }, { name: 'castle-close', ...near('castle', { distance: 1.4, pitch: 0.7, yaw: 0.9 }) }] },
  {
    name: 'oil',
    mix: 'oil',
    seed: 4,
    turns: 13,
    need: ['lost', 'foundry'],
    time: 0.42,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'well', ...near('well') },
      { name: 'gin', ...near('gin', { distance: 2.6, pitch: 0.5 }) },
      { name: 'sweep', ...near('sweep', { distance: 2.2, pitch: 0.55 }) },
      { name: 'gin-near', ...near('pad:gin', { distance: 1.2, pitch: 0.45 }) },
      { name: 'sweep-near', ...near('pad:sweep', { distance: 0.95, pitch: 0.45 }) },
      { name: 'foundry', ...near('foundry', { distance: 4.2 }) },
      { name: 'lost', ...near('lost') },
      // Pollution striking a forest, mid-way: the disc cracking, the blight spreading, the waste.
      { name: 'strike', ...near('forest'), act: 'pollute', until: 'window.session.world.effects.scarValues[window.__actHex] > 0.12', after: 1 },
      { name: 'blight', ...near('forest'), still: true, until: 'window.session.world.effects.scarValues[window.__actHex] > 0.6', after: 1 },
      { name: 'waste', ...near('forest'), still: true, until: 'window.session.world.effects.scarValues[window.__actHex] >= 1', after: 1500 },
      { name: 'flat', flat: true },
    ],
  },
  // (All Hands has no raider fleet: Invasion takes its place. Its longships are shot here and in voyage; the course is the fleet, its buoys and the coast it will land on.)
  { name: 'fleet', mix: 'longVoyage', seed: 6, turns: 24, time: 0.42, shots: [{ name: 'home', focus: 'home' }, { name: 'course', ...near('fleet', { distance: 10, pitch: 0.8, yaw: 0.2 }) }, { name: 'fleet-near', ...near('fleet', { distance: 2.6, pitch: 0.45 }) }, { name: 'flat', flat: true }] },
  // All Hands played on until a caravan's train crosses the sea: its merchantman.
  { name: 'allHandsSea', mix: 'allHands', seed: 1, turns: 50, need: ['merchant'], time: 0.42, shots: [{ name: 'merchant', ...near('merchant', { distance: 4.2 }) }, { name: 'merchant-near', ...near('merchant', { distance: 1.8, pitch: 0.45 }) }] },
  { name: 'oilLate', mix: 'oil', seed: 20, turns: 66, time: 0.42, shots: [{ name: 'home', focus: 'home' }, { name: 'lost', ...near('lost') }, { name: 'flat', flat: true }] },
  // Each face is reached by an actual engine roll at a human turn. Capture at simulation times,
  // rather than wall-clock delays: expensive screenshots must not let a throw sink between shots.
  ...['ship', 'learning', 'commerce', 'statecraft'].map((face) => ({
    name: `dice-${face}`, mix: 'guilds', seed: 7, turns: 18, time: 0.42, eventFace: face,
    shots: [{ name: 'home', focus: 'home' }, { name: 'air', focus: 'home', diceFrame: 0.25 }, { name: 'landed', focus: 'home', diceFrame: 1.8 }],
  })),
  // (The base game's two plain dice, for comparisons of the dice themselves.)
  { name: 'dice-plain', mix: null, seed: 7, turns: 18, time: 0.42,
    shots: [{ name: 'home', focus: 'home' }, { name: 'air', focus: 'home', diceFrame: 0.25 }, { name: 'landed', focus: 'home', diceFrame: 1.8 }] },
  { name: 'dice-card', mix: 'allHands', seed: 7, turns: 22, time: 0.42, eventFace: 'ship', separateRed: true,
    shots: [{ name: 'home', focus: 'home' }, { name: 'air', focus: 'home', diceFrame: 0.25 }, { name: 'landed', focus: 'home', diceFrame: 1.8 }] },
  // A base game's HUD, the calm one the expansions' is measured against.
  { name: 'baseHud', mix: null, seed: 7, turns: 18, time: 0.42, hud: true, shots: [{ name: 'home', focus: 'home' }, { name: 'phone', focus: 'home', viewport: [390, 844] }] },
  // The interface's painted cards: the ledger's pages, an award's banner and a happening's (always with the HUD).
  {
    name: 'cardArt',
    mix: 'allHands',
    seed: 7,
    turns: 22,
    time: 0.42,
    hud: true,
    shots: [
      { name: 'home', focus: 'home' },
      { name: 'guilds', focus: 'home', ...ledgerPage('Guilds') },
      { name: 'ventures', focus: 'home', ...dress({ page: 'Ventures', hand: ['trader', 'spymaster', 'waterworks', 'cartel'], almanac: { card: 14, happening: 'harvest' } }) },
      { name: 'ventureLimit', focus: 'home', ...dress({ page: 'Ventures', hand: ['trader', 'spymaster', 'waterworks', 'cartel', 'rally'], pending: { kind: 'guilds/ventureLimit', data: { kind: 'guilds/ventureLimit' } } }) },
      { name: 'decision-tribute', focus: 'home', ...dress({ syncDecision: true, pending: { kind: 'guilds/tribute', data: { kind: 'guilds/tribute', target: 1, left: 2, seen: { brick: 1, wood: 1 } } } }) },
      { name: 'decision-phone', focus: 'home', viewport: [390, 844], ...dress({ syncDecision: true, pending: { kind: 'guilds/tribute', data: { kind: 'guilds/tribute', target: 1, left: 2, seen: { brick: 1, wood: 1 } } } }) },
      { name: 'decision-landscape', focus: 'home', viewport: [844, 390], ...dress({ syncDecision: true, pending: { kind: 'guilds/tribute', data: { kind: 'guilds/tribute', target: 1, left: 2, seen: { brick: 1, wood: 1 } } } }) },
      { name: 'almanacTake', focus: 'home', ...dress({ almanac: { card: 14, happening: 'harvest' }, pending: { kind: 'almanac/take', data: { happening: 'harvest' } } }) },
      { name: 'award', focus: 'home', ...banner({ title: 'Port Captain', subtitle: 'You — 5 points on harbours (+2 VP)', tone: 'player', player: 0, art: 'art/awards/harbourmaster.webp' }) },
      { name: 'defender', focus: 'home', ...banner({ title: 'Defender of the island', subtitle: 'Bram — the raiders beaten off, 7 against 5 (+1 VP)', tone: 'player', player: 2, art: 'art/awards/defender.webp' }) },
      { name: 'happening', focus: 'home', ...banner({ title: 'A good harvest', subtitle: 'The Almanac · Everyone takes a resource', tone: 'info', art: 'art/happenings/harvest.webp' }) },
      // A venture's card opened from its row, and the Almanac's from its chip.
      { name: 'preview', focus: 'home', ui: `${dress({ fresh: true, page: 'Ventures', hand: ['trader', 'spymaster', 'cornerMarket', 'dowry'], almanac: { card: 14, happening: 'harvest' } }).ui};${hoverCard('.vh-card', 2).ui}` },
      { name: 'previewAlmanac', focus: 'home', ui: `${dress({ fresh: true, almanac: { card: 14, happening: 'quarrel' } }).ui};${hoverCard('.al-face', 0).ui}` },
      // The same HUD in a short window and on both phone shapes.
      { name: 'short', focus: 'home', viewport: [1600, 900], ...dress({ fresh: true, hand: ['trader', 'spymaster', 'waterworks', 'cartel', 'rally'], almanac: { card: 14, happening: 'harvest' }, pending: { kind: 'almanac/take', data: { happening: 'harvest' } } }) },
      { name: 'phone', focus: 'home', viewport: [390, 844], ...dress({ fresh: true, hand: ['trader', 'spymaster', 'waterworks', 'cartel'], almanac: { card: 14, happening: 'harvest' } }) },
      { name: 'phone-take', focus: 'home', viewport: [390, 844], ...dress({ fresh: true, almanac: { card: 14, happening: 'harvest' }, pending: { kind: 'almanac/take', data: { happening: 'harvest' } } }) },
      { name: 'landscape', focus: 'home', viewport: [844, 390], ...dress({ fresh: true, hand: ['trader', 'spymaster', 'waterworks', 'cartel'], almanac: { card: 14, happening: 'harvest' } }) },
      { name: 'landscape-take', focus: 'home', viewport: [844, 390], ...dress({ fresh: true, almanac: { card: 14, happening: 'harvest' }, pending: { kind: 'almanac/take', data: { happening: 'harvest' } } }) },
      { name: 'phone-almanac', focus: 'home', viewport: [390, 844], ui: `${dress({ fresh: true, almanac: { card: 14, happening: 'quake' } }).ui};${inPage(() => setTimeout(() => document.querySelector('.al-chip-btn')?.click(), 400)).ui}` },
      // (Last: the sheet stays open once opened.)
      { name: 'phone-ledger', focus: 'home', viewport: [390, 844], ui: `${dress({ fresh: true, hand: ['trader', 'spymaster', 'waterworks', 'cartel'], almanac: { card: 14, happening: 'harvest' } }).ui};${openSheet('Ventures').ui}` },
      // The defence token held up under the banner, then on its way to the defender's panel (shot as soon as it sets off).
      { name: 'defenderToken', focus: 'home', after: 150, ...tokenFlight({ title: 'Defender of the island', subtitle: 'Bram — the raiders beaten off, 7 against 5 (+1 VP)', tone: 'player', player: 2, art: 'art/awards/defender.webp' }, 2) },
      { name: 'defenderFlight', focus: 'home', until: "window.__ui.getState().flights.some((f) => f.kind === 'token' && f.to.x < f.from.x - 100)", ...tokenFlight({ title: 'Defender of the island', subtitle: 'Bram — the raiders beaten off, 7 against 5 (+1 VP)', tone: 'player', player: 2, art: 'art/awards/defender.webp' }, 2) },
      // The phone's menu, with the supply (last: the dialog stays open once opened).
      { name: 'phone-menu', focus: 'home', viewport: [390, 844], ui: `${dress({ fresh: true }).ui};${inPage(() => setTimeout(() => window.__ui.getState().set({ modal: 'menu' }), 400)).ui}` },
    ],
  },
  // How to play, opened through window.__ui: from the title (every expansion), and in an All Hands
  // game (the mix first), on the desktop and both compact sizes. A `rules` shot keeps the interface,
  // and writes the dialog's text beside its picture.
  {
    name: 'rulesTitle',
    title: true,
    seed: 7,
    time: 0.42,
    shots: [
      { name: 'contents', rules: { tab: 'expansions' } },
      { name: 'guilds', rules: { tab: 'expansions', page: 'Guilds & Garrisons' } },
      { name: 'guilds-ventures', rules: { tab: 'expansions', page: 'Guilds & Garrisons', open: true, scroll: 1500 } },
      { name: 'mix', rules: { tab: 'expansions', page: 'Playing them together' } },
      { name: 'oil', rules: { tab: 'expansions', page: 'Oil' } },
      { name: 'oil-phone', rules: { tab: 'expansions', page: 'Oil', viewport: [390, 844], scroll: 700 } },
      ...Object.entries(PAGE_NAMES).map(([id, page]) => ({ name: `text-${id}`, rules: { tab: 'expansions', page, textOnly: true } })),
    ],
  },
  {
    name: 'rulesAllHands',
    mix: 'allHands',
    seed: 7,
    turns: 6,
    time: 0.42,
    hud: true,
    shots: [
      { name: 'rules', rules: { tab: 'rules' } },
      { name: 'contents', rules: { tab: 'expansions' } },
      { name: 'mix', rules: { tab: 'expansions', page: 'This game' } },
      { name: 'mix-turn', rules: { tab: 'expansions', page: 'This game', scroll: 420 } },
      { name: 'invasion', rules: { tab: 'expansions', page: 'Invasion' } },
      { name: 'sea-together', rules: { tab: 'expansions', page: 'Sea Lanes', scroll: 2400 } },
      ...['sea', 'guilds', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster'].map((id) => ({ name: `text-${id}`, rules: { tab: 'expansions', page: PAGE_NAMES[id], textOnly: true } })),
      { name: 'contents-phone', rules: { tab: 'expansions', viewport: [390, 844] } },
      { name: 'caravans-phone', rules: { tab: 'expansions', page: 'Wagon Trains', viewport: [390, 844], scroll: 500 } },
      { name: 'contents-landscape', rules: { tab: 'expansions', viewport: [844, 390] } },
      { name: 'fisheries-landscape', rules: { tab: 'expansions', page: 'Fisheries', viewport: [844, 390], scroll: 300 } },
    ],
  },
];

// (Ad hoc: --extra scene.json adds a scene for looking into something.)
if (opt('extra')) SCENES.push(JSON.parse(readFileSync(opt('extra'), 'utf8')));

if (flag('list')) {
  for (const s of SCENES) console.log(`${s.name}: ${s.title ? 'the title' : (s.mix ?? 'base game')}${s.map ? ` on ${s.map}` : ''}, seed ${s.seed}${s.title ? '' : `, turn ${s.turns}`}, time ${s.time}\n  ${s.shots.map((x) => x.name).join(', ')}`);
  process.exit(0);
}

const only = opt('only')?.split(',');
const shotFilter = opt('shot');
const out = resolve(opt('out', 'shots'));
const quality = opt('q', 'high');
const backends = flag('both') ? ['webgpu', 'webgl'] : flag('webgl') ? ['webgl'] : ['webgpu'];
const keepHud = flag('hud') || flag('flat');
const flat = flag('flat');
const reduce = flag('reduce');
const animationSpeed = Number(opt('speed', 1));
// A file of JavaScript run in the page after the flat map is up and before its photograph (it can read
// window.__ui and window.session, and change the state shown): for looking at situations a game hasn't reached.
const flatJs = opt('flat-js') ? readFileSync(resolve(opt('flat-js')), 'utf8') : null;
const width = Number(opt('width', 1600)), height = Number(opt('height', 1000));


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
// (--compiles: the hook is served from this script's folder, so the tree being measured, the
// working directory, needs no copy of it. It becomes the first import of the game's entry, so it
// is in place before the renderer or any scene object exists.)
const compilesOut = opt('compiles') ? resolve(opt('compiles')) : null;
const compilesHook = {
  name: 'compiles-hook',
  enforce: 'pre',
  resolveId: (id) => (id === 'virtual:compiles-hook' ? '\0compiles-hook' : undefined),
  load: (id) => (id === '\0compiles-hook' ? (flag('compiles-dedupe') ? 'globalThis.__COMPILES_DEDUPE = true;\n' : '') + readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'compiles-hook.js'), 'utf8') : undefined),
  transform: (code, id) => (id.endsWith('/src/main.tsx') ? { code: `import 'virtual:compiles-hook';\n${code}`, map: null } : undefined),
};
const compiles = {};
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1' }, clearScreen: false, plugins: compilesOut ? [compilesHook] : [] });
await server.listen();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal'],
});

/** In the page: play the bots forward and return a save of the game at the human seat's next roll. */
async function buildSave({ mix, map, seed, turns, need, eventFace, separateRed }) {
  const P = await import('/src/engine/presets.ts');
  const H = await import('/src/game/host.ts');
  const E = await import('/src/engine/index.ts');
  const { PRESET_COLORS } = await import('/src/render/board/pieces.ts');
  const chosen = mix ? (P.PRESETS.find((p) => p.id === mix)?.expansions ?? mix.split(',')) : [];
  const m = chosen.length ? P.mixOf(chosen, map) : null;
  if (m && !m.playable) throw new Error(`mix ${mix} is not playable`);
  const cfg = {
    ...(m && { modules: m.modules, map: m.map === 'classic' ? undefined : m.map, knobs: m.knobs, victoryPoints: m.target }),
    name: 'You',
    color: 'red',
    opponents: 3,
    difficulty: 'normal',
    layout: 'random',
    numberPlacement: 'spiral',
    seed,
  };
  const others = PRESET_COLORS.map((c) => c.id).filter((c) => c !== 'red');
  const names = ['Ada', 'Bram', 'Cora'];
  const seats = [{ name: 'You', color: 'red', isBot: true, difficulty: 'normal' }, ...names.map((name, i) => ({ name, color: others[i], isBot: true, difficulty: 'normal' }))];
  // (The board dealt as a new game's is, and carried in the save as the session does.)
  const options = { seed, layout: cfg.layout, numberPlacement: cfg.numberPlacement, victoryPoints: cfg.victoryPoints, modules: cfg.modules, map: cfg.map, knobs: cfg.knobs };
  cfg.board = E.dealBoard(seats.length, options);
  const host = new H.LocalHost(seats, { ...options, board: cfg.board });
  // What a scene needs on the board before it's photographed (it plays on past `turns` until then).
  const HAS = {
    ship: (s) => s.routes.some((r) => r?.kind === 'ship'),
    bridge: (s) => s.routes.some((r) => r?.kind === 'bridge'),
    seat: (s) => s.buildings.some((b) => b?.seat),
    wall: (s) => s.buildings.some((b) => b?.wall),
    foundry: (s) => s.buildings.some((b) => b?.foundry),
    lost: (s) => (s.ext.oil?.lost?.length ?? 0) > 0,
    raider: (s) => (s.ext.invasion?.raiders ?? []).some((n) => n > 0),
    warden: (s) => s.wardens.length > 0,
    post2: (s) => s.wardens.some((w) => w.rank === 2 && w.mustered && (w.edge !== null || w.vertex !== null)),
    post3: (s) => s.wardens.some((w) => w.rank === 3 && w.mustered && (w.edge !== null || w.vertex !== null)),
    merchant: (s) => (s.ext.caravans?.trains ?? []).some((t) => t.edges.some((e) => !s.board.edges[e].land)),
    corsair: (s) => s.ext.sea?.corsair != null,
  };
  const ready = (s) => (need ?? []).every((k) => HAS[k](s));
  for (let i = 0; i < 80000; i++) {
    const s = host.state;
    if (s.phase === 'gameOver') throw new Error(`the game ended at turn ${s.turn} before the scene was ready: try another seed`);
    if (s.turn >= turns && s.currentPlayer === 0 && s.phase === 'roll' && s.pending.length === 0 && !s.trade && (ready(s) || s.turn >= turns + 60)) {
      const peek = eventFace ? E.applyAction(s, 0, { type: 'rollDice' }) : null;
      if (!eventFace || (peek.ok && peek.events.some((e) => e.type === 'guilds/eventDie' && e.face === eventFace && (!separateRed || e.independentRed)))) break;
    }
    const d = host.nextBotAction();
    if (!d) throw new Error(`no bot could act (turn ${s.turn}, phase ${s.phase})`);
    const r = host.submitBot(d);
    if (!r.ok) throw new Error(r.error);
  }
  host.dispose();
  const o = host.state.options;
  return {
    v: 3,
    rules: o.rules,
    ...(o.modules.length > 0 && { moduleRules: o.moduleRules }),
    cfg,
    seats: seats.map((s, i) => ({ ...s, isBot: i > 0 })),
    avatars: [-1, 0, 1, 2],
    history: host.history,
    turn: host.state.turn,
    savedAt: Date.now(),
  };
}

/** In the page: where a focus is on the board (x, z), or null when it isn't there. */
function locate(focus) {
  const s = window.__ui.getState().view;
  const board = s.board;
  const hex = (id) => (id === null || id === undefined ? null : { x: board.hexes[id].x, z: board.hexes[id].z });
  const vert = (id) => ({ x: board.vertices[id].x, z: board.vertices[id].z });
  const edge = (id) => {
    const e = board.edges[id];
    const a = vert(e.a), b = vert(e.b);
    return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  };
  const [kind, arg] = focus.split(':');
  const ext = s.ext ?? {};
  switch (kind) {
    case 'terrain':
      return hex(board.hexes.find((h) => h.terrain === arg)?.id);
    case 'castle':
      return hex(board.features.castle);
    case 'oasis':
      return hex(board.features.oasis?.hex);
    case 'well':
      return hex(board.hexes.find((h) => h.well)?.id);
    case 'gin':
      return hex(board.hexes.find((h) => h.well && h.numbers.length && (h.terrain === 'desert' || h.terrain === 'swamp'))?.id);
    case 'pad': {
      // A well's works themselves, on their pad ('pad:gin' or 'pad:sweep').
      const t = window.session.world.tiles?.tiles.find((o) => o.shape.ctx.pad && o.shape.ctx.pad.gin === (arg === 'gin'));
      return t ? { x: t.hex.x + t.shape.ctx.pad.x, z: t.hex.z + t.shape.ctx.pad.z } : null;
    }
    case 'sweep':
      return hex(board.hexes.find((h) => h.well && !(h.numbers.length && (h.terrain === 'desert' || h.terrain === 'swamp')))?.id);
    case 'river': {
      const r = board.features.rivers?.[0];
      const hs = r?.hexes ?? [];
      return hs.length ? hex(hs[Math.floor(hs.length / 2)]) : null;
    }
    case 'mouth': {
      // Where a river pours over the cliff into the sea (arg: which river, the first by default).
      const r = board.features.rivers?.[Number(arg ?? 0)];
      return r ? edge(r.bridgeSites[r.bridgeSites.length - 1]) : null;
    }
    case 'source': {
      const r = board.features.rivers?.[Number(arg ?? 0)];
      return r ? hex(r.hexes[0]) : null;
    }
    case 'mill': {
      // The rivers' watermill, if the board has room for one (see riverCourse.ts placeMill).
      const t = window.session.world.tiles?.tiles.find((o) => o.shape.ctx.river?.mill);
      return t ? { x: t.hex.x + t.shape.ctx.river.mill.x, z: t.hex.z + t.shape.ctx.river.mill.z } : null;
    }
    case 'ground':
      return hex(board.hexes.find((h) => h.terrain === 'sea' && h.numbers.length > 0)?.id);
    case 'fog':
      return hex(ext.sea?.fog?.hidden?.[0]);
    case 'fogLand':
      return hex(ext.sea?.fog?.hidden?.find((h) => board.hexes[h].terrain !== 'sea'));
    case 'found': {
      const drawn = Object.keys(ext.sea?.fog?.drawn ?? {});
      return drawn.length ? hex(Number(drawn[0])) : null;
    }
    case 'lost':
      return hex(ext.oil?.lost?.[0]?.hex);
    case 'coastal': {
      const shore = new Set(board.edges.filter((e) => e.coastal).flatMap((e) => [e.a, e.b]));
      const v = s.buildings.findIndex((b, i) => b && shore.has(i));
      return v >= 0 ? vert(v) : null;
    }
    case 'forest': {
      const lost = new Set((ext.oil?.lost ?? []).map((l) => l.hex));
      return hex(board.hexes.find((h) => h.terrain === 'forest' && h.numbers.length && !lost.has(h.id))?.id);
    }
    case 'corsair':
      return hex(ext.sea?.corsair);
    case 'ship':
    case 'bridge': {
      const e = s.routes.findIndex((r) => r?.kind === kind);
      return e >= 0 ? edge(e) : null;
    }
    case 'warden': {
      // (arg: a rank, mustered; 'rest' for one at rest; 'edge' for one on an edge; none for any warden on the board.)
      const w = s.wardens.find((w) => (w.edge !== null || w.vertex !== null) && (arg === undefined || (arg === 'rest' ? !w.mustered : arg === 'edge' ? w.edge !== null : w.rank === Number(arg) && w.mustered)));
      return !w ? null : w.edge !== null ? edge(w.edge) : vert(w.vertex);
    }
    case 'trader':
      return hex(ext.guilds?.trader?.hex);
    case 'raider': {
      const i = (ext.invasion?.raiders ?? []).findIndex((n) => n > 0);
      return i >= 0 ? hex(i) : null;
    }
    case 'camp': {
      const i = (ext.invasion?.raiders ?? []).findIndex((n) => n >= 3);
      return i >= 0 ? hex(i) : null;
    }
    case 'fleet':
      return window.session.view?.fleetFocus?.(s) ?? null;
    case 'merchant': {
      const e = ext.caravans?.trains?.flatMap((t) => t.edges).find((e) => !board.edges[e].land);
      return e === undefined ? null : edge(e);
    }
    case 'wagon': {
      const e = ext.caravans?.trains?.find((t) => t.edges.length > 0)?.edges[0];
      return e === undefined ? null : edge(e);
    }
    case 'city':
    case 'wall':
    case 'seat':
    case 'foundry': {
      // ('seat:commerce': the building holding that track's seat.)
      const v = s.buildings.findIndex((b) => b && (kind === 'city' ? b.kind === 'city' : arg ? b[kind] === arg : b[kind]));
      return v >= 0 ? vert(v) : null;
    }
    case 'junction': {
      // A corner with no building where two or more of one seat's roads meet (they join there).
      const v = board.vertices.findIndex((vx, i) => !s.buildings[i] && vx.edges.some((e, j) => s.routes[e]?.kind === 'road' && vx.edges.some((f, k) => k > j && s.routes[f]?.kind === 'road' && s.routes[f].owner === s.routes[e].owner)));
      return v >= 0 ? vert(v) : null;
    }
    case 'cracked': {
      const e = s.routes.findIndex((r) => r?.cracked);
      return e >= 0 ? edge(e) : null;
    }
    case 'mark': {
      // An expansion piece itself, where the marks stood it ('mark:seat:learning': its model's key names the track).
      const extra = focus.split(':')[2];
      const p = [...(window.session.view?.marks?.pieces?.values() ?? [])].find((p) => p.kind === arg && !p.gone && (!extra || p.geo.includes(extra)));
      return p ? { x: p.obj.position.x, z: p.obj.position.z } : null;
    }
  }
  throw new Error(`unknown focus ${focus}`);
}

/**
 * Open How to play as a `rules` shot asks: its tab, a page from the Expansions contents (by the start
 * of its name), every fold opened, and the dialog scrolled. Returns the dialog's text.
 */
async function openRules(page, ui) {
  await page.setViewportSize(ui.viewport ? { width: ui.viewport[0], height: ui.viewport[1] } : { width, height });
  await page.evaluate(() => window.__ui.getState().set({ modal: null }));
  await page.waitForSelector('.modal .rules', { state: 'detached', timeout: 8000 }).catch(() => {});
  await page.evaluate(() => window.__ui.getState().set({ modal: 'rules' }));
  await page.waitForSelector('#rules-tab-rules');
  if (ui.tab) await page.click(`#rules-tab-${ui.tab}`);
  if (ui.page) {
    const name = new RegExp(`^${ui.page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    await page.locator('.rules-entry').filter({ has: page.locator('.rules-entry-name', { hasText: name }) }).first().click();
  }
  if (ui.open) await page.evaluate(() => document.querySelectorAll('.rules details').forEach((d) => (d.open = true)));
  await page.evaluate((y) => document.querySelector('.modal')?.scrollTo(0, y ?? 0), ui.scroll ?? 0);
  await page.waitForTimeout(700);
  return page.evaluate(() => document.querySelector('.modal')?.innerText ?? '');
}

/** In the page: point at a hex. 'hidden' is the first face-down hex with land under it, 'found' the first one that drew a number from the face-down discs. */
function hover(kind) {
  const st = window.__ui.getState().view;
  const fog = st.ext.sea.fog;
  const id = kind === 'hidden' ? fog.hidden.find((h) => st.board.hexes[h].terrain !== 'sea') : Number(Object.keys(fog.drawn)[0]);
  window.session.input.hoverTile(id, window.innerWidth * 0.55, window.innerHeight * 0.4);
  window.__hoverHex = id;
}

/**
 * In the page: start one of the island's effects as the game would show it, without waiting for
 * it, so shots can catch it mid-way. 'reveal': the first face-down land hex is found (drawing an 8).
 */
function act(kind) {
  const w = window.session.world;
  const st = window.__ui.getState().view;
  if (kind === 'reveal') {
    const fog = st.ext.sea.fog;
    const hex = fog.hidden.find((h) => st.board.hexes[h].terrain !== 'sea');
    const next = { ...st, ext: { ...st.ext, sea: { ...st.ext.sea, fog: { ...fog, hidden: fog.hidden.filter((h) => h !== hex), drawn: { ...fog.drawn, [hex]: 8 } } } } };
    window.__actHex = hex;
    void w.fog.reveal(next, hex, {});
    return;
  }
  if (kind === 'pollute') {
    // Pollution strikes the first forest still bearing its number (the richest ground to blight).
    const oil = st.ext.oil;
    const lost = new Set(oil.lost.map((l) => l.hex));
    const hex = st.board.hexes.find((h) => h.terrain === 'forest' && h.numbers.length && !lost.has(h.id)).id;
    const next = { ...st, ext: { ...st.ext, oil: { ...oil, lost: [...oil.lost, { hex, number: st.board.hexes[hex].numbers[0] }] } } };
    window.__actHex = hex;
    void w.disasters.strike(next, hex, st.board.hexes[hex].numbers[0], {});
    return;
  }
  if (kind === 'flood') {
    // A flood on the island of the first coastal building (every coast where there's one island).
    const shore = new Set(st.board.edges.filter((e) => e.coastal).flatMap((e) => [e.a, e.b]));
    const first = st.buildings.findIndex((b, v) => b && shore.has(v));
    const isl = (v) => st.board.hexes[st.board.vertices[v].hexes.find((h) => st.board.hexes[h].terrain !== 'sea')]?.island;
    const island = st.board.islands.length > 1 ? isl(first) : null;
    const hit = st.buildings.map((b, v) => (b && shore.has(v) && (island === null || isl(v) === island) ? v : -1)).filter((v) => v >= 0);
    const washed = hit.filter((v) => st.buildings[v].kind === 'settlement');
    const dropped = hit.filter((v) => st.buildings[v].kind === 'city');
    const owners = Object.fromEntries(hit.map((v) => [v, st.buildings[v].owner]));
    window.__actHex = first;
    void w.disasters.flood(window.session.view, st.board, { island, washed, dropped, owners }, {});
    return;
  }
  throw new Error(`unknown act ${kind}`);
}

/** In the page: the renderer's counters over `frames` frames (median and max). */
async function sample(frames) {
  const r = window.session.world.stage.renderer;
  const calls = [], tris = [];
  for (let i = 0; i < frames; i++) {
    await new Promise((ok) => requestAnimationFrame(() => ok()));
    calls.push(r.info.render.drawCalls);
    tris.push(r.info.render.triangles);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return { drawCalls: med(calls), drawCallsMax: Math.max(...calls), triangles: med(tris), trianglesMax: Math.max(...tris), geometries: r.info.memory.geometries, textures: r.info.memory.textures };
}

const scenes = SCENES.filter((s) => !only || only.includes(s.name));
let failed = false;

for (const backend of backends) {
  const dir = join(out, backend);
  mkdirSync(dir, { recursive: true });
  const stats = { backend, quality, viewport: [width, height], view: flat ? '2d' : '3d', reduce, animationSpeed, scenes: {} };
  for (const scene of scenes) {
    const shots = scene.shots.filter((x, i) => i === 0 || !shotFilter || shotFilter.split(',').some((name) => x.name.includes(name)));
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    // (The quality is set, not only asked for with ?q=: left on Auto, the game steps itself down
    // under load, and a busy machine's counts would no longer compare.)
    await page.addInitScript((quality) => {
      try {
        localStorage.clear();
        localStorage.setItem('exploratory.touchCoach', '1');
        localStorage.setItem('exploratory.settings', JSON.stringify({ quality, v: 3 }));
      } catch {}
    }, quality);
    const rec = { mix: scene.mix, map: scene.map ?? null, seed: scene.seed, turns: scene.turns, time: scene.time, shots: {}, missing: [], errors };
    const t0 = Date.now();
    try {
      await page.goto(`${base}/?q=${quality}&time=${scene.time}&seed=${scene.seed}${backend === 'webgl' ? '&webgl' : ''}`);
      await page.waitForFunction(() => window.__ui?.getState().worldReady && window.session?.world, null, { timeout: 180000 });
      rec.titleMs = Date.now() - t0;
      // Pin the preset: `?q=` only picks the starting one, and with the setting left on Auto a run
      // whose frames are slow (a busy machine, two runs at once) steps down a preset mid-run, which
      // compiles every material again for the other lighting (seconds, and hundreds of pipelines).
      await page.evaluate((q) => {
        const ui = window.__ui.getState();
        ui.set({ settings: { ...ui.settings, quality: q } });
      }, quality);
      // (A title scene photographs the dialogs over the title, with no game started.)
      if (!scene.title) {
        const save = await page.evaluate(buildSave, { mix: scene.mix, map: scene.map, seed: scene.seed, turns: scene.turns, need: scene.need, eventFace: scene.eventFace, separateRed: scene.separateRed });
        rec.turn = save.turn;
        rec.actions = save.history.length;
        rec.compileMs = await page.evaluate(async (save) => {
          const w = window.session.world;
          const orig = w.precompile.bind(w);
          let ms = 0;
          w.precompile = async (...a) => {
            const t = performance.now();
            try {
              return await orig(...a);
            } finally {
              ms += performance.now() - t;
            }
          };
          // (Kept for a probe that leaves the game and starts it again: window.session.start(__save.cfg, __save).)
          window.__save = save;
          if (window.__compiles) window.__compiles.phase = 'start';
          await window.session.start(save.cfg, save);
          if (window.__compiles) window.__compiles.phase = 'after';
          w.precompile = orig;
          return Math.round(ms);
        }, save);
        await page.evaluate(({ reduce, animationSpeed }) => {
          const ui = window.__ui.getState();
          ui.set({ settings: { ...ui.settings, animationSpeed, reduceMotion: reduce ? 'on' : 'off' } });
          window.session.world.settled();
        }, { reduce, animationSpeed });
        await page.waitForTimeout(1500);
        // What the compile built: render pipelines, distinct shader programs, and node builds (one
        // per material and geometry layout). Steadier than compileMs on a busy machine.
        rec.compiled = await page.evaluate(() => {
          const r = window.session.world.stage.renderer;
          const p = r._pipelines;
          return { pipelines: p?.caches?.size ?? null, vertex: p?.programs?.vertex?.size ?? null, fragment: p?.programs?.fragment?.size ?? null, nodeBuilds: r._nodes?.nodeBuilderCache?.size ?? null };
        });
        rec.quality = await page.evaluate(() => window.__ui.getState().quality);
        if (rec.quality !== quality) console.log(`     ${scene.name}: the preset changed to ${rec.quality} during the run, so its compile counts cover two presets`);
        if (compilesOut) {
          const dump = await page.evaluate(() => {
            const st = window.session.world.stage;
            return window.__compiles.dump({ main: st.camera, sunShadow: st.sun?.shadow?.camera });
          });
          compiles[`${backend}/${scene.name}`] = { mix: scene.mix, seed: scene.seed, turns: scene.turns, quality, compiled: rec.compiled, compileMs: rec.compileMs, ...dump };
          writeFileSync(compilesOut, JSON.stringify({ cwd: process.cwd(), scenes: compiles }));
          const ev = dump.events;
          const n = (phase, k) => ev.filter((e) => e.phase === phase && (k === 'node' ? e.kind === 'node' : e.kind === 'pipeline' && (k === 'p' || e[k]))).length;
          console.log(`     ${scene.name} compiles: ` + ['title', 'start', 'after'].map((ph) => `${ph} ${n(ph, 'p')} pipelines, ${n(ph, 'newV')} vertex, ${n(ph, 'newF')} fragment, ${n(ph, 'node')} node builds`).join('; ') + `; final ${JSON.stringify(dump.final)}; main-thread ms ${JSON.stringify(dump.ms)}`);
        }
        // (--roll or a scene's `roll`: the human seat rolls, and production plays out for that many
        // seconds before the shots: the harvest walking home, each terrain's production effect.)
        const roll = scene.roll ?? (flag('roll') ? Number(opt('roll', 8)) || 8 : 0);
        if (roll) {
          // (Under the Almanac a draw stands in for the dice: then the first legal move.)
          await page.evaluate(async () => {
            const E = await import('/src/engine/index.ts');
            const s = window.__ui.getState();
            if (window.session.presenter.act({ type: 'rollDice' }) !== null) window.session.presenter.act(E.legalActions(s.view, s.me)[0]);
          });
          await page.waitForTimeout(roll * 1000);
          rec.travellers = await page.evaluate(() => {
            const b = window.session.view?.travellers?.batch;
            return b ? { parts: b.instanceCount, room: b.maxInstanceCount } : null;
          });
        }
        // (--probe file.js: an expression worked out in the page once the game is set up, its value printed.)
        if (opt('probe')) console.log(`${scene.name} probe:`, JSON.stringify(await page.evaluate(readFileSync(opt('probe'), 'utf8'))));
        // (--cpuprofile dir: five seconds of the game running, from the CPU profiler.)
        if (opt('cpuprofile')) {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
          await cdp.send('Profiler.start');
          await page.waitForTimeout(5000);
          const { profile } = await cdp.send('Profiler.stop');
          mkdirSync(resolve(opt('cpuprofile')), { recursive: true });
          writeFileSync(join(resolve(opt('cpuprofile')), `${scene.name}.cpuprofile`), JSON.stringify(profile));
          // Self time by function (and where it is), heaviest first.
          const self = new Map(), dt = profile.timeDeltas, total = dt.reduce((a, b) => a + b, 0);
          const byId = new Map(profile.nodes.map((n) => [n.id, n]));
          profile.samples.forEach((id, i) => {
            const f = byId.get(id).callFrame;
            const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/(node_modules\/\.vite\/deps\/|src\/)/, '')}:${f.lineNumber + 1}`;
            self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
          });
          console.log(`${scene.name} cpu profile (self time):`);
          for (const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
          await cdp.detach();
        }
        // (A scene's `prep`: run in the page once its game is up, before any shot: see dressWorks.)
        if (scene.prep) {
          await page.evaluate(scene.prep);
          await page.waitForTimeout(1500);
        }
      }
      if (!keepHud && !scene.hud && !scene.title) await page.addStyleTag({ content: '#root { visibility: hidden !important; } .flat-board, .flat-board * { visibility: visible !important; }' });
      const home = await page.evaluate(() => {
        const p = window.session.world.rig.snapshot();
        return { target: [p.target.x, p.target.y, p.target.z], distance: p.distance, pitch: p.pitch, yaw: p.yaw };
      });
      if (flat) await page.evaluate(async () => {
        const { setViewMode } = await import('/src/app/viewMode.ts');
        await setViewMode('2d', true);
      });
      let rollStarted = false;
      for (const shot of shots) {
        if (shot.rules) {
          const text = await openRules(page, { ...shot.rules, open: shot.rules.open || shot.rules.textOnly });
          writeFileSync(join(dir, `${scene.name}-${shot.name}.txt`), text);
          const file = `${scene.name}-${shot.name}.png`;
          if (!shot.rules.textOnly) await page.screenshot({ path: join(dir, file) });
          rec.shots[shot.name] = { file: shot.rules.textOnly ? null : file, chars: text.length };
          console.log(`${backend} ${scene.name}-${shot.name}: ${text.length} characters of text`);
          continue;
        }
        await page.setViewportSize({ width: shot.viewport?.[0] ?? width, height: shot.viewport?.[1] ?? height });
        if (shot.flat) {
          // The flat map (ui/FlatBoard.tsx): switched to at once, photographed with the island's
          // renderer idle behind it (so no draw-call counts), and last in its scene.
          await page.evaluate(async () => (await import('/src/app/viewMode.ts')).setViewMode('2d', true));
          await page.waitForTimeout(2200);
          if (flatJs) {
            const note = await page.evaluate(`(async () => { ${flatJs} })()`);
            if (note !== undefined) console.log(`     flat-js: ${JSON.stringify(note)}`);
            await page.waitForTimeout(1500);
          }
          const file = `${scene.name}-${shot.name}.png`;
          await page.screenshot({ path: join(dir, file) });
          rec.shots[shot.name] = { file };
          console.log(`${backend} ${scene.name}-${shot.name}`);
          continue;
        }
        const where = shot.focus === 'home' ? { x: home.target[0], z: home.target[2] } : await page.evaluate(locate, shot.focus);
        if (!where) {
          rec.missing.push(shot.name);
          continue;
        }
        // (A shot can take its own window size, as the How to play ones do. The camera stays at home
        // for it, which the rig refits to the new shape by itself.)
        const size = shot.viewport ? { width: shot.viewport[0], height: shot.viewport[1] } : { width, height };
        const was = page.viewportSize();
        if (was.width !== size.width || was.height !== size.height) {
          await page.setViewportSize(size);
          await page.waitForTimeout(600);
        }
        if (!shot.still && !shot.viewport)
        await page.evaluate(
          ({ where, shot, home }) => {
            if (window.__ui.getState().viewMode === '2d') return;
            const rig = window.session.world.rig;
            rig.limits.minDist = 1.5;
            rig.limits.radius = rig.limits.hardRadius = 12;
            const p = rig.snapshot();
            const isHome = shot.focus === 'home';
            const y = isHome ? home.target[1] : (window.session.view?.groundY?.(where.x, where.z) ?? 0.3);
            p.target.set(where.x, y, where.z);
            p.distance = isHome ? home.distance * (shot.distanceScale ?? 1) : shot.distance;
            p.pitch = shot.pitch ?? home.pitch;
            p.yaw = shot.yaw ?? home.yaw;
            rig.jumpTo(p);
          },
          { where, shot, home },
        );
        if (shot.diceFrame !== undefined) {
          if (!rollStarted) {
            await page.evaluate(() => {
              const w = window.session.world;
              // The same throw every run (the solver draws from Math.random), so before and after
              // shots of the dice can be compared face for face.
              const plan = w.dice.plan.bind(w.dice);
              w.dice.plan = (...a) => {
                const random = Math.random;
                let x = 0x9e3779b9;
                Math.random = () => ((x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) ^ (x + 0x6d2b79f5)) >>> 0) / 4294967296;
                try {
                  return plan(...a);
                } finally {
                  Math.random = random;
                }
              };
              const diceUpdate = w.dice.update.bind(w.dice);
              const totalUpdate = w.diceTotal.update.bind(w.diceTotal);
              // Freeze only this effect; the island continues to render normally for counters.
              w.dice.update = () => {};
              w.diceTotal.update = () => {};
              window.__advanceDice = (t) => {
                diceUpdate(Math.max(0, t - w.dice.t) / w.dice.speed, w.stage.camera);
                totalUpdate(t > 1.2 ? 0.6 : 0, w.stage.camera);
              };
              // Hold the presenter at the roll's reveal beat. Production belongs to a different
              // shot: its travellers must not obscure the faces, nor race the screenshot timer.
              const presenter = window.session.presenter;
              const wait = presenter.wait.bind(presenter);
              presenter.wait = (s) => s === 1.35 || s === 1.05 ? new Promise(() => {}) : wait(s);
              window.session.presenter.act({ type: 'rollDice' });
            });
            await page.waitForFunction(() => window.session.world.dice.active);
            if (flat) await page.waitForSelector('.fd-die');
            rollStarted = true;
          }
          await page.evaluate((t) => window.__advanceDice(t), shot.diceFrame);
          // Let the HUD's own timer reveal the same result as the floating cubes.
          if (shot.diceFrame > 1.2) await page.waitForTimeout(1250 / animationSpeed);
          else await page.waitForTimeout(40);
          rec.roll = await page.evaluate(() => window.__ui.getState().diceRoll);
        } else {
          if (shot.ui) await page.evaluate(shot.ui);
          // (A shot of an effect mid-way starts it once the camera has settled, and is taken once
          // `until` holds in the page and `after` ms more; `still` shots follow on from the one
          // before, the camera where it was.)
          if (!shot.still) await page.waitForTimeout(shot.focus === 'home' ? 900 : 1400);
          if (shot.act) await page.evaluate(act, shot.act);
          if (shot.hover) {
            // (The pointer over a hex, as the flat map's tiles and the island's picking report it: needs --hud to be in the picture.)
            await page.evaluate(hover, shot.hover);
            await page.waitForTimeout(300);
          }
          // (Ad hoc: a snippet run in the page, its result printed, for looking into something.)
          if (shot.js) console.log(`     ${shot.name}: ${JSON.stringify(await page.evaluate(shot.js))}`);
          if (shot.produce) {
            // Set the hex under the focus producing, and shoot `produce` seconds into it.
            await page.evaluate((where) => {
              const hex = window.__ui.getState().view.board.hexes.find((h) => Math.hypot(h.x - where.x, h.z - where.z) < 0.01);
              if (hex) window.session.world.produce(hex.id);
            }, where);
            await page.waitForTimeout(shot.produce * 1000);
          }
          if (shot.until) await page.waitForFunction(shot.until, null, { timeout: 20000, polling: 'raf' });
          if (shot.after) await page.waitForTimeout(shot.after);
        }
        const file = `${scene.name}-${shot.name}.png`;
        // (Frames can stall for a moment while the machine is busy, leaving the last view on the
        // canvas: wait until the new one is being drawn before taking it. Not for a shot of an
        // effect mid-way, which would move on meanwhile.)
        if (!flat && !shot.act && !shot.until && !shot.after) for (let i = 0; i < 8 && (await page.evaluate(sample, 3)).drawCalls === 0; i++) await page.waitForTimeout(1500);
        await page.screenshot({ path: join(dir, file) });
        if (shot.hover) await page.evaluate(() => window.session.input?.hoverTile(-1, 0, 0));
        // The flat map intentionally idles the renderer behind it. Its DOM is the photograph.
        const counters = flat ? {} : await page.evaluate(sample, shot.after ? 4 : 30);
        if (!flat && counters.drawCalls === 0) throw new Error(`no frames drawn for ${shot.name}`);
        rec.shots[shot.name] = { file, ...counters };
        console.log(`${backend} ${scene.name}-${shot.name}${flat ? ' (flat)' : `: ${counters.drawCalls} calls, ${(counters.triangles / 1e6).toFixed(2)} M tris`}`);
      }
    } catch (e) {
      failed = true;
      rec.failure = String(e?.stack ?? e);
      console.log(`FAIL ${backend} ${scene.name}: ${e?.message ?? e}`);
      await page.screenshot({ path: join(dir, `${scene.name}-FAILED.png`) }).catch(() => {});
    }
    if (rec.missing.length) console.log(`     ${scene.name}: not on this board: ${rec.missing.join(', ')}`);
    if (errors.length) {
      failed = true;
      console.log(`FAIL ${backend} ${scene.name}: ${errors.length} console errors\n     ${errors.slice(0, 5).join('\n     ')}`);
    }
    stats.scenes[scene.name] = rec;
    await ctx.close();
  }
  // (A run of some scenes keeps the others' records from an earlier run into the same folder.)
  const file = join(dir, 'stats.json');
  let kept = {};
  try {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    if (old.quality === quality && String(old.viewport) === String(stats.viewport)) kept = old.scenes;
  } catch {}
  stats.scenes = { ...kept, ...stats.scenes };
  writeFileSync(file, JSON.stringify(stats, null, 2));
}

await browser.close();
await server.close();
console.log(failed ? '\nsome scenes failed' : `\nall shots in ${out}`);
process.exit(failed ? 1 : 0);
