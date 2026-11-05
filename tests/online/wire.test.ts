// The wire views over whole bot games, for every seat and a spectator at every step: (a) the patch
// from one view to the next rebuilds it exactly on the other side of a JSON round trip, with the
// same hash; (b) the client's inflated view offers its seat exactly the choices the full state
// does. The sizes and times are printed (the online architecture's budget). The quick tier keeps
// the Base game (about 4 s) and leaves the mixes and All Hands (about 45 s) to the full run.

import { describe, expect, it } from 'vitest';
import { legalActions, type GameOptions, type GameState, type PlayerId } from '../../src/engine';
import { actionKey } from '../../src/engine/ai';
import { applyPatch, canonical, diffView, inflateView, viewHash, wireView, type PatchOp, type WireView } from '../../src/engine/wire';
import { slow, timeout } from '../tier';
import { ALL_HANDS_OPTIONS, fogMap, keyed, mixOptions, playGame, type Game } from './play';

const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const choices = (s: GameState, p: PlayerId) => legalActions(s, p).map(actionKey).sort();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

interface Measure {
  label: string;
  steps: number;
  /** Patch JSON per seat over the game (bytes), and the opening view's. */
  patchBytes: number[];
  openingBytes: number;
  /** Per seat per step: wireView, and diffView against the last view (shared structure), in ms. */
  viewMs: number[];
  diffMs: number[];
  /** diffView against a view that came over the wire (nothing shared: every subtree compared). */
  coldDiffMs: number[];
}

function check(g: Game): Measure {
  const n = g.initial.players.length;
  const viewers: (PlayerId | null)[] = [...g.initial.players.map((p) => p.id), null];
  const m: Measure = { label: g.label, steps: g.steps.length, patchBytes: Array(n + 1).fill(0), openingBytes: 0, viewMs: [], diffMs: [], coldDiffMs: [] };
  const states = [g.initial, ...g.steps.map((s) => s.state)];
  viewers.forEach((v, vi) => {
    let prev: WireView = wireView(g.initial, v);
    // (What the client holds: the snapshot as it arrived, then each patch applied to it.)
    let held: WireView = json(prev);
    if (vi === 0) m.openingBytes = JSON.stringify(prev).length;
    for (let i = 1; i < states.length; i++) {
      const s = states[i];
      const t0 = performance.now();
      const next = wireView(s, v);
      const t1 = performance.now();
      const ops = diffView(prev, next);
      const t2 = performance.now();
      m.viewMs.push(t1 - t0);
      m.diffMs.push(t2 - t1);
      if (vi === 0 && i % 7 === 0) {
        const cold = json(prev);
        const t3 = performance.now();
        diffView(cold, next);
        m.coldDiffMs.push(performance.now() - t3);
      }
      const sent = JSON.stringify(ops);
      m.patchBytes[vi] += sent.length;
      const before = i % 50 === 0 ? canonical(held) : null;
      const got = applyPatch(held, JSON.parse(sent) as PatchOp[]);
      if (before !== null) expect(canonical(held), `${g.label}: applyPatch changed its input`).toBe(before);
      const label = `${g.label} seq ${s.seq} viewer ${v}`;
      // (a) The same view, by hash at every step and whole now and then.
      expect(viewHash(got), label).toBe(viewHash(next));
      expect(viewHash(json(got)), label).toBe(viewHash(next));
      if (i % 25 === 0 || i === states.length - 1) expect(got, label).toEqual(json(next));
      // (b) The seat's choices, from what its client holds.
      if (v !== null) expect(choices(inflateView(got, v), v), label).toEqual(choices(s, v));
      prev = next;
      held = got;
    }
  });
  return m;
}

function report(m: Measure) {
  const seats = m.patchBytes.slice(0, -1);
  const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
  console.log(
    `${m.label}: ${m.steps} steps; opening view ${kb(m.openingBytes)}; patches per seat ${seats.map(kb).join(' / ')} (spectator ${kb(m.patchBytes[m.patchBytes.length - 1])}); ` +
      `per seat per step wireView ${median(m.viewMs).toFixed(3)} ms + diffView ${median(m.diffMs).toFixed(3)} ms (median; max ${Math.max(...m.viewMs).toFixed(1)} + ${Math.max(...m.diffMs).toFixed(1)}), ` +
      `diff with nothing shared ${median(m.coldDiffMs).toFixed(3)} ms`,
  );
}

describe('wire views', () => {
  it('rebuild every view of a Base game from its patches, and keep each seat’s choices', () => {
    const m = check(playGame('Base', 11, keyed(1).options, keyed(1).secret));
    report(m);
  }, timeout(1_800_000));

  slow('do the same through module mixes, the fog included', () => {
    for (const [label, seed, options] of [
      ['Guilds and Invasion', 12, mixOptions(['guilds', 'invasion'])],
      ['Rivers, Wagon Trains, Harbourmaster', 13, mixOptions(['rivers', 'caravans', 'harbourmaster'])],
      ['Sea, Fisheries, Oil on the Fog Bank', 14, mixOptions(['sea', 'fisheries', 'oil'], 'fogBank')],
      ['A custom fog map', 15, { map: 'custom', custom: fogMap(), modules: ['sea'], victoryPoints: 12 }],
    ] as [string, number, Partial<GameOptions>][]) {
      const g = playGame(label, seed, keyed(seed, options).options, keyed(seed).secret, { maxSteps: 900 });
      report(check(g));
    }
  }, timeout(1_800_000));

  slow('do the same for All Hands', () => {
    const m = check(playGame('All Hands', 16, keyed(16, ALL_HANDS_OPTIONS).options, keyed(16).secret));
    report(m);
  }, timeout(1_800_000));
});
