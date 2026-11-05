// What an online table adds to each player's panel: the clock of the seat whose turn it is (and
// of anyone owing an answer out of turn), by the room's time; what each person says they're
// looking for and would spare (yours to set on your own panel); and, once the table has waited on
// someone a while, a way to hail them. Calm throughout: a low clock is a quiet change of its
// figures, not an alarm; nothing pulses.

import { useEffect, useRef, useState } from 'react';
import { session } from '../../app/session';
import { sfx } from '../../audio/sfx';
import { cardKinds, type Card, type PlayerId } from '../../engine';
import { CARD_ICON, CARD_NAMES, asset } from '../../game/names';
import { useUI } from '../../game/store';
import { localTime, useOnline } from '../../online/store';
import { canHail, owedKey, owedSince, sameWants, toggleWant, wantsText, type Wants } from '../../online/table';
import { turnTone } from '../../app/chromeTint';
import type { PlayerColor } from '../../engine';
import { LineIcon } from '../LineIcons';

/** Seconds as the clock shows them: 1:05, 0:09. */
export const clockText = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** This device's time, every half second while `on` (for the clocks and the hail). */
export function useNow(on: boolean, every = 500) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [on, every]);
  return now;
}

/** When this seat's clock runs out (the room's time on this device's clock), and whether it's for an answer; null: no clock. */
function useClockOf(player: PlayerId): { endsAt: number; answer: boolean; paused: boolean } | null {
  const timers = useOnline((s) => s.timers);
  const skew = useOnline((s) => s.skew);
  // (The room's clocks run ahead of what is shown while a run of moves is presented: a seat's
  // clock shows once the game shown here has come to what it owes.)
  const owes = useUI((s) => !!s.view && owedKey(s.view, player) !== null);
  if (!timers || !owes) return null;
  const owed = timers.owed?.find((o) => o.seat === player);
  if (owed) return { endsAt: localTime(owed.endsAt, skew), answer: true, paused: !!timers.paused };
  if (timers.seat === player && timers.endsAt !== undefined) return { endsAt: localTime(timers.endsAt, skew), answer: false, paused: !!timers.paused };
  return null;
}

/** The seat's clock: whose turn it is, or an answer owed, and how long is left. Quiet until the last ten seconds, and quiet then. */
export function SeatClock({ player, chip = false }: { player: PlayerId; chip?: boolean }) {
  const clock = useClockOf(player);
  const now = useNow(!!clock && !clock.paused);
  const name = useUI((s) => s.view?.players[player]?.name ?? '');
  const mine = useOnline((s) => !s.watch && s.you?.seat === player);
  if (!clock) return null;
  const left = Math.max(0, Math.ceil((clock.endsAt - now) / 1000));
  const what = clock.answer ? (mine ? 'Your answer' : `${name}'s answer`) : mine ? 'Your turn' : `${name}'s turn`;
  return (
    <span className={`${chip ? 'pchip-clock' : 'seat-clock'}${left <= 10 ? ' low' : ''}${clock.paused ? ' paused' : ''}${clock.answer ? ' answer' : ''}`} role="timer" aria-label={`${what}: ${clock.paused ? 'paused' : `${left} seconds left`}`}>
      {!chip && <span className="clock-dot" aria-hidden />}
      <b aria-hidden>{clock.paused ? '–:––' : clockText(left)}</b>
    </span>
  );
}

/** A phone's chip: the seat's clock where it has one, else what it shows anyway (the thinking dots). */
export function ChipClock({ player, children }: { player: PlayerId; children?: React.ReactNode }) {
  const has = useClockOf(player) !== null;
  return has ? <SeatClock player={player} chip /> : <>{children}</>;
}

/** Card icons in a row, each named. */
function Cards({ cards }: { cards: Card[] }) {
  return (
    <>
      {cards.map((c) => (
        <img key={c} className="want-card" src={asset(CARD_ICON[c])} alt={CARD_NAMES[c]} title={CARD_NAMES[c]} width={16} height={16} draggable={false} />
      ))}
    </>
  );
}

/** What a seat says it's looking for and would spare, as small card icons (named for screen readers). */
function WantTags({ wants }: { wants: Wants }) {
  return (
    <span className="want-tags" role="note" aria-label={wantsText(wants)}>
      {wants.looking.length > 0 && (
        <span className="want-tag looking" aria-hidden>
          Wants <Cards cards={wants.looking} />
        </span>
      )}
      {wants.spare.length > 0 && (
        <span className="want-tag spare" aria-hidden>
          Spare <Cards cards={wants.spare} />
        </span>
      )}
    </span>
  );
}

