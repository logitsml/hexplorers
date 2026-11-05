// Oil's actions: burning, foundries, sequestering, and the base Monopoly and Invention played for
// oil. (A theft names oil through the core's steal: rules.ts canTakeOil.)

import { cards, emptyCards } from '../../constants';
import { assert, fail, moveCards, validIndex, type Ctx } from '../../ctx';
import { hasResources } from '../../rules';
import type { Action, Card, DevCardType, GameState, PlayerId } from '../../types';
import { RESOURCES } from '../../types';
import {
  BURN_YIELD,
  FOUNDRIES,
  FOUNDRY_COST,
  FOUNDRY_TRACK,
  OIL_LIMIT,
  STEWARD_AT,
  TRACK_MAX,
  canBuildFoundry,
  canSequester,
  canUseOil,
  foundriesBuilt,
  foundrySites,
  oilOf,
  oilRoom,
} from './rules';
import type { OilAction } from './types';

const isResource = (x: unknown): x is (typeof RESOURCES)[number] => (RESOURCES as readonly unknown[]).includes(x);

export function handleOil(ctx: Ctx, player: PlayerId, action: Action) {
  const s = ctx.s;
  const st = oilOf(s);
  const me = s.players[player];
  const a = action as OilAction;
  switch (a.type) {
    case 'oil/burn': {
      assert(s.phase === 'main' && s.currentPlayer === player, 'You can burn oil only on your turn, after rolling.');
      assert(isResource(a.get), 'Burning oil buys a resource.');
      assert(me.hand.oil > 0, 'You have no oil.');
      assert(!st.sequesteredThisTurn, 'You sequestered oil this turn: you cannot burn any.');
      assert(st.track + 1 <= TRACK_MAX, 'The disaster track is full: no more oil can be burned this turn.');
      assert(s.bank[a.get] >= BURN_YIELD, `The supply has fewer than ${BURN_YIELD} ${a.get}.`);
      moveCards(ctx, player, null, cards({ oil: 1 }), 'burn');
      moveCards(ctx, null, player, cards({ [a.get]: BURN_YIELD }), 'burn');
      st.track++;
      st.usedThisTurn = true;
      ctx.emit({ type: 'oil/burned', player, get: a.get, track: st.track });
      return;
    }
    case 'oil/foundry': {
      assert(s.phase === 'main' && s.currentPlayer === player, 'You can build a foundry only on your turn, after rolling.');
      assert(validIndex(a.vertex, s.board.vertices.length), 'Invalid intersection.');
      const b = s.buildings[a.vertex];
      assert(b && b.owner === player && b.kind === 'city', 'A foundry goes under one of your towns.');
      assert(!b.foundry, 'That town already has a foundry.');
      assert(foundrySites(s, player).includes(a.vertex), b.seat ? 'A town holds a seat or a foundry, not both.' : 'Not allowed here.');
      assert(foundriesBuilt(s) < FOUNDRIES, 'Every foundry is built.');
      assert(hasResources(me.hand, FOUNDRY_COST), 'A foundry costs a brick, a wheat, an ore and 2 oil.');
      assert(!st.sequesteredThisTurn, 'You sequestered oil this turn: you cannot use any.');
      assert(st.track + FOUNDRY_TRACK <= TRACK_MAX, 'A foundry would take the disaster track past 5.');
      moveCards(ctx, player, null, FOUNDRY_COST, 'foundry');
      b.foundry = true;
      st.track += FOUNDRY_TRACK;
      st.usedThisTurn = true;
      ctx.emit({ type: 'oil/foundryBuilt', player, vertex: a.vertex, track: st.track });
      return;
    }
    case 'oil/sequester': {
      assert(s.phase === 'main' && s.currentPlayer === player, 'You can sequester oil only on your turn, after rolling.');
      assert(me.hand.oil > 0, 'You have no oil.');
      assert(!st.sequesteredThisTurn, 'One oil a turn may be sequestered.');
      assert(!st.usedThisTurn, 'You used oil this turn: you cannot sequester any.');
      me.hand.oil--;
      st.sequestered[player]++;
      st.sequesteredThisTurn = true;
      ctx.emit({ type: 'oil/sequestered', player, total: st.sequestered[player] });
      // The first to three takes the Steward; anyone who then has strictly more takes it from them.
      const holder = st.steward;
      const mine = st.sequestered[player];
      if (holder !== player && mine >= STEWARD_AT && (holder === null || mine > st.sequestered[holder])) {
        st.steward = player;
        ctx.emit({ type: 'oil/stewardChanged', from: holder, to: player });
      }
      return;
    }
    case 'oil/monopoly': {
      playCard(s, player, 'monopoly');
      ctx.emit({ type: 'devCardPlayed', player, card: 'monopoly' });
      // All the others' oil if there's room for it; otherwise one from each in turn, from the next
      // player clockwise, until full.
      const taken: Record<number, number> = {};
      const n = s.players.length;
      const others = Array.from({ length: n - 1 }, (_, i) => (player + 1 + i) % n);
      const left = s.players.map((p) => p.hand.oil);
      let room = oilRoom(s, player);
      let moved = true;
      while (moved && room > 0) {
        moved = false;
        for (const o of others) {
          if (room === 0) break;
          if (left[o] === 0) continue;
          left[o]--;
          room--;
          taken[o] = (taken[o] ?? 0) + 1;
          moved = true;
        }
      }
      for (const o of others) if (taken[o]) moveCards(ctx, o, player, cards({ oil: taken[o] }), 'monopoly');
      ctx.emit({ type: 'oil/monopoly', player, taken });
      return;
    }
    case 'oil/invention': {
      assert(Array.isArray(a.cards) && Array.from(a.cards).every((c) => c === 'oil' || isResource(c)), 'Invalid cards.');
      const want = inventionCount(s, player);
      assert(a.cards.length === want, `Choose ${want} card${want === 1 ? '' : 's'}.`);
      const req = emptyCards();
      for (const c of a.cards) req[c]++;
      assert(req.oil > 0, 'Name oil, or play Invention as usual.');
      assert(req.oil <= oilRoom(s, player), `You may hold at most ${OIL_LIMIT} oil.`);
      assert(hasResources(s.bank, req), 'The supply does not have those cards.');
      playCard(s, player, 'invention');
      ctx.emit({ type: 'devCardPlayed', player, card: 'invention' });
      moveCards(ctx, null, player, req, 'invention');
      ctx.emit({ type: 'oil/invention', player, cards: [...a.cards] });
      return;
    }
    default:
      fail(`Unknown action ${(a as { type: string }).type}`);
  }
}

