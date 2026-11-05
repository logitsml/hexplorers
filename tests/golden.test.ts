// Golden replays: a fixed set of seeded bot games and random legal-action games, each reduced to a
// hash of everything that matters to play (every action, and after it the dice stream, hands, pieces,
// points and awards). The engine's refactors must reproduce every hash exactly; a changed hash means
// a recorded game would play differently.
//
// The projection is deliberately independent of the state's shape: card counts list only non-zero
// entries and keys are sorted, so adding new kinds of card or new fields doesn't move a hash unless
// the base game's play changes.
//
//   npx vitest run tests/golden.test.ts -u    (re-record, only when play is meant to change)

import { describe, expect } from 'vitest';
import { RESOURCES, Rng, applyAction, createGame, legalActions, seedFrom, totalVictoryPoints, type Action, type GameOptions, type GameState } from '../src/engine';
import { botDecide, createBotMemory, type BotDifficulty, type BotMemory } from '../src/engine/ai';
import { setups } from './sim-harness';
import { slow, timeout } from './tier';

/** A streaming 64-bit string hash (two 32-bit lanes), plenty to tell deterministic streams apart. */
class Hash {
  private a = 0xdeadbeef;
  private b = 0x41c6ce57;
  update(text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      this.a = Math.imul(this.a ^ c, 2654435761);
      this.b = Math.imul(this.b ^ c, 1597334677);
    }
  }
  digest(): string {
    let a = Math.imul(this.a ^ (this.a >>> 16), 2246822507) ^ Math.imul(this.b ^ (this.b >>> 13), 3266489909);
    let b = Math.imul(this.b ^ (this.b >>> 16), 2246822507) ^ Math.imul(this.a ^ (this.a >>> 13), 3266489909);
    a >>>= 0;
    b >>>= 0;
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
}

const CARD_KEYS = new Set<string>([...RESOURCES, 'paper', 'cloth', 'silver', 'oil']);

/** Stable JSON: sorted keys, and count objects (all numbers, card keys only) without their zeros. */
function canon(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const counts = keys.length > 0 && keys.every((k) => CARD_KEYS.has(k) && typeof o[k] === 'number');
  return `{${keys
    .filter((k) => o[k] !== undefined && !(counts && o[k] === 0))
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(',')}}`;
}

function snapshot(s: GameState): string {
  return canon({
    rng: s.rngState,
    seq: s.seq,
    turn: s.turn,
    phase: s.phase,
    current: s.currentPlayer,
    dice: s.dice,
    robber: s.robberHex,
    bank: RESOURCES.map((r) => s.bank[r]),
    players: s.players.map((p) => ({
      hand: RESOURCES.map((r) => p.hand[r]),
      vp: totalVictoryPoints(s, p.id),
      dev: p.devCards.map((c) => c.type).sort(),
      played: p.playedDevCards,
      left: [p.settlementsLeft, p.citiesLeft, p.roadsLeft],
      route: p.longestRoad,
    })),
    buildings: s.buildings.map((b) => (b ? `${b.owner}${b.kind[0]}` : '')).join(','),
    roads: s.routes.map((r) => (r === null ? '' : r.owner)).join(','),
    awards: [s.longestRoadHolder, s.largestArmyHolder],
    trade: s.trade,
    winner: s.winner,
  });
}

interface GoldenGame {
  id: string;
  hash: string;
  actions: number;
  winner: number | null;
  turns: number;
}

function record(id: string, initial: GameState, next: (s: GameState) => { actor: number; action: Action } | null, maxSteps: number): GoldenGame {
  const h = new Hash();
  let state = initial;
  h.update(snapshot(state));
  let actions = 0;
  for (let i = 0; i < maxSteps && state.phase !== 'gameOver'; i++) {
    const n = next(state);
    if (!n) break;
    const r = applyAction(state, n.actor, n.action);
    h.update(`|${n.actor}:${canon(n.action)}:${r.ok ? 'ok' : `err ${r.error}`}|`);
    if (!r.ok) continue;
    state = r.state;
    h.update(canon(r.events));
    h.update(snapshot(state));
    actions++;
  }
  return { id, hash: h.digest(), actions, winner: state.winner, turns: state.turn };
}

const DIFFS: BotDifficulty[] = ['easy', 'normal', 'hard'];

function botGame(g: number): GoldenGame {
  const players = g % 3 === 0 ? 3 : 4;
  // These fixtures record rules 2. Keep replaying that contract as new games gain newer rules.
  const opts: Partial<GameOptions> = {
    rules: 2,
    seed: 70_000 + g * 13,
    layout: g % 2 === 0 ? 'beginner' : 'random',
    numberPlacement: g % 4 === 1 ? 'balanced' : 'spiral',
    friendlyRobber: g % 5 === 2,
    eventDeck: g % 7 === 3,
    victoryPoints: g % 11 === 5 ? 12 : 10,
  };
  const state = createGame(setups(players), opts).state;
  const memories: BotMemory[] = state.players.map(() => createBotMemory());
  const diffs = Array.from({ length: players }, (_, i) => DIFFS[(g + i) % 3]);
  return record(`bot-${g}`, state, (s) => {
    const start = s.seq % players;
    for (let i = 0; i < players; i++) {
      const p = (start + i) % players;
      const action = botDecide(s, p, memories[p], diffs[p]);
      if (action) return { actor: p, action };
    }
    return null;
  }, 20_000);
}

function fuzzGame(g: number): GoldenGame {
  const players = g % 3 === 0 ? 3 : 4;
  const state = createGame(setups(players), {
    rules: 2,
    seed: 80_000 + g * 17,
    layout: g % 2 === 0 ? 'random' : 'beginner',
    numberPlacement: g % 2 ? 'balanced' : 'spiral',
    friendlyRobber: g % 4 === 1,
    eventDeck: g % 4 === 2,
  }).state;
  const rng = new Rng(seedFrom(g * 104_729 + 7));
  return record(`fuzz-${g}`, state, (s) => {
    const per = s.players.map((p) => legalActions(s, p.id));
    const actors = per.map((a, p) => (a.length > 0 ? p : -1)).filter((p) => p >= 0);
    if (actors.length === 0) return null;
    const actor = actors.includes(s.currentPlayer) && rng.next() < 0.8 ? s.currentPlayer : actors[rng.int(actors.length)];
    const choices = per[actor];
    return { actor, action: choices[rng.int(choices.length)] };
  }, 1500);
}

const GAMES: (() => GoldenGame)[] = [...Array.from({ length: 90 }, (_, g) => () => botGame(g)), ...Array.from({ length: 30 }, (_, g) => () => fuzzGame(g))];

describe('golden replays', () => {
  slow('every recorded game plays out exactly as recorded', async () => {
    const got = GAMES.map((f) => f());
    // Sanity: the set covers finished games of both sizes.
    expect(got.filter((g) => g.id.startsWith('bot') && g.winner !== null).length).toBeGreaterThan(80);
    // One line per game, so a failure's diff names the games that changed.
    await expect(`${got.map((g) => JSON.stringify(g)).join('\n')}\n`).toMatchFileSnapshot('./fixtures/golden-base.jsonl');
  }, timeout(300_000));
});
