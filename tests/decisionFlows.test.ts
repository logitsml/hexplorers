import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useUI } from '../src/game/store';
import { availability } from '../src/game/commands';
import { Presenter } from '../src/game/presenter';
import { BoardInput } from '../src/app/input';
import { PickBar } from '../src/ui/modules/PickBar';
import { moduleActions, groupActions, spotOf } from '../src/game/moduleActions';
import { game } from './modules/guilds-helpers';
import { toMain } from './helpers';
import type { Action, GameState } from '../src/engine';

// Server rendering normally uses Zustand's initial snapshot. Here the component reads the
// current test game, just as a mounted browser component does after a store update.
vi.mock('../src/game/store', async (original) => {
  const actual = await original<typeof import('../src/game/store')>();
  const use = Object.assign(<T,>(select: (s: ReturnType<typeof actual.useUI.getState>) => T) => select(actual.useUI.getState()), actual.useUI);
  return { ...actual, useUI: use };
});

vi.mock('../src/app/session', () => ({ session: {} }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));

/** Test the actual presenter update without starting its animation and bot scheduling loop. */
function presenter() {
  const p = Object.create(Presenter.prototype) as Presenter;
  Object.assign(p, { me: 0, host: { isBot: () => false, scripted: false }, syncMarkers: vi.fn() });
  return p;
}

/** Input's placement path needs no renderer: the test observes its submitted actions and markers. */
function input() {
  const b = Object.create(BoardInput.prototype) as BoardInput;
  const act = vi.fn(() => null);
  Object.assign(b, { presenter: { act, syncMarkers: vi.fn() }, view: { showMarkers: vi.fn() }, clearPending: vi.fn(), focus: vi.fn() });
  return { b: b as unknown as { place(id: number): void }, act };
}

beforeEach(() => useUI.getState().set({ view: null, me: 0, busy: false, choice: null, interaction: { kind: 'idle' }, replay: null, modal: null }));

