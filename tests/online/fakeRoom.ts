// A scripted stand-in for the room server, for RemoteHost's tests: a real game on a LocalHost (the
// crew at seats 1-3, a person at seat 0), with every record sent as the protocol says the room
// sends it to each seat: the action as actionFor gives it, the events as eventsFor gives them, a
// patch from that seat's last WireView (diffView) and its hash every HASH_EVERY records. Messages
// wait in queues both ways, so a test decides when each is delivered (or dropped, or spoiled).

import type { Action, GameEvent, PlayerId } from '../../src/engine';
import { LocalHost, type HostClock, type SeatConfig } from '../../src/game/host';
import { actionFor, eventsFor, type Viewer } from '../../src/engine/visibility';
import { diffView, viewHash, wireView, type WireView } from '../../src/engine/wire';
import { HASH_EVERY, RESYNC_BATCH_MAX, type ClientMsg, type GameRecord, type NackCode, type ServerMsg } from '../../src/net/protocol';

export const CREW: SeatConfig[] = [
  { name: 'Ana', color: 'red', isBot: false },
  { name: 'Captain Bramble', color: 'blue', isBot: true, difficulty: 'normal' },
  { name: 'Wren Ashdown', color: 'white', isBot: true, difficulty: 'normal' },
  { name: 'Tobias Forge', color: 'orange', isBot: true, difficulty: 'normal' },
];

/** Timers that never fire on their own (the host's offer backstop stays out of the way). */
export function stillClock(): HostClock & { advance(ms: number): void; pending(): number } {
  let t = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.set(++id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (x) => void timers.delete(x as number),
    advance(ms) {
      t += ms;
      for (const [k, v] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (v.at > t || !timers.has(k)) continue;
        timers.delete(k);
        v.fn();
      }
    },
    pending: () => timers.size,
  };
}

interface Socket {
  viewer: Viewer;
  /** The view this socket was last sent, and the records it has had. */
  view: WireView;
  sent: number;
  outbox: ServerMsg[];
  /** Records it missed while "dropped" (they are queued nowhere). */
  dropped: boolean;
}

export class FakeRoom {
  readonly host: LocalHost;
  seq = 0;
  /** Every record by seq (for a resume's batch), with the view each viewer had after it (kept for the last few dozen only). */
  private log: { actor: PlayerId; action: Action; events: GameEvent[]; hashes: Map<Viewer, string>; views: Map<Viewer, WireView> | null }[] = [];
  readonly sockets: Socket[] = [];
  /** What came in from clients, in order. */
  readonly received: ClientMsg[] = [];
  /** Answers to trades the person sent, with the offer id each named and the one open when it came. */
  readonly answers: { type: Action['type']; offer: number | undefined; open: number | undefined }[] = [];
  /** The next act is refused with this code. */
  refuseNext: NackCode | null = null;
  /** Bot moves carry this think time (ms). */
  botWait = 0;
  private pendingAck: { n: number; viewer: Viewer } | null = null;
  readonly initialEvents: GameEvent[];

  /** `crewOnly`: the crew plays every seat (a client only watches its seat's view). */
  constructor(options: { seed: number; layout?: 'random' | 'beginner'; crewOnly?: boolean }, readonly clock = stillClock()) {
    const seats = options.crewOnly ? CREW.map((s) => ({ ...s, isBot: true, difficulty: 'normal' as const })) : CREW;
    this.host = new LocalHost(seats, { seed: options.seed, layout: options.layout ?? 'random' }, clock);
    this.initialEvents = this.host.initialEvents;
    this.host.subscribe((m) => this.broadcast(m.actor!, m.action!, m.events));
  }

  get state() {
    return this.host.state;
  }

  /** A socket for this viewer (seat or null), with its snapshot queued. */
  connect(viewer: Viewer): Socket {
    const view = wireView(this.state, viewer);
    const sock: Socket = { viewer, view, sent: this.seq, outbox: [], dropped: false };
    this.sockets.push(sock);
    sock.outbox.push(this.snapFor(sock, this.seq === 0));
    return sock;
  }

  private snapFor(sock: Socket, opening: boolean): ServerMsg {
    sock.view = wireView(this.state, sock.viewer);
    sock.sent = this.seq;
    return { t: 'snap', seq: this.seq, view: structuredClone(sock.view), hash: viewHash(sock.view), ...(opening && { initialEvents: eventsFor(this.initialEvents, sock.viewer) }) };
  }

