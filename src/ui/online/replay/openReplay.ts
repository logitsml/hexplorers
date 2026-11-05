// Open an online game's replay: fetched, its dice checked (src/online/replay.ts), then played by the
// local replay machinery, with "Dice checked: fair" on its panel. The address shows /replay/ID while
// it plays (a reload comes back to it) and goes back to the start once it's left. Why it can't be
// played (gone, another version's) is said, over the title or the
// table, for a few seconds.

import { session } from '../../../app/session';
import { useUI } from '../../../game/store';
import { replayPath } from '../../../online/links';
import { checkReplay, fetchReplay } from '../../../online/replay';
import '../../../styles/online.css';

function say(text: string) {
  useUI.getState().set({ error: text });
  setTimeout(() => useUI.getState().error === text && useUI.getState().set({ error: null }), 6000);
}

function address(path: string) {
  try {
    if (location.pathname !== path) history.replaceState(history.state, '', path);
  } catch {
    /* (a sandboxed frame: the address stays as it was) */
  }
}

let opening = false;

/** Fetch, check and play the replay with this id. `commit`: the dice commitment this client saw at the table. */
export async function openReplay(id: string, o: { commit?: string } = {}): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    const got = await fetchReplay(id);
    const out = got.ok ? await checkReplay(got.record, o) : got;
    if (!out.ok) {
      // (Opened from its link: back to the start, saying why.)
      if (useUI.getState().screen !== 'game') address('/');
      return say(out.text);
    }
    address(replayPath(id));
    await session.watchReplay(out.game);
    // Leaving it (Exit replay, or another game) takes the address back to the start.
    const done = () => {
      if (location.pathname === replayPath(id)) address('/');
    };
    if (!useUI.getState().replay) return done();
    const stop = useUI.subscribe((s) => {
      if (s.replay) return;
      stop();
      done();
    });
  } catch (e) {
    console.error('could not open the replay', e);
    address('/');
    say('That replay couldn’t be opened. Try again from its link.');
  } finally {
    opening = false;
  }
}
