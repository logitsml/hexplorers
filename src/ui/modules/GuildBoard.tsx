// The guilds' improvement board: the three tracks, where every player stands on each, who holds
// each track's seat, what the level-3 ability does, and the button that climbs a level (its cost
// shown, or why it can't be climbed now). Improvements are made only as legalActions lists them;
// one that wins a seat with a choice of cities becomes a pick on the board.

import { memo, useMemo, useState } from 'react';
import type { Action, GameState, PlayerId, Track } from '../../engine';
import { useUI } from '../../game/store';
import { CARD_ICON, TRACK_ICON, asset } from '../../game/names';
import { TRACK_NAMES } from '../../game/tableWords';
import { legalOf, meFirst } from '../../game/modulePanels';
import { ABILITY_LEVEL, MAX_LEVEL, SEAT_LEVEL, TRACKS, TRACK_COMMODITY, seatHolder } from '../../engine/modules/guilds/rules';
import { improveCost, improveError } from '../../engine/modules/guilds/improve';
import { ReasonButton } from '../Hud';
import { Morph } from '../Morph';
import { SeatMark } from '../SeatMark';
import { whyNotNow } from '../why';
import { act, endPick, nameOf, seatColor, startPick, usePicking, useWatching } from './shared';

type Improve = Extract<Action, { type: 'guilds/improve' }>;


/** What a track's level-3 ability does, in a few words (the board is narrow). */
function ability(s: GameState, t: Track): string {
  if (t === 'learning') return 'no cards from a roll? Take a resource';
  if (t === 'commerce') return 'trade commodities 2 for 1';
  // (Champions are the only thing Statecraft's ability opens, and only the wardens have them.)
  return s.options.modules.includes('garrisons') ? 'wardens may become champions' : 'champions, in a game with wardens';
}

/** Engine messages end in a full stop; the interface's reasons don't. */
const plain = (msg: string) => msg.replace(/\.$/, '');

/** Why `me` can't climb `t` now, or null if they can. */
function improveReason(s: GameState, me: PlayerId, t: Track, hoist: boolean, legal: Improve[]): string | null {
  if (legal.length) return null;
  const level = s.ext.guilds!.levels[me][t];
  if (level >= MAX_LEVEL) return `${TRACK_NAMES[t]} is complete`;
  const now = whyNotNow('main');
  if (now) return now;
  const err = improveError(s, me, { track: t, ...(hoist ? { hoist: true } : {}) });
  return err && !err.startsWith('Choose a town') ? plain(err) : 'Not possible right now';
}

