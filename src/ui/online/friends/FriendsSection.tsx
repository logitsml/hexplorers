// "Friends", on the Multiplayer page: requests to answer, your friends (here a while ago, in a
// harbour, at sea), adding one by their handle, the sailors you've played with lately, and
// inviting a friend to your harbour while you're in one. Friends need an account on both sides,
// so a guest is pointed to "Keep your progress".

import { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ApiError } from '../../../online/api';
import { acceptFriend, askFriend, declineFriend, friendLists, inviteFriend, refresh, removeFriend, signedIn, useAccount, type FriendLists, type Sailor } from '../../../online/account';
import { useOnline } from '../../../online/store';
import { LineIcon } from '../../LineIcons';
import { Morph } from '../../Morph';
import type { SectionProps } from '../sections';
import { Face, ago, press } from '../account/bits';
import { ProfileSheet } from '../account/ProfileSheet';
import { SignInSheet } from '../account/SignInSheet';

export default function FriendsSection(p: SectionProps) {
  const me = useAccount((s) => s.me);
  const set = useAccount((s) => s.set);
  const sheet = useAccount((s) => s.sheet);
  const viewing = useAccount((s) => s.viewing);
  const [lists, setLists] = useState<FriendLists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = !!me && !me.guest;
  const load = () =>
    friendLists()
      .then((l) => (setLists(l), setError(null)))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Your list couldn’t be fetched.'));
  // (The Multiplayer page has no account section to look you up: here, then, or an account
  // would be shown the guest's words until the Profile page had been opened.)
  useEffect(() => {
    if (!me) void refresh();
  }, []);
  useEffect(() => {
    if (account) void load();
    else setLists(null);
  }, [account, me?.user]);
  return (
    <section className="acct-section" aria-labelledby="friends-head">
      <h3 id="friends-head">Friends</h3>
      {!me ? (
        <p className="page-note way-loading">Looking you up in the register…</p>
      ) : !account ? (
        <>
          <p>Friends find each other by handle, and see who’s in a harbour. That needs an account on both sides.</p>
          <button className="link-btn acct-lead-link" onClick={() => (press(), set({ sheet: 'keep', note: null }))}>
            <LineIcon name="user" size={16} />
            Keep your progress first
          </button>
        </>
      ) : (
        <Lists lists={lists} reload={load} error={error} />
      )}
      {/* (The sheets these open: on the Multiplayer page there's no account section to show them.) */}
      <AnimatePresence>
        {sheet && <SignInSheet key="sheet" mode={sheet} features={p.config.features} onClose={() => set({ sheet: null })} />}
        {viewing && <ProfileSheet key={`profile-${viewing}`} handle={viewing} onClose={() => set({ viewing: null })} />}
      </AnimatePresence>
    </section>
  );
}

const status = (f: FriendLists['friends'][number]) => (f.where === 'harbour' ? 'In a harbour' : f.where === 'playing' ? 'At sea' : `Here ${ago(f.lastSeen)}`);

function Who({ s, sub, here }: { s: Sailor; sub?: string; here?: boolean }) {
  const set = useAccount((x) => x.set);
  const label = (
    <>
      <b>{s.name}</b>
      <small className={here ? 'here' : undefined}>{sub ?? (s.handle ? `@${s.handle}` : 'Guest')}</small>
    </>
  );
  return (
    <>
      <Face avatar={s.avatar} name={s.name} color={s.color} />
      {s.handle ? (
        <button className="acct-who" aria-label={`${s.name}’s profile`} onClick={() => (press(), set({ viewing: s.handle! }))}>
          {label}
        </button>
      ) : (
        <span className="acct-who">{label}</span>
      )}
    </>
  );
}

