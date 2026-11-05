// The Wagon Trains auction, an end-of-turn step: each seat's bid of cards (each card a vote), the
// placements proposed, the ballot when nobody holds a majority, and who places the wagon; your
// bid, proposal, vote or placement when it's your turn in it; and where the wagon went once it's
// down. Every move is one legalActions lists (a bid is matched to the listed one with your amounts
// and proposal), and a proposal, a vote or a placement can be chosen on the board.

import { useEffect, useRef, useState } from 'react';
import type { Action, Card, CardCounts, GameState, PlayerId } from '../../engine';
import { useUI } from '../../game/store';
import { CARD_ICON, CARD_NAMES, asset } from '../../game/names';
import { edgePlace } from '../../game/hexView';
import { count, fromCurrent, legalOf, listOf } from '../../game/modulePanels';
import { bidKinds, proposals, recentAuction } from '../../engine/modules/caravans/auction';
import type { Auction, AuctionResult } from '../../engine/modules/caravans/types';
import { ReasonButton } from '../Hud';
import { Morph } from '../Morph';
import { explain } from '../why';
import { act, endPick, nameOf, PaceSwitch, previewSpots, Seat, setSetting, startPick, usePicking, useWatching } from './shared';
import { session } from '../../app/session';
import { reducedMotion } from '../../app/display';
import { CloseIcon } from '../LineIcons';

/** Light a wagon's edge and glance the camera over to it, so one placed out of view is seen (not with motion reduced). */
function showEdge(s: GameState, edge: number) {
  previewSpots('edge', [edge]);
  const e = s.board.edges[edge];
  const a = s.board.vertices[e.a], b = s.board.vertices[e.b];
  if (!reducedMotion()) void session.world?.rig.focusOn((a.x + b.x) / 2, (a.z + b.z) / 2, 2.4);
}

type BidAction = Extract<Action, { type: 'caravans/bid' }>;

const LETTERS = 'ABCDEFGH';

/** A placement's letter in the auction's list of proposals. */
const letterOf = (a: Auction, edge: number) => LETTERS[proposals(a).indexOf(edge)] ?? '?';

/** A bid in words: "2 brick and 1 wood". */
function bidText(s: GameState, cards: CardCounts): string {
  return listOf(bidKinds(s).filter((k) => cards[k] > 0).map((k) => `${cards[k]} ${CARD_NAMES[k].toLowerCase()}`));
}

/** Who places the wagon and why, worked out from the bids as the engine settles it. */
function placerWhy(s: GameState, a: Auction, me: PlayerId): string {
  const who = nameOf(s, a.queue[0], me);
  const total = a.bids.reduce((n, b) => n + b.votes, 0);
  if (total === 0) return `Nobody bid: ${who} ${a.queue[0] === me ? 'place' : 'places'} it anywhere it can go`;
  if (a.bids.some((b) => 2 * b.votes > total)) return `${who} ${a.queue[0] === me ? 'hold' : 'holds'} a majority and ${a.queue[0] === me ? 'place' : 'places'} it anywhere`;
  return `The vote tied: ${who} ${a.queue[0] === me ? 'choose' : 'chooses'} among the tied spots`;
}

/** One seat's part in the auction so far. */
function seatLine(s: GameState, a: Auction, p: PlayerId, me: PlayerId): string {
  const bid = a.bids.find((b) => b.player === p);
  const acting = a.queue[0] === p;
  if (a.stage === 'bids') {
    if (bid) return `${bidText(s, bid.cards)} · ${count(bid.votes, 'vote')}${bid.proposal !== null ? ` · proposes ${letterOf(a, bid.proposal)}` : ''}`;
    if (acting) return p === me ? 'your bid' : 'bidding…';
    return a.queue.includes(p) ? 'to bid' : 'passed';
  }
  if (!bid) return 'passed';
  const votes = count(bid.votes, 'vote');
  if (a.stage === 'ballots') {
    if (bid.ballot !== null) return `${votes} behind ${letterOf(a, bid.ballot)}`;
    return acting ? (p === me ? `your ${votes} to cast` : `casting ${votes}…`) : `${votes} to cast`;
  }
  return `${votes}${bid.ballot !== null ? ` behind ${letterOf(a, bid.ballot)}` : ''}`;
}

