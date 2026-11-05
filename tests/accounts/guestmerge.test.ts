// A guest who signs in to an account they already had keeps their games: the record, the ratings,
// and the seat they hold in a room (which still names the guest's id).

import { describe, expect, it } from 'vitest';
import { account, api, guest, signInWith } from './helpers';

describe('a guest signing in to an existing account', () => {
  it('keeps the seat they held, the ratings rows and an alias for the old id; erasing clears them', async () => {
    const a = await api(41);
    const acc = await account(a, 'Heron Pike');
    const other = await guest(a, 'Heron on the iPad');
    const w = a.world;
    const code = await w.createRoom(other.token, { settings: { seats: 3 } });
    const sock = await w.connect(code, { token: other.token });
    await w.send(code, sock, { t: 'claim', seat: 1 });
    await w.db.run('INSERT INTO ratings(user, name, mu, sigma, games, provisional, tier, display, updated) VALUES (?, ?, 25, 8, 2, 1, ?, 100, 1)', other.user, 'Heron', 'Deckhand');
    await w.db.run('INSERT INTO ratings_games(game, room, user, at, rated, through) VALUES (?, ?, ?, 1, 1, 1)', 'g1', code, other.user);

    const r = await signInWith(a, acc.key, other.token);
    expect(r.status).toBe(200);
    expect(await w.services.identify(other.token)).toBeNull();
    expect((await w.db.first('SELECT user FROM ratings WHERE user = ?', acc.user))).toBeTruthy();
    expect(await w.db.first('SELECT user FROM ratings WHERE user = ?', other.user)).toBeNull();
    expect(await w.db.first('SELECT user FROM ratings_games WHERE user = ?', acc.user)).toBeTruthy();
    expect(await w.services.aliases!(acc.user)).toEqual([other.user]);

    // The account's own token finds the seat the guest held.
    const mine = await w.connect(code, { token: r.body.token });
    await w.settle(code);
    const welcome = mine.inbox.find((m) => m.t === 'welcome') as Extract<(typeof mine.inbox)[number], { t: 'welcome' }>;
    expect(welcome.you.user).toBe(acc.user);
    expect(welcome.you.seat).toBe(1);
    expect(welcome.you.host).toBe(true);

    // The logbook has the ratings; erasing takes them and the alias.
    const out = await a.json('GET', '/api/me/export', { token: r.body.token });
    expect(out.status).toBe(200);
    expect(out.body.ratedGames).toHaveLength(1);
    const del = await a.json('DELETE', '/api/me', { token: r.body.token, body: { confirm: acc.handle } });
    expect(del.status).toBe(200);
    expect(await w.db.first('SELECT user FROM ratings WHERE user = ?', acc.user)).toBeNull();
    expect(await w.db.first('SELECT user FROM ratings_games WHERE user = ?', acc.user)).toBeNull();
    expect(await w.services.aliases!(acc.user)).toEqual([]);
  });
});
