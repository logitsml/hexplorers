// UI state (zustand). The engine state shown here is the *presented* state: it
// lags the authoritative host while animations play, so counters update exactly
// when flying cards land.

import { DEFAULT_MOUSE, sanitizeKeys, sanitizeMouse, type KeyBinds, type MouseBinds } from './bindings';
import { create } from 'zustand';
import type { Action, Card, DevCardType, GameState, PlayerId, CardCounts, Resource } from '../engine';
import { emptyCards } from '../engine/constants';
import { RESOURCES } from '../engine/types';
import type { WeatherMode } from '../render/env/weather';
import type { EventDieResult } from '../render/fx/eventDie';
import type { Quality } from '../render/core/stage';

/** 'leaving': the island sinking after a game, before the title returns (neither shows). 'harbour': an online room's lobby. */
export type Screen = 'title' | 'game' | 'leaving' | 'editor' | 'harbour';

export type Interaction =
  | { kind: 'idle' }
  | { kind: 'setupSettlement'; spots: number[] }
  | { kind: 'setupRoad'; spots: number[] }
  | { kind: 'road'; spots: number[]; free?: boolean }
  | { kind: 'settlement'; spots: number[] }
  | { kind: 'city'; spots: number[] }
  | { kind: 'robber'; hexes: number[] }
  /**
   * An expansion's move that targets the board: each spot stands for the actions taken there (see
   * game/moduleActions.ts). `chosen` makes it a staged pick, a move made at sets of spots chosen in
   * turn (a turncoat's raiders: the hexes they leave, then those they go to): the spots chosen so far
   * at each stage, the last being the stage under way.
   */
  | { kind: 'pick'; target: 'vertex' | 'edge' | 'hex'; spots: number[]; label: string; actions: Action[]; source?: boolean; chosen?: number[][] };

/** The spots the interaction can be placed on, and what kind of spot they are. */
export function interactionSpots(it: Interaction): { kind: 'vertex' | 'edge' | 'hex'; ids: number[] } | null {
  switch (it.kind) {
    case 'setupSettlement':
    case 'settlement':
    case 'city':
      return { kind: 'vertex', ids: it.spots };
    case 'setupRoad':
    case 'road':
      return { kind: 'edge', ids: it.spots };
    case 'robber':
      return { kind: 'hex', ids: it.hexes };
    case 'pick':
      return { kind: it.target, ids: it.spots };
    default:
      return null;
  }
}

/** A rectangle of the window, in px. */
export interface FlatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LogLine {
  id: number;
  player: PlayerId | null;
  text: string;
}

export interface ChatLine {
  id: number;
  /** Who spoke (a seat, the person playing included; -1 online for the table's own notices and the quay). */
  player: PlayerId;
  /** Who it was when not a seat (online: a spectator on the quay, the table). */
  name?: string;
  text: string;
  /** A deal a bot suggested: you give `give` and get `get` from `to`, offered with one click (then cleared). */
  offer?: { to: PlayerId; give: CardCounts; get: CardCounts };
}

export interface Banner {
  id: number;
  title: string;
  subtitle?: string;
  tone?: 'info' | 'warn' | 'player';
  player?: PlayerId;
  /** A painting shown under the ribbon (an expansion award's card, the Almanac's happening). */
  art?: string;
}

/** A card currently flying across the screen (rendered by the flight layer). */
export interface Flight {
  id: number;
  kind: 'resource' | 'dev' | 'devBack' | 'resourceBack' | 'bonus' | 'token';
  bonus?: 'longestRoute' | 'largestArmy';
  /** A token's painting (the raider fleet's defence token). */
  art?: string;
  resource?: Card;
  dev?: DevCardType;
  /** Which building a Victory Point card shows. */
  variant?: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /**
   * Produced cards: they pop up out of the tile at `from`, gather over the building that
   * earned them (`via`), then fly on to `to`.
   */
  via?: { x: number; y: number };
  /** The card never arrives: it greys and fades at `to` (taken by the robber, or no supply). */
  fizzle?: boolean;
  /** Comes up out of the board: lying in its tile at first, standing up as it rises. */
  rise?: boolean;
  delay: number;
  duration: number;
  rotate?: number;
  scale?: number;
  /** Size it starts at: a card lifting off a hand stack starts at the stack's size, opaque. */
  startScale?: number;
  /** Size it ends at: a hand stack's size, or small as it is taken into a panel or the supply. */
  endScale?: number;
  /** Called as it settles into its holder (just before the flight ends, so the two cross-fade). */
  onLand?: () => void;
}