/** Your own Looking for / Spare: a toggle for each card on each list, sent as it changes. */
function WantsEditor({ wants, onDone }: { wants: Wants | undefined; onDone: () => void }) {
  const kinds = useUI((s) => (s.view ? cardKinds(s.view) : []));
  // (What you chose shows at once; the room's word follows.)
  const [mine, setMine] = useState<Wants | undefined>(wants);
  useEffect(() => setMine(wants), [wants?.looking.join(), wants?.spare.join()]);
  const tap = (card: Card, list: keyof Wants) => {
    sfx.play('click');
    const next = toggleWant(mine, card, list);
    setMine(next);
    if (!sameWants(next, wants)) session.room?.wants(next.looking, next.spare);
  };
  const row = (list: keyof Wants, label: string) => (
    <div className={`wants-row ${list}`} role="group" aria-label={label}>
      <span className="wants-label" aria-hidden>
        {label}
      </span>
      {kinds.map((c) => {
        const on = !!mine?.[list].includes(c);
        return (
          <button key={c} type="button" className={`want-pick${on ? ' on' : ''}`} aria-pressed={on} aria-label={`${label}: ${CARD_NAMES[c]}`} onClick={() => tap(c, list)}>
            <img src={asset(CARD_ICON[c])} alt="" width={22} height={22} draggable={false} />
          </button>
        );
      })}
    </div>
  );
  // (Opened, the first card takes the focus; closed, the button that opened it has it back.)
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.querySelector<HTMLButtonElement>('.want-pick')?.focus({ preventScroll: true }), []);
  return (
    <div className="wants-editor" role="group" aria-label="What you’d trade" ref={box}>
      {row('looking', 'Looking for')}
      {row('spare', 'Spare')}
      <p className="wants-note">Everyone sees it on your panel until your turn ends. It never shows your hand.</p>
      <div className="wants-foot">
        {(mine?.looking.length || mine?.spare.length) ? (
          <button type="button" className="btn ghost small" onClick={() => (setMine(undefined), session.room?.wants([], []))}>
            Clear
          </button>
        ) : null}
        <button type="button" className="btn small" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Whether `me` may hail `player` now (ticking each second while the game waits on them). */
export function useHail(player: PlayerId): boolean {
  const view = useUI((s) => s.view);
  const seats = useOnline((s) => s.room?.seats);
  const me = useOnline((s) => (s.watch ? null : (s.you?.seat ?? null)));
  const last = useOnline((s) => s.hailedAt);
  const since = view ? owedSince(view, player) : null;
  const now = useNow(since !== null && me !== null && me !== player, 1000);
  if (!view || !seats) return false;
  return canHail({ state: view, seat: player, me, seats, since, now, lastHail: last ?? undefined });
}

/** Hail a seat the table waits on: they hear a soft bell and who hailed them, nobody else does. */
export function HailButton({ player, named = false }: { player: PlayerId; named?: boolean }) {
  const can = useHail(player);
  const name = useUI((s) => s.view?.players[player]?.name ?? '');
  if (!can) return null;
  return (
    <button type="button" className="btn ghost small hail-btn" aria-label={`Hail ${name}: let them know the table is waiting`} onClick={() => (sfx.play('click'), session.room?.nudge(player))}>
      <LineIcon name="bell" size={15} />
      {named ? `Hail ${name}` : 'Hail'}
    </button>
  );
}

/**
 * Under a player's panel's stats, online: their clock, what they've said they'd trade (yours with
 * the way to say it), and the hail once they've kept the table waiting. `anchor` false: the copy
 * a phone's chip opens, where the hail and the editor live too.
 */
export default function SeatExtras({ player }: { player: PlayerId; anchor?: boolean }) {
  const seat = useOnline((s) => s.room?.seats.find((x) => x.seat === player));
  const mine = useOnline((s) => !s.watch && s.you?.seat === player);
  // (Not in the opening's placements, when there's nothing to trade yet.)
  const playing = useUI((s) => !!s.view && s.view.phase !== 'gameOver' && s.view.phase !== 'setupSettlement' && s.view.phase !== 'setupRoad');
  const color = useUI((s) => s.view?.players[player]?.color);
  const [editing, setEditing] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !editing) opener.current?.focus({ preventScroll: true });
    was.current = editing;
  }, [editing]);
  if (!seat) return null;
  const wants = seat.wants;
  const canSay = mine && playing && seat.kind === 'human' && !seat.conceded;
  const has = !!wants && (wants.looking.length > 0 || wants.spare.length > 0);
  return (
    <div className="seat-extras" style={color ? { ['--dusk' as string]: `#${turnTone(color as PlayerColor).getHexString()}` } : undefined}>
      <SeatClock player={player} />
      {has && !editing && <WantTags wants={wants!} />}
      {canSay && !editing && (
        <button ref={opener} type="button" className="chip-btn wants-btn" onClick={() => (sfx.play('click'), setEditing(true))}>
          {has ? 'Change' : 'Looking for / Spare'}
        </button>
      )}
      {!mine && <HailButton player={player} />}
      {editing && canSay && <WantsEditor wants={wants} onDone={() => setEditing(false)} />}
    </div>
  );
}
