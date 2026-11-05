// The Worker in front of the game's files (see wrangler.toml): it runs only for the links whose
// card says more than the game's own (an invitation, a room, the watch link: see preview.ts),
// serving them the game's page with that card written in; for the game's own page, which it
// gives the clip for the chats that play it; and for the clip itself, served in byte
// ranges (see ranged). Everything else is the files themselves, served without it. (Where the
// room server will live, once online play does.)

import { TRAILER, previewFor, type Preview } from './preview';
import { ranged } from './ranges';

// (Just what this uses of the Workers runtime: the full types aren't a dependency of the game.)
interface Assets {
  fetch(request: Request | URL | string): Promise<Response>;
}
interface Element {
  setAttribute(name: string, value: string): Element;
  setInnerContent(content: string): Element;
  append(content: string, options?: { html: boolean }): Element;
  remove(): Element;
}
declare class HTMLRewriter {
  on(selector: string, handlers: { element(element: Element): void }): HTMLRewriter;
  transform(response: Response): Response;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The tags that give a card its clip. */
const videoTags = (origin: string, v: NonNullable<Preview['video']>) => [
  `<meta property="og:video" content="${escape(origin + v.path)}" />`,
  `<meta property="og:video:secure_url" content="${escape(origin + v.path)}" />`,
  '<meta property="og:video:type" content="video/mp4" />',
  `<meta property="og:video:width" content="${v.width}" />`,
  `<meta property="og:video:height" content="${v.height}" />`,
];

/** The game's page with `p`'s card in place of its own. */
function rewrite(page: Response, p: Preview, origin: string): Response {
  const image = origin + p.image.path;
  const set = (content: string) => ({ element: (e: Element) => void e.setAttribute('content', content) });
  let rewriter = new HTMLRewriter()
    .on('title', { element: (e) => void e.setInnerContent(`${p.title} · Hexplorers`) })
    .on('meta[name="description"]', set(p.description))
    .on('meta[property="og:url"]', set(p.url))
    .on('meta[property="og:title"]', set(p.title))
    .on('meta[property="og:description"]', set(p.description))
    .on('meta[property="og:image"]', set(image))
    .on('meta[property="og:image:width"]', set(String(p.image.width)))
    .on('meta[property="og:image:height"]', set(String(p.image.height)))
    .on('meta[property="og:image:alt"]', set(p.image.alt))
    .on('meta[name="twitter:card"]', set(p.card))
    .on('meta[name="twitter:title"]', set(p.title))
    .on('meta[name="twitter:description"]', set(p.description))
    .on('meta[name="twitter:image"]', set(image))
    .on('meta[name="twitter:image:alt"]', set(p.image.alt));
  // (The game's own description for search engines is the page's alone.)
  if (p.noindex) rewriter = rewriter.on('script[type="application/ld+json"]', { element: (e) => void e.remove() });
  const extra = [p.noindex ? '<meta name="robots" content="noindex" />' : '', ...(p.video ? videoTags(origin, p.video) : [])].filter(Boolean);
  if (extra.length) rewriter = rewriter.on('head', { element: (e) => void e.append(extra.join(''), { html: true }) });
  if (p.video) rewriter = rewriter.on('meta[property="og:type"]', set('video.other'));
  const out = rewriter.transform(page);
  const headers = new Headers(out.headers);
  // (Like the page itself: checked each visit, so a release reaches everyone at once.)
  headers.set('Cache-Control', 'no-cache');
  if (p.noindex) headers.set('X-Robots-Tag', 'noindex');
  return new Response(out.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: { ASSETS: Assets }): Promise<Response> {
    const url = new URL(request.url);
    // (The card's links are https whatever the request came by, bar a local test's.)
    const named = new URL(url);
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) named.protocol = 'https:';
    const read = request.method === 'GET' || request.method === 'HEAD';
    const p = read ? previewFor(named) : null;
    if (p) {
      const page = await env.ASSETS.fetch(new URL('/', url).toString());
      if (!page.ok) return page;
      return rewrite(page, p, named.origin);
    }
    // The clip, in byte ranges (see ranged).
    if (read && url.pathname.startsWith('/social/') && url.pathname.endsWith('.mp4')) {
      const file = await env.ASSETS.fetch(new URL(url.pathname, url.origin).toString());
      return file.ok ? ranged(request, file) : file;
    }
    if (!read || url.pathname !== '/') return env.ASSETS.fetch(request);
    // The game's own page as it is, with the clip for the chats that play it.
    const page = await env.ASSETS.fetch(request);
    if (!page.ok || !(page.headers.get('Content-Type') ?? '').includes('text/html')) return page;
    return new HTMLRewriter().on('head', { element: (e) => void e.append(videoTags(named.origin, TRAILER).join(''), { html: true }) }).transform(page);
  },
};
