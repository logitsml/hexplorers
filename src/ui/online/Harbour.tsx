// The harbour: an online room before it sets sail. A wide card over the sea: the code to pass on
// along its top; the crew on the left (the seats, and under them your own name, picture and
// colour, or the way aboard); the voyage on the right (the host's settings, or the same read out
// for everyone else) over the chat; and along its foot a line saying what the table is waiting
// for, beside the one thing to do about it (Set sail for the host, I'm ready for the others).
// Everything here is a request to the room; what shows is what the room says back (useOnline).
// On a phone it is one column, the whole screen, scrolling, the foot kept in reach.

import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { session } from '../../app/session';
import { sfx } from '../../audio/sfx';
import type { PlayerColor, PlayerId } from '../../engine';
import type { BotDifficulty } from '../../engine/ai';
import { DIFFICULTY_BLURBS } from '../../engine/ai/profiles';
import { PRESETS, mixOf } from '../../engine/presets';
import { QUICK_TALK, type ChatLine, type RoomInfo, type RoomSettings, type SeatInfo, type TimerPreset } from '../../net/protocol';
import { lineText } from '../../online/client';
import { loadProfile, saveProfile, type Profile } from '../../online/identity';
import { roomUrl, spacedCode } from '../../online/links';
import { amHost, mySeat, useOnline } from '../../online/store';
import { QUICK_WORDS } from '../../online/words';
import { PLAYER_PALETTE, PRESET_COLORS } from '../../render/board/pieces';
import { AVATAR_CHOICES, AvatarFace, avatarName } from '../Avatar';
import { LineIcon, type LineIconName } from '../LineIcons';
import { Morph } from '../Morph';
import { QrCard } from './QrCard';
import { LinkPill } from './Overlays';
import { SeatStanding } from './ratings/TierBadge';
import '../../styles/online.css';

// (A seat's profile, block and report, and inviting a friend: loaded once the harbour shows.)
const SeatMenu = lazy(() => import('./safety/SeatMenu'));
const InviteFriend = lazy(() => import('./friends/InviteFriend'));

const press = () => (sfx.unlock(), sfx.play('click'));

const DIFFICULTIES: [BotDifficulty, string][] = [
  ['easy', 'Easy'],
  ['normal', 'Normal'],
  ['hard', 'Hard'],
];

const TIMER_NAMES: Record<TimerPreset, string> = { relaxed: 'Relaxed clock', standard: 'Standard clock', brisk: 'Brisk clock', off: 'No clock' };

