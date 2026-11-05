// The raider fleet at the table: how far it has sailed, its strength (every city on the island)
// against the defence (every mustered warden's rank), and what a landing would do as the island
// stands, by the attack's own reckoning (`landing`), so the page can't drift from the rules: who
// defends least and would lose a city, or who defends most and would take a defence token. Then
// each player's share of both, and the tokens they've won.

import type { PlayerId } from '../../engine';
import { useUI } from '../../game/store';
import { count, listOf, meFirst } from '../../game/modulePanels';
import { FLEET_STEPS, RANSOM, landing } from '../../engine/modules/fleet';
import { nameOf, Pips, Seat } from './shared';

export function Fleet() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const f = view?.ext.fleet;
  if (!view || !f) return null;
  const l = landing(view);
  const togo = FLEET_STEPS - f.position;
  const cities = (p: PlayerId) => view.buildings.filter((b) => b?.owner === p && b.kind === 'city').length;
  const names = (ps: PlayerId[]) => listOf(ps.map((p) => nameOf(view, p, me)));
  // (One player who isn't you takes the verb's -s: "Bram defends", "You defend", "Bram and Cora defend".)
  const verb = (ps: PlayerId[], v: string) => (ps.length === 1 && ps[0] !== me ? `${v}s` : v);
  const ransom = view.options.modules.includes('rivers') ? ` (or ${RANSOM} coins to keep it)` : '';
  const outcome = !l.won
    ? l.losers.length
      ? `Falling short by ${l.strength - l.defence}: ${names(l.losers)} ${verb(l.losers, 'defend')} least, and would lose a town${l.losers.length > 1 ? ' each' : ''}${ransom}.`
      : `Falling short by ${l.strength - l.defence}, but there’s no town it may take (a seat’s or a foundry’s is never taken).`
    : l.token !== null
      ? `Holding: ${names([l.token])} ${verb([l.token], 'defend')} most, and would take a defence token (+1 VP).`
      : l.tied.length
        ? `Holding: ${names(l.tied)} tie for the most, and would each draw a venture of their choice.`
        : 'Holding: with no towns on the island, it has nothing to take.';
  // (A ship from the island and the defence short: the line's edge says so, in the calm amber of a decision owed.)
  const near = togo === 1 && !l.won;
  return (
    <div className="fleet-page">
      <div className="fp-at">
        <span className="ot-label">At sea · {f.position} of {FLEET_STEPS}</span>
        <Pips n={f.position} max={FLEET_STEPS} label={`${f.position} of the ${FLEET_STEPS} steps to the island sailed`} />
      </div>
      <p className="mp-sub">
        {togo === 1 ? 'The next ship on the event die brings it to the island.' : `${togo} more ships on the event die bring it to the island: about ${2 * togo} rolls, with ships on half its faces.`}
      </p>
      <div className={`fp-versus${l.won ? ' holds' : ' short'}${near ? ' near' : ''}`} role="group" aria-label={`Fleet strength ${l.strength} against defence ${l.defence}`}>
        <div className="fp-side">
          <b>{l.strength}</b>
          <span>Strength</span>
          <small>{count(l.strength, 'town', 'towns')} on the island</small>
        </div>
        <span className="fp-vs" aria-hidden>
          against
        </span>
        <div className="fp-side">
          <b>{l.defence}</b>
          <span>Defence</span>
          <small>mustered wardens’ ranks</small>
        </div>
        <p className="fp-say">If it landed now: {outcome}</p>
      </div>
      <table className="ot-table fp-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Player</span>
            </th>
            <th scope="col">Towns</th>
            <th scope="col">Mustered</th>
            <th scope="col">Tokens</th>
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
              <td>{cities(p)}</td>
              <td>{l.contributions[p]}</td>
              <td>{f.tokens[p]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mp-sub">
        A defence token is a point. Mustered wardens rest after a landing, and the fleet sets out again.{' '}
        {f.attacks === 0 ? `${f.corsairStart !== null ? 'The robber and the corsair stay' : 'The robber stays'} off the board until its first landing.` : `Landings so far: ${f.attacks}.`}
      </p>
    </div>
  );
}
