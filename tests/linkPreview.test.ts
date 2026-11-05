import { describe, expect, it } from 'vitest';
import { previewFor, senderName } from '../src/worker/preview';

const at = (path: string) => previewFor(new URL(path, 'https://hexplorers.xyz'));

describe('link previews', () => {
  it('leaves the game itself, and anything else, to the page’s own card', () => {
    expect(at('/')).toBeNull();
    expect(at('/?watch')).toBeNull();
    expect(at('/assets/index.js')).toBeNull();
    expect(at('/join/')).toBeNull();
  });

  it('names a room and who saved the seat, and keeps it out of search', () => {
    const p = at('/join/k7qx?from=Marlow')!;
    expect(p.title).toBe('Marlow saved you a seat · room K7QX');
    expect(p.description).toContain('room K7QX');
    expect(p.url).toBe('https://hexplorers.xyz/join/k7qx?from=Marlow');
    expect(p.image.path).toBe('/social/room.jpg?v=5');
    expect(p.card).toBe('summary');
    expect(p.noindex).toBe(true);
    expect(p.video).toBeUndefined();
    expect(at('/join/K7QX')!.title).toBe('Join room K7QX on Hexplorers');
  });

  it('takes no room code but letters and digits', () => {
    expect(at('/join/<script>')).toBeNull();
    expect(at('/join/ab')).toBeNull();
    expect(at('/join/ABCDEFGHIJK')).toBeNull();
    expect(at('/join/AB-CD')).toBeNull();
  });

  it('says who sent an invitation, or that you are invited', () => {
    expect(at('/invite?from=Marlow')!.title).toBe('Marlow invited you to Hexplorers');
    expect(at('/invite/')!.title).toBe('You’re invited to Hexplorers');
    expect(at('/invite')!.image.path).toBe('/social/invite.jpg?v=5');
  });

  it('gives the watch link the clip in every chat, and a picture across the card', () => {
    const p = at('/watch')!;
    expect(p.video?.path).toBe('/social/trailer.mp4?v=5');
    expect(p.card).toBe('summary_large_image');
    expect(p.noindex).toBe(false);
  });

  it('shows a sender’s name as one short line of text', () => {
    expect(senderName('  Captain\n  Bramble ')).toBe('Captain Bramble');
    expect(senderName('<b>Marlow</b>')).toBe('bMarlow/b');
    expect(senderName('   ')).toBeNull();
    expect(senderName(null)).toBeNull();
    const long = senderName('A'.repeat(40))!;
    expect([...long].length).toBe(24);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the clip in byte ranges', async () => {
  const { ranged } = await import('../src/worker/ranges');
  const file = () => new Response(new Uint8Array(1000).map((_, i) => i % 256), { headers: { 'Content-Type': 'video/mp4' } });
  const get = (range?: string, method = 'GET') => ranged(new Request('https://hexplorers.xyz/social/trailer.mp4', { method, headers: range ? { Range: range } : {} }), file());

  it('serves the range asked for, from a start, to the end or the last bytes', async () => {
    const a = await get('bytes=0-1');
    expect(a.status).toBe(206);
    expect(a.headers.get('Content-Range')).toBe('bytes 0-1/1000');
    expect([...new Uint8Array(await a.arrayBuffer())]).toEqual([0, 1]);
    const b = await get('bytes=990-');
    expect(b.headers.get('Content-Range')).toBe('bytes 990-999/1000');
    expect(b.headers.get('Content-Length')).toBe('10');
    const c = await get('bytes=-4');
    expect(c.headers.get('Content-Range')).toBe('bytes 996-999/1000');
    expect((await c.arrayBuffer()).byteLength).toBe(4);
  });

  it('serves the whole file, saying ranges may be asked for, without one', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('Accept-Ranges')).toBe('bytes');
    expect((await r.arrayBuffer()).byteLength).toBe(1000);
    expect((await get('bytes=0-1,5-6')).status).toBe(200);
  });

  it('refuses a range past the end, and sends no body for HEAD', async () => {
    const r = await get('bytes=5000-');
    expect(r.status).toBe(416);
    expect(r.headers.get('Content-Range')).toBe('bytes */1000');
    const h = await get('bytes=0-9', 'HEAD');
    expect(h.status).toBe(206);
    expect(h.body).toBeNull();
  });
});
