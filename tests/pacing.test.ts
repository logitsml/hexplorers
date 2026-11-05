// The All Hands pacing defaults (game/pacing.ts), none of which changes a rule: a wagon auction
// passed for you when nowhere the wagon could go touches your pieces, a bounty or Learning pick taken
// in your preferred resource (both only once asked for, in Settings or by their switch), and a castle
// exit and a quake's road suggested, a press away, as the bot from your seat would choose them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAction, createGame, legalActions, mustApply, type Action, type GameState } from '../src/engine';
import { caravansOf, placements } from '../src/engine/modules/caravans/trains';
import { walkTargets } from '../src/engine/modules/invasion/wardens';
import { crackable } from '../src/engine/modules/almanac/happenings';
import { autoAnswer, suggestion, wagonTouches } from '../src/game/pacing';
import { DEFAULT_SETTINGS, useUI } from '../src/game/store';
import { Presenter } from '../src/game/presenter';
import { game } from './modules/guilds-helpers';
import { FOUR, patch, toMain } from './helpers';

vi.mock('../src/app/session', () => ({ session: {} }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));

beforeEach(() => useUI.getState().set({ view: null, me: 0, settings: { ...DEFAULT_SETTINGS }, interaction: { kind: 'idle' }, batch: [] }));

const ON = { autoPassWagon: true, pickResource: null };

/** A Wagon Trains game whose wagon auction asks seat `p` first (their turn ended with a wagon owed). */
function auctionFor(p: number): GameState {
  const s = patch(createGame(FOUR, { layout: 'beginner', seed: 7, modules: ['caravans'] }).state, (x) => {
    toMain(x, p);
    caravansOf(x).owed = true;
  });
  return mustApply(s, p, { type: 'endTurn' }).state;
}

describe('the wagon auction, passed for you', () => {
  it('passes only for a seat whose pieces no placement touches, and only when asked to', () => {
    let passed = 0;
    let kept = 0;
    for (let p = 0; p < 4; p++) {
      const s = auctionFor(p);
      expect(s.pending.at(-1)).toMatchObject({ kind: 'caravans/bid', players: [p] });
      const touches = placements(s).some((e) => s.routes[e]?.owner === p || [s.board.edges[e].a, s.board.edges[e].b].some((v) => s.buildings[v]?.owner === p));
      expect(wagonTouches(s, p)).toBe(touches);
      expect(autoAnswer(s, p, { ...ON, autoPassWagon: false })).toBeNull();
      const auto = autoAnswer(s, p, ON);
      if (touches) {
        expect(auto).toBeNull();
        kept++;
      } else {
        expect(auto?.action).toEqual({ type: 'caravans/pass' });
        expect(applyAction(s, p, auto!.action).ok).toBe(true);
        passed++;
      }
    }
    // (The beginner island has both kinds of seat at its first auction.)
    expect(passed).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
  });
});

describe('a pick taken in your preferred resource', () => {
  const learning = (fn: (x: GameState) => void = () => {}) =>
    patch(game(['guilds']), (x) => {
      toMain(x, 0);
      x.pending.push({ kind: 'guilds/pick', players: [0], data: { kind: 'guilds/pick' } });
      fn(x);
    });

  it('takes it when the supply has it, and asks when it doesn’t', () => {
    expect(autoAnswer(learning(), 0, { autoPassWagon: false, pickResource: 'wool' })?.action).toEqual({ type: 'guilds/pick', resource: 'wool' });
    expect(autoAnswer(learning(), 0, { autoPassWagon: false, pickResource: null })).toBeNull();
    expect(autoAnswer(learning((x) => void (x.bank.wool = 0)), 0, { autoPassWagon: false, pickResource: 'wool' })).toBeNull();
  });

  it('takes a bounty field’s two only when the supply has both', () => {
    const bounty = (wool: number) =>
      patch(createGame(FOUR, { seed: 3, map: 'archipelago', modules: ['sea'], victoryPoints: 14 }).state, (x) => {
        toMain(x, 0);
        x.setupIndex = x.setupOrder.length;
        x.bank.wool = wool;
        x.pending.push({ kind: 'sea/bountyPick', players: [0], data: { count: 2, reason: 'production' } });
      });
    expect(autoAnswer(bounty(5), 0, { autoPassWagon: false, pickResource: 'wool' })?.action).toEqual({ type: 'sea/pickBounty', resources: ['wool', 'wool'] });
    expect(autoAnswer(bounty(1), 0, { autoPassWagon: false, pickResource: 'wool' })).toBeNull();
  });

  it('is made by the presenter once, with a line at the table, and not again on the same state', () => {
    const s = learning();
    useUI.getState().set({ settings: { ...DEFAULT_SETTINGS, pickResource: 'ore' } });
    const submit = vi.fn((_p: number, _a: Action) => ({ ok: true }));
    const p = Object.create(Presenter.prototype) as Presenter;
    const log = vi.fn();
    Object.assign(p, { me: 0, host: { state: s, isBot: () => false, scripted: false, submit }, log, syncMarkers: vi.fn(), scheduleBots: vi.fn(), trackReplay: vi.fn() });
    const idle = () => (p as unknown as { afterIdle(): void }).afterIdle();
    idle();
    expect(submit).toHaveBeenCalledWith(0, { type: 'guilds/pick', resource: 'ore' });
    expect(log.mock.calls[0][1]).toContain('You take an ore with your Learning ability');
    idle();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('suggested answers', () => {
  it('suggest a castle exit for a warden that has to leave the castle, and nothing once none has to', () => {
    const s = patch(createGame(FOUR, { layout: 'random', seed: 11, modules: ['invasion'], victoryPoints: 12 }).state, (x) => {
      x.turn = 5;
      x.setupIndex = x.setupOrder.length;
      toMain(x, 0);
      const castle = x.board.hexes.find((h) => h.terrain === 'castle')!;
      x.wardens = [{ id: 7, owner: 0, rank: 1, edge: castle.edges[0], vertex: null, mustered: true, musteredTurn: 0 }];
      x.pending.push({ kind: 'invasion/march', players: [0], data: { acted: [] } });
    });
    const a = suggestion(s, 0);
    expect(a).toMatchObject({ type: 'invasion/march', warden: 7 });
    expect([...walkTargets(s, s.wardens[0]).keys()]).toContain((a as { edge: number }).edge);
    expect(legalActions(s, 0)).toContainEqual(a);
    const walked = patch(s, (x) => void (x.pending.at(-1)!.data as { acted: number[] }).acted.push(7));
    expect(suggestion(walked, 0)).toBeNull();
  });

  it('suggest the road a quake should crack, one of yours', () => {
    const s = patch(game(['almanac']), (x) => {
      toMain(x, 0);
      x.pending.push({ kind: 'almanac/quake', players: [0], data: { happening: 'quake' } });
    });
    const a = suggestion(s, 0);
    expect(a?.type).toBe('almanac/crack');
    expect(crackable(s, 0)).toContain((a as { edge: number }).edge);
    expect(suggestion(patch(s, (x) => void x.pending.pop()), 0)).toBeNull();
  });
});
