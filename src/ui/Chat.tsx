import { Suspense, lazy, memo, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react';
import { useUI, type ChatLine } from '../game/store';
import { hasResources, mightHold } from '../engine';
import { session } from '../app/session';
import { PLAYER_PALETTE } from '../render/board/pieces';
import { sfx } from '../audio/sfx';
import { AvatarFace } from './Avatar';
import { useSeats } from './hooks';
import { isTouch } from './useCompact';
import { CloseIcon, Filled, LineIcon } from './LineIcons';

// Short enough to share a row (they wrap onto a second on a narrow phone).
const QUICK = ['Good luck!', 'Nice one!', 'Any trades?', 'Well played'];

// Online, the room's own talk (reactions, quick talk in its groups, who is typing, free text where
// the room allows it): with the rest of online play, loaded only then.
const OnlineTalk = lazy(() => import('./online/Talk'));

/** Opens the table talk; a badge counts what was said while it was closed. */
export function ChatButton() {
  const open = useUI((s) => s.chatOpen);
  const unread = useUI((s) => s.chatUnread);
  const set = useUI((s) => s.set);
  return (
    <button
      className={`icon-btn tip chat-btn${open ? ' on' : ''}`}
      data-tip="Table talk"
      aria-label={unread ? `Table talk, ${unread} new` : 'Table talk'}
      aria-expanded={open}
      onClick={() => set({ chatOpen: !open, chatUnread: 0 })}
    >
      <Filled name="chat">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />
        </svg>
      </Filled>
      <AnimatePresence initial={false}>
        {unread > 0 && !open && (
          <motion.span
            key="badge"
            className="chat-badge"
            initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          >
            {unread > 9 ? '9+' : unread}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/**
 * The table talk: what everyone has said, quick phrases and a line to type in. (What the others
 * say is read out from Live.tsx, outside the HUD, so the list itself stays quiet.)
 */
export function ChatPanel() {
  const open = useUI((s) => s.chatOpen);
  const chat = useUI((s) => s.chat);
  const has = useUI((s) => s.view !== null);
  const seats = useSeats();
  const me = useUI((s) => s.me);
  const set = useUI((s) => s.set);
  const muted = useUI((s) => s.settings.chatMuted);
  const mute = () => {
    sfx.play('click');
    const st = useUI.getState();
    st.set({ settings: { ...st.settings, chatMuted: !muted } });
  };
  // Online, the room's own talk takes the foot of the panel (see online/Talk.tsx).
  const online = useUI((s) => s.online);
  const reduce = useReducedMotionConfig();
  const [draft, setDraft] = useState('');
  const panel = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastId = chat.length ? chat[chat.length - 1].id : -1;
  useEffect(() => {
    list.current?.scrollTo({
      top: list.current.scrollHeight,
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, [lastId, open]);
  // With a keyboard, straight into the line to type in. On a touch screen that would raise the
  // keyboard over half the board every time: the panel takes the focus, the line waits for a tap.
  useEffect(() => {
    if (!open) return;
    // (Online at a table of quick talk, or watching, there's no line: the panel itself.)
    if (isTouch() || !input.current) panel.current?.focus({ preventScroll: true });
    else input.current.focus();
  }, [open]);
  const send = (text: string) => {
    if (!text.trim()) return;
    sfx.play('click');
    session.say(text);
    setDraft('');
  };
  const close = () => {
    set({ chatOpen: false, chatUnread: 0 });
    document.querySelector<HTMLButtonElement>('.chat-btn')?.focus();
  };
  return (
    <AnimatePresence>
      {open && has && (
        <motion.section
          key="chat"
          ref={panel}
          tabIndex={-1}
          className="chatpanel parchment"
          aria-label="Table talk"
          initial={{ opacity: 0, scale: 0.96, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          // Escape closes it from anywhere inside (a dialog over it takes the key first).
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || useUI.getState().modal) return;
            e.stopPropagation();
            close();
          }}
        >
          <header>
            <h2>Table talk</h2>
            {/* (Named by what pressing does, as the sound's mute is.) */}
            <button className={`icon-btn small tip${muted ? ' on' : ''}`} onClick={mute} aria-pressed={muted} aria-label="Mute the others’ table talk" data-tip={muted ? 'Muted: their lines stay here, without bubbles' : 'Mute the others’ table talk'}>
              <LineIcon name={muted ? 'muted' : 'sound'} size={18} />
            </button>
            <button className="icon-btn small" onClick={close} aria-label="Close table talk">
              <CloseIcon />
            </button>
          </header>
          <div className="chat-lines" ref={list} role="log" aria-label="What has been said" aria-live="off" tabIndex={0}>
            {chat.length === 0 && <p className="chat-empty">Nobody has said anything yet. Say hello?</p>}
            <AnimatePresence initial={false}>
              {chat.map((l) => {
                const seat = seats[l.player];
                return <ChatRow key={l.id} line={l} mine={l.player === me && !online?.watch} name={l.player === me && !online?.watch ? 'You' : (l.name ?? seat?.name ?? '')} seatName={seat?.name} color={seat?.color} />;
              })}
            </AnimatePresence>
          </div>
          {online ? (
            <Suspense fallback={null}>
              <OnlineTalk inputRef={input} />
            </Suspense>
          ) : (
            <>
              <div className="chat-quick">
                {QUICK.map((q) => (
                  <button key={q} className="chip-btn" onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
              <form
                className="chat-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  send(draft);
                }}
              >
                <input ref={input} type="text" value={draft} maxLength={160} placeholder="Say something…" aria-label="Message" onChange={(e) => setDraft(e.target.value)} />
                <button className="btn gold small" type="submit" disabled={!draft.trim()}>
                  <LineIcon name="send" size={16} />
                  Send
                </button>
              </form>
            </>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}

/** One line of table talk. (Memoised: a key typed in the line below, or a new line, mustn't redraw every line said.) */
const ChatRow = memo(function ChatRow({ line: l, mine, name, seatName, color }: { line: ChatLine; mine: boolean; name: string; seatName?: string; color: string | undefined }) {
  const face = session.avatars[l.player] ?? -1;
  return (
    <motion.div
      className={`chat-line${mine ? ' mine' : ''}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
    >
      {/* Who said it, as their portrait (the same as on their panel), so the line stays short. */}
      <span className="chat-face" title={name} style={{ ['--pc' as string]: color ? PLAYER_PALETTE[color].ui : undefined }}>
        {/* (Your own lines say "You", but your face's initial is your name's.) */}
        {color && <AvatarFace code={face} name={seatName ?? name} color={color} />}
      </span>
      <span>
        <span className="sr-only">{name}: </span>
        {l.text}
      </span>
      {l.offer && <OfferButton line={l} />}
    </motion.div>
  );
});

/**
 * A deal a bot named in reply to you: one click offers exactly that trade to it (it said it would
 * take it) and opens the trade dialog to settle it. Only while it can still be made: your side
 * from your hand, theirs from what the table can tell they might hold (their hand is hidden from
 * you, as it is in an online seat's view).
 */
function OfferButton({ line }: { line: ChatLine }) {
  const ok = useUI((s) => {
    const o = line.offer;
    const v = s.view;
    if (!o || !v || s.busy || v.currentPlayer !== s.me || v.phase !== 'main' || v.trade) return false;
    return hasResources(v.players[s.me].hand, o.give) && mightHold(v, s.me, o.to, o.get);
  });
  if (!ok) return null;
  const offer = () => {
    const o = line.offer!;
    if (session.act({ type: 'offerTrade', give: o.give, get: o.get, to: [o.to] })) return;
    const st = useUI.getState();
    st.set({ chat: st.chat.map((c) => (c.id === line.id ? { ...c, offer: undefined } : c)), modal: 'trade' });
  };
  return (
    <button className="chip-btn offer-btn" onClick={offer}>
      Offer it
    </button>
  );
}

/** What a player just said, for a few seconds beside their panel. */
export function SpeechBubble({ player }: { player: number }) {
  const line = useUI((s) => {
    // (Table talk muted: the others' lines stay in the panel.)
    if (s.settings.chatMuted && player !== s.me) return null;
    for (let i = s.chat.length - 1; i >= 0; i--) if (s.chat[i].player === player) return s.chat[i];
    return null;
  });
  const [shown, setShown] = useState<typeof line>(null);
  const seen = useRef(line?.id ?? -1);
  // Keyed on the line's id, not the line: "Offer it" replaces the line object (to drop its offer),
  // and re-running for that cleared the timer that hides the bubble, which then stayed up.
  const id = line?.id ?? -1;
  useEffect(() => {
    if (!line || id === seen.current) return;
    seen.current = id;
    setShown(line);
    const t = setTimeout(() => setShown(null), 3200 + line.text.length * 45);
    return () => clearTimeout(t);
  }, [id]);
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key={shown.id}
          className="speech"
          aria-hidden
          initial={{ opacity: 0, scale: 0.9, x: -6 }}
          animate={{ opacity: 1, scale: 1, x: 0 }}
          exit={{ opacity: 0, x: -4, transition: { duration: 0.2 } }}
          transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
        >
          {shown.text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
