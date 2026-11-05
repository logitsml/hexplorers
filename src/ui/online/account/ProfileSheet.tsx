// Someone's profile (a /u/HANDLE link, or a seat's "Profile"): their face, name and handle, when
// they joined, the games they've played and won, the last few, and what you can do: ask them to
// be friends, block them, or report them.

import { useEffect, useState } from 'react';
import { ApiError } from '../../../online/api';
import { askFriend, block, friendLists, myId, profile, signedIn, unblock, type PublicProfile } from '../../../online/account';
import { ReportForm } from '../safety/Report';
import { LineIcon } from '../../LineIcons';
import { Morph } from '../../Morph';
import { Face, Sheet, day, press } from './bits';

export function ProfileSheet({ handle, onClose }: { handle: string; onClose: () => void }) {
  const [p, setP] = useState<PublicProfile | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [friend, setFriend] = useState<null | 'asked' | 'friends'>(null);
  const [blocked, setBlocked] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    profile(handle)
      .then((x) => live && setP(x))
      .catch((e) => live && setMissing(e instanceof ApiError && e.status === 404 ? 'Nobody sails under that handle.' : 'That profile couldn’t be fetched.'));
    return () => {
      live = false;
    };
  }, [handle]);
  // (Already friends, or asked: said so, rather than offering to ask again.)
  useEffect(() => {
    if (!p || !signedIn()) return;
    let live = true;
    friendLists().then(
      (l) => live && setFriend(l.friends.some((f) => f.user === p.user) ? 'friends' : l.outgoing.some((f) => f.user === p.user) ? 'asked' : null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [p]);
  const mine = !!p && p.user === myId();
  const act = async (fn: () => Promise<unknown>, then: () => void) => {
    press();
    try {
      await fn();
      then();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'That didn’t go through.');
    }
  };
  return (
    <Sheet title={p ? `${p.name}’s profile` : 'A profile'} onClose={onClose}>
      {!p && !missing && <p className="page-note way-loading">Looking them up…</p>}
      {missing && (
        <>
          <h2>No profile here</h2>
          <p>{missing} Check the handle in the link, or find them by it under Friends.</p>
        </>
      )}
      {p && (
        <>
          <div className="acct-me">
            <Face avatar={p.avatar} name={p.name} color={p.color} big />
            <span className="acct-who">
              <b>{p.name}</b>
              <small>@{p.handle}</small>
            </span>
          </div>
          <div className="acct-stats">
            <span>Joined {day(p.joined)}</span>
            <span>
              {p.played} {p.played === 1 ? 'voyage' : 'voyages'}
            </span>
            <span>{p.won} won</span>
          </div>
          {p.recent.length > 0 && (
            <ul className="acct-games" aria-label="Recent voyages">
              {p.recent.slice(0, 5).map((g) => (
                <li key={g.replay}>
                  <span>{day(g.at)}</span>
                  <span>
                    {g.points} points{g.won && <b> · won</b>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!mine && !reporting && (
            <div className="acct-actions">
              {signedIn() && (
                <button className="btn gold small" disabled={friend !== null || blocked} onClick={() => void act(() => askFriend({ handle: p.handle }).then((r) => setFriend(r.state)), () => {})}>
                  <LineIcon name={friend ? 'check' : 'userPlus'} size={16} />
                  <Morph>{friend === 'friends' ? 'Friends' : friend === 'asked' ? 'Asked' : 'Add friend'}</Morph>
                </button>
              )}
              {/* (Blocking and reporting: there when needed, quieter than the friendly way.) */}
              <span className="acct-quiet">
                <button className="link-btn" onClick={() => void act(() => (blocked ? unblock(p.user) : block({ user: p.user })), () => setBlocked(!blocked))}>
                  <Morph>{blocked ? 'Unblock' : 'Block'}</Morph>
                </button>
                <button className="link-btn" onClick={() => (press(), setReporting(true))}>
                  <LineIcon name="flag" size={16} />
                  Report
                </button>
              </span>
            </div>
          )}
          {blocked && <p className="page-note">Blocked: you won’t see their chat, and they can’t ask to be your friend. They aren’t told.</p>}
          {reporting && (
            <ReportForm
              about={{ user: p.user }}
              name={p.name}
              onDone={(text) => {
                setReporting(false);
                setNote(text);
              }}
            />
          )}
          {note && <p className="acct-note">{note}</p>}
        </>
      )}
      <div className="acct-sheet-foot">
        <button className="btn ghost small" onClick={() => (press(), onClose())}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
