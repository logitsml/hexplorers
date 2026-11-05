import type { Card, DevCardType, Resource } from '../engine';
import { DEV_ART, DEV_NAMES, DEV_TEXT, CARD_ICON, CARD_NAMES, CARD_TINT, UI_ICON, VP_VARIANTS, asset, type UiIconName } from '../game/names';

function CardTitle({ text }: { text: string }) {
  return <div className={`card-title ${text.length > 10 ? 'long' : ''}`}>{text}</div>;
}

/** A resource card: the material's icon on a medallion, in the resource's colour (named on hover where it's shown). */
export function ResourceCard({ resource }: { resource: Card }) {
  return (
    <div className="card res" style={{ ['--tint' as string]: CARD_TINT[resource] }}>
      <div className="card-medallion">
        <img src={asset(CARD_ICON[resource])} alt="" draggable={false} />
      </div>
    </div>
  );
}

/**
 * `variant` picks which building a Victory Point card shows. A card is a picture: its small
 * lettering is hidden from screen readers, and wherever a card is shown its name and rule are
 * also given in text that reads (the button's name, a tooltip or a caption).
 */
export function DevCard({ type, variant = 0 }: { type: DevCardType; variant?: number }) {
  const vp = type === 'victoryPoint' ? VP_VARIANTS[Math.max(0, variant) % VP_VARIANTS.length] : null;
  return (
    <div className={`card dev ${vp ? 'vp' : ''}`} aria-hidden>
      <CardTitle text={vp ? vp.name : DEV_NAMES[type]} />
      <div className="card-art">
        <img className="cover" src={asset(vp ? vp.art : DEV_ART[type as keyof typeof DEV_ART])} alt="" draggable={false} />
      </div>
      <div className="card-foot">{vp ? '+1 Victory Point' : DEV_TEXT[type]}</div>
    </div>
  );
}

export function CardBack({ dev }: { dev?: boolean }) {
  return (
    <div className={`card card-back ${dev ? 'dev' : ''}`}>
      <div className="emblem">
        <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden>
          <polygon points="32,4 56,18 56,46 32,60 8,46 8,18" fill="none" stroke="rgba(255,236,190,0.75)" strokeWidth="2.5" />
          <polygon points="32,14 47,23 47,41 32,50 17,41 17,23" fill="rgba(255,236,190,0.18)" stroke="rgba(255,236,190,0.55)" strokeWidth="1.5" />
          <circle cx="32" cy="32" r="6" fill="rgba(255,236,190,0.8)" />
        </svg>
      </div>
    </div>
  );
}

export function Icon({ name, size = 18, label }: { name: UiIconName; size?: number; label?: string }) {
  return <img className="ui-icon" src={asset(UI_ICON[name])} alt={label ?? ''} width={size} height={size} draggable={false} />;
}

export function ResIcon({ r, size = 18 }: { r: Resource; size?: number }) {
  return <img src={asset(CARD_ICON[r])} alt={CARD_NAMES[r]} width={size} height={size} style={{ objectFit: 'contain', verticalAlign: 'middle' }} draggable={false} />;
}

export function BonusCard({ kind }: { kind: 'longestRoute' | 'largestArmy' }) {
  return (
    <div className="card bonus" aria-hidden>
      <CardTitle text={kind === 'longestRoute' ? 'Longest Route' : 'Biggest Army'} />
      <div className="card-art">
        <img className="cover" src={asset(`art/cards/${kind}.webp`)} alt="" draggable={false} />
      </div>
      <div className="card-foot">+2 Victory Points</div>
    </div>
  );
}
