// Save and resume. The engine is deterministic, so a game is stored as its seats, its options
// (including the seed and the board as it was dealt) and the list of actions taken; resuming replays
// them.
//
// Format 3 carries `rules`, the rules version the game is played under (see RULES_VERSION), so a
// game recorded before a rules change replays under the rules it was played with, and the board
// (`cfg.board`, see engine/maps/deal.ts), so how maps are dealt can change without touching it. A
// game with expansions also carries `moduleRules`, the rules version each of its modules was created
// under (see RuleModule.rulesVersion), so a change to one module leaves the games recorded under it
// replayable; it is present exactly when the game has modules. Saves of formats 1 and 2 carry no
// board, only a seed for a way of dealing this game doesn't have: they're dropped.

import { parseCustomMap } from '../engine/maps/custom';
import { boardProblems } from '../engine/maps/stored';
import type { BoardSpec } from '../engine/board';
import { KNOB_TYPES, MAX_VICTORY_POINTS, MIN_VICTORY_POINTS, MODULE_IDS, RULES_VERSION, type Action, type GameOptions, type GameSecret, type Knobs, type ModuleId, type ModuleRules, type PlayerId } from '../engine';
import type { BotDifficulty } from '../engine/ai';
import { MODULES } from '../engine/modules';
import type { SeatConfig } from './host';
import type { NewGameConfig } from '../app/session';

const KEY = 'exploratory.save.v1';

/** This tab's name, stamped on every save it writes, so a tab can tell a save another tab has taken over. */
export const TAB = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export interface SavedGame {
  v: 3;
  /** Rules version the game is played under. */
  rules: number;
  /** The rules version each module in play was created under (present exactly when `cfg.modules` is non-empty). */
  moduleRules?: ModuleRules;
  cfg: NewGameConfig & { seed: number; board: BoardSpec };
  seats: SeatConfig[];
  avatars: number[];
  history: { actor: PlayerId; action: Action }[];
  turn: number;
  savedAt: number;
  /** The tab that last wrote this save (see TAB): a game open in two tabs is kept by one of them at a time. */
  tab?: string;
  /** An online game's replay (never saved): its dice stream, the key revealed at its end, and whether the dice checked out (see online/replay.ts). */
  online?: { rng?: GameOptions['rng']; secret?: GameSecret; fair: boolean };
}

const DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];
const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
const optional = (x: unknown, ok: (x: unknown) => boolean) => x === undefined || ok(x);

/** A stamp for exactly these modules, each at a version it has had (1 up to its current one). */
function validModuleRules(x: unknown, modules: readonly ModuleId[]): boolean {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const stamp = x as Record<string, unknown>;
  return Object.keys(stamp).every((k) => modules.includes(k as ModuleId)) && modules.every((id) => isInt(stamp[id], 1, MODULES[id].rulesVersion));
}

/** Shape check, so a save from another version (or a damaged one) can't crash the title screen or a game. */
export function validSave(s: unknown): s is SavedGame {
  if (!s || typeof s !== 'object') return false;
  const g = s as Partial<SavedGame>;
  const cfg = g.cfg as Partial<SavedGame['cfg']> & Record<string, unknown> | undefined;
  if (g.v !== 3 || !isInt(g.rules, 1, RULES_VERSION)) return false;
  if (!cfg || typeof cfg !== 'object') return false;
  // The seed is hashed as 32 bits: anything else would quietly become another island.
  if (!isInt(cfg.seed, 0, 0xffffffff)) return false;
  if (cfg.layout !== 'random' && cfg.layout !== 'beginner') return false;
  if (cfg.numberPlacement !== 'spiral' && cfg.numberPlacement !== 'balanced') return false;
  if (!DIFFICULTIES.includes(cfg.difficulty as BotDifficulty)) return false;
  if (!optional(cfg.victoryPoints, (x) => isInt(x, MIN_VICTORY_POINTS, MAX_VICTORY_POINTS))) return false;
  if (!optional(cfg.friendlyRobber, (x) => typeof x === 'boolean') || !optional(cfg.eventDeck, (x) => typeof x === 'boolean')) return false;
  // The expansions (absent in a base game). Which mixes can be played together is the engine's to say.
  if (!optional(cfg.modules, (x) => Array.isArray(x) && x.every((m) => MODULE_IDS.includes(m as ModuleId)))) return false;
  // (A save with modules and no stamp is an expansion game from before modules were versioned. The
  // shared shaping changed in the same pass, and a save holds no record of the state it reached, so
  // a replay that stays legal could still be another game: it's dropped rather than stamped with a guess.)
  const modules = (cfg.modules ?? []) as ModuleId[];
  if (modules.length > 0 ? !validModuleRules(g.moduleRules, modules) : g.moduleRules !== undefined) return false;
  if (!optional(cfg.map, (x) => typeof x === 'string')) return false;
  // (A custom map is carried whole, so the game can be resumed and replayed whatever becomes of the editor's copy.)
  if ((cfg.map === 'custom') !== (cfg.custom !== undefined) || !optional(cfg.custom, (x) => parseCustomMap(x) !== null)) return false;
  // (The board it was dealt, one a game can be built from.)
  if (!cfg.board || boardProblems(cfg.board).length > 0) return false;
  if (!optional(cfg.knobs, (x) => !!x && typeof x === 'object' && Object.entries(x).every(([k, v]) => k in KNOB_TYPES && typeof v === KNOB_TYPES[k as keyof Knobs]))) return false;
  if (!Array.isArray(g.seats) || g.seats.length < 3 || g.seats.length > 4) return false;
  if (!g.seats.every((x) => x && typeof x.name === 'string' && typeof x.color === 'string' && typeof x.isBot === 'boolean' && optional(x.difficulty, (d) => DIFFICULTIES.includes(d as BotDifficulty)))) return false;
  if (!Array.isArray(g.avatars) || g.avatars.length !== g.seats.length || !g.avatars.every((a) => Number.isInteger(a))) return false;
  const n = g.seats.length;
  if (!Array.isArray(g.history) || !g.history.every((h) => h && isInt(h.actor, 0, n - 1) && h.action && typeof (h.action as { type?: unknown }).type === 'string')) return false;
  return isInt(g.turn, 0, 1e6);
}

