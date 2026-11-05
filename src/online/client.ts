// A room, from this client: its socket, what the server says about it (into the online store),
// and the game once it starts (a RemoteHost, handed to the session to raise the island for). The
// harbour's and the table's controls go through here as intents; nothing here decides anything
// the room hasn't said.

import { CHAT_KEEP, CHAT_MAX, PROTO, type ChatLine, type ClientMsg, type QuickTalk, type Reaction, type RoomInfo, type RoomSettings, type ServerMsg, type You } from '../net/protocol';
import { BUILD } from '../net/build';
import { b64url } from '../net/codes';
import type { Card, CardCounts, PlayerId } from '../engine';
import type { BotDifficulty } from '../engine/ai';
import { Connection, type ConnectionDeps } from './connection';
import { createRoom, fetchConfig, getRoom, socketUrl, ApiError, type Unavailable } from './api';
import { ensureGuest, forgetIdentity, loadIdentity, loadProfile, type Profile } from './identity';
import { aboardElsewhere, becomeOwnSailor, setAboard } from './tabs';
import { RemoteHost } from './remoteHost';
import { EMPTY_ROOM, useOnline } from './store';
import { QUICK_WORDS, noticeText, quickFor } from './words';

/** A line of table talk in words, for the game's own chat panel: a seat's (-1: the table's, or the quay's). */
export interface TableLine {
  player: PlayerId;
  name?: string;
  text: string;
  /** A deal one of the crew said it would take, offered to it with one click (from your side: give, get). */
  offer?: { to: PlayerId; give: CardCounts; get: CardCounts };
}

/** How long someone shown typing stays shown without a word more (a tab closed mid-line says nothing). */
const TYPING_SHOWN_MS = 8000;

/** A chat line as it reads (quick talk in this client's words). */
export function lineText(l: ChatLine): string {
  return l.text ?? (l.quick ? QUICK_WORDS[l.quick] : '');
}

export interface RoomHooks {
  /** The game has started (or was under way): raise the island for this host. */
  onGame(host: RemoteHost): void;
  /** The room's settings or seats changed (and who you are in it, as it now has it). */
  onRoom?(room: RoomInfo, you: You | null): void;
  /** A line of table talk, for the game's own chat panel. */
  onChat?(line: TableLine): void;
  /** A reaction from a seat (or the quay). */
  onReact?(from: PlayerId | null, r: Reaction): void;
  /** The room has let this client go for good (kicked, handed off, or gone): back to the title. */
  onClosed?(why: string): void;
  /** The table has dropped anchor (enough of it voted to pause), or weighed it again. */
  onPaused?(on: boolean): void;
}

export interface JoinOptions {
  watch?: boolean;
  /** A handed-off seat's token, from a link's #seat= fragment (memory only). */
  seatToken?: string;
  profile?: Profile;
  deps?: Partial<ConnectionDeps>;
}

/** Why the room closed this client's socket for good (connection.ts, FINAL_CLOSES), in words. */
function closeText(code: number): string {
  switch (code) {
    case 4403:
      return 'You can’t come aboard this room.';
    case 4404:
    case 4410:
      return 'This room has closed.';
    case 4409:
      return 'This seat is open in another tab or on another device now.';
    case 4429:
      return 'Too many are watching this game already.';
    case 4426:
      return unavailableText('upgrade');
    default:
      return 'The harbour closed the connection.';
  }
}

/** Why a room can't be joined, in words (the Multiplayer page and the harbour show it). */
export function unavailableText(why: Unavailable): string {
  switch (why) {
    case 'offline':
      return 'Online play isn’t available on this build: there’s no harbour server here.';
    case 'off':
      return 'Online play is switched off on this server for now.';
    case 'upgrade':
      return 'A new version of Hexplorers is out: reload the page to play online.';
    default:
      return 'The harbour server isn’t answering right now. Try again in a moment.';
  }
}

/**
 * Open a harbour with these settings, as a guest made if need be (a token the server no longer
 * knows is replaced, once). Returns the room's code, to join.
 */
