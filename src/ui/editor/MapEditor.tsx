// The map editor: draw an island of your own, flat or in 3D, and see as you go whether a game on
// it can be played to its target. The map is kept in the browser's library and played whole (see
// engine/maps/custom.ts); Test play lets the crew play it out in the real 3D island.
//
// One layout for every screen: the board fills the window; a slim bar along the top holds the
// map's name, undo, the view and the verdict; the tools sit in a dock (a rail on the left of a wide
// screen, along the bottom of a phone); the check opens beside the board, or as a sheet on a phone.

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isRandom, normalize } from '../../engine/maps/custom';
import { getMap, listMaps } from '../../game/customMaps';
import { useUI } from '../../game/store';
import { session } from '../../app/session';
import { sfx } from '../../audio/sfx';
import { Board2D } from './Board2D';
import { SailFill, SailLabel } from '../Sail';
import { View3D } from './View3D';
import { Dock } from './Dock';
import { CheckPanel, StatusChip, useVerdict } from './CheckPanel';
import { Library, SaveIcon } from './Library';
import { chooseView, choosePlayMap, savedDraft, useEditor } from './store';
import { isBrush } from './model';
import { DraftIsland } from '../../render/editor/draft';
import { exportMap } from '../../game/customMaps';
import { isTouch } from '../useCompact';
import { shortcutKey } from '../../app/shortcutKey';
import { LineIcon } from '../LineIcons';
import { Morph } from '../Morph';
import '../../styles/editor.css';

/** Whether the editor has been opened since the page loaded. */
let opened = false;

const press = () => (sfx.unlock(), sfx.play('click'));
const seed = () => Math.floor(Math.random() * 1e9);

/** Leave the editor for the title, the camera back over the sea. */
function closeEditor() {
  useUI.getState().set({ screen: 'title' });
  // (Left from the 2D view, the 3D view's own clean-up, which flies back, has already run as the
  // editor went to 2D and stayed put for it: so the flight back is here. Not while a game has the camera.)
  const world = session.world;
  if (world && !session.host && useEditor.getState().view === '2d') void world.flyToTitle(1.2, () => !session.host);
}

/** The shortcuts' modifier as the keyboard prints it. */
const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** Redo: the line set's undo turned round. */
const RedoIcon = ({ size = 20 }: { size?: number }) => (
  <span className="ed-flip" aria-hidden>
    <LineIcon name="undo" size={size} />
  </span>
);


