// The online walkthrough in a real browser: two people, each in a browser context of their own
// (their own storage, so their own guest), against the dev server's online play. The host opens
// the Multiplayer page and a harbour, and copies its link; the other opens it, takes a seat, picks
// a colour and is ready; the host sets sail with the crew filling the last seat. Both play the
// opening placements on the flat map and then a few turns by clicking the game's own buttons and
// spots; what can't be clicked (a bot's offer to answer, a discard, the robber) is decided with the
// bots' logic through the dev build's `window.session`, and said so in the log. Then the table
// itself: the pause, quick talk and a reaction, Looking for / Spare, a trade offered to one person
// (left in the dock while he answers) and accepted, the guest conceding (the crew sails his seat
// and he watches), and the game played on to its results card at both ends (the room's points to
// win lowered, and the animations and the crew sped up, through the dev hooks, so it ends in
// minutes). Every step is screenshotted at 1280×800, 375×812 and a foldable phone's cover screen,
// 382×580, into shots/online/ (gitignored).
//
//   node scripts/checks/online-e2e.mjs                  starts the dev server (as `vite --port 5191 --strictPort`) itself, and stops it after
//   ONLINE_URL=http://localhost:5173 node scripts/checks/online-e2e.mjs     against a dev server already up
//   CHROME_PATH=…  TURNS=3  SHOTS=shots/online  HEADED=1
//
// Fails (exit 1) on a page error, a console error, a failed request, or a step that never comes.

import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT ?? 5191);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = resolve(root, process.env.SHOTS ?? 'shots/online');
const TURNS = Number(process.env.TURNS ?? 3);
const SIZES = [
  [1280, 800],
  [375, 812],
  [382, 580],
];
mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};

// ------------------------------------------------------------------ the dev server

let vite = null;
let URL = process.env.ONLINE_URL?.replace(/\/$/, '');
if (!URL) {
  URL = `http://localhost:${PORT}`;
  // `npm run dev` on its own port: the project's config and its online play plugin, which reads
  // PUBLIC_URL when the first /api request comes. (node_modules may be a link to another
  // checkout's: its real folder is let through Vite's file guard too, or the fonts are refused.)
  process.env.PUBLIC_URL = URL;
  process.env.ALLOWED_ORIGINS = URL;
  const { createServer } = await import('vite');
  vite = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', server: { port: PORT, strictPort: true, fs: { allow: [root, realpathSync(join(root, 'node_modules'))] } } });
  await vite.listen();
  console.log(`dev server on ${URL}`);
}

// ------------------------------------------------------------------ two people

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !process.env.HEADED,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal'],
});

async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: SIZES[0][0], height: SIZES[0][1] } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
  });
  page.on('response', (r) => r.status() >= 400 && errors.push(`${name}: ${r.status()} ${r.url()}`));
  await page.addInitScript((who) => {
    try {
      localStorage.setItem('exploratory.name', who);
      localStorage.setItem('exploratory.touchCoach', '1');
      localStorage.removeItem('exploratory.view');
    } catch {}
  }, name);
  return { name, ctx, page, errors };
}

const host = await person('Ana');
const guest = await person('Ben');
const both = [host, guest];

let step = 0;
/** A step's screenshot from each person, at both sizes. */
async function shoot(label, who = both) {
  step++;
  for (const p of who) {
    for (const [w, h] of SIZES) {
      await p.page.setViewportSize({ width: w, height: h });
      await p.page.waitForTimeout(700);
      const file = join(SHOTS, `${String(step).padStart(2, '0')}-${label}-${p.name.toLowerCase()}-${w}.png`);
      // (A long wait: two browsers building their islands at once can hold a frame back a while.)
      await p.page.screenshot({ path: file, timeout: 180_000 });
    }
    await p.page.setViewportSize({ width: SIZES[0][0], height: SIZES[0][1] });
  }
  console.log(`     shot ${step} ${label}`);
}

