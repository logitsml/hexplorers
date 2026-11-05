// Cards and hexes the Guilds ask for, chosen the way the base game chooses them: a hand pick
// (unrest's discard, a dowry's or barter's give, a tribute's take) in the discard picker, made one
// move a card (game/handPicks.ts, Presenter.actAll); the Learning and bounty picks in the dock
// (ui/modules/CardPicks.tsx); and a resurvey's two hexes as a staged pick on the board.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyAction, createGame, emptyCards, legalActions, type Action, type CardCounts, type GameState, type Pending } from '../src/engine';
import type { GuildsPending } from '../src/engine/modules/guilds/types';
import { handPick, handPickMoves } from '../src/game/handPicks';
import { stagedAsk, stagedStep, stagesOf } from '../src/game/moduleActions';
import { answersDecision, coveredTypes } from '../src/game/modulePanels';
import { decisionText } from '../src/game/decisions';
import { useUI } from '../src/game/store';
import { Presenter } from '../src/game/presenter';
import { BoardInput } from '../src/app/input';
import { HandPickDecision, HandPickModal, SupplyPick } from '../src/ui/modules/CardPicks';
import { startStagedPick } from '../src/ui/modules/shared';
import { game, giveVenture } from './modules/guilds-helpers';
import { FOUR, grant, patch, toMain } from './helpers';

// As in decisionFlows.test.ts: the components read the test's game from the store as a mounted one would.
vi.mock('../src/game/store', async (original) => {
  const actual = await original<typeof import('../src/game/store')>();
  const use = Object.assign(<T,>(select: (s: ReturnType<typeof actual.useUI.getState>) => T) => select(actual.useUI.getState()), actual.useUI);
  return { ...actual, useUI: use };
});
vi.mock('../src/app/session', () => ({ session: { act: vi.fn(() => null) } }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));
vi.mock('../src/ui/Morph', () => ({ Morph: ({ children }: { children: unknown }) => children }));
// (The HUD reads the window as it loads: its ReasonButton, server-rendered, is a button saying why it's off.)
vi.mock('../src/ui/Hud', async () => {
  const { createElement: h } = await import('react');
  return { ReasonButton: ({ reason, children, className }: { reason: string | null; children: import('react').ReactNode; className?: string }) => h('button', { className, 'aria-disabled': reason ? true : undefined, title: reason ?? undefined }, children) };
});

// (The dialog's frame takes the focus as it opens: a plain box will do here.)
vi.mock('../src/ui/ModalFrame', async (original) => {
  const actual = await original<typeof import('../src/ui/ModalFrame')>();
  const { createElement: h } = await import('react');
  return { ...actual, Modal: ({ children }: { children: import('react').ReactNode }) => h('div', { role: 'dialog' }, children) };
});

beforeEach(() => useUI.getState().set({ view: null, me: 0, busy: false, choice: null, batch: [], interaction: { kind: 'idle' }, replay: null, modal: null }));

/** A guilds game in seat 1's main phase with `d` owed by seat 0, holding `hand` (and nothing else). */
function owing(d: GuildsPending, hand: Partial<CardCounts>): GameState {
  return patch(game(['guilds']), (x) => {
    toMain(x, 1);
    for (const p of x.players) for (const k of Object.keys(p.hand) as (keyof CardCounts)[]) {
      x.bank[k] += p.hand[k];
      p.hand[k] = 0;
    }
    grant(x, 0, hand);
    grant(x, 2, { brick: 1, cloth: 2 });
    x.pending.push({ kind: d.kind, players: [0], data: d });
  });
}

const counts = (c: Partial<CardCounts>): CardCounts => ({ ...emptyCards(), ...c });

