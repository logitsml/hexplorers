// Screenshots of the expansions' panels in states that are hard to reach by play: a hand of
// ventures, a pick of hexes on the board, the wagon auction at each stage, a venture decision. It
// starts its own Vite server (like shots.mjs, so several checkouts can run at once), plays an All
// Hands game (or `--mix`) forward with the bots, resumes it at the human seat's roll, and then patches the view
// the interface reads (never the host's game) into each state through the engine's own moves, so
// what's drawn is what the engine would offer.
//
//   node scripts/capture/panels.mjs                          every state at every size, WebGPU
//   node scripts/capture/panels.mjs --out shots/panels       another folder
//   node scripts/capture/panels.mjs --only ventures,auction  only these states (by name)
//   node scripts/capture/panels.mjs --sizes landscape        only these sizes: desktop, landscape, portrait
//   node scripts/capture/panels.mjs --webgl                  the WebGL2 backend
//   node scripts/capture/panels.mjs --list                   print the states
//   node scripts/capture/panels.mjs --mix invasion --only muster   another mix than All Hands (expansion ids)
//
// It writes <out>/<size>-<state>.png and prints the page's console errors (exit 1 if any).

import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const SIZES = { desktop: [1600, 1000], short: [1100, 560], landscape: [844, 390], portrait: [390, 844] };

