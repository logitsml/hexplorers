import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react';
import { EXIT, SPRING_UI } from './motion';
import { useShallow } from 'zustand/react/shallow';
import {
  COSTS,
  RESOURCES,
  cardKinds,
  devCardsInGame,
  legalRoads,
  playableDevCards,
  expectedIncome,
  publicVictoryPoints,
  totalVictoryPoints,
  victoryBreakdown,
  type Card,
  type DevCardType,
  type GameState,
  type PlayerColor,
  type PlayerId,
  type Resource,
  CARDS,
  type CardCounts,
} from '../engine';
import { useUI } from '../game/store';
import { session } from '../app/session';
import { PLAYER_PALETTE } from '../render/board/pieces';
import { DEV_NAMES, DEV_TEXT, CARD_ICON, CARD_NAMES, CARD_TINT, asset } from '../game/names';
import { tokensOf, type TokenHolding } from '../game/holdings';
import { DevCard, Icon, ResourceCard } from './Cards';
import { Morph } from './Morph';
import { total, useBank, useChanged, useHand, useSeats } from './hooks';
import { sfx } from '../audio/sfx';
import { availability, buyDevCard, cancelPlacement, cardForSale, endTurn, openModal, rollDice, toggleBuild, toggleExtraBuild, undoLast } from '../game/commands';
import { EXTRA_HOTKEYS, extraBuilds, type ExtraBuild } from '../game/builds';
import { setMuted } from '../audio/mute';
import { ChatButton, SpeechBubble } from './Chat';
import { AvatarFace } from './Avatar';
import { SeatMark } from './SeatMark';
import { Presence, SeatMenu, SeatOnline } from './Presence';
import { ViewToggle } from './FlatBoard';
import { explain, extraBuildReason, placingText, whyNot, type ActionKey } from './why';
import { describeCards, incomeBeyond, perRoll } from './advice';
import { useCompact } from './useCompact';
import { ErrorBoundary } from './ErrorBoundary';
import { ModuleLedger } from './modules/Ledger';
import { Filled, LineIcon } from './LineIcons';
import { VentureGlyph, marksOf, standingsOf, venturesHeld } from './modules/standings';
import { pointParts, signed } from '../game/points';

// ------------------------------------------------------------------ players

export function PlayerPanels() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  // (Online the others are people too: their panels show them thinking as the crew's do.)
  const online = useUI((s) => s.online !== null);
  if (!view) return null;
  return (
    <div className="players" data-hud-obstacle="players">
      {view.players.map((p) => (
        <PlayerPanel key={p.id} state={view} id={p.id} me={me} thinking={!busy && (p.isBot || online) && p.id !== me && isWaitingOn(view, p.id) && !awaitsAnswerFrom(view, me)} />
      ))}
      {/* The expansions' standing information (the guild board, the ventures, the disaster track) under the players,
          one width with them; the view's switch at the column's foot. */}
      <ErrorBoundary name="ledger">
        <ModuleLedger />
      </ErrorBoundary>
      <ViewToggle />
    </div>
  );
}

/** An offer from another player is open and `me` hasn't answered it yet. */
export function awaitsAnswerFrom(s: GameState, me: PlayerId) {
  const t = s.trade;
  return !!t && t.proposer !== me && (t.to.length === 0 || t.to.includes(me)) && t.responses[me] === undefined && t.counters[me] === undefined;
}

/** Whose move the game waits on: the current player, or anyone still to discard. */
export function isWaitingOn(s: GameState, p: PlayerId) {
  if (s.phase === 'gameOver') return false;
  if (s.phase === 'discard') return s.pendingDiscards[p] !== undefined;
  return s.currentPlayer === p;
}

/** Three dots while a player decides (said in words to a screen reader). */
function Thinking() {
  return (
    <>
      <span className="thinking" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="sr-only">, thinking</span>
    </>
  );
}

/**
 * A player's panel. `anchor` false is the copy that opens from a phone's player chip: it carries
 * in words what the big HUD only says in tooltips (hidden points, the seat's mark).
 */