  /** The record of the latest action as `sock` sees it (and its new view remembered). */
  private recordFor(sock: Socket, seq: number): GameRecord {
    const entry = this.log[seq - 1];
    const next = entry.views!.get(sock.viewer)!;
    const rec: GameRecord = {
      seq,
      actor: entry.actor,
      a: actionFor(entry.action, entry.actor, sock.viewer),
      e: eventsFor(entry.events, sock.viewer),
      p: diffView(sock.view, next),
      ...(seq % HASH_EVERY === 0 && { h: entry.hashes.get(sock.viewer) }),
    };
    sock.view = next;
    sock.sent = seq;
    return rec;
  }

  private broadcast(actor: PlayerId, action: Action, events: GameEvent[]) {
    this.seq++;
    const views = new Map<Viewer, WireView>();
    const hashes = new Map<Viewer, string>();
    for (const s of this.sockets) {
      if (views.has(s.viewer)) continue;
      const v = wireView(this.state, s.viewer);
      views.set(s.viewer, v);
      hashes.set(s.viewer, viewHash(v));
    }
    this.log.push({ actor, action, events, views, hashes });
    // (Only a resume within a batch's reach needs an old view.)
    const old = this.log[this.seq - RESYNC_BATCH_MAX - 3];
    if (old) old.views = null;
    for (const s of this.sockets) {
      if (s.dropped) continue;
      const rec = this.recordFor(s, this.seq);
      if (this.pendingAck && this.pendingAck.viewer === s.viewer) rec.ackN = this.pendingAck.n;
      if (actor !== 0 && this.botWait) rec.wait = this.botWait;
      s.outbox.push({ t: 'g', ...structuredClone(rec) });
    }
    this.pendingAck = null;
  }

  /** A message from the client on `sock`. */
  hear(sock: Socket, m: ClientMsg) {
    this.received.push(m);
    if (m.t !== 'act') return;
    if (sock.viewer === null) {
      sock.outbox.push({ t: 'nack', n: m.n, code: 'auth', error: 'Watching' });
      return;
    }
    const open = this.state.trade?.id;
    if (['respondTrade', 'counterTrade', 'acceptTrade', 'cancelTrade'].includes(m.a.type)) this.answers.push({ type: m.a.type, offer: (m.a as { offer?: number }).offer, open });
    if (this.refuseNext) {
      sock.outbox.push({ t: 'nack', n: m.n, code: this.refuseNext, error: 'Refused by the test' });
      this.refuseNext = null;
      return;
    }
    // The stale race the offer id guards against.
    const named = (m.a as { offer?: number }).offer;
    if (named !== undefined && named !== open) {
      sock.outbox.push({ t: 'nack', n: m.n, code: 'stale', error: 'That offer has moved on' });
      return;
    }
    this.pendingAck = { n: m.n, viewer: sock.viewer };
    const r = this.host.submit(sock.viewer, m.a);
    if (!r.ok) {
      this.pendingAck = null;
      sock.outbox.push({ t: 'nack', n: m.n, code: 'rule', error: r.error });
    }
  }

  /** One bot move, if one is due. */
  botStep(): boolean {
    const d = this.host.nextBotAction();
    if (!d) return false;
    const r = this.host.submitBot(d);
    if (!r.ok) throw new Error(`bot move refused: ${r.error}`);
    return true;
  }

  /**
   * The socket comes back after a drop, with the hello's `last` and `hash` (null: asked whole):
   * what it missed comes as one batch, or as a snapshot when it's far behind or its hash is off.
   */
  resume(sock: Socket, info: { last: number; hash: string } | null) {
    sock.dropped = false;
    const entry = info && info.last >= 1 && info.last <= this.seq ? this.log[info.last - 1] : null;
    if (!info || !entry?.views || entry.hashes.get(sock.viewer) !== info.hash || this.seq - info.last > RESYNC_BATCH_MAX) {
      sock.outbox.push(this.snapFor(sock, false));
      return;
    }
    sock.view = entry.views.get(sock.viewer)!;
    const list: GameRecord[] = [];
    for (let q = info.last + 1; q <= this.seq; q++) list.push(this.recordFor(sock, q));
    sock.outbox.push({ t: 'gb', list: structuredClone(list) });
  }
}
