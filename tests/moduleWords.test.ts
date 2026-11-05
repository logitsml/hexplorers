// Exercise the public interface's words over real games, including every option offered at a
// sampled decision. This catches payload shapes that a hand-written description fixture misses.
import { describe as suite, expect } from 'vitest';
import { applyAction, createGame, type GameState } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { mixOf, type Expansion } from '../src/engine/presets';
import { describe, moduleActions } from '../src/game/moduleActions';
import { DECISION_KINDS, decisionText } from '../src/game/decisions';
import { setups } from './sim-harness';
import { slow, timeout } from './tier';

const mixes: Expansion[][] = [
  ['sea', 'guilds', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster'],
  ['guilds', 'rivers'],
  ['sea', 'fisheries', 'almanac'],
  ['invasion'],
];

suite('module choices in bot games', () => {
  slow('names pieces, outcomes and payments without bare ids or missing values', () => {
    const kinds = new Set<string>();
    const decisions = new Set<string>();
    let labels = 0;
    for (const ex of mixes) {
      const mix = mixOf(ex);
      let s: GameState = createGame(setups(4), { seed: 31, modules: mix.modules, map: mix.map, knobs: mix.knobs, victoryPoints: mix.target }).state;
      s.players.forEach((p, i) => { p.name = ['Ada', 'Bram', 'Cora', 'Dara'][i]; });
      const memory = s.players.map(() => createBotMemory());
      for (let step = 0; s.phase !== 'gameOver' && step < 4000; step++) {
        const top = s.pending.at(-1);
        if (top) {
          expect(DECISION_KINDS, top.kind).toContain(top.kind);
          const text = decisionText(s, top.players[0], top);
          expect(text, top.kind).not.toMatch(/null|undefined|\bP\d+\b/);
          decisions.add(top.kind);
        }
        let acted = false;
        for (let p = 0; p < 4 && !acted; p++) {
          const action = botDecide(s, p, memory[p], 'normal');
          if (!action) continue;
          // All choices at a decision are important; optional moves are sampled along the game.
          if (top || step % 7 === 0) {
            for (const a of moduleActions(s, p)) {
              const label = describe(s, a);
              expect(label, `${a.type}: ${JSON.stringify(a)}`).not.toMatch(/null|undefined|\bP\d+\b|^\s*\d+\s*$|\b(?:warden|from|to|hex|edge|vertex) \d+\b/);
              expect(label.length).toBeGreaterThan(3);
              kinds.add(a.type);
              labels++;
            }
          }
          const next = applyAction(s, p, action);
          if (!next.ok) throw new Error(next.error);
          s = next.state;
          acted = true;
        }
        if (!acted) throw new Error(`No action at ${s.phase}: ${JSON.stringify(top)}`);
      }
      expect(s.phase, ex.join(',')).toBe('gameOver');
    }
    expect(kinds.size).toBeGreaterThan(30);
    expect(decisions.size).toBeGreaterThan(10);
    expect(labels).toBeGreaterThan(1000);
  }, timeout(120000));
});
