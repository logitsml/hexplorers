// An online game's replay (/replay/ID): fetched from GET /api/replays/:id, its dice checked, and
// turned into the record the local replay machinery plays (session.watchReplay, a SavedGame). The
// check: the dice key revealed at the end matches the commitment (the one the table saw, when this
// client was there; else the replay's own), the game key it gives with the seats' nonces
// (checkReveal) replays every recorded move legally, and the game it plays to ends as the room
// said, with the same winner and the same points.

import { dealBoard, totalVictoryPoints, type Action, type BoardSpec, type GameOptions, type GameSecret, type PlayerColor, type PlayerId } from '../engine';
import type { BotDifficulty } from '../engine/ai';
import { LocalHost, type HostClock } from '../game/host';
import { avatarOf } from '../game/names';
import type { SavedGame } from '../game/save';
import { checkReveal, diceCommit, gameKey } from '../net/codes';
import { ApiError, call } from './api';

/** A replay as the server stores it (server/services finishGame: the room's FinishedGame and its id). */
export interface ReplayRecord {
  id: string;
  room: string;
  options: Partial<GameOptions>;
  seats: { seat: number; name: string; color: string; bot: boolean; difficulty?: string; away?: boolean; conceded?: boolean }[];
  log: { actor: PlayerId; action: Action }[];
  /** The dice key K (hex). */
  key?: string | null;
  nonces: (string | null)[];
  winner: number | null;
  points: number[];
  turns: number;
  startedAt: number;
  endedAt: number;
}

export type ReplayOutcome =
  | { ok: true; game: SavedGame; fair: boolean; commitSeen: boolean }
  | { ok: false; why: 'missing' | 'broken' | 'offline'; text: string };

export const REPLAY_ID = /^[A-Za-z0-9_-]{8,32}$/;
const HEX64 = /^[0-9a-f]{64}$/i;

const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

/** Shape check: a replay this client can read (anything else is "broken", never a crash). */
export function validRecord(r: unknown): r is ReplayRecord {
  if (!r || typeof r !== 'object') return false;
  const x = r as Partial<ReplayRecord>;
  if (!x.options || typeof x.options !== 'object' || !Array.isArray(x.seats) || x.seats.length < 3 || x.seats.length > 4) return false;
  const n = x.seats.length;
  if (!x.seats.every((s, i) => s && s.seat === i && typeof s.name === 'string' && typeof s.color === 'string' && typeof s.bot === 'boolean')) return false;
  if (!Array.isArray(x.log) || !x.log.every((e) => e && isInt(e.actor, 0, n - 1) && e.action && typeof (e.action as { type?: unknown }).type === 'string')) return false;
  if (!Array.isArray(x.nonces) || !x.nonces.every((v) => v === null || typeof v === 'string')) return false;
  if (x.key !== undefined && x.key !== null && (typeof x.key !== 'string' || !HEX64.test(x.key))) return false;
  return Array.isArray(x.points) && (x.winner === null || isInt(x.winner, 0, n - 1));
}

/** GET /api/replays/:id, or why not. */
export async function fetchReplay(id: string, o: { base?: string; f?: typeof fetch } = {}): Promise<{ ok: true; record: ReplayRecord } | Extract<ReplayOutcome, { ok: false }>> {
  if (!REPLAY_ID.test(id)) return { ok: false, why: 'missing', text: 'That isn’t a replay’s link.' };
  try {
    const record = await call<unknown>(o.f ?? fetch, `${o.base ?? ''}/api/replays/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!validRecord(record)) return { ok: false, why: 'broken', text: 'This replay can’t be read by this version of the game.' };
    return { ok: true, record };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { ok: false, why: 'missing', text: 'This replay can’t be found: it may have been cleared from the harbour.' };
    return { ok: false, why: 'offline', text: e instanceof ApiError && e.status === 0 ? e.message : 'The harbour couldn’t send the replay. Try again in a moment.' };
  }
}

/** A clock that never rings (the check plays the moves through, nobody waits on anything). */
const STILL: HostClock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };

/**
 * Check a replay's dice and turn it into the record the local replay plays. `commit`: the dice
 * commitment this client saw at the table (RoomInfo.commit), when it was there.
 */
export async function checkReplay(r: ReplayRecord, o: { commit?: string } = {}): Promise<ReplayOutcome> {
  const options = r.options;
  const keyed = options.rng === 'chacha20';
  let secret: GameSecret | undefined;
  let fair = true;
  if (keyed) {
    if (!r.key) return { ok: false, why: 'broken', text: 'This replay came without its dice key.' };
    const commit = o.commit && HEX64.test(o.commit) ? o.commit.toLowerCase() : await diceCommit(r.key);
    const checked = await checkReveal(commit, r.key, r.nonces);
    fair = checked !== null;
    // (A key that doesn't match what the table was shown still plays, but it isn't called fair.)
    secret = { rngKey: checked ?? (await gameKey(r.key, r.nonces)) };
  }
  const seats = r.seats.map((s) => ({ name: s.name, color: s.color as PlayerColor, isBot: false }));
  let host: LocalHost;
  let board: BoardSpec;
  try {
    // (The island the room dealt: from the game's key once it's revealed, or its seed.)
    board = options.board ?? dealBoard(seats.length, options, secret?.rngKey);
    host = new LocalHost(seats, { ...options, board }, STILL, secret);
    host.replay(r.log);
  } catch {
    return { ok: false, why: 'broken', text: 'This replay doesn’t play through on this version of the game.' };
  }
  const s = host.state;
  host.dispose();
  // The game it plays to must end as the room said it did.
  const same = s.phase === 'gameOver' && s.winner === r.winner && s.players.every((p) => totalVictoryPoints(s, p.id) === r.points[p.id]);
  return { ok: true, game: toSavedGame(r, board, secret, fair && same), fair: fair && same, commitSeen: !!o.commit };
}

/** The record the local replay machinery plays (session.watchReplay): the room's seats, options, island and moves. */
export function toSavedGame(r: ReplayRecord, board: BoardSpec, secret: GameSecret | undefined, fair: boolean): SavedGame {
  const o = r.options;
  const modules = o.modules ?? [];
  const first = r.seats[0];
  return {
    v: 3,
    rules: o.rules ?? 1,
    ...(modules.length > 0 && o.moduleRules && { moduleRules: o.moduleRules }),
    cfg: {
      name: first.name,
      color: first.color as PlayerColor,
      opponents: (r.seats.length - 1) as 2 | 3,
      difficulty: 'normal',
      layout: o.layout ?? 'random',
      numberPlacement: o.numberPlacement ?? 'spiral',
      victoryPoints: o.victoryPoints,
      friendlyRobber: o.friendlyRobber,
      eventDeck: o.eventDeck,
      modules,
      map: o.map,
      custom: o.custom,
      knobs: o.knobs,
      seed: o.seed ?? 0,
      board,
    },
    seats: r.seats.map((s) => ({ name: s.name, color: s.color as PlayerColor, isBot: s.bot, ...(s.bot && s.difficulty && { difficulty: s.difficulty as BotDifficulty }) })),
    // (The crew's portraits go with their names, as the room gave them; people show their initial.)
    avatars: r.seats.map((s) => (s.bot ? avatarOf(s.name) : -1)),
    history: r.log,
    turn: r.turns,
    savedAt: r.endedAt,
    online: { rng: o.rng, ...(secret && { secret }), fair },
  };
}
