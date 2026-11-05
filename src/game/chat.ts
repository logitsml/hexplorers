// Table talk at a local table: the pure core (game/tableTalk.ts) speaking into the table's chat,
// each line after its delay. Online, the room server runs the core itself and sends the lines.

import type { GameState, PlayerId } from '../engine';
import type { BotDifficulty } from '../engine/ai';
import { useUI } from './store';
import { TalkCore } from './tableTalk';

export { PLAIN } from './tableTalk';

export class TableTalk extends TalkCore {
  private readonly timers: Set<ReturnType<typeof setTimeout>>;

  constructor(me: PlayerId, state: () => GameState, difficulty: (p: PlayerId) => BotDifficulty = () => 'normal') {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    super(me, state, difficulty, {
      now: () => performance.now(),
      random: () => Math.random(),
      emit: (line) => {
        const t = setTimeout(() => {
          timers.delete(t);
          useUI.getState().pushChat({ player: line.player, text: line.text, offer: line.offer });
        }, line.delay);
        timers.add(t);
      },
    });
    this.timers = timers;
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
