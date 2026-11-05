// What the expansions' events say at the table (src/game/moduleEvents.ts): every event type has a
// line, the big moments have banners, and bot games across the mixes tell every event they raise
// without a gap or a stray "undefined".

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, emptyCards, type GameEvent, type GameState } from '../src/engine';
import { botDecide, createBotMemory } from '../src/engine/ai';
import { mixOf, type Expansion } from '../src/engine/presets';
import { TOLD_AFTER, tell, type TableEvent, type Teller, type Telling } from '../src/game/moduleEvents';
import { AWARD_ART } from '../src/game/names';
import { HAPPENINGS, happeningLine, happeningName } from '../src/game/tableWords';
import { setups } from './sim-harness';
import { slow, timeout } from './tier';

const allHands = mixOf(['sea', 'guilds', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster']);
const created: GameState = createGame(setups(4), { modules: allHands.modules, map: allHands.map, knobs: allHands.knobs, victoryPoints: allHands.target, seed: 7 }).state;
/** A game under way (set-up says some things more quietly). */
const s: GameState = { ...created, turn: 5 };

const land = s.board.hexes.find((h) => h.terrain !== 'sea' && h.numbers.length)!.id;
const sea = s.board.hexes.find((h) => h.terrain === 'sea')!.id;
const well = s.board.hexes.find((h) => h.well)?.id ?? land;
const edge = s.board.edges.find((e) => e.land)!.id;
const vertex = s.board.vertices.find((v) => v.land)!.id;
const islet = s.board.islands.findIndex((i) => !i.home);
const cards = (c: Partial<ReturnType<typeof emptyCards>>) => ({ ...emptyCards(), ...c });

/** One of each event the table tells (a type left out here fails to compile). */
const SAMPLES: { [K in TableEvent['type']]: Extract<TableEvent, { type: K }> } = {
  cardsMoved: { type: 'cardsMoved', from: 1, to: 0, cards: cards({ ore: 1 }), reason: 'tribute' },
  coins: { type: 'coins', player: 1, amount: 2, reason: 'bridge' },
  coinTraded: { type: 'coinTraded', player: 2, card: 'wheat', cards: 1, coins: 2, bought: true },
  gameLost: { type: 'gameLost', reason: 'The island is lost to pollution.' },

  'sea/shipBuilt': { type: 'sea/shipBuilt', player: 1, edge, free: false, setup: false },
  'sea/shipMoved': { type: 'sea/shipMoved', player: 1, from: edge, to: edge },
  'sea/corsairMoved': { type: 'sea/corsairMoved', player: 2, from: null, to: sea },
  'sea/bountyOwed': { type: 'sea/bountyOwed', owed: { 0: 1, 2: 2 }, reason: 'production' },
  'sea/bountyPicked': { type: 'sea/bountyPicked', player: 2, resources: ['ore', 'ore'], reason: 'production' },
  'sea/firstLanding': { type: 'sea/firstLanding', player: 1, island: islet, vertex, points: 2 },
  'sea/hexRevealed': { type: 'sea/hexRevealed', player: 1, hex: land, terrain: 'hills', number: 5, grant: 'brick' },

  'guilds/eventDie': { type: 'guilds/eventDie', player: 0, face: 'commerce', red: 4, independentRed: false },
  'guilds/drew': { type: 'guilds/drew', player: 1, track: 'learning', card: 'augury' },
  'guilds/shown': { type: 'guilds/shown', player: 1, card: 'grandCharter' },
  'guilds/improved': { type: 'guilds/improved', player: 1, track: 'statecraft', level: 3 },
  'guilds/seat': { type: 'guilds/seat', player: 1, track: 'learning', vertex, from: null, was: null, forGood: false },
  'guilds/played': { type: 'guilds/played', player: 3, card: 'barter' },
  'guilds/ventureDiscarded': { type: 'guilds/ventureDiscarded', player: 3, track: 'commerce' },
  'guilds/trader': { type: 'guilds/trader', player: 3, hex: land },
  'guilds/charter': { type: 'guilds/charter', player: 3, card: 'wool' },
  'guilds/lit': { type: 'guilds/lit', player: 3, hex: land },
  'guilds/numbersSwapped': { type: 'guilds/numbersSwapped', player: 3, hexes: [land, well] },
  'guilds/routeRemoved': { type: 'guilds/routeRemoved', player: 3, owner: 1, edge, kind: 'road' },
  'guilds/raiderCaptured': { type: 'guilds/raiderCaptured', player: 3, hex: land },
  'guilds/ventureTaken': { type: 'guilds/ventureTaken', thief: 3, victim: 0, card: 'tribute' },

  'garrisons/recruited': { type: 'garrisons/recruited', player: 1, warden: 0, vertex, edge: null },
  'garrisons/promoted': { type: 'garrisons/promoted', player: 1, warden: 0, rank: 2, free: false },
  'garrisons/mustered': { type: 'garrisons/mustered', player: 1, wardens: [0, 1], free: false },
  'garrisons/wall': { type: 'garrisons/wall', player: 1, vertex, free: false },
  'garrisons/marched': { type: 'garrisons/marched', player: 1, warden: 0, from: vertex, to: vertex },
  'garrisons/displaced': { type: 'garrisons/displaced', player: 1, warden: 0, target: 4, targetOwner: 2, from: vertex },
  'garrisons/retreated': { type: 'garrisons/retreated', player: 2, warden: 4, from: vertex, to: vertex },
  'garrisons/removed': { type: 'garrisons/removed', player: 2, warden: 4, reason: 'noRetreat' },
  'garrisons/chased': { type: 'garrisons/chased', player: 1, warden: 0, blocker: 'corsair', from: null, to: sea },
  'garrisons/placed': { type: 'garrisons/placed', player: 1, warden: 5, rank: 2, vertex, edge: null },

  'fleet/advanced': { type: 'fleet/advanced', position: 3, steps: 7 },
  'fleet/attack': { type: 'fleet/attack', strength: 5, defence: 3, contributions: [1, 2, 0, 0], won: false },
  'fleet/pillaged': { type: 'fleet/pillaged', player: 2, vertex, lying: false },
  'fleet/ransomed': { type: 'fleet/ransomed', player: 2 },
  'fleet/token': { type: 'fleet/token', player: 1 },
  'fleet/tied': { type: 'fleet/tied', players: [1, 2] },
  'fleet/blockersIn': { type: 'fleet/blockersIn', robber: land, corsair: sea },

  'invasion/landed': { type: 'invasion/landed', player: 0, cause: 'build', dice: [4, 5], number: 9, hex: land, raiders: 2 },
  'invasion/supplyEmpty': { type: 'invasion/supplyEmpty', player: 0 },
  'invasion/prisonersTraded': { type: 'invasion/prisonersTraded', player: 0 },
  'invasion/bought': { type: 'invasion/bought', player: 0 },
  'invasion/drew': { type: 'invasion/drew', player: 0, card: 'outrider', wasted: false },
  'invasion/wardenRaised': { type: 'invasion/wardenRaised', player: 0, warden: 0, edge, card: 'outrider' },
  'invasion/captured': { type: 'invasion/captured', player: 0, hex: land },
  'invasion/raidersLed': { type: 'invasion/raidersLed', player: 0, moves: [{ from: land, to: land }] },
  'invasion/marched': { type: 'invasion/marched', player: 0, warden: 0, from: edge, to: edge, paid: true },
  'invasion/displaced': { type: 'invasion/displaced', player: 0, warden: 0, victim: 1, victimOwner: 1, edge },
  'invasion/retreated': { type: 'invasion/retreated', player: 1, warden: 1, to: null },
  'invasion/halted': { type: 'invasion/halted', player: 0, marched: false },
  'invasion/battle': { type: 'invasion/battle', hex: land, raiders: 3, conquered: true, strength: 4, participants: [0, 2], prisoners: { 0: 2, 2: 1 }, coins: { 0: 3 }, rolls: [] },
  'invasion/losses': { type: 'invasion/losses', hex: land, die: 3, wardens: [{ warden: 0, owner: 0, rank: 2, to: 1 }, { warden: 1, owner: 2, rank: 1, to: null }] },

  'rivers/bridgeBuilt': { type: 'rivers/bridgeBuilt', player: 1, edge },
  'rivers/wealthChanged': { type: 'rivers/wealthChanged', richest: 1, paupers: [2], was: { richest: null, paupers: [2, 3] } },

  'caravans/auctionOpened': { type: 'caravans/auctionOpened', player: 1, placements: [edge] },
  'caravans/auctionSkipped': { type: 'caravans/auctionSkipped', player: 1, reason: 'nowhere' },
  'caravans/bid': { type: 'caravans/bid', player: 2, cards: cards({ wool: 1, wheat: 1 }), proposal: edge },
  'caravans/passed': { type: 'caravans/passed', player: 3 },
  'caravans/voted': { type: 'caravans/voted', player: 3, edge, votes: 2 },
  'caravans/toPlace': { type: 'caravans/toPlace', player: 2, choices: null, reason: 'majority' },
  'caravans/bidsPaid': { type: 'caravans/bidsPaid', bids: [{ player: 2, cards: cards({ wool: 1, wheat: 1 }) }] },
  'caravans/wagonPlaced': { type: 'caravans/wagonPlaced', edge, train: 0, joined: false, by: 2, left: 9 },

  'fisheries/drew': { type: 'fisheries/drew', player: 0, value: 2 },
  'fisheries/bootDrawn': { type: 'fisheries/bootDrawn', player: 1 },
  'fisheries/reshuffled': { type: 'fisheries/reshuffled', tokens: 12 },
  'fisheries/supplyEmpty': { type: 'fisheries/supplyEmpty', player: 1, missed: 2 },
  'fisheries/full': { type: 'fisheries/full', player: 1, missed: 1 },
  'fisheries/swapped': { type: 'fisheries/swapped', player: 1, returned: 1 },
  'fisheries/spent': { type: 'fisheries/spent', player: 1, paid: [2, 3], buy: 'route' },
  'fisheries/blockerRemoved': { type: 'fisheries/blockerRemoved', player: 1, blocker: 'corsair', from: sea },
  'fisheries/took': { type: 'fisheries/took', player: 1, resource: 'ore' },
  'fisheries/card': { type: 'fisheries/card', player: 1, card: 'knight' },
  'fisheries/bootPassed': { type: 'fisheries/bootPassed', from: 1, to: 2 },

  'oil/produced': { type: 'oil/produced', total: 6, grants: [{ player: 1, hex: well, vertex, resource: 'oil', amount: 1 }], short: false },
  'oil/startingOil': { type: 'oil/startingOil', player: 1, vertex, amount: 1 },
  'oil/burned': { type: 'oil/burned', player: 1, get: 'ore', track: 3 },
  'oil/foundryBuilt': { type: 'oil/foundryBuilt', player: 1, vertex, track: 5 },
  'oil/sequestered': { type: 'oil/sequestered', player: 1, total: 3 },
  'oil/stewardChanged': { type: 'oil/stewardChanged', from: null, to: 1 },
  'oil/monopoly': { type: 'oil/monopoly', player: 1, taken: { 2: 1, 3: 2 } },
  'oil/invention': { type: 'oil/invention', player: 1, cards: ['oil', 'wheat'] },
  'oil/disaster': { type: 'oil/disaster', player: 1, dice: [3, 4], total: 7 },
  'oil/flood': { type: 'oil/flood', island: 0, number: 8, washed: [vertex], dropped: [], lying: [], walls: [], owners: { [vertex]: 1 } },
  'oil/polluted': { type: 'oil/polluted', hex: land, number: 6, lost: 3 },
  'oil/wellPolluted': { type: 'oil/wellPolluted', hex: well, fromSupply: 1, fromHands: { 2: 2 } },
  'oil/spared': { type: 'oil/spared', number: 12 },
  'oil/islandLost': { type: 'oil/islandLost', steward: 1 },

  'almanac/drawn': { type: 'almanac/drawn', player: 0, card: 13, dice: [3, 2], happening: 'quake', settled: false },
  'almanac/newYear': { type: 'almanac/newYear' },
  'almanac/nothing': { type: 'almanac/nothing', happening: 'quarrel' },
  'almanac/took': { type: 'almanac/took', player: 1, resource: 'wool', happening: 'harvest' },
  'almanac/gave': { type: 'almanac/gave', from: 1, to: 2, card: 'wool', happening: 'gifts' },
  'almanac/cracked': { type: 'almanac/cracked', player: 1, edge },
  'almanac/repaired': { type: 'almanac/repaired', player: 1, edge },
  'almanac/robberFled': { type: 'almanac/robberFled', from: land, to: null },
  'almanac/corsairFled': { type: 'almanac/corsairFled', from: sea },

  'harbourmaster/changed': { type: 'harbourmaster/changed', from: null, to: 3, points: 4 },
};

const teller = (events: readonly GameEvent[], at: number, state: GameState = s): Teller => ({ s: state, events, at, isMe: (p) => p === 0 });
const alone = (e: TableEvent): Telling => tell(e, teller([e], 0));

/** Nothing in a line that a template left unfilled. */
function clean(t: Telling) {
  for (const l of t.lines) {
    expect(l.text.trim()).not.toBe('');
    expect(l.text).not.toMatch(/undefined|NaN|null|\[object|\{\d+:undefined\}/);
  }
  if (t.banner) {
    expect(t.banner.title.trim()).not.toBe('');
    expect(`${t.banner.title} ${t.banner.subtitle ?? ''}`).not.toMatch(/undefined|NaN|null|\[object/);
  }
}

describe('module event lines', () => {
  it('tells every event type in at least one line', () => {
    for (const e of Object.values(SAMPLES) as TableEvent[]) {
      // (A bare halt says nothing: it is told after a march.)
      const t = e.type === 'invasion/halted' ? alone({ ...e, marched: true }) : alone(e);
      expect(t.lines.length, e.type).toBeGreaterThan(0);
      clean(t);
    }
  });

  it('speaks to the person playing as "you"', () => {
    expect(alone(SAMPLES['invasion/losses']).lines[0].text).toContain('your warden');
    expect(alone({ ...SAMPLES['harbourmaster/changed'], to: 0 }).lines[0].text).toBe('You take the Port Captain award');
    // Secrets show only to their holder: your fish are counted, another's aren't.
    expect(alone(SAMPLES['fisheries/drew']).lines[0].text).toBe('You drew fish: 2');
    expect(alone({ ...SAMPLES['fisheries/drew'], player: 2 }).lines[0].text).toMatch(/drew a fish token$/);
    expect(alone(SAMPLES['guilds/drew']).lines[0].text).not.toContain('Augury');
  });

  it('banners only the big moments', () => {
    const bannered = (Object.values(SAMPLES) as TableEvent[]).filter((e) => alone(e).banner).map((e) => e.type);
    expect(bannered.sort()).toEqual(
      [
        'gameLost', 'sea/firstLanding', 'guilds/seat', 'fleet/attack', 'invasion/battle', 'rivers/wealthChanged', 'caravans/toPlace',
        'oil/stewardChanged', 'oil/flood', 'oil/polluted', 'oil/wellPolluted', 'almanac/drawn', 'harbourmaster/changed',
      ].sort(),
    );
    // A landing is a line; the third raider on a hex, a conquest, is a banner.
    expect(alone(SAMPLES['invasion/landed']).banner).toBeUndefined();
    expect(alone({ ...SAMPLES['invasion/landed'], raiders: 3 }).banner?.title).toMatch(/^Raiders take the /);
    // The Almanac's 7 has the dice's own banner.
    expect(alone({ ...SAMPLES['almanac/drawn'], happening: 'thieves' }).banner).toBeUndefined();
    // A held defence names its best defender in the attack's banner, with the award's painting.
    const held: TableEvent = { ...SAMPLES['fleet/attack'], defence: 6, won: true };
    const crowned = tell(held, teller([held, SAMPLES['fleet/token']], 0)).banner;
    expect(crowned).toMatchObject({ title: 'Watchtower Medal', tone: 'player', player: 1, art: AWARD_ART.defence });
    expect(crowned?.subtitle).toMatch(/beaten off, 6 against 5 \(\+1 VP\)$/);
    expect(tell(held, teller([held, SAMPLES['fleet/tied']], 0)).banner?.subtitle).toMatch(/tie for the best/);
    expect(alone(SAMPLES['fleet/attack']).banner?.title).toBe('The raiders break through');
    // The Richest tile changes hands with every starting coin: in set-up that is a line, not a banner.
    expect(tell(SAMPLES['rivers/wealthChanged'], teller([], 0, created)).banner).toBeUndefined();
  });

  it('leaves to the next event what it tells, and tells a run once', () => {
    for (const reason of TOLD_AFTER) expect(alone({ ...SAMPLES.cardsMoved, reason }).lines).toEqual([]);
    expect(alone({ ...SAMPLES.coins, reason: 'battle' }).lines).toEqual([]);
    // A halt with no march before it is no news; after one, it closes the march.
    expect(alone(SAMPLES['invasion/halted']).lines).toEqual([]);
    expect(alone({ ...SAMPLES['invasion/halted'], marched: true }).lines).toHaveLength(1);
    const haul: TableEvent[] = [
      { type: 'cardsMoved', from: 1, to: 0, cards: cards({ wool: 2 }), reason: 'cornerMarket' },
      { type: 'cardsMoved', from: 2, to: 0, cards: cards({ wool: 1 }), reason: 'cornerMarket' },
    ];
    expect(tell(haul[0], teller(haul, 0)).lines).toEqual([]);
    expect(tell(haul[1], teller(haul, 1)).lines[0].text).toBe('You corner the market: {2:wool} from P1, {1:wool} from P2');
    const draws: TableEvent[] = [SAMPLES['fisheries/drew'], { ...SAMPLES['fisheries/drew'], value: 0 }];
    expect(tell(draws[1], teller(draws, 1)).lines[0].text).toBe('You drew fish: 2 and the Soggy Boot');
  });
});

describe('module event sounds and words', () => {
  /** Every sample, and the variants that sound differently, as the person (seat 0) would hear them. */
  const variants: TableEvent[] = [
    ...(Object.values(SAMPLES) as TableEvent[]),
    { ...SAMPLES['fleet/attack'], defence: 6, won: true },
    { ...SAMPLES['invasion/landed'], raiders: 3 },
    { ...SAMPLES['fleet/blockersIn'], robber: null },
  ];

  it('gives the expansions voices of their own', () => {
    const heard = new Set(variants.map((e) => alone(e).sound?.name).filter(Boolean));
    for (const voice of ['horn', 'warDrum', 'fanfare', 'launch', 'creak', 'battle', 'hiss', 'surge', 'anvil', 'wagon', 'stone', 'crumble', 'reel', 'chime'] as const) expect(heard, voice).toContain(voice);
    // The robber's laugh is the 7's and a conquest's no longer; thunder is the end of the game and the disaster's storm only.
    expect(heard).not.toContain('robberLaugh');
    const thunder = variants.filter((e) => alone(e).sound?.name === 'thunder').map((e) => e.type).sort();
    expect(thunder).toEqual(['gameLost', 'oil/disaster']);
    // A held defence sounds good; a breach, the drums.
    expect(alone({ ...SAMPLES['fleet/attack'], won: true }).sound?.name).toBe('fanfare');
    expect(alone(SAMPLES['fleet/attack']).sound?.name).toBe('warDrum');
    // The robber's walk ashore sounds itself: the line that brings him has no sound of its own.
    expect(alone(SAMPLES['fleet/blockersIn']).sound).toBeUndefined();
    // The defence token's flight carries its sound.
    expect(alone(SAMPLES['fleet/token']).sound).toBeUndefined();
  });

  it('raises the war horn as the fleet closes in', () => {
    const rate = (position: number) => alone({ type: 'fleet/advanced', position, steps: 7 }).sound!.rate!;
    expect(rate(1)).toBe(1);
    expect(rate(4)).toBeGreaterThan(rate(1));
    expect(rate(7)).toBeCloseTo(Math.pow(2, 5 / 12));
  });

  it('banners a battle only when it frees a hex or your wardens fought', () => {
    const routine: TableEvent = { ...SAMPLES['invasion/battle'], conquered: false, participants: [2], prisoners: { 2: 1 }, coins: {} };
    expect(alone(routine).banner).toBeUndefined();
    expect(alone(routine).look).toBeUndefined();
    expect(alone(routine).glow).toEqual([land]);
    expect(alone({ ...routine, participants: [0, 2] }).banner?.title).toMatch(/^Raiders driven from the /);
    expect(alone({ ...routine, conquered: true }).banner?.title).toMatch(/ freed$/);
  });

  it('says "you" in the middle of a sentence, and in the right person', () => {
    for (const e of variants) for (const l of alone(e).lines) expect(l.text, e.type).not.toMatch(/.\bYou\b/);
    expect(alone({ ...SAMPLES['caravans/bid'], player: 0 }).lines[0].text).toBe('You bid {1:wool} {1:wheat} and propose where it goes');
    expect(alone({ ...SAMPLES['fisheries/supplyEmpty'], player: 0 }).lines[0].text).toBe('No fish left to draw: you miss 2');
    expect(alone({ ...SAMPLES['oil/islandLost'], steward: 0 }).lines[0].text).toBe('The island is lost to pollution: you are honoured as the Steward');
    expect(alone({ ...SAMPLES['oil/wellPolluted'], fromHands: { 0: 2 } }).lines[0].text).toMatch(/\(you 2 from hand\)$/);
  });

  it('names the Almanac’s happenings as its chip does, and the corsair under Invasion', () => {
    for (const happening of HAPPENINGS.filter((h) => h !== 'thieves')) {
      const t = alone({ ...SAMPLES['almanac/drawn'], happening } as TableEvent);
      expect(t.banner?.title, happening).toBe(happeningName(s, happening));
      expect(t.banner?.subtitle).toBe(`The Almanac · ${happeningLine(s, happening).replace(/\.$/, '')}`);
    }
    // (All Hands has Invasion: no robber, so Hue and Cry chases the corsair instead.)
    expect(happeningName(s, 'robberFlees')).toBe('Hue and Cry');
    expect(alone({ ...SAMPLES['almanac/nothing'], happening: 'robberFlees' }).lines[0].text).toBe('Hue and Cry, but the corsair isn’t on the board');
    expect(alone({ ...SAMPLES['almanac/drawn'], happening: null }).lines[0].text).toBe('The Almanac: no happening, as the Augury named a 7');
  });
});

// ------------------------------------------------------------------ bot games

const MIXES: [string, Expansion[], string?][] = [
  ['all hands', ['sea', 'guilds', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster']],
  ['siege', ['guilds', 'invasion']],
  ['guilds and the fleet', ['guilds', 'rivers']],
  ['invasion alone', ['invasion']],
  ['rivermouth', ['rivers', 'caravans', 'harbourmaster']],
  ['fishing', ['sea', 'fisheries']],
  ['oil and almanac', ['oil', 'almanac']],
  ['fog', ['sea'], 'fogBank'],
];

const isTable = (e: GameEvent): e is TableEvent => e.type.includes('/') || e.type === 'cardsMoved' || e.type === 'coins' || e.type === 'coinTraded' || e.type === 'gameLost';

describe('module events in bot games', () => {
  slow('tells every event the mixes raise, and every silent card move is followed by its own line', () => {
    const seen = new Map<string, number>();
    for (const [name, ex, map] of MIXES) {
      const mix = mixOf(ex, map);
      for (const seed of [31, 32]) {
        let st: GameState = createGame(setups(4), { modules: mix.modules, map: mix.map, knobs: mix.knobs, victoryPoints: mix.target, seed }).state;
        const mem = st.players.map(() => createBotMemory());
        for (let steps = 0; st.phase !== 'gameOver' && steps < 4000; steps++) {
          let acted = false;
          for (let p = 0; p < 4 && !acted; p++) {
            const a = botDecide(st, p, mem[p], 'normal');
            if (!a) continue;
            const r = applyAction(st, p, a);
            if (!r.ok) throw new Error(`${name}: ${r.error}`);
            r.events.forEach((e, i) => {
              if (!isTable(e)) return;
              const t = tell(e, teller(r.events, i, r.state));
              clean(t);
              seen.set(e.type, (seen.get(e.type) ?? 0) + t.lines.length);
              if (e.type === 'cardsMoved' && TOLD_AFTER.has(e.reason)) {
                const after = r.events.slice(i + 1).find((o) => o.type !== 'cardsMoved');
                expect(after, `${name}: '${e.reason}' cards with nothing after them`).toBeDefined();
              }
            });
            st = r.state;
            acted = true;
          }
          if (!acted) break;
        }
      }
    }
    // Every module event type the games raised was told at least once (silent ones only in passing).
    const untold = [...seen].filter(([type, n]) => type.includes('/') && n === 0).map(([type]) => type);
    expect(untold).toEqual([]);
    expect(seen.size).toBeGreaterThan(60);
  }, timeout(120000));
});
