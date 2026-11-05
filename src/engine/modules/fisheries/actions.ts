// Fish actions, the swap at the limit and passing the boot: what is legal, and doing it.

import { cards } from '../../constants';
import { assert, fail, moveCards, validIndex, type Ctx } from '../../ctx';
import { modulesOf, hasModule } from '../../modules';
import { doSteal } from '../../reducer';
import { canTakeOil, freeRouteOpen, publicVictoryPoints, robbable, stealableCount, theftChoices } from '../../rules';
import type { Action, GameState, PlayerId } from '../../types';
import { RESOURCES } from '../../types';
import type { RuleModule } from '../api';
import { corsairHex, setCorsair } from '../shared';
import { fisheriesOf, payments, removeToken, runQueue, spend, validPayment, drawOne } from './fish';
import { fishCosts, newFisheries, FISH_COSTS, type FishBuy, type FisheriesAction, type Token } from './types';

/** The module whose deck replaces the development cards, if any (rule 3: the first in module order). */
function deckReplacer(s: GameState): { module: RuleModule; decks: string[] } | null {
  for (const m of modulesOf(s)) {
    const decks = m.hooks?.freeCardDecks?.(s);
    if (decks !== undefined) return { module: m, decks };
  }
  return null;
}

/** Where seven fish can get a card from: deck names, or [undefined] for the base deck; empty if nowhere. */
export function cardChoices(s: GameState): (string | undefined)[] {
  const r = deckReplacer(s);
  if (r) return r.decks;
  return s.devDeck.length > 0 ? [undefined] : [];
}

/** The blockers on the board that fish can send away. */
function blockersOnBoard(s: GameState): ('robber' | 'corsair')[] {
  const out: ('robber' | 'corsair')[] = [];
  if (s.robberHex !== null) out.push('robber');
  if (hasModule(s, 'sea') && corsairHex(s) !== null) out.push('corsair');
  return out;
}

/** Players `player` may steal from with fish: anyone else holding a card a theft can take, or oil they may name. */
function fishVictims(s: GameState, player: PlayerId): PlayerId[] {
  return s.players.filter((p) => p.id !== player && robbable(s, player, p.id)).map((p) => p.id);
}

/** Players who may take the boot from `player`: anyone with more points showing (the first rules: at least as many). */
function bootTakers(s: GameState, player: PlayerId): PlayerId[] {
  const mine = publicVictoryPoints(s, player);
  const strict = newFisheries(s);
  return s.players.filter((p) => p.id !== player && (strict ? publicVictoryPoints(s, p.id) > mine : publicVictoryPoints(s, p.id) >= mine)).map((p) => p.id);
}

/** Whether `player` may take a fish action or pass the boot now: their own turn, before or after rolling, with nothing owed. */
function onOwnTurn(s: GameState, player: PlayerId): boolean {
  return player === s.currentPlayer && (s.phase === 'roll' || s.phase === 'main') && s.pending.length === 0;
}

export function legalFisheries(s: GameState, player: PlayerId): Action[] {
  const f = fisheriesOf(s);
  const top = s.pending[s.pending.length - 1];
  if (top) {
    if (top.kind !== 'fisheries/swap' || top.players[0] !== player) return [];
    const out: FisheriesAction[] = [{ type: 'fisheries/swap', give: null }];
    for (const v of new Set(f.tokens[player])) out.push({ type: 'fisheries/swap', give: v });
    return out;
  }
  if (!onOwnTurn(s, player)) return [];
  const out: FisheriesAction[] = [];
  if (f.boot === player) for (const to of bootTakers(s, player)) out.push({ type: 'fisheries/passBoot', to });

  const hand = f.tokens[player];
  const pays = (cost: number) => payments(hand, cost);
  const costs = fishCosts(s);
  for (const pay of pays(costs.blocker)) for (const blocker of blockersOnBoard(s)) out.push({ type: 'fisheries/blocker', pay, blocker });
  for (const pay of pays(costs.steal)) for (const victim of fishVictims(s, player)) for (const t of theftChoices(s, player, victim)) out.push({ type: 'fisheries/steal', pay, ...t });
  for (const pay of pays(costs.take)) for (const resource of RESOURCES) if (s.bank[resource] > 0) out.push({ type: 'fisheries/take', pay, resource });
  // (Whether a route has somewhere to go is the costly question: asked only of a hand that could pay.)
  const routePays = pays(costs.route);
  if (routePays.length > 0 && freeRouteOpen(s, player)) for (const pay of routePays) out.push({ type: 'fisheries/route', pay });
  for (const pay of pays(costs.card)) {
    for (const deck of cardChoices(s)) out.push(deck === undefined ? { type: 'fisheries/card', pay } : { type: 'fisheries/card', pay, deck });
  }
  return out;
}

