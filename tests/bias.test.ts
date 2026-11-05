// Whether the bots single out a person. One seat in four is a stand-in person: played by the same
// bot, but seated as a person (isBot false), so the bots treat it as they would a player. Anything
// the bots do to that seat more than to each other's comes from its being a person, not from its
// play. The same boards are played all-bot too, as the control. Skipped in the usual run:
//
//   BIAS=1 N=200 npx vitest run tests/bias.test.ts --silent=false   (DIFFS=easy,hard to pick the levels)

import { it } from 'vitest';
import { applyAction, createGame, publicVictoryPoints, type GameState } from '../src/engine';
import { botDecide, createBotMemory, type BotDifficulty } from '../src/engine/ai';
import { newGame, setups } from './sim-harness';
import { timeout } from './tier';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

interface Tally {
  seats: number;
  wins: number;
  /** Robber moves by others onto a hex beside this seat's pieces, and thefts from it. */
  robbedHex: number;
  stolen: number;
  /** Thefts from this seat while it led on public points (alone or tied). */
  stolenLeading: number;
  /** Turns this seat led on public points at a theft. */
  ledAtTheft: number;
  thefts: number;
  /** Answers others gave to this seat's offers, and how many said yes or countered. */
  asked: number;
  yes: number;
  countered: number;
  offers: number;
  /** This seat's answers to others' offers that said yes. */
  answered: number;
  answeredYes: number;
}

const blank = (): Tally => ({ seats: 0, wins: 0, robbedHex: 0, stolen: 0, stolenLeading: 0, ledAtTheft: 0, thefts: 0, asked: 0, yes: 0, countered: 0, offers: 0, answered: 0, answeredYes: 0 });

/** One game, seat `watch` tallied as tallies[0] and the rest as tallies[1]; `person` seats that seat as a person. */
function play(seed: number, layout: 'beginner' | 'random', diff: BotDifficulty, watch: number, person: boolean, tallies: Tally[]) {
  const n = 4;
  const seats = setups(n).map((p, i) => ({ ...p, isBot: !(person && i === watch) }));
  let s: GameState = createGame(seats, newGame(n, { layout, seed })).state;
  const mem = s.players.map(() => createBotMemory({ waitForHumans: person }));
  const role = (p: number) => tallies[p === watch ? 0 : 1];
  for (let p = 0; p < n; p++) role(p).seats++;
  while (s.phase !== 'gameOver' && s.turn < 600) {
    let acted = false;
    for (let i = 0; i < n && !acted; i++) {
      const p = (s.seq + i) % n;
      const a = botDecide(s, p, mem[p], diff);
      if (!a) continue;
      if (a.type === 'moveRobber') {
        const owners = new Set(s.board.hexes[a.hex].vertices.map((v) => s.buildings[v]?.owner).filter((o) => o !== undefined && o !== p));
        for (const o of owners) role(o!).robbedHex++;
      }
      if (a.type === 'steal') {
        const vp = s.players.map((x) => publicVictoryPoints(s, x.id));
        const top = Math.max(...vp);
        for (let o = 0; o < n; o++) {
          if (o === p) continue;
          role(o).thefts++;
          if (vp[o] === top) role(o).ledAtTheft++;
        }
        role(a.victim).stolen++;
        if (vp[a.victim] === top) role(a.victim).stolenLeading++;
      }
      if (s.trade && p !== s.trade.proposer && (a.type === 'respondTrade' || a.type === 'counterTrade')) {
        const t = role(s.trade.proposer);
        t.asked++;
        if (a.type === 'counterTrade') t.countered++;
        else if (a.accept) t.yes++;
        role(p).answered++;
        if (a.type === 'respondTrade' && a.accept) role(p).answeredYes++;
      }
      if (a.type === 'offerTrade') role(p).offers++;
      const r = applyAction(s, p, a);
      if (!r.ok) throw new Error(`seed ${seed}: ${r.error}`);
      s = r.state;
      acted = true;
    }
    if (!acted) throw new Error(`seed ${seed}: no one could move`);
  }
  if (s.winner !== null) role(s.winner).wins++;
}

it.skipIf(!env.BIAS)('the bots treat a person as they treat each other', () => {
  const boards = Number(env.N ?? 100);
  const first = Number(env.SEED ?? 7000);
  const per = (t: Tally) => {
    const r = (x: number, y: number) => +(x / Math.max(1, y)).toFixed(3);
    return {
      winRate: r(t.wins, t.seats),
      robbedHexPerGame: r(t.robbedHex, t.seats),
      stolenShare: r(t.stolen, t.thefts),
      stolenWhenLeading: r(t.stolenLeading, t.ledAtTheft),
      stolenWhenNotLeading: r(t.stolen - t.stolenLeading, t.thefts - t.ledAtTheft),
      offersPerGame: r(t.offers, t.seats),
      othersSayYes: r(t.yes, t.asked),
      othersCounter: r(t.countered, t.asked),
      saysYes: r(t.answeredYes, t.answered),
    };
  };
  for (const diff of (env.DIFFS ?? 'easy,normal,hard').split(',') as BotDifficulty[]) {
    // The person's seat goes round the boards; the control plays the same boards all-bot, that seat tallied apart.
    const withPerson = [blank(), blank()];
    const allBot = [blank(), blank()];
    for (let k = 0; k < boards; k++) {
      const layout = k % 2 ? 'random' : 'beginner';
      play(first + k, layout, diff, k % 4, true, withPerson);
      play(first + k, layout, diff, k % 4, false, allBot);
    }
    console.log('BIAS', diff, JSON.stringify({ person: per(withPerson[0]), botsWithPerson: per(withPerson[1]), controlSeat: per(allBot[0]), controlOthers: per(allBot[1]) }));
  }
}, timeout(86400000));