export interface Settings {
  /** Auto: a preset chosen for the device (see app/deviceQuality.ts), else a fixed one. */
  quality: 'auto' | Quality;
  animationSpeed: number;
  sound: number;
  music: number;
  timeOfDay: 'dynamic' | 'daytime' | 'morning' | 'noon' | 'golden' | 'dusk' | 'night';
  showProbabilities: boolean;
  confirmEndTurn: boolean;
  /** A click on a spot shows the piece first, and a second click (or the button) places it; touch always does. */
  confirmPlace: boolean;
  motionBlur: boolean;
  /** Interface size multiplier for legibility. */
  uiScale: number;
  /** 'system' follows the OS setting. */
  reduceMotion: 'system' | 'on' | 'off';
  /** Changing (passing showers and rainbows) or held clear, cloudy, rainy or stormy. */
  weather: WeatherMode;
  /** Pieces at full brightness whatever the light, so they read clearly at night and in shade. */
  brightPieces: boolean;
  /** Depth-of-field strength on the board, 0 (none) .. 1 (strong); 0.5 is the default look. */
  blur: number;
  /** Seconds to answer another player's offer before it is declined for you; 0 waits as long as you like. */
  offerTimer: 30 | 60 | 0;
  /** How long announcements stay up: a shorter or longer time than the usual. */
  bannerTime: 'short' | 'normal' | 'long';
  /** How long the other players take over their moves. */
  botPace: 'quick' | 'normal' | 'relaxed';
  /** Player colours: the usual ones, or a set told apart with any kind of colour vision (from the next game). */
  palette: 'standard' | 'colorblind';
  /** Stronger lines, solid panels and darker text; 'system' follows the OS setting. */
  highContrast: 'system' | 'on' | 'off';
  /** Pass a wagon auction for you when nowhere the wagon could go touches your pieces (game/pacing.ts). */
  autoPassWagon: boolean;
  /** A bounty field's or the Learning ability's pick taken in this resource without asking, when the supply has it; null asks. */
  pickResource: Resource | null;
  /** The others' table talk kept to the panel: no bubbles, badge or read-out (it's still there to read). */
  chatMuted: boolean;
  /** The supply's resource counts shown (off: only what's in it, not how many). */
  supplyCounts: boolean;
  /** Keys chosen in place of the usual ones (game/bindings.ts), and what each mouse button's drag does. */
  keys: KeyBinds;
  mouse: MouseBinds;
  /** The interface's material: Sea Glass (clear glass that follows the sky) or the parchment of the first releases. */
  look: 'glass' | 'parchment';
}

