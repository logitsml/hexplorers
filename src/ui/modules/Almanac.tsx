// The Almanac: the card drawn for this turn's roll, its dice and its happening with a line on what
// the happening does (beside the last roll, where the dice are), the decision a happening leaves
// you owing (a resource to take, a card to give, a road to crack, someone to rob), and a cracked
// road of yours waiting to be mended. The chip by the dice is the card's one home: on the full HUD
// its decision and its lasting effect open in a drawer under it, so the painting, its name and
// its rule are never on screen twice; a phone, with no room up there, answers the decision in the
// dock and keeps the mending in the chip's note. Every answer is one legalActions lists.

import { useState } from 'react';
import { RESOURCES, type Action, type GameState, type PlayerId } from '../../engine';
import { useUI } from '../../game/store';
import { CARD_ICON, asset } from '../../game/names';
import { AUGURY_SEVEN, happeningLine, happeningName } from '../../game/tableWords';
import { legalOf, listOf } from '../../game/modulePanels';
import { cardDice } from '../../engine/modules/almanac/deck';
import { REPAIR_COST, crackedRoads, leftOf, topDecision, type AlmanacDecision as Decision } from '../../engine/modules/almanac/happenings';
import { ReasonButton } from '../Hud';
import { Morph } from '../Morph';
import { useCompact } from '../useCompact';
import { explain, shortfall, whyNotNow } from '../why';
import { act, endPick, nameOf, previewSpots, startPick, usePicking, useWatching } from './shared';
import { suggestion } from '../../game/pacing';
import { edgePlace } from '../../game/hexView';
import { CardButton } from './CardButton';
import { ArtCrop, happeningPainting, useCardPreview } from './CardPreview';
import { PIPS } from '../Dice';

/** A card's die face, drawn small. */
function CardDie({ value }: { value: number }) {
  return (
    <svg className="al-die" viewBox="0 0 24 24" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="5" />
      {(PIPS[value] ?? []).map(([c, r], i) => (
        <circle key={i} cx={6 + c * 6} cy={6 + r * 6} r={2.1} />
      ))}
    </svg>
  );
}

/** The decision a happening has left `me` owing, if any (none while watching a game). */
function useOwed(): Decision | null {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const watching = useWatching();
  if (!view?.ext.almanac || watching) return null;
  const d = topDecision(view);
  return d && d.players.includes(me) ? d : null;
}

/**
 * This turn's Almanac card beside the last roll: its dice and its happening, with what the
 * happening does; under it, in a drawer, the decision it leaves you owing and a cracked road of
 * yours (on a phone the line and the mending open from the chip, which has room only for the name).
 */
export function AlmanacChip({ compact = false }: { compact?: boolean }) {
  const st = useUI((s) => s.view?.ext.almanac);
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const watching = useWatching();
  const owed = useOwed();
  // (The drawer waits while a banner is up: a happening's own banner carries its painting large,
  // and the question opens under the chip once that moment has passed, rather than under it.)
  const bannerUp = useUI((s) => s.banners.length > 0);
  const [open, setOpen] = useState(false);
  const card = st && st.card !== null ? st.card : null;
  const art = st?.happening ? happeningPainting(st.happening) : null;
  const name = view && st?.happening ? happeningName(view, st.happening) : 'No happening';
  const line = view && st?.happening ? happeningLine(view, st.happening) : AUGURY_SEVEN;
  const [previewProps, preview] = useCardPreview(art ? { art, name, kicker: 'The Almanac', text: line } : null, { below: true });
  if (!view || !st) return null;
  const cracked = !watching && view.phase !== 'gameOver' ? crackedRoads(view, me).length : 0;
  if (card === null && !owed && !cracked) return null;
  const dice = card !== null ? cardDice(card) : null;
  const label = dice ? `Almanac card ${dice[0]} and ${dice[1]}: ${name}. ${line}` : 'The Almanac';
  if (compact) {
    return (
      <div className="al-chip compact" data-hud-obstacle="almanac">
        <button type="button" className="al-chip-btn" aria-expanded={open} aria-label={`${label}${cracked ? ` ${cracked > 1 ? `${cracked} roads` : 'A road'} of yours cracked.` : ''}`} onClick={() => setOpen(!open)}>
          {dice && <CardDie value={dice[0]} />}
          {dice && <CardDie value={dice[1]} />}
          <span className="al-name">{name}</span>
          {cracked > 0 && <CrackMark />}
        </button>
        {open && (
          <div className="al-pop parchment" role="note">
            {art && <ArtCrop className="al-pop-art" art={art} w={240} h={120} />}
            {dice && <p className="al-pop-line">{line}</p>}
            {cracked > 0 && <CrackedRoad s={view} me={me} busy={busy} />}
          </div>
        )}
      </div>
    );
  }
  const drawer = (!!owed || cracked > 0) && !bannerUp;
  return (
    <div className={`al-chip${owed ? ' owed' : ''}${drawer ? ' with-drawer' : ''}`} data-hud-obstacle="almanac">
      {dice && (
        <div className="al-face" role="img" aria-label={label} {...previewProps}>
          <span className="al-tag" aria-hidden>
            Almanac
          </span>
          <CardDie value={dice[0]} />
          <CardDie value={dice[1]} />
          {art && <ArtCrop className="al-art" art={art} w={34} h={34} />}
          <span className="al-text" aria-hidden>
            <span className="al-name">{name}</span>
            <span className="al-line">{line}</span>
          </span>
        </div>
      )}
      {drawer && (
        <div className="al-drawer parchment">
          {owed && <Ask d={owed} s={view} me={me} busy={busy} short />}
          {cracked > 0 && <CrackedRoad s={view} me={me} busy={busy} />}
        </div>
      )}
      {preview}
    </div>
  );
}

