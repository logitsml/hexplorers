import { memo, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { useUI, type Flight } from '../game/store';
import { BonusCard, CardBack, DevCard, ResourceCard } from './Cards';
import { asset } from '../game/names';
import { reducedMotion } from '../app/display';

/** Cards travelling between the board, the supply and players' hands. */
export function FlightLayer() {
  const flights = useUI((s) => s.flights);
  return (
    <div className="flight-layer">
      {flights.map((f) => (
        <FlyingCard key={f.id} f={f} />
      ))}
    </div>
  );
}

// (A card in the air takes a deeper box shadow from the stylesheet, see .flight .card: a
// drop-shadow filter on every moving card cost a repaint of each one on every frame.)
/** Share of a flight after which a card settles into its holder: it fades out from here as the holder's own card fades in. */
const LAND = 0.86;

/** Keep a point on screen (a building can be scrolled out of view). */
const onScreen = (p: { x: number; y: number }, m = 36) => ({
  x: Math.min(window.innerWidth - m, Math.max(m, p.x)),
  y: Math.min(window.innerHeight - m, Math.max(m, p.y)),
});

/** A painted token in flight, in the middle of a card's box (so it travels as the cards do), its shadow following its shape. */
const TokenFace = ({ art }: { art: string }) => (
  <img src={asset(art)} alt="" draggable={false} style={{ display: 'block', width: 92, height: 92, marginTop: 20, filter: 'drop-shadow(0 8px 9px rgba(0, 0, 0, 0.35))' }} />
);

const card = (f: Flight) =>
  f.kind === 'token' && f.art ? (
    <TokenFace art={f.art} />
  ) : f.kind === 'resource' && f.resource ? (
    <ResourceCard resource={f.resource} />
  ) : f.kind === 'dev' && f.dev ? (
    <DevCard type={f.dev} variant={f.variant} />
  ) : f.kind === 'bonus' && f.bonus ? (
    <BonusCard kind={f.bonus} />
  ) : (
    <CardBack dev={f.kind === 'devBack'} />
  );

/** Memoised: adding one flight must not re-render (and re-measure) every card in the air. */
const FlyingCard = memo(function FlyingCard({ f: flight }: { f: Flight }) {
  const remove = useUI((s) => s.removeFlight);
  // (Reduced motion: the card is put where it goes rather than flown there, so it needn't hang
  // there for the whole flight before it fades.)
  const f = reducedMotion() ? { ...flight, duration: Math.min(flight.duration, 0.45) } : flight;
  const w = 92;
  const h = 132;
  const s = f.scale ?? 1;
  const r = f.rotate ?? 0;
  const at = (p: { x: number; y: number }, dy = 0) => ({ x: p.x - w / 2, y: p.y - h / 2 + dy });
  const end = f.endScale ?? s * 0.82;
  // A card leaving a hand starts as that hand's card, opaque; any other appears out of nothing.
  const start = f.startScale ?? 0.35;
  const startOpacity = f.startScale ? 1 : 0;
  let animate: Record<string, (number | string)[] | number>;
  let times: number[];
  let ease: [number, number, number, number] = [0.45, 0, 0.25, 1];
  let opacityTimes: number[] | null = null;
  /** Per property, an easing for each leg between its keyframes (else `ease` for every leg). */
  let legs: Partial<Record<'x' | 'y' | 'scale' | 'rotate', string[]>> | null = null;
  // It settles into its holder as it starts to fade (not at the very end), so the holder's card
  // fades in under it as it goes; a card shown in the middle, or lost, has nowhere to settle.
  let settles = !f.fizzle;
  if (f.fizzle) {
    // Pops out of the tile, drifts to where it is lost, greys and dissolves.
    const a = at(f.from), b = at(onScreen(f.to), -10);
    animate = {
      x: [a.x, a.x, b.x, b.x],
      y: [a.y, a.y - 46, b.y, b.y - 8],
      scale: [0.2, 0.5, 0.4, 0.16],
      rotate: [r * 2, r, -r, r * 2],
      opacity: [0, 1, 0.9, 0],
      filter: ['grayscale(0)', 'grayscale(0)', 'grayscale(0.6)', 'grayscale(1)'],
    };
    times = [0, 0.3, 0.72, 1];
    opacityTimes = times;
  } else if (f.via) {
    // Out of the tile (production cards lying in it at first, standing up as they rise), over to
    // the building that earned it, a beat there, then off to its owner.
    const a = at(f.from), v = at(onScreen(f.via), -18), b = at(f.to);
    const lift = Math.min(150, 50 + Math.abs(b.x - v.x) * 0.16);
    const mid = { x: (v.x + b.x) / 2, y: Math.min(v.y, b.y) - lift };
    animate = {
      x: [a.x, a.x, v.x, v.x, mid.x, b.x],
      y: [a.y, a.y - 40, v.y, v.y - 6, mid.y, b.y],
      scale: [0.2, 0.5, 0.44, 0.44, s * 1.02, end],
      rotate: [r * 2, r, 0, 0, r * 0.5, 0],
      opacity: [0, 1, 1, 0],
    };
    times = [0, 0.17, 0.38, 0.52, 0.76, 1];
    opacityTimes = [0, 0.17, LAND, 1];
    // (The last leg, from the building to its owner, is one arc: see the plain flight below.)
    legs = {
      x: ['easeOut', 'easeInOut', 'easeInOut', 'easeIn', 'easeOut'],
      y: ['easeOut', 'easeInOut', 'easeOut', 'easeOut', 'easeIn'],
      scale: ['easeOut', 'easeInOut', 'easeInOut', 'easeOut', 'easeInOut'],
      rotate: ['easeOut', 'easeInOut', 'easeInOut', 'easeOut', 'easeInOut'],
    };
  } else {
    const midX = (f.from.x + f.to.x) / 2;
    const lift = Math.min(160, 60 + Math.abs(f.to.x - f.from.x) * 0.18);
    const midY = Math.min(f.from.y, f.to.y) - lift;
    const isCenter = (f.kind === 'dev' || f.kind === 'bonus' || f.kind === 'token') && s > 1.5 && f.to.y < window.innerHeight * 0.7 && f.to.x > window.innerWidth * 0.3 && f.to.x < window.innerWidth * 0.7;
    if (isCenter) {
      settles = false;
      animate = { x: [f.from.x - w / 2, f.to.x - w / 2, f.to.x - w / 2, f.to.x - w / 2], y: [f.from.y - h / 2, f.to.y - h / 2, f.to.y - h / 2, f.to.y - h / 2 - 30], scale: [0.4, s, s, s * 0.9], rotate: [10, 0, 0, 0], opacity: [0, 1, 1, 0] };
      times = [0, 0.35, 0.8, 1];
      ease = [0.2, 0.9, 0.3, 1];
      opacityTimes = [0, 0.12, 0.85, 1];
    } else {
      animate = {
        x: [f.from.x - w / 2, midX - w / 2, f.to.x - w / 2],
        y: [f.from.y - h / 2, midY - h / 2, f.to.y - h / 2],
        scale: [start, s * 1.08, end],
        rotate: [f.startScale ? 0 : r * 2, r, 0],
        opacity: [startOpacity, 1, 1, 0],
      };
      times = [0, 0.5, 1];
      opacityTimes = [0, 0.12, LAND, 1];
      // One arc, as a thrown card goes: across, quickening into the middle and slowing into the
      // hand; up to the top and back down from it. (One easing for every leg would have every part
      // of it stop dead at the top, so each card would hitch in mid-air.)
      legs = { x: ['easeIn', 'easeOut'], y: ['easeOut', 'easeIn'], scale: ['easeOut', 'easeInOut'], rotate: ['easeOut', 'easeInOut'] };
    }
  }
  const landed = useRef(false);
  const land = () => {
    if (landed.current) return;
    landed.current = true;
    f.onLand?.();
  };
  useEffect(() => {
    if (!settles) return;
    const t = setTimeout(land, (f.delay + f.duration * LAND) * 1000);
    return () => clearTimeout(t);
  }, []);
  return (
    <motion.div
      className="flight"
      initial={{ x: f.from.x - w / 2, y: f.from.y - h / 2, scale: f.startScale ?? 0.25, rotate: f.startScale ? 0 : r * 2, opacity: startOpacity }}
      animate={animate}
      transition={{
        default: { duration: f.duration, delay: f.delay, ease, times },
        ...(legs && Object.fromEntries(Object.entries(legs).map(([k, e]) => [k, { duration: f.duration, delay: f.delay, ease: e, times }]))),
        opacity: opacityTimes
          ? { duration: f.duration, delay: f.delay, times: opacityTimes }
          : { duration: Math.min(0.18, f.duration * 0.15), delay: f.delay, ease: 'easeOut' },
      }}
      onAnimationComplete={() => {
        land();
        remove(f.id);
      }}
    >
      {f.rise ? (
        // Lying in its tile at first, it stands up on its bottom edge as it rises.
        <motion.div initial={{ rotateX: 76, transformPerspective: 360 }} animate={{ rotateX: 0 }} transition={{ duration: f.duration * 0.2, delay: f.delay, ease: [0.3, 0.7, 0.4, 1] }} style={{ transformOrigin: '50% 100%' }}>
          {card(f)}
        </motion.div>
      ) : (
        card(f)
      )}
    </motion.div>
  );
});