export interface UIStore {
  screen: Screen;
  view: GameState | null;
  me: PlayerId;
  interaction: Interaction;
  log: LogLine[];
  /** Table talk, the chat panel open or not, and lines arrived while it was closed. */
  chat: ChatLine[];
  chatOpen: boolean;
  chatUnread: number;
  banners: Banner[];
  flights: Flight[];
  diceRoll: { id: number; dice: [number, number]; player: PlayerId; event?: EventDieResult } | null;
  /**
   * Visual hand adjustments while cards are in flight, added to the presented counts
   * (key -1 = the bank). Reset whenever a new state is committed.
   */
  handDelta: Record<number, CardCounts>;
  busy: boolean;
  /** "Confirm before ending turn": the first press arms, the second ends the turn. */
  endArmed: boolean;
  /**
   * Watching a finished game back: paused, its speed, how far through its moves, and a fast-forward
   * to `until`'s turn. `fair`: an online game's replay, whose dice checked out (true) or couldn't be.
   */
  replay: { paused: boolean; speed: number; index: number; total: number; ff: boolean; until: number; fair?: boolean } | null;
  /** `cards`: cards an expansion asks for from a hand, chosen together (see game/handPicks.ts). */
  modal: null | 'trade' | 'counter' | 'bank' | 'discard' | 'steal' | 'invention' | 'monopoly' | 'cards' | 'settings' | 'rules' | 'devcards' | 'gameover' | 'menu' | 'leave';
  hint: string;
  /** Screen-reader announcement (e.g. the spot chosen with the arrow keys). */
  announce: string;
  error: string | null;
  settings: Settings;
  worldReady: boolean;
  /** The preset being drawn (Auto's pick, or the one chosen). */
  quality: Quality;
  /** Switching presets: compiling the new one's shaders (0..1), or null. */
  qualityProgress: null | { to: Quality; progress: number; undo?: boolean };
  /** What the loading screen shows: the step under way, how far along (0..1), or what failed. */
  /** `lost`: the graphics device went after start-up (the error then asks for a reload). */
  loading: { label: string; progress: number; error?: string; lost?: boolean };
  muted: boolean;
  /** The camera has been moved away from the home view (the reset button lights up). */
  cameraOffHome: boolean;
  /** An expansion's move with more than one way to make it: the ways, offered as a list (see ui/ModuleControls.tsx). */
  choice: null | { title: string; actions: Action[] };
  /**
   * Moves chosen together that the engine takes one at a time (the cards of an unrest's discard):
   * those still to land, the first on its way, each sent once the one before it has landed
   * (Presenter.actAll).
   */
  batch: Action[];
  /** On touch, a tapped spot waiting to be confirmed (what the confirm button says), or null. */
  placeConfirm: null | { label: string };
  /** The board as a 3D island or a flat 2D map (see app/viewMode.ts). */
  viewMode: '3d' | '2d';
  /** The flat map's part in a change of view: built unseen ahead of time, coming in, settled, or going out. */
  flatPhase: 'pre' | 'in' | 'shown' | 'out' | null;
  /**
   * Where the flat map sits: the island's centre on screen (px) and px per world unit, the window's
   * size, and the parts of it the map was fitted to: what the HUD's panels leave free, and the
   * whole of the window clear of the screen's own edges (app/mapFit.ts).
   */
  flatLayout: null | { cx: number; cy: number; k: number; wx: number; wz: number; w: number; h: number; free: FlatRect; safe: FlatRect };
  /** The board spot being previewed (hovered, chosen with the keys, or tapped once). */
  boardFocus: null | { kind: 'vertex' | 'edge' | 'hex'; id: number };
  /**
   * The pieces as presented so far, ahead of `view` (which waits for the whole move): the flat
   * map shows each piece as it is placed, with its sound. Null when `view` is up to date.
   */
  mapPieces: null | Pick<GameState, 'buildings' | 'routes' | 'robberHex'>;
  /** Held "." key: presentations play faster while it's down. */
  hurry: boolean;
  /** The game's opening was skipped (a click on the island, Space, Enter or Escape): the rest of it plays at INTRO_RUSH. */
  introSkip: boolean;
  /** Online, the presentation has fallen behind the room: it plays faster until it catches up. */
  catchUp: boolean;
  /**
   * A page of the title's menu asked for by a link (/?go=/new, /?go=/multi: the installed app's
   * shortcuts, the static site's 404 page): the menu opens it, with a mix of expansions for a set-up.
   */
  goPage: null | { page: 'solo' | 'multi'; mix?: string[] };
  /**
   * In an online room (null in a local game): its code, whether you're watching, whether you may
   * type freely there (the room allows it, your papers do and you hold a seat; quick talk is
   * always on), whether it counts for ratings, and once it's over
   * each seat's final points as the room counted them (hidden cards and all, which a seat's own
   * view may never show of the others'). The rest of the room is in src/online/store.ts, loaded
   * only for online play.
   */
  online: null | { code: string; watch: boolean; freeChat: boolean; rated?: boolean; points?: number[] };
  /** Online, the table's news for a screen reader: the room's notices, a reaction, a hail (politely, outside the HUD). */
  tableNews: string;
  /** A solo game paused (P): bots wait and animations stop. */
  paused: boolean;
  /** The island's opening sweep is playing (first-game guides wait for it). */
  /** The HUD waits to come in until the intro's camera looks down on the water (its glass is lit for the sea, not the sky). */
  hudHeld: boolean;
  introducing: boolean;
  /** The countdown on an offer made to you (seconds left of `total`; total 0: no limit), for the tab icon. */
  offerClock: { id: number; left: number; total: number } | null;
  /** The offer's countdown is held: the pointer or keyboard focus is on the offer (the host's own backstop holds with it). */
  offerHeld: boolean;
  /** Another tab has taken over the solo save this game keeps (this tab stops saving until you play here again). */
  saveAway: boolean;
  set: (p: Partial<UIStore>) => void;
  pushLog: (l: Omit<LogLine, 'id'>) => void;
  pushChat: (l: Omit<ChatLine, 'id'>) => void;
  pushBanner: (b: Omit<Banner, 'id'>, ms?: number) => void;
  addFlights: (f: Omit<Flight, 'id'>[]) => number[];
  removeFlight: (id: number) => void;
}

let seq = 1;

/** Settings are written a moment after the last change (a slider drag changes them many times). */
let settingsTimer: ReturnType<typeof setTimeout> | null = null;
let settingsPending: Settings | null = null;

