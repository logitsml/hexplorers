// Invasion at the table: the coast's page in the ledger and the muster card owed in the dock. The
// page reads the coast as the engine will play it: each raided hex, how near it is to falling (by
// the landing selector itself, `landingHex`), and whether the wardens on its edges would free it in
// the battles at this turn's end (`defenceOn`, the battles' own sum, as the wardens stand now);
// then the raiders still to come, what lands them, and everyone's prisoners against their points.
// A muster card's answer is a pick on the board: an edge for a levy or an outrider, a hex for an
// ambush, and for a turncoat a staged pick (the hexes the raiders leave, then those they go to)
// in place of the hundreds of pairings the engine lists.

import type { Action, GameState } from '../../engine';
import { useUI } from '../../game/store';
import { MUSTER_ART, asset } from '../../game/names';
import { hexPlace, seenHex } from '../../game/hexView';
import { count, listOf, legalOf, meFirst, topOf } from '../../game/modulePanels';
import { stagedStep, stagesOf } from '../../game/moduleActions';
import { TURNCOAT_COINS } from '../../engine/modules/invasion/muster';
import { RAIDERS, improvementLandings, landingHex, landingsPerBuilding, musterDeckInPlay, prisonerPoints, prisonersPerPoint, raidersOnBoard, unlimitedRaiders, withGuilds } from '../../engine/modules/invasion/raids';
import { topology } from '../../engine/modules/invasion/topology';
import type { CardPending, MusterCard } from '../../engine/modules/invasion/types';
import { defenceOn } from '../../engine/modules/invasion/wardens';
import { Morph } from '../Morph';
import { decisionTitle } from '../../game/decisions';
import { explain } from '../why';
import { endPick, Pips, previewSpots, Seat, startPick, startStagedPick, usePicking, useWatching } from './shared';

/** Raiders that conquer a hex. */
const CONQUER = 3;

/** A raided hex's state in a few words: how near it is to falling, and what its wardens would do now. */
function hexState(s: GameState, hex: number, raiders: number): string {
  const defence = defenceOn(s, hex);
  // (Battles free a hex when the wardens' strength beats its raiders.)
  if (defence > raiders) return `${raiders >= CONQUER ? 'Conquered: freed' : 'Driven off'} at this turn’s end, wardens ${defence} against ${raiders}`;
  const wardens = defence > 0 ? `wardens ${defence} of the ${raiders + 1} needed` : `no warden beside it (${raiders + 1} strength needed)`;
  if (raiders >= CONQUER) return `Conquered: ${wardens}`;
  if (raiders === CONQUER - 1) {
    // (A landing goes to the coastal hex with that number holding fewest raiders: it may not be this one.)
    const next = seenHex(s, hex).numbers.filter((n) => landingHex(s, n) === hex);
    return `${next.length ? `One more landing on ${listOf(next.map(String))} conquers it` : 'One more raider conquers it'}; ${wardens}`;
  }
  return wardens[0].toUpperCase() + wardens.slice(1);
}

/** What lands raiders, and how many are still to come. */
function landingsLine(s: GameState): string {
  const k = landingsPerBuilding(s);
  const also = withGuilds(s) ? `, as do the event die’s ship${improvementLandings(s) ? ' and each guild improvement' : ''}` : '';
  return `Each new house or town lands ${k === 1 ? 'a raider' : `${k} raiders on different numbers`}${also}. ${CONQUER} on a hex conquer it.`;
}

