// The expansions' moves and decisions, offered generically where a module has no controls of its
// own: a panel of the moves open to you (a pick on the board for those made at a spot, a list for
// the rest), the decision an expansion has left you owing, and what you hold that the expansions
// count (coins, fish and the Soggy Boot, prisoners, defence tokens), each as its painted token. It
// reads only what legalActions offers (see game/moduleActions.ts), so a module's moves can be
// played as soon as they are legal, and the presenter keeps a pick's spots current as the game
// moves. The moves and decisions a module's own panel answers (ui/modules/, listed in
// game/modulePanels.ts) are left to that panel; a list of choices a pick on the board opened shows
// here whoever opened it.

import { useMemo } from 'react';
import type { GameState, PlayerId } from '../engine';
import type { CardPending } from '../engine/modules/invasion/types';
import { MUSTER_ART, TOKEN_ICON, TRACK_ICON, UI_ICON, CARD_ICON, asset } from '../game/names';
import { decisionText, decisionTitle } from '../game/decisions';
import { count } from '../game/modulePanels';
import { useUI } from '../game/store';
import { session } from '../app/session';
import { decisionFor, describe, groupActions, moveCost, spotOf, wardenName, type ActionGroup } from '../game/moduleActions';
import { answersDecision, coveredTypes, legalModuleActions } from '../game/modulePanels';
import { explain } from './why';
import { useCompact } from './useCompact';
import { act, endPick, previewSpots, startStagedPick } from './modules/shared';
import { suggestion } from '../game/pacing';
import { edgePlace } from '../game/hexView';
import { Morph } from './Morph';
import { LineIcon } from './LineIcons';

/** A group pressed: its pick on the board (pressed again, put away), its one move, or its list of moves. */
function choose(g: ActionGroup) {
  const store = useUI.getState();
  const it = store.interaction;
  if (g.staged) {
    if (it.kind === 'pick' && it.actions[0]?.type === g.key) return endPick();
    return startStagedPick(g.label, g.actions);
  }
  if (g.target) {
    if (it.kind === 'pick' && it.actions[0]?.type === g.key) {
      store.set({ interaction: { kind: 'idle' }, choice: null });
    } else {
      const spots = [...new Set(g.actions.map((a) => spotOf(a, g.target!, store.view!, g.source)))];
      store.set({ interaction: { kind: 'pick', target: g.target, spots, label: g.label, actions: g.actions, source: g.source }, choice: null, hint: `${g.label}: choose ${g.source ? 'the piece to move' : 'a spot'} on the board` });
    }
    session.presenter?.syncMarkers();
    return;
  }
  if (g.actions.length === 1) act(g.actions[0]);
  else store.set({ choice: { title: g.label, actions: g.actions } });
}

interface Holding {
  /** The painted token. */
  icon: string;
  n: number | null;
  label: string;
}

/** What you hold that the expansions count, each as its token and a number (named for screen readers and on hover). */
function holdingsOf(s: GameState, me: PlayerId): Holding[] {
  // (Coins, fish and prisoners are in the hand now, with the cards: here go the tiles and marks.)
  const out: Holding[] = [];
  const rivers = s.ext.rivers;
  if (rivers?.richest === me) out.push({ icon: TOKEN_ICON.richest, n: null, label: 'The Richest tile: the most coins (+1 VP)' });
  if (rivers?.paupers.includes(me)) out.push({ icon: TOKEN_ICON.pauper, n: null, label: 'A Pauper tile: the fewest coins (−2 VP)' });
  if (s.ext.fisheries?.boot === me) out.push({ icon: TOKEN_ICON.boot, n: null, label: 'The Soggy Boot: you need a point more to win' });
  const defence = s.ext.fleet?.tokens[me] ?? 0;
  if (defence > 0) out.push({ icon: TOKEN_ICON.defence, n: defence, label: `${count(defence, 'defence token')} (a point each)` });
  return out;
}