/** The states: each runs in the page, on the resumed game's view, and returns once the panels show it. */
const STATES = {
  /** Your ventures in the ledger (the phone opens its sheet). */
  ventures: async () => {
    await window.__panels.ventures(['trader', 'taxCollectors', 'resurvey', 'rightOfWay']);
    await window.__panels.openLedger('ventures');
  },
  /** The trader's hexes outlined on the board: the Play button pressed. */
  pickTrader: async () => {
    await window.__panels.ventures(['trader', 'taxCollectors', 'resurvey', 'rightOfWay']);
    await window.__panels.openLedger('ventures');
    await window.__panels.play('The Trader');
  },
  /** Tax collectors (many hexes) outlined. */
  pickTax: async () => {
    await window.__panels.ventures(['trader', 'taxCollectors', 'resurvey', 'rightOfWay']);
    await window.__panels.openLedger('ventures');
    await window.__panels.play('Tax Collectors');
  },
  /** Six held: put two back. */
  limit: async () => {
    await window.__panels.ventures(['trader', 'taxCollectors', 'resurvey', 'rightOfWay', 'spymaster', 'waterworks'], { owe: true });
    await window.__panels.openLedger('ventures');
  },
  /** The auction, your bid. */
  auction: async () => {
    await window.__panels.auction(0, () => []);
  },
  /** The auction after bids from the two seats before you, while you bid. */
  auctionBids: async () => {
    await window.__panels.auction(2, (w, bid) => [[2, bid('brick', w[1])], [3, bid('wood', w[2])]]);
  },
  /** The ballot, your vote. */
  ballot: async () => {
    await window.__panels.auction(0, (w, bid) => [[0, bid('brick', w[0])], [1, bid('brick', w[1])], [2, bid('wood', w[2])], [3, { type: 'caravans/pass' }]]);
  },
  /** The auction's result, told. */
  result: async () => {
    await window.__panels.auction(0, (w, bid) => [
      [0, bid('brick', w[0])],
      [1, bid('brick', w[1])],
      [2, bid('wood', w[2])],
      [3, { type: 'caravans/pass' }],
      [0, { type: 'caravans/vote', edge: w[0] }],
      [1, { type: 'caravans/vote', edge: w[1] }],
      [2, { type: 'caravans/vote', edge: w[0] }],
    ]);
  },
  /** A decision taller than the room it has, scrolled to its foot (the paper has to go on under the text). */
  scrolled: async () => {
    await window.__panels.auction(2, (w, bid) => [[2, bid('brick', w[1])], [3, bid('wood', w[2])]]);
    await new Promise((ok) => setTimeout(ok, 300));
    const el = document.querySelector('.dock-decisions');
    el?.scrollTo({ top: 99999 });
  },
  /** A scrolled dialog, its paper a background that scrolls with the text, at its foot. */
  modalScrolled: async () => window.__panels.modal(false),
  /** The same with the paper laid as an overlay instead (one that rides off with the scrolled text), for comparison. */
  modalOldPaper: async () => window.__panels.modal(true),
  /** A pick of sea hexes (the corsair's), outlined over the water. */
  pickSea: async () => {
    await window.__panels.pickHexes((h) => h.terrain === 'sea', 'Move the corsair');
  },
  /** The guild board. */
  guilds: async () => {
    await window.__panels.openLedger('guilds');
  },
  /** Your fish face up, what each buy pays with, and the Soggy Boot in your hand. */
  fish: async () => {
    await window.__panels.fish([3, 3, 2, 1, 1], { boot: true });
    await window.__panels.openLedger('fish');
  },
  /** Too few fish for most buys: each says what it lacks. */
  fishShort: async () => {
    await window.__panels.fish([2, 1]);
    await window.__panels.openLedger('fish');
  },
  /** Seven tokens and more caught: throw one back, or keep them all. */
  fishSwap: async () => {
    await window.__panels.fish([3, 3, 2, 2, 1, 1, 1], { swap: true });
  },
  /** The coast: each raided hex, how near it is to falling, what its wardens would do. */
  raiders: async () => {
    await window.__panels.openLedger('raiders');
  },
  /** A levy owed: the card, what it does, and its pick. */
  levy: async () => {
    await window.__panels.muster('levy');
  },
  /** A turncoat's pick under way: the hexes to take raiders from, outlined. */
  turncoat: async () => {
    await window.__panels.muster('turncoat', 0);
  },
  /** Its second stage: two hexes chosen to take raiders from, the hexes to lead them to outlined. */
  turncoatTo: async () => {
    await window.__panels.muster('turncoat', 2);
  },
  /** The build bar selling a muster card where the development card would be (with --mix invasion). */
  muster: async () => {
    await window.__panels.main();
  },
  /** The build bar with the expansions' builds beside the base game's, each build's price in hand (the phone opens its Build sheet). */
  builds: async () => {
    await window.__panels.main();
    await window.__panels.buildSheet();
  },
  /** The same with an empty hand: each tile greyed, the phone's saying what it lacks. */
  buildsPoor: async () => {
    await window.__panels.main({ poor: true });
    await window.__panels.buildSheet();
  },
  /** An expansion's build pressed (the first that can be made): where it may go, outlined. */
  buildPick: async () => {
    await window.__panels.main();
    const tiles = [...document.querySelectorAll('.actions .build-btn')];
    tiles.slice(3).find((b) => !b.hasAttribute('aria-disabled'))?.click();
    await window.__pause(400);
  },
  /** Hoarder with oil beside the resources (--mix oil: the guilds' games have no development cards). */
  monopolyOil: async () => {
    await window.__panels.devCards('monopoly');
  },
  /** Invention with oil beside the resources, oil and wool chosen. */
  inventionOil: async () => {
    await window.__panels.devCards('invention');
    // (A render between the clicks, as a person's have.)
    for (const name of ['Take Oil', 'Take Wool']) {
      document.querySelector(`.modal .pick-card[aria-label^="${name}"]`)?.click();
      await window.__pause(200);
    }
  },
  /** A decision the expansions' panel answers, under its own heading: a 7 moving the corsair. */
  blocker: async () => {
    await window.__panels.owe({ cause: 'seven', robber: false, victims: 'ships' }, {}, 'sea/blocker');
  },
  /** A quake owed: the road suggested, a press away (on the full HUD, in the Almanac chip's drawer). */
  quake: async () => {
    await window.__panels.owe({ happening: 'quake' }, {}, 'almanac/quake');
    document.querySelector('.al-chip')?.click();
    await window.__pause(400);
  },
  /** The march with a warden of yours on a castle edge: its exit suggested in the expansions' panel. */
  castleExit: async () => {
    await window.__panels.march();
  },
  /** Settings at its Play tab, the pacing defaults among its choices. */
  settingsPlay: async () => {
    window.__ui.getState().set({ modal: 'settings' });
    await window.__pause(1200);
    [...document.querySelectorAll('.modal [role="tab"], .modal .tabs button')].find((b) => b.textContent.trim().startsWith('Play'))?.click();
    await window.__pause(500);
  },
  /** Unrest's discard: the base game's picker, opened by itself, a suggestion taken. */
  unrest: async () => {
    await window.__panels.owe({ kind: 'guilds/discard', left: 4 }, { brick: 2, wool: 3, ore: 1, paper: 2, cloth: 1 });
    document.querySelector('.modal .btn.bare')?.click();
  },
  /** The same put aside: the dock's card for it. */
  unrestDock: async () => {
    await window.__panels.owe({ kind: 'guilds/discard', left: 4 }, { brick: 2, wool: 3, ore: 1, paper: 2, cloth: 1 });
    window.__ui.getState().set({ modal: null });
  },
  /** A tribute: two of another's cards, as the venture showed them. */
  tribute: async () => {
    await window.__panels.owe({ kind: 'guilds/tribute', target: 2, left: 2, seen: { brick: 1, wood: 0, wool: 2, wheat: 0, ore: 1, paper: 0, cloth: 1, silver: 0, oil: 0 } }, {});
  },
  /** The Learning ability's resource, in the dock. */
  learning: async () => {
    await window.__panels.owe({ kind: 'guilds/pick' }, {});
  },
  /** A bounty pick of two, one chosen. */
  bounty: async () => {
    await window.__panels.owe({ count: 2, reason: 'production' }, {}, 'sea/bountyPick');
    document.querySelector('.supply-pick .card-btn')?.click();
  },
  /** The raider fleet's page as the game stands (--mix guilds: the fleet sails only without Invasion). */
  fleet: async () => {
    await window.__panels.openLedger('fleet');
  },
  /** The fleet a ship from the island. */
  fleetNear: async () => {
    await window.__panels.fleet(6);
    await window.__panels.openLedger('fleet');
  },
  /** Your player card with a guild seat and the trader as badges, its points' tooltip shown. */
  badges: async () => {
    await window.__panels.badges();
  },
  /** A resurvey under way: one hex chosen, the hexes it may swap with outlined (--mix guilds: with Invasion, only hexes ringed by land may swap). */
  resurvey: async () => {
    await window.__panels.ventures(['resurvey', 'waterworks', 'trader']);
    await window.__panels.openLedger('ventures');
    await window.__panels.play('Resurvey');
    await window.__panels.stage(1);
  },
};