export function Coast() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  if (!view?.ext.invasion) return null;
  const i = view.ext.invasion;
  const ashore = raidersOnBoard(view);
  // Worst first: conquered, then a raider from falling; along the coast from the castle within each.
  const raided = topology(view.board)
    .coast.filter((h) => i.raiders[h] > 0)
    .sort((a, b) => i.raiders[b] - i.raiders[a]);
  const perPoint = prisonersPerPoint(view);
  return (
    <div className="coast-page">
      <span className="ot-label">On the coast · {count(ashore, 'raider')}</span>
      {raided.length ? (
        <ul className="cp-hexes" aria-label="Coastal hexes with raiders">
          {raided.map((h) => {
            const n = i.raiders[h];
            const { label, numbers } = seenHex(view, h);
            return (
              <li key={h} className={`cp-hex${n >= CONQUER ? ' fallen' : n === CONQUER - 1 ? ' near' : ''}`} onMouseEnter={() => previewSpots('hex', [h])} onMouseLeave={() => previewSpots(null)}>
                <span className="cp-where">
                  {numbers.length > 0 && <b className="cp-disc">{numbers.join('/')}</b>}
                  {label}
                </span>
                <Pips n={Math.min(n, CONQUER)} max={CONQUER} label={`${count(n, 'raider')} of the ${CONQUER} that conquer it`} />
                <span className="cp-say">{hexState(view, h, n)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mp-empty">No raiders ashore.</p>
      )}
      <p className="mp-sub">{landingsLine(view)}</p>
      <p className="mp-sub">
        {unlimitedRaiders(view)
          ? `Raiders never run out: when none are left to land, the player with the most prisoners trades ${perPoint} back for a point.`
          : i.supply > 0
            ? `${i.supply} of ${RAIDERS} raiders still to come; once they’re all ashore, no more land.`
            : `All ${RAIDERS} raiders have come ashore: no more land.`}
      </p>
      <table className="ot-table cp-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Player</span>
            </th>
            <th scope="col">Prisoners</th>
            <th scope="col">Points</th>
          </tr>
        </thead>
        <tbody>
          {meFirst(view, me).map((p) => (
            <tr key={p}>
              <th scope="row">
                <span className="ot-who">
                  <Seat s={view} p={p} me={me} short />
                </span>
              </th>
              <td>{i.prisoners[p]}</td>
              <td>{prisonerPoints(view, p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mp-sub">
        Every {perPoint} prisoners {perPoint === 1 ? 'is' : 'are'} a point.
        {musterDeckInPlay(view) && ` Muster deck: ${count(i.deck.length, 'card')} to draw, ${i.discard.length} played (shuffled back when it runs out).`}
      </p>
    </div>
  );
}

/** Each card's name, what it does, and what its pick asks for. */
const CARDS: Record<MusterCard, { name: string; text: string; ask: string }> = {
  levy: { name: 'Levy', text: 'A new warden on an empty edge of the castle.', ask: 'Choose the castle edge' },
  outrider: { name: 'Outrider', text: 'A new warden on any empty edge of the home island.', ask: 'Choose the edge' },
  ambush: { name: 'Ambush', text: 'Take one raider prisoner from a coastal hex.', ask: 'Choose the hex' },
  turncoat: { name: 'Turncoat', text: `${TURNCOAT_COINS} coins, and two raiders led along the coast to hexes with room.`, ask: 'Choose the raiders' },
};

/** A turncoat's pick so far, in words: where the raiders come from (the supply too), and where they go. */
function turncoatSoFar(s: GameState, answers: Action[], chosen: number[][] | undefined): string | null {
  const first = answers[0];
  if (!first || first.type !== 'invasion/turncoat') return null;
  const n = first.moves.length;
  const fromSupply = n - stagesOf(first)!.stages[0].length;
  const places = (hexes: number[]) => hexes.map((h) => hexPlace(s, h));
  const from = [...places(chosen?.[0] ?? []), ...(fromSupply ? [fromSupply === 1 ? 'the supply' : `the supply (${fromSupply})`] : [])];
  const to = places(chosen?.[1] ?? []);
  // (Before anything is chosen, only what the board forces is worth saying.)
  const forced = n < 2 ? `Only ${count(n, 'raider')} can move.` : fromSupply ? `${fromSupply === n ? 'Both come' : 'One comes'} from the supply: too few hexes hold raiders.` : null;
  if (!chosen || !from.length) return forced;
  return `From ${listOf(from)}${chosen.length > 1 ? `; to ${listOf(to) || '…'}` : ''}`;
}

/** The muster card you've just drawn: its painting, what it does, and the pick on the board that plays it. In the dock. */
export function MusterDecision() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const it = useUI((s) => s.interaction);
  const picking = usePicking();
  const watching = useWatching();
  if (!view?.ext.invasion || watching) return null;
  const top = topOf(view, 'invasion/card');
  if (!top || !top.players.includes(me)) return null;
  const card = (top.data as CardPending).card;
  const def = CARDS[card];
  const answers = legalOf(view, me, `invasion/${card}`);
  const on = picking === def.name;
  const chosen = on && it.kind === 'pick' ? it.chosen : undefined;
  const choose = () => {
    if (busy) return explain('Wait for the last move to finish');
    if (on) return endPick();
    if (card === 'turncoat') return startStagedPick(def.name, answers);
    const target = card === 'ambush' ? 'hex' : 'edge';
    startPick(def.name, target, answers, `${def.name}: ${def.ask.toLowerCase()} on the board`);
  };
  const soFar = card === 'turncoat' ? turncoatSoFar(view, answers, chosen) : null;
  // (Start again only once you've chosen something: a stage that left no choice filled itself in.)
  const restart = !!chosen && chosen.flat().length > (stagedStep(answers, [[]])?.chosen.flat().length ?? 0);
  return (
    <div className="mp-decision parchment owed muster-decision" role="group" aria-label={`Your muster card, ${decisionTitle(view, top)}: ${def.text}`}>
      <div className="mp-head">
        <span className="mp-title">{decisionTitle(view, top)}</span>
        <span className="mp-aside">Muster card</span>
      </div>
      <div className="md-card">
        <img className="md-art" src={asset(MUSTER_ART[card])} alt="" draggable={false} />
        <p className="mp-body">{def.text}</p>
      </div>
      {soFar && <p className="mp-sub">{soFar}</p>}
      <div className="mp-buttons">
        <button type="button" className={`btn small gold${on ? ' on' : ''}`} aria-pressed={on} onClick={choose}>
          <Morph>{on ? 'Cancel' : card === 'turncoat' ? `${def.ask} on the board` : `${def.ask} (${answers.length})`}</Morph>
        </button>
        {on && restart && (
          <button type="button" className="btn small ghost" onClick={() => startStagedPick(def.name, answers)}>
            Start again
          </button>
        )}
      </div>
    </div>
  );
}
