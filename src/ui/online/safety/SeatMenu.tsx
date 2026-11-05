// The small menu on another person's seat: their profile (an account's), asking them to be
// friends, blocking them, and reporting them. In the harbour it is a "⋯" button on their seat;
// at the table, their face on their panel. A block made here takes hold in this room at once
// (the client comes aboard again, and the room reads your blocks as it does).

import { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import type { PlayerId } from '../../../engine';
import type { SeatInfo } from '../../../net/protocol';
import { ApiError } from '../../../online/api';
import { askFriend, block, blockList, myId, signedIn, unblock } from '../../../online/account';
import { useOnline } from '../../../online/store';
import { LineIcon } from '../../LineIcons';
import { Morph } from '../../Morph';
import { Face, Sheet, press } from '../account/bits';
import { ProfileSheet } from '../account/ProfileSheet';
import { ReportForm } from './Report';

/** The harbour's: a "⋯" button on a person's seat. */
export default function SeatMenu({ seat }: { seat: SeatInfo }) {
  const [open, setOpen] = useState(false);
  if (seat.kind !== 'human' || !seat.user || seat.user === myId()) return null;
  return (
    <>
      <button className="seat-menu-btn tip" data-tip="Profile, block or report" aria-label={`${seat.name}: profile, block or report`} onClick={() => (press(), setOpen(true))}>
        <LineIcon name="more" size={18} />
      </button>
      <AnimatePresence>{open && <SeatSheet key="seat" seat={seat} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

/** The table's: another person's face on their panel opens the same menu. */
export function PanelSeatMenu({ player }: { player: PlayerId }) {
  const seat = useOnline((s) => s.room?.seats.find((x) => x.seat === player));
  const [open, setOpen] = useState(false);
  if (!seat || seat.kind !== 'human' || !seat.user || seat.user === myId()) return null;
  return (
    <>
      <button className="seat-menu-hit tip" data-tip="Profile, block or report" aria-label={`${seat.name}: profile, block or report`} onClick={() => (press(), setOpen(true))} />
      <AnimatePresence>{open && <SeatSheet key="seat" seat={seat} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function SeatSheet({ seat, onClose }: { seat: SeatInfo; onClose: () => void }) {
  const [view, setView] = useState<'menu' | 'profile' | 'report'>('menu');
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [friend, setFriend] = useState<null | 'asked' | 'friends'>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    blockList()
      .then((l) => setBlocked(l.some((b) => b.user === seat.user)))
      .catch(() => setBlocked(false));
  }, [seat.user]);
  const act = async (fn: () => Promise<unknown>, then: () => void) => {
    press();
    try {
      await fn();
      then();
    } catch (e) {
      setNote({ text: e instanceof ApiError ? e.message : 'That didn’t go through.', bad: true });
    }
  };
  const toggleBlock = () =>
    act(
      () => (blocked ? unblock(seat.user!) : block({ user: seat.user! })),
      () => {
        setBlocked(!blocked);
        setNote({ text: blocked ? 'Unblocked.' : 'Blocked: you won’t see their chat here or anywhere, and they aren’t told.' });
        void import('../../../app/session').then(({ session }) => session.room?.rejoin());
      },
    );
  if (view === 'profile' && seat.handle) return <ProfileSheet handle={seat.handle} onClose={onClose} />;
  return (
    <Sheet title={`${seat.name}: profile, block or report`} onClose={onClose}>
      <div className="acct-me">
        <Face avatar={seat.avatar} name={seat.name} color={seat.color} big />
        <span className="acct-who">
          <b>{seat.name}</b>
          <small>{seat.handle ? `@${seat.handle}` : 'Guest'}</small>
        </span>
      </div>
      {view === 'menu' && (
        <div className="acct-ways">
          {seat.handle && (
            <button className="btn ghost seat-way" onClick={() => (press(), setView('profile'))}>
              <LineIcon name="user" size={18} />
              Their profile
            </button>
          )}
          {seat.handle && signedIn() && (
            <button className="btn ghost seat-way" disabled={friend !== null || !!blocked} onClick={() => void act(() => askFriend({ handle: seat.handle! }).then((r) => setFriend(r.state)), () => {})}>
              <LineIcon name={friend ? 'check' : 'userPlus'} size={18} />
              <Morph>{friend === 'friends' ? 'Friends' : friend === 'asked' ? 'Asked' : 'Add friend'}</Morph>
            </button>
          )}
          <button className="btn ghost seat-way" aria-disabled={blocked === null} onClick={() => blocked !== null && void toggleBlock()}>
            <LineIcon name={blocked ? 'eye' : 'hand'} size={18} />
            <Morph>{blocked ? 'Unblock' : 'Block'}</Morph>
          </button>
          <button className="btn ghost seat-way" onClick={() => (press(), setView('report'))}>
            <LineIcon name="flag" size={18} />
            Report
          </button>
        </div>
      )}
      {view === 'report' && (
        <ReportForm
          about={{ seat: seat.seat, user: seat.user }}
          name={seat.name}
          onDone={(text) => {
            setView('menu');
            setNote({ text });
          }}
        />
      )}
      {note && <p className={note.bad ? 'acct-bad' : 'acct-note'}>{note.text}</p>}
      <div className="acct-sheet-foot">
        <button className="btn ghost small" onClick={() => (press(), onClose())}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
