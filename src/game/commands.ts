// Player commands shared by the HUD buttons and keyboard shortcuts.

import { CARDS, canAfford, canUndo, devCardsInGame, legalCities, legalRoads, legalSettlements, type Action, type Card, type GameState, type Resource } from '../engine';
import { musterDeckInPlay } from '../engine/modules/invasion/raids';
import { MAIN_HINT, useUI } from './store';
import { extraBuilds, type ExtraBuildKey } from './builds';
import { spotOf } from './moduleActions';
import { session } from '../app/session';
import { sfx } from '../audio/sfx';

export type BuildKind = 'road' | 'settlement' | 'city';

/**
 * The card the build bar sells in this game: a development card, or with Invasion alone a muster
 * card, whose deck replaces them at the same price (and is played the moment it's bought). Null
 * when neither is in play (the guilds' ventures come from their tracks, not a purchase).
 */
export function cardForSale(s: GameState): 'dev' | 'muster' | null {
  if (s.ext.invasion && musterDeckInPlay(s)) return 'muster';
  return devCardsInGame(s) ? 'dev' : null;
}

/** What the local player can do right now (used to enable buttons and shortcuts). */
export function availability() {
  const { view, me, busy } = useUI.getState();
  // (Watching a replay or a bots' game, nothing is the player's to do.)
  if (!view || view.pending.length > 0 || session.presenter?.spectating) return null;
  const mine = view.currentPlayer === me && !busy;
  const main = mine && view.phase === 'main';
  const p = view.players[me];
  return {
    mine,
    main,
    roll: mine && view.phase === 'roll',
    road: main && canAfford(view, me, 'road') && p.roadsLeft > 0 && legalRoads(view, me).length > 0,
    settlement: main && canAfford(view, me, 'settlement') && legalSettlements(view, me).length > 0,
    city: main && canAfford(view, me, 'city') && legalCities(view, me).length > 0,
    dev: main && canAfford(view, me, 'devCard') && (cardForSale(view) === 'muster' || view.devDeck.length > 0),
    // Taking back the last piece you placed (never a bot's, when spectating).
    undo: !busy && canUndo(view, me) && !session.presenter?.spectating,
  };
}

/** Enter (or leave) placement mode for a building type. */
export function toggleBuild(kind: BuildKind) {
  const store = useUI.getState();
  const { view, me, interaction } = store;
  if (!view) return;
  if (interaction.kind === kind) {
    cancelPlacement();
    return;
  }
  const a = availability();
  if (!a?.[kind]) return;
  sfx.play('click');
  const spots = kind === 'road' ? legalRoads(view, me) : kind === 'settlement' ? legalSettlements(view, me) : legalCities(view, me);
  // (The status line gives way to what to tap, which the dock or the actions say.)
  store.set({ interaction: { kind, spots }, hint: store.hint === MAIN_HINT ? '' : store.hint });
  session.presenter?.syncMarkers();
}

/**
 * Choose where to put an expansion's build (game/builds.ts), a pick on the board of the spots its
 * moves are made at; pressed again while choosing, put the pick away. Nothing happens when it can't
 * be built: the caller says why.
 */
export function toggleExtraBuild(key: ExtraBuildKey) {
  const store = useUI.getState();
  const { view, me, interaction } = store;
  const b = view ? extraBuilds(view, me).find((x) => x.key === key) : undefined;
  if (!b) return;
  if (interaction.kind === 'pick' && interaction.label === b.label) {
    store.set({ interaction: { kind: 'idle' }, choice: null });
    session.presenter?.syncMarkers();
    return;
  }
  if (!b.actions.length || store.busy) return;
  sfx.play('click');
  const spots = [...new Set(b.actions.map((a) => spotOf(a, b.target)).filter((v) => v >= 0))];
  store.set({ interaction: { kind: 'pick', target: b.target, spots, label: b.label, actions: b.actions }, choice: null, hint: b.hint });
  session.presenter?.syncMarkers();
}

type OilInvention = Extract<Action, { type: 'oil/invention' }>;

/**
 * The move an Invention's picks make: the base card's, or with oil among them (Oil) the one of the
 * engine's oil moves that takes the same cards, whatever their order; null when none does.
 */
export function inventionMove(picks: readonly Card[], oil: readonly OilInvention[]): Action | null {
  if (!picks.includes('oil')) return { type: 'playInvention', resources: [...picks] as Resource[] };
  const same = (a: readonly Card[]) => a.length === picks.length && CARDS.every((k) => a.filter((x) => x === k).length === picks.filter((x) => x === k).length);
  return oil.find((a) => same(a.cards)) ?? null;
}

/** The move a Hoarder naming `kind` makes: the base card's, or naming oil, the engine's oil move (Oil). */
export const monopolyMove = (kind: Card): Action => (kind === 'oil' ? { type: 'oil/monopoly' } : { type: 'playMonopoly', resource: kind as Resource });

/** Leave an optional placement mode (never cancels mandatory ones like set-up or the robber). */
export function cancelPlacement(): boolean {
  const store = useUI.getState();
  const k = store.interaction.kind;
  if (k !== 'road' && k !== 'settlement' && k !== 'city') return false;
  if (k === 'road' && store.interaction.free) return false;
  // (Back in your turn with nothing to place, the status line says what's open again.)
  const main = store.view?.phase === 'main' && store.view.currentPlayer === store.me && store.hint === '';
  store.set({ interaction: { kind: 'idle' }, ...(main ? { hint: MAIN_HINT } : {}) });
  session.presenter?.syncMarkers();
  session.view?.showGhost(null);
  return true;
}

export function rollDice() {
  if (!availability()?.roll) return;
  sfx.play('click');
  session.act({ type: 'rollDice' });
}

/** Takes back the last road, settlement or city you placed. */
export function undoLast() {
  if (!availability()?.undo) return;
  cancelPlacement();
  sfx.play('click');
  session.act({ type: 'undo' });
}

/** Buy the game's card: a development card, or a muster card (see `cardForSale`). */
export function buyDevCard() {
  const view = useUI.getState().view;
  if (!view || !availability()?.dev) return;
  sfx.play('click');
  session.act(cardForSale(view) === 'muster' ? { type: 'invasion/buy' } : { type: 'buyDevCard' });
}

let disarm: ReturnType<typeof setTimeout> | null = null;

/** Ends the turn; with "confirm before ending turn" on, the first call only arms it. */
export function endTurn() {
  if (!availability()?.main) return;
  const store = useUI.getState();
  if (store.settings.confirmEndTurn && !store.endArmed) {
    store.set({ endArmed: true });
    if (disarm) clearTimeout(disarm);
    disarm = setTimeout(() => useUI.getState().set({ endArmed: false }), 2500);
    return;
  }
  if (disarm) clearTimeout(disarm);
  store.set({ endArmed: false });
  cancelPlacement();
  sfx.play('click');
  session.act({ type: 'endTurn' });
}

/** `beforeRoll`: open it on the roll too (the Supply tab's fish deals are legal then). */
export function openModal(modal: 'trade' | 'bank', beforeRoll = false) {
  const a = availability();
  if (!(a?.main || (beforeRoll && a?.roll))) return;
  sfx.play('click');
  useUI.getState().set({ modal });
}