describe('decisions across input, presentation and compact controls', () => {
  it('blocks every shortcut while any seat owes a decision', () => {
    const s = game(['guilds']);
    toMain(s, 0);
    useUI.getState().set({ view: s });
    expect(availability()?.main).toBe(true);
    for (const player of [0, 1]) {
      useUI.getState().set({ view: { ...s, pending: [{ kind: 'guilds/pick', players: [player] }] } });
      expect(availability()).toBeNull();
    }
  });

  it('preserves legal list actions across unrelated messages and removes only stale alternatives', () => {
    const s = game(['fisheries']);
    toMain(s, 0);
    const actions: Action[] = [{ type: 'fisheries/swap', give: null }, { type: 'fisheries/swap', give: 1 }];
    s.pending = [{ kind: 'fisheries/swap', players: [0] }];
    s.ext.fisheries!.tokens[0] = [1, 1, 1, 1, 1, 1, 1];
    useUI.getState().set({ view: s, choice: { title: 'Swap a fish token', actions } });
    const p = presenter();
    p.updateInteraction({ ...s, turn: s.turn + 1 });
    expect(useUI.getState().choice?.actions).toEqual(actions);
    expect(useUI.getState().hint).toContain('seven fish tokens');
    const changed = structuredClone(s);
    changed.ext.fisheries!.tokens[0] = [2, 2, 2, 2, 2, 2, 2];
    p.updateInteraction(changed);
    expect(useUI.getState().choice?.actions).toEqual([actions[0]]);
    p.updateInteraction({ ...changed, pending: [] });
    expect(useUI.getState().choice).toBeNull();
  });

  it('picks a ship first, then lights only that ship’s destinations before submitting a move', () => {
    const s = game(['sea']);
    const actions: Action[] = [
      { type: 'sea/moveShip', from: 1, to: 4 },
      { type: 'sea/moveShip', from: 1, to: 5 },
      { type: 'sea/moveShip', from: 2, to: 6 },
    ];
    const group = groupActions(actions, s)[0];
    useUI.getState().set({ view: s, interaction: { kind: 'pick', target: group.target!, actions, spots: [1, 2], source: group.source, label: group.label } });
    const { b, act } = input();
    b.place(1);
    expect(act).not.toHaveBeenCalled();
    expect(useUI.getState().interaction).toMatchObject({ source: false, spots: [4, 5], actions: actions.slice(0, 2) });
    b.place(5);
    expect(act).toHaveBeenCalledWith(actions[1]);
    expect(useUI.getState().interaction.kind).toBe('idle');
  });

  it('uses wardens’ actual edges as source picks and keeps the selected identity on refresh', () => {
    const s = game(['guilds', 'garrisons', 'invasion']);
    const e = s.board.edges.filter((e) => e.land).slice(0, 4).map((e) => e.id);
    s.wardens = [
      { id: 41, owner: 0, rank: 1, edge: e[0], vertex: null, mustered: false, musteredTurn: 0 },
      { id: 93, owner: 0, rank: 2, edge: e[1], vertex: null, mustered: false, musteredTurn: 0 },
    ];
    const actions: Action[] = [{ type: 'invasion/march', warden: 41, edge: e[2] }, { type: 'invasion/march', warden: 93, edge: e[2] }];
    const g = groupActions(actions, s)[0];
    expect(g.source).toBe(true);
    expect(g.actions.map((a) => spotOf(a, 'edge', s, true))).toEqual(e.slice(0, 2));
    useUI.getState().set({ view: s, interaction: { kind: 'pick', target: 'edge', spots: e.slice(0, 2), label: g.label, actions, source: true } });
    const { b, act } = input();
    b.place(e[1]);
    expect(useUI.getState().interaction).toMatchObject({ source: false, actions: [actions[1]], spots: [e[2]] });
    b.place(e[2]);
    expect(act).toHaveBeenCalledWith(actions[1]);
  });

  it('offers different victims at one destination after a warden source pick', () => {
    const s = game(['sea', 'guilds', 'garrisons']);
    s.players[1].name = 'Bram';
    s.players[2].name = 'Cora';
    const vertex = s.board.vertices.find((v) => v.land)!.id;
    const hex = s.board.hexes.find((h) => h.terrain !== 'sea')!.id;
    s.wardens = [{ id: 19, owner: 0, rank: 2, vertex, edge: null, mustered: true, musteredTurn: 0 }];
    const actions: Action[] = [
      { type: 'garrisons/chase', warden: 19, blocker: 'robber', hex, victim: 1 },
      { type: 'garrisons/chase', warden: 19, blocker: 'robber', hex, victim: 2 },
    ];
    useUI.getState().set({ view: s, interaction: { kind: 'pick', target: 'vertex', spots: [vertex], actions, label: 'Chase', source: true } });
    const { b, act } = input();
    b.place(vertex);
    expect(useUI.getState().interaction).toMatchObject({ target: 'hex', spots: [hex], source: false });
    b.place(hex);
    expect(act).not.toHaveBeenCalled();
    expect(useUI.getState().choice?.actions).toEqual(actions);
    const html = renderToStaticMarkup(createElement(PickBar));
    expect(html).toContain('from Bram');
    expect(html).toContain('from Cora');
  });

  it('renders colliding destination choices inside the visible phone pick strip', () => {
    const s = game(['fisheries']);
    const actions: Action[] = [{ type: 'fisheries/swap', give: 1 }, { type: 'fisheries/swap', give: null }];
    useUI.getState().set({ view: s, interaction: { kind: 'pick', target: 'edge', spots: [1], label: 'Choose a move', actions }, choice: { title: 'Several moves here', actions } });
    const html = renderToStaticMarkup(createElement(PickBar));
    expect(html).toContain('class="pickbar parchment"');
    expect(html).toContain('class="module-choice"');
    expect(html).toContain('Return a 1-fish token');
    expect(html).toContain('Keep my fish tokens');
    expect(html).toContain('several moves here: choose one below');
  });

  it('keeps a list of optional market buys open while all its actions remain legal', () => {
    const s: GameState = game(['rivers']);
    toMain(s, 0);
    s.players[0].coins = 4;
    const actions = moduleActions(s, 0).filter((a) => a.type === 'buyWithCoins');
    useUI.getState().set({ view: s, choice: { title: 'Buy with coins', actions } });
    presenter().updateInteraction({ ...s, turn: s.turn + 1 });
    expect(useUI.getState().choice?.actions).toEqual(actions);
  });
});
