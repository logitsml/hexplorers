// An online game's results card, on top of the game's own (GameOver.tsx): the room's word on how
// it finished (who conceded, whose seat the crew had at the end), its highlights as small badges
// (Results.awards), and "Share result": the replay's link, whose preview card shows the standings
// (/replay/ID), with the result in a line, through the system's share sheet where there is one,
// or copied.

import { useState } from 'react';
import { sfx } from '../../audio/sfx';
import { PLAYER_PALETTE } from '../../render/board/pieces';
import type { PlayerColor } from '../../engine';
import { Icon } from '../Cards';
import type { UiIconName } from '../../game/names';
import { useOnline } from '../../online/store';
import { awardText, shareText } from '../../online/table';
import { replayPath } from '../../online/links';
import { LineIcon } from '../LineIcons';
import { Morph } from '../Morph';

const AWARD_ICON: Record<string, UiIconName> = {
  longestRoute: 'route',
  largestArmy: 'knight',
  mostTrades: 'trade',
  bestHarvest: 'settlement',
  mostSevens: 'dice',
  mostRobbed: 'cards',
};

/** Who conceded and whose seat the crew had at the end, and the game's highlights as badges. */
export default function OnlineResults() {
  const results = useOnline((s) => s.room?.results);
  const seats = useOnline((s) => s.room?.seats);
  if (!results || !seats) return null;
  const gave = results.standings.filter((s) => s.conceded).map((s) => seats[s.seat]?.name).filter(Boolean);
  const crewed = results.standings.filter((s) => s.away && !s.conceded).map((s) => seats[s.seat]?.name).filter(Boolean);
  const awards = results.awards ?? [];
  return (
    <>
      {(gave.length > 0 || crewed.length > 0) && (
        <p className="results-note">
          {gave.length > 0 && `${gave.join(' and ')} conceded: the crew sailed ${gave.length === 1 ? 'their seat' : 'their seats'} to the end. `}
          {crewed.length > 0 && `The crew had ${crewed.join(' and ')}’s helm at the end.`}
        </p>
      )}
      {awards.length > 0 && (
        <ul className="award-badges" aria-label="Highlights">
          {awards.map((a) => {
            const s = seats[a.seat];
            const t = awardText(a.award, a.value);
            const pc = s ? (PLAYER_PALETTE[s.color as PlayerColor]?.ui ?? s.color) : undefined;
            return (
              <li key={`${a.award}-${a.seat}`} className="award-badge" style={{ ['--pc' as string]: pc }} aria-label={`${t.label}: ${s?.name ?? `Seat ${a.seat + 1}`}`}>
                <Icon name={AWARD_ICON[a.award] ?? 'vp'} size={18} />
                <span aria-hidden>
                  <b>{t.short}</b> {s?.name}
                  {a.value !== undefined && <small> · {a.value}</small>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Share the result: the replay's link (its own preview card) and the result in a line. */
export function ShareResult({ disabled }: { disabled?: boolean }) {
  const results = useOnline((s) => s.room?.results);
  const seats = useOnline((s) => s.room?.seats);
  const me = useOnline((s) => (s.watch ? null : (s.you?.seat ?? null)));
  const [copied, setCopied] = useState(false);
  if (!results?.replay || !seats) return null;
  const url = `${location.origin}${replayPath(results.replay)}`;
  const text = shareText(results, seats, me);
  const share = async () => {
    sfx.play('click');
    if (typeof navigator.share === 'function') {
      try {
        // (A link and one line, no title: iOS's targets join them, and a title comes out twice.)
        await navigator.share({ url, text });
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link', url);
    }
  };
  return (
    <button className="btn ghost share-result" disabled={disabled} onClick={() => void share()} aria-live="polite">
      <LineIcon name={copied ? 'check' : 'share'} size={18} />
      <Morph>{copied ? 'Link copied' : 'Share result'}</Morph>
    </button>
  );
}
