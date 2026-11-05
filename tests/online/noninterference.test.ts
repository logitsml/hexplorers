// Noninterference (protocol-security.md §3.4, adapted from proto/audit.ts): two server states that
// differ only in what a viewer may not know (other seats' cards and their mix, their development
// cards, the decks' order, fish values, ventures, the fog's pool, the game's key) must look the
// same to that viewer, byte for byte: their wire views (static), and the events, action and next
// view of the same move made in each (dynamic).

import { describe, expect, it } from 'vitest';
import { Rng, applyAction, trackedKinds, type GameState, type PlayerId } from '../../src/engine';
import { clonePlain, cloneState } from '../../src/engine/reducer';
import { actionFor, eventsFor, type Viewer } from '../../src/engine/visibility';
import { canonical, wireView } from '../../src/engine/wire';
import { ALL_HANDS_OPTIONS, keyed, playGame, testKey, type Game } from './play';

/**
 * `s0` with what `v` can't know changed (each hand keeping its size, each deck its cards): 'hands'
 * the other seats' cards and the development deck, 'all' every deck and module secret too; `key`
 * the game's key.
 */
function perturb(s0: GameState, v: Viewer, rng: Rng, which: 'all' | 'hands', key = which === 'all'): GameState {
  const s = cloneState(s0);
  s.ext = clonePlain(s.ext);
  s.pending = clonePlain(s.pending);
  const others = s.players.map((p) => p.id).filter((p) => p !== v);
  const kinds = trackedKinds(s);
  // One card of each of two kinds swapped between two other seats.
  for (let tries = 0; tries < 20 && others.length >= 2; tries++) {
    const x = others[rng.int(others.length)];
    const y = others[rng.int(others.length)];
    if (x === y) continue;
    const kx = kinds.filter((k) => s.players[x].hand[k] > 0);
    const ky = kinds.filter((k) => s.players[y].hand[k] > 0);
    if (!kx.length || !ky.length) continue;
    const a = kx[rng.int(kx.length)];
    const b = ky[rng.int(ky.length)];
    if (a === b) continue;
    s.players[x].hand[a]--;
    s.players[x].hand[b]++;
    s.players[y].hand[b]--;
    s.players[y].hand[a]++;
    break;
  }
  // Unplayed development cards: their kinds dealt round the other seats again, and each one bought
  // before this turn bought on another such turn.
  const pool = others.flatMap((p) => s.players[p].devCards.map((c) => c.type));
  rng.shuffle(pool);
  for (const p of others) {
    for (const c of s.players[p].devCards) {
      c.type = pool.shift()!;
      if (c.boughtTurn < s.turn) c.boughtTurn = rng.int(Math.max(1, s.turn));
    }
    rng.shuffle(s.players[p].devCards);
  }
  rng.shuffle(s.devDeck);
  if (key && s.rngKey) s.rngKey = testKey(rng.int(1e9));
  if (which === 'hands') return s;
  if (s.eventCards) rng.shuffle(s.eventCards);
  const g = s.ext.guilds;
  if (g) {
    const vent = others.flatMap((p) => g.hands[p]);
    rng.shuffle(vent);
    for (const p of others) g.hands[p] = g.hands[p].map(() => vent.shift()!);
    for (const t of Object.keys(g.decks) as (keyof typeof g.decks)[]) rng.shuffle(g.decks[t]);
  }
  const f = s.ext.fisheries;
  if (f) {
    const tok = others.flatMap((p) => f.tokens[p]);
    rng.shuffle(tok);
    for (const p of others) f.tokens[p] = f.tokens[p].map(() => tok.shift()!);
    rng.shuffle(f.supply);
  }
  const al = s.ext.almanac;
  if (al) {
    // (The new year keeps its place: where it lies is public.)
    const rest = rng.shuffle(al.deck.filter((c) => c !== 36));
    al.deck = al.deck.map((c) => (c === 36 ? c : rest.shift()!));
  }
  if (s.ext.invasion) rng.shuffle(s.ext.invasion.deck);
  if (s.ext.sea?.fog) rng.shuffle(s.ext.sea.fog.pool);
  return s;
}

/** A view as compared: whether volunteered trade commitments still hold is shown by design (R9). */
function seen(s: GameState, v: Viewer): string {
  const w = wireView(s, v);
  if (w.trade) w.trade = { ...w.trade, readiness: undefined };
  return canonical(w);
}

