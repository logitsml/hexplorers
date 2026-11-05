// Fisheries at the table: the page that spends fish (src/ui/modules/FishNets.tsx), the swap in the
// dock, and what the player cards say of everyone's tokens.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { redactState, type GameState } from '../src/engine';
import { useUI } from '../src/game/store';
import { coveredTypes, legalModuleActions } from '../src/game/modulePanels';
import { cheapestPay, payments } from '../src/engine/modules/fisheries/fish';
import { FishNets, FishSwap } from '../src/ui/modules/FishNets';
import { standingsOf } from '../src/ui/modules/standings';
import { game } from './modules/guilds-helpers';
import { toMain } from './helpers';

// As in decisionFlows.test.ts: the components read the test's game from the store as a mounted one would.
vi.mock('../src/game/store', async (original) => {
  const actual = await original<typeof import('../src/game/store')>();
  const use = Object.assign(<T,>(select: (s: ReturnType<typeof actual.useUI.getState>) => T) => select(actual.useUI.getState()), actual.useUI);
  return { ...actual, useUI: use };
});
vi.mock('../src/app/session', () => ({ session: {} }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));
// (The HUD module brings the board's window listeners with it; its ReasonButton, as it renders: the reason as title and for screen readers.)
vi.mock('../src/ui/Hud', () => ({
  ReasonButton: ({ reason, children, title, onClick: _, ...rest }: { reason: string | null; children?: ReactNode; title?: string; onClick: () => void }) =>
    createElement('button', { ...rest, 'aria-disabled': reason ? true : undefined, title: reason ?? title }, children, reason ? createElement('span', { className: 'sr-only' }, reason) : null),
}));

beforeEach(() => useUI.getState().set({ view: null, me: 0, busy: false, choice: null, interaction: { kind: 'idle' }, replay: null, modal: null }));

/** A fishing game in seat 0's main phase, seat 0 holding `mine` and seat 2 holding `theirs`. */
function fishing(mine: number[], theirs: number[] = []): GameState {
  const s = game(['fisheries']);
  toMain(s, 0);
  s.ext.fisheries!.tokens[0] = mine;
  s.ext.fisheries!.tokens[2] = theirs;
  return s;
}

const page = (s: GameState) => {
  useUI.getState().set({ view: s });
  return renderToStaticMarkup(createElement(FishNets));
};

describe('the player cards', () => {
  it('count every seat’s fish tokens and never add up what they’re worth', () => {
    const s = fishing([3, 1], [3, 3, 2]);
    const fish = (x: GameState, seat: number) => standingsOf(x, seat).find((h) => h.key === 'fish');
    // A solo game hands the interface the whole state: the values are there, and stay unsaid.
    expect(fish(s, 2)).toMatchObject({ n: 3, label: '3 fish tokens, face down' });
    expect(fish(s, 0)).toMatchObject({ n: 2 });
    // Online the room hides them: the count is the same.
    expect(fish(redactState(s, 0), 2)).toMatchObject({ n: 3 });
    expect(fish(redactState(s, 0), 3)).toMatchObject({ n: 0 });
  });
});

describe('paying', () => {
  it('pays as the bots do: the least fish, then the most room freed', () => {
    expect(cheapestPay(payments([3, 2, 1, 1], 4))).toEqual([2, 1, 1]);
    expect(cheapestPay(payments([3, 3, 2], 4))).toEqual([3, 2]);
    expect(cheapestPay(payments([1, 1], 4))).toBeNull();
  });
});

describe('the fish page', () => {
  it('takes every fish move off the generic panel', () => {
    const s = fishing([3, 3, 2, 1, 1]);
    s.robberHex = s.board.hexes.find((h) => h.terrain !== 'sea')!.id;
    const fish = legalModuleActions(s, 0).filter((a) => a.type.startsWith('fisheries/'));
    expect(fish.length).toBeGreaterThan(20);
    expect(fish.filter((a) => !coveredTypes(s).has(a.type))).toEqual([]);
  });

  it('shows your tokens face up, what each buy pays with, and why a buy is out', () => {
    const html = page(fishing([3, 2, 1, 1]));
    expect(html).toContain('Your fish tokens: 3, 2, 1, 1, 7 fish');
    // The robber waits off the board until the first 7.
    expect(html).toContain('The robber is off the board');
    // Two fish from two ones rather than a two (as much room freed), four from three tokens rather than two.
    expect(html).toContain('pays 1 + 1');
    expect(html).toContain('pays 3 + 2 + 1 + 1');
    // Taking a resource is a trade with the supply: the page sends you to the trade dialog's Supply tab.
    expect(html).toContain('Take a resource');
    expect(html).toContain('On the Supply tab');
    expect(html).not.toContain('pays 2 + 1 + 1');
    // No change is given, and the page says what goes over.
    expect(page(fishing([3, 3]))).toContain('pays 3, 1 over');
    expect(page(fishing([1, 1]))).toContain('You need 1 more fish');
  });

  it('keeps every other seat’s tokens to itself, and offers nothing off your turn', () => {
    const s = fishing([3], [3, 3, 2]);
    s.currentPlayer = 1;
    const html = page(s);
    expect(html).not.toMatch(/3, 3, 2/);
    expect(html).toContain(`${s.players[1].name}&#x27;s turn`);
  });

  it('passes the Soggy Boot only to a player with as many points showing', () => {
    const s = fishing([2]);
    s.ext.fisheries!.boot = 0;
    expect(page(s)).toContain('You hold <b>the Soggy Boot</b>: you need a point more to win');
    s.ext.fisheries!.boot = 1;
    expect(page(s)).toContain(`${s.players[1].name} holds the Soggy Boot`);
  });
});

describe('a full purse', () => {
  it('asks in the dock: throw back one of each value held, or keep them all', () => {
    const s = fishing([3, 3, 2, 2, 1, 1, 1]);
    s.pending = [{ kind: 'fisheries/swap', players: [0] }];
    useUI.getState().set({ view: s });
    const html = renderToStaticMarkup(createElement(FishSwap));
    expect(html).toContain('Your nets are full');
    for (const v of [3, 2, 1]) expect(html).toContain(`Throw back a ${v}-fish token`);
    expect(html).toContain('Keep them all');
    useUI.getState().set({ me: 1 });
    expect(renderToStaticMarkup(createElement(FishSwap))).toBe('');
  });
});