export function PlayerPanel({ state, id, me, thinking, anchor = true }: { state: GameState; id: PlayerId; me: PlayerId; thinking: boolean; anchor?: boolean }) {
  const p = state.players[id];
  const hand = useHand(id);
  const pal = PLAYER_PALETTE[p.color];
  const active = state.currentPlayer === id && state.phase !== 'gameOver';
  // Hidden Victory Point cards are revealed to everyone once the game is over.
  const vp = id === me || state.phase === 'gameOver' ? totalVictoryPoints(state, id) : publicVictoryPoints(state, id);
  const vpChanged = useChanged(vp);
  const hidden = id === me ? totalVictoryPoints(state, id) - publicVictoryPoints(state, id) : 0;
  const avatarIdx = session.avatars[id] ?? -1;
  const held = total(hand);
  // How many cards a player holds is public (which they are isn't); more than seven risk a discard.
  const many = held > 7 && id !== me;
  // What the expansions count, for every seat (it's all public): coins, fish, prisoners, defence,
  // and the tiles that move the winning line. With no development cards, their stat gives way to
  // the guilds' ventures held, or goes.
  const devs = devCardsInGame(state);
  const ventures = devs ? null : venturesHeld(state, id);
  const holds = standingsOf(state, id);
  const marks = marksOf(state, id);
  const awards = state.longestRoadHolder === id || state.largestArmyHolder === id || marks.length > 0;
  // Where the points come from, as the table can see it (the hidden cards only for your own).
  const vpParts = pointsInWords(state, id, id === me || state.phase === 'gameOver');
  const vpTip = `${id === me ? 'Your points' : 'Visible points'}: ${vpParts}`;
  return (
    <motion.div
      layout
      // Panels only change height when an award badge row appears or goes.
      layoutDependency={`${state.longestRoadHolder}|${state.largestArmyHolder}|${marks.map((m) => m.key).join()}`}
      className={`player-panel parchment${active ? ' active' : ''}${awards ? ' has-awards' : ''}`}
      style={{ ['--pc' as string]: pal.ui }}
      data-anchor={anchor ? `player-${id}` : undefined}
    >
      {anchor && id !== me && <SpeechBubble player={id} />}
      <div className="avatar">
        <AvatarFace code={avatarIdx} name={p.name} color={p.color} />
        <span className="avatar-mark" title="Their mark, also on their buildings">
          <SeatMark seat={id} color={pal.ui} size={11} />
        </span>
        <Presence player={id} />
        {id !== me && <SeatMenu player={id} />}
      </div>
      <div className="pname" title={p.name}>
        {p.name}
        {id === me && p.name.toLowerCase() !== 'you' && <span className="you-tag">you</span>}
        {thinking && <Thinking />}
      </div>
      <div className="vp tip" data-tip={vpTip} tabIndex={anchor ? 0 : undefined} role="img" aria-label={`${vp} victory points: ${vpParts}`}>
        <span className="vp-num">
          {vpChanged && <motion.span key={vp} className="vp-flash" initial={{ opacity: 0.9, scale: 0.6 }} animate={{ opacity: 0, scale: 1.6 }} transition={{ duration: 0.8 }} aria-hidden />}
          <Morph>{vp}</Morph>
        </span>
        <small>VP</small>
      </div>
      <div className="pstats">
        <span className={`stat tip${many ? ' many' : ''}`} data-tip={many ? 'Resource cards: more than 7, so a seven costs them half' : 'Resource cards'}>
          <Icon name="cards" size={18} label={many ? 'Resource cards, more than 7' : 'Resource cards'} /> <Morph>{held}</Morph>
        </span>
        {devs && (
          <span className="stat tip" data-tip="Development cards">
            <Icon name="devcard" size={18} label="Development cards" /> <Morph>{p.devCards.length}</Morph>
          </span>
        )}
        {ventures !== null && (
          <span className="stat tip" data-tip="Ventures held" role="img" aria-label={`${ventures} ventures held`}>
            <VentureGlyph /> <Morph>{ventures}</Morph>
          </span>
        )}
        {/* Knights and routes only once there is something to count. */}
        {p.playedKnights > 0 && (
          <span className="stat tip" data-tip="Knights played">
            <Icon name="knight" size={18} label="Knights played" /> <Morph>{p.playedKnights}</Morph>
          </span>
        )}
        {p.longestRoad > 1 && (
          <span className="stat tip" data-tip="Longest continuous route">
            <Icon name="route" size={18} label="Longest route" /> <Morph>{p.longestRoad}</Morph>
          </span>
        )}
        {holds.map((h) => (
          <span key={h.key} className={`stat hold tip hold-${h.key}`} data-tip={h.label} role="img" aria-label={h.label}>
            <img className="ui-icon" src={asset(h.icon)} alt="" width={18} height={18} draggable={false} /> <Morph>{h.n}</Morph>
          </span>
        ))}
      </div>
      {/* (Online: the seat's clock, what they'd trade, the hail.) */}
      <SeatOnline player={id} anchor={anchor} />
      {awards && (
        <div className="pawards">
          {state.longestRoadHolder === id && (
            <span className="badge-award tip" data-tip="Longest Route: +2 victory points">
              <Icon name="route" size={14} /> Route +2
            </span>
          )}
          {state.largestArmyHolder === id && (
            <span className="badge-award tip" data-tip="Biggest Army: +2 victory points">
              <Icon name="knight" size={14} /> Army +2
            </span>
          )}
          {marks.map((m) => (
            <span key={m.key} className={`badge-award mark ${m.tone} tip`} data-tip={m.label} role="img" aria-label={m.label}>
              <img src={asset(m.icon)} alt="" draggable={false} /> {m.text}
            </span>
          ))}
        </div>
      )}
      {!anchor && (
        <p className="pnote">
          <SeatMark seat={id} color={pal.ui} size={12} />
          <span>
            {id === me ? 'Your mark, on your buildings.' : 'Their mark, on their buildings.'}{' '}
            {id === me ? (hidden > 0 ? `Your points include ${hidden} hidden Victory Point card${hidden === 1 ? '' : 's'}.` : '') : state.phase === 'gameOver' ? '' : 'Hidden Victory Point cards aren’t counted until the end.'}
          </span>
        </p>
      )}
    </motion.div>
  );
}

/**
 * A seat's points by where they come from: "2 settlements, 1 city, Longest Route +2, 1 guild seat
 * +2, Port Captain +2" (each expansion's named: see game/points.ts).
 */
function pointsInWords(s: GameState, id: PlayerId, withHidden: boolean): string {
  const b = victoryBreakdown(s, id);
  const parts = [
    b.settlements > 0 && `${b.settlements} house${b.settlements === 1 ? '' : 's'}`,
    b.cities > 0 && `${b.cities} town${b.cities === 1 ? '' : 's'}`,
    b.longestRoad && 'Longest Route +2',
    b.largestArmy && 'Biggest Army +2',
    ...pointParts(s, id).map((x) => `${x.words} ${signed(x.n)}`),
    withHidden && b.victoryCards > 0 && `${b.victoryCards} hidden VP card${b.victoryCards === 1 ? '' : 's'}`,
  ].filter((x): x is string => !!x);
  return parts.length ? parts.join(', ') : 'none yet';
}

// --------------------------------------------------------------------- bank

/** Each presented state's estimate, worked out once (it walks every roll, and the store changes far more often than the state). */
const incomes = new WeakMap<GameState, Map<PlayerId, CardCounts & { picks: number }>>();

/** What your buildings bring in per roll, card by card, and the picks of your choice (flat, so the shallow compare holds). */
export function useIncome() {
  return useUI(
    useShallow((s) => {
      if (!s.view) return null;
      let mine = incomes.get(s.view);
      if (!mine) incomes.set(s.view, (mine = new Map()));
      let income = mine.get(s.me);
      if (!income) {
        const { per, picks } = expectedIncome(s.view, s.me);
        mine.set(s.me, (income = { ...per, picks }));
      }
      return income;
    }),
  );
}

/** "≈ 2.40 cards a roll (0.50 of them oil)": your buildings' yield in all, saying what the supply doesn't show. */
export function incomeLine(income: ReturnType<typeof useIncome>): { all: number; text: string } {
  if (!income) return { all: 0, text: '' };
  const beyond = incomeBeyond(income);
  const all = RESOURCES.reduce((t, r) => t + income[r], 0) + beyond.amount;
  return { all, text: `≈ ${perRoll(all)} cards a roll${beyond.amount > 0 ? ` (${perRoll(beyond.amount)} of them ${beyond.words})` : ''}` };
}

/** The kinds of card the supply holds beyond the resources, when the expansions bring them (commodities with the guilds, oil with Oil). */
export function useSupplyExtras(): Card[] {
  return useUI(useShallow((s) => (s.view ? cardKinds(s.view).filter((k) => !RESOURCES.includes(k as Resource)) : [])));
}

/** The most dots a stack shows before a plus. */
const YIELD_DOTS = 12;

