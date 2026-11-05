// Everything a player holds, as one list: the cards (resources, the guilds' commodities, oil) and
// the expansions' tokens that are spent like them (coins, fish, prisoners). The hand, the player
// cards, the phone's panel and the trade dialog all read the tokens from here, so a coin or a fish
// is named, painted and counted the same wherever it shows.

import { usesCoins, type Card, type GameState, type PlayerId } from '../engine';
import { fishOf } from '../engine/modules/fisheries/fish';
import { CARD_ICON, CARD_NAMES, TOKEN_ICON } from './names';
import { count } from './modulePanels';

export type TokenId = 'coin' | 'fish' | 'prisoner';
export type HoldingId = Card | TokenId;

/** One token kind a seat holds: its painting, how many, and its name (on hover and for screen readers). */
export interface TokenHolding {
  id: TokenId;
  icon: string;
  tint: string;
  name: string;
  n: number;
  label: string;
}

export const TOKEN_NAMES: Record<TokenId, string> = { coin: 'Coins', fish: 'Fish', prisoner: 'Prisoners' };
export const TOKEN_TINT: Record<TokenId, string> = { coin: '#b8892a', fish: '#4f8aa3', prisoner: '#7a6a5a' };

export const holdingName = (id: HoldingId): string => (id in TOKEN_NAMES ? TOKEN_NAMES[id as TokenId] : CARD_NAMES[id as Card]);
export const holdingIcon = (id: HoldingId): string => (id in TOKEN_NAMES ? TOKEN_ICON[id as TokenId] : CARD_ICON[id as Card]);

/**
 * The tokens `seat` holds in this game, in a fixed order: coins (rivers, the invasion), fish
 * (fisheries), prisoners (the invasion). Fish lie face down: `own` is the seat's own view, which
 * counts what its tokens are worth; anyone else sees only how many tokens there are.
 */
export function tokensOf(s: GameState, seat: PlayerId, own: boolean): TokenHolding[] {
  const out: TokenHolding[] = [];
  const p = s.players[seat];
  if (usesCoins(s)) out.push(token('coin', p.coins, count(p.coins, 'coin')));
  const fish = s.ext.fisheries;
  if (fish) {
    // (Online the room hides others' values as zeros: their count still holds.)
    const tokens = fish.tokens[seat] ?? [];
    if (own) {
      const held = tokens.filter((t) => t > 0);
      const n = fishOf(held);
      out.push(token('fish', n, `${n} fish, on ${count(held.length, 'token')}`));
    } else {
      out.push(token('fish', tokens.length, `${count(tokens.length, 'fish token')}, face down`));
    }
  }
  if (s.ext.invasion) {
    const n = s.ext.invasion.prisoners[seat] ?? 0;
    out.push(token('prisoner', n, count(n, 'prisoner')));
  }
  return out;
}

const token = (id: TokenId, n: number, label: string): TokenHolding => ({ id, icon: TOKEN_ICON[id], tint: TOKEN_TINT[id], name: TOKEN_NAMES[id], n, label });
