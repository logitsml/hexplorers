// What a room costs to run, measured on whole games: rows written (by table and purpose), alarms
// set, the rows deleteAll() takes at the end (Cloudflare bills a deleted row as a written one),
// wakes (handler invocations), socket messages in and out, and bytes out per seat (raw, and as
// permessage-deflate would send them). One table per run, printed; with COST_OUT=file the rows
// are written there as JSON too (docs/online/COSTS.md is made from them).
//
// The scenarios: a base live game of 2 people and 2 bots; one of 3 people and a bot (the hosting
// research's central table); 4 people; All Hands with 3 people and a bot; a game with 2
// spectators; and one with 20 lines of chat, reactions and typing. People think 3 s a move and send `seen` as
// a browser does. Each room is followed to its end: everyone leaves, and the finished room's
// summary is kept its week and then wiped.

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OVER_KEEP_MS, type RoomSettings } from '../../src/net/protocol';
import { deflatedSize, FakeSocket, play, serverState, startTable, World, type TestTable } from './harness';

export interface CostRow {
  scenario: string;
  people: number;
  bots: number;
  actions: number;
  turns: number;
  /** Rows written while the room ran (every INSERT/UPDATE/DELETE's changes). */
  rows: number;
  byTable: Record<string, number>;
  /** Why the journal was written (RoomCounters.journal), and how many carries the sockets were given (gzipped). */
  journal: Record<string, number>;
  carries: number;
  squeezed: number;
  alarmsSet: number;
  /** Rows the final deleteAll() deleted. */
  deleted: number;
  /** Bytes the finished room keeps for its week (every row's values). */
  keptBytes: number;
  /** Rows the game wrote to the service database (D1 on Cloudflare: results, ratings, notes), identities left out; by table. */
  service: number;
  serviceBy: Record<string, number>;
  /** What Cloudflare bills as rows written: rows + alarms set + rows deleted. */
  billed: number;
  wakes: number;
  alarmsRung: number;
  connects: number;
  msgsIn: number;
  msgsOut: number;
  /** Per seat (a person's, or 'watch'): frames and bytes out, raw and deflated. */
  perSeat: { seat: string; frames: number; raw: number; deflated: number }[];
}

/** The service database's rows written, by table (its NodeSql keeps them). */
const serviceWrites = (w: World) => (w.db as unknown as { sql: { writesBy: Map<string, number> } }).sql.writesBy;

/** The bytes a room's storage holds (each row's values). */
function storedBytes(t: TestTable): number {
  const sql = t.world.rooms.get(t.code)!.rt.sql;
  let n = 0;
  for (const { name } of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray()) {
    for (const row of sql.exec<Record<string, unknown>>(`SELECT * FROM ${name}`).toArray()) {
      for (const v of Object.values(row)) n += typeof v === 'string' ? v.length : v instanceof Uint8Array ? v.length : 8;
    }
  }
  return n;
}

/** Everyone leaves; the finished room keeps its summary its week, then goes. Returns the bytes it kept. */
async function finish(t: TestTable, extra: FakeSocket[] = []): Promise<number> {
  for (const c of t.clients) c.read();
  for (const c of t.clients) if (!c.sock.closed) c.sock.close(1000, 'bye');
  for (const s of extra) if (!s.closed) s.close(1000, 'bye');
  await t.world.settle(t.code);
  const kept = storedBytes(t);
  await t.world.advance(t.code, OVER_KEEP_MS + 60_000);
  return kept;
}

async function measure(scenario: string, t: TestTable, people: number, bots: number, actions: number, turns: number, keptBytes: number): Promise<CostRow> {
  const e = t.world.rooms.get(t.code)!;
  const c = e.room.counters;
  const by = new Map<string, { frames: number; raw: number; msgs: string[] }>();
  for (const s of e.rt.socks) {
    const a = (s.deserializeAttachment() ?? {}) as { s?: number | null; w?: boolean; u?: string };
    if (!a.u) continue;
    const k = a.w ? 'watch' : a.s != null ? String(a.s) : 'harbour';
    const x = by.get(k) ?? { frames: 0, raw: 0, msgs: [] };
    x.frames += s.raw.length;
    x.raw += s.bytes;
    x.msgs.push(...s.raw);
    by.set(k, x);
  }
  const perSeat = await Promise.all([...by].sort(([a], [b]) => a.localeCompare(b)).map(async ([seat, x]) => ({ seat, frames: x.frames, raw: x.raw, deflated: await deflatedSize(x.msgs) })));
  const w = e.rt.written();
  const rows = w.rows;
  const service = [...serviceWrites(t.world)].filter(([k]) => !/^(guests|sessions|limits|hits)/.test(k));
  return {
    scenario,
    people,
    bots,
    actions,
    turns,
    rows,
    byTable: Object.fromEntries([...w.by].sort(([a], [b]) => a.localeCompare(b))),
    journal: { ...c.journal },
    carries: c.carries,
    squeezed: c.squeezed,
    alarmsSet: e.rt.alarmsSet,
    deleted: e.rt.rowsDeleted,
    keptBytes,
    service: service.reduce((a, [, v]) => a + v, 0),
    serviceBy: Object.fromEntries(service),
    billed: rows + e.rt.alarmsSet + e.rt.rowsDeleted,
    wakes: c.wakes,
    alarmsRung: c.alarms,
    connects: e.rt.socks.length,
    msgsIn: c.messages,
    msgsOut: c.sent,
    perSeat,
  };
}

