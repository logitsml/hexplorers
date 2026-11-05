import { describe, expect, it } from 'vitest';
import { createGame, emptyCards, type Pending } from '../src/engine';
import { DECISION_KINDS, decisionText, decisionTitle, type DecisionData } from '../src/game/decisions';
import { humanize } from '../src/game/moduleActions';
import { decisionNews } from '../src/ui/modules/news';
import { game } from './modules/guilds-helpers';
import { FOUR } from './helpers';
import { BLOCKER } from '../src/engine/modules/sea/handle';
import { BOUNTY_PICK } from '../src/engine/modules/sea/bounty';
import { BID, VOTE, PLACE } from '../src/engine/modules/caravans/auction';

/** One payload of every kind, checked against the module's own pending-data types. */
const SAMPLES: DecisionData = {
  'sea/blocker': { cause: 'seven', robber: true, victims: 'ships' },
  'sea/bountyPick': { count: 2, reason: 'production' },
  'garrisons/retreat': { kind: 'garrisons/retreat', warden: 0, from: 1 },
  'invasion/retreat': { warden: 0, from: 1 },
  'invasion/march': { acted: [] },
  'invasion/card': { card: 'levy' },
  'fleet/pillage': { cities: [1] },
  'fisheries/swap': undefined,
  'caravans/bid': undefined, 'caravans/vote': undefined, 'caravans/place': undefined,
  'guilds/ventureLimit': { kind: 'guilds/ventureLimit' },
  'guilds/give': { kind: 'guilds/give', to: 1, left: 2, only: 'commodities', reason: 'barter' },
  'guilds/discard': { kind: 'guilds/discard', left: 3 },
  'guilds/tribute': { kind: 'guilds/tribute', target: 1, left: 2, seen: emptyCards() },
  'guilds/spy': { kind: 'guilds/spy', target: 1, seen: ['barter'] },
  'guilds/pick': { kind: 'guilds/pick' },
  'guilds/drawChoice': { kind: 'guilds/drawChoice' },
  'guilds/barter': { kind: 'guilds/barter', queue: [1, 2] },
  'guilds/rebuild': { kind: 'guilds/rebuild', ship: true },
  'guilds/surrender': { kind: 'guilds/surrender', thief: 1 },
  'guilds/plant': { kind: 'guilds/plant', rank: 2, mustered: true, edge: null },
  'almanac/quake': { happening: 'quake' },
  'almanac/take': { happening: 'harvest' },
  'almanac/gift': { happening: 'helpingHand', recipients: [1, 2] },
  'almanac/rob': { happening: 'windfall', victims: [1, 2] },
};

const sources = import.meta.glob('../src/engine/modules/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('expansion decisions in words', () => {
  const s = createGame(FOUR, { seed: 7 }).state;
  s.players.forEach((p, i) => { p.name = ['Ada', 'Bram', 'Cora', 'Dara'][i]; });

  it('covers every literal pending kind declared by a module, and the exported stack-kind constants', () => {
    const kinds = [...Object.values(sources).join('\n').matchAll(/kind:\s*'([a-z]+\/[a-zA-Z]+)'/g)].map((m) => m[1]);
    const almanac = [...Object.values(sources).join('\n').match(/export type AlmanacPendingKind = ([^;]+);/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...new Set([...kinds, ...almanac, BLOCKER, BOUNTY_PICK, BID, VOTE, PLACE])].sort()).toEqual([...DECISION_KINDS].sort());
    expect(Object.keys(SAMPLES).sort()).toEqual([...DECISION_KINDS].sort());
  });

  it('tells every owed decision in a sentence and reads it out, including generic panels', () => {
    for (const [kind, data] of Object.entries(SAMPLES)) {
      const pending = { kind, data, players: [0] };
      const text = decisionText(s, 0, pending);
      expect(text, kind).not.toMatch(/undefined|null|\bP\d+\b|expansion’s decision/);
      expect(text.split(/\s+/).length, kind).toBeGreaterThan(7);
      expect(decisionNews({ ...s, pending: [pending] }, 0)?.text).toBe(text);
      expect(decisionNews({ ...s, pending: [pending] }, 1)).toBeNull();
    }
  });

  it('heads every decision with a title of its own, never the engine’s name for it', () => {
    for (const [kind, data] of Object.entries(SAMPLES)) {
      const title = decisionTitle(s, { kind, data, players: [0] });
      expect(title, kind).not.toMatch(/undefined|null|\//);
      expect(title, kind).toMatch(/^[A-Z]/);
      expect(title.length, kind).toBeLessThan(32);
      // (A barter's heading is the venture's own name, which the engine's happens to share.)
      if (kind !== 'guilds/barter') expect(title, kind).not.toBe(humanize(kind));
    }
  });

  it('names recipients and remaining quantities, including the next card of the same decision', () => {
    const data = SAMPLES['guilds/give'];
    const p: Pending = { kind: data.kind, players: [0], data };
    expect(decisionText(s, 0, p)).toContain('2 commodities to Bram');
    expect(decisionText(s, 0, { ...p, data: { ...data, left: 1 } })).toContain('1 commodity to Bram');
    expect(decisionNews({ ...s, pending: [p] }, 0)?.key).not.toBe(decisionNews({ ...s, pending: [{ ...p, data: { ...data, left: 1 } }] }, 0)?.key);
    expect(decisionText(s, 0, { kind: 'sea/bountyPick', players: [0], data: { count: 2, reason: 'fog' } })).toContain('2 resources');
  });

  it('explains why marching cannot finish while a recruit must leave the castle', () => {
    const s = game(['invasion']);
    const castle = s.board.hexes.find((h) => h.terrain === 'castle')!;
    s.wardens = [{ id: 7, owner: 0, rank: 1, edge: castle.edges[0], vertex: null, mustered: true, musteredTurn: 0 }];
    const pending: Pending = { kind: 'invasion/march', players: [0], data: { acted: [] } };
    expect(decisionText(s, 0, pending)).toContain('1 warden off the castle edges');
    expect(decisionText(s, 0, pending)).not.toContain('finish marching');
    expect(decisionText(s, 0, { ...pending, data: { acted: [7] } })).toContain('finish marching');
  });

  it('words a displaced warden once, and calls your own one yours', () => {
    const s = game(['invasion']);
    s.wardens = [{ id: 7, owner: 0, rank: 1, edge: null, vertex: null, mustered: false, musteredTurn: 0 }];
    const pending: Pending = { kind: 'invasion/retreat', players: [0], data: { warden: 7, from: 1 } };
    const mine = decisionText(s, 0, pending);
    expect(mine).toMatch(/^Your recruit was displaced/);
    expect(mine).not.toMatch(/retreat to retreat|waiting to retreat/);
    const theirs = decisionText(s, 1, pending);
    expect(theirs).toContain(`${s.players[0].name}’s recruit`);
  });

  it('explains each muster card and offers a ransom only when it is affordable', () => {
    for (const [card, ask] of [['levy', 'castle'], ['outrider', 'empty edge'], ['ambush', 'prisoner'], ['turncoat', 'two raiders']]) {
      expect(decisionText(s, 0, { kind: 'invasion/card', players: [0], data: { card } })).toContain(ask);
    }
    const rivers = game(['guilds', 'garrisons', 'fleet', 'rivers']);
    const p: Pending = { kind: 'fleet/pillage', players: [0], data: { cities: [1] } };
    rivers.players[0].coins = 5;
    expect(decisionText(rivers, 0, p)).toContain('pay 5 coins');
    rivers.players[0].coins = 4;
    expect(decisionText(rivers, 0, p)).not.toContain('pay 5 coins');
  });
});