describe('a hand pick', () => {
  it('asks unrest’s discard of every card a venture can take, never oil, and makes it one move a card', () => {
    const s = owing({ kind: 'guilds/discard', left: 3 }, { wool: 3, ore: 2, paper: 2 });
    const pick = handPick(s, 0)!;
    expect(pick).toMatchObject({ kind: 'guilds/discard', reason: 'unrest', need: 3, from: 0, to: null });
    expect(pick.kinds).toContain('paper');
    expect(pick.kinds).not.toContain('oil');
    expect(pick.max).toMatchObject({ wool: 3, ore: 2, paper: 2 });
    expect(handPick(s, 1)).toBeNull();
    // Not a whole answer: too few, or more than held.
    expect(handPickMoves(s, 0, pick, counts({ wool: 2 }))).toBeNull();
    expect(handPickMoves(s, 0, pick, counts({ ore: 3 }))).toBeNull();
    const moves = handPickMoves(s, 0, pick, counts({ wool: 2, paper: 1 }))!;
    expect(moves).toEqual([
      { type: 'guilds/discardCard', card: 'wool' },
      { type: 'guilds/discardCard', card: 'wool' },
      { type: 'guilds/discardCard', card: 'paper' },
    ]);
    let t = s;
    for (const a of moves) {
      const r = applyAction(t, 0, a);
      if (!r.ok) throw new Error(r.error);
      t = r.state;
    }
    expect(t.pending).toEqual([]);
    expect(t.players[0].hand).toMatchObject({ wool: 1, ore: 2, paper: 1 });
  });

  it('gives a barter’s commodity, and takes a tribute from what the venture showed', () => {
    const barter = owing({ kind: 'guilds/give', to: 2, left: 1, only: 'commodities', reason: 'barter' }, { wool: 2, silver: 1 });
    expect(handPick(barter, 0)).toMatchObject({ reason: 'barter', need: 1, kinds: ['paper', 'cloth', 'silver'], to: 2 });
    const seen = counts({ brick: 1, cloth: 2 });
    const tribute = owing({ kind: 'guilds/tribute', target: 2, left: 2, seen }, {});
    const pick = handPick(tribute, 0)!;
    expect(pick).toMatchObject({ reason: 'tribute', need: 2, from: 2, to: 0 });
    expect(pick.max).toMatchObject({ brick: 1, cloth: 2, wool: 0 });
    expect(handPickMoves(tribute, 0, pick, counts({ brick: 2 }))).toBeNull();
    expect(handPickMoves(tribute, 0, pick, counts({ brick: 1, cloth: 1 }))).toEqual([
      { type: 'guilds/take', card: 'brick' },
      { type: 'guilds/take', card: 'cloth' },
    ]);
  });

  it('asks for no more than the hand holds', () => {
    const s = owing({ kind: 'guilds/give', to: 2, left: 2, only: 'cards', reason: 'dowry' }, { ore: 1 });
    expect(handPick(s, 0)!.need).toBe(1);
  });

  it('is answered by its own dialog and dock card, not the generic panel, and its words don’t ask a card at a time', () => {
    const s = owing({ kind: 'guilds/discard', left: 2 }, { wool: 4 });
    expect(answersDecision(s, s.pending[0])).toBe(true);
    for (const t of ['guilds/discardCard', 'guilds/give', 'guilds/take', 'guilds/pick']) expect(coveredTypes(s).has(t)).toBe(true);
    expect(decisionText(s, 0, s.pending[0] as never)).toBe('Unrest costs you half your cards: choose 2 cards to discard');
  });
});

