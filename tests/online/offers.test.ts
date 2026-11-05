// Trade answers that name their offer (the stale race): an answer to an offer that was settled or
// replaced is refused, not taken for an answer to the next; an answer that names none (every
// recorded game's) answers whatever is open, as it always has.

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, mustApply, type Action, type GameState } from '../../src/engine';
import { beginnerGame, grant, rc, toMain } from '../helpers';
import { setups } from '../sim-harness';
import { keyed, playGame } from './play';

function offered(): GameState {
  let s = beginnerGame();
  toMain(s, 0);
  grant(s, 0, { wheat: 2 });
  grant(s, 1, { brick: 2 });
  s = mustApply(s, 0, { type: 'offerTrade', give: rc({ wheat: 1 }), get: rc({ brick: 1 }) }).state;
  return s;
}

const ANSWERS = ['respondTrade', 'counterTrade', 'acceptTrade', 'cancelTrade'];

describe('offer ids', () => {
  it('refuse an answer to an offer that was replaced or settled', () => {
    let s = offered();
    const first = s.trade!.id;
    // The proposer withdraws and offers again: an answer to the first now lands nowhere.
    s = mustApply(s, 0, { type: 'cancelTrade', offer: first }).state;
    expect(applyAction(s, 1, { type: 'respondTrade', accept: true, offer: first })).toEqual({ ok: false, error: 'That offer is no longer open.' });
    s = mustApply(s, 0, { type: 'offerTrade', give: rc({ wheat: 1 }), get: rc({ brick: 2 }) }).state;
    const second = s.trade!.id;
    expect(second).not.toBe(first);
    const stale = applyAction(s, 1, { type: 'respondTrade', accept: true, offer: first });
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.error).toMatch(/replaced: offer \d+ is open now/);
    expect(applyAction(s, 1, { type: 'counterTrade', give: rc({ brick: 1 }), get: rc({ wheat: 1 }), offer: first }).ok).toBe(false);
    expect(applyAction(s, 0, { type: 'cancelTrade', offer: first }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'respondTrade', accept: true, offer: 'x' } as unknown as Action)).toEqual({ ok: false, error: 'Invalid offer id.' });
    // The open one's answers go through, named or not.
    s = mustApply(s, 1, { type: 'respondTrade', accept: true, offer: second }).state;
    expect(applyAction(s, 0, { type: 'acceptTrade', partner: 1, offer: first }).ok).toBe(false);
    expect(applyAction(s, 0, { type: 'acceptTrade', partner: 1 }).ok).toBe(true);
    s = mustApply(s, 0, { type: 'acceptTrade', partner: 1, offer: second }).state;
    expect(s.trade).toBeNull();
    expect(applyAction(s, 1, { type: 'respondTrade', accept: false, offer: second }).ok).toBe(false);
  });

  it('are what a keyed game’s bots answer with; a local game’s answer as they always have', () => {
    const answers = (online: boolean) => {
      const g = online ? playGame('keyed trades', 41, keyed(41).options, keyed(41).secret) : playGame('local trades', 41, {});
      return g.steps.filter((st) => ANSWERS.includes(st.action.type)).map((st) => ({ action: st.action as Action & { offer?: number }, open: st.before.trade!.id }));
    };
    const online = answers(true);
    expect(online.length).toBeGreaterThan(10);
    for (const a of online) expect(a.action.offer).toBe(a.open);
    const local = answers(false);
    expect(local.length).toBeGreaterThan(5);
    for (const a of local) expect(a.action).not.toHaveProperty('offer');
  }, 1_800_000);

  it('change nothing else: a keyed game’s log replays the same with them taken out', () => {
    const g = playGame('replay', 42, keyed(42).options, keyed(42).secret);
    let s = createGame(setups(4), { layout: 'random', seed: 42, ...keyed(42).options }, keyed(42).secret).state;
    for (const st of g.steps) {
      const { offer: _, ...bare } = st.action as Action & { offer?: number };
      s = mustApply(s, st.actor, bare as Action).state;
    }
    expect(s).toEqual(g.final);
  }, 1_800_000);
});