/** Wait for `fn` in a person's page; a step that never comes is a failure, with a picture of where they were. */
const until = (p, fn, what, timeout = 90_000, arg) =>
  p.page.waitForFunction(fn, arg, { timeout, polling: 200 }).then(
    () => true,
    async () => {
      await p.page.screenshot({ path: join(SHOTS, `fail-${p.name.toLowerCase()}-${what.replace(/\W+/g, '-')}.png`) }).catch(() => {});
      return check(false, `${p.name}: timed out waiting for ${what}`);
    },
  );

const ui = (p, fn, arg) => p.page.evaluate(fn, arg);

try {
  // ---------------------------------------------------------------- the menu and the Multiplayer page
  for (const p of both) await p.page.goto(URL);
  await until(host, () => [...document.querySelectorAll('.menu-card')].some((b) => /Multiplayer/.test(b.textContent)), 'the menu', 120_000);
  await shoot('menu', [host]);
  await host.page.locator('.menu-card', { hasText: 'Multiplayer' }).click();
  await until(host, () => [...document.querySelectorAll('.online-way-card')].some((b) => /Host a room/.test(b.textContent)), 'the Multiplayer page');
  await shoot('multiplayer', [host]);

  // ---------------------------------------------------------------- the host opens a harbour
  // (Host a room is a step of its own: the table's settings, then Open the room.)
  await host.page.locator('.online-way-card', { hasText: 'Host a room' }).click();
  await until(host, () => [...document.querySelectorAll('button')].some((b) => /Open the room/.test(b.textContent) && b.getAttribute('aria-disabled') !== 'true'), 'the Host a room step');
  await host.page.getByRole('button', { name: /Open the room/ }).click();
  await until(host, () => !!document.querySelector('.harbour .room-code') && [...document.querySelectorAll('.seat-card')].some((c) => c.classList.contains('mine')), 'the harbour, seated');
  const code = (await host.page.locator('.room-code').textContent()).replace(/\s/g, '');
  check(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$/.test(code), `the room code ${code}`);
  check(new globalThis.URL(host.page.url()).pathname === `/r/${code}`, 'the address bar shows the room');
  // (Few points to win, so the game reaches its results card in minutes: the room's setting, through the dev hooks.)
  await ui(host, () => window.session.room.settings({ victoryPoints: 4 }));
  console.log('     Ana: the points to win set to 4 through the dev hooks');
  await until(host, async () => (await import('/src/online/store.ts')).useOnline.getState().room?.settings.victoryPoints === 4, 'the points to win');
  await host.page.getByRole('button', { name: /Copy link/ }).click();
  const link = await ui(host, () => navigator.clipboard.readText()).catch(() => `${URL}/r/${code}`);
  check(link === `${URL}/r/${code}`, `the link copied (${link})`);
  await shoot('harbour-opened', [host]);

  // ---------------------------------------------------------------- the other comes by the link
  await guest.page.goto(link);
  await until(guest, () => !!document.querySelector('.harbour .room-code') && !!document.querySelector('.come-aboard'), 'the harbour by the link', 120_000);
  await shoot('harbour-by-link', [guest]);
  await guest.page.locator('.come-aboard button', { hasText: 'Take a seat' }).click();
  await until(guest, () => [...document.querySelectorAll('.seat-card')].some((c) => c.classList.contains('mine')), 'a seat taken');
  // A colour of his own: the first one nobody else has.
  await guest.page.locator('.my-seat .swatch:not([disabled]):not(.on)').first().click();
  await guest.page.getByRole('button', { name: /I’m ready/ }).click();
  await until(host, () => [...document.querySelectorAll('.seat-card.human')].some((c) => !c.classList.contains('mine') && c.classList.contains('ready')), 'the guest ready, as the host sees it');
  // A word in the harbour, both ways.
  await host.page.locator('.harbour-chat input').fill('Fair winds!');
  await host.page.locator('.harbour-chat .chat-form button').click();
  await guest.page.locator('.harbour-chat .chat-quick button').first().click();
  await until(guest, () => document.querySelectorAll('.harbour-chat .chat-line').length >= 2, 'the harbour talk');
  await until(host, () => document.querySelectorAll('.harbour-chat .chat-line').length >= 2, 'the harbour talk');
  await shoot('harbour-ready');

  // ---------------------------------------------------------------- set sail, the crew in the empty seat
  await host.page.getByRole('button', { name: /Set sail/ }).click();
  for (const p of both) await until(p, () => window.__ui?.getState().screen === 'game' && !!window.__ui.getState().view, 'the game', 180_000);
  await shoot('setting-sail');
  for (const p of both) await until(p, () => !window.__ui.getState().busy, 'the island risen', 180_000);
  await shoot('game-start');

  // ---------------------------------------------------------------- the opening and a few turns
  const fallbacks = new Set();
  /**
   * One thing this person can do now, by the game's own controls where it can be clicked. `hold`:
   * their own turn's main phase isn't ended (a trade comes first). `race`: everything by the bots'
   * own choice through the dev hooks (to reach the end quickly).
   */
  async function move(p, o = {}) {
    const st = await ui(p, () => {
      const s = window.__ui.getState();
      const v = s.view;
      if (!v || s.busy || s.screen !== 'game') return null;
      const flat = s.viewMode === '2d';
      return { phase: v.phase, mine: v.currentPlayer === s.me, kind: s.interaction.kind, modal: s.modal, flat, turn: v.turn, pending: v.pending.length, trade: !!v.trade, sending: !!window.session.host?.sending };
    });
    if (!st || st.sending || st.phase === 'gameOver') return false;
    if (o.race) return decide(p);
    // The placements: on the flat map, its spots.
    if (st.kind === 'setupSettlement' || st.kind === 'setupRoad') {
      if (!st.flat) {
        await p.page.locator('.view-toggle').click();
        await until(p, () => window.__ui.getState().viewMode === '2d' && document.querySelectorAll('.flat-spot').length > 0, 'the flat map');
      }
      await p.page.locator('.flat-spot').first().click({ force: true });
      return true;
    }
    if (st.mine && st.phase === 'roll' && !st.modal) {
      const roll = p.page.locator('.roll-btn');
      if (await roll.isVisible().catch(() => false)) {
        await roll.click();
        return true;
      }
    }
    if (o.hold && st.mine && st.phase === 'main' && !st.pending && !st.trade) return false;
    if (st.mine && st.phase === 'main' && !st.pending && !st.trade && !st.modal && st.kind === 'idle') {
      const end = p.page.getByRole('button', { name: /End turn|Press again to end turn/ });
      if (await end.isVisible().catch(() => false)) {
        await end.click();
        await p.page.waitForTimeout(250);
        if (await p.page.getByRole('button', { name: /Press again to end turn/ }).isVisible().catch(() => false)) await p.page.getByRole('button', { name: /Press again to end turn/ }).click();
        return true;
      }
    }
    // Anything else owed (an answer to an offer, a discard, the robber): the bots' own choice, through the dev hooks.
    return decide(p);
  }

  /** The bots' own choice for this person, through the dev hooks (said once a kind in the log). */
  async function decide(p) {
    const did = await ui(p, async () => {
      const s = window.__ui.getState();
      const v = s.view;
      const { legalActions } = await import('/src/engine/index.ts');
      const { botDecide, createBotMemory } = await import('/src/engine/ai/index.ts');
      if (!legalActions(v, s.me).length) return null;
      const a = botDecide(v, s.me, createBotMemory({ waitForHumans: true }), 'normal');
      if (!a) return null;
      if (s.modal === 'discard' || s.modal === 'steal') s.set({ modal: null });
      return window.session.act(a) === null ? a.type : null;
    });
    if (did) {
      if (!fallbacks.has(did)) console.log(`     ${p.name}: ${did} decided through the dev hooks`);
      fallbacks.add(did);
      return true;
    }
    return false;
  }

  let shotSetup = false;
  const start = Date.now();
  while (Date.now() - start < 600_000) {
    const turn = await ui(host, () => window.__ui.getState().view?.turn ?? 0);
    const phase = await ui(host, () => window.__ui.getState().view?.phase);
    if (!shotSetup && phase === 'setupSettlement') {
      const mine = await ui(host, () => window.__ui.getState().interaction.kind === 'setupSettlement');
      if (mine) {
        await shoot('first-placement', [host]);
        shotSetup = true;
      }
    }
    if (turn > TURNS || phase === 'gameOver') break;
    let acted = false;
    for (const p of both) acted = (await move(p)) || acted;
    await host.page.waitForTimeout(acted ? 400 : 250);
    if (phase === 'main' && turn === 1 && !(await ui(host, () => window.__shotMain))) {
      await ui(host, () => (window.__shotMain = true));
      await shoot('after-the-opening');
    }
  }
  const turn = await ui(host, () => window.__ui.getState().view?.turn ?? 0);
  check(turn > TURNS, `${TURNS} turns played (turn ${turn})`);
  for (const p of both) {
    const view = await ui(p, () => window.__ui.getState().view);
    const placed = view.buildings.filter((b) => b && b.owner === (view.players.findIndex((x) => x.name === p.name))).length;
    check(placed >= 2, `${p.name} has their opening settlements (${placed})`);
  }
  // A word at the table, typed into the game's own talk panel.
  const talk = host.page.getByRole('button', { name: /Table talk/ }).first();
  if (await talk.isVisible().catch(() => false)) {
    await talk.click();
    await host.page.locator('.chatpanel input').fill('Good luck all');
    await host.page.locator('.chatpanel input').press('Enter');
    await until(guest, () => window.__ui.getState().chat.some((l) => l.text === 'Good luck all'), 'the table talk at the other end', 30_000);
  }
  await shoot('turns-played');
  // The pause, by the game's own key and the table's cards: Ana asks (P), Ben is asked and agrees,
  // the paused pill says so at both ends, and its Carry on weighs anchor.
  if (await talk.isVisible().catch(() => false)) await host.page.getByRole('button', { name: /Close table talk/ }).click().catch(() => {});
  await ui(host, () => document.activeElement?.blur?.());
  await host.page.keyboard.press('p');
  if (await until(guest, () => [...document.querySelectorAll('.online-hud button')].some((b) => b.textContent === 'Agree'), 'the pause asked', 30_000)) {
    await shoot('pause-asked', [guest]);
    await guest.page.locator('.online-hud button', { hasText: 'Agree' }).click();
    for (const p of both) await until(p, () => !!document.querySelector('.paused-pill'), 'the paused pill', 30_000);
    await shoot('paused');
    await host.page.locator('.paused-pill button').click();
    for (const p of both) await until(p, () => !document.querySelector('.paused-pill'), 'the game going on', 30_000);
  }
  for (const p of both) check(!(await ui(p, () => !!document.querySelector('.online-hud .link-pill'))), `${p.name}: the link is up`);

  // ---------------------------------------------------------------- table talk: quick talk and a reaction
  const openTalk = async (p) => {
    if (!(await ui(p, () => window.__ui.getState().chatOpen))) await p.page.getByRole('button', { name: /^Table talk/ }).first().click();
    await until(p, () => !!document.querySelector('.chatpanel .online-talk'), 'the table talk open', 30_000);
  };
  await openTalk(host);
  await host.page.locator('.talk-group', { hasText: 'Greet' }).click();
  await host.page.locator('.online-talk .chat-quick button', { hasText: 'Hello!' }).click();
  await until(guest, () => window.__ui.getState().chat.some((l) => l.text === 'Hello!' && l.player !== window.__ui.getState().me), 'quick talk at the other end', 30_000);
  await openTalk(guest);
  await guest.page.getByRole('button', { name: 'React: Cheer' }).click();
  check(await until(host, () => !!document.querySelector('.floating-reaction'), 'the reaction floating up', 10_000), 'a reaction floats up at the other end');
  await host.page.screenshot({ path: join(SHOTS, `${String(step + 1).padStart(2, '0')}-reaction-ana-1280.png`) });
  await shoot('table-talk');
  for (const p of both) await p.page.getByRole('button', { name: 'Close table talk' }).click().catch(() => {});

  // ---------------------------------------------------------------- Looking for / Spare, on Ben's own panel
  await guest.page.locator('.wants-btn').first().click();
  await guest.page.getByRole('button', { name: 'Looking for: Ore' }).click();
  await guest.page.getByRole('button', { name: 'Spare: Wool' }).click();
  // (The editor is the panel's own, which a phone's layout draws anew: pictured here at full size only.)
  await guest.page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, '0')}-looking-for-ben-1280.png`) });
  await guest.page.locator('.wants-editor button', { hasText: 'Done' }).click();
  check(await until(host, () => [...document.querySelectorAll('.want-tags')].some((t) => /Looking for ore · Spare wool/.test(t.getAttribute('aria-label') ?? '')), 'Ben’s Looking for / Spare on his panel', 30_000), 'Looking for / Spare shows at the other end');
  await shoot('looking-for-seen', [host]);

  // ---------------------------------------------------------------- a trade offered to one person and accepted
  const CARD_NAMES = { brick: 'Brick', wood: 'Wood', wool: 'Wool', wheat: 'Wheat', ore: 'Ore' };
  const RES = Object.keys(CARD_NAMES);
  let traded = false;
  const tradeBy = Date.now() + 300_000;
  while (!traded && Date.now() < tradeBy) {
    const ready = await ui(host, () => {
      const s = window.__ui.getState();
      const v = s.view;
      return !!v && !s.busy && v.phase === 'main' && v.currentPlayer === s.me && !v.trade && !v.pending.length && !s.modal && !window.session.host?.sending;
    });
    if (ready) {
      const mine = await ui(host, () => window.__ui.getState().view.players[window.__ui.getState().me].hand);
      const his = await ui(guest, () => window.__ui.getState().view.players[window.__ui.getState().me].hand);
      const give = RES.find((r) => mine[r] > 0);
      const get = RES.find((r) => r !== give && his[r] > 0);
      if (give && get) {
        // (The Sea Glass look has one Trade button, its dialog's tabs the players and the supply.)
        await host.page.getByRole('button', { name: /^(Offer trade|Trade)$/ }).first().click();
        await until(host, () => window.__ui.getState().modal === 'trade', 'the trade dialog', 20_000);
        await host.page.getByRole('button', { name: 'Only to Ben' }).click();
        // (One grid of cards for the side last tapped: You give first, then You want.)
        await host.page.getByRole('group', { name: 'Choose what you give' }).getByRole('button', { name: new RegExp(`^${CARD_NAMES[give]},`) }).click();
        await host.page.getByRole('group', { name: 'You want' }).locator('.deal-label').click();
        await host.page.getByRole('group', { name: 'Choose what you want' }).getByRole('button', { name: new RegExp(`^${CARD_NAMES[get]},`) }).click();
        await shoot('trade-to-one', [host]);
        await host.page.locator('.modal .footer .btn.gold', { hasText: 'Offer trade' }).click();
        await until(host, () => !!window.__ui.getState().view?.trade, 'the offer out', 30_000);
        const to = await ui(host, () => window.__ui.getState().view.trade?.to ?? null);
        check(Array.isArray(to) && to.length === 1, `the offer went to one person (${JSON.stringify(to)})`);
        // (Closed, the offer stands in the dock with its answers as they come.)
        await host.page.getByRole('button', { name: 'Close, keep it open' }).click();
        await until(host, () => !!document.querySelector('.outgoing-offer'), 'the offer in the dock', 20_000);
        if (await until(guest, () => !!document.querySelector('.offer-toast'), 'the offer at the other end', 30_000)) {
          await shoot('trade-incoming', [guest]);
          await guest.page.locator('.offer-toast button', { hasText: 'Accept' }).click();
          await until(host, () => Object.values(window.__ui.getState().view?.trade?.responses ?? {}).includes('accepted'), 'the acceptance', 30_000);
          await shoot('trade-accepted-in-the-dock', [host]);
          await host.page.locator('.outgoing-offer').click();
          await until(host, () => !!document.querySelector('.response-list'), 'the answers', 20_000);
          await shoot('trade-accepted', [host]);
          const errs = [];
          const watchErr = setInterval(() => void ui(host, () => window.__ui.getState().error).then((e) => e && !errs.includes(e) && errs.push(e)).catch(() => {}), 150);
          await host.page.locator('.response-list button', { hasText: /^Trade$/ }).click();
          traded = await until(host, () => !window.__ui.getState().view?.trade, 'the trade made', 30_000);
          clearInterval(watchErr);
          if (!traded) console.log(`     Ana: the trade button said ${JSON.stringify(errs)}; ${JSON.stringify(await ui(host, () => ({ sending: window.session.host?.sending, link: window.__ui.getState().online, trade: window.__ui.getState().view?.trade, modal: window.__ui.getState().modal })))}`);
          const after = await ui(host, () => window.__ui.getState().view.players[window.__ui.getState().me].hand);
          check(after[give] === mine[give] - 1 && after[get] === mine[get] + 1, `Ana gave 1 ${give} for 1 ${get}`);
        }
        break;
      }
    }
    let acted = false;
    for (const p of both) acted = (await move(p, { hold: p === host && !traded })) || acted;
    // (Nothing to trade on her turn this time: it ends, and the next one is tried.)
    if (ready && !acted) {
      const end = host.page.getByRole('button', { name: /End turn|Press again to end turn/ });
      if (await end.isVisible().catch(() => false)) await end.click();
    }
    await host.page.waitForTimeout(acted ? 400 : 250);
  }
  check(traded, 'a trade offered to one person and accepted');
  await host.page.keyboard.press('Escape').catch(() => {});

  // ---------------------------------------------------------------- the guest concedes
  await guest.page.getByRole('button', { name: 'Leave game' }).click();
  await guest.page.locator('.modal button', { hasText: /^Concede$/ }).click();
  if (await until(guest, () => !!document.querySelector('.leave-go'), 'the concede sheet', 20_000)) {
    await shoot('concede-sheet', [guest]);
    await guest.page.locator('.leave-go').click();
    await until(host, () => window.__ui.getState().tableNews.includes('Ben conceded') || [...document.querySelectorAll('.table-notice')].some((n) => /Ben conceded/.test(n.textContent)), 'the concession at the other end', 30_000);
    await until(guest, () => /^Watching/.test(window.__ui.getState().hint) || window.__ui.getState().view?.phase === 'gameOver', 'watching the crew sail the seat', 30_000);
    await shoot('conceded');
  }

  // ---------------------------------------------------------------- on to the end, and the results card
  for (const p of both) await ui(p, () => window.__ui.getState().set({ settings: { ...window.__ui.getState().settings, animationSpeed: 4, botPace: 'quick' } }));
  console.log('     both: the animations and the crew sped up through the dev hooks, to reach the end');
  const endBy = Date.now() + 900_000;
  while (Date.now() < endBy) {
    if (await ui(host, () => window.__ui.getState().view?.phase === 'gameOver')) break;
    let acted = false;
    for (const p of both) acted = (await move(p, { race: true })) || acted;
    await host.page.waitForTimeout(acted ? 300 : 400);
  }
  for (const p of both) await until(p, () => window.__ui.getState().modal === 'gameover' && !!document.querySelector('.standings'), 'the results card', 120_000);
  for (const p of both) await until(p, () => !!document.querySelector('.share-result'), 'the replay archived (Share result)', 60_000);
  check(await ui(guest, () => /conceded/.test(document.querySelector('.results-note')?.textContent ?? '')), 'the results say who conceded');
  check(await ui(host, () => document.querySelectorAll('.award-badge').length > 0), 'the results show the awards');
  await shoot('results');
} finally {
  for (const p of both) for (const e of p.errors) check(false, e);
  await browser.close();
  await vite?.close();
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall good');
process.exit(failures.length ? 1 : 0);
