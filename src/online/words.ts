// What the room's codes say in words: quick talk (sent as a code, so every client can show it in
// its player's own words and none of it needs moderating), reactions and the room's notices.

import type { NoticeKind, QuickTalk, Reaction } from '../net/protocol';

export const QUICK_WORDS: Record<QuickTalk, string> = {
  hello: 'Hello!',
  goodLuck: 'Good luck!',
  niceMove: 'Nice move!',
  thanks: 'Thanks!',
  sorry: 'Sorry!',
  oops: 'Oops!',
  wellPlayed: 'Well played',
  goodGame: 'Good game!',
  oneMoment: 'One moment…',
  yourTurn: 'Your turn!',
  anyWool: 'Any wool?',
  anyGrain: 'Any wheat?',
  anyLumber: 'Any wood?',
  anyBrick: 'Any brick?',
  anyOre: 'Any ore?',
  noTrades: 'No trades, sorry',
  deal: 'Deal!',
  noDeal: 'No deal',
};

/** The quick talk a free line matches word for word (so the table's quick phrases go as codes). */
export function quickFor(text: string): QuickTalk | undefined {
  const t = text.trim().toLowerCase();
  return (Object.keys(QUICK_WORDS) as QuickTalk[]).find((k) => QUICK_WORDS[k].toLowerCase() === t);
}

/** A reaction as its button names it, and as a screen reader hears someone send it ("Ana waves"). */
export const REACTION_WORDS: Record<Reaction, { name: string; did: string }> = {
  wave: { name: 'Wave', did: 'waves' },
  laugh: { name: 'Laugh', did: 'laughs' },
  wow: { name: 'Wow', did: 'is amazed' },
  cheer: { name: 'Cheer', did: 'cheers' },
  groan: { name: 'Groan', did: 'groans' },
  think: { name: 'Hmm', did: 'is thinking it over' },
  heart: { name: 'Heart', did: 'sends a heart' },
  anchor: { name: 'Steady', did: 'says steady on' },
};

/**
 * A notice from the room, about `name`'s seat (or yours, `mine`). A hail is only ever sent to the
 * one hailed, its seat the one who hailed: `name` is theirs.
 */
export function noticeText(kind: NoticeKind, name = 'Someone', mine = false, o: { playing?: boolean } = {}): string {
  switch (kind) {
    case 'nudged':
      return `${name} hailed you: the table is waiting on you`;
    case 'kicked':
      return mine ? 'The host has asked you to leave this table' : `${name} has left the table`;
    case 'hostChanged':
      return mine ? 'You are the host now' : `${name} is the host now`;
    case 'paused':
      return 'The game is paused';
    case 'resumed':
      return 'The game goes on';
    case 'away':
      return mine ? 'The crew is keeping your seat warm' : `${name} is away: the crew plays for them`;
    case 'back':
      return mine ? 'You have the helm again' : `${name} is back`;
    case 'conceded':
      return mine ? 'You conceded: the crew sails your seat' : `${name} conceded: the crew sails for them`;
    case 'left':
      // (Before the game, leaving is only closing the table: nobody takes the seat.)
      return mine ? 'You left the table' : o.playing ? `${name} left: the crew sails for them` : `${name} left the table`;
    case 'joined':
      return mine ? 'You came aboard' : `${name} is back at the table`;
    case 'timeout':
      return mine ? 'Time ran out for your move' : `Time ran out for ${name}`;
    case 'handedOff':
      return mine ? 'Your seat was taken up on another device' : `${name} moved to another device`;
    case 'reported':
      return 'Thanks: the report was sent';
    case 'abandoned':
      return 'Everyone has left: the game is over';
    case 'starting':
      return 'Setting sail…';
  }
}
