// A room's settings: the defaults, a host's change checked against the engine, and the game
// options they make. Knobs come only from the named presets (engine/presets.ts); everything else
// goes through validateOptions, and a custom map through the engine's own map check.

import { DEFAULT_OPTIONS, MODULE_IDS, createGame, validateOptions, type GameOptions } from '../../src/engine';
import { MODULES } from '../../src/engine/modules';
import { checkCustomMap, parseCustomMap, type CustomMap } from '../../src/engine/maps/custom';
import { PRESETS, mixOf, poolFor, targetFor, expansionsOf, type Expansion } from '../../src/engine/presets';
import { CUSTOM_MAP_MAX_BYTES, CUSTOM_MAP_MAX_HARBOURS, type RoomSettings } from '../../src/net/protocol';

export const DEFAULT_SETTINGS: RoomSettings = {
  seats: 4,
  preset: 'base',
  modules: [],
  map: 'classic',
  layout: 'random',
  numberPlacement: 'spiral',
  victoryPoints: 10,
  friendlyRobber: false,
  eventDeck: false,
  knobs: {},
  timer: 'standard',
  spectators: 'link',
  botsFill: true,
  botDifficulty: 'normal',
  takeBacks: true,
  freeChat: true,
  rated: false,
};

export type SettingsResult = { ok: true; settings: RoomSettings } | { ok: false; error: string };

/**
 * `patch` applied to `current` and checked. Choosing a preset brings its expansions, map, knobs and
 * target (each may still be set in the same patch, within what the preset allows: the knobs never).
 */
export function applySettings(current: RoomSettings, patch: Partial<RoomSettings>, custom: CustomMap | null): SettingsResult {
  const next: RoomSettings = { ...current, ...patch, knobs: { ...(patch.knobs ?? current.knobs) } };
  if (patch.preset !== undefined && patch.preset !== current.preset) {
    const preset = PRESETS.find((p) => p.id === patch.preset);
    if (preset) {
      const mix = mixOf(preset.expansions);
      next.modules = mix.modules;
      next.map = patch.map ?? mix.map;
      next.knobs = { ...mix.knobs };
      next.victoryPoints = patch.victoryPoints ?? mix.target;
    } else if (patch.preset === 'base') {
      next.modules = [];
      next.map = patch.map ?? 'classic';
      next.knobs = {};
      next.victoryPoints = patch.victoryPoints ?? 10;
    } else if (patch.preset !== 'custom') return { ok: false, error: `No such preset: ${patch.preset}.` };
  }
  // Knobs only as a preset sets them.
  const preset = PRESETS.find((p) => p.id === next.preset);
  const knobs = preset ? (mixOf(preset.expansions).knobs ?? {}) : {};
  if (JSON.stringify(sortKeys(next.knobs)) !== JSON.stringify(sortKeys(knobs))) return { ok: false, error: 'Knobs come only from the presets.' };
  if (preset) {
    const mods = mixOf(preset.expansions).modules;
    if (mods.length !== next.modules.length || mods.some((m) => !next.modules.includes(m))) return { ok: false, error: `The ${preset.name} preset plays its own expansions.` };
  }
  if (next.preset === 'base' && next.modules.length > 0) return { ok: false, error: 'The base game plays no expansions.' };
  // Modules as the expansions make them (a mix the set-up page could make), in canonical order.
  const exps = expansionsOf(next.modules);
  const made = mixOf(exps).modules;
  if (made.length !== next.modules.length || made.some((m) => !next.modules.includes(m))) return { ok: false, error: 'Those modules are not a mix of expansions.' };
  next.modules = MODULE_IDS.filter((m) => next.modules.includes(m));
  if (next.map === 'custom') {
    if (!custom) return { ok: false, error: 'Upload the custom map first.' };
  } else if (!poolFor(exps).includes(next.map)) return { ok: false, error: `The ${next.map} map isn't one that mix plays on.` };
  try {
    validateOptions(gameOptions(next, custom, 0));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, settings: next };
}

const sortKeys = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));

/** The options a game in this room is created with (complete: the reveal and the replay carry them whole). */
export function gameOptions(s: RoomSettings, custom: CustomMap | null, seed: number): GameOptions {
  const modules = MODULE_IDS.filter((m) => s.modules.includes(m));
  const moduleRules = Object.fromEntries(modules.map((m) => [m, MODULES[m].rulesVersion])) as GameOptions['moduleRules'];
  const o: GameOptions = {
    ...DEFAULT_OPTIONS,
    playerCount: s.seats,
    victoryPoints: s.victoryPoints,
    layout: s.layout,
    numberPlacement: s.numberPlacement,
    seed,
    friendlyRobber: s.friendlyRobber,
    eventDeck: s.eventDeck,
    modules,
    moduleRules,
    map: s.map,
    knobs: { ...s.knobs },
    rng: 'chacha20',
  };
  if (s.map === 'custom' && custom) o.custom = custom;
  return o;
}

/** A custom map sent to a room: parsed and checked by the engine for this room's game, or why not. */
export function checkRoomMap(raw: unknown, s: RoomSettings): { ok: true; map: CustomMap } | { ok: false; error: string } {
  let size = 0;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    return { ok: false, error: 'Not a map.' };
  }
  if (size > CUSTOM_MAP_MAX_BYTES) return { ok: false, error: 'That map is too large.' };
  const map = parseCustomMap(raw);
  if (!map) return { ok: false, error: 'Not a map.' };
  if (map.ports.length > CUSTOM_MAP_MAX_HARBOURS) return { ok: false, error: 'Too many harbours.' };
  const exps = expansionsOf(s.modules) as Expansion[];
  const extra = Math.max(0, targetFor(exps, 'custom') - 10);
  const check = checkCustomMap(map, {
    players: s.seats,
    victoryPoints: s.victoryPoints,
    modules: s.modules,
    extra,
    tryGame: (seed) => {
      const seats = Array.from({ length: s.seats }, (_, i) => ({ name: `P${i}`, color: '', isBot: true }));
      createGame(seats, { ...gameOptions({ ...s, map: 'custom' }, map, seed), rng: undefined, layout: 'random' });
    },
  });
  if (check.errors.length > 0) return { ok: false, error: check.errors[0] };
  return { ok: true, map };
}
