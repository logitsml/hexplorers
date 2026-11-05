// What the game says to screen readers. These regions sit outside the HUD, which is inert while
// a dialog is open (and an inert region is never read out), so the turn's news, a refused move,
// an offer or a quality change is still heard over Settings or a trade. Online, the others' moves
// come as the log's lines and their words as the chat's, and the room's notices and the table's
// reactions as its news, all politely. They stay mounted for
// the whole visit, as a region that appears together with its text is often not read at all.

import { useEffect, useRef, useState } from 'react';
import { useUI } from '../game/store';
import { session } from '../app/session';
import { plainLog } from './Hud';
import { placingText } from './why';
import { describeCards } from './advice';
import { decisionNews } from './modules/news';

const QUALITY: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };

/** A turn marker ("— Your turn —") without the dashes, which a screen reader reads out. */
const spoken = (text: string) => plainLog(text).replace(/^[—–-]\s*|\s*[—–-]$/g, '');

/** New log lines since the last announcement, read as one (a move often logs two or three at once). */
function useLogNews() {
  const log = useUI((s) => s.log);
  const [text, setText] = useState('');
  const seen = useRef(Number.MAX_SAFE_INTEGER);
  useEffect(() => {
    // A new game starts with an empty log: what was there before is not news.
    if (log.length === 0) {
      seen.current = -1;
      return;
    }
    const fresh = log.filter((l) => l.id > seen.current);
    seen.current = log[log.length - 1].id;
    if (fresh.length) setText(fresh.map((l) => spoken(l.text)).join('. '));
  }, [log]);
  return text;
}

/** What the others say at the table (your own lines you just typed). */
function useChatNews() {
  const last = useUI((s) => s.chat[s.chat.length - 1]);
  // (Watching online, the seat drawn isn't yours: everything said there is news.)
  const mine = useUI((s) => !!last && last.player === s.me && !s.online?.watch);
  const name = useUI((s) => (last && s.view ? (last.name ?? s.view.players[last.player]?.name) : ''));
  return last && !mine ? `${name} says: ${last.text}` : '';
}

/** An offer made to you, once as it arrives (the toast that shows it may be behind a dialog). */
function useOfferNews() {
  const offer = useUI((s) => {
    const t = s.view?.trade;
    return t && t.proposer !== s.me && (t.to.length === 0 || t.to.includes(s.me)) ? t : null;
  });
  const name = useUI((s) => (offer && s.view ? s.view.players[offer.proposer].name : ''));
  // (Online the room's clock answers for you, not this device's setting.)
  const seconds = useUI((s) => (s.online ? 0 : s.settings.offerTimer));
  const id = offer?.id ?? null;
  const [text, setText] = useState('');
  useEffect(() => {
    if (!offer || session.presenter?.spectating) return;
    const timer = seconds ? ` It is declined for you after ${seconds} seconds.` : '';
    setText(`${name} offers you ${describeCards(offer.give)} for your ${describeCards(offer.get)}. Accept, counter or decline it by the action panel.${timer}`);
    // (Only a new offer is news, not each answer to it.)
  }, [id]);
  return text;
}

function useQualityNews() {
  const to = useUI((s) => s.qualityProgress?.to ?? null);
  return to ? `Preparing ${QUALITY[to]} quality. Play is paused for a moment.` : '';
}

/** Any decision an expansion leaves owed, said once as it falls to you (see modules/news.ts). */
function useModuleNews() {
  // (Picked out as strings, which the store compares by value: an object would be new every time.)
  const pick = (s: ReturnType<typeof useUI.getState>) => (s.view && !s.replay && !session.presenter?.spectating ? decisionNews(s.view, s.me) : null);
  const key = useUI((s) => pick(s)?.key ?? '');
  const news = useUI((s) => pick(s)?.text ?? '');
  const [text, setText] = useState('');
  useEffect(() => {
    setText(key ? news : '');
    // (A new decision is news, not each state while it waits.)
  }, [key]);
  return text;
}

/** What to do while choosing where to build (the compact HUD shows the same in its dock). */
function usePlacingNews() {
  const kind = useUI((s) => s.interaction.kind);
  const free = useUI((s) => s.interaction.kind === 'road' && !!s.interaction.free);
  return kind === 'road' || kind === 'settlement' || kind === 'city' ? placingText(kind, free) : '';
}

export function LiveRegions() {
  const hint = useUI((s) => s.hint);
  const decisionHint = useUI((s) => s.view ? decisionNews(s.view, s.me)?.text : undefined);
  const announce = useUI((s) => s.announce);
  const error = useUI((s) => s.error);
  const log = useLogNews();
  const chat = useChatNews();
  const offer = useOfferNews();
  const quality = useQualityNews();
  const placing = usePlacingNews();
  const modules = useModuleNews();
  // (Online, the room's notices and the table's reactions: see online/Overlays.tsx.)
  const table = useUI((s) => s.tableNews);
  return (
    <div className="live-regions">
      <div role="status" className="sr-only">
        {hint === decisionHint ? '' : hint}
      </div>
      <div aria-live="polite" className="sr-only">
        {modules}
      </div>
      <div role="status" className="sr-only">
        {placing}
      </div>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      <div aria-live="polite" className="sr-only">
        {log}
      </div>
      <div aria-live="polite" className="sr-only">
        {chat}
      </div>
      <div aria-live="polite" className="sr-only">
        {table}
      </div>
      <div aria-live="assertive" className="sr-only">
        {offer}
      </div>
      <div role="status" className="sr-only">
        {quality}
      </div>
      <div role="alert" className="sr-only">
        {error ?? ''}
      </div>
    </div>
  );
}
