import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { SPRING_MORPH, SPRING_PANEL } from './motion';
import { showError, useUI } from '../game/store';
import { session, type NewGameConfig } from '../app/session';
import { ActionBar, Banners, ErrorBar, HandArea, HintBar, PausedPill, PlayerPanels, ResetViewButton, TopRight } from './Hud';
import { CompactActions, CompactBar, CompactStatus, HandChips, PlaceConfirm, PlayerChips } from './Compact';
import { isTouch, useCompact } from './useCompact';
import { FlatBoard, ViewToggle } from './FlatBoard';
import { DiceOverlay, RollIndicator } from './Dice';
import { FlightLayer } from './Flights';
import { IncomingOffer, Modals, OutgoingOffer, ResultsReturn, preloadDialogs } from './Modals';
import { warmCards, warmIcons } from './artWarm';
import { TurnAura } from './TurnAura';
import { IslandText, TileTooltip } from './Tooltip';
import { HintTip } from './HintTip';
import { ModuleControls } from './ModuleControls';
import { DecisionStack, LedgerButton, LedgerSheet, ModuleDecisions, ModuleNews } from './modules/Ledger';
import { PickBar } from './modules/PickBar';
import { AlmanacChip } from './modules/Almanac';
import { PLAYER_PALETTE, PRESET_COLORS } from '../render/board/pieces';
import { AVATAR_CHOICES, AvatarFace, SailingAs } from './Avatar';
import type { PlayerColor } from '../engine';
import type { RoomSettings } from '../net/protocol';
import { DIFFICULTY_BLURBS } from '../engine/ai/profiles';
import { MAP_INFO } from '../engine/maps';
import { EXPANSIONS, PRESETS, expansionsOf, mixOf, poolFor, targetFor, type Expansion, type Grade } from '../engine/presets';
import { sfx } from '../audio/sfx';
import { ErrorBoundary } from './ErrorBoundary';
import { PerfOverlay } from './PerfOverlay';
import { ChatPanel } from './Chat';
import { QualityToast } from './QualityToast';
import { SaveUnusable, clearLastGame, clearSave, loadSave, watchSave } from '../game/save';
import { ExpansionsUnavailable, loadExpansions } from '../render/loadExpansions';
import { SailFill, SailLabel } from './Sail';
import { arrival } from '../app/links';
import { Filled, LineIcon } from './LineIcons';
import { Morph } from './Morph';
import { LiveRegions } from './Live';
import { preparePaper } from './paper';
import { useEditor } from './editor/store';
import { MapThumb, type ThumbMap } from './editor/MapThumb';
import { getMap, listMaps, type StoredMap } from '../game/customMaps';
import { lastRules } from './rules/where';
import { checkCustomMap, customSpec } from '../engine/maps/custom';
import { MAX_VICTORY_POINTS, MIN_VICTORY_POINTS, buildBoard, createGame, dealBoard, withBoard } from '../engine';

// (The editor and its 3D draft are a chunk of their own: fetched once the title is up and the page
// has a moment, so opening the editor seldom waits on the network. A failed fetch is tried again.)
let editorChunk: Promise<{ default: typeof import('./editor/MapEditor').MapEditor }> | null = null;
/** The editor, once its chunk is in: drawn straight away (lazy would suspend once all the same, and React holds a revealed fallback back a few hundred ms). */
let LoadedEditor: typeof import('./editor/MapEditor').MapEditor | null = null;
const loadEditor = () =>
  (editorChunk ??= import('./editor/MapEditor').then(
    (m) => ((LoadedEditor = m.MapEditor), { default: m.MapEditor }),
    (e) => {
      // (A fresh lazy too: one that failed keeps failing, and the next opening should try again.)
      editorChunk = null;
      MapEditor = lazy(loadEditor);
      throw e;
    },
  ));
let MapEditor = lazy(loadEditor);
// (Online play is a chunk of its own, the Multiplayer page, the harbour and the table's overlays:
// a solo player never loads it.)
const loadMulti = () => import('./online/MultiplayerPage');
const MultiplayerPage = lazy(loadMulti);
/** Leaning towards Multiplayer (its card under the mouse, focused or pressed): its page and the
 *  harbour's answer are fetched then, so the card grows straight into a page that's there. */
const warmMulti = () => void loadMulti().then((m) => m.warm(), () => {});
const ProfilePage = lazy(() => import('./online/ProfilePage'));
const Harbour = lazy(() => import('./online/Harbour'));
const OnlineHud = lazy(() => import('./online/Overlays'));

const SHOW_PERF = new URLSearchParams(location.search).has('perf');

/**
 * The dock's height on the layer (--dock-h), so the table talk above it stops short of it, and the
 * right column's top (--top-h: the toolbar, the supply and the log), so a tall expansion panel in
 * the dock scrolls inside it rather than running up over the log.
 */
function useDockHeight(layer: React.RefObject<HTMLDivElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const el = layer.current;
    const dock = el?.querySelector<HTMLElement>('.dock');
    const top = el?.querySelector<HTMLElement>('.topright');
    if (!el || !dock) return;
    // (Written on the next frame, and only when they change: the heights resize panels the
    // observer watches, and written straight away that is a resize loop the browser reports.)
    let raf = 0;
    const write = () => {
      raf = 0;
      const d = `${dock.offsetHeight}px`, t = top ? `${top.offsetHeight}px` : '';
      if (el.style.getPropertyValue('--dock-h') !== d) el.style.setProperty('--dock-h', d);
      if (top && el.style.getPropertyValue('--top-h') !== t) el.style.setProperty('--top-h', t);
    };
    write();
    const ro = new ResizeObserver(() => {
      raf ||= requestAnimationFrame(write);
    });
    ro.observe(dock);
    if (top) ro.observe(top);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [on]);
}

/**
 * A dialog that couldn't draw (its code failed to load, or it threw): it closes, saying so, rather
 * than leaving the HUD inert under nothing. One the game is waiting on opens again (see presenter).
 */
function dialogFailed() {
  useUI.getState().set({ modal: null });
  showError("That couldn't open. If it keeps happening, reload the page: your game is saved.", 6000);
}

/**
 * While the editor's chunk is still on its way (opened before the page had a moment to fetch it):
 * a word that it's coming, after a beat, so a quick load shows nothing at all.
 */
function EditorLoading() {
  return (
    <div className="editor-loading" role="status">
      <span className="editor-loading-card parchment">
        Unrolling the chart…
        <i aria-hidden />
      </span>
    </div>
  );
}

