// The expansions' builds on the build bar (game/builds.ts): a ship, a bridge, a warden, a wall and a
// foundry, each there for the whole of a game whose module brings it, with its price and the reason
// it can't be built; a press is a pick on the board of the moves legalActions lists.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, mustApply, type GameState } from '../src/engine';
import { extraBuilds } from '../src/game/builds';
import { coveredTypes, legalModuleActions } from '../src/game/modulePanels';
import { toggleExtraBuild } from '../src/game/commands';
import { useUI } from '../src/game/store';
import { extraBuildReason } from '../src/ui/why';
import { game } from './modules/guilds-helpers';
import { grant, patch, toMain } from './helpers';
import { setups } from './sim-harness';
import type { Fixture } from './golden-modules';

vi.mock('../src/app/session', () => ({ session: {} }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));

const FILES = import.meta.glob('./fixtures/golden-modules/*.json', { eager: true, import: 'default' }) as Record<string, Fixture>;

beforeEach(() => useUI.getState().set({ view: null, me: 0, busy: false, replay: null, interaction: { kind: 'idle' }, choice: null }));

/** Seat 0's main phase in a game of these modules, its hand emptied, then `hand` granted. */
function mine(modules: Parameters<typeof game>[0], hand: Parameters<typeof grant>[2] = {}, fn: (x: GameState) => void = () => {}): GameState {
  return patch(game(modules), (x) => {
    toMain(x, 0);
    for (const k of Object.keys(x.players[0].hand) as (keyof typeof x.bank)[]) {
      x.bank[k] += x.players[0].hand[k];
      x.players[0].hand[k] = 0;
    }
    grant(x, 0, hand);
    fn(x);
  });
}

describe('the expansions’ builds', () => {
  it('are on the bar for every module that brings one, in their keys’ order', () => {
    const all = createGame(setups(4), { seed: 1, map: 'archipelago', modules: ['sea', 'guilds', 'garrisons', 'fleet', 'rivers', 'oil'], victoryPoints: 16 }).state;
    expect(extraBuilds(all, 0).map((b) => b.key)).toEqual(['ship', 'bridge', 'warden', 'wall', 'foundry']);
    expect(extraBuilds(game([]), 0)).toEqual([]);
    // (The panel of the expansions' moves leaves them to the bar.)
    for (const b of extraBuilds(all, 0)) expect(coveredTypes(all).has(b.type)).toBe(true);
  });

  it('say what they lack, pieces first, then the price, then somewhere to build', () => {
    const G = ['guilds', 'garrisons', 'fleet'] as const;
    const of = (s: GameState, key: string) => extraBuilds(s, 0).find((b) => b.key === key)!;
    expect(of(mine([...G]), 'warden').block).toEqual({ why: 'You need 1 wool and 1 ore more', note: 'need 1 wool, 1 ore' });
    const rich = mine([...G], { wool: 1, ore: 1, brick: 2 });
    expect(of(rich, 'warden')).toMatchObject({ block: null, target: 'vertex' });
    expect(of(rich, 'warden').actions.length).toBeGreaterThan(0);
    const full = mine([...G], { wool: 1, ore: 1 }, (x) => {
      for (let i = 0; i < 99 && extraBuilds(x, 0).find((b) => b.key === 'warden')!.block === null; i++) x.wardens.push({ id: 1000 + i, owner: 0, rank: 1, mustered: false, vertex: null, edge: null, musteredTurn: 0 });
    });
    expect(of(full, 'warden').block?.why).toBe('No recruit left: promote one of your wardens first');
    const noCity = mine([...G], { brick: 2 }, (x) => {
      for (const b of x.buildings) if (b?.owner === 0 && b.kind === 'city') b.wall = true;
    });
    expect(of(noCity, 'wall').block?.why).toBe('No town of yours without a wall');
  });

  it('count oil in a foundry’s price, and say when the track or a sequestering stops it', () => {
    const s = mine(['oil'], { brick: 1, wheat: 1, ore: 1, oil: 1 }, (x) => {
      const v = x.buildings.findIndex((b) => b?.owner === 0 && b.kind === 'settlement');
      x.buildings[v]!.kind = 'city';
    });
    const foundry = (t: GameState) => extraBuilds(t, 0).find((b) => b.key === 'foundry')!;
    expect(foundry(s).cost.oil).toBe(2);
    expect(foundry(s).block).toEqual({ why: 'You need 1 oil more', note: 'need 1 oil' });
    expect(foundry(patch(s, (x) => void (x.ext.oil!.sequesteredThisTurn = true))).block?.note).toBe('sequestered');
    expect(foundry(patch(s, (x) => void (x.ext.oil!.track = 4))).block?.why).toBe('It would take the disaster track past 5');
  });

  it('give a reason exactly when the engine offers no such move, through every recorded game', () => {
    let checked = 0;
    for (const f of Object.values(FILES)) {
      let s = createGame(setups(f.players), f.options, f.secret).state;
      for (const [i, [actor, action]] of f.log.entries()) {
        s = mustApply(s, actor, action).state;
        if (i % 7 !== 0 || s.phase !== 'main' || s.pending.length) continue;
        const me = s.currentPlayer;
        for (const b of extraBuilds(s, me)) {
          checked++;
          expect(b.block === null, `${f.id} at ${i + 1}: ${b.key} ${b.block?.why ?? 'unblocked'} with ${b.actions.length} moves`).toBe(b.actions.length > 0);
          expect(b.actions).toEqual(legalModuleActions(s, me).filter((a) => a.type === b.type));
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  }, 120_000);
});

describe('a build pressed', () => {
  it('is a pick on the board of where it may go, put away when pressed again, and says the turn’s reason first', () => {
    const s = mine(['guilds', 'garrisons', 'fleet'], { wool: 1, ore: 1 });
    useUI.getState().set({ view: s });
    const warden = extraBuilds(s, 0).find((b) => b.key === 'warden')!;
    expect(extraBuildReason(warden)).toEqual({ why: null, note: null });
    toggleExtraBuild('warden');
    expect(useUI.getState().interaction).toMatchObject({ kind: 'pick', label: 'Warden', target: 'vertex' });
    expect((useUI.getState().interaction as { spots: number[] }).spots.length).toBe(warden.actions.length);
    expect(useUI.getState().hint).toBe('Warden: choose a glowing corner beside your routes');
    toggleExtraBuild('warden');
    expect(useUI.getState().interaction.kind).toBe('idle');
    useUI.getState().set({ view: patch(s, (x) => void (x.currentPlayer = 1)) });
    const theirs = extraBuilds(useUI.getState().view!, 0).find((b) => b.key === 'warden')!;
    expect(extraBuildReason(theirs).why).toBe(`It's ${s.players[1].name}'s turn`);
    toggleExtraBuild('warden');
    expect(useUI.getState().interaction.kind).toBe('idle');
  });
});