export async function hostRoom(settings: Partial<RoomSettings>, name: string): Promise<string> {
  const cfg = await fetchConfig();
  if (!cfg.ok) throw new ApiError(0, unavailableText(cfg.why));
  for (let tries = 0; ; tries++) {
    const id = await ensureGuest(name);
    try {
      return (await createRoom(id.token, settings)).code;
    } catch (e) {
      if (tries === 0 && e instanceof ApiError && e.status === 401) {
        forgetIdentity();
        continue;
      }
      throw e;
    }
  }
}

export class RoomClient {
  readonly code: string;
  readonly watch: boolean;
  host: RemoteHost | null = null;
  private conn: Connection | null = null;
  private token = '';
  private seatToken: string | undefined;
  /** The next batch after a resume's welcome is what was missed: it is shown quickly. */
  private resumed = false;
  private triedNewGuest = false;
  private welcomed = false;
  private left = false;
  /** The seat this client has given the dice its entropy for (a seat changed is a nonce lost: the next one gets its own). */
  private entropyFor: PlayerId | null = null;
  private pausedOn = false;
  private typingTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();
  /** Who last sat in each seat: a notice that someone left comes after their seat has opened. */
  private names = new Map<PlayerId, string>();

  constructor(
    code: string,
    private o: JoinOptions,
    private hooks: RoomHooks,
  ) {
    this.code = code;
    this.watch = !!o.watch;
    this.seatToken = o.seatToken;
    useOnline.getState().set({ ...EMPTY_ROOM, code, watch: this.watch, link: 'connecting' });
  }

  /** Check there's a server, make sure of an identity, and open the socket. */
  async open() {
    // (Asked alongside the server's own questions, so a join waits no longer for it.)
    const kept = loadIdentity();
    const twin = kept && !this.watch && !this.seatToken ? aboardElsewhere(this.code, kept.user) : Promise.resolve(false);
    const cfg = await fetchConfig();
    if (this.left) return;
    if (!cfg.ok) return this.fail(unavailableText(cfg.why));
    // (A code that names no room would only be knocked at again and again: say so instead.)
    const card = await getRoom(this.code).catch(() => undefined);
    if (this.left) return;
    if (card === null) return this.fail('There’s no harbour with that code. Check it, or ask for the link again.');
    // (Another tab of this browser aboard as this sailor: this one would take its seat. Ask first.)
    if (await twin) {
      if (this.left) return;
      useOnline.getState().set({ twin: true });
      return;
    }
    return this.board();
  }

  /**
   * The choice the harbour asked for when another tab is aboard as this sailor: play `here`
   * (the other tab's seat moves to this one), or come aboard as `another` sailor, this tab's own.
   */
  async choose(how: 'here' | 'another') {
    if (this.left || !useOnline.getState().twin) return;
    useOnline.getState().set({ twin: false });
    if (how === 'another') {
      becomeOwnSailor();
      // (A duplicated tab brings its sessionStorage, and with it the other tab's own sailor: a new one.)
      forgetIdentity();
    }
    await this.board();
  }

  /** A guest pass if need be, and the socket. */
  private async board() {
    try {
      this.token = (await ensureGuest(this.profile().name)).token;
    } catch (e) {
      return this.fail(e instanceof ApiError ? e.message : 'Couldn’t make you a guest pass. Try again in a moment.');
    }
    if (this.left) return;
    this.connect();
  }

  private connect() {
    this.conn = new Connection({
      url: socketUrl(this.code),
      hello: () => {
        const resume = this.host?.resumeInfo() ?? null;
        this.resumed = !!resume;
        return { t: 'hello', proto: PROTO, build: BUILD, token: this.token, ...(resume && { last: resume.last, hash: resume.hash }), ...(this.watch && { watch: true }), ...(this.seatToken && { seat: this.seatToken }) };
      },
      onMessage: (m) => this.onMessage(m),
      onState: (link) => useOnline.getState().set({ link }),
      // (A word from the room that already said why, kicked or the seat handed off, has closed it first.)
      onClosed: (code) => this.closed(closeText(code), code === 4409),
      deps: this.o.deps,
    });
    this.conn.open();
  }

  private profile(): Profile {
    return this.o.profile ?? loadProfile();
  }

  private fail(why: string) {
    this.conn?.close(1000, 'refused');
    useOnline.getState().set({ link: 'closed', closedWhy: why });
  }