export function MapEditor() {
  const s = useEditor();
  const { map, view, dirty, preview, checkOpen } = s;
  // (A map the library hasn't got is unsaved, changed or not.)
  const unsaved = dirty || !s.kept;
  // (The check's players and points are the store's: they outlast a test game.)
  const { players, points } = s;
  const setPlayers = (players: 3 | 4) => s.set({ players });
  const setPoints = (points: number | null) => s.set({ points });
  const [library, setLibrary] = useState(false);
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const verdict = useVerdict(players, points);
  const blocked = verdict.check.errors.length > 0;
  // A test game being set up: the button fills as the island is built.
  const [starting, setStarting] = useState(false);
  // The first visit after a page load opens the map left unsaved (the page reloaded, or the tab
  // closed) as it was, or else the map last worked on, rather than a blank one. (Before the boards'
  // own effects, which come first otherwise: the 3D view framed the blank map's grid, and the flat
  // board drew it for a frame.)
  useLayoutEffect(() => {
    if (opened) return;
    opened = true;
    const st = useEditor.getState();
    if (st.dirty || st.past.length > 0) return;
    const draft = savedDraft();
    const last = listMaps()[0];
    if (draft) {
      st.open(draft.id, draft.map);
      st.set({ dirty: true, kept: draft.kept });
      st.say(`“${draft.map.name}”, unsaved, as you left it`);
    } else if (last) st.open(last.id, last.map);
  }, []);

  // The two views, both there while one turns into the other: the island lifts out of the flat
  // board, and is pressed back into it (see View3D). `deep`: the 3D view, how it came in and whether
  // it's on its way back to the flat board; `flat`: the flat board, and whether it's shown.
  const [deep, setDeep] = useState<{ entry: 'fly' | 'lift'; leaving: boolean } | null>(() => (view === '3d' ? { entry: 'fly', leaving: false } : null));
  const [flat, setFlat] = useState<{ on: boolean } | null>(() => (view === '2d' ? { on: true } : null));
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    if (view === '3d') {
      if (deep) {
        // (Changed back while being pressed flat: up again, and the flat board dissolves.)
        setDeep({ ...deep, leaving: false });
        if (flat) dissolve();
      } else setDeep({ entry: flat ? 'lift' : 'fly', leaving: false });
    } else if (deep) {
      // The flat board laid out unseen, for the island to be pressed flat exactly under it. (Still
      // shown, the island not yet lifted out of it, it stays: the island goes back under it.)
      setFlat((f) => (f?.on ? f : { on: false }));
      setDeep({ ...deep, leaving: true });
    } else setFlat({ on: true });
  }, [view]);
  const melt = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The flat board fades, and goes once it has (unless the view changed back meanwhile).
  const dissolve = () => {
    setFlat({ on: false });
    if (melt.current) clearTimeout(melt.current);
    melt.current = setTimeout(() => useEditor.getState().view === '3d' && setFlat(null), 450);
  };
  useEffect(() => () => void (melt.current && clearTimeout(melt.current)), []);
  const lifted = () => useEditor.getState().view === '3d' && dissolve();
  const gathered = () => useEditor.getState().view === '2d' && setFlat({ on: true });
  const pressed = () => useEditor.getState().view === '2d' && setDeep(null);

  // The island isn't drawn under the flat board, which covers it once the editor has come in: the
  // GPU rests and painting stays smooth on a phone. (Drawn again for 3D, a test game or leaving.)
  const resting = deep === null;
  useEffect(() => {
    const world = session.world;
    if (!world || !resting || starting) return;
    const rest = setTimeout(() => {
      if (useUI.getState().screen === 'editor') world.drawEnabled = false;
    }, 450);
    const off = useUI.subscribe((u) => {
      if (u.screen !== 'editor') world.drawEnabled = true;
    });
    return () => {
      clearTimeout(rest);
      off();
      world.drawEnabled = true;
    };
  }, [resting, starting]);
  // The title's sandbank (its clear shallows over where its island waits) goes down while the
  // editor is open: the draft is the only island, and the sea round it is open water, as in a
  // game. It comes up again for the title (a test game's island has its own).
  useEffect(() => {
    const world = session.world;
    if (!world) return;
    void world.shoal(false, 0.8);
    return () => void (!session.host && world.shoal(true, 1.2));
  }, []);
  // The 3D view's shaders are built in the background a little after the editor opens, so going
  // to 3D shows the island at once.
  useEffect(() => {
    const world = session.world;
    if (!world) return;
    const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1));
    // (Not while a test game is being set up: its own compile has the frames.)
    const t = setTimeout(() => idle(() => useUI.getState().screen === 'editor' && !session.host && void DraftIsland.warm(world)), 1500);
    return () => clearTimeout(t);
  }, []);

  // Keys: undo and redo, save, the digits for the terrains, Escape out of a preview or a river.
  // (Not while the maps are open over the board: those keep Escape for themselves.)
  const libraryOpen = useRef(false);
  libraryOpen.current = library;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea') || libraryOpen.current) return;
      const st = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = shortcutKey(e);
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        st.redo();
      } else if (mod && k === 's') {
        e.preventDefault();
        // (Nothing to save: the library isn't rewritten, nor the map moved to its top.)
        if (st.dirty || !st.kept) st.save();
      } else if (e.key === 'Escape') {
        if (st.preview !== null) st.set({ preview: null });
        else if (st.drawing !== null) st.set({ drawing: null });
      } else if (!mod && /^[1-8]$/.test(k)) {
        const terrains = ['forest', 'pasture', 'fields', 'hills', 'mountains', 'desert', 'sea', 'random'] as const;
        st.set({ tool: { kind: 'terrain', terrain: terrains[Number(k) - 1] }, category: 'land', drawing: null });
      } else if (!mod && k === 'e') st.set({ tool: { kind: 'erase' }, category: 'land', drawing: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Two fingers move the board, never the page: Safari's own pinch zoom is held off, as in a game.
  useEffect(() => {
    const noPageZoom = (e: Event) => e.preventDefault();
    const twoFingers = (e: TouchEvent) => e.touches.length > 1 && e.preventDefault();
    document.addEventListener('gesturestart', noPageZoom);
    document.addEventListener('gesturechange', noPageZoom);
    document.addEventListener('touchmove', twoFingers, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', noPageZoom);
      document.removeEventListener('gesturechange', noPageZoom);
      document.removeEventListener('touchmove', twoFingers);
    };
  }, []);

  // The ⋯ menu closes on a press anywhere outside it, or Escape (it covers the board's buttons on a phone).
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => !(e.target as Element)?.closest?.('.ed-menu, .ed-more') && setMenu(false);
    // (Escape gives the keyboard back to the ⋯ that opened it.)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (setMenu(false), moreRef.current?.focus());
    // (Opened from the keyboard, its first item takes the focus.)
    if (moreRef.current?.matches(':focus-visible')) requestAnimationFrame(() => menuRef.current?.querySelector('button')?.focus());
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);

  // (While the map can't be played, Test play and Play open the check, which says what to fix.)
  const showProblems = () => {
    press();
    setMenu(false);
    s.set({ checkOpen: true });
    s.say(`Fix ${verdict.check.errors.length === 1 ? 'the problem' : `the ${verdict.check.errors.length} problems`} in the check first`, true);
  };
  const testPlay = async () => {
    if (starting) return;
    if (blocked) return showProblems();
    press();
    setMenu(false);
    setStarting(true);
    s.set({ returnHere: true });
    try {
      await session.start({ name: 'You', color: 'red', opponents: (players - 1) as 2 | 3, difficulty: 'normal', layout: 'random', numberPlacement: 'spiral', victoryPoints: verdict.points, map: 'custom', custom: normalize(map), watch: true, ...(verdict.modules.length && { modules: verdict.modules }) });
    } catch (e) {
      console.error(e);
      // (Not coming back here from the title later: there was no game to come back from.)
      useEditor.getState().set({ returnHere: false });
      useEditor.getState().say(`The game wouldn’t start: ${(e as Error).message}`, true);
      useUI.getState().set({ screen: 'editor' });
      setStarting(false);
    }
  };
  const playIt = () => {
    if (blocked) return showProblems();
    press();
    // (The set-up page plays maps from the library: one changed, or never kept there, is saved first.)
    if ((unsaved || !getMap(s.id)) && !s.save()) return;
    choosePlayMap(s.id, verdict.points, verdict.modules, players);
    useUI.getState().set({ screen: 'title' });
  };
  const toggleCheck = () => (press(), s.set({ checkOpen: !checkOpen }));
  const random = isRandom(map);
  const openLibrary = () => (press(), setMenu(false), setLibrary(true));
  const save = () => (press(), setMenu(false), s.save());

  return (
    <motion.div className={`map-editor view-${view}${flat?.on ? ' flat' : ''}${deep && !deep.leaving ? ' deep' : ''}${checkOpen ? ' check-open' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      {deep && <View3D entry={deep.entry} leaving={deep.leaving} onShown={lifted} onFlat={gathered} onGone={pressed} />}
      {flat && <Board2D hidden={!flat.on} />}

      <header className="ed-top parchment">
        <button className="ed-icon-btn ed-plain tip" data-tip="Back to the title" onClick={() => (press(), closeEditor())} aria-label="Back to the title">
          <LineIcon name="back" size={20} />
        </button>
        <input className="ed-name" value={map.name} maxLength={40} aria-label="Map name" spellCheck={false} onChange={(e) => useEditor.setState({ map: { ...map, name: e.target.value }, dirty: true })} />
        {/* The map itself: the library, and keeping this one in it. */}
        <div className="ed-top-group ed-wide">
          <button className="btn ghost small" onClick={openLibrary}>
            <LineIcon name="map" size={16} />
            Maps
          </button>
          <button className="btn ghost small ed-save" onClick={save} disabled={!unsaved} aria-keyshortcuts="Control+S Meta+S">
            {unsaved ? <SaveIcon size={16} /> : <LineIcon name="check" size={16} />}
            <Morph>{unsaved ? 'Save' : 'Saved'}</Morph>
          </button>
        </div>
        <span className="ed-grow" />
        <StatusChip verdict={verdict} open={checkOpen} onClick={toggleCheck} />
        {/* Playing it: a test with the crew, and the one primary, Play. */}
        <div className="ed-top-group ed-wide ed-play-group">
          <button className={`btn ghost small ed-test tip${starting ? ' sailing' : ''}`} onClick={testPlay} aria-disabled={blocked || starting} data-tip={blocked ? 'Fix the problems first' : 'Watch the crew play it on the real island'}>
            {starting && <SailFill />}
            {!starting && <LineIcon name="bot" size={16} />}
            <span>{starting ? <SailLabel /> : 'Test play'}</span>
          </button>
          <button className="btn gold small tip" onClick={playIt} aria-disabled={blocked} data-tip={blocked ? 'Fix the problems first' : 'Play it against the crew'}>
            <LineIcon name="ship" size={16} />
            Play
          </button>
        </div>
        <button ref={moreRef} className="ed-icon-btn ed-plain ed-narrow ed-more" onClick={() => (press(), setMenu((m) => !m))} aria-label="Map actions" aria-expanded={menu} aria-haspopup="true">
          <LineIcon name="more" size={22} />
        </button>
        <AnimatePresence>
          {menu && (
            <motion.div ref={menuRef} className="ed-menu parchment" role="group" aria-label="Map actions" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97 }} transition={{ duration: 0.16 }}>
              <button onClick={openLibrary}>
                <LineIcon name="map" size={20} />
                Maps…
              </button>
              <button onClick={save} disabled={!unsaved}>
                {unsaved ? <SaveIcon size={20} /> : <LineIcon name="check" size={20} />}
                <Morph>{unsaved ? 'Save' : 'Saved'}</Morph>
              </button>
              <button onClick={() => (press(), setMenu(false), exportMap(map))}>
                <LineIcon name="download" size={20} />
                Export as a file
              </button>
              <hr />
              <button onClick={testPlay} aria-disabled={blocked}>
                <LineIcon name="bot" size={20} />
                {starting ? <SailLabel /> : 'Test play'}
              </button>
              <button className="gold" onClick={() => (setMenu(false), playIt())} aria-disabled={blocked}>
                <LineIcon name="ship" size={20} />
                Play this map
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Undo and redo, the view and a deal's preview: a floating cluster over the board's corner. */}
      <div className="ed-float">
        <div className="ed-pair" role="group" aria-label="History">
          <button className="ed-icon-btn tip" data-tip={`Undo (${MOD}Z)`} onClick={() => (press(), s.undo())} disabled={s.past.length === 0} aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z">
            <LineIcon name="undo" size={20} />
          </button>
          <button className="ed-icon-btn tip" data-tip={`Redo (${MOD}Shift+Z)`} onClick={() => (press(), s.redo())} disabled={s.future.length === 0} aria-label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z">
            <RedoIcon />
          </button>
        </div>
        <div className="seg ed-view" role="group" aria-label="View">
          {(['2d', '3d'] as const).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} aria-label={v === '2d' ? '2D map' : '3D island'} onClick={() => (press(), chooseView(v))}>
              {v.toUpperCase()}
            </button>
          ))}
        </div>
        {random && (
          <button className={`ed-icon-btn tip${preview !== null ? ' on' : ''}`} data-tip="Preview one deal" onClick={() => (press(), s.set({ preview: seed() }))} aria-label="Preview a deal of the random hexes">
            <LineIcon name="play" size={20} />
          </button>
        )}
      </div>

      <AnimatePresence>
        {preview !== null && (
          <motion.div key="preview" className="ed-preview" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} role="status">
            <span>One possible deal: every game deals its own</span>
            <button className="btn ghost small" onClick={() => (press(), s.set({ preview: seed() }))}>
              <LineIcon name="refresh" size={16} />
              Deal again
            </button>
            <button className="btn gold small" onClick={() => (press(), s.set({ preview: null }))} aria-keyshortcuts="Escape">
              <LineIcon name="pencil" size={16} />
              Back to editing
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Dock />

      <AnimatePresence>
        {checkOpen && (
          <motion.div key="check" className="ed-check-wrap" initial={{ opacity: 0, x: 24, y: 0 }} animate={{ opacity: 1, x: 0, y: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ type: 'spring', duration: 0.38, bounce: 0.15 }}>
            <CheckPanel verdict={verdict} players={players} setPlayers={setPlayers} points={points} setPoints={setPoints} onClose={toggleCheck} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {s.note && (
          <motion.div key={s.note.id} className={`ed-note ${s.note.bad ? 'bad' : ''}`} role="status" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}>
            {s.note.text}
          </motion.div>
        )}
      </AnimatePresence>
      <Hint />
      <AnimatePresence>{library && <Library key="lib" onClose={() => setLibrary(false)} />}</AnimatePresence>
      <TestCurtain on={starting} />
    </motion.div>
  );
}

/** What the tool in hand does, said under the board (on a phone, above the dock where it's tall enough). */
function Hint() {
  const tool = useEditor((s) => s.tool);
  const view = useEditor((s) => s.view);
  const drawing = useEditor((s) => s.drawing);
  // (On a touch screen it's a tap, and there's no right button to drag with. A brush paints along a
  // drag in either view; in 3D the other tools leave a drag to move the map.)
  const touch = isTouch();
  const verb = touch ? 'Tap' : 'Click';
  const orDrag = `${verb} or drag`;
  const brush = isBrush(tool);
  const text =
    tool.kind === 'terrain'
      ? tool.terrain === 'random'
        ? 'Paint random land: each game deals it from the bag'
        : `${orDrag} to paint`
      : tool.kind === 'erase'
        ? `${orDrag} to take cells off the map`
        : tool.kind === 'number'
          ? tool.n === 'deal'
            ? `${verb} a hex to leave its number to the deal`
            : `${verb} a producing hex to give it ${tool.n} (again to take it off)`
          : tool.kind === 'port'
            ? `${verb} a stretch of coast for a harbour (again to take it down)`
            : tool.kind === 'river'
              ? drawing === null
                ? `${verb} a hex to start a river at its spring`
                : `${verb} the next hex down to the coast; end on a swamp, and ${verb.toLowerCase()} it again to finish`
              : tool.kind === 'fog'
                ? `${orDrag} to lay the fog over cells (again to clear it)`
                : tool.kind === 'ground'
                  ? `${verb} the sea beside the land for a fishing ground`
                  : tool.kind === 'home'
                    ? `${verb} an island to make it a home island`
                    : tool.kind === 'well'
                      ? `${verb} land for an oil well`
                      : tool.kind === 'corsair'
                        ? `${verb} the open sea for the corsair’s start`
                        : `${verb} land for the robber’s start`;
  const move =
    view === '3d'
      ? touch
        ? brush
          ? ' · two fingers to move'
          : ' · drag to move'
        : brush
          ? ' · right-drag to pan · Shift-drag to turn'
          : ' · drag to pan · Shift-drag to turn'
      : touch
        ? ' · two fingers to pan'
        : ' · right-drag or two fingers to pan';
  return (
    // (Morphed where it keeps to one line: on a touch screen it may wrap, which a morph can't.)
    <p className="ed-hint">{touch ? text + move : <Morph duration={360}>{text + move}</Morph>}</p>
  );
}

/** While a test game is set up, the editor dims under a curtain (the island is being built behind it). */
function TestCurtain({ on }: { on: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return <AnimatePresence>{on && <motion.div ref={ref} className="ed-curtain" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}</AnimatePresence>;
}
