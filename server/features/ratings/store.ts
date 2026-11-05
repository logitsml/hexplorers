// The ratings' tables and what the other features read from them: each person's rating, a row per
// person per finished game (ratings_games: the rated ones carry their change, and every one says
// whether it was seen through, for Fair winds), a person's standing for their seat, and seasons.
//
// (ratings_games, not "plays": the accounts feature may keep a plays table of its own.)

import type { FinishedGame, ServiceDb } from '../../core/ports';
import { PLACEMENT_GAMES, displayRating, type Rating } from '../../lib/ratings';
import { peopleOf, rateTable, tierLabel, type Change, type Held } from './rate';
import { marks } from './shared';

export const RATINGS_SCHEMA = [
  // display and tier are kept beside mu and sigma so the boards are one indexed read.
  'CREATE TABLE IF NOT EXISTS ratings(user TEXT PRIMARY KEY, name TEXT NOT NULL, mu REAL NOT NULL, sigma REAL NOT NULL, games INTEGER NOT NULL, provisional INTEGER NOT NULL, tier TEXT NOT NULL, display INTEGER NOT NULL, updated INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS ratings_board ON ratings(provisional, display DESC)',
  'CREATE TABLE IF NOT EXISTS ratings_games(game TEXT NOT NULL, room TEXT NOT NULL, user TEXT NOT NULL, at INTEGER NOT NULL, rated INTEGER NOT NULL, place INTEGER, before INTEGER, after INTEGER, through INTEGER NOT NULL, PRIMARY KEY (game, user))',
  'CREATE INDEX IF NOT EXISTS ratings_games_user ON ratings_games(user, at DESC)',
];

/** Fair winds looks at this many of a person's latest games. */
export const FAIR_WINDS_GAMES = 20;
/** ...and is shown once there are at least this many. */
export const FAIR_WINDS_MIN = 3;
/** Below this share (with FAIR_WINDS_MIN games or more) a person sails in the squall pool: matched among themselves. */
export const SQUALL_BELOW = 0.6;

interface RatingRow {
  user: string;
  mu: number;
  sigma: number;
  games: number;
  display: number;
  provisional: number;
  tier: string;
  name: string;
}

export async function heldRatings(db: ServiceDb, users: string[]): Promise<Map<string, Held>> {
  const out = new Map<string, Held>();
  if (!users.length) return out;
  const rows = await db.all<RatingRow>(`SELECT user, mu, sigma, games FROM ratings WHERE user IN (${marks(users.length)})`, ...users);
  for (const r of rows) out.set(r.user, { rating: { mu: r.mu, sigma: r.sigma }, games: r.games });
  return out;
}

/** A game's key: its room and its start (a room code comes round again in time; a game never does). */
export const gameKeyOf = (game: FinishedGame) => `${game.room}:${game.startedAt}`;

/**
 * A finished game into the tables: a row for each person (Fair winds), and for a rated game each
 * one's new rating. Returns the changes (empty for an unrated game). A game recorded once already
 * is left as it is.
 */
export async function recordGame(db: ServiceDb, game: FinishedGame, now: number): Promise<Change[]> {
  const people = peopleOf(game);
  if (!people.length) return [];
  const key = gameKeyOf(game);
  if (await db.first('SELECT 1 AS x FROM ratings_games WHERE game = ? LIMIT 1', key)) return [];
  const changes = rateTable(game, await heldRatings(db, people.map((p) => p.user)), people);
  const by = new Map(changes.map((c) => [c.user, c]));
  const at = game.endedAt || now;
  const statements = people.map((p) => {
    const c = by.get(p.user);
    return {
      query: 'INSERT OR IGNORE INTO ratings_games(game, room, user, at, rated, place, before, after, through) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: [key, game.room, p.user, at, c ? 1 : 0, c?.place ?? null, c?.displayBefore ?? null, c?.displayAfter ?? null, p.through ? 1 : 0],
    };
  });
  for (const c of changes) {
    statements.push({
      query:
        'INSERT INTO ratings(user, name, mu, sigma, games, provisional, tier, display, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(user) DO UPDATE SET name = excluded.name, mu = excluded.mu, sigma = excluded.sigma, games = excluded.games, provisional = excluded.provisional, tier = excluded.tier, display = excluded.display, updated = excluded.updated',
      bindings: [c.user, c.name, c.after.mu, c.after.sigma, c.games, c.games < PLACEMENT_GAMES ? 1 : 0, c.tier, c.displayAfter, now],
    });
  }
  await db.batch(statements);
  return changes;
}

export interface Standing {
  tier?: string;
  rating?: number;
  games: number;
  provisional: boolean;
  reliability?: number;
  /** Games looked at for Fair winds. */
  voyages: number;
  /** Sails in the squall pool (low Fair winds). */
  squall: boolean;
  mu?: number;
  sigma?: number;
}

