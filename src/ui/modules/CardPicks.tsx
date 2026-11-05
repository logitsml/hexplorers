// Decisions answered with cards. Cards an expansion asks for out of a hand (an unrest's discard, a
// dowry's or a barter's give, a tribute's take) are chosen together in the base game's discard
// picker, a dialog that opens by itself as a discard's does, and go out one move a card (see
// game/handPicks.ts); the dock keeps a card for the decision, to open the dialog again once it's
// been put aside, and to say the cards are on their way. Resources taken from the supply (the
// Learning ability's one, a bounty field's few) are chosen in the dock: one by a press, several
// counted up and then taken.

import { useState, type ReactNode } from 'react';
import { RESOURCES, totalCards, type Action, type CardCounts, type Pending, type Resource } from '../../engine';
import { emptyCounts, useUI } from '../../game/store';
import { session } from '../../app/session';
import { CARD_NAMES } from '../../game/names';
import { decisionFor } from '../../game/moduleActions';
import { decisionText, decisionTitle } from '../../game/decisions';
import { handPick, handPickMoves, type HandPick } from '../../game/handPicks';
import { legalOf, listOf, topOf } from '../../game/modulePanels';
import { pickSize } from '../../engine/modules/sea/bounty';
import { sfx } from '../../audio/sfx';
import { useDialogView } from '../hooks';
import { suggestDiscard } from '../advice';
import { Modal, ResPicker, close } from '../ModalFrame';
import { LineIcon } from '../LineIcons';
import { ReasonButton } from '../Hud';
import { Morph } from '../Morph';
import { explain } from '../why';
import { act, PaceSwitch, setSetting, useWatching } from './shared';
import { CardButton } from './CardButton';

/** Each hand pick's verb for the cards as they go, and while they're on their way. */
const PICKS: Record<HandPick['reason'], { verb: string; going: string }> = {
  unrest: { verb: 'Discard', going: 'Discarding' },
  dowry: { verb: 'Give', going: 'Giving' },
  barter: { verb: 'Give', going: 'Giving' },
  tribute: { verb: 'Take', going: 'Taking' },
};

const cards = (n: number, commodities: boolean) => (commodities ? (n === 1 ? 'a commodity' : `${n} commodities`) : n === 1 ? 'a card' : `${n} cards`);

/** Make the moves chosen together, one landing after another: the reason for a refusal goes to the error bar. */
function actAll(moves: Action[]): boolean {
  const p = session.presenter;
  const err = p ? p.actAll(moves) : 'No game in progress';
  if (err) explain(err);
  else sfx.play('click');
  return !err;
}

