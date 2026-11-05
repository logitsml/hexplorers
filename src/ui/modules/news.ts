// Every expansion decision, whether answered by a dedicated panel or the generic controls.
// Live.tsx keeps this news outside the inert HUD so it is heard over an open dialog.

import type { GameState, PlayerId } from '../../engine';
import { decisionText } from '../../game/decisions';

export function decisionNews(s: GameState, me: PlayerId): { key: string; text: string } | null {
  const top = s.pending[s.pending.length - 1];
  if (!top || !top.players.includes(me)) return null;
  // The payload distinguishes successive cards owed by the same venture, not only their kind.
  return { key: `${s.turn}:${s.pending.length}:${top.kind}:${JSON.stringify(top.data)}:${top.players.join(',')}`, text: decisionText(s, me, top) };
}