/** A person's standing: their tier and rating (once they have a rated game), and Fair winds (once known). */
export async function standingOf(db: ServiceDb, user: string): Promise<Standing> {
  const r = await db.first<RatingRow>('SELECT mu, sigma, games, display FROM ratings WHERE user = ?', user);
  const recent = await db.all<{ through: number }>('SELECT through FROM ratings_games WHERE user = ? ORDER BY at DESC LIMIT ?', user, FAIR_WINDS_GAMES);
  const out: Standing = { games: r?.games ?? 0, provisional: !r || r.games < PLACEMENT_GAMES, voyages: recent.length, squall: false };
  if (r && r.games > 0) {
    const rating: Rating = { mu: r.mu, sigma: r.sigma };
    out.tier = tierLabel(rating, r.games);
    out.rating = displayRating(rating);
    out.mu = r.mu;
    out.sigma = r.sigma;
  }
  if (recent.length >= FAIR_WINDS_MIN) {
    out.reliability = Math.round((recent.reduce((s, x) => s + x.through, 0) / recent.length) * 100) / 100;
    out.squall = out.reliability < SQUALL_BELOW;
  }
  return out;
}

/** What a seat shows (services.standing): nothing a person without games has. */
export async function seatStanding(db: ServiceDb, user: string) {
  const s = await standingOf(db, user);
  const out: { tier?: string; rating?: number; reliability?: number } = {};
  if (s.tier !== undefined) out.tier = s.tier;
  if (s.rating !== undefined) out.rating = s.rating;
  if (s.reliability !== undefined) out.reliability = s.reliability;
  return Object.keys(out).length ? out : null;
}

// ------------------------------------------------------------------ seasons

/** Seasons are eight weeks, from Monday 5 January 2026 (UTC); each soft-resets nothing yet, only the board. */
export const SEASON_EPOCH = Date.UTC(2026, 0, 5);
export const SEASON_MS = 8 * 7 * 86_400_000;
const TIDES = ['Winter', 'Winter', 'Spring', 'Spring', 'Spring', 'Summer', 'Summer', 'Summer', 'Autumn', 'Autumn', 'Autumn', 'Winter'];

export function seasonOf(now: number) {
  const n = Math.max(0, Math.floor((now - SEASON_EPOCH) / SEASON_MS));
  const start = SEASON_EPOCH + n * SEASON_MS;
  return { n: n + 1, start, end: start + SEASON_MS, name: `The ${TIDES[new Date(start + SEASON_MS / 2).getUTCMonth()]} Tide` };
}

// ------------------------------------------------------------------ boards

export interface BoardRow {
  rank: number;
  user: string;
  name: string;
  tier: string;
  rating: number;
  games: number;
}

/** The top of the board (rated players past their placement games), all time or this season. */
export async function topRatings(db: ServiceDb, o: { since?: number; users?: string[]; limit: number }): Promise<BoardRow[]> {
  const where = ['r.provisional = 0'];
  const bind: (string | number)[] = [];
  if (o.users) {
    if (!o.users.length) return [];
    where.push(`r.user IN (${marks(o.users.length)})`);
    bind.push(...o.users);
  }
  if (o.since !== undefined) {
    where.push('EXISTS (SELECT 1 FROM ratings_games g WHERE g.user = r.user AND g.rated = 1 AND g.at >= ?)');
    bind.push(o.since);
  }
  const rows = await db.all<RatingRow>(`SELECT r.user, r.name, r.tier, r.display, r.games FROM ratings r WHERE ${where.join(' AND ')} ORDER BY r.display DESC, r.games DESC LIMIT ?`, ...bind, o.limit);
  let rank = 0;
  let last = Infinity;
  return rows.map((r, i) => {
    if (r.display < last) rank = i + 1;
    last = r.display;
    return { rank, user: r.user, name: r.name, tier: r.tier, rating: r.display, games: r.games };
  });
}

/** Where a person stands on the global board (null while they are placed or unrated). */
export async function rankOf(db: ServiceDb, user: string, since?: number): Promise<{ rank: number; of: number } | null> {
  const me = await db.first<RatingRow>('SELECT display, provisional FROM ratings WHERE user = ?', user);
  if (!me || me.provisional) return null;
  const season = since !== undefined ? ' AND EXISTS (SELECT 1 FROM ratings_games g WHERE g.user = r.user AND g.rated = 1 AND g.at >= ?)' : '';
  const extra = since !== undefined ? [since] : [];
  const above = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ratings r WHERE r.provisional = 0 AND r.display > ?${season}`, me.display, ...extra);
  const all = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ratings r WHERE r.provisional = 0${season}`, ...extra);
  return { rank: (above?.n ?? 0) + 1, of: all?.n ?? 0 };
}
