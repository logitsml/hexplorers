import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useUI } from '../../game/store';
import { usePwa } from '../../app/pwa/state';
import { applyUpdate } from '../../app/pwa/register';
import { EXIT } from '../motion';
import { CloseIcon, LineIcon } from '../LineIcons';

/**
 * "New version: Reload", once a new version is ready (app/pwa/register.ts): only on the title,
 * never in a game. Put off (×), it waits for the next launch, which opens the new version anyway.
 */
export function UpdateToast() {
  const update = usePwa((s) => s.update);
  const between = useUI((s) => s.worldReady && s.screen === 'title');
  const [later, setLater] = useState(false);
  const [going, setGoing] = useState(false);
  return (
    <AnimatePresence>
      {update && between && !later && (
        <motion.div key="update" className="pwa-toast parchment" role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6, transition: EXIT }}>
          <span>New version ready</span>
          <button
            type="button"
            className="btn gold small"
            disabled={going}
            onClick={() => {
              setGoing(true);
              void applyUpdate();
            }}
          >
            <LineIcon name="refresh" size={16} />
            Reload
          </button>
          <button type="button" className="pwa-toast-x tip" aria-label="Not now" data-tip="Not now" onClick={() => setLater(true)}>
            <CloseIcon size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
