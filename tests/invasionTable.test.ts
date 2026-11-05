// Invasion at the table: the turncoat chosen on the board as a staged pick (game/moduleActions.ts),
// the muster card owed in the dock and the raiders' page (src/ui/modules/Coast.tsx).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyAction, createGame, legalActions, type Action, type GameState } from '../src/engine';
import { topology } from '../src/engine/modules/invasion/topology';
import { RAIDERS } from '../src/engine/modules/invasion/raids';
import type { MusterCard } from '../src/engine/modules/invasion/types';
import { groupActions, stagedAsk, stagedStep, stagesOf } from '../src/game/moduleActions';
import { coveredTypes, legalModuleActions } from '../src/game/modulePanels';
import { availability, buyDevCard, cardForSale } from '../src/game/commands';
import { useUI } from '../src/game/store';
import { session } from '../src/app/session';
import { Coast, MusterDecision } from '../src/ui/modules/Coast';
import { startStagedPick } from '../src/ui/modules/shared';
import { BoardInput } from '../src/app/input';
import { Presenter } from '../src/game/presenter';
import { game } from './modules/guilds-helpers';
import { FOUR, grant, patch, toMain } from './helpers';

// As in decisionFlows.test.ts: the components read the test's game from the store as a mounted one would.
vi.mock('../src/game/store', async (original) => {
  const actual = await original<typeof import('../src/game/store')>();
  const use = Object.assign(<T,>(select: (s: ReturnType<typeof actual.useUI.getState>) => T) => select(actual.useUI.getState()), actual.useUI);
  return { ...actual, useUI: use };
});
vi.mock('../src/app/session', () => ({ session: { act: vi.fn(() => null) } }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));
// (A label that morphs is its text, server-rendered.)
vi.mock('../src/ui/Morph', () => ({ Morph: ({ children }: { children: unknown }) => children }));

type Turncoat = Extract<Action, { type: 'invasion/turncoat' }>;

beforeEach(() => useUI.getState().set({ view: null, me: 0, busy: false, choice: null, interaction: { kind: 'idle' }, replay: null, modal: null }));

