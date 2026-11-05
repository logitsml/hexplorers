// "Watch the replay" on an online game's results: there once the room has archived the game
// (Results.replay). A link, so it can be opened in a tab of its own or copied; a press plays it
// here, its dice checked against the commitment this table was shown at the start.

import { useOnline } from '../../../online/store';
import { replayPath } from '../../../online/links';
import { LineIcon } from '../../LineIcons';
import { openReplay } from './openReplay';

export default function WatchReplay({ disabled }: { disabled?: boolean }) {
  const id = useOnline((s) => s.room?.results?.replay);
  const commit = useOnline((s) => s.room?.commit);
  if (!id) return null;
  return (
    <a
      className="btn ghost"
      href={replayPath(id)}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        // (A tab of its own when asked for one; here otherwise.)
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        if (!disabled) void openReplay(id, { commit });
      }}
    >
      <LineIcon name="play" size={18} />
      Watch the replay
    </a>
  );
}
