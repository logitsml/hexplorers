// Small, safe SVG building blocks for the link-preview cards: escaping, clipping, colours, the font
// stacks and a few shapes in the game's palette.

/** Card size: what Open Graph, Discord and iMessage all show well. */
export const WIDTH = 1200;
export const HEIGHT = 630;

/**
 * No fonts are embedded (each would cost far more than the 20 KB budget). Browsers and crawlers that
 * render the SVG use these stacks; the PNG step (resvg on Workers has no system fonts) must load a
 * font of its own, e.g. Fraunces and Alegreya Sans as TTF, and map these families to it.
 */
export const SERIF = "Fraunces, Georgia, 'Times New Roman', 'DejaVu Serif', serif";
export const SANS = "'Alegreya Sans', 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif";

export const PALETTE = {
  parchment: '#f3e9d2',
  parchmentDeep: '#e6d6b2',
  ink: '#1f3347',
  inkSoft: '#4a5a6a',
  sea: '#2f6f8f',
  seaDeep: '#1d4e68',
  gold: '#b8862e',
  sand: '#e4cf94',
  forest: '#4f7a3a',
  wheat: '#d9a83a',
  hills: '#b4643c',
  pasture: '#8db05a',
  mountain: '#8a8f96',
};

/** Characters XML 1.0 forbids even escaped, plus bidi overrides that could reverse a hostile name. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿‪-‮⁦-⁩]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Text safe for XML content and attribute values. */
export function escapeXml(text: string): string {
  return String(text)
    .replace(FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** At most `max` characters (by code point, so emoji aren't split), with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const clean = String(text ?? '')
    .replace(FORBIDDEN, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(clean);
  return chars.length <= max ? clean : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

/** A #rgb or #rrggbb colour, or the fallback: never raw input in an attribute. */
export function safeColor(color: unknown, fallback: string = PALETTE.inkSoft): string {
  return typeof color === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color) ? color.toLowerCase() : fallback;
}

/** A pleasant text colour on a given background (dark ink or parchment). */
export function onColor(color: string): string {
  const hex = color.length === 4 ? color.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : color;
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? PALETTE.ink : PALETTE.parchment;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A font size that keeps `content` within `maxWidth`, estimating glyphs at `em` of the size (no font
 * metrics without a font), between `min` and `size`.
 */
export function fitSize(content: string, maxWidth: number, size: number, min: number, em = 0.56): number {
  const n = Array.from(content).length || 1;
  return Math.max(min, Math.min(size, Math.floor(maxWidth / (n * em))));
}

export interface TextOptions {
  size: number;
  family?: string;
  weight?: number | 'bold';
  fill?: string;
  anchor?: 'start' | 'middle' | 'end';
  spacing?: number;
  italic?: boolean;
}

/** A <text> element; `content` is escaped here. */
export function text(x: number, y: number, content: string, o: TextOptions): string {
  const attrs = [
    `x="${r1(x)}"`,
    `y="${r1(y)}"`,
    `font-family="${escapeXml(o.family ?? SERIF)}"`,
    `font-size="${o.size}"`,
    o.weight ? `font-weight="${o.weight}"` : '',
    o.italic ? 'font-style="italic"' : '',
    `fill="${o.fill ?? PALETTE.ink}"`,
    o.anchor && o.anchor !== 'start' ? `text-anchor="${o.anchor}"` : '',
    o.spacing ? `letter-spacing="${o.spacing}"` : '',
  ].filter(Boolean);
  return `<text ${attrs.join(' ')}>${escapeXml(content)}</text>`;
}

/** A pointy-top hexagon's points. */
export function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${r1(cx + r * Math.cos(a))},${r1(cy + r * Math.sin(a))}`);
  }
  return pts.join(' ');
}

/** A little island of seven hexes, the game's emblem. */
export function island(cx: number, cy: number, r: number): string {
  const w = Math.sqrt(3) * r;
  const tiles: [number, number, string][] = [
    [0, 0, PALETTE.mountain],
    [w, 0, PALETTE.forest],
    [-w, 0, PALETTE.wheat],
    [w / 2, -1.5 * r, PALETTE.pasture],
    [-w / 2, -1.5 * r, PALETTE.hills],
    [w / 2, 1.5 * r, PALETTE.sand],
    [-w / 2, 1.5 * r, PALETTE.forest],
  ];
  const sea = `<polygon points="${hexPoints(cx, cy, r * 3.3)}" fill="${PALETTE.sea}" opacity="0.18"/>`;
  return (
    sea +
    tiles
      .map(([dx, dy, fill]) => `<polygon points="${hexPoints(cx + dx, cy + dy, r * 0.94)}" fill="${fill}" stroke="${PALETTE.parchment}" stroke-width="2"/>`)
      .join('')
  );
}

/** A band of waves along the bottom edge. */
export function waves(y: number, color: string = PALETTE.sea, opacity = 0.25): string {
  let d = `M0 ${y}`;
  for (let x = 0; x < WIDTH; x += 60) d += ` q15 -10 30 0 t30 0`;
  d += ` V${HEIGHT} H0 Z`;
  return `<path d="${d}" fill="${color}" opacity="${opacity}"/>`;
}

/** The shared frame: parchment, a double rule border and the wordmark. */
export function frame(inner: string, label: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(label)}">`,
    `<title>${escapeXml(label)}</title>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${PALETTE.parchment}"/>`,
    waves(560, PALETTE.sea, 0.16),
    waves(590, PALETTE.seaDeep, 0.2),
    `<rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" rx="18" fill="none" stroke="${PALETTE.ink}" stroke-width="3"/>`,
    `<rect x="34" y="34" width="${WIDTH - 68}" height="${HEIGHT - 68}" rx="12" fill="none" stroke="${PALETTE.gold}" stroke-width="1.5"/>`,
    text(72, 92, 'HEXPLORERS', { size: 22, family: SANS, weight: 'bold', fill: PALETTE.gold, spacing: 6 }),
    inner,
    '</svg>',
  ].join('');
}

/** A seat token: a coloured disc with an initial (or a dashed ring for an open seat). */
export function seatDot(cx: number, cy: number, r: number, color: string | null, initial: string): string {
  if (!color) {
    return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r}" fill="none" stroke="${PALETTE.inkSoft}" stroke-width="3" stroke-dasharray="8 7"/>`;
  }
  return (
    `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r}" fill="${color}" stroke="${PALETTE.ink}" stroke-width="3"/>` +
    text(cx, cy + r * 0.36, initial, { size: Math.round(r * 1.0), family: SANS, weight: 'bold', fill: onColor(color), anchor: 'middle' })
  );
}

/** The first character of a name, upper-cased (a code point, so an emoji survives whole). */
export function initialOf(name: string): string {
  const first = Array.from(clip(name, 40))[0] ?? '?';
  return first.toUpperCase();
}
