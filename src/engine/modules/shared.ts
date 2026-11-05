// Queries and changes that cross module lines: what one module may read of another's state, and
// the few changes another module may make to it. Each works whether or not that module is in play.

import type { GameState, PlayerId } from '../types';
import type { EventFace } from './guilds/types';
import { legalShips } from './sea/rules';

/**
 * A fresh id for a warden about to be placed, from the one counter every module that places
 * wardens shares (Garrisons recruits them, Invasion's muster deck raises them). The first is 1.
 * (Past any id already on the board too, so a patched scene can't collide with it.)
 */
export function newWardenId(s: GameState): number {
  const id = Math.max(s.nextWardenId ?? 1, ...s.wardens.map((w) => w.id + 1));
  s.nextWardenId = id + 1;
  return id;
}

/** Raiders standing on a hex (Invasion). */
export const raidersOn = (s: GameState, hex: number): number => s.ext.invasion?.raiders[hex] ?? 0;

/** A hex the raiders hold (three of them on it): it produces nothing and can't be built on. */
export const isConquered = (s: GameState, hex: number): boolean => raidersOn(s, hex) >= 3;

/**
 * A building the raiders have cut off: every land hex it touches is conquered (it touches only
 * conquered land and the sea). A city holding a seat is never conquered (it's a cut-off seat).
 */
export function buildingConquered(s: GameState, vertex: number): boolean {
  if (!s.ext.invasion) return false;
  const b = s.buildings[vertex];
  if (!b || b.seat) return false;
  return cutOff(s, vertex);
}

/** Every land hex at `vertex` is conquered (whatever stands there). */
export function cutOff(s: GameState, vertex: number): boolean {
  if (!s.ext.invasion) return false;
  const land = s.board.vertices[vertex].hexes.filter((h) => s.board.hexes[h].terrain !== 'sea');
  return land.length > 0 && land.every((h) => isConquered(s, h));
}

/** The corsair's hex (Sea Lanes), or null when it's off the board or there is no sea. */
export const corsairHex = (s: GameState): number | null => s.ext.sea?.corsair ?? null;

/**
 * Whether the corsair stays beside Invasion (the corsairStays knob, All Hands' decision 1). Without
 * it, Invasion takes over the 7's theft and so removes every blocker, the corsair too (rule 4).
 */
export const corsairStays = (s: GameState): boolean => !!s.options.knobs.corsairStays;

/** Move the corsair (the Almanac's happening, Fisheries' fish action). Callers emit their own event. */
export function setCorsair(s: GameState, hex: number | null) {
  if (s.ext.sea) s.ext.sea.corsair = hex;
}

/** This turn's event die face (Guilds), or null without the guilds or before the roll. */
export const eventFace = (s: GameState): EventFace | null => s.ext.guilds?.eventDie?.face ?? null;

/** Take one raider off `hex` as `player`'s prisoner (Invasion: the flagship's agitators). False if none stands there. */
export function captureRaider(s: GameState, player: PlayerId, hex: number): boolean {
  const i = s.ext.invasion;
  if (!i || i.raiders[hex] <= 0) return false;
  i.raiders[hex]--;
  i.prisoners[player]++;
  return true;
}

/** Give a ship taken off the board back to its owner's supply (Sea Lanes). */
export function returnShip(s: GameState, player: PlayerId) {
  if (s.ext.sea) s.ext.sea.shipsLeft[player]++;
}

/** How much more oil `player` may hold (Oil: four at most); none without oil in play. */
export const oilRoom = (s: GameState, player: PlayerId): number => (s.ext.oil ? Math.max(0, 4 - s.players[player].hand.oil) : 0);

/** Where `player` could put a ship now (Sea Lanes), with one left in their supply; nowhere without the sea. */
export const shipSpots = (s: GameState, player: PlayerId): number[] => (s.ext.sea && s.ext.sea.shipsLeft[player] > 0 ? legalShips(s, player) : []);

/** Put one of `player`'s ships on `edge` from their supply (Sea Lanes). The caller runs `built`. */
export function placeShip(s: GameState, player: PlayerId, edge: number) {
  s.routes[edge] = { owner: player, kind: 'ship', builtTurn: s.turn };
  if (s.ext.sea) s.ext.sea.shipsLeft[player]--;
}
