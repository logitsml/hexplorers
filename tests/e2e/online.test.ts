// Online play end to end: the local server as `npm run server` runs it (createOnline over
// node:http, each room in a node:sqlite file under a temporary folder, sockets through `ws`) and
// the client as a browser tab runs it (api.ts, the identity, Connection over Node's own
// WebSocket, RemoteHost and RoomClient, each person with modules, storage and a store of their
// own). Two people and the crew play whole games, each person deciding with the bots' logic on
// nothing but what their own RemoteHost shows them, and reporting each record shown as the
// presenter does; a spectator watches from the quay.
//
// Along the way: the harbour (seats, colours, ready, chat both ways, entropy for the dice), a
// socket dropped for a moment (the batch) and for long enough to go away (the snapshot, then
// "Take the helm"), the seat opened in another tab, the seat handed to another device by its
// link, the stale race of an answer to an offer withdrawn, table talk, the pause vote, the reveal
// checked roll for roll, conceding, and "Sail again". The whole game (about 45 s) is left out of
// the quick tier; the second test (about 7 s) stays in it.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAction, createGame, legalActions, type Action, type GameEvent, type GameState, type PlayerId } from '../../src/engine';
import { botDecide, cloneMemory, createBotMemory, type BotMemory } from '../../src/engine/ai';
import { mixOf } from '../../src/engine/presets';
import { trackedKinds } from '../../src/engine/tracker';
import { viewHash, type WireView } from '../../src/engine/wire';
import type { HostMessage } from '../../src/game/host';
import { checkReveal } from '../../src/net/codes';
import { RESYNC_BATCH_MAX, type RoomSettings } from '../../src/net/protocol';
import type { TableLine } from '../../src/online/client';
import type { SocketLike } from '../../src/online/connection';
import type { KeyStore, Profile } from '../../src/online/identity';
import { linkFrom, roomPath } from '../../src/online/links';
import type { RemoteHost } from '../../src/online/remoteHost';
import { createOnline, type OnlineApp } from '../../server/node/app';
import { slow, timeout } from '../tier';

type ClientMod = typeof import('../../src/online/client');
type StoreMod = typeof import('../../src/online/store');
type RoomClient = InstanceType<ClientMod['RoomClient']>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each step as it's reached, into the file E2E_LOG names (a long run on a loaded machine can be followed). */
const t0 = Date.now();
const progress = (what: string) => process.env.E2E_LOG && appendFileSync(process.env.E2E_LOG, `${((Date.now() - t0) / 1000).toFixed(1)}s ${what}\n`);

// ------------------------------------------------------------------ the page's globals, per person

/** A tab's localStorage. */
class MemStore implements KeyStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** The storage the identity reads (whoever's tab is acting: set before each of their steps that reads it). */
let storage: KeyStore | null = null;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });

/** The socket a tab opens, wrapped so a test can cut it, keep it down, or hold what it sends. */
class Gate {
  /** No socket can be made (the network is gone). */
  down = false;
  /** What the tab sends waits here (it is on its way, slowly). */
  holdOut = false;
  private out: string[] = [];
  private live: WebSocket | null = null;
  opened = 0;
  closes: number[] = [];
  /** The room's refusals, errors and notices to this tab, as they came. */
  said: string[] = [];

  socket = (url: string): SocketLike => {
    if (this.down) throw new Error('No network.');
    const ws = new WebSocket(url);
    this.live = ws;
    this.opened++;
    const gate = this;
    const s: SocketLike = {
      get readyState() {
        return ws.readyState;
      },
      send(d: string) {
        if (gate.holdOut && ws === gate.live) gate.out.push(d);
        else ws.send(d);
      },
      close(code?: number, reason?: string) {
        ws.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    ws.onopen = (e) => s.onopen?.(e);
    ws.onmessage = (e) => {
      if (typeof e.data === 'string' && /^\{"t":"(nack|error|notice|upgrade)"/.test(e.data)) this.said.push(e.data.slice(0, 160));
      s.onmessage?.({ data: e.data });
    };
    ws.onclose = (e) => {
      this.closes.push(e.code);
      s.onclose?.({ code: e.code, reason: e.reason });
    };
    ws.onerror = (e) => s.onerror?.(e);
    return s;
  };

  /** Send what was held, in order. */
  flush() {
    this.holdOut = false;
    for (const d of this.out.splice(0)) this.live?.send(d);
  }

  /** Cut the socket (from this side, as a network that drops does). */
  kill() {
    this.live?.close();
  }
}

// ------------------------------------------------------------------ the server

let app: OnlineApp;
let server: Server;
let base = '';
let dataDir = '';
const realFetch = globalThis.fetch;
const warnings: string[] = [];
const realWarn = console.warn;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'exploratory-e2e-'));
  app = await createOnline({ root: dataDir, dataDir, publicUrl: 'http://localhost:1' });
  // (Routed as server/node/main.ts routes them: the API, then the page; sockets through upgrade.)
  server = createServer((req, res) => {
    void app.handle(req, res).then((done) => done || res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!app.upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  // A page's relative /api requests, and its location (the socket's URL is made from it).
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => realFetch(typeof url === 'string' && url.startsWith('/') ? `${base}${url}` : url, init)) as typeof fetch;
  (globalThis as { location?: unknown }).location = { protocol: 'http:', host: `127.0.0.1:${port}`, origin: base, pathname: '/', search: '', hash: '' };
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(' '));
    realWarn(...a);
  };
});

