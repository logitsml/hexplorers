// The pieces every trade is built from, with players or with the supply: the deal at the top, what
// goes out on the left and what comes in on the right, and below it the things you can put in,
// as tiles of one size in one grid (a tap adds one; a tap on the deal takes one back). Building a
// trade is then the same few taps whoever it's with, and the deal always says what it is.

import { useState, type ReactNode } from 'react';
import { CARDS, type Card, type CardCounts } from '../engine';
import { CARD_ICON, CARD_NAMES, asset } from '../game/names';
import { LineIcon } from './LineIcons';
import { explain } from './why';
import { isTouch } from './useCompact';

/** One thing in a side of the deal: its painting, name and how many. */
export interface DealItem {
  id: string;
  icon: string;
  name: string;
  n: number;
}

/** A side of the deal, its things as chips that each give one back when tapped. */
function Side({ label, tone, items, onTake, empty, active, onPick }: { label: string; tone: 'give' | 'get'; items: DealItem[]; onTake?: (id: string) => void; empty: ReactNode; active?: boolean; onPick?: () => void }) {
  return (
    // (Where a side is chosen to fill, a tap anywhere on it chooses it; its label is the button that says so.)
    <div className={`deal-side ${tone}${onPick ? ' pickable' : ''}${active ? ' active' : ''}`} role="group" aria-label={label} onClick={onPick}>
      {onPick ? (
        <button type="button" className="deal-label" aria-pressed={!!active}>
          {label}
        </button>
      ) : (
        <span className="deal-label">{label}</span>
      )}
      {active && (
        <span className="deal-choosing" aria-hidden>
          Choosing
        </span>
      )}
      <div className="deal-items" aria-live="polite">
        {items.length === 0 ? (
          <span className="deal-empty">{empty}</span>
        ) : (
          items.map((it) =>
            onTake ? (
              <button key={it.id} type="button" className="deal-chip" onClick={() => onTake(it.id)} aria-label={`${it.n} ${it.name}: take one back`}>
                <img src={asset(it.icon)} alt="" draggable={false} />
                <b>{it.n}</b>
                <span className="deal-x" aria-hidden>
                  <LineIcon name="minus" size={12} />
                </span>
              </button>
            ) : (
              <span key={it.id} className="deal-chip still" role="img" aria-label={`${it.n} ${it.name}`}>
                <img src={asset(it.icon)} alt="" draggable={false} />
                <b>{it.n}</b>
              </span>
            ),
          )
        )}
      </div>
    </div>
  );
}

/**
 * The deal: what you give, what you get, side by side. `onSwap` turns it round (the arrow between
 * the sides is its button); without it the arrow only reads left to right.
 */
export function Deal({ give, get, giveLabel = 'You give', getLabel = 'You get', onTakeGive, onTakeGet, onSwap, giveEmpty, getEmpty, active, onPick }: { give: DealItem[]; get: DealItem[]; giveLabel?: string; getLabel?: string; onTakeGive?: (id: string) => void; onTakeGet?: (id: string) => void; onSwap?: () => void; giveEmpty: ReactNode; getEmpty: ReactNode; active?: 'give' | 'get'; onPick?: (side: 'give' | 'get') => void }) {
  return (
    <div className="deal">
      <Side label={giveLabel} tone="give" items={give} onTake={onTakeGive} empty={giveEmpty} active={active === 'give'} onPick={onPick && (() => onPick('give'))} />
      {onSwap ? (
        <button type="button" className="deal-swap" onClick={onSwap} disabled={give.length === 0 && get.length === 0} aria-label="Swap sides" title="Swap sides">
          <LineIcon name="swap" size={18} />
        </button>
      ) : (
        <span className="deal-swap still" aria-hidden>
          <LineIcon name="arrowRight" size={18} />
        </span>
      )}
      <Side label={getLabel} tone="get" items={get} onTake={onTakeGet} empty={getEmpty} active={active === 'get'} onPick={onPick && (() => onPick('get'))} />
    </div>
  );
}

/** A tile to tap: a thing you could put into the deal. `off`: why it can't go in now (said when tapped). */
export interface TileSpec {
  id: string;
  icon: string;
  name: string;
  /** Under the name: how many you have, how many are left. */
  sub: string;
  /** A rate or a note in the corner ("3:1", "burn"). */
  badge?: string;
  badgeClass?: string;
  /** How many of it are in the deal already. */
  picked?: number;
  off?: string | null;
}

