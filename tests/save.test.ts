import { beforeEach, describe, expect, it } from 'vitest';
import { RULES_VERSION, dealBoard } from '../src/engine';
import { MODULES } from '../src/engine/modules';
import { clearSave, loadLastGame, loadSave, serializeSave, validSave, writeLastGame, writeSave, type SavedGame } from '../src/game/save';
import { addEvents, emptyStats } from '../src/game/stats';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const BOARD = dealBoard(3, { seed: 1234, numberPlacement: 'balanced' });

/** A base game, as the session saves it: format 3, stamped with the rules, with the board it was dealt. */
const base = (): SavedGame => ({
  v: 3,
  rules: RULES_VERSION,
  cfg: { name: 'You', color: 'red', opponents: 2, difficulty: 'normal', layout: 'random', numberPlacement: 'balanced', seed: 1234, board: BOARD },
  seats: [
    { name: 'You', color: 'red', isBot: false, difficulty: 'normal' },
    { name: 'Wren Ashdown', color: 'blue', isBot: true, difficulty: 'normal' },
    { name: 'Tobias Forge', color: 'white', isBot: true, difficulty: 'normal' },
  ],
  avatars: [-1, 1, 2],
  history: [{ actor: 0, action: { type: 'placeSetupSettlement', vertex: 3 } }],
  turn: 0,
  savedAt: 1,
});

// An expansion game: stamped with each module's version too.
const withModules = (): SavedGame => ({
  ...base(),
  cfg: { ...base().cfg, modules: ['rivers', 'oil'], board: dealBoard(3, { seed: 1234, modules: ['rivers', 'oil'] }) },
  moduleRules: { rivers: MODULES.rivers.rulesVersion, oil: MODULES.oil.rulesVersion },
});

