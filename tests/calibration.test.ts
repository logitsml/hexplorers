// Calibration playtests for All Hands (docs/all-hands.md, decision 3): bot games across landing
// rates and targets, measuring length, how much of the coast the raiders hold, how often a player
// loses two buildings at once, the winner's lead and wins by seat. Skipped in the usual run:
//
//   CALIBRATE=1 N=60 npx vitest run tests/calibration.test.ts --silent=false
//   (HARD=1: hard bots in every seat; ONLY=1: just the current rate and the draft's)

import { it } from 'vitest';
import { applyAction, createGame, hiddenVictoryPoints, isLand, totalVictoryPoints, type GameState, type Knobs } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { buildingConquered } from '../src/engine/modules/shared';
import { modulesOf } from '../src/engine/modules';
import type { BoardSpec } from '../src/engine/board';
import { ALL_HANDS, EXPANSIONS, PRESETS, mixOf, modulesFor, type Expansion } from '../src/engine/presets';
import { newGame, setups } from './sim-harness';
import { timeout } from './tier';

const preset = PRESETS[0];
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
// (SPEC='{...}' plays a board spec in the All Hands map's place, in every mode below, carried as
// every game's board: for trying a layout before writing it down.)
const board: { board?: BoardSpec } = env.SPEC ? { board: JSON.parse(env.SPEC) as BoardSpec } : {};
const ALL_HARD = !!env.HARD;
const CONFIGS: [string, Partial<Knobs>, number][] = env.ONLY ? [['L1 imp 21', { landingsPerBuilding: 1, improvementLandings: true }, 21], ['L1 noImp 21', { landingsPerBuilding: 1, improvementLandings: false }, 21]] : [
  ['L1 noImp 21', { landingsPerBuilding: 1, improvementLandings: false }, 21],
  ['L1 imp 21', { landingsPerBuilding: 1, improvementLandings: true }, 21],
  ['L2 noImp 21', { landingsPerBuilding: 2, improvementLandings: false }, 21],
  ['L2 imp 21', { landingsPerBuilding: 2, improvementLandings: true }, 21],
  ['L3 imp 21', { landingsPerBuilding: 3, improvementLandings: true }, 21],
  ['L1 noImp 23', { landingsPerBuilding: 1, improvementLandings: false }, 23],
  ['L1 noImp 25', { landingsPerBuilding: 1, improvementLandings: false }, 25],
  ['L2 noImp 23', { landingsPerBuilding: 2, improvementLandings: false }, 23],
];
it.skipIf(!env.CALIBRATE)('sweeps the landing rate and target', () => {
  const N = Number(env.N ?? 24);
  for (const [name, knobs, target] of CONFIGS) {
    const options = { modules: modulesFor(ALL_HANDS), map: 'allHands', knobs: { ...preset.knobs, ...knobs }, victoryPoints: target, ...board };
    const seatWins: number[][] = [[0, 0, 0], [0, 0, 0, 0]];
    let crippled = 0;
    const agg: Record<string, number> = {};
    const add = (k: string, v = 1) => (agg[k] = (agg[k] ?? 0) + v);
    for (let g = 0; g < N; g++) {
      const n = g % 2 ? 3 : 4;
      let s: GameState = createGame(setups(n), newGame(n, { ...options, seed: 9100 + g })).state;
      const mem = s.players.map(() => createBotMemory());
      const diffs = ALL_HARD ? (['hard', 'hard', 'hard', 'hard'] as const) : (['normal', 'hard', 'easy', 'normal'] as const);
      let steps = 0, lastTurn = -1, conqTurns = 0, conqSum = 0, maxConq = 0, lostBldTurns = 0, worstHit = 0;
      while (s.phase !== 'gameOver' && steps < 40000) {
        let acted = false;
        for (let p = 0; p < n && !acted; p++) {
          const a = botDecide(s, p, mem[p], diffs[p]);
          if (!a) continue;
          const r = applyAction(s, p, a);
          if (!r.ok) throw new Error(r.error);
          s = r.state;
          acted = true;
          steps++;
        }
        if (!acted) break;
        if (s.turn !== lastTurn) {
          lastTurn = s.turn;
          const c = s.ext.invasion!.raiders.filter((x) => x >= 3).length;
          conqSum += c;
          conqTurns++;
          maxConq = Math.max(maxConq, c);
          lostBldTurns += s.buildings.filter((b, v) => b && buildingConquered(s, v)).length;
          for (let p = 0; p < n; p++) worstHit = Math.max(worstHit, s.buildings.filter((b, v) => b?.owner === p && buildingConquered(s, v)).length);
        }
      }
      add('turns', s.turn);
      if (s.winner === null) add('noWinner');
      add('avgConquered', conqSum / Math.max(1, conqTurns));
      add('maxConquered', maxConq);
      add('avgBuildingsConquered', lostBldTurns / Math.max(1, conqTurns));
      add('prisoners', s.ext.invasion!.prisoners.reduce((a, b) => a + b, 0));
      if (s.winner !== null) add('winnerVp', totalVictoryPoints(s, s.winner));
      add('runnerUpVp', Math.max(...s.players.filter((p) => p.id !== s.winner).map((p) => totalVictoryPoints(s, p.id))));
      if (worstHit >= 2) crippled++;
      if (s.winner !== null) seatWins[n === 3 ? 0 : 1][s.winner]++;
    }
    console.log('SWEEP', name.padEnd(12), JSON.stringify({ ...Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, k === 'noWinner' ? v : +(v / N).toFixed(2)])), crippledShare: +(crippled / N).toFixed(2), seats3: seatWins[0].join('/'), seats4: seatWins[1].join('/') }));
  }
}, timeout(3600000));