/**
 * Written by a later version of the game: a newer format, rules or module version, or a module
 * this version doesn't know. Such a save is left alone rather than dropped (a tab still open on an
 * older release, or a release rolled back, mustn't delete the game the newer one is playing).
 */
function fromNewer(s: unknown): boolean {
  if (!s || typeof s !== 'object') return false;
  const g = s as { v?: unknown; rules?: unknown; moduleRules?: unknown; cfg?: { modules?: unknown } };
  if (Number.isInteger(g.v) && (g.v as number) > 3) return true;
  if (Number.isInteger(g.rules) && (g.rules as number) > RULES_VERSION) return true;
  if (Array.isArray(g.cfg?.modules) && g.cfg.modules.some((m) => !MODULE_IDS.includes(m as ModuleId))) return true;
  const stamp = g.moduleRules;
  return !!stamp && typeof stamp === 'object' && Object.entries(stamp).some(([id, v]) => MODULE_IDS.includes(id as ModuleId) && Number.isInteger(v) && (v as number) > MODULES[id as ModuleId].rulesVersion);
}

/** A save or a finished game that this version can't play back (its options or its moves are refused). */
export class SaveUnusable extends Error {
  constructor(cause: unknown) {
    super(`the saved game can't be played back: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

function read(key: string): SavedGame | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const s: unknown = JSON.parse(raw);
    if (validSave(s)) return s;
    if (!fromNewer(s)) localStorage.removeItem(key);
  } catch {
    /* unreadable or storage blocked */
  }
  return null;
}

/**
 * What is written: format 3, stamped with the game's rules. A game's `moduleRules` is written as it
 * is, never filled in: only the game itself knows which versions its modules were created under.
 */
export function serializeSave(s: SavedGame): string {
  return JSON.stringify({ ...s, v: 3 });
}

export function loadSave(): SavedGame | null {
  return read(KEY);
}

/** Calls `cb` when another tab writes or clears the solo save (the single slot every tab shares). Returns the way to stop. */
export function watchSave(cb: () => void): () => void {
  const on = (e: StorageEvent) => {
    // (A null key is the whole storage cleared.)
    if (e.key === null || e.key === KEY) cb();
  };
  window.addEventListener('storage', on);
  return () => window.removeEventListener('storage', on);
}

/** Whether the kept solo game is this tab's to write (it was last written here, or nothing is kept). */
export function ownsSave(): boolean {
  const s = loadSave();
  return !s || s.tab === TAB;
}

/** Keeps the game (stamped as this tab's); false when it couldn't be kept. */
export function writeSave(s: SavedGame): boolean {
  try {
    localStorage.setItem(KEY, serializeSave({ ...s, tab: TAB }));
    return true;
  } catch {
    // Storage full or blocked: the game simply isn't resumable. (The save before it goes too, or
    // Continue would quietly take you back to an older position, or to the game before this one.)
    clearSave();
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// The last finished game, kept for its replay (the save itself is dropped when a game ends).
const LAST = 'exploratory.lastGame.v1';

export function loadLastGame(): SavedGame | null {
  return read(LAST);
}

export function clearLastGame() {
  try {
    localStorage.removeItem(LAST);
  } catch {
    /* ignore */
  }
}

export function writeLastGame(s: SavedGame) {
  try {
    localStorage.setItem(LAST, serializeSave(s));
  } catch {
    /* storage full or blocked: no replay from the title screen */
  }
}