/** The dialog: the cards a hand pick asks for, chosen by kind as the base game's discard chooses them. */
export function HandPickModal() {
  const view = useDialogView();
  const me = useUI((s) => s.me);
  const [sel, setSel] = useState<CardCounts>(emptyCounts());
  const [kept, setKept] = useState<string[] | null>(null);
  const pick = handPick(view, me);
  if (!pick) return null;
  const n = totalCards(sel);
  const words = PICKS[pick.reason];
  const giving = pick.reason !== 'tribute';
  const other = pick.reason === 'tribute' ? pick.from : pick.to;
  const name = other === null ? '' : view.players[other].name;
  const commodities = pick.kinds.every((k) => !(RESOURCES as readonly string[]).includes(k));
  const held = pick.kinds.reduce((t, k) => t + pick.max[k], 0);
  // (The decision's heading, with unrest's cost said in full in the dialog's.)
  const title = pick.reason === 'unrest' ? 'Unrest: discard half your cards' : decisionTitle(view, view.pending[view.pending.length - 1]);
  const sub =
    pick.reason === 'unrest' ? <>You hold {held} cards. Choose <b>{pick.need}</b> to return to the supply.</>
    : pick.reason === 'tribute' ? <>You’ve seen their hand: choose <b>{cards(pick.need, false)}</b> to take.</>
    : pick.reason === 'dowry' ? <>{name} has fewer points: choose <b>{cards(pick.need, false)}</b> of yours to give them.</>
    : <>{name} gave you a resource: choose <b>{cards(pick.need, commodities)}</b> to give them for it.</>;
  // A starting point for cards you give up (never for a tribute's, the cards you gain): what you
  // hold most of, keeping what pays for your best build.
  const suggest = () => {
    const s = suggestDiscard(view, me, pick.max, pick.need);
    setSel(s.discard);
    setKept(s.keeps);
  };
  const choose = (v: CardCounts) => {
    setSel(v);
    setKept(null);
  };
  const send = () => {
    const moves = handPickMoves(view, me, pick, sel);
    if (moves && actAll(moves)) close();
  };
  return (
    <Modal onClose={close}>
      <h3>{title}</h3>
      <p className="sub">{sub}</p>
      <ResPicker value={sel} onChange={choose} max={pick.max} limit={pick.need} label={`${n} / ${pick.need}`} kinds={pick.kinds} tone={giving ? 'give' : 'get'} have={giving ? 'have' : 'they have'} />
      {giving && (
        <p className="discard-note" aria-live="polite">
          {kept ? (kept.length ? `This keeps enough for ${kept.slice(0, 2).join(' and ')}.` : 'Nothing can be kept whole, so this gives up what you hold most of.') : ''}
        </p>
      )}
      <div className="footer">
        {giving && (
          <button className="btn ghost bare" onClick={suggest}>
            <LineIcon name="sparkle" size={18} />
            Suggest
          </button>
        )}
        <span className="footer-gap" aria-hidden />
        {/* (Put aside, not answered: the dock's card opens it again.) */}
        <button className="btn ghost" onClick={close}>
          See the board
        </button>
        <button className="btn gold" disabled={n !== pick.need} onClick={send}>
          {words.verb} {pick.need}
        </button>
      </div>
    </Modal>
  );
}

/** In the dock: the hand pick you owe, the button that opens its dialog, and the cards on their way once chosen. */
export function HandPickDecision() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const sending = useUI((s) => s.batch.length > 0);
  const watching = useWatching();
  if (!view?.ext.guilds || watching) return null;
  const pick = handPick(view, me);
  const owed = pick && decisionFor(view, me);
  if (!pick || !owed) return null;
  const words = PICKS[pick.reason];
  return (
    <div className="mp-decision parchment owed hand-pick" role="group" aria-label={`${decisionTitle(view, owed)}: ${decisionText(view, me, owed)}`}>
      <div className="mp-head">
        <span className="mp-title">{decisionTitle(view, owed)}</span>
        <span className="mp-aside">Venture</span>
      </div>
      <p className="mp-body">{decisionText(view, me, owed)}.</p>
      <div className="mp-buttons">
        <ReasonButton className="btn small gold" reason={sending ? 'Your cards are on their way' : null} onClick={() => useUI.getState().set({ modal: 'cards' })}>
          <Morph>{sending ? `${words.going}…` : 'Choose the cards'}</Morph>
        </ReasonButton>
      </div>
    </div>
  );
}

type LearningPick = Extract<Action, { type: 'guilds/pick' }>;
type BountyPick = Extract<Action, { type: 'sea/pickBounty' }>;

/** In the dock: resources you may take from the supply, the Learning ability's or a bounty field's. */
export function SupplyPick() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const watching = useWatching();
  if (!view || watching) return null;
  const top = topOf(view, 'guilds/pick', 'sea/bountyPick');
  if (!top || !top.players.includes(me)) return null;
  // (Keyed to the decision, so a pick half made for one bounty field doesn't carry into the next.)
  return <SupplyPickOf key={`${top.kind}:${view.turn}:${view.pending.length}`} top={top} />;
}