describe('the moves of a hand pick, made in turn', () => {
  /** The presenter's control, with a host that applies moves at once (a LocalHost's way) and no animation. */
  function presenter(s: GameState) {
    const host = {
      state: s,
      remote: false,
      isBot: () => false,
      scripted: false,
      submit: vi.fn((actor: number, a: Action) => {
        const r = applyAction(host.state, actor, a);
        if (r.ok) host.state = r.state;
        return r.ok ? { ok: true } : r;
      }),
    };
    const p = Object.create(Presenter.prototype) as Presenter;
    Object.assign(p, { me: 0, host, syncMarkers: vi.fn(), scheduleBots: vi.fn(), trackReplay: vi.fn() });
    // (What a presentation's settling calls.)
    const idle = () => (p as unknown as { afterIdle(): void }).afterIdle();
    return { p, idle, host };
  }

  it('sends the first now and each of the rest once the one before has landed, then offers what comes next', () => {
    const s = owing({ kind: 'guilds/discard', left: 3 }, { wool: 3, ore: 2 });
    useUI.getState().set({ view: s });
    const { p, idle, host } = presenter(s);
    const moves = handPickMoves(s, 0, handPick(s, 0)!, counts({ wool: 1, ore: 2 }))!;
    expect(p.actAll(moves)).toBeNull();
    expect(host.submit).toHaveBeenCalledTimes(1);
    expect(useUI.getState().batch).toHaveLength(3);
    idle();
    idle();
    expect(host.submit).toHaveBeenCalledTimes(3);
    expect(useUI.getState().batch).toHaveLength(1);
    idle();
    expect(useUI.getState().batch).toEqual([]);
    expect(host.state.pending).toEqual([]);
    expect(host.state.players[0].hand).toMatchObject({ wool: 2, ore: 0 });
    expect((p as unknown as { scheduleBots: () => void }).scheduleBots).toHaveBeenCalled();
  });

  it('drops the rest once the decision has gone', () => {
    const s = owing({ kind: 'guilds/discard', left: 2 }, { wool: 3 });
    const { p, idle, host } = presenter(s);
    const wool: Action = { type: 'guilds/discardCard', card: 'wool' };
    p.actAll([wool, wool, wool]);
    idle();
    idle();
    expect(host.submit).toHaveBeenCalledTimes(2);
    expect(useUI.getState().batch).toEqual([]);
  });

  it('opens its dialog once when the decision falls to you, and not again once put aside', () => {
    const s = owing({ kind: 'guilds/discard', left: 2 }, { wool: 4 });
    const { p } = presenter(s);
    p.updateInteraction(s);
    expect(useUI.getState().modal).toBe('cards');
    useUI.getState().set({ modal: null });
    p.updateInteraction({ ...s });
    expect(useUI.getState().modal).toBeNull();
    // Answered, then owed again: it opens again.
    const done = patch(s, (x) => void x.pending.pop());
    p.updateInteraction(done);
    p.updateInteraction(s);
    expect(useUI.getState().modal).toBe('cards');
  });
});

describe('the hand pick at the table', () => {
  it('says what is owed in the dock, and that the cards are on their way once chosen', () => {
    const s = owing({ kind: 'guilds/discard', left: 2 }, { wool: 4 });
    useUI.getState().set({ view: s });
    const html = renderToStaticMarkup(createElement(HandPickDecision));
    expect(html).toContain('Unrest');
    expect(html).toContain('Choose the cards');
    useUI.getState().set({ batch: [{ type: 'guilds/discardCard', card: 'wool' }] });
    expect(renderToStaticMarkup(createElement(HandPickDecision))).toContain('Discarding…');
  });

  it('offers a tribute’s cards as theirs, with no suggestion for what to take', () => {
    const s = owing({ kind: 'guilds/tribute', target: 2, left: 2, seen: counts({ brick: 1, cloth: 2 }) }, {});
    useUI.getState().set({ view: s, modal: 'cards' });
    const html = renderToStaticMarkup(createElement(HandPickModal));
    expect(html).toContain(`Tribute from ${s.players[2].name}`);
    expect(html).toContain('they have 2');
    expect(html).toContain('Take 2');
    expect(html).not.toContain('Suggest');
  });
});

