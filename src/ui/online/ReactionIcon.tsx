// The table's reactions as small drawn icons (line drawings in the ink's colour, as the game's own
// line icons are), rather than emoji, which every system draws differently and some loudly.

import type { Reaction } from '../../net/protocol';

const PATHS: Record<Reaction, React.ReactNode> = {
  wave: (
    <>
      <path d="M8.5 13.5V7.8a1.4 1.4 0 0 1 2.8 0V11" />
      <path d="M11.3 10.5V6.2a1.4 1.4 0 0 1 2.8 0v4.3" />
      <path d="M14.1 10.6V7.4a1.4 1.4 0 0 1 2.8 0v5.8a6 6 0 0 1-6 6h-.6a5 5 0 0 1-4-2l-2.3-3.1a1.4 1.4 0 0 1 2.2-1.7l1.3 1.6" />
      <path d="M4.2 7.2a5.4 5.4 0 0 1 2.4-2.9M19.6 4.6a5.4 5.4 0 0 1 1.9 3" />
    </>
  ),
  laugh: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M7.8 10.3q1.2-1.7 2.4 0M13.8 10.3q1.2-1.7 2.4 0" />
      <path d="M7.8 13.4h8.4a4.2 4.2 0 0 1-8.4 0z" />
    </>
  ),
  wow: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="9" cy="10" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="0.9" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="15.3" rx="1.8" ry="2.2" />
    </>
  ),
  cheer: (
    <>
      <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9 18 18M6 18l2.1-2.1M15.9 8.1 18 6" />
      <circle cx="12" cy="12" r="2.2" />
    </>
  ),
  groan: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M7.6 9.2l2.6 1.1M16.4 9.2l-2.6 1.1" />
      <path d="M8.2 16.2q.95-1 1.9 0t1.9 0 1.9 0 1.9 0" />
    </>
  ),
  think: (
    <>
      <path d="M7.4 16.5a3.8 3.8 0 0 1 .3-7.6 4.8 4.8 0 0 1 9.1-.9 3.4 3.4 0 0 1 .4 6.8z" />
      <circle cx="7.6" cy="19.4" r="1.1" />
      <circle cx="5" cy="21.3" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  heart: <path d="M12 19.6s-7-4.3-7-9.7A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.4-7 9.7-7 9.7z" />,
  anchor: (
    <>
      <circle cx="12" cy="5" r="1.9" />
      <path d="M12 6.9V20M8.4 10h7.2" />
      <path d="M4.8 13.4a7.2 7.2 0 0 0 14.4 0M3.6 14.6l1.2-1.2 1.2 1.2M17.6 14.6l1.2-1.2 1.2 1.2" />
    </>
  ),
};

export function ReactionIcon({ r, size = 20 }: { r: Reaction; size?: number }) {
  return (
    <svg className="reaction-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[r]}
    </svg>
  );
}