// A profile of each preset and each expansion alone, for reviewing the rules against play: length,
// wins by seat, where the winner's points come from, and how often each action and event happens.
//
//   PROFILE=1 N=30 npx vitest run tests/calibration.test.ts --silent=false   (HARD=1 as above; MIX=allHands,siege to pick;
//   TARGET=13 and KNOBS='{"landingsPerBuilding":2}' to try a target or knobs over each mix's own)
it.skipIf(!env.PROFILE)('profiles the presets and the expansions alone', () => {
  const N = Number(env.N ?? 24);
  const mixes: [string, Expansion[]][] = [
    ['base', []],
    ...PRESETS.map((p) => [p.id, p.expansions] as [string, Expansion[]]),
    ...EXPANSIONS.map((e) => [e.id, [e.id]] as [string, Expansion[]]),
  ];
  const wanted = env.MIX?.split(',');
  for (const [name, expansions] of mixes) {
    if (wanted && !wanted.includes(name)) continue;
    const mix = mixOf(expansions);
    const knobs = { ...mix.knobs, ...(env.KNOBS ? (JSON.parse(env.KNOBS) as Knobs) : {}) };
    const target = env.TARGET ? Number(env.TARGET) : mix.target;
    const options = { modules: mix.modules, map: mix.map === 'classic' ? undefined : mix.map, knobs, victoryPoints: target, ...(mix.map === 'allHands' ? board : {}) };
    const seatWins: number[][] = [[0, 0, 0], [0, 0, 0, 0]];
    const turns: number[] = [];
    const sources: Record<string, number> = {};
    const byRank: Record<string, number>[] = [];
    const events: Record<string, number> = {};
    const actions: Record<string, number> = {};
    const add = (o: Record<string, number>, k: string, v = 1) => (o[k] = (o[k] ?? 0) + v);
    let noWinner = 0, margin = 0;
    for (let g = 0; g < N; g++) {
      const n = g % 2 ? 3 : 4;
      let s: GameState = createGame(setups(n), newGame(n, { ...options, seed: 9300 + g })).state;
      const mem = s.players.map(() => createBotMemory());
      const diffs = ALL_HARD ? (['hard', 'hard', 'hard', 'hard'] as const) : (['normal', 'hard', 'easy', 'normal'] as const);
      let steps = 0;
      while (s.phase !== 'gameOver' && steps < 60000) {
        let acted = false;
        for (let p = 0; p < n && !acted; p++) {
          const a = botDecide(s, p, mem[p], diffs[p]);
          if (!a) continue;
          const r = applyAction(s, p, a);
          if (!r.ok) throw new Error(`${name}: ${r.error}`);
          if (s.phase !== 'setupSettlement' && s.phase !== 'setupRoad') add(actions, a.type);
          for (const e of r.events) add(events, e.type);
          s = r.state;
          acted = true;
          steps++;
        }
        if (!acted) break;
      }
      turns.push(s.turn);
      if (s.winner === null) {
        noWinner++;
        continue;
      }
      seatWins[n === 3 ? 0 : 1][s.winner]++;
      const w = s.winner;
      const vp = (p: number) => totalVictoryPoints(s, p);
      margin += vp(w) - Math.max(...s.players.filter((p) => p.id !== w).map((p) => vp(p.id)));
      // Every player's points by source, by where they finished (the winner first).
      const ranked = [w, ...s.players.map((p) => p.id).filter((p) => p !== w).sort((a, b) => vp(b) - vp(a))];
      ranked.forEach((p, rank) => {
        const into = rank === 0 ? sources : (byRank[rank] ??= {});
        // (Each building's worth, split by the module hook that changed it.)
        s.buildings.forEach((b, v) => {
          if (!b || b.owner !== p) return;
          let worth = b.kind === 'city' ? 2 : 1;
          add(into, b.kind === 'city' ? 'cities' : 'settlements', worth);
          for (const m of modulesOf(s)) {
            if (!m.hooks?.buildingWorth) continue;
            const next = m.hooks.buildingWorth(s, v, worth);
            if (next !== worth) add(into, `${m.id}:building`, next - worth);
            worth = next;
          }
        });
        if (s.longestRoadHolder === p) add(into, 'longestRoute', 2);
        if (s.largestArmyHolder === p) add(into, 'largestArmy', 2);
        add(into, 'victoryCards', hiddenVictoryPoints(s, p));
        for (const m of modulesOf(s)) if (m.hooks?.victoryPoints) add(into, `${m.id}:points`, m.hooks.victoryPoints(s, p));
        add(into, 'total', vp(p));
      });
    }
    turns.sort((a, b) => a - b);
    const won = N - noWinner;
    const per = (o: Record<string, number>, d: number) =>
      Object.fromEntries(Object.entries(o).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / d).toFixed(2)]));
    console.log('PROFILE', name, JSON.stringify({
      modules: mix.modules,
      target,
      knobs,
      games: N,
      turns: { mean: +(turns.reduce((a, b) => a + b, 0) / N).toFixed(1), p10: turns[Math.floor(N * 0.1)], p90: turns[Math.floor(N * 0.9)] },
      noWinner,
      seats3: seatWins[0].join('/'),
      seats4: seatWins[1].join('/'),
      winnerMargin: +(margin / Math.max(1, won)).toFixed(2),
      winnerPoints: per(sources, Math.max(1, won)),
      // (Third and fourth place count only the games that had them: every other game has three seats.)
      othersPoints: byRank.slice(1).map((o, rank) => per(o, Math.max(1, rank === 2 ? Math.ceil(won / 2) : won))),
      actionsPerGame: per(actions, N),
      eventsPerGame: per(events, N),
    }));
  }
}, timeout(7200000));

