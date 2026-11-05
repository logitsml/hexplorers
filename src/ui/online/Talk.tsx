// The table talk's own part online, under what has been said: the reactions (drawn faces that
// float up from your panel for everyone), quick talk in its groups (sent as codes, so everyone
// reads it in their own words and none of it needs moderating), who is typing, and a line to type
// in only where the room allows free chat and your papers do (the room enforces both). Watching
// from the quay you can react, not talk: the table's talk is the table's.

import { useEffect, useMemo, useState } from 'react';
import { session } from '../../app/session';
import { sfx } from '../../audio/sfx';
import { useUI } from '../../game/store';
import { REACTIONS, type QuickTalk, type Reaction } from '../../net/protocol';
import { useOnline } from '../../online/store';
import { QUICK_GROUPS, TypingSignal, typingText } from '../../online/table';
import { QUICK_WORDS, REACTION_WORDS } from '../../online/words';
import { ReactionIcon } from './ReactionIcon';
import { LineIcon } from '../LineIcons';

const GROUP_KEY = 'exploratory.quickGroup';

function savedGroup(): string {
  try {
    const g = localStorage.getItem(GROUP_KEY);
    if (g && QUICK_GROUPS.some((x) => x.id === g)) return g;
  } catch {
    /* (no storage: the first group) */
  }
  return QUICK_GROUPS[0].id;
}

/** The reactions, a row of small drawn faces: one tap sends it. */
export function ReactionRow() {
  const send = (r: Reaction) => {
    sfx.play('click');
    session.room?.react(r);
  };
  return (
    <div className="talk-reactions" role="group" aria-label="Reactions">
      {REACTIONS.map((r) => (
        <button key={r} type="button" className="react-btn tip" data-tip={REACTION_WORDS[r].name} aria-label={`React: ${REACTION_WORDS[r].name}`} onClick={() => send(r)}>
          <ReactionIcon r={r} />
        </button>
      ))}
    </div>
  );
}

export default function OnlineTalk({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const watch = useUI((s) => !!s.online?.watch);
  const canType = useUI((s) => !!s.online?.freeChat);
  const seats = useOnline((s) => s.room?.seats);
  const typing = useOnline((s) => s.typing);
  const me = useOnline((s) => (s.watch ? null : (s.you?.seat ?? null)));
  const [group, setGroup] = useState(savedGroup);
  const [draft, setDraft] = useState('');
  const signal = useMemo(() => new TypingSignal((on) => session.room?.typing(on)), []);
  useEffect(() => () => signal.stop(), [signal]);
  const words = QUICK_GROUPS.find((g) => g.id === group)?.words ?? QUICK_GROUPS[0].words;
  const pick = (id: string) => {
    setGroup(id);
    try {
      localStorage.setItem(GROUP_KEY, id);
    } catch {
      /* (kept for this visit only) */
    }
  };
  const quick = (q: QuickTalk) => {
    sfx.play('click');
    session.room?.chat('', q);
  };
  const send = () => {
    if (!draft.trim()) return;
    sfx.play('click');
    signal.stop();
    session.say(draft);
    setDraft('');
  };
  const who = typingText(typing, seats ?? [], me);
  return (
    <div className="online-talk">
      {who && <p className="talk-typing">{who}</p>}
      <ReactionRow />
      {!watch && (
        <>
          <div className="talk-groups" role="group" aria-label="Quick talk">
            {QUICK_GROUPS.map((g) => (
              <button key={g.id} type="button" className={`talk-group${g.id === group ? ' on' : ''}`} aria-pressed={g.id === group} onClick={() => pick(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
          <div className="chat-quick" role="group" aria-label={`Quick talk: ${QUICK_GROUPS.find((g) => g.id === group)?.label ?? ''}`}>
            {words.map((q) => (
              <button key={q} type="button" className="chip-btn" onClick={() => quick(q)}>
                {QUICK_WORDS[q]}
              </button>
            ))}
          </div>
        </>
      )}
      {watch ? (
        <p className="chat-note">Watching from the quay: you can react; the talk is the table’s</p>
      ) : canType ? (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={160}
            placeholder="Say something…"
            aria-label="Message"
            onChange={(e) => {
              setDraft(e.target.value);
              signal.input(e.target.value);
            }}
            onBlur={() => signal.stop()}
          />
          <button className="btn gold small" type="submit" disabled={!draft.trim()}>
            <LineIcon name="send" size={16} />
            Send
          </button>
        </form>
      ) : (
        <p className="chat-note">Quick talk only at this table</p>
      )}
    </div>
  );
}
