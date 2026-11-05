// The HUD for phones and other small windows (see useCompact): a slim top bar of player chips
// and two buttons, the board in the middle, and one dock at the bottom with the hand and the
// turn's actions. What the big HUD shows at all times (the supply, the log, each player's full
// panel, the build costs) is a tap away instead.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { COSTS, RESOURCES, cardKinds, devCardsInGame, publicVictoryPoints, totalVictoryPoints, type GameState, type PlayerId, type Resource } from '../engine';
import { useShallow } from 'zustand/react/shallow';
import { useUI } from '../game/store';
import { session } from '../app/session';
import { PLAYER_PALETTE } from '../render/board/pieces';
import { CARD_ICON, CARD_NAMES, CARD_TINT, asset } from '../game/names';
import { tokensOf } from '../game/holdings';
import { availability, buyDevCard, cancelPlacement, cardForSale, endTurn, openModal, rollDice, toggleBuild, toggleExtraBuild, undoLast } from '../game/commands';
import { extraBuilds } from '../game/builds';
import { Icon } from './Cards';
import { Morph } from './Morph';
import { total, useEscape, useHand } from './hooks';
import { AvatarFace } from './Avatar';
import { SeatMark } from './SeatMark';
import { ChipClock, Presence } from './Presence';
import { ChatButton, SpeechBubble } from './Chat';
import { BuildButton, ExtraBuildButton, LogText, PlayerPanel, ReasonButton, awaitsAnswerFrom, buildsRow, devGroups, isWaitingOn, useReasons } from './Hud';
import { buildNote, placingText } from './why';
import { CloseIcon, LineIcon } from './LineIcons';

// ----------------------------------------------------------------- top bar