/**
 * What your buildings draw from a stack, as the number discs count it: a dot for each way in 36
 * the dice can bring you one (a city's ways count twice), so a settlement on a 6 shows five dots
 * and a stack you draw nothing from shows none. Expected value is still the measure; the dots make
 * it comparable at a glance where two-decimal figures weren't.
 */
export function YieldPips({ per }: { per: number }) {
  const n = Math.round(per * 36);
  if (n <= 0) return null;
  return (
    <span className="yield" aria-hidden>
      {Array.from({ length: Math.min(n, YIELD_DOTS) }, (_, i) => (
        <i key={i} />
      ))}
      {n > YIELD_DOTS && <b>+</b>}
    </span>
  );
}

/** One of the supply's stacks: the card's icon, how many are left, and under it what your buildings draw on an average roll. */
const BankStack = memo(function BankStack({ kind, left, income, earning }: { kind: Card; left: number; income: (CardCounts & { picks: number }) | null; earning: number }) {
  const per = earning > 0 ? income![kind] : 0;
  const ways = Math.round(per * 36);
  const tip = `${CARD_NAMES[kind]}: ${left} in supply${ways > 0 ? `; your buildings draw it ${ways} ways in 36 (about ${perRoll(per)} a roll)` : ''}`;
  return (
    <div className="bank-stack tip" data-tip={tip} data-anchor={`bank-${kind}`} data-kind={kind}>
      <img src={asset(CARD_ICON[kind])} alt={tip} draggable={false} />
      <Morph>{left}</Morph>
      <YieldPips per={per} />
    </div>
  );
});

export function TopRight() {
  const has = useUI((s) => s.view !== null);
  const devLeft = useUI((s) => s.view?.devDeck.length ?? 0);
  const devs = useUI((s) => (s.view ? devCardsInGame(s.view) : false));
  const bank = useBank();
  const income = useIncome();
  const extras = useSupplyExtras();
  const set = useUI((s) => s.set);
  if (!has) return null;
  const { all: earning, text: earned } = incomeLine(income);
  return (
    <div className="topright" data-hud-obstacle="topright">
      <div className="toolbar parchment">
        <ResetViewButton />
        <ChatButton />
        <button className="icon-btn tip" data-tip="Rules" onClick={() => set({ modal: 'rules' })} aria-label="Rules">
          <Filled name="book">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
          </Filled>
        </button>
        <MuteButton />
        <button className="icon-btn tip" data-tip="Settings" onClick={() => set({ modal: 'settings' })} aria-label="Settings">
          <Filled name="gear">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </Filled>
        </button>
        <button className="icon-btn tip" data-tip="Leave game" onClick={() => set({ modal: 'menu' })} aria-label="Leave game">
          <ExitIcon />
        </button>
      </div>
      {/* The supply's stacks; under each, what your buildings draw from it on an average roll. The
          commodities and oil, when they're in play, stand in a row of their own under the resources. */}
      <div className={`bank parchment${earning > 0 ? ' with-income' : ''}${extras.length > 0 ? ' with-extras' : ''}`} data-anchor="bank" style={{ ['--cols' as string]: RESOURCES.length + (devs ? 1 : 0) }}>
        <div className="section-label">Supply</div>
        {RESOURCES.map((r) => (
          <BankStack key={r} kind={r} left={bank[r]} income={income} earning={earning} />
        ))}
        {devs && (
          <div className="bank-stack devdeck tip" data-tip="Development cards left" data-anchor="devdeck">
            <Icon name="devcard" size={28} label="Development cards left" />
            <Morph>{devLeft}</Morph>
          </div>
        )}
        {extras.length > 0 && (
          <div className="bank-extra" role="group" aria-label="Commodities and oil in the supply">
            {extras.map((k) => (
              <BankStack key={k} kind={k} left={bank[k]} income={income} earning={earning} />
            ))}
          </div>
        )}
        {earning > 0 && (
          <p className="income-note">
            <span className="yield legend" aria-hidden>
              <i />
            </span>{' '}
            one chance in 36 a roll · in all {earned}
          </p>
        )}
      </div>
      <LogPanel />
    </div>
  );
}

/** Flies the camera home; dim while the view is already there, lit once it has wandered. */
export function ResetViewButton() {
  const off = useUI((s) => s.cameraOffHome);
  return (
    <button className={`icon-btn tip reset-view${off ? ' away' : ''}`} data-tip="Reset view (H)" onClick={() => session.world?.rig.reset()} aria-label="Reset view">
      <Filled name="focus">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      </Filled>
    </button>
  );
}

function MuteButton() {
  const muted = useUI((s) => s.muted);
  return (
    <button className="icon-btn tip" data-tip={muted ? 'Sound off (M)' : 'Sound on (M)'} onClick={() => setMuted(!muted)} aria-label="Mute" aria-pressed={muted}>
      <Filled name={muted ? 'muted' : 'sound'}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 5 6 9H2v6h4l5 4z" />
          {muted ? <path d="m23 9-6 6M17 9l6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />}
        </svg>
      </Filled>
    </button>
  );
}

const LOG_OPEN = 'exploratory.logOpen';

/**
 * Memoised: it sits inside the supply column but only depends on the log. On short or narrow
 * windows it keeps to the newest line until opened, and then lies over what is below it.
 */
const LogPanel = memo(function LogPanel() {
  const empty = useUI((s) => s.log.length === 0);
  // A few lines by default; more on request (remembered).
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(LOG_OPEN) === '1';
    } catch {
      return false;
    }
  });
  // (Its height eases only when toggled: a window crossing the small-window size, as Firefox's
  // does coming back from a tab with the bookmarks bar, changes it at once rather than replaying it.)
  const [easing, setEasing] = useState(false);
  useEffect(() => {
    if (!easing) return;
    const t = setTimeout(() => setEasing(false), 400);
    return () => clearTimeout(t);
  }, [easing]);
  const toggle = () => {
    setEasing(true);
    setOpen(!open);
    try {
      localStorage.setItem(LOG_OPEN, open ? '0' : '1');
    } catch {
      /* storage unavailable */
    }
  };
  if (empty) return null;
  return (
    <div className={`logpanel parchment${open ? ' open' : ''}${easing ? ' easing' : ''}`}>
      <LogEntries />
      {/* (One chevron, turned as the log opens, rather than swapped for another.) */}
      <button className="log-toggle tip" data-tip={open ? 'Fewer lines' : 'More lines'} onClick={toggle} aria-expanded={open} aria-label={open ? 'Show fewer log lines' : 'Show more log lines'}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
  );
});