export function handleFisheries(ctx: Ctx, player: PlayerId, action: Action) {
  const s = ctx.s;
  const f = fisheriesOf(s);
  const a = action as FisheriesAction;

  if (a.type === 'fisheries/swap') {
    const top = s.pending[s.pending.length - 1];
    assert(top?.kind === 'fisheries/swap' && top.players[0] === player, 'You have no fish to swap.');
    if (a.give !== null) {
      assert(f.tokens[player].includes(a.give as Token), 'You do not have that token.');
      removeToken(f.tokens[player], a.give);
      f.discard.push(a.give);
      f.swapTurn[player] = s.turn;
      ctx.emit({ type: 'fisheries/swapped', player, returned: a.give });
      drawOne(ctx, player);
    }
    s.pending.pop();
    runQueue(ctx);
    return;
  }

  assert(player === s.currentPlayer, 'It is not your turn.');
  assert(s.pending.length === 0, 'Another decision has to be made first.');
  assert(s.phase === 'roll' || s.phase === 'main', `Not allowed during ${s.phase}.`);

  if (a.type === 'fisheries/passBoot') {
    assert(f.boot === player, 'You do not have the Soggy Boot.');
    assert(validIndex(a.to, s.players.length) && a.to !== player, 'Invalid player.');
    assert(bootTakers(s, player).includes(a.to), newFisheries(s) ? 'The boot goes only to a player with more points than you.' : 'The boot goes only to a player with at least as many points as you.');
    f.boot = a.to;
    ctx.emit({ type: 'fisheries/bootPassed', from: player, to: a.to });
    return;
  }

  // Every other action is a fish action: pay for it in full, with no token to spare.
  const buy = a.type.slice('fisheries/'.length) as FishBuy;
  assert(Object.prototype.hasOwnProperty.call(FISH_COSTS, buy), 'That is not part of this game.');
  const cost = fishCosts(s)[buy];
  assert(validPayment(f.tokens[player], a.pay, cost), `Pay ${cost} fish from your tokens, with none to spare.`);
  const tokens = [...a.pay];

  switch (a.type) {
    case 'fisheries/blocker': {
      assert(blockersOnBoard(s).includes(a.blocker), a.blocker === 'robber' ? 'The robber is not on the board.' : 'The corsair is not on the board.');
      spend(ctx, player, tokens, 'blocker');
      let from: number;
      if (a.blocker === 'robber') {
        from = s.robberHex!;
        s.robberHex = null;
      } else {
        from = corsairHex(s)!;
        setCorsair(s, null);
      }
      ctx.emit({ type: 'fisheries/blockerRemoved', player, blocker: a.blocker, from });
      return;
    }
    case 'fisheries/steal': {
      assert(validIndex(a.victim, s.players.length) && fishVictims(s, player).includes(a.victim), 'You cannot steal from that player.');
      assert(a.oil ? canTakeOil(s, player, a.victim) : stealableCount(s, a.victim) > 0, a.oil ? 'You have no room for their oil.' : 'They have no card to take.');
      spend(ctx, player, tokens, 'steal');
      doSteal(ctx, player, a.victim, !!a.oil, 'fish');
      return;
    }
    case 'fisheries/take': {
      assert(RESOURCES.includes(a.resource), 'Choose a resource.');
      assert(s.bank[a.resource] > 0, `The supply has no ${a.resource} left.`);
      spend(ctx, player, tokens, 'take');
      moveCards(ctx, null, player, cards({ [a.resource]: 1 }), 'fish');
      ctx.emit({ type: 'fisheries/took', player, resource: a.resource });
      return;
    }
    case 'fisheries/route': {
      assert(freeRouteOpen(s, player), 'You have nowhere to build a road.');
      spend(ctx, player, tokens, 'route');
      // The free-route interlude Road Crew opens, for one piece: the base game places a road, and
      // Sea Lanes a ship, in the same 'roadBuilding' phase (its free-ship action and canPlaceFreeRoute).
      s.freeRoadsLeft = 1;
      s.resumePhase = s.hasRolled ? 'main' : 'roll';
      s.phase = 'roadBuilding';
      return;
    }
    case 'fisheries/card': {
      const r = deckReplacer(s);
      if (r) {
        assert(typeof a.deck === 'string' && r.decks.includes(a.deck), 'Choose a deck that still has cards.');
        spend(ctx, player, tokens, 'card');
        r.module.hooks!.dealFreeCard!(ctx, player, a.deck);
        return;
      }
      assert(a.deck === undefined, 'There is only the one deck.');
      assert(s.devDeck.length > 0, 'The development deck is empty.');
      spend(ctx, player, tokens, 'card');
      const card = s.devDeck.pop()!;
      s.players[player].devCards.push({ type: card, boughtTurn: s.turn });
      ctx.emit({ type: 'fisheries/card', player, card });
      return;
    }
    default:
      fail(`Unknown action ${(action as Action).type}`);
  }
}
