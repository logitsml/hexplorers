// The Multiplayer page's body (the menu's card grows into it, as Singleplayer's does): two ways
// aboard, Host a room or Join with a code, each a step of its own, as the face you chose on the
// Profile page. It loads with the rest of online play, as you lean towards its card. On a build
// with no harbour server (the static site) it says so, and singleplayer is a tap away.

import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { session } from '../../app/session';
import { sfx } from '../../audio/sfx';
import { PRESETS } from '../../engine/presets';
import type { PlayerColor } from '../../engine';
import type { RoomSettings, ServerConfig, TimerPreset } from '../../net/protocol';
import { ApiError, fetchConfig, type Unavailable } from '../../online/api';
import { hostRoom, unavailableText } from '../../online/client';
import { sailorName } from '../../online/identity';
import { codeInput, isCode } from '../../online/links';
import { SailingAs } from '../Avatar';
import { LineIcon } from '../LineIcons';
import { Morph } from '../Morph';
import { SECTIONS } from './sections';
import '../../styles/online.css';

export interface MultiplayerProps {
  name: string;
  onName: (name: string) => void;
  color: PlayerColor;
  onColor: (c: PlayerColor) => void;
  avatar: number;
  onAvatar: (a: number) => void;
  /** Seats at the table, from the singleplayer page's choice of opponents. */
  players: 3 | 4;
  onPlayers: (n: 3 | 4) => void;
  /** The expansions' preset chosen there (null: the base game; 'custom': a mix of its own). */
  preset: string | null;
  onPreset: (id: string | null) => void;
  /** That mix in words ("The Long Voyage", "Base game"). */
  mixName: string;
  /** The singleplayer page's choices as a room's settings. */
  settings: Partial<RoomSettings>;
  /** Keep the name and the set-up (the identity reads them). */
  remember: () => void;
  onSolo: () => void;
  /** Open the Profile page (your picture, colour and account). */
  onProfile: () => void;
  /** The menu is left for a room or game a section opened. */
  onLeave: () => void;
  /** Which step: the two ways aboard, or one of them (the page's head, and its way back, follow it). */
  way: 'choose' | 'host' | 'join';
  onWay: (way: 'host' | 'join' | 'choose') => void;
}

/** Ask the harbour, and fetch the sections it has on, ahead of the page (see App's warmMulti). */
export function warm() {
  void fetchConfig().then((r) => {
    if (r.ok) for (const x of SECTIONS) if (x.id !== 'account' && (!x.when || x.when(r.config))) void x.load().catch(() => {});
  });
}

// A step in and out: a short fade and a nudge, no slide across the card. (The game's reduce-motion
// setting stills it: see MotionConfig in main.tsx.)
const STEP = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.2, 0, 0, 1] as const } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

const TIMERS: [TimerPreset, string][] = [
  ['relaxed', 'Relaxed'],
  ['standard', 'Standard'],
  ['brisk', 'Brisk'],
  ['off', 'Off'],
];

/** Focus there as a step comes in (after the last one has gone, so not in the page's own effect). */
function FocusOnMount({ to }: { to: () => HTMLElement | null }) {
  useEffect(() => to()?.focus({ preventScroll: true }), []);
  return null;
}

/** A row of choices, as the singleplayer page draws them. */
function Seg<T extends string | number>({ opts, value, on, label }: { opts: [T, string][]; value: T; on: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {opts.map(([k, text]) => (
        <button key={String(k)} type="button" className={value === k ? 'on' : ''} aria-pressed={value === k} onClick={() => (sfx.unlock(), sfx.play('click'), on(k))}>
          {text}
        </button>
      ))}
    </div>
  );
}