/** A stepper for one kind of card in a bid: its icon, less, how many of how many held, more. */
/** `locked`: the amount is fixed while a spot for the wagon is being picked (the pick was offered for this bid). */
function Amount({ card, n, max, onChange, locked = false }: { card: Card; n: number; max: number; onChange: (n: number) => void; locked?: boolean }) {
  const label = CARD_NAMES[card];
  return (
    <div className="ca-amount" role="group" aria-label={`${label} to bid: ${n} of ${max}`}>
      <img src={asset(CARD_ICON[card])} alt="" draggable={false} title={label} />
      <button type="button" className="icon-btn small" aria-label={`One ${label.toLowerCase()} less`} disabled={locked || n <= 0} onClick={() => onChange(n - 1)}>
        −
      </button>
      <span className="ca-n">
        {n}
        <small>/{max}</small>
      </span>
      <button type="button" className="icon-btn small" aria-label={`One ${label.toLowerCase()} more`} disabled={locked || n >= max} onClick={() => onChange(n + 1)}>
        +
      </button>
    </div>
  );
}

/** Your bid: amounts of the two kinds, then a bid as it stands, a bid with a proposal (a pick on the board), or a pass. */
function BidControls({ s, me, busy }: { s: GameState; me: PlayerId; busy: boolean }) {
  const [x, y] = bidKinds(s);
  const hand = s.players[me].hand;
  const [amounts, setAmounts] = useState<[number, number]>([0, 0]);
  const picking = usePicking();
  // (Cards traded or spent since keep the amounts within the hand.)
  const nx = Math.min(amounts[0], hand[x]);
  const ny = Math.min(amounts[1], hand[y]);
  const votes = nx + ny;
  const bids = legalOf<BidAction>(s, me, 'caravans/bid', (a) => a.cards[x] === nx && a.cards[y] === ny);
  const plain = bids.find((a) => a.proposal === undefined || a.proposal === null);
  const proposing = bids.filter((a) => typeof a.proposal === 'number');
  const pass = legalOf(s, me, 'caravans/pass')[0];
  const proposeLabel = 'Propose where the wagon goes';
  const wait = busy ? 'Wait for the last move to finish' : null;
  const none = votes === 0 ? 'Choose at least one card to bid, or pass' : null;
  const autoPass = useUI((st) => st.settings.autoPassWagon);
  return (
    <div className="ca-controls">
      <div className="ca-amounts">
        <Amount card={x} n={nx} max={hand[x]} locked={picking === proposeLabel} onChange={(n) => setAmounts([n, ny])} />
        <Amount card={y} n={ny} max={hand[y]} locked={picking === proposeLabel} onChange={(n) => setAmounts([nx, n])} />
      </div>
      <div className="mp-buttons">
        <ReasonButton className="btn small gold" reason={wait ?? none ?? (plain ? null : 'That bid is not open to you')} onClick={() => act(plain!)} aria-label={`Bid ${count(votes, 'card')}, proposing nothing`}>
          Bid {votes}
        </ReasonButton>
        <ReasonButton
          className={`btn small${picking === proposeLabel ? ' on' : ''}`}
          reason={wait ?? none ?? (proposing.length ? null : 'There is nowhere to propose')}
          aria-pressed={picking === proposeLabel ? true : undefined}
          aria-label={picking === proposeLabel ? 'Cancel proposing' : `Bid ${count(votes, 'card')} and propose where the wagon goes, on the board`}
          onClick={() => (picking === proposeLabel ? endPick() : startPick(proposeLabel, 'edge', proposing, `Bid ${count(votes, 'vote')} and propose a spot: choose a glowing edge`))}
        >
          <Morph>{picking === proposeLabel ? 'Cancel' : `Bid ${votes}, propose…`}</Morph>
        </ReasonButton>
        <ReasonButton className="btn small ghost" reason={wait ?? (pass ? null : 'You cannot pass now')} onClick={() => act(pass)}>
          Pass
        </ReasonButton>
      </div>
      {/* (A pacing default: game/pacing.ts. Settings › Play holds it too.) */}
      <PaceSwitch label="Pass for me when the wagon can’t reach my pieces" checked={autoPass} onChange={(autoPassWagon) => setSetting({ autoPassWagon })} />
    </div>
  );
}

