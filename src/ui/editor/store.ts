// The map editor's state: the map being drawn, its undo history, the tool in hand and the view.
// Kept outside the editor's components, so a map survives a test game and a trip to the title.

import { create } from 'zustand';
import { FEATURE_MODULE, MAX_HEXES, MAX_HOMES, MAX_LAND, MAX_REACH, blankMap, centreOf, hexDistance, parseCustomMap, versionOf, type CustomMap } from '../../engine/maps/custom';
import { sortModules, type ModuleId, type Terrain } from '../../engine';
import { newMapId, storeMap } from '../../game/customMaps';
import { sfx } from '../../audio/sfx';
import { TERRAIN_NAMES } from '../../game/names';
import { brushCells, cellAt, harbourAt, hexOf, inGrid, key, paint, homesFull, riverAt, setGround, setHarbour, setNumber, setPiece, toggleFlag, toggleHome, turn, turnsOf, type Tool } from './model';

/** What just changed, for the boards to animate: the cells touched by the last edit. */
export interface Change {
  id: number;
  cells: string[];
}

/** The tool categories, in the dock's order. */
export type Category = 'land' | 'numbers' | 'harbours' | 'features' | 'sea' | 'map';

/** A step to undo or redo to: the map, and the expansions it was checked with (a feature placed brings its own in). */
interface Step {
  map: CustomMap;
  modules: ModuleId[];
}

interface EditorState {
  id: string;
  map: CustomMap;
  /** Raised to have the boards take in the whole grid again ("Fit view"). */
  fit: number;
  past: Step[];
  future: Step[];
  tool: Tool;
  category: Category;
  /** The brush: one cell, or a cell and its ring. */
  brush: 1 | 7;
  /** Edits repeated round the middle: none, halves, thirds or sixths. */
  symmetry: 1 | 2 | 3 | 6;
  view: '2d' | '3d';
  /** A deal being previewed (its seed), or null while editing. */
  preview: number | null;
  /** The river being drawn (its index), while the river tool carries one on. */
  drawing: number | null;
  /** The expansions the map is checked (and test-played) with. */
  modules: ModuleId[];
  /** The players the map is checked (and played) for. */
  players: 3 | 4;
  /** The points to win it's checked to: null for the suggested. */
  points: number | null;
  /** The check's panel: open beside the board (a sheet on phones). */
  checkOpen: boolean;
  /** Whether the map differs from the library's copy. */
  dirty: boolean;
  /** Whether the library has a copy of it (not so for one started afresh, or deleted there). */
  kept: boolean;
  change: Change;
  /** Something said for a moment (a refused edit, a save). */
  note: { id: number; text: string; bad?: boolean } | null;
  /** A test game was started from here: its quit comes back to the editor. */
  returnHere: boolean;
  /** The set-up page should open with this map chosen (Play this map). */
  playMap: { id: string; points: number; modules: ModuleId[]; players: 3 | 4 } | null;
  /** Edit: the map after `fn`, as one step to undo (null from `fn` refuses it); with `merge`, part of the last step (a stroke carrying on). */
  edit: (fn: (m: CustomMap) => CustomMap | null, cells?: string[], refusal?: string, merge?: boolean) => boolean;
  undo: () => void;
  redo: () => void;
  open: (id: string, map: CustomMap) => void;
  fresh: (map: CustomMap) => void;
  save: () => boolean;
  set: (p: Partial<EditorState>) => void;
  say: (text: string, bad?: boolean) => void;
}

const LIMIT = 200;
let noteId = 0;
let changeId = 0;
let fitId = 0;

const VIEW_KEY = 'exploratory.editorView';
/** The view last chosen (the flat board, unless 3D was). */
function savedView(): '2d' | '3d' {
  try {
    return localStorage.getItem(VIEW_KEY) === '3d' ? '3d' : '2d';
  } catch {
    return '2d';
  }
}
/** Change the view, and open in it next time. */
export function chooseView(view: '2d' | '3d') {
  useEditor.getState().set({ view });
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* kept for this visit only */
  }
}

/** The expansions a map's features call for. */
export function modulesFor(map: CustomMap): ModuleId[] {
  const out = new Set<ModuleId>();
  for (const h of map.hexes) {
    if (h.terrain in FEATURE_MODULE) out.add(FEATURE_MODULE[h.terrain as keyof typeof FEATURE_MODULE]);
    if (h.well) out.add('oil');
    if (h.hidden) out.add('sea');
    if (h.terrain === 'sea' && h.number !== undefined) out.add('fisheries');
  }
  if (map.rivers?.length) out.add('rivers');
  if (map.corsair) out.add('sea');
  return [...out];
}

