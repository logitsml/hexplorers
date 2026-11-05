// Ratings through the rooms' finishGame: a rated table's people rated among themselves (the crew
// never), a concede placed last, the changes back on the results card, the tier and Fair winds on
// a seat once it's claimed, and the boards.

import { describe, expect, it } from 'vitest';
import type { RoomInfo, ServerMsg } from '../../src/net/protocol';
import { PLACEMENT_GAMES } from '../../server/lib/ratings';
import { clearBoardCache } from '../../server/features/ratings';
import { peopleOf, rateTable } from '../../server/features/ratings/rate';
import { play, serverState, startTable } from '../server/harness';
import { api, finished, sailor, World } from './kit';

const roomOf = (inbox: ServerMsg[]): RoomInfo => [...inbox].reverse().find((m): m is Extract<ServerMsg, { t: 'room' | 'welcome' }> => m.t === 'room' || m.t === 'welcome')!.room;

describe('ratings', () => {
  it('rate a rated table’s people through the room, the crew left out and a concede placed last', { timeout: 600_000 }, async () => {
    const t = await startTable({ seed: 21, humans: 3, settings: { rated: true } });
    const { world: w, code, clients } = t;
    // (The third person strikes their colours at once; the other two sail on with the crew.)
    await w.send(code, clients[2].sock, { t: 'concede' });
    clients[2].playing = false;
    await play(t);
    await w.settle(code);
    expect(serverState(t).phase).toBe('gameOver');
    for (const c of clients) c.read();
    const info = clients[0].room!;
    expect(info.phase).toBe('over');
    const changes = info.results!.ratings!;
    // Three people rated; the crew's seat isn't.
    expect(changes.map((c) => c.seat).sort()).toEqual([0, 1, 2]);
    for (const c of changes) expect(c.tier).toBe('placement');
    const users = clients.map((c) => c.you!.user);
    const rows = await w.db.all<{ user: string; place: number; rated: number; through: number }>('SELECT user, place, rated, through FROM ratings_games ORDER BY user');
    expect(rows).toHaveLength(3);
    const by = new Map(rows.map((r) => [r.user, r]));
    // The one who conceded is last among the people, and didn't see it through.
    expect(by.get(users[2])!.place).toBe(3);
    expect(by.get(users[2])!.through).toBe(0);
    expect(by.get(users[0])!.through).toBe(1);
    const mus = await w.db.all<{ user: string; mu: number; games: number }>('SELECT user, mu, games FROM ratings');
    expect(mus).toHaveLength(3);
    const mu = new Map(mus.map((r) => [r.user, r.mu]));
    expect(mu.get(users[2])!).toBeLessThan(25);
    expect(Math.min(...mus.map((r) => r.mu))).toBe(mu.get(users[2]));
    // The winner among the people (the most points, or the game's winner) gained.
    const first = rows.find((r) => r.place === 1)!;
    expect(mu.get(first.user)!).toBeGreaterThan(25);
  });

  it('rate only people: the crew’s places don’t count, one person alone isn’t rated, an abandoned game neither', async () => {
    const w = await new World(3).init();
    const [a, b] = [await sailor(w, 'Ann'), await sailor(w, 'Bo')];
    // A bot won; Bo scored more than Ann: Bo is first among the people.
    const g = finished({ seats: [{ user: a.user }, { bot: true }, { user: b.user }, { bot: true }], points: [5, 10, 8, 7], winner: 1 });
    const people = peopleOf(g);
    expect(people.map((p) => p.user)).toEqual([a.user, b.user]);
    const changes = rateTable(g, new Map(), people);
    expect(changes.find((c) => c.user === b.user)!.place).toBe(1);
    expect(changes.find((c) => c.user === a.user)!.place).toBe(2);
    const out = await w.services.finishGame(g);
    expect(out.ratings).toHaveLength(2);
    expect(out.replay).toMatch(/^[A-Za-z0-9_-]+$/);
    // One person and three bots: the game is recorded for Fair winds, and rated for nobody.
    const solo = await w.services.finishGame(finished({ seats: [{ user: a.user }, { bot: true }, { bot: true }, { bot: true }], points: [10, 3, 3, 3], winner: 0, startedAt: 2 }));
    expect(solo.ratings).toBeUndefined();
    // Abandoned: nobody rated, nobody saw it through.
    const gone = await w.services.finishGame(finished({ seats: [{ user: a.user }, { user: b.user }, { bot: true }], points: [4, 4, 4], winner: null, startedAt: 3, abandoned: true }));
    expect(gone.ratings).toBeUndefined();
    const games = await w.db.first<{ games: number }>('SELECT games FROM ratings WHERE user = ?', a.user);
    expect(games!.games).toBe(1);
    const through = await w.db.all<{ through: number; rated: number }>('SELECT through, rated FROM ratings_games WHERE user = ? ORDER BY rowid', a.user);
    expect(through.map((r) => r.through)).toEqual([1, 1, 0]);
    expect(through.map((r) => r.rated)).toEqual([1, 0, 0]);
    // Unrated rooms move nothing.
    const casual = await w.services.finishGame(finished({ seats: [{ user: a.user }, { user: b.user }, { bot: true }], points: [10, 4, 4], winner: 0, startedAt: 4, rated: false }));
    expect(casual.ratings).toBeUndefined();
    // (A game handed over twice is counted once.)
    const again = await w.services.finishGame(g);
    expect(again.ratings).toBeUndefined();
    expect((await w.db.first<{ games: number }>('SELECT games FROM ratings WHERE user = ?', b.user))!.games).toBe(1);
  });

  it('show the tier, the rating and Fair winds on a seat once it’s claimed', async () => {
    const w = await new World(4).init();
    const [a, b, c] = [await sailor(w, 'Ann'), await sailor(w, 'Bo'), await sailor(w, 'Cy')];
    // Ann: six rated games won, then one conceded: 6 of 7 seen through.
    for (let i = 0; i < 7; i++) {
      const conceded = i === 6;
      await w.services.finishGame(finished({ seats: [{ user: a.user, conceded }, { user: b.user }, { user: c.user }], points: [conceded ? 2 : 10, 6, 5], winner: conceded ? 1 : 0, startedAt: 100 + i }));
    }
    const code = await w.createRoom(a.token);
    const s = await w.connect(code, { token: a.token });
    await w.send(code, s, { t: 'claim', seat: 0 });
    const seat = roomOf(s.inbox).seats[0];
    expect(seat.reliability).toBe(0.86);
    expect(seat.rating).toBeGreaterThan(1000);
    expect(seat.tier).toMatch(/^(deckhand|bosun|mate|navigator|captain|commodore|admiral)$/);
    // Someone with no games shows nothing.
    const fresh = await sailor(w, 'Dee');
    const s2 = await w.connect(code, { token: fresh.token });
    await w.send(code, s2, { t: 'claim', seat: 1 });
    const seat1 = roomOf(s2.inbox).seats[1];
    expect(seat1.tier).toBeUndefined();
    expect(seat1.reliability).toBeUndefined();
    // GET /api/ratings/me says where Ann stands.
    const me = await api(w, 'GET', '/api/ratings/me', { token: a.token });
    expect(me.status).toBe(200);
    expect(me.body.games).toBe(7);
    expect(me.body.provisional).toBe(false);
    expect(me.body.reliability).toBe(0.86);
  });

  it('serve the boards: global (past the placement games), this season, friends without the feature', async () => {
    const w = await new World(5).init();
    const people = await Promise.all(['Ann', 'Bo', 'Cy', 'Dee'].map((n) => sailor(w, n)));
    for (let i = 0; i < PLACEMENT_GAMES; i++) {
      await w.services.finishGame(finished({ seats: people.slice(0, 3).map((p) => ({ user: p.user, name: p.name })), points: [10, 7, 5], winner: 0, startedAt: 1000 + i, endedAt: w.now }));
    }
    // Dee has one rated game: still placing, so not on the board.
    await w.services.finishGame(finished({ seats: [{ user: people[3].user, name: 'Dee' }, { user: people[0].user, name: 'Ann' }], points: [3, 10], winner: 1, startedAt: 5000, endedAt: w.now }));
    clearBoardCache();
    const global = await api(w, 'GET', '/api/leaderboard?scope=global&period=all', { token: people[0].token });
    expect(global.status).toBe(200);
    expect(global.body.rows.map((r: { name: string }) => r.name)).toEqual(['Ann', 'Bo', 'Cy']);
    expect(global.body.rows[0].rank).toBe(1);
    expect(global.body.you).toMatchObject({ rank: 1, of: 3 });
    const season = await api(w, 'GET', '/api/leaderboard?scope=global&period=season');
    expect(season.body.rows).toHaveLength(3);
    expect(season.body.season.name).toMatch(/^The \w+ Tide$/);
    const friends = await api(w, 'GET', '/api/leaderboard?scope=friends', { token: people[0].token });
    expect(friends.status).toBe(200);
    expect(friends.body.available).toBe(false);
    expect((await api(w, 'GET', '/api/leaderboard?scope=nowhere')).status).toBe(400);
  });
});
