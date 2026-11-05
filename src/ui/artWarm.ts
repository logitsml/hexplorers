// The interface's painted art, decoded before it's needed. A card flying from the board to the
// hand, a new stack in the hand, a development card turned over: each is a new <img>, and a
// phone decodes it on its own time, so on a busy frame (a turn's animations, a shader building)
// it flew or stood blank. Decoded once here and held, the browser keeps the decoded copies.

import { AVATARS, AWARD_ART, CARD_ICON, DEV_ART, SEAT_ART, TOKEN_ICON, TRACK_ICON, UI_ICON, VP_VARIANTS, asset } from '../game/names';

const held = new Map<string, HTMLImageElement>();

function warm(paths: Iterable<string>) {
  for (const p of paths) {
    if (held.has(p)) continue;
    const img = new Image();
    img.decoding = 'async';
    img.src = asset(p);
    held.set(p, img);
    // (A file that fails here fails where it's shown too, and says so there.)
    img.decode().catch(() => {});
  }
}

/** The icons (resources, tokens, the HUD's) and the avatars: small, and on screen in every game. */
export function warmIcons() {
  warm([...Object.values(CARD_ICON), ...Object.values(TOKEN_ICON), ...Object.values(TRACK_ICON), ...Object.values(UI_ICON), ...AVATARS]);
}

/** The cards' and awards' paintings: larger, first seen once a game is under way. */
export function warmCards() {
  warm([...Object.values(DEV_ART), ...VP_VARIANTS.map((v) => v.art), ...Object.values(AWARD_ART), ...Object.values(SEAT_ART)]);
}