/** Another tab took over the saved game this one is playing: the game goes on here, unsaved, until you play here again. */
function SaveAway() {
  const away = useUI((s) => s.saveAway && s.screen === 'game');
  if (!away) return null;
  return (
    <div className="errorbar" role="status" style={{ pointerEvents: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
      <span>This game is open in another tab</span>
      <button type="button" className="btn gold small" onClick={() => session.reclaimSave()}>
        Play here
      </button>
    </div>
  );
}

export function App() {
  const screen = useUI((s) => s.screen);
  const ready = useUI((s) => s.worldReady);
  // What is behind a dialog is inert whenever one is open (driven by the store, so switching from
  // one dialog to another never leaves it clickable in between).
  const modalOpen = useUI((s) => s.modal !== null);
  const compact = useCompact();
  const glass = useUI((s) => s.settings.look === 'glass');
  const hudHeld = useUI((s) => s.hudHeld);
  const layer = useRef<HTMLDivElement>(null);
  // (The right column's top renders once there's a game to show.)
  const hasView = useUI((s) => s.view !== null);
  const online = useUI((s) => s.online !== null);
  useDockHeight(layer, screen === 'game' && !compact && hasView);
  useEffect(preparePaper, []);
  // A test game started from the map editor goes back to it when it's left.
  useEffect(() => {
    if (screen !== 'title' || !useEditor.getState().returnHere) return;
    useEditor.setState({ returnHere: false });
    useUI.getState().set({ screen: 'editor' });
  }, [screen]);
  // Once the island is up and the page has a moment, the dialogs that load on demand are fetched.
  useEffect(() => {
    if (!ready) return;
    const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1500));
    idle(() => {
      preloadDialogs();
      warmIcons();
      loadEditor().catch(() => {});
    });
  }, [ready]);
  // (The cards' paintings once a game is on, before the first one is drawn or flies.)
  useEffect(() => {
    if (screen === 'game') warmCards();
  }, [screen]);
  return (
    <>
      {/* Every control's hover hint, on any screen. */}
      <HintTip />
      {/* (The loading screen, and the motion and contrast settings, are the shell's: see main.tsx.)
          The title and the editor cross: the editor starts the moment it's asked for, its sea
          rising over the title as that fades, rather than after it. */}
      <AnimatePresence>
        {ready && screen === 'title' && (
          <ErrorBoundary key="title" name="title">
            <TitleScreen />
          </ErrorBoundary>
        )}
        {ready && screen === 'editor' && (
          <ErrorBoundary key="editor" name="editor">
            {LoadedEditor ? (
              <LoadedEditor />
            ) : (
              <Suspense fallback={<EditorLoading />}>
                <MapEditor />
              </Suspense>
            )}
          </ErrorBoundary>
        )}
        {ready && screen === 'harbour' && (
          <ErrorBoundary key="harbour" name="harbour">
            <Suspense fallback={null}>
              <Harbour />
            </Suspense>
          </ErrorBoundary>
        )}
      </AnimatePresence>
      {/* An online table's own overlays: the link, the clock, the room's notices. (On a phone they
          stand in the status column under the hint, see below, not over it.) */}
      {screen === 'game' && online && !compact && (
        <ErrorBoundary name="online">
          <Suspense fallback={null}>
            <OnlineHud />
          </Suspense>
        </ErrorBoundary>
      )}
      {/* Before the HUD, so a seven's shade at the edges stays under its panels (the total is lifted above them). */}
      <ErrorBoundary name="dice"><DiceOverlay /></ErrorBoundary>
      {/* The flat 2D map, over the 3D view and under the HUD (see app/viewMode.ts); inert under a
          dialog like the HUD, so Tab can't wander onto its tiles. */}
      {screen === 'game' && (
        <div className="flat-wrap" inert={modalOpen}>
          <ErrorBoundary name="flat"><FlatBoard /></ErrorBoundary>
        </div>
      )}
      {screen === 'game' && !compact && (
        <div className="ui-layer" inert={modalOpen} ref={layer} data-held={hudHeld || undefined}>
          <TurnAura />
          <ErrorBoundary name="players"><PlayerPanels /></ErrorBoundary>
          <ErrorBoundary name="topright"><TopRight /></ErrorBoundary>
          {/* The prompt and the roll: placed apart in the parchment look; one status bar in Sea Glass (styles/glass.css). */}
          <div className="status-bar" data-hud-obstacle="status">
            <ErrorBoundary name="hint"><HintBar /></ErrorBoundary>
            <ErrorBoundary name="roll"><RollIndicator /></ErrorBoundary>
          </div>
          {/* (Online the table's pause stands in the online overlays' column, see Overlays.tsx.) */}
          {!online && <ErrorBoundary name="paused"><PausedPill /></ErrorBoundary>}
          <ErrorBoundary name="almanac"><AlmanacChip /></ErrorBoundary>
          <ErrorBoundary name="chat"><ChatPanel /></ErrorBoundary>
          <ErrorBoundary name="hand"><HandArea /></ErrorBoundary>
          <div className="dock" data-hud-obstacle="dock">
            <ErrorBoundary name="offer"><IncomingOffer /></ErrorBoundary>
            <ErrorBoundary name="my-offer"><OutgoingOffer /></ErrorBoundary>
            {/* The decisions and the expansions' moves scroll as one when the room is short, so the turn's buttons below stay in reach. */}
            <DecisionStack>
              <ModuleDecisions />
              <ErrorBoundary name="modules"><ModuleControls /></ErrorBoundary>
            </DecisionStack>
            <ModuleNews />
            <ErrorBoundary name="actions"><ActionBar /></ErrorBoundary>
          </div>
          <ErrorBoundary name="banners"><Banners /></ErrorBoundary>
          <ErrorBoundary name="tooltip"><TileTooltip /></ErrorBoundary>
          <ErrorBoundary name="island"><IslandText /></ErrorBoundary>
          <ErrorBoundary name="results"><ResultsReturn /></ErrorBoundary>
          {/* (A tablet has the full HUD but places by touch, tap then confirm: its confirm too.) */}
          <ErrorBoundary name="confirm"><PlaceConfirm /></ErrorBoundary>
        </div>
      )}
      {/* Phones: a slim top bar, the board, one dock at the bottom (see Compact.tsx). */}
      {screen === 'game' && compact && (
        <div className="ui-layer compact" inert={modalOpen} data-held={hudHeld || undefined}>
          <TurnAura />
          <ErrorBoundary name="players"><PlayerChips /></ErrorBoundary>
          <ErrorBoundary name="bar"><CompactBar /></ErrorBoundary>
          <ErrorBoundary name="hint">
            <CompactStatus>
              {/* (Sea Glass: the prompt and the roll in one bar, as on the full screen; otherwise the roll stands by the dock.) */}
              {glass ? (
                <div className="status-bar" data-hud-obstacle="status">
                  <HintBar />
                  <ErrorBoundary name="roll"><RollIndicator /></ErrorBoundary>
                </div>
              ) : (
                <HintBar />
              )}
              {online && (
                <ErrorBoundary name="online">
                  <Suspense fallback={null}>
                    <OnlineHud inline />
                  </Suspense>
                </ErrorBoundary>
              )}
            </CompactStatus>
          </ErrorBoundary>
          <ErrorBoundary name="chat"><ChatPanel /></ErrorBoundary>
          {/* (Online the table's pause stands in the online overlays' column, see Overlays.tsx.) */}
          {!online && <ErrorBoundary name="paused"><PausedPill /></ErrorBoundary>}
          <div className="cdock">
            <div className="cdock-float left" data-hud-obstacle="float-l">
              {!glass && <ErrorBoundary name="roll"><RollIndicator /></ErrorBoundary>}
              <ErrorBoundary name="almanac"><AlmanacChip compact /></ErrorBoundary>
            </div>
            <div className="cdock-float right" data-hud-obstacle="float-r">
              <CompactReset />
              <ErrorBoundary name="ledger-button"><LedgerButton /></ErrorBoundary>
              <ViewToggle />
            </div>
            <ErrorBoundary name="offer"><IncomingOffer /></ErrorBoundary>
            <ErrorBoundary name="my-offer"><OutgoingOffer /></ErrorBoundary>
            <ErrorBoundary name="ledger"><LedgerSheet /></ErrorBoundary>
            <ErrorBoundary name="pickbar"><PickBar /></ErrorBoundary>
            {/* The decisions and the expansions' moves scroll as one, so the hand and the turn's buttons below stay in reach. */}
            <DecisionStack>
              <ModuleDecisions />
              <ErrorBoundary name="modules"><ModuleControls /></ErrorBoundary>
            </DecisionStack>
            <ModuleNews />
            <div className="cdock-panel parchment" data-hud-obstacle="cdock">
              <ErrorBoundary name="hand"><HandChips /></ErrorBoundary>
              <ErrorBoundary name="actions"><CompactDockActions /></ErrorBoundary>
            </div>
          </div>
          <ErrorBoundary name="banners"><Banners /></ErrorBoundary>
          <ErrorBoundary name="tooltip"><TileTooltip /></ErrorBoundary>
          <ErrorBoundary name="island"><IslandText /></ErrorBoundary>
          <ErrorBoundary name="confirm"><PlaceConfirm /></ErrorBoundary>
          <ErrorBoundary name="results"><ResultsReturn /></ErrorBoundary>
        </div>
      )}
      <ErrorBoundary name="flights"><FlightLayer /></ErrorBoundary>
      <ErrorBoundary name="quality"><QualityToast /></ErrorBoundary>
      {/* (On the title too: a game that couldn't start says why.) */}
      <ErrorBoundary name="error"><ErrorBar /></ErrorBoundary>
      <ErrorBoundary name="saveaway"><SaveAway /></ErrorBoundary>
      <ErrorBoundary name="modals" onFail={dialogFailed}><Modals /></ErrorBoundary>
      {/* Outside everything a dialog makes inert, so what happens is still read out. */}
      <ErrorBoundary name="live"><LiveRegions /></ErrorBoundary>
      {SHOW_PERF && <PerfOverlay />}
    </>
  );
}