describe('a pick from the supply', () => {
  it('takes the Learning ability’s resource with a press', () => {
    const s = patch(game(['guilds']), (x) => {
      toMain(x, 0);
      x.pending.push({ kind: 'guilds/pick', players: [0], data: { kind: 'guilds/pick' } });
    });
    useUI.getState().set({ view: s });
    const html = renderToStaticMarkup(createElement(SupplyPick));
    expect(html).toContain('Learning');
    expect(html.match(/card-btn/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('counts a bounty pick of two up before it takes them', () => {
    const g = createGame(FOUR, { seed: 3, map: 'archipelago', modules: ['sea'], victoryPoints: 14 }).state;
    const s = patch(g, (x) => {
      toMain(x, 0);
      x.setupIndex = x.setupOrder.length;
      x.pending.push({ kind: 'sea/bountyPick', players: [0], data: { count: 2, reason: 'production' } } as Pending);
    });
    expect(legalActions(s, 0).filter((a) => a.type === 'sea/pickBounty').length).toBe(15);
    useUI.getState().set({ view: s });
    const html = renderToStaticMarkup(createElement(SupplyPick));
    expect(html).toContain('Bounty fields');
    expect(html).toContain('Choose 2 more');
    expect(answersDecision(s, s.pending[0])).toBe(true);
    expect(coveredTypes(s).has('sea/pickBounty')).toBe(true);
  });
});

describe('a resurvey, chosen on the board', () => {
  type Play = Extract<Action, { type: 'guilds/play' }>;
  function resurveying(): GameState {
    return patch(game(['guilds']), (x) => {
      toMain(x, 0);
      giveVenture(x, 0, 'resurvey');
      giveVenture(x, 0, 'waterworks');
    });
  }
  const plays = (s: GameState, card: string) => legalActions(s, 0).filter((a): a is Play => a.type === 'guilds/play' && a.card === card);

  it('reaches every pair by its two hexes, in either order, and never two of a number', () => {
    const s = resurveying();
    const legal = plays(s, 'resurvey');
    expect(legal.length).toBeGreaterThan(20);
    expect(stagesOf(legal[0])).toEqual({ kind: 'hex', stages: [[...legal[0].hexes!]] });
    const first = stagedStep(legal, [[]])!;
    expect(first.need).toBe(2);
    expect(stagedAsk('guilds/play', first)).toBe('choose 2 hexes on the board whose numbers swap');
    for (const a of legal.filter((_, i) => i % 5 === 0)) {
      const [x, y] = a.hexes!;
      const one = stagedStep(legal, [[y]])!;
      expect(one.spots).toContain(x);
      expect(one.spots).not.toContain(y);
      expect(stagedAsk('guilds/play', one)).toBe('choose 1 more hex on the board to swap numbers with');
      // (Two hexes of one number would swap nothing, so neither offers the other.)
      const n = (h: number) => s.ext.guilds!.numbers[h] ?? s.board.hexes[h].numbers;
      for (const z of one.spots) expect(n(z)).not.toEqual(n(y));
      expect(stagedStep(legal, [[y, x]])!.done).toEqual(a);
    }
  });

  it('is clicked out on the board and kept to the resurvey’s own plays as the game moves', () => {
    const s = resurveying();
    useUI.getState().set({ view: s });
    startStagedPick('Resurvey', plays(s, 'resurvey'));
    expect(useUI.getState().hint).toBe('Resurvey: choose 2 hexes on the board whose numbers swap');
    const b = Object.create(BoardInput.prototype) as BoardInput;
    const act = vi.fn((_a: Action) => null);
    Object.assign(b, { presenter: { act, syncMarkers: vi.fn() }, view: { showMarkers: vi.fn() }, clearPending: vi.fn(), focus: vi.fn() });
    const it = () => useUI.getState().interaction as { spots: number[]; chosen?: number[][]; actions: Action[] };
    const first = it().spots[0];
    (b as unknown as { place(id: number): void }).place(first);
    expect(it().chosen).toEqual([[first]]);
    // A new state (another venture also playable): the pick keeps its hex and only the resurvey's plays.
    const p = Object.create(Presenter.prototype) as Presenter;
    Object.assign(p, { me: 0, host: { isBot: () => false, scripted: false }, syncMarkers: vi.fn() });
    p.updateInteraction({ ...s, seq: s.seq + 1 });
    expect(it().chosen).toEqual([[first]]);
    expect(it().actions.every((a) => (a as Play).card === 'resurvey')).toBe(true);
    (b as unknown as { place(id: number): void }).place(it().spots[0]);
    expect((act.mock.calls[0]?.[0] as Play).card).toBe('resurvey');
  });
});