const opened = (id: string, map: CustomMap, dirty: boolean) => ({
  id,
  map,
  past: [],
  future: [],
  dirty,
  kept: !dirty,
  preview: null,
  drawing: null,
  modules: sortModules(modulesFor(map)),
  points: null,
  fit: ++fitId,
  change: { id: ++changeId, cells: [] },
});

export const useEditor = create<EditorState>((set, get) => ({
  id: newMapId(),
  map: blankMap('New island', 3, 2),
  fit: 0,
  past: [],
  future: [],
  tool: { kind: 'terrain', terrain: 'forest' },
  category: 'land',
  brush: 1,
  symmetry: 1,
  view: savedView(),
  preview: null,
  drawing: null,
  modules: [],
  players: 4,
  points: null,
  checkOpen: typeof window !== 'undefined' && window.innerWidth >= 1100,
  dirty: false,
  kept: false,
  change: { id: 0, cells: [] },
  note: null,
  returnHere: false,
  playMap: null,
  edit: (fn, cells = [], refusal, merge = false) => {
    const { map, past, modules: was } = get();
    const made = fn(map);
    if (made === null) {
      if (refusal) get().say(refusal, true);
      return false;
    }
    if (made === map) return false;
    // (A map past the old limits is written in the newer format: see versionOf.)
    const v = versionOf(made.hexes);
    const next = made.v === v ? made : { ...made, v };
    // (A feature placed brings its expansion into the check, so its rules are checked with it.)
    const before = modulesFor(map);
    const wanted = modulesFor(next).filter((m) => !before.includes(m));
    const modules = wanted.length ? sortModules([...new Set([...was, ...wanted])]) : was;
    set({ map: next, past: merge && past.length ? past : [...past.slice(-LIMIT + 1), { map, modules: was }], future: [], dirty: true, preview: null, modules, change: { id: ++changeId, cells } });
    return true;
  },
  // (The name stays as it is now: it's typed, not drawn, and isn't among the steps.)
  undo: () => {
    const { map, modules, past, future } = get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    set({ map: { ...prev.map, name: map.name }, modules: prev.modules, past: past.slice(0, -1), future: [{ map, modules }, ...future], dirty: true, preview: null, drawing: null, change: { id: ++changeId, cells: [] } });
  },
  redo: () => {
    const { map, modules, past, future } = get();
    if (future.length === 0) return;
    const next = future[0];
    set({ map: { ...next.map, name: map.name }, modules: next.modules, past: [...past, { map, modules }], future: future.slice(1), dirty: true, preview: null, drawing: null, change: { id: ++changeId, cells: [] } });
  },
  open: (id, map) => set(opened(id, map, false)),
  fresh: (map) => set(opened(newMapId(), map, true)),
  save: () => {
    const { id, map } = get();
    // (The library keeps it recentred; the map in hand stays where it is under the brush.)
    const ok = storeMap(id, map);
    if (ok) set({ dirty: false, kept: true });
    get().say(ok ? `Saved “${map.name}”` : 'The map wasn’t kept: it breaks a limit of the format, or the browser’s storage is full or blocked', !ok);
    return ok;
  },
  set: (p) => set(p),
  say: (text, bad) => {
    const id = ++noteId;
    set({ note: { id, text, bad } });
    setTimeout(() => get().note?.id === id && set({ note: null }), bad ? 3200 : 2200);
  },
}));

const DRAFT_KEY = 'exploratory.editorDraft';
/**
 * The map being drawn while it's unsaved, kept in the browser as it changes, so a reload or a
 * closed tab doesn't lose it: the editor's first visit opens it again.
 */
