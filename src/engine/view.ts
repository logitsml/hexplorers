// Redaction for networked play: what a given seat is allowed to know.

import type { GameOptions, GameState, PlayerId } from './types';
import { cloneState } from './reducer';
import { tradeReadiness } from './actions';
import { modulesOf } from './modules';
import { redactTracker, trackedKinds } from './tracker';

/**
 * Returns a copy of the state with information hidden from `viewer`:
 * other players' hidden cards (only the hand's size remains visible: the resources and
 * commodities as one count, which this puts under ore; oil is held face up), their unplayed
 * development cards (only how many, and how many of them were bought this turn), the order of the
 * development and event decks, what other seats alone know about hands (the cards they stole or
 * lost), and whatever each module keeps secret. `viewer = null` produces a spectator view. The
 * stream is withheld too: a keyed game's keys (rngKey) never leave, nor where the stream
 * stands (rngState), nor an unkeyed game's seed (with it and the action log a client could rebuild
 * the deck order, future dice and every hand). A keyed game's seed only varies the scenery and
 * stays. So is the board the options carry, which holds what lies under the fog (the state's own
 * board is what the table sees).
 */
export function redactState(state: GameState, viewer: PlayerId | null): GameState {
  const s = cloneState(state);
  // Only accepted offers and volunteered counters expose their present validity. Recompute it
  // before hiding the hands, so the proposer can still act without learning their composition.
  if (s.trade) s.trade.readiness = tradeReadiness(state);
  s.options = publicOptions(s.options);
  delete s.rngKey;
  s.devDeck = s.devDeck.map(() => 'knight');
  s.rngState = 0;
  if (s.eventCards) s.eventCards = s.eventCards.map(() => 0);
  s.tracker = redactTracker(state, viewer);
  const hidden = trackedKinds(state);
  for (const p of s.players) {
    if (p.id === viewer) continue;
    let total = 0;
    for (const k of hidden) {
      total += p.hand[k];
      p.hand[k] = 0;
    }
    p.hand.ore = total;
    // (Only whether each was bought this turn, which says whether it may be played yet, and in that
    // order: otherwise the purchase that vanished would say which card was played.)
    p.devCards = p.devCards.map((c) => ({ type: 'knight' as const, boughtTurn: c.boughtTurn === s.turn ? s.turn : 0 })).sort((a, b) => a.boughtTurn - b.boughtTurn);
  }
  for (const m of modulesOf(s)) m.hooks?.redact?.(s, viewer);
  // The state a take-back would return to hides the same things.
  if (s.undo) s.undo = { player: s.undo.player, before: redactState(s.undo.before, viewer) };
  return s;
}

const publicOptionsOf = new WeakMap<GameOptions, GameOptions>();

/** Options as a view carries them: without their board, and an unkeyed game's without its seed (kept, so views share it). */
function publicOptions(o: GameOptions): GameOptions {
  const keyed = o.rng === 'chacha20';
  if ((keyed || o.seed === 0) && o.board === undefined) return o;
  let p = publicOptionsOf.get(o);
  if (!p) {
    const { board: _carried, ...rest } = o;
    publicOptionsOf.set(o, (p = { ...rest, seed: keyed ? o.seed : 0 }));
  }
  return p;
}
