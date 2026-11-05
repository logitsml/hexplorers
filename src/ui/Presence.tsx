import { Suspense, lazy } from 'react';
import { useUI } from '../game/store';
import type { PlayerId } from '../engine';

// (With the rest of online play, loaded only when a game is online.)
const Dot = lazy(() => import('./online/Overlays').then((m) => ({ default: m.SeatPresence })));
const Menu = lazy(() => import('./online/safety/SeatMenu').then((m) => ({ default: m.PanelSeatMenu })));
const Extras = lazy(() => import('./online/Seat'));
const Clock = lazy(() => import('./online/Seat').then((m) => ({ default: m.ChipClock })));

/** Online, a dot on a player's face for whether they're here; nothing in a local game. */
export function Presence({ player }: { player: PlayerId }) {
  const online = useUI((s) => s.online !== null);
  if (!online) return null;
  return (
    <Suspense fallback={null}>
      <Dot player={player} />
    </Suspense>
  );
}

/** Online, another person's face opens their menu (profile, block, report); nothing in a local game. */
export function SeatMenu({ player }: { player: PlayerId }) {
  const online = useUI((s) => s.online !== null);
  if (!online) return null;
  return (
    <Suspense fallback={null}>
      <Menu player={player} />
    </Suspense>
  );
}

/** Online, under a panel's stats: the seat's clock, what they'd trade, and the hail (see online/Seat.tsx); nothing in a local game. */
export function SeatOnline({ player, anchor = true }: { player: PlayerId; anchor?: boolean }) {
  const online = useUI((s) => s.online !== null);
  if (!online) return null;
  return (
    <Suspense fallback={null}>
      <Extras player={player} anchor={anchor} />
    </Suspense>
  );
}

/** A phone's chip: online, the seat's clock where it has one, in place of `children` (the thinking dots). */
export function ChipClock({ player, children }: { player: PlayerId; children?: React.ReactNode }) {
  const online = useUI((s) => s.online !== null);
  if (!online) return <>{children}</>;
  return (
    <Suspense fallback={children}>
      <Clock player={player}>{children}</Clock>
    </Suspense>
  );
}