if (flag('list')) {
  console.log(`states: ${Object.keys(STATES).join(', ')}\nsizes: ${Object.keys(SIZES).join(', ')}`);
  process.exit(0);
}

const only = opt('only')?.split(',');
const sizes = (opt('sizes')?.split(',') ?? Object.keys(SIZES)).filter((s) => SIZES[s]);
const out = resolve(opt('out', 'shots/panels'));
const quality = opt('q', 'medium');
const webgl = flag('webgl');
const seed = Number(opt('seed', 7));
const turns = Number(opt('turns', 22));
const mix = opt('mix', 'allHands');
mkdirSync(out, { recursive: true });


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
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1' }, clearScreen: false });
await server.listen();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal'],
});

/** In the page: play the All Hands game forward and return a save of it at the human seat's roll. */
async function buildSave({ seed, turns, mix }) {
  const P = await import('/src/engine/presets.ts');
  const H = await import('/src/game/host.ts');
  const { PRESET_COLORS } = await import('/src/render/board/pieces.ts');
  const m = P.mixOf(mix === 'allHands' ? P.PRESETS.find((p) => p.id === 'allHands').expansions : mix.split(','));
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

/** In the page: the helpers the states use. */
async function install() {
  const E = await import('/src/engine/index.ts');
  const V = await import('/src/engine/modules/guilds/ventures.ts');
  const C = await import('/src/engine/modules/caravans/trains.ts');
  const A = await import('/src/engine/modules/caravans/auction.ts');
  const D = await import('/src/engine/modules/guilds/deck.ts');
  const ui = () => window.__ui.getState();
  const show = (v) => {
    ui().set({ view: v, busy: false, handDelta: {} });
    window.session.presenter.updateInteraction(v);
  };
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
  window.__pause = pause;
  window.__panels = {
    /** The resumed game's view, cloned. */
    fresh: () => structuredClone(window.__resumed),
    /** Give seat 0 these ventures (taken from their decks) in the main phase. */
    async ventures(cards, o = {}) {
      const v = window.__panels.fresh();
      v.phase = 'main';
      v.hasRolled = true;
      const g = v.ext.guilds;
      g.hands[0] = [];
      for (const c of cards) {
        const deck = g.decks[V.VENTURES[c].track];
        const i = deck.lastIndexOf(c);
        if (i >= 0) deck.splice(i, 1);
        g.hands[0].push(c);
      }
      if (o.owe) D.checkVentureLimit(v, 0);
      show(v);
      await pause(300);
    },
    /** Seat 0 in the main phase holding these fish tokens (taken from the supply); the boot too, or the swap a full purse owes. */
    async fish(tokens, o = {}) {
      const v = window.__panels.fresh();
      v.phase = 'main';
      v.hasRolled = true;
      const f = v.ext.fisheries;
      f.discard.push(...f.tokens[0]);
      f.tokens[0] = [];
      for (const t of tokens) {
        f.supply.splice(f.supply.indexOf(t), 1);
        f.tokens[0].push(t);
      }
      f.tokens[0].sort((a, b) => b - a);
      if (o.boot) f.boot = 0;
      if (o.swap) v.pending.push({ kind: 'fisheries/swap', players: [0] });
      show(v);
      await pause(300);
    },
    /** Seat 0 in the main phase with every build's price in hand (oil too), or (`poor`) nothing at all. */
    async main(o = {}) {
      const v = window.__panels.fresh();
      v.phase = 'main';
      v.hasRolled = true;
      for (const k of ['brick', 'wood', 'wool', 'wheat', 'ore', 'oil']) v.players[0].hand[k] = o.poor ? 0 : Math.max(v.players[0].hand[k], 2);
      show(v);
      await pause(300);
    },
    /** Seat 0 in the main phase holding a development card of `type` bought last turn, its dialog open. */
    async devCards(type) {
      const v = window.__panels.fresh();
      v.phase = 'main';
      v.hasRolled = true;
      v.devCardPlayedThisTurn = false;
      v.players[0].devCards.push({ type, boughtTurn: 0 });
      show(v);
      await pause(300);
      ui().set({ modal: type });
      await pause(600);
    },
    /** A warden of seat 0's on an open castle edge, and the march owed (Invasion). */
    async march() {
      const v = window.__panels.fresh();
      v.phase = 'main';
      v.hasRolled = true;
      const castle = v.board.features.castle;
      const edge = v.board.hexes[castle].edges.find((e) => !v.wardens.some((w) => w.edge === e));
      v.wardens.push({ id: 900, owner: 0, rank: 1, edge, vertex: null, mustered: true, musteredTurn: 0 });
      v.pending.push({ kind: 'invasion/march', players: [0], data: { acted: [] } });
      show(v);
      await pause(500);
    },
    /** On a phone: the Build sheet opened from the dock. */
    async buildSheet() {
      const btn = [...document.querySelectorAll('.cactions button')].find((b) => b.textContent.trim().startsWith('Build'));
      btn?.click();
      await pause(400);
    },
    /**
     * A muster card owed by seat 0, its pick started from the decision's button; for a turncoat,
     * `sources` hexes then chosen to take raiders from, as the board's clicks would choose them.
     */
    async muster(card, sources) {
      const v = window.__panels.fresh();
      v.phase = 'main';
      v.hasRolled = true;
      v.pending.push({ kind: 'invasion/card', players: [0], data: { card } });
      show(v);
      await pause(300);
      if (sources === undefined) return;
      document.querySelector('.muster-decision .btn.gold')?.click();
      await pause(300);
      await window.__panels.stage(sources);
    },
    /** Seat 0 in the main phase owing decision `d` (of kind `kind`, else its own), holding just `hand` of the cards a venture takes. */
    async owe(d, hand, kind = d.kind) {
      const v = window.__panels.fresh();
      v.phase = 'main';
      v.hasRolled = true;
      for (const k of ['brick', 'wood', 'wool', 'wheat', 'ore', 'paper', 'cloth', 'silver']) {
        const n = hand[k] ?? 0;
        v.bank[k] += v.players[0].hand[k] - n;
        v.players[0].hand[k] = n;
      }
      v.pending.push({ kind, players: [0], data: d });
      show(v);
      await pause(500);
    },
    /** The fleet `position` steps out. */
    async fleet(position) {
      const v = window.__panels.fresh();
      v.ext.fleet.position = position;
      show(v);
      await pause(300);
    },
    /** Seat 0 holding the Learning seat on a city of theirs (one made, if need be) and the trader beside it; the points' tooltip in view. */
    async badges() {
      const v = window.__panels.fresh();
      let at = v.buildings.findIndex((b) => b?.owner === 0 && b.kind === 'city');
      if (at < 0) {
        at = v.buildings.findIndex((b) => b?.owner === 0);
        v.buildings[at].kind = 'city';
        v.players[0].settlementsLeft++;
        v.players[0].citiesLeft--;
      }
      for (const b of v.buildings) if (b?.seat === 'learning') delete b.seat;
      v.buildings[at].seat = 'learning';
      v.ext.guilds.trader = { hex: v.board.vertices[at].hexes.find((h) => v.board.hexes[h].terrain !== 'sea' && v.board.hexes[h].terrain !== 'desert'), owner: 0 };
      show(v);
      await pause(400);
      document.querySelector('[data-anchor="player-0"] .vp')?.focus({ focusVisible: true });
      await pause(200);
    },
    /** The staged pick under way, `n` more of its spots chosen as the board's clicks would choose them. */
    async stage(n) {
      const M = await import('/src/game/moduleActions.ts');
      for (let k = 0; k < n; k++) {
        const it = ui().interaction;
        // (None under way: the move couldn't be made here, and its reason is what's drawn.)
        if (!it.chosen) break;
        const step = M.stagedStep(it.actions, [...it.chosen.slice(0, -1), [...it.chosen[it.chosen.length - 1], it.spots[k]]]);
        ui().set({ interaction: { ...it, spots: step.spots, chosen: step.chosen }, hint: `${it.label}: ${M.stagedAsk(it.actions[0].type, step)}` });
        window.session.presenter.syncMarkers();
      }
      await pause(300);
    },
    async openLedger(page) {
      localStorage.setItem('exploratory.ledger', JSON.stringify({ page, open: true }));
      const compact = window.matchMedia('(max-width: 700px), (max-height: 500px)').matches;
      if (compact) {
        document.querySelector('.ledger-btn')?.click();
        await pause(200);
        const tab = [...document.querySelectorAll('.ledger-tabs button')].find((b) => b.textContent.toLowerCase().startsWith(page));
        tab?.click();
      } else {
        const tab = [...document.querySelectorAll('.ledger-tabs button')].find((b) => b.textContent.toLowerCase().startsWith(page));
        tab?.click();
      }
      await pause(400);
    },
    /** The rules dialog scrolled to its foot; with `old`, its paper laid as an overlay instead, for comparison. */
    async modal(old) {
      window.__ui.getState().set({ modal: 'rules' });
      await pause(1200);
      if (old) {
        const st = document.createElement('style');
        st.textContent = "html:root:not([data-contrast='more']) .modal.parchment { background: radial-gradient(120% 90% at 30% 10%, rgba(255, 252, 240, 0.85), rgba(255, 252, 240, 0) 60%), linear-gradient(180deg, var(--parchment) 0%, var(--parchment-2) 100%) !important; box-shadow: var(--shadow), inset 0 1px 0 rgba(255, 255, 255, 0.7), inset 0 0 0 3px rgba(255, 248, 230, 0.35) !important; } html:root:not([data-contrast='more']) .modal.parchment::after { display: block !important; }";
        document.head.append(st);
        window.__oldPaper = st;
      }
      const el = document.querySelector('.modal');
      el?.scrollTo({ top: 99999 });
      await pause(500);
    },
    /** A hex pick over the hexes the filter keeps (a stand-in for a module's own: only the view is asked). */
    async pickHexes(keep, label) {
      const S = await import('/src/ui/modules/shared.tsx');
      const v = window.__panels.fresh();
      show(v);
      const hexes = v.board.hexes.filter(keep).sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z)).slice(0, 10);
      S.startPick(label, 'hex', hexes.map((h) => ({ type: 'sea/moveCorsair', hex: h.id })));
      await pause(400);
    },
    async play(name) {
      const card = [...document.querySelectorAll('.vh-card')].find((c) => c.querySelector('.vh-name')?.textContent.startsWith(name));
      card?.querySelector('.vh-play')?.click();
      await pause(500);
    },
    /**
     * An auction at the end of `active`'s turn, taken through the engine's own moves: `script`
     * is given the placements and a bid builder, and returns [seat, action] pairs to apply.
     */
    async auction(active, script) {
      const v = window.__panels.fresh();
      v.phase = 'main';
      v.hasRolled = true;
      v.currentPlayer = active;
      // (Everyone holds a few of the bid kinds, so the view carries the cards the moves need.)
      for (const p of v.players) for (const k of ['brick', 'wood']) p.hand[k] = Math.max(p.hand[k], 2);
      // (A building this turn owes a wagon.)
      C.caravansOf(v).owed = true;
      let s = E.mustApply(v, active, { type: 'endTurn' }).state;
      const where = C.placements(s);
      const bid = (kind, proposal) => ({ type: 'caravans/bid', cards: A.bidCards(s, kind === 'brick' ? 1 : 0, kind === 'wood' ? 1 : 0), ...(proposal === undefined ? {} : { proposal }) });
      for (const [p, a] of script(where, bid)) s = E.mustApply(s, p, a).state;
      show(s);
      await pause(500);
    },
  };
}

