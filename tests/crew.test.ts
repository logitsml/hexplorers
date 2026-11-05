// The computer players' crew: who they are, which portrait and voice each has, and how a table's
// crew is drawn (without repeats, and the same from the same seed).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RULES_VERSION, Rng, createGame, dealBoard, seedFrom } from '../src/engine';
import { PERSONALITIES } from '../src/engine/ai';
import { TableTalk } from '../src/game/chat';
import { personalityOf } from '../src/game/host';
import { AVATARS, BOT_NAMES, avatarOf, pickCrew, voiceOf } from '../src/game/names';
import { loadSave, validSave, writeSave, type SavedGame } from '../src/game/save';
import { useUI } from '../src/game/store';
import { NAME_MAX } from '../src/net/protocol';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const seeded = (seed: number) => {
  const dice = new Rng(seedFrom(seed));
  return () => dice.next();
};

describe('the crew', () => {
  it('has the names it began with first, then a dozen more, none repeated', () => {
    expect(BOT_NAMES.slice(0, 4)).toEqual(['Captain Bramble', 'Wren Ashdown', 'Tobias Forge', 'Elder Quill']);
    expect(BOT_NAMES).toHaveLength(16);
    expect(new Set(BOT_NAMES.map((n) => n.toLowerCase())).size).toBe(BOT_NAMES.length);
    for (const n of BOT_NAMES) {
      expect(n.length).toBeLessThanOrEqual(NAME_MAX);
      expect(n).toBe(n.trim().replace(/\s+/g, ' '));
    }
  });

  it('never shares a first word, so naming one at the table names one', () => {
    const firsts = BOT_NAMES.map((n) => n.toLowerCase().split(' ')[0]);
    expect(new Set(firsts).size).toBe(BOT_NAMES.length);
    // (And no word of a name is another's.)
    const words = BOT_NAMES.flatMap((n) => n.toLowerCase().split(' '));
    expect(new Set(words).size).toBe(words.length);
  });

  it('gives each portrait four names and each voice four, the first four keeping their old portraits', () => {
    const faces = BOT_NAMES.map((n) => avatarOf(n));
    expect(faces.slice(0, 4)).toEqual([0, 1, 2, 3]);
    // (While the four portraits are all there are; the names that wait for portraits of their own then move to them.)
    if (AVATARS.length === 4) for (let a = 0; a < 4; a++) expect(faces.filter((f) => f === a)).toHaveLength(4);
    expect(faces.every((f) => f >= 0 && f < AVATARS.length)).toBe(true);
    for (const v of PERSONALITIES) expect(BOT_NAMES.filter((n) => voiceOf(n) === v)).toHaveLength(4);
    // A voice and a face go together: the first four's voices are the original order's.
    expect(BOT_NAMES.slice(0, 4).map((n) => personalityOf(n))).toEqual(['trader', 'settler', 'smith', 'scholar']);
    // Names that aren't the crew's have neither.
    expect(avatarOf('Spectated Bot')).toBe(-1);
    expect(personalityOf('Spectated Bot')).toBeUndefined();
  });

  it('wears a portrait of its own once one is listed, and the stand-in until then', () => {
    const listed = [...AVATARS];
    try {
      AVATARS.length = 4;
      expect(avatarOf('Tomas Halvorsen')).toBe(0);
      expect(avatarOf('Isidore Fenn')).toBe(3);
      // (As if avatar_5 to avatar_12 were painted and listed.)
      for (let i = 5; i <= 12; i++) AVATARS.push(`art/avatars/${i}.webp`);
      expect(avatarOf('Tomas Halvorsen')).toBe(4);
      expect(avatarOf('Isidore Fenn')).toBe(11);
      // The first eight are not moved: saves and rooms that name them keep their faces.
      expect(BOT_NAMES.slice(0, 8).map((n) => avatarOf(n))).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
      expect(new Set(BOT_NAMES.map((n) => avatarOf(n))).size).toBe(12);
      // A table of six still draws six, each its own face.
      const six = pickCrew(6, seeded(5));
      expect(new Set(six.map((n) => avatarOf(n))).size).toBe(6);
    } finally {
      AVATARS.length = 0;
      AVATARS.push(...listed);
    }
  });
});