afterAll(() => {
  console.warn = realWarn;
  globalThis.fetch = realFetch;
  server?.close();
  app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface ServerRoom {
  meta: { phase: string; host: string } | null;
  seats: { seat: number; kind: string; user?: string; nonce?: string | null; away?: boolean; conceded?: boolean; color: string }[];
  table: { state: GameState; views: Map<number | 'w', WireView> } | null;
  open: { pause: unknown };
}

const room = (code: string) => app.rooms.get(code)!.room as unknown as ServerRoom;
const sstate = (code: string) => room(code).table!.state;

// ------------------------------------------------------------------ a person at a tab

/** A person: their tab's modules (store and all), storage and socket, and a presenter that plays as the bots would. */
class Person {
  readonly gate = new Gate();
  readonly events = { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as Document };
  mods!: { client: ClientMod; store: StoreMod };
  room!: RoomClient;
  host: RemoteHost | null = null;
  /** The hosts this tab has played through (a snapshot keeps one; a new tab makes one). */
  hosts = 0;
  mem: BotMemory = createBotMemory({ waitForHumans: true });
  /** Off: this person doesn't decide (a scripted step, or they've gone quiet). */
  auto = true;
  /** While this holds, they don't decide either (waiting for a moment a scripted step needs). */
  holdWhen: (() => boolean) | null = null;
  /** Moves the room refused after they went out (what the presenter would show). */
  refusals: string[] = [];
  chat: TableLine[] = [];
  closed: string | null = null;
  /** Anything this person saw that they shouldn't have, or that went wrong. */
  problems: string[] = [];
  shown: HostMessage[] = [];
  jumps = 0;
  private lastTry: string | null = null;
  /** A person takes a moment over each move (and the socket's allowance is 20 messages a second). */
  private nextAt = 0;

  constructor(
    readonly name: string,
    readonly profile: Profile,
    readonly store = new MemStore(),
  ) {
    everyone.push(this);
  }

  /** A fresh tab: its own copy of the client's modules (and so its own online store). */
  async load() {
    vi.resetModules();
    const [client, store] = await Promise.all([import('../../src/online/client'), import('../../src/online/store')]);
    this.mods = { client, store };
  }

  get st() {
    return this.mods.store.useOnline.getState();
  }

  get seat(): PlayerId | null {
    return this.host ? this.host.me : (this.st.you?.seat ?? null);
  }

  /** Open a harbour with these settings (as the Multiplayer page does); its code. */
  async hostRoom(settings: Partial<RoomSettings>) {
    if (!this.mods) await this.load();
    storage = this.store;
    return this.mods.client.hostRoom(settings, this.profile.name);
  }

  async join(code: string, o: { watch?: boolean; seatToken?: string } = {}) {
    if (!this.mods) await this.load();
    this.host = null;
    this.room = new this.mods.client.RoomClient(
      code,
      { watch: o.watch, seatToken: o.seatToken, profile: this.profile, deps: { socket: this.gate.socket, events: this.events, random: () => 0 } },
      {
        onGame: (h) => this.attach(h),
        onChat: (l) => this.chat.push(l),
        onClosed: (why) => (this.closed = why),
      },
    );
    // (Nobody waits out the bots' think times here: the presenter's pace is the test's.)
    this.room.waitScale = () => 0;
    storage = this.store;
    await this.room.open();
  }

  private attach(h: RemoteHost) {
    this.host = h;
    this.hosts++;
    h.onError = (e) => this.refusals.push(e);
    h.subscribe((m) => {
      this.check(m);
      this.shown.push(m);
      if (m.jump) this.jumps++;
      // (The presenter reports a record once it has played it out.)
      queueMicrotask(() => h.presented(m.seq));
    });
    queueMicrotask(() => h.presented());
  }

  /** Nothing this seat may not see: other hands by their size only, others' moves by their type, no stolen card between others, no dice key. */
  private check(m: HostMessage) {
    const me = this.host!.me;
    const s = m.state;
    const hidden = trackedKinds(s);
    for (const p of s.players) {
      if (p.id === me) continue;
      for (const k of hidden) if (k !== 'ore' && p.hand[k] !== 0) this.problems.push(`seq ${m.seq}: saw seat ${p.id}'s ${k}`);
      if (p.devCards.some((c) => c.type !== 'knight')) this.problems.push(`seq ${m.seq}: saw seat ${p.id}'s development cards`);
    }
    if (m.actor !== null && m.actor !== me && m.action && Object.keys(m.action).length !== 1) this.problems.push(`seq ${m.seq}: saw seat ${m.actor}'s whole ${m.action.type}`);
    for (const e of m.events) {
      if (e.type === 'stolen' && !e.named && me !== e.thief && me !== e.victim && e.resource !== undefined) this.problems.push(`seq ${m.seq}: saw a stolen card`);
      if (e.type === 'devCardBought' && e.player !== me && (e as { card?: unknown }).card !== undefined) this.problems.push(`seq ${m.seq}: saw a card bought`);
    }
    if ((s as { rngKey?: string }).rngKey) this.problems.push('saw the dice key');
  }

  /** Caught up: everything received has been shown, and no move is on its way. */
  get idle() {
    const h = this.host;
    return !!h && !h.sending && h.backlog === 0 && h.state.seq === h.lastSeq;
  }

  /** Decide and send a move if one is owed now (on what has been shown, as the presenter lets a person). */
  step(): boolean {
    const h = this.host;
    if (!this.auto || !h || h.spectator || !this.idle || this.closed || Date.now() < this.nextAt || this.holdWhen?.()) return false;
    const s = h.state;
    if (s.phase === 'gameOver' || this.st.room?.pause?.on) return false;
    const seat = h.me!;
    const mem = cloneMemory(this.mem);
    let a: Action | null = botDecide(s, seat, mem, 'normal');
    if (!a) return false;
    // (The same move at the same point was refused: something plain instead, so nobody loops. Too
    // many at once is no refusal of the move: it goes again.)
    if (this.refusals.at(-1) === 'One moment, please' && this.lastTry) {
      this.lastTry = null;
      this.refusals.push('(retried)');
    }
    if (this.lastTry === `${s.seq}|${JSON.stringify(a)}`) {
      const legal = legalActions(s, seat);
      a = legal.find((x) => x.type === 'endTurn') ?? legal.find((x) => x.type === 'respondTrade' && !x.accept) ?? legal[0] ?? null;
      if (!a || this.lastTry === `${s.seq}|${JSON.stringify(a)}`) return false;
    }
    this.lastTry = `${s.seq}|${JSON.stringify(a)}`;
    const r = h.submit(seat, a);
    if (!r.ok) {
      this.problems.push(`seq ${s.seq}: ${a.type} refused before it went: ${r.error}`);
      return false;
    }
    this.mem = mem;
    this.nextAt = Date.now() + 60;
    return true;
  }

  /** Where this tab is, in a line (for a step that never comes). */
  get where() {
    const h = this.host;
    if (!h) return `${this.name}: no game (link ${this.st?.link}, seat ${this.st?.you?.seat})`;
    const s = h.state;
    return `${this.name}: seat ${h.me} shown ${s.seq}/${h.lastSeq} backlog ${h.backlog} sending ${h.sending} ${s.phase} turn ${s.turn} current ${s.currentPlayer} link ${this.st.link} last tried ${this.lastTry} refused ${JSON.stringify(this.refusals.slice(-3))} said ${JSON.stringify(this.gate.said.slice(-4))} problems ${this.problems.length}`;
  }

  /** The tab's view hash (what its next hello would carry). */
  get hash() {
    return this.host?.resumeInfo()?.hash ?? null;
  }
}

/** Every person made so far (for saying where each is when a step never comes). */
const everyone: Person[] = [];
let watching: string | null = null;
const serverLine = () => {
  if (!watching) return '';
  const t = app.rooms.get(watching) ? room(watching).table : null;
  return t ? `server: seq ${t.state.seq} ${t.state.phase} turn ${t.state.turn} current ${t.state.currentPlayer} trade ${t.state.trade?.id ?? '-'} pending ${t.state.pending.length}` : 'server: no table';
};

/** Play on (everyone deciding) until `done`, failing after `ms`. */
async function until(what: string, done: () => boolean, people: Person[], ms = 180_000) {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${serverLine()}\n${everyone.map((p) => p.where).join('\n')}`);
    for (const p of people) p.step();
    await sleep(2);
  }
  progress(what);
}

/** Nobody deciding: wait until the room is still and every tab has shown all of it, then check each view against the server's. */
async function inStep(code: string, people: Person[]) {
  let quiet = 0;
  let last = -1;
  const end = Date.now() + 60_000;
  while (quiet < 5) {
    if (Date.now() > end) throw new Error(`never in step: server at ${sstate(code).seq}, tabs at ${people.map((p) => `${p.host?.lastSeq}/${p.host?.state.seq}`).join(', ')}`);
    await sleep(40);
    const seq = sstate(code).seq;
    const level = people.every((p) => p.idle && p.host!.lastSeq === seq);
    quiet = level && seq === last ? quiet + 1 : 0;
    last = seq;
  }
  for (const p of people) expect(p.hash, `${p.name}'s view`).toBe(viewHash(room(code).table!.views.get(p.seat ?? 'w')!));
}

/** The settings the Multiplayer page sends for the base game, as the singleplayer page's choices make them. */
function baseSettings(seats: 3 | 4): Partial<RoomSettings> {
  const mix = mixOf([]);
  return { preset: mix.preset?.id ?? 'custom', modules: mix.modules, map: mix.map, layout: 'random', numberPlacement: 'spiral', victoryPoints: mix.target, friendlyRobber: false, eventDeck: false, knobs: mix.knobs, botDifficulty: 'normal', seats, timer: 'standard' };
}

afterEach(() => {
  // (Every tab a test opened leaves its room, so the next test's rooms are their own.)
  for (const p of everyone.splice(0)) {
    p.auto = false;
    p.room?.leave();
  }
  storage = null;
  watching = null;
});

// ------------------------------------------------------------------ the tests

describe('online play, the real client against the real server', () => {
  slow('two people, the crew and a spectator: the harbour, then a whole game through drops, a new tab, a hand-off, a stale answer, talk and a pause', { timeout: timeout(900_000) }, async () => {
    const ana = new Person('Ana', { name: 'Ana', color: 'red', avatar: 1 });
    const ben = new Person('Ben', { name: 'Ben', color: 'blue', avatar: -1 });

    // ---------------------------------------------------------- the harbour
    const code = await ana.hostRoom(baseSettings(4));
    watching = code;
    expect(code).toMatch(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$/);
    const card = await realFetch(`${base}/api/rooms/${code}`).then((r) => r.json());
    expect(card.phase).toBe('harbour');
    await ana.join(code);
    await until('Ana welcomed', () => ana.st.link === 'open' && !!ana.st.room, []);
    // The host of a harbour just opened sits at its first seat, as herself.
    await until('Ana seated', () => ana.st.room!.seats[0].kind === 'human', []);
    expect(ana.st.you!.seat).toBe(0);
    expect(ana.st.room!.seats[0]).toMatchObject({ name: 'Ana', color: 'red', avatar: 1 });

    // Ben comes by the link.
    const link = linkFrom({ pathname: roomPath(code), search: '', hash: '' })!;
    expect(link).toEqual({ code, watch: false });
    await ben.join(link.code);
    await until('Ben welcomed', () => ben.st.link === 'open' && !!ben.st.room, []);
    expect(ben.st.you!.seat).toBeNull();
    // His colour is Ana's (red, as a first visit's is): the room gives him a free one, and he changes it after.
    ben.room.claim(1, { ...ben.profile, color: 'red' });
    await until('Ben seated', () => ben.st.you?.seat === 1 && ana.st.room!.seats[1].kind === 'human', []);
    expect(ben.st.room!.seats[1].color).not.toBe('red');
    ben.room.claim(1, { ...ben.profile, color: 'teal' });
    await until('Ben in teal', () => ana.st.room!.seats[1].color === 'teal' && ben.st.room!.seats[1].color === 'teal', []);
    // (A colour someone has, asked for outright, is the room's to refuse.)
    ben.room.send({ t: 'claim', seat: 1, color: 'red' });
    await until('the colour refused', () => ben.st.notices.some((n) => /colour/i.test(n.text)), []);

    // A spectator on the quay.
    const cy = new Person('Cy', { name: 'Cy', color: 'white', avatar: 0 });
    await cy.join(code, { watch: true });
    await until('Cy on the quay', () => cy.st.link === 'open' && ana.st.room!.spectators === 1, []);
    expect(cy.st.you!.watch).toBe(true);

    // The harbour's talk, both ways: everyone hears each line, the speaker too.
    ana.room.chat('Fair winds, all');
    ben.room.chat('', 'hello');
    await until('the harbour talk', () => [ana, ben, cy].every((p) => p.st.chat.length >= 2), []);
    for (const p of [ana, ben, cy]) expect(p.st.chat.map((l) => [l.from, l.text ?? l.quick])).toEqual([[0, 'Fair winds, all'], [1, 'hello']]);

    // Each seat has given the dice its entropy (after the commitment was shown).
    expect(ana.st.room!.commit).toMatch(/^[0-9a-f]{64}$/);
    await until('the nonces', () => room(code).seats.slice(0, 2).every((s) => typeof s.nonce === 'string'), []);

    // Not everyone is ready: the start is refused; then it isn't.
    ana.room.start();
    await until('the start refused', () => ana.st.notices.some((n) => /ready/i.test(n.text)), []);
    ben.room.ready(true);
    await until('Ben ready', () => ana.st.room!.seats[1].ready === true, []);
    ana.room.start();
    await until('the game under way', () => [ana, ben, cy].every((p) => !!p.host), []);
    expect(ana.st.room!.phase).toBe('playing');
    expect(ana.st.room!.seats.slice(2).map((s) => s.kind)).toEqual(['bot', 'bot']);
    expect(ana.host!.me).toBe(0);
    expect(ben.host!.me).toBe(1);
    expect(cy.host!.me).toBeNull();
    expect(ana.host!.initialEvents.length).toBeGreaterThan(0);
    const people = [ana, ben];
    let tabs = [ana, ben, cy];

    // ---------------------------------------------------------- the opening, and the clocks
    await until('the opening placed', () => sstate(code).turn >= 1 && !sstate(code).phase.startsWith('setup'), people);
    expect(ana.st.timers).not.toBeNull();
    expect(ben.st.timers!.now).toBeGreaterThan(0);
    await until('turn 4', () => sstate(code).turn >= 4, people);
    for (const p of people) p.auto = false;
    await inStep(code, tabs);

    // ---------------------------------------------------------- a stale answer: Ana withdraws her offer as Ben accepts it
    for (const p of people) p.auto = true;
    const canOffer = () => {
      const s = ana.host!.state;
      return s.phase === 'main' && s.currentPlayer === 0 && s.pending.length === 0 && !s.trade && s.players[0].hand.wood + s.players[0].hand.brick + s.players[0].hand.wool + s.players[0].hand.wheat + s.players[0].hand.ore > 0;
    };
    // (Ana plays on until she is, and is scripted from there; Ben too, once he's level with her.)
    ana.holdWhen = canOffer;
    await until('Ana free to offer', () => ana.idle && canOffer(), people, 300_000);
    ana.auto = false;
    ana.holdWhen = null;
    await until('Ben level', () => ben.idle && ben.host!.lastSeq === ana.host!.lastSeq, [], 30_000);
    ben.auto = false;
    const kinds = ['wood', 'brick', 'wool', 'wheat', 'ore'] as const;
    const hand = ana.host!.state.players[0].hand;
    const give = kinds.find((r) => hand[r] > 0)!;
    // (What Ben has to give, as his own view shows him: he'd take it if he can, else say no.)
    const his = ben.host!.state.players[1].hand;
    const get = kinds.find((r) => r !== give && his[r] > 0) ?? (give === 'ore' ? 'wheat' : 'ore');
    const accept = his[get] > 0;
    const zero = { brick: 0, wood: 0, wool: 0, wheat: 0, ore: 0, paper: 0, cloth: 0, silver: 0, oil: 0 };
    expect(ana.host!.submit(0, { type: 'offerTrade', give: { ...zero, [give]: 1 }, get: { ...zero, [get]: 1 }, to: [1] })).toEqual({ ok: true });
    await until('Ben shown the offer', () => ben.idle && !!ben.host!.state.trade, [], 30_000);
    // Ben's answer is on its way as Ana withdraws the offer; the room has her withdrawal first.
    ben.gate.holdOut = true;
    expect(ben.host!.submit(1, { type: 'respondTrade', accept })).toEqual({ ok: true });
    await until('Ana level', () => ana.idle, [], 30_000);
    expect(ana.host!.submit(0, { type: 'cancelTrade' })).toEqual({ ok: true });
    await until('the offer withdrawn', () => !sstate(code).trade, [], 30_000);
    const before = ben.refusals.length;
    ben.gate.flush();
    await until('Ben told it was too late', () => ben.refusals.length > before, [], 30_000);
    expect(ben.refusals.at(-1)).toBe('Too late: the table had moved on');
    expect(ben.host!.sending).toBe(false);
    // (Stale: decide again. Everyone plays on.)
    for (const p of people) p.auto = true;

    // ---------------------------------------------------------- table talk, both ways
    ana.room.say('Fair winds to you');
    ben.room.say('Thanks!');
    await until('the table talk', () => [ana, ben, cy].every((p) => p.chat.some((l) => l.player === 0 && l.text === 'Fair winds to you') && p.chat.some((l) => l.player === 1 && l.text === 'Thanks!')), people, 30_000);
    expect(ben.st.chat.filter((l) => l.from === 1).at(-1)!.quick).toBe('thanks');

    // ---------------------------------------------------------- the pause: one asks, the table agrees, then it goes on
    await until('turn 7', () => sstate(code).turn >= 7, people);
    ana.room.pause(true);
    await until('the pause asked', () => !!ben.st.room?.pause && ben.st.room.pause.votes.includes(0), people, 30_000);
    expect(ben.st.room!.pause!.on).toBe(false);
    ben.room.pause(true);
    await until('the pause on', () => [ana, ben, cy].every((p) => !!p.st.room?.pause?.on && !!p.st.timers?.paused), [], 30_000);
    expect(ana.st.notices.some((n) => n.kind === 'paused')).toBe(true);
    const pausedAt = sstate(code).seq;
    await sleep(600);
    expect(sstate(code).seq).toBe(pausedAt);
    ana.room.pause(false);
    await until('the game going on', () => [ana, ben].every((p) => !p.st.room?.pause && !p.st.timers?.paused), [], 30_000);

    // ---------------------------------------------------------- Ben's socket drops for a moment: the batch
    await until('turn 9', () => sstate(code).turn >= 9, people);
    const benSocks = ben.gate.opened;
    ben.gate.down = true;
    ben.gate.kill();
    ben.auto = false;
    const from = ben.host!.lastSeq;
    await until('a few records missed', () => sstate(code).seq >= from + 3 || (sstate(code).currentPlayer === 1 && sstate(code).seq > from), [ana], 120_000);
    const benHost = ben.host;
    ben.gate.down = false;
    ben.events.window.dispatchEvent(new Event('online'));
    await until('Ben back', () => ben.st.link === 'open' && ben.gate.opened > benSocks, [ana], 30_000);
    ben.auto = true;
    await until('Ben caught up', () => ben.idle && ben.host!.lastSeq >= sstate(code).seq - 1, people, 30_000);
    // (The same host, caught up by the records missed: no snapshot.)
    expect(ben.host).toBe(benHost);
    expect(ben.jumps).toBe(0);
    for (const p of people) p.auto = false;
    await inStep(code, tabs);
    for (const p of people) p.auto = true;

    // ---------------------------------------------------------- Ana opens the game in a new tab: asked, she plays there, and the old one lets go
    await until('turn 11', () => sstate(code).turn >= 11, people);
    const ana2 = new Person('Ana (new tab)', ana.profile, ana.store);
    ana.auto = false;
    await ana2.join(code);
    // (The old tab is aboard as the same sailor: the new one asks first, and takes the seat on a yes.)
    expect(ana2.st.twin).toBe(true);
    await ana2.room!.choose('here');
    await until('the new tab playing', () => !!ana2.host && ana2.idle, [ben], 60_000);
    expect(ana2.host!.me).toBe(0);
    expect(ana2.host!.resumed).toBe(true);
    await until('the old tab closed', () => ana.closed !== null, [ben, ana2], 30_000);
    const anaSocks = ana.gate.opened;
    await sleep(1500);
    // (It doesn't come back to take the seat again.)
    expect(ana.gate.opened).toBe(anaSocks);
    people.splice(0, 1, ana2);
    tabs = [ana2, ben, cy];
    // Its moves are numbered after the old tab's, so none is taken for one already had.
    const refusedBefore = ana2.refusals.length;
    await until('turn 13', () => sstate(code).turn >= 13, people);
    expect(ana2.refusals.slice(refusedBefore)).toEqual([]);

    // ---------------------------------------------------------- Ben hands his seat to another device
    ben.auto = false;
    await until('Ben idle', () => ben.idle, [ana2], 60_000);
    ben.room.handoff();
    await until('the hand-off link', () => !!ben.st.handoff, [ana2], 30_000);
    const url = new URL(`${base}/r/${code}#seat=${ben.st.handoff}`);
    const taken = linkFrom({ pathname: url.pathname, search: url.search, hash: url.hash });
    expect(taken?.seat).toBe(ben.st.handoff);
    const ben2 = new Person('Ben (phone)', { name: 'Ben', color: 'teal', avatar: -1 });
    await ben2.join(taken!.code, { seatToken: taken!.seat });
    await until('the phone playing', () => !!ben2.host && ben2.idle, [ana2], 60_000);
    expect(ben2.host!.me).toBe(1);
    await until('the laptop let go', () => ben.closed !== null, [ana2, ben2], 30_000);
    expect(ben.st.notices.some((n) => n.kind === 'handedOff')).toBe(true);
    people.splice(1, 1, ben2);
    tabs = [ana2, ben2, cy];
    const benRefused = ben2.refusals.length;
    await until('turn 15', () => sstate(code).turn >= 15, people);
    expect(ben2.refusals.slice(benRefused)).toEqual([]);
    for (const p of people) p.auto = false;
    await inStep(code, tabs);
    for (const p of people) p.auto = true;

    // ---------------------------------------------------------- Ana's link is down long enough to go away: the snapshot, then the helm
    ana2.gate.down = true;
    ana2.gate.kill();
    ana2.auto = false;
    const gone = ana2.host!.lastSeq;
    await until('Ana away', () => !!room(code).seats[0].away, [ben2], 120_000);
    // (The table hears it: her seat shows the crew at the helm.)
    await until('the table told', () => ben2.st.room!.seats[0].away === true && ben2.st.notices.some((n) => n.kind === 'away'), [ben2], 30_000);
    await until('the table far past her', () => sstate(code).seq > gone + RESYNC_BATCH_MAX + 4 || sstate(code).phase === 'gameOver', [ben2], 240_000);
    ana2.gate.down = false;
    ana2.events.window.dispatchEvent(new Event('online'));
    await until('Ana back with the whole view', () => ana2.st.link === 'open' && ana2.jumps > 0 && ana2.idle, [ben2], 60_000);
    if (sstate(code).phase !== 'gameOver') {
      expect(ana2.st.room!.seats[0].away).toBe(true);
      ana2.room.back();
      await until('Ana at the helm', () => !room(code).seats[0].away && ana2.st.room!.seats[0].away !== true, [ben2], 30_000);
      expect(ana2.st.notices.some((n) => n.kind === 'back')).toBe(true);
      ana2.auto = true;
    }

    // ---------------------------------------------------------- to the end
    await until('the game over', () => sstate(code).phase === 'gameOver' && tabs.every((p) => p.idle && p.host!.state.phase === 'gameOver'), people, 600_000);
    await inStep(code, tabs);
    for (const p of [ana, ben, cy, ana2, ben2]) expect(p.problems, p.name).toEqual([]);
    expect(warnings.filter((w) => w.startsWith('online:'))).toEqual([]);
    // Every move of theirs went out once and was taken, but the one that came too late.
    for (const p of [ana2, ben2]) expect(p.refusals.filter((r) => r !== 'Too late: the table had moved on'), p.name).toEqual([]);

    // ---------------------------------------------------------- the reveal: the dice everyone saw, from the key the commitment named
    await until('the reveal', () => tabs.every((p) => !!p.st.reveal) && ana2.st.room?.phase === 'over', [], 30_000);
    const reveal = cy.st.reveal!;
    const commit = cy.st.room!.commit!;
    const rngKey = await checkReveal(commit, reveal.key, reveal.nonces);
    expect(rngKey).toMatch(/^[0-9a-f]{64}$/);
    expect(reveal.nonces.slice(0, 2).every((n) => typeof n === 'string' && n.length >= 16)).toBe(true);
    const seats = cy.host!.state.players.map((p) => ({ name: p.name, color: p.color, isBot: p.isBot }));
    let state = createGame(seats, reveal.options, { rngKey: rngKey! }).state;
    const dice: [number, number][] = [];
    for (const { actor, action } of reveal.log) {
      const r = applyAction(state, actor, action);
      expect(r.ok).toBe(true);
      if (!r.ok) break;
      state = r.state;
      for (const e of r.events) if (e.type === 'diceRolled') dice.push(e.dice);
    }
    expect(state.winner).toBe(sstate(code).winner);
    const seen = cy.shown.flatMap((m) => m.events.filter((e): e is Extract<GameEvent, { type: 'diceRolled' }> => e.type === 'diceRolled').map((e) => e.dice));
    // (Cy came in at the start and was never resynced: every roll went past her.)
    expect(dice).toEqual(seen);
    const results = ana2.st.room!.results!;
    expect(results.winner).toBe(sstate(code).winner);
    expect(results.standings[0].seat).toBe(sstate(code).winner);
  });

  it('a token the server doesn’t know makes a new guest; a seat opened twice doesn’t fight over it; conceding; Sail again', { timeout: timeout(600_000) }, async () => {
    const dee = new Person('Dee', { name: 'Dee', color: 'orange', avatar: 2 });
    const eli = new Person('Eli', { name: 'Eli', color: 'purple', avatar: -2 });
    const code = await dee.hostRoom({ ...baseSettings(3), timer: 'off' });
    watching = code;
    await dee.join(code);
    await until('Dee seated', () => dee.st.you?.seat === 0, []);

    // Eli's device kept a token from a server that has since forgotten it: he comes aboard as a new guest.
    eli.store.setItem('exploratory.online.identity', JSON.stringify({ user: 'g_gone', token: 'xg1.g_gone.abc.def', name: 'Eli', guest: true }));
    await eli.join(code);
    await until('Eli welcomed', () => eli.st.link === 'open' && !!eli.st.you, [], 30_000);
    expect(eli.st.you!.user).not.toBe('g_gone');
    expect(JSON.parse(eli.store.getItem('exploratory.online.identity')!).user).toBe(eli.st.you!.user);
    eli.room.claim(1, eli.profile);
    await until('Eli seated', () => eli.st.you?.seat === 1, [], 30_000);
    eli.room.ready(true);
    await until('Eli ready', () => dee.st.room!.seats[1].ready === true, [], 30_000);
    dee.room.start();
    await until('under way', () => !!dee.host && !!eli.host, [], 60_000);
    const people = [dee, eli];
    await until('turn 3', () => sstate(code).turn >= 3, people);

    // Dee concedes: the crew takes her seat for good, and she isn't offered it back.
    dee.room.concede();
    await until('Dee conceded', () => !!room(code).seats[0].conceded, [eli], 30_000);
    await until('the table told', () => eli.st.notices.some((n) => n.kind === 'conceded') && !!dee.st.room?.seats[0].conceded, [eli], 30_000);
    dee.auto = false;
    // Then Eli: nobody is left at the table, and the game is over.
    eli.room.concede();
    await until('the game given up', () => dee.st.room?.phase === 'abandoned' && eli.st.room?.phase === 'abandoned', [], 30_000);
    await until('the reveal', () => !!dee.st.reveal && !!eli.st.reveal, [], 30_000);
    expect(await checkReveal(dee.st.room!.commit!, dee.st.reveal!.key, dee.st.reveal!.nonces)).not.toBeNull();

    // Sail again: a new harbour for the same table, everyone already in their seat.
    const next = await dee.room.rematch();
    expect(next).toMatch(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$/);
    await until('Eli told of it', () => eli.st.room?.rematch === next, [], 30_000);
    expect(await eli.room.rematch()).toBe(next);
    const dee2 = new Person('Dee', dee.profile, dee.store);
    const eli2 = new Person('Eli', eli.profile, eli.store);
    await dee2.join(next);
    await eli2.join(next);
    await until('both in the next harbour', () => dee2.st.you?.seat === 0 && eli2.st.you?.seat === 1, [], 30_000);
    expect(dee2.st.room!.seats.map((s) => s.kind)).toEqual(['human', 'human', 'bot']);
    expect(dee2.st.you!.host).toBe(true);
    eli2.room.ready(true);
    await until('Eli ready again', () => dee2.st.room!.seats[1].ready === true, [], 30_000);
    dee2.room.start();
    watching = next;
    await until('sailing again', () => !!dee2.host && !!eli2.host, [], 60_000);
    await until('turn 2', () => sstate(next).turn >= 2, [dee2, eli2]);
    for (const p of [dee, eli, dee2, eli2]) expect(p.problems, p.name).toEqual([]);
  });
});
