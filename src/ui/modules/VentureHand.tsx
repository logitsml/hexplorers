// The venture hand: your cards with what each does, the ones you can play now (each played as
// legalActions lists it: at once, by a pick on the board, a resurvey's two hexes chosen in turn, or
// from a short list of its ways), the rest with the reason they can't be, and the limit of four.
// Each card's painting is cropped to its subject in the row, and the card itself opens beside it on
// a hover, a focus or a held finger. The other seats' counts are on their player cards (as a seat
// would see them over a network: their cards are never read here); this page names only the
// ventures they have shown. The decisions the ventures leave you owing (back down to four, which
// deck to draw from, a spymaster's take) are answered in VentureDecision; the cards they ask of a
// hand, and the Learning ability's pick, in CardPicks.tsx.

import { useMemo, useState } from 'react';
import type { Action, GameState, PlayerId, Track } from '../../engine';
import { useUI } from '../../game/store';
import { CARD_NAMES, TRACK_ICON, asset } from '../../game/names';
import { legalOf, listOf, meFirst, topOf } from '../../game/modulePanels';
import { TRACKS, VENTURE_LIMIT } from '../../engine/modules/guilds/rules';
import { VENTURES } from '../../engine/modules/guilds/ventures';
import { seenHex } from '../../game/hexView';
import { ventureIdleReason } from '../../engine/modules/guilds/why';
import type { GuildsPending, VentureCard, VentureId } from '../../engine/modules/guilds/types';
import { ReasonButton } from '../Hud';
import { Morph } from '../Morph';
import { explain, whyNotNow } from '../why';
import { act, endPick, nameOf, pickTarget, Seat, startPick, startStagedPick, usePicking, useWatching } from './shared';
import { stagesOf } from '../../game/moduleActions';
import { TRACK_NAMES } from '../../game/tableWords';
import { decisionTitle } from '../../game/decisions';
import { ArtCrop, useCardPreview, venturePainting, type PreviewCard } from './CardPreview';

/** Each guild's colour (the band down its cards' edge, in ui.css), for the preview's ribbon. */
const TRACK_TONE: Record<Track, string> = { learning: '#3f6f8a', commerce: '#a8743a', statecraft: '#7b4a86' };

/** A venture as its preview shows it: the painting, the name, its guild and its rule. */
function venturePreview(card: VentureId): PreviewCard {
  const def = VENTURES[card];
  return { art: venturePainting(card), name: def.name, kicker: `${TRACK_NAMES[def.track]} venture`, text: def.text, tone: TRACK_TONE[def.track] };
}

type Play = Extract<Action, { type: 'guilds/play' }>;

/** Why `card` can't be played now, or null. */
function playReason(s: GameState, me: PlayerId, card: VentureId, legal: Play[], busy: boolean): string | null {
  const def = VENTURES[card];
  if (!def.play) return 'Spent with an improvement, for one commodity less';
  if (legal.length) return null;
  if (busy) return 'Wait for the last move to finish';
  const now = whyNotNow(def.beforeRoll ? 'roll' : 'main');
  if (now) return def.beforeRoll && now === 'Only before you roll' ? 'Played before you roll' : now;
  // (The card's own reason is the engine's, so it can't drift from the options it offers.)
  return ventureIdleReason(s, me, card) ?? 'Nothing for it to do right now';
}

/** One way of playing a venture, in words (the spot-free ones: a pick shows its spot on the board). */
function playLabel(s: GameState, me: PlayerId, a: Play): string {
  if (a.dice) return `${a.dice[0] + a.dice[1]}`;
  if (a.kind) return CARD_NAMES[a.kind];
  if (a.target !== undefined) return nameOf(s, a.target, me);
  const warden = (id: number) => {
    const w = s.wardens.find((x) => x.id === id);
    return w ? `${w.owner === me ? 'your' : `${s.players[w.owner].name}'s`} rank ${w.rank} warden` : `warden ${id}`;
  };
  if (a.wardens) return `Promote ${listOf(a.wardens.map(warden))}`;
  if (a.warden !== undefined) return `Displace ${warden(a.warden)}`;
  if (a.hex !== undefined) return seenHex(s, a.hex).label;
  return VENTURES[a.card].name;
}

/** The distinct cards in a hand, with how many of each. */
function grouped(hand: readonly VentureCard[]): [VentureId, number][] {
  const out = new Map<VentureId, number>();
  for (const c of hand) if (c !== 'hidden') out.set(c, (out.get(c) ?? 0) + 1);
  return [...out];
}