function Lists({ lists, reload, error }: { lists: FriendLists | null; reload: () => Promise<void>; error: string | null }) {
  const code = useOnline((s) => s.code);
  const [handle, setHandle] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [armed, setArmed] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>, after: string) => {
    press();
    try {
      await fn();
      setDone((d) => ({ ...d, [key]: after }));
      await reload();
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : 'That didn’t go through.', bad: true });
    }
  };
  const add = async () => {
    const h = handle.trim().replace(/^@/, '');
    if (!h) return;
    press();
    setMsg(null);
    try {
      const r = await askFriend({ handle: h });
      setMsg({ text: r.state === 'friends' ? `You and @${h} are friends.` : `Asked @${h}.` });
      setHandle('');
      await reload();
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : 'That didn’t go through.', bad: true });
    }
  };
  if (error)
    return (
      <p className="acct-bad acct-retry" role="alert">
        {error}
        <button className="link-btn" onClick={() => (press(), void reload())}>
          <LineIcon name="refresh" size={16} />
          Try again
        </button>
      </p>
    );
  if (!lists) return <p className="page-note way-loading">Looking for your friends…</p>;
  return (
    <>
      {lists.incoming.length > 0 && (
        <ul className="acct-list" aria-label="Asking to be your friend">
          {lists.incoming.map((s) => (
            <li key={s.user} className="acct-row ask">
              <Who s={s} sub="Asks to be your friend" />
              <span className="acct-row-actions">
                <button className="btn gold small" onClick={() => void act(s.user, () => acceptFriend(s.user), 'Friends')}>
                  <LineIcon name="check" size={16} />
                  Accept
                </button>
                <button className="btn ghost small" onClick={() => void act(s.user, () => declineFriend(s.user), 'Declined')}>
                  Decline
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {lists.friends.length === 0 && <p className="page-note">No friends yet: add one by their handle{lists.recent.length > 0 ? ', or from the sailors you’ve played with' : ''}.</p>}
      {lists.friends.length > 0 && (
        <ul className="acct-list" aria-label="Your friends">
          {lists.friends.map((f) => (
            <li key={f.user} className="acct-row">
              <Who s={f} sub={status(f)} here={!!f.where} />
              <span className="acct-row-actions">
                {code && signedIn() && (
                  <button className="btn gold small" disabled={!!done[`invite-${f.user}`]} onClick={() => void act(`invite-${f.user}`, () => inviteFriend(f.user, code), 'Invited')}>
                    <LineIcon name={done[`invite-${f.user}`] ? 'check' : 'send'} size={16} />
                    <Morph>{done[`invite-${f.user}`] ? 'Invited' : 'Invite'}</Morph>
                  </button>
                )}
                {/* (Removing is rare: a quiet bin that asks once more, in words, before it acts.) */}
                <button
                  className={`btn ghost small acct-remove${armed === f.user ? ' armed warn' : ' tip'}`}
                  data-tip={armed === f.user ? undefined : 'Remove friend'}
                  aria-label={armed === f.user ? `Press again to remove ${f.name}` : `Remove ${f.name}`}
                  onBlur={() => armed === f.user && setArmed(null)}
                  onClick={() => (armed === f.user ? (setArmed(null), void act(f.user, () => removeFriend(f.user), 'Removed')) : (press(), setArmed(f.user)))}
                >
                  <LineIcon name="trash" size={16} />
                  {armed === f.user && <span>Remove?</span>}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="acct-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input type="text" value={handle} placeholder="Their handle" aria-label="A friend’s handle" maxLength={21} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setHandle(e.target.value.replace(/[^A-Za-z0-9_@]/g, ''))} />
        <button className="btn gold small" type="submit" aria-disabled={handle.replace(/^@/, '').length < 3}>
          <LineIcon name="userPlus" size={16} />
          Add
        </button>
      </form>
      {msg && (
        <p className={msg.bad ? 'acct-bad' : 'acct-hint'} role="status">
          {msg.text}
        </p>
      )}
      {lists.outgoing.length > 0 && (
        <ul className="acct-list" aria-label="Asked">
          {lists.outgoing.map((s) => (
            <li key={s.user} className="acct-row">
              <Who s={s} sub="Asked: waiting for them" />
              <span className="acct-row-actions">
                <button className="btn ghost small" onClick={() => void act(s.user, () => removeFriend(s.user), 'Cancelled')}>
                  Cancel
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {lists.recent.length > 0 && (
        <details className="options">
          <summary>
            <span className="summary-label">Sailed with lately</span>
            <span className="summary-value">{lists.recent.length}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </summary>
          <ul className="acct-list options-body">
            {lists.recent.slice(0, 20).map((s) => (
              <li key={s.user} className="acct-row">
                <Who s={s} sub={s.guest ? 'Guest' : `@${s.handle} · ${ago(s.at)}`} />
                <span className="acct-row-actions">
                  {!s.guest && (
                    <button className="btn ghost small" disabled={!!done[`ask-${s.user}`]} onClick={() => void act(`ask-${s.user}`, () => askFriend({ user: s.user }), 'Asked')}>
                      <LineIcon name={done[`ask-${s.user}`] ? 'check' : 'userPlus'} size={16} />
                      <Morph>{done[`ask-${s.user}`] ? 'Asked' : 'Add friend'}</Morph>
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
