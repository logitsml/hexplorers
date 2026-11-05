// A sailor's tier as a small badge (the harbour's seats, the boards), and their Fair winds as a
// quiet mark: only the good word ("Fair winds") or, low, a muted one, never a number to grind.

import '../../../styles/community.css';

/** The tiers' names (server/lib/ratings's TIERS), and the placement games before them. */
export const TIER_NAMES: Record<string, string> = {
  placement: 'Placement',
  deckhand: 'Deckhand',
  bosun: 'Bosun',
  mate: 'Mate',
  navigator: 'Navigator',
  captain: 'Captain',
  commodore: 'Commodore',
  admiral: 'Admiral',
};

export const tierName = (id: string) => TIER_NAMES[id] ?? id;

/** Fair winds as words: a band, never the share itself. */
export function fairWinds(reliability: number | undefined): null | { word: string; low: boolean; tip: string } {
  if (reliability === undefined) return null;
  if (reliability >= 0.85) return { word: 'Fair winds', low: false, tip: 'Sees their voyages through' };
  if (reliability < 0.6) return { word: 'Unsettled', low: true, tip: 'Has left a few voyages before the end lately' };
  return null;
}

export function TierBadge({ tier, rating, showRating = false }: { tier?: string; rating?: number; showRating?: boolean }) {
  if (!tier) return null;
  const name = tierName(tier);
  const number = showRating && rating !== undefined && tier !== 'placement';
  return (
    <span className={`tier-badge tier-${tier}`} title={tier === 'placement' ? 'Still in their placement games' : `${name}${rating !== undefined ? `, rated ${rating}` : ''}`}>
      {name}
      {number && <b>{rating}</b>}
    </span>
  );
}

export function FairWindsMark({ reliability }: { reliability?: number }) {
  const f = fairWinds(reliability);
  if (!f) return null;
  return (
    <span className={`fair-winds${f.low ? ' low' : ''}`} title={f.tip}>
      {f.word}
    </span>
  );
}

/** Both, for a seat: nothing at all for someone without games. */
export function SeatStanding({ tier, rating, reliability }: { tier?: string; rating?: number; reliability?: number }) {
  if (!tier && fairWinds(reliability) === null) return null;
  return (
    <span className="seat-standing">
      <TierBadge tier={tier} rating={rating} />
      <FairWindsMark reliability={reliability} />
    </span>
  );
}