/** Your ballot: back one of the proposed placements (from the list, or on the board). */
function VoteControls({ s, me, a, busy }: { s: GameState; me: PlayerId; a: Auction; busy: boolean }) {
  const votes = legalOf<Extract<Action, { type: 'caravans/vote' }>>(s, me, 'caravans/vote');
  const mine = a.bids.find((b) => b.player === me);
  const picking = usePicking();
  const label = 'Back a proposed placement';
  const press = (x: Action) => (busy ? explain('Wait for the last move to finish') : act(x));
  return (
    <div className="ca-controls">
      <p className="mp-body">Put your {count(mine?.votes ?? 0, 'vote')} behind one placement.</p>
      <div className="mp-buttons column">
        {votes.map((v) => (
          <button key={v.edge} type="button" className="btn small" onClick={() => press(v)} onMouseEnter={() => previewSpots('edge', [v.edge])} onMouseLeave={() => previewSpots(null)} onFocus={() => previewSpots('edge', [v.edge])} onBlur={() => previewSpots(null)}>
            {letterOf(a, v.edge)}: {edgePlace(s, v.edge)}
          </button>
        ))}
        <button type="button" className={`btn small ghost${picking === label ? ' on' : ''}`} aria-pressed={picking === label} onClick={() => (picking === label ? endPick() : startPick(label, 'edge', votes))}>
          <Morph>{picking === label ? 'Cancel' : 'Choose on the board'}</Morph>
        </button>
      </div>
    </div>
  );
}

/** The wagon is yours to place: on the board (among the tied spots after a tied vote). */
function PlaceControls({ s, me }: { s: GameState; me: PlayerId }) {
  const places = legalOf<Extract<Action, { type: 'caravans/place' }>>(s, me, 'caravans/place');
  const picking = usePicking();
  const label = 'Place the wagon';
  return (
    <div className="mp-buttons">
      <button type="button" className={`btn small gold${picking === label ? ' on' : ''}`} aria-pressed={picking === label} onClick={() => (picking === label ? endPick() : startPick(label, 'edge', places, 'Place the wagon: choose a glowing edge'))}>
        <Morph>{picking === label ? 'Cancel' : `Choose its spot (${places.length})`}</Morph>
      </button>
    </div>
  );
}

/**
 * The result of the auction just closed, read off the state (the engine keeps it, so a game
 * resumed from a save tells it too), and a way to put it away until the next auction.
 */
function useResult(view: GameState | null): [AuctionResult | null, () => void] {
  // (An auction a turn at most, so its turn and wagon name the one closed.)
  const [closed, setClosed] = useState<string | null>(null);
  const result = view ? recentAuction(view) : null;
  const key = result ? `${result.turn}:${result.edge}` : null;
  return [result && key !== closed ? result : null, () => setClosed(key)];
}

/** How long the wagon's news stays up, unless the pointer or focus is on it. */
const NEWS_MS = 9000;

/**
 * Where the wagon went, as news rather than a panel: a line in the dock's dark glass, under the
 * decisions and over the turn's buttons, that shows the spot on the board and goes by itself (the
 * log keeps the line for good).
 */
