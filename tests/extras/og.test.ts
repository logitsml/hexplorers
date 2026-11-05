// Link previews: the cards under /og (cache headers, a room's from its public card only, 404s for
// what isn't there) and each game link's page tags, rewritten in index.html with every value
// escaped, a hostile name included ("$&" too, which a replacement string would expand).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { injectMeta, OG_SOURCES, pageMeta, renderPage } from '../../server/features/og';
import { api, context, World } from './helpers';

const INDEX = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const HOSTILE = `"><i x=1>$&'`;

const tags = (html: string, key: string) => [...html.matchAll(new RegExp(`<meta (?:property|name)="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`, 'g'))].map((m) => m[1]);

async function harbourWithHostile() {
  const world = await new World(7).init();
  const g = await world.guest('Host');
  const code = await world.createRoom(g.token, { settings: { seats: 4 } });
  const sock = await world.connect(code, { token: g.token });
  await world.send(code, sock, { t: 'claim', seat: 0, name: HOSTILE });
  return { world, code, ctx: context(world) };
}

afterEach(() => {
  delete OG_SOURCES.profile;
});

describe('link previews', () => {
  it('draws a room’s invite from its card, cached briefly, with the name escaped', async () => {
    const { code, ctx } = await harbourWithHostile();
    const r = await api(ctx, 'GET', `/og/r/${code}.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    const svg = await r.text();
    expect(svg).toContain(code);
    expect(svg).not.toContain('<i x=1>');
    expect(svg).toContain('&lt;i x=1&gt;');
    expect(svg.length).toBeLessThan(20_000);
    // (No such room, and no such shape of code.)
    expect((await api(ctx, 'GET', '/og/r/BCDFGH.svg')).status).toBe(404);
    expect((await api(ctx, 'GET', '/og/r/nope.svg')).status).toBe(404);
    expect((await api(ctx, 'GET', `/og/r/${code}.png`)).status).toBe(404);
  });

  it('rewrites the page’s tags for /r/CODE, escaping a hostile name', async () => {
    const { code, ctx } = await harbourWithHostile();
    const html = await renderPage(`/r/${code}`, INDEX, ctx);
    expect(html).not.toBe(INDEX);
    // Every tag once, rewritten.
    expect(tags(html, 'og:title')).toHaveLength(1);
    expect(tags(html, 'og:image')).toEqual([expect.stringMatching(new RegExp(`^http://localhost:5173/og/r/${code}\\.svg\\?v=[0-9a-z]+$`))]);
    expect(tags(html, 'twitter:image')).toEqual(tags(html, 'og:image'));
    expect(tags(html, 'twitter:card')).toEqual(['summary_large_image']);
    expect(tags(html, 'og:image:type')).toEqual(['image/svg+xml']);
    expect(tags(html, 'og:url')).toEqual([`http://localhost:5173/r/${code}`]);
    expect(tags(html, 'robots')).toEqual(['noindex']);
    const title = tags(html, 'og:title')[0];
    expect(title).toContain('Join');
    expect(title).toContain('3 seats open');
    // The hostile name: escaped everywhere, "$&" left as it is.
    expect(title).toContain('&quot;&gt;&lt;i x=1&gt;$&amp;&#39;');
    expect(html).not.toContain('<i x=1>');
    expect(html).toMatch(/<title>Join &quot;&gt;&lt;i x=1&gt;\$&amp;&#39;’s island · 3 seats open<\/title>/);
    // (The site's page carries no Discord embed, which would show over the link's own card.)
    expect(html).not.toContain('discord:component-embed');
    // The rest of the page is untouched.
    expect(html).toContain('<div id="root">');
    expect(html.match(/<\/head>/g)).toHaveLength(1);
    // Watching, and a room that isn't there.
    expect(tags(await renderPage(`/w/${code}`, INDEX, ctx), 'og:title')[0]).toMatch(/^Watch /);
    const gone = await renderPage('/r/BCDFGH', INDEX, ctx);
    expect(tags(gone, 'og:title')).toEqual(['A room in Hexplorers']);
    expect(tags(gone, 'og:image')).toEqual(tags(INDEX, 'og:image'));
  });

  it('leaves every other page as it was', async () => {
    const { ctx } = await harbourWithHostile();
    for (const path of ['/', '/new', '/m/abc', '/assets/x.js', '/replay/!!', '/u/a']) expect(await renderPage(path, INDEX, ctx)).toBe(INDEX);
  });

  it('escapes whatever reaches the tags, in attributes and the title', () => {
    const html = injectMeta(INDEX, { title: `a"b<c>&'$1$&$$`, description: '\u202eevil\u0000', url: 'http://x/"><script>', image: 'http://x/i.svg?"' });
    expect(html).toContain('<title>a&quot;b&lt;c&gt;&amp;&#39;$1$&amp;$$</title>');
    expect(html).not.toMatch(/"><script>|\u202e|\u0000/);
    expect(html).not.toContain('component embed');
    expect(tags(html, 'og:url')).toEqual(['http://x/&quot;&gt;&lt;script&gt;']);
    expect(tags(html, 'og:image')).toEqual(['http://x/i.svg?&quot;']);
  });

  it('draws a replay’s results, cached for good, and its page', async () => {
    const world = await new World(8).init();
    const ctx = context(world);
    const seats = ['Wren', HOSTILE, 'Crew', 'Marlow'].map((name, seat) => ({ seat, name, color: ['red', 'blue', 'white', '#16a093'][seat], bot: seat === 2 }));
    const { replay } = await world.services.finishGame({ room: 'BCDFGH', options: { modules: ['sea'] }, seats, log: [], key: '00'.repeat(32), nonces: [null, null, null, null], winner: 1, points: [8, 12, 6, 9], turns: 64, startedAt: world.now - 3_600_000, endedAt: world.now, rated: false });
    const r = await api(ctx, 'GET', `/og/replay/${replay}.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(`public, max-age=${30 * 86_400}`);
    const svg = await r.text();
    expect(svg).toContain('12–9–8–6');
    expect(svg).not.toContain('<i x=1>');
    expect((await api(ctx, 'GET', '/og/replay/AAAAAAAAAAAA.svg')).status).toBe(404);
    const meta = await pageMeta(`/replay/${replay}`, ctx);
    expect(meta).toMatchObject({ image: `http://localhost:5173/og/replay/${replay}.svg`, noindex: true });
    expect(meta!.title).toBe(`${HOSTILE} won on Wren’s island · 12–9–8–6`);
    const html = await renderPage(`/replay/${replay}`, INDEX, ctx);
    expect(tags(html, 'og:title')[0]).toBe('&quot;&gt;&lt;i x=1&gt;$&amp;&#39; won on Wren’s island · 12–9–8–6');
  });

  it('draws a profile only once profiles exist, and has no card for the removed Daily Chart', async () => {
    const world = await new World(9).init();
    const ctx = context(world);
    expect((await api(ctx, 'GET', '/og/daily/2026-10-24.svg')).status).toBe(404);
    expect(await pageMeta('/daily', ctx)).toBeNull();
    // Profiles: no source yet, no card (and the page keeps the site's image).
    expect((await api(ctx, 'GET', '/og/u/wren.svg')).status).toBe(404);
    expect((await pageMeta('/u/wren', ctx))!.image).toBeUndefined();
    OG_SOURCES.profile = async (handle) => (handle === 'wren' ? { name: HOSTILE, handle, games: 10, wins: 4, tier: 'Navigator' } : null);
    const p = await api(ctx, 'GET', '/og/u/wren.svg');
    expect(p.status).toBe(200);
    expect(await p.text()).not.toContain('<i x=1>');
    expect((await api(ctx, 'GET', '/og/u/nobody.svg')).status).toBe(404);
    expect((await pageMeta('/u/wren', ctx))!.image).toBe('http://localhost:5173/og/u/wren.svg');
  });

  it('says so in /api/config', async () => {
    const world = await new World(10).init();
    const c = (await (await api(context(world), 'GET', '/api/config')).json()) as { features: Record<string, unknown> };
    expect(c.features.og).toBe(true);
  });
});
