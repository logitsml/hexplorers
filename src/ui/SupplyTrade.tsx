// The trade dialog's Supply tab: what you pay with, what the supply gives, built by tapping, as the
// Players tab is (ui/TradeParts.tsx). Cards pay at your best rate (a harbour's 2:1 or 3:1, the
// supply's 4:1); oil burns for two of a resource; coins buy a resource (two coins) or are earned
// by selling cards at your rate; fish buy a resource (four fish). A deal is one thing paid for one
// thing taken, so each is one move the engine already has: `bankTrade`, `sellForCoins`,
// `oil/burn`, `buyWithCoins` or `fisheries/take`. The oil, coin and fish deals are the ones the
// rules list (legalActions), so nothing is offered that the engine would refuse.

import { useState } from 'react';
import { cardKinds, tradeRatios, usesCoins, type Action, type Card } from '../engine';
import { useUI } from '../game/store';
import { session } from '../app/session';
import { holdingIcon, holdingName, tokensOf, type HoldingId } from '../game/holdings';
import { legalOf } from '../game/modulePanels';
import { cheapestPay, payments } from '../engine/modules/fisheries/fish';
import { fishCosts, type FisheriesAction } from '../engine/modules/fisheries/types';
import { useBank, useDialogView, useHand } from './hooks';
import { close } from './ModalFrame';
import { Deal, Palette, type TileSpec } from './TradeParts';
import { isTouch } from './useCompact';
import { supplyNeeds } from './advice';
import { LineIcon } from './LineIcons';

/** What pays: a card at your rate (oil: burned), coins, or fish. */
type Pay = Card | 'coin' | 'fish';
/** What's taken: a card, or coins for cards sold. */
type Take = Card | 'coin';

/** A deal to open the Supply tab on (the Players tab's "from the supply instead"). */
let preset: { give: Card; get: Card; times: number } | null = null;
export function presetSupply(p: { give: Card; get: Card; times: number }) {
  preset = p;
}

