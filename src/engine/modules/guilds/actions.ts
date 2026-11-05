// The guilds' actions: improving, playing ventures, and answering the decisions the ventures and
// abilities leave owed. `legalGuilds` lists exactly what `handleGuilds` accepts.

import { type Ctx, assert, fail, validIndex } from '../../ctx';
import { built } from '../../reducer';
import { isLegalRoad, legalRoads } from '../../rules';
import { placeShip, shipSpots } from '../shared';
import type { Action, Card, GameState, PlayerId, Resource } from '../../types';
import { COMMODITIES, RESOURCES } from '../../types';
import { freePieces, invaded, placeWarden, wardenById, wardensChanged, wardensOf } from '../garrisons/wardens';
import type { WardenRank } from '../garrisons/types';
import { anyDeck, drawVenture, returnVenture, takeFromHand } from './deck';
import { improve, improveOptions } from './improve';
import { TRACKS, VENTURE_LIMIT, guildsOf, guildsPending, owe, owedBy } from './rules';
import type { GuildsAction, GuildsPending, VentureId } from './types';
import { VENTURES, moveKind, paramsKey, paramsOf, plantRanks, plantSpots, treacheryRemove, ventureCards, ventureKinds } from './ventures';

/** The decision on top of the stack, popped. */
const resolved = (s: GameState) => s.pending.pop();

/** A main-phase action of the player whose turn it is, with nothing owed. */
function requireMain(s: GameState, player: PlayerId) {
  assert(s.pending.length === 0, 'Another decision has to be made first.');
  assert(player === s.currentPlayer, 'It is not your turn.');
  assert(s.phase === 'main', `Not allowed during ${s.phase}.`);
}

/** Kinds a give may hand over. */
const givable = (s: GameState, only: 'cards' | 'commodities'): Card[] => (only === 'commodities' ? [...COMMODITIES] : ventureKinds(s));

const holdsAny = (s: GameState, p: PlayerId, kinds: readonly Card[]) => kinds.some((k) => s.players[p].hand[k] > 0);

/** The distinct ventures in a hand (actions are per card kind, not per copy). */
const distinct = (hand: readonly string[]): VentureId[] => [...new Set(hand)].filter((c) => c !== 'hidden') as VentureId[];

