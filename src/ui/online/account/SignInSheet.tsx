// "Keep your progress" and "Sign in": the ship's register. A passkey first (this device's own
// lock, no password), then the providers this server has keys for, then a letter by email if it
// sends them. Keeping your progress asks a year of birth first, neutrally and with no default,
// kept only as an age band (features-social.md §1.5): free chat at tables is an opt-in for 13 and
// over, quick talk otherwise.

import { useState } from 'react';
import type { FeatureFlags } from '../../../net/protocol';
import { addPasskey, enterCode, passkeysHere, sendLetter, signInWith, signInWithPasskey, useAccount, type ProviderId, type SheetMode, type SignUp } from '../../../online/account';
import { LineIcon } from '../../LineIcons';
import { Morph } from '../../Morph';
import { Sheet, press } from './bits';

const PROVIDERS: [ProviderId, string][] = [
  ['apple', 'Continue with Apple'],
  ['google', 'Continue with Google'],
  ['discord', 'Continue with Discord'],
];

/** The youngest age a birth year could mean (as the server counts it). */
export const youngestAge = (year: number, now = new Date()) => now.getFullYear() - year - 1;

export function SignInSheet({ mode, features, onClose }: { mode: SheetMode; features: FeatureFlags; onClose: () => void }) {
  const set = useAccount((s) => s.set);
  const [step, setStep] = useState<'ways' | 'email' | 'code'>('ways');
  const [year, setYear] = useState<string>('');
  const [chat, setChat] = useState(false);
  const [email, setEmail] = useState('');
  const [notify, setNotify] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = mode === 'keep';
  const thisYear = new Date().getFullYear();
  const born = year && year !== 'no' ? Number(year) : null;
  const canChat = born !== null && youngestAge(born) >= 13;
  const signUp: SignUp | undefined = keep && born !== null ? { birthYear: born, chat: canChat && chat ? 'free' : 'quick' } : undefined;
  const providers = PROVIDERS.filter(([p]) => features[p]);
  const run = async (what: () => Promise<string | null>, done?: string) => {
    if (busy) return;
    press();
    setBusy(true);
    setError(null);
    const why = await what();
    setBusy(false);
    if (why === null) {
      if (done) set({ note: { text: done } });
      onClose();
    } else if (why) setError(why);
  };
  return (
    <Sheet title={keep ? 'Keep your progress' : 'Sign in'} onClose={onClose}>
      {/* (Back to the other ways, from the letter's form, at the sheet's top left.) */}
      {step === 'email' && (
        <button className="link-btn sheet-back" type="button" onClick={() => (press(), setError(null), setStep('ways'))}>
          <LineIcon name="back" size={16} />
          Other ways
        </button>
      )}
      <h2>{keep ? 'Keep your progress' : 'Sign in'}</h2>
      {step === 'ways' && (
        <>
          <p>{keep ? 'Your name and record, on any device. There’s no password: a passkey is this device’s own lock.' : 'To the account you made on another device. The games you played here as a guest come along.'}</p>
          {keep && (
            <div className="acct-form">
              <label>
                Year of birth
                <select value={year} onChange={(e) => setYear(e.target.value)}>
                  <option value="">Choose…</option>
                  {Array.from({ length: 100 }, (_, i) => thisYear - i).map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                  <option value="no">Rather not say</option>
                </select>
                <span className="acct-hint">Asked once and kept only as an age band, never the year.</span>
              </label>
              <label className={`check${canChat ? '' : ' off'}`}>
                <input type="checkbox" checked={canChat && chat} disabled={!canChat} onChange={(e) => setChat(e.target.checked)} />
                <span>
                  Free chat at tables that allow it
                  <small>{canChat || born === null ? 'Otherwise you talk in quick words. You can change this later.' : 'Quick words only: free chat is for sailors 13 and over.'}</small>
                </span>
              </label>
            </div>
          )}
          <div className="acct-ways">
            {passkeysHere() ? (
              <button className="btn gold large" aria-disabled={busy} onClick={() => void run(() => (keep ? addPasskey(signUp) : signInWithPasskey()), keep ? 'Registered: your logbook is safe.' : 'You’re signed in.')}>
                <LineIcon name="lock" size={20} />
                <Morph>{busy ? 'Waiting for the passkey…' : keep ? 'Add a passkey' : 'Sign in with a passkey'}</Morph>
              </button>
            ) : (
              <p className="page-note">This browser can’t make passkeys{providers.length || features.email ? ': try another way below.' : '.'}</p>
            )}
            {(providers.length > 0 || features.email) && <span className="acct-or">or</span>}
            {providers.map(([p, label]) => (
              <button key={p} className="btn ghost" aria-disabled={busy} onClick={() => void run(() => signInWith(p, signUp))}>
                {label}
              </button>
            ))}
            {features.email && (
              <button className="btn ghost" onClick={() => (press(), setError(null), setStep('email'))}>
                <LineIcon name="send" size={18} />
                Email me a link
              </button>
            )}
          </div>
        </>
      )}
      {step === 'email' && (
        <form
          className="acct-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const why = await sendLetter(email, notify);
              if (why === null) setStep('code');
              return why ?? '';
            });
          }}
        >
          <p>A letter with a link and a code, good for 15 minutes.</p>
          <label>
            Email address
            <input type="email" value={email} autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>
              Send my “your move” letters here too
              <small>Otherwise the address isn’t kept: only a sealed copy, for signing in.</small>
            </span>
          </label>
          <div className="acct-actions">
            <button className="btn gold" type="submit" aria-disabled={busy || !email.includes('@')}>
              <LineIcon name="send" size={18} />
              <Morph>{busy ? 'Sending…' : 'Send the letter'}</Morph>
            </button>
          </div>
        </form>
      )}
      {step === 'code' && (
        <form
          className="acct-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => enterCode(email, code, signUp), 'You’re signed in.');
          }}
        >
          <p>A letter is on its way. Open its link on this device, or type its six-digit code here.</p>
          <label>
            Code
            <input type="text" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={7} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} />
          </label>
          <div className="acct-actions">
            <button className="btn gold" type="submit" aria-disabled={busy || code.replace(/\D/g, '').length !== 6}>
              <Morph>{busy ? 'Checking…' : 'Sign in'}</Morph>
            </button>
            <button className="link-btn" type="button" onClick={() => setStep('email')}>
              <LineIcon name="refresh" size={16} />
              Send another
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="acct-bad" role="alert">
          {error}
        </p>
      )}
      <div className="acct-sheet-foot">
        {keep && step === 'ways' && (
          <button className="link-btn" onClick={() => (press(), set({ sheet: 'signin' }))}>
            I have an account
          </button>
        )}
        <button className="btn ghost small" onClick={() => (press(), onClose())}>
          Not now
        </button>
      </div>
    </Sheet>
  );
}