export function savedDraft(): { id: string; map: CustomMap; kept: boolean } | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as { id?: unknown; map?: unknown; kept?: unknown } | null;
    const map = d && parseCustomMap(d.map);
    return map && typeof d.id === 'string' ? { id: d.id, map, kept: d.kept === true } : null;
  } catch {
    return null;
  }
}
function keepDraft() {
  try {
    const { id, map, kept, dirty } = useEditor.getState();
    if (dirty) localStorage.setItem(DRAFT_KEY, JSON.stringify({ id, map, kept }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* not kept: the browser's storage is full or blocked */
  }
}
let draftTimer: ReturnType<typeof setTimeout> | undefined;
useEditor.subscribe((s, was) => {
  if (s.map === was.map && s.dirty === was.dirty) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(keepDraft, 500);
});
// (A stroke a moment before the tab closes is kept too.)
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => (clearTimeout(draftTimer), keepDraft()));

/** Open the set-up page with the library's map `id` chosen, to `points`, with `modules`. */
export function choosePlayMap(id: string, points: number, modules: ModuleId[], players: 3 | 4) {
  useEditor.setState({ playMap: { id, points, modules, players }, returnHere: false });
}

/** A short buzz under the finger for a placement (phones that have one; nothing elsewhere). */
const buzz = () => {
  try {
    if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(8);
  } catch {
    /* no vibration */
  }
};

/** Whether the current fog or well stroke is setting its flag (true) or clearing it. */
let strokeFlag = true;
/** Whether the current stroke has changed the map yet: its later cells join that one step to undo. */
let strokeLanded = false;
/** The cell a stroke's symmetry turns about: the map's centre as the stroke began (it moves as the map grows). */
let strokePivot: [number, number] = [0, 0];

/**
 * The tool in hand used at a point on the board (world x, z), from either view. `stroke`: a drag
 * carrying on a paint stroke (quieter: no refusal said for each cell it crosses). Symmetry repeats
 * painting, the fog, wells, numbers and harbours round the middle.
 */
export function applyTool(x: number, z: number, stroke = false) {
  const st = useEditor.getState();
  const { tool, map, brush, symmetry } = st;
  const [q, r] = cellAt(x, z);
  const turns = turnsOf(symmetry);
  if (!stroke) strokePivot = centreOf(map);
  const pivot = strokePivot;
  const mirrored = (cells: [number, number][]) => {
    const out = new Map<string, [number, number]>();
    for (const t of turns) for (const [a, b] of cells) out.set(key(...turn(a, b, t, pivot)), turn(a, b, t, pivot));
    return [...out.values()].filter(([a, b]) => inGrid(map, a, b));
  };
  const say = (text: string) => !stroke && st.say(text, true);
  const done = (sound: Parameters<typeof sfx.play>[0], volume = 0.8) => {
    sfx.play(sound, { volume: stroke ? volume * 0.55 : volume });
    buzz();
  };
  // A deal being previewed: the press only ends the preview (the map under it isn't what's shown).
  if (st.preview !== null) {
    st.set({ preview: null });
    return;
  }
  // (A drag paints one step to undo, however many cells it crosses.)
  if (!stroke) strokeLanded = false;
  const merge = stroke && strokeLanded;
  const landed = (ok: boolean) => ((strokeLanded ||= ok), ok);

  if (tool.kind === 'terrain' || tool.kind === 'erase') {
    if (!inGrid(map, q, r)) {
      // (Beyond the reach maps have from their middle: Crop to map moves the middle.)
      if (hexDistance(q, r) > MAX_REACH && map.hexes.some((h) => hexDistance(h.q - q, h.r - r) <= 2)) say(`A map reaches ${MAX_REACH} hexes from its middle at most: Crop to map recentres it`);
      return;
    }
    const terrain = tool.kind === 'terrain' ? tool.terrain : null;
    const cells = mirrored(brushCells(q, r, brush));
    // (A map lists so many cells: new ones past them are refused.)
    if (terrain) {
      const adds = cells.filter(([a, b]) => !hexOf(map, a, b)).length;
      if (adds > 0 && map.hexes.length + adds > MAX_HEXES) {
        say(`A map holds at most ${MAX_HEXES} hexes`);
        return;
      }
    }
    // (The island's shaders hold so many tiles: new land past them is refused.)
    if (terrain && terrain !== 'sea') {
      const land = map.hexes.filter((h) => h.terrain !== 'sea').length;
      const adds = cells.filter(([a, b]) => {
        const old = hexOf(map, a, b);
        return !old || old.terrain === 'sea';
      }).length;
      if (adds > 0 && land + adds > MAX_LAND) {
        say(`An island holds at most ${MAX_LAND} land hexes`);
        return;
      }
    }
    if (landed(st.edit((m) => paint(m, cells, terrain), cells.map(([a, b]) => key(a, b)), undefined, merge))) {
      done(terrain === null ? 'crumble' : terrain === 'sea' ? 'splash' : 'build', terrain === null ? 0.5 : 0.8);
    }
    return;
  }
  if (tool.kind === 'fog' || tool.kind === 'well') {
    const flag = tool.kind === 'fog' ? 'hidden' : 'well';
    const cells = mirrored(tool.kind === 'fog' ? brushCells(q, r, brush) : [[q, r]]).filter(([a, b]) => hexOf(map, a, b));
    if (cells.length === 0) return;
    // (A stroke keeps to what its first cell did, fogging or clearing all the way.)
    const ok = landed(st.edit((m) => toggleFlag(m, cells, flag, stroke ? strokeFlag : undefined), cells.map(([a, b]) => key(a, b)), tool.kind === 'well' && !stroke ? 'Wells go on fixed land, not the sea or a lake' : undefined, merge));
    if (!stroke) strokeFlag = !!hexOf(useEditor.getState().map, ...cells[0])?.[flag];
    if (ok) done(tool.kind === 'fog' ? 'whoosh' : 'anvil', 0.5);
    return;
  }
  if (tool.kind === 'number') {
    const h = hexOf(map, q, r);
    const refusal = !h ? 'Numbers go on land' : h.terrain === 'random' ? 'A random hex is dealt its number with its terrain' : h.terrain === 'sea' ? 'On the sea, use the fishing ground tool' : `${TERRAIN_NAMES[h.terrain as Terrain]} takes no number`;
    const cells = mirrored([[q, r]]);
    let refused = false;
    const ok = st.edit(
      (m) =>
        cells.reduce<CustomMap>((acc, [a, b]) => {
          const next = setNumber(acc, a, b, tool.n);
          if (!next && a === q && b === r) refused = true;
          return next ?? acc;
        }, m),
      cells.map(([a, b]) => key(a, b)),
    );
    if (refused) say(refusal);
    else if (ok) done('click');
    return;
  }
  if (tool.kind === 'port') {
    const at = harbourAt(map, x, z);
    if (!at) {
      say('Harbours go on the coast: a side of fixed land facing the sea');
      return;
    }
    // (The tapped side toggles; its images round the middle follow it, where they're coast too.)
    const images = turns.slice(1).map((t) => {
      const [a, b] = turn(at.q, at.r, t, pivot);
      return { q: a, r: b, side: (at.side + t) % 6 };
    });
    const ok = st.edit((m) => {
      const had = m.ports.find((p) => p.q === at.q && p.r === at.r && p.side === at.side);
      const next = setHarbour(m, at, tool.type);
      const removing = had?.type === tool.type;
      return images.reduce((acc, s) => {
        const there = acc.ports.find((p) => p.q === s.q && p.r === s.r && p.side === s.side);
        if (removing) return there ? { ...acc, ports: acc.ports.filter((p) => p !== there) } : acc;
        return there?.type === tool.type ? acc : setHarbour(acc, s, tool.type);
      }, next);
    }, [key(at.q, at.r), ...images.map((s) => key(s.q, s.r))]);
    if (ok) done('creak');
    return;
  }
  if (tool.kind === 'ground') {
    if (st.edit((m) => setGround(m, q, r), [key(q, r)], 'Fishing grounds go on the sea, beside the land')) done('reel');
    return;
  }
  if (tool.kind === 'river') {
    const res = riverAt(map, q, r, st.drawing);
    if (!res) {
      say('Rivers run over fixed land, from a spring to a swamp on the coast');
      return;
    }
    if (res.refused) {
      say(res.refused);
      return;
    }
    if (res.map !== map) st.edit(() => res.map, [key(q, r)]);
    st.set({ drawing: res.drawing });
    done(res.drawing === null ? 'chime' : 'splash', 0.5);
    return;
  }
  if (tool.kind === 'home') {
    if (homesFull(map, q, r)) {
      say(`A map holds at most ${MAX_HOMES} home islands: tap a marked one to unmark it`);
      return;
    }
    if (st.edit((m) => toggleHome(m, q, r), [key(q, r)], 'Home islands are marked on fixed land')) done('horn', 0.5);
    return;
  }
  const piece = tool.kind;
  if (st.edit((m) => setPiece(m, piece, q, r), [key(q, r)], piece === 'robber' ? 'The robber starts on fixed land' : 'The corsair starts on the open sea')) done(piece === 'robber' ? 'robber' : 'launch', 0.6);
}