  send(m: ClientMsg): boolean {
    return this.conn?.send(m) ?? false;
  }

  // ------------------------------------------------------------------ messages

  private onMessage(m: ServerMsg) {
    const st = useOnline.getState();
    switch (m.t) {
      case 'welcome': {
        const first = !this.welcomed;
        this.welcomed = true;
        // (The handed-off seat is yours now: your own token holds it from here.)
        this.seatToken = undefined;
        st.set({ you: m.you, room: m.room, chat: m.chat.slice(-CHAT_KEEP), closedWhy: null });
        if (!this.watch) setAboard({ code: this.code, user: m.you.user });
        this.roomChanged(m.room);
        // The host of a harbour just opened takes its first seat, as themselves (everyone else chooses theirs).
        if (first && !this.watch && m.room.phase === 'harbour' && m.you.host && m.you.seat === null && !m.room.seats.some((x) => x.kind === 'human')) {
          const open = m.room.seats.find((x) => x.kind === 'open');
          if (open) this.claim(open.seat, this.profile());
        }
        return;
      }
      case 'room':
        st.set({ room: m.room });
        this.roomChanged(m.room);
        return;
      case 'snap':
        if (m.timers) this.timers(m.timers);
        if (!this.host) {
          const you = useOnline.getState().you;
          this.host = new RemoteHost({
            seat: this.watch ? null : (you?.seat ?? null),
            snap: m,
            seats: useOnline.getState().room?.seats ?? [],
            send: (x) => this.send(x),
            resync: () => this.conn?.resume(),
            waitScale: this.waitScale,
            ackN: you?.ackN,
          });
          this.host.paused = this.pausedOn || !!useOnline.getState().timers?.paused;
          st.set({ playing: true });
          this.hooks.onGame(this.host);
        } else this.host.receive(m);
        this.resumed = false;
        return;
      case 'g':
        if (m.timers) this.timers(m.timers);
        this.host?.receive(m);
        return;
      case 'gb': {
        const last = m.list[m.list.length - 1];
        if (last?.timers) this.timers(last.timers);
        this.host?.receive(m, { catchUp: this.resumed });
        this.resumed = false;
        return;
      }
      case 'nack':
        this.host?.receive(m);
        return;
      case 'chat': {
        const l = m.line;
        // (A word meant for another seat isn't this one's to show.)
        if (l.to !== undefined && l.to !== st.you?.seat) return;
        st.set({ chat: [...st.chat.slice(-(CHAT_KEEP - 1)), l] });
        // (A line said is the end of its typing.)
        if (l.from !== null && st.typing[l.from]) this.typingOf(l.from, false);
        const text = lineText(l);
        const offer = l.offer && l.from !== null && l.bot ? { to: l.from, give: l.offer.give, get: l.offer.get } : undefined;
        if (text) this.hooks.onChat?.({ player: l.from ?? -1, ...(l.from === null && { name: 'The table' }), text, ...(offer && { offer }) });
        return;
      }
      case 'react':
        st.react(m.from, m.r);
        this.hooks.onReact?.(m.from, m.r);
        return;
      case 'typing':
        this.typingOf(m.seat, m.on);
        return;
      case 'presence': {
        const room = st.room;
        if (!room) return;
        const by = new Map(m.seats.map((x) => [x.seat, x]));
        const seats = room.seats.map((s) => {
          const p = by.get(s.seat);
          return p ? { ...s, online: p.online, away: p.away } : s;
        });
        st.set({ room: { ...room, seats, spectators: m.spectators } });
        this.host?.setSeats(seats);
        return;
      }
      case 'timers':
        this.timers(m.timers);
        if (this.host) this.host.paused = this.pausedOn || !!m.timers.paused;
        return;
      case 'notice': {
        const name = m.seat === undefined ? undefined : st.room?.seats.find((s) => s.seat === m.seat && s.kind !== 'open')?.name || this.names.get(m.seat);
        // (A hail names who sent it, to the one it's for.)
        const mine = m.kind !== 'nudged' && m.seat !== undefined && m.seat === st.you?.seat;
        const words = noticeText(m.kind, name, mine, { playing: st.room?.phase === 'playing' });
        st.notice({ kind: m.kind, seat: m.seat, text: m.text ?? words }, m.kind === 'nudged' ? 6000 : undefined);
        // Put ashore, or your seat taken up on another device: this socket's part is over.
        if ((m.kind === 'kicked' || m.kind === 'handedOff') && (mine || m.seat === undefined)) this.closed(noticeText(m.kind, name, true));
        return;
      }
      case 'handoff':
        st.set({ handoff: m.token });
        return;
      case 'upgrade':
        st.set({ upgrade: true });
        this.conn?.close(1000, 'upgrade');
        return;
      case 'reveal':
        // (The dice key and the log, for checking every roll: kept for the results card.)
        st.set({ reveal: m });
        return;
      case 'error':
        // A token the server doesn't know (the guest was removed): forget it and come back as a new guest, once.
        if (m.code === 'auth' && !this.welcomed && !this.triedNewGuest) {
          this.triedNewGuest = true;
          forgetIdentity();
          this.conn?.close(1000, 'auth');
          this.conn = null;
          void this.open();
          return;
        }
        // Before the welcome, a refusal is the end of it (no such room, full, closed to watchers).
        if (!this.welcomed) {
          this.fail(m.error || 'The harbour turned you away.');
          return;
        }
        st.notice({ kind: 'error', text: m.error });
        return;
    }
  }