// Where players start against what they win, on All Hands: each player's best sail from their
// starting buildings to an islet (hex steps from a hex they touch to the nearest islet hex) and
// their nearest walk to the castle, then wins against a fair share, points, first landings and
// conquered buildings, by sail. For comparing maps: a fair map wins about 1.0 from every distance.
//
//   STARTS=1 N=120 npx vitest run tests/calibration.test.ts --silent=false   (HARD=1 and SPEC= as above;
//   SEED=n starts the games' seeds elsewhere, to check a result on fresh games)
it.skipIf(!env.STARTS)('measures where players start against what they win', () => {
  const N = Number(env.N ?? 60);
  const options = { modules: modulesFor(ALL_HANDS), map: 'allHands', knobs: preset.knobs, victoryPoints: preset.target, ...board };
  const rows: { sail: number; castle: number; fair: number; won: number; vp: number; landed: number; conquered: number; seat: string; spot: string }[] = [];
  const seatWins: number[][] = [[0, 0, 0], [0, 0, 0, 0]];
  let unfinished = 0;
  for (let g = 0; g < N; g++) {
    const n = g % 2 ? 3 : 4;
    let s: GameState = createGame(setups(n), newGame(n, { ...options, seed: Number(env.SEED ?? 9500) + g })).state;
    const mem = s.players.map(() => createBotMemory());
    const diffs = ALL_HARD ? (['hard', 'hard', 'hard', 'hard'] as const) : (['normal', 'hard', 'easy', 'normal'] as const);
    let starts: number[][] | null = null;
    let steps = 0;
    while (s.phase !== 'gameOver' && steps < 60000) {
      let acted = false;
      for (let p = 0; p < n && !acted; p++) {
        const a = botDecide(s, p, mem[p], diffs[p]);
        if (!a) continue;
        const r = applyAction(s, p, a);
        if (!r.ok) throw new Error(r.error);
        s = r.state;
        acted = true;
        steps++;
      }
      if (!acted) break;
      if (!starts && !s.phase.startsWith('setup')) starts = s.players.map((p) => s.buildings.flatMap((b, v) => (b?.owner === p.id ? [v] : [])));
    }
    // (A game that didn't finish would count as a loss for everyone: it's left out, and counted.)
    if (s.winner === null) {
      unfinished++;
      continue;
    }
    const b = s.board;
    const steps2 = (x: number, y: number) => {
      const [h, k] = [b.hexes[x], b.hexes[y]];
      return (Math.abs(h.q - k.q) + Math.abs(h.r - k.r) + Math.abs(h.q + h.r - k.q - k.r)) / 2;
    };
    const islets = b.islands.filter((i) => !i.home).flatMap((i) => i.hexes);
    const castle = b.features.castle!;
    seatWins[n === 3 ? 0 : 1][s.winner]++;
    // A start as the hexes its buildings touch, terrain and numbers (the settlement's, then the city's).
    const spot = (vs: number[]) => vs.map((v) => b.vertices[v].hexes.map((h) => b.hexes[h]).filter((h) => h.terrain !== 'sea' || h.numbers.length).map((h) => h.terrain.slice(0, 2) + h.numbers.join('/')).sort().join(' ')).join(' + ');
    const touched = (vs: number[]) => vs.flatMap((v) => b.vertices[v].hexes).filter((h) => isLand(b.hexes[h].terrain));
    s.players.forEach((p) => {
      const hexes = touched(starts![p.id]);
      rows.push({
        sail: Math.min(...hexes.flatMap((h) => islets.map((i) => steps2(h, i)))),
        castle: Math.min(...hexes.map((h) => steps2(h, castle))),
        fair: 1 / n,
        won: s.winner === p.id ? 1 : 0,
        vp: totalVictoryPoints(s, p.id),
        landed: s.ext.sea?.landed?.[p.id].length ?? 0,
        conquered: s.buildings.filter((x, v) => x?.owner === p.id && buildingConquered(s, v)).length,
        seat: `${n}:${p.id}`,
        spot: spot(starts![p.id]),
      });
    });
  }
  const report = (label: string, key: (r: (typeof rows)[number]) => number) => {
    const groups = new Map<number, typeof rows>();
    for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    for (const [k, rs] of [...groups].sort((a, b) => a[0] - b[0])) {
      const mean = (f: (r: (typeof rows)[number]) => number) => +(rs.reduce((t, r) => t + f(r), 0) / rs.length).toFixed(2);
      const wins = rs.reduce((t, r) => t + r.won, 0);
      console.log('STARTS', label, k, JSON.stringify({ players: rs.length, wins, winsOverFair: +(wins / rs.reduce((t, r) => t + r.fair, 0)).toFixed(2), vp: mean((r) => r.vp), landed: mean((r) => r.landed), conquered: mean((r) => r.conquered) }));
    }
  };
  report('sail', (r) => Math.min(r.sail, 5));
  report('castle', (r) => Math.min(r.castle, 4));
  console.log('STARTS seats', JSON.stringify({ seats3: seatWins[0].join('/'), seats4: seatWins[1].join('/'), unfinished }));
  // The commonest starts, with how often their player won against a fair share; and, over every
  // start, how far its wins stray from a fair share, weighted by players (0 is even).
  const spots = new Map<string, typeof rows>();
  for (const r of rows) spots.set(r.spot, [...(spots.get(r.spot) ?? []), r]);
  const ratio = (rs: typeof rows) => rs.reduce((t, r) => t + r.won, 0) / rs.reduce((t, r) => t + r.fair, 0);
  const uneven = [...spots.values()].reduce((t, rs) => t + rs.length * Math.abs(ratio(rs) - 1), 0) / Math.max(1, rows.length);
  console.log('STARTS uneven', JSON.stringify({ uneven: +uneven.toFixed(3), players: rows.length }));
  for (const [k, rs] of [...spots].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    console.log('STARTS spot', JSON.stringify({ players: rs.length, winsOverFair: +ratio(rs).toFixed(2), seats: [...new Set(rs.map((r) => r.seat))].join(','), spot: k }));
  }
}, timeout(7200000));
