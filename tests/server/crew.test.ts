// The crew a room seats: names drawn without repeats, each with the portrait and voice that go
// with it, whether the host seats them or the table sails with open seats.

import { describe, expect, it } from 'vitest';
import type { RoomInfo, ServerMsg } from '../../src/net/protocol';
import { avatarOf, voiceOf } from '../../src/game/names';
import { World, type FakeSocket } from './harness';

const last = <T extends ServerMsg['t']>(s: FakeSocket, t: T) => s.inbox.filter((m) => m.t === t).at(-1) as Extract<ServerMsg, { t: T }> | undefined;
const room = (s: FakeSocket) => (last(s, 'room')?.room ?? last(s, 'welcome')?.room) as RoomInfo;

describe('the crew in a room', () => {
  it('seats bots by the host and by sailing with open seats: different names, faces and voices, none the host’s portrait', async () => {
    const taken = new Set<string>();
    for (let seed = 1; seed <= 6; seed++) {
      const w = await new World(seed).init();
      const a = await w.guest('Ann');
      const code = await w.createRoom(a.token);
      const s = await w.connect(code, { token: a.token });
      await w.send(code, s, { t: 'claim', seat: 0, avatar: 1 });
      await w.send(code, s, { t: 'seatBot', seat: 1, difficulty: 'normal' });
      await w.send(code, s, { t: 'seatBot', seat: 2, difficulty: 'normal' });
      const seated = room(s).seats.filter((x) => x.kind === 'bot');
      expect(seated).toHaveLength(2);
      // (Seated one by one, each avoids the faces and voices already there.)
      for (const b of seated) expect(b.avatar).toBe(avatarOf(b.name));
      await w.send(code, s, { t: 'start' });
      expect(room(s).phase).toBe('playing');
      const bots = room(s).seats.filter((x) => x.kind === 'bot');
      expect(bots).toHaveLength(3);
      expect(new Set(bots.map((b) => b.name)).size).toBe(3);
      expect(new Set(bots.map((b) => b.avatar)).size).toBe(3);
      expect(new Set(bots.map((b) => voiceOf(b.name))).size).toBe(3);
      for (const b of bots) {
        expect(b.avatar).toBe(avatarOf(b.name));
        expect(b.avatar).not.toBe(1);
        taken.add(b.name);
      }
    }
    // Across rooms, it is not always the same crew.
    expect(taken.size).toBeGreaterThan(3);
  });
});