/**
 * Play a development card as the base game would (once a turn, on your turn, not on the turn it
 * was bought). This mirrors the base checks in reducer.ts, which name only resources.
 */
function playCard(s: GameState, player: PlayerId, type: DevCardType) {
  const me = s.players[player];
  assert(s.phase === 'roll' || s.phase === 'main', `Not allowed during ${s.phase}.`);
  assert(player === s.currentPlayer, 'It is not your turn.');
  assert(!s.devCardPlayedThisTurn, 'One development card a turn.');
  const idx = me.devCards.findIndex((c) => c.type === type && c.boughtTurn < s.turn);
  assert(idx >= 0, me.devCards.some((c) => c.type === type) ? 'You cannot play a card on the turn you built it.' : 'You do not have that card.');
  me.devCards.splice(idx, 1);
  me.playedDevCards.push(type);
  s.devCardPlayedThisTurn = true;
}

/** Cards an Invention naming oil takes: two, or fewer if the supply and the player's room can't give two. */
function inventionCount(s: GameState, player: PlayerId): number {
  let open = Math.min(s.bank.oil, oilRoom(s, player));
  for (const r of RESOURCES) open += s.bank[r];
  return Math.min(2, open);
}

/** Whether `player` could play a development card of `type` now. */
function cardPlayable(s: GameState, player: PlayerId, type: DevCardType): boolean {
  if (s.currentPlayer !== player || s.devCardPlayedThisTurn || (s.phase !== 'roll' && s.phase !== 'main')) return false;
  return s.players[player].devCards.some((c) => c.type === type && c.boughtTurn < s.turn);
}

export function legalOil(s: GameState, player: PlayerId): Action[] {
  if (s.phase === 'gameOver' || s.pending.length > 0 || s.currentPlayer !== player) return [];
  const out: Action[] = [];
  const me = s.players[player];
  if (s.phase === 'moveRobber') {
    return out;
  }
  if (s.phase === 'main') {
    if (me.hand.oil > 0 && canUseOil(s, player, 1)) for (const get of RESOURCES) if (s.bank[get] >= BURN_YIELD) out.push({ type: 'oil/burn', get });
    if (canBuildFoundry(s, player)) for (const vertex of foundrySites(s, player)) out.push({ type: 'oil/foundry', vertex });
    if (canSequester(s, player)) out.push({ type: 'oil/sequester' });
  }
  if (cardPlayable(s, player, 'monopoly')) out.push({ type: 'oil/monopoly' });
  if (cardPlayable(s, player, 'invention')) {
    const want = inventionCount(s, player);
    const oil = Math.min(s.bank.oil, oilRoom(s, player));
    if (want >= 1 && oil >= 1) {
      if (want === 1) out.push({ type: 'oil/invention', cards: ['oil'] });
      else {
        if (oil >= 2) out.push({ type: 'oil/invention', cards: ['oil', 'oil'] });
        for (const r of RESOURCES) if (s.bank[r] >= 1) out.push({ type: 'oil/invention', cards: ['oil', r] as Card[] });
      }
    }
  }
  return out;
}