/** A small crack across the phone's chip: a road of yours waits to be mended (its note says how). */
function CrackMark() {
  return (
    <svg className="al-crack-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 9 9l5 3-4 10" />
    </svg>
  );
}

/**
 * What a happening's decision asks and its answers. `short` leaves out the happening's own line,
 * which the chip above already says.
 */
function Ask({ d, s, me, busy, short = false }: { d: Decision; s: GameState; me: PlayerId; busy: boolean; short?: boolean }) {
  const picking = usePicking();
  const [to, setTo] = useState<PlayerId | null>(null);
  const wait = busy ? 'Wait for the last move to finish' : null;
  const press = (a: Action) => (busy ? explain('Wait for the last move to finish') : act(a));
  const h = d.data.happening;
  const lead = short ? '' : `${happeningLine(s, h)} `;
  let body: string;
  let controls: React.ReactNode;
  if (d.kind === 'almanac/quake') {
    const cracks = legalOf<Extract<Action, { type: 'almanac/crack' }>>(s, me, 'almanac/crack');
    const label = 'Choose a road to crack';
    // (A pacing default: the road whose crack costs least, the bot's own choice from your seat. The
    // pick on the board still chooses any.)
    const suggested = suggestion(s, me);
    const crack = suggested?.type === 'almanac/crack' ? suggested : null;
    const show = () => crack && previewSpots('edge', [crack.edge]);
    body = `Crack one of your roads. Until it is mended (1 brick and 1 wood) you can build no roads, ships or bridges, and nobody may settle beside it.${crack ? ` Suggested: the road ${edgePlace(s, crack.edge)}, whose ends leave the fewest places to settle.` : ''}`;
    controls = (
      <>
        {crack && (
          <button type="button" className="btn small gold" onMouseEnter={show} onFocus={show} onMouseLeave={() => previewSpots(null)} onBlur={() => previewSpots(null)} onClick={() => press(crack)}>
            Crack the suggested road
          </button>
        )}
        <button type="button" className={`btn small${crack ? ' ghost' : ' gold'}${picking === label ? ' on' : ''}`} aria-pressed={picking === label} onClick={() => (picking === label ? endPick() : startPick(label, 'edge', cracks, 'The Road Splits: choose one of your roads to crack'))}>
          <Morph>{picking === label ? 'Cancel' : crack ? 'Choose another' : `Choose the road (${cracks.length})`}</Morph>
        </button>
      </>
    );
  } else if (d.kind === 'almanac/take') {
    const takes = legalOf<Extract<Action, { type: 'almanac/take' }>>(s, me, 'almanac/take');
    body = `${lead}Choose yours from the supply.`;
    controls = RESOURCES.map((r) => {
      const a = takes.find((x) => x.resource === r);
      return <CardButton key={r} card={r} reason={wait ?? (a ? null : 'The supply has none left')} onClick={() => act(a!)} />;
    });
  } else if (d.kind === 'almanac/gift') {
    const gives = legalOf<Extract<Action, { type: 'almanac/give' }>>(s, me, 'almanac/give');
    const recipients = [...new Set(gives.map((a) => a.to))];
    const who = to !== null && recipients.includes(to) ? to : recipients[0];
    const kinds = [...new Set(gives.filter((a) => a.to === who).map((a) => a.card))];
    body =
      h === 'gifts'
        ? `Pass a card to ${nameOf(s, leftOf(s, me), me)}, on your left.`
        : `You lead: give a card to ${recipients.length > 1 ? 'one of the players with fewer points' : nameOf(s, who, me)}.`;
    controls = (
      <>
        {recipients.length > 1 && (
          <div className="seg al-to" role="group" aria-label="Give to">
            {recipients.map((p) => (
              <button key={p} type="button" className={p === who ? 'on' : ''} aria-pressed={p === who} onClick={() => setTo(p)}>
                {nameOf(s, p, me)}
              </button>
            ))}
          </div>
        )}
        {kinds.map((k) => (
          <CardButton key={k} card={k} n={s.players[me].hand[k]} reason={wait} onClick={() => act(gives.find((a) => a.to === who && a.card === k)!)} />
        ))}
      </>
    );
  } else {
    const robs = legalOf<Extract<Action, { type: 'almanac/rob' }>>(s, me, 'almanac/rob');
    body = `${lead}Choose whom you rob.`;
    controls = robs.map((a, i) => (
      <button key={i} type="button" className="btn small" onClick={() => press(a)}>
        {a.oil ? `Take ${s.players[a.victim].name}'s oil` : `Rob ${s.players[a.victim].name}`}
      </button>
    ));
  }
  const others = d.players.filter((p) => p !== me);
  return (
    <div className="al-ask" role="group" aria-label={`${happeningName(s, h)}: ${happeningLine(s, h)} ${body}`}>
      <p className="mp-body">{body}</p>
      <div className="mp-buttons">{controls}</div>
      {others.length > 0 && <p className="mp-sub">Also choosing: {listOf(others.map((p) => s.players[p].name))}</p>}
    </div>
  );
}

