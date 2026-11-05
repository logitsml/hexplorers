// The trade dialog's Supply tab: what you pay with, what the supply gives, built by tapping, as the
// Players tab is (ui/TradeParts.tsx). Cards pay at your best rate (a harbour's 2:1 or 3:1, the
// supply's 4:1); oil burns for two of a resource; coins buy a resource (two coins) or are earned
// by selling cards at your rate; fish buy a resource (four fish). A deal is one thing paid for one
// thing taken, so each is one move the engine already has: `bankTrade`, `sellForCoins`,
// `oil/burn`, `buyWithCoins` or `fisheries/take`. Cards paid at a rate may buy several kinds at
// once (four wood at 2:1, a grain and an ore): one `bankTrade` a kind, made in turn (actAll).
// The oil, coin and fish deals are the ones the rules list (legalActions), so nothing is offered
// that the engine would refuse.

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

export function SupplyTrade() {
  const view = useDialogView();
  const me = useUI((s) => s.me);
  const hand = useHand(me);
  const bank = useBank();
  const [give, setGive] = useState<Pay | null>(null);
  // What's taken, and how many of each: several kinds only for cards paid at a rate.
  const [gets, setGets] = useState<Partial<Record<Take, number>>>({});
  // Sea Glass: one grid, for whichever side was tapped (what you give, then what you get).
  const glass = useUI((s) => s.settings.look === 'glass');
  const counted = useUI((s) => s.settings.supplyCounts);
  const [side, setSide] = useState<'give' | 'get'>('give');

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
  const taken = (Object.keys(gets) as Take[]).filter((k) => (gets[k] ?? 0) > 0);
  const get: Take | null = taken[0] ?? null;
  /** How many deals the take adds up to (one card, or one coin sold for, a deal). */
  const t = taken.reduce((n, k) => n + (gets[k] ?? 0), 0);
  /** Cards paid at a rate for cards: the kinds taken may differ. */
  const mixes = (p: Pay | null) => !!p && p !== 'coin' && p !== 'fish' && p !== 'oil';
  const cap = give && get ? (mixes(give) && get !== 'coin' ? payCap(give) : pairCap(give, get)) : give ? payCap(give) : get ? takeCap(get) : 0;

  /** What paying `p` hands over, `n` times; what taking `k` brings, `n` times. */
  const paid = (p: Pay, n: number) => (p === 'coin' ? 2 * n : p === 'fish' ? (fishPay ? fishPay.reduce((a, b) => a + b, 0) : 4) * n : p === 'oil' ? n : ratios[p] * n);
  const brought = (k: Take, n: number) => (give === 'oil' && k !== 'coin' ? 2 * n : n);

  const pickGive = (p: Pay) => {
    // (Tapped again with one kind taken: one more of it, as far as the payment goes.)
    if (give === p) return taken.length === 1 && t < cap && setGets({ [get!]: t + 1 });
    setGive(p);
    // What can't be had for it goes; of the rest, what it can pay for.
    const keep = taken.filter((k) => pairCap(p, k) > 0 && (mixes(p) && k !== 'coin' ? true : taken.length === 1));
    let room = Math.max(0, mixes(p) && keep[0] !== 'coin' ? payCap(p) : keep[0] ? pairCap(p, keep[0]) : 0);
    const next: Partial<Record<Take, number>> = {};
    for (const k of keep) {
      const n = Math.min(gets[k] ?? 0, room, k === 'coin' ? 99 : bank[k as Card]);
      if (n > 0) (next[k] = n), (room -= n);
    }
    setGets(next);
  };
  const dropGive = () => (setGive(null), t > 1 && taken.length === 1 ? setGets({ [get!]: 1 }) : undefined);
  const pickGet = (k: Take) => {
    const have = gets[k] ?? 0;
    // A kind of its own: coins sold for, or what coins, fish and oil buy (one deal at a time).
    const alone = k === 'coin' || get === 'coin' || (give !== null && !mixes(give));
    if (give && !pairCap(give, k)) {
      setGive(null);
      return setGets({ [k]: 1 });
    }
    if (alone) {
      if (get === k) return t < cap && setGets({ [k]: t + 1 });
      return setGets({ [k]: 1 });
    }
    // Cards for cards: another of this kind, while the payment (and the supply) has room.
    if (give && t >= cap) return;
    if (have >= bank[k]) return;
    // (With nothing paid yet, one kind at a time: what pays for a mix is chosen first.)
    if (!give && get && get !== k) return setGets({ [k]: 1 });
    setGets({ ...gets, [k]: have + 1 });
  };
  const dropGet = (id: string) => {
    const k = id as Take;
    const n = (gets[k] ?? 0) - 1;
    const next = { ...gets };
    if (n > 0) next[k] = n;
    else delete next[k];
    setGets(next);
  };

  const deals: Action[] = (() => {
    if (!give || !get || cap < 1 || t > cap) return [];
    const one = (a: Action | undefined) => (a ? [a] : []);
    if (give === 'coin') return one(buys.find((a) => a.get === get));
    if (give === 'fish') return one(takes.find((a) => a.resource === get));
    if (give === 'oil') return one(burns.find((a) => a.get === get));
    if (get === 'coin') return [{ type: 'sellForCoins', give, times: t }];
    return taken.map((k): Action => ({ type: 'bankTrade', give, get: k as Card, times: gets[k] }));
  })();
  const trade = () => {
    const p = session.presenter;
    if (!deals.length || !p) return;
    const err = deals.length > 1 ? p.actAll(deals) : session.act(deals[0]);
    if (!err) setGets({});
  };

  // (With nothing you could pay, the line under the tabs says what it would take.)
  const payable = kinds.some((r) => payCap(r) > 0) || buys.length > 0 || takes.length > 0;
  const nm = (k: HoldingId) => holdingName(k).toLowerCase();
  const full = (on: boolean) => (on && t >= cap ? 'That’s as many as this deal can make' : null);
  const takenNames = taken.map((k) => ({ id: k, icon: holdingIcon(k), name: holdingName(k), n: brought(k, gets[k] ?? 0) }));
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
      picked: give === r ? paid(r, Math.max(t, 1)) : 0,
      off: payCap(r) < 1 ? `Takes ${ratios[r]} ${nm(r)}` : full(give === r),
    })),
    ...(kinds.includes('oil') ? [{ id: 'oil', icon: holdingIcon('oil'), name: 'Oil', sub: `have ${hand.oil}`, badge: '1 → 2', picked: give === 'oil' ? paid('oil', Math.max(t, 1)) : 0, off: burns.length ? full(give === 'oil') : hand.oil ? 'No oil can be burned now' : 'You have no oil' }] : []),
    ...(coinTk ? [{ id: 'coin', icon: coinTk.icon, name: 'Coins', sub: `have ${coinTk.n}`, badge: '2 → 1', picked: give === 'coin' ? paid('coin', Math.max(t, 1)) : 0, off: buys.length ? full(give === 'coin') : coinTk.n < 2 ? 'Takes 2 coins' : 'Coins buy no more this turn' }] : []),
    ...(fishTk ? [{ id: 'fish', icon: fishTk.icon, name: 'Fish', sub: `have ${fishTk.n}`, badge: '4 → 1', picked: give === 'fish' ? paid('fish', Math.max(t, 1)) : 0, off: takes.length ? full(give === 'fish') : fishTk.n < 4 ? 'Takes 4 fish' : 'Fish buy nothing now' }] : []),
    ...(prisonerTk ? [{ id: 'prisoner', icon: prisonerTk.icon, name: 'Prisoners', sub: `have ${prisonerTk.n}`, badge: '3 → 1 pt', off: 'Every 3 prisoners go back for a point by themselves, when the raiders run out' }] : []),
  ];
  // What the supply gives: any card but oil, and coins for cards sold.
  const takeTile = (k: Take): TileSpec => {
    const n = gets[k] ?? 0;
    const why = (() => {
      if (k !== 'coin' && takeCap(k) - n < 1) return n ? 'That’s all the supply has' : 'None left in the supply';
      if (give && !pairCap(give, k)) return give === k ? `You're paying with ${nm(k)}` : k === 'coin' ? 'Coins come from selling cards' : `${holdingName(give)} buy${give === 'oil' ? 's' : ''} resources only`;
      // (A mix: the payment is used up whichever kind is tapped next.)
      return full(mixes(give) && get !== 'coin' && k !== 'coin' ? t > 0 : n > 0);
    })();
    return k === 'coin'
      ? { id: k, icon: holdingIcon(k), name: 'Coins', sub: `have ${coinTk?.n ?? 0}`, badge: 'sell', picked: brought(k, n), off: why }
      : { id: k, icon: holdingIcon(k), name: holdingName(k), sub: counted ? `${bank[k]} left` : 'from the supply', picked: brought(k, n), off: why };
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
            give={give ? [{ id: give, icon: holdingIcon(give), name: holdingName(give), n: paid(give, Math.max(t, 1)) }] : []}
            get={takenNames}
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
          <p className="sub">{payable ? 'Tap what you pay with, then what you take (cards paid at a rate can take several kinds). Each tile shows your best rate.' : supplyNeeds(kinds.filter((r) => r !== 'oil'), ratios)}</p>
          <Deal
            giveLabel="You pay"
            getLabel="You take"
            give={give ? [{ id: give, icon: holdingIcon(give), name: holdingName(give), n: paid(give, Math.max(t, 1)) }] : []}
            get={takenNames}
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
        <button className="btn ghost bare" disabled={!give && !get} onClick={() => (setGive(null), setGets({}), setSide('give'))}>
          Clear
        </button>
        <span className="footer-gap" aria-hidden />
        <button className="btn ghost" onClick={close}>
          Done
        </button>
        <button className="btn gold" disabled={!deals.length} onClick={trade}>
          <LineIcon name="swap" size={18} />
          Trade
        </button>
      </div>
    </>
  );
}
