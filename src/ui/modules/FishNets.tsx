// Fisheries' page in the ledger: your fish tokens face up (the other seats' are face down, counted
// on their cards), the Soggy Boot and who may take it, and the five things fish buy, each a row
// whose buttons are its real choices (which blocker, whom to rob, which resource, which deck).
// Payment is chosen for you by the bots' own rule (`cheapestPay`: the least fish, then the most
// room freed), and the row says which tokens it takes, so no buy is ever a list of payments. The
// swap a full purse leaves you owing is a decision in the dock. Every button is a move that
// legalActions lists; a greyed one says why.

import { useState } from 'react';
import { RESOURCES, type Action, type GameState, type PlayerId, type Track } from '../../engine';
import { useUI } from '../../game/store';
import { CARD_ICON, CARD_NAMES, TOKEN_ICON, TRACK_ICON, asset } from '../../game/names';
import { TRACK_NAMES } from '../../game/tableWords';
import { decisionTitle } from '../../game/decisions';
import { count, legalOf, topOf } from '../../game/modulePanels';
import { cardChoices } from '../../engine/modules/fisheries/actions';
import { cheapestPay, fishOf, payments } from '../../engine/modules/fisheries/fish';
import { fishCosts, FISH_LIMIT, type FishBuy, type FisheriesAction, type Token } from '../../engine/modules/fisheries/types';
import { corsairHex } from '../../engine/modules/shared';
import { ReasonButton } from '../Hud';
import { ToSupply } from './ToSupply';
import { explain, whyNotNow } from '../why';
import { act, nameOf, Pips, Seat, useWatching } from './shared';

type Buy<K extends FishBuy | 'swap'> = Extract<FisheriesAction, { type: `fisheries/${K}` }>;

// (Taking a resource is a trade with the supply: it's on the trade dialog's Supply tab, beside the
// cards, and this page links there.)
const BUYS: FishBuy[] = ['blocker', 'steal', 'route', 'card'];