/**
 * On a phone: the decision a happening leaves you owing, in the dock (the full HUD answers it in
 * the chip's drawer). The chip above carries the painting, so the panel is words and buttons.
 */
export function AlmanacDecision() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const compact = useCompact();
  const d = useOwed();
  if (!compact || !view || !d) return null;
  const h = d.data.happening;
  return (
    <div className="mp-decision parchment owed almanac-decision">
      <div className="mp-head">
        <span className="mp-title">{happeningName(view, h)}</span>
        <span className="mp-aside">Almanac</span>
      </div>
      <Ask d={d} s={view} me={me} busy={busy} />
    </div>
  );
}

/**
 * A road of yours a quake cracked: no routes until it's mended, and on your turn (the one time it
 * can be) the mending, a pick when there's a choice of road.
 */
function CrackedRoad({ s, me, busy }: { s: GameState; me: PlayerId; busy: boolean }) {
  const picking = usePicking();
  const cracked = crackedRoads(s, me);
  if (!cracked.length) return null;
  const mine = s.currentPlayer === me;
  const repairs = legalOf<Extract<Action, { type: 'almanac/repair' }>>(s, me, 'almanac/repair');
  const label = 'Mend a cracked road';
  const lack = shortfall(s.players[me].hand, REPAIR_COST);
  const reason = repairs.length ? (busy ? 'Wait for the last move to finish' : null) : (whyNotNow('main') ?? (lack ? `You need ${lack} more` : 'Not right now'));
  const mend = () => {
    if (picking === label) return endPick();
    if (repairs.length === 1) return act(repairs[0]);
    startPick(label, 'edge', repairs, 'Choose a cracked road to mend');
  };
  return (
    <div className="al-crack" role="group" aria-label={cracked.length > 1 ? `${cracked.length} cracked roads` : 'A cracked road'}>
      <p className="al-crack-text" title={`No roads, ships or bridges for you until ${cracked.length > 1 ? 'they are' : 'it is'} mended`}>
        <CrackMark />
        <span>
          <b>{cracked.length > 1 ? `${cracked.length} cracked roads` : 'A cracked road'}</b>: no new routes till mended
        </span>
      </p>
      {mine && (
        <ReasonButton className={`btn small ghost al-mend${picking === label ? ' on' : ''}`} reason={reason} aria-pressed={picking === label ? true : undefined} aria-label={picking === label ? 'Cancel the mending' : 'Mend it for 1 brick and 1 wood'} onClick={mend}>
          {picking === label ? (
            'Cancel'
          ) : (
            <>
              Mend
              <img src={asset(CARD_ICON.brick)} alt="" draggable={false} />
              <img src={asset(CARD_ICON.wood)} alt="" draggable={false} />
            </>
          )}
        </ReasonButton>
      )}
    </div>
  );
}
