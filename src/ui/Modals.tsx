import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react';
import { EXIT_PANEL, FADE } from './motion';
import {
  devCardsInGame,
  CARDS,
  COSTS,
  RESOURCES,
  canTakeOil,
  cardKinds,
  legalActions,
  stealCandidates,
  stealableCount,
  totalCards,
  isOpenOffer,
  tradeRatios,
  type Action,
  type Card,
  type PlayerId,
  type CardCounts,
} from '../engine';
import { emptyCounts, showError, useUI } from '../game/store';
import { session } from '../app/session';
import { DEV_NAMES, DEV_TEXT, CARD_ICON, CARD_NAMES, asset } from '../game/names';
import { AvatarFace } from './Avatar';
import { PLAYER_PALETTE } from '../render/board/pieces';
import { DevCard, Icon, ResourceCard } from './Cards';
import { ExitIcon, LogEntries, ReasonButton, YieldPips, devGroups, devReason, incomeLine, playDev, useIncome, useSupplyExtras } from './Hud';
import { useCompact } from './useCompact';
import { buyDevCard, inventionMove, monopolyMove } from '../game/commands';
import { Morph } from './Morph';
import { LineIcon } from './LineIcons';
import { useBank, useDialogView, useHand } from './hooks';
import { sfx } from '../audio/sfx';
import { setMuted } from '../audio/mute';
import { MinusIcon, Modal, ResChips, ResPicker, TabPanel, Tabs, close, forgetMenu, openFromMenu, takeMenuRow } from './ModalFrame';
import { SupplyTrade, presetSupply } from './SupplyTrade';
import { CardDeal } from './TradeParts';
import { describeCards, perRoll, suggestDiscard, supplyPrice } from './advice';
import { explain, shortfall, whyNot } from './why';
import { OIL_LIMIT } from '../engine/modules/oil/rules';
import { HandPickModal } from './modules/CardPicks';

// Settings, the rules and the results are large and seldom open: each loads on first use (and is
// fetched in the background once the island is up, see preloadDialogs), so the first screen
// doesn't wait for them.
// (A failed fetch, on a flaky connection, is tried once more before the dialog gives up: see
// the dialogs' ErrorBoundary in App.tsx for what happens then.)
const again = <T,>(load: () => Promise<T>) => () => load().catch(() => new Promise<void>((ok) => setTimeout(ok, 800)).then(load));
const loadSettings = again(() => import('./SettingsModal'));
const loadRules = again(() => import('./RulesModal'));
const loadGameOver = again(() => import('./GameOver'));
const SettingsModal = lazy(() => loadSettings().then((m) => ({ default: m.SettingsModal })));
const RulesModal = lazy(() => loadRules().then((m) => ({ default: m.RulesModal })));
const GameOverModal = lazy(() => loadGameOver().then((m) => ({ default: m.GameOverModal })));

/** Fetch the on-demand dialogs ahead of need, when the page has a moment. */
export function preloadDialogs() {
  void loadSettings();
  void loadRules();
  void loadGameOver();
}

export function Modals() {
  const modal = useUI((s) => s.modal);
  useEffect(() => forgetMenu(modal), [modal]);
  return (
    <>
      {/* One shade under whichever dialog is open, kept across a change from one to another. */}
      <AnimatePresence>{modal !== null && <motion.div key="shade" className="modal-shade" aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1, transition: FADE }} exit={{ opacity: 0, transition: EXIT_PANEL }} />}</AnimatePresence>
      <AnimatePresence>
      {modal === 'discard' && <DiscardModal key="discard" />}
      {modal === 'steal' && <StealModal key="steal" />}
      {modal === 'invention' && <InventionModal key="invention" />}
      {modal === 'monopoly' && <MonopolyModal key="monopoly" />}
      {modal === 'cards' && <HandPickModal key="cards" />}
      {/* (One dialog for both: its tabs are the two keys, so switching keeps it open.) */}
      {(modal === 'trade' || modal === 'bank') && <TradeDialog key="trade" />}
      {modal === 'counter' && <CounterModal key="counter" />}
      {modal === 'settings' && (
        <Suspense key="settings" fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      {modal === 'rules' && (
        <Suspense key="rules" fallback={null}>
          <RulesModal />
        </Suspense>
      )}
      {modal === 'menu' && <MenuModal key="menu" />}
      {modal === 'leave' && <LeaveModal key="leave" />}
      {modal === 'devcards' && <DevCardsModal key="devcards" />}
      {modal === 'gameover' && (
        <Suspense key="gameover" fallback={null}>
          <GameOverModal />
        </Suspense>
      )}
      </AnimatePresence>
    </>
  );
}

// -------------------------------------------------------------------- discard