/** The same tokens, in any order. */
const samePay = (a: readonly Token[], b: readonly Token[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Why fish can't be spent now: they can before or after the roll, on your own turn, with nothing owed. */
const notNow = (s: GameState) => whyNotNow(s.phase === 'roll' ? 'roll' : 'main');

/** What a buy is called at this table (a ship goes with a road at sea; the guilds' ventures stand in for the cards). */
function buyName(s: GameState, buy: FishBuy): string {
  switch (buy) {
    case 'blocker':
      return s.ext.sea ? 'Send a blocker away' : 'Send the robber away';
    case 'steal':
      return 'Steal a card';
    case 'take':
      return 'Take a resource';
    case 'route':
      return s.ext.sea ? 'A free road or ship' : 'A free road';
    case 'card':
      return s.ext.guilds ? 'A free venture' : s.ext.invasion && cardChoices(s).includes('muster') ? 'A free muster card' : 'A free development card';
  }
}

/** Your tokens, highest first (as the engine keeps them), the ones a hovered buy would spend raised. */
function Tokens({ tokens, paying, boot }: { tokens: Token[]; paying: readonly Token[] | null; boot: boolean }) {
  // (Each paid value marks the first of its tokens not yet marked.)
  const marked = new Set<number>();
  for (const v of paying ?? []) {
    const i = tokens.findIndex((t, k) => t === v && !marked.has(k));
    if (i >= 0) marked.add(i);
  }
  const fish = fishOf(tokens);
  const label = tokens.length ? `Your fish tokens: ${tokens.join(', ')}, ${fish} fish` : 'You hold no fish tokens';
  return (
    <div className="fn-tokens" role="img" aria-label={`${label}${boot ? ', and the Soggy Boot' : ''}`}>
      {tokens.map((t, i) => (
        <span key={i} className={`fn-token${marked.has(i) ? ' paying' : ''}`}>
          <img src={asset(TOKEN_ICON.fish)} alt="" draggable={false} />
          <b>{t}</b>
        </span>
      ))}
      {boot && (
        <span className="fn-token boot">
          <img src={asset(TOKEN_ICON.boot)} alt="" draggable={false} />
        </span>
      )}
      {!tokens.length && !boot && <span className="mp-empty">No fish yet</span>}
    </div>
  );
}

/** The Soggy Boot: who holds it, and, if it's you, whom you may pass it to. */
function Boot({ s, me }: { s: GameState; me: PlayerId }) {
  const f = s.ext.fisheries!;
  if (f.boot === null) return <p className="mp-sub">The Soggy Boot is still in the water: whoever fishes it up needs a point more to win.</p>;
  if (f.boot !== me) return <p className="mp-sub">{nameOf(s, f.boot, me)} holds the Soggy Boot, and needs a point more to win.</p>;
  const passes = legalOf<Extract<Action, { type: 'fisheries/passBoot' }>>(s, me, 'fisheries/passBoot');
  return (
    <div className="fn-boot" role="group" aria-label="The Soggy Boot">
      <p className="mp-sub">
        You hold <b>the Soggy Boot</b>: you need a point more to win.
      </p>
      {passes.length > 0 ? (
        <div className="mp-buttons">
          {passes.map((a) => (
            <ReasonButton key={a.to} className="btn small ghost" reason={notNow(s)} onClick={() => act(a)} aria-label={`Pass the Soggy Boot to ${s.players[a.to].name}`}>
              Pass it to <Seat s={s} p={a.to} me={me} short />
            </ReasonButton>
          ))}
        </div>
      ) : (
        <p className="mp-sub">{s.currentPlayer === me ? 'Nobody with more points showing than you can take it.' : 'On your turn you may pass it to a player with more points showing.'}</p>
      )}
    </div>
  );
}

interface Choice {
  key: string;
  label: React.ReactNode;
  /** What the button says to a screen reader, when its label is an icon. */
  aria?: string;
  title?: string;
  action: Action | undefined;
  /** Why this choice is out when the buy itself could be made. */
  why: string;
}

/** One buy's choices, each paired with the move (at the page's payment) that makes it. */
function choicesOf(s: GameState, me: PlayerId, buy: FishBuy, pay: readonly Token[] | null): Choice[] {
  const legal = legalOf<Buy<typeof buy>>(s, me, `fisheries/${buy}`, (a) => !!pay && samePay(a.pay, pay));
  switch (buy) {
    case 'blocker': {
      const on = { robber: s.robberHex !== null, corsair: corsairHex(s) !== null };
      return (s.ext.sea ? (['robber', 'corsair'] as const) : (['robber'] as const)).map((b) => ({
        key: b,
        label: b === 'robber' ? 'The robber' : 'The corsair',
        aria: `Send the ${b} away`,
        action: (legal as Buy<'blocker'>[]).find((a) => a.blocker === b),
        why: on[b] ? 'Not right now' : `The ${b} is off the board`,
      }));
    }
    case 'steal': {
      const out: Choice[] = [];
      for (const p of s.players) {
        if (p.id === me) continue;
        const of = (legal as Buy<'steal'>[]).filter((a) => a.victim === p.id);
        out.push({ key: `${p.id}`, label: <Seat s={s} p={p.id} me={me} short />, aria: `Steal a card from ${p.name}`, action: of.find((a) => !a.oil), why: `${p.name} has no card to take` });
        // (Their oil is in plain sight, and may be named instead, where you have room for it.)
        const oil = of.find((a) => a.oil);
        if (oil) out.push({ key: `${p.id}-oil`, label: `${p.name.split(' ').slice(-1)[0]}’s oil`, aria: `Take ${p.name}’s oil`, action: oil, why: '' });
      }
      return out;
    }
    case 'take':
      return RESOURCES.map((r) => ({
        key: r,
        label: <img src={asset(CARD_ICON[r])} alt="" draggable={false} />,
        aria: `Take 1 ${CARD_NAMES[r].toLowerCase()}`,
        title: CARD_NAMES[r],
        action: (legal as Buy<'take'>[]).find((a) => a.resource === r),
        why: `The supply has no ${CARD_NAMES[r].toLowerCase()} left`,
      }));
    case 'route':
      return [{ key: 'route', label: 'Buy, then place it', action: legal[0], why: `You have nowhere to build ${s.ext.sea ? 'a road or ship' : 'a road'}` }];
    case 'card': {
      const decks = cardChoices(s);
      if (!decks.length) return [{ key: 'none', label: 'Buy', action: undefined, why: 'No cards are left to draw' }];
      return decks.map((d) => {
        const track = s.ext.guilds && d ? (d as Track) : null;
        return {
          key: d ?? 'deck',
          label: track ? (
            <>
              <img className="fn-icon" src={asset(TRACK_ICON[track])} alt="" draggable={false} />
              {TRACK_NAMES[track]}
            </>
          ) : (
            'Buy'
          ),
          aria: track ? `Draw a ${TRACK_NAMES[track]} venture` : undefined,
          action: (legal as Buy<'card'>[]).find((a) => a.deck === d),
          why: 'Not right now',
        };
      });
    }
  }
}

/** The tokens a payment takes, and what it overpays (no change is given). */
function payWords(pay: readonly Token[], cost: number): string {
  const over = fishOf(pay) - cost;
  return `pays ${pay.join(' + ')}${over > 0 ? `, ${over} over` : ''}`;
}

export function FishNets() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const watching = useWatching();
  // The buy under the pointer or focus: its payment is raised among your tokens.
  const [hover, setHover] = useState<FishBuy | null>(null);
  if (!view?.ext.fisheries) return null;
  const f = view.ext.fisheries;
  // (A seat's tokens are face down to everyone else; watching, there's no hand of yours to show.)
  const tokens = watching ? [] : f.tokens[me].filter((t) => t > 0);
  const fish = fishOf(tokens);
  const now = notNow(view);
  const pays = Object.fromEntries(BUYS.map((b) => [b, cheapestPay(payments(tokens, fishCosts(view)[b]))])) as Record<FishBuy, Token[] | null>;
  const left = f.supply.length;
  return (
    <div className="fish-nets">
      {!watching && (
        <>
          <div className="fn-head">
            <span className="ot-label">Your catch · {count(fish, 'fish', 'fish')}</span>
            <Pips n={tokens.length} max={FISH_LIMIT} label={`${tokens.length} of ${FISH_LIMIT} tokens held`} />
          </div>
          <Tokens tokens={tokens} paying={hover ? pays[hover] : null} boot={f.boot === me} />
        </>
      )}
      <Boot s={view} me={me} />
      {!watching && (
        <ul className="fn-buys" aria-label="What fish buy">
          {BUYS.map((buy) => {
            const cost = fishCosts(view)[buy];
            const pay = pays[buy];
            const short = pay ? null : `You need ${cost - fish} more fish`;
            const name = buyName(view, buy);
            return (
              <li key={buy} className="fn-buy" onMouseEnter={() => setHover(buy)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(buy)} onBlur={() => setHover(null)}>
                <div className="fn-buy-head">
                  <span className="fn-cost" role="img" aria-label={`${cost} fish`}>
                    <img src={asset(TOKEN_ICON.fish)} alt="" draggable={false} />
                    {cost}
                  </span>
                  <span className="fn-buy-name">{name}</span>
                  <small className="fn-pay">{pay ? payWords(pay, cost) : `${cost - fish} short`}</small>
                </div>
                <div className={`fn-choices ${buy}`} role="group" aria-label={`${name} for ${cost} fish`}>
                  {choicesOf(view, me, buy, pay).map((c) => (
                    <ReasonButton key={c.key} className={`btn small ghost fn-choice${buy === 'take' ? ' ot-res' : ''}`} reason={c.action ? null : (now ?? short ?? c.why)} onClick={() => act(c.action!)} aria-label={c.aria} title={c.title}>
                      {c.label}
                    </ReasonButton>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!watching && (
        <div className="fn-supply">
          <span className="fn-cost" role="img" aria-label={`${fishCosts(view).take} fish`}>
            <img src={asset(TOKEN_ICON.fish)} alt="" draggable={false} />
            {fishCosts(view).take}
          </span>
          <span className="fn-buy-name">Take a resource</span>
          <ToSupply>On the Supply tab</ToSupply>
        </div>
      )}
      <p className="mp-sub">
        A house by the lake or a fishing ground catches a token when its number comes up, a town two; {FISH_LIMIT} at most. {left ? `${count(left, 'token')} left in the water.` : 'The water is fished out until the spent tokens go back.'} Overpaying gives no change.
      </p>
    </div>
  );
}

/** Your nets full and more caught: throw one token back for a fresh draw, or keep them all. In the dock. */
export function FishSwap() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const watching = useWatching();
  if (!view?.ext.fisheries || watching) return null;
  const top = topOf(view, 'fisheries/swap');
  if (!top || !top.players.includes(me)) return null;
  const swaps = legalOf<Buy<'swap'>>(view, me, 'fisheries/swap');
  const tokens = view.ext.fisheries.tokens[me];
  const press = (a: Action) => (busy ? explain('Wait for the last move to finish') : act(a));
  const backs = swaps.filter((a) => a.give !== null).sort((a, b) => b.give! - a.give!);
  const keep = swaps.find((a) => a.give === null);
  return (
    <div className="mp-decision parchment owed fish-swap" role="group" aria-label={`${decisionTitle(view, top)}: throw back a token for a fresh draw, or keep all ${FISH_LIMIT}`}>
      <div className="mp-head">
        <span className="mp-title">{decisionTitle(view, top)}</span>
        <span className="mp-aside">Fisheries</span>
      </div>
      <p className="mp-body">You hold {FISH_LIMIT} tokens and caught more. Throw one back for a single fresh draw (once a turn), or keep them all.</p>
      <Tokens tokens={tokens} paying={null} boot={false} />
      <div className="mp-buttons">
        {backs.map((a) => (
          <button key={a.give} type="button" className="btn small ghost fn-choice" onClick={() => press(a)} aria-label={`Throw back a ${a.give}-fish token`}>
            Throw back
            <span className="fn-token small">
              <img src={asset(TOKEN_ICON.fish)} alt="" draggable={false} />
              <b>{a.give}</b>
            </span>
          </button>
        ))}
        {keep && (
          <button type="button" className="btn small ghost" onClick={() => press(keep)}>
            Keep them all
          </button>
        )}
      </div>
    </div>
  );
}

/** Whether fish buy anything for you right now (the phone's ledger button says so). */
export function fishToDo(s: GameState, me: PlayerId): boolean {
  return !!s.ext.fisheries && BUYS.some((b) => legalOf(s, me, `fisheries/${b}`).length > 0);
}