describe('picking a table’s crew', () => {
  it('draws names without repeats, from the stream it is given', () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (const n of [1, 2, 3, 5, 6]) {
        const crew = pickCrew(n, seeded(seed));
        expect(crew).toHaveLength(n);
        expect(new Set(crew).size).toBe(n);
        for (const name of crew) expect(BOT_NAMES).toContain(name);
      }
    }
  });

  it('gives the same crew for the same seed, and others for others', () => {
    for (let seed = 1; seed <= 20; seed++) expect(pickCrew(3, seeded(seed))).toEqual(pickCrew(3, seeded(seed)));
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) for (const n of pickCrew(3, seeded(seed))) seen.add(n);
    // Over many games, everyone sails.
    expect([...seen].sort()).toEqual([...BOT_NAMES].sort());
    expect(new Set(Array.from({ length: 50 }, (_, i) => pickCrew(3, seeded(i + 1)).join('|'))).size).toBeGreaterThan(25);
  });

  it('seats three at a table with three faces and three voices', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const crew = pickCrew(3, seeded(seed));
      expect(new Set(crew.map((n) => avatarOf(n))).size).toBe(3);
      expect(new Set(crew.map((n) => voiceOf(n))).size).toBe(3);
    }
    // (With four portraits and four voices, four also differ from one another; beyond that, faces repeat before names.)
    for (let seed = 1; seed <= 100; seed++) expect(new Set(pickCrew(4, seeded(seed)).map((n) => avatarOf(n))).size).toBe(4);
    const five = pickCrew(5, seeded(9));
    expect(new Set(five).size).toBe(5);
  });

  it('plays without the face a person took, and without the names already seated', () => {
    for (let seed = 1; seed <= 100; seed++) {
      for (let face = 0; face < AVATARS.length; face++) {
        const crew = pickCrew(3, seeded(seed), { faces: [face] });
        expect(crew.map((n) => avatarOf(n))).not.toContain(face);
        expect(crew).toHaveLength(3);
      }
      const seated = ['Captain Bramble', 'Bosun Pellow'];
      const next = pickCrew(2, seeded(seed), { taken: seated });
      for (const n of next) expect(seated).not.toContain(n);
      // (A person who took a crew member's own name is not drawn a second one.)
      expect(pickCrew(16, seeded(seed), { taken: ['Wren Ashdown'] })).not.toContain('Wren Ashdown');
      // The faces and voices of those seated count as worn.
      expect(avatarOf(pickCrew(1, seeded(seed), { taken: ['Captain Bramble', 'Marisol Venn'] })[0])).toBeGreaterThanOrEqual(2);
    }
  });

  it('runs out only when the crew does', () => {
    expect(new Set(pickCrew(16, seeded(1)))).toEqual(new Set(BOT_NAMES));
    expect(pickCrew(20, seeded(1))).toHaveLength(16);
    expect(pickCrew(1, seeded(1), { taken: BOT_NAMES })).toEqual([]);
    expect(pickCrew(0, seeded(1))).toEqual([]);
  });
});

describe('older games keep their crew', () => {
  beforeEach(() => store.clear());

  const board = dealBoard(4, { seed: 77 });
  const game = (names: string[], avatars: number[]): SavedGame => ({
    v: 3,
    rules: RULES_VERSION,
    cfg: { name: 'You', color: 'red', opponents: 3, difficulty: 'normal', layout: 'random', numberPlacement: 'balanced', seed: 77, board },
    seats: [
      { name: 'You', color: 'red', isBot: false, difficulty: 'normal' },
      ...names.map((name, i) => ({ name, color: (['blue', 'white', 'orange'] as const)[i], isBot: true, difficulty: 'normal' as const })),
    ],
    avatars,
    history: [],
    turn: 0,
    savedAt: 1,
  });

  it('loads a save made with the four names it began with, as it was', () => {
    // As the old session wrote it: the portraits by the names' order, shuffled.
    const old = game(['Tobias Forge', 'Captain Bramble', 'Elder Quill'], [-1, 2, 0, 3]);
    expect(validSave(old)).toBe(true);
    writeSave(old);
    const back = loadSave()!;
    expect(back.seats.map((s) => s.name)).toEqual(['You', 'Tobias Forge', 'Captain Bramble', 'Elder Quill']);
    expect(back.avatars).toEqual([-1, 2, 0, 3]);
    // Their portraits and characters are the same ones the save recorded.
    expect(back.seats.slice(1).map((s) => avatarOf(s.name))).toEqual(back.avatars.slice(1));
    expect(back.seats.slice(1).map((s) => personalityOf(s.name))).toEqual(['smith', 'trader', 'scholar']);
  });

  it('loads a save whose crew are no one’s now, or whose portrait is not listed', () => {
    const odd = game(['Forgotten Sailor', 'Captain Bramble', 'Marisol Venn'], [-1, -1, 0, 9]);
    expect(validSave(odd)).toBe(true);
    writeSave(odd);
    expect(loadSave()!.seats[1].name).toBe('Forgotten Sailor');
    expect(personalityOf('Forgotten Sailor')).toBeUndefined();
  });
});

describe('talking to the crew', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUI.getState().set({ chat: [], chatUnread: 0, chatOpen: false });
  });

  const seats = [
    { name: 'You', color: 'red' as const, isBot: false },
    { name: 'Ned Fairweather', color: 'blue' as const, isBot: true },
    { name: 'Rahim Thorley', color: 'white' as const, isBot: true },
  ];

  it('is answered by the one named, by any word of their name, whole words only', () => {
    for (const [said, who] of [['Ned, any ore?', 1], ['rahim: any ore to spare?', 2], ['Thorley, have you ore?', 2], ['Fairweather, ore?', 1]] as const) {
      useUI.getState().set({ chat: [], chatUnread: 0 });
      const { state } = createGame(seats, { seed: 3 });
      state.players[1].hand.ore = 3;
      state.players[2].hand.ore = 3;
      new TableTalk(0, () => state).hear(said);
      vi.advanceTimersByTime(5000);
      expect(useUI.getState().chat.map((l) => l.player), said).toEqual([who]);
    }
    vi.useRealTimers();
  });

  it('speaks in the voice of its character, whoever it is', () => {
    expect(personalityOf('Ned Fairweather')).toBe('trader');
    expect(personalityOf('Rahim Thorley')).toBe('scholar');
  });
});
