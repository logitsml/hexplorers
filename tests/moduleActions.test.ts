import { describe as suite, expect, it } from 'vitest';
import { createGame, type Action } from '../src/engine';
import { describe, groupActions, humanize, isModuleAction, moduleActions, moveCost, refreshedPick, spotOf } from '../src/game/moduleActions';
import { FOUR, patch, toMain } from './helpers';
import { game, giveVenture } from './modules/guilds-helpers';

// The generic controls name and group whatever a module offers, so a module's moves are playable
// before it has controls of its own.
suite('generic module controls', () => {
  it('names moves from their types', () => {
    expect(humanize('sea/buildShip')).toBe('Build ship');
    expect(humanize('invasion/assignLandings')).toBe('Assign landings');
    expect(humanize('buyWithCoins')).toBe('Buy with coins');
  });

  it('offers module moves and the coin market, never the base game’s own', () => {
    expect(isModuleAction({ type: 'sea/buildShip', edge: 3 } as unknown as Action)).toBe(true);
    expect(isModuleAction({ type: 'buyWithCoins', get: 'wood' })).toBe(true);
    expect(isModuleAction({ type: 'buildRoad', edge: 3 })).toBe(false);
  });

  it('makes a pick on the board of moves that each name one spot, and a list of the rest', () => {
    const moves = [
      { type: 'sea/buildShip', edge: 4 },
      { type: 'sea/buildShip', edge: 9 },
      { type: 'sea/moveShip', from: 4, to: 5 },
      { type: 'oil/foundry', vertex: 12 },
      { type: 'x/raid', hex: 3, victim: 1 },
      { type: 'oil/burn', get: 'ore' },
    ] as unknown as Action[];
    const groups = Object.fromEntries(groupActions(moves).map((g) => [g.key, g]));
    expect(groups['sea/buildShip'].target).toBe('edge');
    expect(groups['sea/buildShip'].actions).toHaveLength(2);
    expect(groups['sea/moveShip'].target).toBe('edge');
    expect(groups['sea/moveShip'].source).toBe(true);
    expect(groups['oil/foundry'].target).toBe('vertex');
    expect(groups['x/raid'].target).toBe('hex');
    expect(groups['oil/burn'].target).toBeNull();
  });

  it('keeps each venture’s spots apart when a pick is refreshed: they are all guilds plays, told apart by their card', () => {
    const s = patch(game(['guilds']), (x) => {
      toMain(x, 0);
      giveVenture(x, 0, 'trader');
      giveVenture(x, 0, 'taxCollectors');
    });
    const plays = moduleActions(s, 0).filter((a) => a.type === 'guilds/play');
    const of = (card: string) => plays.filter((a) => (a as { card: string }).card === card);
    const trader = of('trader');
    const tax = of('taxCollectors');
    expect(trader.length).toBeGreaterThan(0);
    expect(tax.length).toBeGreaterThan(trader.length);
    // (The two share a type and a kind of spot; refreshing by type alone merged their hexes.)
    expect(refreshedPick(trader, plays, 'hex')).toEqual(trader);
    expect(refreshedPick(tax, plays, 'hex')).toEqual(tax);
    // A pick whose moves are fewer than before keeps to its own card, and ends once none is left.
    expect(refreshedPick(trader.slice(0, 1), plays, 'hex').every((a) => (a as { card: string }).card === 'trader')).toBe(true);
    expect(refreshedPick(trader, plays.filter((a) => (a as { card: string }).card !== 'trader'), 'hex')).toEqual([]);
    // Terms the pick left open (the same spot played different ways) stay open.
    const open = [{ type: 'x/raid', hex: 3, victim: 1 }, { type: 'x/raid', hex: 3, victim: 2 }] as unknown as Action[];
    const later = [{ type: 'x/raid', hex: 4, victim: 1 }, { type: 'x/raid', hex: 5, victim: 2 }, { type: 'x/other', hex: 4 }] as unknown as Action[];
    expect(refreshedPick(open, later, 'hex').map((a) => spotOf(a, 'hex'))).toEqual([4, 5]);
  });

  it('describes a move by its terms, with seats as names and cards by name', () => {
    const s = createGame(FOUR, { seed: 3 }).state;
    expect(describe(s, { type: 'x/raid', hex: 3, victim: 1 } as unknown as Action, 'hex')).toBe(s.players[1].name);
    expect(describe(s, { type: 'oil/burn', get: 'ore' } as unknown as Action)).toBe('Take 2 ore · 1 oil');
    expect(describe(s, { type: 'x/give', cards: { wood: 2, brick: 1, ore: 0 } } as unknown as Action)).toBe('2 wood, 1 brick');
    expect(describe(s, { type: 'oil/sequester' } as unknown as Action)).toBe('Sequester 1 oil');
  });

  it('names seats, fish payments, empty choices and the warden’s rank and place', () => {
    const s = game(['guilds', 'garrisons', 'invasion']);
    s.players[1].name = 'Bram';
    const edge = s.board.edges.find((e) => e.land)!.id;
    s.wardens = [{ id: 104, owner: 1, rank: 2, edge, vertex: null, mustered: true, musteredTurn: 0 }];
    expect(describe(s, { type: 'fisheries/passBoot', to: 1 })).toBe('Give the Soggy Boot to Bram');
    expect(describe(s, { type: 'fisheries/swap', give: null })).toBe('Keep my fish tokens');
    expect(describe(s, { type: 'guilds/offer', resource: null })).toBe('Offer nothing and pass');
    expect(describe(s, { type: 'fisheries/take', resource: 'ore', pay: [3, 2] })).toBe('Take 1 ore · 5 fish (tokens 3+2)');
    expect(describe(s, { type: 'garrisons/promote', warden: 104 })).toContain('Bram’s mustered guard');
    expect(describe(s, { type: 'garrisons/promote', warden: 104 })).not.toContain('104');
    expect(moveCost('fisheries/blocker')).toBe('2 fish');
  });

  it('keeps the selected ship fixed while refreshing its destinations', () => {
    const a: Action = { type: 'sea/moveShip', from: 3, to: 8 };
    const b: Action = { type: 'sea/moveShip', from: 3, to: 9 };
    const other: Action = { type: 'sea/moveShip', from: 4, to: 8 };
    expect(refreshedPick([a], [a, b, other], 'edge')).toEqual([a, b]);
    expect(spotOf(a, 'edge', undefined, true)).toBe(3);
    expect(spotOf(a, 'edge')).toBe(8);
  });

  it('offers nothing in the base game', () => {
    const s = createGame(FOUR, { seed: 3 }).state;
    expect(moduleActions(s, s.currentPlayer)).toEqual([]);
  });
});