/** Write settings still waiting to be saved (the tab closing or hiding). */
export function flushSettings() {
  if (settingsTimer) clearTimeout(settingsTimer);
  settingsTimer = null;
  if (!settingsPending) return;
  try {
    localStorage.setItem('exploratory.settings', JSON.stringify({ ...settingsPending, v: 3 }));
  } catch {
    /* ignore */
  }
  settingsPending = null;
}

const defaultSettings: Settings = {
  quality: 'auto',
  animationSpeed: 1,
  sound: 0.8,
  music: 0.4,
  timeOfDay: 'daytime',
  showProbabilities: true,
  confirmEndTurn: false,
  confirmPlace: true,
  motionBlur: true,
  uiScale: 1,
  reduceMotion: 'system',
  weather: 'clear',
  brightPieces: true,
  blur: 0.5,
  offerTimer: 30,
  bannerTime: 'normal',
  botPace: 'normal',
  palette: 'standard',
  highContrast: 'system',
  autoPassWagon: false,
  pickResource: null,
  chatMuted: false,
  supplyCounts: true,
  keys: {},
  mouse: { ...DEFAULT_MOUSE },
  look: 'glass',
};

export const DEFAULT_SETTINGS: Readonly<Settings> = defaultSettings;

const oneOf = <T,>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Validate stored settings field by field, so an old or corrupted save can't break the game. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultSettings;
  const v = typeof r.v === 'number' ? r.v : 1;
  // (Up to v2 the defaults were day and night with changing weather; saves still on those take
  // the new ones, a clear day.)
  if (v < 3 && r.timeOfDay === 'dynamic') r.timeOfDay = d.timeOfDay;
  if (v < 3 && r.weather === 'changing') r.weather = d.weather;
  return {
    // (Before Auto, High was the default every save carried: those saves start on Auto.)
    quality: v < 2 && r.quality === 'high' ? 'auto' : oneOf(r.quality, ['auto', 'low', 'medium', 'high', 'ultra'] as const, d.quality),
    animationSpeed: num(r.animationSpeed, 0.25, 4, d.animationSpeed),
    sound: num(r.sound, 0, 1, d.sound),
    music: num(r.music, 0, 1, d.music),
    timeOfDay: oneOf(r.timeOfDay, ['dynamic', 'daytime', 'morning', 'noon', 'golden', 'dusk', 'night'] as const, d.timeOfDay),
    showProbabilities: bool(r.showProbabilities, d.showProbabilities),
    confirmEndTurn: bool(r.confirmEndTurn, d.confirmEndTurn),
    confirmPlace: bool(r.confirmPlace, d.confirmPlace),
    motionBlur: bool(r.motionBlur, d.motionBlur),
    uiScale: num(r.uiScale, 0.85, 1.3, d.uiScale),
    reduceMotion: oneOf(r.reduceMotion, ['system', 'on', 'off'] as const, d.reduceMotion),
    // (Older saves stored an on/off switch for passing showers.)
    weather: r.weather === true ? 'changing' : r.weather === false ? 'clear' : oneOf(r.weather, ['changing', 'clear', 'cloudy', 'rain', 'storm'] as const, d.weather),
    brightPieces: bool(r.brightPieces, d.brightPieces),
    blur: num(r.blur, 0, 1, d.blur),
    offerTimer: oneOf(r.offerTimer, [30, 60, 0] as const, d.offerTimer),
    bannerTime: oneOf(r.bannerTime, ['short', 'normal', 'long'] as const, d.bannerTime),
    botPace: oneOf(r.botPace, ['quick', 'normal', 'relaxed'] as const, d.botPace),
    palette: oneOf(r.palette, ['standard', 'colorblind'] as const, d.palette),
    highContrast: oneOf(r.highContrast, ['system', 'on', 'off'] as const, d.highContrast),
    autoPassWagon: bool(r.autoPassWagon, d.autoPassWagon),
    pickResource: oneOf(r.pickResource, [null, ...RESOURCES] as const, d.pickResource),
    chatMuted: bool(r.chatMuted, d.chatMuted),
    supplyCounts: bool(r.supplyCounts, d.supplyCounts),
    keys: sanitizeKeys(r.keys),
    mouse: sanitizeMouse(r.mouse),
    look: oneOf(r.look, ['glass', 'parchment'] as const, d.look),
  };
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('exploratory.settings');
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch {
    /* storage unavailable or corrupt */
  }
  return { ...defaultSettings };
}

