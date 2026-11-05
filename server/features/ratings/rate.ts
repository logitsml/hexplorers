// A finished game as the ratings see it: who was a person at the table, where each finished among
// the people only, whether each saw it through (Fair winds), and the OpenSkill update for a rated
// game. Pure: the feature reads the ratings before and writes what this returns.
//
// Decisions (see docs/online/research/features-social.md, 6.2 and 6.5):
// - Bots are never rated, and a table's bots don't count in anyone's place: a game with bots is
//   rated among its people only, and only when at least two people sat at it (one person and
//   three bots measures nothing against anyone). Solo rooms are never rated.
// - A person who conceded, or was away at the end (the crew had their helm), is placed last.
// - An abandoned game (nobody left at the table) isn't rated, and nobody saw it through.

import type { FinishedGame } from '../../core/ports';
import { finishingRanks, rateFreeForAll, rating as fresh, displayRating, tierFor, type Rating } from '../../lib/ratings';

/** A person's rating as stored, with the rated games behind it. */
export interface Held {
  rating: Rating;
  games: number;
}

export interface Person {
  user: string;
  seat: number;
  name: string;
  /** Saw it through: not conceded, not away at the end, the game not abandoned (Fair winds). */
  through: boolean;
  conceded: boolean;
  away: boolean;
}

export interface Change {
  user: string;
  seat: number;
  name: string;
  /** 1-based place among the people (ties share it). */
  place: number;
  before: Rating;
  after: Rating;
  games: number;
  displayBefore: number;
  displayAfter: number;
  /** The tier after (a tier's id, or 'placement' while the first games are played). */
  tier: string;
}

/** Fewest people at a table for it to be rated. */
export const RATED_MIN_PEOPLE = 2;

/** The people at a finished table (each once: a seat with a user and no bot). */
export function peopleOf(game: FinishedGame): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const s of game.seats) {
    if (s.bot || !s.user || seen.has(s.user)) continue;
    seen.add(s.user);
    out.push({ user: s.user, seat: s.seat, name: s.name, conceded: !!s.conceded, away: !!s.away && !s.conceded, through: !s.conceded && !s.away && !game.abandoned });
  }
  return out;
}

/** Whether this game moves anyone's rating. */
export function isRated(game: FinishedGame, people = peopleOf(game)): boolean {
  return !!game.rated && !game.abandoned && people.length >= RATED_MIN_PEOPLE;
}

/** The label a tier shows as: its id, or 'placement' while the first games are played. */
export function tierLabel(r: Rating, games: number): string {
  const t = tierFor(r, games);
  return t.provisional ? 'placement' : t.id;
}

/** The rating changes of a rated game, among its people (`held`: each one's rating before; absent: new). */
export function rateTable(game: FinishedGame, held: Map<string, Held>, people = peopleOf(game)): Change[] {
  if (!isRated(game, people)) return [];
  const before = people.map((p) => held.get(p.user) ?? { rating: fresh(), games: 0 });
  const places = finishingRanks(people.map((p) => ({ points: game.points[p.seat] ?? 0, winner: game.winner === p.seat, conceded: p.conceded, away: p.away })));
  const after = rateFreeForAll(
    before.map((b) => b.rating),
    places,
  );
  return people.map((p, i) => {
    const games = before[i].games + 1;
    return {
      user: p.user,
      seat: p.seat,
      name: p.name,
      place: places[i],
      before: before[i].rating,
      after: after[i],
      games,
      displayBefore: displayRating(before[i].rating),
      displayAfter: displayRating(after[i]),
      tier: tierLabel(after[i], games),
    };
  });
}
