// The words of the notes a room sends to someone away from the table ("your move", the end of the
// game), and the few public moments a note can mention ("Wren built a city"). Pure functions over
// what the room passes in.

import type { CardCounts, GameEvent, GameState, PlayerId } from '../../src/engine';
import { CARD_NAMES } from '../../src/game/names';

/** Cards in words: "2 wool and 1 ore". */
export function cardsText(c: CardCounts): string {
  const parts = Object.entries(c)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${n} ${(CARD_NAMES[k as keyof CardCounts] ?? k).toLowerCase()}`);
  if (parts.length <= 1) return parts[0] ?? 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** The island's name as its people know it: the host's ("Marlow’s island"), or yours. */
export function islandName(hostName: string | undefined, yours: boolean): string {
  if (yours) return 'your island';
  return hostName ? `${hostName}’s island` : 'your voyage';
}

/** A public moment worth a line in a note, if this event is one. */
export function momentOf(e: GameEvent, name: (p: PlayerId) => string): { seat: PlayerId; text: string } | null {
  switch (e.type) {
    case 'cityBuilt':
      return { seat: e.player, text: `${name(e.player)} built a city.` };
    case 'settlementBuilt':
      return { seat: e.player, text: `${name(e.player)} built a house.` };
    case 'robberMoved':
      return { seat: e.player, text: `${name(e.player)} moved the robber.` };
    case 'tradeExecuted':
      return { seat: e.from, text: `${name(e.from)} and ${name(e.to)} made a trade.` };
    case 'longestRoadChanged':
      return e.to === null ? null : { seat: e.to, text: `${name(e.to)} has the longest route.` };
    case 'largestArmyChanged':
      return e.to === null ? null : { seat: e.to, text: `${name(e.to)} has the biggest army.` };
    case 'diceRolled':
      return e.total === 7 ? { seat: e.player, text: `${name(e.player)} rolled a seven.` } : null;
    default:
      return null;
  }
}

export interface MoveNoteInput {
  state: GameState;
  seat: PlayerId;
  kind: 'turn' | 'decision';
  name: (p: PlayerId) => string;
  island: string;
  /** The latest public moment by someone else, if the room remembers one. */
  recent?: string;
}

/** "Your move on Marlow’s island", with what it is you owe (or what happened) as its body. */
export function moveNote(x: MoveNoteInput): { title: string; body: string } {
  const s = x.state;
  const title = `Your move on ${x.island}`;
  if (x.kind === 'decision') {
    const t = s.trade;
    if (s.phase === 'main' && t && t.proposer !== x.seat) return { title, body: `${x.name(t.proposer)} offers ${cardsText(t.give)} for ${cardsText(t.get)}.` };
    const n = s.pendingDiscards[x.seat];
    if (s.phase === 'discard' && n !== undefined) return { title, body: `A seven! Choose ${n} card${n === 1 ? '' : 's'} to throw overboard.` };
    return { title, body: 'The table is waiting on your answer.' };
  }
  if (s.phase === 'setupSettlement' || s.phase === 'setupRoad') return { title, body: 'Your turn to settle the coast.' };
  return { title, body: x.recent ?? 'It’s your turn.' };
}

/** The voyage is over. */
export function overNote(island: string, winner: string | null, you: boolean): { title: string; body: string } {
  return { title: `The voyage on ${island} is over`, body: you ? 'You won! Come and see the results.' : winner ? `${winner} won. Come and see the results.` : 'Come and see the results.' };
}
