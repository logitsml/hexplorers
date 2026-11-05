// The game's results: the standings, the dice and who earned what. Loaded on demand (see
// Modals.tsx); "View the island" closes it over the finished board, and ResultsReturn (in
// Modals.tsx) brings it back.

import { Suspense, lazy, useState } from 'react';
import { victoryBreakdown } from '../engine';
import { pointParts, signed } from '../game/points';
import { showError, useUI } from '../game/store';
import { session } from '../app/session';
import { PLAYER_PALETTE } from '../render/board/pieces';
import { Icon } from './Cards';
import { SeatMark } from './SeatMark';
import { Morph } from './Morph';
import { Modal } from './ModalFrame';
import { LineIcon } from './LineIcons';
import type { UiIconName } from '../game/names';

/** Odds of each total with two dice, out of 36. */
const WAYS = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];

/** A rated online game's rating changes (online play's own chunk, loaded only in a room). */
const RatingChanges = lazy(() => import('./online/ratings/RatingChanges'));
/** Online, the room's word on the finish (who conceded), the highlights as badges, and Share result. */
const OnlineResults = lazy(() => import('./online/Results'));
const ShareResult = lazy(() => import('./online/Results').then((m) => ({ default: m.ShareResult })));

/** Dice histogram against the expected distribution, and cards each player earned. */
function GameStatsPanel() {
  const view = useUI((s) => s.view);
  if (!view) return null;
  const st = session.stats;
  const rolled = st.rolls.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...st.rolls.slice(2), ...WAYS.map((w) => (w / 36) * rolled));
  return (
    <div className="stats-grid">
      <div>
        <div className="stats-title">Dice rolls · {rolled}</div>
        <div className="dice-hist" role="img" aria-label={`Dice totals: ${st.rolls.slice(2).map((n, i) => `${i + 2}: ${n}`).join(', ')}`}>
          {st.rolls.slice(2).map((n, i) => {
            const total = i + 2;
            const exp = (WAYS[total] / 36) * rolled;
            return (
              <div key={total} className="bar-col">
                <div className="bar-track">
                  <div className={`bar ${total === 7 ? 'seven' : ''}`} style={{ height: `${(n / max) * 100}%` }} />
                  <div className="expect" style={{ bottom: `${(exp / max) * 100}%` }} />
                </div>
                <span className="bar-n">{n}</span>
                <span className="bar-lbl">{total}</span>
              </div>
            );
          })}
        </div>
        <div className="stats-note">Line marks the expected count for this many rolls.</div>
      </div>
      <div>
        <div className="stats-title">Cards from production</div>
        <div className="prod-list">
          {view.players.map((p) => (
            <div key={p.id} className="prod-row">
              <span className="dot" style={{ background: PLAYER_PALETTE[p.color].ui }} />
              <span className="nm">{p.name}</span>
              <span className="v">{st.produced[p.id] ?? 0}</span>
              {(st.stolen[p.id] ?? 0) > 0 && <span className="stole">+{st.stolen[p.id]} stolen</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// (Online, the room's replay: with the rest of online play, loaded only then.)
const WatchOnlineReplay = lazy(() => import('./online/replay/WatchReplay'));

/**
 * The standings' columns: a painted icon each (as on the panels), its name under it where the
 * table has the width (see .standings-name in ui.css), and always in its tooltip and to a screen reader.
 */
const COLUMNS: [string, UiIconName][] = [
  ['Houses', 'settlement'],
  ['Towns', 'city'],
  ['Longest Route', 'route'],
  ['Biggest Army', 'knight'],
  ['Victory Point cards', 'devcard'],
];

export function GameOverModal() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  // Online, the room's count of each seat's points: a seat's view never shows the others' hidden cards.
  const roomPoints = useUI((s) => s.online?.points);
  const [again, setAgain] = useState(false);
  // Off to a replay or a new game: one press only, and if it fails the old game has already been
  // taken down, so back to the title saying so (as the title's own start does), not left here.
  const run = (go: () => Promise<void>) => {
    if (again) return;
    setAgain(true);
    go().catch((e) => {
      console.error('could not start the game', e);
      session.end();
      useUI.getState().set({ screen: 'title', view: null, modal: null });
      showError("That game couldn't start. Try again from the title.", 6000);
      setAgain(false);
    });
  };
  // While the dialog animates out after "Back to title" the view is already cleared.
  if (!view || view.phase !== 'gameOver') return null;
  // (Nobody wins when pollution takes the island: only the Steward is honoured.)
  const winner = view.winner ?? null;
  const steward = winner === null ? (view.ext.oil?.steward ?? null) : null;
  const rows = view.players
    .map((p) => {
      const b = victoryBreakdown(view, p.id);
      const total = roomPoints?.[p.id] ?? b.total;
      // (What the room counted beyond what this view shows is hidden Victory Point cards.)
      return { p, b: { ...b, total, victoryCards: b.victoryCards + Math.max(0, total - b.total) } };
    })
    .sort((a, b) => b.b.total - a.b.total);
  // The expansions' points (seats, foundries, wagons, awards, prisoners…) get a column of their own,
  // and the development cards' columns show only where the game has them.
  const expansions = view.options.modules.length > 0;
  const columns = COLUMNS.filter(([name]) => !expansions || (name === 'Biggest Army' ? rows.some((r) => r.b.largestArmy) : name === 'Victory Point cards' ? rows.some((r) => r.b.victoryCards > 0) : true));
  const extra = (b: ReturnType<typeof victoryBreakdown>) => b.buildingExtra + b.modules;
  const viewIsland = () => useUI.getState().set({ modal: null });
  return (
    // (Escape, or a click on the shade, does what View the island does: Back to the results brings it again.
    // Wide enough for its four ways on in one row: at 620 the first ran off the card's left edge.)
    <Modal width={720} onClose={again ? undefined : viewIsland}>
      {/* The result first and largest, under its emblem: a trophy for a win of yours, a crown for another's. */}
      <div className={`results-head${winner === null ? ' lost' : winner === me ? ' won' : ''}`}>
        <span className="results-emblem" aria-hidden>
          <LineIcon name={winner === null ? 'flag' : winner === me ? 'trophy' : 'crown'} size={28} />
        </span>
        <h3>{winner === null ? 'The island is lost.' : winner === me ? 'Victory! The island is yours.' : `${view.players[winner].name} wins!`}</h3>
      </div>
      <p className="sub">
        {winner === null ? `Pollution has taken it after ${view.turn} turns, and nobody wins.${steward !== null ? ` ${view.players[steward].name}, the Steward, is honoured.` : ''}` : `Final standings after ${view.turn} turns.`}
      </p>
      <div className="standings-wrap">
        <table className="standings">
          <thead>
            <tr>
              <th scope="col">Player</th>
              {columns.map(([name, icon]) => (
                <th key={name} scope="col" title={name} aria-label={name}>
                  <Icon name={icon} size={22} />
                  <span className="standings-name">{name}</span>
                </th>
              ))}
              {expansions && (
                <th scope="col" title="Expansions" aria-label="Expansions">
                  <Icon name="vp" size={22} />
                  <span className="standings-name">Expansions</span>
                </th>
              )}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, b }) => (
              <tr key={p.id} className={p.id === winner ? 'winner' : undefined}>
                <th scope="row">
                  <SeatMark seat={p.id} color={PLAYER_PALETTE[p.color].ui} size={11} />
                  {p.name}
                  {p.id === winner && (
                    <span className="standings-crown">
                      <LineIcon name="crown" size={14} />
                      <span className="sr-only"> (winner)</span>
                    </span>
                  )}
                </th>
                {columns.map(([name]) => (
                  <td key={name}>{name === 'Houses' ? b.settlements : name === 'Towns' ? b.cities : name === 'Longest Route' ? (b.longestRoad ? '+2' : '–') : name === 'Biggest Army' ? (b.largestArmy ? '+2' : '–') : b.victoryCards}</td>
                ))}
                {expansions && (
                  // (Where they came from, on a hover or a focus: "2 guild seats +4, Port Captain +2".)
                  <td className={extra(b) ? 'tip' : undefined} data-tip={extra(b) ? pointParts(view, p.id).map((x) => `${x.words} ${signed(x.n)}`).join(', ') : undefined} tabIndex={extra(b) ? 0 : undefined}>
                    {extra(b) ? signed(extra(b)) : '–'}
                  </td>
                )}
                <td className="total">{b.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {session.room && (
        <Suspense fallback={null}>
          <OnlineResults />
          <RatingChanges />
        </Suspense>
      )}
      <GameStatsPanel />
      {/* One gold way on (another voyage); the looks back are quiet, at the start; the way out beside the gold. */}
      <div className="footer results-actions">
        <button className="btn ghost bare" disabled={again} onClick={viewIsland}>
          <LineIcon name="eye" size={18} />
          View the island
        </button>
        {session.lastGame && !session.room && (
          <button className="btn ghost bare" disabled={again} onClick={() => run(() => session.watchReplay(session.lastGame!))}>
            <LineIcon name="hourglass" size={18} />
            Watch replay
          </button>
        )}
        <span className="footer-gap" aria-hidden />
        <button className="btn ghost" disabled={again} onClick={() => void session.quitToTitle()}>
          <LineIcon name="home" size={18} />
          Back to title
        </button>
        {/* (Online the game was the room's: the next voyage is the room's to make, for the same table, and its replay the room's to offer.) */}
        {session.room && (
          <>
            <button
              className="btn gold"
              disabled={again}
              onClick={() => {
                // (The next game not made, a network blip say: nothing has been taken down, so the results stay.)
                if (again) return;
                setAgain(true);
                session.sailAgain().catch((e) => {
                  console.error('could not sail again', e);
                  showError('The next game couldn’t be set up. Check your connection and try again.', 6000);
                  setAgain(false);
                });
              }}
            >
              <LineIcon name="ship" size={18} />
              <Morph>{again ? 'Setting sail…' : 'Sail again'}</Morph>
            </button>
            <Suspense fallback={null}>
              <WatchOnlineReplay disabled={again} />
              <ShareResult disabled={again} />
            </Suspense>
          </>
        )}
        {session.lastConfig && !session.room && (
          <button
            className="btn gold"
            disabled={again}
            onClick={() => {
              // The same players and options on a fresh island.
              run(() => session.start(session.lastConfig!));
            }}
          >
            <LineIcon name="ship" size={18} />
            <Morph>{again ? 'Setting sail…' : 'Play again'}</Morph>
          </button>
        )}
      </div>
    </Modal>
  );
}