/** An Invasion island in seat 0's main phase with `card` on top of the muster deck, bought: its answer owed. */
function owing(card: MusterCard, fn: (x: GameState) => void = () => {}): GameState {
  const g = createGame(FOUR, { layout: 'random', seed: 11, modules: ['invasion'], victoryPoints: 12 }).state;
  const s = patch(g, (x) => {
    x.turn = 5;
    x.setupIndex = x.setupOrder.length;
    toMain(x, 0);
    grant(x, 0, { wool: 1, wheat: 1, ore: 1 });
    const i = x.ext.invasion!;
    i.deck.splice(i.deck.lastIndexOf(card), 1);
    i.deck.push(card);
    fn(x);
  });
  const r = applyAction(s, 0, { type: 'invasion/buy' });
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

const coast = (s: GameState) => topology(s.board).coast;

describe('the turncoat, chosen on the board', () => {
  it('is a staged pick of hexes, not a list', () => {
    const s = owing('turncoat', (x) => {
      const c = coast(x);
      x.ext.invasion!.raiders[c[1]] = 1;
      x.ext.invasion!.raiders[c[4]] = 2;
    });
    const answers = legalActions(s, 0) as Turncoat[];
    expect(answers.length).toBeGreaterThan(50);
    const [g] = groupActions(answers, s);
    expect(g).toMatchObject({ staged: true, target: 'hex' });
  });

  it('reaches every answer by its hexes, in any order, and only once both stages are chosen', () => {
    const s = owing('turncoat', (x) => {
      const c = coast(x);
      x.ext.invasion!.raiders[c[1]] = 1;
      x.ext.invasion!.raiders[c[4]] = 2;
      x.ext.invasion!.raiders[c[6]] = 3;
    });
    const answers = legalActions(s, 0) as Turncoat[];
    for (const a of answers.filter((_, i) => i % 7 === 0)) {
      const [from, to] = stagesOf(a)!.stages;
      let step = stagedStep(answers, [[]])!;
      // Sources backwards, destinations forwards: the order within a stage doesn't count.
      for (const h of [...from].reverse()) {
        expect(step.done).toBeNull();
        expect(step.spots).toContain(h);
        step = stagedStep(answers, [...step.chosen.slice(0, -1), [...step.chosen[step.chosen.length - 1], h]])!;
      }
      expect(step.chosen).toHaveLength(2);
      // (The hexes the raiders leave aren't offered as places to lead them, nor is a conquered hex.)
      for (const h of from) expect(step.spots).not.toContain(h);
      expect(step.spots).not.toContain(coast(s)[6]);
      for (const h of to) {
        expect(step.done).toBeNull();
        step = stagedStep(answers, [...step.chosen.slice(0, -1), [...step.chosen[step.chosen.length - 1], h]])!;
      }
      expect(step.done).toBe(a);
    }
  });

  it('fills in a stage that leaves no choice: raiders that can only come from the one hex and the supply', () => {
    const s = owing('turncoat', (x) => {
      x.ext.invasion!.raiders.fill(0);
      x.ext.invasion!.raiders[coast(x)[3]] = 3;
      x.ext.invasion!.supply = RAIDERS - 3;
    });
    const answers = legalActions(s, 0) as Turncoat[];
    const step = stagedStep(answers, [[]])!;
    expect(step.chosen).toEqual([[coast(s)[3]], []]);
    expect(step.need).toBe(2);
    expect(stagedAsk('invasion/turncoat', step)).toBe('choose 2 hexes on the board to lead the raiders to');
    expect(step.spots).not.toContain(coast(s)[3]);
  });

  it('refuses a spot that fits no answer', () => {
    const s = owing('turncoat');
    const answers = legalActions(s, 0) as Turncoat[];
    const inland = s.board.hexes.find((h) => h.terrain !== 'sea' && !coast(s).includes(h.id))!.id;
    expect(stagedStep(answers, [[inland]])).toBeNull();
  });
});

describe('the turncoat, clicked on the board', () => {
  /** The input layer's placing, with the board and presenter stubbed: as decisionFlows.test.ts does. */
  function input() {
    const b = Object.create(BoardInput.prototype) as BoardInput;
    const act = vi.fn((_a: Action) => null);
    Object.assign(b, { presenter: { act, syncMarkers: vi.fn() }, view: { showMarkers: vi.fn() }, clearPending: vi.fn(), focus: vi.fn() });
    return { b: b as unknown as { place(id: number): void }, act };
  }

  it('takes each click into the stage under way, says what is left, and makes the move at the last', () => {
    const s = owing('turncoat', (x) => {
      const c = coast(x);
      x.ext.invasion!.raiders[c[1]] = 1;
      x.ext.invasion!.raiders[c[4]] = 2;
    });
    useUI.getState().set({ view: s });
    const answers = legalActions(s, 0) as Turncoat[];
    startStagedPick('Turncoat', answers);
    expect(useUI.getState().hint).toBe('Turncoat: choose 2 hexes on the board to take raiders from');
    const { b, act } = input();
    const pickAt = () => {
      const it = useUI.getState().interaction;
      if (it.kind !== 'pick') throw new Error('the pick ended');
      return it;
    };
    b.place(pickAt().spots[0]);
    expect(useUI.getState().hint).toBe('Turncoat: choose 1 more hex on the board to take a raider from');
    b.place(pickAt().spots[0]);
    expect(pickAt().chosen).toHaveLength(2);
    expect(useUI.getState().hint).toBe('Turncoat: choose 2 hexes on the board to lead the raiders to');
    b.place(pickAt().spots[0]);
    expect(act).not.toHaveBeenCalled();
    const [from, to] = [pickAt().chosen![0], [...pickAt().chosen![1], pickAt().spots[0]]];
    b.place(pickAt().spots[0]);
    const made = act.mock.calls[0]?.[0] as Turncoat;
    expect(stagesOf(made)!.stages.map((x) => [...x].sort())).toEqual([[...from].sort(), [...to].sort()]);
    expect(useUI.getState().interaction.kind).toBe('idle');
  });

  it('keeps what’s chosen when the game moves on and it still fits, and starts again when it doesn’t', () => {
    const s = owing('turncoat', (x) => {
      const c = coast(x);
      x.ext.invasion!.raiders[c[1]] = 1;
      x.ext.invasion!.raiders[c[4]] = 2;
    });
    useUI.getState().set({ view: s });
    startStagedPick('Turncoat', legalActions(s, 0));
    const first = (useUI.getState().interaction as { spots: number[] }).spots[0];
    input().b.place(first);
    const p = Object.create(Presenter.prototype) as Presenter;
    Object.assign(p, { me: 0, host: { isBot: () => false, scripted: false }, syncMarkers: vi.fn() });
    p.updateInteraction({ ...s, seq: s.seq + 1 });
    expect(useUI.getState().interaction).toMatchObject({ kind: 'pick', chosen: [[first]] });
    // The raider chosen is gone (an ambush, say): the pick starts again from what's there (here,
    // with two raided hexes left, a source stage that fills itself in).
    const moved = structuredClone(s);
    moved.ext.invasion!.raiders[first] = 0;
    p.updateInteraction(moved);
    const fresh = stagedStep(legalActions(moved, 0), [[]])!;
    expect(useUI.getState().interaction).toMatchObject({ kind: 'pick', chosen: fresh.chosen, spots: fresh.spots });
    expect(fresh.chosen[0]).not.toContain(first);
  });
});

describe('the muster card', () => {
  it('is sold where the development card would be, at its price, and only with Invasion alone', () => {
    const s = owing('levy');
    expect(cardForSale(s)).toBe('muster');
    expect(cardForSale(game(['guilds', 'garrisons', 'invasion']))).toBeNull();
    expect(cardForSale(game([]))).toBe('dev');
    // Bought: seat 0 back in the main phase with the price in hand.
    const t = patch(s, (x) => {
      x.pending = [];
      grant(x, 0, { wool: 1, wheat: 1, ore: 1 });
    });
    useUI.getState().set({ view: t });
    expect(availability()?.dev).toBe(true);
    buyDevCard();
    expect(session.act).toHaveBeenCalledWith({ type: 'invasion/buy' });
  });

  it('leaves the generic panel nothing of Invasion’s but the march', () => {
    const s = owing('turncoat');
    expect(legalModuleActions(s, 0).filter((a) => !coveredTypes(s).has(a.type))).toEqual([]);
  });

  it('is answered in the dock by its painting, what it does, and a pick on the board', () => {
    const show = (s: GameState) => {
      useUI.getState().set({ view: s });
      return renderToStaticMarkup(createElement(MusterDecision));
    };
    const levy = show(owing('levy'));
    expect(levy).toContain('art/muster/levy.webp');
    expect(levy).toMatch(/Choose the castle edge \(\d+\)/);
    expect(show(owing('turncoat'))).toContain('Choose the raiders on the board');
    // A turncoat with one raided hex: the other raider comes from the supply, and the page says so.
    const lone = owing('turncoat', (x) => {
      x.ext.invasion!.raiders.fill(0);
      x.ext.invasion!.raiders[coast(x)[3]] = 2;
      x.ext.invasion!.supply = RAIDERS - 2;
    });
    expect(show(lone)).toContain('One comes from the supply');
    useUI.getState().set({ me: 1 });
    expect(show(owing('levy'))).toBe('');
  });
});

describe('the coast page', () => {
  it('puts the worst first, and says what a landing or the wardens would do', () => {
    // (Hexes with a number, so each row can be found by its disc.)
    const numbered = (x: GameState) => coast(x).filter((h) => x.board.hexes[h].numbers.length > 0);
    const s = owing('levy', (x) => {
      const c = numbered(x);
      x.ext.invasion!.raiders.fill(0);
      x.ext.invasion!.raiders[c[2]] = 1;
      x.ext.invasion!.raiders[c[5]] = 3;
      x.ext.invasion!.raiders[c[7]] = 2;
      x.ext.invasion!.supply = RAIDERS - 6;
      // Two wardens on the conquered hex's edges: strength 2 of the 4 it needs.
      const edges = x.board.hexes[c[5]].edges;
      x.wardens = [0, 1].map((k) => ({ id: 90 + k, owner: k, rank: 1 as const, mustered: true, vertex: null, edge: edges[k * 3], musteredTurn: 0 }));
      x.nextWardenId = 92;
    });
    useUI.getState().set({ view: s });
    const html = renderToStaticMarkup(createElement(Coast));
    expect(html).toContain('On the coast · 6 raiders');
    const at = (h: number) => html.indexOf(`>${s.board.hexes[h].numbers.join('/')}</b>`);
    const [low, fallen, near] = [numbered(s)[2], numbered(s)[5], numbered(s)[7]];
    expect(at(fallen)).toBeGreaterThan(0);
    expect(at(fallen)).toBeLessThan(at(near));
    expect(at(near)).toBeLessThan(at(low));
    expect(html).toContain('Conquered: wardens 2 of the 4 needed');
    expect(html).toMatch(/One more (landing on \d+|raider) conquers it/);
    expect(html).toContain(`${RAIDERS - 6} of ${RAIDERS} raiders still to come`);
  });
});