export function handleGuilds(ctx: Ctx, player: PlayerId, a: GuildsAction) {
  const s = ctx.s;
  const g = guildsOf(s);
  switch (a.type) {
    case 'guilds/improve':
      requireMain(s, player);
      improve(ctx, player, a);
      return;

    case 'guilds/play': {
      const def = VENTURES[a.card];
      assert(def && def.play, 'You cannot play that card on its own.');
      assert(s.pending.length === 0, 'Another decision has to be made first.');
      assert(player === s.currentPlayer, 'It is not your turn.');
      assert(s.phase === (def.beforeRoll ? 'roll' : 'main'), def.beforeRoll ? 'Play it before you roll.' : 'Ventures are played after the roll.');
      assert(g.hands[player].includes(a.card), 'You do not have that card.');
      const params = paramsOf(a);
      const err = def.validate
        ? def.validate(s, player, params)
        : def.options!(s, player).some((o) => paramsKey(o) === paramsKey(params))
          ? null
          : 'You cannot play that card like that.';
      assert(err === null, err ?? '');
      takeFromHand(s, player, a.card);
      returnVenture(s, a.card);
      ctx.emit({ type: 'guilds/played', player, card: a.card });
      def.play(ctx, player, params);
      return;
    }

    case 'guilds/discardVenture': {
      assert(owedBy(s, player, 'guilds/ventureLimit'), 'You do not need to discard a venture.');
      assert(g.hands[player].includes(a.card), 'You do not have that card.');
      takeFromHand(s, player, a.card);
      returnVenture(s, a.card);
      ctx.emit({ type: 'guilds/ventureDiscarded', player, track: VENTURES[a.card].track });
      if (g.hands[player].length <= VENTURE_LIMIT) resolved(s);
      return;
    }

    case 'guilds/give': {
      const d = owedBy(s, player, 'guilds/give');
      assert(d, 'You owe nobody a card.');
      const kinds = givable(s, d.only);
      assert(kinds.includes(a.card) && s.players[player].hand[a.card] > 0, 'You cannot give that.');
      moveKind(ctx, player, d.to, a.card, 1, d.reason);
      d.left--;
      if (d.left <= 0 || !holdsAny(s, player, kinds)) resolved(s);
      return;
    }

    case 'guilds/discardCard': {
      const d = owedBy(s, player, 'guilds/discard');
      assert(d, 'You do not need to discard.');
      assert(ventureKinds(s).includes(a.card) && s.players[player].hand[a.card] > 0, 'You cannot discard that.');
      moveKind(ctx, player, null, a.card, 1, 'unrest');
      d.left--;
      if (d.left <= 0 || ventureCards(s, player) === 0) resolved(s);
      return;
    }

    case 'guilds/take': {
      const d = owedBy(s, player, 'guilds/tribute');
      assert(d, 'There is nothing for you to take.');
      assert(ventureKinds(s).includes(a.card) && s.players[d.target].hand[a.card] > 0, 'They do not have that.');
      moveKind(ctx, d.target, player, a.card, 1, 'tribute');
      d.seen[a.card]--;
      d.left--;
      if (d.left <= 0 || ventureCards(s, d.target) === 0) resolved(s);
      return;
    }

    case 'guilds/takeVenture': {
      const d = owedBy(s, player, 'guilds/spy');
      assert(d, 'There is nothing for you to take.');
      if (a.card !== null) {
        assert(g.hands[d.target].includes(a.card), 'They do not have that card.');
        takeFromHand(s, d.target, a.card);
        g.hands[player].push(a.card);
        ctx.emit({ type: 'guilds/ventureTaken', thief: player, victim: d.target, card: a.card });
      }
      resolved(s);
      return;
    }

    case 'guilds/pick': {
      const d = owedBy(s, player, 'guilds/pick');
      assert(d, 'There is nothing for you to pick.');
      if (a.resource === null) assert(RESOURCES.every((r) => s.bank[r] === 0), 'Pick a resource.');
      else {
        assert(RESOURCES.includes(a.resource) && s.bank[a.resource] > 0, 'The supply has none of that.');
        moveKind(ctx, null, player, a.resource, 1, d.salvage ? 'salvage' : 'learning');
      }
      resolved(s);
      return;
    }

    case 'guilds/draw': {
      assert(owedBy(s, player, 'guilds/drawChoice'), 'You have no venture to draw.');
      if (a.track === null) assert(!anyDeck(s), 'Choose a deck.');
      else assert(TRACKS.includes(a.track) && g.decks[a.track].length > 0, 'That deck is empty.');
      resolved(s);
      if (a.track !== null) drawVenture(ctx, player, a.track);
      return;
    }

    case 'guilds/offer': {
      const d = owedBy(s, player, 'guilds/barter');
      assert(d, 'You have no barter to make.');
      const to = d.queue[0];
      if (a.resource !== null) {
        assert(RESOURCES.includes(a.resource) && s.players[player].hand[a.resource] > 0, 'You do not have that.');
        assert(holdsAny(s, to, COMMODITIES), 'They have no commodity to give.');
      }
      d.queue.shift();
      if (d.queue.length === 0) resolved(s);
      if (a.resource !== null) {
        moveKind(ctx, player, to, a.resource, 1, 'barter');
        owe(s, to, { kind: 'guilds/give', to: player, left: 1, only: 'commodities', reason: 'barter' });
      }
      return;
    }

    case 'guilds/rebuild': {
      const d = owedBy(s, player, 'guilds/rebuild');
      assert(d, 'You have no road to rebuild.');
      if (a.edge !== null) {
        assert(validIndex(a.edge, s.board.edges.length), 'Invalid edge.');
        if (d.ship) assert(shipSpots(s, player).includes(a.edge), 'A ship must join your own ship or building, on open water.');
        else assert(s.players[player].roadsLeft > 0 && isLegalRoad(s, player, a.edge), 'A road must connect to your own road or building.');
      }
      resolved(s);
      if (a.edge !== null && d.ship) {
        // (A ship taken by a right of way comes back as a ship.)
        placeShip(s, player, a.edge);
        ctx.emit({ type: 'sea/shipBuilt', player, edge: a.edge, free: true, setup: false });
        built(ctx, player, 'ship', a.edge, true);
      } else if (a.edge !== null) {
        s.routes[a.edge] = { owner: player, kind: 'road', builtTurn: s.turn };
        s.players[player].roadsLeft--;
        ctx.emit({ type: 'roadBuilt', player, edge: a.edge, free: true });
        built(ctx, player, 'road', a.edge, true);
      }
      return;
    }

    case 'guilds/surrender': {
      const d = owedBy(s, player, 'guilds/surrender');
      assert(d, 'You have no warden to give up.');
      const w = wardenById(s, a.warden);
      assert(w && w.owner === player && (w.vertex !== null || w.edge !== null), 'That is not one of your wardens on the board.');
      resolved(s);
      treacheryRemove(ctx, d.thief, w.id);
      return;
    }

    case 'guilds/plant': {
      const d = owedBy(s, player, 'guilds/plant');
      assert(d, 'You have no warden to place.');
      if (a.rank === 0) {
        assert(a.vertex === null, 'Invalid placement.');
        resolved(s);
        return;
      }
      assert(plantRanks(s, player, d.rank).includes(a.rank as WardenRank), 'You cannot place a warden of that rank.');
      const spots = plantSpots(s, player, d.edge);
      if (invaded(s)) assert(a.vertex === null && spots.length > 0, 'Your warden takes the edge the other left.');
      else assert(a.vertex !== null && spots.includes(a.vertex), 'Your warden must stand on an empty intersection beside your routes.');
      resolved(s);
      const w = placeWarden(s, player, a.rank as WardenRank, invaded(s) ? { vertex: null, edge: d.edge } : { vertex: a.vertex, edge: null }, d.mustered);
      ctx.emit({ type: 'garrisons/placed', player, warden: w.id, rank: w.rank, vertex: w.vertex, edge: w.edge });
      wardensChanged(ctx);
      return;
    }

    default: {
      const never: never = a;
      fail(`Unknown action ${(never as Action).type}`);
    }
  }
}