function SupplyPickOf({ top }: { top: Pending }) {
  const view = useUI((s) => s.view)!;
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const [picks, setPicks] = useState<Resource[]>([]);
  const owed = decisionFor(view, me);
  const learning = top.kind === 'guilds/pick';
  const size = learning ? 1 : pickSize(view, top);
  const wait = busy ? 'Wait for the last move to finish' : null;
  const of = (r: Resource) => picks.filter((x) => x === r).length;
  const sameAs = (rs: Resource[]) => rs.length === picks.length && RESOURCES.every((r) => rs.filter((x) => x === r).length === of(r));
  const learn = learning ? legalOf<LearningPick>(view, me, 'guilds/pick') : [];
  const bounty = learning ? [] : legalOf<BountyPick>(view, me, 'sea/pickBounty');
  const title = decisionTitle(view, top);
  // A pacing default (game/pacing.ts): with the switch on, what you take now is taken without asking
  // from then on, whenever the supply has enough of it. On while one is set (the supply was short of
  // it, so you're asked): off forgets it.
  const preferred = useUI((st) => st.settings.pickResource);
  const [remember, setRemember] = useState(false);
  const take = (a: Action, rs: Resource[]) => {
    if (busy) return explain('Wait for the last move to finish');
    // (Of a mixed pick, the kind taken most; the first of them on a tie.)
    const most = rs.reduce((best, r) => (rs.filter((x) => x === r).length > rs.filter((x) => x === best).length ? r : best), rs[0]);
    if (remember) setSetting({ pickResource: most });
    act(a);
  };
  let controls: ReactNode;
  if (size === 0 || (learning && learn.length === 1 && learn[0].resource === null)) {
    // (The supply has nothing left to give: the decision is only to carry on.)
    const a = learning ? learn[0] : bounty[0];
    controls = a && (
      <button type="button" className="btn small gold" onClick={() => (busy ? explain('Wait for the last move to finish') : act(a))}>
        The supply is empty: carry on
      </button>
    );
  } else if (size === 1) {
    controls = RESOURCES.map((r) => {
      const a = learning ? learn.find((x) => x.resource === r) : bounty.find((x) => x.resources[0] === r);
      return <CardButton key={r} card={r} reason={wait ?? (a ? null : 'The supply has none left')} onClick={() => take(a!, [r])} />;
    });
  } else {
    const done = picks.length === size ? bounty.find((a) => sameAs(a.resources)) : undefined;
    const add = (r: Resource) => setPicks([...picks, r]);
    controls = (
      <>
        {RESOURCES.map((r) => (
          <CardButton key={r} card={r} chosen={of(r)} reason={view.bank[r] <= of(r) ? (view.bank[r] ? 'The supply has no more' : 'The supply has none left') : picks.length >= size ? `You’ve chosen ${size}` : null} onClick={() => add(r)} />
        ))}
        <div className="sp-foot">
          {picks.length > 0 && (
            <button type="button" className="btn small ghost bare" onClick={() => setPicks([])}>
              <LineIcon name="undo" size={16} />
              Clear
            </button>
          )}
          <span className="footer-gap" aria-hidden />
          <ReasonButton className="btn small gold" reason={wait ?? (done ? null : `Choose ${size - picks.length} more`)} onClick={() => take(done!, done!.resources)}>
            {done ? `Take ${listOf(RESOURCES.filter((r) => of(r) > 0).map((r) => `${of(r) > 1 ? `${of(r)} ` : ''}${CARD_NAMES[r].toLowerCase()}`))}` : `Take ${size}`}
          </ReasonButton>
        </div>
      </>
    );
  }
  return (
    <div className="mp-decision parchment owed supply-pick" role="group" aria-label={`${title}: ${owed ? decisionText(view, me, owed) : ''}`}>
      <div className="mp-head">
        <span className="mp-title">{title}</span>
        <span className="mp-aside">{learning ? 'Guilds' : 'Sea Lanes'}</span>
      </div>
      {owed && <p className="mp-body">{decisionText(view, me, owed)}.</p>}
      <div className="mp-buttons">{controls}</div>
      {size > 0 &&
        (preferred ? (
          <PaceSwitch label={`Taking ${CARD_NAMES[preferred].toLowerCase()} without asking, when the supply has enough`} checked onChange={() => setSetting({ pickResource: null })} />
        ) : (
          <PaceSwitch label="Take what I choose here without asking, from now on" checked={remember} onChange={setRemember} />
        ))}
    </div>
  );
}
