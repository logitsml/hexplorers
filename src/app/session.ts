// Owns the persistent 3D world and the current game (host, board view,
// presenter, input). The React UI talks to the game only through here. A game
// is local (start: LocalHost, the crew, saves) or online (join: the room's
// harbour, then a RemoteHost once it sets sail; the room keeps the game, so
// nothing is saved here).

import type { CustomMap } from '../engine/maps/custom';
import { Rng, createGame, dealBoard, seedFrom, type Action, type BoardSpec, type GameState, type GameOptions, type Knobs, type ModuleId, type PlayerColor, type PlayerId } from '../engine';
import type { BotDifficulty } from '../engine/ai';
import { World, titleView } from '../render/World';
import type { BoardView } from '../render/board/boardView';
import { LocalHost, type GameHost, type SeatConfig } from '../game/host';
import type { RoomClient } from '../online/client';
import type { RemoteHost } from '../online/remoteHost';
import type { Presenter } from '../game/presenter';
import { BOT_PACE, INTRO_RUSH, animSpeed, animatorSpeed, showError, useUI, type Settings } from '../game/store';
import { SaveUnusable, clearSave, loadLastGame, ownsSave, watchSave, writeLastGame, writeSave, type SavedGame } from '../game/save';
import { addEvents, emptyStats, type GameStats } from '../game/stats';
import type { BoardInput, HoverInfo } from './input';
import { rememberedView, resetView, setViewMode } from './viewMode';
import { avatarOf, pickCrew } from '../game/names';
import { PRESET_COLORS, colorsClash } from '../render/board/pieces';
import { sfx } from '../audio/sfx';
import type { Quality } from '../render/core/stage';
import { rememberQuality } from './deviceQuality';
import { reducedMotion } from './display';
import { BUILD } from '../net/build';

export interface NewGameConfig {
  name: string;
  color: PlayerColor;
  opponents: 2 | 3;
  difficulty: BotDifficulty;
  layout: GameOptions['layout'];
  numberPlacement: GameOptions['numberPlacement'];
  victoryPoints?: number;
  friendlyRobber?: boolean;
  eventDeck?: boolean;
  /** The expansions' rule modules in play, in MODULE_IDS order (the base game when absent). */
  modules?: ModuleId[];
  /** The map they play on (the classic island when absent; 'custom' with `custom`). */
  map?: string;
  /** A map drawn in the editor, played whole. */
  custom?: CustomMap;
  /** The board as it was dealt when the game began, saved with it (absent in a config for a game yet to start). */
  board?: BoardSpec;
  /** A preset's calibration knobs (each module's own numbers when absent). */
  knobs?: Knobs;
  seed?: number;
  /** The player's avatar code (see ui/Avatar.tsx); their initial when absent. */
  avatar?: number;
  /** Debug/testing: every seat is a bot (spectate). */
  watch?: boolean;
}

const WARM_KEY = 'exploratory.gpuWarm';
/** What the GPU's shader cache is keyed by here: this build's shaders at this preset. */
const warmStamp = (q: Quality) => `${BUILD}|${q}|${new URLSearchParams(location.search).has('syncbuilds') ? 's' : ''}`;
/**
 * Whether this device has compiled this build's game shaders at this preset before. The GPU
 * driver keeps what it compiled, so a second compile is a few seconds, but the first, on a phone,
 * is the better part of half a minute (a pipeline at a time, each over a tenth of a second): the
 * set-up page spends that time ahead of Set sail, see Session.warmShaders.
 */
function gpuWarm(q: Quality) {
  try {
    return localStorage.getItem(WARM_KEY) === warmStamp(q);
  } catch {
    return true;
  }
}
function markGpuWarm(q: Quality) {
  try {
    localStorage.setItem(WARM_KEY, warmStamp(q));
  } catch {
    /* storage unavailable */
  }
}

let gameParts: Promise<{ BoardView: typeof BoardView; Presenter: typeof Presenter; BoardInput: typeof BoardInput }> | null = null;

/**
 * What only a game uses (the board's pieces and their animation, the presenter, the board's
 * input) comes in a chunk of its own: fetched while the title is up (see bootstrap), so the title
 * doesn't wait for it and a game finds it there. A failure is let go, to be tried again.
 */
export function loadGameParts() {
  return (gameParts ??= Promise.all([import('../render/board/boardView'), import('../game/presenter'), import('./input')]).then(
    ([v, p, i]) => ({ BoardView: v.BoardView, Presenter: p.Presenter, BoardInput: i.BoardInput }),
    (e) => {
      gameParts = null;
      throw e;
    },
  ));
}

let displayFont: Promise<unknown> | null = null;

/**
 * The display font the number discs and harbour badges are painted with (onto canvases, so it
 * must have loaded first). Fetched once, alongside start-up; it gives up after 1.5 s.
 */
export function loadDisplayFont() {
  return (displayFont ??= Promise.race([document.fonts.load('700 64px "Fraunces Variable"'), new Promise((r) => setTimeout(r, 1500))]).catch(() => undefined));
}

/** The game options a game is created with: its set-up, its seed, and a saved game's rules (and an online replay's dice). */
function gameOptions(cfg: NewGameConfig, seed: number, saved?: SavedGame, replay?: SavedGame) {
  return {
    seed,
    layout: cfg.layout,
    numberPlacement: cfg.numberPlacement,
    victoryPoints: cfg.victoryPoints,
    friendlyRobber: cfg.friendlyRobber,
    eventDeck: cfg.eventDeck,
    modules: cfg.modules,
    map: cfg.map,
    custom: cfg.custom,
    knobs: cfg.knobs,
    rules: saved?.rules,
    moduleRules: saved?.moduleRules,
    // (An online game's replay plays its own dice stream, under the key revealed at its end.)
    ...(replay?.online && { rng: replay.online.rng }),
  };
}

