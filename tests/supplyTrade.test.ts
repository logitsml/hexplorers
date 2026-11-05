// Holdings and trade in one place: the tokens every view of a hand reads (src/game/holdings.ts),
// the trade dialog's Supply tab (src/ui/SupplyTrade.tsx) and the Players tab's deal (CardDeal,
// src/ui/TradeParts.tsx): a deal at the top, tiles to tap below, all one size in one grid.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cardKinds, redactState, type GameState } from '../src/engine';
import { emptyCounts, useUI } from '../src/game/store';
import { tokensOf } from '../src/game/holdings';
import { coveredTypes, legalModuleActions } from '../src/game/modulePanels';
import { SupplyTrade } from '../src/ui/SupplyTrade';
import { CardDeal } from '../src/ui/TradeParts';
import { game } from './modules/guilds-helpers';
import { toMain } from './helpers';

// As in fishNets.test.ts: the components read the test's game from the store as a mounted one would.
vi.mock('../src/game/store', async (original) => {
  const actual = await original<typeof import('../src/game/store')>();
  const use = Object.assign(<T,>(select: (s: ReturnType<typeof actual.useUI.getState>) => T) => select(actual.useUI.getState()), actual.useUI);
  return { ...actual, useUI: use };
});
vi.mock('../src/app/session', () => ({ session: {} }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));
vi.mock('../src/ui/why', () => ({ explain: vi.fn() }));
vi.mock('../src/ui/Hud', () => ({
  ReasonButton: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));

// (The parchment look draws both grids at once; Sea Glass, its own case below, one at a time.)
beforeEach(() => useUI.getState().set({ view: null, me: 0, busy: false, choice: null, interaction: { kind: 'idle' }, replay: null, modal: null, handDelta: {}, settings: { ...useUI.getState().settings, look: 'parchment' } }));

/** Seat 0's main phase in a game of every token: coins (rivers), fish, prisoners (the invasion), oil and the commodities. */
function holding(): GameState {
  const s = game(['guilds', 'invasion', 'rivers', 'fisheries', 'oil']);
  toMain(s, 0);
  s.players[0].coins = 3;
  s.players[0].hand = { ...s.players[0].hand, ore: 4, wood: 1, oil: 1 };
  s.ext.fisheries!.tokens[0] = [3, 2];
  s.ext.fisheries!.tokens[1] = [2, 2, 1];
  s.ext.invasion!.prisoners[0] = 2;
  return s;
}

const supply = (s: GameState) => {
  useUI.getState().set({ view: s });
  return renderToStaticMarkup(createElement(SupplyTrade));
};

describe('holdings', () => {
  it('names coins, fish and prisoners alike everywhere, fish worth what they are only to their holder', () => {
    const s = holding();
    expect(tokensOf(s, 0, true).map((t) => [t.id, t.n])).toEqual([['coin', 3], ['fish', 5], ['prisoner', 2]]);
    // Anyone else counts the tokens, face down; online the room hides the values, and the count stands.
    expect(tokensOf(s, 1, false).find((t) => t.id === 'fish')).toMatchObject({ n: 3, label: '3 fish tokens, face down' });
    expect(tokensOf(redactState(s, 0), 1, false).find((t) => t.id === 'fish')).toMatchObject({ n: 3 });
  });

  it('holds no tokens in a game of none', () => {
    expect(tokensOf(game([]), 0, true)).toEqual([]);
  });
});

/** Each tile of a palette (`give` or `get`): its name and whether it's greyed. */
function tiles(html: string, tone: 'give' | 'get'): { name: string; off: boolean; label: string }[] {
  return [...html.matchAll(new RegExp(`<button[^>]*class="tile ${tone}[^"]*"[^>]*>`, 'g'))].map((m) => {
    const label = m[0].match(/aria-label="([^"]*)"/)![1];
    return { name: label.split(',')[0], off: m[0].includes('aria-disabled="true"'), label };
  });
}

describe('the Supply tab', () => {
  it('pays with every card kind at your rate, oil, coins, fish and prisoners; takes any card but oil, or coins', () => {
    const html = supply(holding());
    expect(tiles(html, 'give').map((x) => x.name)).toEqual(['Brick', 'Wood', 'Wool', 'Wheat', 'Ore', 'Paper', 'Cloth', 'Silver', 'Oil', 'Coins', 'Fish', 'Prisoners']);
    expect(tiles(html, 'get').map((x) => x.name)).toEqual(['Brick', 'Wood', 'Wool', 'Wheat', 'Ore', 'Paper', 'Cloth', 'Silver', 'Coins']);
    // What each pays at: a card at the supply's rate, oil burned for two, coins two for one, fish four.
    expect(html).toContain('4:1');
    expect(html).toContain('1 → 2');
    expect(html).toContain('2 → 1');
    expect(html).toContain('4 → 1');
    expect(html).toContain('3 → 1 pt');
    // The deal starts empty, saying what to tap.
    expect(html).toContain('Tap what you pay with');
  });

  it('offers to pay only with what can pay: four ore, the oil, two coins and four fish, not one wood', () => {
    const off = Object.fromEntries(tiles(supply(holding()), 'give').map((x) => [x.name, x.off]));
    expect(off).toMatchObject({ Ore: false, Oil: false, Coins: false, Fish: false, Wood: true, Prisoners: true });
  });

  it('says what a trade would take when nothing can pay', () => {
    const s = game(['rivers']);
    toMain(s, 0);
    s.players[0].hand = emptyCounts();
    s.players[0].coins = 0;
    expect(supply(s)).toContain('You need 4 of one kind to trade');
  });

  it('takes the coin market off the expansions’ general panel', () => {
    const s = holding();
    expect(legalModuleActions(s, 0).some((a) => a.type === 'buyWithCoins')).toBe(true);
    expect(coveredTypes(s).has('buyWithCoins')).toBe(true);
    expect(coveredTypes(s).has('sellForCoins')).toBe(true);
  });
});

describe('the Players tab', () => {
  const deal = (give: object, get: object) => {
    const s = holding();
    return renderToStaticMarkup(createElement(CardDeal, { give: { ...emptyCounts(), ...give }, get: { ...emptyCounts(), ...get }, onGive: () => {}, onGet: () => {}, kinds: cardKinds(s), mine: s.players[0].hand, open: true }));
  };

  it('puts every kind on a tile to give and one to ask for, and the deal on top', () => {
    const html = deal({ ore: 2 }, { oil: 1 });
    expect(tiles(html, 'give')).toHaveLength(9);
    expect(tiles(html, 'get')).toHaveLength(9);
    expect(html).toContain('aria-label="2 Ore: take one back"');
    expect(html).toContain('aria-label="1 Oil: take one back"');
    // A kind goes one way only.
    expect(tiles(html, 'get').find((x) => x.name === 'Ore')!.off).toBe(true);
    expect(tiles(html, 'give').find((x) => x.name === 'Oil')!.off).toBe(true);
  });

  it('asks for bids when nothing is wanted', () => {
    expect(deal({ ore: 1 }, {})).toContain('Any offer: leave it empty and they bid');
  });
});

describe('Sea Glass', () => {
  it('shows one grid, for the side being filled: what you give first, the sides named give and get', () => {
    useUI.getState().set({ settings: { ...useUI.getState().settings, look: 'glass' } });
    const html = supply(holding());
    expect(html).toContain('Choose what you give');
    expect(html).not.toContain('Choose what you get');
    expect(html).toContain('You give');
    expect(html).toContain('You get');
    expect(html).toContain('aria-pressed="true"');
  });
});