/** Moves whose outcome shows holdings by rule: a monopoly's takings, and the guilds' market cards. */
const reveals = (a: { type: string; card?: string }) => a.type === 'playMonopoly' || (a.type === 'guilds/play' && ['cornerMarket', 'cartel', 'barter'].includes(a.card!)) || a.type === 'guilds/offer';

interface Audit {
  staticChecks: number;
  dynamicChecks: number;
  revealsByRule: number;
  leaks: string[];
}

function audit(g: Game, every: number): Audit {
  const rng = new Rng(12345);
  const viewers: Viewer[] = [...g.initial.players.map((p) => p.id), null];
  const out: Audit = { staticChecks: 0, dynamicChecks: 0, revealsByRule: 0, leaks: [] };
  g.steps.forEach((st, i) => {
    if (i % every) return;
    for (const v of viewers) {
      // Static: the view doesn't depend on what v can't know.
      const other = perturb(st.before, v, rng, 'all');
      out.staticChecks++;
      if (seen(st.before, v) !== seen(other, v)) out.leaks.push(`static seq ${st.before.seq} viewer ${v} (${st.before.phase})`);
      // Dynamic: the same move in both worlds, as v is told of it. (Not the decks' order, which
      // decides what v draws from them, theirs to see: a fish, a venture. Nor, for a move that
      // draws, the key, which decides what the dice show everyone.)
      if (v === st.actor) continue;
      const twin = perturb(st.before, v, rng, 'hands', st.state.rngState === st.before.rngState);
      const r1 = applyAction(st.before, st.actor, st.action);
      const r2 = applyAction(twin, st.actor, st.action);
      if (!r1.ok || !r2.ok) continue;
      out.dynamicChecks++;
      const differs =
        canonical(eventsFor(r1.events, v)) !== canonical(eventsFor(r2.events, v)) ||
        canonical(actionFor(st.action, st.actor, v)) !== canonical(actionFor(st.action, st.actor, v as PlayerId)) ||
        seen(r1.state, v) !== seen(r2.state, v);
      if (!differs) continue;
      // (A move that ends the game shows the winner's points, hidden ones too: only one world may end.)
      if (reveals(st.action as { type: string; card?: string }) || r1.state.phase === 'gameOver' || r2.state.phase === 'gameOver') out.revealsByRule++;
      else out.leaks.push(`dynamic seq ${st.before.seq} viewer ${v}: ${st.action.type} by ${st.actor}`);
    }
  });
  return out;
}

describe('noninterference', () => {
  it('holds in Base games: no view, event or action depends on another seat’s secrets', () => {
    for (const seed of [101, 202]) {
      const a = audit(playGame(`base ${seed}`, seed, keyed(seed).options, keyed(seed).secret), 2);
      console.log(`base ${seed}: ${a.staticChecks} static, ${a.dynamicChecks} dynamic checks, ${a.revealsByRule} public reveals by rule`);
      expect(a.leaks).toEqual([]);
      expect(a.dynamicChecks).toBeGreaterThan(300);
    }
  }, 1_800_000);

  it('holds in All Hands, every module’s secrets with it', () => {
    const a = audit(playGame('all hands', 4400, keyed(4400, ALL_HANDS_OPTIONS).options, keyed(4400).secret), 4);
    console.log(`all hands: ${a.staticChecks} static, ${a.dynamicChecks} dynamic checks, ${a.revealsByRule} public reveals by rule`);
    expect(a.leaks).toEqual([]);
    expect(a.dynamicChecks).toBeGreaterThan(500);
  }, 1_800_000);

  it('is what the playing of a development card needed: which purchase went no longer shows', () => {
    // (The leak the audit found: a knight played took the first matching card, and the others'
    // purchase turns stayed in the view, so the one that vanished said which was played.)
    const g = playGame('knights', 304, keyed(304).options, keyed(304).secret);
    const plays = g.steps.filter((s) => s.action.type === 'playKnight' || s.action.type === 'playRoadBuilding' || s.action.type === 'playMonopoly');
    expect(plays.length).toBeGreaterThan(0);
    for (const st of plays) {
      for (const v of [0, 1, 2, 3].filter((p) => p !== st.actor)) {
        const cards = wireView(st.state, v).players[st.actor].devCards;
        expect(cards.every((c) => c.type === 'knight' && (c.boughtTurn === 0 || c.boughtTurn === st.state.turn))).toBe(true);
        expect(cards.map((c) => c.boughtTurn)).toEqual([...cards.map((c) => c.boughtTurn)].sort((x, y) => x - y));
      }
    }
  }, 1_800_000);
});
