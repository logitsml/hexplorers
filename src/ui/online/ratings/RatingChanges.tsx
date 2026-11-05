// A rated game's rating changes on the results card: each person's rating before and after and
// their tier, as the room reports them once the services have rated the game (a moment after the
// end). Nothing for an unrated game.

import { useOnline } from '../../../online/store';
import { tierName } from './TierBadge';

export default function RatingChanges() {
  const ratings = useOnline((s) => s.room?.results?.ratings);
  const seats = useOnline((s) => s.room?.seats);
  const mine = useOnline((s) => s.you?.seat ?? null);
  if (!ratings?.length || !seats) return null;
  return (
    <div className="rating-changes" aria-label="Rating changes">
      {ratings.map((r) => {
        const d = r.after - r.before;
        return (
          <span key={r.seat} className={`rating-change${r.seat === mine ? ' mine' : ''}`}>
            <b>{seats[r.seat]?.name ?? `Seat ${r.seat + 1}`}</b> {r.before} → {r.after} <small>({d >= 0 ? `+${d}` : `−${-d}`})</small> · {tierName(r.tier)}
          </span>
        );
      })}
    </div>
  );
}