/** The view's reset button, shown only once the camera has wandered from home. */
function CompactReset() {
  const off = useUI((s) => s.cameraOffHome);
  return (
    <AnimatePresence initial={false}>
      {off && (
        <motion.div key="reset" initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }} transition={{ type: 'spring', duration: 0.3, bounce: 0 }}>
          <ResetViewButton />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The replay's controls in place of the turn's buttons while a finished game is watched back. */
function CompactDockActions() {
  const replay = useUI((s) => s.replay !== null);
  return replay ? <ActionBar /> : <CompactActions />;
}

function ago(ms: number) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** The title's choices, remembered for next time. */
interface Setup {
  color: PlayerColor;
  avatar: number;
  opponents: 2 | 3;
  difficulty: NewGameConfig['difficulty'];
  layout: NewGameConfig['layout'];
  numbers: NewGameConfig['numberPlacement'];
  /** Points to win, as a step from the suggested target (10 in the base game, more with expansions). */
  shift: number;
  robber: 'standard' | 'friendly';
  /** Dice, or the event deck of all 36 rolls. */
  rolls: 'dice' | 'deck';
  /** The expansions in play (none: the base game). */
  expansions: Expansion[];
  /** The map chosen from the mix's pool ('' for none: the mix's flagship, as when the chosen one isn't in its pool). */
  map: string;
  /** A map from the editor's library to play on instead (its id), when no preset fixes one. */
  customMap: string | null;
}

/** How far the points to win may be set from the suggested target (any target from 3 to 30). */
const MAX_SHIFT = MAX_VICTORY_POINTS - MIN_VICTORY_POINTS;
const okShift = (x: unknown): x is number => Number.isInteger(x) && Math.abs(x as number) <= MAX_SHIFT;

/** The beginner set-up's place in the set-up page's map strip (the classic island, laid out the same every game). */
const BEGINNER = 'beginner';

const DEFAULT_SETUP: Setup = { color: 'red', avatar: -1, opponents: 3, difficulty: 'normal', layout: 'random', numbers: 'spiral', shift: 0, robber: 'standard', rolls: 'dice', expansions: [], map: '', customMap: null };

/** How each grade of mix is named on the set-up page, and what it means (docs/expansions.md, Compatibility). */
const GRADES: Record<Grade, { label: string; tip: string }> = {
  settled: { label: 'Settled', tip: 'Every rule where these expansions meet has been played and settled' },
  derived: { label: 'Derived', tip: 'Where these expansions meet, the rules follow from settled ones' },
  speculative: { label: 'Speculative', tip: 'Where these expansions meet, the rules are our own and still being tuned' },
};

function loadSetup(): Setup {
  try {
    const v = JSON.parse(localStorage.getItem('exploratory.setup') ?? 'null') as Partial<Setup> | null;
    if (!v || typeof v !== 'object') return DEFAULT_SETUP;
    const pick = <K extends keyof Setup>(k: K, ok: (x: unknown) => boolean) => (ok(v[k]) ? (v[k] as Setup[K]) : DEFAULT_SETUP[k]);
    const legacy = v as { points?: number };
    return {
      color: pick('color', (x) => typeof x === 'string' && (PRESET_COLORS.some((c) => c.id === x) || /^#[0-9a-f]{6}$/i.test(x))),
      avatar: pick('avatar', (x) => AVATAR_CHOICES.includes(x as number)),
      opponents: pick('opponents', (x) => x === 2 || x === 3),
      difficulty: pick('difficulty', (x) => x === 'easy' || x === 'normal' || x === 'hard'),
      layout: pick('layout', (x) => x === 'random' || x === 'beginner'),
      numbers: pick('numbers', (x) => x === 'spiral' || x === 'balanced'),
      // (Set-ups kept before the expansions held the points themselves: 8 to 14 is a step from 10.)
      shift: okShift(v.shift) ? v.shift : okShift((legacy.points ?? NaN) - 10) ? legacy.points! - 10 : 0,
      robber: pick('robber', (x) => x === 'standard' || x === 'friendly'),
      rolls: pick('rolls', (x) => x === 'dice' || x === 'deck'),
      expansions: pick('expansions', (x) => Array.isArray(x) && x.every((e) => EXPANSIONS.some((d) => d.id === e))),
      map: pick('map', (x) => x === '' || (typeof x === 'string' && x in MAP_INFO)),
      customMap: pick('customMap', (x) => typeof x === 'string' && listMaps().some((m) => m.id === x)),
    };
  } catch {
    return DEFAULT_SETUP;
  }
}

type MenuView = 'main' | 'solo' | 'multi' | 'profile';
type MultiWay = 'choose' | 'host' | 'join';

/** The menu's marks, from the same set as the settings' (see LineIcons.tsx). */
const ICONS = {
  continue: <LineIcon name="ship" size={22} />,
  solo: <LineIcon name="compass" size={22} />,
  multi: <LineIcon name="crew" size={22} />,
  settings: <LineIcon name="gear" size={22} />,
  rules: <LineIcon name="book" size={22} />,
  // (Sea Glass draws it filled, as it does the others.)
  editor: (
    <Filled name="mapEditor" size={22}>
      <svg className="line-icon" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3 19.8 7.5v9L12 21l-7.8-4.5v-9z" />
        <path d="m9.5 14.5 5-5 1.5 1.5-5 5H9.5z" />
      </svg>
    </Filled>
  ),
  back: <LineIcon name="back" size={18} />,
};

interface MenuItem {
  id: string;
  label: string;
  note: string;
  icon: React.ReactNode;
  badge?: string;
  primary?: boolean;
  /** Settings and the rules: a smaller card, two to a row, apart from the ways to play. */
  small?: boolean;
  onSelect: () => void;
  /** Its page's code is fetched as you lean towards the card, before the click. */
  onIntent?: () => void;
}

/** How a card grows into its page and back, and the menu's cards coming in (see motion.ts). */
const MORPH = SPRING_MORPH;
const ENTER = SPRING_PANEL;

/**
 * The main menu: the logo on a plaque over a card for each place to go, parchment panels like
 * the players' in the game. Whichever card is under the mouse or the keyboard's focus (the
 * arrow keys move it) rings in your colour, as the player whose turn it is does. On a touch
 * screen none is lit until it's pressed: there's no pointer or focus for a highlight to follow.
 * A card that opens a page grows into it, and the page shrinks back into its card; while a
 * voyage is being set up, the card that started it fills as it goes.
 */
function MainMenu({ items, busy, first, from, replay }: { items: MenuItem[]; busy: string | null; first: boolean; from: string | null; replay?: () => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = (id: string | null) => items.findIndex((it) => it.id === id);
  const touch = isTouch();
  const glass = useUI((s) => s.settings.look === 'glass');
  const [active, setActive] = useState(() => (touch ? -1 : Math.max(0, from ? index(from) : items.findIndex((it) => it.primary))));
  // Back from a page: its card takes the keyboard's focus again (not on a touch screen, where it
  // would only light the card).
  useEffect(() => {
    if (from && !touch) refs.current[index(from)]?.focus({ preventScroll: true });
  }, []);
  const onKey = (e: React.KeyboardEvent | KeyboardEvent) => {
    const n = items.length;
    const next = ['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 0;
    // (With none lit yet, on a touch screen with a keyboard, the arrows start at either end.)
    const to = next ? (active < 0 ? (next > 0 ? 0 : n - 1) : (active + next + n) % n) : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    refs.current[to]?.focus();
  };
  // The foot says the arrows choose, and they do from the start: with nothing focused yet (the page
  // just opened, or a click elsewhere let go of the focus) they move on from the lit card too.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || useUI.getState().modal) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      onKey(e);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [active]);
  const delay = first ? 0.8 : 0.06;
  // The rest slide in after the plaque, one by one (the card coming back from a page is
  // already there: it is the page, shrinking).
  const enter = (i: number) => ({ ...ENTER, delay: delay + 0.06 + i * 0.045 });
  return (
    <nav className="menu" aria-label="Main menu">
      <motion.div className="menu-plaque parchment" initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0, transition: { ...ENTER, delay } }} exit={{ opacity: 0, x: -16, transition: { duration: 0.2 } }}>
        <h1 className="logo">Hexplorers</h1>
        <p className="menu-tagline">Sail · trade · prosper</p>
      </motion.div>
      <ul className="menu-cards" onKeyDown={onKey}>
        {items.map((it, i) => (
          // (The row moves and its card fades: a fade on the row, the card's ancestor, blinds the
          // card's backdrop-filter, and it would slide in as clear glass, frosting only once it had arrived.)
          <motion.li
            key={it.id}
            className={it.small ? 'small' : undefined}
            initial={it.id === from ? false : { x: -24 }}
            animate={{ x: 0, transition: enter(i) }}
            // Leaving for a page, the chosen card stays (it becomes the page); the rest step aside.
            exit="gone"
            variants={{ gone: (to: string) => (to === it.id ? { transition: { duration: 0.3 } } : { x: -16, transition: { duration: 0.2 } }) }}
          >
            <motion.button
              initial={it.id === from ? false : { opacity: 0 }}
              animate={{ opacity: 1, transition: enter(i) }}
              exit="gone"
              variants={{ gone: (to: string) => (to === it.id ? { opacity: 1, transition: { duration: 0.3 } } : { opacity: 0, transition: { duration: 0.2 } }) }}
              ref={(el) => {
                refs.current[i] = el;
              }}
              layoutId={`card-${it.id}`}
              // Only a change of page moves the cards (the highlight is CSS). The card and its page
              // need different values here, or motion takes them for the same layout and skips the move.
              layoutDependency="card"
              transition={MORPH}
              // (Sea Glass cards are pills, the small ones too, each seal concentric with its end.)
              style={{ borderRadius: glass ? 999 : 14 }}
              className={`menu-card parchment${it.primary ? ' primary' : ''}${it.small ? ' small' : ''}${i === active ? ' active' : ''}`}
              aria-disabled={busy !== null}
              // A touch lights its card as it presses it (below), so the tap goes straight through
              // rather than first moving the highlight.
              onPointerEnter={(e) => (it.onIntent?.(), e.pointerType === 'mouse' && setActive(i))}
              onPointerDown={it.onIntent}
              onFocus={() => (it.onIntent?.(), setActive(i))}
              onClick={() => {
                if (busy) return;
                sfx.unlock();
                sfx.play('click');
                setActive(i);
                it.onSelect();
              }}
            >
              {busy === it.id && <SailFill wash />}
              <motion.span className="card-body" layout layoutDependency={0} transition={MORPH}>
                <span className="menu-seal">{it.icon}</span>
                <span className="menu-text">
                  <span className="menu-label">
                    {busy === it.id ? <SailLabel /> : it.label}
                    {it.badge && <span className="menu-badge">{it.badge}</span>}
                  </span>
                  {!it.small && <span className="menu-note">{it.note}</span>}
                </span>
                {!it.small && (
                  <span className="menu-chevron" aria-hidden>
                    <LineIcon name="next" size={18} />
                  </span>
                )}
              </motion.span>
            </motion.button>
          </motion.li>
        ))}
      </ul>
      <motion.div className="menu-foot" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: delay + 0.35, duration: 0.3 } }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
        {replay ? (
          <button className="link-btn" onClick={replay} disabled={busy !== null}>
            <LineIcon name="play" size={16} />
            Watch your last game
          </button>
        ) : (
          <span>Saved on this device as you play</span>
        )}
        <span className="menu-foot-end">
          <button
            className="link-btn"
            onClick={() => {
              lastRules.tab = 'about';
              lastRules.page = 'contents';
              useUI.getState().set({ modal: 'rules' });
            }}
            disabled={busy !== null}
          >
            <LineIcon name="info" size={16} />
            About
          </button>
          <span className="menu-keys" aria-hidden>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to choose
          </span>
        </span>
      </motion.div>
    </nav>
  );
}

/**
 * A page of the menu (Singleplayer, Multiplayer), grown out of its card: the card's mark and
 * title stay at its head, after the way back, and the rest fades in as it opens.
 */
function MenuPage({ id, grown, title, icon, onBack, back: backTo = 'Menu', children, className = '' }: { id: string; grown: boolean; title: string; icon: React.ReactNode; onBack: () => void; /** Where the way back goes, as its label (the menu, or the page this one was opened from). */ back?: string; children: React.ReactNode; className?: string }) {
  const back = useRef<HTMLButtonElement>(null);
  const compact = useCompact();
  const glass = useUI((s) => s.settings.look === 'glass');
  // (Focus lands on the way back once, as the page opens: not again each time the way changes,
  // as it does between Multiplayer's steps, where the step itself says where focus goes.)
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !useUI.getState().modal && latest.current();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  return (
    <motion.section
      layoutId={`card-${id}`}
      layoutDependency="page"
      transition={MORPH}
      style={{ borderRadius: compact ? 0 : glass ? 24 : 14 }}
      className={`title-card parchment menu-page ${className}`}
      aria-label={title}
      // From one page to another there is no card to grow from: it slides in, the other out.
      initial={grown ? false : { opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0, transition: ENTER }}
      exit="leave"
      variants={{ leave: (to: MenuView) => (to === 'main' ? { opacity: 1 } : { opacity: 0, x: -16, transition: { duration: 0.2 } }) }}
    >
      <motion.div
        className="page-body"
        layout
        layoutDependency={0}
        transition={MORPH}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.25 } }}
        exit={{ opacity: 0, transition: { duration: 0.1 } }}
      >
        {/* (The way back leads the head, at its top left, where every page keeps it.) */}
        <div className="page-head">
          <button ref={back} className="back-btn" onClick={onBack}>
            {ICONS.back}
            <Morph>{backTo}</Morph>
          </button>
          <span className="menu-seal">{icon}</span>
          <h2>
            <Morph>{title}</Morph>
          </h2>
        </div>
        {children}
      </motion.div>
    </motion.section>
  );
}

