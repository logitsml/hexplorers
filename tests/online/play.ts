// Whole bot games for the online tests: every step kept (the state before and after, the action,
// its events), so views, events and patches can be checked at each one.

import { Rng, applyAction, createGame, seedFrom, type Action, type GameEvent, type GameOptions, type GameSecret, type GameState, type PlayerId } from '../../src/engine';
import { botDecide, createBotMemory, type BotDifficulty } from '../../src/engine/ai';
import { ALL_HANDS, mixOf, type Expansion } from '../../src/engine/presets';
import { blankMap, fillTerrain, placeHarbours, type CustomMap } from '../../src/engine/maps/custom';
import { setups } from '../sim-harness';

export interface Step {
  actor: PlayerId;
  action: Action;
  events: GameEvent[];
  before: GameState;
  state: GameState;
}

export interface Game {
  label: string;
  initial: GameState;
  initialEvents: GameEvent[];
  steps: Step[];
  final: GameState;
}

/** A test key: 64 hex digits from `n` (any number gives a different one; hashed, so no stream is drawn from). */
export function testKey(n: number): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += (seedFrom(seedFrom(n * 8 + i) ^ 0x5bd1e995) >>> 0).toString(16).padStart(8, '0');
  return out;
}

/** The options of a mix of expansions (Base when none). */
export function mixOptions(expansions: Expansion[], seaMap?: string): Partial<GameOptions> {
  if (expansions.length === 0) return {};
  const mix = mixOf(expansions, seaMap);
  return { modules: mix.modules, map: mix.map, knobs: mix.knobs, victoryPoints: mix.target };
}

export const ALL_HANDS_OPTIONS = mixOptions(ALL_HANDS);

/** A keyed (online) game's options and secret. */
export function keyed(n: number, more: Partial<GameOptions> = {}): { options: Partial<GameOptions>; secret: GameSecret } {
  return { options: { rng: 'chacha20', ...more }, secret: { rngKey: testKey(n) } };
}

const DIFFS: BotDifficulty[] = ['normal', 'hard', 'easy', 'normal'];

/** A whole bot game as the harness plays it (the polling order turned by seq), up to `maxSteps`. */
export function playGame(label: string, seed: number, options: Partial<GameOptions>, secret?: GameSecret, o: { players?: 3 | 4; maxSteps?: number; difficulties?: BotDifficulty[] } = {}): Game {
  const players = o.players ?? 4;
  const created = createGame(setups(players), { layout: 'random', seed, ...options }, secret);
  let state = created.state;
  const memories = state.players.map(() => createBotMemory());
  const diffs = o.difficulties ?? DIFFS;
  const steps: Step[] = [];
  const max = o.maxSteps ?? 20_000;
  while (state.phase !== 'gameOver' && steps.length < max) {
    let acted = false;
    const start = state.seq % players;
    for (let i = 0; i < players; i++) {
      const p = (start + i) % players;
      const action = botDecide(state, p, memories[p], diffs[p % diffs.length]);
      if (!action) continue;
      const r = applyAction(state, p, action);
      if (!r.ok) throw new Error(`${label}: bot ${p} illegal ${JSON.stringify(action)}: ${r.error}`);
      steps.push({ actor: p, action, events: r.events, before: state, state: r.state });
      state = r.state;
      acted = true;
      break;
    }
    if (!acted) throw new Error(`${label}: no bot acted at seq ${state.seq}`);
  }
  return { label, initial: created.state, initialEvents: created.events, steps, final: state };
}

/**
 * A custom map with an islet under the fog, a little way off a classic-sized island: fixed terrain
 * and numbers face down (what options.custom would give away), a harbour on the face-down islet
 * and one on the island facing a face-down sea hex (what the seen board would give away).
 */
export function fogMap(seed = 5): CustomMap {
  const rng = new Rng(seed);
  const base = placeHarbours(fillTerrain(blankMap('Fog test', 5, 2), rng), rng);
  // (Two rings out: open sea between it and the island.)
  const islet: Record<string, { terrain: 'mountains' | 'hills' | 'fields'; number: number }> = {
    '4,-3': { terrain: 'fields', number: 9 },
    '4,-2': { terrain: 'mountains', number: 6 },
    '4,-1': { terrain: 'hills', number: 8 },
  };
  const hiddenSea = new Set(['3,-2', '2,1', '3,0', '1,2']);
  const hexes = base.hexes.map((h) => {
    const k = `${h.q},${h.r}`;
    if (islet[k]) return { q: h.q, r: h.r, ...islet[k], hidden: true as const };
    if (hiddenSea.has(k)) return { q: h.q, r: h.r, terrain: 'sea' as const, hidden: true as const };
    return h;
  });
  // (On the islet, facing the open sea beyond it to the east; and on the island's coast at 2,0, facing the face-down 3,0.)
  const ports = [...base.ports.filter((p) => !(p.q === 2 && p.r === 0)), { q: 4, r: -2, side: 1, type: 'ore' as const }, { q: 2, r: 0, side: 1, type: 'wool' as const }];
  return { ...base, hexes, ports, robber: [0, 0] };
}
