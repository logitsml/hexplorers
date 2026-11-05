// The bots' table talk, on the server: the same voices as a local table (game/tableTalk.ts),
// fed only what each line may know. Remarks on what happens at the table read the spectators'
// view (everything in them is public); an answer to a person reads that person's own view with the
// speaking bots' own hands in it (a bot names a deal from its hand and what the asker can see),
// and a deal, which shows the asker's own cards, goes to the asker alone.

import { redactState, type GameEvent, type GameState, type PlayerId } from '../../src/engine';
import type { BotDifficulty } from '../../src/engine/ai';
import { TalkCore, type TalkLine } from '../../src/game/tableTalk';
import type { QuickTalk } from '../../src/net/protocol';

export interface SaidLine {
  from: PlayerId;
  text: string;
  /** Only to this seat. */
  to?: PlayerId;
  offer?: TalkLine['offer'];
}

/** What a quick-talk word says, for the bots to answer it as if typed. */
const QUICK_WORDS: Partial<Record<QuickTalk, string>> = {
  hello: 'hello',
  goodLuck: 'good luck',
  niceMove: 'nice',
  thanks: 'thanks',
  wellPlayed: 'well played',
  goodGame: 'good game',
  anyWool: 'anyone have wool?',
  anyGrain: 'anyone have wheat?',
  anyLumber: 'anyone have wood?',
  anyBrick: 'anyone have brick?',
  anyOre: 'anyone have ore?',
};

/** Lines that answer from the asker's own knowledge of the table: theirs alone. */
const PRIVATE = new Set(['deal', 'trade', 'tradeNo']);

export class RoomTalk {
  private table: TalkCore;
  private said: SaidLine[] = [];
  private publicView: GameState | null = null;

  constructor(
    private state: () => GameState,
    private difficulty: (p: PlayerId) => BotDifficulty,
    private now: () => number,
    private random: () => number,
  ) {
    // (Seat -1 is nobody's: the table's remarks name every seat, none of them "you".)
    this.table = new TalkCore(-1, () => (this.publicView ??= redactState(this.state(), null)), difficulty, {
      now,
      random,
      emit: (l) => this.said.push({ from: l.player, text: l.text }),
    });
  }

  /** The table reacts to what just happened. */
  onEvents(events: readonly GameEvent[]) {
    this.publicView = null;
    for (const e of events) this.table.onEvent(e);
  }

  /** A person said something (or a quick-talk word): the bots named, or one of them, answer. */
  hear(asker: PlayerId, text: string | undefined, quick: QuickTalk | undefined) {
    const words = text ?? (quick ? QUICK_WORDS[quick] : undefined);
    if (!words) return;
    let view: GameState | null = null;
    const askerView = () => {
      if (view) return view;
      const full = this.state();
      const v = redactState(full, asker);
      for (const p of full.players) if (p.isBot) v.players[p.id].hand = { ...full.players[p.id].hand };
      return (view = v);
    };
    const talk = new TalkCore(asker, askerView, this.difficulty, {
      now: this.now,
      random: this.random,
      emit: (l) => this.said.push({ from: l.player, text: l.text, ...(PRIVATE.has(l.moment) ? { to: asker } : {}), ...(l.offer ? { offer: l.offer } : {}) }),
    });
    talk.hear(words);
  }

  /** The lines said since the last call. */
  take(): SaidLine[] {
    const out = this.said;
    this.said = [];
    return out;
  }
}
