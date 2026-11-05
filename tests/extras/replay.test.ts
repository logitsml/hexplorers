// An online game's replay: a whole game played on the server harness, its replay fetched through
// the router as the /replay/ID page fetches it, its dice checked against the commitment the table
// was shown (checkReveal), and LocalHost, given the game's key as its secret, replaying it as the
// session's replay would, to the very state the server ended with. A tampered key or commitment
// isn't called fair.

import { describe, expect, it } from 'vitest';
import type { GameState } from '../../src/engine';
import { canonical, wireView } from '../../src/engine/wire';
import { LocalHost } from '../../src/game/host';
import { checkReplay, fetchReplay, toSavedGame, type ReplayRecord } from '../../src/online/replay';
import { play, serverState, startTable } from '../server/harness';
import { context, routerFetch } from './helpers';

/** A state as everyone may see it once the game is over, who was a bot aside (a replay has no bots). */
const seen = (s: GameState) => canonical(wireView({ ...s, players: s.players.map((p) => ({ ...p, isBot: false })) }, null));

describe('an online game’s replay', () => {
  it('fetches, checks the dice and replays to the server’s final state', { timeout: 1_200_000 }, async () => {
    const t = await startTable({ seed: 5, humans: 1, seats: 3 });
    await play(t);
    await t.world.settle(t.code);
    for (const c of t.clients) c.read();
    const end = serverState(t);
    expect(end.phase).toBe('gameOver');
    const room = t.clients[0].room!;
    const id = room.results?.replay;
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);

    // Fetched as the page does (GET /api/replays/:id), and checked against the commitment seen at the table.
    const ctx = context(t.world);
    const got = await fetchReplay(id!, { f: routerFetch(ctx) });
    if (!got.ok) throw new Error(got.text);
    const record = got.record;
    expect(record.options.rng).toBe('chacha20');
    const out = await checkReplay(record, { commit: room.commit });
    if (!out.ok) throw new Error(out.text);
    expect(out.fair).toBe(true);
    expect(out.commitSeen).toBe(true);
    const game = out.game;
    expect(game.online).toMatchObject({ rng: 'chacha20', fair: true, secret: { rngKey: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(game.seats.map((s) => s.isBot)).toEqual([false, true, true]);
    expect(game.history).toHaveLength(record.log.length);

    // Played as session.start plays a replay: every seat recorded, the options from the record, the key as the secret.
    const cfg = game.cfg;
    const host = new LocalHost(
      game.seats.map((s) => ({ ...s, isBot: false })),
      { seed: cfg.seed, layout: cfg.layout, numberPlacement: cfg.numberPlacement, victoryPoints: cfg.victoryPoints, friendlyRobber: cfg.friendlyRobber, eventDeck: cfg.eventDeck, modules: cfg.modules, map: cfg.map, custom: cfg.custom, knobs: cfg.knobs, rules: game.rules, moduleRules: game.moduleRules, rng: game.online!.rng, daily: game.online!.daily },
      undefined,
      game.online!.secret,
    );
    host.replay(game.history);
    expect(host.state.phase).toBe('gameOver');
    expect(host.state.winner).toBe(end.winner);
    expect(host.state.seq).toBe(end.seq);
    expect(host.state.turn).toBe(end.turn);
    expect(seen(host.state)).toBe(seen(end));
    host.dispose();
    // (And without the key it can't even start: the dice are the key's.)
    expect(() => new LocalHost(game.seats, { ...record.options })).toThrow(/key/);

    // A commitment other than the one shown, or a key changed: not fair.
    const wrongCommit = await checkReplay(record, { commit: 'ab'.repeat(32) });
    expect(wrongCommit.ok && wrongCommit.fair).toBe(false);
    const flipped: ReplayRecord = { ...record, key: record.key!.replace(/^./, (c) => (c === '0' ? '1' : '0')) };
    const tampered = await checkReplay(flipped, { commit: room.commit });
    expect(tampered.ok && tampered.fair).toBe(false);
    // Results the log doesn't reach aren't fair either.
    const boasted = await checkReplay({ ...record, points: record.points.map((p) => p + 1) }, { commit: room.commit });
    expect(boasted.ok && boasted.fair).toBe(false);
    // No commitment remembered here (a link from someone else): checked against the replay's own.
    const stranger = await checkReplay(record);
    expect(stranger.ok && stranger.fair && !stranger.commitSeen).toBe(true);

    // A replay without its dice key can't be checked: broken, not fair.
    const noDice = await checkReplay({ ...record, key: null });
    expect(noDice).toMatchObject({ ok: false, why: 'broken' });

    // Missing, and junk.
    expect(await fetchReplay('AAAAAAAAAAAAAAAA', { f: routerFetch(ctx) })).toMatchObject({ ok: false, why: 'missing' });
    expect(await fetchReplay('../etc', { f: routerFetch(ctx) })).toMatchObject({ ok: false, why: 'missing' });
    // The record as the session plays it: seat 0's face, the crew's portraits by name.
    const again = toSavedGame(record, game.cfg.board, game.online!.secret, true);
    expect(again.cfg.opponents).toBe(2);
    expect(again.avatars[0]).toBe(-1);
  });
});
