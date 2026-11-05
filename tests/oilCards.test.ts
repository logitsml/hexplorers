// Oil's Monopoly and Invention naming oil, made from the base game's dialogs (oil offered beside
// the resources) rather than as tiles in the expansions' panel: the move each choice makes is the
// engine's own (game/commands.ts `inventionMove`, `monopolyMove`).
import { describe, expect, it, vi } from 'vitest';
import { legalActions, mustApply, type Action, type GameState } from '../src/engine';
import { inventionMove, monopolyMove } from '../src/game/commands';
import { coveredTypes, legalModuleActions } from '../src/game/modulePanels';
import { game } from './modules/guilds-helpers';
import { patch, toMain } from './helpers';

vi.mock('../src/app/session', () => ({ session: {} }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));

type OilInvention = Extract<Action, { type: 'oil/invention' }>;

/** An Oil game in seat 0's main phase holding a Monopoly and an Invention bought last turn, with `oil` in hand. */
function holding(oil: number): GameState {
  return patch(game(['oil']), (x) => {
    x.turn = 4;
    toMain(x, 0);
    x.players[0].devCards.push({ type: 'invention', boughtTurn: 1 }, { type: 'monopoly', boughtTurn: 1 });
    x.bank.oil -= oil;
    x.players[0].hand.oil += oil;
    x.players[2].hand.oil += 2;
    x.bank.oil -= 2;
  });
}

const oilPlays = (s: GameState) => legalActions(s, 0).filter((a): a is OilInvention => a.type === 'oil/invention');

describe('an Invention naming oil', () => {
  it('makes the engine’s oil move for picks with oil, whatever their order, and the base card’s without', () => {
    const s = holding(0);
    const oil = oilPlays(s);
    expect(oil.length).toBeGreaterThan(1);
    const mixed = inventionMove(['wool', 'oil'], oil);
    expect(mixed).toEqual(oil.find((a) => a.cards.includes('wool')));
    expect(mustApply(s, 0, mixed!).state.players[0].hand).toMatchObject({ oil: 1, wool: s.players[0].hand.wool + 1 });
    expect(inventionMove(['oil', 'oil'], oil)).toEqual({ type: 'oil/invention', cards: ['oil', 'oil'] });
    expect(inventionMove(['brick', 'ore'], oil)).toEqual({ type: 'playInvention', resources: ['brick', 'ore'] });
  });

  it('has no move for more oil than you have room for', () => {
    const s = holding(3);
    const oil = oilPlays(s);
    expect(oil.every((a) => a.cards.filter((c) => c === 'oil').length === 1)).toBe(true);
    expect(inventionMove(['oil', 'oil'], oil)).toBeNull();
  });
});

describe('a Monopoly naming oil', () => {
  it('is the engine’s oil move, and takes the others’ oil', () => {
    const s = holding(0);
    expect(legalActions(s, 0)).toContainEqual(monopolyMove('oil'));
    // (All the others hold, as far as there's room for it: four at most.)
    const theirs = s.players.slice(1).reduce((n, p) => n + p.hand.oil, 0);
    expect(mustApply(s, 0, monopolyMove('oil')).state.players[0].hand.oil).toBe(Math.min(4, s.players[0].hand.oil + theirs));
    expect(monopolyMove('wheat')).toEqual({ type: 'playMonopoly', resource: 'wheat' });
  });

  it('leaves the expansions’ panel to the dialogs', () => {
    const s = holding(0);
    const covered = coveredTypes(s);
    expect(legalModuleActions(s, 0).filter((a) => !covered.has(a.type)).map((a) => a.type)).not.toContain('oil/monopoly');
    expect(covered.has('oil/invention')).toBe(true);
  });
});
