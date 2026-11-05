// A report about someone: what happened, in one of a few plain words, and a note if you like.
// From a seat it goes through the room (which adds the chat around it); from a profile, to the
// server on its own. It's acknowledged, and nothing is said to the one reported.

import { useState } from 'react';
import { REPORT_REASONS, type ReportReason } from '../../../net/protocol';
import { ApiError } from '../../../online/api';
import { report } from '../../../online/account';
import { LineIcon } from '../../LineIcons';
import { Morph } from '../../Morph';
import { press } from '../account/bits';

export const REASONS: Record<ReportReason, string> = {
  abuse: 'Abuse or harassment',
  cheating: 'Cheating or teaming up',
  spam: 'Spam',
  name: 'An unkind name',
  afk: 'Left the table',
  other: 'Something else',
};

export function ReportForm({ about, name, onDone }: { about: { user?: string; handle?: string; seat?: number }; name: string; onDone: (text: string) => void }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!reason || busy) return;
    press();
    setBusy(true);
    setError(null);
    try {
      await report(about, reason, note.trim() || undefined);
      onDone('Thanks. We’ll take a look.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The report didn’t go. Try again in a moment.');
      setBusy(false);
    }
  };
  return (
    <div className="acct-form">
      <p>What happened with {name}?</p>
      <div className="acct-reasons" role="group" aria-label="Reason">
        {REPORT_REASONS.map((r) => (
          <button key={r} type="button" className={`chip-btn${reason === r ? ' on' : ''}`} aria-pressed={reason === r} onClick={() => (press(), setReason(r))}>
            {REASONS[r]}
          </button>
        ))}
      </div>
      <label>
        A note (optional)
        <input type="text" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && (
        <p className="acct-bad" role="alert">
          {error}
        </p>
      )}
      <div className="acct-actions">
        <button className="btn gold" aria-disabled={!reason || busy} onClick={() => void send()}>
          <LineIcon name="send" size={18} />
          <Morph>{busy ? 'Sending…' : 'Send the report'}</Morph>
        </button>
      </div>
    </div>
  );
}
