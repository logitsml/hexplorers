// What a link preview says, read from as little as possible: a room's public card (GET /card, the
// same the join page reads: no ids, no secrets), a finished game's replay summary (kept in memory,
// since a replay never changes), and whatever the profiles register as their
// source (server/features/og/sources.ts). Every name here is still raw: the cards in server/lib/og
// and the page's tags escape them.

import type { ModuleId } from '../../../src/engine';
import { EXPANSIONS, PRESETS, expansionsOf, mixOf } from '../../../src/engine/presets';
import { ROOM_CODE_RE } from '../../../src/net/protocol';
import type { CardSeat, ResultsInput, RoomInviteInput } from '../../lib/og';
import type { HttpContext } from '../../http/kit';

/** The HUD colours of the room's colour names (render/board/pieces.ts), as the cards take them (#rrggbb only). */
const COLOURS: Record<string, string> = {
  red: '#d64534',
  blue: '#3f74d6',
  white: '#f2ede2',
  orange: '#f2a12f',
  purple: '#8b55d6',
  teal: '#16a093',
  rose: '#e2639c',
  charcoal: '#4a4c55',
};

export const hexColour = (c: unknown): string | undefined => (typeof c !== 'string' ? undefined : /^#[0-9a-f]{6}$/i.test(c) ? c : COLOURS[c]);

/** The mix in words, as the harbour shows it: a preset's name, the expansions, or the base game. */
export function mixName(o: { preset?: string; modules?: readonly string[] }): string {
  const preset = o.preset ? PRESETS.find((p) => p.id === o.preset) : undefined;
  if (preset) return preset.name;
  const expansions = expansionsOf((o.modules ?? []) as ModuleId[]);
  if (!expansions.length) return 'Base game';
  return mixOf(expansions).preset?.name ?? expansions.map((e) => EXPANSIONS.find((x) => x.id === e)?.name ?? e).join(' with ');
}

/** The room's card as GET /api/rooms/:code gives it (only what the previews read). */
export interface RoomCard {
  code: string;
  phase: 'harbour' | 'playing' | 'over' | 'abandoned';
  seats: { seat: number; kind: 'open' | 'human' | 'bot'; name: string; color: string }[];
  settings: { seats: number; preset?: string; modules?: string[]; victoryPoints?: number };
  results?: { winner: number | null; standings: { seat: number; points: number; conceded?: boolean }[]; turns: number };
}

/** A room's public card, or null when there's no such room (one request to the room, nothing else). */
export async function roomCard(ctx: Pick<HttpContext, 'rooms'>, code: string): Promise<RoomCard | null> {
  if (!ROOM_CODE_RE.test(code)) return null;
  try {
    const r = await ctx.rooms.fetch(code, 'card', { method: 'GET' });
    if (!r.ok) return null;
    const c = (await r.json()) as RoomCard;
    return c && Array.isArray(c.seats) && c.settings ? c : null;
  } catch {
    return null;
  }
}

/** Whose island it is: the first person at the table (the card names no host), or a sailor. */
const hostOf = (seats: { kind: string; name: string }[]) => seats.find((s) => s.kind === 'human' && s.name)?.name ?? 'A sailor';

export function inviteInput(c: RoomCard): RoomInviteInput {
  const seats: CardSeat[] = c.seats.slice(0, c.settings.seats).map((s) => ({ kind: s.kind, name: s.kind === 'open' ? undefined : s.name, color: hexColour(s.color) }));
  return { code: c.code, host: hostOf(c.seats), seats, mix: mixName(c.settings), target: c.settings.victoryPoints, phase: c.phase === 'harbour' ? 'harbour' : 'playing' };
}

/** A finished room's standings, best first, with the names its card shows. */
export function roomResults(c: RoomCard): ResultsInput | null {
  if (!c.results) return null;
  const standings = c.results.standings.map((s) => {
    const seat = c.seats.find((x) => x.seat === s.seat);
    return { name: seat?.name || `Seat ${s.seat + 1}`, color: hexColour(seat?.color), points: s.points, conceded: s.conceded };
  });
  return { host: hostOf(c.seats), mix: mixName(c.settings), standings, turns: c.results.turns };
}

/** A short version for an image's URL: it changes whenever what the card shows does (crawlers keep a URL's image for days). */
export function cardVersion(c: RoomCard): string {
  const text = JSON.stringify([c.phase, c.seats.map((s) => [s.kind, s.name, s.color]), c.results?.standings]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// ------------------------------------------------------------------ replays

export const REPLAY_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;

export interface ReplaySummary {
  id: string;
  card: ResultsInput;
  winner: string | null;
  turns: number;
}

const replays = new Map<string, ReplaySummary | null>();
const REPLAYS_KEPT = 256;

/** A replay's summary for its preview (each replay read once per process: it never changes). */
export async function replaySummary(ctx: Pick<HttpContext, 'services'>, id: string): Promise<ReplaySummary | null> {
  if (!REPLAY_ID_RE.test(id)) return null;
  if (replays.has(id)) return replays.get(id)!;
  let out: ReplaySummary | null = null;
  try {
    const text = await ctx.services.replay(id);
    if (text) {
      const r = JSON.parse(text) as {
        options?: { modules?: string[] };
        seats?: { seat: number; name: string; color: string; bot: boolean; conceded?: boolean }[];
        winner?: number | null;
        points?: number[];
        turns?: number;
        startedAt?: number;
        endedAt?: number;
      };
      const seats = Array.isArray(r.seats) ? r.seats : [];
      const points = Array.isArray(r.points) ? r.points : [];
      const rows = seats
        .map((s) => ({ seat: s.seat, name: s.name, color: hexColour(s.color), points: Number(points[s.seat]) || 0, conceded: s.conceded }))
        .sort((a, b) => (b.seat === r.winner ? 1 : 0) - (a.seat === r.winner ? 1 : 0) || b.points - a.points);
      const turns = Number(r.turns) || 0;
      const duration = Number(r.endedAt) - Number(r.startedAt);
      out = {
        id,
        card: { host: hostOf(seats.map((s) => ({ kind: s.bot ? 'bot' : 'human', name: s.name }))), mix: mixName({ modules: r.options?.modules }), standings: rows, turns, durationMs: duration > 0 ? duration : undefined },
        winner: typeof r.winner === 'number' ? (seats.find((s) => s.seat === r.winner)?.name ?? null) : null,
        turns,
      };
    }
  } catch {
    out = null;
  }
  if (replays.size >= REPLAYS_KEPT) replays.delete(replays.keys().next().value!);
  // (A missing replay isn't remembered: it may be archived a moment later.)
  if (out) replays.set(id, out);
  return out;
}

/** "12–9–8–6". */
export const scoreLine = (card: ResultsInput) => card.standings.map((s) => Math.max(0, Math.round(s.points))).join('–');

export const HANDLE_RE = /^[A-Za-z0-9_.-]{2,32}$/;
