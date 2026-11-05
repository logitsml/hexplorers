// The installable app's own layer: the update note and the Home Screen sheet, in a React root of
// their own beside the game's (#root), made the first time one of them is needed. They come and
// go without the game's interface knowing of them.

import { createRoot, type Root } from 'react-dom/client';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { create } from 'zustand';
import { useUI } from '../../game/store';
import { SPRING_UI } from '../motion';
import { HomeScreenCoaching, type CoachReason, type CoachResult } from './HomeScreenCoaching';
import { UpdateToast } from './UpdateToast';
import './pwa.css';

const useSheet = create<{ open: null | { reason: CoachReason; done: (r: CoachResult) => void } }>(() => ({ open: null }));

let root: Root | null = null;

export function mountPwaLayer() {
  if (root) return;
  const el = document.createElement('div');
  el.className = 'pwa-layer';
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(<Layer />);
}

/** Put up the Home Screen sheet: resolves with how it was closed. (One already up gives way to it.) */
export function openCoaching(reason: CoachReason): Promise<CoachResult> {
  mountPwaLayer();
  useSheet.getState().open?.done('later');
  return new Promise((done) => useSheet.setState({ open: { reason, done } }));
}

const MOTION = { system: 'user', on: 'always', off: 'never' } as const;

function Layer() {
  // (The game's motion setting, as its own root has it: see main.tsx.)
  const reduceMotion = useUI((s) => s.settings.reduceMotion);
  const open = useSheet((s) => s.open);
  const close = (r: CoachResult) => {
    open?.done(r);
    useSheet.setState({ open: null });
  };
  return (
    <MotionConfig reducedMotion={MOTION[reduceMotion]} transition={SPRING_UI}>
      <UpdateToast />
      <AnimatePresence>{open && <HomeScreenCoaching key="coach" reason={open.reason} onClose={close} />}</AnimatePresence>
    </MotionConfig>
  );
}
