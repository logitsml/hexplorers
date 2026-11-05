// The home island's rules (docs/maps.md, The home island), held over every map the set-up page can
// deal: each mix of expansions on each map its pool offers, dealt as a new game is. A rule a map
// doesn't keep yet is listed in PENDING with what will make it hold, so a rule that breaks
// anywhere else fails here, and so does a listed one that has started to hold (take it out, and
// mark the rule's ✔ in docs/maps.md). The usual run deals each mix once on one map of its pool, in
// turn, and FULL=1 ten times on every one, enough to tell. The report mode prints how often each
// rule breaks on each map and the soft rules' figures, for tuning the dealer:
//
//   ISLAND=1 N=40 npx vitest run tests/island.test.ts --silent=false   (SEED=… for other deals)

import { describe, expect, it } from 'vitest';
import { dealBoard } from '../src/engine';
import { islandBreaches, islandFigures, type IslandFigures, type IslandRule } from '../src/engine/maps/island';
import { mixOf } from '../src/engine/presets';
import type { ModuleId } from '../src/engine/types';
import { mixes } from './sim-harness';
import { FULL, games, timeout } from './tier';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/** The rules each map doesn't keep yet, and what will make them hold (see docs/maps.md). */
const PENDING: Record<string, Partial<Record<IslandRule, string>>> = {};

/** Every mix on every map its pool offers (or on one of them, in turn), `n` deals each from seed `first`, three seats and four in turn. */
function deals(n: number, first: number, every = true) {
  return mixes(every).flatMap((m, k) => {
    const mix = mixOf(m.chosen, m.map);
    return Array.from({ length: n }, (_, i) => {
      const [seed, players] = [first + i, (k + i) % 2 ? 3 : 4];
      return { label: m.label, map: mix.map, modules: mix.modules, seed, spec: () => dealBoard(players, { seed, modules: mix.modules, map: mix.map, knobs: mix.knobs }) };
    });
  });
}

describe('the home island', () => {
  it('keeps its rules on every map, but for those still to come', () => {
    const broken = new Map<string, string>();
    for (const d of deals(games(10, 1), 300, FULL)) {
      for (const b of islandBreaches(d.spec(), d.modules)) {
        const key = `${d.map}:${b.rule}`;
        if (!broken.has(key)) broken.set(key, `${d.label} seed ${d.seed}: ${b.text}`);
      }
    }
    const unexpected = [...broken].filter(([key]) => {
      const [map, rule] = key.split(':');
      return !PENDING[map]?.[rule as IslandRule];
    });
    expect(unexpected.map(([key, example]) => `${key} (${example})`)).toEqual([]);
    // (Some pending rules break in a few deals in a hundred, so only the full count can tell one now holds.)
    if (!FULL) return;
    const holding = Object.entries(PENDING).flatMap(([map, rules]) => Object.keys(rules).map((rule) => `${map}:${rule}`)).filter((key) => !broken.has(key));
    expect(holding, 'these pending rules now hold: take them out of PENDING').toEqual([]);
    // (The full tier deals tens of thousands of boards: give it time.)
  }, timeout(FULL ? 600_000 : 60_000));
});

describe('deals that once broke a rule', () => {
  it('keeps them all', () => {
    // A spare well that went unscored (seeds 2860796303, 2142745127, 1889289687), and a stuck
    // annealing that left two reds touching round the lake (seed 321).
    const cases: [number, 3 | 4, ModuleId[], string][] = [
      [2860796303, 3, ['sea', 'invasion', 'caravans', 'fisheries', 'oil'], 'archipelago'],
      [2142745127, 3, ['sea', 'invasion', 'caravans', 'fisheries', 'oil'], 'archipelago'],
      [1889289687, 3, ['sea', 'invasion', 'caravans', 'fisheries', 'oil'], 'archipelago'],
      [321, 4, ['invasion', 'rivers', 'fisheries'], 'classic'],
    ];
    for (const [seed, players, modules, map] of cases) expect(islandBreaches(dealBoard(players, { seed, modules, map }), modules), `seed ${seed}`).toEqual([]);
  });
});

it.skipIf(!env.ISLAND)('reports how often each rule breaks, and the soft figures, on each map', () => {
  const n = Number(env.N ?? 40);
  const all = deals(n, Number(env.SEED ?? 300));
  // (A rule a module brings is counted over the deals with that module.)
  const NEEDS: Partial<Record<IslandRule, ModuleId>> = { castle: 'invasion', desert: 'invasion', landings: 'invasion', rivers: 'rivers', oasis: 'caravans', lake: 'fisheries', grounds: 'fisheries', wells: 'oil' };
  const dealt = new Map<string, number>();
  const breaks = new Map<string, { count: number; example: string }>();
  const figures = new Map<string, IslandFigures[]>();
  for (const d of all) {
    const s = d.spec();
    for (const key of [d.map, ...d.modules.map((m) => `${d.map}+${m}`)]) dealt.set(key, (dealt.get(key) ?? 0) + 1);
    const seen = new Set<string>();
    for (const b of islandBreaches(s, d.modules)) {
      const key = `${d.map}:${b.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = breaks.get(key) ?? { count: 0, example: `${d.label} seed ${d.seed}: ${b.text}` };
      row.count++;
      breaks.set(key, row);
    }
    const f = islandFigures(s);
    figures.set(d.map, [...(figures.get(d.map) ?? []), f]);
  }
  const lines = [`ISLAND ${all.length} deals, ${n} a mix`, '', 'Breaks (share of the deals the rule applies to):'];
  for (const [key, { count, example }] of [...breaks].sort()) {
    const [map, rule] = key.split(':');
    const over = NEEDS[rule as IslandRule] ? `${map}+${NEEDS[rule as IslandRule]}` : map;
    lines.push(`  ${key.padEnd(24)} ${((100 * count) / dealt.get(over)!).toFixed(1).padStart(5)}% of ${String(dealt.get(over)).padStart(5)}   e.g. ${example}`);
  }
  lines.push('', 'Figures (mean, p10, p50, p90, max):');
  for (const [map, fs] of figures) {
    lines.push(`  ${map} (${fs.length} deals)`);
    for (const name of Object.keys(fs[0]) as (keyof IslandFigures)[]) {
      const xs = fs.map((f) => f[name]).sort((a, b) => a - b);
      const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
      const mean = xs.reduce((t, x) => t + x, 0) / xs.length;
      lines.push(`    ${name.padEnd(10)} ${[mean, q(0.1), q(0.5), q(0.9), xs[xs.length - 1]].map((x) => x.toFixed(2).padStart(7)).join('')}`);
    }
  }
  console.log(lines.join('\n'));
}, timeout(3_600_000));
