// What an online table adds over the game's own HUD: whether the link to the room is up (a pill
// only when it isn't), a word when the crew is sailing your seat while you were away (and the way
// to take the helm back), "While you were away" after a reconnect, someone asking to drop anchor
// (and the way to agree), the offer you made to make again, how many watch from the quay, the
// room's notices, the reactions floating up from their senders' panels, and a dot on each
// player's panel for whether they're here. (Each seat's clock, Looking for / Spare and the hail are
// on its panel: see Seat.tsx.) It keeps the screen awake on a phone while it's your move, and tells
// a screen reader the table's news. Loaded only for online play (see App.tsx).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react';
import { session } from '../../app/session';
import { sfx } from '../../audio/sfx';
import type { GameEvent, PlayerColor, PlayerId } from '../../engine';
import { useUI } from '../../game/store';
import { PausedPill } from '../Hud';
import { keepOffer, keptOffer } from '../Modals';
import { isTouch } from '../useCompact';
import { mySeat, useOnline, type FloatingReaction } from '../../online/store';
import { offerAgain, offerWords, owedKey } from '../../online/table';
import { REACTION_WORDS } from '../../online/words';
import { fromEvents, markOf, sinceMark, type Mark } from '../../online/away';
import { turnTone } from '../../app/chromeTint';
import { CloseIcon, LineIcon } from '../LineIcons';
import { Morph } from '../Morph';
import { ReactionIcon } from './ReactionIcon';
import { HailButton } from './Seat';
import { AwaySummary } from './AwaySummary';
import '../../styles/online.css';

