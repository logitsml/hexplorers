import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react';
import { Morph } from './Morph';
import { speedOf, useUI } from '../game/store';
import { session } from '../app/session';
import { PLAYER_PALETTE } from '../render/board/pieces';
import { EVENT_INK, EVENT_NAME, EVENT_PATH, VALUE_EVENT } from '../render/fx/eventDie';
import type { EventFace } from '../engine/modules/guilds/types';
import { THROW_TIME } from '../render/fx/dice3d';

/** Pips on a 3×3 grid (column, row) for each face. */
export const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};

/** Whether a screen point is under the HUD (its panels, not the see-through layer itself). */
const underHud = (x: number, y: number) => document.elementsFromPoint(x, y).some((el) => el.closest('.ui-layer > *') !== null);

const rollerColor = (player: number) => {
  const p = useUI.getState().view?.players[player];
  return p ? PLAYER_PALETTE[p.color].ui : '#ffffff';
};

/**
 * A roll: the dice are thrown onto the sea beside the island (see render/fx/dice3d.ts and
 * World.throwDice); once they float, the total rises out of the water above them as a solid
 * numeral (render/fx/diceTotal.ts). A seven also lets the edges of the world fall into shadow
 * for a moment: a shade that eases in and out once, never a flash of colour.
 */
export function DiceOverlay() {
  const roll = useUI((s) => s.diceRoll);
  const speed = useUI(speedOf);
  const reduce = !!useReducedMotionConfig();
  const [shade, setShade] = useState<number | null>(null);
  useEffect(() => {
    if (!roll) return;
    session.world?.throwDice(roll.dice, rollerColor(roll.player), speed, reduce, underHud, roll.event);
    if (roll.dice[0] + roll.dice[1] !== 7 || reduce) return;
    const t = setTimeout(() => setShade(roll.id), (THROW_TIME * 1000) / speed + 60);
    return () => clearTimeout(t);
    // (A speed change mid-roll doesn't restart it.)
  }, [roll, reduce]);
  return (
    <AnimatePresence>
      {shade !== null && (
        <motion.div
          key={shade}
          className="seven-shade"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: 2.4, times: [0, 0.35, 1], ease: 'easeInOut' }}
          onAnimationComplete={() => setShade(null)}
        />
      )}
    </AnimatePresence>
  );
}

function MiniDie({ value, rolling, red = false }: { value: number; rolling: boolean; red?: boolean }) {
  return (
    <span className={`mini-die ${red ? 'red-body' : ''} ${rolling ? 'rolling' : ''}`}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.svg
          key={rolling ? 'rolling' : value}
          viewBox="0 0 24 24"
          aria-hidden
          initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
          animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
          exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
        >
          {(PIPS[value] ?? []).map(([c, r], i) => (
            <circle key={i} cx={6 + c * 6} cy={6 + r * 6} r={2.15} />
          ))}
        </motion.svg>
      </AnimatePresence>
    </span>
  );
}

/** The same engraved silhouette is painted onto the 3D die and printed on the flat cube. */
export function EventDieIcon({ face }: { face: EventFace }) {
  return <svg viewBox="0 0 24 24" aria-hidden style={{ color: EVENT_INK[face] }}><path d={EVENT_PATH[face]} fill="currentColor" fillRule="evenodd" /></svg>;
}

/**
 * The last roll, always on screen: its small dice and the total, edged in the roller's colour.
 * While a throw is in the air its dice tumble through random faces; they show the roll as the
 * real ones come to rest.
 */
export function RollIndicator() {
  const roll = useUI((s) => s.diceRoll);
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const speed = useUI(speedOf);
  const reduce = !!useReducedMotionConfig();
  const [shown, setShown] = useState(roll);
  const [rolling, setRolling] = useState(false);
  const [spin, setSpin] = useState<[number, number]>([3, 4]);
  const first = useRef(true);
  useEffect(() => {
    // A roll already made when this appears (a resumed game) shows without the tumble.
    if (first.current || !roll || reduce) {
      first.current = false;
      setShown(roll);
      setRolling(false);
      return;
    }
    setRolling(true);
    const face = () => 1 + Math.floor(Math.random() * 6);
    const tick = setInterval(() => setSpin([face(), face()]), 120);
    const done = setTimeout(() => {
      clearInterval(tick);
      setRolling(false);
      setShown(roll);
    }, (THROW_TIME * 1000) / speed);
    return () => {
      clearInterval(tick);
      clearTimeout(done);
    };
  }, [roll, reduce]);
  const player = shown && view ? view.players[shown.player] : undefined;
  const total = shown && !rolling ? shown.dice[0] + shown.dice[1] : null;
  const [a, b] = rolling ? spin : (shown?.dice ?? [0, 0]);
  const event = (rolling ? roll : shown)?.event;
  const face = rolling ? VALUE_EVENT[(spin[0] - 1) % 6] : event?.face;
  const cardTotal = !!event?.independentRed;
  const label = shown && player ? `Last roll: ${player.name} ${shown.event?.independentRed ? 'drew card total' : 'rolled'} ${shown.dice[0] + shown.dice[1]} (${shown.dice[0]} and ${shown.dice[1]})` + (shown.event ? `, red die ${shown.event.red}, ${EVENT_NAME[shown.event.face]}` : '') : 'No roll yet';
  return (
    <div
      className={`roll-chip ${total === 7 ? 'seven' : ''} ${shown || rolling ? '' : 'idle'}`}
      data-hud-obstacle="roll"
      role="img"
      aria-label={label}
      style={{ ['--who' as string]: player ? PLAYER_PALETTE[player.color].ui : 'transparent' }}
      // (Your own roll: online, a dice skin you show dresses its dice; see styles/online.css.)
      data-mine={(rolling ? roll : shown)?.player === me ? '' : undefined}
    >
      <MiniDie value={a} rolling={rolling} red={!!event && !cardTotal} />
      <MiniDie value={b} rolling={rolling} />
      <span className={`roll-sum${cardTotal ? ' card-total' : ''}`} data-caption={cardTotal ? 'card total' : undefined}>
        <Morph duration={380}>{total === null ? '–' : String(total)}</Morph>
      </span>
      {event && face && <>
        {cardTotal && <span className="roll-divider" />}
        <span className={`mini-die event-die ${rolling ? 'rolling' : ''}`} title={`${EVENT_NAME[face]} · red ${event.red}`}><EventDieIcon face={face} /></span>
        {cardTotal && <MiniDie value={rolling ? spin[0] : event.red} rolling={rolling} red />}
      </>}
    </div>
  );
}