/**
 * The game's log lines, newest at the bottom (kept scrolled there). New lines are read out by
 * the live regions (see Live.tsx), which a dialog can't silence, so this list itself stays quiet.
 */
export function LogEntries({ limit = 60 }: { limit?: number }) {
  const log = useUI((s) => s.log);
  const seats = useSeats();
  const reduce = useReducedMotionConfig();
  const ref = useRef<HTMLDivElement>(null);
  // Keyed on the newest line, not the length (which stops changing at the 200-line cap).
  const lastId = log.length ? log[log.length - 1].id : -1;
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  }, [lastId]);
  // Its box resized (opened, closed, the window's height): still the newest lines in view.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => (el.scrollTop = el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="entries" ref={ref} role="log" aria-label="Game log" aria-live="off" tabIndex={0}>
      {log.slice(-limit).map((l) => {
        const seat = l.player !== null && seats[l.player] ? l.player : null;
        return <LogRow key={l.id} text={l.text} seat={seat} color={seat !== null ? PLAYER_PALETTE[seats[seat].color as PlayerColor].ui : '#b9a37c'} />;
      })}
    </div>
  );
}

/** One line of the log. (Memoised: a new line must not redraw the sixty before it.) */
const LogRow = memo(function LogRow({ text, seat, color }: { text: string; seat: number | null; color: string }) {
  return (
    <div className="logline">
      <SeatMark seat={seat} color={color} size={9} />
      {/* One line each; the whole line is in the tooltip if it runs out of room. */}
      <span className="log-text" title={plainLog(text)}>
        <LogText text={text} />
      </span>
    </div>
  );
});

const TOKEN = /\{(\d+):(\w+)\}/;

/** A log line's resource counts ("{2:wool}") in words, for its tooltip and for screen readers. */
export function plainLog(text: string) {
  return text.replace(new RegExp(TOKEN, 'g'), (_, n, r: Resource) => `${n} ${CARD_NAMES[r]}`);
}

/** A log line with its resource counts drawn as icons (the count shown only above one). */
export function LogText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\{\d+:\w+\})/).map((part, i) => {
        const m = TOKEN.exec(part);
        if (!m) return part;
        const n = Number(m[1]);
        const r = m[2] as Resource;
        return (
          <span key={i} className="log-res">
            {n > 1 && n}
            <img src={asset(CARD_ICON[r])} alt={`${n} ${CARD_NAMES[r]}`} draggable={false} />
          </span>
        );
      })}
    </>
  );
}

// --------------------------------------------------------------------- hint

/**
 * The status line. (Read out from Live.tsx, outside the HUD, so a dialog can't silence it.) On a
 * phone a long one wraps onto a second line, which the letter-by-letter morph can't do: there
 * it is plain text.
 */
