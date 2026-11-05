import { describe, expect, it } from 'vitest';
import { clip, escapeXml, profileCard, resultsCard, roomInviteCard, safeColor, svgResponse } from '../../server/lib/og';

/**
 * A tiny XML well-formedness checker: balanced tags, quoted unique attributes, no stray "<" or "&" in
 * text or attribute values, only the predefined and numeric entities. Returns the elements in order.
 */
function checkXml(xml: string): string[] {
  const entity = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;
  const checkText = (t: string, where: string) => {
    for (let k = 0; k < t.length; k++) {
      if (t[k] === '<') throw new Error(`stray < in ${where}`);
      if (t[k] === '&' && !entity.test(t.slice(k))) throw new Error(`bad entity in ${where}: ${t.slice(k, k + 12)}`);
    }
  };
  const stack: string[] = [];
  const names: string[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      checkText(xml.slice(i), 'text');
      break;
    }
    checkText(xml.slice(i, lt), 'text');
    const gt = xml.indexOf('>', lt);
    if (gt < 0) throw new Error('unclosed tag');
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('/')) {
      const open = stack.pop();
      if (open !== tag.slice(1)) throw new Error(`</${tag.slice(1)}> closes <${open}>`);
    } else {
      const selfClosing = tag.endsWith('/');
      const body = selfClosing ? tag.slice(0, -1) : tag;
      const m = /^([A-Za-z][\w:-]*)((?:\s+[A-Za-z_:][\w:.-]*="[^"]*")*)\s*$/.exec(body);
      if (!m) throw new Error(`malformed tag <${tag.slice(0, 60)}>`);
      const seen = new Set<string>();
      for (const [, name, value] of m[2]!.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
        if (seen.has(name!)) throw new Error(`duplicate attribute ${name}`);
        seen.add(name!);
        checkText(value!, `attribute ${name}`);
      }
      names.push(m[1]!);
      if (!selfClosing) stack.push(m[1]!);
    }
    i = gt + 1;
  }
  if (stack.length) throw new Error(`unclosed <${stack.join('>, <')}>`);
  return names;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

const HOSTILE = [
  '</text><script>alert(1)</script>',
  '" onload="alert(1)" x="',
  "'><svg onload=alert(1)>",
  '&amp;&#x41;&bogus; & <',
  '\u0000nul\u0007bell‮evil⁦',
  '\ud800lone surrogate',
  ']]><!-- comment -->',
  '🚢'.repeat(500),
  'x'.repeat(20_000),
];

const cards = (name: string, color = '#c0392b') => ({
  invite: roomInviteCard({
    code: 'BCDFGH',
    host: name,
    mix: name,
    target: 10,
    seats: [
      { kind: 'human', name, color },
      { kind: 'bot', name: 'Bramble', color: '#2e86c1' },
      { kind: 'human', name: 'Wren', color: '#f1c40f' },
      { kind: 'open' },
    ],
  }),
  results: resultsCard({
    host: name,
    mix: name,
    turns: 41,
    durationMs: 47 * 60_000,
    standings: [
      { name, color, points: 12 },
      { name: 'Wren', color: '#f1c40f', points: 9 },
      { name: 'Bramble', color: '#2e86c1', points: 8 },
      { name: 'Ami', color: '#27ae60', points: 6, conceded: true },
    ],
  }),
  profile: profileCard({ name, handle: name, tier: name, rating: 1612, games: 57, wins: 19, color }),
});

describe('link-preview cards', () => {
  it('are well-formed 1200×630 SVG under 20 KB', () => {
    for (const [kind, svg] of Object.entries(cards("Marlow"))) {
      const names = checkXml(svg);
      expect(names[0], kind).toBe('svg');
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"'), kind).toBe(true);
      expect(bytes(svg), kind).toBeLessThan(20 * 1024);
      expect(svg, kind).not.toMatch(/href=|<image|@import|url\(/); // nothing external
    }
  });
  it('the invite shows the host, open seats, the mix, the code and "Join the crew"', () => {
    const svg = cards('Marlow').invite;
    expect(svg).toContain('Join Marlow’s island');
    expect(svg).toContain('1 seat open');
    expect(svg).toContain('first to 10 points');
    expect(svg).toContain('>BCDFGH<');
    expect(svg).toContain('Join the crew');
    expect(svg).toContain('>crew<'); // the bot seat's tag
    expect(svg).toContain('>Open<');
    expect(svg).toContain('fill="#c0392b"');
    const underway = roomInviteCard({ code: 'BCDFGH', host: 'Marlow', mix: 'Classic', seats: [{ kind: 'human', name: 'Marlow' }], phase: 'playing' });
    expect(underway).toContain('Voyage under way');
    expect(underway).not.toContain('Join the crew');
  });
  it('the results card leads with the winner and the score line', () => {
    const svg = cards('Wren').results;
    expect(svg).toContain('Wren won on Wren’s island');
    expect(svg).toContain('12–9–8–6');
    expect(svg).toContain('41 turns · 47 min');
    expect(svg).toContain('(struck colours)');
  });
  it('the profile card says what it is', () => {
    const { profile } = cards('Marlow');
    expect(profile).toContain('@Marlow');
    expect(profile).toContain('VOYAGES');
    expect(profile).toContain('33%');
    expect(profileCard({ name: 'New', games: 2, wins: 1, provisional: true, tier: 'Bosun', rating: 1200 })).toContain('Placement games');
  });
  it('escape every hostile name and stay well-formed and small', () => {
    for (const name of HOSTILE) {
      for (const [kind, svg] of Object.entries(cards(name, `red" onload="alert(1)`))) {
        const where = `${kind}: ${name.slice(0, 30)}`;
        expect(() => checkXml(svg), where).not.toThrow();
        expect(svg, where).not.toMatch(/<script|<svg onload|<!--|onload="/);
        expect(svg, where).not.toMatch(/[\u0000-\u0008‪-‮⁦-⁩]/);
        expect(bytes(svg), where).toBeLessThan(20 * 1024);
      }
    }
  });
  it('drops bad colours and junk in the room code', () => {
    expect(safeColor('#ABCDEF')).toBe('#abcdef');
    expect(safeColor('#abc')).toBe('#abc');
    expect(safeColor('red')).not.toBe('red');
    expect(safeColor('#12345g')).not.toBe('#12345g');
    expect(safeColor(undefined)).toMatch(/^#[0-9a-f]{6}$/);
    expect(roomInviteCard({ code: '<b>"X"</b>', host: 'a', mix: 'b', seats: [] })).toContain('>BXB<');
  });
});

describe('text helpers', () => {
  it('escapeXml escapes the five specials and strips what XML forbids', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
    expect(escapeXml('a\u0000b\u001fc‮d')).toBe('abcd');
    expect(escapeXml('ok 🚢')).toBe('ok 🚢');
    expect(escapeXml('lone \ud83d')).toBe('lone ');
  });
  it('clip counts code points and never splits an emoji', () => {
    expect(clip('Amber Gannet', 20)).toBe('Amber Gannet');
    expect(clip('Teal Cormorant of the Northern Reaches', 18)).toBe('Teal Cormorant of…');
    expect(clip('🚢🚢🚢🚢', 3)).toBe('🚢🚢…');
    expect(clip('  spaced\n\tout  ', 20)).toBe('spaced out');
  });
  it('svgResponse serves SVG with a strict CSP', () => {
    const res = svgResponse('<svg xmlns="http://www.w3.org/2000/svg"/>', 600);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });
});
