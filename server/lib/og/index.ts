// server/lib/og: link-preview cards as SVG strings (1200×630), for /og/r/:code.svg and friends.
//
//   roomInviteCard({ code, host, seats, mix, target })  "Join Marlow's island", seat dots, "Join the crew"
//   resultsCard({ host, winner, standings, turns, mix }) "Wren won on Marlow's island", 12–9–8–6
//   profileCard({ name, handle, tier, rating, games, wins, color })
//
// Every name is clipped and escaped (and stripped of control and bidi-override characters), colours are
// checked against #rgb/#rrggbb, and nothing is fetched: no external fonts or images, each card well
// under 20 KB. See svg.ts for the font note (the PNG step needs its own font). Young sailors' names
// should already be replaced ("A sailor") by the caller, as should hidden names.

import { clip, fitSize, frame, initialOf, island, PALETTE, safeColor, SANS, seatDot, text, WIDTH } from './svg';

export { clip, escapeXml, safeColor, HEIGHT, WIDTH, SERIF, SANS } from './svg';

export interface CardSeat {
  kind: 'open' | 'human' | 'bot';
  name?: string;
  color?: string;
}

export interface RoomInviteInput {
  /** The room code (6 letters from the room alphabet). */
  code: string;
  host: string;
  seats: CardSeat[];
  /** The preset or mix name, e.g. "The Long Voyage" or "Sea Lanes with Guilds & Garrisons". */
  mix: string;
  /** Victory points to win. */
  target?: number;
  phase?: 'harbour' | 'playing';
}

const possessive = (name: string) => `${name}’s`;

function codeBadge(code: string, x: number, y: number): string {
  const shown = clip(code.toUpperCase().replace(/[^A-Z0-9]/g, ''), 8);
  return [
    `<rect x="${x}" y="${y}" width="300" height="120" rx="14" fill="${PALETTE.ink}"/>`,
    `<rect x="${x + 8}" y="${y + 8}" width="284" height="104" rx="9" fill="none" stroke="${PALETTE.gold}" stroke-width="1.5"/>`,
    text(x + 150, y + 40, 'ROOM CODE', { size: 16, family: SANS, weight: 'bold', fill: PALETTE.gold, anchor: 'middle', spacing: 4 }),
    text(x + 150, y + 92, shown, { size: 46, family: SANS, weight: 'bold', fill: PALETTE.parchment, anchor: 'middle', spacing: 8 }),
  ].join('');
}

function seatRow(seats: CardSeat[], y: number): string {
  const shown = seats.slice(0, 6);
  const gap = 200;
  const startX = WIDTH / 2 - ((shown.length - 1) * gap) / 2;
  return shown
    .map((seat, i) => {
      const cx = startX + i * gap;
      const open = seat.kind === 'open' || !seat.name;
      const name = open ? 'Open' : clip(seat.name!, 14);
      const dot = seatDot(cx, y, 34, open ? null : safeColor(seat.color), open ? '' : initialOf(seat.name!));
      const label = text(cx, y + 66, name, { size: 22, family: SANS, weight: open ? undefined : 'bold', fill: open ? PALETTE.inkSoft : PALETTE.ink, anchor: 'middle' });
      const crew = seat.kind === 'bot' ? text(cx, y + 90, 'crew', { size: 17, family: SANS, fill: PALETTE.inkSoft, anchor: 'middle', italic: true }) : '';
      return dot + label + crew;
    })
    .join('');
}

/** The invite card for /r/CODE. */
export function roomInviteCard(input: RoomInviteInput): string {
  const host = clip(input.host || 'A sailor', 18);
  const open = input.seats.filter((s) => s.kind === 'open').length;
  const underway = input.phase === 'playing';
  const title = `${underway ? '' : 'Join '}${possessive(host)} island`;
  const sub = underway ? 'Voyage under way' : open === 1 ? '1 seat open' : open > 1 ? `${open} seats open` : 'Table full';
  const details = [clip(input.mix || 'Classic island', 44), `${input.seats.length} players`, input.target ? `first to ${input.target} points` : '']
    .filter(Boolean)
    .join(' · ');
  const label = `${title}. ${details}. Room ${input.code}.`;
  return frame(
    [
      island(1010, 150, 26),
      text(72, 180, title, { size: fitSize(title, 830, 64, 36), weight: 'bold' }),
      text(72, 232, sub, { size: 30, family: SANS, fill: PALETTE.seaDeep, weight: 'bold' }),
      text(72, 278, details, { size: 26, family: SANS, fill: PALETTE.inkSoft }),
      codeBadge(input.code, 72, 312),
      underway
        ? ''
        : `<rect x="404" y="342" width="290" height="60" rx="30" fill="${PALETTE.gold}"/>` +
          text(549, 382, 'Join the crew', { size: 28, family: SANS, weight: 'bold', fill: PALETTE.ink, anchor: 'middle' }),
      seatRow(input.seats, 480),
    ].join(''),
    label,
  );
}

