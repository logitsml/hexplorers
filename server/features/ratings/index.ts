// Ratings and tiers (OpenSkill, server/lib/ratings), "Fair winds" reliability, and the
// leaderboards. The finished game of every room passes through finishGame: each person's row goes
// into ratings_games (Fair winds: did they see it through), and a rated game (settings.rated, the host's
// choice) moves its people's ratings, returned to the room for the results
// card. The seats show each person's tier and Fair winds through services.standing.
//
//   GET /api/leaderboard?scope=global|friends&period=all|season
//   GET /api/ratings/me
//
// The global board's top is one indexed read kept a minute in memory (the rank of the one asking
// is two counts); the friends board needs the friends feature (services.friendsOf) and says so
// without it.

import type { Feature } from '..';
import { PLACEMENT_GAMES, tierFor } from '../../lib/ratings';
import { fail, json, who, type Handler } from '../../http/kit';
import { RATINGS_SCHEMA, rankOf, recordGame, seasonOf, seatStanding, standingOf, topRatings, type BoardRow } from './store';
import { friendsOf, signedIn, warn } from './shared';
import { ACCOUNT_HOOKS } from '../accounts';

export const BOARD_SIZE = 100;
const BOARD_CACHE_MS = 60_000;
const cache = new Map<string, { at: number; rows: BoardRow[] }>();

/** The top of the global board, kept a minute (it changes only as rated games end). */
async function cachedTop(db: Parameters<typeof topRatings>[0], period: 'all' | 'season', now: number): Promise<BoardRow[]> {
  const season = seasonOf(now);
  const key = `${period}|${season.n}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < BOARD_CACHE_MS) return hit.rows;
  const rows = await topRatings(db, { limit: BOARD_SIZE, ...(period === 'season' && { since: season.start }) });
  cache.set(key, { at: now, rows });
  return rows;
}

/** Forget the cached boards (a test, or a game that just moved them when the board must be exact). */
export function clearBoardCache() {
  cache.clear();
}

const leaderboard: Handler = async (req, _p, ctx) => {
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') ?? 'global';
  const period = url.searchParams.get('period') === 'season' ? 'season' : 'all';
  if (scope !== 'global' && scope !== 'friends') return fail(400, 'No such board.');
  const now = ctx.now();
  const season = seasonOf(now);
  const since = period === 'season' ? season.start : undefined;
  const head = { scope, period, season: { n: season.n, name: season.name, start: season.start, end: season.end } };
  if (scope === 'global') {
    const id = await who(req, ctx);
    const rows = await cachedTop(ctx.db, period, now);
    const you = id ? await rankOf(ctx.db, id.user, since) : null;
    return json(200, { ...head, available: true, rows, ...(you && { you: { ...you, user: id!.user } }) });
  }
  const id = await signedIn(req, ctx);
  if (id instanceof Response) return id;
  const friends = friendsOf(ctx.services);
  // (No friends feature on this server: the board says so rather than failing.)
  if (!friends) return json(200, { ...head, available: false, rows: [] });
  const users = [id.user, ...(await friends(id.user))];
  const rows = await topRatings(ctx.db, { users: [...new Set(users)].slice(0, 500), limit: BOARD_SIZE, ...(since !== undefined && { since }) });
  return json(200, { ...head, available: true, rows });
};

const mine: Handler = async (req, _p, ctx) => {
  const id = await signedIn(req, ctx);
  if (id instanceof Response) return id;
  const s = await standingOf(ctx.db, id.user);
  const t = s.mu !== undefined ? tierFor({ mu: s.mu, sigma: s.sigma! }, s.games) : null;
  return json(200, {
    games: s.games,
    provisional: s.provisional,
    placementLeft: t ? t.placementLeft : PLACEMENT_GAMES,
    ...(s.tier !== undefined && { tier: s.tier, rating: s.rating }),
    ...(t?.next && { next: t.next }),
    ...(s.reliability !== undefined && { reliability: s.reliability }),
    voyages: s.voyages,
    season: seasonOf(ctx.now()),
  });
};

// What an account's logbook, erasure and guest sign-in take of this feature's.
ACCOUNT_HOOKS.export.push(async (db, user) => ({
  rating: await db.first('SELECT name, mu, sigma, games, provisional, tier, display, updated FROM ratings WHERE user = ?', user),
  ratedGames: await db.all('SELECT game, room, at, rated, place, before, after, through FROM ratings_games WHERE user = ? ORDER BY at', user),
}));
ACCOUNT_HOOKS.erase.push(async (db, user) => {
  await db.batch([
    { query: 'DELETE FROM ratings WHERE user = ?', bindings: [user] },
    { query: 'DELETE FROM ratings_games WHERE user = ?', bindings: [user] },
  ]);
});
// (A guest's ratings move over only where the account has none of its own for that row.)
ACCOUNT_HOOKS.absorb.push((guest, into) => [
  { query: 'UPDATE OR IGNORE ratings SET user = ? WHERE user = ?', bindings: [into, guest] },
  { query: 'DELETE FROM ratings WHERE user = ?', bindings: [guest] },
  { query: 'UPDATE OR IGNORE ratings_games SET user = ? WHERE user = ?', bindings: [into, guest] },
  { query: 'DELETE FROM ratings_games WHERE user = ?', bindings: [guest] },
]);

export const ratings: Feature = {
  id: 'ratings',
  schema: RATINGS_SCHEMA,
  routes: [
    { method: 'GET', path: '/api/leaderboard', handler: leaderboard },
    { method: 'GET', path: '/api/ratings/me', handler: mine },
  ],
  extend(services, deps) {
    const inner = services.finishGame;
    services.finishGame = async (game) => {
      const out = await inner.call(services, game);
      try {
        const changes = await recordGame(deps.db, game, deps.now());
        if (changes.length) cache.clear();
        return changes.length ? { ...out, ratings: changes.map((c) => ({ user: c.user, before: c.displayBefore, after: c.displayAfter, tier: c.tier })) } : out;
      } catch (e) {
        // (The replay is stored: a failure here costs a rating change, never the game's record.)
        warn('ratingsFailed', e);
        return out;
      }
    };
    services.standing = (user) => seatStanding(deps.db, user);
  },
};
