// Text continuity for the HUD: numbers roll to their new value and labels morph letter by letter
// instead of snapping (Torph). One wrapper so every morph shares timing and easing.

import { memo, useState } from 'react';
import { TextMorph } from 'torph/react';
import { useUI } from '../game/store';
import { reducedMotion } from '../app/display';

import { EASE_OUT } from './motion';

/** (motion.ts's EASE_OUT, as CSS.) */
export const MORPH_EASE = `cubic-bezier(${EASE_OUT.join(', ')})`;

/** (Memoised: its text is a plain value, so a panel redrawn for something else leaves it be.) */
export const Morph = memo(function Morph({ children, duration = 420 }: { children: string | number; duration?: number }) {
  const reduce = useUI((s) => s.settings.reduceMotion);
  if (typeof children === 'number' || /^\d+$/.test(children)) return <Roll value={String(children)} duration={duration} />;
  return (
    <TextMorph duration={duration} ease={MORPH_EASE} respectReducedMotion={reduce !== 'off'} disabled={reduce === 'on'}>
      {children}
    </TextMorph>
  );
});

/**
 * A number rolls its new value in, up as it grows and down as it falls, in CSS alone. (Torph reads
 * the layout back on every change, and the HUD's counters change many times a turn while the bots
 * trade and build: its morphs would force style and layout recalculations inside long frames.)
 */
function Roll({ value, duration }: { value: string; duration: number }) {
  const [last, setLast] = useState({ value, dir: '' });
  if (last.value !== value) setLast({ value, dir: reducedMotion() ? '' : Number(value) < Number(last.value) ? 'down' : 'up' });
  return (
    <span key={value} className={`morph-roll ${last.dir}`} style={{ animationDuration: `${duration}ms` }}>
      {value}
    </span>
  );
}
