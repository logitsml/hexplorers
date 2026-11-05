// Line icons for the menu, the settings and the controls guide, drawn like the toolbar's (24-unit
// grid, 1.75 stroke, round ends, currentColor; the clouds, ship and crew after Lucide's, ISC License,
// Copyright (c) 2026 Lucide Icons and Contributors, LICENSES/ISC-lucide.txt). The
// game's own things (pieces, cards, dice) use the painted icons in Cards.tsx instead.

import type { ReactNode } from 'react';
import { useUI } from '../game/store';
import { FILLED } from './filledIcons';

const PATHS = {
  // Settings sections
  look: (
    <>
      <circle cx="16.5" cy="7.5" r="2.5" />
      <path d="M2.5 19.5 9 12l4 4.5 2.5-2.5 6 5.5" />
      <path d="M2.5 19.5h19" />
    </>
  ),
  play: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  sound: (
    <>
      <path d="M11 5 6 9H2.5v6H6l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </>
  ),
  muted: (
    <>
      <path d="M11 5 6 9H2.5v6H6l5 4z" />
      <path d="m22 9-6 6M16 9l6 6" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5.5l11-2V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  access: (
    <>
      <circle cx="12" cy="4.5" r="1.8" />
      <path d="M4.5 8.5 12 10l7.5-1.5M12 10v4.5M12 14.5 8.5 21M12 14.5l3.5 6.5" />
    </>
  ),
  // Sky
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  dayNight: (
    <>
      <circle cx="8.5" cy="8.5" r="3" />
      <path d="M8.5 2.5v1.2M8.5 13.3v1.2M2.5 8.5h1.2M13.3 8.5h1.2M4.3 4.3l.85.85M12.7 4.3l-.85.85M4.3 12.7l.85-.85" />
      {/* (Drawn small: the stroke is widened by as much, to match the others.) */}
      <path transform="translate(10.5 10.5) scale(0.55)" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" strokeWidth={1.75 / 0.55} />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  sunrise: (
    <>
      <path d="M7 16a5 5 0 0 1 10 0" />
      <path d="M2.5 19.5h19M12 3.5v4M9.5 6 12 3.5 14.5 6M4.5 12.5l1.4 1M19.5 12.5l-1.4 1" />
    </>
  ),
  noon: (
    <>
      <circle cx="12" cy="9" r="4" />
      <path d="M12 2v1.5M5 9H3.5M20.5 9H19M7 4l1 1M17 4l-1 1M2.5 19.5h19" />
    </>
  ),
  sunset: (
    <>
      <path d="M7 16a5 5 0 0 1 10 0" />
      <path d="M2.5 19.5h19M12 7.5v-4M9.5 5 12 7.5 14.5 5M4.5 12.5l1.4 1M19.5 12.5l-1.4 1" />
    </>
  ),
  dusk: (
    <>
      <path d="M7.5 16.5a4.5 4.5 0 0 1 9 0" />
      <path d="M2.5 19.5h19M4.5 14l1.2.7M19.5 14l-1.2.7" />
      <path transform="translate(12.5 1.5) scale(0.45)" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" strokeWidth={1.75 / 0.45} />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" />,
  // Weather
  changing: (
    <>
      <path d="M12 2.5v1.5M4.9 5.4l1.1 1.1M19.1 5.4 18 6.5M21.5 12H20" />
      <path d="M15.9 12.6a4 4 0 0 0-5.9-4.1" />
      <path d="M13 21.5H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6z" />
    </>
  ),
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 0 1 0 9z" />,
  rain: (
    <>
      <path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2" />
      <path d="M8 14v6M12 16v6M16 14v6" />
    </>
  ),
  storm: (
    <>
      <path d="M6 16.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 .5 9" />
      <path d="m13 12-3 5h4l-3 5" />
    </>
  ),
  // Effects, play and access
  focus: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16" />
    </>
  ),
  speed: (
    <>
      <path d="M4 17a8.5 8.5 0 1 1 16 0" />
      <path d="m12 14 4-5" />
      <circle cx="12" cy="14.5" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  turn: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v4h-4" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </>
  ),
  odds: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5V12h8.5" />
      <path d="M12 3.5A8.5 8.5 0 0 1 20.5 12H12z" fill="currentColor" fillOpacity="0.25" stroke="none" />
    </>
  ),
  bright: (
    <>
      <path d="M6.5 20.5v-6.5l5.5-4.5 5.5 4.5v6.5z" />
      <path d="M10.5 20.5v-3h3v3" />
      <path d="M12 2.5v2.5M4.6 5.6l1.6 1.6M19.4 5.6l-1.6 1.6M2.5 12.5h2M21.5 12.5h-2" />
    </>
  ),
  textSize: (
    <>
      <path d="M3 18 7.5 6l4.5 12M4.6 14h5.8" />
      <path d="M14 18l3.5-8.5L21 18M15.2 15.5h4.6" />
    </>
  ),
  motion: (
    <>
      <circle cx="16" cy="12" r="4.5" />
      <path d="M2.5 12h8M4.5 8.5h6.5M4.5 15.5h6.5" />
    </>
  ),
  // Menu
  ship: (
    <>
      <path d="M21.5 18h-19a4 4 0 0 0 4 3.5h11a4 4 0 0 0 4-3.5z" />
      <path d="M20 14.5 10 2.5 4 14.5z" />
      <path d="M10 2.5V18" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m16 8-1.8 5.4a1.3 1.3 0 0 1-.8.8L8 16l1.8-5.4a1.3 1.3 0 0 1 .8-.8z" />
    </>
  ),
  crew: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20.5v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.7a5 5 0 0 1 3 4.8v1" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  back: <path d="M15 18l-6-6 6-6" />,
  next: <path d="M9 6l6 6-6 6" />,
  // Guides
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2.5H20v19H6.5A2.5 2.5 0 0 1 4 19V5a2.5 2.5 0 0 1 2.5-2.5z" />
    </>
  ),
  hand: (
    <>
      <path d="M9 11V4.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M12 10V8.5a1.5 1.5 0 0 1 3 0V11M15 10.5a1.5 1.5 0 0 1 3 0V15a6.5 6.5 0 0 1-6.5 6.5h-.8a5.5 5.5 0 0 1-4.6-2.5L4.4 15.6a1.5 1.5 0 0 1 2.4-1.8L9 16" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6.5 10h1M10 10h1M13.5 10h1M17 10h.5M7 14h10" />
    </>
  ),
  mouse: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="6" />
      <path d="M12 7v3" />
    </>
  ),
  // Actions (for buttons: one beside a label says at a glance what it does; after Lucide's, ISC)
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2.5" />
      <path d="M4.5 16A1.5 1.5 0 0 1 3 14.5v-10A1.5 1.5 0 0 1 4.5 3h10A1.5 1.5 0 0 1 16 4.5" />
    </>
  ),
  share: <path d="M4 12v7.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V12M16 6.5 12 2.5l-4 4M12 2.5V15" />,
  link: <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />,
  qr: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 14h3v3h-3zM20.5 14v.5M14 20.5h.5M17.5 20.5H21V17" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  arrowRight: <path d="M5 12h14M12.5 5.5 19 12l-6.5 6.5" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </>
  ),
  userPlus: (
    <>
      <circle cx="9.5" cy="8" r="4" />
      <path d="M2 21a7.5 7.5 0 0 1 15 0M19 8v6M22 11h-6" />
    </>
  ),
  exit: <path d="M9 21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3H9M16 17l5-5-5-5M21 12H9" />,
  send: <path d="M21.5 2.5 11 13M21.5 2.5l-6.5 19-4-8.5-8.5-4z" />,
  refresh: <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8.5M20.5 3.5v5h-5" />,
  undo: <path d="M3 7.5v5.5h5.5M20.5 17A8.5 8.5 0 0 0 6 10.6L3 13" />,
  trash: <path d="M3.5 6h17M18.5 6v13.5A1.5 1.5 0 0 1 17 21H7a1.5 1.5 0 0 1-1.5-1.5V6M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6M10 11v5.5M14 11v5.5" />,
  pencil: <path d="M16.5 3.5a2.6 2.6 0 0 1 4 4L7.5 20.5 2.5 21.5l1-5z" />,
  flag: <path d="M4.5 21.5V15M4.5 15s1-1 4-1 5 2 8 2 3.5-1 3.5-1V3.5s-.5 1-3.5 1-5-2-8-2-4 1-4 1V15" />,
  trophy: <path d="M7 4.5H4a3 3 0 0 0 3 4.5M17 4.5h3a3 3 0 0 1-3 4.5M7 3h10v6a5 5 0 0 1-10 0zM12 14v4M8 21h8M9.5 18h5" />,
  crown: <path d="M3 7.5 7.5 12 12 5l4.5 7L21 7.5 19 17H5zM5 20.5h14" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 16.5V11M12 7.5v.01" />
    </>
  ),
  download: <path d="M20.5 15v4A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19v-4M7 10l5 5 5-5M12 15V3.5" />,
  upload: <path d="M20.5 15v4A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19v-4M17 8l-5-5-5 5M12 3v11.5" />,
  map: <path d="M9 3.5 3.5 6v14.5L9 18l6 2.5 5.5-2.5V3.5L15 6zM9 3.5V18M15 6v14.5" />,
  chat: <path d="M7.9 20A9 9 0 1 0 4 16.1L2.5 21.5z" />,
  bell: <path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5M10.3 20.5a2 2 0 0 0 3.4 0" />,
  star: <path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M7.5 11V7.5a4.5 4.5 0 0 1 9 0V11" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-4-4L6 21" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="3" />
      <path d="M12 9V5.5M9 14.5v1M15 14.5v1M2 14v2.5M22 14v2.5" />
      <circle cx="12" cy="4.5" r="1.2" />
    </>
  ),
  pause: <path d="M9 5v14M15 5v14" />,
  home: <path d="M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5A1.5 1.5 0 0 1 3.5 19z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7.5" />
      <path d="m20.5 20.5-4.2-4.2" />
    </>
  ),
  hourglass: <path d="M5.5 2.5h13M5.5 21.5h13M7.5 2.5v3.5a4.5 4.5 0 0 0 9 0V2.5M7.5 21.5V18a4.5 4.5 0 0 1 9 0v3.5" />,
  swap: <path d="M7.5 3.5 4 7l3.5 3.5M4 7h16M16.5 13.5 20 17l-3.5 3.5M20 17H4" />,
  sparkle: <path d="m12 3 1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9zM19 16.5v4M17 18.5h4" />,
  anchor: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <path d="M12 7.5v14M8 11h8M4 13.5a8 8 0 0 0 16 0" />
    </>
  ),
  device: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  palette: (
    <>
      <path d="M12 21.5a9.5 9.5 0 1 1 9.5-9.5c0 2.6-2.1 4-4.2 4h-2.1a1.9 1.9 0 0 0-1.4 3.2 1.4 1.4 0 0 1-1 2.3z" />
      <circle cx="7.5" cy="11" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="7" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="7" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type LineIconName = keyof typeof PATHS;

export function LineIcon({ name, size = 20 }: { name: LineIconName; size?: number }) {
  return (
    <Filled name={name} size={size}>
      <LineGlyph name={name} size={size} />
    </Filled>
  );
}

/**
 * Sea Glass draws its icons filled (filledIcons.ts): the glyph for `name` where there is one, drawn 2px larger
 * (Material's glyphs sit inside their box) on the same footprint; otherwise, and in the parchment look, `children`.
 */
export function Filled({ name, size = 20, children }: { name: string; size?: number; children: ReactNode }) {
  const glass = useUI((s) => s.settings.look === 'glass');
  const d = glass ? FILLED[name] : undefined;
  if (!d) return <>{children}</>;
  return (
    <svg className="line-icon filled" width={size + 2} height={size + 2} viewBox="0 -960 960 960" fill="currentColor" style={{ margin: -1 }} aria-hidden>
      <path d={d} />
    </svg>
  );
}

function LineGlyph({ name, size }: { name: LineIconName; size: number }) {
  return (
    <svg className="line-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

/**
 * The close mark, the one every panel, sheet and tip puts away with: its stroke scaled to its size,
 * so it draws the same 1.5px line however small.
 */
export function CloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={36 / size} strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