describe('saves', () => {
  beforeEach(() => store.clear());

  it('drops a save from before boards were carried (formats 1 and 2), and forgets it', () => {
    const { board, ...cfg } = base().cfg;
    expect(board).toBeDefined();
    for (const old of [{ ...base(), v: 1, rules: undefined, cfg }, { ...base(), v: 2, cfg }, { ...base(), v: 2 }]) {
      expect(validSave(old)).toBe(false);
      store.set('exploratory.save.v1', JSON.stringify(old));
      expect(loadSave()).toBeNull();
      expect(store.has('exploratory.save.v1')).toBe(false);
    }
  });

  it('writes format 3 stamped with the rules and the board, and reads it back unchanged', () => {
    writeSave(base());
    const raw = JSON.parse(store.get('exploratory.save.v1')!);
    expect(raw).toMatchObject({ v: 3, rules: RULES_VERSION });
    expect(raw.cfg.board).toEqual(BOARD);
    expect(loadSave()).toEqual(raw);
    // A game kept on older rules says so.
    writeLastGame({ ...base(), rules: 1 });
    expect(loadLastGame()).toMatchObject({ v: 3, rules: 1 });
    clearSave();
    expect(loadSave()).toBeNull();
  });

  it('keeps the rules version of each module with an expansion game, and reads it back unchanged', () => {
    const save = withModules();
    expect(validSave(save)).toBe(true);
    expect(JSON.parse(serializeSave(save)).moduleRules).toEqual({ rivers: MODULES.rivers.rulesVersion, oil: 1 });
    writeSave(save);
    expect(loadSave()).toEqual(JSON.parse(store.get('exploratory.save.v1')!));
    expect(loadSave()).toMatchObject({ v: 3, rules: RULES_VERSION, moduleRules: { rivers: MODULES.rivers.rulesVersion, oil: 1 } });
    writeLastGame(save);
    expect(loadLastGame()).toMatchObject({ moduleRules: { rivers: MODULES.rivers.rulesVersion, oil: 1 } });
  });

  it('still loads a game saved under the first Rivers rules, keeping its stamp so it plays by them', () => {
    const old = { ...withModules(), moduleRules: { rivers: 1, oil: 1 } };
    expect(validSave(old)).toBe(true);
    writeSave(old);
    expect(loadSave()).toMatchObject({ moduleRules: { rivers: 1, oil: 1 } });
  });

  it('asks a base game for no module versions, and refuses one that has them', () => {
    writeSave(base());
    expect(JSON.parse(store.get('exploratory.save.v1')!)).not.toHaveProperty('moduleRules');
    expect(loadSave()).not.toBeNull();
    expect(validSave(base())).toBe(true);
    expect(validSave({ ...base(), cfg: { ...base().cfg, modules: [] } })).toBe(true);
    expect(validSave({ ...base(), moduleRules: {} })).toBe(false);
    expect(validSave({ ...base(), cfg: { ...base().cfg, modules: [] }, moduleRules: { rivers: 1 } })).toBe(false);
  });

  it('turns away an expansion game with no stamp, or one that is not for its modules', () => {
    const { moduleRules, ...unstamped } = withModules();
    expect(moduleRules).toBeDefined();
    const bad: ((s: SavedGame) => unknown)[] = [
      // Without a stamp, or damaged.
      () => unstamped,
      (s) => ({ ...s, moduleRules: undefined }),
      (s) => ({ ...s, moduleRules: null }),
      (s) => ({ ...s, moduleRules: [1, 1] }),
      (s) => ({ ...s, moduleRules: {} }),
      // A module in play without a version, or a version for a module that isn't.
      (s) => ({ ...s, moduleRules: { rivers: 1 } }),
      (s) => ({ ...s, moduleRules: { ...s.moduleRules, fisheries: 1 } }),
      (s) => ({ ...s, moduleRules: { ...s.moduleRules, nonsense: 1 } }),
      // A version that doesn't exist: before the first, or not a whole number.
      (s) => ({ ...s, moduleRules: { ...s.moduleRules, oil: 0 } }),
      (s) => ({ ...s, moduleRules: { ...s.moduleRules, oil: 1.5 } }),
      (s) => ({ ...s, moduleRules: { ...s.moduleRules, oil: '1' } }),
    ];
    for (const f of bad) {
      expect(validSave(f(withModules())), JSON.stringify(f(withModules()))).toBe(false);
      store.set('exploratory.save.v1', JSON.stringify(f(withModules())));
      expect(loadSave()).toBeNull();
      expect(store.has('exploratory.save.v1')).toBe(false);
    }
  });

  it('turns away damaged or impossible saves, and forgets them', () => {
    const bad: ((s: SavedGame) => unknown)[] = [
      (s) => ({ ...s, rules: undefined }),
      (s) => ({ ...s, cfg: { ...s.cfg, seed: 2 ** 32 } }),
      (s) => ({ ...s, cfg: { ...s.cfg, seed: -1 } }),
      (s) => ({ ...s, cfg: { ...s.cfg, seed: 1.5 } }),
      (s) => ({ ...s, cfg: { ...s.cfg, difficulty: 'nightmare' } }),
      (s) => ({ ...s, cfg: { ...s.cfg, numberPlacement: undefined } }),
      (s) => ({ ...s, cfg: { ...s.cfg, victoryPoints: 99 } }),
      (s) => ({ ...s, cfg: { ...s.cfg, friendlyRobber: 'yes' } }),
      (s) => ({ ...s, seats: s.seats.map((x, i) => (i === 1 ? { ...x, difficulty: 'nightmare' } : x)) }),
      (s) => ({ ...s, history: [{ actor: 3, action: { type: 'endTurn' } }] }),
      (s) => ({ ...s, avatars: [1] }),
      (s) => ({ ...s, turn: 'three' }),
      // A board a game can't be built from.
      (s) => ({ ...s, cfg: { ...s.cfg, board: { ...BOARD, hexes: [] } } }),
      (s) => ({ ...s, cfg: { ...s.cfg, board: { ...BOARD, ports: [{ q: 99, r: 0, side: 0, type: 'any' }] } } }),
    ];
    for (const f of bad) {
      expect(validSave(f(base()))).toBe(false);
      store.set('exploratory.save.v1', JSON.stringify(f(base())));
      expect(loadSave()).toBeNull();
      expect(store.has('exploratory.save.v1')).toBe(false);
    }
    expect(validSave({ ...base(), cfg: { ...base().cfg, victoryPoints: 12, friendlyRobber: true, eventDeck: false } })).toBe(true);
    store.set('exploratory.save.v1', '{not json');
    expect(loadSave()).toBeNull();
  });

  it('leaves a save from a later version alone: not read, and not forgotten', () => {
    const later: (() => unknown)[] = [
      () => ({ ...base(), v: 4 }),
      () => ({ ...base(), rules: RULES_VERSION + 1 }),
      () => ({ ...withModules(), moduleRules: { ...withModules().moduleRules, rivers: MODULES.rivers.rulesVersion + 1 } }),
      () => ({ ...withModules(), cfg: { ...withModules().cfg, modules: ['rivers', 'oil', 'glaciers'] }, moduleRules: { ...withModules().moduleRules, glaciers: 1 } }),
    ];
    for (const f of later) {
      expect(validSave(f())).toBe(false);
      store.set('exploratory.save.v1', JSON.stringify(f()));
      expect(loadSave()).toBeNull();
      expect(store.has('exploratory.save.v1')).toBe(true);
    }
  });

  it('forgets the save when a new one can’t be written, rather than resuming an older position', () => {
    writeSave(base());
    const setItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    try {
      writeSave({ ...base(), turn: 4 });
    } finally {
      localStorage.setItem = setItem;
    }
    expect(loadSave()).toBeNull();
  });
});

describe('game statistics', () => {
  it('counts rolls, production by player and steals', () => {
    const st = emptyStats();
    addEvents(st, [
      { type: 'diceRolled', player: 0, dice: [3, 5], total: 8 },
      { type: 'production', total: 8, blockedHexes: [], shortages: [], grants: [
        { player: 1, hex: 0, vertex: 0, resource: 'ore', amount: 2 },
        { player: 2, hex: 0, vertex: 1, resource: 'ore', amount: 1 },
        { player: 1, hex: 3, vertex: 9, resource: 'wool', amount: 1 },
      ] },
      { type: 'diceRolled', player: 1, dice: [3, 4], total: 7 },
      { type: 'stolen', thief: 1, victim: 2, resource: 'ore' },
      { type: 'diceRolled', player: 2, dice: [4, 4], total: 8 },
    ]);
    expect(st.rolls[8]).toBe(2);
    expect(st.rolls[7]).toBe(1);
    expect(st.rolls.reduce((a, b) => a + b, 0)).toBe(3);
    expect(st.produced).toEqual({ 1: 3, 2: 1 });
    expect(st.stolen).toEqual({ 1: 1 });
  });
});
