// Text checks for free chat and names: normalised (NFKC; no control, bidi or zero-width
// characters; combining marks capped; whitespace collapsed), capped in length, links refused, and a
// small word list masked (chat) or refused (names). A later version can swap in a fuller filter
// behind the same function.

import { CHAT_MAX, NAME_MAX } from '../../src/net/protocol';

/** Words masked in chat and refused in names, as prefixes of a word (after undoing leetspeak and repeats). */
const WORDS = [
  'fuck', 'shit', 'cunt', 'bitch', 'nigg', 'fag', 'retard', 'whore', 'slut', 'dick', 'cock', 'pussy', 'asshole', 'bastard',
  'wank', 'twat', 'kike', 'spic', 'chink', 'rape', 'nazi', 'motherf',
];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

const plain = (w: string) =>
  w
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET[c])
    .replace(/[^\p{L}]/gu, '')
    .replace(/(.)\1+/g, '$1');

const bad = (w: string) => {
  const p = plain(w);
  return p.length > 0 && WORDS.some((x) => p.startsWith(x.replace(/(.)\1+/g, '$1')));
};

/** Links, addresses and phone numbers: never in chat (a lure is one click away). */
const LINKY = [
  /\b(?:https?|ftp):\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]{2,}\.(?:com|net|org|io|gg|co|me|ly|tv|xyz|app|dev|link|ru|uk|de|info|biz|site|online|shop|club)\b/i,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  /(?:\d[\s.-]?){8,}/,
];

/** Clean a text for showing: the text, masked, or null to drop it. */
export function moderateText(text: string, kind: 'chat' | 'name'): string | null {
  if (typeof text !== 'string') return null;
  let t = text.normalize('NFKC');
  t = t.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  t = t.replace(/[​-‏‪-‮⁠-⁩﻿\u{e0000}-\u{e007f}]/gu, '');
  t = t.replace(/(\p{M}{2})\p{M}+/gu, '$1');
  t = t.replace(/\s+/g, ' ').trim();
  const max = kind === 'name' ? NAME_MAX : CHAT_MAX;
  if (t.length > max) t = t.slice(0, max).trim();
  if (!t || !/[\p{L}\p{N}\p{S}\p{P}]/u.test(t)) return null;
  if (LINKY.some((r) => r.test(t))) return null;
  const words = t.split(/(\s+)/);
  if (kind === 'name') return words.some((w) => bad(w)) || bad(t) ? null : t;
  return words.map((w) => (/\s/.test(w) || !bad(w) ? w : '•••')).join('');
}
