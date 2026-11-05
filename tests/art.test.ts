// The painted art the interface asks for (src/game/names.ts): every path in the maps is a file
// under public/, every venture and muster card has its own painting, and no card or token still
// borrows another's icon.

import { describe, expect, it } from 'vitest';
import { VENTURES } from '../src/engine/modules/guilds/ventures';
import { AVATARS, AWARD_ART, CARD_ICON, DEV_ART, HAPPENING_ART, MUSTER_ART, SEAT_ART, TOKEN_ICON, TRACK_ICON, UI_ICON, VENTURE_ART, VP_VARIANTS } from '../src/game/names';

/** Every painting shipped, by its path under public/ (Vite lists them without loading any). */
const SHIPPED = new Set(Object.keys(import.meta.glob('../public/art/**/*.webp')).map((k) => k.replace('../public/', '')));

const MAPS: Record<string, Record<string, string>> = {
  CARD_ICON,
  TOKEN_ICON,
  TRACK_ICON,
  UI_ICON,
  DEV_ART,
  VENTURE_ART,
  MUSTER_ART,
  HAPPENING_ART,
  AWARD_ART,
  SEAT_ART,
  VP_VARIANTS: Object.fromEntries(VP_VARIANTS.map((v) => [v.name, v.art])),
  AVATARS: Object.fromEntries(AVATARS.map((a, i) => [i, a])),
};

describe('the art maps', () => {
  for (const [map, paths] of Object.entries(MAPS)) {
    it(`${map}: every file is there`, () => {
      const missing = Object.entries(paths).filter(([, p]) => !SHIPPED.has(p));
      expect(missing).toEqual([]);
    });
  }

  it('every venture has a painting, and only the six newest may borrow an older card’s until they have their own', () => {
    expect(Object.keys(VENTURE_ART).sort()).toEqual(Object.keys(VENTURES).sort());
    const NEW = ['salvage', 'pilot', 'tradeWind', 'customs', 'stockpile', 'lighthouse'];
    const paths = Object.values(VENTURE_ART);
    // No two cards share a painting, unless a new card still borrows (then it duplicates an older one).
    const ownIds = Object.keys(VENTURE_ART).filter((id) => VENTURE_ART[id as keyof typeof VENTURE_ART] === `art/ventures/${id}.webp`);
    for (const id of Object.keys(VENTURE_ART)) if (!NEW.includes(id)) expect(ownIds).toContain(id);
    const borrowing = NEW.filter((id) => !ownIds.includes(id));
    expect(paths.length - new Set(paths).size).toBe(borrowing.length);
  });

  it('no card or token borrows another icon', () => {
    const icons = [...Object.values(CARD_ICON), ...Object.values(TOKEN_ICON), ...Object.values(TRACK_ICON)];
    expect(new Set(icons).size).toBe(icons.length);
    // (The UI icons are the base game's buttons: a card showing one is a stand-in.)
    const ui = new Set<string>(Object.values(UI_ICON));
    expect(icons.filter((p) => ui.has(p))).toEqual([]);
  });
});