export default function MultiplayerPage(p: MultiplayerProps) {
  const [avail, setAvail] = useState<'checking' | true | Unavailable>('checking');
  const [config, setConfig] = useState<ServerConfig | null>(null);
  // (Each further section loads only once the page knows the server has it on.)
  const sections = useMemo(() => (config ? SECTIONS.filter((x) => x.id !== 'account' && (!x.when || x.when(config))).map((x) => ({ id: x.id, C: lazy(x.load) })) : []), [config]);
  const [code, setCode] = useState('');
  const [timer, setTimer] = useState<TimerPreset>('standard');
  const [busy, setBusy] = useState<null | 'host' | 'join'>(null);
  const [error, setError] = useState<string | null>(null);
  const codeBox = useRef<HTMLInputElement>(null);
  // "You" is no name to show other people: a first-timer's box is filled with a sailor's name to
  // keep or change.
  useEffect(() => {
    if (!p.name.trim() || p.name.trim().toLowerCase() === 'you') p.onName(sailorName());
  }, []);
  // (Asked again by Try again, when the server was there but didn't answer in time.)
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    void fetchConfig({ fresh: asked > 0 }).then((r) => {
      if (!live) return;
      setAvail(r.ok ? true : r.why);
      if (r.ok) setConfig(r.config);
    });
    return () => {
      live = false;
    };
  }, [asked]);
  // (Focus follows the step: into the code box to join, to the step to host, and back to the way
  // you came from when you return to the choice.)
  const came = useRef<'host' | 'join' | null>(null);
  const stepBox = useRef<HTMLDivElement>(null);
  const wayBtn = { host: useRef<HTMLButtonElement>(null), join: useRef<HTMLButtonElement>(null) };
  useEffect(() => {
    if (p.way !== 'choose') came.current = p.way;
    setError(null);
  }, [p.way]);
  const ready = avail === true;
  const press = () => (sfx.unlock(), sfx.play('click'));
  const host = async () => {
    if (busy || !ready) return;
    press();
    p.remember();
    setBusy('host');
    setError(null);
    try {
      const made = await hostRoom({ ...p.settings, seats: p.players, timer }, p.name);
      await session.join(made);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The harbour couldn’t be opened. Try again in a moment.');
      setBusy(null);
    }
  };
  const join = async (watch = false) => {
    if (busy || !ready || !isCode(code)) return;
    press();
    p.remember();
    setBusy('join');
    setError(null);
    try {
      await session.join(code, { watch });
    } catch (e) {
      console.error('could not join', e);
      setError('That harbour couldn’t be reached. Check the code and try again.');
      setBusy(null);
    }
  };
  // (After every hook: the page can turn unavailable on a later answer, and the hooks must not change.)
  if (avail !== true && avail !== 'checking') {
    return (
      <>
        <div className="soon">
          <svg className="soon-art" viewBox="0 0 120 64" aria-hidden>
            <path d="M6 50q12 -6 24 0t24 0t24 0t24 0t12 0" />
            <path d="M18 44l3 6h22l3 -6zM31 44V18M31 20l10 20H31M31 25l-8 15h8" />
            <path d="M74 44l3 6h22l3 -6zM87 44V16M87 18l11 22H87M87 23l-9 17h9" />
            <path d="M47 30q10 -8 20 0" className="dash" />
          </svg>
          <p className="soon-lead">{avail === 'upgrade' ? 'A new version is out' : avail === 'error' ? 'The harbour is quiet' : 'No harbour here'}</p>
          <p>{unavailableText(avail)}</p>
        </div>
        <div className="title-actions">
          {avail === 'upgrade' ? (
            <button className="btn gold large" onClick={() => location.reload()}>
              <LineIcon name="refresh" size={20} />
              Reload
            </button>
          ) : avail === 'error' ? (
            <>
              <button className="btn gold large" onClick={() => (press(), setAvail('checking'), setAsked((n) => n + 1))}>
                <LineIcon name="refresh" size={20} />
                Try again
              </button>
              <button className="btn ghost large" onClick={p.onSolo}>
                Play singleplayer
              </button>
            </>
          ) : (
            <button className="btn gold large" onClick={p.onSolo}>
              <LineIcon name="compass" size={20} />
              Play singleplayer
            </button>
          )}
        </div>
      </>
    );
  }
  const choose = (w: 'host' | 'join') => (press(), p.onWay(w));
  return (
    <div className="form online-form">
      <AnimatePresence mode="wait" initial={false}>
        {p.way === 'choose' && (
          <motion.div key="choose" className="online-step" {...STEP}>
            {/* (Your picture, colour and account are the Profile page's: here, who you'll be, and a way there.) */}
            <SailingAs name={p.name} color={p.color} avatar={p.avatar} onChange={() => p.onProfile()} />
            <FocusOnMount to={() => came.current && wayBtn[came.current].current} />
            <div className="online-ways" role="group" aria-label="Ways aboard">
              <button ref={wayBtn.host} type="button" className="online-way-card primary" onClick={() => choose('host')}>
                <span className="menu-seal">
                  <LineIcon name="ship" size={22} />
                </span>
                <span className="menu-text">
                  <span className="menu-label">Host a room</span>
                  <span className="menu-note">Set the table, then share its link</span>
                </span>
                <span className="menu-chevron" aria-hidden>
                  <LineIcon name="next" size={18} />
                </span>
              </button>
              <button ref={wayBtn.join} type="button" className="online-way-card" onClick={() => choose('join')}>
                <span className="menu-seal">
                  <LineIcon name="link" size={22} />
                </span>
                <span className="menu-text">
                  <span className="menu-label">Join with a code</span>
                  <span className="menu-note">The six letters and numbers a host shares</span>
                </span>
                <span className="menu-chevron" aria-hidden>
                  <LineIcon name="next" size={18} />
                </span>
              </button>
            </div>
            {config && (
              <Suspense fallback={null}>
                <motion.div className="online-sections" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.25 } }}>
                  {sections.map(({ id, C }) => (
                    <C key={id} config={config} name={p.name} color={p.color} avatar={p.avatar} leaveMenu={p.onLeave} />
                  ))}
                </motion.div>
              </Suspense>
            )}
          </motion.div>
        )}

        {p.way === 'join' && (
          <motion.div key="join" className="online-step" {...STEP}>
            <form
              className="online-join"
              aria-label="Join a room"
              onSubmit={(e) => {
                e.preventDefault();
                void join();
              }}
            >
              <label className="field-label" htmlFor="room-code">
                Room code
              </label>
              <div className="code-row">
                <input
                  id="room-code"
                  ref={codeBox}
                  className="code-input"
                  type="text"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="K7QW2B"
                  size={8}
                  aria-describedby="room-code-note"
                  value={code}
                  maxLength={8}
                  onChange={(e) => setCode(codeInput(e.target.value))}
                />
                <FocusOnMount to={() => codeBox.current} />
                <button className="btn gold" type="submit" aria-disabled={!ready || !isCode(code) || busy !== null}>
                  <Morph>{busy === 'join' ? 'Boarding…' : 'Join'}</Morph>
                  <LineIcon name="arrowRight" size={18} />
                </button>
              </div>
              <p id="room-code-note" className="page-note start">
                Six letters and numbers, from the host’s link or screen.
              </p>
              <button className="link-btn" type="button" disabled={!ready || !isCode(code) || busy !== null} onClick={() => void join(true)}>
                <LineIcon name="eye" size={16} />
                Watch from the quay instead
              </button>
            </form>
          </motion.div>
        )}

        {p.way === 'host' && (
          <motion.div key="host" ref={stepBox} tabIndex={-1} className="online-step" aria-label="Host a room" {...STEP}>
            <FocusOnMount to={() => stepBox.current} />
            <div className="field" role="group" aria-label="Players">
              <span className="field-label">Players</span>
              <Seg<3 | 4> label="Players" opts={[[3, '3 players'], [4, '4 players']]} value={p.players} on={p.onPlayers} />
            </div>
            <div className="field" role="group" aria-label="Expansions">
              <span className="field-label">Expansions</span>
              <div className="chips">
                <button className={p.preset === null ? 'on' : ''} aria-pressed={p.preset === null} onClick={() => (press(), p.onPreset(null))}>
                  Base game
                </button>
                {PRESETS.map((x) => (
                  <button key={x.id} className={`tip ${p.preset === x.id ? 'on' : ''}`} data-tip={x.blurb} aria-pressed={p.preset === x.id} onClick={() => (press(), p.onPreset(x.id))}>
                    {x.name}
                  </button>
                ))}
                {p.preset === 'custom' && (
                  <button className="on" aria-pressed>
                    {p.mixName}
                  </button>
                )}
              </div>
            </div>
            <div className="field" role="group" aria-label="Turn clock">
              <span className="field-label">Turn clock</span>
              <Seg<TimerPreset> label="Turn clock" opts={TIMERS} value={timer} on={setTimer} />
            </div>
            <p className="page-note">Seats nobody takes are sailed by the crew. Everything else can be changed in the harbour.</p>
            <div className="title-actions">
              <button className="btn gold large" onClick={() => void host()} aria-disabled={!ready || busy !== null}>
                <LineIcon name="ship" size={20} />
                <Morph>{busy === 'host' ? 'Opening the room…' : 'Open the room'}</Morph>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {avail === 'checking' && p.way !== 'choose' && (
        <p className="page-note" role="status">
          Looking for the harbour…
        </p>
      )}
      {error && (
        <p className="page-note bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