export function WagonNews() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const [result, dismiss] = useResult(view);
  const [held, setHeld] = useState(false);
  const close = useRef(dismiss);
  close.current = dismiss;
  const key = result ? `${result.turn}:${result.edge}` : null;
  useEffect(() => {
    if (!key || held) return;
    const t = setTimeout(() => (previewSpots(null), close.current()), NEWS_MS);
    return () => clearTimeout(t);
  }, [key, held]);
  const st = view?.ext.caravans;
  if (!view || !st || st.auction || !result) return null;
  const paid = result.bids.filter((b) => b.votes > 0);
  const who = result.by === null ? 'The votes placed the wagon' : `${nameOf(view, result.by, me)} placed the wagon`;
  const where = edgePlace(view, result.edge);
  const bids = paid.length ? `The bids went to the supply: ${listOf(paid.map((b) => `${nameOf(view, b.player, me)} ${bidText(view, b.cards)}`))}.` : 'Nobody bid.';
  const show = () => previewSpots('edge', [result.edge]);
  const hide = () => previewSpots(null);
  return (
    <div
      className="dock-news"
      // (No live region of its own: it sits in the HUD a dialog makes inert, and the placing is
      // read out from the game log, which lives outside it.)
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <p className="dock-news-text" title={`${who} ${where}. ${bids}`}>
        <b>{who}</b> {where} <span className="dock-news-aside">· {count(st.supply, 'wagon')} left</span>
        <span className="sr-only"> {bids}</span>
      </p>
      <button type="button" className="dock-news-btn" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onClick={() => showEdge(view, result.edge)}>
        Show it
      </button>
      <button type="button" className="dock-news-btn close" aria-label="Close the wagon’s news" onClick={() => (hide(), dismiss())}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

/** The wagon auction while it runs: the bids, the proposals, the ballot, and your part in it. */
export function CaravansAuction() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const watching = useWatching();
  const st = view?.ext.caravans;
  if (!view || !st?.auction) return null;
  const a = st.auction;
  const auction = a;
  const owed = !watching && auction.queue[0] === me && view.pending[view.pending.length - 1]?.players.includes(me);
  const total = auction.bids.reduce((n, b) => n + b.votes, 0);
  const offered = proposals(auction);
  const [x, y] = bidKinds(view);
  const stage = auction.stage === 'bids' ? 'Bids' : auction.stage === 'ballots' ? 'Ballot' : 'Placing';
  return (
    <div className={`mp-decision parchment caravans-auction live${owed ? ' owed' : ''}`} role="group" aria-label={`Wagon auction: ${stage.toLowerCase()}`}>
      <div className="mp-head">
        <span className="mp-title">Wagon auction</span>
        <span className="mp-stage">{stage}</span>
        <span className="mp-aside" role="img" aria-label={`${count(st.supply, 'wagon')} left`}>
          {st.supply} left
        </span>
      </div>
      <p className="mp-sub">
        {auction.stage === 'bids'
          ? `${CARD_NAMES[x]} and ${CARD_NAMES[y].toLowerCase()}, a card a vote; a majority places it. Bids are paid.`
          : auction.stage === 'ballots'
            ? `No majority of ${total}: each bidder backs a proposal.`
            : placerWhy(view, auction, me)}
      </p>
      {/* Your part first, so it stays in view when the panel has to scroll. */}
      {owed && auction.stage === 'bids' && <BidControls s={view} me={me} busy={busy} />}
      {owed && auction.stage === 'ballots' && <VoteControls s={view} me={me} a={auction} busy={busy} />}
      {owed && auction.stage === 'place' && <PlaceControls s={view} me={me} />}
      <ol className="ca-seats">
        {fromCurrent(view).map((p) => (
          <li key={p} className={auction.queue[0] === p ? 'acting' : undefined}>
            <Seat s={view} p={p} me={me} short />
            <span className="ca-line">{seatLine(view, auction, p, me)}</span>
          </li>
        ))}
      </ol>
      {/* (Your ballot lists the proposals itself.) */}
      {offered.length > 0 && !(owed && auction.stage === 'ballots') && (
        <ul className="ca-proposals" aria-label="Proposed placements">
          {offered.map((e) => {
            const behind = auction.bids.filter((b) => b.ballot === e).reduce((n, b) => n + b.votes, 0);
            return (
              <li key={e} tabIndex={0} onMouseEnter={() => previewSpots('edge', [e])} onMouseLeave={() => previewSpots(null)} onFocus={() => previewSpots('edge', [e])} onBlur={() => previewSpots(null)}>
                <b>{letterOf(auction, e)}</b> {edgePlace(view, e)}
                {auction.stage !== 'bids' && behind > 0 && <span className="ca-behind"> · {count(behind, 'vote')}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
