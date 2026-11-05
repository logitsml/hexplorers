// Junk at the door: random bytes, random JSON, valid messages with their fields mutated, frames
// too large or nested too deep, intents before hello and from seats not held. The room must never
// throw, never apply anything a schema or the engine refused, never send a secret, and keep
// serving the table.

import { describe, expect, it } from 'vitest';
import { viewHash } from '../../src/engine/wire';
import { PROTO, type ClientMsg } from '../../src/net/protocol';
import { parseClientFrame } from '../../src/net/schema';
import { play, seeded, serverState, serverView, startTable, type FakeSocket } from './harness';

const TEMPLATES: ClientMsg[] = [
  { t: 'hello', proto: PROTO, build: 'x', token: 'nope' },
  { t: 'claim', seat: 1, name: 'Zed', color: 'teal' },
  { t: 'settings', settings: { seats: 3, preset: 'allHands' } },
  { t: 'start' },
  { t: 'act', n: 1, at: 0, a: { type: 'endTurn' } },
  { t: 'act', n: 2, at: 3, a: { type: 'offerTrade', give: { brick: 1, wood: 0, wool: 0, wheat: 0, ore: 0, paper: 0, cloth: 0, silver: 0, oil: 0 }, get: { brick: 0, wood: 0, wool: 2, wheat: 0, ore: 0, paper: 0, cloth: 0, silver: 0, oil: 0 } } },
  { t: 'act', n: 3, at: 1, a: { type: 'invasion/turncoat', moves: [{ from: 1, to: 2 }] } },
  { t: 'chat', text: 'hello there' },
  { t: 'chat', quick: 'goodLuck' },
  { t: 'react', r: 'wave' },
  { t: 'report', seat: 0, reason: 'spam' },
  { t: 'kick', seat: 0 },
  { t: 'pause', on: true },
  { t: 'concede' },
  { t: 'handoff' },
  { t: 'rematch' },
  { t: 'nudge', seat: 0 },
];

describe('schema fuzz', () => {
  it('junk frames never throw, never apply, never leak', { timeout: 600_000 }, async () => {
    const t = await startTable({ seed: 51, humans: 1 });
    await play(t, { until: () => serverState(t).seq > 20 });
    const rand = seeded(99);
    const r = () => rand(1)[0] / 256;
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const junkValue = (d = 0): unknown => {
      const k = r();
      if (d > 3 || k < 0.15) return pick([null, true, false, 0, -1, 1e9, -1e15, 0.5, 2 ** 53, '', 'x'.repeat(300), '__proto__', '‮\u0000', NaN]);
      if (k < 0.3) return Math.floor(r() * 2000) - 1000;
      if (k < 0.45) return String.fromCharCode(...rand(1 + Math.floor(r() * 30)));
      if (k < 0.7) return Array.from({ length: Math.floor(r() * 5) }, () => junkValue(d + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < 1 + r() * 4; i++) o[pick(['t', 'a', 'n', 'at', 'type', 'seat', 'give', 'get', 'text', '__proto__', 'constructor', 'x'])] = junkValue(d + 1);
      return o;
    };
    const mutate = (m: ClientMsg): unknown => {
      const o = structuredClone(m) as Record<string, unknown>;
      const keys = Object.keys(o);
      const k = r();
      if (k < 0.3) o[pick(keys)] = junkValue();
      else if (k < 0.5) o[pick(['extra', '__proto__', 'seat', 'a', 'n'])] = junkValue();
      else if (k < 0.7 && typeof o.a === 'object' && o.a) (o.a as Record<string, unknown>)[pick(['type', 'give', 'edge', 'vertex', 'moves', 'x'])] = junkValue();
      else delete o[pick(keys)];
      return o;
    };
    const frame = (): string => {
      const k = r();
      if (k < 0.1) return String.fromCharCode(...rand(1 + Math.floor(r() * 200)));
      if (k < 0.2) return JSON.stringify(junkValue());
      if (k < 0.25) return '['.repeat(50) + ']'.repeat(50);
      if (k < 0.27) return JSON.stringify({ t: 'chat', text: 'y'.repeat(5000) });
      return JSON.stringify(mutate(pick(TEMPLATES)));
    };

    const key = (t.world.rooms.get(t.code)!.room as unknown as { meta: { key: string; gameKey: string } }).meta;
    const spectatorToken = (await t.world.guest('Watcher')).token;
    let watcher: FakeSocket = await t.world.connect(t.code, { token: spectatorToken, watch: true });
    const stranger = await t.world.connect(t.code, { token: 'not-a-token' });
    expect(stranger.closed?.code).toBe(4401);
    const seq = serverState(t).seq;
    const person = t.clients[0];
    let closes = 0;
    let personCloses = 0;
    /** Every frame the fuzzing sockets were sent (theirs are replaced when they reconnect). */
    const sent: string[] = [];
    let accepted = 0;
    for (let i = 0; i < 1500; i++) {
      const f = frame();
      if (parseClientFrame(f).ok) accepted++;
      if (watcher.closed) {
        closes++;
        sent.push(...watcher.raw);
        watcher = await t.world.connect(t.code, { token: spectatorToken, watch: true });
      }
      // The spectator sends anything; so does the person, but only junk that the schema refuses (else it might be a fair move).
      await t.world.send(t.code, watcher, f);
      if (!parseClientFrame(f).ok) await t.world.send(t.code, person.sock, f);
      // (Too many bad frames close a socket: it comes back, as a client would.)
      if (person.sock.closed) {
        personCloses++;
        sent.push(...person.sock.raw);
        person.read();
        person.sock = await t.world.connect(t.code, { token: t.tokens[0], last: person.seq, hash: viewHash(person.view!) });
      }
    }
    expect(personCloses).toBeGreaterThan(0);
    // Nothing a spectator or a refused frame sent changed the game.
    expect(serverState(t).seq).toBe(seq);
    expect(closes).toBeGreaterThan(0);
    // No secret went out: not the dice key, not the game's key.
    for (const raw of [...watcher.raw, ...stranger.raw, ...person.sock.raw, ...sent]) {
      expect(raw.includes(key.key)).toBe(false);
      expect(raw.includes(key.gameKey)).toBe(false);
      expect(raw.includes('rngKey')).toBe(false);
    }
    expect(accepted).toBeGreaterThan(50);
    // The table plays on, in step.
    person.read();
    if (person.sock.closed) {
      person.sock = await t.world.connect(t.code, { token: t.tokens[0], last: person.seq, hash: viewHash(person.view!) });
      person.read();
    }
    person.errors = person.errors.filter((e) => !/^(bad|auth|phase|seat|chat|order|settings|start|rematch|taken|handoff)/.test(e));
    await play(t, { until: () => serverState(t).seq > seq + 30 });
    person.read();
    expect(person.errors).toEqual([]);
    expect(viewHash(person.view!)).toBe(viewHash(serverView(t, 0)));
  });
});