function VentureRow({ s, me, card, n, busy, open, onOpen }: { s: GameState; me: PlayerId; card: VentureId; n: number; busy: boolean; open: boolean; onOpen: (o: boolean) => void }) {
  const def = VENTURES[card];
  const legal = legalOf<Play>(s, me, 'guilds/play', (a) => a.card === card);
  const reason = playReason(s, me, card, legal, busy);
  const picking = usePicking();
  const it = useUI((st) => st.interaction);
  const pickLabel = def.name;
  const target = pickTarget(legal);
  const staged = legal.length > 0 && stagesOf(legal[0]) !== null;
  const play = () => {
    if (picking === pickLabel) return endPick();
    if (open) return onOpen(false);
    // One way to play it: play it. Ways that differ only in a spot: choose it on the board, and
    // a resurvey's two hexes one after the other. Otherwise the ways are listed under the card.
    if (legal.length === 1) return act(legal[0]);
    if (staged) return startStagedPick(pickLabel, legal);
    if (target) return startPick(pickLabel, target, legal);
    onOpen(true);
  };
  // (The first hex of a resurvey drops out of the board's marks, so it's named here.)
  const first = picking === pickLabel && it.kind === 'pick' && it.chosen?.[0]?.length === 1 ? seenHex(s, it.chosen[0][0]) : null;
  const active = picking === pickLabel || open;
  const [previewProps, preview] = useCardPreview(venturePreview(card));
  return (
    <li className={`vh-card track-${def.track}${reason ? '' : ' playable'}`} {...previewProps}>
      {/* (Focusable for its preview when there's no Play button to carry it.) */}
      <span className="vh-art-wrap" tabIndex={def.play ? undefined : 0} role={def.play ? undefined : 'img'} aria-label={def.play ? undefined : `${def.name}: ${def.text}`}>
        <ArtCrop className="vh-art" art={venturePainting(card)} w={40} h={40} />
      </span>
      <div className="vh-top">
        <span className="vh-name">
          {def.name}
          {n > 1 && <span className="vh-n"> ×{n}</span>}
        </span>
        {def.play && (
          <ReasonButton className={`btn small vh-play${active ? ' on' : ''}`} reason={reason} onClick={play} aria-pressed={active ? true : undefined} aria-label={active ? `Cancel playing ${def.name}` : `Play ${def.name}`}>
            <Morph>{active ? 'Cancel' : 'Play'}</Morph>
          </ReasonButton>
        )}
      </div>
      <p className="vh-text">{def.text}</p>
      {!def.play && <p className="vh-text vh-why">{reason}</p>}
      {first && <p className="vh-text vh-so-far">Swapping the {first.numbers.join('/')} on {first.kind} with…</p>}
      {preview}
      {open && !reason && (
        <div className={`vh-ways${legal.every((a) => a.dice) ? ' dice' : ''}`} role="group" aria-label={`Ways to play ${def.name}`}>
          {legal.map((a, i) => (
            <button key={i} type="button" className="btn small ghost" onClick={() => (onOpen(false), act(a))}>
              {playLabel(s, me, a)}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

export function VentureHand() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const [open, setOpen] = useState<VentureId | null>(null);
  const watching = useWatching();
  const g = view?.ext.guilds;
  const mine = useMemo(() => (g ? grouped(g.hands[me] ?? []) : []), [g, me]);
  if (!view || !g) return null;
  const held = g.hands[me]?.length ?? 0;
  const over = held > VENTURE_LIMIT;
  // (Watching a game, every seat is a count: no hand is yours to see.)
  const others = meFirst(view, me).filter((p) => watching || p !== me);
  if (watching) {
    return (
      <div className="venture-hand">
        <OthersVentures s={view} me={me} seats={others} />
      </div>
    );
  }
  return (
    <div className="venture-hand">
      <div className={`mp-sub${over ? ' warn' : ''}`}>
        {over ? `${held} held: put ${held - VENTURE_LIMIT} back by the end of your turn (${VENTURE_LIMIT} at most)` : `${held} of ${VENTURE_LIMIT} held`}
      </div>
      {mine.length === 0 ? (
        <p className="mp-empty">No ventures yet. Climbing a track draws them when its face shows on the event die.</p>
      ) : (
        <ul className="vh-cards">
          {mine.map(([card, n]) => (
            <VentureRow key={card} s={view} me={me} card={card} n={n} busy={busy} open={open === card} onOpen={(o) => setOpen(o ? card : null)} />
          ))}
        </ul>
      )}
      {g.shown[me]?.length > 0 && <p className="vh-shown">Shown for a point each: {listOf(g.shown[me].map((c) => VENTURES[c].name))}</p>}
      {/* (How many each seat holds is on its player card; here, only what they've shown.) */}
      <OthersVentures s={view} me={me} seats={others.filter((p) => g.shown[p].length > 0)} shownOnly />
    </div>
  );
}

/** Each other seat's ventures as the table sees them: how many held (unless `shownOnly`), and the victory ventures shown. */
function OthersVentures({ s, me, seats, shownOnly = false }: { s: GameState; me: PlayerId; seats: PlayerId[]; shownOnly?: boolean }) {
  const g = s.ext.guilds!;
  if (!seats.length) return null;
  return (
    <ul className="vh-others" aria-label={shownOnly ? 'Ventures the other players have shown' : 'Ventures the other players hold'}>
      {seats.map((p) => (
        <li key={p}>
          <Seat s={s} p={p} me={me} short />
          <span>
            {shownOnly ? `${listOf(g.shown[p].map((c) => VENTURES[c].name))} shown` : `${g.hands[p].length} held`}
            {!shownOnly && g.shown[p].length > 0 && ` · ${listOf(g.shown[p].map((c) => VENTURES[c].name))} shown`}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------- decisions

/** The decisions the ventures leave you owing: back down to four, a deck to draw from, a spymaster's take. */
export function VentureDecision() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const watching = useWatching();
  if (!view?.ext.guilds || watching) return null;
  const top = topOf(view, 'guilds/ventureLimit', 'guilds/drawChoice', 'guilds/spy');
  if (!top || !top.players.includes(me)) return null;
  const d = top.data as GuildsPending;
  const press = (a: Action) => (busy ? explain('Wait for the last move to finish') : act(a));
  const title = decisionTitle(view, top);
  let body = '';
  let buttons: { label: string; title?: string; card?: VentureId; icon?: string; a: Action }[] = [];
  if (d.kind === 'guilds/ventureLimit') {
    const held = view.ext.guilds.hands[me].length;
    body = `You hold ${held}: put one back under its deck (${VENTURE_LIMIT} at most).`;
    buttons = legalOf<Extract<Action, { type: 'guilds/discardVenture' }>>(view, me, 'guilds/discardVenture').map((a) => ({ label: VENTURES[a.card].name, title: VENTURES[a.card].text, card: a.card, a }));
  } else if (d.kind === 'guilds/drawChoice') {
    body = 'Choose the deck to draw from.';
    const left = (t: Track) => view.ext.guilds!.decks[t].length;
    buttons = legalOf<Extract<Action, { type: 'guilds/draw' }>>(view, me, 'guilds/draw').map((a) => ({
      label: a.track ? `${TRACK_NAMES[a.track]} · ${left(a.track)} left` : 'Every deck is empty',
      icon: a.track ? TRACK_ICON[a.track] : undefined,
      a,
    }));
    // (In track order, so the three always sit in the same places.)
    buttons.sort((x, y) => TRACKS.indexOf((x.a as { track: Track }).track) - TRACKS.indexOf((y.a as { track: Track }).track));
  } else if (d.kind === 'guilds/spy') {
    body = `Take one of ${view.players[d.target].name}'s ventures, or none.`;
    buttons = legalOf<Extract<Action, { type: 'guilds/takeVenture' }>>(view, me, 'guilds/takeVenture').map((a) => ({
      label: a.card ? VENTURES[a.card].name : 'Take none',
      title: a.card ? VENTURES[a.card].text : undefined,
      card: a.card ?? undefined,
      a,
    }));
  }
  if (!buttons.length) return null;
  return (
    <div className="mp-decision parchment owed venture-decision" role="group" aria-label={`${title}: ${body}`}>
      <div className="mp-head">
        <span className="mp-title">{title}</span>
      </div>
      <p className="mp-body">{body}</p>
      <div className="mp-buttons">
        {buttons.map((b, i) => (
          <DecisionButton key={i} label={b.label} title={b.title} card={b.card} icon={b.icon} onClick={() => press(b.a)} />
        ))}
      </div>
    </div>
  );
}

/** A decision's answer as a button: a venture's (with its painting, and its card on a hover, a focus or a held finger) or a deck's (with its emblem). */
function DecisionButton({ label, title, card, icon, onClick }: { label: string; title?: string; card?: VentureId; icon?: string; onClick: () => void }) {
  const [previewProps, preview] = useCardPreview(card ? venturePreview(card) : null);
  return (
    <button type="button" className="btn small ghost" aria-label={title ? `${label}: ${title}` : undefined} onClick={onClick} {...previewProps}>
      {card && <ArtCrop className="vh-btn-art" art={venturePainting(card)} w={24} h={24} />}
      {icon && <img className="vh-btn-icon" src={asset(icon)} alt="" draggable={false} />}
      {label}
      {preview}
    </button>
  );
}
