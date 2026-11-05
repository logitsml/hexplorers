// Link previews: the cards under /og (a room's invite or results, a replay's results, a
// profile) drawn by server/lib/og as plain SVG, and the page's own tags for each of the
// game's links (meta.ts, used by the runtimes when they serve index.html). Cheap by design: a room
// card asks the room for its public card and nothing else, a replay is read once per process, and
// each image carries a cache header (a room's URL also carries a version of what it shows).

import { profileCard, resultsCard, roomInviteCard, svgResponse } from '../../lib/og';
import { fail, limited, type Handler } from '../../http/kit';
import type { Feature } from '..';
import { HANDLE_RE, inviteInput, replaySummary, roomCard, roomResults } from './cards';
import { OG_SOURCES } from './sources';

export { META_PAGE, injectMeta, pageMeta, renderPage, type PageMeta } from './meta';
export { OG_SOURCES, type OgSources } from './sources';

/** The name in /og/x/NAME.svg (null when it isn't one). */
const svgName = (file: string | undefined) => (file && file.endsWith('.svg') ? file.slice(0, -4) : null);

/** Crawlers come from few addresses and fetch a card once a link: a generous limit, per address. */
const busy = (ctx: Parameters<Handler>[2]) => limited(ctx, 'og', 120, 120);

const room: Handler = async (_req, p, ctx) => {
  const code = svgName(p.file)?.toUpperCase();
  if (!code) return fail(404, 'No such card.');
  if (await busy(ctx)) return fail(429, 'Too many cards: wait a minute.');
  const card = await roomCard(ctx, code);
  if (!card) return fail(404, 'No such room.');
  const results = card.phase === 'over' || card.phase === 'abandoned' ? roomResults(card) : null;
  // (A harbour's seats change by the minute; the page's link carries a version, so a short life is enough.)
  return svgResponse(results ? resultsCard(results) : roomInviteCard(inviteInput(card)), results ? 86_400 : 300);
};

const replay: Handler = async (_req, p, ctx) => {
  const id = svgName(p.file);
  if (!id) return fail(404, 'No such card.');
  if (await busy(ctx)) return fail(429, 'Too many cards: wait a minute.');
  const r = await replaySummary(ctx, id);
  if (!r) return fail(404, 'No such replay.');
  // (A replay never changes.)
  return svgResponse(resultsCard(r.card), 30 * 86_400);
};

const profile: Handler = async (_req, p, ctx) => {
  const handle = svgName(p.file);
  if (!handle || !HANDLE_RE.test(handle) || !OG_SOURCES.profile) return fail(404, 'No such sailor.');
  if (await busy(ctx)) return fail(429, 'Too many cards: wait a minute.');
  const found = await OG_SOURCES.profile(handle, ctx).catch(() => null);
  if (!found) return fail(404, 'No such sailor.');
  return svgResponse(profileCard(found), 3600);
};

export const og: Feature = {
  id: 'og',
  routes: [
    { method: 'GET', path: '/og/r/:file', handler: room },
    { method: 'GET', path: '/og/replay/:file', handler: replay },
    { method: 'GET', path: '/og/u/:file', handler: profile },
  ],
  // (Nothing to key: the cards are drawn here.)
  flags: () => ({ og: true }),
};
