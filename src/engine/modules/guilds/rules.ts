// The guilds' numbers and read-only queries: tracks, levels and their red-die ranges, seats, the
// venture limit, and the decisions they leave owed. Shared by the module, its ventures and the bots
// (and read by the garrisons and the fleet).

import { isConquered, cutOff } from '../shared';
import type { Commodity, GameState, Pending, PlayerId, Track } from '../../types';
import type { EventFace, GuildsPending, GuildsState } from './types';

export const TRACKS: readonly Track[] = ['learning', 'commerce', 'statecraft'];

/** What each track's improvements are paid in. */
export const TRACK_COMMODITY: Record<Track, Commodity> = { learning: 'paper', commerce: 'cloth', statecraft: 'silver' };

/** Each commodity's supply. */
export const COMMODITY_SUPPLY = 12;

export const MAX_LEVEL = 5;
/** The level whose lasting ability a track grants. */
export const ABILITY_LEVEL = 3;
/** The first to reach this level holds the track's seat; the first to reach MAX_LEVEL holds it for good. */
export const SEAT_LEVEL = 4;
export const SEAT_POINTS = 2;
export const TRADER_POINTS = 1;
/** Venture cards a hand may keep (victory ventures aside). */
export const VENTURE_LIMIT = 4;
/** The trader's and the charter fleet's rate, and the Commerce ability's. */
export const PREFERRED_RATE = 2;

/** The event die: three ship faces and one for each track. */
export const EVENT_FACES: readonly EventFace[] = ['ship', 'ship', 'ship', 'learning', 'commerce', 'statecraft'];

/** Whether a level's red-die range covers `red`: level 1 draws on 1–2, level 2 on 1–3, up to level 5 on 1–6. */
export const covers = (level: number, red: number): boolean => level > 0 && red <= level + 1;

/** Commodities a level costs to reach (its own number). */
export const levelCost = (level: number): number => level;

export const guildsOf = (s: GameState): GuildsState => s.ext.guilds!;

export const levelOf = (s: GameState, player: PlayerId, track: Track): number => s.ext.guilds?.levels[player]?.[track] ?? 0;

/** `player`'s cities (standing, not laid down). */
export function citiesOf(s: GameState, player: PlayerId): number[] {
  const out: number[] = [];
  s.buildings.forEach((b, v) => {
    if (b && b.owner === player && b.kind === 'city') out.push(v);
  });
  return out;
}

/** The city holding `track`'s seat, or null. */
export function seatVertex(s: GameState, track: Track): number | null {
  const v = s.buildings.findIndex((b) => b?.seat === track);
  return v < 0 ? null : v;
}

/** Who holds `track`'s seat, or null. */
export function seatHolder(s: GameState, track: Track): PlayerId | null {
  const v = seatVertex(s, track);
  return v === null ? null : s.buildings[v]!.owner;
}

/**
 * Cities of `player`'s that could take a seat: holding no seat and (unless the stackUpgrades knob is
 * set) no foundry, and not cut off by conquest.
 */
export function seatSites(s: GameState, player: PlayerId): number[] {
  const stack = !!s.options.knobs.stackUpgrades;
  return citiesOf(s, player).filter((v) => {
    const b = s.buildings[v]!;
    return !b.seat && (stack || !b.foundry) && !cutOff(s, v);
  });
}

/** A seat city cut off by conquest freezes its track for its owner (Invasion). */
export function trackFrozen(s: GameState, player: PlayerId, track: Track): boolean {
  const v = seatVertex(s, track);
  return v !== null && s.buildings[v]!.owner === player && cutOff(s, v);
}

/** Terrain with a single resource of its own (the trader's hexes; never a bounty field). */
const RESOURCE_TERRAIN = new Set(['hills', 'forest', 'pasture', 'fields', 'mountains']);

/** Where the trader may stand: a hex with a resource of its own, beside one of `player`'s buildings, not conquered. */
export function traderHexes(s: GameState, player: PlayerId): number[] {
  const g = guildsOf(s);
  return s.board.hexes
    .filter(
      (h) =>
        RESOURCE_TERRAIN.has(h.terrain) &&
        !isConquered(s, h.id) &&
        !(g.trader && g.trader.owner === player && g.trader.hex === h.id) &&
        h.vertices.some((v) => s.buildings[v]?.owner === player),
    )
    .map((h) => h.id);
}


// ---------------------------------------------------------------------------
// Decisions owed
// ---------------------------------------------------------------------------

/** Put a decision on the pending stack for one player. */
export function owe(s: GameState, player: PlayerId, d: GuildsPending) {
  s.pending.push({ kind: d.kind, players: [player], data: d });
}

/** The top decision, if it is this kind and owed by `player`. */
export function owedBy<K extends GuildsPending['kind']>(s: GameState, player: PlayerId, kind: K): Extract<GuildsPending, { kind: K }> | null {
  const top: Pending | undefined = s.pending[s.pending.length - 1];
  if (!top || top.kind !== kind || !top.players.includes(player)) return null;
  return top.data as Extract<GuildsPending, { kind: K }>;
}

/** Whether any decision on the stack is the guilds'. */
export const guildsPending = (p: Pending | undefined): p is Pending & { data: GuildsPending } => !!p && p.kind.startsWith('guilds/');