  private roomChanged(room: RoomInfo) {
    const st = useOnline.getState();
    for (const x of room.seats) if (x.kind !== 'open' && x.name) this.names.set(x.seat, x.name);
    // Who you are here as the room now has it: `you` came with the welcome, and a seat taken, left
    // or handed on since (or the host's role passed) shows only in the seats.
    const you = st.you;
    if (you) {
      const seat = this.watch ? null : (room.seats.find((x) => x.kind === 'human' && x.user === you.user)?.seat ?? null);
      const host = room.host === you.user;
      if (seat !== you.seat || host !== you.host) st.set({ you: { ...you, seat, host } });
      // Your seat's word to the dice, once the commitment is shown (see ARCHITECTURE.md, Fair dice).
      if (room.phase === 'harbour' && room.commit && seat !== null && this.entropyFor !== seat) {
        if (this.send({ t: 'entropy', nonce: b64url(crypto.getRandomValues(new Uint8Array(24))) })) this.entropyFor = seat;
      }
    }
    const on = !!room.pause?.on;
    // (The game's host first: a seat conceded is watched from now on, and the hooks may look.)
    if (this.host) {
      this.host.setSeats(room.seats);
      this.host.paused = on || !!st.timers?.paused;
    }
    this.hooks.onRoom?.(room, useOnline.getState().you);
    if (on !== this.pausedOn) {
      this.pausedOn = on;
      this.hooks.onPaused?.(on);
    }
  }

  /** Someone typing, or not: shown a while at most without a word more. */
  private typingOf(seat: PlayerId, on: boolean) {
    const st = useOnline.getState();
    const t = this.typingTimers.get(seat);
    if (t) clearTimeout(t);
    this.typingTimers.delete(seat);
    if (on) this.typingTimers.set(seat, setTimeout(() => this.typingOf(seat, false), TYPING_SHOWN_MS));
    if (!!st.typing[seat] !== on) st.set({ typing: { ...st.typing, [seat]: on } });
  }

  private timers(t: NonNullable<Extract<ServerMsg, { t: 'timers' }>['timers']>) {
    useOnline.getState().set({ timers: t, skew: t.now - Date.now() });
  }

  /** How long a bot's think time lasts here: set by the session (the bot pace over the animation speed). */
  waitScale: () => number = () => 1;

  private closed(why: string, rejoin = false) {
    this.conn?.close(1000, 'closed');
    setAboard(null);
    useOnline.getState().set({ link: 'closed', closedWhy: why, rejoin });
    this.hooks.onClosed?.(why);
  }

  // ------------------------------------------------------------------ the harbour