/** A colour the room will show: a preset's id, or #rrggbb (else the seat's colour as given). */
const paint = (c: string) => (PLAYER_PALETTE[c as PlayerColor]?.ui ?? (/^#[0-9a-f]{6}$/i.test(c) ? c : '#8a7a62'));

function Seg<T extends string | number | boolean>({ opts, value, on, label, disabled, disabledOf }: { opts: [T, string][]; value: T; on: (v: T) => void; label: string; disabled?: boolean; disabledOf?: (v: T) => boolean }) {
  return (
    <div className={`seg${disabled ? ' disabled' : ''}`} role="group" aria-label={label}>
      {opts.map(([k, text]) => (
        <button key={String(k)} type="button" disabled={disabled || disabledOf?.(k)} className={value === k ? 'on' : ''} aria-pressed={value === k} onClick={() => (press(), on(k))}>
          {text}
        </button>
      ))}
    </div>
  );
}

export default function Harbour() {
  const code = useOnline((s) => s.code);
  const room = useOnline((s) => s.room);
  const you = useOnline((s) => s.you);
  const link = useOnline((s) => s.link);
  const closedWhy = useOnline((s) => s.closedWhy);
  const rejoin = useOnline((s) => s.rejoin);
  const upgrade = useOnline((s) => s.upgrade);
  const playing = useOnline((s) => s.playing);
  const watch = useOnline((s) => s.watch);
  const twin = useOnline((s) => s.twin);
  const me = useOnline(mySeat);
  const host = useOnline(amHost);
  const [qr, setQr] = useState<null | { url: string; title: string }>(null);
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  // (Come aboard as another sailor, this tab's own: its face is its own too.)
  useEffect(() => {
    if (!twin) setProfile(loadProfile());
  }, [twin]);
  const keep = (p: Profile) => {
    setProfile(p);
    saveProfile(p);
  };
  // Leaving a seat others can see asks once: the button says so, and a second press leaves.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(false), 3500);
    return () => clearTimeout(t);
  }, [leaving]);
  const leave = () => {
    press();
    if (me && !leaving && !closedWhy) return setLeaving(true);
    session.leaveRoom();
  };
  const pc = paint(me?.color ?? profile.color);
  const card = (body: React.ReactNode, wide = false) => (
    <motion.section
      className={`harbour title-card parchment menu-page${wide ? ' wide' : ''}`}
      aria-label="Harbour"
      style={{ ['--pc' as string]: pc }}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, transition: { duration: 0.2 } }}
    >
      {/* (The way out leads the head, at its top left, as on every page.) */}
      <div className="page-head">
        <button className={`back-btn${leaving ? ' armed' : ''}`} onClick={leave} aria-live="polite">
          <LineIcon name="back" size={18} />
          <Morph>{leaving ? 'Leave? Your seat opens' : 'Leave'}</Morph>
        </button>
        <span className="menu-seal">
          <LineIcon name="crew" size={22} />
        </span>
        <h2>
          Harbour
          {room && <small className="harbour-whose">{hostLine(room, host)}</small>}
        </h2>
        <LinkPill inline />
      </div>
      {body}
    </motion.section>
  );
  if (closedWhy || upgrade) {
    return (
      <div className="title-screen harbour-screen">
        {card(
          <div className="soon">
            <p className="soon-lead">{upgrade ? 'A new version is out' : 'Not this time'}</p>
            <p>{upgrade ? 'Reload the page to come aboard with the new version.' : closedWhy}</p>
            <div className="title-actions">
              {upgrade ? (
                <button className="btn gold large" onClick={() => location.reload()}>
                  <LineIcon name="refresh" size={20} />
                  Reload
                </button>
              ) : (
                <>
                  {rejoin && code && (
                    <button className="btn gold large" onClick={() => (press(), void session.join(code))}>
                      <LineIcon name="play" size={20} />
                      Play in this tab
                    </button>
                  )}
                  <button className={`btn ${rejoin ? 'ghost' : 'gold'} large`} onClick={() => (press(), session.leaveRoom())}>
                    <LineIcon name="home" size={20} />
                    Back to the menu
                  </button>
                </>
              )}
            </div>
          </div>,
        )}
      </div>
    );
  }
  if (twin) {
    return (
      <div className="title-screen harbour-screen">
        {card(
          <div className="soon twin-choice">
            <p className="soon-lead">You’re aboard in another tab</p>
            <p>This browser is already in this harbour, in another tab. Play here instead, or come aboard as another player (a guest of this tab’s own: handy for trying it out on one computer).</p>
            <div className="title-actions">
              <button className="btn gold large" onClick={() => (press(), void session.room?.choose('here'))}>
                <LineIcon name="play" size={20} />
                Play in this tab
              </button>
              <button className="btn ghost large" onClick={() => (press(), void session.room?.choose('another'))}>
                <LineIcon name="userPlus" size={20} />
                Join as another player
              </button>
            </div>
          </div>,
        )}
      </div>
    );
  }
  if (!room || !you || !code) {
    return (
      <div className="title-screen harbour-screen">
        {card(
          <p className="page-note harbour-wait" role="status">
            {link === 'offline' ? 'Waiting for the network…' : 'Rowing out to the harbour…'}
          </p>,
        )}
      </div>
    );
  }
  const seats = room.seats.slice(0, room.settings.seats);
  const hosting = host;
  const open = seats.find((s) => s.kind === 'open');
  const url = roomUrl(code);
  const claim = (seat: PlayerId) => {
    press();
    session.room?.claim(seat, profile);
  };
  const aboard = seats.filter((s) => s.kind === 'human').length;
  return (
    <div className="title-screen harbour-screen">
      {card(
        <>
          <Invite code={code} url={url} watchUrl={room.settings.spectators === 'link' ? roomUrl(code, true) : null} spectators={room.spectators} onQr={() => setQr({ url, title: 'Point a camera here to come aboard' })} />
          <div className="harbour-grid">
            <section className="harbour-col" aria-labelledby="harbour-crew">
              <h3 id="harbour-crew" className="harbour-h">
                Crew{' '}
                <small>
                  <Morph>{`${aboard === 1 ? '1 person' : `${aboard} people`} aboard · ${seats.length} seats`}</Morph>
                </small>
              </h3>
              {!me && !watch && open && <ComeAboard profile={profile} onProfile={keep} onClaim={() => claim(open.seat)} />}
              <ul className="seats" aria-label="Seats">
                {seats.map((s) => (
                  <SeatCard key={s.seat} seat={s} mine={me?.seat === s.seat} host={hosting} canClaim={!me && !watch} isHostSeat={room.host === String(s.seat) || (!!s.user && room.host === s.user)} onClaim={() => claim(s.seat)} difficulty={room.settings.botDifficulty} />
                ))}
              </ul>
              {!me && (watch || !open) && <p className="page-note">{watch ? 'You’re watching from the quay.' : 'Every seat is taken: you can watch from the quay.'}</p>}
              {me && (
                <MySeat
                  seat={me}
                  profile={profile}
                  onProfile={(p) => {
                    keep(p);
                    session.room?.claim(me.seat, p);
                  }}
                  onHandoff={(url) => setQr({ url, title: 'Point the other device’s camera here: your seat moves to it' })}
                />
              )}
            </section>
            <section className="harbour-col" aria-labelledby="harbour-voyage">
              <h3 id="harbour-voyage" className="harbour-h">
                Voyage{' '}
                <small>
                  <Morph>{hosting ? 'yours to set' : 'the host sets it'}</Morph>
                </small>
              </h3>
              {hosting ? <HostSettings settings={room.settings} people={aboard} /> : <VoyageSummary settings={room.settings} />}
              <HarbourChat seats={seats} freeChat={room.settings.freeChat} mine={me?.seat ?? null} />
            </section>
          </div>
          {/* (Just above Ready and Set sail, which stay in reach however long the card: a refusal is seen where it was asked.) */}
          <Notices />
          <HarbourBar seats={seats} settings={room.settings} hostName={seats.find((s) => s.kind === 'human' && (room.host === s.user || room.host === String(s.seat)))?.name ?? null} hosting={hosting} playing={playing} watch={watch} />
        </>,
        true,
      )}
      <AnimatePresence>{qr && <QrCard key="qr" url={qr.url} code={code} title={qr.title} onClose={() => setQr(null)} />}</AnimatePresence>
    </div>
  );
}

