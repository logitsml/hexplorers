// "Notifications" on the Multiplayer page: this device signed up for word of a friend's request or
// invitation, and of your move at a live table you stepped away from (on an iPhone, once the game is
// on the Home Screen); what to hear about, quiet hours, and a test.

import { useEffect, useState } from 'react';
import { PushError, currentPushSubscription, pushNeedsHomeScreen, pushPermission, pushSupported } from '../../../app/pwa/push';
import { sfx } from '../../../audio/sfx';
import { ApiError } from '../../../online/api';
import { ensureGuest } from '../../../online/identity';
import { followNotifications, getPushPrefs, putPushPrefs, pushToken, refreshPush, sendTestPush, turnOffPush, turnOnPush, type NoteKind, type PushPrefs } from '../../../online/notifications';
import { LineIcon } from '../../LineIcons';
import { Morph } from '../../Morph';
import { showHomeScreenCoaching } from '../../pwa';
import type { SectionProps } from '../sections';
import './notifications.css';
import '../../../styles/community.css';

const press = () => (sfx.unlock(), sfx.play('click'));

const KINDS: [NoteKind, string, string][] = [
  ['invite', 'Invitations', 'A friend asks you aboard'],
  ['friend', 'Friend requests', 'Someone would like to sail with you'],
  ['move', 'Your move', 'A live table you stepped away from'],
  ['over', 'A game’s end', 'Who won, when you weren’t there'],
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;

function pushErrorText(e: unknown): string {
  if (e instanceof PushError) {
    switch (e.code) {
      case 'denied':
        return 'Notifications are turned off for this site: the browser’s own settings can turn them back on.';
      case 'unsupported':
        return 'This browser can’t take notifications.';
      case 'no-worker':
        return 'Notifications need the installed version of the game (this build has no service worker).';
      case 'bad-key':
        return 'The harbour’s key for notifications isn’t right. Try again later.';
      default:
        return 'On iPhone, notifications come once the game is on your Home Screen.';
    }
  }
  return e instanceof ApiError ? e.message : 'Notifications couldn’t be turned on. Try again in a moment.';
}

export default function Notifications({ config, name }: SectionProps) {
  const vapidKey = config.vapidPublicKey;
  const [prefs, setPrefs] = useState<PushPrefs | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const token = pushToken();
      const sub = pushSupported() && pushPermission() === 'granted' ? await currentPushSubscription().catch(() => null) : null;
      if (!live || !sub || !token) return;
      setOn(true);
      await refreshPush(token);
      const p = await getPushPrefs(token).catch(() => null);
      if (live && p) setPrefs(p);
    })();
    return () => {
      live = false;
    };
  }, []);
  if (!config.features.push || !vapidKey) return null;
  const turnOn = async () => {
    press();
    setNote(null);
    // (On an iPhone in a Safari tab there's no push at all: the Home Screen first.)
    if (pushNeedsHomeScreen()) {
      void showHomeScreenCoaching('push');
      return;
    }
    if (!pushSupported()) return setNote('This browser can’t take notifications.');
    setBusy(true);
    try {
      const p = await turnOnPush(vapidKey, async () => (await ensureGuest(name)).token);
      setPrefs(p);
      setOn(true);
      followNotifications();
    } catch (e) {
      setNote(pushErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    press();
    const token = pushToken();
    setBusy(true);
    if (token) await turnOffPush(token);
    setOn(false);
    setBusy(false);
  };
  const change = async (patch: Parameters<typeof putPushPrefs>[1]) => {
    const token = pushToken();
    if (!token || !prefs) return;
    setPrefs({ ...prefs, ...patch, kinds: { ...prefs.kinds, ...(patch.kinds ?? {}) } });
    try {
      setPrefs(await putPushPrefs(token, patch));
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'That couldn’t be saved. Try again.');
    }
  };
  const test = async () => {
    press();
    const token = pushToken();
    if (!token) return;
    setNote(null);
    try {
      const r = await sendTestPush(token);
      setNote(r.sent ? 'Sent: it should arrive in a moment.' : 'The test didn’t reach this device. Try turning notifications off and on.');
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'The test couldn’t be sent.');
    }
  };
  return (
    <section className="online-way community notifications" aria-labelledby="way-notifications">
      <h3 id="way-notifications">Notifications</h3>
      <details className="options note-options">
        <summary>
          <span className="summary-label">Word from the harbour</span>
          <span className="summary-value">
            <Morph>{on ? 'On' : 'Off'}</Morph>
          </span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <div className="options-body">
          <label className={`toggle-row note-toggle${busy ? ' disabled' : ''}`}>
            <span className="toggle-text">
              <span className="toggle-label">Send word to this device</span>
              <span className="toggle-hint">{pushNeedsHomeScreen() ? 'On iPhone, once the game is on your Home Screen' : 'Invitations, friend requests and your move when you’re away'}</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={on} disabled={busy} onChange={(e) => void (e.target.checked ? turnOn() : turnOff())} />
          </label>
          {on && prefs && (
            <>
              {KINDS.map(([k, label, hint]) => (
                <label key={k} className="toggle-row note-toggle">
                  <span className="toggle-text">
                    <span className="toggle-label">{label}</span>
                    <span className="toggle-hint">{hint}</span>
                  </span>
                  <input type="checkbox" role="switch" className="switch" checked={prefs.kinds[k]} onChange={(e) => void change({ kinds: { [k]: e.target.checked } as Record<NoteKind, boolean> })} />
                </label>
              ))}
              <label className="toggle-row note-toggle">
                <span className="toggle-text">
                  <span className="toggle-label">Quiet hours</span>
                  <span className="toggle-hint">Notes wait until the morning{prefs.tz ? ` (${prefs.tz.replace(/_/g, ' ')})` : ''}</span>
                </span>
                <input type="checkbox" role="switch" className="switch" checked={!!prefs.quiet} onChange={(e) => void change({ quiet: e.target.checked ? { from: 22 * 60, to: 8 * 60 } : null })} />
              </label>
              {prefs.quiet && (
                <div className="note-quiet" role="group" aria-label="Quiet hours">
                  <label>
                    From
                    <select value={Math.floor(prefs.quiet.from / 60)} onChange={(e) => void change({ quiet: { from: Number(e.target.value) * 60, to: prefs.quiet!.to } })}>
                      {HOURS.map((h) => (
                        <option key={h} value={h}>
                          {hourText(h)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    to
                    <select value={Math.floor(prefs.quiet.to / 60)} onChange={(e) => void change({ quiet: { from: prefs.quiet!.from, to: Number(e.target.value) * 60 } })}>
                      {HOURS.map((h) => (
                        <option key={h} value={h}>
                          {hourText(h)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <button type="button" className="btn ghost small note-test" onClick={() => void test()}>
                <LineIcon name="bell" size={16} />
                Send a test
              </button>
            </>
          )}
          {note && (
            <p className="note-note" role="status">
              {note}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
