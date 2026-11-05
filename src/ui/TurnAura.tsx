// Whose turn it is, along the top of the screen: a hairline in that player's colour as a dusk
// tone (the same as the browser's bars take, see app/chromeTint.ts), easing from one player's to
// the next, with a light that runs along it once as the turn passes. Quiet by design: no bands of
// colour over the board, nothing that pulses. CSS on the compositor; hidden under a dialog.

import { useShallow } from 'zustand/react/shallow';
import { useUI } from '../game/store';
import { turnTone } from '../app/chromeTint';

export function TurnAura() {
  const aura = useUI(
    useShallow((s) => {
      const v = s.view;
      if (!v || s.replay || v.phase === 'gameOver') return { color: '', player: -1 };
      return { color: v.players[v.currentPlayer].color, player: v.currentPlayer };
    }),
  );
  const modal = useUI((s) => s.modal !== null);
  if (!aura.color) return null;
  return (
    <div className={`turn-aura${modal ? ' quiet' : ''}`} style={{ ['--aura' as string]: `#${turnTone(aura.color as never).getHexString()}` }} aria-hidden>
      {/* (Keyed on the player: a new turn runs the light along the line once.) */}
      <span key={aura.player} className="aura-sweep" />
    </div>
  );
}