export function SupplyTrade() {
  const view = useDialogView();
  const me = useUI((s) => s.me);
  const hand = useHand(me);
  const bank = useBank();
  const [start] = useState(() => {
    const p = preset;
    preset = null;
    return p;
  });
  const [give, setGive] = useState<Pay | null>(start?.give ?? null);
  const [get, setGet] = useState<Take | null>(start?.get ?? null);
  const [times, setTimes] = useState(start?.times ?? 1);
  // Sea Glass: one grid, for whichever side was tapped (what you give, then what you get).
  const glass = useUI((s) => s.settings.look === 'glass');
  const [side, setSide] = useState<'give' | 'get'>(() => (start?.give ? 'get' : 'give'));

  const ratios = tradeRatios(view, me);
  const kinds = cardKinds(view);
  const coins = usesCoins(view);
  const tokens = tokensOf(view, me, true);
  const fishTokens = (view.ext.fisheries?.tokens[me] ?? []).filter((t) => t > 0);
  const fishPay = view.ext.fisheries ? cheapestPay(payments(fishTokens, fishCosts(view).take)) : null;
  const burns = legalOf<Extract<Action, { type: 'oil/burn' }>>(view, me, 'oil/burn');
  const buys = legalOf<Extract<Action, { type: 'buyWithCoins' }>>(view, me, 'buyWithCoins');
  const takes = fishPay ? legalOf<Extract<FisheriesAction, { type: 'fisheries/take' }>>(view, me, 'fisheries/take', (a) => [...a.pay].sort().join() === [...fishPay].sort().join()) : [];

  /** How many deals `pay` could make on its own (each special deal is one move: once at a time). */
  const payCap = (p: Pay): number => {
    if (p === 'coin') return buys.length ? 1 : 0;
    if (p === 'fish') return takes.length ? 1 : 0;
    if (p === 'oil') return burns.length ? 1 : 0;
    return Number.isFinite(ratios[p]) ? Math.floor(hand[p] / ratios[p]) : 0;
  };
  /** How many of `t` could be taken, paying nothing in particular yet. */
  const takeCap = (t: Take): number => (t === 'coin' ? (coins ? 99 : 0) : t === 'oil' ? 0 : bank[t]);
  /** How many times `p` buys `t` (0: it doesn't). */
  const pairCap = (p: Pay, t: Take): number => {
    if (p === t) return 0;
    if (p === 'coin') return t !== 'coin' && buys.some((a) => a.get === t) ? 1 : 0;
    if (p === 'fish') return t !== 'coin' && takes.some((a) => a.resource === t) ? 1 : 0;
    if (p === 'oil') return t !== 'coin' && burns.some((a) => a.get === t) ? 1 : 0;
    if (t === 'coin') return coins ? payCap(p) : 0;
    return t === 'oil' ? 0 : Math.min(payCap(p), bank[t]);
  };
  const cap = give && get ? pairCap(give, get) : give ? payCap(give) : get ? takeCap(get) : 0;
  const t = Math.max(1, Math.min(times, Math.max(cap, 1)));

  /** What paying `p` hands over, `n` times; what taking `k` brings, `n` times. */
  const paid = (p: Pay, n: number) => (p === 'coin' ? 2 * n : p === 'fish' ? (fishPay ? fishPay.reduce((a, b) => a + b, 0) : 4) * n : p === 'oil' ? n : ratios[p] * n);
  const brought = (k: Take, n: number) => (give === 'oil' && k !== 'coin' ? 2 * n : n);

  const pickGive = (p: Pay) => {
    if (give === p) return setTimes(Math.min(t + 1, cap));
    setGive(p);
    setTimes(1);
    if (get && !pairCap(p, get)) setGet(null);
  };
  const dropGive = () => (t > 1 ? setTimes(t - 1) : (setGive(null), setTimes(1)));
  const pickGet = (k: Take) => {
    if (get === k) return setTimes(Math.min(t + 1, cap));
    setGet(k);
    if (give && !pairCap(give, k)) setGive(null);
  };
  const dropGet = () => (t > 1 ? setTimes(t - 1) : (setGet(null), setTimes(1)));

  const deal: Action | null = (() => {
    if (!give || !get || cap < 1) return null;
    if (give === 'coin') return buys.find((a) => a.get === get) ?? null;
    if (give === 'fish') return takes.find((a) => a.resource === get) ?? null;
    if (give === 'oil') return burns.find((a) => a.get === get) ?? null;
    if (get === 'coin') return { type: 'sellForCoins', give, times: t };
    return { type: 'bankTrade', give, get, times: t };
  })();
  const trade = () => {
    if (deal) session.act(deal);
    setTimes(1);
  };

  // (With nothing you could pay, the line under the tabs says what it would take.)
  const payable = kinds.some((r) => payCap(r) > 0) || buys.length > 0 || takes.length > 0;
  const nm = (k: HoldingId) => holdingName(k).toLowerCase();
  const full = (on: boolean) => (on && t >= cap ? 'That’s as many as this deal can make' : null);
  const coinTk = tokens.find((tk) => tk.id === 'coin');
  const fishTk = tokens.find((tk) => tk.id === 'fish');
  const prisonerTk = tokens.find((tk) => tk.id === 'prisoner');

  // What pays: the cards at your rates, oil burned, coins, fish (and prisoners, which go back by themselves).
  const payTiles: TileSpec[] = [
    ...kinds.filter((r) => r !== 'oil' && Number.isFinite(ratios[r])).map((r): TileSpec => ({
      id: r,
      icon: holdingIcon(r),
      name: holdingName(r),
      sub: `have ${hand[r]}`,
      badge: `${ratios[r]}:1`,
      badgeClass: `r${ratios[r]}`,
      picked: give === r ? paid(r, t) : 0,
      off: payCap(r) < 1 ? `Takes ${ratios[r]} ${nm(r)}` : full(give === r),
    })),
    ...(kinds.includes('oil') ? [{ id: 'oil', icon: holdingIcon('oil'), name: 'Oil', sub: `have ${hand.oil}`, badge: '1 → 2', picked: give === 'oil' ? paid('oil', t) : 0, off: burns.length ? full(give === 'oil') : hand.oil ? 'No oil can be burned now' : 'You have no oil' }] : []),
    ...(coinTk ? [{ id: 'coin', icon: coinTk.icon, name: 'Coins', sub: `have ${coinTk.n}`, badge: '2 → 1', picked: give === 'coin' ? paid('coin', t) : 0, off: buys.length ? full(give === 'coin') : coinTk.n < 2 ? 'Takes 2 coins' : 'Coins buy no more this turn' }] : []),
    ...(fishTk ? [{ id: 'fish', icon: fishTk.icon, name: 'Fish', sub: `have ${fishTk.n}`, badge: '4 → 1', picked: give === 'fish' ? paid('fish', t) : 0, off: takes.length ? full(give === 'fish') : fishTk.n < 4 ? 'Takes 4 fish' : 'Fish buy nothing now' }] : []),
    ...(prisonerTk ? [{ id: 'prisoner', icon: prisonerTk.icon, name: 'Prisoners', sub: `have ${prisonerTk.n}`, badge: '3 → 1 pt', off: 'Every 3 prisoners go back for a point by themselves, when the raiders run out' }] : []),
  ];
  // What the supply gives: any card but oil, and coins for cards sold.
  const takeTile = (k: Take): TileSpec => {
    const taking = get === k;
    const why = (() => {
      if (k !== 'coin' && takeCap(k) < 1) return 'None left in the supply';
      if (give && !pairCap(give, k)) return give === k ? `You're paying with ${nm(k)}` : k === 'coin' ? 'Coins come from selling cards' : `${holdingName(give)} buy${give === 'oil' ? 's' : ''} resources only`;
      return full(taking);
    })();
    return k === 'coin'
      ? { id: k, icon: holdingIcon(k), name: 'Coins', sub: `have ${coinTk?.n ?? 0}`, badge: 'sell', picked: taking ? brought(k, t) : 0, off: why }
      : { id: k, icon: holdingIcon(k), name: holdingName(k), sub: `${bank[k]} left`, picked: taking ? brought(k, t) : 0, off: why };
  };
  const takeTiles: TileSpec[] = [...kinds.filter((r) => r !== 'oil').map(takeTile), ...(coins ? [takeTile('coin')] : [])];

  return (
    <>
      {glass ? (
        <>
          {!payable && <p className="sub">{supplyNeeds(kinds.filter((r) => r !== 'oil'), ratios)}</p>}
          <Deal
            giveLabel="You give"
            getLabel="You get"
            give={give ? [{ id: give, icon: holdingIcon(give), name: holdingName(give), n: paid(give, t) }] : []}
            get={get ? [{ id: get, icon: holdingIcon(get), name: holdingName(get), n: brought(get, t) }] : []}
            onTakeGive={dropGive}
            onTakeGet={dropGet}
            giveEmpty={isTouch() ? 'Tap to choose' : 'Choose…'}
            getEmpty={isTouch() ? 'Tap to choose' : 'Choose…'}
            active={side}
            onPick={setSide}
          />
          {side === 'give' ? (
            <Palette label="Choose what you give" tone="give" tiles={payTiles} onTap={(k) => (pickGive(k as Pay), !get && setSide('get'))} />
          ) : (
            <Palette label="Choose what you get" tone="get" tiles={takeTiles} onTap={(k) => pickGet(k as Take)} />
          )}
        </>
      ) : (
        <>
          <p className="sub">{payable ? 'Tap what you pay with, then what you take. Each tile shows your best rate.' : supplyNeeds(kinds.filter((r) => r !== 'oil'), ratios)}</p>
          <Deal
            giveLabel="You pay"
            getLabel="You take"
            give={give ? [{ id: give, icon: holdingIcon(give), name: holdingName(give), n: paid(give, t) }] : []}
            get={get ? [{ id: get, icon: holdingIcon(get), name: holdingName(get), n: brought(get, t) }] : []}
            onTakeGive={dropGive}
            onTakeGet={dropGet}
            giveEmpty="Tap what you pay with"
            getEmpty="Tap what you take"
          />
          <Palette label="Pay with · tap to add" tone="give" tiles={payTiles} onTap={(k) => pickGive(k as Pay)} />
          <Palette label="Take from the supply" tone="get" tiles={takeTiles} onTap={(k) => pickGet(k as Take)} />
        </>
      )}
      <div className="footer">
        <button className="btn ghost bare" disabled={!give && !get} onClick={() => (setGive(null), setGet(null), setTimes(1), setSide('give'))}>
          Clear
        </button>
        <span className="footer-gap" aria-hidden />
        <button className="btn ghost" onClick={close}>
          Done
        </button>
        <button className="btn gold" disabled={!deal} onClick={trade}>
          <LineIcon name="swap" size={18} />
          Trade
        </button>
      </div>
    </>
  );
}