function TitleScreen() {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('exploratory.name') ?? 'You';
    } catch {
      return 'You';
    }
  });
  const [setup, setSetup] = useState(() => {
    // (Play this map, from the editor: the set-up page opens with it chosen, to its target.)
    const s = loadSetup();
    const asked = useEditor.getState().playMap;
    return asked && getMap(asked.id) ? { ...s, customMap: asked.id, expansions: expansionsOf(asked.modules), opponents: (asked.players - 1) as 2 | 3 } : s;
  });
  const { color, avatar, opponents, difficulty, layout, numbers, shift, robber, rolls, expansions, map: picked, customMap } = setup;
  const mix = mixOf(expansions, picked);
  // The editor's maps, kept fresh as the library changes.
  const [library, setLibrary] = useState<StoredMap[]>(listMaps);
  useEffect(() => {
    const on = () => setLibrary(listMaps());
    window.addEventListener('exploratory-maps', on);
    return () => window.removeEventListener('exploratory-maps', on);
  }, []);
  // A custom map plays when one is chosen and no preset fixes its own map.
  const stored = customMap && !mix.preset?.map ? (library.find((m) => m.id === customMap) ?? null) : null;
  const custom = stored?.map ?? null;
  const players = opponents + 1;
  // The maps the mix can be played on, each with a glimpse of one deal of it (every game deals its own).
  const pool = poolFor(expansions);
  const glimpses = useMemo(() => {
    const out: Record<string, ThumbMap> = {};
    for (const id of expansions.length ? pool : [...pool, BEGINNER]) {
      try {
        const spec = dealBoard(players, { modules: mix.modules, map: id, knobs: mix.knobs, seed: 1, ...(id === BEGINNER ? { map: 'classic', layout: 'beginner' } : {}) });
        const fog = new Set((spec.objectives ?? []).flatMap((o) => (o.id === 'fog' ? (o.hexes ?? []) : [])).map(([q, r]) => `${q},${r}`));
        out[id] = { hexes: spec.hexes.map((h) => ({ q: h.q, r: h.r, terrain: h.terrain, hidden: fog.has(`${h.q},${h.r}`) })) };
      } catch {
        /* no glimpse: the button still reads */
      }
    }
    return out;
  }, [pool.join(), players, mix.modules.join()]);
  // The expansions' own points beyond the map's (rule 9), on a custom map over what it supports.
  // (A custom map of several islands plays as a sea map would with Sea Lanes, First Landing's points and all.)
  const islands = useMemo(() => {
    try {
      return custom ? buildBoard(customSpec(custom)).islands.length : 0;
    } catch {
      return 0;
    }
  }, [custom]);
  const extra = mix.preset?.target ? mix.target - (MAP_INFO[mix.map]?.target ?? 10) : targetFor(expansions, islands > 1 && expansions.includes('sea') ? 'archipelago' : 'classic') - 10;
  const mapCheck = useMemo(() => (custom ? checkCustomMap(custom, { players, victoryPoints: 10 }) : null), [custom, players]);
  const suggested = custom ? (mapCheck?.figures?.suggested ?? 10) + extra : mix.target;
  // (Guilds and Invasion build a city in the set-up, so everyone opens on 3 points: a target of 3 would be won before a roll.)
  const fewest = mix.modules.some((m) => m === 'guilds' || m === 'invasion') ? MIN_VICTORY_POINTS + 1 : MIN_VICTORY_POINTS;
  const points = Math.max(fewest, Math.min(MAX_VICTORY_POINTS, suggested + shift));
  const check = useMemo(
    () =>
      custom
        ? checkCustomMap(custom, {
            players,
            victoryPoints: points,
            modules: mix.modules,
            extra,
            tryGame: (seed) => void createGame(Array.from({ length: players }, (_, i) => ({ name: `P${i}`, color: '', isBot: true })), withBoard(players, { map: 'custom', custom, modules: mix.modules, knobs: mix.knobs, seed })),
          })
        : null,
    [custom, players, points, mix.modules.join(), extra],
  );
  const playable = custom ? check!.errors.length === 0 : mix.playable;
  useEffect(() => {
    const asked = useEditor.getState().playMap;
    if (!asked) return;
    useEditor.setState({ playMap: null });
    if (!getMap(asked.id)) {
      showError('That map isn’t among your maps any more: save it in the editor to play it', 5000);
      return;
    }
    choose({ shift: asked.points - ((checkCustomMap(getMap(asked.id)!.map, { players, victoryPoints: 10 }).figures?.suggested ?? 10) + extra) });
    setView('solo');
  }, []);
  const almanac = expansions.includes('almanac');
  const choose = (p: Partial<Setup>) => setSetup((s) => ({ ...s, ...p }));
  const setColor = (c: PlayerColor) => choose({ color: c });
  const setOpponents = (opponents: 2 | 3) => choose({ opponents });
  const setDifficulty = (difficulty: Setup['difficulty']) => choose({ difficulty });
  const setNumbers = (numbers: Setup['numbers']) => choose({ numbers });
  const setShift = (shift: number) => choose({ shift });
  const toggle = (e: Expansion) => choose({ expansions: expansions.includes(e) ? expansions.filter((x) => x !== e) : [...expansions, e] });
  const setRobber = (robber: Setup['robber']) => choose({ robber });
  const setRolls = (rolls: Setup['rolls']) => choose({ rolls });
  // Where the menu is, and where it was: a page grows out of its card only when opened from
  // the menu, and the menu gives the focus back to the card of the page it came from.
  // (Opened from a room's link, the menu starts on the multiplayer page, which says what became of it.)
  const [{ view, from }, go] = useState<{ view: MenuView; from: MenuView }>(() => (arrival.room && !roomShown ? ((roomShown = true), { view: 'multi', from: 'multi' }) : { view: 'main', from: 'main' }));
  const setView = (to: MenuView) => go((s) => ({ view: to, from: s.view }));
  // Multiplayer's step: its two ways aboard, or one of them chosen (kept while Profile is open
  // from it, so its way back returns to the same step).
  const [way, setWay] = useState<MultiWay>('choose');
  // Which way in started a game ('continue', 'solo' or 'replay'), while it is being set up.
  const [starting, setStarting] = useState<string | null>(null);
  const set = useUI((s) => s.set);
  const modalOpen = useUI((s) => s.modal !== null);
  const present = useIsPresent();
  // (State, so the Continue card follows what is really saved after a start that failed.)
  const [save, setSave] = useState(() => loadSave());
  // (Another tab can continue, replace or clear the one solo save: the card follows what is really kept.)
  useEffect(() => watchSave(() => setSave(loadSave())), []);
  // The expansions' render code is a chunk of its own: fetch it while the title is up whenever the
  // game that would start (the mix chosen, or the save to continue) has modules, so the island
  // doesn't wait for it.
  const wantsExpansions = mix.modules.length > 0 || (save?.cfg.modules?.length ?? 0) > 0;
  useEffect(() => {
    // (A failed warm-up is no news: the game's own start asks again, and says so if it fails.)
    if (wantsExpansions) loadExpansions().catch(() => {});
  }, [wantsExpansions]);
  // The menu's first showing waits for the loading chart's dive to clear; later ones don't.
  const [first] = useState(() => !shownMenu);
  useEffect(() => {
    shownMenu = true;
  }, []);
  const toMain = useCallback(() => go((s) => ({ view: 'main', from: s.view })), []);
  // A page a link asked for (an installed app's shortcut, ?go=/new or /multi): opened as the
  // title comes up, the set-up with the link's mix chosen.
  const asked = useUI((s) => s.goPage);
  useEffect(() => {
    if (!asked) return;
    set({ goPage: null });
    const mix = asked.mix?.filter((e): e is Expansion => EXPANSIONS.some((x) => x.id === e));
    if (mix?.length) choose({ expansions: mix });
    if (asked.page === 'multi') setWay('choose');
    setView(asked.page);
  }, [asked]);
  // If a start fails, return to the title rather than leaving the buttons stuck on "Setting
  // sail…", and let go of only what failed: a save that couldn't be resumed is dropped, but a new
  // game or a replay that failed leaves your saved game alone (a replay that failed is just not
  // offered again this visit). The expansions' render code failing to load is the connection's
  // fault, not the save's or the replay's: both are kept, and the reason is shown.
  const launch = async (how: 'continue' | 'solo' | 'replay', run: () => Promise<void>) => {
    setStarting(how);
    sfx.unlock();
    try {
      await run();
    } catch (e) {
      console.error('could not start the game', e);
      // (Only a record this version can't play back is let go: not a chunk that failed to load,
      // a release deployed meanwhile or a render error, none of which is the record's fault.)
      const offline = e instanceof ExpansionsUnavailable;
      const unusable = e instanceof SaveUnusable;
      if (how === 'continue' && unusable) clearSave();
      if (how === 'replay' && unusable) {
        session.lastGame = null;
        clearLastGame();
      }
      session.end();
      useUI.getState().set({ screen: 'title', view: null, modal: null });
      // (Never silently: the button only going back to Set sail reads as nothing having happened.
      // A part of the game that won't load is most often a release deployed since the page opened.)
      const stale = !offline && /dynamically imported module|module script failed|Loading chunk/i.test(String((e as Error)?.message ?? e));
      if (offline) showError('The expansions couldn’t be loaded: check your connection and try again', 6000);
      else if (stale) showError('A new version is out: reload the page to set sail', 8000);
      else if (how === 'continue' && unusable) showError('That saved game can’t be resumed with this version, so it was cleared', 6000);
      else if (how === 'replay' && unusable) showError('That replay can’t be played with this version, so it was cleared', 6000);
      else if (!unusable) showError('The voyage couldn’t start: try again, or reload the page', 6000);
      setSave(loadSave());
      setStarting(null);
    }
  };
  const resume = async () => {
    if (starting || !save) return;
    await launch('continue', () => session.start(save.cfg, save));
  };
  /** Keep the name and the set-up for next time (online play comes aboard with them too). */
  const remember = () => {
    try {
      localStorage.setItem('exploratory.name', name);
      localStorage.setItem('exploratory.setup', JSON.stringify(setup));
    } catch {
      /* ignore */
    }
  };
  /** The voyage the set-up page would set out on, as session.start takes it. */
  const voyage = (): NewGameConfig & { victoryPoints: number; friendlyRobber: boolean; eventDeck: boolean } => ({
    name: name.trim() || 'You',
    color,
    avatar,
    opponents,
    difficulty,
    layout: expansions.length || custom || mix.map !== 'classic' ? 'random' : layout,
    numberPlacement: numbers,
    victoryPoints: points,
    friendlyRobber: robber === 'friendly',
    eventDeck: rolls === 'deck' && !almanac,
    ...(mix.modules.length ? { modules: mix.modules } : {}),
    ...(custom ? { map: 'custom', custom } : mix.map !== 'classic' ? { map: mix.map } : {}),
    ...(Object.keys(mix.knobs).length ? { knobs: mix.knobs } : {}),
  });
  const start = async () => {
    if (starting) return;
    remember();
    if (!playable) return;
    // (The variants ride on the config as game options: victoryPoints, friendlyRobber, eventDeck;
    // the expansions as modules on a map with a preset's knobs. They play on a random island, and
    // the almanac brings its own deck.)
    const cfg = voyage();
    await launch('solo', () => session.start(cfg));
  };
  // The island the voyage would set out to is built ahead (its terrain, on the workers) while the
  // set-up page is open, or the title offers the save to continue: see session.prepare. (Once the
  // page has settled: a choice changed meanwhile only deals a new board.)
  const ahead = view === 'solo' && playable ? JSON.stringify(voyage()) : view === 'main' && save ? 'save' : null;
  useEffect(() => {
    if (!ahead || starting) return;
    const t = setTimeout(() => (ahead === 'save' ? save && session.prepare(save.cfg, save) : session.prepare(voyage())), ahead === 'save' ? 1200 : 250);
    return () => clearTimeout(t);
  }, [ahead, starting]);
  // The same choices as a room's settings, for hosting a voyage online. (A map from the editor
  // isn't sent yet: the room plays the mix's own.)
  const roomSettings: Partial<RoomSettings> = {
    preset: mix.preset?.id ?? 'custom',
    modules: mix.modules,
    map: mix.map,
    layout: expansions.length ? 'random' : layout,
    numberPlacement: numbers,
    victoryPoints: Math.max(fewest, Math.min(MAX_VICTORY_POINTS, mix.target + shift)),
    friendlyRobber: robber === 'friendly',
    eventDeck: rolls === 'deck' && !almanac,
    knobs: mix.knobs,
    botDifficulty: difficulty,
  };
  const compact = useCompact();
  const variants = [shift !== 0 && `${points} points`, robber === 'friendly' && 'Friendly robber', rolls === 'deck' && !almanac && 'Event deck'].filter(Boolean);
  const mixName = mix.preset?.name ?? (expansions.length === 1 ? EXPANSIONS.find((e) => e.id === expansions[0])!.name : expansions.length ? `${expansions.length} expansions` : 'Base game');
  const island = custom ? custom.name : expansions.length || mix.map !== 'classic' ? (MAP_INFO[mix.map]?.name ?? mixName) : layout === 'beginner' ? 'Beginner set-up' : numbers === 'balanced' ? 'Random, balanced' : 'Random island';
  const summary = `${opponents + 1} players · ${difficulty[0].toUpperCase()}${difficulty.slice(1)} · ${expansions.length && island !== mixName ? `${mixName} · ` : ''}${island}${variants.map((v) => ` · ${v}`).join('')}`;
  const seg = <T extends string | number>(opts: [T, string][], v: T, on: (x: T) => void) => (
    <div className="seg">
      {opts.map(([k, label]) => (
        <button key={String(k)} className={v === k ? 'on' : ''} aria-pressed={v === k} onClick={() => (sfx.unlock(), sfx.play('click'), on(k))}>
          {label}
        </button>
      ))}
    </div>
  );
  const press = () => (sfx.unlock(), sfx.play('click'));
  const options = (
    <>
      <div className="field" role="group" aria-label="Players">
        <span className="field-label">Players</span>
        {seg<2 | 3>([[2, '3 players'], [3, '4 players']], opponents, setOpponents)}
      </div>
      <div className="field" role="group" aria-label="Difficulty" aria-describedby="difficulty-note">
        <span className="field-label">Difficulty</span>
        {seg<NewGameConfig['difficulty']>([['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], difficulty, setDifficulty)}
        <span className="field-hint" id="difficulty-note">
          {DIFFICULTY_BLURBS[difficulty]}
        </span>
      </div>
      {/* (Expansions always play on a random island: the beginner positions are the base game's.
          A preset with a map of its own, All Hands, takes no other.) */}
      {!mix.preset?.map && (
        <div className="field" role="group" aria-label="Island" style={{ gridColumn: '1 / -1' }}>
          <span className="field-label">Island</span>
          <div className="island-choices">
            {pool.map((id) => {
              // (The base game plays the classic island at random or as the beginner set-up.)
              const on = !custom && mix.map === id && (expansions.length > 0 || id !== 'classic' || layout === 'random');
              return (
                <button key={id} className={`map-choice tip ${on ? 'on' : ''}`} aria-pressed={on} data-tip={MAP_INFO[id] ? `${MAP_INFO[id].about[0].toUpperCase()}${MAP_INFO[id].about.slice(1)}` : undefined} onClick={() => (press(), choose({ map: id, layout: 'random', customMap: null }))}>
                  {glimpses[id] && <MapThumb map={glimpses[id]} size={26} />}
                  {MAP_INFO[id]?.name ?? id}
                </button>
              );
            })}
            {expansions.length === 0 && (
              <button className={`map-choice tip ${!custom && mix.map === 'classic' && layout === 'beginner' ? 'on' : ''}`} aria-pressed={!custom && mix.map === 'classic' && layout === 'beginner'} data-tip="The classic island laid out the same every game, for a first game" onClick={() => (press(), choose({ map: 'classic', layout: 'beginner', customMap: null }))}>
                {glimpses[BEGINNER] && <MapThumb map={glimpses[BEGINNER]} size={26} />}
                Beginner set-up
              </button>
            )}
            {library.map((m) => (
              <button key={m.id} className={`map-choice custom tip ${customMap === m.id && custom ? 'on' : ''}`} aria-pressed={customMap === m.id && !!custom} data-tip={`Your map, ${m.map.hexes.filter((h) => h.terrain !== 'sea').length} land hexes`} onClick={() => (press(), choose({ customMap: m.id }))}>
                <MapThumb map={m.map} size={26} />
                {m.map.name}
              </button>
            ))}
            <button className="map-choice draw" onClick={() => (press(), set({ screen: 'editor' }))}>
              <LineIcon name="plus" size={16} />
              {library.length ? 'Draw a map' : 'Draw your own map'}
            </button>
          </div>
        </div>
      )}
      {/* (With expansions the numbers are dealt by the home island's rules: docs/maps.md.) */}
      {!custom && !expansions.length && layout === 'random' && mix.map === 'classic' && (
        <div className="field" role="group" aria-label="Number discs">
          <span className="field-label">Number discs</span>
          {seg<NewGameConfig['numberPlacement']>([['spiral', 'Spiral'], ['balanced', 'Shuffled']], numbers, setNumbers)}
        </div>
      )}
    </>
  );
  // The variants fold away on desktop too (they are rarely changed, and the page must fit).
  const variantFields = (
    <>
      <div className="field" role="group" aria-label="Points to win" style={{ gridColumn: '1 / -1' }}>
        <span className="field-label">Points to win</span>
        <div className="points-row">
          <div className="stepper">
            <button aria-label="Fewer points" disabled={points <= fewest} onClick={() => (press(), setShift(points - 1 - suggested))}>
              −
            </button>
            <b aria-live="polite">
              <Morph>{points}</Morph>
            </b>
            <button aria-label="More points" disabled={points >= MAX_VICTORY_POINTS} onClick={() => (press(), setShift(points + 1 - suggested))}>
              +
            </button>
          </div>
          {points === suggested ? (
            <span className="points-note">Suggested{custom ? ' for this map' : expansions.length ? ' for this mix' : ''}</span>
          ) : (
            <button className="points-reset" onClick={() => (press(), setShift(0))}>
              <LineIcon name="undo" size={16} />
              Back to {suggested}, the suggested target
            </button>
          )}
        </div>
      </div>
      <div className="field" role="group" aria-label="Robber">
        <span className="field-label">Robber</span>
        {seg<Setup['robber']>([['standard', 'Standard'], ['friendly', 'Friendly']], robber, setRobber)}
      </div>
      {!almanac && (
        <div className="field" role="group" aria-label="Rolls">
          <span className="field-label">Rolls</span>
          {seg<Setup['rolls']>([['dice', 'Dice'], ['deck', 'Event deck']], rolls, setRolls)}
        </div>
      )}
    </>
  );
  // The expansions: a preset is a named set of them, so the chips and the toggles are one choice.
  const expansionFields = (
    <>
      <div className="field" role="group" aria-label="Presets">
        <span className="field-label">Presets</span>
        <div className="chips">
          <button className={expansions.length ? '' : 'on'} aria-pressed={!expansions.length} onClick={() => (press(), choose({ expansions: [] }))}>
            Base game
          </button>
          {PRESETS.map((p) => (
            <button key={p.id} className={`tip ${mix.preset === p ? 'on' : ''}`} data-tip={p.blurb} aria-pressed={mix.preset === p} onClick={() => (press(), choose({ expansions: [...p.expansions] }))}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="field" role="group" aria-label="Expansions">
        <span className="field-label">Expansions</span>
        <div className="expansion-toggles">
          {EXPANSIONS.map((e) => (
            <button key={e.id} className={expansions.includes(e.id) ? 'on' : ''} aria-pressed={expansions.includes(e.id)} onClick={() => (press(), toggle(e.id))}>
              <span className="expansion-name">{e.name}</span>
              <span className="expansion-blurb">{e.blurb}</span>
            </button>
          ))}
        </div>
      </div>
      {expansions.length > 0 && (
        <p className="mix-line">
          <span className={`grade grade-${mix.grade} tip`} data-tip={GRADES[mix.grade].tip}>
            {GRADES[mix.grade].label}
          </span>
          <span>Suggested target {suggested} points</span>
        </p>
      )}
    </>
  );
  const expansionDetails = (
    <details className="options">
      <summary>
        <span className="summary-label">Expansions</span>
        <span className="summary-value">
          <Morph>{mixName}</Morph>
        </span>
        <LineIcon name="chevronDown" size={16} />
      </summary>
      <div className="options-body">{expansionFields}</div>
    </details>
  );
  // (Your own face is the Profile card's mark, and its page's.)
  const profileFace = (
    <span className="menu-face" style={{ ['--pc' as string]: PLAYER_PALETTE[color]?.ui ?? color }}>
      <AvatarFace code={avatar} name={name.trim() || 'You'} color={color} />
    </span>
  );
  const items: MenuItem[] = [
    ...(save
      ? [
          {
            id: 'continue',
            label: 'Continue',
            note: `${save.turn > 0 ? `Turn ${save.turn}` : 'Placing the first houses'}${typeof save.savedAt === 'number' ? ` · ${ago(Date.now() - save.savedAt)}` : ''}`,
            icon: ICONS.continue,
            primary: true,
            onSelect: () => void resume(),
          },
        ]
      : []),
    { id: 'solo', label: 'Singleplayer', note: save ? 'A new island against the crew' : 'You against the crew, on a new island', icon: ICONS.solo, primary: !save, onSelect: () => setView('solo') },
    { id: 'multi', label: 'Multiplayer', note: 'Host a room or join one with a code', icon: ICONS.multi, onIntent: warmMulti, onSelect: () => (setWay('choose'), setView('multi')) },
    {
      id: 'profile',
      label: 'Profile',
      note: `${name.trim() && name.trim().toLowerCase() !== 'you' ? name.trim() : 'Your name'} · picture, colour and account`,
      icon: profileFace,
      onSelect: () => setView('profile'),
    },
    { id: 'editor', label: 'Map editor', note: 'Draw an island of your own', icon: ICONS.editor, onSelect: () => set({ screen: 'editor' }) },
    { id: 'settings', label: 'Settings', note: 'Look, play, sound and access', icon: ICONS.settings, small: true, onSelect: () => set({ modal: 'settings' }) },
    { id: 'rules', label: 'How to play', note: 'Rules, expansions and controls', icon: ICONS.rules, small: true, onSelect: () => set({ modal: 'rules' }) },
  ];
  return (
    // The menu's highlight is in your colour, as your panel's is in the game.
    <motion.div
      className={`title-screen view-${view}`}
      // Settings and the rules open over the menu: it is out of reach of Tab and clicks meanwhile.
      // So too as it fades for the editor, which comes in over it.
      inert={modalOpen || !present}
      style={{ ['--pc' as string]: PLAYER_PALETTE[color].ui }}
    >
      {/* The views share one place, so a card can grow into its page while the others step aside.
          (Nothing here fades the whole title: an ancestor's fade blinds its glass's backdrop-filter,
          clear glass until it ends. Each card and page fades itself, in and out, the title's going
          carried down to them. Once the title is on its way out, its pages leave with it and aren't
          drawn again: one that re-rendered while leaving would be shown twice under one key.) */}
      <AnimatePresence custom={view} propagate>
        {present && view === 'main' && (
          <MainMenu
            key="main"
            items={items}
            busy={starting}
            first={first && from === 'main'}
            from={from === 'main' ? null : from}
            replay={session.lastGame ? () => void launch('replay', () => session.watchReplay(session.lastGame!)) : undefined}
          />
        )}
        {present && view === 'solo' && (
          <MenuPage key="solo" id="solo" grown={from === 'main'} title="Singleplayer" icon={ICONS.solo} onBack={toMain}>
            <div className="form">
              {/* (Your name, colour and picture are the Profile page's, as on the Multiplayer page: here,
                  who you'll be, and a way there. One less screenful between you and Set sail.) */}
              <SailingAs name={name} color={color} avatar={avatar} onChange={() => (remember(), setView('profile'))} />
              {compact ? (
                // Phones: the game's options fold into one row that says what they are set to.
                // (Together, so a phone on its side can stand them beside the rest; see ui.css.)
                <div className="option-folds">
                  <details className="options">
                    <summary>
                      <span className="summary-label">Game</span>
                      <span className="summary-value">{summary}</span>
                      <LineIcon name="chevronDown" size={16} />
                    </summary>
                    <div className="options-body">
                      {options}
                      {variantFields}
                    </div>
                  </details>
                  {expansionDetails}
                </div>
              ) : (
                <>
                  {options}
                  {expansionDetails}
                  <details className="options">
                    <summary>
                      <span className="summary-label">Variants</span>
                      <span className="summary-value">{variants.length ? variants.join(' · ') : 'Standard rules'}</span>
                      <LineIcon name="chevronDown" size={16} />
                    </summary>
                    <div className="options-body" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      {variantFields}
                    </div>
                  </details>
                </>
              )}
            </div>
            {check && (check.errors.length > 0 || check.warnings.length > 0 || check.notes.length > 0) && (
              <ul className="map-issues">
                {check.errors.map((e) => (
                  <li key={e} className="bad">
                    {e}
                  </li>
                ))}
                {check.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
                {check.notes.map((n) => (
                  <li key={n} className="note">
                    {n}
                  </li>
                ))}
              </ul>
            )}
            {!custom && !mix.playable && <p className="page-note">This mix’s map isn’t charted yet.</p>}
            {save && <p className="page-note">A new game replaces your saved one{save.turn > 0 ? ` (turn ${save.turn})` : ''}.</p>}
            <div className="title-actions">
              {/* While the game is being set up the button stays lit and fills as it goes, rather
                  than greying out (which read as stuck); start() ignores further presses. */}
              <button className={`btn gold large${starting ? ' sailing' : ''}`} onClick={start} aria-disabled={starting !== null || !playable} style={starting ? { position: 'relative', overflow: 'hidden' } : undefined}>
                {/* (A pale wash filling it from its leading edge, clipped to its shape: the label stays clear.) */}
                {starting && <SailFill />}
                {!starting && <LineIcon name="ship" size={20} />}
                <span style={{ position: 'relative' }}>{starting ? <SailLabel /> : 'Set sail'}</span>
              </button>
            </div>
          </MenuPage>
        )}
        {present && view === 'profile' && (
          <MenuPage
            key="profile"
            id="profile"
            grown={from === 'main'}
            title="Profile"
            icon={profileFace}
            // (Opened from a page's "Sailing as", the way back is to that page.)
            back={from === 'solo' ? 'Singleplayer' : from === 'multi' ? 'Multiplayer' : 'Menu'}
            onBack={() => {
              remember();
              if (from === 'solo' || from === 'multi') setView(from);
              else toMain();
            }}
          >
            <Suspense fallback={null}>
              <ProfilePage name={name} onName={setName} color={color} onColor={setColor} avatar={avatar} onAvatar={(a) => choose({ avatar: a })} onLeave={remember} />
            </Suspense>
          </MenuPage>
        )}
        {present && view === 'multi' && (
          <MenuPage
            key="multi"
            id="multi"
            grown={from === 'main'}
            title={way === 'host' ? 'Host a room' : way === 'join' ? 'Join a room' : 'Multiplayer'}
            icon={ICONS.multi}
            // (From a chosen way, back is to the choice of ways; from there, to the menu.)
            back={way === 'choose' ? 'Menu' : 'Multiplayer'}
            onBack={way === 'choose' ? toMain : () => (sfx.play('click'), setWay('choose'))}
            className="multi-page"
          >
            {/* (The way back is the page's own, at its head: one is enough.) */}
            <Suspense fallback={<p className="page-note">Looking for the harbour…</p>}>
              <MultiplayerPage
                name={name}
                onName={setName}
                color={color}
                onColor={setColor}
                avatar={avatar}
                onAvatar={(a) => choose({ avatar: a })}
                players={(opponents + 1) as 3 | 4}
                onPlayers={(n) => setOpponents((n - 1) as 2 | 3)}
                preset={mix.preset?.id ?? (expansions.length ? 'custom' : null)}
                onPreset={(id) => choose({ expansions: id ? [...(PRESETS.find((p) => p.id === id)?.expansions ?? [])] : [] })}
                mixName={mixName}
                settings={roomSettings}
                remember={remember}
                onSolo={() => setView('solo')}
                onProfile={() => (remember(), setView('profile'))}
                onLeave={remember}
                way={way}
                onWay={setWay}
              />
            </Suspense>
          </MenuPage>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Whether the menu has been shown yet this visit (its first entrance waits for the loader). */
let shownMenu = false;
/** Whether the page a room's link opened on has been shown (only the first time the menu is). */
let roomShown = false;