class Session {
  world: World | null = null;
  host: GameHost | null = null;
  /** The online room this tab is in, from joining it (its harbour) until leaving it. */
  room: RoomClient | null = null;
  /** You conceded the seat you hold in that room's game: the crew sails it, and you watch. */
  private conceded = false;
  view: BoardView | null = null;
  presenter: Presenter | null = null;
  input: BoardInput | null = null;
  me: PlayerId = 0;
  hoverListeners = new Set<(h: HoverInfo | null) => void>();
  /** Avatar index per seat (bots get portraits). */
  avatars: number[] = [];
  /** Bumped per game (and on quit) so a superseded start() stops after its awaits. */
  private gen = 0;
  /** While the island rises at the start of a game: its flights own the camera (no view switch). */
  private intro = false;
  /** The game whose opening may be skipped now (see skipIntro), or -1. */
  private skippable = -1;
  /** The status line's offer to skip, while it shows. */
  private skipHint = '';

  /**
   * Hurry the rest of a game's opening along (the island's rise, the discs, the first cards):
   * asked by a click on the island, or Space, Enter or Escape, while it plays. It plays out at
   * INTRO_RUSH, the camera's flight with it, rather than cutting to the end, so it is still seen
   * to happen. Whether there was an opening to hurry.
   */
  skipIntro(): boolean {
    const s = useUI.getState();
    if (this.skippable !== this.gen || s.introSkip) return false;
    s.set({ introSkip: true, ...(s.hint === this.skipHint && { hint: '' }) });
    if (this.world) this.world.introRush = INTRO_RUSH;
    return true;
  }

  /** The opening over (or left): its pace and its offer gone. */
  private endIntroSkip() {
    this.skippable = -1;
    const s = useUI.getState();
    if (s.introSkip || (this.skipHint && s.hint === this.skipHint)) s.set({ introSkip: false, ...(s.hint === this.skipHint && { hint: '' }) });
    this.skipHint = '';
    if (this.world) this.world.introRush = 1;
  }

  /** The intro is playing (mirrored in the store, so the interface can wait for it). */
  get introducing() {
    return this.intro;
  }
  set introducing(on: boolean) {
    this.intro = on;
    if (useUI.getState().introducing !== on) useUI.getState().set({ introducing: on });
  }
  /** Write a pending save immediately (tab closing, quitting). */
  flushSave: () => void = () => {};
  stats: GameStats = emptyStats();
  private unsubSave: (() => void) | null = null;
  private unwatchSave: (() => void) | null = null;
  /** Take the solo save back from another tab that has written it (what "Play here" does). */
  reclaimSave: () => void = () => {};
  private unsubOffers: (() => void) | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async initWorld(canvas: HTMLCanvasElement, quality: Quality, step?: (label: string, progress: number) => Promise<void>) {
    if (this.world) return this.world;
    this.world = new World(canvas, quality);
    // (The player's keys and mouse buttons, on the title and in the editor too.)
    this.world.rig.binds = () => useUI.getState().settings;
    await this.world.init(step);
    return this.world;
  }

  /** Show a decorative board behind the title screen (its shaders compiled first, see World.setBoard). */
  async showcase(seed = 11, progress?: (done: number, total: number) => void) {
    if (!this.world) return;
    const host = new LocalHost(
      [
        { name: 'A', color: 'red', isBot: true },
        { name: 'B', color: 'blue', isBot: true },
        { name: 'C', color: 'white', isBot: true },
      ],
      { seed, layout: 'random' },
    );
    await this.world.setBoard(host.state);
    // The title looks out over the sea where the island waits, a sandbank under clear water: this
    // island stays under it (it is built so its shaders are ready for the first game, which raises
    // its own).
    void this.world.shoal(true, 0);
    const rig = this.world.rig;
    const title = titleView();
    rig.pose.yaw = rig.goal.yaw = title.yaw;
    rig.pose.pitch = rig.goal.pitch = title.pitch;
    rig.pose.distance = rig.goal.distance = title.distance;
    rig.pose.shiftY = rig.goal.shiftY = title.shiftY;
    rig.pose.target.copy(title.target);
    rig.goal.target.copy(title.target);
    this.world.setAutoOrbit(true);
    await this.world.precompile(progress, true);
  }

  private warming = false;

