// The page's own tags for the game's links: when a runtime serves index.html for /r/CODE, /w/CODE,
// /replay/ID or /u/HANDLE, its title, description and Open Graph and Twitter tags are
// rewritten for that link (by string, each value escaped), with the image pointing at the link's
// card under /og. The site-wide Discord component embed is taken out of these pages, so Discord
// shows the link's own card rather than the game's. Anything that goes wrong leaves the page as it
// was: a preview is never worth a page that doesn't load.

import { clip } from '../../lib/og';
import type { HttpContext } from '../../http/kit';
import { HANDLE_RE, REPLAY_ID_RE, cardVersion, inviteInput, replaySummary, roomCard, roomResults, scoreLine } from './cards';
import { OG_SOURCES } from './sources';

/** The paths whose page gets tags of its own. */
export const META_PAGE = /^\/(r|w|replay|u)(\/|$)/;

export interface PageMeta {
  title: string;
  description: string;
  /** Absolute. Absent: the site's own card stays. */
  image?: string;
  imageAlt?: string;
  url: string;
  /** Rooms and replays are nobody's search result. */
  noindex?: boolean;
}

/** Text for an attribute or an element: control and bidi-override characters gone, then escaped. */
export function escapeHtml(text: string): string {
  return clip(text, 400).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const possessive = (name: string) => `${clip(name, 24)}’s`;

/** What the page of this path says of itself, or null for a path that keeps the site's tags. */
export async function pageMeta(path: string, ctx: HttpContext): Promise<PageMeta | null> {
  const base = new URL(ctx.env.PUBLIC_URL).origin;
  const p = path.split(/[?#]/)[0].replace(/\/+$/, '');
  let m: RegExpExecArray | null;

  if ((m = /^\/([rw])\/([^/]+)$/.exec(p))) {
    const code = decodeURIComponent(m[2]).toUpperCase();
    const watch = m[1] === 'w';
    const url = `${base}/${m[1]}/${code}`;
    const card = await roomCard(ctx, code);
    if (!card) return { title: 'A room in Hexplorers', description: 'This room has closed, or its code is mistyped. Open a harbour of your own and invite the crew.', url, noindex: true };
    const invite = inviteInput(card);
    const image = `${base}/og/r/${card.code}.svg?v=${cardVersion(card)}`;
    const details = [invite.mix, `${invite.seats.length} players`, invite.target ? `first to ${invite.target} points` : ''].filter(Boolean).join(' · ');
    const island = `${possessive(invite.host)} island`;
    const results = card.phase === 'over' || card.phase === 'abandoned' ? roomResults(card) : null;
    if (results) {
      const winner = results.standings[0];
      return { title: `${winner ? `${clip(winner.name, 24)} won on ` : ''}${island} · ${scoreLine(results)}`, description: `${details}. ${results.turns} turns.`, image, imageAlt: `The results on ${island}`, url, noindex: true };
    }
    if (card.phase === 'playing') {
      return { title: `${island} · voyage under way`, description: `${watch ? 'Watch from the quay: ' : ''}${details}.`, image, imageAlt: `${island}, voyage under way`, url, noindex: true };
    }
    const open = invite.seats.filter((s) => s.kind === 'open').length;
    const seats = open ? plural(open, 'seat open', 'seats open') : 'table full';
    return { title: `${watch ? 'Watch' : 'Join'} ${island} · ${seats}`, description: `${details}. Room ${card.code}: come aboard, no sign-up.`, image, imageAlt: `An invitation to ${island}, room ${card.code}`, url, noindex: true };
  }

  if ((m = /^\/replay\/([^/]+)$/.exec(p))) {
    const id = decodeURIComponent(m[1]);
    if (!REPLAY_ID_RE.test(id)) return null;
    const url = `${base}/replay/${id}`;
    const r = await replaySummary(ctx, id);
    if (!r) return { title: 'A voyage’s replay · Hexplorers', description: 'This replay can’t be found.', url, noindex: true };
    const island = `${possessive(r.card.host)} island`;
    return {
      title: `${r.winner ? `${clip(r.winner, 24)} won on ` : ''}${island} · ${scoreLine(r.card)}`,
      description: `Watch the replay: ${r.turns} turns of ${r.card.mix}. Every roll checks out against the dice key shown at the start.`,
      image: `${base}/og/replay/${id}.svg`,
      imageAlt: `The results on ${island}`,
      url,
      noindex: true,
    };
  }

  if ((m = /^\/u\/([^/]+)$/.exec(p))) {
    const handle = decodeURIComponent(m[1]);
    if (!HANDLE_RE.test(handle)) return null;
    const url = `${base}/u/${handle}`;
    const profile = OG_SOURCES.profile ? await OG_SOURCES.profile(handle, ctx).catch(() => null) : null;
    if (!profile) return { title: 'A sailor’s logbook · Hexplorers', description: 'Sail, trade and prosper on a living island, with friends or the crew.', url };
    const name = clip(profile.name || 'A sailor', 24);
    return {
      title: `${name} · Hexplorers`,
      description: `${profile.tier ?? 'Unrated'} · ${plural(profile.games, 'voyage', 'voyages')} · ${plural(profile.wins, 'win', 'wins')}.`,
      image: `${base}/og/u/${handle}.svg`,
      imageAlt: `${name}’s logbook`,
      url,
    };
  }
  return null;
}

// ------------------------------------------------------------------ the page

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Put a <meta> tag (attr="key") in the head, replacing the page's own; null takes it out. */
function setTag(html: string, attr: 'property' | 'name', key: string, value: string | null): string {
  const re = new RegExp(`[ \\t]*<meta\\s+${attr}="${reEscape(key)}"\\s+content="[^"]*"\\s*/?>\\n?`);
  // (A function, never a replacement string: a name with "$&" in it stays as it is.)
  const tag = value === null ? '' : `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
  if (re.test(html)) return html.replace(re, () => (tag ? `    ${tag}\n` : ''));
  return tag ? html.replace(/([ \t]*)<\/head>/i, (_, indent: string) => `${indent}  ${tag}\n${indent}</head>`) : html;
}

/** The page with this link's tags. */
export function injectMeta(html: string, meta: PageMeta): string {
  let out = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeHtml(meta.title)}</title>`);
  // (Discord would show the site's component embed over these tags: it goes, with the comment over it.)
  out = out.replace(/(?:[ \t]*<!--(?:(?!-->)[^\n])*-->\n)?[ \t]*<script id="discord:component-embed"[\s\S]*?<\/script>\n?/, '');
  const image = meta.image ?? null;
  const tags: ['property' | 'name', string, string | null][] = [
    ['name', 'description', meta.description],
    ['property', 'og:url', meta.url],
    ['property', 'og:title', meta.title],
    ['property', 'og:description', meta.description],
    ['name', 'twitter:title', meta.title],
    ['name', 'twitter:description', meta.description],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'robots', meta.noindex ? 'noindex' : null],
  ];
  if (image) {
    tags.push(
      ['property', 'og:image', image],
      ['property', 'og:image:type', 'image/svg+xml'],
      ['property', 'og:image:width', '1200'],
      ['property', 'og:image:height', '630'],
      ['property', 'og:image:alt', meta.imageAlt ?? meta.title],
      ['name', 'twitter:image', image],
      ['name', 'twitter:image:alt', meta.imageAlt ?? meta.title],
    );
  }
  for (const [attr, key, value] of tags) out = setTag(out, attr, key, value);
  return out;
}

/** index.html as served for this path: with the link's own tags when it is one of the game's links. */
export async function renderPage(path: string, html: string, ctx: HttpContext): Promise<string> {
  if (!META_PAGE.test(path)) return html;
  try {
    const meta = await pageMeta(path, ctx);
    return meta ? injectMeta(html, meta) : html;
  } catch (e) {
    console.warn(JSON.stringify({ ev: 'pageMetaFailed', error: String((e as Error)?.message ?? e).slice(0, 120) }));
    return html;
  }
}
