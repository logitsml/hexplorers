import { memo } from 'react';
import { SEAT_MARKS } from '../render/board/pieces';

/**
 * A seat's mark (circle, triangle, square or diamond) in the player's colour, the same one their
 * buildings carry, so who is who never rests on colour alone.
 */
export const SeatMark = memo(function SeatMark({ seat, color, size = 10 }: { seat: number | null; color: string; size?: number }) {
  const mark = seat === null ? null : SEAT_MARKS[seat % SEAT_MARKS.length];
  const shape =
    mark === 'triangle' ? <polygon points="5,0.9 9.3,8.8 0.7,8.8" />
    : mark === 'square' ? <rect x="1.3" y="1.3" width="7.4" height="7.4" rx="0.6" />
    : mark === 'diamond' ? <polygon points="5,0.5 9.5,5 5,9.5 0.5,5" />
    : <circle cx="5" cy="5" r="4.1" />;
  return (
    <svg className="seat-mark" width={size} height={size} viewBox="0 0 10 10" aria-hidden style={{ fill: color }}>
      {shape}
    </svg>
  );
});
