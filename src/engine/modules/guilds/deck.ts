// The venture decks and hands: drawing, showing victory ventures, the hand limit, and the cards
// that go back under their decks.

import type { Ctx } from '../../ctx';
import type { Rng } from '../../rng';
import type { GameState, PlayerId, Track } from '../../types';
import { TRACKS, VENTURE_LIMIT, guildsOf, owe } from './rules';
import type { VentureCard, VentureId } from './types';
import { VENTURES, ventureCopies } from './ventures';

/** The three decks this game plays with, shuffled (cards that need the garrisons stay out without them). */
export function buildDecks(s: GameState, rng: Rng): Record<Track, VentureCard[]> {
  const decks = { learning: [], commerce: [], statecraft: [] } as Record<Track, VentureCard[]>;
  for (const [id, def] of Object.entries(VENTURES) as [VentureId, (typeof VENTURES)[VentureId]][]) {
    for (let i = 0; i < ventureCopies(s, def); i++) decks[def.track].push(id);
  }
  for (const t of TRACKS) rng.shuffle(decks[t]);
  return decks;
}

/** A venture goes back face down under its deck (played or discarded). */
export function returnVenture(s: GameState, card: VentureId) {
  guildsOf(s).decks[VENTURES[card].track].unshift(card);
}

/** Take `card` out of `player`'s hand (it must be there). */
export function takeFromHand(s: GameState, player: PlayerId, card: VentureId) {
  const hand = guildsOf(s).hands[player];
  hand.splice(hand.indexOf(card), 1);
}

/**
 * `player` draws the top card of `track`'s deck: a victory venture is shown at once, anything else
 * goes to the hand, and a player over the limit off their turn owes a discard straight away.
 * Returns the card, or null if the deck is empty.
 */
export function drawVenture(ctx: Ctx, player: PlayerId, track: Track): VentureId | null {
  const s = ctx.s;
  const g = guildsOf(s);
  const card = g.decks[track].pop() as VentureId | undefined;
  if (!card) return null;
  if (VENTURES[card].victory) {
    g.shown[player].push(card);
    ctx.emit({ type: 'guilds/shown', player, card });
  } else {
    g.hands[player].push(card);
    ctx.emit({ type: 'guilds/drew', player, track, card });
    if (player !== s.currentPlayer) checkVentureLimit(s, player);
  }
  return card;
}

/** A player over the venture limit owes a discard (once: the decision stays until they're back to four). */
export function checkVentureLimit(s: GameState, player: PlayerId) {
  if (guildsOf(s).hands[player].length <= VENTURE_LIMIT) return;
  if (s.pending.some((p) => p.kind === 'guilds/ventureLimit' && p.players.includes(player))) return;
  owe(s, player, { kind: 'guilds/ventureLimit' });
}

/** Whether any deck still has a card. */
export const anyDeck = (s: GameState): boolean => TRACKS.some((t) => guildsOf(s).decks[t].length > 0);

/**
 * Each of `players` draws a venture from the deck of their choice, in the order given (rule 3: anything
 * that grants a development card grants this). For other modules too: the fleet's tied defenders.
 */
export function oweVentureChoice(s: GameState, players: PlayerId[]) {
  if (!anyDeck(s)) return;
  // (The first to choose goes on top.)
  for (let i = players.length - 1; i >= 0; i--) owe(s, players[i], { kind: 'guilds/drawChoice' });
}