/** Whose harbour this is, under its name. */
function hostLine(room: RoomInfo, host: boolean): string {
  if (host) return 'You’re the host';
  const h = room.seats.find((s) => s.kind === 'human' && (room.host === s.user || room.host === String(s.seat)));
  return h ? `${h.name}’s voyage` : '';
}

/**
 * The card's foot, in reach however long the card: what the table is waiting for, in a line, and
 * the one thing for you to do about it (Set sail for the host, Ready for the others).
 */
function HarbourBar({ seats, settings, hostName, hosting, playing, watch }: { seats: SeatInfo[]; settings: RoomSettings; hostName: string | null; hosting: boolean; playing: boolean; watch: boolean }) {
  const me = useOnline(mySeat);
  const host = useOnline(amHost);
  const room = useOnline((s) => s.room);
  // Set sail with someone not ready yet asks once: the button names them.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const others = seats.filter((s) => s.kind === 'human' && !(room && (room.host === s.user || room.host === String(s.seat))));
  const waiting = others.filter((s) => !s.ready && s.online !== false);
  const open = seats.filter((s) => s.kind === 'open').length;
  const blocked = open > 0 && !settings.botsFill;
  const names = (xs: SeatInfo[]) => (xs.length === 1 ? xs[0].name : xs.length === 2 ? `${xs[0].name} and ${xs[1].name}` : `${xs.length} people`);
  let status: string;
  if (playing) status = 'Setting sail: the island is rising…';
  else if (watch) status = 'You’re watching from the quay. The voyage starts when the host sets sail.';
  else if (hosting) {
    status =
      blocked ? `${open === 1 ? 'A seat is' : `${open} seats are`} still empty, and you’ve set empty seats to stay empty.`
      : waiting.length ? `Waiting for ${names(waiting)} to be ready. You can set sail anyway.`
      : others.length ? 'Everyone’s ready. Set sail when you like.'
      : open ? `Invite people with the code, or set sail now: the crew sails ${open === 1 ? 'the empty seat' : 'the empty seats'}.`
      : 'Set sail when you like.';
  } else if (me) status = me.ready ? `You’re ready. Waiting for ${hostName ?? 'the host'} to set sail.` : 'Say you’re ready when you are.';
  else status = 'Take a seat to play.';
  const start = () => {
    press();
    if (waiting.length && !armed) return setArmed(true);
    setArmed(false);
    session.room?.start(waiting.length > 0);
  };
  return (
    <div className="title-actions harbour-actions harbour-bar">
      <p className="harbour-status" role="status" aria-live="polite">
        <Morph>{status}</Morph>
      </p>
      {/* (The host's Set sail is their word: only the others say they're ready.) */}
      {me && !playing && me.kind === 'human' && !host && (
        <button className={`btn ${me.ready ? 'ghost' : 'gold'} large harbour-go`} aria-pressed={!!me.ready} onClick={() => (press(), session.room?.ready(!me.ready))}>
          {/* (Ready, the button is the way back: no tick on it, so the tick stays the seat's word for ready.) */}
          {!me.ready && <LineIcon name="check" size={20} />}
          <Morph>{me.ready ? 'Not ready yet' : 'I’m ready'}</Morph>
        </button>
      )}
      {hosting && !playing && (
        <button className={`btn gold large harbour-go${armed ? ' armed' : ''}`} onClick={start} aria-disabled={blocked} disabled={blocked}>
          <LineIcon name="ship" size={20} />
          <Morph>{armed ? `Sail without ${names(waiting)} ready?` : 'Set sail'}</Morph>
        </button>
      )}
    </div>
  );
}