export const useUI = create<UIStore>((set, get) => ({
  screen: 'title',
  view: null,
  me: 0,
  interaction: { kind: 'idle' },
  log: [],
  chat: [],
  chatOpen: false,
  chatUnread: 0,
  banners: [],
  flights: [],
  diceRoll: null,
  handDelta: {},
  endArmed: false,
  replay: null,
  busy: false,
  modal: null,
  hint: '',
  announce: '',
  tableNews: '',
  error: null,
  settings: loadSettings(),
  worldReady: false,
  quality: 'medium',
  qualityProgress: null,
  loading: { label: 'Unrolling the chart', progress: 0 },
  cameraOffHome: false,
  choice: null,
  batch: [],
  placeConfirm: null,
  viewMode: '3d',
  flatPhase: null,
  flatLayout: null,
  boardFocus: null,
  mapPieces: null,
  hurry: false,
  introSkip: false,
  catchUp: false,
  goPage: null,
  online: null,
  paused: false,
  offerClock: null,
  offerHeld: false,
  saveAway: false,
  hudHeld: false,
  introducing: false,
  muted: (() => {
    try {
      return localStorage.getItem('exploratory.muted') === '1';
    } catch {
      return false;
    }
  })(),
  set: (p) => {
    if (p.settings) {
      settingsPending = p.settings;
      if (settingsTimer) clearTimeout(settingsTimer);
      settingsTimer = setTimeout(flushSettings, 250);
    }
    set(p);
  },
  pushLog: (l) => set({ log: [...get().log.slice(-199), { ...l, id: seq++ }] }),
  // (Muted, the others' lines go into the panel without counting as news.)
  pushChat: (l) => set({ chat: [...get().chat.slice(-99), { ...l, id: seq++ }], chatUnread: get().chatOpen || (get().settings.chatMuted && l.player !== get().me) ? 0 : get().chatUnread + 1 }),
  pushBanner: (b, ms = 2600) => {
    const id = seq++;
    set({ banners: [...get().banners, { ...b, id }] });
    // Reading time follows the announcement-length setting and barely shortens with the animation
    // speed (fast-forward still clears them).
    const k = { short: 0.65, normal: 1, long: 1.6 }[get().settings.bannerTime];
    setTimeout(() => set({ banners: get().banners.filter((x) => x.id !== id) }), (ms * k) / Math.max(1, Math.sqrt(animSpeed())));
  },
  addFlights: (fs) => {
    const withIds = fs.map((f) => ({ ...f, id: seq++ }));
    set({ flights: [...get().flights, ...withIds] });
    return withIds.map((f) => f.id);
  },
  removeFlight: (id) => set({ flights: get().flights.filter((f) => f.id !== id) }),
}));

/**
 * Show a reason in the error line (it is read out too) for `ms`, or until something replaces it
 * when `ms` is 0. Clearing it later leaves a newer message alone. A refused move's reason stays
 * the default 2.6 s; one that explains why you're back at the title, 6 s.
 */
export function showError(text: string, ms = 2600) {
  useUI.getState().set({ error: text });
  if (ms > 0) setTimeout(() => useUI.getState().error === text && useUI.getState().set({ error: null }), ms);
}

export const emptyCounts = (): CardCounts => emptyCards();

/** The status line once you've rolled and nothing is being placed: what the turn has open. */
export const MAIN_HINT = 'Your turn!';

/** The bots' pace setting as a factor on their think time (a local game's own bots, and online the room's think times as shown here). */
export const BOT_PACE: Record<Settings['botPace'], number> = { quick: 0.55, normal: 1, relaxed: 1.7 };

/** How much faster a skipped opening plays out: its 5.7 s in about 0.7, the island still seen to rise. */
export const INTRO_RUSH = 8;

/** How fast animations run: the setting, times a replay's speed (or its fast-forward), hurried, catching up, or an opening skipped. */
export const speedOf = (s: Pick<UIStore, 'settings' | 'replay' | 'hurry'> & Partial<Pick<UIStore, 'catchUp' | 'introSkip'>>) =>
  Math.max(0.25, s.settings.animationSpeed * (s.replay ? (s.replay.ff ? 6 : s.replay.speed) : 1) * (s.hurry ? 3 : 1) * (s.catchUp ? 4 : 1) * (s.introSkip ? INTRO_RUSH : 1));

export const animSpeed = () => speedOf(useUI.getState());

/** The speed for the world's animator: held at 0 while a quality change is being prepared. */
export const animatorSpeed = () => (useUI.getState().qualityProgress || useUI.getState().paused ? 0 : animSpeed());
