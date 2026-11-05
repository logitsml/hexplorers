// "Your account", on the Multiplayer page. A guest is offered "Keep your progress" (a passkey on
// this device, or the other ways in this server has); an account sees its profile (the name,
// colours and face at the top of the page, a handle, free chat), its ways in and its devices, a
// copy of its logbook, erasing it, the sailors it has blocked, and signing out. Coming back from a
// provider or a letter's link is picked up here, and a /u/HANDLE profile opens over this page.

import { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import type { FeatureFlags } from '../../../net/protocol';
import { ApiError } from '../../../online/api';
import {
  addPasskey, blockList, downloadLogbook, eraseMe, pickUpSignIn, refresh, revokeSession, saveMe, sessions, signInWith, signOut, unblock, useAccount, type Me, type ProviderId, type Sailor, type SessionInfo,
} from '../../../online/account';
import { profilePath } from '../../../online/links';
import { LineIcon } from '../../LineIcons';
import { Morph } from '../../Morph';
import type { SectionProps } from '../sections';
import { Face, ago, day, press } from './bits';
import { ProfileSheet } from './ProfileSheet';
import { SignInSheet, youngestAge } from './SignInSheet';

const PROVIDER_NAMES: Record<ProviderId, string> = { apple: 'Apple', google: 'Google', discord: 'Discord' };

const Chevron = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export default function AccountSection(p: SectionProps) {
  const me = useAccount((s) => s.me);
  const sheet = useAccount((s) => s.sheet);
  const viewing = useAccount((s) => s.viewing);
  const note = useAccount((s) => s.note);
  const set = useAccount((s) => s.set);
  useEffect(() => {
    void pickUpSignIn().then(() => refresh());
  }, []);
  return (
    <section className="acct-section" aria-labelledby="acct-head">
      <h3 id="acct-head">Your account</h3>
      {note && (
        <p className={`acct-note${note.bad ? ' bad' : ''}`} role="status">
          {note.text}
        </p>
      )}
      {!me ? <p className="page-note way-loading">Looking you up in the register…</p> : me.guest ? <Guest me={me} /> : <Account me={me} page={p} features={p.config.features} />}
      <AnimatePresence>
        {sheet && <SignInSheet key="sheet" mode={sheet} features={p.config.features} onClose={() => set({ sheet: null })} />}
        {viewing && <ProfileSheet key={`profile-${viewing}`} handle={viewing} onClose={() => set({ viewing: null })} />}
      </AnimatePresence>
    </section>
  );
}

function Guest({ me }: { me: Me }) {
  const set = useAccount((s) => s.set);
  return (
    <>
      <p>
        <b>Keep your progress:</b> your name and record on any device, and friends to sail with.
        {me.played > 0 && ` Your ${me.played} ${me.played === 1 ? 'voyage is' : 'voyages are'} kept on this device only for now.`}
      </p>
      <div className="acct-actions">
        <button className="btn gold" onClick={() => (press(), set({ sheet: 'keep', note: null }))}>
          <LineIcon name="lock" size={18} />
          Keep your progress
        </button>
        <button className="link-btn" onClick={() => (press(), set({ sheet: 'signin', note: null }))}>
          I have an account
        </button>
      </div>
      {me.user && (
        <>
          <Blocked />
          <YourData me={me} />
        </>
      )}
    </>
  );
}

function Account({ me, page, features }: { me: Me; page: SectionProps; features: FeatureFlags }) {
  const set = useAccount((s) => s.set);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    press();
    const url = `${location.origin}${profilePath(me.handle!)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy your profile’s link', url);
    }
  };
  return (
    <>
      <div className="acct-me">
        <Face avatar={me.avatar} name={me.name} color={me.color} big />
        <span className="acct-who">
          <b>{me.name}</b>
          <small>@{me.handle}</small>
        </span>
      </div>
      <div className="acct-stats">
        <span>
          {me.played} {me.played === 1 ? 'voyage' : 'voyages'}
        </span>
        <span>{me.won} won</span>
        {me.created && <span>Joined {day(me.created)}</span>}
      </div>
      <div className="acct-actions">
        <button className="btn ghost small" onClick={() => (press(), set({ viewing: me.handle! }))}>
          <LineIcon name="eye" size={16} />
          See your profile
        </button>
        <button className="btn ghost small" onClick={() => void copy()} aria-live="polite">
          <LineIcon name={copied ? 'check' : 'link'} size={16} />
          <Morph>{copied ? 'Link copied' : 'Copy its link'}</Morph>
        </button>
      </div>
      <EditProfile me={me} page={page} />
      <WaysIn me={me} features={features} />
      <Blocked />
      <YourData me={me} />
      <button className="link-btn" onClick={() => (press(), void signOut())}>
        <LineIcon name="exit" size={16} />
        Sign out on this device
      </button>
    </>
  );
}

/** The handle, free chat, and the page's name, colour and face as the profile's. */
function EditProfile({ me, page }: { me: Me; page: SectionProps }) {
  const [handle, setHandle] = useState(me.handle ?? '');
  const [year, setYear] = useState('');
  const [chat, setChat] = useState(me.settings?.chat === 'free');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const band = me.settings?.ageBand ?? null;
  const born = year ? Number(year) : null;
  const canChat = band ? band !== 'u13' : born !== null && youngestAge(born) >= 13;
  const thisYear = new Date().getFullYear();
  const changed = handle !== me.handle || page.name.trim() !== me.name || page.color !== me.color || page.avatar !== me.avatar || chat !== (me.settings?.chat === 'free') || born !== null;
  const save = async () => {
    if (busy) return;
    press();
    setBusy(true);
    setMsg(null);
    try {
      await saveMe({
        name: page.name.trim() || me.name,
        handle: handle.trim().replace(/^@/, ''),
        color: page.color,
        avatar: page.avatar,
        settings: { ...(born !== null && !band && { birthYear: born }), chat: canChat && chat ? 'free' : 'quick' },
      });
      setYear('');
      setMsg({ text: 'Saved.' });
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : 'That couldn’t be saved.', bad: true });
    }
    setBusy(false);
  };
  return (
    <details className="options">
      <summary>
        <span className="summary-label">Profile</span>
        <span className="summary-value">@{me.handle}</span>
        <Chevron />
      </summary>
      <div className="options-body acct-form">
        <p className="acct-hint">Your name, colour and face are the ones at the top of this page.</p>
        <label>
          Handle
          <input type="text" value={handle} maxLength={20} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setHandle(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} />
          <span className="acct-hint">Friends find you by it, and your profile is at /u/{handle || 'handle'}.</span>
        </label>
        {!band && (
          <label>
            Year of birth
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">Choose…</option>
              {Array.from({ length: 100 }, (_, i) => thisYear - i).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <span className="acct-hint">Kept only as an age band, never the year.</span>
          </label>
        )}
        <label className={`check${canChat ? '' : ' off'}`}>
          <input type="checkbox" checked={canChat && chat} disabled={!canChat} onChange={(e) => setChat(e.target.checked)} />
          <span>
            Free chat at tables that allow it
            <small>{band === 'u13' ? 'Quick words only: free chat is for sailors 13 and over.' : canChat ? 'Chat is kept 30 days for safety. Otherwise you talk in quick words.' : 'Free chat needs your year of birth first.'}</small>
          </span>
        </label>
        <div className="acct-actions">
          <button className="btn gold small" aria-disabled={busy || !changed} onClick={() => changed && void save()}>
            <Morph>{busy ? 'Saving…' : 'Save'}</Morph>
          </button>
          {msg && <span className={msg.bad ? 'acct-bad' : 'acct-hint'} role="status">{msg.text}</span>}
        </div>
      </div>
    </details>
  );
}

/** Passkeys, the providers and the letter, and the devices signed in. */
function WaysIn({ me, features }: { me: Me; features: FeatureFlags }) {
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    sessions()
      .then(setList)
      .catch(() => setList([]));
  const m = me.methods;
  const linkable = (['apple', 'google', 'discord'] as const).filter((x) => features[x] && !m?.providers.includes(x));
  const add = async () => {
    if (busy) return;
    press();
    setBusy(true);
    setMsg(null);
    const why = await addPasskey();
    setBusy(false);
    setMsg(why === null ? 'Passkey added.' : why || null);
  };
  return (
    <details className="options" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && list === null && void load()}>
      <summary>
        <span className="summary-label">Sign-in and devices</span>
        <span className="summary-value">
          {m?.passkeys.length ?? 0} {m?.passkeys.length === 1 ? 'passkey' : 'passkeys'}
        </span>
        <Chevron />
      </summary>
      <div className="options-body acct-form">
        <ul className="acct-list" aria-label="Passkeys">
          {m?.passkeys.map((k) => (
            <li key={k.id} className="acct-row plain">
              <span className="acct-who">
                <b>Passkey · {k.device}</b>
                <small>
                  Made {day(k.created)}
                  {k.used ? `, last used ${ago(k.used)}` : ''}
                  {k.synced ? ' · synced' : ''}
                </small>
              </span>
              <span className="acct-row-actions" />
            </li>
          ))}
          {m?.providers.map((x) => (
            <li key={x} className="acct-row plain">
              <span className="acct-who">
                <b>{PROVIDER_NAMES[x]}</b>
                <small>Signs you in</small>
              </span>
              <span className="acct-row-actions" />
            </li>
          ))}
          {m?.email && (
            <li className="acct-row plain">
              <span className="acct-who">
                <b>Email</b>
                <small>{m.email.address ? `${m.email.address} · letters about your games` : 'Sign-in letters only (the address isn’t kept)'}</small>
              </span>
              <span className="acct-row-actions" />
            </li>
          )}
        </ul>
        <div className="acct-actions">
          <button className="btn ghost small" aria-disabled={busy} onClick={() => void add()}>
            <LineIcon name="plus" size={16} />
            <Morph>{busy ? 'Waiting for the passkey…' : 'Add a passkey on this device'}</Morph>
          </button>
          {linkable.map((x) => (
            <button key={x} className="btn ghost small" onClick={() => (press(), void signInWith(x).then((why) => why && setMsg(why)))}>
              Link {PROVIDER_NAMES[x]}
            </button>
          ))}
        </div>
        {msg && <p className="acct-hint" role="status">{msg}</p>}
        <span className="field-label">Signed in on</span>
        {list === null ? (
          <p className="page-note way-loading">Looking for your devices…</p>
        ) : (
          <ul className="acct-list" aria-label="Devices signed in">
            {list.map((s) => (
              <li key={s.id} className="acct-row plain">
                <span className="acct-who">
                  <b>{s.device}</b>
                  <small>{s.current ? 'This device' : `Last seen ${ago(s.lastSeen)}`}</small>
                </span>
                <span className="acct-row-actions">
                  {!s.current && (
                    <button className="btn ghost small" onClick={() => (press(), void revokeSession(s.id).then(load))}>
                      Sign out
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/** The sailors you've blocked, and unblocking them. */
function Blocked() {
  const [list, setList] = useState<Sailor[] | null>(null);
  const load = () =>
    blockList()
      .then(setList)
      .catch(() => setList([]));
  return (
    <details className="options" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void load()}>
      <summary>
        <span className="summary-label">Blocked sailors</span>
        <span className="summary-value">{list ? list.length : ''}</span>
        <Chevron />
      </summary>
      <div className="options-body acct-form">
        <p className="acct-hint">You don’t see their chat, they can’t ask to be your friend, and they aren’t told. Block someone from their seat or their profile.</p>
        {list === null && <p className="page-note way-loading">Looking…</p>}
        {list && list.length === 0 && <p className="page-note">You haven’t blocked anyone.</p>}
        {list && list.length > 0 && (
          <ul className="acct-list">
            {list.map((b) => (
              <li key={b.user} className="acct-row plain">
                <span className="acct-who">
                  <b>{b.name}</b>
                  {b.handle && <small>@{b.handle}</small>}
                </span>
                <span className="acct-row-actions">
                  <button className="btn ghost small" onClick={() => (press(), void unblock(b.user).then(load))}>
                    Unblock
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/** "Copy of my logbook", and "Strike from the register". */
function YourData({ me }: { me: Me }) {
  const set = useAccount((s) => s.set);
  const [armed, setArmed] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const names = [me.name.toLowerCase(), me.handle?.toLowerCase()].filter(Boolean);
  const ok = names.includes(confirm.trim().replace(/^@/, '').toLowerCase());
  const erase = async () => {
    if (!ok || busy) return;
    press();
    setBusy(true);
    const why = await eraseMe(confirm.trim());
    setBusy(false);
    if (why === null) set({ note: { text: 'Your papers have been struck. Fair winds.' } });
    else setMsg(why);
  };
  return (
    <details className="options">
      <summary>
        <span className="summary-label">Your data</span>
        <span className="summary-value" />
        <Chevron />
      </summary>
      <div className="options-body acct-form">
        <div className="acct-actions">
          <button className="btn ghost small" onClick={() => (press(), void downloadLogbook().then(setMsg))}>
            <LineIcon name="download" size={16} />
            Copy of my logbook
          </button>
        </div>
        <p className="acct-hint">Everything kept about you, as a file: your profile, your games (each replay’s link), {me.guest ? 'and your blocks' : 'your ways in, devices, friends and blocks'}.</p>
        <div className="acct-danger">
          {!armed ? (
            <button className="btn ghost warn small" onClick={() => (press(), setArmed(true))}>
              <LineIcon name="trash" size={16} />
              {me.guest ? 'Erase this guest' : 'Delete my account'}
            </button>
          ) : (
            <>
              <p>Your name, record{me.guest ? '' : ', passkeys and friends'} will be removed, and every device signed out. Games you played stay in other players’ histories under “A former sailor”.</p>
              <label>
                Type your name to confirm
                <input type="text" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
              </label>
              <div className="acct-actions">
                <button className="btn ghost warn small" aria-disabled={!ok || busy} onClick={() => void erase()}>
                  <LineIcon name="trash" size={16} />
                  <Morph>{busy ? 'Striking…' : 'Strike from the register'}</Morph>
                </button>
                <button className="link-btn" onClick={() => (press(), setArmed(false), setConfirm(''))}>
                  Keep it
                </button>
              </div>
            </>
          )}
        </div>
        {msg && <p className="acct-bad" role="alert">{msg}</p>}
      </div>
    </details>
  );
}
