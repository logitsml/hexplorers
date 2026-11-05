import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOURCES, applyAction, cards, createGame, emptyTracker, trackEvents, type GameState, type Production } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { TableTalk } from '../src/game/chat';
import { useUI } from '../src/game/store';

const seats = [
  { name: 'You', color: 'red' as const, isBot: false },
  { name: 'Wren Ashdown', color: 'blue' as const, isBot: true },
  { name: 'Tobias Forge', color: 'white' as const, isBot: true },
];

/** The hands as they stand, as if every card had been seen arriving (so the tracker knows them). */
function known(state: GameState) {
  state.tracker = emptyTracker(state.players.length);
  const grants: Production[] = state.players.flatMap((p) => RESOURCES.filter((r) => p.hand[r] > 0).map((r) => ({ player: p.id, hex: 0, vertex: 0, resource: r, amount: p.hand[r] })));
  trackEvents(state, [{ type: 'production', total: 0, grants, blockedHexes: [], shortages: [] }]);
  return state;
}

describe('table talk', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUI.getState().set({ chat: [], chatUnread: 0, chatOpen: false });
  });
  afterEach(() => vi.useRealTimers());

  it('the player named answers a trade question from what they hold', () => {
    const { state } = createGame(seats, { seed: 3 });
    state.players[1].hand.ore = 3;
    known(state);
    const talk = new TableTalk(0, () => state);
    talk.hear('Wren, any ore to trade?');
    vi.advanceTimersByTime(5000);
    const chat = useUI.getState().chat;
    expect(chat).toHaveLength(1);
    expect(chat[0].player).toBe(1);
    expect(chat[0].text.toLowerCase()).toContain('ore');
    expect(useUI.getState().chatUnread).toBe(1);
  });

  it('says it has none to spare when it holds too few', () => {
    const { state } = createGame(seats, { seed: 3 });
    state.players[2].hand.wheat = 1;
    const talk = new TableTalk(0, () => state);
    talk.hear('Tobias, do you have wheat?');
    vi.advanceTimersByTime(5000);
    const [line] = useUI.getState().chat;
    expect(line.player).toBe(2);
    expect(line.text).toMatch(/no wheat|need my wheat/i);
  });

  it('on your turn, names a deal it would take, and takes it when you offer it', () => {
    // Wren is a wheat short of a city, with an ore to spare; you hold wheat.
    const { state: s0 } = createGame(seats, { seed: 3, layout: 'beginner' });
    const state: GameState = { ...s0, phase: 'main', currentPlayer: 0, hasRolled: true, turn: 3 };
    state.players[0].hand = cards({ brick: 1, wood: 1, wheat: 2 });
    state.players[1].hand = cards({ wheat: 1, ore: 4 });
    known(state);
    const talk = new TableTalk(0, () => state);
    talk.hear('Wren, any ore?');
    vi.advanceTimersByTime(5000);
    const [line] = useUI.getState().chat;
    expect(line.player).toBe(1);
    expect(line.offer).toBeDefined();
    expect(line.offer!.get).toMatchObject({ ore: 1 });
    expect(line.text).toMatch(/ore/);
    const r = applyAction(state, 0, { type: 'offerTrade', give: line.offer!.give, get: line.offer!.get, to: [1] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(botDecide(r.state, 1, createBotMemory({ waitForHumans: true }), 'normal')).toEqual({ type: 'respondTrade', accept: true });
  });

  it('never owns up to cards you could not know it holds', () => {
    // Wren's ore arrived unseen (say, stolen from someone else): asked for it, no deal is named.
    const { state: s0 } = createGame(seats, { seed: 3, layout: 'beginner' });
    const state: GameState = { ...s0, phase: 'main', currentPlayer: 0, hasRolled: true, turn: 3 };
    state.players[0].hand = cards({ brick: 1, wood: 1, wheat: 2 });
    state.players[1].hand = cards({ wheat: 1 });
    known(state);
    state.players[1].hand.ore = 4;
    const talk = new TableTalk(0, () => state);
    talk.hear('Wren, any ore?');
    vi.advanceTimersByTime(5000);
    const [line] = useUI.getState().chat;
    expect(line.player).toBe(1);
    expect(line.offer).toBeUndefined();
    expect(line.text).toMatch(/ore/i);
  });

  it('pitches its own offer to the table', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { state } = createGame(seats, { seed: 3 });
    const talk = new TableTalk(0, () => state);
    const none = cards({});
    talk.onEvent({ type: 'tradeOffered', offer: { id: 1, proposer: 2, give: { ...none, wool: 2 }, get: { ...none, ore: 1 }, to: [], responses: {}, counters: {} } });
    vi.advanceTimersByTime(5000);
    vi.restoreAllMocks();
    const [line] = useUI.getState().chat;
    expect(line.player).toBe(2);
    expect(line.text).toMatch(/2 wool/);
    expect(line.text).toMatch(/1 ore/);
  });

  it('stays quiet once disposed', () => {
    const { state } = createGame(seats, { seed: 3 });
    const talk = new TableTalk(0, () => state);
    talk.hear('hello Wren');
    talk.dispose();
    vi.advanceTimersByTime(5000);
    expect(useUI.getState().chat).toHaveLength(0);
  });
});