/** The voyage as the host set it, for everyone else: the same things the host's settings show, read-only. */
function VoyageSummary({ settings: s }: { settings: RoomSettings }) {
  const preset = PRESETS.find((p) => p.id === s.preset);
  const rows: [string, string][] = [
    ['Expansions', preset?.name ?? (s.modules.length ? `${s.modules.length} expansions` : 'Base game')],
    ['Players', String(s.seats)],
    ['Points to win', String(s.victoryPoints)],
    ['Clock', TIMER_NAMES[s.timer]],
    ['Crew', DIFFICULTIES.find(([d]) => d === s.botDifficulty)?.[1] ?? s.botDifficulty],
    ['Empty seats', s.botsFill ? 'Crew sails them' : 'Stay empty'],
    ['Take-backs', s.takeBacks === false ? 'None' : 'Allowed'],
    ['Table talk', s.freeChat ? 'Free chat' : 'Quick talk'],
  ];
  if (s.friendlyRobber) rows.push(['Robber', 'Friendly']);
  if (s.eventDeck) rows.push(['Dice', 'Event deck']);
  return (
    <dl className="voyage-summary">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          {/* (A value the host just changed morphs into the new one, so the change is seen without a flash.) */}
          <dd>
            <Morph>{v}</Morph>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The room's code and the ways to pass it on (and, where the room lets anyone watch, the link to watch). */
function Invite({ code, url, watchUrl, spectators, onQr }: { code: string; url: string; watchUrl: string | null; spectators: number; onQr: () => void }) {
  const [copied, setCopied] = useState<null | 'join' | 'watch'>(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const copy = async (which: 'join' | 'watch', link: string) => {
    press();
    try {
      await navigator.clipboard.writeText(link);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // (No clipboard here: the link is selected to copy by hand.)
      window.prompt('Copy this link', link);
    }
  };
  const share = async (link: string, text: string) => {
    press();
    try {
      // (A link and one short line, no title: iOS's targets join them, and a title comes out twice.)
      await navigator.share({ url: link, text });
    } catch {
      /* (cancelled) */
    }
  };
  return (
    <div className="invite">
      <div className="invite-code">
        <span className="invite-label">Room code</span>
        <b className="room-code" aria-label={`Room code ${code.split('').join(' ')}`}>
          {spacedCode(code)}
        </b>
      </div>
      {/* (One quiet group: Set sail or I'm ready is the harbour's one gold button. The familiar ways,
          the QR code and the watchers' link, are icons with their names in a tip.) */}
      <div className="invite-actions" role="group" aria-label="Pass the code on">
        {canShare && (
          <button className="btn ghost small" onClick={() => void share(url, `Come aboard my island in Hexplorers: ${spacedCode(code)}`)}>
            <LineIcon name="share" size={16} />
            Share invite
          </button>
        )}
        <button className="btn ghost small invite-copy" onClick={() => void copy('join', url)} aria-live="polite">
          <LineIcon name={copied === 'join' ? 'check' : 'copy'} size={16} />
          <Morph>{copied === 'join' ? 'Link copied' : canShare ? 'Copy link' : 'Copy invite link'}</Morph>
        </button>
        <button className="icon-btn tip" data-tip="QR code" aria-label="Show a QR code to scan" onClick={() => (press(), onQr())}>
          <LineIcon name="qr" size={18} />
        </button>
        {watchUrl && (
          <button
            className="icon-btn tip invite-watch"
            data-tip={copied === 'watch' ? 'Watch link copied' : spectators > 0 ? `Copy the link to watch · ${spectators} watching` : 'Copy the link to watch'}
            aria-label={copied === 'watch' ? 'Watch link copied' : `Copy the link to watch${spectators > 0 ? `: ${spectators} watching` : ''}`}
            onClick={() => void copy('watch', watchUrl)}
          >
            <LineIcon name={copied === 'watch' ? 'check' : 'eye'} size={18} />
            {spectators > 0 && (
              <span className="invite-badge" aria-hidden>
                {spectators}
              </span>
            )}
          </button>
        )}
        <Suspense fallback={null}>
          <InviteFriend code={code} />
        </Suspense>
        <span className="sr-only" role="status">
          {copied === 'watch' ? 'Watch link copied' : ''}
        </span>
      </div>
    </div>
  );
}

/** A seat: who's in it (or that it's open), whether they're ready and here, and what the host can do with it. */
function SeatCard({ seat: s, mine, host, canClaim, isHostSeat, onClaim, difficulty }: { seat: SeatInfo; mine: boolean; host: boolean; canClaim: boolean; isHostSeat: boolean; onClaim: () => void; difficulty: BotDifficulty }) {
  // Removing someone asks once, in the menu: the item says so, and a second press removes them.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const safety = useRef<HTMLSpanElement>(null);
  // (A seat opened or emptied loses its menu, and the focus with it: it waits on the seat instead.)
  const card = useRef<HTMLLIElement>(null);
  const keepFocus = () => card.current?.focus({ preventScroll: true });
  const room = () => session.room;
  const level = s.difficulty ?? difficulty;
  const status =
    s.kind === 'open' ? 'Open'
    : s.kind === 'bot' ? `Crew · ${DIFFICULTIES.find(([d]) => d === level)?.[1] ?? level}`
    : s.online === false ? 'Away from the harbour'
    : isHostSeat ? 'Hosting'
    : s.ready ? 'Ready'
    : 'Not ready yet';
  const ready = s.ready || (isHostSeat && s.kind === 'human');
  // (The host's ways with a seat, in one menu: a person's, and the profile, block and report
  // SeatMenu keeps, opened from here by its own button, which stays out of sight.)
  const items: MenuItem[] =
    !host || mine ? []
    : s.kind === 'bot' ?
      [
        ...DIFFICULTIES.map(([d, name]): MenuItem => ({ key: d, label: name, checked: level === d, on: () => room()?.seatBot(s.seat, d) })),
        { key: 'open', label: 'Open this seat', icon: 'minus', on: () => (room()?.seatBot(s.seat, null), keepFocus()), divide: true },
      ]
    : s.kind === 'human' ?
      [
        { key: 'host', label: 'Make host', icon: 'crown', on: () => room()?.transfer(s.seat) },
        { key: 'kick', label: armed ? `Remove ${s.name}? Press again` : 'Remove from the harbour', icon: 'exit', armed, keep: !armed, on: () => (armed ? (room()?.kick(s.seat), setArmed(false), keepFocus()) : setArmed(true)) },
        ...(s.user ? [{ key: 'safety', label: 'Profile, block or report', icon: 'user', divide: true, on: () => safety.current?.querySelector<HTMLButtonElement>('.seat-menu-btn')?.click() } satisfies MenuItem] : []),
      ]
    : [];
  return (
    <li ref={card} tabIndex={-1} className={`seat-card ${s.kind}${mine ? ' mine' : ''}${ready ? ' ready' : ''}`} style={{ ['--pc' as string]: s.kind === 'open' ? 'transparent' : paint(s.color) }}>
      <span className="seat-face">
        {s.kind === 'open' ? <span className="face open-face" aria-hidden /> : <AvatarFace code={s.avatar ?? -1} name={s.name} color={(PLAYER_PALETTE[s.color as PlayerColor] ? s.color : 'red') as PlayerColor} />}
        {s.kind === 'human' && <i className={`presence ${s.online === false ? 'off' : 'on'}`} aria-label={s.online === false ? 'Not connected' : 'Connected'} />}
      </span>
      <span className="seat-text">
        <b>
          <span className="seat-name">{s.kind === 'open' ? 'Open seat' : s.name}</span>
          {mine && <span className="you-tag">you</span>}
          {isHostSeat && <span className="host-tag">host</span>}
        </b>
        <small>
          {ready && s.kind === 'human' && s.online !== false && <LineIcon name="check" size={14} />}
          <Morph>{status}</Morph>
        </small>
        {s.kind === 'human' && <SeatStanding tier={s.tier} rating={s.rating} reliability={s.reliability} />}
      </span>
      <span className="seat-actions">
        {s.kind === 'open' && canClaim && (
          <button className="btn ghost small" onClick={onClaim}>
            Take seat
          </button>
        )}
        {s.kind === 'open' && host && (
          <button className="btn ghost small" onClick={() => (press(), room()?.seatBot(s.seat, difficulty))} aria-label="Add crew to this seat">
            <LineIcon name="bot" size={16} />
            Add crew
          </button>
        )}
        {items.length > 0 && <MoreMenu label={s.kind === 'bot' ? `${s.name}: crew difficulty, or open the seat` : `${s.name}: make host, remove, profile`} items={items} onClose={() => setArmed(false)} />}
        {s.kind === 'human' && !mine && (
          <span ref={safety} className={items.length > 0 ? 'seat-safety hidden' : 'seat-safety'}>
            <Suspense fallback={null}>
              <SeatMenu seat={s} />
            </Suspense>
          </span>
        )}
      </span>
    </li>
  );
}

type MenuItem = { key: string; label: string; icon?: LineIconName; on: () => void; checked?: boolean; keep?: boolean; armed?: boolean; divide?: boolean };

/**
 * A small menu behind a "⋯" button: the seat's rarer ways, out of the row until asked for. A menu
 * by the book: arrows move along it, Escape or a press outside closes it, and the focus goes
 * back to its button.
 */
function MoreMenu({ label, items, onClose }: { label: string; items: MenuItem[]; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (focus = true) => {
    setOpen(false);
    onClose?.();
    if (focus) btn.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // (Only the menu: not the harbour behind it too.)
      e.stopImmediatePropagation();
      close();
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const move = (e: React.KeyboardEvent) => {
    const all = [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % all.length : e.key === 'ArrowUp' ? (at - 1 + all.length) % all.length : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
    if (e.key === 'Tab') return close(false);
    if (to === null) return;
    e.preventDefault();
    all[to]?.focus();
  };
  return (
    <span className="more-menu">
      <button ref={btn} type="button" className="icon-btn seat-more tip" data-tip={open ? undefined : 'More'} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => (press(), open ? close() : setOpen(true))}>
        <LineIcon name="more" size={18} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div key="menu" id={id} ref={list} role="menu" aria-label={label} className="more-pop parchment" onKeyDown={move} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                tabIndex={-1}
                role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={it.checked}
                className={`more-item${it.armed ? ' armed' : ''}${it.divide ? ' divide' : ''}`}
                onClick={() => {
                  press();
                  if (it.keep) return it.on();
                  // (The focus back on the menu's button first: a sheet opened from here gives it back there.)
                  close();
                  it.on();
                }}
              >
                {it.checked !== undefined ? <span className="more-tick">{it.checked && <LineIcon name="check" size={16} />}</span> : it.icon ? <LineIcon name={it.icon} size={16} /> : null}
                <Morph>{it.label}</Morph>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

/** Taking a seat: the name and face you'll have at the table, chosen right here. */
function ComeAboard({ profile, onProfile, onClaim }: { profile: Profile; onProfile: (p: Profile) => void; onClaim: () => void }) {
  return (
    <div className="come-aboard" style={{ ['--pc' as string]: paint(profile.color) }}>
      <div className="come-aboard-row">
        <span className="come-aboard-face">
          <AvatarFace code={profile.avatar} name={profile.name.trim() || '?'} color={faceColor(profile.color)} />
        </span>
        <label>
          Your name
          <input type="text" value={profile.name} maxLength={18} autoComplete="nickname" onChange={(e) => onProfile({ ...profile, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && profile.name.trim() && onClaim()} />
        </label>
        <button className="btn gold" onClick={onClaim} disabled={!profile.name.trim()}>
          Take a seat
        </button>
      </div>
      <FacePicker profile={profile} onPick={(avatar) => onProfile({ ...profile, avatar })} />
    </div>
  );
}

/** A colour as a face can be drawn in (a preset's id; your own colour draws as red's). */
const faceColor = (c: string) => (PLAYER_PALETTE[c as PlayerColor] ? c : 'red') as PlayerColor;

/** The faces to choose from: your initial, the crew's portraits and the crests. */
function FacePicker({ profile, onPick }: { profile: Profile; onPick: (a: number) => void }) {
  return (
    <div className="field" role="group" aria-label="Your picture">
      <span className="field-label">Your picture</span>
      <div className="avatar-choices compact">
        {AVATAR_CHOICES.map((a) => (
          <button key={a} className={`avatar-choice tip ${profile.avatar === a ? 'on' : ''}`} data-tip={avatarName(a)} aria-label={avatarName(a)} aria-pressed={profile.avatar === a} onClick={() => (press(), onPick(a))}>
            <AvatarFace code={a} name={profile.name.trim() || '?'} color={faceColor(profile.color)} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Your own seat: your name, picture and colour (changed at once, for everyone), leaving it, and moving it to another device. */
function MySeat({ seat, profile, onProfile, onHandoff }: { seat: SeatInfo; profile: Profile; onProfile: (p: Profile) => void; onHandoff: (url: string) => void }) {
  const handoff = useOnline((s) => s.handoff);
  const code = useOnline((s) => s.code);
  const asked = useRef(false);
  const [name, setName] = useState(seat.name);
  useEffect(() => setName(seat.name), [seat.name]);
  // The room's transfer link, once asked for: the token rides in the fragment, never a query.
  useEffect(() => {
    if (handoff && asked.current && code) {
      asked.current = false;
      onHandoff(`${roomUrl(code)}#seat=${handoff}`);
    }
  }, [handoff]);
  // (Colours other people have: picked out of the room's seats, which change rarely.)
  const seats = useOnline((s) => s.room?.seats);
  const taken = useMemo(() => new Set(seats?.filter((x) => x.seat !== seat.seat && x.kind !== 'open').map((x) => x.color)), [seats, seat.seat]);
  // (What the table shows is the seat's: the face as the room has it, with the name being typed.)
  const face: Profile = { name, color: seat.color, avatar: seat.avatar ?? profile.avatar };
  const rename = () => {
    const n = name.trim();
    if (n && n !== seat.name) onProfile({ ...face, name: n });
    else setName(seat.name);
  };
  return (
    <div className="my-seat">
      <label className="my-name">
        Your name
        <input type="text" value={name} maxLength={18} autoComplete="nickname" onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </label>
      <FacePicker profile={face} onPick={(avatar) => onProfile({ ...face, avatar })} />
      <div className="field" role="group" aria-label="Your colour">
        <span className="field-label">Your colour</span>
        <div className="swatches">
          {PRESET_COLORS.map((c) => (
            <button key={c.id} className={`swatch tip ${seat.color === c.id ? 'on' : ''}`} data-tip={taken.has(c.id) ? `${c.name} (taken)` : c.name} disabled={taken.has(c.id)} style={{ background: PLAYER_PALETTE[c.id].ui }} aria-label={c.name} aria-pressed={seat.color === c.id} onClick={() => (press(), onProfile({ ...face, color: c.id }))} />
          ))}
        </div>
      </div>
      <div className="my-seat-links">
        <button className="link-btn" onClick={() => (press(), session.room?.unclaim())}>
          <LineIcon name="exit" size={16} />
          Leave this seat
        </button>
        <button
          className="link-btn"
          onClick={() => {
            press();
            asked.current = true;
            if (handoff && code) {
              asked.current = false;
              onHandoff(`${roomUrl(code)}#seat=${handoff}`);
            } else session.room?.handoff();
          }}
        >
          <LineIcon name="device" size={16} />
          Continue on another device
        </button>
      </div>
    </div>
  );
}

/** What the host sets: the table, the mix, the clock, the crew and the house rules. */
function HostSettings({ settings: s, people }: { settings: RoomSettings; people: number }) {
  const uid = useId();
  const set = (p: Partial<RoomSettings>) => session.room?.settings(p);
  const preset = PRESETS.find((p) => p.id === s.preset);
  const choosePreset = (id: string | null) => {
    const p = PRESETS.find((x) => x.id === id);
    const mix = mixOf(p ? [...p.expansions] : []);
    set({ preset: p?.id ?? 'custom', modules: mix.modules, map: mix.map, knobs: mix.knobs, victoryPoints: mix.target });
  };
  return (
    <div className="options host-settings">
      <div className="options-body">
        <div className="field" role="group" aria-label="Players">
          <span className="field-label">Players</span>
          <Seg<3 | 4> label="Players" opts={[[3, '3'], [4, '4']]} value={s.seats} on={(seats) => set({ seats })} disabledOf={(n) => n < people} />
        </div>
        <div className="field" role="group" aria-label="Turn clock">
          <span className="field-label">Turn clock</span>
          <Seg<TimerPreset> label="Turn clock" opts={[['relaxed', 'Relaxed'], ['standard', 'Standard'], ['brisk', 'Brisk'], ['off', 'Off']]} value={s.timer} on={(timer) => set({ timer })} />
        </div>
        <div className="field wide" role="group" aria-label="Expansions">
          <span className="field-label">Expansions</span>
          <div className="chips">
            <button className={!s.modules.length ? 'on' : ''} aria-pressed={!s.modules.length} onClick={() => (press(), choosePreset(null))}>
              Base game
            </button>
            {PRESETS.map((p) => (
              <button key={p.id} className={`tip ${preset === p ? 'on' : ''}`} data-tip={p.blurb} aria-pressed={preset === p} onClick={() => (press(), choosePreset(p.id))}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div className="field" role="group" aria-label="Crew" aria-describedby={`${uid}-crew-note`}>
          <span className="field-label">Crew</span>
          <Seg<BotDifficulty> label="Crew" opts={DIFFICULTIES} value={s.botDifficulty} on={(botDifficulty) => set({ botDifficulty })} />
          <span className="field-hint" id={`${uid}-crew-note`}>
            {DIFFICULTY_BLURBS[s.botDifficulty]}
          </span>
        </div>
        <div className="field wide" role="group" aria-label="Empty seats">
          <span className="field-label">Empty seats</span>
          <Seg<boolean> label="Empty seats" opts={[[true, 'Crew sails them'], [false, 'Stay empty']]} value={s.botsFill} on={(botsFill) => set({ botsFill })} />
        </div>
        <div className="field" role="group" aria-label="Take-backs">
          <span className="field-label">Take-backs</span>
          <Seg<boolean> label="Take-backs" opts={[[true, 'Allowed'], [false, 'None']]} value={s.takeBacks} on={(takeBacks) => set({ takeBacks })} />
        </div>
        <div className="field wide" role="group" aria-label="Watchers">
          <span className="field-label">Watchers</span>
          <Seg<RoomSettings['spectators']> label="Watchers" opts={[['link', 'Anyone with the link'], ['none', 'Nobody']]} value={s.spectators} on={(spectators) => set({ spectators })} />
        </div>
        <div className="field" role="group" aria-label="Table talk">
          <span className="field-label">Table talk</span>
          <Seg<boolean> label="Table talk" opts={[[false, 'Quick talk'], [true, 'Free chat']]} value={s.freeChat} on={(freeChat) => set({ freeChat })} />
        </div>
      </div>
    </div>
  );
}

/** The harbour's chat: a few lines, the quick words, and a line to type where the room allows it. */
function HarbourChat({ seats, freeChat, mine }: { seats: SeatInfo[]; freeChat: boolean; mine: PlayerId | null }) {
  const chat = useOnline((s) => s.chat);
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const shown = chat.slice(-30);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.length]);
  const by = useMemo(() => new Map(seats.map((s) => [s.seat, s])), [seats]);
  const quick = ['hello', 'goodLuck', 'oneMoment', 'thanks'] as const satisfies readonly (typeof QUICK_TALK)[number][];
  return (
    <section className="harbour-chat" aria-label="Harbour talk">
      <div className="chat-lines" ref={list} role="log" aria-live="polite">
        {shown.length === 0 && <p className="chat-empty">Nobody has said anything yet.</p>}
        {shown.map((l: ChatLine) => {
          const s = l.from === null ? undefined : by.get(l.from);
          return (
            <div key={l.id} className={`chat-line${l.from !== null && l.from === mine ? ' mine' : ''}`}>
              <span className="chat-who" style={{ ['--pc' as string]: s ? paint(s.color) : undefined }}>
                {s ? s.name : 'The table'}
              </span>
              <span>{lineText(l)}</span>
            </div>
          );
        })}
      </div>
      <div className="chat-quick">
        {quick.map((q) => (
          <button key={q} className="chip-btn" onClick={() => (press(), session.room?.chat('', q))}>
            {QUICK_WORDS[q]}
          </button>
        ))}
      </div>
      {freeChat && (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            press();
            session.room?.chat(draft);
            setDraft('');
          }}
        >
          <input type="text" value={draft} maxLength={240} placeholder="Say something…" aria-label="Message" onChange={(e) => setDraft(e.target.value)} />
          <button className="btn gold small" type="submit" disabled={!draft.trim()}>
            <LineIcon name="send" size={16} />
            Send
          </button>
        </form>
      )}
    </section>
  );
}

/** The room's notices, a moment each. */
function Notices() {
  const notices = useOnline((s) => s.notices);
  return (
    <div className="harbour-notices" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {notices.map((n) => (
          <motion.p key={n.id} className={`harbour-notice${n.kind === 'error' ? ' bad' : ''}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
            {n.text}
          </motion.p>
        ))}
      </AnimatePresence>
    </div>
  );
}
