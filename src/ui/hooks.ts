import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUI } from '../game/store';
import { CARDS, emptyCards, type GameState, type PlayerId, type CardCounts } from '../engine';

/**
 * The game view for a dialog. Dialogs only open during a game, but one that is animating out
 * keeps rendering; if the game was cleared meanwhile it keeps the last view instead of crashing.
 */
export function useDialogView(): GameState {
  const view = useUI((s) => s.view);
  const last = useRef(view);
  if (view) last.current = view;
  return last.current!;
}

// The hand and the supply are picked out count by count (and compared that way), so the many
// things that show them re-render when a count changes, not on every new game state.

/** Displayed hand of a player (presented state + in-flight adjustments). */
export function useHand(player: PlayerId): CardCounts {
  return useUI(
    useShallow((s) => {
      const base = s.view?.players[player]?.hand;
      const delta = s.handDelta[player];
      const out = emptyCards();
      if (!base) return out;
      for (const r of CARDS) out[r] = Math.max(0, base[r] + (delta?.[r] ?? 0));
      return out;
    }),
  );
}

export function useBank(): CardCounts {
  return useUI(
    useShallow((s) => {
      const delta = s.handDelta[-1];
      const out = emptyCards();
      if (!s.view) return out;
      for (const r of CARDS) out[r] = Math.max(0, s.view.bank[r] + (delta?.[r] ?? 0));
      return out;
    }),
  );
}

/** The seats' names and colours, which a new game state almost never changes. */
export function useSeats(): { name: string; color: string }[] {
  return useUI(useShallow((s) => s.view?.players.map((p) => `${p.color}\n${p.name}`) ?? [])).map((k) => {
    const i = k.indexOf('\n');
    return { color: k.slice(0, i), name: k.slice(i + 1) };
  });
}

/** Cards held, of every kind (commodities and oil count toward a hand's size too). */
export const total = (rc: CardCounts) => CARDS.reduce((n, r) => n + rc[r], 0);

/**
 * Whether `value` has changed since the component first drew it: a flash that marks a change
 * (points gained, a card in hand) waits for one, rather than going off as the panel first shows
 * at the start of a game, a resumed one, or a phone's chip opening.
 */
export function useChanged<T>(value: T): boolean {
  const first = useRef(value);
  const changed = useRef(false);
  if (!changed.current && !Object.is(value, first.current)) changed.current = true;
  return changed.current;
}

/**
 * Escape closes a popover or sheet (unless a dialog over it takes the key), and only that: it takes
 * the key first and marks it handled, so the build being placed behind it isn't cancelled too
 * (app/keys.ts).
 */
export function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || useUI.getState().modal) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', k, { capture: true });
    return () => window.removeEventListener('keydown', k, { capture: true });
  }, [open]);
}