export interface ResultsInput {
  host: string;
  mix: string;
  /** Best first. */
  standings: { name: string; color?: string; points: number; conceded?: boolean }[];
  turns: number;
  durationMs?: number;
}

/** The results card for a finished game or its replay. */
export function resultsCard(input: ResultsInput): string {
  const rows = input.standings.slice(0, 6);
  const winner = rows[0];
  const host = clip(input.host || 'A sailor', 18);
  const title = winner ? `${clip(winner.name, 16)} won on ${possessive(host)} island` : `${possessive(host)} island`;
  const score = rows.map((r) => Math.max(0, Math.round(r.points))).join('–');
  const minutes = input.durationMs ? Math.max(1, Math.round(input.durationMs / 60_000)) : 0;
  const details = [clip(input.mix || 'Classic island', 40), `${input.turns} turns`, minutes ? `${minutes} min` : ''].filter(Boolean).join(' · ');
  const max = Math.max(1, ...rows.map((r) => r.points));
  const bars = rows
    .map((r, i) => {
      const y = 300 + i * 52;
      const color = safeColor(r.color);
      const w = Math.round((Math.max(0, r.points) / max) * 440);
      return [
        text(72, y + 26, `${i + 1}`, { size: 26, family: SANS, weight: 'bold', fill: PALETTE.gold }),
        seatDot(124, y + 16, 16, color, ''),
        text(156, y + 26, r.conceded ? `${clip(r.name, 14)} (struck colours)` : clip(r.name, 16), { size: 26, family: SANS, weight: i === 0 ? 'bold' : undefined }),
        `<rect x="600" y="${y + 4}" width="${Math.max(6, w)}" height="26" rx="6" fill="${color}" opacity="0.85"/>`,
        text(610 + Math.max(6, w), y + 26, String(Math.max(0, Math.round(r.points))), { size: 24, family: SANS, weight: 'bold' }),
      ].join('');
    })
    .join('');
  return frame(
    [
      island(1040, 150, 22),
      text(72, 170, title, { size: fitSize(title, 880, 56, 30), weight: 'bold' }),
      text(72, 226, score, { size: 40, family: SANS, weight: 'bold', fill: PALETTE.seaDeep, spacing: 2 }),
      text(72, 266, details, { size: 24, family: SANS, fill: PALETTE.inkSoft }),
      bars,
    ].join(''),
    `${title}. ${score}. ${details}.`,
  );
}

export interface ProfileInput {
  name: string;
  handle?: string;
  /** Tier name, e.g. "Navigator". */
  tier?: string;
  rating?: number;
  provisional?: boolean;
  games: number;
  wins: number;
  color?: string;
}

/** A player's profile card for /u/HANDLE. */
export function profileCard(input: ProfileInput): string {
  const name = clip(input.name || 'A sailor', 18);
  const color = safeColor(input.color, PALETTE.sea);
  const handle = input.handle ? `@${clip(input.handle.replace(/[^A-Za-z0-9_.-]/g, ''), 24)}` : '';
  const games = Math.max(0, Math.floor(input.games));
  const wins = Math.max(0, Math.min(games, Math.floor(input.wins)));
  const rate = games ? Math.round((wins / games) * 100) : 0;
  const tier = input.provisional ? 'Placement games' : input.tier ? clip(input.tier, 16) : 'Unrated';
  const pill = tier + (input.rating !== undefined && !input.provisional ? ` · ${Math.round(input.rating)}` : '');
  const stat = (x: number, value: string, label: string) =>
    text(x, 470, value, { size: 54, family: SANS, weight: 'bold', anchor: 'middle' }) +
    text(x, 506, label, { size: 22, family: SANS, fill: PALETTE.inkSoft, anchor: 'middle', spacing: 2 });
  return frame(
    [
      seatDot(190, 250, 92, color, initialOf(name)),
      text(320, 230, name, { size: fitSize(name, 640, 64, 40), weight: 'bold' }),
      handle ? text(320, 276, handle, { size: 28, family: SANS, fill: PALETTE.inkSoft }) : '',
      `<rect x="320" y="${handle ? 300 : 260}" width="${Math.round(Math.max(160, 0.6 * 24 * Array.from(pill).length + 40))}" height="48" rx="24" fill="${PALETTE.ink}"/>`,
      text(340, handle ? 333 : 293, pill, {
        size: 24,
        family: SANS,
        weight: 'bold',
        fill: PALETTE.parchment,
      }),
      stat(320, String(games), 'VOYAGES'),
      stat(560, String(wins), 'WINS'),
      stat(800, `${rate}%`, 'WIN RATE'),
      island(1040, 170, 20),
    ].join(''),
    `${name}${handle ? ` (${handle})` : ''}: ${tier}, ${games} voyages, ${wins} wins.`,
  );
}

/** Serve an SVG card (Content-Type and a cache header; the URL should carry a version). */
export function svgResponse(svg: string, maxAgeSeconds = 3600): Response {
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
      'X-Content-Type-Options': 'nosniff',
      // An SVG opened directly must not run anything, whatever slips into it.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