/** Tiles of one size in one grid, under a heading saying what a tap does. */
export function Palette({ label, tone, tiles, onTap }: { label: string; tone: 'give' | 'get'; tiles: TileSpec[]; onTap: (id: string) => void }) {
  return (
    <div className="palette" role="group" aria-label={label}>
      <span className="palette-label">{label}</span>
      <div className="palette-tiles">
        {tiles.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tile ${tone}${t.picked ? ' picked' : ''}`}
            aria-disabled={t.off ? true : undefined}
            aria-label={`${t.name}, ${t.sub}${t.badge ? `, ${t.badge}` : ''}${t.picked ? `, ${t.picked} in the deal` : ''}${t.off ? `. ${t.off}` : ''}`}
            title={t.off ?? undefined}
            onClick={() => (t.off ? explain(t.off) : onTap(t.id))}
          >
            {t.badge && <span className={`tile-badge chip rate ${t.badgeClass ?? ''}`}>{t.badge}</span>}
            {!!t.picked && <span className="tile-n">{t.picked}</span>}
            <img src={asset(t.icon)} alt="" draggable={false} />
            <b>{t.name}</b>
            <small>{t.sub}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Cards as the deal's items: each kind there is at least one of. */
export const cardItems = (rc: CardCounts, kinds: readonly Card[]): DealItem[] => kinds.filter((r) => rc[r] > 0).map((r) => ({ id: r, icon: CARD_ICON[r], name: CARD_NAMES[r], n: rc[r] }));

/**
 * A trade of cards with other players, built by tapping: your cards to give, the kinds to ask for.
 * A kind goes one way only. `open`: asking for nothing is allowed, an open offer the others bid on.
 */
export function CardDeal({ give, get, onGive, onGet, kinds, mine, open = false, giveLabel = 'You give', getLabel = 'You get', pick = false }: { give: CardCounts; get: CardCounts; onGive: (v: CardCounts) => void; onGet: (v: CardCounts) => void; kinds: readonly Card[]; mine: CardCounts; open?: boolean; giveLabel?: string; getLabel?: string; pick?: boolean }) {
  const less = (rc: CardCounts, r: string) => ({ ...rc, [r]: Math.max(0, rc[r as Card] - 1) });
  // `pick` (Sea Glass): one grid of tiles, for whichever side was tapped last; what you get reads "You want".
  const [side, setSide] = useState<'give' | 'get'>('give');
  const giveTiles = kinds.map((r) => ({
    id: r,
    icon: CARD_ICON[r],
    name: CARD_NAMES[r],
    sub: mine[r] ? `have ${mine[r] - give[r]}` : 'none',
    picked: give[r],
    off: get[r] > 0 ? `You're asking for ${CARD_NAMES[r].toLowerCase()}` : mine[r] - give[r] <= 0 ? (mine[r] ? `All your ${CARD_NAMES[r].toLowerCase()} is in the deal` : `You have no ${CARD_NAMES[r].toLowerCase()}`) : null,
  }));
  const getTiles = kinds.map((r) => ({
    id: r,
    icon: CARD_ICON[r],
    name: CARD_NAMES[r],
    sub: get[r] ? `${get[r]} asked` : 'ask',
    picked: get[r],
    off: give[r] > 0 ? `You're giving ${CARD_NAMES[r].toLowerCase()}` : get[r] >= 19 ? 'That’s all there are' : null,
  }));
  const addGive = (r: string) => onGive({ ...give, [r]: give[r as Card] + 1 });
  const addGet = (r: string) => onGet({ ...get, [r]: get[r as Card] + 1 });
  if (pick) {
    const want = getLabel === 'You get' ? 'You want' : getLabel;
    return (
      <>
        <Deal
          give={cardItems(give, kinds)}
          get={cardItems(get, kinds)}
          giveLabel={giveLabel}
          getLabel={want}
          onTakeGive={(r) => onGive(less(give, r))}
          onTakeGet={(r) => onGet(less(get, r))}
          onSwap={() => (onGive(Object.fromEntries(CARDS.map((r) => [r, Math.min(get[r], mine[r])])) as CardCounts), onGet(give))}
          giveEmpty={isTouch() ? 'Tap to choose' : 'Choose…'}
          getEmpty={open ? `${isTouch() ? 'Tap to choose' : 'Choose'}, or leave open for bids` : isTouch() ? 'Tap to choose' : 'Choose…'}
          active={side}
          onPick={setSide}
        />
        {side === 'give' ? <Palette label="Choose what you give" tone="give" onTap={addGive} tiles={giveTiles} /> : <Palette label="Choose what you want" tone="get" onTap={addGet} tiles={getTiles} />}
      </>
    );
  }
  return (
    <>
      <Deal
        give={cardItems(give, kinds)}
        get={cardItems(get, kinds)}
        giveLabel={giveLabel}
        getLabel={getLabel}
        onTakeGive={(r) => onGive(less(give, r))}
        onTakeGet={(r) => onGet(less(get, r))}
        onSwap={() => (onGive(Object.fromEntries(CARDS.map((r) => [r, Math.min(get[r], mine[r])])) as CardCounts), onGet(give))}
        giveEmpty="Tap your cards below"
        getEmpty={open ? 'Any offer: leave it empty and they bid' : 'Tap what you want below'}
      />
      <Palette label="Your cards · tap to give" tone="give" onTap={addGive} tiles={giveTiles} />
      <Palette label="Ask for · tap to want" tone="get" onTap={addGet} tiles={getTiles} />
    </>
  );
}