async function live(scenario: string, o: { seed: number; humans: number; seats?: 3 | 4; settings?: Partial<RoomSettings>; watchers?: number; chat?: number }): Promise<CostRow> {
  const t = await startTable({ seed: o.seed, humans: o.humans, seats: o.seats, settings: o.settings });
  const watchers: FakeSocket[] = [];
  for (let i = 0; i < (o.watchers ?? 0); i++) {
    const token = (await t.world.guest(`Watcher ${i}`)).token;
    watchers.push(await t.world.connect(t.code, { token, watch: true }));
  }
  const lines = o.chat ?? 0;
  let said = 0;
  await play(t, {
    seen: true,
    until: async (step) => {
      // Table talk: a line every 7 steps until `lines` are said, with typing before it and a reaction after.
      if (said < lines && step % 7 === 3) {
        const c = t.clients[said % t.clients.length];
        await t.world.send(t.code, c.sock, { t: 'typing', on: true });
        await t.world.send(t.code, c.sock, { t: 'chat', text: `line ${said + 1}: nice harbour` });
        await t.world.send(t.code, c.sock, { t: 'typing', on: false });
        await t.world.send(t.code, t.clients[(said + 1) % t.clients.length].sock, { t: 'react', r: 'cheer' });
        said++;
      }
      return false;
    },
  });
  const s = serverState(t);
  expect(s.phase).toBe('gameOver');
  expect(said).toBe(lines);
  const kept = await finish(t, watchers);
  const row = await measure(scenario, t, o.humans, (o.seats ?? 4) - o.humans, s.seq, s.turn, kept);
  for (const c of t.clients) expect(c.errors).toEqual([]);
  return row;
}

function table(rows: CostRow[]): string {
  const head = ['scenario', 'actions', 'turns', 'rows', 'alarms set', 'alarms rung', 'deleted', 'billed rows', 'billed/turn', 'wakes', 'msgs in', 'msgs out', 'KB out/seat raw', 'KB out/seat deflated', 'KB kept', 'service rows', 'rows by purpose'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) {
    const seats = r.perSeat.filter((p) => p.seat !== 'harbour');
    const avg = (f: (p: CostRow['perSeat'][number]) => number) => (seats.length ? seats.reduce((a, p) => a + f(p), 0) / seats.length / 1024 : 0).toFixed(1);
    const why = Object.entries(r.journal).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' + ');
    const purpose = Object.entries(r.byTable).map(([k, v]) => (k === 'chunks' && why ? `chunks ${v} (${why})` : `${k} ${v}`)).join(', ');
    lines.push(`| ${[r.scenario, r.actions, r.turns, r.rows, r.alarmsSet, r.alarmsRung, r.deleted, r.billed, (r.billed / Math.max(1, r.turns)).toFixed(2), r.wakes, r.msgsIn, r.msgsOut, avg((p) => p.raw), avg((p) => p.deflated), (r.keptBytes / 1024).toFixed(0), r.service, purpose].join(' | ')} |`);
  }
  return lines.join('\n');
}

describe('what a room costs', () => {
  it('measures rows, alarms, wakes, messages and bytes for each kind of game', { timeout: 1_800_000 }, async () => {
    const rows: CostRow[] = [];
    rows.push(await live('base live: 2 people + 2 bots', { seed: 11, humans: 2 }));
    rows.push(await live('base live: 3 people + 1 bot', { seed: 16, humans: 3 }));
    rows.push(await live('4 people live', { seed: 12, humans: 4 }));
    rows.push(await live('All Hands: 3 people + 1 bot', { seed: 13, humans: 3, settings: { preset: 'allHands' } }));
    rows.push(await live('spectated: 2 people + 2 bots, 2 watching', { seed: 11, humans: 2, watchers: 2 }));
    rows.push(await live('chat: 2 people + 2 bots, 20 lines, reactions', { seed: 11, humans: 2, chat: 20 }));
    console.log(`room costs\n${table(rows)}`);
    if (process.env.COST_OUT) writeFileSync(process.env.COST_OUT, JSON.stringify(rows, null, 2));
    // Guards (a quarter or so above what's measured): a change that writes per action again, or
    // leaves a row per turn for deleteAll, fails here.
    const most: Record<string, number> = { base: 1.6, '4 people': 2.4, 'All Hands': 4.6, spectated: 1.6, chat: 1.6 };
    for (const r of rows) {
      const bound = Object.entries(most).find(([k]) => r.scenario.startsWith(k))![1];
      // (And the service database isn't written every turn of a game: only results, ratings and notes.)
      const service = r.service <= 40;
      expect({ scenario: r.scenario, perTurn: r.billed / r.turns < bound, deleted: r.deleted <= 8, service }).toEqual({ scenario: r.scenario, perTurn: true, deleted: true, service: true });
    }
  });
});