function TrackRow({ s, me, t, hoist, busy, watching }: { s: GameState; me: PlayerId; t: Track; hoist: boolean; busy: boolean; watching: boolean }) {
  const g = s.ext.guilds!;
  const level = g.levels[me][t];
  const commodity = TRACK_COMMODITY[t];
  const held = s.players[me].hand[commodity];
  const holder = seatHolder(s, t);
  const forGood = g.seatsForGood.includes(t);
  const legal = useMemo(() => legalOf<Improve>(s, me, 'guilds/improve', (a) => a.track === t && !!a.hoist === hoist), [s, me, t, hoist]);
  const complete = level >= MAX_LEVEL;
  const cost = complete ? 0 : improveCost(s, me, t, hoist);
  const reason = watching ? 'You are watching this game' : busy ? 'Wait for the last move to finish' : improveReason(s, me, t, hoist, legal);
  const picking = usePicking();
  const seatLabel = `Choose a town for the ${TRACK_NAMES[t]} seat`;
  const improve = () => {
    // One way to climb: climb. A seat with a choice of cities: choose it on the board.
    if (picking === seatLabel) return endPick();
    if (legal.length === 1 || legal.every((a) => a.vertex === undefined)) return act(legal[0]);
    startPick(seatLabel, 'vertex', legal, `The ${TRACK_NAMES[t]} seat: choose a glowing town of yours`);
  };
  const players = meFirst(s, me);
  const others = players.filter((p) => p !== me);
  const summary = `${TRACK_NAMES[t]}: you are at level ${level} of ${MAX_LEVEL}${others.length ? `; ${others.map((p) => `${s.players[p].name} ${g.levels[p][t]}`).join(', ')}` : ''}. ${holder === null ? `The seat is open: the first to level ${SEAT_LEVEL} takes it.` : `${nameOf(s, holder, me)} ${holder === me ? 'hold' : 'holds'} the seat${forGood ? ' for good' : ''}.`}`;
  return (
    <li className="gb-track" role="group" aria-label={summary}>
      <div className="gb-head">
        <img className="gb-emblem" src={asset(TRACK_ICON[t])} alt="" draggable={false} />
        <span className="gb-name">{TRACK_NAMES[t]}</span>
        <span className="gb-held" title={`You hold ${held} ${commodity}, what ${TRACK_NAMES[t]} is paid in`}>
          <img className="gb-res" src={asset(CARD_ICON[commodity])} alt="" draggable={false} />
          {held} {commodity}
        </span>
        <ReasonButton
          className={`btn small gb-up${picking === seatLabel ? ' on' : ''}`}
          reason={reason}
          onClick={improve}
          aria-pressed={picking === seatLabel ? true : undefined}
          title={complete ? undefined : `Improve to level ${level + 1} for ${cost} ${commodity}`}
          aria-label={complete ? `${TRACK_NAMES[t]} complete` : `Improve ${TRACK_NAMES[t]} to level ${level + 1} for ${cost} ${commodity}`}
        >
          {complete ? (
            'Complete'
          ) : picking === seatLabel ? (
            'Cancel'
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 14l6-6 6 6" />
              </svg>
              {cost} {commodity}
            </>
          )}
        </ReasonButton>
      </div>
      <ol className="gb-steps" aria-hidden>
        {Array.from({ length: MAX_LEVEL + 1 }, (_, n) => (
          <li key={n} className={`gb-step${n > 0 && n <= level ? ' mine' : ''}${n === ABILITY_LEVEL ? ' ability' : ''}${n >= SEAT_LEVEL ? ' seat' : ''}`} style={{ ['--pc' as string]: seatColor(s, me) }}>
            {/* (The milestones carry their own marks, the same ones the notes under the track
                start with: the guild's emblem on the ability's level, a laurel on the seat's.) */}
            {n === ABILITY_LEVEL && <img className="gb-step-key" src={asset(TRACK_ICON[t])} alt="" draggable={false} />}
            {n >= SEAT_LEVEL && <Laurel className="gb-step-key" />}
            <span className="gb-step-n">{n === 0 ? '' : n}</span>
            <span className="gb-marks">
              {players
                .filter((p) => g.levels[p][t] === n)
                .map((p) => (
                  <SeatMark key={p} seat={p} color={seatColor(s, p)} size={p === me ? 12 : 10} />
                ))}
            </span>
          </li>
        ))}
      </ol>
      <p className="gb-note">
        <span className={level >= ABILITY_LEVEL ? 'gb-have' : undefined}>
          <img className="gb-key ability" src={asset(TRACK_ICON[t])} alt="" draggable={false} />
          <b>At {ABILITY_LEVEL}:</b> {ability(s, t)}
          {level >= ABILITY_LEVEL ? ' (yours)' : ''}
        </span>
        <span>
          <Laurel className="gb-key seat" />
          <b>Seat, 2 points:</b>{' '}
          {holder === null ? (
            `open, first to ${SEAT_LEVEL}`
          ) : (
            <>
              <SeatMark seat={holder} color={seatColor(s, holder)} size={9} /> {nameOf(s, holder, me)}
              {forGood ? ', for good' : `, till another is first to ${MAX_LEVEL}`}
            </>
          )}
        </span>
      </p>
    </li>
  );
}

export function GuildBoard() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const watching = useWatching();
  const [hoist, setHoist] = useState(false);
  if (!view?.ext.guilds) return null;
  const g = view.ext.guilds;
  const hasHoist = g.hands[me]?.includes('hoist');
  const die = g.eventDie;
  return (
    <div className="guild-board">
      <div className="mp-sub">
        {die ? (
          <span>
            Event die: <b>{die.face === 'ship' ? 'a ship' : TRACK_NAMES[die.face]}</b> · red {die.red}
            {die.face !== 'ship' && g.levels[me][die.face] > 0 && die.red <= g.levels[me][die.face] + 1 ? ' (a venture for you)' : ''}
          </span>
        ) : (
          <span>Each level draws ventures when its face and a low red die come up</span>
        )}
      </div>
      {hasHoist && (
        <button type="button" className={`btn small ghost gb-hoist${hoist ? ' on' : ''}`} aria-pressed={hoist} disabled={watching} onClick={() => setHoist(!hoist)}>
          <Morph>{hoist ? 'Spending a hoist: one commodity less' : 'Spend a hoist: one commodity less'}</Morph>
        </button>
      )}
      <ul className="gb-tracks">
        {TRACKS.map((t) => (
          <TrackRow key={t} s={view} me={me} t={t} hoist={hoist && !!hasHoist} busy={busy} watching={watching} />
        ))}
      </ul>
    </div>
  );
}

/** A laurel wreath, the seat's mark: on the track's last two levels and before the note on the seat. */
const LEAVES: [number, number, number][] = [
  [8.4, 19.4, -55],
  [5.6, 15.6, -28],
  [4.6, 11.2, -4],
  [5.4, 6.8, 20],
  [7.8, 3.4, 42],
];

const Laurel = memo(function Laurel({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" aria-hidden>
      <g fill="currentColor">
        {LEAVES.map(([x, y, a]) => (
          <g key={`${x}${y}`}>
            <ellipse cx={x} cy={y} rx={2} ry={3.3} transform={`rotate(${a} ${x} ${y})`} />
            <ellipse cx={24 - x} cy={y} rx={2} ry={3.3} transform={`rotate(${-a} ${24 - x} ${y})`} />
          </g>
        ))}
      </g>
      <circle cx="12" cy="21.6" r="1.6" fill="currentColor" />
    </svg>
  );
});
