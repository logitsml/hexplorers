// Open offers: cards put up without asking anything in particular, and the others bid for them
// with counter-offers (the trade dialog's "Ask for bids"). Nobody can take one as it stands: that
// would be a gift.
import { describe, expect, it } from 'vitest';
import { RESOURCES, applyAction, isOpenOffer, legalActions, totalCards } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { apply, beginnerGame, grant, patch, rc, toMain } from './helpers';

function table() {
  const base = beginnerGame();
  const p = base.currentPlayer;
  const q = (p + 1) % 4;
  const s = patch(base, (x) => {
    toMain(x, p);
    grant(x, p, { ore: 3 });
    grant(x, q, { wool: 2, brick: 2 });
  });
  return { s, p, q };
}

describe('an open offer', () => {
  it('puts cards up asking nothing back, and only a bid can answer it', () => {
    const { s, p, q } = table();
    const st = apply(s, p, { type: 'offerTrade', give: rc({ ore: 1 }), get: rc({}) }).state;
    expect(isOpenOffer(st.trade!)).toBe(true);
    // Taking it as it stands would be a gift: refused, and not among the moves offered.
    expect(applyAction(st, q, { type: 'respondTrade', accept: true }).ok).toBe(false);
    expect(legalActions(st, q).some((a) => a.type === 'respondTrade' && a.accept)).toBe(false);
    expect(applyAction(st, q, { type: 'respondTrade', accept: false }).ok).toBe(true);
    // A bid must give something.
    expect(applyAction(st, q, { type: 'counterTrade', give: rc({}), get: rc({ ore: 1 }) }).ok).toBe(false);
    const bid = apply(st, q, { type: 'counterTrade', give: rc({ wool: 2 }), get: rc({ ore: 1 }) }).state;
    const before = structuredClone(bid.players);
    const r = apply(bid, p, { type: 'acceptTrade', partner: q, counter: true }).state;
    expect(r.players[p].hand.ore).toBe(before[p].hand.ore - 1);
    expect(r.players[p].hand.wool).toBe(before[p].hand.wool + 2);
    expect(r.players[q].hand.ore).toBe(before[q].hand.ore + 1);
    expect(r.trade).toBeNull();
  });

  it('is bid on by bots, never accepted, every bid legal and for the cards put up', () => {
    const red = 0;
    const blue = 1;
    let bids = 0;
    for (let i = 0; i < 80; i++) {
      const s0 = patch(beginnerGame(), (x) => {
        toMain(x, red);
        grant(x, red, { brick: 2, wood: 2, wool: 2, wheat: 2, ore: 2 });
        grant(x, blue, { wool: i % 3, wheat: (i >> 1) % 3, ore: (i >> 2) % 3, brick: (i >> 3) % 2 + 1, wood: (i >> 4) % 2 });
      });
      const give = rc({ [RESOURCES[i % 5]]: 1 + (i % 2) });
      const s = apply(s0, red, { type: 'offerTrade', give, get: rc({}) }).state;
      const a = botDecide(s, blue, createBotMemory({ waitForHumans: true }), 'normal');
      expect(a?.type === 'respondTrade' && a.accept).toBe(false);
      if (a?.type !== 'counterTrade') continue;
      bids++;
      expect(a.get).toEqual(give);
      expect(totalCards(a.give)).toBeGreaterThan(0);
      expect(totalCards(a.give)).toBeLessThanOrEqual(totalCards(give) + 1);
      const after = apply(s, blue, a).state;
      expect(after.trade!.counters[blue]).toEqual({ give: a.give, get: a.get });
    }
    expect(bids).toBeGreaterThan(0);
  });
});