let failed = false;
for (const size of sizes) {
  const [width, height] = SIZES[size];
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
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
  try {
    await page.goto(`${base}/?q=${quality}&time=0.42&seed=${seed}${webgl ? '&webgl' : ''}`);
    await page.waitForFunction(() => window.__ui?.getState().worldReady && window.session?.world, null, { timeout: 180000 });
    const save = await page.evaluate(buildSave, { seed, turns, mix });
    await page.evaluate(async (save) => {
      await window.session.start(save.cfg, save);
      await window.session.world.settled();
      window.__resumed = structuredClone(window.__ui.getState().view);
    }, save);
    await page.evaluate(install);
    await page.waitForTimeout(1500);
    for (const name of Object.keys(STATES)) {
      if (only && !only.includes(name)) continue;
      // Every state starts from the resumed game (the interface is put back before the next).
      await page.evaluate(() => {
        window.__oldPaper?.remove();
        window.__ui.getState().set({ view: structuredClone(window.__resumed), interaction: { kind: 'idle' }, choice: null, modal: null });
        window.session.presenter.updateInteraction(window.__resumed);
        document.querySelector('.ledger-btn.on')?.click();
      });
      await page.waitForTimeout(250);
      await page.evaluate(STATES[name]);
      await page.waitForTimeout(700);
      const file = `${size}-${name}.png`;
      await page.screenshot({ path: join(out, file) });
      console.log(file);
    }
  } catch (e) {
    failed = true;
    console.log(`FAIL ${size}: ${e?.message ?? e}`);
    await page.screenshot({ path: join(out, `${size}-FAILED.png`) }).catch(() => {});
  }
  if (errors.length) {
    failed = true;
    console.log(`FAIL ${size}: ${errors.length} console errors\n     ${errors.slice(0, 5).join('\n     ')}`);
  }
  await ctx.close();
}
await browser.close();
await server.close();
console.log(failed ? '\nsome states failed' : `\nall shots in ${out}`);
process.exit(failed ? 1 : 0);
