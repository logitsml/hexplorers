// Golden replays of module mixes (and of online games: keyed, a fog map), for the
// server's sake: a room pins its rules when it's created and replays its log to come back after a
// deploy, so a change that alters any of these games' course must be caught (and a rules version
// bumped). Each fixture is a game's log as bots played it, with hashes of the state along the way;
// the test replays the log and checks them. tests/moduleGolden.test.ts runs it.
//
// To record them again (only when play is meant to change):
//   RECORD_GOLDENS=1 npx vitest run tests/moduleGolden.test.ts -u

import { createGame, mustApply, type Action, type GameOptions, type GameSecret, type GameState, type PlayerId } from '../src/engine';
import { canonical, viewHash, wireView, type WireView } from '../src/engine/wire';
import { ALL_HANDS, type Expansion } from '../src/engine/presets';
import { fogMap, mixOptions, playGame, testKey } from './online/play';
import { setups } from './sim-harness';

interface Spec {
  id: string;
  seed: number;
  players: 3 | 4;
  options: Partial<GameOptions>;
  secret?: GameSecret;
  /** Where the log is cut, if the game goes on (whole games of the big mixes would make large fixtures). */
  maxActions: number;
}

export interface Fixture {
  id: string;
  players: 3 | 4;
  options: Partial<GameOptions>;
  secret?: GameSecret;
  actions: number;
  turn: number;
  winner: PlayerId | null;
  /** The state's hash after every 100th action and after the last, and the spectator's view hash at the end. */
  hashes: Record<string, string>;
  view: string;
  log: [PlayerId, Action][];
}

const mix = (expansions: Expansion[], seaMap?: string) => mixOptions(expansions, seaMap);

export const SPECS: Spec[] = [
  { id: 'sea-archipelago', seed: 501, players: 4, options: mix(['sea']), maxActions: 600 },
  { id: 'guilds', seed: 502, players: 3, options: mix(['guilds']), maxActions: 600 },
  { id: 'siege', seed: 503, players: 4, options: mix(['guilds', 'invasion']), maxActions: 600 },
  { id: 'rivermouth', seed: 504, players: 4, options: mix(['rivers', 'caravans', 'harbourmaster']), maxActions: 600 },
  { id: 'fishing-fog-bank', seed: 505, players: 4, options: mix(['sea', 'fisheries'], 'fogBank'), maxActions: 600 },
  { id: 'oil-almanac', seed: 506, players: 4, options: mix(['oil', 'almanac']), maxActions: 600 },
  { id: 'all-hands', seed: 507, players: 4, options: mix(ALL_HANDS), maxActions: 600 },
  { id: 'online-base', seed: 508, players: 4, options: { rng: 'chacha20' }, secret: { rngKey: testKey(508) }, maxActions: 600 },
  { id: 'online-all-hands', seed: 509, players: 4, options: { rng: 'chacha20', ...mix(ALL_HANDS) }, secret: { rngKey: testKey(509) }, maxActions: 600 },
  { id: 'online-fog-map', seed: 511, players: 4, options: { rng: 'chacha20', map: 'custom', custom: fogMap(), modules: ['sea'], victoryPoints: 12 }, secret: { rngKey: testKey(511) }, maxActions: 600 },
];

const stateHash = (s: GameState) => viewHash(s as unknown as WireView);

/** Plays a spec's game with bots, for its fixture. */
export function record(spec: Spec): Fixture {
  const g = playGame(spec.id, spec.seed, spec.options, spec.secret, { players: spec.players, maxSteps: spec.maxActions });
  const hashes: Record<string, string> = {};
  g.steps.forEach((st, i) => {
    if ((i + 1) % 100 === 0) hashes[i + 1] = stateHash(st.state);
  });
  hashes.final = stateHash(g.final);
  const f: Fixture = {
    id: spec.id,
    players: spec.players,
    options: { layout: 'random', seed: spec.seed, ...spec.options },
    ...(spec.secret && { secret: spec.secret }),
    actions: g.steps.length,
    turn: g.final.turn,
    winner: g.final.winner,
    hashes,
    view: viewHash(wireView(g.final, null)),
    log: g.steps.map((st) => [st.actor, st.action]),
  };
  return f;
}

/** A fixture's file: one action a line, so a re-recorded fixture's diff reads. */
export function fixtureText(f: Fixture): string {
  const { log, ...head } = f;
  return `${JSON.stringify(head).slice(0, -1)},"log":[\n${log.map((l) => JSON.stringify(l)).join(',\n')}\n]}\n`;
}

/** Replays a fixture's log; returns where it first parts from the recording, or null. */
export function replay(f: Fixture): string | null {
  let s = createGame(setups(f.players), f.options, f.secret).state;
  for (const [i, [actor, action]] of f.log.entries()) {
    try {
      s = mustApply(s, actor, action).state;
    } catch (e) {
      return `${f.id}: action ${i + 1} (${canonical(action)}) is refused now: ${(e as Error).message}`;
    }
    const want = f.hashes[i + 1];
    if (want !== undefined && stateHash(s) !== want) return `${f.id}: the state after action ${i + 1} differs from the recording`;
  }
  if (stateHash(s) !== f.hashes.final) return `${f.id}: the final state differs from the recording`;
  if (viewHash(wireView(s, null)) !== f.view) return `${f.id}: the final spectator view differs from the recording`;
  if (s.turn !== f.turn || s.winner !== f.winner) return `${f.id}: ends on turn ${s.turn} won by ${s.winner}, recorded turn ${f.turn} won by ${f.winner}`;
  return null;
}
