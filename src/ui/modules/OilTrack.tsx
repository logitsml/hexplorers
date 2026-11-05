// Oil's disaster track: where it stands from 0 to 5 and what happens at 5, the numbers pollution
// has taken against the limit that loses the island, everyone's oil (four at most) and what they
// have sequestered, and the Steward. Sequestering is here too, as legalActions lists it; burning is
// a trade with the supply (the trade dialog's Supply tab, linked from here); a foundry (a pick of one of your cities) stays with the expansions' general panel.

import type { GameState, PlayerId } from '../../engine';
import { useUI } from '../../game/store';
import { count, legalOf, meFirst } from '../../game/modulePanels';
import { BURN_YIELD, FOUNDRIES, OIL_LIMIT, SEQUESTER_PER_POINT, STEWARD_AT, TRACK_MAX, foundriesBuilt, pollutionLimit } from '../../engine/modules/oil/rules';
import { ReasonButton } from '../Hud';
import { ToSupply } from './ToSupply';
import { whyNotNow } from '../why';
import { act, nameOf, Pips, Seat, useWatching } from './shared';

const WORDS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** "fifth", "tenth", "12th": the pollution limit is a knob, so any number can come up. */
const ordinal = (n: number) => WORDS[n] ?? `${n}th`;

/** Why `me` can't burn oil now (any resource), or null. */
function burnBlocked(s: GameState, me: PlayerId, busy: boolean): string | null {
  const st = s.ext.oil!;
  if (busy) return 'Wait for the last move to finish';
  const now = whyNotNow('main');
  if (now) return now;
  if (s.players[me].hand.oil <= 0) return 'You have no oil';
  if (st.sequesteredThisTurn) return 'You sequestered oil this turn, so none can be burned';
  if (st.track + 1 > TRACK_MAX) return `The track stands at ${TRACK_MAX}: no more oil burns this turn`;
  return null;
}

/** Why `me` can't sequester oil now, or null. */
function sequesterBlocked(s: GameState, me: PlayerId, busy: boolean, legal: boolean): string | null {
  if (legal) return busy ? 'Wait for the last move to finish' : null;
  const st = s.ext.oil!;
  const now = whyNotNow('main');
  if (now) return now;
  if (s.players[me].hand.oil <= 0) return 'You have no oil';
  if (st.sequesteredThisTurn) return 'One oil a turn may be sequestered';
  if (st.usedThisTurn) return 'You used oil this turn, so none can be sequestered';
  return 'Not right now';
}

export function OilTrack() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const watching = useWatching();
  if (!view?.ext.oil) return null;
  const st = view.ext.oil;
  const limit = pollutionLimit(view);
  const sequester = legalOf(view, me, 'oil/sequester')[0];
  const blocked = burnBlocked(view, me, busy);
  const sqReason = watching ? 'You are watching this game' : sequesterBlocked(view, me, busy, !!sequester);
  const best = Math.max(...st.sequestered);
  const atFive = st.track >= TRACK_MAX;
  return (
    <div className="oil-track">
      <div className="ot-row">
        <span className="ot-label">Disaster track</span>
        <ol className={`ot-steps${atFive ? ' full' : ''}`} role="img" aria-label={`Disaster track at ${st.track} of ${TRACK_MAX}${atFive ? ': a disaster strikes when this turn ends' : ''}`}>
          {Array.from({ length: TRACK_MAX + 1 }, (_, n) => (
            <li key={n} className={`${n === st.track ? 'at' : ''}${n < st.track ? ' past' : ''}${n === TRACK_MAX ? ' disaster' : ''}`}>
              {n}
            </li>
          ))}
        </ol>
      </div>
      <p className={`mp-sub${atFive ? ' warn' : ''}`}>
        {atFive ? 'A disaster when this turn ends: ' : `An oil burned is a step, a foundry two. At ${TRACK_MAX} a disaster ends the turn: `}a 7 floods the coasts, any other number pollutes a hex.
      </p>
      <div className="ot-row">
        <span className="ot-label">
          Numbers lost · {st.lost.length} of {limit}
        </span>
        <span className="ot-lost" role="img" aria-label={`${st.lost.length} of ${limit} numbers lost to pollution${st.lost.length ? `: ${st.lost.map((l) => l.number).join(', ')}` : ''}`}>
          {Array.from({ length: limit }, (_, i) => (
            <i key={i} className={st.lost[i] ? 'gone' : undefined}>
              {st.lost[i]?.number ?? ''}
            </i>
          ))}
        </span>
      </div>
      <p className={`mp-sub${st.lost.length === limit - 1 ? ' warn' : ''}`}>{st.lost.length === limit - 1 ? 'One more and the island is lost: nobody wins.' : `The ${ordinal(limit)} loses the island, and nobody wins.`}</p>
      <table className="ot-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Player</span>
            </th>
            <th scope="col">Oil</th>
            <th scope="col">Sequestered</th>
          </tr>
        </thead>
        <tbody>
          {meFirst(view, me).map((p) => {
            const oil = view.players[p].hand.oil;
            const sq = st.sequestered[p];
            return (
              <tr key={p}>
                <th scope="row">
                  <span className="ot-who">
                    <Seat s={view} p={p} me={me} short />
                    {st.steward === p && <span className="ot-steward" title="The Steward: the most oil sequestered, at least three (a point)">Steward</span>}
                  </span>
                </th>
                <td>
                  <Pips n={oil} max={OIL_LIMIT} label={`${oil} of ${OIL_LIMIT} oil`} />
                </td>
                <td>
                  {sq}
                  {sq >= SEQUESTER_PER_POINT && <small> · {count(Math.floor(sq / SEQUESTER_PER_POINT), 'point')}</small>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* (Burning is a trade with the supply: one oil for two of a resource, on the trade dialog's Supply tab.) */}
      <div className="ot-burn">
        <span className="ot-label">Burn 1 oil for {BURN_YIELD} of a resource</span>
        <ToSupply>Burn on the Supply tab</ToSupply>
        {blocked && <small className="ot-why">{blocked}</small>}
      </div>
      <ReasonButton className="btn small ot-seq" reason={sqReason} onClick={() => act(sequester)}>
        Sequester 1 oil · {SEQUESTER_PER_POINT} make a point
      </ReasonButton>
      <p className="mp-sub">
        {st.steward === null
          ? `The Steward (a point) goes to the first to sequester ${STEWARD_AT}; ${best > 0 ? `the most so far is ${best}` : 'none is sequestered yet'}.`
          : `${nameOf(view, st.steward, me)} ${st.steward === me ? 'are' : 'is'} the Steward: a point, and honoured if the island is lost.`}{' '}
        Foundries built: {foundriesBuilt(view)} of {FOUNDRIES}.
      </p>
    </div>
  );
}