/** Every player as a chip (face, mark, points, cards); a tap opens that player's full panel. */
export function PlayerChips() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  // (Online the others are people too: their panels show them thinking as the crew's do.)
  const online = useUI((s) => s.online !== null);
  const [open, setOpen] = useState<PlayerId | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // A tap anywhere else closes the panel.
  useEffect(() => {
    if (open === null) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  useEscape(open !== null, () => setOpen(null));
  // How wide the chips run, for the status line beside them on a landscape phone (see ui.css).
  useLayoutEffect(() => {
    const el = ref.current;
    const layer = el?.parentElement;
    if (!el || !layer) return;
    const ro = new ResizeObserver(() => layer.style.setProperty('--chips-w', `${el.offsetWidth}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!view]);
  if (!view) return null;
  return (
    <div className="pchips" ref={ref} data-hud-obstacle="pchips">
      {view.players.map((p) => (
        <PlayerChip
          key={p.id}
          state={view}
          id={p.id}
          me={me}
          open={open === p.id}
          thinking={!busy && (p.isBot || online) && p.id !== me && isWaitingOn(view, p.id) && !awaitsAnswerFrom(view, me)}
          onToggle={() => setOpen(open === p.id ? null : p.id)}
        />
      ))}
      <AnimatePresence>
        {open !== null && (
          <motion.div
            key={open}
            className="pchip-pop glass-fade"
            initial={{ '--fade': 0, y: -6 }}
            animate={{ '--fade': 1, y: 0 }}
            exit={{ '--fade': 0, y: -4, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          >
            <PlayerPanel state={view} id={open} me={me} thinking={false} anchor={false} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PlayerChip({ state, id, me, open, thinking, onToggle }: { state: GameState; id: PlayerId; me: PlayerId; open: boolean; thinking: boolean; onToggle: () => void }) {
  const p = state.players[id];
  const pal = PLAYER_PALETTE[p.color];
  const held = total(useHand(id));
  const active = state.currentPlayer === id && state.phase !== 'gameOver';
  const vp = id === me || state.phase === 'gameOver' ? totalVictoryPoints(state, id) : publicVictoryPoints(state, id);
  const awards = state.longestRoadHolder === id || state.largestArmyHolder === id;
  // (Others' hands over seven are at risk on a seven: their count turns warm.)
  const many = held > 7 && id !== me;
  return (
    <div className="pchip-wrap" style={{ ['--pc' as string]: pal.ui }}>
      <button
        type="button"
        className={`pchip${active ? ' active' : ''}${open ? ' open' : ''}`}
        data-anchor={`player-${id}`}
        aria-expanded={open}
        aria-label={`${p.name}${id === me && p.name !== 'You' ? ' (you)' : ''}: ${vp} victory points, ${held} resource card${held === 1 ? '' : 's'}${active ? (id === me ? ', your turn' : ', their turn') : ''}${thinking ? ', thinking' : ''}. Show details`}
        onClick={onToggle}
      >
        <span className="pchip-face">
          <AvatarFace code={session.avatars[id] ?? -1} name={p.name} color={p.color} />
          <span className="avatar-mark">
            <SeatMark seat={id} color={pal.ui} size={9} />
          </span>
          <Presence player={id} />
        </span>
        <span className="pchip-nums" aria-hidden>
          <span className="pchip-vp">
            <Morph>{vp}</Morph>
          </span>
          <span className={`pchip-cards${many ? ' many' : ''}`}>
            <Icon name="cards" size={12} />
            <Morph>{held}</Morph>
          </span>
        </span>
        {awards && <span className="pchip-award" aria-hidden />}
        {/* (Online the seat's clock, where it has one, stands where the thinking dots would.) */}
        <ChipClock player={id}>
          {thinking && (
            <span className="thinking" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          )}
        </ChipClock>
      </button>
    </div>
  );
}

/** Table talk and the menu (which holds everything else). */
export function CompactBar() {
  const set = useUI((s) => s.set);
  return (
    <div className="cbar" data-hud-obstacle="cbar">
      <ChatButton />
      <button className="icon-btn" onClick={() => set({ modal: 'menu' })} aria-label="Menu: rules, settings, supply and log">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Under the top bar, one column: the status line, the newest lines of the game log (the full log
 * is in the menu), and what the others say, one bubble under another in their colours (not under
 * each chip, where bubbles said at once would overlap).
 */
export function CompactStatus({ children }: { children: React.ReactNode }) {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  return (
    <div className="cstatus">
      {children}
      <LogTicker />
      {view && (
        <div className="cspeech" aria-hidden>
          {view.players
            .filter((p) => p.id !== me)
            .map((p) => (
              <div key={p.id} className="cspeech-row" style={{ ['--pc' as string]: PLAYER_PALETTE[p.color].ui }}>
                <SpeechBubble player={p.id} />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** The last few log lines, the newest darkest; each fades out a while after it came in. */
function LogTicker() {
  const lines = useUI(useShallow((s) => s.log.slice(-3)));
  const newest = lines.length ? lines[lines.length - 1].id : -1;
  const [quiet, setQuiet] = useState(-1);
  // A while after the last line came in, the ticker clears (the board is what matters then).
  useEffect(() => {
    const t = setTimeout(() => setQuiet(newest), 9000);
    return () => clearTimeout(t);
  }, [newest]);
  const shown = quiet === newest ? [] : lines;
  return (
    <ol className="cticker" aria-hidden>
      <AnimatePresence initial={false}>
        {shown.map((l, i) => (
          <motion.li
            key={l.id}
            layout="position"
            className={i === shown.length - 1 ? 'new' : undefined}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
          >
            <LogText text={l.text.replace(/^— | —$/g, '')} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

// -------------------------------------------------------------------- dock

/** Your resources as chips (icon and count), and your development cards behind one chip. */
export function HandChips() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const set = useUI((s) => s.set);
  const hand = useHand(me);
  // (Watching online there's no hand of yours: the seat drawn is only known by its size.)
  const quay = useUI((s) => !!s.online?.watch);
  if (!view || quay) return null;
  const groups = devGroups(view, me, busy);
  const cards = view.players[me].devCards.length;
  const playable = groups.some((g) => g.canPlay);
  return (
    <div className="hand-chips" data-anchor="hand">
      {/* The resources, commodities and oil once held, then the expansions' tokens (game/holdings.ts);
          an empty kind is a slim chip, and past the row's width it scrolls sideways. */}
      {cardKinds(view).filter((r) => RESOURCES.includes(r as Resource) || hand[r] > 0).map((r) => (
        <div key={r} className={`hchip${hand[r] === 0 ? ' empty' : ''}`} data-anchor={`hand-${r}`} role="img" aria-label={`${CARD_NAMES[r]}: ${hand[r]}`} style={{ ['--tint' as string]: CARD_TINT[r] }}>
          <img src={asset(CARD_ICON[r])} alt="" draggable={false} />
          <span className="n">
            <Morph>{hand[r]}</Morph>
          </span>
        </div>
      ))}
      {tokensOf(view, me, true).map((tk) => (
        <div key={tk.id} className={`hchip token${tk.n === 0 ? ' empty' : ''}`} data-anchor={`hand-${tk.id}`} role="img" aria-label={tk.label} style={{ ['--tint' as string]: tk.tint }}>
          <img src={asset(tk.icon)} alt="" draggable={false} />
          <span className="n">
            <Morph>{tk.n}</Morph>
          </span>
        </div>
      ))}
      {/* (Only in a game with development cards.) */}
      {devCardsInGame(view) && (
        <button
          type="button"
          className={`hchip cards${cards === 0 ? ' empty' : ''}${playable ? ' playable' : ''}`}
          onClick={() => set({ modal: 'devcards' })}
          aria-label={`Development cards: ${cards}${playable ? ', one can be played' : ''}. Show them`}
        >
          <Icon name="devcard" size={22} />
          <span className="n">
            <Morph>{cards}</Morph>
          </span>
        </button>
      )}
    </div>
  );
}

/** Build, Trade and the turn's main button (Roll, then End turn); Undo while it applies. */
export function CompactActions() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const interaction = useUI((s) => s.interaction);
  const armed = useUI((s) => s.endArmed);
  const [sheet, setSheet] = useState<'build' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const info = view ? availability() : null;
  const why = useReasons();
  // Leave a build mode whose cost was just traded or spent away (as the big HUD does).
  useEffect(() => {
    const k = interaction.kind;
    if (!info || busy || (k !== 'road' && k !== 'settlement' && k !== 'city')) return;
    if (k === 'road' && interaction.free) return;
    if (!info[k]) cancelPlacement();
  }, [info?.road, info?.settlement, info?.city, busy, interaction]);
  // The sheets close on a tap elsewhere, on Escape, and when the turn moves on.
  useEffect(() => {
    if (!sheet) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setSheet(null);
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [sheet]);
  useEscape(sheet !== null, () => setSheet(null));
  useEffect(() => {
    if (!info?.main) setSheet(null);
  }, [info?.main]);
  const extras = view ? extraBuilds(view, me) : [];
  if (!view || !info) return null;
  const k = interaction.kind;
  const placing = k === 'road' || k === 'settlement' || k === 'city' ? k : null;
  const locked = placing === 'road' && interaction.kind === 'road' && !!interaction.free;
  const myRoll = view.currentPlayer === me && view.phase === 'roll';
  // Nothing in the sheet can be built: the button goes quiet (it still opens, to say what each lacks).
  const none = !why.build && !!(why.road && why.settlement && why.city && why.dev) && extras.every((b) => b.block);
  const pick = (fn: () => void) => () => {
    setSheet(null);
    fn();
  };
  return (
    <div className="cactions" ref={ref}>
      <AnimatePresence>
        {sheet && (
          <motion.div
            key={sheet}
            className="dock-pop parchment"
            role="group"
            aria-label="Build"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          >
            {/* (Each greyed tile says under it what it lacks, there where the finger is.) */}
            <div {...buildsRow(3 + (cardForSale(view) ? 1 : 0) + extras.length)}>
              <BuildButton label="Road" hotkey="1" cost={COSTS.road} reason={why.road} note={buildNote('road')} on={false} onClick={pick(() => toggleBuild('road'))} icon={<Icon name="road" size={34} />} />
              <BuildButton label="House" hotkey="2" cost={COSTS.settlement} reason={why.settlement} note={buildNote('settlement')} on={false} onClick={pick(() => toggleBuild('settlement'))} icon={<Icon name="settlement" size={34} />} />
              <BuildButton label="Town" hotkey="3" cost={COSTS.city} reason={why.city} note={buildNote('city')} on={false} onClick={pick(() => toggleBuild('city'))} icon={<Icon name="city" size={34} />} />
              {cardForSale(view) && <BuildButton label={cardForSale(view) === 'muster' ? 'Muster card' : 'Dev card'} hotkey="4" cost={COSTS.devCard} reason={why.dev} note={buildNote('dev')} on={false} onClick={pick(buyDevCard)} icon={<Icon name="devcard" size={34} />} />}
              {extras.map((b) => (
                <ExtraBuildButton key={b.key} b={b} on={false} note onClick={pick(() => toggleExtraBuild(b.key))} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {placing ? (
        // (Read out from Live.tsx, whose region stays mounted; this one comes and goes.)
        <div className="cplacing">
          <span className="cplacing-text">{placingText(placing, locked)}</span>
          {!locked && (
            <button className="btn ghost" onClick={() => cancelPlacement()}>
              <CloseIcon size={16} />
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="crow">
          <ReasonButton
            className={`btn ghost cbtn${sheet === 'build' ? ' on' : ''}${none ? ' quiet' : ''}`}
            reason={why.build}
            aria-expanded={sheet === 'build'}
            aria-label={none ? 'Build: nothing you can afford yet' : undefined}
            onClick={() => setSheet(sheet === 'build' ? null : 'build')}
          >
            <Icon name="settlement" size={22} /> Build
          </ReasonButton>
          {/* (Straight to the trade dialog: its tabs are the players and the supply.) */}
          <ReasonButton className="btn ghost cbtn" reason={why.trade} onClick={() => (setSheet(null), openModal('trade'))}>
            <Icon name="trade" size={22} /> Trade
          </ReasonButton>
          {info.undo && (
            <button className="btn ghost cbtn undo" onClick={undoLast} aria-label="Take back your last move">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
              </svg>
            </button>
          )}
          {/* One button for the turn's main move, Roll and then End turn, so its label morphs from
              one to the other where it stands. */}
          <ReasonButton className={`btn cmain${myRoll ? ' gold' : ''}`} reason={myRoll ? why.roll : why.end} onClick={myRoll ? rollDice : () => endTurn()}>
            {myRoll && <Icon name="dice" size={22} />}
            <Morph>{myRoll ? 'Roll' : armed ? 'Tap again' : 'End turn'}</Morph>
            {!myRoll && <LineIcon name="arrowRight" size={18} />}
          </ReasonButton>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ touch aids

/**
 * On touch, a tapped spot is only previewed (its ghost piece shows); this button, or a second
 * tap on the same spot, places it. It follows the spot as the camera moves.
 */
export function PlaceConfirm() {
  const confirm = useUI((s) => s.placeConfirm);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirm) return;
    let raf = 0;
    // Its size is measured when it changes, not read every frame (a read there would make the
    // browser lay the page out again in the middle of each frame), and it moves only when the spot does.
    let w = -1, h = 0, place = '';
    const measure = () => {
      const el = ref.current;
      if (el) (w = el.offsetWidth), (h = el.offsetHeight);
    };
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    const follow = () => {
      const at = session.input?.pendingScreenPoint();
      const el = ref.current;
      if (at && el) {
        if (w < 0) measure();
        // Above the spot (clear of the finger), kept inside the window.
        const x = Math.min(window.innerWidth - w - 8, Math.max(8, at.x - w / 2));
        const y = Math.max(8, at.y - h - 28);
        const next = `translate(${x}px, ${y}px)`;
        if (next !== place) el.style.transform = place = next;
      }
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [confirm]);
  return (
    <AnimatePresence>
      {confirm && (
        <div className="place-confirm" ref={ref} key="confirm">
          <motion.div className="place-confirm-inner" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.12 } }} transition={{ type: 'spring', duration: 0.25, bounce: 0 }}>
            <button className="btn gold" onClick={() => session.input?.confirmPending()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12.5 10 17 19 7" />
              </svg>
              {confirm.label}
            </button>
            <button className="icon-btn" onClick={() => session.input?.clearPending()} aria-label="Choose another spot">
              <CloseIcon size={18} />
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function Gesture({ kind }: { kind: 'pan' | 'pinch' | 'tilt' | 'hold' }) {
  const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r="3.2" fill="currentColor" stroke="none" />;
  return (
    <svg className="gesture" width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {kind === 'pan' && (
        <>
          {dot(15, 15)}
          <path d="M15 4v5M15 21v5M4 15h5M21 15h5M13 6l2-2 2 2M13 24l2 2 2-2M6 13l-2 2 2 2M24 13l2 2-2 2" />
        </>
      )}
      {kind === 'pinch' && (
        <>
          {dot(10, 20)}
          {dot(20, 10)}
          <path d="M7 23l-3 3M23 7l3-3M4 22v4h4M26 8V4h-4" />
        </>
      )}
      {kind === 'tilt' && (
        <>
          {dot(11, 16)}
          {dot(19, 16)}
          <path d="M11 11V5M19 11V5M9 7l2-2 2 2M17 7l2-2 2 2M11 21v4M19 21v4" />
        </>
      )}
      {kind === 'hold' && (
        <>
          {dot(15, 17)}
          <circle cx="15" cy="17" r="8" strokeDasharray="2.5 3" />
        </>
      )}
    </svg>
  );
}