export function HintBar() {
  const compact = useCompact();
  // (Placing a build from the dock leaves the status line empty: it says what to do then, and how to cancel. The phone's dock says it itself.)
  const hint = useUI((s) => s.hint || (!compact && (s.interaction.kind === 'road' || s.interaction.kind === 'settlement' || s.interaction.kind === 'city') ? placingText(s.interaction.kind, s.interaction.kind === 'road' && !!s.interaction.free) : ''));
  return (
    <AnimatePresence>
      {hint && (
        <motion.div key="hint" className="hintbar" data-hud-obstacle="hint" aria-hidden initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0, transition: SPRING_UI }} exit={{ opacity: 0, y: -10, transition: EXIT }}>
          {compact ? hint : <Morph>{hint}</Morph>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Why an action was refused, for a moment under the roll chip (above any quality note there, and
 * above an open dialog, whose own buttons are often what was refused). On a phone it stands just
 * above the dock instead, or above its open sheet or a dialog over it, near the finger that was
 * refused rather than across the screen from it. Read out from Live.tsx.
 */
export function ErrorBar() {
  const error = useUI((s) => s.error);
  const compact = useCompact();
  const [anchor, setAnchor] = useState<React.CSSProperties | undefined>();
  // (Measured as each reason comes up: it stays only a moment.)
  useLayoutEffect(() => setAnchor(error && compact ? aboveDock() : undefined), [error, compact]);
  return (
    // (One at a time: a new reason replaces the last at once rather than stacking under it.)
    <AnimatePresence mode="popLayout">
      {error && (
        <motion.div key={error} className={`errorbar${anchor ? ' docked' : ''}`} style={anchor} aria-hidden initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0, transition: SPRING_UI }} exit={{ opacity: 0, transition: EXIT }}>
          {error}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Where the phone's error bar stands: centred over the dock (on a foldable or a phone on its side
 * that's the right of the screen), its foot a little above the top of whatever is highest of the
 * dock, the buttons over its corners, its open sheet and a dialog over it. Undefined with no dock.
 */
function aboveDock(): React.CSSProperties | undefined {
  const dock = document.querySelector('.ui-layer.compact > .cdock');
  if (!dock) return undefined;
  const box = dock.getBoundingClientRect();
  let top = box.top;
  for (const el of document.querySelectorAll('.cdock-float > *, .dock-pop, .modal')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && getComputedStyle(el).visibility !== 'hidden') top = Math.min(top, r.top);
  }
  return {
    ['--err-bottom' as string]: `${Math.round(window.innerHeight - top + 8)}px`,
    ['--err-left' as string]: `${Math.round(box.left)}px`,
    ['--err-right' as string]: `${Math.round(window.innerWidth - box.right)}px`,
    ['--err-width' as string]: `${Math.round(box.width)}px`,
  };
}

// News that isn't good (a seven, an empty supply) comes on a dusk brown, never an alarm's red: as
// quiet as the browser's bars, which take the robber's moment in shadow (app/chromeTint.ts).
const TONE_RIBBON: Record<string, { band: string; dark: string; ink: string }> = {
  warn: { band: '#6b5a48', dark: '#3f3428', ink: '#f8eedc' },
  info: { band: '#c99a45', dark: '#8a6524', ink: '#2b1d0c' },
};

/**
 * Announcements on a fabric ribbon: the band unfurls from the centre, its swallowtail ends
 * fold out behind it, it swings once as it's hung and settles, and it rolls back up as it
 * leaves (the line under it and the ends tucked away first, then the band closing in to the
 * centre). What they say goes in the game log too, and that is what a screen reader hears.
 */
export function Banners() {
  const banners = useUI((s) => s.banners);
  const seats = useSeats();
  const reduce = useReducedMotionConfig();
  const tuck = { duration: 0.2, ease: [0.4, 0, 1, 1] } as const;
  return (
    <div className="banners" aria-hidden>
      <AnimatePresence>
        {banners.map((b) => {
          const pal = b.player !== undefined && seats[b.player] ? PLAYER_PALETTE[seats[b.player].color] : null;
          const c = pal ? { band: pal.base, dark: pal.dark, ink: pal.trim } : (TONE_RIBBON[b.tone ?? 'info'] ?? TONE_RIBBON.info);
          return (
            <motion.div
              key={b.id}
              // (The others close up smoothly when one goes.)
              layout="position"
              className="banner"
              style={{ ['--rb' as string]: c.band, ['--rb-dark' as string]: c.dark, ['--rb-ink' as string]: c.ink }}
              // (Its parts come and go on their own: the banner itself fades only with reduced motion,
              // and then around them, since its fade blinds the glass line under it while it lasts.)
              initial={{ opacity: reduce ? 0 : 1, y: reduce ? 0 : -14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: reduce ? { delay: 0.2, duration: 0.25 } : { delay: 0.5, duration: 0.12 } }}
              transition={{ duration: 0.25 }}
            >
              <motion.div className="ribbon-tail left" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: reduce ? 0 : 40, opacity: 0, transition: tuck }} transition={{ delay: 0.22, type: 'spring', stiffness: 260, damping: 22 }} />
              <motion.div className="ribbon-tail right" initial={{ x: -40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: reduce ? 0 : -40, opacity: 0, transition: tuck }} transition={{ delay: 0.22, type: 'spring', stiffness: 260, damping: 22 }} />
              <motion.div
                className="ribbon-band"
                initial={{ clipPath: 'inset(0 50% 0 50%)' }}
                animate={{ clipPath: 'inset(0 0% 0 0%)' }}
                exit={reduce ? undefined : { clipPath: 'inset(0 50% 0 50%)', transition: { delay: 0.14, duration: 0.4, ease: [0.65, 0, 0.35, 1] } }}
                transition={{ duration: reduce ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
              >
                <h2>{b.title}</h2>
              </motion.div>
              {b.subtitle && (
                <motion.p className="banner-sub" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduce ? 0 : -8, transition: tuck }} transition={{ delay: 0.3 }}>
                  {b.subtitle}
                </motion.p>
              )}
              {b.art && (
                <motion.img className="banner-art" src={asset(b.art)} alt="" draggable={false} initial={{ opacity: 0, y: reduce ? 0 : -12, rotate: reduce ? 0 : -4 }} animate={{ opacity: 1, y: 0, rotate: 0 }} exit={{ opacity: 0, y: reduce ? 0 : -8, transition: tuck }} transition={{ delay: 0.36, type: 'spring', stiffness: 220, damping: 20 }} />
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// --------------------------------------------------------------------- hand

/** Your development cards, one group per type with a count, and which can be played now. */
export function devGroups(view: GameState, me: PlayerId, busy: boolean) {
  const p = view.players[me];
  const playable = new Set(playableDevCards(view, me).map((c) => c.type));
  // One stack per card type with a count, so every card's text stays readable.
  const order: DevCardType[] = ['knight', 'roadBuilding', 'invention', 'monopoly', 'victoryPoint'];
  return order
    .map((type) => {
      const cards = p.devCards.filter((c) => c.type === type);
      const fresh = cards.filter((c) => c.boughtTurn >= view.turn && type !== 'victoryPoint').length;
      const ready = cards.length - fresh;
      // Not while a presentation runs: a card just played stays on screen until its animation ends.
      const canPlay = !busy && ready > 0 && playable.has(type) && !(type === 'roadBuilding' && legalRoads(view, me).length === 0);
      return { type, count: cards.length, fresh, ready, canPlay };
    })
    .filter((g) => g.count > 0);
}

/** Why a group of development cards can't be played now (null when it can). */
export function devReason(view: GameState, me: PlayerId, busy: boolean, g: ReturnType<typeof devGroups>[number]) {
  if (g.canPlay) return null;
  if (g.type === 'victoryPoint') return 'Counts by itself at the end: no need to play it';
  if (g.ready === 0) return 'Bought this turn: playable from your next turn';
  if (view.currentPlayer !== me) return 'Playable on your turn';
  if (busy) return 'Wait for the last move to finish';
  if (view.devCardPlayedThisTurn) return 'One development card a turn, and you have played yours';
  if (view.phase !== 'roll' && view.phase !== 'main') return 'Finish the current step first';
  if (g.type === 'roadBuilding') return 'No free edge joins your roads';
  return 'Not right now';
}

export function playDev(type: DevCardType) {
  sfx.play('click');
  if (type === 'knight') session.act({ type: 'playKnight' });
  else if (type === 'roadBuilding') session.act({ type: 'playRoadBuilding' });
  else if (type === 'invention') useUI.getState().set({ modal: 'invention' });
  else if (type === 'monopoly') useUI.getState().set({ modal: 'monopoly' });
}

/** A card stack's width and a token's, and the hand's gap and side padding, at the hand's own scale (ui.css). */
const SLOT = { card: 92, token: 52, gap: 14, pad: 28 };

/**
 * The hand (and the development cards beside it) drawn smaller when the room between the columns
 * is narrower than they are, rather than its stacks squeezed under their cards, which then lay
 * over one another: a fit on the wrap (--hand-fit), times the window's own step (--hand-zoom).
 *
 * And while every kind in play fits at a card's width (the base game's five, a guilds game's nine
 * on a desktop window), each keeps a full slot whether held or not (data-even): an empty kind is a
 * card-shaped well, so the hand is one size from the first card to the last and a card lands in its
 * own place. With more kinds than the room takes, the empty ones narrow to slim wells instead.
 */
function useHandFit() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    let fit = 1;
    let even = false;
    const measure = () => {
      const parts = [...el.children] as HTMLElement[];
      let width = 0;
      for (const part of parts) width += part.getBoundingClientRect().width;
      if (width === 0) return;
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const room = el.clientWidth - gap * (parts.length - 1);
      // The hand at full slots: every kind a card's width (tokens a token's), at the window's step.
      const hand = el.querySelector('.hand');
      if (hand) {
        const zoom = parseFloat(getComputedStyle(el).getPropertyValue('--hand-zoom')) || 1;
        const cards = hand.querySelectorAll('.stack:not(.token)').length;
        const tokens = hand.querySelectorAll('.stack.token').length;
        const slots = cards + tokens + (tokens ? 1 : 0);
        const full = (cards * SLOT.card + tokens * SLOT.token + Math.max(0, slots - 1) * SLOT.gap + SLOT.pad) * zoom;
        const others = parts.filter((p) => !p.contains(hand)).reduce((w, p) => w + p.getBoundingClientRect().width, 0);
        // (A little either way of the line, so a window resized across it doesn't flicker between the two.)
        const next = room - others >= full * (even ? 0.74 : 0.8);
        if (next !== even) {
          even = next;
          if (even) el.dataset.even = '';
          else delete el.dataset.even;
          return;
        }
      }
      // (What's drawn scales with the fit, so one step lands on the size that fits.)
      const next = Math.min(1, Math.max(0.5, (room * fit) / width));
      // (Any overflow is taken in, however small: a hand a pixel too wide runs past the room's edge.)
      if (next > fit - 0.002 && next - fit < 0.01) return;
      fit = next;
      el.style.setProperty('--hand-fit', String(+fit.toFixed(3)));
    };
    // (A resize is measured on the next frame: the fit it writes resizes the parts the observer
    // watches, and written straight away that is a resize loop the browser reports, as with a hand
    // grown past a short window's room.)
    let raf = 0;
    const sizes = new ResizeObserver(() => {
      raf ||= requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    });
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const part of el.children) sizes.observe(part);
    };
    // (The development cards' panel coming or going.)
    const tree = new MutationObserver(() => {
      watch();
      measure();
    });
    watch();
    tree.observe(el, { childList: true });
    measure();
    return () => {
      sizes.disconnect();
      cancelAnimationFrame(raf);
      tree.disconnect();
    };
  }, [el]);
  return setEl;
}

export function HandArea() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const hand = useHand(me);
  const fitRef = useHandFit();
  // (Watching online there's no hand of yours: the seat drawn is only known by its size.)
  const quay = useUI((s) => !!s.online?.watch);
  if (!view || quay) return null;
  const p = view.players[me];
  const tokens = tokensOf(view, me, true);
  const groups = devGroups(view, me, busy);
  // Slots only move when a stack appears or empties.
  const slotKey = groups.map((g) => g.type).join();
  return (
    <div className="hand-wrap" ref={fitRef} data-hud-obstacle="hand">
      {/* Slides aside when the development cards' panel appears or goes. */}
      <motion.div className={`hand parchment${total(hand) === 0 ? ' all-empty' : ''}`} data-anchor="hand" layout="position" layoutDependency={groups.length > 0} transition={{ type: 'spring', duration: 0.4, bounce: 0 }}>
        <div className="section-label">
          Your hand · <Morph>{total(hand)}</Morph>
        </div>
        {/* Every kind in play: commodities and oil sit after the resources (an empty one is a slim slot). */}
        {cardKinds(view).map((r) => (
          <HandStack key={r} r={r} n={hand[r]} />
        ))}
        {/* Then the expansions' tokens, spent like cards (game/holdings.ts), past a divider. */}
        {tokens.length > 0 && <span className="hand-divider" aria-hidden />}
        {tokens.map((tk) => (
          <TokenStack key={tk.id} t={tk} />
        ))}
      </motion.div>
      {/* Only once there are development cards to show. */}
      <AnimatePresence initial={false}>
        {groups.length > 0 && (
          <motion.div key="devhand" className="devhand parchment" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8, transition: { duration: 0.2 } }} transition={{ type: 'spring', duration: 0.35, bounce: 0 }}>
            <div className="section-label">
              Cards · <Morph>{p.devCards.length}</Morph>
            </div>
            <AnimatePresence mode="popLayout">
              {groups.map((g) => {
                const canPlay = g.canPlay;
                const why = devReason(view, me, busy, g);
                // The hand is drawn small, so the card's own lettering is too: its name and rule are
                // in the tooltip and the button's name, at a size that reads.
                const label = `${DEV_NAMES[g.type]}${g.count > 1 ? ` ×${g.count}` : ''}: ${DEV_TEXT[g.type]}`;
                return (
                  <motion.button
                    type="button"
                    key={g.type}
                    className={`devslot tip ${canPlay ? 'playable' : ''}`}
                    data-tip={canPlay ? `${label}. Click to play` : `${label}. ${why}`}
                    aria-label={canPlay ? `Play ${label}` : `${label}. ${why}`}
                    aria-disabled={canPlay ? undefined : true}
                    layout
                    layoutDependency={slotKey}
                    initial={{ opacity: 0, y: 40, rotate: 8 }}
                    animate={{ opacity: 1, y: 0, rotate: 0 }}
                    exit={{ opacity: 0, y: -60, scale: 1.2 }}
                    onClick={() => (canPlay ? playDev(g.type) : explain(why))}
                  >
                    {g.fresh > 0 && <div className="new-tag">New</div>}
                    {g.count > 1 && <div className="count">{g.count}</div>}
                    <DevCard type={g.type} variant={g.count - 1} />
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** (Memoised, as is a supply stack: a new state redraws only the stacks whose count changed.) */
const HandStack = memo(function HandStack({ r, n }: { r: Card; n: number }) {
  const nChanged = useChanged(n);
  const layers = Math.min(n, 5);
  const place = (i: number) => ({ x: i * 3, y: -i * 3, rotate: (i - (layers - 1) / 2) * 1.6 });
  return (
    <div className={`stack tip ${n === 0 ? 'empty' : ''}`} data-anchor={`hand-${r}`} data-tip={CARD_NAMES[r]} role="img" aria-label={`${CARD_NAMES[r]}: ${n}`} style={{ ['--tint' as string]: CARD_TINT[r] }}>
      {/* None held: a slim slot with the resource's icon, so the empty hand stays small. A card
          arriving settles onto the stack (fading in under the one flying in); a card leaving
          lifts off it and fades (as its flight sets off from here). */}
      {n === 0 && <img className="stack-slot" src={asset(CARD_ICON[r])} alt="" draggable={false} />}
      <AnimatePresence initial={false}>
        {Array.from({ length: layers }, (_, i) => (
          <motion.div
            key={i}
            className="stack-card"
            initial={{ ...place(i), y: place(i).y - 12, scale: 1.04, opacity: 0 }}
            animate={{ ...place(i), scale: 1, opacity: 1 }}
            exit={{ ...place(i), y: place(i).y - 14, opacity: 0, transition: { duration: 0.2, ease: 'easeOut' } }}
            transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
          >
            <ResourceCard resource={r} />
          </motion.div>
        ))}
      </AnimatePresence>
      {n > 0 && (
        <div className="count">
          {nChanged && <motion.span key={n} className="count-ring" initial={{ opacity: 0.8, scale: 0.8 }} animate={{ opacity: 0, scale: 1.7 }} transition={{ duration: 0.6 }} aria-hidden />}
          <Morph>{n}</Morph>
        </div>
      )}
    </div>
  );
});

/** A token kind in the hand: its painting and how many, a slim slot like an empty stack when none. */
const TokenStack = memo(function TokenStack({ t }: { t: TokenHolding }) {
  return (
    <div className={`stack token tip ${t.n === 0 ? 'empty' : ''}`} data-anchor={`hand-${t.id}`} data-tip={t.name} role="img" aria-label={t.label} style={{ ['--tint' as string]: t.tint }}>
      <img className="stack-slot" src={asset(t.icon)} alt="" draggable={false} />
      {t.n > 0 && (
        <div className="count">
          <Morph>{t.n}</Morph>
        </div>
      )}
    </div>
  );
});

// ------------------------------------------------------------------ actions

/** In place of the actions while a finished game is watched back. */
function ReplayPanel() {
  const r = useUI((s) => s.replay)!;
  const turn = useUI((s) => s.view?.turn ?? 0);
  const c = session.replayControls;
  const over = r.index >= r.total;
  return (
    <div className="actions replay-panel parchment" role="group" aria-label="Replay">
      <div className="replay-head">
        <span className="replay-title">Replay</span>
        {r.fair !== undefined && (
          <span className={`fair-badge${r.fair ? '' : ' unchecked'}`} title={r.fair ? 'The dice key revealed at the end matches the one promised at the start, and every roll replays from it' : 'The dice couldn’t be checked against the key'}>
            {r.fair ? 'Dice checked: fair' : 'Dice not checked'}
          </span>
        )}
        <span className="replay-turn">
          Turn <Morph>{String(Math.max(1, turn))}</Morph>
        </span>
      </div>
      <div className="replay-track" role="progressbar" aria-label="Moves played" aria-valuemin={0} aria-valuemax={r.total} aria-valuenow={r.index}>
        <div style={{ transform: `scaleX(${r.total ? r.index / r.total : 0})` }} />
      </div>
      {/* Play and pause lead (the one wooden button); the rest are quieter. */}
      <div className="row replay-buttons">
        <button className="btn small" onClick={c.toggle} disabled={over} aria-pressed={r.paused}>
          {r.paused ? <PlayGlyph size={16} /> : <LineIcon name="pause" size={16} />}
          <Morph>{r.paused ? 'Play' : 'Pause'}</Morph>
        </button>
        <button className="btn ghost small" onClick={c.nextTurn} disabled={over || r.ff}>
          <LineIcon name="next" size={16} />
          Next turn
        </button>
      </div>
      <div className="seg" role="group" aria-label="Replay speed">
        {[1, 2, 4].map((x) => (
          <button key={x} className={r.speed === x ? 'on' : ''} aria-pressed={r.speed === x} onClick={() => c.speed(x)}>
            {x}×
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn ghost small" onClick={c.restart}>
          <LineIcon name="refresh" size={16} />
          Restart
        </button>
        <button className="btn ghost small" onClick={() => void session.quitToTitle()}>
          <LineIcon name="exit" size={16} />
          Exit replay
        </button>
      </div>
    </div>
  );
}

/** Play, as a media control has it (LineIcons' `play` is the game's die). In the line icons' own style. */
export function PlayGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg className="line-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7.5 4.5v15L19 12z" />
    </svg>
  );
}

/** A door with an arrow leading out of it: leave the game. */
export function ExitIcon({ size = 20 }: { size?: number }) {
  return (
    <Filled name="exit" size={size}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
        <path d="M15 8l4 4-4 4" />
        <path d="M19 12H9" />
      </svg>
    </Filled>
  );
}

export function ActionBar() {
  const replay = useUI((s) => s.replay !== null);
  return replay ? <ReplayPanel /> : <Actions />;
}

const KEYS: ActionKey[] = ['roll', 'build', 'road', 'settlement', 'city', 'dev', 'trade', 'bank', 'end'];

/** Why each of the turn's actions can't be taken now (null where it can), kept as the game moves. */
export function useReasons() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const replay = useUI((s) => s.replay !== null);
  return useMemo(() => Object.fromEntries(KEYS.map((k) => [k, whyNot(k)])) as Record<ActionKey, string | null>, [view, me, busy, replay]);
}

/**
 * A button that stays focusable while it can't be used (aria-disabled, not disabled), so the
 * keyboard reaches it and hears why; pressing it then shows the reason instead of doing nothing.
 */
export function ReasonButton({ reason, onClick, className, children, title, ...rest }: { reason: string | null; onClick: () => void; className: string; children: React.ReactNode; title?: string } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'title' | 'disabled'>) {
  const id = useId();
  return (
    <>
      <button {...rest} type="button" className={className} aria-disabled={reason ? true : undefined} aria-describedby={reason ? id : undefined} title={reason ?? title} onClick={() => (reason ? explain(reason) : onClick())}>
        {children}
      </button>
      {reason && (
        <span id={id} className="sr-only">
          {reason}
        </span>
      )}
    </>
  );
}

function Actions() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const interaction = useUI((s) => s.interaction);
  const confirmEnd = useUI((s) => s.endArmed);
  const glass = useUI((s) => s.settings.look === 'glass');
  // Recompute when the view or busy state changes.
  const info = useMemo(() => availability(), [view, me, busy]);
  const why = useReasons();
  // Leave a build mode whose cost was just traded or spent away.
  useEffect(() => {
    const k = interaction.kind;
    if (!info || busy || (k !== 'road' && k !== 'settlement' && k !== 'city')) return;
    if (k === 'road' && interaction.free) return;
    if (!info[k]) cancelPlacement();
  }, [info, busy, interaction]);
  const extras = useMemo(() => (view ? extraBuilds(view, me) : []), [view, me]);
  if (!view || !info) return null;
  const free = interaction.kind === 'road' && !!interaction.free;
  const picking = interaction.kind === 'pick' ? interaction.label : null;
  return (
    <div className="actions parchment">
      {view.currentPlayer === me && view.phase === 'roll' ? (
        <ReasonButton className="btn gold roll-btn" reason={why.roll} onClick={rollDice} title="Roll the dice (Space)">
          <Icon name="dice" size={26} /> Roll the dice <kbd>Space</kbd>
        </ReasonButton>
      ) : null}
      <div {...buildsRow(3 + (cardForSale(view) ? 1 : 0) + extras.length)}>
        <BuildButton label="Road" hotkey="1" cost={COSTS.road} reason={free ? FREE_ROADS : why.road} on={interaction.kind === 'road'} onClick={() => toggleBuild('road')} icon={<Icon name="road" size={34} />} />
        <BuildButton label="House" hotkey="2" cost={COSTS.settlement} reason={why.settlement} on={interaction.kind === 'settlement'} onClick={() => toggleBuild('settlement')} icon={<Icon name="settlement" size={34} />} />
        <BuildButton label="Town" hotkey="3" cost={COSTS.city} reason={why.city} on={interaction.kind === 'city'} onClick={() => toggleBuild('city')} icon={<Icon name="city" size={34} />} />
        {/* (A game without development cards, the guilds' for one, has nothing to buy here; Invasion alone sells its muster cards.) */}
        {cardForSale(view) && <BuildButton label={cardForSale(view) === 'muster' ? 'Muster card' : 'Dev card'} hotkey="4" cost={COSTS.devCard} reason={why.dev} on={false} onClick={buyDevCard} icon={<Icon name="devcard" size={34} />} />}
        {extras.map((b) => (
          <ExtraBuildButton key={b.key} b={b} on={picking === b.label} />
        ))}
      </div>
      {!glass && (
        <div className="row">
          <ReasonButton className="btn ghost small" reason={why.trade} onClick={() => openModal('trade')} title="Offer a trade to other players (T)">
            <Icon name="trade" size={20} /> Offer trade
          </ReasonButton>
          <ReasonButton className="btn ghost small" reason={why.bank} onClick={() => openModal('bank')} title="Trade with the supply or your harbours (B)">
            <Icon name="harbour" size={20} /> Supply trade
          </ReasonButton>
        </div>
      )}
      <div className={`end-row${info.undo ? ' with-undo' : ''}${glass ? ' with-trade' : ''}`}>
        {info.undo && (
          <button className="btn ghost undo-btn" onClick={undoLast} title="Undo: take back your last move (Ctrl+Z)" aria-label="Undo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
          </button>
        )}
        {/* (Sea Glass: one Trade button, its dialog's tabs holding the players and the supply.) */}
        {glass && (
          <ReasonButton className="btn trade-btn" reason={why.trade && why.bank} onClick={() => openModal(why.trade ? 'bank' : 'trade')} title="Trade with players (T) or the supply (B)">
            <Icon name="trade" size={20} /> Trade
          </ReasonButton>
        )}
        <ReasonButton className="btn end-btn" reason={why.end} onClick={() => endTurn()} title="End your turn (Enter)" aria-label={confirmEnd ? 'Press again to end turn' : 'End turn'}>
          <Morph>{confirmEnd ? 'Press again to end turn' : 'End turn'}</Morph>
          <LineIcon name="arrowRight" size={18} />
        </ReasonButton>
      </div>
    </div>
  );
}

/**
 * The build tiles' row: two columns for the base game's three or four, and for more (the
 * expansions' builds beside them) up to four columns of smaller tiles in two rows.
 */
export function buildsRow(n: number): { className: string; style?: React.CSSProperties } {
  return n > 4 ? { className: 'row builds many', style: { ['--build-cols' as string]: Math.min(4, Math.ceil(n / 2)) } } : { className: 'row builds' };
}

/**
 * An expansion's build (game/builds.ts) as a tile: its price, greyed with the reason when it can't
 * be built (under it too, in a few words, in the phone's sheet: `note`), lit while its pick is on.
 */
export function ExtraBuildButton({ b, on, note = false, onClick = () => toggleExtraBuild(b.key) }: { b: ExtraBuild; on: boolean; note?: boolean; onClick?: () => void }) {
  const r = extraBuildReason(b);
  return <BuildButton label={b.label} hotkey={EXTRA_HOTKEYS[b.key]} cost={b.cost} reason={r.why} note={note ? r.note : null} on={on} onClick={onClick} icon={<img className="ui-icon" src={asset(b.icon)} alt="" width={34} height={34} draggable={false} />} />;
}

/** Road Crew's roads must all go down before anything else (the road tile stays lit meanwhile). */
const FREE_ROADS = 'Place your free roads first';

/**
 * A build tile. `reason` says why it can't be used now (null when it can); a lit tile (`on`, its
 * placing under way) can always be pressed again to leave placing, except while free roads wait.
 * `note` is the reason in a few words under it, where there's room (the phone's Build sheet).
 */
export function BuildButton({ label, hotkey, cost, reason, on, onClick, icon, note }: { label: string; hotkey: string; cost: CardCounts; reason: string | null; on: boolean; onClick: () => void; icon: React.ReactNode; note?: string | null }) {
  const blocked = on && reason !== FREE_ROADS ? null : reason;
  const title = blocked ? `${label}: ${blocked}` : `${label} (${hotkey})${on ? ' — click again or press Esc to cancel' : ''}`;
  return (
    <ReasonButton className={`build-btn ${on ? 'on' : ''}`} reason={blocked} onClick={onClick} title={title} aria-label={`${label}${on ? ', placing' : ''}. Costs ${describeCards(cost)}`}>
      <span className="ico">
        {icon}
        <kbd className="hk">{hotkey}</kbd>
      </span>
      <span className="lbl">{label}</span>
      <span className="cost">
        {CARDS.flatMap((r) => Array.from({ length: cost[r] }, (_, i) => <img key={`${r}${i}`} src={asset(CARD_ICON[r])} alt={CARD_NAMES[r]} />))}
      </span>
      {/* (Heard in full from the reason the button is described by.) */}
      {blocked && note && (
        <span className="why-note" aria-hidden>
          {note}
        </span>
      )}
    </ReasonButton>
  );
}

/**
 * While the game is paused (P, or Pause in the menu), a pill says so for as long as it lasts, with
 * the way to carry on: paused, nothing moves, and a game that seems to have stopped needs a reason.
 */
export function PausedPill() {
  const paused = useUI((s) => s.paused);
  const touch = useCompact();
  return (
    <AnimatePresence>
      {paused && (
        <motion.div key="paused" className="paused-pill parchment" role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0, transition: SPRING_UI }} exit={{ opacity: 0, y: -8, transition: EXIT }}>
          <span>Paused</span>
          <button type="button" className="btn gold small" onClick={() => session.setPaused(false)}>
            <PlayGlyph size={16} />
            Carry on{!touch && <kbd>P</kbd>}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