export function ModuleControls() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const replay = useUI((s) => s.replay !== null);
  const interaction = useUI((s) => s.interaction);
  const choice = useUI((s) => s.choice);
  const compact = useCompact();
  const actions = useMemo(() => {
    if (!view || !view.options.modules.length) return [];
    const covered = coveredTypes(view);
    return legalModuleActions(view, me).filter((a) => !covered.has(a.type));
  }, [view, me]);
  const groups = useMemo(() => groupActions(actions, view ?? undefined), [actions, view]);
  if (!view || !view.options.modules.length || replay || session.presenter?.spectating) return null;
  const decision = decisionFor(view, me);
  const owed = decision && !answersDecision(view, decision) ? decision : null;
  // On the desktop every seat's holdings sit on its player panel (modules/standings.tsx); the
  // phone's player chips have no room for them, so there they stay at the head of this panel.
  const holdings = compact ? holdingsOf(view, me) : [];
  // (A muster card bought is answered here: its painting heads the decision.)
  const cardArt = owed?.kind === 'invasion/card' ? MUSTER_ART[(owed.data as CardPending).card] : null;
  const picking = interaction.kind === 'pick' ? interaction.actions[0]?.type : null;
  if (!owed && !groups.length && !holdings.length && !choice) return null;
  return (
    <div className={`module-controls parchment${owed ? ' owed' : ''}`} role="group" aria-label={owed ? 'Your decision' : 'Expansion moves'}>
      <div className="module-head">
        {cardArt && <img className="module-card-art" src={asset(cardArt)} alt="" draggable={false} />}
        <span className="module-title">
          <Morph>{owed ? decisionTitle(view, owed) : 'Expansions'}</Morph>
        </span>
        {holdings.length > 0 && (
          <span className="module-coins">
            {holdings.map((h) => (
              <span key={h.icon} className="module-hold" role="img" aria-label={h.label} title={h.label}>
                <img src={asset(h.icon)} alt="" draggable={false} />
                {h.n !== null && h.n}
              </span>
            ))}
          </span>
        )}
      </div>
      {owed && <p className="module-asks">{decisionText(view, me, owed)}</p>}
      {owed && <Suggested />}
      {groups.length > 0 && (
        <div className="module-moves">
          {groups.map((g) => (
            <button key={g.key} type="button" className={`module-move${picking === g.key ? ' on' : ''}`} aria-pressed={g.target ? picking === g.key : undefined} aria-disabled={busy || undefined} onClick={() => (busy ? explain('Wait for the last move to finish') : choose(g))}>
              <img src={asset(moveIcon(g.key))} alt="" draggable={false} />
              <span className="module-move-text">{g.label}{moveCost(g.key, view, g.actions) && <small> · {moveCost(g.key, view, g.actions)}</small>}</span>
              <span className="module-count" role="img" aria-label={`${g.actions.length} ${g.actions.length === 1 ? 'option' : 'options'}`}>{g.actions.length}</span>
            </button>
          ))}
        </div>
      )}
      {choice && <ModuleChoices />}
    </div>
  );
}

/**
 * A suggested answer to the decision owed, a press away (game/pacing.ts): a castle exit for a
 * warden that has to leave the castle, shown on the board while pointed at; the moves below still
 * choose otherwise.
 */
function Suggested() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const a = useMemo(() => (view ? suggestion(view, me) : null), [view, me]);
  if (!view || a?.type !== 'invasion/march') return null;
  const show = () => previewSpots('edge', [a.edge]);
  return (
    <div className="module-suggest">
      <button type="button" className="btn small gold" aria-describedby="module-suggest-what" onMouseEnter={show} onFocus={show} onMouseLeave={() => previewSpots(null)} onBlur={() => previewSpots(null)} onClick={() => (busy ? explain('Wait for the last move to finish') : act(a))}>
        Take the suggested exit
      </button>
      <span id="module-suggest-what" className="module-suggest-what">
        {`${wardenName(view, a.warden, me)} to the edge ${edgePlace(view, a.edge)}`.replace(/^./, (c) => c.toUpperCase())}
      </span>
    </div>
  );
}

/** The same list lives in the desktop panel and the phone's visible pick strip. */
export function ModuleChoices() {
  const view = useUI((s) => s.view);
  const choice = useUI((s) => s.choice);
  const interaction = useUI((s) => s.interaction);
  const busy = useUI((s) => s.busy);
  if (!view || !choice) return null;
  return (
    <div className="module-choice" role="group" aria-label={choice.title}>
      <span className="module-choice-title">{choice.title}: choose one</span>
      {choice.actions.map((a, i) => (
        <button key={i} type="button" className="module-option" aria-disabled={busy || undefined} onClick={() => busy ? explain('Wait for the last move to finish') : act(a)}>
          {describe(view, a, interaction.kind === 'pick' && !interaction.source ? interaction.target : null)}
        </button>
      ))}
      <button type="button" className="module-option module-cancel" onClick={() => useUI.getState().set({ choice: null })}>
        <LineIcon name="back" size={16} />
        Back
      </button>
    </div>
  );
}

/** Each tile borrows its module's painted emblem rather than adding another visual language. */
function moveIcon(type: string): string {
  const icons: Record<string, string> = {
    sea: UI_ICON.harbour, garrisons: TOKEN_ICON.warden, invasion: TOKEN_ICON.warden,
    fleet: TOKEN_ICON.defence, rivers: TOKEN_ICON.coin, fisheries: TOKEN_ICON.fish,
    guilds: TRACK_ICON.learning, oil: CARD_ICON.oil, almanac: UI_ICON.dice,
    caravans: UI_ICON.trade,
  };
  return icons[type.split('/')[0]] ?? TOKEN_ICON.coin;
}
