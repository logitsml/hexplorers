import { describe, expect } from 'vitest';
import { LocalHost, type SeatConfig } from '../src/game/host';
import { slow, timeout } from './tier';

const seats: SeatConfig[] = [
  { name: 'A', color: 'red', isBot: true, difficulty: 'normal' },
  { name: 'B', color: 'blue', isBot: true, difficulty: 'hard' },
  { name: 'C', color: 'white', isBot: true, difficulty: 'easy' },
];

describe('save and resume', () => {
  slow('replaying the action history reproduces the exact game state', () => {
    const opts = { seed: 4242, layout: 'random' as const, numberPlacement: 'spiral' as const };
    const host = new LocalHost(seats, opts);
    for (let i = 0; i < 600; i++) {
      const next = host.nextBotAction();
      if (!next) break;
      const r = host.submitBot(next);
      expect(r.ok).toBe(true);
    }
    // Round-trip through JSON as the save does.
    const history = JSON.parse(JSON.stringify(host.history));
    const resumed = new LocalHost(seats, opts);
    resumed.replay(history);
    expect(resumed.state).toEqual(host.state);
    expect(resumed.history.length).toBe(host.history.length);
  }, timeout(60_000));

  slow('a game resumed mid-turn continues exactly as the uninterrupted game', () => {
    for (const seed of [3, 11, 29, 47, 58]) {
      const opts = { seed, layout: 'random' as const, numberPlacement: 'spiral' as const };
      const a = new LocalHost(seats, opts);
      // Play to an arbitrary point (usually mid-turn), then branch.
      const cut = 150 + (seed % 37);
      for (let i = 0; i < cut; i++) {
        const next = a.nextBotAction();
        if (!next) break;
        a.submitBot(next);
      }
      const b = new LocalHost(seats, opts);
      b.replay(JSON.parse(JSON.stringify(a.history)));
      for (let i = 0; i < 120; i++) {
        const na = a.nextBotAction();
        const nb = b.nextBotAction();
        expect(nb?.action).toEqual(na?.action);
        if (!na || !nb) break;
        a.submitBot(na);
        b.submitBot(nb);
      }
      expect(b.state).toEqual(a.state);
    }
  }, timeout(60_000));
});