/** The link to the room, in a word, while it's down (nothing while it's up). `inline`: in the harbour's card rather than over the table. */
export function LinkPill({ inline = false }: { inline?: boolean }) {
  const link = useOnline((s) => s.link);
  const text = link === 'reconnecting' ? 'Reconnecting…' : link === 'offline' ? 'Offline: waiting for the network' : link === 'connecting' && !inline ? 'Connecting…' : null;
  return (
    <AnimatePresence>
      {text && (
        <motion.div key="link" className={`link-pill${inline ? ' inline' : ' parchment'}${link === 'offline' ? ' offline' : ''}`} role="status" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}>
          <span className="link-dot" aria-hidden />
          {text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Your seat went to the crew while you were away: say so, and offer it back (not once you've conceded it). */
function AwayCard() {
  const away = useOnline((s) => !!mySeat(s)?.away && !mySeat(s)?.conceded);
  return (
    <AnimatePresence>
      {away && (
        <motion.div key="away" className="away-card parchment" role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}>
          <span>The crew is sailing your seat</span>
          <button className="btn gold small" onClick={() => (sfx.play('click'), session.room?.back())}>
            <LineIcon name="ship" size={16} />
            Take the helm
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Someone at the table asked to drop anchor and not enough have agreed yet: the others are asked,
 * and the one who asked hears that the table is being asked. (Once it's on, the game's own paused
 * pill says so, and its Carry on lifts it.)
 */
function PauseAsk() {
  const pause = useOnline((s) => s.room?.pause ?? null);
  const seats = useOnline((s) => s.room?.seats);
  const me = useOnline((s) => mySeat(s));
  const show = !!pause && !pause.on && !!me && !me.away && !me.conceded;
  const asked = show && pause.votes.includes(me.seat);
  const by = seats?.find((x) => x.seat === pause?.by)?.name ?? 'Someone';
  return (
    <AnimatePresence>
      {show && (
        <motion.div key="pause" className="away-card parchment" role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8, transition: { duration: 0.15 } }}>
          <span>
            <Morph>{asked ? 'Asking the table to drop anchor…' : `${by} asks to drop anchor`}</Morph>
          </span>
          {asked ? (
            <button className="btn ghost small" onClick={() => (sfx.play('click'), session.room?.pause(false))}>
              Never mind
            </button>
          ) : (
            <>
              <button className="btn gold small" onClick={() => (sfx.play('click'), session.room?.pause(true))}>
                <LineIcon name="anchor" size={16} />
                Agree
              </button>
              <button className="btn ghost small" onClick={() => (sfx.play('click'), session.room?.pause(false))}>
                Play on
              </button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A new version is out: this page can't follow the room any more until it reloads. */
function UpgradeCard() {
  const upgrade = useOnline((s) => s.upgrade);
  if (!upgrade) return null;
  return (
    <div className="away-card parchment" role="alert">
      <span>A new version is out</span>
      <button className="btn gold small" onClick={() => location.reload()}>
        <LineIcon name="refresh" size={16} />
        Reload
      </button>
    </div>
  );
}

/** The room's notices over the table, a moment each. (A screen reader hears them from Live.tsx, outside the HUD.) */
function TableNotices() {
  const notices = useOnline((s) => s.notices);
  return (
    <div className="table-notices" aria-hidden>
      <AnimatePresence initial={false}>
        {/* (That the game is paused, the paused pill above says.) */}
        {notices.filter((n) => n.kind !== 'paused').slice(-2).map((n) => (
          <motion.p key={n.id} className={`table-notice parchment${n.kind === 'error' ? ' bad' : ''}`} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
            {n.text}
          </motion.p>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** How many watch from the quay: a small count while anyone does (their reactions float from it). */
function WatchCount() {
  const n = useOnline((s) => s.room?.spectators ?? 0);
  if (n <= 0) return null;
  return (
    <p className="watch-count parchment" role="status" aria-label={`${n} watching from the quay`}>
      <LineIcon name="eye" size={16} />
      <span aria-hidden>
        <Morph>{n}</Morph> watching
      </span>
    </p>
  );
}

/**
 * The offer you made on an earlier turn, to make again in one tap now it's your turn (to the
 * same players, while you still hold what it gives). It stands in for a standing offer: you make
 * it, the room never trades for you while you're away.
 */
function OfferAgain() {
  const view = useUI((s) => s.view);
  const me = useOnline((s) => (s.watch ? null : (s.you?.seat ?? null)));
  const busy = useUI((s) => s.busy);
  const [dropped, setDropped] = useState<number | null>(null);
  const kept = view && !busy && !session.presenter?.spectating ? offerAgain(keptOffer(), view, me) : null;
  if (!kept || !view || dropped === view.turn) return null;
  const names = kept.to.map((p) => view.players[p]?.name).filter(Boolean);
  const make = () => {
    sfx.play('click');
    if (session.act({ type: 'offerTrade', give: kept.give, get: kept.get, ...(kept.to.length > 0 && { to: kept.to }) })) return;
    // (Made again: it's this turn's offer now, to make again at the next.)
    keepOffer({ ...kept, turn: view.turn });
    setDropped(view.turn);
  };
  return (
    <div className="offer-again parchment" role="group" aria-label="Your last offer">
      <button type="button" className="btn ghost small" onClick={make} title={`Offer again: ${offerWords(kept)}${names.length > 0 ? ` to ${names.join(', ')}` : ''}`}>
        <LineIcon name="refresh" size={16} />
        Offer again: {offerWords(kept)}
        {names.length > 0 && <span className="offer-again-to"> to {names.join(', ')}</span>}
      </button>
      <button type="button" className="icon-btn small tip" data-tip="Not this turn" aria-label="Not this turn" onClick={() => (sfx.play('click'), setDropped(view.turn))}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

/** On a phone, the hail stands in the status column (the chips are too small for it): one for each person kept waiting. */
function HailRow() {
  const players = useUI((s) => s.view?.players);
  if (!players) return null;
  return (
    <div className="hail-row">
      {players.map((p) => (
        <HailButton key={p.id} player={p.id} named />
      ))}
    </div>
  );
}

/** Where a reaction rises from: its sender's panel or chip (the quay's count for a spectator), on this screen. */
function anchorOf(from: PlayerId | null): { x: number; y: number; below: boolean } {
  const el = document.querySelector<HTMLElement>(from === null ? '.watch-count' : `[data-anchor="player-${from}"]`);
  if (!el) return { x: innerWidth / 2, y: 90, below: true };
  const r = el.getBoundingClientRect();
  // (A phone's chip along the top: under it. A panel down the side: beside it.)
  const below = r.top < 140 && r.width < 160;
  return below ? { x: r.left + r.width / 2, y: r.bottom + 8, below } : { x: r.right + 10, y: r.top + r.height / 2, below };
}

/** One reaction floating up from its sender a moment: a drawn face on parchment, in their colour's dusk tone. */
function Floater({ f }: { f: FloatingReaction }) {
  const color = useUI((s) => (f.from === null ? null : s.view?.players[f.from]?.color));
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const reduce = useReducedMotionConfig();
  useLayoutEffect(() => setAt(anchorOf(f.from)), []);
  if (!at) return null;
  const tone = color ? `#${turnTone(color as PlayerColor).getHexString()}` : undefined;
  return (
    <motion.span
      className="floating-reaction parchment"
      style={{ left: at.x, top: at.y, ['--dusk' as string]: tone }}
      initial={{ opacity: 0, y: 0, scale: 0.9 }}
      animate={{ opacity: [0, 1, 1, 0], y: reduce ? 0 : at.below ? [0, 6, 14, 22] : [0, -8, -18, -28], scale: 1 }}
      transition={{ duration: 1.7, times: [0, 0.15, 0.7, 1], ease: 'easeOut' }}
      aria-hidden
    >
      <ReactionIcon r={f.r} size={22} />
    </motion.span>
  );
}

/** Everyone's reactions, over everything (not inside the HUD's column, which moves with the layout). */
function ReactionLayer() {
  const list = useOnline((s) => s.reactions);
  return createPortal(
    <div className="reaction-layer" aria-hidden>
      {list.map((f) => (
        <Floater key={f.id} f={f} />
      ))}
    </div>,
    document.body,
  );
}

/** Away this long (the link down, or the tab out of sight) is worth a word on coming back; a blink isn't. */
const AWAY_NEWS_MS = 10_000;

/**
 * "While you were away" in a live game: once you're back after the link dropped or the phone
 * slept, what the table did meanwhile, from the records that came in catch-up (or, after a jump
 * to the game whole, the game as you left it against the game now).
 */
function LiveAway() {
  const link = useOnline((s) => s.link);
  const me = useOnline((s) => (s.watch ? null : (s.you?.seat ?? null)));
  const yours = useUI((s) => !!s.view && me !== null && owedKey(s.view, me) !== null);
  const [lines, setLines] = useState<string[] | null>(null);
  const away = useRef<{ since: number; mark: Mark; events: GameEvent[]; jumped: GameEvent[] | null; back: boolean } | null>(null);
  const check = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = () => {
    check.current = null;
    const a = away.current;
    const host = session.room?.host;
    if (!a || !a.back || !host) return;
    if (host.catchUp || host.backlog > 0) return void (check.current = setTimeout(settle, 400));
    away.current = null;
    if (Date.now() - a.since < AWAY_NEWS_MS) return;
    const name = (p: PlayerId) => host.newest.players[p]?.name ?? 'Someone';
    const ls = a.jumped ? sinceMark(a.mark, host.newest, me ?? 0) : fromEvents(a.events, me, name);
    if (ls.length) setLines(ls);
  };
  const start = () => {
    const host = session.room?.host;
    if (!host || away.current) return;
    away.current = { since: Date.now(), mark: markOf(host.newest, me ?? 0), events: [], jumped: null, back: false };
  };
  const back = () => {
    if (!away.current) return;
    away.current.back = true;
    if (check.current === null) check.current = setTimeout(settle, 600);
  };
  // Away: the link down, or the page out of sight; back: the link up and the page in view.
  useEffect(() => {
    if (link === 'reconnecting' || link === 'offline') start();
    else if (link === 'open' && document.visibilityState === 'visible') back();
  }, [link]);
  useEffect(() => {
    const vis = () => (document.visibilityState === 'hidden' ? start() : useOnline.getState().link === 'open' && back());
    document.addEventListener('visibilitychange', vis);
    const host = session.room?.host;
    // What the table did meanwhile, as the records come (a jump to the game whole: compared with the mark instead).
    const stop = host?.subscribe((m) => {
      const a = away.current;
      if (!a) return;
      if (m.jump) a.jumped = [];
      else a.events.push(...m.events);
    });
    return () => {
      document.removeEventListener('visibilitychange', vis);
      stop?.();
      if (check.current !== null) clearTimeout(check.current);
    };
  }, [me]);
  return <AnimatePresence>{lines && <AwaySummary key="away" lines={lines} yours={yours} onClose={() => setLines(null)} />}</AnimatePresence>;
}

/** The screen kept awake on a phone while the table waits on you (released as soon as it doesn't, and taken again on coming back to the page). */
function useWakeLock() {
  const me = useOnline((s) => (s.watch ? null : (s.you?.seat ?? null)));
  const yours = useUI((s) => !!s.view && me !== null && !session.presenter?.spectating && owedKey(s.view, me) !== null);
  const on = yours && isTouch();
  useEffect(() => {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; addEventListener(t: 'release', f: () => void): void }> } }).wakeLock;
    if (!on || !wl) return;
    let lock: { release(): Promise<void> } | null = null;
    let done = false;
    const take = async () => {
      if (done || lock || document.visibilityState !== 'visible') return;
      try {
        const l = await wl.request('screen');
        if (done) return void l.release().catch(() => {});
        lock = l;
        l.addEventListener('release', () => {
          if (lock === l) lock = null;
        });
      } catch {
        // (Refused, by a battery saver or a frame without the permission: the screen may sleep.)
      }
    };
    const vis = () => void take();
    void take();
    document.addEventListener('visibilitychange', vis);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', vis);
      void lock?.release().catch(() => {});
      lock = null;
    };
  }, [on]);
}

/**
 * The table's news for a screen reader, politely and outside the HUD (Live.tsx reads it): the
 * room's notices and the reactions, in words. A hail for you is a soft bell too.
 */
function useTableNews() {
  useEffect(() => {
    let seenNotice = useOnline.getState().notices.at(-1)?.id ?? 0;
    let seenReact = useOnline.getState().reactions.at(-1)?.id ?? 0;
    return useOnline.subscribe((s) => {
      const fresh = s.notices.filter((n) => n.id > seenNotice);
      const reacts = s.reactions.filter((r) => r.id > seenReact);
      if (!fresh.length && !reacts.length) return;
      seenNotice = s.notices.at(-1)?.id ?? seenNotice;
      seenReact = s.reactions.at(-1)?.id ?? seenReact;
      if (fresh.some((n) => n.kind === 'nudged' && !n.local)) sfx.play('chime');
      const view = useUI.getState().view;
      const me = s.watch ? null : (s.you?.seat ?? null);
      const said = [
        ...fresh.map((n) => n.text),
        ...reacts.filter((r) => r.from !== me).map((r) => `${r.from === null ? 'Someone on the quay' : (view?.players[r.from]?.name ?? 'Someone')} ${REACTION_WORDS[r.r].did}`),
      ].filter(Boolean);
      if (!said.length) return;
      // (The same news twice running is still news: it's told apart so the region reads it again.)
      const text = said.join('. ');
      useUI.getState().set({ tableNews: useUI.getState().tableNews === text ? `${text}\u200b` : text });
    });
  }, []);
}

/** Everything an online table shows over the game's HUD (`inline`: in a phone's status column, under the hint). */
export default function OnlineHud({ inline = false }: { inline?: boolean }) {
  useWakeLock();
  useTableNews();
  return (
    <div className={`online-hud${inline ? ' inline' : ''}`} data-hud-obstacle="online">
      <PausedPill />
      <LinkPill />
      <AwayCard />
      <LiveAway />
      <PauseAsk />
      <UpgradeCard />
      {inline && <HailRow />}
      <OfferAgain />
      <WatchCount />
      <TableNotices />
      <ReactionLayer />
    </div>
  );
}

/** A dot on a player's panel: here, gone (the link dropped), or away (the crew sails their seat). */
export function SeatPresence({ player }: { player: PlayerId }) {
  const seat = useOnline((s) => s.room?.seats.find((x) => x.seat === player));
  if (!seat || seat.kind !== 'human') return null;
  const state = seat.away ? 'away' : seat.online === false ? 'off' : 'on';
  const label = seat.conceded ? 'Conceded: the crew sails for them' : state === 'away' ? 'Away: the crew sails for them' : state === 'off' ? 'Not connected' : 'Here';
  return (
    <i className={`presence ${state} tip`} data-tip={label} role="img" aria-label={label} />
  );
}
