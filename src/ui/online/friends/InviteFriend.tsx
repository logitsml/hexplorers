// "Invite a friend", in the harbour: your friends, each with Invite (a note to them, which Web Push
// will deliver once it's built). Shown only to an account; it also tells your friends' lists that
// you're in this harbour.

import { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ApiError } from '../../../online/api';
import { friendLists, inviteFriend, sayWhere, signedIn, type FriendLists } from '../../../online/account';
import { LineIcon } from '../../LineIcons';
import { Morph } from '../../Morph';
import { Face, Sheet, ago, press } from '../account/bits';

export default function InviteFriend({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const account = signedIn();
  useEffect(() => {
    if (account) sayWhere();
  }, [account, code]);
  if (!account) return null;
  return (
    <>
      <button className="btn ghost small" onClick={() => (press(), setOpen(true))}>
        <LineIcon name="userPlus" size={16} />
        Invite a friend
      </button>
      <AnimatePresence>{open && <Friends key="friends" code={code} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function Friends({ code, onClose }: { code: string; onClose: () => void }) {
  const [lists, setLists] = useState<FriendLists | null>(null);
  const [sent, setSent] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    friendLists()
      .then(setLists)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Your list couldn’t be fetched.'));
  }, []);
  const invite = async (user: string) => {
    press();
    try {
      await inviteFriend(user, code);
      setSent((s) => ({ ...s, [user]: true }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That invitation didn’t go.');
    }
  };
  return (
    <Sheet title="Invite a friend" onClose={onClose}>
      <h2>Invite a friend</h2>
      {!lists && !error && <p className="page-note way-loading">Looking for your friends…</p>}
      {lists && lists.friends.length === 0 && <p>No friends on your list yet: add them by handle under Friends on the Multiplayer page, or share this harbour’s link.</p>}
      {lists && lists.friends.length > 0 && (
        <ul className="acct-list">
          {lists.friends.map((f) => (
            <li key={f.user} className="acct-row">
              <Face avatar={f.avatar} name={f.name} color={f.color} />
              <span className="acct-who">
                <b>{f.name}</b>
                <small className={f.where ? 'here' : undefined}>{f.where === 'harbour' ? 'In a harbour' : f.where === 'playing' ? 'At sea' : `Here ${ago(f.lastSeen)}`}</small>
              </span>
              <span className="acct-row-actions">
                <button className="btn gold small" disabled={!!sent[f.user]} onClick={() => void invite(f.user)}>
                  <LineIcon name={sent[f.user] ? 'check' : 'send'} size={16} />
                  <Morph>{sent[f.user] ? 'Invited' : 'Invite'}</Morph>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="acct-bad" role="alert">
          {error}
        </p>
      )}
      <div className="acct-sheet-foot">
        <button className="btn ghost small" onClick={() => (press(), onClose())}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