  /**
   * On a device that has not compiled this build's game shaders before (its first game, or a new
   * release), build a throwaway island in the board group, which is hidden and never drawn, and
   * compile everything a game's first board needs, while the set-up page is open: the page is
   * idle, the GPU would otherwise wait for Set sail, and the driver keeps what it compiles, so the
   * game's own compile that follows takes seconds rather than half a minute. Nothing the title
   * shows is touched (its sea, sandbank, camera and pieces stay as they are: see World.warmBoard),
   * and Set sail drops the island at once (World.setBoard clears it; see dropWarm).
   */
  warmShaders(state?: GameState) {
    const world = this.world;
    const quality = useUI.getState().quality;
    if (!world || this.warming || this.host || gpuWarm(quality)) return;
    // (The WebGL fallback compiles synchronously as things are first drawn, with no pipelines to
    // build ahead on a thread of the GPU process: a throwaway island there would only cost memory.)
    if (!(world.stage.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) return;
    this.warming = true;
    const gen = this.gen;
    const stale = () => gen !== this.gen || this.host !== null || document.hidden;
    void this.warmBoard(world, quality, stale, state)
      .catch((e) => console.warn('could not warm the shaders', e))
      .finally(() => {
        this.dropWarm();
        // (Tried again later if it was interrupted: only a finished compile counts, see warmBoard.)
        this.warming = false;
      });
  }

  private warmView: BoardView | null = null;

  private async warmBoard(world: World, quality: Quality, stale: () => boolean, ahead?: GameState) {
    // (The island the set-up page would sail to, if it has one: its terrain was built ahead, and is
    // built again for the game once this has taken it. Else any island.)
    const seats: SeatConfig[] = PRESET_COLORS.slice(0, 4).map((c, i) => ({ name: `Seat ${i + 1}`, color: c.id, isBot: true }));
    const host = new LocalHost(seats, { seed: 11, layout: 'random' });
    const state = ahead && !ahead.options.modules.length ? ahead : host.state;
    try {
      const { BoardView } = await loadGameParts();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (stale()) return;
      if (!(await world.warmBoard(state, stale)) || stale()) return;
      await loadDisplayFont();
      if (stale()) return;
      const view = new BoardView(world, state);
      this.warmView = view;
      view.standIns();
      await this.qualityQueue;
      if (stale()) return;
      await world.warmCompile(stale);
      if (!stale()) markGpuWarm(quality);
    } finally {
      host.dispose();
    }
  }

  /** Let go of the throwaway island (a game starting, or the compile done): straight away, so a game's own board never meets it. */
  private dropWarm() {
    const view = this.warmView;
    this.warmView = null;
    view?.dispose();
    this.world?.dropWarm();
  }


  /** The last game's set-up, for Play again (a fresh island each time). */
  lastConfig: NewGameConfig | null = null;

  /** The last finished game (this session's, or the one kept from before), for its replay. */
  lastGame: SavedGame | null = loadLastGame();

  /** The game being replayed, for Restart. */
  private replaying: SavedGame | null = null;

  /** Watch a finished game back: the same seed and seats, its moves played out one by one. */
  watchReplay(rec: SavedGame) {
    return this.start(rec.cfg, undefined, rec);
  }

  /** Replay controls (see ReplayPanel). */
  replayControls = {
    toggle: () => {
      const r = useUI.getState().replay;
      if (!r || !(this.host instanceof LocalHost)) return;
      this.host.paused = !r.paused;
      useUI.getState().set({ replay: { ...r, paused: !r.paused } });
      if (r.paused) this.presenter?.nudge();
    },
    speed: (speed: number) => {
      const r = useUI.getState().replay;
      if (!r) return;
      useUI.getState().set({ replay: { ...r, speed } });
      if (this.world) this.world.animator.speed = animatorSpeed();
    },
    /** Hurry through to the next turn. */
    nextTurn: () => {
      const r = useUI.getState().replay;
      if (!r || !(this.host instanceof LocalHost)) return;
      this.host.paused = false;
      useUI.getState().set({ replay: { ...r, paused: false, ff: true, until: Math.max(1, this.host.state.turn) + 1 } });
      if (this.world) this.world.animator.speed = animatorSpeed();
      this.presenter?.nudge();
    },
    restart: () => {
      // (If it fails, the game watched has already been taken down: back to the title, saying so.)
      if (this.replaying)
        this.watchReplay(this.replaying).catch((e) => {
          console.error('could not restart the replay', e);
          this.end();
          useUI.getState().set({ screen: 'title', view: null, modal: null });
          showError("That game couldn't start. Try again from the title.", 6000);
        });
    },
  };

  /** The seed of the next new game, chosen ahead so its island can be built ahead (see prepare). */
  private seedAhead: number | null = null;
  private nextSeed() {
    return (this.seedAhead ??= Math.floor(Math.random() * 1e9));
  }

  /**
   * Start building the island of the game Set sail (or Continue) would begin now, its terrain on
   * the workers, while the player is still choosing: the set-up page as it changes, the title with
   * a save. start finds it built if it is asked for the same game (a new game keeps the seed chosen
   * here), and builds as before otherwise.
   */
  prepare(cfg: NewGameConfig, resume?: SavedGame) {
    const world = this.world;
    if (!world || this.host) return;
    try {
      const seed = resume?.cfg.seed ?? cfg.seed ?? this.nextSeed();
      const given = gameOptions(cfg, seed, resume);
      const n = resume ? resume.seats.length : cfg.opponents + 1;
      // (Only the board matters here: the seats as placeholders, as many as the game has.)
      const seats = resume?.seats ?? PRESET_COLORS.slice(0, n).map((c, i) => ({ name: `Seat ${i + 1}`, color: c.id, isBot: true }));
      const board = resume ? resume.cfg.board : dealBoard(n, given);
      const state = createGame(seats, { ...given, board }).state;
      world.prepareIsland(state);
      // (A first visit's shaders compile meanwhile, on this island: see warmShaders.)
      if (!navigator.webdriver || new URLSearchParams(location.search).has('warm')) setTimeout(() => this.warmShaders(state), 1500);
    } catch (e) {
      // (A set-up that can't be dealt is start's to report; nothing is built ahead.)
      if (import.meta.env.DEV) console.warn('could not prepare the island', e);
    }
  }

  async start(cfg: NewGameConfig, resume?: SavedGame, replay?: SavedGame) {
    // Progress for the "Setting sail" buttons (ui/Sail.tsx): from nothing, at once, so a button
    // lit as this starts never shows the last voyage's. Set out in proportion to the time each
    // part takes: building the island about a quarter, compiling its shaders the rest.
    const sailing = (progress: number) => useUI.getState().set({ loading: { label: 'Setting sail', progress } });
    sailing(0);
    // (Before anything changes: a game that can't load its parts leaves the title as it was.)
    await loadGameParts();
    performance.mark('sail: parts');
    // A local game leaves any room this tab was in.
    this.leaveRoom();
    this.end();
    this.replaying = replay ?? null;
    this.lastConfig = { ...cfg, seed: undefined, board: undefined };
    const gen = ++this.gen;
    const world = this.world!;
    // (A board built ahead to warm the GPU, if one is up, gives way: see warmShaders.)
    this.dropWarm();
    sailing(0.02);
    // The island is built and compiled out of sight first, while the view turns slowly on (its
    // occasional hitch hardly shows at that pace); only when all is ready does the camera dive to
    // the water and sweep in as the island rises (see World.introSequence), so nothing heavy runs
    // during the motion.
    // The bots take the first presets that can't be mistaken for the player's colour.
    // (Or, with the colour-blind-safe palette, from the Okabe–Ito colours.)
    const safe = useUI.getState().settings.palette === 'colorblind';
    const others = (safe ? ['#0072b2', '#e69f00', '#f2ede2', '#cc79a7', '#009e73', '#d55e00'] : PRESET_COLORS.map((c) => c.id)).filter((c) => c !== cfg.color && !colorsClash(c, cfg.color));
    const n = cfg.opponents + 1;
    let seats: SeatConfig[] = [{ name: cfg.watch ? 'Spectated Bot' : cfg.name || 'You', color: cfg.color, isBot: !!cfg.watch, difficulty: cfg.difficulty }];
    // (A new game takes the seed its island was built ahead for, if it was: see prepare.)
    const seed = resume?.cfg.seed ?? replay?.cfg.seed ?? cfg.seed ?? this.nextSeed();
    this.seedAhead = null;
    // The crew are drawn by the game's seed (the same seed, the same opponents), none repeated; a
    // player who took a bot's portrait plays without that bot.
    const dice = new Rng(seedFrom(seed ^ 0x63726577));
    const crew = pickCrew(n - 1, () => dice.next(), { faces: cfg.avatar !== undefined && cfg.avatar >= 0 ? [cfg.avatar] : [] });
    this.avatars = [cfg.watch ? -1 : (cfg.avatar ?? -1)];
    for (let i = 1; i < n; i++) {
      const name = crew[i - 1] ?? `Crew ${i}`;
      seats.push({ name, color: others[i - 1], isBot: true, difficulty: cfg.difficulty });
      this.avatars.push(avatarOf(name));
    }
    if (resume ?? replay) {
      seats = (resume ?? replay)!.seats;
      this.avatars = (resume ?? replay)!.avatars;
    }
    // In a replay nobody decides anything: every seat plays back its recorded moves.
    if (replay) seats = seats.map((s) => ({ ...s, isBot: false }));
    const given = gameOptions(cfg, seed, resume ?? replay, replay);
    let host: LocalHost;
    let board: BoardSpec;
    try {
      // A new game's board is dealt here, once, and saved with it; a save brings its own.
      board = resume ?? replay ? (resume ?? replay)!.cfg.board : dealBoard(seats.length, given);
      host = new LocalHost(seats, { ...given, board }, undefined, replay?.online?.secret);
    } catch (e) {
      // (A save or a finished game whose options this version refuses: the title lets go of it.)
      throw resume ?? replay ? new SaveUnusable(e) : e;
    }
    // A bot's offer to you is declined for you after the table's time limit, its clock stopped
    // whenever the table's own countdown is (a dialog, a pause, a hidden tab); a few seconds late,
    // so the table's own decline comes first.
    const offers = () => {
      const s = useUI.getState();
      host.setOfferWait(s.settings.offerTimer ? s.settings.offerTimer * 1000 + 3000 : 0);
      host.holdOffers(s.modal !== null || s.busy || s.paused || s.offerHeld || s.qualityProgress !== null || document.hidden);
    };
    offers();
    const unsubOffers = useUI.subscribe(offers);
    document.addEventListener('visibilitychange', offers);
    this.unsubOffers = () => {
      unsubOffers();
      document.removeEventListener('visibilitychange', offers);
    };
    if (replay) host.setScript(replay.history);
    useUI.getState().set({ replay: replay ? { paused: false, speed: 1, index: 0, total: replay.history.length, ff: false, until: 0, ...(replay.online && { fair: replay.online.fair }) } : null });
    world.animator.speed = animatorSpeed();
    this.stats = emptyStats();
    addEvents(this.stats, host.initialEvents);
    let damaged = false;
    if (resume) {
      try {
        host.replay(resume.history, (ev) => addEvents(this.stats, ev));
      } catch (e) {
        console.error(e);
        // Nothing usable: back to the title (which drops the save) rather than a fresh game passed
        // off as the save. A partly restored one replaces it once the board is up.
        if (host.history.length === 0) throw new SaveUnusable(e);
        damaged = true;
      }
    }
    this.host = host;
    this.me = 0;
    // Keep statistics current and save after every action (debounced).
    const savedCfg = { ...cfg, seed, board };
    // (What the game was created under, to replay it by: the module versions only when it has modules.)
    const { rules, modules, moduleRules } = host.state.options;
    const stamp = { rules, ...(modules.length > 0 && { moduleRules }) };
    const savedSeats = seats;
    const savedAvatars = [...this.avatars];
    let unsaved = false;
    // The save is one slot every tab shares. This tab keeps it while it is the one that wrote it
    // last; if another tab (the same game continued there, or a new one) takes it, this game goes
    // on playable but stops writing, and says so with a way to take the save back.
    let away = false;
    const setAway = (on: boolean) => {
      away = on;
      if (useUI.getState().saveAway !== on) useUI.getState().set({ saveAway: on });
    };
    const persist = () => {
      this.saveTimer = null;
      if (host.state.phase === 'gameOver' || away) return;
      const kept = writeSave({ v: 3, ...stamp, cfg: savedCfg, seats: savedSeats, avatars: savedAvatars, history: host.history, turn: host.state.turn, savedAt: Date.now() });
      // (Said once a game: the menu says the game is saved as you play, and here it isn't.)
      if (!kept && !unsaved) {
        unsaved = true;
        showError('This game can’t be saved in this browser (its storage is full or blocked), so it won’t be there to continue.', 8000);
      }
    };
    // (The whole history is written each time: when the page is idle, not in the middle of a move.)
    const idle = (fn: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 0));
    this.flushSave = () => {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        persist();
      }
    };
    this.unsubSave = host.subscribe((m) => {
      addEvents(this.stats, m.events);
      if (replay) return;
      if (m.state.phase === 'gameOver') {
        // Kept for its replay. (A game of bots, such as the map editor's test, only for this visit:
        // the one kept from before is a game you played.)
        this.lastGame = { v: 3, ...stamp, cfg: savedCfg, seats: savedSeats.map((s) => ({ ...s })), avatars: savedAvatars, history: host.history.slice(), turn: host.state.turn, savedAt: Date.now() };
        if (!cfg.watch) writeLastGame(this.lastGame);
      }
      if (cfg.watch) return;
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      // A finished game is never resumable: drop the save and any write still pending.
      if (m.state.phase === 'gameOver') {
        // (Not another tab's save, if it has taken the slot.)
        if (!away) clearSave();
        return;
      }
      // (Only while this game is still the one in play: a write left waiting by a game since quit
      // would put it back over the next one's save, and take that one's pending write with it.)
      this.saveTimer = setTimeout(() => idle(() => gen === this.gen && this.saveTimer !== null && persist()), 400);
    });
    // Only once the game is ready to play (a start that fails before this leaves the save as it
    // was): a resumed save that was already decided shouldn't come back again, a new game replaces
    // the saved one at once (quitting before a move mustn't bring the old one back), and a partly
    // restored save is kept as restored.
    const ready = () => {
      if (resume && host.state.phase === 'gameOver') clearSave();
      else if (!replay && !cfg.watch) {
        // (A resumed game writes its save too, so this tab owns it from the start and another tab
        // holding the same game hears of it.)
        persist();
        if (!away) {
          this.unwatchSave?.();
          this.unwatchSave = watchSave(() => {
            if (host.state.phase !== 'gameOver') setAway(!ownsSave());
          });
          this.reclaimSave = () => {
            setAway(false);
            if (this.saveTimer) clearTimeout(this.saveTimer);
            persist();
          };
        }
      }
    };
    if (!(await this.raise(host, gen, { resumed: !!resume, ready }))) return;
    if (resume) {
      const text = damaged ? `Your save was damaged; resumed at the last valid move (turn ${host.state.turn})` : `Game resumed at turn ${host.state.turn}`;
      useUI.getState().pushLog({ player: null, text });
      if (damaged) useUI.getState().pushBanner({ title: 'Save partly restored', subtitle: `Resumed at turn ${host.state.turn}`, tone: 'warn' }, 3600);
    }
  }

  /**
   * Raise the island for a game: its board built and its shaders compiled out of sight, then the
   * dive and the island rising, then its opening presented (or, for a game already under way, its
   * pieces revealed). False when it was left (or another game started) before the end.
   */
  private async raise(host: GameHost, gen: number, o: { resumed: boolean; keepChat?: boolean; ready?: () => void }): Promise<boolean> {
    const world = this.world!;
    const resume = o.resumed;
    const sailing = (progress: number) => useUI.getState().set({ loading: { label: 'Setting sail', progress } });
    await world.setBoard(host.state, (f) => gen === this.gen && sailing(0.02 + 0.23 * f));
    if (gen !== this.gen) return false;
    sailing(0.25);
    world.setTimeFromTurn(host.state.turn, host.state.players.length);
    world.snapTime();
    await loadDisplayFont();
    // (A pause between each part, so the page keeps drawing.)
    const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
    await pause();
    if (gen !== this.gen) return false;
    const { BoardView, Presenter, BoardInput } = await loadGameParts();
    const view = new BoardView(world, host.state);
    performance.mark('sail: view built');
    await pause();
    if (gen !== this.gen) {
      view.dispose();
      return false;
    }
    // (A failure while preparing it, a context lost or a shader refused, leaves no view behind.)
    try {
      // Compile the new board's shaders (pieces still to come and the dice included) before the
      // intro, so it doesn't stall as things first appear. The title's button says "Setting sail".
      // (The stand-ins stay with the board, hidden, so what they compiled is kept: see standIns.)
      view.standIns();
      sailing(0.28);
      // (After any quality change still being prepared, so their compiles don't overlap.)
      await this.qualityQueue;
      // (Progress is what is done: the objects built and the GPU's pipelines finished, see Stage.precompile.)
      const compiled = (f: number) => 0.28 + 0.72 * f;
      performance.mark('sail: compile');
      await world.precompile((done, total) => total && gen === this.gen && sailing(compiled(done / total)), true, true, () => gen !== this.gen);
      if (gen === this.gen) sailing(1);
      performance.mark('sail: compiled');
      if (gen === this.gen) markGpuWarm(useUI.getState().quality);
      if (gen !== this.gen) {
        view.dispose();
        return false;
      }
    } catch (e) {
      view.dispose();
      throw e;
    }
    // (The game is ready to play: its starter's save is written now, see start.)
    o.ready?.();
    this.view = view;
    const presenter = new Presenter(host, world, view, this.me);
    this.presenter = presenter;
    this.input = new BoardInput(world, view, presenter);
    this.input.onHoverHex = (h) => this.hoverListeners.forEach((l) => l(h));
    // The opening can be hurried along until play is handed over (see skipIntro), as the status line says.
    this.skippable = gen;
    this.skipHint = matchMedia('(pointer: coarse)').matches ? 'Tap to skip' : 'Click or press Space to skip';
    useUI.getState().set({ screen: 'game', me: this.me, view: host.state, mapPieces: null, log: [], ...(!o.keepChat && { chat: [], chatUnread: 0 }), banners: [], flights: [], modal: null, interaction: { kind: 'idle' }, choice: null, batch: [], handDelta: {}, diceRoll: null, hint: this.skipHint, error: null, busy: true });
    // (A resumed game has seen its opening: it plays out quickly, and can still be hurried further.)
    if (resume) this.skipIntro();
    const skipOnPress = () => this.skipIntro();
    world.stage.canvas.addEventListener('pointerdown', skipOnPress);
    try {
      return await this.openGame(host, gen, world, view, presenter, resume);
    } finally {
      world.stage.canvas.removeEventListener('pointerdown', skipOnPress);
      if (gen === this.gen) this.endIntroSkip();
    }
  }

  /** The opening of a game raised by raise: the island rising, then its first events presented. */
  private async openGame(host: GameHost, gen: number, world: World, view: BoardView, presenter: Presenter, resume: boolean): Promise<boolean> {
    sfx.startAmbience();
    sfx.startMusic();
    // Pieces already in the state (a resumed game, or the beginner set-up) wait until the
    // island has risen; new games present their starting resources flying in.
    view.hidePieces();
    if (!resume) presenter.prepareIntro();
    // (The HUD's first render lands before the camera moves, not in the middle of the dive.)
    this.introducing = true;
    useUI.getState().set({ hudHeld: true });
    const release = () => useUI.getState().hudHeld && useUI.getState().set({ hudHeld: false });
    try {
      await world.animator.wait(0.15);
      if (gen !== this.gen) return false;
      // Leaving (or restarting) mid-way stops it where it is: see the cancel checks in the intro.
      await world.introSequence(view, () => gen !== this.gen, release);
    } finally {
      release();
      if (gen === this.gen) this.introducing = false;
    }
    if (gen !== this.gen) return false;
    // Last played flat: the island, once risen, flattens into the map before the first cards fly.
    if (rememberedView() === '2d') await setViewMode('2d');
    if (gen !== this.gen) return false;
    if (resume) await view.revealPieces();
    if (gen !== this.gen) return false;
    // (A resumed game's pennants go up along its Longest Route.)
    if (resume) presenter.showRoute(host.state);
    await presenter.intro(resume ? [] : host.initialEvents);
    return gen === this.gen;
  }

  private leaving = false;

  // ------------------------------------------------------------------ online

  /**
   * Go aboard an online room (a code typed in, a room just made, a /r/CODE link): its harbour
   * opens, and the island rises once the host sets sail. `watch`: from the quay, without a seat.
   * `seat`: a handed-off seat's token, from a link's fragment. The online code is a chunk of its
   * own, fetched here: a solo player never loads it.
   */
  async join(code: string, o: { watch?: boolean; seat?: string } = {}) {
    const [{ RoomClient }, { showRoomInUrl }] = await Promise.all([import('../online/client'), import('../online/links')]);
    this.leaveRoom();
    const watch = !!o.watch;
    const room: RoomClient = new RoomClient(
      code,
      { watch, seatToken: o.seat },
      {
        onGame: (host) => void this.play(room, host),
        onRoom: (info, you) => {
          const on = useUI.getState().online;
          if (!on || this.room !== room) return;
          // (Free text where the room allows it, your papers do and you hold a seat; the room enforces it all.)
          const points = info.results ? info.seats.map((x) => info.results!.standings.find((r) => r.seat === x.seat)?.points ?? 0) : undefined;
          const next = { ...on, freeChat: info.settings.freeChat && !you?.quick && !watch && you?.seat !== null, rated: info.settings.rated, points };
          if (next.freeChat !== on.freeChat || next.rated !== on.rated || next.points?.join() !== on.points?.join()) useUI.getState().set({ online: next });
          // Conceded: from here the seat is the crew's, and you watch it sail (nothing prompts for it).
          const mine = you?.seat == null ? null : info.seats.find((x) => x.seat === you.seat);
          const gaveUp = !!mine?.conceded;
          if (gaveUp !== this.conceded) {
            this.conceded = gaveUp;
            if (this.host && this.presenter) this.presenter.updateInteraction(this.host.state);
          }
        },
        onChat: (l) => this.room === room && useUI.getState().pushChat(l),
        // (The table's anchor is everyone's: the paused pill and the menu say so, and Carry on lifts it.)
        onPaused: (on) => this.room === room && useUI.getState().set({ paused: on }),
        // Put ashore, the seat taken up elsewhere, or the room gone: the harbour's card says why
        // (and, for a seat that moved to another tab, offers it back). From the table, the island
        // sinks first.
        onClosed: (why) => {
          if (this.room !== room) return;
          // (Closed while its island is still rising, from the harbour: that stops, and the harbour says why.)
          if (useUI.getState().screen !== 'game') {
            if (this.host) this.end();
            return;
          }
          void (async () => {
            const { useOnline } = await import('../online/store');
            const rejoin = useOnline.getState().rejoin;
            await this.quitToTitle();
            useOnline.getState().set({ code, watch, closedWhy: why, rejoin });
            useUI.getState().set({ screen: 'harbour', online: { code, watch, freeChat: false } });
          })();
        },
      },
    );
    this.room = room;
    this.conceded = false;
    // (The bots' think times as their pauses would be here: the pace setting over the animation speed.)
    room.waitScale = () => BOT_PACE[useUI.getState().settings.botPace] / Math.max(0.25, animSpeed());
    useUI.getState().set({ screen: 'harbour', modal: null, online: { code, watch, freeChat: false }, chat: [], chatUnread: 0 });
    showRoomInUrl({ code, watch });
    await room.open();
  }

  /** The room has set sail (or was at sea when you came aboard): raise its island and play it through its host. */
  private async play(room: RoomClient, host: RemoteHost) {
    try {
      await loadGameParts();
    } catch (e) {
      console.error('could not load the game', e);
      useUI.getState().set({ error: 'The game couldn’t be loaded: check your connection and reload the page.' });
      return;
    }
    if (this.room !== room) return;
    this.end();
    this.replaying = null;
    const gen = ++this.gen;
    this.host = host;
    // (On the quay there is no seat: seat 0's view is drawn, and nothing prompts for it.)
    this.me = host.me ?? 0;
    const { useOnline } = await import('../online/store');
    const seats = useOnline.getState().room?.seats ?? [];
    this.avatars = host.state.players.map((p) => seats.find((x) => x.seat === p.id)?.avatar ?? -1);
    this.stats = emptyStats();
    addEvents(this.stats, host.initialEvents);
    this.unsubSave = host.subscribe((m) => addEvents(this.stats, m.events));
    useUI.getState().set({ replay: null, loading: { label: 'Setting sail', progress: 0.04 } });
    if (this.world) this.world.animator.speed = animatorSpeed();
    await this.raise(host, gen, { resumed: host.resumed, keepChat: true });
  }

  /**
   * "Sail again" after an online game: the room makes the next one for this table (or has made it,
   * if someone asked first), the island sinks, and its harbour opens with your seat kept for you.
   */
  async sailAgain() {
    const room = this.room;
    if (!room) return;
    // (Asked first, so a failure leaves the results where they are; only then does the island sink.)
    const code = await room.rematch();
    await this.quitToTitle();
    await this.join(code).catch((e) => {
      console.error('could not join the next game', e);
      showError('The next game couldn’t be joined. Try its link from Multiplayer.', 6000);
    });
  }

  /** Concede the online game: the crew sails your seat to the end, you watch it, and ratings place you last. False when it couldn't be sent (not connected just now). */
  concede(): boolean {
    return !!this.room?.concede();
  }

  /** Leave the online table for the menu. The game's seat goes to the crew at once (back by the link, Take the helm has it again). */
  async leaveTable() {
    await this.quitToTitle();
  }

  /** Leave the room this tab is in (the room hears it): back to no room, and the address to the start. */
  leaveRoom() {
    const room = this.room;
    this.room = null;
    room?.leave();
    // (Left from the harbour while its game's island was still rising: that stops too, rather than
    // opening on a table that's gone.)
    if (room && this.host && useUI.getState().screen !== 'game') this.end();
    if (useUI.getState().online || useUI.getState().screen === 'harbour') useUI.getState().set({ online: null, ...(useUI.getState().screen === 'harbour' && { screen: 'title' }) });
    if (room) void import('../online/links').then((m) => m.showRoomInUrl(null));
  }

  /**
   * Leave the game for the title: play stops (the game is saved, or online the room is told and
   * your seat goes to the crew), the HUD goes, the island sinks back into the sea
   * (World.outroSequence), and then the menu returns.
   */
  async quitToTitle() {
    if (this.leaving) return;
    this.leaving = true;
    const world = this.world;
    const view = this.view;
    // The view stays until the island has sunk with everything on it.
    this.view = null;
    this.end();
    this.leaveRoom();
    useUI.getState().set({ screen: 'leaving', modal: null, view: null });
    try {
      if (world) await world.outroSequence(view, reducedMotion());
    } finally {
      view?.dispose();
      this.leaving = false;
      useUI.getState().set({ screen: 'title' });
    }
  }

  /** Submit an action for the local player. Returns null on success, or an error message. */
  act(action: Action): string | null {
    if (!this.presenter) return 'No game in progress.';
    // (A move made while paused carries the game on: paused, it would be taken and then sit
    // frozen until P was pressed again.)
    if (useUI.getState().paused) this.setPaused(false);
    return this.presenter.act(action);
  }

  private qualityQueue: Promise<void> = Promise.resolve();
  /** Counts quality changes: a newer one (or an undo) stops the one being prepared. */
  private qualityRun = 0;
  /** What the change being prepared replaced, while it can still be undone. */
  private qualityUndo: { quality: Quality; setting: Settings['quality'] } | null = null;

  /**
   * Switch quality presets: rebuild the passes, then compile their shaders side by side (with
   * progress for the HUD) before the island is drawn again, instead of stalling on first draw.
   * The game holds still meanwhile (no bot moves, no animations), as the island isn't drawn.
   * Given the setting it replaces (a player's choice, not Auto's), the change can be undone.
   */
  applyQuality(q: Quality, replacing?: Settings['quality']) {
    const from = useUI.getState().quality;
    // The preset already on (or already being prepared): nothing to rebuild.
    if (q === from) return this.qualityQueue;
    const run = ++this.qualityRun;
    this.qualityQueue = this.qualityQueue.then(async () => {
      const world = this.world;
      if (!world || run !== this.qualityRun) return;
      const current = () => run === this.qualityRun;
      this.qualityUndo = replacing === undefined ? null : { quality: from, setting: replacing };
      const undo = replacing !== undefined;
      useUI.getState().set({ quality: q, qualityProgress: { to: q, progress: 0, undo } });
      // The game holds still meanwhile: no bot moves, animations or camera flights (its own hold,
      // not the replay's pause, which a player may toggle in the meantime).
      const presenter = this.presenter;
      presenter?.hold('quality', true);
      world.held = true;
      world.animator.speed = 0;
      try {
        // (Lets the progress show before the rebuild takes the main thread.)
        await new Promise((r) => setTimeout(r, 30));
        // The canvas is resized for the new preset's resolution only once it is ready: resizing
        // clears it, and the last frame should stay up (blurred, see QualityToast) meanwhile.
        world.setQuality(q, false);
        // Hidden things too (the dice, pieces in flight, effects): with new lighting or passes
        // they would otherwise each stall the frame they next appear in.
        await world.precompile((done, total) => total && current() && useUI.getState().set({ qualityProgress: { to: q, progress: done / total, undo } }), true, false, () => !current());
      } finally {
        world.stage.resize();
        world.held = false;
        if (current()) {
          this.qualityUndo = null;
          useUI.getState().set({ qualityProgress: null });
        }
        world.animator.speed = animatorSpeed();
        presenter?.hold('quality', false);
      }
    });
    // (One failed change mustn't block every later one.)
    this.qualityQueue = this.qualityQueue.catch((e) => console.error('quality change failed', e));
    return this.qualityQueue;
  }

  /** Undo the quality change being prepared: back to the preset and setting it replaced. */
  undoQuality() {
    const u = this.qualityUndo;
    if (!u) return;
    this.qualityUndo = null;
    const ui = useUI.getState();
    ui.set({ settings: { ...ui.settings, quality: u.setting } });
    if (u.setting === 'auto') rememberQuality(u.quality);
    return this.applyQuality(u.quality);
  }

  /** Pause a solo game (P) or carry on: bots wait and the island's animations stop. Online, ask the table to drop anchor. */
  setPaused(on: boolean) {
    if (!this.presenter || this.presenter.spectating) return;
    if (this.room) {
      this.room.pause(on);
      return;
    }
    useUI.getState().set({ paused: on });
    this.presenter.hold('pause', on);
    // (The paused pill says so for as long as it lasts: see PausedPill.)
  }

  /** Say something at the table (the others may answer). Online it goes to the room, which tells everyone (you too). */
  say(text: string) {
    const t = text.trim().slice(0, 160);
    if (!t) return;
    if (this.room) {
      this.room.say(t);
      return;
    }
    if (!this.presenter) return;
    useUI.getState().pushChat({ player: this.me, text: t });
    this.presenter.talk?.hear(t);
  }

  end() {
    this.gen++;
    this.introducing = false;
    this.endIntroSkip();
    this.world?.rig.cancelFocus();
    resetView();
    this.flushSave();
    this.flushSave = () => {};
    // A hex coming up out of the fog stops where it is (the island may be about to sink with it
    // still under the sea): before the tweens are finished, so finishing its own does nothing.
    this.world?.fog?.stop();
    // Complete any in-flight animations from the previous game before tearing it down.
    this.world?.animator.finishAll();
    this.unsubSave?.();
    this.unsubSave = null;
    this.unwatchSave?.();
    this.unwatchSave = null;
    this.reclaimSave = () => {};
    if (useUI.getState().saveAway) useUI.getState().set({ saveAway: false });
    this.unsubOffers?.();
    this.unsubOffers = null;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.input?.dispose();
    this.presenter?.dispose();
    this.view?.dispose();
    this.input = null;
    this.presenter = null;
    this.view = null;
    this.host?.dispose();
    this.host = null;
    useUI.getState().set({ flights: [], banners: [], diceRoll: null, busy: false, handDelta: {}, mapPieces: null, endArmed: false, replay: null, interaction: { kind: 'idle' }, choice: null, batch: [], boardFocus: null, placeConfirm: null, paused: false, hurry: false, catchUp: false });
    if (this.world) this.world.animator.speed = animatorSpeed();
  }
}

export const session = new Session();