  claim(seat: PlayerId, p: Profile) {
    // (Your colour, unless someone at the table has it: then the room gives you a free one, to change after.)
    const taken = useOnline.getState().room?.seats.some((x) => x.seat !== seat && x.kind !== 'open' && x.color.toLowerCase() === p.color.toLowerCase());
    return this.send({ t: 'claim', seat, name: p.name, ...(!taken && { color: p.color }), avatar: p.avatar });
  }
  unclaim() {
    return this.send({ t: 'unclaim' });
  }
  ready(on: boolean) {
    return this.send({ t: 'ready', on });
  }
  settings(settings: Partial<RoomSettings>) {
    return this.send({ t: 'settings', settings });
  }
  seatBot(seat: PlayerId, difficulty: BotDifficulty | null) {
    return this.send({ t: 'seatBot', seat, difficulty });
  }
  kick(seat: PlayerId) {
    return this.send({ t: 'kick', seat });
  }
  transfer(seat: PlayerId) {
    return this.send({ t: 'transfer', seat });
  }
  start(force = false) {
    return this.send({ t: 'start', ...(force && { force: true }) });
  }

  // ------------------------------------------------------------------ the table

  /** Say something at the table: a quick-talk phrase goes as its code, anything else as free text. */
  say(text: string) {
    return this.chat(text, quickFor(text));
  }

  /** A line of table talk: a quick-talk word, or free text (the room drops it when free chat is off). */
  chat(text: string, quick?: QuickTalk) {
    if (quick) return this.send({ t: 'chat', quick });
    const t = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    return t ? this.send({ t: 'chat', text: t }) : false;
  }
  react(r: Reaction) {
    return this.send({ t: 'react', r });
  }
  typing(on: boolean) {
    return this.send({ t: 'typing', on });
  }
  /** Ask for a link that takes this seat to another device (it comes back as `handoff`). */
  handoff() {
    return this.send({ t: 'handoff' });
  }
  /** Take the helm back from the bot that stood in while you were away. */
  back() {
    return this.send({ t: 'back' });
  }
  /** Come aboard again on a fresh socket: the room reads whom you've blocked as you do. */
  rejoin() {
    this.conn?.resume();
  }
  pause(on: boolean) {
    return this.send({ t: 'pause', on });
  }
  concede() {
    return this.send({ t: 'concede' });
  }

  /** Hail the seat the table waits on: only they hear it (the room holds you to one a while). */
  nudge(seat: PlayerId) {
    if (!this.send({ t: 'nudge', seat })) return false;
    const st = useOnline.getState();
    const name = st.room?.seats.find((x) => x.seat === seat)?.name ?? 'them';
    st.set({ hailedAt: Date.now() });
    st.notice({ kind: 'nudged', seat, text: `You hailed ${name}`, local: true });
    return true;
  }

  /** Looking for / Spare: what you'd like and would part with, for the table to read (empty lists clear it). */
  wants(looking: Card[], spare: Card[]) {
    return this.send({ t: 'wants', looking, spare });
  }

  /**
   * "Sail again" once the game is over: the next room for this table (made by whoever asks first,
   * with everyone's seats kept for them), its code once the room has it.
   */
  rematch(): Promise<string> {
    const st = useOnline.getState();
    if (st.room?.rematch) return Promise.resolve(st.room.rematch);
    return new Promise((resolve, reject) => {
      const done = (f: () => void) => {
        clearTimeout(timer);
        unsub();
        f();
      };
      const timer = setTimeout(() => done(() => reject(new Error('The harbour didn’t answer.'))), 10_000);
      const unsub = useOnline.subscribe((s, prev) => {
        if (s.room?.rematch) done(() => resolve(s.room!.rematch!));
        else if (s.link === 'closed') done(() => reject(new Error(s.closedWhy ?? 'The room has closed.')));
        else if (s.notices !== prev.notices && s.notices.at(-1)?.kind === 'error') done(() => reject(new Error(s.notices.at(-1)!.text)));
      });
      if (!this.send({ t: 'rematch' })) done(() => reject(new Error('Not connected: try again in a moment.')));
    });
  }

  /** Leave the room: the room hears it (a seat in a game goes to the crew), and the socket closes. */
  leave() {
    if (this.left) return;
    this.left = true;
    setAboard(null);
    this.send({ t: 'leave' });
    this.conn?.close(1000, 'leave');
    this.conn = null;
    this.host?.dispose();
    this.host = null;
    for (const t of this.typingTimers.values()) clearTimeout(t);
    this.typingTimers.clear();
    useOnline.getState().set({ ...EMPTY_ROOM });
  }
}
