import { AnimatePresence, motion } from 'motion/react';
import { useUI } from '../game/store';
import { session } from '../app/session';
import type { Quality } from '../render/core/stage';
import { LineIcon } from './LineIcons';

const NAME: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };

/**
 * A preset's shaders compiling after a change in Settings: its progress, with Undo. (Auto suggests
 * no preset of its own: see app/autoQuality.ts.)
 */
export function QualityToast() {
  const progress = useUI((s) => s.qualityProgress);
  return (
    <AnimatePresence>
      {/* While a preset is prepared the island isn't drawn: the last frame stays, softly blurred,
          and play holds still underneath (nothing can be pressed but Undo). */}
      {progress && (
        <motion.div
          key="veil"
          className="quality-veil"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        />
      )}
      {progress && (
        <motion.div
          key="progress"
          className="quality-toast parchment"
          role="status"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
        >
          <span>Preparing {NAME[progress.to]} quality</span>
          <div className="qt-bar" role="progressbar" aria-label={`Preparing ${NAME[progress.to]} quality`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.progress * 100)}>
            <div style={{ transform: `scaleX(${progress.progress})` }} />
          </div>
          {progress.undo && (
            <button className="btn ghost small" onClick={() => void session.undoQuality()}>
              <LineIcon name="undo" size={16} />
              Undo
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