function DiscardModal() {
  const view = useDialogView();
  const me = useUI((s) => s.me);
  const hand = useHand(me);
  const need = view.pendingDiscards[me] ?? 0;
  const [sel, setSel] = useState<CardCounts>(emptyCounts());
  const [kept, setKept] = useState<string[] | null>(null);
  const n = totalCards(sel);
  // A starting point: give up what you hold most of, keeping what pays for your best build.
  const suggest = () => {
    const s = suggestDiscard(view, me, hand, need);
    setSel(s.discard);
    setKept(s.keeps);
  };
  const choose = (v: CardCounts) => {
    setSel(v);
    setKept(null);
  };
  return (
    <Modal>
      {/* (Not "the robber": Invasion has none, and he may not be out yet.) */}
      <h3>Discard half your hand</h3>
      <p className="sub">
        You hold {totalCards(hand)} cards. Choose <b>{need}</b> to return to the supply.
      </p>
      <ResPicker value={sel} onChange={choose} max={hand} limit={need} label={`${n} / ${need}`} kinds={cardKinds(view)} />
      <p className="discard-note" aria-live="polite">
        {kept ? (kept.length ? `This keeps enough for ${kept.slice(0, 2).join(' and ')}.` : 'Nothing can be kept whole, so this gives up what you hold most of.') : ''}
      </p>
      <div className="footer">
        {/* (A helper, not a choice the dialog asks for: quieter than the one that settles it.) */}
        <button className="btn ghost bare" onClick={suggest}>
          <LineIcon name="sparkle" size={18} />
          Suggest
        </button>
        <span className="footer-gap" aria-hidden />
        <button className="btn gold" disabled={n !== need} onClick={() => !session.act({ type: 'discard', resources: sel }) && close()}>
          Discard {need}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------- steal

function StealModal() {
  const view = useDialogView();
  const me = useUI((s) => s.me);
  const victims = view.stealCandidates.length || view.robberHex === null ? view.stealCandidates : stealCandidates(view, view.robberHex, me);
  return (
    <Modal>
      <h3>Choose a player to rob</h3>
      <p className="sub">You take a card from them at random.</p>
      <div className="response-list">
        {victims.map((v) => (
          <VictimRow key={v} id={v} />
        ))}
      </div>
    </Modal>
  );
}

function VictimRow({ id }: { id: PlayerId }) {
  const view = useDialogView();
  const me = useUI((s) => s.me);
  const p = view.players[id];
  const a = session.avatars[id] ?? -1;
  // (With Oil: their oil is in plain sight, and may be named instead, where you have room for it.)
  const oil = canTakeOil(view, me, id);
  // (Only the cards a robber can take at random: oil and commodities are named, or not stealable.)
  const held = stealableCount(view, id);
  const random = held > 0;
  return (
    <div className="response" style={{ ['--pc' as string]: PLAYER_PALETTE[p.color].ui }}>
      <span className="response-face">
        <AvatarFace code={a} name={p.name} color={p.color} />
      </span>
      <div>
        <b>{p.name}</b>
        <div className="response-status">
          Holds {held} card{held === 1 ? '' : 's'}
        </div>
      </div>
      {random && (
        <button className="btn gold small" onClick={() => !session.act({ type: 'steal', victim: id }) && close()}>
          Rob
        </button>
      )}
      {oil && (
        <button className="btn ghost small" onClick={() => !session.act({ type: 'steal', victim: id, oil: true }) && close()}>
          Take oil
        </button>
      )}
    </div>
  );
}

// -------------------------------------------------------- invention / monopoly

/**
 * The oil an Invention or a Hoarder may name (Oil): the moves the engine offers for it, which
 * play the same card. Empty in a game without oil, or while you have no room for more.
 */
function useOilPlays() {
  const view = useDialogView();
  const me = useUI((s) => s.me);
  return useMemo(() => {
    const legal = view.ext.oil ? legalActions(view, me) : [];
    return {
      invention: legal.filter((a): a is Extract<Action, { type: 'oil/invention' }> => a.type === 'oil/invention'),
      monopoly: legal.some((a) => a.type === 'oil/monopoly'),
    };
  }, [view, me]);
}

/** A dialog wide enough for six cards in a row (the resources and oil), where the window has room. */
const SIX_CARDS = 660;

function InventionModal() {
  const bank = useBank();
  const oil = useOilPlays().invention;
  const [picks, setPicks] = useState<Card[]>([]);
  // (Resources as the engine counts them; with oil among the picks, the count its oil move asks.)
  const resources = RESOURCES.reduce((n, r) => n + bank[r], 0);
  const naming = picks.includes('oil');
  const want = naming && oil.length ? oil[0].cards.length : Math.min(2, resources);
  const kinds: Card[] = oil.length ? [...RESOURCES, 'oil'] : [...RESOURCES];
  const count = (r: Card) => picks.filter((x) => x === r).length;
  // A card may be added if some way of playing the card still has room for it (a full pick has none).
  const fits = (r: Card) => {
    const next = [...picks, r];
    if (next.includes('oil')) return oil.some((a) => CARDS.every((k) => next.filter((x) => x === k).length <= a.cards.filter((x) => x === k).length));
    return next.length <= Math.min(2, resources) && bank[r] > count(r);
  };
  const add = (r: Card) => fits(r) && setPicks([...picks, r]);
  const remove = (r: Card) => {
    const i = picks.lastIndexOf(r);
    if (i >= 0) setPicks(picks.filter((_, j) => j !== i));
  };
  const move = inventionMove(picks, oil);
  const take = () => move && !session.act(move) && close();
  return (
    <Modal onClose={close} width={kinds.length > 5 ? SIX_CARDS : undefined}>
      <h3>Invention</h3>
      <p className="sub">
        Take any {want} cards from the supply (doubles allowed){oil.length ? `, oil among them while you have room for it (${OIL_LIMIT} at most)` : ''}.
      </p>
      <div className="picker">
        {kinds.map((r) => (
          <div key={r} className="pick-col">
            <button type="button" className={`pick-card ${count(r) ? 'selected' : ''}`} aria-label={`Take ${CARD_NAMES[r]}${count(r) ? ` (${count(r)} chosen)` : ''}`} disabled={!fits(r)} onClick={() => add(r)}>
              <ResourceCard resource={r} />
            </button>
            {/* Each card picked can be put back on its own. */}
            <div className="pick-count">
              {count(r) > 0 && (
                <>
                  <span aria-hidden>×{count(r)}</span>
                  <button type="button" className="pick-less" aria-label={`One ${CARD_NAMES[r]} fewer`} onClick={() => remove(r)}>
                    <MinusIcon />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="footer">
        <button className="btn ghost bare" disabled={picks.length === 0} onClick={() => setPicks([])}>
          <LineIcon name="undo" size={18} />
          Clear
        </button>
        <span className="footer-gap" aria-hidden />
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn gold" disabled={picks.length !== want || !move} onClick={take}>
          Take cards
        </button>
      </div>
    </Modal>
  );
}

function MonopolyModal() {
  const [pick, setPick] = useState<Card | null>(null);
  const oil = useOilPlays().monopoly;
  const kinds: Card[] = oil ? [...RESOURCES, 'oil'] : [...RESOURCES];
  const claim = () => pick && !session.act(monopolyMove(pick)) && close();
  return (
    <Modal onClose={close} width={kinds.length > 5 ? SIX_CARDS : undefined}>
      <h3>Hoarder</h3>
      <p className="sub">
        Name a resource{oil ? ' or oil' : ''}: the others hand over all they hold of it{oil ? ` (oil as far as you have room for it, ${OIL_LIMIT} at most, one from each in turn)` : ''}.
      </p>
      <div className="picker">
        {kinds.map((r) => (
          <button type="button" key={r} className={`pick-card ${pick === r ? 'selected' : ''}`} aria-pressed={pick === r} aria-label={CARD_NAMES[r]} onClick={() => setPick(r)}>
            <ResourceCard resource={r} />
          </button>
        ))}
      </div>
      <div className="footer">
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn gold" disabled={!pick} onClick={claim}>
          {/* (The name morphs from one kind to the next as they're tried.) */}
          <Morph>{pick ? `Claim all ${CARD_NAMES[pick]}` : 'Claim all'}</Morph>
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- player trade

/** The last offer you made this game, to start the next one from (and, online, whom it went to and when). */
let lastOffer: { game: unknown; give: CardCounts; get: CardCounts; to: PlayerId[]; turn: number } | null = null;

/** An offer made (again) from elsewhere than the dialog: the one to start the next from. */
export function keepOffer(o: { give: CardCounts; get: CardCounts; to: PlayerId[]; turn: number }) {
  lastOffer = { game: session.host, ...o };
}

/** The offer you made last in this game, to make again at your next turn (online: see Overlays' Offer again). */
export function keptOffer(): { give: CardCounts; get: CardCounts; to: PlayerId[]; turn: number } | null {
  return lastOffer && lastOffer.game === session.host ? { give: lastOffer.give, get: lastOffer.get, to: lastOffer.to, turn: lastOffer.turn } : null;
}

/** At most what you hold, of each kind. */
const clip = (rc: CardCounts, hand: CardCounts) => Object.fromEntries(CARDS.map((r) => [r, Math.min(rc[r], hand[r])])) as CardCounts;

/**
 * Trading, in one dialog: with the other players, or with the supply (and your harbours). Its tabs
 * are the two dialogs the shortcuts open (T and B), so either key lands on its tab and a tab
 * switches without the dialog closing.
 */
function TradeDialog() {
  const tab = useUI((s) => (s.modal === 'bank' ? 'supply' : 'players'));
  return (
    <Modal onClose={close} width={680}>
      <h3>Trade</h3>
      <Tabs
        idBase="trade"
        label="Trade with"
        value={tab}
        onChange={(t) => useUI.getState().set({ modal: t === 'supply' ? 'bank' : 'trade' })}
        items={[
          { id: 'players', label: 'Players', icon: 'crew' },
          { id: 'supply', label: 'Supply', icon: 'anchor' },
        ]}
      />
      <TabPanel page={tab} idBase="trade" tab={tab} className="trade-panel">
        {tab === 'players' ? <PlayersTrade /> : <SupplyTrade />}
      </TabPanel>
    </Modal>
  );
}

function PlayersTrade() {
  const view = useDialogView();
  const me = useUI((s) => s.me);
  const hand = useHand(me);
  const bank = useBank();
  const remembered = lastOffer && lastOffer.game === session.host ? lastOffer : null;
  const [give, setGive] = useState<CardCounts>(() => (remembered ? clip(remembered.give, hand) : emptyCounts()));
  const [get, setGet] = useState<CardCounts>(() => (remembered ? { ...remembered.get } : emptyCounts()));
  // Online, whom it goes to: everyone (none picked), or only those picked.
  const online = useUI((s) => s.online !== null);
  const glass = useUI((s) => s.settings.look === 'glass');
  const [to, setTo] = useState<PlayerId[]>(() => (online && remembered ? remembered.to.filter((p) => p !== me && view.players[p]) : []));
  const offer = view.trade && view.trade.proposer === me ? view.trade : null;
  // (Asking for nothing is an open offer: the others bid for what you put up.)
  const asking = totalCards(get) === 0;
  const valid = totalCards(give) > 0 && CARDS.every((r) => give[r] === 0 || get[r] === 0);
  const empty = totalCards(give) === 0 && totalCards(get) === 0;
  const open = !!offer && isOpenOffer(offer);
  // Only those the offer went to answer it.
  const others = view.players.filter((p) => p.id !== me && (!offer || offer.to.length === 0 || offer.to.includes(p.id)));
  const reduce = useReducedMotionConfig();
  const price = !offer && valid && !asking ? supplyPrice(tradeRatios(view, me), hand, bank, give, get) : null;
  const propose = () => {
    lastOffer = { game: session.host, give, get, to, turn: view.turn };
    session.act({ type: 'offerTrade', give, get, ...(to.length > 0 && { to }) });
  };
  const toSupply = () => {
    if (!price) return;
    presetSupply({ give: price.pay, get: price.get, times: price.times });
    useUI.getState().set({ modal: 'bank' });
  };
  return (
    <>
      {(offer || !glass) && <p className="sub">
        {offer
          ? open
            ? 'Your cards are up: take the bid you like best.'
            : 'Your offer is out: trade with whoever accepts, or take a counter-offer.'
          : `Tap your cards to put them up, then what you want for them${online ? ', and who it goes to' : ''}. Ask for nothing, and the others bid.`}
      </p>}
      {!offer && online && <OfferTo me={me} to={to} onTo={setTo} />}
      {!offer ? (
        <CardDeal give={give} get={get} onGive={setGive} onGet={setGet} kinds={cardKinds(view)} mine={hand} open pick={glass} />
      ) : (
        <OfferSummary give={offer.give} get={offer.get} mine />
      )}
      {/* The same cards from the supply (or a harbour), for comparison, where it can sell them. */}
      {price && (
        <div className={`supply-alt${price.cheaper ? ' better' : ''}`}>
          <span>
            {price.cheaper ? 'The supply does this for no more: ' : 'From the supply instead: '}
            <b>
              {price.count} {CARD_NAMES[price.pay]}
            </b>{' '}
            for {price.times} {CARD_NAMES[price.get]} ({price.ratio}:1{price.ratio < 4 ? ', your harbour' : ''}).
          </span>
          {price.affordable && (
            <button type="button" className="btn ghost small" onClick={toSupply}>
              Trade with the supply
            </button>
          )}
        </div>
      )}
      {offer && (
        <div className="response-list">
          {others.map((p, i) => {
            const resp = offer.responses[p.id];
            const counter = offer.counters[p.id];
            const a = session.avatars[p.id] ?? -1;
            // Each answer has its colour: waiting plain, accepting green, a counter gold, declining muted.
            // (Either yes is taken with the same gold button.)
            const state = counter ? 'counter' : resp === 'accepted' ? 'accepted' : resp === 'rejected' ? 'declined' : 'waiting';
            return (
              <motion.div
                key={p.id}
                className={`response ${state}`}
                style={{ ['--pc' as string]: PLAYER_PALETTE[p.color].ui }}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.07, duration: 0.28, ease: [0.2, 0.8, 0.3, 1] }}
              >
                <span className="response-face">
                  <AvatarFace code={a} name={p.name} color={p.color} />
                </span>
                <div>
                  <b>{p.name}</b>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div key={state} className="response-status" initial={reduce ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.12 }}>
                      <StatusIcon state={state} />
                      {counter ? (
                        <>
                          {/* Who gives what, in so many words: their cards, for yours. */}
                          {open ? 'Bids' : 'Offers'} <ResChips rc={counter.give} /> for your <ResChips rc={counter.get} />
                        </>
                      ) : state === 'accepted' ? (
                        'Accepts your offer'
                      ) : state === 'declined' ? (
                        'Declines'
                      ) : (
                        'Considering'
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>
                <AnimatePresence initial={false}>
                  {counter ? (
                    <motion.button
                      key="counter"
                      className="btn gold small"
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      // (Out of reach: it says why, as the HUD's greyed buttons do.)
                      aria-disabled={CARDS.every((r) => hand[r] >= counter.get[r]) ? undefined : true}
                      title={CARDS.every((r) => hand[r] >= counter.get[r]) ? undefined : `You need ${shortfall(hand, counter.get)} more to accept this`}
                      onClick={() => (CARDS.every((r) => hand[r] >= counter.get[r]) ? !session.act({ type: 'acceptTrade', partner: p.id, counter: true }) && close() : explain(`You need ${shortfall(hand, counter.get)} more to accept this`))}
                    >
                      {open ? 'Take bid' : 'Accept counter'}
                    </motion.button>
                  ) : resp === 'accepted' ? (
                    <motion.button key="trade" className="btn gold small" initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} disabled={!CARDS.every((r) => hand[r] >= offer.give[r])} onClick={() => !session.act({ type: 'acceptTrade', partner: p.id }) && close()}>
                      Trade
                    </motion.button>
                  ) : (
                    <span key="none" />
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      )}
      {offer && <p className="setting-note trade-keep">Closing keeps your offer open: Offer trade brings the answers back.</p>}
      <div className="footer">
        {offer ? (
          <>
            {/* (Taking it back is the rarer move: quieter, and on its own at the start.) */}
            <button className="btn ghost bare" onClick={() => session.act({ type: 'cancelTrade' })}>
              <LineIcon name="undo" size={18} />
              Withdraw offer
            </button>
            <span className="footer-gap" aria-hidden />
            <button className="btn ghost" onClick={close}>
              Close, keep it open
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost bare" disabled={empty} onClick={() => (setGive(emptyCounts()), setGet(emptyCounts()))}>
              Clear
            </button>
            <span className="footer-gap" aria-hidden />
            {/* (Cancel, as Invention and Hoarder say: the draft goes with the dialog.) */}
            <button className="btn ghost" onClick={close}>
              Cancel
            </button>
            <button className="btn gold" disabled={!valid} title={valid ? undefined : 'Put up at least one card'} onClick={propose}>
              <LineIcon name="send" size={18} />
              <Morph>{valid && asking ? 'Ask for bids' : 'Offer trade'}</Morph>
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Online, whom an offer goes to: everyone at the table (as when nobody is picked), or only the
 * players picked. A face each, pressed when picked; everyone again with one tap.
 */
function OfferTo({ me, to, onTo }: { me: PlayerId; to: PlayerId[]; onTo: (to: PlayerId[]) => void }) {
  const players = useUI((s) => s.view?.players) ?? [];
  const others = players.filter((p) => p.id !== me);
  const all = to.length === 0 || to.length === others.length;
  const tap = (p: PlayerId) => {
    sfx.play('click');
    const next = to.includes(p) ? to.filter((x) => x !== p) : [...to, p];
    // (Everyone picked is everyone: the offer goes to the table.)
    onTo(next.length === others.length ? [] : next.sort());
  };
  return (
    <div className="offer-to" role="group" aria-label="Offer to">
      <span className="offer-to-label" aria-hidden>
        Offer to
      </span>
      <button type="button" className={`chip-btn offer-to-all${all ? ' on' : ''}`} aria-pressed={all} onClick={() => (sfx.play('click'), onTo([]))}>
        Everyone
      </button>
      {others.map((p) => {
        const on = !all && to.includes(p.id);
        return (
          <button key={p.id} type="button" className={`offer-to-face${on ? ' on' : ''}`} style={{ ['--pc' as string]: PLAYER_PALETTE[p.color].ui }} aria-pressed={on} aria-label={`Only to ${p.name}${on ? ' (picked)' : ''}`} onClick={() => tap(p.id)}>
            <span className="response-face">
              <AvatarFace code={session.avatars[p.id] ?? -1} name={p.name} color={p.color} />
            </span>
            <span className="offer-to-name">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Online, your offer while it's out and its dialog closed: a card in the dock with a face for each
 * player it went to, showing their answer as it comes (considering, accepting, declining, a
 * counter), and the way back to the dialog to choose whom to trade with.
 */
export function OutgoingOffer() {
  const online = useUI((s) => s.online !== null);
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const modal = useUI((s) => s.modal);
  const offer = online && view?.trade && view.trade.proposer === me && !session.presenter?.spectating ? view.trade : null;
  const shown = offer && modal === null;
  const answers = offer && view ? view.players.filter((p) => p.id !== me && (offer.to.length === 0 || offer.to.includes(p.id))).map((p) => ({ p, state: offer.counters[p.id] ? ('counter' as const) : offer.responses[p.id] === 'accepted' ? ('accepted' as const) : offer.responses[p.id] === 'rejected' ? ('declined' as const) : ('waiting' as const) })) : [];
  const ready = answers.filter((a) => a.state === 'accepted' || a.state === 'counter').length;
  const said = { waiting: 'considering', accepted: 'accepts', declined: 'declines', counter: 'counters' };
  return (
    <AnimatePresence>
      {shown && (
        <motion.button
          key={offer.id}
          type="button"
          className="outgoing-offer parchment"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
          aria-label={`Your offer: ${describeCards(offer.give)} for ${describeCards(offer.get)}. ${answers.map((a) => `${a.p.name} ${said[a.state]}`).join(', ')}. Open it${ready ? ' to choose whom to trade with' : ''}`}
          onClick={() => (sfx.play('click'), useUI.getState().set({ modal: 'trade' }))}
        >
          <span className="oo-label" aria-hidden>
            Your offer
          </span>
          <span className="oo-cards" aria-hidden>
            <ResChips rc={offer.give} />
            <span className="os-swap">
              <LineIcon name="swap" size={16} />
            </span>
            <ResChips rc={offer.get} />
          </span>
          <span className="oo-faces" aria-hidden>
            {answers.map(({ p, state }) => (
              <span key={p.id} className={`oo-face ${state}`} style={{ ['--pc' as string]: PLAYER_PALETTE[p.color].ui }}>
                <AvatarFace code={session.avatars[p.id] ?? -1} name={p.name} color={p.color} />
                <StatusIcon state={state} />
              </span>
            ))}
          </span>
          {ready > 0 && (
            <span className="oo-go" aria-hidden>
              Choose
            </span>
          )}
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/** The human's answer to a bot's offer with different terms, which the bot then takes or leaves. */
function CounterModal() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const hand = useHand(me);
  const live = view?.trade && view.trade.proposer !== me ? view.trade : null;
  // Keep showing the last offer while the dialog animates out after it is withdrawn.
  const last = useRef(live);
  if (live) last.current = live;
  const offer = last.current;
  const [give, setGive] = useState<CardCounts>(() => {
    const g = emptyCounts();
    if (offer) for (const r of CARDS) g[r] = Math.min(offer.get[r], hand[r]);
    return g;
  });
  const [get, setGet] = useState<CardCounts>(() => (offer ? { ...offer.give } : emptyCounts()));
  const open = live !== null;
  useEffect(() => {
    if (!open) close();
  }, [open]);
  const glass = useUI((s) => s.settings.look === 'glass');
  if (!offer || !view) return null;
  const same = CARDS.every((r) => give[r] === offer.get[r] && get[r] === offer.give[r]);
  const valid =
    !same &&
    totalCards(give) > 0 &&
    totalCards(get) > 0 &&
    CARDS.every((r) => (give[r] === 0 || get[r] === 0) && give[r] <= hand[r]);
  const p = view.players[offer.proposer];
  // (An open offer asks what you'd give: your answer is a bid, not a change of terms.)
  const bid = isOpenOffer(offer);
  return (
    <Modal onClose={close} width={640}>
      <h3>{bid ? `Bid for ${p.name}'s cards` : `Counter ${p.name}'s offer`}</h3>
      <p className="sub">{bid ? `They put up ${describeCards(offer.give)}. Tap what you'd give for it.` : `They offered ${describeCards(offer.give)} for your ${describeCards(offer.get)}. Propose other terms.`}</p>
      <CardDeal give={give} get={get} onGive={setGive} onGet={setGet} kinds={cardKinds(view)} mine={hand} getLabel="You get" pick={glass} />
      <div className="footer">
        <button className="btn ghost" onClick={close}>
          Back
        </button>
        <button
          className="btn gold"
          disabled={!valid || busy}
          onClick={() => {
            sfx.play('click');
            if (!session.act({ type: 'counterTrade', give, get })) close();
          }}
        >
          {/* (It says what's missing until the terms differ, then what pressing does: one morphs into the other.) */}
          <Morph>{bid ? 'Send bid' : same ? 'Change the terms to counter' : 'Send counter'}</Morph>
        </button>
      </div>
    </Modal>
  );
}

/**
 * An offer's two sides, labelled from your point of view and coloured as everywhere in trading:
 * what you give warm, what you get green. `mine`: your own offer (else another player's to you).
 */
function OfferSummary({ give, get, mine = false }: { give: CardCounts; get: CardCounts; mine?: boolean }) {
  const yours = mine ? give : get, theirs = mine ? get : give;
  return (
    <div className="offer-summary">
      <div className="os-side give">
        <span className="os-lbl">You give</span>
        <ResChips rc={yours} />
      </div>
      <span className="os-swap" aria-hidden>
        <LineIcon name="swap" size={22} />
      </span>
      <div className="os-side get">
        <span className="os-lbl">You get</span>
        {totalCards(theirs) > 0 ? <ResChips rc={theirs} /> : <span className="os-open">{mine ? 'The best bid' : 'Your bid'}</span>}
      </div>
    </div>
  );
}

/** A player's answer to your offer, as a small coloured sign. */
function StatusIcon({ state }: { state: 'waiting' | 'accepted' | 'declined' | 'counter' }) {
  if (state === 'waiting')
    return (
      <span className="rs-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    );
  return (
    <span className={`rs-ico ${state}`} aria-hidden>
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === 'accepted' ? <path d="M2.5 6.2 5 8.6l4.5-5" /> : state === 'declined' ? <path d="M3.2 3.2l5.6 5.6M8.8 3.2 3.2 8.8" /> : <path d="M2 4.5h7.5L7.5 2.5M10 7.5H2.5l2 2" />}
      </svg>
    </span>
  );
}

/**
 * Incoming offers from other players (bots) that the human can answer. Left unanswered, one is
 * declined for you after the time set in Settings (or never, with no limit); with ten seconds to
 * go, a screen reader is told.
 */
export function IncomingOffer() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  // (Online the room's own clock declines for you, the same for everyone at the table: this
  // device's setting doesn't.)
  const seconds = useUI((s) => (s.online ? 0 : s.settings.offerTimer));
  // Paused whenever the toast can't be answered: a dialog (including Counter) is open, a
  // presentation is running, play is paused, or held while a quality preset is prepared.
  const blocked = useUI((s) => s.modal !== null || s.busy || s.paused || s.qualityProgress !== null);
  const spectating = !!session.presenter?.spectating;
  const hand = useHand(me);
  const offer = !spectating && view?.trade && view.trade.proposer !== me && (view.trade.to.length === 0 || view.trade.to.includes(me)) ? view.trade : null;
  const p = offer && view ? view.players[offer.proposer] : null;
  const responded = offer ? offer.responses[me] !== undefined || offer.counters[me] !== undefined : true;
  // The countdown belongs to one offer id, so a new offer can never inherit an expired timer.
  // It pauses while the pointer or keyboard focus is on the offer.
  const [timer, setTimer] = useState<{ id: number | null; left: number }>({ id: null, left: seconds });
  const [hold, setHoldState] = useState(false);
  // (The host's backstop, which declines for you a little after the toast would, holds with it:
  // see session.start. Without it, a pointer resting on the toast froze its count while the
  // backstop declined the offer anyway.)
  const setHold = (h: boolean) => {
    setHoldState(h);
    if (useUI.getState().offerHeld !== h) useUI.getState().set({ offerHeld: h });
  };
  const offerId = offer?.id ?? null;
  const timed = seconds > 0;
  useEffect(() => {
    if (offerId === null || responded) return;
    setTimer({ id: offerId, left: seconds });
  }, [offerId, responded, seconds]);
  // A pointer resting on the old toast as it vanished must not freeze the next one.
  useEffect(() => setHold(false), [offerId]);
  useEffect(() => {
    if (!timed || offerId === null || responded || hold || blocked) return;
    // (Nor does it run in a hidden tab.)
    const t = setInterval(() => !document.hidden && setTimer((x) => (x.id === offerId ? { ...x, left: x.left - 1 } : x)), 1000);
    return () => clearInterval(t);
  }, [offerId, responded, hold, blocked, timed]);
  const left = timer.id === offerId ? timer.left : seconds;
  useEffect(() => {
    if (!timed || offerId === null || responded || timer.id !== offerId) return;
    if (timer.left === 10 && p) useUI.getState().set({ announce: `${p.name}'s offer: 10 seconds left to answer` });
    if (timer.left <= 0) session.act({ type: 'respondTrade', accept: false });
  }, [timer, offerId, responded, timed]);
  // The tab icon shows the same countdown.
  const open = offerId !== null && !responded;
  useEffect(() => {
    useUI.getState().set({ offerClock: open ? { id: offerId, left: Math.max(0, left), total: timed ? seconds : 0 } : null });
  }, [open, offerId, left, timed, seconds]);
  useEffect(() => () => useUI.getState().set({ offerClock: null, offerHeld: false }), []);
  const canAccept = useMemo(() => !!offer && CARDS.every((r) => hand[r] >= offer.get[r]), [offer, hand]);
  return (
    <AnimatePresence>
      {offer && p && (
        <motion.div
          key={offer.id}
          className="offer-toast parchment"
          role="group"
          aria-label={`${p.name} offers a trade`}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 30 }}
          style={{ borderColor: PLAYER_PALETTE[p.color].ui }}
          onPointerEnter={() => setHold(true)}
          onPointerLeave={() => setHold(false)}
          onFocus={() => setHold(true)}
          onBlur={() => setHold(false)}
        >
          <div className="offer-title">{isOpenOffer(offer) ? `${p.name} asks for bids` : `${p.name} offers a trade`}</div>
          <OfferSummary give={offer.give} get={offer.get} />
          {responded ? (
            <div className="offer-answered">{offer.counters[me] ? (isOpenOffer(offer) ? 'You bid — waiting for them…' : 'You countered — waiting for them…') : offer.responses[me] === 'accepted' ? 'You accepted — waiting for them…' : 'You declined.'}</div>
          ) : (
            <div className="footer">
              <button className="btn ghost small" disabled={busy} onClick={() => session.act({ type: 'respondTrade', accept: false })} aria-label={timed ? `Decline (declined for you in ${left} seconds)` : 'Decline'}>
                {timed ? (
                  <>
                    Decline · <Morph>{left}</Morph>s
                  </>
                ) : (
                  'Decline'
                )}
              </button>
              {isOpenOffer(offer) ? (
                <button className="btn gold small" disabled={busy} onClick={() => useUI.getState().set({ modal: 'counter' })}>
                  Make a bid
                </button>
              ) : (
                <>
                  <button className="btn ghost small" disabled={busy} onClick={() => useUI.getState().set({ modal: 'counter' })}>
                    Counter
                  </button>
                  <button className="btn gold small" disabled={busy || !canAccept} onClick={() => (sfx.play('click'), session.act({ type: 'respondTrade', accept: true }))}>
                    <LineIcon name="check" size={16} />
                    Accept
                  </button>
                </>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------- menu etc

function MenuModal() {
  const compact = useCompact();
  // Back from Settings or the rules opened here: the row that opened them takes the focus again.
  const [row] = useState(takeMenuRow);
  const online = useUI((s) => s.online);
  return (
    <Modal onClose={close} initialFocus={row ? `[data-row="${row}"]` : undefined}>
      {/* On desktop this is the door button's question; on phones the menu, with the toolbar,
          supply and log in it too. */}
      <h3>{compact ? 'Menu' : online ? 'Leave this table?' : 'Leave this game?'}</h3>
      <p className="sub">{online ? <OnlineMenuNote /> : 'Your game is saved as you play: Continue picks it up from the menu.'}</p>
      {compact && <MenuExtras />}
      {online && <OnlineMenuFooter />}
      {!online && (
        <div className="footer">
          <button className="btn ghost" onClick={() => void session.quitToTitle()}>
            <ExitIcon size={18} />
            Back to title
          </button>
          <span className="footer-gap" aria-hidden />
          <button className="btn gold" onClick={close}>
            Keep playing
          </button>
        </div>
      )}
    </Modal>
  );
}

/** Which of the leave sheet's questions is asked: leaving the table, or giving the game up. */
let leaveAsk: 'leave' | 'concede' = 'leave';

const askLeave = (what: 'leave' | 'concede') => {
  sfx.play('click');
  leaveAsk = what;
  useUI.getState().set({ modal: 'leave' });
};

/**
 * The menu's word online: the room keeps the game, so leaving the table isn't the end of it. A
 * game's seat goes to the crew until you're back; and conceding gives the seat up for good (each
 * asked first, saying what happens). Watching, or with the seat given up, leaving is only leaving.
 */
function useOnlineMenu() {
  const online = useUI((s) => s.online);
  const over = useUI((s) => s.view?.phase === 'gameOver');
  return { watching: !!online?.watch || !!session.presenter?.spectating, over };
}

function OnlineMenuNote() {
  const { watching, over } = useOnlineMenu();
  if (watching) return <>You’re watching: leave whenever you like.</>;
  if (over) return <>The game is over: its results stay with the room for a week.</>;
  return <>The room keeps the game. Leave, and the crew sails your seat until you’re back.</>;
}

function OnlineMenuFooter() {
  const { watching, over } = useOnlineMenu();
  // (Watching, or with the game over, leaving changes nothing: no need to ask.)
  const away = () => (watching || over ? void session.leaveTable() : askLeave('leave'));
  return (
    <div className="footer online-menu">
      {/* (Giving the game up is asked again, and is the rarest choice here: the quiet one, apart.) */}
      {!watching && !over && (
        <button className="btn ghost bare" onClick={() => askLeave('concede')}>
          <LineIcon name="flag" size={18} />
          Concede
        </button>
      )}
      <span className="footer-gap" aria-hidden />
      <button className="btn ghost" onClick={away}>
        <ExitIcon size={18} />
        Back to the menu
      </button>
      <button className="btn gold" onClick={close}>
        Keep playing
      </button>
    </div>
  );
}

/**
 * Asked before you leave a live table or give a game up, saying what happens: who sails your seat,
 * whether it can be taken back, and how ratings count it. Stay is the first thing focused, so a
 * key pressed by accident keeps you at the table.
 */
function LeaveModal() {
  const online = useUI((s) => s.online);
  const [what] = useState(() => leaveAsk);
  const [going, setGoing] = useState(false);
  const rated = !!online?.rated;
  const ratings = rated ? 'Ratings count it as last.' : 'This game isn’t rated; in a rated one it would count as last.';
  const go = () => {
    if (going) return;
    setGoing(true);
    sfx.play('click');
    if (what === 'leave') return void session.leaveTable();
    if (!session.concede()) {
      setGoing(false);
      return showError('Not connected just now, so that wasn’t sent. Try again in a moment.');
    }
    // (You stay to watch the crew sail your seat.)
    close();
  };
  const back = () => (sfx.play('click'), useUI.getState().set({ modal: 'menu' }));
  const [title, text, yes] =
    what === 'leave'
      ? ['Leave the table?', `The crew sails your seat from now on. Come back by the room’s link and Take the helm has it again. ${rated ? 'If the crew still has it at the end, ratings count it as last.' : ''}`, 'Leave the table']
      : ['Concede the game?', `The crew sails your seat to the end, and you can watch it from here. It can’t be taken back. ${ratings}`, 'Concede'];
  return (
    <Modal onClose={back} initialFocus=".leave-stay">
      <h3>{title}</h3>
      <p className="sub">{text.trim()}</p>
      <div className="footer">
        <button className="btn ghost leave-go" disabled={going} onClick={go}>
          {what === 'leave' ? <ExitIcon size={18} /> : <LineIcon name="flag" size={18} />}
          {yes}
        </button>
        <span className="footer-gap" aria-hidden />
        <button className="btn gold leave-stay" onClick={back}>
          Stay
        </button>
      </div>
    </Modal>
  );
}

function MenuExtras() {
  const muted = useUI((s) => s.muted);
  const paused = useUI((s) => s.paused);
  // (Pause is the solo game's: a watched or replayed game has its own controls.)
  const canPause = !!session.presenter && !session.presenter.spectating;
  const off = useUI((s) => s.cameraOffHome);
  const devLeft = useUI((s) => s.view?.devDeck.length ?? null);
  // (A game without development cards has no deck to count.)
  const devs = useUI((s) => (s.view ? devCardsInGame(s.view) : false));
  const hasLog = useUI((s) => s.log.length > 0);
  const bank = useBank();
  const income = useIncome();
  const extras = useSupplyExtras();
  const { all: earning, text: earned } = incomeLine(income);
  // (The set's own icons where it has them, as the toolbar shows them; the view's target is drawn here.)
  const glyph = (d: ReactNode) => (
    <svg className="line-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d}
    </svg>
  );
  return (
    <>
      <div className="menu-list">
        {canPause && (
          // (Its name says what pressing does, so no pressed state as well: "Carry on, pressed" read as paused twice over.)
          <button className="menu-row" onClick={() => (close(), session.setPaused(!paused))}>
            {paused ? glyph(<path d="M8 5v14l11-7z" />) : <LineIcon name="pause" size={20} />}
            {paused ? 'Carry on' : 'Pause'}
            <span className="menu-note">{paused ? 'Paused' : 'P'}</span>
          </button>
        )}
        <button className="menu-row" onClick={() => (close(), session.world?.rig.reset())}>
          {glyph(
            <>
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </>,
          )}
          Reset the view
          <span className="menu-note">{off ? 'Moved' : 'At home'}</span>
        </button>
        <button className="menu-row" data-row="rules" onClick={() => openFromMenu('rules')}>
          <LineIcon name="book" size={20} />
          How to play
        </button>
        <button className="menu-row" data-row="settings" onClick={() => openFromMenu('settings')}>
          <LineIcon name="gear" size={20} />
          Settings
        </button>
        {/* (Pressed while the sound is on: the row is "Sound", not "Mute".) */}
        <button className="menu-row" onClick={() => setMuted(!muted)} aria-pressed={!muted}>
          <LineIcon name={muted ? 'muted' : 'sound'} size={20} />
          Sound
          <span className="menu-note">
            <Morph>{muted ? 'Off' : 'On'}</Morph>
          </span>
        </button>
      </div>
      {devLeft !== null && (
        <section className="menu-section" aria-label="Supply">
          <h4>Supply</h4>
          <div className="menu-supply">
            {RESOURCES.map((r) => (
              <div key={r} className="bank-stack" role="img" aria-label={`${CARD_NAMES[r]} in supply: ${bank[r]}${earning > 0 ? `, about ${perRoll(income![r])} a roll for you` : ''}`}>
                <img src={asset(CARD_ICON[r])} alt="" draggable={false} />
                {bank[r]}
                <YieldPips per={earning > 0 ? income![r] : 0} />
              </div>
            ))}
            {devs && (
              <div className="bank-stack devdeck" role="img" aria-label={`Development cards left: ${devLeft}`}>
                <Icon name="devcard" size={24} />
                {devLeft}
              </div>
            )}
          </div>
          {/* (The commodities and oil, when they're in play, in a row of their own: the same stacks.) */}
          {extras.length > 0 && (
            <div className="menu-supply extra" role="group" aria-label="Commodities and oil in the supply">
              {extras.map((k) => (
                <div key={k} className="bank-stack" role="img" aria-label={`${CARD_NAMES[k]} in supply: ${bank[k]}${earning > 0 ? `, about ${perRoll(income![k])} a roll for you` : ''}`}>
                  <img src={asset(CARD_ICON[k])} alt="" draggable={false} />
                  {bank[k]}
                  <YieldPips per={earning > 0 ? income![k] : 0} />
                </div>
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
        </section>
      )}
      {hasLog && (
        <section className="menu-section" aria-label="Game log">
          <h4>Game log</h4>
          <div className="menu-log">
            <LogEntries limit={80} />
          </div>
        </section>
      )}
    </>
  );
}

/** Your development cards, to read and play (the compact HUD's Cards chip opens this). */
function DevCardsModal() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  // (Read as the dialog renders, so it follows the hand as cards are bought.)
  const buy = whyNot('dev');
  if (!view) return null;
  const groups = devGroups(view, me, busy);
  // (While a card can be played, its Play is the dialog's one gold button; Done steps back.)
  const playing = groups.some((g) => g.canPlay);
  return (
    <Modal onClose={close}>
      <h3>Development cards</h3>
      {groups.length === 0 ? (
        <p className="devcards-empty">None yet. One costs wool, wheat and ore: a Knight, Road Crew, Invention, Hoarder or a Victory Point.</p>
      ) : (
        <div className="devcards-list">
          {groups.map((g) => (
            <div key={g.type} className="devcards-item">
              <DevCard type={g.type} variant={g.count - 1} />
              {/* The card's rule at a size that reads (the card's own lettering is small). */}
              <p className="devcards-rule">
                {g.count > 1 ? `${g.count} × ` : ''}
                {DEV_TEXT[g.type]}
              </p>
              {g.canPlay ? (
                <button
                  className="btn gold"
                  aria-label={`Play ${DEV_NAMES[g.type]}: ${DEV_TEXT[g.type]}`}
                  onClick={() => {
                    // Its own dialog (Invention, Hoarder) replaces this one; the others play straight away.
                    if (g.type !== 'invention' && g.type !== 'monopoly') close();
                    playDev(g.type);
                  }}
                >
                  Play
                </button>
              ) : (
                <span className="setting-note">{devReason(view, me, busy, g)}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="footer">
        {/* (It stays open, so the card you bought is there to see in your hand.) */}
        <ReasonButton className="btn ghost" reason={buy} onClick={() => buyDevCard()}>
          Buy one
          {RESOURCES.flatMap((r) => Array.from({ length: COSTS.devCard[r] }, (_, i) => <img key={`${r}${i}`} className="ui-icon" width={16} height={16} src={asset(CARD_ICON[r])} alt={CARD_NAMES[r]} />))}
        </ReasonButton>
        <span className="footer-gap" aria-hidden />
        <button className={`btn ${playing ? 'ghost' : 'gold'}`} onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/**
 * Over a finished game's island after "View the island": the way back to the results. (Its
 * dialog is closed, so nothing else would bring it back.)
 */
export function ResultsReturn() {
  const show = useUI((s) => s.screen === 'game' && s.modal === null && s.view?.phase === 'gameOver');
  return (
    <AnimatePresence>
      {show && (
        <motion.div key="results" className="results-return" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }} transition={{ type: 'spring', duration: 0.35, bounce: 0 }}>
          <button className="btn gold" onClick={() => useUI.getState().set({ modal: 'gameover' })}>
            <LineIcon name="trophy" size={18} />
            Back to the results
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
