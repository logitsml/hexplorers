// The raider fleet at the table and each seat's points by where they come from: the fleet's page
// (strength against defence, and what a landing would do, by the engine's own `landing`), the
// player cards' badges for the awards that change hands, and the points tooltip's parts
// (game/points.ts), which must add up to the engine's total in every recorded game.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createGame, mustApply, victoryBreakdown, type GameState } from '../src/engine';
import { FLEET_STEPS, landing } from '../src/engine/modules/fleet';
import { newWardenId } from '../src/engine/modules/shared';
import { pointParts } from '../src/game/points';
import { useUI } from '../src/game/store';
import { Fleet } from '../src/ui/modules/FleetPage';
import { marksOf } from '../src/ui/modules/standings';
import { game } from './modules/guilds-helpers';
import { patch, toMain } from './helpers';
import { setups } from './sim-harness';
import type { Fixture } from './golden-modules';

vi.mock('../src/game/store', async (original) => {
  const actual = await original<typeof import('../src/game/store')>();
  const use = Object.assign(<T,>(select: (s: ReturnType<typeof actual.useUI.getState>) => T) => select(actual.useUI.getState()), actual.useUI);
  return { ...actual, useUI: use };
});
vi.mock('../src/app/session', () => ({ session: {} }));
vi.mock('../src/audio/sfx', () => ({ sfx: { play: vi.fn() } }));

const FILES = import.meta.glob('./fixtures/golden-modules/*.json', { eager: true, import: 'default' }) as Record<string, Fixture>;

beforeEach(() => useUI.getState().set({ view: null, me: 0, replay: null }));

describe('each seat’s points by where they come from', () => {
  it('add up to the engine’s count beyond buildings’ face value and the base awards, all through every recorded game', () => {
    const seen = new Set<string>();
    for (const f of Object.values(FILES)) {
      let s = createGame(setups(f.players), f.options, f.secret).state;
      for (const [i, [actor, action]] of f.log.entries()) {
        s = mustApply(s, actor, action).state;
        if (i % 20 !== 0 && i !== f.log.length - 1) continue;
        for (const p of s.players) {
          const b = victoryBreakdown(s, p.id);
          const parts = pointParts(s, p.id);
          for (const x of parts) seen.add(x.key);
          expect(parts.reduce((t, x) => t + x.n, 0), `${f.id} at action ${i + 1}, seat ${p.id}`).toBe(b.buildingExtra + b.modules);
        }
      }
    }
    // (Each a name of its own, never a module's leftover.)
    for (const k of ['guilds-buildings', 'ventures', 'harbourmaster', 'richest', 'pauper', 'prisoners', 'landings', 'sequestered']) expect(seen, k).toContain(k);
    expect([...seen].filter((k) => !k.includes('-') && !['ventures', 'trader', 'defence', 'harbourmaster', 'prisoners', 'landings', 'richest', 'pauper', 'sequestered', 'steward'].includes(k))).toEqual([]);
  }, 120_000);
});

describe('a landing, reckoned before it comes', () => {
  it('is what every recorded attack did', () => {
    let attacks = 0;
    for (const f of Object.values(FILES).filter((x) => x.options.modules?.includes('fleet'))) {
      let s = createGame(setups(f.players), f.options, f.secret).state;
      for (const [actor, action] of f.log) {
        const before = s;
        const r = mustApply(s, actor, action);
        s = r.state;
        const e = r.events.find((x) => x.type === 'fleet/attack');
        if (!e || e.type !== 'fleet/attack') continue;
        attacks++;
        // (The roll's own production changes no city and no warden: the island before it is the island it lands on.)
        const l = landing(before);
        expect({ strength: l.strength, defence: l.defence, contributions: l.contributions, won: l.won }).toEqual({ strength: e.strength, defence: e.defence, contributions: e.contributions, won: e.won });
        const token = r.events.find((x) => x.type === 'fleet/token');
        expect(token && token.type === 'fleet/token' ? token.player : null).toBe(l.token);
        const lost = new Set([...r.events.flatMap((x) => (x.type === 'fleet/pillaged' ? [x.player] : [])), ...s.pending.filter((p) => p.kind === 'fleet/pillage').flatMap((p) => p.players)]);
        expect([...lost].sort()).toEqual([...l.losers].sort());
      }
    }
    expect(attacks).toBeGreaterThan(0);
  });
});

/** A full-set game in seat 0's main phase, the fleet `position` steps out, with these wardens mustered. */
function fleetGame(position: number, wardens: [owner: number, rank: 1 | 2 | 3][]): GameState {
  return patch(game(['guilds', 'garrisons', 'fleet']), (x) => {
    toMain(x, 0);
    x.ext.fleet!.position = position;
    const spots = x.board.vertices.map((v) => v.id).filter((v) => !x.buildings[v] && x.board.vertices[v].hexes.length === 3);
    for (const [owner, rank] of wardens) x.wardens.push({ id: newWardenId(x), owner, rank, mustered: true, vertex: spots.shift()!, edge: null, musteredTurn: 0 });
  });
}

describe('the fleet’s page', () => {
  it('sets strength against defence and names who defends least, a ship from the island', () => {
    const s = fleetGame(FLEET_STEPS - 1, [[1, 2]]);
    const l = landing(s);
    expect(l.won).toBe(false);
    useUI.getState().set({ view: s });
    const html = renderToStaticMarkup(createElement(Fleet));
    expect(html).toContain(`At sea · ${FLEET_STEPS - 1} of ${FLEET_STEPS}`);
    expect(html).toContain('The next ship on the event die brings it to the island.');
    expect(html).toContain(`Fleet strength ${l.strength} against defence 2`);
    expect(html).toContain('fp-versus short near');
    expect(html).toContain(`Falling short by ${l.strength - 2}:`);
    expect(html).toContain('defend least, and would lose a town each');
  });

  it('names the best defender when the defence holds', () => {
    const s = fleetGame(2, [[2, 3], [2, 3], [1, 1]]);
    const l = landing(s);
    expect(l).toMatchObject({ won: true, token: 2 });
    useUI.getState().set({ view: s });
    const html = renderToStaticMarkup(createElement(Fleet));
    expect(html).toContain(`${s.players[2].name} defends most, and would take a defence token`);
    expect(html).toContain('5 more ships on the event die');
    expect(html).not.toContain('near');
  });
});

describe('the awards that change hands, on the player cards', () => {
  it('badge a guild seat, the trader and the Port Captain', () => {
    const s = patch(game(['guilds', 'garrisons', 'fleet', 'harbourmaster']), (x) => {
      const v = x.buildings.findIndex((b) => b?.owner === 1 && b.kind === 'city');
      x.buildings[v]!.seat = 'learning';
      x.ext.guilds!.trader = { hex: 0, owner: 1 };
      x.ext.harbourmaster!.holder = 1;
    });
    expect(marksOf(s, 1).map((m) => m.text)).toEqual(['Port Captain +2', 'Learning seat +2', 'Trader +1']);
    expect(marksOf(s, 0)).toEqual([]);
    expect(pointParts(s, 1).map((x) => x.words)).toEqual(expect.arrayContaining(['1 guild seat', 'the Trader', 'Port Captain']));
  });
});