/** The answers `player` may give to the guilds' decision on top of the stack. */
function answers(s: GameState, player: PlayerId, d: GuildsPending): Action[] {
  const g = guildsOf(s);
  const hand = s.players[player].hand;
  switch (d.kind) {
    case 'guilds/ventureLimit':
      return distinct(g.hands[player]).map((card) => ({ type: 'guilds/discardVenture', card }));
    case 'guilds/give':
      return givable(s, d.only)
        .filter((k) => hand[k] > 0)
        .map((card) => ({ type: 'guilds/give', card }));
    case 'guilds/discard':
      return ventureKinds(s)
        .filter((k) => hand[k] > 0)
        .map((card) => ({ type: 'guilds/discardCard', card }));
    // (What the venture let the player see, which a view redacted for them still carries; the
    // target's own hand is hidden there.)
    case 'guilds/tribute':
      return ventureKinds(s)
        .filter((k) => d.seen[k] > 0)
        .map((card) => ({ type: 'guilds/take', card }));
    case 'guilds/spy':
      return [...distinct(d.seen).map((card): Action => ({ type: 'guilds/takeVenture', card })), { type: 'guilds/takeVenture', card: null }];
    case 'guilds/pick': {
      const open = RESOURCES.filter((r) => s.bank[r] > 0);
      return open.length > 0 ? open.map((resource): Action => ({ type: 'guilds/pick', resource })) : [{ type: 'guilds/pick', resource: null }];
    }
    case 'guilds/drawChoice': {
      const open = TRACKS.filter((t) => g.decks[t].length > 0);
      return open.length > 0 ? open.map((track): Action => ({ type: 'guilds/draw', track })) : [{ type: 'guilds/draw', track: null }];
    }
    case 'guilds/barter': {
      const out: Action[] = [{ type: 'guilds/offer', resource: null }];
      // The recorded queue names opponents who can give a commodity. Nothing changes their
      // commodities before this offer, so their hidden hand need not be consulted again.
      for (const r of RESOURCES) if (hand[r] > 0) out.push({ type: 'guilds/offer', resource: r as Resource });
      return out;
    }
    case 'guilds/rebuild': {
      const out: Action[] = [{ type: 'guilds/rebuild', edge: null }];
      if (d.ship) for (const edge of shipSpots(s, player)) out.push({ type: 'guilds/rebuild', edge });
      else if (s.players[player].roadsLeft > 0) for (const edge of legalRoads(s, player)) out.push({ type: 'guilds/rebuild', edge });
      return out;
    }
    case 'guilds/surrender':
      return wardensOf(s, player)
        .filter((w) => w.vertex !== null || w.edge !== null)
        .map((w) => ({ type: 'guilds/surrender', warden: w.id }));
    case 'guilds/plant': {
      const out: Action[] = [{ type: 'guilds/plant', rank: 0, vertex: null }];
      const spots = plantSpots(s, player, d.edge);
      for (const rank of plantRanks(s, player, d.rank)) {
        if (freePieces(s, player, rank) <= 0) continue;
        if (invaded(s)) {
          if (spots.length > 0) out.push({ type: 'guilds/plant', rank, vertex: null });
        } else for (const vertex of spots) out.push({ type: 'guilds/plant', rank, vertex });
      }
      return out;
    }
  }
}

/** Ventures `player` could play now, every way each can be played. */
export function ventureActions(s: GameState, player: PlayerId): Action[] {
  const out: Action[] = [];
  const before = s.phase === 'roll';
  for (const card of distinct(guildsOf(s).hands[player])) {
    const def = VENTURES[card];
    if (!def.play || !!def.beforeRoll !== before) continue;
    for (const params of def.options!(s, player)) out.push({ type: 'guilds/play', card, ...params });
  }
  return out;
}

export function legalGuilds(s: GameState, player: PlayerId): Action[] {
  const top = s.pending[s.pending.length - 1];
  if (top) return guildsPending(top) && top.players.includes(player) ? answers(s, player, top.data) : [];
  if (player !== s.currentPlayer) return [];
  if (s.phase === 'roll') return ventureActions(s, player);
  if (s.phase === 'main') return [...improveOptions(s, player), ...ventureActions(s, player)];
  return [];
}
