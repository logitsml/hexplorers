// "While you were away": what happened at the table while you weren't looking, in a few lines,
// with a way to put it by (it goes by itself after a while when it's your move, so you can get on
// with it). For a game you came back to after the link dropped or the phone slept (Overlays.tsx).

import { useEffect } from 'react';
import { motion } from 'motion/react';
import { sfx } from '../../audio/sfx';

/** How long the card stays up by itself when it's your move. */
export const AWAY_CARD_MS = 8000;

export function AwaySummary({ lines, onClose, yours }: { lines: string[]; onClose: () => void; yours: boolean }) {
  useEffect(() => {
    if (!yours) return;
    const t = setTimeout(onClose, AWAY_CARD_MS);
    return () => clearTimeout(t);
  }, [yours, lines]);
  return (
    <motion.section key="away" className="away-summary parchment" aria-label="While you were away" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
      <h4>While you were away</h4>
      <ul>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <button type="button" className="btn ghost small" onClick={() => (sfx.play('click'), onClose())}>
        Got it
      </button>
    </motion.section>
  );
}
